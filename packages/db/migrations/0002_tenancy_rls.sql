DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aeostudio_runtime') THEN
    CREATE ROLE aeostudio_runtime NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aeostudio_lifecycle_worker') THEN
    CREATE ROLE aeostudio_lifecycle_worker NOLOGIN;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname IN ('aeostudio_runtime', 'aeostudio_lifecycle_worker')
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
        OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'TENANT_GROUP_ROLE_PRIVILEGE_INVALID' USING ERRCODE = '42501';
  END IF;
END
$migration$;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_ci_unique ON users (lower(email));

CREATE TABLE external_identities (
  subject text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  tenant_id uuid GENERATED ALWAYS AS (id) STORED UNIQUE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED')),
  invited_email text NOT NULL,
  invited_by_user_id uuid REFERENCES users(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE role_bindings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'EDITOR', 'REVIEWER', 'PUBLISHER', 'ANALYST', 'VIEWER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, membership_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('SUCCEEDED', 'DENIED', 'FAILED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id)
);

CREATE OR REPLACE FUNCTION aeostudio_current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$function$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE role_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY workspace_isolation ON workspaces
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY membership_isolation ON memberships
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY role_binding_isolation ON role_bindings
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY audit_event_isolation ON audit_events
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

CREATE OR REPLACE FUNCTION bootstrap_tenant(
  p_subject text,
  p_email text,
  p_user_id uuid,
  p_tenant_id uuid,
  p_tenant_name text,
  p_workspace_id uuid,
  p_workspace_name text,
  p_membership_id uuid,
  p_role_binding_id uuid,
  p_audit_event_id uuid
)
RETURNS TABLE (
  user_id uuid,
  tenant_id uuid,
  tenant_name text,
  workspace_id uuid,
  workspace_name text,
  membership_id uuid,
  role text,
  membership_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_user_id uuid;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  SELECT ei.user_id INTO v_user_id
  FROM public.external_identities ei
  WHERE ei.subject = p_subject;

  IF v_user_id IS NULL THEN
    SELECT u.id INTO v_user_id
    FROM public.users u
    WHERE lower(u.email) = lower(p_email);
    IF v_user_id IS NULL THEN
      INSERT INTO public.users (id, email) VALUES (p_user_id, lower(p_email));
      v_user_id := p_user_id;
    END IF;
    INSERT INTO public.external_identities (subject, user_id) VALUES (p_subject, v_user_id);
  ELSE
    UPDATE public.users SET email = lower(p_email) WHERE id = v_user_id;
  END IF;

  INSERT INTO public.tenants (id, name) VALUES (p_tenant_id, p_tenant_name);
  INSERT INTO public.workspaces (id, tenant_id, name)
    VALUES (p_workspace_id, p_tenant_id, p_workspace_name);
  INSERT INTO public.memberships
    (id, tenant_id, user_id, status, invited_email, invited_by_user_id, accepted_at)
    VALUES (p_membership_id, p_tenant_id, v_user_id, 'ACTIVE', p_email, v_user_id, now());
  INSERT INTO public.role_bindings (id, tenant_id, workspace_id, membership_id, role)
    VALUES (p_role_binding_id, p_tenant_id, p_workspace_id, p_membership_id, 'OWNER');
  INSERT INTO public.audit_events
    (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id, outcome)
    VALUES (p_audit_event_id, p_tenant_id, p_workspace_id, v_user_id,
      'TENANT_CREATED', 'TENANT', p_tenant_id, 'SUCCEEDED');

  RETURN QUERY SELECT v_user_id, p_tenant_id, p_tenant_name, p_workspace_id,
    p_workspace_name, p_membership_id, 'OWNER'::text, 'ACTIVE'::text;
END
$function$;

CREATE OR REPLACE FUNCTION resolve_active_workspace_membership(
  p_subject text,
  p_tenant_id uuid,
  p_workspace_id uuid
)
RETURNS TABLE (
  user_id uuid,
  membership_id uuid,
  role text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  RETURN QUERY
    SELECT ei.user_id, m.id, rb.role
    FROM public.external_identities ei
    JOIN public.memberships m
      ON m.user_id = ei.user_id
      AND m.tenant_id = p_tenant_id
      AND m.status = 'ACTIVE'
    JOIN public.role_bindings rb
      ON rb.tenant_id = m.tenant_id
      AND rb.membership_id = m.id
      AND rb.workspace_id = p_workspace_id
    WHERE ei.subject = p_subject;
END
$function$;

CREATE OR REPLACE FUNCTION list_actor_workspaces(p_subject text)
RETURNS TABLE (
  tenant_id uuid,
  tenant_name text,
  workspace_id uuid,
  workspace_name text,
  membership_id uuid,
  role text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT t.id, t.name, w.id, w.name, m.id, rb.role
  FROM public.external_identities ei
  JOIN public.memberships m
    ON m.user_id = ei.user_id
    AND m.status = 'ACTIVE'
  JOIN public.tenants t ON t.id = m.tenant_id
  JOIN public.role_bindings rb
    ON rb.tenant_id = m.tenant_id
    AND rb.membership_id = m.id
  JOIN public.workspaces w
    ON w.tenant_id = rb.tenant_id
    AND w.id = rb.workspace_id
  WHERE ei.subject = p_subject
  ORDER BY w.created_at DESC, w.id
$function$;

CREATE OR REPLACE FUNCTION invite_workspace_member(
  p_actor_user_id uuid,
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_email text,
  p_role text,
  p_invited_user_id uuid,
  p_membership_id uuid,
  p_role_binding_id uuid,
  p_audit_event_id uuid
)
RETURNS TABLE (
  membership_id uuid,
  user_id uuid,
  invited_email text,
  role text,
  membership_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_user_id uuid;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  IF NOT EXISTS (
    SELECT 1
    FROM public.memberships m
    JOIN public.role_bindings rb
      ON rb.tenant_id = m.tenant_id
      AND rb.membership_id = m.id
      AND rb.workspace_id = p_workspace_id
    WHERE m.tenant_id = p_tenant_id
      AND m.user_id = p_actor_user_id
      AND m.status = 'ACTIVE'
      AND rb.role = 'OWNER'
  ) THEN
    RAISE EXCEPTION 'MEMBERSHIP_INVITE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT u.id INTO v_user_id FROM public.users u WHERE lower(u.email) = lower(p_email);
  IF v_user_id IS NULL THEN
    INSERT INTO public.users (id, email) VALUES (p_invited_user_id, lower(p_email));
    v_user_id := p_invited_user_id;
  END IF;

  INSERT INTO public.memberships
    (id, tenant_id, user_id, status, invited_email, invited_by_user_id)
    VALUES (p_membership_id, p_tenant_id, v_user_id, 'PENDING', lower(p_email), p_actor_user_id);
  INSERT INTO public.role_bindings (id, tenant_id, workspace_id, membership_id, role)
    VALUES (p_role_binding_id, p_tenant_id, p_workspace_id, p_membership_id, p_role);
  INSERT INTO public.audit_events
    (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id, outcome,
      metadata)
    VALUES (p_audit_event_id, p_tenant_id, p_workspace_id, p_actor_user_id,
      'MEMBERSHIP_INVITED', 'MEMBERSHIP', p_membership_id, 'SUCCEEDED',
      jsonb_build_object('role', p_role));

  RETURN QUERY SELECT p_membership_id, v_user_id, lower(p_email), p_role, 'PENDING'::text;
END
$function$;

CREATE OR REPLACE FUNCTION accept_workspace_membership(
  p_subject text,
  p_email text,
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_membership_id uuid,
  p_audit_event_id uuid
)
RETURNS TABLE (
  membership_id uuid,
  user_id uuid,
  invited_email text,
  role text,
  membership_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_user_id uuid;
  v_role text;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  SELECT m.user_id, rb.role INTO v_user_id, v_role
  FROM public.memberships m
  JOIN public.role_bindings rb
    ON rb.tenant_id = m.tenant_id
    AND rb.membership_id = m.id
    AND rb.workspace_id = p_workspace_id
  WHERE m.id = p_membership_id
    AND m.tenant_id = p_tenant_id
    AND m.status = 'PENDING'
    AND lower(m.invited_email) = lower(p_email);

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.external_identities (subject, user_id)
    VALUES (p_subject, v_user_id)
    ON CONFLICT (subject) DO UPDATE SET user_id = EXCLUDED.user_id;
  UPDATE public.users SET email = lower(p_email) WHERE id = v_user_id;
  UPDATE public.memberships
    SET status = 'ACTIVE', accepted_at = now()
    WHERE id = p_membership_id AND tenant_id = p_tenant_id;
  INSERT INTO public.audit_events
    (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id, outcome)
    VALUES (p_audit_event_id, p_tenant_id, p_workspace_id, v_user_id,
      'MEMBERSHIP_ACCEPTED', 'MEMBERSHIP', p_membership_id, 'SUCCEEDED');

  RETURN QUERY SELECT p_membership_id, v_user_id, lower(p_email), v_role, 'ACTIVE'::text;
END
$function$;

CREATE OR REPLACE FUNCTION change_workspace_member_role(
  p_actor_user_id uuid,
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_membership_id uuid,
  p_role text,
  p_audit_event_id uuid
)
RETURNS TABLE (
  membership_id uuid,
  user_id uuid,
  invited_email text,
  role text,
  membership_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_user_id uuid;
  v_invited_email text;
  v_status text;
  v_old_role text;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  IF NOT EXISTS (
    SELECT 1
    FROM public.memberships actor_membership
    JOIN public.role_bindings actor_role
      ON actor_role.tenant_id = actor_membership.tenant_id
      AND actor_role.membership_id = actor_membership.id
      AND actor_role.workspace_id = p_workspace_id
    WHERE actor_membership.tenant_id = p_tenant_id
      AND actor_membership.user_id = p_actor_user_id
      AND actor_membership.status = 'ACTIVE'
      AND actor_role.role = 'OWNER'
  ) THEN
    RAISE EXCEPTION 'MEMBERSHIP_ROLE_CHANGE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT m.user_id, m.invited_email, m.status, rb.role
    INTO v_user_id, v_invited_email, v_status, v_old_role
  FROM public.memberships m
  JOIN public.role_bindings rb
    ON rb.tenant_id = m.tenant_id
    AND rb.membership_id = m.id
    AND rb.workspace_id = p_workspace_id
  WHERE m.id = p_membership_id
    AND m.tenant_id = p_tenant_id
    AND m.status IN ('PENDING', 'ACTIVE');

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;
  IF v_old_role = 'OWNER' AND p_role <> 'OWNER' AND (
    SELECT count(*)
    FROM public.memberships owner_membership
    JOIN public.role_bindings owner_role
      ON owner_role.tenant_id = owner_membership.tenant_id
      AND owner_role.membership_id = owner_membership.id
      AND owner_role.workspace_id = p_workspace_id
    WHERE owner_membership.tenant_id = p_tenant_id
      AND owner_membership.status = 'ACTIVE'
      AND owner_role.role = 'OWNER'
  ) <= 1 THEN
    RAISE EXCEPTION 'LAST_OWNER_ROLE_CHANGE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  UPDATE public.role_bindings AS target_role
    SET role = p_role
    WHERE target_role.tenant_id = p_tenant_id
      AND target_role.workspace_id = p_workspace_id
      AND target_role.membership_id = p_membership_id;
  INSERT INTO public.audit_events
    (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id, outcome,
      metadata)
    VALUES (p_audit_event_id, p_tenant_id, p_workspace_id, p_actor_user_id,
      'MEMBERSHIP_ROLE_CHANGED', 'MEMBERSHIP', p_membership_id, 'SUCCEEDED',
      jsonb_build_object('fromRole', v_old_role, 'toRole', p_role));

  RETURN QUERY SELECT p_membership_id, v_user_id, v_invited_email, p_role, v_status;
END
$function$;

CREATE OR REPLACE FUNCTION revoke_workspace_membership(
  p_actor_user_id uuid,
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_membership_id uuid,
  p_audit_event_id uuid
)
RETURNS TABLE (
  membership_id uuid,
  user_id uuid,
  invited_email text,
  role text,
  membership_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_user_id uuid;
  v_invited_email text;
  v_role text;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  IF NOT EXISTS (
    SELECT 1
    FROM public.memberships actor_membership
    JOIN public.role_bindings actor_role
      ON actor_role.tenant_id = actor_membership.tenant_id
      AND actor_role.membership_id = actor_membership.id
      AND actor_role.workspace_id = p_workspace_id
    WHERE actor_membership.tenant_id = p_tenant_id
      AND actor_membership.user_id = p_actor_user_id
      AND actor_membership.status = 'ACTIVE'
      AND actor_role.role = 'OWNER'
  ) THEN
    RAISE EXCEPTION 'MEMBERSHIP_REVOKE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT m.user_id, m.invited_email, rb.role INTO v_user_id, v_invited_email, v_role
  FROM public.memberships m
  JOIN public.role_bindings rb
    ON rb.tenant_id = m.tenant_id
    AND rb.membership_id = m.id
    AND rb.workspace_id = p_workspace_id
  WHERE m.id = p_membership_id
    AND m.tenant_id = p_tenant_id
    AND m.status IN ('PENDING', 'ACTIVE');

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;
  IF v_user_id = p_actor_user_id THEN
    RAISE EXCEPTION 'SELF_REVOKE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  UPDATE public.memberships
    SET status = 'REVOKED', revoked_at = now()
    WHERE id = p_membership_id AND tenant_id = p_tenant_id;
  INSERT INTO public.audit_events
    (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id, outcome,
      metadata)
    VALUES (p_audit_event_id, p_tenant_id, p_workspace_id, p_actor_user_id,
      'MEMBERSHIP_REVOKED', 'MEMBERSHIP', p_membership_id, 'SUCCEEDED',
      jsonb_build_object('role', v_role));

  RETURN QUERY SELECT p_membership_id, v_user_id, v_invited_email, v_role, 'REVOKED'::text;
END
$function$;

REVOKE ALL ON FUNCTION bootstrap_tenant(text, text, uuid, uuid, text, uuid, text, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_active_workspace_membership(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_actor_workspaces(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION invite_workspace_member(uuid, uuid, uuid, text, text, uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION accept_workspace_membership(text, text, uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION change_workspace_member_role(uuid, uuid, uuid, uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_workspace_membership(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO aeostudio_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_login_attempts, auth_sessions TO aeostudio_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, workspaces, memberships, role_bindings, audit_events TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION bootstrap_tenant(text, text, uuid, uuid, text, uuid, text, uuid, uuid, uuid) TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION resolve_active_workspace_membership(text, uuid, uuid) TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION list_actor_workspaces(text) TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION invite_workspace_member(uuid, uuid, uuid, text, text, uuid, uuid, uuid, uuid) TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION accept_workspace_membership(text, text, uuid, uuid, uuid, uuid) TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION change_workspace_member_role(uuid, uuid, uuid, uuid, text, uuid) TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION revoke_workspace_membership(uuid, uuid, uuid, uuid, uuid) TO aeostudio_runtime;
