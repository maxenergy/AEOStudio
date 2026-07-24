import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, Pool, type PoolClient } from 'pg';
import { describe, expect, test } from 'vitest';

import { reconcileDatabasePrincipals } from '../../packages/db/src/bootstrap-main.js';
import { runMigrations } from '../../packages/db/src/migrations.js';

interface TenantFixture {
  actorUserId: string;
  operationId: string;
  tenantId: string;
  workspaceId: string;
}

function loginPool(container: StartedPostgreSqlContainer, user: string, password: string): Pool {
  return new Pool({
    database: container.getDatabase(),
    host: container.getHost(),
    password,
    port: container.getPort(),
    user,
  });
}

async function recentContainerLogs(container: StartedPostgreSqlContainer): Promise<string> {
  const stream = await container.logs({ tail: 10_000 });
  let captured = '';
  stream.on('data', (chunk: Buffer | string) => {
    captured += chunk.toString();
  });
  await wait(250);
  stream.destroy();
  return captured;
}

async function bootstrapTenant(pool: Pool, ordinal: number): Promise<TenantFixture> {
  const fixture = {
    actorUserId: randomUUID(),
    auditEventId: randomUUID(),
    membershipId: randomUUID(),
    operationId: randomUUID(),
    roleBindingId: randomUUID(),
    tenantId: randomUUID(),
    workspaceId: randomUUID(),
  };
  await pool.query(
    `SELECT * FROM bootstrap_tenant(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
     )`,
    [
      `production-role-test-${ordinal}`,
      `owner-${ordinal}@example.test`,
      fixture.actorUserId,
      fixture.tenantId,
      `Tenant ${ordinal}`,
      fixture.workspaceId,
      `Workspace ${ordinal}`,
      fixture.membershipId,
      fixture.roleBindingId,
      fixture.auditEventId,
    ],
  );
  return fixture;
}

async function seedPendingWriteIntent(
  client: PoolClient,
  fixture: TenantFixture,
  ordinal: number,
): Promise<void> {
  const body = Buffer.from(`tenant-${ordinal}`, 'utf8');
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [fixture.tenantId]);
    await client.query(
      `INSERT INTO privacy_object_write_intents (
         operation_id, tenant_id, workspace_id, kind, request_identity,
         business_id, actor_user_id, audit_event_id, object_key,
         canonical_payload, checksum, content_type, byte_length,
         sealed_at, locked_until, business_payload, status, created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'TENANT_EXPORT', $4, $1, $5, $6, $7,
         $8, $9, 'application/json', $10,
         NULL, NULL, '{}'::jsonb, 'PENDING', clock_timestamp(), clock_timestamp()
       )`,
      [
        fixture.operationId,
        fixture.tenantId,
        fixture.workspaceId,
        ordinal.toString(16).padStart(64, '0'),
        fixture.actorUserId,
        randomUUID(),
        `tenants/${fixture.tenantId}/exports/${fixture.operationId}.bundle.json`,
        body,
        ordinal.toString(16).padStart(64, 'a'),
        body.byteLength,
      ],
    );
    await client.query(
      `INSERT INTO privacy_object_write_outbox (
         operation_id, tenant_id, available_at, dispatched_at
       ) VALUES ($1, $2, clock_timestamp(), NULL)`,
      [fixture.operationId, fixture.tenantId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

describe('Task 18 production database roles', () => {
  test('retries with a non-BYPASS bootstrap owner and never sends raw passwords to PostgreSQL', async () => {
    let container: StartedPostgreSqlContainer | undefined;
    let superuser: Client | undefined;
    let operator: Client | undefined;
    let application: Pool | undefined;
    try {
      container = await new PostgreSqlContainer('postgres:18.3-alpine3.23')
        .withCommand(['postgres', '-c', 'log_statement=all'])
        .start();
      superuser = new Client({ connectionString: container.getConnectionUri() });
      await superuser.connect();
      await superuser.query(`CREATE ROLE aeostudio_bootstrap_operator
          LOGIN CREATEDB CREATEROLE PASSWORD 'bootstrap-operator-password'`);
      const quotedDatabase = `"${container.getDatabase().replaceAll('"', '""')}"`;
      await superuser.query(
        `ALTER DATABASE ${quotedDatabase} OWNER TO aeostudio_bootstrap_operator`,
      );
      operator = new Client({
        database: container.getDatabase(),
        host: container.getHost(),
        password: 'bootstrap-operator-password',
        port: container.getPort(),
        user: 'aeostudio_bootstrap_operator',
      });
      await operator.connect();

      const passwords = new Map([
        ['aeostudio_app_login', 'FAILURE_APP_RAW_PASSWORD_MARKER'.padEnd(43, 'A')],
        ['aeostudio_lifecycle_login', 'FAILURE_LIFECYCLE_RAW_PASSWORD'.padEnd(43, 'L')],
        ['aeostudio_migration_login', 'FAILURE_MIGRATION_RAW_PASSWORD'.padEnd(43, 'M')],
        ['aeostudio_tenant_data_broker_login', 'FAILURE_BROKER_RAW_PASSWORD'.padEnd(43, 'B')],
      ]);
      await reconcileDatabasePrincipals(operator, container.getDatabase(), passwords);
      await operator.query('CREATE ROLE aeostudio_unexpected_admin');
      await operator.query(
        'GRANT aeostudio_unexpected_admin, aeostudio_runtime, aeostudio_lifecycle_worker TO aeostudio_tenant_data_broker_login',
      );
      await reconcileDatabasePrincipals(operator, container.getDatabase(), passwords);

      const brokerMemberships = await superuser.query<{ role_name: string }>(
        `SELECT granted.rolname AS role_name
           FROM pg_catalog.pg_auth_members membership
           JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
           JOIN pg_catalog.pg_roles member ON member.oid = membership.member
           WHERE member.rolname = 'aeostudio_tenant_data_broker_login'
           ORDER BY granted.rolname`,
      );
      expect(brokerMemberships.rows).toEqual([{ role_name: 'aeostudio_tenant_data_broker' }]);

      const operatorRole = await superuser.query<{
        rolbypassrls: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolsuper: boolean;
      }>(
        `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
           FROM pg_catalog.pg_roles
           WHERE rolname = 'aeostudio_bootstrap_operator'`,
      );
      expect(operatorRole.rows).toEqual([
        {
          rolbypassrls: false,
          rolcreatedb: true,
          rolcreaterole: true,
          rolreplication: false,
          rolsuper: false,
        },
      ]);

      application = loginPool(
        container,
        'aeostudio_app_login',
        passwords.get('aeostudio_app_login')!,
      );
      await expect(
        application.query<{ current_user: string }>('SELECT current_user'),
      ).resolves.toMatchObject({ rows: [{ current_user: 'aeostudio_app_login' }] });

      await superuser.query(
        `REVOKE ADMIN OPTION FOR aeostudio_app_login
           FROM aeostudio_bootstrap_operator`,
      );
      let failedBootstrap: unknown;
      try {
        await reconcileDatabasePrincipals(operator, container.getDatabase(), passwords);
      } catch (error) {
        failedBootstrap = error;
      }
      expect(failedBootstrap).toBeDefined();
      const failure = failedBootstrap as {
        code?: string;
        detail?: string;
        message?: string;
        where?: string;
      };
      expect(failure.code).toBe('42501');
      const failureText = [failure.message, failure.detail, failure.where].join('\n');
      expect(failureText).toContain('ALTER ROLE aeostudio_app_login');
      expect(failureText).toContain('SCRAM-SHA-256$');
      for (const password of passwords.values()) {
        expect(failureText.includes(password)).toBe(false);
      }

      const serverLogs = await recentContainerLogs(container);
      expect(serverLogs).toContain('ALTER ROLE aeostudio_app_login');
      expect(serverLogs).toContain('SCRAM-SHA-256$');
      for (const password of passwords.values()) {
        expect(serverLogs.includes(password)).toBe(false);
      }

      await expect(
        application.query<{ current_user: string }>('SELECT current_user'),
      ).resolves.toMatchObject({ rows: [{ current_user: 'aeostudio_app_login' }] });
    } finally {
      await application?.end();
      await operator?.end();
      await superuser?.end();
      await container?.stop();
    }
  }, 120_000);

  test('keeps runtime logins subject to RLS while migration-owned worker claims span tenants', async () => {
    let container: StartedPostgreSqlContainer | undefined;
    let superuser: Client | undefined;
    let application: Pool | undefined;
    let migration: Pool | undefined;
    let lifecycle: Pool | undefined;
    try {
      container = await new PostgreSqlContainer('postgres:18.3-alpine3.23')
        .withCommand(['postgres', '-c', 'log_statement=all'])
        .start();
      superuser = new Client({ connectionString: container.getConnectionUri() });
      await superuser.connect();

      const passwords = new Map([
        ['aeostudio_app_login', 'TASK18_APP_RAW_PASSWORD_MARKER'.padEnd(43, 'A')],
        ['aeostudio_lifecycle_login', 'TASK18_LIFECYCLE_RAW_PASSWORD'.padEnd(43, 'L')],
        ['aeostudio_migration_login', 'TASK18_MIGRATION_RAW_PASSWORD'.padEnd(43, 'M')],
        ['aeostudio_tenant_data_broker_login', 'TASK18_BROKER_RAW_PASSWORD'.padEnd(43, 'B')],
      ]);
      await reconcileDatabasePrincipals(superuser, container.getDatabase(), passwords);

      migration = loginPool(
        container,
        'aeostudio_migration_login',
        passwords.get('aeostudio_migration_login')!,
      );
      const migrationsDirectory = fileURLToPath(
        new URL('../../packages/db/migrations', import.meta.url),
      );
      await runMigrations(migration, migrationsDirectory);
      const migrationFiles = (await readdir(migrationsDirectory)).filter((file) =>
        /^\d+_[a-z0-9_]+\.sql$/iu.test(file),
      );
      const applied = await migration.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM schema_migrations',
      );
      expect(applied.rows[0]?.count).toBe(String(migrationFiles.length));

      const tenantA = await bootstrapTenant(migration, 1);
      const tenantB = await bootstrapTenant(migration, 2);
      const migrationClient = await migration.connect();
      try {
        await seedPendingWriteIntent(migrationClient, tenantA, 1);
        await seedPendingWriteIntent(migrationClient, tenantB, 2);
      } finally {
        migrationClient.release();
      }

      lifecycle = loginPool(
        container,
        'aeostudio_lifecycle_login',
        passwords.get('aeostudio_lifecycle_login')!,
      );
      const context = await lifecycle.query<{ tenant_id: string | null }>(
        "SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant_id",
      );
      expect(context.rows[0]?.tenant_id ?? null).toBeNull();

      const leaseToken = randomUUID();
      const claimed = await lifecycle.query<{ operation_id: string; tenant_id: string }>(
        `SELECT operation_id, tenant_id
           FROM claim_pending_privacy_object_write_intents($1, $2)`,
        [leaseToken, 10],
      );
      expect(new Set(claimed.rows.map((row) => row.tenant_id))).toEqual(
        new Set([tenantA.tenantId, tenantB.tenantId]),
      );
      expect(new Set(claimed.rows.map((row) => row.operation_id))).toEqual(
        new Set([tenantA.operationId, tenantB.operationId]),
      );

      application = loginPool(
        container,
        'aeostudio_app_login',
        passwords.get('aeostudio_app_login')!,
      );
      await expect(
        application.query<{ current_user: string }>('SELECT current_user'),
      ).resolves.toMatchObject({ rows: [{ current_user: 'aeostudio_app_login' }] });

      const roles = await superuser.query<{
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolname: string;
        rolsuper: boolean;
      }>(
        `SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolinherit, rolbypassrls
           FROM pg_catalog.pg_roles
           WHERE rolname = ANY($1::text[])
           ORDER BY rolname`,
        [
          [
            'aeostudio_app_login',
            'aeostudio_lifecycle_login',
            'aeostudio_lifecycle_worker',
            'aeostudio_migration_login',
            'aeostudio_runtime',
            'aeostudio_tenant_data_broker',
            'aeostudio_tenant_data_broker_login',
          ],
        ],
      );
      expect(roles.rows).toEqual([
        {
          rolbypassrls: false,
          rolcanlogin: true,
          rolcreaterole: false,
          rolinherit: true,
          rolname: 'aeostudio_app_login',
          rolsuper: false,
        },
        {
          rolbypassrls: false,
          rolcanlogin: true,
          rolcreaterole: false,
          rolinherit: true,
          rolname: 'aeostudio_lifecycle_login',
          rolsuper: false,
        },
        {
          rolbypassrls: false,
          rolcanlogin: false,
          rolcreaterole: false,
          rolinherit: true,
          rolname: 'aeostudio_lifecycle_worker',
          rolsuper: false,
        },
        {
          rolbypassrls: false,
          rolcanlogin: true,
          rolcreaterole: true,
          rolinherit: false,
          rolname: 'aeostudio_migration_login',
          rolsuper: false,
        },
        {
          rolbypassrls: false,
          rolcanlogin: false,
          rolcreaterole: false,
          rolinherit: true,
          rolname: 'aeostudio_runtime',
          rolsuper: false,
        },
        {
          rolbypassrls: false,
          rolcanlogin: false,
          rolcreaterole: false,
          rolinherit: true,
          rolname: 'aeostudio_tenant_data_broker',
          rolsuper: false,
        },
        {
          rolbypassrls: false,
          rolcanlogin: true,
          rolcreaterole: false,
          rolinherit: true,
          rolname: 'aeostudio_tenant_data_broker_login',
          rolsuper: false,
        },
      ]);

      const brokerMemberships = await superuser.query<{ role_name: string }>(
        `SELECT granted.rolname AS role_name
           FROM pg_catalog.pg_auth_members membership
           JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
           JOIN pg_catalog.pg_roles member ON member.oid = membership.member
           WHERE member.rolname = 'aeostudio_tenant_data_broker_login'
           ORDER BY granted.rolname`,
      );
      expect(brokerMemberships.rows).toEqual([{ role_name: 'aeostudio_tenant_data_broker' }]);
      const brokerTablePrivileges = await superuser.query(
        `SELECT table_schema, table_name, privilege_type
           FROM information_schema.role_table_grants
           WHERE grantee IN (
             'aeostudio_tenant_data_broker',
             'aeostudio_tenant_data_broker_login'
           )`,
      );
      expect(brokerTablePrivileges.rows).toEqual([]);

      const owner = await superuser.query<{ owner: string }>(
        `SELECT owner.rolname AS owner
           FROM pg_catalog.pg_proc function
           JOIN pg_catalog.pg_roles owner ON owner.oid = function.proowner
           WHERE function.proname = 'claim_pending_privacy_object_write_intents'`,
      );
      expect(owner.rows).toEqual([{ owner: 'aeostudio_migration_login' }]);

      const forcedTenantTables = await superuser.query<{
        owner_policy_present: boolean;
        table_name: string;
      }>(
        `SELECT relation.oid::regclass::text AS table_name,
             EXISTS (
               SELECT 1
               FROM pg_catalog.pg_policy policy
               JOIN pg_catalog.pg_roles policy_owner
                 ON policy_owner.rolname = 'aeostudio_migration_login'
               WHERE policy.polrelid = relation.oid
                 AND policy.polname = 'aeostudio_migration_owner_all_tenants'
                 AND policy.polcmd = '*'
                 AND policy.polpermissive
                 AND policy.polroles = ARRAY[policy_owner.oid]::oid[]
                 AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
                 AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
             ) AS owner_policy_present
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
           ORDER BY relation.relname`,
      );
      expect(forcedTenantTables.rows.length).toBeGreaterThan(0);
      expect(forcedTenantTables.rows.filter((row) => !row.owner_policy_present)).toEqual([]);

      const definerPrivileges = await superuser.query<{
        owner: string;
        public_can_execute: boolean;
        signature: string;
      }>(
        `SELECT function.oid::regprocedure::text AS signature,
             owner.rolname AS owner,
             has_function_privilege('public', function.oid, 'EXECUTE') AS public_can_execute
           FROM pg_catalog.pg_proc function
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function.pronamespace
           JOIN pg_catalog.pg_roles owner ON owner.oid = function.proowner
           WHERE namespace.nspname = 'public'
             AND function.prosecdef
           ORDER BY function.oid::regprocedure::text`,
      );
      expect(definerPrivileges.rows.length).toBeGreaterThan(0);
      expect(new Set(definerPrivileges.rows.map((row) => row.owner))).toEqual(
        new Set(['aeostudio_migration_login']),
      );
      expect(definerPrivileges.rows.filter((row) => row.public_can_execute)).toEqual([]);

      const storedCredentials = await superuser.query<{ rolpassword: string }>(
        `SELECT rolpassword
           FROM pg_catalog.pg_authid
           WHERE rolname IN (
             'aeostudio_app_login',
             'aeostudio_lifecycle_login',
             'aeostudio_migration_login',
             'aeostudio_tenant_data_broker_login'
           )`,
      );
      expect(storedCredentials.rows).toHaveLength(4);
      expect(
        storedCredentials.rows.every((row) => row.rolpassword.startsWith('SCRAM-SHA-256$')),
      ).toBe(true);

      const serverLogs = await recentContainerLogs(container);
      for (const password of passwords.values()) {
        expect(serverLogs.includes(password)).toBe(false);
      }
    } finally {
      await application?.end();
      await lifecycle?.end();
      await migration?.end();
      await superuser?.end();
      await container?.stop();
    }
  }, 120_000);
});
