import { createHash } from 'node:crypto';

import * as DomainRuntime from '@aeostudio/domain';
import * as ExperimentContracts from '@aeostudio/contracts/experiments';
import {
  CreateExperimentRequestSchema,
  ExperimentInterventionOptionSchema,
} from '@aeostudio/contracts/experiments';
import type { MetricCohort, MetricSnapshot } from '@aeostudio/domain';
import { describe, expect, test } from 'vitest';

interface MonetaryCost {
  amount: string;
  currency: string;
}

interface ComparisonSnapshotInput {
  snapshotId: string;
  snapshot: MetricSnapshot;
  costBreakdown: readonly MonetaryCost[];
}

interface ComparableResult {
  outcome: 'COMPARABLE';
  compatibilityKey: string;
  compatibilityHash: string;
  baseline: {
    snapshotId: string;
    contentHash: string;
    numerator: number;
    eligibleDenominator: number;
    value: number | null;
    sampleSize: number;
    excludedCounts: MetricSnapshot['excludedCounts'];
  };
  remeasurement: ComparableResult['baseline'];
  delta: {
    numerator: number;
    eligibleDenominator: number;
    value: number | null;
  };
  costBreakdown: {
    baseline: MonetaryCost[];
    remeasurement: MonetaryCost[];
  };
  observedAssociation: string;
  caveat: string;
  noGuarantee: string;
}

interface IncompatibleResult {
  outcome: 'INCOMPATIBLE_SCENARIO';
  baseline: {
    snapshotId: string;
    contentHash: string;
    compatibilityKey: string;
    compatibilityHash: string;
  };
  remeasurement: IncompatibleResult['baseline'];
  differingFields: string[];
  decision: 'REBASELINE' | 'STRATIFY';
  caveat: string;
}

type SnapshotComparator = (input: {
  baseline: ComparisonSnapshotInput;
  remeasurement: ComparisonSnapshotInput;
}) => ComparableResult | IncompatibleResult;

interface CompatibilityKeyResult {
  schemaVersion: 'metric-compatibility-key.v1';
  fields: {
    metricKey: string;
    methodVersion: string;
    scenarioId: string;
    scenarioVersion: number;
    providerKey: string;
    surfaceKey: string;
    acquisitionClass: string;
    acquisitionMethod: string;
    adapterKey: string;
    adapterVersion: string;
    model: string;
    modelVersion: string;
    scope: MetricCohort['scope'];
    parameters: Record<string, unknown>;
  };
  key: string;
  hash: string;
}

type CompatibilityKeyBuilder = (snapshot: MetricSnapshot) => CompatibilityKeyResult;

const experimentDomain = DomainRuntime as unknown as {
  compareMetricSnapshots?: SnapshotComparator;
  buildMetricCompatibilityKey?: CompatibilityKeyBuilder;
};

describe('Task 16 MetricSnapshot compatibility properties', () => {
  test('accepts exact published and approved intervention options without conflating application', () => {
    const published = ExperimentInterventionOptionSchema.safeParse({
      kind: 'PUBLISHED_PUBLICATION',
      publicationRecordId: id(201),
      publicationAttemptId: id(202),
      channelPackageId: id(203),
      artifactId: id(208),
      artifactReviewId: id(209),
      artifactRevisionId: id(204),
      artifactContentHash: 'a'.repeat(64),
      observedAt: '2026-07-22T08:00:00.000Z',
    });
    const approved = ExperimentInterventionOptionSchema.safeParse({
      kind: 'APPROVED_ARTIFACT',
      artifactId: id(205),
      artifactRevisionId: id(206),
      artifactContentHash: 'b'.repeat(64),
      artifactReviewId: id(207),
      observedAt: '2026-07-22T07:00:00.000Z',
    });

    expect(published.success).toBe(true);
    expect(approved.success, 'expected an exact APPROVED_ARTIFACT option').toBe(true);
    expect(
      CreateExperimentRequestSchema.safeParse({
        baselineRunId: id(220),
        remeasurementRunId: id(221),
        intervention: published.success ? published.data : null,
        idempotencyKey: 'exact-published-tuple',
      }).success,
    ).toBe(true);
    expect(
      CreateExperimentRequestSchema.safeParse({
        baselineRunId: id(220),
        remeasurementRunId: id(221),
        intervention: {
          kind: 'PUBLISHED_PUBLICATION',
          publicationRecordId: id(201),
          artifactRevisionId: id(204),
          artifactContentHash: 'a'.repeat(64),
        },
        idempotencyKey: 'incomplete-published-tuple',
      }).success,
      'a create request must bind the exact server-approved immutable intervention identity',
    ).toBe(false);
  });

  test('exposes an exact server-approved Experiment input combination contract', () => {
    const schema = (
      ExperimentContracts as typeof ExperimentContracts & {
        ExperimentCompatibleCombinationSchema?: {
          safeParse(value: unknown): { success: boolean };
        };
      }
    ).ExperimentCompatibleCombinationSchema;
    expect(schema, 'expected exact compatible combination schema').toBeDefined();
    expect(
      schema?.safeParse({
        baselineRunId: id(210),
        remeasurementRunId: id(211),
        intervention: {
          kind: 'PUBLISHED_PUBLICATION',
          publicationRecordId: id(212),
          publicationAttemptId: id(213),
          channelPackageId: id(214),
          artifactId: id(215),
          artifactReviewId: id(217),
          artifactRevisionId: id(216),
          artifactContentHash: 'e'.repeat(64),
          observedAt: '2026-07-22T08:00:00.000Z',
        },
      }).success,
    ).toBe(true);
  });

  test('exports the public snapshot compatibility comparator', () => {
    expect(
      experimentDomain.compareMetricSnapshots,
      'expected public compatibility comparator compareMetricSnapshots, received experiment API unavailable',
    ).toBeTypeOf('function');
  });

  test('returns a self-contained descriptive delta for compatible snapshots', () => {
    const baseline = metricSnapshot({ numerator: 1, eligibleDenominator: 4, excluded: 2 });
    const remeasurement = metricSnapshot({ numerator: 3, eligibleDenominator: 5, excluded: 1 });

    const result = compare({
      baseline: {
        snapshotId: id(1),
        snapshot: baseline,
        costBreakdown: [{ amount: '1.250000', currency: 'USD' }],
      },
      remeasurement: {
        snapshotId: id(2),
        snapshot: remeasurement,
        costBreakdown: [{ amount: '2.500000', currency: 'USD' }],
      },
    });

    expect(result.outcome).toBe('COMPARABLE');
    if (result.outcome !== 'COMPARABLE') return;

    expect(result.compatibilityKey).toContain('"scenarioVersion":3');
    expect(result.compatibilityHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.baseline).toEqual({
      snapshotId: id(1),
      contentHash: baseline.contentHash,
      numerator: 1,
      eligibleDenominator: 4,
      value: 0.25,
      sampleSize: 6,
      excludedCounts: {
        ERROR: 2,
        NOT_CHECKED: 0,
        INCONCLUSIVE: 0,
        NOT_APPLICABLE: 0,
      },
    });
    expect(result.remeasurement).toMatchObject({
      snapshotId: id(2),
      contentHash: remeasurement.contentHash,
      numerator: 3,
      eligibleDenominator: 5,
      value: 0.6,
      sampleSize: 6,
    });
    expect(result.delta).toEqual({
      numerator: 2,
      eligibleDenominator: 1,
      value: 0.35,
    });
    expect(result.costBreakdown).toEqual({
      baseline: [{ amount: '1.250000', currency: 'USD' }],
      remeasurement: [{ amount: '2.500000', currency: 'USD' }],
    });
    expect(result.observedAssociation).toMatch(/observed association/iu);
    expect(result.caveat).toMatch(/descriptive/iu);
    expect(result.noGuarantee).toMatch(/does not guarantee/iu);
  });

  test('projects snapshot rates and descriptive deltas with database decimal-12 semantics', () => {
    const thirds = compare({
      baseline: snapshotInput(
        id(230),
        metricSnapshot({ numerator: 1, eligibleDenominator: 3, excluded: 0 }),
      ),
      remeasurement: snapshotInput(
        id(231),
        metricSnapshot({ numerator: 1, eligibleDenominator: 6, excluded: 0 }),
      ),
    });
    expect(thirds.outcome).toBe('COMPARABLE');
    if (thirds.outcome !== 'COMPARABLE') return;
    expect(thirds.baseline.value).toBe(0.333333333333);
    expect(thirds.remeasurement.value).toBe(0.166666666667);
    expect(thirds.delta.value).toBe(-0.166666666666);

    const decimalTenths = compare({
      baseline: snapshotInput(
        id(232),
        metricSnapshot({ numerator: 1, eligibleDenominator: 5, excluded: 0 }),
      ),
      remeasurement: snapshotInput(
        id(233),
        metricSnapshot({ numerator: 7, eligibleDenominator: 10, excluded: 0 }),
      ),
    });
    expect(decimalTenths.outcome).toBe('COMPARABLE');
    if (decimalTenths.outcome !== 'COMPARABLE') return;
    expect(decimalTenths.baseline.value).toBe(0.2);
    expect(decimalTenths.remeasurement.value).toBe(0.7);
    expect(decimalTenths.delta.value).toBe(0.5);

    const halfUpTies: Array<{
      numerator: number;
      denominator: number;
      expected: number;
    }> = [
      { numerator: 246_913_578_025, denominator: 2_000_000_000_000, expected: 0.123456789013 },
      { numerator: 1, denominator: 2_000_000_000_000, expected: 0.000000000001 },
      { numerator: 1_999_999_999_999, denominator: 2_000_000_000_000, expected: 1 },
    ];
    for (const [index, tie] of halfUpTies.entries()) {
      const tied = compare({
        baseline: snapshotInput(
          id(240 + index * 2),
          metricSnapshot({ numerator: 0, eligibleDenominator: tie.denominator, excluded: 0 }),
        ),
        remeasurement: snapshotInput(
          id(241 + index * 2),
          metricSnapshot({
            numerator: tie.numerator,
            eligibleDenominator: tie.denominator,
            excluded: 0,
          }),
        ),
      });
      expect(tied.outcome).toBe('COMPARABLE');
      if (tied.outcome !== 'COMPARABLE') continue;
      expect(tied.remeasurement.value).toBe(tie.expected);
      expect(tied.delta.value).toBe(tie.expected);
    }
  });

  test('rejects direct delta for every compatibility field change with an explicit decision', () => {
    const mutations: Array<{
      field: string;
      decision: IncompatibleResult['decision'];
      mutate: (snapshot: MetricSnapshot) => void;
    }> = [
      {
        field: 'metricKey',
        decision: 'REBASELINE',
        mutate: (snapshot) => {
          snapshot.metricKey = 'citation-rate';
        },
      },
      {
        field: 'methodVersion',
        decision: 'REBASELINE',
        mutate: (snapshot) => {
          snapshot.methodVersion = 'answer-mention-rate-v2';
        },
      },
      {
        field: 'scenarioId',
        decision: 'REBASELINE',
        mutate: (snapshot) => {
          snapshot.cohort.scenarioId = id(17);
        },
      },
      {
        field: 'scenarioVersion',
        decision: 'REBASELINE',
        mutate: (snapshot) => {
          snapshot.cohort.scenarioVersion += 1;
        },
      },
      {
        field: 'providerKey',
        decision: 'STRATIFY',
        mutate: (snapshot) => {
          snapshot.cohort.providerKey = 'other-provider';
        },
      },
      {
        field: 'surfaceKey',
        decision: 'STRATIFY',
        mutate: (snapshot) => {
          snapshot.cohort.surfaceKey = 'other-surface';
        },
      },
      {
        field: 'acquisitionClass',
        decision: 'REBASELINE',
        mutate: (snapshot) => {
          snapshot.cohort.acquisitionClass = 'MANUAL_IMPORT';
        },
      },
      {
        field: 'acquisitionMethod',
        decision: 'REBASELINE',
        mutate: (snapshot) => {
          snapshot.cohort.acquisitionMethod = 'REVIEWED_MANUAL_IMPORT';
        },
      },
      {
        field: 'adapterKey',
        decision: 'REBASELINE',
        mutate: (snapshot) => {
          snapshot.cohort.adapterKey = 'other-adapter';
        },
      },
      {
        field: 'adapterVersion',
        decision: 'REBASELINE',
        mutate: (snapshot) => {
          snapshot.cohort.adapterVersion = '2.0.0';
        },
      },
      {
        field: 'model',
        decision: 'STRATIFY',
        mutate: (snapshot) => {
          snapshot.cohort.model = 'other-model';
        },
      },
      {
        field: 'modelVersion',
        decision: 'STRATIFY',
        mutate: (snapshot) => {
          snapshot.cohort.modelVersion = '2026-07-22';
        },
      },
      {
        field: 'scope',
        decision: 'STRATIFY',
        mutate: (snapshot) => {
          snapshot.cohort.scope = { ...snapshot.cohort.scope, locale: 'zh-TW' };
        },
      },
      {
        field: 'parameters',
        decision: 'REBASELINE',
        mutate: (snapshot) => {
          snapshot.cohort.parameters = {
            ...snapshot.cohort.parameters,
            searchEnabled: false,
          };
        },
      },
    ];

    for (const mutation of mutations) {
      const baseline = metricSnapshot({ numerator: 1, eligibleDenominator: 3, excluded: 1 });
      const remeasurement = structuredClone(baseline);
      remeasurement.contentHash = 'c'.repeat(64);
      mutation.mutate(remeasurement);

      const result = compare({
        baseline: snapshotInput(id(1), baseline),
        remeasurement: snapshotInput(id(2), remeasurement),
      });

      expect(result.outcome, `expected INCOMPATIBLE_SCENARIO rejection for ${mutation.field}`).toBe(
        'INCOMPATIBLE_SCENARIO',
      );
      if (result.outcome !== 'INCOMPATIBLE_SCENARIO') continue;
      expect(
        result,
        `expected INCOMPATIBLE_SCENARIO rejection with exact ${mutation.field} decision`,
      ).toMatchObject({
        baseline: {
          snapshotId: id(1),
          contentHash: baseline.contentHash,
        },
        remeasurement: {
          snapshotId: id(2),
          contentHash: remeasurement.contentHash,
        },
        differingFields: [mutation.field],
        decision: mutation.decision,
      });
    }
  });

  test('reports an exact, stable per-currency cost breakdown without mutating inputs', () => {
    const baselineSnapshot = metricSnapshot({
      numerator: 1,
      eligibleDenominator: 2,
      excluded: 0,
    });
    const remeasurementSnapshot = metricSnapshot({
      numerator: 2,
      eligibleDenominator: 2,
      excluded: 0,
    });
    const input: Parameters<SnapshotComparator>[0] = {
      baseline: {
        snapshotId: id(1),
        snapshot: baselineSnapshot,
        costBreakdown: [
          { amount: '0.100000', currency: 'USD' },
          { amount: '2.000000', currency: 'EUR' },
          { amount: '0.200000', currency: 'USD' },
        ],
      },
      remeasurement: {
        snapshotId: id(2),
        snapshot: remeasurementSnapshot,
        costBreakdown: [
          { amount: '0.750000', currency: 'USD' },
          { amount: '1.250000', currency: 'EUR' },
        ],
      },
    };
    const original = structuredClone(input);

    const result = compare(input);

    expect(result.outcome).toBe('COMPARABLE');
    if (result.outcome !== 'COMPARABLE') return;
    expect(result.costBreakdown).toEqual({
      baseline: [
        { amount: '2.000000', currency: 'EUR' },
        { amount: '0.300000', currency: 'USD' },
      ],
      remeasurement: [
        { amount: '1.250000', currency: 'EUR' },
        { amount: '0.750000', currency: 'USD' },
      ],
    });
    expect(input).toEqual(original);
  });

  test('builds an immutable deterministic key from every exact compatibility field', () => {
    expect(experimentDomain.buildMetricCompatibilityKey).toBeTypeOf('function');
    const buildKey = experimentDomain.buildMetricCompatibilityKey;
    if (buildKey === undefined) return;

    const first = metricSnapshot({ numerator: 1, eligibleDenominator: 2, excluded: 0 });
    const reordered = structuredClone(first);
    reordered.cohort.scope = {
      region: first.cohort.scope.region,
      locale: first.cohort.scope.locale,
      market: first.cohort.scope.market,
    };
    reordered.cohort.parameters = {
      searchEnabled: true,
      repetitions: 3,
      freshSession: true,
    };
    const firstBefore = structuredClone(first);
    const expected = buildKey(first);
    const actual = buildKey(reordered);

    expect(actual).toEqual(expected);
    expect(expected).toMatchObject({
      schemaVersion: 'metric-compatibility-key.v1',
      fields: {
        metricKey: first.metricKey,
        methodVersion: first.methodVersion,
        scenarioId: first.cohort.scenarioId,
        scenarioVersion: first.cohort.scenarioVersion,
        providerKey: first.cohort.providerKey,
        surfaceKey: first.cohort.surfaceKey,
        acquisitionClass: first.cohort.acquisitionClass,
        acquisitionMethod: first.cohort.acquisitionMethod,
        adapterKey: first.cohort.adapterKey,
        adapterVersion: first.cohort.adapterVersion,
        model: first.cohort.model,
        modelVersion: first.cohort.modelVersion,
        scope: first.cohort.scope,
        parameters: first.cohort.parameters,
      },
    });
    expect(expected.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(expected.hash).toBe(createHash('sha256').update(expected.key, 'utf8').digest('hex'));
    expect(Object.isFrozen(expected)).toBe(true);
    expect(Object.isFrozen(expected.fields)).toBe(true);
    expect(Object.isFrozen(expected.fields.scope)).toBe(true);
    expect(Object.isFrozen(expected.fields.parameters)).toBe(true);
    expect(first).toEqual(firstBefore);

    const changed = structuredClone(first);
    changed.cohort.parameters = { ...changed.cohort.parameters, repetitions: 4 };
    expect(buildKey(changed).key).not.toBe(expected.key);
    expect(buildKey(changed).hash).not.toBe(expected.hash);
  });

  test('canonicalizes nested parameters, UTF-16 keys and finite number spellings', () => {
    const buildKey = experimentDomain.buildMetricCompatibilityKey;
    expect(buildKey).toBeTypeOf('function');
    if (buildKey === undefined) return;

    const snapshot = metricSnapshot({ numerator: 1, eligibleDenominator: 2, excluded: 0 });
    const astralKey = '\u{10000}';
    const privateUseBmpKey = '\uE000';
    snapshot.cohort.parameters = {
      nested: {
        [privateUseBmpKey]: 'bmp',
        values: [1, 1.0, 1.25, 1e-7, { enabled: true }],
        [astralKey]: 'astral',
      },
    };

    const compatibility = buildKey(snapshot);

    expect(compatibility.key).toContain('"values":[1,1,1.25,0.0000001,{"enabled":true}]');
    expect(compatibility.key.indexOf(`"${astralKey}"`)).toBeLessThan(
      compatibility.key.indexOf(`"${privateUseBmpKey}"`),
    );
    expect(compatibility.hash).toBe(
      createHash('sha256').update(compatibility.key, 'utf8').digest('hex'),
    );
  });

  test('keeps excluded cohorts separate, returns null delta for undefined rates and seals output', () => {
    const baseline = metricSnapshot({ numerator: 0, eligibleDenominator: 0, excluded: 4 });
    baseline.excludedCounts = {
      ERROR: 1,
      NOT_CHECKED: 1,
      INCONCLUSIVE: 1,
      NOT_APPLICABLE: 1,
    };
    const remeasurement = metricSnapshot({
      numerator: 2,
      eligibleDenominator: 3,
      excluded: 0,
    });

    const result = compare({
      baseline: snapshotInput(id(1), baseline),
      remeasurement: snapshotInput(id(2), remeasurement),
    });

    expect(result.outcome).toBe('COMPARABLE');
    if (result.outcome !== 'COMPARABLE') return;
    expect(result.baseline).toMatchObject({
      eligibleDenominator: 0,
      value: null,
      sampleSize: 4,
      excludedCounts: {
        ERROR: 1,
        NOT_CHECKED: 1,
        INCONCLUSIVE: 1,
        NOT_APPLICABLE: 1,
      },
    });
    expect(result.delta.value).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.baseline)).toBe(true);
    expect(Object.isFrozen(result.baseline.excludedCounts)).toBe(true);
    expect(Object.isFrozen(result.costBreakdown.baseline)).toBe(true);
  });

  test('uses stable code-unit ordering and only descriptive, non-causal language', () => {
    const baseline = metricSnapshot({ numerator: 1, eligibleDenominator: 3, excluded: 0 });
    const remeasurement = structuredClone(baseline);
    remeasurement.cohort.surfaceKey = 'other-surface';
    remeasurement.cohort.scenarioVersion = 4;
    remeasurement.cohort.model = 'other-model';

    const rejected = compare({
      baseline: snapshotInput(id(1), baseline),
      remeasurement: snapshotInput(id(2), remeasurement),
    });

    expect(rejected.outcome).toBe('INCOMPATIBLE_SCENARIO');
    if (rejected.outcome !== 'INCOMPATIBLE_SCENARIO') return;
    expect(rejected.differingFields).toEqual(['model', 'scenarioVersion', 'surfaceKey']);
    expect(rejected.decision).toBe('REBASELINE');

    const comparable = compare({
      baseline: snapshotInput(id(1), baseline),
      remeasurement: snapshotInput(
        id(2),
        metricSnapshot({ numerator: 2, eligibleDenominator: 3, excluded: 0 }),
      ),
    });
    expect(comparable.outcome).toBe('COMPARABLE');
    if (comparable.outcome !== 'COMPARABLE') return;
    const disclosure = [
      comparable.observedAssociation,
      comparable.caveat,
      comparable.noGuarantee,
    ].join(' ');
    expect(disclosure).toMatch(/observed association/iu);
    expect(disclosure).toMatch(/sample/iu);
    expect(disclosure).toMatch(/uncertainty/iu);
    expect(disclosure).not.toMatch(/\bcaused?\b|\bresulted in\b|\battribut(?:e|ed|ion)\b/iu);
    expect(disclosure).not.toMatch(/\bwill (?:rank|cite|recommend)\b|\bguaranteed\b/iu);
  });
});

function compare(input: Parameters<SnapshotComparator>[0]): ReturnType<SnapshotComparator> {
  const comparator = experimentDomain.compareMetricSnapshots;
  if (comparator === undefined) throw new Error('EXPERIMENT_COMPARATOR_API_UNAVAILABLE');
  return comparator(input);
}

const cohort: MetricCohort = {
  scenarioId: id(16),
  scenarioVersion: 3,
  providerKey: 'fixture-provider',
  surfaceKey: 'answer-surface',
  acquisitionClass: 'MODEL_API_DIAGNOSTIC',
  acquisitionMethod: 'OFFICIAL_API',
  adapterKey: 'fixture-adapter',
  adapterVersion: '1.2.3',
  model: 'fixture-model',
  modelVersion: '2026-07-01',
  scope: {
    market: 'SG',
    locale: 'en-SG',
    region: 'ap-southeast-1',
  },
  parameters: {
    freshSession: true,
    repetitions: 3,
    searchEnabled: true,
  },
};

function metricSnapshot(input: {
  numerator: number;
  eligibleDenominator: number;
  excluded: number;
}): MetricSnapshot {
  const excludedCounts = {
    ERROR: input.excluded,
    NOT_CHECKED: 0,
    INCONCLUSIVE: 0,
    NOT_APPLICABLE: 0,
  };
  const seed = `${input.numerator}-${input.eligibleDenominator}-${input.excluded}`;
  return {
    schemaVersion: 'metric-snapshot.v1',
    metricKey: 'answer-mention-rate',
    methodVersion: 'answer-mention-rate-v1',
    cohort: structuredClone(cohort),
    numerator: input.numerator,
    eligibleDenominator: input.eligibleDenominator,
    value: input.eligibleDenominator === 0 ? null : input.numerator / input.eligibleDenominator,
    excludedCounts,
    sourceObservationIds: [id(input.numerator + 100)],
    sourceHash: seed.padEnd(64, 'a').slice(0, 64),
    contentHash: seed.padEnd(64, 'b').slice(0, 64),
  };
}

function snapshotInput(snapshotId: string, snapshot: MetricSnapshot): ComparisonSnapshotInput {
  return {
    snapshotId,
    snapshot,
    costBreakdown: [{ amount: '1.000000', currency: 'USD' }],
  };
}

function id(suffix: number): string {
  return `00000000-0000-7000-8000-${String(suffix).padStart(12, '0')}`;
}
