import {
  createAwsBackupDeletionVerifier,
  createAwsSqsJobTransport,
  bindRuntimeBuildIdentity,
  createStructuredApplicationLogger,
  readSingaporeQueueUrl,
  resolveEcsRuntimeBuildIdentity,
  type StructuredApplicationLogger,
} from '@aeostudio/adapters';
import {
  createTenantDataBrokerClientGateway,
  createTenantDataBrokerNodeHttpsClientTransport,
  parseTenantDataBrokerKeyRing,
  TenantDataBrokerHttpClient,
  type TenantDataBrokerClientGateway,
} from '@aeostudio/adapters/tenant-data-broker';
import {
  createProductionPublicationAdapterRegistry,
  type SignedWebhookEndpointVerificationPort,
} from '@aeostudio/adapters/publication';
import type { JobQueuePort, JobQueueRouterPort } from '@aeostudio/application/jobs-budgets';
import type { PublicationAdapterRegistry } from '@aeostudio/application/channels-publishing';
import type { CrawlPageFetcher } from '@aeostudio/application/site-crawl';
import type { BackupDeletionVerifier } from '@aeostudio/application/privacy-audit';
import { PostgresPublicationAuthorizationMaterialReader } from '@aeostudio/db';
import { PostgresTenantDataCapabilityIssuer } from '@aeostudio/db/tenant-data-broker';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import type { MeasurementQueueConsumer } from './measurement-worker-runtime.js';
import { resolveProductionMeasurementWorkerRuntime } from './production-measurement-worker-runtime.js';
import { resolveProductionChannelAuthorizationValidationRuntime } from './production-channel-authorization-validation-runtime.js';
import { resolveProductionOutboxRelayRuntime } from './production-outbox-relay-runtime.js';
import { resolveProductionPrivacyLifecycleWorkerRuntime } from './production-privacy-lifecycle-worker-runtime.js';
import { resolveProductionWorkerCapacity } from './production-worker-capacity.js';
import { createCombinedProductionWorkerRuntime } from './production-worker-runtime.js';
import { resolveProductionWorkloadWorkerRuntime } from './production-workload-worker-runtime.js';
import type { ProductionWorkerLoop } from './production-worker-runtime.js';
import {
  createWorkloadJobQueueRouter,
  type JobWorkload,
  type WorkloadJobQueues,
} from './workload-job-queue-router.js';

export interface ProductionWorkerEnvironment {
  [name: string]: string | undefined;
  AEOSTUDIO_AUTH_MODE?: string;
  AEOSTUDIO_MEASUREMENT_PROVIDER_MODE?: string;
  AEOSTUDIO_MEASUREMENT_QUEUE_TRANSPORT?: string;
  ARTIFACT_BUCKET?: string;
  AUDIT_EVIDENCE_BUCKET?: string;
  AWS_ACCOUNT_ID?: string;
  AWS_REGION?: string;
  BACKUP_VAULT_NAME?: string;
  CRAWL_QUEUE_URL?: string;
  DATABASE_URL?: string;
  GENERATION_QUEUE_URL?: string;
  LIFECYCLE_DATABASE_URL?: string;
  MEASUREMENT_QUEUE_URL?: string;
  NODE_ENV?: string;
  PUBLISH_QUEUE_URL?: string;
  RDS_INSTANCE_ARN?: string;
  RDS_INSTANCE_IDENTIFIER?: string;
  S3_KMS_KEY_ARN?: string;
  SESSION_ENCRYPTION_KEY?: string;
  ECS_CONTAINER_METADATA_URI_V4?: string;
  TENANT_DATA_BROKER_ENDPOINT?: string;
  TENANT_DATA_BROKER_AUDIENCE?: string;
  TENANT_DATA_BROKER_HMAC_KEY_RING?: string;
}

interface SqsTransportResource {
  producer: JobQueuePort;
  consumer: MeasurementQueueConsumer;
  close(): Promise<void>;
}

interface BackupVerifierResource {
  verifier: BackupDeletionVerifier;
  close(): Promise<void>;
}

export interface TenantDataBrokerClientResource {
  workload: TenantDataBrokerClientGateway;
  lifecycle: TenantDataBrokerClientGateway;
  components?: { runtimePool: Pool; lifecyclePool: Pool };
  close(): Promise<void>;
}

export interface ProductionTenantDataBrokerClientOptions {
  runtimeDatabaseUrl: string;
  lifecycleDatabaseUrl: string;
  runtimeDatabasePoolMax: number;
  lifecycleDatabasePoolMax: number;
  endpoint: string;
  audience: string;
  signingKeyRing: string;
  artifactBucket: string;
  auditEvidenceBucket: string;
  accountId: string;
  requestTimeoutMs: number;
  clock: { now(): Date };
}

export async function createProductionWorkerRuntime(input: {
  environment: ProductionWorkerEnvironment;
  logger?: StructuredApplicationLogger;
  sqsFactory?: (input: { queueUrl: string }) => Promise<SqsTransportResource>;
  outboxFactory?: (input: {
    databaseUrl: string;
    queueRouter: JobQueueRouterPort;
    logger: StructuredApplicationLogger;
  }) => ProductionWorkerLoop;
  backupFactory?: (
    input: Parameters<typeof createAwsBackupDeletionVerifier>[0],
  ) => Promise<BackupVerifierResource>;
  tenantDataBrokerFactory?: (
    input: ProductionTenantDataBrokerClientOptions,
  ) => Promise<TenantDataBrokerClientResource>;
  workloadFactory?: typeof resolveProductionWorkloadWorkerRuntime;
  publicationAdapters?: PublicationAdapterRegistry;
  /**
   * Platform-owned durable endpoint verification lookup. When absent, the
   * production signed-webhook Adapter remains installed but fails closed.
   */
  signedWebhookEndpointVerifications?: SignedWebhookEndpointVerificationPort;
  crawler?: CrawlPageFetcher;
}) {
  const region = input.environment.AWS_REGION;
  if (region !== 'ap-southeast-1') throw new Error('AWS_SINGAPORE_REGION_REQUIRED');
  const accountId = input.environment.AWS_ACCOUNT_ID;
  if (accountId === undefined || !/^\d{12}$/u.test(accountId)) {
    throw new Error('AWS_ACCOUNT_ID_REQUIRED');
  }
  const capacity = resolveProductionWorkerCapacity(input.environment);
  const queueUrls = readWorkloadQueueUrls(input.environment, accountId);
  if (input.environment.AEOSTUDIO_MEASUREMENT_QUEUE_TRANSPORT !== 'sqs') {
    throw new Error('PRODUCTION_SQS_TRANSPORT_REQUIRED');
  }
  const runtimeBuildIdentity = await resolveEcsRuntimeBuildIdentity({
    service: 'worker',
    environment: input.environment,
  });
  const logger = bindRuntimeBuildIdentity(
    input.logger ?? createStructuredApplicationLogger({ serviceName: 'aeostudio-worker' }),
    runtimeBuildIdentity,
  );
  const sqs = await createWorkloadSqsTransports(
    queueUrls,
    input.sqsFactory ?? createAwsSqsJobTransport,
  );
  const queueRouter = createWorkloadJobQueueRouter({
    crawl: sqs.crawl.producer,
    generation: sqs.generation.producer,
    publish: sqs.publish.producer,
    measurement: sqs.measurement.producer,
  } satisfies WorkloadJobQueues);
  const sqsResources = Object.values(sqs);

  let tenantDataBroker: TenantDataBrokerClientResource;
  try {
    tenantDataBroker = await (
      input.tenantDataBrokerFactory ?? createProductionTenantDataBrokerClientResource
    )({
      runtimeDatabaseUrl: requireWorkerEnvironment(input.environment, 'DATABASE_URL'),
      lifecycleDatabaseUrl: requireWorkerEnvironment(input.environment, 'LIFECYCLE_DATABASE_URL'),
      runtimeDatabasePoolMax: capacity.databasePools.runtimeIssuer,
      lifecycleDatabasePoolMax: capacity.databasePools.lifecycleIssuer,
      endpoint: requireWorkerEnvironment(input.environment, 'TENANT_DATA_BROKER_ENDPOINT'),
      audience: requireWorkerEnvironment(input.environment, 'TENANT_DATA_BROKER_AUDIENCE'),
      signingKeyRing: requireWorkerEnvironment(
        input.environment,
        'TENANT_DATA_BROKER_HMAC_KEY_RING',
      ),
      artifactBucket: requireEnvironmentValue(input.environment, 'ARTIFACT_BUCKET'),
      auditEvidenceBucket: requireEnvironmentValue(input.environment, 'AUDIT_EVIDENCE_BUCKET'),
      accountId,
      requestTimeoutMs: 30_000,
      clock: { now: () => new Date() },
    });
  } catch (error: unknown) {
    await Promise.allSettled(sqsResources.map((resource) => resource.close()));
    throw error;
  }

  let outbox: ProductionWorkerLoop | undefined;
  let workload: ReturnType<typeof resolveProductionWorkloadWorkerRuntime> | undefined;
  let measurement: ReturnType<typeof resolveProductionMeasurementWorkerRuntime> | undefined;
  let privacy: ReturnType<typeof resolveProductionPrivacyLifecycleWorkerRuntime> | undefined;
  let authorizationValidation:
    ReturnType<typeof resolveProductionChannelAuthorizationValidationRuntime> | undefined;
  let backupVerifier: BackupVerifierResource;
  try {
    const databaseArn = requireEnvironmentValue(input.environment, 'RDS_INSTANCE_ARN');
    const artifactBucket = requireEnvironmentValue(input.environment, 'ARTIFACT_BUCKET');
    const auditBucket = requireEnvironmentValue(input.environment, 'AUDIT_EVIDENCE_BUCKET');
    backupVerifier = await (input.backupFactory ?? createAwsBackupDeletionVerifier)({
      region,
      accountId,
      backupVaultName: requireEnvironmentValue(input.environment, 'BACKUP_VAULT_NAME'),
      databaseArn,
      databaseIdentifier: requireEnvironmentValue(input.environment, 'RDS_INSTANCE_IDENTIFIER'),
      protectedResourceArns: [
        databaseArn,
        `arn:aws:s3:::${artifactBucket}`,
        `arn:aws:s3:::${auditBucket}`,
      ],
      clock: { now: () => new Date() },
    });
  } catch (error: unknown) {
    await Promise.allSettled([
      ...sqsResources.map((resource) => resource.close()),
      tenantDataBroker.close(),
    ]);
    throw error;
  }

  try {
    const databaseUrl = requireWorkerEnvironment(input.environment, 'DATABASE_URL');
    outbox =
      input.outboxFactory?.({ databaseUrl, queueRouter, logger }) ??
      resolveProductionOutboxRelayRuntime({
        environment: input.environment,
        queue: queueRouter,
        logger,
      });
    privacy = resolveProductionPrivacyLifecycleWorkerRuntime({
      environment: input.environment,
      backupVerifier: backupVerifier.verifier,
      lifecycleGateway: tenantDataBroker.lifecycle,
    });
    const publicationAuthorizationMaterials = new PostgresPublicationAuthorizationMaterialReader(
      privacy.components.pool,
    );
    const publicationAdapters =
      input.publicationAdapters ??
      (input.signedWebhookEndpointVerifications === undefined
        ? undefined
        : createProductionPublicationAdapterRegistry({
            signedWebhookEndpointVerifications: input.signedWebhookEndpointVerifications,
          }));
    workload = (input.workloadFactory ?? resolveProductionWorkloadWorkerRuntime)({
      environment: input.environment,
      queues: {
        crawl: sqs.crawl.consumer,
        generation: sqs.generation.consumer,
        publish: sqs.publish.consumer,
      },
      storage: { storage: tenantDataBroker.workload },
      publicationPackages: tenantDataBroker.workload,
      publicationAuthorizationMaterials,
      publicationSecrets: tenantDataBroker.workload,
      ...(publicationAdapters === undefined ? {} : { publicationAdapters }),
      ...(input.crawler === undefined ? {} : { crawler: input.crawler }),
      logger,
    });
    measurement = resolveProductionMeasurementWorkerRuntime({
      environment: input.environment,
      queue: sqs.measurement.consumer,
      logger,
    });
    authorizationValidation = resolveProductionChannelAuthorizationValidationRuntime({
      pool: privacy.components.pool,
      adapters: workload.components.publicationAdapters,
      secrets: tenantDataBroker.lifecycle,
      logger,
    });
    const combined = createCombinedProductionWorkerRuntime({
      outbox,
      workload,
      measurement,
      privacy,
      authorizationValidation,
      logger,
      resources: [...sqsResources, tenantDataBroker, backupVerifier],
    });
    return {
      ...combined,
      components: {
        outbox,
        workload,
        measurement,
        privacy,
        authorizationValidation,
        sqs,
        queueRouter,
        tenantDataBroker,
        backupVerifier,
        logger,
      },
    };
  } catch (error: unknown) {
    await Promise.allSettled([
      outbox?.close(),
      workload?.close(),
      measurement?.close(),
      authorizationValidation?.close(),
      privacy?.close(),
      ...sqsResources.map((resource) => resource.close()),
      tenantDataBroker.close(),
      backupVerifier.close(),
    ]);
    throw error;
  }
}

export async function createProductionTenantDataBrokerClientResource(
  input: ProductionTenantDataBrokerClientOptions,
): Promise<TenantDataBrokerClientResource> {
  const endpoint = new URL(input.endpoint);
  if (endpoint.host !== input.audience) {
    throw new Error('TENANT_DATA_BROKER_ENDPOINT_AUDIENCE_MISMATCH');
  }
  const signingKeys = parseTenantDataBrokerKeyRing(input.signingKeyRing, input.clock);
  const client = new TenantDataBrokerHttpClient({
    endpoint: input.endpoint,
    signingKey: signingKeys.current,
    clock: input.clock,
    nextNonce: uuidv7,
    transport: createTenantDataBrokerNodeHttpsClientTransport(),
  });
  const runtimePool = new Pool({
    connectionString: input.runtimeDatabaseUrl,
    max: requiredPoolMax(input.runtimeDatabasePoolMax),
  });
  const lifecyclePool = new Pool({
    connectionString: input.lifecycleDatabaseUrl,
    max: requiredPoolMax(input.lifecycleDatabasePoolMax),
  });
  try {
    const gatewayOptions = {
      client,
      ids: { next: uuidv7 },
      clock: input.clock,
      buckets: {
        workload: input.artifactBucket,
        tenantExports: input.artifactBucket,
        auditEvidence: input.auditEvidenceBucket,
      },
      requestTimeoutMs: input.requestTimeoutMs,
      expectedBucketOwner: input.accountId,
    };
    const workload = createTenantDataBrokerClientGateway({
      ...gatewayOptions,
      issuer: new PostgresTenantDataCapabilityIssuer(runtimePool),
    });
    const lifecycle = createTenantDataBrokerClientGateway({
      ...gatewayOptions,
      issuer: new PostgresTenantDataCapabilityIssuer(lifecyclePool),
    });
    let closePromise: Promise<void> | null = null;
    return {
      workload,
      lifecycle,
      components: { runtimePool, lifecyclePool },
      close() {
        closePromise ??= closeTenantDataBrokerPools(runtimePool, lifecyclePool);
        return closePromise;
      },
    };
  } catch (error: unknown) {
    await Promise.allSettled([runtimePool.end(), lifecyclePool.end()]);
    throw error;
  }
}

function requiredPoolMax(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new Error('TENANT_DATA_BROKER_ISSUER_DATABASE_POOL_MAX_INVALID');
  }
  return value;
}

async function closeTenantDataBrokerPools(runtimePool: Pool, lifecyclePool: Pool): Promise<void> {
  const results = await Promise.allSettled([runtimePool.end(), lifecyclePool.end()]);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejected !== undefined) throw rejected.reason;
}

const WORKLOAD_QUEUE_ENVIRONMENT = {
  crawl: 'CRAWL_QUEUE_URL',
  generation: 'GENERATION_QUEUE_URL',
  publish: 'PUBLISH_QUEUE_URL',
  measurement: 'MEASUREMENT_QUEUE_URL',
} as const satisfies Record<JobWorkload, keyof ProductionWorkerEnvironment>;

function readWorkloadQueueUrls(
  environment: ProductionWorkerEnvironment,
  accountId: string,
): Record<JobWorkload, string> {
  return Object.fromEntries(
    Object.entries(WORKLOAD_QUEUE_ENVIRONMENT).map(([workload, environmentName]) => {
      const value = environment[environmentName];
      if (value === undefined || value.length === 0) {
        throw new Error(`${environmentName}_REQUIRED`);
      }
      const queueUrl = readSingaporeQueueUrl(value);
      if (new URL(queueUrl).pathname.split('/')[1] !== accountId) {
        throw new Error('SQS_QUEUE_ACCOUNT_SCOPE_MISMATCH');
      }
      return [workload, queueUrl];
    }),
  ) as Record<JobWorkload, string>;
}

async function createWorkloadSqsTransports(
  queueUrls: Record<JobWorkload, string>,
  factory: (input: { queueUrl: string }) => Promise<SqsTransportResource>,
): Promise<Record<JobWorkload, SqsTransportResource>> {
  const resources: Partial<Record<JobWorkload, SqsTransportResource>> = {};
  try {
    for (const workload of Object.keys(WORKLOAD_QUEUE_ENVIRONMENT) as JobWorkload[]) {
      resources[workload] = await factory({ queueUrl: queueUrls[workload] });
    }
  } catch (error: unknown) {
    await Promise.allSettled(Object.values(resources).map((resource) => resource.close()));
    throw error;
  }
  return resources as Record<JobWorkload, SqsTransportResource>;
}

function requireEnvironmentValue(
  environment: ProductionWorkerEnvironment,
  name:
    | 'ARTIFACT_BUCKET'
    | 'AUDIT_EVIDENCE_BUCKET'
    | 'S3_KMS_KEY_ARN'
    | 'BACKUP_VAULT_NAME'
    | 'RDS_INSTANCE_ARN'
    | 'RDS_INSTANCE_IDENTIFIER',
): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}

function requireWorkerEnvironment(
  environment: ProductionWorkerEnvironment,
  name:
    | 'DATABASE_URL'
    | 'LIFECYCLE_DATABASE_URL'
    | 'TENANT_DATA_BROKER_ENDPOINT'
    | 'TENANT_DATA_BROKER_AUDIENCE'
    | 'TENANT_DATA_BROKER_HMAC_KEY_RING',
): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}
