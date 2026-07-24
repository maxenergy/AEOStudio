import type {
  JobQueueMessage,
  JobQueuePort,
  JobQueueRouterPort,
  JobTraceContext,
} from '@aeostudio/application/jobs-budgets';
import type { JobType } from '@aeostudio/domain/jobs-budgets';

export type JobWorkload = 'crawl' | 'generation' | 'publish' | 'measurement';

export interface WorkloadJobQueues {
  crawl: JobQueuePort;
  generation: JobQueuePort;
  publish: JobQueuePort;
  measurement: JobQueuePort;
}

const JOB_WORKLOAD: Record<JobType, JobWorkload> = {
  PROFILE_READINESS: 'generation',
  SITE_CRAWL: 'crawl',
  CONTENT_PLAN: 'generation',
  ARTIFACT_GENERATION: 'generation',
  PUBLICATION: 'publish',
  MEASUREMENT: 'measurement',
};

export function createWorkloadJobQueueRouter(queues: WorkloadJobQueues): JobQueueRouterPort {
  return {
    route(
      jobType: JobType,
      message: JobQueueMessage,
      traceContext?: JobTraceContext,
    ): Promise<void> {
      const queue = queues[JOB_WORKLOAD[jobType]];
      return traceContext === undefined ? queue.send(message) : queue.send(message, traceContext);
    },
  };
}
