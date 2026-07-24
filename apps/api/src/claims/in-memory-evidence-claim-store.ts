import type { EvidenceClaimStore } from '@aeostudio/application/evidence-claims';
import type { JsonValue, TenantExportSourceObject } from '@aeostudio/application/privacy-audit';
import type {
  ClaimBundle,
  ClaimCurrentState,
  ClaimEvidenceDrillDownRecord,
  ClaimReviewRecord,
  EvidenceSnapshotRecord,
  EvidenceSourceRecord,
} from '@aeostudio/domain/evidence-claims';

import {
  FAKE_ARTIFACT_LINEAGE,
  fakeArtifactClaimBundle,
  fakeArtifactClaimEvidence,
  fakeArtifactClaimReview,
} from '../artifacts/fake-artifact-lineage-fixture.js';
import type { InMemoryAuditSink } from '../privacy/in-memory-audit-sink.js';
import type { InMemoryTenantExportSource } from '../privacy/in-memory-tenant-export-source.js';

export class InMemoryEvidenceClaimStore implements EvidenceClaimStore, InMemoryTenantExportSource {
  private readonly sources = new Map<string, EvidenceSourceRecord>();
  private readonly snapshots = new Map<string, EvidenceSnapshotRecord>();
  private readonly claims = new Map<string, ClaimBundle>();
  private readonly reviews = new Map<string, ClaimReviewRecord[]>();

  public constructor(private readonly audit?: InMemoryAuditSink) {}

  createSource(input: Parameters<EvidenceClaimStore['createSource']>[0]) {
    const source: EvidenceSourceRecord = {
      id: input.sourceId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      sourceType: input.sourceType,
      title: input.title,
      uri: input.uri,
      license: input.license,
      publicity: input.publicity,
      currentSnapshotId: null,
      createdAt: input.createdAt.toISOString(),
    };
    this.sources.set(
      this.key(input.context.tenantId, input.context.workspaceId, source.id),
      source,
    );
    this.appendAudit(
      input,
      'EVIDENCE_SOURCE_CREATED',
      'EVIDENCE_SOURCE',
      source.id,
      input.createdAt,
      {
        sourceType: source.sourceType,
        publicity: source.publicity,
      },
    );
    return Promise.resolve(source);
  }

  createSnapshot(input: Parameters<EvidenceClaimStore['createSnapshot']>[0]) {
    const sourceKey = this.key(input.context.tenantId, input.context.workspaceId, input.sourceId);
    const source = this.sources.get(sourceKey);
    if (source === undefined) {
      return Promise.resolve(null);
    }
    const snapshot: EvidenceSnapshotRecord = {
      id: input.snapshotId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      sourceId: source.id,
      contentHash: input.contentHash,
      objectRef: input.objectRef,
      objectVersionId: input.objectVersionId,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      capturedAt: input.capturedAt.toISOString(),
    };
    const updatedSource = { ...source, currentSnapshotId: snapshot.id };
    this.snapshots.set(
      this.key(input.context.tenantId, input.context.workspaceId, snapshot.id),
      snapshot,
    );
    this.sources.set(sourceKey, updatedSource);
    for (const [claimKey, bundle] of this.claims) {
      if (
        bundle.revision.status === 'APPROVED' &&
        bundle.revision.evidence.some((link) => {
          const linked = this.snapshots.get(
            this.key(input.context.tenantId, input.context.workspaceId, link.snapshotId),
          );
          return linked?.sourceId === source.id && linked.id !== snapshot.id;
        })
      ) {
        this.claims.set(claimKey, {
          ...bundle,
          revision: { ...bundle.revision, status: 'STALE' },
        });
      }
    }
    this.appendAudit(
      input,
      'EVIDENCE_SNAPSHOT_CREATED',
      'EVIDENCE_SNAPSHOT',
      snapshot.id,
      input.capturedAt,
      {
        sourceId: source.id,
        contentHash: snapshot.contentHash,
        contentType: snapshot.contentType,
        sizeBytes: snapshot.sizeBytes,
      },
    );
    return Promise.resolve({ snapshot, source: updatedSource });
  }

  findSnapshots(input: Parameters<EvidenceClaimStore['findSnapshots']>[0]) {
    const snapshots = input.snapshotIds.map((snapshotId) =>
      this.snapshots.get(this.key(input.context.tenantId, input.context.workspaceId, snapshotId)),
    );
    return Promise.resolve(
      snapshots.some((snapshot) => snapshot === undefined)
        ? null
        : snapshots.map((snapshot) => structuredClone(snapshot!)),
    );
  }

  createClaim(input: Parameters<EvidenceClaimStore['createClaim']>[0]) {
    const evidence = input.evidence.map((entry, index) => ({
      id: input.evidenceLinkIds[index] ?? '',
      ...entry,
    }));
    const exactEvidence =
      evidence.length > 0 &&
      evidence.every((link) => {
        const snapshot = this.snapshots.get(
          this.key(input.context.tenantId, input.context.workspaceId, link.snapshotId),
        );
        const source =
          snapshot === undefined
            ? undefined
            : this.sources.get(
                this.key(input.context.tenantId, input.context.workspaceId, snapshot.sourceId),
              );
        return (
          snapshot !== undefined &&
          source !== undefined &&
          link.id.length > 0 &&
          link.sourceHash === snapshot.contentHash &&
          link.snippet !== null &&
          source.currentSnapshotId === snapshot.id
        );
      });
    if (
      evidence.some(
        (link) =>
          !this.snapshots.has(
            this.key(input.context.tenantId, input.context.workspaceId, link.snapshotId),
          ),
      )
    ) {
      return Promise.resolve(null);
    }
    const ready =
      exactEvidence &&
      input.scope !== null &&
      input.expiresAt !== null &&
      input.expiresAt.getTime() > input.createdAt.getTime() &&
      (input.numericValue === null || input.unit !== null);
    const bundle: ClaimBundle = {
      claim: {
        id: input.claimId,
        tenantId: input.context.tenantId,
        workspaceId: input.context.workspaceId,
        currentRevision: 1,
        createdAt: input.createdAt.toISOString(),
      },
      revision: {
        id: input.revisionId,
        tenantId: input.context.tenantId,
        workspaceId: input.context.workspaceId,
        claimId: input.claimId,
        revision: 1,
        statement: input.statement,
        numericValue: input.numericValue,
        unit: input.unit,
        scope: input.scope,
        conditions: input.conditions,
        expiresAt: input.expiresAt?.toISOString() ?? null,
        contentHash: input.contentHash,
        status: ready ? 'DRAFT' : 'NEEDS_EVIDENCE',
        createdByUserId: input.context.actorUserId,
        createdAt: input.createdAt.toISOString(),
        evidence,
      },
    };
    this.claims.set(
      this.key(input.context.tenantId, input.context.workspaceId, input.claimId),
      bundle,
    );
    this.appendAudit(input, 'CLAIM_REVISION_CREATED', 'CLAIM', input.claimId, input.createdAt, {
      revisionId: input.revisionId,
      revision: 1,
      contentHash: input.contentHash,
      status: bundle.revision.status,
      evidenceCount: evidence.length,
    });
    return Promise.resolve(bundle);
  }

  submitClaim(input: Parameters<EvidenceClaimStore['submitClaim']>[0]) {
    const claimKey = this.key(input.context.tenantId, input.context.workspaceId, input.claimId);
    const bundle = this.claims.get(claimKey);
    if (bundle === undefined || bundle.revision.id !== input.revisionId) {
      return Promise.resolve({ outcome: 'NOT_FOUND' as const });
    }
    if (
      bundle.revision.status !== 'DRAFT' ||
      bundle.revision.expiresAt === null ||
      new Date(bundle.revision.expiresAt).getTime() <= input.submittedAt.getTime()
    ) {
      return Promise.resolve({ outcome: 'NEEDS_EVIDENCE' as const });
    }
    const updated = { ...bundle, revision: { ...bundle.revision, status: 'IN_REVIEW' as const } };
    this.claims.set(claimKey, updated);
    this.appendAudit(input, 'CLAIM_REVISION_SUBMITTED', 'CLAIM', input.claimId, input.submittedAt, {
      revisionId: input.revisionId,
      contentHash: bundle.revision.contentHash,
    });
    return Promise.resolve({ outcome: 'SUCCEEDED' as const, bundle: updated });
  }

  findClaimForReview(input: Parameters<EvidenceClaimStore['findClaimForReview']>[0]) {
    return Promise.resolve(this.findClaimForReviewNow(input));
  }

  /** Fake-runtime effect fence; real aggregate state takes precedence over fixture fallback. */
  findClaimForReviewNow(
    input: Parameters<EvidenceClaimStore['findClaimForReview']>[0],
  ): ClaimBundle | null {
    const bundle = this.claims.get(
      this.key(input.context.tenantId, input.context.workspaceId, input.claimId),
    );
    if (bundle !== undefined) {
      return bundle.revision.id === input.revisionId ? bundle : null;
    }
    if (
      input.claimId === FAKE_ARTIFACT_LINEAGE.claimId &&
      input.revisionId === FAKE_ARTIFACT_LINEAGE.claimRevisionId
    ) {
      return fakeArtifactClaimBundle({
        tenantId: input.context.tenantId,
        workspaceId: input.context.workspaceId,
        actorUserId: input.context.actorUserId,
      });
    }
    return null;
  }

  /** Fake-runtime effect/package fence truth for an exact immutable Claim approval. */
  findExactApprovedReviewNow(input: {
    context: Parameters<EvidenceClaimStore['findClaimForReview']>[0]['context'];
    claimId: string;
    revisionId: string;
    contentHash: string;
  }): ClaimReviewRecord | null {
    const bundle = this.claims.get(
      this.key(input.context.tenantId, input.context.workspaceId, input.claimId),
    );
    if (bundle !== undefined) {
      if (
        bundle.revision.id !== input.revisionId ||
        bundle.revision.contentHash !== input.contentHash
      ) {
        return null;
      }
      const matches = (this.reviews.get(input.revisionId) ?? []).filter(
        (review) =>
          review.claimRevisionId === input.revisionId &&
          review.contentHash === input.contentHash &&
          review.decision === 'APPROVE',
      );
      return matches.length === 1 ? structuredClone(matches[0]!) : null;
    }
    if (
      input.claimId === FAKE_ARTIFACT_LINEAGE.claimId &&
      input.revisionId === FAKE_ARTIFACT_LINEAGE.claimRevisionId &&
      input.contentHash === FAKE_ARTIFACT_LINEAGE.claimHash
    ) {
      return fakeArtifactClaimReview({ actorUserId: input.context.actorUserId });
    }
    return null;
  }

  reviewClaim(input: Parameters<EvidenceClaimStore['reviewClaim']>[0]) {
    const claimKey = this.key(input.context.tenantId, input.context.workspaceId, input.claimId);
    const bundle = this.claims.get(claimKey);
    if (
      bundle === undefined ||
      bundle.revision.id !== input.revisionId ||
      bundle.revision.contentHash !== input.expectedContentHash
    ) {
      return Promise.resolve({ outcome: 'NOT_FOUND' as const });
    }
    if (bundle.revision.status !== 'IN_REVIEW') {
      return Promise.resolve({ outcome: 'NOT_IN_REVIEW' as const });
    }
    const updated: ClaimBundle = {
      ...bundle,
      revision: {
        ...bundle.revision,
        status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      },
    };
    const review: ClaimReviewRecord = {
      id: input.reviewId,
      claimRevisionId: input.revisionId,
      decision: input.decision,
      reviewerUserId: input.context.actorUserId,
      contentHash: input.expectedContentHash,
      note: input.note,
      reviewedAt: input.reviewedAt.toISOString(),
    };
    this.claims.set(claimKey, updated);
    const reviews = this.reviews.get(input.revisionId) ?? [];
    reviews.push(review);
    this.reviews.set(input.revisionId, reviews);
    this.appendAudit(
      input,
      input.decision === 'APPROVE' ? 'CLAIM_REVISION_APPROVED' : 'CLAIM_REVISION_REJECTED',
      'CLAIM',
      input.claimId,
      input.reviewedAt,
      {
        revisionId: input.revisionId,
        reviewId: input.reviewId,
        contentHash: input.expectedContentHash,
        decision: input.decision,
      },
    );
    return Promise.resolve({ outcome: 'SUCCEEDED' as const, bundle: updated, review });
  }

  listTenantExportObjects(input: {
    tenantId: string;
    from: Date;
    to: Date;
  }): Promise<TenantExportSourceObject[]> {
    const from = input.from.getTime();
    const to = input.to.getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      return Promise.reject(new Error('INVALID_TENANT_EXPORT_RANGE'));
    }
    const objects = [...this.claims.values()]
      .filter((bundle) => bundle.claim.tenantId === input.tenantId)
      .filter((bundle) => {
        const occurredAt = Date.parse(bundle.revision.createdAt);
        return occurredAt >= from && occurredAt <= to;
      })
      .map<TenantExportSourceObject>((bundle) => ({
        tenantId: bundle.claim.tenantId,
        workspaceId: bundle.claim.workspaceId,
        kind: 'CLAIM_REVISION',
        objectId: bundle.revision.id,
        occurredAt: bundle.revision.createdAt,
        payload: toJsonValue({
          claim: bundle.claim,
          revision: bundle.revision,
          reviews: this.reviews.get(bundle.revision.id) ?? [],
          evidenceRecords: bundle.revision.evidence.map((link) => {
            const snapshot = this.snapshots.get(
              this.key(bundle.claim.tenantId, bundle.claim.workspaceId, link.snapshotId),
            );
            const source =
              snapshot === undefined
                ? null
                : (this.sources.get(
                    this.key(bundle.claim.tenantId, bundle.claim.workspaceId, snapshot.sourceId),
                  ) ?? null);
            return { link, source, snapshot: snapshot ?? null };
          }),
        }),
      }));
    objects.sort((left, right) =>
      `${left.kind}:${left.objectId}`.localeCompare(`${right.kind}:${right.objectId}`),
    );
    return Promise.resolve(objects);
  }

  findEvidenceDrillDown(input: Parameters<EvidenceClaimStore['findEvidenceDrillDown']>[0]) {
    return Promise.resolve(this.findEvidenceDrillDownNow(input));
  }

  /** Fake-runtime effect fence; reads exact live link, snapshot, and source rows without yielding. */
  findEvidenceDrillDownNow(
    input: Parameters<EvidenceClaimStore['findEvidenceDrillDown']>[0],
  ): ClaimEvidenceDrillDownRecord[] | null {
    const bundle = this.claims.get(
      this.key(input.context.tenantId, input.context.workspaceId, input.claimId),
    );
    if (bundle !== undefined) {
      if (bundle.revision.id !== input.revisionId) return null;
      const result: ClaimEvidenceDrillDownRecord[] = [];
      for (const link of bundle.revision.evidence) {
        const snapshot = this.snapshots.get(
          this.key(input.context.tenantId, input.context.workspaceId, link.snapshotId),
        );
        const source =
          snapshot === undefined
            ? undefined
            : this.sources.get(
                this.key(input.context.tenantId, input.context.workspaceId, snapshot.sourceId),
              );
        if (snapshot === undefined || source === undefined) return null;
        result.push({ source, snapshot, link });
      }
      return result.length === 0 ? null : result;
    }
    if (
      input.claimId === FAKE_ARTIFACT_LINEAGE.claimId &&
      input.revisionId === FAKE_ARTIFACT_LINEAGE.claimRevisionId
    ) {
      return fakeArtifactClaimEvidence({
        tenantId: input.context.tenantId,
        workspaceId: input.context.workspaceId,
      });
    }
    return null;
  }

  findCurrentClaim(input: Parameters<EvidenceClaimStore['findCurrentClaim']>[0]) {
    const claimKey = this.key(input.context.tenantId, input.context.workspaceId, input.claimId);
    let bundle = this.claims.get(claimKey);
    if (bundle === undefined) {
      return Promise.resolve(null);
    }
    const sourceChanged = bundle.revision.evidence.some((link) => {
      const snapshot = this.snapshots.get(
        this.key(input.context.tenantId, input.context.workspaceId, link.snapshotId),
      );
      const source =
        snapshot === undefined
          ? undefined
          : this.sources.get(
              this.key(input.context.tenantId, input.context.workspaceId, snapshot.sourceId),
            );
      return source?.currentSnapshotId !== snapshot?.id;
    });
    const expired =
      bundle.revision.expiresAt !== null &&
      new Date(bundle.revision.expiresAt).getTime() <= input.evaluatedAt.getTime();
    if (bundle.revision.status === 'APPROVED' && (sourceChanged || expired)) {
      bundle = { ...bundle, revision: { ...bundle.revision, status: 'STALE' } };
      this.claims.set(claimKey, bundle);
    }
    const staleReasons: ClaimCurrentState['staleReasons'] = [];
    if (sourceChanged) staleReasons.push('SOURCE_CHANGED');
    if (expired) staleReasons.push('EXPIRED');
    if (bundle.revision.status !== 'APPROVED' && bundle.revision.status !== 'STALE') {
      staleReasons.push('NOT_APPROVED');
    }
    const currentUsable = bundle.revision.status === 'APPROVED' && staleReasons.length === 0;
    this.appendAudit(input, 'CLAIM_CURRENT_EVALUATED', 'CLAIM', input.claimId, input.evaluatedAt, {
      revisionId: bundle.revision.id,
      contentHash: bundle.revision.contentHash,
      currentUsable,
      staleReasons,
    });
    return Promise.resolve({
      ...bundle,
      currentUsable,
      staleReasons,
      reviewRequired: !currentUsable,
    });
  }

  private key(tenantId: string, workspaceId: string, id: string): string {
    return `${tenantId}:${workspaceId}:${id}`;
  }

  private appendAudit(
    input: {
      context: { tenantId: string; workspaceId: string; actorUserId: string };
      auditEventId: string;
    },
    action: string,
    resourceType: string,
    resourceId: string,
    occurredAt: Date,
    metadata: Record<string, unknown>,
  ): void {
    this.audit?.append({
      id: input.auditEventId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      actorId: input.context.actorUserId,
      action,
      resourceType,
      resourceId,
      outcome: 'SUCCEEDED',
      metadata,
      occurredAt,
    });
  }

  listApprovedClaims(input: { context: { tenantId: string; workspaceId: string } }): Promise<
    {
      claimId: string;
      revisionId: string;
      revision: number;
      statement: string;
      contentHash: string;
    }[]
  > {
    const results: {
      claimId: string;
      revisionId: string;
      revision: number;
      statement: string;
      contentHash: string;
    }[] = [];
    for (const [key, bundle] of this.claims) {
      if (!key.startsWith(`${input.context.tenantId}:${input.context.workspaceId}:`)) continue;
      if (bundle.revision.status !== 'APPROVED') continue;
      results.push({
        claimId: bundle.claim.id,
        revisionId: bundle.revision.id,
        revision: bundle.revision.revision,
        statement: bundle.revision.statement,
        contentHash: bundle.revision.contentHash,
      });
    }
    return Promise.resolve(results);
  }
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
