CREATE TABLE budget_policies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  limit_units bigint NOT NULL CHECK (limit_units > 0),
  warning_percent integer NOT NULL DEFAULT 80 CHECK (warning_percent BETWEEN 1 AND 99),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  job_type text NOT NULL CHECK (job_type IN ('PROFILE_READINESS')),
  aggregate_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN (
    'BUDGET_BLOCKED', 'QUEUED', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED',
    'FAILED_TERMINAL', 'CANCELLED'
  )),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  idempotency_key text NOT NULL,
  estimated_units bigint NOT NULL CHECK (estimated_units > 0),
  budget_warning boolean NOT NULL DEFAULT false,
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  lease_token uuid,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  next_attempt_at timestamptz,
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, idempotency_key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE budget_reservations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  estimated_units bigint NOT NULL CHECK (estimated_units > 0),
  actual_units bigint CHECK (actual_units >= 0),
  status text NOT NULL CHECK (status IN ('RESERVED', 'SETTLED', 'RELEASED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (tenant_id, job_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE usage_ledger (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  units bigint NOT NULL CHECK (units >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, job_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE outbox_messages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  aggregate_id uuid NOT NULL,
  message_type text NOT NULL,
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object'
    AND payload ?& ARRAY['jobId', 'tenantId', 'workspaceId', 'schemaVersion']
    AND (payload - 'jobId' - 'tenantId' - 'workspaceId' - 'schemaVersion') = '{}'::jsonb
  ),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE inbox_messages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  consumer text NOT NULL,
  message_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED')),
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (consumer, message_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE budget_alerts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  threshold_percent integer NOT NULL CHECK (threshold_percent BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, policy_id, threshold_percent),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, policy_id) REFERENCES budget_policies(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE job_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE budget_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_ledger FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE inbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE budget_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_alerts FORCE ROW LEVEL SECURITY;
ALTER TABLE job_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_events FORCE ROW LEVEL SECURITY;

CREATE POLICY budget_policy_isolation ON budget_policies
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY job_isolation ON jobs
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY budget_reservation_isolation ON budget_reservations
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY usage_ledger_isolation ON usage_ledger
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY outbox_message_isolation ON outbox_messages
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY inbox_message_isolation ON inbox_messages
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY budget_alert_isolation ON budget_alerts
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY job_event_isolation ON job_events
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

CREATE OR REPLACE FUNCTION list_pending_job_outbox(p_limit integer)
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
  WHERE message.published_at IS NULL
    AND message.message_type = 'JOB_QUEUED'
  ORDER BY message.created_at, message.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$function$;

CREATE OR REPLACE FUNCTION mark_job_outbox_published(
  p_message_id uuid,
  p_tenant_id uuid,
  p_published_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  UPDATE public.outbox_messages message
    SET published_at = COALESCE(message.published_at, p_published_at)
    WHERE message.id = p_message_id AND message.tenant_id = p_tenant_id;
END
$function$;

REVOKE ALL ON FUNCTION list_pending_job_outbox(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION mark_job_outbox_published(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_pending_job_outbox(integer) TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION mark_job_outbox_published(uuid, uuid, timestamptz) TO aeostudio_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON budget_policies, jobs, budget_reservations,
  usage_ledger, outbox_messages, inbox_messages, budget_alerts, job_events
  TO aeostudio_runtime;
