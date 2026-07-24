ALTER TABLE outbox_messages
  ADD COLUMN traceparent text,
  ADD COLUMN request_id uuid,
  ADD CONSTRAINT outbox_messages_trace_context_pair CHECK (
    (traceparent IS NULL AND request_id IS NULL)
    OR (
      traceparent IS NOT NULL
      AND request_id IS NOT NULL
      AND traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
      AND substring(traceparent FROM 4 FOR 32) <> repeat('0', 32)
      AND substring(traceparent FROM 37 FOR 16) <> repeat('0', 16)
    )
  );

DROP FUNCTION public.list_pending_job_outbox(integer);

CREATE FUNCTION public.list_pending_job_outbox(p_limit integer)
RETURNS TABLE (
  message_id uuid,
  tenant_id uuid,
  workspace_id uuid,
  job_type text,
  payload jsonb,
  traceparent text,
  request_id uuid
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT
    message.id,
    message.tenant_id,
    message.workspace_id,
    job.job_type,
    message.payload,
    message.traceparent,
    message.request_id
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
