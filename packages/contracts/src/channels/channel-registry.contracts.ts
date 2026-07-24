import { z } from 'zod';

import { SCHEMA_VERSION } from '../auth/auth.contracts.js';

const UuidSchema = z.uuid();
const OpenMetadataSchema = z.record(z.string(), z.unknown());

export const ChannelAdapterVersionSchema = z
  .object({
    id: UuidSchema,
    adapterKey: z.string().trim().min(1).max(160),
    adapterVersion: z.string().trim().min(1).max(80),
    providerApiVersion: z.string().trim().min(1).max(80).optional(),
    providerApiSupportedUntil: z.iso.datetime({ offset: true }).optional(),
    enabled: z.boolean(),
    disabledReason: z.string().trim().min(1).max(500).nullable(),
    capabilities: z.array(z.string().trim().min(1).max(120)).max(100),
    requiredScopes: z.array(z.string().trim().min(1).max(200)).max(100),
    termsVersion: z.string().trim().min(1).max(120),
    termsStatus: z.enum(['ALLOWED', 'REVIEW_REQUIRED', 'PROHIBITED']),
    processingRegion: z.string().trim().min(1).max(160),
    retentionPolicy: z.string().trim().min(1).max(500),
    trainingPolicy: z.string().trim().min(1).max(500),
    subprocessors: z.array(OpenMetadataSchema).max(100),
    ratePolicy: OpenMetadataSchema,
  })
  .strict();

export const ChannelRegistryEntrySchema = z
  .object({
    id: UuidSchema,
    channelKey: z.string().trim().min(1).max(160),
    displayName: z.string().trim().min(1).max(160),
    status: z.enum(['AVAILABLE', 'UNAVAILABLE', 'DEPRECATED']),
    unavailableReason: z.string().trim().min(1).max(500).nullable(),
    packageTransformerKey: z.string().trim().min(1).max(160),
    packageSchemaVersion: z.string().trim().min(1).max(80),
    adapterVersions: z.array(ChannelAdapterVersionSchema),
  })
  .strict();

export const ChannelRegistryEnvelopeSchema = z
  .object({
    data: z.object({ entries: z.array(ChannelRegistryEntrySchema) }).strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export type ChannelRegistryEnvelope = z.infer<typeof ChannelRegistryEnvelopeSchema>;
