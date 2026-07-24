import { describe, expect, test } from 'vitest';

import { InMemorySecretLifecycleStore } from './in-memory-secret-lifecycle-store.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000017';
const SECRET_REFERENCE = 'secret+memory://tenant-17/channel-credential';
const SECRET_VALUE = 'must-never-appear-in-metadata';
const NOW = new Date('2026-07-22T04:00:00.000Z');
const FORCE_DELETE_AT = new Date(NOW.getTime() + 24 * 60 * 60 * 1_000);

describe('InMemorySecretLifecycleStore', () => {
  test('revokes reads immediately and wipes the value exactly at force-delete time', async () => {
    let current = new Date(NOW);
    const store = new InMemorySecretLifecycleStore({ now: () => new Date(current) });
    const configured = await store.configure({
      tenantId: TENANT_ID,
      secretReference: SECRET_REFERENCE,
      value: SECRET_VALUE,
    });
    expect(JSON.stringify(configured)).not.toContain(SECRET_VALUE);
    await expect(store.getSecretValue(SECRET_REFERENCE)).resolves.toBe(SECRET_VALUE);

    const revoked = await store.revoke({
      tenantId: TENANT_ID,
      secretReference: SECRET_REFERENCE,
      revokedAt: NOW,
      forceDeleteAt: FORCE_DELETE_AT,
    });
    expect(revoked).toMatchObject({ state: 'REVOKED_PENDING_FORCE_DELETE', readable: false });
    expect(JSON.stringify(revoked)).not.toContain(SECRET_VALUE);
    await expect(store.getSecretValue(SECRET_REFERENCE)).rejects.toThrow(/revoked/iu);

    await expect(
      store.describe({
        tenantId: TENANT_ID,
        secretReference: SECRET_REFERENCE,
        at: new Date(FORCE_DELETE_AT.getTime() - 1),
      }),
    ).resolves.toMatchObject({ state: 'REVOKED_PENDING_FORCE_DELETE' });
    current = FORCE_DELETE_AT;
    await expect(
      store.describe({ tenantId: TENANT_ID, secretReference: SECRET_REFERENCE, at: current }),
    ).resolves.toMatchObject({ state: 'FORCE_DELETED', readable: false });
    await expect(store.getSecretValue(SECRET_REFERENCE)).rejects.toThrow(/deleted/iu);
  });
});
