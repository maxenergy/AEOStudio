import * as DomainRuntime from '@aeostudio/domain';
import { describe, expect, test } from 'vitest';

type MetricClassification =
  'PASS' | 'FAIL' | 'MISMATCH' | 'ERROR' | 'NOT_CHECKED' | 'INCONCLUSIVE' | 'NOT_APPLICABLE';

type AcquisitionClass =
  'CONSUMER_UI_SAMPLE' | 'MODEL_API_DIAGNOSTIC' | 'SEARCH_DATA_API' | 'MANUAL_IMPORT';

interface MetricCohort {
  scenarioId: string;
  scenarioVersion: number;
  providerKey: string;
  surfaceKey: string;
  acquisitionClass: AcquisitionClass;
  acquisitionMethod: string;
  adapterKey: string;
  adapterVersion: string;
  model: string;
  modelVersion: string;
  scope: {
    market: string;
    locale: string;
    region: string;
  };
  parameters: Record<string, unknown>;
}

interface MetricObservation {
  id: string;
  promptRunId: string;
  metricKey: string;
  classification: MetricClassification;
  cohort: MetricCohort;
}

interface MetricSnapshot {
  schemaVersion: 'metric-snapshot.v1';
  metricKey: string;
  methodVersion: string;
  cohort: MetricCohort;
  numerator: number;
  eligibleDenominator: number;
  value: number | null;
  excludedCounts: {
    ERROR: number;
    NOT_CHECKED: number;
    INCONCLUSIVE: number;
    NOT_APPLICABLE: number;
  };
  sourceObservationIds: string[];
  sourceHash: string;
  contentHash: string;
}

type BuildMetricSnapshot = (input: {
  metricKey: string;
  methodVersion: string;
  observations: readonly MetricObservation[];
}) => MetricSnapshot;

type MetricValueFromCounts = (numerator: number, eligibleDenominator: number) => number | null;

const measurementDomain = DomainRuntime as unknown as {
  buildMetricSnapshot?: BuildMetricSnapshot;
  metricValueFromCounts?: MetricValueFromCounts;
};
const reducerMissing = measurementDomain.buildMetricSnapshot === undefined;

const metricKey = 'answer-mention-rate';
const methodVersion = 'answer-mention-rate-v1';
const cohort: MetricCohort = {
  scenarioId: '00000000-0000-7000-8000-000000001501',
  scenarioVersion: 3,
  providerKey: 'fixture-provider',
  surfaceKey: 'consumer-answer-sandbox',
  acquisitionClass: 'CONSUMER_UI_SAMPLE',
  acquisitionMethod: 'MANUAL_IMPORT',
  adapterKey: 'fixture-consumer-sample',
  adapterVersion: '1.0.0',
  model: 'fixture-model',
  modelVersion: 'fixture-model-v1',
  scope: {
    market: 'SG',
    locale: 'en-SG',
    region: 'ap-southeast-1',
  },
  parameters: {
    freshSession: true,
    searchEnabled: true,
    repetitions: 3,
  },
};

const allClassifications: MetricClassification[] = [
  'PASS',
  'FAIL',
  'MISMATCH',
  'ERROR',
  'NOT_CHECKED',
  'INCONCLUSIVE',
  'NOT_APPLICABLE',
];

describe('Task 15 MetricSnapshot denominator properties', () => {
  test('exports the public deterministic measurement reducer/API', () => {
    expect(
      measurementDomain.buildMetricSnapshot,
      'expected eligible denominator reducer/API buildMetricSnapshot, received measurement API unavailable',
    ).toBeTypeOf('function');
  });

  test('derives the metric value from authoritative integer counts without persistence rounding', () => {
    expect(
      measurementDomain.metricValueFromCounts,
      'expected public metricValueFromCounts for persisted MetricSnapshot hydration',
    ).toBeTypeOf('function');
    const metricValueFromCounts = measurementDomain.metricValueFromCounts;
    if (metricValueFromCounts === undefined) return;

    expect(metricValueFromCounts(20, 30)).toBe(20 / 30);
    expect(metricValueFromCounts(0, 0)).toBeNull();
    expect(() => metricValueFromCounts(2, 1)).toThrowError(/MEASUREMENT_METRIC_COUNTS_INVALID/u);
  });

  test.skipIf(reducerMissing)(
    'counts PASS, FAIL and MISMATCH as eligible while only PASS enters the numerator',
    () => {
      const snapshot = build(observationsFor(allClassifications));

      expect(snapshot).toMatchObject({
        schemaVersion: 'metric-snapshot.v1',
        metricKey,
        methodVersion,
        cohort,
        numerator: 1,
        eligibleDenominator: 3,
        value: 1 / 3,
        excludedCounts: {
          ERROR: 1,
          NOT_CHECKED: 1,
          INCONCLUSIVE: 1,
          NOT_APPLICABLE: 1,
        },
      });
      expect(snapshot.sourceObservationIds).toEqual(
        observationsFor(allClassifications)
          .map((observation) => observation.id)
          .sort(),
      );
      expect(snapshot.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    },
  );

  test.skipIf(reducerMissing)(
    'excludes ERROR, NOT_CHECKED, INCONCLUSIVE and NOT_APPLICABLE and reports null when eligible is zero',
    () => {
      const snapshot = build(
        observationsFor(['ERROR', 'NOT_CHECKED', 'INCONCLUSIVE', 'NOT_APPLICABLE']),
      );

      expect(snapshot).toMatchObject({
        numerator: 0,
        eligibleDenominator: 0,
        value: null,
        excludedCounts: {
          ERROR: 1,
          NOT_CHECKED: 1,
          INCONCLUSIVE: 1,
          NOT_APPLICABLE: 1,
        },
      });
    },
  );

  test.skipIf(reducerMissing)(
    'is invariant to raw-observation input order, including source and snapshot hashes',
    () => {
      const observations = observationsFor(allClassifications);
      const expected = build(observations);

      for (const reordered of deterministicReorderings(observations)) {
        const actual = build(reordered);
        expect(actual).toEqual(expected);
        expect(actual.sourceHash).toBe(expected.sourceHash);
        expect(actual.contentHash).toBe(expected.contentHash);
      }
    },
  );

  test.skipIf(reducerMissing)(
    'recomputes an identical snapshot from persisted raw observations',
    () => {
      const rawObservations = observationsFor(allClassifications);
      const snapshot = build(rawObservations);
      const persistedRawRoundTrip = JSON.parse(
        JSON.stringify(rawObservations),
      ) as MetricObservation[];

      expect(build(persistedRawRoundTrip)).toEqual(snapshot);
    },
  );

  test.skipIf(reducerMissing)(
    'rejects a cohort when any scenario, provider, surface, acquisition, Adapter, model, scope or parameter field differs',
    () => {
      const mutations: Array<[string, (value: MetricCohort) => MetricCohort]> = [
        ['scenario ID', (value) => ({ ...value, scenarioId: differentId(2) })],
        ['scenario version', (value) => ({ ...value, scenarioVersion: value.scenarioVersion + 1 })],
        ['provider', (value) => ({ ...value, providerKey: 'different-provider' })],
        ['surface', (value) => ({ ...value, surfaceKey: 'different-surface' })],
        ['acquisition class', (value) => ({ ...value, acquisitionClass: 'MODEL_API_DIAGNOSTIC' })],
        ['acquisition method', (value) => ({ ...value, acquisitionMethod: 'OFFICIAL_API' })],
        ['Adapter key', (value) => ({ ...value, adapterKey: 'different-adapter' })],
        ['Adapter version', (value) => ({ ...value, adapterVersion: '2.0.0' })],
        ['model', (value) => ({ ...value, model: 'different-model' })],
        ['model version', (value) => ({ ...value, modelVersion: 'different-model-v2' })],
        ['scope', (value) => ({ ...value, scope: { ...value.scope, locale: 'zh-TW' } })],
        [
          'parameters',
          (value) => ({
            ...value,
            parameters: { ...value.parameters, searchEnabled: false },
          }),
        ],
      ];

      for (const [field, mutate] of mutations) {
        const observations = observationsFor(['PASS', 'FAIL']);
        observations[1] = {
          ...observations[1]!,
          cohort: mutate(observations[1]!.cohort),
        };

        expect(() => build(observations), `expected mixed ${field} cohort rejection`).toThrowError(
          /MEASUREMENT_COHORT_MISMATCH/u,
        );
      }
    },
  );

  test.skipIf(reducerMissing)(
    'never mixes an ordinary model API diagnostic into a consumer UI sample cohort',
    () => {
      const observations = observationsFor(['PASS', 'PASS']);
      observations[1] = {
        ...observations[1]!,
        cohort: {
          ...observations[1]!.cohort,
          acquisitionClass: 'MODEL_API_DIAGNOSTIC',
          acquisitionMethod: 'OFFICIAL_API',
          adapterKey: 'ordinary-model-api',
        },
      };

      expect(() => build(observations)).toThrowError(/MEASUREMENT_COHORT_MISMATCH/u);
    },
  );
});

function build(observations: readonly MetricObservation[]): MetricSnapshot {
  const reducer = measurementDomain.buildMetricSnapshot;
  if (reducer === undefined) throw new Error('MEASUREMENT_REDUCER_API_UNAVAILABLE');
  return reducer({ metricKey, methodVersion, observations });
}

function observationsFor(classifications: readonly MetricClassification[]): MetricObservation[] {
  return classifications.map((classification, index) => ({
    id: differentId(index + 10),
    promptRunId: differentId(index + 100),
    metricKey,
    classification,
    cohort: structuredClone(cohort),
  }));
}

function differentId(suffix: number): string {
  return `00000000-0000-7000-8000-${String(suffix).padStart(12, '0')}`;
}

function deterministicReorderings<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += 1) {
    const rotated = [...values.slice(offset), ...values.slice(0, offset)];
    result.push(rotated, [...rotated].reverse());
  }
  return result;
}
