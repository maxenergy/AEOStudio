ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check
  CHECK (job_type IN
    ('PROFILE_READINESS', 'SITE_CRAWL', 'CONTENT_PLAN', 'ARTIFACT_GENERATION', 'PUBLICATION',
      'MEASUREMENT'));

ALTER TABLE provider_surface_registry ADD COLUMN acquisition_class text;
UPDATE provider_surface_registry SET acquisition_class = CASE
  WHEN acquisition_method = 'MANUAL_IMPORT' THEN 'MANUAL_IMPORT'
  WHEN acquisition_method = 'AUTHORIZED_BROWSER_SAMPLE' THEN 'CONSUMER_UI_SAMPLE'
  ELSE 'MODEL_API_DIAGNOSTIC'
END;
ALTER TABLE provider_surface_registry ALTER COLUMN acquisition_class SET NOT NULL;
ALTER TABLE provider_surface_registry ADD CONSTRAINT provider_surface_acquisition_class_check
  CHECK (acquisition_class IN
    ('CONSUMER_UI_SAMPLE', 'MODEL_API_DIAGNOSTIC', 'SEARCH_DATA_API', 'MANUAL_IMPORT'));

INSERT INTO provider_surface_registry
  (id, provider_key, provider_name, surface_key, surface_name, surface_kind,
    acquisition_method, status, unavailable_reason, adapter_version, created_at,
    acquisition_class)
VALUES
  ('00000000-0000-7000-8000-000000001501', 'google-search-console',
    'Google Search Console', 'search-performance', 'Search Performance', 'SEARCH_DATA',
    'OFFICIAL_API', 'UNAVAILABLE',
    'OAuth connector is not configured in this environment; measurement remains NOT_CHECKED.',
    'gsc-contract-v1', '2026-07-21T00:00:00Z', 'SEARCH_DATA_API'),
  ('00000000-0000-7000-8000-000000001502', 'bing-webmaster-tools',
    'Bing Webmaster Tools', 'search-performance', 'Search Performance', 'SEARCH_DATA',
    'OFFICIAL_API', 'UNAVAILABLE',
    'OAuth connector is not configured in this environment; measurement remains NOT_CHECKED.',
    'bing-webmaster-contract-v1', '2026-07-21T00:00:00Z', 'SEARCH_DATA_API'),
  ('00000000-0000-7000-8000-000000001503', 'openai', 'OpenAI', 'chatgpt-search',
    'ChatGPT Search', 'CONSUMER_AI_ANSWER', 'MANUAL_IMPORT', 'UNAVAILABLE',
    'No approved production acquisition runtime is installed; only reviewed manual import is allowed.',
    'manual-import-v1', '2026-07-21T00:00:00Z', 'MANUAL_IMPORT'),
  ('00000000-0000-7000-8000-000000001504', 'google', 'Google', 'ai-mode',
    'Google AI Mode', 'CONSUMER_AI_ANSWER', 'MANUAL_IMPORT', 'UNAVAILABLE',
    'No approved production acquisition runtime is installed; only reviewed manual import is allowed.',
    'manual-import-v1', '2026-07-21T00:00:00Z', 'MANUAL_IMPORT'),
  ('00000000-0000-7000-8000-000000001505', 'google', 'Google', 'ai-overviews',
    'Google AI Overviews', 'CONSUMER_AI_ANSWER', 'MANUAL_IMPORT', 'UNAVAILABLE',
    'No approved production acquisition runtime is installed; only reviewed manual import is allowed.',
    'manual-import-v1', '2026-07-21T00:00:00Z', 'MANUAL_IMPORT'),
  ('00000000-0000-7000-8000-000000001506', 'perplexity', 'Perplexity', 'answer-surface',
    'Perplexity Answer Surface', 'CONSUMER_AI_ANSWER', 'MANUAL_IMPORT', 'UNAVAILABLE',
    'No approved production acquisition runtime is installed; only reviewed manual import is allowed.',
    'manual-import-v1', '2026-07-21T00:00:00Z', 'MANUAL_IMPORT');

CREATE TABLE measurement_provider_policies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  provider_key text NOT NULL CHECK (length(provider_key) BETWEEN 1 AND 120),
  surface_key text NOT NULL CHECK (length(surface_key) BETWEEN 1 AND 120),
  adapter_version text NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 120),
  terms_version text NOT NULL CHECK (length(terms_version) BETWEEN 1 AND 120),
  terms_approved boolean NOT NULL,
  authorization_approved boolean NOT NULL,
  cross_border_approved boolean NOT NULL,
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 500),
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 120),
  approved_by_user_id uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, workspace_id, provider_key, surface_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE measurement_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  prompt_set_id uuid NOT NULL,
  prompt_revision_id uuid NOT NULL,
  prompt_content_hash text NOT NULL CHECK (prompt_content_hash ~ '^[a-f0-9]{64}$'),
  scenario_id uuid NOT NULL,
  scenario_version integer NOT NULL CHECK (scenario_version > 0),
  scenario_content_hash text NOT NULL CHECK (scenario_content_hash ~ '^[a-f0-9]{64}$'),
  job_id uuid,
  kind text NOT NULL CHECK (kind = 'BASELINE'),
  status text NOT NULL CHECK (status IN
    ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'ERROR', 'CANCELLED')),
  expected_prompt_run_count integer NOT NULL CHECK (expected_prompt_run_count > 0),
  completed_prompt_run_count integer NOT NULL DEFAULT 0
    CHECK (completed_prompt_run_count BETWEEN 0 AND expected_prompt_run_count),
  provider_key text NOT NULL CHECK (length(provider_key) BETWEEN 1 AND 120),
  surface_key text NOT NULL CHECK (length(surface_key) BETWEEN 1 AND 120),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 240),
  model_version text NOT NULL CHECK (length(model_version) BETWEEN 1 AND 240),
  acquisition_class text NOT NULL CHECK (acquisition_class IN
    ('CONSUMER_UI_SAMPLE', 'MODEL_API_DIAGNOSTIC', 'SEARCH_DATA_API', 'MANUAL_IMPORT')),
  acquisition_method text NOT NULL CHECK (length(acquisition_method) BETWEEN 1 AND 120),
  adapter_version text NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 120),
  scenario_snapshot jsonb NOT NULL CHECK (jsonb_typeof(scenario_snapshot) = 'object'),
  prompt_snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(prompt_snapshot) = 'array'
    AND jsonb_array_length(prompt_snapshot) BETWEEN 20 AND 50
  ),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, workspace_id, idempotency_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, prompt_set_id) REFERENCES prompt_sets(tenant_id, id),
  FOREIGN KEY (tenant_id, prompt_revision_id) REFERENCES prompt_revisions(tenant_id, id),
  FOREIGN KEY (tenant_id, scenario_id) REFERENCES measurement_scenarios(tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id)
);

CREATE TABLE raw_evidence_refs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  measurement_run_id uuid NOT NULL,
  object_ref text NOT NULL CHECK (length(object_ref) BETWEEN 1 AND 2000),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb CHECK (
    payload IS NULL OR (
      jsonb_typeof(payload) = 'object'
      AND octet_length(payload::text) <= 10000000
    )
  ),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, measurement_run_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, measurement_run_id) REFERENCES measurement_runs(tenant_id, id)
    ON DELETE CASCADE
);

CREATE TABLE prompt_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  measurement_run_id uuid NOT NULL,
  prompt_id uuid NOT NULL,
  prompt_ordinal integer NOT NULL CHECK (prompt_ordinal > 0),
  repetition integer NOT NULL CHECK (repetition > 0),
  scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN
    ('PASS', 'FAIL', 'ERROR', 'NOT_CHECKED', 'INCONCLUSIVE', 'NOT_APPLICABLE')),
  provider_key text NOT NULL CHECK (length(provider_key) BETWEEN 1 AND 120),
  surface_key text NOT NULL CHECK (length(surface_key) BETWEEN 1 AND 120),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 240),
  model_version text NOT NULL CHECK (length(model_version) BETWEEN 1 AND 240),
  scenario_id uuid NOT NULL,
  scenario_version integer NOT NULL CHECK (scenario_version > 0),
  acquisition_class text NOT NULL CHECK (acquisition_class IN
    ('CONSUMER_UI_SAMPLE', 'MODEL_API_DIAGNOSTIC', 'SEARCH_DATA_API', 'MANUAL_IMPORT')),
  acquisition_method text NOT NULL CHECK (length(acquisition_method) BETWEEN 1 AND 120),
  adapter_key text NOT NULL CHECK (length(adapter_key) BETWEEN 1 AND 120),
  adapter_version text NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 120),
  method_version text NOT NULL CHECK (length(method_version) BETWEEN 1 AND 120),
  observation jsonb NOT NULL CHECK (jsonb_typeof(observation) = 'object'),
  cost_amount numeric(18, 6) NOT NULL CHECK (cost_amount >= 0),
  cost_currency text NOT NULL CHECK (cost_currency ~ '^[A-Z]{3}$'),
  policy_reason text CHECK (policy_reason IS NULL OR length(policy_reason) BETWEEN 1 AND 160),
  raw_evidence_ref_id uuid,
  observed_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, measurement_run_id, prompt_id, scope_key, repetition),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, measurement_run_id) REFERENCES measurement_runs(tenant_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, scenario_id) REFERENCES measurement_scenarios(tenant_id, id),
  FOREIGN KEY (tenant_id, measurement_run_id, raw_evidence_ref_id)
    REFERENCES raw_evidence_refs(tenant_id, measurement_run_id, id)
);

CREATE TABLE metric_observations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  measurement_run_id uuid NOT NULL,
  prompt_run_id uuid NOT NULL,
  metric_key text NOT NULL CHECK (metric_key IN
    ('MENTION_RATE', 'CITATION_RATE', 'ACCURACY_RATE', 'COVERAGE_RATE')),
  scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 500),
  classification text NOT NULL CHECK (classification IN
    ('PASS', 'FAIL', 'MISMATCH', 'ERROR', 'NOT_CHECKED', 'INCONCLUSIVE', 'NOT_APPLICABLE')),
  cohort jsonb NOT NULL CHECK (jsonb_typeof(cohort) = 'object'),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, prompt_run_id, metric_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, measurement_run_id) REFERENCES measurement_runs(tenant_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, prompt_run_id) REFERENCES prompt_runs(tenant_id, id)
    ON DELETE CASCADE
);

CREATE TABLE metric_snapshots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  measurement_run_id uuid NOT NULL,
  schema_version text NOT NULL CHECK (schema_version = 'metric-snapshot.v1'),
  metric_key text NOT NULL CHECK (metric_key IN
    ('MENTION_RATE', 'CITATION_RATE', 'ACCURACY_RATE', 'COVERAGE_RATE')),
  scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 500),
  method_version text NOT NULL CHECK (length(method_version) BETWEEN 1 AND 120),
  cohort jsonb NOT NULL CHECK (jsonb_typeof(cohort) = 'object'),
  numerator integer NOT NULL CHECK (numerator >= 0),
  eligible_denominator integer NOT NULL CHECK
    (eligible_denominator >= 0 AND numerator <= eligible_denominator),
  value numeric(18, 12) CHECK (value IS NULL OR value BETWEEN 0 AND 1),
  excluded_counts jsonb NOT NULL CHECK (
    jsonb_typeof(excluded_counts) = 'object'
    AND excluded_counts ?& ARRAY['ERROR', 'NOT_CHECKED', 'INCONCLUSIVE', 'NOT_APPLICABLE']
    AND (excluded_counts - 'ERROR' - 'NOT_CHECKED' - 'INCONCLUSIVE' - 'NOT_APPLICABLE') = '{}'::jsonb
    AND jsonb_typeof(excluded_counts -> 'ERROR') = 'number'
    AND (excluded_counts ->> 'ERROR')::numeric >= 0
    AND (excluded_counts ->> 'ERROR')::numeric = trunc((excluded_counts ->> 'ERROR')::numeric)
    AND jsonb_typeof(excluded_counts -> 'NOT_CHECKED') = 'number'
    AND (excluded_counts ->> 'NOT_CHECKED')::numeric >= 0
    AND (excluded_counts ->> 'NOT_CHECKED')::numeric =
      trunc((excluded_counts ->> 'NOT_CHECKED')::numeric)
    AND jsonb_typeof(excluded_counts -> 'INCONCLUSIVE') = 'number'
    AND (excluded_counts ->> 'INCONCLUSIVE')::numeric >= 0
    AND (excluded_counts ->> 'INCONCLUSIVE')::numeric =
      trunc((excluded_counts ->> 'INCONCLUSIVE')::numeric)
    AND jsonb_typeof(excluded_counts -> 'NOT_APPLICABLE') = 'number'
    AND (excluded_counts ->> 'NOT_APPLICABLE')::numeric >= 0
    AND (excluded_counts ->> 'NOT_APPLICABLE')::numeric =
      trunc((excluded_counts ->> 'NOT_APPLICABLE')::numeric)
  ),
  source_observation_ids uuid[] NOT NULL CHECK (cardinality(source_observation_ids) > 0),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, measurement_run_id, scope_key, metric_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, measurement_run_id) REFERENCES measurement_runs(tenant_id, id)
    ON DELETE CASCADE
);

ALTER TABLE measurement_provider_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurement_provider_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE measurement_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurement_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE raw_evidence_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_evidence_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE prompt_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE metric_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE metric_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY measurement_provider_policy_isolation ON measurement_provider_policies
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY measurement_run_isolation ON measurement_runs
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY raw_evidence_ref_isolation ON raw_evidence_refs
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY prompt_run_isolation ON prompt_runs
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY metric_observation_isolation ON metric_observations
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY metric_snapshot_isolation ON metric_snapshots
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

CREATE FUNCTION enforce_measurement_run_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['job_id', 'status', 'completed_prompt_run_count',
        'started_at', 'completed_at']::text[])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['job_id', 'status', 'completed_prompt_run_count',
        'started_at', 'completed_at']::text[]) THEN
    RAISE EXCEPTION 'MEASUREMENT_RUN_IMMUTABLE_FIELDS' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.job_id IS NULL AND NEW.job_id IS NOT NULL
     AND OLD.status = 'QUEUED' AND NEW.status = 'QUEUED'
     AND NEW.completed_prompt_run_count = 0
     AND NEW.started_at IS NULL AND NEW.completed_at IS NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM jobs job
      WHERE job.id = NEW.job_id
        AND job.tenant_id = NEW.tenant_id
        AND job.workspace_id = NEW.workspace_id
        AND job.job_type = 'MEASUREMENT'
        AND job.aggregate_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'MEASUREMENT_JOB_BINDING_FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.job_id = NEW.job_id AND OLD.status = 'QUEUED' AND NEW.status = 'RUNNING'
     AND NEW.completed_prompt_run_count = 0
     AND OLD.started_at IS NULL AND NEW.started_at IS NOT NULL
     AND NEW.completed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.job_id = NEW.job_id AND OLD.status = 'RUNNING' AND NEW.status = 'RUNNING'
     AND NEW.completed_prompt_run_count >= OLD.completed_prompt_run_count
     AND NEW.completed_prompt_run_count <= NEW.expected_prompt_run_count
     AND NEW.started_at = OLD.started_at AND NEW.completed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.job_id = NEW.job_id AND OLD.status = 'RUNNING' AND NEW.status = 'COMPLETED'
     AND NEW.completed_prompt_run_count = NEW.expected_prompt_run_count
     AND NEW.started_at = OLD.started_at AND NEW.completed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'MEASUREMENT_RUN_TRANSITION_FORBIDDEN' USING ERRCODE = 'P0001';
END
$function$;

CREATE TRIGGER measurement_run_update_guard
BEFORE UPDATE ON measurement_runs
FOR EACH ROW EXECUTE FUNCTION enforce_measurement_run_update();

CREATE FUNCTION reject_measurement_evidence_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'MEASUREMENT_EVIDENCE_IMMUTABLE' USING ERRCODE = 'P0001';
END
$function$;

CREATE TRIGGER raw_evidence_ref_update_guard BEFORE UPDATE ON raw_evidence_refs
FOR EACH ROW EXECUTE FUNCTION reject_measurement_evidence_update();
CREATE TRIGGER prompt_run_update_guard BEFORE UPDATE ON prompt_runs
FOR EACH ROW EXECUTE FUNCTION reject_measurement_evidence_update();
CREATE TRIGGER metric_observation_update_guard BEFORE UPDATE ON metric_observations
FOR EACH ROW EXECUTE FUNCTION reject_measurement_evidence_update();
CREATE TRIGGER metric_snapshot_update_guard BEFORE UPDATE ON metric_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_measurement_evidence_update();

GRANT SELECT, INSERT, UPDATE ON measurement_provider_policies TO aeostudio_runtime;
GRANT SELECT, INSERT, UPDATE ON measurement_runs TO aeostudio_runtime;
GRANT SELECT, INSERT ON raw_evidence_refs, prompt_runs, metric_observations, metric_snapshots
  TO aeostudio_runtime;
