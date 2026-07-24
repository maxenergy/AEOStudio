import { describe, expect, test } from 'vitest';

import { InMemoryChannelAuthorizationStore } from '../../apps/api/src/channels/in-memory-channel-authorization-store.js';

const context = {
  tenantId: '00000000-0000-7000-8000-000000000001',
  workspaceId: '00000000-0000-7000-8000-000000000002',
  actorUserId: '00000000-0000-7000-8000-000000000003',
  membershipId: '00000000-0000-7000-8000-000000000004',
  role: 'OWNER' as const,
};

describe('Task 10 in-memory Channel authorization parity', () => {
  test('selects the newest authorization after a revoked target is rotated', async () => {
    const store = new InMemoryChannelAuthorizationStore();
    const base = {
      context,
      adapterVersionId: '00000000-0000-7000-8000-000000000010',
      target: 'fixture://rotated-target',
      grantedScopes: ['content:write'],
      acceptedTermsVersion: 'terms-v1',
      secretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:old',
      expiresAt: null,
      auditEventId: '00000000-0000-7000-8000-000000000020',
    };
    await store.create({
      ...base,
      authorizationId: '00000000-0000-7000-8000-000000000101',
      createdAt: new Date('2026-07-21T00:00:00.000Z'),
    });
    await store.revoke({
      context,
      authorizationId: '00000000-0000-7000-8000-000000000101',
      revokedAt: new Date('2026-07-21T00:01:00.000Z'),
      auditEventId: '00000000-0000-7000-8000-000000000021',
    });
    await store.create({
      ...base,
      authorizationId: '00000000-0000-7000-8000-000000000102',
      secretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:new',
      createdAt: new Date('2026-07-21T00:02:00.000Z'),
    });

    await expect(
      store.findForTarget({
        context,
        adapterVersionId: base.adapterVersionId,
        target: base.target,
      }),
    ).resolves.toMatchObject({
      id: '00000000-0000-7000-8000-000000000102',
      status: 'ACTIVE',
    });
  });
});
