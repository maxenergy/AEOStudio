import { startWorkerInstrumentation } from './instrumentation.js';
import { resolveProductionWorkerMode } from './production-worker-mode.js';

async function main(): Promise<void> {
  const runtimeSmoke = process.argv.includes('--runtime-smoke');
  const telemetry = runtimeSmoke
    ? { shutdown: () => Promise.resolve() }
    : await startWorkerInstrumentation({ environment: process.env });
  try {
    const mode = resolveProductionWorkerMode({
      AEOSTUDIO_WORKER_MODE: process.env.AEOSTUDIO_WORKER_MODE,
    });
    if (mode === 'tenant-data-broker') {
      // Load the isolated Broker process only after OpenTelemetry instrumentation is active.
      const { runTenantDataBrokerProcess } = await import('./tenant-data-broker-process.js');
      if (runtimeSmoke) {
        await telemetry.shutdown();
        process.stdout.write('WORKER_RUNTIME_SMOKE_OK\n');
        return;
      }
      await runTenantDataBrokerProcess({ environment: process.env });
      await telemetry.shutdown();
      return;
    }

    // Load normal Worker dependencies only after mode selection and instrumentation.
    const [{ runMeasurementWorkerProcess }, { createProductionWorkerRuntime }] = await Promise.all([
      import('./measurement-worker-process.js'),
      import('./production-worker-composition.js'),
    ]);
    if (runtimeSmoke) {
      await telemetry.shutdown();
      process.stdout.write('WORKER_RUNTIME_SMOKE_OK\n');
      return;
    }
    const runtime = await createProductionWorkerRuntime({ environment: process.env });
    await runMeasurementWorkerProcess({
      runtime: {
        run: (signal) => runtime.run(signal),
        async close() {
          try {
            await runtime.close();
          } finally {
            await telemetry.shutdown();
          }
        },
      },
      signals: {
        once(signal, listener) {
          process.once(signal, listener);
        },
        off(signal, listener) {
          process.off(signal, listener);
        },
      },
    });
  } catch (error: unknown) {
    await telemetry.shutdown();
    throw error;
  }
}

try {
  await main();
} catch {
  process.stderr.write('PRODUCTION_WORKER_TERMINATED\n');
  process.exitCode = 1;
}
