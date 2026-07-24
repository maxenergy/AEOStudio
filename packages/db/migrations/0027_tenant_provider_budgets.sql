CREATE TABLE tenant_budget_policies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  limit_units bigint NOT NULL CHECK (limit_units > 0),
  warning_percent integer NOT NULL DEFAULT 80 CHECK (warning_percent BETWEEN 1 AND 99),
  explicitly_configured boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE provider_budget_policies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_key text NOT NULL CHECK (
    length(provider_key) BETWEEN 1 AND 160 AND provider_key = btrim(provider_key)
  ),
  limit_units bigint NOT NULL CHECK (limit_units > 0),
  warning_percent integer NOT NULL DEFAULT 80 CHECK (warning_percent BETWEEN 1 AND 99),
  explicitly_configured boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_key),
  UNIQUE (tenant_id, id)
);

ALTER TABLE jobs
  ADD COLUMN provider_key text CHECK (
    provider_key IS NULL
    OR (length(provider_key) BETWEEN 1 AND 160 AND provider_key = btrim(provider_key))
  );

CREATE INDEX jobs_provider_budget_usage
  ON jobs (tenant_id, provider_key)
  WHERE provider_key IS NOT NULL;

ALTER TABLE tenant_budget_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_budget_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_budget_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_budget_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_budget_policy_isolation ON tenant_budget_policies
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

CREATE POLICY provider_budget_policy_isolation ON provider_budget_policies
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

DO $$
BEGIN
  EXECUTE format(
    'CREATE POLICY aeostudio_migration_owner_all_tenants ON tenant_budget_policies TO %I USING (true) WITH CHECK (true)',
    current_user
  );
  EXECUTE format(
    'CREATE POLICY aeostudio_migration_owner_all_tenants ON provider_budget_policies TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON tenant_budget_policies, provider_budget_policies
  TO aeostudio_runtime;
