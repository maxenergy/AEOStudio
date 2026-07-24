export type MetricClassification =
  'PASS' | 'FAIL' | 'MISMATCH' | 'ERROR' | 'NOT_CHECKED' | 'INCONCLUSIVE' | 'NOT_APPLICABLE';

export type MeasurementAcquisitionClass =
  'CONSUMER_UI_SAMPLE' | 'MODEL_API_DIAGNOSTIC' | 'SEARCH_DATA_API' | 'MANUAL_IMPORT';

export interface MetricCohort {
  scenarioId: string;
  scenarioVersion: number;
  providerKey: string;
  surfaceKey: string;
  acquisitionClass: MeasurementAcquisitionClass;
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

export interface MetricObservation {
  id: string;
  promptRunId: string;
  metricKey: string;
  classification: MetricClassification;
  cohort: MetricCohort;
}

export interface MetricExcludedCounts {
  ERROR: number;
  NOT_CHECKED: number;
  INCONCLUSIVE: number;
  NOT_APPLICABLE: number;
}

export interface MetricSnapshot {
  schemaVersion: 'metric-snapshot.v1';
  metricKey: string;
  methodVersion: string;
  cohort: MetricCohort;
  numerator: number;
  eligibleDenominator: number;
  value: number | null;
  excludedCounts: MetricExcludedCounts;
  sourceObservationIds: string[];
  sourceHash: string;
  contentHash: string;
}

export interface BuildMetricSnapshotInput {
  metricKey: string;
  methodVersion: string;
  observations: readonly MetricObservation[];
}

export function metricValueFromCounts(
  numerator: number,
  eligibleDenominator: number,
): number | null {
  if (
    !Number.isSafeInteger(numerator) ||
    numerator < 0 ||
    !Number.isSafeInteger(eligibleDenominator) ||
    eligibleDenominator < 0 ||
    numerator > eligibleDenominator
  ) {
    throw new Error('MEASUREMENT_METRIC_COUNTS_INVALID');
  }
  return eligibleDenominator === 0 ? null : numerator / eligibleDenominator;
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

/**
 * Reduces raw observations for exactly one measurement cohort. The reducer deliberately has no
 * cross-Surface aggregation path: a single differing cohort field is a hard error.
 */
export function buildMetricSnapshot(input: BuildMetricSnapshotInput): MetricSnapshot {
  if (input.observations.length === 0) throw new Error('MEASUREMENT_OBSERVATIONS_REQUIRED');

  const observations = [...input.observations].sort(
    (left, right) =>
      left.id.localeCompare(right.id) || left.promptRunId.localeCompare(right.promptRunId),
  );
  assertUniqueObservationIds(observations);
  assertMetricAndCohort(input.metricKey, observations);

  let numerator = 0;
  let eligibleDenominator = 0;
  const excludedCounts: MetricExcludedCounts = {
    ERROR: 0,
    NOT_CHECKED: 0,
    INCONCLUSIVE: 0,
    NOT_APPLICABLE: 0,
  };

  for (const observation of observations) {
    switch (observation.classification) {
      case 'PASS':
        numerator += 1;
        eligibleDenominator += 1;
        break;
      case 'FAIL':
      case 'MISMATCH':
        eligibleDenominator += 1;
        break;
      case 'ERROR':
      case 'NOT_CHECKED':
      case 'INCONCLUSIVE':
      case 'NOT_APPLICABLE':
        excludedCounts[observation.classification] += 1;
        break;
    }
  }

  const sourceObservationIds = observations.map((observation) => observation.id);
  const sourceHash = sha256(canonicalMeasurementJson(observations));
  const snapshotWithoutContentHash = {
    schemaVersion: 'metric-snapshot.v1' as const,
    metricKey: input.metricKey,
    methodVersion: input.methodVersion,
    cohort: canonicalClone(observations[0]!.cohort),
    numerator,
    eligibleDenominator,
    value: metricValueFromCounts(numerator, eligibleDenominator),
    excludedCounts,
    sourceObservationIds,
    sourceHash,
  };
  const snapshot: MetricSnapshot = {
    ...snapshotWithoutContentHash,
    contentHash: sha256(canonicalMeasurementJson(snapshotWithoutContentHash)),
  };

  return deepFreeze(snapshot);
}

function assertUniqueObservationIds(observations: readonly MetricObservation[]): void {
  for (let index = 1; index < observations.length; index += 1) {
    if (observations[index - 1]!.id === observations[index]!.id) {
      throw new Error('MEASUREMENT_DUPLICATE_OBSERVATION');
    }
  }
}

function assertMetricAndCohort(
  metricKey: string,
  observations: readonly MetricObservation[],
): void {
  const cohort = canonicalMeasurementJson(observations[0]!.cohort);
  for (const observation of observations) {
    if (observation.metricKey !== metricKey) throw new Error('MEASUREMENT_METRIC_MISMATCH');
    if (canonicalMeasurementJson(observation.cohort) !== cohort) {
      throw new Error('MEASUREMENT_COHORT_MISMATCH');
    }
  }
}

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

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalMeasurementJson(value)) as T;
}

function canonicalMeasurementJson(
  value: unknown,
  ancestors: ReadonlySet<object> = new Set(),
): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('MEASUREMENT_CANONICAL_JSON_INVALID');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error('MEASUREMENT_CANONICAL_JSON_INVALID');
  if (ancestors.has(value)) throw new Error('MEASUREMENT_CANONICAL_JSON_INVALID');

  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) {
      throw new Error('MEASUREMENT_CANONICAL_JSON_INVALID');
    }
    return `[${value.map((entry) => canonicalMeasurementJson(entry, nextAncestors)).join(',')}]`;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('MEASUREMENT_CANONICAL_JSON_INVALID');
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalMeasurementJson(record[key], nextAncestors)}`)
    .join(',')}}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
