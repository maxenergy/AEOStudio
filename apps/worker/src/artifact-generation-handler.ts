import type {
  ArtifactGenerator,
  ArtifactPayloadStore,
  ArtifactStore,
} from '@aeostudio/application/artifacts';
import { hashArtifactRevision, validateArtifactPayload } from '@aeostudio/application/artifacts';
import type { JobRecord } from '@aeostudio/domain/jobs-budgets';
import type { TenantContext } from '@aeostudio/application/identity-access';

export type ArtifactGenerationHandlerOutcome =
  | { outcome: 'SUCCEEDED'; artifactId: string; contentHash: string }
  | { outcome: 'INVALID_REFERENCE' | 'NOT_FOUND' };

export class ArtifactGenerationHandler {
  constructor(
    private readonly store: ArtifactStore,
    private readonly generator: ArtifactGenerator,
    private readonly payloads: ArtifactPayloadStore,
    private readonly ids: { next(): string },
    private readonly clock: { now(): Date },
  ) {}

  async run(job: JobRecord): Promise<ArtifactGenerationHandlerOutcome> {
    const context: TenantContext = {
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
      actorUserId: job.id,
      membershipId: job.id,
      role: 'OWNER',
    };
    const writerContext = await this.store.loadWriterContext({
      context,
      artifactId: job.aggregateId,
      effectiveAt: this.clock.now(),
    });
    if (writerContext === null) return { outcome: 'INVALID_REFERENCE' };
    const claimBindings = writerContext.claims.map((claim) => ({
      claimId: claim.claimId,
      claimRevisionId: claim.revisionId,
      claimContentHash: claim.contentHash,
      claimStatement: claim.statement,
      evidence: claim.evidence,
    }));
    const payload = validateArtifactPayload(
      await this.generator.generate(writerContext),
      claimBindings,
    );
    if (payload === null) return { outcome: 'INVALID_REFERENCE' };
    const contentHash = hashArtifactRevision({
      schemaVersion: writerContext.schemaVersion,
      artifactId: job.aggregateId,
      revision: 1,
      type: writerContext.type,
      locale: writerContext.locale,
      market: writerContext.market,
      sourceArtifactIds: writerContext.brief.sourceArtifactIds,
      lineage: writerContext.brief.lineage,
      claimBindings,
      methodPolicyVersion: writerContext.methodPolicyVersion,
      payload,
    });
    const stored = await this.payloads.put({
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
      artifactId: job.aggregateId,
      revision: 1,
      contentHash,
      payload,
    });
    const claimLinkIds = claimBindings.flatMap((binding) =>
      binding.evidence.map(() => this.ids.next()),
    );
    const completed = await this.store.completeGeneration({
      context,
      artifactId: job.aggregateId,
      revisionId: this.ids.next(),
      contentHash,
      payloadObjectRef: stored.objectRef,
      sourceArtifactIds: writerContext.brief.sourceArtifactIds,
      lineage: writerContext.brief.lineage,
      claimBindings,
      claimLinkIds,
      schemaVersion: writerContext.schemaVersion,
      createdByActor: { kind: 'AGENT', id: job.id },
      createdAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
    return completed === null
      ? { outcome: 'INVALID_REFERENCE' }
      : { outcome: 'SUCCEEDED', artifactId: job.aggregateId, contentHash };
  }
}
