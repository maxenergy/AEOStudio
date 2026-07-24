import { describe, expect, test } from 'vitest';

import { AwsS3EvidenceObjectStore, type AwsS3EvidenceApi } from './aws-s3-evidence-object-store.js';

const tenantA = '00000000-0000-7000-8000-000000000601';
const tenantB = '00000000-0000-7000-8000-000000000602';
const workspaceId = '00000000-0000-7000-8000-000000000603';
const sourceId = '00000000-0000-7000-8000-000000000604';
const snapshotId = '00000000-0000-7000-8000-000000000605';
const contentHash = 'a'.repeat(64);
const versionId = 'immutable-version-1';
const key =
  `tenants/${tenantA}/workspaces/${workspaceId}/evidence-sources/${sourceId}` +
  `/snapshots/${snapshotId}/${contentHash}`;

describe('AwsS3EvidenceObjectStore', () => {
  test('writes server-derived metadata to a content-addressed immutable S3 version', async () => {
    const body = new TextEncoder().encode('Exact supporting excerpt.');
    const actualHash = createHash('sha256').update(body).digest('hex');
    let putInput: Parameters<AwsS3EvidenceApi['putObject']>[0] | undefined;
    const api: AwsS3EvidenceApi = {
      putObject: (input) => {
        putInput = input;
        return Promise.resolve({ VersionId: versionId });
      },
      getObject: () => Promise.reject(new Error('not used')),
    };
    const storage = new AwsS3EvidenceObjectStore(api, {
      region: 'ap-southeast-1',
      accountId: '123456789012',
      bucket: 'aeostudio-evidence-test',
      kmsKeyArn: 'arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-7000-8000-000000000606',
    });

    const stored = await storage.ingestExact({
      tenantId: tenantA,
      workspaceId,
      sourceId,
      snapshotId,
      contentHash: actualHash,
      contentType: 'text/plain',
      sizeBytes: body.byteLength,
      body,
    });

    expect(stored).toMatchObject({
      tenantId: tenantA,
      workspaceId,
      sourceId,
      snapshotId,
      objectVersionId: versionId,
      contentHash: actualHash,
      contentType: 'text/plain',
      sizeBytes: body.byteLength,
    });
    expect(stored.objectRef).toBe(
      `s3://aeostudio-evidence-test/tenants/${tenantA}/workspaces/${workspaceId}` +
        `/evidence-sources/${sourceId}/snapshots/${snapshotId}/${actualHash}` +
        `?versionId=${versionId}`,
    );
    expect(putInput).toMatchObject({
      Bucket: 'aeostudio-evidence-test',
      Key:
        `tenants/${tenantA}/workspaces/${workspaceId}/evidence-sources/${sourceId}` +
        `/snapshots/${snapshotId}/${actualHash}`,
      Body: body,
      ContentType: 'text/plain',
      IfNoneMatch: '*',
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: Buffer.from(actualHash, 'hex').toString('base64'),
      ServerSideEncryption: 'aws:kms',
      ExpectedBucketOwner: '123456789012',
      Metadata: {
        'tenant-id': tenantA,
        'workspace-id': workspaceId,
        'source-id': sourceId,
        'snapshot-id': snapshotId,
        sha256: actualHash,
      },
    });
  });

  test('rejects an exact object whose durable S3 metadata belongs to another Tenant', async () => {
    const body = new TextEncoder().encode('Exact supporting excerpt.');
    const api: AwsS3EvidenceApi = {
      putObject: () => Promise.reject(new Error('not used')),
      getObject: () =>
        Promise.resolve({
          VersionId: versionId,
          ContentType: 'text/plain',
          ContentLength: body.byteLength,
          ChecksumSHA256: Buffer.from(contentHash, 'hex').toString('base64'),
          Metadata: {
            'tenant-id': tenantB,
            'workspace-id': workspaceId,
            'source-id': sourceId,
            'snapshot-id': snapshotId,
            sha256: contentHash,
          },
          Body: body,
        }),
    };
    const storage = new AwsS3EvidenceObjectStore(api, {
      region: 'ap-southeast-1',
      accountId: '123456789012',
      bucket: 'aeostudio-evidence-test',
      kmsKeyArn: 'arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-7000-8000-000000000606',
    });

    await expect(
      storage.readExact({
        tenantId: tenantA,
        workspaceId,
        sourceId,
        snapshotId,
        objectRef: `s3://aeostudio-evidence-test/${key}?versionId=${versionId}`,
        objectVersionId: versionId,
        contentHash,
        contentType: 'text/plain',
        sizeBytes: body.byteLength,
      }),
    ).rejects.toThrow('EVIDENCE_OBJECT_SCOPE_MISMATCH');
  });
});
import { createHash } from 'node:crypto';
