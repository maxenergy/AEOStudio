import {
  PublicationEligibilityService,
  type ChannelAuthorizationStore,
  type ChannelPackageService,
  type ChannelRegistryStore,
  type PublicationAdapter,
  type RuntimeChannelAdapterRegistry,
} from '@aeostudio/application/channels-publishing';
import type {
  ChannelAuthorizationEligibility,
  ChannelPackageRecord,
  ChannelRegistryEntry,
} from '@aeostudio/domain/channels-publishing';
import { describe, expect, test } from 'vitest';

const tenantId = '00000000-0000-7000-8000-00000000a001';
const workspaceId = '00000000-0000-7000-8000-00000000a002';
const adapterVersionId = '00000000-0000-7000-8000-00000000a003';
const packageId = '00000000-0000-7000-8000-00000000a004';
const actorUserId = '00000000-0000-7000-8000-00000000a005';
const now = new Date('2026-07-24T03:00:00.000Z');
const target = 'fixture://provider-valid/target';
const termsVersion = 'provider-terms-v1';
const requiredScopes = ['content:write'];

const context = {
  tenantId,
  workspaceId,
  actorUserId,
  membershipId: '00000000-0000-7000-8000-00000000a006',
  role: 'PUBLISHER' as const,
};

const ownedAdapters = [
  'git-pull-request',
  'wordpress-woocommerce-draft',
  'shopify-draft',
  'signed-webhook',
] as const;

describe('provider-validated Channel authorization eligibility', () => {
  test.each(ownedAdapters)(
    '%s remains EXPORT_ONLY while its durable authorization is pending provider validation',
    async (adapterKey) => {
      const authorization = authorizationFixture({
        validationStatus: 'PENDING_VALIDATION',
        validationSnapshot: null,
      });
      const service = eligibilityService(adapterKey, authorization);

      await expect(
        service.check({
          actorSubject: 'publisher-subject',
          sessionToken: 'authenticated-session',
          tenantId,
          workspaceId,
          channelPackageId: packageId,
          adapterVersionId,
          target,
          expectedPackageChecksum: 'b'.repeat(64),
        }),
      ).resolves.toMatchObject({
        outcome: 'EXPORT_ONLY',
        reasons: [
          expect.objectContaining({
            code: 'AUTHORIZATION_VALIDATION_PENDING',
          }),
        ],
      });
    },
  );

  test.each(ownedAdapters)(
    '%s accepts only a fresh VERIFIED snapshot bound to the actual target, scopes and terms',
    async (adapterKey) => {
      const authorization = authorizationFixture({
        validationStatus: 'VERIFIED',
        validationSnapshot: {
          actualTarget: target,
          actualScopes: requiredScopes,
          acceptedTermsVersion: termsVersion,
          validatedAt: '2026-07-24T02:55:00.000Z',
          validUntil: '2026-07-24T03:55:00.000Z',
        },
      });

      await expect(
        eligibilityService(adapterKey, authorization).check({
          actorSubject: 'publisher-subject',
          sessionToken: 'authenticated-session',
          tenantId,
          workspaceId,
          channelPackageId: packageId,
          adapterVersionId,
          target,
          expectedPackageChecksum: 'b'.repeat(64),
        }),
      ).resolves.toMatchObject({
        outcome: 'READY',
        authorization: {
          id: authorization.id,
          validationStatus: 'VERIFIED',
        },
      });
    },
  );

  test.each([
    {
      label: 'expired validation window',
      snapshot: {
        actualTarget: target,
        actualScopes: requiredScopes,
        acceptedTermsVersion: termsVersion,
        validatedAt: '2026-07-24T01:00:00.000Z',
        validUntil: '2026-07-24T03:00:00.000Z',
      },
    },
    {
      label: 'rotated credential target',
      snapshot: {
        actualTarget: 'fixture://provider-valid/rotated-target',
        actualScopes: requiredScopes,
        acceptedTermsVersion: termsVersion,
        validatedAt: '2026-07-24T02:55:00.000Z',
        validUntil: '2026-07-24T03:55:00.000Z',
      },
    },
    {
      label: 'provider scope loss',
      snapshot: {
        actualTarget: target,
        actualScopes: [],
        acceptedTermsVersion: termsVersion,
        validatedAt: '2026-07-24T02:55:00.000Z',
        validUntil: '2026-07-24T03:55:00.000Z',
      },
    },
    {
      label: 'changed provider terms',
      snapshot: {
        actualTarget: target,
        actualScopes: requiredScopes,
        acceptedTermsVersion: 'superseded-terms',
        validatedAt: '2026-07-24T02:55:00.000Z',
        validUntil: '2026-07-24T03:55:00.000Z',
      },
    },
  ])('fails closed for $label', async ({ snapshot }) => {
    const authorization = authorizationFixture({
      validationStatus: 'VERIFIED',
      validationSnapshot: snapshot,
    });

    const result = await eligibilityService('git-pull-request', authorization).check({
      actorSubject: 'publisher-subject',
      sessionToken: 'authenticated-session',
      tenantId,
      workspaceId,
      channelPackageId: packageId,
      adapterVersionId,
      target,
      expectedPackageChecksum: 'b'.repeat(64),
    });
    expect(result.outcome).toBe('EXPORT_ONLY');
    if (result.outcome !== 'EXPORT_ONLY') throw new Error('EXPORT_ONLY_REQUIRED');
    expect(result.reasons[0]?.code).toMatch(/^AUTHORIZATION_/u);
  });
});

function authorizationFixture(
  validation: Pick<ChannelAuthorizationEligibility, 'validationStatus' | 'validationSnapshot'>,
): ChannelAuthorizationEligibility {
  return {
    id: '00000000-0000-7000-8000-00000000a007',
    tenantId,
    workspaceId,
    adapterVersionId,
    status: 'ACTIVE',
    grantedScopes: requiredScopes,
    acceptedTermsVersion: termsVersion,
    target,
    expiresAt: '2026-07-25T03:00:00.000Z',
    createdByUserId: actorUserId,
    createdAt: '2026-07-24T02:50:00.000Z',
    updatedAt: '2026-07-24T02:50:00.000Z',
    ...validation,
  };
}

function eligibilityService(
  adapterKey: (typeof ownedAdapters)[number],
  authorization: ChannelAuthorizationEligibility,
): PublicationEligibilityService {
  const channelPackage = packageFixture(adapterKey);
  const adapter = runtimeAdapter(adapterKey);
  const registry = registryFixture(adapterKey, adapter);
  return new PublicationEligibilityService(
    {
      verifyForPublication: () =>
        Promise.resolve({ outcome: 'SUCCEEDED' as const, context, package: channelPackage }),
    } as unknown as ChannelPackageService,
    { listEntries: () => Promise.resolve([registry]) } satisfies ChannelRegistryStore,
    {
      findForTarget: () => Promise.resolve(authorization),
    } as unknown as ChannelAuthorizationStore,
    { resolve: () => adapter } satisfies RuntimeChannelAdapterRegistry,
    { resolveTenantContext: () => Promise.resolve(context) },
    { now: () => now },
  );
}

function runtimeAdapter(adapterKey: (typeof ownedAdapters)[number]): PublicationAdapter {
  const descriptor = {
    adapterKey,
    adapterVersion: '1.0.0',
    capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
    requiredScopes,
    termsVersion,
    processingRegion: 'provider-controlled',
    retentionPolicy: 'provider policy',
    trainingPolicy: 'no training',
    subprocessors: [],
    ratePolicy: { mode: 'provider' },
  };
  return {
    adapterKey,
    adapterVersion: descriptor.adapterVersion,
    authorizationTargetFor: () => target,
    requiredScopesFor: () => requiredScopes,
    describe: () => descriptor,
    validateAuthorization: () => Promise.resolve({ outcome: 'VALID' }),
    preview: ({ channelPackage, payload }) => ({
      packageChecksum: channelPackage.packageChecksum,
      files: payload.files,
    }),
    publish: () => Promise.resolve({ outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'NOT_USED' }),
    reconcile: () => Promise.resolve({ outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'NOT_USED' }),
  };
}

function registryFixture(
  adapterKey: (typeof ownedAdapters)[number],
  adapter: PublicationAdapter,
): ChannelRegistryEntry {
  const descriptor = adapter.describe();
  return {
    id: '00000000-0000-7000-8000-00000000a008',
    channelKey: adapterKey,
    displayName: adapterKey,
    status: 'AVAILABLE',
    unavailableReason: null,
    packageTransformerKey: 'generic-web-package',
    packageSchemaVersion: '1.0.0',
    adapterVersions: [
      {
        id: adapterVersionId,
        adapterKey,
        adapterVersion: descriptor.adapterVersion,
        enabled: true,
        disabledReason: null,
        capabilities: descriptor.capabilities,
        requiredScopes: descriptor.requiredScopes,
        termsVersion: descriptor.termsVersion,
        termsStatus: 'ALLOWED',
        processingRegion: descriptor.processingRegion,
        retentionPolicy: descriptor.retentionPolicy,
        trainingPolicy: descriptor.trainingPolicy,
        subprocessors: descriptor.subprocessors,
        ratePolicy: descriptor.ratePolicy,
      },
    ],
  };
}

function packageFixture(adapterKey: (typeof ownedAdapters)[number]): ChannelPackageRecord {
  return {
    id: packageId,
    tenantId,
    workspaceId,
    packageRevision: 1,
    channel: {
      definitionId: '00000000-0000-7000-8000-00000000a008',
      channelKey: adapterKey,
    },
    transformer: { key: 'generic-web-package', version: '1.0.0' },
    packageSchemaVersion: '1.0.0',
    artifact: {
      artifactId: '00000000-0000-7000-8000-00000000a009',
      artifactRevisionId: '00000000-0000-7000-8000-00000000a010',
      revision: 1,
      contentHash: 'a'.repeat(64),
      type: 'DEFINITION_PRODUCT',
      locale: 'en-US',
      market: 'US',
      methodPolicyVersion: 'fixture-v1',
    },
    manifest: { schemaVersion: '1.0.0', files: [], assetRefs: [], claimSourceMap: [] },
    packageChecksum: 'b'.repeat(64),
    payloadObjectRef: 'memory://provider-validation-package',
    createdByUserId: actorUserId,
    createdAt: '2026-07-24T02:00:00.000Z',
  };
}
