import { randomUUID } from 'node:crypto';

import {
  canonicalPrivacyJson,
  privacySha256,
  type PrivacyObjectWriteIntentWork,
} from '@aeostudio/application/privacy-audit';
import type { TenantContext } from '@aeostudio/application/identity-access';
import {
  TENANT_EXPORT_INTEGRITY_DISCLOSURE,
  TENANT_EXPORT_NO_GUARANTEE_DISCLOSURE,
  TENANT_EXPORT_SCOPE_DISCLOSURE,
  type TenantExportManifest,
} from '@aeostudio/contracts/privacy-audit';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, test, vi } from 'vitest';

import { PostgresPrivacyAuditStore } from './postgres-privacy-audit-store.js';

describe('PostgresPrivacyAuditStore authenticated Tenant export reads', () => {
  test('commits the exact Owner-bound object lookup before invoking the capability reader', async () => {
    const context: TenantContext = {
      tenantId: randomUUID(),
      workspaceId: randomUUID(),
      actorUserId: randomUUID(),
      membershipId: randomUUID(),
      role: 'OWNER',
    };
    const exportId = randomUUID();
    const sessionToken = 's'.repeat(43);
    const manifest: TenantExportManifest = {
      schemaVersion: '1.0.0',
      tenantId: context.tenantId,
      timeRange: {
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-02T00:00:00.000Z',
      },
      objects: [],
      files: [],
      disclosures: {
        tenantScope: TENANT_EXPORT_SCOPE_DISCLOSURE,
        integrity: TENANT_EXPORT_INTEGRITY_DISCLOSURE,
        noGuarantee: TENANT_EXPORT_NO_GUARANTEE_DISCLOSURE,
      },
    };
    const body = new TextEncoder().encode(
      canonicalPrivacyJson({
        schemaVersion: 'tenant-export-bundle.v1',
        manifest,
        files: [],
      }),
    );
    const manifestChecksum = privacySha256(canonicalPrivacyJson(manifest));
    const archiveChecksum = privacySha256(body);
    const expected = {
      objectRef: `s3://tenant-exports/tenants/${context.tenantId}/exports/${exportId}?versionId=v1`,
      objectKey: `tenants/${context.tenantId}/exports/${exportId}.bundle.json`,
      objectVersionId: 'v1',
      checksum: archiveChecksum,
    };
    const events: string[] = [];
    const queryValues: unknown[][] = [];
    const pool = scriptedPool({
      events,
      queryValues,
      archiveRow: {
        id: exportId,
        checksum: manifestChecksum,
        manifest,
        object_ref: expected.objectRef,
        object_key: expected.objectKey,
        object_version_id: expected.objectVersionId,
        object_checksum: expected.checksum,
      },
    });
    const legacyRead = vi.fn(() =>
      Promise.reject(new Error('LEGACY_TENANT_EXPORT_OBJECT_READ_FORBIDDEN')),
    );
    const capabilityRead = vi.fn((input: unknown) => {
      events.push('CAPABILITY_READ');
      expect(events.at(-2)).toBe('COMMIT');
      expect(input).toEqual({
        sessionToken,
        context,
        authority: { kind: 'TENANT_EXPORT', exportId },
        expected,
      });
      return Promise.resolve({
        body,
        object: {
          tenantId: context.tenantId,
          ...expected,
        },
      });
    });
    const store = new PostgresPrivacyAuditStore(pool, {
      objects: { readExportVersion: legacyRead },
      tenantExportReader: {
        readAuthenticatedTenantExportArchive: capabilityRead,
      },
    } as never) as unknown as {
      readTenantExportArchive(input: {
        sessionToken: string;
        context: TenantContext;
        exportId: string;
      }): Promise<{
        body: Uint8Array;
        manifestChecksum: string;
        archiveChecksum: string;
        filename: string;
      } | null>;
    };

    await expect(
      store.readTenantExportArchive({ sessionToken, context, exportId }),
    ).resolves.toEqual({
      body,
      manifestChecksum,
      archiveChecksum,
      filename: `tenant-export-${exportId}.json`,
    });
    expect(capabilityRead).toHaveBeenCalledOnce();
    expect(legacyRead).not.toHaveBeenCalled();
    expect(queryValues.flat()).not.toContain(sessionToken);
  });

  test.each(['tenantId', 'objectRef', 'objectKey', 'objectVersionId', 'checksum'] as const)(
    'rejects a capability response with a substituted %s',
    async (field) => {
      const fixture = tenantExportFixture();
      const storedObject = {
        tenantId: fixture.context.tenantId,
        ...fixture.expected,
      };
      storedObject[field] =
        field === 'tenantId'
          ? randomUUID()
          : field === 'checksum'
            ? 'f'.repeat(64)
            : `substituted-${field}`;
      const capabilityRead = vi.fn(() =>
        Promise.resolve({
          body: fixture.body,
          object: storedObject,
        }),
      );
      const store = new PostgresPrivacyAuditStore(
        scriptedPool({
          events: [],
          archiveRow: fixture.archiveRow,
        }),
        {
          objects: {
            readExportVersion: () =>
              Promise.reject(new Error('LEGACY_TENANT_EXPORT_OBJECT_READ_FORBIDDEN')),
          },
          tenantExportReader: {
            readAuthenticatedTenantExportArchive: capabilityRead,
          },
        } as never,
      );

      await expect(
        store.readTenantExportArchive({
          sessionToken: fixture.sessionToken,
          context: fixture.context,
          exportId: fixture.exportId,
        }),
      ).resolves.toBeNull();
      expect(capabilityRead).toHaveBeenCalledOnce();
    },
  );

  test('fails closed without touching PostgreSQL or the legacy object reader when no capability reader is composed', async () => {
    const fixture = tenantExportFixture();
    const connect = vi.fn(() => Promise.reject(new Error('DATABASE_MUST_NOT_BE_TOUCHED')));
    const legacyRead = vi.fn(() =>
      Promise.reject(new Error('LEGACY_TENANT_EXPORT_OBJECT_READ_FORBIDDEN')),
    );
    const store = new PostgresPrivacyAuditStore(
      { connect } as unknown as Pool,
      { objects: { readExportVersion: legacyRead } } as never,
    );

    await expect(
      store.readTenantExportArchive({
        sessionToken: fixture.sessionToken,
        context: fixture.context,
        exportId: fixture.exportId,
      }),
    ).resolves.toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(legacyRead).not.toHaveBeenCalled();
  });

  test('rejects a malformed session proof before preparing or reading an export', async () => {
    const fixture = tenantExportFixture();
    const pool = scriptedPool({ events: [], archiveRow: fixture.archiveRow });
    const connect = vi.spyOn(pool, 'connect');
    const capabilityRead = vi.fn(() =>
      Promise.resolve({
        body: fixture.body,
        object: {
          tenantId: fixture.context.tenantId,
          ...fixture.expected,
        },
      }),
    );
    const store = new PostgresPrivacyAuditStore(pool, {
      objects: {
        readExportVersion: () =>
          Promise.reject(new Error('LEGACY_TENANT_EXPORT_OBJECT_READ_FORBIDDEN')),
      },
      tenantExportReader: {
        readAuthenticatedTenantExportArchive: capabilityRead,
      },
    } as never);

    await expect(
      store.readTenantExportArchive({
        sessionToken: 'not-a-valid-session-proof',
        context: fixture.context,
        exportId: fixture.exportId,
      }),
    ).resolves.toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(capabilityRead).not.toHaveBeenCalled();
  });
});

describe('PostgresPrivacyAuditStore capability-bound privacy writes', () => {
  test('passes the complete committed intent and its lease to the capability writer', async () => {
    const context: TenantContext = {
      tenantId: randomUUID(),
      workspaceId: randomUUID(),
      actorUserId: randomUUID(),
      membershipId: randomUUID(),
      role: 'OWNER',
    };
    const operationId = randomUUID();
    const body = new TextEncoder().encode('{"schemaVersion":"tenant-export-bundle.v1"}');
    const checksum = privacySha256(body);
    const objectKey = `tenants/${context.tenantId}/exports/${operationId}.bundle.json`;
    const leaseExpiresAt = new Date('2026-07-23T13:01:00.000Z');
    const completionValues: unknown[][] = [];
    const pool = privacyWriteIntentPool({
      context,
      operationId,
      body,
      checksum,
      objectKey,
      leaseExpiresAt,
      completionValues,
    });
    const stored = {
      tenantId: context.tenantId,
      objectRef: `s3://tenant-exports/${objectKey}?versionId=broker-v1`,
      objectKey,
      objectVersionId: 'broker-v1',
      checksum,
      contentType: 'application/json',
      byteLength: body.byteLength,
      createdAt: '2026-07-23T13:00:00.000Z',
      lockedUntil: null,
    };
    const putAuthorizedPrivacyVersion =
      vi.fn<(input: PrivacyObjectWriteIntentWork) => Promise<typeof stored>>();
    putAuthorizedPrivacyVersion.mockResolvedValue(stored);
    const store = new PostgresPrivacyAuditStore(pool, {
      privacyWriter: { putAuthorizedPrivacyVersion },
    }) as unknown as {
      reconcilePrivacyObjectWriteIntentInContext(
        activeContext: TenantContext,
        activeOperationId: string,
      ): Promise<boolean>;
    };

    await expect(
      store.reconcilePrivacyObjectWriteIntentInContext(context, operationId),
    ).resolves.toBe(true);

    const intent = putAuthorizedPrivacyVersion.mock.calls[0]?.[0];
    if (intent === undefined) throw new Error('CAPABILITY_PRIVACY_WRITE_NOT_INVOKED');
    expect(intent.leaseToken).toMatch(/^[0-9a-f-]{36}$/u);
    expect(intent).toEqual({
      operationId,
      kind: 'TENANT_EXPORT',
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      objectKey,
      canonicalPayload: body,
      checksum,
      contentType: 'application/json',
      lockedUntil: null,
      sealedAt: null,
      leaseToken: intent.leaseToken,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
    });
    expect(completionValues).toEqual([
      [
        operationId,
        intent.leaseToken,
        stored.objectRef,
        objectKey,
        stored.objectVersionId,
        checksum,
        stored.contentType,
        stored.byteLength,
        new Date(stored.createdAt),
        null,
      ],
    ]);
  });
});

function tenantExportFixture() {
  const context: TenantContext = {
    tenantId: randomUUID(),
    workspaceId: randomUUID(),
    actorUserId: randomUUID(),
    membershipId: randomUUID(),
    role: 'OWNER',
  };
  const exportId = randomUUID();
  const manifest: TenantExportManifest = {
    schemaVersion: '1.0.0',
    tenantId: context.tenantId,
    timeRange: {
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-02T00:00:00.000Z',
    },
    objects: [],
    files: [],
    disclosures: {
      tenantScope: TENANT_EXPORT_SCOPE_DISCLOSURE,
      integrity: TENANT_EXPORT_INTEGRITY_DISCLOSURE,
      noGuarantee: TENANT_EXPORT_NO_GUARANTEE_DISCLOSURE,
    },
  };
  const body = new TextEncoder().encode(
    canonicalPrivacyJson({
      schemaVersion: 'tenant-export-bundle.v1',
      manifest,
      files: [],
    }),
  );
  const manifestChecksum = privacySha256(canonicalPrivacyJson(manifest));
  const expected = {
    objectRef: `s3://tenant-exports/tenants/${context.tenantId}/exports/${exportId}?versionId=v1`,
    objectKey: `tenants/${context.tenantId}/exports/${exportId}.bundle.json`,
    objectVersionId: 'v1',
    checksum: privacySha256(body),
  };
  return {
    context,
    exportId,
    sessionToken: 's'.repeat(43),
    manifest,
    body,
    expected,
    archiveRow: {
      id: exportId,
      checksum: manifestChecksum,
      manifest,
      object_ref: expected.objectRef,
      object_key: expected.objectKey,
      object_version_id: expected.objectVersionId,
      object_checksum: expected.checksum,
    },
  };
}

function privacyWriteIntentPool(input: {
  context: TenantContext;
  operationId: string;
  body: Uint8Array;
  checksum: string;
  objectKey: string;
  leaseExpiresAt: Date;
  completionValues: unknown[][];
}): Pool {
  let leaseToken = '';
  const query = vi.fn(
    (
      queryInput: string | { text: string },
      values?: unknown[],
    ): Promise<QueryResult<Record<string, unknown>>> => {
      const text = typeof queryInput === 'string' ? queryInput : queryInput.text;
      const normalized = text.trim().replace(/\s+/gu, ' ');
      if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
        return Promise.resolve(queryResult([]));
      }
      if (normalized.startsWith('SET LOCAL ROLE')) return Promise.resolve(queryResult([]));
      if (normalized.includes("set_config('app.tenant_id'")) {
        return Promise.resolve(queryResult([{}]));
      }
      if (normalized.includes('FROM tenants tenant JOIN workspaces workspace')) {
        return Promise.resolve(queryResult([{}]));
      }
      if (normalized.includes('JOIN memberships membership')) {
        return Promise.resolve(queryResult([{}]));
      }
      if (normalized.includes('FROM workspaces WHERE tenant_id')) {
        return Promise.resolve(queryResult([{ lifecycle_state: 'ACTIVE' }]));
      }
      if (normalized.includes('claim_privacy_object_write_intent')) {
        const claimedLeaseToken = values?.[2];
        if (typeof claimedLeaseToken !== 'string') {
          throw new Error('EXPECTED_PRIVACY_WRITE_LEASE_TOKEN');
        }
        leaseToken = claimedLeaseToken;
        return Promise.resolve(queryResult([{ claimed: true }]));
      }
      if (normalized.includes('FROM privacy_object_write_intents')) {
        return Promise.resolve(
          queryResult([
            {
              operation_id: input.operationId,
              kind: 'TENANT_EXPORT',
              tenant_id: input.context.tenantId,
              workspace_id: input.context.workspaceId,
              object_key: input.objectKey,
              canonical_payload: Buffer.from(input.body),
              checksum: input.checksum,
              content_type: 'application/json',
              locked_until: null,
              sealed_at: null,
              lease_token: leaseToken,
              lease_expires_at: input.leaseExpiresAt,
            },
          ]),
        );
      }
      if (normalized.includes('complete_privacy_object_write_intent')) {
        input.completionValues.push(values ?? []);
        return Promise.resolve(queryResult([{ completed: true }]));
      }
      throw new Error(`UNEXPECTED_QUERY:${normalized}`);
    },
  );
  const client = {
    query,
    release: vi.fn(),
  } as unknown as PoolClient;
  return {
    connect: vi.fn(() => Promise.resolve(client)),
  } as unknown as Pool;
}

function scriptedPool(input: {
  events: string[];
  archiveRow: Record<string, unknown>;
  queryValues?: unknown[][];
}): Pool {
  const query = vi.fn(
    (
      queryInput: string | { text: string },
      values?: unknown[],
    ): Promise<QueryResult<Record<string, unknown>>> => {
      const text = typeof queryInput === 'string' ? queryInput : queryInput.text;
      const normalized = text.trim().replace(/\s+/gu, ' ');
      if (values !== undefined) input.queryValues?.push(values);
      if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
        input.events.push(normalized);
        return Promise.resolve(queryResult([]));
      }
      if (normalized.startsWith('SET LOCAL ROLE')) return Promise.resolve(queryResult([]));
      if (normalized.includes("set_config('app.tenant_id'")) {
        return Promise.resolve(queryResult([{}]));
      }
      if (normalized.includes('FROM tenants tenant JOIN workspaces workspace')) {
        return Promise.resolve(queryResult([{}]));
      }
      if (normalized.includes('JOIN memberships membership')) {
        return Promise.resolve(queryResult([{}]));
      }
      if (normalized.includes('FROM workspaces WHERE tenant_id')) {
        return Promise.resolve(queryResult([{ lifecycle_state: 'ACTIVE' }]));
      }
      if (normalized.includes('FROM tenant_exports export')) {
        return Promise.resolve(queryResult([input.archiveRow]));
      }
      throw new Error(`UNEXPECTED_QUERY:${normalized}`);
    },
  );
  const client = {
    query,
    release: vi.fn(),
  } as unknown as PoolClient;
  return {
    connect: vi.fn(() => Promise.resolve(client)),
  } as unknown as Pool;
}

function queryResult<TRow extends Record<string, unknown>>(rows: TRow[]): QueryResult<TRow> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}
