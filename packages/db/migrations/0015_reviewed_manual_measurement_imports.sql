ALTER TABLE jobs
  ADD CONSTRAINT jobs_workspace_identity_unique
    UNIQUE (tenant_id, workspace_id, id);
ALTER TABLE prompt_sets
  ADD CONSTRAINT prompt_sets_workspace_identity_unique
    UNIQUE (tenant_id, workspace_id, id);
ALTER TABLE prompt_revisions
  ADD CONSTRAINT prompt_revisions_workspace_identity_unique
    UNIQUE (tenant_id, workspace_id, id);
ALTER TABLE measurement_scenarios
  ADD CONSTRAINT measurement_scenarios_workspace_identity_unique
    UNIQUE (tenant_id, workspace_id, id);

ALTER TABLE prompt_revisions
  ADD CONSTRAINT prompt_revisions_prompt_set_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id, prompt_set_id)
    REFERENCES prompt_sets(tenant_id, workspace_id, id);
ALTER TABLE measurement_scenarios
  ADD CONSTRAINT measurement_scenarios_prompt_revision_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id, prompt_revision_id)
    REFERENCES prompt_revisions(tenant_id, workspace_id, id);
ALTER TABLE prompt_approvals
  ADD CONSTRAINT prompt_approvals_prompt_revision_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id, prompt_revision_id)
    REFERENCES prompt_revisions(tenant_id, workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT prompt_approvals_scenario_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id, scenario_id)
    REFERENCES measurement_scenarios(tenant_id, workspace_id, id) ON DELETE CASCADE;

ALTER TABLE measurement_runs
  ADD CONSTRAINT measurement_runs_workspace_identity_unique
    UNIQUE (tenant_id, workspace_id, id),
  ADD CONSTRAINT measurement_runs_prompt_set_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id, prompt_set_id)
    REFERENCES prompt_sets(tenant_id, workspace_id, id),
  ADD CONSTRAINT measurement_runs_prompt_revision_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id, prompt_revision_id)
    REFERENCES prompt_revisions(tenant_id, workspace_id, id),
  ADD CONSTRAINT measurement_runs_scenario_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id, scenario_id)
    REFERENCES measurement_scenarios(tenant_id, workspace_id, id),
  ADD CONSTRAINT measurement_runs_job_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id, job_id)
    REFERENCES jobs(tenant_id, workspace_id, id);

ALTER TABLE raw_evidence_refs
  ADD CONSTRAINT raw_evidence_refs_workspace_identity_unique
    UNIQUE (tenant_id, workspace_id, id),
  ADD CONSTRAINT raw_evidence_refs_workspace_run_identity_unique
    UNIQUE (tenant_id, workspace_id, measurement_run_id, id),
  ADD CONSTRAINT raw_evidence_refs_run_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id, measurement_run_id)
    REFERENCES measurement_runs(tenant_id, workspace_id, id) ON DELETE CASCADE;

ALTER TABLE prompt_runs
  ADD CONSTRAINT prompt_runs_workspace_identity_unique
    UNIQUE (tenant_id, workspace_id, id),
  ADD CONSTRAINT prompt_runs_workspace_run_identity_unique
    UNIQUE (tenant_id, workspace_id, measurement_run_id, id),
  ADD CONSTRAINT prompt_runs_run_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id, measurement_run_id)
    REFERENCES measurement_runs(tenant_id, workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT prompt_runs_scenario_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id, scenario_id)
    REFERENCES measurement_scenarios(tenant_id, workspace_id, id),
  ADD CONSTRAINT prompt_runs_raw_evidence_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id, measurement_run_id, raw_evidence_ref_id)
    REFERENCES raw_evidence_refs(tenant_id, workspace_id, measurement_run_id, id);

ALTER TABLE metric_observations
  ADD CONSTRAINT metric_observations_workspace_identity_unique
    UNIQUE (tenant_id, workspace_id, id),
  ADD CONSTRAINT metric_observations_run_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id, measurement_run_id)
    REFERENCES measurement_runs(tenant_id, workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT metric_observations_prompt_run_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id, measurement_run_id, prompt_run_id)
    REFERENCES prompt_runs(tenant_id, workspace_id, measurement_run_id, id) ON DELETE CASCADE;

ALTER TABLE metric_snapshots
  ADD CONSTRAINT metric_snapshots_workspace_identity_unique
    UNIQUE (tenant_id, workspace_id, id),
  ADD CONSTRAINT metric_snapshots_run_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id, measurement_run_id)
    REFERENCES measurement_runs(tenant_id, workspace_id, id) ON DELETE CASCADE;

CREATE TABLE measurement_manual_imports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  schema_version text NOT NULL CHECK (schema_version = 'measurement-manual-import.v1'),
  prompt_set_id uuid NOT NULL,
  prompt_revision_id uuid NOT NULL,
  prompt_content_hash text NOT NULL CHECK (prompt_content_hash ~ '^[a-f0-9]{64}$'),
  scenario_id uuid NOT NULL,
  scenario_content_hash text NOT NULL CHECK (scenario_content_hash ~ '^[a-f0-9]{64}$'),
  provider_key text NOT NULL CHECK (length(provider_key) BETWEEN 1 AND 120),
  surface_key text NOT NULL CHECK (length(surface_key) BETWEEN 1 AND 120),
  adapter_version text NOT NULL CHECK (adapter_version = 'manual-import-v1'),
  acquisition_class text NOT NULL CHECK (acquisition_class = 'MANUAL_IMPORT'),
  acquisition_method text NOT NULL CHECK (acquisition_method = 'MANUAL_IMPORT'),
  status text NOT NULL CHECK (status IN ('SUBMITTED', 'APPROVED', 'REJECTED')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  expected_slot_count integer NOT NULL CHECK (expected_slot_count > 0),
  provided_slot_count integer NOT NULL
    CHECK (provided_slot_count BETWEEN 1 AND expected_slot_count),
  cost_currency text NOT NULL CHECK (cost_currency ~ '^[A-Z]{3}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  submitted_by_user_id uuid NOT NULL REFERENCES users(id),
  submitted_at timestamptz NOT NULL,
  reviewed_by_user_id uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text CHECK (review_note IS NULL OR length(review_note) BETWEEN 1 AND 1000),
  CHECK (
    (status = 'SUBMITTED' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
    OR
    (status IN ('APPROVED', 'REJECTED') AND reviewed_by_user_id IS NOT NULL
      AND reviewed_at IS NOT NULL AND reviewed_by_user_id <> submitted_by_user_id)
  ),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, idempotency_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, workspace_id, prompt_set_id)
    REFERENCES prompt_sets(tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, prompt_revision_id)
    REFERENCES prompt_revisions(tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, scenario_id)
    REFERENCES measurement_scenarios(tenant_id, workspace_id, id)
);

CREATE TABLE measurement_manual_import_slots (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  manual_import_id uuid NOT NULL,
  prompt_id uuid NOT NULL,
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object' AND octet_length(scope::text) <= 2048),
  scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 500),
  repetition integer NOT NULL CHECK (repetition > 0),
  provided boolean NOT NULL,
  observed_at timestamptz,
  result jsonb CHECK (
    result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 10000000)
  ),
  raw_evidence_content_hash text CHECK (
    raw_evidence_content_hash IS NULL OR raw_evidence_content_hash ~ '^[a-f0-9]{64}$'
  ),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CHECK (
    (provided AND observed_at IS NOT NULL AND result IS NOT NULL
      AND raw_evidence_content_hash IS NOT NULL)
    OR
    (NOT provided AND observed_at IS NULL AND result IS NULL
      AND raw_evidence_content_hash IS NULL)
  ),
  PRIMARY KEY (tenant_id, manual_import_id, prompt_id, scope_key, repetition),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, workspace_id, manual_import_id)
    REFERENCES measurement_manual_imports(tenant_id, workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE measurement_runs
  ADD COLUMN manual_import_id uuid,
  ADD COLUMN manual_import_content_hash text CHECK (
    manual_import_content_hash IS NULL OR manual_import_content_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT measurement_run_manual_import_pair_check CHECK (
    (manual_import_id IS NULL AND manual_import_content_hash IS NULL)
    OR (manual_import_id IS NOT NULL AND manual_import_content_hash IS NOT NULL)
  ),
  ADD CONSTRAINT measurement_run_manual_import_fk
    FOREIGN KEY (tenant_id, workspace_id, manual_import_id)
    REFERENCES measurement_manual_imports(tenant_id, workspace_id, id);

ALTER TABLE measurement_manual_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurement_manual_imports FORCE ROW LEVEL SECURITY;
ALTER TABLE measurement_manual_import_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurement_manual_import_slots FORCE ROW LEVEL SECURITY;

CREATE POLICY measurement_manual_import_isolation ON measurement_manual_imports
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY measurement_manual_import_slot_isolation ON measurement_manual_import_slots
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

CREATE FUNCTION enforce_measurement_manual_import_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'reviewed_by_user_id', 'reviewed_at', 'review_note']::text[])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'reviewed_by_user_id', 'reviewed_at', 'review_note']::text[])
  THEN
    RAISE EXCEPTION 'MEASUREMENT_MANUAL_IMPORT_IMMUTABLE_FIELDS' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'SUBMITTED' OR NEW.status NOT IN ('APPROVED', 'REJECTED')
     OR NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_at IS NULL
     OR NEW.reviewed_by_user_id = OLD.submitted_by_user_id THEN
    RAISE EXCEPTION 'MEASUREMENT_MANUAL_IMPORT_REVIEW_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER measurement_manual_import_update_guard
BEFORE UPDATE ON measurement_manual_imports
FOR EACH ROW EXECUTE FUNCTION enforce_measurement_manual_import_update();

CREATE TRIGGER measurement_manual_import_slot_update_guard
BEFORE UPDATE ON measurement_manual_import_slots
FOR EACH ROW EXECUTE FUNCTION reject_measurement_evidence_update();

GRANT SELECT, INSERT, UPDATE ON measurement_manual_imports TO aeostudio_runtime;
GRANT SELECT, INSERT ON measurement_manual_import_slots TO aeostudio_runtime;
