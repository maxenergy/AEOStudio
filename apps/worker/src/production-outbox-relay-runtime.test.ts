import { describe, expect, test, vi } from 'vitest';

import { resolveProductionOutboxRelayRuntime } from './production-outbox-relay-runtime.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  flush: vi.fn(),
};

describe('production outbox relay database capacity', () => {
  test('uses the required explicit bounded PostgreSQL pool', async () => {
    const runtime = resolveProductionOutboxRelayRuntime({
      environment: {
        DATABASE_URL: 'postgresql://127.0.0.1:1/outbox-capacity',
        OUTBOX_DATABASE_POOL_MAX: '2',
      },
      queue: { send: () => Promise.resolve() },
      logger,
    });

    expect(runtime.components.pool.options.max).toBe(2);
    await runtime.close();
  });

  test('fails closed when the outbox PostgreSQL pool budget is absent', () => {
    expect(() =>
      resolveProductionOutboxRelayRuntime({
        environment: { DATABASE_URL: 'postgresql://127.0.0.1:1/outbox-capacity' },
        queue: { send: () => Promise.resolve() },
        logger,
      }),
    ).toThrow('OUTBOX_DATABASE_POOL_MAX_REQUIRED');
  });
});
