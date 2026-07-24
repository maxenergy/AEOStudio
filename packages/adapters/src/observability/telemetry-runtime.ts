import { createRedactingSpanExporter } from '@aeostudio/adapters/observability/redacting-span-exporter';

export interface TelemetryEnvironment {
  [name: string]: string | undefined;
  NODE_ENV?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_SDK_DISABLED?: string;
}

export interface TelemetrySdk {
  start(): void | Promise<void>;
  shutdown(): void | Promise<void>;
}

export interface TelemetrySdkConfig {
  serviceName: string;
  environmentName: string;
  traceEndpoint: string;
}

export type TelemetrySdkFactory = (config: TelemetrySdkConfig) => Promise<TelemetrySdk>;

export interface NodeTelemetryRuntime {
  enabled: boolean;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export function sensitiveInstrumentationOverrides(
  environment: Readonly<Record<string, string | undefined>>,
) {
  void environment;
  // Programmatic `enabled: false` has precedence over OTEL_NODE_* environment variables.
  return {
    '@opentelemetry/instrumentation-bunyan': { enabled: false as const },
    '@opentelemetry/instrumentation-fs': { enabled: false as const },
    '@opentelemetry/instrumentation-openai': { enabled: false as const },
    '@opentelemetry/instrumentation-pino': { enabled: false as const },
    '@opentelemetry/instrumentation-winston': { enabled: false as const },
  };
}

export function enforceSafeOpenTelemetryEnvironment(
  environment: Record<string, string | undefined>,
): void {
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith('OTEL_')) delete environment[key];
  }
  Object.assign(environment, {
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false',
    OTEL_LOG_LEVEL: 'none',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_NODE_RESOURCE_DETECTORS: 'none',
    OTEL_PROPAGATORS: 'tracecontext',
    OTEL_SDK_DISABLED: 'false',
    OTEL_TRACES_EXPORTER: 'none',
    OTEL_TRACES_SAMPLER: 'parentbased_always_on',
  });
}

/** Resolve telemetry before importing the application framework or database clients. */
export async function resolveNodeTelemetryRuntime(input: {
  serviceName: string;
  environment: TelemetryEnvironment;
  sdkFactory?: TelemetrySdkFactory;
}): Promise<NodeTelemetryRuntime> {
  const serviceName = readServiceName(input.serviceName);
  const environmentName = readEnvironmentName(input.environment.NODE_ENV);
  const endpoint = input.environment.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint === undefined || endpoint.length === 0) {
    if (environmentName === 'production') throw new Error('OTEL_EXPORTER_OTLP_ENDPOINT_REQUIRED');
    return disabledRuntime();
  }
  if (input.environment.OTEL_SDK_DISABLED === 'true' && environmentName === 'production') {
    throw new Error('PRODUCTION_TELEMETRY_CANNOT_BE_DISABLED');
  }
  const traceEndpoint = readTraceEndpoint(endpoint, environmentName);
  const sdk = await (input.sdkFactory ?? createOpenTelemetrySdk)({
    serviceName,
    environmentName,
    traceEndpoint,
  });
  let started = false;
  let stopped = false;
  return {
    enabled: true,
    async start() {
      if (started) return;
      await sdk.start();
      started = true;
    },
    async shutdown() {
      if (!started || stopped) return;
      await sdk.shutdown();
      stopped = true;
    },
  };
}

async function createOpenTelemetrySdk(config: TelemetrySdkConfig): Promise<TelemetrySdk> {
  // The endpoint has already been parsed into `config`. Remove every ambient OTEL override before
  // loading the SDK so debug diagnostics, alternate exporters and content capture cannot bypass
  // the regional redaction boundary.
  enforceSafeOpenTelemetryEnvironment(process.env);
  const [
    { NodeSDK },
    { AwsInstrumentation },
    { HttpInstrumentation },
    { NestInstrumentation },
    { PgInstrumentation },
    { UndiciInstrumentation },
    { OTLPTraceExporter },
    resources,
    api,
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/instrumentation-aws-sdk'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-nestjs-core'),
    import('@opentelemetry/instrumentation-pg'),
    import('@opentelemetry/instrumentation-undici'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/api'),
  ]);
  // Diagnostic output can contain library arguments. Keep it disabled even if OTEL_LOG_LEVEL is
  // injected as `debug`; all application logs go through the structured allowlist instead.
  api.diag.disable();
  const traceExporter = createRedactingSpanExporter(
    new OTLPTraceExporter({ url: config.traceEndpoint }),
  );
  const sdk = new NodeSDK({
    autoDetectResources: false,
    logRecordProcessors: [],
    metricReaders: [],
    resource: resources.resourceFromAttributes({
      'service.name': config.serviceName,
      'deployment.environment.name': config.environmentName,
    }),
    traceExporter,
    instrumentations: [
      new AwsInstrumentation(),
      new HttpInstrumentation(),
      new NestInstrumentation(),
      new PgInstrumentation(),
      new UndiciInstrumentation(),
    ],
  });
  // NodeSDK consults OTEL_LOG_LEVEL in its constructor. Disable diagnostics again afterwards so a
  // later library cannot write raw arguments to stdout.
  api.diag.disable();
  return sdk;
}

function disabledRuntime(): NodeTelemetryRuntime {
  return {
    enabled: false,
    start: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

function readServiceName(value: string): string {
  if (!/^[a-z][a-z0-9-]{2,63}$/u.test(value)) throw new Error('INVALID_OTEL_SERVICE_NAME');
  return value;
}

function readEnvironmentName(value: string | undefined): string {
  const candidate = value ?? 'development';
  if (!/^[a-z][a-z0-9-]{1,31}$/u.test(candidate)) {
    throw new Error('INVALID_DEPLOYMENT_ENVIRONMENT_NAME');
  }
  return candidate;
}

function readTraceEndpoint(value: string, environmentName: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('INVALID_OTEL_EXPORTER_OTLP_ENDPOINT');
  }
  const hostname = endpoint.hostname.replace(/^\[|\]$/gu, '');
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(hostname);
  const localHttp = endpoint.protocol === 'http:' && loopback;
  if (endpoint.protocol !== 'https:' && !localHttp) {
    throw new Error('INSECURE_OTEL_EXPORTER_OTLP_ENDPOINT');
  }
  if (environmentName === 'production' && !loopback) {
    throw new Error('PRODUCTION_OTLP_COLLECTOR_MUST_BE_LOOPBACK');
  }
  endpoint.search = '';
  endpoint.hash = '';
  endpoint.pathname = `${endpoint.pathname.replace(/\/(?:v1\/traces)?$/u, '')}/v1/traces`;
  return endpoint.toString().replace(/\/$/u, '');
}
