-- Task 18: rotate previously claimed deletion work behind never-claimed work.
-- Inventory drains and transient remote failures deliberately release their
-- exact lease; ordering only by the original due date would otherwise let one
-- full poison page starve every later Tenant forever.
CREATE OR REPLACE FUNCTION public.claim_due_deletion_requests(
  p_lease_token uuid,
  p_limit integer
)
RETURNS TABLE (
  request_id uuid,
  stage text,
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
    RAISE EXCEPTION 'DELETION_WORK_CLAIM_INVALID' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH due AS (
    SELECT request.id
    FROM public.deletion_requests request
    WHERE (
        request.finalization_lease_expires_at IS NULL
        OR request.finalization_lease_expires_at <= database_now
      )
      AND (
        (
          request.state = 'FROZEN'
          AND request.active_delete_by <= database_now
          AND NOT EXISTS (
            SELECT 1
            FROM public.connector_secret_deletions secret
            WHERE secret.deletion_request_id = request.id
              AND secret.state <> 'VERIFIED_UNREADABLE'
          )
        )
        OR (
          request.state = 'ACTIVE_DATA_DELETED'
          AND request.active_deleted_at IS NOT NULL
          AND (
            request.backup_delete_by <= database_now
            OR EXISTS (
              SELECT 1
              FROM public.managed_object_versions object_version
              WHERE object_version.tenant_id = request.tenant_id
                AND object_version.deletion_request_id = request.id
                AND object_version.lifecycle_state = 'DELETE_DUE'
            )
          )
        )
        OR (
          request.state = 'BLOCKED_BY_LEGAL_HOLD'
          AND request.active_deleted_at IS NOT NULL
          AND request.backup_delete_by <= database_now
          AND NOT EXISTS (
            SELECT 1
            FROM public.managed_object_versions object_version
            JOIN public.legal_hold_object_versions target
              ON target.tenant_id = object_version.tenant_id
             AND target.object_key = object_version.object_key
             AND target.object_version_id = object_version.object_version_id
            JOIN public.legal_holds hold_row
              ON hold_row.tenant_id = target.tenant_id
             AND hold_row.id = target.hold_id
            WHERE object_version.tenant_id = request.tenant_id
              AND object_version.lifecycle_state = 'LEGAL_HOLD'
              AND hold_row.status = 'ACTIVE'
              AND (
                request.scope_kind = 'TENANT'
                OR object_version.workspace_id = request.workspace_id
                OR object_version.object_class = 'TENANT_EXPORT'
              )
          )
        )
        OR request.state = 'BACKUP_DELETED'
      )
    ORDER BY
      request.finalization_last_claimed_at ASC NULLS FIRST,
      CASE
        WHEN request.state = 'FROZEN' THEN request.active_delete_by
        WHEN request.state = 'BACKUP_DELETED' THEN request.backup_deleted_at
        WHEN request.state = 'ACTIVE_DATA_DELETED'
          AND EXISTS (
            SELECT 1
            FROM public.managed_object_versions object_version
            WHERE object_version.tenant_id = request.tenant_id
              AND object_version.deletion_request_id = request.id
              AND object_version.lifecycle_state = 'DELETE_DUE'
          ) THEN database_now
        ELSE request.backup_delete_by
      END,
      request.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ),
  claimed AS (
    UPDATE public.deletion_requests request
    SET finalization_lease_token = p_lease_token,
        finalization_lease_expires_at = database_now + interval '5 minutes',
        finalization_attempt_count = request.finalization_attempt_count + 1,
        finalization_last_claimed_at = database_now
    FROM due
    WHERE request.id = due.id
    RETURNING request.id, request.state, request.backup_delete_by,
      request.finalization_lease_token, request.finalization_lease_expires_at
  )
  SELECT claimed.id,
    CASE
      WHEN claimed.state = 'FROZEN' THEN 'ACTIVE'
      WHEN claimed.state = 'BACKUP_DELETED' THEN 'TOMBSTONE'
      WHEN claimed.state = 'ACTIVE_DATA_DELETED'
        AND claimed.backup_delete_by > database_now THEN 'OBJECT'
      ELSE 'BACKUP'
    END,
    claimed.finalization_lease_token,
    claimed.finalization_lease_expires_at
  FROM claimed
  ORDER BY claimed.id;
END
$function$;

REVOKE ALL ON FUNCTION public.claim_due_deletion_requests(uuid, integer)
  FROM PUBLIC, aeostudio_runtime, aeostudio_tenant_data_broker;
GRANT EXECUTE ON FUNCTION public.claim_due_deletion_requests(uuid, integer)
  TO aeostudio_lifecycle_worker;
