import { beforeEach, describe, expect, test, vi } from 'vitest';

const aws = vi.hoisted(() => ({
  send: vi.fn<(command: unknown, options?: unknown) => unknown>(),
  destroy: vi.fn<() => void>(),
}));

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
    GetObjectCommand: TestCommand,
    HeadObjectCommand: TestCommand,
    PutObjectCommand: TestCommand,
    S3Client: TestS3Client,
  };
});

import { createAwsS3WorkloadObjectStorage } from './aws-s3-workload-sdk.js';

const TENANT_ID = '018f84b3-7eb8-7c75-9ca5-25278969d3f1';
const WORKSPACE_ID = '018f84b3-7eb8-7c75-9ca5-25278969d3f2';
const ARTIFACT_ID = '018f84b3-7eb8-7c75-9ca5-25278969d3f3';
const KMS_KEY_ARN =
  'arn:aws:kms:ap-southeast-1:123456789012:key/018f84b3-7eb8-7c75-9ca5-25278969d3f4';

describe('AWS S3 SDK workload boundary', () => {
  beforeEach(() => {
    aws.send.mockReset();
    aws.destroy.mockReset();
  });

  test('adopts the exact existing immutable version after an ambiguous conditional retry', async () => {
    aws.send
      .mockRejectedValueOnce({ name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } })
      .mockImplementationOnce(() => {
        const put = commandInput(1);
        const metadata = put.Metadata as Record<string, string>;
        return Promise.resolve({
          VersionId: 'existing-workload-v1',
          ContentType: put.ContentType,
          ContentLength: (put.Body as Uint8Array).byteLength,
          ChecksumSHA256: put.ChecksumSHA256,
          Metadata: metadata,
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: KMS_KEY_ARN,
        });
      });
    const resource = await createResource();

    const stored = await resource.artifacts.put(artifactInput());
    expect(stored.objectRef).toContain('versionId=existing-workload-v1');

    expect(commandInput(1)).toMatchObject({ IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256' });
    expect(commandInput(2)).toMatchObject({ ChecksumMode: 'ENABLED' });
    expect(readAbortSignal(aws.send.mock.calls[0]?.[1])).toBeInstanceOf(AbortSignal);
    expect(readAbortSignal(aws.send.mock.calls[1]?.[1])).toBeInstanceOf(AbortSignal);
    await resource.close();
    expect(aws.destroy).toHaveBeenCalledOnce();
  });

  test('rejects a 412 key collision with a foreign immutable checksum', async () => {
    aws.send
      .mockRejectedValueOnce({ name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } })
      .mockImplementationOnce(() => {
        const put = commandInput(1);
        return Promise.resolve({
          VersionId: 'foreign-workload-v1',
          ContentType: put.ContentType,
          ContentLength: (put.Body as Uint8Array).byteLength,
          Metadata: {
            ...(put.Metadata as Record<string, string>),
            sha256: '0'.repeat(64),
          },
          ChecksumSHA256: put.ChecksumSHA256,
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: KMS_KEY_ARN,
        });
      });
    const resource = await createResource();

    await expect(resource.artifacts.put(artifactInput())).rejects.toThrow(
      'S3_WORKLOAD_OBJECT_KEY_CONFLICT',
    );
    await resource.close();
  });

  test.each([
    { name: 'ConditionalRequestConflict', status: 409 },
    { name: 'TimeoutError', status: undefined },
    { name: 'InternalError', status: 500 },
  ])(
    'adopts the exact existing immutable version after ambiguous $name',
    async ({ name, status }) => {
      aws.send
        .mockRejectedValueOnce({
          name,
          ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }),
        })
        .mockImplementationOnce(() => {
          const put = commandInput(1);
          return Promise.resolve({
            VersionId: `existing-${name}`,
            ContentType: put.ContentType,
            ContentLength: (put.Body as Uint8Array).byteLength,
            ChecksumSHA256: put.ChecksumSHA256,
            Metadata: put.Metadata,
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: KMS_KEY_ARN,
          });
        });
      const resource = await createResource();

      const stored = await resource.artifacts.put(artifactInput());
      expect(stored.objectRef).toContain(`versionId=existing-${name}`);
      expect(commandInput(2)).toMatchObject({ ChecksumMode: 'ENABLED' });
      await resource.close();
    },
  );
});

function artifactInput() {
  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    artifactId: ARTIFACT_ID,
    revision: 1,
    contentHash: 'a'.repeat(64),
    payload: {
      title: 'Immutable workload artifact',
      summary: 'Evidence-backed summary',
      sections: [{ heading: 'Evidence', body: 'Bound evidence.' }],
      claimMap: [
        {
          claimRevisionId: '018f84b3-7eb8-7c75-9ca5-25278969d3f5',
          statement: 'Bound statement.',
          evidenceSourceIds: ['018f84b3-7eb8-7c75-9ca5-25278969d3f6'],
        },
      ],
      disclosure: 'Human review is required before publication.',
    },
  };
}

function createResource() {
  return createAwsS3WorkloadObjectStorage({
    region: 'ap-southeast-1',
    accountId: '123456789012',
    bucket: 'aeostudio-staging-123456789012-artifacts',
    kmsKeyArn: KMS_KEY_ARN,
  });
}

function commandInput(call: number): Record<string, unknown> {
  const command = aws.send.mock.calls[call - 1]?.[0] as { input?: Record<string, unknown> };
  return command.input ?? {};
}

function readAbortSignal(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('abortSignal' in value)) return undefined;
  return value.abortSignal;
}
