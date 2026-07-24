-- Task 18: keep the migration login NOBYPASSRLS while allowing only functions
-- owned by that offline principal to perform governed cross-Tenant work. Every
-- current forced-RLS Tenant table gets one explicit owner policy. Future
-- forced-RLS Tenant tables must create the same policy in their own migration.
DO $hardening$
DECLARE
  owner_policy_name constant text := 'aeostudio_migration_owner_all_tenants';
  tenant_table record;
  definer_function record;
BEGIN
  FOR tenant_table IN
    SELECT namespace.nspname AS schema_name, relation.relname AS table_name,
      relation.oid AS table_oid
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute attribute
        WHERE attribute.attrelid = relation.oid
          AND attribute.attname = 'tenant_id'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )
    ORDER BY namespace.nspname, relation.relname
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy policy
      WHERE policy.polrelid = tenant_table.table_oid
        AND policy.polname = owner_policy_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I.%I AS PERMISSIVE FOR ALL TO %I USING (true) WITH CHECK (true)',
        owner_policy_name,
        tenant_table.schema_name,
        tenant_table.table_name,
        current_user
      );
    END IF;
  END LOOP;

  FOR definer_function IN
    SELECT function.oid::regprocedure::text AS signature
    FROM pg_catalog.pg_proc function
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function.pronamespace
    WHERE namespace.nspname = 'public'
      AND function.prosecdef
    ORDER BY function.oid
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC',
      definer_function.signature
    );
  END LOOP;
END
$hardening$;
