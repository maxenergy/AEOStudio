import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  PostgresTenancyStore,
  PostgresPrivacyAuditStore,
  PostgresWorkloadObjectWriteIntentStore,
  runMigrations,
} from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

describe('Task 18 workload object privacy ledger', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: PostgresWorkloadObjectWriteIntentStore;
  let privacyStore: PostgresPrivacyAuditStore;
  let tenantId: string;
  let workspaceId: string;
  let siblingWorkspaceId: string;
  let ownerUserId: string;
  let membershipId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(
      pool,
      fileURLToPath(new URL('../../packages/db/migrations', import.meta.url)),
    );
    tenantId = randomUUID();
    workspaceId = randomUUID();
    ownerUserId = randomUUID();
    membershipId = randomUUID();
    const scope = await new PostgresTenancyStore(pool).bootstrapTenant({
      actorSubject: 'task18-workload-owner',
      actorEmail: 'task18-workload-owner@example.test',
      userId: ownerUserId,
      tenantId,
      tenantName: 'Task18 Workload Tenant',
      workspaceId,
      workspaceName: 'Task18 Workload Workspace',
      membershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    ownerUserId = scope.membership.userId;
    siblingWorkspaceId = randomUUID();
    await pool.query(
      `INSERT INTO workspaces (id, tenant_id, name, created_at)
       VALUES ($1, $2, 'Task18 Sibling Workspace', clock_timestamp())`,
      [siblingWorkspaceId, tenantId],
    );
    store = new PostgresWorkloadObjectWriteIntentStore(pool);
    privacyStore = new PostgresPrivacyAuditStore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  test('persists intent before S3 and CAS-registers the exact Artifact VersionId', async () => {
    const operationId = randomUUID();
    const leaseToken = randomUUID();
    const body = new TextEncoder().encode('{"title":"durable"}');
    const checksum = createHash('sha256').update(body).digest('hex');
    const objectKey =
      `tenants/${tenantId}/workspaces/${workspaceId}/artifacts/${randomUUID()}/` +
      `revisions/1/${'a'.repeat(64)}.json`;
    const prepared = {
      operationId,
      kind: 'ARTIFACT_PAYLOAD' as const,
      tenantId,
      workspaceId,
      objectKey,
      checksum,
      contentType: 'application/json',
      byteLength: body.byteLength,
    };

    await expect(store.reserveWorkloadObjectWriteIntent(prepared)).resolves.toEqual({
      outcome: 'PENDING',
      operationId,
    });
    await expect(
      pool.query(
        `SELECT status, object_version_id FROM workload_object_write_intents WHERE operation_id = $1`,
        [operationId],
      ),
    ).resolves.toMatchObject({ rows: [{ status: 'PENDING', object_version_id: null }] });

    await expect(
      store.claimWorkloadObjectWriteIntent({ operationId, tenantId, leaseToken }),
    ).resolves.toBe(true);
    await expect(
      store.completeWorkloadObjectWriteIntent({
        operationId,
        leaseToken,
        object: {
          kind: 'ARTIFACT_PAYLOAD',
          objectClass: 'ARTIFACT_PAYLOAD',
          tenantId,
          workspaceId,
          objectRef: `s3://artifacts/${objectKey}?versionId=artifact-v1`,
          objectKey,
          objectVersionId: 'artifact-v1',
          checksum,
          contentType: 'application/json',
          byteLength: body.byteLength,
          createdAt: '2026-07-22T12:00:00.000Z',
        },
      }),
    ).resolves.toBe(true);

    await expect(
      pool.query(
        `SELECT intent.status, intent.object_version_id, object.object_class,
                object.workspace_id, object.expires_at - object.created_at AS retention
         FROM workload_object_write_intents intent
         JOIN managed_object_versions object ON object.id = intent.operation_id
         WHERE intent.operation_id = $1`,
        [operationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          status: 'READY',
          object_version_id: 'artifact-v1',
          object_class: 'ARTIFACT_PAYLOAD',
          workspace_id: workspaceId,
          retention: { days: 30 },
        },
      ],
    });
  });

  test('checkpoints every page, waits for active Put leases, and never crosses Workspace scope', async () => {
    const operationId = randomUUID();
    const uploadLease = randomUUID();
    const snapshotChecksum = 'b'.repeat(64);
    const snapshotKey =
      `tenants/${tenantId}/workspaces/${workspaceId}/sites/${randomUUID()}/snapshots/` +
      snapshotChecksum;
    await store.reserveWorkloadObjectWriteIntent({
      operationId,
      kind: 'CRAWL_SNAPSHOT',
      tenantId,
      workspaceId,
      objectKey: snapshotKey,
      checksum: snapshotChecksum,
      contentType: 'text/html',
      byteLength: 512,
    });
    await expect(
      store.claimWorkloadObjectWriteIntent({
        operationId,
        tenantId,
        leaseToken: uploadLease,
      }),
    ).resolves.toBe(true);

    const requestId = randomUUID();
    const deletionLease = randomUUID();
    await insertWorkspaceDeletion({ requestId, deletionLease });
    await expect(
      privacyStore.getDeletionObjectInventoryPageTarget({ requestId, leaseToken: deletionLease }),
    ).resolves.toEqual({ outcome: 'PENDING_WRITES' });

    await pool.query(
      `UPDATE workload_object_write_intents
       SET work_lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE operation_id = $1`,
      [operationId],
    );
    await expect(
      privacyStore.getDeletionObjectInventoryPageTarget({ requestId, leaseToken: deletionLease }),
    ).resolves.toMatchObject({
      outcome: 'REQUIRED',
      target: { bucket: 'TENANT_EXPORTS', cursor: null, workspaceId },
    });

    await expect(
      privacyStore.recordDeletionObjectInventoryPage({
        requestId,
        leaseToken: deletionLease,
        bucket: 'TENANT_EXPORTS',
        cursor: null,
        nextCursor: 'export-page-2',
        versions: [],
      }),
    ).resolves.toEqual({ outcome: 'PROGRESS' });
    await expect(
      privacyStore.getDeletionObjectInventoryPageTarget({ requestId, leaseToken: deletionLease }),
    ).resolves.toMatchObject({
      outcome: 'REQUIRED',
      target: { bucket: 'TENANT_EXPORTS', cursor: 'export-page-2' },
    });
    await privacyStore.recordDeletionObjectInventoryPage({
      requestId,
      leaseToken: deletionLease,
      bucket: 'TENANT_EXPORTS',
      cursor: 'export-page-2',
      nextCursor: null,
      versions: [],
    });

    const auditKey = `tenants/${tenantId}/audit-digests/legacy.json`;
    const auditMarkerKey = `tenants/${tenantId}/audit-digests/deleted-legacy.json`;
    await privacyStore.recordDeletionObjectInventoryPage({
      requestId,
      leaseToken: deletionLease,
      bucket: 'AUDIT_EVIDENCE',
      cursor: null,
      nextCursor: null,
      versions: [
        { objectKey: auditKey, objectVersionId: 'audit-retained-v1' },
        {
          objectKey: auditMarkerKey,
          objectVersionId: 'audit-delete-marker-v1',
          isDeleteMarker: true,
          createdAt: '2026-07-22T12:00:00.000Z',
        },
      ],
    });
    await expect(
      privacyStore.getDeletionObjectInventoryPageTarget({ requestId, leaseToken: deletionLease }),
    ).resolves.toEqual({ outcome: 'DRAINING_WRITES' });
    await pool.query(
      `UPDATE privacy_object_inventory_page_progress
       SET workload_fenced_at = clock_timestamp() - interval '31 seconds'
       WHERE deletion_request_id = $1`,
      [requestId],
    );
    await expect(
      privacyStore.getDeletionObjectInventoryPageTarget({ requestId, leaseToken: deletionLease }),
    ).resolves.toMatchObject({ outcome: 'REQUIRED', target: { bucket: 'WORKLOAD_OBJECTS' } });

    const unknownKey = `tenants/${tenantId}/workspaces/${workspaceId}/unknown/vendor-object.bin`;
    const deleteMarkerKey = `tenants/${tenantId}/workspaces/${workspaceId}/unknown/deleted-vendor-object.bin`;
    const siblingKey = `tenants/${tenantId}/workspaces/${siblingWorkspaceId}/unknown/must-not-delete.bin`;
    await expect(
      privacyStore.recordDeletionObjectInventoryPage({
        requestId,
        leaseToken: deletionLease,
        bucket: 'WORKLOAD_OBJECTS',
        cursor: null,
        nextCursor: null,
        versions: [
          {
            objectKey: siblingKey,
            objectVersionId: 'sibling-v1',
            workspaceId: siblingWorkspaceId,
          },
        ],
      }),
    ).rejects.toThrow('PRIVACY_OBJECT_INVENTORY_SCOPE_MISMATCH');
    await expect(
      privacyStore.recordDeletionObjectInventoryPage({
        requestId,
        leaseToken: deletionLease,
        bucket: 'WORKLOAD_OBJECTS',
        cursor: null,
        nextCursor: null,
        versions: [
          { objectKey: unknownKey, objectVersionId: 'unknown-v1', workspaceId },
          {
            objectKey: deleteMarkerKey,
            objectVersionId: 'delete-marker-v1',
            workspaceId,
            isDeleteMarker: true,
            createdAt: '2026-07-22T12:00:00.000Z',
          },
          {
            objectKey: snapshotKey,
            objectVersionId: 'snapshot-v1',
            workspaceId,
            checksum: snapshotChecksum,
            contentType: 'text/html',
            byteLength: 512,
            createdAt: '2026-07-22T12:00:00.000Z',
          },
        ],
      }),
    ).resolves.toEqual({ outcome: 'COMPLETE' });

    const managed = await pool.query<{
      object_key: string;
      object_version_id: string;
      object_class: string;
      checksum: string | null;
      is_delete_marker: boolean;
    }>(
      `SELECT object_key, object_version_id, object_class, checksum, is_delete_marker
       FROM managed_object_versions
       WHERE tenant_id = $1 AND object_key IN ($2, $3, $4)
       ORDER BY object_key`,
      [tenantId, unknownKey, snapshotKey, deleteMarkerKey],
    );
    expect(managed.rows).toContainEqual({
      object_key: deleteMarkerKey,
      object_version_id: 'delete-marker-v1',
      object_class: 'ACTIVE_TENANT_DATA',
      checksum: null,
      is_delete_marker: true,
    });
    expect(managed.rows).toContainEqual({
      object_key: unknownKey,
      object_version_id: 'unknown-v1',
      object_class: 'ACTIVE_TENANT_DATA',
      checksum: null,
      is_delete_marker: false,
    });
    expect(managed.rows).toContainEqual({
      object_key: snapshotKey,
      object_version_id: 'snapshot-v1',
      object_class: 'CRAWL_SNAPSHOT',
      checksum: snapshotChecksum,
      is_delete_marker: false,
    });
    const orphans = await pool.query<{
      bucket_kind: string;
      object_key: string;
      disposition: string;
    }>(
      `SELECT bucket_kind, object_key, disposition FROM privacy_orphan_object_versions
       WHERE deletion_request_id = $1 ORDER BY bucket_kind`,
      [requestId],
    );
    expect(orphans.rows).toContainEqual({
      bucket_kind: 'AUDIT_EVIDENCE',
      object_key: auditKey,
      disposition: 'RETAINED_AUDIT',
    });
    expect(orphans.rows).toContainEqual({
      bucket_kind: 'AUDIT_EVIDENCE',
      object_key: auditMarkerKey,
      disposition: 'RETAINED_AUDIT',
    });
    expect(
      orphans.rows.some(
        (row) => row.bucket_kind === 'WORKLOAD_OBJECTS' && row.disposition === 'DELETE_REQUIRED',
      ),
    ).toBe(true);
    await expect(
      pool.query(`SELECT status FROM workload_object_write_intents WHERE operation_id = $1`, [
        operationId,
      ]),
    ).resolves.toMatchObject({ rows: [{ status: 'CANCELLED' }] });
  });

  test('rejects kind/prefix mismatches and any write reserved after Workspace freeze', async () => {
    const mismatchedKey =
      `tenants/${tenantId}/workspaces/${siblingWorkspaceId}/artifacts/${randomUUID()}/` +
      `revisions/1/${'c'.repeat(64)}.json`;
    await expect(
      store.reserveWorkloadObjectWriteIntent({
        operationId: randomUUID(),
        kind: 'CHANNEL_PACKAGE',
        tenantId,
        workspaceId: siblingWorkspaceId,
        objectKey: mismatchedKey,
        checksum: 'd'.repeat(64),
        contentType: 'application/json',
        byteLength: 12,
      }),
    ).rejects.toThrow('WORKLOAD_OBJECT_WRITE_PREFIX_INVALID');

    const validKey =
      `tenants/${tenantId}/workspaces/${siblingWorkspaceId}/channel-packages/` +
      `${'d'.repeat(64)}.json`;
    const pendingOperationId = randomUUID();
    await store.reserveWorkloadObjectWriteIntent({
      operationId: pendingOperationId,
      kind: 'CHANNEL_PACKAGE',
      tenantId,
      workspaceId: siblingWorkspaceId,
      objectKey: validKey,
      checksum: 'd'.repeat(64),
      contentType: 'application/json',
      byteLength: 12,
    });
    const reusableLeaseToken = randomUUID();
    await expect(
      store.claimWorkloadObjectWriteIntent({
        operationId: pendingOperationId,
        tenantId,
        leaseToken: reusableLeaseToken,
      }),
    ).resolves.toBe(true);
    await pool.query(
      `UPDATE workload_object_write_intents
       SET work_lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE operation_id = $1`,
      [pendingOperationId],
    );
    await insertWorkspaceDeletion({
      requestId: randomUUID(),
      deletionLease: randomUUID(),
      targetWorkspaceId: siblingWorkspaceId,
    });
    await expect(
      store.claimWorkloadObjectWriteIntent({
        operationId: pendingOperationId,
        tenantId,
        leaseToken: reusableLeaseToken,
      }),
    ).resolves.toBe(false);
    await expect(
      store.claimWorkloadObjectWriteIntent({
        operationId: pendingOperationId,
        tenantId,
        leaseToken: randomUUID(),
      }),
    ).resolves.toBe(false);
    const frozenKey =
      `tenants/${tenantId}/workspaces/${siblingWorkspaceId}/channel-packages/` +
      `${'e'.repeat(64)}.json`;
    await expect(
      store.reserveWorkloadObjectWriteIntent({
        operationId: randomUUID(),
        kind: 'CHANNEL_PACKAGE',
        tenantId,
        workspaceId: siblingWorkspaceId,
        objectKey: frozenKey,
        checksum: 'e'.repeat(64),
        contentType: 'application/json',
        byteLength: 12,
      }),
    ).rejects.toThrow('WORKLOAD_OBJECT_WRITE_SCOPE_FROZEN');
  });

  test('serializes every workload claim with a concurrent deletion freeze on the Tenant row', async () => {
    const targetWorkspaceId = await createWorkspace('Task18 Claim Freeze Race');
    const operationId = randomUUID();
    const leaseToken = randomUUID();
    const checksum = 'f'.repeat(64);
    const objectKey =
      `tenants/${tenantId}/workspaces/${targetWorkspaceId}/channel-packages/` + `${checksum}.json`;
    await store.reserveWorkloadObjectWriteIntent({
      operationId,
      kind: 'CHANNEL_PACKAGE',
      tenantId,
      workspaceId: targetWorkspaceId,
      objectKey,
      checksum,
      contentType: 'application/json',
      byteLength: 12,
    });

    const claimingClient = await pool.connect();
    try {
      await claimingClient.query('BEGIN');
      await expect(
        claimingClient.query('SELECT claim_workload_object_write_intent($1, $2, $3) AS claimed', [
          operationId,
          tenantId,
          leaseToken,
        ]),
      ).resolves.toMatchObject({ rows: [{ claimed: true }] });

      const deletion = requestWorkspaceDeletion(targetWorkspaceId);
      await expect(
        Promise.race([
          deletion.then(() => 'FREEZE_COMMITTED' as const),
          new Promise<'CLAIM_LOCK_HELD'>((resolve) => {
            setTimeout(() => resolve('CLAIM_LOCK_HELD'), 150);
          }),
        ]),
      ).resolves.toBe('CLAIM_LOCK_HELD');

      await claimingClient.query('COMMIT');
      await expect(deletion).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
    } finally {
      try {
        await claimingClient.query('ROLLBACK');
      } finally {
        claimingClient.release();
      }
    }
  });

  test('serializes batch outbox claims with a concurrent deletion freeze on the Tenant row', async () => {
    const targetWorkspaceId = await createWorkspace('Task18 Batch Claim Freeze Race');
    const operationId = randomUUID();
    const checksum = '1'.repeat(64);
    await store.reserveWorkloadObjectWriteIntent({
      operationId,
      kind: 'CHANNEL_PACKAGE',
      tenantId,
      workspaceId: targetWorkspaceId,
      objectKey:
        `tenants/${tenantId}/workspaces/${targetWorkspaceId}/channel-packages/` +
        `${checksum}.json`,
      checksum,
      contentType: 'application/json',
      byteLength: 12,
    });

    const claimingClient = await pool.connect();
    try {
      await claimingClient.query('BEGIN');
      await expect(
        claimingClient.query(
          `SELECT operation_id
           FROM claim_pending_workload_object_write_intents($1, 1)`,
          [randomUUID()],
        ),
      ).resolves.toMatchObject({ rows: [{ operation_id: operationId }] });

      const deletion = requestWorkspaceDeletion(targetWorkspaceId);
      await expect(
        Promise.race([
          deletion.then(() => 'FREEZE_COMMITTED' as const),
          new Promise<'CLAIM_LOCK_HELD'>((resolve) => {
            setTimeout(() => resolve('CLAIM_LOCK_HELD'), 150);
          }),
        ]),
      ).resolves.toBe('CLAIM_LOCK_HELD');

      await claimingClient.query('COMMIT');
      await expect(deletion).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
    } finally {
      try {
        await claimingClient.query('ROLLBACK');
      } finally {
        claimingClient.release();
      }
    }
  });

  test('persists a workload write fence and drains expired Put attempts before workload inventory', async () => {
    const targetWorkspaceId = await createWorkspace('Task18 Late Put Drain');
    const operationId = randomUUID();
    const checksum = '2'.repeat(64);
    const objectKey =
      `tenants/${tenantId}/workspaces/${targetWorkspaceId}/channel-packages/` + `${checksum}.json`;
    await store.reserveWorkloadObjectWriteIntent({
      operationId,
      kind: 'CHANNEL_PACKAGE',
      tenantId,
      workspaceId: targetWorkspaceId,
      objectKey,
      checksum,
      contentType: 'application/json',
      byteLength: 12,
    });
    await store.claimWorkloadObjectWriteIntent({
      operationId,
      tenantId,
      leaseToken: randomUUID(),
    });
    await pool.query(
      `UPDATE workload_object_write_intents
       SET work_lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE operation_id = $1`,
      [operationId],
    );

    const requestId = randomUUID();
    const deletionLease = randomUUID();
    await insertWorkspaceDeletion({
      requestId,
      deletionLease,
      targetWorkspaceId,
    });
    await privacyStore.getDeletionObjectInventoryPageTarget({
      requestId,
      leaseToken: deletionLease,
    });
    await privacyStore.recordDeletionObjectInventoryPage({
      requestId,
      leaseToken: deletionLease,
      bucket: 'TENANT_EXPORTS',
      cursor: null,
      nextCursor: null,
      versions: [],
    });
    await privacyStore.recordDeletionObjectInventoryPage({
      requestId,
      leaseToken: deletionLease,
      bucket: 'AUDIT_EVIDENCE',
      cursor: null,
      nextCursor: null,
      versions: [],
    });

    await expect(
      privacyStore.getDeletionObjectInventoryPageTarget({ requestId, leaseToken: deletionLease }),
    ).resolves.toEqual({ outcome: 'DRAINING_WRITES' });
    await expect(
      pool.query(
        `SELECT status, work_lease_token, work_lease_expires_at
         FROM workload_object_write_intents WHERE operation_id = $1`,
        [operationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ status: 'CANCELLED', work_lease_token: null, work_lease_expires_at: null }],
    });
    const fence = await pool.query<{ workload_fenced_at: Date | null }>(
      `SELECT workload_fenced_at FROM privacy_object_inventory_page_progress
       WHERE deletion_request_id = $1`,
      [requestId],
    );
    expect(fence.rows[0]?.workload_fenced_at).toBeInstanceOf(Date);

    await pool.query(
      `UPDATE privacy_object_inventory_page_progress
       SET workload_fenced_at = clock_timestamp() - interval '31 seconds'
       WHERE deletion_request_id = $1`,
      [requestId],
    );
    await expect(
      privacyStore.getDeletionObjectInventoryPageTarget({ requestId, leaseToken: deletionLease }),
    ).resolves.toMatchObject({
      outcome: 'REQUIRED',
      target: { bucket: 'WORKLOAD_OBJECTS', cursor: null, workspaceId: targetWorkspaceId },
    });
    // Materialize the state that the original claim/freeze race could commit
    // after the first drain decision. The final-page transaction must fence it
    // and require a fresh drain instead of publishing COMPLETE.
    await pool.query(
      `UPDATE workload_object_write_intents
       SET status = 'PENDING', last_error = NULL
       WHERE operation_id = $1`,
      [operationId],
    );
    await expect(
      privacyStore.recordDeletionObjectInventoryPage({
        requestId,
        leaseToken: deletionLease,
        bucket: 'WORKLOAD_OBJECTS',
        cursor: null,
        nextCursor: null,
        versions: [],
      }),
    ).resolves.toEqual({ outcome: 'DRAINING_WRITES' });
    await expect(
      pool.query(
        `SELECT workload_complete, completed_at
         FROM privacy_object_inventory_page_progress
         WHERE deletion_request_id = $1`,
        [requestId],
      ),
    ).resolves.toMatchObject({
      rows: [{ workload_complete: false, completed_at: null }],
    });
    await pool.query(
      `UPDATE privacy_object_inventory_page_progress
       SET workload_fenced_at = clock_timestamp() - interval '31 seconds'
       WHERE deletion_request_id = $1`,
      [requestId],
    );
    await expect(
      privacyStore.getDeletionObjectInventoryPageTarget({ requestId, leaseToken: deletionLease }),
    ).resolves.toMatchObject({ outcome: 'REQUIRED', target: { bucket: 'WORKLOAD_OBJECTS' } });
    await expect(
      privacyStore.recordDeletionObjectInventoryPage({
        requestId,
        leaseToken: deletionLease,
        bucket: 'WORKLOAD_OBJECTS',
        cursor: null,
        nextCursor: null,
        versions: [{ objectKey, objectVersionId: 'late-put-v1', workspaceId: targetWorkspaceId }],
      }),
    ).resolves.toEqual({ outcome: 'COMPLETE' });
  });

  test('rejects a persisted A to B to A inventory cursor cycle', async () => {
    const targetWorkspaceId = await createWorkspace('Task18 Cursor Cycle');
    await pool.query(
      `INSERT INTO privacy_object_inventory_requirements (scope_tenant_id, required_at)
       VALUES ($1, clock_timestamp()) ON CONFLICT (scope_tenant_id) DO NOTHING`,
      [tenantId],
    );
    const requestId = randomUUID();
    const deletionLease = randomUUID();
    await insertWorkspaceDeletion({ requestId, deletionLease, targetWorkspaceId });
    await expect(
      privacyStore.getDeletionObjectInventoryPageTarget({ requestId, leaseToken: deletionLease }),
    ).resolves.toMatchObject({ outcome: 'REQUIRED', target: { cursor: null } });
    await expect(
      privacyStore.recordDeletionObjectInventoryPage({
        requestId,
        leaseToken: deletionLease,
        bucket: 'TENANT_EXPORTS',
        cursor: null,
        nextCursor: 'cursor-a',
        versions: [],
      }),
    ).resolves.toEqual({ outcome: 'PROGRESS' });
    await expect(
      privacyStore.recordDeletionObjectInventoryPage({
        requestId,
        leaseToken: deletionLease,
        bucket: 'TENANT_EXPORTS',
        cursor: 'cursor-a',
        nextCursor: 'cursor-b',
        versions: [],
      }),
    ).resolves.toEqual({ outcome: 'PROGRESS' });
    await expect(
      privacyStore.recordDeletionObjectInventoryPage({
        requestId,
        leaseToken: deletionLease,
        bucket: 'TENANT_EXPORTS',
        cursor: 'cursor-b',
        nextCursor: 'cursor-a',
        versions: [],
      }),
    ).rejects.toThrow('PRIVACY_OBJECT_INVENTORY_CURSOR_CYCLE');
  });

  test('backs off an absent-object batch recovery without delaying a direct request retry', async () => {
    const targetWorkspaceId = await createWorkspace('Task18 Recovery Backoff');
    const operationId = randomUUID();
    const checksum = '3'.repeat(64);
    await store.reserveWorkloadObjectWriteIntent({
      operationId,
      kind: 'CHANNEL_PACKAGE',
      tenantId,
      workspaceId: targetWorkspaceId,
      objectKey:
        `tenants/${tenantId}/workspaces/${targetWorkspaceId}/channel-packages/` +
        `${checksum}.json`,
      checksum,
      contentType: 'application/json',
      byteLength: 12,
    });
    const recoveryLease = randomUUID();
    await expect(
      store.claimPendingWorkloadObjectWriteIntents({ leaseToken: recoveryLease, limit: 10 }),
    ).resolves.toMatchObject([{ operationId, leaseToken: recoveryLease }]);
    await expect(
      store.releaseWorkloadObjectWriteIntentLease({
        operationId,
        leaseToken: recoveryLease,
        retryDelayMs: 30_000,
      }),
    ).resolves.toBe(true);
    await expect(
      store.claimPendingWorkloadObjectWriteIntents({ leaseToken: randomUUID(), limit: 10 }),
    ).resolves.toEqual([]);

    // The foreground request still owns the deterministic payload bytes and
    // may retry immediately; only the metadata-only background poll is delayed.
    await expect(
      store.claimWorkloadObjectWriteIntent({
        operationId,
        tenantId,
        leaseToken: randomUUID(),
      }),
    ).resolves.toBe(true);
  });

  test('fails closed when workload completion has no lease token', async () => {
    const targetWorkspaceId = await createWorkspace('Task18 NULL Completion Lease');
    const operationId = randomUUID();
    const checksum = '4'.repeat(64);
    const objectKey =
      `tenants/${tenantId}/workspaces/${targetWorkspaceId}/channel-packages/` + `${checksum}.json`;
    await store.reserveWorkloadObjectWriteIntent({
      operationId,
      kind: 'CHANNEL_PACKAGE',
      tenantId,
      workspaceId: targetWorkspaceId,
      objectKey,
      checksum,
      contentType: 'application/json',
      byteLength: 12,
    });

    await expect(
      pool.query<{ completed: boolean }>(
        `SELECT complete_workload_object_write_intent(
           $1, NULL, 'CHANNEL_PACKAGE', $2, $3, $4, $5, 'null-lease-v1',
           $6, 'application/json', 12, $7::timestamptz
         ) AS completed`,
        [
          operationId,
          tenantId,
          targetWorkspaceId,
          `s3://artifacts/${objectKey}?versionId=null-lease-v1`,
          objectKey,
          checksum,
          '2026-07-22T12:00:00.000Z',
        ],
      ),
    ).resolves.toMatchObject({ rows: [{ completed: false }] });
    await expect(
      pool.query(
        `SELECT status, object_version_id FROM workload_object_write_intents
                  WHERE operation_id = $1`,
        [operationId],
      ),
    ).resolves.toMatchObject({ rows: [{ status: 'PENDING', object_version_id: null }] });
  });

  test('backs off failed privacy writes so a full stale page cannot starve newer work', async () => {
    const fairnessTenantId = randomUUID();
    const fairnessWorkspaceId = randomUUID();
    const fairnessOwnerUserId = randomUUID();
    await new PostgresTenancyStore(pool).bootstrapTenant({
      actorSubject: 'task18-privacy-retry-fairness',
      actorEmail: 'task18-privacy-retry-fairness@example.test',
      userId: fairnessOwnerUserId,
      tenantId: fairnessTenantId,
      tenantName: 'Task18 Privacy Retry Fairness Tenant',
      workspaceId: fairnessWorkspaceId,
      workspaceName: 'Task18 Privacy Retry Fairness Workspace',
      membershipId: randomUUID(),
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    const failedOperationIds = Array.from({ length: 25 }, () => randomUUID());
    const liveOperationId = randomUUID();
    const operationIds = [...failedOperationIds, liveOperationId];
    const canonicalPayload = Buffer.from('{"status":"pending"}', 'utf8');
    const checksum = createHash('sha256').update(canonicalPayload).digest('hex');

    for (const [index, operationId] of operationIds.entries()) {
      const requestedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      const requestHash = createHash('sha256')
        .update(`privacy-retry-fairness:${operationId}`)
        .digest('hex');
      const objectKey = `tenants/${fairnessTenantId}/exports/${operationId}.bundle.json`;
      const manifest = {
        schemaVersion: '1.0.0',
        tenantId: fairnessTenantId,
        timeRange: {
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-02T00:00:00.000Z',
        },
        objects: [],
        files: [],
        disclosures: {},
      };
      await pool.query(
        `INSERT INTO tenant_exports (
           id, tenant_id, workspace_id, schema_version, status, requested_by_user_id,
           request_hash, requested_at, range_from, range_to, manifest, checksum
         ) VALUES (
           $1, $2, $3, '1.0.0', 'ARCHIVE_PENDING', $4, $5,
           $6::timestamptz, $7::timestamptz, $8::timestamptz, $9::jsonb, $10
         )`,
        [
          operationId,
          fairnessTenantId,
          fairnessWorkspaceId,
          fairnessOwnerUserId,
          requestHash,
          requestedAt,
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          JSON.stringify(manifest),
          createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
        ],
      );
      await pool.query(
        `INSERT INTO privacy_object_write_intents (
           operation_id, tenant_id, workspace_id, kind, request_identity,
           business_id, actor_user_id, audit_event_id, object_key,
           canonical_payload, checksum, content_type, byte_length,
           sealed_at, locked_until, business_payload, status, created_at, updated_at
         ) VALUES (
           $1, $2, $3, 'TENANT_EXPORT', $4, $1, $5, $6, $7,
           $8, $9, 'application/json', $10,
           NULL, NULL, $11::jsonb, 'PENDING', $12::timestamptz, $12::timestamptz
         )`,
        [
          operationId,
          fairnessTenantId,
          fairnessWorkspaceId,
          requestHash,
          fairnessOwnerUserId,
          randomUUID(),
          objectKey,
          canonicalPayload,
          checksum,
          canonicalPayload.byteLength,
          JSON.stringify({ manifestChecksum: checksum }),
          requestedAt,
        ],
      );
      await pool.query(
        `INSERT INTO privacy_object_write_outbox
           (operation_id, tenant_id, available_at, dispatched_at)
         VALUES ($1, $2, $3::timestamptz, NULL)`,
        [operationId, fairnessTenantId, requestedAt],
      );
    }

    const failedLease = randomUUID();
    const firstPage = await privacyStore.claimPendingPrivacyObjectWriteIntents({
      leaseToken: failedLease,
      limit: 25,
    });
    expect(firstPage.map((work) => work.operationId)).toEqual(failedOperationIds);
    for (const operationId of failedOperationIds) {
      await expect(
        privacyStore.releasePrivacyObjectWriteIntentLease({
          operationId,
          leaseToken: failedLease,
          retryDelayMs: 30_000,
        }),
      ).resolves.toBe(true);
    }

    const retryPage = await privacyStore.claimPendingPrivacyObjectWriteIntents({
      leaseToken: randomUUID(),
      limit: 25,
    });
    expect(retryPage.map((work) => work.operationId)).toEqual([liveOperationId]);
  });

  test('backs off a full poison legal-hold page so another Tenant can reconcile', async () => {
    const poisonTenantId = randomUUID();
    const poisonWorkspaceId = randomUUID();
    const poisonOwnerUserId = randomUUID();
    const liveTenantId = randomUUID();
    const liveWorkspaceId = randomUUID();
    const liveOwnerUserId = randomUUID();
    const tenancy = new PostgresTenancyStore(pool);
    await tenancy.bootstrapTenant({
      actorSubject: 'task18-legal-hold-poison-owner',
      actorEmail: 'task18-legal-hold-poison-owner@example.test',
      userId: poisonOwnerUserId,
      tenantId: poisonTenantId,
      tenantName: 'Task18 Legal Hold Poison Tenant',
      workspaceId: poisonWorkspaceId,
      workspaceName: 'Task18 Legal Hold Poison Workspace',
      membershipId: randomUUID(),
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    await tenancy.bootstrapTenant({
      actorSubject: 'task18-legal-hold-live-owner',
      actorEmail: 'task18-legal-hold-live-owner@example.test',
      userId: liveOwnerUserId,
      tenantId: liveTenantId,
      tenantName: 'Task18 Legal Hold Live Tenant',
      workspaceId: liveWorkspaceId,
      workspaceName: 'Task18 Legal Hold Live Workspace',
      membershipId: randomUUID(),
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });

    const poisonTargets = Array.from({ length: 25 }, (_, index) => ({
      key:
        `tenants/${poisonTenantId}/workspaces/${poisonWorkspaceId}/logs/` + `poison-${index}.json`,
      versionId: `poison-version-${index}`,
    }));
    const liveTarget = {
      key: `tenants/${liveTenantId}/workspaces/${liveWorkspaceId}/logs/live.json`,
      versionId: 'live-version',
    };
    for (const target of poisonTargets) {
      await seedPendingLegalHoldReconciliation({
        tenantId: poisonTenantId,
        workspaceId: poisonWorkspaceId,
        ...target,
        updatedAt: '1900-01-01T00:00:00.000Z',
      });
    }
    await seedPendingLegalHoldReconciliation({
      tenantId: liveTenantId,
      workspaceId: liveWorkspaceId,
      ...liveTarget,
      updatedAt: '1900-01-02T00:00:00.000Z',
    });

    const poisonLease = randomUUID();
    const firstPage = await privacyStore.claimPendingLegalHoldReconciliations({
      leaseToken: poisonLease,
      limit: 25,
    });
    expect(firstPage).toHaveLength(25);
    expect(new Set(firstPage.map((work) => work.objectKey))).toEqual(
      new Set(poisonTargets.map((target) => target.key)),
    );
    for (const target of poisonTargets) {
      await expect(
        privacyStore.releaseLegalHoldReconciliationLease({
          tenantId: poisonTenantId,
          objectKey: target.key,
          objectVersionId: target.versionId,
          leaseToken: poisonLease,
        }),
      ).resolves.toBe(true);
    }

    const retryPage = await privacyStore.claimPendingLegalHoldReconciliations({
      leaseToken: randomUUID(),
      limit: 25,
    });
    expect(retryPage.map((work) => work.objectKey)).toContain(liveTarget.key);
    expect(retryPage.map((work) => work.objectKey)).not.toEqual(
      expect.arrayContaining(poisonTargets.map((target) => target.key)),
    );
  });

  test('rotates a full released deletion page so another Tenant can finalize', async () => {
    const poisonTenantId = randomUUID();
    const poisonOwnerUserId = randomUUID();
    const poisonMembershipId = randomUUID();
    const poisonWorkspaceIds = Array.from({ length: 25 }, () => randomUUID());
    const liveTenantId = randomUUID();
    const liveOwnerUserId = randomUUID();
    const liveMembershipId = randomUUID();
    const liveWorkspaceId = randomUUID();
    const tenancy = new PostgresTenancyStore(pool);
    await tenancy.bootstrapTenant({
      actorSubject: 'task18-deletion-poison-owner',
      actorEmail: 'task18-deletion-poison-owner@example.test',
      userId: poisonOwnerUserId,
      tenantId: poisonTenantId,
      tenantName: 'Task18 Deletion Poison Tenant',
      workspaceId: poisonWorkspaceIds[0]!,
      workspaceName: 'Task18 Deletion Poison Workspace 0',
      membershipId: poisonMembershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    for (const [index, targetWorkspaceId] of poisonWorkspaceIds.slice(1).entries()) {
      await pool.query(
        `INSERT INTO workspaces (id, tenant_id, name, created_at)
         VALUES ($1, $2, $3, clock_timestamp())`,
        [targetWorkspaceId, poisonTenantId, `Task18 Deletion Poison Workspace ${index + 1}`],
      );
    }
    await tenancy.bootstrapTenant({
      actorSubject: 'task18-deletion-live-owner',
      actorEmail: 'task18-deletion-live-owner@example.test',
      userId: liveOwnerUserId,
      tenantId: liveTenantId,
      tenantName: 'Task18 Deletion Live Tenant',
      workspaceId: liveWorkspaceId,
      workspaceName: 'Task18 Deletion Live Workspace',
      membershipId: liveMembershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });

    const poisonRequestIds: string[] = [];
    for (const [index, targetWorkspaceId] of poisonWorkspaceIds.entries()) {
      const requestId = randomUUID();
      poisonRequestIds.push(requestId);
      await seedDueDeletionRequest({
        requestId,
        tenantId: poisonTenantId,
        workspaceId: targetWorkspaceId,
        ownerUserId: poisonOwnerUserId,
        membershipId: poisonMembershipId,
        requestedAt: new Date(Date.UTC(1900, 0, 1, 0, 0, index)).toISOString(),
      });
    }
    const liveRequestId = randomUUID();
    await seedDueDeletionRequest({
      requestId: liveRequestId,
      tenantId: liveTenantId,
      workspaceId: liveWorkspaceId,
      ownerUserId: liveOwnerUserId,
      membershipId: liveMembershipId,
      requestedAt: '1900-02-01T00:00:00.000Z',
    });

    const poisonLease = randomUUID();
    const firstPage = await privacyStore.claimDueDeletionRequests({
      leaseToken: poisonLease,
      limit: 25,
    });
    expect(new Set(firstPage.map((work) => work.requestId))).toEqual(new Set(poisonRequestIds));
    for (const requestId of poisonRequestIds) {
      await expect(
        privacyStore.releaseDeletionLease({ requestId, leaseToken: poisonLease }),
      ).resolves.toBe(true);
    }

    const retryPage = await privacyStore.claimDueDeletionRequests({
      leaseToken: randomUUID(),
      limit: 25,
    });
    expect(retryPage.map((work) => work.requestId)).toContain(liveRequestId);
  });

  test('fails closed when a workload batch claim has no lease token', async () => {
    await expect(
      pool.query(`SELECT * FROM claim_pending_workload_object_write_intents(NULL, 10)`),
    ).rejects.toMatchObject({ code: '22023' });
  });

  test('fails closed when a single workload claim has no lease token', async () => {
    await expect(
      pool.query(`SELECT claim_workload_object_write_intent($1, $2, NULL)`, [
        randomUUID(),
        tenantId,
      ]),
    ).rejects.toMatchObject({ code: '22023' });
  });

  test('fails closed when a workload batch claim has no page limit', async () => {
    await expect(
      pool.query(`SELECT * FROM claim_pending_workload_object_write_intents($1, NULL)`, [
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '22023' });
  });

  test('fails closed on incomplete privacy-object lease inputs', async () => {
    await expect(
      pool.query(`SELECT claim_privacy_object_write_intent($1, $2, NULL)`, [
        randomUUID(),
        tenantId,
      ]),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      pool.query(`SELECT * FROM claim_pending_privacy_object_write_intents(NULL, 10)`),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      pool.query(`SELECT * FROM claim_pending_privacy_object_write_intents($1, NULL)`, [
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      pool.query(`SELECT release_privacy_object_write_intent_lease($1, NULL, NULL)`, [
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      pool.query(`SELECT release_privacy_object_write_intent_lease(NULL, $1, NULL)`, [
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '22023' });

    const privacyTenantId = randomUUID();
    const targetWorkspaceId = randomUUID();
    const privacyOwnerUserId = randomUUID();
    await new PostgresTenancyStore(pool).bootstrapTenant({
      actorSubject: 'task18-null-privacy-completion',
      actorEmail: 'task18-null-privacy-completion@example.test',
      userId: privacyOwnerUserId,
      tenantId: privacyTenantId,
      tenantName: 'Task18 NULL Privacy Tenant',
      workspaceId: targetWorkspaceId,
      workspaceName: 'Task18 NULL Privacy Workspace',
      membershipId: randomUUID(),
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    const operationId = randomUUID();
    const canonicalPayload = Buffer.from('{"status":"pending"}', 'utf8');
    const checksum = createHash('sha256').update(canonicalPayload).digest('hex');
    const objectKey = `tenants/${privacyTenantId}/exports/${operationId}.bundle.json`;
    const manifest = {
      schemaVersion: '1.0.0',
      tenantId: privacyTenantId,
      timeRange: {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-02T00:00:00.000Z',
      },
      objects: [],
      files: [],
      disclosures: {},
    };
    await pool.query(
      `INSERT INTO tenant_exports (
         id, tenant_id, workspace_id, schema_version, status, requested_by_user_id,
         request_hash, requested_at, range_from, range_to, manifest, checksum
       ) VALUES (
         $1, $2, $3, '1.0.0', 'ARCHIVE_PENDING', $4, $5,
         $6::timestamptz, $7::timestamptz, $8::timestamptz, $9::jsonb, $10
       )`,
      [
        operationId,
        privacyTenantId,
        targetWorkspaceId,
        privacyOwnerUserId,
        createHash('sha256').update(`privacy-null:${operationId}`).digest('hex'),
        '2026-01-02T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        JSON.stringify(manifest),
        createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
      ],
    );
    await pool.query(
      `INSERT INTO privacy_object_write_intents (
         operation_id, tenant_id, workspace_id, kind, request_identity,
         business_id, actor_user_id, audit_event_id, object_key,
         canonical_payload, checksum, content_type, byte_length,
         sealed_at, locked_until, business_payload, status, created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'TENANT_EXPORT', $4, $1, $5, $6, $7,
         $8, $9, 'application/json', $10,
         NULL, NULL, $11::jsonb, 'PENDING', clock_timestamp(), clock_timestamp()
       )`,
      [
        operationId,
        privacyTenantId,
        targetWorkspaceId,
        createHash('sha256').update(`privacy-intent:${operationId}`).digest('hex'),
        privacyOwnerUserId,
        randomUUID(),
        objectKey,
        canonicalPayload,
        checksum,
        canonicalPayload.byteLength,
        JSON.stringify({ manifestChecksum: checksum }),
      ],
    );
    await expect(
      pool.query<{ completed: boolean }>(
        `SELECT complete_privacy_object_write_intent(
           $1, NULL, $2, $3, 'privacy-null-v1', $4,
           'application/json', $5, $6::timestamptz, NULL
         ) AS completed`,
        [
          operationId,
          `s3://artifacts/${objectKey}?versionId=privacy-null-v1`,
          objectKey,
          checksum,
          canonicalPayload.byteLength,
          '2026-07-22T12:00:00.000Z',
        ],
      ),
    ).resolves.toMatchObject({ rows: [{ completed: false }] });
    await expect(
      pool.query(
        `SELECT intent.status, export.status AS export_status,
                EXISTS (SELECT 1 FROM managed_object_versions object
                        WHERE object.id = intent.operation_id) AS managed
         FROM privacy_object_write_intents intent
         JOIN tenant_exports export ON export.id = intent.business_id
         WHERE intent.operation_id = $1`,
        [operationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ status: 'PENDING', export_status: 'ARCHIVE_PENDING', managed: false }],
    });
  });

  test('fails closed on incomplete lifecycle claim inputs', async () => {
    const invalidClaims: Array<{ sql: string; params?: unknown[] }> = [
      { sql: `SELECT * FROM claim_due_deletion_requests(NULL, 10)` },
      { sql: `SELECT * FROM claim_due_deletion_requests($1, NULL)`, params: [randomUUID()] },
      { sql: `SELECT * FROM claim_due_secret_deletions(NULL, 10)` },
      { sql: `SELECT * FROM claim_due_secret_deletions($1, NULL)`, params: [randomUUID()] },
      {
        sql: `SELECT * FROM claim_pending_legal_hold_reconciliations($1, NULL)`,
        params: [randomUUID()],
      },
    ];
    for (const claim of invalidClaims) {
      await expect(pool.query(claim.sql, claim.params)).rejects.toMatchObject({ code: '22023' });
    }
    await expect(
      pool.query(
        `SELECT release_legal_hold_reconciliation_lease(
           NULL, 'object-key', 'object-version', $1
         )`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '22023' });
  });

  test('fails closed on NULL finalization and backup-verification leases', async () => {
    const requestId = randomUUID();
    const targetWorkspaceId = await createWorkspace('Task18 NULL Finalization Lease');
    const sourceDeletedAt = new Date('2026-01-31T00:00:00.000Z');
    await pool.query(
      `INSERT INTO deletion_requests (
         id, tenant_id, workspace_id, scope_kind, state, requested_by_user_id,
         requested_membership_id, requested_workspace_id, requested_subject_digest,
         reason, request_hash, requested_at, frozen_at, active_delete_by,
         backup_delete_by, secret_force_delete_by, active_deleted_at,
         finalization_lease_token, finalization_lease_expires_at,
         finalization_last_claimed_at
       ) VALUES (
         $1, $2, $3, 'WORKSPACE', 'ACTIVE_DATA_DELETED', $4,
         $5, $3, $6, 'Task18 NULL finalization lease', $7,
         '2026-01-01T00:00:00.000Z'::timestamptz,
         '2026-01-01T00:00:00.000Z'::timestamptz,
         '2026-01-31T00:00:00.000Z'::timestamptz,
         '2026-04-01T00:00:00.000Z'::timestamptz,
         '2026-01-02T00:00:00.000Z'::timestamptz,
         '2026-01-31T00:00:00.000Z'::timestamptz,
         NULL, clock_timestamp() + interval '10 minutes', clock_timestamp()
       )`,
      [
        requestId,
        tenantId,
        targetWorkspaceId,
        ownerUserId,
        membershipId,
        createHash('sha256').update('task18-null-finalization-subject').digest('hex'),
        createHash('sha256').update(requestId).digest('hex'),
      ],
    );
    await expect(
      pool.query(`SELECT * FROM finalize_deletion($1, NULL, clock_timestamp(), $2, $3)`, [
        requestId,
        randomUUID(),
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      pool.query(`SELECT * FROM get_backup_deletion_verification_target($1, NULL)`, [requestId]),
    ).rejects.toMatchObject({ code: '42501' });
    const verifiedAt = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]
      ?.now;
    if (verifiedAt === undefined) throw new Error('database clock unavailable');
    const evidenceCanonicalJson = JSON.stringify({
      inventoryMethod: 'ListRecoveryPointsByResource',
      managedByAWSBackupOnly: false,
      requestId: requestId.toLowerCase(),
      schemaVersion: '2.0.0',
      sourceDeletedAt: sourceDeletedAt.toISOString(),
      verifiedAt: verifiedAt.toISOString(),
    });
    await expect(
      pool.query<{ recorded: boolean }>(
        `SELECT record_backup_deletion_verification(
           $1, NULL, $2::timestamptz, $3::timestamptz, $4, $5
         ) AS recorded`,
        [
          requestId,
          sourceDeletedAt,
          verifiedAt,
          evidenceCanonicalJson,
          createHash('sha256').update(evidenceCanonicalJson).digest('hex'),
        ],
      ),
    ).resolves.toMatchObject({ rows: [{ recorded: false }] });
    await expect(
      pool.query(
        `SELECT state, finalization_lease_token, backup_verified_at,
                backup_evidence_hash
         FROM deletion_requests WHERE id = $1`,
        [requestId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: 'ACTIVE_DATA_DELETED',
          finalization_lease_token: null,
          backup_verified_at: null,
          backup_evidence_hash: null,
        },
      ],
    });
  });

  test('fails closed on SQL NULL inventory bucket and versions inputs', async () => {
    const targetWorkspaceId = await createWorkspace('Task18 Null Inventory Input');
    await pool.query(
      `INSERT INTO privacy_object_inventory_requirements (scope_tenant_id, required_at)
       VALUES ($1, clock_timestamp()) ON CONFLICT (scope_tenant_id) DO NOTHING`,
      [tenantId],
    );
    const requestId = randomUUID();
    const deletionLease = randomUUID();
    await insertWorkspaceDeletion({ requestId, deletionLease, targetWorkspaceId });
    await privacyStore.getDeletionObjectInventoryPageTarget({
      requestId,
      leaseToken: deletionLease,
    });

    await expect(
      pool.query(
        `SELECT record_deletion_object_inventory_page(
           $1, $2, NULL, NULL, NULL, '[]'::jsonb
         )`,
        [requestId, deletionLease],
      ),
    ).rejects.toThrow('PRIVACY_OBJECT_INVENTORY_PAGE_INVALID');
    await expect(
      pool.query(
        `SELECT record_deletion_object_inventory_page(
           $1, $2, 'TENANT_EXPORTS', NULL, NULL, NULL::jsonb
         )`,
        [requestId, deletionLease],
      ),
    ).rejects.toThrow('PRIVACY_OBJECT_INVENTORY_PAGE_INVALID');
  });

  test('fails closed on a SQL NULL physical-deletion page limit', async () => {
    const targetWorkspaceId = await createWorkspace('Task18 NULL Deletion Limit');
    const requestId = randomUUID();
    const deletionLease = randomUUID();
    await insertWorkspaceDeletion({ requestId, deletionLease, targetWorkspaceId });

    await expect(
      pool.query(`SELECT * FROM list_due_deletion_object_versions($1, $2, NULL)`, [
        requestId,
        deletionLease,
      ]),
    ).rejects.toThrow('DELETION_OBJECT_WORK_LIMIT_INVALID');
  });

  async function insertWorkspaceDeletion(input: {
    requestId: string;
    deletionLease: string;
    targetWorkspaceId?: string;
  }): Promise<void> {
    const targetWorkspaceId = input.targetWorkspaceId ?? workspaceId;
    await pool.query(
      `INSERT INTO deletion_requests (
         id, tenant_id, workspace_id, scope_kind, state, requested_by_user_id,
         requested_membership_id, requested_workspace_id, requested_subject_digest,
         reason, request_hash, requested_at, frozen_at, active_delete_by,
         backup_delete_by, secret_force_delete_by, finalization_lease_token,
         finalization_lease_expires_at, finalization_last_claimed_at
       ) VALUES (
         $1, $2, $3, 'WORKSPACE', 'FROZEN', $4, $5, $3, $6,
         'Task18 exact Workspace inventory', $7, $8::timestamptz, $8::timestamptz,
         $8::timestamptz + interval '30 days',
         $8::timestamptz + interval '90 days',
         $8::timestamptz + interval '24 hours',
         $9, clock_timestamp() + interval '10 minutes', clock_timestamp()
       )`,
      [
        input.requestId,
        tenantId,
        targetWorkspaceId,
        ownerUserId,
        membershipId,
        createHash('sha256').update('task18-subject').digest('hex'),
        createHash('sha256').update(input.requestId).digest('hex'),
        new Date('2026-01-01T00:00:00.000Z'),
        input.deletionLease,
      ],
    );
  }

  async function createWorkspace(name: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO workspaces (id, tenant_id, name, created_at)
       VALUES ($1, $2, $3, clock_timestamp())`,
      [id, tenantId, name],
    );
    await pool.query(
      `INSERT INTO role_bindings (
         id, tenant_id, workspace_id, membership_id, role, created_at
       ) VALUES ($1, $2, $3, $4, 'OWNER', clock_timestamp())`,
      [randomUUID(), tenantId, id, membershipId],
    );
    return id;
  }

  async function seedPendingLegalHoldReconciliation(input: {
    tenantId: string;
    workspaceId: string;
    key: string;
    versionId: string;
    updatedAt: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO managed_object_versions (
         id, tenant_id, workspace_id, object_class, object_ref, object_key,
         object_version_id, checksum, content_type, byte_length,
         lifecycle_state, created_at, storage_class
       ) VALUES (
         $1, $2, $3, 'APPLICATION_LOG', $4, $5, $6, $7,
         'application/json', 32, 'ACTIVE', clock_timestamp(), 'WORKLOAD_OBJECTS'
       )`,
      [
        randomUUID(),
        input.tenantId,
        input.workspaceId,
        `s3://artifacts/${input.key}`,
        input.key,
        input.versionId,
        createHash('sha256').update(`${input.key}:${input.versionId}`).digest('hex'),
      ],
    );
    await pool.query(
      `INSERT INTO legal_hold_object_reconciliations (
         tenant_id, object_key, object_version_id, object_class,
         desired_status, desired_revision, applied_status, applied_revision,
         work_attempt_count, updated_at
       ) VALUES (
         $1, $2, $3, 'APPLICATION_LOG', 'ON', 1, 'UNKNOWN', 0, 0,
         $4::timestamptz
       )`,
      [input.tenantId, input.key, input.versionId, input.updatedAt],
    );
  }

  async function seedDueDeletionRequest(input: {
    requestId: string;
    tenantId: string;
    workspaceId: string;
    ownerUserId: string;
    membershipId: string;
    requestedAt: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO deletion_requests (
         id, tenant_id, workspace_id, scope_kind, state,
         requested_by_user_id, requested_membership_id, requested_workspace_id,
         requested_subject_digest, reason, request_hash, requested_at, frozen_at,
         active_delete_by, backup_delete_by, secret_force_delete_by
       ) VALUES (
         $1, $2, $3, 'WORKSPACE', 'FROZEN',
         $4, $5, $3, $6, 'Task18 deletion queue fairness', $7,
         $8::timestamptz, $8::timestamptz,
         $8::timestamptz + interval '30 days',
         $8::timestamptz + interval '90 days',
         $8::timestamptz + interval '24 hours'
       )`,
      [
        input.requestId,
        input.tenantId,
        input.workspaceId,
        input.ownerUserId,
        input.membershipId,
        createHash('sha256').update(`subject:${input.requestId}`).digest('hex'),
        createHash('sha256').update(`request:${input.requestId}`).digest('hex'),
        input.requestedAt,
      ],
    );
  }

  function requestWorkspaceDeletion(targetWorkspaceId: string) {
    const requestId = randomUUID();
    return privacyStore.requestWorkspaceDeletion({
      actorSubject: 'task18-workload-owner',
      context: {
        tenantId,
        workspaceId: targetWorkspaceId,
        membershipId,
        actorUserId: ownerUserId,
        role: 'OWNER',
      },
      requestId,
      reason: 'Task18 claim and freeze serialization',
      requestHash: createHash('sha256').update(requestId).digest('hex'),
      requestedAt: new Date(),
      auditEventId: randomUUID(),
    });
  }
});
