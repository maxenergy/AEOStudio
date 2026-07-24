import { describe, expect, it, vi } from 'vitest';

import { runTenantDataBrokerProcess } from './tenant-data-broker-process.js';

describe('tenant data broker process', () => {
  it('owns the broker until SIGTERM and then closes it exactly once', async () => {
    const listeners = new Map<string, () => void>();
    const signals = {
      once: vi.fn((signal: string, listener: () => void) => {
        listeners.set(signal, listener);
      }),
      off: vi.fn((signal: string) => {
        listeners.delete(signal);
      }),
    };
    const runtime = {
      components: {},
      start: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const startRuntime = vi.fn().mockResolvedValue(runtime);

    const running = runTenantDataBrokerProcess({
      environment: {},
      signals,
      startRuntime: startRuntime as never,
    });
    await vi.waitFor(() => expect(startRuntime).toHaveBeenCalledTimes(1));
    expect(listeners.has('SIGINT')).toBe(true);
    expect(listeners.has('SIGTERM')).toBe(true);

    listeners.get('SIGTERM')?.();
    await expect(running).resolves.toBeUndefined();

    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(signals.off).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(0);
  });

  it('preserves startup failure after removing every signal listener', async () => {
    const signals = {
      once: vi.fn(),
      off: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('SIGINT_OFF_FAILED');
        })
        .mockImplementationOnce(() => undefined),
    };

    await expect(
      runTenantDataBrokerProcess({
        environment: {},
        signals,
        startRuntime: vi.fn().mockRejectedValue(new Error('BROKER_START_FAILED')) as never,
      }),
    ).rejects.toThrow('BROKER_START_FAILED');

    expect(signals.once).toHaveBeenCalledTimes(2);
    expect(signals.off).toHaveBeenCalledTimes(2);
  });
});
