-- Task 18: durable exact-version S3 Legal Hold reconciliation.
--
-- Legal-hold API transactions only write a monotonic desired revision. A
-- leased worker applies that revision to S3 and acknowledges it with a CAS.
-- This removes the impossible-to-atomically-commit DB/S3 dual-write and makes
-- crash/retry and create-vs-last-release races idempotent and fail-closed.
CREATE TABLE legal_hold_object_reconciliations (
  tenant_id uuid NOT NULL,
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 2048),
  object_version_id text NOT NULL CHECK (length(object_version_id) BETWEEN 1 AND 1024),
  object_class text NOT NULL CHECK (object_class IN (
    'ACTIVE_TENANT_DATA', 'BACKUP_COPY', 'RAW_PROMPT_RESPONSE', 'CRAWL_SNAPSHOT',
    'SCREENSHOT', 'APPLICATION_LOG', 'AUDIT_DIGEST', 'ARTIFACT_PAYLOAD',
    'CHANNEL_PACKAGE', 'EVIDENCE_SNAPSHOT', 'TENANT_EXPORT'
  )),
  desired_status text NOT NULL CHECK (desired_status IN ('ON', 'OFF')),
  desired_revision bigint NOT NULL CHECK (desired_revision >= 1),
  applied_status text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (applied_status IN ('UNKNOWN', 'ON', 'OFF')),
  applied_revision bigint NOT NULL DEFAULT 0 CHECK (applied_revision >= 0),
  work_lease_token uuid,
  work_lease_expires_at timestamptz,
  work_attempt_count integer NOT NULL DEFAULT 0 CHECK (work_attempt_count >= 0),
  updated_at timestamptz NOT NULL,
  applied_at timestamptz,
  PRIMARY KEY (tenant_id, object_key, object_version_id),
  FOREIGN KEY (tenant_id, object_key, object_version_id)
    REFERENCES managed_object_versions(tenant_id, object_key, object_version_id),
  CHECK ((work_lease_token IS NULL) = (work_lease_expires_at IS NULL)),
  CHECK (applied_revision <= desired_revision),
  CHECK (applied_revision > 0 OR applied_status = 'UNKNOWN')
);

ALTER TABLE legal_hold_object_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_hold_object_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY legal_hold_object_reconciliation_isolation
  ON legal_hold_object_reconciliations
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

CREATE FUNCTION refresh_legal_hold_object_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  target_tenant_id uuid;
  target_key text;
  target_version text;
  target_class text;
  target_status text;
  database_now timestamptz := clock_timestamp();
BEGIN
  IF TG_TABLE_NAME = 'legal_hold_object_versions' THEN
    target_tenant_id := NEW.tenant_id;
    target_key := NEW.object_key;
    target_version := NEW.object_version_id;
  ELSE
    SELECT target.tenant_id, target.object_key, target.object_version_id
      INTO target_tenant_id, target_key, target_version
    FROM public.legal_hold_object_versions target
    WHERE target.tenant_id = NEW.tenant_id AND target.hold_id = NEW.id;
  END IF;
  IF target_tenant_id IS NULL THEN RETURN NEW; END IF;

  SELECT object_version.object_class INTO target_class
  FROM public.managed_object_versions object_version
  WHERE object_version.tenant_id = target_tenant_id
    AND object_version.object_key = target_key
    AND object_version.object_version_id = target_version
  FOR UPDATE;
  IF target_class IS NULL THEN
    RAISE EXCEPTION 'LEGAL_HOLD_OBJECT_STORAGE_IDENTITY_MISSING' USING ERRCODE = 'P0002';
  END IF;

  target_status := CASE WHEN EXISTS (
    SELECT 1
    FROM public.legal_hold_object_versions target
    JOIN public.legal_holds hold_row
      ON hold_row.tenant_id = target.tenant_id AND hold_row.id = target.hold_id
    WHERE target.tenant_id = target_tenant_id
      AND target.object_key = target_key
      AND target.object_version_id = target_version
      AND hold_row.status = 'ACTIVE'
  ) THEN 'ON' ELSE 'OFF' END;

  INSERT INTO public.legal_hold_object_reconciliations (
    tenant_id, object_key, object_version_id, object_class, desired_status,
    desired_revision, applied_status, applied_revision, updated_at
  ) VALUES (
    target_tenant_id, target_key, target_version, target_class, target_status,
    1, 'UNKNOWN', 0, database_now
  )
  ON CONFLICT (tenant_id, object_key, object_version_id) DO UPDATE
  SET object_class = EXCLUDED.object_class,
      desired_status = EXCLUDED.desired_status,
      desired_revision = CASE
        WHEN legal_hold_object_reconciliations.desired_status
          IS DISTINCT FROM EXCLUDED.desired_status
        THEN legal_hold_object_reconciliations.desired_revision + 1
        ELSE legal_hold_object_reconciliations.desired_revision
      END,
      updated_at = database_now;
  RETURN NEW;
END
$function$;

CREATE TRIGGER legal_hold_target_reconciliation_insert
AFTER INSERT ON legal_hold_object_versions
FOR EACH ROW EXECUTE FUNCTION refresh_legal_hold_object_reconciliation();

CREATE TRIGGER legal_hold_status_reconciliation_update
AFTER UPDATE OF status ON legal_holds
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION refresh_legal_hold_object_reconciliation();

-- Existing databases may already contain active or released exact-version
-- holds from Task 17. Seed both so a prior remote ON is explicitly reconciled.
INSERT INTO legal_hold_object_reconciliations (
  tenant_id, object_key, object_version_id, object_class, desired_status,
  desired_revision, applied_status, applied_revision, updated_at
)
SELECT target.tenant_id, target.object_key, target.object_version_id,
  object_version.object_class,
  CASE WHEN bool_or(hold_row.status = 'ACTIVE') THEN 'ON' ELSE 'OFF' END,
  1, 'UNKNOWN', 0, clock_timestamp()
FROM legal_hold_object_versions target
JOIN legal_holds hold_row
  ON hold_row.tenant_id = target.tenant_id AND hold_row.id = target.hold_id
JOIN managed_object_versions object_version
  ON object_version.tenant_id = target.tenant_id
 AND object_version.object_key = target.object_key
 AND object_version.object_version_id = target.object_version_id
GROUP BY target.tenant_id, target.object_key, target.object_version_id,
  object_version.object_class
ON CONFLICT (tenant_id, object_key, object_version_id) DO NOTHING;

CREATE FUNCTION claim_pending_legal_hold_reconciliations(
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
  IF p_lease_token IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'LEGAL_HOLD_RECONCILIATION_CLAIM_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH claimed AS (
    SELECT state.tenant_id, state.object_key, state.object_version_id
    FROM public.legal_hold_object_reconciliations state
    WHERE (state.applied_revision < state.desired_revision
        OR state.applied_status <> state.desired_status)
      AND (state.work_lease_expires_at IS NULL
        OR state.work_lease_expires_at <= database_now)
    ORDER BY state.updated_at, state.tenant_id, state.object_key, state.object_version_id
    FOR UPDATE SKIP LOCKED
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

CREATE FUNCTION complete_legal_hold_reconciliation(
  p_tenant_id uuid,
  p_object_key text,
  p_object_version_id text,
  p_desired_status text,
  p_desired_revision bigint,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  completed_rows integer;
BEGIN
  IF p_desired_status NOT IN ('ON', 'OFF') OR p_desired_revision < 1 THEN
    RETURN false;
  END IF;
  UPDATE public.legal_hold_object_reconciliations state
  SET applied_status = p_desired_status,
      applied_revision = p_desired_revision,
      applied_at = clock_timestamp(),
      work_lease_token = NULL,
      work_lease_expires_at = NULL
  WHERE state.tenant_id = p_tenant_id
    AND state.object_key = p_object_key
    AND state.object_version_id = p_object_version_id
    AND state.desired_status = p_desired_status
    AND state.desired_revision = p_desired_revision
    AND state.work_lease_token = p_lease_token
    AND state.work_lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS completed_rows = ROW_COUNT;
  IF completed_rows = 1 THEN RETURN true; END IF;

  -- A concurrent API transaction may have advanced the desired revision while
  -- the remote request was in flight. The stale remote effect is now the last
  -- known physical state, so invalidate any older acknowledgement before the
  -- new revision can be claimed. Keeping the original lease across a desired
  -- revision change serializes the two remote effects until this CAS executes.
  UPDATE public.legal_hold_object_reconciliations state
  SET applied_status = 'UNKNOWN',
      applied_revision = 0,
      applied_at = NULL,
      work_lease_token = NULL,
      work_lease_expires_at = NULL
  WHERE state.tenant_id = p_tenant_id
    AND state.object_key = p_object_key
    AND state.object_version_id = p_object_version_id
    AND state.work_lease_token = p_lease_token;
  RETURN false;
END
$function$;

CREATE FUNCTION release_legal_hold_reconciliation_lease(
  p_tenant_id uuid,
  p_object_key text,
  p_object_version_id text,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  WITH released AS (
    UPDATE public.legal_hold_object_reconciliations state
    SET work_lease_token = NULL, work_lease_expires_at = NULL
    WHERE state.tenant_id = p_tenant_id
      AND state.object_key = p_object_key
      AND state.object_version_id = p_object_version_id
      AND state.work_lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM released)
$function$;

REVOKE ALL ON legal_hold_object_reconciliations FROM PUBLIC;
REVOKE ALL ON legal_hold_object_reconciliations FROM aeostudio_runtime;
REVOKE ALL ON FUNCTION refresh_legal_hold_object_reconciliation() FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_pending_legal_hold_reconciliations(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_legal_hold_reconciliation(
  uuid, text, text, text, bigint, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_legal_hold_reconciliation_lease(
  uuid, text, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_pending_legal_hold_reconciliations(uuid, integer)
  FROM aeostudio_runtime;
REVOKE ALL ON FUNCTION complete_legal_hold_reconciliation(
  uuid, text, text, text, bigint, uuid
) FROM aeostudio_runtime;
REVOKE ALL ON FUNCTION release_legal_hold_reconciliation_lease(
  uuid, text, text, uuid
) FROM aeostudio_runtime;
GRANT EXECUTE ON FUNCTION claim_pending_legal_hold_reconciliations(uuid, integer)
  TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION complete_legal_hold_reconciliation(
  uuid, text, text, text, bigint, uuid
) TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION release_legal_hold_reconciliation_lease(
  uuid, text, text, uuid
) TO aeostudio_lifecycle_worker;
