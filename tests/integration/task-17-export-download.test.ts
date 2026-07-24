import { createHash, randomUUID } from 'node:crypto';

import { InMemorySecretLifecycleStore } from '@aeostudio/adapters/secrets';
import { FakePrivacyObjectStorage } from '@aeostudio/adapters/storage';
import { privacySha256 } from '@aeostudio/application/privacy-audit';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createApiApp } from '../../apps/api/src/app.js';
import { InMemoryAuthStore } from '../../apps/api/src/auth/auth-store.memory.js';
import { InMemoryChannelAuthorizationStore } from '../../apps/api/src/channels/in-memory-channel-authorization-store.js';
import { InMemoryJobBudgetStore } from '../../apps/api/src/jobs/in-memory-job-budget-store.js';
import { InMemoryAuditSink } from '../../apps/api/src/privacy/in-memory-audit-sink.js';
import { InMemoryPrivacyAuditStore } from '../../apps/api/src/privacy/in-memory-privacy-audit-store.js';
import { InMemoryTenancyStore } from '../../apps/api/src/tenants/in-memory-tenancy-store.js';

type ApiTestApp = Awaited<ReturnType<typeof createApiApp>>;

describe('Task 17 authenticated export download', () => {
  let app: ApiTestApp | undefined;

  afterEach(async () => {
    await app?.close();
  });

  test('serves only the exact active Owner archive and rejects guessed or frozen scopes', async () => {
    const now = new Date('2026-07-22T08:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const actorSubject = 'task-17-download-owner';
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const actorUserId = randomUUID();
    const membershipId = randomUUID();
    const auth = new InMemoryAuthStore();
    const tenancy = new InMemoryTenancyStore();
    await tenancy.bootstrapTenant({
      actorSubject,
      actorEmail: 'task-17-download-owner@example.test',
      tenantId,
      tenantName: 'Download Tenant',
      workspaceId,
      workspaceName: 'Download Workspace',
      userId: actorUserId,
      membershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    const privacy = new InMemoryPrivacyAuditStore({
      auth,
      tenancy,
      jobs: new InMemoryJobBudgetStore(),
      authorizations: new InMemoryChannelAuthorizationStore(),
      objects: new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock }),
      secrets: new InMemorySecretLifecycleStore(clock),
      clock,
      exportSources: [
        {
          listTenantExportObjects: () =>
            Promise.resolve([
              {
                tenantId,
                workspaceId,
                kind: 'PROFILE_REVISION',
                objectId: randomUUID(),
                occurredAt: '2026-07-22T06:00:00.000Z',
                payload: { customDimension: 'portable-profile-value' },
              },
              {
                tenantId,
                workspaceId,
                kind: 'OFFERING_REVISION',
                objectId: randomUUID(),
                occurredAt: '2026-07-22T06:01:00.000Z',
                payload: { customDimension: 'portable-offering-value' },
              },
            ]),
        },
      ],
    });
    const ownerSession = 'task-17-download-session';
    await saveSession(auth, ownerSession, actorSubject, now);
    app = await createApiApp({
      store: auth,
      tenancyStore: tenancy,
      privacyAuditStore: privacy,
      now: () => new Date(now),
      clock,
      webOrigin: 'https://app.example.test',
    });

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/privacy/exports`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { from: '2026-07-22T05:00:00.000Z', to: '2026-07-22T07:00:00.000Z' },
    });
    expect(created.statusCode).toBe(201);
    const exportRecord = created.json<{
      data: { export: { id: string; checksum: string; archiveStatus: string } };
    }>().data.export;
    expect(exportRecord.archiveStatus).toBe('READY');

    const url = `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/privacy/exports/${exportRecord.id}/download`;
    const downloaded = await app.inject({
      method: 'GET',
      url,
      headers: { cookie: `__Host-aeo_session=${ownerSession}` },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['cache-control']).toBe('private, no-store');
    expect(downloaded.headers['content-disposition']).toContain(
      `tenant-export-${exportRecord.id}.json`,
    );
    expect(downloaded.headers['x-aeo-export-manifest-checksum']).toBe(exportRecord.checksum);
    expect(downloaded.headers['x-aeo-export-archive-checksum']).toBe(
      privacySha256(downloaded.rawPayload),
    );
    const bundle = downloaded.json<{
      files: Array<{ content: { payload: unknown } }>;
    }>();
    expect(JSON.stringify(bundle)).toContain('portable-profile-value');
    expect(JSON.stringify(bundle)).toContain('portable-offering-value');

    const guessed = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/privacy/exports/${randomUUID()}/download`,
      headers: { cookie: `__Host-aeo_session=${ownerSession}` },
    });
    expect(guessed.statusCode).toBe(404);
    expect(guessed.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });

    const crossTenant = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${randomUUID()}/workspaces/${workspaceId}/privacy/exports/${exportRecord.id}/download`,
      headers: { cookie: `__Host-aeo_session=${ownerSession}` },
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });

    const futureRange = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/privacy/exports`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { from: '2026-07-22T05:00:00.000Z', to: '2026-07-22T09:00:00.000Z' },
    });
    expect(futureRange.statusCode).toBe(400);
    expect(futureRange.json()).toMatchObject({ code: 'INVALID_TIME_RANGE' });

    await privacy.requestTenantDeletion({
      actorSubject,
      context: { tenantId, workspaceId, actorUserId, membershipId, role: 'OWNER' },
      requestId: randomUUID(),
      reason: 'Freeze after export to verify active-only download.',
      requestHash: privacySha256('freeze-after-export'),
      requestedAt: now,
      auditEventId: randomUUID(),
    });
    const freshFrozenSession = 'task-17-frozen-download-session';
    await saveSession(auth, freshFrozenSession, actorSubject, now);
    const frozen = await app.inject({
      method: 'GET',
      url,
      headers: { cookie: `__Host-aeo_session=${freshFrozenSession}` },
    });
    expect(frozen.statusCode).toBe(404);
    expect(frozen.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });
  });

  test('reuses a tenant-wide export and lets its Owner download it from another active Workspace', async () => {
    const now = new Date('2026-07-22T08:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const actorSubject = 'task-17-cross-workspace-export-owner';
    const tenantId = randomUUID();
    const createdFromWorkspaceId = randomUUID();
    const activeWorkspaceId = randomUUID();
    const actorUserId = randomUUID();
    const sourceObjectId = randomUUID();
    const auth = new InMemoryAuthStore();
    const tenancy = new InMemoryTenancyStore();
    await tenancy.bootstrapTenant({
      actorSubject,
      actorEmail: 'task-17-cross-workspace-export-owner@example.test',
      tenantId,
      tenantName: 'Portable Tenant',
      workspaceId: createdFromWorkspaceId,
      workspaceName: 'Created From Workspace',
      userId: actorUserId,
      membershipId: randomUUID(),
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    await tenancy.bootstrapTenant({
      actorSubject,
      actorEmail: 'task-17-cross-workspace-export-owner@example.test',
      tenantId,
      tenantName: 'Portable Tenant',
      workspaceId: activeWorkspaceId,
      workspaceName: 'Current Active Workspace',
      userId: actorUserId,
      membershipId: randomUUID(),
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    const objects = new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock });
    const putExportVersion = objects.putExportVersion.bind(objects);
    vi.spyOn(objects, 'putExportVersion').mockImplementation(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return putExportVersion(input);
    });
    const audit = new InMemoryAuditSink(clock);
    const privacy = new InMemoryPrivacyAuditStore({
      auth,
      tenancy,
      jobs: new InMemoryJobBudgetStore(),
      authorizations: new InMemoryChannelAuthorizationStore(),
      objects,
      secrets: new InMemorySecretLifecycleStore(clock),
      clock,
      audit,
      exportSources: [
        {
          listTenantExportObjects: () =>
            Promise.resolve([
              {
                tenantId,
                workspaceId: createdFromWorkspaceId,
                kind: 'PROFILE_REVISION',
                objectId: sourceObjectId,
                occurredAt: '2026-07-22T06:00:00.000Z',
                payload: { customDimension: 'tenant-wide-portable-value' },
              },
            ]),
        },
      ],
    });
    const ownerSession = 'task-17-cross-workspace-export-session';
    await saveSession(auth, ownerSession, actorSubject, now);
    app = await createApiApp({
      store: auth,
      tenancyStore: tenancy,
      privacyAuditStore: privacy,
      now: () => new Date(now),
      clock,
      webOrigin: 'https://app.example.test',
    });
    const payload = {
      from: '2026-07-22T05:00:00.000Z',
      to: '2026-07-22T07:00:00.000Z',
    };
    const headers = {
      cookie: `__Host-aeo_session=${ownerSession}`,
      origin: 'https://app.example.test',
    };

    const [created, retried] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${tenantId}/workspaces/${createdFromWorkspaceId}/privacy/exports`,
        headers,
        payload,
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${tenantId}/workspaces/${activeWorkspaceId}/privacy/exports`,
        headers,
        payload,
      }),
    ]);
    expect(created.statusCode).toBe(201);
    const createdExport = created.json<{ data: { export: { id: string } } }>().data.export;
    expect(retried.statusCode).toBe(201);
    expect(retried.json()).toMatchObject({ data: { export: { id: createdExport.id } } });
    expect(objects.size).toBe(1);
    expect(
      audit.listTenant(tenantId).filter(({ action }) => action === 'TENANT_EXPORT_CREATED'),
    ).toHaveLength(1);

    const equivalentRange = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/workspaces/${activeWorkspaceId}/privacy/exports`,
      headers,
      payload: { from: '2026-07-22T05:00:00Z', to: payload.to },
    });
    expect(equivalentRange.statusCode).toBe(201);
    expect(equivalentRange.json()).toMatchObject({
      data: { export: { id: createdExport.id } },
    });
    expect(objects.size).toBe(1);

    const downloaded = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/workspaces/${activeWorkspaceId}/privacy/exports/${createdExport.id}/download`,
      headers: { cookie: `__Host-aeo_session=${ownerSession}` },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toContain('tenant-wide-portable-value');
  });

  test('fails closed for tenant-wide export creation and download when any Workspace is frozen', async () => {
    const now = new Date('2026-07-22T08:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const actorSubject = 'task-17-partially-frozen-export-owner';
    const tenantId = randomUUID();
    const activeWorkspaceId = randomUUID();
    const frozenWorkspaceId = randomUUID();
    const actorUserId = randomUUID();
    const activeMembershipId = randomUUID();
    const frozenMembershipId = randomUUID();
    const sourceObjectId = randomUUID();
    const auth = new InMemoryAuthStore();
    const tenancy = new InMemoryTenancyStore();
    await tenancy.bootstrapTenant({
      actorSubject,
      actorEmail: 'task-17-partially-frozen-export-owner@example.test',
      tenantId,
      tenantName: 'Fail Closed Tenant',
      workspaceId: activeWorkspaceId,
      workspaceName: 'Still Active Workspace',
      userId: actorUserId,
      membershipId: activeMembershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    await tenancy.bootstrapTenant({
      actorSubject,
      actorEmail: 'task-17-partially-frozen-export-owner@example.test',
      tenantId,
      tenantName: 'Fail Closed Tenant',
      workspaceId: frozenWorkspaceId,
      workspaceName: 'Frozen Workspace',
      userId: actorUserId,
      membershipId: frozenMembershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    const objects = new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock });
    const audit = new InMemoryAuditSink(clock);
    const privacy = new InMemoryPrivacyAuditStore({
      auth,
      tenancy,
      jobs: new InMemoryJobBudgetStore(),
      authorizations: new InMemoryChannelAuthorizationStore(),
      objects,
      secrets: new InMemorySecretLifecycleStore(clock),
      clock,
      audit,
      exportSources: [
        {
          listTenantExportObjects: () =>
            Promise.resolve([
              {
                tenantId,
                workspaceId: activeWorkspaceId,
                kind: 'PROFILE_REVISION',
                objectId: sourceObjectId,
                occurredAt: '2026-07-22T06:00:00.000Z',
                payload: { customDimension: 'must-not-cross-frozen-boundary' },
              },
            ]),
        },
      ],
    });
    const initialSession = 'task-17-partially-frozen-initial-session';
    await saveSession(auth, initialSession, actorSubject, now);
    app = await createApiApp({
      store: auth,
      tenancyStore: tenancy,
      privacyAuditStore: privacy,
      now: () => new Date(now),
      clock,
      webOrigin: 'https://app.example.test',
    });
    const initial = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/workspaces/${activeWorkspaceId}/privacy/exports`,
      headers: {
        cookie: `__Host-aeo_session=${initialSession}`,
        origin: 'https://app.example.test',
      },
      payload: { from: '2026-07-22T05:00:00.000Z', to: '2026-07-22T07:00:00.000Z' },
    });
    expect(initial.statusCode).toBe(201);
    const exportId = initial.json<{ data: { export: { id: string } } }>().data.export.id;

    const putExportVersion = objects.putExportVersion.bind(objects);
    vi.spyOn(objects, 'putExportVersion').mockImplementationOnce(async (input) => {
      const object = await putExportVersion(input);
      await expect(
        privacy.requestWorkspaceDeletion({
          actorSubject,
          context: {
            tenantId,
            workspaceId: frozenWorkspaceId,
            actorUserId,
            membershipId: frozenMembershipId,
            role: 'OWNER',
          },
          requestId: randomUUID(),
          reason: 'Freeze one Workspace to close the tenant-wide export boundary.',
          requestHash: privacySha256('freeze-one-workspace'),
          requestedAt: now,
          auditEventId: randomUUID(),
        }),
      ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
      return object;
    });
    const racedCreate = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/workspaces/${activeWorkspaceId}/privacy/exports`,
      headers: {
        cookie: `__Host-aeo_session=${initialSession}`,
        origin: 'https://app.example.test',
      },
      payload: { from: '2026-07-22T05:30:00.000Z', to: '2026-07-22T07:00:00.000Z' },
    });
    expect(racedCreate.statusCode).toBe(503);
    expect(racedCreate.json()).toMatchObject({ code: 'PRIVACY_PIPELINE_UNAVAILABLE' });
    expect(
      audit.listTenant(tenantId).filter(({ action }) => action === 'TENANT_EXPORT_CREATED'),
    ).toHaveLength(1);
    expect(objects.size).toBe(1);
    const freshSession = 'task-17-partially-frozen-fresh-session';
    await saveSession(auth, freshSession, actorSubject, now);

    const downloaded = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/workspaces/${activeWorkspaceId}/privacy/exports/${exportId}/download`,
      headers: { cookie: `__Host-aeo_session=${freshSession}` },
    });
    expect(downloaded.statusCode).toBe(404);
    expect(downloaded.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/workspaces/${activeWorkspaceId}/privacy/exports`,
      headers: {
        cookie: `__Host-aeo_session=${freshSession}`,
        origin: 'https://app.example.test',
      },
      payload: { from: '2026-07-22T05:30:00.000Z', to: '2026-07-22T07:00:00.000Z' },
    });
    expect(created.statusCode).toBe(404);
    expect(created.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });
  });

  test.each(['workspace freeze', 'owner role downgrade'] as const)(
    'revalidates exact current Owner authorization after archive I/O when %s happens',
    async (authorizationChange) => {
      const now = new Date('2026-07-22T08:00:00.000Z');
      const clock = { now: () => new Date(now) };
      const actorSubject = 'task-17-export-read-race-owner';
      const tenantId = randomUUID();
      const workspaceId = randomUUID();
      const actorUserId = randomUUID();
      const membershipId = randomUUID();
      const auth = new InMemoryAuthStore();
      const tenancy = new InMemoryTenancyStore();
      await tenancy.bootstrapTenant({
        actorSubject,
        actorEmail: 'task-17-export-read-race-owner@example.test',
        tenantId,
        tenantName: 'Archive Race Tenant',
        workspaceId,
        workspaceName: 'Archive Race Workspace',
        userId: actorUserId,
        membershipId,
        roleBindingId: randomUUID(),
        auditEventId: randomUUID(),
      });
      const objects = new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock });
      const privacy = new InMemoryPrivacyAuditStore({
        auth,
        tenancy,
        jobs: new InMemoryJobBudgetStore(),
        authorizations: new InMemoryChannelAuthorizationStore(),
        objects,
        secrets: new InMemorySecretLifecycleStore(clock),
        clock,
        exportSources: [
          {
            listTenantExportObjects: () =>
              Promise.resolve([
                {
                  tenantId,
                  workspaceId,
                  kind: 'PROFILE_REVISION',
                  objectId: randomUUID(),
                  occurredAt: '2026-07-22T06:00:00.000Z',
                  payload: { customDimension: 'race-must-not-leak' },
                },
              ]),
          },
        ],
      });
      const ownerSession = 'task-17-export-read-race-session';
      await saveSession(auth, ownerSession, actorSubject, now);
      app = await createApiApp({
        store: auth,
        tenancyStore: tenancy,
        privacyAuditStore: privacy,
        now: () => new Date(now),
        clock,
        webOrigin: 'https://app.example.test',
      });
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/privacy/exports`,
        headers: {
          cookie: `__Host-aeo_session=${ownerSession}`,
          origin: 'https://app.example.test',
        },
        payload: { from: '2026-07-22T05:00:00.000Z', to: '2026-07-22T07:00:00.000Z' },
      });
      expect(created.statusCode).toBe(201);
      const exportId = created.json<{ data: { export: { id: string } } }>().data.export.id;
      const ownerContext = {
        tenantId,
        workspaceId,
        actorUserId,
        membershipId,
        role: 'OWNER' as const,
      };
      const originalRead = objects.readExportVersion.bind(objects);
      const readSpy = vi.spyOn(objects, 'readExportVersion').mockImplementation(async (input) => {
        const result = await originalRead(input);
        if (authorizationChange === 'workspace freeze') {
          tenancy.freezeWorkspace({ tenantId, workspaceId, frozenAt: now });
        } else {
          await tenancy.changeMembershipRole({
            context: ownerContext,
            membershipId,
            role: 'EDITOR',
            auditEventId: randomUUID(),
          });
        }
        return result;
      });

      const downloaded = await app.inject({
        method: 'GET',
        url: `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/privacy/exports/${exportId}/download`,
        headers: { cookie: `__Host-aeo_session=${ownerSession}` },
      });
      expect(downloaded.statusCode).toBe(404);
      expect(downloaded.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });
      readSpy.mockRestore();

      if (authorizationChange === 'owner role downgrade') {
        await tenancy.changeMembershipRole({
          context: ownerContext,
          membershipId,
          role: 'OWNER',
          auditEventId: randomUUID(),
        });
        await expect(
          privacy.readTenantExportArchive({
            sessionToken: ownerSession,
            context: {
              ...ownerContext,
              actorUserId: randomUUID(),
              membershipId: randomUUID(),
            },
            exportId,
          }),
        ).resolves.toBeNull();
        await tenancy.revokeMembership({
          context: ownerContext,
          membershipId,
          auditEventId: randomUUID(),
        });
        await expect(
          privacy.readTenantExportArchive({
            sessionToken: ownerSession,
            context: ownerContext,
            exportId,
          }),
        ).resolves.toBeNull();
      }
    },
  );
});

function saveSession(
  auth: InMemoryAuthStore,
  token: string,
  subject: string,
  createdAt: Date,
): Promise<void> {
  return auth.saveSession({
    tokenDigest: createHash('sha256').update(token, 'utf8').digest('base64url'),
    subject,
    email: `${subject}@example.test`,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 8 * 60 * 60 * 1_000),
    revokedAt: null,
  });
}
