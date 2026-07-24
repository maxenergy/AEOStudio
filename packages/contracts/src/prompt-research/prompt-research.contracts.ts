import { z } from 'zod';

const UuidSchema = z.uuid();
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const MetaSchema = z.object({ requestId: z.string(), schemaVersion: z.literal('1.0.0') }).strict();

export const PromptSourceContextSchema = z
  .object({
    profile: z.object({ id: UuidSchema, revision: z.number().int().positive() }).strict(),
    offering: z.object({ id: UuidSchema, revision: z.number().int().positive() }).strict(),
    claimRevisionIds: z.array(UuidSchema).max(50),
  })
  .strict();

export const PromptDraftSchema = z
  .object({
    id: UuidSchema,
    text: z.string().max(2000),
    persona: z.string().max(120),
    journeyStage: z.string().max(120),
    queryType: z.string().max(120),
  })
  .strict();

export const PromptScopeSchema = z
  .object({
    market: z.string().max(120),
    locale: z.string().max(64),
    region: z.string().max(120),
  })
  .strict();

export const MeasurementScenarioInputSchema = z
  .object({
    providerKey: z.string().trim().min(1).max(120),
    surfaceKey: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(240),
    modelVersion: z.string().trim().min(1).max(120),
    account: z.string().trim().min(1).max(240),
    acquisitionMethod: z.string().trim().min(1).max(120),
    freshSession: z.boolean(),
    searchEnabled: z.boolean(),
    parameters: z.record(z.string(), z.unknown()),
    repetitions: z.number().int().min(1).max(100),
  })
  .strict();

export const ProposePromptSetRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    subject: z.string().trim().min(1).max(500),
    sourceContext: PromptSourceContextSchema,
    scopes: z.array(PromptScopeSchema).max(10),
    scenario: MeasurementScenarioInputSchema,
  })
  .strict();

export const CreatePromptRevisionRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    prompts: z.array(PromptDraftSchema).max(100),
    scopes: z.array(PromptScopeSchema).max(10),
    scenario: MeasurementScenarioInputSchema,
  })
  .strict();

export const ApprovePromptRevisionRequestSchema = z
  .object({
    expectedPromptHash: HashSchema,
    expectedScenarioHash: HashSchema,
  })
  .strict();

export const ProviderSurfaceRegistrySchema = z
  .object({
    id: UuidSchema,
    providerKey: z.string(),
    providerName: z.string(),
    surfaceKey: z.string(),
    surfaceName: z.string(),
    surfaceKind: z.enum(['SEARCH_DATA', 'CONSUMER_SEARCH', 'CONSUMER_AI_ANSWER']),
    acquisitionClass: z.enum([
      'CONSUMER_UI_SAMPLE',
      'MODEL_API_DIAGNOSTIC',
      'SEARCH_DATA_API',
      'MANUAL_IMPORT',
    ]),
    acquisitionMethod: z.string(),
    status: z.enum(['AVAILABLE', 'UNAVAILABLE']),
    unavailableReason: z.string().nullable(),
    adapterVersion: z.string(),
  })
  .strict();

export const PromptSetSchema = z
  .object({
    id: UuidSchema,
    tenantId: UuidSchema,
    workspaceId: UuidSchema,
    currentRevision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const PromptRevisionSchema = z
  .object({
    id: UuidSchema,
    promptSetId: UuidSchema,
    revision: z.number().int().positive(),
    title: z.string(),
    subject: z.string(),
    sourceContext: PromptSourceContextSchema,
    prompts: z.array(PromptDraftSchema),
    scopes: z.array(PromptScopeSchema),
    contentHash: HashSchema,
    status: z.enum(['DRAFT', 'APPROVED', 'STALE']),
    createdByUserId: UuidSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export const MeasurementScenarioSchema = MeasurementScenarioInputSchema.extend({
  id: UuidSchema,
  promptRevisionId: UuidSchema,
  version: z.number().int().positive(),
  contentHash: HashSchema,
  registryStatus: z.enum(['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN']),
  createdAt: z.iso.datetime(),
}).strict();

export const PromptApprovalSchema = z
  .object({
    id: UuidSchema,
    promptRevisionId: UuidSchema,
    scenarioId: UuidSchema,
    promptContentHash: HashSchema,
    scenarioContentHash: HashSchema,
    approvedByUserId: UuidSchema,
    approvedAt: z.iso.datetime(),
  })
  .strict();

const PromptBundleDataSchema = z
  .object({
    promptSet: PromptSetSchema,
    revision: PromptRevisionSchema,
    scenario: MeasurementScenarioSchema,
    approval: PromptApprovalSchema.nullable(),
    approvalCurrent: z.boolean(),
    previousApprovalStale: z.boolean(),
  })
  .strict();

export const PromptBundleEnvelopeSchema = z
  .object({ data: PromptBundleDataSchema, meta: MetaSchema })
  .strict();

export const PromptRegistryEnvelopeSchema = z
  .object({
    data: z.object({ entries: z.array(ProviderSurfaceRegistrySchema) }).strict(),
    meta: MetaSchema,
  })
  .strict();

export const PromptApprovalIssueSchema = z
  .object({
    code: z.enum([
      'PROMPT_COUNT',
      'PROMPT_TEXT',
      'PROMPT_TAXONOMY',
      'SCOPE_COUNT',
      'SCOPE_MARKET',
      'SCOPE_LOCALE',
      'SCOPE_REGION',
      'REPETITIONS',
      'SURFACE_NOT_REGISTERED',
      'SURFACE_ACQUISITION_METHOD',
    ]),
    path: z.string(),
    message: z.string(),
  })
  .strict();

export const ApprovedPromptSetListEnvelopeSchema = z
  .object({
    data: z
      .object({
        promptSets: z.array(
          z
            .object({
              promptSetId: UuidSchema,
              revisionId: UuidSchema,
              revision: z.number().int().positive(),
              title: z.string(),
              subject: z.string(),
              contentHash: HashSchema,
            })
            .strict(),
        ),
      })
      .strict(),
    meta: MetaSchema,
  })
  .strict();

export type ProposePromptSetRequest = z.infer<typeof ProposePromptSetRequestSchema>;
export type CreatePromptRevisionRequest = z.infer<typeof CreatePromptRevisionRequestSchema>;
export type MeasurementScenarioInputContract = z.infer<typeof MeasurementScenarioInputSchema>;
export type PromptBundleEnvelope = z.infer<typeof PromptBundleEnvelopeSchema>;
export type PromptRegistryEnvelope = z.infer<typeof PromptRegistryEnvelopeSchema>;
export type ApprovedPromptSetListEnvelope = z.infer<typeof ApprovedPromptSetListEnvelopeSchema>;
