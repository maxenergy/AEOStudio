import { z } from 'zod';

import { SCHEMA_VERSION } from '../auth/auth.contracts.js';

export const CreateEvidenceSourceRequestSchema = z
  .object({
    sourceType: z.enum(['UPLOAD', 'CRAWL', 'PUBLIC']),
    title: z.string().trim().min(1).max(240),
    uri: z.url().max(2048).nullable(),
    license: z.string().trim().min(1).max(240),
    publicity: z.enum(['PRIVATE', 'PUBLIC', 'RESTRICTED']),
  })
  .strict();

export const EvidenceSourceSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    sourceType: z.enum(['UPLOAD', 'CRAWL', 'PUBLIC']),
    title: z.string().min(1).max(240),
    uri: z.url().max(2048).nullable(),
    license: z.string().min(1).max(240),
    publicity: z.enum(['PRIVATE', 'PUBLIC', 'RESTRICTED']),
    currentSnapshotId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const EvidenceSourceEnvelopeSchema = z
  .object({
    data: z.object({ source: EvidenceSourceSchema }).strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const CreateEvidenceSnapshotRequestSchema = z
  .object({
    contentBase64: z
      .string()
      .min(4)
      .max(13_981_016)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    contentType: z.string().trim().min(1).max(255),
  })
  .strict();

export const EvidenceSnapshotSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    sourceId: z.uuid(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    objectRef: z.string().min(1).max(2048),
    objectVersionId: z.string().min(1).max(1024),
    contentType: z.string().min(1).max(255),
    sizeBytes: z.number().int().positive().max(2_147_483_648),
    capturedAt: z.iso.datetime(),
  })
  .strict();

export const EvidenceSnapshotEnvelopeSchema = z
  .object({
    data: z.object({ snapshot: EvidenceSnapshotSchema, source: EvidenceSourceSchema }).strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const ClaimEvidenceInputSchema = z
  .object({
    snapshotId: z.uuid(),
    snippet: z.string().trim().min(1).max(4000).nullable(),
  })
  .strict();

export const CreateClaimRequestSchema = z
  .object({
    statement: z.string().trim().min(1).max(4000),
    numericValue: z.number().finite().nullable(),
    unit: z.string().trim().min(1).max(80).nullable(),
    scope: z.string().trim().min(1).max(1000).nullable(),
    conditions: z.array(z.string().trim().min(1).max(1000)).max(50),
    expiresAt: z.iso.datetime().nullable(),
    evidence: z.array(ClaimEvidenceInputSchema).max(50),
  })
  .strict();

export const ClaimEvidenceLinkSchema = z
  .object({
    id: z.uuid(),
    snapshotId: z.uuid(),
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    snippet: z.string().min(1).max(4000).nullable(),
  })
  .strict();

export const ClaimSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    currentRevision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const ClaimRevisionSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    claimId: z.uuid(),
    revision: z.number().int().positive(),
    statement: z.string().min(1).max(4000),
    numericValue: z.number().finite().nullable(),
    unit: z.string().min(1).max(80).nullable(),
    scope: z.string().min(1).max(1000).nullable(),
    conditions: z.array(z.string().min(1).max(1000)).max(50),
    expiresAt: z.iso.datetime().nullable(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['NEEDS_EVIDENCE', 'DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'STALE']),
    createdByUserId: z.uuid(),
    createdAt: z.iso.datetime(),
    evidence: z.array(ClaimEvidenceLinkSchema).max(50),
  })
  .strict();

export const ClaimEnvelopeSchema = z
  .object({
    data: z.object({ claim: ClaimSchema, revision: ClaimRevisionSchema }).strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const SubmitClaimRequestSchema = z.object({}).strict();

export const ReviewClaimRequestSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().trim().min(1).max(2000),
  })
  .strict();

export const ClaimReviewSchema = z
  .object({
    id: z.uuid(),
    claimRevisionId: z.uuid(),
    decision: z.enum(['APPROVE', 'REJECT']),
    reviewerUserId: z.uuid(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    note: z.string().min(1).max(2000),
    reviewedAt: z.iso.datetime(),
  })
  .strict();

export const ClaimReviewEnvelopeSchema = z
  .object({
    data: z
      .object({ claim: ClaimSchema, revision: ClaimRevisionSchema, review: ClaimReviewSchema })
      .strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const ClaimEvidenceDrillDownSchema = z
  .object({
    source: EvidenceSourceSchema,
    snapshot: EvidenceSnapshotSchema,
    link: ClaimEvidenceLinkSchema,
  })
  .strict();

export const ClaimEvidenceDrillDownEnvelopeSchema = z
  .object({
    data: z.object({ evidence: z.array(ClaimEvidenceDrillDownSchema).min(1) }).strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const ClaimCurrentStateEnvelopeSchema = z
  .object({
    data: z
      .object({
        claim: ClaimSchema,
        revision: ClaimRevisionSchema,
        currentUsable: z.boolean(),
        staleReasons: z.array(z.enum(['SOURCE_CHANGED', 'EXPIRED', 'NOT_APPROVED'])),
        reviewRequired: z.boolean(),
      })
      .strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const ApprovedClaimListEnvelopeSchema = z
  .object({
    data: z
      .object({
        claims: z.array(
          z
            .object({
              claimId: z.uuid(),
              revisionId: z.uuid(),
              revision: z.number().int().positive(),
              statement: z.string(),
              contentHash: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
        ),
      })
      .strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export type EvidenceSourceEnvelope = z.infer<typeof EvidenceSourceEnvelopeSchema>;
export type EvidenceSnapshotEnvelope = z.infer<typeof EvidenceSnapshotEnvelopeSchema>;
export type ClaimEnvelope = z.infer<typeof ClaimEnvelopeSchema>;
export type ClaimReviewEnvelope = z.infer<typeof ClaimReviewEnvelopeSchema>;
export type ClaimEvidenceDrillDownEnvelope = z.infer<typeof ClaimEvidenceDrillDownEnvelopeSchema>;
export type ClaimCurrentStateEnvelope = z.infer<typeof ClaimCurrentStateEnvelopeSchema>;
export type ApprovedClaimListEnvelope = z.infer<typeof ApprovedClaimListEnvelopeSchema>;
