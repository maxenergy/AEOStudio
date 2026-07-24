DROP FUNCTION public.list_pending_job_outbox(integer);

CREATE FUNCTION public.list_pending_job_outbox(p_limit integer)
RETURNS TABLE (
  message_id uuid,
  tenant_id uuid,
  workspace_id uuid,
  job_type text,
  payload jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT message.id, message.tenant_id, message.workspace_id, job.job_type, message.payload
  FROM public.outbox_messages message
  JOIN public.jobs job
    ON job.id = message.aggregate_id
   AND job.tenant_id = message.tenant_id
   AND job.workspace_id = message.workspace_id
  JOIN public.tenants tenant ON tenant.id = message.tenant_id
  JOIN public.workspaces workspace
    ON workspace.tenant_id = message.tenant_id AND workspace.id = message.workspace_id
  WHERE message.published_at IS NULL
    AND message.suppressed_at IS NULL
    AND message.message_type = 'JOB_QUEUED'
    AND job.lifecycle_frozen_at IS NULL
    AND tenant.lifecycle_state = 'ACTIVE'
    AND workspace.lifecycle_state = 'ACTIVE'
  ORDER BY message.created_at, message.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$function$;

REVOKE ALL ON FUNCTION public.list_pending_job_outbox(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_pending_job_outbox(integer) TO aeostudio_runtime;
