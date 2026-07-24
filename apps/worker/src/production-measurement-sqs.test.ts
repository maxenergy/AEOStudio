import { describe, expect, test } from 'vitest';

import { resolveProductionMeasurementWorkerRuntime } from './production-measurement-worker-runtime.js';

describe('production Measurement SQS composition', () => {
  test('requires and uses the injected durable SQS consumer for the sqs transport', async () => {
    const queue = { receive: () => Promise.resolve(null) };
    const runtime = resolveProductionMeasurementWorkerRuntime({
      environment: {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://127.0.0.1:1/measurement-worker-wiring',
        SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 18).toString('base64url'),
        AEOSTUDIO_MEASUREMENT_QUEUE_TRANSPORT: 'sqs',
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
      },
      queue,
    });

    expect(runtime.components.queue).toBe(queue);
    expect(runtime.consumerConcurrency).toBe(3);
    expect(runtime.components.capacity.databasePools.measurement).toBe(3);
    expect(runtime.components.pool.options.max).toBe(3);
    await runtime.close();
  });
});
