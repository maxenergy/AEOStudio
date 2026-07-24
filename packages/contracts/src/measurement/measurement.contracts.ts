import { z } from 'zod';

import { SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import { JobSchema } from '@aeostudio/contracts/jobs-budgets';

export const MeasurementRunStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'PARTIAL',
  'ERROR',
  'CANCELLED',
]);

export const MeasurementRunKindSchema = z.enum(['BASELINE', 'REMEASUREMENT']);

export const PromptRunStatusSchema = z.enum([
  'PASS',
  'FAIL',
  'ERROR',
  'NOT_CHECKED',
  'INCONCLUSIVE',
  'NOT_APPLICABLE',
]);

export const MeasurementScopeSchema = z
  .object({
    market: z.string().trim().min(1).max(120),
    locale: z.string().trim().min(1).max(80),
    region: z.string().trim().min(1).max(160),
  })
  .strict();

export const ScenarioSnapshotSchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    promptRevisionId: z.uuid(),
    providerKey: z.string().min(1).max(120),
    surfaceKey: z.string().min(1).max(120),
    model: z.string().min(1).max(240),
    modelVersion: z.string().min(1).max(240),
    account: z.string().min(1).max(500),
    acquisitionClass: z.enum([
      'CONSUMER_UI_SAMPLE',
      'MODEL_API_DIAGNOSTIC',
      'SEARCH_DATA_API',
      'MANUAL_IMPORT',
    ]),
    acquisitionMethod: z.string().min(1).max(120),
    registryStatus: z.enum(['AVAILABLE', 'UNAVAILABLE']),
    manualImport: z
      .object({ id: z.uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .nullable(),
    freshSession: z.boolean(),
    searchEnabled: z.boolean(),
    parameters: z.record(z.string(), z.unknown()),
    repetitions: z.number().int().min(3).max(100),
    scopes: z.array(MeasurementScopeSchema).min(1).max(3),
  })
  .strict();

export const MonetaryCostSchema = z
  .object({
    amount: z.string().regex(/^\d+\.\d{6}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();

const CostBreakdownSchema = z.array(MonetaryCostSchema).min(1);

function costSummaryIsHonest(value: {
  cost: { amount: string; currency: string } | null;
  costBreakdown: { amount: string; currency: string }[];
}): boolean {
  const currencies = value.costBreakdown.map((entry) => entry.currency);
  const sortedCurrencies = [...currencies].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (
    new Set(currencies).size !== currencies.length ||
    currencies.some((currency, index) => currency !== sortedCurrencies[index])
  ) {
    return false;
  }
  if (value.cost === null) return value.costBreakdown.length > 1;
  const only = value.costBreakdown[0];
  return (
    value.costBreakdown.length === 1 &&
    only !== undefined &&
    only.amount === value.cost.amount &&
    only.currency === value.cost.currency
  );
}

export const MeasurementObservationSchema = z
  .object({
    mention: z.boolean().nullable(),
    citation: z.boolean().nullable(),
    accuracy: z.enum(['MATCH', 'MISMATCH', 'NOT_APPLICABLE']).nullable(),
    coverage: z.boolean().nullable(),
  })
  .strict();

export const MeasurementRunSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    promptRevisionId: z.uuid(),
    scenarioId: z.uuid(),
    scenarioVersion: z.number().int().positive(),
    jobId: z.uuid().nullable(),
    kind: MeasurementRunKindSchema,
    status: MeasurementRunStatusSchema,
    expectedPromptRunCount: z.number().int().positive(),
    completedPromptRunCount: z.number().int().nonnegative(),
    providerKey: z.string().min(1).max(120),
    surfaceKey: z.string().min(1).max(120),
    model: z.string().min(1).max(240),
    modelVersion: z.string().min(1).max(240),
    acquisitionClass: z.enum([
      'CONSUMER_UI_SAMPLE',
      'MODEL_API_DIAGNOSTIC',
      'SEARCH_DATA_API',
      'MANUAL_IMPORT',
    ]),
    acquisitionMethod: z.string().min(1).max(120),
    adapterVersion: z.string().min(1).max(120),
    scenarioSnapshot: ScenarioSnapshotSchema,
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const PromptRunSchema = z
  .object({
    id: z.uuid(),
    measurementRunId: z.uuid(),
    promptId: z.uuid(),
    promptOrdinal: z.number().int().positive(),
    repetition: z.number().int().positive(),
    scopeKey: z.string().min(1).max(500),
    status: PromptRunStatusSchema,
    providerKey: z.string().min(1).max(120),
    surfaceKey: z.string().min(1).max(120),
    model: z.string().min(1).max(240),
    modelVersion: z.string().min(1).max(240),
    scenarioId: z.uuid(),
    scenarioVersion: z.number().int().positive(),
    acquisitionMethod: z.string().min(1).max(120),
    acquisitionClass: z.enum([
      'CONSUMER_UI_SAMPLE',
      'MODEL_API_DIAGNOSTIC',
      'SEARCH_DATA_API',
      'MANUAL_IMPORT',
    ]),
    adapterKey: z.string().min(1).max(120),
    adapterVersion: z.string().min(1).max(120),
    methodVersion: z.string().min(1).max(120),
    observation: MeasurementObservationSchema,
    cost: MonetaryCostSchema,
    policyReason: z.string().min(1).max(160).nullable(),
    observedAt: z.iso.datetime(),
  })
  .strict();

export const RawCitationSchema = z
  .object({
    url: z.url(),
    title: z.string().max(500),
    snippet: z.string().max(4_000),
  })
  .strict();

export const RawMeasurementEvidenceSchema = z
  .object({
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    responseText: z.string().max(2_000_000).nullable(),
    citations: z.array(RawCitationSchema).max(1_000),
    error: z
      .object({ code: z.string().min(1).max(160), message: z.string().min(1).max(4_000) })
      .strict()
      .nullable(),
  })
  .strict();

const EnvelopeMetaSchema = z
  .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
  .strict();

export const StartMeasurementRunRequestSchema = z
  .object({
    promptSetId: z.uuid(),
    promptRevisionId: z.uuid(),
    scenarioId: z.uuid(),
    expectedPromptHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedScenarioHash: z.string().regex(/^[a-f0-9]{64}$/),
    manualImportId: z.uuid().optional(),
    expectedManualImportHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    kind: MeasurementRunKindSchema,
    idempotencyKey: z.string().trim().min(1).max(160),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.manualImportId === undefined) !== (value.expectedManualImportHash === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['manualImportId'],
        message: 'manualImportId and expectedManualImportHash must be provided together.',
      });
    }
  });

export const MeasurementProviderPolicyRequestSchema = z
  .object({
    adapterVersion: z.string().trim().min(1).max(120),
    termsVersion: z.string().trim().min(1).max(120),
    termsApproved: z.boolean(),
    authorizationApproved: z.boolean(),
    crossBorderApproved: z.boolean(),
    purpose: z.string().trim().min(1).max(500),
    policyVersion: z.string().trim().min(1).max(120),
  })
  .strict();

export const MeasurementProviderPolicySchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    providerKey: z.string().min(1).max(120),
    surfaceKey: z.string().min(1).max(120),
    adapterVersion: z.string().min(1).max(120),
    termsVersion: z.string().min(1).max(120),
    termsApproved: z.boolean(),
    authorizationApproved: z.boolean(),
    crossBorderApproved: z.boolean(),
    purpose: z.string().min(1).max(500),
    policyVersion: z.string().min(1).max(120),
    approvedByUserId: z.uuid(),
    approvedAt: z.iso.datetime(),
  })
  .strict();

export const MeasurementProviderPolicyEligibilityReasonSchema = z.enum([
  'POLICY_MISSING',
  'ADAPTER_UNAVAILABLE',
  'ADAPTER_VERSION_MISMATCH',
  'TERMS_VERSION_MISMATCH',
  'TERMS_NOT_APPROVED',
  'AUTHORIZATION_NOT_APPROVED',
  'CROSS_BORDER_NOT_APPROVED',
]);

export const MeasurementProviderPolicyStateSchema = z
  .object({
    providerKey: z.string().min(1).max(120),
    surfaceKey: z.string().min(1).max(120),
    requiredAdapterVersion: z.string().min(1).max(120),
    requiredTermsVersion: z.string().min(1).max(120).nullable(),
    requiresAuthorization: z.boolean(),
    eligible: z.boolean(),
    reasons: z.array(MeasurementProviderPolicyEligibilityReasonSchema).max(7),
    policy: MeasurementProviderPolicySchema.nullable(),
  })
  .strict();

export const MeasurementProviderPolicyStateEnvelopeSchema = z
  .object({
    data: z.object({ state: MeasurementProviderPolicyStateSchema }).strict(),
    meta: EnvelopeMetaSchema,
  })
  .strict();

export const MeasurementProviderPolicyEnvelopeSchema = z
  .object({
    data: z.object({ policy: MeasurementProviderPolicySchema }).strict(),
    meta: EnvelopeMetaSchema,
  })
  .strict();

export const StartMeasurementRunEnvelopeSchema = z
  .object({
    data: z.object({ measurementRun: MeasurementRunSchema, job: JobSchema }).strict(),
    meta: EnvelopeMetaSchema,
  })
  .strict();

export const MeasurementRunEnvelopeSchema = z
  .object({
    data: z.object({ measurementRun: MeasurementRunSchema }).strict(),
    meta: EnvelopeMetaSchema,
  })
  .strict();

export const MeasurementPromptRunListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(100),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
    scopeKey: z.string().min(1).max(500).optional(),
    dimension: z
      .enum(['MENTION_RATE', 'CITATION_RATE', 'ACCURACY_RATE', 'COVERAGE_RATE', 'COST', 'ERROR'])
      .optional(),
  })
  .strict();

export const MeasurementPromptRunListEnvelopeSchema = z
  .object({
    data: z.object({ promptRuns: z.array(PromptRunSchema).max(100) }).strict(),
    meta: EnvelopeMetaSchema.extend({
      total: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(100),
      offset: z.number().int().nonnegative(),
      nextOffset: z.number().int().positive().nullable(),
    }).strict(),
  })
  .strict();

export const PromptRunEnvelopeSchema = z
  .object({
    data: z
      .object({ promptRun: PromptRunSchema, rawEvidence: RawMeasurementEvidenceSchema })
      .strict(),
    meta: EnvelopeMetaSchema,
  })
  .strict();

export const ExcludedCountsSchema = z
  .object({
    ERROR: z.number().int().nonnegative(),
    NOT_CHECKED: z.number().int().nonnegative(),
    INCONCLUSIVE: z.number().int().nonnegative(),
    NOT_APPLICABLE: z.number().int().nonnegative(),
  })
  .strict();

export const DashboardCohortSchema = z
  .object({
    providerKey: z.string().min(1).max(120),
    surfaceKey: z.string().min(1).max(120),
    model: z.string().min(1).max(240),
    modelVersion: z.string().min(1).max(240),
    scenarioId: z.uuid(),
    scenarioVersion: z.number().int().positive(),
    acquisitionMethod: z.string().min(1).max(120),
    acquisitionClass: z.enum([
      'CONSUMER_UI_SAMPLE',
      'MODEL_API_DIAGNOSTIC',
      'SEARCH_DATA_API',
      'MANUAL_IMPORT',
    ]),
    adapterKey: z.string().min(1).max(120),
    adapterVersion: z.string().min(1).max(120),
    scopeKey: z.string().min(1).max(500),
  })
  .strict();

export const DashboardMetricSchema = z
  .object({
    id: z.uuid(),
    metricKey: z.enum(['MENTION_RATE', 'CITATION_RATE', 'ACCURACY_RATE', 'COVERAGE_RATE']),
    methodVersion: z.string().min(1).max(120),
    numerator: z.number().int().nonnegative(),
    eligibleDenominator: z.number().int().nonnegative(),
    value: z.number().min(0).max(1).nullable(),
    excludedCounts: ExcludedCountsSchema,
    promptRunIds: z.array(z.uuid()),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    cohort: DashboardCohortSchema,
  })
  .strict();

export const MeasurementResultCountsSchema = z
  .object({
    PASS: z.number().int().nonnegative(),
    FAIL: z.number().int().nonnegative(),
    ERROR: z.number().int().nonnegative(),
    NOT_CHECKED: z.number().int().nonnegative(),
    INCONCLUSIVE: z.number().int().nonnegative(),
    NOT_APPLICABLE: z.number().int().nonnegative(),
  })
  .strict();

const TechnicalHealthSectionSchema = z
  .object({
    key: z.literal('TECHNICAL_HEALTH'),
    sourceKind: z.literal('OWNED_SITE_BASELINE'),
    summary: z.discriminatedUnion('state', [
      z
        .object({
          state: z.literal('NOT_LINKED'),
          reason: z.literal('MEASUREMENT_SCENARIO_SITE_NOT_LINKED'),
        })
        .strict(),
      z
        .object({
          state: z.literal('AVAILABLE'),
          siteId: z.uuid(),
          baselineId: z.uuid(),
          capturedAt: z.iso.datetime(),
          status: z.enum(['COMPLETE', 'PARTIAL', 'FAILED_TERMINAL']),
          pageCount: z.number().int().nonnegative(),
          findingCount: z.number().int().nonnegative(),
        })
        .strict(),
    ]),
  })
  .strict();

const ContentEvidenceReadinessSectionSchema = z
  .object({
    key: z.literal('CONTENT_EVIDENCE_READINESS'),
    sourceKind: z.literal('CLAIM_EVIDENCE_LEDGER'),
    summary: z.discriminatedUnion('state', [
      z
        .object({
          state: z.literal('NOT_LINKED'),
          reason: z.literal('MEASUREMENT_SCENARIO_CLAIM_SET_NOT_LINKED'),
        })
        .strict(),
      z
        .object({
          state: z.literal('AVAILABLE'),
          claimSetHash: z.string().regex(/^[a-f0-9]{64}$/),
          evaluatedAt: z.iso.datetime(),
          approvedCount: z.number().int().nonnegative(),
          staleCount: z.number().int().nonnegative(),
          needsEvidenceCount: z.number().int().nonnegative(),
        })
        .strict(),
    ]),
  })
  .strict();

const MeasuredAiVisibilitySectionSchema = z
  .object({
    key: z.literal('MEASURED_AI_VISIBILITY'),
    cohorts: z.array(
      z
        .object({
          cohort: DashboardCohortSchema,
          metricIds: z.array(z.uuid()).length(4),
          cost: MonetaryCostSchema.nullable(),
          costBreakdown: CostBreakdownSchema,
          resultCounts: MeasurementResultCountsSchema,
        })
        .strict()
        .refine(costSummaryIsHonest, { message: 'MEASUREMENT_COST_SUMMARY_INVALID' }),
    ),
    crossSurfaceAggregate: z.never().optional(),
  })
  .strict();

export const MeasurementDashboardEnvelopeSchema = z
  .object({
    data: z
      .object({
        snapshot: z
          .object({
            measurementRunId: z.uuid(),
            metrics: z.array(DashboardMetricSchema).min(4),
          })
          .strict(),
        sections: z.tuple([
          TechnicalHealthSectionSchema,
          ContentEvidenceReadinessSectionSchema,
          MeasuredAiVisibilitySectionSchema,
        ]),
        cost: MonetaryCostSchema.nullable(),
        costBreakdown: CostBreakdownSchema,
        resultCounts: MeasurementResultCountsSchema,
      })
      .strict()
      .refine(costSummaryIsHonest, { message: 'MEASUREMENT_COST_SUMMARY_INVALID' }),
    meta: EnvelopeMetaSchema,
  })
  .strict();

export const MeasurementAcquisitionClassSchema = z.enum([
  'CONSUMER_UI_SAMPLE',
  'MODEL_API_DIAGNOSTIC',
  'SEARCH_DATA_API',
  'MANUAL_IMPORT',
]);

export const MeasurementSurfaceAdapterDescriptorSchema = z
  .object({
    adapterKey: z.string().min(1).max(120),
    adapterVersion: z.string().min(1).max(120),
    providerKey: z.string().min(1).max(120),
    surfaceKey: z.string().min(1).max(120),
    surfaceKind: z.enum(['SEARCH_DATA', 'CONSUMER_SEARCH', 'CONSUMER_AI_ANSWER']),
    acquisitionClass: MeasurementAcquisitionClassSchema,
    acquisitionMethod: z.string().min(1).max(120),
    termsVersion: z.string().min(1).max(120),
    processingRegion: z.string().min(1).max(240),
    storageRegion: z.string().min(1).max(240),
    retentionPolicy: z.string().min(1).max(500),
    trainingPolicy: z.string().min(1).max(500),
    subprocessors: z.array(z.string().min(1).max(240)).max(100),
    requiresAuthorization: z.boolean(),
  })
  .strict();

export const SearchDataConnectorDescriptorSchema = MeasurementSurfaceAdapterDescriptorSchema.extend(
  {
    surfaceKind: z.literal('SEARCH_DATA'),
    acquisitionClass: z.literal('SEARCH_DATA_API'),
    acquisitionMethod: z.literal('OFFICIAL_API'),
    requiresAuthorization: z.literal(true),
  },
).strict();

const ManualMeasurementImportRawEvidenceSchema = RawMeasurementEvidenceSchema.omit({
  contentHash: true,
})
  .extend({
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export const ManualMeasurementImportEntrySchema = z
  .object({
    promptId: z.uuid(),
    scope: MeasurementScopeSchema,
    repetition: z.number().int().positive(),
    observedAt: z.iso.datetime(),
    result: z
      .object({
        status: PromptRunStatusSchema,
        observation: MeasurementObservationSchema,
        cost: MonetaryCostSchema,
        rawEvidence: ManualMeasurementImportRawEvidenceSchema,
      })
      .strict(),
  })
  .strict();

export const SubmitManualMeasurementImportRequestSchema = z
  .object({
    schemaVersion: z.literal('measurement-manual-import.v1'),
    promptSetId: z.uuid(),
    promptRevisionId: z.uuid(),
    scenarioId: z.uuid(),
    expectedPromptHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedScenarioHash: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().trim().min(1).max(160),
    entries: z.array(ManualMeasurementImportEntrySchema).min(1).max(10_000),
  })
  .strict();

export const ReviewManualMeasurementImportRequestSchema = z
  .object({
    expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

export const ManualMeasurementImportSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    schemaVersion: z.literal('measurement-manual-import.v1'),
    promptSetId: z.uuid(),
    promptRevisionId: z.uuid(),
    promptContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    scenarioId: z.uuid(),
    scenarioContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    providerKey: z.string().min(1).max(120),
    surfaceKey: z.string().min(1).max(120),
    adapterVersion: z.string().min(1).max(120),
    acquisitionClass: z.literal('MANUAL_IMPORT'),
    acquisitionMethod: z.literal('MANUAL_IMPORT'),
    status: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED']),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedSlotCount: z.number().int().positive(),
    providedSlotCount: z.number().int().nonnegative(),
    costCurrency: z.string().regex(/^[A-Z]{3}$/),
    submittedByUserId: z.uuid(),
    submittedAt: z.iso.datetime(),
    reviewedByUserId: z.uuid().nullable(),
    reviewedAt: z.iso.datetime().nullable(),
    reviewNote: z.string().max(1_000).nullable(),
  })
  .strict();

export const ManualMeasurementImportSlotManifestSchema = z
  .object({
    prompt: z
      .object({
        id: z.uuid(),
        ordinal: z.number().int().positive(),
        text: z.string().max(2_000),
      })
      .strict(),
    scope: MeasurementScopeSchema,
    scopeKey: z.string().min(1).max(500),
    repetition: z.number().int().positive(),
    provided: z.boolean(),
    observedAt: z.iso.datetime().nullable(),
    result: z
      .object({
        status: PromptRunStatusSchema,
        observation: MeasurementObservationSchema,
        cost: MonetaryCostSchema,
        rawEvidence: ManualMeasurementImportRawEvidenceSchema,
      })
      .strict()
      .nullable(),
    rawEvidenceContentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((slot, context) => {
    const complete =
      slot.observedAt !== null && slot.result !== null && slot.rawEvidenceContentHash !== null;
    const empty =
      slot.observedAt === null && slot.result === null && slot.rawEvidenceContentHash === null;
    if ((slot.provided && !complete) || (!slot.provided && !empty)) {
      context.addIssue({ code: 'custom', message: 'Manual import slot state is inconsistent.' });
    }
  });

export const ManualMeasurementImportEnvelopeSchema = z
  .object({
    data: z.object({ manualImport: ManualMeasurementImportSchema }).strict(),
    meta: EnvelopeMetaSchema,
  })
  .strict();

export const ManualMeasurementImportDetailEnvelopeSchema = z
  .object({
    data: z
      .object({
        manualImport: ManualMeasurementImportSchema,
        slots: z.array(ManualMeasurementImportSlotManifestSchema).min(1).max(10_000),
      })
      .strict(),
    meta: EnvelopeMetaSchema,
  })
  .strict();

export type StartMeasurementRunRequest = z.infer<typeof StartMeasurementRunRequestSchema>;
export type MeasurementProviderPolicyRequest = z.infer<
  typeof MeasurementProviderPolicyRequestSchema
>;
export type MeasurementProviderPolicy = z.infer<typeof MeasurementProviderPolicySchema>;
export type MeasurementProviderPolicyState = z.infer<typeof MeasurementProviderPolicyStateSchema>;
export type MeasurementProviderPolicyStateEnvelope = z.infer<
  typeof MeasurementProviderPolicyStateEnvelopeSchema
>;
export type MeasurementProviderPolicyEnvelope = z.infer<
  typeof MeasurementProviderPolicyEnvelopeSchema
>;
export type StartMeasurementRunEnvelope = z.infer<typeof StartMeasurementRunEnvelopeSchema>;
export type MeasurementRunEnvelope = z.infer<typeof MeasurementRunEnvelopeSchema>;
export type MeasurementPromptRunListEnvelope = z.infer<
  typeof MeasurementPromptRunListEnvelopeSchema
>;
export type PromptRunEnvelope = z.infer<typeof PromptRunEnvelopeSchema>;
export type MeasurementDashboardEnvelope = z.infer<typeof MeasurementDashboardEnvelopeSchema>;
export type SubmitManualMeasurementImportRequest = z.infer<
  typeof SubmitManualMeasurementImportRequestSchema
>;
export type ReviewManualMeasurementImportRequest = z.infer<
  typeof ReviewManualMeasurementImportRequestSchema
>;
export type ManualMeasurementImport = z.infer<typeof ManualMeasurementImportSchema>;
export type ManualMeasurementImportEnvelope = z.infer<typeof ManualMeasurementImportEnvelopeSchema>;
export type ManualMeasurementImportSlotManifest = z.infer<
  typeof ManualMeasurementImportSlotManifestSchema
>;
export type ManualMeasurementImportDetailEnvelope = z.infer<
  typeof ManualMeasurementImportDetailEnvelopeSchema
>;
