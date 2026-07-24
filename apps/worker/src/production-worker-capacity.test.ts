import { describe, expect, test } from 'vitest';

import { resolveProductionWorkerCapacity } from './production-worker-capacity.js';

const boundedCapacity = {
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
};

describe('production Worker capacity contract', () => {
  test('returns one explicit bounded allocation for every asynchronous workload', () => {
    expect(resolveProductionWorkerCapacity(boundedCapacity)).toEqual({
      maxConcurrentJobs: 32,
      databaseConnectionBudget: 40,
      databasePools: {
        workload: 29,
        measurement: 3,
        outbox: 2,
        privacy: 2,
        runtimeIssuer: 2,
        lifecycleIssuer: 2,
      },
      consumers: { crawl: 2, generation: 25, publish: 2, measurement: 3 },
    });
  });

  test('rejects queue allocations that exceed the declared per-task global bound', () => {
    expect(() =>
      resolveProductionWorkerCapacity({
        ...boundedCapacity,
        MEASUREMENT_CONSUMER_CONCURRENCY: '4',
      }),
    ).toThrow('WORKER_CONSUMER_CAPACITY_EXCEEDS_GLOBAL_BOUND');
  });

  test('rejects a database pool smaller than the workload it must sustain', () => {
    expect(() =>
      resolveProductionWorkerCapacity({
        ...boundedCapacity,
        WORKLOAD_DATABASE_POOL_MAX: '28',
      }),
    ).toThrow('WORKLOAD_DATABASE_POOL_CAPACITY_INSUFFICIENT');
    expect(() =>
      resolveProductionWorkerCapacity({
        ...boundedCapacity,
        MEASUREMENT_DATABASE_POOL_MAX: '2',
      }),
    ).toThrow('MEASUREMENT_DATABASE_POOL_CAPACITY_INSUFFICIENT');
  });

  test('requires an explicit bounded pool for every Worker database consumer', () => {
    for (const name of [
      'OUTBOX_DATABASE_POOL_MAX',
      'PRIVACY_DATABASE_POOL_MAX',
      'RUNTIME_ISSUER_DATABASE_POOL_MAX',
      'LIFECYCLE_ISSUER_DATABASE_POOL_MAX',
    ] as const) {
      expect(() =>
        resolveProductionWorkerCapacity({ ...boundedCapacity, [name]: undefined }),
      ).toThrow(`${name}_REQUIRED`);
    }
  });
});
