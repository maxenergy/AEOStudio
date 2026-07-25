export type OnboardingStepId =
  'start' | 'company' | 'products' | 'audiences' | 'evidence' | 'strategy' | 'channels' | 'content';

export type StepStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED';

export interface StepState {
  stepId: OnboardingStepId;
  status: StepStatus;
  completedAt: string | null;
  blockingReason: string | null;
}

export interface OnboardingState {
  tenantId: string;
  workspaceId: string;
  activeStep: OnboardingStepId;
  stepStatuses: StepState[];
  completionPercent: number;
  nextBestAction: string | null;
  updatedAt: string;
}

export type ReadinessStage =
  | 'SETUP'
  | 'KNOWLEDGE_BUILDING'
  | 'EVIDENCE_GATHERING'
  | 'CONTENT_READY'
  | 'PUBLISH_READY'
  | 'MEASURING';

export interface ReadinessBlocker {
  type: string;
  message: string;
  resourceId: string | null;
}

export interface ReadinessRecommendation {
  action: string;
  reason: string;
  targetStep: OnboardingStepId;
}

export interface Readiness {
  tenantId: string;
  workspaceId: string;
  currentStage: ReadinessStage;
  completedSteps: OnboardingStepId[];
  blockers: ReadinessBlocker[];
  recommendations: ReadinessRecommendation[];
  canGenerate: boolean;
  canPublish: boolean;
  unconnectedChannels: string[];
  claimsMissingEvidence: string[];
  pendingReviewCount: number;
  evaluatedAt: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStepId[] = [
  'start',
  'company',
  'products',
  'audiences',
  'evidence',
  'strategy',
  'channels',
  'content',
] as const;

export function computeCompletionPercent(stepStatuses: StepState[]): number {
  const completed = stepStatuses.filter((s) => s.status === 'COMPLETED').length;
  return Math.round((completed / stepStatuses.length) * 100);
}

export function determineNextBestAction(stepStatuses: StepState[]): string | null {
  const firstIncomplete = stepStatuses.find((s) => s.status !== 'COMPLETED');
  if (firstIncomplete === undefined) return null;
  const actionMap: Record<OnboardingStepId, string> = {
    start: '完成产品说明与入口选择',
    company: '填写企业与品牌信息',
    products: '添加产品/服务描述',
    audiences: '定义目标客户与竞品',
    evidence: '收集网站与证明材料',
    strategy: '设定推广目标与内容参数',
    channels: '连接发布渠道',
    content: '生成并审核内容',
  };
  return actionMap[firstIncomplete.stepId];
}
