import {
  createReviewedManualMeasurementImportAdapterRegistry,
  MeasurementExecutionHandler,
  type MeasurementSurfaceAdapterRegistry,
} from '@aeostudio/application/measurement';
import { JobWorkerCoordinator } from '@aeostudio/application/jobs-budgets';
import {
  AesGcmSessionCipher,
  PostgresAuthStore,
  PostgresJobBudgetStore,
  PostgresManualMeasurementImportStore,
  PostgresMeasurementRawEvidenceStore,
  PostgresMeasurementStore,
} from '@aeostudio/db';
import type { StructuredApplicationLogger } from '@aeostudio/adapters/observability';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { MeasurementRunJobWorker } from './measurement-run-job-worker.js';
import {
  createMeasurementWorkerRuntime,
  type MeasurementQueueConsumer,
} from './measurement-worker-runtime.js';
import { PostgresMeasurementOutboxQueue } from './postgres-measurement-outbox-queue.js';
import {
  resolveProductionWorkerCapacity,
  type ProductionWorkerCapacityEnvironment,
} from './production-worker-capacity.js';

export interface ProductionMeasurementWorkerEnvironment extends ProductionWorkerCapacityEnvironment {
  [name: string]: string | undefined;
  DATABASE_URL?: string;
  AEOSTUDIO_ALLOW_FAKE_RUNTIME?: string;
  AEOSTUDIO_AUTH_MODE?: string;
  AEOSTUDIO_MEASUREMENT_PROVIDER_MODE?: string;
  AEOSTUDIO_MEASUREMENT_QUEUE_TRANSPORT?: string;
  NODE_ENV?: string;
  SESSION_ENCRYPTION_KEY?: string;
}

export function resolveProductionMeasurementWorkerRuntime(input: {
  environment: ProductionMeasurementWorkerEnvironment;
  configuredAdapters?: MeasurementSurfaceAdapterRegistry;
  clock?: { now(): Date };
  queue?: MeasurementQueueConsumer;
  logger?: StructuredApplicationLogger;
}) {
  if (
    input.environment.AEOSTUDIO_AUTH_MODE === 'fake' ||
    input.environment.AEOSTUDIO_MEASUREMENT_PROVIDER_MODE === 'fake'
  ) {
    throw new Error('FAKE_RUNTIME_FORBIDDEN_IN_PRODUCTION');
  }
  if (input.environment.DATABASE_URL === undefined || input.environment.DATABASE_URL.length === 0) {
    throw new Error('DATABASE_URL_REQUIRED_FOR_MEASUREMENT_WORKER');
  }
  if (
    input.environment.SESSION_ENCRYPTION_KEY === undefined ||
    input.environment.SESSION_ENCRYPTION_KEY.length === 0
  ) {
    throw new Error('SESSION_ENCRYPTION_KEY_REQUIRED_FOR_MEASUREMENT_WORKER');
  }
  if (input.environment.AEOSTUDIO_MEASUREMENT_QUEUE_TRANSPORT === undefined) {
    throw new Error('MEASUREMENT_QUEUE_TRANSPORT_REQUIRED');
  }
  const transport = input.environment.AEOSTUDIO_MEASUREMENT_QUEUE_TRANSPORT;
  if (transport !== 'postgres-outbox' && transport !== 'sqs') {
    throw new Error('MEASUREMENT_QUEUE_TRANSPORT_UNSUPPORTED');
  }
  if (transport === 'sqs' && input.queue === undefined) {
    throw new Error('SQS_MEASUREMENT_QUEUE_CONSUMER_REQUIRED');
  }
  const capacity = resolveProductionWorkerCapacity(input.environment);
  const encryptionKey = Buffer.from(input.environment.SESSION_ENCRYPTION_KEY, 'base64url');
  const pool = new Pool({
    connectionString: input.environment.DATABASE_URL,
    max: capacity.databasePools.measurement,
  });
  const clock = input.clock ?? { now: () => new Date() };
  const authStore = new PostgresAuthStore(pool, new AesGcmSessionCipher(encryptionKey));
  const jobStore = new PostgresJobBudgetStore(pool);
  const measurementStore = new PostgresMeasurementStore(pool);
  const rawEvidenceStore = new PostgresMeasurementRawEvidenceStore(pool);
  const manualImportStore = new PostgresManualMeasurementImportStore(pool);
  const manualAdapters = createReviewedManualMeasurementImportAdapterRegistry(
    manualImportStore,
    clock,
  );
  const adapters: MeasurementSurfaceAdapterRegistry = {
    resolve(providerKey, surfaceKey, adapterVersion) {
      return (
        input.configuredAdapters?.resolve(providerKey, surfaceKey, adapterVersion) ??
        manualAdapters.resolve(providerKey, surfaceKey, adapterVersion)
      );
    },
  };
  const queue =
    transport === 'postgres-outbox'
      ? new PostgresMeasurementOutboxQueue(pool, jobStore, clock)
      : input.queue;
  if (queue === undefined) throw new Error('SQS_MEASUREMENT_QUEUE_CONSUMER_REQUIRED');
  const processor = new MeasurementRunJobWorker(
    new JobWorkerCoordinator(jobStore, clock, { next: uuidv7 }, 'measurement-run-v1'),
    new MeasurementExecutionHandler(
      measurementStore,
      rawEvidenceStore,
      adapters,
      { next: uuidv7 },
      clock,
      {
        observationMethodVersion: 'answer-observation-v1',
        snapshotMethodVersion: 'ai-visibility-snapshot-v1',
      },
    ),
  );
  const runtime = createMeasurementWorkerRuntime({
    queue,
    processor,
    pollIntervalMs: 1_000,
    consumerConcurrency: capacity.consumers.measurement,
    terminalFailureEvent: 'PROVIDER_FAILED',
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });
  return {
    ...runtime,
    components: {
      pool,
      authStore,
      jobStore,
      measurementStore,
      rawEvidenceStore,
      manualImportStore,
      adapters,
      queue,
      capacity,
    },
    close: () => pool.end(),
  };
}
