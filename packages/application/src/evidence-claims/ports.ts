import type { TenantContext } from '../identity-access/index.js';
import type {
  ClaimBundle,
  ClaimEvidenceDrillDownRecord,
  ClaimCurrentState,
  ClaimReviewRecord,
  EvidencePublicity,
  EvidenceSnapshotRecord,
  EvidenceSourceRecord,
  EvidenceSourceType,
} from '@aeostudio/domain/evidence-claims';

export interface EvidenceObjectRecord {
  tenantId: string;
  workspaceId: string;
  sourceId: string;
  snapshotId: string;
  objectRef: string;
  objectVersionId: string;
  contentHash: string;
  contentType: string;
  sizeBytes: number;
}

export interface EvidenceObjectRead extends EvidenceObjectRecord {
  body: Uint8Array;
}

export type EvidenceObjectWrite = Omit<EvidenceObjectRecord, 'objectRef' | 'objectVersionId'> & {
  body: Uint8Array;
};

/**
 * Server-owned boundary for exact immutable Evidence bytes. Callers supply
 * bytes; only this boundary may mint an object reference/version.
 */
export interface EvidenceObjectStore {
  ingestExact(input: EvidenceObjectWrite): Promise<EvidenceObjectRecord>;
  readExact(input: EvidenceObjectRecord): Promise<EvidenceObjectRead | null>;
}

export interface EvidenceClaimStore {
  createSource(input: {
    context: TenantContext;
    sourceId: string;
    sourceType: EvidenceSourceType;
    title: string;
    uri: string | null;
    license: string;
    publicity: EvidencePublicity;
    createdAt: Date;
    auditEventId: string;
  }): Promise<EvidenceSourceRecord>;
  createSnapshot(input: {
    context: TenantContext;
    snapshotId: string;
    sourceId: string;
    contentHash: string;
    objectRef: string;
    objectVersionId: string;
    contentType: string;
    sizeBytes: number;
    capturedAt: Date;
    auditEventId: string;
  }): Promise<{ snapshot: EvidenceSnapshotRecord; source: EvidenceSourceRecord } | null>;
  findSnapshots(input: {
    context: TenantContext;
    snapshotIds: string[];
  }): Promise<EvidenceSnapshotRecord[] | null>;
  createClaim(input: {
    context: TenantContext;
    claimId: string;
    revisionId: string;
    evidenceLinkIds: string[];
    statement: string;
    numericValue: number | null;
    unit: string | null;
    scope: string | null;
    conditions: string[];
    expiresAt: Date | null;
    evidence: { snapshotId: string; sourceHash: string | null; snippet: string | null }[];
    contentHash: string;
    createdAt: Date;
    auditEventId: string;
  }): Promise<ClaimBundle | null>;
  submitClaim(input: {
    context: TenantContext;
    claimId: string;
    revisionId: string;
    submittedAt: Date;
    auditEventId: string;
  }): Promise<
    | { outcome: 'SUCCEEDED'; bundle: ClaimBundle }
    | { outcome: 'NEEDS_EVIDENCE' }
    | { outcome: 'NOT_FOUND' }
  >;
  findClaimForReview(input: {
    context: TenantContext;
    claimId: string;
    revisionId: string;
  }): Promise<ClaimBundle | null>;
  reviewClaim(input: {
    context: TenantContext;
    claimId: string;
    revisionId: string;
    expectedContentHash: string;
    reviewId: string;
    decision: 'APPROVE' | 'REJECT';
    note: string;
    reviewedAt: Date;
    auditEventId: string;
  }): Promise<
    | { outcome: 'SUCCEEDED'; bundle: ClaimBundle; review: ClaimReviewRecord }
    | { outcome: 'NEEDS_EVIDENCE' }
    | { outcome: 'NOT_IN_REVIEW' }
    | { outcome: 'NOT_FOUND' }
  >;
  findEvidenceDrillDown(input: {
    context: TenantContext;
    claimId: string;
    revisionId: string;
  }): Promise<ClaimEvidenceDrillDownRecord[] | null>;
  findCurrentClaim(input: {
    context: TenantContext;
    claimId: string;
    evaluatedAt: Date;
    auditEventId: string;
  }): Promise<ClaimCurrentState | null>;
  listApprovedClaims(input: { context: TenantContext }): Promise<
    {
      claimId: string;
      revisionId: string;
      revision: number;
      statement: string;
      contentHash: string;
    }[]
  >;
}
