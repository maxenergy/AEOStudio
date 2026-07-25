import type {
  AudiencePersonaContent,
  AudiencePersonaRevision,
  CompetitorSetContent,
  CompetitorSetRevision,
  ContentPolicyContent,
  ContentPolicyRevision,
  IndustryContextContent,
  IndustryContextRevision,
  PromotionStrategyContent,
  PromotionStrategyRevision,
} from '@aeostudio/domain/knowledge';
import type { TenantContext } from '../identity-access/index.js';

export interface KnowledgeRevisionMap {
  industryContext: IndustryContextRevision;
  audiencePersona: AudiencePersonaRevision;
  competitorSet: CompetitorSetRevision;
  promotionStrategy: PromotionStrategyRevision;
  contentPolicy: ContentPolicyRevision;
}

export interface KnowledgeContentMap {
  industryContext: IndustryContextContent;
  audiencePersona: AudiencePersonaContent;
  competitorSet: CompetitorSetContent;
  promotionStrategy: PromotionStrategyContent;
  contentPolicy: ContentPolicyContent;
}

export type KnowledgeKind = keyof KnowledgeRevisionMap;

export const KNOWLEDGE_KINDS: readonly KnowledgeKind[] = [
  'industryContext',
  'audiencePersona',
  'competitorSet',
  'promotionStrategy',
  'contentPolicy',
] as const;

/**
 * Store port for workspace knowledge aggregates (industry context, audience
 * personas, competitor sets, promotion strategy, content policy). Each
 * aggregate is an immutable revision ledger scoped to a workspace.
 */
export interface KnowledgeStore {
  create<K extends KnowledgeKind>(input: {
    kind: K;
    context: TenantContext;
    revisionId: string;
    contentHash: string;
    content: KnowledgeContentMap[K];
  }): Promise<KnowledgeRevisionMap[K]>;

  list<K extends KnowledgeKind>(input: {
    kind: K;
    context: TenantContext;
  }): Promise<KnowledgeRevisionMap[K][]>;
}
