import type { TenantContext } from '@aeostudio/application/identity-access';
import type { JobType } from '@aeostudio/domain/jobs-budgets';
import { describe, expect, test, vi } from 'vitest';

import { InMemoryJobBudgetStore } from '../../apps/api/src/jobs/in-memory-job-budget-store.js';

const context: TenantContext = {
  tenantId: '00000000-0000-7000-8000-000000009001',
  workspaceId: '00000000-0000-7000-8000-000000009002',
  actorUserId: '00000000-0000-7000-8000-000000009003',
  membershipId: '00000000-0000-7000-8000-000000009004',
  role: 'OWNER',
};

describe('InMemoryJobBudgetStore processor poll concurrency', () => {
  test.each([
    { jobType: 'PUBLICATION' as const, register: 'publication' as const },
    { jobType: 'MEASUREMENT' as const, register: 'measurement' as const },
  ])(
    'two concurrent $jobType polls share one processor invocation',
    async ({ jobType, register }) => {
      const jobs = new InMemoryJobBudgetStore();
      await jobs.setBudget({
        context,
        policyId: '00000000-0000-7000-8000-000000009005',
        limitUnits: 100,
        auditEventId: '00000000-0000-7000-8000-000000009006',
      });
      const entered = deferred<void>();
      const release = deferred<void>();
      const processor = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        return {
          status: 'SUCCEEDED' as const,
          result: { processed: true },
          errorCode: null,
        };
      });
      if (register === 'publication') jobs.registerPublicationProcessor(processor);
      else jobs.registerMeasurementProcessor(processor);
      const jobId =
        jobType === 'PUBLICATION'
          ? '00000000-0000-7000-8000-000000009007'
          : '00000000-0000-7000-8000-000000009008';
      await submit(jobs, jobType, jobId);
      await jobs.findJob({ context, jobId });
      await jobs.findJob({ context, jobId });

      const first = jobs.findJob({ context, jobId });
      const second = jobs.findJob({ context, jobId });
      await entered.promise;
      try {
        expect(processor).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        await Promise.all([first, second]);
      }
      await expect(jobs.findJob({ context, jobId })).resolves.toMatchObject({
        status: 'SUCCEEDED',
        result: { processed: true },
      });
      expect(processor).toHaveBeenCalledTimes(1);
    },
  );
});

async function submit(
  jobs: InMemoryJobBudgetStore,
  jobType: JobType,
  jobId: string,
): Promise<void> {
  const submitted = await jobs.submitJob({
    context,
    jobId,
    jobType,
    aggregateId: '00000000-0000-7000-8000-000000009009',
    idempotencyKey: `${jobType.toLowerCase()}-concurrent-polls`,
    estimatedUnits: 1,
    reservationId: '00000000-0000-7000-8000-000000009010',
    budgetAlertId: '00000000-0000-7000-8000-000000009011',
    outboxMessageId: '00000000-0000-7000-8000-000000009012',
    auditEventId: '00000000-0000-7000-8000-000000009013',
  });
  expect(submitted).toMatchObject({ id: jobId, status: 'QUEUED' });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
