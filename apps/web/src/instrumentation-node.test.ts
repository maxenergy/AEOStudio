import { describe, expect, test, vi } from 'vitest';

import { installTelemetryExitBarrier } from './instrumentation.js';

describe('Web Node telemetry exit barrier', () => {
  test('lets Next drain first, then flushes telemetry before forwarding Next signal exit', async () => {
    const listeners = new Map<string, () => void>();
    let release: (() => void) | undefined;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const actualExit = vi.fn();
    const lifecycle = {
      once: vi.fn((signal: string, listener: () => void) => listeners.set(signal, listener)),
      exit: actualExit,
    };

    installTelemetryExitBarrier({ shutdown }, lifecycle, 10_000);
    listeners.get('SIGTERM')?.();
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();
    expect(actualExit).not.toHaveBeenCalled();

    lifecycle.exit(143);
    await Promise.resolve();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(actualExit).not.toHaveBeenCalled();

    release?.();
    await vi.waitFor(() => expect(actualExit).toHaveBeenCalledWith(143));
  });

  test('attempts telemetry cleanup before the fail-safe forces a stuck Next drain to exit', async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Map<string, () => void>();
      const events: string[] = [];
      const shutdown = vi.fn(() => {
        events.push('telemetry');
        return Promise.resolve();
      });
      const actualExit = vi.fn((code: number) => events.push(`exit:${code}`));
      const lifecycle = {
        once: vi.fn((signal: string, listener: () => void) => listeners.set(signal, listener)),
        exit: actualExit,
      };

      installTelemetryExitBarrier({ shutdown }, lifecycle, 100);
      listeners.get('SIGTERM')?.();
      await vi.advanceTimersByTimeAsync(100);

      expect(shutdown).toHaveBeenCalledOnce();
      expect(actualExit).toHaveBeenCalledWith(1);
      expect(events).toEqual(['telemetry', 'exit:1']);
    } finally {
      vi.useRealTimers();
    }
  });
});
