import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { InMemoryProfileOfferingStore } from '../../apps/api/src/profile-offering/in-memory-profile-offering-store.js';

describe('Task 17 fake Tenant export sources', () => {
  test('projects every tenant-owned Profile and Offering revision without crossing tenants', async () => {
    const occurredAt = new Date('2026-07-22T06:00:00.000Z');
    const store = new InMemoryProfileOfferingStore({ now: () => new Date(occurredAt) });
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const context = {
      tenantId,
      workspaceId,
      actorUserId: randomUUID(),
      membershipId: randomUUID(),
      role: 'OWNER' as const,
    };
    const profileId = randomUUID();
    await store.createProfile({
      context,
      profileId,
      revisionId: randomUUID(),
      contentHash: 'a'.repeat(64),
      content: {
        displayName: 'Tenant-defined export brand',
        description: 'Arbitrary business information, without a hard-coded industry.',
        digitalAssets: [{ label: 'Website', url: 'https://export.example.test' }],
        targetMarkets: [{ locale: 'zh-CN', market: 'TW' }],
      },
      completeness: { completedFields: 4, totalFields: 4, percent: 100, missingFields: [] },
      auditEventId: randomUUID(),
    });
    await store.createOffering({
      context,
      profileId,
      offeringId: randomUUID(),
      revisionId: randomUUID(),
      contentHash: 'b'.repeat(64),
      content: {
        kind: 'tenant-defined-service',
        name: 'Tenant-defined Offering',
        locale: 'zh-CN',
        market: 'TW',
        taxonomy: ['tenant-defined'],
        principle: 'An arbitrary operating principle.',
        specifications: [],
        features: ['Feature A'],
        usage: ['Step A'],
        applicationScenarios: ['Scenario A'],
        compatibility: ['Browser'],
        evidenceHints: ['Evidence A'],
        attributes: [],
      },
      completeness: { completedFields: 10, totalFields: 12, percent: 83, missingFields: [] },
      attributes: [],
      auditEventId: randomUUID(),
    });

    await expect(
      store.listTenantExportObjects({
        tenantId,
        from: new Date('2026-07-22T05:59:59.000Z'),
        to: new Date('2026-07-22T06:00:01.000Z'),
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenantId, workspaceId, kind: 'PROFILE_REVISION' }),
        expect.objectContaining({ tenantId, workspaceId, kind: 'OFFERING_REVISION' }),
      ]),
    );
    await expect(
      store.listTenantExportObjects({
        tenantId: randomUUID(),
        from: new Date(0),
        to: new Date('2027-01-01T00:00:00.000Z'),
      }),
    ).resolves.toEqual([]);
  });
});
