CREATE TABLE evidence_sources (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('UPLOAD', 'CRAWL', 'PUBLIC')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  uri text,
  license text NOT NULL CHECK (length(license) BETWEEN 1 AND 240),
  publicity text NOT NULL CHECK (publicity IN ('PRIVATE', 'PUBLIC', 'RESTRICTED')),
  current_snapshot_id uuid,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE evidence_snapshots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  object_ref text NOT NULL CHECK (length(object_ref) BETWEEN 1 AND 2048),
  object_version_id text NOT NULL CHECK (length(object_version_id) BETWEEN 1 AND 1024),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 255),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 2147483648),
  captured_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, source_id, content_hash),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, source_id) REFERENCES evidence_sources(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE evidence_sources
  ADD CONSTRAINT evidence_source_current_snapshot_fk
  FOREIGN KEY (tenant_id, current_snapshot_id)
  REFERENCES evidence_snapshots(tenant_id, id);

CREATE TABLE claims (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  current_revision integer NOT NULL CHECK (current_revision > 0),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE claim_revisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  statement text NOT NULL CHECK (length(statement) BETWEEN 1 AND 4000),
  numeric_value double precision,
  unit text,
  scope text,
  conditions jsonb NOT NULL,
  expires_at timestamptz,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN
    ('NEEDS_EVIDENCE', 'DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'STALE')),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, claim_id, revision),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, claim_id) REFERENCES claims(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE claim_evidence_links (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  claim_revision_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  source_hash text CHECK (source_hash IS NULL OR source_hash ~ '^[a-f0-9]{64}$'),
  snippet text,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, claim_revision_id, snapshot_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, claim_revision_id)
    REFERENCES claim_revisions(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, snapshot_id)
    REFERENCES evidence_snapshots(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE claim_reviews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  claim_revision_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVE', 'REJECT')),
  reviewer_user_id uuid NOT NULL REFERENCES users(id),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  reviewed_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, claim_revision_id)
    REFERENCES claim_revisions(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE evidence_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims FORCE ROW LEVEL SECURITY;
ALTER TABLE claim_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE claim_evidence_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_evidence_links FORCE ROW LEVEL SECURITY;
ALTER TABLE claim_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_reviews FORCE ROW LEVEL SECURITY;

CREATE POLICY evidence_source_isolation ON evidence_sources
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY evidence_snapshot_isolation ON evidence_snapshots
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY claim_isolation ON claims
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY claim_revision_isolation ON claim_revisions
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY claim_evidence_link_isolation ON claim_evidence_links
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY claim_review_isolation ON claim_reviews
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON evidence_sources, evidence_snapshots, claims,
  claim_revisions, claim_evidence_links, claim_reviews TO aeostudio_runtime;
