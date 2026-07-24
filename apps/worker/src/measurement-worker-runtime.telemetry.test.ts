import type { JobQueueMessage } from '@aeostudio/application/jobs-budgets';
import { describe, expect, test, vi } from 'vitest';

import { createMeasurementWorkerRuntime } from './measurement-worker-runtime.js';

const message: JobQueueMessage = {
  messageId: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
  payload: {
    jobId: '018f84b3-7eb8-7c75-9ca5-25278969d3f0',
    tenantId: '018f84b3-7eb8-7c75-9ca5-25278969d3f1',
    workspaceId: '018f84b3-7eb8-7c75-9ca5-25278969d3f2',
    schemaVersion: '1.0.0',
  },
};

describe('measurement Worker telemetry', () => {
  test('correlates a terminal delivery by opaque job and scope IDs without logging payload content', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const runtime = createMeasurementWorkerRuntime({
      queue: {
        receive: () =>
          Promise.resolve({
            message,
            acknowledge: () => Promise.resolve(),
            release: () => Promise.resolve(),
          }),
      },
      processor: { process: () => Promise.resolve({ outcome: 'SUCCEEDED' as const }) },
      pollIntervalMs: 1,
      logger,
    });

    await runtime.runOnce();

    expect(logger.info).toHaveBeenNthCalledWith(1, 'WORKER_JOB_RECEIVED', {
      correlation: { jobId: message.payload.jobId },
      attributes: {
        tenantId: message.payload.tenantId,
        workspaceId: message.payload.workspaceId,
      },
    });
    expect(logger.info).toHaveBeenNthCalledWith(2, 'WORKER_JOB_ACKNOWLEDGED', {
      correlation: { jobId: message.payload.jobId },
      attributes: {
        tenantId: message.payload.tenantId,
        workspaceId: message.payload.workspaceId,
        outcome: 'SUCCEEDED',
      },
    });
    expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(
      /prompt|content|rawResponse|token/iu,
    );
  });

  test.each(['REFERENCE', 'PERSISTENCE', 'EXECUTION', 'JOB_CONTRACT'] as const)(
    'does not misclassify a %s Measurement failure as a Provider failure',
    async (failureSource) => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        flush: vi.fn(),
      };
      const runtime = createMeasurementWorkerRuntime({
        queue: {
          receive: () =>
            Promise.resolve({
              message,
              acknowledge: () => Promise.resolve(),
              release: () => Promise.resolve(),
            }),
        },
        processor: {
          process: () =>
            Promise.resolve({
              outcome: 'FAILED_TERMINAL' as const,
              failureSource,
            }),
        },
        pollIntervalMs: 1,
        terminalFailureEvent: 'PROVIDER_FAILED',
        logger,
      });

      await runtime.runOnce();

      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  test('does not emit a Provider signal from an unclassified failure count', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const runtime = createMeasurementWorkerRuntime({
      queue: {
        receive: () =>
          Promise.resolve({
            message,
            acknowledge: () => Promise.resolve(),
            release: () => Promise.resolve(),
          }),
      },
      processor: {
        process: () => Promise.resolve({ outcome: 'SUCCEEDED' as const, providerFailureCount: 2 }),
      },
      pollIntervalMs: 1,
      terminalFailureEvent: 'PROVIDER_FAILED',
      logger,
    });

    await runtime.runOnce();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('emits a low-cardinality Provider failure signal when a completed run contains failed slots', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const runtime = createMeasurementWorkerRuntime({
      queue: {
        receive: () =>
          Promise.resolve({
            message,
            acknowledge: () => Promise.resolve(),
            release: () => Promise.resolve(),
          }),
      },
      processor: {
        process: () =>
          Promise.resolve({
            outcome: 'SUCCEEDED' as const,
            providerFailureCount: 2,
            failureSource: 'PROVIDER' as const,
          }),
      },
      pollIntervalMs: 1,
      terminalFailureEvent: 'PROVIDER_FAILED',
      logger,
    });

    await runtime.runOnce();

    expect(logger.warn).toHaveBeenCalledWith('PROVIDER_FAILED', {
      correlation: { jobId: message.payload.jobId },
      attributes: {
        tenantId: message.payload.tenantId,
        workspaceId: message.payload.workspaceId,
        outcome: 'SUCCEEDED',
        errorCode: 'MEASUREMENT_PROVIDER_SLOT_ERROR',
        count: 2,
      },
    });
  });

  test('emits the database lease heartbeat failure signal without payload data', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const runtime = createMeasurementWorkerRuntime({
      queue: {
        receive: () =>
          Promise.resolve({
            message,
            acknowledge: () => Promise.resolve(),
            release: () => Promise.resolve(),
          }),
      },
      processor: {
        process: () => Promise.resolve({ outcome: 'LEASE_LOST' as const, heartbeatFailed: true }),
      },
      pollIntervalMs: 1,
      logger,
    });

    await runtime.runOnce();

    expect(logger.warn).toHaveBeenCalledWith('JOB_HEARTBEAT_FAILED', {
      correlation: { jobId: message.payload.jobId },
      attributes: {
        tenantId: message.payload.tenantId,
        workspaceId: message.payload.workspaceId,
        outcome: 'LEASE_LOST',
        errorCode: 'DATABASE_LEASE_HEARTBEAT_FAILED',
      },
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(
      /prompt|content|rawResponse|token/iu,
    );
  });

  test('keeps claim, processing and defer under the extracted Worker trace context', async () => {
    const traceContext = {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      requestId: '018f84b3-7eb8-7c75-9ca5-25278969d3f3',
    };
    let active: unknown;
    const observed: unknown[] = [];
    const release = vi.fn(() => {
      observed.push(active);
      return Promise.resolve();
    });
    const traceRunner = {
      async run<T>(input: { traceContext: unknown }, operation: () => Promise<T>): Promise<T> {
        active = input.traceContext;
        try {
          return await operation();
        } finally {
          active = undefined;
        }
      },
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const runtime = createMeasurementWorkerRuntime({
      queue: {
        receive: () =>
          Promise.resolve({
            message,
            traceContext,
            acknowledge: () => Promise.resolve(),
            release,
          }),
      },
      processor: {
        process: () => {
          observed.push(active);
          return Promise.resolve({ outcome: 'RETRY_WAIT' as const });
        },
      },
      traceRunner,
      pollIntervalMs: 1,
      logger,
    });

    await runtime.runOnce();

    expect(observed).toEqual([traceContext, traceContext]);
    expect(release).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenNthCalledWith(1, 'WORKER_JOB_RECEIVED', {
      correlation: {
        jobId: message.payload.jobId,
        requestId: traceContext.requestId,
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      },
      attributes: {
        tenantId: message.payload.tenantId,
        workspaceId: message.payload.workspaceId,
      },
    });
  });
});
