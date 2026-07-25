import { z } from 'zod';

import { SCHEMA_VERSION } from '../auth/auth.contracts.js';

const UuidSchema = z.uuid();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
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

export const ChannelProfileFieldRequirementSchema = z
  .object({
    field: z.string().trim().min(1).max(160),
    sourcePointer: z.string().min(1).max(500).startsWith('/'),
    required: z.boolean(),
    minLength: z.number().int().nonnegative().max(1_000_000).nullable(),
    maxLength: z.number().int().nonnegative().max(1_000_000).nullable(),
    format: z.string().trim().min(1).max(160),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.minLength !== null && value.maxLength !== null && value.minLength > value.maxLength) {
      context.addIssue({
        code: 'custom',
        path: ['maxLength'],
        message: 'maxLength must be greater than or equal to minLength',
      });
    }
  });

export const ChannelProfileSchema = z
  .object({
    channel: z.string().trim().min(1).max(160),
    profileVersion: z.string().trim().min(1).max(80),
    profileHash: Sha256Schema,
    fieldRequirements: z.array(ChannelProfileFieldRequirementSchema).min(1).max(100),
    titleMaxLength: z.number().int().positive().max(1_000_000).nullable().optional(),
    bodyFormat: z.enum(['markdown', 'html', 'plain']).nullable().optional(),
    maxTags: z.number().int().nonnegative().max(1_000).nullable().optional(),
    ctaPosition: z.enum(['none', 'top', 'bottom']).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const fields = new Set<string>();
    for (const [index, requirement] of value.fieldRequirements.entries()) {
      if (fields.has(requirement.field)) {
        context.addIssue({
          code: 'custom',
          path: ['fieldRequirements', index, 'field'],
          message: 'field requirements must be unique',
        });
      }
      fields.add(requirement.field);
    }
  });

export const ChannelRegistryEntrySchema = z
  .object({
    id: UuidSchema,
    channelKey: z.string().trim().min(1).max(160),
    displayName: z.string().trim().min(1).max(160),
    status: z.enum(['AVAILABLE', 'UNAVAILABLE', 'DEPRECATED']),
    unavailableReason: z.string().trim().min(1).max(500).nullable(),
    packageTransformerKey: z.string().trim().min(1).max(160),
    packageSchemaVersion: z.string().trim().min(1).max(80),
    channelProfile: ChannelProfileSchema.nullable().optional(),
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
