-- Migration 0025 added this policy to every forced-RLS Tenant table that
-- existed at that point. Migration 0040 created this table later, so add the
-- same migration-owner policy without changing the checksum of an applied
-- migration.
DROP POLICY IF EXISTS aeostudio_migration_owner_all_tenants
  ON signed_webhook_endpoint_verifications;

DO $owner_policy$
BEGIN
  EXECUTE format(
    'CREATE POLICY aeostudio_migration_owner_all_tenants ON public.signed_webhook_endpoint_verifications AS PERMISSIVE FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$owner_policy$;
