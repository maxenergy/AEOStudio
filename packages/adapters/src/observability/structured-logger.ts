import pino, { type DestinationStream, type Logger } from 'pino';

export interface LogCorrelation {
  traceId?: string;
  requestId?: string;
  jobId?: string;
}

export interface ApplicationLogInput {
  correlation?: LogCorrelation;
  attributes?: Readonly<Record<string, unknown>>;
}

export interface StructuredApplicationLogger {
  debug(event: string, input?: ApplicationLogInput): void;
  info(event: string, input?: ApplicationLogInput): void;
  warn(event: string, input?: ApplicationLogInput): void;
  error(event: string, input?: ApplicationLogInput): void;
  flush(): void;
}

const SENSITIVE_PINO_PATHS = [
  'authorization',
  'cookie',
  'token',
  'password',
  'secret',
  'secretArn',
  'prompt',
  'content',
  'rawResponse',
  'query',
  'email',
  'phone',
  'address',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TRACE_ID = /^(?:[0-9a-f]{16}|[0-9a-f]{32})$/iu;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const ECS_TASK_ARN =
  /^arn:aws:ecs:[a-z]{2}-[a-z]+-[1-9][0-9]*:[0-9]{12}:task\/[A-Za-z0-9_-]{1,255}\/[0-9a-f]{32}$/u;
const ECS_TASK_DEFINITION_ARN =
  /^arn:aws:ecs:[a-z]{2}-[a-z]+-[1-9][0-9]*:[0-9]{12}:task-definition\/[A-Za-z0-9_-]{1,255}:[1-9][0-9]{0,9}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

type SafeLogRecord = Record<string, string | number>;

/**
 * Creates the only application logging boundary used by runtime composition.
 * Callers cannot pass arbitrary objects to Pino: content is reduced to a small
 * allowlist before serialization, with Pino redaction retained as defence in depth.
 */
export function createStructuredApplicationLogger(input: {
  serviceName: string;
  destination?: DestinationStream;
  level?: 'debug' | 'info' | 'warn' | 'error';
}): StructuredApplicationLogger {
  const serviceName = readServiceName(input.serviceName);
  const target: DestinationStream = input.destination ?? process.stdout;
  const logger = pino(
    {
      base: { service: serviceName },
      level: input.level ?? 'info',
      redact: {
        paths: [...SENSITIVE_PINO_PATHS],
        censor: '[REDACTED]',
      },
    },
    target,
  );

  return {
    debug: (event, value) => write(logger, 'debug', event, value),
    info: (event, value) => write(logger, 'info', event, value),
    warn: (event, value) => write(logger, 'warn', event, value),
    error: (event, value) => write(logger, 'error', event, value),
    flush: () => logger.flush(),
  };
}

function write(
  logger: Logger,
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  input?: ApplicationLogInput,
): void {
  const record = safeRecord(event, input);
  logger[level](record);
}

function safeRecord(event: string, input?: ApplicationLogInput): SafeLogRecord {
  if (!CODE.test(event)) throw new Error('INVALID_LOG_EVENT');
  const result: SafeLogRecord = { event };
  copyTraceId(result, 'trace_id', input?.correlation?.traceId);
  copyUuid(result, 'request_id', input?.correlation?.requestId);
  copyUuid(result, 'job_id', input?.correlation?.jobId);

  const attributes = input?.attributes;
  if (attributes === undefined) return result;
  copyUuid(result, 'tenant_id', attributes.tenantId);
  copyUuid(result, 'workspace_id', attributes.workspaceId);
  copyUuid(result, 'publication_id', attributes.publicationId);
  copyUuid(result, 'measurement_run_id', attributes.measurementRunId);
  copyCode(result, 'outcome', attributes.outcome);
  copyCode(result, 'error_code', attributes.errorCode);
  copyBoundedInteger(result, 'attempt', attributes.attempt, 1_000);
  copyBoundedInteger(result, 'duration_ms', attributes.durationMs, 86_400_000);
  copyBoundedInteger(result, 'count', attributes.count, 10_000);
  copyExact(result, 'runtime_task_arn', attributes.runtimeTaskArn, ECS_TASK_ARN);
  copyExact(
    result,
    'runtime_task_definition_arn',
    attributes.runtimeTaskDefinitionArn,
    ECS_TASK_DEFINITION_ARN,
  );
  copyExact(result, 'runtime_image_digest', attributes.runtimeImageDigest, SHA256_DIGEST);
  copyExact(result, 'runtime_image_id', attributes.runtimeImageId, SHA256_DIGEST);
  return result;
}

function copyExact(target: SafeLogRecord, key: string, value: unknown, pattern: RegExp): void {
  if (typeof value === 'string' && pattern.test(value)) target[key] = value;
}

function copyUuid(target: SafeLogRecord, key: string, value: unknown): void {
  if (typeof value === 'string' && UUID.test(value)) target[key] = value.toLowerCase();
}

function copyTraceId(target: SafeLogRecord, key: string, value: unknown): void {
  if (typeof value === 'string' && TRACE_ID.test(value)) target[key] = value.toLowerCase();
}

function copyCode(target: SafeLogRecord, key: string, value: unknown): void {
  if (typeof value === 'string' && CODE.test(value)) target[key] = value;
}

function copyBoundedInteger(
  target: SafeLogRecord,
  key: string,
  value: unknown,
  maximum: number,
): void {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum) {
    target[key] = value;
  }
}

function readServiceName(value: string): string {
  if (!/^[a-z][a-z0-9-]{2,63}$/u.test(value)) throw new Error('INVALID_LOG_SERVICE_NAME');
  return value;
}
