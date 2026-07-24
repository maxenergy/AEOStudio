-- Task 18: a full page of permanently failing exact-version Legal Hold
-- reconciliations must not starve later work from another Tenant.
ALTER TABLE legal_hold_object_reconciliations
  ADD COLUMN next_attempt_at timestamptz NOT NULL
    DEFAULT '-infinity'::timestamptz;

CREATE OR REPLACE FUNCTION public.claim_pending_legal_hold_reconciliations(
  p_lease_token uuid,
  p_limit integer
)
RETURNS TABLE (
  tenant_id uuid,
  object_class text,
  object_key text,
  object_version_id text,
  desired_status text,
  desired_revision bigint,
  lease_token uuid,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
BEGIN
  IF p_lease_token IS NULL OR p_limit IS NULL
     OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'LEGAL_HOLD_RECONCILIATION_CLAIM_INVALID'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH claimed AS (
    SELECT state.tenant_id, state.object_key, state.object_version_id
    FROM public.legal_hold_object_reconciliations state
    JOIN public.managed_object_versions object_version
      ON object_version.tenant_id = state.tenant_id
     AND object_version.object_key = state.object_key
     AND object_version.object_version_id = state.object_version_id
    WHERE object_version.lifecycle_state <> 'DELETED'
      AND (
        state.applied_revision < state.desired_revision
        OR state.applied_status <> state.desired_status
      )
      AND state.next_attempt_at <= database_now
      AND (
        state.work_lease_expires_at IS NULL
        OR state.work_lease_expires_at <= database_now
      )
    ORDER BY state.updated_at, state.tenant_id, state.object_key,
      state.object_version_id
    FOR UPDATE OF state SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.legal_hold_object_reconciliations state
  SET work_lease_token = p_lease_token,
      work_lease_expires_at = database_now + interval '5 minutes',
      work_attempt_count = state.work_attempt_count + 1
  FROM claimed
  WHERE state.tenant_id = claimed.tenant_id
    AND state.object_key = claimed.object_key
    AND state.object_version_id = claimed.object_version_id
  RETURNING state.tenant_id, state.object_class, state.object_key,
    state.object_version_id, state.desired_status, state.desired_revision,
    state.work_lease_token, state.work_lease_expires_at;
END
$function$;

CREATE OR REPLACE FUNCTION public.release_legal_hold_reconciliation_lease(
  p_tenant_id uuid,
  p_object_key text,
  p_object_version_id text,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  affected integer;
  database_now timestamptz := clock_timestamp();
BEGIN
  IF p_tenant_id IS NULL
     OR p_object_key IS NULL
     OR p_object_version_id IS NULL
     OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'LEGAL_HOLD_RECONCILIATION_RELEASE_INVALID'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.legal_hold_object_reconciliations state
  SET work_lease_token = NULL,
      work_lease_expires_at = NULL,
      next_attempt_at = database_now + interval '30 seconds',
      updated_at = database_now
  WHERE state.tenant_id = p_tenant_id
    AND state.object_key = p_object_key
    AND state.object_version_id = p_object_version_id
    AND state.work_lease_token = p_lease_token;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END
$function$;

REVOKE ALL ON FUNCTION public.claim_pending_legal_hold_reconciliations(
  uuid, integer
) FROM PUBLIC, aeostudio_runtime;
REVOKE ALL ON FUNCTION public.release_legal_hold_reconciliation_lease(
  uuid, text, text, uuid
) FROM PUBLIC, aeostudio_runtime;
GRANT EXECUTE ON FUNCTION public.claim_pending_legal_hold_reconciliations(
  uuid, integer
) TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION public.release_legal_hold_reconciliation_lease(
  uuid, text, text, uuid
) TO aeostudio_lifecycle_worker;
