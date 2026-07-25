import { z } from 'zod';

import { SCHEMA_VERSION } from '../auth/auth.contracts.js';

export const OnboardingStepIdSchema = z.enum([
  'start',
  'company',
  'products',
  'audiences',
  'evidence',
  'strategy',
  'channels',
  'content',
]);

export const StepStatusSchema = z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED']);

export const StepStateSchema = z
  .object({
    stepId: OnboardingStepIdSchema,
    status: StepStatusSchema,
    completedAt: z.string().datetime().nullable(),
    blockingReason: z.string().nullable(),
  })
  .strict();

export const OnboardingStateSchema = z
  .object({
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    activeStep: OnboardingStepIdSchema,
    stepStatuses: z.array(StepStateSchema).length(8),
    completionPercent: z.number().int().min(0).max(100),
    nextBestAction: z.string().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const OnboardingStateEnvelopeSchema = z
  .object({
    data: z.object({ onboardingState: OnboardingStateSchema }).strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export const ReadinessStageSchema = z.enum([
  'SETUP',
  'KNOWLEDGE_BUILDING',
  'EVIDENCE_GATHERING',
  'CONTENT_READY',
  'PUBLISH_READY',
  'MEASURING',
]);

export const ReadinessBlockerSchema = z
  .object({
    type: z.string().min(1),
    message: z.string().min(1),
    resourceId: z.uuid().nullable(),
  })
  .strict();

export const ReadinessRecommendationSchema = z
  .object({
    action: z.string().min(1),
    reason: z.string().min(1),
    targetStep: OnboardingStepIdSchema,
  })
  .strict();

export const ReadinessSchema = z
  .object({
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    currentStage: ReadinessStageSchema,
    completedSteps: z.array(OnboardingStepIdSchema),
    blockers: z.array(ReadinessBlockerSchema),
    recommendations: z.array(ReadinessRecommendationSchema),
    canGenerate: z.boolean(),
    canPublish: z.boolean(),
    unconnectedChannels: z.array(z.string()),
    claimsMissingEvidence: z.array(z.uuid()),
    pendingReviewCount: z.number().int().nonnegative(),
    evaluatedAt: z.string().datetime(),
  })
  .strict();

export const ReadinessEnvelopeSchema = z
  .object({
    data: z.object({ readiness: ReadinessSchema }).strict(),
    meta: z
      .object({ requestId: z.string().min(1), schemaVersion: z.literal(SCHEMA_VERSION) })
      .strict(),
  })
  .strict();

export type OnboardingStepId = z.infer<typeof OnboardingStepIdSchema>;
export type StepStatus = z.infer<typeof StepStatusSchema>;
export type StepState = z.infer<typeof StepStateSchema>;
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;
export type OnboardingStateEnvelope = z.infer<typeof OnboardingStateEnvelopeSchema>;
export type ReadinessStage = z.infer<typeof ReadinessStageSchema>;
export type ReadinessBlocker = z.infer<typeof ReadinessBlockerSchema>;
export type ReadinessRecommendation = z.infer<typeof ReadinessRecommendationSchema>;
export type Readiness = z.infer<typeof ReadinessSchema>;
export type ReadinessEnvelope = z.infer<typeof ReadinessEnvelopeSchema>;
