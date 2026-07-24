ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check
  CHECK (job_type IN
    ('PROFILE_READINESS', 'SITE_CRAWL', 'CONTENT_PLAN', 'ARTIFACT_GENERATION'));

ALTER TABLE audit_events
  ADD COLUMN actor_kind text NOT NULL DEFAULT 'USER'
    CHECK (actor_kind IN ('USER', 'AGENT')),
  ADD COLUMN actor_id uuid;

UPDATE audit_events SET actor_id = actor_user_id WHERE actor_id IS NULL;

CREATE FUNCTION normalize_audit_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.actor_kind = 'USER' THEN
    NEW.actor_id := NEW.actor_user_id;
  ELSIF NEW.actor_id IS NULL THEN
    RAISE EXCEPTION 'AUDIT_AGENT_ACTOR_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER audit_actor_normalization
BEFORE INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION normalize_audit_actor();

ALTER TABLE audit_events ALTER COLUMN actor_id SET NOT NULL;

CREATE TABLE artifacts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  brief_id uuid NOT NULL,
  artifact_type text NOT NULL CHECK (artifact_type IN
    ('DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE')),
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  status text NOT NULL CHECK (status IN
    ('PENDING', 'DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'STALE')),
  locale text NOT NULL CHECK (length(locale) BETWEEN 2 AND 35),
  market text NOT NULL CHECK (length(market) BETWEEN 1 AND 120),
  method_policy_version text NOT NULL,
  job_id uuid,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, job_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, brief_id) REFERENCES briefs(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;

CREATE POLICY artifact_isolation ON artifacts
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

GRANT SELECT, INSERT ON artifacts TO aeostudio_runtime;
GRANT UPDATE (job_id, current_revision, status) ON artifacts TO aeostudio_runtime;

CREATE TABLE artifact_revisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  brief_id uuid NOT NULL,
  artifact_type text NOT NULL CHECK (artifact_type IN
    ('DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE')),
  schema_version text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'STALE')),
  locale text NOT NULL,
  market text NOT NULL,
  source_artifact_ids jsonb NOT NULL,
  lineage jsonb NOT NULL,
  claim_bindings jsonb NOT NULL,
  method_policy_version text NOT NULL,
  created_by_actor_kind text NOT NULL CHECK (created_by_actor_kind IN ('USER', 'AGENT')),
  created_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  payload_object_ref text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, artifact_id, revision),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, artifact_id) REFERENCES artifacts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, brief_id) REFERENCES briefs(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE artifact_claim_links (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  artifact_revision_id uuid NOT NULL,
  claim_revision_id uuid NOT NULL,
  source_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, artifact_revision_id, claim_revision_id, snapshot_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, artifact_revision_id)
    REFERENCES artifact_revisions(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, claim_revision_id)
    REFERENCES claim_revisions(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, source_id)
    REFERENCES evidence_sources(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, snapshot_id)
    REFERENCES evidence_snapshots(tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE artifact_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE artifact_claim_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_claim_links FORCE ROW LEVEL SECURITY;

CREATE POLICY artifact_revision_isolation ON artifact_revisions
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY artifact_claim_link_isolation ON artifact_claim_links
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

GRANT SELECT, INSERT ON artifact_revisions, artifact_claim_links TO aeostudio_runtime;
GRANT UPDATE (status) ON artifact_revisions TO aeostudio_runtime;

CREATE FUNCTION enforce_artifact_projection_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  revision_status text;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.brief_id IS DISTINCT FROM OLD.brief_id
     OR NEW.artifact_type IS DISTINCT FROM OLD.artifact_type
     OR NEW.locale IS DISTINCT FROM OLD.locale
     OR NEW.market IS DISTINCT FROM OLD.market
     OR NEW.method_policy_version IS DISTINCT FROM OLD.method_policy_version
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ARTIFACT_ENVELOPE_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.job_id IS DISTINCT FROM OLD.job_id THEN
    IF OLD.job_id IS NOT NULL OR NEW.job_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM jobs
      WHERE id = NEW.job_id
        AND tenant_id = NEW.tenant_id
        AND workspace_id = NEW.workspace_id
        AND aggregate_id = NEW.id
        AND job_type = 'ARTIFACT_GENERATION'
    ) THEN
      RAISE EXCEPTION 'ARTIFACT_JOB_BINDING_FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.current_revision IS DISTINCT FROM OLD.current_revision
     OR NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.current_revision IS DISTINCT FROM OLD.current_revision
       AND NEW.current_revision <> OLD.current_revision + 1 THEN
      RAISE EXCEPTION 'ARTIFACT_REVISION_POINTER_FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
    SELECT status INTO revision_status
    FROM artifact_revisions
    WHERE artifact_id = NEW.id AND revision = NEW.current_revision;
    IF revision_status IS NULL OR revision_status <> NEW.status THEN
      RAISE EXCEPTION 'ARTIFACT_PROJECTION_MISMATCH' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER artifact_projection_update_guard
BEFORE UPDATE ON artifacts
FOR EACH ROW EXECUTE FUNCTION enforce_artifact_projection_update();

CREATE TABLE artifact_reviews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  artifact_revision_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  decision text NOT NULL CHECK (decision IN ('APPROVE', 'REJECT')),
  reviewer_user_id uuid NOT NULL REFERENCES users(id),
  note text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, artifact_revision_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, artifact_id) REFERENCES artifacts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, artifact_revision_id)
    REFERENCES artifact_revisions(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE artifact_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_review_isolation ON artifact_reviews
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
GRANT SELECT, INSERT ON artifact_reviews TO aeostudio_runtime;

CREATE FUNCTION enforce_artifact_review_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  revision_row artifact_revisions%ROWTYPE;
BEGIN
  SELECT * INTO revision_row
  FROM artifact_revisions
  WHERE id = NEW.artifact_revision_id
    AND artifact_id = NEW.artifact_id
    AND tenant_id = NEW.tenant_id
    AND workspace_id = NEW.workspace_id;

  IF revision_row.id IS NULL
    OR revision_row.status <> 'IN_REVIEW'
    OR revision_row.revision <> NEW.revision
    OR revision_row.content_hash <> NEW.content_hash THEN
    RAISE EXCEPTION 'ARTIFACT_REVIEW_EXACT_REVISION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.reviewer_user_id::text <> current_setting('app.actor_id', true) THEN
    RAISE EXCEPTION 'ARTIFACT_REVIEW_ACTOR_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  IF revision_row.created_by_actor_kind = 'USER'
    AND revision_row.created_by_actor_id = NEW.reviewer_user_id THEN
    RAISE EXCEPTION 'SELF_APPROVAL_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM memberships membership
    JOIN role_bindings binding
      ON binding.membership_id = membership.id
     AND binding.tenant_id = membership.tenant_id
    WHERE membership.tenant_id = NEW.tenant_id
      AND membership.user_id = NEW.reviewer_user_id
      AND membership.status = 'ACTIVE'
      AND binding.workspace_id = NEW.workspace_id
      AND binding.role IN ('OWNER', 'REVIEWER')
  ) THEN
    RAISE EXCEPTION 'ARTIFACT_REVIEW_ROLE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER artifact_review_insert_guard
BEFORE INSERT ON artifact_reviews
FOR EACH ROW EXECUTE FUNCTION enforce_artifact_review_insert();

CREATE FUNCTION enforce_artifact_revision_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'IN_REVIEW' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'IN_REVIEW' AND NEW.status IN ('APPROVED', 'REJECTED')
    AND EXISTS (
      SELECT 1
      FROM artifact_reviews review
      WHERE review.artifact_revision_id = OLD.id
        AND review.content_hash = OLD.content_hash
        AND review.decision = CASE WHEN NEW.status = 'APPROVED' THEN 'APPROVE' ELSE 'REJECT' END
    ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ARTIFACT_REVISION_STATUS_TRANSITION_FORBIDDEN' USING ERRCODE = 'P0001';
END
$function$;

CREATE TRIGGER artifact_revision_status_transition_guard
BEFORE UPDATE OF status ON artifact_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_artifact_revision_status_transition();
