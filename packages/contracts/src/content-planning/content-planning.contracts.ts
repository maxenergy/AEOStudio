import { z } from 'zod';

import { SCHEMA_VERSION } from '../auth/auth.contracts.js';
import { JobSchema } from '../jobs-budgets/jobs-budgets.contracts.js';

const UuidSchema = z.uuid();
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const RevisionReferenceSchema = z
  .object({ id: UuidSchema, revision: z.number().int().positive() })
  .strict();
const MetaSchema = z
  .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
  .strict();

export const StartContentPlanRequestSchema = z
  .object({
    profile: RevisionReferenceSchema,
    offering: RevisionReferenceSchema,
    promptSetId: UuidSchema,
    promptRevisionId: UuidSchema,
    primaryClaimRevisionIds: z.array(UuidSchema).max(50),
    comparisonClaimRevisionIds: z.array(UuidSchema).max(50),
    baselineId: UuidSchema,
    methodPolicyVersion: z.literal('content-plan-v1'),
    idempotencyKey: z.string().trim().min(1).max(160),
    estimatedUnits: z
      .number()
      .int()
      .positive()
      .max(1_000_000)
      .optional()
      .describe(
        'Deprecated client estimate; accepted for compatibility and ignored by the server.',
      ),
  })
  .strict();

export const ContentPlanInputSnapshotSchema = z
  .object({
    profile: RevisionReferenceSchema,
    offering: RevisionReferenceSchema,
    promptSetId: UuidSchema,
    promptRevisionId: UuidSchema,
    primaryClaimRevisionIds: z.array(UuidSchema),
    comparisonClaimRevisionIds: z.array(UuidSchema),
    baselineId: UuidSchema,
    methodPolicyVersion: z.string(),
    profileRevisionId: UuidSchema,
    offeringRevisionId: UuidSchema,
    promptIds: z.array(UuidSchema),
    primaryEvidenceSnapshotIds: z.array(UuidSchema),
    comparisonEvidenceSnapshotIds: z.array(UuidSchema),
    availableClaimRevisionIds: z.array(UuidSchema),
    availableSourceArtifactIds: z.array(UuidSchema),
    comparisonEvidenceIndependent: z.boolean(),
  })
  .strict();

export const ContentPlanSchema = z
  .object({
    id: UuidSchema,
    tenantId: UuidSchema,
    workspaceId: UuidSchema,
    jobId: UuidSchema.nullable(),
    status: z.enum(['PENDING', 'READY', 'INVALID']),
    methodPolicyVersion: z.string(),
    inputSnapshot: ContentPlanInputSnapshotSchema,
    contentHash: HashSchema.nullable(),
    createdByUserId: UuidSchema,
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const OpportunitySchema = z
  .object({
    id: UuidSchema,
    contentPlanId: UuidSchema,
    key: z.enum(['DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE']),
    assetKind: z.enum(['DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE']),
    businessValue: z.number().min(0).max(100),
    evidenceReadiness: z.number().min(0).max(100),
    visibilityGap: z.object({ status: z.literal('UNKNOWN'), reason: z.string().min(1) }).strict(),
    effort: z.number().min(0).max(100),
    risk: z.number().min(0).max(100),
    priorityScore: z.number(),
    rank: z.number().int().positive(),
    rankReason: z.string().min(1),
    action: z.enum(['BRIEF', 'EVIDENCE_TASK']),
    evidenceReady: z.boolean(),
    publishReady: z.literal(false),
  })
  .strict();

export const BriefSchema = z
  .object({
    id: UuidSchema,
    contentPlanId: UuidSchema,
    opportunityId: UuidSchema,
    key: z.enum(['DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE']),
    assetKind: z.enum(['DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE']),
    title: z.string().min(1),
    promptIds: z.array(UuidSchema).min(1),
    claimRevisionIds: z.array(UuidSchema).min(1),
    sourceArtifactIds: z.array(UuidSchema).min(1),
    status: z.enum(['REVIEW_REQUIRED', 'APPROVED', 'REJECTED']),
    evidenceReady: z.literal(true),
    publishReady: z.literal(false),
    contentHash: HashSchema,
    createdByUserId: UuidSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export const BriefReviewSchema = z
  .object({
    id: UuidSchema,
    briefId: UuidSchema,
    decision: z.enum(['APPROVE', 'REJECT']),
    contentHash: HashSchema,
    reviewedByUserId: UuidSchema,
    note: z.string().min(1).max(2000),
    reviewedAt: z.iso.datetime(),
  })
  .strict();

export const ReviewBriefRequestSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    expectedContentHash: HashSchema,
    note: z.string().trim().min(1).max(2000),
  })
  .strict();

export const EvidenceTaskSchema = z
  .object({
    id: UuidSchema,
    contentPlanId: UuidSchema,
    opportunityId: UuidSchema,
    key: z.enum(['DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE']),
    assetKind: z.enum(['DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE']),
    reasonCode: z.enum([
      'PRIMARY_CLAIM_EVIDENCE_REQUIRED',
      'INDEPENDENT_COMPARISON_EVIDENCE_REQUIRED',
    ]),
    detail: z.string().min(1),
  })
  .strict();

export const ContentPlanBundleSchema = z
  .object({
    plan: ContentPlanSchema,
    opportunities: z.array(OpportunitySchema),
    briefs: z.array(BriefSchema),
    briefReviews: z.array(BriefReviewSchema),
    evidenceTasks: z.array(EvidenceTaskSchema),
  })
  .strict();

export const StartContentPlanEnvelopeSchema = z
  .object({
    data: z.object({ plan: ContentPlanSchema, job: JobSchema }).strict(),
    meta: MetaSchema,
  })
  .strict();

export const ContentPlanBundleEnvelopeSchema = z
  .object({ data: ContentPlanBundleSchema, meta: MetaSchema })
  .strict();

export const BriefReviewEnvelopeSchema = z
  .object({
    data: z.object({ brief: BriefSchema, review: BriefReviewSchema }).strict(),
    meta: MetaSchema,
  })
  .strict();

export const ApprovedBriefListEnvelopeSchema = z
  .object({
    data: z
      .object({
        briefs: z.array(
          z
            .object({
              briefId: UuidSchema,
              planId: UuidSchema,
              assetKind: z.string(),
              title: z.string(),
              contentHash: HashSchema,
              status: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
    meta: MetaSchema,
  })
  .strict();

export type StartContentPlanRequest = z.infer<typeof StartContentPlanRequestSchema>;
export type StartContentPlanEnvelope = z.infer<typeof StartContentPlanEnvelopeSchema>;
export type ContentPlanBundleEnvelope = z.infer<typeof ContentPlanBundleEnvelopeSchema>;
export type ReviewBriefRequest = z.infer<typeof ReviewBriefRequestSchema>;
export type BriefReviewEnvelope = z.infer<typeof BriefReviewEnvelopeSchema>;
export type ApprovedBriefListEnvelope = z.infer<typeof ApprovedBriefListEnvelopeSchema>;
