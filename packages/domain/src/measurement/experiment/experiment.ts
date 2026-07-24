import type { MetricCohort, MetricExcludedCounts, MetricSnapshot } from '../measurement.js';

export interface ExperimentMonetaryCost {
  amount: string;
  currency: string;
}

export interface ExperimentSnapshotInput {
  snapshotId: string;
  snapshot: MetricSnapshot;
  costBreakdown: readonly ExperimentMonetaryCost[];
}

export interface CompareMetricSnapshotsInput {
  baseline: ExperimentSnapshotInput;
  remeasurement: ExperimentSnapshotInput;
}

export interface MetricCompatibilityFields {
  metricKey: string;
  methodVersion: string;
  scenarioId: string;
  scenarioVersion: number;
  providerKey: string;
  surfaceKey: string;
  acquisitionClass: MetricCohort['acquisitionClass'];
  acquisitionMethod: string;
  adapterKey: string;
  adapterVersion: string;
  model: string;
  modelVersion: string;
  scope: MetricCohort['scope'];
  parameters: Record<string, unknown>;
}

export interface MetricCompatibilityKey {
  schemaVersion: 'metric-compatibility-key.v1';
  fields: MetricCompatibilityFields;
  key: string;
  hash: string;
}

export interface ExperimentSnapshotSummary {
  snapshotId: string;
  contentHash: string;
  numerator: number;
  eligibleDenominator: number;
  value: number | null;
  sampleSize: number;
  excludedCounts: MetricExcludedCounts;
}

export interface ComparableMetricSnapshots {
  outcome: 'COMPARABLE';
  compatibilityKey: string;
  compatibilityHash: string;
  baseline: ExperimentSnapshotSummary;
  remeasurement: ExperimentSnapshotSummary;
  delta: {
    numerator: number;
    eligibleDenominator: number;
    value: number | null;
  };
  costBreakdown: {
    baseline: ExperimentMonetaryCost[];
    remeasurement: ExperimentMonetaryCost[];
  };
  observedAssociation: string;
  caveat: string;
  noGuarantee: string;
}

export interface IncompatibleMetricSnapshots {
  outcome: 'INCOMPATIBLE_SCENARIO';
  baseline: ExperimentCompatibilityIdentity;
  remeasurement: ExperimentCompatibilityIdentity;
  differingFields: MetricCompatibilityField[];
  decision: 'REBASELINE' | 'STRATIFY';
  caveat: string;
}

export interface ExperimentCompatibilityIdentity {
  snapshotId: string;
  contentHash: string;
  compatibilityKey: string;
  compatibilityHash: string;
}

export type MetricCompatibilityField = keyof MetricCompatibilityFields;

export type MetricSnapshotComparison = ComparableMetricSnapshots | IncompatibleMetricSnapshots;

export function buildMetricCompatibilityKey(snapshot: MetricSnapshot): MetricCompatibilityKey {
  const fields: MetricCompatibilityFields = {
    metricKey: snapshot.metricKey,
    methodVersion: snapshot.methodVersion,
    scenarioId: snapshot.cohort.scenarioId,
    scenarioVersion: snapshot.cohort.scenarioVersion,
    providerKey: snapshot.cohort.providerKey,
    surfaceKey: snapshot.cohort.surfaceKey,
    acquisitionClass: snapshot.cohort.acquisitionClass,
    acquisitionMethod: snapshot.cohort.acquisitionMethod,
    adapterKey: snapshot.cohort.adapterKey,
    adapterVersion: snapshot.cohort.adapterVersion,
    model: snapshot.cohort.model,
    modelVersion: snapshot.cohort.modelVersion,
    scope: canonicalClone(snapshot.cohort.scope),
    parameters: canonicalClone(snapshot.cohort.parameters),
  };
  const key = canonicalJson(fields);
  const hash = sha256(key);

  return deepFreeze({
    schemaVersion: 'metric-compatibility-key.v1',
    fields,
    key,
    hash,
  });
}

export function compareMetricSnapshots(
  input: CompareMetricSnapshotsInput,
): MetricSnapshotComparison {
  const baselineCompatibility = buildMetricCompatibilityKey(input.baseline.snapshot);
  const remeasurementCompatibility = buildMetricCompatibilityKey(input.remeasurement.snapshot);
  if (baselineCompatibility.key !== remeasurementCompatibility.key) {
    const differingFields = findDifferingFields(
      baselineCompatibility.fields,
      remeasurementCompatibility.fields,
    );
    return deepFreeze({
      outcome: 'INCOMPATIBLE_SCENARIO',
      baseline: compatibilityIdentity(input.baseline, baselineCompatibility),
      remeasurement: compatibilityIdentity(input.remeasurement, remeasurementCompatibility),
      differingFields,
      decision: differingFields.every((field) => STRATIFIABLE_FIELDS.has(field))
        ? 'STRATIFY'
        : 'REBASELINE',
      caveat:
        'Direct delta is unavailable because the snapshots belong to incompatible measurement cohorts.',
    });
  }

  const baseline = summarizeSnapshot(input.baseline);
  const remeasurement = summarizeSnapshot(input.remeasurement);
  return deepFreeze({
    outcome: 'COMPARABLE',
    compatibilityKey: baselineCompatibility.key,
    compatibilityHash: baselineCompatibility.hash,
    baseline,
    remeasurement,
    delta: {
      numerator: remeasurement.numerator - baseline.numerator,
      eligibleDenominator: remeasurement.eligibleDenominator - baseline.eligibleDenominator,
      value:
        input.baseline.snapshot.value === null || input.remeasurement.snapshot.value === null
          ? null
          : experimentRateFromUnits(
              experimentRateUnits(input.remeasurement.snapshot.value) -
                experimentRateUnits(input.baseline.snapshot.value),
            ),
    },
    costBreakdown: {
      baseline: normalizeCostBreakdown(input.baseline.costBreakdown),
      remeasurement: normalizeCostBreakdown(input.remeasurement.costBreakdown),
    },
    observedAssociation:
      'This descriptive result reports an observed association between the recorded intervention window and remeasurement.',
    caveat:
      'This is a descriptive comparison of compatible samples; uncertainty, excluded outcomes, timing and external changes can affect the delta.',
    noGuarantee:
      'This observed delta does not guarantee ranking, citation, recommendation or future performance.',
  });
}

function normalizeCostBreakdown(
  costs: readonly ExperimentMonetaryCost[],
): ExperimentMonetaryCost[] {
  const amountMicrosByCurrency = new Map<string, bigint>();
  for (const cost of costs) {
    if (!/^\d+\.\d{6}$/u.test(cost.amount) || !/^[A-Z]{3}$/u.test(cost.currency)) {
      throw new Error('EXPERIMENT_COST_INVALID');
    }
    const amountMicros = BigInt(cost.amount.replace('.', ''));
    amountMicrosByCurrency.set(
      cost.currency,
      (amountMicrosByCurrency.get(cost.currency) ?? 0n) + amountMicros,
    );
  }
  return [...amountMicrosByCurrency.entries()]
    .sort(([left], [right]) => codeUnitCompare(left, right))
    .map(([currency, amountMicros]) => ({
      amount: `${amountMicros / 1_000_000n}.${String(amountMicros % 1_000_000n).padStart(6, '0')}`,
      currency,
    }));
}

const STRATIFIABLE_FIELDS = new Set<MetricCompatibilityField>([
  'providerKey',
  'surfaceKey',
  'model',
  'modelVersion',
  'scope',
]);

function findDifferingFields(
  baseline: MetricCompatibilityFields,
  remeasurement: MetricCompatibilityFields,
): MetricCompatibilityField[] {
  const fields: MetricCompatibilityField[] = [
    'metricKey',
    'methodVersion',
    'scenarioId',
    'scenarioVersion',
    'providerKey',
    'surfaceKey',
    'acquisitionClass',
    'acquisitionMethod',
    'adapterKey',
    'adapterVersion',
    'model',
    'modelVersion',
    'scope',
    'parameters',
  ];
  return fields
    .filter((field) => canonicalJson(baseline[field]) !== canonicalJson(remeasurement[field]))
    .sort(codeUnitCompare);
}

function compatibilityIdentity(
  input: ExperimentSnapshotInput,
  compatibility: MetricCompatibilityKey,
): ExperimentCompatibilityIdentity {
  return {
    snapshotId: input.snapshotId,
    contentHash: input.snapshot.contentHash,
    compatibilityKey: compatibility.key,
    compatibilityHash: compatibility.hash,
  };
}

function summarizeSnapshot(input: ExperimentSnapshotInput): ExperimentSnapshotSummary {
  const excludedCounts = canonicalClone(input.snapshot.excludedCounts);
  return {
    snapshotId: input.snapshotId,
    contentHash: input.snapshot.contentHash,
    numerator: input.snapshot.numerator,
    eligibleDenominator: input.snapshot.eligibleDenominator,
    value: normalizeExperimentRate(input.snapshot.value),
    sampleSize:
      input.snapshot.eligibleDenominator +
      excludedCounts.ERROR +
      excludedCounts.NOT_CHECKED +
      excludedCounts.INCONCLUSIVE +
      excludedCounts.NOT_APPLICABLE,
    excludedCounts,
  };
}

function normalizeExperimentRate(value: number | null): number | null {
  if (value === null) return null;
  return experimentRateFromUnits(experimentRateUnits(value));
}

const EXPERIMENT_RATE_SCALE = 1_000_000_000_000n;

function experimentRateUnits(value: number): bigint {
  if (!Number.isFinite(value)) throw new Error('EXPERIMENT_RATE_INVALID');
  const rendered = canonicalNumber(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(rendered);
  if (match === null) throw new Error('EXPERIMENT_RATE_INVALID');
  const negative = match[1] === '-';
  const integerDigits = match[2]!;
  const fractionDigits = match[3] ?? '';
  const keptFraction = fractionDigits.slice(0, 12).padEnd(12, '0');
  let magnitude = BigInt(integerDigits) * EXPERIMENT_RATE_SCALE + BigInt(keptFraction);
  if ((fractionDigits[12] ?? '0') >= '5') magnitude += 1n;
  return negative ? -magnitude : magnitude;
}

function experimentRateFromUnits(units: bigint): number {
  if (units === 0n) return 0;
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const integerDigits = magnitude / EXPERIMENT_RATE_SCALE;
  const fractionDigits = String(magnitude % EXPERIMENT_RATE_SCALE)
    .padStart(12, '0')
    .replace(/0+$/u, '');
  return Number(
    `${negative ? '-' : ''}${integerDigits}${fractionDigits.length === 0 ? '' : `.${fractionDigits}`}`,
  );
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function canonicalJson(value: unknown, ancestors: ReadonlySet<object> = new Set()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('EXPERIMENT_CANONICAL_JSON_INVALID');
    return canonicalNumber(value);
  }
  if (typeof value !== 'object') throw new Error('EXPERIMENT_CANONICAL_JSON_INVALID');
  if (ancestors.has(value)) throw new Error('EXPERIMENT_CANONICAL_JSON_INVALID');

  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) {
      throw new Error('EXPERIMENT_CANONICAL_JSON_INVALID');
    }
    return `[${value.map((entry) => canonicalJson(entry, nextAncestors)).join(',')}]`;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('EXPERIMENT_CANONICAL_JSON_INVALID');
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], nextAncestors)}`)
    .join(',')}}`;
}

function canonicalNumber(value: number): string {
  const serialized = JSON.stringify(value);
  if (!/[eE]/u.test(serialized)) return serialized;

  const [coefficientPart, exponentPart] = serialized.toLowerCase().split('e');
  if (coefficientPart === undefined || exponentPart === undefined) {
    throw new Error('EXPERIMENT_CANONICAL_JSON_INVALID');
  }
  const negative = coefficientPart.startsWith('-');
  const coefficient = negative ? coefficientPart.slice(1) : coefficientPart;
  const [integerPart, fractionPart = ''] = coefficient.split('.');
  if (integerPart === undefined) throw new Error('EXPERIMENT_CANONICAL_JSON_INVALID');
  const digits = `${integerPart}${fractionPart}`;
  const decimalPosition = integerPart.length + Number.parseInt(exponentPart, 10);
  const sign = negative ? '-' : '';

  if (decimalPosition <= 0) {
    return `${sign}0.${'0'.repeat(-decimalPosition)}${digits}`;
  }
  if (decimalPosition >= digits.length) {
    return `${sign}${digits}${'0'.repeat(decimalPosition - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function sha256(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(bytes);
  message[bytes.length] = 0x80;
  const view = new DataView(message.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(paddedLength - 4, (bytes.length * 8) >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15]!;
      const word2 = words[index - 2]!;
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choose + SHA256_ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
