import {
  type JobClaimResult,
  type JobQueueMessage,
  JobWorkerCoordinator,
} from '@aeostudio/application/jobs-budgets';

import type { MeasurementExecutionHandler } from './measurement-execution-handler.js';

export type MeasurementRunJobFailureSource =
  'PROVIDER' | 'REFERENCE' | 'PERSISTENCE' | 'EXECUTION' | 'JOB_CONTRACT';

export type MeasurementRunJobOutcome =
  | { outcome: JobClaimResult['outcome'] }
  | {
      outcome: 'SUCCEEDED' | 'FAILED_TERMINAL' | 'RETRY_WAIT' | 'LEASE_LOST';
      measurementRunId?: string;
      providerFailureCount?: number;
      failureSource?: MeasurementRunJobFailureSource;
      heartbeatFailed?: true;
    };

export class MeasurementRunJobWorker {
  constructor(
    private readonly coordinator: JobWorkerCoordinator,
    private readonly handler: MeasurementExecutionHandler,
  ) {}

  async process(message: JobQueueMessage): Promise<MeasurementRunJobOutcome> {
    const claimed = await this.coordinator.claim(message);
    if (claimed.outcome !== 'CLAIMED') return { outcome: claimed.outcome };
    const { lease } = claimed;
    if (lease.job.jobType !== 'MEASUREMENT') {
      const failed = await this.coordinator.fail(lease, 'TERMINAL', 'UNSUPPORTED_JOB_TYPE');
      return failed === false
        ? { outcome: 'LEASE_LOST' }
        : { outcome: 'FAILED_TERMINAL', failureSource: 'JOB_CONTRACT' };
    }
    if (!(await this.coordinator.reportProgress(lease, 10))) return { outcome: 'LEASE_LOST' };
    let leaseAlive = true;
    let heartbeatFailed = false;
    const leaseAbort = new AbortController();
    const markLeaseLost = () => {
      heartbeatFailed = true;
      leaseAlive = false;
      leaseAbort.abort(new Error('MEASUREMENT_JOB_LEASE_LOST'));
    };
    const leaseLost = (measurementRunId: string) => ({
      outcome: 'LEASE_LOST' as const,
      measurementRunId,
      ...(heartbeatFailed ? { heartbeatFailed: true as const } : {}),
    });
    const heartbeat = setInterval(() => {
      void this.coordinator
        .heartbeat(lease)
        .then((alive) => {
          leaseAlive &&= alive;
          if (!leaseAlive) markLeaseLost();
        })
        .catch(markLeaseLost);
    }, JobWorkerCoordinator.heartbeatIntervalMs);
    try {
      const result = await this.handler.run(lease.job, {
        signal: leaseAbort.signal,
        lease: { jobId: lease.job.id, leaseToken: lease.leaseToken },
        leaseGuard: async () => {
          if (!leaseAlive) return false;
          try {
            const alive = await this.coordinator.heartbeat(lease);
            leaseAlive &&= alive;
          } catch {
            markLeaseLost();
          }
          if (!leaseAlive) markLeaseLost();
          return leaseAlive;
        },
      });
      if (result.outcome === 'LEASE_LOST') {
        return leaseLost(lease.job.aggregateId);
      }
      try {
        if (!(await this.coordinator.heartbeat(lease))) markLeaseLost();
      } catch {
        markLeaseLost();
      }
      if (!leaseAlive) {
        return leaseLost(lease.job.aggregateId);
      }
      if (result.outcome === 'RETRYABLE_CONFLICT') {
        const failed = await this.coordinator.fail(
          lease,
          'RETRYABLE',
          'MEASUREMENT_PERSISTENCE_CONFLICT',
        );
        if (failed === false) {
          return leaseLost(lease.job.aggregateId);
        }
        return {
          outcome: failed === 'RETRY_WAIT' ? 'RETRY_WAIT' : 'FAILED_TERMINAL',
          measurementRunId: lease.job.aggregateId,
          failureSource: 'PERSISTENCE',
        };
      }
      if (result.outcome !== 'SUCCEEDED') {
        const failed = await this.coordinator.fail(
          lease,
          'TERMINAL',
          'MEASUREMENT_INVALID_REFERENCE',
        );
        return {
          ...(failed === false
            ? leaseLost(lease.job.aggregateId)
            : {
                outcome: 'FAILED_TERMINAL' as const,
                measurementRunId: lease.job.aggregateId,
                failureSource: 'REFERENCE' as const,
              }),
        };
      }
      if (!(await this.coordinator.reportProgress(lease, 90))) {
        return leaseLost(result.measurementRunId);
      }
      const completed = await this.coordinator.complete(
        lease,
        {
          measurementRunId: result.measurementRunId,
          measurementStatus: 'COMPLETED',
          snapshotCount: result.snapshotCount,
        },
        result.actualUnits,
      );
      return completed
        ? {
            outcome: 'SUCCEEDED',
            measurementRunId: result.measurementRunId,
            providerFailureCount: result.providerFailureCount,
            ...(result.providerFailureCount > 0 ? { failureSource: 'PROVIDER' as const } : {}),
          }
        : leaseLost(result.measurementRunId);
    } catch {
      try {
        const alive = leaseAlive && (await this.coordinator.heartbeat(lease));
        if (!alive) markLeaseLost();
      } catch {
        markLeaseLost();
      }
      if (!leaseAlive) {
        return leaseLost(lease.job.aggregateId);
      }
      const failed = await this.coordinator.fail(
        lease,
        'RETRYABLE',
        'MEASUREMENT_EXECUTION_TRANSIENT_FAILURE',
      );
      if (failed === false) {
        return leaseLost(lease.job.aggregateId);
      }
      return {
        outcome: failed === 'RETRY_WAIT' ? 'RETRY_WAIT' : 'FAILED_TERMINAL',
        measurementRunId: lease.job.aggregateId,
        failureSource: 'EXECUTION',
      };
    } finally {
      clearInterval(heartbeat);
      leaseAbort.abort();
    }
  }
}
