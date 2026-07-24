CREATE TABLE sites (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  origin text NOT NULL,
  hostname text NOT NULL,
  status text NOT NULL DEFAULT 'UNVERIFIED' CHECK (status IN ('UNVERIFIED', 'VERIFIED')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, workspace_id, origin),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, profile_id) REFERENCES profiles(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE site_verifications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('DNS', 'FILE', 'OAUTH', 'ADMIN')),
  challenge_token text NOT NULL,
  challenge_path text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VERIFIED')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE crawl_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  job_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('COMPLETE', 'PARTIAL', 'FAILED_TERMINAL')),
  error_code text,
  page_count integer NOT NULL CHECK (page_count BETWEEN 0 AND 500),
  total_bytes bigint NOT NULL CHECK (total_bytes BETWEEN 0 AND 2147483648),
  completed_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, job_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE crawl_snapshots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  crawl_id uuid NOT NULL,
  site_id uuid NOT NULL,
  url text NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  captured_at timestamptz NOT NULL,
  object_ref text NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, crawl_id) REFERENCES crawl_runs(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE baseline_findings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  crawl_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  finding_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'ERROR')),
  detail text NOT NULL,
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, crawl_id) REFERENCES crawl_runs(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES crawl_snapshots(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites FORCE ROW LEVEL SECURITY;
ALTER TABLE site_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_verifications FORCE ROW LEVEL SECURITY;
ALTER TABLE crawl_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE crawl_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE crawl_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE crawl_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE baseline_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE baseline_findings FORCE ROW LEVEL SECURITY;

CREATE POLICY site_isolation ON sites
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

CREATE POLICY site_verification_isolation ON site_verifications
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

CREATE POLICY crawl_run_isolation ON crawl_runs
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY crawl_snapshot_isolation ON crawl_snapshots
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY baseline_finding_isolation ON baseline_findings
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON sites, site_verifications, crawl_runs,
  crawl_snapshots, baseline_findings TO aeostudio_runtime;

ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check
  CHECK (job_type IN ('PROFILE_READINESS', 'SITE_CRAWL'));
