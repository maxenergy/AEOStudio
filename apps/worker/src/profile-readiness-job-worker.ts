import {
  type JobClaimResult,
  type JobLease,
  type JobQueueMessage,
  JobWorkerCoordinator,
} from '@aeostudio/application/jobs-budgets';
import type { ProfileReadinessExecutionStore } from '@aeostudio/application/profile-offering';

import type { ProfileReadinessHandler } from './profile-readiness-handler.js';

export type ProfileReadinessJobOutcome =
  | { outcome: JobClaimResult['outcome'] }
  | { outcome: 'SUCCEEDED' | 'FAILED_TERMINAL' | 'LEASE_LOST' };

export class ProfileReadinessJobWorker {
  constructor(
    private readonly coordinator: JobWorkerCoordinator,
    private readonly profiles: ProfileReadinessExecutionStore,
    private readonly handler: ProfileReadinessHandler,
  ) {}

  async process(message: JobQueueMessage): Promise<ProfileReadinessJobOutcome> {
    const claimed = await this.coordinator.claim(message);
    if (claimed.outcome !== 'CLAIMED') return { outcome: claimed.outcome };
    return this.processClaimed(claimed.lease);
  }

  async processClaimed(lease: JobLease): Promise<ProfileReadinessJobOutcome> {
    if (lease.job.jobType !== 'PROFILE_READINESS') {
      const failed = await this.coordinator.fail(lease, 'TERMINAL', 'UNSUPPORTED_JOB_TYPE');
      return { outcome: failed === false ? 'LEASE_LOST' : 'FAILED_TERMINAL' };
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
      const profile = await this.profiles.loadCurrentProfile(lease.job);
      leaseAlive &&= await this.coordinator.heartbeat(lease);
      if (!leaseAlive) return { outcome: 'LEASE_LOST' };
      if (profile === null) {
        const failed = await this.coordinator.fail(lease, 'TERMINAL', 'PROFILE_NOT_FOUND');
        return { outcome: failed === false ? 'LEASE_LOST' : 'FAILED_TERMINAL' };
      }
      const result = this.handler.execute(profile);
      if (!(await this.coordinator.reportProgress(lease, 90))) return { outcome: 'LEASE_LOST' };
      const completed = await this.coordinator.complete(lease, { ...result }, 1);
      return { outcome: completed ? 'SUCCEEDED' : 'LEASE_LOST' };
    } finally {
      clearInterval(heartbeat);
    }
  }
}
