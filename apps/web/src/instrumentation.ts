import type {
  NodeTelemetryRuntime,
  TelemetryEnvironment,
  TelemetrySdkFactory,
} from '@aeostudio/adapters/observability/telemetry';

let runtimePromise: Promise<NodeTelemetryRuntime> | undefined;
let exitBarrierInstalled = false;

interface ProcessExitLifecycle {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  exit(code?: number): unknown;
}

/**
 * Leaves SIGINT/SIGTERM draining to Next, then delays Next's final process.exit until telemetry
 * is flushed. The signal deadline is only a fail-safe for a request that never drains.
 */
export function installTelemetryExitBarrier(
  runtime: Pick<NodeTelemetryRuntime, 'shutdown'>,
  lifecycle: ProcessExitLifecycle = process,
  timeoutMs = 10_000,
): void {
  const actualExit = lifecycle.exit.bind(lifecycle);
  let deadlineAt: number | undefined;
  let drainDeadline: ReturnType<typeof setTimeout> | undefined;
  let exitRequested = false;
  let hardExitStarted = false;

  const startDrainDeadline = () => {
    if (deadlineAt !== undefined) return;
    deadlineAt = Date.now() + timeoutMs;
    drainDeadline = setTimeout(() => {
      hardExitStarted = true;
      try {
        void runtime.shutdown().catch(() => undefined);
      } catch {
        // The fail-safe must still terminate when a telemetry implementation throws synchronously.
      }
      actualExit(1);
    }, timeoutMs);
  };
  lifecycle.once('SIGINT', startDrainDeadline);
  lifecycle.once('SIGTERM', startDrainDeadline);

  lifecycle.exit = (code = 0) => {
    if (exitRequested || hardExitStarted) return;
    exitRequested = true;
    if (drainDeadline !== undefined) clearTimeout(drainDeadline);
    const remainingMs = Math.max(0, (deadlineAt ?? Date.now() + timeoutMs) - Date.now());
    const telemetryDeadline = setTimeout(() => actualExit(1), remainingMs);
    void Promise.resolve()
      .then(() => runtime.shutdown())
      .then(
        () => {
          clearTimeout(telemetryDeadline);
          actualExit(code);
        },
        () => {
          clearTimeout(telemetryDeadline);
          actualExit(1);
        },
      );
  };
}

export async function startWebInstrumentation(input: {
  environment: TelemetryEnvironment;
  sdkFactory?: TelemetrySdkFactory;
}): Promise<NodeTelemetryRuntime> {
  const { resolveNodeTelemetryRuntime } =
    await import('@aeostudio/adapters/observability/telemetry');
  const runtime = await resolveNodeTelemetryRuntime({
    serviceName: 'aeostudio-web',
    environment: input.environment,
    ...(input.sdkFactory === undefined ? {} : { sdkFactory: input.sdkFactory }),
  });
  await runtime.start();
  return runtime;
}

/** Next.js invokes this hook before loading the Node server runtime. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') return;
  runtimePromise ??= startWebInstrumentation({ environment: process.env });
  const runtime = await runtimePromise;
  if (exitBarrierInstalled) return;
  exitBarrierInstalled = true;
  installTelemetryExitBarrier(runtime);
}
