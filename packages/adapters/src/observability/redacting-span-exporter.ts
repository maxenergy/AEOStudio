import type { AttributeValue, Attributes } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

const HTTP_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
const ROUTE_LITERALS = new Set([
  'api',
  'app',
  'artifacts',
  'auth',
  'channels',
  'content-plans',
  'crawls',
  'experiments',
  'health',
  'jobs',
  'measurement',
  'measurements',
  'offerings',
  'privacy',
  'profiles',
  'publications',
  'ready',
  'session',
  'sites',
  'tenants',
  'v1',
  'workspaces',
]);
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9._-]{0,119}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Reduces every exported span to an explicit operational allowlist. Auto-instrumentation may
 * observe URLs, SQL, headers and exception messages before application logging redaction runs;
 * this boundary prevents those values from reaching the regional OTLP collector.
 */
export function createRedactingSpanExporter(delegate: SpanExporter): SpanExporter {
  return {
    export(spans, resultCallback) {
      delegate.export(spans.map(sanitizeSpan), resultCallback);
    },
    shutdown: () => delegate.shutdown(),
    ...(delegate.forceFlush === undefined
      ? {}
      : { forceFlush: () => delegate.forceFlush?.() ?? Promise.resolve() }),
  };
}

function sanitizeSpan(span: ReadableSpan): ReadableSpan {
  const attributes = sanitizeAttributes(span.attributes);
  return {
    name: safeSpanName(attributes),
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext === undefined ? {} : { parentSpanContext: span.parentSpanContext }),
    startTime: span.startTime,
    endTime: span.endTime,
    status: { code: span.status.code },
    attributes,
    links: span.links.map((link) => ({
      context: link.context,
      attributes: {},
      ...(link.droppedAttributesCount === undefined
        ? {}
        : { droppedAttributesCount: link.droppedAttributesCount }),
    })),
    events: span.events.map((event) => ({
      name: safeEventName(event.name),
      time: event.time,
      attributes: sanitizeEventAttributes(event.attributes),
      ...(event.droppedAttributesCount === undefined
        ? {}
        : { droppedAttributesCount: event.droppedAttributesCount }),
    })),
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

function sanitizeAttributes(source: Attributes): Attributes {
  const result: Attributes = {};
  copyHttpMethod(result, source, 'http.request.method');
  copyHttpMethod(result, source, 'http.method');
  copyInteger(result, source, 'http.response.status_code', 100, 599);
  copyInteger(result, source, 'http.status_code', 100, 599);
  const route = source['http.route'];
  if (typeof route === 'string') result['http.route'] = sanitizeRoute(route);
  copyCode(result, source, 'db.system.name');
  copyCode(result, source, 'db.system');
  copyCode(result, source, 'db.operation.name');
  copyCode(result, source, 'messaging.system');
  copyCode(result, source, 'messaging.operation.name');
  copyCode(result, source, 'rpc.system');
  copyCode(result, source, 'rpc.service');
  copyCode(result, source, 'rpc.method');
  copyCode(result, source, 'network.transport');
  copyCode(result, source, 'network.protocol.version');
  copyCode(result, source, 'error.type');
  copyInteger(result, source, 'server.port', 1, 65_535);
  copyUuid(result, source, 'aeostudio.tenant.id');
  copyUuid(result, source, 'aeostudio.workspace.id');
  copyUuid(result, source, 'aeostudio.job.id');
  copyUuid(result, source, 'aeostudio.publication.id');
  copyUuid(result, source, 'aeostudio.measurement_run.id');
  return result;
}

function sanitizeEventAttributes(source: Attributes | undefined): Attributes {
  const result: Attributes = {};
  if (source === undefined) return result;
  copyCode(result, source, 'exception.type');
  copyCode(result, source, 'error.type');
  return result;
}

function safeSpanName(attributes: Attributes): string {
  const method = attributes['http.request.method'] ?? attributes['http.method'];
  if (typeof method === 'string') return `HTTP ${method}`;
  const databaseOperation = attributes['db.operation.name'];
  if (typeof databaseOperation === 'string') return `DATABASE ${databaseOperation.toUpperCase()}`;
  const messagingOperation = attributes['messaging.operation.name'];
  if (typeof messagingOperation === 'string') {
    return `MESSAGING ${messagingOperation.toUpperCase()}`;
  }
  const rpcMethod = attributes['rpc.method'];
  if (typeof rpcMethod === 'string') return `RPC ${rpcMethod.toUpperCase()}`;
  return 'APPLICATION_OPERATION';
}

function safeEventName(value: string): string {
  return value === 'exception' ? 'exception' : 'application.event';
}

function sanitizeRoute(value: string): string {
  if (!value.startsWith('/') || value.length > 512 || value.includes('?') || value.includes('#')) {
    return '/:value';
  }
  return value
    .split('/')
    .map((segment, index) => {
      if (index === 0 || segment.length === 0) return '';
      if (/^(?::[A-Za-z][A-Za-z0-9_]*|\{[A-Za-z][A-Za-z0-9_]*\})$/u.test(segment)) {
        return ':param';
      }
      if (UUID.test(segment) || /^\d+$/u.test(segment)) return ':id';
      const normalized = segment.toLowerCase();
      return ROUTE_LITERALS.has(normalized) ? normalized : ':value';
    })
    .join('/');
}

function copyHttpMethod(target: Attributes, source: Attributes, key: string): void {
  const value = source[key];
  if (typeof value === 'string') {
    const normalized = value.toUpperCase();
    if (HTTP_METHODS.has(normalized)) target[key] = normalized;
  }
}

function copyCode(target: Attributes, source: Attributes, key: string): void {
  const value = source[key];
  if (typeof value === 'string' && SAFE_CODE.test(value)) target[key] = value;
}

function copyUuid(target: Attributes, source: Attributes, key: string): void {
  const value = source[key];
  if (typeof value === 'string' && UUID.test(value)) target[key] = value.toLowerCase();
}

function copyInteger(
  target: Attributes,
  source: Attributes,
  key: string,
  minimum: number,
  maximum: number,
): void {
  const value: AttributeValue | undefined = source[key];
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  ) {
    target[key] = value;
  }
}
