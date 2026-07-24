import { describe, expect, test } from 'vitest';

import { readJobTraceContext, traceIdFromJobTraceContext } from './job-trace-context.js';

const valid = {
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  requestId: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
};

describe('job trace context validation', () => {
  test('accepts one minimal W3C traceparent and opaque UUID request ID', () => {
    expect(readJobTraceContext(valid)).toEqual(valid);
    expect(traceIdFromJobTraceContext(valid)).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  test.each([
    { ...valid, traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' },
    { ...valid, traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01' },
    { ...valid, traceparent: valid.traceparent.toUpperCase() },
    { ...valid, requestId: 'email@example.test?token=secret' },
    { ...valid, prompt: 'must-not-enter-trace-context' },
  ])('rejects malformed or over-wide trace metadata', (candidate) => {
    expect(() => readJobTraceContext(candidate)).toThrow('INVALID_JOB_TRACE_CONTEXT');
  });
});
