import type {
  EvidenceObjectRead,
  EvidenceObjectRecord,
  EvidenceObjectStore,
  EvidenceObjectWrite,
} from '@aeostudio/application/evidence-claims';

export interface AwsS3EvidenceApi {
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
    Metadata: {
      'tenant-id': string;
      'workspace-id': string;
      'source-id': string;
      'snapshot-id': string;
      sha256: string;
    };
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
}

export interface AwsS3EvidenceObjectStoreOptions {
  region: string;
  accountId: string;
  bucket: string;
  kmsKeyArn: string;
}

/** Production S3 adapter for server-owned immutable Evidence objects. */
export class AwsS3EvidenceObjectStore implements EvidenceObjectStore {
  private readonly accountId: string;
  private readonly bucket: string;
  private readonly kmsKeyArn: string;

  public constructor(
    private readonly api: AwsS3EvidenceApi,
    options: AwsS3EvidenceObjectStoreOptions,
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
  }

  async ingestExact(input: EvidenceObjectWrite): Promise<EvidenceObjectRecord> {
    if (
      !validWrite(input) ||
      input.body.byteLength !== input.sizeBytes ||
      sha256(input.body) !== input.contentHash
    ) {
      throw new Error('EVIDENCE_OBJECT_METADATA_MISMATCH');
    }
    const key = objectKey(input);
    const result = await this.api.putObject({
      Bucket: this.bucket,
      Key: key,
      Body: input.body.slice(),
      ContentType: input.contentType,
      IfNoneMatch: '*',
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: Buffer.from(input.contentHash, 'hex').toString('base64'),
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: this.kmsKeyArn,
      BucketKeyEnabled: true,
      ExpectedBucketOwner: this.accountId,
      Tagging:
        `TenantId=${encodeURIComponent(input.tenantId)}` +
        `&WorkspaceId=${encodeURIComponent(input.workspaceId)}`,
      Metadata: {
        'tenant-id': input.tenantId,
        'workspace-id': input.workspaceId,
        'source-id': input.sourceId,
        'snapshot-id': input.snapshotId,
        sha256: input.contentHash,
      },
    });
    const objectVersionId = readVersionId(result.VersionId);
    return {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      snapshotId: input.snapshotId,
      objectRef: `s3://${this.bucket}/${key}?versionId=${encodeURIComponent(objectVersionId)}`,
      objectVersionId,
      contentHash: input.contentHash,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
    };
  }

  async readExact(input: EvidenceObjectRecord): Promise<EvidenceObjectRead | null> {
    const expectedKey = objectKey(input);
    const identity = readObjectRef(input.objectRef, this.bucket);
    if (
      identity.key !== expectedKey ||
      identity.versionId !== input.objectVersionId ||
      !validRecord(input)
    ) {
      throw new Error('EVIDENCE_OBJECT_SCOPE_MISMATCH');
    }
    let result: Awaited<ReturnType<AwsS3EvidenceApi['getObject']>>;
    try {
      result = await this.api.getObject({
        Bucket: this.bucket,
        Key: expectedKey,
        VersionId: input.objectVersionId,
        ExpectedBucketOwner: this.accountId,
        ChecksumMode: 'ENABLED',
      });
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const metadata = result.Metadata;
    if (
      metadata?.['tenant-id'] !== input.tenantId ||
      metadata?.['workspace-id'] !== input.workspaceId ||
      metadata?.['source-id'] !== input.sourceId ||
      metadata?.['snapshot-id'] !== input.snapshotId
    ) {
      throw new Error('EVIDENCE_OBJECT_SCOPE_MISMATCH');
    }
    const body = await readBody(result.Body);
    const expectedChecksum = Buffer.from(input.contentHash, 'hex').toString('base64');
    if (
      result.VersionId !== input.objectVersionId ||
      normalizeContentType(result.ContentType ?? '') !== input.contentType ||
      result.ContentLength !== input.sizeBytes ||
      result.ChecksumSHA256 !== expectedChecksum ||
      metadata.sha256 !== input.contentHash ||
      Object.keys(metadata).length !== 5 ||
      body.byteLength !== input.sizeBytes ||
      sha256(body) !== input.contentHash
    ) {
      throw new Error('EVIDENCE_OBJECT_METADATA_MISMATCH');
    }
    return { ...input, body };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;

function validRecord(input: EvidenceObjectRecord): boolean {
  return (
    validWrite(input) &&
    input.objectRef.length > 0 &&
    input.objectRef.length <= 2048 &&
    input.objectVersionId.length > 0 &&
    input.objectVersionId.length <= 1024
  );
}

function validWrite(input: Omit<EvidenceObjectRecord, 'objectRef' | 'objectVersionId'>): boolean {
  return (
    UUID.test(input.tenantId) &&
    UUID.test(input.workspaceId) &&
    UUID.test(input.sourceId) &&
    UUID.test(input.snapshotId) &&
    SHA256.test(input.contentHash) &&
    normalizeContentType(input.contentType) === input.contentType &&
    Number.isSafeInteger(input.sizeBytes) &&
    input.sizeBytes > 0 &&
    input.sizeBytes <= 10 * 1024 * 1024
  );
}

function objectKey(
  input: Pick<
    EvidenceObjectRecord,
    'tenantId' | 'workspaceId' | 'sourceId' | 'snapshotId' | 'contentHash'
  >,
): string {
  return (
    `tenants/${input.tenantId}/workspaces/${input.workspaceId}` +
    `/evidence-sources/${input.sourceId}/snapshots/${input.snapshotId}/${input.contentHash}`
  );
}

function readObjectRef(objectRef: string, bucket: string): { key: string; versionId: string } {
  let url: URL;
  try {
    url = new URL(objectRef);
  } catch {
    throw new Error('EVIDENCE_OBJECT_SCOPE_MISMATCH');
  }
  const keys = [...url.searchParams.keys()];
  const versionId = url.searchParams.get('versionId') ?? '';
  if (
    url.protocol !== 's3:' ||
    url.hostname !== bucket ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    keys.length !== 1 ||
    keys[0] !== 'versionId' ||
    versionId.length < 1 ||
    versionId.length > 1024
  ) {
    throw new Error('EVIDENCE_OBJECT_SCOPE_MISMATCH');
  }
  return { key: url.pathname.slice(1), versionId };
}

async function readBody(
  value: Uint8Array | { transformToByteArray(): Promise<Uint8Array> } | undefined,
): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value.slice();
  if (value !== undefined) return new Uint8Array(await value.transformToByteArray());
  throw new Error('EVIDENCE_OBJECT_BODY_MISSING');
}

function normalizeContentType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function readVersionId(value: string | undefined): string {
  if (
    value === undefined ||
    value.length < 1 ||
    value.length > 1024 ||
    // eslint-disable-next-line no-control-regex -- intentional control character validation
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error('EVIDENCE_OBJECT_VERSION_ID_REQUIRED');
  }
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isNotFound(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const error = value as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    ['NoSuchKey', 'NoSuchVersion', 'NotFound'].includes(String(error.name)) ||
    error.$metadata?.httpStatusCode === 404
  );
}

function validBucket(value: string): boolean {
  return (
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(value) &&
    !value.includes('..') &&
    !/^\d+\.\d+\.\d+\.\d+$/u.test(value)
  );
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
import { createHash } from 'node:crypto';
