ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check
  CHECK (job_type IN
    ('PROFILE_READINESS', 'SITE_CRAWL', 'CONTENT_PLAN', 'ARTIFACT_GENERATION', 'PUBLICATION'));
ALTER TABLE jobs ADD CONSTRAINT jobs_publication_identity_unique
  UNIQUE (tenant_id, workspace_id, id);

CREATE TABLE channel_definitions (
  id uuid PRIMARY KEY,
  channel_key text NOT NULL UNIQUE
    CHECK (channel_key ~ '^[a-z0-9][a-z0-9._-]{0,159}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  status text NOT NULL CHECK (status IN ('AVAILABLE', 'UNAVAILABLE', 'DEPRECATED')),
  unavailable_reason text CHECK (unavailable_reason IS NULL OR length(unavailable_reason) <= 500),
  package_transformer_key text NOT NULL
    CHECK (package_transformer_key ~ '^[a-z0-9][a-z0-9._-]{0,159}$'),
  package_schema_version text NOT NULL CHECK (length(package_schema_version) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE adapter_versions (
  id uuid PRIMARY KEY,
  channel_definition_id uuid NOT NULL REFERENCES channel_definitions(id) ON DELETE CASCADE,
  adapter_key text NOT NULL CHECK (length(adapter_key) BETWEEN 1 AND 160),
  adapter_version text NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 80),
  enabled boolean NOT NULL,
  disabled_reason text CHECK (disabled_reason IS NULL OR length(disabled_reason) <= 500),
  capabilities text[] NOT NULL,
  required_scopes text[] NOT NULL,
  terms_version text NOT NULL CHECK (length(terms_version) BETWEEN 1 AND 120),
  terms_status text NOT NULL CHECK (terms_status IN ('ALLOWED', 'REVIEW_REQUIRED', 'PROHIBITED')),
  processing_region text NOT NULL CHECK (length(processing_region) BETWEEN 1 AND 160),
  retention_policy text NOT NULL CHECK (length(retention_policy) BETWEEN 1 AND 500),
  training_policy text NOT NULL CHECK (length(training_policy) BETWEEN 1 AND 500),
  subprocessors jsonb NOT NULL CHECK (jsonb_typeof(subprocessors) = 'array'),
  rate_policy jsonb NOT NULL CHECK (jsonb_typeof(rate_policy) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_definition_id, adapter_key, adapter_version)
);

CREATE INDEX adapter_versions_registry_order
  ON adapter_versions (channel_definition_id, adapter_key, adapter_version);

-- Industry-neutral package/export capability only. No seed claims a live external publish path.
INSERT INTO channel_definitions
  (id, channel_key, display_name, status, unavailable_reason,
    package_transformer_key, package_schema_version)
VALUES
  ('00000000-0000-7000-8000-000000001000', 'portable-web-export',
    'Portable Web Export', 'AVAILABLE', NULL, 'generic-web-package', '1.0.0');

REVOKE ALL ON channel_definitions, adapter_versions FROM PUBLIC;
GRANT SELECT ON channel_definitions, adapter_versions TO aeostudio_runtime;

-- Exact publication hand-offs must preserve the complete tenant/workspace Artifact identity.
-- These keys let the package FK bind the revision number and hash as well as its UUID.
ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_channel_package_identity_unique
  UNIQUE (tenant_id, workspace_id, id);

ALTER TABLE artifact_revisions
  ADD CONSTRAINT artifact_revisions_channel_package_identity_unique
  UNIQUE (tenant_id, workspace_id, artifact_id, id, revision, content_hash);

CREATE TABLE channel_packages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  package_revision integer NOT NULL CHECK (package_revision > 0),
  channel_definition_id uuid NOT NULL REFERENCES channel_definitions(id) ON DELETE RESTRICT,
  channel_key text NOT NULL CHECK (length(channel_key) BETWEEN 1 AND 160),
  transformer_key text NOT NULL CHECK (length(transformer_key) BETWEEN 1 AND 160),
  transformer_version text NOT NULL CHECK (length(transformer_version) BETWEEN 1 AND 80),
  package_schema_version text NOT NULL CHECK (length(package_schema_version) BETWEEN 1 AND 80),
  artifact_id uuid NOT NULL,
  artifact_revision_id uuid NOT NULL,
  artifact_revision integer NOT NULL CHECK (artifact_revision > 0),
  artifact_content_hash text NOT NULL CHECK (artifact_content_hash ~ '^[a-f0-9]{64}$'),
  artifact_type text NOT NULL CHECK (artifact_type IN
    ('DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE')),
  artifact_locale text NOT NULL CHECK (length(artifact_locale) BETWEEN 2 AND 35),
  artifact_market text NOT NULL CHECK (length(artifact_market) BETWEEN 1 AND 120),
  artifact_method_policy_version text NOT NULL,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  package_checksum text NOT NULL CHECK (package_checksum ~ '^[a-f0-9]{64}$'),
  payload_object_ref text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (
    tenant_id,
    workspace_id,
    artifact_revision_id,
    artifact_content_hash,
    channel_definition_id,
    transformer_key,
    transformer_version,
    package_schema_version
  ),
  UNIQUE (tenant_id, workspace_id, artifact_id, channel_definition_id, package_revision),
  FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
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
  ) ON DELETE RESTRICT
);

CREATE INDEX channel_packages_artifact_lookup
  ON channel_packages (tenant_id, workspace_id, artifact_id, artifact_revision);

ALTER TABLE channel_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_packages FORCE ROW LEVEL SECURITY;

CREATE POLICY channel_package_isolation ON channel_packages
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

CREATE FUNCTION reject_channel_package_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'CHANNEL_PACKAGE_IMMUTABLE' USING ERRCODE = 'P0001';
END
$function$;

CREATE TRIGGER channel_package_immutable_guard
BEFORE UPDATE OR DELETE ON channel_packages
FOR EACH ROW EXECUTE FUNCTION reject_channel_package_mutation();

REVOKE ALL ON channel_packages FROM PUBLIC;
GRANT SELECT, INSERT ON channel_packages TO aeostudio_runtime;

-- The exact package snapshot is the evidence boundary for a PublicationRecord.
ALTER TABLE channel_packages
  ADD CONSTRAINT channel_packages_publication_identity_unique
  UNIQUE (
    tenant_id,
    workspace_id,
    id,
    package_checksum,
    artifact_revision_id,
    artifact_content_hash
  );

CREATE TABLE channel_authorizations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  adapter_version_id uuid NOT NULL REFERENCES adapter_versions(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  secret_arn text NOT NULL CHECK (
    secret_arn ~ '^arn:aws[a-zA-Z-]*:secretsmanager:ap-southeast-1:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$'
  ),
  granted_scopes text[] NOT NULL,
  accepted_terms_version text NOT NULL CHECK (length(accepted_terms_version) BETWEEN 1 AND 120),
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 2048),
  expires_at timestamptz,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, id, adapter_version_id, target),
  FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX channel_authorizations_eligibility_lookup
  ON channel_authorizations
    (tenant_id, workspace_id, adapter_version_id, target, created_at DESC);

CREATE TABLE publication_records (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  channel_package_id uuid NOT NULL,
  package_checksum text NOT NULL CHECK (package_checksum ~ '^[a-f0-9]{64}$'),
  artifact_revision_id uuid NOT NULL,
  artifact_content_hash text NOT NULL CHECK (artifact_content_hash ~ '^[a-f0-9]{64}$'),
  adapter_version_id uuid NOT NULL REFERENCES adapter_versions(id) ON DELETE RESTRICT,
  channel_authorization_id uuid NOT NULL,
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 2048),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN (
    'REQUESTED', 'BUDGET_BLOCKED', 'QUEUED', 'RUNNING', 'RETRY_WAIT', 'AMBIGUOUS',
    'RECONCILE_REQUIRED', 'RECONCILING', 'MANUAL_REVIEW_REQUIRED', 'PUBLISHED',
    'FAILED_TERMINAL', 'ROLLBACK_QUEUED', 'ROLLED_BACK', 'ROLLBACK_FAILED'
  )),
  job_id uuid,
  remote_ref text CHECK (remote_ref IS NULL OR length(remote_ref) BETWEEN 1 AND 2048),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (status <> 'PUBLISHED' OR remote_ref IS NOT NULL),
  CHECK (
    remote_ref IS NULL
    OR status IN ('PUBLISHED', 'ROLLBACK_QUEUED', 'ROLLED_BACK', 'ROLLBACK_FAILED')
  ),
  CHECK (
    (status = 'REQUESTED' AND job_id IS NULL)
    OR (status <> 'REQUESTED' AND job_id IS NOT NULL)
  ),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, idempotency_key),
  UNIQUE (tenant_id, workspace_id, job_id),
  UNIQUE (
    tenant_id,
    channel_authorization_id,
    artifact_revision_id,
    target,
    idempotency_key
  ),
  FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (
    tenant_id,
    workspace_id,
    channel_package_id,
    package_checksum,
    artifact_revision_id,
    artifact_content_hash
  ) REFERENCES channel_packages(
    tenant_id,
    workspace_id,
    id,
    package_checksum,
    artifact_revision_id,
    artifact_content_hash
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id,
    workspace_id,
    channel_authorization_id,
    adapter_version_id,
    target
  ) REFERENCES channel_authorizations(
    tenant_id,
    workspace_id,
    id,
    adapter_version_id,
    target
  ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id, job_id)
    REFERENCES jobs(tenant_id, workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX publication_records_package_lookup
  ON publication_records
    (tenant_id, workspace_id, channel_package_id, created_at DESC);

CREATE TABLE publication_attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  operation text NOT NULL CHECK (operation IN ('PUBLISH', 'RECONCILE', 'ROLLBACK')),
  outcome text NOT NULL CHECK (outcome IN (
    'STARTED', 'APPLIED', 'AMBIGUOUS', 'DEFINITELY_NOT_APPLIED', 'RETRYABLE_FAILURE',
    'TERMINAL_FAILURE', 'UNKNOWN', 'ROLLED_BACK', 'ROLLBACK_FAILED'
  )),
  remote_ref text CHECK (remote_ref IS NULL OR length(remote_ref) BETWEEN 1 AND 2048),
  error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 160),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  CHECK (
    (outcome = 'STARTED' AND finished_at IS NULL)
    OR (outcome <> 'STARTED' AND finished_at IS NOT NULL)
  ),
  CHECK (outcome <> 'APPLIED' OR remote_ref IS NOT NULL),
  UNIQUE (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, publication_id, attempt_number),
  FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, workspace_id, publication_id)
    REFERENCES publication_records(tenant_id, workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE channel_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_authorizations FORCE ROW LEVEL SECURITY;
ALTER TABLE publication_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE publication_records FORCE ROW LEVEL SECURITY;
ALTER TABLE publication_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE publication_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY channel_authorization_isolation ON channel_authorizations
  USING (
    tenant_id = aeostudio_current_tenant_id()
    AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = aeostudio_current_tenant_id()
    AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );
CREATE POLICY publication_record_isolation ON publication_records
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY publication_attempt_isolation ON publication_attempts
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

CREATE FUNCTION guard_channel_authorization_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_DELETE_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'REVOKED' THEN
    RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_TRANSITION_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  IF ROW(
    NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.adapter_version_id, NEW.secret_arn,
    NEW.granted_scopes, NEW.accepted_terms_version, NEW.target, NEW.expires_at,
    NEW.created_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.adapter_version_id, OLD.secret_arn,
    OLD.granted_scopes, OLD.accepted_terms_version, OLD.target, OLD.expires_at,
    OLD.created_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_METADATA_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_TIME_REGRESSION' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER channel_authorization_mutation_guard
BEFORE UPDATE OR DELETE ON channel_authorizations
FOR EACH ROW EXECUTE FUNCTION guard_channel_authorization_mutation();

CREATE FUNCTION guard_publication_record_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PUBLICATION_RECORD_DELETE_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  IF ROW(
    NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.channel_package_id, NEW.package_checksum,
    NEW.artifact_revision_id, NEW.artifact_content_hash, NEW.adapter_version_id,
    NEW.channel_authorization_id, NEW.target, NEW.idempotency_key, NEW.request_hash,
    NEW.requested_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.channel_package_id, OLD.package_checksum,
    OLD.artifact_revision_id, OLD.artifact_content_hash, OLD.adapter_version_id,
    OLD.channel_authorization_id, OLD.target, OLD.idempotency_key, OLD.request_hash,
    OLD.requested_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'PUBLICATION_REQUEST_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'PUBLICATION_TIME_REGRESSION' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id THEN
    RAISE EXCEPTION 'PUBLICATION_JOB_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.remote_ref IS NOT NULL AND NEW.remote_ref IS DISTINCT FROM OLD.remote_ref THEN
    RAISE EXCEPTION 'PUBLICATION_REMOTE_REF_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'REQUESTED' AND NEW.status IN ('BUDGET_BLOCKED', 'QUEUED', 'FAILED_TERMINAL'))
    OR (OLD.status = 'BUDGET_BLOCKED' AND NEW.status IN ('QUEUED', 'FAILED_TERMINAL'))
    OR (OLD.status = 'QUEUED' AND NEW.status IN ('RUNNING', 'FAILED_TERMINAL'))
    OR (OLD.status = 'RUNNING' AND NEW.status IN (
      'PUBLISHED', 'RETRY_WAIT', 'AMBIGUOUS', 'RECONCILE_REQUIRED', 'FAILED_TERMINAL'
    ))
    OR (OLD.status = 'RETRY_WAIT' AND NEW.status IN ('QUEUED', 'RUNNING', 'FAILED_TERMINAL'))
    OR (OLD.status = 'AMBIGUOUS' AND NEW.status IN (
      'RECONCILE_REQUIRED', 'RECONCILING', 'MANUAL_REVIEW_REQUIRED'
    ))
    OR (OLD.status = 'RECONCILE_REQUIRED' AND NEW.status IN (
      'RECONCILING', 'MANUAL_REVIEW_REQUIRED'
    ))
    OR (OLD.status = 'RECONCILING' AND NEW.status IN (
      'PUBLISHED', 'RETRY_WAIT', 'RECONCILE_REQUIRED', 'FAILED_TERMINAL',
      'MANUAL_REVIEW_REQUIRED'
    ))
    OR (OLD.status = 'MANUAL_REVIEW_REQUIRED' AND NEW.status IN (
      'RECONCILING', 'FAILED_TERMINAL'
    ))
    OR (OLD.status = 'PUBLISHED' AND NEW.status = 'ROLLBACK_QUEUED')
    OR (OLD.status = 'ROLLBACK_QUEUED' AND NEW.status IN ('ROLLED_BACK', 'ROLLBACK_FAILED'))
    OR (OLD.status = 'ROLLBACK_FAILED' AND NEW.status = 'ROLLBACK_QUEUED')
  ) THEN
    RAISE EXCEPTION 'PUBLICATION_STATUS_TRANSITION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'RUNNING' AND NEW.status = 'PUBLISHED' AND NOT EXISTS (
    SELECT 1 FROM publication_attempts
    WHERE tenant_id = NEW.tenant_id
      AND workspace_id = NEW.workspace_id
      AND publication_id = NEW.id
      AND operation = 'PUBLISH'
      AND outcome = 'APPLIED'
      AND remote_ref = NEW.remote_ref
      AND finished_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PUBLICATION_APPLIED_ATTEMPT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'RECONCILING' AND NEW.status = 'PUBLISHED' AND NOT EXISTS (
    SELECT 1 FROM publication_attempts
    WHERE tenant_id = NEW.tenant_id
      AND workspace_id = NEW.workspace_id
      AND publication_id = NEW.id
      AND operation = 'RECONCILE'
      AND outcome = 'APPLIED'
      AND remote_ref = NEW.remote_ref
      AND finished_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PUBLICATION_RECONCILIATION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER publication_record_mutation_guard
BEFORE UPDATE OR DELETE ON publication_records
FOR EACH ROW EXECUTE FUNCTION guard_publication_record_mutation();

CREATE FUNCTION validate_publication_job_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jobs
    WHERE tenant_id = NEW.tenant_id
      AND workspace_id = NEW.workspace_id
      AND id = NEW.job_id
      AND job_type = 'PUBLICATION'
      AND aggregate_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'PUBLICATION_JOB_BINDING_INVALID' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER publication_job_binding_guard
BEFORE INSERT OR UPDATE OF job_id, status ON publication_records
FOR EACH ROW EXECUTE FUNCTION validate_publication_job_binding();

CREATE FUNCTION guard_publication_attempt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PUBLICATION_ATTEMPT_DELETE_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.outcome <> 'STARTED' OR NEW.outcome = 'STARTED' OR NEW.finished_at IS NULL THEN
    RAISE EXCEPTION 'PUBLICATION_ATTEMPT_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF ROW(
    NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.publication_id, NEW.attempt_number,
    NEW.operation, NEW.started_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.publication_id, OLD.attempt_number,
    OLD.operation, OLD.started_at
  ) THEN
    RAISE EXCEPTION 'PUBLICATION_ATTEMPT_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER publication_attempt_mutation_guard
BEFORE UPDATE OR DELETE ON publication_attempts
FOR EACH ROW EXECUTE FUNCTION guard_publication_attempt_mutation();

REVOKE ALL ON channel_authorizations, publication_records, publication_attempts FROM PUBLIC;
GRANT SELECT, INSERT ON channel_authorizations TO aeostudio_runtime;
GRANT UPDATE (status, updated_at) ON channel_authorizations TO aeostudio_runtime;
GRANT SELECT, INSERT ON publication_records TO aeostudio_runtime;
GRANT UPDATE (status, job_id, remote_ref, updated_at) ON publication_records
  TO aeostudio_runtime;
GRANT SELECT, INSERT ON publication_attempts TO aeostudio_runtime;
GRANT UPDATE (outcome, remote_ref, error_code, finished_at) ON publication_attempts
  TO aeostudio_runtime;
