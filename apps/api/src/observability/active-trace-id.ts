import { trace } from '@opentelemetry/api';

export const activeTraceIdProvider = {
  current(): string | undefined {
    const traceId = trace.getActiveSpan()?.spanContext().traceId;
    return typeof traceId === 'string' && /^[0-9a-f]{32}$/iu.test(traceId) ? traceId : undefined;
  },
};
