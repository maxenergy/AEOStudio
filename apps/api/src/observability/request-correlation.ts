import type { StructuredApplicationLogger } from '@aeostudio/adapters/observability';

interface RequestLike {
  raw: object;
  id: string;
  headers: Readonly<Record<string, unknown>>;
}

interface ReplyLike {
  statusCode: number;
  header(name: string, value: string): unknown;
}

interface RequestState {
  requestId: string;
  traceId?: string;
  startedAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TRACE_ID = /^[0-9a-f]{32}$/iu;

export function createApiRequestTelemetry(
  logger: StructuredApplicationLogger,
  input: {
    traceIds: { current(): string | undefined };
    clock: { now(): number };
  },
) {
  const requests = new WeakMap<object, RequestState>();
  return {
    onRequest(request: RequestLike, reply: ReplyLike): void {
      const requestId = readUuid(request.id);
      const traceId = readTraceId(input.traceIds.current());
      const startedAt = readClock(input.clock);
      requests.set(request.raw, {
        requestId,
        ...(traceId === undefined ? {} : { traceId }),
        startedAt,
      });
      reply.header('x-request-id', requestId);
      logger.info('HTTP_REQUEST_RECEIVED', {
        correlation: { requestId, ...(traceId === undefined ? {} : { traceId }) },
      });
    },
    onResponse(request: RequestLike, reply: ReplyLike): void {
      const state = requests.get(request.raw);
      if (state === undefined) return;
      requests.delete(request.raw);
      const durationMs = Math.min(
        86_400_000,
        Math.max(0, Math.round(readClock(input.clock) - state.startedAt)),
      );
      const statusClass = Math.min(5, Math.max(1, Math.floor(reply.statusCode / 100)));
      const correlation = {
        requestId: state.requestId,
        ...(state.traceId === undefined ? {} : { traceId: state.traceId }),
      };
      if (reply.statusCode === 401 || reply.statusCode === 403) {
        logger.warn('AUTHENTICATION_DENIED', {
          correlation,
          attributes: { outcome: `HTTP_${String(reply.statusCode)}` },
        });
      }
      logger.info('HTTP_REQUEST_COMPLETED', {
        correlation,
        attributes: { durationMs, outcome: `HTTP_${statusClass}XX` },
      });
    },
  };
}

export function resolveRequestId(
  supplied: string | string[] | undefined,
  ids: { next(): string },
): string {
  return readUuid(typeof supplied === 'string' && UUID.test(supplied) ? supplied : ids.next());
}

function readUuid(value: string): string {
  if (!UUID.test(value)) throw new Error('INVALID_GENERATED_REQUEST_ID');
  return value.toLowerCase();
}

function readTraceId(value: string | undefined): string | undefined {
  return value !== undefined && TRACE_ID.test(value) ? value.toLowerCase() : undefined;
}

function readClock(clock: { now(): number }): number {
  const value = clock.now();
  if (!Number.isFinite(value) || value < 0) throw new Error('INVALID_OBSERVABILITY_CLOCK');
  return value;
}
