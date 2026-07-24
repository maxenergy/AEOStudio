import { describe, expect, test, vi } from 'vitest';

import { startWorkerInstrumentation } from './instrumentation.js';

describe('Worker instrumentation bootstrap', () => {
  test('starts the Worker OpenTelemetry SDK and exposes deterministic shutdown', async () => {
    const start = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const shutdown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const telemetry = await startWorkerInstrumentation({
      environment: {
        NODE_ENV: 'production',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      },
      sdkFactory: () => Promise.resolve({ start, shutdown }),
    });

    expect(start).toHaveBeenCalledOnce();
    await telemetry.shutdown();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
