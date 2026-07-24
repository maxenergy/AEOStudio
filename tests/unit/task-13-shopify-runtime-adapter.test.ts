import * as AdapterRuntime from '@aeostudio/adapters';
import * as ChannelContracts from '@aeostudio/contracts/channels';
import type {
  ChannelPackagePayload,
  ChannelPackageRecord,
  PublicationRemoteState,
} from '@aeostudio/domain/channels-publishing';
import { describe, expect, test } from 'vitest';

interface RuntimeCommand {
  publicationId: string;
  idempotencyKey: string;
  target: string;
  channelPackage: ChannelPackageRecord;
  payload: ChannelPackagePayload;
  secretValue: string;
}

interface RuntimeAdapter {
  authorizationTargetFor(target: string): string;
  requiredScopesFor(input: { target: string; channelPackage: ChannelPackageRecord }): string[];
  validateAuthorization(command: RuntimeCommand): Promise<{ outcome: 'VALID' | 'INVALID' }>;
  publish(
    command: RuntimeCommand,
  ): Promise<
    | { outcome: 'APPLIED'; remoteRef: string; remoteState: PublicationRemoteState }
    | { outcome: Exclude<string, 'APPLIED'>; errorCode: string }
  >;
}

type RuntimeAdapterConstructor = new (options: {
  adapterKey: string;
  adapterVersion: string;
  descriptor: {
    capabilities: string[];
    requiredScopes: string[];
    termsVersion: string;
    processingRegion: string;
    retentionPolicy: string;
    trainingPolicy: string;
    subprocessors: Array<Record<string, unknown>>;
    ratePolicy: Record<string, unknown>;
  };
  providerApiVersion: string;
  supportedStableApiVersions: string[];
  draftAdapter: unknown;
}) => RuntimeAdapter;

interface ShopifyDraftTargetInput {
  schemaVersion: 'shopify-draft-target.v1';
  shopDomain: string;
  apiVersion: string;
  destination:
    | { kind: 'PAGE'; operation: 'CREATE'; handle: string }
    | { kind: 'BLOG_ARTICLE'; operation: 'CREATE'; handle: string; blogId: string }
    | { kind: 'PRODUCT'; operation: 'CREATE'; handle: string };
}

const packagePayload: ChannelPackagePayload = {
  files: {
    'content.md': '# Approved Shopify guide\n\nApproved summary.',
    'content.html': '<article><h1>Approved Shopify guide</h1><p>Approved summary.</p></article>',
    'structured-data.json': JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'CreativeWork',
      headline: 'Approved Shopify guide',
      abstract: 'Approved summary.',
    }),
  },
};

const channelPackage: ChannelPackageRecord = {
  id: '00000000-0000-7000-8000-000000001321',
  tenantId: '00000000-0000-7000-8000-000000001322',
  workspaceId: '00000000-0000-7000-8000-000000001323',
  packageRevision: 1,
  channel: {
    definitionId: '00000000-0000-7000-8000-000000001324',
    channelKey: 'shopify-draft',
  },
  transformer: { key: 'generic-web-package', version: '1.0.0' },
  packageSchemaVersion: '1.0.0',
  artifact: {
    artifactId: '00000000-0000-7000-8000-000000001325',
    artifactRevisionId: '00000000-0000-7000-8000-000000001326',
    revision: 4,
    contentHash: 'a'.repeat(64),
    type: 'DEFINITION_PRODUCT',
    locale: 'en-US',
    market: 'US',
    methodPolicyVersion: 'fixture-v1',
  },
  manifest: { schemaVersion: '1.0.0', files: [], assetRefs: [], claimSourceMap: [] },
  packageChecksum: 'b'.repeat(64),
  payloadObjectRef: 'memory://task-13-runtime-package',
  createdByUserId: '00000000-0000-7000-8000-000000001327',
  createdAt: '2026-07-21T00:00:00.000Z',
};

describe('Task 13 Shopify runtime Adapter bridge', () => {
  test('uses shop-scoped authorization and maps an exact package to a durable non-live state', async () => {
    const encodeDraftTarget = (
      ChannelContracts as unknown as {
        encodeShopifyDraftTarget?: (input: ShopifyDraftTargetInput) => string;
      }
    ).encodeShopifyDraftTarget;
    const encodeAuthorizationTarget = (
      ChannelContracts as unknown as {
        encodeShopifyShopAuthorizationTarget?: (input: {
          schemaVersion: 'shopify-shop-auth.v1';
          shopDomain: string;
        }) => string;
      }
    ).encodeShopifyShopAuthorizationTarget;
    const runtimeConstructor = (
      AdapterRuntime as unknown as {
        ShopifyDraftRuntimeAdapter?: RuntimeAdapterConstructor;
      }
    ).ShopifyDraftRuntimeAdapter;

    expect(encodeDraftTarget, 'expected Shopify draft target codec').toBeTypeOf('function');
    expect(encodeAuthorizationTarget, 'expected Shopify shop authorization codec').toBeTypeOf(
      'function',
    );
    expect(runtimeConstructor, 'expected Shopify runtime bridge').toBeTypeOf('function');
    if (
      encodeDraftTarget === undefined ||
      encodeAuthorizationTarget === undefined ||
      runtimeConstructor === undefined
    ) {
      throw new Error('expected Shopify runtime bridge');
    }

    const secretSentinel = 'shopify-runtime-token-must-never-escape';
    const api = new AdapterRuntime.VersionedFakeShopifyAdminApi({
      apiVersion: '2026-04',
      shopDomain: 'tenant-shop.myshopify.com',
      authorization: { scopes: ['write_content'], accessToken: secretSentinel },
      log: () => undefined,
    });
    const draftAdapter = new AdapterRuntime.ShopifyDraftPublicationAdapter({
      adapterKey: 'shopify-draft',
      adapterVersion: '1.0.0',
      providerApiVersion: '2026-04',
      supportedStableApiVersions: ['2026-04'],
      api,
      requiredScopesByContentKind: {
        PAGE: ['write_content'],
        BLOG_ARTICLE: ['write_content'],
        PRODUCT: ['write_products'],
      },
      allowedShopDomains: ['tenant-shop.myshopify.com'],
    });
    const adapter = new runtimeConstructor({
      adapterKey: 'shopify-draft',
      adapterVersion: '1.0.0',
      providerApiVersion: '2026-04',
      supportedStableApiVersions: ['2026-04'],
      descriptor: {
        capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
        requiredScopes: ['write_content', 'write_products'],
        termsVersion: 'shopify-test-terms-v1',
        processingRegion: 'in-process-test-runtime',
        retentionPolicy: 'No credential or package retention.',
        trainingPolicy: 'No training.',
        subprocessors: [],
        ratePolicy: { apiVersion: '2026-04', mode: 'deterministic-test-only' },
      },
      draftAdapter,
    });
    const target = encodeDraftTarget({
      schemaVersion: 'shopify-draft-target.v1',
      shopDomain: 'tenant-shop.myshopify.com',
      apiVersion: '2026-04',
      destination: { kind: 'PAGE', operation: 'CREATE', handle: 'approved-shopify-guide' },
    });
    const command: RuntimeCommand = {
      publicationId: '00000000-0000-7000-8000-000000001328',
      idempotencyKey: 'local-shopify-runtime-attempt',
      target,
      channelPackage,
      payload: packagePayload,
      secretValue: secretSentinel,
    };

    expect(adapter.authorizationTargetFor(target)).toBe(
      encodeAuthorizationTarget({
        schemaVersion: 'shopify-shop-auth.v1',
        shopDomain: 'tenant-shop.myshopify.com',
      }),
    );
    expect(adapter.requiredScopesFor({ target, channelPackage })).toEqual(['write_content']);
    await expect(adapter.validateAuthorization(command)).resolves.toEqual({ outcome: 'VALID' });
    const result = await adapter.publish(command);
    expect(result).toEqual({
      outcome: 'APPLIED',
      remoteRef: 'https://tenant-shop.myshopify.com/admin/pages/1',
      remoteState: {
        status: 'UNPUBLISHED',
        number: null,
        isProductionLive: false,
        rollbackHandle: {
          operation: 'DELETE_UNPUBLISHED_CONTENT',
          shopDomain: 'tenant-shop.myshopify.com',
          contentType: 'PAGE',
          remoteGid: 'gid://shopify/Page/1',
        },
      },
    });
    expect(JSON.stringify({ result, snapshot: api.snapshot() })).not.toContain(secretSentinel);
  });
});
