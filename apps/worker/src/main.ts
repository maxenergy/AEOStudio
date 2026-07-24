import { runMeasurementWorkerProcess } from './measurement-worker-process.js';
import { resolveProductionMeasurementWorkerRuntime } from './production-measurement-worker-runtime.js';

async function main(): Promise<void> {
  const runtime = resolveProductionMeasurementWorkerRuntime({ environment: process.env });
  await runMeasurementWorkerProcess({
    runtime,
    signals: {
      once(signal, listener) {
        process.once(signal, listener);
      },
      off(signal, listener) {
        process.off(signal, listener);
      },
    },
  });
}

try {
  await main();
} catch {
  process.stderr.write('MEASUREMENT_WORKER_TERMINATED\n');
  process.exitCode = 1;
}
