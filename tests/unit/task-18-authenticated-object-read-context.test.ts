import {
  ArtifactService,
  canonicalArtifactJson,
  hashArtifactRevision,
  type ArtifactPayloadStore,
  type ArtifactStore,
} from '@aeostudio/application/artifacts';
import {
  ChannelPackageService,
  DefaultChannelPackageTransformerRegistry,
  type ChannelPackagePayloadStore,
  type ChannelPackageStore,
} from '@aeostudio/application/channels-publishing';
import type {
  CapabilityBoundArtifactRevisionPayloadReader,
  CapabilityBoundChannelPackagePayloadReader,
  ArtifactRevisionPayloadReadRequest,
  ChannelPackagePayloadReadRequest,
} from '@aeostudio/application/tenant-data-access';
import type {
  ArtifactLedgerBundle,
  ArtifactPayload,
  ArtifactRevisionRecord,
} from '@aeostudio/domain/artifacts';
import type {
  ChannelPackagePayload,
  ChannelPackageRecord,
} from '@aeostudio/domain/channels-publishing';
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';

const tenantContext = {
  tenantId: '00000000-0000-7000-8000-000000000101',
  workspaceId: '00000000-0000-7000-8000-000000000102',
  actorUserId: '00000000-0000-7000-8000-000000000103',
  membershipId: '00000000-0000-7000-8000-000000000104',
  role: 'OWNER' as const,
};
const rawSessionToken = 'task-18-raw-session-token';

const artifactPayload: ArtifactPayload = {
  title: 'Capability-bound Artifact',
  summary: 'The payload is read only through its authoritative revision.',
  sections: [{ heading: 'Evidence', body: 'Bound to an exact immutable revision.' }],
  claimMap: [],
  disclosure: 'Generated from approved evidence.',
};

describe('Task 18 authenticated workload object read contexts', () => {
  test('ArtifactService binds a payload read to the resolved TenantContext and exact Artifact revision', async () => {
    const bundle = artifactBundle();
    const observed: ArtifactRevisionPayloadReadRequest[] = [];
    const reader: CapabilityBoundArtifactRevisionPayloadReader = {
      readAuthenticatedArtifactRevision(input) {
        observed.push(input);
        return Promise.resolve(artifactPayload);
      },
    };
    const service = artifactService(bundle, reader);

    await expect(
      service.getArtifact({
        actorSubject: 'auth0|task-18-reader',
        sessionToken: rawSessionToken,
        tenantId: tenantContext.tenantId,
        workspaceId: tenantContext.workspaceId,
        artifactId: bundle.artifact.id,
      }),
    ).resolves.toMatchObject({ payload: artifactPayload });
    expect(observed).toEqual([
      {
        sessionToken: rawSessionToken,
        context: tenantContext,
        authority: {
          kind: 'ARTIFACT_REVISION',
          artifactRevisionId: bundle.revision?.id,
        },
        expected: {
          objectRef: bundle.revision?.payloadObjectRef,
          contentHash: bundle.revision?.contentHash,
        },
      },
    ]);
  });

  test('ChannelPackageService binds preview reads to the persisted package id and checksum', async () => {
    const { record, payload } = channelPackageFixture();
    const observed: ChannelPackagePayloadReadRequest[] = [];
    const reader: CapabilityBoundChannelPackagePayloadReader = {
      readAuthenticatedChannelPackage(input) {
        observed.push(input);
        return Promise.resolve(payload);
      },
    };
    const service = channelPackageService(record, reader);

    await expect(
      service.getPreview({
        actorSubject: 'auth0|task-18-reader',
        sessionToken: rawSessionToken,
        tenantId: tenantContext.tenantId,
        workspaceId: tenantContext.workspaceId,
        packageId: record.id,
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED', package: { id: record.id } });
    expect(observed).toEqual([
      {
        sessionToken: rawSessionToken,
        context: tenantContext,
        authority: { kind: 'CHANNEL_PACKAGE', packageId: record.id },
        expected: {
          objectRef: record.payloadObjectRef,
          packageChecksum: record.packageChecksum,
        },
      },
    ]);
  });

  test('ChannelPackageService write verification binds the read to createOrFind persisted authority', async () => {
    const bundle = approvedArtifactBundle();
    const transformedPayload = channelPackageFixture().payload;
    const candidatePackageId = '00000000-0000-7000-8000-000000000205';
    const persistedPackageId = '00000000-0000-7000-8000-000000000206';
    const packageObjectRef = 'memory://channel-packages/persisted-package';
    const artifactReads: ArtifactRevisionPayloadReadRequest[] = [];
    const packageReads: ChannelPackagePayloadReadRequest[] = [];
    let persistedRecord: ChannelPackageRecord | undefined;
    let nextIdCalls = 0;
    const service = new ChannelPackageService(
      {
        createOrFind(input: Parameters<ChannelPackageStore['createOrFind']>[0]) {
          persistedRecord = {
            id: persistedPackageId,
            tenantId: input.context.tenantId,
            workspaceId: input.context.workspaceId,
            packageRevision: 1,
            packageSchemaVersion: input.packageSchemaVersion,
            channel: input.channel,
            transformer: input.transformer,
            artifact: input.artifact,
            manifest: input.manifest,
            packageChecksum: input.packageChecksum,
            payloadObjectRef: input.payloadObjectRef,
            createdByUserId: input.context.actorUserId,
            createdAt: input.createdAt.toISOString(),
          };
          return Promise.resolve({ record: persistedRecord, created: false });
        },
      } as unknown as ChannelPackageStore,
      {
        put: () => Promise.resolve({ objectRef: packageObjectRef }),
        get: () => Promise.reject(new Error('GENERIC_CHANNEL_PACKAGE_READ_FORBIDDEN')),
      },
      {
        readAuthenticatedChannelPackage(input) {
          packageReads.push(input);
          return Promise.resolve(
            input.authority.packageId === persistedPackageId ? transformedPayload : null,
          );
        },
      },
      {
        listEntries: () =>
          Promise.resolve([
            {
              id: '00000000-0000-7000-8000-000000000207',
              channelKey: 'generic-web',
              displayName: 'Generic web package',
              status: 'AVAILABLE',
              unavailableReason: null,
              packageTransformerKey: 'generic-web-package',
              packageSchemaVersion: '1.0.0',
              adapterVersions: [],
            },
          ]),
      },
      new DefaultChannelPackageTransformerRegistry([
        {
          key: 'generic-web-package',
          version: '1.0.0',
          transform: () => transformedPayload,
        },
      ]),
      {
        findBundle: () => Promise.resolve(bundle),
      } as unknown as ArtifactStore,
      {
        readAuthenticatedArtifactRevision(input) {
          artifactReads.push(input);
          return Promise.resolve(artifactPayload);
        },
      },
      {
        resolveTenantContext: () => Promise.resolve(tenantContext),
      },
      {
        next() {
          nextIdCalls += 1;
          return nextIdCalls === 1 ? candidatePackageId : '00000000-0000-7000-8000-000000000208';
        },
      },
      { now: () => new Date('2026-07-23T08:00:00.000Z') },
    );
    const revision = bundle.revision;
    if (revision === null) throw new Error('ARTIFACT_REVISION_FIXTURE_MISSING');

    await expect(
      service.build({
        actorSubject: 'auth0|task-18-reader',
        sessionToken: rawSessionToken,
        tenantId: tenantContext.tenantId,
        workspaceId: tenantContext.workspaceId,
        artifactId: revision.artifactId,
        artifactRevisionId: revision.id,
        revision: revision.revision,
        expectedContentHash: revision.contentHash,
        channelKey: 'generic-web',
      }),
    ).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      created: false,
      package: { id: persistedPackageId },
    });
    expect(persistedRecord?.id).toBe(persistedPackageId);
    expect(persistedRecord?.id).not.toBe(candidatePackageId);
    expect(artifactReads).toEqual([
      {
        sessionToken: rawSessionToken,
        context: tenantContext,
        authority: {
          kind: 'ARTIFACT_REVISION',
          artifactRevisionId: revision.id,
        },
        expected: {
          objectRef: revision.payloadObjectRef,
          contentHash: revision.contentHash,
        },
      },
    ]);
    expect(packageReads).toEqual([
      {
        sessionToken: rawSessionToken,
        context: tenantContext,
        authority: {
          kind: 'CHANNEL_PACKAGE',
          packageId: persistedPackageId,
        },
        expected: {
          objectRef: packageObjectRef,
          packageChecksum: persistedRecord?.packageChecksum,
        },
      },
    ]);
  });

  test('ArtifactService rejects an objectRef substituted under a valid Artifact revision id', async () => {
    const original = artifactBundle();
    const revision = original.revision;
    if (revision === null) throw new Error('ARTIFACT_REVISION_FIXTURE_MISSING');
    const substitutedObjectRef =
      's3://workload/tenants/00000000-0000-7000-8000-000000000999/' +
      'workspaces/00000000-0000-7000-8000-000000000998/artifacts/foreign.json?versionId=v2';
    const substituted: ArtifactLedgerBundle = {
      ...original,
      revision: { ...revision, payloadObjectRef: substitutedObjectRef },
      revisions: [{ ...revision, payloadObjectRef: substitutedObjectRef }],
    };
    const reader: CapabilityBoundArtifactRevisionPayloadReader = {
      readAuthenticatedArtifactRevision(input) {
        const matchesAuthority =
          input.sessionToken === rawSessionToken &&
          input.context.tenantId === tenantContext.tenantId &&
          input.context.workspaceId === tenantContext.workspaceId &&
          input.authority.artifactRevisionId === revision.id &&
          input.expected.objectRef === revision.payloadObjectRef &&
          input.expected.contentHash === revision.contentHash;
        return Promise.resolve(matchesAuthority ? artifactPayload : null);
      },
    };

    await expect(
      artifactService(substituted, reader).getArtifact({
        actorSubject: 'auth0|task-18-reader',
        sessionToken: rawSessionToken,
        tenantId: tenantContext.tenantId,
        workspaceId: tenantContext.workspaceId,
        artifactId: original.artifact.id,
      }),
    ).resolves.toBeNull();
  });

  test('ChannelPackageService rejects a package object substituted under another source binding', async () => {
    const { record, payload } = channelPackageFixture();
    const substituted: ChannelPackageRecord = {
      ...record,
      payloadObjectRef:
        's3://workload/tenants/00000000-0000-7000-8000-000000000999/' +
        'workspaces/00000000-0000-7000-8000-000000000998/channel-packages/foreign.json' +
        '?versionId=v2',
    };
    const reader: CapabilityBoundChannelPackagePayloadReader = {
      readAuthenticatedChannelPackage(input) {
        const matchesAuthority =
          input.sessionToken === rawSessionToken &&
          input.context.tenantId === tenantContext.tenantId &&
          input.context.workspaceId === tenantContext.workspaceId &&
          input.authority.packageId === record.id &&
          input.expected.objectRef === record.payloadObjectRef &&
          input.expected.packageChecksum === record.packageChecksum;
        return Promise.resolve(matchesAuthority ? payload : null);
      },
    };

    await expect(
      channelPackageService(substituted, reader).getPreview({
        actorSubject: 'auth0|task-18-reader',
        sessionToken: rawSessionToken,
        tenantId: tenantContext.tenantId,
        workspaceId: tenantContext.workspaceId,
        packageId: record.id,
      }),
    ).resolves.toEqual({ outcome: 'PAYLOAD_INTEGRITY_INVALID' });
  });
});

function artifactService(
  bundle: ArtifactLedgerBundle,
  reader: CapabilityBoundArtifactRevisionPayloadReader,
): ArtifactService {
  const payloadWriter = {
    put: () => Promise.reject(new Error('UNEXPECTED_ARTIFACT_WRITE')),
    get: () => Promise.reject(new Error('GENERIC_ARTIFACT_READ_FORBIDDEN')),
  } satisfies ArtifactPayloadStore;
  return new ArtifactService(
    {
      findBundle: () => Promise.resolve(bundle),
    } as unknown as ArtifactStore,
    payloadWriter,
    reader,
    {} as never,
    {
      resolveTenantContext: () => Promise.resolve(tenantContext),
      appendDeniedAudit: () => Promise.reject(new Error('UNEXPECTED_DENIED_AUDIT')),
    },
    { next: () => '00000000-0000-7000-8000-000000000199' },
    { now: () => new Date('2026-07-23T08:00:00.000Z') },
  );
}

function channelPackageService(
  record: ChannelPackageRecord,
  reader: CapabilityBoundChannelPackagePayloadReader,
): ChannelPackageService {
  const payloadWriter = {
    put: () => Promise.reject(new Error('UNEXPECTED_CHANNEL_PACKAGE_WRITE')),
    get: () => Promise.reject(new Error('GENERIC_CHANNEL_PACKAGE_READ_FORBIDDEN')),
  } satisfies ChannelPackagePayloadStore;
  return new ChannelPackageService(
    {
      findById: () => Promise.resolve(record),
    } as unknown as ChannelPackageStore,
    payloadWriter,
    reader,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      resolveTenantContext: () => Promise.resolve(tenantContext),
    },
    { next: () => '00000000-0000-7000-8000-000000000299' },
    { now: () => new Date('2026-07-23T08:00:00.000Z') },
  );
}

function channelPackageFixture(): {
  record: ChannelPackageRecord;
  payload: ChannelPackagePayload;
} {
  const payload: ChannelPackagePayload = {
    files: {
      'content.md': '# Capability-bound package',
      'content.html': '<h1>Capability-bound package</h1>',
      'structured-data.json': '{"@type":"Product"}',
    },
  };
  const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  const manifest = {
    schemaVersion: '1.0.0',
    files: Object.entries(payload.files).map(([path, content]) => ({
      path,
      mediaType:
        path === 'content.md'
          ? 'text/markdown'
          : path === 'content.html'
            ? 'text/html'
            : 'application/ld+json',
      sha256: sha256(content),
      byteLength: Buffer.byteLength(content, 'utf8'),
    })),
    assetRefs: [],
    claimSourceMap: [],
  };
  const packageIdentity = {
    packageSchemaVersion: '1.0.0',
    channel: {
      definitionId: '00000000-0000-7000-8000-000000000201',
      channelKey: 'generic-web',
    },
    transformer: { key: 'generic-web', version: '1.0.0' },
    artifact: {
      artifactId: '00000000-0000-7000-8000-000000000202',
      artifactRevisionId: '00000000-0000-7000-8000-000000000203',
      revision: 1,
      contentHash: '3'.repeat(64),
      type: 'DEFINITION_PRODUCT' as const,
      locale: 'en-SG',
      market: 'SG',
      methodPolicyVersion: 'task-18-v1',
    },
    manifest,
    payload,
  };
  const packageChecksum = sha256(canonicalArtifactJson(packageIdentity));
  return {
    payload,
    record: {
      id: '00000000-0000-7000-8000-000000000204',
      tenantId: tenantContext.tenantId,
      workspaceId: tenantContext.workspaceId,
      packageRevision: 1,
      packageChecksum,
      packageSchemaVersion: packageIdentity.packageSchemaVersion,
      channel: packageIdentity.channel,
      transformer: packageIdentity.transformer,
      artifact: packageIdentity.artifact,
      manifest,
      payloadObjectRef:
        's3://workload/tenants/00000000-0000-7000-8000-000000000101/' +
        'workspaces/00000000-0000-7000-8000-000000000102/channel-packages/package.json' +
        '?versionId=v1',
      createdByUserId: tenantContext.actorUserId,
      createdAt: '2026-07-23T07:30:00.000Z',
    },
  };
}

function artifactBundle(): ArtifactLedgerBundle {
  const revisionWithoutHash = {
    id: '00000000-0000-7000-8000-000000000111',
    artifactId: '00000000-0000-7000-8000-000000000110',
    revision: 1,
    briefId: '00000000-0000-7000-8000-000000000112',
    type: 'DEFINITION_PRODUCT',
    schemaVersion: '1.0.0',
    status: 'APPROVED',
    locale: 'en-SG',
    market: 'SG',
    sourceArtifactIds: [],
    lineage: {
      contentPlanId: '00000000-0000-7000-8000-000000000113',
      brief: {
        id: '00000000-0000-7000-8000-000000000112',
        contentHash: '1'.repeat(64),
      },
      prompt: {
        promptSetId: '00000000-0000-7000-8000-000000000114',
        promptRevisionId: '00000000-0000-7000-8000-000000000115',
        contentHash: '2'.repeat(64),
        promptIds: [],
      },
      sourceReferences: [],
    },
    claimBindings: [],
    methodPolicyVersion: 'task-18-v1',
    createdByActor: { kind: 'AGENT', id: '00000000-0000-7000-8000-000000000116' },
    createdAt: '2026-07-23T07:00:00.000Z',
    payloadObjectRef:
      's3://workload/tenants/00000000-0000-7000-8000-000000000101/' +
      'workspaces/00000000-0000-7000-8000-000000000102/artifacts/revision.json?versionId=v1',
  } as const;
  const contentHash = hashArtifactRevision({
    schemaVersion: revisionWithoutHash.schemaVersion,
    artifactId: revisionWithoutHash.artifactId,
    revision: revisionWithoutHash.revision,
    type: revisionWithoutHash.type,
    locale: revisionWithoutHash.locale,
    market: revisionWithoutHash.market,
    sourceArtifactIds: revisionWithoutHash.sourceArtifactIds,
    lineage: revisionWithoutHash.lineage,
    claimBindings: revisionWithoutHash.claimBindings,
    methodPolicyVersion: revisionWithoutHash.methodPolicyVersion,
    payload: artifactPayload,
  });
  const revision: ArtifactRevisionRecord = { ...revisionWithoutHash, contentHash };
  return {
    artifact: {
      id: revision.artifactId,
      tenantId: tenantContext.tenantId,
      workspaceId: tenantContext.workspaceId,
      briefId: revision.briefId,
      type: revision.type,
      revision: revision.revision,
      status: 'APPROVED',
      locale: revision.locale,
      market: revision.market,
      methodPolicyVersion: revision.methodPolicyVersion,
      jobId: revision.createdByActor.id,
      createdByUserId: tenantContext.actorUserId,
      createdAt: revision.createdAt,
    },
    revision,
    revisions: [revision],
    reviews: [],
    approvalState: 'ELIGIBLE',
    selectableApprovedRevisions: [{ revision: 1, contentHash }],
  };
}

function approvedArtifactBundle(): ArtifactLedgerBundle {
  const bundle = artifactBundle();
  const revision = bundle.revision;
  if (revision === null) throw new Error('ARTIFACT_REVISION_FIXTURE_MISSING');
  return {
    ...bundle,
    reviews: [
      {
        id: '00000000-0000-7000-8000-000000000117',
        artifactId: revision.artifactId,
        artifactRevisionId: revision.id,
        revision: revision.revision,
        contentHash: revision.contentHash,
        decision: 'APPROVE',
        reviewerUserId: tenantContext.actorUserId,
        note: 'Approved for package generation.',
        createdAt: '2026-07-23T07:15:00.000Z',
      },
    ],
  };
}
