import {
  traceIdFromJobTraceContext,
  type JobQueueMessage,
  type JobTraceContext,
  type JobTraceContextRunnerPort,
} from '@aeostudio/application/jobs-budgets';
import {
  openTelemetryJobTraceContextRunner,
  type StructuredApplicationLogger,
} from '@aeostudio/adapters/observability';

import type { MeasurementRunJobOutcome } from './measurement-run-job-worker.js';

export interface MeasurementQueueDeliveryBase {
  message: JobQueueMessage;
  traceContext?: JobTraceContext;
  acknowledge(): Promise<void>;
}

export interface VisibilityManagedMeasurementQueueDelivery extends MeasurementQueueDeliveryBase {
  extendVisibility(visibilityTimeoutSeconds: number): Promise<void>;
  release(visibilityTimeoutSeconds: number): Promise<void>;
}

export interface LocalMeasurementQueueDelivery extends MeasurementQueueDeliveryBase {
  extendVisibility?: undefined;
  release(): Promise<void>;
}

export type MeasurementQueueDelivery =
  VisibilityManagedMeasurementQueueDelivery | LocalMeasurementQueueDelivery;

export interface MeasurementQueueConsumer {
  receive(signal?: AbortSignal): Promise<MeasurementQueueDelivery | null>;
}

export interface MeasurementMessageProcessor {
  process(
    message: JobQueueMessage,
    traceContext?: JobTraceContext,
  ): Promise<MeasurementRunJobOutcome>;
}

type WorkerOperation = 'RECEIVE' | 'PROCESS' | 'ACKNOWLEDGE' | 'RELEASE' | 'UNKNOWN';
type TrackedWorkerOperation = Exclude<WorkerOperation, 'UNKNOWN'>;

class WorkerOperationFailure extends Error {
  constructor(readonly operation: WorkerOperation) {
    super('WORKER_OPERATION_FAILED');
  }
}

export function createMeasurementWorkerRuntime(input: {
  queue: MeasurementQueueConsumer;
  processor: MeasurementMessageProcessor;
  pollIntervalMs: number;
  consumerConcurrency?: number;
  failurePolicy?: {
    maxConsecutiveFailures: number;
  };
  logger?: StructuredApplicationLogger;
  traceRunner?: JobTraceContextRunnerPort;
  terminalFailureEvent?: 'PROVIDER_FAILED' | 'PUBLICATION_FAILED';
}) {
  const pollIntervalMs = Math.max(1, Math.min(input.pollIntervalMs, 60_000));
  const consumerConcurrency = readConsumerConcurrency(input.consumerConcurrency ?? 1);
  const maxConsecutiveFailures = readMaxConsecutiveFailures(
    input.failurePolicy?.maxConsecutiveFailures ?? 3,
  );
  const traceRunner = input.traceRunner ?? openTelemetryJobTraceContextRunner;

  async function executeOnce(
    signal?: AbortSignal,
    operationSucceeded?: (operation: TrackedWorkerOperation) => void,
  ) {
    const delivery = await runWorkerOperation(
      'RECEIVE',
      () => input.queue.receive(signal),
      operationSucceeded,
    );
    if (delivery === null) return { outcome: 'IDLE' as const };
    const processDelivery = async () => {
      const traceContext = delivery.traceContext;
      const logInput = {
        correlation: {
          jobId: delivery.message.payload.jobId,
          ...(traceContext === undefined
            ? {}
            : {
                requestId: traceContext.requestId,
                traceId: traceIdFromJobTraceContext(traceContext),
              }),
        },
        attributes: {
          tenantId: delivery.message.payload.tenantId,
          workspaceId: delivery.message.payload.workspaceId,
        },
      };
      input.logger?.info('WORKER_JOB_RECEIVED', logInput);
      let visibilityHeartbeatFailed = false;
      let visibilityHeartbeatOperation = Promise.resolve();
      const extendVisibility = delivery.extendVisibility;
      const visibilityHeartbeat =
        extendVisibility === undefined
          ? undefined
          : setInterval(() => {
              visibilityHeartbeatOperation = visibilityHeartbeatOperation
                .then(() => extendVisibility(60))
                .catch(() => {
                  visibilityHeartbeatFailed = true;
                });
            }, 15_000);
      let outcome: Awaited<ReturnType<MeasurementMessageProcessor['process']>>;
      try {
        outcome =
          traceContext === undefined
            ? await runWorkerOperation(
                'PROCESS',
                () => input.processor.process(delivery.message),
                operationSucceeded,
              )
            : await runWorkerOperation(
                'PROCESS',
                () => input.processor.process(delivery.message, traceContext),
                operationSucceeded,
              );
      } finally {
        if (visibilityHeartbeat !== undefined) clearInterval(visibilityHeartbeat);
        await visibilityHeartbeatOperation;
      }
      if (visibilityHeartbeatFailed) {
        input.logger?.warn('JOB_HEARTBEAT_FAILED', logInput);
        throw new Error('SQS_VISIBILITY_HEARTBEAT_FAILED');
      }
      if ('heartbeatFailed' in outcome && outcome.heartbeatFailed) {
        input.logger?.warn('JOB_HEARTBEAT_FAILED', {
          ...logInput,
          attributes: {
            ...logInput.attributes,
            outcome: outcome.outcome,
            errorCode: 'DATABASE_LEASE_HEARTBEAT_FAILED',
          },
        });
      }
      if (
        input.terminalFailureEvent === 'PROVIDER_FAILED' &&
        'failureSource' in outcome &&
        outcome.failureSource === 'PROVIDER' &&
        'providerFailureCount' in outcome &&
        (outcome.providerFailureCount ?? 0) > 0
      ) {
        input.logger?.warn('PROVIDER_FAILED', {
          ...logInput,
          attributes: {
            ...logInput.attributes,
            outcome: outcome.outcome,
            errorCode: 'MEASUREMENT_PROVIDER_SLOT_ERROR',
            count: outcome.providerFailureCount,
          },
        });
      }
      if (outcome.outcome === 'FAILED_TERMINAL') {
        if (input.terminalFailureEvent === 'PUBLICATION_FAILED') {
          input.logger?.warn('PUBLICATION_FAILED', {
            ...logInput,
            attributes: { ...logInput.attributes, outcome: outcome.outcome },
          });
        }
      }
      if (
        ['SUCCEEDED', 'FAILED_TERMINAL', 'DUPLICATE', 'NOT_AVAILABLE'].includes(outcome.outcome)
      ) {
        await runWorkerOperation('ACKNOWLEDGE', () => delivery.acknowledge(), operationSucceeded);
        input.logger?.info('WORKER_JOB_ACKNOWLEDGED', {
          ...logInput,
          attributes: { ...logInput.attributes, outcome: outcome.outcome },
        });
      } else {
        const visibilityTimeoutSeconds = ['CONCURRENCY_LIMIT', 'RETRY_WAIT'].includes(
          outcome.outcome,
        )
          ? 30
          : 5;
        if (delivery.extendVisibility === undefined) {
          await runWorkerOperation('RELEASE', () => delivery.release(), operationSucceeded);
        } else {
          await runWorkerOperation(
            'RELEASE',
            () => delivery.release(visibilityTimeoutSeconds),
            operationSucceeded,
          );
        }
        input.logger?.info('WORKER_JOB_RELEASED', {
          ...logInput,
          attributes: { ...logInput.attributes, outcome: outcome.outcome },
        });
      }
      return outcome;
    };
    if (delivery.traceContext === undefined) return processDelivery();
    return traceRunner.run(
      {
        operation: 'WORKER_PROCESS',
        traceContext: delivery.traceContext,
        message: delivery.message,
      },
      processDelivery,
    );
  }

  function runOnce(signal?: AbortSignal) {
    return executeOnce(signal);
  }

  async function waitForNextPoll(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(done, pollIntervalMs);

      function done() {
        clearTimeout(timeout);
        signal.removeEventListener('abort', done);
        resolve();
      }

      signal.addEventListener('abort', done, { once: true });
    });
  }

  async function runConsumer(signal: AbortSignal): Promise<void> {
    const consecutiveFailures = new Map<WorkerOperation, number>();
    while (!signal.aborted) {
      let outcome: Awaited<ReturnType<typeof runOnce>>;
      try {
        outcome = await executeOnce(signal, (operation) => {
          consecutiveFailures.set(operation, 0);
        });
      } catch (error: unknown) {
        if (signal.aborted) return;
        const operation =
          error instanceof WorkerOperationFailure ? error.operation : ('UNKNOWN' as const);
        const consecutiveFailureCount = (consecutiveFailures.get(operation) ?? 0) + 1;
        consecutiveFailures.set(operation, consecutiveFailureCount);
        input.logger?.warn('WORKER_OPERATION_RETRY', {
          attributes: {
            operation,
            consecutiveFailureCount,
            maxConsecutiveFailures,
          },
        });
        if (consecutiveFailureCount >= maxConsecutiveFailures) {
          throw new Error('WORKER_CONSUMER_FAILURE_BUDGET_EXHAUSTED', { cause: error });
        }
        await waitForNextPoll(signal);
        continue;
      }
      if (
        ['IDLE', 'BUSY', 'CONCURRENCY_LIMIT', 'RETRY_WAIT', 'LEASE_LOST'].includes(outcome.outcome)
      ) {
        await waitForNextPoll(signal);
      }
    }
  }

  return {
    consumerConcurrency,
    runOnce,
    async run(signal: AbortSignal) {
      const siblings = new AbortController();
      const abort = () => siblings.abort();
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      try {
        const runPoolMember = async () => {
          try {
            await runConsumer(siblings.signal);
          } catch {
            abort();
            throw new Error('WORKER_CONSUMER_POOL_MEMBER_FAILED');
          }
        };
        const outcomes = await Promise.allSettled(
          Array.from({ length: consumerConcurrency }, () => runPoolMember()),
        );
        if (outcomes.some((outcome) => outcome.status === 'rejected')) {
          throw new Error('WORKER_CONSUMER_POOL_FAILED');
        }
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
  };
}

function readConsumerConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new Error('WORKER_CONSUMER_CONCURRENCY_INVALID');
  }
  return value;
}

function readMaxConsecutiveFailures(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error('WORKER_CONSUMER_FAILURE_POLICY_INVALID');
  }
  return value;
}

async function runWorkerOperation<T>(
  operation: TrackedWorkerOperation,
  effect: () => Promise<T>,
  operationSucceeded?: (operation: TrackedWorkerOperation) => void,
): Promise<T> {
  try {
    const result = await effect();
    operationSucceeded?.(operation);
    return result;
  } catch (error: unknown) {
    if (error instanceof WorkerOperationFailure) throw error;
    throw new WorkerOperationFailure(operation);
  }
}
