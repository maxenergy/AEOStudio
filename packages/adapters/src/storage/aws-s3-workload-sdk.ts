import {
  AwsS3WorkloadObjectStorage,
  type AwsS3WorkloadApi,
  type AwsS3WorkloadObjectStorageOptions,
} from './aws-s3-workload-object-storage.js';

export async function createAwsS3WorkloadObjectStorage(options: AwsS3WorkloadObjectStorageOptions) {
  const { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } =
    await import('@aws-sdk/client-s3');
  const client = new S3Client({ region: options.region });
  const remoteEffectAbortSignal = () => AbortSignal.timeout(30_000);
  const api: AwsS3WorkloadApi = {
    async putObject(input) {
      try {
        const result = await client.send(new PutObjectCommand(input), {
          abortSignal: remoteEffectAbortSignal(),
        });
        return result.VersionId === undefined ? {} : { VersionId: result.VersionId };
      } catch (error: unknown) {
        if (!isAmbiguousAwsPut(error)) throw error;
        const existing = await client.send(
          new HeadObjectCommand({
            Bucket: input.Bucket,
            Key: input.Key,
            ExpectedBucketOwner: input.ExpectedBucketOwner,
            ChecksumMode: 'ENABLED',
          }),
          { abortSignal: remoteEffectAbortSignal() },
        );
        if (!isSameImmutableWorkloadPut(input, existing)) {
          throw new Error('S3_WORKLOAD_OBJECT_KEY_CONFLICT', { cause: error });
        }
        return existing.VersionId === undefined ? {} : { VersionId: existing.VersionId };
      }
    },
    async getObject(input) {
      const result = await client.send(new GetObjectCommand(input), {
        abortSignal: remoteEffectAbortSignal(),
      });
      return {
        ...(result.VersionId === undefined ? {} : { VersionId: result.VersionId }),
        ...(result.ContentType === undefined ? {} : { ContentType: result.ContentType }),
        ...(result.ContentLength === undefined ? {} : { ContentLength: result.ContentLength }),
        ...(result.ChecksumSHA256 === undefined ? {} : { ChecksumSHA256: result.ChecksumSHA256 }),
        ...(result.Metadata === undefined ? {} : { Metadata: result.Metadata }),
        ...(result.Body === undefined
          ? {}
          : { Body: { transformToByteArray: () => result.Body!.transformToByteArray() } }),
      };
    },
    async headObject(input) {
      const result = await client.send(new HeadObjectCommand(input), {
        abortSignal: remoteEffectAbortSignal(),
      });
      return {
        ...(result.VersionId === undefined ? {} : { VersionId: result.VersionId }),
        ...(result.ContentType === undefined ? {} : { ContentType: result.ContentType }),
        ...(result.ContentLength === undefined ? {} : { ContentLength: result.ContentLength }),
        ...(result.ChecksumSHA256 === undefined ? {} : { ChecksumSHA256: result.ChecksumSHA256 }),
        ...(result.Metadata === undefined ? {} : { Metadata: result.Metadata }),
        ...(result.LastModified === undefined ? {} : { LastModified: result.LastModified }),
        ...(result.ServerSideEncryption === undefined
          ? {}
          : { ServerSideEncryption: result.ServerSideEncryption }),
        ...(result.SSEKMSKeyId === undefined ? {} : { SSEKMSKeyId: result.SSEKMSKeyId }),
      };
    },
  };
  const storage = new AwsS3WorkloadObjectStorage(api, options);
  return {
    storage,
    artifacts: storage,
    channelPackages: storage.channelPackages(),
    crawls: storage,
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
    $metadata?: { httpStatusCode?: unknown } | undefined;
  };
  const status = candidate.$metadata?.httpStatusCode;
  return (
    candidate.name === 'PreconditionFailed' ||
    candidate.name === 'ConditionalRequestConflict' ||
    candidate.name === 'TimeoutError' ||
    candidate.name === 'RequestTimeout' ||
    candidate.name === 'RequestTimeoutException' ||
    status === 409 ||
    status === 412 ||
    (typeof status === 'number' && status >= 500 && status <= 599)
  );
}

function isSameImmutableWorkloadPut(
  expected: Parameters<AwsS3WorkloadApi['putObject']>[0],
  actual: {
    VersionId?: string | undefined;
    ContentType?: string | undefined;
    ContentLength?: number | undefined;
    ChecksumSHA256?: string | undefined;
    Metadata?: Record<string, string> | undefined;
    ServerSideEncryption?: string | undefined;
    SSEKMSKeyId?: string | undefined;
  },
): boolean {
  const metadata = actual.Metadata;
  return (
    actual.VersionId !== undefined &&
    actual.ContentType === expected.ContentType &&
    actual.ContentLength === expected.Body.byteLength &&
    actual.ChecksumSHA256 === expected.ChecksumSHA256 &&
    metadata?.['tenant-id'] === expected.Metadata['tenant-id'] &&
    metadata?.['workspace-id'] === expected.Metadata['workspace-id'] &&
    metadata?.sha256 === expected.Metadata.sha256 &&
    Object.keys(metadata).length === 3 &&
    actual.ServerSideEncryption === expected.ServerSideEncryption &&
    actual.SSEKMSKeyId === expected.SSEKMSKeyId
  );
}
