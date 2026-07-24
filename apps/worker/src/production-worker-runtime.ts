import type { StructuredApplicationLogger } from '@aeostudio/adapters/observability';

export interface ProductionWorkerLoop {
  run(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export function createCombinedProductionWorkerRuntime(input: {
  outbox: ProductionWorkerLoop;
  workload: ProductionWorkerLoop;
  measurement: ProductionWorkerLoop;
  privacy: ProductionWorkerLoop;
  authorizationValidation?: ProductionWorkerLoop;
  logger: StructuredApplicationLogger;
  resources?: Array<{ close(): Promise<void> }>;
}): ProductionWorkerLoop {
  let started = false;
  let closed = false;
  return {
    async run(signal: AbortSignal): Promise<void> {
      if (started) throw new Error('PRODUCTION_WORKER_RUNTIME_ALREADY_STARTED');
      started = true;
      const siblingShutdown = new AbortController();
      const requestShutdown = () => siblingShutdown.abort();
      if (signal.aborted) requestShutdown();
      else signal.addEventListener('abort', requestShutdown, { once: true });
      input.logger.info('WORKER_RUNTIME_STARTED');
      try {
        const runLoop = async (loop: ProductionWorkerLoop) => {
          try {
            await loop.run(siblingShutdown.signal);
          } catch (error: unknown) {
            requestShutdown();
            throw error;
          }
        };
        const loops = [
          runLoop(input.outbox),
          runLoop(input.workload),
          runLoop(input.measurement),
          runLoop(input.privacy),
          ...(input.authorizationValidation === undefined
            ? []
            : [runLoop(input.authorizationValidation)]),
        ];
        const outcomes = await Promise.allSettled(loops);
        if (outcomes.some((outcome) => outcome.status === 'rejected')) {
          input.logger.error('WORKER_RUNTIME_FAILED');
          throw new Error('PRODUCTION_WORKER_RUNTIME_FAILED');
        }
        input.logger.info('WORKER_RUNTIME_STOPPED');
      } finally {
        signal.removeEventListener('abort', requestShutdown);
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const resources = [...(input.resources ?? [])].reverse();
      const outcomes = await Promise.allSettled([
        ...(input.authorizationValidation === undefined
          ? []
          : [input.authorizationValidation.close()]),
        input.privacy.close(),
        input.measurement.close(),
        input.workload.close(),
        input.outbox.close(),
        ...resources.map((resource) => resource.close()),
      ]);
      input.logger.flush();
      if (outcomes.some((outcome) => outcome.status === 'rejected')) {
        throw new Error('PRODUCTION_WORKER_SHUTDOWN_FAILED');
      }
    },
  };
}
