import { randomUUID } from 'node:crypto';

import { InMemorySecretLifecycleStore } from '@aeostudio/adapters/secrets';
import { FakePrivacyObjectStorage } from '@aeostudio/adapters/storage';
import { canonicalPrivacyJson, privacySha256 } from '@aeostudio/application/privacy-audit';
import {
  TENANT_EXPORT_INTEGRITY_DISCLOSURE,
  TENANT_EXPORT_NO_GUARANTEE_DISCLOSURE,
  TENANT_EXPORT_SCOPE_DISCLOSURE,
} from '@aeostudio/contracts/privacy-audit';
import { describe, expect, test } from 'vitest';

import { InMemoryAuthStore } from '../../apps/api/src/auth/auth-store.memory.js';
import { InMemoryChannelAuthorizationStore } from '../../apps/api/src/channels/in-memory-channel-authorization-store.js';
import { InMemoryJobBudgetStore } from '../../apps/api/src/jobs/in-memory-job-budget-store.js';
import { InMemoryAuditSink } from '../../apps/api/src/privacy/in-memory-audit-sink.js';
import { InMemoryPrivacyAuditStore } from '../../apps/api/src/privacy/in-memory-privacy-audit-store.js';
import { InMemoryTenancyStore } from '../../apps/api/src/tenants/in-memory-tenancy-store.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

describe('Task 17 fake deletion cleanup', () => {
  test('binds Legal Hold creation and release to the exact creator Workspace', async () => {
    const now = new Date('2026-07-22T08:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const tenancy = new InMemoryTenancyStore();
    const tenantId = randomUUID();
    const actorUserId = randomUUID();
    const contextA = await bootstrapOwner({
      tenancy,
      actorSubject: 'exact-hold-owner',
      actorEmail: 'exact-hold-owner@example.test',
      tenantId,
      workspaceId: randomUUID(),
      actorUserId,
    });
    const contextB = await bootstrapOwner({
      tenancy,
      actorSubject: 'exact-hold-owner',
      actorEmail: 'exact-hold-owner@example.test',
      tenantId,
      workspaceId: randomUUID(),
      actorUserId,
    });
    const objects = new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock });
    const store = new InMemoryPrivacyAuditStore({
      auth: new InMemoryAuthStore(),
      tenancy,
      jobs: new InMemoryJobBudgetStore(),
      authorizations: new InMemoryChannelAuthorizationStore(),
      objects,
      secrets: new InMemorySecretLifecycleStore(clock),
      clock,
    });
    const created = await saveReadyExport(store, contextA, contextA.workspaceId, now);
    const holdId = randomUUID();

    await expect(
      store.createLegalHold({
        context: contextB,
        holdId,
        name: 'Exact Workspace hold',
        reason: 'Only the creator Workspace may govern this exact version.',
        objectKey: created.objectKey,
        objectVersionId: created.objectVersionId,
        createdAt: now,
        auditEventId: randomUUID(),
      }),
    ).resolves.toEqual({ outcome: 'OBJECT_NOT_FOUND' });

    await expect(
      store.createLegalHold({
        context: contextA,
        holdId,
        name: 'Exact Workspace hold',
        reason: 'Only the creator Workspace may govern this exact version.',
        objectKey: created.objectKey,
        objectVersionId: created.objectVersionId,
        createdAt: now,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED', created: true });
    await expect(
      store.releaseLegalHold({
        context: contextB,
        holdId,
        releasedAt: now,
        auditEventId: randomUUID(),
      }),
    ).resolves.toEqual({ outcome: 'NOT_FOUND' });
    await expect(
      store.releaseLegalHold({
        context: contextA,
        holdId,
        releasedAt: now,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
  });

  test('makes Legal Hold creation replay-safe without orphaning a conflicting target', async () => {
    const now = new Date('2026-07-22T08:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const tenancy = new InMemoryTenancyStore();
    const context = await bootstrapOwner({
      tenancy,
      actorSubject: 'hold-replay-owner',
      actorEmail: 'hold-replay-owner@example.test',
      tenantId: randomUUID(),
      workspaceId: randomUUID(),
      actorUserId: randomUUID(),
    });
    const objects = new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock });
    const store = new InMemoryPrivacyAuditStore({
      auth: new InMemoryAuthStore(),
      tenancy,
      jobs: new InMemoryJobBudgetStore(),
      authorizations: new InMemoryChannelAuthorizationStore(),
      objects,
      secrets: new InMemorySecretLifecycleStore(clock),
      clock,
    });
    const first = await saveReadyExport(store, context, context.workspaceId, now);
    const conflicting = await saveReadyExport(store, context, context.workspaceId, now);
    const holdId = randomUUID();
    const auditEventId = randomUUID();
    const command = {
      context,
      holdId,
      name: 'Replay-safe hold',
      reason: 'The same command must converge on one exact hold.',
      objectKey: first.objectKey,
      objectVersionId: first.objectVersionId,
      createdAt: now,
      auditEventId,
    };
    const created = await store.createLegalHold(command);
    if (created.outcome !== 'SUCCEEDED') throw new Error('expected created Legal Hold');

    await expect(store.createLegalHold(command)).resolves.toEqual({
      outcome: 'SUCCEEDED',
      hold: created.hold,
      created: false,
    });
    await expect(
      store.createLegalHold({
        ...command,
        objectKey: conflicting.objectKey,
        objectVersionId: conflicting.objectVersionId,
      }),
    ).resolves.toEqual({ outcome: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      objects.deleteExportVersion({
        tenantId: context.tenantId,
        objectKey: conflicting.objectKey,
        objectVersionId: conflicting.objectVersionId,
        at: now,
      }),
    ).resolves.toMatchObject({ outcome: 'DELETED' });
  });

  test('serializes concurrent Legal Hold commands sharing one hold id', async () => {
    const now = new Date('2026-07-22T08:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const tenancy = new InMemoryTenancyStore();
    const context = await bootstrapOwner({
      tenancy,
      actorSubject: 'concurrent-hold-owner',
      actorEmail: 'concurrent-hold-owner@example.test',
      tenantId: randomUUID(),
      workspaceId: randomUUID(),
      actorUserId: randomUUID(),
    });
    const objects = new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock });
    const store = new InMemoryPrivacyAuditStore({
      auth: new InMemoryAuthStore(),
      tenancy,
      jobs: new InMemoryJobBudgetStore(),
      authorizations: new InMemoryChannelAuthorizationStore(),
      objects,
      secrets: new InMemorySecretLifecycleStore(clock),
      clock,
    });
    const first = await saveReadyExport(store, context, context.workspaceId, now);
    const conflicting = await saveReadyExport(store, context, context.workspaceId, now);
    const holdId = randomUUID();
    const base = {
      context,
      holdId,
      name: 'Concurrent exact hold',
      reason: 'Only one target may own a reused hold id.',
      createdAt: now,
    };
    const [created, rejected] = await Promise.all([
      store.createLegalHold({
        ...base,
        objectKey: first.objectKey,
        objectVersionId: first.objectVersionId,
        auditEventId: randomUUID(),
      }),
      store.createLegalHold({
        ...base,
        objectKey: conflicting.objectKey,
        objectVersionId: conflicting.objectVersionId,
        auditEventId: randomUUID(),
      }),
    ]);

    expect(created).toMatchObject({ outcome: 'SUCCEEDED', created: true });
    expect(rejected).toEqual({ outcome: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      objects.deleteExportVersion({
        tenantId: context.tenantId,
        objectKey: conflicting.objectKey,
        objectVersionId: conflicting.objectVersionId,
        at: now,
      }),
    ).resolves.toMatchObject({ outcome: 'DELETED' });
  });

  test('replays an exact Legal Hold release without duplicating its audit event', async () => {
    const now = new Date('2026-07-22T08:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const tenancy = new InMemoryTenancyStore();
    const context = await bootstrapOwner({
      tenancy,
      actorSubject: 'hold-release-replay-owner',
      actorEmail: 'hold-release-replay-owner@example.test',
      tenantId: randomUUID(),
      workspaceId: randomUUID(),
      actorUserId: randomUUID(),
    });
    const audit = new InMemoryAuditSink(clock);
    const store = new InMemoryPrivacyAuditStore({
      auth: new InMemoryAuthStore(),
      tenancy,
      jobs: new InMemoryJobBudgetStore(),
      authorizations: new InMemoryChannelAuthorizationStore(),
      objects: new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock }),
      secrets: new InMemorySecretLifecycleStore(clock),
      clock,
      audit,
    });
    const object = await saveReadyExport(store, context, context.workspaceId, now);
    const holdId = randomUUID();
    const created = await store.createLegalHold({
      context,
      holdId,
      name: 'Release replay hold',
      reason: 'A retried release must return the first immutable result.',
      objectKey: object.objectKey,
      objectVersionId: object.objectVersionId,
      createdAt: now,
      auditEventId: randomUUID(),
    });
    if (created.outcome !== 'SUCCEEDED') throw new Error('expected created Legal Hold');
    const first = await store.releaseLegalHold({
      context,
      holdId,
      releasedAt: now,
      auditEventId: randomUUID(),
    });
    if (first.outcome !== 'SUCCEEDED') throw new Error('expected released Legal Hold');

    await expect(
      store.releaseLegalHold({
        context,
        holdId,
        releasedAt: new Date(now.getTime() + 60_000),
        auditEventId: randomUUID(),
      }),
    ).resolves.toEqual(first);
    expect(
      audit.listTenant(context.tenantId).filter(({ action }) => action === 'LEGAL_HOLD_RELEASED'),
    ).toHaveLength(1);
  });

  test('a Workspace deletion clears every tenant-wide export while an exact hold retains only its version', async () => {
    const requestedAt = new Date('2026-07-22T08:00:00.000Z');
    let current = new Date(requestedAt);
    const clock = { now: () => new Date(current) };
    const tenancy = new InMemoryTenancyStore();
    const tenantId = randomUUID();
    const workspaceAId = randomUUID();
    const workspaceBId = randomUUID();
    const actorUserId = randomUUID();
    const contextA = await bootstrapOwner({
      tenancy,
      actorSubject: 'deletion-export-owner',
      actorEmail: 'deletion-export-owner@example.test',
      tenantId,
      workspaceId: workspaceAId,
      actorUserId,
    });
    const contextB = await bootstrapOwner({
      tenancy,
      actorSubject: 'deletion-export-owner',
      actorEmail: 'deletion-export-owner@example.test',
      tenantId,
      workspaceId: workspaceBId,
      actorUserId,
    });
    const foreignContext = await bootstrapOwner({
      tenancy,
      actorSubject: 'foreign-deletion-export-owner',
      actorEmail: 'foreign-deletion-export-owner@example.test',
      tenantId: randomUUID(),
      workspaceId: randomUUID(),
      actorUserId: randomUUID(),
    });
    const objects = new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock });
    const audit = new InMemoryAuditSink(clock);
    const store = new InMemoryPrivacyAuditStore({
      auth: new InMemoryAuthStore(),
      tenancy,
      jobs: new InMemoryJobBudgetStore(),
      authorizations: new InMemoryChannelAuthorizationStore(),
      objects,
      secrets: new InMemorySecretLifecycleStore(clock),
      clock,
      audit,
    });
    const unheld = await saveReadyExport(store, contextA, workspaceAId, requestedAt);
    const held = await saveReadyExport(store, contextB, workspaceAId, requestedAt);
    const foreign = await saveReadyExport(
      store,
      foreignContext,
      foreignContext.workspaceId,
      requestedAt,
    );
    expect(objects.size).toBe(3);

    const holdId = randomUUID();
    await expect(
      store.createLegalHold({
        context: contextB,
        holdId,
        name: 'Exact export evidence hold',
        reason: 'Retain only the named archive version.',
        objectKey: held.objectKey,
        objectVersionId: held.objectVersionId,
        createdAt: requestedAt,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
    const requestId = randomUUID();
    await expect(
      store.requestWorkspaceDeletion({
        actorSubject: 'deletion-export-owner',
        context: contextA,
        requestId,
        reason: 'Delete Workspace A including its data in every tenant-wide export.',
        requestHash: privacySha256('delete-workspace-a-tenant-wide-exports'),
        requestedAt,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });

    current = new Date(requestedAt.getTime() + 30 * DAY_MS);
    const activeLease = randomUUID();
    await expect(
      store.claimDueDeletionRequests({ leaseToken: activeLease, limit: 10 }),
    ).resolves.toEqual([
      expect.objectContaining({ requestId, stage: 'ACTIVE', leaseToken: activeLease }),
    ]);
    await expect(
      store.finalizeDeletion({
        requestId,
        leaseToken: activeLease,
        effectiveAt: current,
        tombstoneId: randomUUID(),
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      finalization: { state: 'ACTIVE_DATA_DELETED' },
    });
    expect(objects.size).toBe(3);

    current = new Date(requestedAt.getTime() + 90 * DAY_MS);
    const blockedLease = randomUUID();
    await expect(
      store.claimDueDeletionRequests({ leaseToken: blockedLease, limit: 10 }),
    ).resolves.toEqual([
      expect.objectContaining({ requestId, stage: 'BACKUP', leaseToken: blockedLease }),
    ]);
    await expect(
      store.finalizeDeletion({
        requestId,
        leaseToken: blockedLease,
        effectiveAt: current,
        tombstoneId: randomUUID(),
        auditEventId: randomUUID(),
      }),
    ).resolves.toEqual({ outcome: 'LEGAL_HOLD' });
    expect(objects.size).toBe(2);
    await expect(
      objects.readExportVersion({
        tenantId,
        objectKey: unheld.objectKey,
        objectVersionId: unheld.objectVersionId,
      }),
    ).resolves.toBeNull();
    await expect(
      objects.readExportVersion({
        tenantId,
        objectKey: held.objectKey,
        objectVersionId: held.objectVersionId,
      }),
    ).resolves.not.toBeNull();
    await expect(
      objects.readExportVersion({
        tenantId: foreignContext.tenantId,
        objectKey: foreign.objectKey,
        objectVersionId: foreign.objectVersionId,
      }),
    ).resolves.not.toBeNull();

    await expect(
      store.releaseLegalHold({
        context: contextB,
        holdId,
        releasedAt: current,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
    const resumedLease = randomUUID();
    await expect(
      store.claimDueDeletionRequests({ leaseToken: resumedLease, limit: 10 }),
    ).resolves.toEqual([
      expect.objectContaining({ requestId, stage: 'BACKUP', leaseToken: resumedLease }),
    ]);
    await expect(
      store.finalizeDeletion({
        requestId,
        leaseToken: resumedLease,
        effectiveAt: current,
        tombstoneId: randomUUID(),
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      finalization: { state: 'BACKUP_DELETED' },
    });
    expect(objects.size).toBe(1);
    await expect(
      objects.readExportVersion({
        tenantId,
        objectKey: held.objectKey,
        objectVersionId: held.objectVersionId,
      }),
    ).resolves.toBeNull();
    await expect(
      store.readTenantExportArchive({
        sessionToken: 'task-17-fake-cleanup-session',
        context: foreignContext,
        exportId: foreign.exportId,
      }),
    ).resolves.not.toBeNull();
    expect(
      audit
        .listTenant(tenantId)
        .filter(({ action }) => action === 'DELETION_BACKUP_BLOCKED_BY_LEGAL_HOLD'),
    ).toHaveLength(1);
  });
});

async function bootstrapOwner(input: {
  tenancy: InMemoryTenancyStore;
  actorSubject: string;
  actorEmail: string;
  tenantId: string;
  workspaceId: string;
  actorUserId: string;
}) {
  const membershipId = randomUUID();
  await input.tenancy.bootstrapTenant({
    actorSubject: input.actorSubject,
    actorEmail: input.actorEmail,
    tenantId: input.tenantId,
    tenantName: 'Deletion cleanup tenant',
    workspaceId: input.workspaceId,
    workspaceName: 'Deletion cleanup workspace',
    userId: input.actorUserId,
    membershipId,
    roleBindingId: randomUUID(),
    auditEventId: randomUUID(),
  });
  return {
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    membershipId,
    role: 'OWNER' as const,
  };
}

async function saveReadyExport(
  store: InMemoryPrivacyAuditStore,
  context: Awaited<ReturnType<typeof bootstrapOwner>>,
  sourceWorkspaceId: string,
  createdAt: Date,
) {
  const objectId = randomUUID();
  const occurredAt = new Date(createdAt.getTime() - 60_000).toISOString();
  const content = canonicalPrivacyJson({
    schemaVersion: 'tenant-export-object.v1',
    tenantId: context.tenantId,
    workspaceId: sourceWorkspaceId,
    kind: 'PROFILE_REVISION',
    objectId,
    occurredAt,
    payload: { sourceWorkspaceId },
  });
  const contentHash = privacySha256(content);
  const byteLength = new TextEncoder().encode(content).byteLength;
  const path = `objects/profile_revision/${encodeURIComponent(objectId)}.json`;
  const manifest = {
    schemaVersion: '1.0.0' as const,
    tenantId: context.tenantId,
    timeRange: {
      from: new Date(createdAt.getTime() - 120_000).toISOString(),
      to: new Date(createdAt.getTime() - 1).toISOString(),
    },
    objects: [{ kind: 'PROFILE_REVISION' as const, objectId, contentHash }],
    files: [{ path, contentHash, byteLength, objectCount: 1 }],
    disclosures: {
      tenantScope: TENANT_EXPORT_SCOPE_DISCLOSURE,
      integrity: TENANT_EXPORT_INTEGRITY_DISCLOSURE,
      noGuarantee: TENANT_EXPORT_NO_GUARANTEE_DISCLOSURE,
    },
  };
  const exportId = randomUUID();
  const saved = await store.saveTenantExport({
    context,
    exportId,
    manifest,
    canonicalFiles: [{ path, content, contentHash, byteLength }],
    checksum: privacySha256(canonicalPrivacyJson(manifest)),
    requestHash: privacySha256(randomUUID()),
    createdAt,
    auditEventId: randomUUID(),
  });
  if (saved.outcome !== 'SUCCEEDED' || saved.objectRef === null) {
    throw new Error('expected ready fake export');
  }
  const versionId = new URL(saved.objectRef).searchParams.get('versionId');
  if (versionId === null) throw new Error('expected fake object version');
  return {
    exportId,
    objectKey: `tenants/${context.tenantId}/exports/${exportId}.bundle.json`,
    objectVersionId: versionId,
  };
}
