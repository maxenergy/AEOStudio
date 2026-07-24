import type { JobTraceContext } from '@aeostudio/application/jobs-budgets';

export interface GenerationCapacityProbeEnvironment {
  AEO_ENVIRONMENT?: string;
  GENERATION_CAPACITY_PROBE_HOLD_MS?: string;
  GENERATION_CAPACITY_PROBE_REQUEST_ID_SUFFIX?: string;
}

export interface GenerationCapacityProbe {
  holdAfterClaim(input: { traceContext?: JobTraceContext }): Promise<void>;
}

export function resolveGenerationCapacityProbe(
  environment: GenerationCapacityProbeEnvironment,
  sleep: (milliseconds: number) => Promise<void> = defaultSleep,
): GenerationCapacityProbe | undefined {
  const requestIdSuffix = environment.GENERATION_CAPACITY_PROBE_REQUEST_ID_SUFFIX;
  const rawHoldMs = environment.GENERATION_CAPACITY_PROBE_HOLD_MS;
  if (requestIdSuffix === undefined && rawHoldMs === undefined) return undefined;
  if (environment.AEO_ENVIRONMENT !== 'staging') {
    throw new Error('GENERATION_CAPACITY_PROBE_STAGING_ONLY');
  }
  if (requestIdSuffix === undefined || !/^[0-9a-f]{4,12}$/u.test(requestIdSuffix)) {
    throw new Error('GENERATION_CAPACITY_PROBE_REQUEST_ID_SUFFIX_INVALID');
  }
  if (rawHoldMs === undefined || !/^[1-9][0-9]*$/u.test(rawHoldMs)) {
    throw new Error('GENERATION_CAPACITY_PROBE_HOLD_MS_INVALID');
  }
  const holdMs = Number(rawHoldMs);
  if (!Number.isSafeInteger(holdMs) || holdMs < 100 || holdMs > 15_000) {
    throw new Error('GENERATION_CAPACITY_PROBE_HOLD_MS_INVALID');
  }

  return {
    async holdAfterClaim(input): Promise<void> {
      if (input.traceContext?.requestId.endsWith(requestIdSuffix) === true) await sleep(holdMs);
    },
  };
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
