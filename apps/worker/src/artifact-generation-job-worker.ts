import {
  type JobClaimResult,
  type JobLease,
  type JobQueueMessage,
  JobWorkerCoordinator,
} from '@aeostudio/application/jobs-budgets';

import type { ArtifactGenerationHandler } from './artifact-generation-handler.js';

export type ArtifactGenerationJobOutcome =
  | { outcome: JobClaimResult['outcome'] }
  | { outcome: 'SUCCEEDED' | 'FAILED_TERMINAL' | 'LEASE_LOST'; artifactId?: string };

export class ArtifactGenerationJobWorker {
  constructor(
    private readonly coordinator: JobWorkerCoordinator,
    private readonly handler: ArtifactGenerationHandler,
  ) {}

  async process(message: JobQueueMessage): Promise<ArtifactGenerationJobOutcome> {
    const claimed = await this.coordinator.claim(message);
    if (claimed.outcome !== 'CLAIMED') return { outcome: claimed.outcome };
    return this.processClaimed(claimed.lease);
  }

  async processClaimed(lease: JobLease): Promise<ArtifactGenerationJobOutcome> {
    if (lease.job.jobType !== 'ARTIFACT_GENERATION') {
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
      if (!leaseAlive) return { outcome: 'LEASE_LOST', artifactId: lease.job.aggregateId };
      if (result.outcome !== 'SUCCEEDED') {
        await this.coordinator.fail(lease, 'TERMINAL', 'ARTIFACT_INVALID_REFERENCE');
        return { outcome: 'FAILED_TERMINAL', artifactId: lease.job.aggregateId };
      }
      if (!(await this.coordinator.reportProgress(lease, 90))) {
        return { outcome: 'LEASE_LOST', artifactId: result.artifactId };
      }
      const completed = await this.coordinator.complete(
        lease,
        {
          artifactStatus: 'DRAFT',
          artifactId: result.artifactId,
          revision: 1,
          contentHash: result.contentHash,
        },
        5,
      );
      return completed
        ? { outcome: 'SUCCEEDED', artifactId: result.artifactId }
        : { outcome: 'LEASE_LOST', artifactId: result.artifactId };
    } finally {
      clearInterval(heartbeat);
    }
  }
}
