import { createHash, randomUUID } from 'node:crypto';
import type { ContentPlanningStore } from '@aeostudio/application/content-planning';
import {
  buildDeterministicContentPlan,
  contentPlanReferenceErrors,
  type BriefReviewRecord,
  type ContentPlanBundle,
  type ContentPlanInputSnapshot,
  type PlannedAssetKind,
} from '@aeostudio/domain/content-planning';
import type { JobRecord } from '@aeostudio/domain/jobs-budgets';

import {
  FAKE_ARTIFACT_LINEAGE,
  FAKE_ARTIFACT_PROMPT_IDS,
} from '../artifacts/fake-artifact-lineage-fixture.js';

const FAKE_PROMPT_IDS = [
  '00000000-0000-7000-8000-000000000801',
  '00000000-0000-7000-8000-000000000802',
  '00000000-0000-7000-8000-000000000803',
];

const ARTIFACT_LINEAGE_CREATED_AT = '2026-01-01T00:00:00.000Z';

function fakeArtifactContentPlanBundle(input: {
  tenantId: string;
  workspaceId: string;
  actorUserId: string;
}): ContentPlanBundle {
  const opportunityId = '00000000-0000-7000-8000-000000000919';
  const briefHash = 'b'.repeat(64);
  const sourceArtifactIds = [
    FAKE_ARTIFACT_LINEAGE.profileRevisionId,
    FAKE_ARTIFACT_LINEAGE.offeringRevisionId,
    FAKE_ARTIFACT_LINEAGE.promptRevisionId,
    FAKE_ARTIFACT_LINEAGE.siteBaselineId,
  ];
  return {
    plan: {
      id: FAKE_ARTIFACT_LINEAGE.contentPlanId,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      jobId: null,
      status: 'READY',
      methodPolicyVersion: 'content-plan-fixture-v1',
      inputSnapshot: {
        profile: { id: FAKE_ARTIFACT_LINEAGE.profileId, revision: 1 },
        offering: { id: FAKE_ARTIFACT_LINEAGE.offeringId, revision: 1 },
        promptSetId: FAKE_ARTIFACT_LINEAGE.promptSetId,
        promptRevisionId: FAKE_ARTIFACT_LINEAGE.promptRevisionId,
        primaryClaimRevisionIds: [FAKE_ARTIFACT_LINEAGE.claimRevisionId],
        comparisonClaimRevisionIds: [],
        baselineId: FAKE_ARTIFACT_LINEAGE.siteBaselineId,
        methodPolicyVersion: 'content-plan-fixture-v1',
        profileRevisionId: FAKE_ARTIFACT_LINEAGE.profileRevisionId,
        offeringRevisionId: FAKE_ARTIFACT_LINEAGE.offeringRevisionId,
        promptIds: [...FAKE_ARTIFACT_PROMPT_IDS],
        primaryEvidenceSnapshotIds: [FAKE_ARTIFACT_LINEAGE.evidenceSnapshotId],
        comparisonEvidenceSnapshotIds: [],
        availableClaimRevisionIds: [FAKE_ARTIFACT_LINEAGE.claimRevisionId],
        availableSourceArtifactIds: sourceArtifactIds,
        comparisonEvidenceIndependent: false,
      },
      contentHash: 'd'.repeat(64),
      createdByUserId: input.actorUserId,
      createdAt: ARTIFACT_LINEAGE_CREATED_AT,
      completedAt: ARTIFACT_LINEAGE_CREATED_AT,
    },
    opportunities: [
      {
        id: opportunityId,
        contentPlanId: FAKE_ARTIFACT_LINEAGE.contentPlanId,
        key: 'DEFINITION_PRODUCT',
        assetKind: 'DEFINITION_PRODUCT',
        businessValue: 90,
        evidenceReadiness: 100,
        visibilityGap: {
          status: 'UNKNOWN',
          reason: 'No real visibility measurement baseline has been executed.',
        },
        effort: 30,
        risk: 20,
        priorityScore: 88,
        rank: 1,
        rankReason: 'The approved evidence-backed definition Brief is ready for drafting.',
        action: 'BRIEF',
        evidenceReady: true,
        publishReady: false,
      },
    ],
    briefs: [
      {
        id: FAKE_ARTIFACT_LINEAGE.briefId,
        contentPlanId: FAKE_ARTIFACT_LINEAGE.contentPlanId,
        opportunityId,
        key: 'DEFINITION_PRODUCT',
        assetKind: 'DEFINITION_PRODUCT',
        title: 'Definition and offering brief',
        promptIds: [...FAKE_ARTIFACT_PROMPT_IDS],
        claimRevisionIds: [FAKE_ARTIFACT_LINEAGE.claimRevisionId],
        sourceArtifactIds,
        status: 'APPROVED',
        evidenceReady: true,
        publishReady: false,
        contentHash: briefHash,
        createdByUserId: input.actorUserId,
        createdAt: ARTIFACT_LINEAGE_CREATED_AT,
      },
    ],
    briefReviews: [
      {
        id: '00000000-0000-7000-8000-000000000920',
        briefId: FAKE_ARTIFACT_LINEAGE.briefId,
        decision: 'APPROVE',
        contentHash: briefHash,
        reviewedByUserId: '00000000-0000-7000-8000-000000000921',
        note: 'Approved for the exact evidence-backed fixture revision.',
        reviewedAt: ARTIFACT_LINEAGE_CREATED_AT,
      },
    ],
    evidenceTasks: [],
  };
}

export class InMemoryContentPlanningStore implements ContentPlanningStore {
  private readonly bundles = new Map<string, ContentPlanBundle>();

  preparePlan(input: Parameters<ContentPlanningStore['preparePlan']>[0]) {
    const key = this.key(input.context.tenantId, input.context.workspaceId, input.planId);
    const existing = this.bundles.get(key);
    if (existing !== undefined) {
      return Promise.resolve({
        outcome: 'SUCCEEDED' as const,
        plan: structuredClone(existing.plan),
      });
    }
    const snapshot: ContentPlanInputSnapshot = {
      ...input.sourceInput,
      profileRevisionId: input.sourceInput.profile.id,
      offeringRevisionId: input.sourceInput.offering.id,
      promptIds: [...FAKE_PROMPT_IDS],
      primaryEvidenceSnapshotIds: [...input.sourceInput.primaryClaimRevisionIds],
      comparisonEvidenceSnapshotIds: [...input.sourceInput.comparisonClaimRevisionIds],
      availableClaimRevisionIds: [
        ...new Set([
          ...input.sourceInput.primaryClaimRevisionIds,
          ...input.sourceInput.comparisonClaimRevisionIds,
        ]),
      ],
      availableSourceArtifactIds: [
        input.sourceInput.profile.id,
        input.sourceInput.offering.id,
        input.sourceInput.promptRevisionId,
        input.sourceInput.baselineId,
      ],
      comparisonEvidenceIndependent:
        input.sourceInput.comparisonClaimRevisionIds.length > 0 &&
        input.sourceInput.comparisonClaimRevisionIds.every(
          (id) => !input.sourceInput.primaryClaimRevisionIds.includes(id),
        ),
    };
    const plan = {
      id: input.planId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      jobId: null,
      status: 'PENDING' as const,
      methodPolicyVersion: input.sourceInput.methodPolicyVersion,
      inputSnapshot: snapshot,
      contentHash: null,
      createdByUserId: input.context.actorUserId,
      createdAt: input.createdAt.toISOString(),
      completedAt: null,
    };
    this.bundles.set(key, {
      plan,
      opportunities: [],
      briefs: [],
      briefReviews: [],
      evidenceTasks: [],
    });
    return Promise.resolve({ outcome: 'SUCCEEDED' as const, plan: structuredClone(plan) });
  }

  bindJob(input: Parameters<ContentPlanningStore['bindJob']>[0]) {
    const bundle = this.bundles.get(
      this.key(input.context.tenantId, input.context.workspaceId, input.planId),
    );
    if (bundle === undefined) return Promise.resolve(null);
    bundle.plan.jobId = input.jobId;
    return Promise.resolve(structuredClone(bundle.plan));
  }

  findBundle(input: Parameters<ContentPlanningStore['findBundle']>[0]) {
    const bundle = this.bundles.get(
      this.key(input.context.tenantId, input.context.workspaceId, input.planId),
    );
    if (bundle !== undefined) return Promise.resolve(structuredClone(bundle));
    if (input.planId !== FAKE_ARTIFACT_LINEAGE.contentPlanId) return Promise.resolve(null);
    return Promise.resolve(
      fakeArtifactContentPlanBundle({
        tenantId: input.context.tenantId,
        workspaceId: input.context.workspaceId,
        actorUserId: input.context.actorUserId,
      }),
    );
  }

  loadInput(input: Parameters<ContentPlanningStore['loadInput']>[0]) {
    const bundle = this.bundles.get(
      this.key(input.context.tenantId, input.context.workspaceId, input.planId),
    );
    return Promise.resolve(
      bundle === undefined ? null : structuredClone(bundle.plan.inputSnapshot),
    );
  }

  completePlan(input: Parameters<ContentPlanningStore['completePlan']>[0]) {
    const key = this.key(input.context.tenantId, input.context.workspaceId, input.planId);
    const current = this.bundles.get(key);
    if (current === undefined) return Promise.resolve({ outcome: 'NOT_FOUND' as const });
    const errors = contentPlanReferenceErrors({
      snapshot: current.plan.inputSnapshot,
      result: input.result,
    });
    if (errors.length > 0) {
      current.plan.status = 'INVALID';
      current.plan.contentHash = input.contentHash;
      current.plan.completedAt = input.completedAt.toISOString();
      return Promise.resolve({ outcome: 'INVALID_REFERENCE' as const, errors });
    }
    const opportunities = input.result.opportunities.map((opportunity) => ({
      ...opportunity,
      id: input.opportunityIds[opportunity.assetKind],
      contentPlanId: input.planId,
    }));
    const briefs = input.result.briefs.map((brief) => ({
      ...brief,
      id: this.required(input.briefIds[brief.assetKind]),
      contentPlanId: input.planId,
      opportunityId: input.opportunityIds[brief.assetKind],
      contentHash: this.required(input.briefContentHashes[brief.assetKind]),
      createdByUserId: current.plan.createdByUserId,
      createdAt: input.completedAt.toISOString(),
    }));
    const evidenceTasks = input.result.evidenceTasks.map((task) => ({
      ...task,
      id: this.required(input.evidenceTaskIds[task.assetKind]),
      contentPlanId: input.planId,
      opportunityId: input.opportunityIds[task.assetKind],
    }));
    current.plan.status = 'READY';
    current.plan.contentHash = input.contentHash;
    current.plan.completedAt = input.completedAt.toISOString();
    current.opportunities = opportunities;
    current.briefs = briefs;
    current.evidenceTasks = evidenceTasks;
    return Promise.resolve({ outcome: 'SUCCEEDED' as const, bundle: structuredClone(current) });
  }

  reviewBrief(input: Parameters<ContentPlanningStore['reviewBrief']>[0]) {
    const bundle = this.bundles.get(
      this.key(input.context.tenantId, input.context.workspaceId, input.planId),
    );
    const brief = bundle?.briefs.find((entry) => entry.id === input.briefId);
    if (bundle === undefined || brief === undefined) {
      return Promise.resolve({ outcome: 'NOT_FOUND' as const });
    }
    if (brief.contentHash !== input.expectedContentHash) {
      return Promise.resolve({ outcome: 'HASH_MISMATCH' as const });
    }
    if (brief.createdByUserId === input.context.actorUserId) {
      return Promise.resolve({ outcome: 'SELF_APPROVAL' as const });
    }
    if (brief.status !== 'REVIEW_REQUIRED') {
      return Promise.resolve({ outcome: 'ALREADY_REVIEWED' as const });
    }
    brief.status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const review: BriefReviewRecord = {
      id: input.reviewId,
      briefId: brief.id,
      decision: input.decision,
      contentHash: input.expectedContentHash,
      reviewedByUserId: input.context.actorUserId,
      note: input.note,
      reviewedAt: input.reviewedAt.toISOString(),
    };
    bundle.briefReviews.push(review);
    return Promise.resolve({
      outcome: 'SUCCEEDED' as const,
      brief: structuredClone(brief),
      review: structuredClone(review),
    });
  }

  async recordCompletedPlan(job: JobRecord): Promise<void> {
    if (job.jobType !== 'CONTENT_PLAN') return;
    const context = {
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
      actorUserId: job.id,
      membershipId: job.id,
      role: 'OWNER' as const,
    };
    const snapshot = await this.loadInput({ context, planId: job.aggregateId });
    if (snapshot === null) return;
    const result = buildDeterministicContentPlan(snapshot);
    const assetKinds: PlannedAssetKind[] = [
      'DEFINITION_PRODUCT',
      'COMPARISON',
      'TECHNICAL_EVIDENCE',
    ];
    const opportunityIds = Object.fromEntries(
      assetKinds.map((assetKind) => [assetKind, randomUUID()]),
    ) as Record<PlannedAssetKind, string>;
    const briefIds: Partial<Record<PlannedAssetKind, string>> = {};
    const briefContentHashes: Partial<Record<PlannedAssetKind, string>> = {};
    for (const brief of result.briefs) {
      briefIds[brief.assetKind] = randomUUID();
      briefContentHashes[brief.assetKind] = this.hash({
        methodPolicyVersion: result.methodPolicyVersion,
        ...brief,
      });
    }
    const evidenceTaskIds: Partial<Record<PlannedAssetKind, string>> = {};
    for (const task of result.evidenceTasks) evidenceTaskIds[task.assetKind] = randomUUID();
    await this.completePlan({
      context,
      planId: job.aggregateId,
      result,
      contentHash: this.hash({ snapshot, result }),
      opportunityIds,
      briefIds,
      briefContentHashes,
      evidenceTaskIds,
      completedAt: new Date(),
      auditEventId: randomUUID(),
    });
  }

  private required(value: string | undefined): string {
    if (value === undefined) throw new Error('FAKE_CONTENT_PLAN_ID_OR_HASH_MISSING');
    return value;
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(this.canonicalJson(value), 'utf8').digest('hex');
  }

  private canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return `[${value.map((entry) => this.canonicalJson(entry)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${this.canonicalJson(record[key])}`)
      .join(',')}}`;
  }

  private key(tenantId: string, workspaceId: string, planId: string): string {
    return `${tenantId}:${workspaceId}:${planId}`;
  }
}
