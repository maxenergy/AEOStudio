import { z } from 'zod';

import {
  ChannelPackageArtifactSchema,
  ChannelPackageManifestSchema,
} from './channel-package.contracts.js';
import {
  SignedWebhookKeyIdSchema,
  SignedWebhookSigningAlgorithmSchema,
  SignedWebhookUrlSchema,
} from './signed-webhook-target.contracts.js';

export * from './signed-webhook-target.contracts.js';

const UuidSchema = z.uuid();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const DeliveredChannelPackageSchema = z
  .object({
    tenantId: UuidSchema,
    workspaceId: UuidSchema,
    id: UuidSchema,
    packageRevision: z.number().int().positive(),
    packageChecksum: Sha256Schema,
    packageSchemaVersion: z.string().min(1).max(80),
    channel: z
      .object({ definitionId: UuidSchema, channelKey: z.string().min(1).max(160) })
      .strict(),
    transformer: z
      .object({ key: z.string().min(1).max(160), version: z.string().min(1).max(80) })
      .strict(),
    artifact: ChannelPackageArtifactSchema,
    manifest: ChannelPackageManifestSchema,
    files: z
      .object({
        'content.md': z.string().min(1),
        'content.html': z.string().min(1),
        'structured-data.json': z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const SignedWebhookDeliveryV1Schema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    eventType: z.literal('channel-package.approved.v1'),
    deliveryId: UuidSchema,
    publicationId: UuidSchema,
    channelPackage: DeliveredChannelPackageSchema,
  })
  .strict()
  .refine(
    ({ deliveryId, publicationId }) => deliveryId === publicationId,
    'delivery ID must be stable publication ID',
  );

export const SignedWebhookReceiptQueryV1Schema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    queryType: z.literal('channel-package.delivery-receipt.v1'),
    deliveryId: UuidSchema,
    publicationId: UuidSchema,
    channelPackageId: UuidSchema,
    packageRevision: z.number().int().positive(),
    packageChecksum: Sha256Schema,
    artifactRevisionId: UuidSchema,
    artifactContentHash: Sha256Schema,
    requestBodySha256: Sha256Schema,
  })
  .strict()
  .refine(
    ({ deliveryId, publicationId }) => deliveryId === publicationId,
    'delivery ID must match publication ID',
  );

export const SignedWebhookReceiptV1Schema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    receiptType: z.literal('channel-package.delivery-receipt.v1'),
    receiptId: z.string().min(1).max(500),
    status: z.enum(['APPLIED', 'ALREADY_APPLIED', 'PENDING', 'NOT_FOUND', 'CONFLICT']),
    deliveryId: UuidSchema,
    publicationId: UuidSchema,
    channelPackageId: UuidSchema,
    packageRevision: z.number().int().positive(),
    packageChecksum: Sha256Schema,
    artifactRevisionId: UuidSchema,
    artifactContentHash: Sha256Schema,
    requestBodySha256: Sha256Schema,
    receiverEffectId: z.string().min(1).max(500).nullable(),
    verifiedKeyId: SignedWebhookKeyIdSchema,
    verifiedAlgorithm: SignedWebhookSigningAlgorithmSchema,
    receivedAt: z.iso.datetime({ offset: true }),
    remoteRef: SignedWebhookUrlSchema,
    isProductionLive: z.literal(false),
  })
  .strict()
  .superRefine((receipt, context) => {
    const applied = receipt.status === 'APPLIED' || receipt.status === 'ALREADY_APPLIED';
    if (applied !== (receipt.receiverEffectId !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'only applied receipts may contain a receiver effect ID',
      });
    }
  });

export type SignedWebhookDeliveryV1 = z.infer<typeof SignedWebhookDeliveryV1Schema>;
export type SignedWebhookReceiptQueryV1 = z.infer<typeof SignedWebhookReceiptQueryV1Schema>;
export type SignedWebhookReceiptV1 = z.infer<typeof SignedWebhookReceiptV1Schema>;

export const SIGNED_WEBHOOK_DELIVERY_V1_JSON_SCHEMA = z.toJSONSchema(
  SignedWebhookDeliveryV1Schema,
  { target: 'draft-2020-12' },
);
export const SIGNED_WEBHOOK_RECEIPT_V1_JSON_SCHEMA = z.toJSONSchema(SignedWebhookReceiptV1Schema, {
  target: 'draft-2020-12',
});
export const SIGNED_WEBHOOK_RECEIPT_QUERY_V1_JSON_SCHEMA = z.toJSONSchema(
  SignedWebhookReceiptQueryV1Schema,
  { target: 'draft-2020-12' },
);
