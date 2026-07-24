-- A Pull Request is a durable remote effect, but it is not evidence that content is live.
-- Preserve the Adapter-owned lifecycle state without weakening PublicationRecord fencing.

-- Advertise the industry-neutral package target without claiming that a production Provider is
-- installed. Deployments must separately approve terms and register a secret-backed runtime;
-- until then the channel remains an honest export-only handoff.
INSERT INTO channel_definitions
  (id, channel_key, display_name, status, unavailable_reason,
    package_transformer_key, package_schema_version)
VALUES
  ('00000000-0000-7000-8000-000000001010', 'git-pull-request',
    'Git Pull Request', 'AVAILABLE', NULL, 'generic-web-package', '1.0.0');

INSERT INTO adapter_versions
  (id, channel_definition_id, adapter_key, adapter_version, enabled, disabled_reason,
    capabilities, required_scopes, terms_version, terms_status, processing_region,
    retention_policy, training_policy, subprocessors, rate_policy)
VALUES
  ('00000000-0000-7000-8000-000000001011',
    '00000000-0000-7000-8000-000000001010', 'git-pull-request', '1.0.0', false,
    'Production Git Provider runtime is not installed; reviewed package export remains available.',
    ARRAY['PREVIEW','PUBLISH','RECONCILE','ROLLBACK','PULL_REQUEST_STATUS'],
    ARRAY['contents:write','pull_requests:write','metadata:read'],
    'git-provider-terms-v1', 'REVIEW_REQUIRED',
    'Provider-configured; no production runtime installed.',
    'No Provider retention policy is asserted until a production runtime is approved.',
    'No training is permitted.', '[]'::jsonb,
    '{"mode":"not-configured"}'::jsonb);

CREATE FUNCTION publication_remote_state_is_valid(candidate jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $function$
  SELECT
    jsonb_typeof(candidate) = 'object'
    AND (SELECT count(*) = 4 FROM jsonb_object_keys(candidate))
    AND candidate ?& ARRAY['status', 'number', 'isProductionLive', 'rollbackHandle']::text[]
    AND jsonb_typeof(candidate -> 'status') = 'string'
    AND (candidate ->> 'status') ~ '^[A-Z][A-Z0-9_]{0,63}$'
    AND CASE jsonb_typeof(candidate -> 'number')
      WHEN 'null' THEN true
      WHEN 'number' THEN
        (candidate ->> 'number')::numeric > 0
        AND (candidate ->> 'number')::numeric <= 9007199254740991
        AND (candidate ->> 'number')::numeric = trunc((candidate ->> 'number')::numeric)
      ELSE false
    END
    AND jsonb_typeof(candidate -> 'isProductionLive') = 'boolean'
    AND CASE jsonb_typeof(candidate -> 'rollbackHandle')
      WHEN 'null' THEN true
      WHEN 'object' THEN
        (SELECT count(*) BETWEEN 1 AND 16
         FROM jsonb_object_keys(candidate -> 'rollbackHandle'))
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_each(candidate -> 'rollbackHandle') AS entry(key, value)
          WHERE entry.key !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'
            OR CASE jsonb_typeof(entry.value)
              WHEN 'string' THEN NOT (
                length(entry.value #>> '{}') BETWEEN 1 AND 512
                AND (entry.value #>> '{}') !~ '[[:cntrl:]]'
              )
              WHEN 'number' THEN NOT (
                (entry.value #>> '{}')::numeric >= 0
                AND (entry.value #>> '{}')::numeric <= 9007199254740991
                AND (entry.value #>> '{}')::numeric = trunc((entry.value #>> '{}')::numeric)
              )
              WHEN 'boolean' THEN false
              ELSE true
            END
        )
      ELSE false
    END
    AND octet_length(candidate::text) <= 4096
$function$;

REVOKE ALL ON FUNCTION publication_remote_state_is_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION publication_remote_state_is_valid(jsonb) TO aeostudio_runtime;

ALTER TABLE publication_records
  ADD COLUMN remote_state jsonb,
  DROP CONSTRAINT publication_records_status_check,
  DROP CONSTRAINT publication_records_check,
  DROP CONSTRAINT publication_records_check1;

ALTER TABLE publication_records
  ADD CONSTRAINT publication_records_status_check CHECK (status IN (
    'REQUESTED', 'BUDGET_BLOCKED', 'QUEUED', 'RUNNING', 'RETRY_WAIT', 'AMBIGUOUS',
    'RECONCILE_REQUIRED', 'RECONCILING', 'MANUAL_REVIEW_REQUIRED', 'REMOTE_APPLIED',
    'PUBLISHED', 'FAILED_TERMINAL', 'ROLLBACK_QUEUED', 'ROLLED_BACK', 'ROLLBACK_FAILED'
  )),
  ADD CONSTRAINT publication_records_remote_effect_ref_check CHECK (
    status NOT IN ('REMOTE_APPLIED', 'PUBLISHED') OR remote_ref IS NOT NULL
  ),
  ADD CONSTRAINT publication_records_remote_ref_status_check CHECK (
    remote_ref IS NULL
    OR status IN (
      'REMOTE_APPLIED', 'PUBLISHED', 'ROLLBACK_QUEUED', 'ROLLED_BACK', 'ROLLBACK_FAILED'
    )
  ),
  ADD CONSTRAINT publication_records_remote_state_shape_check CHECK (
    remote_state IS NULL OR publication_remote_state_is_valid(remote_state)
  ),
  ADD CONSTRAINT publication_records_remote_state_status_check CHECK (
    remote_state IS NULL
    OR status IN (
      'REMOTE_APPLIED', 'PUBLISHED', 'ROLLBACK_QUEUED', 'ROLLED_BACK', 'ROLLBACK_FAILED'
    )
  ),
  ADD CONSTRAINT publication_records_remote_applied_state_check CHECK (
    status <> 'REMOTE_APPLIED'
    OR (
      remote_state IS NOT NULL
      AND CASE jsonb_typeof(remote_state -> 'isProductionLive')
        WHEN 'boolean' THEN NOT (remote_state ->> 'isProductionLive')::boolean
        ELSE false
      END
    )
  ),
  ADD CONSTRAINT publication_records_published_state_check CHECK (
    status <> 'PUBLISHED'
    OR remote_state IS NULL
    OR CASE jsonb_typeof(remote_state -> 'isProductionLive')
      WHEN 'boolean' THEN (remote_state ->> 'isProductionLive')::boolean
      ELSE false
    END
  );

-- Tenant and workspace are both mandatory isolation dimensions for publication state.
DROP POLICY publication_record_isolation ON publication_records;
CREATE POLICY publication_record_isolation ON publication_records
  USING (
    tenant_id = aeostudio_current_tenant_id()
    AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = aeostudio_current_tenant_id()
    AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );

DROP POLICY publication_attempt_isolation ON publication_attempts;
CREATE POLICY publication_attempt_isolation ON publication_attempts
  USING (
    tenant_id = aeostudio_current_tenant_id()
    AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = aeostudio_current_tenant_id()
    AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );

CREATE OR REPLACE FUNCTION guard_publication_record_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PUBLICATION_RECORD_DELETE_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  IF ROW(
    NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.channel_package_id, NEW.package_checksum,
    NEW.artifact_revision_id, NEW.artifact_content_hash, NEW.adapter_version_id,
    NEW.channel_authorization_id, NEW.target, NEW.idempotency_key, NEW.request_hash,
    NEW.requested_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.channel_package_id, OLD.package_checksum,
    OLD.artifact_revision_id, OLD.artifact_content_hash, OLD.adapter_version_id,
    OLD.channel_authorization_id, OLD.target, OLD.idempotency_key, OLD.request_hash,
    OLD.requested_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'PUBLICATION_REQUEST_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'PUBLICATION_TIME_REGRESSION' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id THEN
    RAISE EXCEPTION 'PUBLICATION_JOB_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.remote_ref IS DISTINCT FROM OLD.remote_ref AND NOT (
    OLD.remote_ref IS NULL
    AND OLD.status IN ('RUNNING', 'RECONCILING')
    AND NEW.status IN ('REMOTE_APPLIED', 'PUBLISHED')
    AND NEW.remote_ref IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PUBLICATION_REMOTE_REF_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.remote_state IS DISTINCT FROM OLD.remote_state AND NOT (
    (
      OLD.remote_state IS NULL
      AND OLD.status IN ('RUNNING', 'RECONCILING')
      AND NEW.status IN ('REMOTE_APPLIED', 'PUBLISHED')
      AND NEW.remote_state IS NOT NULL
    )
    OR (
      OLD.status = 'REMOTE_APPLIED'
      AND NEW.status = 'REMOTE_APPLIED'
      AND NEW.remote_ref IS NOT DISTINCT FROM OLD.remote_ref
      AND OLD.remote_state IS NOT NULL
      AND NEW.remote_state IS NOT NULL
      AND OLD.remote_state ->> 'status' IN ('PR_OPENED', 'MERGED', 'CLOSED', 'FAILED')
      AND NEW.remote_state ->> 'status' IN ('PR_OPENED', 'MERGED', 'CLOSED', 'FAILED')
      AND (
        OLD.remote_state ->> 'status' = 'PR_OPENED'
        OR NEW.remote_state ->> 'status' = OLD.remote_state ->> 'status'
      )
      AND NEW.remote_state -> 'number' IS NOT DISTINCT FROM OLD.remote_state -> 'number'
      AND jsonb_typeof(NEW.remote_state -> 'number') = 'number'
      AND NEW.remote_state -> 'isProductionLive' = 'false'::jsonb
      AND (
        (
          NEW.remote_state ->> 'status' = 'PR_OPENED'
          AND NEW.remote_state -> 'rollbackHandle'
            IS NOT DISTINCT FROM OLD.remote_state -> 'rollbackHandle'
        )
        OR (
          NEW.remote_state ->> 'status' IN ('MERGED', 'CLOSED', 'FAILED')
          AND jsonb_typeof(NEW.remote_state -> 'rollbackHandle') = 'null'
        )
      )
    )
  ) THEN
    RAISE EXCEPTION 'PUBLICATION_REMOTE_STATE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'REQUESTED' AND NEW.status IN ('BUDGET_BLOCKED', 'QUEUED', 'FAILED_TERMINAL'))
    OR (OLD.status = 'BUDGET_BLOCKED' AND NEW.status IN ('QUEUED', 'FAILED_TERMINAL'))
    OR (OLD.status = 'QUEUED' AND NEW.status IN ('RUNNING', 'FAILED_TERMINAL'))
    OR (OLD.status = 'RUNNING' AND NEW.status IN (
      'REMOTE_APPLIED', 'PUBLISHED', 'RETRY_WAIT', 'AMBIGUOUS', 'RECONCILE_REQUIRED',
      'FAILED_TERMINAL'
    ))
    OR (OLD.status = 'RETRY_WAIT' AND NEW.status IN ('QUEUED', 'RUNNING', 'FAILED_TERMINAL'))
    OR (OLD.status = 'AMBIGUOUS' AND NEW.status IN (
      'RECONCILE_REQUIRED', 'RECONCILING', 'MANUAL_REVIEW_REQUIRED'
    ))
    OR (OLD.status = 'RECONCILE_REQUIRED' AND NEW.status IN (
      'RECONCILING', 'MANUAL_REVIEW_REQUIRED'
    ))
    OR (OLD.status = 'RECONCILING' AND NEW.status IN (
      'REMOTE_APPLIED', 'PUBLISHED', 'RETRY_WAIT', 'RECONCILE_REQUIRED', 'FAILED_TERMINAL',
      'MANUAL_REVIEW_REQUIRED'
    ))
    OR (OLD.status = 'MANUAL_REVIEW_REQUIRED' AND NEW.status IN (
      'RECONCILING', 'FAILED_TERMINAL'
    ))
    OR (OLD.status IN ('REMOTE_APPLIED', 'PUBLISHED') AND NEW.status = 'ROLLBACK_QUEUED')
    OR (OLD.status = 'ROLLBACK_QUEUED' AND NEW.status IN ('ROLLED_BACK', 'ROLLBACK_FAILED'))
    OR (OLD.status = 'ROLLBACK_FAILED' AND NEW.status = 'ROLLBACK_QUEUED')
  ) THEN
    RAISE EXCEPTION 'PUBLICATION_STATUS_TRANSITION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'RUNNING' AND NEW.status IN ('REMOTE_APPLIED', 'PUBLISHED') AND NOT EXISTS (
    SELECT 1 FROM publication_attempts
    WHERE tenant_id = NEW.tenant_id
      AND workspace_id = NEW.workspace_id
      AND publication_id = NEW.id
      AND operation = 'PUBLISH'
      AND outcome = 'APPLIED'
      AND remote_ref = NEW.remote_ref
      AND finished_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PUBLICATION_APPLIED_ATTEMPT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'RECONCILING' AND NEW.status IN ('REMOTE_APPLIED', 'PUBLISHED') AND NOT EXISTS (
    SELECT 1 FROM publication_attempts
    WHERE tenant_id = NEW.tenant_id
      AND workspace_id = NEW.workspace_id
      AND publication_id = NEW.id
      AND operation = 'RECONCILE'
      AND outcome = 'APPLIED'
      AND remote_ref = NEW.remote_ref
      AND finished_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PUBLICATION_RECONCILIATION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

GRANT UPDATE (remote_state) ON publication_records TO aeostudio_runtime;
