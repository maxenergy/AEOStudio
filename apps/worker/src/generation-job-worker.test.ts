import type {
  JobLease,
  JobQueueMessage,
  JobTraceContext,
  JobWorkerCoordinator,
} from '@aeostudio/application/jobs-budgets';
import { describe, expect, test, vi } from 'vitest';

import { GenerationJobWorker } from './generation-job-worker.js';

const message: JobQueueMessage = {
  messageId: '00000000-0000-7000-8000-000000000101',
  payload: {
    jobId: '00000000-0000-7000-8000-000000000102',
    tenantId: '00000000-0000-7000-8000-000000000103',
    workspaceId: '00000000-0000-7000-8000-000000000104',
    schemaVersion: '1.0.0',
  },
};
const lease: JobLease = {
  job: {
    id: message.payload.jobId,
    tenantId: message.payload.tenantId,
    workspaceId: message.payload.workspaceId,
    providerKey: null,
    jobType: 'PROFILE_READINESS',
    aggregateId: '00000000-0000-7000-8000-000000000105',
    status: 'RUNNING',
    progress: 0,
    attempt: 1,
    maxAttempts: 3,
    budgetWarning: false,
    estimatedUnits: 10,
    heartbeatAt: '2026-07-24T04:00:00.000Z',
    result: null,
    errorCode: null,
  },
  leaseToken: '00000000-0000-7000-8000-000000000106',
  messageId: message.messageId,
};
const traceContext: JobTraceContext = {
  requestId: '00000000-0000-7000-8000-000000000050',
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
};

describe('generation Job routing', () => {
  test('runs the capacity probe only after claiming the DB lease and before doing work', async () => {
    let releaseHold: (() => void) | undefined;
    const holdAfterClaim = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseHold = resolve;
        }),
    );
    const profileReadiness = {
      processClaimed: vi.fn(() => Promise.resolve({ outcome: 'SUCCEEDED' as const })),
    };
    const coordinator = {
      claim: vi.fn(() => Promise.resolve({ outcome: 'CLAIMED' as const, lease })),
      fail: vi.fn(),
    } as unknown as JobWorkerCoordinator;
    const worker = new GenerationJobWorker(
      coordinator,
      profileReadiness,
      { processClaimed: vi.fn() },
      { processClaimed: vi.fn() },
      { holdAfterClaim },
    );

    const running = worker.process(message, traceContext);
    await vi.waitFor(() => expect(holdAfterClaim).toHaveBeenCalledOnce());
    expect(profileReadiness.processClaimed).not.toHaveBeenCalled();
    expect(holdAfterClaim).toHaveBeenCalledWith({ traceContext });

    releaseHold?.();
    await expect(running).resolves.toEqual({ outcome: 'SUCCEEDED' });
    expect(profileReadiness.processClaimed).toHaveBeenCalledWith(lease);
  });
});
