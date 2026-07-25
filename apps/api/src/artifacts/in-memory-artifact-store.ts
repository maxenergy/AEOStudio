import { randomUUID } from 'node:crypto';
import {
  hashArtifactRevision,
  type ArtifactPayloadStore,
  type ArtifactStore,
} from '@aeostudio/application/artifacts';
import { DeterministicArtifactGenerator } from '@aeostudio/adapters/generation';
import type {
  ArtifactLedgerBundle,
  ArtifactRecord,
  ArtifactReviewRecord,
  ArtifactRevisionRecord,
  ArtifactType,
  ArtifactWriterContext,
} from '@aeostudio/domain/artifacts';
import type { JobRecord } from '@aeostudio/domain/jobs-budgets';
import type { JsonValue, TenantExportSourceObject } from '@aeostudio/application/privacy-audit';

import type { InMemoryAuditSink } from '../privacy/in-memory-audit-sink.js';
import type { InMemoryTenantExportSource } from '../privacy/in-memory-tenant-export-source.js';
import {
  FAKE_ARTIFACT_LINEAGE,
  FAKE_ARTIFACT_PROMPT_IDS,
} from './fake-artifact-lineage-fixture.js';

const TYPES: ArtifactType[] = ['DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE'];
const SOURCE_IDS = [
  FAKE_ARTIFACT_LINEAGE.profileRevisionId,
  FAKE_ARTIFACT_LINEAGE.offeringRevisionId,
  FAKE_ARTIFACT_LINEAGE.promptRevisionId,
  FAKE_ARTIFACT_LINEAGE.siteBaselineId,
] as const;

interface State {
  bundle: ArtifactLedgerBundle;
  writer: ArtifactWriterContext;
}

export interface InMemoryApprovedExperimentIntervention {
  artifactId: string;
  artifactRevisionId: string;
  artifactRevision: number;
  artifactContentHash: string;
  artifactReviewId: string;
  approvedAt: string;
}

export class InMemoryArtifactStore implements ArtifactStore, InMemoryTenantExportSource {
  private readonly states = new Map<string, State>();

  public constructor(private readonly audit?: InMemoryAuditSink) {}

  prepareArtifact(input: Parameters<ArtifactStore['prepareArtifact']>[0]) {
    const key = this.key(input.context.tenantId, input.context.workspaceId, input.artifactId);
    const existing = this.states.get(key);
    if (existing !== undefined) {
      return Promise.resolve({
        outcome: 'SUCCEEDED' as const,
        artifact: structuredClone(existing.bundle.artifact),
      });
    }
    const type =
      TYPES[Number.parseInt(input.briefId.at(-1) ?? '1', 16) % TYPES.length] ??
      'DEFINITION_PRODUCT';
    const artifact: ArtifactRecord = {
      id: input.artifactId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      briefId: input.briefId,
      type,
      revision: 1,
      status: 'PENDING',
      locale: input.locale,
      market: input.market,
      methodPolicyVersion: input.methodPolicyVersion,
      jobId: null,
      createdByUserId: input.context.actorUserId,
      createdAt: input.createdAt.toISOString(),
    };
    const writer: ArtifactWriterContext = {
      schemaVersion: '1.0.0',
      type,
      locale: input.locale,
      market: input.market,
      methodPolicyVersion: input.methodPolicyVersion,
      brief: {
        id: input.briefId,
        contentHash: 'b'.repeat(64),
        title: 'Approved cross-industry product brief',
        promptIds: [...FAKE_ARTIFACT_PROMPT_IDS],
        sourceArtifactIds: [...SOURCE_IDS],
        lineage: {
          contentPlanId: FAKE_ARTIFACT_LINEAGE.contentPlanId,
          brief: { id: FAKE_ARTIFACT_LINEAGE.briefId, contentHash: 'b'.repeat(64) },
          prompt: {
            promptSetId: FAKE_ARTIFACT_LINEAGE.promptSetId,
            promptRevisionId: SOURCE_IDS[2],
            contentHash: FAKE_ARTIFACT_LINEAGE.promptHash,
            promptIds: [...FAKE_ARTIFACT_PROMPT_IDS],
          },
          sourceReferences: [
            {
              kind: 'PROFILE_REVISION',
              id: SOURCE_IDS[0],
              aggregateId: FAKE_ARTIFACT_LINEAGE.profileId,
              revision: 1,
              contentHash: 'd'.repeat(64),
            },
            {
              kind: 'OFFERING_REVISION',
              id: SOURCE_IDS[1],
              aggregateId: FAKE_ARTIFACT_LINEAGE.offeringId,
              revision: 1,
              contentHash: 'e'.repeat(64),
            },
            {
              kind: 'PROMPT_REVISION',
              id: SOURCE_IDS[2],
              aggregateId: FAKE_ARTIFACT_LINEAGE.promptSetId,
              revision: 1,
              contentHash: FAKE_ARTIFACT_LINEAGE.promptHash,
            },
            {
              kind: 'SITE_BASELINE',
              id: SOURCE_IDS[3],
              aggregateId: FAKE_ARTIFACT_LINEAGE.siteId,
              revision: null,
              contentHash: null,
            },
          ],
        },
      },
      claims: [
        {
          claimId: FAKE_ARTIFACT_LINEAGE.claimId,
          revisionId: FAKE_ARTIFACT_LINEAGE.claimRevisionId,
          contentHash: FAKE_ARTIFACT_LINEAGE.claimHash,
          statement: 'The approved fixture claim is traceable to current evidence.',
          conditions: { scope: 'fake-mode demonstration' },
          evidence: [
            {
              sourceId: FAKE_ARTIFACT_LINEAGE.evidenceSourceId,
              snapshotId: FAKE_ARTIFACT_LINEAGE.evidenceSnapshotId,
              sourceHash: FAKE_ARTIFACT_LINEAGE.evidenceHash,
            },
          ],
        },
      ],
    };
    this.states.set(key, {
      bundle: {
        artifact,
        revision: null,
        revisions: [],
        reviews: [],
        approvalState: 'APPROVAL_REQUIRED',
        selectableApprovedRevisions: [],
      },
      writer,
    });
    this.appendAudit(input, 'ARTIFACT_PREPARED', input.artifactId, input.createdAt, {
      type,
      locale: input.locale,
      market: input.market,
    });
    return Promise.resolve({ outcome: 'SUCCEEDED' as const, artifact: structuredClone(artifact) });
  }

  bindJob(input: Parameters<ArtifactStore['bindJob']>[0]) {
    const state = this.state(input.context, input.artifactId);
    if (state === undefined) return Promise.resolve(null);
    state.bundle.artifact.jobId = input.jobId;
    return Promise.resolve(structuredClone(state.bundle.artifact));
  }

  loadWriterContext(input: Parameters<ArtifactStore['loadWriterContext']>[0]) {
    const state = this.state(input.context, input.artifactId);
    return Promise.resolve(state === undefined ? null : structuredClone(state.writer));
  }

  completeGeneration(input: Parameters<ArtifactStore['completeGeneration']>[0]) {
    const state = this.state(input.context, input.artifactId);
    if (state === undefined || state.bundle.artifact.status !== 'PENDING')
      return Promise.resolve(null);
    const revision: ArtifactRevisionRecord = {
      id: input.revisionId,
      artifactId: input.artifactId,
      revision: 1,
      briefId: state.bundle.artifact.briefId,
      type: state.bundle.artifact.type,
      schemaVersion: input.schemaVersion,
      contentHash: input.contentHash,
      status: 'DRAFT',
      locale: state.bundle.artifact.locale,
      market: state.bundle.artifact.market,
      sourceArtifactIds: [...input.sourceArtifactIds],
      lineage: structuredClone(input.lineage),
      claimBindings: structuredClone(input.claimBindings),
      methodPolicyVersion: state.bundle.artifact.methodPolicyVersion,
      createdByActor: input.createdByActor,
      createdAt: input.createdAt.toISOString(),
      payloadObjectRef: input.payloadObjectRef,
    };
    state.bundle.artifact.status = 'DRAFT';
    state.bundle.revision = revision;
    state.bundle.revisions = [revision];
    this.appendAudit(input, 'ARTIFACT_GENERATED', input.artifactId, input.createdAt, {
      revision: revision.revision,
      contentHash: revision.contentHash,
    });
    return Promise.resolve({
      artifact: structuredClone(state.bundle.artifact),
      revision: structuredClone(revision),
    });
  }

  createRevision(input: Parameters<ArtifactStore['createRevision']>[0]) {
    const state = this.state(input.context, input.artifactId);
    if (state === undefined || state.bundle.revision === null) {
      return Promise.resolve({ outcome: 'NOT_FOUND' as const });
    }
    if (state.bundle.artifact.revision !== input.expectedRevision) {
      return Promise.resolve({ outcome: 'REVISION_CONFLICT' as const });
    }
    const revision: ArtifactRevisionRecord = {
      ...structuredClone(state.bundle.revision),
      id: input.revisionId,
      revision: input.expectedRevision + 1,
      contentHash: input.contentHash,
      status: 'DRAFT',
      createdByActor: { kind: 'USER', id: input.context.actorUserId },
      createdAt: input.createdAt.toISOString(),
      payloadObjectRef: input.payloadObjectRef,
    };
    state.bundle.artifact.revision = revision.revision;
    state.bundle.artifact.status = 'DRAFT';
    state.bundle.revision = revision;
    state.bundle.revisions.push(revision);
    this.recalculate(state);
    this.appendAudit(input, 'ARTIFACT_REVISION_CREATED', input.artifactId, input.createdAt, {
      revision: revision.revision,
      contentHash: revision.contentHash,
    });
    return Promise.resolve({
      outcome: 'SUCCEEDED' as const,
      artifact: structuredClone(state.bundle.artifact),
      revision: structuredClone(revision),
    });
  }

  submitRevision(input: Parameters<ArtifactStore['submitRevision']>[0]) {
    const state = this.state(input.context, input.artifactId);
    const revision = state?.bundle.revisions.find((entry) => entry.revision === input.revision);
    if (state === undefined || revision === undefined)
      return Promise.resolve({ outcome: 'NOT_FOUND' as const });
    if (revision.contentHash !== input.expectedContentHash)
      return Promise.resolve({ outcome: 'HASH_MISMATCH' as const });
    if (revision.status !== 'DRAFT') return Promise.resolve({ outcome: 'INVALID_STATE' as const });
    revision.status = 'IN_REVIEW';
    if (state.bundle.artifact.revision === revision.revision)
      state.bundle.artifact.status = 'IN_REVIEW';
    this.recalculate(state);
    this.appendAudit(input, 'ARTIFACT_REVISION_SUBMITTED', input.artifactId, input.submittedAt, {
      revision: revision.revision,
      contentHash: revision.contentHash,
    });
    return Promise.resolve({ outcome: 'SUCCEEDED' as const, revision: structuredClone(revision) });
  }

  reviewRevision(input: Parameters<ArtifactStore['reviewRevision']>[0]) {
    const state = this.state(input.context, input.artifactId);
    const revision = state?.bundle.revisions.find((entry) => entry.revision === input.revision);
    if (state === undefined || revision === undefined)
      return Promise.resolve({ outcome: 'NOT_FOUND' as const });
    if (revision.contentHash !== input.expectedContentHash)
      return Promise.resolve({ outcome: 'HASH_MISMATCH' as const });
    if (
      revision.createdByActor.kind === 'USER' &&
      revision.createdByActor.id === input.context.actorUserId
    ) {
      return Promise.resolve({ outcome: 'SELF_APPROVAL' as const });
    }
    if (revision.status !== 'IN_REVIEW')
      return Promise.resolve({ outcome: 'INVALID_STATE' as const });
    if (state.bundle.reviews.some((review) => review.artifactRevisionId === revision.id)) {
      return Promise.resolve({ outcome: 'ALREADY_REVIEWED' as const });
    }
    revision.status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const review: ArtifactReviewRecord = {
      id: input.reviewId,
      artifactId: input.artifactId,
      artifactRevisionId: revision.id,
      revision: revision.revision,
      contentHash: revision.contentHash,
      decision: input.decision,
      reviewerUserId: input.context.actorUserId,
      note: input.note,
      createdAt: input.reviewedAt.toISOString(),
    };
    state.bundle.reviews.push(review);
    if (state.bundle.artifact.revision === revision.revision)
      state.bundle.artifact.status = revision.status;
    this.recalculate(state);
    this.appendAudit(
      input,
      input.decision === 'APPROVE' ? 'ARTIFACT_REVISION_APPROVED' : 'ARTIFACT_REVISION_REJECTED',
      input.artifactId,
      input.reviewedAt,
      {
        reviewId: review.id,
        revision: revision.revision,
        contentHash: revision.contentHash,
        decision: input.decision,
      },
    );
    return Promise.resolve({
      outcome: 'SUCCEEDED' as const,
      revision: structuredClone(revision),
      review: structuredClone(review),
    });
  }

  findBundle(input: Parameters<ArtifactStore['findBundle']>[0]) {
    const state = this.state(input.context, input.artifactId);
    return Promise.resolve(state === undefined ? null : structuredClone(state.bundle));
  }

  isCurrentApprovedRevision(input: {
    tenantId: string;
    workspaceId: string;
    artifactId: string;
    artifactRevisionId: string;
    revision: number;
    contentHash: string;
  }): boolean {
    const state = this.states.get(this.key(input.tenantId, input.workspaceId, input.artifactId));
    const current = state?.bundle.revision;
    return (
      state !== undefined &&
      current !== undefined &&
      current !== null &&
      state.bundle.artifact.tenantId === input.tenantId &&
      state.bundle.artifact.workspaceId === input.workspaceId &&
      state.bundle.artifact.id === input.artifactId &&
      state.bundle.artifact.revision === input.revision &&
      state.bundle.artifact.status === 'APPROVED' &&
      state.bundle.approvalState === 'ELIGIBLE' &&
      current.id === input.artifactRevisionId &&
      current.artifactId === input.artifactId &&
      current.revision === input.revision &&
      current.contentHash === input.contentHash &&
      current.status === 'APPROVED' &&
      state.bundle.selectableApprovedRevisions.some(
        (revision) =>
          revision.revision === input.revision && revision.contentHash === input.contentHash,
      ) &&
      state.bundle.reviews.some(
        (review) =>
          review.artifactId === input.artifactId &&
          review.artifactRevisionId === input.artifactRevisionId &&
          review.revision === input.revision &&
          review.contentHash === input.contentHash &&
          review.decision === 'APPROVE',
      )
    );
  }

  /** Fake-runtime effect fence; returns only the exact current approved revision. */
  findCurrentApprovedRevisionNow(input: {
    tenantId: string;
    workspaceId: string;
    artifactId: string;
    artifactRevisionId: string;
    revision: number;
    contentHash: string;
  }): ArtifactRevisionRecord | null {
    if (!this.isCurrentApprovedRevision(input)) return null;
    const current = this.states.get(this.key(input.tenantId, input.workspaceId, input.artifactId))
      ?.bundle.revision;
    return current === undefined || current === null ? null : structuredClone(current);
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
    const objects = [...this.states.values()]
      .filter((state) => state.bundle.artifact.tenantId === input.tenantId)
      .filter((state) => {
        const occurredAt = Date.parse(state.bundle.artifact.createdAt);
        return occurredAt >= from && occurredAt <= to;
      })
      .map<TenantExportSourceObject>((state) => ({
        tenantId: state.bundle.artifact.tenantId,
        workspaceId: state.bundle.artifact.workspaceId,
        kind: 'ARTIFACT',
        objectId: state.bundle.artifact.id,
        occurredAt: state.bundle.artifact.createdAt,
        payload: toJsonValue(state.bundle),
      }));
    objects.sort((left, right) =>
      `${left.kind}:${left.objectId}`.localeCompare(`${right.kind}:${right.objectId}`),
    );
    return Promise.resolve(objects);
  }

  /** Exact approved-revision projection used only by the fake Experiment candidate registry. */
  listApprovedForExperiment(context: {
    tenantId: string;
    workspaceId: string;
  }): InMemoryApprovedExperimentIntervention[] {
    return [...this.states.values()]
      .filter(
        (state) =>
          state.bundle.artifact.tenantId === context.tenantId &&
          state.bundle.artifact.workspaceId === context.workspaceId,
      )
      .flatMap((state) =>
        state.bundle.revisions.flatMap((revision) => {
          const matchingReviews = state.bundle.reviews.filter(
            (review) =>
              review.artifactId === revision.artifactId &&
              review.artifactRevisionId === revision.id &&
              review.revision === revision.revision &&
              review.contentHash === revision.contentHash &&
              review.decision === 'APPROVE',
          );
          if (revision.status !== 'APPROVED' || matchingReviews.length !== 1) return [];
          const review = matchingReviews[0];
          if (review === undefined) return [];
          return [
            {
              artifactId: revision.artifactId,
              artifactRevisionId: revision.id,
              artifactRevision: revision.revision,
              artifactContentHash: revision.contentHash,
              artifactReviewId: review.id,
              approvedAt: review.createdAt,
            },
          ];
        }),
      )
      .sort((left, right) =>
        left.approvedAt > right.approvedAt ? -1 : left.approvedAt < right.approvedAt ? 1 : 0,
      );
  }

  async recordCompletedArtifact(job: JobRecord, payloads: ArtifactPayloadStore): Promise<void> {
    if (job.jobType !== 'ARTIFACT_GENERATION') return;
    const context = {
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
      actorUserId: job.id,
      membershipId: job.id,
      role: 'OWNER' as const,
    };
    const writer = await this.loadWriterContext({
      context,
      artifactId: job.aggregateId,
      effectiveAt: new Date(),
    });
    if (writer === null) return;
    const payload = await new DeterministicArtifactGenerator().generate(writer);
    const claimBindings = writer.claims.map((claim) => ({
      claimId: claim.claimId,
      claimRevisionId: claim.revisionId,
      claimContentHash: claim.contentHash,
      claimStatement: claim.statement,
      evidence: claim.evidence,
    }));
    const contentHash = hashArtifactRevision({
      schemaVersion: writer.schemaVersion,
      artifactId: job.aggregateId,
      revision: 1,
      type: writer.type,
      locale: writer.locale,
      market: writer.market,
      sourceArtifactIds: writer.brief.sourceArtifactIds,
      lineage: writer.brief.lineage,
      claimBindings,
      methodPolicyVersion: writer.methodPolicyVersion,
      payload,
    });
    const stored = await payloads.put({
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
      artifactId: job.aggregateId,
      revision: 1,
      contentHash,
      payload,
    });
    await this.completeGeneration({
      context,
      artifactId: job.aggregateId,
      revisionId: randomUUID(),
      contentHash,
      payloadObjectRef: stored.objectRef,
      sourceArtifactIds: writer.brief.sourceArtifactIds,
      lineage: writer.brief.lineage,
      claimBindings,
      claimLinkIds: claimBindings.flatMap((binding) => binding.evidence.map(() => randomUUID())),
      schemaVersion: writer.schemaVersion,
      createdByActor: { kind: 'AGENT', id: job.id },
      createdAt: new Date(),
      auditEventId: randomUUID(),
    });
  }

  private recalculate(state: State): void {
    state.bundle.selectableApprovedRevisions = state.bundle.revisions
      .filter((revision) => revision.status === 'APPROVED')
      .map((revision) => ({ revision: revision.revision, contentHash: revision.contentHash }));
    state.bundle.approvalState =
      state.bundle.revision?.status === 'APPROVED'
        ? 'ELIGIBLE'
        : state.bundle.selectableApprovedRevisions.length > 0
          ? 'APPROVAL_STALE'
          : 'APPROVAL_REQUIRED';
  }

  private appendAudit(
    input: {
      context: { tenantId: string; workspaceId: string; actorUserId: string };
      auditEventId: string;
    },
    action: string,
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
      resourceType: 'ARTIFACT',
      resourceId,
      outcome: 'SUCCEEDED',
      metadata,
      occurredAt,
    });
  }

  private state(context: { tenantId: string; workspaceId: string }, artifactId: string) {
    return this.states.get(this.key(context.tenantId, context.workspaceId, artifactId));
  }

  private key(tenantId: string, workspaceId: string, artifactId: string): string {
    return `${tenantId}:${workspaceId}:${artifactId}`;
  }
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
