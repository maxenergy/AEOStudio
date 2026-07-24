ALTER TABLE jobs
  DROP CONSTRAINT jobs_tenant_id_workspace_id_idempotency_key_key;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_idempotency_scope_unique
  UNIQUE (tenant_id, workspace_id, job_type, idempotency_key);

CREATE TABLE generation_start_intents (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('CONTENT_PLAN', 'ARTIFACT_GENERATION')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  aggregate_id uuid NOT NULL,
  job_id uuid NOT NULL,
  estimated_units bigint NOT NULL CHECK (estimated_units > 0),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, operation, idempotency_key),
  UNIQUE (tenant_id, aggregate_id),
  UNIQUE (tenant_id, job_id),
  FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE generation_start_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_start_intents FORCE ROW LEVEL SECURITY;

CREATE POLICY generation_start_intent_isolation ON generation_start_intents
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

GRANT SELECT, INSERT ON generation_start_intents TO aeostudio_runtime;
