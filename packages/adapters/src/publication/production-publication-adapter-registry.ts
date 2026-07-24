import { randomUUID } from 'node:crypto';

import type {
  PublicationAdapter,
  PublicationAdapterDescriptor,
  PublicationAdapterRegistry,
} from '@aeostudio/application/channels-publishing';
import type {
  SignedWebhookDnsResolver,
  SignedWebhookHttpTransport,
} from './signed-webhook-http-client.js';
import { ProductionSignedWebhookPublicationAdapter } from './production-signed-webhook-publication-adapter.js';
import type { SignedWebhookEndpointVerificationPort } from './signed-webhook-endpoint-verification.js';
import {
  ProductionGitHubPullRequestPublicationAdapter,
  type GitHubRestTransport,
} from './production-github-pull-request-publication-adapter.js';
import {
  ProductionShopifyDraftPublicationAdapter,
  type ShopifyGraphqlTransport,
} from './production-shopify-draft-publication-adapter.js';
import {
  NodeSignedWebhookDnsResolver,
  NodeSignedWebhookHttpsTransport,
} from './node-signed-webhook-http-transport.js';
import { NodeGitHubRestTransport } from './node-github-rest-transport.js';
import { NodeShopifyGraphqlTransport } from './node-shopify-graphql-transport.js';
import {
  ProductionWordPressWooCommerceDraftPublicationAdapter,
  type SafeWordPressJsonHttpClient,
} from './production-wordpress-woocommerce-draft-publication-adapter.js';
import { NodeSafeWordPressJsonHttpClient } from './node-wordpress-json-http-client.js';

const PRODUCTION_ADAPTER_DESCRIPTORS = [
  {
    adapterKey: 'git-pull-request',
    adapterVersion: '1.0.0',
    providerApiVersion: '2026-03-10',
    capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'PULL_REQUEST_STATUS'],
    requiredScopes: ['contents:write', 'pull_requests:write', 'metadata:read'],
    termsVersion: 'git-provider-terms-v1',
    processingRegion: 'Provider-controlled; authorization policy required.',
    retentionPolicy: 'Git Provider repository and pull-request retention policy applies.',
    trainingPolicy: 'No training is permitted.',
    subprocessors: [],
    ratePolicy: { mode: 'provider-rate-limits' },
  },
  {
    adapterKey: 'wordpress-woocommerce-draft',
    adapterVersion: '1.0.0',
    capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
    requiredScopes: ['media:write', 'pages:write', 'posts:write', 'woocommerce:products:write'],
    termsVersion: 'wordpress-provider-terms-v1',
    processingRegion: 'Tenant-owned site region; authorization policy required.',
    retentionPolicy: 'Tenant-owned WordPress or WooCommerce retention policy applies.',
    trainingPolicy: 'No training is permitted.',
    subprocessors: [],
    ratePolicy: { mode: 'site-rate-limits' },
  },
  {
    adapterKey: 'shopify-draft',
    adapterVersion: '1.0.0',
    providerApiVersion: '2026-07',
    capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
    requiredScopes: ['write_content', 'write_products'],
    termsVersion: 'shopify-provider-terms-v1',
    processingRegion: 'Provider-controlled; authorization policy required.',
    retentionPolicy: 'Shopify Admin API and merchant store retention policy applies.',
    trainingPolicy: 'No training is permitted.',
    subprocessors: [],
    ratePolicy: { mode: 'graphql-cost-throttle', providerApiVersion: '2026-07' },
  },
  {
    adapterKey: 'signed-webhook',
    adapterVersion: '1.0.0',
    capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
    requiredScopes: ['webhook:deliver'],
    termsVersion: 'signed-webhook-contract-v1',
    processingRegion: 'Verified receiver region; authorization policy required.',
    retentionPolicy:
      'Only verified receipts and audit hashes may be retained; approved request bodies are not retained by the Adapter.',
    trainingPolicy: 'No training is permitted.',
    subprocessors: [],
    ratePolicy: {
      mode: 'receiver-rate-limits',
      contractVersion: '1.0.0',
      signatureProfile: 'aeostudio-signed-webhook-v1',
    },
  },
] as const satisfies readonly PublicationAdapterDescriptor[];

export interface ProductionPublicationAdapterRegistryOptions {
  github?: GitHubRestTransport;
  shopify?: ShopifyGraphqlTransport;
  wordpress?: SafeWordPressJsonHttpClient;
  signedWebhookEndpointVerifications?: SignedWebhookEndpointVerificationPort;
  signedWebhook?: {
    resolver: SignedWebhookDnsResolver;
    transport: SignedWebhookHttpTransport;
    clock: { now(): Date };
    nextNonce(): string;
    timeoutMs?: number;
  };
}

export function createProductionPublicationAdapterRegistry(
  options: ProductionPublicationAdapterRegistryOptions = {},
): PublicationAdapterRegistry {
  const adapters = new Map<string, PublicationAdapter>();
  const githubDescriptor = PRODUCTION_ADAPTER_DESCRIPTORS.find(
    (candidate) => candidate.adapterKey === 'git-pull-request',
  );
  if (githubDescriptor === undefined) throw new Error('GITHUB_DESCRIPTOR_REQUIRED');
  const githubAdapter = new ProductionGitHubPullRequestPublicationAdapter({
    descriptor: structuredClone(githubDescriptor),
    transport: options.github ?? new NodeGitHubRestTransport(),
  });
  adapters.set(`${githubAdapter.adapterKey}\u0000${githubAdapter.adapterVersion}`, githubAdapter);
  const signedWebhookDescriptor = PRODUCTION_ADAPTER_DESCRIPTORS.find(
    (candidate) => candidate.adapterKey === 'signed-webhook',
  );
  if (signedWebhookDescriptor === undefined) throw new Error('SIGNED_WEBHOOK_DESCRIPTOR_REQUIRED');
  const adapter = new ProductionSignedWebhookPublicationAdapter({
    descriptor: structuredClone(signedWebhookDescriptor),
    ...(options.signedWebhook ?? {
      resolver: new NodeSignedWebhookDnsResolver(),
      transport: new NodeSignedWebhookHttpsTransport(),
      clock: { now: () => new Date() },
      nextNonce: randomUUID,
    }),
    ...(options.signedWebhookEndpointVerifications === undefined
      ? {}
      : { endpointVerifications: options.signedWebhookEndpointVerifications }),
  });
  adapters.set(`${adapter.adapterKey}\u0000${adapter.adapterVersion}`, adapter);
  const shopifyDescriptor = PRODUCTION_ADAPTER_DESCRIPTORS.find(
    (candidate) => candidate.adapterKey === 'shopify-draft',
  );
  if (shopifyDescriptor === undefined) throw new Error('SHOPIFY_DESCRIPTOR_REQUIRED');
  const shopifyAdapter = new ProductionShopifyDraftPublicationAdapter({
    descriptor: structuredClone(shopifyDescriptor),
    transport: options.shopify ?? new NodeShopifyGraphqlTransport(),
  });
  adapters.set(
    `${shopifyAdapter.adapterKey}\u0000${shopifyAdapter.adapterVersion}`,
    shopifyAdapter,
  );
  const wordpressDescriptor = PRODUCTION_ADAPTER_DESCRIPTORS.find(
    (candidate) => candidate.adapterKey === 'wordpress-woocommerce-draft',
  );
  if (wordpressDescriptor === undefined) throw new Error('WORDPRESS_DESCRIPTOR_REQUIRED');
  const wordpressAdapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
    descriptor: structuredClone(wordpressDescriptor),
    httpClient: options.wordpress ?? new NodeSafeWordPressJsonHttpClient(),
  });
  adapters.set(
    `${wordpressAdapter.adapterKey}\u0000${wordpressAdapter.adapterVersion}`,
    wordpressAdapter,
  );
  return {
    resolve(adapterKey, adapterVersion) {
      return adapters.get(`${adapterKey}\u0000${adapterVersion}`) ?? null;
    },
  };
}
