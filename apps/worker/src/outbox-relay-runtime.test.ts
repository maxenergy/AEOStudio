import { describe, expect, test, vi } from 'vitest';

import { createOutboxRelayRuntime } from './outbox-relay-runtime.js';

describe('production outbox relay loop', () => {
  test('relays committed rows to SQS and reports only a bounded count', async () => {
    const relay = { relay: vi.fn(() => Promise.resolve(3)) };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const runtime = createOutboxRelayRuntime({ relay, logger, pollIntervalMs: 1 });

    await expect(runtime.runOnce()).resolves.toBe(3);

    expect(relay.relay).toHaveBeenCalledWith(100);
    expect(logger.info).toHaveBeenCalledWith('OUTBOX_MESSAGES_RELAYED', {
      attributes: { outcome: 'SUCCEEDED', count: 3 },
    });
  });
});
