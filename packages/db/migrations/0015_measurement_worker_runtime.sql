CREATE INDEX measurement_outbox_pending_order_idx
  ON outbox_messages (created_at, id, aggregate_id)
  WHERE published_at IS NULL AND message_type = 'JOB_QUEUED';

CREATE INDEX jobs_active_tenant_lease_idx
  ON jobs (tenant_id, lease_expires_at, id)
  WHERE status = 'RUNNING';

CREATE OR REPLACE FUNCTION list_pending_measurement_job_outbox(p_limit integer)
RETURNS TABLE (
  message_id uuid,
  tenant_id uuid,
  workspace_id uuid,
  payload jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT message.id, message.tenant_id, message.workspace_id, message.payload
  FROM public.outbox_messages message
  JOIN public.jobs job
    ON job.id = message.aggregate_id
   AND job.tenant_id = message.tenant_id
   AND job.workspace_id = message.workspace_id
  WHERE message.published_at IS NULL
    AND message.message_type = 'JOB_QUEUED'
    AND job.job_type = 'MEASUREMENT'
    AND (
      job.status IN ('SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED')
      OR (
        (
          job.status = 'QUEUED'
          OR (
            job.status = 'RUNNING'
            AND (job.lease_expires_at IS NULL OR job.lease_expires_at < statement_timestamp())
          )
          OR (
            job.status = 'RETRY_WAIT'
            AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= statement_timestamp())
          )
        )
        AND (
          SELECT count(*)
          FROM public.jobs active_job
          WHERE active_job.tenant_id = job.tenant_id
            AND active_job.status = 'RUNNING'
            AND active_job.lease_expires_at >= statement_timestamp()
            AND active_job.id <> job.id
        ) < 5
      )
    )
  ORDER BY
    CASE job.status
      WHEN 'RUNNING' THEN COALESCE(job.lease_expires_at, message.created_at)
      WHEN 'RETRY_WAIT' THEN COALESCE(job.next_attempt_at, message.created_at)
      ELSE message.created_at
    END,
    message.created_at,
    message.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$function$;

REVOKE ALL ON FUNCTION list_pending_measurement_job_outbox(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_pending_measurement_job_outbox(integer) TO aeostudio_runtime;
