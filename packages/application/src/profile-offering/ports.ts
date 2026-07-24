import type {
  CompletenessSummary,
  DynamicAttribute,
  OfferingContent,
  OfferingRevision,
  ProfileContent,
  ProfileRevision,
} from '@aeostudio/domain/profile-offering';
import type { JobRecord } from '@aeostudio/domain/jobs-budgets';
import type { TenantContext } from '../identity-access/index.js';

export interface CreateProfileStoreInput {
  context: TenantContext;
  profileId: string;
  revisionId: string;
  contentHash: string;
  content: ProfileContent;
  completeness: CompletenessSummary;
  auditEventId: string;
}

export interface ProfileOfferingStore {
  createProfile(input: CreateProfileStoreInput): Promise<ProfileRevision>;
  createProfileRevision(input: {
    context: TenantContext;
    profileId: string;
    revisionId: string;
    contentHash: string;
    content: ProfileContent;
    completeness: CompletenessSummary;
    auditEventId: string;
  }): Promise<ProfileRevision | null>;
  findProfileRevision(input: {
    context: TenantContext;
    profileId: string;
    revision: number;
  }): Promise<ProfileRevision | null>;
  createOffering(input: {
    context: TenantContext;
    profileId: string;
    offeringId: string;
    revisionId: string;
    contentHash: string;
    content: OfferingContent;
    completeness: CompletenessSummary;
    attributes: {
      definitionId: string;
      valueId: string;
      attribute: DynamicAttribute;
    }[];
    auditEventId: string;
  }): Promise<OfferingRevision | null>;
  createOfferingRevision(input: {
    context: TenantContext;
    offeringId: string;
    revisionId: string;
    contentHash: string;
    content: OfferingContent;
    completeness: CompletenessSummary;
    attributes: {
      definitionId: string;
      valueId: string;
      attribute: DynamicAttribute;
    }[];
    auditEventId: string;
  }): Promise<OfferingRevision | null>;
  findOfferingRevision(input: {
    context: TenantContext;
    offeringId: string;
    revision: number;
  }): Promise<OfferingRevision | null>;
}

/** Worker-only reader for the authoritative current Profile revision bound to a Job. */
export interface ProfileReadinessExecutionStore {
  loadCurrentProfile(job: JobRecord): Promise<ProfileRevision | null>;
}
