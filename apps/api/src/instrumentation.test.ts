import { describe, expect, test, vi } from 'vitest';

import { startApiInstrumentation } from './instrumentation.js';

describe('API instrumentation bootstrap', () => {
  test('starts telemetry before the API module is loaded and exposes shutdown', async () => {
    const start = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const shutdown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const telemetry = await startApiInstrumentation({
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
