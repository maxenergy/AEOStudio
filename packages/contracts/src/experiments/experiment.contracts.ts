import { z } from 'zod';

import { SCHEMA_VERSION } from '@aeostudio/contracts/auth';
import { MonetaryCostSchema } from '@aeostudio/contracts/measurement';

const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const ExperimentInterventionRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('PUBLISHED_PUBLICATION'),
      publicationRecordId: z.uuid(),
      publicationAttemptId: z.uuid(),
      channelPackageId: z.uuid(),
      artifactId: z.uuid(),
      artifactReviewId: z.uuid(),
      artifactRevisionId: z.uuid(),
      artifactContentHash: ContentHashSchema,
      observedAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('APPROVED_ARTIFACT'),
      artifactId: z.uuid(),
      artifactReviewId: z.uuid(),
      artifactRevisionId: z.uuid(),
      artifactContentHash: ContentHashSchema,
      observedAt: z.iso.datetime(),
    })
    .strict(),
]);

export const CreateExperimentRequestSchema = z
  .object({
    baselineRunId: z.uuid(),
    remeasurementRunId: z.uuid(),
    intervention: ExperimentInterventionRequestSchema,
    idempotencyKey: z.string().trim().min(1).max(160),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.baselineRunId === value.remeasurementRunId) {
      context.addIssue({
        code: 'custom',
        path: ['remeasurementRunId'],
        message: 'Baseline and remeasurement must be different completed runs.',
      });
    }
  });

export const ExperimentSnapshotSummarySchema = z
  .object({
    snapshotId: z.uuid(),
    contentHash: ContentHashSchema,
    numerator: z.number().int().nonnegative(),
    eligibleDenominator: z.number().int().nonnegative(),
    value: z.number().min(0).max(1).nullable(),
    sampleSize: z.number().int().nonnegative(),
    excludedCounts: z
      .object({
        ERROR: z.number().int().nonnegative(),
        NOT_CHECKED: z.number().int().nonnegative(),
        INCONCLUSIVE: z.number().int().nonnegative(),
        NOT_APPLICABLE: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const ExperimentMetricComparisonSchema = z
  .object({
    metricKey: z.enum(['MENTION_RATE', 'CITATION_RATE', 'ACCURACY_RATE', 'COVERAGE_RATE']),
    scopeKey: z.string().min(1).max(500),
    compatibilityKey: z.string().min(1),
    compatibilityHash: ContentHashSchema,
    baseline: ExperimentSnapshotSummarySchema,
    remeasurement: ExperimentSnapshotSummarySchema,
    delta: z
      .object({
        numerator: z.number().int(),
        eligibleDenominator: z.number().int(),
        value: z.number().min(-1).max(1).nullable(),
      })
      .strict(),
    costBreakdown: z
      .object({
        baseline: z.array(MonetaryCostSchema),
        remeasurement: z.array(MonetaryCostSchema),
      })
      .strict(),
    observedAssociation: z.string().min(1).max(1_000),
    caveat: z.string().min(1).max(2_000),
    noGuarantee: z.string().min(1).max(2_000),
  })
  .strict();

export const ExperimentInterventionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('PUBLISHED_PUBLICATION'),
      publicationRecordId: z.uuid(),
      publicationAttemptId: z.uuid(),
      channelPackageId: z.uuid(),
      artifactId: z.uuid(),
      artifactReviewId: z.uuid(),
      artifactRevisionId: z.uuid(),
      artifactContentHash: ContentHashSchema,
      applicationState: z.literal('PUBLISHED'),
      observedAt: z.iso.datetime(),
      href: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('APPROVED_ARTIFACT'),
      artifactId: z.uuid(),
      artifactReviewId: z.uuid(),
      artifactRevisionId: z.uuid(),
      artifactContentHash: ContentHashSchema,
      applicationState: z.literal('APPROVED_NOT_PUBLISHED'),
      observedAt: z.iso.datetime(),
      href: z.string().min(1),
      applicationDisclosure: z.literal(
        'Approval is a recorded review event, not proof of external application or causation.',
      ),
    })
    .strict(),
]);

const ExperimentTimelineEntrySchema = z
  .object({
    runId: z.uuid(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    evidenceWindow: z
      .object({
        minObservedAt: z.iso.datetime(),
        maxObservedAt: z.iso.datetime(),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.startedAt) > Date.parse(value.completedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Run completion must not precede its start.',
      });
    }
    if (
      Date.parse(value.evidenceWindow.minObservedAt) >
      Date.parse(value.evidenceWindow.maxObservedAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceWindow', 'maxObservedAt'],
        message: 'Evidence window maximum must not precede its minimum.',
      });
    }
  })
  .readonly();

export const ExperimentMeasurementContextSchema = z
  .object({
    scenarioId: z.uuid(),
    scenarioVersion: z.number().int().positive(),
    providerKey: z.string().min(1).max(120),
    surfaceKey: z.string().min(1).max(120),
    model: z.string().min(1).max(240),
    modelVersion: z.string().min(1).max(240),
    timeline: z
      .object({
        baseline: ExperimentTimelineEntrySchema,
        remeasurement: ExperimentTimelineEntrySchema,
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export const ExperimentSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    schemaVersion: z.literal('experiment.v1'),
    baselineRunId: z.uuid(),
    remeasurementRunId: z.uuid(),
    scenarioVersion: z.number().int().positive(),
    measurementContext: ExperimentMeasurementContextSchema,
    intervention: ExperimentInterventionSchema,
    comparisons: z.array(ExperimentMetricComparisonSchema).min(1),
    sample: z
      .object({
        baseline: z.number().int().nonnegative(),
        remeasurement: z.number().int().nonnegative(),
      })
      .strict(),
    excludedCounts: z
      .object({
        baseline: ExperimentSnapshotSummarySchema.shape.excludedCounts,
        remeasurement: ExperimentSnapshotSummarySchema.shape.excludedCounts,
      })
      .strict(),
    costBreakdown: z
      .object({
        baseline: z.array(MonetaryCostSchema),
        remeasurement: z.array(MonetaryCostSchema),
      })
      .strict(),
    observedAssociation: z.string().min(1).max(2_000),
    caveat: z
      .string()
      .min(1)
      .max(4_000)
      .refine((value) => /\buncertainty\b/iu.test(value), {
        message: 'Experiment caveat must explicitly disclose uncertainty.',
      }),
    noGuarantee: z.string().min(1).max(2_000),
    drillDown: z
      .object({
        baselineRunHref: z.string().min(1),
        remeasurementRunHref: z.string().min(1),
        interventionHref: z.string().min(1),
      })
      .strict(),
    createdByUserId: z.uuid(),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    const { baseline, remeasurement } = value.measurementContext.timeline;
    if (baseline.runId !== value.baselineRunId) {
      context.addIssue({
        code: 'custom',
        path: ['measurementContext', 'timeline', 'baseline', 'runId'],
        message: 'Baseline timeline must identify the exact sealed baseline run.',
      });
    }
    if (remeasurement.runId !== value.remeasurementRunId) {
      context.addIssue({
        code: 'custom',
        path: ['measurementContext', 'timeline', 'remeasurement', 'runId'],
        message: 'Remeasurement timeline must identify the exact sealed remeasurement run.',
      });
    }
    if (value.measurementContext.scenarioVersion !== value.scenarioVersion) {
      context.addIssue({
        code: 'custom',
        path: ['measurementContext', 'scenarioVersion'],
        message: 'Measurement context must identify the sealed scenario version.',
      });
    }
    const interventionAt = Date.parse(value.intervention.observedAt);
    if (Date.parse(baseline.evidenceWindow.maxObservedAt) > interventionAt) {
      context.addIssue({
        code: 'custom',
        path: ['measurementContext', 'timeline', 'baseline', 'evidenceWindow'],
        message: 'Baseline evidence must not postdate the intervention event.',
      });
    }
    if (interventionAt > Date.parse(remeasurement.evidenceWindow.minObservedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['measurementContext', 'timeline', 'remeasurement', 'evidenceWindow'],
        message: 'Remeasurement evidence must not predate the intervention event.',
      });
    }
    const createdAt = Date.parse(value.createdAt);
    if (
      Date.parse(baseline.evidenceWindow.maxObservedAt) > createdAt ||
      Date.parse(remeasurement.evidenceWindow.maxObservedAt) > createdAt
    ) {
      context.addIssue({
        code: 'custom',
        path: ['measurementContext', 'timeline'],
        message: 'Experiment evidence must not be dated after Experiment creation.',
      });
    }
  });

export const IncompatibleExperimentSchema = z
  .object({
    outcome: z.literal('INCOMPATIBLE_SCENARIO'),
    differingFields: z.array(z.string().min(1)).min(1),
    decision: z.enum(['REBASELINE', 'STRATIFY']),
    baselineCompatibilityKeys: z.array(z.string().min(1)),
    remeasurementCompatibilityKeys: z.array(z.string().min(1)),
    caveat: z.string().min(1).max(2_000),
  })
  .strict();

export const ExperimentRunOptionSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['BASELINE', 'REMEASUREMENT']),
    scenarioId: z.uuid(),
    scenarioVersion: z.number().int().positive(),
    providerKey: z.string().min(1).max(120),
    surfaceKey: z.string().min(1).max(120),
    model: z.string().min(1).max(240),
    modelVersion: z.string().min(1).max(240),
    completedAt: z.iso.datetime(),
  })
  .strict();

export const ExperimentInterventionOptionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('PUBLISHED_PUBLICATION'),
      publicationRecordId: z.uuid(),
      publicationAttemptId: z.uuid(),
      channelPackageId: z.uuid(),
      artifactId: z.uuid(),
      artifactReviewId: z.uuid(),
      artifactRevisionId: z.uuid(),
      artifactContentHash: ContentHashSchema,
      observedAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('APPROVED_ARTIFACT'),
      artifactId: z.uuid(),
      artifactReviewId: z.uuid(),
      artifactRevisionId: z.uuid(),
      artifactContentHash: ContentHashSchema,
      observedAt: z.iso.datetime(),
    })
    .strict(),
]);

export const ExperimentCompatibleCombinationSchema = z
  .object({
    baselineRunId: z.uuid(),
    intervention: ExperimentInterventionOptionSchema,
    remeasurementRunId: z.uuid(),
  })
  .strict()
  .readonly();

const EnvelopeMetaSchema = z
  .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
  .strict();

export const ExperimentEnvelopeSchema = z
  .object({ data: z.object({ experiment: ExperimentSchema }).strict(), meta: EnvelopeMetaSchema })
  .strict();

export const ExperimentOptionsEnvelopeSchema = z
  .object({
    data: z
      .object({
        options: z
          .object({
            baselineRuns: z.array(ExperimentRunOptionSchema),
            remeasurementRuns: z.array(ExperimentRunOptionSchema),
            interventions: z.array(ExperimentInterventionOptionSchema),
            compatibleCombinations: z.array(ExperimentCompatibleCombinationSchema),
          })
          .strict(),
      })
      .strict(),
    meta: EnvelopeMetaSchema,
  })
  .strict();

export type ExperimentInterventionRequest = z.infer<typeof ExperimentInterventionRequestSchema>;
export type CreateExperimentRequest = z.infer<typeof CreateExperimentRequestSchema>;
export type Experiment = z.infer<typeof ExperimentSchema>;
export type ExperimentMetricComparison = z.infer<typeof ExperimentMetricComparisonSchema>;
export type IncompatibleExperiment = z.infer<typeof IncompatibleExperimentSchema>;
export type ExperimentMeasurementContext = z.infer<typeof ExperimentMeasurementContextSchema>;
export type ExperimentCompatibleCombination = z.infer<typeof ExperimentCompatibleCombinationSchema>;
