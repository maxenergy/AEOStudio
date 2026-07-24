import type { IdentityIdGenerator, TenancyStore } from '../identity-access/index.js';
import { roleAllows } from '@aeostudio/domain/identity-access';
import {
  offeringCompleteness,
  profileCompleteness,
  type OfferingContent,
  type OfferingRevision,
  type ProfileContent,
  type ProfileRevision,
} from '@aeostudio/domain/profile-offering';

import type { ProfileOfferingStore } from './ports.js';
import { revisionHash } from './revision-hash.js';

export type ProfileMutationResult =
  | { outcome: 'SUCCEEDED'; profile: ProfileRevision }
  | { outcome: 'FORBIDDEN' }
  | { outcome: 'NOT_FOUND' };

export type OfferingMutationResult =
  | { outcome: 'SUCCEEDED'; offering: OfferingRevision }
  | { outcome: 'FORBIDDEN' }
  | { outcome: 'NOT_FOUND' };

export class ProfileOfferingService {
  constructor(
    private readonly store: ProfileOfferingStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext' | 'appendDeniedAudit'>,
    private readonly ids: IdentityIdGenerator,
  ) {}

  async createProfile(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    content: ProfileContent;
  }): Promise<ProfileMutationResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'PROFILE_WRITE',
        resourceType: 'PROFILE',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const profile = await this.store.createProfile({
      context,
      profileId: this.ids.next(),
      revisionId: this.ids.next(),
      contentHash: revisionHash(input.content),
      content: input.content,
      completeness: profileCompleteness(input.content),
      auditEventId: this.ids.next(),
    });
    return { outcome: 'SUCCEEDED', profile };
  }

  async createProfileRevision(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    profileId: string;
    content: ProfileContent;
  }): Promise<ProfileMutationResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'PROFILE_WRITE',
        resourceType: 'PROFILE',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const profile = await this.store.createProfileRevision({
      context,
      profileId: input.profileId,
      revisionId: this.ids.next(),
      contentHash: revisionHash(input.content),
      content: input.content,
      completeness: profileCompleteness(input.content),
      auditEventId: this.ids.next(),
    });
    return profile === null ? { outcome: 'NOT_FOUND' } : { outcome: 'SUCCEEDED', profile };
  }

  async getProfileRevision(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    profileId: string;
    revision: number;
  }): Promise<ProfileRevision | null> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) {
      return null;
    }
    return this.store.findProfileRevision({
      context,
      profileId: input.profileId,
      revision: input.revision,
    });
  }

  async createOffering(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    profileId: string;
    content: OfferingContent;
  }): Promise<OfferingMutationResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'OFFERING_WRITE',
        resourceType: 'OFFERING',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const offering = await this.store.createOffering({
      context,
      profileId: input.profileId,
      offeringId: this.ids.next(),
      revisionId: this.ids.next(),
      contentHash: revisionHash(input.content),
      content: input.content,
      completeness: offeringCompleteness(input.content),
      attributes: input.content.attributes.map((attribute) => ({
        definitionId: this.ids.next(),
        valueId: this.ids.next(),
        attribute,
      })),
      auditEventId: this.ids.next(),
    });
    return offering === null ? { outcome: 'NOT_FOUND' } : { outcome: 'SUCCEEDED', offering };
  }

  async createOfferingRevision(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    offeringId: string;
    content: OfferingContent;
  }): Promise<OfferingMutationResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'OFFERING_WRITE',
        resourceType: 'OFFERING',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const offering = await this.store.createOfferingRevision({
      context,
      offeringId: input.offeringId,
      revisionId: this.ids.next(),
      contentHash: revisionHash(input.content),
      content: input.content,
      completeness: offeringCompleteness(input.content),
      attributes: input.content.attributes.map((attribute) => ({
        definitionId: this.ids.next(),
        valueId: this.ids.next(),
        attribute,
      })),
      auditEventId: this.ids.next(),
    });
    return offering === null ? { outcome: 'NOT_FOUND' } : { outcome: 'SUCCEEDED', offering };
  }

  async getOfferingRevision(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    offeringId: string;
    revision: number;
  }): Promise<OfferingRevision | null> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) {
      return null;
    }
    return this.store.findOfferingRevision({
      context,
      offeringId: input.offeringId,
      revision: input.revision,
    });
  }

  async listProfiles(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<
    | {
        outcome: 'SUCCEEDED';
        profiles: {
          id: string;
          displayName: string;
          currentRevision: number;
          completeness: {
            completedFields: number;
            totalFields: number;
            percent: number;
            missingFields: string[];
          };
        }[];
      }
    | { outcome: 'NOT_FOUND' }
  > {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) {
      return { outcome: 'NOT_FOUND' };
    }
    const profiles = await this.store.listProfiles({ context });
    return { outcome: 'SUCCEEDED', profiles };
  }

  async listOfferings(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<
    | {
        outcome: 'SUCCEEDED';
        offerings: {
          id: string;
          profileId: string;
          kind: string;
          name: string;
          locale: string;
          market: string;
          currentRevision: number;
          completeness: {
            completedFields: number;
            totalFields: number;
            percent: number;
            missingFields: string[];
          };
        }[];
      }
    | { outcome: 'NOT_FOUND' }
  > {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) {
      return { outcome: 'NOT_FOUND' };
    }
    const offerings = await this.store.listOfferings({ context });
    return { outcome: 'SUCCEEDED', offerings };
  }
}
