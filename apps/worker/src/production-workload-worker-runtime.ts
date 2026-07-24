import {
  createNodeSafeCrawlerFetch,
  DeterministicArtifactGenerator,
  DurableWorkloadObjectStorage,
  type DurableWorkloadObjectStorageGateway,
  type StructuredApplicationLogger,
} from '@aeostudio/adapters';
import { createProductionPublicationAdapterRegistry } from '@aeostudio/adapters/publication';
import type {
  PublicationAdapterRegistry,
  PublicationAuthorizationMaterialReader,
} from '@aeostudio/application/channels-publishing';
import {
  JobWorkerCoordinator,
  type JobQueueMessage,
  type JobTraceContext,
} from '@aeostudio/application/jobs-budgets';
import type { CrawlPageFetcher } from '@aeostudio/application/site-crawl';
import type {
  ActivePublicationPackageReader,
  ActivePublicationSecretReader,
} from '@aeostudio/application/tenant-data-access';
import {
  PostgresArtifactStore,
  PostgresContentPlanningStore,
  PostgresJobBudgetStore,
  PostgresProfileOfferingStore,
  PostgresPublicationExecutionStore,
  PostgresSignedWebhookEndpointVerificationStore,
  PostgresSiteCrawlStore,
  PostgresWorkloadObjectWriteIntentStore,
} from '@aeostudio/db';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { ArtifactGenerationHandler } from './artifact-generation-handler.js';
import { ArtifactGenerationJobWorker } from './artifact-generation-job-worker.js';
import { ContentPlanHandler } from './content-plan-handler.js';
import { ContentPlanJobWorker } from './content-plan-job-worker.js';
import {
  resolveGenerationCapacityProbe,
  type GenerationCapacityProbeEnvironment,
} from './generation-capacity-probe.js';
import { GenerationJobWorker } from './generation-job-worker.js';
import {
  createMeasurementWorkerRuntime,
  type MeasurementMessageProcessor,
  type MeasurementQueueConsumer,
} from './measurement-worker-runtime.js';
import { ProfileReadinessHandler } from './profile-readiness-handler.js';
import { ProfileReadinessJobWorker } from './profile-readiness-job-worker.js';
import { PublicationExecutionHandler } from './publication-execution-handler.js';
import { PublicationJobWorker } from './publication-job-worker.js';
import {
  resolveProductionWorkerCapacity,
  type ProductionWorkerCapacityEnvironment,
} from './production-worker-capacity.js';
import { SiteCrawlHandler } from './site-crawl-handler.js';
import { SiteCrawlJobWorker } from './site-crawl-job-worker.js';

export interface ProductionWorkloadWorkerEnvironment
  extends ProductionWorkerCapacityEnvironment, GenerationCapacityProbeEnvironment {
  [name: string]: string | undefined;
  AEOSTUDIO_AUTH_MODE?: string;
  AEOSTUDIO_CHANNEL_ADAPTER_MODE?: string;
  AEOSTUDIO_GIT_PROVIDER_MODE?: string;
  AEOSTUDIO_SHOPIFY_PROVIDER_MODE?: string;
  AEOSTUDIO_WEBHOOK_PROVIDER_MODE?: string;
  AEOSTUDIO_WORDPRESS_PROVIDER_MODE?: string;
  DATABASE_URL?: string;
  NODE_ENV?: string;
}

export interface ProductionWorkloadStorage {
  storage: DurableWorkloadObjectStorageGateway;
}

export interface ProductionWorkloadQueues {
  crawl: MeasurementQueueConsumer;
  generation: MeasurementQueueConsumer;
  publish: MeasurementQueueConsumer;
}

export function resolveProductionWorkloadWorkerRuntime(input: {
  environment: ProductionWorkloadWorkerEnvironment;
  queues: ProductionWorkloadQueues;
  storage: ProductionWorkloadStorage;
  publicationPackages: ActivePublicationPackageReader;
  publicationAuthorizationMaterials: PublicationAuthorizationMaterialReader;
  publicationSecrets: ActivePublicationSecretReader;
  publicationAdapters?: PublicationAdapterRegistry;
  crawler?: CrawlPageFetcher;
  logger?: StructuredApplicationLogger;
  clock?: { now(): Date };
}) {
  forbidFakeRuntime(input.environment);
  const databaseUrl = input.environment.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL_REQUIRED_FOR_WORKLOAD_WORKER');
  }
  const capacity = resolveProductionWorkerCapacity(input.environment);
  const capacityProbe = resolveGenerationCapacityProbe(input.environment);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: capacity.databasePools.workload,
  });
  const clock = input.clock ?? { now: () => new Date() };
  const ids = { next: uuidv7 };
  const jobStore = new PostgresJobBudgetStore(pool);
  const profileStore = new PostgresProfileOfferingStore(pool);
  const siteCrawlStore = new PostgresSiteCrawlStore(pool);
  const contentPlanningStore = new PostgresContentPlanningStore(pool);
  const artifactStore = new PostgresArtifactStore(pool);
  const publicationStore = new PostgresPublicationExecutionStore(pool);
  const signedWebhookEndpointVerifications = new PostgresSignedWebhookEndpointVerificationStore(
    pool,
  );
  const publicationAdapters =
    input.publicationAdapters ??
    createProductionPublicationAdapterRegistry({ signedWebhookEndpointVerifications });
  const durableStorage = new DurableWorkloadObjectStorage(
    input.storage.storage,
    new PostgresWorkloadObjectWriteIntentStore(pool),
    { ids, clock },
  );

  const crawlCoordinator = new JobWorkerCoordinator(jobStore, clock, ids, 'crawl-workload-v1');
  const generationCoordinator = new JobWorkerCoordinator(
    jobStore,
    clock,
    ids,
    'generation-workload-v1',
  );
  const publishCoordinator = new JobWorkerCoordinator(jobStore, clock, ids, 'publish-workload-v1');

  const profileReadiness = new ProfileReadinessJobWorker(
    generationCoordinator,
    profileStore,
    new ProfileReadinessHandler(),
  );
  const siteCrawl = new SiteCrawlJobWorker(
    crawlCoordinator,
    siteCrawlStore,
    new SiteCrawlHandler(input.crawler ?? createNodeSafeCrawlerFetch(), durableStorage, ids, clock),
    ids,
    clock,
  );
  const contentPlan = new ContentPlanJobWorker(
    generationCoordinator,
    new ContentPlanHandler(contentPlanningStore, ids, clock),
  );
  const artifactGeneration = new ArtifactGenerationJobWorker(
    generationCoordinator,
    new ArtifactGenerationHandler(
      artifactStore,
      new DeterministicArtifactGenerator(),
      durableStorage,
      ids,
      clock,
    ),
  );
  const generation = new GenerationJobWorker(
    generationCoordinator,
    profileReadiness,
    contentPlan,
    artifactGeneration,
    capacityProbe,
  );
  const publication = new PublicationJobWorker(
    publishCoordinator,
    new PublicationExecutionHandler(
      publicationStore,
      input.publicationPackages,
      publicationAdapters,
      input.publicationAuthorizationMaterials,
      input.publicationSecrets,
      ids,
      clock,
    ),
  );

  const crawlRuntime = createMeasurementWorkerRuntime({
    queue: input.queues.crawl,
    processor: adaptProcessor({
      process: (message) =>
        siteCrawl.process(message, {
          maxPages: 500,
          maxBytes: 2 * 1024 * 1024 * 1024,
          timeoutMs: 10_000,
        }),
    }),
    pollIntervalMs: 1_000,
    consumerConcurrency: capacity.consumers.crawl,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });
  const generationRuntime = createMeasurementWorkerRuntime({
    queue: input.queues.generation,
    processor: adaptProcessor(generation),
    pollIntervalMs: 1_000,
    consumerConcurrency: capacity.consumers.generation,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });
  const publishRuntime = createMeasurementWorkerRuntime({
    queue: input.queues.publish,
    processor: adaptProcessor(publication),
    pollIntervalMs: 1_000,
    consumerConcurrency: capacity.consumers.publish,
    terminalFailureEvent: 'PUBLICATION_FAILED',
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });
  let started = false;
  let closed = false;

  return {
    async run(signal: AbortSignal): Promise<void> {
      if (started) throw new Error('WORKLOAD_WORKER_RUNTIME_ALREADY_STARTED');
      started = true;
      const siblings = new AbortController();
      const abort = () => siblings.abort();
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      try {
        const runLoop = async (runtime: { run(signal: AbortSignal): Promise<void> }) => {
          try {
            await runtime.run(siblings.signal);
          } catch (error: unknown) {
            abort();
            throw error;
          }
        };
        const results = await Promise.allSettled([
          runLoop(crawlRuntime),
          runLoop(generationRuntime),
          runLoop(publishRuntime),
        ]);
        if (results.some((result) => result.status === 'rejected')) {
          throw new Error('WORKLOAD_WORKER_RUNTIME_FAILED');
        }
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await pool.end();
    },
    components: {
      pool,
      queues: input.queues,
      capacity,
      capacityProbe,
      runtimes: { crawl: crawlRuntime, generation: generationRuntime, publish: publishRuntime },
      stores: {
        jobStore,
        profileStore,
        siteCrawlStore,
        contentPlanningStore,
        artifactStore,
        publicationStore,
      },
      processors: {
        profileReadiness,
        siteCrawl,
        contentPlan,
        artifactGeneration,
        generation,
        publication,
      },
      storage: durableStorage,
      publicationAdapters,
      publicationAuthorizationMaterials: input.publicationAuthorizationMaterials,
      signedWebhookEndpointVerifications,
    },
  };
}

function adaptProcessor(processor: {
  process(message: JobQueueMessage, traceContext?: JobTraceContext): Promise<{ outcome: string }>;
}): MeasurementMessageProcessor {
  return {
    async process(message, traceContext) {
      return (await processor.process(message, traceContext)) as Awaited<
        ReturnType<MeasurementMessageProcessor['process']>
      >;
    },
  };
}

function forbidFakeRuntime(environment: ProductionWorkloadWorkerEnvironment): void {
  for (const name of [
    'AEOSTUDIO_AUTH_MODE',
    'AEOSTUDIO_CHANNEL_ADAPTER_MODE',
    'AEOSTUDIO_GIT_PROVIDER_MODE',
    'AEOSTUDIO_SHOPIFY_PROVIDER_MODE',
    'AEOSTUDIO_WEBHOOK_PROVIDER_MODE',
    'AEOSTUDIO_WORDPRESS_PROVIDER_MODE',
  ] as const) {
    if (environment[name] === 'fake') throw new Error('FAKE_RUNTIME_FORBIDDEN_IN_PRODUCTION');
  }
}
