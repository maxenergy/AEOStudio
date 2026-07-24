import type {
  JobClaimResult,
  JobLease,
  JobQueueMessage,
  JobTraceContext,
  JobWorkerCoordinator,
} from '@aeostudio/application/jobs-budgets';
import type { GenerationCapacityProbe } from './generation-capacity-probe.js';

export type GenerationJobOutcome =
  | { outcome: JobClaimResult['outcome'] }
  | {
      outcome: 'SUCCEEDED' | 'FAILED_TERMINAL' | 'LEASE_LOST';
      planId?: string;
      artifactId?: string;
    };

interface ClaimedGenerationJobProcessor {
  processClaimed(lease: JobLease): Promise<GenerationJobOutcome>;
}

/** Claims once, then dispatches from the authoritative persisted Job type. */
export class GenerationJobWorker {
  constructor(
    private readonly coordinator: JobWorkerCoordinator,
    private readonly profileReadiness: ClaimedGenerationJobProcessor,
    private readonly contentPlan: ClaimedGenerationJobProcessor,
    private readonly artifactGeneration: ClaimedGenerationJobProcessor,
    private readonly capacityProbe?: GenerationCapacityProbe,
  ) {}

  async process(
    message: JobQueueMessage,
    traceContext?: JobTraceContext,
  ): Promise<GenerationJobOutcome> {
    const claimed = await this.coordinator.claim(message);
    if (claimed.outcome !== 'CLAIMED') return { outcome: claimed.outcome };
    await this.capacityProbe?.holdAfterClaim({
      ...(traceContext === undefined ? {} : { traceContext }),
    });
    switch (claimed.lease.job.jobType) {
      case 'PROFILE_READINESS':
        return this.profileReadiness.processClaimed(claimed.lease);
      case 'CONTENT_PLAN':
        return this.contentPlan.processClaimed(claimed.lease);
      case 'ARTIFACT_GENERATION':
        return this.artifactGeneration.processClaimed(claimed.lease);
      default: {
        const failed = await this.coordinator.fail(
          claimed.lease,
          'TERMINAL',
          'UNSUPPORTED_JOB_TYPE',
        );
        return { outcome: failed === false ? 'LEASE_LOST' : 'FAILED_TERMINAL' };
      }
    }
  }
}
