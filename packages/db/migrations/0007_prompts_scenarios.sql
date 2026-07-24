CREATE TABLE provider_surface_registry (
  id uuid PRIMARY KEY,
  provider_key text NOT NULL CHECK (length(provider_key) BETWEEN 1 AND 120),
  provider_name text NOT NULL CHECK (length(provider_name) BETWEEN 1 AND 240),
  surface_key text NOT NULL CHECK (length(surface_key) BETWEEN 1 AND 120),
  surface_name text NOT NULL CHECK (length(surface_name) BETWEEN 1 AND 240),
  surface_kind text NOT NULL CHECK (surface_kind IN
    ('SEARCH_DATA', 'CONSUMER_SEARCH', 'CONSUMER_AI_ANSWER')),
  acquisition_method text NOT NULL CHECK (length(acquisition_method) BETWEEN 1 AND 120),
  status text NOT NULL CHECK (status IN ('AVAILABLE', 'UNAVAILABLE')),
  unavailable_reason text,
  adapter_version text NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL,
  UNIQUE (provider_key, surface_key)
);

INSERT INTO provider_surface_registry
  (id, provider_key, provider_name, surface_key, surface_name, surface_kind,
    acquisition_method, status, unavailable_reason, adapter_version, created_at)
VALUES
  ('00000000-0000-7000-8000-000000000701', 'fixture-provider', 'Fixture Provider',
    'consumer-answer-sandbox', 'Consumer Answer Sandbox', 'CONSUMER_AI_ANSWER',
    'MANUAL_IMPORT', 'AVAILABLE', NULL, 'fixture-v1', '2026-07-20T00:00:00Z'),
  ('00000000-0000-7000-8000-000000000702', 'offline-fixture-provider',
    'Offline Fixture Provider', 'regional-answer-fixture', 'Regional Answer Fixture',
    'CONSUMER_AI_ANSWER', 'AUTHORIZED_BROWSER_SAMPLE', 'UNAVAILABLE',
    'Provider fixture intentionally unavailable; retain configuration for NOT_CHECKED.',
    'fixture-v1', '2026-07-20T00:00:00Z');

CREATE TABLE prompt_sets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  current_revision integer NOT NULL CHECK (current_revision > 0),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE prompt_revisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  prompt_set_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 500),
  source_context jsonb NOT NULL,
  prompts jsonb NOT NULL,
  scopes jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('DRAFT', 'APPROVED', 'STALE')),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, prompt_set_id, revision),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, prompt_set_id) REFERENCES prompt_sets(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE measurement_scenarios (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  prompt_revision_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  provider_key text NOT NULL,
  surface_key text NOT NULL,
  model text NOT NULL,
  model_version text NOT NULL,
  account_ref text NOT NULL,
  acquisition_method text NOT NULL,
  fresh_session boolean NOT NULL,
  search_enabled boolean NOT NULL,
  parameters jsonb NOT NULL,
  repetitions integer NOT NULL CHECK (repetitions BETWEEN 1 AND 100),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  registry_status text NOT NULL CHECK (registry_status IN ('AVAILABLE', 'UNAVAILABLE', 'UNKNOWN')),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, prompt_revision_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, prompt_revision_id)
    REFERENCES prompt_revisions(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE prompt_approvals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  prompt_revision_id uuid NOT NULL,
  scenario_id uuid NOT NULL,
  prompt_content_hash text NOT NULL CHECK (prompt_content_hash ~ '^[a-f0-9]{64}$'),
  scenario_content_hash text NOT NULL CHECK (scenario_content_hash ~ '^[a-f0-9]{64}$'),
  approved_by_user_id uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, prompt_revision_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, prompt_revision_id)
    REFERENCES prompt_revisions(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, scenario_id)
    REFERENCES measurement_scenarios(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE prompt_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE prompt_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE measurement_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurement_scenarios FORCE ROW LEVEL SECURITY;
ALTER TABLE prompt_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_approvals FORCE ROW LEVEL SECURITY;

CREATE POLICY prompt_set_isolation ON prompt_sets
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY prompt_revision_isolation ON prompt_revisions
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY measurement_scenario_isolation ON measurement_scenarios
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY prompt_approval_isolation ON prompt_approvals
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

GRANT SELECT ON provider_surface_registry TO aeostudio_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON prompt_sets, prompt_revisions,
  measurement_scenarios, prompt_approvals TO aeostudio_runtime;
