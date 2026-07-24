import { z } from 'zod';

import { SCHEMA_VERSION } from '@aeostudio/contracts/auth';

export const SetBudgetRequestSchema = z
  .object({
    limitUnits: z.number().int().positive().max(1_000_000_000),
  })
  .strict();

export const ProviderKeySchema = z.string().trim().min(1).max(160);

export const SubmitJobRequestSchema = z
  .object({
    jobType: z.literal('PROFILE_READINESS'),
    aggregateId: z.uuid(),
    idempotencyKey: z.string().trim().min(1).max(160),
    estimatedUnits: z.number().int().positive().max(1_000_000),
  })
  .strict();

export const JobStatusSchema = z.enum([
  'BUDGET_BLOCKED',
  'QUEUED',
  'RUNNING',
  'RETRY_WAIT',
  'SUCCEEDED',
  'FAILED_TERMINAL',
  'CANCELLED',
]);

export const JobSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    providerKey: ProviderKeySchema.nullable(),
    jobType: z.enum([
      'PROFILE_READINESS',
      'SITE_CRAWL',
      'CONTENT_PLAN',
      'ARTIFACT_GENERATION',
      'PUBLICATION',
      'MEASUREMENT',
    ]),
    aggregateId: z.uuid(),
    status: JobStatusSchema,
    progress: z.number().int().min(0).max(100),
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    budgetWarning: z.boolean(),
    estimatedUnits: z.number().int().positive(),
    heartbeatAt: z.iso.datetime().nullable(),
    result: z.record(z.string(), z.unknown()).nullable(),
    errorCode: z.string().nullable(),
  })
  .strict();

export const JobEnvelopeSchema = z
  .object({
    data: z.object({ job: JobSchema }).strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

const BudgetPolicyCoreSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  limitUnits: z.number().int().positive().max(1_000_000_000),
  warningPercent: z.number().int().min(1).max(100),
});

export const WorkspaceBudgetPolicySchema = BudgetPolicyCoreSchema.extend({
  workspaceId: z.uuid(),
}).strict();

export const TenantBudgetPolicySchema = BudgetPolicyCoreSchema.strict();

export const ProviderBudgetPolicySchema = BudgetPolicyCoreSchema.extend({
  providerKey: ProviderKeySchema,
}).strict();

const BudgetResponseMetaSchema = z
  .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
  .strict();

export const WorkspaceBudgetPolicyEnvelopeSchema = z
  .object({
    data: z.object({ policy: WorkspaceBudgetPolicySchema }).strict(),
    meta: BudgetResponseMetaSchema,
  })
  .strict();

export const TenantBudgetPolicyEnvelopeSchema = z
  .object({
    data: z.object({ policy: TenantBudgetPolicySchema }).strict(),
    meta: BudgetResponseMetaSchema,
  })
  .strict();

export const ProviderBudgetPolicyEnvelopeSchema = z
  .object({
    data: z.object({ policy: ProviderBudgetPolicySchema }).strict(),
    meta: BudgetResponseMetaSchema,
  })
  .strict();

export const BudgetAlertSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    sourceWorkspaceId: z.uuid(),
    jobId: z.uuid(),
    budgetScope: z.enum(['TENANT', 'PROVIDER']),
    policyId: z.uuid(),
    providerKey: ProviderKeySchema.nullable(),
    thresholdPercent: z.number().int().min(1).max(100),
    audience: z.literal('TENANT_OWNER'),
    recipientUserId: z.uuid(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const BudgetAlertsEnvelopeSchema = z
  .object({
    data: z.object({ alerts: z.array(BudgetAlertSchema) }).strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export type SetBudgetRequest = z.infer<typeof SetBudgetRequestSchema>;
export type SubmitJobRequest = z.infer<typeof SubmitJobRequestSchema>;
export type JobEnvelope = z.infer<typeof JobEnvelopeSchema>;
export type WorkspaceBudgetPolicy = z.infer<typeof WorkspaceBudgetPolicySchema>;
export type TenantBudgetPolicy = z.infer<typeof TenantBudgetPolicySchema>;
export type ProviderBudgetPolicy = z.infer<typeof ProviderBudgetPolicySchema>;
export type WorkspaceBudgetPolicyEnvelope = z.infer<typeof WorkspaceBudgetPolicyEnvelopeSchema>;
export type TenantBudgetPolicyEnvelope = z.infer<typeof TenantBudgetPolicyEnvelopeSchema>;
export type ProviderBudgetPolicyEnvelope = z.infer<typeof ProviderBudgetPolicyEnvelopeSchema>;
export type BudgetAlert = z.infer<typeof BudgetAlertSchema>;
export type BudgetAlertsEnvelope = z.infer<typeof BudgetAlertsEnvelopeSchema>;
