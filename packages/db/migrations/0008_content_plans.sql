ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check
  CHECK (job_type IN ('PROFILE_READINESS', 'SITE_CRAWL', 'CONTENT_PLAN'));

CREATE TABLE content_plans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  job_id uuid,
  status text NOT NULL CHECK (status IN ('PENDING', 'READY', 'INVALID')),
  method_policy_version text NOT NULL,
  input_snapshot jsonb NOT NULL,
  content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, job_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE opportunities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  content_plan_id uuid NOT NULL,
  opportunity_key text NOT NULL CHECK (opportunity_key IN
    ('DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE')),
  asset_kind text NOT NULL CHECK (asset_kind IN
    ('DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE')),
  business_value double precision NOT NULL CHECK (business_value BETWEEN 0 AND 100),
  evidence_readiness double precision NOT NULL CHECK (evidence_readiness BETWEEN 0 AND 100),
  visibility_gap jsonb NOT NULL,
  effort double precision NOT NULL CHECK (effort BETWEEN 0 AND 100),
  risk double precision NOT NULL CHECK (risk BETWEEN 0 AND 100),
  priority_score double precision NOT NULL,
  priority_rank integer NOT NULL CHECK (priority_rank > 0),
  rank_reason text NOT NULL,
  action text NOT NULL CHECK (action IN ('BRIEF', 'EVIDENCE_TASK')),
  evidence_ready boolean NOT NULL,
  publish_ready boolean NOT NULL DEFAULT false CHECK (publish_ready = false),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, content_plan_id, opportunity_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, content_plan_id) REFERENCES content_plans(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE briefs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  content_plan_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  brief_key text NOT NULL CHECK (brief_key IN
    ('DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE')),
  asset_kind text NOT NULL CHECK (asset_kind IN
    ('DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE')),
  title text NOT NULL,
  prompt_ids jsonb NOT NULL,
  claim_revision_ids jsonb NOT NULL,
  source_artifact_ids jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('REVIEW_REQUIRED', 'APPROVED', 'REJECTED')),
  evidence_ready boolean NOT NULL CHECK (evidence_ready = true),
  publish_ready boolean NOT NULL DEFAULT false CHECK (publish_ready = false),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, content_plan_id, brief_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, content_plan_id) REFERENCES content_plans(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE brief_reviews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  brief_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVE', 'REJECT')),
  reviewer_user_id uuid NOT NULL REFERENCES users(id),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  reviewed_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, brief_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, brief_id) REFERENCES briefs(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE evidence_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  content_plan_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  task_key text NOT NULL CHECK (task_key IN
    ('DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE')),
  asset_kind text NOT NULL CHECK (asset_kind IN
    ('DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE')),
  reason_code text NOT NULL CHECK (reason_code IN
    ('PRIMARY_CLAIM_EVIDENCE_REQUIRED', 'INDEPENDENT_COMPARISON_EVIDENCE_REQUIRED')),
  detail text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, content_plan_id, task_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, content_plan_id) REFERENCES content_plans(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE content_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities FORCE ROW LEVEL SECURITY;
ALTER TABLE briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE briefs FORCE ROW LEVEL SECURITY;
ALTER TABLE brief_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE brief_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY content_plan_isolation ON content_plans
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY opportunity_isolation ON opportunities
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY brief_isolation ON briefs
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY brief_review_isolation ON brief_reviews
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY evidence_task_isolation ON evidence_tasks
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON content_plans, opportunities, briefs, brief_reviews,
  evidence_tasks TO aeostudio_runtime;
