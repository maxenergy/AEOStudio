import { randomUUID } from 'node:crypto';

import { InMemorySecretLifecycleStore } from '@aeostudio/adapters/secrets';
import { FakePrivacyObjectStorage } from '@aeostudio/adapters/storage';
import {
  canonicalPrivacyJson,
  PrivacyAuditService,
  privacySha256,
  type TenantExportSourceObject,
} from '@aeostudio/application/privacy-audit';
import {
  TENANT_EXPORT_INTEGRITY_DISCLOSURE,
  TENANT_EXPORT_NO_GUARANTEE_DISCLOSURE,
  TENANT_EXPORT_SCOPE_DISCLOSURE,
} from '@aeostudio/contracts/privacy-audit';
import { describe, expect, test, vi } from 'vitest';

import { InMemoryAuthStore } from '../../apps/api/src/auth/auth-store.memory.js';
import { InMemoryChannelAuthorizationStore } from '../../apps/api/src/channels/in-memory-channel-authorization-store.js';
import { InMemoryJobBudgetStore } from '../../apps/api/src/jobs/in-memory-job-budget-store.js';
import { InMemoryPrivacyAuditStore } from '../../apps/api/src/privacy/in-memory-privacy-audit-store.js';
import { InMemoryTenancyStore } from '../../apps/api/src/tenants/in-memory-tenancy-store.js';

describe('Task 17 downloadable Tenant export archive', () => {
  test('downloads a checksum-verified eight-category bundle with original Workspace attribution', async () => {
    const now = new Date('2026-07-22T08:00:00.000Z');
    const sourceOccurredAt = new Date('2026-07-22T06:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const actorUserId = randomUUID();
    const membershipId = randomUUID();
    const actorSubject = 'task-17-export-owner';
    const tenancy = new InMemoryTenancyStore();
    await tenancy.bootstrapTenant({
      actorSubject,
      actorEmail: 'task-17-export-owner@example.test',
      tenantId,
      tenantName: 'Portable data Tenant',
      workspaceId,
      workspaceName: 'Primary Workspace',
      userId: actorUserId,
      membershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    await tenancy.bootstrapTenant({
      actorSubject,
      actorEmail: 'task-17-export-owner@example.test',
      tenantId,
      tenantName: 'Portable data Tenant',
      workspaceId: otherWorkspaceId,
      workspaceName: 'Secondary Workspace',
      userId: actorUserId,
      membershipId: randomUUID(),
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    const objects = new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock });
    const sourceObjects = createSourceObjects({
      tenantId,
      workspaceId,
      otherWorkspaceId,
      occurredAt: sourceOccurredAt,
    });
    const store = new InMemoryPrivacyAuditStore({
      auth: new InMemoryAuthStore(),
      tenancy,
      jobs: new InMemoryJobBudgetStore(),
      authorizations: new InMemoryChannelAuthorizationStore(),
      objects,
      secrets: new InMemorySecretLifecycleStore(clock),
      clock,
      exportSources: [
        {
          listTenantExportObjects: () => Promise.resolve(structuredClone(sourceObjects)),
        },
      ],
    });
    const service = new PrivacyAuditService(store, tenancy, { next: randomUUID }, clock);
    const request = {
      actorSubject,
      tenantId,
      workspaceId,
      from: '2026-07-22T05:00:00.000Z',
      to: '2026-07-22T07:00:00.000Z',
    };
    const ownerContext = {
      tenantId,
      workspaceId,
      actorUserId,
      membershipId,
      role: 'OWNER' as const,
    };

    const result = await service.exportTenant(request);
    expect(result).toMatchObject({
      outcome: 'SUCCEEDED',
      export: { archiveStatus: 'READY', archiveReady: true },
    });
    if (result.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_READY_EXPORT');
    const archive = await store.readTenantExportArchive({
      sessionToken: 'task-17-export-owner-session',
      context: ownerContext,
      exportId: result.export.id,
    });
    expect(archive).not.toBeNull();
    if (archive === null) throw new Error('EXPECTED_DOWNLOADABLE_ARCHIVE');
    expect(archive.manifestChecksum).toBe(result.export.checksum);
    expect(archive.archiveChecksum).toBe(privacySha256(archive.body));

    const bundle = JSON.parse(new TextDecoder().decode(archive.body)) as {
      schemaVersion: string;
      manifest: typeof result.export.manifest;
      files: Array<{
        path: string;
        contentHash: string;
        byteLength: number;
        content: {
          tenantId: string;
          workspaceId: string | null;
          kind: string;
          payload: unknown;
        };
      }>;
    };
    expect(bundle.schemaVersion).toBe('tenant-export-bundle.v1');
    expect(privacySha256(canonicalPrivacyJson(bundle.manifest))).toBe(archive.manifestChecksum);
    expect(bundle.files).toHaveLength(bundle.manifest.files.length);
    for (const [index, file] of bundle.files.entries()) {
      const manifestFile = bundle.manifest.files[index];
      expect(file.path).toBe(manifestFile?.path);
      expect(file.contentHash).toBe(manifestFile?.contentHash);
      expect(privacySha256(canonicalPrivacyJson(file.content))).toBe(file.contentHash);
      expect(Buffer.byteLength(canonicalPrivacyJson(file.content), 'utf8')).toBe(file.byteLength);
      expect(file.content.tenantId).toBe(tenantId);
    }
    expect(new Set(bundle.files.map((file) => file.content.kind))).toEqual(
      new Set([
        'PROFILE_REVISION',
        'OFFERING_REVISION',
        'CLAIM_REVISION',
        'ARTIFACT',
        'MEASUREMENT_RUN',
        'METRIC_SNAPSHOT',
        'PUBLICATION',
        'AUDIT_EVENT',
      ]),
    );
    expect(new Set(bundle.files.map((file) => file.content.workspaceId))).toEqual(
      new Set([workspaceId, otherWorkspaceId]),
    );
    expect(JSON.stringify(bundle)).toContain('tenant-defined-profile-dimension');
    expect(JSON.stringify(bundle)).toContain('tenant-defined-offering-dimension');

    await expect(
      store.readTenantExportArchive({
        sessionToken: 'task-17-export-owner-session',
        context: { ...ownerContext, tenantId: randomUUID() },
        exportId: result.export.id,
      }),
    ).resolves.toBeNull();
    await expect(
      store.readTenantExportArchive({
        sessionToken: 'task-17-export-owner-session',
        context: { ...ownerContext, workspaceId: otherWorkspaceId },
        exportId: result.export.id,
      }),
    ).resolves.toBeNull();
    await expect(
      store.readTenantExportArchive({
        sessionToken: 'task-17-export-owner-session',
        context: ownerContext,
        exportId: randomUUID(),
      }),
    ).resolves.toBeNull();

    const repeated = await service.exportTenant(request);
    expect(repeated).toMatchObject({ outcome: 'SUCCEEDED', export: { id: result.export.id } });
    expect(objects.size).toBe(1);

    const originalRead = objects.readExportVersion.bind(objects);
    vi.spyOn(objects, 'readExportVersion').mockImplementation(async (input) => {
      const stored = await originalRead(input);
      if (stored === null) return null;
      const tampered = JSON.parse(new TextDecoder().decode(stored.body)) as {
        files: Array<{ content: { payload: unknown } }>;
      };
      const first = tampered.files[0];
      if (first !== undefined) first.content.payload = { tampered: true };
      return {
        object: stored.object,
        body: new TextEncoder().encode(JSON.stringify(tampered)),
      };
    });
    await expect(
      store.readTenantExportArchive({
        sessionToken: 'task-17-export-owner-session',
        context: ownerContext,
        exportId: result.export.id,
      }),
    ).resolves.toBeNull();
  });

  test('persists a valid empty Tenant bundle rather than inventing a placeholder object', async () => {
    const now = new Date('2026-07-22T06:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const actorUserId = randomUUID();
    const membershipId = randomUUID();
    const tenancy = new InMemoryTenancyStore();
    await tenancy.bootstrapTenant({
      actorSubject: 'empty-export-owner',
      actorEmail: 'empty-export-owner@example.test',
      tenantId,
      tenantName: 'Empty Tenant',
      workspaceId,
      workspaceName: 'Empty Workspace',
      userId: actorUserId,
      membershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    const store = new InMemoryPrivacyAuditStore({
      auth: new InMemoryAuthStore(),
      tenancy,
      jobs: new InMemoryJobBudgetStore(),
      authorizations: new InMemoryChannelAuthorizationStore(),
      objects: new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock }),
      secrets: new InMemorySecretLifecycleStore(clock),
      clock,
    });
    const manifest = {
      schemaVersion: '1.0.0' as const,
      tenantId,
      timeRange: {
        from: '2026-07-22T05:00:00.000Z',
        to: '2026-07-22T07:00:00.000Z',
      },
      objects: [],
      files: [],
      disclosures: {
        tenantScope: TENANT_EXPORT_SCOPE_DISCLOSURE,
        integrity: TENANT_EXPORT_INTEGRITY_DISCLOSURE,
        noGuarantee: TENANT_EXPORT_NO_GUARANTEE_DISCLOSURE,
      },
    };
    const exportId = randomUUID();
    const checksum = privacySha256(canonicalPrivacyJson(manifest));
    const ownerContext = {
      tenantId,
      workspaceId,
      actorUserId,
      membershipId,
      role: 'OWNER' as const,
    };
    const foreignManifest = { ...manifest, tenantId: randomUUID() };
    await expect(
      store.saveTenantExport({
        context: ownerContext,
        exportId: randomUUID(),
        manifest: foreignManifest,
        canonicalFiles: [],
        checksum: privacySha256(canonicalPrivacyJson(foreignManifest)),
        requestHash: privacySha256('foreign-empty-export'),
        createdAt: now,
        auditEventId: randomUUID(),
      }),
    ).resolves.toEqual({ outcome: 'PIPELINE_UNAVAILABLE' });
    await expect(
      store.saveTenantExport({
        context: ownerContext,
        exportId,
        manifest,
        canonicalFiles: [],
        checksum,
        requestHash: privacySha256('empty-export'),
        createdAt: now,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED', archiveStatus: 'READY' });
    const archive = await store.readTenantExportArchive({
      sessionToken: 'task-17-empty-export-owner-session',
      context: ownerContext,
      exportId,
    });
    expect(archive).not.toBeNull();
    expect(JSON.parse(new TextDecoder().decode(archive?.body))).toMatchObject({
      manifest: { objects: [], files: [] },
      files: [],
    });
  });

  test('rejects a manifest object that is not bound to its exact canonical file content', async () => {
    const now = new Date('2026-07-22T06:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const actorUserId = randomUUID();
    const membershipId = randomUUID();
    const tenancy = new InMemoryTenancyStore();
    await tenancy.bootstrapTenant({
      actorSubject: 'mismatched-manifest-owner',
      actorEmail: 'mismatched-manifest-owner@example.test',
      tenantId,
      tenantName: 'Manifest Tenant',
      workspaceId,
      workspaceName: 'Manifest Workspace',
      userId: actorUserId,
      membershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    const store = new InMemoryPrivacyAuditStore({
      auth: new InMemoryAuthStore(),
      tenancy,
      jobs: new InMemoryJobBudgetStore(),
      authorizations: new InMemoryChannelAuthorizationStore(),
      objects: new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock }),
      secrets: new InMemorySecretLifecycleStore(clock),
      clock,
    });
    const objectId = randomUUID();
    const canonicalContent = canonicalPrivacyJson({
      schemaVersion: 'tenant-export-object.v1',
      tenantId,
      workspaceId,
      kind: 'PROFILE_REVISION',
      objectId,
      occurredAt: '2026-07-22T05:30:00.000Z',
      payload: { displayName: 'Bound content' },
    });
    const contentHash = privacySha256(canonicalContent);
    const path = `objects/profile_revision/${encodeURIComponent(objectId)}.json`;
    const manifest = {
      schemaVersion: '1.0.0' as const,
      tenantId,
      timeRange: {
        from: '2026-07-22T05:00:00.000Z',
        to: '2026-07-22T05:59:59.000Z',
      },
      objects: [{ kind: 'PROFILE_REVISION' as const, objectId: randomUUID(), contentHash }],
      files: [
        {
          path,
          contentHash,
          byteLength: Buffer.byteLength(canonicalContent, 'utf8'),
          objectCount: 1,
        },
      ],
      disclosures: {
        tenantScope: TENANT_EXPORT_SCOPE_DISCLOSURE,
        integrity: TENANT_EXPORT_INTEGRITY_DISCLOSURE,
        noGuarantee: TENANT_EXPORT_NO_GUARANTEE_DISCLOSURE,
      },
    };

    await expect(
      store.saveTenantExport({
        context: { tenantId, workspaceId, actorUserId, membershipId, role: 'OWNER' },
        exportId: randomUUID(),
        manifest,
        canonicalFiles: [
          {
            path,
            content: canonicalContent,
            contentHash,
            byteLength: Buffer.byteLength(canonicalContent, 'utf8'),
          },
        ],
        checksum: privacySha256(canonicalPrivacyJson(manifest)),
        requestHash: privacySha256('mismatched-manifest-object'),
        createdAt: now,
        auditEventId: randomUUID(),
      }),
    ).resolves.toEqual({ outcome: 'PIPELINE_UNAVAILABLE' });
  });

  test('rejects source objects outside the Tenant and revalidates Owner context after source I/O', async () => {
    const now = new Date('2026-07-22T08:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const actorUserId = randomUUID();
    const membershipId = randomUUID();
    const tenancy = new InMemoryTenancyStore();
    await tenancy.bootstrapTenant({
      actorSubject: 'source-scope-owner',
      actorEmail: 'source-scope-owner@example.test',
      tenantId,
      tenantName: 'Source scope Tenant',
      workspaceId,
      workspaceName: 'Source scope Workspace',
      userId: actorUserId,
      membershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    let sourceMode: 'FOREIGN_WORKSPACE' | 'FREEZE_DURING_IO' = 'FOREIGN_WORKSPACE';
    const store = new InMemoryPrivacyAuditStore({
      auth: new InMemoryAuthStore(),
      tenancy,
      jobs: new InMemoryJobBudgetStore(),
      authorizations: new InMemoryChannelAuthorizationStore(),
      objects: new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock }),
      secrets: new InMemorySecretLifecycleStore(clock),
      clock,
      exportSources: [
        {
          listTenantExportObjects: () =>
            Promise.resolve().then(() => {
              if (sourceMode === 'FREEZE_DURING_IO') {
                tenancy.freezeWorkspace({ tenantId, workspaceId, frozenAt: now });
              }
              return [
                {
                  tenantId,
                  workspaceId: sourceMode === 'FOREIGN_WORKSPACE' ? randomUUID() : workspaceId,
                  kind: 'PROFILE_REVISION',
                  objectId: randomUUID(),
                  occurredAt: '2026-07-22T06:00:00.000Z',
                  payload: { displayName: 'Scoped source object' },
                },
              ];
            }),
        },
      ],
    });
    const context = {
      tenantId,
      workspaceId,
      actorUserId,
      membershipId,
      role: 'OWNER' as const,
    };
    const range = {
      context,
      from: new Date('2026-07-22T05:00:00.000Z'),
      to: new Date('2026-07-22T07:00:00.000Z'),
    };

    await expect(store.loadTenantExportObjects(range)).resolves.toEqual({
      outcome: 'PIPELINE_UNAVAILABLE',
    });

    sourceMode = 'FREEZE_DURING_IO';
    await expect(store.loadTenantExportObjects(range)).resolves.toEqual({ outcome: 'NOT_FOUND' });
  });
});

function createSourceObjects(input: {
  tenantId: string;
  workspaceId: string;
  otherWorkspaceId: string;
  occurredAt: Date;
}): TenantExportSourceObject[] {
  const occurredAt = input.occurredAt.toISOString();
  const values: Array<[string, string, Record<string, unknown>]> = [
    ['PROFILE_REVISION', input.workspaceId, { dimension: 'tenant-defined-profile-dimension' }],
    [
      'OFFERING_REVISION',
      input.otherWorkspaceId,
      { dimension: 'tenant-defined-offering-dimension' },
    ],
    ['CLAIM_REVISION', input.workspaceId, { status: 'APPROVED' }],
    ['ARTIFACT', input.otherWorkspaceId, { status: 'APPROVED' }],
    ['MEASUREMENT_RUN', input.workspaceId, { status: 'COMPLETED' }],
    ['METRIC_SNAPSHOT', input.otherWorkspaceId, { metricKey: 'MENTION_RATE', value: 0.5 }],
    ['PUBLICATION', input.workspaceId, { status: 'PUBLISHED' }],
    ['AUDIT_EVENT', input.otherWorkspaceId, { action: 'TENANT_CREATED' }],
  ];
  return values.map(([kind, workspaceId, payload]) => ({
    tenantId: input.tenantId,
    workspaceId,
    kind,
    objectId: randomUUID(),
    occurredAt,
    payload,
  }));
}
