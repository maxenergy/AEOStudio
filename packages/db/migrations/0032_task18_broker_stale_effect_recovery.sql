-- Task 18: close orphaned Broker effect journals without ever redispatching a
-- cloud mutation that may still be running.
--
-- begin_tenant_data_broker_effect already fences every retry of a STARTED
-- effect as an AMBIGUOUS/UNKNOWN attempt. This forward trigger converts the
-- prior durable STARTED rows to UNKNOWN once their full signed request window
-- has elapsed. The retry remains AMBIGUOUS, so this transition cannot replay
-- the cloud operation; operation-specific recovery must observe the provider.
CREATE FUNCTION public.tenant_data_broker_source_lease_expires_at_private(
  p_capability public.tenant_data_capabilities
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  source_lease_expires_at timestamptz;
BEGIN
  CASE p_capability.source_kind
    WHEN 'WORKLOAD_WRITE_INTENT' THEN
      SELECT intent.work_lease_expires_at
        INTO source_lease_expires_at
      FROM public.workload_object_write_intents intent
      WHERE intent.operation_id::text = p_capability.source_reference
        AND intent.work_attempt_count = p_capability.source_revision
        AND encode(
          sha256(convert_to(intent.work_lease_token::text, 'UTF8')), 'hex'
        ) = p_capability.lease_token_sha256;
    WHEN 'PRIVACY_WRITE_INTENT' THEN
      SELECT intent.work_lease_expires_at
        INTO source_lease_expires_at
      FROM public.privacy_object_write_intents intent
      WHERE intent.operation_id::text = p_capability.source_reference
        AND intent.work_attempt_count = p_capability.source_revision
        AND encode(
          sha256(convert_to(intent.work_lease_token::text, 'UTF8')), 'hex'
        ) = p_capability.lease_token_sha256;
    WHEN 'CONNECTOR_DELETION_INTENT' THEN
      SELECT deletion.work_lease_expires_at
        INTO source_lease_expires_at
      FROM public.connector_secret_deletions deletion
      WHERE deletion.tenant_id = p_capability.tenant_id
        AND deletion.channel_authorization_id::text =
          p_capability.source_reference
        AND deletion.work_attempt_count = p_capability.source_revision
        AND encode(
          sha256(convert_to(deletion.work_lease_token::text, 'UTF8')), 'hex'
        ) = p_capability.lease_token_sha256;
    WHEN 'DELETION_OBJECT_INTENT' THEN
      SELECT request.finalization_lease_expires_at
        INTO source_lease_expires_at
      FROM public.deletion_requests request
      WHERE request.tenant_id = p_capability.tenant_id
        AND request.id::text = p_capability.source_reference
        AND request.finalization_attempt_count =
          p_capability.source_revision
        AND encode(
          sha256(
            convert_to(request.finalization_lease_token::text, 'UTF8')
          ), 'hex'
        ) = p_capability.lease_token_sha256;
    WHEN 'LEGAL_HOLD_RECONCILIATION_INTENT' THEN
      SELECT reconciliation.work_lease_expires_at
        INTO source_lease_expires_at
      FROM public.legal_hold_object_reconciliations reconciliation
      WHERE reconciliation.tenant_id = p_capability.tenant_id
        AND reconciliation.object_key = p_capability.resource->>'key'
        AND reconciliation.object_version_id =
          p_capability.resource->>'versionId'
        AND reconciliation.work_attempt_count =
          p_capability.source_revision
        AND encode(
          sha256(
            convert_to(reconciliation.work_lease_token::text, 'UTF8')
          ), 'hex'
        ) = p_capability.lease_token_sha256;
    ELSE
      RETURN NULL;
  END CASE;
  RETURN source_lease_expires_at;
END
$function$;

CREATE FUNCTION public.tenant_data_broker_provider_grace_elapsed_private(
  p_effect_identity text,
  p_database_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  elapsed boolean;
BEGIN
  IF p_effect_identity IS NULL OR p_database_now IS NULL THEN
    RETURN false;
  END IF;
  SELECT
    active_attempt.started_at <=
      p_database_now - interval '30 seconds'
    AND GREATEST(
      active_capability.expires_at,
      active_nonce.expires_at,
      COALESCE(
        public.tenant_data_broker_source_lease_expires_at_private(
          active_capability
        ),
        '-infinity'::timestamptz
      )
    ) <= p_database_now - interval '30 seconds'
    INTO elapsed
  FROM public.tenant_data_broker_effects effect
  JOIN public.tenant_data_broker_attempts active_attempt
    ON active_attempt.attempt_id = effect.active_attempt_id
   AND active_attempt.effect_identity = effect.effect_identity
  JOIN public.tenant_data_capabilities active_capability
    ON active_capability.capability_id = active_attempt.capability_id
  JOIN public.tenant_data_broker_nonces active_nonce
    ON active_nonce.nonce = active_attempt.nonce
   AND active_nonce.nonce_hash = active_attempt.nonce_hash
  WHERE effect.effect_identity = p_effect_identity
    AND active_attempt.outcome IN ('STARTED', 'UNKNOWN');
  RETURN COALESCE(elapsed, false);
END
$function$;

CREATE FUNCTION public.tenant_data_mark_stale_broker_effect_unknown_private()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  stale_attempt_id uuid;
  affected integer;
BEGIN
  IF NEW.effectful IS DISTINCT FROM true
     OR NEW.outcome IS DISTINCT FROM 'UNKNOWN' THEN
    RETURN NEW;
  END IF;

  SELECT effect.active_attempt_id
    INTO stale_attempt_id
  FROM public.tenant_data_broker_effects effect
  JOIN public.tenant_data_broker_attempts active_attempt
    ON active_attempt.attempt_id = effect.active_attempt_id
  JOIN public.tenant_data_capabilities active_capability
    ON active_capability.capability_id = active_attempt.capability_id
  JOIN public.tenant_data_broker_nonces active_nonce
    ON active_nonce.nonce = active_attempt.nonce
   AND active_nonce.nonce_hash = active_attempt.nonce_hash
  WHERE effect.effect_identity = NEW.effect_identity
    AND effect.state = 'STARTED'
    AND active_attempt.outcome = 'STARTED'
    AND active_attempt.effect_identity = effect.effect_identity
    AND active_attempt.started_at <= database_now - interval '30 seconds'
    AND effect.updated_at <= database_now - interval '30 seconds'
    AND public.tenant_data_broker_provider_grace_elapsed_private(
      effect.effect_identity, database_now
    )
  FOR UPDATE OF effect, active_attempt;
  IF NOT FOUND THEN RETURN NEW; END IF;

  UPDATE public.tenant_data_broker_effects effect
  SET state = 'UNKNOWN', success_receipt = NULL, updated_at = database_now
  WHERE effect.effect_identity = NEW.effect_identity
    AND effect.active_attempt_id = stale_attempt_id
    AND effect.state = 'STARTED';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'TENANT_DATA_BROKER_EFFECT_FENCE_LOST'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.tenant_data_broker_attempts attempt
  SET outcome = 'UNKNOWN', finished_at = database_now
  WHERE attempt.attempt_id = stale_attempt_id
    AND attempt.effect_identity = NEW.effect_identity
    AND attempt.outcome = 'STARTED';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'TENANT_DATA_BROKER_ATTEMPT_FENCE_LOST'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER tenant_data_mark_stale_broker_effect_unknown
AFTER INSERT ON public.tenant_data_broker_attempts
FOR EACH ROW
EXECUTE FUNCTION public.tenant_data_mark_stale_broker_effect_unknown_private();

-- Keep the existing full source validator as the primary implementation, then
-- add the one recovery case it intentionally could not represent: a durable
-- successful workload PUT whose application-side intent acknowledgement was
-- lost after the Broker commit.
ALTER FUNCTION public.tenant_data_capability_source_lease_expires_at(
  public.tenant_data_capabilities, uuid, timestamptz
) RENAME TO tenant_data_capability_source_lease_expires_at_task18_legacy;

CREATE FUNCTION public.tenant_data_capability_source_lease_expires_at(
  p_capability public.tenant_data_capabilities,
  p_lease_token uuid,
  p_database_now timestamptz
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  source_lease_expires_at timestamptz;
BEGIN
  source_lease_expires_at :=
    public.tenant_data_capability_source_lease_expires_at_task18_legacy(
      p_capability, p_lease_token, p_database_now
    );
  IF source_lease_expires_at IS NOT NULL THEN
    RETURN source_lease_expires_at;
  END IF;
  IF p_lease_token IS NULL
     OR p_database_now IS NULL
     OR p_capability.source_kind IS DISTINCT FROM
       'WORKLOAD_WRITE_INTENT'
     OR p_capability.authority_kind IS DISTINCT FROM
       'WORKLOAD_WRITE_INTENT'
     OR p_capability.operation IS DISTINCT FROM 'HEAD_WORKLOAD_OBJECT'
     OR p_capability.scope_kind IS DISTINCT FROM 'WORKSPACE'
     OR p_capability.workspace_id IS NULL
     OR p_capability.lease_token_sha256 IS DISTINCT FROM encode(
       sha256(convert_to(p_lease_token::text, 'UTF8')), 'hex'
     ) THEN
    RETURN NULL;
  END IF;

  SELECT intent.work_lease_expires_at
    INTO source_lease_expires_at
  FROM public.workload_object_write_intents intent
  JOIN public.tenant_data_broker_resource_authority authority
    ON authority.singleton
  JOIN public.tenant_data_broker_effects effect
    ON effect.effect_identity =
      'WORKLOAD_OBJECT_WRITE:' || intent.operation_id::text
   AND effect.operation = 'PUT_WORKLOAD_OBJECT'
   AND effect.state = 'SUCCESS'
   AND effect.success_receipt = jsonb_build_object(
     'bucket', authority.workload_bucket,
     'key', intent.object_key,
     'versionId', effect.success_receipt->>'versionId',
     'checksum', intent.checksum,
     'contentType', intent.content_type,
     'byteLength', intent.byte_length
   )
  WHERE intent.operation_id::text = p_capability.source_reference
    AND intent.tenant_id = p_capability.tenant_id
    AND intent.workspace_id = p_capability.workspace_id
    AND intent.work_attempt_count = p_capability.source_revision
    AND intent.status = 'PENDING'
    AND intent.work_lease_token = p_lease_token
    AND intent.work_lease_expires_at > p_database_now
    AND p_capability.authority_reference =
      intent.operation_id::text
    AND p_capability.effect_identity =
      'WORKLOAD_OBJECT_RECOVERY_HEAD:' ||
      intent.operation_id::text || ':' ||
      intent.work_attempt_count::text
    AND p_capability.resource = jsonb_build_object(
      'kind', 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD',
      'objectClass', 'WORKLOAD_OBJECTS',
      'bucket', authority.workload_bucket,
      'key', intent.object_key,
      'expectedChecksumSha256', intent.checksum,
      'expectedContentType', intent.content_type,
      'expectedByteLength', intent.byte_length,
      'lockedUntil', NULL,
      'sealedAt', NULL
    );
  RETURN source_lease_expires_at;
END
$function$;

CREATE OR REPLACE FUNCTION public.issue_workload_object_recovery_head_capability(
  p_operation_id uuid,
  p_lease_token uuid,
  p_capability_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  authority public.tenant_data_broker_resource_authority%ROWTYPE;
  intent public.workload_object_write_intents%ROWTYPE;
  put_effect public.tenant_data_broker_effects%ROWTYPE;
  derived_resource jsonb;
  put_effect_identity text;
  affected integer;
BEGIN
  IF p_operation_id IS NULL OR p_lease_token IS NULL
     OR p_capability_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT configured.* INTO authority
  FROM public.tenant_data_broker_resource_authority configured
  WHERE configured.singleton;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT source.* INTO intent
  FROM public.workload_object_write_intents source
  WHERE source.operation_id = p_operation_id
    AND source.status = 'PENDING'
    AND source.work_lease_token = p_lease_token
    AND source.work_lease_expires_at > database_now
  FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  put_effect_identity :=
    'WORKLOAD_OBJECT_WRITE:' || intent.operation_id::text;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(put_effect_identity, 0)
  );
  SELECT effect.* INTO put_effect
  FROM public.tenant_data_broker_effects effect
  WHERE effect.effect_identity = put_effect_identity
    AND effect.operation = 'PUT_WORKLOAD_OBJECT'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF put_effect.state = 'STARTED' THEN
    IF NOT public.tenant_data_broker_provider_grace_elapsed_private(
      put_effect_identity, database_now
    ) THEN
      RETURN NULL;
    END IF;
    UPDATE public.tenant_data_broker_effects effect
    SET state = 'UNKNOWN', success_receipt = NULL,
        updated_at = database_now
    WHERE effect.effect_identity = put_effect_identity
      AND effect.active_attempt_id = put_effect.active_attempt_id
      AND effect.state = 'STARTED';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'TENANT_DATA_BROKER_EFFECT_FENCE_LOST'
        USING ERRCODE = '40001';
    END IF;
    UPDATE public.tenant_data_broker_attempts attempt
    SET outcome = 'UNKNOWN', finished_at = database_now
    WHERE attempt.attempt_id = put_effect.active_attempt_id
      AND attempt.effect_identity = put_effect_identity
      AND attempt.outcome = 'STARTED';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'TENANT_DATA_BROKER_ATTEMPT_FENCE_LOST'
        USING ERRCODE = '40001';
    END IF;
  ELSIF put_effect.state NOT IN ('UNKNOWN', 'SUCCESS') THEN
    RETURN NULL;
  END IF;

  derived_resource := jsonb_build_object(
    'kind', 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD',
    'objectClass', 'WORKLOAD_OBJECTS',
    'bucket', authority.workload_bucket,
    'key', intent.object_key,
    'expectedChecksumSha256', intent.checksum,
    'expectedContentType', intent.content_type,
    'expectedByteLength', intent.byte_length,
    'lockedUntil', NULL,
    'sealedAt', NULL
  );
  RETURN public.tenant_data_issue_capability_private(
    p_capability_id, 'WORKLOAD_WRITE_INTENT',
    intent.operation_id::text, intent.work_attempt_count,
    p_lease_token,
    'WORKLOAD_OBJECT_RECOVERY_HEAD:' ||
      intent.operation_id::text || ':' ||
      intent.work_attempt_count::text,
    'WORKLOAD_WRITE_INTENT', intent.operation_id::text,
    'WORKSPACE', intent.tenant_id, intent.workspace_id,
    'HEAD_WORKLOAD_OBJECT', derived_resource,
    intent.work_lease_expires_at
  );
END
$function$;

-- A DELETE_CONNECTOR_SECRET result can be ambiguous at the HTTP boundary.
-- Resolve that stable mutation only from a separately authorized provider
-- DESCRIBE observation under the same database-owned deletion lease.
CREATE FUNCTION public.resolve_tenant_data_broker_secret_delete_effect(
  p_probe_attempt_id uuid,
  p_lease_token uuid,
  p_observation text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  probe_attempt public.tenant_data_broker_attempts%ROWTYPE;
  probe_capability public.tenant_data_capabilities%ROWTYPE;
  source public.connector_secret_deletions%ROWTYPE;
  delete_effect public.tenant_data_broker_effects%ROWTYPE;
  expected_probe_resource jsonb;
  delete_effect_identity text;
  resolved_state text;
  resolved_receipt jsonb;
  resolution text;
  affected integer;
  delete_attempt public.tenant_data_broker_attempts%ROWTYPE;
BEGIN
  IF p_probe_attempt_id IS NULL OR p_lease_token IS NULL
     OR p_observation IS NULL
     OR p_observation NOT IN ('ABSENT', 'DELETION_REQUESTED', 'EXISTS') THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  SELECT stored.* INTO probe_attempt
  FROM public.tenant_data_broker_attempts stored
  WHERE stored.attempt_id = p_probe_attempt_id
  FOR UPDATE;
  IF NOT FOUND
     OR probe_attempt.operation IS DISTINCT FROM 'DESCRIBE_CONNECTOR_SECRET'
     OR probe_attempt.effectful
     OR probe_attempt.outcome IS DISTINCT FROM 'STARTED' THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  SELECT stored.* INTO probe_capability
  FROM public.tenant_data_capabilities stored
  WHERE stored.capability_id = probe_attempt.capability_id
  FOR SHARE;
  IF NOT FOUND
     OR probe_capability.source_kind IS DISTINCT FROM
       'CONNECTOR_DELETION_INTENT'
     OR probe_capability.authority_kind IS DISTINCT FROM
       'CONNECTOR_DELETION_INTENT'
     OR probe_capability.operation IS DISTINCT FROM
       'DESCRIBE_CONNECTOR_SECRET'
     OR probe_capability.scope_kind IS DISTINCT FROM 'WORKSPACE'
     OR probe_capability.workspace_id IS NULL
     OR probe_capability.expires_at <= database_now
     OR probe_capability.lease_token_sha256 IS DISTINCT FROM encode(
       sha256(convert_to(p_lease_token::text, 'UTF8')), 'hex'
     )
     OR probe_attempt.resource_hash IS DISTINCT FROM
       probe_capability.resource_hash THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  SELECT deletion.* INTO source
  FROM public.connector_secret_deletions deletion
  WHERE deletion.channel_authorization_id::text =
      probe_capability.source_reference
    AND deletion.channel_authorization_id::text =
      probe_capability.authority_reference
    AND deletion.tenant_id = probe_capability.tenant_id
    AND deletion.workspace_id = probe_capability.workspace_id
    AND deletion.work_attempt_count = probe_capability.source_revision
    AND deletion.work_lease_token = p_lease_token
    AND deletion.work_lease_expires_at > database_now
    AND deletion.secret_reference IS NOT NULL
    AND deletion.state IN (
      'REVOKED_PENDING_FORCE_DELETE', 'FORCE_DELETE_REQUESTED', 'FAILED'
    )
  FOR SHARE;
  IF NOT FOUND THEN RETURN 'NOT_RESOLVED'; END IF;

  expected_probe_resource := jsonb_build_object(
    'kind', 'CONNECTOR_SECRET',
    'secretArn', source.secret_reference
  );
  IF probe_capability.resource IS DISTINCT FROM expected_probe_resource
     OR probe_capability.effect_identity IS DISTINCT FROM
       'CONNECTOR_SECRET_PROBE:' ||
       source.channel_authorization_id::text || ':' ||
       source.work_attempt_count::text || ':DESCRIBE_CONNECTOR_SECRET' THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  delete_effect_identity :=
    'CONNECTOR_SECRET_DELETE:' || source.channel_authorization_id::text;
  PERFORM pg_advisory_xact_lock(hashtextextended(delete_effect_identity, 0));
  SELECT stored.* INTO delete_effect
  FROM public.tenant_data_broker_effects stored
  WHERE stored.effect_identity = delete_effect_identity
    AND stored.operation = 'DELETE_CONNECTOR_SECRET'
  FOR UPDATE;
  IF NOT FOUND OR delete_effect.state IS DISTINCT FROM 'UNKNOWN' THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  SELECT stored.* INTO delete_attempt
  FROM public.tenant_data_broker_attempts stored
  WHERE stored.attempt_id = delete_effect.active_attempt_id
    AND stored.effect_identity = delete_effect.effect_identity
  FOR SHARE;
  IF NOT FOUND OR delete_attempt.outcome IS DISTINCT FROM 'UNKNOWN' THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  IF p_observation IN ('ABSENT', 'DELETION_REQUESTED') THEN
    resolved_state := 'SUCCESS';
    resolved_receipt := '{}'::jsonb;
    resolution := 'RESOLVED_SUCCESS';
  ELSE
    IF NOT public.tenant_data_broker_provider_grace_elapsed_private(
      delete_effect_identity, database_now
    ) THEN
      RETURN 'NOT_RESOLVED';
    END IF;
    resolved_state := 'FAILED';
    resolved_receipt := NULL;
    resolution := 'RESOLVED_FAILED';
  END IF;

  UPDATE public.tenant_data_broker_effects stored
  SET state = resolved_state, success_receipt = resolved_receipt,
      updated_at = database_now
  WHERE stored.effect_identity = delete_effect_identity
    AND stored.active_attempt_id = delete_effect.active_attempt_id
    AND stored.state = delete_effect.state;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'TENANT_DATA_BROKER_EFFECT_FENCE_LOST'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.tenant_data_broker_attempts stored
  SET outcome = 'SUCCESS', finished_at = database_now
  WHERE stored.attempt_id = p_probe_attempt_id
    AND stored.outcome = 'STARTED';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'TENANT_DATA_BROKER_ATTEMPT_FENCE_LOST'
      USING ERRCODE = '40001';
  END IF;
  RETURN resolution;
END
$function$;

ALTER FUNCTION public.resolve_tenant_data_broker_object_put_effect(
  uuid, uuid, text, text, text, text, bigint
) RENAME TO resolve_tenant_data_broker_object_put_effect_task18_legacy;

CREATE FUNCTION public.resolve_tenant_data_broker_object_put_effect(
  p_probe_attempt_id uuid,
  p_lease_token uuid,
  p_observation text,
  p_observed_version_id text,
  p_observed_checksum text,
  p_observed_content_type text,
  p_observed_byte_length bigint
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  probe_attempt public.tenant_data_broker_attempts%ROWTYPE;
  probe_capability public.tenant_data_capabilities%ROWTYPE;
  put_effect public.tenant_data_broker_effects%ROWTYPE;
  put_effect_identity text;
  source_lease_expires_at timestamptz;
  positive_observation boolean;
  affected integer;
BEGIN
  IF p_probe_attempt_id IS NULL OR p_lease_token IS NULL
     OR p_observation IS NULL
     OR p_observation NOT IN ('FOUND', 'MISSING', 'MISMATCH') THEN
    RETURN 'NOT_RESOLVED';
  END IF;
  SELECT attempt.* INTO probe_attempt
  FROM public.tenant_data_broker_attempts attempt
  WHERE attempt.attempt_id = p_probe_attempt_id
  FOR UPDATE;
  IF NOT FOUND
     OR probe_attempt.operation NOT IN (
       'HEAD_WORKLOAD_OBJECT', 'HEAD_PRIVACY_OBJECT'
     )
     OR probe_attempt.effectful
     OR probe_attempt.outcome IS DISTINCT FROM 'STARTED' THEN
    RETURN 'NOT_RESOLVED';
  END IF;
  SELECT capability.* INTO probe_capability
  FROM public.tenant_data_capabilities capability
  WHERE capability.capability_id = probe_attempt.capability_id
  FOR SHARE;
  IF NOT FOUND
     OR probe_capability.expires_at <= database_now
     OR probe_capability.operation IS DISTINCT FROM
       probe_attempt.operation
     OR probe_capability.resource_hash IS DISTINCT FROM
       probe_attempt.resource_hash
     OR probe_capability.lease_token_sha256 IS DISTINCT FROM encode(
       sha256(convert_to(p_lease_token::text, 'UTF8')), 'hex'
     ) THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  IF probe_capability.source_kind = 'WORKLOAD_WRITE_INTENT'
     AND probe_capability.authority_kind = 'WORKLOAD_WRITE_INTENT'
     AND probe_capability.operation = 'HEAD_WORKLOAD_OBJECT' THEN
    put_effect_identity :=
      'WORKLOAD_OBJECT_WRITE:' || probe_capability.source_reference;
  ELSIF probe_capability.source_kind = 'PRIVACY_WRITE_INTENT'
     AND probe_capability.authority_kind = 'PRIVACY_WRITE_INTENT'
     AND probe_capability.operation = 'HEAD_PRIVACY_OBJECT' THEN
    put_effect_identity :=
      'PRIVACY_OBJECT_WRITE:' || probe_capability.source_reference;
  ELSE
    RETURN 'NOT_RESOLVED';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(put_effect_identity, 0)
  );
  SELECT effect.* INTO put_effect
  FROM public.tenant_data_broker_effects effect
  WHERE effect.effect_identity = put_effect_identity
    AND effect.operation = CASE probe_capability.source_kind
      WHEN 'WORKLOAD_WRITE_INTENT' THEN 'PUT_WORKLOAD_OBJECT'
      ELSE 'PUT_PRIVACY_OBJECT'
    END
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_RESOLVED'; END IF;

  positive_observation :=
    p_observation = 'FOUND'
    AND p_observed_version_id IS NOT NULL
    AND length(p_observed_version_id) BETWEEN 1 AND 1024
    AND p_observed_version_id !~ '[[:cntrl:]]'
    AND p_observed_checksum IS NOT NULL
    AND p_observed_checksum =
      probe_capability.resource->>'expectedChecksumSha256'
    AND p_observed_content_type IS NOT NULL
    AND p_observed_content_type =
      probe_capability.resource->>'expectedContentType'
    AND p_observed_byte_length IS NOT NULL
    AND p_observed_byte_length::text =
      probe_capability.resource->>'expectedByteLength';

  IF put_effect.state = 'UNKNOWN' THEN
    IF NOT positive_observation
       AND NOT public.tenant_data_broker_provider_grace_elapsed_private(
         put_effect_identity, database_now
       ) THEN
      RETURN 'NOT_RESOLVED';
    END IF;
    RETURN public.resolve_tenant_data_broker_object_put_effect_task18_legacy(
      p_probe_attempt_id,
      p_lease_token,
      p_observation,
      p_observed_version_id,
      p_observed_checksum,
      p_observed_content_type,
      p_observed_byte_length
    );
  END IF;

  IF put_effect.state IS DISTINCT FROM 'SUCCESS'
     OR probe_capability.source_kind IS DISTINCT FROM
       'WORKLOAD_WRITE_INTENT'
     OR NOT positive_observation THEN
    RETURN 'NOT_RESOLVED';
  END IF;
  source_lease_expires_at :=
    public.tenant_data_capability_source_lease_expires_at(
      probe_capability, p_lease_token, database_now
    );
  IF source_lease_expires_at IS NULL
     OR source_lease_expires_at <= database_now
     OR put_effect.success_receipt IS DISTINCT FROM jsonb_build_object(
       'bucket', probe_capability.resource->>'bucket',
       'key', probe_capability.resource->>'key',
       'versionId', p_observed_version_id,
       'checksum',
         probe_capability.resource->>'expectedChecksumSha256',
       'contentType',
         probe_capability.resource->>'expectedContentType',
       'byteLength',
         (probe_capability.resource->>'expectedByteLength')::bigint
     ) THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  UPDATE public.tenant_data_broker_attempts attempt
  SET outcome = 'SUCCESS', finished_at = database_now
  WHERE attempt.attempt_id = p_probe_attempt_id
    AND attempt.outcome = 'STARTED';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'TENANT_DATA_BROKER_ATTEMPT_FENCE_LOST'
      USING ERRCODE = '40001';
  END IF;
  RETURN 'RESOLVED_SUCCESS';
END
$function$;

ALTER FUNCTION public.resolve_tenant_data_broker_legal_hold_effect(
  uuid, uuid, text
) RENAME TO resolve_tenant_data_broker_legal_hold_effect_task18_legacy;

CREATE FUNCTION public.resolve_tenant_data_broker_legal_hold_effect(
  p_probe_attempt_id uuid,
  p_lease_token uuid,
  p_observed_status text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  probe_attempt public.tenant_data_broker_attempts%ROWTYPE;
  probe_capability public.tenant_data_capabilities%ROWTYPE;
  reconciliation public.legal_hold_object_reconciliations%ROWTYPE;
  source_identity text;
  set_effect_identity text;
BEGIN
  IF p_probe_attempt_id IS NULL OR p_lease_token IS NULL
     OR p_observed_status IS NULL
     OR p_observed_status NOT IN ('ON', 'OFF') THEN
    RETURN 'NOT_RESOLVED';
  END IF;
  SELECT attempt.* INTO probe_attempt
  FROM public.tenant_data_broker_attempts attempt
  WHERE attempt.attempt_id = p_probe_attempt_id
  FOR SHARE;
  IF NOT FOUND
     OR probe_attempt.operation IS DISTINCT FROM
       'GET_OBJECT_LEGAL_HOLD'
     OR probe_attempt.effectful
     OR probe_attempt.outcome IS DISTINCT FROM 'STARTED' THEN
    RETURN 'NOT_RESOLVED';
  END IF;
  SELECT capability.* INTO probe_capability
  FROM public.tenant_data_capabilities capability
  WHERE capability.capability_id = probe_attempt.capability_id
  FOR SHARE;
  IF NOT FOUND
     OR probe_capability.source_kind IS DISTINCT FROM
       'LEGAL_HOLD_RECONCILIATION_INTENT'
     OR probe_capability.authority_kind IS DISTINCT FROM
       'LEGAL_HOLD_RECONCILIATION_INTENT'
     OR probe_capability.operation IS DISTINCT FROM
       'GET_OBJECT_LEGAL_HOLD'
     OR probe_capability.expires_at <= database_now
     OR probe_capability.lease_token_sha256 IS DISTINCT FROM encode(
       sha256(convert_to(p_lease_token::text, 'UTF8')), 'hex'
     ) THEN
    RETURN 'NOT_RESOLVED';
  END IF;
  SELECT state.* INTO reconciliation
  FROM public.legal_hold_object_reconciliations state
  WHERE state.tenant_id = probe_capability.tenant_id
    AND state.object_key = probe_capability.resource->>'key'
    AND state.object_version_id =
      probe_capability.resource->>'versionId'
    AND state.work_attempt_count =
      probe_capability.source_revision
    AND state.work_lease_token = p_lease_token
    AND state.work_lease_expires_at > database_now
  FOR SHARE;
  IF NOT FOUND THEN RETURN 'NOT_RESOLVED'; END IF;

  source_identity := encode(sha256(convert_to(
    public.aeostudio_backup_evidence_canonical_json(
      jsonb_build_object(
        'tenantId', reconciliation.tenant_id,
        'key', reconciliation.object_key,
        'versionId', reconciliation.object_version_id
      )
    ), 'UTF8'
  )), 'hex');
  IF probe_capability.source_reference IS DISTINCT FROM source_identity
     OR probe_capability.authority_reference IS DISTINCT FROM
       source_identity THEN
    RETURN 'NOT_RESOLVED';
  END IF;
  set_effect_identity :=
    'LEGAL_HOLD_SET:' || source_identity || ':' ||
    reconciliation.desired_revision::text;
  IF p_observed_status IS DISTINCT FROM
       reconciliation.desired_status
     AND NOT public.tenant_data_broker_provider_grace_elapsed_private(
       set_effect_identity, database_now
     ) THEN
    RETURN 'NOT_RESOLVED';
  END IF;
  RETURN public.resolve_tenant_data_broker_legal_hold_effect_task18_legacy(
    p_probe_attempt_id, p_lease_token, p_observed_status
  );
END
$function$;

REVOKE ALL ON FUNCTION
  public.tenant_data_broker_source_lease_expires_at_private(
    public.tenant_data_capabilities
  )
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;
REVOKE ALL ON FUNCTION
  public.tenant_data_broker_provider_grace_elapsed_private(
    text, timestamptz
  )
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;
REVOKE ALL ON FUNCTION
  public.tenant_data_mark_stale_broker_effect_unknown_private()
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;
REVOKE ALL ON FUNCTION
  public.tenant_data_capability_source_lease_expires_at_task18_legacy(
    public.tenant_data_capabilities, uuid, timestamptz
  )
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;
REVOKE ALL ON FUNCTION
  public.tenant_data_capability_source_lease_expires_at(
    public.tenant_data_capabilities, uuid, timestamptz
  )
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;
REVOKE ALL ON FUNCTION
  public.resolve_tenant_data_broker_object_put_effect_task18_legacy(
    uuid, uuid, text, text, text, text, bigint
  )
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;
REVOKE ALL ON FUNCTION
  public.resolve_tenant_data_broker_object_put_effect(
    uuid, uuid, text, text, text, text, bigint
  )
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;
REVOKE ALL ON FUNCTION
  public.resolve_tenant_data_broker_legal_hold_effect_task18_legacy(
    uuid, uuid, text
  )
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;
REVOKE ALL ON FUNCTION
  public.resolve_tenant_data_broker_legal_hold_effect(
    uuid, uuid, text
  )
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;
REVOKE ALL ON FUNCTION
  public.resolve_tenant_data_broker_secret_delete_effect(uuid, uuid, text)
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;
GRANT EXECUTE ON FUNCTION
  public.resolve_tenant_data_broker_object_put_effect(
    uuid, uuid, text, text, text, text, bigint
  )
  TO aeostudio_tenant_data_broker;
GRANT EXECUTE ON FUNCTION
  public.resolve_tenant_data_broker_legal_hold_effect(uuid, uuid, text)
  TO aeostudio_tenant_data_broker;
GRANT EXECUTE ON FUNCTION
  public.resolve_tenant_data_broker_secret_delete_effect(uuid, uuid, text)
  TO aeostudio_tenant_data_broker;
