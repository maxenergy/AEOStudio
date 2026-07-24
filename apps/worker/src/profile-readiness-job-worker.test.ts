import { describe, expect, test, vi } from 'vitest';
import {
  JobWorkerCoordinator,
  type JobExecutionStore,
  type JobLease,
  type JobQueueMessage,
} from '@aeostudio/application/jobs-budgets';
import type { ProfileReadinessExecutionStore } from '@aeostudio/application/profile-offering';

import { ProfileReadinessHandler } from './profile-readiness-handler.js';
import { ProfileReadinessJobWorker } from './profile-readiness-job-worker.js';

describe('ProfileReadinessJobWorker', () => {
  test('completes a queued readiness job from the current persisted Profile revision', async () => {
    const message: JobQueueMessage = {
      messageId: '018f3b76-1000-7000-8000-000000000001',
      payload: {
        jobId: '018f3b76-1000-7000-8000-000000000002',
        tenantId: '018f3b76-1000-7000-8000-000000000003',
        workspaceId: '018f3b76-1000-7000-8000-000000000004',
        schemaVersion: '1.0.0',
      },
    };
    const lease: JobLease = {
      messageId: message.messageId,
      leaseToken: '018f3b76-1000-7000-8000-000000000005',
      job: {
        id: message.payload.jobId,
        tenantId: message.payload.tenantId,
        workspaceId: message.payload.workspaceId,
        providerKey: null,
        jobType: 'PROFILE_READINESS',
        aggregateId: '018f3b76-1000-7000-8000-000000000006',
        status: 'RUNNING',
        progress: 0,
        attempt: 1,
        maxAttempts: 3,
        budgetWarning: false,
        estimatedUnits: 10,
        heartbeatAt: null,
        result: null,
        errorCode: null,
      },
    };
    const complete = vi.fn(() => Promise.resolve(true));
    const executionStore: JobExecutionStore = {
      listPendingOutbox: () => Promise.resolve([]),
      markOutboxPublished: () => Promise.resolve(),
      claimJob: () => Promise.resolve({ outcome: 'CLAIMED', lease }),
      heartbeat: () => Promise.resolve(true),
      reportProgress: () => Promise.resolve(true),
      complete,
      fail: () => Promise.resolve('FAILED_TERMINAL'),
    };
    const profiles: ProfileReadinessExecutionStore = {
      loadCurrentProfile: () =>
        Promise.resolve({
          id: '018f3b76-1000-7000-8000-000000000007',
          profileId: lease.job.aggregateId,
          tenantId: lease.job.tenantId,
          workspaceId: lease.job.workspaceId,
          revision: 3,
          displayName: 'Neutral Product Profile',
          description: 'Industry-neutral product and company information.',
          digitalAssets: [],
          targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
          contentHash: 'a'.repeat(64),
          completeness: {
            percent: 80,
            completedFields: 4,
            totalFields: 5,
            missingFields: ['websiteUrl'],
          },
        }),
    };
    const worker = new ProfileReadinessJobWorker(
      new JobWorkerCoordinator(
        executionStore,
        { now: () => new Date('2026-07-22T00:00:00.000Z') },
        { next: () => '018f3b76-1000-7000-8000-000000000008' },
        'generation-workload-v1',
      ),
      profiles,
      new ProfileReadinessHandler(),
    );

    await expect(worker.process(message)).resolves.toEqual({ outcome: 'SUCCEEDED' });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        result: {
          readinessPercent: 80,
          completedFields: 4,
          totalFields: 5,
          missingFields: ['websiteUrl'],
          profileRevision: 3,
          contentHash: 'a'.repeat(64),
        },
        actualUnits: 1,
      }),
    );
  });
});
