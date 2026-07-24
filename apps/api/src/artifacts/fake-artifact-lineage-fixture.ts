import type {
  ClaimBundle,
  ClaimEvidenceDrillDownRecord,
  ClaimReviewRecord,
} from '@aeostudio/domain/evidence-claims';
import type { PromptBundle } from '@aeostudio/domain/prompt-research';

export const FAKE_ARTIFACT_LINEAGE = {
  profileRevisionId: '00000000-0000-7000-8000-000000000901',
  offeringRevisionId: '00000000-0000-7000-8000-000000000902',
  promptRevisionId: '00000000-0000-7000-8000-000000000903',
  siteBaselineId: '00000000-0000-7000-8000-000000000904',
  contentPlanId: '00000000-0000-7000-8000-000000000909',
  briefId: '00000000-0000-7000-8000-000000000910',
  profileId: '00000000-0000-7000-8000-000000000911',
  offeringId: '00000000-0000-7000-8000-000000000912',
  claimId: '00000000-0000-7000-8000-000000000913',
  siteId: '00000000-0000-7000-8000-000000000914',
  promptSetId: '00000000-0000-7000-8000-000000000915',
  claimRevisionId: '00000000-0000-7000-8000-000000000906',
  evidenceSourceId: '00000000-0000-7000-8000-000000000907',
  evidenceSnapshotId: '00000000-0000-7000-8000-000000000908',
  evidenceLinkId: '00000000-0000-7000-8000-000000000918',
  claimReviewId: '00000000-0000-7000-8000-000000000920',
  promptScenarioId: '00000000-0000-7000-8000-000000000916',
  promptApprovalId: '00000000-0000-7000-8000-000000000917',
  promptHash: 'c'.repeat(64),
  claimHash: 'f'.repeat(64),
  evidenceHash: 'a'.repeat(64),
} as const;

export const FAKE_ARTIFACT_PROMPT_IDS = [
  '00000000-0000-7000-8000-000000000905',
  ...Array.from(
    { length: 19 },
    (_, index) => `00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
  ),
];

const CREATED_AT = '2026-01-01T00:00:00.000Z';

export function fakeArtifactPromptBundle(input: {
  tenantId: string;
  workspaceId: string;
  actorUserId: string;
}): PromptBundle {
  const prompts = FAKE_ARTIFACT_PROMPT_IDS.map((id, index) => ({
    id,
    text: `How should an evaluator assess the product's documented capabilities? Prompt ${index + 1}.`,
    persona: ['prospective evaluator', 'hands-on practitioner', 'organizational decision maker'][
      index % 3
    ]!,
    journeyStage: ['discover', 'evaluate', 'verify'][index % 3]!,
    queryType: ['definition', 'principle', 'evidence'][index % 3]!,
  }));
  return {
    promptSet: {
      id: FAKE_ARTIFACT_LINEAGE.promptSetId,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      currentRevision: 1,
      createdAt: CREATED_AT,
    },
    revision: {
      id: FAKE_ARTIFACT_LINEAGE.promptRevisionId,
      promptSetId: FAKE_ARTIFACT_LINEAGE.promptSetId,
      revision: 1,
      title: 'Approved artifact lineage prompt fixture',
      subject: 'Documented product capabilities',
      sourceContext: {
        profile: { id: FAKE_ARTIFACT_LINEAGE.profileId, revision: 1 },
        offering: { id: FAKE_ARTIFACT_LINEAGE.offeringId, revision: 1 },
        claimRevisionIds: [FAKE_ARTIFACT_LINEAGE.claimRevisionId],
      },
      prompts,
      scopes: [{ market: 'global', locale: 'en-US', region: 'global' }],
      contentHash: FAKE_ARTIFACT_LINEAGE.promptHash,
      status: 'APPROVED',
      createdByUserId: input.actorUserId,
      createdAt: CREATED_AT,
    },
    scenario: {
      id: FAKE_ARTIFACT_LINEAGE.promptScenarioId,
      promptRevisionId: FAKE_ARTIFACT_LINEAGE.promptRevisionId,
      version: 1,
      providerKey: 'fixture-provider',
      surfaceKey: 'consumer-answer-sandbox',
      model: 'fixture-answer-model',
      modelVersion: 'fixture-v1',
      account: 'fake-runtime',
      acquisitionMethod: 'MANUAL_IMPORT',
      freshSession: true,
      searchEnabled: false,
      parameters: {},
      repetitions: 3,
      contentHash: '1'.repeat(64),
      registryStatus: 'AVAILABLE',
      createdAt: CREATED_AT,
    },
    approval: {
      id: FAKE_ARTIFACT_LINEAGE.promptApprovalId,
      promptRevisionId: FAKE_ARTIFACT_LINEAGE.promptRevisionId,
      scenarioId: FAKE_ARTIFACT_LINEAGE.promptScenarioId,
      promptContentHash: FAKE_ARTIFACT_LINEAGE.promptHash,
      scenarioContentHash: '1'.repeat(64),
      approvedByUserId: input.actorUserId,
      approvedAt: CREATED_AT,
    },
    approvalCurrent: true,
    previousApprovalStale: false,
  };
}

export function fakeArtifactClaimBundle(input: {
  tenantId: string;
  workspaceId: string;
  actorUserId: string;
}): ClaimBundle {
  return {
    claim: {
      id: FAKE_ARTIFACT_LINEAGE.claimId,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      currentRevision: 1,
      createdAt: CREATED_AT,
    },
    revision: {
      id: FAKE_ARTIFACT_LINEAGE.claimRevisionId,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      claimId: FAKE_ARTIFACT_LINEAGE.claimId,
      revision: 1,
      statement: 'The approved fixture claim is traceable to current evidence.',
      numericValue: null,
      unit: null,
      scope: 'The documented product capability and its declared usage context.',
      conditions: ['Use only with the cited immutable Evidence snapshot.'],
      expiresAt: '2036-01-01T00:00:00.000Z',
      contentHash: FAKE_ARTIFACT_LINEAGE.claimHash,
      status: 'APPROVED',
      createdByUserId: input.actorUserId,
      createdAt: CREATED_AT,
      evidence: [
        {
          id: FAKE_ARTIFACT_LINEAGE.evidenceLinkId,
          snapshotId: FAKE_ARTIFACT_LINEAGE.evidenceSnapshotId,
          sourceHash: FAKE_ARTIFACT_LINEAGE.evidenceHash,
          snippet: 'The cited snapshot directly supports the documented capability statement.',
        },
      ],
    },
  };
}

export function fakeArtifactClaimReview(input: { actorUserId: string }): ClaimReviewRecord {
  return {
    id: FAKE_ARTIFACT_LINEAGE.claimReviewId,
    claimRevisionId: FAKE_ARTIFACT_LINEAGE.claimRevisionId,
    decision: 'APPROVE',
    reviewerUserId: input.actorUserId,
    contentHash: FAKE_ARTIFACT_LINEAGE.claimHash,
    note: 'Approved exact fixture Claim revision for fake Artifact lineage.',
    reviewedAt: CREATED_AT,
  };
}

export function fakeArtifactClaimEvidence(input: {
  tenantId: string;
  workspaceId: string;
}): ClaimEvidenceDrillDownRecord[] {
  return [
    {
      source: {
        id: FAKE_ARTIFACT_LINEAGE.evidenceSourceId,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        sourceType: 'PUBLIC',
        title: 'Artifact lineage evidence fixture',
        uri: 'https://example.test/evidence/artifact-lineage',
        license: 'Fixture demonstration license',
        publicity: 'PUBLIC',
        currentSnapshotId: FAKE_ARTIFACT_LINEAGE.evidenceSnapshotId,
        createdAt: CREATED_AT,
      },
      snapshot: {
        id: FAKE_ARTIFACT_LINEAGE.evidenceSnapshotId,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        sourceId: FAKE_ARTIFACT_LINEAGE.evidenceSourceId,
        contentHash: FAKE_ARTIFACT_LINEAGE.evidenceHash,
        objectRef: 'fixture://artifact-lineage/evidence.txt',
        contentType: 'text/plain',
        sizeBytes: 128,
        capturedAt: CREATED_AT,
      },
      link: {
        id: FAKE_ARTIFACT_LINEAGE.evidenceLinkId,
        snapshotId: FAKE_ARTIFACT_LINEAGE.evidenceSnapshotId,
        sourceHash: FAKE_ARTIFACT_LINEAGE.evidenceHash,
        snippet: 'The cited snapshot directly supports the documented capability statement.',
      },
    },
  ];
}
