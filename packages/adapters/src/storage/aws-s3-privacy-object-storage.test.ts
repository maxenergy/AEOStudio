import { createHash } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import { AwsS3PrivacyObjectStorage } from './aws-s3-privacy-object-storage.js';

const TENANT_ID = '018f84b3-7eb8-7c75-9ca5-25278969d3f1';
const WORKSPACE_ID = '018f84b3-7eb8-7c75-9ca5-25278969d3f3';
const EXPORT_BUCKET = 'aeostudio-staging-123456789012-artifacts';
const AUDIT_BUCKET = 'aeostudio-staging-123456789012-audit';
const KMS_KEY_ARN =
  'arn:aws:kms:ap-southeast-1:123456789012:key/018f84b3-7eb8-7c75-9ca5-25278969d3f2';

describe('AWS S3 privacy object storage', () => {
  test('writes an exact versioned tenant export with KMS and a verified checksum', async () => {
    const api = s3Api({ putObject: vi.fn().mockResolvedValue({ VersionId: 'export-v1' }) });
    const storage = createStorage(api);
    const body = bytes('{"schemaVersion":"tenant-export-bundle.v1"}');
    const checksum = sha256(body);

    await expect(
      storage.putExportVersion({
        tenantId: TENANT_ID,
        objectKey: `tenants/${TENANT_ID}/exports/export-1.bundle.json`,
        body,
        contentType: 'application/json',
        checksum,
      }),
    ).resolves.toMatchObject({
      tenantId: TENANT_ID,
      objectVersionId: 'export-v1',
      checksum,
      lockedUntil: null,
    });
    expect(api.putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: EXPORT_BUCKET,
        Key: `tenants/${TENANT_ID}/exports/export-1.bundle.json`,
        Body: body,
        ContentType: 'application/json',
        IfNoneMatch: '*',
        ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: KMS_KEY_ARN,
        Tagging: `TenantId=${TENANT_ID}`,
        Metadata: { 'tenant-id': TENANT_ID, sha256: checksum },
      }),
    );
  });

  test('writes audit evidence with exact Object Lock retention and legal-holds only its version', async () => {
    const api = s3Api({
      putObject: vi.fn().mockResolvedValue({ VersionId: 'audit-v1' }),
      putObjectLegalHold: vi.fn().mockResolvedValue({}),
    });
    const storage = createStorage(api);
    const body = bytes('{"schemaVersion":"audit-digest.v1"}');
    const lockedUntil = new Date('2027-07-22T00:00:00.000Z');
    const key = `tenants/${TENANT_ID}/audit-digests/digest-1.json`;

    await storage.putLockedAuditVersion({
      tenantId: TENANT_ID,
      objectKey: key,
      body,
      contentType: 'application/json',
      checksum: sha256(body),
      lockedUntil,
    });
    await expect(
      storage.holdAuditVersion({
        tenantId: TENANT_ID,
        objectKey: key,
        objectVersionId: 'audit-v1',
        holdId: 'named-hold',
      }),
    ).resolves.toBe(true);

    expect(api.putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: AUDIT_BUCKET,
        ObjectLockMode: 'GOVERNANCE',
        ObjectLockRetainUntilDate: lockedUntil,
      }),
    );
    expect(api.putObjectLegalHold).toHaveBeenCalledWith({
      Bucket: AUDIT_BUCKET,
      Key: key,
      VersionId: 'audit-v1',
      LegalHold: { Status: 'ON' },
      ExpectedBucketOwner: '123456789012',
    });
  });

  test('fails closed on cross-tenant keys before contacting S3', async () => {
    const api = s3Api();
    const storage = createStorage(api);

    await expect(
      storage.putExportVersion({
        tenantId: TENANT_ID,
        objectKey: 'tenants/018f84b3-7eb8-7c75-9ca5-25278969d399/exports/leak.json',
        body: bytes('leak'),
        contentType: 'application/json',
        checksum: sha256(bytes('leak')),
      }),
    ).rejects.toThrow('S3_PRIVACY_OBJECT_TENANT_SCOPE_MISMATCH');
    expect(api.putObject).not.toHaveBeenCalled();
  });

  test('paginates ListObjectVersions within the exact Tenant export prefix', async () => {
    const prefix = `tenants/${TENANT_ID}/exports/`;
    const api = s3Api({
      listObjectVersions: vi
        .fn()
        .mockResolvedValueOnce({
          Versions: [{ Key: `${prefix}one.json`, VersionId: 'v1' }],
          IsTruncated: true,
          NextKeyMarker: `${prefix}one.json`,
          NextVersionIdMarker: 'v1',
        })
        .mockResolvedValueOnce({
          Versions: [{ Key: `${prefix}two.json`, VersionId: 'v2' }],
          IsTruncated: false,
        }),
    });
    const storage = createStorage(api);

    const first = await storage.listPrivacyObjectVersions({
      tenantId: TENANT_ID,
      bucket: 'TENANT_EXPORTS',
      cursor: null,
      limit: 100,
    });
    expect(first).toMatchObject({
      versions: [{ objectKey: `${prefix}one.json`, objectVersionId: 'v1' }],
    });
    expect(first.nextCursor).toBeTypeOf('string');
    const second = await storage.listPrivacyObjectVersions({
      tenantId: TENANT_ID,
      bucket: 'TENANT_EXPORTS',
      cursor: first.nextCursor,
      limit: 100,
    });
    expect(second).toEqual({
      versions: [{ objectKey: `${prefix}two.json`, objectVersionId: 'v2' }],
      nextCursor: null,
    });
    expect(api.listObjectVersions.mock.calls[0]?.[0] as unknown).toEqual({
      Bucket: EXPORT_BUCKET,
      Prefix: prefix,
      ExpectedBucketOwner: '123456789012',
      MaxKeys: 100,
    });
    expect(api.listObjectVersions.mock.calls[1]?.[0] as unknown).toMatchObject({
      KeyMarker: `${prefix}one.json`,
      VersionIdMarker: 'v1',
    });
    expectInventoryAbortSignal(api.listObjectVersions.mock.calls[0]?.[1] as unknown);
    expectInventoryAbortSignal(api.listObjectVersions.mock.calls[1]?.[1] as unknown);
  });

  test('inventories and deletes only exact versions under one workload Workspace', async () => {
    const prefix = `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/`;
    const key = `${prefix}unknown/vendor-object.bin`;
    const api = s3Api({
      listObjectVersions: vi.fn().mockResolvedValue({
        Versions: [{ Key: key, VersionId: 'unknown-v1' }],
        IsTruncated: false,
      }),
      headObject: vi.fn().mockResolvedValue({
        VersionId: 'unknown-v1',
        ContentLength: 7,
        ContentType: 'application/octet-stream',
        Metadata: { 'tenant-id': TENANT_ID, 'workspace-id': WORKSPACE_ID },
      }),
      deleteObject: vi.fn().mockResolvedValue({}),
    });
    const storage = createStorage(api);

    await expect(
      storage.listPrivacyObjectVersions({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        bucket: 'WORKLOAD_OBJECTS',
        cursor: null,
        limit: 100,
      }),
    ).resolves.toEqual({
      versions: [{ objectKey: key, objectVersionId: 'unknown-v1', workspaceId: WORKSPACE_ID }],
      nextCursor: null,
    });
    await expect(
      storage.deleteWorkloadVersion({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        objectKey: key,
        objectVersionId: 'unknown-v1',
      }),
    ).resolves.toBe('DELETED');
    expect(api.listObjectVersions.mock.calls[0]?.[0] as unknown).toEqual({
      Bucket: EXPORT_BUCKET,
      Prefix: prefix,
      ExpectedBucketOwner: '123456789012',
      MaxKeys: 100,
    });
    expect(api.deleteObject).toHaveBeenCalledWith({
      Bucket: EXPORT_BUCKET,
      Key: key,
      VersionId: 'unknown-v1',
      ExpectedBucketOwner: '123456789012',
    });
    const listOptions = api.listObjectVersions.mock.calls[0]?.[1] as
      { abortSignal?: AbortSignal } | undefined;
    const headOptions = api.headObject.mock.calls[0]?.[1] as
      { abortSignal?: AbortSignal } | undefined;
    expect(listOptions?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(headOptions?.abortSignal).toBe(listOptions?.abortSignal);
  });

  test('inventories and exactly deletes workload S3 DeleteMarkers without HEAD metadata', async () => {
    const prefix = `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/`;
    const key = `${prefix}unknown/deleted-vendor-object.bin`;
    const api = s3Api({
      listObjectVersions: vi.fn().mockResolvedValue({
        DeleteMarkers: [
          {
            Key: key,
            VersionId: 'delete-marker-v1',
            LastModified: new Date('2026-07-22T12:00:00Z'),
          },
        ],
        IsTruncated: false,
      }),
      deleteObject: vi.fn().mockResolvedValue({}),
    });
    const storage = createStorage(api);

    await expect(
      storage.listPrivacyObjectVersions({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        bucket: 'WORKLOAD_OBJECTS',
        cursor: null,
        limit: 100,
      }),
    ).resolves.toEqual({
      versions: [
        {
          objectKey: key,
          objectVersionId: 'delete-marker-v1',
          workspaceId: WORKSPACE_ID,
          isDeleteMarker: true,
          createdAt: '2026-07-22T12:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    expect(api.headObject).not.toHaveBeenCalled();
    await expect(
      storage.deleteWorkloadVersion({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        objectKey: key,
        objectVersionId: 'delete-marker-v1',
        isDeleteMarker: true,
      }),
    ).resolves.toBe('DELETED');
    expect(api.deleteObject).toHaveBeenCalledWith({
      Bucket: EXPORT_BUCKET,
      Key: key,
      VersionId: 'delete-marker-v1',
      ExpectedBucketOwner: '123456789012',
    });
    expect(api.headObject).not.toHaveBeenCalled();

    const exportMarkerKey = `tenants/${TENANT_ID}/exports/deleted-export.bundle.json`;
    await expect(
      storage.deleteExportVersion({
        tenantId: TENANT_ID,
        objectKey: exportMarkerKey,
        objectVersionId: 'export-delete-marker-v1',
        at: new Date('2026-07-22T12:00:00.000Z'),
        isDeleteMarker: true,
      }),
    ).resolves.toEqual({ outcome: 'DELETED' });
    expect(api.deleteObject).toHaveBeenCalledWith({
      Bucket: EXPORT_BUCKET,
      Key: exportMarkerKey,
      VersionId: 'export-delete-marker-v1',
      ExpectedBucketOwner: '123456789012',
    });
    expect(api.headObject).not.toHaveBeenCalled();
  });
});

function createStorage(api: ReturnType<typeof s3Api>) {
  return new AwsS3PrivacyObjectStorage(api, {
    region: 'ap-southeast-1',
    accountId: '123456789012',
    exportBucket: EXPORT_BUCKET,
    auditBucket: AUDIT_BUCKET,
    kmsKeyArn: KMS_KEY_ARN,
    clock: { now: () => new Date('2026-07-22T00:00:00.000Z') },
  });
}

function s3Api(overrides: Record<string, unknown> = {}) {
  return {
    putObject: vi.fn().mockResolvedValue({ VersionId: 'version-1' }),
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
    getObjectLegalHold: vi.fn(),
    putObjectLegalHold: vi.fn(),
    listObjectVersions: vi.fn(),
    ...overrides,
  };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function expectInventoryAbortSignal(value: unknown): void {
  if (typeof value !== 'object' || value === null || !('abortSignal' in value)) {
    throw new Error('inventory abort signal required');
  }
  expect(value.abortSignal).toBeInstanceOf(AbortSignal);
}
