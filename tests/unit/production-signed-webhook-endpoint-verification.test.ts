import {
  createProductionPublicationAdapterRegistry,
  type SignedWebhookEndpointVerificationRecord,
} from '@aeostudio/adapters/publication';
import type { PublicationAdapterCommand } from '@aeostudio/application/channels-publishing';
import { encodeSignedWebhookTarget } from '@aeostudio/contracts/channels';
import type {
  ChannelPackagePayload,
  ChannelPackageRecord,
} from '@aeostudio/domain/channels-publishing';
import { describe, expect, test, vi } from 'vitest';

const endpoint = {
  endpointUrl: 'https://receiver.example.test/hooks/aeostudio',
  receiptUrl: 'https://receiver.example.test/hooks/aeostudio/receipts',
  endpointVerificationId: '00000000-0000-7000-8000-000000009001',
  algorithm: 'HMAC_SHA256' as const,
  keyId: 'production-hmac-1',
};

describe('production signed-webhook endpoint verification boundary', () => {
  test('turns the exact durable endpoint tuple into provider-valid authorization evidence', async () => {
    const verification = verificationRecord();
    const findVerifiedEndpoint = vi.fn(() => Promise.resolve(verification));
    const transport = { post: vi.fn() };
    const adapter = createProductionPublicationAdapterRegistry({
      signedWebhookEndpointVerifications: { findVerifiedEndpoint },
      signedWebhook: {
        resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
        transport,
        clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
        nextNonce: () => 'provider-validation-nonce',
      },
    }).resolve('signed-webhook', '1.0.0');
    if (adapter === null) throw new Error('SIGNED_WEBHOOK_ADAPTER_REQUIRED');
    const command = commandFor();

    await expect(
      adapter.validateChannelAuthorization?.({
        tenantId: command.channelPackage.tenantId,
        workspaceId: command.channelPackage.workspaceId,
        channelDefinitionId: command.channelPackage.channel.definitionId,
        target: command.target,
        requestedScopes: ['webhook:deliver'],
        acceptedTermsVersion: 'signed-webhook-contract-v1',
        secretValue: command.secretValue,
      }),
    ).resolves.toEqual({
      outcome: 'VERIFIED',
      actualTarget: command.target,
      actualScopes: ['webhook:deliver'],
    });
    expect(findVerifiedEndpoint).toHaveBeenCalledOnce();
    expect(transport.post).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: 'the target key is only a historical reconciliation key',
      credential: credentialFor({
        activeKeyId: 'production-hmac-2',
        keys: [signingKey(endpoint.keyId), signingKey('production-hmac-2')],
      }),
      runtimeAuthorization: { outcome: 'VALID' },
    },
    {
      name: 'the active target key is expired',
      credential: credentialFor({
        activeKeyId: endpoint.keyId,
        keys: [signingKey(endpoint.keyId, '2026-07-23T23:59:59.000Z')],
      }),
      runtimeAuthorization: { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' },
    },
  ])(
    'rejects provider validation when $name while preserving operation-specific runtime rotation',
    async ({ credential, runtimeAuthorization }) => {
      const findVerifiedEndpoint = vi.fn(() => Promise.resolve(verificationRecord()));
      const transport = { post: vi.fn() };
      const adapter = createProductionPublicationAdapterRegistry({
        signedWebhookEndpointVerifications: { findVerifiedEndpoint },
        signedWebhook: {
          resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
          transport,
          clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
          nextNonce: () => 'provider-validation-nonce',
        },
      }).resolve('signed-webhook', '1.0.0');
      if (adapter === null) throw new Error('SIGNED_WEBHOOK_ADAPTER_REQUIRED');
      const command = commandFor();
      command.secretValue = credential;

      await expect(
        adapter.validateChannelAuthorization?.({
          tenantId: command.channelPackage.tenantId,
          workspaceId: command.channelPackage.workspaceId,
          channelDefinitionId: command.channelPackage.channel.definitionId,
          target: command.target,
          requestedScopes: ['webhook:deliver'],
          acceptedTermsVersion: 'signed-webhook-contract-v1',
          secretValue: command.secretValue,
        }),
      ).resolves.toEqual({
        outcome: 'INVALID',
        reason: 'CREDENTIAL_INVALID',
      });
      expect(findVerifiedEndpoint).not.toHaveBeenCalled();
      await expect(adapter.validateAuthorization(command)).resolves.toEqual(runtimeAuthorization);
      expect(findVerifiedEndpoint).toHaveBeenCalledOnce();
      expect(transport.post).not.toHaveBeenCalled();
    },
  );

  test('does not accept a credential self-declared public endpoint as verification evidence', async () => {
    const transport = { post: vi.fn() };
    const registry = createProductionPublicationAdapterRegistry({
      signedWebhook: {
        resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
        transport,
        clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
        nextNonce: () => 'production-verification-nonce-0001',
      },
    });
    const adapter = registry.resolve('signed-webhook', '1.0.0');
    if (adapter === null) throw new Error('SIGNED_WEBHOOK_ADAPTER_REQUIRED');

    await expect(adapter.validateAuthorization(commandFor())).resolves.toEqual({
      outcome: 'INVALID',
      reason: 'TARGET_NOT_ALLOWED',
    });
    expect(transport.post).not.toHaveBeenCalled();
  });

  test('does not publish to a credential self-declared endpoint without durable verification', async () => {
    const transport = {
      post: vi.fn(() =>
        Promise.resolve({
          status: 202,
          headers: {},
          body: new Uint8Array(),
          location: null,
          connectedAddress: '93.184.216.34',
        }),
      ),
    };
    const registry = createProductionPublicationAdapterRegistry({
      signedWebhook: {
        resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
        transport,
        clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
        nextNonce: () => 'production-verification-nonce-0002',
      },
    });
    const adapter = registry.resolve('signed-webhook', '1.0.0');
    if (adapter === null) throw new Error('SIGNED_WEBHOOK_ADAPTER_REQUIRED');

    await expect(adapter.publish(commandFor())).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'WEBHOOK_AUTHORIZATION_INVALID',
    });
    expect(transport.post).not.toHaveBeenCalled();
  });

  test('does not reconcile against a credential self-declared endpoint without durable verification', async () => {
    const transport = {
      post: vi.fn(() =>
        Promise.resolve({
          status: 202,
          headers: {},
          body: new Uint8Array(),
          location: null,
          connectedAddress: '93.184.216.34',
        }),
      ),
    };
    const registry = createProductionPublicationAdapterRegistry({
      signedWebhook: {
        resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
        transport,
        clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
        nextNonce: () => 'production-verification-nonce-0003',
      },
    });
    const adapter = registry.resolve('signed-webhook', '1.0.0');
    if (adapter === null) throw new Error('SIGNED_WEBHOOK_ADAPTER_REQUIRED');

    await expect(adapter.reconcile(commandFor())).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'WEBHOOK_RECONCILIATION_UNAVAILABLE',
    });
    expect(transport.post).not.toHaveBeenCalled();
  });

  test('rechecks the exact tenant, workspace, channel, and endpoint tuple at every remote-effect boundary', async () => {
    const verification = verificationRecord();
    const findVerifiedEndpoint = vi.fn(() => Promise.resolve(verification));
    const transport = {
      post: vi.fn(() =>
        Promise.resolve({
          status: 202,
          headers: {},
          body: new Uint8Array(),
          location: null,
          connectedAddress: '93.184.216.34',
        }),
      ),
    };
    const registry = createProductionPublicationAdapterRegistry({
      signedWebhookEndpointVerifications: { findVerifiedEndpoint },
      signedWebhook: {
        resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
        transport,
        clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
        nextNonce: () => 'production-verification-nonce-0004',
      },
    });
    const adapter = registry.resolve('signed-webhook', '1.0.0');
    if (adapter === null) throw new Error('SIGNED_WEBHOOK_ADAPTER_REQUIRED');
    const command = commandFor();
    const expectedLookup = {
      tenantId: command.channelPackage.tenantId,
      workspaceId: command.channelPackage.workspaceId,
      channelDefinitionId: command.channelPackage.channel.definitionId,
      endpointVerificationId: endpoint.endpointVerificationId,
    };

    await expect(adapter.validateAuthorization(command)).resolves.toEqual({ outcome: 'VALID' });
    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'WEBHOOK_RECEIPT_PENDING',
    });
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'WEBHOOK_RECEIPT_PENDING',
    });

    expect(findVerifiedEndpoint).toHaveBeenCalledTimes(3);
    for (const [lookup] of findVerifiedEndpoint.mock.calls) {
      expect(lookup).toEqual(expectedLookup);
    }
    expect(transport.post).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['tenantId', '00000000-0000-7000-8000-000000009099'],
    ['workspaceId', '00000000-0000-7000-8000-000000009099'],
    ['channelDefinitionId', '00000000-0000-7000-8000-000000009099'],
    ['endpointVerificationId', '00000000-0000-7000-8000-000000009099'],
    ['endpointUrl', 'https://different.example.test/hooks/aeostudio'],
    ['receiptUrl', 'https://different.example.test/hooks/aeostudio/receipts'],
    ['algorithm', 'ED25519'],
    ['keyId', 'different-production-key'],
  ] as const)(
    'rejects a durable verification whose %s does not match the publication command',
    async (field, value) => {
      const findVerifiedEndpoint = vi.fn(() =>
        Promise.resolve({ ...verificationRecord(), [field]: value }),
      );
      const transport = { post: vi.fn() };
      const registry = createProductionPublicationAdapterRegistry({
        signedWebhookEndpointVerifications: { findVerifiedEndpoint },
        signedWebhook: {
          resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
          transport,
          clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
          nextNonce: () => 'production-verification-nonce-0005',
        },
      });
      const adapter = registry.resolve('signed-webhook', '1.0.0');
      if (adapter === null) throw new Error('SIGNED_WEBHOOK_ADAPTER_REQUIRED');

      await expect(adapter.validateAuthorization(commandFor())).resolves.toEqual({
        outcome: 'INVALID',
        reason: 'TARGET_NOT_ALLOWED',
      });
      expect(transport.post).not.toHaveBeenCalled();
    },
  );

  test('revalidates the full tuple before publish and reconcile instead of trusting an earlier authorization', async () => {
    const verification = {
      ...verificationRecord(),
      receiptUrl: 'https://substituted.example.test/hooks/aeostudio/receipts',
    };
    const findVerifiedEndpoint = vi.fn(() => Promise.resolve(verification));
    const transport = { post: vi.fn() };
    const registry = createProductionPublicationAdapterRegistry({
      signedWebhookEndpointVerifications: { findVerifiedEndpoint },
      signedWebhook: {
        resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
        transport,
        clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
        nextNonce: () => 'production-verification-nonce-0006',
      },
    });
    const adapter = registry.resolve('signed-webhook', '1.0.0');
    if (adapter === null) throw new Error('SIGNED_WEBHOOK_ADAPTER_REQUIRED');
    const command = commandFor();

    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'WEBHOOK_AUTHORIZATION_INVALID',
    });
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'WEBHOOK_RECONCILIATION_UNAVAILABLE',
    });
    expect(findVerifiedEndpoint).toHaveBeenCalledTimes(2);
    expect(transport.post).not.toHaveBeenCalled();
  });
});

function verificationRecord(): SignedWebhookEndpointVerificationRecord {
  return {
    status: 'VERIFIED',
    tenantId: '00000000-0000-7000-8000-000000009011',
    workspaceId: '00000000-0000-7000-8000-000000009012',
    channelDefinitionId: '00000000-0000-7000-8000-000000009013',
    ...endpoint,
  };
}

function commandFor(): PublicationAdapterCommand {
  const payload: ChannelPackagePayload = {
    files: {
      'content.md': '# Approved content\n',
      'content.html': '<article><h1>Approved content</h1></article>',
      'structured-data.json': '{"@context":"https://schema.org","@type":"Article"}',
    },
  };
  const channelPackage: ChannelPackageRecord = {
    id: '00000000-0000-7000-8000-000000009010',
    tenantId: '00000000-0000-7000-8000-000000009011',
    workspaceId: '00000000-0000-7000-8000-000000009012',
    packageRevision: 1,
    channel: {
      definitionId: '00000000-0000-7000-8000-000000009013',
      channelKey: 'signed-webhook',
    },
    transformer: { key: 'generic-web-package', version: '1.0.0' },
    packageSchemaVersion: '1.0.0',
    artifact: {
      artifactId: '00000000-0000-7000-8000-000000009014',
      artifactRevisionId: '00000000-0000-7000-8000-000000009015',
      revision: 1,
      contentHash: 'a'.repeat(64),
      type: 'DEFINITION_PRODUCT',
      locale: 'en-SG',
      market: 'SG',
      methodPolicyVersion: 'production-verification-test-v1',
    },
    manifest: {
      schemaVersion: '1.0.0',
      files: Object.entries(payload.files).map(([path, value]) => ({
        path,
        mediaType:
          path === 'content.md'
            ? 'text/markdown'
            : path === 'content.html'
              ? 'text/html'
              : 'application/ld+json',
        sha256: 'b'.repeat(64),
        byteLength: Buffer.byteLength(value, 'utf8'),
      })),
      assetRefs: [],
      claimSourceMap: [],
    },
    packageChecksum: 'c'.repeat(64),
    payloadObjectRef: 's3://test-bucket/channel-package.json',
    createdByUserId: '00000000-0000-7000-8000-000000009016',
    createdAt: '2026-07-24T00:00:00.000Z',
  };
  return {
    publicationId: '00000000-0000-7000-8000-000000009017',
    idempotencyKey: '00000000-0000-7000-8000-000000009017',
    target: encodeSignedWebhookTarget({
      schemaVersion: 'signed-webhook-target.v1',
      ...endpoint,
    }),
    channelPackage,
    payload,
    secretValue: JSON.stringify({
      schemaVersion: 'aeostudio.signed-webhook-credential.v1',
      endpoint,
      keyRing: {
        schemaVersion: 'signed-webhook-key-ring.v1',
        activeKeyId: endpoint.keyId,
        keys: [
          {
            keyId: endpoint.keyId,
            algorithm: endpoint.algorithm,
            signingMaterial: 'a'.repeat(64),
            validFrom: '2026-07-01T00:00:00.000Z',
            validUntil: null,
          },
        ],
      },
    }),
  };
}

function signingKey(keyId: string, validUntil: string | null = null) {
  return {
    keyId,
    algorithm: endpoint.algorithm,
    signingMaterial: 'a'.repeat(64),
    validFrom: '2026-07-01T00:00:00.000Z',
    validUntil,
  };
}

function credentialFor(input: {
  activeKeyId: string;
  keys: ReturnType<typeof signingKey>[];
}): string {
  return JSON.stringify({
    schemaVersion: 'aeostudio.signed-webhook-credential.v1',
    endpoint,
    keyRing: {
      schemaVersion: 'signed-webhook-key-ring.v1',
      activeKeyId: input.activeKeyId,
      keys: input.keys,
    },
  });
}
