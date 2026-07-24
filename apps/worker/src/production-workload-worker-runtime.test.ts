import { describe, expect, test, vi } from 'vitest';
import {
  AwsS3WorkloadObjectStorage,
  DurableWorkloadObjectStorage,
  type DurableWorkloadObjectStorageGateway,
} from '@aeostudio/adapters/storage';
import type { CrawlPageFetcher } from '@aeostudio/application/site-crawl';

import type { MeasurementQueueConsumer } from './measurement-worker-runtime.js';
import { resolveProductionWorkloadWorkerRuntime } from './production-workload-worker-runtime.js';

describe('production workload Worker runtime', () => {
  test('binds crawl, generation and publish consumers to PostgreSQL-backed processors', async () => {
    const queue = (): MeasurementQueueConsumer => ({
      receive: vi.fn(() => Promise.resolve(null)),
    });
    const queues = { crawl: queue(), generation: queue(), publish: queue() };
    const crawler: CrawlPageFetcher = {
      fetch: () => Promise.resolve({ outcome: 'FETCH_FAILED', errorCode: 'TRANSPORT_ERROR' }),
    };
    const runtime = resolveProductionWorkloadWorkerRuntime({
      environment: {
        NODE_ENV: 'production',
        AEO_ENVIRONMENT: 'staging',
        DATABASE_URL: 'postgresql://127.0.0.1:1/workload-composition',
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
        GENERATION_CAPACITY_PROBE_REQUEST_ID_SUFFIX: '0050',
        GENERATION_CAPACITY_PROBE_HOLD_MS: '10000',
      },
      queues,
      storage: { storage: rawStorage() },
      crawler,
      publicationPackages: {
        readPublicationPackage: () => Promise.resolve(null),
      },
      publicationAuthorizationMaterials: {
        readForPublication: () => Promise.resolve(null),
      },
      publicationSecrets: {
        readPublicationSecret: () => Promise.reject(new Error('not configured')),
      },
    });

    expect(runtime.components.queues).toBe(queues);
    expect(runtime.components.processors.profileReadiness).toBeDefined();
    expect(runtime.components.processors.siteCrawl).toBeDefined();
    expect(runtime.components.processors.contentPlan).toBeDefined();
    expect(runtime.components.processors.artifactGeneration).toBeDefined();
    expect(runtime.components.processors.publication).toBeDefined();
    expect(
      (
        [
          ['git-pull-request', '1.0.0'],
          ['wordpress-woocommerce-draft', '1.0.0'],
          ['shopify-draft', '1.0.0'],
          ['signed-webhook', '1.0.0'],
        ] as const
      ).map(([adapterKey, adapterVersion]) =>
        runtime.components.publicationAdapters.resolve(adapterKey, adapterVersion)?.describe(),
      ),
    ).toEqual([
      expect.objectContaining({ adapterKey: 'git-pull-request' }),
      expect.objectContaining({ adapterKey: 'wordpress-woocommerce-draft' }),
      expect.objectContaining({ adapterKey: 'shopify-draft' }),
      expect.objectContaining({ adapterKey: 'signed-webhook' }),
    ]);
    expect(runtime.components.signedWebhookEndpointVerifications.constructor.name).toBe(
      'PostgresSignedWebhookEndpointVerificationStore',
    );
    expect(runtime.components.storage).toBeInstanceOf(DurableWorkloadObjectStorage);
    expect(runtime.components.capacity).toMatchObject({
      maxConcurrentJobs: 32,
      consumers: { crawl: 2, generation: 25, publish: 2, measurement: 3 },
      databaseConnectionBudget: 40,
      databasePools: { workload: 29, measurement: 3 },
    });
    expect(runtime.components.pool.options.max).toBe(29);
    expect(runtime.components.runtimes.crawl.consumerConcurrency).toBe(2);
    expect(runtime.components.runtimes.generation.consumerConcurrency).toBe(25);
    expect(runtime.components.runtimes.publish.consumerConcurrency).toBe(2);
    expect(runtime.components.capacityProbe).toBeDefined();
    await runtime.close();
  });

  test('requires an explicit bounded generation consumer capacity', () => {
    expect(() =>
      resolveProductionWorkloadWorkerRuntime({
        environment: {
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://127.0.0.1:1/workload-composition',
          WORKER_MAX_CONCURRENT_JOBS: '32',
          CRAWL_CONSUMER_CONCURRENCY: '2',
          PUBLISH_CONSUMER_CONCURRENCY: '2',
          MEASUREMENT_CONSUMER_CONCURRENCY: '3',
          WORKLOAD_DATABASE_POOL_MAX: '29',
          MEASUREMENT_DATABASE_POOL_MAX: '3',
          OUTBOX_DATABASE_POOL_MAX: '2',
          PRIVACY_DATABASE_POOL_MAX: '2',
          RUNTIME_ISSUER_DATABASE_POOL_MAX: '2',
          LIFECYCLE_ISSUER_DATABASE_POOL_MAX: '2',
        },
        queues: {
          crawl: { receive: () => Promise.resolve(null) },
          generation: { receive: () => Promise.resolve(null) },
          publish: { receive: () => Promise.resolve(null) },
        },
        storage: { storage: rawStorage() },
        crawler: {
          fetch: () => Promise.resolve({ outcome: 'FETCH_FAILED', errorCode: 'blocked' }),
        },
        publicationPackages: {
          readPublicationPackage: () => Promise.resolve(null),
        },
        publicationAuthorizationMaterials: {
          readForPublication: () => Promise.resolve(null),
        },
        publicationSecrets: {
          readPublicationSecret: () => Promise.resolve(''),
        },
      }),
    ).toThrow('GENERATION_CONSUMER_CONCURRENCY_REQUIRED');
  });

  test('rejects fake runtime modes before constructing any processor', () => {
    expect(() =>
      resolveProductionWorkloadWorkerRuntime({
        environment: {
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://127.0.0.1:1/workload-composition',
          AEOSTUDIO_AUTH_MODE: 'fake',
        },
        queues: {
          crawl: { receive: () => Promise.resolve(null) },
          generation: { receive: () => Promise.resolve(null) },
          publish: { receive: () => Promise.resolve(null) },
        },
        storage: { storage: rawStorage() },
        crawler: {
          fetch: () => Promise.resolve({ outcome: 'FETCH_FAILED', errorCode: 'blocked' }),
        },
        publicationPackages: {
          readPublicationPackage: () => Promise.resolve(null),
        },
        publicationAuthorizationMaterials: {
          readForPublication: () => Promise.resolve(null),
        },
        publicationSecrets: {
          readPublicationSecret: () => Promise.resolve(''),
        },
      }),
    ).toThrow('FAKE_RUNTIME_FORBIDDEN_IN_PRODUCTION');
  });
});

function rawStorage(): DurableWorkloadObjectStorageGateway {
  const storage = new AwsS3WorkloadObjectStorage(
    {
      putObject: () => Promise.resolve({ VersionId: 'fixture-v1' }),
      headObject: () => Promise.reject(new Error('not configured')),
      getObject: () => Promise.reject(new Error('not configured')),
    },
    {
      region: 'ap-southeast-1',
      accountId: '123456789012',
      bucket: 'aeostudio-test-artifacts',
      kmsKeyArn: 'arn:aws:kms:ap-southeast-1:123456789012:key/12345678-1234-4234-8234-123456789012',
    },
  );
  return {
    prepareArtifactPayload: storage.prepareArtifactPayload.bind(storage),
    get: storage.get.bind(storage),
    prepareChannelPackage: storage.prepareChannelPackage.bind(storage),
    getChannelPackage: storage.getChannelPackage.bind(storage),
    prepareCrawlSnapshot: storage.prepareCrawlSnapshot.bind(storage),
    putAuthorizedWorkloadVersion: (input) => storage.putWorkloadVersion(input),
    async recoverAuthorizedWorkloadVersion(input) {
      const recovered = await storage.recoverWorkloadVersion(input);
      return recovered === null
        ? { outcome: 'ABSENT' as const }
        : { outcome: 'FOUND' as const, object: recovered };
    },
  };
}
