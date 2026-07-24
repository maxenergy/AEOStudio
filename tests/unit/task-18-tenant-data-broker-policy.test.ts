import {
  TenantDataBrokerAuthorizer,
  type TenantDataAccessAuthority,
  type TenantDataAccessGrant,
} from '@aeostudio/application/tenant-data-access';
import { describe, expect, test, vi } from 'vitest';

const CAPABILITY_ID = '018f3b76-1000-7000-8000-000000000001';
const LEASE_TOKEN = '018f3b76-1000-7000-8000-000000000002';
const LEASE_TOKEN_SHA256 = '33246a3e70a81a58720ac80b2f704e0d56b7d39ffa47acd1bfc0da4a30dbfb08';
const TENANT_ID = '018f3b76-1000-7000-8000-000000000003';
const WORKSPACE_ID = '018f3b76-1000-7000-8000-000000000004';
const AUTHORIZATION_ID = '018f3b76-1000-7000-8000-000000000005';
const SECRET_REFERENCE =
  'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:' +
  `tenant-${TENANT_ID}/workspace-${WORKSPACE_ID}/connector`;
const NOW = new Date('2026-07-23T07:00:00.000Z');

describe('Task 18 authoritative tenant data broker policy', () => {
  test('derives every PUT coordinate and integrity fence from an operation-specific authority grant', async () => {
    const resource = {
      kind: 'WORKLOAD_OBJECT_PUT',
      objectClass: 'WORKLOAD_OBJECTS',
      bucket: 'aeostudio-workload-prod',
      key: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/exact.json`,
      checksumSha256: 'a'.repeat(64),
      contentType: 'application/json',
      byteLength: 128,
      lockedUntil: null,
      sealedAt: null,
    } as const;
    const grant = {
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: LEASE_TOKEN_SHA256,
      authorityKind: 'WORKLOAD_WRITE_INTENT',
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'PUT_WORKLOAD_OBJECT',
      resource,
      expiresAt: '2026-07-23T07:01:00.000Z',
    } as unknown as TenantDataAccessGrant;
    const authorizer = new TenantDataBrokerAuthorizer(
      { loadActiveGrant: () => Promise.resolve(grant) },
      { now: () => NOW },
    );

    const authorization = await authorizer.authorize({
      capabilityId: CAPABILITY_ID,
      leaseToken: LEASE_TOKEN,
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'PUT_WORKLOAD_OBJECT',
    });

    expect(authorization).toMatchObject({
      outcome: 'AUTHORIZED',
      grant: {
        operation: 'PUT_WORKLOAD_OBJECT',
        resource,
      },
    });
    expect(authorization.outcome).toBe('AUTHORIZED');
    if (authorization.outcome === 'AUTHORIZED') {
      expect(authorization.audit.resourceReferenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  test.each([
    ['zero-byte object', { resource: { byteLength: 0 } }],
    [
      'cross-Tenant key',
      {
        resource: {
          key:
            'tenants/018f3b76-1000-7000-8000-000000000099/workspaces/' +
            `${WORKSPACE_ID}/artifacts/exact.json`,
        },
      },
    ],
    [
      'cross-Workspace key',
      {
        resource: {
          key:
            `tenants/${TENANT_ID}/workspaces/` +
            '018f3b76-1000-7000-8000-000000000099/artifacts/exact.json',
        },
      },
    ],
    [
      'Tenant scope for a Workspace workload write',
      {
        scopeKind: 'TENANT',
        workspaceId: null,
      },
    ],
  ])('denies a misbehaving authority %s grant', async (_label, patch) => {
    const { resource: resourcePatch = {}, ...grantPatch } = patch as {
      resource?: Partial<{
        byteLength: number;
        key: string;
        lockedUntil: null;
      }>;
      scopeKind?: 'TENANT';
      workspaceId?: null;
    };
    const resource = {
      kind: 'WORKLOAD_OBJECT_PUT',
      objectClass: 'WORKLOAD_OBJECTS',
      bucket: 'aeostudio-workload-prod',
      key: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/exact.json`,
      checksumSha256: 'a'.repeat(64),
      contentType: 'application/json',
      byteLength: 128,
      lockedUntil: null,
      sealedAt: null,
      ...resourcePatch,
    } as const;
    const grant = {
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: LEASE_TOKEN_SHA256,
      authorityKind: 'WORKLOAD_WRITE_INTENT',
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'PUT_WORKLOAD_OBJECT',
      resource,
      expiresAt: '2026-07-23T07:01:00.000Z',
      ...grantPatch,
    } as unknown as TenantDataAccessGrant;
    const authorizer = new TenantDataBrokerAuthorizer(
      { loadActiveGrant: () => Promise.resolve(grant) },
      { now: () => NOW },
    );

    await expect(
      authorizer.authorize({
        capabilityId: CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: AUTHORIZATION_ID,
        scopeKind: grant.scopeKind,
        tenantId: TENANT_ID,
        workspaceId: grant.workspaceId,
        operation: 'PUT_WORKLOAD_OBJECT',
      }),
    ).resolves.toEqual({
      outcome: 'DENIED',
      code: 'TENANT_DATA_ACCESS_DENIED',
    });
  });

  test('denies an audit-evidence write whose DB-derived retention is shorter than 365 days', async () => {
    const grant = {
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: LEASE_TOKEN_SHA256,
      authorityKind: 'PRIVACY_WRITE_INTENT',
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'TENANT',
      tenantId: TENANT_ID,
      workspaceId: null,
      operation: 'PUT_PRIVACY_OBJECT',
      resource: {
        kind: 'PRIVACY_OBJECT_PUT',
        objectClass: 'AUDIT_EVIDENCE',
        bucket: 'aeostudio-audit-prod',
        key: `tenants/${TENANT_ID}/audit-digests/exact.json`,
        checksumSha256: 'a'.repeat(64),
        contentType: 'application/json',
        byteLength: 128,
        sealedAt: '2026-07-23T06:59:00.000Z',
        lockedUntil: '2027-07-22T06:59:00.000Z',
      },
      expiresAt: '2026-07-23T07:01:00.000Z',
    } as const satisfies TenantDataAccessGrant;
    const authorizer = new TenantDataBrokerAuthorizer(
      { loadActiveGrant: () => Promise.resolve(grant) },
      { now: () => NOW },
    );

    await expect(
      authorizer.authorize({
        capabilityId: CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'TENANT',
        tenantId: TENANT_ID,
        workspaceId: null,
        operation: 'PUT_PRIVACY_OBJECT',
      }),
    ).resolves.toEqual({
      outcome: 'DENIED',
      code: 'TENANT_DATA_ACCESS_DENIED',
    });
  });

  test('authorizes a deletion-scoped workload legal-hold read without caller-selected status fields', async () => {
    const resource = {
      kind: 'OBJECT_LEGAL_HOLD_READ',
      objectClass: 'WORKLOAD_OBJECTS',
      bucket: 'aeostudio-workload-prod',
      key: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/exact.json`,
      versionId: 'exact-version',
    } as const;
    const grant = {
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: LEASE_TOKEN_SHA256,
      authorityKind: 'DELETION_OBJECT_INTENT',
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'TENANT',
      tenantId: TENANT_ID,
      workspaceId: null,
      operation: 'GET_OBJECT_LEGAL_HOLD',
      resource,
      expiresAt: '2026-07-23T07:01:00.000Z',
    } as unknown as TenantDataAccessGrant;
    const authorizer = new TenantDataBrokerAuthorizer(
      { loadActiveGrant: () => Promise.resolve(grant) },
      { now: () => NOW },
    );

    await expect(
      authorizer.authorize({
        capabilityId: CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'TENANT',
        tenantId: TENANT_ID,
        workspaceId: null,
        operation: 'GET_OBJECT_LEGAL_HOLD',
      }),
    ).resolves.toMatchObject({
      outcome: 'AUTHORIZED',
      grant: { resource },
    });
  });

  test('authorizes legal-hold reconciliation recovery only as an exact-version legal-hold read', async () => {
    const resource = {
      kind: 'OBJECT_LEGAL_HOLD_READ',
      objectClass: 'WORKLOAD_OBJECTS',
      bucket: 'aeostudio-workload-prod',
      key: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/exact.json`,
      versionId: 'exact-version',
    } as const;
    const grant = {
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: LEASE_TOKEN_SHA256,
      authorityKind: 'LEGAL_HOLD_RECONCILIATION_INTENT',
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'GET_OBJECT_LEGAL_HOLD',
      resource,
      expiresAt: '2026-07-23T07:01:00.000Z',
    } as unknown as TenantDataAccessGrant;
    const authorizer = new TenantDataBrokerAuthorizer(
      { loadActiveGrant: () => Promise.resolve(grant) },
      { now: () => NOW },
    );

    await expect(
      authorizer.authorize({
        capabilityId: CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'GET_OBJECT_LEGAL_HOLD',
      }),
    ).resolves.toMatchObject({
      outcome: 'AUTHORIZED',
      grant: {
        authorityKind: 'LEGAL_HOLD_RECONCILIATION_INTENT',
        operation: 'GET_OBJECT_LEGAL_HOLD',
        resource,
      },
    });
  });

  test.each([
    ['cross-authority grant', { authorityKind: 'ACTIVE_PUBLICATION_JOB' }, {}],
    [
      'write-shaped resource',
      {
        resource: {
          kind: 'OBJECT_LEGAL_HOLD_WRITE',
          objectClass: 'WORKLOAD_OBJECTS',
          bucket: 'aeostudio-workload-prod',
          key: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/exact.json`,
          versionId: 'exact-version',
          desiredStatus: 'ON',
          revision: 1,
        },
      },
      {},
    ],
    ['cross-reference request', {}, { authorityReference: '018f3b76-1000-7000-8000-000000000099' }],
  ])(
    'denies legal-hold reconciliation recovery with a %s',
    async (_label, grantPatch, requestPatch) => {
      const grant = {
        capabilityId: CAPABILITY_ID,
        leaseTokenSha256: LEASE_TOKEN_SHA256,
        authorityKind: 'LEGAL_HOLD_RECONCILIATION_INTENT',
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'GET_OBJECT_LEGAL_HOLD',
        resource: {
          kind: 'OBJECT_LEGAL_HOLD_READ',
          objectClass: 'WORKLOAD_OBJECTS',
          bucket: 'aeostudio-workload-prod',
          key: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/exact.json`,
          versionId: 'exact-version',
        },
        expiresAt: '2026-07-23T07:01:00.000Z',
        ...grantPatch,
      } as unknown as TenantDataAccessGrant;
      const authorizer = new TenantDataBrokerAuthorizer(
        { loadActiveGrant: () => Promise.resolve(grant) },
        { now: () => NOW },
      );

      await expect(
        authorizer.authorize({
          capabilityId: CAPABILITY_ID,
          leaseToken: LEASE_TOKEN,
          authorityReference: AUTHORIZATION_ID,
          scopeKind: 'WORKSPACE',
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          operation: 'GET_OBJECT_LEGAL_HOLD',
          ...requestPatch,
        }),
      ).resolves.toEqual({
        outcome: 'DENIED',
        code: 'TENANT_DATA_ACCESS_DENIED',
      });
    },
  );

  test('authorizes secret unreadability verification only as a boolean-only deletion-intent composite', async () => {
    const resource = {
      kind: 'CONNECTOR_SECRET_UNREADABLE_VERIFICATION',
      secretArn: SECRET_REFERENCE,
      resultKind: 'BOOLEAN_ONLY',
    } as const;
    const grant = {
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: LEASE_TOKEN_SHA256,
      authorityKind: 'CONNECTOR_DELETION_INTENT',
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'VERIFY_CONNECTOR_SECRET_UNREADABLE',
      resource,
      expiresAt: '2026-07-23T07:01:00.000Z',
    } as unknown as TenantDataAccessGrant;
    const authorizer = new TenantDataBrokerAuthorizer(
      { loadActiveGrant: () => Promise.resolve(grant) },
      { now: () => NOW },
    );

    await expect(
      authorizer.authorize({
        capabilityId: CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'VERIFY_CONNECTOR_SECRET_UNREADABLE',
      } as never),
    ).resolves.toMatchObject({
      outcome: 'AUTHORIZED',
      grant: {
        authorityKind: 'CONNECTOR_DELETION_INTENT',
        operation: 'VERIFY_CONNECTOR_SECRET_UNREADABLE',
        resource,
      },
    });
  });

  test('denies secret unreadability verification when an authority asks for a secret-bearing result', async () => {
    const grant = {
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: LEASE_TOKEN_SHA256,
      authorityKind: 'CONNECTOR_DELETION_INTENT',
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'VERIFY_CONNECTOR_SECRET_UNREADABLE',
      resource: {
        kind: 'CONNECTOR_SECRET_UNREADABLE_VERIFICATION',
        secretArn: SECRET_REFERENCE,
        resultKind: 'SECRET_VALUE',
      },
      expiresAt: '2026-07-23T07:01:00.000Z',
    } as unknown as TenantDataAccessGrant;
    const authorizer = new TenantDataBrokerAuthorizer(
      { loadActiveGrant: () => Promise.resolve(grant) },
      { now: () => NOW },
    );

    await expect(
      authorizer.authorize({
        capabilityId: CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'VERIFY_CONNECTOR_SECRET_UNREADABLE',
      }),
    ).resolves.toEqual({
      outcome: 'DENIED',
      code: 'TENANT_DATA_ACCESS_DENIED',
    });
  });

  test('authorizes workload write recovery HEAD by exact key and expected integrity without a version ID', async () => {
    const resource = {
      kind: 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD',
      objectClass: 'WORKLOAD_OBJECTS',
      bucket: 'aeostudio-workload-prod',
      key: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/exact.json`,
      expectedChecksumSha256: 'a'.repeat(64),
      expectedContentType: 'application/json',
      expectedByteLength: 128,
      lockedUntil: null,
      sealedAt: null,
    } as const;
    const grant = {
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: LEASE_TOKEN_SHA256,
      authorityKind: 'WORKLOAD_WRITE_INTENT',
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'HEAD_WORKLOAD_OBJECT',
      resource,
      expiresAt: '2026-07-23T07:01:00.000Z',
    } as unknown as TenantDataAccessGrant;
    const authorizer = new TenantDataBrokerAuthorizer(
      { loadActiveGrant: () => Promise.resolve(grant) },
      { now: () => NOW },
    );

    const authorization = await authorizer.authorize({
      capabilityId: CAPABILITY_ID,
      leaseToken: LEASE_TOKEN,
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'HEAD_WORKLOAD_OBJECT',
    });

    expect(authorization).toMatchObject({
      outcome: 'AUTHORIZED',
      grant: {
        authorityKind: 'WORKLOAD_WRITE_INTENT',
        operation: 'HEAD_WORKLOAD_OBJECT',
        resource,
      },
    });
    expect(authorization).not.toHaveProperty('grant.resource.versionId');
  });

  test('denies crossed workload HEAD resources between write recovery and deletion authorities', async () => {
    const writeRecoveryResource = {
      kind: 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD',
      objectClass: 'WORKLOAD_OBJECTS',
      bucket: 'aeostudio-workload-prod',
      key: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/exact.json`,
      expectedChecksumSha256: 'a'.repeat(64),
      expectedContentType: 'application/json',
      expectedByteLength: 128,
      lockedUntil: null,
      sealedAt: null,
    } as const;
    const deletionResource = {
      kind: 'OBJECT_VERSION',
      objectClass: 'WORKLOAD_OBJECTS',
      bucket: 'aeostudio-workload-prod',
      key: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/exact.json`,
      versionId: 'exact-version',
      checksumSha256: 'a'.repeat(64),
      contentType: 'application/json',
      byteLength: 128,
    } as const;
    const crossedGrants = [
      {
        authorityKind: 'DELETION_OBJECT_INTENT',
        resource: writeRecoveryResource,
      },
      {
        authorityKind: 'WORKLOAD_WRITE_INTENT',
        resource: deletionResource,
      },
    ] as const;

    for (const crossed of crossedGrants) {
      const grant = {
        capabilityId: CAPABILITY_ID,
        leaseTokenSha256: LEASE_TOKEN_SHA256,
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'HEAD_WORKLOAD_OBJECT',
        expiresAt: '2026-07-23T07:01:00.000Z',
        ...crossed,
      } as unknown as TenantDataAccessGrant;
      const authorizer = new TenantDataBrokerAuthorizer(
        { loadActiveGrant: () => Promise.resolve(grant) },
        { now: () => NOW },
      );

      await expect(
        authorizer.authorize({
          capabilityId: CAPABILITY_ID,
          leaseToken: LEASE_TOKEN,
          authorityReference: AUTHORIZATION_ID,
          scopeKind: 'WORKSPACE',
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          operation: 'HEAD_WORKLOAD_OBJECT',
        }),
      ).resolves.toEqual({
        outcome: 'DENIED',
        code: 'TENANT_DATA_ACCESS_DENIED',
      });
    }
  });

  test('authorizes Tenant export write recovery HEAD with null retention fields and no version ID', async () => {
    const resource = {
      kind: 'PRIVACY_OBJECT_WRITE_RECOVERY_HEAD',
      objectClass: 'TENANT_EXPORTS',
      bucket: 'aeostudio-exports-prod',
      key: `tenants/${TENANT_ID}/exports/exact.json`,
      expectedChecksumSha256: 'a'.repeat(64),
      expectedContentType: 'application/json',
      expectedByteLength: 128,
      lockedUntil: null,
      sealedAt: null,
    } as const;
    const grant = {
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: LEASE_TOKEN_SHA256,
      authorityKind: 'PRIVACY_WRITE_INTENT',
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'TENANT',
      tenantId: TENANT_ID,
      workspaceId: null,
      operation: 'HEAD_PRIVACY_OBJECT',
      resource,
      expiresAt: '2026-07-23T07:01:00.000Z',
    } as unknown as TenantDataAccessGrant;
    const authorizer = new TenantDataBrokerAuthorizer(
      { loadActiveGrant: () => Promise.resolve(grant) },
      { now: () => NOW },
    );

    const authorization = await authorizer.authorize({
      capabilityId: CAPABILITY_ID,
      leaseToken: LEASE_TOKEN,
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'TENANT',
      tenantId: TENANT_ID,
      workspaceId: null,
      operation: 'HEAD_PRIVACY_OBJECT',
    });

    expect(authorization).toMatchObject({
      outcome: 'AUTHORIZED',
      grant: {
        authorityKind: 'PRIVACY_WRITE_INTENT',
        operation: 'HEAD_PRIVACY_OBJECT',
        resource,
      },
    });
    expect(authorization).not.toHaveProperty('grant.resource.versionId');
  });

  test('authorizes audit-evidence write recovery HEAD only with DB-derived 365-day retention fields', async () => {
    const resource = {
      kind: 'PRIVACY_OBJECT_WRITE_RECOVERY_HEAD',
      objectClass: 'AUDIT_EVIDENCE',
      bucket: 'aeostudio-audit-prod',
      key: `tenants/${TENANT_ID}/audit-digests/exact.json`,
      expectedChecksumSha256: 'a'.repeat(64),
      expectedContentType: 'application/json',
      expectedByteLength: 128,
      sealedAt: '2026-07-23T06:59:00.000Z',
      lockedUntil: '2027-07-23T06:59:00.000Z',
    } as const;
    const grant = {
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: LEASE_TOKEN_SHA256,
      authorityKind: 'PRIVACY_WRITE_INTENT',
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'TENANT',
      tenantId: TENANT_ID,
      workspaceId: null,
      operation: 'HEAD_PRIVACY_OBJECT',
      resource,
      expiresAt: '2026-07-23T07:01:00.000Z',
    } as unknown as TenantDataAccessGrant;
    const authorizer = new TenantDataBrokerAuthorizer(
      { loadActiveGrant: () => Promise.resolve(grant) },
      { now: () => NOW },
    );

    await expect(
      authorizer.authorize({
        capabilityId: CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'TENANT',
        tenantId: TENANT_ID,
        workspaceId: null,
        operation: 'HEAD_PRIVACY_OBJECT',
      }),
    ).resolves.toMatchObject({
      outcome: 'AUTHORIZED',
      grant: {
        authorityKind: 'PRIVACY_WRITE_INTENT',
        operation: 'HEAD_PRIVACY_OBJECT',
        resource,
      },
    });
  });

  test('denies audit-evidence write recovery HEAD when retention is shorter than 365 days', async () => {
    const grant = {
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: LEASE_TOKEN_SHA256,
      authorityKind: 'PRIVACY_WRITE_INTENT',
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'TENANT',
      tenantId: TENANT_ID,
      workspaceId: null,
      operation: 'HEAD_PRIVACY_OBJECT',
      resource: {
        kind: 'PRIVACY_OBJECT_WRITE_RECOVERY_HEAD',
        objectClass: 'AUDIT_EVIDENCE',
        bucket: 'aeostudio-audit-prod',
        key: `tenants/${TENANT_ID}/audit-digests/exact.json`,
        expectedChecksumSha256: 'a'.repeat(64),
        expectedContentType: 'application/json',
        expectedByteLength: 128,
        sealedAt: '2026-07-23T06:59:00.000Z',
        lockedUntil: '2027-07-22T06:59:00.000Z',
      },
      expiresAt: '2026-07-23T07:01:00.000Z',
    } as const satisfies TenantDataAccessGrant;
    const authorizer = new TenantDataBrokerAuthorizer(
      { loadActiveGrant: () => Promise.resolve(grant) },
      { now: () => NOW },
    );

    await expect(
      authorizer.authorize({
        capabilityId: CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'TENANT',
        tenantId: TENANT_ID,
        workspaceId: null,
        operation: 'HEAD_PRIVACY_OBJECT',
      }),
    ).resolves.toEqual({
      outcome: 'DENIED',
      code: 'TENANT_DATA_ACCESS_DENIED',
    });
  });

  test('denies crossed privacy HEAD resources between write recovery and deletion authorities', async () => {
    const writeRecoveryResource = {
      kind: 'PRIVACY_OBJECT_WRITE_RECOVERY_HEAD',
      objectClass: 'TENANT_EXPORTS',
      bucket: 'aeostudio-exports-prod',
      key: `tenants/${TENANT_ID}/exports/exact.json`,
      expectedChecksumSha256: 'a'.repeat(64),
      expectedContentType: 'application/json',
      expectedByteLength: 128,
      lockedUntil: null,
      sealedAt: null,
    } as const;
    const deletionResource = {
      kind: 'OBJECT_VERSION',
      objectClass: 'TENANT_EXPORTS',
      bucket: 'aeostudio-exports-prod',
      key: `tenants/${TENANT_ID}/exports/exact.json`,
      versionId: 'exact-version',
      checksumSha256: 'a'.repeat(64),
      contentType: 'application/json',
      byteLength: 128,
    } as const;
    const crossedGrants = [
      {
        authorityKind: 'DELETION_OBJECT_INTENT',
        resource: writeRecoveryResource,
      },
      {
        authorityKind: 'PRIVACY_WRITE_INTENT',
        resource: deletionResource,
      },
    ] as const;

    for (const crossed of crossedGrants) {
      const grant = {
        capabilityId: CAPABILITY_ID,
        leaseTokenSha256: LEASE_TOKEN_SHA256,
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'TENANT',
        tenantId: TENANT_ID,
        workspaceId: null,
        operation: 'HEAD_PRIVACY_OBJECT',
        expiresAt: '2026-07-23T07:01:00.000Z',
        ...crossed,
      } as unknown as TenantDataAccessGrant;
      const authorizer = new TenantDataBrokerAuthorizer(
        { loadActiveGrant: () => Promise.resolve(grant) },
        { now: () => NOW },
      );

      await expect(
        authorizer.authorize({
          capabilityId: CAPABILITY_ID,
          leaseToken: LEASE_TOKEN,
          authorityReference: AUTHORIZATION_ID,
          scopeKind: 'TENANT',
          tenantId: TENANT_ID,
          workspaceId: null,
          operation: 'HEAD_PRIVACY_OBJECT',
        }),
      ).resolves.toEqual({
        outcome: 'DENIED',
        code: 'TENANT_DATA_ACCESS_DENIED',
      });
    }
  });

  test.each([
    [
      'workload',
      'HEAD_WORKLOAD_OBJECT',
      {
        kind: 'OBJECT_VERSION',
        objectClass: 'WORKLOAD_OBJECTS',
        bucket: 'aeostudio-workload-prod',
        key: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/exact.json`,
        versionId: 'exact-workload-version',
        checksumSha256: 'a'.repeat(64),
        contentType: 'application/json',
        byteLength: 128,
      },
    ],
    [
      'privacy',
      'HEAD_PRIVACY_OBJECT',
      {
        kind: 'OBJECT_VERSION',
        objectClass: 'TENANT_EXPORTS',
        bucket: 'aeostudio-exports-prod',
        key: `tenants/${TENANT_ID}/exports/exact.json`,
        versionId: 'exact-privacy-version',
        checksumSha256: 'b'.repeat(64),
        contentType: 'application/json',
        byteLength: 256,
      },
    ],
  ] as const)(
    'authorizes deletion HEAD only for an exact %s object version',
    async (_label, operation, resource) => {
      const grant = {
        capabilityId: CAPABILITY_ID,
        leaseTokenSha256: LEASE_TOKEN_SHA256,
        authorityKind: 'DELETION_OBJECT_INTENT',
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'TENANT',
        tenantId: TENANT_ID,
        workspaceId: null,
        operation,
        resource,
        expiresAt: '2026-07-23T07:01:00.000Z',
      } as TenantDataAccessGrant;
      const authorizer = new TenantDataBrokerAuthorizer(
        { loadActiveGrant: () => Promise.resolve(grant) },
        { now: () => NOW },
      );

      await expect(
        authorizer.authorize({
          capabilityId: CAPABILITY_ID,
          leaseToken: LEASE_TOKEN,
          authorityReference: AUTHORIZATION_ID,
          scopeKind: 'TENANT',
          tenantId: TENANT_ID,
          workspaceId: null,
          operation,
        }),
      ).resolves.toMatchObject({
        outcome: 'AUTHORIZED',
        grant: {
          authorityKind: 'DELETION_OBJECT_INTENT',
          operation,
          resource,
        },
      });
    },
  );

  test.each([
    [
      'zero-byte workload recovery',
      'WORKLOAD_WRITE_INTENT',
      'WORKSPACE',
      WORKSPACE_ID,
      'HEAD_WORKLOAD_OBJECT',
      {
        kind: 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD',
        objectClass: 'WORKLOAD_OBJECTS',
        bucket: 'aeostudio-workload-prod',
        key: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/exact.json`,
        expectedChecksumSha256: 'a'.repeat(64),
        expectedContentType: 'application/json',
        expectedByteLength: 0,
        lockedUntil: null,
        sealedAt: null,
      },
    ],
    [
      'version-bearing workload recovery',
      'WORKLOAD_WRITE_INTENT',
      'WORKSPACE',
      WORKSPACE_ID,
      'HEAD_WORKLOAD_OBJECT',
      {
        kind: 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD',
        objectClass: 'WORKLOAD_OBJECTS',
        bucket: 'aeostudio-workload-prod',
        key: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/exact.json`,
        expectedChecksumSha256: 'a'.repeat(64),
        expectedContentType: 'application/json',
        expectedByteLength: 128,
        lockedUntil: null,
        sealedAt: null,
        versionId: 'caller-selected-version',
      },
    ],
    [
      'cross-Tenant privacy recovery key',
      'PRIVACY_WRITE_INTENT',
      'TENANT',
      null,
      'HEAD_PRIVACY_OBJECT',
      {
        kind: 'PRIVACY_OBJECT_WRITE_RECOVERY_HEAD',
        objectClass: 'TENANT_EXPORTS',
        bucket: 'aeostudio-exports-prod',
        key: 'tenants/018f3b76-1000-7000-8000-000000000099/exports/exact.json',
        expectedChecksumSha256: 'a'.repeat(64),
        expectedContentType: 'application/json',
        expectedByteLength: 128,
        lockedUntil: null,
        sealedAt: null,
      },
    ],
    [
      'zero-byte privacy recovery',
      'PRIVACY_WRITE_INTENT',
      'TENANT',
      null,
      'HEAD_PRIVACY_OBJECT',
      {
        kind: 'PRIVACY_OBJECT_WRITE_RECOVERY_HEAD',
        objectClass: 'TENANT_EXPORTS',
        bucket: 'aeostudio-exports-prod',
        key: `tenants/${TENANT_ID}/exports/exact.json`,
        expectedChecksumSha256: 'a'.repeat(64),
        expectedContentType: 'application/json',
        expectedByteLength: 0,
        lockedUntil: null,
        sealedAt: null,
      },
    ],
  ] as const)(
    'denies malformed or out-of-scope %s grants',
    async (_label, authorityKind, scopeKind, workspaceId, operation, resource) => {
      const grant = {
        capabilityId: CAPABILITY_ID,
        leaseTokenSha256: LEASE_TOKEN_SHA256,
        authorityKind,
        authorityReference: AUTHORIZATION_ID,
        scopeKind,
        tenantId: TENANT_ID,
        workspaceId,
        operation,
        resource,
        expiresAt: '2026-07-23T07:01:00.000Z',
      } as unknown as TenantDataAccessGrant;
      const authorizer = new TenantDataBrokerAuthorizer(
        { loadActiveGrant: () => Promise.resolve(grant) },
        { now: () => NOW },
      );

      await expect(
        authorizer.authorize({
          capabilityId: CAPABILITY_ID,
          leaseToken: LEASE_TOKEN,
          authorityReference: AUTHORIZATION_ID,
          scopeKind,
          tenantId: TENANT_ID,
          workspaceId,
          operation,
        }),
      ).resolves.toEqual({
        outcome: 'DENIED',
        code: 'TENANT_DATA_ACCESS_DENIED',
      });
    },
  );

  test('authorizes only the exact active lease, Workspace, Adapter authorization and resource', async () => {
    const grant: TenantDataAccessGrant = {
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: LEASE_TOKEN_SHA256,
      authorityKind: 'ACTIVE_PUBLICATION_JOB',
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'READ_CONNECTOR_SECRET',
      resource: { kind: 'CONNECTOR_SECRET', secretArn: SECRET_REFERENCE },
      expiresAt: '2026-07-23T07:01:00.000Z',
    };
    const loadActiveGrant = vi.fn(() => Promise.resolve(grant));
    const authority: TenantDataAccessAuthority = { loadActiveGrant };
    const authorizer = new TenantDataBrokerAuthorizer(authority, { now: () => NOW });

    const authorization = await authorizer.authorize({
      capabilityId: CAPABILITY_ID,
      leaseToken: LEASE_TOKEN,
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'READ_CONNECTOR_SECRET',
    });

    expect(authorization).toMatchObject({
      outcome: 'AUTHORIZED',
      grant: {
        capabilityId: CAPABILITY_ID,
        authorityKind: 'ACTIVE_PUBLICATION_JOB',
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'READ_CONNECTOR_SECRET',
        resource: { kind: 'CONNECTOR_SECRET', secretArn: SECRET_REFERENCE },
        expiresAt: '2026-07-23T07:01:00.000Z',
      },
    });
    expect(authorization.outcome).toBe('AUTHORIZED');
    if (authorization.outcome === 'AUTHORIZED') {
      expect(authorization.audit.resourceReferenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(loadActiveGrant).toHaveBeenCalledWith({
      capabilityId: CAPABILITY_ID,
      leaseToken: LEASE_TOKEN,
      at: NOW,
    });
  });

  test.each([
    ['Tenant', `tenant-018f3b76-1000-7000-8000-000000000099/workspace-${WORKSPACE_ID}/connector`],
    ['Workspace', `tenant-${TENANT_ID}/workspace-018f3b76-1000-7000-8000-000000000099/connector`],
  ])('denies a connector secret ARN outside the exact grant %s namespace', async (_label, name) => {
    const grant = {
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: LEASE_TOKEN_SHA256,
      authorityKind: 'ACTIVE_PUBLICATION_JOB',
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'READ_CONNECTOR_SECRET',
      resource: {
        kind: 'CONNECTOR_SECRET',
        secretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:' + name,
      },
      expiresAt: '2026-07-23T07:01:00.000Z',
    } as const satisfies TenantDataAccessGrant;
    const authorizer = new TenantDataBrokerAuthorizer(
      { loadActiveGrant: () => Promise.resolve(grant) },
      { now: () => NOW },
    );

    await expect(
      authorizer.authorize({
        capabilityId: CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'READ_CONNECTOR_SECRET',
      }),
    ).resolves.toEqual({
      outcome: 'DENIED',
      code: 'TENANT_DATA_ACCESS_DENIED',
    });
  });

  test.each([
    ['Tenant', { tenantId: '018f3b76-1000-7000-8000-000000000006' }],
    ['Workspace', { workspaceId: '018f3b76-1000-7000-8000-000000000007' }],
    ['Adapter authorization', { authorityReference: '018f3b76-1000-7000-8000-000000000008' }],
    ['operation', { operation: 'DELETE_CONNECTOR_SECRET' as const }],
  ])(
    'denies caller-selected cross-%s input with one non-enumerating outcome',
    async (_label, patch) => {
      const grant: TenantDataAccessGrant = {
        capabilityId: CAPABILITY_ID,
        leaseTokenSha256: LEASE_TOKEN_SHA256,
        authorityKind: 'ACTIVE_PUBLICATION_JOB',
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'READ_CONNECTOR_SECRET',
        resource: { kind: 'CONNECTOR_SECRET', secretArn: SECRET_REFERENCE },
        expiresAt: '2026-07-23T07:01:00.000Z',
      };
      const authorizer = new TenantDataBrokerAuthorizer(
        { loadActiveGrant: () => Promise.resolve(grant) },
        { now: () => NOW },
      );

      await expect(
        authorizer.authorize({
          capabilityId: CAPABILITY_ID,
          leaseToken: LEASE_TOKEN,
          authorityReference: AUTHORIZATION_ID,
          scopeKind: 'WORKSPACE',
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          operation: 'READ_CONNECTOR_SECRET',
          ...patch,
        }),
      ).resolves.toEqual({
        outcome: 'DENIED',
        code: 'TENANT_DATA_ACCESS_DENIED',
      });
    },
  );

  test('fails closed instead of throwing on an unrecognized runtime operation', async () => {
    const grant = {
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: LEASE_TOKEN_SHA256,
      authorityKind: 'ACTIVE_PUBLICATION_JOB',
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'CALL_ARBITRARY_AWS_API',
      resource: { kind: 'CONNECTOR_SECRET', secretArn: SECRET_REFERENCE },
      expiresAt: '2026-07-23T07:01:00.000Z',
    } as unknown as TenantDataAccessGrant;
    const authorizer = new TenantDataBrokerAuthorizer(
      { loadActiveGrant: () => Promise.resolve(grant) },
      { now: () => NOW },
    );

    await expect(
      authorizer.authorize({
        capabilityId: CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'CALL_ARBITRARY_AWS_API',
      } as never),
    ).resolves.toEqual({
      outcome: 'DENIED',
      code: 'TENANT_DATA_ACCESS_DENIED',
    });
  });

  test('fails closed instead of throwing when the authority returns malformed runtime fields', async () => {
    const malformedGrant = {
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: LEASE_TOKEN_SHA256,
      authorityKind: 'ACTIVE_PUBLICATION_JOB',
      authorityReference: {},
      scopeKind: 'WORKSPACE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'READ_CONNECTOR_SECRET',
      resource: [],
      expiresAt: '2026-07-23T07:01:00.000Z',
    } as unknown as TenantDataAccessGrant;
    const authorizer = new TenantDataBrokerAuthorizer(
      { loadActiveGrant: () => Promise.resolve(malformedGrant) },
      { now: () => NOW },
    );

    await expect(
      authorizer.authorize({
        capabilityId: CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'READ_CONNECTOR_SECRET',
      }),
    ).resolves.toEqual({
      outcome: 'DENIED',
      code: 'TENANT_DATA_ACCESS_DENIED',
    });
  });

  test('independently fences a valid but different lease even if an authority adapter misbehaves', async () => {
    const grant: TenantDataAccessGrant = {
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: LEASE_TOKEN_SHA256,
      authorityKind: 'ACTIVE_PUBLICATION_JOB',
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'READ_CONNECTOR_SECRET',
      resource: { kind: 'CONNECTOR_SECRET', secretArn: SECRET_REFERENCE },
      expiresAt: '2026-07-23T07:01:00.000Z',
    };
    const authorizer = new TenantDataBrokerAuthorizer(
      { loadActiveGrant: () => Promise.resolve(grant) },
      { now: () => NOW },
    );

    await expect(
      authorizer.authorize({
        capabilityId: CAPABILITY_ID,
        leaseToken: '018f3b76-1000-7000-8000-000000000099',
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'READ_CONNECTOR_SECRET',
      }),
    ).resolves.toEqual({
      outcome: 'DENIED',
      code: 'TENANT_DATA_ACCESS_DENIED',
    });
  });
});
