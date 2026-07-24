import type { ArtifactPayload } from '@aeostudio/domain/artifacts';
import type { ChannelPackagePayload } from '@aeostudio/domain/channels-publishing';
import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import {
  AwsS3WorkloadObjectStorage,
  type AwsS3WorkloadApi,
} from './aws-s3-workload-object-storage.js';

const payload: ArtifactPayload = {
  title: 'Artifact title',
  summary: 'Evidence-backed summary',
  sections: [{ heading: 'Evidence', body: 'Evidence-backed body.' }],
  claimMap: [
    {
      claimRevisionId: '00000000-0000-7000-8000-000000000901',
      statement: 'Approved statement.',
      evidenceSourceIds: ['00000000-0000-7000-8000-000000000902'],
    },
  ],
  disclosure: 'Method disclosure.',
};

describe('AWS S3 workload object storage', () => {
  test('adopts only an exact existing workload version without replaying payload bytes', async () => {
    const tenantId = '00000000-0000-7000-8000-000000000903';
    const workspaceId = '00000000-0000-7000-8000-000000000904';
    const checksum = 'c'.repeat(64);
    const objectKey = `tenants/${tenantId}/workspaces/${workspaceId}/channel-packages/${checksum}.json`;
    const headObject = vi.fn(() =>
      Promise.resolve({
        VersionId: 'recovered-v1',
        ContentType: 'application/json',
        ContentLength: 128,
        ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
        Metadata: { 'tenant-id': tenantId, 'workspace-id': workspaceId, sha256: checksum },
        LastModified: new Date('2026-07-22T12:00:00.000Z'),
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId:
          'arn:aws:kms:ap-southeast-1:123456789012:key/12345678-1234-4234-8234-123456789012',
      }),
    );
    const putObject = vi.fn();
    const storage = new AwsS3WorkloadObjectStorage(
      { putObject, getObject: vi.fn(), headObject },
      {
        region: 'ap-southeast-1',
        accountId: '123456789012',
        bucket: 'aeostudio-staging-artifacts',
        kmsKeyArn:
          'arn:aws:kms:ap-southeast-1:123456789012:key/12345678-1234-4234-8234-123456789012',
      },
    );

    await expect(
      storage.recoverWorkloadVersion({
        kind: 'CHANNEL_PACKAGE',
        tenantId,
        workspaceId,
        objectKey,
        checksum,
        contentType: 'application/json',
        byteLength: 128,
      }),
    ).resolves.toMatchObject({
      objectVersionId: 'recovered-v1',
      objectKey,
      checksum,
      createdAt: '2026-07-22T12:00:00.000Z',
    });
    expect(headObject).toHaveBeenCalledWith({
      Bucket: 'aeostudio-staging-artifacts',
      Key: objectKey,
      ExpectedBucketOwner: '123456789012',
      ChecksumMode: 'ENABLED',
    });
    expect(putObject).not.toHaveBeenCalled();
  });

  test('round-trips an exact-version Artifact payload under its Tenant and Workspace scope', async () => {
    let body = new Uint8Array();
    let putKey = '';
    let metadata: Record<string, string> = {};
    const putObject = vi.fn((input: Parameters<AwsS3WorkloadApi['putObject']>[0]) => {
      body = input.Body.slice();
      putKey = input.Key;
      metadata = { ...input.Metadata };
      return Promise.resolve({ VersionId: 'artifact-version-1' });
    });
    const api: AwsS3WorkloadApi = {
      putObject,
      headObject: vi.fn(),
      getObject: (input) =>
        Promise.resolve({
          VersionId: input.VersionId,
          ContentType: 'application/json',
          ContentLength: body.byteLength,
          Metadata: metadata,
          Body: body,
        }),
    };
    const storage = new AwsS3WorkloadObjectStorage(api, {
      region: 'ap-southeast-1',
      accountId: '123456789012',
      bucket: 'aeostudio-staging-artifacts',
      kmsKeyArn: 'arn:aws:kms:ap-southeast-1:123456789012:key/12345678-1234-4234-8234-123456789012',
    });

    const stored = await storage.put({
      tenantId: '00000000-0000-7000-8000-000000000903',
      workspaceId: '00000000-0000-7000-8000-000000000904',
      artifactId: '00000000-0000-7000-8000-000000000905',
      revision: 1,
      contentHash: 'a'.repeat(64),
      payload,
    });

    expect(putKey).toBe(
      'tenants/00000000-0000-7000-8000-000000000903/workspaces/' +
        '00000000-0000-7000-8000-000000000904/artifacts/' +
        '00000000-0000-7000-8000-000000000905/revisions/1/' +
        `${'a'.repeat(64)}.json`,
    );
    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'aeostudio-staging-artifacts',
        ServerSideEncryption: 'aws:kms',
        ExpectedBucketOwner: '123456789012',
        Tagging:
          'TenantId=00000000-0000-7000-8000-000000000903&' +
          'WorkspaceId=00000000-0000-7000-8000-000000000904',
      }),
    );
    await expect(storage.get(stored.objectRef)).resolves.toEqual(payload);
    await expect(
      storage.get(stored.objectRef.replace('aeostudio-staging-artifacts', 'foreign-bucket')),
    ).rejects.toThrow('S3_WORKLOAD_OBJECT_SCOPE_MISMATCH');
  });

  test('round-trips a channel adaptation package for audit-then-publish across processes', async () => {
    let body = new Uint8Array();
    let metadata: Record<string, string> = {};
    const api: AwsS3WorkloadApi = {
      putObject: (input) => {
        body = input.Body.slice();
        metadata = { ...input.Metadata };
        return Promise.resolve({ VersionId: 'channel-package-version-1' });
      },
      headObject: vi.fn(),
      getObject: (input) =>
        Promise.resolve({
          VersionId: input.VersionId,
          ContentType: 'application/json',
          ContentLength: body.byteLength,
          Metadata: metadata,
          Body: body,
        }),
    };
    const storage = new AwsS3WorkloadObjectStorage(api, {
      region: 'ap-southeast-1',
      accountId: '123456789012',
      bucket: 'aeostudio-staging-artifacts',
      kmsKeyArn: 'arn:aws:kms:ap-southeast-1:123456789012:key/12345678-1234-4234-8234-123456789012',
    });
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Reviewed package',
        'content.html': '<h1>Reviewed package</h1>',
        'structured-data.json': '{"headline":"Reviewed package","abstract":"Evidence"}',
      },
    };

    const stored = await storage.putChannelPackage({
      tenantId: '00000000-0000-7000-8000-000000000903',
      workspaceId: '00000000-0000-7000-8000-000000000904',
      packageChecksum: 'b'.repeat(64),
      payload,
    });

    expect(stored.objectRef).toContain('/channel-packages/');
    await expect(storage.getChannelPackage(stored.objectRef)).resolves.toEqual(payload);
  });

  test('stores crawl bytes only under a content-addressed Tenant and Workspace key', async () => {
    const body = new TextEncoder().encode('User-agent: *\nAllow: /');
    const checksum = createHash('sha256').update(body).digest('hex');
    const putObject = vi.fn(() => Promise.resolve({ VersionId: 'crawl-version-1' }));
    const storage = new AwsS3WorkloadObjectStorage(
      {
        putObject,
        headObject: vi.fn(),
        getObject: () => Promise.reject(new Error('not used')),
      },
      {
        region: 'ap-southeast-1',
        accountId: '123456789012',
        bucket: 'aeostudio-staging-artifacts',
        kmsKeyArn:
          'arn:aws:kms:ap-southeast-1:123456789012:key/12345678-1234-4234-8234-123456789012',
      },
    );
    const key =
      'tenants/00000000-0000-7000-8000-000000000903/workspaces/' +
      '00000000-0000-7000-8000-000000000904/sites/' +
      `00000000-0000-7000-8000-000000000905/snapshots/${checksum}`;

    await expect(
      storage.putObject({ key, body, contentType: 'text/plain', checksum }),
    ).resolves.toEqual({
      objectRef: `s3://aeostudio-staging-artifacts/${key}?` + 'versionId=crawl-version-1',
    });
    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: key,
        Tagging:
          'TenantId=00000000-0000-7000-8000-000000000903&' +
          'WorkspaceId=00000000-0000-7000-8000-000000000904',
      }),
    );
    await expect(
      storage.putObject({ key, body: new Uint8Array([1]), contentType: 'text/plain', checksum }),
    ).rejects.toThrow('S3_WORKLOAD_OBJECT_CHECKSUM_MISMATCH');
  });
});
