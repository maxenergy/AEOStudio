import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { runMigrations } from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const tenantId = '00000000-0000-7000-8000-00000000b001';
const workspaceId = '00000000-0000-7000-8000-00000000b002';
const userId = '00000000-0000-7000-8000-00000000b003';
const channelId = '00000000-0000-7000-8000-00000000b004';
const adapterVersionId = '00000000-0000-7000-8000-00000000b005';
const activeAuthorizationId = '00000000-0000-7000-8000-00000000b006';
const revokedAuthorizationId = '00000000-0000-7000-8000-00000000b007';
const deletionRequestId = '00000000-0000-7000-8000-00000000b008';

describe('0041 provider-validation upgrade path', () => {
  let container: StartedPostgreSqlContainer;
  let superuserPool: Pool;
  let migrationPool: Pool;
  let temporaryRoot: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    superuserPool = new Pool({ connectionString: container.getConnectionUri() });
    const databaseName = new URL(container.getConnectionUri()).pathname.slice(1);
    await superuserPool.query(
      `CREATE ROLE aeostudio_migration
       LOGIN PASSWORD 'provider-validation-upgrade-test'
       CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS`,
    );
    await superuserPool.query(`ALTER DATABASE "${databaseName}" OWNER TO aeostudio_migration`);
    await superuserPool.query('ALTER SCHEMA public OWNER TO aeostudio_migration');

    const migrationUrl = new URL(container.getConnectionUri());
    migrationUrl.username = 'aeostudio_migration';
    migrationUrl.password = 'provider-validation-upgrade-test';
    migrationPool = new Pool({ connectionString: migrationUrl.toString() });

    temporaryRoot = await mkdtemp(join(tmpdir(), 'aeostudio-0041-upgrade-'));
    const migrations = fileURLToPath(new URL('../../packages/db/migrations', import.meta.url));
    const before0041 = join(temporaryRoot, 'before-0041');
    const only0041 = join(temporaryRoot, 'only-0041');
    await Promise.all([mkdir(before0041), mkdir(only0041)]);
    const files = (await readdir(migrations))
      .filter((file) => /^\d+_[a-z0-9_]+\.sql$/i.test(file))
      .sort();
    await Promise.all(
      files
        .filter((file) => file < '0041_')
        .map((file) => copyFile(join(migrations, file), join(before0041, file))),
    );
    await copyFile(
      join(migrations, '0041_channel_authorization_provider_validation.sql'),
      join(only0041, '0041_channel_authorization_provider_validation.sql'),
    );

    await runMigrations(migrationPool, before0041);
    await seedLegacyAuthorizations(superuserPool);
    await runMigrations(migrationPool, only0041);
  }, 180_000);

  afterAll(async () => {
    await migrationPool?.end();
    await superuserPool?.end();
    await container?.stop();
    if (temporaryRoot !== undefined) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('backfills ACTIVE and REVOKED rows under a NOBYPASSRLS migration owner', async () => {
    const role = await superuserPool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `SELECT rolbypassrls, rolsuper
       FROM pg_roles
       WHERE rolname = 'aeostudio_migration'`,
    );
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });

    const authorizations = await superuserPool.query<{
      id: string;
      status: string;
      validation_status: string;
      validated_at: Date | null;
      validation_failure_code: string | null;
    }>(
      `SELECT id, status, validation_status, validated_at, validation_failure_code
       FROM channel_authorizations
       WHERE id IN ($1, $2)
       ORDER BY id`,
      [activeAuthorizationId, revokedAuthorizationId],
    );
    expect(authorizations.rows).toEqual([
      {
        id: activeAuthorizationId,
        status: 'ACTIVE',
        validation_status: 'PENDING_VALIDATION',
        validated_at: null,
        validation_failure_code: null,
      },
      {
        id: revokedAuthorizationId,
        status: 'REVOKED',
        validation_status: 'INVALID',
        validated_at: new Date('2026-07-23T00:00:00.000Z'),
        validation_failure_code: 'AUTHORIZATION_REVOKED',
      },
    ]);

    const commands = await superuserPool.query<{
      authorization_id: string;
      status: string;
    }>(
      `SELECT authorization_id, status
       FROM channel_authorization_validation_commands
       ORDER BY authorization_id`,
    );
    expect(commands.rows).toEqual([{ authorization_id: activeAuthorizationId, status: 'PENDING' }]);

    const rls = await superuserPool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      owner_policy: boolean;
    }>(
      `SELECT relation.relrowsecurity,
              relation.relforcerowsecurity,
              EXISTS (
                SELECT 1
                FROM pg_policy policy
                WHERE policy.polrelid = relation.oid
                  AND policy.polname = 'aeostudio_migration_owner_all_tenants'
              ) AS owner_policy
       FROM pg_class relation
       WHERE relation.oid = 'channel_authorization_validation_commands'::regclass`,
    );
    expect(rls.rows[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
      owner_policy: true,
    });
  });

  test('reinstalls the immutable authorization guard after the transactional backfill', async () => {
    await expect(
      superuserPool.query(
        `UPDATE channel_authorizations
         SET target = 'fixture://upgrade/mutated'
         WHERE id = $1`,
        [activeAuthorizationId],
      ),
    ).rejects.toMatchObject({ code: 'P0001' });
  });

  test('preserves the lifecycle-scoped authorization delete guard after the upgrade', async () => {
    await superuserPool.query(
      `INSERT INTO deletion_requests
         (id, tenant_id, workspace_id, scope_kind, state, requested_by_user_id,
          requested_membership_id, requested_workspace_id, requested_subject_digest, reason,
          request_hash, requested_at, frozen_at, active_delete_by, backup_delete_by,
          secret_force_delete_by)
       VALUES ($1, $2, $3, 'WORKSPACE', 'FINALIZING', $4, $5, $3, $6,
         'Provider validation upgrade lifecycle deletion', $7, $8, $8,
         $8::timestamptz + interval '30 days',
         $8::timestamptz + interval '90 days',
         $8::timestamptz + interval '24 hours')`,
      [
        deletionRequestId,
        tenantId,
        workspaceId,
        userId,
        '00000000-0000-7000-8000-00000000b009',
        'a'.repeat(64),
        'b'.repeat(64),
        '2026-01-01T00:00:00.000Z',
      ],
    );
    const client = await superuserPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT
           set_config('app.lifecycle_request_id', $1, true),
           set_config('app.lifecycle_effective_at', $2, true)`,
        [deletionRequestId, '2026-02-01T00:00:00.000Z'],
      );
      await client.query(
        `DELETE FROM channel_authorization_validation_commands
         WHERE authorization_id = $1`,
        [activeAuthorizationId],
      );
      await expect(
        client.query(`DELETE FROM channel_authorizations WHERE id = $1`, [activeAuthorizationId]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
});

async function seedLegacyAuthorizations(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email)
     VALUES ($1, 'upgrade-owner@example.test')`,
    [userId],
  );
  await pool.query(
    `INSERT INTO tenants (id, name)
     VALUES ($1, 'Provider validation upgrade Tenant')`,
    [tenantId],
  );
  await pool.query(
    `INSERT INTO workspaces (id, tenant_id, name)
     VALUES ($1, $2, 'Provider validation upgrade Workspace')`,
    [workspaceId, tenantId],
  );
  await pool.query(
    `INSERT INTO channel_definitions
       (id, channel_key, display_name, status, unavailable_reason,
        package_transformer_key, package_schema_version)
     VALUES ($1, 'upgrade-provider-validation', 'Upgrade provider validation',
       'AVAILABLE', NULL, 'generic-web-package', '1.0.0')`,
    [channelId],
  );
  await pool.query(
    `INSERT INTO adapter_versions
       (id, channel_definition_id, adapter_key, adapter_version, enabled, disabled_reason,
        capabilities, required_scopes, terms_version, terms_status, processing_region,
        retention_policy, training_policy, subprocessors, rate_policy)
     VALUES ($1, $2, 'git-pull-request', '1.0.0', true, NULL,
       ARRAY['PUBLISH','RECONCILE'], ARRAY['contents:write'], 'upgrade-terms-v1', 'ALLOWED',
       'provider-controlled', 'provider-policy', 'no-training', '[]'::jsonb, '{}'::jsonb)`,
    [adapterVersionId, channelId],
  );
  await pool.query(
    `INSERT INTO channel_authorizations
       (id, tenant_id, workspace_id, adapter_version_id, status, secret_arn,
        granted_scopes, accepted_terms_version, target, expires_at,
        created_by_user_id, created_at, updated_at)
     VALUES
       ($1, $2, $3, $4, 'ACTIVE',
        'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:upgrade/active',
        ARRAY['contents:write'], 'upgrade-terms-v1', 'fixture://upgrade/active', NULL,
        $5, '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'),
       ($6, $2, $3, $4, 'REVOKED',
        'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:upgrade/revoked',
        ARRAY['contents:write'], 'upgrade-terms-v1', 'fixture://upgrade/revoked', NULL,
        $5, '2026-07-22T00:00:00.000Z', '2026-07-23T00:00:00.000Z')`,
    [
      activeAuthorizationId,
      tenantId,
      workspaceId,
      adapterVersionId,
      userId,
      revokedAuthorizationId,
    ],
  );
}
