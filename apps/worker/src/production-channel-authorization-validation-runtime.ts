import type { StructuredApplicationLogger } from '@aeostudio/adapters/observability';
import type { PublicationAdapterRegistry } from '@aeostudio/application/channels-publishing';
import type { LeasedChannelAuthorizationValidationSecretReader } from '@aeostudio/application/tenant-data-access';
import { PostgresChannelAuthorizationValidationStore } from '@aeostudio/db';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import {
  ChannelAuthorizationValidationHandler,
  type ChannelAuthorizationValidationHandlerOutcome,
} from './channel-authorization-validation-handler.js';

export interface ValidationHandler {
  runOnce(workerId: string): Promise<ChannelAuthorizationValidationHandlerOutcome>;
}

export function createChannelAuthorizationValidationRuntime(input: {
  handler: ValidationHandler;
  workerId: string;
  logger: StructuredApplicationLogger;
  pollIntervalMs?: number;
}) {
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > 60_000 ||
    input.workerId.length < 1 ||
    input.workerId.length > 160
  ) {
    throw new Error('CHANNEL_AUTHORIZATION_VALIDATION_RUNTIME_CONFIG_INVALID');
  }
  let started = false;
  let closed = false;
  return {
    async run(signal: AbortSignal): Promise<void> {
      if (started) throw new Error('CHANNEL_AUTHORIZATION_VALIDATION_RUNTIME_ALREADY_STARTED');
      started = true;
      input.logger.info('CHANNEL_AUTHORIZATION_VALIDATION_RUNTIME_STARTED');
      try {
        while (!signal.aborted) {
          let result: ChannelAuthorizationValidationHandlerOutcome;
          try {
            result = await input.handler.runOnce(input.workerId);
          } catch {
            input.logger.error('CHANNEL_AUTHORIZATION_VALIDATION_RUNTIME_FAILED');
            throw new Error('CHANNEL_AUTHORIZATION_VALIDATION_RUNTIME_FAILED');
          }
          if (result.outcome === 'IDLE') {
            await waitForAbort(signal, pollIntervalMs);
          }
        }
      } finally {
        input.logger.info('CHANNEL_AUTHORIZATION_VALIDATION_RUNTIME_STOPPED');
      }
    },
    close(): Promise<void> {
      closed = true;
      return Promise.resolve();
    },
    components: { handler: input.handler, workerId: input.workerId, ownsPool: false as const },
    get closed(): boolean {
      return closed;
    },
  };
}

export function resolveProductionChannelAuthorizationValidationRuntime(input: {
  pool: Pool;
  adapters: PublicationAdapterRegistry;
  secrets: LeasedChannelAuthorizationValidationSecretReader;
  logger: StructuredApplicationLogger;
  ids?: { next(): string };
  clock?: { now(): Date };
  workerId?: string;
  pollIntervalMs?: number;
}) {
  const store = new PostgresChannelAuthorizationValidationStore(input.pool);
  const handler = new ChannelAuthorizationValidationHandler(
    store,
    input.adapters,
    input.secrets,
    input.ids ?? { next: uuidv7 },
    input.clock ?? { now: () => new Date() },
  );
  const runtime = createChannelAuthorizationValidationRuntime({
    handler,
    workerId: input.workerId ?? `channel-authorization-validator-${uuidv7()}`,
    logger: input.logger,
    ...(input.pollIntervalMs === undefined ? {} : { pollIntervalMs: input.pollIntervalMs }),
  });
  return {
    ...runtime,
    components: {
      ...runtime.components,
      store,
      secrets: input.secrets,
      adapters: input.adapters,
      pool: input.pool,
    },
  };
}

function waitForAbort(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, delayMs);
    const abort = () => done();
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}
