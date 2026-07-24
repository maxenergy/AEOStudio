import type { ProfileOfferingStore } from '@aeostudio/application/profile-offering';
import type { JsonValue, TenantExportSourceObject } from '@aeostudio/application/privacy-audit';
import type { OfferingRevision, ProfileRevision } from '@aeostudio/domain/profile-offering';

import type { InMemoryTenantExportSource } from '../privacy/in-memory-tenant-export-source.js';
import type { InMemoryAuditSink } from '../privacy/in-memory-audit-sink.js';

interface ProfileAggregate {
  tenantId: string;
  workspaceId: string;
  currentRevision: number;
  revisions: Map<number, ProfileRevision>;
}

interface OfferingAggregate {
  tenantId: string;
  workspaceId: string;
  profileId: string;
  currentRevision: number;
  revisions: Map<number, OfferingRevision>;
}

export class InMemoryProfileOfferingStore
  implements ProfileOfferingStore, InMemoryTenantExportSource
{
  private readonly profiles = new Map<string, ProfileAggregate>();
  private readonly offerings = new Map<string, OfferingAggregate>();
  private readonly revisionOccurredAt = new Map<string, string>();

  public constructor(
    private readonly clock: { now(): Date } = { now: () => new Date() },
    private readonly audit?: InMemoryAuditSink,
  ) {}

  createProfile(
    input: Parameters<ProfileOfferingStore['createProfile']>[0],
  ): Promise<ProfileRevision> {
    const occurredAt = this.safeNow();
    const revision: ProfileRevision = {
      id: input.revisionId,
      profileId: input.profileId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      revision: 1,
      contentHash: input.contentHash,
      completeness: structuredClone(input.completeness),
      ...structuredClone(input.content),
    };
    this.profiles.set(input.profileId, {
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      currentRevision: 1,
      revisions: new Map([[1, revision]]),
    });
    this.revisionOccurredAt.set(revision.id, occurredAt.toISOString());
    this.appendRevisionAudit(input, 'PROFILE_REVISION_CREATED', revision, occurredAt);
    return Promise.resolve(structuredClone(revision));
  }

  createProfileRevision(
    input: Parameters<ProfileOfferingStore['createProfileRevision']>[0],
  ): Promise<ProfileRevision | null> {
    const aggregate = this.profiles.get(input.profileId);
    if (!this.inScope(aggregate, input.context.tenantId, input.context.workspaceId)) {
      return Promise.resolve(null);
    }
    const occurredAt = this.safeNow();
    const revisionNumber = aggregate.currentRevision + 1;
    const revision: ProfileRevision = {
      id: input.revisionId,
      profileId: input.profileId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      revision: revisionNumber,
      contentHash: input.contentHash,
      completeness: structuredClone(input.completeness),
      ...structuredClone(input.content),
    };
    aggregate.currentRevision = revisionNumber;
    aggregate.revisions.set(revisionNumber, revision);
    this.revisionOccurredAt.set(revision.id, occurredAt.toISOString());
    this.appendRevisionAudit(input, 'PROFILE_REVISION_CREATED', revision, occurredAt);
    return Promise.resolve(structuredClone(revision));
  }

  findProfileRevision(
    input: Parameters<ProfileOfferingStore['findProfileRevision']>[0],
  ): Promise<ProfileRevision | null> {
    const aggregate = this.profiles.get(input.profileId);
    if (!this.inScope(aggregate, input.context.tenantId, input.context.workspaceId)) {
      return Promise.resolve(null);
    }
    const revision = aggregate.revisions.get(input.revision);
    return Promise.resolve(revision === undefined ? null : structuredClone(revision));
  }

  createOffering(
    input: Parameters<ProfileOfferingStore['createOffering']>[0],
  ): Promise<OfferingRevision | null> {
    const profile = this.profiles.get(input.profileId);
    if (!this.inScope(profile, input.context.tenantId, input.context.workspaceId)) {
      return Promise.resolve(null);
    }
    const occurredAt = this.safeNow();
    const revision: OfferingRevision = {
      id: input.revisionId,
      offeringId: input.offeringId,
      profileId: input.profileId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      revision: 1,
      contentHash: input.contentHash,
      completeness: structuredClone(input.completeness),
      ...structuredClone(input.content),
    };
    this.offerings.set(input.offeringId, {
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      profileId: input.profileId,
      currentRevision: 1,
      revisions: new Map([[1, revision]]),
    });
    this.revisionOccurredAt.set(revision.id, occurredAt.toISOString());
    this.appendRevisionAudit(input, 'OFFERING_REVISION_CREATED', revision, occurredAt);
    return Promise.resolve(structuredClone(revision));
  }

  createOfferingRevision(
    input: Parameters<ProfileOfferingStore['createOfferingRevision']>[0],
  ): Promise<OfferingRevision | null> {
    const aggregate = this.offerings.get(input.offeringId);
    if (!this.inScope(aggregate, input.context.tenantId, input.context.workspaceId)) {
      return Promise.resolve(null);
    }
    const occurredAt = this.safeNow();
    const revisionNumber = aggregate.currentRevision + 1;
    const revision: OfferingRevision = {
      id: input.revisionId,
      offeringId: input.offeringId,
      profileId: aggregate.profileId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      revision: revisionNumber,
      contentHash: input.contentHash,
      completeness: structuredClone(input.completeness),
      ...structuredClone(input.content),
    };
    aggregate.currentRevision = revisionNumber;
    aggregate.revisions.set(revisionNumber, revision);
    this.revisionOccurredAt.set(revision.id, occurredAt.toISOString());
    this.appendRevisionAudit(input, 'OFFERING_REVISION_CREATED', revision, occurredAt);
    return Promise.resolve(structuredClone(revision));
  }

  findOfferingRevision(
    input: Parameters<ProfileOfferingStore['findOfferingRevision']>[0],
  ): Promise<OfferingRevision | null> {
    const aggregate = this.offerings.get(input.offeringId);
    if (!this.inScope(aggregate, input.context.tenantId, input.context.workspaceId)) {
      return Promise.resolve(null);
    }
    const revision = aggregate.revisions.get(input.revision);
    return Promise.resolve(revision === undefined ? null : structuredClone(revision));
  }

  listTenantExportObjects(input: {
    tenantId: string;
    from: Date;
    to: Date;
  }): Promise<TenantExportSourceObject[]> {
    const from = input.from.getTime();
    const to = input.to.getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      return Promise.reject(new Error('INVALID_TENANT_EXPORT_RANGE'));
    }
    const objects: TenantExportSourceObject[] = [];
    for (const aggregate of this.profiles.values()) {
      if (aggregate.tenantId !== input.tenantId) continue;
      for (const revision of aggregate.revisions.values()) {
        this.appendExportRevision(objects, 'PROFILE_REVISION', revision, from, to);
      }
    }
    for (const aggregate of this.offerings.values()) {
      if (aggregate.tenantId !== input.tenantId) continue;
      for (const revision of aggregate.revisions.values()) {
        this.appendExportRevision(objects, 'OFFERING_REVISION', revision, from, to);
      }
    }
    objects.sort((left, right) =>
      `${left.kind}:${left.objectId}`.localeCompare(`${right.kind}:${right.objectId}`),
    );
    return Promise.resolve(objects);
  }

  private appendExportRevision(
    objects: TenantExportSourceObject[],
    kind: 'PROFILE_REVISION' | 'OFFERING_REVISION',
    revision: ProfileRevision | OfferingRevision,
    from: number,
    to: number,
  ): void {
    const occurredAt = this.revisionOccurredAt.get(revision.id);
    if (occurredAt === undefined) return;
    const occurredAtMs = Date.parse(occurredAt);
    if (!Number.isFinite(occurredAtMs) || occurredAtMs < from || occurredAtMs > to) return;
    objects.push({
      tenantId: revision.tenantId,
      workspaceId: revision.workspaceId,
      kind,
      objectId: revision.id,
      occurredAt,
      payload: structuredClone(revision) as unknown as JsonValue,
    });
  }

  listProfiles(input: {
    context: { tenantId: string; workspaceId: string };
  }): Promise<
    { id: string; displayName: string; currentRevision: number; completeness: { completedFields: number; totalFields: number; percent: number; missingFields: string[] } }[]
  > {
    const results: {
      id: string;
      displayName: string;
      currentRevision: number;
      completeness: { completedFields: number; totalFields: number; percent: number; missingFields: string[] };
    }[] = [];
    for (const [profileId, aggregate] of this.profiles) {
      if (aggregate.tenantId !== input.context.tenantId) continue;
      if (aggregate.workspaceId !== input.context.workspaceId) continue;
      const current = aggregate.revisions.get(aggregate.currentRevision);
      if (current === undefined) continue;
      results.push({
        id: profileId,
        displayName: current.displayName,
        currentRevision: aggregate.currentRevision,
        completeness: structuredClone(current.completeness),
      });
    }
    return Promise.resolve(results);
  }

  listOfferings(input: {
    context: { tenantId: string; workspaceId: string };
  }): Promise<
    {
      id: string;
      profileId: string;
      kind: string;
      name: string;
      locale: string;
      market: string;
      currentRevision: number;
      completeness: { completedFields: number; totalFields: number; percent: number; missingFields: string[] };
    }[]
  > {
    const results: {
      id: string;
      profileId: string;
      kind: string;
      name: string;
      locale: string;
      market: string;
      currentRevision: number;
      completeness: { completedFields: number; totalFields: number; percent: number; missingFields: string[] };
    }[] = [];
    for (const [offeringId, aggregate] of this.offerings) {
      if (aggregate.tenantId !== input.context.tenantId) continue;
      if (aggregate.workspaceId !== input.context.workspaceId) continue;
      const current = aggregate.revisions.get(aggregate.currentRevision);
      if (current === undefined) continue;
      results.push({
        id: offeringId,
        profileId: aggregate.profileId,
        kind: current.kind,
        name: current.name,
        locale: current.locale,
        market: current.market,
        currentRevision: aggregate.currentRevision,
        completeness: structuredClone(current.completeness),
      });
    }
    return Promise.resolve(results);
  }

  private safeNow(): Date {
    const value = this.clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error('INVALID_PROFILE_OFFERING_CLOCK');
    }
    return new Date(value);
  }

  private appendRevisionAudit(
    input: {
      context: { tenantId: string; workspaceId: string; actorUserId: string };
      auditEventId: string;
    },
    action: 'PROFILE_REVISION_CREATED' | 'OFFERING_REVISION_CREATED',
    revision: ProfileRevision | OfferingRevision,
    occurredAt: Date,
  ): void {
    this.audit?.append({
      id: input.auditEventId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      actorId: input.context.actorUserId,
      action,
      resourceType: action.startsWith('PROFILE') ? 'PROFILE' : 'OFFERING',
      resourceId: action.startsWith('PROFILE')
        ? (revision as ProfileRevision).profileId
        : (revision as OfferingRevision).offeringId,
      outcome: 'SUCCEEDED',
      metadata: {
        revisionId: revision.id,
        revision: revision.revision,
        contentHash: revision.contentHash,
        completenessPercent: revision.completeness.percent,
      },
      occurredAt,
    });
  }

  private inScope<T extends { tenantId: string; workspaceId: string }>(
    aggregate: T | undefined,
    tenantId: string,
    workspaceId: string,
  ): aggregate is T {
    return (
      aggregate !== undefined &&
      aggregate.tenantId === tenantId &&
      aggregate.workspaceId === workspaceId
    );
  }
}
