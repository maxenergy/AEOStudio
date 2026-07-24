-- Provider-observed Channel authorization validation. Browser-supplied scopes, targets and terms
-- remain requests only; publication gates consume a fresh Worker-produced snapshot.

-- The migration role owns the table but intentionally has NOBYPASSRLS. Temporarily relaxing
-- FORCE RLS inside the migration transaction lets it backfill every Tenant while ALTER TABLE's
-- lock prevents any concurrent observer from seeing an unprotected state.
ALTER TABLE channel_authorizations NO FORCE ROW LEVEL SECURITY;

ALTER TABLE channel_authorizations
  ADD COLUMN validation_status text NOT NULL DEFAULT 'PENDING_VALIDATION',
  ADD COLUMN validation_actual_target text,
  ADD COLUMN validation_actual_scopes text[],
  ADD COLUMN validation_terms_version text,
  ADD COLUMN validation_credential_fingerprint text,
  ADD COLUMN validated_at timestamptz,
  ADD COLUMN validation_valid_until timestamptz,
  ADD COLUMN validation_failure_code text;

-- The pre-0041 guard rejects REVOKED -> REVOKED metadata backfills. Dropping and recreating this
-- trigger is transaction-atomic; rollback restores the old guard and commit installs the new one.
DROP TRIGGER channel_authorization_mutation_guard ON channel_authorizations;

UPDATE channel_authorizations
SET validation_status = 'INVALID',
    validated_at = updated_at,
    validation_failure_code = 'AUTHORIZATION_REVOKED'
WHERE status = 'REVOKED';

ALTER TABLE channel_authorizations
  ADD CONSTRAINT channel_authorizations_validation_status_check
    CHECK (validation_status IN ('PENDING_VALIDATION', 'VERIFIED', 'INVALID')),
  ADD CONSTRAINT channel_authorizations_validation_snapshot_check
    CHECK (
      (
        validation_status = 'PENDING_VALIDATION'
        AND validation_actual_target IS NULL
        AND validation_actual_scopes IS NULL
        AND validation_terms_version IS NULL
        AND validation_credential_fingerprint IS NULL
        AND validated_at IS NULL
        AND validation_valid_until IS NULL
        AND validation_failure_code IS NULL
      )
      OR (
        validation_status = 'VERIFIED'
        AND length(validation_actual_target) BETWEEN 1 AND 2048
        AND cardinality(validation_actual_scopes) BETWEEN 0 AND 100
        AND length(validation_terms_version) BETWEEN 1 AND 120
        AND validation_credential_fingerprint ~ '^[a-f0-9]{64}$'
        AND validated_at IS NOT NULL
        AND validation_valid_until > validated_at
        AND validation_failure_code IS NULL
      )
      OR (
        validation_status = 'INVALID'
        AND validation_actual_target IS NULL
        AND validation_actual_scopes IS NULL
        AND validation_terms_version IS NULL
        AND validation_credential_fingerprint IS NULL
        AND validated_at IS NOT NULL
        AND validation_valid_until IS NULL
        AND length(validation_failure_code) BETWEEN 1 AND 120
      )
    );

CREATE TABLE channel_authorization_validation_commands (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'LEASED', 'COMPLETED', 'CANCELLED')),
  worker_id text CHECK (worker_id IS NULL OR length(worker_id) BETWEEN 1 AND 160),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (tenant_id, workspace_id, authorization_id),
  FOREIGN KEY (tenant_id, workspace_id, authorization_id)
    REFERENCES channel_authorizations(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'PENDING' AND worker_id IS NULL AND lease_token IS NULL
      AND lease_expires_at IS NULL AND completed_at IS NULL)
    OR
    (status = 'LEASED' AND worker_id IS NOT NULL AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
    OR
    (status = 'COMPLETED' AND worker_id IS NOT NULL AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL AND completed_at IS NOT NULL)
    OR
    (status = 'CANCELLED' AND worker_id IS NULL AND lease_token IS NULL
      AND lease_expires_at IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX channel_authorization_validation_pending
  ON channel_authorization_validation_commands (created_at, id)
  WHERE status IN ('PENDING', 'LEASED');

INSERT INTO channel_authorization_validation_commands
  (id, tenant_id, workspace_id, authorization_id, status, created_at)
SELECT id, tenant_id, workspace_id, id, 'PENDING', created_at
FROM channel_authorizations
WHERE status = 'ACTIVE' AND secret_arn IS NOT NULL AND validation_status = 'PENDING_VALIDATION'
ON CONFLICT (tenant_id, workspace_id, authorization_id) DO NOTHING;

ALTER TABLE channel_authorization_validation_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_authorization_validation_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_authorization_validation_isolation
  ON channel_authorization_validation_commands
  USING (
    tenant_id = aeostudio_current_tenant_id()
    AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = aeostudio_current_tenant_id()
    AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );

-- SECURITY DEFINER validation functions are owned by the offline NOBYPASSRLS migration
-- principal. Match the explicit owner policy established for prior forced-RLS Tenant tables.
DO $owner_policy$
BEGIN
  EXECUTE format(
    'CREATE POLICY aeostudio_migration_owner_all_tenants ON public.channel_authorization_validation_commands TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$owner_policy$;

CREATE OR REPLACE FUNCTION guard_channel_authorization_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_DELETE_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;

  IF current_setting('app.secret_deletion_transition', true) = 'authorized' THEN
    NEW.validation_status := 'INVALID';
    NEW.validation_actual_target := NULL;
    NEW.validation_actual_scopes := NULL;
    NEW.validation_terms_version := NULL;
    NEW.validation_credential_fingerprint := NULL;
    NEW.validated_at := clock_timestamp();
    NEW.validation_valid_until := NULL;
    NEW.validation_failure_code := 'AUTHORIZATION_REVOKED';
    IF NEW.status <> 'REVOKED'
       OR NEW.secret_arn IS NOT NULL
       OR NEW.secret_arn_hash IS DISTINCT FROM COALESCE(
         OLD.secret_arn_hash,
         encode(sha256(convert_to(OLD.secret_arn, 'UTF8')), 'hex')
       )
       OR to_jsonb(NEW) - ARRAY[
         'status', 'secret_arn', 'secret_arn_hash', 'updated_at',
         'validation_status', 'validation_actual_target', 'validation_actual_scopes',
         'validation_terms_version', 'validation_credential_fingerprint', 'validated_at',
         'validation_valid_until', 'validation_failure_code'
       ]::text[] IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY[
         'status', 'secret_arn', 'secret_arn_hash', 'updated_at',
         'validation_status', 'validation_actual_target', 'validation_actual_scopes',
         'validation_terms_version', 'validation_credential_fingerprint', 'validated_at',
         'validation_valid_until', 'validation_failure_code'
       ]::text[]
       OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_SECRET_REDACTION_INVALID'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF current_setting('app.channel_authorization_validation_transition', true) = 'authorized' THEN
    IF OLD.status <> 'ACTIVE'
       OR NEW.status <> 'ACTIVE'
       OR OLD.validation_status <> 'PENDING_VALIDATION'
       OR NEW.validation_status NOT IN ('VERIFIED', 'INVALID')
       OR to_jsonb(NEW) - ARRAY[
         'validation_status', 'validation_actual_target', 'validation_actual_scopes',
         'validation_terms_version', 'validation_credential_fingerprint', 'validated_at',
         'validation_valid_until', 'validation_failure_code', 'updated_at'
       ]::text[] IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY[
         'validation_status', 'validation_actual_target', 'validation_actual_scopes',
         'validation_terms_version', 'validation_credential_fingerprint', 'validated_at',
         'validation_valid_until', 'validation_failure_code', 'updated_at'
       ]::text[]
       OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_VALIDATION_TRANSITION_FORBIDDEN'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'REVOKED' THEN
    RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_TRANSITION_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.validation_status <> 'INVALID'
     OR NEW.validation_actual_target IS NOT NULL
     OR NEW.validation_actual_scopes IS NOT NULL
     OR NEW.validation_terms_version IS NOT NULL
     OR NEW.validation_credential_fingerprint IS NOT NULL
     OR NEW.validated_at IS NULL
     OR NEW.validation_valid_until IS NOT NULL
     OR NEW.validation_failure_code <> 'AUTHORIZATION_REVOKED' THEN
    RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_REVOCATION_VALIDATION_INVALID'
      USING ERRCODE = '42501';
  END IF;
  IF ROW(
    NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.adapter_version_id, NEW.secret_arn,
    NEW.secret_arn_hash, NEW.granted_scopes, NEW.accepted_terms_version, NEW.target,
    NEW.expires_at, NEW.created_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.adapter_version_id, OLD.secret_arn,
    OLD.secret_arn_hash, OLD.granted_scopes, OLD.accepted_terms_version, OLD.target,
    OLD.expires_at, OLD.created_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_METADATA_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_TIME_REGRESSION' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER channel_authorization_mutation_guard
BEFORE UPDATE ON channel_authorizations
FOR EACH ROW EXECUTE FUNCTION guard_channel_authorization_mutation();

ALTER TABLE channel_authorizations FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION claim_channel_authorization_validation(
  p_worker_id text,
  p_lease_token uuid,
  p_now timestamptz,
  p_lease_until timestamptz
)
RETURNS TABLE (
  command_id uuid,
  tenant_id uuid,
  workspace_id uuid,
  authorization_id uuid,
  channel_definition_id uuid,
  adapter_version_id uuid,
  adapter_key text,
  adapter_version text,
  target text,
  requested_scopes text[],
  accepted_terms_version text,
  secret_reference text,
  authorization_expires_at timestamptz,
  worker_id text,
  lease_token uuid,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF length(p_worker_id) NOT BETWEEN 1 AND 160
     OR p_lease_until <= p_now
     OR p_lease_until > p_now + interval '5 minutes' THEN
    RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_VALIDATION_LEASE_INVALID' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT validation_command.id
    FROM public.channel_authorization_validation_commands validation_command
    JOIN public.channel_authorizations auth_row
      ON auth_row.tenant_id = validation_command.tenant_id
     AND auth_row.workspace_id = validation_command.workspace_id
     AND auth_row.id = validation_command.authorization_id
    WHERE (
        validation_command.status = 'PENDING'
        OR (
          validation_command.status = 'LEASED'
          AND validation_command.lease_expires_at <= p_now
        )
      )
      AND validation_command.attempt_count < 100
      AND auth_row.status = 'ACTIVE'
      AND auth_row.validation_status = 'PENDING_VALIDATION'
      AND auth_row.secret_arn IS NOT NULL
    ORDER BY validation_command.created_at, validation_command.id
    FOR UPDATE OF validation_command SKIP LOCKED
    LIMIT 1
  ),
  claimed AS (
    UPDATE public.channel_authorization_validation_commands validation_command
    SET status = 'LEASED',
        worker_id = p_worker_id,
        lease_token = p_lease_token,
        lease_expires_at = p_lease_until,
        attempt_count = validation_command.attempt_count + 1
    FROM candidate
    WHERE validation_command.id = candidate.id
    RETURNING validation_command.*
  )
  SELECT claimed.id,
         claimed.tenant_id,
         claimed.workspace_id,
         auth_row.id,
         adapter.channel_definition_id,
         auth_row.adapter_version_id,
         adapter.adapter_key,
         adapter.adapter_version,
         auth_row.target,
         auth_row.granted_scopes,
         auth_row.accepted_terms_version,
         auth_row.secret_arn,
         auth_row.expires_at,
         claimed.worker_id,
         claimed.lease_token,
         claimed.lease_expires_at
  FROM claimed
  JOIN public.channel_authorizations auth_row
    ON auth_row.tenant_id = claimed.tenant_id
   AND auth_row.workspace_id = claimed.workspace_id
   AND auth_row.id = claimed.authorization_id
  JOIN public.adapter_versions adapter ON adapter.id = auth_row.adapter_version_id;
END
$function$;

CREATE OR REPLACE FUNCTION complete_channel_authorization_validation_verified(
  p_command_id uuid,
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_authorization_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_actual_target text,
  p_actual_scopes text[],
  p_terms_version text,
  p_credential_fingerprint text,
  p_validated_at timestamptz,
  p_valid_until timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  changed_count integer;
BEGIN
  IF length(p_actual_target) NOT BETWEEN 1 AND 2048
     OR cardinality(p_actual_scopes) NOT BETWEEN 0 AND 100
     OR EXISTS (
       SELECT 1 FROM unnest(p_actual_scopes) scope
       WHERE length(btrim(scope)) NOT BETWEEN 1 AND 160
     )
     OR (SELECT count(*) FROM unnest(p_actual_scopes)) <>
        (SELECT count(DISTINCT scope) FROM unnest(p_actual_scopes) scope)
     OR length(p_terms_version) NOT BETWEEN 1 AND 120
     OR p_credential_fingerprint !~ '^[a-f0-9]{64}$'
     OR p_valid_until <= p_validated_at THEN
    RETURN false;
  END IF;

  PERFORM set_config('app.channel_authorization_validation_transition', 'authorized', true);
  WITH completed AS (
    UPDATE public.channel_authorization_validation_commands validation_command
    SET status = 'COMPLETED', completed_at = p_validated_at
    WHERE validation_command.id = p_command_id
      AND validation_command.tenant_id = p_tenant_id
      AND validation_command.workspace_id = p_workspace_id
      AND validation_command.authorization_id = p_authorization_id
      AND validation_command.status = 'LEASED'
      AND validation_command.worker_id = p_worker_id
      AND validation_command.lease_token = p_lease_token
      AND validation_command.lease_expires_at > p_validated_at
    RETURNING validation_command.authorization_id
  )
  UPDATE public.channel_authorizations auth_row
  SET validation_status = 'VERIFIED',
      validation_actual_target = p_actual_target,
      validation_actual_scopes = p_actual_scopes,
      validation_terms_version = p_terms_version,
      validation_credential_fingerprint = p_credential_fingerprint,
      validated_at = p_validated_at,
      validation_valid_until = LEAST(
        p_valid_until,
        COALESCE(auth_row.expires_at, p_valid_until)
      ),
      validation_failure_code = NULL,
      updated_at = p_validated_at
  FROM completed
  WHERE auth_row.tenant_id = p_tenant_id
    AND auth_row.workspace_id = p_workspace_id
    AND auth_row.id = completed.authorization_id
    AND auth_row.status = 'ACTIVE'
    AND auth_row.validation_status = 'PENDING_VALIDATION';
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END
$function$;

CREATE OR REPLACE FUNCTION complete_channel_authorization_validation_invalid(
  p_command_id uuid,
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_authorization_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_failure_code text,
  p_validated_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  changed_count integer;
BEGIN
  IF length(btrim(p_failure_code)) NOT BETWEEN 1 AND 120 THEN
    RETURN false;
  END IF;

  PERFORM set_config('app.channel_authorization_validation_transition', 'authorized', true);
  WITH completed AS (
    UPDATE public.channel_authorization_validation_commands validation_command
    SET status = 'COMPLETED', completed_at = p_validated_at
    WHERE validation_command.id = p_command_id
      AND validation_command.tenant_id = p_tenant_id
      AND validation_command.workspace_id = p_workspace_id
      AND validation_command.authorization_id = p_authorization_id
      AND validation_command.status = 'LEASED'
      AND validation_command.worker_id = p_worker_id
      AND validation_command.lease_token = p_lease_token
      AND validation_command.lease_expires_at > p_validated_at
    RETURNING validation_command.authorization_id
  )
  UPDATE public.channel_authorizations auth_row
  SET validation_status = 'INVALID',
      validation_actual_target = NULL,
      validation_actual_scopes = NULL,
      validation_terms_version = NULL,
      validation_credential_fingerprint = NULL,
      validated_at = p_validated_at,
      validation_valid_until = NULL,
      validation_failure_code = btrim(p_failure_code),
      updated_at = p_validated_at
  FROM completed
  WHERE auth_row.tenant_id = p_tenant_id
    AND auth_row.workspace_id = p_workspace_id
    AND auth_row.id = completed.authorization_id
    AND auth_row.status = 'ACTIVE'
    AND auth_row.validation_status = 'PENDING_VALIDATION';
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END
$function$;

CREATE OR REPLACE FUNCTION revoke_channel_authorization(
  p_authorization_id uuid,
  p_revoked_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  changed_count integer;
BEGIN
  UPDATE public.channel_authorizations auth_row
  SET status = 'REVOKED',
      validation_status = 'INVALID',
      validation_actual_target = NULL,
      validation_actual_scopes = NULL,
      validation_terms_version = NULL,
      validation_credential_fingerprint = NULL,
      validated_at = p_revoked_at,
      validation_valid_until = NULL,
      validation_failure_code = 'AUTHORIZATION_REVOKED',
      updated_at = p_revoked_at
  WHERE auth_row.tenant_id = public.aeostudio_current_tenant_id()
    AND auth_row.workspace_id =
      NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND auth_row.id = p_authorization_id
    AND auth_row.status = 'ACTIVE';
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count <> 1 THEN
    RETURN false;
  END IF;

  UPDATE public.channel_authorization_validation_commands validation_command
  SET status = 'CANCELLED',
      worker_id = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      completed_at = p_revoked_at
  FROM public.channel_authorizations auth_row
  WHERE validation_command.tenant_id = public.aeostudio_current_tenant_id()
    AND validation_command.workspace_id =
      NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND validation_command.authorization_id = p_authorization_id
    AND validation_command.status IN ('PENDING', 'LEASED')
    AND auth_row.tenant_id = validation_command.tenant_id
    AND auth_row.workspace_id = validation_command.workspace_id
    AND auth_row.id = validation_command.authorization_id
    AND auth_row.status = 'REVOKED';
  RETURN true;
END
$function$;

REVOKE ALL ON channel_authorization_validation_commands FROM PUBLIC;
GRANT INSERT ON channel_authorization_validation_commands TO aeostudio_runtime;
REVOKE ALL ON FUNCTION claim_channel_authorization_validation(text, uuid, timestamptz, timestamptz)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_channel_authorization_validation_verified(
  uuid, uuid, uuid, uuid, text, uuid, text, text[], text, text, timestamptz, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_channel_authorization_validation_invalid(
  uuid, uuid, uuid, uuid, text, uuid, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_channel_authorization(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_channel_authorization_validation(
  text, uuid, timestamptz, timestamptz
) FROM aeostudio_runtime;
REVOKE ALL ON FUNCTION complete_channel_authorization_validation_verified(
  uuid, uuid, uuid, uuid, text, uuid, text, text[], text, text, timestamptz, timestamptz
) FROM aeostudio_runtime;
REVOKE ALL ON FUNCTION complete_channel_authorization_validation_invalid(
  uuid, uuid, uuid, uuid, text, uuid, text, timestamptz
) FROM aeostudio_runtime;
GRANT EXECUTE ON FUNCTION revoke_channel_authorization(uuid, timestamptz)
  TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION claim_channel_authorization_validation(
  text, uuid, timestamptz, timestamptz
) TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION complete_channel_authorization_validation_verified(
  uuid, uuid, uuid, uuid, text, uuid, text, text[], text, text, timestamptz, timestamptz
) TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION complete_channel_authorization_validation_invalid(
  uuid, uuid, uuid, uuid, text, uuid, text, timestamptz
) TO aeostudio_lifecycle_worker;
