export interface PromotionStrategyContent {
  objectives: string[];
  priorityOfferingIds: string[];
  targetPersonaIds: string[];
  targetMarkets: string[];
  channelPriorities: string[];
  contentTypes: string[];
  primaryCta: string;
  measurementGoals: string[];
}

export interface PromotionStrategyRevision extends PromotionStrategyContent {
  id: string;
  tenantId: string;
  workspaceId: string;
  revision: number;
  contentHash: string;
}
