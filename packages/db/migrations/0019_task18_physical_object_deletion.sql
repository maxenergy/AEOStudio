-- Task 18: expose only exact object identities covered by one currently valid
-- deletion lease. ACTIVE means the 30-day live-object purge; BACKUP only
-- catches versions that were retained by a named hold and later released.
CREATE FUNCTION list_due_deletion_object_versions(
  p_request_id uuid,
  p_lease_token uuid,
  p_limit integer
)
RETURNS TABLE (
  tenant_id uuid,
  object_class text,
  object_key text,
  object_version_id text,
  legal_hold boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  deletion_request public.deletion_requests%ROWTYPE;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'DELETION_OBJECT_WORK_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT request.* INTO deletion_request
  FROM public.deletion_requests request
  WHERE request.id = p_request_id
    AND request.finalization_lease_token = p_lease_token
    AND request.finalization_lease_expires_at > database_now;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINALIZATION_LEASE_INVALID' USING ERRCODE = '42501';
  END IF;

  IF deletion_request.state = 'FROZEN'
     AND deletion_request.active_delete_by <= database_now THEN
    RETURN QUERY
    SELECT object_version.tenant_id, object_version.object_class,
      object_version.object_key, object_version.object_version_id,
      false
    FROM public.managed_object_versions object_version
    WHERE object_version.tenant_id = deletion_request.tenant_id
      AND object_version.lifecycle_state = 'ACTIVE'
      AND object_version.object_class <> 'AUDIT_DIGEST'
      AND (deletion_request.scope_kind = 'TENANT'
        OR object_version.workspace_id = deletion_request.workspace_id
        OR object_version.object_class = 'TENANT_EXPORT')
      AND NOT EXISTS (
        SELECT 1
        FROM public.legal_hold_object_versions target
        JOIN public.legal_holds hold_row
          ON hold_row.tenant_id = target.tenant_id AND hold_row.id = target.hold_id
        WHERE target.tenant_id = object_version.tenant_id
          AND target.object_key = object_version.object_key
          AND target.object_version_id = object_version.object_version_id
          AND hold_row.status = 'ACTIVE'
      )
    ORDER BY object_version.object_class, object_version.object_key,
      object_version.object_version_id
    LIMIT p_limit + 1;
    RETURN;
  END IF;

  IF deletion_request.state IN ('ACTIVE_DATA_DELETED', 'BLOCKED_BY_LEGAL_HOLD')
     AND deletion_request.active_deleted_at IS NOT NULL THEN
    RETURN QUERY
    SELECT object_version.tenant_id, object_version.object_class,
      object_version.object_key, object_version.object_version_id, false
    FROM public.managed_object_versions object_version
    WHERE object_version.tenant_id = deletion_request.tenant_id
      AND object_version.deletion_request_id = p_request_id
      AND object_version.lifecycle_state = 'DELETE_DUE'
    ORDER BY object_version.object_class, object_version.object_key,
      object_version.object_version_id
    LIMIT p_limit + 1;
    RETURN;
  END IF;

  RAISE EXCEPTION 'FINALIZATION_LEASE_INVALID' USING ERRCODE = '42501';
END
$function$;

REVOKE ALL ON FUNCTION list_due_deletion_object_versions(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_due_deletion_object_versions(uuid, uuid, integer)
  FROM aeostudio_runtime;
GRANT EXECUTE ON FUNCTION list_due_deletion_object_versions(uuid, uuid, integer)
  TO aeostudio_lifecycle_worker;

CREATE FUNCTION mark_deletion_object_version_deleted(
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
  database_now timestamptz := clock_timestamp();
  deletion_request public.deletion_requests%ROWTYPE;
  affected_rows integer;
BEGIN
  SELECT request.* INTO deletion_request
  FROM public.deletion_requests request
  WHERE request.id = p_request_id
    AND request.tenant_id = p_tenant_id
    AND request.finalization_lease_token = p_lease_token
    AND request.finalization_lease_expires_at > database_now;
  IF NOT FOUND THEN RETURN false; END IF;

  PERFORM set_config('app.tenant_id', deletion_request.tenant_id::text, true);
  PERFORM set_config('app.lifecycle_request_id', deletion_request.id::text, true);
  PERFORM set_config('app.lifecycle_effective_at', database_now::text, true);

  IF deletion_request.state = 'FROZEN'
     AND deletion_request.active_delete_by <= database_now THEN
    UPDATE public.managed_object_versions object_version
    SET lifecycle_state = 'DELETED', deletion_request_id = deletion_request.id,
      deleted_at = database_now
    WHERE object_version.tenant_id = deletion_request.tenant_id
      AND object_version.object_key = p_object_key
      AND object_version.object_version_id = p_object_version_id
      AND object_version.lifecycle_state = 'ACTIVE'
      AND object_version.object_class <> 'AUDIT_DIGEST'
      AND (deletion_request.scope_kind = 'TENANT'
        OR object_version.workspace_id = deletion_request.workspace_id
        OR object_version.object_class = 'TENANT_EXPORT')
      AND NOT EXISTS (
        SELECT 1
        FROM public.legal_hold_object_versions target
        JOIN public.legal_holds hold_row
          ON hold_row.tenant_id = target.tenant_id AND hold_row.id = target.hold_id
        WHERE target.tenant_id = object_version.tenant_id
          AND target.object_key = object_version.object_key
          AND target.object_version_id = object_version.object_version_id
          AND hold_row.status = 'ACTIVE'
      );
  ELSIF deletion_request.state IN ('ACTIVE_DATA_DELETED', 'BLOCKED_BY_LEGAL_HOLD')
     AND deletion_request.active_deleted_at IS NOT NULL THEN
    UPDATE public.managed_object_versions object_version
    SET lifecycle_state = 'DELETED', deleted_at = database_now
    WHERE object_version.tenant_id = deletion_request.tenant_id
      AND object_version.object_key = p_object_key
      AND object_version.object_version_id = p_object_version_id
      AND object_version.deletion_request_id = deletion_request.id
      AND object_version.lifecycle_state = 'DELETE_DUE';
  ELSE
    RETURN false;
  END IF;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows = 1 THEN RETURN true; END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.managed_object_versions object_version
    WHERE object_version.tenant_id = deletion_request.tenant_id
      AND object_version.object_key = p_object_key
      AND object_version.object_version_id = p_object_version_id
      AND object_version.deletion_request_id = deletion_request.id
      AND object_version.lifecycle_state = 'DELETED'
  );
END
$function$;

CREATE FUNCTION release_deletion_work_lease(p_request_id uuid, p_lease_token uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  released_id uuid;
BEGIN
  UPDATE public.deletion_requests request
  SET finalization_lease_token = NULL, finalization_lease_expires_at = NULL
  WHERE request.id = p_request_id
    AND request.finalization_lease_token = p_lease_token
    AND request.finalization_lease_expires_at > clock_timestamp()
  RETURNING request.id INTO released_id;
  RETURN released_id IS NOT NULL;
END
$function$;

REVOKE ALL ON FUNCTION mark_deletion_object_version_deleted(
  uuid, uuid, uuid, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_deletion_work_lease(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION mark_deletion_object_version_deleted(
  uuid, uuid, uuid, text, text
) FROM aeostudio_runtime;
REVOKE ALL ON FUNCTION release_deletion_work_lease(uuid, uuid) FROM aeostudio_runtime;
GRANT EXECUTE ON FUNCTION mark_deletion_object_version_deleted(
  uuid, uuid, uuid, text, text
) TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION release_deletion_work_lease(uuid, uuid)
  TO aeostudio_lifecycle_worker;
