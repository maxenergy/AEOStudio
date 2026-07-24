import { createHash } from 'node:crypto';

import type {
  AuditEvidenceObjectLockStore,
  PrivacyObjectVersionInventory,
  PrivacyObjectDeleteResult,
  StoredPrivacyObjectVersion,
  TenantExportObjectStorage,
  WorkloadObjectDeletionStorage,
} from '@aeostudio/application/privacy-audit';

interface AwsS3ObjectIdentity {
  Bucket: string;
  Key: string;
  VersionId: string;
  ExpectedBucketOwner: string;
}

interface AwsS3ObjectMetadata {
  VersionId?: string | undefined;
  ContentType?: string | undefined;
  ContentLength?: number | undefined;
  ChecksumSHA256?: string | undefined;
  Metadata?: Record<string, string> | undefined;
  ObjectLockRetainUntilDate?: Date | undefined;
  LastModified?: Date | undefined;
  ServerSideEncryption?: string | undefined;
  SSEKMSKeyId?: string | undefined;
}

interface AwsS3RequestOptions {
  abortSignal: AbortSignal;
}

export interface AwsS3PrivacyApi {
  putObject(input: {
    Bucket: string;
    Key: string;
    Body: Uint8Array;
    ContentType: string;
    IfNoneMatch: '*';
    ChecksumAlgorithm: 'SHA256';
    ChecksumSHA256: string;
    ServerSideEncryption: 'aws:kms';
    SSEKMSKeyId: string;
    BucketKeyEnabled: true;
    ExpectedBucketOwner: string;
    Tagging: string;
    Metadata: { 'tenant-id': string; sha256: string };
    ObjectLockMode?: 'GOVERNANCE';
    ObjectLockRetainUntilDate?: Date;
  }): Promise<{ VersionId?: string | undefined }>;
  getObject(input: AwsS3ObjectIdentity & { ChecksumMode: 'ENABLED' }): Promise<
    AwsS3ObjectMetadata & {
      Body?: Uint8Array | { transformToByteArray(): Promise<Uint8Array> } | undefined;
    }
  >;
  headObject(
    input: AwsS3ObjectIdentity & { ChecksumMode: 'ENABLED' },
    options?: AwsS3RequestOptions,
  ): Promise<AwsS3ObjectMetadata>;
  deleteObject(input: AwsS3ObjectIdentity): Promise<unknown>;
  getObjectLegalHold(input: AwsS3ObjectIdentity): Promise<{
    LegalHold?: { Status?: 'OFF' | 'ON' | undefined } | undefined;
  }>;
  putObjectLegalHold(
    input: AwsS3ObjectIdentity & { LegalHold: { Status: 'OFF' | 'ON' } },
  ): Promise<unknown>;
  listObjectVersions(
    input: {
      Bucket: string;
      Prefix: string;
      ExpectedBucketOwner: string;
      MaxKeys: number;
      KeyMarker?: string;
      VersionIdMarker?: string;
    },
    options?: AwsS3RequestOptions,
  ): Promise<{
    Versions?: Array<{ Key?: string; VersionId?: string }>;
    DeleteMarkers?: Array<{ Key?: string; VersionId?: string; LastModified?: Date }>;
    IsTruncated?: boolean;
    NextKeyMarker?: string;
    NextVersionIdMarker?: string;
  }>;
}

export interface AwsS3PrivacyObjectStorageOptions {
  region: string;
  accountId: string;
  exportBucket: string;
  auditBucket: string;
  kmsKeyArn: string;
  clock: { now(): Date };
}

type BucketKind = 'AUDIT' | 'EXPORT';

/**
 * Production exact-version S3 boundary for Tenant exports and immutable audit
 * evidence. Every operation binds the Tenant key prefix, expected AWS account,
 * KMS key, checksum and VersionId before returning data or changing state.
 */
export class AwsS3PrivacyObjectStorage
  implements
    TenantExportObjectStorage,
    AuditEvidenceObjectLockStore,
    PrivacyObjectVersionInventory,
    WorkloadObjectDeletionStorage
{
  private readonly accountId: string;
  private readonly auditBucket: string;
  private readonly exportBucket: string;
  private readonly kmsKeyArn: string;

  public constructor(
    private readonly api: AwsS3PrivacyApi,
    private readonly options: AwsS3PrivacyObjectStorageOptions,
  ) {
    if (options.region !== 'ap-southeast-1') throw new Error('AWS_S3_SINGAPORE_REGION_REQUIRED');
    if (!/^\d{12}$/u.test(options.accountId)) throw new Error('INVALID_AWS_ACCOUNT_ID');
    this.accountId = options.accountId;
    this.exportBucket = readBucketName(options.exportBucket);
    this.auditBucket = readBucketName(options.auditBucket);
    const escapedAccount = escapeRegularExpression(options.accountId);
    if (
      !new RegExp(`^arn:aws:kms:ap-southeast-1:${escapedAccount}:key/[0-9a-f-]{36}$`, 'iu').test(
        options.kmsKeyArn,
      )
    ) {
      throw new Error('AWS_S3_KMS_KEY_OUTSIDE_RUNTIME_SCOPE');
    }
    this.kmsKeyArn = options.kmsKeyArn;
  }

  public putExportVersion(
    input: Parameters<TenantExportObjectStorage['putExportVersion']>[0],
  ): Promise<StoredPrivacyObjectVersion> {
    return this.putVersion('EXPORT', input, null);
  }

  public putLockedAuditVersion(
    input: Parameters<AuditEvidenceObjectLockStore['putLockedAuditVersion']>[0],
  ): Promise<StoredPrivacyObjectVersion> {
    const lockedUntil = readInstant(input.lockedUntil);
    const now = safeNow(this.options.clock);
    if (lockedUntil === null || now === null || lockedUntil <= now) {
      return Promise.reject(new Error('INVALID_OBJECT_LOCK_TIMELINE'));
    }
    return this.putVersion('AUDIT', input, new Date(lockedUntil));
  }

  public readExportVersion(
    input: Parameters<TenantExportObjectStorage['readExportVersion']>[0],
  ): Promise<{ object: StoredPrivacyObjectVersion; body: Uint8Array } | null> {
    return this.readVersion('EXPORT', input);
  }

  public readAuditVersion(
    input: Parameters<AuditEvidenceObjectLockStore['readAuditVersion']>[0],
  ): Promise<{ object: StoredPrivacyObjectVersion; body: Uint8Array } | null> {
    return this.readVersion('AUDIT', input);
  }

  public deleteExportVersion(
    input: Parameters<TenantExportObjectStorage['deleteExportVersion']>[0],
  ): Promise<PrivacyObjectDeleteResult> {
    return this.deleteVersion('EXPORT', input);
  }

  public deleteAuditVersion(
    input: Parameters<AuditEvidenceObjectLockStore['deleteAuditVersion']>[0],
  ): Promise<PrivacyObjectDeleteResult> {
    return this.deleteVersion('AUDIT', input);
  }

  public holdExportVersion(
    input: Parameters<TenantExportObjectStorage['holdExportVersion']>[0],
  ): Promise<boolean> {
    return this.setLegalHold('EXPORT', input, 'ON');
  }

  public holdAuditVersion(
    input: Parameters<AuditEvidenceObjectLockStore['holdAuditVersion']>[0],
  ): Promise<boolean> {
    return this.setLegalHold('AUDIT', input, 'ON');
  }

  public releaseExportVersionHold(
    input: Parameters<TenantExportObjectStorage['releaseExportVersionHold']>[0],
  ): Promise<boolean> {
    return this.setLegalHold('EXPORT', input, 'OFF');
  }

  public releaseAuditVersionHold(
    input: Parameters<AuditEvidenceObjectLockStore['releaseAuditVersionHold']>[0],
  ): Promise<boolean> {
    return this.setLegalHold('AUDIT', input, 'OFF');
  }

  public async listPrivacyObjectVersions(
    input: Parameters<PrivacyObjectVersionInventory['listPrivacyObjectVersions']>[0],
  ): ReturnType<PrivacyObjectVersionInventory['listPrivacyObjectVersions']> {
    const tenantId = input.tenantId.toLowerCase();
    if (!UUID.test(tenantId) || input.limit < 1 || input.limit > 1_000) {
      throw new Error('INVALID_PRIVACY_OBJECT_INVENTORY_REQUEST');
    }
    const workload = input.bucket === 'WORKLOAD_OBJECTS';
    const kind: BucketKind = input.bucket === 'AUDIT_EVIDENCE' ? 'AUDIT' : 'EXPORT';
    const workspaceId = readOptionalWorkspace(input.workspaceId);
    const prefix = workload
      ? `tenants/${tenantId}/workspaces/${workspaceId === null ? '' : `${workspaceId}/`}`
      : kind === 'EXPORT'
        ? `tenants/${tenantId}/exports/`
        : `tenants/${tenantId}/audit-digests/`;
    const marker = decodeInventoryCursor(input.cursor);
    // One page has one deadline: the list request and every exact-version HEAD
    // share this signal so a large page cannot multiply the remote timeout.
    const pageRequestOptions = { abortSignal: AbortSignal.timeout(30_000) };
    const result = await this.api.listObjectVersions(
      {
        Bucket: this.bucket(kind),
        Prefix: prefix,
        ExpectedBucketOwner: this.accountId,
        MaxKeys: input.limit,
        ...(marker === null
          ? {}
          : { KeyMarker: marker.keyMarker, VersionIdMarker: marker.versionIdMarker }),
      },
      pageRequestOptions,
    );
    const listed = [
      ...(result.Versions ?? []).map((version) => ({ ...version, isDeleteMarker: false as const })),
      ...(result.DeleteMarkers ?? []).map((version) => ({
        ...version,
        isDeleteMarker: true as const,
      })),
    ];
    const versions = await Promise.all(
      listed.map(async (version) => {
        if (version.Key === undefined || !version.Key.startsWith(prefix)) {
          throw new Error('S3_PRIVACY_OBJECT_INVENTORY_SCOPE_MISMATCH');
        }
        const objectVersionId = readVersionId(version.VersionId);
        if (!workload) {
          if (version.isDeleteMarker) {
            return {
              objectKey: version.Key,
              objectVersionId,
              isDeleteMarker: true as const,
              createdAt: readOptionalInventoryInstant(version.LastModified),
            };
          }
          return { objectKey: version.Key, objectVersionId };
        }
        const exactWorkspaceId = readWorkloadWorkspace(tenantId, version.Key);
        if (workspaceId !== null && exactWorkspaceId !== workspaceId) {
          throw new Error('S3_PRIVACY_OBJECT_INVENTORY_SCOPE_MISMATCH');
        }
        if (version.isDeleteMarker) {
          return {
            objectKey: version.Key,
            objectVersionId,
            workspaceId: exactWorkspaceId,
            isDeleteMarker: true as const,
            createdAt: readOptionalInventoryInstant(version.LastModified),
          };
        }
        const identity = {
          Bucket: this.exportBucket,
          Key: version.Key,
          VersionId: objectVersionId,
          ExpectedBucketOwner: this.accountId,
        };
        const metadata = await this.api.headObject(
          { ...identity, ChecksumMode: 'ENABLED' },
          pageRequestOptions,
        );
        if (metadata.VersionId !== objectVersionId) {
          throw new Error('S3_PRIVACY_OBJECT_INVENTORY_SCOPE_MISMATCH');
        }
        return {
          objectKey: version.Key,
          objectVersionId,
          workspaceId: exactWorkspaceId,
          ...this.readOptionalWorkloadMetadata(tenantId, exactWorkspaceId, metadata),
        };
      }),
    );
    if (result.IsTruncated !== true) return { versions, nextCursor: null };
    if (result.NextKeyMarker === undefined || result.NextVersionIdMarker === undefined) {
      throw new Error('S3_PRIVACY_OBJECT_INVENTORY_CURSOR_MISSING');
    }
    return {
      versions,
      nextCursor: encodeInventoryCursor({
        keyMarker: result.NextKeyMarker,
        versionIdMarker: result.NextVersionIdMarker,
      }),
    };
  }

  public async deleteWorkloadVersion(
    input: Parameters<WorkloadObjectDeletionStorage['deleteWorkloadVersion']>[0],
  ): Promise<'DELETED' | 'NOT_FOUND'> {
    const tenantId = input.tenantId.toLowerCase();
    const workspaceId = input.workspaceId.toLowerCase();
    if (readWorkloadWorkspace(tenantId, input.objectKey) !== workspaceId) {
      throw new Error('S3_WORKLOAD_OBJECT_SCOPE_MISMATCH');
    }
    const identity = {
      Bucket: this.exportBucket,
      Key: input.objectKey,
      VersionId: readVersionId(input.objectVersionId),
      ExpectedBucketOwner: this.accountId,
    };
    if (input.isDeleteMarker === true) {
      await this.api.deleteObject(identity);
      return 'DELETED';
    }
    try {
      const metadata = await this.api.headObject({ ...identity, ChecksumMode: 'ENABLED' });
      if (
        metadata.VersionId !== identity.VersionId ||
        (metadata.Metadata?.['tenant-id'] !== undefined &&
          metadata.Metadata['tenant-id'] !== tenantId) ||
        (metadata.Metadata?.['workspace-id'] !== undefined &&
          metadata.Metadata['workspace-id'] !== workspaceId)
      ) {
        throw new Error('S3_WORKLOAD_OBJECT_SCOPE_MISMATCH');
      }
      await this.api.deleteObject(identity);
      return 'DELETED';
    } catch (error: unknown) {
      if (isAwsNotFound(error)) return 'NOT_FOUND';
      throw error;
    }
  }

  private readOptionalWorkloadMetadata(
    tenantId: string,
    workspaceId: string,
    value: AwsS3ObjectMetadata,
  ): {
    checksum?: string;
    contentType?: string;
    byteLength?: number;
    createdAt?: string;
  } {
    const metadata = value.Metadata;
    const checksum = metadata?.sha256;
    const byteLength = value.ContentLength;
    const contentType = value.ContentType;
    const createdAt = value.LastModified;
    if (
      metadata?.['tenant-id'] !== tenantId ||
      metadata['workspace-id'] !== workspaceId ||
      checksum === undefined ||
      !SHA256.test(checksum) ||
      value.ChecksumSHA256 !== checksumBase64(checksum) ||
      byteLength === undefined ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 1 ||
      contentType === undefined ||
      value.ServerSideEncryption !== 'aws:kms' ||
      value.SSEKMSKeyId !== this.kmsKeyArn ||
      !(createdAt instanceof Date) ||
      !Number.isFinite(createdAt.getTime())
    ) {
      return {};
    }
    return {
      checksum,
      contentType: readContentType(contentType),
      byteLength,
      createdAt: createdAt.toISOString(),
    };
  }

  private async putVersion(
    kind: BucketKind,
    input: {
      tenantId: string;
      objectKey: string;
      body: Uint8Array;
      contentType: string;
      checksum: string;
    },
    lockedUntil: Date | null,
  ): Promise<StoredPrivacyObjectVersion> {
    const tenantId = readTenantKey(input.tenantId, input.objectKey);
    const now = safeNow(this.options.clock);
    const contentType = readContentType(input.contentType);
    const checksum = readChecksum(input.checksum);
    if (now === null || sha256(input.body) !== checksum) {
      throw new Error('S3_PRIVACY_OBJECT_CHECKSUM_MISMATCH');
    }
    const bucket = this.bucket(kind);
    const result = await this.api.putObject({
      Bucket: bucket,
      Key: input.objectKey,
      Body: input.body,
      ContentType: contentType,
      IfNoneMatch: '*',
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: checksumBase64(checksum),
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: this.kmsKeyArn,
      BucketKeyEnabled: true,
      ExpectedBucketOwner: this.accountId,
      Tagging: `TenantId=${encodeURIComponent(tenantId)}`,
      Metadata: { 'tenant-id': tenantId, sha256: checksum },
      ...(lockedUntil === null
        ? {}
        : { ObjectLockMode: 'GOVERNANCE' as const, ObjectLockRetainUntilDate: lockedUntil }),
    });
    const versionId = readVersionId(result.VersionId);
    return {
      tenantId,
      objectRef: objectReference(bucket, input.objectKey, versionId),
      objectKey: input.objectKey,
      objectVersionId: versionId,
      checksum,
      contentType,
      byteLength: input.body.byteLength,
      createdAt: new Date(now).toISOString(),
      lockedUntil: lockedUntil?.toISOString() ?? null,
    };
  }

  private async readVersion(
    kind: BucketKind,
    input: { tenantId: string; objectKey: string; objectVersionId: string },
  ): Promise<{ object: StoredPrivacyObjectVersion; body: Uint8Array } | null> {
    const identity = this.identity(kind, input);
    let result: Awaited<ReturnType<AwsS3PrivacyApi['getObject']>>;
    try {
      result = await this.api.getObject({ ...identity, ChecksumMode: 'ENABLED' });
    } catch (error: unknown) {
      if (isAwsNotFound(error)) return null;
      throw error;
    }
    const body = await readBody(result.Body);
    const object = this.readMetadata(kind, input, result, body.byteLength);
    if (sha256(body) !== object.checksum) throw new Error('S3_PRIVACY_OBJECT_CHECKSUM_MISMATCH');
    return { object, body };
  }

  private async deleteVersion(
    kind: BucketKind,
    input: {
      tenantId: string;
      objectKey: string;
      objectVersionId: string;
      at: Date;
      isDeleteMarker?: boolean;
    },
  ): Promise<PrivacyObjectDeleteResult> {
    const at = readInstant(input.at);
    if (at === null) return { outcome: 'INVALID_TIMELINE' };
    const identity = this.identity(kind, input);
    if (input.isDeleteMarker === true) {
      try {
        await this.api.deleteObject(identity);
        return { outcome: 'DELETED' };
      } catch (error: unknown) {
        if (isAwsNotFound(error)) return { outcome: 'NOT_FOUND' };
        throw error;
      }
    }
    let metadata: Awaited<ReturnType<AwsS3PrivacyApi['headObject']>>;
    try {
      metadata = await this.api.headObject({ ...identity, ChecksumMode: 'ENABLED' });
    } catch (error: unknown) {
      if (isAwsNotFound(error)) return { outcome: 'NOT_FOUND' };
      throw error;
    }
    const object = this.readMetadata(kind, input, metadata);
    const legalHold = await this.api.getObjectLegalHold(identity);
    if (legalHold.LegalHold?.Status === 'ON') return { outcome: 'LEGAL_HOLD' };
    if (
      object.lockedUntil !== null &&
      Number.isFinite(Date.parse(object.lockedUntil)) &&
      at < Date.parse(object.lockedUntil)
    ) {
      return { outcome: 'OBJECT_LOCKED' };
    }
    try {
      await this.api.deleteObject(identity);
    } catch (error: unknown) {
      if (isAwsNotFound(error)) return { outcome: 'NOT_FOUND' };
      throw error;
    }
    return { outcome: 'DELETED', object };
  }

  private async setLegalHold(
    kind: BucketKind,
    input: { tenantId: string; objectKey: string; objectVersionId: string; holdId: string },
    status: 'OFF' | 'ON',
  ): Promise<boolean> {
    if (input.holdId.trim().length === 0 || input.holdId.length > 200) return false;
    const identity = this.identity(kind, input);
    try {
      await this.api.putObjectLegalHold({ ...identity, LegalHold: { Status: status } });
      return true;
    } catch (error: unknown) {
      if (isAwsNotFound(error)) return false;
      throw error;
    }
  }

  private identity(
    kind: BucketKind,
    input: { tenantId: string; objectKey: string; objectVersionId: string },
  ): AwsS3ObjectIdentity {
    readTenantKey(input.tenantId, input.objectKey);
    return {
      Bucket: this.bucket(kind),
      Key: input.objectKey,
      VersionId: readVersionId(input.objectVersionId),
      ExpectedBucketOwner: this.accountId,
    };
  }

  private readMetadata(
    kind: BucketKind,
    input: { tenantId: string; objectKey: string; objectVersionId: string },
    value: AwsS3ObjectMetadata,
    bodyLength?: number,
  ): StoredPrivacyObjectVersion {
    const tenantId = readTenantKey(input.tenantId, input.objectKey);
    if (value.VersionId !== input.objectVersionId || value.Metadata?.['tenant-id'] !== tenantId) {
      throw new Error('S3_PRIVACY_OBJECT_SCOPE_MISMATCH');
    }
    const checksum = readChecksum(value.Metadata.sha256);
    if (value.ChecksumSHA256 !== undefined && value.ChecksumSHA256 !== checksumBase64(checksum)) {
      throw new Error('S3_PRIVACY_OBJECT_CHECKSUM_MISMATCH');
    }
    const byteLength = bodyLength ?? value.ContentLength;
    if (byteLength === undefined || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error('S3_PRIVACY_OBJECT_METADATA_INVALID');
    }
    const lockedAt = value.ObjectLockRetainUntilDate;
    const lockedUntil = lockedAt === undefined ? null : readInstant(lockedAt);
    if (lockedAt !== undefined && lockedUntil === null) {
      throw new Error('S3_PRIVACY_OBJECT_METADATA_INVALID');
    }
    const createdAt = safeNow(this.options.clock);
    if (createdAt === null) throw new Error('S3_PRIVACY_OBJECT_CLOCK_INVALID');
    return {
      tenantId,
      objectRef: objectReference(this.bucket(kind), input.objectKey, input.objectVersionId),
      objectKey: input.objectKey,
      objectVersionId: input.objectVersionId,
      checksum,
      contentType: readContentType(value.ContentType ?? 'application/octet-stream'),
      byteLength,
      createdAt: new Date(createdAt).toISOString(),
      lockedUntil: lockedUntil === null ? null : new Date(lockedUntil).toISOString(),
    };
  }

  private bucket(kind: BucketKind): string {
    return kind === 'AUDIT' ? this.auditBucket : this.exportBucket;
  }
}

function readTenantKey(tenantIdValue: string, objectKey: string): string {
  const tenantId = tenantIdValue.toLowerCase();
  if (!UUID.test(tenantId)) throw new Error('INVALID_TENANT_ID');
  if (
    !objectKey.startsWith(`tenants/${tenantId}/`) ||
    objectKey.length > 1_024 ||
    Buffer.byteLength(objectKey, 'utf8') > 1_024 ||
    objectKey.includes('..') ||
    objectKey.includes('\\') ||
    hasAsciiControlCharacter(objectKey)
  ) {
    throw new Error('S3_PRIVACY_OBJECT_TENANT_SCOPE_MISMATCH');
  }
  return tenantId;
}

function readOptionalWorkspace(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const workspaceId = value.toLowerCase();
  if (!UUID.test(workspaceId)) throw new Error('INVALID_WORKSPACE_ID');
  return workspaceId;
}

function readOptionalInventoryInstant(value: Date | undefined): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('S3_PRIVACY_OBJECT_INVENTORY_MARKER_TIME_INVALID');
  }
  return value.toISOString();
}

function readWorkloadWorkspace(tenantValue: string, objectKey: string): string {
  const tenantId = tenantValue.toLowerCase();
  if (!UUID.test(tenantId)) throw new Error('INVALID_TENANT_ID');
  if (
    objectKey.length > 1_024 ||
    Buffer.byteLength(objectKey, 'utf8') > 1_024 ||
    objectKey.includes('..') ||
    objectKey.includes('\\') ||
    hasAsciiControlCharacter(objectKey)
  ) {
    throw new Error('S3_WORKLOAD_OBJECT_SCOPE_MISMATCH');
  }
  const match = new RegExp(
    `^tenants/${escapeRegularExpression(tenantId)}/workspaces/` +
      '([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/.+',
    'iu',
  ).exec(objectKey);
  if (match?.[1] === undefined) throw new Error('S3_WORKLOAD_OBJECT_SCOPE_MISMATCH');
  return match[1].toLowerCase();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;

function readChecksum(value: string | undefined): string {
  if (value === undefined || !SHA256.test(value)) throw new Error('INVALID_SHA256_CHECKSUM');
  return value;
}

function checksumBase64(value: string): string {
  return Buffer.from(value, 'hex').toString('base64');
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function readVersionId(value: string | undefined): string {
  if (
    value === undefined ||
    value.length < 1 ||
    value.length > 1_024 ||
    hasAsciiControlCharacter(value)
  ) {
    throw new Error('S3_OBJECT_VERSION_ID_REQUIRED');
  }
  return value;
}

function readContentType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u.test(normalized)) {
    throw new Error('INVALID_S3_OBJECT_CONTENT_TYPE');
  }
  return normalized;
}

function readBucketName(value: string): string {
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(value) ||
    value.includes('..') ||
    /^\d+\.\d+\.\d+\.\d+$/u.test(value)
  ) {
    throw new Error('INVALID_S3_BUCKET_NAME');
  }
  return value;
}

async function readBody(
  value: Uint8Array | { transformToByteArray(): Promise<Uint8Array> } | undefined,
): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value !== undefined && typeof value.transformToByteArray === 'function') {
    return new Uint8Array(await value.transformToByteArray());
  }
  throw new Error('S3_PRIVACY_OBJECT_BODY_MISSING');
}

function readInstant(value: Date): number | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null;
}

function safeNow(clock: { now(): Date }): number | null {
  try {
    return readInstant(clock.now());
  } catch {
    return null;
  }
}

function objectReference(bucket: string, key: string, versionId: string): string {
  return `s3://${bucket}/${key}?versionId=${encodeURIComponent(versionId)}`;
}

function isAwsNotFound(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const error = value as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    ['NoSuchKey', 'NoSuchVersion', 'NotFound'].includes(String(error.name)) ||
    error.$metadata?.httpStatusCode === 404
  );
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function encodeInventoryCursor(value: { keyMarker: string; versionIdMarker: string }): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeInventoryCursor(
  value: string | null,
): { keyMarker: string; versionIdMarker: string } | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      keyMarker?: unknown;
      versionIdMarker?: unknown;
    };
    if (
      typeof parsed.keyMarker !== 'string' ||
      parsed.keyMarker.length < 1 ||
      parsed.keyMarker.length > 1_024 ||
      typeof parsed.versionIdMarker !== 'string' ||
      parsed.versionIdMarker.length < 1 ||
      parsed.versionIdMarker.length > 1_024
    ) {
      throw new Error('invalid');
    }
    return { keyMarker: parsed.keyMarker, versionIdMarker: parsed.versionIdMarker };
  } catch {
    throw new Error('INVALID_PRIVACY_OBJECT_INVENTORY_CURSOR');
  }
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}
