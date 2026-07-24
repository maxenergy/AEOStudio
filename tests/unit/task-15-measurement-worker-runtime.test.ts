import type { JobQueueMessage } from '@aeostudio/application/jobs-budgets';
import { describe, expect, test, vi } from 'vitest';

import {
  createMeasurementWorkerRuntime,
  type MeasurementQueueDelivery,
} from '../../apps/worker/src/measurement-worker-runtime.js';
import { runMeasurementWorkerProcess } from '../../apps/worker/src/measurement-worker-process.js';
import { resolveProductionMeasurementWorkerRuntime } from '../../apps/worker/src/production-measurement-worker-runtime.js';

const message: JobQueueMessage = {
  messageId: '15000000-0000-4000-8000-000000000001',
  payload: {
    jobId: '15000000-0000-4000-8000-000000000002',
    tenantId: '15000000-0000-4000-8000-000000000003',
    workspaceId: '15000000-0000-4000-8000-000000000004',
    schemaVersion: '1.0.0',
  },
};

describe('Task 15 production Measurement Worker runtime', () => {
  test('a queue delivery enters the runtime and is acknowledged only after successful processing', async () => {
    const acknowledge = vi.fn(() => Promise.resolve());
    const release = vi.fn(() => Promise.resolve());
    const delivery: MeasurementQueueDelivery = { message, acknowledge, release };
    const receive = vi.fn(() => Promise.resolve(delivery));
    const process = vi.fn(() => Promise.resolve({ outcome: 'SUCCEEDED' as const }));
    const runtime = createMeasurementWorkerRuntime({
      queue: { receive },
      processor: { process },
      pollIntervalMs: 1,
    });

    await expect(runtime.runOnce()).resolves.toEqual({ outcome: 'SUCCEEDED' });
    expect(process).toHaveBeenCalledWith(message);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  test('passes validated queue trace context to the claimed Job processor', async () => {
    const traceContext = {
      requestId: '15000000-0000-4000-8000-000000000005',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    };
    const process = vi.fn(() => Promise.resolve({ outcome: 'SUCCEEDED' as const }));
    const runtime = createMeasurementWorkerRuntime({
      queue: {
        receive: () =>
          Promise.resolve({
            message,
            traceContext,
            acknowledge: () => Promise.resolve(),
            release: () => Promise.resolve(),
          }),
      },
      processor: { process },
      pollIntervalMs: 1,
      traceRunner: {
        run: (_input, operation) => operation(),
      },
    });

    await expect(runtime.runOnce()).resolves.toEqual({ outcome: 'SUCCEEDED' });
    expect(process).toHaveBeenCalledWith(message, traceContext);
  });

  test('renews SQS visibility while a handler is still processing', async () => {
    vi.useFakeTimers();
    try {
      let finish: ((outcome: { outcome: 'SUCCEEDED' }) => void) | undefined;
      const acknowledge = vi.fn(() => Promise.resolve());
      const release = vi.fn(() => Promise.resolve());
      const extendVisibility = vi.fn(() => Promise.resolve());
      const process = vi.fn(
        () =>
          new Promise<{ outcome: 'SUCCEEDED' }>((resolve) => {
            finish = resolve;
          }),
      );
      const runtime = createMeasurementWorkerRuntime({
        queue: {
          receive: () => Promise.resolve({ message, acknowledge, release, extendVisibility }),
        },
        processor: { process },
        pollIntervalMs: 1,
      });

      const running = runtime.runOnce();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(15_000);

      expect(extendVisibility).toHaveBeenCalledWith(60);
      expect(acknowledge).not.toHaveBeenCalled();

      finish?.({ outcome: 'SUCCEEDED' });
      await expect(running).resolves.toEqual({ outcome: 'SUCCEEDED' });
      expect(acknowledge).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each(['DUPLICATE', 'NOT_AVAILABLE'] as const)(
    '%s deliveries are acknowledged instead of being hot-looped forever',
    async (terminalOutcome) => {
      const acknowledge = vi.fn(() => Promise.resolve());
      const release = vi.fn(() => Promise.resolve());
      const runtime = createMeasurementWorkerRuntime({
        queue: {
          receive: () => Promise.resolve({ message, acknowledge, release }),
        },
        processor: { process: () => Promise.resolve({ outcome: terminalOutcome }) },
        pollIntervalMs: 1,
      });

      await expect(runtime.runOnce()).resolves.toEqual({ outcome: terminalOutcome });
      expect(acknowledge).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
    },
  );

  test.each(['BUSY', 'CONCURRENCY_LIMIT', 'RETRY_WAIT', 'LEASE_LOST'] as const)(
    '%s deliveries are released and backed off before the queue is polled again',
    async (releasedOutcome) => {
      vi.useFakeTimers();
      try {
        const shutdown = new AbortController();
        const acknowledge = vi.fn(() => Promise.resolve());
        const release = vi.fn(() => Promise.resolve());
        const receive = vi.fn(() => {
          if (receive.mock.calls.length === 2) shutdown.abort();
          return Promise.resolve({ message, acknowledge, release });
        });
        const runtime = createMeasurementWorkerRuntime({
          queue: { receive },
          processor: {
            process: () => Promise.resolve({ outcome: releasedOutcome }),
          },
          pollIntervalMs: 100,
        });

        const running = runtime.run(shutdown.signal);
        await vi.advanceTimersByTimeAsync(0);

        expect(receive).toHaveBeenCalledOnce();
        expect(acknowledge).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(99);
        expect(receive).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(1);
        await running;
        expect(receive).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test.each(['CONCURRENCY_LIMIT', 'RETRY_WAIT'] as const)(
    '%s is invisible for the bounded retry window and becomes executable when it expires',
    async (deferredOutcome) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'));
      try {
        let visibleAt = 0;
        const acknowledge = vi.fn(() => Promise.resolve());
        const release = vi.fn((visibilityTimeoutSeconds: number) => {
          visibleAt = Date.now() + visibilityTimeoutSeconds * 1_000;
          return Promise.resolve();
        });
        const delivery: MeasurementQueueDelivery = {
          message,
          acknowledge,
          release,
          extendVisibility: () => Promise.resolve(),
        };
        const receive = vi.fn(() => Promise.resolve(Date.now() < visibleAt ? null : delivery));
        const process = vi
          .fn()
          .mockResolvedValueOnce({ outcome: deferredOutcome })
          .mockResolvedValueOnce({ outcome: 'SUCCEEDED' as const });
        const runtime = createMeasurementWorkerRuntime({
          queue: { receive },
          processor: { process },
          pollIntervalMs: 1,
        });

        await expect(runtime.runOnce()).resolves.toEqual({ outcome: deferredOutcome });
        expect(release).toHaveBeenCalledWith(30);

        await vi.advanceTimersByTimeAsync(29_999);
        await expect(runtime.runOnce()).resolves.toEqual({ outcome: 'IDLE' });
        expect(process).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(1);
        await expect(runtime.runOnce()).resolves.toEqual({ outcome: 'SUCCEEDED' });
        expect(process).toHaveBeenCalledTimes(2);
        expect(acknowledge).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test('the polling runtime exits cleanly after its shutdown signal is aborted', async () => {
    const shutdown = new AbortController();
    const runtime = createMeasurementWorkerRuntime({
      queue: {
        receive: () =>
          Promise.resolve({
            message,
            acknowledge: () => {
              shutdown.abort();
              return Promise.resolve();
            },
            release: () => Promise.resolve(),
          }),
      },
      processor: { process: () => Promise.resolve({ outcome: 'SUCCEEDED' as const }) },
      pollIntervalMs: 1,
    });

    await expect(runtime.run(shutdown.signal)).resolves.toBeUndefined();
  });

  test('runs the configured number of consumers concurrently and drains them on abort', async () => {
    const shutdown = new AbortController();
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const acknowledge = vi.fn(() => Promise.resolve());
    const process = vi.fn(
      () =>
        new Promise<{ outcome: 'SUCCEEDED' }>((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          releases.push(() => {
            active -= 1;
            resolve({ outcome: 'SUCCEEDED' });
          });
        }),
    );
    const runtime = createMeasurementWorkerRuntime({
      queue: {
        receive: () =>
          Promise.resolve({
            message,
            acknowledge,
            release: () => Promise.resolve(),
          }),
      },
      processor: { process },
      pollIntervalMs: 1,
      consumerConcurrency: 3,
    });

    const running = runtime.run(shutdown.signal);
    try {
      await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(3), { timeout: 100 });
      expect(maxActive).toBe(3);
    } finally {
      shutdown.abort();
      for (const release of releases) release();
    }
    await expect(running).resolves.toBeUndefined();
    expect(acknowledge).toHaveBeenCalledTimes(3);
  });

  test.each(['receive', 'process', 'acknowledge', 'release'] as const)(
    'rejects the consumer pool after a bounded number of consecutive %s failures',
    async (failingOperation) => {
      vi.useFakeTimers();
      try {
        let rejection: unknown;
        const acknowledge = vi.fn(() =>
          failingOperation === 'acknowledge'
            ? Promise.reject(new Error('PERMANENT_ACKNOWLEDGE_FAILURE'))
            : Promise.resolve(),
        );
        const release = vi.fn(() =>
          failingOperation === 'release'
            ? Promise.reject(new Error('PERMANENT_RELEASE_FAILURE'))
            : Promise.resolve(),
        );
        const receive = vi.fn(() =>
          failingOperation === 'receive'
            ? Promise.reject(new Error('PERMANENT_RECEIVE_FAILURE'))
            : Promise.resolve({ message, acknowledge, release }),
        );
        const process = vi.fn(() =>
          failingOperation === 'process'
            ? Promise.reject(new Error('PERMANENT_PROCESS_FAILURE'))
            : Promise.resolve({
                outcome:
                  failingOperation === 'release' ? ('BUSY' as const) : ('SUCCEEDED' as const),
              }),
        );
        const runtime = createMeasurementWorkerRuntime({
          queue: { receive },
          processor: { process },
          pollIntervalMs: 1,
          failurePolicy: { maxConsecutiveFailures: 2 },
        });

        const running = runtime.run(new AbortController().signal);
        void running.catch((error: unknown) => {
          rejection = error;
        });
        await vi.advanceTimersByTimeAsync(2);

        expect(receive).toHaveBeenCalledTimes(2);
        expect(rejection).toEqual(new Error('WORKER_CONSUMER_POOL_FAILED'));
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test.each(['process', 'acknowledge', 'release'] as const)(
    'does not let visibility-gap IDLE polls erase the %s failure budget',
    async (failingOperation) => {
      vi.useFakeTimers();
      try {
        let siblingSignal: AbortSignal | undefined;
        let receiveCount = 0;
        const acknowledge = vi.fn(() =>
          failingOperation === 'acknowledge'
            ? Promise.reject(new Error('PERMANENT_ACKNOWLEDGE_FAILURE'))
            : Promise.resolve(),
        );
        const release = vi.fn(() =>
          failingOperation === 'release'
            ? Promise.reject(new Error('PERMANENT_RELEASE_FAILURE'))
            : Promise.resolve(),
        );
        const delivery = { message, acknowledge, release };
        const receive = vi.fn((signal?: AbortSignal) => {
          receiveCount += 1;
          if (receiveCount === 1 || receiveCount === 5) return Promise.resolve(delivery);
          if (receiveCount === 3 || receiveCount === 4) return Promise.resolve(null);
          siblingSignal = signal;
          return new Promise<null>((resolve) => {
            if (signal?.aborted === true) resolve(null);
            else signal?.addEventListener('abort', () => resolve(null), { once: true });
          });
        });
        const process = vi.fn(() =>
          failingOperation === 'process'
            ? Promise.reject(new Error('PERMANENT_PROCESS_FAILURE'))
            : Promise.resolve({
                outcome:
                  failingOperation === 'release' ? ('BUSY' as const) : ('SUCCEEDED' as const),
              }),
        );
        const runtime = createMeasurementWorkerRuntime({
          queue: { receive },
          processor: { process },
          pollIntervalMs: 1,
          consumerConcurrency: 2,
          failurePolicy: { maxConsecutiveFailures: 2 },
        });

        const running = runtime.run(new AbortController().signal);
        const rejected = expect(running).rejects.toThrow('WORKER_CONSUMER_POOL_FAILED');
        await vi.advanceTimersByTimeAsync(3);

        await rejected;
        expect(receive).toHaveBeenCalledTimes(5);
        expect(siblingSignal?.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test.each(['receive', 'process', 'acknowledge', 'release'] as const)(
    'recovers from a transient %s failure before the bounded failure budget is exhausted',
    async (failingOperation) => {
      vi.useFakeTimers();
      try {
        const shutdown = new AbortController();
        let receiveFailures = 0;
        let processFailures = 0;
        let acknowledgeFailures = 0;
        let releaseFailures = 0;
        const acknowledge = vi.fn(() => {
          if (failingOperation === 'acknowledge' && acknowledgeFailures++ === 0) {
            return Promise.reject(new Error('TRANSIENT_ACKNOWLEDGE_FAILURE'));
          }
          shutdown.abort();
          return Promise.resolve();
        });
        const release = vi.fn(() => {
          if (failingOperation === 'release' && releaseFailures++ === 0) {
            return Promise.reject(new Error('TRANSIENT_RELEASE_FAILURE'));
          }
          shutdown.abort();
          return Promise.resolve();
        });
        const receive = vi.fn(() => {
          if (failingOperation === 'receive' && receiveFailures++ === 0) {
            return Promise.reject(new Error('TRANSIENT_RECEIVE_FAILURE'));
          }
          return Promise.resolve({ message, acknowledge, release });
        });
        const process = vi.fn(() => {
          if (failingOperation === 'process' && processFailures++ === 0) {
            return Promise.reject(new Error('TRANSIENT_PROCESS_FAILURE'));
          }
          return Promise.resolve({
            outcome: failingOperation === 'release' ? ('BUSY' as const) : ('SUCCEEDED' as const),
          });
        });
        const logger = {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          flush: vi.fn(),
        };
        const runtime = createMeasurementWorkerRuntime({
          queue: { receive },
          processor: { process },
          pollIntervalMs: 1,
          failurePolicy: { maxConsecutiveFailures: 2 },
          logger,
        });

        const running = runtime.run(shutdown.signal);
        await vi.advanceTimersByTimeAsync(2);

        await expect(running).resolves.toBeUndefined();
        expect(receive).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith('WORKER_OPERATION_RETRY', {
          attributes: {
            operation: failingOperation.toUpperCase(),
            consecutiveFailureCount: 1,
            maxConsecutiveFailures: 2,
          },
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test('aborts a blocked sibling after a consumer exhausts its receive failure budget', async () => {
    vi.useFakeTimers();
    try {
      let siblingSignal: AbortSignal | undefined;
      let receiveCount = 0;
      const receive = vi.fn((signal?: AbortSignal) => {
        receiveCount += 1;
        if (receiveCount === 1 || receiveCount === 3) {
          return Promise.reject(new Error('PERMANENT_RECEIVE_FAILURE'));
        }
        siblingSignal = signal;
        return new Promise<null>((resolve) => {
          if (signal?.aborted === true) resolve(null);
          else signal?.addEventListener('abort', () => resolve(null), { once: true });
        });
      });
      const runtime = createMeasurementWorkerRuntime({
        queue: { receive },
        processor: { process: () => Promise.resolve({ outcome: 'SUCCEEDED' as const }) },
        pollIntervalMs: 1,
        consumerConcurrency: 2,
        failurePolicy: { maxConsecutiveFailures: 2 },
      });

      const running = runtime.run(new AbortController().signal);
      const rejected = expect(running).rejects.toThrow('WORKER_CONSUMER_POOL_FAILED');
      await vi.advanceTimersByTimeAsync(1);

      await rejected;
      expect(receive).toHaveBeenCalledTimes(3);
      expect(siblingSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('aborts sibling consumers and exposes only a fixed error when one pool member fails', async () => {
    let siblingSignal: AbortSignal | undefined;
    let receiveCount = 0;
    const runtime = createMeasurementWorkerRuntime({
      queue: {
        receive: (signal) => {
          receiveCount += 1;
          if (receiveCount === 1) {
            return Promise.reject(new Error('token=must-not-cross-runtime-boundary'));
          }
          siblingSignal = signal;
          return new Promise((resolve) => {
            if (signal?.aborted === true) resolve(null);
            else signal?.addEventListener('abort', () => resolve(null), { once: true });
          });
        },
      },
      processor: { process: () => Promise.resolve({ outcome: 'SUCCEEDED' as const }) },
      pollIntervalMs: 1,
      consumerConcurrency: 2,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: () => {
          throw new Error('LOGGER_SINK_FAILED');
        },
        error: vi.fn(),
        flush: vi.fn(),
      },
    });

    await expect(runtime.run(new AbortController().signal)).rejects.toThrow(
      'WORKER_CONSUMER_POOL_FAILED',
    );
    expect(siblingSignal?.aborted).toBe(true);
  });

  test('the worker process converts SIGTERM into graceful runtime shutdown and cleanup', async () => {
    const listeners = new Map<string, () => void>();
    const signals = {
      once: vi.fn((name: string, listener: () => void) => {
        listeners.set(name, listener);
      }),
      off: vi.fn((name: string, listener: () => void) => {
        if (listeners.get(name) === listener) listeners.delete(name);
      }),
    };
    let observedSignal: AbortSignal | undefined;
    const runtime = {
      run: vi.fn(async (signal: AbortSignal) => {
        observedSignal = signal;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      }),
      close: vi.fn(() => Promise.resolve()),
    };

    const processRun = runMeasurementWorkerProcess({ runtime, signals });
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledOnce());
    listeners.get('SIGTERM')?.();

    await expect(processRun).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(signals.off).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(0);
  });

  test('production startup fails closed when durable PostgreSQL configuration is absent', () => {
    expect(() =>
      resolveProductionMeasurementWorkerRuntime({
        environment: { NODE_ENV: 'production' },
      }),
    ).toThrow('DATABASE_URL_REQUIRED_FOR_MEASUREMENT_WORKER');
  });

  test('production startup requires the durable Auth cipher configuration used by its Postgres composition', () => {
    expect(() =>
      resolveProductionMeasurementWorkerRuntime({
        environment: {
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://127.0.0.1:1/measurement-worker-wiring',
        },
      }),
    ).toThrow('SESSION_ENCRYPTION_KEY_REQUIRED_FOR_MEASUREMENT_WORKER');
  });

  test('production startup fails closed unless an explicit queue transport is selected', () => {
    expect(() =>
      resolveProductionMeasurementWorkerRuntime({
        environment: {
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://127.0.0.1:1/measurement-worker-wiring',
          SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 15).toString('base64url'),
        },
      }),
    ).toThrow('MEASUREMENT_QUEUE_TRANSPORT_REQUIRED');
  });

  test('the production worker cannot be mistaken for an explicitly enabled fake test runtime', () => {
    expect(() =>
      resolveProductionMeasurementWorkerRuntime({
        environment: {
          NODE_ENV: 'test',
          AEOSTUDIO_ALLOW_FAKE_RUNTIME: 'true',
          AEOSTUDIO_AUTH_MODE: 'fake',
          AEOSTUDIO_MEASUREMENT_PROVIDER_MODE: 'fake',
          DATABASE_URL: 'postgresql://127.0.0.1:1/measurement-worker-wiring',
          SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 15).toString('base64url'),
          AEOSTUDIO_MEASUREMENT_QUEUE_TRANSPORT: 'postgres-outbox',
        },
      }),
    ).toThrow('FAKE_RUNTIME_FORBIDDEN_IN_PRODUCTION');
  });

  test('production startup composes durable Postgres stores and the reviewed Manual Import adapter', async () => {
    const resolved = resolveProductionMeasurementWorkerRuntime({
      environment: {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://127.0.0.1:1/measurement-worker-wiring',
        SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 15).toString('base64url'),
        AEOSTUDIO_MEASUREMENT_QUEUE_TRANSPORT: 'postgres-outbox',
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
      },
    });

    expect(resolved.components.authStore.constructor.name).toBe('PostgresAuthStore');
    expect(resolved.components.jobStore.constructor.name).toBe('PostgresJobBudgetStore');
    expect(resolved.components.measurementStore.constructor.name).toBe('PostgresMeasurementStore');
    expect(resolved.components.rawEvidenceStore.constructor.name).toBe(
      'PostgresMeasurementRawEvidenceStore',
    );
    expect(resolved.components.manualImportStore.constructor.name).toBe(
      'PostgresManualMeasurementImportStore',
    );
    expect(
      resolved.components.adapters.resolve('openai', 'chatgpt-search', 'manual-import-v1')
        ?.adapterKey,
    ).toBe('reviewed-manual-import');
    expect(resolved.components.queue.constructor.name).toBe('PostgresMeasurementOutboxQueue');
    await resolved.close();
  });
});
