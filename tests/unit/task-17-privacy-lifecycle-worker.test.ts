import { createHash, randomUUID } from 'node:crypto';

import type {
  BackupDeletionEvidenceStore,
  DeletionObjectInventoryStore,
  LegalHoldReconciliationStore,
  PhysicalDeletionLifecycleStore,
  PrivacyAuditStore,
  PrivacyObjectWriteIntentStore,
} from '@aeostudio/application/privacy-audit';
import { describe, expect, test, vi } from 'vitest';

import { PrivacyLifecycleWorker } from '../../apps/worker/src/privacy-lifecycle-worker.js';
import { resolveProductionPrivacyLifecycleWorkerRuntime } from '../../apps/worker/src/production-privacy-lifecycle-worker-runtime.js';

const NOW = new Date('2026-07-22T06:00:00.000Z');

describe('Task 17 privacy lifecycle worker', () => {
  test('production startup fails closed before polling when no Secret Manager boundary is configured', () => {
    expect(() =>
      resolveProductionPrivacyLifecycleWorkerRuntime({
        environment: {
          NODE_ENV: 'production',
          LIFECYCLE_DATABASE_URL: 'postgresql://127.0.0.1:1/privacy-lifecycle-worker-wiring',
          PRIVACY_DATABASE_POOL_MAX: '5',
        },
        objects: absentObjectStorage,
      }),
    ).toThrow('PRIVACY_LIFECYCLE_SECRET_MANAGER_REQUIRED');
  });

  test('the production Privacy runtime composes PostgreSQL with explicit secret and backup boundaries', async () => {
    const secrets = {
      requestForceDelete: () => Promise.resolve(),
      verifyUnreadable: () => Promise.resolve(true),
    };
    const runtime = resolveProductionPrivacyLifecycleWorkerRuntime({
      environment: {
        NODE_ENV: 'production',
        LIFECYCLE_DATABASE_URL: 'postgresql://127.0.0.1:1/privacy-lifecycle-worker-wiring',
        PRIVACY_DATABASE_POOL_MAX: '5',
      },
      secrets,
      objects: absentObjectStorage,
      backupVerifier: {
        verifyExpired: () => Promise.resolve({ outcome: 'RECOVERY_POINTS_RETAINED' }),
      },
    });

    expect(runtime.components.store.constructor.name).toBe('PostgresPrivacyAuditStore');
    expect(runtime.components.secrets).toBe(secrets);
    await runtime.close();
  });

  test('uses each claim-returned lease token for secret proof and deletion finalization', async () => {
    const requestedLegalHoldLease = randomUUID();
    const requestedSecretLease = randomUUID();
    const requestedDeletionLease = randomUUID();
    const returnedSecretLease = randomUUID();
    const returnedDeletionLease = randomUUID();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const authorizationId = randomUUID();
    const requestId = randomUUID();
    const store = lifecycleStore({
      claimDueSecretDeletions: () =>
        Promise.resolve([
          {
            tenantId,
            workspaceId,
            channelAuthorizationId: authorizationId,
            deletionRequestId: requestId,
            secretReference: 'opaque-secret-reference',
            forceDeleteAt: NOW.toISOString(),
            leaseToken: returnedSecretLease,
            leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
          },
        ]),
      claimDueDeletionRequests: () =>
        Promise.resolve([
          {
            requestId,
            stage: 'ACTIVE',
            leaseToken: returnedDeletionLease,
            leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
          },
        ]),
    });
    const secrets = {
      requestForceDelete: vi.fn(() => Promise.resolve()),
      verifyUnreadable: vi.fn(() => Promise.resolve(true)),
    };
    const worker = new PrivacyLifecycleWorker(store, secrets, {
      clock: { now: () => new Date(NOW) },
      ids: {
        next: vi
          .fn()
          .mockReturnValueOnce(requestedLegalHoldLease)
          .mockReturnValueOnce(requestedSecretLease)
          .mockReturnValueOnce(requestedDeletionLease)
          .mockImplementation(randomUUID),
      },
      objects: absentObjectStorage,
    });

    await expect(worker.runOnce()).resolves.toEqual({
      claimedPrivacyObjectWrites: 0,
      completedPrivacyObjectWrites: 0,
      claimedWorkloadObjectWrites: 0,
      completedWorkloadObjectWrites: 0,
      claimedLegalHoldReconciliations: 0,
      reconciledLegalHoldObjectVersions: 0,
      claimedSecrets: 1,
      verifiedSecrets: 1,
      claimedDeletions: 1,
      finalizedDeletions: 1,
      physicallyDeletedObjectVersions: 0,
      retainedAuditObjectVersions: 0,
      retainedLegalHoldObjectVersions: 0,
      leaseLost: 0,
      failed: 0,
    });
    expect(store.markSecretDeletionRequested).toHaveBeenCalledWith({
      tenantId,
      channelAuthorizationId: authorizationId,
      leaseToken: returnedSecretLease,
    });
    expect(store.markSecretUnreadable).toHaveBeenCalledWith({
      tenantId,
      channelAuthorizationId: authorizationId,
      leaseToken: returnedSecretLease,
    });
    expect(secrets.requestForceDelete).toHaveBeenCalledWith({
      channelAuthorizationId: authorizationId,
      leaseToken: returnedSecretLease,
      tenantId,
      workspaceId,
      secretReference: 'opaque-secret-reference',
    });
    expect(secrets.verifyUnreadable).toHaveBeenCalledWith({
      channelAuthorizationId: authorizationId,
      leaseToken: returnedSecretLease,
      tenantId,
      workspaceId,
      secretReference: 'opaque-secret-reference',
    });
    expect(store.finalizeDeletion).toHaveBeenCalledWith(
      expect.objectContaining({ requestId, leaseToken: returnedDeletionLease }),
    );
  });

  test('passes exact secret claim authority to the capability gateway without a legacy fallback', async () => {
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const channelAuthorizationId = randomUUID();
    const leaseToken = randomUUID();
    const secretReference = 'opaque-secret-reference';
    const store = lifecycleStore({
      claimDueSecretDeletions: () =>
        Promise.resolve([
          {
            tenantId,
            workspaceId,
            channelAuthorizationId,
            deletionRequestId: randomUUID(),
            secretReference,
            forceDeleteAt: NOW.toISOString(),
            leaseToken,
            leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
          },
        ]),
    });
    const requestAuthorizedConnectorSecretForceDelete = vi.fn(() => Promise.resolve());
    const verifyAuthorizedConnectorSecretUnreadable = vi.fn(() => Promise.resolve(true));
    const requestForceDelete = vi.fn(() => Promise.resolve());
    const verifyUnreadable = vi.fn(() => Promise.resolve(true));
    const worker = new PrivacyLifecycleWorker(
      store,
      {
        requestAuthorizedConnectorSecretForceDelete,
        verifyAuthorizedConnectorSecretUnreadable,
        requestForceDelete,
        verifyUnreadable,
      },
      {
        clock: { now: () => new Date(NOW) },
        ids: { next: randomUUID },
        objects: absentObjectStorage,
      },
    );

    await expect(worker.runOnce()).resolves.toMatchObject({
      claimedSecrets: 1,
      verifiedSecrets: 1,
      failed: 0,
    });
    const expected = {
      source: { channelAuthorizationId, leaseToken },
      expected: { tenantId, workspaceId, secretReference },
    };
    expect(requestAuthorizedConnectorSecretForceDelete).toHaveBeenCalledWith(expected);
    expect(verifyAuthorizedConnectorSecretUnreadable).toHaveBeenCalledWith(expected);
    expect(requestForceDelete).not.toHaveBeenCalled();
    expect(verifyUnreadable).not.toHaveBeenCalled();
  });

  test('does not perform effects or state transitions for already expired claims', async () => {
    const expiredAt = new Date(NOW.getTime() - 1).toISOString();
    const store = lifecycleStore({
      claimDueSecretDeletions: () =>
        Promise.resolve([
          {
            tenantId: randomUUID(),
            workspaceId: randomUUID(),
            channelAuthorizationId: randomUUID(),
            deletionRequestId: randomUUID(),
            secretReference: 'expired-secret-reference',
            forceDeleteAt: NOW.toISOString(),
            leaseToken: randomUUID(),
            leaseExpiresAt: expiredAt,
          },
        ]),
      claimDueDeletionRequests: () =>
        Promise.resolve([
          {
            requestId: randomUUID(),
            stage: 'ACTIVE',
            leaseToken: randomUUID(),
            leaseExpiresAt: expiredAt,
          },
        ]),
    });
    const secrets = {
      requestForceDelete: vi.fn(() => Promise.resolve()),
      verifyUnreadable: vi.fn(() => Promise.resolve(true)),
    };
    const worker = new PrivacyLifecycleWorker(store, secrets, {
      clock: { now: () => new Date(NOW) },
      ids: { next: randomUUID },
      objects: absentObjectStorage,
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      claimedSecrets: 1,
      verifiedSecrets: 0,
      claimedDeletions: 1,
      finalizedDeletions: 0,
      leaseLost: 2,
    });
    expect(secrets.requestForceDelete).not.toHaveBeenCalled();
    expect(store.markSecretDeletionRequested).not.toHaveBeenCalled();
    expect(store.markSecretUnreadable).not.toHaveBeenCalled();
    expect(store.finalizeDeletion).not.toHaveBeenCalled();
  });

  test('reports an invalid lease without treating the deletion as finalized', async () => {
    const store = lifecycleStore({
      claimDueDeletionRequests: () =>
        Promise.resolve([
          {
            requestId: randomUUID(),
            stage: 'BACKUP',
            leaseToken: randomUUID(),
            leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
          },
        ]),
      finalizeDeletion: () => Promise.resolve({ outcome: 'INVALID_LEASE' }),
    });
    const worker = new PrivacyLifecycleWorker(
      store,
      {
        requestForceDelete: () => Promise.resolve(),
        verifyUnreadable: () => Promise.resolve(true),
      },
      {
        clock: { now: () => new Date(NOW) },
        ids: { next: randomUUID },
        objects: absentObjectStorage,
        backupVerifier: {
          verifyExpired: (input) => {
            const evidence = backupEvidence(
              input.requestId,
              input.sourceDeletedAt,
              NOW.toISOString(),
            );
            return Promise.resolve({
              outcome: 'VERIFIED',
              ...evidence,
              sourceDeletedAt: input.sourceDeletedAt,
              verifiedAt: NOW.toISOString(),
            });
          },
        },
      },
    );

    await expect(worker.runOnce()).resolves.toMatchObject({
      claimedDeletions: 1,
      finalizedDeletions: 0,
      leaseLost: 1,
    });
  });

  test('reclaims a previously requested secret and can verify it on a later attempt', async () => {
    let current = new Date(NOW);
    let claimCount = 0;
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const channelAuthorizationId = randomUUID();
    const deletionRequestId = randomUUID();
    const store = lifecycleStore({
      claimDueSecretDeletions: (input) => {
        claimCount += 1;
        return Promise.resolve([
          {
            tenantId,
            workspaceId,
            channelAuthorizationId,
            deletionRequestId,
            secretReference: 'retryable-secret-reference',
            forceDeleteAt: NOW.toISOString(),
            state:
              claimCount === 1
                ? ('REVOKED_PENDING_FORCE_DELETE' as const)
                : ('FORCE_DELETE_REQUESTED' as const),
            leaseToken: input.leaseToken,
            leaseExpiresAt: new Date(current.getTime() + 60_000).toISOString(),
          },
        ]);
      },
    });
    const secrets = {
      requestForceDelete: vi.fn(() => Promise.resolve()),
      verifyUnreadable: vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    };
    const worker = new PrivacyLifecycleWorker(store, secrets, {
      clock: { now: () => new Date(current) },
      ids: { next: randomUUID },
      objects: absentObjectStorage,
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      verifiedSecrets: 0,
      failed: 1,
    });
    current = new Date(current.getTime() + 5 * 60 * 1_000);
    await expect(worker.runOnce()).resolves.toMatchObject({
      verifiedSecrets: 1,
      failed: 0,
    });
    expect(store.markSecretDeletionRequested).toHaveBeenCalledTimes(2);
    expect(store.markSecretUnreadable).toHaveBeenCalledTimes(1);
    expect(secrets.requestForceDelete).toHaveBeenCalledTimes(1);
  });

  test('keeps the lifecycle poller alive after a transient claim failure', async () => {
    vi.useFakeTimers();
    try {
      const shutdown = new AbortController();
      let attempts = 0;
      const store = lifecycleStore({
        claimDueSecretDeletions: () => {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error('TRANSIENT_DATABASE_FAILURE'));
          shutdown.abort();
          return Promise.resolve([]);
        },
      });
      const worker = new PrivacyLifecycleWorker(
        store,
        {
          requestForceDelete: () => Promise.resolve(),
          verifyUnreadable: () => Promise.resolve(true),
        },
        {
          clock: { now: () => new Date(NOW) },
          ids: { next: randomUUID },
          objects: absentObjectStorage,
          pollIntervalMs: 10,
        },
      );

      const running = worker.run(shutdown.signal);
      await vi.advanceTimersByTimeAsync(10);

      await expect(running).resolves.toBeUndefined();
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

function lifecycleStore(
  overrides: Partial<
    Pick<
      PrivacyAuditStore,
      | 'claimDueDeletionRequests'
      | 'claimDueSecretDeletions'
      | 'markSecretDeletionRequested'
      | 'markSecretUnreadable'
      | 'finalizeDeletion'
    >
  > &
    Partial<PhysicalDeletionLifecycleStore> &
    Partial<BackupDeletionEvidenceStore> &
    Partial<LegalHoldReconciliationStore> &
    Partial<PrivacyObjectWriteIntentStore> &
    Partial<DeletionObjectInventoryStore> = {},
) {
  return {
    claimPendingPrivacyObjectWriteIntents: vi.fn(() => Promise.resolve([])),
    completePrivacyObjectWriteIntent: vi.fn(() => Promise.resolve(true)),
    releasePrivacyObjectWriteIntentLease: vi.fn(() => Promise.resolve(true)),
    claimDueDeletionRequests: vi.fn(() => Promise.resolve([])),
    claimDueSecretDeletions: vi.fn(() => Promise.resolve([])),
    markSecretDeletionRequested: vi.fn(() => Promise.resolve(true)),
    markSecretUnreadable: vi.fn(() => Promise.resolve(true)),
    listDueDeletionObjectVersions: vi.fn(() =>
      Promise.resolve({ outcome: 'SUCCEEDED' as const, objects: [], hasMore: false }),
    ),
    markDeletionObjectVersionDeleted: vi.fn(() => Promise.resolve(true)),
    releaseDeletionLease: vi.fn(() => Promise.resolve(true)),
    getBackupDeletionVerificationTarget: vi.fn((input: { requestId: string }) =>
      Promise.resolve({
        outcome: 'SUCCEEDED' as const,
        target: {
          requestId: input.requestId,
          sourceDeletedAt: '2026-05-23T06:00:00.000Z',
        },
      }),
    ),
    recordBackupDeletionVerification: vi.fn(() => Promise.resolve(true)),
    getDeletionObjectInventoryTarget: vi.fn(() =>
      Promise.resolve({ outcome: 'NOT_REQUIRED' as const }),
    ),
    recordDeletionObjectInventory: vi.fn(() => Promise.resolve(true)),
    claimPendingLegalHoldReconciliations: vi.fn(() => Promise.resolve([])),
    completeLegalHoldReconciliation: vi.fn(() => Promise.resolve(true)),
    releaseLegalHoldReconciliationLease: vi.fn(() => Promise.resolve(true)),
    finalizeDeletion: vi.fn(() =>
      Promise.resolve({
        outcome: 'SUCCEEDED' as const,
        finalization: {
          requestId: randomUUID(),
          state: 'ACTIVE_DATA_DELETED' as const,
          effectiveAt: NOW.toISOString(),
          tombstoneId: null,
        },
      }),
    ),
    ...overrides,
  };
}

const absentObjectStorage = {
  putExportVersion: () => Promise.reject(new Error('UNEXPECTED_PRIVACY_WRITE')),
  putLockedAuditVersion: () => Promise.reject(new Error('UNEXPECTED_PRIVACY_WRITE')),
  deleteExportVersion: () => Promise.resolve({ outcome: 'NOT_FOUND' as const }),
  deleteAuditVersion: () => Promise.resolve({ outcome: 'NOT_FOUND' as const }),
  holdExportVersion: () => Promise.resolve(true),
  releaseExportVersionHold: () => Promise.resolve(true),
  holdAuditVersion: () => Promise.resolve(true),
  releaseAuditVersionHold: () => Promise.resolve(true),
  listPrivacyObjectVersions: () => Promise.resolve({ versions: [], nextCursor: null }),
};

function backupEvidence(requestId: string, sourceDeletedAt: string, verifiedAt: string) {
  const evidenceCanonicalJson = JSON.stringify({
    inventoryMethod: 'ListRecoveryPointsByResource',
    managedByAWSBackupOnly: false,
    requestId: requestId.toLowerCase(),
    schemaVersion: '2.0.0',
    sourceDeletedAt,
    verifiedAt,
  });
  return {
    evidenceCanonicalJson,
    evidenceHash: createHash('sha256').update(evidenceCanonicalJson).digest('hex'),
  };
}
