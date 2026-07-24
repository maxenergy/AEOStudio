-- Task 16: immutable, tenant/workspace-scoped descriptive Experiment comparisons.

ALTER TABLE measurement_runs DROP CONSTRAINT measurement_runs_kind_check;
ALTER TABLE measurement_runs
  ADD CONSTRAINT measurement_runs_kind_check
  CHECK (kind IN ('BASELINE', 'REMEASUREMENT'));

ALTER TABLE publication_records
  ADD CONSTRAINT publication_records_experiment_identity_unique
  UNIQUE (
    tenant_id,
    workspace_id,
    id,
    channel_package_id,
    package_checksum,
    artifact_revision_id,
    artifact_content_hash
  );

-- Keep database-side compatibility identity derivation byte-for-byte aligned with
-- the domain's canonical JSON implementation (JavaScript UTF-16 key ordering).
CREATE FUNCTION aeostudio_utf16_code_units(value text)
RETURNS integer[]
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $function$
DECLARE
  result integer[] := ARRAY[]::integer[];
  character_value text;
  code_point integer;
BEGIN
  FOR character_value IN
    SELECT substr(value, position, 1)
    FROM generate_series(1, char_length(value)) AS positions(position)
  LOOP
    code_point := ascii(character_value);
    IF code_point <= 65535 THEN
      result := array_append(result, code_point);
    ELSE
      code_point := code_point - 65536;
      result := array_append(result, 55296 + (code_point / 1024));
      result := array_append(result, 56320 + (code_point % 1024));
    END IF;
  END LOOP;
  RETURN result;
END
$function$;

CREATE FUNCTION aeostudio_canonical_number(value jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $function$
  -- Cohorts enter jsonb through JSON.stringify. Preserve that exact decimal value after
  -- exponent expansion, while removing jsonb's insignificant fractional scale (1.0 -> 1).
  SELECT CASE
    WHEN value::text::numeric = 0 THEN '0'
    ELSE trim_scale(value::text::numeric)::text
  END
$function$;

CREATE FUNCTION aeostudio_canonical_json(value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $function$
DECLARE
  value_kind text := jsonb_typeof(value);
  result text;
  entry record;
  first_entry boolean := true;
BEGIN
  IF value_kind = 'number' THEN
    RETURN aeostudio_canonical_number(value);
  END IF;

  IF value_kind IN ('null', 'string', 'boolean') THEN
    RETURN value::text;
  END IF;

  IF value_kind = 'array' THEN
    result := '[';
    FOR entry IN
      SELECT item
      FROM jsonb_array_elements(value) WITH ORDINALITY AS items(item, ordinal)
      ORDER BY ordinal
    LOOP
      IF NOT first_entry THEN result := result || ','; END IF;
      result := result || aeostudio_canonical_json(entry.item);
      first_entry := false;
    END LOOP;
    RETURN result || ']';
  END IF;

  IF value_kind = 'object' THEN
    result := '{';
    FOR entry IN
      SELECT key, item
      FROM jsonb_each(value) AS items(key, item)
      ORDER BY aeostudio_utf16_code_units(key)
    LOOP
      IF NOT first_entry THEN result := result || ','; END IF;
      result := result || to_jsonb(entry.key)::text || ':'
        || aeostudio_canonical_json(entry.item);
      first_entry := false;
    END LOOP;
    RETURN result || '}';
  END IF;

  RAISE EXCEPTION 'EXPERIMENT_CANONICAL_JSON_INVALID' USING ERRCODE = 'P0001';
END
$function$;

CREATE FUNCTION aeostudio_experiment_compatibility_key(
  metric_key text,
  method_version text,
  cohort jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $function$
  SELECT aeostudio_canonical_json(jsonb_build_object(
    'metricKey', metric_key,
    'methodVersion', method_version,
    'scenarioId', cohort ->> 'scenarioId',
    'scenarioVersion', cohort -> 'scenarioVersion',
    'providerKey', cohort ->> 'providerKey',
    'surfaceKey', cohort ->> 'surfaceKey',
    'acquisitionClass', cohort ->> 'acquisitionClass',
    'acquisitionMethod', cohort ->> 'acquisitionMethod',
    'adapterKey', cohort ->> 'adapterKey',
    'adapterVersion', cohort ->> 'adapterVersion',
    'model', cohort ->> 'model',
    'modelVersion', cohort ->> 'modelVersion',
    'scope', cohort -> 'scope',
    'parameters', cohort -> 'parameters'
  ))
$function$;

CREATE TABLE experiments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  schema_version text NOT NULL CHECK (schema_version = 'experiment.v1'),
  status text NOT NULL CHECK (status IN ('BUILDING', 'SEALED')),
  baseline_run_id uuid NOT NULL,
  remeasurement_run_id uuid NOT NULL,
  scenario_version integer NOT NULL CHECK (scenario_version > 0),
  intervention_kind text NOT NULL CHECK (
    intervention_kind IN ('PUBLISHED_PUBLICATION', 'APPROVED_ARTIFACT')
  ),
  publication_record_id uuid,
  publication_attempt_id uuid,
  channel_package_id uuid,
  package_checksum text CHECK (package_checksum IS NULL OR package_checksum ~ '^[a-f0-9]{64}$'),
  artifact_id uuid NOT NULL,
  artifact_review_id uuid NOT NULL,
  artifact_revision_id uuid NOT NULL,
  artifact_revision integer NOT NULL CHECK (artifact_revision > 0),
  artifact_content_hash text NOT NULL CHECK (artifact_content_hash ~ '^[a-f0-9]{64}$'),
  intervention_observed_at timestamptz NOT NULL,
  compatibility_hash text CHECK (
    compatibility_hash IS NULL OR compatibility_hash ~ '^[a-f0-9]{64}$'
  ),
  report jsonb CHECK (report IS NULL OR jsonb_typeof(report) = 'object'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  sealed_at timestamptz,
  CHECK (baseline_run_id <> remeasurement_run_id),
  CHECK (
    (intervention_kind = 'PUBLISHED_PUBLICATION'
      AND publication_record_id IS NOT NULL
      AND publication_attempt_id IS NOT NULL
      AND channel_package_id IS NOT NULL
      AND package_checksum IS NOT NULL)
    OR
    (intervention_kind = 'APPROVED_ARTIFACT'
      AND publication_record_id IS NULL
      AND publication_attempt_id IS NULL
      AND channel_package_id IS NULL
      AND package_checksum IS NULL)
  ),
  CHECK (
    (status = 'BUILDING' AND compatibility_hash IS NULL AND report IS NULL AND sealed_at IS NULL)
    OR
    (status = 'SEALED' AND compatibility_hash IS NOT NULL AND report IS NOT NULL
      AND sealed_at IS NOT NULL)
  ),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, idempotency_key),
  FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, workspace_id, baseline_run_id)
    REFERENCES measurement_runs(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, remeasurement_run_id)
    REFERENCES measurement_runs(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, artifact_review_id)
    REFERENCES artifact_reviews(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, publication_attempt_id)
    REFERENCES publication_attempts(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id,
    workspace_id,
    artifact_id,
    artifact_revision_id,
    artifact_revision,
    artifact_content_hash
  ) REFERENCES artifact_revisions(
    tenant_id,
    workspace_id,
    artifact_id,
    id,
    revision,
    content_hash
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id,
    workspace_id,
    publication_record_id,
    channel_package_id,
    package_checksum,
    artifact_revision_id,
    artifact_content_hash
  ) REFERENCES publication_records(
    tenant_id,
    workspace_id,
    id,
    channel_package_id,
    package_checksum,
    artifact_revision_id,
    artifact_content_hash
  ) ON DELETE RESTRICT
);

CREATE TABLE experiment_snapshot_links (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  experiment_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  metric_key text NOT NULL CHECK (metric_key IN
    ('MENTION_RATE', 'CITATION_RATE', 'ACCURACY_RATE', 'COVERAGE_RATE')),
  scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 500),
  baseline_snapshot_id uuid NOT NULL,
  baseline_content_hash text NOT NULL CHECK (baseline_content_hash ~ '^[a-f0-9]{64}$'),
  remeasurement_snapshot_id uuid NOT NULL,
  remeasurement_content_hash text NOT NULL CHECK (
    remeasurement_content_hash ~ '^[a-f0-9]{64}$'
  ),
  compatibility_key text NOT NULL,
  compatibility_hash text NOT NULL CHECK (compatibility_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, workspace_id, experiment_id, ordinal),
  UNIQUE (tenant_id, workspace_id, experiment_id, metric_key, scope_key),
  FOREIGN KEY (tenant_id, workspace_id, experiment_id)
    REFERENCES experiments(tenant_id, workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, workspace_id, baseline_snapshot_id)
    REFERENCES metric_snapshots(tenant_id, workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, remeasurement_snapshot_id)
    REFERENCES metric_snapshots(tenant_id, workspace_id, id) ON DELETE RESTRICT
);

ALTER TABLE experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiments FORCE ROW LEVEL SECURITY;
ALTER TABLE experiment_snapshot_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_snapshot_links FORCE ROW LEVEL SECURITY;

CREATE POLICY experiment_isolation ON experiments
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY experiment_snapshot_link_isolation ON experiment_snapshot_links
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

CREATE FUNCTION enforce_experiment_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  baseline_row measurement_runs%ROWTYPE;
  remeasurement_row measurement_runs%ROWTYPE;
  review_row artifact_reviews%ROWTYPE;
  selected_attempt_id uuid;
  intervention_time timestamptz;
  baseline_min_observed_at timestamptz;
  baseline_max_observed_at timestamptz;
  remeasurement_min_observed_at timestamptz;
  remeasurement_max_observed_at timestamptz;
BEGIN
  IF NEW.status <> 'BUILDING' OR NEW.compatibility_hash IS NOT NULL
     OR NEW.report IS NOT NULL OR NEW.sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'EXPERIMENT_MUST_START_BUILDING' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO baseline_row FROM measurement_runs
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND id = NEW.baseline_run_id;
  SELECT * INTO remeasurement_row FROM measurement_runs
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND id = NEW.remeasurement_run_id;

  IF baseline_row.id IS NULL OR baseline_row.status <> 'COMPLETED'
     OR baseline_row.kind <> 'BASELINE' OR baseline_row.started_at IS NULL
     OR baseline_row.completed_at IS NULL THEN
    RAISE EXCEPTION 'EXPERIMENT_BASELINE_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF remeasurement_row.id IS NULL OR remeasurement_row.status <> 'COMPLETED'
     OR remeasurement_row.kind <> 'REMEASUREMENT'
     OR remeasurement_row.started_at IS NULL OR remeasurement_row.completed_at IS NULL THEN
    RAISE EXCEPTION 'EXPERIMENT_REMEASUREMENT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.scenario_version <> baseline_row.scenario_version THEN
    RAISE EXCEPTION 'EXPERIMENT_SCENARIO_VERSION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF ROW(
       baseline_row.scenario_id, baseline_row.scenario_version,
       baseline_row.provider_key, baseline_row.surface_key,
       baseline_row.model, baseline_row.model_version,
       baseline_row.acquisition_class, baseline_row.acquisition_method,
       baseline_row.adapter_version
     ) IS DISTINCT FROM ROW(
       remeasurement_row.scenario_id, remeasurement_row.scenario_version,
       remeasurement_row.provider_key, remeasurement_row.surface_key,
       remeasurement_row.model, remeasurement_row.model_version,
       remeasurement_row.acquisition_class, remeasurement_row.acquisition_method,
       remeasurement_row.adapter_version
     ) THEN
    RAISE EXCEPTION 'EXPERIMENT_RUN_CONTEXT_INCOMPATIBLE' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO review_row FROM artifact_reviews review
  WHERE review.tenant_id = NEW.tenant_id
    AND review.workspace_id = NEW.workspace_id
    AND review.id = NEW.artifact_review_id
    AND review.artifact_revision_id = NEW.artifact_revision_id
    AND review.artifact_id = NEW.artifact_id
    AND review.revision = NEW.artifact_revision
    AND review.content_hash = NEW.artifact_content_hash
    AND review.decision = 'APPROVE';
  IF review_row.id IS NULL OR NOT EXISTS (
    SELECT 1 FROM artifact_revisions revision
    WHERE revision.tenant_id = NEW.tenant_id
      AND revision.workspace_id = NEW.workspace_id
      AND revision.id = NEW.artifact_revision_id
      AND revision.artifact_id = NEW.artifact_id
      AND revision.revision = NEW.artifact_revision
      AND revision.content_hash = NEW.artifact_content_hash
      AND revision.status = 'APPROVED'
  ) THEN
    RAISE EXCEPTION 'EXPERIMENT_EXACT_APPROVED_ARTIFACT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.intervention_kind = 'PUBLISHED_PUBLICATION' THEN
    SELECT attempt.id, attempt.finished_at INTO selected_attempt_id, intervention_time
    FROM publication_records publication
    JOIN LATERAL (
      SELECT applied.id, applied.finished_at
      FROM publication_attempts applied
      WHERE applied.tenant_id = publication.tenant_id
        AND applied.workspace_id = publication.workspace_id
        AND applied.publication_id = publication.id
        AND applied.operation IN ('PUBLISH', 'RECONCILE')
        AND applied.outcome = 'APPLIED'
        AND applied.finished_at IS NOT NULL
        AND applied.remote_ref = publication.remote_ref
      ORDER BY applied.finished_at, applied.attempt_number, applied.id
      LIMIT 1
    ) attempt ON true
    WHERE publication.tenant_id = NEW.tenant_id
      AND publication.workspace_id = NEW.workspace_id
      AND publication.id = NEW.publication_record_id
      AND publication.channel_package_id = NEW.channel_package_id
      AND publication.package_checksum = NEW.package_checksum
      AND publication.artifact_revision_id = NEW.artifact_revision_id
      AND publication.artifact_content_hash = NEW.artifact_content_hash
      AND publication.status = 'PUBLISHED';
    IF selected_attempt_id IS NULL OR selected_attempt_id <> NEW.publication_attempt_id THEN
      RAISE EXCEPTION 'EXPERIMENT_EXACT_PUBLICATION_ATTEMPT_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    intervention_time := review_row.created_at;
  END IF;

  IF intervention_time IS NULL OR intervention_time IS DISTINCT FROM NEW.intervention_observed_at
  THEN
    RAISE EXCEPTION 'EXPERIMENT_INTERVENTION_WINDOW_INVALID' USING ERRCODE = 'P0001';
  END IF;

  SELECT min(observed_at), max(observed_at)
    INTO baseline_min_observed_at, baseline_max_observed_at
  FROM prompt_runs
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND measurement_run_id = NEW.baseline_run_id;
  SELECT min(observed_at), max(observed_at)
    INTO remeasurement_min_observed_at, remeasurement_max_observed_at
  FROM prompt_runs
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND measurement_run_id = NEW.remeasurement_run_id;
  IF baseline_min_observed_at IS NULL OR baseline_max_observed_at IS NULL
     OR remeasurement_min_observed_at IS NULL OR remeasurement_max_observed_at IS NULL
     OR baseline_max_observed_at > intervention_time
     OR intervention_time > remeasurement_min_observed_at
     OR baseline_row.completed_at > intervention_time
     OR intervention_time > remeasurement_row.started_at
     OR baseline_max_observed_at > NEW.created_at
     OR remeasurement_max_observed_at > NEW.created_at
     OR baseline_max_observed_at > transaction_timestamp()
     OR remeasurement_max_observed_at > transaction_timestamp()
     OR NEW.created_at > transaction_timestamp() THEN
    RAISE EXCEPTION 'EXPERIMENT_EVIDENCE_WINDOW_INVALID' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER experiment_insert_guard
BEFORE INSERT ON experiments
FOR EACH ROW EXECUTE FUNCTION enforce_experiment_insert();

CREATE FUNCTION enforce_experiment_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  link_count integer;
  baseline_snapshot_count integer;
  remeasurement_snapshot_count integer;
  baseline_row measurement_runs%ROWTYPE;
  remeasurement_row measurement_runs%ROWTYPE;
  baseline_min_observed_at timestamptz;
  baseline_max_observed_at timestamptz;
  remeasurement_min_observed_at timestamptz;
  remeasurement_max_observed_at timestamptz;
  baseline_sample integer;
  remeasurement_sample integer;
  baseline_excluded jsonb;
  remeasurement_excluded jsonb;
  baseline_cost jsonb;
  remeasurement_cost jsonb;
  expected_compatibility_hash text;
  expected_caveat text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EXPERIMENT_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'BUILDING' OR NEW.status <> 'SEALED'
     OR (to_jsonb(NEW) - ARRAY['status', 'compatibility_hash', 'report', 'sealed_at']::text[])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['status', 'compatibility_hash', 'report', 'sealed_at']::text[])
     OR NEW.compatibility_hash IS NULL OR NEW.report IS NULL OR NEW.sealed_at IS NULL THEN
    RAISE EXCEPTION 'EXPERIMENT_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*)::integer INTO link_count FROM experiment_snapshot_links
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND experiment_id = NEW.id;
  SELECT count(*)::integer INTO baseline_snapshot_count FROM metric_snapshots
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND measurement_run_id = NEW.baseline_run_id;
  SELECT count(*)::integer INTO remeasurement_snapshot_count FROM metric_snapshots
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND measurement_run_id = NEW.remeasurement_run_id;
  IF link_count < 1
     OR link_count <> baseline_snapshot_count
     OR link_count <> remeasurement_snapshot_count
     OR (
       CASE
         WHEN jsonb_typeof(NEW.report -> 'comparisons') IS DISTINCT FROM 'array' THEN true
         ELSE jsonb_array_length(NEW.report -> 'comparisons') IS DISTINCT FROM link_count
       END
     ) THEN
    RAISE EXCEPTION 'EXPERIMENT_SNAPSHOT_LINKS_INVALID' USING ERRCODE = 'P0001';
  END IF;

  SELECT encode(
    sha256(convert_to(string_agg(compatibility_hash, '' ORDER BY ordinal), 'UTF8')),
    'hex'
  ) INTO expected_compatibility_hash
  FROM experiment_snapshot_links
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND experiment_id = NEW.id;
  IF NEW.compatibility_hash IS DISTINCT FROM expected_compatibility_hash THEN
    RAISE EXCEPTION 'EXPERIMENT_COMPATIBILITY_HASH_INVALID' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO baseline_row FROM measurement_runs
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND id = NEW.baseline_run_id;
  SELECT * INTO remeasurement_row FROM measurement_runs
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND id = NEW.remeasurement_run_id;
  SELECT min(observed_at), max(observed_at)
    INTO baseline_min_observed_at, baseline_max_observed_at
  FROM prompt_runs
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND measurement_run_id = NEW.baseline_run_id;
  SELECT min(observed_at), max(observed_at)
    INTO remeasurement_min_observed_at, remeasurement_max_observed_at
  FROM prompt_runs
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND measurement_run_id = NEW.remeasurement_run_id;

  IF NEW.report ->> 'id' IS DISTINCT FROM NEW.id::text
     OR NEW.report ->> 'tenantId' IS DISTINCT FROM NEW.tenant_id::text
     OR NEW.report ->> 'workspaceId' IS DISTINCT FROM NEW.workspace_id::text
     OR NEW.report ->> 'schemaVersion' IS DISTINCT FROM NEW.schema_version
     OR NEW.report ->> 'baselineRunId' IS DISTINCT FROM NEW.baseline_run_id::text
     OR NEW.report ->> 'remeasurementRunId' IS DISTINCT FROM NEW.remeasurement_run_id::text
     OR (NEW.report ->> 'scenarioVersion')::integer IS DISTINCT FROM NEW.scenario_version
     OR NEW.report ->> 'createdByUserId' IS DISTINCT FROM NEW.created_by_user_id::text
     OR (NEW.report ->> 'createdAt')::timestamptz IS DISTINCT FROM NEW.created_at
     OR NEW.report #>> '{measurementContext,scenarioId}'
        IS DISTINCT FROM baseline_row.scenario_id::text
     OR (NEW.report #>> '{measurementContext,scenarioVersion}')::integer
        IS DISTINCT FROM baseline_row.scenario_version
     OR NEW.report #>> '{measurementContext,providerKey}'
        IS DISTINCT FROM baseline_row.provider_key
     OR NEW.report #>> '{measurementContext,surfaceKey}'
        IS DISTINCT FROM baseline_row.surface_key
     OR NEW.report #>> '{measurementContext,model}' IS DISTINCT FROM baseline_row.model
     OR NEW.report #>> '{measurementContext,modelVersion}'
        IS DISTINCT FROM baseline_row.model_version
     OR NEW.report #>> '{measurementContext,timeline,baseline,runId}'
        IS DISTINCT FROM baseline_row.id::text
     OR (NEW.report #>> '{measurementContext,timeline,baseline,startedAt}')::timestamptz
        IS DISTINCT FROM baseline_row.started_at
     OR (NEW.report #>> '{measurementContext,timeline,baseline,completedAt}')::timestamptz
        IS DISTINCT FROM baseline_row.completed_at
     OR (NEW.report #>>
          '{measurementContext,timeline,baseline,evidenceWindow,minObservedAt}')::timestamptz
        IS DISTINCT FROM baseline_min_observed_at
     OR (NEW.report #>>
          '{measurementContext,timeline,baseline,evidenceWindow,maxObservedAt}')::timestamptz
        IS DISTINCT FROM baseline_max_observed_at
     OR NEW.report #>> '{measurementContext,timeline,remeasurement,runId}'
        IS DISTINCT FROM remeasurement_row.id::text
     OR (NEW.report #>> '{measurementContext,timeline,remeasurement,startedAt}')::timestamptz
        IS DISTINCT FROM remeasurement_row.started_at
     OR (NEW.report #>> '{measurementContext,timeline,remeasurement,completedAt}')::timestamptz
        IS DISTINCT FROM remeasurement_row.completed_at
     OR (NEW.report #>>
          '{measurementContext,timeline,remeasurement,evidenceWindow,minObservedAt}')::timestamptz
        IS DISTINCT FROM remeasurement_min_observed_at
     OR (NEW.report #>>
          '{measurementContext,timeline,remeasurement,evidenceWindow,maxObservedAt}')::timestamptz
        IS DISTINCT FROM remeasurement_max_observed_at
     OR NEW.report #>> '{intervention,kind}' IS DISTINCT FROM NEW.intervention_kind
     OR NEW.report #>> '{intervention,artifactId}' IS DISTINCT FROM NEW.artifact_id::text
     OR NEW.report #>> '{intervention,artifactRevisionId}'
        IS DISTINCT FROM NEW.artifact_revision_id::text
     OR NEW.report #>> '{intervention,artifactContentHash}'
        IS DISTINCT FROM NEW.artifact_content_hash
     OR (NEW.report #>> '{intervention,observedAt}')::timestamptz
        IS DISTINCT FROM NEW.intervention_observed_at THEN
    RAISE EXCEPTION 'EXPERIMENT_REPORT_IDENTITY_INVALID' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.intervention_kind = 'PUBLISHED_PUBLICATION' AND (
       NEW.report #>> '{intervention,publicationRecordId}'
         IS DISTINCT FROM NEW.publication_record_id::text
       OR NEW.report #>> '{intervention,publicationAttemptId}'
         IS DISTINCT FROM NEW.publication_attempt_id::text
       OR NEW.report #>> '{intervention,channelPackageId}'
         IS DISTINCT FROM NEW.channel_package_id::text
       OR NEW.report #>> '{intervention,artifactReviewId}'
         IS DISTINCT FROM NEW.artifact_review_id::text
       OR NEW.report #>> '{intervention,applicationState}' IS DISTINCT FROM 'PUBLISHED'
       OR NEW.report #>> '{intervention,href}' IS DISTINCT FROM format(
         '/app/channels?tenant=%s&workspace=%s&publication=%s',
         NEW.tenant_id, NEW.workspace_id, NEW.publication_record_id
       )
     ) THEN
    RAISE EXCEPTION 'EXPERIMENT_REPORT_PUBLICATION_IDENTITY_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.intervention_kind = 'APPROVED_ARTIFACT' AND (
       NEW.report #>> '{intervention,artifactReviewId}'
         IS DISTINCT FROM NEW.artifact_review_id::text
       OR NEW.report #>> '{intervention,applicationState}'
         IS DISTINCT FROM 'APPROVED_NOT_PUBLISHED'
       OR NEW.report #>> '{intervention,applicationDisclosure}'
         IS DISTINCT FROM
           'Approval is a recorded review event, not proof of external application or causation.'
       OR NEW.report #>> '{intervention,href}' IS DISTINCT FROM format(
         '/app/artifacts?tenant=%s&workspace=%s&artifact=%s',
         NEW.tenant_id, NEW.workspace_id, NEW.artifact_id
       )
     ) THEN
    RAISE EXCEPTION 'EXPERIMENT_REPORT_APPROVAL_IDENTITY_INVALID' USING ERRCODE = 'P0001';
  END IF;
  expected_caveat := format(
    'The exact %s event was recorded at %s; sample size, excluded outcomes, Provider behavior, timing, external changes and uncertainty can affect the descriptive delta.',
    CASE WHEN NEW.intervention_kind = 'PUBLISHED_PUBLICATION'
      THEN 'applied publication' ELSE 'approval' END,
    to_char(
      NEW.intervention_observed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
  IF NEW.report ->> 'noGuarantee' IS DISTINCT FROM
       'This Experiment does not guarantee ranking, citation, recommendation, traffic or future performance.'
     OR NEW.report ->> 'caveat' IS DISTINCT FROM expected_caveat
     OR (
       NEW.intervention_kind = 'PUBLISHED_PUBLICATION'
       AND NEW.report ->> 'observedAssociation'
         IS DISTINCT FROM
           'This report describes an observed association across a recorded applied publication event; it does not establish causation.'
     )
     OR (
       NEW.intervention_kind = 'APPROVED_ARTIFACT'
       AND NEW.report ->> 'observedAssociation'
         IS DISTINCT FROM
           'This report describes an observed association across a recorded approval event; approval does not prove external application or causation.'
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(NEW.report -> 'comparisons') comparison
       WHERE comparison ->> 'observedAssociation'
         IS DISTINCT FROM
           'This descriptive result reports an observed association between the recorded intervention window and remeasurement.'
          OR comparison ->> 'caveat'
         IS DISTINCT FROM
           'This is a descriptive comparison of compatible samples; uncertainty, excluded outcomes, timing and external changes can affect the delta.'
          OR comparison ->> 'noGuarantee'
         IS DISTINCT FROM
           'This observed delta does not guarantee ranking, citation, recommendation or future performance.'
     ) THEN
    RAISE EXCEPTION 'EXPERIMENT_REPORT_DISCLOSURE_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.report #>> '{drillDown,baselineRunHref}' IS DISTINCT FROM format(
       '/app/measurement?tenant=%s&workspace=%s&run=%s',
       NEW.tenant_id, NEW.workspace_id, NEW.baseline_run_id
     )
     OR NEW.report #>> '{drillDown,remeasurementRunHref}' IS DISTINCT FROM format(
       '/app/measurement?tenant=%s&workspace=%s&run=%s',
       NEW.tenant_id, NEW.workspace_id, NEW.remeasurement_run_id
     )
     OR (
       NEW.intervention_kind = 'PUBLISHED_PUBLICATION'
       AND NEW.report #>> '{drillDown,interventionHref}' IS DISTINCT FROM format(
         '/app/channels?tenant=%s&workspace=%s&publication=%s',
         NEW.tenant_id, NEW.workspace_id, NEW.publication_record_id
       )
     )
     OR (
       NEW.intervention_kind = 'APPROVED_ARTIFACT'
       AND NEW.report #>> '{drillDown,interventionHref}' IS DISTINCT FROM format(
         '/app/artifacts?tenant=%s&workspace=%s&artifact=%s',
         NEW.tenant_id, NEW.workspace_id, NEW.artifact_id
       )
     ) THEN
    RAISE EXCEPTION 'EXPERIMENT_REPORT_DRILL_DOWN_INVALID' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM experiment_snapshot_links link
    JOIN metric_snapshots baseline_snapshot
      ON baseline_snapshot.tenant_id = link.tenant_id
     AND baseline_snapshot.workspace_id = link.workspace_id
     AND baseline_snapshot.id = link.baseline_snapshot_id
    JOIN metric_snapshots remeasurement_snapshot
      ON remeasurement_snapshot.tenant_id = link.tenant_id
     AND remeasurement_snapshot.workspace_id = link.workspace_id
     AND remeasurement_snapshot.id = link.remeasurement_snapshot_id
    WHERE link.tenant_id = NEW.tenant_id AND link.workspace_id = NEW.workspace_id
      AND link.experiment_id = NEW.id
      AND (
        NEW.report -> 'comparisons' -> (link.ordinal - 1) ->> 'metricKey'
          IS DISTINCT FROM link.metric_key
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1) ->> 'scopeKey'
          IS DISTINCT FROM link.scope_key
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1) ->> 'compatibilityKey'
          IS DISTINCT FROM link.compatibility_key
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1) ->> 'compatibilityHash'
          IS DISTINCT FROM link.compatibility_hash
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1) #>> '{baseline,snapshotId}'
          IS DISTINCT FROM baseline_snapshot.id::text
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1) #>> '{baseline,contentHash}'
          IS DISTINCT FROM baseline_snapshot.content_hash
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1) #> '{baseline,numerator}'
          IS DISTINCT FROM to_jsonb(baseline_snapshot.numerator)
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1)
             #> '{baseline,eligibleDenominator}'
          IS DISTINCT FROM to_jsonb(baseline_snapshot.eligible_denominator)
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1) #> '{baseline,value}'
          IS DISTINCT FROM COALESCE(to_jsonb(baseline_snapshot.value), 'null'::jsonb)
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1) #> '{baseline,excludedCounts}'
          IS DISTINCT FROM baseline_snapshot.excluded_counts
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1) #> '{baseline,sampleSize}'
          IS DISTINCT FROM to_jsonb(
            baseline_snapshot.eligible_denominator
            + (baseline_snapshot.excluded_counts ->> 'ERROR')::integer
            + (baseline_snapshot.excluded_counts ->> 'NOT_CHECKED')::integer
            + (baseline_snapshot.excluded_counts ->> 'INCONCLUSIVE')::integer
            + (baseline_snapshot.excluded_counts ->> 'NOT_APPLICABLE')::integer
          )
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1)
             #>> '{remeasurement,snapshotId}'
          IS DISTINCT FROM remeasurement_snapshot.id::text
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1)
             #>> '{remeasurement,contentHash}'
          IS DISTINCT FROM remeasurement_snapshot.content_hash
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1) #> '{remeasurement,numerator}'
          IS DISTINCT FROM to_jsonb(remeasurement_snapshot.numerator)
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1)
             #> '{remeasurement,eligibleDenominator}'
          IS DISTINCT FROM to_jsonb(remeasurement_snapshot.eligible_denominator)
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1) #> '{remeasurement,value}'
          IS DISTINCT FROM COALESCE(to_jsonb(remeasurement_snapshot.value), 'null'::jsonb)
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1)
             #> '{remeasurement,excludedCounts}'
          IS DISTINCT FROM remeasurement_snapshot.excluded_counts
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1)
             #> '{remeasurement,sampleSize}'
          IS DISTINCT FROM to_jsonb(
            remeasurement_snapshot.eligible_denominator
            + (remeasurement_snapshot.excluded_counts ->> 'ERROR')::integer
            + (remeasurement_snapshot.excluded_counts ->> 'NOT_CHECKED')::integer
            + (remeasurement_snapshot.excluded_counts ->> 'INCONCLUSIVE')::integer
            + (remeasurement_snapshot.excluded_counts ->> 'NOT_APPLICABLE')::integer
          )
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1) #> '{delta,numerator}'
          IS DISTINCT FROM to_jsonb(
            remeasurement_snapshot.numerator - baseline_snapshot.numerator
          )
        OR NEW.report -> 'comparisons' -> (link.ordinal - 1)
             #> '{delta,eligibleDenominator}'
          IS DISTINCT FROM to_jsonb(
            remeasurement_snapshot.eligible_denominator
            - baseline_snapshot.eligible_denominator
          )
        OR (
          (baseline_snapshot.value IS NULL OR remeasurement_snapshot.value IS NULL)
          AND NEW.report -> 'comparisons' -> (link.ordinal - 1) #> '{delta,value}'
            IS DISTINCT FROM 'null'::jsonb
        )
        OR (
          baseline_snapshot.value IS NOT NULL AND remeasurement_snapshot.value IS NOT NULL
          AND NEW.report -> 'comparisons' -> (link.ordinal - 1) #> '{delta,value}'
            IS DISTINCT FROM to_jsonb(remeasurement_snapshot.value - baseline_snapshot.value)
        )
      )
  ) THEN
    RAISE EXCEPTION 'EXPERIMENT_REPORT_COMPARISON_INVALID' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)::integer,
    jsonb_build_object(
      'ERROR', count(*) FILTER (WHERE status = 'ERROR')::integer,
      'NOT_CHECKED', count(*) FILTER (WHERE status = 'NOT_CHECKED')::integer,
      'INCONCLUSIVE', count(*) FILTER (WHERE status = 'INCONCLUSIVE')::integer,
      'NOT_APPLICABLE', count(*) FILTER (WHERE status = 'NOT_APPLICABLE')::integer
    ) INTO baseline_sample, baseline_excluded
  FROM prompt_runs WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND measurement_run_id = NEW.baseline_run_id;
  SELECT count(*)::integer,
    jsonb_build_object(
      'ERROR', count(*) FILTER (WHERE status = 'ERROR')::integer,
      'NOT_CHECKED', count(*) FILTER (WHERE status = 'NOT_CHECKED')::integer,
      'INCONCLUSIVE', count(*) FILTER (WHERE status = 'INCONCLUSIVE')::integer,
      'NOT_APPLICABLE', count(*) FILTER (WHERE status = 'NOT_APPLICABLE')::integer
    ) INTO remeasurement_sample, remeasurement_excluded
  FROM prompt_runs WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND measurement_run_id = NEW.remeasurement_run_id;
  SELECT COALESCE(jsonb_agg(
      jsonb_build_object('amount', amount, 'currency', currency) ORDER BY currency
    ), '[]'::jsonb) INTO baseline_cost
  FROM (
    SELECT cost_currency AS currency, sum(cost_amount)::numeric(18, 6)::text AS amount
    FROM prompt_runs WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
      AND measurement_run_id = NEW.baseline_run_id GROUP BY cost_currency
  ) costs;
  SELECT COALESCE(jsonb_agg(
      jsonb_build_object('amount', amount, 'currency', currency) ORDER BY currency
    ), '[]'::jsonb) INTO remeasurement_cost
  FROM (
    SELECT cost_currency AS currency, sum(cost_amount)::numeric(18, 6)::text AS amount
    FROM prompt_runs WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
      AND measurement_run_id = NEW.remeasurement_run_id GROUP BY cost_currency
  ) costs;
  IF NEW.report #> '{sample,baseline}' IS DISTINCT FROM to_jsonb(baseline_sample)
     OR NEW.report #> '{sample,remeasurement}' IS DISTINCT FROM to_jsonb(remeasurement_sample)
     OR NEW.report #> '{excludedCounts,baseline}' IS DISTINCT FROM baseline_excluded
     OR NEW.report #> '{excludedCounts,remeasurement}' IS DISTINCT FROM remeasurement_excluded
     OR NEW.report #> '{costBreakdown,baseline}' IS DISTINCT FROM baseline_cost
     OR NEW.report #> '{costBreakdown,remeasurement}' IS DISTINCT FROM remeasurement_cost
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(NEW.report -> 'comparisons') comparison
       WHERE comparison #> '{costBreakdown,baseline}' IS DISTINCT FROM baseline_cost
          OR comparison #> '{costBreakdown,remeasurement}' IS DISTINCT FROM remeasurement_cost
     ) THEN
    RAISE EXCEPTION 'EXPERIMENT_REPORT_SUMMARY_INVALID' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER experiment_mutation_guard
BEFORE UPDATE OR DELETE ON experiments
FOR EACH ROW EXECUTE FUNCTION enforce_experiment_mutation();

CREATE FUNCTION enforce_experiment_snapshot_link_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  experiment_row experiments%ROWTYPE;
  baseline_snapshot metric_snapshots%ROWTYPE;
  remeasurement_snapshot metric_snapshots%ROWTYPE;
  expected_compatibility_key text;
  expected_compatibility_hash text;
BEGIN
  SELECT * INTO experiment_row FROM experiments
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND id = NEW.experiment_id;
  IF experiment_row.id IS NULL OR experiment_row.status <> 'BUILDING' THEN
    RAISE EXCEPTION 'EXPERIMENT_SNAPSHOT_LINK_APPEND_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO baseline_snapshot FROM metric_snapshots
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND id = NEW.baseline_snapshot_id;
  SELECT * INTO remeasurement_snapshot FROM metric_snapshots
  WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id
    AND id = NEW.remeasurement_snapshot_id;
  expected_compatibility_key := aeostudio_experiment_compatibility_key(
    baseline_snapshot.metric_key,
    baseline_snapshot.method_version,
    baseline_snapshot.cohort
  );
  expected_compatibility_hash := encode(
    sha256(convert_to(expected_compatibility_key, 'UTF8')),
    'hex'
  );
  IF baseline_snapshot.id IS NULL OR remeasurement_snapshot.id IS NULL
     OR baseline_snapshot.measurement_run_id <> experiment_row.baseline_run_id
     OR remeasurement_snapshot.measurement_run_id <> experiment_row.remeasurement_run_id
     OR baseline_snapshot.metric_key <> NEW.metric_key
     OR remeasurement_snapshot.metric_key <> NEW.metric_key
     OR baseline_snapshot.method_version IS DISTINCT FROM remeasurement_snapshot.method_version
     OR baseline_snapshot.cohort IS DISTINCT FROM remeasurement_snapshot.cohort
     OR baseline_snapshot.scope_key <> NEW.scope_key
     OR remeasurement_snapshot.scope_key <> NEW.scope_key
     OR baseline_snapshot.content_hash <> NEW.baseline_content_hash
     OR remeasurement_snapshot.content_hash <> NEW.remeasurement_content_hash
     OR NEW.compatibility_key IS DISTINCT FROM expected_compatibility_key
     OR NEW.compatibility_hash IS DISTINCT FROM expected_compatibility_hash THEN
    RAISE EXCEPTION 'EXPERIMENT_SNAPSHOT_LINK_INVALID' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER experiment_snapshot_link_insert_guard
BEFORE INSERT ON experiment_snapshot_links
FOR EACH ROW EXECUTE FUNCTION enforce_experiment_snapshot_link_insert();

CREATE FUNCTION reject_experiment_snapshot_link_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'EXPERIMENT_SNAPSHOT_LINK_IMMUTABLE' USING ERRCODE = 'P0001';
END
$function$;

CREATE TRIGGER experiment_snapshot_link_mutation_guard
BEFORE UPDATE OR DELETE ON experiment_snapshot_links
FOR EACH ROW EXECUTE FUNCTION reject_experiment_snapshot_link_mutation();

CREATE INDEX experiments_source_lookup
  ON experiments (tenant_id, workspace_id, baseline_run_id, remeasurement_run_id);
CREATE INDEX experiment_snapshot_links_baseline_lookup
  ON experiment_snapshot_links (tenant_id, workspace_id, baseline_snapshot_id);
CREATE INDEX experiment_snapshot_links_remeasurement_lookup
  ON experiment_snapshot_links (tenant_id, workspace_id, remeasurement_snapshot_id);

REVOKE ALL ON experiments, experiment_snapshot_links FROM PUBLIC;
GRANT SELECT, INSERT ON experiments, experiment_snapshot_links TO aeostudio_runtime;
GRANT UPDATE (status, compatibility_hash, report, sealed_at) ON experiments TO aeostudio_runtime;
