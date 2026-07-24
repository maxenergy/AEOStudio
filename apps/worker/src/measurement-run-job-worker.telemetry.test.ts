import type { JobQueueMessage, JobWorkerCoordinator } from '@aeostudio/application/jobs-budgets';
import { describe, expect, test, vi } from 'vitest';

import type { MeasurementExecutionHandler } from './measurement-execution-handler.js';
import { MeasurementRunJobWorker } from './measurement-run-job-worker.js';

const message: JobQueueMessage = {
  messageId: 'message-1',
  payload: {
    jobId: 'job-1',
    tenantId: 'tenant-1',
    workspaceId: 'workspace-1',
    schemaVersion: '1.0.0',
  },
};

describe('measurement job lease telemetry outcome', () => {
  test('classifies completed Provider slot errors explicitly when propagating their count', async () => {
    const lease = {
      job: {
        id: message.payload.jobId,
        tenantId: message.payload.tenantId,
        workspaceId: message.payload.workspaceId,
        aggregateId: 'measurement-1',
        jobType: 'MEASUREMENT',
      },
      leaseToken: 'lease-1',
    };
    const coordinator = {
      claim: vi.fn(() => Promise.resolve({ outcome: 'CLAIMED', lease })),
      reportProgress: vi.fn(() => Promise.resolve(true)),
      heartbeat: vi.fn(() => Promise.resolve(true)),
      fail: vi.fn(),
      complete: vi.fn(() => Promise.resolve(true)),
    } as unknown as JobWorkerCoordinator;
    const handler = {
      run: vi.fn(() =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          measurementRunId: 'measurement-1',
          actualUnits: 1,
          snapshotCount: 4,
          providerFailureCount: 1,
        }),
      ),
    } as unknown as MeasurementExecutionHandler;

    const worker = new MeasurementRunJobWorker(coordinator, handler);

    await expect(worker.process(message)).resolves.toEqual({
      outcome: 'SUCCEEDED',
      measurementRunId: 'measurement-1',
      providerFailureCount: 1,
      failureSource: 'PROVIDER',
    });
  });

  test('classifies an invalid Measurement reference separately from Provider failures', async () => {
    const lease = {
      job: {
        id: message.payload.jobId,
        tenantId: message.payload.tenantId,
        workspaceId: message.payload.workspaceId,
        aggregateId: 'measurement-1',
        jobType: 'MEASUREMENT',
      },
      leaseToken: 'lease-1',
    };
    const fail = vi.fn(() => Promise.resolve('FAILED_TERMINAL'));
    const coordinator = {
      claim: vi.fn(() => Promise.resolve({ outcome: 'CLAIMED', lease })),
      reportProgress: vi.fn(() => Promise.resolve(true)),
      heartbeat: vi.fn(() => Promise.resolve(true)),
      fail,
      complete: vi.fn(),
    } as unknown as JobWorkerCoordinator;
    const handler = {
      run: vi.fn(() => Promise.resolve({ outcome: 'INVALID_REFERENCE' as const })),
    } as unknown as MeasurementExecutionHandler;

    const worker = new MeasurementRunJobWorker(coordinator, handler);

    await expect(worker.process(message)).resolves.toEqual({
      outcome: 'FAILED_TERMINAL',
      measurementRunId: 'measurement-1',
      failureSource: 'REFERENCE',
    });
    expect(fail).toHaveBeenCalledWith(lease, 'TERMINAL', 'MEASUREMENT_INVALID_REFERENCE');
  });

  test('classifies an exhausted persistence conflict separately from Provider failures', async () => {
    const lease = {
      job: {
        id: message.payload.jobId,
        tenantId: message.payload.tenantId,
        workspaceId: message.payload.workspaceId,
        aggregateId: 'measurement-1',
        jobType: 'MEASUREMENT',
      },
      leaseToken: 'lease-1',
    };
    const fail = vi.fn(() => Promise.resolve('FAILED_TERMINAL'));
    const coordinator = {
      claim: vi.fn(() => Promise.resolve({ outcome: 'CLAIMED', lease })),
      reportProgress: vi.fn(() => Promise.resolve(true)),
      heartbeat: vi.fn(() => Promise.resolve(true)),
      fail,
      complete: vi.fn(),
    } as unknown as JobWorkerCoordinator;
    const handler = {
      run: vi.fn(() => Promise.resolve({ outcome: 'RETRYABLE_CONFLICT' as const })),
    } as unknown as MeasurementExecutionHandler;

    const worker = new MeasurementRunJobWorker(coordinator, handler);

    await expect(worker.process(message)).resolves.toEqual({
      outcome: 'FAILED_TERMINAL',
      measurementRunId: 'measurement-1',
      failureSource: 'PERSISTENCE',
    });
    expect(fail).toHaveBeenCalledWith(lease, 'RETRYABLE', 'MEASUREMENT_PERSISTENCE_CONFLICT');
  });

  test('classifies an exhausted execution retry separately from Provider failures', async () => {
    const lease = {
      job: {
        id: message.payload.jobId,
        tenantId: message.payload.tenantId,
        workspaceId: message.payload.workspaceId,
        aggregateId: 'measurement-1',
        jobType: 'MEASUREMENT',
      },
      leaseToken: 'lease-1',
    };
    const fail = vi.fn(() => Promise.resolve('FAILED_TERMINAL'));
    const coordinator = {
      claim: vi.fn(() => Promise.resolve({ outcome: 'CLAIMED', lease })),
      reportProgress: vi.fn(() => Promise.resolve(true)),
      heartbeat: vi.fn(() => Promise.resolve(true)),
      fail,
      complete: vi.fn(),
    } as unknown as JobWorkerCoordinator;
    const handler = {
      run: vi.fn(() => Promise.reject(new Error('EXECUTION_INTERRUPTED'))),
    } as unknown as MeasurementExecutionHandler;

    const worker = new MeasurementRunJobWorker(coordinator, handler);

    await expect(worker.process(message)).resolves.toEqual({
      outcome: 'FAILED_TERMINAL',
      measurementRunId: 'measurement-1',
      failureSource: 'EXECUTION',
    });
    expect(fail).toHaveBeenCalledWith(
      lease,
      'RETRYABLE',
      'MEASUREMENT_EXECUTION_TRANSIENT_FAILURE',
    );
  });

  test('classifies an unsupported job contract separately from Provider failures', async () => {
    const lease = {
      job: {
        id: message.payload.jobId,
        tenantId: message.payload.tenantId,
        workspaceId: message.payload.workspaceId,
        aggregateId: 'measurement-1',
        jobType: 'GENERATION',
      },
      leaseToken: 'lease-1',
    };
    const fail = vi.fn(() => Promise.resolve('FAILED_TERMINAL'));
    const coordinator = {
      claim: vi.fn(() => Promise.resolve({ outcome: 'CLAIMED', lease })),
      reportProgress: vi.fn(),
      heartbeat: vi.fn(),
      fail,
      complete: vi.fn(),
    } as unknown as JobWorkerCoordinator;
    const run = vi.fn();
    const handler = { run } as unknown as MeasurementExecutionHandler;

    const worker = new MeasurementRunJobWorker(coordinator, handler);

    await expect(worker.process(message)).resolves.toEqual({
      outcome: 'FAILED_TERMINAL',
      failureSource: 'JOB_CONTRACT',
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('propagates a rejected catch-path heartbeat as a database heartbeat failure', async () => {
    const lease = {
      job: {
        id: message.payload.jobId,
        tenantId: message.payload.tenantId,
        workspaceId: message.payload.workspaceId,
        aggregateId: 'measurement-1',
        jobType: 'MEASUREMENT',
      },
      leaseToken: 'lease-1',
    };
    const fail = vi.fn();
    const coordinator = {
      claim: vi.fn(() => Promise.resolve({ outcome: 'CLAIMED', lease })),
      reportProgress: vi.fn(() => Promise.resolve(true)),
      heartbeat: vi.fn(() => Promise.resolve(false)),
      fail,
      complete: vi.fn(),
    } as unknown as JobWorkerCoordinator;
    const handler = {
      run: vi.fn(() => Promise.reject(new Error('TRANSIENT_PROVIDER_FAILURE'))),
    } as unknown as MeasurementExecutionHandler;

    const worker = new MeasurementRunJobWorker(coordinator, handler);

    await expect(worker.process(message)).resolves.toEqual({
      outcome: 'LEASE_LOST',
      measurementRunId: 'measurement-1',
      heartbeatFailed: true,
    });
    expect(fail).not.toHaveBeenCalled();
  });

  test('propagates a throwing catch-path heartbeat as a database heartbeat failure', async () => {
    const lease = {
      job: {
        id: message.payload.jobId,
        tenantId: message.payload.tenantId,
        workspaceId: message.payload.workspaceId,
        aggregateId: 'measurement-1',
        jobType: 'MEASUREMENT',
      },
      leaseToken: 'lease-1',
    };
    const fail = vi.fn();
    const coordinator = {
      claim: vi.fn(() => Promise.resolve({ outcome: 'CLAIMED', lease })),
      reportProgress: vi.fn(() => Promise.resolve(true)),
      heartbeat: vi.fn(() => Promise.reject(new Error('DATABASE_UNAVAILABLE'))),
      fail,
      complete: vi.fn(),
    } as unknown as JobWorkerCoordinator;
    const handler = {
      run: vi.fn(() => Promise.reject(new Error('TRANSIENT_PROVIDER_FAILURE'))),
    } as unknown as MeasurementExecutionHandler;

    const worker = new MeasurementRunJobWorker(coordinator, handler);

    await expect(worker.process(message)).resolves.toEqual({
      outcome: 'LEASE_LOST',
      measurementRunId: 'measurement-1',
      heartbeatFailed: true,
    });
    expect(fail).not.toHaveBeenCalled();
  });

  test('marks a database heartbeat rejection separately from a generic persistence fence', async () => {
    const lease = {
      job: {
        id: message.payload.jobId,
        tenantId: message.payload.tenantId,
        workspaceId: message.payload.workspaceId,
        aggregateId: 'measurement-1',
        jobType: 'MEASUREMENT',
      },
      leaseToken: 'lease-1',
    };
    const coordinator = {
      claim: vi.fn(() => Promise.resolve({ outcome: 'CLAIMED', lease })),
      reportProgress: vi.fn(() => Promise.resolve(true)),
      heartbeat: vi.fn(() => Promise.resolve(false)),
      fail: vi.fn(),
      complete: vi.fn(),
    } as unknown as JobWorkerCoordinator;
    const handler = {
      run: vi.fn(async (_job: unknown, control: { leaseGuard?: () => Promise<boolean> }) => {
        expect(await control.leaseGuard?.()).toBe(false);
        return { outcome: 'LEASE_LOST' as const };
      }),
    } as unknown as MeasurementExecutionHandler;

    const worker = new MeasurementRunJobWorker(coordinator, handler);

    await expect(worker.process(message)).resolves.toMatchObject({
      outcome: 'LEASE_LOST',
      measurementRunId: 'measurement-1',
      heartbeatFailed: true,
    });
  });
});
