import { describe, expect, test, vi } from 'vitest';

import { startWebInstrumentation } from './instrumentation.js';

describe('Web OpenTelemetry instrumentation', () => {
  test('starts a named production runtime and can flush it during shutdown', async () => {
    const start = vi.fn();
    const shutdown = vi.fn();
    const sdkFactory = vi.fn(() => Promise.resolve({ start, shutdown }));

    const runtime = await startWebInstrumentation({
      environment: {
        NODE_ENV: 'production',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      },
      sdkFactory,
    });

    expect(sdkFactory).toHaveBeenCalledWith(
      expect.objectContaining({ serviceName: 'aeostudio-web', environmentName: 'production' }),
    );
    expect(start).toHaveBeenCalledOnce();
    await runtime.shutdown();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
