import { z } from 'zod';

import { SCHEMA_VERSION } from '../auth/auth.contracts.js';

export const LocaleSchema = z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/);
export const MarketSchema = z.string().regex(/^[A-Z]{2}$/);

export const ProfileInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2_000).optional(),
    digitalAssets: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(80),
            url: z.url({ protocol: /^https?$/ }),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    targetMarkets: z
      .array(z.object({ locale: LocaleSchema, market: MarketSchema }).strict())
      .min(1)
      .max(20),
  })
  .strict();

export const CompletenessSummarySchema = z
  .object({
    completedFields: z.number().int().nonnegative(),
    totalFields: z.number().int().positive(),
    percent: z.number().int().min(0).max(100),
    missingFields: z.array(z.string()),
  })
  .strict();

export const ProfileRevisionSchema = ProfileInputSchema.extend({
  id: z.uuid(),
  profileId: z.uuid(),
  tenantId: z.uuid(),
  workspaceId: z.uuid(),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  completeness: CompletenessSummarySchema,
}).strict();

export const ProfileEnvelopeSchema = z
  .object({
    data: z.object({ profile: ProfileRevisionSchema }).strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

const AttributeBaseSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: z.string().trim().min(1).max(120),
  required: z.boolean(),
});

export const DynamicAttributeSchema = z.discriminatedUnion('valueType', [
  AttributeBaseSchema.extend({
    valueType: z.literal('text'),
    value: z.string().trim().min(1).max(2_000),
  }).strict(),
  AttributeBaseSchema.extend({
    valueType: z.literal('number'),
    value: z.number().finite(),
  }).strict(),
  AttributeBaseSchema.extend({
    valueType: z.literal('boolean'),
    value: z.boolean(),
  }).strict(),
  AttributeBaseSchema.extend({
    valueType: z.literal('url'),
    value: z.url({ protocol: /^https?$/ }),
  }).strict(),
  AttributeBaseSchema.extend({
    valueType: z.literal('string_list'),
    value: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  }).strict(),
]);

const StringListSchema = z.array(z.string().trim().min(1).max(500)).max(100).default([]);

export const OfferingInputSchema = z
  .object({
    kind: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(200),
    locale: LocaleSchema,
    market: MarketSchema,
    taxonomy: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
    principle: z.string().trim().max(4_000).optional(),
    specifications: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(120),
            value: z.string().trim().min(1).max(500),
            unit: z.string().trim().min(1).max(40).optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    features: StringListSchema,
    usage: StringListSchema,
    applicationScenarios: StringListSchema,
    compatibility: StringListSchema,
    evidenceHints: StringListSchema,
    attributes: z.array(DynamicAttributeSchema).max(100).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.attributes.forEach((attribute, index) => {
      if (seen.has(attribute.key)) {
        context.addIssue({
          code: 'custom',
          path: ['attributes', index, 'key'],
          message: 'Attribute keys must be unique within a revision.',
        });
      }
      seen.add(attribute.key);
    });
  });

export const OfferingRevisionSchema = OfferingInputSchema.safeExtend({
  id: z.uuid(),
  offeringId: z.uuid(),
  profileId: z.uuid(),
  tenantId: z.uuid(),
  workspaceId: z.uuid(),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  completeness: CompletenessSummarySchema,
}).strict();

export const OfferingEnvelopeSchema = z
  .object({
    data: z.object({ offering: OfferingRevisionSchema }).strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export type ProfileInput = z.infer<typeof ProfileInputSchema>;
export type ProfileEnvelope = z.infer<typeof ProfileEnvelopeSchema>;
export type OfferingInput = z.infer<typeof OfferingInputSchema>;
export type OfferingEnvelope = z.infer<typeof OfferingEnvelopeSchema>;
