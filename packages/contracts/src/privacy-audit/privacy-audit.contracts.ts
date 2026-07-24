import { z } from 'zod';

import { SCHEMA_VERSION } from '@aeostudio/contracts/auth';

export const TENANT_EXPORT_SCOPE_DISCLOSURE =
  'This export is limited to the requested Tenant and stated time range.' as const;
export const TENANT_EXPORT_INTEGRITY_DISCLOSURE =
  'Hashes support integrity checks but are not legal certification of completeness.' as const;
export const TENANT_EXPORT_NO_GUARANTEE_DISCLOSURE =
  'This point-in-time export is not a guarantee of future ranking, citation, traffic, or business outcomes.' as const;

const UuidSchema = z.uuid();
const InstantSchema = z.iso.datetime();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const BoundedTextSchema = z.string().trim().min(1).max(1_000);
const ActionSchema = z.string().trim().min(1).max(160);
const ResourceTypeSchema = z.string().trim().min(1).max(160);
const ResourceIdSchema = z.string().trim().min(1).max(500);
export const MAX_BREAK_GLASS_TTL_MS = 24 * 60 * 60 * 1_000;
const ObjectKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((value) => !value.includes('..') && !value.startsWith('/'), {
    message: 'Object keys must be relative and cannot traverse directories.',
  });

export const PrivacyTimeRangeSchema = z
  .object({ from: InstantSchema, to: InstantSchema })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.from) > Date.parse(value.to)) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'The end of the time range must not precede its start.',
      });
    }
  });

export const TenantExportObjectKindSchema = z.enum([
  'PROFILE_REVISION',
  'OFFERING_REVISION',
  'CLAIM_REVISION',
  'ARTIFACT',
  'MEASUREMENT_RUN',
  'METRIC_SNAPSHOT',
  'PUBLICATION',
  'AUDIT_EVENT',
]);

export const TenantExportManifestObjectSchema = z
  .object({
    kind: TenantExportObjectKindSchema,
    objectId: z.string().trim().min(1).max(500),
    contentHash: Sha256Schema,
  })
  .strict();

export const TenantExportManifestFileSchema = z
  .object({
    path: ObjectKeySchema,
    contentHash: Sha256Schema,
    byteLength: z.number().int().nonnegative(),
    objectCount: z.number().int().positive(),
  })
  .strict();

export const TenantExportDisclosuresSchema = z
  .object({
    tenantScope: z.literal(TENANT_EXPORT_SCOPE_DISCLOSURE),
    integrity: z.literal(TENANT_EXPORT_INTEGRITY_DISCLOSURE),
    noGuarantee: z.literal(TENANT_EXPORT_NO_GUARANTEE_DISCLOSURE),
  })
  .strict();

export const TenantExportManifestSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    tenantId: UuidSchema,
    timeRange: PrivacyTimeRangeSchema,
    objects: z.array(TenantExportManifestObjectSchema),
    files: z.array(TenantExportManifestFileSchema),
    disclosures: TenantExportDisclosuresSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const objectKeys = value.objects.map(({ kind, objectId }) => `${kind}:${objectId}`);
    const sortedObjectKeys = [...objectKeys].sort((left, right) => left.localeCompare(right));
    if (new Set(objectKeys).size !== objectKeys.length) {
      context.addIssue({
        code: 'custom',
        path: ['objects'],
        message: 'Export objects must be unique.',
      });
    }
    if (objectKeys.some((key, index) => key !== sortedObjectKeys[index])) {
      context.addIssue({
        code: 'custom',
        path: ['objects'],
        message: 'Export objects must use deterministic kind and object ID ordering.',
      });
    }
    const filePaths = value.files.map(({ path }) => path);
    const sortedFilePaths = [...filePaths].sort((left, right) => left.localeCompare(right));
    if (new Set(filePaths).size !== filePaths.length) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'Export files must be unique.',
      });
    }
    if (filePaths.some((path, index) => path !== sortedFilePaths[index])) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'Export files must use deterministic path ordering.',
      });
    }
  });

export const TenantExportSchema = z
  .object({
    id: UuidSchema,
    manifest: TenantExportManifestSchema,
    checksum: Sha256Schema,
    archiveStatus: z.enum(['PENDING', 'READY', 'FAILED']),
    archiveReady: z.boolean(),
    objectRef: z.string().trim().min(1).max(2_048).nullable(),
    createdAt: InstantSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const ready = value.archiveStatus === 'READY';
    if (
      value.archiveReady !== ready ||
      (ready ? value.objectRef === null : value.objectRef !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['archiveReady'],
        message: 'Archive readiness, status and object reference must agree.',
      });
    }
  });

export const DeletionScopeSchema = z.enum(['TENANT', 'WORKSPACE']);
export const DeletionLifecycleStateSchema = z.enum([
  'FROZEN',
  'ACTIVE_DATA_DELETED',
  'BACKUP_DELETED',
  'TOMBSTONED',
  'BLOCKED_BY_LEGAL_HOLD',
]);

export const TenantDeletionReceiptSchema = z
  .object({
    id: UuidSchema,
    scope: DeletionScopeSchema,
    state: z.literal('FROZEN'),
    requestedAt: InstantSchema,
    activeDeleteBy: InstantSchema,
    backupDeleteBy: InstantSchema,
    secretForceDeleteBy: InstantSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const requestedAt = Date.parse(value.requestedAt);
    if (
      Date.parse(value.secretForceDeleteBy) !== requestedAt + 24 * 60 * 60 * 1_000 ||
      Date.parse(value.activeDeleteBy) !== requestedAt + 30 * 24 * 60 * 60 * 1_000 ||
      Date.parse(value.backupDeleteBy) !== requestedAt + 90 * 24 * 60 * 60 * 1_000
    ) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'Deletion receipt deadlines must preserve the 24-hour, 30-day and 90-day policy.',
      });
    }
  });

export const LegalHoldTargetSchema = z
  .object({ objectKey: ObjectKeySchema, objectVersionId: z.string().trim().min(1).max(500) })
  .strict();

export const TenantVisibleLegalHoldSchema = z
  .object({
    id: UuidSchema,
    tenantId: UuidSchema,
    name: z.string().trim().min(1).max(200),
    reason: BoundedTextSchema,
    createdBy: UuidSchema,
    visibleToTenant: z.literal(true),
    target: LegalHoldTargetSchema,
    createdAt: InstantSchema,
    releasedAt: InstantSchema.nullable(),
  })
  .strict();

export const BreakGlassGrantSchema = z
  .object({
    id: UuidSchema,
    tenantId: UuidSchema,
    workspaceId: UuidSchema,
    operatorId: UuidSchema,
    operatorName: z.string().trim().min(1).max(200),
    reason: BoundedTextSchema,
    auditEventId: UuidSchema,
    requestedAction: ActionSchema,
    resourceType: ResourceTypeSchema,
    resourceId: ResourceIdSchema,
    grantedAt: InstantSchema,
    expiresAt: InstantSchema,
    revokedAt: InstantSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const ttl = Date.parse(value.expiresAt) - Date.parse(value.grantedAt);
    if (ttl <= 0 || ttl > MAX_BREAK_GLASS_TTL_MS) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Break-glass expiry must follow grant time and cannot exceed 24 hours.',
      });
    }
  });

export const BreakGlassDecisionSchema = z
  .object({
    decision: z.enum(['ALLOW', 'DENY']),
    state: z.enum(['ACTIVE', 'NOT_YET_ACTIVE', 'EXPIRED', 'REVOKED', 'INVALID_GRANT']),
    grantId: UuidSchema.nullable(),
    operatorName: z.string().trim().min(1).max(200).nullable(),
    reason: BoundedTextSchema.nullable(),
    auditEventId: UuidSchema.nullable(),
  })
  .strict();

export const AuditActorKindSchema = z.enum([
  'USER',
  'AGENT',
  'SYSTEM',
  'SUPPORT',
  'PLATFORM_OPERATOR',
]);
export const AuditTimelineEventSchema = z
  .object({
    id: UuidSchema,
    tenantId: UuidSchema,
    workspaceId: UuidSchema.nullable(),
    sequence: z.number().int().positive(),
    previousHash: Sha256Schema.nullable(),
    eventHash: Sha256Schema,
    actorKind: AuditActorKindSchema,
    actorId: z.string().trim().min(1).max(500),
    action: z.string().trim().min(1).max(160),
    resourceType: z.string().trim().min(1).max(160),
    resourceId: z.string().trim().min(1).max(500).nullable(),
    outcome: z.string().trim().min(1).max(80),
    metadata: z.record(z.string(), z.unknown()),
    occurredAt: InstantSchema,
  })
  .strict();

export const AuditTimelineSchema = z
  .object({
    events: z.array(AuditTimelineEventSchema),
    nextCursor: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

export const AuditIntegrityVerificationSchema = z
  .object({
    valid: z.boolean(),
    eventCount: z.number().int().nonnegative(),
    lastSequence: z.number().int().nonnegative(),
    headHash: Sha256Schema.nullable(),
    reason: z.string().trim().min(1).max(1_000).nullable(),
  })
  .strict();

export const AuditDigestSchema = z
  .object({
    id: UuidSchema,
    tenantId: UuidSchema,
    schemaVersion: z.literal('audit-digest.v1'),
    timeRange: PrivacyTimeRangeSchema,
    eventCount: z.number().int().nonnegative(),
    lastSequence: z.number().int().nonnegative(),
    headHash: Sha256Schema.nullable(),
    digestHash: Sha256Schema,
    objectRef: z.string().trim().min(1).max(2_048),
    objectKey: ObjectKeySchema,
    objectVersionId: z.string().trim().min(1).max(500),
    lockedUntil: InstantSchema,
    sealedAt: InstantSchema,
  })
  .strict();

export const PrivacyOverviewSchema = z
  .object({
    tenantId: UuidSchema,
    lifecycleState: z.enum(['ACTIVE', 'FROZEN', 'DELETION_IN_PROGRESS', 'TOMBSTONED']),
    retention: z
      .object({
        activeTenantDataDays: z.literal(30),
        backupCopyDays: z.literal(90),
        secretForceDeleteHours: z.literal(24),
        rawEvidenceDays: z.literal(180),
        screenshotDays: z.literal(90),
        applicationLogDays: z.literal(30),
        auditEvidenceDays: z.literal(365),
      })
      .strict(),
    legalHolds: z.array(TenantVisibleLegalHoldSchema),
    breakGlassGrants: z.array(BreakGlassGrantSchema),
    latestAuditEventAt: InstantSchema.nullable(),
    latestDeletionReceipt: TenantDeletionReceiptSchema.nullable(),
  })
  .strict();

const PrivacyResponseMetaSchema = z
  .object({
    requestId: z.string().min(1),
    schemaVersion: z.literal(SCHEMA_VERSION),
  })
  .strict();

export const TenantDeletionReceiptEnvelopeSchema = z
  .object({
    data: z.object({ receipt: TenantDeletionReceiptSchema }).strict(),
    meta: PrivacyResponseMetaSchema,
  })
  .strict();

export const PrivacyOverviewEnvelopeSchema = z
  .object({
    data: z.object({ overview: PrivacyOverviewSchema }).strict(),
    meta: PrivacyResponseMetaSchema,
  })
  .strict();

export const AuditTimelineEnvelopeSchema = z
  .object({
    data: z.object({ timeline: AuditTimelineSchema }).strict(),
    meta: PrivacyResponseMetaSchema,
  })
  .strict();

export const TenantExportEnvelopeSchema = z
  .object({
    data: z.object({ export: TenantExportSchema }).strict(),
    meta: PrivacyResponseMetaSchema,
  })
  .strict();

export const LegalHoldListEnvelopeSchema = z
  .object({
    data: z.object({ holds: z.array(TenantVisibleLegalHoldSchema) }).strict(),
    meta: PrivacyResponseMetaSchema,
  })
  .strict();

export const LegalHoldEnvelopeSchema = z
  .object({
    data: z.object({ hold: TenantVisibleLegalHoldSchema }).strict(),
    meta: PrivacyResponseMetaSchema,
  })
  .strict();

export const AuditIntegrityResultSchema = z
  .object({
    outcome: z.enum(['SUCCEEDED', 'TAMPERED']),
    valid: z.boolean(),
    eventCount: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(1_000).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.outcome === 'SUCCEEDED' && (!value.valid || value.reason !== null)) ||
      (value.outcome === 'TAMPERED' && (value.valid || value.reason === null))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Audit integrity outcome, validity and reason must agree.',
      });
    }
  });

export const AuditIntegrityEnvelopeSchema = z
  .object({
    data: z.object({ verification: AuditIntegrityResultSchema }).strict(),
    meta: PrivacyResponseMetaSchema,
  })
  .strict();

export const AuditDigestEnvelopeSchema = z
  .object({
    data: z.object({ digest: AuditDigestSchema }).strict(),
    meta: PrivacyResponseMetaSchema,
  })
  .strict();

export const ExportTenantRequestSchema = z
  .object({ from: InstantSchema, to: InstantSchema })
  .strict()
  .and(PrivacyTimeRangeSchema);

export const RequestDeletionRequestSchema = z.object({ reason: BoundedTextSchema }).strict();

export const CreateLegalHoldRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    reason: BoundedTextSchema,
    objectKey: ObjectKeySchema,
    objectVersionId: z.string().trim().min(1).max(500),
  })
  .strict();

export const GrantBreakGlassRequestSchema = z
  .object({
    reason: BoundedTextSchema,
    expiresAt: InstantSchema,
    requestedAction: ActionSchema,
    resourceType: ResourceTypeSchema,
    resourceId: ResourceIdSchema,
  })
  .strict();

export type PrivacyTimeRange = z.infer<typeof PrivacyTimeRangeSchema>;
export type TenantExportManifestObject = z.infer<typeof TenantExportManifestObjectSchema>;
export type TenantExportManifestFile = z.infer<typeof TenantExportManifestFileSchema>;
export type TenantExportManifest = z.infer<typeof TenantExportManifestSchema>;
export type TenantExport = z.infer<typeof TenantExportSchema>;
export type DeletionScope = z.infer<typeof DeletionScopeSchema>;
export type DeletionLifecycleState = z.infer<typeof DeletionLifecycleStateSchema>;
export type TenantDeletionReceipt = z.infer<typeof TenantDeletionReceiptSchema>;
export type TenantVisibleLegalHold = z.infer<typeof TenantVisibleLegalHoldSchema>;
export type BreakGlassGrantRecord = z.infer<typeof BreakGlassGrantSchema>;
export type BreakGlassDecisionRecord = z.infer<typeof BreakGlassDecisionSchema>;
export type AuditTimelineEvent = z.infer<typeof AuditTimelineEventSchema>;
export type AuditTimeline = z.infer<typeof AuditTimelineSchema>;
export type AuditIntegrityVerification = z.infer<typeof AuditIntegrityVerificationSchema>;
export type AuditDigest = z.infer<typeof AuditDigestSchema>;
export type PrivacyOverview = z.infer<typeof PrivacyOverviewSchema>;
export type TenantDeletionReceiptEnvelope = z.infer<typeof TenantDeletionReceiptEnvelopeSchema>;
export type PrivacyOverviewEnvelope = z.infer<typeof PrivacyOverviewEnvelopeSchema>;
export type AuditTimelineEnvelope = z.infer<typeof AuditTimelineEnvelopeSchema>;
export type TenantExportEnvelope = z.infer<typeof TenantExportEnvelopeSchema>;
export type LegalHoldListEnvelope = z.infer<typeof LegalHoldListEnvelopeSchema>;
export type LegalHoldEnvelope = z.infer<typeof LegalHoldEnvelopeSchema>;
export type AuditIntegrityResult = z.infer<typeof AuditIntegrityResultSchema>;
export type AuditIntegrityEnvelope = z.infer<typeof AuditIntegrityEnvelopeSchema>;
export type AuditDigestEnvelope = z.infer<typeof AuditDigestEnvelopeSchema>;
