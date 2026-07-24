import { z } from 'zod';

import { SCHEMA_VERSION } from '../auth/auth.contracts.js';
import { JobSchema } from '../jobs-budgets/jobs-budgets.contracts.js';
import {
  SignedWebhookKeyIdSchema,
  SignedWebhookSigningAlgorithmSchema,
} from './signed-webhook-target.contracts.js';

const UuidSchema = z.uuid();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const RemoteStateStatusSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const RollbackHandleKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const RollbackHandleStringSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !hasControlCharacter(value), 'control characters forbidden');
const RollbackHandleSchema = z
  .record(
    RollbackHandleKeySchema,
    z.union([RollbackHandleStringSchema, z.number().int().safe().nonnegative(), z.boolean()]),
  )
  .superRefine((value, context) => {
    const keyCount = Object.keys(value).length;
    if (keyCount < 1 || keyCount > 16) {
      context.addIssue({
        code: 'custom',
        message: 'rollback handle must contain between 1 and 16 entries',
      });
    }
  });

const ReceiptEvidenceTextSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !hasControlCharacter(value), 'control characters forbidden');

export const SignedWebhookReceiptEvidenceSchema = z
  .object({
    schemaVersion: z.literal('signed-webhook-receipt-evidence.v1'),
    receiptId: ReceiptEvidenceTextSchema,
    deliveryId: UuidSchema,
    receiverEffectId: ReceiptEvidenceTextSchema,
    requestBodySha256: Sha256Schema,
    verifiedKeyId: SignedWebhookKeyIdSchema,
    verifiedAlgorithm: SignedWebhookSigningAlgorithmSchema,
    receivedAt: z.iso.datetime({ offset: true }).max(35),
  })
  .strict();

export const PublicationRemoteStateSchema = z
  .object({
    status: RemoteStateStatusSchema,
    number: z.number().int().safe().positive().nullable(),
    isProductionLive: z.boolean(),
    rollbackHandle: RollbackHandleSchema.nullable(),
    receiptEvidence: SignedWebhookReceiptEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.receiptEvidence !== undefined &&
      (value.status !== 'DELIVERED' ||
        value.number !== null ||
        value.isProductionLive ||
        value.rollbackHandle !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'receipt evidence requires an immutable non-live DELIVERED state',
        path: ['receiptEvidence'],
      });
    }
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 4_096,
    'remote state is too large',
  );
const PublicationEligibilityReasonCodeSchema = z.enum([
  'AUTHORIZATION_MISSING',
  'AUTHORIZATION_EXPIRED',
  'AUTHORIZATION_REVOKED',
  'AUTHORIZATION_VALIDATION_PENDING',
  'AUTHORIZATION_VALIDATION_INVALID',
  'AUTHORIZATION_VALIDATION_STALE',
  'AUTHORIZATION_VALIDATED_TARGET_MISMATCH',
  'AUTHORIZATION_VALIDATED_SCOPE_INSUFFICIENT',
  'AUTHORIZATION_VALIDATED_TERMS_MISMATCH',
  'ADAPTER_NOT_FOUND',
  'ADAPTER_DISABLED',
  'ADAPTER_RUNTIME_UNAVAILABLE',
  'ADAPTER_RUNTIME_METADATA_MISMATCH',
  'ADAPTER_PROVIDER_API_VERSION_EXPIRED',
  'CHANNEL_UNAVAILABLE',
  'PUBLISH_CAPABILITY_MISSING',
  'RECONCILE_CAPABILITY_MISSING',
  'TERMS_NOT_APPROVED',
  'AUTHORIZATION_SCOPE_INSUFFICIENT',
]);

export const RequestPublicationSchema = z
  .object({
    channelPackageId: UuidSchema,
    adapterVersionId: UuidSchema.optional(),
    target: z.string().trim().min(1).max(2_048),
    expectedPackageChecksum: Sha256Schema,
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

/** A read-only eligibility probe. Command-only idempotency and budget fields are excluded. */
export const CheckPublicationEligibilitySchema = z
  .object({
    channelPackageId: UuidSchema,
    adapterVersionId: UuidSchema.optional(),
    target: z.string().trim().min(1).max(2_048),
    expectedPackageChecksum: Sha256Schema,
  })
  .strict();

export const PublicationEligibilityReasonSchema = z
  .object({
    code: PublicationEligibilityReasonCodeSchema,
    detail: z.string().min(1).max(500),
  })
  .strict();

export const ExportOnlyPublicationProblemSchema = z
  .object({
    type: z.string().url(),
    title: z.string().min(1),
    status: z.literal(409),
    code: z.literal('EXPORT_ONLY'),
    detail: z.string().min(1),
    requestId: z.string().min(1),
    retryable: z.literal(false),
    eligibility: z
      .object({
        mode: z.literal('EXPORT_ONLY'),
        packageId: UuidSchema,
        packageChecksum: Sha256Schema,
        reasons: z.array(PublicationEligibilityReasonSchema).min(1),
      })
      .strict(),
    export: z
      .object({
        href: z.string().startsWith('/api/v1/'),
        packageChecksum: Sha256Schema,
      })
      .strict(),
  })
  .strict();

export const PublicationRecordSchema = z
  .object({
    id: UuidSchema,
    status: z.enum([
      'REQUESTED',
      'BUDGET_BLOCKED',
      'QUEUED',
      'RUNNING',
      'RETRY_WAIT',
      'AMBIGUOUS',
      'RECONCILE_REQUIRED',
      'RECONCILING',
      'MANUAL_REVIEW_REQUIRED',
      'REMOTE_APPLIED',
      'PUBLISHED',
      'FAILED_TERMINAL',
      'ROLLBACK_QUEUED',
      'ROLLED_BACK',
      'ROLLBACK_FAILED',
    ]),
    channelPackageId: UuidSchema,
    packageChecksum: Sha256Schema,
    artifactRevisionId: UuidSchema,
    artifactContentHash: Sha256Schema,
    adapterVersionId: UuidSchema,
    channelAuthorizationId: UuidSchema,
    target: z.string().min(1).max(2_048),
    idempotencyKey: z.string().min(1).max(200),
    remoteRef: z.string().min(1).max(2_048).nullable(),
    remoteState: PublicationRemoteStateSchema.nullable().optional(),
    requestedByUserId: UuidSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === 'REMOTE_APPLIED' &&
      (value.remoteRef === null ||
        value.remoteState === null ||
        value.remoteState === undefined ||
        value.remoteState.isProductionLive)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'REMOTE_APPLIED requires a durable non-live remote effect',
        path: ['remoteState'],
      });
    }
    if (
      value.status === 'PUBLISHED' &&
      value.remoteState !== null &&
      value.remoteState !== undefined &&
      !value.remoteState.isProductionLive
    ) {
      context.addIssue({
        code: 'custom',
        message: 'PUBLISHED remote state must be production-live',
        path: ['remoteState'],
      });
    }
  });

export const PublicationAttemptRecordSchema = z
  .object({
    id: UuidSchema,
    publicationId: UuidSchema,
    attemptNumber: z.number().int().positive(),
    operation: z.enum(['PUBLISH', 'RECONCILE', 'ROLLBACK']),
    outcome: z.enum([
      'STARTED',
      'APPLIED',
      'AMBIGUOUS',
      'DEFINITELY_NOT_APPLIED',
      'RETRYABLE_FAILURE',
      'TERMINAL_FAILURE',
      'UNKNOWN',
      'ROLLED_BACK',
      'ROLLBACK_FAILED',
    ]),
    remoteRef: z.string().min(1).max(2_048).nullable(),
    errorCode: z.string().min(1).max(160).nullable(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .strict();

const PublicationExportSchema = z
  .object({
    href: z.string().startsWith('/api/v1/'),
    packageChecksum: Sha256Schema,
  })
  .strict();

export const PublicationEligibilityEnvelopeSchema = z
  .object({
    data: z
      .object({
        eligibility: z.discriminatedUnion('mode', [
          z
            .object({
              mode: z.literal('PUBLISH_READY'),
              packageId: UuidSchema,
              packageChecksum: Sha256Schema,
              adapterVersionId: UuidSchema,
              channelAuthorizationId: UuidSchema,
            })
            .strict(),
          z
            .object({
              mode: z.literal('EXPORT_ONLY'),
              packageId: UuidSchema,
              packageChecksum: Sha256Schema,
              reasons: z.array(PublicationEligibilityReasonSchema).min(1),
            })
            .strict(),
        ]),
        export: PublicationExportSchema,
      })
      .strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const PublicationDetailEnvelopeSchema = z
  .object({
    data: z
      .object({
        publication: PublicationRecordSchema,
        attempts: z.array(PublicationAttemptRecordSchema),
        job: JobSchema,
      })
      .strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const PublicationCommandEnvelopeSchema = z
  .object({
    data: z
      .object({
        publication: PublicationRecordSchema,
        job: JobSchema,
        created: z.boolean(),
      })
      .strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const PublicationRemoteStatusRefreshEnvelopeSchema = z
  .object({
    data: z.object({ publication: PublicationRecordSchema }).strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export type RequestPublication = z.infer<typeof RequestPublicationSchema>;
export type CheckPublicationEligibility = z.infer<typeof CheckPublicationEligibilitySchema>;
export type ExportOnlyPublicationProblem = z.infer<typeof ExportOnlyPublicationProblemSchema>;
export type PublicationCommandEnvelope = z.infer<typeof PublicationCommandEnvelopeSchema>;
export type PublicationEligibilityEnvelope = z.infer<typeof PublicationEligibilityEnvelopeSchema>;
export type PublicationDetailEnvelope = z.infer<typeof PublicationDetailEnvelopeSchema>;
export type PublicationRemoteStatusRefreshEnvelope = z.infer<
  typeof PublicationRemoteStatusRefreshEnvelopeSchema
>;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}
