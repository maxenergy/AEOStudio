import { z } from 'zod';

import { SCHEMA_VERSION } from '../auth/auth.contracts.js';

const StringListSchema = z.array(z.string().trim().min(1).max(500)).max(200).default([]);

const MetaSchema = z
  .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
  .strict();

const RevisionMetaSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    revision: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

function envelope<T extends z.ZodTypeAny>(key: string, schema: T) {
  return z
    .object({
      data: z.object({ [key]: schema }).strict(),
      meta: MetaSchema,
    })
    .strict();
}

function listEnvelope<T extends z.ZodTypeAny>(key: string, schema: T) {
  return z
    .object({
      data: z.object({ [key]: z.array(schema) }).strict(),
      meta: MetaSchema,
    })
    .strict();
}

// --- Industry Context ---
export const IndustryContextInputSchema = z
  .object({
    industryLabels: StringListSchema,
    subIndustryLabels: StringListSchema,
    taxonomyRefs: StringListSchema,
    synonyms: StringListSchema,
    commonTerms: StringListSchema,
    commonQuestions: StringListSchema,
    regulations: StringListSchema,
    prohibitedClaims: StringListSchema,
    seasonality: StringListSchema,
    authoritativeSources: StringListSchema,
  })
  .strict();

export const IndustryContextRevisionSchema = IndustryContextInputSchema.extend(
  RevisionMetaSchema.shape,
).strict();

export const IndustryContextEnvelopeSchema = envelope(
  'industryContext',
  IndustryContextRevisionSchema,
);
export const IndustryContextListEnvelopeSchema = listEnvelope(
  'industryContexts',
  IndustryContextRevisionSchema,
);

// --- Audience Persona ---
export const AudiencePersonaInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    role: z.string().trim().max(200).default(''),
    industry: z.string().trim().max(200).default(''),
    region: z.string().trim().max(200).default(''),
    goals: StringListSchema,
    painPoints: StringListSchema,
    questions: StringListSchema,
    objections: StringListSchema,
    decisionCriteria: StringListSchema,
    channels: StringListSchema,
    journeyStages: StringListSchema,
  })
  .strict();

export const AudiencePersonaRevisionSchema = AudiencePersonaInputSchema.extend(
  RevisionMetaSchema.shape,
).strict();

export const AudiencePersonaEnvelopeSchema = envelope(
  'audiencePersona',
  AudiencePersonaRevisionSchema,
);
export const AudiencePersonaListEnvelopeSchema = listEnvelope(
  'audiencePersonas',
  AudiencePersonaRevisionSchema,
);

// --- Competitor Set ---
export const CompetitorSetInputSchema = z
  .object({
    competitorName: z.string().trim().min(1).max(200),
    website: z.string().trim().max(500).default(''),
    matchedOfferingIds: z.array(z.uuid()).max(100).default([]),
    positioning: z.string().trim().max(2_000).default(''),
    comparisonDimensions: StringListSchema,
    evidenceSourceIds: z.array(z.uuid()).max(100).default([]),
    allowedComparisons: StringListSchema,
    prohibitedComparisons: StringListSchema,
  })
  .strict();

export const CompetitorSetRevisionSchema = CompetitorSetInputSchema.extend(
  RevisionMetaSchema.shape,
).strict();

export const CompetitorSetEnvelopeSchema = envelope('competitorSet', CompetitorSetRevisionSchema);
export const CompetitorSetListEnvelopeSchema = listEnvelope(
  'competitorSets',
  CompetitorSetRevisionSchema,
);

// --- Promotion Strategy ---
export const PromotionStrategyInputSchema = z
  .object({
    objectives: StringListSchema,
    priorityOfferingIds: z.array(z.uuid()).max(100).default([]),
    targetPersonaIds: z.array(z.uuid()).max(100).default([]),
    targetMarkets: StringListSchema,
    channelPriorities: StringListSchema,
    contentTypes: StringListSchema,
    primaryCta: z.string().trim().max(500).default(''),
    measurementGoals: StringListSchema,
  })
  .strict();

export const PromotionStrategyRevisionSchema = PromotionStrategyInputSchema.extend(
  RevisionMetaSchema.shape,
).strict();

export const PromotionStrategyEnvelopeSchema = envelope(
  'promotionStrategy',
  PromotionStrategyRevisionSchema,
);
export const PromotionStrategyListEnvelopeSchema = listEnvelope(
  'promotionStrategies',
  PromotionStrategyRevisionSchema,
);

// --- Content Policy ---
export const ContentPolicyInputSchema = z
  .object({
    locale: z.string().trim().min(1).max(20),
    audienceId: z.string().trim().max(100).default(''),
    journeyStage: z.string().trim().max(100).default(''),
    objective: z.string().trim().max(500).default(''),
    tone: z.string().trim().max(100).default(''),
    readingLevel: z.string().trim().max(100).default(''),
    answerFirst: z.boolean().default(true),
    includeFaq: z.boolean().default(true),
    requiredEntities: StringListSchema,
    prohibitedTerms: StringListSchema,
    requiredClaimRevisionIds: z.array(z.uuid()).max(100).default([]),
    schemaTypes: StringListSchema,
    ctaPolicy: z.string().trim().max(500).default(''),
  })
  .strict();

export const ContentPolicyRevisionSchema = ContentPolicyInputSchema.extend(
  RevisionMetaSchema.shape,
).strict();

export const ContentPolicyEnvelopeSchema = envelope('contentPolicy', ContentPolicyRevisionSchema);
export const ContentPolicyListEnvelopeSchema = listEnvelope(
  'contentPolicies',
  ContentPolicyRevisionSchema,
);

export type IndustryContextInput = z.infer<typeof IndustryContextInputSchema>;
export type IndustryContextEnvelope = z.infer<typeof IndustryContextEnvelopeSchema>;
export type IndustryContextListEnvelope = z.infer<typeof IndustryContextListEnvelopeSchema>;
export type AudiencePersonaInput = z.infer<typeof AudiencePersonaInputSchema>;
export type AudiencePersonaEnvelope = z.infer<typeof AudiencePersonaEnvelopeSchema>;
export type AudiencePersonaListEnvelope = z.infer<typeof AudiencePersonaListEnvelopeSchema>;
export type CompetitorSetInput = z.infer<typeof CompetitorSetInputSchema>;
export type CompetitorSetEnvelope = z.infer<typeof CompetitorSetEnvelopeSchema>;
export type CompetitorSetListEnvelope = z.infer<typeof CompetitorSetListEnvelopeSchema>;
export type PromotionStrategyInput = z.infer<typeof PromotionStrategyInputSchema>;
export type PromotionStrategyEnvelope = z.infer<typeof PromotionStrategyEnvelopeSchema>;
export type PromotionStrategyListEnvelope = z.infer<typeof PromotionStrategyListEnvelopeSchema>;
export type ContentPolicyInput = z.infer<typeof ContentPolicyInputSchema>;
export type ContentPolicyEnvelope = z.infer<typeof ContentPolicyEnvelopeSchema>;
export type ContentPolicyListEnvelope = z.infer<typeof ContentPolicyListEnvelopeSchema>;
