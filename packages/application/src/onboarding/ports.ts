import type {
  OnboardingState,
  Readiness,
  StepState,
  OnboardingStepId,
} from '@aeostudio/domain/onboarding';
import type { TenantContext } from '../identity-access/index.js';

/**
 * Store port for onboarding state persistence.
 * The in-memory implementation computes state from other stores.
 */
export interface OnboardingStore {
  getOnboardingState(input: { context: TenantContext }): Promise<OnboardingState | null>;

  updateStepStatus(input: {
    context: TenantContext;
    stepId: OnboardingStepId;
    status: StepState['status'];
    blockingReason?: string | null;
  }): Promise<OnboardingState | null>;

  getReadiness(input: { context: TenantContext }): Promise<Readiness | null>;
}

/**
 * Aggregated read model for computing onboarding progress.
 * Implemented by combining data from profile, offering, claims, prompts, etc.
 */
export interface OnboardingProgressReader {
  hasProfile(input: { context: TenantContext }): Promise<boolean>;
  hasOffering(input: { context: TenantContext }): Promise<boolean>;
  hasApprovedClaim(input: { context: TenantContext }): Promise<boolean>;
  hasPromptSet(input: { context: TenantContext }): Promise<boolean>;
  hasContentPlan(input: { context: TenantContext }): Promise<boolean>;
  hasArtifact(input: { context: TenantContext }): Promise<boolean>;
  hasChannelConnection(input: { context: TenantContext }): Promise<boolean>;
  hasPublication(input: { context: TenantContext }): Promise<boolean>;
  countPendingReviews(input: { context: TenantContext }): Promise<number>;
  listUnconnectedChannels(input: { context: TenantContext }): Promise<string[]>;
  listClaimsMissingEvidence(input: { context: TenantContext }): Promise<string[]>;
}
