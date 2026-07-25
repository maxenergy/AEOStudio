export interface ContentPolicyContent {
  locale: string;
  audienceId: string;
  journeyStage: string;
  objective: string;
  tone: string;
  readingLevel: string;
  answerFirst: boolean;
  includeFaq: boolean;
  requiredEntities: string[];
  prohibitedTerms: string[];
  requiredClaimRevisionIds: string[];
  schemaTypes: string[];
  ctaPolicy: string;
}

export interface ContentPolicyRevision extends ContentPolicyContent {
  id: string;
  tenantId: string;
  workspaceId: string;
  revision: number;
  contentHash: string;
}
