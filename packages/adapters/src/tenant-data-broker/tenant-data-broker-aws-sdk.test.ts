import { Readable } from 'node:stream';

import { describe, expect, test, vi } from 'vitest';

import { createAwsTenantDataBrokerExecutor } from './tenant-data-broker-aws-executor.js';
import { createAwsTenantDataBrokerCloudResource } from './tenant-data-broker-aws-sdk.js';

describe('AWS Tenant Data Broker normalized cloud ports', () => {
  test('maps streaming S3 operations to exact AWS SDK commands without materializing bodies', async () => {
    const requestBody = singlePassBody([new Uint8Array([1, 2, 3])]);
    const responseBody = Readable.from([new Uint8Array([4, 5, 6])]);
    const calls: Array<{ name: string; input: Record<string, unknown>; signal: AbortSignal }> = [];
    const s3Client = {
      send: vi.fn(
        (command: { input: Record<string, unknown> }, options: { abortSignal: AbortSignal }) => {
          const name = command.constructor.name;
          calls.push({ name, input: command.input, signal: options.abortSignal });
          if (name === 'PutObjectCommand') return Promise.resolve({ VersionId: 'version-put' });
          if (name === 'GetObjectCommand') {
            return Promise.resolve({
              Body: responseBody,
              VersionId: 'version-get',
              Metadata: { 'aeostudio-direct-sha256': 'a'.repeat(64) },
              ContentType: 'application/json',
              ContentLength: 3,
              ChecksumSHA256: 'transport-checksum',
            });
          }
          if (name === 'ListObjectVersionsCommand') {
            return Promise.resolve({
              Versions: [
                {
                  Key: 'tenants/t1/object.json',
                  VersionId: 'version-list',
                  LastModified: new Date('2026-07-23T18:40:00.000Z'),
                },
              ],
              DeleteMarkers: [],
              IsTruncated: true,
              NextKeyMarker: 'tenants/t1/object.json',
              NextVersionIdMarker: 'version-list',
            });
          }
          throw new Error(`UNEXPECTED_S3_COMMAND:${name}`);
        },
      ),
      destroy: vi.fn(),
    };
    const secretsClient = { send: vi.fn(), destroy: vi.fn() };
    const resource = createAwsTenantDataBrokerCloudResource({
      region: 'ap-southeast-1',
      s3Client,
      secretsClient,
    });
    const signal = AbortSignal.timeout(5_000);

    await expect(
      resource.s3.putObject(
        {
          bucket: 'aeostudio-staging-artifacts',
          key: 'tenants/t1/object.json',
          expectedBucketOwner: '123456789012',
          body: requestBody,
          bucketKeyEnabled: true,
          checksumSha256: 'base64-checksum',
          contentLength: 3,
          contentType: 'application/json',
          ifNoneMatch: '*',
          metadata: { 'aeostudio-direct-sha256': 'a'.repeat(64) },
          serverSideEncryption: 'aws:kms',
          sseKmsKeyId:
            'arn:aws:kms:ap-southeast-1:123456789012:key/11111111-1111-4111-8111-111111111111',
        },
        signal,
      ),
    ).resolves.toEqual({ versionId: 'version-put' });
    const put = calls[0]!;
    expect(put.name).toBe('PutObjectCommand');
    expect(put.signal).toBe(signal);
    expect(put.input).toMatchObject({
      Bucket: 'aeostudio-staging-artifacts',
      Key: 'tenants/t1/object.json',
      ExpectedBucketOwner: '123456789012',
      BucketKeyEnabled: true,
      ChecksumSHA256: 'base64-checksum',
      ContentLength: 3,
      IfNoneMatch: '*',
    });
    expect(put.input.Body).toBeInstanceOf(Readable);
    await expect(consumeBody(put.input.Body as AsyncIterable<Uint8Array>)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );

    const get = await resource.s3.getObject(
      {
        bucket: 'aeostudio-staging-artifacts',
        key: 'tenants/t1/object.json',
        versionId: 'version-get',
        expectedBucketOwner: '123456789012',
        checksumMode: 'ENABLED',
      },
      signal,
    );
    expect(get).toMatchObject({
      body: responseBody,
      versionId: 'version-get',
      contentType: 'application/json',
      byteLength: 3,
      checksumSha256: 'transport-checksum',
    });
    expect(calls[1]?.input).toEqual({
      Bucket: 'aeostudio-staging-artifacts',
      Key: 'tenants/t1/object.json',
      VersionId: 'version-get',
      ExpectedBucketOwner: '123456789012',
      ChecksumMode: 'ENABLED',
    });

    await expect(
      resource.s3.listObjectVersions(
        {
          bucket: 'aeostudio-staging-artifacts',
          expectedBucketOwner: '123456789012',
          prefix: 'tenants/t1/',
          maxKeys: 1000,
        },
        signal,
      ),
    ).resolves.toEqual({
      versions: [
        {
          key: 'tenants/t1/object.json',
          versionId: 'version-list',
          lastModified: new Date('2026-07-23T18:40:00.000Z'),
        },
      ],
      deleteMarkers: [],
      isTruncated: true,
      nextKeyMarker: 'tenants/t1/object.json',
      nextVersionIdMarker: 'version-list',
    });
  });

  test('maps Secrets Manager calls and closes both SDK clients exactly once', async () => {
    const s3Client = { send: vi.fn(), destroy: vi.fn() };
    const calls: Array<{ name: string; input: Record<string, unknown>; signal: AbortSignal }> = [];
    const secretsClient = {
      send: vi.fn(
        (command: { input: Record<string, unknown> }, options: { abortSignal: AbortSignal }) => {
          const name = command.constructor.name;
          calls.push({ name, input: command.input, signal: options.abortSignal });
          if (name === 'GetSecretValueCommand') {
            return Promise.resolve({ SecretString: 'fixture-secret' });
          }
          if (name === 'DescribeSecretCommand') {
            return Promise.resolve({ DeletedDate: new Date('2026-07-23T18:40:00.000Z') });
          }
          if (name === 'DeleteSecretCommand') {
            return Promise.resolve({ ARN: 'arn:fixture' });
          }
          throw new Error(`UNEXPECTED_SECRETS_COMMAND:${name}`);
        },
      ),
      destroy: vi.fn(),
    };
    const resource = createAwsTenantDataBrokerCloudResource({
      region: 'ap-southeast-1',
      s3Client,
      secretsClient,
    });
    const signal = AbortSignal.timeout(5_000);

    await expect(
      resource.secrets.getSecretValue({ secretId: 'arn:fixture' }, signal),
    ).resolves.toEqual({ secretString: 'fixture-secret' });
    await expect(
      resource.secrets.describeSecret({ secretId: 'arn:fixture' }, signal),
    ).resolves.toEqual({
      exists: true,
      deletedAt: '2026-07-23T18:40:00.000Z',
    });
    await expect(
      resource.secrets.deleteSecret(
        { secretId: 'arn:fixture', forceDeleteWithoutRecovery: true },
        signal,
      ),
    ).resolves.toEqual({ deleted: true });
    expect(calls.map((call) => [call.name, call.input])).toEqual([
      ['GetSecretValueCommand', { SecretId: 'arn:fixture' }],
      ['DescribeSecretCommand', { SecretId: 'arn:fixture' }],
      ['DeleteSecretCommand', { SecretId: 'arn:fixture', ForceDeleteWithoutRecovery: true }],
    ]);

    resource.close();
    resource.close();
    expect(s3Client.destroy).toHaveBeenCalledTimes(1);
    expect(secretsClient.destroy).toHaveBeenCalledTimes(1);
  });

  test('normalizes a missing secret through both the SDK port and composed executor', async () => {
    const notFound = Object.assign(new Error('secret is absent'), {
      name: 'ResourceNotFoundException',
      $metadata: { httpStatusCode: 400 },
    });
    const s3Client = { send: vi.fn(), destroy: vi.fn() };
    const secretsClient = {
      send: vi.fn().mockRejectedValue(notFound),
      destroy: vi.fn(),
    };
    const resource = createAwsTenantDataBrokerCloudResource({
      region: 'ap-southeast-1',
      s3Client,
      secretsClient,
    });
    const signal = AbortSignal.timeout(5_000);
    const deadline = new Date(Date.now() + 5_000);
    const secretArn =
      'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:' +
      'tenant-018f3b76-1000-7000-8000-000000000003/' +
      'workspace-018f3b76-1000-7000-8000-000000000004/connector';

    await expect(resource.secrets.describeSecret({ secretId: secretArn }, signal)).resolves.toEqual(
      {
        exists: false,
      },
    );

    const executor = createAwsTenantDataBrokerExecutor({
      artifactBucket: 'aeostudio-staging-artifacts',
      auditEvidenceBucket: 'aeostudio-staging-audit-evidence',
      expectedBucketOwner: '123456789012',
      kmsKeyArn: 'arn:aws:kms:ap-southeast-1:123456789012:key/11111111-1111-4111-8111-111111111111',
      multipartPartBytes: 5 * 1_024 * 1_024,
      s3: resource.s3,
      secrets: resource.secrets,
    });
    await expect(
      executor.execute({
        grant: {
          capabilityId: '018f3b76-1000-7000-8000-000000000031',
          authorityKind: 'CONNECTOR_DELETION_INTENT',
          authorityReference: '018f3b76-1000-7000-8000-000000000032',
          scopeKind: 'WORKSPACE',
          tenantId: '018f3b76-1000-7000-8000-000000000003',
          workspaceId: '018f3b76-1000-7000-8000-000000000004',
          operation: 'DESCRIBE_CONNECTOR_SECRET',
          resource: { kind: 'CONNECTOR_SECRET', secretArn },
          expiresAt: deadline.toISOString(),
        },
        body: singlePassBody([]),
        signal,
        deadline,
      }),
    ).resolves.toEqual({ kind: 'SECRET_DESCRIPTION', exists: false });
  });

  test('normalizes only trustworthy S3 HEAD 404s through the composed executor', async () => {
    const tenantId = '018f3b76-1000-7000-8000-000000000003';
    const workspaceId = '018f3b76-1000-7000-8000-000000000004';
    const prefix = `tenants/${tenantId}/workspaces/${workspaceId}/artifacts`;
    const s3Client = {
      send: vi.fn((command: { input: Record<string, unknown> }) => {
        const key = command.input.Key;
        if (command.constructor.name !== 'HeadObjectCommand' || typeof key !== 'string') {
          return Promise.reject(new Error('UNEXPECTED_S3_COMMAND'));
        }
        if (key.endsWith('/missing-versioned.json')) {
          return Promise.reject(
            Object.assign(new Error('version is absent'), {
              name: 'NotFound',
              $metadata: { httpStatusCode: 404 },
            }),
          );
        }
        if (key.endsWith('/missing-unversioned.json')) {
          return Promise.reject(
            Object.assign(new Error('key is absent'), {
              code: 'NoSuchKey',
              $metadata: { httpStatusCode: 404 },
            }),
          );
        }
        if (key.endsWith('/forbidden.json')) {
          return Promise.reject(
            Object.assign(new Error('access denied'), {
              name: 'AccessDenied',
              $metadata: { httpStatusCode: 403 },
            }),
          );
        }
        if (key.endsWith('/misleading-not-found.json')) {
          return Promise.reject(
            Object.assign(new Error('not found name with a forbidden status'), {
              name: 'NotFound',
              $metadata: { httpStatusCode: 403 },
            }),
          );
        }
        return Promise.reject(
          Object.assign(new Error('service unavailable'), {
            name: 'InternalError',
            $metadata: { httpStatusCode: 500 },
          }),
        );
      }),
      destroy: vi.fn(),
    };
    const resource = createAwsTenantDataBrokerCloudResource({
      region: 'ap-southeast-1',
      s3Client,
      secretsClient: { send: vi.fn(), destroy: vi.fn() },
    });
    const executor = createAwsTenantDataBrokerExecutor({
      artifactBucket: 'aeostudio-staging-artifacts',
      auditEvidenceBucket: 'aeostudio-staging-audit-evidence',
      expectedBucketOwner: '123456789012',
      kmsKeyArn: 'arn:aws:kms:ap-southeast-1:123456789012:key/11111111-1111-4111-8111-111111111111',
      multipartPartBytes: 5 * 1_024 * 1_024,
      s3: resource.s3,
      secrets: resource.secrets,
    });
    const signal = AbortSignal.timeout(5_000);
    const deadline = new Date(Date.now() + 5_000);
    const checksum = 'a'.repeat(64);
    const baseGrant = {
      capabilityId: '018f3b76-1000-7000-8000-000000000031',
      authorityKind: 'WORKLOAD_WRITE_INTENT',
      authorityReference: '018f3b76-1000-7000-8000-000000000032',
      scopeKind: 'WORKSPACE',
      tenantId,
      workspaceId,
      operation: 'HEAD_WORKLOAD_OBJECT',
      expiresAt: deadline.toISOString(),
    } as const;
    const versionedKey = `${prefix}/missing-versioned.json`;
    const unversionedKey = `${prefix}/missing-unversioned.json`;

    await expect(
      executor.execute({
        grant: {
          ...baseGrant,
          authorityKind: 'DELETION_OBJECT_INTENT',
          resource: {
            kind: 'OBJECT_VERSION',
            objectClass: 'WORKLOAD_OBJECTS',
            bucket: 'aeostudio-staging-artifacts',
            key: versionedKey,
            versionId: 'missing-version-1',
            checksumSha256: checksum,
            contentType: 'application/json',
            byteLength: 128,
          },
        },
        body: singlePassBody([]),
        signal,
        deadline,
      }),
    ).resolves.toEqual({
      kind: 'OBJECT_HEAD',
      exists: false,
      bucket: 'aeostudio-staging-artifacts',
      key: versionedKey,
      versionId: 'missing-version-1',
    });
    await expect(
      executor.execute({
        grant: {
          ...baseGrant,
          capabilityId: '018f3b76-1000-7000-8000-000000000033',
          authorityReference: '018f3b76-1000-7000-8000-000000000034',
          resource: {
            kind: 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD',
            objectClass: 'WORKLOAD_OBJECTS',
            bucket: 'aeostudio-staging-artifacts',
            key: unversionedKey,
            expectedChecksumSha256: checksum,
            expectedContentType: 'application/json',
            expectedByteLength: 128,
            lockedUntil: null,
            sealedAt: null,
          },
        },
        body: singlePassBody([]),
        signal,
        deadline,
      }),
    ).resolves.toEqual({
      kind: 'OBJECT_HEAD',
      exists: false,
      bucket: 'aeostudio-staging-artifacts',
      key: unversionedKey,
    });

    for (const key of [
      `${prefix}/forbidden.json`,
      `${prefix}/misleading-not-found.json`,
      `${prefix}/unavailable.json`,
    ]) {
      await expect(
        resource.s3.headObject(
          {
            bucket: 'aeostudio-staging-artifacts',
            key,
            expectedBucketOwner: '123456789012',
            checksumMode: 'ENABLED',
          },
          signal,
        ),
      ).rejects.toThrow();
    }
  });

  test('fails closed outside Singapore before constructing any client', () => {
    expect(() =>
      createAwsTenantDataBrokerCloudResource({
        region: 'us-east-1',
        s3Client: { send: vi.fn(), destroy: vi.fn() },
        secretsClient: { send: vi.fn(), destroy: vi.fn() },
      }),
    ).toThrow('AWS_SINGAPORE_REGION_REQUIRED');
  });
});

function singlePassBody(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  let consumed = false;
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      if (consumed) throw new Error('BODY_REUSED');
      consumed = true;
      for (const chunk of chunks) yield chunk;
    },
  };
}

async function consumeBody(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
