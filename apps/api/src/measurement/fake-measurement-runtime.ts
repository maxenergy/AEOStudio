import {
  MeasurementExecutionHandler,
  type MeasurementRawEvidenceStore,
  type MeasurementStore,
  type MeasurementSurfaceAdapter,
  type MeasurementSurfaceAdapterRegistry,
  type MeasurementSurfaceExecutionResult,
} from '@aeostudio/application/measurement';
import type { JobRecord } from '@aeostudio/domain/jobs-budgets';

export const FAKE_MEASUREMENT_PROVIDER_KEY = 'fixture-provider';
export const FAKE_MEASUREMENT_SURFACE_KEY = 'consumer-answer-sandbox';
export const FAKE_MEASUREMENT_ADAPTER_KEY = 'recorded-measurement-fixture';
export const FAKE_MEASUREMENT_ADAPTER_VERSION = 'fixture-v1';
export const FAKE_MEASUREMENT_OBSERVATION_METHOD = 'answer-observation-v1';
export const FAKE_MEASUREMENT_SNAPSHOT_METHOD = 'ai-visibility-snapshot-v1';

interface InMemoryMeasurementJobCompletion {
  status: 'SUCCEEDED' | 'FAILED_TERMINAL';
  result: Record<string, unknown> | null;
  errorCode: string | null;
}

export function createFakeMeasurementSurfaceAdapters(input: {
  clock: { now(): Date };
}): MeasurementSurfaceAdapterRegistry {
  const adapter = new RecordedMeasurementFixtureAdapter(input.clock);
  return {
    resolve(providerKey, surfaceKey, adapterVersion) {
      return providerKey === FAKE_MEASUREMENT_PROVIDER_KEY &&
        surfaceKey === FAKE_MEASUREMENT_SURFACE_KEY &&
        adapterVersion === FAKE_MEASUREMENT_ADAPTER_VERSION
        ? adapter
        : null;
    },
  };
}

export function createFakeMeasurementProcessor(input: {
  store: MeasurementStore;
  rawEvidence: MeasurementRawEvidenceStore;
  adapters: MeasurementSurfaceAdapterRegistry;
  ids: { next(): string };
  clock: { now(): Date };
}): (job: JobRecord) => Promise<InMemoryMeasurementJobCompletion> {
  const handler = new MeasurementExecutionHandler(
    input.store,
    input.rawEvidence,
    input.adapters,
    input.ids,
    input.clock,
    {
      observationMethodVersion: FAKE_MEASUREMENT_OBSERVATION_METHOD,
      snapshotMethodVersion: FAKE_MEASUREMENT_SNAPSHOT_METHOD,
    },
  );
  return async (job) => {
    if (job.jobType !== 'MEASUREMENT') return failed('MEASUREMENT_JOB_TYPE_INVALID');
    const completed = await handler.run(job);
    if (completed.outcome !== 'SUCCEEDED') return failed('MEASUREMENT_INVALID_REFERENCE');
    return {
      status: 'SUCCEEDED',
      result: {
        measurementRunId: completed.measurementRunId,
        measurementRunStatus: 'COMPLETED',
        snapshotCount: completed.snapshotCount,
      },
      errorCode: null,
    };
  };
}

class RecordedMeasurementFixtureAdapter implements MeasurementSurfaceAdapter {
  readonly adapterKey = FAKE_MEASUREMENT_ADAPTER_KEY;
  readonly adapterVersion = FAKE_MEASUREMENT_ADAPTER_VERSION;

  constructor(private readonly clock: { now(): Date }) {}

  describe() {
    return {
      adapterKey: this.adapterKey,
      adapterVersion: this.adapterVersion,
      providerKey: FAKE_MEASUREMENT_PROVIDER_KEY,
      surfaceKey: FAKE_MEASUREMENT_SURFACE_KEY,
      surfaceKind: 'CONSUMER_AI_ANSWER' as const,
      acquisitionClass: 'MANUAL_IMPORT' as const,
      acquisitionMethod: 'MANUAL_IMPORT',
      termsVersion: 'fixture-terms-2026-07',
      processingRegion: 'in-process-test-runtime',
      storageRegion: 'process-memory-test-runtime',
      retentionPolicy: 'Recorded fixture payloads exist only for the process lifetime.',
      trainingPolicy: 'No training.',
      subprocessors: [],
      requiresAuthorization: true,
    };
  }

  executeScenario(command: Parameters<MeasurementSurfaceAdapter['executeScenario']>[0]) {
    const slot = ((command.prompt.ordinal - 1) * 3 + command.repetition - 1) % 6;
    return Promise.resolve(fixtureResult(slot, this.clock.now()));
  }
}

function fixtureResult(slot: number, observedAt: Date): MeasurementSurfaceExecutionResult {
  const common = {
    providerKey: FAKE_MEASUREMENT_PROVIDER_KEY,
    surfaceKey: FAKE_MEASUREMENT_SURFACE_KEY,
    acquisitionMethod: 'MANUAL_IMPORT',
    adapterVersion: FAKE_MEASUREMENT_ADAPTER_VERSION,
    methodVersion: FAKE_MEASUREMENT_OBSERVATION_METHOD,
    observedAt: observedAt.toISOString(),
    cost: { amount: '0.001000', currency: 'USD' },
  } as const;
  switch (slot) {
    case 0:
      return {
        ...common,
        status: 'PASS',
        observation: { mention: true, citation: true, accuracy: 'MATCH', coverage: true },
        rawEvidence: {
          responseText: 'The recorded fixture answer mentions the measured offering.',
          citations: [
            {
              url: 'https://sources.example.test/measurement-evidence',
              title: 'Recorded measurement evidence fixture',
              snippet: 'Recorded citation used only for deterministic verification.',
            },
          ],
          error: null,
        },
      };
    case 1:
      return {
        ...common,
        status: 'FAIL',
        observation: {
          mention: false,
          citation: false,
          accuracy: 'NOT_APPLICABLE',
          coverage: false,
        },
        rawEvidence: {
          responseText: 'The recorded fixture answer does not mention the measured offering.',
          citations: [],
          error: null,
        },
      };
    case 2:
      return {
        ...common,
        status: 'FAIL',
        observation: { mention: true, citation: true, accuracy: 'MISMATCH', coverage: true },
        rawEvidence: {
          responseText: 'The recorded fixture answer contains a deliberate evidence mismatch.',
          citations: [
            {
              url: 'https://sources.example.test/measurement-mismatch',
              title: 'Recorded mismatch fixture',
              snippet: 'The recorded citation does not support the observed answer.',
            },
          ],
          error: null,
        },
      };
    case 3:
      return {
        ...common,
        status: 'ERROR',
        observation: { mention: null, citation: null, accuracy: null, coverage: null },
        rawEvidence: {
          responseText: null,
          citations: [],
          error: {
            code: 'FIXTURE_PROVIDER_TIMEOUT',
            message: 'Recorded fixture timeout; no external network was called.',
          },
        },
      };
    case 4:
      return {
        ...common,
        status: 'NOT_CHECKED',
        observation: { mention: null, citation: null, accuracy: null, coverage: null },
        rawEvidence: {
          responseText: null,
          citations: [],
          error: {
            code: 'FIXTURE_NOT_AVAILABLE',
            message: 'Recorded Surface sample is unavailable.',
          },
        },
      };
    default:
      return {
        ...common,
        status: 'INCONCLUSIVE',
        observation: { mention: null, citation: null, accuracy: null, coverage: null },
        rawEvidence: {
          responseText: 'The recorded fixture answer cannot be classified conclusively.',
          citations: [],
          error: null,
        },
      };
  }
}

function failed(errorCode: string): InMemoryMeasurementJobCompletion {
  return { status: 'FAILED_TERMINAL', result: null, errorCode };
}
