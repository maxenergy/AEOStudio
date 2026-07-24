CREATE TABLE profiles (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  current_revision integer NOT NULL CHECK (current_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE profile_revisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  content jsonb NOT NULL,
  completeness jsonb NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, profile_id, revision),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, profile_id) REFERENCES profiles(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE offerings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  current_revision integer NOT NULL CHECK (current_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, profile_id) REFERENCES profiles(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE offering_revisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  content jsonb NOT NULL,
  completeness jsonb NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, offering_id, revision),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, offering_id) REFERENCES offerings(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, profile_id) REFERENCES profiles(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE offering_attribute_definitions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  offering_revision_id uuid NOT NULL,
  attribute_key text NOT NULL,
  label text NOT NULL,
  value_type text NOT NULL CHECK (value_type IN ('text', 'number', 'boolean', 'url', 'string_list')),
  is_required boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, offering_revision_id, attribute_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, offering_id) REFERENCES offerings(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, offering_revision_id) REFERENCES offering_revisions(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE offering_attribute_values (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  offering_revision_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, offering_revision_id, definition_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, offering_revision_id) REFERENCES offering_revisions(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, definition_id) REFERENCES offering_attribute_definitions(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE profile_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE offerings ENABLE ROW LEVEL SECURITY;
ALTER TABLE offerings FORCE ROW LEVEL SECURITY;
ALTER TABLE offering_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE offering_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE offering_attribute_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE offering_attribute_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE offering_attribute_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE offering_attribute_values FORCE ROW LEVEL SECURITY;

CREATE POLICY profile_isolation ON profiles
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY profile_revision_isolation ON profile_revisions
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY offering_isolation ON offerings
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY offering_revision_isolation ON offering_revisions
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY offering_attribute_definition_isolation ON offering_attribute_definitions
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY offering_attribute_value_isolation ON offering_attribute_values
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON profiles, profile_revisions, offerings,
  offering_revisions, offering_attribute_definitions, offering_attribute_values
  TO aeostudio_runtime;
