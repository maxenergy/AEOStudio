import { randomUUID } from 'node:crypto';

import { InMemorySecretLifecycleStore } from '@aeostudio/adapters/secrets';
import { FakePrivacyObjectStorage } from '@aeostudio/adapters/storage';
import { describe, expect, test } from 'vitest';

import { InMemoryAuthStore } from '../../apps/api/src/auth/auth-store.memory.js';
import { InMemoryChannelAuthorizationStore } from '../../apps/api/src/channels/in-memory-channel-authorization-store.js';
import { InMemoryJobBudgetStore } from '../../apps/api/src/jobs/in-memory-job-budget-store.js';
import { InMemoryPrivacyAuditStore } from '../../apps/api/src/privacy/in-memory-privacy-audit-store.js';
import { resolveApiRuntime } from '../../apps/api/src/runtime/resolve-runtime.js';
import { InMemoryTenancyStore } from '../../apps/api/src/tenants/in-memory-tenancy-store.js';

describe('Task 17 fake lifecycle runtime', () => {
  test('fake deletion finalization advances only under a live claim-returned lease', async () => {
    let current = new Date('2026-07-22T05:00:00.000Z');
    const clock = { now: () => new Date(current) };
    const tenancy = new InMemoryTenancyStore();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const actorUserId = randomUUID();
    const membershipId = randomUUID();
    await tenancy.bootstrapTenant({
      actorSubject: 'task-17-finalizer-owner',
      actorEmail: 'task-17-finalizer-owner@example.test',
      tenantId,
      tenantName: 'Finalizer Tenant',
      workspaceId,
      workspaceName: 'Finalizer Workspace',
      userId: actorUserId,
      membershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    const context = {
      tenantId,
      workspaceId,
      actorUserId,
      membershipId,
      role: 'OWNER' as const,
    };
    const store = new InMemoryPrivacyAuditStore({
      auth: new InMemoryAuthStore(),
      tenancy,
      jobs: new InMemoryJobBudgetStore(),
      authorizations: new InMemoryChannelAuthorizationStore(),
      objects: new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock }),
      secrets: new InMemorySecretLifecycleStore(clock),
      clock,
    });
    const requestId = randomUUID();
    await expect(
      store.requestTenantDeletion({
        actorSubject: 'task-17-finalizer-owner',
        context,
        requestId,
        reason: 'Exercise leased finalization.',
        requestHash: '9'.repeat(64),
        requestedAt: current,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });

    current = new Date(current.getTime() + 30 * 24 * 60 * 60 * 1_000);
    const expiredLeaseToken = randomUUID();
    await expect(
      store.claimDueDeletionRequests({ leaseToken: expiredLeaseToken, limit: 10 }),
    ).resolves.toEqual([
      expect.objectContaining({ requestId, stage: 'ACTIVE', leaseToken: expiredLeaseToken }),
    ]);
    current = new Date(current.getTime() + 5 * 60 * 1_000 + 1);
    await expect(
      store.finalizeDeletion({
        requestId,
        leaseToken: expiredLeaseToken,
        effectiveAt: current,
        tombstoneId: randomUUID(),
        auditEventId: randomUUID(),
      }),
    ).resolves.toEqual({ outcome: 'INVALID_LEASE' });

    const activeLeaseToken = randomUUID();
    const [claim] = await store.claimDueDeletionRequests({
      leaseToken: activeLeaseToken,
      limit: 10,
    });
    expect(claim).toMatchObject({ requestId, stage: 'ACTIVE', leaseToken: activeLeaseToken });
    await expect(
      store.finalizeDeletion({
        requestId,
        leaseToken: randomUUID(),
        effectiveAt: current,
        tombstoneId: randomUUID(),
        auditEventId: randomUUID(),
      }),
    ).resolves.toEqual({ outcome: 'INVALID_LEASE' });
    await expect(
      store.finalizeDeletion({
        requestId,
        leaseToken: claim?.leaseToken ?? '',
        effectiveAt: current,
        tombstoneId: randomUUID(),
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      finalization: { requestId, state: 'ACTIVE_DATA_DELETED' },
    });

    const timeline = await store.listAuditEvents({
      context,
      from: new Date('2026-07-22T00:00:00.000Z'),
      to: new Date(current.getTime() + 1_000),
      cursor: null,
      limit: 100,
    });
    expect(timeline.outcome).toBe('SUCCEEDED');
    if (timeline.outcome !== 'SUCCEEDED') throw new Error('expected lifecycle audit timeline');
    expect(
      timeline.timeline.events.some(
        ({ actorKind, actorId, action, resourceId }) =>
          actorKind === 'SYSTEM' &&
          actorId === 'privacy-lifecycle-worker' &&
          action === 'DELETION_ACTIVE_DATA_COMPLETED' &&
          resourceId === requestId,
      ),
    ).toBe(true);
  });

  test('privacy governance keeps the named Owner available after freeze without reopening normal access', async () => {
    const tenancy = new InMemoryTenancyStore();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const actorUserId = randomUUID();
    const membershipId = randomUUID();
    await tenancy.bootstrapTenant({
      actorSubject: 'task-17-governance-owner',
      actorEmail: 'task-17-governance-owner@example.test',
      tenantId,
      tenantName: 'Governance Tenant',
      workspaceId,
      workspaceName: 'Governance Workspace',
      userId: actorUserId,
      membershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });

    tenancy.freezeTenant({ tenantId, frozenAt: new Date('2026-07-22T05:00:00.000Z') });

    const lookup = { actorSubject: 'task-17-governance-owner', tenantId, workspaceId };
    await expect(tenancy.resolveTenantContext(lookup)).resolves.toBeNull();
    await expect(tenancy.resolvePrivacyGovernanceContext(lookup)).resolves.toEqual({
      tenantId,
      workspaceId,
      actorUserId,
      membershipId,
      role: 'OWNER',
    });
    await expect(
      tenancy.resolvePrivacyGovernanceContext({
        ...lookup,
        actorSubject: 'task-17-unrelated-subject',
      }),
    ).resolves.toBeNull();
  });

  test('a lifecycle freeze wins over an in-flight processor completion', async () => {
    const jobs = new InMemoryJobBudgetStore();
    const context = {
      tenantId: randomUUID(),
      workspaceId: randomUUID(),
      actorUserId: randomUUID(),
      membershipId: randomUUID(),
      role: 'OWNER' as const,
    };
    await jobs.setBudget({
      context,
      policyId: randomUUID(),
      limitUnits: 100,
      auditEventId: randomUUID(),
    });
    const jobId = randomUUID();
    await jobs.submitJob({
      context,
      jobId,
      jobType: 'MEASUREMENT',
      aggregateId: randomUUID(),
      idempotencyKey: 'task-17-freeze-race',
      estimatedUnits: 1,
      reservationId: randomUUID(),
      budgetAlertId: randomUUID(),
      outboxMessageId: randomUUID(),
      auditEventId: randomUUID(),
    });

    let releaseProcessor: (() => void) | undefined;
    let markProcessorStarted: (() => void) | undefined;
    const processorStarted = new Promise<void>((resolve) => {
      markProcessorStarted = resolve;
    });
    const processorGate = new Promise<void>((resolve) => {
      releaseProcessor = resolve;
    });
    jobs.registerMeasurementProcessor(async () => {
      markProcessorStarted?.();
      await processorGate;
      return {
        status: 'SUCCEEDED',
        result: { unsafeCompletion: true },
        errorCode: null,
      };
    });

    await jobs.findJob({ context, jobId });
    await jobs.findJob({ context, jobId });
    const inFlightPoll = jobs.findJob({ context, jobId });
    await processorStarted;

    expect(jobs.freezeTenant(context.tenantId)).toBe(1);
    expect(jobs.peekJob({ context, jobId })).toMatchObject({
      status: 'CANCELLED',
      errorCode: 'TENANT_LIFECYCLE_FROZEN',
      result: null,
    });

    releaseProcessor?.();
    await expect(inFlightPoll).resolves.toMatchObject({
      status: 'CANCELLED',
      errorCode: 'TENANT_LIFECYCLE_FROZEN',
      result: null,
    });
    expect(jobs.peekJob({ context, jobId })).toMatchObject({
      status: 'CANCELLED',
      errorCode: 'TENANT_LIFECYCLE_FROZEN',
      result: null,
    });
  });

  test('a frozen Tenant rejects an export that holds a stale pre-freeze context', async () => {
    const now = new Date('2026-07-22T05:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const tenancy = new InMemoryTenancyStore();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const actorUserId = randomUUID();
    const membershipId = randomUUID();
    await tenancy.bootstrapTenant({
      actorSubject: 'task-17-owner',
      actorEmail: 'task-17-owner@example.test',
      tenantId,
      tenantName: 'Lifecycle Tenant',
      workspaceId,
      workspaceName: 'Lifecycle Workspace',
      userId: actorUserId,
      membershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    const context = {
      tenantId,
      workspaceId,
      actorUserId,
      membershipId,
      role: 'OWNER' as const,
    };
    const store = new InMemoryPrivacyAuditStore({
      auth: new InMemoryAuthStore(),
      tenancy,
      jobs: new InMemoryJobBudgetStore(),
      authorizations: new InMemoryChannelAuthorizationStore(),
      objects: new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock }),
      secrets: new InMemorySecretLifecycleStore(clock),
      clock,
    });

    tenancy.freezeTenant({ tenantId, frozenAt: now });

    await expect(
      store.loadTenantExportObjects({
        context,
        from: new Date(0),
        to: new Date('2027-01-01T00:00:00.000Z'),
      }),
    ).resolves.toEqual({ outcome: 'NOT_FOUND' });
  });

  test('a frozen Workspace rejects an export that holds a stale pre-freeze context', async () => {
    const now = new Date('2026-07-22T05:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const tenancy = new InMemoryTenancyStore();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const actorUserId = randomUUID();
    const membershipId = randomUUID();
    await tenancy.bootstrapTenant({
      actorSubject: 'task-17-workspace-owner',
      actorEmail: 'task-17-workspace-owner@example.test',
      tenantId,
      tenantName: 'Workspace Lifecycle Tenant',
      workspaceId,
      workspaceName: 'Workspace Lifecycle Workspace',
      userId: actorUserId,
      membershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    const context = {
      tenantId,
      workspaceId,
      actorUserId,
      membershipId,
      role: 'OWNER' as const,
    };
    const store = new InMemoryPrivacyAuditStore({
      auth: new InMemoryAuthStore(),
      tenancy,
      jobs: new InMemoryJobBudgetStore(),
      authorizations: new InMemoryChannelAuthorizationStore(),
      objects: new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock }),
      secrets: new InMemorySecretLifecycleStore(clock),
      clock,
    });

    tenancy.freezeWorkspace({ tenantId, workspaceId, frozenAt: now });

    await expect(
      store.loadTenantExportObjects({
        context,
        from: new Date(0),
        to: new Date('2027-01-01T00:00:00.000Z'),
      }),
    ).resolves.toEqual({ outcome: 'NOT_FOUND' });
  });

  test('channel publication and deletion share one secret lifecycle', async () => {
    let current = new Date('2026-07-22T05:00:00.000Z');
    const clock = { now: () => new Date(current) };
    const tenancy = new InMemoryTenancyStore();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const actorUserId = randomUUID();
    const membershipId = randomUUID();
    await tenancy.bootstrapTenant({
      actorSubject: 'task-17-secret-owner',
      actorEmail: 'task-17-secret-owner@example.test',
      tenantId,
      tenantName: 'Secret Lifecycle Tenant',
      workspaceId,
      workspaceName: 'Secret Lifecycle Workspace',
      userId: actorUserId,
      membershipId,
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    const context = {
      tenantId,
      workspaceId,
      actorUserId,
      membershipId,
      role: 'OWNER' as const,
    };
    const secrets = new InMemorySecretLifecycleStore(clock);
    const authorizations = new InMemoryChannelAuthorizationStore({
      secrets,
      secretValueForReference: () => 'deterministic-fake-publication-secret',
    });
    const secretReference = `arn:aws:secretsmanager:ap-southeast-1:000000000000:secret:${randomUUID()}`;
    await authorizations.create({
      context,
      authorizationId: randomUUID(),
      adapterVersionId: randomUUID(),
      target: 'https://publish.example.test',
      grantedScopes: ['content:write'],
      acceptedTermsVersion: 'task-17-v1',
      secretArn: secretReference,
      expiresAt: new Date(current.getTime() + 60 * 60 * 1_000),
      createdAt: current,
      auditEventId: randomUUID(),
    });
    await expect(secrets.getSecretValue(secretReference)).resolves.toBe(
      'deterministic-fake-publication-secret',
    );

    const privacy = new InMemoryPrivacyAuditStore({
      auth: new InMemoryAuthStore(),
      tenancy,
      jobs: new InMemoryJobBudgetStore(),
      authorizations,
      objects: new FakePrivacyObjectStorage({ ids: { next: randomUUID }, clock }),
      secrets,
      clock,
    });
    const requestId = randomUUID();
    await expect(
      privacy.requestTenantDeletion({
        actorSubject: 'task-17-secret-owner',
        context,
        requestId,
        reason: 'Delete the Tenant and revoke its connector secret.',
        requestHash: 'a'.repeat(64),
        requestedAt: current,
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
    await expect(secrets.getSecretValue(secretReference)).rejects.toThrow('SECRET_REVOKED');
    expect(authorizations.revokeTenant(tenantId, current)).toEqual([]);

    current = new Date(current.getTime() + 24 * 60 * 60 * 1_000);
    const leaseToken = randomUUID();
    const [secretWork] = await privacy.claimDueSecretDeletions({ leaseToken, limit: 10 });
    expect(secretWork).toMatchObject({
      tenantId,
      deletionRequestId: requestId,
      secretReference,
      leaseToken,
    });
    await secrets.forceDeleteDue({ tenantId, at: current });
    await expect(
      privacy.markSecretDeletionRequested({
        tenantId,
        channelAuthorizationId: secretWork?.channelAuthorizationId ?? '',
        leaseToken: secretWork?.leaseToken ?? '',
      }),
    ).resolves.toBe(true);
    await expect(
      privacy.markSecretUnreadable({
        tenantId,
        channelAuthorizationId: secretWork?.channelAuthorizationId ?? '',
        leaseToken: secretWork?.leaseToken ?? '',
      }),
    ).resolves.toBe(true);
    await expect(
      secrets.describe({ tenantId, secretReference, at: current }),
    ).resolves.toMatchObject({ state: 'FORCE_DELETED', readable: false });
  });

  test('the fake break-glass store binds every access decision to the exact trusted scope', async () => {
    const now = new Date('2026-07-22T05:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const tenancy = new InMemoryTenancyStore();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const operatorId = randomUUID();
    const grantId = randomUUID();
    await tenancy.bootstrapTenant({
      actorSubject: 'task-17-break-glass-owner',
      actorEmail: 'task-17-break-glass-owner@example.test',
      tenantId,
      tenantName: 'Break-glass Tenant',
      workspaceId,
      workspaceName: 'Break-glass Workspace',
      userId: randomUUID(),
      membershipId: randomUUID(),
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

    await expect(
      store.grantBreakGlass({
        tenantId,
        workspaceId,
        grantId,
        operatorId,
        operatorName: 'Trusted fake platform operator',
        reason: 'Investigate incident INC-1701.',
        expiresAt: new Date(now.getTime() + 15 * 60 * 1_000),
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: 'object-version-17',
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      grant: { tenantId, workspaceId, requestedAction: 'READ_SENSITIVE_EVIDENCE' },
    });

    const allowedAuditEventId = randomUUID();
    await expect(
      store.evaluateBreakGlassAccess({
        actorSubject: 'trusted-platform-subject',
        tenantId,
        workspaceId,
        grantId,
        operatorId,
        operatorName: 'Trusted fake platform operator',
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: 'object-version-17',
        auditEventId: allowedAuditEventId,
      }),
    ).resolves.toMatchObject({
      decision: 'ALLOW',
      state: 'ACTIVE',
      auditEventId: allowedAuditEventId,
    });

    const deniedAuditEventId = randomUUID();
    await expect(
      store.evaluateBreakGlassAccess({
        actorSubject: 'trusted-platform-subject',
        tenantId,
        workspaceId,
        grantId,
        operatorId,
        operatorName: 'Trusted fake platform operator',
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: 'different-object-version',
        auditEventId: deniedAuditEventId,
      }),
    ).resolves.toMatchObject({
      decision: 'DENY',
      state: 'INVALID_GRANT',
      auditEventId: deniedAuditEventId,
    });

    const supportAuditEventId = randomUUID();
    await expect(
      store.evaluateBreakGlassAccess({
        actorSubject: 'named-support-subject',
        tenantId,
        workspaceId,
        grantId,
        operatorId: null,
        operatorName: null,
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: 'object-version-17',
        auditEventId: supportAuditEventId,
      }),
    ).resolves.toMatchObject({ decision: 'DENY', state: 'INVALID_GRANT' });
    const supportTimeline = await store.listAuditEvents({
      context: {
        tenantId,
        workspaceId,
        actorUserId: randomUUID(),
        membershipId: randomUUID(),
        role: 'OWNER',
      },
      from: new Date(now.getTime() - 1_000),
      to: new Date(now.getTime() + 1_000),
      cursor: null,
      limit: 100,
    });
    expect(supportTimeline.outcome).toBe('SUCCEEDED');
    if (supportTimeline.outcome !== 'SUCCEEDED') throw new Error('expected support audit');
    expect(
      supportTimeline.timeline.events.find(({ id }) => id === supportAuditEventId),
    ).toMatchObject({
      actorKind: 'SUPPORT',
      actorId: 'named-support-subject',
      resourceType: 'BREAK_GLASS_GRANT',
      resourceId: grantId,
      outcome: 'DENIED',
      metadata: {
        workspaceId,
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: 'object-version-17',
        state: 'INVALID_GRANT',
      },
    });

    tenancy.freezeWorkspace({ tenantId, workspaceId, frozenAt: now });
    await expect(
      store.evaluateBreakGlassAccess({
        actorSubject: 'trusted-platform-subject',
        tenantId,
        workspaceId,
        grantId,
        operatorId,
        operatorName: 'Trusted fake platform operator',
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: 'object-version-17',
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ decision: 'DENY', state: 'INVALID_GRANT' });
    await expect(
      store.grantBreakGlass({
        tenantId,
        workspaceId,
        grantId: randomUUID(),
        operatorId,
        operatorName: 'Trusted fake platform operator',
        reason: 'A frozen scope must reject new emergency access.',
        expiresAt: new Date(now.getTime() + 15 * 60 * 1_000),
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: 'object-version-17',
        auditEventId: randomUUID(),
      }),
    ).resolves.toEqual({ outcome: 'NOT_FOUND' });

    const firstRevoke = await store.revokeBreakGlass({
      tenantId,
      workspaceId,
      grantId,
      operatorId,
      operatorName: 'Trusted fake platform operator',
      auditEventId: randomUUID(),
    });
    await expect(
      store.revokeBreakGlass({
        tenantId,
        workspaceId,
        grantId,
        operatorId,
        operatorName: 'Trusted fake platform operator',
        auditEventId: randomUUID(),
      }),
    ).resolves.toEqual(firstRevoke);
    const replayTimeline = await store.listAuditEvents({
      context: {
        tenantId,
        workspaceId,
        actorUserId: randomUUID(),
        membershipId: randomUUID(),
        role: 'OWNER',
      },
      from: new Date(now.getTime() - 1_000),
      to: new Date(now.getTime() + 1_000),
      cursor: null,
      limit: 100,
    });
    if (replayTimeline.outcome !== 'SUCCEEDED') throw new Error('expected revoke audit');
    expect(
      replayTimeline.timeline.events.filter(({ action }) => action === 'BREAK_GLASS_REVOKED'),
    ).toHaveLength(1);
  });

  test('the fake API runtime composes authorization and privacy with the supplied secret lifecycle', async () => {
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      allowFake: process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME,
      authMode: process.env.AEOSTUDIO_AUTH_MODE,
      channelMode: process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE,
    };
    process.env.NODE_ENV = 'test';
    process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME = 'true';
    process.env.AEOSTUDIO_AUTH_MODE = 'fake';
    process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE = 'fake';
    const now = new Date('2026-07-22T05:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const secrets = new InMemorySecretLifecycleStore(clock);
    let runtime: Awaited<ReturnType<typeof resolveApiRuntime>> | undefined;
    try {
      runtime = await resolveApiRuntime({
        clock,
        fakeSecretLifecycleStore: secrets,
      });
      const tenancy = runtime.options.tenancyStore;
      const authorizations = runtime.options.channelAuthorizationStore;
      expect(tenancy).toBeInstanceOf(InMemoryTenancyStore);
      expect(authorizations).toBeInstanceOf(InMemoryChannelAuthorizationStore);
      if (
        !(tenancy instanceof InMemoryTenancyStore) ||
        !(authorizations instanceof InMemoryChannelAuthorizationStore)
      ) {
        throw new Error('EXPECTED_FAKE_PRIVACY_RUNTIME');
      }
      const tenantId = randomUUID();
      const workspaceId = randomUUID();
      const actorUserId = randomUUID();
      const membershipId = randomUUID();
      await tenancy.bootstrapTenant({
        actorSubject: 'task-17-runtime-owner',
        actorEmail: 'task-17-runtime-owner@example.test',
        tenantId,
        tenantName: 'Runtime Secret Tenant',
        workspaceId,
        workspaceName: 'Runtime Secret Workspace',
        userId: actorUserId,
        membershipId,
        roleBindingId: randomUUID(),
        auditEventId: randomUUID(),
      });
      const secretReference = `arn:aws:secretsmanager:test:000000000000:secret:${randomUUID()}`;
      await authorizations.create({
        context: {
          tenantId,
          workspaceId,
          actorUserId,
          membershipId,
          role: 'OWNER',
        },
        authorizationId: randomUUID(),
        adapterVersionId: randomUUID(),
        target: 'https://runtime-publish.example.test',
        grantedScopes: ['content:write'],
        acceptedTermsVersion: 'task-17-runtime-v1',
        secretArn: secretReference,
        expiresAt: null,
        createdAt: now,
        auditEventId: randomUUID(),
      });

      await expect(secrets.getSecretValue(secretReference)).resolves.toBe(
        'fake-publication-secret',
      );
    } finally {
      await runtime?.cleanup();
      restoreEnvironment('NODE_ENV', previous.nodeEnv);
      restoreEnvironment('AEOSTUDIO_ALLOW_FAKE_RUNTIME', previous.allowFake);
      restoreEnvironment('AEOSTUDIO_AUTH_MODE', previous.authMode);
      restoreEnvironment('AEOSTUDIO_CHANNEL_ADAPTER_MODE', previous.channelMode);
    }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
