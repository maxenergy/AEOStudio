import type {
  AuditEvidenceObjectLockStore,
  BackupDeletionEvidenceStore,
  BackupDeletionVerifier,
  DeletionObjectInventoryStore,
  LegalHoldReconciliationStore,
  PhysicalDeletionLifecycleStore,
  PrivacyAuditStore,
  PrivacyObjectWriteIntentStore,
  PrivacyObjectVersionInventory,
  TenantExportObjectStorage,
  WorkloadObjectDeletionStorage,
  WorkloadObjectRecoveryStorage,
  WorkloadObjectWriteIntentStore,
} from '@aeostudio/application/privacy-audit';
import type { CapabilityBoundWorkloadObjectRecovery } from '@aeostudio/application/tenant-data-access';
import type {
  CapabilityBoundDeletionInventoryGateway,
  CapabilityBoundLegalHoldGateway,
  CapabilityBoundObjectDeletionGateway,
  CapabilityBoundPrivacyObjectWriter,
  CapabilityBoundSecretLifecycleGateway,
} from '@aeostudio/adapters/tenant-data-broker';
import { PostgresPrivacyAuditStore, PostgresWorkloadObjectWriteIntentStore } from '@aeostudio/db';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import {
  PrivacyLifecycleWorker,
  type PrivacyLifecycleSecretManager,
} from './privacy-lifecycle-worker.js';
import { readRequiredDatabasePoolMax } from './production-worker-capacity.js';

export interface ProductionPrivacyLifecycleWorkerEnvironment {
  [name: string]: string | undefined;
  AEOSTUDIO_AUTH_MODE?: string;
  LIFECYCLE_DATABASE_URL?: string;
  PRIVACY_DATABASE_POOL_MAX?: string;
  NODE_ENV?: string;
}

export type ProductionPrivacyLifecycleCapabilityGateway = CapabilityBoundPrivacyObjectWriter &
  CapabilityBoundSecretLifecycleGateway &
  CapabilityBoundDeletionInventoryGateway &
  CapabilityBoundObjectDeletionGateway &
  CapabilityBoundLegalHoldGateway &
  CapabilityBoundWorkloadObjectRecovery;

export function resolveProductionPrivacyLifecycleWorkerRuntime(input: {
  environment: ProductionPrivacyLifecycleWorkerEnvironment;
  secrets?: PrivacyLifecycleSecretManager;
  lifecycleGateway?: ProductionPrivacyLifecycleCapabilityGateway;
  clock?: { now(): Date };
  ids?: { next(): string };
  backupVerifier?: BackupDeletionVerifier;
  workloadObjects?: WorkloadObjectRecoveryStorage | CapabilityBoundWorkloadObjectRecovery;
  workloadIntents?: WorkloadObjectWriteIntentStore;
  objects?: Pick<
    TenantExportObjectStorage,
    'putExportVersion' | 'deleteExportVersion' | 'holdExportVersion' | 'releaseExportVersionHold'
  > &
    Pick<
      AuditEvidenceObjectLockStore,
      | 'putLockedAuditVersion'
      | 'deleteAuditVersion'
      | 'holdAuditVersion'
      | 'releaseAuditVersionHold'
    > &
    PrivacyObjectVersionInventory &
    Partial<WorkloadObjectDeletionStorage>;
  store?: Pick<
    PrivacyAuditStore,
    | 'claimDueDeletionRequests'
    | 'claimDueSecretDeletions'
    | 'markSecretDeletionRequested'
    | 'markSecretUnreadable'
    | 'finalizeDeletion'
  > &
    PhysicalDeletionLifecycleStore &
    BackupDeletionEvidenceStore &
    LegalHoldReconciliationStore &
    PrivacyObjectWriteIntentStore &
    DeletionObjectInventoryStore;
  pool?: Pool;
}) {
  if (input.environment.AEOSTUDIO_AUTH_MODE === 'fake') {
    throw new Error('FAKE_RUNTIME_FORBIDDEN_IN_PRODUCTION');
  }
  if (
    input.environment.LIFECYCLE_DATABASE_URL === undefined ||
    input.environment.LIFECYCLE_DATABASE_URL.length === 0
  ) {
    throw new Error('LIFECYCLE_DATABASE_URL_REQUIRED_FOR_PRIVACY_LIFECYCLE_WORKER');
  }
  const secrets = input.lifecycleGateway ?? input.secrets;
  if (secrets === undefined) {
    throw new Error('PRIVACY_LIFECYCLE_SECRET_MANAGER_REQUIRED');
  }
  if (input.backupVerifier === undefined) {
    throw new Error('PRIVACY_LIFECYCLE_BACKUP_VERIFIER_REQUIRED');
  }
  if (input.lifecycleGateway === undefined && input.objects === undefined) {
    throw new Error('PRIVACY_LIFECYCLE_OBJECT_STORAGE_REQUIRED');
  }
  const poolMax = readRequiredDatabasePoolMax(
    input.environment.PRIVACY_DATABASE_POOL_MAX,
    'PRIVACY_DATABASE_POOL_MAX',
  );
  const pool =
    input.pool ??
    new Pool({
      connectionString: input.environment.LIFECYCLE_DATABASE_URL,
      max: poolMax,
    });
  const store = input.store ?? new PostgresPrivacyAuditStore(pool);
  const workloadIntents = input.workloadIntents ?? new PostgresWorkloadObjectWriteIntentStore(pool);
  const workloadObjects = input.lifecycleGateway ?? input.workloadObjects;
  const worker = new PrivacyLifecycleWorker(store, secrets, {
    clock: input.clock ?? { now: () => new Date() },
    ids: input.ids ?? { next: uuidv7 },
    backupVerifier: input.backupVerifier,
    ...(input.objects === undefined ? {} : { objects: input.objects }),
    ...(input.lifecycleGateway === undefined
      ? {}
      : {
          lifecycleGateway: input.lifecycleGateway,
          privacyWrites: input.lifecycleGateway,
        }),
    ...(workloadObjects === undefined
      ? {}
      : {
          workloadWrites: {
            intents: workloadIntents,
            objects: workloadObjects,
          },
        }),
  });
  const workloadWrites =
    workloadObjects === undefined ? null : { intents: workloadIntents, objects: workloadObjects };
  return {
    run: (signal: AbortSignal) => worker.run(signal),
    close: () => pool.end(),
    components: {
      pool,
      store,
      secrets,
      objects: input.objects ?? null,
      lifecycleGateway: input.lifecycleGateway ?? null,
      backupVerifier: input.backupVerifier,
      workloadWrites,
      worker,
    },
  };
}
