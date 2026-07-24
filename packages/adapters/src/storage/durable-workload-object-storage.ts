import type { ArtifactPayloadStore } from '@aeostudio/application/artifacts';
import type { ChannelPackagePayloadStore } from '@aeostudio/application/channels-publishing';
import type {
  PreparedWorkloadObjectWrite,
  WorkloadObjectWriteIntentStore,
} from '@aeostudio/application/privacy-audit';
import type { CrawlObjectStorage } from '@aeostudio/application/site-crawl';
import type {
  CapabilityBoundWorkloadObjectRecovery,
  CapabilityBoundWorkloadObjectWriter,
} from '@aeostudio/application/tenant-data-access';
import type { ArtifactPayload } from '@aeostudio/domain/artifacts';
import type { ChannelPackagePayload } from '@aeostudio/domain/channels-publishing';

export interface DurableWorkloadObjectStorageGateway
  extends CapabilityBoundWorkloadObjectWriter, CapabilityBoundWorkloadObjectRecovery {
  prepareArtifactPayload(
    input: Parameters<ArtifactPayloadStore['put']>[0],
  ): PreparedWorkloadObjectWrite;
  get(objectRef: string): Promise<ArtifactPayload | null>;
  prepareChannelPackage(
    input: Parameters<ChannelPackagePayloadStore['put']>[0],
  ): PreparedWorkloadObjectWrite;
  getChannelPackage(objectRef: string): Promise<ChannelPackagePayload | null>;
  prepareCrawlSnapshot(
    input: Parameters<CrawlObjectStorage['putObject']>[0],
  ): PreparedWorkloadObjectWrite;
}

/**
 * Database-first coordinator for production workload payloads. The stable
 * immutable intent is committed before S3, and only an exact leased CAS may
 * publish the resulting VersionId into the managed-object ledger.
 */
export class DurableWorkloadObjectStorage implements ArtifactPayloadStore, CrawlObjectStorage {
  public constructor(
    private readonly raw: DurableWorkloadObjectStorageGateway,
    private readonly intents: WorkloadObjectWriteIntentStore,
    private readonly options: {
      ids: { next(): string };
      clock: { now(): Date };
    },
  ) {}

  public async put(
    input: Parameters<ArtifactPayloadStore['put']>[0],
  ): Promise<{ objectRef: string }> {
    return this.write(this.raw.prepareArtifactPayload(input));
  }

  public get(objectRef: string): ReturnType<ArtifactPayloadStore['get']> {
    return this.raw.get(objectRef);
  }

  public async putChannelPackage(
    input: Parameters<ChannelPackagePayloadStore['put']>[0],
  ): Promise<{ objectRef: string }> {
    return this.write(this.raw.prepareChannelPackage(input));
  }

  public getChannelPackage(objectRef: string): ReturnType<ChannelPackagePayloadStore['get']> {
    return this.raw.getChannelPackage(objectRef);
  }

  public async putObject(
    input: Parameters<CrawlObjectStorage['putObject']>[0],
  ): Promise<{ objectRef: string }> {
    return this.write(this.raw.prepareCrawlSnapshot(input));
  }

  public channelPackages(): ChannelPackagePayloadStore {
    return {
      put: (input) => this.putChannelPackage(input),
      get: (objectRef) => this.getChannelPackage(objectRef),
    };
  }

  private async write(input: PreparedWorkloadObjectWrite): Promise<{ objectRef: string }> {
    const now = this.options.clock.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('WORKLOAD_OBJECT_WRITE_TIME_INVALID');
    }
    const reserved = await this.intents.reserveWorkloadObjectWriteIntent({
      operationId: this.options.ids.next(),
      kind: input.kind,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      objectKey: input.objectKey,
      checksum: input.checksum,
      contentType: input.contentType,
      byteLength: input.byteLength,
    });
    if (reserved.outcome === 'READY') {
      assertReadyObjectMatches(input, reserved.object);
      return { objectRef: reserved.object.objectRef };
    }

    const leaseToken = this.options.ids.next();
    const claimed = await this.intents.claimWorkloadObjectWriteIntent({
      operationId: reserved.operationId,
      tenantId: input.tenantId,
      leaseToken,
    });
    if (!claimed) throw new Error('WORKLOAD_OBJECT_WRITE_BUSY');
    let releaseLease = true;
    try {
      const access = { operationId: reserved.operationId, leaseToken };
      let object;
      try {
        object = await this.raw.putAuthorizedWorkloadVersion(input, access);
      } catch (error: unknown) {
        if (!isTenantDataEffectOutcomeUnknown(error)) throw error;
        releaseLease = false;
        let recovery;
        try {
          recovery = await this.raw.recoverAuthorizedWorkloadVersion(input, access);
        } catch {
          throw error;
        }
        if (recovery.outcome !== 'FOUND') {
          releaseLease = recovery.outcome === 'ABSENT' || recovery.outcome === 'FAILED';
          throw error;
        }
        object = recovery.object;
        assertReadyObjectMatches(input, object);
      }
      const completed = await this.intents.completeWorkloadObjectWriteIntent({
        operationId: reserved.operationId,
        leaseToken,
        object,
      });
      if (!completed) throw new Error('WORKLOAD_OBJECT_WRITE_LEASE_LOST');
      return { objectRef: object.objectRef };
    } catch (error: unknown) {
      if (releaseLease) {
        try {
          await this.intents.releaseWorkloadObjectWriteIntentLease({
            operationId: reserved.operationId,
            leaseToken,
          });
        } catch {
          // The database lease remains the authority and expires server-side.
        }
      }
      throw error;
    }
  }
}

function isTenantDataEffectOutcomeUnknown(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  const code = (value as Error & { code?: unknown }).code;
  return (
    value.message === 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN' ||
    code === 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN'
  );
}

function assertReadyObjectMatches(
  expected: PreparedWorkloadObjectWrite,
  actual: {
    kind: string;
    tenantId: string;
    workspaceId: string;
    objectKey: string;
    checksum: string;
    contentType: string;
    byteLength: number;
    objectRef: string;
  },
): void {
  if (
    actual.kind !== expected.kind ||
    actual.tenantId !== expected.tenantId ||
    actual.workspaceId !== expected.workspaceId ||
    actual.objectKey !== expected.objectKey ||
    actual.checksum !== expected.checksum ||
    actual.contentType !== expected.contentType ||
    actual.byteLength !== expected.byteLength ||
    actual.objectRef.length < 1
  ) {
    throw new Error('WORKLOAD_OBJECT_WRITE_IDEMPOTENCY_CONFLICT');
  }
}
