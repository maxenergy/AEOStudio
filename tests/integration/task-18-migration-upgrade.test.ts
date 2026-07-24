import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgresTenancyStore, runMigrations } from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

describe('Task 18 forward migration upgrades existing managed-object authority', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let partialMigrationsDirectory: string;

  beforeAll(async () => {
    const migrationsDirectory = fileURLToPath(
      new URL('../../packages/db/migrations', import.meta.url),
    );
    partialMigrationsDirectory = await mkdtemp(
      join(tmpdir(), 'aeostudio-migrations-through-0030-'),
    );
    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((file) => /^\d+_[a-z0-9_]+\.sql$/iu.test(file))
      .filter((file) => file.localeCompare('0031_') < 0);
    await Promise.all(
      migrationFiles.map((file) =>
        copyFile(join(migrationsDirectory, file), join(partialMigrationsDirectory, basename(file))),
      ),
    );

    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
    await runMigrations(pool, partialMigrationsDirectory);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
    if (partialMigrationsDirectory !== undefined) {
      await rm(partialMigrationsDirectory, { recursive: true, force: true });
    }
  });

  test('backfills a canonical existing row and re-enables the lifecycle transition guard', async () => {
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const objectId = randomUUID();
    const objectKey = `tenants/${tenantId}/exports/${objectId}.bundle.json`;
    await new PostgresTenancyStore(pool).bootstrapTenant({
      actorSubject: 'task18-migration-upgrade-owner',
      actorEmail: 'task18-migration-upgrade-owner@example.test',
      userId: randomUUID(),
      tenantId,
      tenantName: 'Task18 Migration Upgrade Tenant',
      workspaceId,
      workspaceName: 'Task18 Migration Upgrade Workspace',
      membershipId: randomUUID(),
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    await pool.query(
      `INSERT INTO managed_object_versions (
         id, tenant_id, workspace_id, object_class, object_ref, object_key,
         object_version_id, checksum, content_type, byte_length,
         lifecycle_state, created_at
       ) VALUES (
         $1, $2, $3, 'TENANT_EXPORT', $4, $5, 'upgrade-version-1',
         $6, 'application/json', 128, 'ACTIVE', clock_timestamp()
       )`,
      [
        objectId,
        tenantId,
        workspaceId,
        `s3://tenant-exports/${objectKey}`,
        objectKey,
        'a'.repeat(64),
      ],
    );

    await expect(
      runMigrations(pool, fileURLToPath(new URL('../../packages/db/migrations', import.meta.url))),
    ).resolves.toBeUndefined();
    await expect(
      pool.query<{ storage_class: string }>(
        `SELECT storage_class
         FROM managed_object_versions
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, objectId],
      ),
    ).resolves.toMatchObject({ rows: [{ storage_class: 'TENANT_EXPORTS' }] });
    await expect(
      pool.query<{ tgenabled: string }>(
        `SELECT trigger_row.tgenabled
         FROM pg_trigger trigger_row
         JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'managed_object_versions'
           AND trigger_row.tgname = 'managed_object_lifecycle_transition_guard'`,
      ),
    ).resolves.toMatchObject({ rows: [{ tgenabled: 'O' }] });
  });
});
