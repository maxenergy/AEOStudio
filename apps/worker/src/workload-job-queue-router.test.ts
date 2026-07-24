import type {
  JobExecutionStore,
  JobQueueMessage,
  JobQueuePort,
  JobTraceContext,
  JobTraceContextRunnerPort,
  PendingOutboxMessage,
} from '@aeostudio/application/jobs-budgets';
import { OutboxRelay } from '@aeostudio/application/jobs-budgets';
import { describe, expect, test, vi, type MockedFunction } from 'vitest';

import { createWorkloadJobQueueRouter } from './workload-job-queue-router.js';

describe('workload-isolated production outbox routing', () => {
  test('routes by persisted job type without adding routing metadata to the SQS payload', async () => {
    const scope = {
      tenantId: '018f3b75-4b91-7ef0-8b04-a7c762767dcc',
      workspaceId: '018f3b75-65fe-7f43-ae42-e0950c844507',
    };
    const messages: PendingOutboxMessage[] = [
      pending('PROFILE_READINESS', '018f3b76-0001-7000-8000-000000000001', scope),
      pending('SITE_CRAWL', '018f3b76-0002-7000-8000-000000000002', scope),
      pending('CONTENT_PLAN', '018f3b76-0003-7000-8000-000000000003', scope),
      pending('ARTIFACT_GENERATION', '018f3b76-0004-7000-8000-000000000004', scope),
      pending('PUBLICATION', '018f3b76-0005-7000-8000-000000000005', scope),
      pending('MEASUREMENT', '018f3b76-0006-7000-8000-000000000006', scope),
    ];
    const store = jobStore(messages);
    const queues = {
      crawl: recordingQueue(),
      generation: recordingQueue(),
      publish: recordingQueue(),
      measurement: recordingQueue(),
    };
    const traceRuns: unknown[] = [];
    const traceRunner: JobTraceContextRunnerPort = {
      run<T>(input: Parameters<JobTraceContextRunnerPort['run']>[0], operation: () => Promise<T>) {
        traceRuns.push(input);
        return operation();
      },
    };
    const relay = new OutboxRelay(
      store,
      createWorkloadJobQueueRouter(queues),
      { now: () => new Date('2026-07-22T00:00:00.000Z') },
      traceRunner,
    );

    await expect(relay.relay()).resolves.toBe(6);

    expect(queues.crawl.send).toHaveBeenCalledTimes(1);
    expect(queues.generation.send).toHaveBeenCalledTimes(3);
    expect(queues.publish.send).toHaveBeenCalledTimes(1);
    expect(queues.measurement.send).toHaveBeenCalledTimes(1);
    for (const queue of Object.values(queues)) {
      for (const { message, traceContext } of queue.deliveries) {
        expect(Object.keys(message.payload).sort()).toEqual([
          'jobId',
          'schemaVersion',
          'tenantId',
          'workspaceId',
        ]);
        expect(message.payload).not.toHaveProperty('jobType');
        expect(message.payload).not.toHaveProperty('content');
        expect(message.payload).not.toHaveProperty('secret');
        expect(traceContext).toEqual({
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
          requestId: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
        });
      }
    }
    expect(traceRuns).toHaveLength(6);
  });
});

function pending(
  jobType: PendingOutboxMessage['jobType'],
  jobId: string,
  scope: { tenantId: string; workspaceId: string },
): PendingOutboxMessage {
  return {
    messageId: `message-${jobId}`,
    jobType,
    tenantId: scope.tenantId,
    traceContext: {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      requestId: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
    },
    payload: {
      jobId,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      schemaVersion: '1.0.0',
    },
  };
}

interface RecordingQueue extends JobQueuePort {
  send: MockedFunction<JobQueuePort['send']>;
  deliveries: Array<{ message: JobQueueMessage; traceContext: JobTraceContext | undefined }>;
}

function recordingQueue(): RecordingQueue {
  const deliveries: RecordingQueue['deliveries'] = [];
  return {
    deliveries,
    send: vi.fn<JobQueuePort['send']>((message, traceContext) => {
      deliveries.push({ message, traceContext });
      return Promise.resolve();
    }),
  };
}

function jobStore(messages: PendingOutboxMessage[]): JobExecutionStore {
  return {
    listPendingOutbox: vi.fn(() => Promise.resolve(messages)),
    markOutboxPublished: vi.fn(() => Promise.resolve()),
    claimJob: vi.fn(() => Promise.resolve({ outcome: 'NOT_AVAILABLE' as const })),
    heartbeat: vi.fn(() => Promise.resolve(false)),
    reportProgress: vi.fn(() => Promise.resolve(false)),
    complete: vi.fn(() => Promise.resolve(false)),
    fail: vi.fn(() => Promise.resolve(false as const)),
  };
}
