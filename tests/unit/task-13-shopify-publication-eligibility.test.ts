import {
  PublicationEligibilityService,
  type ChannelAuthorizationStore,
  type ChannelPackageService,
  type ChannelRegistryStore,
  type PublicationAdapter,
  type RuntimeChannelAdapterRegistry,
} from '@aeostudio/application/channels-publishing';
import {
  encodeShopifyDraftTarget,
  encodeShopifyShopAuthorizationTarget,
  shopifyAuthorizationTargetFor,
  shopifyRequiredScopesFor,
} from '@aeostudio/contracts/channels';
import type {
  ChannelAuthorizationEligibility,
  ChannelPackageRecord,
  ChannelRegistryEntry,
} from '@aeostudio/domain/channels-publishing';
import { describe, expect, test, vi } from 'vitest';

const tenantId = '00000000-0000-7000-8000-000000001301';
const workspaceId = '00000000-0000-7000-8000-000000001302';
const adapterVersionId = '00000000-0000-7000-8000-000000001303';
const packageId = '00000000-0000-7000-8000-000000001304';
const supportedUntil = '2027-07-16T15:00:00.000Z';
const shopDomain = 'tenant-a.myshopify.com';
const context = {
  tenantId,
  workspaceId,
  actorUserId: '00000000-0000-7000-8000-000000001305',
  membershipId: '00000000-0000-7000-8000-000000001306',
  role: 'PUBLISHER' as const,
};

const channelPackage: ChannelPackageRecord = {
  id: packageId,
  tenantId,
  workspaceId,
  packageRevision: 1,
  channel: {
    definitionId: '00000000-0000-7000-8000-000000001307',
    channelKey: 'shopify-draft',
  },
  transformer: { key: 'generic-web-package', version: '1.0.0' },
  packageSchemaVersion: '1.0.0',
  artifact: {
    artifactId: '00000000-0000-7000-8000-000000001308',
    artifactRevisionId: '00000000-0000-7000-8000-000000001309',
    revision: 1,
    contentHash: 'a'.repeat(64),
    type: 'DEFINITION_PRODUCT',
    locale: 'en-US',
    market: 'US',
    methodPolicyVersion: 'fixture-v1',
  },
  manifest: { schemaVersion: '1.0.0', files: [], assetRefs: [], claimSourceMap: [] },
  packageChecksum: 'b'.repeat(64),
  payloadObjectRef: 'memory://task-13-package',
  createdByUserId: context.actorUserId,
  createdAt: '2026-07-21T00:00:00.000Z',
};

const registryEntry: ChannelRegistryEntry = {
  id: channelPackage.channel.definitionId,
  channelKey: channelPackage.channel.channelKey,
  displayName: 'Shopify Draft',
  status: 'AVAILABLE',
  unavailableReason: null,
  packageTransformerKey: 'generic-web-package',
  packageSchemaVersion: '1.0.0',
  adapterVersions: [
    {
      id: adapterVersionId,
      adapterKey: 'shopify-draft',
      adapterVersion: '1.0.0',
      providerApiVersion: '2026-07',
      providerApiSupportedUntil: supportedUntil,
      enabled: true,
      disabledReason: null,
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
      requiredScopes: ['write_content', 'write_products'],
      termsVersion: 'shopify-test-terms-v1',
      termsStatus: 'ALLOWED',
      processingRegion: 'in-process-test-runtime',
      retentionPolicy: 'No credential or package retention.',
      trainingPolicy: 'No training.',
      subprocessors: [],
      ratePolicy: { mode: 'deterministic-test-only' },
    },
  ],
};

function pageTarget(handle: string): string {
  return encodeShopifyDraftTarget({
    schemaVersion: 'shopify-draft-target.v1',
    shopDomain,
    apiVersion: '2026-07',
    destination: { kind: 'PAGE', operation: 'CREATE', handle },
  });
}

function runtimeAdapter(): PublicationAdapter {
  return {
    adapterKey: 'shopify-draft',
    adapterVersion: '1.0.0',
    describe: () => ({
      adapterKey: 'shopify-draft',
      adapterVersion: '1.0.0',
      providerApiVersion: '2026-07',
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
      requiredScopes: ['write_content', 'write_products'],
      termsVersion: 'shopify-test-terms-v1',
      processingRegion: 'in-process-test-runtime',
      retentionPolicy: 'No credential or package retention.',
      trainingPolicy: 'No training.',
      subprocessors: [],
      ratePolicy: { mode: 'deterministic-test-only' },
    }),
    authorizationTargetFor: shopifyAuthorizationTargetFor,
    requiredScopesFor: ({ target }) => shopifyRequiredScopesFor(target),
    validateAuthorization: () => Promise.resolve({ outcome: 'VALID' }),
    preview: ({ channelPackage: exactPackage, payload }) => ({
      packageChecksum: exactPackage.packageChecksum,
      files: payload.files,
    }),
    publish: () => Promise.resolve({ outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'NOT_USED' }),
    reconcile: () => Promise.resolve({ outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'NOT_USED' }),
    rollback: () =>
      Promise.resolve({ outcome: 'DEFINITELY_NOT_ROLLED_BACK', errorCode: 'NOT_USED' }),
  };
}

function makeService(now: string) {
  const authorizationTarget = encodeShopifyShopAuthorizationTarget({
    schemaVersion: 'shopify-shop-auth.v1',
    shopDomain,
  });
  const authorization: ChannelAuthorizationEligibility = {
    id: '00000000-0000-7000-8000-000000001310',
    tenantId,
    workspaceId,
    adapterVersionId,
    status: 'ACTIVE',
    grantedScopes: ['write_content'],
    acceptedTermsVersion: 'shopify-test-terms-v1',
    target: authorizationTarget,
    expiresAt: '2030-01-01T00:00:00.000Z',
    validationStatus: 'VERIFIED',
    validationSnapshot: {
      actualTarget: authorizationTarget,
      actualScopes: ['write_content'],
      acceptedTermsVersion: 'shopify-test-terms-v1',
      validatedAt: '2027-07-16T14:00:00.000Z',
      validUntil: '2030-01-01T00:00:00.000Z',
    },
    validationFailureCode: null,
    createdByUserId: context.actorUserId,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  };
  const findForTarget = vi.fn<ChannelAuthorizationStore['findForTarget']>((input) =>
    Promise.resolve(input.target === authorizationTarget ? authorization : null),
  );
  return {
    authorization,
    authorizationTarget,
    findForTarget,
    service: new PublicationEligibilityService(
      {
        verifyForPublication: () =>
          Promise.resolve({ outcome: 'SUCCEEDED' as const, context, package: channelPackage }),
      } as unknown as ChannelPackageService,
      { listEntries: () => Promise.resolve([registryEntry]) } satisfies ChannelRegistryStore,
      { findForTarget } as unknown as ChannelAuthorizationStore,
      { resolve: () => runtimeAdapter() } satisfies RuntimeChannelAdapterRegistry,
      { resolveTenantContext: () => Promise.resolve(context) },
      { now: () => new Date(now) },
    ),
  };
}

function eligibilityInput(target: string) {
  return {
    actorSubject: 'publisher-subject',
    tenantId,
    workspaceId,
    channelPackageId: packageId,
    adapterVersionId,
    target,
    expectedPackageChecksum: channelPackage.packageChecksum,
  };
}

describe('Task 13 Shopify provider-version eligibility', () => {
  test('one shop authorization covers multiple PAGE handles with write_content only', async () => {
    const fixture = makeService('2027-07-16T14:59:59.999Z');
    for (const handle of ['approved-first-page', 'approved-second-page']) {
      await expect(
        fixture.service.check(eligibilityInput(pageTarget(handle))),
      ).resolves.toMatchObject({
        outcome: 'READY',
        authorization: { id: fixture.authorization.id, target: fixture.authorizationTarget },
        requiredScopes: ['write_content'],
      });
    }
    expect(fixture.findForTarget.mock.calls.map(([input]) => input.target)).toEqual([
      fixture.authorizationTarget,
      fixture.authorizationTarget,
    ]);
  });

  test('fails closed at the exact provider API support cutoff with an explicit reason', async () => {
    const fixture = makeService(supportedUntil);
    await expect(
      fixture.service.check(eligibilityInput(pageTarget('approved-cutoff-page'))),
    ).resolves.toEqual({
      outcome: 'EXPORT_ONLY',
      packageId,
      packageChecksum: channelPackage.packageChecksum,
      reasons: [
        {
          code: 'ADAPTER_PROVIDER_API_VERSION_EXPIRED',
          detail: `Provider API version 2026-07 support ended at ${supportedUntil}.`,
        },
      ],
    });
  });
});
