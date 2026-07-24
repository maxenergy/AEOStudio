export type EvidenceSourceType = 'UPLOAD' | 'CRAWL' | 'PUBLIC';
export type EvidencePublicity = 'PRIVATE' | 'PUBLIC' | 'RESTRICTED';

export interface EvidenceSourceRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  sourceType: EvidenceSourceType;
  title: string;
  uri: string | null;
  license: string;
  publicity: EvidencePublicity;
  currentSnapshotId: string | null;
  createdAt: string;
}

export interface EvidenceSnapshotRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  sourceId: string;
  contentHash: string;
  objectRef: string;
  objectVersionId: string;
  contentType: string;
  sizeBytes: number;
  capturedAt: string;
}

export type ClaimRevisionStatus =
  'NEEDS_EVIDENCE' | 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'STALE';

export interface ClaimRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  currentRevision: number;
  createdAt: string;
}

export interface ClaimEvidenceLinkRecord {
  id: string;
  snapshotId: string;
  sourceHash: string | null;
  snippet: string | null;
}

export interface ClaimRevisionRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  claimId: string;
  revision: number;
  statement: string;
  numericValue: number | null;
  unit: string | null;
  scope: string | null;
  conditions: string[];
  expiresAt: string | null;
  contentHash: string;
  status: ClaimRevisionStatus;
  createdByUserId: string;
  createdAt: string;
  evidence: ClaimEvidenceLinkRecord[];
}

export interface ClaimBundle {
  claim: ClaimRecord;
  revision: ClaimRevisionRecord;
}

export interface ClaimReviewRecord {
  id: string;
  claimRevisionId: string;
  decision: 'APPROVE' | 'REJECT';
  reviewerUserId: string;
  contentHash: string;
  note: string;
  reviewedAt: string;
}

export interface ClaimEvidenceDrillDownRecord {
  source: EvidenceSourceRecord;
  snapshot: EvidenceSnapshotRecord;
  link: ClaimEvidenceLinkRecord;
}

export interface ClaimCurrentState extends ClaimBundle {
  currentUsable: boolean;
  staleReasons: ('SOURCE_CHANGED' | 'EXPIRED' | 'NOT_APPROVED')[];
  reviewRequired: boolean;
}
