import {
  type JobClaimResult,
  type JobLease,
  type JobQueueMessage,
  JobWorkerCoordinator,
} from '@aeostudio/application/jobs-budgets';

import type { ContentPlanHandler } from './content-plan-handler.js';

export type ContentPlanJobOutcome =
  | { outcome: JobClaimResult['outcome'] }
  | { outcome: 'SUCCEEDED' | 'FAILED_TERMINAL' | 'LEASE_LOST'; planId?: string };

export class ContentPlanJobWorker {
  constructor(
    private readonly coordinator: JobWorkerCoordinator,
    private readonly handler: ContentPlanHandler,
  ) {}

  async process(message: JobQueueMessage): Promise<ContentPlanJobOutcome> {
    const claimed = await this.coordinator.claim(message);
    if (claimed.outcome !== 'CLAIMED') return { outcome: claimed.outcome };
    return this.processClaimed(claimed.lease);
  }

  async processClaimed(lease: JobLease): Promise<ContentPlanJobOutcome> {
    if (lease.job.jobType !== 'CONTENT_PLAN') {
      await this.coordinator.fail(lease, 'TERMINAL', 'UNSUPPORTED_JOB_TYPE');
      return { outcome: 'FAILED_TERMINAL' };
    }
    if (!(await this.coordinator.reportProgress(lease, 10))) return { outcome: 'LEASE_LOST' };
    let leaseAlive = true;
    const heartbeat = setInterval(() => {
      void this.coordinator
        .heartbeat(lease)
        .then((alive) => {
          leaseAlive &&= alive;
        })
        .catch(() => {
          leaseAlive = false;
        });
    }, JobWorkerCoordinator.heartbeatIntervalMs);
    try {
      const result = await this.handler.run(lease.job);
      leaseAlive &&= await this.coordinator.heartbeat(lease);
      if (!leaseAlive) return { outcome: 'LEASE_LOST', planId: lease.job.aggregateId };
      if (result.outcome !== 'SUCCEEDED') {
        await this.coordinator.fail(
          lease,
          'TERMINAL',
          result.outcome === 'INVALID_REFERENCE'
            ? 'CONTENT_PLAN_INVALID_REFERENCE'
            : 'CONTENT_PLAN_NOT_FOUND',
        );
        return { outcome: 'FAILED_TERMINAL', planId: lease.job.aggregateId };
      }
      if (!(await this.coordinator.reportProgress(lease, 90))) {
        return { outcome: 'LEASE_LOST', planId: result.planId };
      }
      const actualUnits = Math.max(1, result.briefCount + 1);
      const completed = await this.coordinator.complete(
        lease,
        {
          contentPlanStatus: 'READY',
          planId: result.planId,
          contentHash: result.contentHash,
          briefCount: result.briefCount,
        },
        actualUnits,
      );
      return completed
        ? { outcome: 'SUCCEEDED', planId: result.planId }
        : { outcome: 'LEASE_LOST', planId: result.planId };
    } finally {
      clearInterval(heartbeat);
    }
  }
}
