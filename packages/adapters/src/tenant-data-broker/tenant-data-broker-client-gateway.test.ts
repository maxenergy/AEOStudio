import { createHash } from 'node:crypto';

import { canonicalArtifactJson } from '@aeostudio/application/artifacts';
import { describe, expect, test, vi } from 'vitest';

import {
  createTenantDataBrokerClientGateway,
  type TenantDataBrokerClientCapabilityIssuer,
  type TenantDataBrokerClientInvoker,
} from './tenant-data-broker-client-gateway.js';

const TENANT_ID = '018f3b76-2000-7000-8000-000000000001';
const WORKSPACE_ID = '018f3b76-2000-7000-8000-000000000002';
const OPERATION_ID = '018f3b76-2000-7000-8000-000000000003';
const LEASE_TOKEN = '018f3b76-2000-7000-8000-000000000004';
const CANDIDATE_CAPABILITY_ID = '018f3b76-2000-7000-8000-000000000005';
const ISSUED_CAPABILITY_ID = '018f3b76-2000-7000-8000-000000000006';
const NOW = new Date('2026-07-23T20:00:00.000Z');
const WORKLOAD_BUCKET = 'aeostudio-staging-artifacts';
const MEMBERSHIP_ID = '018f3b76-2000-7000-8000-000000000008';
const SESSION_TOKEN = 's'.repeat(43);

describe('Tenant Data Broker application gateway', () => {
  test('fails closed when the issuer cannot mint validation-secret capabilities', () => {
    const incompleteIssuer: Partial<TenantDataBrokerClientCapabilityIssuer> = createIssuer();
    delete incompleteIssuer.issueChannelAuthorizationValidationSecretRead;

    expect(() =>
      createTenantDataBrokerClientGateway({
        issuer: incompleteIssuer as TenantDataBrokerClientCapabilityIssuer,
        client: { invoke: vi.fn<TenantDataBrokerClientInvoker['invoke']>() },
        ids: { next: () => CANDIDATE_CAPABILITY_ID },
        clock: { now: () => new Date(NOW) },
        buckets: {
          workload: WORKLOAD_BUCKET,
          tenantExports: 'aeostudio-staging-tenant-exports',
        },
        requestTimeoutMs: 5_000,
      }),
    ).toThrow('TENANT_DATA_BROKER_GATEWAY_OPTIONS_INVALID');
  });

  test('prepares a canonical Artifact payload without constructing a direct cloud client', () => {
    const contentHash = 'a'.repeat(64);
    const artifactId = '018f3b76-2000-7000-8000-000000000007';
    const payload = {
      title: 'Fixture',
      summary: 'Summary',
      sections: [{ heading: 'Heading', body: 'Body' }],
      claimMap: [
        {
          claimRevisionId: '018f3b76-2000-7000-8000-000000000011',
          statement: 'Statement',
          evidenceSourceIds: ['018f3b76-2000-7000-8000-000000000012'],
        },
      ],
      disclosure: 'Disclosure',
    };
    const gateway = createTenantDataBrokerClientGateway({
      issuer: createIssuer(),
      client: { invoke: vi.fn<TenantDataBrokerClientInvoker['invoke']>() },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    const prepared = gateway.prepareArtifactPayload({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      artifactId,
      revision: 1,
      contentHash,
      payload,
    });
    const expectedBody = new TextEncoder().encode(canonicalArtifactJson(payload));
    expect(prepared).toEqual({
      kind: 'ARTIFACT_PAYLOAD',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      objectKey:
        `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/${artifactId}/` +
        `revisions/1/${contentHash}.json`,
      canonicalPayload: expectedBody,
      checksum: sha256(expectedBody),
      contentType: 'application/json',
      byteLength: expectedBody.byteLength,
    });
  });

  test('prepares a canonical Channel Package at its checksum-bound key', () => {
    const packageChecksum = 'b'.repeat(64);
    const payload = {
      files: {
        'content.md': '# Package',
        'content.html': '<h1>Package</h1>',
        'structured-data.json': '{"@type":"Product"}',
      },
    };
    const gateway = createTenantDataBrokerClientGateway({
      issuer: createIssuer(),
      client: { invoke: vi.fn<TenantDataBrokerClientInvoker['invoke']>() },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    const prepared = gateway.prepareChannelPackage({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      packageChecksum,
      payload,
    });
    const expectedBody = new TextEncoder().encode(canonicalArtifactJson(payload));
    expect(prepared).toEqual({
      kind: 'CHANNEL_PACKAGE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      objectKey:
        `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/channel-packages/` +
        `${packageChecksum}.json`,
      canonicalPayload: expectedBody,
      checksum: sha256(expectedBody),
      contentType: 'application/json',
      byteLength: expectedBody.byteLength,
    });
  });

  test('prepares a crawl snapshot only when its scoped key and body hash agree', () => {
    const body = new TextEncoder().encode('{"url":"https://example.com"}');
    const checksum = sha256(body);
    const siteId = '018f3b76-2000-7000-8000-000000000023';
    const key =
      `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/sites/${siteId}/` + `snapshots/${checksum}`;
    const gateway = createTenantDataBrokerClientGateway({
      issuer: createIssuer(),
      client: { invoke: vi.fn<TenantDataBrokerClientInvoker['invoke']>() },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    expect(
      gateway.prepareCrawlSnapshot({
        key,
        body,
        contentType: 'application/json',
        checksum,
      }),
    ).toEqual({
      kind: 'CRAWL_SNAPSHOT',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      objectKey: key,
      canonicalPayload: body,
      checksum,
      contentType: 'application/json',
      byteLength: body.byteLength,
    });
  });

  test('fails closed for legacy objectRef-only reads that carry no authority source', async () => {
    const gateway = createTenantDataBrokerClientGateway({
      issuer: createIssuer(),
      client: { invoke: vi.fn<TenantDataBrokerClientInvoker['invoke']>() },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });
    const objectRef =
      `s3://${WORKLOAD_BUCKET}/tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/` +
      `channel-packages/${'a'.repeat(64)}.json?versionId=v1`;

    await expect(gateway.get(objectRef)).rejects.toThrow('TENANT_DATA_AUTHORITY_REQUIRED');
    await expect(gateway.getChannelPackage(objectRef)).rejects.toThrow(
      'TENANT_DATA_AUTHORITY_REQUIRED',
    );
  });

  test('writes a workload version only through an issued capability and the Broker client', async () => {
    const canonicalPayload = new TextEncoder().encode('{"title":"fixture"}');
    const checksum = sha256(canonicalPayload);
    const objectKey =
      `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/` +
      `018f3b76-2000-7000-8000-000000000007/revisions/1/${'a'.repeat(64)}.json`;
    const issuer = createIssuer();
    issuer.issueWorkloadObjectPut.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const invoke = vi.fn<TenantDataBrokerClientInvoker['invoke']>(async (_command, input) => {
      await expect(consume(input.body)).resolves.toEqual(canonicalPayload);
      return {
        bucket: WORKLOAD_BUCKET,
        key: objectKey,
        versionId: 'version/one',
        checksum,
        contentType: 'application/json',
        byteLength: canonicalPayload.byteLength,
      };
    });
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.putAuthorizedWorkloadVersion(
        {
          kind: 'ARTIFACT_PAYLOAD',
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          objectKey,
          canonicalPayload,
          checksum,
          contentType: 'application/json',
          byteLength: canonicalPayload.byteLength,
        },
        { operationId: OPERATION_ID, leaseToken: LEASE_TOKEN },
      ),
    ).resolves.toEqual({
      kind: 'ARTIFACT_PAYLOAD',
      objectClass: 'ARTIFACT_PAYLOAD',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      objectRef: `s3://${WORKLOAD_BUCKET}/${objectKey}?versionId=version%2Fone`,
      objectKey,
      objectVersionId: 'version/one',
      checksum,
      contentType: 'application/json',
      byteLength: canonicalPayload.byteLength,
      createdAt: NOW.toISOString(),
    });
    expect(issuer.issueWorkloadObjectPut).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      leaseToken: LEASE_TOKEN,
      capabilityId: CANDIDATE_CAPABILITY_ID,
    });
    expect(invoke).toHaveBeenCalledWith(
      {
        capabilityId: ISSUED_CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: OPERATION_ID,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'PUT_WORKLOAD_OBJECT',
      },
      expect.objectContaining({
        payloadLength: canonicalPayload.byteLength,
        payloadSha256: checksum,
        deadline: new Date('2026-07-23T20:00:05.000Z'),
      }),
    );
    expect(invoke.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  test('recovers an ambiguous workload write through a metadata-only HEAD capability', async () => {
    const canonicalPayload = new TextEncoder().encode('{"title":"fixture"}');
    const checksum = sha256(canonicalPayload);
    const objectKey =
      `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/channel-packages/` +
      `${'b'.repeat(64)}.json`;
    const issuer = createIssuer();
    issuer.issueWorkloadObjectRecoveryHead.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const invoke = vi.fn<TenantDataBrokerClientInvoker['invoke']>(async (_command, input) => {
      await expect(consume(input.body)).resolves.toEqual(new Uint8Array());
      return {
        kind: 'OBJECT_HEAD',
        exists: true,
        bucket: WORKLOAD_BUCKET,
        key: objectKey,
        versionId: 'recovered-version',
        checksum,
        contentType: 'application/json',
        byteLength: canonicalPayload.byteLength,
      };
    });
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.recoverAuthorizedWorkloadVersion(
        {
          kind: 'CHANNEL_PACKAGE',
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          objectKey,
          checksum,
          contentType: 'application/json',
          byteLength: canonicalPayload.byteLength,
        },
        { operationId: OPERATION_ID, leaseToken: LEASE_TOKEN },
      ),
    ).resolves.toEqual({
      outcome: 'FOUND',
      object: {
        kind: 'CHANNEL_PACKAGE',
        objectClass: 'CHANNEL_PACKAGE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        objectRef: `s3://${WORKLOAD_BUCKET}/${objectKey}?versionId=recovered-version`,
        objectKey,
        objectVersionId: 'recovered-version',
        checksum,
        contentType: 'application/json',
        byteLength: canonicalPayload.byteLength,
        createdAt: NOW.toISOString(),
      },
    });
    expect(issuer.issueWorkloadObjectRecoveryHead).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      leaseToken: LEASE_TOKEN,
      capabilityId: CANDIDATE_CAPABILITY_ID,
    });
    expect(invoke).toHaveBeenCalledWith(
      {
        capabilityId: ISSUED_CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: OPERATION_ID,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'HEAD_WORKLOAD_OBJECT',
      },
      expect.objectContaining({
        payloadLength: 0,
        payloadSha256: sha256(new Uint8Array()),
      }),
    );
  });

  test('reports a failed recovery probe without adopting any object version', async () => {
    const issuer = createIssuer();
    issuer.issueWorkloadObjectRecoveryHead.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: {
        invoke: vi.fn<TenantDataBrokerClientInvoker['invoke']>(() =>
          Promise.reject(new Error('TENANT_DATA_EFFECT_FAILED')),
        ),
      },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.recoverAuthorizedWorkloadVersion(
        {
          kind: 'CRAWL_SNAPSHOT',
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          objectKey: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/sites/fixture/snapshots/${'c'.repeat(64)}`,
          checksum: 'c'.repeat(64),
          contentType: 'application/json',
          byteLength: 42,
        },
        { operationId: OPERATION_ID, leaseToken: LEASE_TOKEN },
      ),
    ).resolves.toEqual({ outcome: 'FAILED' });
  });

  test('keeps an unresolved recovery probe explicitly unknown', async () => {
    const issuer = createIssuer();
    issuer.issueWorkloadObjectRecoveryHead.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: {
        invoke: vi.fn<TenantDataBrokerClientInvoker['invoke']>(() =>
          Promise.reject(new Error('TENANT_DATA_EFFECT_OUTCOME_UNKNOWN')),
        ),
      },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.recoverAuthorizedWorkloadVersion(
        {
          kind: 'CRAWL_SNAPSHOT',
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          objectKey: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/sites/fixture/snapshots/${'c'.repeat(64)}`,
          checksum: 'c'.repeat(64),
          contentType: 'application/json',
          byteLength: 42,
        },
        { operationId: OPERATION_ID, leaseToken: LEASE_TOKEN },
      ),
    ).resolves.toEqual({ outcome: 'UNKNOWN' });
  });

  test('reads an Artifact revision with the raw session proof and returned authenticated capability', async () => {
    const contentHash = 'd'.repeat(64);
    const artifactId = '018f3b76-2000-7000-8000-000000000009';
    const artifactRevisionId = '018f3b76-2000-7000-8000-000000000010';
    const claimRevisionId = '018f3b76-2000-7000-8000-000000000011';
    const evidenceSourceId = '018f3b76-2000-7000-8000-000000000012';
    const objectKey =
      `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/${artifactId}/` +
      `revisions/1/${contentHash}.json`;
    const versionId = 'artifact-v1';
    const objectRef = `s3://${WORKLOAD_BUCKET}/${objectKey}?versionId=${versionId}`;
    const payload = {
      title: 'Fixture title',
      summary: 'Fixture summary',
      sections: [{ heading: 'Heading', body: 'Body' }],
      claimMap: [
        {
          claimRevisionId,
          statement: 'Supported statement',
          evidenceSourceIds: [evidenceSourceId],
        },
      ],
      disclosure: 'Fixture disclosure',
    };
    const bytes = new TextEncoder().encode(canonicalArtifactJson(payload));
    const issuer = createIssuer();
    issuer.issueAuthenticatedObjectRead.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const invoke = vi.fn<TenantDataBrokerClientInvoker['invoke']>(() =>
      Promise.resolve({
        kind: 'OBJECT_STREAM',
        bucket: WORKLOAD_BUCKET,
        key: objectKey,
        versionId,
        checksum: sha256(bytes),
        contentType: 'application/json',
        byteLength: bytes.byteLength,
        transportChecksumSha256: 'transport-checksum',
        body: chunks(bytes),
      }),
    );
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.readAuthenticatedArtifactRevision({
        sessionToken: SESSION_TOKEN,
        context: {
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          actorUserId: '018f3b76-2000-7000-8000-000000000013',
          membershipId: MEMBERSHIP_ID,
          role: 'OWNER',
        },
        authority: { kind: 'ARTIFACT_REVISION', artifactRevisionId },
        expected: { objectRef, contentHash },
      }),
    ).resolves.toEqual(payload);
    expect(issuer.issueAuthenticatedObjectRead).toHaveBeenCalledWith({
      sessionToken: SESSION_TOKEN,
      membershipId: MEMBERSHIP_ID,
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      objectKey,
      objectVersionId: versionId,
      leaseToken: CANDIDATE_CAPABILITY_ID,
      capabilityId: CANDIDATE_CAPABILITY_ID,
    });
    const issuedLeaseToken = issuer.issueAuthenticatedObjectRead.mock.calls[0]?.[0].leaseToken;
    expect(invoke).toHaveBeenCalledWith(
      {
        capabilityId: ISSUED_CAPABILITY_ID,
        leaseToken: issuedLeaseToken,
        authorityReference: ISSUED_CAPABILITY_ID,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'READ_WORKLOAD_OBJECT',
      },
      expect.objectContaining({
        payloadLength: 0,
        payloadSha256: sha256(new Uint8Array()),
      }),
    );
  });

  test('rejects a foreign-bucket authenticated object reference before capability issuance', async () => {
    const contentHash = 'd'.repeat(64);
    const objectKey =
      `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/` +
      `018f3b76-2000-7000-8000-000000000009/revisions/1/${contentHash}.json`;
    const issuer = createIssuer();
    issuer.issueAuthenticatedObjectRead.mockResolvedValue(null);
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke: vi.fn<TenantDataBrokerClientInvoker['invoke']>() },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.readAuthenticatedArtifactRevision({
        sessionToken: SESSION_TOKEN,
        context: {
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          actorUserId: '018f3b76-2000-7000-8000-000000000013',
          membershipId: MEMBERSHIP_ID,
          role: 'OWNER',
        },
        authority: {
          kind: 'ARTIFACT_REVISION',
          artifactRevisionId: '018f3b76-2000-7000-8000-000000000010',
        },
        expected: {
          objectRef: `s3://attacker-controlled-bucket/${objectKey}?versionId=artifact-v1`,
          contentHash,
        },
      }),
    ).rejects.toThrow('TENANT_DATA_BROKER_OBJECT_REFERENCE_INVALID');
    expect(issuer.issueAuthenticatedObjectRead).not.toHaveBeenCalled();
  });

  test('reads a canonical Channel Package payload through authenticated Broker access', async () => {
    const packageChecksum = 'e'.repeat(64);
    const packageId = '018f3b76-2000-7000-8000-000000000014';
    const objectKey =
      `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/channel-packages/` +
      `${packageChecksum}.json`;
    const versionId = 'package-v1';
    const payload = {
      files: {
        'content.md': '# Fixture',
        'content.html': '<h1>Fixture</h1>',
        'structured-data.json': '{"@type":"Product"}',
      },
    };
    const bytes = new TextEncoder().encode(canonicalArtifactJson(payload));
    const issuer = createIssuer();
    issuer.issueAuthenticatedObjectRead.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: {
        invoke: vi.fn<TenantDataBrokerClientInvoker['invoke']>(() =>
          Promise.resolve({
            kind: 'OBJECT_STREAM',
            bucket: WORKLOAD_BUCKET,
            key: objectKey,
            versionId,
            checksum: sha256(bytes),
            contentType: 'application/json',
            byteLength: bytes.byteLength,
            transportChecksumSha256: 'transport-checksum',
            body: chunks(bytes.subarray(0, 7), bytes.subarray(7)),
          }),
        ),
      },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.readAuthenticatedChannelPackage({
        sessionToken: SESSION_TOKEN,
        context: {
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          actorUserId: '018f3b76-2000-7000-8000-000000000013',
          membershipId: MEMBERSHIP_ID,
          role: 'EDITOR',
        },
        authority: { kind: 'CHANNEL_PACKAGE', packageId },
        expected: {
          objectRef: `s3://${WORKLOAD_BUCKET}/${objectKey}?versionId=${versionId}`,
          packageChecksum,
        },
      }),
    ).resolves.toEqual(payload);
  });

  test('reads the package bound to an active publication lease', async () => {
    const publicationId = '018f3b76-2000-7000-8000-000000000015';
    const packageChecksum = 'f'.repeat(64);
    const objectKey =
      `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/channel-packages/` +
      `${packageChecksum}.json`;
    const versionId = 'publication-package-v1';
    const objectRef = `s3://${WORKLOAD_BUCKET}/${objectKey}?versionId=${versionId}`;
    const payload = {
      files: {
        'content.md': '# Publication',
        'content.html': '<h1>Publication</h1>',
        'structured-data.json': '{"@type":"Article"}',
      },
    };
    const bytes = new TextEncoder().encode(canonicalArtifactJson(payload));
    const issuer = createIssuer();
    issuer.issuePublicationPackageRead.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const invoke = vi.fn<TenantDataBrokerClientInvoker['invoke']>(() =>
      Promise.resolve({
        kind: 'OBJECT_STREAM',
        bucket: WORKLOAD_BUCKET,
        key: objectKey,
        versionId,
        checksum: sha256(bytes),
        contentType: 'application/json',
        byteLength: bytes.byteLength,
        transportChecksumSha256: 'transport-checksum',
        body: chunks(bytes),
      }),
    );
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.readPublicationPackage({
        access: { publicationId, leaseToken: LEASE_TOKEN },
        expected: {
          objectRef,
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          packageChecksum,
        },
      }),
    ).resolves.toEqual(payload);
    expect(issuer.issuePublicationPackageRead).toHaveBeenCalledWith({
      publicationId,
      leaseToken: LEASE_TOKEN,
      capabilityId: CANDIDATE_CAPABILITY_ID,
    });
    expect(invoke).toHaveBeenCalledWith(
      {
        capabilityId: ISSUED_CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: publicationId,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'READ_WORKLOAD_OBJECT',
      },
      expect.objectContaining({
        payloadLength: 0,
        payloadSha256: sha256(new Uint8Array()),
      }),
    );
  });

  test('reads a connector secret only from the active publication authority', async () => {
    const publicationId = '018f3b76-2000-7000-8000-000000000015';
    const secretReference =
      `arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:` +
      `tenant-${TENANT_ID}/workspace-${WORKSPACE_ID}/connector-AbCdEf`;
    const issuer = createIssuer();
    issuer.issuePublicationSecretRead.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const invoke = vi.fn<TenantDataBrokerClientInvoker['invoke']>(() =>
      Promise.resolve({
        kind: 'SECRET_VALUE',
        value: '{"accessToken":"broker-only"}',
      }),
    );
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.readPublicationSecret({
        access: { publicationId, leaseToken: LEASE_TOKEN },
        expected: {
          secretReference,
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
        },
      }),
    ).resolves.toBe('{"accessToken":"broker-only"}');
    expect(issuer.issuePublicationSecretRead).toHaveBeenCalledWith({
      publicationId,
      leaseToken: LEASE_TOKEN,
      capabilityId: CANDIDATE_CAPABILITY_ID,
    });
    expect(invoke).toHaveBeenCalledWith(
      {
        capabilityId: ISSUED_CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: publicationId,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'READ_CONNECTOR_SECRET',
      },
      expect.objectContaining({
        payloadLength: 0,
        payloadSha256: sha256(new Uint8Array()),
      }),
    );
  });

  test('reads a connector secret only from the leased authorization-validation command', async () => {
    const commandId = '018f3b76-2000-7000-8000-000000000016';
    const authorizationId = '018f3b76-2000-7000-8000-000000000017';
    const secretReference =
      `arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:` +
      `tenant-${TENANT_ID}/workspace-${WORKSPACE_ID}/connector-validation`;
    const issuer = createIssuer();
    issuer.issueChannelAuthorizationValidationSecretRead.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const invoke = vi.fn<TenantDataBrokerClientInvoker['invoke']>(() =>
      Promise.resolve({
        kind: 'SECRET_VALUE',
        value: '{"accessToken":"validation-only"}',
      }),
    );
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.readValidationSecret({
        access: { commandId, authorizationId, leaseToken: LEASE_TOKEN },
        expected: {
          secretReference,
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
        },
      }),
    ).resolves.toBe('{"accessToken":"validation-only"}');
    expect(issuer.issueChannelAuthorizationValidationSecretRead).toHaveBeenCalledWith({
      commandId,
      authorizationId,
      leaseToken: LEASE_TOKEN,
      capabilityId: CANDIDATE_CAPABILITY_ID,
    });
    expect(invoke).toHaveBeenCalledWith(
      {
        capabilityId: ISSUED_CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: authorizationId,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'READ_CONNECTOR_SECRET',
      },
      expect.objectContaining({
        payloadLength: 0,
        payloadSha256: sha256(new Uint8Array()),
      }),
    );
  });

  test('reads an exact tenant export version with tenant-scoped authenticated authority', async () => {
    const tenantExportsBucket = 'aeostudio-staging-tenant-exports';
    const exportId = '018f3b76-2000-7000-8000-000000000016';
    const objectKey = `tenants/${TENANT_ID}/exports/${exportId}.bundle.json`;
    const versionId = 'export-v1';
    const body = new TextEncoder().encode('{"files":[]}');
    const checksum = sha256(body);
    const objectRef = `s3://${tenantExportsBucket}/${objectKey}?versionId=${versionId}`;
    const issuer = createIssuer();
    issuer.issueAuthenticatedObjectRead.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const invoke = vi.fn<TenantDataBrokerClientInvoker['invoke']>(() =>
      Promise.resolve({
        kind: 'OBJECT_STREAM',
        bucket: tenantExportsBucket,
        key: objectKey,
        versionId,
        checksum,
        contentType: 'application/json',
        byteLength: body.byteLength,
        transportChecksumSha256: 'transport-checksum',
        body: chunks(body),
      }),
    );
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: tenantExportsBucket,
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.readAuthenticatedTenantExportArchive({
        sessionToken: SESSION_TOKEN,
        context: {
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          actorUserId: '018f3b76-2000-7000-8000-000000000013',
          membershipId: MEMBERSHIP_ID,
          role: 'OWNER',
        },
        authority: { kind: 'TENANT_EXPORT', exportId },
        expected: {
          objectRef,
          objectKey,
          objectVersionId: versionId,
          checksum,
        },
      }),
    ).resolves.toEqual({
      body,
      object: {
        tenantId: TENANT_ID,
        objectRef,
        objectKey,
        objectVersionId: versionId,
        checksum,
      },
    });
    const issuedLeaseToken = issuer.issueAuthenticatedObjectRead.mock.calls[0]?.[0].leaseToken;
    expect(invoke).toHaveBeenCalledWith(
      {
        capabilityId: ISSUED_CAPABILITY_ID,
        leaseToken: issuedLeaseToken,
        authorityReference: ISSUED_CAPABILITY_ID,
        scopeKind: 'TENANT',
        tenantId: TENANT_ID,
        workspaceId: null,
        operation: 'READ_PRIVACY_OBJECT',
      },
      expect.objectContaining({
        payloadLength: 0,
        payloadSha256: sha256(new Uint8Array()),
      }),
    );
  });

  test('writes a privacy object only from its leased database intent', async () => {
    const tenantExportsBucket = 'aeostudio-staging-tenant-exports';
    const operationId = '018f3b76-2000-7000-8000-000000000017';
    const objectKey = `tenants/${TENANT_ID}/exports/${operationId}.bundle.json`;
    const canonicalPayload = new TextEncoder().encode('{"files":[]}');
    const checksum = sha256(canonicalPayload);
    const issuer = createIssuer();
    issuer.issuePrivacyObjectPut.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const invoke = vi.fn<TenantDataBrokerClientInvoker['invoke']>(() =>
      Promise.resolve({
        bucket: tenantExportsBucket,
        key: objectKey,
        versionId: 'privacy-v1',
        checksum,
        contentType: 'application/json',
        byteLength: canonicalPayload.byteLength,
      }),
    );
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: tenantExportsBucket,
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.putAuthorizedPrivacyVersion({
        operationId,
        kind: 'TENANT_EXPORT',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        objectKey,
        canonicalPayload,
        checksum,
        contentType: 'application/json',
        lockedUntil: null,
        sealedAt: null,
        leaseToken: LEASE_TOKEN,
        leaseExpiresAt: '2026-07-23T20:05:00.000Z',
      }),
    ).resolves.toEqual({
      tenantId: TENANT_ID,
      objectRef: `s3://${tenantExportsBucket}/${objectKey}?versionId=privacy-v1`,
      objectKey,
      objectVersionId: 'privacy-v1',
      checksum,
      contentType: 'application/json',
      byteLength: canonicalPayload.byteLength,
      createdAt: NOW.toISOString(),
      lockedUntil: null,
    });
    expect(issuer.issuePrivacyObjectPut).toHaveBeenCalledWith({
      operationId,
      leaseToken: LEASE_TOKEN,
      capabilityId: CANDIDATE_CAPABILITY_ID,
    });
    expect(invoke).toHaveBeenCalledWith(
      {
        capabilityId: ISSUED_CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: operationId,
        scopeKind: 'TENANT',
        tenantId: TENANT_ID,
        workspaceId: null,
        operation: 'PUT_PRIVACY_OBJECT',
      },
      expect.objectContaining({
        payloadLength: canonicalPayload.byteLength,
        payloadSha256: checksum,
      }),
    );
  });

  test('recovers an unknown privacy PUT through the same intent lease', async () => {
    const tenantExportsBucket = 'aeostudio-staging-tenant-exports';
    const operationId = '018f3b76-2000-7000-8000-000000000017';
    const objectKey = `tenants/${TENANT_ID}/exports/${operationId}.bundle.json`;
    const canonicalPayload = new TextEncoder().encode('{"files":[]}');
    const checksum = sha256(canonicalPayload);
    const issuer = createIssuer();
    issuer.issuePrivacyObjectPut.mockResolvedValue(ISSUED_CAPABILITY_ID);
    issuer.issuePrivacyObjectRecoveryHead.mockResolvedValue('018f3b76-2000-7000-8000-000000000022');
    const invoke = vi
      .fn<TenantDataBrokerClientInvoker['invoke']>()
      .mockRejectedValueOnce(new Error('TENANT_DATA_EFFECT_OUTCOME_UNKNOWN'))
      .mockResolvedValueOnce({
        kind: 'OBJECT_HEAD',
        exists: true,
        bucket: tenantExportsBucket,
        key: objectKey,
        versionId: 'privacy-recovered-v1',
        checksum,
        contentType: 'application/json',
        byteLength: canonicalPayload.byteLength,
      });
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: tenantExportsBucket,
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.putAuthorizedPrivacyVersion({
        operationId,
        kind: 'TENANT_EXPORT',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        objectKey,
        canonicalPayload,
        checksum,
        contentType: 'application/json',
        lockedUntil: null,
        sealedAt: null,
        leaseToken: LEASE_TOKEN,
        leaseExpiresAt: '2026-07-23T20:05:00.000Z',
      }),
    ).resolves.toMatchObject({
      objectVersionId: 'privacy-recovered-v1',
      objectRef: `s3://${tenantExportsBucket}/${objectKey}?versionId=privacy-recovered-v1`,
    });
    expect(issuer.issuePrivacyObjectRecoveryHead).toHaveBeenCalledWith({
      operationId,
      leaseToken: LEASE_TOKEN,
      capabilityId: CANDIDATE_CAPABILITY_ID,
    });
    expect(invoke.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        capabilityId: '018f3b76-2000-7000-8000-000000000022',
        authorityReference: operationId,
        operation: 'HEAD_PRIVACY_OBJECT',
      }),
    );
  });

  test('force-deletes a connector secret only from its leased authorization deletion intent', async () => {
    const channelAuthorizationId = '018f3b76-2000-7000-8000-000000000018';
    const secretReference =
      `arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:` +
      `tenant-${TENANT_ID}/workspace-${WORKSPACE_ID}/connector-AbCdEf`;
    const issuer = createIssuer();
    issuer.issueConnectorSecretDelete.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const invoke = vi.fn<TenantDataBrokerClientInvoker['invoke']>(() =>
      Promise.resolve({ kind: 'SECRET_DELETE_RECEIPT', deleted: true }),
    );
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.requestAuthorizedConnectorSecretForceDelete({
        source: { channelAuthorizationId, leaseToken: LEASE_TOKEN },
        expected: {
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          secretReference,
        },
      }),
    ).resolves.toBeUndefined();
    expect(issuer.issueConnectorSecretDelete).toHaveBeenCalledWith({
      channelAuthorizationId,
      leaseToken: LEASE_TOKEN,
      capabilityId: CANDIDATE_CAPABILITY_ID,
    });
    expect(invoke).toHaveBeenCalledWith(
      {
        capabilityId: ISSUED_CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: channelAuthorizationId,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'DELETE_CONNECTOR_SECRET',
      },
      expect.objectContaining({ payloadLength: 0 }),
    );
  });

  test('resolves an unknown connector-secret DELETE only through an authorized DESCRIBE observation', async () => {
    const channelAuthorizationId = '018f3b76-2000-7000-8000-000000000018';
    const describeCandidateCapabilityId = '018f3b76-2000-7000-8000-000000000024';
    const describeCapabilityId = '018f3b76-2000-7000-8000-000000000025';
    const secretReference =
      `arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:` +
      `tenant-${TENANT_ID}/workspace-${WORKSPACE_ID}/connector-AbCdEf`;
    const issueConnectorSecretDescribe = vi.fn(() => Promise.resolve(describeCapabilityId));
    const issuer = {
      ...createIssuer(),
      issueConnectorSecretDescribe,
    };
    issuer.issueConnectorSecretDelete.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const invoke = vi
      .fn<TenantDataBrokerClientInvoker['invoke']>()
      .mockRejectedValueOnce(new Error('TENANT_DATA_EFFECT_OUTCOME_UNKNOWN'))
      .mockResolvedValueOnce({ kind: 'SECRET_DESCRIPTION', exists: false });
    const candidateIds = [CANDIDATE_CAPABILITY_ID, describeCandidateCapabilityId];
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: {
        next: () => {
          const candidateId = candidateIds.shift();
          if (candidateId === undefined) throw new Error('UNEXPECTED_CAPABILITY_ISSUE');
          return candidateId;
        },
      },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.requestAuthorizedConnectorSecretForceDelete({
        source: { channelAuthorizationId, leaseToken: LEASE_TOKEN },
        expected: {
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          secretReference,
        },
      }),
    ).resolves.toBeUndefined();
    expect(issueConnectorSecretDescribe).toHaveBeenCalledWith({
      channelAuthorizationId,
      leaseToken: LEASE_TOKEN,
      capabilityId: describeCandidateCapabilityId,
    });
    expect(invoke.mock.calls[1]?.[0]).toEqual({
      capabilityId: describeCapabilityId,
      leaseToken: LEASE_TOKEN,
      authorityReference: channelAuthorizationId,
      scopeKind: 'WORKSPACE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'DESCRIBE_CONNECTOR_SECRET',
    });
  });

  test('verifies connector-secret unreadability with the same leased deletion source', async () => {
    const channelAuthorizationId = '018f3b76-2000-7000-8000-000000000018';
    const secretReference =
      `arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:` +
      `tenant-${TENANT_ID}/workspace-${WORKSPACE_ID}/connector-AbCdEf`;
    const issuer = createIssuer();
    issuer.issueConnectorSecretVerifyUnreadable.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const invoke = vi.fn<TenantDataBrokerClientInvoker['invoke']>(() =>
      Promise.resolve({ kind: 'CONNECTOR_SECRET_UNREADABLE', unreadable: true }),
    );
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.verifyAuthorizedConnectorSecretUnreadable({
        source: { channelAuthorizationId, leaseToken: LEASE_TOKEN },
        expected: {
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          secretReference,
        },
      }),
    ).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        authorityReference: channelAuthorizationId,
        operation: 'VERIFY_CONNECTOR_SECRET_UNREADABLE',
      }),
      expect.objectContaining({ payloadLength: 0 }),
    );
  });

  test('lists one exact deletion-inventory page from request and lease authority', async () => {
    const requestId = '018f3b76-2000-7000-8000-000000000019';
    const issuer = createIssuer();
    issuer.issueDeletionInventory.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const invoke = vi.fn<TenantDataBrokerClientInvoker['invoke']>(() =>
      Promise.resolve({
        kind: 'OBJECT_VERSION_INVENTORY',
        objectClass: 'TENANT_EXPORTS',
        versions: [
          {
            key: `tenants/${TENANT_ID}/exports/export-one.bundle.json`,
            versionId: 'v1',
            isDeleteMarker: false,
            lastModified: '2026-07-23T19:00:00.000Z',
          },
        ],
        deleteMarkers: [
          {
            key: `tenants/${TENANT_ID}/exports/export-two.bundle.json`,
            versionId: 'delete-v1',
            isDeleteMarker: true,
          },
        ],
        isTruncated: true,
        nextCursor: {
          keyMarker: `tenants/${TENANT_ID}/exports/export-two.bundle.json`,
          versionIdMarker: 'delete-v1',
        },
      }),
    );
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    const page = await gateway.listAuthorizedObjectVersions({
      source: { requestId, leaseToken: LEASE_TOKEN },
      expected: {
        tenantId: TENANT_ID,
        scopeKind: 'TENANT',
        workspaceId: null,
        objectClass: 'TENANT_EXPORTS',
      },
    });
    expect(page.versions).toEqual([
      {
        objectKey: `tenants/${TENANT_ID}/exports/export-one.bundle.json`,
        objectVersionId: 'v1',
        createdAt: '2026-07-23T19:00:00.000Z',
      },
      {
        objectKey: `tenants/${TENANT_ID}/exports/export-two.bundle.json`,
        objectVersionId: 'delete-v1',
        isDeleteMarker: true,
      },
    ]);
    expect(decodeCursor(page.nextCursor)).toEqual({
      keyMarker: `tenants/${TENANT_ID}/exports/export-two.bundle.json`,
      versionIdMarker: 'delete-v1',
    });
    expect(issuer.issueDeletionInventory).toHaveBeenCalledWith({
      requestId,
      leaseToken: LEASE_TOKEN,
      capabilityId: CANDIDATE_CAPABILITY_ID,
    });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        authorityReference: requestId,
        scopeKind: 'TENANT',
        tenantId: TENANT_ID,
        workspaceId: null,
        operation: 'LIST_TENANT_OBJECT_VERSIONS',
      }),
      expect.objectContaining({ payloadLength: 0 }),
    );
  });

  test('deletes an exact workload version only from the deletion request lease', async () => {
    const requestId = '018f3b76-2000-7000-8000-000000000019';
    const objectKey =
      `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/` +
      `018f3b76-2000-7000-8000-000000000020/revisions/1/${'a'.repeat(64)}.json`;
    const issuer = createIssuer();
    issuer.issueDeletionObjectDelete.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const invoke = vi.fn<TenantDataBrokerClientInvoker['invoke']>(() =>
      Promise.resolve({
        kind: 'OBJECT_VERSION_DELETED',
        bucket: WORKLOAD_BUCKET,
        key: objectKey,
        versionId: 'delete-exact-v1',
        isDeleteMarker: false,
      }),
    );
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.deleteAuthorizedObjectVersion({
        source: { requestId, leaseToken: LEASE_TOKEN },
        expected: {
          tenantId: TENANT_ID,
          scopeKind: 'WORKSPACE',
          workspaceId: WORKSPACE_ID,
          objectClass: 'WORKLOAD_OBJECTS',
          objectKey,
          objectVersionId: 'delete-exact-v1',
          isDeleteMarker: false,
        },
      }),
    ).resolves.toBe('DELETED');
    expect(issuer.issueDeletionObjectDelete).toHaveBeenCalledWith({
      requestId,
      leaseToken: LEASE_TOKEN,
      capabilityId: CANDIDATE_CAPABILITY_ID,
      objectKey,
      objectVersionId: 'delete-exact-v1',
    });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        authorityReference: requestId,
        scopeKind: 'WORKSPACE',
        workspaceId: WORKSPACE_ID,
        operation: 'DELETE_WORKLOAD_OBJECT_VERSION',
      }),
      expect.objectContaining({ payloadLength: 0 }),
    );
  });

  test('heads an exact deletion candidate without deriving authority from its object key', async () => {
    const requestId = '018f3b76-2000-7000-8000-000000000019';
    const objectKey = `tenants/${TENANT_ID}/exports/export-one.bundle.json`;
    const issuer = createIssuer();
    issuer.issueDeletionObjectHead.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const invoke = vi.fn<TenantDataBrokerClientInvoker['invoke']>(() =>
      Promise.resolve({
        kind: 'OBJECT_HEAD',
        exists: false,
        bucket: 'aeostudio-staging-tenant-exports',
        key: objectKey,
        versionId: 'export-v1',
      }),
    );
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.headAuthorizedDeletionObject({
        source: { requestId, leaseToken: LEASE_TOKEN },
        expected: {
          tenantId: TENANT_ID,
          scopeKind: 'TENANT',
          workspaceId: null,
          objectClass: 'TENANT_EXPORTS',
          objectKey,
          objectVersionId: 'export-v1',
        },
      }),
    ).resolves.toEqual({ exists: false });
    expect(issuer.issueDeletionObjectHead).toHaveBeenCalledWith({
      requestId,
      leaseToken: LEASE_TOKEN,
      capabilityId: CANDIDATE_CAPABILITY_ID,
      objectKey,
      objectVersionId: 'export-v1',
    });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        authorityReference: requestId,
        scopeKind: 'TENANT',
        operation: 'HEAD_PRIVACY_OBJECT',
      }),
      expect.objectContaining({ payloadLength: 0 }),
    );
  });

  test('gets legal-hold status only for the deletion request exact version', async () => {
    const requestId = '018f3b76-2000-7000-8000-000000000019';
    const objectKey = `tenants/${TENANT_ID}/exports/export-one.bundle.json`;
    const issuer = createIssuer();
    issuer.issueDeletionObjectGetLegalHold.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const invoke = vi.fn<TenantDataBrokerClientInvoker['invoke']>(() =>
      Promise.resolve({
        kind: 'OBJECT_LEGAL_HOLD',
        bucket: 'aeostudio-staging-tenant-exports',
        expectedBucketOwner: '123456789012',
        key: objectKey,
        versionId: 'export-v1',
        status: 'ON',
      }),
    );
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      expectedBucketOwner: '123456789012',
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.getAuthorizedDeletionObjectLegalHold({
        source: { requestId, leaseToken: LEASE_TOKEN },
        expected: {
          tenantId: TENANT_ID,
          scopeKind: 'TENANT',
          workspaceId: null,
          objectClass: 'TENANT_EXPORTS',
          objectKey,
          objectVersionId: 'export-v1',
        },
      }),
    ).resolves.toBe('ON');
    expect(issuer.issueDeletionObjectGetLegalHold).toHaveBeenCalledWith({
      requestId,
      leaseToken: LEASE_TOKEN,
      capabilityId: CANDIDATE_CAPABILITY_ID,
      objectKey,
      objectVersionId: 'export-v1',
    });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        authorityReference: requestId,
        operation: 'GET_OBJECT_LEGAL_HOLD',
      }),
      expect.objectContaining({ payloadLength: 0 }),
    );
  });

  test('sets the desired legal hold from the leased reconciliation source', async () => {
    const objectKey = `tenants/${TENANT_ID}/exports/export-one.bundle.json`;
    const sourceReference = createHash('sha256')
      .update(
        canonicalArtifactJson({
          tenantId: TENANT_ID,
          key: objectKey,
          versionId: 'export-v1',
        }),
        'utf8',
      )
      .digest('hex');
    const issuer = createIssuer();
    issuer.issueLegalHoldSet.mockResolvedValue(ISSUED_CAPABILITY_ID);
    const invoke = vi.fn<TenantDataBrokerClientInvoker['invoke']>(() =>
      Promise.resolve({
        kind: 'OBJECT_LEGAL_HOLD_SET',
        bucket: 'aeostudio-staging-tenant-exports',
        expectedBucketOwner: '123456789012',
        key: objectKey,
        versionId: 'export-v1',
        status: 'ON',
        revision: 3,
      }),
    );
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      expectedBucketOwner: '123456789012',
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.reconcileAuthorizedObjectLegalHold({
        source: {
          tenantId: TENANT_ID,
          objectKey,
          objectVersionId: 'export-v1',
          leaseToken: LEASE_TOKEN,
        },
        expected: {
          scopeKind: 'TENANT',
          workspaceId: null,
          objectClass: 'TENANT_EXPORTS',
          desiredStatus: 'ON',
          revision: 3,
        },
      }),
    ).resolves.toBe(true);
    expect(issuer.issueLegalHoldSet).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      objectKey,
      objectVersionId: 'export-v1',
      leaseToken: LEASE_TOKEN,
      capabilityId: CANDIDATE_CAPABILITY_ID,
    });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        authorityReference: sourceReference,
        scopeKind: 'TENANT',
        operation: 'SET_OBJECT_LEGAL_HOLD',
      }),
      expect.objectContaining({ payloadLength: 0 }),
    );
  });

  test('resolves an unknown legal-hold SET with a capability-bound GET probe', async () => {
    const objectKey = `tenants/${TENANT_ID}/exports/export-one.bundle.json`;
    const issuer = createIssuer();
    issuer.issueLegalHoldSet.mockResolvedValue(ISSUED_CAPABILITY_ID);
    issuer.issueLegalHoldGetRecovery.mockResolvedValue('018f3b76-2000-7000-8000-000000000021');
    const invoke = vi
      .fn<TenantDataBrokerClientInvoker['invoke']>()
      .mockRejectedValueOnce(new Error('TENANT_DATA_EFFECT_OUTCOME_UNKNOWN'))
      .mockResolvedValueOnce({
        kind: 'OBJECT_LEGAL_HOLD',
        bucket: 'aeostudio-staging-tenant-exports',
        expectedBucketOwner: '123456789012',
        key: objectKey,
        versionId: 'export-v1',
        status: 'OFF',
      });
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client: { invoke },
      ids: { next: () => CANDIDATE_CAPABILITY_ID },
      clock: { now: () => new Date(NOW) },
      buckets: {
        workload: WORKLOAD_BUCKET,
        tenantExports: 'aeostudio-staging-tenant-exports',
      },
      expectedBucketOwner: '123456789012',
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.reconcileAuthorizedObjectLegalHold({
        source: {
          tenantId: TENANT_ID,
          objectKey,
          objectVersionId: 'export-v1',
          leaseToken: LEASE_TOKEN,
        },
        expected: {
          scopeKind: 'TENANT',
          workspaceId: null,
          objectClass: 'TENANT_EXPORTS',
          desiredStatus: 'OFF',
          revision: 4,
        },
      }),
    ).resolves.toBe(true);
    expect(issuer.issueLegalHoldGetRecovery).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      objectKey,
      objectVersionId: 'export-v1',
      leaseToken: LEASE_TOKEN,
      capabilityId: CANDIDATE_CAPABILITY_ID,
    });
    expect(invoke.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        capabilityId: '018f3b76-2000-7000-8000-000000000021',
        operation: 'GET_OBJECT_LEGAL_HOLD',
      }),
    );
  });
});

function createIssuer() {
  return {
    issueAuthenticatedObjectRead:
      vi.fn<TenantDataBrokerClientCapabilityIssuer['issueAuthenticatedObjectRead']>(),
    issueWorkloadObjectPut:
      vi.fn<TenantDataBrokerClientCapabilityIssuer['issueWorkloadObjectPut']>(),
    issuePublicationPackageRead:
      vi.fn<TenantDataBrokerClientCapabilityIssuer['issuePublicationPackageRead']>(),
    issuePublicationSecretRead:
      vi.fn<TenantDataBrokerClientCapabilityIssuer['issuePublicationSecretRead']>(),
    issueChannelAuthorizationValidationSecretRead:
      vi.fn<
        TenantDataBrokerClientCapabilityIssuer['issueChannelAuthorizationValidationSecretRead']
      >(),
    issuePrivacyObjectPut: vi.fn<TenantDataBrokerClientCapabilityIssuer['issuePrivacyObjectPut']>(),
    issuePrivacyObjectRecoveryHead:
      vi.fn<TenantDataBrokerClientCapabilityIssuer['issuePrivacyObjectRecoveryHead']>(),
    issueWorkloadObjectRecoveryHead:
      vi.fn<TenantDataBrokerClientCapabilityIssuer['issueWorkloadObjectRecoveryHead']>(),
    issueConnectorSecretDescribe:
      vi.fn<TenantDataBrokerClientCapabilityIssuer['issueConnectorSecretDescribe']>(),
    issueConnectorSecretDelete:
      vi.fn<TenantDataBrokerClientCapabilityIssuer['issueConnectorSecretDelete']>(),
    issueConnectorSecretVerifyUnreadable:
      vi.fn<TenantDataBrokerClientCapabilityIssuer['issueConnectorSecretVerifyUnreadable']>(),
    issueDeletionInventory:
      vi.fn<TenantDataBrokerClientCapabilityIssuer['issueDeletionInventory']>(),
    issueDeletionObjectHead:
      vi.fn<TenantDataBrokerClientCapabilityIssuer['issueDeletionObjectHead']>(),
    issueDeletionObjectGetLegalHold:
      vi.fn<TenantDataBrokerClientCapabilityIssuer['issueDeletionObjectGetLegalHold']>(),
    issueDeletionObjectDelete:
      vi.fn<TenantDataBrokerClientCapabilityIssuer['issueDeletionObjectDelete']>(),
    issueLegalHoldSet: vi.fn<TenantDataBrokerClientCapabilityIssuer['issueLegalHoldSet']>(),
    issueLegalHoldGetRecovery:
      vi.fn<TenantDataBrokerClientCapabilityIssuer['issueLegalHoldGetRecovery']>(),
  };
}

async function consume(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      for (const value of values) yield value;
    },
  };
}

function decodeCursor(value: string | null): unknown {
  if (value === null) return null;
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
}
