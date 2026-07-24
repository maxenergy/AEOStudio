import { describe, expect, test, vi } from 'vitest';

import { createCombinedProductionWorkerRuntime } from './production-worker-runtime.js';

describe('combined production Worker runtime', () => {
  test('aborts sibling loops and reports only a fixed event when one runtime fails', async () => {
    let privacySignal: AbortSignal | undefined;
    const measurement = {
      run: vi.fn(() => Promise.reject(new Error('token=must-not-reach-stdout'))),
      close: vi.fn(() => Promise.resolve()),
    };
    const workload = {
      run: vi.fn(async (signal: AbortSignal) => {
        if (signal.aborted) return;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      }),
      close: vi.fn(() => Promise.resolve()),
    };
    const outbox = {
      run: vi.fn(async (signal: AbortSignal) => {
        if (signal.aborted) return;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      }),
      close: vi.fn(() => Promise.resolve()),
    };
    const privacy = {
      run: vi.fn(async (signal: AbortSignal) => {
        privacySignal = signal;
        if (signal.aborted) return;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      }),
      close: vi.fn(() => Promise.resolve()),
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const runtime = createCombinedProductionWorkerRuntime({
      outbox,
      workload,
      measurement,
      privacy,
      logger,
    });

    await expect(runtime.run(new AbortController().signal)).rejects.toThrow(
      'PRODUCTION_WORKER_RUNTIME_FAILED',
    );

    expect(privacySignal?.aborted).toBe(true);
    expect(logger.error).toHaveBeenCalledWith('WORKER_RUNTIME_FAILED');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('must-not-reach-stdout');
    await runtime.close();
    await runtime.close();
    expect(measurement.close).toHaveBeenCalledOnce();
    expect(workload.close).toHaveBeenCalledOnce();
    expect(privacy.close).toHaveBeenCalledOnce();
    expect(outbox.close).toHaveBeenCalledOnce();
  });
});
