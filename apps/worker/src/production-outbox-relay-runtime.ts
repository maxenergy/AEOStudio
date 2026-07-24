import {
  openTelemetryJobTraceContextRunner,
  type StructuredApplicationLogger,
} from '@aeostudio/adapters/observability';
import {
  OutboxRelay,
  type JobQueuePort,
  type JobQueueRouterPort,
} from '@aeostudio/application/jobs-budgets';
import { PostgresJobBudgetStore } from '@aeostudio/db';
import { Pool } from 'pg';

import { createOutboxRelayRuntime } from './outbox-relay-runtime.js';
import { readRequiredDatabasePoolMax } from './production-worker-capacity.js';

export function resolveProductionOutboxRelayRuntime(input: {
  environment: { DATABASE_URL?: string; OUTBOX_DATABASE_POOL_MAX?: string };
  queue: JobQueuePort | JobQueueRouterPort;
  logger: StructuredApplicationLogger;
  clock?: { now(): Date };
}) {
  const databaseUrl = input.environment.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL_REQUIRED_FOR_OUTBOX_RELAY');
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    max: readRequiredDatabasePoolMax(
      input.environment.OUTBOX_DATABASE_POOL_MAX,
      'OUTBOX_DATABASE_POOL_MAX',
    ),
  });
  const clock = input.clock ?? { now: () => new Date() };
  const store = new PostgresJobBudgetStore(pool);
  const relay = new OutboxRelay(store, input.queue, clock, openTelemetryJobTraceContextRunner);
  const runtime = createOutboxRelayRuntime({
    relay,
    logger: input.logger,
    pollIntervalMs: 1_000,
  });
  return {
    ...runtime,
    components: { pool, store, relay, queue: input.queue },
    close: () => pool.end(),
  };
}
