import type { TenantContext } from '@aeostudio/application/identity-access';
import type { ArtifactClaimBinding, ArtifactRevisionRecord } from '@aeostudio/domain/artifacts';
import type { ClaimEvidenceDrillDownRecord } from '@aeostudio/domain/evidence-claims';

import type { InMemoryEvidenceClaimStore } from '../claims/in-memory-evidence-claim-store.js';
import type { InMemoryPromptResearchStore } from '../prompts/in-memory-prompt-research-store.js';

export class InMemoryArtifactLineageValidator {
  public constructor(
    private readonly options: {
      prompts: InMemoryPromptResearchStore;
      claims: InMemoryEvidenceClaimStore;
      clock: { now(): Date };
    },
  ) {}

  /** Fake-runtime effect fence; every read is synchronous and the result fails closed. */
  public isCurrent(input: { context: TenantContext; revision: ArtifactRevisionRecord }): boolean {
    let now: Date;
    try {
      now = this.options.clock.now();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return false;
      return (
        this.promptIsCurrent(input.context, input.revision) &&
        input.revision.claimBindings.length > 0 &&
        input.revision.claimBindings.every((binding) =>
          this.claimIsCurrent(input.context, binding, now),
        )
      );
    } catch {
      return false;
    }
  }

  private promptIsCurrent(context: TenantContext, artifact: ArtifactRevisionRecord): boolean {
    const lineage = artifact.lineage.prompt;
    const bundle = this.options.prompts.findRevisionNow({
      context,
      promptSetId: lineage.promptSetId,
      revisionId: lineage.promptRevisionId,
    });
    if (bundle === null) return false;
    const promptReference = artifact.lineage.sourceReferences.filter(
      (reference) =>
        reference.kind === 'PROMPT_REVISION' &&
        reference.id === lineage.promptRevisionId &&
        reference.aggregateId === lineage.promptSetId &&
        reference.revision === bundle.revision.revision &&
        reference.contentHash === lineage.contentHash,
    );
    return (
      bundle.promptSet.tenantId === context.tenantId &&
      bundle.promptSet.workspaceId === context.workspaceId &&
      bundle.promptSet.id === lineage.promptSetId &&
      bundle.promptSet.currentRevision === bundle.revision.revision &&
      bundle.revision.id === lineage.promptRevisionId &&
      bundle.revision.promptSetId === lineage.promptSetId &&
      bundle.revision.contentHash === lineage.contentHash &&
      bundle.revision.status === 'APPROVED' &&
      nonEmptyUniqueSubset(
        lineage.promptIds,
        bundle.revision.prompts.map((prompt) => prompt.id),
      ) &&
      bundle.scenario.promptRevisionId === lineage.promptRevisionId &&
      bundle.scenario.version === bundle.revision.revision &&
      bundle.scenario.registryStatus === 'AVAILABLE' &&
      bundle.approvalCurrent &&
      bundle.approval !== null &&
      bundle.approval.promptRevisionId === lineage.promptRevisionId &&
      bundle.approval.scenarioId === bundle.scenario.id &&
      bundle.approval.promptContentHash === lineage.contentHash &&
      bundle.approval.promptContentHash === bundle.revision.contentHash &&
      bundle.approval.scenarioContentHash === bundle.scenario.contentHash &&
      promptReference.length === 1
    );
  }

  private claimIsCurrent(
    context: TenantContext,
    binding: ArtifactClaimBinding,
    now: Date,
  ): boolean {
    const bundle = this.options.claims.findClaimForReviewNow({
      context,
      claimId: binding.claimId,
      revisionId: binding.claimRevisionId,
    });
    if (bundle === null) return false;
    const expiresAt =
      bundle.revision.expiresAt === null ? Number.NaN : Date.parse(bundle.revision.expiresAt);
    if (
      bundle.claim.tenantId !== context.tenantId ||
      bundle.claim.workspaceId !== context.workspaceId ||
      bundle.claim.id !== binding.claimId ||
      bundle.claim.currentRevision !== bundle.revision.revision ||
      bundle.revision.tenantId !== context.tenantId ||
      bundle.revision.workspaceId !== context.workspaceId ||
      bundle.revision.id !== binding.claimRevisionId ||
      bundle.revision.claimId !== binding.claimId ||
      bundle.revision.contentHash !== binding.claimContentHash ||
      bundle.revision.statement !== binding.claimStatement ||
      bundle.revision.status !== 'APPROVED' ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now.getTime()
    ) {
      return false;
    }
    const review = this.options.claims.findExactApprovedReviewNow({
      context,
      claimId: binding.claimId,
      revisionId: binding.claimRevisionId,
      contentHash: binding.claimContentHash,
    });
    if (
      review === null ||
      review.claimRevisionId !== binding.claimRevisionId ||
      review.contentHash !== binding.claimContentHash ||
      review.decision !== 'APPROVE'
    ) {
      return false;
    }
    const evidence = this.options.claims.findEvidenceDrillDownNow({
      context,
      claimId: binding.claimId,
      revisionId: binding.claimRevisionId,
    });
    return evidence !== null && exactCurrentEvidence(context, binding, evidence);
  }
}

function exactCurrentEvidence(
  context: TenantContext,
  binding: ArtifactClaimBinding,
  evidence: ClaimEvidenceDrillDownRecord[],
): boolean {
  if (binding.evidence.length === 0 || evidence.length === 0) {
    return false;
  }
  const expectedKeys = binding.evidence.map(evidenceKey);
  if (new Set(expectedKeys).size !== expectedKeys.length) return false;
  return binding.evidence.every((expected) => {
    const matches = evidence.filter(
      ({ source, snapshot, link }) =>
        source.id === expected.sourceId &&
        snapshot.id === expected.snapshotId &&
        link.sourceHash === expected.sourceHash,
    );
    if (matches.length !== 1) return false;
    const { source, snapshot, link } = matches[0]!;
    return (
      source.tenantId === context.tenantId &&
      source.workspaceId === context.workspaceId &&
      source.currentSnapshotId === snapshot.id &&
      snapshot.tenantId === context.tenantId &&
      snapshot.workspaceId === context.workspaceId &&
      snapshot.sourceId === source.id &&
      link.snapshotId === snapshot.id &&
      link.sourceHash !== null &&
      link.sourceHash === snapshot.contentHash &&
      link.sourceHash === expected.sourceHash &&
      link.snippet !== null
    );
  });
}

function evidenceKey(input: { sourceId: string; snapshotId: string; sourceHash: string }): string {
  return `${input.sourceId}:${input.snapshotId}:${input.sourceHash}`;
}

function nonEmptyUniqueSubset(expected: string[], available: string[]): boolean {
  const expectedIds = new Set(expected);
  const availableIds = new Set(available);
  return (
    expected.length > 0 &&
    expectedIds.size === expected.length &&
    availableIds.size === available.length &&
    expected.every((id) => availableIds.has(id))
  );
}
