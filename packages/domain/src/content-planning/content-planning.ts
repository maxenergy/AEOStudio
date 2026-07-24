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

// ============================================================================
// C06: Data-driven Content Plan with Signal Vectors
// ============================================================================

export interface SignalUnknown {
  status: 'UNKNOWN';
  reason: string;
}

export interface OpportunitySignalVector {
  businessPriority: number;
  evidenceReadiness: number;
  technicalReadiness: number;
  contentCoverageGap: number;
  promptCoverageGap: number;
  searchOpportunity: SignalUnknown | { status: 'AVAILABLE'; value: number };
  aiVisibilityObservation: SignalUnknown | { status: 'AVAILABLE'; value: number };
  competitorEvidenceGap: number;
  effort: number;
  risk: number;
  freshnessExpiry: string | null;
  methodPolicyVersion: string;
}

export interface RankingPolicyV1 {
  version: string;
  weights: {
    businessPriority: number;
    evidenceReadiness: number;
    technicalReadiness: number;
    contentCoverageGap: number;
    effort: number;
    risk: number;
  };
}

export const RANKING_POLICY_V1: RankingPolicyV1 = {
  version: 'ranking-policy-v1',
  weights: {
    businessPriority: 0.3,
    evidenceReadiness: 0.25,
    technicalReadiness: 0.15,
    contentCoverageGap: 0.15,
    effort: 0.1,
    risk: 0.05,
  },
};

export function computePriorityScore(
  signals: OpportunitySignalVector,
  policy: RankingPolicyV1,
): number {
  const w = policy.weights;
  return Number(
    (
      signals.businessPriority * w.businessPriority +
      signals.evidenceReadiness * w.evidenceReadiness +
      signals.technicalReadiness * w.technicalReadiness +
      signals.contentCoverageGap * w.contentCoverageGap +
      (100 - signals.effort) * w.effort +
      (100 - signals.risk) * w.risk
    ).toFixed(2),
  );
}

export interface DataDrivenOpportunity extends OpportunitySkeleton {
  signals: OpportunitySignalVector;
}

export interface DataDrivenContentPlanResult {
  methodPolicyVersion: string;
  contentHash: string;
  opportunities: DataDrivenOpportunity[];
  briefs: BriefSkeleton[];
  evidenceTasks: EvidenceTaskSkeleton[];
}

function simpleHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

export function buildDataDrivenContentPlan(
  input: ContentPlanInputSnapshot,
  policy: RankingPolicyV1 = RANKING_POLICY_V1,
): DataDrivenContentPlanResult {
  const primaryReady = input.primaryClaimRevisionIds.length > 0;
  const comparisonReady =
    input.comparisonClaimRevisionIds.length > 0 && input.comparisonEvidenceIndependent;
  const hasBaseline = input.baselineId.length > 0;
  const promptCount = input.promptIds.length;

  const definitions: {
    key: PlannedAssetKind;
    businessPriority: number;
    evidenceReadiness: number;
    technicalReadiness: number;
    contentCoverageGap: number;
    promptCoverageGap: number;
    competitorEvidenceGap: number;
    effort: number;
    risk: number;
    evidenceReady: boolean;
  }[] = [
    {
      key: 'DEFINITION_PRODUCT',
      businessPriority: primaryReady ? 85 : 60,
      evidenceReadiness: primaryReady
        ? Math.min(100, input.primaryEvidenceSnapshotIds.length * 50)
        : 0,
      technicalReadiness: hasBaseline ? 75 : 30,
      contentCoverageGap: promptCount >= 3 ? 40 : 70,
      promptCoverageGap: promptCount >= 3 ? 30 : 60,
      competitorEvidenceGap: 50,
      effort: 30,
      risk: primaryReady ? 20 : 80,
      evidenceReady: primaryReady,
    },
    {
      key: 'TECHNICAL_EVIDENCE',
      businessPriority: primaryReady ? 78 : 55,
      evidenceReadiness: primaryReady
        ? Math.min(95, input.primaryEvidenceSnapshotIds.length * 45)
        : 0,
      technicalReadiness: hasBaseline ? 85 : 25,
      contentCoverageGap: promptCount >= 2 ? 35 : 65,
      promptCoverageGap: promptCount >= 2 ? 25 : 55,
      competitorEvidenceGap: 40,
      effort: 45,
      risk: primaryReady ? 25 : 85,
      evidenceReady: primaryReady,
    },
    {
      key: 'COMPARISON',
      businessPriority: comparisonReady ? 72 : 50,
      evidenceReadiness: comparisonReady
        ? Math.min(100, input.comparisonEvidenceSnapshotIds.length * 50)
        : 0,
      technicalReadiness: hasBaseline ? 65 : 20,
      contentCoverageGap: 55,
      promptCoverageGap: 45,
      competitorEvidenceGap: comparisonReady ? 30 : 90,
      effort: 60,
      risk: comparisonReady ? 45 : 95,
      evidenceReady: comparisonReady,
    },
  ];

  const opportunities: DataDrivenOpportunity[] = definitions
    .map((def) => {
      const signals: OpportunitySignalVector = {
        businessPriority: def.businessPriority,
        evidenceReadiness: def.evidenceReadiness,
        technicalReadiness: def.technicalReadiness,
        contentCoverageGap: def.contentCoverageGap,
        promptCoverageGap: def.promptCoverageGap,
        searchOpportunity: { status: 'UNKNOWN', reason: 'No Search Console data available.' },
        aiVisibilityObservation: {
          status: 'UNKNOWN',
          reason: 'No real visibility measurement baseline has been executed.',
        },
        competitorEvidenceGap: def.competitorEvidenceGap,
        effort: def.effort,
        risk: def.risk,
        freshnessExpiry: null,
        methodPolicyVersion: input.methodPolicyVersion,
      };
      const priorityScore = computePriorityScore(signals, policy);
      return {
        key: def.key,
        assetKind: def.key,
        businessValue: def.businessPriority,
        evidenceReadiness: def.evidenceReadiness,
        visibilityGap: {
          status: 'UNKNOWN' as const,
          reason: 'No real visibility measurement baseline has been executed.',
        },
        effort: def.effort,
        risk: def.risk,
        priorityScore,
        rank: 0,
        rankReason: '',
        action: def.evidenceReady ? ('BRIEF' as const) : ('EVIDENCE_TASK' as const),
        evidenceReady: def.evidenceReady,
        publishReady: false as const,
        signals,
      };
    })
    .sort(
      (left, right) =>
        right.priorityScore - left.priorityScore || left.assetKind.localeCompare(right.assetKind),
    )
    .map((opp, index) => ({
      ...opp,
      rank: index + 1,
      rankReason:
        `Policy ${policy.version} (${input.methodPolicyVersion}): ` +
        `biz ${opp.signals.businessPriority}\u00d7${policy.weights.businessPriority} + ` +
        `evidence ${opp.signals.evidenceReadiness}\u00d7${policy.weights.evidenceReadiness} + ` +
        `technical ${opp.signals.technicalReadiness}\u00d7${policy.weights.technicalReadiness} + ` +
        `coverage ${opp.signals.contentCoverageGap}\u00d7${policy.weights.contentCoverageGap} + ` +
        `inv-effort ${100 - opp.signals.effort}\u00d7${policy.weights.effort} + ` +
        `inv-risk ${100 - opp.signals.risk}\u00d7${policy.weights.risk}; ` +
        `visibility UNKNOWN (not scored).`,
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
    .filter((d) => d.ready)
    .map((d) => {
      const promptId = input.promptIds[d.promptIndex];
      return {
        key: d.key,
        assetKind: d.key,
        title: d.title,
        promptIds: promptId === undefined ? [] : [promptId],
        claimRevisionIds: d.claims,
        sourceArtifactIds: commonSources,
        status: 'REVIEW_REQUIRED',
        evidenceReady: true,
        publishReady: false,
      };
    });
  const evidenceTasks: EvidenceTaskSkeleton[] = briefDefinitions
    .filter((d) => !d.ready)
    .map((d) =>
      d.key === 'COMPARISON'
        ? {
            key: d.key,
            assetKind: d.key,
            reasonCode: 'INDEPENDENT_COMPARISON_EVIDENCE_REQUIRED',
            detail:
              'Register and approve independently sourced comparison Claims before creating a comparison brief.',
          }
        : {
            key: d.key,
            assetKind: d.key,
            reasonCode: 'PRIMARY_CLAIM_EVIDENCE_REQUIRED',
            detail:
              'Register and approve evidence-backed primary Claims before creating this brief.',
          },
    );

  const contentHash = simpleHash(
    JSON.stringify({
      policy: policy.version,
      method: input.methodPolicyVersion,
      opportunities: opportunities.map((o) => ({
        kind: o.assetKind,
        score: o.priorityScore,
        signals: o.signals,
      })),
      briefs: briefs.map((b) => b.key),
      tasks: evidenceTasks.map((t) => t.key),
      inputs: {
        primary: input.primaryClaimRevisionIds,
        comparison: input.comparisonClaimRevisionIds,
        prompts: input.promptIds,
        baseline: input.baselineId,
      },
    }),
  );

  return {
    methodPolicyVersion: input.methodPolicyVersion,
    contentHash,
    opportunities,
    briefs,
    evidenceTasks,
  };
}
