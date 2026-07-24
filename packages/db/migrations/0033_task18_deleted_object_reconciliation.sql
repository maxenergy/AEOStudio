-- A physically deleted exact version has no remaining remote Legal Hold to
-- reconcile. Settle OFF work atomically and reject the impossible combination
-- of a DELETED version with desired ON, so stale rows cannot monopolize every
-- worker claim page.
DO $deleted_object_reconciliation_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.legal_hold_object_reconciliations state
    JOIN public.managed_object_versions object_version
      ON object_version.tenant_id = state.tenant_id
     AND object_version.object_key = state.object_key
     AND object_version.object_version_id = state.object_version_id
    WHERE object_version.lifecycle_state = 'DELETED'
      AND state.desired_status = 'ON'
  ) THEN
    RAISE EXCEPTION 'DELETED_OBJECT_LEGAL_HOLD_INVARIANT'
      USING ERRCODE = '23514';
  END IF;
END
$deleted_object_reconciliation_preflight$;

UPDATE public.legal_hold_object_reconciliations state
SET applied_status = 'OFF',
    applied_revision = state.desired_revision,
    applied_at = clock_timestamp(),
    work_lease_token = NULL,
    work_lease_expires_at = NULL,
    updated_at = clock_timestamp()
FROM public.managed_object_versions object_version
WHERE object_version.tenant_id = state.tenant_id
  AND object_version.object_key = state.object_key
  AND object_version.object_version_id = state.object_version_id
  AND object_version.lifecycle_state = 'DELETED'
  AND state.desired_status = 'OFF';

CREATE FUNCTION public.guard_deleted_object_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.managed_object_versions object_version
    WHERE object_version.tenant_id = NEW.tenant_id
      AND object_version.object_key = NEW.object_key
      AND object_version.object_version_id = NEW.object_version_id
      AND object_version.lifecycle_state = 'DELETED'
  ) THEN
    IF NEW.desired_status <> 'OFF' THEN
      RAISE EXCEPTION 'DELETED_OBJECT_LEGAL_HOLD_INVARIANT'
        USING ERRCODE = '23514';
    END IF;
    NEW.applied_status := 'OFF';
    NEW.applied_revision := NEW.desired_revision;
    NEW.applied_at := clock_timestamp();
    NEW.work_lease_token := NULL;
    NEW.work_lease_expires_at := NULL;
    NEW.updated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER deleted_object_reconciliation_guard
BEFORE INSERT OR UPDATE OF desired_status, desired_revision, applied_status,
  applied_revision, work_lease_token, work_lease_expires_at
ON public.legal_hold_object_reconciliations
FOR EACH ROW EXECUTE FUNCTION public.guard_deleted_object_reconciliation();

ALTER FUNCTION public.mark_deletion_object_version_deleted(
  uuid, uuid, uuid, text, text
) RENAME TO mark_deletion_object_version_deleted_legacy_impl;

REVOKE ALL ON FUNCTION public.mark_deletion_object_version_deleted_legacy_impl(
  uuid, uuid, uuid, text, text
) FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker;

CREATE FUNCTION public.mark_deletion_object_version_deleted(
  p_request_id uuid,
  p_lease_token uuid,
  p_tenant_id uuid,
  p_object_key text,
  p_object_version_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  marked boolean;
BEGIN
  marked := public.mark_deletion_object_version_deleted_legacy_impl(
    p_request_id,
    p_lease_token,
    p_tenant_id,
    p_object_key,
    p_object_version_id
  );
  IF NOT marked THEN RETURN false; END IF;

  IF EXISTS (
    SELECT 1
    FROM public.legal_hold_object_reconciliations state
    JOIN public.managed_object_versions object_version
      ON object_version.tenant_id = state.tenant_id
     AND object_version.object_key = state.object_key
     AND object_version.object_version_id = state.object_version_id
    WHERE state.tenant_id = p_tenant_id
      AND state.object_key = p_object_key
      AND state.object_version_id = p_object_version_id
      AND object_version.lifecycle_state = 'DELETED'
      AND state.desired_status = 'ON'
  ) THEN
    RAISE EXCEPTION 'DELETED_OBJECT_LEGAL_HOLD_INVARIANT'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.legal_hold_object_reconciliations state
  SET applied_status = 'OFF',
      applied_revision = state.desired_revision,
      applied_at = clock_timestamp(),
      work_lease_token = NULL,
      work_lease_expires_at = NULL,
      updated_at = clock_timestamp()
  WHERE state.tenant_id = p_tenant_id
    AND state.object_key = p_object_key
    AND state.object_version_id = p_object_version_id
    AND state.desired_status = 'OFF';
  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION public.mark_deletion_object_version_deleted(
  uuid, uuid, uuid, text, text
) FROM PUBLIC, aeostudio_runtime;
GRANT EXECUTE ON FUNCTION public.mark_deletion_object_version_deleted(
  uuid, uuid, uuid, text, text
) TO aeostudio_lifecycle_worker;

DROP FUNCTION public.claim_pending_legal_hold_reconciliations(uuid, integer);

CREATE FUNCTION public.claim_pending_legal_hold_reconciliations(
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

REVOKE ALL ON FUNCTION public.guard_deleted_object_reconciliation()
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;
REVOKE ALL ON FUNCTION public.claim_pending_legal_hold_reconciliations(
  uuid, integer
) FROM PUBLIC, aeostudio_runtime;
GRANT EXECUTE ON FUNCTION public.claim_pending_legal_hold_reconciliations(
  uuid, integer
) TO aeostudio_lifecycle_worker;
