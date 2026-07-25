import type { TenancyStore } from '../identity-access/index.js';
import {
  computeCompletionPercent,
  determineNextBestAction,
  type OnboardingState,
  type OnboardingStepId,
  type Readiness,
  type ReadinessStage,
  type StepState,
} from '@aeostudio/domain/onboarding';

import type { OnboardingProgressReader, OnboardingStore } from './ports.js';

export type OnboardingStateResult =
  { outcome: 'SUCCEEDED'; state: OnboardingState } | { outcome: 'NOT_FOUND' };

export type ReadinessResult =
  { outcome: 'SUCCEEDED'; readiness: Readiness } | { outcome: 'NOT_FOUND' };

export class OnboardingService {
  constructor(
    private readonly store: OnboardingStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext'>,
    private readonly progress: OnboardingProgressReader,
  ) {}

  async getOnboardingState(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<OnboardingStateResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }

    const stored = await this.store.getOnboardingState({ context });
    if (stored !== null) {
      return { outcome: 'SUCCEEDED', state: stored };
    }

    // Compute initial state from progress reader
    const stepStatuses = await this.computeStepStatuses({ context });
    const activeStep = this.determineActiveStep(stepStatuses);
    const state: OnboardingState = {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      activeStep,
      stepStatuses,
      completionPercent: computeCompletionPercent(stepStatuses),
      nextBestAction: determineNextBestAction(stepStatuses),
      updatedAt: new Date().toISOString(),
    };
    return { outcome: 'SUCCEEDED', state };
  }

  async getReadiness(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<ReadinessResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }

    const stored = await this.store.getReadiness({ context });
    if (stored !== null) {
      return { outcome: 'SUCCEEDED', readiness: stored };
    }

    // Compute readiness from progress reader
    const readiness = await this.computeReadiness({
      context,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
    });
    return { outcome: 'SUCCEEDED', readiness };
  }

  private async computeStepStatuses(input: {
    context: Parameters<OnboardingProgressReader['hasProfile']>[0]['context'];
  }): Promise<StepState[]> {
    const { context } = input;
    const now = new Date().toISOString();

    const hasProfile = await this.progress.hasProfile({ context });
    const hasOffering = await this.progress.hasOffering({ context });
    const hasApprovedClaim = await this.progress.hasApprovedClaim({ context });
    const hasPromptSet = await this.progress.hasPromptSet({ context });
    const hasContentPlan = await this.progress.hasContentPlan({ context });
    const hasArtifact = await this.progress.hasArtifact({ context });
    const hasChannelConnection = await this.progress.hasChannelConnection({ context });
    const hasPublication = await this.progress.hasPublication({ context });

    const statusFor = (completed: boolean): StepState['status'] =>
      completed ? 'COMPLETED' : 'NOT_STARTED';

    return [
      { stepId: 'start', status: 'COMPLETED', completedAt: now, blockingReason: null },
      {
        stepId: 'company',
        status: statusFor(hasProfile),
        completedAt: hasProfile ? now : null,
        blockingReason: null,
      },
      {
        stepId: 'products',
        status: statusFor(hasOffering),
        completedAt: hasOffering ? now : null,
        blockingReason: null,
      },
      {
        stepId: 'audiences',
        status: statusFor(hasApprovedClaim),
        completedAt: hasApprovedClaim ? now : null,
        blockingReason: null,
      },
      {
        stepId: 'evidence',
        status: statusFor(hasPromptSet),
        completedAt: hasPromptSet ? now : null,
        blockingReason: null,
      },
      {
        stepId: 'strategy',
        status: statusFor(hasContentPlan),
        completedAt: hasContentPlan ? now : null,
        blockingReason: null,
      },
      {
        stepId: 'channels',
        status: statusFor(hasChannelConnection),
        completedAt: hasChannelConnection ? now : null,
        blockingReason: null,
      },
      {
        stepId: 'content',
        status: statusFor(hasArtifact || hasPublication),
        completedAt: hasArtifact || hasPublication ? now : null,
        blockingReason: null,
      },
    ];
  }

  private determineActiveStep(stepStatuses: StepState[]): OnboardingStepId {
    const firstIncomplete = stepStatuses.find((s) => s.status !== 'COMPLETED');
    return firstIncomplete?.stepId ?? 'content';
  }

  private async computeReadiness(input: {
    context: Parameters<OnboardingProgressReader['hasProfile']>[0]['context'];
    tenantId: string;
    workspaceId: string;
  }): Promise<Readiness> {
    const { context, tenantId, workspaceId } = input;

    const hasProfile = await this.progress.hasProfile({ context });
    const hasOffering = await this.progress.hasOffering({ context });
    const hasApprovedClaim = await this.progress.hasApprovedClaim({ context });
    const hasArtifact = await this.progress.hasArtifact({ context });
    const hasChannelConnection = await this.progress.hasChannelConnection({ context });
    const hasPublication = await this.progress.hasPublication({ context });
    const pendingReviewCount = await this.progress.countPendingReviews({ context });
    const unconnectedChannels = await this.progress.listUnconnectedChannels({ context });
    const claimsMissingEvidence = await this.progress.listClaimsMissingEvidence({ context });

    const currentStage = this.determineStage({
      hasProfile,
      hasOffering,
      hasApprovedClaim,
      hasArtifact,
      hasChannelConnection,
      hasPublication,
    });

    const completedSteps: OnboardingStepId[] = [];
    if (hasProfile) completedSteps.push('company');
    if (hasOffering) completedSteps.push('products');
    if (hasApprovedClaim) completedSteps.push('audiences', 'evidence');
    if (hasArtifact) completedSteps.push('strategy', 'content');
    if (hasChannelConnection) completedSteps.push('channels');

    const blockers: Readiness['blockers'] = [];
    if (!hasProfile) {
      blockers.push({ type: 'MISSING_PROFILE', message: '需要先创建企业资料', resourceId: null });
    }
    if (!hasOffering) {
      blockers.push({ type: 'MISSING_OFFERING', message: '需要先添加产品/服务', resourceId: null });
    }
    if (claimsMissingEvidence.length > 0) {
      blockers.push({
        type: 'CLAIMS_MISSING_EVIDENCE',
        message: `${claimsMissingEvidence.length} 个事实声明缺少证明材料`,
        resourceId: null,
      });
    }

    const recommendations: Readiness['recommendations'] = [];
    if (!hasProfile) {
      recommendations.push({
        action: '创建企业资料',
        reason: '这是所有后续步骤的基础',
        targetStep: 'company',
      });
    } else if (!hasOffering) {
      recommendations.push({
        action: '添加产品/服务',
        reason: '描述你要推广的产品或服务',
        targetStep: 'products',
      });
    } else if (!hasApprovedClaim) {
      recommendations.push({
        action: '收集证明材料',
        reason: '事实声明需要证明材料支持',
        targetStep: 'evidence',
      });
    } else if (!hasChannelConnection) {
      recommendations.push({
        action: '连接发布渠道',
        reason: '连接渠道后才能发布内容',
        targetStep: 'channels',
      });
    }

    return {
      tenantId,
      workspaceId,
      currentStage,
      completedSteps,
      blockers,
      recommendations,
      canGenerate: hasApprovedClaim,
      canPublish: hasArtifact && hasChannelConnection,
      unconnectedChannels,
      claimsMissingEvidence,
      pendingReviewCount,
      evaluatedAt: new Date().toISOString(),
    };
  }

  private determineStage(flags: {
    hasProfile: boolean;
    hasOffering: boolean;
    hasApprovedClaim: boolean;
    hasArtifact: boolean;
    hasChannelConnection: boolean;
    hasPublication: boolean;
  }): ReadinessStage {
    if (flags.hasPublication) return 'MEASURING';
    if (flags.hasArtifact && flags.hasChannelConnection) return 'PUBLISH_READY';
    if (flags.hasArtifact) return 'CONTENT_READY';
    if (flags.hasApprovedClaim) return 'EVIDENCE_GATHERING';
    if (flags.hasProfile || flags.hasOffering) return 'KNOWLEDGE_BUILDING';
    return 'SETUP';
  }
}
