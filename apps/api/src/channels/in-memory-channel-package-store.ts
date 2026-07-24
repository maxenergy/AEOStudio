import type { ChannelPackageStore } from '@aeostudio/application/channels-publishing';
import type { ChannelPackageRecord } from '@aeostudio/domain/channels-publishing';

export type InMemoryChannelPackageCurrentApprovalFence = (
  input: Parameters<ChannelPackageStore['createOrFind']>[0],
) => boolean;

export class InMemoryChannelPackageStore implements ChannelPackageStore {
  private readonly records = new Map<string, ChannelPackageRecord>();

  constructor(private readonly isCurrentApproved: InMemoryChannelPackageCurrentApprovalFence) {}

  createOrFind(input: Parameters<ChannelPackageStore['createOrFind']>[0]) {
    if (!this.isCurrentApproved(input)) {
      return Promise.resolve({ outcome: 'APPROVAL_STALE' as const });
    }
    const existing = [...this.records.values()].find(
      (record) =>
        record.tenantId === input.context.tenantId &&
        record.workspaceId === input.context.workspaceId &&
        record.artifact.artifactRevisionId === input.artifact.artifactRevisionId &&
        record.artifact.contentHash === input.artifact.contentHash &&
        record.channel.definitionId === input.channel.definitionId &&
        record.transformer.key === input.transformer.key &&
        record.transformer.version === input.transformer.version &&
        record.packageSchemaVersion === input.packageSchemaVersion &&
        (record.manifest.channelProfile?.profileHash ?? null) ===
          (input.manifest.channelProfile?.profileHash ?? null),
    );
    if (existing !== undefined) {
      return Promise.resolve({
        outcome: 'SUCCEEDED' as const,
        record: structuredClone(existing),
        created: false,
      });
    }
    const packageRevision =
      Math.max(
        0,
        ...[...this.records.values()]
          .filter(
            (record) =>
              record.tenantId === input.context.tenantId &&
              record.workspaceId === input.context.workspaceId &&
              record.artifact.artifactId === input.artifact.artifactId &&
              record.channel.definitionId === input.channel.definitionId,
          )
          .map((record) => record.packageRevision),
      ) + 1;
    const record: ChannelPackageRecord = {
      id: input.packageId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      packageRevision,
      channel: structuredClone(input.channel),
      transformer: structuredClone(input.transformer),
      packageSchemaVersion: input.packageSchemaVersion,
      artifact: structuredClone(input.artifact),
      manifest: structuredClone(input.manifest),
      packageChecksum: input.packageChecksum,
      payloadObjectRef: input.payloadObjectRef,
      createdByUserId: input.context.actorUserId,
      createdAt: input.createdAt.toISOString(),
    };
    this.records.set(record.id, record);
    return Promise.resolve({
      outcome: 'SUCCEEDED' as const,
      record: structuredClone(record),
      created: true,
    });
  }

  findById(input: Parameters<ChannelPackageStore['findById']>[0]) {
    const record = this.records.get(input.packageId);
    return Promise.resolve(
      record === undefined ||
        record.tenantId !== input.context.tenantId ||
        record.workspaceId !== input.context.workspaceId
        ? null
        : structuredClone(record),
    );
  }
}
