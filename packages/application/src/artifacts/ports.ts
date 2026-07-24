import type {
  ArtifactClaimBinding,
  ArtifactLedgerBundle,
  ArtifactLineage,
  ArtifactPayload,
  ArtifactRecord,
  ArtifactReviewRecord,
  ArtifactRevisionRecord,
  ArtifactWriterContext,
} from '@aeostudio/domain/artifacts';
import type { TenantContext } from '../identity-access/index.js';

export interface ArtifactStore {
  prepareArtifact(input: {
    context: TenantContext;
    artifactId: string;
    briefId: string;
    locale: string;
    market: string;
    methodPolicyVersion: string;
    createdAt: Date;
    auditEventId: string;
  }): Promise<
    | { outcome: 'SUCCEEDED'; artifact: ArtifactRecord }
    | { outcome: 'INVALID_REFERENCE'; referenceType: string }
  >;
  bindJob(input: {
    context: TenantContext;
    artifactId: string;
    jobId: string;
  }): Promise<ArtifactRecord | null>;
  loadWriterContext(input: {
    context: TenantContext;
    artifactId: string;
    effectiveAt: Date;
  }): Promise<ArtifactWriterContext | null>;
  completeGeneration(input: {
    context: TenantContext;
    artifactId: string;
    revisionId: string;
    contentHash: string;
    payloadObjectRef: string;
    sourceArtifactIds: string[];
    lineage: ArtifactLineage;
    claimBindings: ArtifactClaimBinding[];
    claimLinkIds: string[];
    schemaVersion: '1.0.0';
    createdByActor: { kind: 'AGENT'; id: string };
    createdAt: Date;
    auditEventId: string;
  }): Promise<{ artifact: ArtifactRecord; revision: ArtifactRevisionRecord } | null>;
  createRevision(input: {
    context: TenantContext;
    artifactId: string;
    expectedRevision: number;
    revisionId: string;
    contentHash: string;
    payloadObjectRef: string;
    createdAt: Date;
    claimLinkIds: string[];
    auditEventId: string;
  }): Promise<
    | { outcome: 'SUCCEEDED'; artifact: ArtifactRecord; revision: ArtifactRevisionRecord }
    | { outcome: 'NOT_FOUND' | 'REVISION_CONFLICT' | 'INVALID_REFERENCE' }
  >;
  submitRevision(input: {
    context: TenantContext;
    artifactId: string;
    revision: number;
    expectedContentHash: string;
    submittedAt: Date;
    auditEventId: string;
  }): Promise<
    | { outcome: 'SUCCEEDED'; revision: ArtifactRevisionRecord }
    | { outcome: 'NOT_FOUND' | 'HASH_MISMATCH' | 'INVALID_STATE' }
  >;
  reviewRevision(input: {
    context: TenantContext;
    artifactId: string;
    revision: number;
    expectedContentHash: string;
    decision: 'APPROVE' | 'REJECT';
    note: string;
    reviewId: string;
    reviewedAt: Date;
    auditEventId: string;
  }): Promise<
    | {
        outcome: 'SUCCEEDED';
        revision: ArtifactRevisionRecord;
        review: ArtifactReviewRecord;
      }
    | {
        outcome:
          | 'NOT_FOUND'
          | 'HASH_MISMATCH'
          | 'INVALID_STATE'
          | 'INVALID_REFERENCE'
          | 'SELF_APPROVAL'
          | 'ALREADY_REVIEWED';
      }
  >;
  findBundle(input: {
    context: TenantContext;
    artifactId: string;
    effectiveAt: Date;
  }): Promise<ArtifactLedgerBundle | null>;
}

export interface ArtifactGenerator {
  generate(context: ArtifactWriterContext): Promise<ArtifactPayload>;
}

export interface ArtifactPayloadWriter {
  put(input: {
    tenantId: string;
    workspaceId: string;
    artifactId: string;
    revision: number;
    contentHash: string;
    payload: ArtifactPayload;
  }): Promise<{ objectRef: string }>;
}

/** Raw storage port retained for generation/recovery adapters; API reads must use a capability reader. */
export interface ArtifactPayloadStore extends ArtifactPayloadWriter {
  get(objectRef: string): Promise<ArtifactPayload | null>;
}
