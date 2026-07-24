import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { FakePrivacyObjectStorage } from './fake-privacy-object-storage.js';

const TENANT_ID = '00000000-0000-7000-8000-000000000017';
const NOW = new Date('2026-07-22T04:00:00.000Z');

describe('FakePrivacyObjectStorage', () => {
  test('versions exports and applies legal hold only to the exact version', async () => {
    const storage = new FakePrivacyObjectStorage({
      ids: sequenceIds('version-1', 'version-2'),
      clock: { now: () => new Date(NOW) },
    });
    const objectKey = `tenants/${TENANT_ID}/exports/manifest.json`;
    const first = await storage.putExportVersion({
      tenantId: TENANT_ID,
      objectKey,
      body: bytes('first'),
      contentType: 'application/json',
      checksum: sha256(bytes('first')),
    });
    const sibling = await storage.putExportVersion({
      tenantId: TENANT_ID,
      objectKey,
      body: bytes('second'),
      contentType: 'application/json',
      checksum: sha256(bytes('second')),
    });

    await expect(
      storage.holdExportVersion({
        tenantId: TENANT_ID,
        objectKey,
        objectVersionId: first.objectVersionId,
        holdId: 'hold-1',
      }),
    ).resolves.toBe(true);
    await expect(
      storage.deleteExportVersion({
        tenantId: TENANT_ID,
        objectKey,
        objectVersionId: first.objectVersionId,
        at: NOW,
      }),
    ).resolves.toMatchObject({ outcome: 'LEGAL_HOLD' });
    await expect(
      storage.deleteExportVersion({
        tenantId: TENANT_ID,
        objectKey,
        objectVersionId: sibling.objectVersionId,
        at: NOW,
      }),
    ).resolves.toMatchObject({ outcome: 'DELETED' });
    expect(first.objectRef).toMatch(
      new RegExp(`^s3\\+memory://tenant-exports/tenants/${TENANT_ID}/`, 'u'),
    );
  });

  test('keeps audit evidence locked before, but not at, the exact expiry', async () => {
    const lockedUntil = new Date(NOW.getTime() + 60_000);
    const storage = new FakePrivacyObjectStorage({
      ids: sequenceIds('audit-version-1'),
      clock: { now: () => new Date(NOW) },
    });
    const objectKey = `tenants/${TENANT_ID}/digests/2026-07-22.json`;
    const stored = await storage.putLockedAuditVersion({
      tenantId: TENANT_ID,
      objectKey,
      body: bytes('digest'),
      contentType: 'application/json',
      checksum: sha256(bytes('digest')),
      lockedUntil,
    });

    await expect(
      storage.deleteAuditVersion({
        tenantId: TENANT_ID,
        objectKey,
        objectVersionId: stored.objectVersionId,
        at: new Date(lockedUntil.getTime() - 1),
      }),
    ).resolves.toMatchObject({ outcome: 'OBJECT_LOCKED' });
    await expect(
      storage.deleteAuditVersion({
        tenantId: TENANT_ID,
        objectKey,
        objectVersionId: stored.objectVersionId,
        at: lockedUntil,
      }),
    ).resolves.toMatchObject({ outcome: 'DELETED' });
    expect(stored.objectRef).toMatch(
      new RegExp(`^s3\\+memory://audit-evidence/tenants/${TENANT_ID}/`, 'u'),
    );
  });

  test('keeps a staged locked version invisible until commit and can abort it before publication', async () => {
    const storage = new FakePrivacyObjectStorage({
      ids: sequenceIds('aborted-version', 'committed-version'),
      clock: { now: () => new Date(NOW) },
    });
    const lockedUntil = new Date(NOW.getTime() + 60_000);
    const objectKey = `tenants/${TENANT_ID}/digests/staged.json`;
    const input = {
      tenantId: TENANT_ID,
      objectKey,
      body: bytes('staged digest'),
      contentType: 'application/json',
      checksum: sha256(bytes('staged digest')),
      lockedUntil,
    };

    const aborted = await storage.stageLockedAuditVersion(input);
    expect(storage.size).toBe(0);
    await expect(
      storage.readAuditVersion({
        tenantId: TENANT_ID,
        objectKey,
        objectVersionId: aborted.object.objectVersionId,
      }),
    ).resolves.toBeNull();
    aborted.abort();
    expect(() => aborted.commit()).toThrow('PRIVACY_OBJECT_STAGE_ABORTED');

    const committed = await storage.stageLockedAuditVersion(input);
    const object = committed.commit();
    expect(storage.size).toBe(1);
    await expect(
      storage.readAuditVersion({
        tenantId: TENANT_ID,
        objectKey,
        objectVersionId: object.objectVersionId,
      }),
    ).resolves.not.toBeNull();
    expect(() => committed.abort()).toThrow('PRIVACY_OBJECT_STAGE_COMMITTED');
    await expect(
      storage.deleteAuditVersion({
        tenantId: TENANT_ID,
        objectKey,
        objectVersionId: object.objectVersionId,
        at: NOW,
      }),
    ).resolves.toEqual({ outcome: 'OBJECT_LOCKED' });
  });
});

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sequenceIds(...values: string[]): { next(): string } {
  let offset = 0;
  return {
    next() {
      const value = values[offset++];
      if (value === undefined) throw new Error('TEST_ID_SEQUENCE_EXHAUSTED');
      return value;
    },
  };
}
