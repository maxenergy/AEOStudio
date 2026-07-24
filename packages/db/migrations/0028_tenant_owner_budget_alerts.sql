CREATE TABLE tenant_owner_budget_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  budget_scope text NOT NULL CHECK (budget_scope IN ('TENANT', 'PROVIDER')),
  tenant_budget_policy_id uuid,
  provider_budget_policy_id uuid,
  provider_key text,
  threshold_percent integer NOT NULL CHECK (threshold_percent BETWEEN 1 AND 100),
  audience text NOT NULL DEFAULT 'TENANT_OWNER' CHECK (audience = 'TENANT_OWNER'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, source_workspace_id)
    REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, job_id)
    REFERENCES jobs(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, tenant_budget_policy_id)
    REFERENCES tenant_budget_policies(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, provider_budget_policy_id)
    REFERENCES provider_budget_policies(tenant_id, id) ON DELETE CASCADE,
  CHECK (
    (
      budget_scope = 'TENANT'
      AND tenant_budget_policy_id IS NOT NULL
      AND provider_budget_policy_id IS NULL
      AND provider_key IS NULL
    )
    OR (
      budget_scope = 'PROVIDER'
      AND tenant_budget_policy_id IS NULL
      AND provider_budget_policy_id IS NOT NULL
      AND provider_key IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX tenant_owner_budget_alert_tenant_dedup
  ON tenant_owner_budget_alerts
    (tenant_id, tenant_budget_policy_id, threshold_percent)
  WHERE budget_scope = 'TENANT';

CREATE UNIQUE INDEX tenant_owner_budget_alert_provider_dedup
  ON tenant_owner_budget_alerts
    (tenant_id, provider_budget_policy_id, threshold_percent)
  WHERE budget_scope = 'PROVIDER';

CREATE INDEX tenant_owner_budget_alert_read
  ON tenant_owner_budget_alerts (tenant_id, created_at DESC, id DESC);

CREATE TABLE tenant_owner_budget_alert_recipients (
  alert_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  audience text NOT NULL DEFAULT 'TENANT_OWNER' CHECK (audience = 'TENANT_OWNER'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, recipient_user_id),
  FOREIGN KEY (tenant_id, alert_id)
    REFERENCES tenant_owner_budget_alerts(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX tenant_owner_budget_alert_recipient_read
  ON tenant_owner_budget_alert_recipients
    (tenant_id, recipient_user_id, created_at DESC, alert_id DESC);

ALTER TABLE tenant_owner_budget_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_owner_budget_alerts FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_owner_budget_alert_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_owner_budget_alert_recipients FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_owner_budget_alert_isolation ON tenant_owner_budget_alerts
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

CREATE POLICY tenant_owner_budget_alert_recipient_isolation
  ON tenant_owner_budget_alert_recipients
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

DO $$
BEGIN
  EXECUTE format(
    'CREATE POLICY aeostudio_migration_owner_all_tenants ON tenant_owner_budget_alerts TO %I USING (true) WITH CHECK (true)',
    current_user
  );
  EXECUTE format(
    'CREATE POLICY aeostudio_migration_owner_all_tenants ON tenant_owner_budget_alert_recipients TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON tenant_owner_budget_alerts, tenant_owner_budget_alert_recipients
  TO aeostudio_runtime;
