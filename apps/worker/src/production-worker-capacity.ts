export interface ProductionWorkerCapacityEnvironment {
  [name: string]: string | undefined;
  CRAWL_CONSUMER_CONCURRENCY?: string;
  GENERATION_CONSUMER_CONCURRENCY?: string;
  MEASUREMENT_CONSUMER_CONCURRENCY?: string;
  MEASUREMENT_DATABASE_POOL_MAX?: string;
  OUTBOX_DATABASE_POOL_MAX?: string;
  PRIVACY_DATABASE_POOL_MAX?: string;
  RUNTIME_ISSUER_DATABASE_POOL_MAX?: string;
  LIFECYCLE_ISSUER_DATABASE_POOL_MAX?: string;
  PUBLISH_CONSUMER_CONCURRENCY?: string;
  WORKER_MAX_CONCURRENT_JOBS?: string;
  WORKLOAD_DATABASE_POOL_MAX?: string;
}

export interface ProductionWorkerCapacity {
  maxConcurrentJobs: number;
  databaseConnectionBudget: number;
  consumers: {
    crawl: number;
    generation: number;
    publish: number;
    measurement: number;
  };
  databasePools: {
    workload: number;
    measurement: number;
    outbox: number;
    privacy: number;
    runtimeIssuer: number;
    lifecycleIssuer: number;
  };
}

const MAX_WORKER_DATABASE_CONNECTIONS = 40;

export function resolveProductionWorkerCapacity(
  environment: ProductionWorkerCapacityEnvironment,
): ProductionWorkerCapacity {
  const maxConcurrentJobs = readRequiredBoundedInteger(
    environment.WORKER_MAX_CONCURRENT_JOBS,
    'WORKER_MAX_CONCURRENT_JOBS',
  );
  const consumers = {
    crawl: readRequiredBoundedInteger(
      environment.CRAWL_CONSUMER_CONCURRENCY,
      'CRAWL_CONSUMER_CONCURRENCY',
    ),
    generation: readRequiredBoundedInteger(
      environment.GENERATION_CONSUMER_CONCURRENCY,
      'GENERATION_CONSUMER_CONCURRENCY',
    ),
    publish: readRequiredBoundedInteger(
      environment.PUBLISH_CONSUMER_CONCURRENCY,
      'PUBLISH_CONSUMER_CONCURRENCY',
    ),
    measurement: readRequiredBoundedInteger(
      environment.MEASUREMENT_CONSUMER_CONCURRENCY,
      'MEASUREMENT_CONSUMER_CONCURRENCY',
    ),
  };
  const allocatedConsumers = Object.values(consumers).reduce((total, value) => total + value, 0);
  if (allocatedConsumers > maxConcurrentJobs) {
    throw new Error('WORKER_CONSUMER_CAPACITY_EXCEEDS_GLOBAL_BOUND');
  }
  const databasePools = {
    workload: readRequiredBoundedInteger(
      environment.WORKLOAD_DATABASE_POOL_MAX,
      'WORKLOAD_DATABASE_POOL_MAX',
    ),
    measurement: readRequiredBoundedInteger(
      environment.MEASUREMENT_DATABASE_POOL_MAX,
      'MEASUREMENT_DATABASE_POOL_MAX',
    ),
    outbox: readRequiredBoundedInteger(
      environment.OUTBOX_DATABASE_POOL_MAX,
      'OUTBOX_DATABASE_POOL_MAX',
    ),
    privacy: readRequiredBoundedInteger(
      environment.PRIVACY_DATABASE_POOL_MAX,
      'PRIVACY_DATABASE_POOL_MAX',
    ),
    runtimeIssuer: readRequiredBoundedInteger(
      environment.RUNTIME_ISSUER_DATABASE_POOL_MAX,
      'RUNTIME_ISSUER_DATABASE_POOL_MAX',
    ),
    lifecycleIssuer: readRequiredBoundedInteger(
      environment.LIFECYCLE_ISSUER_DATABASE_POOL_MAX,
      'LIFECYCLE_ISSUER_DATABASE_POOL_MAX',
    ),
  };
  if (databasePools.workload < consumers.crawl + consumers.generation + consumers.publish) {
    throw new Error('WORKLOAD_DATABASE_POOL_CAPACITY_INSUFFICIENT');
  }
  if (databasePools.measurement < consumers.measurement) {
    throw new Error('MEASUREMENT_DATABASE_POOL_CAPACITY_INSUFFICIENT');
  }
  const databaseConnectionBudget = Object.values(databasePools).reduce(
    (total, value) => total + value,
    0,
  );
  if (databaseConnectionBudget > MAX_WORKER_DATABASE_CONNECTIONS) {
    throw new Error('WORKER_DATABASE_CONNECTION_BUDGET_EXCEEDED');
  }
  return { maxConcurrentJobs, consumers, databasePools, databaseConnectionBudget };
}

function readRequiredBoundedInteger(value: string | undefined, name: string): number {
  if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`);
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name}_INVALID`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 64) throw new Error(`${name}_INVALID`);
  return parsed;
}

export function readRequiredDatabasePoolMax(value: string | undefined, name: string): number {
  return readRequiredBoundedInteger(value, name);
}
