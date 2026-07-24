import type {
  BackupDeletionEvidenceStore,
  DeletionObjectInventoryStore,
  LegalHoldReconciliationStore,
  PhysicalDeletionLifecycleStore,
  PrivacyAuditStore,
  PrivacyObjectWriteIntentStore,
} from '@aeostudio/application/privacy-audit';
import { describe, expect, test } from 'vitest';

import { resolveProductionPrivacyLifecycleWorkerRuntime } from '../../apps/worker/src/production-privacy-lifecycle-worker-runtime.js';

const lifecycleStore = {
  claimDueDeletionRequests: () => Promise.resolve([]),
  claimDueSecretDeletions: () => Promise.resolve([]),
  markSecretDeletionRequested: () => Promise.resolve(true),
  markSecretUnreadable: () => Promise.resolve(true),
  finalizeDeletion: () => Promise.resolve({ outcome: 'NOT_FOUND' as const }),
  listDueDeletionObjectVersions: () =>
    Promise.resolve({ outcome: 'SUCCEEDED' as const, objects: [], hasMore: false }),
  markDeletionObjectVersionDeleted: () => Promise.resolve(true),
  releaseDeletionLease: () => Promise.resolve(true),
  getBackupDeletionVerificationTarget: () => Promise.resolve({ outcome: 'NOT_DUE' as const }),
  recordBackupDeletionVerification: () => Promise.resolve(true),
  getDeletionObjectInventoryTarget: () => Promise.resolve({ outcome: 'NOT_REQUIRED' as const }),
  recordDeletionObjectInventory: () => Promise.resolve(true),
  claimPendingLegalHoldReconciliations: () => Promise.resolve([]),
  completeLegalHoldReconciliation: () => Promise.resolve(true),
  releaseLegalHoldReconciliationLease: () => Promise.resolve(true),
  claimPendingPrivacyObjectWriteIntents: () => Promise.resolve([]),
  completePrivacyObjectWriteIntent: () => Promise.resolve(true),
  releasePrivacyObjectWriteIntentLease: () => Promise.resolve(true),
} satisfies Pick<
  PrivacyAuditStore,
  | 'claimDueDeletionRequests'
  | 'claimDueSecretDeletions'
  | 'markSecretDeletionRequested'
  | 'markSecretUnreadable'
  | 'finalizeDeletion'
> &
  PhysicalDeletionLifecycleStore &
  BackupDeletionEvidenceStore &
  DeletionObjectInventoryStore &
  LegalHoldReconciliationStore &
  PrivacyObjectWriteIntentStore;

const secrets = {
  requestForceDelete: () => Promise.resolve(),
  verifyUnreadable: () => Promise.resolve(true),
};

const objects = {
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

const backupVerifier = {
  verifyExpired: () => Promise.resolve({ outcome: 'RECOVERY_POINTS_RETAINED' as const }),
};

describe('Task 18 production credential separation', () => {
  test('the privacy lifecycle runtime uses its explicit shared lifecycle pool budget', async () => {
    const runtime = resolveProductionPrivacyLifecycleWorkerRuntime({
      environment: {
        NODE_ENV: 'production',
        LIFECYCLE_DATABASE_URL: 'postgresql://lifecycle@database/aeostudio',
        PRIVACY_DATABASE_POOL_MAX: '2',
      },
      secrets,
      objects,
      store: lifecycleStore,
      backupVerifier,
    });

    expect(runtime.components.pool.options.max).toBe(2);
    await runtime.close();
  });

  test('the privacy lifecycle runtime requires its dedicated NOBYPASSRLS login', () => {
    expect(() =>
      resolveProductionPrivacyLifecycleWorkerRuntime({
        environment: {
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://runtime@database/aeostudio',
        },
        secrets,
        objects,
        store: lifecycleStore,
      }),
    ).toThrow('LIFECYCLE_DATABASE_URL_REQUIRED_FOR_PRIVACY_LIFECYCLE_WORKER');
  });

  test('the privacy lifecycle runtime accepts the dedicated lifecycle URL without an application URL', async () => {
    const runtime = resolveProductionPrivacyLifecycleWorkerRuntime({
      environment: {
        NODE_ENV: 'production',
        LIFECYCLE_DATABASE_URL: 'postgresql://lifecycle@database/aeostudio',
        PRIVACY_DATABASE_POOL_MAX: '2',
      },
      secrets,
      objects,
      store: lifecycleStore,
      backupVerifier,
    });

    expect(runtime.components.store).toBe(lifecycleStore);
    await runtime.close();
  });

  test('the privacy lifecycle runtime composes one capability gateway without legacy cloud ports', async () => {
    const lifecycleGateway = {
      putAuthorizedPrivacyVersion: () => Promise.reject(new Error('UNUSED_PRIVACY_PUT')),
      recoverAuthorizedWorkloadVersion: () => Promise.resolve({ outcome: 'UNKNOWN' as const }),
      requestAuthorizedConnectorSecretForceDelete: () => Promise.resolve(),
      verifyAuthorizedConnectorSecretUnreadable: () => Promise.resolve(true),
      listAuthorizedObjectVersions: () => Promise.resolve({ versions: [], nextCursor: null }),
      headAuthorizedDeletionObject: () => Promise.resolve({ exists: false as const }),
      getAuthorizedDeletionObjectLegalHold: () => Promise.resolve('OFF' as const),
      deleteAuthorizedObjectVersion: () => Promise.resolve('DELETED' as const),
      reconcileAuthorizedObjectLegalHold: () => Promise.resolve(true),
    };

    const runtime = resolveProductionPrivacyLifecycleWorkerRuntime({
      environment: {
        NODE_ENV: 'production',
        LIFECYCLE_DATABASE_URL: 'postgresql://lifecycle@database/aeostudio',
        PRIVACY_DATABASE_POOL_MAX: '2',
      },
      lifecycleGateway,
      store: lifecycleStore,
      backupVerifier,
    });

    expect(runtime.components.lifecycleGateway).toBe(lifecycleGateway);
    expect(runtime.components.secrets).toBe(lifecycleGateway);
    expect(runtime.components.workloadWrites.objects).toBe(lifecycleGateway);
    await runtime.close();
  });
});
