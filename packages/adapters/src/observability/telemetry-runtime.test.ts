import { readFile } from 'node:fs/promises';

import { describe, expect, test, vi } from 'vitest';

import {
  enforceSafeOpenTelemetryEnvironment,
  resolveNodeTelemetryRuntime,
  sensitiveInstrumentationOverrides,
} from './telemetry-runtime.js';

describe('OpenTelemetry runtime composition', () => {
  test('ships only the five production instrumentations used by this AWS runtime', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
    };
    const expected = {
      '@opentelemetry/instrumentation-aws-sdk': '0.75.0',
      '@opentelemetry/instrumentation-http': '0.220.0',
      '@opentelemetry/instrumentation-nestjs-core': '0.66.0',
      '@opentelemetry/instrumentation-pg': '0.72.0',
      '@opentelemetry/instrumentation-undici': '0.30.0',
    };

    expect(manifest.dependencies).not.toHaveProperty('@opentelemetry/auto-instrumentations-node');
    expect(
      Object.fromEntries(
        Object.entries(manifest.dependencies).filter(([name]) =>
          name.startsWith('@opentelemetry/instrumentation-'),
        ),
      ),
    ).toEqual(expected);

    const runtime = await readFile(new URL('./telemetry-runtime.ts', import.meta.url), 'utf8');
    expect(runtime).not.toContain('@opentelemetry/auto-instrumentations-node');
    expect(runtime).not.toContain('getNodeAutoInstrumentations');
    for (const packageName of Object.keys(expected)) {
      expect(runtime).toContain(`import('${packageName}')`);
    }
  });

  test('malicious environment overrides cannot enable content-bearing telemetry loggers', () => {
    const environment: Record<string, string | undefined> = {
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://outside.example.test/SECRET_METRIC',
      OTEL_LOG_LEVEL: 'debug',
      OTEL_RESOURCE_ATTRIBUTES: 'customer.email=owner@example.test',
      OTEL_SDK_DISABLED: 'true',
    };
    enforceSafeOpenTelemetryEnvironment(environment);
    expect(environment).toEqual({
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
    expect(
      sensitiveInstrumentationOverrides({
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'true',
        OTEL_LOG_LEVEL: 'debug',
        OTEL_NODE_ENABLED_INSTRUMENTATIONS: 'openai,pino,bunyan,winston',
      }),
    ).toEqual({
      '@opentelemetry/instrumentation-bunyan': { enabled: false },
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-openai': { enabled: false },
      '@opentelemetry/instrumentation-pino': { enabled: false },
      '@opentelemetry/instrumentation-winston': { enabled: false },
    });
  });

  test('fails closed when a production process has no OTLP destination', async () => {
    await expect(
      resolveNodeTelemetryRuntime({
        serviceName: 'aeostudio-api',
        environment: { NODE_ENV: 'production' },
      }),
    ).rejects.toThrow('OTEL_EXPORTER_OTLP_ENDPOINT_REQUIRED');
  });

  test('production sends telemetry only to the colocated ADOT collector', async () => {
    await expect(
      resolveNodeTelemetryRuntime({
        serviceName: 'aeostudio-api',
        environment: {
          NODE_ENV: 'production',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.outside.example.test',
        },
        sdkFactory: () => Promise.resolve({ start() {}, shutdown() {} }),
      }),
    ).rejects.toThrow('PRODUCTION_OTLP_COLLECTOR_MUST_BE_LOOPBACK');
  });

  test('starts and shuts down the injected SDK with bounded service configuration', async () => {
    const start = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const shutdown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const factory = vi.fn(() => Promise.resolve({ start, shutdown }));

    const runtime = await resolveNodeTelemetryRuntime({
      serviceName: 'aeostudio-worker',
      environment: {
        NODE_ENV: 'production',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      },
      sdkFactory: factory,
    });
    await runtime.start();
    await runtime.start();
    await runtime.shutdown();
    await runtime.shutdown();

    expect(factory).toHaveBeenCalledWith({
      serviceName: 'aeostudio-worker',
      environmentName: 'production',
      traceEndpoint: 'http://127.0.0.1:4318/v1/traces',
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
