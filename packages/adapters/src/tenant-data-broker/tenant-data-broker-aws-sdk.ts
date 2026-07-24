import { Readable } from 'node:stream';

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectLegalHoldCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListPartsCommand,
  PutObjectCommand,
  PutObjectLegalHoldCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import {
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

import type {
  TenantDataBrokerS3Port,
  TenantDataBrokerSecretsPort,
} from './tenant-data-broker-aws-executor.js';

type CloudRecord = Record<string, unknown>;

interface AwsSdkClientPort {
  send(command: object, options: { abortSignal: AbortSignal }): Promise<unknown>;
  destroy(): void;
}

export interface AwsTenantDataBrokerCloudResource {
  s3: TenantDataBrokerS3Port;
  secrets: TenantDataBrokerSecretsPort;
  close(): void;
}

export function createAwsTenantDataBrokerCloudResource(input: {
  region: string;
  s3Client?: AwsSdkClientPort;
  secretsClient?: AwsSdkClientPort;
}): AwsTenantDataBrokerCloudResource {
  if (input.region !== 'ap-southeast-1') {
    throw new Error('AWS_SINGAPORE_REGION_REQUIRED');
  }
  const s3Client = input.s3Client ?? new S3Client({ region: input.region });
  const secretsClient =
    input.secretsClient ??
    new SecretsManagerClient({
      region: input.region,
    });
  let closed = false;

  return {
    s3: createS3Port(s3Client),
    secrets: createSecretsPort(secretsClient),
    close() {
      if (closed) return;
      closed = true;
      s3Client.destroy();
      secretsClient.destroy();
    },
  };
}

function createS3Port(client: AwsSdkClientPort): TenantDataBrokerS3Port {
  return {
    async putObject(raw, signal) {
      const result = await send(
        client,
        new PutObjectCommand({
          ...mapObjectIdentity(raw, false),
          Body: readStreamingBody(raw.body),
          BucketKeyEnabled: readBoolean(raw.bucketKeyEnabled),
          ChecksumSHA256: readString(raw.checksumSha256),
          ContentLength: readInteger(raw.contentLength),
          ContentType: readString(raw.contentType),
          IfNoneMatch: readString(raw.ifNoneMatch),
          Metadata: readStringRecord(raw.metadata),
          ServerSideEncryption: readExact(raw.serverSideEncryption, 'aws:kms'),
          SSEKMSKeyId: readString(raw.sseKmsKeyId),
          ...mapRetention(raw),
        }),
        signal,
      );
      return { versionId: optionalString(result.VersionId) };
    },

    async createMultipartUpload(raw, signal) {
      const result = await send(
        client,
        new CreateMultipartUploadCommand({
          ...mapObjectIdentity(raw, false),
          BucketKeyEnabled: readBoolean(raw.bucketKeyEnabled),
          ChecksumAlgorithm: readExact(raw.checksumAlgorithm, 'SHA256'),
          ChecksumType: readExact(raw.checksumType, 'COMPOSITE'),
          ContentType: readString(raw.contentType),
          Metadata: readStringRecord(raw.metadata),
          ServerSideEncryption: readExact(raw.serverSideEncryption, 'aws:kms'),
          SSEKMSKeyId: readString(raw.sseKmsKeyId),
          ...mapRetention(raw),
        }),
        signal,
      );
      return { uploadId: optionalString(result.UploadId) };
    },

    async uploadPart(raw, signal) {
      const result = await send(
        client,
        new UploadPartCommand({
          ...mapObjectIdentity(raw, false),
          Body: readStreamingBody(raw.body),
          ChecksumSHA256: readString(raw.checksumSha256),
          ContentLength: readInteger(raw.contentLength),
          PartNumber: readInteger(raw.partNumber),
          UploadId: readString(raw.uploadId),
        }),
        signal,
      );
      return {
        etag: optionalString(result.ETag),
        checksumSha256: optionalString(result.ChecksumSHA256),
      };
    },

    async completeMultipartUpload(raw, signal) {
      const result = await send(
        client,
        new CompleteMultipartUploadCommand({
          ...mapObjectIdentity(raw, false),
          ChecksumType: readExact(raw.checksumType, 'COMPOSITE'),
          IfNoneMatch: readString(raw.ifNoneMatch),
          MpuObjectSize: readInteger(raw.mpuObjectSize),
          MultipartUpload: {
            Parts: readCompletedParts(raw.parts),
          },
          UploadId: readString(raw.uploadId),
        }),
        signal,
      );
      return { versionId: optionalString(result.VersionId) };
    },

    async abortMultipartUpload(raw, signal) {
      await send(
        client,
        new AbortMultipartUploadCommand({
          ...mapObjectIdentity(raw, false),
          UploadId: readString(raw.uploadId),
        }),
        signal,
      );
      return {};
    },

    async listParts(raw, signal) {
      const result = await send(
        client,
        new ListPartsCommand({
          ...mapObjectIdentity(raw, false),
          UploadId: readString(raw.uploadId),
        }),
        signal,
      );
      return {
        parts: Array.isArray(result.Parts)
          ? result.Parts.map((part) => normalizePart(requireRecord(part)))
          : [],
      };
    },

    async getObject(raw, signal) {
      const result = await send(
        client,
        new GetObjectCommand({
          ...mapObjectIdentity(raw, true),
          ChecksumMode: readExact(raw.checksumMode, 'ENABLED'),
        }),
        signal,
      );
      return {
        body: result.Body,
        versionId: optionalString(result.VersionId),
        metadata: optionalStringRecord(result.Metadata),
        contentType: optionalString(result.ContentType),
        byteLength: optionalInteger(result.ContentLength),
        checksumSha256: optionalString(result.ChecksumSHA256),
      };
    },

    async headObject(raw, signal) {
      const command = new HeadObjectCommand({
        ...mapObjectIdentity(raw, hasOwn(raw, 'versionId')),
        ChecksumMode: readExact(raw.checksumMode, 'ENABLED'),
      });
      let result: CloudRecord;
      try {
        result = await send(client, command, signal);
      } catch (error: unknown) {
        if (isS3HeadNotFound(error)) return { exists: false };
        throw error;
      }
      return {
        exists: true,
        versionId: optionalString(result.VersionId),
        metadata: optionalStringRecord(result.Metadata),
        contentType: optionalString(result.ContentType),
        byteLength: optionalInteger(result.ContentLength),
        checksumSha256: optionalString(result.ChecksumSHA256),
        objectLockRetainUntilDate: optionalDate(result.ObjectLockRetainUntilDate),
      };
    },

    async deleteObject(raw, signal) {
      const result = await send(
        client,
        new DeleteObjectCommand(mapObjectIdentity(raw, true)),
        signal,
      );
      return {
        versionId: optionalString(result.VersionId),
        deleteMarker: optionalBoolean(result.DeleteMarker),
      };
    },

    async listObjectVersions(raw, signal) {
      const result = await send(
        client,
        new ListObjectVersionsCommand({
          Bucket: readString(raw.bucket),
          ExpectedBucketOwner: readString(raw.expectedBucketOwner),
          Prefix: readString(raw.prefix),
          MaxKeys: readInteger(raw.maxKeys),
          ...(hasOwn(raw, 'keyMarker') ? { KeyMarker: readString(raw.keyMarker) } : {}),
          ...(hasOwn(raw, 'versionIdMarker')
            ? { VersionIdMarker: readString(raw.versionIdMarker) }
            : {}),
        }),
        signal,
      );
      return {
        versions: normalizeVersionEntries(result.Versions),
        deleteMarkers: normalizeVersionEntries(result.DeleteMarkers),
        isTruncated: result.IsTruncated === true,
        nextKeyMarker: optionalString(result.NextKeyMarker),
        nextVersionIdMarker: optionalString(result.NextVersionIdMarker),
      };
    },

    async getObjectLegalHold(raw, signal) {
      const result = await send(
        client,
        new GetObjectLegalHoldCommand(mapObjectIdentity(raw, true)),
        signal,
      );
      const legalHold = requireRecord(result.LegalHold);
      return { status: optionalString(legalHold.Status) };
    },

    async putObjectLegalHold(raw, signal) {
      const legalHold = requireRecord(raw.legalHold);
      await send(
        client,
        new PutObjectLegalHoldCommand({
          ...mapObjectIdentity(raw, true),
          LegalHold: {
            Status: readOneOf(legalHold.status, ['ON', 'OFF'] as const),
          },
        }),
        signal,
      );
      return {};
    },
  };
}

function createSecretsPort(client: AwsSdkClientPort): TenantDataBrokerSecretsPort {
  return {
    async getSecretValue(raw, signal) {
      const result = await send(
        client,
        new GetSecretValueCommand({ SecretId: readString(raw.secretId) }),
        signal,
      );
      return {
        secretString: optionalString(result.SecretString),
        ...(result.SecretBinary instanceof Uint8Array ? { secretBinary: result.SecretBinary } : {}),
      };
    },

    async describeSecret(raw, signal) {
      let result: CloudRecord;
      try {
        result = await send(
          client,
          new DescribeSecretCommand({ SecretId: readString(raw.secretId) }),
          signal,
        );
      } catch (error: unknown) {
        if (isResourceNotFound(error)) return { exists: false };
        throw error;
      }
      return {
        exists: true,
        ...(result.DeletedDate instanceof Date && Number.isFinite(result.DeletedDate.getTime())
          ? { deletedAt: result.DeletedDate.toISOString() }
          : {}),
      };
    },

    async deleteSecret(raw, signal) {
      await send(
        client,
        new DeleteSecretCommand({
          SecretId: readString(raw.secretId),
          ForceDeleteWithoutRecovery: readBoolean(raw.forceDeleteWithoutRecovery),
        }),
        signal,
      );
      return { deleted: true };
    },
  };
}

async function send(
  client: AwsSdkClientPort,
  command: object,
  signal: AbortSignal,
): Promise<CloudRecord> {
  const result = await client.send(command, { abortSignal: signal });
  return requireRecord(result);
}

function isResourceNotFound(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return (
    candidate.name === 'ResourceNotFoundException' || candidate.code === 'ResourceNotFoundException'
  );
}

function isS3HeadNotFound(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as {
    $metadata?: unknown;
    code?: unknown;
    name?: unknown;
  };
  const metadata =
    candidate.$metadata !== null && typeof candidate.$metadata === 'object'
      ? (candidate.$metadata as { httpStatusCode?: unknown })
      : null;
  const errorNames = [candidate.name, candidate.code].filter(
    (value): value is string => typeof value === 'string',
  );
  return (
    metadata?.httpStatusCode === 404 &&
    errorNames.some((value) => value === 'NotFound' || value === 'NoSuchKey')
  );
}

function mapObjectIdentity(
  raw: CloudRecord,
  requireVersion: boolean,
): {
  Bucket: string;
  Key: string;
  ExpectedBucketOwner: string;
  VersionId?: string;
} {
  const base = {
    Bucket: readString(raw.bucket),
    Key: readString(raw.key),
    ExpectedBucketOwner: readString(raw.expectedBucketOwner),
  };
  return requireVersion ? { ...base, VersionId: readString(raw.versionId) } : base;
}

function mapRetention(raw: CloudRecord): {
  ObjectLockMode?: 'COMPLIANCE';
  ObjectLockRetainUntilDate?: Date;
} {
  if (!hasOwn(raw, 'objectLockMode') && !hasOwn(raw, 'objectLockRetainUntilDate')) {
    return {};
  }
  return {
    ObjectLockMode: readExact(raw.objectLockMode, 'COMPLIANCE'),
    ObjectLockRetainUntilDate: readDate(raw.objectLockRetainUntilDate),
  };
}

function readCompletedParts(
  value: unknown,
): Array<{ ChecksumSHA256: string; ETag: string; PartNumber: number }> {
  if (!Array.isArray(value) || value.length < 1) invalidInput();
  return value.map((part) => {
    const record = requireRecord(part);
    return {
      ChecksumSHA256: readString(record.checksumSha256),
      ETag: readString(record.etag),
      PartNumber: readInteger(record.partNumber),
    };
  });
}

function normalizePart(value: CloudRecord): CloudRecord {
  return {
    etag: optionalString(value.ETag),
    checksumSha256: optionalString(value.ChecksumSHA256),
    partNumber: optionalInteger(value.PartNumber),
    size: optionalInteger(value.Size),
  };
}

function normalizeVersionEntries(value: unknown): CloudRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalidResponse();
  return value.map((entry) => {
    const record = requireRecord(entry);
    return {
      key: optionalString(record.Key),
      versionId: optionalString(record.VersionId),
      lastModified: optionalDate(record.LastModified),
    };
  });
}

function readStreamingBody(value: unknown): Readable {
  if (
    value === null ||
    typeof value !== 'object' ||
    !(Symbol.asyncIterator in value) ||
    typeof value[Symbol.asyncIterator] !== 'function'
  ) {
    return invalidInput();
  }
  return Readable.from(value as AsyncIterable<Uint8Array>);
}

function readString(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1) return invalidInput();
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalidInput();
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalidInput();
  return value as number;
}

function optionalInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? (value as number) : undefined;
}

function readDate(value: unknown): Date {
  const date =
    value instanceof Date ? new Date(value) : typeof value === 'string' ? new Date(value) : null;
  if (date === null || !Number.isFinite(date.getTime())) return invalidInput();
  return date;
}

function optionalDate(value: unknown): Date | undefined {
  return value instanceof Date && Number.isFinite(value.getTime()) ? new Date(value) : undefined;
}

function readStringRecord(value: unknown): Record<string, string> {
  const record = requireRecord(value);
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, readString(entry)]));
}

function optionalStringRecord(value: unknown): Record<string, string> | undefined {
  return value === undefined ? undefined : readStringRecord(value);
}

function readExact<T extends string>(value: unknown, expected: T): T {
  if (value !== expected) return invalidInput();
  return expected;
}

function readOneOf<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) return invalidInput();
  return value;
}

function requireRecord(value: unknown): CloudRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidResponse();
  }
  return value as CloudRecord;
}

function hasOwn(value: CloudRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidInput(): never {
  throw new Error('TENANT_DATA_BROKER_AWS_SDK_INPUT_INVALID');
}

function invalidResponse(): never {
  throw new Error('TENANT_DATA_BROKER_AWS_SDK_RESPONSE_INVALID');
}
