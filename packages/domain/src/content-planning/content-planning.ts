export const CONTENT_PLAN_METHOD_VERSION = 'content-plan-v1';

export type PlannedAssetKind = 'DEFINITION_PRODUCT' | 'COMPARISON' | 'TECHNICAL_EVIDENCE';
export type ContentPlanStatus = 'PENDING' | 'READY' | 'INVALID';
export type BriefStatus = 'REVIEW_REQUIRED' | 'APPROVED' | 'REJECTED';

export interface ContentPlanSourceInput {
  profile: { id: string; revision: number };
  offering: { id: string; revision: number };
  promptSetId: string;
  promptRevisionId: string;
  primaryClaimRevisionIds: string[];
  comparisonClaimRevisionIds: string[];
  baselineId: string;
  methodPolicyVersion: string;
}

export interface ContentPlanInputSnapshot extends ContentPlanSourceInput {
  profileRevisionId: string;
  offeringRevisionId: string;
  promptIds: string[];
  primaryEvidenceSnapshotIds: string[];
  comparisonEvidenceSnapshotIds: string[];
  availableClaimRevisionIds: string[];
  availableSourceArtifactIds: string[];
  comparisonEvidenceIndependent: boolean;
}

export interface ContentPlanRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  jobId: string | null;
  status: ContentPlanStatus;
  methodPolicyVersion: string;
  inputSnapshot: ContentPlanInputSnapshot;
  contentHash: string | null;
  createdByUserId: string;
  createdAt: string;
  completedAt: string | null;
}

export interface OpportunitySkeleton {
  key: PlannedAssetKind;
  assetKind: PlannedAssetKind;
  businessValue: number;
  evidenceReadiness: number;
  visibilityGap: { status: 'UNKNOWN'; reason: string };
  effort: number;
  risk: number;
  priorityScore: number;
  rank: number;
  rankReason: string;
  action: 'BRIEF' | 'EVIDENCE_TASK';
  evidenceReady: boolean;
  publishReady: false;
}

export interface BriefSkeleton {
  key: PlannedAssetKind;
  assetKind: PlannedAssetKind;
  title: string;
  promptIds: string[];
  claimRevisionIds: string[];
  sourceArtifactIds: string[];
  status: 'REVIEW_REQUIRED';
  evidenceReady: true;
  publishReady: false;
}

export interface EvidenceTaskSkeleton {
  key: PlannedAssetKind;
  assetKind: PlannedAssetKind;
  reasonCode: 'PRIMARY_CLAIM_EVIDENCE_REQUIRED' | 'INDEPENDENT_COMPARISON_EVIDENCE_REQUIRED';
  detail: string;
}

export interface ContentPlanResultSkeleton {
  methodPolicyVersion: string;
  opportunities: OpportunitySkeleton[];
  briefs: BriefSkeleton[];
  evidenceTasks: EvidenceTaskSkeleton[];
}

export interface OpportunityRecord extends OpportunitySkeleton {
  id: string;
  contentPlanId: string;
}

export interface BriefRecord extends Omit<BriefSkeleton, 'status'> {
  id: string;
  contentPlanId: string;
  opportunityId: string;
  status: BriefStatus;
  contentHash: string;
  createdByUserId: string;
  createdAt: string;
}

export interface BriefReviewRecord {
  id: string;
  briefId: string;
  decision: 'APPROVE' | 'REJECT';
  contentHash: string;
  reviewedByUserId: string;
  note: string;
  reviewedAt: string;
}

export interface EvidenceTaskRecord extends EvidenceTaskSkeleton {
  id: string;
  contentPlanId: string;
  opportunityId: string;
}

export interface ContentPlanBundle {
  plan: ContentPlanRecord;
  opportunities: OpportunityRecord[];
  briefs: BriefRecord[];
  briefReviews: BriefReviewRecord[];
  evidenceTasks: EvidenceTaskRecord[];
}

const POLICY = {
  businessValueWeight: 0.4,
  evidenceReadinessWeight: 0.35,
  effortWeight: 0.15,
  riskWeight: 0.1,
} as const;

function score(input: {
  businessValue: number;
  evidenceReadiness: number;
  effort: number;
  risk: number;
}): number {
  return Number(
    (
      input.businessValue * POLICY.businessValueWeight +
      input.evidenceReadiness * POLICY.evidenceReadinessWeight +
      (100 - input.effort) * POLICY.effortWeight +
      (100 - input.risk) * POLICY.riskWeight
    ).toFixed(2),
  );
}

export function buildDeterministicContentPlan(
  input: ContentPlanInputSnapshot,
): ContentPlanResultSkeleton {
  const primaryReady = input.primaryClaimRevisionIds.length > 0;
  const comparisonReady =
    input.comparisonClaimRevisionIds.length > 0 && input.comparisonEvidenceIndependent;
  const definitions = [
    {
      key: 'DEFINITION_PRODUCT' as const,
      businessValue: 90,
      evidenceReadiness: primaryReady ? 100 : 0,
      effort: 30,
      risk: primaryReady ? 20 : 80,
      evidenceReady: primaryReady,
    },
    {
      key: 'TECHNICAL_EVIDENCE' as const,
      businessValue: 82,
      evidenceReadiness: primaryReady ? 95 : 0,
      effort: 45,
      risk: primaryReady ? 25 : 85,
      evidenceReady: primaryReady,
    },
    {
      key: 'COMPARISON' as const,
      businessValue: 78,
      evidenceReadiness: comparisonReady ? 100 : 0,
      effort: 60,
      risk: comparisonReady ? 45 : 95,
      evidenceReady: comparisonReady,
    },
  ];
  const opportunities = definitions
    .map((definition) => ({
      ...definition,
      assetKind: definition.key,
      visibilityGap: {
        status: 'UNKNOWN' as const,
        reason: 'No real visibility measurement baseline has been executed.',
      },
      priorityScore: score(definition),
      rank: 0,
      rankReason: '',
      action: definition.evidenceReady ? ('BRIEF' as const) : ('EVIDENCE_TASK' as const),
      publishReady: false as const,
    }))
    .sort(
      (left, right) =>
        right.priorityScore - left.priorityScore || left.assetKind.localeCompare(right.assetKind),
    )
    .map((opportunity, index) => ({
      ...opportunity,
      rank: index + 1,
      rankReason:
        `Policy ${input.methodPolicyVersion}: business ${opportunity.businessValue}×0.40 + ` +
        `evidence ${opportunity.evidenceReadiness}×0.35 + inverse effort ${100 - opportunity.effort}×0.15 + ` +
        `inverse risk ${100 - opportunity.risk}×0.10; visibility gap remains UNKNOWN and is not scored.`,
    }));

  const commonSources = [
    input.profileRevisionId,
    input.offeringRevisionId,
    input.promptRevisionId,
    input.baselineId,
  ];
  const primaryClaim = input.primaryClaimRevisionIds[0];
  const comparisonClaim = input.comparisonClaimRevisionIds[0];
  const briefDefinitions: {
    key: PlannedAssetKind;
    title: string;
    promptIndex: number;
    claims: string[];
    ready: boolean;
  }[] = [
    {
      key: 'DEFINITION_PRODUCT',
      title: 'Definition and offering brief',
      promptIndex: 0,
      claims: primaryClaim === undefined ? [] : [primaryClaim],
      ready: primaryReady,
    },
    {
      key: 'TECHNICAL_EVIDENCE',
      title: 'Technical and evidence brief',
      promptIndex: 1,
      claims: primaryClaim === undefined ? [] : [primaryClaim],
      ready: primaryReady,
    },
    {
      key: 'COMPARISON',
      title: 'Evidence-balanced comparison brief',
      promptIndex: 2,
      claims:
        primaryClaim === undefined || comparisonClaim === undefined
          ? []
          : [primaryClaim, comparisonClaim],
      ready: comparisonReady,
    },
  ];
  const briefs: BriefSkeleton[] = briefDefinitions
    .filter((definition) => definition.ready)
    .map((definition) => {
      const promptId = input.promptIds[definition.promptIndex];
      return {
        key: definition.key,
        assetKind: definition.key,
        title: definition.title,
        promptIds: promptId === undefined ? [] : [promptId],
        claimRevisionIds: definition.claims,
        sourceArtifactIds: commonSources,
        status: 'REVIEW_REQUIRED',
        evidenceReady: true,
        publishReady: false,
      };
    });
  const evidenceTasks: EvidenceTaskSkeleton[] = briefDefinitions
    .filter((definition) => !definition.ready)
    .map((definition) =>
      definition.key === 'COMPARISON'
        ? {
            key: definition.key,
            assetKind: definition.key,
            reasonCode: 'INDEPENDENT_COMPARISON_EVIDENCE_REQUIRED',
            detail:
              'Register and approve independently sourced comparison Claims before creating a comparison brief.',
          }
        : {
            key: definition.key,
            assetKind: definition.key,
            reasonCode: 'PRIMARY_CLAIM_EVIDENCE_REQUIRED',
            detail:
              'Register and approve evidence-backed primary Claims before creating this brief.',
          },
    );
  return { methodPolicyVersion: input.methodPolicyVersion, opportunities, briefs, evidenceTasks };
}

export function contentPlanReferenceErrors(input: {
  snapshot: ContentPlanInputSnapshot;
  result: ContentPlanResultSkeleton;
}): string[] {
  const errors: string[] = [];
  const promptIds = new Set(input.snapshot.promptIds);
  const claimIds = new Set(input.snapshot.availableClaimRevisionIds);
  const artifactIds = new Set(input.snapshot.availableSourceArtifactIds);
  for (const brief of input.result.briefs) {
    if (brief.promptIds.length === 0 || brief.promptIds.some((id) => !promptIds.has(id))) {
      errors.push(`${brief.key}:DANGLING_PROMPT_REFERENCE`);
    }
    if (
      brief.claimRevisionIds.length === 0 ||
      brief.claimRevisionIds.some((id) => !claimIds.has(id))
    ) {
      errors.push(`${brief.key}:DANGLING_CLAIM_REFERENCE`);
    }
    if (
      brief.sourceArtifactIds.length === 0 ||
      brief.sourceArtifactIds.some((id) => !artifactIds.has(id))
    ) {
      errors.push(`${brief.key}:DANGLING_SOURCE_ARTIFACT_REFERENCE`);
    }
  }
  return errors;
}
