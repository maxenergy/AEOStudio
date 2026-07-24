import {
  CreateArtifactRevisionEnvelopeSchema,
  ReviewArtifactRevisionEnvelopeSchema,
  SubmitArtifactRevisionEnvelopeSchema,
} from '@aeostudio/contracts/artifacts';
import { describe, expect, test } from 'vitest';

const ids = {
  artifact: '018f3b76-1000-7000-8000-000000000001',
  tenant: '018f3b76-1000-7000-8000-000000000002',
  workspace: '018f3b76-1000-7000-8000-000000000003',
  brief: '018f3b76-1000-7000-8000-000000000004',
  user: '018f3b76-1000-7000-8000-000000000005',
  revision: '018f3b76-1000-7000-8000-000000000006',
  contentPlan: '018f3b76-1000-7000-8000-000000000007',
  promptSet: '018f3b76-1000-7000-8000-000000000008',
  promptRevision: '018f3b76-1000-7000-8000-000000000009',
  prompt: '018f3b76-1000-7000-8000-000000000010',
  source: '018f3b76-1000-7000-8000-000000000011',
  claim: '018f3b76-1000-7000-8000-000000000012',
  claimRevision: '018f3b76-1000-7000-8000-000000000013',
  snapshot: '018f3b76-1000-7000-8000-000000000014',
  review: '018f3b76-1000-7000-8000-000000000015',
} as const;

const hash = 'a'.repeat(64);
const createdAt = '2026-07-24T00:00:00.000Z';

const artifact = {
  id: ids.artifact,
  tenantId: ids.tenant,
  workspaceId: ids.workspace,
  briefId: ids.brief,
  type: 'DEFINITION_PRODUCT',
  revision: 2,
  status: 'DRAFT',
  locale: 'en-SG',
  market: 'SG',
  methodPolicyVersion: 'artifact-fixture-v1',
  jobId: null,
  createdByUserId: ids.user,
  createdAt,
} as const;

const revision = {
  id: ids.revision,
  artifactId: ids.artifact,
  revision: 2,
  briefId: ids.brief,
  type: 'DEFINITION_PRODUCT',
  schemaVersion: '1.0.0',
  contentHash: hash,
  status: 'DRAFT',
  locale: 'en-SG',
  market: 'SG',
  sourceArtifactIds: [ids.source],
  lineage: {
    contentPlanId: ids.contentPlan,
    brief: { id: ids.brief, contentHash: hash },
    prompt: {
      promptSetId: ids.promptSet,
      promptRevisionId: ids.promptRevision,
      contentHash: hash,
      promptIds: [ids.prompt],
    },
    sourceReferences: [
      {
        kind: 'PROFILE_REVISION',
        id: ids.source,
        aggregateId: ids.source,
        revision: 1,
        contentHash: hash,
      },
      {
        kind: 'OFFERING_REVISION',
        id: ids.source,
        aggregateId: ids.source,
        revision: 1,
        contentHash: hash,
      },
      {
        kind: 'PROMPT_REVISION',
        id: ids.promptRevision,
        aggregateId: ids.promptSet,
        revision: 1,
        contentHash: hash,
      },
      {
        kind: 'SITE_BASELINE',
        id: ids.source,
        aggregateId: ids.source,
        revision: null,
        contentHash: null,
      },
    ],
  },
  claimBindings: [
    {
      claimId: ids.claim,
      claimRevisionId: ids.claimRevision,
      claimContentHash: hash,
      claimStatement: 'A supported claim.',
      evidence: [{ sourceId: ids.source, snapshotId: ids.snapshot, sourceHash: hash }],
    },
  ],
  methodPolicyVersion: 'artifact-fixture-v1',
  createdByActor: { kind: 'USER', id: ids.user },
  createdAt,
  payloadObjectRef: 's3://artifact-fixture/revision-2.json',
} as const;

const meta = { requestId: 'request-1', schemaVersion: '1.0.0' } as const;

describe('Artifact revision success response contracts', () => {
  test('create revision returns the exact Artifact and immutable revision envelope', () => {
    const envelope = { data: { artifact, revision }, meta };

    expect(CreateArtifactRevisionEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(
      CreateArtifactRevisionEnvelopeSchema.safeParse({
        ...envelope,
        data: { ...envelope.data, uncontracted: true },
      }).success,
    ).toBe(false);
  });

  test('submit revision returns only the exact submitted revision envelope', () => {
    const envelope = {
      data: { revision: { ...revision, status: 'IN_REVIEW' as const } },
      meta,
    };

    expect(SubmitArtifactRevisionEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(
      SubmitArtifactRevisionEnvelopeSchema.safeParse({
        ...envelope,
        data: { ...envelope.data, artifact },
      }).success,
    ).toBe(false);
  });

  test('review revision returns the exact reviewed revision and immutable review envelope', () => {
    const reviewedRevision = { ...revision, status: 'APPROVED' as const };
    const review = {
      id: ids.review,
      artifactId: ids.artifact,
      artifactRevisionId: ids.revision,
      revision: 2,
      contentHash: hash,
      decision: 'APPROVE' as const,
      reviewerUserId: ids.user,
      note: 'Evidence and lineage verified.',
      createdAt,
    };
    const envelope = { data: { revision: reviewedRevision, review }, meta };

    expect(ReviewArtifactRevisionEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(
      ReviewArtifactRevisionEnvelopeSchema.safeParse({
        ...envelope,
        data: { ...envelope.data, review: { ...review, mutable: true } },
      }).success,
    ).toBe(false);
  });
});
