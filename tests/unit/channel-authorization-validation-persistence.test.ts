import type {
  ChannelAuthorizationValidationCommandStore,
  ChannelAuthorizationValidationLease,
} from '@aeostudio/application/channels-publishing';
import { describe, expect, test } from 'vitest';

import { InMemoryChannelAuthorizationStore } from '../../apps/api/src/channels/in-memory-channel-authorization-store.js';

const tenantA = '00000000-0000-7000-8000-00000000b001';
const tenantB = '00000000-0000-7000-8000-00000000b002';
const workspaceA = '00000000-0000-7000-8000-00000000b003';
const workspaceB = '00000000-0000-7000-8000-00000000b004';
const adapterVersionId = '00000000-0000-7000-8000-00000000b005';
const now = new Date('2026-07-24T04:00:00.000Z');

describe('durable Channel authorization validation state', () => {
  test('create persists PENDING_VALIDATION and a worker-only command instead of trusting input', async () => {
    const store = new InMemoryChannelAuthorizationStore();
    await createPending(
      store,
      context(tenantA, workspaceA),
      '00000000-0000-7000-8000-00000000b101',
    );

    await expect(store.list({ context: context(tenantA, workspaceA) })).resolves.toMatchObject([
      {
        validationStatus: 'PENDING_VALIDATION',
        validationSnapshot: null,
        validationFailureCode: null,
      },
    ]);
    const worker = store as ChannelAuthorizationValidationCommandStore;
    await expect(
      worker.claimNext({
        workerId: 'authorization-validator-1',
        leaseToken: 'lease-token-a',
        now,
        leaseUntil: new Date('2026-07-24T04:01:00.000Z'),
      }),
    ).resolves.toMatchObject({
      tenantId: tenantA,
      workspaceId: workspaceA,
      authorizationId: '00000000-0000-7000-8000-00000000b101',
      target: 'fixture://provider-validation/site',
      requestedScopes: ['content:write'],
      acceptedTermsVersion: 'provider-terms-v1',
      secretReference:
        'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:provider-validation-a',
    });
  });

  test('a leased completion is tenant/workspace bound and cannot validate a different scope', async () => {
    const store = new InMemoryChannelAuthorizationStore();
    await createPending(
      store,
      context(tenantA, workspaceA),
      '00000000-0000-7000-8000-00000000b201',
    );
    await createPending(
      store,
      context(tenantB, workspaceB),
      '00000000-0000-7000-8000-00000000b202',
    );
    const worker = store as ChannelAuthorizationValidationCommandStore;
    const lease = await worker.claimNext({
      workerId: 'authorization-validator-1',
      leaseToken: 'lease-token-a',
      now,
      leaseUntil: new Date('2026-07-24T04:01:00.000Z'),
    });
    expect(lease).not.toBeNull();
    if (lease === null) return;

    await expect(
      worker.completeVerified({
        lease: {
          ...lease,
          tenantId: tenantB,
          workspaceId: workspaceB,
        } satisfies ChannelAuthorizationValidationLease,
        actualTarget: lease.target,
        actualScopes: lease.requestedScopes,
        acceptedTermsVersion: lease.acceptedTermsVersion,
        credentialFingerprint: 'a'.repeat(64),
        validatedAt: now,
        validUntil: new Date('2026-07-24T05:00:00.000Z'),
      }),
    ).resolves.toBe(false);

    await expect(store.list({ context: context(tenantA, workspaceA) })).resolves.toMatchObject([
      { validationStatus: 'PENDING_VALIDATION' },
    ]);
    await expect(store.list({ context: context(tenantB, workspaceB) })).resolves.toMatchObject([
      { validationStatus: 'PENDING_VALIDATION' },
    ]);

    await expect(
      worker.completeVerified({
        lease,
        actualTarget: lease.target,
        actualScopes: lease.requestedScopes,
        acceptedTermsVersion: lease.acceptedTermsVersion,
        credentialFingerprint: 'a'.repeat(64),
        validatedAt: now,
        validUntil: new Date('2026-07-24T05:00:00.000Z'),
      }),
    ).resolves.toBe(true);

    await expect(store.list({ context: context(tenantA, workspaceA) })).resolves.toMatchObject([
      {
        validationStatus: 'VERIFIED',
        validationSnapshot: {
          actualTarget: 'fixture://provider-validation/site',
          actualScopes: ['content:write'],
          acceptedTermsVersion: 'provider-terms-v1',
          validatedAt: now.toISOString(),
          validUntil: '2026-07-24T05:00:00.000Z',
        },
      },
    ]);
    const publicMetadata = await store.list({ context: context(tenantA, workspaceA) });
    expect(JSON.stringify(publicMetadata)).not.toContain('credentialFingerprint');
    expect(JSON.stringify(publicMetadata)).not.toContain('a'.repeat(64));
    const eligibility = await store.findForTarget({
      context: context(tenantA, workspaceA),
      adapterVersionId,
      target: 'fixture://provider-validation/site',
    });
    expect(eligibility).toMatchObject({
      validationSnapshot: {
        actualTarget: 'fixture://provider-validation/site',
        actualScopes: ['content:write'],
      },
    });
    expect(JSON.stringify(eligibility)).not.toContain('credentialFingerprint');
    expect(JSON.stringify(eligibility)).not.toContain('a'.repeat(64));
    await expect(store.list({ context: context(tenantB, workspaceB) })).resolves.toMatchObject([
      { validationStatus: 'PENDING_VALIDATION', validationSnapshot: null },
    ]);
  });

  test('expired and reclaimed leases reject stale completion by command, worker and token CAS', async () => {
    const store = new InMemoryChannelAuthorizationStore();
    await createPending(
      store,
      context(tenantA, workspaceA),
      '00000000-0000-7000-8000-00000000b401',
    );
    const worker = store as ChannelAuthorizationValidationCommandStore;
    const staleLease = await worker.claimNext({
      workerId: 'authorization-validator-stale',
      leaseToken: 'lease-token-stale',
      now,
      leaseUntil: new Date('2026-07-24T04:01:00.000Z'),
    });
    expect(staleLease).not.toBeNull();
    if (staleLease === null) return;

    await expect(
      worker.completeVerified({
        lease: staleLease,
        actualTarget: staleLease.target,
        actualScopes: staleLease.requestedScopes,
        acceptedTermsVersion: staleLease.acceptedTermsVersion,
        credentialFingerprint: 'c'.repeat(64),
        validatedAt: new Date('2026-07-24T04:01:00.000Z'),
        validUntil: new Date('2026-07-24T05:01:00.000Z'),
      }),
    ).resolves.toBe(false);

    const currentLease = await worker.claimNext({
      workerId: 'authorization-validator-current',
      leaseToken: 'lease-token-current',
      now: new Date('2026-07-24T04:01:00.000Z'),
      leaseUntil: new Date('2026-07-24T04:02:00.000Z'),
    });
    expect(currentLease).not.toBeNull();
    if (currentLease === null) return;

    await expect(
      worker.completeInvalid({
        lease: staleLease,
        failureCode: 'STALE_WORKER_MUST_NOT_COMMIT',
        validatedAt: new Date('2026-07-24T04:01:01.000Z'),
      }),
    ).resolves.toBe(false);
    await expect(
      worker.completeVerified({
        lease: currentLease,
        actualTarget: currentLease.target,
        actualScopes: currentLease.requestedScopes,
        acceptedTermsVersion: currentLease.acceptedTermsVersion,
        credentialFingerprint: 'd'.repeat(64),
        validatedAt: new Date('2026-07-24T04:01:01.000Z'),
        validUntil: new Date('2026-07-24T05:01:01.000Z'),
      }),
    ).resolves.toBe(true);
  });
});

async function createPending(
  store: InMemoryChannelAuthorizationStore,
  tenantContext: ReturnType<typeof context>,
  authorizationId: string,
) {
  return store.create({
    context: tenantContext,
    authorizationId,
    adapterVersionId,
    adapterKey: 'git-pull-request',
    adapterVersion: '1.0.0',
    channelDefinitionId: '00000000-0000-7000-8000-00000000b006',
    target: 'fixture://provider-validation/site',
    grantedScopes: ['content:write'],
    acceptedTermsVersion: 'provider-terms-v1',
    secretArn:
      tenantContext.tenantId === tenantA
        ? 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:provider-validation-a'
        : 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:provider-validation-b',
    expiresAt: new Date('2026-07-25T04:00:00.000Z'),
    createdAt: new Date(
      tenantContext.tenantId === tenantA ? '2026-07-24T03:58:00.000Z' : '2026-07-24T03:59:00.000Z',
    ),
    auditEventId:
      tenantContext.tenantId === tenantA
        ? '00000000-0000-7000-8000-00000000b301'
        : '00000000-0000-7000-8000-00000000b302',
  });
}

function context(tenantId: string, workspaceId: string) {
  return {
    tenantId,
    workspaceId,
    actorUserId:
      tenantId === tenantA
        ? '00000000-0000-7000-8000-00000000b007'
        : '00000000-0000-7000-8000-00000000b008',
    membershipId:
      tenantId === tenantA
        ? '00000000-0000-7000-8000-00000000b009'
        : '00000000-0000-7000-8000-00000000b010',
    role: 'OWNER' as const,
  };
}
