export type ArtifactType = 'DEFINITION_PRODUCT' | 'COMPARISON' | 'TECHNICAL_EVIDENCE';
export type ArtifactStatus = 'PENDING' | 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'STALE';

export interface ArtifactRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  briefId: string;
  type: ArtifactType;
  revision: number;
  status: ArtifactStatus;
  locale: string;
  market: string;
  methodPolicyVersion: string;
  jobId: string | null;
  createdByUserId: string;
  createdAt: string;
}

export interface ArtifactEvidenceBinding {
  sourceId: string;
  snapshotId: string;
  sourceHash: string;
}

export interface ArtifactClaimBinding {
  claimId: string;
  claimRevisionId: string;
  claimContentHash: string;
  claimStatement: string;
  evidence: ArtifactEvidenceBinding[];
}

export type ArtifactSourceReferenceKind =
  'PROFILE_REVISION' | 'OFFERING_REVISION' | 'PROMPT_REVISION' | 'SITE_BASELINE';

export interface ArtifactSourceReference {
  kind: ArtifactSourceReferenceKind;
  id: string;
  aggregateId: string;
  revision: number | null;
  contentHash: string | null;
}

export interface ArtifactLineage {
  contentPlanId: string;
  brief: { id: string; contentHash: string };
  prompt: {
    promptSetId: string;
    promptRevisionId: string;
    contentHash: string;
    promptIds: string[];
  };
  sourceReferences: ArtifactSourceReference[];
}

export interface ArtifactWriterContext {
  schemaVersion: '1.0.0';
  type: ArtifactType;
  locale: string;
  market: string;
  methodPolicyVersion: string;
  brief: {
    id: string;
    contentHash: string;
    title: string;
    promptIds: string[];
    sourceArtifactIds: string[];
    lineage: ArtifactLineage;
  };
  claims: {
    claimId: string;
    revisionId: string;
    contentHash: string;
    statement: string;
    conditions: Record<string, unknown>;
    evidence: ArtifactEvidenceBinding[];
  }[];
}

export interface ArtifactPayload {
  title: string;
  summary: string;
  sections: { heading: string; body: string }[];
  claimMap: {
    claimRevisionId: string;
    statement: string;
    evidenceSourceIds: string[];
  }[];
  disclosure: string;
}

export interface ArtifactRevisionRecord {
  id: string;
  artifactId: string;
  revision: number;
  briefId: string;
  type: ArtifactType;
  schemaVersion: '1.0.0';
  contentHash: string;
  status: Exclude<ArtifactStatus, 'PENDING'>;
  locale: string;
  market: string;
  sourceArtifactIds: string[];
  lineage: ArtifactLineage;
  claimBindings: ArtifactClaimBinding[];
  methodPolicyVersion: string;
  createdByActor: { kind: 'USER' | 'AGENT'; id: string };
  createdAt: string;
  payloadObjectRef: string;
}

export interface ArtifactReviewRecord {
  id: string;
  artifactId: string;
  artifactRevisionId: string;
  revision: number;
  contentHash: string;
  decision: 'APPROVE' | 'REJECT';
  reviewerUserId: string;
  note: string;
  createdAt: string;
}

export type ArtifactApprovalState = 'ELIGIBLE' | 'APPROVAL_REQUIRED' | 'APPROVAL_STALE';

export interface ArtifactLedgerBundle {
  artifact: ArtifactRecord;
  revision: ArtifactRevisionRecord | null;
  revisions: ArtifactRevisionRecord[];
  reviews: ArtifactReviewRecord[];
  approvalState: ArtifactApprovalState;
  selectableApprovedRevisions: { revision: number; contentHash: string }[];
}

export interface ArtifactBundle extends ArtifactLedgerBundle {
  payload: ArtifactPayload | null;
  previousPayload: ArtifactPayload | null;
}
