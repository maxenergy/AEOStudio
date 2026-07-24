import type { ChannelPackageStore } from '@aeostudio/application/channels-publishing';
import { describe, expect, test } from 'vitest';

import { InMemoryChannelPackageStore } from '../../apps/api/src/channels/in-memory-channel-package-store.js';

describe('Channel Package commit-time currentness', () => {
  test('the in-memory store rejects a stale replay before returning an existing package', async () => {
    let current = true;
    const store = new InMemoryChannelPackageStore(() => current);
    const input: Parameters<ChannelPackageStore['createOrFind']>[0] = {
      context: {
        tenantId: '00000000-0000-7000-8000-000000000101',
        workspaceId: '00000000-0000-7000-8000-000000000102',
        actorUserId: '00000000-0000-7000-8000-000000000103',
        membershipId: '00000000-0000-7000-8000-000000000104',
        role: 'OWNER',
      },
      packageId: '00000000-0000-7000-8000-000000000201',
      channel: {
        definitionId: '00000000-0000-7000-8000-000000000202',
        channelKey: 'portable-web-export',
      },
      transformer: { key: 'generic-web-package', version: '1.0.0' },
      packageSchemaVersion: '1.0.0',
      artifact: {
        artifactId: '00000000-0000-7000-8000-000000000203',
        artifactRevisionId: '00000000-0000-7000-8000-000000000204',
        revision: 1,
        contentHash: 'a'.repeat(64),
        type: 'DEFINITION_PRODUCT',
        locale: 'en-SG',
        market: 'SG',
        methodPolicyVersion: 'artifact-fixture-v1',
      },
      manifest: {
        schemaVersion: '1.0.0',
        files: [],
        assetRefs: [],
        claimSourceMap: [],
      },
      packageChecksum: 'b'.repeat(64),
      payloadObjectRef: 'memory://channel-packages/currentness.json',
      createdAt: new Date('2026-07-24T06:00:00.000Z'),
      auditEventId: '00000000-0000-7000-8000-000000000205',
    };

    await expect(store.createOrFind(input)).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      created: true,
    });

    current = false;
    await expect(
      store.createOrFind({
        ...input,
        packageId: '00000000-0000-7000-8000-000000000206',
        auditEventId: '00000000-0000-7000-8000-000000000207',
      }),
    ).resolves.toEqual({ outcome: 'APPROVAL_STALE' });
  });
});
