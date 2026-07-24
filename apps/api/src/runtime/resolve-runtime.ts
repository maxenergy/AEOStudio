import { OpenIdClientAdapter } from '@aeostudio/adapters/identity';
import { createNodeSafeSiteOwnershipVerifier } from '@aeostudio/adapters/crawler';
import { InMemorySecretLifecycleStore } from '@aeostudio/adapters/secrets';
import {
  DurableWorkloadObjectStorage,
  FakePrivacyObjectStorage,
} from '@aeostudio/adapters/storage';
import {
  createTenantDataBrokerClientGateway,
  createTenantDataBrokerNodeHttpsClientTransport,
  parseTenantDataBrokerKeyRing,
  TenantDataBrokerHttpClient,
} from '@aeostudio/adapters/tenant-data-broker';
import {
  InMemoryArtifactPayloadStore,
  InMemoryChannelPackagePayloadStore,
} from '@aeostudio/adapters/generation';
import {
  createProductionPublicationAdapterRegistry,
  FakeAmbiguousPublicationAdapter,
  GitPullRequestPublicationAdapter,
  GitPullRequestRuntimeAdapter,
  ShopifyDraftPublicationAdapter,
  ShopifyDraftRuntimeAdapter,
  HttpsSignedWebhookEndpointOwnershipVerifier,
  NodeSignedWebhookDnsResolver,
  NodeSignedWebhookHttpsTransport,
  SignedWebhookPublicationAdapter,
  VersionedFakeGitProvider,
  VersionedFakeShopifyAdminApi,
  VersionedFakeWebhookReceiver,
  VersionedFakeWordPressServer,
  WordPressWooCommerceDraftPublicationAdapter,
  WordPressWooCommerceDraftRuntimeAdapter,
} from '@aeostudio/adapters/publication';
import {
  createReviewedManualMeasurementImportAdapterRegistry,
  InMemoryMeasurementRawEvidenceStore,
} from '@aeostudio/application/measurement';
import {
  AesGcmSessionCipher,
  PostgresAuthStore,
  PostgresArtifactStore,
  PostgresChannelAuthorizationStore,
  PostgresChannelPackageStore,
  PostgresChannelRegistryStore,
  PostgresPublicationCommandStore,
  PostgresPublicationQueryStore,
  PostgresPublicationRemoteStatusRefreshStore,
  PostgresSignedWebhookEndpointVerificationStore,
  PostgresContentPlanningStore,
  PostgresEvidenceClaimStore,
  PostgresExperimentStore,
  PostgresJobBudgetStore,
  PostgresManualMeasurementImportStore,
  PostgresMeasurementRawEvidenceStore,
  PostgresMeasurementStore,
  PostgresProfileOfferingStore,
  PostgresPrivacyAuditStore,
  PostgresWorkloadObjectWriteIntentStore,
  PostgresPromptResearchStore,
  PostgresSiteCrawlStore,
  PostgresTenantDataCapabilityIssuer,
  PostgresTenancyStore,
} from '@aeostudio/db';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import type { ApiAppOptions } from '../app.module.js';
import { InMemoryArtifactLineageValidator } from '../artifacts/in-memory-artifact-lineage-validator.js';
import { InMemoryArtifactStore } from '../artifacts/in-memory-artifact-store.js';
import { InMemoryAuthStore } from '../auth/auth-store.memory.js';
import { InMemoryChannelAuthorizationStore } from '../channels/in-memory-channel-authorization-store.js';
import { InMemoryChannelRegistryStore } from '../channels/in-memory-channel-registry-store.js';
import { InMemoryChannelPackageStore } from '../channels/in-memory-channel-package-store.js';
import {
  IN_MEMORY_ATOMIC_EFFECT_RUNNER,
  InMemoryPublicationStore,
} from '../channels/in-memory-publication-store.js';
import { InMemorySignedWebhookEndpointVerificationStore } from '../channels/in-memory-signed-webhook-endpoint-verification-store.js';
import { InMemoryEvidenceClaimStore } from '../claims/in-memory-evidence-claim-store.js';
import { InMemoryEvidenceObjectStore } from '../claims/in-memory-evidence-object-store.js';
import { InMemoryContentPlanningStore } from '../content-plans/in-memory-content-planning-store.js';
import { InMemoryExperimentStore } from '../experiments/in-memory-experiment-store.js';
import { InMemoryJobBudgetStore } from '../jobs/in-memory-job-budget-store.js';
import {
  createFakeMeasurementProcessor,
  createFakeMeasurementSurfaceAdapters,
} from '../measurement/fake-measurement-runtime.js';
import { InMemoryMeasurementStore } from '../measurement/in-memory-measurement-store.js';
import { InMemoryManualMeasurementImportStore } from '../measurement/in-memory-manual-measurement-import-store.js';
import { InMemoryProfileOfferingStore } from '../profile-offering/in-memory-profile-offering-store.js';
import { InMemoryPrivacyAuditStore } from '../privacy/in-memory-privacy-audit-store.js';
import { InMemoryAuditSink } from '../privacy/in-memory-audit-sink.js';
import { HmacDeletionReceiptTokenService } from '../privacy/deletion-receipt-token.js';
import { InMemoryPromptResearchStore } from '../prompts/in-memory-prompt-research-store.js';
import { InMemorySiteCrawlStore } from '../sites/in-memory-site-crawl-store.js';
import { FakeSiteOwnershipVerifier } from '../sites/fake-site-ownership-verifier.js';
import { InMemoryTenancyStore } from '../tenants/in-memory-tenancy-store.js';

export interface ResolvedApiRuntime {
  cleanup: () => Promise<void>;
  options: ApiAppOptions;
  components: { databasePool?: Pool };
}

export interface ApiRuntimeDependencies {
  createTenantDataBrokerClientGateway?: typeof createTenantDataBrokerClientGateway;
  createSiteOwnershipVerifier?: typeof createNodeSafeSiteOwnershipVerifier;
}

const DEFAULT_API_RUNTIME_DEPENDENCIES: ApiRuntimeDependencies = {
  createTenantDataBrokerClientGateway,
  createSiteOwnershipVerifier: createNodeSafeSiteOwnershipVerifier,
};

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required outside test/fake auth mode.`);
  }
  return value;
}

function requireDatabasePoolMax(name: string): number {
  const value = requireEnvironment(name);
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name}_INVALID`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 64) throw new Error(`${name}_INVALID`);
  return parsed;
}

export async function resolveApiRuntime(
  input: ApiAppOptions,
  dependencies: ApiRuntimeDependencies = DEFAULT_API_RUNTIME_DEPENDENCIES,
): Promise<ResolvedApiRuntime> {
  const fakeMode = process.env.AEOSTUDIO_AUTH_MODE === 'fake';
  const fakeAdapterMode = process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE === 'fake';
  const fakeGitProviderMode = process.env.AEOSTUDIO_GIT_PROVIDER_MODE === 'fake';
  const fakeWordPressProviderMode = process.env.AEOSTUDIO_WORDPRESS_PROVIDER_MODE === 'fake';
  const fakeShopifyProviderMode = process.env.AEOSTUDIO_SHOPIFY_PROVIDER_MODE === 'fake';
  const fakeWebhookProviderMode = process.env.AEOSTUDIO_WEBHOOK_PROVIDER_MODE === 'fake';
  const fakeMeasurementProviderMode = process.env.AEOSTUDIO_MEASUREMENT_PROVIDER_MODE === 'fake';
  const fakeRuntimeRequested =
    fakeMode ||
    fakeAdapterMode ||
    fakeGitProviderMode ||
    fakeWordPressProviderMode ||
    fakeShopifyProviderMode ||
    fakeWebhookProviderMode ||
    fakeMeasurementProviderMode;
  const fakeRuntimeEnvironmentAllowed =
    process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
  if (
    fakeRuntimeRequested &&
    (!fakeRuntimeEnvironmentAllowed || process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME !== 'true')
  ) {
    throw new Error('FAKE_RUNTIME_FORBIDDEN_IN_PRODUCTION');
  }
  const fakePublicationMode = fakeMode && fakeAdapterMode;
  const fakeGitMode = fakePublicationMode && fakeGitProviderMode;
  const fakeWordPressMode = fakePublicationMode && fakeWordPressProviderMode;
  const fakeShopifyMode = fakePublicationMode && fakeShopifyProviderMode;
  const fakeWebhookMode = fakePublicationMode && fakeWebhookProviderMode;
  const fakeMeasurementMode = fakeMode && fakeMeasurementProviderMode;
  const testMode = process.env.NODE_ENV === 'test';
  const ephemeralAllowed = fakeMode || testMode || input.store !== undefined;
  const productionRuntime = ephemeralAllowed
    ? null
    : {
        databaseUrl: requireEnvironment('DATABASE_URL'),
        databasePoolMax: requireDatabasePoolMax('API_DATABASE_POOL_MAX'),
        encryptionKey: Buffer.from(requireEnvironment('SESSION_ENCRYPTION_KEY'), 'base64url'),
      };
  let pool: Pool | undefined;
  let options = { ...input };
  const fakeRuntimeClock = options.clock ?? { now: () => new Date() };
  const fakeAuditSink = fakeMode ? new InMemoryAuditSink(fakeRuntimeClock) : undefined;
  const fakeSecretLifecycleStore = fakeMode
    ? (options.fakeSecretLifecycleStore ?? new InMemorySecretLifecycleStore(fakeRuntimeClock))
    : undefined;
  if (options.deletionReceiptTokenService === undefined) {
    const configuredKey = process.env.DELETION_RECEIPT_SIGNING_KEY;
    const signingKey =
      configuredKey === undefined
        ? fakeMode || testMode
          ? Buffer.from('aeostudio-task-17-test-receipt-key')
          : Buffer.from(requireEnvironment('DELETION_RECEIPT_SIGNING_KEY'), 'base64url')
        : Buffer.from(configuredKey, 'base64url');
    options = {
      ...options,
      deletionReceiptTokenService: new HmacDeletionReceiptTokenService({
        signingKey,
        clock: fakeRuntimeClock,
      }),
    };
  }

  if (fakeMode && options.store === undefined) {
    options = { ...options, store: new InMemoryAuthStore(fakeAuditSink) };
  }
  if (fakeMode && options.tenancyStore === undefined) {
    options = { ...options, tenancyStore: new InMemoryTenancyStore(fakeAuditSink) };
  }
  if (fakeMode && options.channelRegistryStore === undefined) {
    options = {
      ...options,
      channelRegistryStore: new InMemoryChannelRegistryStore(
        fakePublicationMode,
        fakeGitMode,
        fakeWordPressMode,
        fakeShopifyMode,
        fakeWebhookMode,
      ),
    };
  }
  if (fakeMode && options.signedWebhookEndpointVerificationStore === undefined) {
    options = {
      ...options,
      signedWebhookEndpointVerificationStore: new InMemorySignedWebhookEndpointVerificationStore(),
    };
  }
  if (fakeMode && options.channelPackagePayloadStore === undefined) {
    const channelPackagePayloads = new InMemoryChannelPackagePayloadStore();
    options = {
      ...options,
      channelPackagePayloadStore: channelPackagePayloads,
      channelPackagePayloadReader: channelPackagePayloads,
    };
  }
  if (
    options.channelPackagePayloadReader === undefined &&
    options.channelPackagePayloadStore instanceof InMemoryChannelPackagePayloadStore
  ) {
    options = {
      ...options,
      channelPackagePayloadReader: options.channelPackagePayloadStore,
    };
  }
  if (fakeMode && options.profileOfferingStore === undefined) {
    options = {
      ...options,
      profileOfferingStore: new InMemoryProfileOfferingStore(fakeRuntimeClock, fakeAuditSink),
    };
  }
  if (fakeMode && options.evidenceClaimStore === undefined) {
    options = { ...options, evidenceClaimStore: new InMemoryEvidenceClaimStore(fakeAuditSink) };
  }
  if (fakeMode && options.evidenceObjectStore === undefined) {
    options = { ...options, evidenceObjectStore: new InMemoryEvidenceObjectStore() };
  }
  if (fakeMode && options.promptResearchStore === undefined) {
    options = { ...options, promptResearchStore: new InMemoryPromptResearchStore() };
  }
  if (fakeMode && options.measurementStore === undefined) {
    options = { ...options, measurementStore: new InMemoryMeasurementStore() };
  }
  if (fakeMode && options.measurementRawEvidenceStore === undefined) {
    options = {
      ...options,
      measurementRawEvidenceStore: new InMemoryMeasurementRawEvidenceStore(),
    };
  }
  if (fakeMode && options.manualMeasurementImportStore === undefined) {
    options = {
      ...options,
      manualMeasurementImportStore: new InMemoryManualMeasurementImportStore(),
    };
  }
  if (fakeMeasurementMode && options.measurementSurfaceAdapters === undefined) {
    const fixtureAdapters = createFakeMeasurementSurfaceAdapters({
      clock: options.clock ?? { now: () => new Date() },
    });
    const manualAdapters =
      options.manualMeasurementImportStore === undefined
        ? undefined
        : createReviewedManualMeasurementImportAdapterRegistry(
            options.manualMeasurementImportStore,
            options.clock ?? { now: () => new Date() },
          );
    options = {
      ...options,
      measurementSurfaceAdapters: {
        resolve(providerKey, surfaceKey, adapterVersion) {
          return (
            fixtureAdapters.resolve(providerKey, surfaceKey, adapterVersion) ??
            manualAdapters?.resolve(providerKey, surfaceKey, adapterVersion) ??
            null
          );
        },
      },
    };
  }
  if (fakeMode && options.contentPlanningStore === undefined) {
    options = { ...options, contentPlanningStore: new InMemoryContentPlanningStore() };
  }
  if (fakeMode && options.artifactStore === undefined) {
    options = { ...options, artifactStore: new InMemoryArtifactStore(fakeAuditSink) };
  }
  if (fakeMode && options.channelPackageStore === undefined) {
    if (!(options.artifactStore instanceof InMemoryArtifactStore)) {
      throw new Error('IN_MEMORY_CHANNEL_PACKAGE_CURRENTNESS_FENCE_REQUIRED');
    }
    const artifacts = options.artifactStore;
    const prompts =
      options.promptResearchStore instanceof InMemoryPromptResearchStore
        ? options.promptResearchStore
        : null;
    const claims =
      options.evidenceClaimStore instanceof InMemoryEvidenceClaimStore
        ? options.evidenceClaimStore
        : null;
    const lineage =
      prompts === null || claims === null
        ? null
        : new InMemoryArtifactLineageValidator({
            prompts,
            claims,
            clock: fakeRuntimeClock,
          });
    options = {
      ...options,
      channelPackageStore: new InMemoryChannelPackageStore((input) => {
        if (lineage === null) return false;
        const revision = artifacts.findCurrentApprovedRevisionNow({
          tenantId: input.context.tenantId,
          workspaceId: input.context.workspaceId,
          artifactId: input.artifact.artifactId,
          artifactRevisionId: input.artifact.artifactRevisionId,
          revision: input.artifact.revision,
          contentHash: input.artifact.contentHash,
        });
        return revision !== null && lineage.isCurrent({ context: input.context, revision });
      }),
    };
  }
  if (fakeMode && options.artifactPayloadStore === undefined) {
    const artifactPayloads = new InMemoryArtifactPayloadStore();
    options = {
      ...options,
      artifactPayloadStore: artifactPayloads,
      artifactPayloadReader: artifactPayloads,
    };
  }
  if (
    options.artifactPayloadReader === undefined &&
    options.artifactPayloadStore instanceof InMemoryArtifactPayloadStore
  ) {
    options = {
      ...options,
      artifactPayloadReader: options.artifactPayloadStore,
    };
  }
  if (fakeMode && options.siteCrawlStore === undefined) {
    options = { ...options, siteCrawlStore: new InMemorySiteCrawlStore(fakeAuditSink) };
  }
  if (fakeMode && options.jobBudgetStore === undefined) {
    const siteStore =
      options.siteCrawlStore instanceof InMemorySiteCrawlStore ? options.siteCrawlStore : undefined;
    const contentPlanStore =
      options.contentPlanningStore instanceof InMemoryContentPlanningStore
        ? options.contentPlanningStore
        : undefined;
    const artifactStore =
      options.artifactStore instanceof InMemoryArtifactStore ? options.artifactStore : undefined;
    const artifactPayloadStore = options.artifactPayloadStore;
    options = {
      ...options,
      jobBudgetStore: new InMemoryJobBudgetStore(
        async (job) => {
          siteStore?.recordCompletedCrawl(job);
          await contentPlanStore?.recordCompletedPlan(job);
          if (artifactPayloadStore !== undefined) {
            await artifactStore?.recordCompletedArtifact(job, artifactPayloadStore);
          }
        },
        fakeAuditSink,
        fakeRuntimeClock,
      ),
    };
  }
  if (
    fakeMeasurementMode &&
    options.jobBudgetStore instanceof InMemoryJobBudgetStore &&
    options.measurementStore instanceof InMemoryMeasurementStore &&
    options.measurementRawEvidenceStore instanceof InMemoryMeasurementRawEvidenceStore &&
    options.measurementSurfaceAdapters !== undefined
  ) {
    options.jobBudgetStore.registerMeasurementProcessor(
      createFakeMeasurementProcessor({
        store: options.measurementStore,
        rawEvidence: options.measurementRawEvidenceStore,
        adapters: options.measurementSurfaceAdapters,
        ids: { next: uuidv7 },
        clock: options.clock ?? { now: () => new Date() },
      }),
    );
  }
  if (fakeMode && options.siteOwnershipVerifier === undefined) {
    options = { ...options, siteOwnershipVerifier: new FakeSiteOwnershipVerifier() };
  }
  if (fakePublicationMode) {
    const customRuntimeChannelAdapters = options.runtimeChannelAdapters;
    const adapter = new FakeAmbiguousPublicationAdapter({
      adapterKey: 'fake-ambiguous',
      adapterVersion: 'v1',
      descriptor: {
        capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK'],
        requiredScopes: ['content:write'],
        termsVersion: 'test-terms-v1',
        processingRegion: 'in-process-test-runtime',
        retentionPolicy: 'No package or credential retention outside process memory.',
        trainingPolicy: 'No training.',
        subprocessors: [],
        ratePolicy: { mode: 'deterministic-test-only' },
      },
      authorizationValidator: (command) => command.secretValue.length > 0,
    });
    const gitProvider = fakeGitMode
      ? new VersionedFakeGitProvider({
          apiVersion: '2026-03-10',
          installation: {
            installationId: 'installation-tenant-a',
            repositories: ['tenant-owned/site-content'],
            scopes: ['contents:write', 'pull_requests:write', 'metadata:read'],
            token: 'fake-git-provider-token',
          },
          protectedBranches: [{ repository: 'tenant-owned/site-content', branch: 'main' }],
          symlinkPaths: [],
          log: () => undefined,
        })
      : undefined;
    if (gitProvider !== undefined) gitProvider.queuePullRequestFailure('TIMEOUT_AFTER_EFFECT');
    const gitAdapter =
      gitProvider === undefined
        ? undefined
        : new GitPullRequestRuntimeAdapter({
            adapterKey: 'git-pull-request',
            adapterVersion: '1.0.0',
            descriptor: {
              capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'PULL_REQUEST_STATUS'],
              requiredScopes: ['contents:write', 'pull_requests:write', 'metadata:read'],
              termsVersion: 'git-test-terms-v1',
              processingRegion: 'in-process-test-runtime',
              retentionPolicy: 'No credential or package retention outside process memory.',
              trainingPolicy: 'No training.',
              subprocessors: [],
              ratePolicy: { mode: 'deterministic-test-only' },
            },
            gitAdapter: new GitPullRequestPublicationAdapter({
              adapterKey: 'git-pull-request',
              adapterVersion: '1.0.0',
              providerApiVersion: '2026-03-10',
              provider: gitProvider,
              requiredScopes: ['contents:write', 'pull_requests:write', 'metadata:read'],
              allowedInstallationIds: ['installation-tenant-a'],
              allowedRepositories: ['tenant-owned/site-content'],
              allowedPathPrefixes: ['content/approved'],
            }),
          });
    const wordpressSiteOrigin = 'https://cms.example.test';
    const wordpressServer = fakeWordPressMode
      ? new VersionedFakeWordPressServer({
          apiVersion: 'wp/v2',
          siteOrigin: wordpressSiteOrigin,
          authorization: {
            mechanism: 'APPLICATION_PASSWORD',
            scopes: ['media:write', 'pages:write', 'posts:write', 'woocommerce:products:write'],
            credential: 'fake-wordpress-provider-credential',
          },
          woocommerceApiVersion: 'wc/v3',
          log: () => undefined,
        })
      : undefined;
    if (wordpressServer !== undefined) wordpressServer.queueFailure('TIMEOUT_AFTER_EFFECT');
    const wordpressAdapter =
      wordpressServer === undefined
        ? undefined
        : new WordPressWooCommerceDraftRuntimeAdapter({
            adapterKey: 'wordpress-woocommerce-draft',
            adapterVersion: '1.0.0',
            descriptor: {
              capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
              requiredScopes: [
                'media:write',
                'pages:write',
                'posts:write',
                'woocommerce:products:write',
              ],
              termsVersion: 'wordpress-test-terms-v1',
              processingRegion: 'in-process-test-runtime',
              retentionPolicy: 'No credential or package retention outside process memory.',
              trainingPolicy: 'No training.',
              subprocessors: [],
              ratePolicy: { mode: 'deterministic-test-only' },
            },
            draftAdapter: new WordPressWooCommerceDraftPublicationAdapter({
              adapterKey: 'wordpress-woocommerce-draft',
              adapterVersion: '1.0.0',
              providerApiVersion: 'wp/v2',
              server: wordpressServer,
              requiredScopes: [],
              allowedSiteOrigins: [wordpressSiteOrigin],
            }),
          });
    const shopifyAdminApiVersion = '2026-07';
    const shopifyDomain = 'tenant-a.myshopify.com';
    const shopifyAdminApi = fakeShopifyMode
      ? new VersionedFakeShopifyAdminApi({
          apiVersion: shopifyAdminApiVersion,
          shopDomain: shopifyDomain,
          authorization: {
            scopes: ['write_content', 'write_products'],
            accessToken: 'fake-shopify-provider-access-token',
          },
          log: () => undefined,
        })
      : undefined;
    if (shopifyAdminApi !== undefined) shopifyAdminApi.queueFailure('TIMEOUT_AFTER_EFFECT');
    const shopifyAdapter =
      shopifyAdminApi === undefined
        ? undefined
        : new ShopifyDraftRuntimeAdapter({
            adapterKey: 'shopify-draft',
            adapterVersion: '1.0.0',
            providerApiVersion: shopifyAdminApiVersion,
            supportedStableApiVersions: [shopifyAdminApiVersion],
            descriptor: {
              capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
              requiredScopes: ['write_content', 'write_products'],
              termsVersion: 'shopify-test-terms-v1',
              processingRegion: 'in-process-test-runtime',
              retentionPolicy: 'No credential or package retention outside process memory.',
              trainingPolicy: 'No training.',
              subprocessors: [],
              ratePolicy: {
                apiVersion: shopifyAdminApiVersion,
                mode: 'deterministic-test-only',
              },
            },
            draftAdapter: new ShopifyDraftPublicationAdapter({
              adapterKey: 'shopify-draft',
              adapterVersion: '1.0.0',
              providerApiVersion: shopifyAdminApiVersion,
              supportedStableApiVersions: [shopifyAdminApiVersion],
              api: shopifyAdminApi,
              requiredScopesByContentKind: {
                PAGE: ['write_content'],
                BLOG_ARTICLE: ['write_content'],
                PRODUCT: ['write_products'],
              },
              allowedShopDomains: [shopifyDomain],
            }),
          });
    const signedWebhookDeliveryUrl = 'https://receiver.example.test/v1/channel-packages';
    const signedWebhookReceiptUrl = 'https://receiver.example.test/v1/channel-package-receipts';
    const signedWebhookVerificationId = '14000000-0000-4000-8000-000000000014';
    const signedWebhookAddress = '93.184.216.34';
    const signedWebhookKeyId = 'e2e-primary-2026-07';
    const signedWebhookSigningMaterial = 'fake-signed-webhook-hmac-material-at-least-32-bytes';
    const signedWebhookSecretValue = JSON.stringify({
      schemaVersion: 'signed-webhook-key-ring.v1',
      activeKeyId: signedWebhookKeyId,
      keys: [
        {
          keyId: signedWebhookKeyId,
          algorithm: 'HMAC_SHA256',
          signingMaterial: signedWebhookSigningMaterial,
          validFrom: '2026-01-01T00:00:00.000Z',
          validUntil: null,
        },
      ],
    });
    const authorizationStore =
      options.channelAuthorizationStore ??
      new InMemoryChannelAuthorizationStore(
        {
          secrets: fakeSecretLifecycleStore ?? new InMemorySecretLifecycleStore(fakeRuntimeClock),
          secretValueForReference: (secretReference) =>
            fakeWebhookMode && secretReference.toLowerCase().includes('signed-webhook')
              ? signedWebhookSecretValue
              : 'fake-publication-secret',
          ...(testMode && process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME === 'true'
            ? {
                validation: {
                  mode: 'DETERMINISTIC_FAKE' as const,
                  nodeEnv: 'test' as const,
                  allowFakeRuntime: true as const,
                },
              }
            : {}),
        },
        fakeAuditSink,
      );
    const signedWebhookReceiver = fakeWebhookMode
      ? new VersionedFakeWebhookReceiver({
          deliveryUrl: signedWebhookDeliveryUrl,
          receiptUrl: signedWebhookReceiptUrl,
          endpointVerificationId: signedWebhookVerificationId,
          address: signedWebhookAddress,
          verificationKeys: [
            {
              keyId: signedWebhookKeyId,
              algorithm: 'HMAC_SHA256',
              verificationMaterial: signedWebhookSigningMaterial,
              validFrom: '2026-01-01T00:00:00.000Z',
              validUntil: null,
            },
          ],
          clock: options.clock ?? { now: () => new Date() },
          maxTimestampSkewSeconds: 300,
          log: () => undefined,
        })
      : undefined;
    if (signedWebhookReceiver !== undefined) {
      signedWebhookReceiver.queueFailure('TIMEOUT_AFTER_EFFECT');
    }
    const signedWebhookAdapter =
      signedWebhookReceiver === undefined
        ? undefined
        : new SignedWebhookPublicationAdapter({
            adapterKey: 'signed-webhook',
            adapterVersion: '1.0.0',
            descriptor: {
              capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
              requiredScopes: ['webhook:deliver'],
              termsVersion: 'signed-webhook-contract-v1',
              processingRegion: 'in-process-test-runtime',
              retentionPolicy: 'Receipts only; request bodies are not retained by the Adapter.',
              trainingPolicy: 'No training.',
              subprocessors: [],
              ratePolicy: {
                contractVersion: '1.0.0',
                mode: 'deterministic-test-only',
                signatureProfile: 'aeostudio-signed-webhook-v1',
              },
            },
            verifiedEndpoints: [
              {
                endpointUrl: signedWebhookDeliveryUrl,
                receiptUrl: signedWebhookReceiptUrl,
                endpointVerificationId: signedWebhookVerificationId,
                algorithm: 'HMAC_SHA256',
                keyId: signedWebhookKeyId,
              },
            ],
            resolver: {
              resolve: (hostname) =>
                hostname === 'receiver.example.test'
                  ? Promise.resolve([signedWebhookAddress])
                  : Promise.reject(new Error('FAKE_WEBHOOK_HOST_NOT_VERIFIED')),
            },
            transport: signedWebhookReceiver,
            clock: options.clock ?? { now: () => new Date() },
            nextNonce: () => uuidv7(),
            maxTimestampSkewSeconds: 300,
            timeoutMs: 5_000,
          });
    const fakeRuntimeChannelAdapters = {
      resolve(adapterKey: string, adapterVersion: string) {
        if (adapter.adapterKey === adapterKey && adapter.adapterVersion === adapterVersion) {
          return adapter;
        }
        if (gitAdapter?.adapterKey === adapterKey && gitAdapter.adapterVersion === adapterVersion) {
          return gitAdapter;
        }
        if (
          wordpressAdapter?.adapterKey === adapterKey &&
          wordpressAdapter.adapterVersion === adapterVersion
        ) {
          return wordpressAdapter;
        }
        if (
          signedWebhookAdapter?.adapterKey === adapterKey &&
          signedWebhookAdapter.adapterVersion === adapterVersion
        ) {
          return signedWebhookAdapter;
        }
        return shopifyAdapter?.adapterKey === adapterKey &&
          shopifyAdapter.adapterVersion === adapterVersion
          ? shopifyAdapter
          : null;
      },
    };
    const runtimeChannelAdapters = customRuntimeChannelAdapters ?? {
      resolve(adapterKey: string, adapterVersion: string) {
        return fakeRuntimeChannelAdapters.resolve(adapterKey, adapterVersion);
      },
    };
    const liveTenancy =
      options.tenancyStore instanceof InMemoryTenancyStore ? options.tenancyStore : null;
    const liveArtifacts =
      options.artifactStore instanceof InMemoryArtifactStore ? options.artifactStore : null;
    const liveRegistry =
      options.channelRegistryStore instanceof InMemoryChannelRegistryStore
        ? options.channelRegistryStore
        : null;
    const livePrompts =
      options.promptResearchStore instanceof InMemoryPromptResearchStore
        ? options.promptResearchStore
        : null;
    const liveClaims =
      options.evidenceClaimStore instanceof InMemoryEvidenceClaimStore
        ? options.evidenceClaimStore
        : null;
    const liveLineage =
      livePrompts === null || liveClaims === null
        ? null
        : new InMemoryArtifactLineageValidator({
            prompts: livePrompts,
            claims: liveClaims,
            clock: fakeRuntimeClock,
          });
    const publicationStore =
      options.publicationCommandStore === undefined &&
      options.publicationQueryStore === undefined &&
      options.jobBudgetStore instanceof InMemoryJobBudgetStore &&
      options.channelPackagePayloadStore !== undefined &&
      options.channelPackageStore !== undefined &&
      options.channelRegistryStore !== undefined &&
      options.tenancyStore !== undefined &&
      options.artifactStore !== undefined &&
      options.artifactPayloadStore !== undefined &&
      authorizationStore instanceof InMemoryChannelAuthorizationStore &&
      liveTenancy !== null &&
      liveArtifacts !== null &&
      liveRegistry !== null &&
      liveLineage !== null &&
      fakeSecretLifecycleStore !== undefined &&
      customRuntimeChannelAdapters === undefined
        ? new InMemoryPublicationStore({
            jobs: options.jobBudgetStore,
            packages: options.channelPackageStore,
            artifacts: options.artifactStore,
            publicationPackages: {
              readPublicationPackage: ({ access, expected }) =>
                access.publicationId.length === 0 || access.leaseToken.length === 0
                  ? Promise.resolve(null)
                  : (options.channelPackagePayloadStore?.get(expected.objectRef) ??
                    Promise.resolve(null)),
            },
            registry: options.channelRegistryStore,
            authorizations: authorizationStore,
            adapters: fakeRuntimeChannelAdapters,
            publicationSecrets: {
              readPublicationSecret: ({ access, expected }) =>
                access.publicationId.length === 0 || access.leaseToken.length === 0
                  ? Promise.reject(new Error('FAKE_PUBLICATION_ACCESS_INVALID'))
                  : (
                      fakeSecretLifecycleStore ?? new InMemorySecretLifecycleStore(fakeRuntimeClock)
                    ).getSecretValue(expected.secretReference),
            },
            ids: { next: uuidv7 },
            clock: options.clock ?? { now: () => new Date() },
            tenancy: options.tenancyStore,
            atomicEffectRunner: IN_MEMORY_ATOMIC_EFFECT_RUNNER,
            liveEffectState: {
              resolveTenantContext: (input) => liveTenancy.resolveTenantContextNow(input),
              isCurrentApprovedArtifact: (input) => liveArtifacts.isCurrentApprovedRevision(input),
              isCurrentApprovedLineage: ({ context, ...input }) => {
                const revision = liveArtifacts.findCurrentApprovedRevisionNow(input);
                return revision !== null && liveLineage.isCurrent({ context, revision });
              },
              listRegistryEntries: () => liveRegistry.listEntriesNow(),
              findAuthorization: (input) =>
                authorizationStore.findPublicationAuthorizationNow(input),
              secretValueMatches: (input) =>
                fakeSecretLifecycleStore.isActiveValue({
                  tenantId: input.tenantId,
                  secretReference: input.secretReference,
                  value: input.secretValue,
                }),
            },
            ...(fakeAuditSink === undefined ? {} : { audit: fakeAuditSink }),
          })
        : undefined;
    options = {
      ...options,
      channelAuthorizationStore: authorizationStore,
      runtimeChannelAdapters,
      ...(publicationStore === undefined
        ? {}
        : {
            publicationCommandStore: publicationStore,
            publicationQueryStore: publicationStore,
            publicationRemoteStatusRefreshStore: publicationStore,
          }),
    };
  }

  if (
    fakeMode &&
    options.experimentStore === undefined &&
    options.measurementStore instanceof InMemoryMeasurementStore &&
    options.publicationQueryStore instanceof InMemoryPublicationStore &&
    options.artifactStore instanceof InMemoryArtifactStore
  ) {
    options = {
      ...options,
      experimentStore: new InMemoryExperimentStore({
        measurements: options.measurementStore,
        publications: options.publicationQueryStore,
        artifacts: options.artifactStore,
        clock: options.clock ?? { now: () => new Date() },
      }),
    };
  }

  if (
    fakeMode &&
    options.privacyAuditStore === undefined &&
    options.store instanceof InMemoryAuthStore &&
    options.tenancyStore instanceof InMemoryTenancyStore &&
    options.jobBudgetStore instanceof InMemoryJobBudgetStore &&
    options.channelAuthorizationStore instanceof InMemoryChannelAuthorizationStore
  ) {
    const clock = options.clock ?? { now: () => new Date() };
    options = {
      ...options,
      privacyAuditStore: new InMemoryPrivacyAuditStore({
        auth: options.store,
        tenancy: options.tenancyStore,
        jobs: options.jobBudgetStore,
        authorizations: options.channelAuthorizationStore,
        objects: new FakePrivacyObjectStorage({ ids: { next: uuidv7 }, clock }),
        secrets:
          fakeSecretLifecycleStore ??
          options.fakeSecretLifecycleStore ??
          new InMemorySecretLifecycleStore(clock),
        clock,
        ...(fakeAuditSink === undefined ? {} : { audit: fakeAuditSink }),
        exportSources: [
          ...(options.profileOfferingStore instanceof InMemoryProfileOfferingStore
            ? [options.profileOfferingStore]
            : []),
          ...(options.evidenceClaimStore instanceof InMemoryEvidenceClaimStore
            ? [options.evidenceClaimStore]
            : []),
          ...(options.artifactStore instanceof InMemoryArtifactStore
            ? [options.artifactStore]
            : []),
          ...(options.measurementStore instanceof InMemoryMeasurementStore
            ? [options.measurementStore]
            : []),
          ...(options.publicationQueryStore instanceof InMemoryPublicationStore
            ? [options.publicationQueryStore]
            : []),
        ],
      }),
    };
  }

  if (productionRuntime !== null) {
    pool = new Pool({
      connectionString: productionRuntime.databaseUrl,
      max: productionRuntime.databasePoolMax,
    });
    const productionClock = options.clock ?? { now: () => new Date() };
    let tenantDataGateway;
    try {
      const signingKeys = parseTenantDataBrokerKeyRing(
        requireEnvironment('TENANT_DATA_BROKER_HMAC_KEY_RING'),
        productionClock,
      );
      const brokerEndpoint = requireEnvironment('TENANT_DATA_BROKER_ENDPOINT');
      const brokerAudience = requireEnvironment('TENANT_DATA_BROKER_AUDIENCE');
      if (new URL(brokerEndpoint).host !== brokerAudience) {
        throw new Error('TENANT_DATA_BROKER_ENDPOINT_AUDIENCE_MISMATCH');
      }
      const client = new TenantDataBrokerHttpClient({
        endpoint: brokerEndpoint,
        signingKey: signingKeys.current,
        clock: productionClock,
        nextNonce: uuidv7,
        transport: createTenantDataBrokerNodeHttpsClientTransport(),
      });
      tenantDataGateway = (
        dependencies.createTenantDataBrokerClientGateway ?? createTenantDataBrokerClientGateway
      )({
        issuer: new PostgresTenantDataCapabilityIssuer(pool),
        client,
        ids: { next: uuidv7 },
        clock: productionClock,
        buckets: {
          workload: requireEnvironment('ARTIFACT_BUCKET'),
          tenantExports: requireEnvironment('ARTIFACT_BUCKET'),
          auditEvidence: requireEnvironment('AUDIT_EVIDENCE_BUCKET'),
        },
        requestTimeoutMs: 5_000,
        expectedBucketOwner: requireEnvironment('AWS_ACCOUNT_ID'),
      });
    } catch (error: unknown) {
      await pool.end();
      throw error;
    }
    const durableWorkloadObjectStorage = new DurableWorkloadObjectStorage(
      tenantDataGateway,
      new PostgresWorkloadObjectWriteIntentStore(pool),
      {
        ids: { next: uuidv7 },
        clock: productionClock,
      },
    );
    const postgresManualImportStore = new PostgresManualMeasurementImportStore(pool);
    const signedWebhookEndpointVerifications =
      options.signedWebhookEndpointVerificationStore ??
      new PostgresSignedWebhookEndpointVerificationStore(pool);
    const signedWebhookEndpointOwnershipVerifier =
      options.signedWebhookEndpointOwnershipVerifier ??
      new HttpsSignedWebhookEndpointOwnershipVerifier({
        resolver: new NodeSignedWebhookDnsResolver(),
        transport: new NodeSignedWebhookHttpsTransport({ maxRequestBytes: 4_096 }),
      });
    const reviewedManualImportAdapters = createReviewedManualMeasurementImportAdapterRegistry(
      postgresManualImportStore,
      options.clock ?? { now: () => new Date() },
    );
    const configuredMeasurementAdapters = options.measurementSurfaceAdapters;
    options = {
      ...options,
      store: new PostgresAuthStore(pool, new AesGcmSessionCipher(productionRuntime.encryptionKey)),
      artifactStore: new PostgresArtifactStore(pool),
      artifactPayloadStore: durableWorkloadObjectStorage,
      artifactPayloadReader: tenantDataGateway,
      channelAuthorizationStore: new PostgresChannelAuthorizationStore(pool),
      channelPackageStore: new PostgresChannelPackageStore(pool),
      channelPackagePayloadStore: durableWorkloadObjectStorage.channelPackages(),
      channelPackagePayloadReader: tenantDataGateway,
      channelRegistryStore: new PostgresChannelRegistryStore(pool),
      signedWebhookEndpointVerificationStore: signedWebhookEndpointVerifications,
      signedWebhookEndpointOwnershipVerifier,
      runtimeChannelAdapters:
        options.runtimeChannelAdapters ??
        createProductionPublicationAdapterRegistry({
          signedWebhookEndpointVerifications,
        }),
      publicationCommandStore: new PostgresPublicationCommandStore(pool),
      publicationQueryStore: new PostgresPublicationQueryStore(pool),
      publicationRemoteStatusRefreshStore: new PostgresPublicationRemoteStatusRefreshStore(pool),
      contentPlanningStore: new PostgresContentPlanningStore(pool),
      evidenceClaimStore: new PostgresEvidenceClaimStore(pool),
      experimentStore: new PostgresExperimentStore(pool),
      jobBudgetStore: new PostgresJobBudgetStore(pool),
      measurementStore: new PostgresMeasurementStore(pool),
      measurementRawEvidenceStore: new PostgresMeasurementRawEvidenceStore(pool),
      manualMeasurementImportStore: postgresManualImportStore,
      measurementSurfaceAdapters: {
        resolve(providerKey, surfaceKey, adapterVersion) {
          return (
            configuredMeasurementAdapters?.resolve(providerKey, surfaceKey, adapterVersion) ??
            reviewedManualImportAdapters.resolve(providerKey, surfaceKey, adapterVersion)
          );
        },
      },
      profileOfferingStore: new PostgresProfileOfferingStore(pool),
      privacyAuditStore: new PostgresPrivacyAuditStore(pool, {
        privacyWriter: tenantDataGateway,
        tenantExportReader: tenantDataGateway,
      }),
      promptResearchStore: new PostgresPromptResearchStore(pool),
      siteCrawlStore: new PostgresSiteCrawlStore(pool),
      siteOwnershipVerifier:
        options.siteOwnershipVerifier ??
        (dependencies.createSiteOwnershipVerifier ?? createNodeSafeSiteOwnershipVerifier)(),
      tenancyStore: new PostgresTenancyStore(pool),
      readiness:
        options.readiness ??
        (async () => {
          try {
            await pool?.query('SELECT 1');
            return true;
          } catch {
            return false;
          }
        }),
    };
  }

  if (
    !fakeMode &&
    !testMode &&
    (options.measurementStore === undefined ||
      options.measurementRawEvidenceStore === undefined ||
      options.manualMeasurementImportStore === undefined ||
      options.measurementStore instanceof InMemoryMeasurementStore ||
      options.measurementRawEvidenceStore instanceof InMemoryMeasurementRawEvidenceStore ||
      options.manualMeasurementImportStore instanceof InMemoryManualMeasurementImportStore)
  ) {
    await pool?.end();
    throw new Error('MEASUREMENT_RUNTIME_NOT_CONFIGURED');
  }

  if (!fakeMode && options.oidcClient === undefined && !testMode) {
    try {
      options = {
        ...options,
        oidcClient: await OpenIdClientAdapter.discover({
          issuerUrl: requireEnvironment('OIDC_ISSUER_URL'),
          clientId: requireEnvironment('OIDC_CLIENT_ID'),
          ...(process.env.OIDC_CLIENT_SECRET === undefined
            ? {}
            : { clientSecret: process.env.OIDC_CLIENT_SECRET }),
        }),
      };
    } catch (error) {
      await Promise.allSettled([pool?.end()]);
      throw error;
    }
  }

  return {
    options,
    components: { ...(pool === undefined ? {} : { databasePool: pool }) },
    cleanup: async () => {
      await pool?.end();
    },
  };
}
