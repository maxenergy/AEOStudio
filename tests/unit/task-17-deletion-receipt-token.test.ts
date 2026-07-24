import { FakeOidcClient } from '@aeostudio/adapters';
import { describe, expect, test } from 'vitest';

import { HmacDeletionReceiptTokenService } from '../../apps/api/src/privacy/deletion-receipt-token.js';
import { resolveApiRuntime } from '../../apps/api/src/runtime/resolve-runtime.js';

const receipt = {
  id: '019b7653-cfb0-7000-8000-000000000001',
  scope: 'TENANT' as const,
  state: 'FROZEN' as const,
  requestedAt: '2026-07-22T05:00:00.000Z',
  secretForceDeleteBy: '2026-07-23T05:00:00.000Z',
  activeDeleteBy: '2026-08-21T05:00:00.000Z',
  backupDeleteBy: '2026-10-20T05:00:00.000Z',
};

describe('Task 17 deletion receipt capability', () => {
  test('accepts an issued receipt and rejects payload or signature tampering', () => {
    const service = new HmacDeletionReceiptTokenService({
      signingKey: Buffer.from('task-17-test-signing-key-material!'),
      clock: { now: () => new Date('2026-07-22T05:01:00.000Z') },
    });
    const token = service.issue(receipt);

    expect(service.verify(token)).toEqual(receipt);

    const [payload, signature] = token.split('.');
    if (payload === undefined || signature === undefined) throw new Error('EXPECTED_SIGNED_TOKEN');
    const changedSignature = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
    expect(service.verify(`${payload}.${changedSignature}`)).toBeNull();
    expect(service.verify(`${payload}x.${signature}`)).toBeNull();
  });

  test('rejects a validly signed receipt after the short display window', () => {
    let current = new Date('2026-07-22T05:01:00.000Z');
    const service = new HmacDeletionReceiptTokenService({
      signingKey: Buffer.from('task-17-test-signing-key-material!'),
      clock: { now: () => new Date(current) },
      ttlMs: 5 * 60 * 1_000,
    });
    const token = service.issue(receipt);

    current = new Date('2026-07-22T05:06:01.000Z');
    expect(service.verify(token)).toBeNull();
  });

  test('fails production runtime startup when the receipt signing key is missing', async () => {
    const names = [
      'NODE_ENV',
      'DATABASE_URL',
      'API_DATABASE_POOL_MAX',
      'SESSION_ENCRYPTION_KEY',
      'DELETION_RECEIPT_SIGNING_KEY',
      'AEOSTUDIO_AUTH_MODE',
      'AEOSTUDIO_CHANNEL_ADAPTER_MODE',
      'AEOSTUDIO_GIT_PROVIDER_MODE',
      'AEOSTUDIO_MEASUREMENT_PROVIDER_MODE',
      'AEOSTUDIO_SHOPIFY_PROVIDER_MODE',
      'AEOSTUDIO_WEBHOOK_PROVIDER_MODE',
      'AEOSTUDIO_WORDPRESS_PROVIDER_MODE',
    ] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    try {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/runtime-wiring-only';
      process.env.API_DATABASE_POOL_MAX = '10';
      process.env.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 15).toString('base64url');
      delete process.env.DELETION_RECEIPT_SIGNING_KEY;
      for (const name of names.filter((name) => name.startsWith('AEOSTUDIO_'))) {
        delete process.env[name];
      }

      await expect(
        resolveApiRuntime({
          oidcClient: new FakeOidcClient('http://127.0.0.1/unused-fake-oidc'),
        }),
      ).rejects.toThrow('DELETION_RECEIPT_SIGNING_KEY');
    } finally {
      for (const name of names) restoreEnvironment(name, previous.get(name));
    }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
