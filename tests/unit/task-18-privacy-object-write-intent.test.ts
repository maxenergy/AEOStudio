import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import { PrivacyLifecycleWorker } from '../../apps/worker/src/privacy-lifecycle-worker.js';

const NOW = new Date('2026-07-22T12:00:00.000Z');

describe('Task 18 durable privacy object write intents', () => {
  test('passes the exact privacy intent id and returned lease to the capability-bound writer', async () => {
    const operationId = randomUUID();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const leaseToken = randomUUID();
    const body = new TextEncoder().encode('{"schemaVersion":"tenant-export-bundle.v1"}');
    const checksum = createHash('sha256').update(body).digest('hex');
    const intent = {
      operationId,
      kind: 'TENANT_EXPORT' as const,
      tenantId,
      workspaceId,
      objectKey: `tenants/${tenantId}/exports/${operationId}.bundle.json`,
      canonicalPayload: body,
      checksum,
      contentType: 'application/json',
      lockedUntil: null,
      sealedAt: null,
      leaseToken,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    };
    const stored = {
      tenantId,
      objectRef: `s3://exports/${intent.objectKey}?versionId=capability-v1`,
      objectKey: intent.objectKey,
      objectVersionId: 'capability-v1',
      checksum,
      contentType: intent.contentType,
      byteLength: body.byteLength,
      createdAt: NOW.toISOString(),
      lockedUntil: null,
    };
    const putAuthorizedPrivacyVersion = vi.fn(() => Promise.resolve(stored));
    const completePrivacyObjectWriteIntent = vi.fn(() => Promise.resolve(true));
    const worker = new PrivacyLifecycleWorker(
      lifecycleStore({
        claimPendingPrivacyObjectWriteIntents: () => Promise.resolve([intent]),
        completePrivacyObjectWriteIntent,
      }),
      absentSecrets,
      {
        clock: { now: () => new Date(NOW) },
        ids: { next: randomUUID },
        objects: absentObjectStorage,
        privacyWrites: { putAuthorizedPrivacyVersion },
      },
    );

    await expect(worker.runOnce()).resolves.toMatchObject({
      claimedPrivacyObjectWrites: 1,
      completedPrivacyObjectWrites: 1,
    });
    expect(putAuthorizedPrivacyVersion).toHaveBeenCalledWith(intent);
    expect(completePrivacyObjectWriteIntent).toHaveBeenCalledWith({
      operationId,
      leaseToken,
      object: stored,
    });
  });

  test('replays one stable export intent after Put succeeded but database finalization crashed', async () => {
    const operationId = randomUUID();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const leaseToken = randomUUID();
    const body = new TextEncoder().encode('{"schemaVersion":"tenant-export-bundle.v1"}');
    const checksum = createHash('sha256').update(body).digest('hex');
    const intent = {
      operationId,
      kind: 'TENANT_EXPORT' as const,
      tenantId,
      workspaceId,
      objectKey: `tenants/${tenantId}/exports/${operationId}.bundle.json`,
      canonicalPayload: body,
      checksum,
      contentType: 'application/json',
      lockedUntil: null,
      sealedAt: null,
      leaseToken,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    };
    const claim = vi.fn().mockResolvedValue([intent]);
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error('SIMULATED_COMMIT_CRASH'))
      .mockResolvedValueOnce(true);
    const release = vi.fn(() => Promise.resolve(true));
    const store = lifecycleStore({
      claimPendingPrivacyObjectWriteIntents: claim,
      completePrivacyObjectWriteIntent: complete,
      releasePrivacyObjectWriteIntentLease: release,
    });
    const stored = {
      tenantId,
      objectRef: `s3://exports/${intent.objectKey}?versionId=stable-v1`,
      objectKey: intent.objectKey,
      objectVersionId: 'stable-v1',
      checksum,
      contentType: 'application/json',
      byteLength: body.byteLength,
      createdAt: NOW.toISOString(),
      lockedUntil: null,
    };
    const putExportVersion = vi.fn(() => Promise.resolve(stored));
    const worker = new PrivacyLifecycleWorker(store, absentSecrets, {
      clock: { now: () => new Date(NOW) },
      ids: { next: randomUUID },
      objects: { ...absentObjectStorage, putExportVersion },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      claimedPrivacyObjectWrites: 1,
      completedPrivacyObjectWrites: 0,
      failed: 1,
    });
    await expect(worker.runOnce()).resolves.toMatchObject({
      claimedPrivacyObjectWrites: 1,
      completedPrivacyObjectWrites: 1,
      failed: 0,
    });

    expect(putExportVersion).toHaveBeenCalledTimes(2);
    expect(putExportVersion.mock.calls[0]?.[0]).toEqual(putExportVersion.mock.calls[1]?.[0]);
    expect(complete).toHaveBeenLastCalledWith({
      operationId,
      leaseToken,
      object: stored,
    });
    expect(release).toHaveBeenCalledWith({
      operationId,
      leaseToken,
      retryDelayMs: 30_000,
    });
  });

  test('recovers an exact workload version after S3 Put succeeded but ledger completion crashed', async () => {
    const operationId = randomUUID();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const leaseToken = randomUUID();
    const checksum = 'a'.repeat(64);
    const objectKey = `tenants/${tenantId}/workspaces/${workspaceId}/channel-packages/${checksum}.json`;
    const claim = {
      operationId,
      kind: 'CHANNEL_PACKAGE' as const,
      tenantId,
      workspaceId,
      objectKey,
      checksum,
      contentType: 'application/json',
      byteLength: 128,
      leaseToken,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    };
    const stored = {
      kind: 'CHANNEL_PACKAGE' as const,
      objectClass: 'CHANNEL_PACKAGE' as const,
      tenantId,
      workspaceId,
      objectRef: `s3://artifacts/${objectKey}?versionId=exact-workload-v1`,
      objectKey,
      objectVersionId: 'exact-workload-v1',
      checksum,
      contentType: 'application/json',
      byteLength: 128,
      createdAt: NOW.toISOString(),
    };
    const intents = {
      reserveWorkloadObjectWriteIntent: vi.fn(),
      claimWorkloadObjectWriteIntent: vi.fn(),
      claimPendingWorkloadObjectWriteIntents: vi.fn(() => Promise.resolve([claim])),
      completeWorkloadObjectWriteIntent: vi.fn(() => Promise.resolve(true)),
      releaseWorkloadObjectWriteIntentLease: vi.fn(() => Promise.resolve(true)),
    };
    const recoverWorkloadVersion = vi.fn(() => Promise.resolve(stored));
    const worker = new PrivacyLifecycleWorker(lifecycleStore({}), absentSecrets, {
      clock: { now: () => new Date(NOW) },
      ids: { next: randomUUID },
      objects: absentObjectStorage,
      workloadWrites: {
        intents,
        objects: { recoverWorkloadVersion },
      },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      claimedWorkloadObjectWrites: 1,
      completedWorkloadObjectWrites: 1,
      failed: 0,
    });
    expect(recoverWorkloadVersion).toHaveBeenCalledWith({
      kind: claim.kind,
      tenantId,
      workspaceId,
      objectKey,
      checksum,
      contentType: claim.contentType,
      byteLength: claim.byteLength,
    });
    expect(intents.completeWorkloadObjectWriteIntent).toHaveBeenCalledWith({
      operationId,
      leaseToken,
      object: stored,
    });
    expect(intents.releaseWorkloadObjectWriteIntentLease).not.toHaveBeenCalled();
  });

  test('releases a workload recovery lease when the deterministic S3 key is still absent', async () => {
    const operationId = randomUUID();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const leaseToken = randomUUID();
    const checksum = 'b'.repeat(64);
    const claim = {
      operationId,
      kind: 'CHANNEL_PACKAGE' as const,
      tenantId,
      workspaceId,
      objectKey: `tenants/${tenantId}/workspaces/${workspaceId}/channel-packages/${checksum}.json`,
      checksum,
      contentType: 'application/json',
      byteLength: 128,
      leaseToken,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    };
    const intents = {
      reserveWorkloadObjectWriteIntent: vi.fn(),
      claimWorkloadObjectWriteIntent: vi.fn(),
      claimPendingWorkloadObjectWriteIntents: vi.fn(() => Promise.resolve([claim])),
      completeWorkloadObjectWriteIntent: vi.fn(() => Promise.resolve(true)),
      releaseWorkloadObjectWriteIntentLease: vi.fn(() => Promise.resolve(true)),
    };
    const worker = new PrivacyLifecycleWorker(lifecycleStore({}), absentSecrets, {
      clock: { now: () => new Date(NOW) },
      ids: { next: randomUUID },
      objects: absentObjectStorage,
      workloadWrites: {
        intents,
        objects: { recoverWorkloadVersion: () => Promise.resolve(null) },
      },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      claimedWorkloadObjectWrites: 1,
      completedWorkloadObjectWrites: 0,
      failed: 0,
    });
    expect(intents.releaseWorkloadObjectWriteIntentLease).toHaveBeenCalledWith({
      operationId,
      leaseToken,
      retryDelayMs: 30_000,
    });
    expect(intents.completeWorkloadObjectWriteIntent).not.toHaveBeenCalled();
  });

  test('retains an ambiguous workload recovery lease and passes its authority to the Broker', async () => {
    const operationId = randomUUID();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const leaseToken = randomUUID();
    const checksum = 'c'.repeat(64);
    const claim = {
      operationId,
      kind: 'CHANNEL_PACKAGE' as const,
      tenantId,
      workspaceId,
      objectKey: `tenants/${tenantId}/workspaces/${workspaceId}/channel-packages/${checksum}.json`,
      checksum,
      contentType: 'application/json',
      byteLength: 128,
      leaseToken,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    };
    const intents = {
      reserveWorkloadObjectWriteIntent: vi.fn(),
      claimWorkloadObjectWriteIntent: vi.fn(),
      claimPendingWorkloadObjectWriteIntents: vi.fn(() => Promise.resolve([claim])),
      completeWorkloadObjectWriteIntent: vi.fn(() => Promise.resolve(true)),
      releaseWorkloadObjectWriteIntentLease: vi.fn(() => Promise.resolve(true)),
    };
    const recoverAuthorizedWorkloadVersion = vi.fn(() =>
      Promise.resolve({ outcome: 'UNKNOWN' as const }),
    );
    const worker = new PrivacyLifecycleWorker(lifecycleStore({}), absentSecrets, {
      clock: { now: () => new Date(NOW) },
      ids: { next: randomUUID },
      objects: absentObjectStorage,
      workloadWrites: {
        intents,
        objects: { recoverAuthorizedWorkloadVersion },
      },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      claimedWorkloadObjectWrites: 1,
      completedWorkloadObjectWrites: 0,
      failed: 1,
    });
    expect(recoverAuthorizedWorkloadVersion).toHaveBeenCalledWith(
      {
        kind: claim.kind,
        tenantId,
        workspaceId,
        objectKey: claim.objectKey,
        checksum,
        contentType: claim.contentType,
        byteLength: claim.byteLength,
      },
      { operationId, leaseToken },
    );
    expect(intents.completeWorkloadObjectWriteIntent).not.toHaveBeenCalled();
    expect(intents.releaseWorkloadObjectWriteIntentLease).not.toHaveBeenCalled();
  });
});

function lifecycleStore(overrides: Record<string, unknown>) {
  return {
    claimPendingPrivacyObjectWriteIntents: () => Promise.resolve([]),
    completePrivacyObjectWriteIntent: () => Promise.resolve(true),
    releasePrivacyObjectWriteIntentLease: () => Promise.resolve(true),
    claimPendingLegalHoldReconciliations: () => Promise.resolve([]),
    claimDueSecretDeletions: () => Promise.resolve([]),
    claimDueDeletionRequests: () => Promise.resolve([]),
    markSecretDeletionRequested: () => Promise.resolve(true),
    markSecretUnreadable: () => Promise.resolve(true),
    listDueDeletionObjectVersions: () =>
      Promise.resolve({ outcome: 'SUCCEEDED' as const, objects: [], hasMore: false }),
    markDeletionObjectVersionDeleted: () => Promise.resolve(true),
    releaseDeletionLease: () => Promise.resolve(true),
    getBackupDeletionVerificationTarget: () => Promise.resolve({ outcome: 'NOT_DUE' as const }),
    recordBackupDeletionVerification: () => Promise.resolve(true),
    getDeletionObjectInventoryTarget: () => Promise.resolve({ outcome: 'NOT_REQUIRED' as const }),
    recordDeletionObjectInventory: () => Promise.resolve(true),
    completeLegalHoldReconciliation: () => Promise.resolve(true),
    releaseLegalHoldReconciliationLease: () => Promise.resolve(true),
    finalizeDeletion: () => Promise.resolve({ outcome: 'NOT_DUE' as const }),
    ...overrides,
  };
}

const absentSecrets = {
  requestForceDelete: () => Promise.resolve(),
  verifyUnreadable: () => Promise.resolve(true),
};

const absentObjectStorage = {
  putLockedAuditVersion: () => Promise.reject(new Error('UNUSED_AUDIT_PUT')),
  deleteExportVersion: () => Promise.resolve({ outcome: 'NOT_FOUND' as const }),
  deleteAuditVersion: () => Promise.resolve({ outcome: 'NOT_FOUND' as const }),
  holdExportVersion: () => Promise.resolve(true),
  releaseExportVersionHold: () => Promise.resolve(true),
  holdAuditVersion: () => Promise.resolve(true),
  releaseAuditVersionHold: () => Promise.resolve(true),
  listPrivacyObjectVersions: () => Promise.resolve({ versions: [], nextCursor: null }),
};
