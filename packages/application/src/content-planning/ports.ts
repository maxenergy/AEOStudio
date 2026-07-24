import type { TenantContext } from '../identity-access/index.js';
import type {
  ContentPlanBundle,
  ContentPlanInputSnapshot,
  ContentPlanRecord,
  ContentPlanResultSkeleton,
  ContentPlanSourceInput,
  PlannedAssetKind,
} from '@aeostudio/domain/content-planning';

export interface ContentPlanningStore {
  preparePlan(input: {
    context: TenantContext;
    planId: string;
    sourceInput: ContentPlanSourceInput;
    createdAt: Date;
    auditEventId: string;
  }): Promise<
    | { outcome: 'SUCCEEDED'; plan: ContentPlanRecord }
    | { outcome: 'INVALID_REFERENCE'; referenceType: string }
  >;
  bindJob(input: {
    context: TenantContext;
    planId: string;
    jobId: string;
  }): Promise<ContentPlanRecord | null>;
  findBundle(input: { context: TenantContext; planId: string }): Promise<ContentPlanBundle | null>;
  loadInput(input: {
    context: TenantContext;
    planId: string;
  }): Promise<ContentPlanInputSnapshot | null>;
  completePlan(input: {
    context: TenantContext;
    planId: string;
    result: ContentPlanResultSkeleton;
    contentHash: string;
    opportunityIds: Record<PlannedAssetKind, string>;
    briefIds: Partial<Record<PlannedAssetKind, string>>;
    briefContentHashes: Partial<Record<PlannedAssetKind, string>>;
    evidenceTaskIds: Partial<Record<PlannedAssetKind, string>>;
    completedAt: Date;
    auditEventId: string;
  }): Promise<
    | { outcome: 'SUCCEEDED'; bundle: ContentPlanBundle }
    | { outcome: 'INVALID_REFERENCE'; errors: string[] }
    | { outcome: 'NOT_FOUND' }
  >;
  reviewBrief(input: {
    context: TenantContext;
    planId: string;
    briefId: string;
    decision: 'APPROVE' | 'REJECT';
    expectedContentHash: string;
    note: string;
    reviewId: string;
    reviewedAt: Date;
    auditEventId: string;
  }): Promise<
    | {
        outcome: 'SUCCEEDED';
        brief: ContentPlanBundle['briefs'][number];
        review: ContentPlanBundle['briefReviews'][number];
      }
    | { outcome: 'NOT_FOUND' | 'HASH_MISMATCH' | 'SELF_APPROVAL' | 'ALREADY_REVIEWED' }
  >;
  listApprovedBriefs(input: { context: TenantContext }): Promise<
    { briefId: string; planId: string; assetKind: string; title: string; contentHash: string; status: string }[]
  >;
}
