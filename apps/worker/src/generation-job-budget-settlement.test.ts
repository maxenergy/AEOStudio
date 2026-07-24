import type { JobLease, JobWorkerCoordinator } from '@aeostudio/application/jobs-budgets';
import { describe, expect, test, vi } from 'vitest';

import type { ArtifactGenerationHandler } from './artifact-generation-handler.js';
import { ArtifactGenerationJobWorker } from './artifact-generation-job-worker.js';
import type { ContentPlanHandler } from './content-plan-handler.js';
import { ContentPlanJobWorker } from './content-plan-job-worker.js';

function lease(jobType: 'CONTENT_PLAN' | 'ARTIFACT_GENERATION'): JobLease {
  return {
    job: {
      id: '00000000-0000-7000-8000-000000000001',
      tenantId: '00000000-0000-7000-8000-000000000002',
      workspaceId: '00000000-0000-7000-8000-000000000003',
      providerKey: null,
      jobType,
      aggregateId: '00000000-0000-7000-8000-000000000004',
      status: 'RUNNING',
      progress: 10,
      attempt: 1,
      maxAttempts: 3,
      budgetWarning: false,
      estimatedUnits: 1,
      heartbeatAt: '2026-07-24T00:00:00.000Z',
      result: null,
      errorCode: null,
    },
    leaseToken: '00000000-0000-7000-8000-000000000005',
    messageId: '00000000-0000-7000-8000-000000000006',
  };
}

function coordinator() {
  const complete = vi.fn(() => Promise.resolve(true));
  return {
    complete,
    value: {
      reportProgress: vi.fn(() => Promise.resolve(true)),
      heartbeat: vi.fn(() => Promise.resolve(true)),
      complete,
      fail: vi.fn(() => Promise.resolve('FAILED_TERMINAL' as const)),
    } as unknown as JobWorkerCoordinator,
  };
}

describe('generation Worker budget settlement', () => {
  test('Content Plan reports the full actual usage even when it exceeds the reservation', async () => {
    const execution = coordinator();
    const handler = {
      run: vi.fn(() =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          planId: '00000000-0000-7000-8000-000000000004',
          contentHash: 'a'.repeat(64),
          briefCount: 3,
        }),
      ),
    } as unknown as ContentPlanHandler;
    const worker = new ContentPlanJobWorker(execution.value, handler);

    await worker.processClaimed(lease('CONTENT_PLAN'));

    expect(execution.complete).toHaveBeenCalledWith(expect.anything(), expect.anything(), 4);
  });

  test('Artifact generation reports the full actual usage even when it exceeds the reservation', async () => {
    const execution = coordinator();
    const handler = {
      run: vi.fn(() =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          artifactId: '00000000-0000-7000-8000-000000000004',
          contentHash: 'b'.repeat(64),
        }),
      ),
    } as unknown as ArtifactGenerationHandler;
    const worker = new ArtifactGenerationJobWorker(execution.value, handler);

    await worker.processClaimed(lease('ARTIFACT_GENERATION'));

    expect(execution.complete).toHaveBeenCalledWith(expect.anything(), expect.anything(), 5);
  });
});
