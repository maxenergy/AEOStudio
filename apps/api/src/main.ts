import 'reflect-metadata';

import { startApiInstrumentation } from './instrumentation.js';

const port = Number.parseInt(process.env.PORT ?? '3200', 10);
const host = process.env.HOST ?? '127.0.0.1';
const runtimeSmoke = process.argv.includes('--runtime-smoke');

const telemetry = runtimeSmoke
  ? { shutdown: () => Promise.resolve() }
  : await startApiInstrumentation({ environment: process.env });
try {
  // Instrumentation must start before Nest, Fastify, pg and AWS SDK modules load.
  const { createApiApp } = await import('./app.js');
  if (runtimeSmoke) {
    await telemetry.shutdown();
    process.stdout.write('API_RUNTIME_SMOKE_OK\n');
  } else {
    const app = await createApiApp();
    await app.listen(port, host);
    let shutdown: Promise<void> | undefined;
    const requestShutdown = () => {
      shutdown ??= (async () => {
        try {
          await app.close();
        } finally {
          await telemetry.shutdown();
        }
      })();
      void shutdown.catch(() => {
        process.stderr.write('API_SHUTDOWN_FAILED\n');
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', requestShutdown);
    process.once('SIGTERM', requestShutdown);
  }
} catch (error: unknown) {
  await telemetry.shutdown();
  throw error;
}
