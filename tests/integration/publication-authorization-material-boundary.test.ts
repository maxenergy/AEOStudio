import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  PostgresChannelAuthorizationStore,
  PostgresPublicationAuthorizationMaterialReader,
  runMigrations,
} from '@aeostudio/db';
import type { JobLease } from '@aeostudio/application/jobs-budgets';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

describe('Publication authorization material PostgreSQL boundary', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  const ids = {
    user: randomUUID(),
    tenant: randomUUID(),
    workspace: randomUUID(),
    foreignTenant: randomUUID(),
    foreignWorkspace: randomUUID(),
    channel: randomUUID(),
    adapter: randomUUID(),
    authorization: randomUUID(),
    publication: randomUUID(),
    job: randomUUID(),
    messageId: randomUUID(),
    leaseToken: randomUUID(),
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(
      pool,
      fileURLToPath(new URL('../../packages/db/migrations', import.meta.url)),
    );
    await seedAuthorization(pool, ids);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  test('runtime can read only non-sensitive authorization columns', async () => {
    const privileges = await pool.query<{
      table_select: boolean;
      id_select: boolean;
      secret_select: boolean;
      fingerprint_select: boolean;
    }>(
      `SELECT
         has_table_privilege(
           'aeostudio_runtime', 'public.channel_authorizations', 'SELECT'
         ) AS table_select,
         has_column_privilege(
           'aeostudio_runtime', 'public.channel_authorizations', 'id', 'SELECT'
         ) AS id_select,
         has_column_privilege(
           'aeostudio_runtime', 'public.channel_authorizations', 'secret_arn', 'SELECT'
         ) AS secret_select,
         has_column_privilege(
           'aeostudio_runtime',
           'public.channel_authorizations',
           'validation_credential_fingerprint',
           'SELECT'
         ) AS fingerprint_select`,
    );
    expect(privileges.rows[0]).toEqual({
      table_select: false,
      id_select: true,
      secret_select: false,
      fingerprint_select: false,
    });

    await expect(
      selectAsRuntime(pool, ids, 'SELECT id, status FROM channel_authorizations WHERE id = $1'),
    ).resolves.toEqual([{ id: ids.authorization, status: 'ACTIVE' }]);
    await expect(
      selectAsRuntime(pool, ids, 'SELECT secret_arn FROM channel_authorizations WHERE id = $1'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      selectAsRuntime(
        pool,
        ids,
        'SELECT validation_credential_fingerprint FROM channel_authorizations WHERE id = $1',
      ),
    ).rejects.toMatchObject({ code: '42501' });
  }, 120_000);

  test('only the lifecycle worker can read material for the exact live Publication lease', async () => {
    const privileges = await pool.query<{
      runtime_execute: boolean;
      lifecycle_execute: boolean;
    }>(
      `SELECT
         COALESCE(has_function_privilege(
           'aeostudio_runtime',
           to_regprocedure(
             'public.read_publication_authorization_material(uuid,uuid,uuid,uuid,uuid,uuid)'
           ),
           'EXECUTE'
         ), false) AS runtime_execute,
         COALESCE(has_function_privilege(
           'aeostudio_lifecycle_worker',
           to_regprocedure(
             'public.read_publication_authorization_material(uuid,uuid,uuid,uuid,uuid,uuid)'
           ),
           'EXECUTE'
         ), false) AS lifecycle_execute`,
    );
    expect(privileges.rows[0]).toEqual({
      runtime_execute: false,
      lifecycle_execute: true,
    });

    await expect(readMaterialAsRuntime(pool, ids)).rejects.toMatchObject({ code: '42501' });
    await expect(readMaterialAsLifecycle(pool, ids)).resolves.toEqual([
      {
        secret_reference:
          'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:publication-material',
        credential_fingerprint: 'f'.repeat(64),
      },
    ]);
    await expect(
      readMaterialAsLifecycle(pool, {
        ...ids,
        tenant: ids.foreignTenant,
        workspace: ids.foreignWorkspace,
      }),
    ).resolves.toEqual([]);
    await expect(
      readMaterialAsLifecycle(pool, { ...ids, leaseToken: randomUUID() }),
    ).resolves.toEqual([]);
    await expect(
      readMaterialAsLifecycle(pool, { ...ids, messageId: randomUUID() }),
    ).resolves.toEqual([]);
    await withReplicaMutation(
      pool,
      `UPDATE inbox_messages
       SET consumer = 'wrong-publication-consumer'
       WHERE message_id = $1`,
      `UPDATE inbox_messages
       SET consumer = 'publish-workload-v1'
       WHERE message_id = $1`,
      [ids.messageId],
      () => expect(readMaterialAsLifecycle(pool, ids)).resolves.toEqual([]),
    );
    await withReplicaMutation(
      pool,
      `UPDATE inbox_messages
       SET status = 'COMPLETED', completed_at = now()
       WHERE message_id = $1`,
      `UPDATE inbox_messages
       SET status = 'PROCESSING', completed_at = NULL
       WHERE message_id = $1`,
      [ids.messageId],
      () => expect(readMaterialAsLifecycle(pool, ids)).resolves.toEqual([]),
    );
    await withReplicaMutation(
      pool,
      `UPDATE channel_authorizations
       SET expires_at = now() - interval '1 second'
       WHERE id = $1`,
      `UPDATE channel_authorizations
       SET expires_at = now() + interval '1 day'
       WHERE id = $1`,
      [ids.authorization],
      () => expect(readMaterialAsLifecycle(pool, ids)).resolves.toEqual([]),
    );
    await withReplicaMutation(
      pool,
      `UPDATE channel_authorizations
       SET validated_at = now() - interval '2 hours',
           validation_valid_until = now() - interval '1 hour'
       WHERE id = $1`,
      `UPDATE channel_authorizations
       SET validated_at = now() - interval '1 minute',
           validation_valid_until = now() + interval '1 hour'
       WHERE id = $1`,
      [ids.authorization],
      () => expect(readMaterialAsLifecycle(pool, ids)).resolves.toEqual([]),
    );
    await withReplicaMutation(
      pool,
      `UPDATE channel_authorizations
       SET status = 'REVOKED',
           validation_status = 'INVALID',
           validation_actual_target = NULL,
           validation_actual_scopes = NULL,
           validation_terms_version = NULL,
           validation_credential_fingerprint = NULL,
           validated_at = now(),
           validation_valid_until = NULL,
           validation_failure_code = 'AUTHORIZATION_REVOKED'
       WHERE id = $1`,
      `UPDATE channel_authorizations
       SET status = 'ACTIVE',
           validation_status = 'VERIFIED',
           validation_actual_target = 'fixture://publication-material',
           validation_actual_scopes = ARRAY['content:write'],
           validation_terms_version = 'fixture-terms-v1',
           validation_credential_fingerprint = '${'f'.repeat(64)}',
           validated_at = now() - interval '1 minute',
           validation_valid_until = now() + interval '1 hour',
           validation_failure_code = NULL
       WHERE id = $1`,
      [ids.authorization],
      () => expect(readMaterialAsLifecycle(pool, ids)).resolves.toEqual([]),
    );
    await withReplicaMutation(
      pool,
      `UPDATE jobs SET status = 'QUEUED' WHERE id = $1`,
      `UPDATE jobs SET status = 'RUNNING' WHERE id = $1`,
      [ids.job],
      () => expect(readMaterialAsLifecycle(pool, ids)).resolves.toEqual([]),
    );
    await withReplicaMutation(
      pool,
      `UPDATE publication_records SET status = 'QUEUED' WHERE id = $1`,
      `UPDATE publication_records SET status = 'RUNNING' WHERE id = $1`,
      [ids.publication],
      () => expect(readMaterialAsLifecycle(pool, ids)).resolves.toEqual([]),
    );
  }, 120_000);

  test('the PostgreSQL reader maps only material authorized by the supplied JobLease', async () => {
    const reader = new PostgresPublicationAuthorizationMaterialReader(pool);
    const lease = materialLease(ids);

    await expect(reader.readForPublication({ lease })).resolves.toEqual({
      secretReference:
        'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:publication-material',
      credentialFingerprint: 'f'.repeat(64),
    });
    await expect(
      reader.readForPublication({
        lease: { ...lease, messageId: randomUUID() },
      }),
    ).resolves.toBeNull();
    await expect(
      reader.readForPublication({
        lease: { ...lease, leaseToken: randomUUID() },
      }),
    ).resolves.toBeNull();
  }, 120_000);

  test('runtime cannot author provider validation state during authorization creation', async () => {
    const forgedAuthorizationId = randomUUID();
    await expect(
      insertVerifiedAuthorizationAsRuntime(pool, ids, forgedAuthorizationId),
    ).rejects.toMatchObject({ code: '42501' });

    const privileges = await pool.query<{
      table_insert: boolean;
      id_insert: boolean;
      validation_columns_blocked: boolean;
    }>(
      `SELECT
         has_table_privilege(
           'aeostudio_runtime', 'public.channel_authorizations', 'INSERT'
         ) AS table_insert,
         has_column_privilege(
           'aeostudio_runtime', 'public.channel_authorizations', 'id', 'INSERT'
         ) AS id_insert,
         bool_and(
           NOT has_column_privilege(
             'aeostudio_runtime',
             'public.channel_authorizations',
             column_name,
             'INSERT'
           )
         ) AS validation_columns_blocked
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'channel_authorizations'
         AND (
           column_name = 'validated_at'
           OR column_name LIKE 'validation_%'
         )`,
    );
    expect(privileges.rows[0]).toEqual({
      table_insert: false,
      id_insert: true,
      validation_columns_blocked: true,
    });
  }, 120_000);

  test('runtime can still create, list, and revoke authorization metadata', async () => {
    const store = new PostgresChannelAuthorizationStore(pool);
    const authorizationId = randomUUID();
    const context = {
      tenantId: ids.tenant,
      workspaceId: ids.workspace,
      actorUserId: ids.user,
      membershipId: randomUUID(),
      role: 'OWNER' as const,
    };
    await expect(
      store.create({
        context,
        authorizationId,
        adapterVersionId: ids.adapter,
        target: 'fixture://publication-material/runtime-write',
        grantedScopes: ['content:write'],
        acceptedTermsVersion: 'fixture-terms-v1',
        secretArn:
          'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:publication-material-runtime',
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
        createdAt: new Date(),
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      id: authorizationId,
      status: 'ACTIVE',
      validationStatus: 'PENDING_VALIDATION',
      validationSnapshot: null,
      secretConfigured: true,
    });
    const listed = await store.list({ context });
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: authorizationId,
          status: 'ACTIVE',
          validationSnapshot: null,
          secretConfigured: true,
        }),
      ]),
    );
    expect(JSON.stringify(listed)).not.toContain('credentialFingerprint');
    await expect(
      store.revoke({
        context,
        authorizationId,
        revokedAt: new Date(),
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      id: authorizationId,
      status: 'REVOKED',
      validationStatus: 'INVALID',
      validationSnapshot: null,
    });
  }, 120_000);
});

async function selectAsRuntime(
  pool: Pool,
  ids: {
    user: string;
    tenant: string;
    workspace: string;
    authorization: string;
  },
  sql: string,
): Promise<unknown[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE aeostudio_runtime');
    await client.query(
      `SELECT
         set_config('app.tenant_id', $1, true),
         set_config('app.workspace_id', $2, true),
         set_config('app.actor_id', $3, true)`,
      [ids.tenant, ids.workspace, ids.user],
    );
    const result = await client.query(sql, [ids.authorization]);
    await client.query('COMMIT');
    return result.rows as unknown[];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedAuthorization(
  pool: Pool,
  ids: {
    user: string;
    tenant: string;
    workspace: string;
    foreignTenant: string;
    foreignWorkspace: string;
    channel: string;
    adapter: string;
    authorization: string;
    publication: string;
    job: string;
    messageId: string;
    leaseToken: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email)
     VALUES ($1, $2)`,
    [ids.user, `publication-material-${ids.user}@example.test`],
  );
  await pool.query(
    `INSERT INTO tenants (id, name)
     VALUES
       ($1, 'Publication material Tenant'),
       ($2, 'Foreign publication material Tenant')`,
    [ids.tenant, ids.foreignTenant],
  );
  await pool.query(
    `INSERT INTO workspaces (id, tenant_id, name)
     VALUES
       ($1, $2, 'Publication material Workspace'),
       ($3, $4, 'Foreign publication material Workspace')`,
    [ids.workspace, ids.tenant, ids.foreignWorkspace, ids.foreignTenant],
  );
  await pool.query(
    `INSERT INTO channel_definitions
       (id, channel_key, display_name, status, unavailable_reason,
        package_transformer_key, package_schema_version)
     VALUES ($1, $2, 'Publication material Channel', 'AVAILABLE', NULL,
       'generic-web-package', '1.0.0')`,
    [ids.channel, `publication-material-${ids.channel}`],
  );
  await pool.query(
    `INSERT INTO adapter_versions
       (id, channel_definition_id, adapter_key, adapter_version, enabled, disabled_reason,
        capabilities, required_scopes, terms_version, terms_status, processing_region,
        retention_policy, training_policy, subprocessors, rate_policy)
     VALUES ($1, $2, 'publication-material-fixture', '1.0.0', true, NULL,
       ARRAY['PUBLISH','RECONCILE'], ARRAY['content:write'], 'fixture-terms-v1', 'ALLOWED',
       'Singapore', 'ephemeral', 'not-used-for-training', '[]'::jsonb, '{}'::jsonb)`,
    [ids.adapter, ids.channel],
  );
  await pool.query(
    `INSERT INTO channel_authorizations
       (id, tenant_id, workspace_id, adapter_version_id, status, secret_arn,
        granted_scopes, accepted_terms_version, target, expires_at,
        validation_status, validation_actual_target, validation_actual_scopes,
        validation_terms_version, validation_credential_fingerprint, validated_at,
        validation_valid_until, validation_failure_code, created_by_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', $5, ARRAY['content:write'], 'fixture-terms-v1',
       'fixture://publication-material', now() + interval '1 day',
       'VERIFIED', 'fixture://publication-material', ARRAY['content:write'],
       'fixture-terms-v1', $6, now() - interval '1 minute', now() + interval '1 hour',
       NULL, $7, now(), now())`,
    [
      ids.authorization,
      ids.tenant,
      ids.workspace,
      ids.adapter,
      'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:publication-material',
      'f'.repeat(64),
      ids.user,
    ],
  );
  await pool.query(
    `INSERT INTO jobs
       (id, tenant_id, workspace_id, job_type, aggregate_id, status, progress, attempt,
        max_attempts, idempotency_key, estimated_units, requested_by_user_id, lease_token,
        lease_expires_at, heartbeat_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'PUBLICATION', $4, 'RUNNING', 10, 1, 3, $5, 1, $6, $7,
       now() + interval '10 minutes', now(), now(), now())`,
    [
      ids.job,
      ids.tenant,
      ids.workspace,
      ids.publication,
      `publication-material-${ids.publication}`,
      ids.user,
      ids.leaseToken,
    ],
  );
  await pool.query(
    `INSERT INTO outbox_messages
       (id, tenant_id, workspace_id, aggregate_id, message_type, payload, published_at, created_at)
     VALUES ($1, $2, $3, $4, 'JOB_QUEUED', $5::jsonb, now(), now())`,
    [
      ids.messageId,
      ids.tenant,
      ids.workspace,
      ids.job,
      JSON.stringify({
        jobId: ids.job,
        tenantId: ids.tenant,
        workspaceId: ids.workspace,
        schemaVersion: '1.0.0',
      }),
    ],
  );
  await pool.query(
    `INSERT INTO inbox_messages
       (id, tenant_id, workspace_id, consumer, message_id, status, received_at)
     VALUES ($1, $2, $3, 'publish-workload-v1', $4, 'PROCESSING', now())`,
    [randomUUID(), ids.tenant, ids.workspace, ids.messageId],
  );
  const client = await pool.connect();
  try {
    await client.query(`SET session_replication_role = 'replica'`);
    await client.query(
      `INSERT INTO publication_records
         (id, tenant_id, workspace_id, channel_package_id, package_checksum,
           artifact_revision_id, artifact_content_hash, adapter_version_id,
           channel_authorization_id, target, authorization_target, idempotency_key, request_hash,
           status, job_id, remote_ref, requested_by_user_id, created_at, updated_at,
           required_scopes_snapshot)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
          'fixture://publication-material', 'fixture://publication-material', $10, $11,
          'RUNNING', $12, NULL, $13, now(), now(), ARRAY['content:write'])`,
      [
        ids.publication,
        ids.tenant,
        ids.workspace,
        randomUUID(),
        'a'.repeat(64),
        randomUUID(),
        'b'.repeat(64),
        ids.adapter,
        ids.authorization,
        `publication-material-${ids.publication}`,
        'c'.repeat(64),
        ids.job,
        ids.user,
      ],
    );
  } finally {
    await client.query(`SET session_replication_role = 'origin'`);
    client.release();
  }
}

type MaterialIds = {
  tenant: string;
  workspace: string;
  publication: string;
  job: string;
  messageId: string;
  leaseToken: string;
};

async function readMaterialAsRuntime(pool: Pool, ids: MaterialIds): Promise<unknown[]> {
  return readMaterialAsRole(pool, 'aeostudio_runtime', ids);
}

async function readMaterialAsLifecycle(pool: Pool, ids: MaterialIds): Promise<unknown[]> {
  return readMaterialAsRole(pool, 'aeostudio_lifecycle_worker', ids);
}

async function readMaterialAsRole(
  pool: Pool,
  role: 'aeostudio_runtime' | 'aeostudio_lifecycle_worker',
  ids: MaterialIds,
): Promise<unknown[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await client.query(
      `SELECT secret_reference, credential_fingerprint
       FROM read_publication_authorization_material($1, $2, $3, $4, $5, $6)`,
      [ids.tenant, ids.workspace, ids.publication, ids.job, ids.messageId, ids.leaseToken],
    );
    await client.query('COMMIT');
    return result.rows as unknown[];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function materialLease(ids: MaterialIds): JobLease {
  return {
    job: {
      id: ids.job,
      tenantId: ids.tenant,
      workspaceId: ids.workspace,
      providerKey: null,
      jobType: 'PUBLICATION',
      aggregateId: ids.publication,
      status: 'RUNNING',
      progress: 10,
      attempt: 1,
      maxAttempts: 3,
      budgetWarning: false,
      estimatedUnits: 1,
      heartbeatAt: new Date().toISOString(),
      result: null,
      errorCode: null,
    },
    leaseToken: ids.leaseToken,
    messageId: ids.messageId,
  };
}

async function insertVerifiedAuthorizationAsRuntime(
  pool: Pool,
  ids: {
    user: string;
    tenant: string;
    workspace: string;
    adapter: string;
  },
  authorizationId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE aeostudio_runtime');
    await client.query(
      `SELECT
         set_config('app.tenant_id', $1, true),
         set_config('app.workspace_id', $2, true),
         set_config('app.actor_id', $3, true)`,
      [ids.tenant, ids.workspace, ids.user],
    );
    await client.query(
      `INSERT INTO channel_authorizations
         (id, tenant_id, workspace_id, adapter_version_id, status, secret_arn,
          granted_scopes, accepted_terms_version, target, expires_at,
          validation_status, validation_actual_target, validation_actual_scopes,
          validation_terms_version, validation_credential_fingerprint, validated_at,
          validation_valid_until, validation_failure_code, created_by_user_id, created_at,
          updated_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', $5, ARRAY['content:write'], 'fixture-terms-v1',
         'fixture://publication-material/forged', now() + interval '1 day',
         'VERIFIED', 'fixture://publication-material/forged', ARRAY['content:write'],
         'fixture-terms-v1', $6, now(), now() + interval '1 hour', NULL, $7, now(), now())`,
      [
        authorizationId,
        ids.tenant,
        ids.workspace,
        ids.adapter,
        'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:forged-validation',
        'e'.repeat(64),
        ids.user,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function withReplicaMutation(
  pool: Pool,
  applySql: string,
  restoreSql: string,
  values: unknown[],
  assertion: () => PromiseLike<unknown>,
): Promise<void> {
  const client = await pool.connect();
  let applied = false;
  try {
    await client.query(`SET session_replication_role = 'replica'`);
    await client.query(applySql, values);
    applied = true;
    await client.query(`SET session_replication_role = 'origin'`);
    await assertion();
  } finally {
    if (applied) {
      await client.query(`SET session_replication_role = 'replica'`);
      await client.query(restoreSql, values);
    }
    await client.query(`SET session_replication_role = 'origin'`);
    client.release();
  }
}
