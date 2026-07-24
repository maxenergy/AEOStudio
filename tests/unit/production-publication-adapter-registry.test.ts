import { describe, expect, test } from 'vitest';
import { vi } from 'vitest';

import { createProductionPublicationAdapterRegistry } from '@aeostudio/adapters/publication';
import {
  validatePublicationAdapterRuntime,
  type PublicationAdapterCommand,
} from '@aeostudio/application/channels-publishing';
import {
  encodeGitPullRequestTarget,
  encodeShopifyDraftTarget,
  encodeSignedWebhookTarget,
  encodeWordPressDraftTarget,
} from '@aeostudio/contracts/channels';
import type {
  ChannelPackagePayload,
  ChannelPackageRecord,
} from '@aeostudio/domain/channels-publishing';

describe('production publication Adapter registry', () => {
  test('installs the four reviewed owned-site Adapter runtime identities', () => {
    const registry = createProductionPublicationAdapterRegistry();

    for (const adapterKey of [
      'git-pull-request',
      'wordpress-woocommerce-draft',
      'shopify-draft',
      'signed-webhook',
    ]) {
      const adapter = registry.resolve(adapterKey, '1.0.0');

      expect(adapter, `${adapterKey}@1.0.0`).not.toBeNull();
      expect(adapter?.describe()).toMatchObject({
        adapterKey,
        adapterVersion: '1.0.0',
      });
      if (adapter === null) throw new Error('PRODUCTION_PUBLICATION_ADAPTER_REQUIRED');
      expect(validatePublicationAdapterRuntime(adapter, adapter.describe())).toBeNull();
    }

    expect(registry.resolve('git-pull-request', '2.0.0')).toBeNull();
    expect(registry.resolve('unreviewed-channel', '1.0.0')).toBeNull();
  });

  test('binds signed-webhook authorization to a platform-owned durable endpoint verification', async () => {
    const endpoint = {
      endpointUrl: 'https://receiver.example.test/hooks/aeostudio',
      receiptUrl: 'https://receiver.example.test/hooks/aeostudio/receipts',
      endpointVerificationId: '00000000-0000-7000-8000-000000009001',
      algorithm: 'HMAC_SHA256' as const,
      keyId: 'production-hmac-1',
    };
    const findVerifiedEndpoint = vi.fn(() =>
      Promise.resolve({
        status: 'VERIFIED' as const,
        tenantId: '00000000-0000-7000-8000-000000009011',
        workspaceId: '00000000-0000-7000-8000-000000009012',
        channelDefinitionId: '00000000-0000-7000-8000-000000009013',
        ...endpoint,
      }),
    );
    const registry = createProductionPublicationAdapterRegistry({
      signedWebhookEndpointVerifications: { findVerifiedEndpoint },
      signedWebhook: {
        resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
        transport: {
          post: () => Promise.reject(new Error('HTTP_NOT_EXPECTED_DURING_AUTHORIZATION')),
        },
        clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
        nextNonce: () => 'production-registry-nonce-0001',
      },
    });
    const adapter = registry.resolve('signed-webhook', '1.0.0');
    if (adapter === null) throw new Error('SIGNED_WEBHOOK_ADAPTER_REQUIRED');
    const target = encodeSignedWebhookTarget({
      schemaVersion: 'signed-webhook-target.v1',
      ...endpoint,
    });
    const command = signedWebhookCommand({
      target,
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
    });

    await expect(adapter.validateAuthorization(command)).resolves.toEqual({ outcome: 'VALID' });
    expect(findVerifiedEndpoint).toHaveBeenCalledWith({
      tenantId: command.channelPackage.tenantId,
      workspaceId: command.channelPackage.workspaceId,
      channelDefinitionId: command.channelPackage.channel.definitionId,
      endpointVerificationId: endpoint.endpointVerificationId,
    });
    const defaultAdapter = createProductionPublicationAdapterRegistry().resolve(
      'signed-webhook',
      '1.0.0',
    );
    if (defaultAdapter === null) throw new Error('DEFAULT_SIGNED_WEBHOOK_ADAPTER_REQUIRED');
    await expect(defaultAdapter.validateAuthorization(command)).resolves.toEqual({
      outcome: 'INVALID',
      reason: 'TARGET_NOT_ALLOWED',
    });
    await expect(
      adapter.validateAuthorization({
        ...command,
        target: encodeSignedWebhookTarget({
          schemaVersion: 'signed-webhook-target.v1',
          ...endpoint,
          endpointVerificationId: '00000000-0000-7000-8000-000000009099',
        }),
      }),
    ).resolves.toEqual({ outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' });
  });

  test('validates a GitHub installation credential against the exact repository and protected base', async () => {
    const token = 'github-installation-token-value';
    const request = vi.fn(
      (input: { method: string; path: string; headers: Record<string, string> }) => {
        if (input.path === '/installation') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: {
              id: 42,
              permissions: {
                contents: 'write',
                pull_requests: 'write',
                metadata: 'read',
              },
            },
          });
        }
        if (input.path === '/installation/repositories?per_page=100&page=1') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: {
              total_count: 1,
              repositories: [{ full_name: 'example/docs' }],
            },
          });
        }
        if (input.path === '/repos/example/docs') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { full_name: 'example/docs' },
          });
        }
        if (input.path === '/repos/example/docs/branches/main') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { name: 'main', protected: true },
          });
        }
        throw new Error(`UNEXPECTED_GITHUB_REQUEST:${input.method}:${input.path}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      github: { request },
    }).resolve('git-pull-request', '1.0.0');
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');
    const command = signedWebhookCommand({
      target: encodeGitPullRequestTarget({
        schemaVersion: 'git-pr-target.v1',
        provider: 'GITHUB',
        installationId: '42',
        repository: 'example/docs',
        baseBranch: 'main',
        pathPrefix: 'content/approved',
      }),
      secretValue: JSON.stringify({
        schemaVersion: 'aeostudio.github-installation-credential.v1',
        installationId: '42',
        permissions: {
          contents: 'write',
          pull_requests: 'write',
          metadata: 'read',
        },
        token,
      }),
    });

    const result = await adapter.validateAuthorization(command);

    expect(result).toEqual({ outcome: 'VALID' });
    expect(request).toHaveBeenCalledTimes(4);
    for (const [input] of request.mock.calls) {
      expect(input.headers.authorization).toBe(`Bearer ${token}`);
      expect(JSON.stringify(input)).not.toContain(command.secretValue);
    }
    expect(JSON.stringify(result)).not.toContain(token);
  });

  test('the default registry composes the bounded GitHub Node transport', async () => {
    const fetch = vi.fn((input: string | URL | Request) => {
      const requestUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(requestUrl).pathname;
      const body =
        path === '/installation'
          ? {
              id: 42,
              permissions: {
                contents: 'write',
                pull_requests: 'write',
                metadata: 'read',
              },
            }
          : path === '/installation/repositories'
            ? {
                total_count: 1,
                repositories: [{ full_name: 'example/docs' }],
              }
            : path === '/repos/example/docs'
              ? { full_name: 'example/docs' }
              : path === '/repos/example/docs/branches/main'
                ? { name: 'main', protected: true }
                : null;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: body === null ? 404 : 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const adapter = createProductionPublicationAdapterRegistry().resolve(
        'git-pull-request',
        '1.0.0',
      );
      if (adapter === null) throw new Error('DEFAULT_GITHUB_ADAPTER_REQUIRED');
      const command = signedWebhookCommand({
        target: encodeGitPullRequestTarget({
          schemaVersion: 'git-pr-target.v1',
          provider: 'GITHUB',
          installationId: '42',
          repository: 'example/docs',
          baseBranch: 'main',
          pathPrefix: 'content/approved',
        }),
        secretValue: JSON.stringify({
          schemaVersion: 'aeostudio.github-installation-credential.v1',
          installationId: '42',
          permissions: {
            contents: 'write',
            pull_requests: 'write',
            metadata: 'read',
          },
          token: 'github-installation-token-value',
        }),
      });

      await expect(adapter.validateAuthorization(command)).resolves.toEqual({ outcome: 'VALID' });
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('validates a Shopify offline token against the exact shop, API version, and target scope', async () => {
    const accessToken = 'shopify-offline-access-token';
    const request = vi.fn(() =>
      Promise.resolve({
        status: 200,
        headers: { 'x-shopify-api-version': '2026-07' },
        body: {
          data: {
            shop: { myshopifyDomain: 'example-store.myshopify.com' },
            currentAppInstallation: {
              accessScopes: [{ handle: 'write_content' }],
            },
          },
        },
      }),
    );
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const command = signedWebhookCommand({
      target: encodeShopifyDraftTarget({
        schemaVersion: 'shopify-draft-target.v1',
        shopDomain: 'example-store.myshopify.com',
        apiVersion: '2026-07',
        destination: { kind: 'PAGE', operation: 'CREATE', handle: 'approved-content' },
      }),
      secretValue: JSON.stringify({
        schemaVersion: 'aeostudio.shopify-offline-credential.v1',
        shopDomain: 'example-store.myshopify.com',
        apiVersion: '2026-07',
        accessToken,
      }),
    });

    const result = await adapter.validateAuthorization(command);

    expect(result).toEqual({ outcome: 'VALID' });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://example-store.myshopify.com/admin/api/2026-07/graphql.json',
      headers: {
        'content-type': 'application/json',
        'x-shopify-access-token': accessToken,
      },
    });
    expect(JSON.stringify(result)).not.toContain(accessToken);
  });

  test('the default registry composes the bounded Shopify Node transport', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              shop: { myshopifyDomain: 'example-store.myshopify.com' },
              currentAppInstallation: {
                accessScopes: [{ handle: 'write_content' }],
              },
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-shopify-api-version': '2026-07',
            },
          },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    try {
      const adapter = createProductionPublicationAdapterRegistry().resolve(
        'shopify-draft',
        '1.0.0',
      );
      if (adapter === null) throw new Error('DEFAULT_SHOPIFY_ADAPTER_REQUIRED');
      const command = signedWebhookCommand({
        target: encodeShopifyDraftTarget({
          schemaVersion: 'shopify-draft-target.v1',
          shopDomain: 'example-store.myshopify.com',
          apiVersion: '2026-07',
          destination: { kind: 'PAGE', operation: 'CREATE', handle: 'approved-content' },
        }),
        secretValue: JSON.stringify({
          schemaVersion: 'aeostudio.shopify-offline-credential.v1',
          shopDomain: 'example-store.myshopify.com',
          apiVersion: '2026-07',
          accessToken: 'shopify-offline-access-token',
        }),
      });

      await expect(adapter.validateAuthorization(command)).resolves.toEqual({ outcome: 'VALID' });
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('the production registry composes the create-only WordPress Adapter with its safe client', async () => {
    const authorizationHeader = 'Basic dXNlcjphcHAtcGFzc3dvcmQ=';
    const request = vi.fn(
      (input: { method: string; url: string; headers: Record<string, string> }) => {
        expect(input).toMatchObject({
          method: 'GET',
          url: 'https://cms.example.test/wp-json/wp/v2/users/me?context=edit',
          headers: { authorization: authorizationHeader },
        });
        return Promise.resolve({
          status: 200,
          headers: {},
          body: {
            capabilities: {
              upload_files: false,
              edit_pages: true,
              edit_posts: false,
              edit_products: false,
            },
          },
        });
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      wordpress: { request },
    }).resolve('wordpress-woocommerce-draft', '1.0.0');
    if (adapter === null) throw new Error('DEFAULT_WORDPRESS_ADAPTER_REQUIRED');
    const command = signedWebhookCommand({
      target: encodeWordPressDraftTarget({
        schemaVersion: 'wordpress-draft-target.v1',
        siteUrl: 'https://cms.example.test',
        authMode: 'APPLICATION_PASSWORD',
        destination: { kind: 'PAGE', operation: 'CREATE', slug: 'approved-content' },
      }),
      secretValue: JSON.stringify({
        schemaVersion: 'aeostudio.wordpress-credential.v1',
        siteUrl: 'https://cms.example.test',
        authMode: 'APPLICATION_PASSWORD',
        scopes: ['pages:write'],
        authorizationHeader,
      }),
    });
    command.payload.files['structured-data.json'] = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'Approved content',
    });

    await expect(adapter.validateAuthorization(command)).resolves.toEqual({ outcome: 'VALID' });
    expect(request).toHaveBeenCalledOnce();
  });
});

function signedWebhookCommand(input: {
  target: string;
  secretValue: string;
}): PublicationAdapterCommand {
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
      methodPolicyVersion: 'production-registry-test-v1',
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
    target: input.target,
    channelPackage,
    payload,
    secretValue: input.secretValue,
  };
}
