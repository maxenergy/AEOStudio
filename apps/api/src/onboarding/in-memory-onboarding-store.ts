import type { OnboardingStore, OnboardingProgressReader } from '@aeostudio/application/onboarding';
import type { TenantContext } from '@aeostudio/application/identity-access';
import type {
  OnboardingState,
  OnboardingStepId,
  Readiness,
  StepState,
} from '@aeostudio/domain/onboarding';

interface WorkspaceProgress {
  hasProfile: boolean;
  hasOffering: boolean;
  hasApprovedClaim: boolean;
  hasPromptSet: boolean;
  hasContentPlan: boolean;
  hasArtifact: boolean;
  hasChannelConnection: boolean;
  hasPublication: boolean;
  pendingReviewCount: number;
  unconnectedChannels: string[];
  claimsMissingEvidence: string[];
}

/**
 * In-memory onboarding store that tracks workspace progress.
 * In production, this would aggregate from multiple stores.
 */
export class InMemoryOnboardingStore implements OnboardingStore, OnboardingProgressReader {
  private readonly progress = new Map<string, WorkspaceProgress>();
  private readonly states = new Map<string, OnboardingState>();

  private key(context: TenantContext): string {
    return `${context.tenantId}:${context.workspaceId}`;
  }

  private getOrCreateProgress(context: TenantContext): WorkspaceProgress {
    const key = this.key(context);
    let progress = this.progress.get(key);
    if (progress === undefined) {
      progress = {
        hasProfile: false,
        hasOffering: false,
        hasApprovedClaim: false,
        hasPromptSet: false,
        hasContentPlan: false,
        hasArtifact: false,
        hasChannelConnection: false,
        hasPublication: false,
        pendingReviewCount: 0,
        unconnectedChannels: ['github', 'wordpress', 'shopify', 'webhook'],
        claimsMissingEvidence: [],
      };
      this.progress.set(key, progress);
    }
    return progress;
  }

  // OnboardingStore implementation
  getOnboardingState(input: { context: TenantContext }): Promise<OnboardingState | null> {
    return Promise.resolve(this.states.get(this.key(input.context)) ?? null);
  }

  updateStepStatus(input: {
    context: TenantContext;
    stepId: OnboardingStepId;
    status: StepState['status'];
    blockingReason?: string | null;
  }): Promise<OnboardingState | null> {
    const key = this.key(input.context);
    const state = this.states.get(key);
    if (state === undefined) return Promise.resolve(null);

    const stepIndex = state.stepStatuses.findIndex((s) => s.stepId === input.stepId);
    if (stepIndex === -1) return Promise.resolve(null);

    state.stepStatuses[stepIndex] = {
      stepId: input.stepId,
      status: input.status,
      blockingReason: input.blockingReason ?? null,
      completedAt: input.status === 'COMPLETED' ? new Date().toISOString() : null,
    };
    state.updatedAt = new Date().toISOString();
    return Promise.resolve(state);
  }

  getReadiness(input: { context: TenantContext }): Promise<Readiness | null> {
    // Readiness is computed on-the-fly by the service
    void input;
    return Promise.resolve(null);
  }

  // OnboardingProgressReader implementation
  hasProfile(input: { context: TenantContext }): Promise<boolean> {
    return Promise.resolve(this.getOrCreateProgress(input.context).hasProfile);
  }

  hasOffering(input: { context: TenantContext }): Promise<boolean> {
    return Promise.resolve(this.getOrCreateProgress(input.context).hasOffering);
  }

  hasApprovedClaim(input: { context: TenantContext }): Promise<boolean> {
    return Promise.resolve(this.getOrCreateProgress(input.context).hasApprovedClaim);
  }

  hasPromptSet(input: { context: TenantContext }): Promise<boolean> {
    return Promise.resolve(this.getOrCreateProgress(input.context).hasPromptSet);
  }

  hasContentPlan(input: { context: TenantContext }): Promise<boolean> {
    return Promise.resolve(this.getOrCreateProgress(input.context).hasContentPlan);
  }

  hasArtifact(input: { context: TenantContext }): Promise<boolean> {
    return Promise.resolve(this.getOrCreateProgress(input.context).hasArtifact);
  }

  hasChannelConnection(input: { context: TenantContext }): Promise<boolean> {
    return Promise.resolve(this.getOrCreateProgress(input.context).hasChannelConnection);
  }

  hasPublication(input: { context: TenantContext }): Promise<boolean> {
    return Promise.resolve(this.getOrCreateProgress(input.context).hasPublication);
  }

  countPendingReviews(input: { context: TenantContext }): Promise<number> {
    return Promise.resolve(this.getOrCreateProgress(input.context).pendingReviewCount);
  }

  listUnconnectedChannels(input: { context: TenantContext }): Promise<string[]> {
    return Promise.resolve([...this.getOrCreateProgress(input.context).unconnectedChannels]);
  }

  listClaimsMissingEvidence(input: { context: TenantContext }): Promise<string[]> {
    return Promise.resolve([...this.getOrCreateProgress(input.context).claimsMissingEvidence]);
  }

  // Mutation helpers for testing/development
  markProfileCreated(context: TenantContext): void {
    this.getOrCreateProgress(context).hasProfile = true;
  }

  markOfferingCreated(context: TenantContext): void {
    this.getOrCreateProgress(context).hasOffering = true;
  }

  markClaimApproved(context: TenantContext): void {
    this.getOrCreateProgress(context).hasApprovedClaim = true;
  }

  markPromptSetCreated(context: TenantContext): void {
    this.getOrCreateProgress(context).hasPromptSet = true;
  }

  markContentPlanCreated(context: TenantContext): void {
    this.getOrCreateProgress(context).hasContentPlan = true;
  }

  markArtifactCreated(context: TenantContext): void {
    this.getOrCreateProgress(context).hasArtifact = true;
  }

  markChannelConnected(context: TenantContext, channel: string): void {
    const progress = this.getOrCreateProgress(context);
    progress.hasChannelConnection = true;
    progress.unconnectedChannels = progress.unconnectedChannels.filter((c) => c !== channel);
  }

  markPublicationCreated(context: TenantContext): void {
    this.getOrCreateProgress(context).hasPublication = true;
  }
}
