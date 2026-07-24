import {
  resolveNodeTelemetryRuntime,
  type NodeTelemetryRuntime,
  type TelemetryEnvironment,
  type TelemetrySdkFactory,
} from '@aeostudio/adapters/observability/telemetry';

export async function startWorkerInstrumentation(input: {
  environment: TelemetryEnvironment;
  sdkFactory?: TelemetrySdkFactory;
}): Promise<NodeTelemetryRuntime> {
  const runtime = await resolveNodeTelemetryRuntime({
    serviceName: 'aeostudio-worker',
    environment: input.environment,
    ...(input.sdkFactory === undefined ? {} : { sdkFactory: input.sdkFactory }),
  });
  await runtime.start();
  return runtime;
}
