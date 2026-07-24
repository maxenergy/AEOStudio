import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import * as application from '@aeostudio/application';
import { FakePrivacyObjectStorage } from '@aeostudio/adapters/storage';
import type { TenantContext } from '@aeostudio/application/identity-access';
import type {
  AuditEvidenceObjectLockStore,
  BackupDeletionEvidenceStore,
  PrivacyObjectVersionInventory,
  TenantExportObjectStorage,
} from '@aeostudio/application/privacy-audit';
import type { TenantExportArchiveReadRequest } from '@aeostudio/application/tenant-data-access';
import {
  TENANT_EXPORT_INTEGRITY_DISCLOSURE,
  TENANT_EXPORT_NO_GUARANTEE_DISCLOSURE,
  TENANT_EXPORT_SCOPE_DISCLOSURE,
} from '@aeostudio/contracts/privacy-audit';
import * as db from '@aeostudio/db';
import {
  AesGcmSessionCipher,
  PostgresAuthStore,
  PostgresChannelAuthorizationStore,
  PostgresJobBudgetStore,
  PostgresTenancyStore,
  runMigrations,
} from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import { PrivacyLifecycleWorker } from '../../apps/worker/src/privacy-lifecycle-worker.js';

const NOW = new Date('2026-07-22T04:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;
const PLATFORM_OPERATOR_ID = '00000000-0000-7000-8000-000000000170';
const PLATFORM_OPERATOR_SUBJECT = 'trusted-platform-operator-subject';

function activeWallClockExpiry(): Date {
  return new Date(Date.now() + DAY_MS);
}

interface TenantFixture {
  tenantId: string;
  workspaceId: string;
  ownerUserId: string;
  ownerSubject: string;
  context: TenantContext;
  sessionTokenDigest: string;
  jobId: string;
  authorizationId: string;
  secretArn: string;
  auditEventId: string;
}

interface ExportManifestObject {
  kind: string;
  objectId: string;
  contentHash: string;
}

interface ExportManifest {
  schemaVersion: '1.0.0';
  tenantId: string;
  timeRange: { from: string; to: string };
  objects: ExportManifestObject[];
}

interface PrivacyAuditServiceApi {
  exportTenant(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    from: string;
    to: string;
  }): Promise<
    | {
        outcome: 'SUCCEEDED';
        export: {
          id: string;
          manifest: ExportManifest;
          checksum: string;
          archiveStatus: 'PENDING' | 'READY' | 'FAILED';
          archiveReady: boolean;
          objectRef: string | null;
          createdAt: string;
        };
      }
    | { outcome: 'FORBIDDEN' | 'NOT_FOUND' | 'OBJECT_NOT_FOUND' }
  >;
  requestTenantDeletion(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    reason: string;
  }): Promise<
    | {
        outcome: 'SUCCEEDED';
        receipt: {
          id: string;
          state: 'FROZEN';
          requestedAt: string;
          activeDeleteBy: string;
          backupDeleteBy: string;
          secretForceDeleteBy: string;
        };
      }
    | { outcome: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_REQUEST' }
  >;
  requestWorkspaceDeletion(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    reason: string;
  }): Promise<
    | {
        outcome: 'SUCCEEDED';
        receipt: {
          id: string;
          requestedAt: string;
          activeDeleteBy: string;
          backupDeleteBy: string;
          secretForceDeleteBy: string;
        };
      }
    | { outcome: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_REQUEST' }
  >;
  createLegalHold(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    name: string;
    reason: string;
    objectKey: string;
    objectVersionId: string;
  }): Promise<
    | {
        outcome: 'SUCCEEDED';
        hold: {
          id: string;
          name: string;
          reason: string;
          visibleToTenant: true;
          target: { objectKey: string; objectVersionId: string };
        };
      }
    | { outcome: 'FORBIDDEN' | 'NOT_FOUND' }
  >;
  listLegalHolds(input: { actorSubject: string; tenantId: string; workspaceId: string }): Promise<
    | {
        outcome: 'SUCCEEDED';
        holds: Array<{
          id: string;
          name: string;
          reason: string;
          visibleToTenant: true;
          target: { objectKey: string; objectVersionId: string };
        }>;
      }
    | { outcome: 'NOT_FOUND' }
  >;
  releaseLegalHold(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    holdId: string;
  }): Promise<{ outcome: 'SUCCEEDED' | 'NOT_FOUND' | 'INVALID_HOLD' }>;
  finalizeDeletion(input: { requestId: string; leaseToken: string }): Promise<{
    outcome:
      | 'SUCCEEDED'
      | 'NOT_FOUND'
      | 'NOT_DUE'
      | 'INVALID_LEASE'
      | 'LEGAL_HOLD'
      | 'PIPELINE_UNAVAILABLE';
    finalization?: { state: string };
  }>;
  evaluateRetention(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    objectClass: 'APPLICATION_LOG';
    objectKey: string;
    objectVersionId: string;
    createdAt: string;
  }): Promise<{
    decision: 'RETAIN' | 'EXPIRE' | 'LEGAL_HOLD' | 'INVALID_TIMELINE';
    retained: boolean;
    deletionAllowed: boolean;
    legalHold: { id: string } | null;
  }>;
  grantBreakGlass(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    reason: string;
    expiresAt: string;
    requestedAction: string;
    resourceType: string;
    resourceId: string;
  }): Promise<
    | {
        outcome: 'SUCCEEDED';
        grant: {
          id: string;
          tenantId: string;
          workspaceId: string;
          operatorId: string;
          operatorName: string;
          reason: string;
          auditEventId: string;
          requestedAction: string;
          resourceType: string;
          resourceId: string;
          grantedAt: string;
          expiresAt: string;
        };
      }
    | { outcome: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_GRANT' }
  >;
  evaluateBreakGlassAccess(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    grantId: string;
    requestedAction: string;
    resourceType: string;
    resourceId: string;
  }): Promise<{
    decision: 'ALLOW' | 'DENY';
    state: 'ACTIVE' | 'NOT_YET_ACTIVE' | 'EXPIRED' | 'REVOKED' | 'INVALID_GRANT';
    grantId: string | null;
    operatorName: string | null;
    reason: string | null;
    auditEventId: string | null;
  }>;
  verifyAuditIntegrity(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<{
    outcome: 'SUCCEEDED' | 'TAMPERED' | 'NOT_FOUND';
    valid: boolean;
    eventCount: number;
    reason: string | null;
  }>;
  sealAuditDigest(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    from: string;
    to: string;
  }): Promise<{
    outcome: 'SUCCEEDED' | 'TAMPERED' | 'NOT_FOUND' | 'PIPELINE_UNAVAILABLE';
    digest?: {
      id: string;
      tenantId: string;
      schemaVersion: 'audit-digest.v1';
      eventCount: number;
      lastSequence: number;
      headHash: string | null;
      digestHash: string;
      timeRange: { from: string; to: string };
      lockedUntil: string;
      sealedAt: string;
    };
  }>;
  listAuditEvents(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    from: string;
    to: string;
    limit?: number;
  }): Promise<{
    outcome: 'SUCCEEDED' | 'NOT_FOUND' | 'PIPELINE_UNAVAILABLE';
    timeline?: {
      events: Array<{
        actorKind: 'USER' | 'AGENT' | 'SYSTEM' | 'SUPPORT' | 'PLATFORM_OPERATOR';
        action: string;
        resourceType: string;
        resourceId: string | null;
        outcome: string;
        metadata: Record<string, unknown>;
      }>;
    };
  }>;
}

type PrivacyAuditServiceConstructor = new (
  store: object,
  tenancy: PostgresTenancyStore,
  ids: { next(): string },
  clock: { now(): Date },
  platformBreakGlass?: {
    authorize(input: { actorSubject: string }): Promise<{
      operatorId: string;
      operatorName: string;
    } | null>;
  },
) => PrivacyAuditServiceApi;

type PostgresPrivacyAuditStoreConstructor = typeof db.PostgresPrivacyAuditStore;

const applicationRuntime = application as unknown as {
  PrivacyAuditService?: PrivacyAuditServiceConstructor;
};
const databaseRuntime = db as unknown as {
  PostgresPrivacyAuditStore?: PostgresPrivacyAuditStoreConstructor;
};

class FakeClock {
  public constructor(private current: Date) {}

  public now(): Date {
    return new Date(this.current.getTime());
  }

  public set(value: Date): void {
    this.current = new Date(value.getTime());
  }
}

describe('Task 17 privacy, audit, and lifecycle public API', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tenancyStore: PostgresTenancyStore;
  let authStore: PostgresAuthStore;
  let jobStore: PostgresJobBudgetStore;
  let channelAuthorizationStore: PostgresChannelAuthorizationStore;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let tenantFrozenGovernance: TenantFixture;
  let tenantHoldRelease: TenantFixture;
  let tenantHeldSibling: TenantFixture;
  let tenantFutureClock: TenantFixture;
  let tenantRevokedSecret: TenantFixture;
  let tenantLifecycleLock: TenantFixture;
  let tenantFutureRequest: TenantFixture;
  let tenantScheduler: TenantFixture;
  let tenantEscalatedDeletion: TenantFixture;
  let tenantExportDeletion: TenantFixture;
  let tenantWorkspaceExportDeletion: TenantFixture;
  let tenantInventoryDeletion: TenantFixture;
  let tenantFreezeRace: TenantFixture;
  let tenantIntentRace: TenantFixture;
  let clock: FakeClock;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(
      pool,
      fileURLToPath(new URL('../../packages/db/migrations', import.meta.url)),
    );
    tenancyStore = new PostgresTenancyStore(pool);
    authStore = new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 17)));
    jobStore = new PostgresJobBudgetStore(pool);
    channelAuthorizationStore = new PostgresChannelAuthorizationStore(pool);
    clock = new FakeClock(NOW);

    const adapterVersionId = randomUUID();
    await pool.query(
      `INSERT INTO adapter_versions
        (id, channel_definition_id, adapter_key, adapter_version, enabled, capabilities,
          required_scopes, terms_version, terms_status, processing_region, retention_policy,
          training_policy, subprocessors, rate_policy, created_at)
       VALUES ($1, '00000000-0000-7000-8000-000000001000', 'task17-fixture', '1.0.0',
         true, ARRAY['PUBLISH'], ARRAY['content:write'], 'task17-terms-v1', 'ALLOWED',
         'ap-southeast-1', 'Fixture retention.', 'Fixture training disabled.', '[]'::jsonb,
         '{"mode":"fixture"}'::jsonb, $2)`,
      [adapterVersionId, NOW],
    );

    tenantA = await seedTenantFixture({
      label: 'tenant-a',
      adapterVersionId,
      tenancyStore,
      authStore,
      channelAuthorizationStore,
      pool,
    });
    tenantB = await seedTenantFixture({
      label: 'tenant-b',
      adapterVersionId,
      tenancyStore,
      authStore,
      channelAuthorizationStore,
      pool,
    });
    tenantFrozenGovernance = await seedTenantFixture({
      label: 'tenant-frozen-governance',
      adapterVersionId,
      tenancyStore,
      authStore,
      channelAuthorizationStore,
      pool,
    });
    tenantHoldRelease = await seedTenantFixture({
      label: 'tenant-hold-release',
      adapterVersionId,
      tenancyStore,
      authStore,
      channelAuthorizationStore,
      pool,
    });
    tenantHeldSibling = await seedTenantFixture({
      label: 'tenant-held-sibling',
      adapterVersionId,
      tenancyStore,
      authStore,
      channelAuthorizationStore,
      pool,
    });
    tenantFutureClock = await seedTenantFixture({
      label: 'tenant-future-clock',
      adapterVersionId,
      tenancyStore,
      authStore,
      channelAuthorizationStore,
      pool,
    });
    tenantRevokedSecret = await seedTenantFixture({
      label: 'tenant-revoked-secret',
      adapterVersionId,
      tenancyStore,
      authStore,
      channelAuthorizationStore,
      pool,
    });
    tenantLifecycleLock = await seedTenantFixture({
      label: 'tenant-lifecycle-lock',
      adapterVersionId,
      tenancyStore,
      authStore,
      channelAuthorizationStore,
      pool,
    });
    tenantFutureRequest = await seedTenantFixture({
      label: 'tenant-future-request',
      adapterVersionId,
      tenancyStore,
      authStore,
      channelAuthorizationStore,
      pool,
    });
    tenantScheduler = await seedTenantFixture({
      label: 'tenant-scheduler',
      adapterVersionId,
      tenancyStore,
      authStore,
      channelAuthorizationStore,
      pool,
    });
    tenantEscalatedDeletion = await seedTenantFixture({
      label: 'tenant-escalated-deletion',
      adapterVersionId,
      tenancyStore,
      authStore,
      channelAuthorizationStore,
      pool,
    });
    tenantExportDeletion = await seedTenantFixture({
      label: 'tenant-export-deletion',
      adapterVersionId,
      tenancyStore,
      authStore,
      channelAuthorizationStore,
      pool,
    });
    tenantWorkspaceExportDeletion = await seedTenantFixture({
      label: 'tenant-workspace-export-deletion',
      adapterVersionId,
      tenancyStore,
      authStore,
      channelAuthorizationStore,
      pool,
    });
    tenantInventoryDeletion = await seedTenantFixture({
      label: 'tenant-inventory-deletion',
      adapterVersionId,
      tenancyStore,
      authStore,
      channelAuthorizationStore,
      pool,
    });
    tenantFreezeRace = await seedTenantFixture({
      label: 'tenant-freeze-race',
      adapterVersionId,
      tenancyStore,
      authStore,
      channelAuthorizationStore,
      pool,
    });
    tenantIntentRace = await seedTenantFixture({
      label: 'tenant-intent-race',
      adapterVersionId,
      tenancyStore,
      authStore,
      channelAuthorizationStore,
      pool,
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  afterEach(() => {
    clock?.set(NOW);
  });

  test('exports the PrivacyAuditService application boundary', () => {
    expect(
      applicationRuntime.PrivacyAuditService,
      'expected tenant-only export to be owned by a public PrivacyAuditService',
    ).toBeTypeOf('function');
  });

  test('exports the PostgreSQL privacy/audit store boundary', () => {
    expect(
      databaseRuntime.PostgresPrivacyAuditStore,
      'expected session revoked immediately through a public PostgresPrivacyAuditStore',
    ).toBeTypeOf('function');
  });

  test('PostgreSQL tenant exports revalidate the exact live Owner instead of trusting context claims', async () => {
    const resolved = await tenancyStore.resolveTenantContext({
      actorSubject: tenantA.ownerSubject,
      tenantId: tenantA.tenantId,
      workspaceId: tenantA.workspaceId,
    });
    if (resolved === null) throw new Error('expected live Owner context');
    const forgedContext: TenantContext = {
      ...resolved,
      actorUserId: randomUUID(),
      membershipId: randomUUID(),
      role: 'OWNER',
    };
    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    if (Store === undefined) throw new Error('privacy store unavailable');
    const store = new Store(pool) as {
      loadTenantExportObjects(input: {
        context: TenantContext;
        from: Date;
        to: Date;
      }): Promise<unknown>;
      saveTenantExport(input: {
        context: TenantContext;
        exportId: string;
        manifest: Record<string, unknown>;
        checksum: string;
        requestHash: string;
        createdAt: Date;
        auditEventId: string;
      }): Promise<unknown>;
    };
    await expect(
      store.loadTenantExportObjects({
        context: forgedContext,
        from: new Date('2026-01-01T00:00:00.000Z'),
        to: new Date('2026-07-21T23:59:59.999Z'),
      }),
    ).rejects.toThrow(/TENANT_EXPORT_OWNER_CONTEXT_INVALID|permission|not active/iu);
    await expect(
      store.saveTenantExport({
        context: forgedContext,
        exportId: randomUUID(),
        manifest: {
          schemaVersion: '1.0.0',
          tenantId: tenantA.tenantId,
          timeRange: {
            from: '2026-01-01T00:00:00.000Z',
            to: '2026-07-21T23:59:59.999Z',
          },
          objects: [],
          files: [],
          disclosures: {
            tenantScope: 'Tenant scope.',
            integrity: 'Integrity disclosure.',
            noGuarantee: 'No guarantee disclosure.',
          },
        },
        checksum: 'a'.repeat(64),
        requestHash: 'b'.repeat(64),
        createdAt: NOW,
        auditEventId: randomUUID(),
      }),
    ).rejects.toThrow(/TENANT_EXPORT_OWNER_CONTEXT_INVALID|permission|not active/iu);
  });

  test('concurrent PostgreSQL export saves converge on one idempotent export id', async () => {
    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    if (Store === undefined) throw new Error('privacy store unavailable');
    const store = new Store(pool) as {
      saveTenantExport(input: {
        context: TenantContext;
        exportId: string;
        manifest: Record<string, unknown>;
        checksum: string;
        requestHash: string;
        createdAt: Date;
        auditEventId: string;
      }): Promise<{
        outcome: string;
        exportId?: string;
        created?: boolean;
      }>;
    };
    const requestHash = sha256(`concurrent-export:${randomUUID()}`);
    const checksum = sha256('concurrent-export-manifest');
    const manifest = {
      schemaVersion: '1.0.0',
      tenantId: tenantA.tenantId,
      timeRange: {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-07-21T23:59:59.999Z',
      },
      objects: [],
      files: [],
      disclosures: {
        tenantScope: 'Tenant scope.',
        integrity: 'Integrity disclosure.',
        noGuarantee: 'No guarantee disclosure.',
      },
    };
    const results = await Promise.all(
      [randomUUID(), randomUUID()].map((exportId) =>
        store.saveTenantExport({
          context: tenantA.context,
          exportId,
          manifest,
          checksum,
          requestHash,
          createdAt: NOW,
          auditEventId: randomUUID(),
        }),
      ),
    );
    expect(results.map(({ outcome }) => outcome)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    expect(new Set(results.map(({ exportId }) => exportId)).size).toBe(1);
    expect(results.map(({ created }) => created).sort()).toEqual([false, true]);
    await expect(
      pool.query<{ id: string }>(
        'SELECT id FROM tenant_exports WHERE tenant_id = $1 AND request_hash = $2',
        [tenantA.tenantId, requestHash],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  test('production PostgreSQL export persists and reads the exact object-storage version', async () => {
    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    if (Store === undefined) throw new Error('privacy store unavailable');
    const objects = new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock });
    const sessionToken = 's'.repeat(43);
    const readAuthenticatedTenantExportArchive = vi.fn((input: TenantExportArchiveReadRequest) => {
      if (input.sessionToken !== sessionToken) return Promise.resolve(null);
      return objects.readExportVersion({
        tenantId: input.context.tenantId,
        objectKey: input.expected.objectKey,
        objectVersionId: input.expected.objectVersionId,
      });
    });
    const store = new Store(pool, {
      objects,
      tenantExportReader: {
        readAuthenticatedTenantExportArchive,
      },
    }) as unknown as {
      saveTenantExport(input: {
        context: TenantContext;
        exportId: string;
        manifest: Record<string, unknown>;
        canonicalFiles: [];
        checksum: string;
        requestHash: string;
        createdAt: Date;
        auditEventId: string;
      }): Promise<{
        outcome: string;
        exportId?: string;
        archiveStatus?: string;
        archiveReady?: boolean;
        objectRef?: string | null;
      }>;
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
    const exportId = randomUUID();
    const manifest = {
      schemaVersion: '1.0.0',
      tenantId: tenantA.tenantId,
      timeRange: {
        from: '2018-01-01T00:00:00.000Z',
        to: '2018-01-02T00:00:00.000Z',
      },
      objects: [],
      files: [],
      disclosures: {
        tenantScope: TENANT_EXPORT_SCOPE_DISCLOSURE,
        integrity: TENANT_EXPORT_INTEGRITY_DISCLOSURE,
        noGuarantee: TENANT_EXPORT_NO_GUARANTEE_DISCLOSURE,
      },
    };
    const checksum = application.privacySha256(application.canonicalPrivacyJson(manifest));

    const saved = await store.saveTenantExport({
      context: tenantA.context,
      exportId,
      manifest,
      canonicalFiles: [],
      checksum,
      requestHash: sha256(`task18-s3-export:${exportId}`),
      createdAt: NOW,
      auditEventId: randomUUID(),
    });
    expect(saved).toMatchObject({
      outcome: 'SUCCEEDED',
      exportId,
      archiveStatus: 'READY',
      archiveReady: true,
    });
    expect(saved.objectRef).toContain('versionId=');

    const archive = await store.readTenantExportArchive({
      sessionToken,
      context: tenantA.context,
      exportId,
    });
    expect(archive).not.toBeNull();
    if (archive === null) throw new Error('exact export archive unavailable');
    expect(JSON.parse(new TextDecoder().decode(archive.body))).toMatchObject({
      schemaVersion: 'tenant-export-bundle.v1',
      manifest,
      files: [],
    });
    expect(archive.manifestChecksum).toBe(checksum);
    expect(archive.archiveChecksum).toBe(application.privacySha256(archive.body));
    expect(archive.filename).toBe(`tenant-export-${exportId}.json`);
    expect(readAuthenticatedTenantExportArchive).toHaveBeenCalledOnce();
    const readRequest = readAuthenticatedTenantExportArchive.mock.calls[0]?.[0];
    expect(readRequest?.sessionToken).toBe(sessionToken);
    expect(readRequest?.context).toEqual(tenantA.context);
    expect(readRequest?.authority).toEqual({ kind: 'TENANT_EXPORT', exportId });
    expect(readRequest?.expected.objectRef).toBe(saved.objectRef);
    expect(readRequest?.expected.objectKey).toBe(
      `tenants/${tenantA.tenantId}/exports/${exportId}.bundle.json`,
    );
    expect(readRequest?.expected.objectVersionId.length).toBeGreaterThan(0);
    expect(readRequest?.expected.checksum).toBe(archive.archiveChecksum);
    expect(objects.size).toBe(1);

    await expect(
      store.readTenantExportArchive({
        sessionToken,
        context: tenantB.context,
        exportId,
      }),
    ).resolves.toBeNull();
    expect(readAuthenticatedTenantExportArchive).toHaveBeenCalledTimes(1);

    await expect(
      store.readTenantExportArchive({
        sessionToken,
        context: { ...tenantA.context, workspaceId: tenantB.workspaceId },
        exportId,
      }),
    ).rejects.toThrow(/TENANT_SCOPE_NOT_ACTIVE|permission|not active/iu);
    expect(readAuthenticatedTenantExportArchive).toHaveBeenCalledTimes(1);

    await expect(
      store.readTenantExportArchive({
        sessionToken: 't'.repeat(43),
        context: tenantA.context,
        exportId,
      }),
    ).resolves.toBeNull();
    expect(readAuthenticatedTenantExportArchive).toHaveBeenCalledTimes(2);

    const persistedExport = await pool.query<{
      object_ref: string;
      object_version_id: string;
      object_checksum: string;
      managed_checksum: string;
    }>(
      `SELECT export.object_ref, export.object_version_id, export.object_checksum,
           object.checksum AS managed_checksum
         FROM tenant_exports export
         JOIN managed_object_versions object
           ON object.tenant_id = export.tenant_id
          AND object.object_key = $3
          AND object.object_version_id = export.object_version_id
         WHERE export.tenant_id = $1 AND export.id = $2`,
      [tenantA.tenantId, exportId, `tenants/${tenantA.tenantId}/exports/${exportId}.bundle.json`],
    );
    expect(persistedExport.rows).toHaveLength(1);
    expect(persistedExport.rows[0]).toMatchObject({
      object_checksum: archive.archiveChecksum,
      managed_checksum: archive.archiveChecksum,
    });
    expect(persistedExport.rows[0]?.object_ref).toContain('versionId=');
    expect(persistedExport.rows[0]?.object_version_id.length).toBeGreaterThan(0);
  });

  test('a durable export intent survives Put-before-finalize failure and is recovered without an HTTP retry', async () => {
    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    if (Store === undefined) throw new Error('privacy store unavailable');
    const delegate = new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock });
    const remembered = new Map<string, Awaited<ReturnType<typeof delegate.putExportVersion>>>();
    let crashAfterPut = true;
    const objects = {
      ...productionLikeLegalHoldStorage().objects,
      async putExportVersion(input: Parameters<typeof delegate.putExportVersion>[0]) {
        let object = remembered.get(input.objectKey);
        if (object === undefined) {
          object = await delegate.putExportVersion(input);
          remembered.set(input.objectKey, object);
        }
        if (crashAfterPut) {
          crashAfterPut = false;
          throw new Error('SIMULATED_PROCESS_CRASH_AFTER_PUT');
        }
        return object;
      },
      readExportVersion: delegate.readExportVersion.bind(delegate),
    } satisfies TenantExportObjectStorage & AuditEvidenceObjectLockStore;
    const store = new Store(pool, { objects });
    const exportId = randomUUID();
    const manifest = {
      schemaVersion: '1.0.0' as const,
      tenantId: tenantA.tenantId,
      timeRange: {
        from: '2018-02-01T00:00:00.000Z',
        to: '2018-02-02T00:00:00.000Z',
      },
      objects: [],
      files: [],
      disclosures: {
        tenantScope: TENANT_EXPORT_SCOPE_DISCLOSURE,
        integrity: TENANT_EXPORT_INTEGRITY_DISCLOSURE,
        noGuarantee: TENANT_EXPORT_NO_GUARANTEE_DISCLOSURE,
      },
    };
    const checksum = application.privacySha256(application.canonicalPrivacyJson(manifest));
    const requestHash = sha256(`durable-export:${exportId}`);

    await expect(
      store.saveTenantExport({
        context: tenantA.context,
        exportId,
        manifest,
        canonicalFiles: [],
        checksum,
        requestHash,
        createdAt: NOW,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      exportId,
      archiveStatus: 'PENDING',
      archiveReady: false,
    });

    const pending = await pool.query<{
      operation_id: string;
      object_key: string;
      status: string;
      canonical_payload: Buffer;
    }>(
      `SELECT operation_id, object_key, status, canonical_payload
       FROM privacy_object_write_intents
       WHERE tenant_id = $1 AND request_identity = $2`,
      [tenantA.tenantId, requestHash],
    );
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0]).toMatchObject({
      operation_id: exportId,
      object_key: `tenants/${tenantA.tenantId}/exports/${exportId}.bundle.json`,
      status: 'PENDING',
    });
    expect(pending.rows[0]?.canonical_payload.byteLength).toBeGreaterThan(0);
    expect(delegate.size).toBe(1);

    const recoveryStore = new Store(pool);
    const leaseToken = randomUUID();
    const [claim] = await recoveryStore.claimPendingPrivacyObjectWriteIntents({
      leaseToken,
      limit: 10,
    });
    expect(claim).toMatchObject({
      operationId: exportId,
      tenantId: tenantA.tenantId,
      objectKey: `tenants/${tenantA.tenantId}/exports/${exportId}.bundle.json`,
      leaseToken,
    });
    if (claim === undefined) throw new Error('durable export intent was not reclaimable');
    const recoveredObject = await objects.putExportVersion({
      tenantId: claim.tenantId,
      objectKey: claim.objectKey,
      body: claim.canonicalPayload,
      contentType: claim.contentType,
      checksum: claim.checksum,
    });
    await expect(
      recoveryStore.completePrivacyObjectWriteIntent({
        operationId: claim.operationId,
        leaseToken: claim.leaseToken,
        object: recoveredObject,
      }),
    ).resolves.toBe(true);

    await expect(
      pool.query<{ status: string; managed: string }>(
        `SELECT intent.status,
           (SELECT count(*)::text FROM managed_object_versions object
            WHERE object.tenant_id = intent.tenant_id
              AND object.object_key = intent.object_key
              AND object.object_version_id = intent.object_version_id) AS managed
         FROM privacy_object_write_intents intent
         WHERE intent.operation_id = $1`,
        [exportId],
      ),
    ).resolves.toMatchObject({ rows: [{ status: 'READY', managed: '1' }] });
    expect(delegate.size).toBe(1);
  });

  test('deletion cannot finalize until a complete version inventory discovers and deletes export orphans', async () => {
    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    if (Store === undefined) throw new Error('privacy store unavailable');
    const objects = new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock });
    const store = new Store(pool, { objects });
    const exportId = randomUUID();
    const manifest = {
      schemaVersion: '1.0.0' as const,
      tenantId: tenantInventoryDeletion.tenantId,
      timeRange: {
        from: '2013-01-01T00:00:00.000Z',
        to: '2013-01-02T00:00:00.000Z',
      },
      objects: [],
      files: [],
      disclosures: {
        tenantScope: TENANT_EXPORT_SCOPE_DISCLOSURE,
        integrity: TENANT_EXPORT_INTEGRITY_DISCLOSURE,
        noGuarantee: TENANT_EXPORT_NO_GUARANTEE_DISCLOSURE,
      },
    };
    const checksum = application.privacySha256(application.canonicalPrivacyJson(manifest));
    await expect(
      store.saveTenantExport({
        context: tenantInventoryDeletion.context,
        exportId,
        manifest,
        canonicalFiles: [],
        checksum,
        requestHash: sha256(`inventory-export:${exportId}`),
        createdAt: NOW,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED', archiveStatus: 'READY' });

    const orphanBody = new TextEncoder().encode('{"orphan":true}');
    const orphan = await objects.putExportVersion({
      tenantId: tenantInventoryDeletion.tenantId,
      objectKey: `tenants/${tenantInventoryDeletion.tenantId}/exports/orphan.bundle.json`,
      body: orphanBody,
      contentType: 'application/json',
      checksum: application.privacySha256(orphanBody),
    });
    const managed = (
      await pool.query<{ object_key: string; object_version_id: string }>(
        `SELECT object_key, object_version_id
         FROM managed_object_versions
         WHERE tenant_id = $1 AND object_class = 'TENANT_EXPORT'`,
        [tenantInventoryDeletion.tenantId],
      )
    ).rows[0];
    if (managed === undefined) throw new Error('managed export unavailable');

    const service = createPrivacyService('expected inventory-gated deletion');
    const deletion = await service.requestTenantDeletion({
      actorSubject: tenantInventoryDeletion.ownerSubject,
      tenantId: tenantInventoryDeletion.tenantId,
      workspaceId: tenantInventoryDeletion.workspaceId,
      reason: 'Prove no untracked privacy versions survive deletion.',
    });
    if (deletion.outcome !== 'SUCCEEDED') throw new Error('inventory deletion unavailable');
    await ageDeletionForTest(pool, deletion.receipt.id, new Date('2026-01-01T00:00:00.000Z'));
    await markSecretUnreadableForTest(
      pool,
      tenantInventoryDeletion.tenantId,
      tenantInventoryDeletion.authorizationId,
    );
    const leaseToken = await leaseDeletionForTest(pool, deletion.receipt.id);
    const databaseNow = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]
      ?.now;
    if (databaseNow === undefined) throw new Error('database clock unavailable');
    clock.set(databaseNow);
    try {
      await expect(
        service.finalizeDeletion({ requestId: deletion.receipt.id, leaseToken }),
      ).resolves.toMatchObject({ outcome: 'PIPELINE_UNAVAILABLE' });
      await expect(
        store.getDeletionObjectInventoryTarget({ requestId: deletion.receipt.id, leaseToken }),
      ).resolves.toMatchObject({
        outcome: 'REQUIRED',
        target: { tenantId: tenantInventoryDeletion.tenantId },
      });
      await expect(
        store.recordDeletionObjectInventory({
          requestId: deletion.receipt.id,
          leaseToken,
          exportVersions: [
            { objectKey: managed.object_key, objectVersionId: managed.object_version_id },
            { objectKey: orphan.objectKey, objectVersionId: orphan.objectVersionId },
          ],
          auditVersions: [],
        }),
      ).resolves.toBe(true);

      await objects.deleteExportVersion({
        tenantId: tenantInventoryDeletion.tenantId,
        objectKey: managed.object_key,
        objectVersionId: managed.object_version_id,
        at: databaseNow,
      });
      await store.markDeletionObjectVersionDeleted({
        requestId: deletion.receipt.id,
        leaseToken,
        tenantId: tenantInventoryDeletion.tenantId,
        objectKey: managed.object_key,
        objectVersionId: managed.object_version_id,
      });
      await expect(
        pool.query('SELECT * FROM finalize_deletion($1, $2, $3, $4, $5)', [
          deletion.receipt.id,
          leaseToken,
          databaseNow,
          randomUUID(),
          randomUUID(),
        ]),
      ).rejects.toThrow('PRIVACY_ORPHAN_OBJECT_DELETE_PROOF_REQUIRED');

      await objects.deleteExportVersion({
        tenantId: tenantInventoryDeletion.tenantId,
        objectKey: orphan.objectKey,
        objectVersionId: orphan.objectVersionId,
        at: databaseNow,
      });
      await store.markDeletionObjectVersionDeleted({
        requestId: deletion.receipt.id,
        leaseToken,
        tenantId: tenantInventoryDeletion.tenantId,
        objectKey: orphan.objectKey,
        objectVersionId: orphan.objectVersionId,
      });
      await expect(
        service.finalizeDeletion({ requestId: deletion.receipt.id, leaseToken }),
      ).resolves.toMatchObject({
        outcome: 'SUCCEEDED',
        finalization: { state: 'ACTIVE_DATA_DELETED' },
      });
      expect(objects.size).toBe(0);
    } finally {
      clock.set(NOW);
    }
  });

  test('a deletion freeze queued first wins the Tenant lock and prevents a concurrent audit intent', async () => {
    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    if (Store === undefined) throw new Error('privacy store unavailable');
    const objects = new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock });
    const store = new Store(pool, { objects });
    const service = createPrivacyService('expected serialized deletion freeze');
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE', [
        tenantFreezeRace.tenantId,
      ]);
      const deletionPromise = service
        .requestTenantDeletion({
          actorSubject: tenantFreezeRace.ownerSubject,
          tenantId: tenantFreezeRace.tenantId,
          workspaceId: tenantFreezeRace.workspaceId,
          reason: 'Serialize deletion against a concurrent privacy write.',
        })
        .then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
      const sealPromise = store
        .sealAuditDigest({
          context: tenantFreezeRace.context,
          digestId: randomUUID(),
          from: new Date('2012-01-01T00:00:00.000Z'),
          to: new Date('2012-01-02T00:00:00.000Z'),
          auditEventId: randomUUID(),
        })
        .then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
      await blocker.query('COMMIT');

      const deletion = await deletionPromise;
      const seal = await sealPromise;
      expect(deletion.error).toBeNull();
      expect(deletion.value).toMatchObject({ outcome: 'SUCCEEDED' });
      expect(seal.value).toBeNull();
      expect(String(seal.error)).toMatch(/TENANT_SCOPE_NOT_ACTIVE|not active/iu);
      await expect(
        pool.query(`SELECT 1 FROM privacy_object_write_intents WHERE tenant_id = $1`, [
          tenantFreezeRace.tenantId,
        ]),
      ).resolves.toMatchObject({ rowCount: 0 });
      expect(objects.size).toBe(0);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  test('an audit intent queued first commits before deletion and remains worker-recoverable', async () => {
    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    if (Store === undefined) throw new Error('privacy store unavailable');
    const objects = new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock });
    const store = new Store(pool, { objects });
    const service = createPrivacyService('expected durable intent before deletion');
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE', [
        tenantIntentRace.tenantId,
      ]);
      const sealPromise = store
        .sealAuditDigest({
          context: tenantIntentRace.context,
          digestId: randomUUID(),
          from: new Date('2011-01-01T00:00:00.000Z'),
          to: new Date('2011-01-02T00:00:00.000Z'),
          auditEventId: randomUUID(),
        })
        .then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
      const deletionPromise = service
        .requestTenantDeletion({
          actorSubject: tenantIntentRace.ownerSubject,
          tenantId: tenantIntentRace.tenantId,
          workspaceId: tenantIntentRace.workspaceId,
          reason: 'Wait for the earlier durable privacy intent.',
        })
        .then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
      await blocker.query('COMMIT');

      const [seal, deletion] = await Promise.all([sealPromise, deletionPromise]);
      expect(seal.error).toBeNull();
      expect(seal.value).toEqual({ outcome: 'PIPELINE_UNAVAILABLE' });
      expect(deletion.error).toBeNull();
      expect(deletion.value).toMatchObject({ outcome: 'SUCCEEDED' });
      expect(objects.size).toBe(0);

      const recoveryStore = new Store(pool);
      const leaseToken = randomUUID();
      const [claim] = await recoveryStore.claimPendingPrivacyObjectWriteIntents({
        leaseToken,
        limit: 10,
      });
      expect(claim).toMatchObject({
        tenantId: tenantIntentRace.tenantId,
        kind: 'AUDIT_DIGEST',
      });
      if (claim === undefined) throw new Error('concurrent audit intent was not recoverable');
      if (claim.lockedUntil === null) throw new Error('concurrent audit lock unavailable');
      const stored = await objects.putLockedAuditVersion({
        tenantId: claim.tenantId,
        objectKey: claim.objectKey,
        body: claim.canonicalPayload,
        contentType: claim.contentType,
        checksum: claim.checksum,
        lockedUntil: new Date(claim.lockedUntil),
      });
      await expect(
        recoveryStore.completePrivacyObjectWriteIntent({
          operationId: claim.operationId,
          leaseToken: claim.leaseToken,
          object: stored,
        }),
      ).resolves.toBe(true);
      expect(objects.size).toBe(1);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  test('production PostgreSQL audit seal persists the actual Object-Lock version and checksum', async () => {
    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    if (Store === undefined) throw new Error('privacy store unavailable');
    const objects = new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock });
    const store = new Store(pool, { objects }) as {
      sealAuditDigest(input: {
        context: TenantContext;
        digestId: string;
        from: Date;
        to: Date;
        auditEventId: string;
      }): Promise<{
        outcome: string;
        created?: boolean;
        digest?: {
          id: string;
          digestHash: string;
          objectRef: string;
          objectKey: string;
          objectVersionId: string;
          lockedUntil: string;
        };
      }>;
    };
    const digestId = randomUUID();
    const sealed = await store.sealAuditDigest({
      context: tenantA.context,
      digestId,
      from: new Date('2016-01-01T00:00:00.000Z'),
      to: new Date('2016-01-02T00:00:00.000Z'),
      auditEventId: randomUUID(),
    });
    expect(sealed).toMatchObject({
      outcome: 'SUCCEEDED',
      created: true,
      digest: {
        id: digestId,
      },
    });
    if (sealed.outcome !== 'SUCCEEDED' || sealed.digest === undefined) {
      throw new Error('Object-Lock digest unavailable');
    }
    expect(sealed.digest.objectRef).toContain('s3+memory://audit-evidence/');
    expect(sealed.digest.objectVersionId).not.toBe(digestId);
    const stored = await objects.readAuditVersion({
      tenantId: tenantA.tenantId,
      objectKey: sealed.digest.objectKey,
      objectVersionId: sealed.digest.objectVersionId,
    });
    expect(stored).not.toBeNull();
    if (stored === null) throw new Error('Object-Lock version unavailable');
    const body = JSON.parse(new TextDecoder().decode(stored.body)) as {
      digestHash: string;
      lockedUntil: string;
    };
    expect(body).toMatchObject({
      digestHash: sealed.digest.digestHash,
      lockedUntil: sealed.digest.lockedUntil,
    });
    expect(stored.object.lockedUntil).toBe(sealed.digest.lockedUntil);
    expect(objects.size).toBe(1);

    await expect(
      pool.query<{
        object_ref: string;
        object_version_id: string;
        checksum: string;
        locked_until: Date;
      }>(
        `SELECT digest.object_ref, digest.object_version_id, object.checksum,
           object.locked_until
         FROM audit_digests digest
         JOIN managed_object_versions object
           ON object.tenant_id = digest.tenant_id
          AND object.object_key = digest.object_key
          AND object.object_version_id = digest.object_version_id
         WHERE digest.tenant_id = $1 AND digest.id = $2`,
        [tenantA.tenantId, digestId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          object_ref: sealed.digest.objectRef,
          object_version_id: sealed.digest.objectVersionId,
          checksum: application.privacySha256(stored.body),
          locked_until: new Date(sealed.digest.lockedUntil),
        },
      ],
    });
  });

  test('audit sealing reuses the committed operation, key, payload, and audit time after an ambiguous Put', async () => {
    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    if (Store === undefined) throw new Error('privacy store unavailable');
    const delegate = new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock });
    const remembered = new Map<
      string,
      Awaited<ReturnType<typeof delegate.putLockedAuditVersion>>
    >();
    let crashAfterPut = true;
    const objects = {
      ...productionLikeLegalHoldStorage().objects,
      async putLockedAuditVersion(input: Parameters<typeof delegate.putLockedAuditVersion>[0]) {
        let object = remembered.get(input.objectKey);
        if (object === undefined) {
          object = await delegate.putLockedAuditVersion(input);
          remembered.set(input.objectKey, object);
        }
        if (crashAfterPut) {
          crashAfterPut = false;
          throw new Error('SIMULATED_AUDIT_CRASH_AFTER_PUT');
        }
        return object;
      },
      readAuditVersion: delegate.readAuditVersion.bind(delegate),
    } satisfies TenantExportObjectStorage & AuditEvidenceObjectLockStore;
    const store = new Store(pool, { objects });
    const range = {
      from: new Date('2014-01-01T00:00:00.000Z'),
      to: new Date('2014-01-02T00:00:00.000Z'),
    };
    const originalDigestId = randomUUID();

    await expect(
      store.sealAuditDigest({
        context: tenantA.context,
        digestId: originalDigestId,
        ...range,
        auditEventId: randomUUID(),
      }),
    ).resolves.toEqual({ outcome: 'PIPELINE_UNAVAILABLE' });

    const before = await pool.query<{
      operation_id: string;
      object_key: string;
      canonical_payload: Buffer;
      checksum: string;
      sealed_at: Date;
      locked_until: Date;
    }>(
      `SELECT operation_id, object_key, canonical_payload, checksum, sealed_at, locked_until
       FROM privacy_object_write_intents
       WHERE tenant_id = $1 AND kind = 'AUDIT_DIGEST'
         AND business_payload->>'rangeFrom' = $2
         AND business_payload->>'rangeTo' = $3`,
      [tenantA.tenantId, range.from.toISOString(), range.to.toISOString()],
    );
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0]).toMatchObject({
      operation_id: originalDigestId,
      object_key: `tenants/${tenantA.tenantId}/audit-digests/${originalDigestId}.json`,
    });
    expect(delegate.size).toBe(1);

    await pool.query('SELECT pg_sleep(0.02)');
    const retry = await store.sealAuditDigest({
      context: tenantA.context,
      digestId: randomUUID(),
      ...range,
      auditEventId: randomUUID(),
    });
    expect(retry).toMatchObject({
      outcome: 'SUCCEEDED',
      digest: { id: originalDigestId },
    });
    if (retry.outcome !== 'SUCCEEDED') throw new Error('audit retry did not converge');

    const after = await pool.query<{
      operation_id: string;
      object_key: string;
      canonical_payload: Buffer;
      checksum: string;
      sealed_at: Date;
      locked_until: Date;
      status: string;
      audit_occurred_at: Date;
    }>(
      `SELECT intent.operation_id, intent.object_key, intent.canonical_payload,
         intent.checksum, intent.sealed_at, intent.locked_until, intent.status,
         event.occurred_at AS audit_occurred_at
       FROM privacy_object_write_intents intent
       JOIN audit_events event ON event.id = intent.audit_event_id
       WHERE intent.operation_id = $1`,
      [originalDigestId],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.object_key).toBe(before.rows[0]?.object_key);
    expect(after.rows[0]?.checksum).toBe(before.rows[0]?.checksum);
    expect(after.rows[0]?.canonical_payload.equals(before.rows[0]!.canonical_payload)).toBe(true);
    expect(after.rows[0]?.sealed_at).toEqual(before.rows[0]?.sealed_at);
    expect(after.rows[0]?.locked_until).toEqual(before.rows[0]?.locked_until);
    expect(after.rows[0]?.audit_occurred_at).toEqual(before.rows[0]?.sealed_at);
    expect(after.rows[0]?.status).toBe('READY');
    expect(delegate.size).toBe(1);
  });

  test('concurrent production audit seals create only one immutable object version', async () => {
    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    if (Store === undefined) throw new Error('privacy store unavailable');
    const objects = new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock });
    const putLockedAuditVersion = objects.putLockedAuditVersion.bind(objects);
    let firstPut = true;
    vi.spyOn(objects, 'putLockedAuditVersion').mockImplementation(async (input) => {
      if (firstPut) {
        firstPut = false;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return putLockedAuditVersion(input);
    });
    const store = new Store(pool, { objects }) as {
      sealAuditDigest(input: {
        context: TenantContext;
        digestId: string;
        from: Date;
        to: Date;
        auditEventId: string;
      }): Promise<{
        outcome: string;
        created?: boolean;
        digest?: { id: string; objectVersionId: string };
      }>;
    };
    const range = {
      from: new Date('2015-01-01T00:00:00.000Z'),
      to: new Date('2015-01-02T00:00:00.000Z'),
    };
    const [left, right] = await Promise.all([
      store.sealAuditDigest({
        context: tenantA.context,
        digestId: randomUUID(),
        ...range,
        auditEventId: randomUUID(),
      }),
      store.sealAuditDigest({
        context: tenantA.context,
        digestId: randomUUID(),
        ...range,
        auditEventId: randomUUID(),
      }),
    ]);

    expect(left.outcome).toBe('SUCCEEDED');
    expect(right.outcome).toBe('SUCCEEDED');
    expect(left.digest?.id).toBe(right.digest?.id);
    expect(left.digest?.objectVersionId).toBe(right.digest?.objectVersionId);
    expect([left.created, right.created].sort()).toEqual([false, true]);
    expect(objects.size).toBe(1);
  });

  test('Owner exports only its Tenant with a versioned manifest and verified object hashes', async () => {
    const service = createPrivacyService('expected tenant-only export');
    const previousClock = clock.now();
    try {
      const secondWorkspaceId = randomUUID();
      await pool.query(
        `INSERT INTO workspaces (id, tenant_id, name, created_at)
       VALUES ($1, $2, 'Tenant-wide export workspace', $3)`,
        [secondWorkspaceId, tenantA.tenantId, NOW],
      );
      await pool.query(
        `INSERT INTO role_bindings (id, tenant_id, workspace_id, membership_id, role, created_at)
       VALUES ($1, $2, $3, $4, 'OWNER', $5)`,
        [randomUUID(), tenantA.tenantId, secondWorkspaceId, tenantA.context.membershipId, NOW],
      );
      const secondWorkspaceAuditId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM audit_events
         WHERE tenant_id = $1 AND workspace_id = $2 AND action = 'AUTH_SESSION_STARTED'`,
          [tenantA.tenantId, secondWorkspaceId],
        )
      ).rows[0]?.id;
      if (secondWorkspaceAuditId === undefined) throw new Error('second workspace audit missing');

      const auditEvents = await pool.query<{ id: string; occurred_at: Date }>(
        `SELECT id, occurred_at
         FROM audit_events
         WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenantA.tenantId, [tenantA.auditEventId, secondWorkspaceAuditId]],
      );
      expect(auditEvents.rows).toHaveLength(2);
      const earliestAuditAt = Math.min(
        ...auditEvents.rows.map(({ occurred_at: occurredAt }) => occurredAt.getTime()),
      );
      const latestAuditAt = Math.max(
        ...auditEvents.rows.map(({ occurred_at: occurredAt }) => occurredAt.getTime()),
      );
      const databaseNow = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now'))
        .rows[0]?.now;
      if (databaseNow === undefined) throw new Error('database clock unavailable');
      const exportClock = new Date(Math.max(databaseNow.getTime(), latestAuditAt + 2));
      clock.set(exportClock);

      const from = new Date(earliestAuditAt - 1).toISOString();
      const to = new Date(latestAuditAt + 1).toISOString();
      const result = await service.exportTenant({
        actorSubject: tenantA.ownerSubject,
        tenantId: tenantA.tenantId,
        workspaceId: tenantA.workspaceId,
        from,
        to,
      });
      expect(result.outcome).toBe('SUCCEEDED');
      if (result.outcome !== 'SUCCEEDED') throw new Error('expected tenant-only export');

      expect(result.export.manifest).toMatchObject({
        schemaVersion: '1.0.0',
        tenantId: tenantA.tenantId,
        timeRange: { from, to },
      });
      expect(result.export.manifest.objects.length).toBeGreaterThan(0);
      expect(result.export.manifest.objects).toEqual(
        [...result.export.manifest.objects].sort((left, right) =>
          `${left.kind}:${left.objectId}`.localeCompare(`${right.kind}:${right.objectId}`),
        ),
      );
      for (const object of result.export.manifest.objects) {
        expect(object.kind.length).toBeGreaterThan(0);
        expect(object.objectId.length).toBeGreaterThan(0);
        expect(object.contentHash).toMatch(/^[a-f0-9]{64}$/u);
      }
      expect(result.export.manifest.objects.map(({ objectId }) => objectId)).toEqual(
        expect.arrayContaining([tenantA.auditEventId, secondWorkspaceAuditId]),
      );
      expect(result.export.checksum).toBe(sha256(canonicalJson(result.export.manifest)));
      expect(result.export).toMatchObject({
        archiveStatus: 'PENDING',
        archiveReady: false,
        objectRef: null,
      });
      expect(result.export.createdAt).toBe(exportClock.toISOString());

      const serialized = canonicalJson(result.export);
      expect(serialized).not.toContain(tenantB.tenantId);
      expect(serialized).not.toContain(tenantB.workspaceId);
      expect(serialized).not.toContain(tenantA.secretArn);
      expect(serialized).not.toContain(tenantB.secretArn);
      expect(serialized).not.toMatch(/secret_arn/iu);

      const crossTenant = await service.exportTenant({
        actorSubject: tenantA.ownerSubject,
        tenantId: tenantB.tenantId,
        workspaceId: tenantB.workspaceId,
        from,
        to,
      });
      expect(['FORBIDDEN', 'NOT_FOUND']).toContain(crossTenant.outcome);
    } finally {
      clock.set(previousClock);
    }
  });

  test('active deletion removes PostgreSQL export metadata without ever storing canonical payloads', async () => {
    const marker = `private-export-body-${randomUUID()}`;
    const profileId = randomUUID();
    const profileRevisionId = randomUUID();
    const profileCreatedAt = new Date(NOW.getTime() - DAY_MS);
    await pool.query(
      `INSERT INTO profiles (id, tenant_id, workspace_id, current_revision, created_at)
       VALUES ($1, $2, $3, 1, $4)`,
      [
        profileId,
        tenantExportDeletion.tenantId,
        tenantExportDeletion.workspaceId,
        profileCreatedAt,
      ],
    );
    await pool.query(
      `INSERT INTO profile_revisions
        (id, tenant_id, workspace_id, profile_id, revision, content_hash, content,
          completeness, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, '{}'::jsonb, $7, $8)`,
      [
        profileRevisionId,
        tenantExportDeletion.tenantId,
        tenantExportDeletion.workspaceId,
        profileId,
        sha256(marker),
        JSON.stringify({ privateDescription: marker }),
        tenantExportDeletion.ownerUserId,
        profileCreatedAt,
      ],
    );
    const service = createPrivacyService('expected export metadata lifecycle deletion');
    const exported = await service.exportTenant({
      actorSubject: tenantExportDeletion.ownerSubject,
      tenantId: tenantExportDeletion.tenantId,
      workspaceId: tenantExportDeletion.workspaceId,
      from: '2026-07-21T00:00:00.000Z',
      to: new Date(NOW.getTime() - 1).toISOString(),
    });
    if (exported.outcome !== 'SUCCEEDED') throw new Error('expected export before deletion');
    expect(exported.export.manifest.objects).toContainEqual(
      expect.objectContaining({ kind: 'PROFILE_REVISION', objectId: profileRevisionId }),
    );
    await expect(
      pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'tenant_exports'
           AND column_name = 'canonical_files'`,
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      pool.query<{ contains_payload: boolean }>(
        `SELECT manifest::text LIKE '%' || $2 || '%' AS contains_payload
         FROM tenant_exports WHERE tenant_id = $1 AND id = $3`,
        [tenantExportDeletion.tenantId, marker, exported.export.id],
      ),
    ).resolves.toMatchObject({ rows: [{ contains_payload: false }] });

    await pool.query(
      `UPDATE auth_sessions SET created_at = $2, last_seen_at = $2 WHERE token_digest = $1`,
      [tenantExportDeletion.sessionTokenDigest, new Date('2025-12-01T00:00:00.000Z')],
    );
    try {
      clock.set(new Date('2026-01-01T00:00:00.000Z'));
      const deletion = await service.requestTenantDeletion({
        actorSubject: tenantExportDeletion.ownerSubject,
        tenantId: tenantExportDeletion.tenantId,
        workspaceId: tenantExportDeletion.workspaceId,
        reason: 'Remove export metadata with the active Tenant data plane.',
      });
      if (deletion.outcome !== 'SUCCEEDED') throw new Error('expected export Tenant deletion');
      await ageDeletionForTest(pool, deletion.receipt.id, new Date('2026-01-01T00:00:00.000Z'));
      await markSecretUnreadableForTest(
        pool,
        tenantExportDeletion.tenantId,
        tenantExportDeletion.authorizationId,
      );
      const databaseNow = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now'))
        .rows[0]?.now;
      if (databaseNow === undefined) throw new Error('database clock unavailable');
      clock.set(databaseNow);
      const activeLease = await leaseDeletionForTest(pool, deletion.receipt.id);
      await expect(
        service.finalizeDeletion({ requestId: deletion.receipt.id, leaseToken: activeLease }),
      ).resolves.toMatchObject({
        outcome: 'SUCCEEDED',
        finalization: { state: 'ACTIVE_DATA_DELETED' },
      });
      await expect(
        pool.query(
          `SELECT 1 FROM tenant_exports WHERE tenant_id = $1
           UNION ALL SELECT 1 FROM tenant_export_items WHERE tenant_id = $1`,
          [tenantExportDeletion.tenantId],
        ),
      ).resolves.toMatchObject({ rowCount: 0 });
      await expect(
        pool.query<{ tenant_name: string; workspace_name: string }>(
          `SELECT tenant.name AS tenant_name, workspace.name AS workspace_name
           FROM tenants tenant
           JOIN workspaces workspace ON workspace.tenant_id = tenant.id
           WHERE tenant.id = $1 AND workspace.id = $2`,
          [tenantExportDeletion.tenantId, tenantExportDeletion.workspaceId],
        ),
      ).resolves.toMatchObject({
        rows: [{ tenant_name: 'Deleted tenant', workspace_name: 'Deleted workspace' }],
      });
      const secretDeletionRows = await pool.query<{
        secret_reference: string | null;
        secret_reference_hash: string;
        serialized: string;
      }>(
        `SELECT secret_reference, secret_reference_hash,
           to_jsonb(secret)::text AS serialized
         FROM connector_secret_deletions secret
         WHERE tenant_id = $1 AND channel_authorization_id = $2`,
        [tenantExportDeletion.tenantId, tenantExportDeletion.authorizationId],
      );
      expect(secretDeletionRows.rows).toHaveLength(1);
      expect(secretDeletionRows.rows[0]).toMatchObject({
        secret_reference: null,
        secret_reference_hash: sha256(tenantExportDeletion.secretArn),
      });
      expect(secretDeletionRows.rows[0]?.serialized).not.toContain(tenantExportDeletion.secretArn);
    } finally {
      clock.set(NOW);
    }
  });

  test('workspace deletion removes tenant-wide exports created elsewhere and governs every TENANT_EXPORT version', async () => {
    const service = createPrivacyService('expected tenant-wide export deletion semantics');
    const workspaceB = randomUUID();
    await pool.query(
      `INSERT INTO workspaces (id, tenant_id, name, created_at)
       VALUES ($1, $2, 'Tenant export creator workspace', $3)`,
      [workspaceB, tenantWorkspaceExportDeletion.tenantId, NOW],
    );
    await pool.query(
      `INSERT INTO role_bindings (id, tenant_id, workspace_id, membership_id, role, created_at)
       VALUES ($1, $2, $3, $4, 'OWNER', $5)`,
      [
        randomUUID(),
        tenantWorkspaceExportDeletion.tenantId,
        workspaceB,
        tenantWorkspaceExportDeletion.context.membershipId,
        NOW,
      ],
    );

    const marker = `workspace-a-private-export-${randomUUID()}`;
    const profileId = randomUUID();
    const profileRevisionId = randomUUID();
    await pool.query(
      `INSERT INTO profiles (id, tenant_id, workspace_id, current_revision, created_at)
       VALUES ($1, $2, $3, 1, $4)`,
      [
        profileId,
        tenantWorkspaceExportDeletion.tenantId,
        tenantWorkspaceExportDeletion.workspaceId,
        new Date(NOW.getTime() - DAY_MS),
      ],
    );
    await pool.query(
      `INSERT INTO profile_revisions
        (id, tenant_id, workspace_id, profile_id, revision, content_hash, content,
          completeness, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, '{}'::jsonb, $7, $8)`,
      [
        profileRevisionId,
        tenantWorkspaceExportDeletion.tenantId,
        tenantWorkspaceExportDeletion.workspaceId,
        profileId,
        sha256(marker),
        JSON.stringify({ privateDescription: marker }),
        tenantWorkspaceExportDeletion.ownerUserId,
        new Date(NOW.getTime() - DAY_MS),
      ],
    );

    const exported = await service.exportTenant({
      actorSubject: tenantWorkspaceExportDeletion.ownerSubject,
      tenantId: tenantWorkspaceExportDeletion.tenantId,
      workspaceId: workspaceB,
      from: new Date(NOW.getTime() - 2 * DAY_MS).toISOString(),
      to: new Date(NOW.getTime() - 1).toISOString(),
    });
    if (exported.outcome !== 'SUCCEEDED') throw new Error('expected Workspace B export');
    expect(exported.export.manifest.objects).toContainEqual(
      expect.objectContaining({ kind: 'PROFILE_REVISION', objectId: profileRevisionId }),
    );
    await expect(
      pool.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM tenant_exports WHERE tenant_id = $1 AND id = $2',
        [tenantWorkspaceExportDeletion.tenantId, exported.export.id],
      ),
    ).resolves.toMatchObject({ rows: [{ workspace_id: workspaceB }] });
    await expect(
      pool.query(
        `SELECT 1 FROM tenant_export_items
         WHERE tenant_id = $1 AND export_id = $2 AND source_object_id = $3`,
        [tenantWorkspaceExportDeletion.tenantId, exported.export.id, profileRevisionId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    const otherTenantExportId = randomUUID();
    const otherTenantManifest = {
      schemaVersion: '1.0.0',
      tenantId: tenantA.tenantId,
      timeRange: {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-02T00:00:00.000Z',
      },
      objects: [],
      files: [],
      disclosures: {},
    };
    await pool.query(
      `INSERT INTO tenant_exports
        (id, tenant_id, workspace_id, schema_version, status, requested_by_user_id,
          request_hash, requested_at, range_from, range_to, manifest, checksum)
       VALUES ($1, $2, $3, '1.0.0', 'ARCHIVE_PENDING', $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [
        otherTenantExportId,
        tenantA.tenantId,
        tenantA.workspaceId,
        tenantA.ownerUserId,
        sha256(`other-tenant-export:${otherTenantExportId}`),
        NOW,
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-01-02T00:00:00.000Z'),
        JSON.stringify(otherTenantManifest),
        sha256(JSON.stringify(otherTenantManifest)),
      ],
    );

    const exportObjectKey = `tenants/${tenantWorkspaceExportDeletion.tenantId}/exports/${exported.export.id}.zip`;
    const heldVersion = 'held-v1';
    const unheldVersion = 'unheld-v2';
    const businessObjectKey = `tenants/${tenantWorkspaceExportDeletion.tenantId}/workspaces/${workspaceB}/business.json`;
    const otherTenantObjectKey = `tenants/${tenantA.tenantId}/exports/${otherTenantExportId}.zip`;
    for (const object of [
      {
        tenantId: tenantWorkspaceExportDeletion.tenantId,
        workspaceId: workspaceB,
        objectClass: 'TENANT_EXPORT',
        storageClass: 'TENANT_EXPORTS',
        objectKey: exportObjectKey,
        objectVersionId: heldVersion,
      },
      {
        tenantId: tenantWorkspaceExportDeletion.tenantId,
        workspaceId: workspaceB,
        objectClass: 'TENANT_EXPORT',
        storageClass: 'TENANT_EXPORTS',
        objectKey: exportObjectKey,
        objectVersionId: unheldVersion,
      },
      {
        tenantId: tenantWorkspaceExportDeletion.tenantId,
        workspaceId: workspaceB,
        objectClass: 'APPLICATION_LOG',
        storageClass: 'WORKLOAD_OBJECTS',
        objectKey: businessObjectKey,
        objectVersionId: 'business-v1',
      },
      {
        tenantId: tenantA.tenantId,
        workspaceId: tenantA.workspaceId,
        objectClass: 'TENANT_EXPORT',
        storageClass: 'TENANT_EXPORTS',
        objectKey: otherTenantObjectKey,
        objectVersionId: 'other-v1',
      },
    ]) {
      await pool.query(
        `INSERT INTO managed_object_versions
          (id, tenant_id, workspace_id, object_class, object_ref, object_key,
            object_version_id, checksum, content_type, byte_length, lifecycle_state,
            created_at, expires_at, locked_until, deletion_request_id, deleted_at,
            storage_class)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'application/zip', 10,
           'ACTIVE', $9, NULL, NULL, NULL, NULL, $10)`,
        [
          randomUUID(),
          object.tenantId,
          object.workspaceId,
          object.objectClass,
          `s3://tenant-exports/${object.tenantId}/${randomUUID()}`,
          object.objectKey,
          object.objectVersionId,
          sha256(`${object.objectKey}:${object.objectVersionId}`),
          NOW,
          object.storageClass,
        ],
      );
    }

    const hold = await service.createLegalHold({
      actorSubject: tenantWorkspaceExportDeletion.ownerSubject,
      tenantId: tenantWorkspaceExportDeletion.tenantId,
      workspaceId: workspaceB,
      name: 'Hold one tenant export version',
      reason: 'Preserve only the exact held archive version during Workspace deletion.',
      objectKey: exportObjectKey,
      objectVersionId: heldVersion,
    });
    if (hold.outcome !== 'SUCCEEDED') throw new Error('expected exact tenant export hold');

    const requestedAt = new Date('2026-01-01T00:00:00.000Z');
    const deletion = await service.requestWorkspaceDeletion({
      actorSubject: tenantWorkspaceExportDeletion.ownerSubject,
      tenantId: tenantWorkspaceExportDeletion.tenantId,
      workspaceId: tenantWorkspaceExportDeletion.workspaceId,
      reason: 'Delete Workspace A including every tenant-wide derived export.',
    });
    if (deletion.outcome !== 'SUCCEEDED') throw new Error('expected Workspace A deletion');
    await ageDeletionForTest(pool, deletion.receipt.id, requestedAt);
    await markSecretUnreadableForTest(
      pool,
      tenantWorkspaceExportDeletion.tenantId,
      tenantWorkspaceExportDeletion.authorizationId,
    );
    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    if (Store === undefined) throw new Error('privacy store unavailable');
    const schedulerStore = new Store(pool) as BackupDeletionEvidenceStore & {
      claimDueDeletionRequests(input: {
        leaseToken: string;
        limit: number;
      }): Promise<Array<{ requestId: string; stage: 'ACTIVE' | 'BACKUP' | 'TOMBSTONE' }>>;
    };
    const databaseNow = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]
      ?.now;
    if (databaseNow === undefined) throw new Error('database clock unavailable');
    try {
      clock.set(databaseNow);
      const activeLease = randomUUID();
      await expect(
        schedulerStore.claimDueDeletionRequests({ leaseToken: activeLease, limit: 100 }),
      ).resolves.toContainEqual(
        expect.objectContaining({ requestId: deletion.receipt.id, stage: 'ACTIVE' }),
      );
      await provePhysicalObjectDeletionForTest(pool, deletion.receipt.id, activeLease);
      await expect(
        service.finalizeDeletion({ requestId: deletion.receipt.id, leaseToken: activeLease }),
      ).resolves.toMatchObject({
        outcome: 'SUCCEEDED',
        finalization: { state: 'ACTIVE_DATA_DELETED' },
      });

      await expect(
        pool.query(
          `SELECT 1 FROM tenant_exports WHERE tenant_id = $1 AND id = $2
           UNION ALL
           SELECT 1 FROM tenant_export_items WHERE tenant_id = $1 AND export_id = $2`,
          [tenantWorkspaceExportDeletion.tenantId, exported.export.id],
        ),
      ).resolves.toMatchObject({ rowCount: 0 });
      await expect(
        pool.query('SELECT 1 FROM tenant_exports WHERE tenant_id = $1 AND id = $2', [
          tenantA.tenantId,
          otherTenantExportId,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });

      const activeStates = await pool.query<{
        object_key: string;
        object_version_id: string;
        lifecycle_state: string;
        deletion_request_id: string | null;
      }>(
        `SELECT object_key, object_version_id, lifecycle_state, deletion_request_id
         FROM managed_object_versions
         WHERE (tenant_id = $1 AND object_key IN ($2, $3))
            OR (tenant_id = $4 AND object_key = $5)
         ORDER BY object_key, object_version_id`,
        [
          tenantWorkspaceExportDeletion.tenantId,
          exportObjectKey,
          businessObjectKey,
          tenantA.tenantId,
          otherTenantObjectKey,
        ],
      );
      expect(activeStates.rows).toContainEqual({
        object_key: exportObjectKey,
        object_version_id: heldVersion,
        lifecycle_state: 'LEGAL_HOLD',
        deletion_request_id: deletion.receipt.id,
      });
      expect(activeStates.rows).toContainEqual({
        object_key: exportObjectKey,
        object_version_id: unheldVersion,
        lifecycle_state: 'DELETED',
        deletion_request_id: deletion.receipt.id,
      });
      expect(activeStates.rows).toContainEqual({
        object_key: businessObjectKey,
        object_version_id: 'business-v1',
        lifecycle_state: 'ACTIVE',
        deletion_request_id: null,
      });
      expect(activeStates.rows).toContainEqual({
        object_key: otherTenantObjectKey,
        object_version_id: 'other-v1',
        lifecycle_state: 'ACTIVE',
        deletion_request_id: null,
      });
      const workspaceStates = await pool.query<{ id: string; lifecycle_state: string }>(
        `SELECT id, lifecycle_state FROM workspaces
         WHERE tenant_id = $1 AND id IN ($2, $3)`,
        [
          tenantWorkspaceExportDeletion.tenantId,
          tenantWorkspaceExportDeletion.workspaceId,
          workspaceB,
        ],
      );
      expect(workspaceStates.rows).toContainEqual({
        id: tenantWorkspaceExportDeletion.workspaceId,
        lifecycle_state: 'ACTIVE_DATA_DELETED',
      });
      expect(workspaceStates.rows).toContainEqual({ id: workspaceB, lifecycle_state: 'ACTIVE' });

      const blockedLease = randomUUID();
      await expect(
        schedulerStore.claimDueDeletionRequests({ leaseToken: blockedLease, limit: 100 }),
      ).resolves.toContainEqual(
        expect.objectContaining({ requestId: deletion.receipt.id, stage: 'BACKUP' }),
      );
      await expect(
        service.finalizeDeletion({ requestId: deletion.receipt.id, leaseToken: blockedLease }),
      ).resolves.toMatchObject({ outcome: 'LEGAL_HOLD' });
      const blockedStates = await pool.query<{
        object_version_id: string;
        lifecycle_state: string;
      }>(
        `SELECT object_version_id, lifecycle_state FROM managed_object_versions
         WHERE tenant_id = $1 AND object_key = $2 ORDER BY object_version_id`,
        [tenantWorkspaceExportDeletion.tenantId, exportObjectKey],
      );
      expect(blockedStates.rows).toEqual([
        { object_version_id: heldVersion, lifecycle_state: 'LEGAL_HOLD' },
        { object_version_id: unheldVersion, lifecycle_state: 'DELETED' },
      ]);
      const heldClaims = await schedulerStore.claimDueDeletionRequests({
        leaseToken: randomUUID(),
        limit: 100,
      });
      expect(heldClaims.some(({ requestId }) => requestId === deletion.receipt.id)).toBe(false);

      await expect(
        service.releaseLegalHold({
          actorSubject: tenantWorkspaceExportDeletion.ownerSubject,
          tenantId: tenantWorkspaceExportDeletion.tenantId,
          workspaceId: workspaceB,
          holdId: hold.hold.id,
        }),
      ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
      const retryLease = randomUUID();
      await expect(
        schedulerStore.claimDueDeletionRequests({ leaseToken: retryLease, limit: 100 }),
      ).resolves.toContainEqual(
        expect.objectContaining({ requestId: deletion.receipt.id, stage: 'BACKUP' }),
      );
      await provePhysicalObjectDeletionForTest(pool, deletion.receipt.id, retryLease);
      await expect(
        service.finalizeDeletion({ requestId: deletion.receipt.id, leaseToken: retryLease }),
      ).resolves.toEqual({ outcome: 'PIPELINE_UNAVAILABLE' });
      const tamperedTarget = await schedulerStore.getBackupDeletionVerificationTarget({
        requestId: deletion.receipt.id,
        leaseToken: retryLease,
      });
      if (tamperedTarget.outcome !== 'SUCCEEDED') {
        throw new Error(`backup target unavailable: ${tamperedTarget.outcome}`);
      }
      const tamperedVerifiedAt = (
        await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')
      ).rows[0]?.now;
      if (tamperedVerifiedAt === undefined) throw new Error('database clock unavailable');
      const tamperedCanonicalJson = canonicalJson({
        inventoryMethod: 'ListRecoveryPointsByResource',
        managedByAWSBackupOnly: false,
        requestId: deletion.receipt.id.toLowerCase(),
        schemaVersion: '2.0.0',
        sourceDeletedAt: tamperedTarget.target.sourceDeletedAt,
        verifiedAt: tamperedVerifiedAt.toISOString(),
      });
      await expect(
        schedulerStore.recordBackupDeletionVerification({
          requestId: deletion.receipt.id,
          leaseToken: retryLease,
          evidenceCanonicalJson: tamperedCanonicalJson,
          evidenceHash: sha256(`${tamperedCanonicalJson}:tampered`),
          sourceDeletedAt: new Date(tamperedTarget.target.sourceDeletedAt),
          verifiedAt: tamperedVerifiedAt,
        }),
      ).resolves.toBe(false);
      const proof = await recordBackupDeletionProofForTest(
        schedulerStore,
        pool,
        deletion.receipt.id,
        retryLease,
      );
      await expect(
        service.finalizeDeletion({ requestId: deletion.receipt.id, leaseToken: retryLease }),
      ).resolves.toMatchObject({
        outcome: 'SUCCEEDED',
        finalization: { state: 'BACKUP_DELETED' },
      });
      await expect(
        pool.query<{
          evidence_hash: string;
          evidence_canonical_json: string;
          evidence_source_deleted_at: Date;
          evidence_verified_at: Date;
        }>(
          `SELECT evidence_hash, evidence_canonical_json,
             evidence_source_deleted_at, evidence_verified_at
           FROM deletion_tombstones
           WHERE deletion_request_id = $1 AND plane = 'BACKUP'`,
          [deletion.receipt.id],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            evidence_hash: proof.evidenceHash,
            evidence_canonical_json: proof.evidenceCanonicalJson,
            evidence_source_deleted_at: new Date(proof.sourceDeletedAt),
            evidence_verified_at: proof.verifiedAt,
          },
        ],
      });
      await expect(
        pool.query<{ lifecycle_state: string }>(
          `SELECT lifecycle_state FROM managed_object_versions
           WHERE tenant_id = $1 AND object_key = $2 AND object_version_id = $3`,
          [tenantWorkspaceExportDeletion.tenantId, exportObjectKey, heldVersion],
        ),
      ).resolves.toMatchObject({ rows: [{ lifecycle_state: 'DELETED' }] });
    } finally {
      clock.set(NOW);
    }
  });

  test('an Owner cannot create a legal hold for a missing or cross-scope object version', async () => {
    const service = createPrivacyService('expected exact managed object before legal hold');
    const otherWorkspaceId = randomUUID();
    const crossWorkspaceKey = `tenants/${tenantA.tenantId}/workspaces/${otherWorkspaceId}/cross-workspace.json`;
    const crossTenantKey = `tenants/${tenantB.tenantId}/workspaces/${tenantB.workspaceId}/cross-tenant.json`;
    const crossWorkspaceVersion = randomUUID();
    const crossTenantVersion = randomUUID();
    await pool.query(
      `INSERT INTO workspaces (id, tenant_id, name, created_at)
       VALUES ($1, $2, 'Legal hold target isolation', $3)`,
      [otherWorkspaceId, tenantA.tenantId, NOW],
    );
    await pool.query(
      `INSERT INTO managed_object_versions
        (id, tenant_id, workspace_id, object_class, object_ref, object_key, object_version_id,
          checksum, content_type, byte_length, lifecycle_state, created_at, expires_at,
          locked_until, deletion_request_id, deleted_at, storage_class)
       VALUES
        ($1, $2, $3, 'APPLICATION_LOG', $4, $5, $6, $7, 'application/json', 10,
          'ACTIVE', $8, NULL, NULL, NULL, NULL, 'WORKLOAD_OBJECTS'),
        ($9, $10, $11, 'APPLICATION_LOG', $12, $13, $14, $15, 'application/json', 10,
          'ACTIVE', $8, NULL, NULL, NULL, NULL, 'WORKLOAD_OBJECTS')`,
      [
        randomUUID(),
        tenantA.tenantId,
        otherWorkspaceId,
        `s3://audit-evidence/${randomUUID()}`,
        crossWorkspaceKey,
        crossWorkspaceVersion,
        sha256(crossWorkspaceKey),
        NOW,
        randomUUID(),
        tenantB.tenantId,
        tenantB.workspaceId,
        `s3://audit-evidence/${randomUUID()}`,
        crossTenantKey,
        crossTenantVersion,
        sha256(crossTenantKey),
      ],
    );

    for (const target of [
      {
        objectKey: `tenants/${tenantA.tenantId}/workspaces/${tenantA.workspaceId}/missing.json`,
        objectVersionId: randomUUID(),
        expectedOutcome: 'OBJECT_NOT_FOUND',
      },
      {
        objectKey: crossWorkspaceKey,
        objectVersionId: crossWorkspaceVersion,
        expectedOutcome: 'OBJECT_NOT_FOUND',
      },
      {
        objectKey: crossTenantKey,
        objectVersionId: crossTenantVersion,
        expectedOutcome: 'INVALID_HOLD',
      },
    ]) {
      await expect(
        service.createLegalHold({
          actorSubject: tenantA.ownerSubject,
          tenantId: tenantA.tenantId,
          workspaceId: tenantA.workspaceId,
          name: 'Exact managed object required',
          reason: 'A guessed object target must not create preservation evidence.',
          objectKey: target.objectKey,
          objectVersionId: target.objectVersionId,
        }),
      ).resolves.toEqual({ outcome: target.expectedOutcome });
    }

    await expect(
      service.listLegalHolds({
        actorSubject: tenantA.ownerSubject,
        tenantId: tenantA.tenantId,
        workspaceId: tenantA.workspaceId,
      }),
    ).resolves.toEqual({ outcome: 'SUCCEEDED', holds: [] });
  });

  test('SECURITY DEFINER legal-hold functions bind Tenant, Workspace, actor, and named Owner', async () => {
    const service = createPrivacyService('expected legal-hold SQL context binding');
    const tenantBTarget = {
      objectKey: `tenants/${tenantB.tenantId}/workspaces/${tenantB.workspaceId}/audit/context-bound.json`,
      objectVersionId: randomUUID(),
    };
    const tenantATarget = {
      objectKey: `tenants/${tenantA.tenantId}/workspaces/${tenantA.workspaceId}/audit/owner-bound.json`,
      objectVersionId: randomUUID(),
    };
    await seedManagedObjectForLegalHold(pool, tenantB, tenantBTarget);
    await seedManagedObjectForLegalHold(pool, tenantA, tenantATarget);

    await expect(
      runAsRuntime(pool, tenantA.context, {
        text: `SELECT * FROM create_legal_hold(
          $1, $2, $3, $4, $5, $6, $7, $8, $9
        )`,
        values: [
          tenantB.tenantId,
          tenantB.workspaceId,
          randomUUID(),
          tenantB.ownerUserId,
          'Cross-context hold',
          'Tenant A runtime must not create Tenant B preservation evidence.',
          tenantBTarget.objectKey,
          tenantBTarget.objectVersionId,
          randomUUID(),
        ],
      }),
    ).rejects.toThrow(/LEGAL_HOLD_CONTEXT_MISMATCH|permission|42501/iu);

    await expect(
      runAsRuntime(
        pool,
        { ...tenantA.context, actorUserId: tenantB.ownerUserId },
        {
          text: `SELECT * FROM create_legal_hold(
            $1, $2, $3, $4, $5, $6, $7, $8, $9
          )`,
          values: [
            tenantA.tenantId,
            tenantA.workspaceId,
            randomUUID(),
            tenantB.ownerUserId,
            'Forged Owner hold',
            'A matching GUC actor still must be an active Owner in the exact scope.',
            tenantATarget.objectKey,
            tenantATarget.objectVersionId,
            randomUUID(),
          ],
        },
      ),
    ).rejects.toThrow(/LEGAL_HOLD_OWNER_REQUIRED|permission|42501/iu);

    const hold = await service.createLegalHold({
      actorSubject: tenantB.ownerSubject,
      tenantId: tenantB.tenantId,
      workspaceId: tenantB.workspaceId,
      name: 'Context-bound release',
      reason: 'Only the exact named steward may release this hold.',
      ...tenantBTarget,
    });
    if (hold.outcome !== 'SUCCEEDED') throw new Error('expected legal hold for release binding');
    await expect(
      runAsRuntime(pool, tenantA.context, {
        text: 'SELECT * FROM release_legal_hold($1, $2, $3, $4, $5)',
        values: [
          tenantB.tenantId,
          tenantB.workspaceId,
          hold.hold.id,
          tenantB.ownerUserId,
          randomUUID(),
        ],
      }),
    ).rejects.toThrow(/LEGAL_HOLD_CONTEXT_MISMATCH|permission|42501/iu);
    await expect(
      pool.query<{ status: string }>(
        'SELECT status FROM legal_holds WHERE tenant_id = $1 AND id = $2',
        [tenantB.tenantId, hold.hold.id],
      ),
    ).resolves.toMatchObject({ rows: [{ status: 'ACTIVE' }] });
  });

  test('a deletion request immediately freezes access, jobs, connectors, and secret reads', async () => {
    const service = createPrivacyService('expected session revoked immediately');
    await expect(
      authStore.findSession(
        tenantB.sessionTokenDigest,
        NOW,
        new Date(NOW.getTime() - 30 * 60 * 1000),
      ),
    ).resolves.not.toBeNull();
    await expect(
      tenancyStore.resolveTenantContext({
        actorSubject: tenantB.ownerSubject,
        tenantId: tenantB.tenantId,
        workspaceId: tenantB.workspaceId,
      }),
    ).resolves.not.toBeNull();

    const result = await service.requestTenantDeletion({
      actorSubject: tenantB.ownerSubject,
      tenantId: tenantB.tenantId,
      workspaceId: tenantB.workspaceId,
      reason: 'Owner-requested lifecycle integration test.',
    });
    expect(result.outcome).toBe('SUCCEEDED');
    if (result.outcome !== 'SUCCEEDED') throw new Error('expected session revoked immediately');

    const persistedRequestTime = Date.parse(result.receipt.requestedAt);
    expect(result.receipt).toMatchObject({ state: 'FROZEN' });
    expect(Date.parse(result.receipt.activeDeleteBy)).toBe(persistedRequestTime + 30 * DAY_MS);
    expect(Date.parse(result.receipt.backupDeleteBy)).toBe(persistedRequestTime + 90 * DAY_MS);
    expect(Date.parse(result.receipt.secretForceDeleteBy)).toBe(persistedRequestTime + DAY_MS);
    expect(canonicalJson(result.receipt)).not.toContain(tenantB.secretArn);

    const redactedAuthorization = await pool.query<{
      secret_arn: string | null;
      secret_arn_hash: string | null;
      serialized: string;
    }>(
      `SELECT secret_arn, secret_arn_hash, to_jsonb(channel_auth)::text AS serialized
       FROM channel_authorizations channel_auth
       WHERE tenant_id = $1 AND id = $2`,
      [tenantB.tenantId, tenantB.authorizationId],
    );
    expect(redactedAuthorization.rows).toHaveLength(1);
    expect(redactedAuthorization.rows[0]).toMatchObject({
      secret_arn: null,
      secret_arn_hash: sha256(tenantB.secretArn),
    });
    expect(redactedAuthorization.rows[0]?.serialized).not.toContain(tenantB.secretArn);

    await expect(
      authStore.findSession(
        tenantB.sessionTokenDigest,
        NOW,
        new Date(NOW.getTime() - 30 * 60 * 1000),
      ),
    ).resolves.toBeNull();
    await expect(
      tenancyStore.resolveTenantContext({
        actorSubject: tenantB.ownerSubject,
        tenantId: tenantB.tenantId,
        workspaceId: tenantB.workspaceId,
      }),
    ).resolves.toBeNull();

    const job = await jobStore.findJob({ context: tenantB.context, jobId: tenantB.jobId });
    expect(job).not.toBeNull();
    expect(['CANCELLED', 'FROZEN']).toContain(job?.status);
    const authorizations = await channelAuthorizationStore.list({ context: tenantB.context });
    expect(authorizations).toContainEqual(
      expect.objectContaining({ id: tenantB.authorizationId, status: 'REVOKED' }),
    );
    expect(canonicalJson(authorizations)).not.toContain(tenantB.secretArn);
    const revokedAudits = await pool.query(
      `SELECT 1 FROM audit_events
       WHERE tenant_id = $1 AND action = 'AUTH_SESSION_REVOKED'`,
      [tenantB.tenantId],
    );
    expect(revokedAudits.rowCount).toBeGreaterThan(0);
  });

  test('a frozen Owner can list exact legal holds while active export remains blocked', async () => {
    const service = createPrivacyService('expected frozen-safe privacy governance');
    const objectKey =
      `tenants/${tenantFrozenGovernance.tenantId}/workspaces/` +
      `${tenantFrozenGovernance.workspaceId}/audit/frozen.json`;
    await seedManagedObjectForLegalHold(pool, tenantFrozenGovernance, {
      objectKey,
      objectVersionId: 'frozen-version-1',
    });
    const hold = await service.createLegalHold({
      actorSubject: tenantFrozenGovernance.ownerSubject,
      tenantId: tenantFrozenGovernance.tenantId,
      workspaceId: tenantFrozenGovernance.workspaceId,
      name: 'Frozen-scope hold',
      reason: 'Keep this exact object version visible during deletion.',
      objectKey,
      objectVersionId: 'frozen-version-1',
    });
    expect(hold.outcome).toBe('SUCCEEDED');

    const deletion = await service.requestTenantDeletion({
      actorSubject: tenantFrozenGovernance.ownerSubject,
      tenantId: tenantFrozenGovernance.tenantId,
      workspaceId: tenantFrozenGovernance.workspaceId,
      reason: 'Freeze this Tenant while preserving governance access.',
    });
    expect(deletion.outcome).toBe('SUCCEEDED');

    await expect(
      service.listLegalHolds({
        actorSubject: tenantFrozenGovernance.ownerSubject,
        tenantId: tenantFrozenGovernance.tenantId,
        workspaceId: tenantFrozenGovernance.workspaceId,
      }),
    ).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      holds: [expect.objectContaining({ name: 'Frozen-scope hold' })],
    });
    await expect(
      service.exportTenant({
        actorSubject: tenantFrozenGovernance.ownerSubject,
        tenantId: tenantFrozenGovernance.tenantId,
        workspaceId: tenantFrozenGovernance.workspaceId,
        from: '2026-07-21T00:00:00.000Z',
        to: '2026-07-23T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({ outcome: 'NOT_FOUND' });

    const frozenLoginDigest = sha256(`frozen-login:${randomUUID()}`);
    await authStore.saveSession({
      tokenDigest: frozenLoginDigest,
      subject: tenantFrozenGovernance.ownerSubject,
      email: 'frozen-steward@example.test',
      createdAt: NOW,
      expiresAt: activeWallClockExpiry(),
      revokedAt: null,
    });
    await expect(
      tenancyStore.resolveTenantContext({
        actorSubject: tenantFrozenGovernance.ownerSubject,
        tenantId: tenantFrozenGovernance.tenantId,
        workspaceId: tenantFrozenGovernance.workspaceId,
      }),
    ).resolves.toBeNull();
    await expect(
      pool.query(
        `SELECT 1 FROM audit_events
         WHERE tenant_id = $1 AND workspace_id = $2
           AND action = 'AUTH_SESSION_STARTED'
           AND id = (overlay(overlay(md5($3 || ':' || $1::text || ':' || $2::text ||
             ':AUTH_SESSION_STARTED') placing '4' from 13 for 1) placing '8' from 17 for 1))::uuid`,
        [tenantFrozenGovernance.tenantId, tenantFrozenGovernance.workspaceId, frozenLoginDigest],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  test('releasing the last exact hold after active deletion makes only that version delete-due', async () => {
    const service = createPrivacyService('expected exact hold release lifecycle transition');
    const requestedAt = new Date('2026-01-01T00:00:00.000Z');
    const objectKey =
      `tenants/${tenantHoldRelease.tenantId}/workspaces/` +
      `${tenantHoldRelease.workspaceId}/logs/release.json`;
    const objectVersionId = 'release-version-1';
    const managedObjectId = randomUUID();
    await pool.query(
      `INSERT INTO managed_object_versions
        (id, tenant_id, workspace_id, object_class, object_ref, object_key, object_version_id,
          checksum, content_type, byte_length, lifecycle_state, created_at, expires_at,
          locked_until, deletion_request_id, deleted_at, storage_class)
       VALUES ($1, $2, $3, 'APPLICATION_LOG', $4, $5, $6, $7, 'application/json', 10,
         'ACTIVE', $8, $9, NULL, NULL, NULL, 'WORKLOAD_OBJECTS')`,
      [
        managedObjectId,
        tenantHoldRelease.tenantId,
        tenantHoldRelease.workspaceId,
        `object://${objectKey}/${objectVersionId}`,
        objectKey,
        objectVersionId,
        sha256('release-version-1'),
        new Date('2025-12-01T00:00:00.000Z'),
        requestedAt,
      ],
    );
    await pool.query(
      `UPDATE auth_sessions
       SET created_at = $2, last_seen_at = $2
       WHERE token_digest = $1`,
      [tenantHoldRelease.sessionTokenDigest, new Date('2025-12-01T00:00:00.000Z')],
    );

    try {
      clock.set(requestedAt);
      const hold = await service.createLegalHold({
        actorSubject: tenantHoldRelease.ownerSubject,
        tenantId: tenantHoldRelease.tenantId,
        workspaceId: tenantHoldRelease.workspaceId,
        name: 'Release exact version',
        reason: 'Retain only until the named review completes.',
        objectKey,
        objectVersionId,
      });
      expect(hold.outcome).toBe('SUCCEEDED');
      if (hold.outcome !== 'SUCCEEDED') throw new Error('expected exact hold');
      const deletion = await service.requestTenantDeletion({
        actorSubject: tenantHoldRelease.ownerSubject,
        tenantId: tenantHoldRelease.tenantId,
        workspaceId: tenantHoldRelease.workspaceId,
        reason: 'Exercise exact held-object deletion lifecycle.',
      });
      expect(deletion.outcome).toBe('SUCCEEDED');
      if (deletion.outcome !== 'SUCCEEDED') throw new Error('expected deletion request');
      await ageDeletionForTest(pool, deletion.receipt.id, requestedAt);
      await markSecretUnreadableForTest(
        pool,
        tenantHoldRelease.tenantId,
        tenantHoldRelease.authorizationId,
      );
      const databaseNow = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now'))
        .rows[0]?.now;
      if (databaseNow === undefined) throw new Error('expected database clock');
      clock.set(databaseNow);
      const activeLease = await leaseDeletionForTest(pool, deletion.receipt.id);
      await expect(
        service.finalizeDeletion({ requestId: deletion.receipt.id, leaseToken: activeLease }),
      ).resolves.toMatchObject({
        outcome: 'SUCCEEDED',
        finalization: { state: 'ACTIVE_DATA_DELETED' },
      });

      const stewardLoginDigest = sha256(`post-active-delete-login:${randomUUID()}`);
      await authStore.saveSession({
        tokenDigest: stewardLoginDigest,
        subject: tenantHoldRelease.ownerSubject,
        email: 'deleted-steward@example.test',
        createdAt: databaseNow,
        expiresAt: new Date(databaseNow.getTime() + DAY_MS),
        revokedAt: null,
      });
      await expect(
        tenancyStore.resolveTenantContext({
          actorSubject: tenantHoldRelease.ownerSubject,
          tenantId: tenantHoldRelease.tenantId,
          workspaceId: tenantHoldRelease.workspaceId,
        }),
      ).resolves.toBeNull();
      await expect(
        tenancyStore.resolvePrivacyGovernanceContext({
          actorSubject: tenantHoldRelease.ownerSubject,
          tenantId: tenantHoldRelease.tenantId,
          workspaceId: tenantHoldRelease.workspaceId,
        }),
      ).resolves.toMatchObject({ role: 'OWNER' });
      await expect(
        pool.query(
          `SELECT 1 FROM audit_events
           WHERE tenant_id = $1 AND workspace_id = $2
             AND action = 'AUTH_SESSION_STARTED'
             AND id = (overlay(overlay(md5($3 || ':' || $1::text || ':' || $2::text ||
               ':AUTH_SESSION_STARTED') placing '4' from 13 for 1) placing '8' from 17 for 1))::uuid`,
          [tenantHoldRelease.tenantId, tenantHoldRelease.workspaceId, stewardLoginDigest],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });

      await expect(
        service.releaseLegalHold({
          actorSubject: tenantHoldRelease.ownerSubject,
          tenantId: tenantHoldRelease.tenantId,
          workspaceId: tenantHoldRelease.workspaceId,
          holdId: hold.hold.id,
        }),
      ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
      const managed = await pool.query<{ lifecycle_state: string }>(
        `SELECT lifecycle_state FROM managed_object_versions
         WHERE tenant_id = $1 AND id = $2`,
        [tenantHoldRelease.tenantId, managedObjectId],
      );
      expect(managed.rows[0]?.lifecycle_state).toBe('DELETE_DUE');
    } finally {
      clock.set(NOW);
    }
  });

  test('the 90-day pass deletes unheld siblings, records the exact hold, and completes after release', async () => {
    const service = createPrivacyService('expected exact-version hold without scope expansion');
    const requestedAt = new Date('2026-01-01T00:00:00.000Z');
    const objectKey =
      `tenants/${tenantHeldSibling.tenantId}/workspaces/` +
      `${tenantHeldSibling.workspaceId}/logs/versions.json`;
    const heldObjectId = randomUUID();
    const siblingObjectId = randomUUID();
    for (const [id, version] of [
      [heldObjectId, 'held-v1'],
      [siblingObjectId, 'sibling-v2'],
    ] as const) {
      await pool.query(
        `INSERT INTO managed_object_versions
          (id, tenant_id, workspace_id, object_class, object_ref, object_key, object_version_id,
            checksum, content_type, byte_length, lifecycle_state, created_at, expires_at,
            locked_until, deletion_request_id, deleted_at, storage_class)
         VALUES ($1, $2, $3, 'APPLICATION_LOG', $4, $5, $6, $7, 'application/json', 10,
           'ACTIVE', $8, $9, NULL, NULL, NULL, 'WORKLOAD_OBJECTS')`,
        [
          id,
          tenantHeldSibling.tenantId,
          tenantHeldSibling.workspaceId,
          `object://${objectKey}/${version}`,
          objectKey,
          version,
          sha256(version),
          new Date('2025-12-01T00:00:00.000Z'),
          requestedAt,
        ],
      );
    }
    await pool.query(
      `UPDATE auth_sessions SET created_at = $2, last_seen_at = $2 WHERE token_digest = $1`,
      [tenantHeldSibling.sessionTokenDigest, new Date('2025-12-01T00:00:00.000Z')],
    );

    try {
      clock.set(requestedAt);
      const hold = await service.createLegalHold({
        actorSubject: tenantHeldSibling.ownerSubject,
        tenantId: tenantHeldSibling.tenantId,
        workspaceId: tenantHeldSibling.workspaceId,
        name: 'Hold only v1',
        reason: 'The sibling version is not in scope.',
        objectKey,
        objectVersionId: 'held-v1',
      });
      if (hold.outcome !== 'SUCCEEDED') throw new Error('expected exact hold');
      const deletion = await service.requestTenantDeletion({
        actorSubject: tenantHeldSibling.ownerSubject,
        tenantId: tenantHeldSibling.tenantId,
        workspaceId: tenantHeldSibling.workspaceId,
        reason: 'Verify exact-version lifecycle scope.',
      });
      if (deletion.outcome !== 'SUCCEEDED') throw new Error('expected deletion request');
      await ageDeletionForTest(pool, deletion.receipt.id, requestedAt);
      await markSecretUnreadableForTest(
        pool,
        tenantHeldSibling.tenantId,
        tenantHeldSibling.authorizationId,
      );
      const databaseNow = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now'))
        .rows[0]?.now;
      if (databaseNow === undefined) throw new Error('expected database clock');
      clock.set(databaseNow);
      const activeLease = await leaseDeletionForTest(pool, deletion.receipt.id);
      await provePhysicalObjectDeletionForTest(pool, deletion.receipt.id, activeLease);
      await service.finalizeDeletion({ requestId: deletion.receipt.id, leaseToken: activeLease });
      const blockedLease = await leaseDeletionForTest(pool, deletion.receipt.id);
      await expect(
        service.finalizeDeletion({ requestId: deletion.receipt.id, leaseToken: blockedLease }),
      ).resolves.toMatchObject({ outcome: 'LEGAL_HOLD' });

      const versions = await pool.query<{
        id: string;
        lifecycle_state: string;
      }>(
        `SELECT id, lifecycle_state FROM managed_object_versions
         WHERE tenant_id = $1 ORDER BY id`,
        [tenantHeldSibling.tenantId],
      );
      expect(versions.rows).toContainEqual({ id: heldObjectId, lifecycle_state: 'LEGAL_HOLD' });
      expect(versions.rows).toContainEqual({ id: siblingObjectId, lifecycle_state: 'DELETED' });
      await expect(
        pool.query(
          `SELECT 1 FROM deletion_tombstones
           WHERE tenant_id = $1 AND deletion_request_id = $2
             AND plane = 'OBJECT' AND status = 'LEGAL_HOLD'`,
          [tenantHeldSibling.tenantId, deletion.receipt.id],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        pool.query(
          `SELECT 1 FROM audit_events
           WHERE tenant_id = $1 AND resource_id = $2
             AND action = 'DELETION_BACKUP_BLOCKED_BY_LEGAL_HOLD'`,
          [tenantHeldSibling.tenantId, deletion.receipt.id],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });

      const Store = databaseRuntime.PostgresPrivacyAuditStore;
      if (Store === undefined) throw new Error('privacy store unavailable');
      const schedulerStore = new Store(pool) as BackupDeletionEvidenceStore & {
        claimDueDeletionRequests(input: {
          leaseToken: string;
          limit: number;
        }): Promise<Array<{ requestId: string; stage: 'ACTIVE' | 'BACKUP' | 'TOMBSTONE' }>>;
      };
      const blockedClaims = await schedulerStore.claimDueDeletionRequests({
        leaseToken: randomUUID(),
        limit: 100,
      });
      expect(blockedClaims.some(({ requestId }) => requestId === deletion.receipt.id)).toBe(false);

      await service.releaseLegalHold({
        actorSubject: tenantHeldSibling.ownerSubject,
        tenantId: tenantHeldSibling.tenantId,
        workspaceId: tenantHeldSibling.workspaceId,
        holdId: hold.hold.id,
      });
      const backupLease = randomUUID();
      const releasedClaims = await schedulerStore.claimDueDeletionRequests({
        leaseToken: backupLease,
        limit: 100,
      });
      expect(releasedClaims).toContainEqual(
        expect.objectContaining({ requestId: deletion.receipt.id, stage: 'BACKUP' }),
      );
      await provePhysicalObjectDeletionForTest(pool, deletion.receipt.id, backupLease);
      await recordBackupDeletionProofForTest(
        schedulerStore,
        pool,
        deletion.receipt.id,
        backupLease,
      );
      await expect(
        service.finalizeDeletion({ requestId: deletion.receipt.id, leaseToken: backupLease }),
      ).resolves.toMatchObject({
        outcome: 'SUCCEEDED',
        finalization: { state: 'BACKUP_DELETED' },
      });
      const tombstoneLease = randomUUID();
      await expect(
        schedulerStore.claimDueDeletionRequests({ leaseToken: tombstoneLease, limit: 100 }),
      ).resolves.toContainEqual(
        expect.objectContaining({ requestId: deletion.receipt.id, stage: 'TOMBSTONE' }),
      );
      await expect(
        service.finalizeDeletion({ requestId: deletion.receipt.id, leaseToken: tombstoneLease }),
      ).resolves.toMatchObject({
        outcome: 'SUCCEEDED',
        finalization: { state: 'TOMBSTONED' },
      });
      await expect(
        pool.query<{
          desired_status: string;
          desired_revision: string;
          applied_status: string;
          applied_revision: string;
          work_lease_token: string | null;
        }>(
          `SELECT desired_status, desired_revision, applied_status, applied_revision,
                  work_lease_token
           FROM legal_hold_object_reconciliations
           WHERE tenant_id = $1 AND object_key = $2 AND object_version_id = 'held-v1'`,
          [tenantHeldSibling.tenantId, objectKey],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            desired_status: 'OFF',
            desired_revision: '2',
            applied_status: 'OFF',
            applied_revision: '2',
            work_lease_token: null,
          },
        ],
      });

      const lifecycleAudits = await pool.query<{
        action: string;
        actor_user_id: string | null;
        actor_kind: string;
        actor_principal_id: string | null;
      }>(
        `SELECT action, actor_user_id, actor_kind, actor_principal_id
         FROM audit_events
         WHERE tenant_id = $1 AND resource_id = $2
           AND action IN (
             'DELETION_ACTIVE_DATA_COMPLETED',
             'DELETION_BACKUP_BLOCKED_BY_LEGAL_HOLD',
             'DELETION_BACKUP_COMPLETED',
             'DELETION_TOMBSTONED'
           )
         ORDER BY chain_sequence`,
        [tenantHeldSibling.tenantId, deletion.receipt.id],
      );
      expect(lifecycleAudits.rows.map(({ action }) => action)).toEqual([
        'DELETION_ACTIVE_DATA_COMPLETED',
        'DELETION_BACKUP_BLOCKED_BY_LEGAL_HOLD',
        'DELETION_BACKUP_COMPLETED',
        'DELETION_TOMBSTONED',
      ]);
      expect(lifecycleAudits.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actor_user_id: null,
            actor_kind: 'SYSTEM',
            actor_principal_id: 'privacy-lifecycle-worker',
          }),
        ]),
      );
      expect(
        lifecycleAudits.rows.every(
          ({ actor_user_id, actor_kind, actor_principal_id }) =>
            actor_user_id === null &&
            actor_kind === 'SYSTEM' &&
            actor_principal_id === 'privacy-lifecycle-worker',
        ),
      ).toBe(true);
    } finally {
      clock.set(NOW);
    }
  });

  test('the database clock rejects a caller-supplied future deletion effective time', async () => {
    const service = createPrivacyService('expected database-authoritative deletion clock');
    const deletion = await service.requestTenantDeletion({
      actorSubject: tenantFutureClock.ownerSubject,
      tenantId: tenantFutureClock.tenantId,
      workspaceId: tenantFutureClock.workspaceId,
      reason: 'A caller clock must not advance retention deadlines.',
    });
    expect(deletion.outcome).toBe('SUCCEEDED');
    if (deletion.outcome !== 'SUCCEEDED') throw new Error('expected deletion request');
    await pool.query('SELECT mark_connector_secret_unreadable($1, $2, $3)', [
      tenantFutureClock.tenantId,
      tenantFutureClock.authorizationId,
      new Date(NOW.getTime() + DAY_MS),
    ]);

    try {
      clock.set(new Date(NOW.getTime() + 100 * DAY_MS));
      const leaseToken = await leaseDeletionForTest(pool, deletion.receipt.id);
      await expect(
        service.finalizeDeletion({ requestId: deletion.receipt.id, leaseToken }),
      ).resolves.toMatchObject({ outcome: 'NOT_DUE' });
      await expect(
        pool.query<{ lifecycle_state: string }>(
          'SELECT lifecycle_state FROM tenants WHERE id = $1',
          [tenantFutureClock.tenantId],
        ),
      ).resolves.toMatchObject({ rows: [{ lifecycle_state: 'FROZEN' }] });
    } finally {
      clock.set(NOW);
    }
  });

  test('the database clock rejects a deletion request timestamp beyond clock-skew tolerance', async () => {
    const service = createPrivacyService('expected database-authoritative request clock');
    const databaseNow = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]
      ?.now;
    if (databaseNow === undefined) throw new Error('database clock unavailable');
    try {
      clock.set(new Date(databaseNow.getTime() + DAY_MS));
      await expect(
        service.requestWorkspaceDeletion({
          actorSubject: tenantFutureRequest.ownerSubject,
          tenantId: tenantFutureRequest.tenantId,
          workspaceId: tenantFutureRequest.workspaceId,
          reason: 'A caller clock cannot postpone lifecycle deadlines.',
        }),
      ).resolves.toMatchObject({ outcome: 'INVALID_REQUEST' });
      await expect(
        pool.query<{ lifecycle_state: string }>(
          'SELECT lifecycle_state FROM workspaces WHERE tenant_id = $1 AND id = $2',
          [tenantFutureRequest.tenantId, tenantFutureRequest.workspaceId],
        ),
      ).resolves.toMatchObject({ rows: [{ lifecycle_state: 'ACTIVE' }] });

      const before = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]
        ?.now;
      if (before === undefined) throw new Error('database clock unavailable');
      clock.set(new Date('2020-01-01T00:00:00.000Z'));
      const accepted = await service.requestWorkspaceDeletion({
        actorSubject: tenantFutureRequest.ownerSubject,
        tenantId: tenantFutureRequest.tenantId,
        workspaceId: tenantFutureRequest.workspaceId,
        reason: 'An ancient caller clock must not accelerate lifecycle deadlines.',
      });
      if (accepted.outcome !== 'SUCCEEDED') throw new Error('expected DB-clock deletion request');
      const after = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]
        ?.now;
      if (after === undefined) throw new Error('database clock unavailable');
      const persistedRequestedAt = new Date(accepted.receipt.requestedAt);
      expect(persistedRequestedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(persistedRequestedAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(Date.parse(accepted.receipt.secretForceDeleteBy)).toBe(
        persistedRequestedAt.getTime() + DAY_MS,
      );
      expect(Date.parse(accepted.receipt.activeDeleteBy)).toBe(
        persistedRequestedAt.getTime() + 30 * DAY_MS,
      );
      expect(Date.parse(accepted.receipt.backupDeleteBy)).toBe(
        persistedRequestedAt.getTime() + 90 * DAY_MS,
      );
    } finally {
      clock.set(NOW);
    }
  });

  test('tenant-wide PostgreSQL export fails closed when any included workspace is not active', async () => {
    const service = createPrivacyService('expected lifecycle-locked privacy paths');
    const frozenWorkspaceId = randomUUID();
    await pool.query(
      `INSERT INTO workspaces (id, tenant_id, name, created_at)
       VALUES ($1, $2, 'Frozen export sibling', $3)`,
      [frozenWorkspaceId, tenantLifecycleLock.tenantId, NOW],
    );
    await pool.query(
      `INSERT INTO role_bindings (id, tenant_id, workspace_id, membership_id, role, created_at)
       VALUES ($1, $2, $3, $4, 'OWNER', $5)`,
      [
        randomUUID(),
        tenantLifecycleLock.tenantId,
        frozenWorkspaceId,
        tenantLifecycleLock.context.membershipId,
        NOW,
      ],
    );
    const frozen = await service.requestWorkspaceDeletion({
      actorSubject: tenantLifecycleLock.ownerSubject,
      tenantId: tenantLifecycleLock.tenantId,
      workspaceId: frozenWorkspaceId,
      reason: 'Freeze one included workspace while the requesting workspace remains active.',
    });
    expect(frozen.outcome).toBe('SUCCEEDED');
    const workspaceStates = await pool.query<{ id: string; lifecycle_state: string }>(
      `SELECT id, lifecycle_state FROM workspaces
       WHERE tenant_id = $1 AND id IN ($2, $3)
       ORDER BY id`,
      [tenantLifecycleLock.tenantId, tenantLifecycleLock.workspaceId, frozenWorkspaceId],
    );
    expect(workspaceStates.rows).toContainEqual({
      id: tenantLifecycleLock.workspaceId,
      lifecycle_state: 'ACTIVE',
    });
    expect(workspaceStates.rows).toContainEqual({
      id: frozenWorkspaceId,
      lifecycle_state: 'FROZEN',
    });
    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    if (Store === undefined) throw new Error('privacy store unavailable');
    const store = new Store(pool) as {
      loadTenantExportObjects(input: {
        context: TenantContext;
        from: Date;
        to: Date;
      }): Promise<unknown>;
      saveTenantExport(input: {
        context: TenantContext;
        exportId: string;
        manifest: Record<string, unknown>;
        checksum: string;
        requestHash: string;
        createdAt: Date;
        auditEventId: string;
      }): Promise<unknown>;
    };
    await expect(
      store.loadTenantExportObjects({
        context: tenantLifecycleLock.context,
        from: new Date('2026-01-01T00:00:00.000Z'),
        to: new Date('2026-12-31T23:59:59.999Z'),
      }),
    ).rejects.toThrow(/TENANT_SCOPE_NOT_ACTIVE/u);
    await expect(
      store.saveTenantExport({
        context: tenantLifecycleLock.context,
        exportId: randomUUID(),
        manifest: {
          schemaVersion: '1.0.0',
          tenantId: tenantLifecycleLock.tenantId,
          timeRange: {
            from: '2026-01-01T00:00:00.000Z',
            to: '2026-12-31T23:59:59.999Z',
          },
          objects: [],
          files: [],
          disclosures: {
            tenantScope: 'This export is limited to the requested Tenant and stated time range.',
            integrity:
              'Hashes support integrity checks but are not legal certification of completeness.',
            noGuarantee:
              'This point-in-time export is not a guarantee of future ranking, citation, traffic, or business outcomes.',
          },
        },
        checksum: 'a'.repeat(64),
        requestHash: 'b'.repeat(64),
        createdAt: NOW,
        auditEventId: randomUUID(),
      }),
    ).rejects.toThrow(/TENANT_SCOPE_NOT_ACTIVE/u);
  });

  test('deletion workers lease due secret and finalization work without duplicate claims', async () => {
    const requestedAt = new Date('2026-01-01T00:00:00.000Z');
    await expect(
      pool.query<{ rolcanlogin: boolean; rolbypassrls: boolean }>(
        `SELECT rolcanlogin, rolbypassrls
         FROM pg_roles
         WHERE rolname = 'aeostudio_lifecycle_worker'`,
      ),
    ).resolves.toMatchObject({ rows: [{ rolcanlogin: false, rolbypassrls: false }] });
    await expect(
      pool.query<{
        runtime_finalize: boolean;
        runtime_claim_deletions: boolean;
        runtime_claim_secrets: boolean;
        runtime_mark_requested: boolean;
        runtime_mark_unreadable: boolean;
        worker_finalize: boolean;
        worker_claim_deletions: boolean;
        worker_claim_secrets: boolean;
        worker_mark_requested: boolean;
        worker_mark_unreadable: boolean;
      }>(
        `SELECT
          has_function_privilege('aeostudio_runtime',
            'finalize_deletion(uuid,uuid,timestamptz,uuid,uuid)', 'EXECUTE') AS runtime_finalize,
          has_function_privilege('aeostudio_runtime',
            'claim_due_deletion_requests(uuid,integer)', 'EXECUTE') AS runtime_claim_deletions,
          has_function_privilege('aeostudio_runtime',
            'claim_due_secret_deletions(uuid,integer)', 'EXECUTE') AS runtime_claim_secrets,
          has_function_privilege('aeostudio_runtime',
            'worker_mark_secret_deletion_requested(uuid,uuid,uuid)', 'EXECUTE') AS runtime_mark_requested,
          has_function_privilege('aeostudio_runtime',
            'worker_mark_secret_unreadable(uuid,uuid,uuid)', 'EXECUTE') AS runtime_mark_unreadable,
          has_function_privilege('aeostudio_lifecycle_worker',
            'finalize_deletion(uuid,uuid,timestamptz,uuid,uuid)', 'EXECUTE') AS worker_finalize,
          has_function_privilege('aeostudio_lifecycle_worker',
            'claim_due_deletion_requests(uuid,integer)', 'EXECUTE') AS worker_claim_deletions,
          has_function_privilege('aeostudio_lifecycle_worker',
            'claim_due_secret_deletions(uuid,integer)', 'EXECUTE') AS worker_claim_secrets,
          has_function_privilege('aeostudio_lifecycle_worker',
            'worker_mark_secret_deletion_requested(uuid,uuid,uuid)', 'EXECUTE') AS worker_mark_requested,
          has_function_privilege('aeostudio_lifecycle_worker',
            'worker_mark_secret_unreadable(uuid,uuid,uuid)', 'EXECUTE') AS worker_mark_unreadable`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          runtime_finalize: false,
          runtime_claim_deletions: false,
          runtime_claim_secrets: false,
          runtime_mark_requested: false,
          runtime_mark_unreadable: false,
          worker_finalize: true,
          worker_claim_deletions: true,
          worker_claim_secrets: true,
          worker_mark_requested: true,
          worker_mark_unreadable: true,
        },
      ],
    });
    await expect(
      pool.query<{ can_request: boolean; can_verify: boolean }>(
        `SELECT
          has_function_privilege(
            'aeostudio_runtime',
            'mark_connector_secret_deletion_requested(uuid,uuid,timestamptz)',
            'EXECUTE'
          ) AS can_request,
          has_function_privilege(
            'aeostudio_runtime',
            'mark_connector_secret_unreadable(uuid,uuid,timestamptz)',
            'EXECUTE'
          ) AS can_verify`,
      ),
    ).resolves.toMatchObject({ rows: [{ can_request: false, can_verify: false }] });
    await expect(
      runAsRuntime(pool, tenantScheduler.context, {
        text: 'SELECT mark_connector_secret_unreadable($1, $2, clock_timestamp())',
        values: [tenantScheduler.tenantId, tenantScheduler.authorizationId],
      }),
    ).rejects.toThrow(/permission denied|42501/iu);
    await pool.query(
      `UPDATE auth_sessions SET created_at = $2, last_seen_at = $2 WHERE token_digest = $1`,
      [tenantScheduler.sessionTokenDigest, new Date('2025-12-01T00:00:00.000Z')],
    );
    const service = createPrivacyService('expected leased deletion work scheduler');
    try {
      clock.set(requestedAt);
      const deletion = await service.requestTenantDeletion({
        actorSubject: tenantScheduler.ownerSubject,
        tenantId: tenantScheduler.tenantId,
        workspaceId: tenantScheduler.workspaceId,
        reason: 'Exercise bounded and retry-safe deletion work claims.',
      });
      if (deletion.outcome !== 'SUCCEEDED') throw new Error('expected deletion request');
      await ageDeletionForTest(pool, deletion.receipt.id, requestedAt);
      await expect(
        runAsRuntime(pool, tenantA.context, {
          text: 'SELECT * FROM claim_due_secret_deletions($1, $2)',
          values: [randomUUID(), 100],
        }),
      ).rejects.toThrow(/permission denied|42501/iu);
      const Store = databaseRuntime.PostgresPrivacyAuditStore;
      if (Store === undefined) throw new Error('privacy store unavailable');
      const store = new Store(pool) as {
        claimDueSecretDeletions(input: { leaseToken: string; limit: number }): Promise<
          Array<{
            tenantId: string;
            channelAuthorizationId: string;
            deletionRequestId: string;
            secretReference: string;
          }>
        >;
        markSecretDeletionRequested(input: {
          tenantId: string;
          channelAuthorizationId: string;
          leaseToken: string;
        }): Promise<boolean>;
        markSecretUnreadable(input: {
          tenantId: string;
          channelAuthorizationId: string;
          leaseToken: string;
        }): Promise<boolean>;
        claimDueDeletionRequests(input: {
          leaseToken: string;
          limit: number;
        }): Promise<Array<{ requestId: string; stage: 'ACTIVE' | 'BACKUP' | 'TOMBSTONE' }>>;
      };
      const secretLease = randomUUID();
      const claimedSecrets = await store.claimDueSecretDeletions({
        leaseToken: secretLease,
        limit: 10,
      });
      expect(claimedSecrets).toHaveLength(
        new Set(claimedSecrets.map(({ channelAuthorizationId }) => channelAuthorizationId)).size,
      );
      expect(claimedSecrets.length).toBeLessThanOrEqual(10);
      expect(claimedSecrets).toContainEqual(
        expect.objectContaining({
          tenantId: tenantScheduler.tenantId,
          channelAuthorizationId: tenantScheduler.authorizationId,
          deletionRequestId: deletion.receipt.id,
          secretReference: tenantScheduler.secretArn,
        }),
      );
      await expect(
        store.claimDueSecretDeletions({ leaseToken: randomUUID(), limit: 10 }),
      ).resolves.toEqual([]);
      await expect(
        store.markSecretDeletionRequested({
          tenantId: tenantScheduler.tenantId,
          channelAuthorizationId: tenantScheduler.authorizationId,
          leaseToken: secretLease,
        }),
      ).resolves.toBe(true);
      const firstRequestedAt = (
        await pool.query<{ force_delete_requested_at: Date }>(
          `SELECT force_delete_requested_at
           FROM connector_secret_deletions
           WHERE tenant_id = $1 AND channel_authorization_id = $2`,
          [tenantScheduler.tenantId, tenantScheduler.authorizationId],
        )
      ).rows[0]?.force_delete_requested_at;
      if (firstRequestedAt === undefined) throw new Error('force-delete request evidence missing');
      const expiryClient = await pool.connect();
      try {
        await expiryClient.query('BEGIN');
        await expiryClient.query(
          `SELECT set_config('app.secret_deletion_lease', 'authorized', true)`,
        );
        await expiryClient.query(
          `UPDATE connector_secret_deletions
           SET work_lease_expires_at = clock_timestamp() - interval '1 second'
           WHERE tenant_id = $1 AND channel_authorization_id = $2`,
          [tenantScheduler.tenantId, tenantScheduler.authorizationId],
        );
        await expiryClient.query('COMMIT');
      } catch (error) {
        await expiryClient.query('ROLLBACK');
        throw error;
      } finally {
        expiryClient.release();
      }
      const retrySecretLease = randomUUID();
      const retriedSecrets = await store.claimDueSecretDeletions({
        leaseToken: retrySecretLease,
        limit: 100,
      });
      expect(retriedSecrets).toContainEqual(
        expect.objectContaining({
          tenantId: tenantScheduler.tenantId,
          channelAuthorizationId: tenantScheduler.authorizationId,
        }),
      );
      await expect(
        store.markSecretDeletionRequested({
          tenantId: tenantScheduler.tenantId,
          channelAuthorizationId: tenantScheduler.authorizationId,
          leaseToken: retrySecretLease,
        }),
      ).resolves.toBe(true);
      await expect(
        pool.query<{ force_delete_requested_at: Date }>(
          `SELECT force_delete_requested_at
           FROM connector_secret_deletions
           WHERE tenant_id = $1 AND channel_authorization_id = $2`,
          [tenantScheduler.tenantId, tenantScheduler.authorizationId],
        ),
      ).resolves.toMatchObject({ rows: [{ force_delete_requested_at: firstRequestedAt }] });
      await expect(
        store.markSecretUnreadable({
          tenantId: tenantScheduler.tenantId,
          channelAuthorizationId: tenantScheduler.authorizationId,
          leaseToken: retrySecretLease,
        }),
      ).resolves.toBe(true);

      const activeLease = randomUUID();
      const claimedDeletions = await store.claimDueDeletionRequests({
        leaseToken: activeLease,
        limit: 10,
      });
      expect(claimedDeletions).toHaveLength(
        new Set(claimedDeletions.map(({ requestId }) => requestId)).size,
      );
      expect(claimedDeletions.length).toBeLessThanOrEqual(10);
      expect(claimedDeletions).toContainEqual(
        expect.objectContaining({ requestId: deletion.receipt.id, stage: 'ACTIVE' }),
      );
      await expect(
        store.claimDueDeletionRequests({ leaseToken: randomUUID(), limit: 10 }),
      ).resolves.toEqual([]);
      await expect(
        service.finalizeDeletion({
          requestId: deletion.receipt.id,
          leaseToken: randomUUID(),
        }),
      ).resolves.toMatchObject({ outcome: 'INVALID_LEASE' });
      const databaseNow = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now'))
        .rows[0]?.now;
      if (databaseNow === undefined) throw new Error('database clock unavailable');
      clock.set(databaseNow);
      await expect(
        service.finalizeDeletion({ requestId: deletion.receipt.id, leaseToken: activeLease }),
      ).resolves.toMatchObject({
        outcome: 'SUCCEEDED',
        finalization: { state: 'ACTIVE_DATA_DELETED' },
      });
      await expect(
        store.claimDueDeletionRequests({ leaseToken: randomUUID(), limit: 10 }),
      ).resolves.toEqual([
        expect.objectContaining({ requestId: deletion.receipt.id, stage: 'BACKUP' }),
      ]);
    } finally {
      clock.set(NOW);
    }
  });

  test('tenant deletion preserves an existing workspace secret deletion transition and deadline', async () => {
    const service = createPrivacyService('expected monotonic connector secret deletion state');
    const secondWorkspaceId = randomUUID();
    await pool.query(
      `INSERT INTO workspaces (id, tenant_id, name, created_at)
       VALUES ($1, $2, 'Escalation workspace', $3)`,
      [secondWorkspaceId, tenantEscalatedDeletion.tenantId, NOW],
    );
    await pool.query(
      `INSERT INTO role_bindings (id, tenant_id, workspace_id, membership_id, role, created_at)
       VALUES ($1, $2, $3, $4, 'OWNER', $5)`,
      [
        randomUUID(),
        tenantEscalatedDeletion.tenantId,
        secondWorkspaceId,
        tenantEscalatedDeletion.context.membershipId,
        NOW,
      ],
    );
    const workspaceDeletion = await service.requestWorkspaceDeletion({
      actorSubject: tenantEscalatedDeletion.ownerSubject,
      tenantId: tenantEscalatedDeletion.tenantId,
      workspaceId: tenantEscalatedDeletion.workspaceId,
      reason: 'First freeze only one workspace.',
    });
    expect(workspaceDeletion.outcome).toBe('SUCCEEDED');
    const before = await pool.query<{
      deletion_request_id: string;
      state: string;
      revoked_at: Date;
      force_delete_at: Date;
    }>(
      `SELECT deletion_request_id, state, revoked_at, force_delete_at
       FROM connector_secret_deletions
       WHERE tenant_id = $1 AND channel_authorization_id = $2`,
      [tenantEscalatedDeletion.tenantId, tenantEscalatedDeletion.authorizationId],
    );
    const tenantDeletion = await service.requestTenantDeletion({
      actorSubject: tenantEscalatedDeletion.ownerSubject,
      tenantId: tenantEscalatedDeletion.tenantId,
      workspaceId: secondWorkspaceId,
      reason: 'Escalate to the entire Tenant without rewinding secret work.',
    });
    expect(tenantDeletion.outcome).toBe('SUCCEEDED');
    const after = await pool.query<{
      deletion_request_id: string;
      state: string;
      revoked_at: Date;
      force_delete_at: Date;
    }>(
      `SELECT deletion_request_id, state, revoked_at, force_delete_at
       FROM connector_secret_deletions
       WHERE tenant_id = $1 AND channel_authorization_id = $2`,
      [tenantEscalatedDeletion.tenantId, tenantEscalatedDeletion.authorizationId],
    );
    expect(after.rows).toEqual(before.rows);
  });

  test('deletion tracks every unverified connector secret including an already-revoked authorization', async () => {
    await channelAuthorizationStore.revoke({
      context: tenantRevokedSecret.context,
      authorizationId: tenantRevokedSecret.authorizationId,
      revokedAt: NOW,
      auditEventId: randomUUID(),
    });
    const service = createPrivacyService('expected complete connector secret inventory');
    const deletion = await service.requestTenantDeletion({
      actorSubject: tenantRevokedSecret.ownerSubject,
      tenantId: tenantRevokedSecret.tenantId,
      workspaceId: tenantRevokedSecret.workspaceId,
      reason: 'Track an already-revoked credential until verified unreadable.',
    });
    expect(deletion.outcome).toBe('SUCCEEDED');
    await expect(
      pool.query<{
        secret_reference: string;
        state: string;
      }>(
        `SELECT secret_reference, state FROM connector_secret_deletions
         WHERE tenant_id = $1 AND channel_authorization_id = $2`,
        [tenantRevokedSecret.tenantId, tenantRevokedSecret.authorizationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          secret_reference: tenantRevokedSecret.secretArn,
          state: 'REVOKED_PENDING_FORCE_DELETE',
        },
      ],
    });
  });

  test('ordinary Tenant runtime cannot invoke the platform break-glass control plane', async () => {
    const privileges = await pool.query<{
      can_grant: boolean;
      can_evaluate: boolean;
      can_revoke: boolean;
    }>(
      `SELECT
        has_function_privilege(
          'aeostudio_runtime',
          'grant_break_glass(uuid,uuid,uuid,uuid,text,text,timestamptz,text,text,text,uuid)',
          'EXECUTE'
        ) AS can_grant,
        has_function_privilege(
          'aeostudio_runtime',
          'evaluate_break_glass_access(text,uuid,uuid,uuid,uuid,text,text,text,text,uuid)',
          'EXECUTE'
        ) AS can_evaluate,
        has_function_privilege(
          'aeostudio_runtime',
          'revoke_break_glass(uuid,uuid,uuid,uuid,text,uuid)',
          'EXECUTE'
        ) AS can_revoke`,
    );
    expect(privileges.rows).toEqual([{ can_grant: false, can_evaluate: false, can_revoke: false }]);
    await expect(
      runAsRuntime(pool, tenantA.context, {
        text: `SELECT * FROM grant_break_glass(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        )`,
        values: [
          tenantA.tenantId,
          tenantA.workspaceId,
          randomUUID(),
          PLATFORM_OPERATOR_ID,
          'Forged Runtime Operator',
          'Compromised Tenant runtime must not cross the control-plane boundary.',
          new Date(Date.now() + 10 * 60 * 1_000),
          'READ_SENSITIVE_EVIDENCE',
          'AUDIT_EVIDENCE',
          randomUUID(),
          randomUUID(),
        ],
      }),
    ).rejects.toThrow(/permission denied|42501/iu);
  });

  test('a named visible legal hold targets one object version and break-glass is exact and audited', async () => {
    const service = createPrivacyService(
      'expected exact object-version legal hold and expiring break-glass access',
    );
    const objectKey = `tenants/${tenantA.tenantId}/workspaces/${tenantA.workspaceId}/audit/2026-07-22.json`;
    const objectVersionId = randomUUID();
    const siblingVersionId = randomUUID();
    const createdAt = '2026-01-01T00:00:00.000Z';
    await seedManagedObjectForLegalHold(pool, tenantA, { objectKey, objectVersionId });
    const holdResult = await service.createLegalHold({
      actorSubject: tenantA.ownerSubject,
      tenantId: tenantA.tenantId,
      workspaceId: tenantA.workspaceId,
      name: 'Named preservation request 2026-07',
      reason: 'Preserve the exact evidence version while the request is reviewed.',
      objectKey,
      objectVersionId,
    });
    expect(holdResult.outcome).toBe('SUCCEEDED');
    if (holdResult.outcome !== 'SUCCEEDED') {
      throw new Error('expected exact object-version legal hold');
    }
    expect(holdResult.hold).toMatchObject({
      name: 'Named preservation request 2026-07',
      visibleToTenant: true,
      target: { objectKey, objectVersionId },
    });
    const listed = await service.listLegalHolds({
      actorSubject: tenantA.ownerSubject,
      tenantId: tenantA.tenantId,
      workspaceId: tenantA.workspaceId,
    });
    expect(listed.outcome).toBe('SUCCEEDED');
    if (listed.outcome !== 'SUCCEEDED') throw new Error('expected tenant-visible legal hold');
    expect(listed.holds).toContainEqual(expect.objectContaining({ id: holdResult.hold.id }));

    await expect(
      service.evaluateRetention({
        actorSubject: tenantA.ownerSubject,
        tenantId: tenantA.tenantId,
        workspaceId: tenantA.workspaceId,
        objectClass: 'APPLICATION_LOG',
        objectKey,
        objectVersionId,
        createdAt,
      }),
    ).resolves.toMatchObject({
      decision: 'LEGAL_HOLD',
      retained: true,
      deletionAllowed: false,
      legalHold: { id: holdResult.hold.id },
    });
    await expect(
      service.evaluateRetention({
        actorSubject: tenantA.ownerSubject,
        tenantId: tenantA.tenantId,
        workspaceId: tenantA.workspaceId,
        objectClass: 'APPLICATION_LOG',
        objectKey,
        objectVersionId: siblingVersionId,
        createdAt,
      }),
    ).resolves.toMatchObject({
      decision: 'EXPIRE',
      retained: false,
      deletionAllowed: true,
      legalHold: null,
    });

    const databaseNow = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]
      ?.now;
    if (databaseNow === undefined) throw new Error('database clock unavailable');
    clock.set(databaseNow);
    const expiresAt = new Date(databaseNow.getTime() + 15 * 60 * 1_000).toISOString();
    await expect(
      service.grantBreakGlass({
        actorSubject: tenantA.ownerSubject,
        tenantId: tenantA.tenantId,
        workspaceId: tenantA.workspaceId,
        reason: 'Body identity must not turn an Owner into a platform operator.',
        expiresAt,
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: objectVersionId,
      }),
    ).resolves.toEqual({ outcome: 'FORBIDDEN' });
    const grantResult = await service.grantBreakGlass({
      actorSubject: PLATFORM_OPERATOR_SUBJECT,
      tenantId: tenantA.tenantId,
      workspaceId: tenantA.workspaceId,
      reason: 'Tenant-approved incident ticket INC-1701.',
      expiresAt,
      requestedAction: 'READ_SENSITIVE_EVIDENCE',
      resourceType: 'AUDIT_EVIDENCE',
      resourceId: objectVersionId,
    });
    expect(grantResult.outcome).toBe('SUCCEEDED');
    if (grantResult.outcome !== 'SUCCEEDED') throw new Error('expected named break-glass grant');
    expect(grantResult.grant).toMatchObject({
      tenantId: tenantA.tenantId,
      workspaceId: tenantA.workspaceId,
      operatorId: PLATFORM_OPERATOR_ID,
      operatorName: 'Named Platform Operator',
      reason: 'Tenant-approved incident ticket INC-1701.',
      expiresAt,
      requestedAction: 'READ_SENSITIVE_EVIDENCE',
      resourceType: 'AUDIT_EVIDENCE',
      resourceId: objectVersionId,
    });
    expect(grantResult.grant.auditEventId).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(
      service.evaluateBreakGlassAccess({
        actorSubject: PLATFORM_OPERATOR_SUBJECT,
        tenantId: tenantA.tenantId,
        workspaceId: tenantA.workspaceId,
        grantId: grantResult.grant.id,
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: objectVersionId,
      }),
    ).resolves.toMatchObject({
      decision: 'ALLOW',
      state: 'ACTIVE',
      grantId: grantResult.grant.id,
    });

    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    if (Store === undefined) throw new Error('privacy store unavailable');
    const breakGlassStore = new Store(pool) as {
      evaluateBreakGlassAccess(input: {
        actorSubject: string;
        tenantId: string;
        workspaceId: string;
        grantId: string;
        operatorId: string;
        operatorName: string;
        requestedAction: string;
        resourceType: string;
        resourceId: string;
        auditEventId: string;
      }): Promise<{ decision: string; state: string; grantId: string | null }>;
    };
    await expect(
      breakGlassStore.evaluateBreakGlassAccess({
        actorSubject: PLATFORM_OPERATOR_SUBJECT,
        tenantId: tenantA.tenantId,
        workspaceId: tenantA.workspaceId,
        grantId: grantResult.grant.id,
        operatorId: PLATFORM_OPERATOR_ID,
        operatorName: 'Forged Platform Operator Name',
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: objectVersionId,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ decision: 'DENY', state: 'INVALID_GRANT', grantId: null });

    await expect(
      service.evaluateBreakGlassAccess({
        actorSubject: PLATFORM_OPERATOR_SUBJECT,
        tenantId: tenantA.tenantId,
        workspaceId: tenantA.workspaceId,
        grantId: grantResult.grant.id,
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: siblingVersionId,
      }),
    ).resolves.toMatchObject({ decision: 'DENY', state: 'INVALID_GRANT' });
    const accessAudits = await pool.query<{ action: string; outcome: string }>(
      `SELECT action, outcome FROM audit_events
       WHERE tenant_id = $1 AND resource_id = $2
         AND action IN ('BREAK_GLASS_ACCESS_ALLOWED', 'BREAK_GLASS_ACCESS_DENIED')
       ORDER BY chain_sequence`,
      [tenantA.tenantId, grantResult.grant.id],
    );
    expect(accessAudits.rows).toEqual([
      { action: 'BREAK_GLASS_ACCESS_ALLOWED', outcome: 'SUCCEEDED' },
      { action: 'BREAK_GLASS_ACCESS_DENIED', outcome: 'DENIED' },
      { action: 'BREAK_GLASS_ACCESS_DENIED', outcome: 'DENIED' },
    ]);
    const operatorTimeline = await service.listAuditEvents({
      actorSubject: tenantA.ownerSubject,
      tenantId: tenantA.tenantId,
      workspaceId: tenantA.workspaceId,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-12-31T23:59:59.999Z',
      limit: 200,
    });
    if (operatorTimeline.outcome !== 'SUCCEEDED' || operatorTimeline.timeline === undefined) {
      throw new Error('expected break-glass audit timeline');
    }
    expect(
      operatorTimeline.timeline.events
        .filter(({ action }) =>
          ['BREAK_GLASS_ACCESS_ALLOWED', 'BREAK_GLASS_ACCESS_DENIED'].includes(action),
        )
        .toReversed()
        .map(({ actorKind, action, resourceType, outcome }) => ({
          actorKind,
          action,
          resourceType,
          outcome,
        })),
    ).toEqual([
      {
        actorKind: 'SUPPORT',
        action: 'BREAK_GLASS_ACCESS_DENIED',
        resourceType: 'BREAK_GLASS_GRANT',
        outcome: 'DENIED',
      },
      {
        actorKind: 'PLATFORM_OPERATOR',
        action: 'BREAK_GLASS_ACCESS_ALLOWED',
        resourceType: 'BREAK_GLASS_GRANT',
        outcome: 'SUCCEEDED',
      },
      {
        actorKind: 'PLATFORM_OPERATOR',
        action: 'BREAK_GLASS_ACCESS_DENIED',
        resourceType: 'BREAK_GLASS_GRANT',
        outcome: 'DENIED',
      },
      {
        actorKind: 'PLATFORM_OPERATOR',
        action: 'BREAK_GLASS_ACCESS_DENIED',
        resourceType: 'BREAK_GLASS_GRANT',
        outcome: 'DENIED',
      },
    ]);
  });

  test('durably reconciles exact-version legal holds and serializes create against last release', async () => {
    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    if (Store === undefined) throw new Error('privacy store unavailable');
    const priorStore = new Store(pool);
    const priorRemote = productionLikeLegalHoldStorage();
    for (let pass = 0; pass < 10; pass += 1) {
      const drained = await new PrivacyLifecycleWorker(
        priorStore,
        {
          requestForceDelete: () => Promise.resolve(),
          verifyUnreadable: () => Promise.resolve(true),
        },
        {
          clock: { now: () => new Date() },
          ids: { next: randomUUID },
          objects: priorRemote.objects,
        },
      ).runOnce();
      if (drained.claimedLegalHoldReconciliations === 0) break;
    }
    const objectKey = `tenants/${tenantA.tenantId}/workspaces/${tenantA.workspaceId}/evidence/legal-hold.json`;
    const objectVersionId = randomUUID();
    await seedManagedObjectForLegalHold(pool, tenantA, { objectKey, objectVersionId });
    const remote = productionLikeLegalHoldStorage();
    const store = new Store(pool, { objects: remote.objects }) as {
      createLegalHold(input: {
        context: TenantContext;
        holdId: string;
        name: string;
        reason: string;
        objectKey: string;
        objectVersionId: string;
        createdAt: Date;
        auditEventId: string;
      }): Promise<{ outcome: string }>;
      releaseLegalHold(input: {
        context: TenantContext;
        holdId: string;
        releasedAt: Date;
        auditEventId: string;
      }): Promise<{ outcome: string }>;
    };
    const firstHoldId = randomUUID();
    const secondHoldId = randomUUID();
    const reconcile = () =>
      new PrivacyLifecycleWorker(
        store as never,
        {
          requestForceDelete: () => Promise.resolve(),
          verifyUnreadable: () => Promise.resolve(true),
        },
        {
          clock: { now: () => new Date() },
          ids: { next: randomUUID },
          objects: remote.objects,
        },
      ).runOnce();

    await expect(
      store.createLegalHold({
        context: tenantA.context,
        holdId: firstHoldId,
        name: 'First exact-version hold',
        reason: 'Preserve during the first named review.',
        objectKey,
        objectVersionId,
        createdAt: NOW,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
    await expect(
      store.createLegalHold({
        context: tenantA.context,
        holdId: secondHoldId,
        name: 'Second exact-version hold',
        reason: 'Preserve during an independent named review.',
        objectKey,
        objectVersionId,
        createdAt: NOW,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
    expect(remote.holdExportVersion).not.toHaveBeenCalled();
    await expect(reconcile()).resolves.toMatchObject({
      claimedLegalHoldReconciliations: 1,
      reconciledLegalHoldObjectVersions: 1,
    });
    expect(remote.holdExportVersion).toHaveBeenCalledOnce();
    expect(remote.isHeld()).toBe(true);

    await expect(
      store.releaseLegalHold({
        context: tenantA.context,
        holdId: firstHoldId,
        releasedAt: NOW,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
    await expect(reconcile()).resolves.toMatchObject({ claimedLegalHoldReconciliations: 0 });
    expect(remote.releaseExportVersionHold).not.toHaveBeenCalled();
    expect(remote.isHeld()).toBe(true);

    await expect(
      store.releaseLegalHold({
        context: tenantA.context,
        holdId: secondHoldId,
        releasedAt: NOW,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
    await expect(reconcile()).resolves.toMatchObject({
      claimedLegalHoldReconciliations: 1,
      reconciledLegalHoldObjectVersions: 1,
    });
    expect(remote.releaseExportVersionHold).toHaveBeenCalledOnce();
    expect(remote.isHeld()).toBe(false);

    const concurrentHoldIds = [randomUUID(), randomUUID()];
    for (const [index, holdId] of concurrentHoldIds.entries()) {
      await store.createLegalHold({
        context: tenantA.context,
        holdId,
        name: `Concurrent hold ${index + 1}`,
        reason: 'Exercise last-holder serialization on one exact object version.',
        objectKey,
        objectVersionId,
        createdAt: NOW,
        auditEventId: randomUUID(),
      });
    }
    await reconcile();
    expect(remote.isHeld()).toBe(true);
    await Promise.all(
      concurrentHoldIds.map((holdId) =>
        store.releaseLegalHold({
          context: tenantA.context,
          holdId,
          releasedAt: NOW,
          auditEventId: randomUUID(),
        }),
      ),
    );
    await reconcile();
    expect(remote.releaseExportVersionHold).toHaveBeenCalledTimes(2);
    expect(remote.isHeld()).toBe(false);

    // The former dual-write race was: release DB commit -> create S3 ON ->
    // release S3 OFF. Both API calls now only advance one exact-object desired
    // revision under the same row lock, so the worker can apply only the final
    // state regardless of lock acquisition order.
    const oldHoldId = randomUUID();
    const replacementHoldId = randomUUID();
    await store.createLegalHold({
      context: tenantA.context,
      holdId: oldHoldId,
      name: 'Race source hold',
      reason: 'Exercise create versus the final release.',
      objectKey,
      objectVersionId,
      createdAt: NOW,
      auditEventId: randomUUID(),
    });
    await reconcile();
    expect(remote.isHeld()).toBe(true);

    await Promise.all([
      store.releaseLegalHold({
        context: tenantA.context,
        holdId: oldHoldId,
        releasedAt: NOW,
        auditEventId: randomUUID(),
      }),
      store.createLegalHold({
        context: tenantA.context,
        holdId: replacementHoldId,
        name: 'Race replacement hold',
        reason: 'Must remain the final desired exact-version state.',
        objectKey,
        objectVersionId,
        createdAt: NOW,
        auditEventId: randomUUID(),
      }),
    ]);
    await reconcile();
    expect(remote.isHeld()).toBe(true);
    await expect(
      pool.query<{
        desired_status: string;
        applied_status: string;
        desired_revision: string;
        applied_revision: string;
      }>(
        `SELECT desired_status, applied_status, desired_revision, applied_revision
         FROM legal_hold_object_reconciliations
         WHERE tenant_id = $1 AND object_key = $2 AND object_version_id = $3`,
        [tenantA.tenantId, objectKey, objectVersionId],
      ),
    ).resolves.toMatchObject({
      rows: [
        expect.objectContaining({
          desired_status: 'ON',
          applied_status: 'ON',
        }),
      ],
    });
  });

  test('never overlaps a stale legal-hold effect with a newer desired revision', async () => {
    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    if (Store === undefined) throw new Error('privacy store unavailable');
    const objectKey = `tenants/${tenantA.tenantId}/workspaces/${tenantA.workspaceId}/evidence/leased-hold.json`;
    const objectVersionId = randomUUID();
    await seedManagedObjectForLegalHold(pool, tenantA, { objectKey, objectVersionId });
    const store = new Store(pool) as {
      createLegalHold(input: {
        context: TenantContext;
        holdId: string;
        name: string;
        reason: string;
        objectKey: string;
        objectVersionId: string;
        createdAt: Date;
        auditEventId: string;
      }): Promise<{ outcome: string }>;
      releaseLegalHold(input: {
        context: TenantContext;
        holdId: string;
        releasedAt: Date;
        auditEventId: string;
      }): Promise<{ outcome: string }>;
    };
    const holdId = randomUUID();
    await store.createLegalHold({
      context: tenantA.context,
      holdId,
      name: 'Leased exact-version hold',
      reason: 'Prove monotonic remote-effect serialization.',
      objectKey,
      objectVersionId,
      createdAt: NOW,
      auditEventId: randomUUID(),
    });
    const staleLease = randomUUID();
    const stale = await pool.query<{
      desired_status: string;
      desired_revision: string;
    }>(
      `SELECT desired_status, desired_revision
       FROM claim_pending_legal_hold_reconciliations($1, 1)`,
      [staleLease],
    );
    expect(stale.rows).toEqual([
      expect.objectContaining({ desired_status: 'ON', desired_revision: '1' }),
    ]);

    await store.releaseLegalHold({
      context: tenantA.context,
      holdId,
      releasedAt: NOW,
      auditEventId: randomUUID(),
    });
    const newerLease = randomUUID();
    const overlapping = await pool.query(
      `SELECT * FROM claim_pending_legal_hold_reconciliations($1, 10)`,
      [newerLease],
    );
    expect(overlapping.rows).toEqual([]);

    const staleCompletion = await pool.query<{ completed: boolean }>(
      `SELECT complete_legal_hold_reconciliation($1, $2, $3, 'ON', 1, $4)
         AS completed`,
      [tenantA.tenantId, objectKey, objectVersionId, staleLease],
    );
    expect(staleCompletion.rows[0]?.completed).toBe(false);
    await expect(
      pool.query<{
        applied_status: string;
        applied_revision: string;
        desired_status: string;
        desired_revision: string;
        work_lease_token: string | null;
      }>(
        `SELECT applied_status, applied_revision, desired_status, desired_revision,
           work_lease_token
         FROM legal_hold_object_reconciliations
         WHERE tenant_id = $1 AND object_key = $2 AND object_version_id = $3`,
        [tenantA.tenantId, objectKey, objectVersionId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          applied_status: 'UNKNOWN',
          applied_revision: '0',
          desired_status: 'OFF',
          desired_revision: '2',
          work_lease_token: null,
        },
      ],
    });
    const current = await pool.query<{
      desired_status: string;
      desired_revision: string;
    }>(
      `SELECT desired_status, desired_revision
       FROM claim_pending_legal_hold_reconciliations($1, 1)`,
      [newerLease],
    );
    expect(current.rows).toEqual([
      expect.objectContaining({ desired_status: 'OFF', desired_revision: '2' }),
    ]);
  });

  test('runtime SQL cannot rewrite a legal-hold target or a break-glass grant binding', async () => {
    const service = createPrivacyService('expected immutable privileged records');
    const objectKey = `tenants/${tenantA.tenantId}/workspaces/${tenantA.workspaceId}/immutable/evidence.json`;
    const objectVersionId = randomUUID();
    const managedObjectId = await seedManagedObjectForLegalHold(pool, tenantA, {
      objectKey,
      objectVersionId,
    });
    const hold = await service.createLegalHold({
      actorSubject: tenantA.ownerSubject,
      tenantId: tenantA.tenantId,
      workspaceId: tenantA.workspaceId,
      name: 'Immutable target',
      reason: 'The exact target must never be rewritten.',
      objectKey,
      objectVersionId,
    });
    if (hold.outcome !== 'SUCCEEDED') throw new Error('expected legal hold');
    const databaseNow = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]
      ?.now;
    if (databaseNow === undefined) throw new Error('database clock unavailable');
    clock.set(databaseNow);
    const grant = await service.grantBreakGlass({
      actorSubject: PLATFORM_OPERATOR_SUBJECT,
      tenantId: tenantA.tenantId,
      workspaceId: tenantA.workspaceId,
      reason: 'Immutable grant binding.',
      expiresAt: new Date(databaseNow.getTime() + 10 * 60 * 1_000).toISOString(),
      requestedAction: 'READ_SENSITIVE_EVIDENCE',
      resourceType: 'AUDIT_EVIDENCE',
      resourceId: objectVersionId,
    });
    if (grant.outcome !== 'SUCCEEDED') throw new Error('expected break-glass grant');
    await expect(
      runAsRuntime(pool, tenantA.context, {
        text: `UPDATE legal_hold_object_versions SET object_version_id = $3
               WHERE tenant_id = $1 AND hold_id = $2`,
        values: [tenantA.tenantId, hold.hold.id, randomUUID()],
      }),
    ).rejects.toThrow(/permission|immutable|denied/iu);
    await expect(
      runAsRuntime(pool, tenantA.context, {
        text: `UPDATE break_glass_grants SET resource_id = $3
               WHERE tenant_id = $1 AND id = $2`,
        values: [tenantA.tenantId, grant.grant.id, randomUUID()],
      }),
    ).rejects.toThrow(/permission|immutable|denied/iu);
    await expect(
      runAsRuntime(pool, tenantA.context, {
        text: `UPDATE managed_object_versions
               SET lifecycle_state = 'DELETED', deleted_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2`,
        values: [tenantA.tenantId, managedObjectId],
      }),
    ).rejects.toThrow(/permission|lifecycle|denied/iu);
    await expect(
      runAsRuntime(pool, tenantB.context, {
        text: `UPDATE connector_secret_deletions
               SET state = 'VERIFIED_UNREADABLE', verified_unreadable_at = clock_timestamp()
               WHERE tenant_id = $1 AND channel_authorization_id = $2`,
        values: [tenantB.tenantId, tenantB.authorizationId],
      }),
    ).rejects.toThrow(/permission|lifecycle|denied/iu);
  });

  test('audit digests summarize only the exact verified time range and define empty ranges', async () => {
    await expect(
      runAsRuntime(pool, tenantA.context, {
        text: 'SELECT * FROM verify_audit_chain($1)',
        values: [tenantB.tenantId],
      }),
    ).rejects.toThrow(/AUDIT_TENANT_CONTEXT_MISMATCH|permission/iu);
    await expect(
      runAsRuntime(pool, tenantA.context, {
        text: 'SELECT * FROM verify_audit_range($1, $2, $3)',
        values: [
          tenantB.tenantId,
          new Date('2026-07-21T00:00:00.000Z'),
          new Date('2026-07-21T23:59:59.999Z'),
        ],
      }),
    ).rejects.toThrow(/AUDIT_TENANT_CONTEXT_MISMATCH|permission/iu);
    const outsideEventId = randomUUID();
    const insideEventId = randomUUID();
    for (const [eventId, occurredAt, action] of [
      [outsideEventId, new Date('2026-07-20T12:00:00.000Z'), 'RANGE_TEST_OUTSIDE'],
      [insideEventId, new Date('2026-07-21T12:00:00.000Z'), 'RANGE_TEST_INSIDE'],
    ] as const) {
      await pool.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, actor_kind, action,
            resource_type, resource_id, outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'USER', $5, 'AUDIT_RANGE_TEST', $1, 'SUCCEEDED',
           '{}'::jsonb, $6)`,
        [eventId, tenantA.tenantId, tenantA.workspaceId, tenantA.ownerUserId, action, occurredAt],
      );
    }
    const selected = (
      await pool.query<{ chain_sequence: string; event_hash: string }>(
        `SELECT chain_sequence, event_hash FROM audit_events WHERE id = $1`,
        [insideEventId],
      )
    ).rows[0];
    if (selected === undefined) throw new Error('inside range audit event missing');

    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    if (Store === undefined) throw new Error('privacy store unavailable');
    const store = new Store(pool) as {
      verifyAuditRange(input: { context: TenantContext; from: Date; to: Date }): Promise<{
        valid: boolean;
        eventCount: number;
        lastSequence: number;
        headHash: string | null;
        reason: string | null;
      }>;
    };
    const from = new Date('2026-07-21T00:00:00.000Z');
    const to = new Date('2026-07-21T23:59:59.999Z');
    await expect(store.verifyAuditRange({ context: tenantA.context, from, to })).resolves.toEqual({
      valid: true,
      eventCount: 1,
      lastSequence: Number(selected.chain_sequence),
      headHash: selected.event_hash,
      reason: null,
    });
    await expect(
      store.verifyAuditRange({
        context: tenantA.context,
        from: new Date('2024-01-01T00:00:00.000Z'),
        to: new Date('2024-01-02T00:00:00.000Z'),
      }),
    ).resolves.toEqual({
      valid: true,
      eventCount: 0,
      lastSequence: 0,
      headHash: null,
      reason: null,
    });

    const service = createPrivacyService('expected exact audit digest range');
    const beforeSeal = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]
      ?.now;
    if (beforeSeal === undefined) throw new Error('database seal clock unavailable');
    clock.set(new Date('2020-01-01T00:00:00.000Z'));
    let sealed: Awaited<ReturnType<PrivacyAuditServiceApi['sealAuditDigest']>>;
    try {
      sealed = await service.sealAuditDigest({
        actorSubject: tenantA.ownerSubject,
        tenantId: tenantA.tenantId,
        workspaceId: tenantA.workspaceId,
        from: from.toISOString(),
        to: to.toISOString(),
      });
    } finally {
      clock.set(NOW);
    }
    const afterSeal = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]
      ?.now;
    if (afterSeal === undefined) throw new Error('database seal clock unavailable');
    expect(sealed).toMatchObject({
      outcome: 'SUCCEEDED',
      digest: {
        eventCount: 1,
        lastSequence: Number(selected.chain_sequence),
        headHash: selected.event_hash,
        timeRange: { from: from.toISOString(), to: to.toISOString() },
      },
    });
    if (sealed.outcome !== 'SUCCEEDED' || sealed.digest === undefined) {
      throw new Error('expected DB-clock audit digest');
    }
    const persisted = (
      await pool.query<{
        last_sequence: string;
        sealed_at: Date;
        locked_until: Date;
        digest_hash: string;
      }>(
        `SELECT last_sequence, sealed_at, locked_until, digest_hash
         FROM audit_digests WHERE tenant_id = $1 AND id = $2`,
        [tenantA.tenantId, sealed.digest.id],
      )
    ).rows[0];
    expect(persisted).toBeDefined();
    if (persisted === undefined) throw new Error('persisted audit digest missing');
    expect(Number(persisted.last_sequence)).toBe(sealed.digest.lastSequence);
    expect(persisted.sealed_at.getTime()).toBeGreaterThanOrEqual(beforeSeal.getTime());
    expect(persisted.sealed_at.getTime()).toBeLessThanOrEqual(afterSeal.getTime());
    expect(persisted.locked_until.getTime() - persisted.sealed_at.getTime()).toBe(365 * DAY_MS);
    const digestPayload = {
      id: sealed.digest.id,
      tenantId: sealed.digest.tenantId,
      schemaVersion: sealed.digest.schemaVersion,
      timeRange: sealed.digest.timeRange,
      eventCount: sealed.digest.eventCount,
      lastSequence: sealed.digest.lastSequence,
      headHash: sealed.digest.headHash,
      lockedUntil: sealed.digest.lockedUntil,
      sealedAt: sealed.digest.sealedAt,
    };
    expect(sealed.digest.digestHash).toBe(sha256(canonicalJson(digestPayload)));
    expect(persisted.digest_hash).toBe(sealed.digest.digestHash);

    const repeated = await service.sealAuditDigest({
      actorSubject: tenantA.ownerSubject,
      tenantId: tenantA.tenantId,
      workspaceId: tenantA.workspaceId,
      from: from.toISOString(),
      to: to.toISOString(),
    });
    expect(repeated).toMatchObject({
      outcome: 'SUCCEEDED',
      digest: { id: sealed.digest.id, digestHash: sealed.digest.digestHash },
    });
    await expect(
      pool.query<{ digest_count: string; seal_audit_count: string }>(
        `SELECT
           (SELECT count(*) FROM audit_digests
            WHERE tenant_id = $1 AND range_from = $2 AND range_to = $3) AS digest_count,
           (SELECT count(*) FROM audit_events
            WHERE tenant_id = $1 AND action = 'AUDIT_DIGEST_SEALED'
              AND resource_id = $4) AS seal_audit_count`,
        [tenantA.tenantId, from, to, sealed.digest.id],
      ),
    ).resolves.toMatchObject({ rows: [{ digest_count: '1', seal_audit_count: '1' }] });
  });

  test('concurrent audit seals serialize the verified range and converge on one digest', async () => {
    const service = createPrivacyService('expected atomic audit digest seal');
    const from = new Date('2025-01-01T00:00:00.000Z');
    const to = new Date('2025-01-02T00:00:00.000Z');
    const input = {
      actorSubject: tenantA.ownerSubject,
      tenantId: tenantA.tenantId,
      workspaceId: tenantA.workspaceId,
      from: from.toISOString(),
      to: to.toISOString(),
    };

    const [left, right] = await Promise.all([
      service.sealAuditDigest(input),
      service.sealAuditDigest(input),
    ]);

    expect(left.outcome).toBe('SUCCEEDED');
    expect(right.outcome).toBe('SUCCEEDED');
    if (
      left.outcome !== 'SUCCEEDED' ||
      left.digest === undefined ||
      right.outcome !== 'SUCCEEDED' ||
      right.digest === undefined
    ) {
      throw new Error('concurrent audit digest did not converge');
    }
    expect(right.digest.id).toBe(left.digest.id);
    await expect(
      pool.query<{ digest_count: string; seal_audit_count: string }>(
        `SELECT
           (SELECT count(*) FROM audit_digests
            WHERE tenant_id = $1 AND range_from = $2 AND range_to = $3) AS digest_count,
           (SELECT count(*) FROM audit_events
            WHERE tenant_id = $1 AND action = 'AUDIT_DIGEST_SEALED'
              AND resource_id = $4) AS seal_audit_count`,
        [tenantA.tenantId, from, to, left.digest.id],
      ),
    ).resolves.toMatchObject({ rows: [{ digest_count: '1', seal_audit_count: '1' }] });
  });

  test('append-only audit verification detects a superuser mutation of sealed evidence', async () => {
    const service = createPrivacyService('audit digest mismatch not detected');
    const input = {
      actorSubject: tenantA.ownerSubject,
      tenantId: tenantA.tenantId,
      workspaceId: tenantA.workspaceId,
    };
    await expect(service.verifyAuditIntegrity(input)).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      valid: true,
    });

    const client = await pool.connect();
    try {
      await client.query('ALTER TABLE audit_events DISABLE TRIGGER USER');
      await client.query(
        `UPDATE audit_events
         SET metadata = metadata || '{"superuserTamper":true}'::jsonb
         WHERE id = $1`,
        [tenantA.auditEventId],
      );
    } finally {
      await client.query('ALTER TABLE audit_events ENABLE TRIGGER USER');
      client.release();
    }

    const tampered = await service.verifyAuditIntegrity(input);
    expect(tampered.valid, 'audit digest mismatch not detected').toBe(false);
    expect(tampered.outcome).toBe('TAMPERED');
    expect(tampered.reason).toMatch(/digest|chain|tamper/iu);
  });

  test('the Owner audit timeline includes tenant-scoped session start and revoke evidence', async () => {
    const tokenDigest = sha256(`task17-login-audit:${randomUUID()}`);
    await authStore.saveSession({
      tokenDigest,
      subject: tenantA.ownerSubject,
      email: 'must-not-appear@example.test',
      createdAt: NOW,
      expiresAt: activeWallClockExpiry(),
      revokedAt: null,
    });
    await authStore.revokeSession(tokenDigest, new Date(NOW.getTime() + 60_000));
    const service = createPrivacyService('expected authentication events in Owner timeline');
    const timeline = await service.listAuditEvents({
      actorSubject: tenantA.ownerSubject,
      tenantId: tenantA.tenantId,
      workspaceId: tenantA.workspaceId,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-12-31T23:59:59.999Z',
      limit: 200,
    });
    expect(timeline.outcome).toBe('SUCCEEDED');
    if (timeline.outcome !== 'SUCCEEDED' || timeline.timeline === undefined) {
      throw new Error('expected Owner audit timeline');
    }
    const authEvents = timeline.timeline.events.filter((event) =>
      ['AUTH_SESSION_STARTED', 'AUTH_SESSION_REVOKED'].includes(event.action),
    );
    expect(authEvents.map(({ action }) => action)).toEqual(
      expect.arrayContaining(['AUTH_SESSION_STARTED', 'AUTH_SESSION_REVOKED']),
    );
    expect(authEvents.every(({ resourceId }) => resourceId === null)).toBe(true);
    const serialized = canonicalJson(authEvents);
    expect(serialized).not.toContain(tokenDigest);
    expect(serialized).not.toContain('must-not-appear@example.test');
  });

  test('a first login is backfilled into audit evidence when its first Tenant is bootstrapped', async () => {
    const subject = `pre-tenant-login-${randomUUID()}`;
    const tokenDigest = sha256(`pre-tenant-session:${subject}`);
    await authStore.saveSession({
      tokenDigest,
      subject,
      email: 'pre-tenant-owner@example.test',
      createdAt: NOW,
      expiresAt: activeWallClockExpiry(),
      revokedAt: null,
    });
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    await tenancyStore.bootstrapTenant({
      actorSubject: subject,
      actorEmail: 'pre-tenant-owner@example.test',
      userId: randomUUID(),
      tenantId,
      tenantName: 'Pre-tenant login audit',
      workspaceId,
      workspaceName: 'Initial workspace',
      membershipId: randomUUID(),
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    const evidence = await pool.query<{ resource_id: string | null }>(
      `SELECT resource_id::text
       FROM audit_events
       WHERE tenant_id = $1 AND workspace_id = $2 AND action = 'AUTH_SESSION_STARTED'`,
      [tenantId, workspaceId],
    );
    expect(evidence.rows).toEqual([{ resource_id: null }]);
  });

  function createPrivacyService(expectedFailure: string): PrivacyAuditServiceApi {
    const Store = databaseRuntime.PostgresPrivacyAuditStore;
    const Service = applicationRuntime.PrivacyAuditService;
    expect(Store, `${expectedFailure}; PostgresPrivacyAuditStore unavailable`).toBeTypeOf(
      'function',
    );
    expect(Service, `${expectedFailure}; PrivacyAuditService unavailable`).toBeTypeOf('function');
    if (Store === undefined || Service === undefined) throw new Error(expectedFailure);
    return new Service(new Store(pool), tenancyStore, { next: randomUUID }, clock, {
      authorize: ({ actorSubject }) =>
        Promise.resolve(
          actorSubject === PLATFORM_OPERATOR_SUBJECT
            ? {
                operatorId: PLATFORM_OPERATOR_ID,
                operatorName: 'Named Platform Operator',
              }
            : null,
        ),
    });
  }
});

async function runAsRuntime(
  pool: Pool,
  context: TenantContext,
  query: { text: string; values: unknown[] },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE aeostudio_runtime');
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true),
              set_config('app.workspace_id', $2, true),
              set_config('app.actor_id', $3, true)`,
      [context.tenantId, context.workspaceId, context.actorUserId],
    );
    await client.query(query.text, query.values);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function provePhysicalObjectDeletionForTest(
  pool: Pool,
  requestId: string,
  leaseToken: string,
): Promise<void> {
  const Store = databaseRuntime.PostgresPrivacyAuditStore;
  if (Store === undefined) throw new Error('privacy store unavailable');
  const store = new Store(pool) as {
    listDueDeletionObjectVersions(input: {
      requestId: string;
      leaseToken: string;
      limit: number;
    }): Promise<{
      outcome: 'SUCCEEDED' | 'INVALID_LEASE';
      objects?: Array<{
        tenantId: string;
        objectKey: string;
        objectVersionId: string;
      }>;
      hasMore?: boolean;
    }>;
    markDeletionObjectVersionDeleted(input: {
      requestId: string;
      leaseToken: string;
      tenantId: string;
      objectKey: string;
      objectVersionId: string;
    }): Promise<boolean>;
  };
  for (;;) {
    const batch = await store.listDueDeletionObjectVersions({ requestId, leaseToken, limit: 1000 });
    if (batch.outcome !== 'SUCCEEDED') throw new Error('physical deletion lease unavailable');
    for (const object of batch.objects ?? []) {
      const marked = await store.markDeletionObjectVersionDeleted({
        requestId,
        leaseToken,
        tenantId: object.tenantId,
        objectKey: object.objectKey,
        objectVersionId: object.objectVersionId,
      });
      if (!marked) throw new Error('physical deletion proof was not persisted');
    }
    if (batch.hasMore !== true) return;
  }
}

function productionLikeLegalHoldStorage() {
  let held = false;
  const holdExportVersion = vi.fn(() => {
    held = true;
    return Promise.resolve(true);
  });
  const releaseExportVersionHold = vi.fn(() => {
    held = false;
    return Promise.resolve(true);
  });
  const objects = {
    putExportVersion: () => Promise.reject(new Error('UNUSED_PUT_EXPORT')),
    readExportVersion: () => Promise.resolve(null),
    deleteExportVersion: () => Promise.resolve({ outcome: 'NOT_FOUND' as const }),
    holdExportVersion,
    releaseExportVersionHold,
    putLockedAuditVersion: () => Promise.reject(new Error('UNUSED_PUT_AUDIT')),
    readAuditVersion: () => Promise.resolve(null),
    deleteAuditVersion: () => Promise.resolve({ outcome: 'NOT_FOUND' as const }),
    holdAuditVersion: () => Promise.resolve(true),
    releaseAuditVersionHold: () => Promise.resolve(true),
    listPrivacyObjectVersions: () => Promise.resolve({ versions: [], nextCursor: null }),
  } satisfies TenantExportObjectStorage &
    AuditEvidenceObjectLockStore &
    PrivacyObjectVersionInventory;
  return {
    objects,
    holdExportVersion,
    releaseExportVersionHold,
    isHeld: () => held,
  };
}

async function seedManagedObjectForLegalHold(
  pool: Pool,
  fixture: TenantFixture,
  target: { objectKey: string; objectVersionId: string },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO managed_object_versions
      (id, tenant_id, workspace_id, object_class, object_ref, object_key, object_version_id,
        checksum, content_type, byte_length, lifecycle_state, created_at, expires_at,
        locked_until, deletion_request_id, deleted_at, storage_class)
     VALUES ($1, $2, $3, 'APPLICATION_LOG', $4, $5, $6, $7, 'application/json', 10,
       'ACTIVE', $8, NULL, NULL, NULL, NULL, 'WORKLOAD_OBJECTS')`,
    [
      id,
      fixture.tenantId,
      fixture.workspaceId,
      `s3://audit-evidence/${id}`,
      target.objectKey,
      target.objectVersionId,
      sha256(`${target.objectKey}:${target.objectVersionId}`),
      NOW,
    ],
  );
  return id;
}

async function leaseDeletionForTest(pool: Pool, requestId: string): Promise<string> {
  const leaseToken = randomUUID();
  await pool.query(
    `UPDATE deletion_requests
     SET finalization_lease_token = $2,
         finalization_lease_expires_at = clock_timestamp() + interval '5 minutes',
         finalization_attempt_count = finalization_attempt_count + 1,
         finalization_last_claimed_at = clock_timestamp()
     WHERE id = $1`,
    [requestId, leaseToken],
  );
  return leaseToken;
}

async function recordBackupDeletionProofForTest(
  store: BackupDeletionEvidenceStore,
  pool: Pool,
  requestId: string,
  leaseToken: string,
): Promise<{
  evidenceCanonicalJson: string;
  evidenceHash: string;
  sourceDeletedAt: string;
  verifiedAt: Date;
}> {
  const target = await store.getBackupDeletionVerificationTarget({ requestId, leaseToken });
  if (target.outcome !== 'SUCCEEDED')
    throw new Error(`backup target unavailable: ${target.outcome}`);
  const verifiedAt = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]
    ?.now;
  if (verifiedAt === undefined) throw new Error('database clock unavailable');
  const evidenceCanonicalJson = canonicalJson({
    inventoryMethod: 'ListRecoveryPointsByResource',
    managedByAWSBackupOnly: false,
    requestId: requestId.toLowerCase(),
    schemaVersion: '2.0.0',
    sourceDeletedAt: target.target.sourceDeletedAt,
    verifiedAt: verifiedAt.toISOString(),
  });
  const evidenceHash = sha256(evidenceCanonicalJson);
  const recorded = await store.recordBackupDeletionVerification({
    requestId,
    leaseToken,
    evidenceCanonicalJson,
    evidenceHash,
    sourceDeletedAt: new Date(target.target.sourceDeletedAt),
    verifiedAt,
  });
  if (!recorded) throw new Error('backup proof was not recorded');
  return {
    evidenceCanonicalJson,
    evidenceHash,
    sourceDeletedAt: target.target.sourceDeletedAt,
    verifiedAt,
  };
}

async function ageDeletionForTest(pool: Pool, requestId: string, requestedAt: Date): Promise<void> {
  await pool.query(
    `UPDATE deletion_requests
     SET requested_at = $2::timestamptz,
         frozen_at = $2::timestamptz,
         active_delete_by = $2::timestamptz + interval '30 days',
         backup_delete_by = $2::timestamptz + interval '90 days',
         secret_force_delete_by = $2::timestamptz + interval '24 hours'
     WHERE id = $1 AND state = 'FROZEN'`,
    [requestId, requestedAt],
  );
}

async function markSecretUnreadableForTest(
  pool: Pool,
  tenantId: string,
  channelAuthorizationId: string,
): Promise<void> {
  const result = await pool.query<{ marked: boolean }>(
    `SELECT mark_connector_secret_unreadable(
       $1, $2, clock_timestamp()
     ) AS marked`,
    [tenantId, channelAuthorizationId],
  );
  expect(result.rows).toEqual([{ marked: true }]);
}

async function seedTenantFixture(input: {
  label: string;
  adapterVersionId: string;
  tenancyStore: PostgresTenancyStore;
  authStore: PostgresAuthStore;
  channelAuthorizationStore: PostgresChannelAuthorizationStore;
  pool: Pool;
}): Promise<TenantFixture> {
  const ownerSubject = `task17-${input.label}-owner-subject`;
  const ownerEmail = `task17-${input.label}-owner@example.test`;
  const tenantId = randomUUID();
  const workspaceId = randomUUID();
  const ownerUserId = randomUUID();
  const membershipId = randomUUID();
  const auditEventId = randomUUID();
  const scope = await input.tenancyStore.bootstrapTenant({
    actorSubject: ownerSubject,
    actorEmail: ownerEmail,
    userId: ownerUserId,
    tenantId,
    tenantName: `Task17 ${input.label} Tenant`,
    workspaceId,
    workspaceName: `Task17 ${input.label} Workspace`,
    membershipId,
    roleBindingId: randomUUID(),
    auditEventId,
  });
  const context: TenantContext = {
    tenantId,
    workspaceId,
    actorUserId: scope.membership.userId,
    membershipId,
    role: 'OWNER',
  };
  const sessionTokenDigest = sha256(`task17-session:${input.label}`);
  await input.authStore.saveSession({
    tokenDigest: sessionTokenDigest,
    subject: ownerSubject,
    email: ownerEmail,
    createdAt: new Date(NOW.getTime() - 60_000),
    expiresAt: activeWallClockExpiry(),
    revokedAt: null,
  });

  const jobId = randomUUID();
  await input.pool.query(
    `INSERT INTO jobs
      (id, tenant_id, workspace_id, job_type, aggregate_id, status, progress, attempt,
        idempotency_key, estimated_units, requested_by_user_id, lease_token, lease_expires_at,
        heartbeat_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'PROFILE_READINESS', $4, 'RUNNING', 25, 1, $5, 10, $6, $7,
       $8, $9, $9, $9)`,
    [
      jobId,
      tenantId,
      workspaceId,
      randomUUID(),
      `task17-${input.label}-job`,
      scope.membership.userId,
      randomUUID(),
      new Date(NOW.getTime() + 60_000),
      NOW,
    ],
  );
  await input.pool.query(
    `INSERT INTO audit_events
      (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
        outcome, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, 'JOB_STARTED', 'JOB', $5, 'SUCCEEDED',
       '{"fixture":"task17"}'::jsonb, $6)`,
    [randomUUID(), tenantId, workspaceId, scope.membership.userId, jobId, NOW],
  );

  const authorizationId = randomUUID();
  const secretArn = `arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:task17/${input.label}`;
  await input.channelAuthorizationStore.create({
    context,
    authorizationId,
    adapterVersionId: input.adapterVersionId,
    target: `https://${input.label}.publish.example.test`,
    grantedScopes: ['content:write'],
    acceptedTermsVersion: 'task17-terms-v1',
    secretArn,
    expiresAt: activeWallClockExpiry(),
    createdAt: NOW,
    auditEventId: randomUUID(),
  });

  return {
    tenantId,
    workspaceId,
    ownerUserId: scope.membership.userId,
    ownerSubject,
    context,
    sessionTokenDigest,
    jobId,
    authorizationId,
    secretArn,
    auditEventId,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('CANONICAL_JSON_NON_FINITE_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('CANONICAL_JSON_UNSUPPORTED_VALUE');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
