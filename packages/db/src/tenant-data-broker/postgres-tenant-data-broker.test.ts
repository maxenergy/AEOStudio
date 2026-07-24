import type { Pool } from 'pg';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';

import {
  PostgresTenantDataCapabilityIssuer,
  PostgresTenantDataBrokerStore,
  type TenantDataBrokerSqlClient,
} from './postgres-tenant-data-broker.js';

const CAPABILITY_ID = '018f3b76-1000-7000-8000-000000000001';
const LEASE_TOKEN = '018f3b76-1000-7000-8000-000000000002';
const ATTEMPT_ID = '018f3b76-1000-7000-8000-000000000003';
const NONCE = '018f3b76-1000-7000-8000-000000000004';
const TENANT_ID = '018f3b76-1000-7000-8000-000000000005';
const WORKSPACE_ID = '018f3b76-1000-7000-8000-000000000006';
const RESOURCE_HASH = 'a'.repeat(64);

describe('Postgres Tenant Data Broker runtime store', () => {
  test('accepts the production pg Pool query surface', () => {
    expectTypeOf<Pool>().toExtend<TenantDataBrokerSqlClient>();
  });

  test('maps the exact active capability row without exposing a raw lease', async () => {
    const query = vi.fn(() =>
      Promise.resolve({
        rows: [
          {
            capability_id: CAPABILITY_ID,
            lease_token_sha256: 'b'.repeat(64),
            authority_kind: 'WORKLOAD_WRITE_INTENT',
            authority_reference: '018f3b76-1000-7000-8000-000000000007',
            scope_kind: 'WORKSPACE',
            tenant_id: TENANT_ID,
            workspace_id: WORKSPACE_ID,
            operation: 'PUT_WORKLOAD_OBJECT',
            resource: workloadPutResource(),
            resource_hash: RESOURCE_HASH,
            effect_identity: 'WORKLOAD_OBJECT_WRITE:fixture',
            expires_at: new Date('2026-07-23T18:30:00.000Z'),
          },
        ],
      }),
    );
    const store = new PostgresTenantDataBrokerStore({ query });

    await expect(
      store.loadActiveGrant({
        capabilityId: CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        at: new Date('2026-07-23T18:29:00.000Z'),
      }),
    ).resolves.toEqual({
      capabilityId: CAPABILITY_ID,
      leaseTokenSha256: 'b'.repeat(64),
      authorityKind: 'WORKLOAD_WRITE_INTENT',
      authorityReference: '018f3b76-1000-7000-8000-000000000007',
      scopeKind: 'WORKSPACE',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'PUT_WORKLOAD_OBJECT',
      resource: workloadPutResource(),
      expiresAt: '2026-07-23T18:30:00.000Z',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('load_active_tenant_data_capability'),
      [CAPABILITY_ID, LEASE_TOKEN],
    );
  });

  test('uses the atomic authenticated begin and preserves durable retry outcomes', async () => {
    const receipt = {
      bucket: 'aeostudio-staging-artifacts',
      key: 'tenants/fixture/object.json',
      versionId: 'version-1',
      checksum: 'c'.repeat(64),
      contentType: 'application/json',
      byteLength: 7,
    };
    const query = vi.fn(() =>
      Promise.resolve({
        rows: [
          {
            outcome: 'ALREADY_SUCCEEDED',
            attempt_id: null,
            success_receipt: receipt,
          },
        ],
      }),
    );
    const store = new PostgresTenantDataBrokerStore({ query });
    const signedAt = new Date('2026-07-23T18:29:00.000Z');
    const expiresAt = new Date('2026-07-23T18:29:30.000Z');

    await expect(
      store.beginAuthenticated({
        nonce: NONCE,
        signedAt,
        expiresAt,
        capabilityId: CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        operation: 'PUT_WORKLOAD_OBJECT',
        resourceReferenceSha256: RESOURCE_HASH,
      }),
    ).resolves.toEqual({
      outcome: 'ALREADY_SUCCEEDED',
      successReceipt: receipt,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('begin_authenticated_tenant_data_broker_effect'),
      [
        NONCE,
        signedAt,
        expiresAt,
        CAPABILITY_ID,
        LEASE_TOKEN,
        'PUT_WORKLOAD_OBJECT',
        RESOURCE_HASH,
      ],
    );
  });

  test('fails closed for an empty or malformed database response', async () => {
    const empty = new PostgresTenantDataBrokerStore({
      query: () => Promise.resolve({ rows: [] }),
    });
    await expect(
      empty.beginAuthenticated({
        nonce: NONCE,
        signedAt: new Date('2026-07-23T18:29:00.000Z'),
        expiresAt: new Date('2026-07-23T18:29:30.000Z'),
        capabilityId: CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        operation: 'PUT_WORKLOAD_OBJECT',
        resourceReferenceSha256: RESOURCE_HASH,
      }),
    ).resolves.toEqual({ outcome: 'DENIED' });

    const malformed = new PostgresTenantDataBrokerStore({
      query: () => Promise.resolve({ rows: [{ outcome: 'STARTED', attempt_id: null }] }),
    });
    await expect(
      malformed.beginAuthenticated({
        nonce: NONCE,
        signedAt: new Date('2026-07-23T18:29:00.000Z'),
        expiresAt: new Date('2026-07-23T18:29:30.000Z'),
        capabilityId: CAPABILITY_ID,
        leaseToken: LEASE_TOKEN,
        operation: 'PUT_WORKLOAD_OBJECT',
        resourceReferenceSha256: RESOURCE_HASH,
      }),
    ).rejects.toThrow('TENANT_DATA_BROKER_DATABASE_RESPONSE_INVALID');
  });

  test('finishes attempts through the exact lease-fenced function and rejects false', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ finished: true }] })
      .mockResolvedValueOnce({ rows: [{ finished: false }] });
    const store = new PostgresTenantDataBrokerStore({ query });

    await expect(
      store.complete({
        attemptId: ATTEMPT_ID,
        leaseToken: LEASE_TOKEN,
        receipt: null,
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.fail({
        attemptId: ATTEMPT_ID,
        leaseToken: LEASE_TOKEN,
        outcome: 'UNKNOWN',
      }),
    ).rejects.toThrow('TENANT_DATA_BROKER_ATTEMPT_NOT_FINISHED');
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('finish_tenant_data_broker_effect'),
      [ATTEMPT_ID, LEASE_TOKEN, 'SUCCESS', null],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('finish_tenant_data_broker_effect'),
      [ATTEMPT_ID, LEASE_TOKEN, 'UNKNOWN', null],
    );
  });

  test('maps the exact UNKNOWN resolvers without accepting arbitrary outcomes', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ resolution: 'RESOLVED_SUCCESS' }] })
      .mockResolvedValueOnce({ rows: [{ resolution: 'NOT_RESOLVED' }] })
      .mockResolvedValueOnce({ rows: [{ resolution: 'RESOLVED_FAILED' }] });
    const store = new PostgresTenantDataBrokerStore({ query });

    await expect(
      store.resolveObjectPut({
        probeAttemptId: ATTEMPT_ID,
        leaseToken: LEASE_TOKEN,
        observation: 'FOUND',
        observedVersionId: 'version-1',
        observedChecksum: 'c'.repeat(64),
        observedContentType: 'application/json',
        observedByteLength: 7,
      }),
    ).resolves.toBe('RESOLVED_SUCCESS');
    await expect(
      store.resolveLegalHold({
        probeAttemptId: ATTEMPT_ID,
        leaseToken: LEASE_TOKEN,
        observedStatus: 'ON',
      }),
    ).resolves.toBe('NOT_RESOLVED');
    await expect(
      store.resolveSecretDelete({
        probeAttemptId: ATTEMPT_ID,
        leaseToken: LEASE_TOKEN,
        observation: 'EXISTS',
      }),
    ).resolves.toBe('RESOLVED_FAILED');
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('resolve_tenant_data_broker_object_put_effect'),
      [ATTEMPT_ID, LEASE_TOKEN, 'FOUND', 'version-1', 'c'.repeat(64), 'application/json', 7],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('resolve_tenant_data_broker_legal_hold_effect'),
      [ATTEMPT_ID, LEASE_TOKEN, 'ON'],
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('resolve_tenant_data_broker_secret_delete_effect'),
      [ATTEMPT_ID, LEASE_TOKEN, 'EXISTS'],
    );
  });
});

describe('Postgres Tenant Data capability issuer', () => {
  test('issues an authenticated read only from the raw session proof and exact version', async () => {
    const issuedCapabilityId = '018f3b76-1000-7000-8000-000000000009';
    const query = vi.fn(() => Promise.resolve({ rows: [{ capability_id: issuedCapabilityId }] }));
    const issuer = new PostgresTenantDataCapabilityIssuer({ query });
    const rawSessionToken = 's'.repeat(43);

    await expect(
      issuer.issueAuthenticatedObjectRead({
        sessionToken: rawSessionToken,
        membershipId: '018f3b76-1000-7000-8000-000000000010',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        objectKey: 'tenants/t1/workspaces/w1/artifacts/a/revisions/1/payload.json',
        objectVersionId: 'version-1',
        leaseToken: LEASE_TOKEN,
        capabilityId: CAPABILITY_ID,
      }),
    ).resolves.toBe(issuedCapabilityId);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('issue_authenticated_object_read_capability'),
      [
        rawSessionToken,
        '018f3b76-1000-7000-8000-000000000010',
        TENANT_ID,
        WORKSPACE_ID,
        'tenants/t1/workspaces/w1/artifacts/a/revisions/1/payload.json',
        'version-1',
        LEASE_TOKEN,
        CAPABILITY_ID,
      ],
    );
    expect(JSON.stringify(query.mock.calls)).toContain(rawSessionToken);
  });

  test('uses returned capability ids and fixes inventory authority to 1000', async () => {
    const returned = '018f3b76-1000-7000-8000-000000000011';
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ capability_id: returned }] })
      .mockResolvedValueOnce({ rows: [{ capability_id: null }] });
    const issuer = new PostgresTenantDataCapabilityIssuer({ query });

    await expect(
      issuer.issueWorkloadObjectPut({
        operationId: '018f3b76-1000-7000-8000-000000000012',
        leaseToken: LEASE_TOKEN,
        capabilityId: CAPABILITY_ID,
      }),
    ).resolves.toBe(returned);
    await expect(
      issuer.issueDeletionInventory({
        requestId: '018f3b76-1000-7000-8000-000000000013',
        leaseToken: LEASE_TOKEN,
        capabilityId: CAPABILITY_ID,
      }),
    ).resolves.toBeNull();
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('issue_workload_object_put_capability'),
      ['018f3b76-1000-7000-8000-000000000012', LEASE_TOKEN, CAPABILITY_ID],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('issue_deletion_inventory_capability'),
      ['018f3b76-1000-7000-8000-000000000013', LEASE_TOKEN, CAPABILITY_ID, 1000],
    );
  });

  test('fails closed for malformed issuer rows and invalid session proof', async () => {
    const issuer = new PostgresTenantDataCapabilityIssuer({
      query: () =>
        Promise.resolve({
          rows: [{ capability_id: 'not-a-uuid', extra: 'unexpected' }],
        }),
    });
    await expect(
      issuer.issueWorkloadObjectPut({
        operationId: '018f3b76-1000-7000-8000-000000000012',
        leaseToken: LEASE_TOKEN,
        capabilityId: CAPABILITY_ID,
      }),
    ).rejects.toThrow('TENANT_DATA_BROKER_DATABASE_RESPONSE_INVALID');
    await expect(
      issuer.issueAuthenticatedObjectRead({
        sessionToken: 'digest-is-not-possession-proof',
        membershipId: '018f3b76-1000-7000-8000-000000000010',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        objectKey: 'tenants/t1/object.json',
        objectVersionId: 'version-1',
        leaseToken: LEASE_TOKEN,
        capabilityId: CAPABILITY_ID,
      }),
    ).rejects.toThrow('TENANT_DATA_BROKER_DATABASE_INPUT_INVALID');
  });
});

function workloadPutResource() {
  return {
    kind: 'WORKLOAD_OBJECT_PUT',
    objectClass: 'WORKLOAD_OBJECTS',
    bucket: 'aeostudio-staging-artifacts',
    key: 'tenants/fixture/object.json',
    checksumSha256: 'c'.repeat(64),
    contentType: 'application/json',
    byteLength: 7,
    lockedUntil: null,
    sealedAt: null,
  } as const;
}
