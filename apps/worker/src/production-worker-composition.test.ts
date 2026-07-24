import { describe, expect, test, vi } from 'vitest';
import type { JobQueueRouterPort } from '@aeostudio/application/jobs-budgets';
import type { PublicationAdapterRegistry } from '@aeostudio/application/channels-publishing';
import { encodeSignedWebhookTarget } from '@aeostudio/contracts/channels';

import {
  createProductionTenantDataBrokerClientResource,
  createProductionWorkerRuntime,
} from './production-worker-composition.js';
import { resolveProductionWorkloadWorkerRuntime } from './production-workload-worker-runtime.js';

describe('production Worker AWS composition', () => {
  test('bounds both capability issuer PostgreSQL pools explicitly', async () => {
    const resource = await createProductionTenantDataBrokerClientResource({
      runtimeDatabaseUrl: 'postgresql://runtime@database/aeostudio',
      lifecycleDatabaseUrl: 'postgresql://lifecycle@database/aeostudio',
      runtimeDatabasePoolMax: 2,
      lifecycleDatabasePoolMax: 2,
      endpoint: 'https://broker.example.internal/internal/v1/tenant-data',
      audience: 'broker.example.internal',
      signingKeyRing: JSON.stringify({
        schemaVersion: 'aeostudio.tenant-data-broker-key-ring.v1',
        current: {
          id: 'current-2026-07',
          value: Buffer.alloc(32, 41).toString('base64url'),
        },
      }),
      artifactBucket: 'aeostudio-staging-artifacts',
      auditEvidenceBucket: 'aeostudio-staging-audit-evidence',
      accountId: '123456789012',
      requestTimeoutMs: 30_000,
      clock: { now: () => new Date('2026-07-23T13:00:00.000Z') },
    });

    expect(resource.components?.runtimePool.options.max).toBe(2);
    expect(resource.components?.lifecyclePool.options.max).toBe(2);
    await resource.close();
  });

  test('rejects a Broker endpoint whose signed audience is different before opening pools', async () => {
    await expect(
      createProductionTenantDataBrokerClientResource({
        runtimeDatabaseUrl: 'postgresql://runtime@database/aeostudio',
        lifecycleDatabaseUrl: 'postgresql://lifecycle@database/aeostudio',
        runtimeDatabasePoolMax: 2,
        lifecycleDatabasePoolMax: 2,
        endpoint: 'https://broker.example.internal/internal/v1/tenant-data',
        audience: 'substituted.example.internal',
        signingKeyRing: JSON.stringify({
          schemaVersion: 'aeostudio.tenant-data-broker-key-ring.v1',
          current: {
            id: 'current-2026-07',
            value: Buffer.alloc(32, 41).toString('base64url'),
          },
        }),
        artifactBucket: 'aeostudio-staging-artifacts',
        auditEvidenceBucket: 'aeostudio-staging-audit-evidence',
        accountId: '123456789012',
        requestTimeoutMs: 30_000,
        clock: { now: () => new Date('2026-07-23T13:00:00.000Z') },
      }),
    ).rejects.toThrow('TENANT_DATA_BROKER_ENDPOINT_AUDIENCE_MISMATCH');
  });

  test('binds four workload queues and runs a consumer for every routed workload', async () => {
    const tenantDataBrokerClose = vi.fn(() => Promise.resolve());
    const backupClose = vi.fn(() => Promise.resolve());
    const outboxClose = vi.fn(() => Promise.resolve());
    const queueUrls = {
      crawl: 'https://sqs.ap-southeast-1.amazonaws.com/123456789012/aeostudio-crawl',
      generation: 'https://sqs.ap-southeast-1.amazonaws.com/123456789012/aeostudio-generation',
      publish: 'https://sqs.ap-southeast-1.amazonaws.com/123456789012/aeostudio-publish',
      measurement: 'https://sqs.ap-southeast-1.amazonaws.com/123456789012/aeostudio-measurement',
    };
    const transports = Object.fromEntries(
      Object.entries(queueUrls).map(([workload, queueUrl]) => [
        queueUrl,
        {
          producer: { send: vi.fn(() => Promise.resolve()) },
          consumer: { receive: vi.fn(() => Promise.resolve(null)) },
          close: vi.fn(() => Promise.resolve()),
          workload,
        },
      ]),
    );
    const outbox = { run: vi.fn(() => Promise.resolve()), close: outboxClose };
    const workloadGateway = {};
    const lifecycleGateway = {
      readValidationSecret: vi.fn(() => Promise.resolve('provider-validation-secret')),
    };
    const backupVerifier = {
      verifyExpired: vi.fn(() => Promise.resolve({ outcome: 'RECOVERY_POINTS_RETAINED' as const })),
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const findVerifiedEndpoint = vi.fn(() => Promise.resolve(null));

    let queueRouter: JobQueueRouterPort | undefined;
    let publicationAdapters: PublicationAdapterRegistry | undefined;
    const sqsFactory = vi.fn(({ queueUrl }: { queueUrl: string }) => {
      const transport = transports[queueUrl];
      if (transport === undefined) throw new Error(`UNEXPECTED_QUEUE:${queueUrl}`);
      return Promise.resolve(transport);
    });
    const runtime = await createProductionWorkerRuntime({
      environment: {
        NODE_ENV: 'production',
        AWS_REGION: 'ap-southeast-1',
        AWS_ACCOUNT_ID: '123456789012',
        WORKER_MAX_CONCURRENT_JOBS: '32',
        CRAWL_CONSUMER_CONCURRENCY: '2',
        GENERATION_CONSUMER_CONCURRENCY: '25',
        PUBLISH_CONSUMER_CONCURRENCY: '2',
        MEASUREMENT_CONSUMER_CONCURRENCY: '3',
        WORKLOAD_DATABASE_POOL_MAX: '29',
        MEASUREMENT_DATABASE_POOL_MAX: '3',
        OUTBOX_DATABASE_POOL_MAX: '2',
        PRIVACY_DATABASE_POOL_MAX: '2',
        RUNTIME_ISSUER_DATABASE_POOL_MAX: '2',
        LIFECYCLE_ISSUER_DATABASE_POOL_MAX: '2',
        CRAWL_QUEUE_URL: queueUrls.crawl,
        GENERATION_QUEUE_URL: queueUrls.generation,
        PUBLISH_QUEUE_URL: queueUrls.publish,
        MEASUREMENT_QUEUE_URL: queueUrls.measurement,
        DATABASE_URL: 'postgresql://127.0.0.1:1/combined-worker-wiring',
        LIFECYCLE_DATABASE_URL: 'postgresql://127.0.0.1:1/combined-lifecycle-wiring',
        SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 18).toString('base64url'),
        ARTIFACT_BUCKET: 'aeostudio-staging-artifacts',
        AUDIT_EVIDENCE_BUCKET: 'aeostudio-staging-audit-evidence',
        S3_KMS_KEY_ARN:
          'arn:aws:kms:ap-southeast-1:123456789012:key/12345678-1234-4234-8234-123456789012',
        BACKUP_VAULT_NAME: 'aeostudio-staging-backup',
        RDS_INSTANCE_ARN: 'arn:aws:rds:ap-southeast-1:123456789012:db:aeostudio-staging-postgres',
        RDS_INSTANCE_IDENTIFIER: 'aeostudio-staging-postgres',
        AEOSTUDIO_MEASUREMENT_QUEUE_TRANSPORT: 'sqs',
        TENANT_DATA_BROKER_ENDPOINT: 'https://broker.example.internal/internal/v1/tenant-data',
        TENANT_DATA_BROKER_AUDIENCE: 'broker.example.internal',
        TENANT_DATA_BROKER_HMAC_KEY_RING: JSON.stringify({
          schemaVersion: 'aeostudio.tenant-data-broker-key-ring.v1',
          current: {
            id: 'current-2026-07',
            value: Buffer.alloc(32, 41).toString('base64url'),
          },
        }),
      },
      logger,
      signedWebhookEndpointVerifications: { findVerifiedEndpoint },
      sqsFactory,
      outboxFactory: vi.fn(({ queueRouter: routedQueues }: { queueRouter: JobQueueRouterPort }) => {
        queueRouter = routedQueues;
        return outbox;
      }),
      tenantDataBrokerFactory: vi.fn((options) => {
        expect(options).toMatchObject({
          accountId: '123456789012',
          runtimeDatabaseUrl: 'postgresql://127.0.0.1:1/combined-worker-wiring',
          lifecycleDatabaseUrl: 'postgresql://127.0.0.1:1/combined-lifecycle-wiring',
          runtimeDatabasePoolMax: 2,
          lifecycleDatabasePoolMax: 2,
          endpoint: 'https://broker.example.internal/internal/v1/tenant-data',
          audience: 'broker.example.internal',
          artifactBucket: 'aeostudio-staging-artifacts',
          auditEvidenceBucket: 'aeostudio-staging-audit-evidence',
          requestTimeoutMs: 30_000,
        });
        return Promise.resolve({
          workload: workloadGateway as never,
          lifecycle: lifecycleGateway as never,
          close: tenantDataBrokerClose,
        });
      }),
      backupFactory: vi.fn((options) => {
        expect(options).toMatchObject({
          accountId: '123456789012',
          region: 'ap-southeast-1',
          backupVaultName: 'aeostudio-staging-backup',
          databaseArn: 'arn:aws:rds:ap-southeast-1:123456789012:db:aeostudio-staging-postgres',
          databaseIdentifier: 'aeostudio-staging-postgres',
          protectedResourceArns: [
            'arn:aws:rds:ap-southeast-1:123456789012:db:aeostudio-staging-postgres',
            'arn:aws:s3:::aeostudio-staging-artifacts',
            'arn:aws:s3:::aeostudio-staging-audit-evidence',
          ],
        });
        return Promise.resolve({ verifier: backupVerifier, close: backupClose });
      }),
      workloadFactory: vi.fn(
        (options: Parameters<typeof resolveProductionWorkloadWorkerRuntime>[0]) => {
          expect(
            (
              options as Parameters<typeof resolveProductionWorkloadWorkerRuntime>[0] & {
                publicationAuthorizationMaterials?: unknown;
              }
            ).publicationAuthorizationMaterials,
          ).toBeDefined();
          expect(options.publicationAdapters).toBeDefined();
          const adapters = options.publicationAdapters;
          if (adapters === undefined) throw new Error('PRODUCTION_PUBLICATION_ADAPTERS_REQUIRED');
          publicationAdapters = adapters;
          expect(adapters.resolve('git-pull-request', '1.0.0')).not.toBeNull();
          expect(adapters.resolve('wordpress-woocommerce-draft', '1.0.0')).not.toBeNull();
          expect(adapters.resolve('shopify-draft', '1.0.0')).not.toBeNull();
          expect(adapters.resolve('signed-webhook', '1.0.0')).not.toBeNull();
          return resolveProductionWorkloadWorkerRuntime(options);
        },
      ),
    });

    expect(sqsFactory).toHaveBeenCalledTimes(4);
    expect(runtime.components.measurement.components.queue).toBe(
      transports[queueUrls.measurement]?.consumer,
    );
    expect(runtime.components.workload.components.queues).toEqual({
      crawl: transports[queueUrls.crawl]?.consumer,
      generation: transports[queueUrls.generation]?.consumer,
      publish: transports[queueUrls.publish]?.consumer,
    });
    expect(runtime.components.tenantDataBroker.workload).toBe(workloadGateway);
    expect(runtime.components.tenantDataBroker.lifecycle).toBe(lifecycleGateway);
    expect(runtime.components.privacy.components.backupVerifier).toBe(backupVerifier);
    expect(runtime.components.authorizationValidation.components.pool).toBe(
      runtime.components.privacy.components.pool,
    );
    expect(
      (
        runtime.components.workload.components as typeof runtime.components.workload.components & {
          publicationAuthorizationMaterials?: { pool?: unknown };
        }
      ).publicationAuthorizationMaterials?.pool,
    ).toBe(runtime.components.privacy.components.pool);
    expect(runtime.components.authorizationValidation.components.adapters).toBe(
      runtime.components.workload.components.publicationAdapters,
    );
    expect(runtime.components.authorizationValidation.components.secrets).toBe(lifecycleGateway);
    expect(runtime.components.authorizationValidation.components.ownsPool).toBe(false);
    expect(runtime.components.outbox).toBe(outbox);
    const signedWebhook = publicationAdapters?.resolve('signed-webhook', '1.0.0');
    if (signedWebhook === null || signedWebhook === undefined) {
      throw new Error('PRODUCTION_SIGNED_WEBHOOK_ADAPTER_REQUIRED');
    }
    await expect(
      signedWebhook.validateAuthorization({
        target: encodeSignedWebhookTarget({
          schemaVersion: 'signed-webhook-target.v1',
          endpointUrl: 'https://receiver.example.test/hooks/aeostudio',
          receiptUrl: 'https://receiver.example.test/hooks/aeostudio/receipts',
          endpointVerificationId: '00000000-0000-7000-8000-000000009001',
          algorithm: 'HMAC_SHA256',
          keyId: 'production-hmac-1',
        }),
        channelPackage: {
          tenantId: '00000000-0000-7000-8000-000000009011',
          workspaceId: '00000000-0000-7000-8000-000000009012',
          channel: { definitionId: '00000000-0000-7000-8000-000000009013' },
        },
      } as never),
    ).resolves.toEqual({ outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' });
    expect(findVerifiedEndpoint).toHaveBeenCalledWith({
      tenantId: '00000000-0000-7000-8000-000000009011',
      workspaceId: '00000000-0000-7000-8000-000000009012',
      channelDefinitionId: '00000000-0000-7000-8000-000000009013',
      endpointVerificationId: '00000000-0000-7000-8000-000000009001',
    });
    const delivery = {
      messageId: '018f3b76-1000-7000-8000-000000000001',
      payload: {
        jobId: '018f3b76-1000-7000-8000-000000000002',
        tenantId: '018f3b76-1000-7000-8000-000000000003',
        workspaceId: '018f3b76-1000-7000-8000-000000000004',
        schemaVersion: '1.0.0' as const,
      },
    };
    await queueRouter?.route('SITE_CRAWL', delivery);
    await queueRouter?.route('ARTIFACT_GENERATION', delivery);
    await queueRouter?.route('PUBLICATION', delivery);
    await queueRouter?.route('MEASUREMENT', delivery);
    expect(transports[queueUrls.crawl]?.producer.send).toHaveBeenCalledWith(delivery);
    expect(transports[queueUrls.generation]?.producer.send).toHaveBeenCalledWith(delivery);
    expect(transports[queueUrls.publish]?.producer.send).toHaveBeenCalledWith(delivery);
    expect(transports[queueUrls.measurement]?.producer.send).toHaveBeenCalledWith(delivery);
    await runtime.close();
    expect(outboxClose).toHaveBeenCalledOnce();
    for (const transport of Object.values(transports)) {
      expect(transport.close).toHaveBeenCalledOnce();
    }
    expect(tenantDataBrokerClose).toHaveBeenCalledOnce();
    expect(backupClose).toHaveBeenCalledOnce();
  });
});
