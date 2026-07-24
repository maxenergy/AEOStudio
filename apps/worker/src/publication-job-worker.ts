import {
  type JobClaimResult,
  type JobQueueMessage,
  JobWorkerCoordinator,
} from '@aeostudio/application/jobs-budgets';

import type { PublicationExecutionHandler } from './publication-execution-handler.js';

export type PublicationJobOutcome =
  | { outcome: JobClaimResult['outcome'] }
  | { outcome: 'SUCCEEDED' | 'FAILED_TERMINAL' | 'RETRY_WAIT' | 'LEASE_LOST' };

export class PublicationJobWorker {
  constructor(
    private readonly coordinator: JobWorkerCoordinator,
    private readonly handler: PublicationExecutionHandler,
  ) {}

  async process(message: JobQueueMessage): Promise<PublicationJobOutcome> {
    const claimed = await this.coordinator.claim(message);
    if (claimed.outcome !== 'CLAIMED') return { outcome: claimed.outcome };
    const { lease } = claimed;
    if (lease.job.jobType !== 'PUBLICATION') {
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
      const result = await this.handler.run(lease);
      if (result.outcome === 'LEASE_LOST') return { outcome: 'LEASE_LOST' };
      leaseAlive &&= await this.coordinator.heartbeat(lease);
      if (!leaseAlive) return { outcome: 'LEASE_LOST' };
      if (result.outcome === 'RETRYABLE_FAILURE') {
        const failed = await this.coordinator.fail(lease, 'RETRYABLE', result.errorCode);
        if (failed === false) return { outcome: 'LEASE_LOST' };
        return { outcome: failed === 'RETRY_WAIT' ? 'RETRY_WAIT' : 'FAILED_TERMINAL' };
      }
      if (result.outcome === 'TERMINAL_FAILURE') {
        const failed = await this.coordinator.fail(lease, 'TERMINAL', result.errorCode);
        return { outcome: failed === false ? 'LEASE_LOST' : 'FAILED_TERMINAL' };
      }
      if (!(await this.coordinator.reportProgress(lease, 90))) return { outcome: 'LEASE_LOST' };
      const completed = await this.coordinator.complete(
        lease,
        {
          publicationId: result.publicationId,
          publicationStatus: result.publicationStatus,
          remoteRef: result.remoteRef,
          packageChecksum: result.packageChecksum,
          ...(result.remoteState === undefined ? {} : { remoteState: result.remoteState }),
        },
        lease.job.estimatedUnits,
      );
      return { outcome: completed ? 'SUCCEEDED' : 'LEASE_LOST' };
    } finally {
      clearInterval(heartbeat);
    }
  }
}
