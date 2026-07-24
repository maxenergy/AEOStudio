import { randomUUID } from 'node:crypto';

import {
  MeasurementService,
  measurementScopeKey,
  type MeasurementDashboardSource,
  type MeasurementStore,
} from '@aeostudio/application/measurement';
import { MeasurementDashboardEnvelopeSchema } from '@aeostudio/contracts/measurement';
import { describe, expect, test } from 'vitest';

import { formatDashboardCost } from '../../apps/web/src/app/app/measurement/cost-summary.js';

describe('Task 15 mixed-currency dashboard', () => {
  test('labels mixed costs as separate currencies without implying an exchange-rate total', () => {
    expect(
      formatDashboardCost({
        cost: null,
        costBreakdown: [
          { amount: '1.250000', currency: 'EUR' },
          { amount: '2.500000', currency: 'USD' },
        ],
      }),
    ).toBe('1.250000 EUR + 2.500000 USD（按币种分别统计，未换汇）');
  });

  test('represents mixed costs as a stable per-currency breakdown without a false aggregate', () => {
    const scenarioId = randomUUID();
    const promptRunIds = [randomUUID(), randomUUID()];
    const cohort = {
      providerKey: 'reviewed-provider',
      surfaceKey: 'reviewed-surface',
      model: 'reviewed-manual-import',
      modelVersion: 'manual-import-v1',
      scenarioId,
      scenarioVersion: 1,
      acquisitionMethod: 'MANUAL_IMPORT',
      acquisitionClass: 'MANUAL_IMPORT',
      adapterKey: 'reviewed-manual-import',
      adapterVersion: 'manual-import-v1',
      scopeKey: 'SG|en-SG|Singapore',
    } as const;
    const metricIds = Array.from({ length: 4 }, () => randomUUID());
    const metricKeys = ['MENTION_RATE', 'CITATION_RATE', 'ACCURACY_RATE', 'COVERAGE_RATE'] as const;
    const costBreakdown = [
      { amount: '1.250000', currency: 'EUR' },
      { amount: '2.500000', currency: 'USD' },
    ];
    const resultCounts = {
      PASS: 1,
      FAIL: 0,
      ERROR: 0,
      NOT_CHECKED: 1,
      INCONCLUSIVE: 0,
      NOT_APPLICABLE: 0,
    };
    const envelope = {
      data: {
        snapshot: {
          measurementRunId: randomUUID(),
          metrics: metricKeys.map((metricKey, index) => ({
            id: metricIds[index],
            metricKey,
            methodVersion: 'ai-visibility-snapshot-v1',
            numerator: 1,
            eligibleDenominator: 1,
            value: 1,
            excludedCounts: {
              ERROR: 0,
              NOT_CHECKED: 1,
              INCONCLUSIVE: 0,
              NOT_APPLICABLE: 0,
            },
            promptRunIds,
            sourceHash: 'a'.repeat(64),
            contentHash: 'b'.repeat(64),
            cohort,
          })),
        },
        sections: [
          {
            key: 'TECHNICAL_HEALTH',
            sourceKind: 'OWNED_SITE_BASELINE',
            summary: {
              state: 'NOT_LINKED',
              reason: 'MEASUREMENT_SCENARIO_SITE_NOT_LINKED',
            },
          },
          {
            key: 'CONTENT_EVIDENCE_READINESS',
            sourceKind: 'CLAIM_EVIDENCE_LEDGER',
            summary: {
              state: 'NOT_LINKED',
              reason: 'MEASUREMENT_SCENARIO_CLAIM_SET_NOT_LINKED',
            },
          },
          {
            key: 'MEASURED_AI_VISIBILITY',
            cohorts: [{ cohort, metricIds, cost: null, costBreakdown, resultCounts }],
          },
        ],
        cost: null,
        costBreakdown,
        resultCounts,
      },
      meta: { requestId: 'mixed-cost-request', schemaVersion: '1.0.0' },
    };

    expect(MeasurementDashboardEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  test('returns separately summed and currency-sorted costs through the dashboard service', async () => {
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const actorUserId = randomUUID();
    const membershipId = randomUUID();
    const measurementRunId = randomUUID();
    const scenarioId = randomUUID();
    const scope = { market: 'SG', locale: 'en-SG', region: 'Singapore' };
    const scopeKey = measurementScopeKey(scope);
    const cohort = {
      scenarioId,
      scenarioVersion: 1,
      providerKey: 'reviewed-provider',
      surfaceKey: 'reviewed-surface',
      acquisitionClass: 'MANUAL_IMPORT',
      acquisitionMethod: 'MANUAL_IMPORT',
      adapterKey: 'reviewed-manual-import',
      adapterVersion: 'manual-import-v1',
      model: 'reviewed-manual-import',
      modelVersion: 'manual-import-v1',
      scope,
      parameters: {},
    } as const;
    const usdRunId = randomUUID();
    const eurRunId = randomUUID();
    const source: MeasurementDashboardSource = {
      run: {
        id: measurementRunId,
        tenantId,
        workspaceId,
        promptRevisionId: randomUUID(),
        scenarioId,
        scenarioVersion: 1,
        jobId: randomUUID(),
        kind: 'BASELINE',
        status: 'COMPLETED',
        expectedPromptRunCount: 2,
        completedPromptRunCount: 2,
        providerKey: cohort.providerKey,
        surfaceKey: cohort.surfaceKey,
        model: cohort.model,
        modelVersion: cohort.modelVersion,
        acquisitionClass: 'MANUAL_IMPORT',
        acquisitionMethod: 'MANUAL_IMPORT',
        adapterVersion: 'manual-import-v1',
        scenarioSnapshot: {
          id: scenarioId,
          version: 1,
          contentHash: 'a'.repeat(64),
          promptRevisionId: randomUUID(),
          providerKey: cohort.providerKey,
          surfaceKey: cohort.surfaceKey,
          model: cohort.model,
          modelVersion: cohort.modelVersion,
          account: 'reviewed-account',
          acquisitionClass: 'MANUAL_IMPORT',
          acquisitionMethod: 'MANUAL_IMPORT',
          registryStatus: 'UNAVAILABLE',
          manualImport: { id: randomUUID(), contentHash: 'b'.repeat(64) },
          freshSession: true,
          searchEnabled: false,
          parameters: {},
          repetitions: 3,
          scopes: [scope],
        },
        createdAt: '2026-07-22T00:00:00.000Z',
        startedAt: '2026-07-22T00:00:01.000Z',
        completedAt: '2026-07-22T00:00:02.000Z',
      },
      promptRuns: [
        dashboardPromptRun({
          id: usdRunId,
          measurementRunId,
          scenarioId,
          scopeKey,
          cost: { amount: '2.500000', currency: 'USD' },
          status: 'NOT_CHECKED',
        }),
        dashboardPromptRun({
          id: eurRunId,
          measurementRunId,
          scenarioId,
          scopeKey,
          cost: { amount: '1.250000', currency: 'EUR' },
          status: 'PASS',
        }),
      ],
      snapshots: (['MENTION_RATE', 'CITATION_RATE', 'ACCURACY_RATE', 'COVERAGE_RATE'] as const).map(
        (metricKey) => ({
          id: randomUUID(),
          measurementRunId,
          metricKey,
          methodVersion: 'ai-visibility-snapshot-v1',
          cohort,
          numerator: 1,
          eligibleDenominator: 1,
          value: 1,
          excludedCounts: { ERROR: 0, NOT_CHECKED: 1, INCONCLUSIVE: 0, NOT_APPLICABLE: 0 },
          sourceObservationIds: [randomUUID(), randomUUID()],
          sourceHash: 'c'.repeat(64),
          contentHash: 'd'.repeat(64),
        }),
      ),
    };
    const service = new MeasurementService(
      { loadDashboard: () => Promise.resolve(source) } as unknown as MeasurementStore,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        resolveTenantContext: () =>
          Promise.resolve({
            tenantId,
            workspaceId,
            actorUserId,
            membershipId,
            role: 'ANALYST' as const,
          }),
        appendDeniedAudit: () => Promise.resolve(),
      },
      { next: randomUUID },
      { now: () => new Date('2026-07-22T00:00:03.000Z') },
    );

    await expect(
      service.getDashboard({
        actorSubject: 'analyst-subject',
        tenantId,
        workspaceId,
        measurementRunId,
      }),
    ).resolves.toMatchObject({
      cost: null,
      costBreakdown: [
        { amount: '1.250000', currency: 'EUR' },
        { amount: '2.500000', currency: 'USD' },
      ],
      sections: [
        {},
        {},
        {
          cohorts: [
            {
              cost: null,
              costBreakdown: [
                { amount: '1.250000', currency: 'EUR' },
                { amount: '2.500000', currency: 'USD' },
              ],
            },
          ],
        },
      ],
    });
  });
});

function dashboardPromptRun(input: {
  id: string;
  measurementRunId: string;
  scenarioId: string;
  scopeKey: string;
  cost: { amount: string; currency: string };
  status: 'PASS' | 'NOT_CHECKED';
}) {
  return {
    id: input.id,
    measurementRunId: input.measurementRunId,
    promptId: randomUUID(),
    promptOrdinal: 1,
    repetition: 1,
    scopeKey: input.scopeKey,
    status: input.status,
    providerKey: 'reviewed-provider',
    surfaceKey: 'reviewed-surface',
    model: 'reviewed-manual-import',
    modelVersion: 'manual-import-v1',
    scenarioId: input.scenarioId,
    scenarioVersion: 1,
    acquisitionMethod: 'MANUAL_IMPORT',
    acquisitionClass: 'MANUAL_IMPORT' as const,
    adapterKey: 'reviewed-manual-import',
    adapterVersion: 'manual-import-v1',
    methodVersion: 'manual-import-observation-v1',
    observation:
      input.status === 'PASS'
        ? { mention: true, citation: true, accuracy: 'MATCH' as const, coverage: true }
        : { mention: null, citation: null, accuracy: null, coverage: null },
    cost: input.cost,
    policyReason: input.status === 'NOT_CHECKED' ? 'PROVIDER_POLICY_NOT_APPROVED' : null,
    observedAt: '2026-07-22T00:00:01.000Z',
  };
}
