import { createHash } from 'node:crypto';

import { canonicalArtifactJson, type ArtifactPayloadStore } from '@aeostudio/application/artifacts';
import type { ChannelPackagePayloadStore } from '@aeostudio/application/channels-publishing';
import type {
  PreparedWorkloadObjectWrite,
  StoredWorkloadObjectVersion,
  WorkloadObjectRecoveryStorage,
  WorkloadObjectVersionStorage,
} from '@aeostudio/application/privacy-audit';
import type { CrawlObjectStorage } from '@aeostudio/application/site-crawl';
import type { ArtifactPayload } from '@aeostudio/domain/artifacts';
import type { ChannelPackagePayload } from '@aeostudio/domain/channels-publishing';

export interface AwsS3WorkloadApi {
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
    Metadata: { 'tenant-id': string; 'workspace-id': string; sha256: string };
  }): Promise<{ VersionId?: string | undefined }>;
  getObject(input: {
    Bucket: string;
    Key: string;
    VersionId: string;
    ExpectedBucketOwner: string;
    ChecksumMode: 'ENABLED';
  }): Promise<{
    VersionId?: string | undefined;
    ContentType?: string | undefined;
    ContentLength?: number | undefined;
    ChecksumSHA256?: string | undefined;
    Metadata?: Record<string, string> | undefined;
    Body?: Uint8Array | { transformToByteArray(): Promise<Uint8Array> } | undefined;
  }>;
  headObject(input: {
    Bucket: string;
    Key: string;
    ExpectedBucketOwner: string;
    ChecksumMode: 'ENABLED';
  }): Promise<{
    VersionId?: string | undefined;
    ContentType?: string | undefined;
    ContentLength?: number | undefined;
    ChecksumSHA256?: string | undefined;
    Metadata?: Record<string, string> | undefined;
    LastModified?: Date | undefined;
    ServerSideEncryption?: string | undefined;
    SSEKMSKeyId?: string | undefined;
  }>;
}

export interface AwsS3WorkloadObjectStorageOptions {
  region: string;
  accountId: string;
  bucket: string;
  kmsKeyArn: string;
  clock?: { now(): Date };
}

type ArtifactPut = Parameters<ArtifactPayloadStore['put']>[0];
type ChannelPackagePut = Parameters<ChannelPackagePayloadStore['put']>[0];

/** Production S3 boundary shared by crawl, Artifact and channel-package workloads. */
export class AwsS3WorkloadObjectStorage
  implements
    ArtifactPayloadStore,
    CrawlObjectStorage,
    WorkloadObjectVersionStorage,
    WorkloadObjectRecoveryStorage
{
  private readonly accountId: string;
  private readonly bucket: string;
  private readonly kmsKeyArn: string;
  private readonly clock: { now(): Date };

  constructor(
    private readonly api: AwsS3WorkloadApi,
    options: AwsS3WorkloadObjectStorageOptions,
  ) {
    if (options.region !== 'ap-southeast-1') throw new Error('AWS_S3_SINGAPORE_REGION_REQUIRED');
    if (!/^\d{12}$/u.test(options.accountId)) throw new Error('INVALID_AWS_ACCOUNT_ID');
    if (!validBucket(options.bucket)) throw new Error('INVALID_S3_BUCKET_NAME');
    const account = escapeRegularExpression(options.accountId);
    if (
      !new RegExp(`^arn:aws:kms:ap-southeast-1:${account}:key/[0-9a-f-]{36}$`, 'iu').test(
        options.kmsKeyArn,
      )
    ) {
      throw new Error('AWS_S3_KMS_KEY_OUTSIDE_RUNTIME_SCOPE');
    }
    this.accountId = options.accountId;
    this.bucket = options.bucket;
    this.kmsKeyArn = options.kmsKeyArn;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  public async put(input: ArtifactPut): Promise<{ objectRef: string }> {
    const stored = await this.putWorkloadVersion(this.prepareArtifactPayload(input));
    return { objectRef: stored.objectRef };
  }

  public prepareArtifactPayload(input: ArtifactPut): PreparedWorkloadObjectWrite {
    const scope = readScope(input.tenantId, input.workspaceId);
    readUuid(input.artifactId, 'ARTIFACT');
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new Error('INVALID_ARTIFACT_REVISION');
    }
    readChecksum(input.contentHash);
    const key =
      `${scope.prefix}/artifacts/${input.artifactId.toLowerCase()}/revisions/` +
      `${input.revision}/${input.contentHash}.json`;
    return this.prepareJson('ARTIFACT_PAYLOAD', key, scope, input.payload);
  }

  get(objectRef: string): Promise<ArtifactPayload | null> {
    return this.getJson<ArtifactPayload>(objectRef);
  }

  public async putChannelPackage(input: ChannelPackagePut): Promise<{ objectRef: string }> {
    const stored = await this.putWorkloadVersion(this.prepareChannelPackage(input));
    return { objectRef: stored.objectRef };
  }

  public prepareChannelPackage(input: ChannelPackagePut): PreparedWorkloadObjectWrite {
    const scope = readScope(input.tenantId, input.workspaceId);
    readChecksum(input.packageChecksum);
    return this.prepareJson(
      'CHANNEL_PACKAGE',
      `${scope.prefix}/channel-packages/${input.packageChecksum}.json`,
      scope,
      input.payload,
    );
  }

  getChannelPackage(objectRef: string): Promise<ChannelPackagePayload | null> {
    return this.getJson<ChannelPackagePayload>(objectRef);
  }

  public async putObject(
    input: Parameters<CrawlObjectStorage['putObject']>[0],
  ): Promise<{ objectRef: string }> {
    const stored = await this.putWorkloadVersion(this.prepareCrawlSnapshot(input));
    return { objectRef: stored.objectRef };
  }

  public prepareCrawlSnapshot(
    input: Parameters<CrawlObjectStorage['putObject']>[0],
  ): PreparedWorkloadObjectWrite {
    const match =
      /^tenants\/([^/]+)\/workspaces\/([^/]+)\/sites\/([^/]+)\/snapshots\/([a-f0-9]{64})$/u.exec(
        input.key,
      );
    if (match === null) throw new Error('S3_WORKLOAD_OBJECT_SCOPE_MISMATCH');
    const scope = readScope(match[1] ?? '', match[2] ?? '');
    readUuid(match[3] ?? '', 'SITE');
    const checksum = readChecksum(input.checksum);
    if (match[4] !== checksum || sha256(input.body) !== checksum) {
      throw new Error('S3_WORKLOAD_OBJECT_CHECKSUM_MISMATCH');
    }
    return this.prepareBytes(
      'CRAWL_SNAPSHOT',
      input.key,
      scope,
      input.body,
      readContentType(input.contentType),
    );
  }

  channelPackages(): ChannelPackagePayloadStore {
    return {
      put: (input) => this.putChannelPackage(input),
      get: (objectRef) => this.getChannelPackage(objectRef),
    };
  }

  private prepareJson(
    kind: PreparedWorkloadObjectWrite['kind'],
    key: string,
    scope: Scope,
    value: ArtifactPayload | ChannelPackagePayload,
  ): PreparedWorkloadObjectWrite {
    return this.prepareBytes(
      kind,
      key,
      scope,
      new TextEncoder().encode(canonicalArtifactJson(value)),
      'application/json',
    );
  }

  private prepareBytes(
    kind: PreparedWorkloadObjectWrite['kind'],
    key: string,
    scope: Scope,
    body: Uint8Array,
    contentType: string,
  ): PreparedWorkloadObjectWrite {
    const checksum = sha256(body);
    return {
      kind,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      objectKey: key,
      canonicalPayload: body.slice(),
      checksum,
      contentType,
      byteLength: body.byteLength,
    };
  }

  public async putWorkloadVersion(
    input: PreparedWorkloadObjectWrite,
  ): Promise<StoredWorkloadObjectVersion> {
    const scope = readScope(input.tenantId, input.workspaceId);
    validatePreparedWorkloadObject(input, scope);
    const body = input.canonicalPayload;
    const checksum = readChecksum(input.checksum);
    const result = await this.api.putObject({
      Bucket: this.bucket,
      Key: input.objectKey,
      Body: body,
      ContentType: input.contentType,
      IfNoneMatch: '*',
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: this.kmsKeyArn,
      BucketKeyEnabled: true,
      ExpectedBucketOwner: this.accountId,
      Tagging:
        `TenantId=${encodeURIComponent(scope.tenantId)}` +
        `&WorkspaceId=${encodeURIComponent(scope.workspaceId)}`,
      Metadata: {
        'tenant-id': scope.tenantId,
        'workspace-id': scope.workspaceId,
        sha256: checksum,
      },
    });
    const versionId = readVersionId(result.VersionId);
    const createdAt = this.clock.now();
    if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) {
      throw new Error('S3_WORKLOAD_OBJECT_TIME_INVALID');
    }
    return {
      kind: input.kind,
      objectClass: input.kind,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      objectRef: `s3://${this.bucket}/${input.objectKey}?versionId=${encodeURIComponent(versionId)}`,
      objectKey: input.objectKey,
      objectVersionId: versionId,
      checksum,
      contentType: input.contentType,
      byteLength: body.byteLength,
      createdAt: createdAt.toISOString(),
    };
  }

  public async recoverWorkloadVersion(
    input: Parameters<WorkloadObjectRecoveryStorage['recoverWorkloadVersion']>[0],
  ): ReturnType<WorkloadObjectRecoveryStorage['recoverWorkloadVersion']> {
    const scope = readScope(input.tenantId, input.workspaceId);
    validateWorkloadIntentMetadata(input, scope);
    let metadata: Awaited<ReturnType<AwsS3WorkloadApi['headObject']>>;
    try {
      metadata = await this.api.headObject({
        Bucket: this.bucket,
        Key: input.objectKey,
        ExpectedBucketOwner: this.accountId,
        ChecksumMode: 'ENABLED',
      });
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const versionId = readVersionId(metadata.VersionId);
    const lastModified = metadata.LastModified;
    if (
      metadata.ContentType !== input.contentType ||
      metadata.ContentLength !== input.byteLength ||
      metadata.ChecksumSHA256 !== Buffer.from(input.checksum, 'hex').toString('base64') ||
      metadata.Metadata?.['tenant-id'] !== scope.tenantId ||
      metadata.Metadata['workspace-id'] !== scope.workspaceId ||
      metadata.Metadata.sha256 !== input.checksum ||
      Object.keys(metadata.Metadata).length !== 3 ||
      metadata.ServerSideEncryption !== 'aws:kms' ||
      metadata.SSEKMSKeyId !== this.kmsKeyArn ||
      !(lastModified instanceof Date) ||
      !Number.isFinite(lastModified.getTime())
    ) {
      throw new Error('S3_WORKLOAD_OBJECT_RECOVERY_MISMATCH');
    }
    return {
      kind: input.kind,
      objectClass: input.kind,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      objectRef: `s3://${this.bucket}/${input.objectKey}?versionId=${encodeURIComponent(versionId)}`,
      objectKey: input.objectKey,
      objectVersionId: versionId,
      checksum: input.checksum,
      contentType: input.contentType,
      byteLength: input.byteLength,
      createdAt: lastModified.toISOString(),
    };
  }

  private async getJson<T extends ArtifactPayload | ChannelPackagePayload>(
    objectRef: string,
  ): Promise<T | null> {
    const identity = this.readObjectRef(objectRef);
    let result: Awaited<ReturnType<AwsS3WorkloadApi['getObject']>>;
    try {
      result = await this.api.getObject({
        ...identity,
        ExpectedBucketOwner: this.accountId,
        ChecksumMode: 'ENABLED',
      });
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const body = await readBody(result.Body);
    if (
      result.VersionId !== identity.VersionId ||
      result.ContentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' ||
      result.ContentLength !== body.byteLength ||
      result.Metadata?.['tenant-id'] !== identity.scope.tenantId ||
      result.Metadata?.['workspace-id'] !== identity.scope.workspaceId
    ) {
      throw new Error('S3_WORKLOAD_OBJECT_SCOPE_MISMATCH');
    }
    const checksum = readChecksum(result.Metadata.sha256);
    if (
      sha256(body) !== checksum ||
      (result.ChecksumSHA256 !== undefined &&
        result.ChecksumSHA256 !== Buffer.from(checksum, 'hex').toString('base64'))
    ) {
      throw new Error('S3_WORKLOAD_OBJECT_CHECKSUM_MISMATCH');
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as T;
    } catch {
      throw new Error('S3_WORKLOAD_OBJECT_JSON_INVALID');
    }
  }

  private readObjectRef(objectRef: string): {
    Bucket: string;
    Key: string;
    VersionId: string;
    scope: Scope;
  } {
    let url: URL;
    try {
      url = new URL(objectRef);
    } catch {
      throw new Error('S3_WORKLOAD_OBJECT_SCOPE_MISMATCH');
    }
    const key = url.pathname.slice(1);
    const match = /^tenants\/([^/]+)\/workspaces\/([^/]+)\/(?:artifacts|channel-packages)\//u.exec(
      key,
    );
    if (
      url.protocol !== 's3:' ||
      url.hostname !== this.bucket ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== '' ||
      match === null ||
      [...url.searchParams.keys()].length !== 1
    ) {
      throw new Error('S3_WORKLOAD_OBJECT_SCOPE_MISMATCH');
    }
    return {
      Bucket: this.bucket,
      Key: key,
      VersionId: readVersionId(url.searchParams.get('versionId') ?? undefined),
      scope: readScope(match[1] ?? '', match[2] ?? ''),
    };
  }
}

interface Scope {
  tenantId: string;
  workspaceId: string;
  prefix: string;
}

function readScope(tenantValue: string, workspaceValue: string): Scope {
  const tenantId = readUuid(tenantValue, 'TENANT');
  const workspaceId = readUuid(workspaceValue, 'WORKSPACE');
  return {
    tenantId,
    workspaceId,
    prefix: `tenants/${tenantId}/workspaces/${workspaceId}`,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;

function readUuid(value: string, kind: string): string {
  if (!UUID.test(value)) throw new Error(`INVALID_${kind}_ID`);
  return value.toLowerCase();
}

function readChecksum(value: string | undefined): string {
  if (value === undefined || !SHA256.test(value)) throw new Error('INVALID_SHA256_CHECKSUM');
  return value;
}

function readVersionId(value: string | undefined): string {
  if (
    value === undefined ||
    value.length < 1 ||
    value.length > 1_024 ||
    hasControlCharacter(value)
  ) {
    throw new Error('S3_OBJECT_VERSION_ID_REQUIRED');
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function readContentType(value: string): string {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u.test(normalized)) {
    throw new Error('INVALID_S3_OBJECT_CONTENT_TYPE');
  }
  return normalized;
}

function validBucket(value: string): boolean {
  return (
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(value) &&
    !value.includes('..') &&
    !/^\d+\.\d+\.\d+\.\d+$/u.test(value)
  );
}

async function readBody(
  value: Uint8Array | { transformToByteArray(): Promise<Uint8Array> } | undefined,
): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value.slice();
  if (value !== undefined) return new Uint8Array(await value.transformToByteArray());
  throw new Error('S3_WORKLOAD_OBJECT_BODY_MISSING');
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function validatePreparedWorkloadObject(input: PreparedWorkloadObjectWrite, scope: Scope): void {
  validateWorkloadIntentMetadata(input, scope);
  if (
    !(input.canonicalPayload instanceof Uint8Array) ||
    input.canonicalPayload.byteLength < 1 ||
    input.byteLength !== input.canonicalPayload.byteLength ||
    sha256(input.canonicalPayload) !== readChecksum(input.checksum) ||
    readContentType(input.contentType) !== input.contentType
  ) {
    throw new Error('S3_WORKLOAD_OBJECT_CHECKSUM_MISMATCH');
  }
}

function validateWorkloadIntentMetadata(
  input: {
    kind: PreparedWorkloadObjectWrite['kind'];
    tenantId: string;
    workspaceId: string;
    objectKey: string;
    checksum: string;
    contentType: string;
    byteLength: number;
  },
  scope: Scope,
): void {
  if (
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 1 ||
    input.byteLength > 2_147_483_648 ||
    readChecksum(input.checksum) !== input.checksum ||
    readContentType(input.contentType) !== input.contentType
  ) {
    throw new Error('S3_WORKLOAD_OBJECT_CHECKSUM_MISMATCH');
  }
  const root = escapeRegularExpression(scope.prefix);
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const checksum = '[a-f0-9]{64}';
  const pattern =
    input.kind === 'CRAWL_SNAPSHOT'
      ? new RegExp(`^${root}/sites/${uuid}/snapshots/${checksum}$`, 'u')
      : input.kind === 'ARTIFACT_PAYLOAD'
        ? new RegExp(`^${root}/artifacts/${uuid}/revisions/[1-9][0-9]*/${checksum}\\.json$`, 'u')
        : new RegExp(`^${root}/channel-packages/${checksum}\\.json$`, 'u');
  if (!pattern.test(input.objectKey)) throw new Error('S3_WORKLOAD_OBJECT_SCOPE_MISMATCH');
}

function isNotFound(value: unknown): boolean {
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
