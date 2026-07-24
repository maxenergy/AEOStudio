import { z } from 'zod';

import { SCHEMA_VERSION } from '../auth/auth.contracts.js';
import { JobSchema } from '../jobs-budgets/jobs-budgets.contracts.js';

const UuidSchema = z.uuid();
const MetaSchema = z
  .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
  .strict();

export const StartArtifactGenerationRequestSchema = z
  .object({
    briefId: UuidSchema,
    locale: z.string().trim().min(2).max(35),
    market: z.string().trim().min(1).max(120),
    methodPolicyVersion: z.literal('artifact-fixture-v1'),
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

export const ArtifactSchema = z
  .object({
    id: UuidSchema,
    tenantId: UuidSchema,
    workspaceId: UuidSchema,
    briefId: UuidSchema,
    type: z.enum(['DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE']),
    revision: z.number().int().positive(),
    status: z.enum(['PENDING', 'DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'STALE']),
    locale: z.string().min(2),
    market: z.string().min(1),
    methodPolicyVersion: z.string().min(1),
    jobId: UuidSchema.nullable(),
    createdByUserId: UuidSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export const StartArtifactGenerationEnvelopeSchema = z
  .object({
    data: z.object({ artifact: ArtifactSchema, job: JobSchema }).strict(),
    meta: MetaSchema,
  })
  .strict();

const ArtifactEvidenceBindingSchema = z
  .object({
    sourceId: UuidSchema,
    snapshotId: UuidSchema,
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const ArtifactClaimBindingSchema = z
  .object({
    claimId: UuidSchema,
    claimRevisionId: UuidSchema,
    claimContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    claimStatement: z.string().min(1),
    evidence: z.array(ArtifactEvidenceBindingSchema).min(1),
  })
  .strict();
const ArtifactSourceReferenceSchema = z
  .object({
    kind: z.enum(['PROFILE_REVISION', 'OFFERING_REVISION', 'PROMPT_REVISION', 'SITE_BASELINE']),
    id: UuidSchema,
    aggregateId: UuidSchema,
    revision: z.number().int().positive().nullable(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
const ArtifactLineageSchema = z
  .object({
    contentPlanId: UuidSchema,
    brief: z.object({ id: UuidSchema, contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    prompt: z
      .object({
        promptSetId: UuidSchema,
        promptRevisionId: UuidSchema,
        contentHash: z.string().regex(/^[a-f0-9]{64}$/),
        promptIds: z.array(UuidSchema).min(1),
      })
      .strict(),
    sourceReferences: z.array(ArtifactSourceReferenceSchema).length(4),
  })
  .strict();
export const ArtifactRevisionSchema = z
  .object({
    id: UuidSchema,
    artifactId: UuidSchema,
    revision: z.number().int().positive(),
    briefId: UuidSchema,
    type: z.enum(['DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE']),
    schemaVersion: z.literal('1.0.0'),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'STALE']),
    locale: z.string().min(2),
    market: z.string().min(1),
    sourceArtifactIds: z.array(UuidSchema).min(1),
    lineage: ArtifactLineageSchema,
    claimBindings: z.array(ArtifactClaimBindingSchema).min(1),
    methodPolicyVersion: z.string().min(1),
    createdByActor: z.object({ kind: z.enum(['USER', 'AGENT']), id: UuidSchema }).strict(),
    createdAt: z.iso.datetime(),
    payloadObjectRef: z.string().startsWith('s3://'),
  })
  .strict();
export const ArtifactPayloadSchema = z
  .object({
    title: z.string().min(1),
    summary: z.string().min(1),
    sections: z.array(z.object({ heading: z.string().min(1), body: z.string().min(1) }).strict()),
    claimMap: z.array(
      z
        .object({
          claimRevisionId: UuidSchema,
          statement: z.string().min(1),
          evidenceSourceIds: z.array(UuidSchema).min(1),
        })
        .strict(),
    ),
    disclosure: z.string().min(1),
  })
  .strict();
export const CreateArtifactRevisionRequestSchema = z
  .object({ expectedRevision: z.number().int().positive(), payload: ArtifactPayloadSchema })
  .strict();
export const SubmitArtifactRevisionRequestSchema = z
  .object({ expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const ReviewArtifactRevisionRequestSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    note: z.string().trim().min(1).max(2_000),
  })
  .strict();
export const CreateArtifactRevisionEnvelopeSchema = z
  .object({
    data: z.object({ artifact: ArtifactSchema, revision: ArtifactRevisionSchema }).strict(),
    meta: MetaSchema,
  })
  .strict();

export const SubmitArtifactRevisionEnvelopeSchema = z
  .object({
    data: z.object({ revision: ArtifactRevisionSchema }).strict(),
    meta: MetaSchema,
  })
  .strict();

export const ArtifactReviewSchema = z
  .object({
    id: UuidSchema,
    artifactId: UuidSchema,
    artifactRevisionId: UuidSchema,
    revision: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['APPROVE', 'REJECT']),
    reviewerUserId: UuidSchema,
    note: z.string(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const ReviewArtifactRevisionEnvelopeSchema = z
  .object({
    data: z.object({ revision: ArtifactRevisionSchema, review: ArtifactReviewSchema }).strict(),
    meta: MetaSchema,
  })
  .strict();

export const ArtifactBundleEnvelopeSchema = z
  .object({
    data: z
      .object({
        artifact: ArtifactSchema,
        revision: ArtifactRevisionSchema.nullable(),
        payload: ArtifactPayloadSchema.nullable(),
        previousPayload: ArtifactPayloadSchema.nullable(),
        revisions: z.array(ArtifactRevisionSchema),
        reviews: z.array(ArtifactReviewSchema),
        approvalState: z.enum(['ELIGIBLE', 'APPROVAL_REQUIRED', 'APPROVAL_STALE']),
        selectableApprovedRevisions: z.array(
          z
            .object({
              revision: z.number().int().positive(),
              contentHash: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
        ),
      })
      .strict(),
    meta: MetaSchema,
  })
  .strict();

export type StartArtifactGenerationRequest = z.infer<typeof StartArtifactGenerationRequestSchema>;
export type StartArtifactGenerationEnvelope = z.infer<typeof StartArtifactGenerationEnvelopeSchema>;
export type ArtifactBundleEnvelope = z.infer<typeof ArtifactBundleEnvelopeSchema>;
export type CreateArtifactRevisionRequest = z.infer<typeof CreateArtifactRevisionRequestSchema>;
