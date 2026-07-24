import {
  AwsS3PrivacyObjectStorage,
  type AwsS3PrivacyApi,
  type AwsS3PrivacyObjectStorageOptions,
} from './aws-s3-privacy-object-storage.js';

export async function createAwsS3PrivacyObjectStorage(options: AwsS3PrivacyObjectStorageOptions) {
  const {
    DeleteObjectCommand,
    GetObjectCommand,
    GetObjectLegalHoldCommand,
    HeadObjectCommand,
    ListObjectVersionsCommand,
    PutObjectCommand,
    PutObjectLegalHoldCommand,
    S3Client,
  } = await import('@aws-sdk/client-s3');
  const client = new S3Client({ region: options.region });
  const createRemoteEffectAbortSignal = () => AbortSignal.timeout(30_000);
  const api: AwsS3PrivacyApi = {
    async putObject(input) {
      try {
        const result = await client.send(new PutObjectCommand(input), {
          abortSignal: createRemoteEffectAbortSignal(),
        });
        return { ...(result.VersionId === undefined ? {} : { VersionId: result.VersionId }) };
      } catch (error: unknown) {
        if (!isAmbiguousAwsPut(error)) throw error;
        let existing;
        try {
          existing = await client.send(
            new HeadObjectCommand({
              Bucket: input.Bucket,
              Key: input.Key,
              ExpectedBucketOwner: input.ExpectedBucketOwner,
              ChecksumMode: 'ENABLED',
            }),
            { abortSignal: createRemoteEffectAbortSignal() },
          );
        } catch {
          // No exact version can be proven. Preserve the original ambiguous
          // result so the durable worker can retry the same operation later.
          throw error;
        }
        if (!isSameImmutablePut(input, existing)) {
          throw new Error('S3_PRIVACY_OBJECT_KEY_CONFLICT', { cause: error });
        }
        return {
          ...(existing.VersionId === undefined ? {} : { VersionId: existing.VersionId }),
        };
      }
    },
    async getObject(input) {
      const result = await client.send(new GetObjectCommand(input), {
        abortSignal: createRemoteEffectAbortSignal(),
      });
      return {
        ...(result.VersionId === undefined ? {} : { VersionId: result.VersionId }),
        ...(result.ContentType === undefined ? {} : { ContentType: result.ContentType }),
        ...(result.ContentLength === undefined ? {} : { ContentLength: result.ContentLength }),
        ...(result.ChecksumSHA256 === undefined ? {} : { ChecksumSHA256: result.ChecksumSHA256 }),
        ...(result.Metadata === undefined ? {} : { Metadata: result.Metadata }),
        ...(result.ObjectLockRetainUntilDate === undefined
          ? {}
          : { ObjectLockRetainUntilDate: result.ObjectLockRetainUntilDate }),
        ...(result.Body === undefined
          ? {}
          : { Body: { transformToByteArray: () => result.Body!.transformToByteArray() } }),
      };
    },
    async headObject(input, options) {
      const result = await client.send(new HeadObjectCommand(input), {
        abortSignal: options?.abortSignal ?? createRemoteEffectAbortSignal(),
      });
      return {
        ...(result.VersionId === undefined ? {} : { VersionId: result.VersionId }),
        ...(result.ContentType === undefined ? {} : { ContentType: result.ContentType }),
        ...(result.ContentLength === undefined ? {} : { ContentLength: result.ContentLength }),
        ...(result.ChecksumSHA256 === undefined ? {} : { ChecksumSHA256: result.ChecksumSHA256 }),
        ...(result.Metadata === undefined ? {} : { Metadata: result.Metadata }),
        ...(result.ObjectLockRetainUntilDate === undefined
          ? {}
          : { ObjectLockRetainUntilDate: result.ObjectLockRetainUntilDate }),
        ...(result.LastModified === undefined ? {} : { LastModified: result.LastModified }),
        ...(result.ServerSideEncryption === undefined
          ? {}
          : { ServerSideEncryption: result.ServerSideEncryption }),
        ...(result.SSEKMSKeyId === undefined ? {} : { SSEKMSKeyId: result.SSEKMSKeyId }),
      };
    },
    deleteObject: (input) =>
      client.send(new DeleteObjectCommand(input), {
        abortSignal: createRemoteEffectAbortSignal(),
      }),
    async getObjectLegalHold(input) {
      const result = await client.send(new GetObjectLegalHoldCommand(input), {
        abortSignal: createRemoteEffectAbortSignal(),
      });
      const status = result.LegalHold?.Status;
      return status === undefined ? {} : { LegalHold: { Status: status } };
    },
    putObjectLegalHold: (input) =>
      client.send(new PutObjectLegalHoldCommand(input), {
        abortSignal: createRemoteEffectAbortSignal(),
      }),
    async listObjectVersions(input, options) {
      const result = await client.send(new ListObjectVersionsCommand(input), {
        abortSignal: options?.abortSignal ?? createRemoteEffectAbortSignal(),
      });
      return {
        ...(result.Versions === undefined
          ? {}
          : {
              Versions: result.Versions.map((version) => ({
                ...(version.Key === undefined ? {} : { Key: version.Key }),
                ...(version.VersionId === undefined ? {} : { VersionId: version.VersionId }),
              })),
            }),
        ...(result.DeleteMarkers === undefined
          ? {}
          : {
              DeleteMarkers: result.DeleteMarkers.map((marker) => ({
                ...(marker.Key === undefined ? {} : { Key: marker.Key }),
                ...(marker.VersionId === undefined ? {} : { VersionId: marker.VersionId }),
                ...(marker.LastModified === undefined ? {} : { LastModified: marker.LastModified }),
              })),
            }),
        ...(result.IsTruncated === undefined ? {} : { IsTruncated: result.IsTruncated }),
        ...(result.NextKeyMarker === undefined ? {} : { NextKeyMarker: result.NextKeyMarker }),
        ...(result.NextVersionIdMarker === undefined
          ? {}
          : { NextVersionIdMarker: result.NextVersionIdMarker }),
      };
    },
  };
  return {
    storage: new AwsS3PrivacyObjectStorage(api, options),
    close() {
      client.destroy();
      return Promise.resolve();
    },
  };
}

function isAmbiguousAwsPut(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown } | undefined;
  };
  const status = candidate.$metadata?.httpStatusCode;
  return (
    candidate.name === 'PreconditionFailed' ||
    candidate.name === 'ConditionalRequestConflict' ||
    candidate.name === 'AbortError' ||
    candidate.name === 'TimeoutError' ||
    candidate.name === 'RequestTimeout' ||
    candidate.code === 'ETIMEDOUT' ||
    candidate.code === 'ECONNRESET' ||
    status === 408 ||
    status === 409 ||
    status === 412 ||
    (typeof status === 'number' && status >= 500)
  );
}

function isSameImmutablePut(
  expected: Parameters<AwsS3PrivacyApi['putObject']>[0],
  actual: {
    VersionId?: string | undefined;
    ContentType?: string | undefined;
    ContentLength?: number | undefined;
    ChecksumSHA256?: string | undefined;
    Metadata?: Record<string, string> | undefined;
    ServerSideEncryption?: string | undefined;
    SSEKMSKeyId?: string | undefined;
    ObjectLockMode?: string | undefined;
    ObjectLockRetainUntilDate?: Date | undefined;
  },
): boolean {
  if (
    actual.VersionId === undefined ||
    actual.ContentType !== expected.ContentType ||
    actual.ContentLength !== expected.Body.byteLength ||
    actual.Metadata?.['tenant-id'] !== expected.Metadata['tenant-id'] ||
    actual.Metadata.sha256 !== expected.Metadata.sha256 ||
    actual.ServerSideEncryption !== expected.ServerSideEncryption ||
    actual.SSEKMSKeyId !== expected.SSEKMSKeyId ||
    actual.ChecksumSHA256 !== expected.ChecksumSHA256
  ) {
    return false;
  }
  const expectedRetention = expected.ObjectLockRetainUntilDate?.getTime();
  const actualRetention = actual.ObjectLockRetainUntilDate?.getTime();
  return actual.ObjectLockMode === expected.ObjectLockMode && actualRetention === expectedRetention;
}
