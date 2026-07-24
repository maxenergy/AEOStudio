import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type * as OpenTelemetryApi from '@opentelemetry/api';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const otel = vi.hoisted(() => {
  const span = {
    end: vi.fn(),
    setStatus: vi.fn(),
  };
  return {
    span,
    inject: vi.fn(),
    extract: vi.fn(() => ({ extracted: true })),
    withContext: vi.fn((_context: unknown, operation: () => unknown) => operation()),
    startActiveSpan: vi.fn(
      (
        _name: string,
        _options: unknown,
        operation: (span: { end(): void; setStatus(input: unknown): void }) => unknown,
      ) => operation(span),
    ),
  };
});

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof OpenTelemetryApi>();
  return {
    ...actual,
    context: {
      active: () => ({ active: true }),
      with: otel.withContext,
    },
    propagation: {
      inject: otel.inject,
      extract: otel.extract,
    },
    trace: {
      getTracer: () => ({ startActiveSpan: otel.startActiveSpan }),
    },
  };
});

import {
  activeJobTraceContextProvider,
  openTelemetryJobTraceContextRunner,
} from './job-trace-context.js';

const traceContext = {
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  requestId: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
};
const message = {
  messageId: '018f84b3-7eb8-7c75-9ca5-25278969d3f0',
  payload: {
    jobId: '018f84b3-7eb8-7c75-9ca5-25278969d3f1',
    tenantId: '018f84b3-7eb8-7c75-9ca5-25278969d3f2',
    workspaceId: '018f84b3-7eb8-7c75-9ca5-25278969d3f3',
    schemaVersion: '1.0.0' as const,
  },
};

describe('OpenTelemetry job trace context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    otel.inject.mockImplementation((_context, carrier: Record<string, string>) => {
      carrier.traceparent = traceContext.traceparent;
    });
  });

  test('captures only traceparent plus the validated request ID from the active HTTP context', () => {
    expect(activeJobTraceContextProvider.capture(traceContext.requestId)).toEqual(traceContext);
    expect(otel.inject).toHaveBeenCalledOnce();
  });

  test('restores the remote parent and wraps Worker work in one CONSUMER process span', async () => {
    const operation = vi.fn(() => Promise.resolve('done'));

    await expect(
      openTelemetryJobTraceContextRunner.run(
        { operation: 'WORKER_PROCESS', traceContext, message },
        operation,
      ),
    ).resolves.toBe('done');

    expect(otel.extract).toHaveBeenCalledWith(
      { active: true },
      { traceparent: traceContext.traceparent },
    );
    expect(otel.startActiveSpan).toHaveBeenCalledWith(
      'job process',
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'aws_sqs',
          'messaging.operation.name': 'process',
          'aeostudio.tenant.id': message.payload.tenantId,
          'aeostudio.workspace.id': message.payload.workspaceId,
          'aeostudio.job.id': message.payload.jobId,
        },
      },
      expect.any(Function),
    );
    expect(operation).toHaveBeenCalledOnce();
    expect(otel.span.end).toHaveBeenCalledOnce();
  });

  test('uses a non-duplicating INTERNAL relay span and closes it on failure', async () => {
    await expect(
      openTelemetryJobTraceContextRunner.run(
        { operation: 'OUTBOX_RELAY', traceContext, message },
        () => Promise.reject(new Error('SQS_UNAVAILABLE')),
      ),
    ).rejects.toThrow('SQS_UNAVAILABLE');

    expect(otel.startActiveSpan).toHaveBeenCalledWith(
      'outbox relay',
      expect.objectContaining({ kind: SpanKind.INTERNAL }),
      expect.any(Function),
    );
    expect(otel.span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(otel.span.end).toHaveBeenCalledOnce();
  });
});
