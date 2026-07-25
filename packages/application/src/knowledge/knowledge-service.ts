import type { IdentityIdGenerator, TenancyStore } from '../identity-access/index.js';
import { roleAllows } from '@aeostudio/domain/identity-access';
import { revisionHash } from '../profile-offering/revision-hash.js';

import type {
  KnowledgeContentMap,
  KnowledgeKind,
  KnowledgeRevisionMap,
  KnowledgeStore,
} from './ports.js';

export type KnowledgeMutationResult<K extends KnowledgeKind> =
  | { outcome: 'SUCCEEDED'; revision: KnowledgeRevisionMap[K] }
  | { outcome: 'FORBIDDEN' }
  | { outcome: 'NOT_FOUND' };

export type KnowledgeListResult<K extends KnowledgeKind> =
  { outcome: 'SUCCEEDED'; revisions: KnowledgeRevisionMap[K][] } | { outcome: 'NOT_FOUND' };

const KIND_RESOURCE_TYPE: Record<KnowledgeKind, string> = {
  industryContext: 'INDUSTRY_CONTEXT',
  audiencePersona: 'AUDIENCE_PERSONA',
  competitorSet: 'COMPETITOR_SET',
  promotionStrategy: 'PROMOTION_STRATEGY',
  contentPolicy: 'CONTENT_POLICY',
};

export class KnowledgeService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext' | 'appendDeniedAudit'>,
    private readonly ids: IdentityIdGenerator,
  ) {}

  async create<K extends KnowledgeKind>(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    kind: K;
    content: KnowledgeContentMap[K];
  }): Promise<KnowledgeMutationResult<K>> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'KNOWLEDGE_WRITE',
        resourceType: KIND_RESOURCE_TYPE[input.kind],
      });
      return { outcome: 'FORBIDDEN' };
    }
    const revision = await this.store.create({
      kind: input.kind,
      context,
      revisionId: this.ids.next(),
      contentHash: revisionHash(input.content),
      content: input.content,
    });
    return { outcome: 'SUCCEEDED', revision };
  }

  async list<K extends KnowledgeKind>(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    kind: K;
  }): Promise<KnowledgeListResult<K>> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) {
      return { outcome: 'NOT_FOUND' };
    }
    const revisions = await this.store.list({ kind: input.kind, context });
    return { outcome: 'SUCCEEDED', revisions };
  }
}
