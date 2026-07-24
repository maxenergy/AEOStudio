import {
  startTenantDataBrokerRuntime,
  type TenantDataBrokerRuntime,
  type TenantDataBrokerRuntimeEnvironment,
} from './tenant-data-broker-runtime.js';

export type TenantDataBrokerShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface TenantDataBrokerSignalHost {
  once(signal: TenantDataBrokerShutdownSignal, listener: () => void): unknown;
  off(signal: TenantDataBrokerShutdownSignal, listener: () => void): unknown;
}

export async function runTenantDataBrokerProcess(input: {
  environment: TenantDataBrokerRuntimeEnvironment;
  signals?: TenantDataBrokerSignalHost;
  startRuntime?: typeof startTenantDataBrokerRuntime;
}): Promise<void> {
  const signals = input.signals ?? processSignalHost;
  const startRuntime = input.startRuntime ?? startTenantDataBrokerRuntime;
  let runtime: TenantDataBrokerRuntime | undefined;
  let resolveShutdown: (() => void) | undefined;
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const requestShutdown = () => resolveShutdown?.();
  let sigintRegistered = false;
  let sigtermRegistered = false;
  let processFailed = false;
  let processFailure: unknown;
  try {
    signals.once('SIGINT', requestShutdown);
    sigintRegistered = true;
    signals.once('SIGTERM', requestShutdown);
    sigtermRegistered = true;
    runtime = await startRuntime({ environment: input.environment });
    await shutdown;
  } catch (error: unknown) {
    processFailed = true;
    processFailure = error;
  }

  const cleanupErrors: unknown[] = [];
  if (sigintRegistered) captureCleanup(cleanupErrors, () => signals.off('SIGINT', requestShutdown));
  if (sigtermRegistered) {
    captureCleanup(cleanupErrors, () => signals.off('SIGTERM', requestShutdown));
  }
  if (runtime !== undefined) {
    try {
      await runtime.close();
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }
  if (processFailed) throw processFailure;
  if (cleanupErrors.length > 0) throw cleanupErrors[0];
}

const processSignalHost: TenantDataBrokerSignalHost = {
  once(signal, listener) {
    process.once(signal, listener);
  },
  off(signal, listener) {
    process.off(signal, listener);
  },
};

function captureCleanup(errors: unknown[], effect: () => unknown): void {
  try {
    effect();
  } catch (error: unknown) {
    errors.push(error);
  }
}
