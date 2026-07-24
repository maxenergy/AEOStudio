import { describe, expect, it } from 'vitest';
import {
  validateCohortCompatibility,
  validateSchedulerIdempotency,
  validateScheduledRunAuthorization,
  validateCurrencySafety,
  type MetricCohort,
  type CohortCompatibilityInput,
  type SchedulerIdempotencyInput,
  type ScheduledRunAuthorizationInput,
  type CurrencySafetyInput,
} from '@aeostudio/domain/measurement';

function makeCohort(overrides: Partial<MetricCohort> = {}): MetricCohort {
  return {
    scenarioId: '00000000-0000-7000-8000-000000000001',
    scenarioVersion: 1,
    providerKey: 'openai',
    surfaceKey: 'chatgpt-web',
    acquisitionClass: 'CONSUMER_UI_SAMPLE',
    acquisitionMethod: 'browser-automation-v1',
    adapterKey: 'measurement-adapter-v1',
    adapterVersion: '1.0.0',
    model: 'gpt-4o',
    modelVersion: '2026-05-13',
    scope: { market: 'US', locale: 'en-US', region: 'north-america' },
    parameters: {},
    ...overrides,
  };
}

describe('C09: Measurement Production Safety', () => {
  describe('Cohort compatibility', () => {
    function makeCompatibilityInput(
      overrides: Partial<CohortCompatibilityInput> = {},
    ): CohortCompatibilityInput {
      return {
        baselineCohort: makeCohort(),
        comparisonCohort: makeCohort(),
        ...overrides,
      };
    }

    it('accepts identical cohorts for comparison', () => {
      const result = validateCohortCompatibility(makeCompatibilityInput());
      expect(result.compatible).toBe(true);
      expect(result.incompatibleFields).toEqual([]);
    });

    it('rejects cohorts with different provider', () => {
      const result = validateCohortCompatibility(
        makeCompatibilityInput({
          comparisonCohort: makeCohort({ providerKey: 'anthropic' }),
        }),
      );
      expect(result.compatible).toBe(false);
      expect(result.incompatibleFields).toContain('providerKey');
    });

    it('rejects cohorts with different model', () => {
      const result = validateCohortCompatibility(
        makeCompatibilityInput({
          comparisonCohort: makeCohort({ model: 'claude-3.5-sonnet' }),
        }),
      );
      expect(result.compatible).toBe(false);
      expect(result.incompatibleFields).toContain('model');
    });

    it('rejects cohorts with different model version', () => {
      const result = validateCohortCompatibility(
        makeCompatibilityInput({
          comparisonCohort: makeCohort({ modelVersion: '2026-06-01' }),
        }),
      );
      expect(result.compatible).toBe(false);
      expect(result.incompatibleFields).toContain('modelVersion');
    });

    it('rejects cohorts with different surface', () => {
      const result = validateCohortCompatibility(
        makeCompatibilityInput({
          comparisonCohort: makeCohort({ surfaceKey: 'api-direct' }),
        }),
      );
      expect(result.compatible).toBe(false);
      expect(result.incompatibleFields).toContain('surfaceKey');
    });

    it('rejects cohorts with different acquisition class', () => {
      const result = validateCohortCompatibility(
        makeCompatibilityInput({
          comparisonCohort: makeCohort({ acquisitionClass: 'MODEL_API_DIAGNOSTIC' }),
        }),
      );
      expect(result.compatible).toBe(false);
      expect(result.incompatibleFields).toContain('acquisitionClass');
    });

    it('rejects cohorts with different scope', () => {
      const result = validateCohortCompatibility(
        makeCompatibilityInput({
          comparisonCohort: makeCohort({
            scope: { market: 'CN', locale: 'zh-CN', region: 'asia' },
          }),
        }),
      );
      expect(result.compatible).toBe(false);
      expect(result.incompatibleFields).toContain('scope');
    });

    it('allows different scenario versions for rebaseline comparison', () => {
      const result = validateCohortCompatibility(
        makeCompatibilityInput({
          comparisonCohort: makeCohort({ scenarioVersion: 2 }),
        }),
      );
      expect(result.compatible).toBe(true);
    });
  });

  describe('Scheduler idempotency', () => {
    function makeIdempotencyInput(
      overrides: Partial<SchedulerIdempotencyInput> = {},
    ): SchedulerIdempotencyInput {
      return {
        scenarioId: '00000000-0000-7000-8000-000000000001',
        scenarioVersion: 1,
        scheduledFor: '2026-07-25T00:00:00.000Z',
        scheduleType: 'WEEKLY',
        existingRunKeys: [],
        ...overrides,
      };
    }

    it('allows new run when no existing runs', () => {
      const result = validateSchedulerIdempotency(makeIdempotencyInput());
      expect(result.allowed).toBe(true);
      expect(result.runKey).toBeDefined();
    });

    it('blocks duplicate run for same schedule slot', () => {
      const input = makeIdempotencyInput();
      const firstResult = validateSchedulerIdempotency(input);
      const secondResult = validateSchedulerIdempotency(
        makeIdempotencyInput({ existingRunKeys: [firstResult.runKey] }),
      );
      expect(secondResult.allowed).toBe(false);
      expect(secondResult.reason).toBe('DUPLICATE_SCHEDULE_SLOT');
    });

    it('allows run for different schedule slot', () => {
      const result = validateSchedulerIdempotency(
        makeIdempotencyInput({
          scheduledFor: '2026-08-01T00:00:00.000Z',
          existingRunKeys: ['scenario-1-v1-WEEKLY-2026-07-25'],
        }),
      );
      expect(result.allowed).toBe(true);
    });

    it('generates deterministic run key', () => {
      const input = makeIdempotencyInput();
      const result1 = validateSchedulerIdempotency(input);
      const result2 = validateSchedulerIdempotency(input);
      expect(result1.runKey).toBe(result2.runKey);
    });
  });

  describe('Scheduled run authorization fence', () => {
    function makeAuthInput(
      overrides: Partial<ScheduledRunAuthorizationInput> = {},
    ): ScheduledRunAuthorizationInput {
      return {
        authorizationStatus: 'ACTIVE',
        authorizationValidUntil: '2027-01-01T00:00:00.000Z',
        termsVersion: 'measurement-terms-v1',
        expectedTermsVersion: 'measurement-terms-v1',
        budgetRemaining: 100,
        ratePolicyAllowed: true,
        now: new Date('2026-07-25T00:00:00.000Z'),
        ...overrides,
      };
    }

    it('allows run when all checks pass', () => {
      const result = validateScheduledRunAuthorization(makeAuthInput());
      expect(result.allowed).toBe(true);
      expect(result.blockedReasons).toEqual([]);
    });

    it('blocks run when authorization is revoked', () => {
      const result = validateScheduledRunAuthorization(
        makeAuthInput({ authorizationStatus: 'REVOKED' }),
      );
      expect(result.allowed).toBe(false);
      expect(result.blockedReasons).toContain('AUTHORIZATION_REVOKED');
    });

    it('blocks run when authorization validation expired', () => {
      const result = validateScheduledRunAuthorization(
        makeAuthInput({
          authorizationValidUntil: '2026-01-01T00:00:00.000Z',
          now: new Date('2026-07-25T00:00:00.000Z'),
        }),
      );
      expect(result.allowed).toBe(false);
      expect(result.blockedReasons).toContain('AUTHORIZATION_VALIDATION_EXPIRED');
    });

    it('blocks run when terms version mismatch', () => {
      const result = validateScheduledRunAuthorization(
        makeAuthInput({ termsVersion: 'measurement-terms-v0' }),
      );
      expect(result.allowed).toBe(false);
      expect(result.blockedReasons).toContain('TERMS_VERSION_MISMATCH');
    });

    it('blocks run when budget exhausted', () => {
      const result = validateScheduledRunAuthorization(makeAuthInput({ budgetRemaining: 0 }));
      expect(result.allowed).toBe(false);
      expect(result.blockedReasons).toContain('BUDGET_EXHAUSTED');
    });

    it('blocks run when rate policy disallows', () => {
      const result = validateScheduledRunAuthorization(makeAuthInput({ ratePolicyAllowed: false }));
      expect(result.allowed).toBe(false);
      expect(result.blockedReasons).toContain('RATE_POLICY_BLOCKED');
    });
  });

  describe('Currency safety', () => {
    function makeCurrencyInput(overrides: Partial<CurrencySafetyInput> = {}): CurrencySafetyInput {
      return {
        values: [
          { amount: 100, currency: 'USD', label: 'cost-1' },
          { amount: 200, currency: 'USD', label: 'cost-2' },
        ],
        ...overrides,
      };
    }

    it('allows aggregation of same currency', () => {
      const result = validateCurrencySafety(makeCurrencyInput());
      expect(result.safe).toBe(true);
      expect(result.totalAmount).toBe(300);
      expect(result.currency).toBe('USD');
    });

    it('rejects mixed currency aggregation', () => {
      const result = validateCurrencySafety(
        makeCurrencyInput({
          values: [
            { amount: 100, currency: 'USD', label: 'cost-1' },
            { amount: 200, currency: 'EUR', label: 'cost-2' },
          ],
        }),
      );
      expect(result.safe).toBe(false);
      expect(result.currencies).toContain('USD');
      expect(result.currencies).toContain('EUR');
    });

    it('handles empty values', () => {
      const result = validateCurrencySafety(makeCurrencyInput({ values: [] }));
      expect(result.safe).toBe(true);
      expect(result.totalAmount).toBe(0);
    });

    it('handles single value', () => {
      const result = validateCurrencySafety(
        makeCurrencyInput({ values: [{ amount: 150, currency: 'CNY', label: 'cost-1' }] }),
      );
      expect(result.safe).toBe(true);
      expect(result.totalAmount).toBe(150);
      expect(result.currency).toBe('CNY');
    });
  });

  describe('Determinism', () => {
    it('same cohort input produces same compatibility result', () => {
      const input: CohortCompatibilityInput = {
        baselineCohort: makeCohort(),
        comparisonCohort: makeCohort({ model: 'different' }),
      };
      const result1 = validateCohortCompatibility(input);
      const result2 = validateCohortCompatibility(input);
      expect(result1).toEqual(result2);
    });

    it('same scheduler input produces same run key', () => {
      const input: SchedulerIdempotencyInput = {
        scenarioId: '00000000-0000-7000-8000-000000000001',
        scenarioVersion: 1,
        scheduledFor: '2026-07-25T00:00:00.000Z',
        scheduleType: 'WEEKLY',
        existingRunKeys: [],
      };
      const result1 = validateSchedulerIdempotency(input);
      const result2 = validateSchedulerIdempotency(input);
      expect(result1.runKey).toBe(result2.runKey);
    });
  });
});
