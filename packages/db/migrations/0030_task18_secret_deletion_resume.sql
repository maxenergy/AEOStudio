-- Task 18: expose the database-owned secret-deletion state to the lifecycle
-- worker so a reclaimed FORCE_DELETE_REQUESTED lease resumes at the
-- unreadability probe instead of attempting a second provider delete.
--
-- This is a forward migration because PostgreSQL cannot change a function's
-- RETURNS TABLE row type with CREATE OR REPLACE, and historical migration
-- checksums must remain immutable on already-migrated databases.
DROP FUNCTION public.claim_due_secret_deletions(uuid, integer);

CREATE FUNCTION public.claim_due_secret_deletions(
  p_lease_token uuid,
  p_limit integer
)
RETURNS TABLE (
  tenant_id uuid,
  workspace_id uuid,
  channel_authorization_id uuid,
  deletion_request_id uuid,
  secret_reference text,
  force_delete_at timestamptz,
  state text,
  lease_token uuid,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_lease_token IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'SECRET_DELETION_WORK_CLAIM_INVALID' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT claimed.tenant_id,
    claimed.workspace_id,
    claimed.channel_authorization_id,
    claimed.deletion_request_id,
    claimed.secret_reference,
    claimed.force_delete_at,
    secret.state,
    claimed.lease_token,
    claimed.lease_expires_at
  FROM public.claim_due_secret_deletions_legacy_impl(
    p_lease_token,
    p_limit
  ) AS claimed
  JOIN public.connector_secret_deletions AS secret
    ON secret.tenant_id = claimed.tenant_id
   AND secret.channel_authorization_id = claimed.channel_authorization_id;
END
$function$;

REVOKE ALL ON FUNCTION public.claim_due_secret_deletions(uuid, integer)
  FROM PUBLIC, aeostudio_runtime, aeostudio_tenant_data_broker;
GRANT EXECUTE ON FUNCTION public.claim_due_secret_deletions(uuid, integer)
  TO aeostudio_lifecycle_worker;
