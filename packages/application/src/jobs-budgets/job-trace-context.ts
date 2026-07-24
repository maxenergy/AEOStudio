import type { JobTraceContext } from './execution-ports.js';

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u;
const ALL_ZERO_TRACE_ID = /^0{32}$/u;
const ALL_ZERO_SPAN_ID = /^0{16}$/u;

export function readJobTraceContext(value: unknown): JobTraceContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('INVALID_JOB_TRACE_CONTEXT');
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2 ||
    typeof candidate.traceparent !== 'string' ||
    typeof candidate.requestId !== 'string' ||
    !REQUEST_ID.test(candidate.requestId)
  ) {
    throw new Error('INVALID_JOB_TRACE_CONTEXT');
  }
  const parsed = TRACEPARENT.exec(candidate.traceparent);
  if (
    parsed === null ||
    parsed[1] === undefined ||
    parsed[2] === undefined ||
    ALL_ZERO_TRACE_ID.test(parsed[1]) ||
    ALL_ZERO_SPAN_ID.test(parsed[2])
  ) {
    throw new Error('INVALID_JOB_TRACE_CONTEXT');
  }
  return { traceparent: candidate.traceparent, requestId: candidate.requestId };
}

export function traceIdFromJobTraceContext(value: JobTraceContext): string {
  const traceId = TRACEPARENT.exec(value.traceparent)?.[1];
  if (traceId === undefined) throw new Error('INVALID_JOB_TRACE_CONTEXT');
  return traceId;
}
