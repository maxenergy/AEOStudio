import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const aws = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));

vi.mock('@aws-sdk/client-s3', () => {
  class TestCommand {
    public constructor(public readonly input: Record<string, unknown>) {}
  }
  class TestS3Client {
    public send(command: unknown, options?: unknown): unknown {
      return aws.send(command, options);
    }

    public destroy(): void {
      aws.destroy();
    }
  }
  return {
    DeleteObjectCommand: TestCommand,
    GetObjectCommand: TestCommand,
    GetObjectLegalHoldCommand: TestCommand,
    HeadObjectCommand: TestCommand,
    ListObjectVersionsCommand: TestCommand,
    PutObjectCommand: TestCommand,
    PutObjectLegalHoldCommand: TestCommand,
    S3Client: TestS3Client,
  };
});

import { createAwsS3PrivacyObjectStorage } from './aws-s3-sdk.js';

const TENANT_ID = '018f84b3-7eb8-7c75-9ca5-25278969d3f1';
const KMS_KEY_ARN =
  'arn:aws:kms:ap-southeast-1:123456789012:key/018f84b3-7eb8-7c75-9ca5-25278969d3f2';

describe('AWS S3 SDK privacy boundary', () => {
  beforeEach(() => {
    aws.send.mockReset();
    aws.destroy.mockReset();
  });

  test('adopts only the same immutable version after an ambiguous conditional put retry', async () => {
    const body = new TextEncoder().encode('{"schemaVersion":"tenant-export-bundle.v1"}');
    const checksum = createHash('sha256').update(body).digest('hex');
    aws.send
      .mockRejectedValueOnce({ name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } })
      .mockResolvedValueOnce({
        VersionId: 'existing-v1',
        ContentType: 'application/json',
        ContentLength: body.byteLength,
        ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
        Metadata: { 'tenant-id': TENANT_ID, sha256: checksum },
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: KMS_KEY_ARN,
      });
    const resource = await createResource();

    await expect(
      resource.storage.putExportVersion({
        tenantId: TENANT_ID,
        objectKey: `tenants/${TENANT_ID}/exports/export-1.bundle.json`,
        body,
        contentType: 'application/json',
        checksum,
      }),
    ).resolves.toMatchObject({ objectVersionId: 'existing-v1', checksum });

    expect(commandInput(1)).toMatchObject({ IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256' });
    expect(commandInput(2)).toMatchObject({ ChecksumMode: 'ENABLED' });
    const firstSendOptions: unknown = aws.send.mock.calls[0]?.[1];
    const secondSendOptions: unknown = aws.send.mock.calls[1]?.[1];
    expect(readAbortSignal(firstSendOptions)).toBeInstanceOf(AbortSignal);
    expect(readAbortSignal(secondSendOptions)).toBeInstanceOf(AbortSignal);
    await resource.close();
    expect(aws.destroy).toHaveBeenCalledOnce();
  });

  test('rejects an existing key whose immutable checksum does not match', async () => {
    const body = new TextEncoder().encode('{}');
    const checksum = createHash('sha256').update(body).digest('hex');
    aws.send
      .mockRejectedValueOnce({ name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } })
      .mockResolvedValueOnce({
        VersionId: 'foreign-v1',
        ContentType: 'application/json',
        ContentLength: body.byteLength,
        Metadata: { 'tenant-id': TENANT_ID, sha256: '0'.repeat(64) },
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: KMS_KEY_ARN,
      });
    const resource = await createResource();

    await expect(
      resource.storage.putExportVersion({
        tenantId: TENANT_ID,
        objectKey: `tenants/${TENANT_ID}/exports/export-2.bundle.json`,
        body,
        contentType: 'application/json',
        checksum,
      }),
    ).rejects.toThrow('S3_PRIVACY_OBJECT_KEY_CONFLICT');
    await resource.close();
  });

  test('fails closed when HEAD omits ChecksumSHA256 even if metadata matches', async () => {
    const body = new TextEncoder().encode('{"stable":true}');
    const checksum = createHash('sha256').update(body).digest('hex');
    aws.send
      .mockRejectedValueOnce({ name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } })
      .mockResolvedValueOnce({
        VersionId: 'unverifiable-v1',
        ContentType: 'application/json',
        ContentLength: body.byteLength,
        Metadata: { 'tenant-id': TENANT_ID, sha256: checksum },
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: KMS_KEY_ARN,
      });
    const resource = await createResource();

    await expect(
      resource.storage.putExportVersion({
        tenantId: TENANT_ID,
        objectKey: `tenants/${TENANT_ID}/exports/export-no-checksum.bundle.json`,
        body,
        contentType: 'application/json',
        checksum,
      }),
    ).rejects.toThrow('S3_PRIVACY_OBJECT_KEY_CONFLICT');
    await resource.close();
  });

  test('HEAD-adopts an exact immutable version after S3 409 ambiguity', async () => {
    const body = new TextEncoder().encode('{"operation":"stable"}');
    const checksum = createHash('sha256').update(body).digest('hex');
    aws.send
      .mockRejectedValueOnce({
        name: 'ConditionalRequestConflict',
        $metadata: { httpStatusCode: 409 },
      })
      .mockResolvedValueOnce({
        VersionId: 'concurrent-v1',
        ContentType: 'application/json',
        ContentLength: body.byteLength,
        ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
        Metadata: { 'tenant-id': TENANT_ID, sha256: checksum },
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: KMS_KEY_ARN,
      });
    const resource = await createResource();

    await expect(
      resource.storage.putExportVersion({
        tenantId: TENANT_ID,
        objectKey: `tenants/${TENANT_ID}/exports/export-409.bundle.json`,
        body,
        contentType: 'application/json',
        checksum,
      }),
    ).resolves.toMatchObject({ objectVersionId: 'concurrent-v1', checksum });
    expect(commandInput(2)).toMatchObject({ ChecksumMode: 'ENABLED' });
    await resource.close();
  });

  test.each([
    ['timeout', { name: 'TimeoutError' }],
    ['5xx', { name: 'InternalError', $metadata: { httpStatusCode: 503 } }],
  ])('HEAD-adopts an exact immutable version after %s ambiguity', async (_label, failure) => {
    const body = new TextEncoder().encode('{"ambiguous":true}');
    const checksum = createHash('sha256').update(body).digest('hex');
    aws.send.mockRejectedValueOnce(failure).mockResolvedValueOnce({
      VersionId: 'ambiguous-v1',
      ContentType: 'application/json',
      ContentLength: body.byteLength,
      ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
      Metadata: { 'tenant-id': TENANT_ID, sha256: checksum },
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: KMS_KEY_ARN,
    });
    const resource = await createResource();

    await expect(
      resource.storage.putExportVersion({
        tenantId: TENANT_ID,
        objectKey: `tenants/${TENANT_ID}/exports/export-${_label}.bundle.json`,
        body,
        contentType: 'application/json',
        checksum,
      }),
    ).resolves.toMatchObject({ objectVersionId: 'ambiguous-v1', checksum });
    await resource.close();
  });

  test('executes ListObjectVersions with the Tenant audit prefix', async () => {
    aws.send.mockResolvedValueOnce({
      Versions: [
        {
          Key: `tenants/${TENANT_ID}/audit-digests/digest.json`,
          VersionId: 'audit-v1',
        },
      ],
      IsTruncated: false,
    });
    const resource = await createResource();

    await expect(
      resource.storage.listPrivacyObjectVersions({
        tenantId: TENANT_ID,
        bucket: 'AUDIT_EVIDENCE',
        cursor: null,
        limit: 100,
      }),
    ).resolves.toEqual({
      versions: [
        {
          objectKey: `tenants/${TENANT_ID}/audit-digests/digest.json`,
          objectVersionId: 'audit-v1',
        },
      ],
      nextCursor: null,
    });
    expect(commandInput(1)).toMatchObject({
      Bucket: 'aeostudio-staging-123456789012-audit',
      Prefix: `tenants/${TENANT_ID}/audit-digests/`,
      MaxKeys: 100,
    });
    await resource.close();
  });
});

function createResource() {
  return createAwsS3PrivacyObjectStorage({
    region: 'ap-southeast-1',
    accountId: '123456789012',
    exportBucket: 'aeostudio-staging-123456789012-artifacts',
    auditBucket: 'aeostudio-staging-123456789012-audit',
    kmsKeyArn: KMS_KEY_ARN,
    clock: { now: () => new Date('2026-07-22T00:00:00.000Z') },
  });
}

function commandInput(call: number): Record<string, unknown> {
  const command = aws.send.mock.calls[call - 1]?.[0] as { input?: Record<string, unknown> };
  return command.input ?? {};
}

function readAbortSignal(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('abortSignal' in value)) return null;
  return value.abortSignal;
}
