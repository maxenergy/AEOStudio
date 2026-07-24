import { z } from 'zod';

import { SCHEMA_VERSION } from '../auth/auth.contracts.js';

export const CreateSiteRequestSchema = z
  .object({
    profileId: z.uuid(),
    origin: z.url().max(2048),
  })
  .strict();

export const StartCrawlRequestSchema = z
  .object({ idempotencyKey: z.string().trim().min(1).max(160) })
  .strict();

export const CreateSiteVerificationRequestSchema = z
  .object({ method: z.enum(['DNS', 'FILE', 'OAUTH', 'ADMIN']) })
  .strict();

export const CompleteSiteVerificationRequestSchema = z.object({}).strict();

export const SiteSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    profileId: z.uuid(),
    origin: z.url(),
    hostname: z.string().min(1).max(253),
    status: z.enum(['UNVERIFIED', 'VERIFIED']),
    verifiedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const SiteEnvelopeSchema = z
  .object({
    data: z.object({ site: SiteSchema }).strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const SiteVerificationSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    siteId: z.uuid(),
    method: z.enum(['DNS', 'FILE', 'OAUTH', 'ADMIN']),
    challengeToken: z.string().min(1),
    challengePath: z.string().nullable(),
    status: z.enum(['PENDING', 'VERIFIED']),
    verifiedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const SiteVerificationEnvelopeSchema = z
  .object({
    data: z.object({ verification: SiteVerificationSchema }).strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const CrawlSnapshotSchema = z
  .object({
    id: z.uuid(),
    url: z.url().max(2048),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    contentType: z.string().min(1).max(255),
    sizeBytes: z.number().int().nonnegative().max(2_147_483_648),
    capturedAt: z.iso.datetime(),
    objectRef: z.string().min(1).max(2048),
  })
  .strict();

export const BaselineFindingSchema = z
  .object({
    id: z.uuid(),
    snapshotId: z.uuid(),
    findingType: z.string().min(1).max(120),
    severity: z.enum(['INFO', 'WARNING', 'ERROR']),
    detail: z.string().min(1).max(4000),
  })
  .strict();

export const SiteBaselineSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    siteId: z.uuid(),
    jobId: z.uuid(),
    status: z.enum(['COMPLETE', 'PARTIAL', 'FAILED_TERMINAL']),
    errorCode: z.string().min(1).max(120).nullable(),
    pageCount: z.number().int().nonnegative().max(500),
    totalBytes: z.number().int().nonnegative().max(2_147_483_648),
    completedAt: z.iso.datetime(),
    snapshots: z.array(CrawlSnapshotSchema).max(502),
    findings: z.array(BaselineFindingSchema),
  })
  .strict()
  .superRefine((baseline, context) => {
    const snapshotIds = new Set(baseline.snapshots.map((snapshot) => snapshot.id));
    for (const [index, finding] of baseline.findings.entries()) {
      if (!snapshotIds.has(finding.snapshotId)) {
        context.addIssue({
          code: 'custom',
          message: 'Finding must reference an exact snapshot in this baseline.',
          path: ['findings', index, 'snapshotId'],
        });
      }
    }
  });

export const SiteBaselineEnvelopeSchema = z
  .object({
    data: z.object({ baseline: SiteBaselineSchema }).strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const SiteBaselineListEnvelopeSchema = z
  .object({
    data: z
      .object({
        baselines: z.array(
          z
            .object({
              id: z.uuid(),
              siteId: z.uuid(),
              status: z.enum(['COMPLETE', 'PARTIAL', 'FAILED_TERMINAL']),
              pageCount: z.number().int().min(0),
              completedAt: z.string(),
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

export type SiteEnvelope = z.infer<typeof SiteEnvelopeSchema>;
export type SiteVerificationEnvelope = z.infer<typeof SiteVerificationEnvelopeSchema>;
export type SiteBaselineEnvelope = z.infer<typeof SiteBaselineEnvelopeSchema>;
export type SiteBaselineListEnvelope = z.infer<typeof SiteBaselineListEnvelopeSchema>;
