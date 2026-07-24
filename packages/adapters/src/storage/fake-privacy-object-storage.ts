import { createHash } from 'node:crypto';

import type {
  AuditEvidenceObjectLockStore,
  PrivacyObjectVersionInventory,
  PrivacyObjectDeleteResult,
  StoredPrivacyObjectVersion,
  TenantExportObjectStorage,
} from '@aeostudio/application/privacy-audit';

type Bucket = 'audit-evidence' | 'tenant-exports';

interface StoredVersion {
  bucket: Bucket;
  body: Uint8Array;
  metadata: StoredPrivacyObjectVersion;
  holds: Set<string>;
}

export interface StagedPrivacyObjectVersion {
  object: StoredPrivacyObjectVersion;
  commit(): StoredPrivacyObjectVersion;
  abort(): void;
}

export interface FakePrivacyObjectStorageOptions {
  ids: { next(): string };
  clock: { now(): Date };
}

export class FakePrivacyObjectStorage
  implements TenantExportObjectStorage, AuditEvidenceObjectLockStore, PrivacyObjectVersionInventory
{
  private readonly versions = new Map<string, StoredVersion>();

  public constructor(private readonly options: FakePrivacyObjectStorageOptions) {}

  public get size(): number {
    return this.versions.size;
  }

  public putExportVersion(
    input: Parameters<TenantExportObjectStorage['putExportVersion']>[0],
  ): Promise<StoredPrivacyObjectVersion> {
    return this.putVersion('tenant-exports', input, null);
  }

  public putLockedAuditVersion(
    input: Parameters<AuditEvidenceObjectLockStore['putLockedAuditVersion']>[0],
  ): Promise<StoredPrivacyObjectVersion> {
    return this.stageLockedAuditVersion(input).then((staged) => staged.commit());
  }

  /**
   * Fake-runtime transaction boundary for an Object-Lock write. The version is
   * invisible until commit, so a caller can revalidate authorization after the
   * asynchronous write without weakening deletion rules for committed evidence.
   */
  public stageLockedAuditVersion(
    input: Parameters<AuditEvidenceObjectLockStore['putLockedAuditVersion']>[0],
  ): Promise<StagedPrivacyObjectVersion> {
    const now = readInstant(this.options.clock.now());
    const lockedUntil = readInstant(input.lockedUntil);
    if (now === null || lockedUntil === null || lockedUntil <= now) {
      return Promise.reject(new Error('INVALID_OBJECT_LOCK_TIMELINE'));
    }
    return this.stageVersion('audit-evidence', input, new Date(lockedUntil).toISOString());
  }

  public readExportVersion(
    input: Parameters<TenantExportObjectStorage['readExportVersion']>[0],
  ): Promise<{ object: StoredPrivacyObjectVersion; body: Uint8Array } | null> {
    return Promise.resolve(this.readVersion('tenant-exports', input));
  }

  public readAuditVersion(
    input: Parameters<AuditEvidenceObjectLockStore['readAuditVersion']>[0],
  ): Promise<{ object: StoredPrivacyObjectVersion; body: Uint8Array } | null> {
    return Promise.resolve(this.readVersion('audit-evidence', input));
  }

  public deleteExportVersion(
    input: Parameters<TenantExportObjectStorage['deleteExportVersion']>[0],
  ): Promise<PrivacyObjectDeleteResult> {
    return Promise.resolve(this.deleteVersion('tenant-exports', input));
  }

  public deleteAuditVersion(
    input: Parameters<AuditEvidenceObjectLockStore['deleteAuditVersion']>[0],
  ): Promise<PrivacyObjectDeleteResult> {
    return Promise.resolve(this.deleteVersion('audit-evidence', input));
  }

  public holdExportVersion(
    input: Parameters<TenantExportObjectStorage['holdExportVersion']>[0],
  ): Promise<boolean> {
    return Promise.resolve(this.holdVersion('tenant-exports', input, true));
  }

  public holdAuditVersion(
    input: Parameters<AuditEvidenceObjectLockStore['holdAuditVersion']>[0],
  ): Promise<boolean> {
    return Promise.resolve(this.holdVersion('audit-evidence', input, true));
  }

  public releaseExportVersionHold(
    input: Parameters<TenantExportObjectStorage['releaseExportVersionHold']>[0],
  ): Promise<boolean> {
    return Promise.resolve(this.holdVersion('tenant-exports', input, false));
  }

  public releaseAuditVersionHold(
    input: Parameters<AuditEvidenceObjectLockStore['releaseAuditVersionHold']>[0],
  ): Promise<boolean> {
    return Promise.resolve(this.holdVersion('audit-evidence', input, false));
  }

  public listPrivacyObjectVersions(
    input: Parameters<PrivacyObjectVersionInventory['listPrivacyObjectVersions']>[0],
  ): ReturnType<PrivacyObjectVersionInventory['listPrivacyObjectVersions']> {
    const prefix =
      input.bucket === 'TENANT_EXPORTS'
        ? `tenants/${input.tenantId}/exports/`
        : `tenants/${input.tenantId}/audit-digests/`;
    const bucket: Bucket = input.bucket === 'TENANT_EXPORTS' ? 'tenant-exports' : 'audit-evidence';
    const offset = input.cursor === null ? 0 : Number(input.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || input.limit < 1 || input.limit > 1_000) {
      return Promise.reject(new Error('INVALID_PRIVACY_OBJECT_INVENTORY_CURSOR'));
    }
    const versions = [...this.versions.values()]
      .filter(
        (stored) =>
          stored.bucket === bucket &&
          stored.metadata.tenantId === input.tenantId &&
          stored.metadata.objectKey.startsWith(prefix),
      )
      .map(({ metadata }) => ({
        objectKey: metadata.objectKey,
        objectVersionId: metadata.objectVersionId,
      }))
      .sort((left, right) =>
        `${left.objectKey}\u0000${left.objectVersionId}`.localeCompare(
          `${right.objectKey}\u0000${right.objectVersionId}`,
        ),
      );
    const page = versions.slice(offset, offset + input.limit);
    const nextOffset = offset + page.length;
    return Promise.resolve({
      versions: page,
      nextCursor: nextOffset < versions.length ? String(nextOffset) : null,
    });
  }

  private putVersion(
    bucket: Bucket,
    input: {
      tenantId: string;
      objectKey: string;
      body: Uint8Array;
      contentType: string;
      checksum: string;
    },
    lockedUntil: string | null,
  ): Promise<StoredPrivacyObjectVersion> {
    return this.stageVersion(bucket, input, lockedUntil).then((staged) => staged.commit());
  }

  private stageVersion(
    bucket: Bucket,
    input: {
      tenantId: string;
      objectKey: string;
      body: Uint8Array;
      contentType: string;
      checksum: string;
    },
    lockedUntil: string | null,
  ): Promise<StagedPrivacyObjectVersion> {
    const now = safeClock(this.options.clock);
    if (
      now === null ||
      !validTenantKey(input.tenantId, input.objectKey) ||
      input.contentType.trim().length === 0
    ) {
      return Promise.reject(new Error('INVALID_PRIVACY_OBJECT'));
    }
    const checksum = createHash('sha256').update(input.body).digest('hex');
    if (checksum !== input.checksum) {
      return Promise.reject(new Error('PRIVACY_OBJECT_CHECKSUM_MISMATCH'));
    }
    const objectVersionId = this.options.ids.next();
    if (objectVersionId.trim().length === 0) {
      return Promise.reject(new Error('INVALID_PRIVACY_OBJECT_VERSION_ID'));
    }
    const metadata: StoredPrivacyObjectVersion = {
      tenantId: input.tenantId,
      objectRef: `s3+memory://${bucket}/${input.objectKey}?versionId=${encodeURIComponent(objectVersionId)}`,
      objectKey: input.objectKey,
      objectVersionId,
      checksum,
      contentType: input.contentType,
      byteLength: input.body.byteLength,
      createdAt: now.toISOString(),
      lockedUntil,
    };
    const key = versionKey(bucket, input.tenantId, input.objectKey, objectVersionId);
    const stored: StoredVersion = {
      bucket,
      body: new Uint8Array(input.body),
      metadata,
      holds: new Set(),
    };
    let state: 'PENDING' | 'COMMITTED' | 'ABORTED' = 'PENDING';
    return Promise.resolve({
      object: cloneMetadata(metadata),
      commit: () => {
        if (state === 'ABORTED') throw new Error('PRIVACY_OBJECT_STAGE_ABORTED');
        if (state === 'PENDING') {
          this.versions.set(key, stored);
          state = 'COMMITTED';
        }
        return cloneMetadata(metadata);
      },
      abort: () => {
        if (state === 'COMMITTED') throw new Error('PRIVACY_OBJECT_STAGE_COMMITTED');
        state = 'ABORTED';
      },
    });
  }

  private readVersion(
    bucket: Bucket,
    input: { tenantId: string; objectKey: string; objectVersionId: string },
  ): { object: StoredPrivacyObjectVersion; body: Uint8Array } | null {
    if (!validTenantKey(input.tenantId, input.objectKey)) return null;
    const stored = this.versions.get(
      versionKey(bucket, input.tenantId, input.objectKey, input.objectVersionId),
    );
    return stored === undefined
      ? null
      : { object: cloneMetadata(stored.metadata), body: new Uint8Array(stored.body) };
  }

  private deleteVersion(
    bucket: Bucket,
    input: { tenantId: string; objectKey: string; objectVersionId: string; at: Date },
  ): PrivacyObjectDeleteResult {
    const at = readInstant(input.at);
    if (at === null) return { outcome: 'INVALID_TIMELINE' };
    if (!validTenantKey(input.tenantId, input.objectKey)) return { outcome: 'NOT_FOUND' };
    const key = versionKey(bucket, input.tenantId, input.objectKey, input.objectVersionId);
    const stored = this.versions.get(key);
    if (stored === undefined) return { outcome: 'NOT_FOUND' };
    if (stored.holds.size > 0) return { outcome: 'LEGAL_HOLD' };
    if (stored.metadata.lockedUntil !== null && at < Date.parse(stored.metadata.lockedUntil)) {
      return { outcome: 'OBJECT_LOCKED' };
    }
    this.versions.delete(key);
    return { outcome: 'DELETED', object: cloneMetadata(stored.metadata) };
  }

  private holdVersion(
    bucket: Bucket,
    input: {
      tenantId: string;
      objectKey: string;
      objectVersionId: string;
      holdId: string;
    },
    apply: boolean,
  ): boolean {
    if (!validTenantKey(input.tenantId, input.objectKey) || input.holdId.trim().length === 0) {
      return false;
    }
    const stored = this.versions.get(
      versionKey(bucket, input.tenantId, input.objectKey, input.objectVersionId),
    );
    if (stored === undefined) return false;
    if (apply) {
      stored.holds.add(input.holdId);
      return true;
    }
    return stored.holds.delete(input.holdId);
  }
}

function versionKey(
  bucket: Bucket,
  tenantId: string,
  objectKey: string,
  versionId: string,
): string {
  return JSON.stringify([bucket, tenantId, objectKey, versionId]);
}

function validTenantKey(tenantId: string, objectKey: string): boolean {
  return (
    tenantId.trim().length > 0 &&
    objectKey.startsWith(`tenants/${tenantId}/`) &&
    objectKey.length <= 1_024 &&
    !objectKey.includes('..') &&
    !objectKey.includes('\\')
  );
}

function safeClock(clock: { now(): Date }): Date | null {
  try {
    const value = clock.now();
    return readInstant(value) === null ? null : new Date(value);
  } catch {
    return null;
  }
}

function readInstant(value: Date): number | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null;
}

function cloneMetadata(value: StoredPrivacyObjectVersion): StoredPrivacyObjectVersion {
  return { ...value };
}
