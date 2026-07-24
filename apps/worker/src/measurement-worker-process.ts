export type MeasurementWorkerShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface MeasurementWorkerSignalHost {
  once(signal: MeasurementWorkerShutdownSignal, listener: () => void): unknown;
  off(signal: MeasurementWorkerShutdownSignal, listener: () => void): unknown;
}

export interface MeasurementWorkerProcessRuntime {
  run(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export async function runMeasurementWorkerProcess(input: {
  runtime: MeasurementWorkerProcessRuntime;
  signals: MeasurementWorkerSignalHost;
}): Promise<void> {
  const shutdown = new AbortController();
  const requestShutdown = () => shutdown.abort();

  input.signals.once('SIGINT', requestShutdown);
  input.signals.once('SIGTERM', requestShutdown);
  try {
    await input.runtime.run(shutdown.signal);
  } finally {
    input.signals.off('SIGINT', requestShutdown);
    input.signals.off('SIGTERM', requestShutdown);
    await input.runtime.close();
  }
}
