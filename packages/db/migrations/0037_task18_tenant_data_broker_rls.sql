-- Task 18: every Tenant-owned table remains FORCE RLS even when all direct
-- grants are already revoked. Ordinary callers require the exact app.tenant_id
-- context. The offline migration owner receives the same explicit all-Tenant
-- policy used by every other governed SECURITY DEFINER boundary.

ALTER TABLE public.tenant_data_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_data_capabilities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_data_capability_isolation
  ON public.tenant_data_capabilities
  USING (tenant_id = public.aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = public.aeostudio_current_tenant_id());

ALTER TABLE public.tenant_data_authenticated_object_read_sources
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_data_authenticated_object_read_sources
  FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_data_authenticated_read_source_isolation
  ON public.tenant_data_authenticated_object_read_sources
  USING (tenant_id = public.aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = public.aeostudio_current_tenant_id());

ALTER TABLE public.tenant_data_channel_package_object_bindings
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_data_channel_package_object_bindings
  FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_data_channel_package_object_binding_isolation
  ON public.tenant_data_channel_package_object_bindings
  USING (tenant_id = public.aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = public.aeostudio_current_tenant_id());

DO $owner_policy$
BEGIN
  EXECUTE format(
    'CREATE POLICY aeostudio_migration_owner_all_tenants ON public.tenant_data_capabilities TO %I USING (true) WITH CHECK (true)',
    current_user
  );
  EXECUTE format(
    'CREATE POLICY aeostudio_migration_owner_all_tenants ON public.tenant_data_authenticated_object_read_sources TO %I USING (true) WITH CHECK (true)',
    current_user
  );
  EXECUTE format(
    'CREATE POLICY aeostudio_migration_owner_all_tenants ON public.tenant_data_channel_package_object_bindings TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$owner_policy$;
