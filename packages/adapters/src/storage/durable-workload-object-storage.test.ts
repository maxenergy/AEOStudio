import { randomUUID } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';
import type {
  PreparedWorkloadObjectWrite,
  WorkloadObjectWriteIntentStore,
} from '@aeostudio/application/privacy-audit';
import type {
  CapabilityBoundWorkloadObjectRecovery,
  CapabilityBoundWorkloadObjectWriter,
  WorkloadWriteAccess,
  WorkloadWriteRecoveryResult,
} from '@aeostudio/application/tenant-data-access';

import { AwsS3WorkloadObjectStorage } from './aws-s3-workload-object-storage.js';
import { DurableWorkloadObjectStorage } from './durable-workload-object-storage.js';

const TENANT_ID = '018f84b3-7eb8-7c75-9ca5-25278969d3f1';
const WORKSPACE_ID = '018f84b3-7eb8-7c75-9ca5-25278969d3f2';
const ARTIFACT_ID = '018f84b3-7eb8-7c75-9ca5-25278969d3f3';
const DIRECT_S3_IS_NOT_CAPABILITY_BOUND_WRITER: AwsS3WorkloadObjectStorage extends CapabilityBoundWorkloadObjectWriter
  ? false
  : true = true;
type CapabilityBoundTestGateway = CapabilityBoundWorkloadObjectWriter &
  CapabilityBoundWorkloadObjectRecovery &
  Pick<
    AwsS3WorkloadObjectStorage,
    | 'prepareArtifactPayload'
    | 'get'
    | 'prepareChannelPackage'
    | 'getChannelPackage'
    | 'prepareCrawlSnapshot'
  >;

describe('durable workload object storage', () => {
  test('requires a capability-specific gateway instead of accepting the direct S3 adapter', () => {
    expect(DIRECT_S3_IS_NOT_CAPABILITY_BOUND_WRITER).toBe(true);
  });

  test('commits an immutable database intent before S3 and CAS-binds the exact version', async () => {
    const events: string[] = [];
    const operationId = randomUUID();
    const leaseToken = randomUUID();
    const store = {
      reserveWorkloadObjectWriteIntent: vi.fn(
        (
          input: Parameters<WorkloadObjectWriteIntentStore['reserveWorkloadObjectWriteIntent']>[0],
        ) => {
          events.push('reserve');
          return Promise.resolve({ outcome: 'PENDING' as const, operationId, intent: input });
        },
      ),
      claimWorkloadObjectWriteIntent: vi.fn(() => {
        events.push('claim');
        return Promise.resolve(true);
      }),
      completeWorkloadObjectWriteIntent: vi.fn(
        (
          input: Parameters<WorkloadObjectWriteIntentStore['completeWorkloadObjectWriteIntent']>[0],
        ) => {
          void input;
          events.push('complete');
          return Promise.resolve(true);
        },
      ),
      releaseWorkloadObjectWriteIntentLease: vi.fn(() => Promise.resolve(true)),
      claimPendingWorkloadObjectWriteIntents: vi.fn(() => Promise.resolve([])),
    };
    const raw = new AwsS3WorkloadObjectStorage(
      {
        putObject: vi.fn(() => {
          events.push('put');
          return Promise.resolve({ VersionId: 'exact-artifact-v1' });
        }),
        headObject: vi.fn(),
        getObject: vi.fn(),
      },
      {
        region: 'ap-southeast-1',
        accountId: '123456789012',
        bucket: 'aeostudio-staging-123456789012-artifacts',
        kmsKeyArn:
          'arn:aws:kms:ap-southeast-1:123456789012:key/018f84b3-7eb8-7c75-9ca5-25278969d3f4',
      },
    );
    const putAuthorizedWorkloadVersion = vi.fn(
      (input: PreparedWorkloadObjectWrite, access: WorkloadWriteAccess) => {
        void access;
        return raw.putWorkloadVersion(input);
      },
    );
    const durable = new DurableWorkloadObjectStorage(
      capabilityBoundTestGateway(raw, { putAuthorizedWorkloadVersion }),
      store,
      {
        ids: { next: vi.fn().mockReturnValueOnce(operationId).mockReturnValueOnce(leaseToken) },
        clock: { now: () => new Date('2026-07-22T12:00:00.000Z') },
      },
    );

    const stored = await durable.put(artifactInput());
    expect(stored.objectRef).toContain('versionId=exact-artifact-v1');
    expect(events).toEqual(['reserve', 'claim', 'put', 'complete']);
    expect(putAuthorizedWorkloadVersion).toHaveBeenCalledWith(expect.any(Object), {
      operationId,
      leaseToken,
    });
    expect(store.reserveWorkloadObjectWriteIntent.mock.calls[0]?.[0]).not.toHaveProperty(
      'canonicalPayload',
    );
    expect(store.completeWorkloadObjectWriteIntent.mock.calls[0]?.[0]).toMatchObject({
      operationId,
      leaseToken,
      object: {
        objectClass: 'ARTIFACT_PAYLOAD',
        objectVersionId: 'exact-artifact-v1',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
      },
    });
  });

  test('resolves an unknown PUT with the same leased capability before completing the intent', async () => {
    const operationId = randomUUID();
    const leaseToken = randomUUID();
    const codec = new AwsS3WorkloadObjectStorage(
      { putObject: vi.fn(), getObject: vi.fn(), headObject: vi.fn() },
      {
        region: 'ap-southeast-1',
        accountId: '123456789012',
        bucket: 'aeostudio-staging-123456789012-artifacts',
        kmsKeyArn:
          'arn:aws:kms:ap-southeast-1:123456789012:key/018f84b3-7eb8-7c75-9ca5-25278969d3f4',
      },
    );
    const prepared = codec.prepareArtifactPayload(artifactInput());
    const recovered = {
      kind: prepared.kind,
      objectClass: prepared.kind,
      tenantId: prepared.tenantId,
      workspaceId: prepared.workspaceId,
      objectRef:
        `s3://aeostudio-staging-123456789012-artifacts/${prepared.objectKey}` +
        '?versionId=recovered-v1',
      objectKey: prepared.objectKey,
      objectVersionId: 'recovered-v1',
      checksum: prepared.checksum,
      contentType: prepared.contentType,
      byteLength: prepared.byteLength,
      createdAt: '2026-07-23T10:00:00.000Z',
    };
    const recoverAuthorizedWorkloadVersion = vi
      .fn()
      .mockResolvedValue({ outcome: 'FOUND', object: recovered });
    const releaseWorkloadObjectWriteIntentLease = vi.fn().mockResolvedValue(true);
    const completeWorkloadObjectWriteIntent = vi.fn().mockResolvedValue(true);
    const raw = {
      prepareArtifactPayload: codec.prepareArtifactPayload.bind(codec),
      get: codec.get.bind(codec),
      prepareChannelPackage: codec.prepareChannelPackage.bind(codec),
      getChannelPackage: codec.getChannelPackage.bind(codec),
      prepareCrawlSnapshot: codec.prepareCrawlSnapshot.bind(codec),
      putAuthorizedWorkloadVersion: vi
        .fn()
        .mockRejectedValue(new Error('TENANT_DATA_EFFECT_OUTCOME_UNKNOWN')),
      recoverAuthorizedWorkloadVersion,
    };
    const store: WorkloadObjectWriteIntentStore = {
      reserveWorkloadObjectWriteIntent: vi.fn().mockResolvedValue({
        outcome: 'PENDING',
        operationId,
      }),
      claimWorkloadObjectWriteIntent: vi.fn().mockResolvedValue(true),
      claimPendingWorkloadObjectWriteIntents: vi.fn().mockResolvedValue([]),
      completeWorkloadObjectWriteIntent,
      releaseWorkloadObjectWriteIntentLease,
    };
    const durable = new DurableWorkloadObjectStorage(raw, store, {
      ids: { next: vi.fn().mockReturnValueOnce(operationId).mockReturnValueOnce(leaseToken) },
      clock: { now: () => new Date('2026-07-23T10:00:00.000Z') },
    });

    await expect(durable.put(artifactInput())).resolves.toEqual({
      objectRef: recovered.objectRef,
    });
    expect(recoverAuthorizedWorkloadVersion).toHaveBeenCalledWith(prepared, {
      operationId,
      leaseToken,
    });
    expect(completeWorkloadObjectWriteIntent).toHaveBeenCalledWith({
      operationId,
      leaseToken,
      object: recovered,
    });
    expect(releaseWorkloadObjectWriteIntentLease).not.toHaveBeenCalled();
  });

  test.each([
    ['an UNKNOWN resolution', { outcome: 'UNKNOWN' as const }],
    ['a failed resolution request', new Error('BROKER_RECOVERY_UNAVAILABLE')],
  ])('retains the lease after %s', async (_case, recovery) => {
    const fixture = unknownPutFixture(recovery);

    await expect(fixture.durable.put(artifactInput())).rejects.toThrow(
      'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN',
    );
    expect(fixture.recoverAuthorizedWorkloadVersion).toHaveBeenCalledWith(fixture.prepared, {
      operationId: fixture.operationId,
      leaseToken: fixture.leaseToken,
    });
    expect(fixture.releaseWorkloadObjectWriteIntentLease).not.toHaveBeenCalled();
    expect(fixture.completeWorkloadObjectWriteIntent).not.toHaveBeenCalled();
  });

  test.each(['ABSENT', 'FAILED'] as const)(
    'releases the lease only after recovery proves %s',
    async (outcome) => {
      const fixture = unknownPutFixture({ outcome });

      await expect(fixture.durable.put(artifactInput())).rejects.toThrow(
        'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN',
      );
      expect(fixture.releaseWorkloadObjectWriteIntentLease).toHaveBeenCalledWith({
        operationId: fixture.operationId,
        leaseToken: fixture.leaseToken,
      });
      expect(fixture.completeWorkloadObjectWriteIntent).not.toHaveBeenCalled();
    },
  );

  test('does not invoke recovery for an ordinary pre-effect failure', async () => {
    const fixture = unknownPutFixture(
      { outcome: 'UNKNOWN' },
      new Error('S3_WORKLOAD_OBJECT_SCOPE_MISMATCH'),
    );

    await expect(fixture.durable.put(artifactInput())).rejects.toThrow(
      'S3_WORKLOAD_OBJECT_SCOPE_MISMATCH',
    );
    expect(fixture.recoverAuthorizedWorkloadVersion).not.toHaveBeenCalled();
    expect(fixture.releaseWorkloadObjectWriteIntentLease).toHaveBeenCalledWith({
      operationId: fixture.operationId,
      leaseToken: fixture.leaseToken,
    });
  });

  test('replays the stable key after S3 succeeded but the completion lease was lost', async () => {
    const operationId = randomUUID();
    const putObject = vi.fn((input: unknown) => {
      void input;
      return Promise.resolve({ VersionId: 'stable-v1' });
    });
    const raw = new AwsS3WorkloadObjectStorage(
      { putObject, getObject: vi.fn(), headObject: vi.fn() },
      {
        region: 'ap-southeast-1',
        accountId: '123456789012',
        bucket: 'aeostudio-staging-123456789012-artifacts',
        kmsKeyArn:
          'arn:aws:kms:ap-southeast-1:123456789012:key/018f84b3-7eb8-7c75-9ca5-25278969d3f4',
      },
    );
    const store: WorkloadObjectWriteIntentStore = {
      reserveWorkloadObjectWriteIntent: vi.fn(() =>
        Promise.resolve({ outcome: 'PENDING' as const, operationId }),
      ),
      claimWorkloadObjectWriteIntent: vi.fn(() => Promise.resolve(true)),
      claimPendingWorkloadObjectWriteIntents: vi.fn(() => Promise.resolve([])),
      completeWorkloadObjectWriteIntent: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      releaseWorkloadObjectWriteIntentLease: vi.fn(() => Promise.resolve(true)),
    };
    const durable = new DurableWorkloadObjectStorage(
      capabilityBoundTestGateway(raw, {
        putAuthorizedWorkloadVersion: (input) => raw.putWorkloadVersion(input),
      }),
      store,
      {
        ids: { next: randomUUID },
        clock: { now: () => new Date('2026-07-22T12:00:00.000Z') },
      },
    );

    await expect(durable.put(artifactInput())).rejects.toThrow('WORKLOAD_OBJECT_WRITE_LEASE_LOST');
    const stored = await durable.put(artifactInput());
    expect(stored.objectRef).toContain('versionId=stable-v1');
    expect(putObject).toHaveBeenCalledTimes(2);
    expect(putObject.mock.calls[0]?.[0]).toEqual(putObject.mock.calls[1]?.[0]);
  });
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
      claimMap: [],
      disclosure: 'Human review is required before publication.',
    },
  };
}

function capabilityBoundTestGateway(
  codec: AwsS3WorkloadObjectStorage,
  operations: {
    putAuthorizedWorkloadVersion(
      input: PreparedWorkloadObjectWrite,
      access: WorkloadWriteAccess,
    ): ReturnType<AwsS3WorkloadObjectStorage['putWorkloadVersion']>;
    recoverAuthorizedWorkloadVersion?(
      input: Parameters<
        CapabilityBoundWorkloadObjectRecovery['recoverAuthorizedWorkloadVersion']
      >[0],
      access: WorkloadWriteAccess,
    ): Promise<WorkloadWriteRecoveryResult>;
  },
) {
  return {
    prepareArtifactPayload: codec.prepareArtifactPayload.bind(codec),
    get: codec.get.bind(codec),
    prepareChannelPackage: codec.prepareChannelPackage.bind(codec),
    getChannelPackage: codec.getChannelPackage.bind(codec),
    prepareCrawlSnapshot: codec.prepareCrawlSnapshot.bind(codec),
    putAuthorizedWorkloadVersion: (input, access) =>
      operations.putAuthorizedWorkloadVersion(input, access),
    recoverAuthorizedWorkloadVersion: (input, access) =>
      operations.recoverAuthorizedWorkloadVersion?.(input, access) ??
      Promise.resolve({ outcome: 'UNKNOWN' as const }),
  } satisfies CapabilityBoundTestGateway;
}

function unknownPutFixture(
  recovery: WorkloadWriteRecoveryResult | Error,
  putError: Error = new Error('TENANT_DATA_EFFECT_OUTCOME_UNKNOWN'),
) {
  const operationId = randomUUID();
  const leaseToken = randomUUID();
  const codec = new AwsS3WorkloadObjectStorage(
    { putObject: vi.fn(), getObject: vi.fn(), headObject: vi.fn() },
    {
      region: 'ap-southeast-1',
      accountId: '123456789012',
      bucket: 'aeostudio-staging-123456789012-artifacts',
      kmsKeyArn: 'arn:aws:kms:ap-southeast-1:123456789012:key/018f84b3-7eb8-7c75-9ca5-25278969d3f4',
    },
  );
  const prepared = codec.prepareArtifactPayload(artifactInput());
  const recoverAuthorizedWorkloadVersion = vi.fn(() =>
    recovery instanceof Error ? Promise.reject(recovery) : Promise.resolve(recovery),
  );
  const releaseWorkloadObjectWriteIntentLease = vi.fn().mockResolvedValue(true);
  const completeWorkloadObjectWriteIntent = vi.fn().mockResolvedValue(true);
  const durable = new DurableWorkloadObjectStorage(
    capabilityBoundTestGateway(codec, {
      putAuthorizedWorkloadVersion: vi.fn().mockRejectedValue(putError),
      recoverAuthorizedWorkloadVersion,
    }),
    {
      reserveWorkloadObjectWriteIntent: vi.fn().mockResolvedValue({
        outcome: 'PENDING',
        operationId,
      }),
      claimWorkloadObjectWriteIntent: vi.fn().mockResolvedValue(true),
      claimPendingWorkloadObjectWriteIntents: vi.fn().mockResolvedValue([]),
      completeWorkloadObjectWriteIntent,
      releaseWorkloadObjectWriteIntentLease,
    },
    {
      ids: { next: vi.fn().mockReturnValueOnce(operationId).mockReturnValueOnce(leaseToken) },
      clock: { now: () => new Date('2026-07-23T10:00:00.000Z') },
    },
  );
  return {
    durable,
    operationId,
    leaseToken,
    prepared,
    recoverAuthorizedWorkloadVersion,
    releaseWorkloadObjectWriteIntentLease,
    completeWorkloadObjectWriteIntent,
  };
}
