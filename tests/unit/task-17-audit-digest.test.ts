import { randomUUID } from 'node:crypto';

import { InMemorySecretLifecycleStore } from '@aeostudio/adapters/secrets';
import { FakePrivacyObjectStorage } from '@aeostudio/adapters/storage';
import { canonicalPrivacyJson, privacySha256 } from '@aeostudio/application/privacy-audit';
import { describe, expect, test } from 'vitest';

import { InMemoryAuthStore } from '../../apps/api/src/auth/auth-store.memory.js';
import { InMemoryChannelAuthorizationStore } from '../../apps/api/src/channels/in-memory-channel-authorization-store.js';
import { InMemoryJobBudgetStore } from '../../apps/api/src/jobs/in-memory-job-budget-store.js';
import { InMemoryAuditSink } from '../../apps/api/src/privacy/in-memory-audit-sink.js';
import { InMemoryPrivacyAuditStore } from '../../apps/api/src/privacy/in-memory-privacy-audit-store.js';
import { InMemoryTenancyStore } from '../../apps/api/src/tenants/in-memory-tenancy-store.js';

describe('Task 17 audit digest', () => {
  test('binds an Audit digest hold to the exact sealing Workspace', async () => {
    const fixture = await createAuditDigestFixture();
    const siblingMembershipId = randomUUID();
    const siblingContext = {
      ...fixture.context,
      workspaceId: randomUUID(),
      membershipId: siblingMembershipId,
    };
    await fixture.tenancy.bootstrapTenant({
      actorSubject: 'audit-digest-owner',
      actorEmail: 'audit-digest-owner@example.test',
      tenantId: fixture.context.tenantId,
      tenantName: 'Audit digest tenant',
      workspaceId: siblingContext.workspaceId,
      workspaceName: 'Sibling audit digest workspace',
      userId: fixture.context.actorUserId,
      membershipId: siblingMembershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    const sealed = await fixture.store.sealAuditDigest({
      context: fixture.context,
      digestId: randomUUID(),
      from: new Date(fixture.now.getTime() - 60_000),
      to: new Date(fixture.now.getTime() - 1),
      auditEventId: randomUUID(),
    });
    if (sealed.outcome !== 'SUCCEEDED') throw new Error('expected sealed Audit digest');

    await expect(
      fixture.store.createLegalHold({
        context: siblingContext,
        holdId: randomUUID(),
        name: 'Exact digest Workspace hold',
        reason: 'A sibling Workspace must not govern this digest version.',
        objectKey: sealed.digest.objectKey,
        objectVersionId: sealed.digest.objectVersionId,
        createdAt: fixture.now,
        auditEventId: randomUUID(),
      }),
    ).resolves.toEqual({ outcome: 'OBJECT_NOT_FOUND' });
  });

  test('locks a self-verifiable digest body that includes the exact last sequence', async () => {
    const now = new Date('2026-07-22T08:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const actorUserId = randomUUID();
    const membershipId = randomUUID();
    const tenancy = new InMemoryTenancyStore();
    await tenancy.bootstrapTenant({
      actorSubject: 'audit-digest-owner',
      actorEmail: 'audit-digest-owner@example.test',
      tenantId,
      tenantName: 'Audit digest tenant',
      workspaceId,
      workspaceName: 'Audit digest workspace',
      userId: actorUserId,
      membershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
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
    const context = {
      tenantId,
      workspaceId,
      actorUserId,
      membershipId,
      role: 'OWNER' as const,
    };
    const from = new Date(now.getTime() - 60_000);
    const to = new Date(now.getTime() - 1);
    audit.append({
      id: randomUUID(),
      tenantId,
      workspaceId,
      actorKind: 'USER',
      actorId: actorUserId,
      action: 'AUDIT_DIGEST_TEST_EVENT',
      resourceType: 'AUDIT_DIGEST_TEST',
      resourceId: randomUUID(),
      outcome: 'SUCCEEDED',
      metadata: {},
      occurredAt: new Date(now.getTime() - 30_000),
    });

    const result = await store.sealAuditDigest({
      context,
      digestId: randomUUID(),
      from,
      to,
      auditEventId: randomUUID(),
    });

    expect(result.outcome).toBe('SUCCEEDED');
    if (result.outcome !== 'SUCCEEDED') throw new Error('expected sealed audit digest');
    expect(result.digest.lastSequence).toBeGreaterThan(0);
    const locked = await objects.readAuditVersion({
      tenantId,
      objectKey: result.digest.objectKey,
      objectVersionId: result.digest.objectVersionId,
    });
    expect(locked).not.toBeNull();
    const body = JSON.parse(new TextDecoder().decode(locked?.body)) as Record<string, unknown>;
    expect(body.lastSequence).toBe(result.digest.lastSequence);
    const { digestHash, ...canonicalDigest } = body;
    expect(digestHash).toBe(result.digest.digestHash);
    expect(privacySha256(canonicalPrivacyJson(canonicalDigest))).toBe(digestHash);
  });

  test('returns the first immutable digest for a repeated Tenant time range', async () => {
    const fixture = await createAuditDigestFixture();
    const from = new Date(fixture.now.getTime() - 60_000);
    const to = new Date(fixture.now.getTime() - 1);
    fixture.audit.append({
      id: randomUUID(),
      tenantId: fixture.context.tenantId,
      workspaceId: fixture.context.workspaceId,
      actorKind: 'USER',
      actorId: fixture.context.actorUserId,
      action: 'AUDIT_DIGEST_IDEMPOTENCY_EVENT',
      resourceType: 'AUDIT_DIGEST_TEST',
      resourceId: randomUUID(),
      outcome: 'SUCCEEDED',
      metadata: {},
      occurredAt: new Date(fixture.now.getTime() - 30_000),
    });

    const first = await fixture.store.sealAuditDigest({
      context: fixture.context,
      digestId: randomUUID(),
      from,
      to,
      auditEventId: randomUUID(),
    });
    const second = await fixture.store.sealAuditDigest({
      context: fixture.context,
      digestId: randomUUID(),
      from,
      to,
      auditEventId: randomUUID(),
    });

    expect(first.outcome).toBe('SUCCEEDED');
    expect(second.outcome).toBe('SUCCEEDED');
    if (first.outcome !== 'SUCCEEDED' || second.outcome !== 'SUCCEEDED') {
      throw new Error('expected idempotent audit digests');
    }
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, digest: first.digest });
    expect(fixture.objects.size).toBe(1);
    expect(
      fixture.audit
        .listTenant(fixture.context.tenantId)
        .filter(({ action }) => action === 'AUDIT_DIGEST_SEALED'),
    ).toHaveLength(1);
  });

  test('rejects one digest id reused for another range without publishing an orphan version', async () => {
    const fixture = await createAuditDigestFixture();
    const digestId = randomUUID();
    const first = await fixture.store.sealAuditDigest({
      context: fixture.context,
      digestId,
      from: new Date(fixture.now.getTime() - 120_000),
      to: new Date(fixture.now.getTime() - 60_001),
      auditEventId: randomUUID(),
    });
    expect(first.outcome).toBe('SUCCEEDED');
    expect(fixture.objects.size).toBe(1);

    await expect(
      fixture.store.sealAuditDigest({
        context: fixture.context,
        digestId,
        from: new Date(fixture.now.getTime() - 60_000),
        to: new Date(fixture.now.getTime() - 1),
        auditEventId: randomUUID(),
      }),
    ).resolves.toEqual({ outcome: 'IDEMPOTENCY_CONFLICT' });
    expect(fixture.objects.size).toBe(1);
    expect(
      fixture.audit
        .listTenant(fixture.context.tenantId)
        .filter(({ action }) => action === 'AUDIT_DIGEST_SEALED'),
    ).toHaveLength(1);
  });

  test('rejects a concurrent range conflict for one digest id before staging another version', async () => {
    const fixture = await createAuditDigestFixture(
      (clock) => new BlockingAuditObjectStorage({ ids: { next: randomUUID }, clock }),
    );
    const objects = fixture.objects as BlockingAuditObjectStorage;
    const digestId = randomUUID();
    const firstPromise = fixture.store.sealAuditDigest({
      context: fixture.context,
      digestId,
      from: new Date(fixture.now.getTime() - 120_000),
      to: new Date(fixture.now.getTime() - 60_001),
      auditEventId: randomUUID(),
    });
    await objects.firstPutStarted;
    const conflictingPromise = fixture.store.sealAuditDigest({
      context: fixture.context,
      digestId,
      from: new Date(fixture.now.getTime() - 60_000),
      to: new Date(fixture.now.getTime() - 1),
      auditEventId: randomUUID(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    objects.releasePuts();
    const [first, conflicting] = await Promise.all([firstPromise, conflictingPromise]);

    expect(first.outcome).toBe('SUCCEEDED');
    expect(conflicting).toEqual({ outcome: 'IDEMPOTENCY_CONFLICT' });
    expect(objects.putCount).toBe(1);
    expect(objects.size).toBe(1);
  });

  test('single-flights concurrent seals for the same Tenant time range', async () => {
    const fixture = await createAuditDigestFixture(
      (clock) => new BlockingAuditObjectStorage({ ids: { next: randomUUID }, clock }),
    );
    const objects = fixture.objects as BlockingAuditObjectStorage;
    const from = new Date(fixture.now.getTime() - 60_000);
    const to = new Date(fixture.now.getTime() - 1);
    fixture.audit.append({
      id: randomUUID(),
      tenantId: fixture.context.tenantId,
      workspaceId: fixture.context.workspaceId,
      actorKind: 'USER',
      actorId: fixture.context.actorUserId,
      action: 'AUDIT_DIGEST_CONCURRENCY_EVENT',
      resourceType: 'AUDIT_DIGEST_TEST',
      resourceId: randomUUID(),
      outcome: 'SUCCEEDED',
      metadata: {},
      occurredAt: new Date(fixture.now.getTime() - 30_000),
    });
    const firstInput = {
      context: fixture.context,
      digestId: randomUUID(),
      from,
      to,
      auditEventId: randomUUID(),
    };
    const secondInput = {
      ...firstInput,
      digestId: randomUUID(),
      auditEventId: randomUUID(),
    };

    const firstPromise = fixture.store.sealAuditDigest(firstInput);
    await objects.firstPutStarted;
    const secondPromise = fixture.store.sealAuditDigest(secondInput);
    await new Promise((resolve) => setTimeout(resolve, 20));
    objects.releasePuts();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.outcome).toBe('SUCCEEDED');
    expect(second.outcome).toBe('SUCCEEDED');
    if (first.outcome !== 'SUCCEEDED' || second.outcome !== 'SUCCEEDED') {
      throw new Error('expected concurrent audit digest seals');
    }
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, digest: first.digest });
    expect(objects.putCount).toBe(1);
    expect(objects.size).toBe(1);
    expect(
      fixture.audit
        .listTenant(fixture.context.tenantId)
        .filter(({ action }) => action === 'AUDIT_DIGEST_SEALED'),
    ).toHaveLength(1);
  });

  test('aborts an in-flight seal when the current Owner context becomes stale', async () => {
    const fixture = await createAuditDigestFixture(
      (clock) => new BlockingAuditObjectStorage({ ids: { next: randomUUID }, clock }),
    );
    const objects = fixture.objects as BlockingAuditObjectStorage;
    const seal = fixture.store.sealAuditDigest({
      context: fixture.context,
      digestId: randomUUID(),
      from: new Date(fixture.now.getTime() - 60_000),
      to: new Date(fixture.now.getTime() - 1),
      auditEventId: randomUUID(),
    });

    await objects.firstPutStarted;
    await fixture.tenancy.revokeMembership({
      context: fixture.context,
      membershipId: fixture.context.membershipId,
      auditEventId: randomUUID(),
    });
    objects.releasePuts();

    await expect(seal).resolves.toEqual({ outcome: 'PIPELINE_UNAVAILABLE' });
    expect(objects.size).toBe(0);
    expect(
      fixture.audit
        .listTenant(fixture.context.tenantId)
        .filter(({ action }) => action === 'AUDIT_DIGEST_SEALED'),
    ).toHaveLength(0);
  });

  test('aborts an in-flight seal when any Workspace in the Tenant freezes', async () => {
    const fixture = await createAuditDigestFixture(
      (clock) => new BlockingAuditObjectStorage({ ids: { next: randomUUID }, clock }),
    );
    const objects = fixture.objects as BlockingAuditObjectStorage;
    const siblingWorkspaceId = randomUUID();
    await fixture.tenancy.bootstrapTenant({
      actorSubject: 'audit-digest-owner',
      actorEmail: 'audit-digest-owner@example.test',
      tenantId: fixture.context.tenantId,
      tenantName: 'Audit digest tenant',
      workspaceId: siblingWorkspaceId,
      workspaceName: 'Sibling audit digest workspace',
      userId: fixture.context.actorUserId,
      membershipId: randomUUID(),
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    const seal = fixture.store.sealAuditDigest({
      context: fixture.context,
      digestId: randomUUID(),
      from: new Date(fixture.now.getTime() - 60_000),
      to: new Date(fixture.now.getTime() - 1),
      auditEventId: randomUUID(),
    });

    await objects.firstPutStarted;
    fixture.tenancy.freezeWorkspace({
      tenantId: fixture.context.tenantId,
      workspaceId: siblingWorkspaceId,
      frozenAt: fixture.now,
    });
    objects.releasePuts();

    await expect(seal).resolves.toEqual({ outcome: 'PIPELINE_UNAVAILABLE' });
    expect(objects.size).toBe(0);
    expect(
      fixture.audit
        .listTenant(fixture.context.tenantId)
        .filter(({ action }) => action === 'AUDIT_DIGEST_SEALED'),
    ).toHaveLength(0);
  });

  test('aborts an in-flight seal when the verified Audit range changes before commit', async () => {
    const fixture = await createAuditDigestFixture(
      (clock) => new BlockingAuditObjectStorage({ ids: { next: randomUUID }, clock }),
    );
    const objects = fixture.objects as BlockingAuditObjectStorage;
    const from = new Date(fixture.now.getTime() - 60_000);
    const to = new Date(fixture.now.getTime() - 1);
    const seal = fixture.store.sealAuditDigest({
      context: fixture.context,
      digestId: randomUUID(),
      from,
      to,
      auditEventId: randomUUID(),
    });

    await objects.firstPutStarted;
    fixture.audit.append({
      id: randomUUID(),
      tenantId: fixture.context.tenantId,
      workspaceId: fixture.context.workspaceId,
      actorKind: 'USER',
      actorId: fixture.context.actorUserId,
      action: 'AUDIT_DIGEST_CONCURRENT_RANGE_EVENT',
      resourceType: 'AUDIT_DIGEST_TEST',
      resourceId: randomUUID(),
      outcome: 'SUCCEEDED',
      metadata: {},
      occurredAt: new Date(fixture.now.getTime() - 30_000),
    });
    objects.releasePuts();

    await expect(seal).resolves.toEqual({ outcome: 'PIPELINE_UNAVAILABLE' });
    expect(objects.size).toBe(0);
    expect(
      fixture.audit
        .listTenant(fixture.context.tenantId)
        .filter(({ action }) => action === 'AUDIT_DIGEST_SEALED'),
    ).toHaveLength(0);
  });
});

async function createAuditDigestFixture(
  createObjects: (clock: { now(): Date }) => FakePrivacyObjectStorage = (clock) =>
    new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock }),
) {
  const now = new Date('2026-07-22T08:00:00.000Z');
  const clock = { now: () => new Date(now) };
  const tenancy = new InMemoryTenancyStore();
  const context = {
    tenantId: randomUUID(),
    workspaceId: randomUUID(),
    actorUserId: randomUUID(),
    membershipId: randomUUID(),
    role: 'OWNER' as const,
  };
  await tenancy.bootstrapTenant({
    actorSubject: 'audit-digest-owner',
    actorEmail: 'audit-digest-owner@example.test',
    tenantId: context.tenantId,
    tenantName: 'Audit digest tenant',
    workspaceId: context.workspaceId,
    workspaceName: 'Audit digest workspace',
    userId: context.actorUserId,
    membershipId: context.membershipId,
    roleBindingId: randomUUID(),
    auditEventId: randomUUID(),
  });
  const objects = createObjects(clock);
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
  return { now, context, tenancy, objects, audit, store };
}

class BlockingAuditObjectStorage extends FakePrivacyObjectStorage {
  public putCount = 0;
  public readonly firstPutStarted: Promise<void>;
  private resolveFirstPutStarted: (() => void) | undefined;
  private readonly putsReleased: Promise<void>;
  private resolvePuts: (() => void) | undefined;

  public constructor(options: ConstructorParameters<typeof FakePrivacyObjectStorage>[0]) {
    super(options);
    this.firstPutStarted = new Promise((resolve) => {
      this.resolveFirstPutStarted = resolve;
    });
    this.putsReleased = new Promise((resolve) => {
      this.resolvePuts = resolve;
    });
  }

  public override async stageLockedAuditVersion(
    input: Parameters<FakePrivacyObjectStorage['stageLockedAuditVersion']>[0],
  ): ReturnType<FakePrivacyObjectStorage['stageLockedAuditVersion']> {
    this.putCount += 1;
    this.resolveFirstPutStarted?.();
    await this.putsReleased;
    return super.stageLockedAuditVersion(input);
  }

  public releasePuts(): void {
    this.resolvePuts?.();
  }
}
