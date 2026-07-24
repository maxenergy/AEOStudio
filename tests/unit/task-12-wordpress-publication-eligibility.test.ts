import {
  PublicationEligibilityService,
  type ChannelAuthorizationStore,
  type ChannelPackageService,
  type ChannelRegistryStore,
  type PublicationAdapter,
  type RuntimeChannelAdapterRegistry,
} from '@aeostudio/application/channels-publishing';
import {
  encodeWordPressDraftTarget,
  encodeWordPressSiteAuthorizationTarget,
  wordpressAuthorizationTargetFor,
  wordpressRequiredScopesFor,
} from '@aeostudio/contracts/channels';
import type {
  ChannelAuthorizationEligibility,
  ChannelPackageRecord,
  ChannelRegistryEntry,
} from '@aeostudio/domain/channels-publishing';
import { describe, expect, test, vi } from 'vitest';

const tenantId = '00000000-0000-7000-8000-000000001201';
const workspaceId = '00000000-0000-7000-8000-000000001202';
const adapterVersionId = '00000000-0000-7000-8000-000000001203';
const packageId = '00000000-0000-7000-8000-000000001204';
const context = {
  tenantId,
  workspaceId,
  actorUserId: '00000000-0000-7000-8000-000000001205',
  membershipId: '00000000-0000-7000-8000-000000001206',
  role: 'PUBLISHER' as const,
};

const channelPackage: ChannelPackageRecord = {
  id: packageId,
  tenantId,
  workspaceId,
  packageRevision: 1,
  channel: {
    definitionId: '00000000-0000-7000-8000-000000001207',
    channelKey: 'wordpress-woocommerce-draft',
  },
  transformer: { key: 'generic-web-package', version: '1.0.0' },
  packageSchemaVersion: '1.0.0',
  artifact: {
    artifactId: '00000000-0000-7000-8000-000000001208',
    artifactRevisionId: '00000000-0000-7000-8000-000000001209',
    revision: 1,
    contentHash: 'a'.repeat(64),
    type: 'DEFINITION_PRODUCT',
    locale: 'en-US',
    market: 'US',
    methodPolicyVersion: 'fixture-v1',
  },
  manifest: { schemaVersion: '1.0.0', files: [], assetRefs: [], claimSourceMap: [] },
  packageChecksum: 'b'.repeat(64),
  payloadObjectRef: 'memory://task-12-package',
  createdByUserId: context.actorUserId,
  createdAt: '2026-07-21T00:00:00.000Z',
};

const allDeclaredScopes = [
  'media:write',
  'pages:write',
  'posts:write',
  'woocommerce:products:write',
];

const registryEntry: ChannelRegistryEntry = {
  id: channelPackage.channel.definitionId,
  channelKey: channelPackage.channel.channelKey,
  displayName: 'WordPress / WooCommerce Draft',
  status: 'AVAILABLE',
  unavailableReason: null,
  packageTransformerKey: 'generic-web-package',
  packageSchemaVersion: '1.0.0',
  adapterVersions: [
    {
      id: adapterVersionId,
      adapterKey: 'wordpress-woocommerce-draft',
      adapterVersion: '1.0.0',
      enabled: true,
      disabledReason: null,
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
      requiredScopes: allDeclaredScopes,
      termsVersion: 'wordpress-test-terms-v1',
      termsStatus: 'ALLOWED',
      processingRegion: 'in-process-test-runtime',
      retentionPolicy: 'No credential or package retention.',
      trainingPolicy: 'No training.',
      subprocessors: [],
      ratePolicy: { mode: 'deterministic-test-only' },
    },
  ],
};

function pageTarget(slug: string): string {
  return encodeWordPressDraftTarget({
    schemaVersion: 'wordpress-draft-target.v1',
    siteUrl: 'https://cms.example.test/blog',
    authMode: 'APPLICATION_PASSWORD',
    destination: { kind: 'PAGE', operation: 'CREATE', slug },
  });
}

function makeRuntimeAdapter(): PublicationAdapter {
  return {
    adapterKey: 'wordpress-woocommerce-draft',
    adapterVersion: '1.0.0',
    describe: () => ({
      adapterKey: 'wordpress-woocommerce-draft',
      adapterVersion: '1.0.0',
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
      requiredScopes: allDeclaredScopes,
      termsVersion: 'wordpress-test-terms-v1',
      processingRegion: 'in-process-test-runtime',
      retentionPolicy: 'No credential or package retention.',
      trainingPolicy: 'No training.',
      subprocessors: [],
      ratePolicy: { mode: 'deterministic-test-only' },
    }),
    authorizationTargetFor: wordpressAuthorizationTargetFor,
    requiredScopesFor: ({ target, channelPackage: exactPackage }) =>
      wordpressRequiredScopesFor({ target, assetRefs: exactPackage.manifest.assetRefs }),
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

describe('Task 12 WordPress site authorization eligibility', () => {
  test('one site authorization covers multiple page slugs with page-only scope', async () => {
    const siteAuthorizationTarget = encodeWordPressSiteAuthorizationTarget({
      schemaVersion: 'wordpress-site-auth.v1',
      siteUrl: 'https://cms.example.test/blog',
      authMode: 'APPLICATION_PASSWORD',
    });
    const authorization: ChannelAuthorizationEligibility = {
      id: '00000000-0000-7000-8000-000000001210',
      tenantId,
      workspaceId,
      adapterVersionId,
      status: 'ACTIVE',
      grantedScopes: ['pages:write'],
      acceptedTermsVersion: 'wordpress-test-terms-v1',
      target: siteAuthorizationTarget,
      expiresAt: '2030-01-01T00:00:00.000Z',
      validationStatus: 'VERIFIED',
      validationSnapshot: {
        actualTarget: siteAuthorizationTarget,
        actualScopes: ['pages:write'],
        acceptedTermsVersion: 'wordpress-test-terms-v1',
        validatedAt: '2026-07-20T23:00:00.000Z',
        validUntil: '2030-01-01T00:00:00.000Z',
      },
      validationFailureCode: null,
      createdByUserId: context.actorUserId,
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    };
    const findForTarget = vi.fn<ChannelAuthorizationStore['findForTarget']>((input) =>
      Promise.resolve(input.target === siteAuthorizationTarget ? authorization : null),
    );
    const runtimeAdapter = makeRuntimeAdapter();
    const service = new PublicationEligibilityService(
      {
        verifyForPublication: () =>
          Promise.resolve({ outcome: 'SUCCEEDED' as const, context, package: channelPackage }),
      } as unknown as ChannelPackageService,
      {
        listEntries: () => Promise.resolve([registryEntry]),
      } satisfies ChannelRegistryStore,
      { findForTarget } as unknown as ChannelAuthorizationStore,
      {
        resolve: () => runtimeAdapter,
      } satisfies RuntimeChannelAdapterRegistry,
      { resolveTenantContext: () => Promise.resolve(context) },
      { now: () => new Date('2026-07-21T00:00:00.000Z') },
    );

    for (const slug of ['approved-first-page', 'approved-second-page']) {
      const target = pageTarget(slug);
      await expect(
        service.check({
          actorSubject: 'publisher-subject',
          tenantId,
          workspaceId,
          channelPackageId: packageId,
          adapterVersionId,
          target,
          expectedPackageChecksum: channelPackage.packageChecksum,
        }),
      ).resolves.toMatchObject({
        outcome: 'READY',
        authorization: { id: authorization.id, target: siteAuthorizationTarget },
      });
    }
    expect(findForTarget).toHaveBeenCalledTimes(2);
    expect(findForTarget.mock.calls.map(([input]) => input.target)).toEqual([
      siteAuthorizationTarget,
      siteAuthorizationTarget,
    ]);
  });
});
