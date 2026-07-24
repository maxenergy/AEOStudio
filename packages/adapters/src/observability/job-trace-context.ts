import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  readJobTraceContext,
  type JobTraceContext,
  type JobTraceContextProvider,
  type JobTraceContextRunnerPort,
} from '@aeostudio/application/jobs-budgets';

const tracer = trace.getTracer('@aeostudio/job-pipeline');

export const activeJobTraceContextProvider: JobTraceContextProvider = {
  capture(requestId: string): JobTraceContext | undefined {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    if (carrier.traceparent === undefined) return undefined;
    return readJobTraceContext({ traceparent: carrier.traceparent, requestId });
  },
};

export const openTelemetryJobTraceContextRunner: JobTraceContextRunnerPort = {
  run<T>(input: Parameters<JobTraceContextRunnerPort['run']>[0], operation: () => Promise<T>) {
    const traceContext = readJobTraceContext(input.traceContext);
    const parent = propagation.extract(context.active(), {
      traceparent: traceContext.traceparent,
    });
    const isConsumer = input.operation === 'WORKER_PROCESS';
    return context.with(parent, () =>
      tracer.startActiveSpan(
        isConsumer ? 'job process' : 'outbox relay',
        {
          kind: isConsumer ? SpanKind.CONSUMER : SpanKind.INTERNAL,
          attributes: {
            'messaging.system': 'aws_sqs',
            'messaging.operation.name': isConsumer ? 'process' : 'publish',
            'aeostudio.tenant.id': input.message.payload.tenantId,
            'aeostudio.workspace.id': input.message.payload.workspaceId,
            'aeostudio.job.id': input.message.payload.jobId,
          },
        },
        async (span) => {
          try {
            return await operation();
          } catch (error: unknown) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            span.end();
          }
        },
      ),
    );
  },
};
