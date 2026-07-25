import type {
  KnowledgeContentMap,
  KnowledgeKind,
  KnowledgeRevisionMap,
  KnowledgeStore,
} from '@aeostudio/application/knowledge';
import type { TenantContext } from '@aeostudio/application/identity-access';

type KnowledgeRevisionUnion = KnowledgeRevisionMap[KnowledgeKind];

/**
 * In-memory knowledge store. Each aggregate kind is an append-only revision
 * ledger scoped to a workspace: every create appends the next revision.
 */
export class InMemoryKnowledgeStore implements KnowledgeStore {
  private readonly ledgers = new Map<string, KnowledgeRevisionUnion[]>();

  private key(kind: KnowledgeKind, context: TenantContext): string {
    return `${kind}:${context.tenantId}:${context.workspaceId}`;
  }

  create<K extends KnowledgeKind>(input: {
    kind: K;
    context: TenantContext;
    revisionId: string;
    contentHash: string;
    content: KnowledgeContentMap[K];
  }): Promise<KnowledgeRevisionMap[K]> {
    const key = this.key(input.kind, input.context);
    const ledger = this.ledgers.get(key) ?? [];
    const revision = {
      ...structuredClone(input.content),
      id: input.revisionId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      revision: ledger.length + 1,
      contentHash: input.contentHash,
    } as KnowledgeRevisionMap[K];
    ledger.push(revision);
    this.ledgers.set(key, ledger);
    return Promise.resolve(structuredClone(revision));
  }

  list<K extends KnowledgeKind>(input: {
    kind: K;
    context: TenantContext;
  }): Promise<KnowledgeRevisionMap[K][]> {
    const ledger = this.ledgers.get(this.key(input.kind, input.context)) ?? [];
    return Promise.resolve(structuredClone(ledger) as KnowledgeRevisionMap[K][]);
  }
}
