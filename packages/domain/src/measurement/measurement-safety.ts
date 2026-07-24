import type { MetricCohort } from './measurement.js';

// ============================================================================
// C09: Measurement Production Safety Validation
// ============================================================================

// --- Cohort Compatibility ---

export interface CohortCompatibilityInput {
  baselineCohort: MetricCohort;
  comparisonCohort: MetricCohort;
}

export interface CohortCompatibilityResult {
  compatible: boolean;
  incompatibleFields: string[];
}

const COHORT_COMPATIBILITY_FIELDS: (keyof Omit<MetricCohort, 'scenarioVersion'>)[] = [
  'scenarioId',
  'providerKey',
  'surfaceKey',
  'acquisitionClass',
  'acquisitionMethod',
  'adapterKey',
  'adapterVersion',
  'model',
  'modelVersion',
];

export function validateCohortCompatibility(
  input: CohortCompatibilityInput,
): CohortCompatibilityResult {
  const incompatibleFields: string[] = [];
  const { baselineCohort, comparisonCohort } = input;

  for (const field of COHORT_COMPATIBILITY_FIELDS) {
    if (baselineCohort[field] !== comparisonCohort[field]) {
      incompatibleFields.push(field);
    }
  }

  // Compare scope separately
  if (
    baselineCohort.scope.market !== comparisonCohort.scope.market ||
    baselineCohort.scope.locale !== comparisonCohort.scope.locale ||
    baselineCohort.scope.region !== comparisonCohort.scope.region
  ) {
    incompatibleFields.push('scope');
  }

  // Note: scenarioVersion is intentionally NOT checked to allow rebaseline comparison

  return { compatible: incompatibleFields.length === 0, incompatibleFields };
}

// --- Scheduler Idempotency ---

export type ScheduleType = 'BASELINE' | 'WEEKLY' | 'MONTHLY' | 'ON_DEMAND';

export interface SchedulerIdempotencyInput {
  scenarioId: string;
  scenarioVersion: number;
  scheduledFor: string;
  scheduleType: ScheduleType;
  existingRunKeys: string[];
}

export interface SchedulerIdempotencyResult {
  allowed: boolean;
  runKey: string;
  reason?: 'DUPLICATE_SCHEDULE_SLOT';
}

function buildRunKey(input: {
  scenarioId: string;
  scenarioVersion: number;
  scheduleType: ScheduleType;
  scheduledFor: string;
}): string {
  const dateSlot = input.scheduledFor.slice(0, 10); // YYYY-MM-DD
  return `scenario-${input.scenarioId}-v${input.scenarioVersion}-${input.scheduleType}-${dateSlot}`;
}

export function validateSchedulerIdempotency(
  input: SchedulerIdempotencyInput,
): SchedulerIdempotencyResult {
  const runKey = buildRunKey(input);

  if (input.existingRunKeys.includes(runKey)) {
    return { allowed: false, runKey, reason: 'DUPLICATE_SCHEDULE_SLOT' };
  }

  return { allowed: true, runKey };
}

// --- Scheduled Run Authorization Fence ---

export type ScheduledRunBlockedReason =
  | 'AUTHORIZATION_REVOKED'
  | 'AUTHORIZATION_VALIDATION_EXPIRED'
  | 'TERMS_VERSION_MISMATCH'
  | 'BUDGET_EXHAUSTED'
  | 'RATE_POLICY_BLOCKED';

export interface ScheduledRunAuthorizationInput {
  authorizationStatus: 'ACTIVE' | 'REVOKED';
  authorizationValidUntil: string;
  termsVersion: string;
  expectedTermsVersion: string;
  budgetRemaining: number;
  ratePolicyAllowed: boolean;
  now: Date;
}

export interface ScheduledRunAuthorizationResult {
  allowed: boolean;
  blockedReasons: ScheduledRunBlockedReason[];
}

export function validateScheduledRunAuthorization(
  input: ScheduledRunAuthorizationInput,
): ScheduledRunAuthorizationResult {
  const blockedReasons: ScheduledRunBlockedReason[] = [];

  if (input.authorizationStatus === 'REVOKED') {
    blockedReasons.push('AUTHORIZATION_REVOKED');
  }

  const validUntil = new Date(input.authorizationValidUntil).getTime();
  if (Number.isFinite(validUntil) && validUntil <= input.now.getTime()) {
    blockedReasons.push('AUTHORIZATION_VALIDATION_EXPIRED');
  }

  if (input.termsVersion !== input.expectedTermsVersion) {
    blockedReasons.push('TERMS_VERSION_MISMATCH');
  }

  if (input.budgetRemaining <= 0) {
    blockedReasons.push('BUDGET_EXHAUSTED');
  }

  if (!input.ratePolicyAllowed) {
    blockedReasons.push('RATE_POLICY_BLOCKED');
  }

  return { allowed: blockedReasons.length === 0, blockedReasons };
}

// --- Currency Safety ---

export interface CurrencyValue {
  amount: number;
  currency: string;
  label: string;
}

export interface CurrencySafetyInput {
  values: CurrencyValue[];
}

export interface CurrencySafetyResult {
  safe: boolean;
  totalAmount: number;
  currency: string | null;
  currencies: string[];
}

export function validateCurrencySafety(input: CurrencySafetyInput): CurrencySafetyResult {
  if (input.values.length === 0) {
    return { safe: true, totalAmount: 0, currency: null, currencies: [] };
  }

  const currencies = [...new Set(input.values.map((v) => v.currency))];

  if (currencies.length > 1) {
    return {
      safe: false,
      totalAmount: 0,
      currency: null,
      currencies,
    };
  }

  const totalAmount = input.values.reduce((sum, v) => sum + v.amount, 0);
  return {
    safe: true,
    totalAmount,
    currency: currencies[0]!,
    currencies,
  };
}
