import { describe, expect, test, vi } from 'vitest';

import { createChannelAuthorizationValidationRuntime } from './production-channel-authorization-validation-runtime.js';

describe('production Channel authorization validation runtime', () => {
  test('drains validation commands and exits without owning the shared database pool', async () => {
    const abort = new AbortController();
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'VERIFIED',
        authorizationId: '00000000-0000-7000-8000-00000000c001',
      })
      .mockImplementationOnce(() => {
        abort.abort();
        return Promise.resolve({ outcome: 'IDLE' });
      });
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const runtime = createChannelAuthorizationValidationRuntime({
      handler: { runOnce },
      workerId: 'channel-authorization-validator-test',
      logger,
      pollIntervalMs: 1,
    });

    await expect(runtime.run(abort.signal)).resolves.toBeUndefined();
    await runtime.close();

    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith('CHANNEL_AUTHORIZATION_VALIDATION_RUNTIME_STARTED');
    expect(logger.info).toHaveBeenCalledWith('CHANNEL_AUTHORIZATION_VALIDATION_RUNTIME_STOPPED');
  });
});
