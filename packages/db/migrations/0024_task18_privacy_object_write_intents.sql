-- Task 18: durable transactional outbox for privacy object writes.
-- The immutable payload and stable key commit before S3 is contacted. A leased
-- worker can therefore recover a successful-but-unacknowledged Put without an
-- HTTP retry and bind the exact VersionId in a second transaction.
CREATE TABLE privacy_object_write_intents (
  operation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('TENANT_EXPORT', 'AUDIT_DIGEST')),
  request_identity text NOT NULL CHECK (request_identity ~ '^[a-f0-9]{64}$'),
  business_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  audit_event_id uuid NOT NULL,
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 2048),
  canonical_payload bytea NOT NULL CHECK (octet_length(canonical_payload) > 0),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  content_type text NOT NULL CHECK (length(btrim(content_type)) BETWEEN 1 AND 255),
  byte_length bigint NOT NULL CHECK (byte_length = octet_length(canonical_payload)),
  sealed_at timestamptz,
  locked_until timestamptz,
  business_payload jsonb NOT NULL CHECK (jsonb_typeof(business_payload) = 'object'),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'READY', 'FAILED')),
  object_ref text,
  object_version_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  work_lease_token uuid,
  work_lease_expires_at timestamptz,
  work_attempt_count integer NOT NULL DEFAULT 0 CHECK (work_attempt_count >= 0),
  last_error text,
  UNIQUE (tenant_id, kind, request_identity),
  UNIQUE (tenant_id, object_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id),
  CHECK ((kind = 'AUDIT_DIGEST' AND sealed_at IS NOT NULL AND locked_until IS NOT NULL)
    OR (kind = 'TENANT_EXPORT' AND sealed_at IS NULL AND locked_until IS NULL)),
  CHECK (locked_until IS NULL OR locked_until >= sealed_at + interval '365 days'),
  CHECK ((status = 'READY' AND object_ref IS NOT NULL AND object_version_id IS NOT NULL
      AND completed_at IS NOT NULL)
    OR (status <> 'READY' AND object_ref IS NULL AND object_version_id IS NULL
      AND completed_at IS NULL)),
  CHECK ((work_lease_token IS NULL) = (work_lease_expires_at IS NULL))
);

CREATE TABLE privacy_object_write_outbox (
  operation_id uuid PRIMARY KEY REFERENCES privacy_object_write_intents(operation_id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  available_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  UNIQUE (tenant_id, operation_id)
);

-- Existing Tenants may contain versions written by the pre-outbox runtime, so
-- they require one complete inventory before any later deletion. New Tenants
-- are enrolled atomically when their first durable privacy write is reserved.
CREATE TABLE privacy_object_inventory_requirements (
  scope_tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  required_at timestamptz NOT NULL
);

INSERT INTO privacy_object_inventory_requirements (scope_tenant_id, required_at)
SELECT tenant.id, clock_timestamp() FROM tenants tenant
ON CONFLICT (scope_tenant_id) DO NOTHING;

CREATE TABLE privacy_object_inventory_checkpoints (
  deletion_request_id uuid PRIMARY KEY REFERENCES deletion_requests(id),
  scanned_at timestamptz NOT NULL,
  export_version_count integer NOT NULL CHECK (export_version_count >= 0),
  audit_version_count integer NOT NULL CHECK (audit_version_count >= 0)
);

CREATE TABLE privacy_orphan_object_versions (
  deletion_request_id uuid NOT NULL REFERENCES deletion_requests(id),
  bucket_kind text NOT NULL CHECK (bucket_kind IN ('TENANT_EXPORTS', 'AUDIT_EVIDENCE')),
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
  object_version_id text NOT NULL CHECK (length(object_version_id) BETWEEN 1 AND 1024),
  disposition text NOT NULL CHECK (disposition IN ('DELETE_REQUIRED', 'RETAINED_AUDIT')),
  discovered_at timestamptz NOT NULL,
  PRIMARY KEY (deletion_request_id, bucket_kind, object_key, object_version_id)
);

ALTER TABLE privacy_object_write_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_object_write_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY privacy_object_write_intent_isolation ON privacy_object_write_intents
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

ALTER TABLE privacy_object_write_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_object_write_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY privacy_object_write_outbox_isolation ON privacy_object_write_outbox
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

CREATE FUNCTION claim_privacy_object_write_intent(
  p_operation_id uuid,
  p_tenant_id uuid,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  affected integer;
BEGIN
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid
       IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'PRIVACY_OBJECT_WRITE_CONTEXT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  UPDATE public.privacy_object_write_intents intent
  SET work_lease_token = p_lease_token,
      work_lease_expires_at = clock_timestamp() + interval '2 minutes',
      work_attempt_count = intent.work_attempt_count + 1,
      updated_at = clock_timestamp(),
      last_error = NULL
  WHERE intent.operation_id = p_operation_id
    AND intent.tenant_id = p_tenant_id
    AND intent.status = 'PENDING'
    AND (intent.work_lease_expires_at IS NULL
      OR intent.work_lease_expires_at <= clock_timestamp());
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END
$function$;

CREATE FUNCTION claim_pending_privacy_object_write_intents(
  p_lease_token uuid,
  p_limit integer
)
RETURNS TABLE (
  operation_id uuid,
  kind text,
  tenant_id uuid,
  workspace_id uuid,
  object_key text,
  canonical_payload bytea,
  checksum text,
  content_type text,
  locked_until timestamptz,
  sealed_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'PRIVACY_OBJECT_WRITE_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT intent.operation_id
    FROM public.privacy_object_write_intents intent
    JOIN public.privacy_object_write_outbox outbox
      ON outbox.operation_id = intent.operation_id
    WHERE intent.status = 'PENDING'
      AND outbox.dispatched_at IS NULL
      AND outbox.available_at <= clock_timestamp()
      AND (intent.work_lease_expires_at IS NULL
        OR intent.work_lease_expires_at <= clock_timestamp())
    ORDER BY outbox.available_at, intent.operation_id
    FOR UPDATE OF intent SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public.privacy_object_write_intents intent
    SET work_lease_token = p_lease_token,
        work_lease_expires_at = clock_timestamp() + interval '2 minutes',
        work_attempt_count = intent.work_attempt_count + 1,
        updated_at = clock_timestamp(),
        last_error = NULL
    FROM candidates
    WHERE intent.operation_id = candidates.operation_id
    RETURNING intent.*
  )
  SELECT claimed.operation_id, claimed.kind, claimed.tenant_id, claimed.workspace_id,
    claimed.object_key, claimed.canonical_payload, claimed.checksum,
    claimed.content_type, claimed.locked_until, claimed.sealed_at,
    claimed.work_lease_token, claimed.work_lease_expires_at
  FROM claimed
  ORDER BY claimed.created_at, claimed.operation_id;
END
$function$;

CREATE FUNCTION complete_privacy_object_write_intent(
  p_operation_id uuid,
  p_lease_token uuid,
  p_object_ref text,
  p_object_key text,
  p_object_version_id text,
  p_checksum text,
  p_content_type text,
  p_byte_length bigint,
  p_object_created_at timestamptz,
  p_locked_until timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  intent public.privacy_object_write_intents%ROWTYPE;
  database_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO intent
  FROM public.privacy_object_write_intents write_intent
  WHERE write_intent.operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF intent.status = 'READY' THEN
    RETURN intent.object_ref = p_object_ref
      AND intent.object_key = p_object_key
      AND intent.object_version_id = p_object_version_id
      AND intent.checksum = p_checksum;
  END IF;
  IF intent.status <> 'PENDING'
     OR intent.work_lease_token IS DISTINCT FROM p_lease_token
     OR intent.work_lease_expires_at <= database_now THEN
    RETURN false;
  END IF;
  IF p_object_ref IS NULL OR length(p_object_ref) NOT BETWEEN 1 AND 2048
     OR p_object_key IS DISTINCT FROM intent.object_key
     OR p_object_version_id IS NULL OR length(p_object_version_id) NOT BETWEEN 1 AND 1024
     OR p_checksum IS DISTINCT FROM intent.checksum
     OR p_content_type IS DISTINCT FROM intent.content_type
     OR p_byte_length IS DISTINCT FROM intent.byte_length
     OR p_object_created_at IS NULL
     OR p_locked_until IS DISTINCT FROM intent.locked_until THEN
    RAISE EXCEPTION 'PRIVACY_OBJECT_WRITE_COMPLETION_MISMATCH' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.tenant_id', intent.tenant_id::text, true);
  PERFORM set_config('app.workspace_id', intent.workspace_id::text, true);
  PERFORM set_config('app.actor_id', intent.actor_user_id::text, true);

  IF intent.kind = 'TENANT_EXPORT' THEN
    UPDATE public.tenant_exports export
    SET status = 'ARCHIVE_READY', object_ref = p_object_ref,
      object_version_id = p_object_version_id, object_checksum = p_checksum,
      completed_at = p_object_created_at
    WHERE export.tenant_id = intent.tenant_id
      AND export.id = intent.business_id
      AND export.status = 'ARCHIVE_PENDING';
    IF NOT FOUND THEN RETURN false; END IF;

    INSERT INTO public.managed_object_versions (
      id, tenant_id, workspace_id, object_class, object_ref, object_key,
      object_version_id, checksum, content_type, byte_length, lifecycle_state,
      created_at, expires_at, locked_until, deletion_request_id, deleted_at
    ) VALUES (
      intent.business_id, intent.tenant_id, intent.workspace_id, 'TENANT_EXPORT',
      p_object_ref, p_object_key, p_object_version_id, p_checksum, p_content_type,
      p_byte_length, 'ACTIVE', p_object_created_at, NULL, NULL, NULL, NULL
    );

    INSERT INTO public.audit_events (
      id, tenant_id, workspace_id, actor_user_id, action, resource_type,
      resource_id, outcome, metadata, occurred_at
    ) VALUES (
      intent.audit_event_id, intent.tenant_id, intent.workspace_id, intent.actor_user_id,
      'TENANT_EXPORT_CREATED', 'TENANT_EXPORT', intent.business_id,
      'SUCCEEDED', jsonb_build_object(
        'schemaVersion', '1.0.0',
        'checksum', intent.business_payload->>'manifestChecksum',
        'objectKey', p_object_key,
        'objectVersionId', p_object_version_id
      ), p_object_created_at
    );
  ELSIF intent.kind = 'AUDIT_DIGEST' THEN
    INSERT INTO public.audit_digests (
      id, tenant_id, workspace_id, schema_version, range_from, range_to,
      event_count, last_sequence, head_hash, digest_hash, object_ref,
      object_key, object_version_id, locked_until, sealed_at, audit_event_id
    ) VALUES (
      intent.business_id, intent.tenant_id, intent.workspace_id,
      'audit-digest.v1',
      (intent.business_payload->>'rangeFrom')::timestamptz,
      (intent.business_payload->>'rangeTo')::timestamptz,
      (intent.business_payload->>'eventCount')::bigint,
      (intent.business_payload->>'lastSequence')::bigint,
      intent.business_payload->>'headHash',
      intent.business_payload->>'digestHash',
      p_object_ref, p_object_key, p_object_version_id,
      intent.locked_until, intent.sealed_at, intent.audit_event_id
    );

    INSERT INTO public.managed_object_versions (
      id, tenant_id, workspace_id, object_class, object_ref, object_key,
      object_version_id, checksum, content_type, byte_length, lifecycle_state,
      created_at, expires_at, locked_until, deletion_request_id, deleted_at
    ) VALUES (
      intent.business_id, intent.tenant_id, intent.workspace_id, 'AUDIT_DIGEST',
      p_object_ref, p_object_key, p_object_version_id, p_checksum, p_content_type,
      p_byte_length, 'ACTIVE', p_object_created_at, intent.locked_until,
      intent.locked_until, NULL, NULL
    );

    INSERT INTO public.audit_events (
      id, tenant_id, workspace_id, actor_user_id, action, resource_type,
      resource_id, outcome, metadata, occurred_at
    ) VALUES (
      intent.audit_event_id, intent.tenant_id, intent.workspace_id, intent.actor_user_id,
      'AUDIT_DIGEST_SEALED', 'AUDIT_DIGEST', intent.business_id,
      'SUCCEEDED', jsonb_build_object(
        'digestHash', intent.business_payload->>'digestHash',
        'lastSequence', (intent.business_payload->>'lastSequence')::bigint,
        'lockedUntil', intent.locked_until,
        'objectKey', p_object_key,
        'objectVersionId', p_object_version_id
      ), intent.sealed_at
    );
  ELSE
    RAISE EXCEPTION 'PRIVACY_OBJECT_WRITE_KIND_INVALID' USING ERRCODE = '22023';
  END IF;

  UPDATE public.privacy_object_write_intents write_intent
  SET status = 'READY', object_ref = p_object_ref,
    object_version_id = p_object_version_id, completed_at = database_now,
    updated_at = database_now, work_lease_token = NULL,
    work_lease_expires_at = NULL, last_error = NULL
  WHERE write_intent.operation_id = intent.operation_id;
  UPDATE public.privacy_object_write_outbox outbox
  SET dispatched_at = database_now
  WHERE outbox.operation_id = intent.operation_id;
  RETURN true;
END
$function$;

CREATE FUNCTION release_privacy_object_write_intent_lease(
  p_operation_id uuid,
  p_lease_token uuid,
  p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  affected integer;
BEGIN
  UPDATE public.privacy_object_write_intents intent
  SET work_lease_token = NULL, work_lease_expires_at = NULL,
    updated_at = clock_timestamp(),
    last_error = CASE WHEN p_error IS NULL THEN intent.last_error ELSE left(p_error, 500) END
  WHERE intent.operation_id = p_operation_id
    AND intent.status = 'PENDING'
    AND intent.work_lease_token = p_lease_token;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END
$function$;

CREATE FUNCTION guard_and_enroll_privacy_object_write_intent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  -- Serialize reservation with aeostudio_request_deletion's exact Tenant
  -- FOR UPDATE lock. If deletion commits first this statement waits and the
  -- frozen-scope check below rejects; if the intent commits first deletion
  -- waits and its later finalization observes the durable PENDING row.
  PERFORM 1
  FROM public.tenants tenant
  WHERE tenant.id = NEW.tenant_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRIVACY_OBJECT_WRITE_TENANT_NOT_FOUND' USING ERRCODE = '23503';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.deletion_requests request
    WHERE request.tenant_id = NEW.tenant_id
      AND request.state IN (
        'FROZEN', 'FINALIZING', 'ACTIVE_DATA_DELETED', 'BACKUP_DELETED',
        'BLOCKED_BY_LEGAL_HOLD', 'TOMBSTONED'
      )
      AND (
        request.scope_kind = 'TENANT'
        OR NEW.kind = 'TENANT_EXPORT'
        OR request.workspace_id = NEW.workspace_id
      )
  ) THEN
    RAISE EXCEPTION 'PRIVACY_OBJECT_WRITE_SCOPE_FROZEN' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.privacy_object_inventory_requirements (scope_tenant_id, required_at)
  VALUES (NEW.tenant_id, NEW.created_at)
  ON CONFLICT (scope_tenant_id) DO NOTHING;
  RETURN NEW;
END
$function$;

CREATE TRIGGER privacy_object_write_intent_freeze_guard
BEFORE INSERT ON privacy_object_write_intents
FOR EACH ROW EXECUTE FUNCTION guard_and_enroll_privacy_object_write_intent();

CREATE FUNCTION get_deletion_object_inventory_target(
  p_request_id uuid,
  p_lease_token uuid
)
RETURNS TABLE (
  status text,
  request_id uuid,
  tenant_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  deletion_request public.deletion_requests%ROWTYPE;
BEGIN
  SELECT request.* INTO deletion_request
  FROM public.deletion_requests request
  WHERE request.id = p_request_id
    AND request.finalization_lease_token = p_lease_token
    AND request.finalization_lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'INVALID_LEASE'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.privacy_object_write_intents intent
    WHERE intent.tenant_id = deletion_request.tenant_id
      AND intent.status = 'PENDING'
      AND (
        deletion_request.scope_kind = 'TENANT'
        OR intent.kind = 'TENANT_EXPORT'
        OR intent.workspace_id = deletion_request.workspace_id
      )
  ) THEN
    RETURN QUERY SELECT 'PENDING_WRITES'::text,
      deletion_request.id, deletion_request.tenant_id;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.privacy_object_inventory_requirements requirement
    WHERE requirement.scope_tenant_id = deletion_request.tenant_id
  ) THEN
    RETURN QUERY SELECT 'NOT_REQUIRED'::text,
      deletion_request.id, deletion_request.tenant_id;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.privacy_object_inventory_checkpoints checkpoint
    WHERE checkpoint.deletion_request_id = deletion_request.id
      AND checkpoint.scanned_at >= deletion_request.frozen_at
  ) THEN
    RETURN QUERY SELECT 'COMPLETE'::text,
      deletion_request.id, deletion_request.tenant_id;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'REQUIRED'::text,
    deletion_request.id, deletion_request.tenant_id;
END
$function$;

CREATE FUNCTION record_deletion_object_inventory(
  p_request_id uuid,
  p_lease_token uuid,
  p_export_versions jsonb,
  p_audit_versions jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  deletion_request public.deletion_requests%ROWTYPE;
  database_now timestamptz := clock_timestamp();
  workspace_for_orphan uuid;
  entry jsonb;
  inventory_object_key text;
  inventory_object_version_id text;
BEGIN
  IF jsonb_typeof(p_export_versions) <> 'array'
     OR jsonb_typeof(p_audit_versions) <> 'array'
     OR jsonb_array_length(p_export_versions) > 100000
     OR jsonb_array_length(p_audit_versions) > 100000 THEN
    RAISE EXCEPTION 'PRIVACY_OBJECT_INVENTORY_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT request.* INTO deletion_request
  FROM public.deletion_requests request
  WHERE request.id = p_request_id
    AND request.finalization_lease_token = p_lease_token
    AND request.finalization_lease_expires_at > database_now
    AND request.state IN ('FROZEN', 'FINALIZING');
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM public.privacy_object_write_intents intent
    WHERE intent.tenant_id = deletion_request.tenant_id
      AND intent.status = 'PENDING'
      AND (
        deletion_request.scope_kind = 'TENANT'
        OR intent.kind = 'TENANT_EXPORT'
        OR intent.workspace_id = deletion_request.workspace_id
      )
  ) THEN RETURN false; END IF;

  SELECT COALESCE(
    deletion_request.workspace_id,
    (SELECT workspace.id FROM public.workspaces workspace
     WHERE workspace.tenant_id = deletion_request.tenant_id
     ORDER BY workspace.created_at, workspace.id LIMIT 1)
  ) INTO workspace_for_orphan;
  IF workspace_for_orphan IS NULL THEN RETURN false; END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_export_versions) LOOP
    inventory_object_key := entry->>'objectKey';
    inventory_object_version_id := entry->>'objectVersionId';
    IF inventory_object_key IS NULL
       OR inventory_object_key NOT LIKE 'tenants/' || deletion_request.tenant_id::text || '/exports/%'
       OR length(inventory_object_key) > 1024
       OR inventory_object_version_id IS NULL
       OR length(inventory_object_version_id) NOT BETWEEN 1 AND 1024 THEN
      RAISE EXCEPTION 'PRIVACY_OBJECT_INVENTORY_SCOPE_MISMATCH' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.managed_object_versions object_version
      WHERE object_version.tenant_id = deletion_request.tenant_id
        AND object_version.object_key = inventory_object_key
        AND object_version.object_version_id = inventory_object_version_id
    ) THEN
      INSERT INTO public.privacy_orphan_object_versions (
        deletion_request_id, bucket_kind, object_key, object_version_id,
        disposition, discovered_at
      ) VALUES (
        deletion_request.id, 'TENANT_EXPORTS', inventory_object_key,
        inventory_object_version_id,
        'DELETE_REQUIRED', database_now
      ) ON CONFLICT DO NOTHING;
      INSERT INTO public.managed_object_versions (
        id, tenant_id, workspace_id, object_class, object_ref, object_key,
        object_version_id, checksum, content_type, byte_length, lifecycle_state,
        created_at, expires_at, locked_until, deletion_request_id, deleted_at
      ) VALUES (
        gen_random_uuid(), deletion_request.tenant_id, workspace_for_orphan,
        'TENANT_EXPORT',
        's3-inventory://' || encode(sha256(convert_to(
          inventory_object_key || ':' || inventory_object_version_id, 'UTF8'
        )), 'hex'),
        inventory_object_key, inventory_object_version_id, repeat('0', 64),
        'application/octet-stream', 0, 'ACTIVE', database_now,
        NULL, NULL, NULL, NULL
      ) ON CONFLICT (tenant_id, object_key, object_version_id) DO NOTHING;
    END IF;
  END LOOP;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_audit_versions) LOOP
    inventory_object_key := entry->>'objectKey';
    inventory_object_version_id := entry->>'objectVersionId';
    IF inventory_object_key IS NULL
       OR inventory_object_key NOT LIKE 'tenants/' || deletion_request.tenant_id::text || '/audit-digests/%'
       OR length(inventory_object_key) > 1024
       OR inventory_object_version_id IS NULL
       OR length(inventory_object_version_id) NOT BETWEEN 1 AND 1024 THEN
      RAISE EXCEPTION 'PRIVACY_OBJECT_INVENTORY_SCOPE_MISMATCH' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.managed_object_versions object_version
      WHERE object_version.tenant_id = deletion_request.tenant_id
        AND object_version.object_key = inventory_object_key
        AND object_version.object_version_id = inventory_object_version_id
    ) THEN
      INSERT INTO public.privacy_orphan_object_versions (
        deletion_request_id, bucket_kind, object_key, object_version_id,
        disposition, discovered_at
      ) VALUES (
        deletion_request.id, 'AUDIT_EVIDENCE', inventory_object_key,
        inventory_object_version_id,
        'RETAINED_AUDIT', database_now
      ) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  INSERT INTO public.privacy_object_inventory_checkpoints (
    deletion_request_id, scanned_at, export_version_count, audit_version_count
  ) VALUES (
    deletion_request.id, database_now,
    jsonb_array_length(p_export_versions), jsonb_array_length(p_audit_versions)
  ) ON CONFLICT (deletion_request_id) DO UPDATE
    SET scanned_at = EXCLUDED.scanned_at,
        export_version_count = EXCLUDED.export_version_count,
        audit_version_count = EXCLUDED.audit_version_count;
  RETURN true;
END
$function$;

CREATE FUNCTION guard_deletion_privacy_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.state = 'FINALIZING' AND OLD.state IS DISTINCT FROM 'FINALIZING' THEN
    IF EXISTS (
      SELECT 1 FROM public.privacy_object_write_intents intent
      WHERE intent.tenant_id = NEW.tenant_id AND intent.status = 'PENDING'
        AND (NEW.scope_kind = 'TENANT' OR intent.kind = 'TENANT_EXPORT'
          OR intent.workspace_id = NEW.workspace_id)
    ) THEN
      RAISE EXCEPTION 'PRIVACY_OBJECT_WRITES_PENDING' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.privacy_object_inventory_requirements requirement
      WHERE requirement.scope_tenant_id = NEW.tenant_id
    ) AND NOT EXISTS (
      SELECT 1 FROM public.privacy_object_inventory_checkpoints checkpoint
      WHERE checkpoint.deletion_request_id = NEW.id
        AND checkpoint.scanned_at >= NEW.frozen_at
    ) THEN
      RAISE EXCEPTION 'PRIVACY_OBJECT_INVENTORY_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.privacy_orphan_object_versions orphan
      JOIN public.managed_object_versions object_version
        ON object_version.tenant_id = NEW.tenant_id
       AND object_version.object_key = orphan.object_key
       AND object_version.object_version_id = orphan.object_version_id
      WHERE orphan.deletion_request_id = NEW.id
        AND orphan.disposition = 'DELETE_REQUIRED'
        AND object_version.lifecycle_state <> 'DELETED'
    ) THEN
      RAISE EXCEPTION 'PRIVACY_ORPHAN_OBJECT_DELETE_PROOF_REQUIRED'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER deletion_privacy_inventory_guard
BEFORE UPDATE OF state ON deletion_requests
FOR EACH ROW EXECUTE FUNCTION guard_deletion_privacy_inventory();

REVOKE ALL ON privacy_object_write_intents, privacy_object_write_outbox FROM PUBLIC;
GRANT SELECT, INSERT ON privacy_object_write_intents, privacy_object_write_outbox
  TO aeostudio_runtime;

REVOKE ALL ON FUNCTION claim_privacy_object_write_intent(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_pending_privacy_object_write_intents(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_privacy_object_write_intent(
  uuid, uuid, text, text, text, text, text, bigint, timestamptz, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_privacy_object_write_intent_lease(uuid, uuid, text)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION claim_privacy_object_write_intent(uuid, uuid, uuid)
  TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION complete_privacy_object_write_intent(
  uuid, uuid, text, text, text, text, text, bigint, timestamptz, timestamptz
) TO aeostudio_runtime, aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION release_privacy_object_write_intent_lease(uuid, uuid, text)
  TO aeostudio_runtime, aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION claim_pending_privacy_object_write_intents(uuid, integer)
  TO aeostudio_lifecycle_worker;

REVOKE ALL ON privacy_object_inventory_requirements,
  privacy_object_inventory_checkpoints, privacy_orphan_object_versions FROM PUBLIC;
REVOKE ALL ON FUNCTION get_deletion_object_inventory_target(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_deletion_object_inventory(uuid, uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_deletion_object_inventory_target(uuid, uuid)
  TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION record_deletion_object_inventory(uuid, uuid, jsonb, jsonb)
  TO aeostudio_lifecycle_worker;
