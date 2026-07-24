import { createProductionPublicationAdapterRegistry } from '@aeostudio/adapters/publication';
import type { PublicationAdapterCommand } from '@aeostudio/application/channels-publishing';
import { encodeSignedWebhookTarget } from '@aeostudio/contracts/channels';
import { describe, expect, test, vi } from 'vitest';

describe('production signed-webhook pending dual-URL effect boundary', () => {
  test('does not publish or reconcile after delivery proof passes but receipt proof fails', async () => {
    const endpointVerificationId = '00000000-0000-7000-8000-000000009201';
    const endpointUrl = 'https://hooks.shared-saas.test/customer-a/delivery';
    const receiptUrl = 'https://hooks.shared-saas.test/customer-b/receipt';
    const findVerifiedEndpoint = vi.fn(() => Promise.resolve(null));
    const resolve = vi.fn(() => Promise.resolve(['93.184.216.34']));
    const post = vi.fn();
    const adapter = createProductionPublicationAdapterRegistry({
      signedWebhookEndpointVerifications: { findVerifiedEndpoint },
      signedWebhook: {
        resolver: { resolve },
        transport: { post },
        clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
        nextNonce: () => 'pending-dual-url-must-never-sign',
      },
    }).resolve('signed-webhook', '1.0.0');
    if (adapter === null) throw new Error('SIGNED_WEBHOOK_ADAPTER_REQUIRED');

    // The endpoint-verification store exposes only VERIFIED tuples. A delivery proof followed by a
    // failed exact receipt proof therefore remains PENDING and resolves to null at this boundary.
    const command = {
      target: encodeSignedWebhookTarget({
        schemaVersion: 'signed-webhook-target.v1',
        endpointUrl,
        receiptUrl,
        endpointVerificationId,
        algorithm: 'HMAC_SHA256',
        keyId: 'shared-saas-hmac-2026-07',
      }),
      channelPackage: {
        tenantId: '00000000-0000-7000-8000-000000009202',
        workspaceId: '00000000-0000-7000-8000-000000009203',
        channel: { definitionId: '00000000-0000-7000-8000-000000009204' },
      },
    } as PublicationAdapterCommand;

    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'WEBHOOK_AUTHORIZATION_INVALID',
    });
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'WEBHOOK_RECONCILIATION_UNAVAILABLE',
    });

    expect(findVerifiedEndpoint).toHaveBeenCalledTimes(2);
    expect(resolve).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
