import type { ChannelRegistryStore } from '@aeostudio/application/channels-publishing';
import type { ChannelRegistryEntry } from '@aeostudio/domain/channels-publishing';

const PORTABLE_WEB_EXPORT: ChannelRegistryEntry = {
  id: '00000000-0000-7000-8000-000000001000',
  channelKey: 'portable-web-export',
  displayName: 'Portable Web Export',
  status: 'AVAILABLE',
  unavailableReason: null,
  packageTransformerKey: 'generic-web-package',
  packageSchemaVersion: '1.0.0',
  adapterVersions: [],
};

const REVIEW_ONLY_HANDOFFS: ChannelRegistryEntry[] = [
  {
    id: '00000000-0000-7000-8000-000000001050',
    channelKey: 'third-party-site-handoff',
    displayName: 'Third-party Site Handoff',
    status: 'AVAILABLE',
    unavailableReason: null,
    packageTransformerKey: 'generic-web-package',
    packageSchemaVersion: '1.1.0',
    channelProfile: {
      channel: 'third-party-site-handoff',
      profileVersion: '1.0.0',
      profileHash: '47105ddd224e542a047fc4b28ce127ef0ddeef13ebbbdad79ba60a1e3037ab9b',
      fieldRequirements: [
        {
          field: 'title',
          sourcePointer: '/title',
          required: true,
          minLength: 1,
          maxLength: 180,
          format: 'plain-text',
        },
        {
          field: 'summary',
          sourcePointer: '/summary',
          required: true,
          minLength: 1,
          maxLength: 2_000,
          format: 'plain-text',
        },
        {
          field: 'disclosure',
          sourcePointer: '/disclosure',
          required: true,
          minLength: 1,
          maxLength: 800,
          format: 'plain-text',
        },
      ],
    },
    adapterVersions: [],
  },
  {
    id: '00000000-0000-7000-8000-000000001060',
    channelKey: 'social-channel-handoff',
    displayName: 'Social Channel Handoff',
    status: 'AVAILABLE',
    unavailableReason: null,
    packageTransformerKey: 'generic-web-package',
    packageSchemaVersion: '1.1.0',
    channelProfile: {
      channel: 'social-channel-handoff',
      profileVersion: '1.0.0',
      profileHash: '56bda296dfc9287991e75505bd05c61a4b417a2c864003f6710cb925e21d0bb4',
      fieldRequirements: [
        {
          field: 'post',
          sourcePointer: '/summary',
          required: true,
          minLength: 1,
          maxLength: 280,
          format: 'plain-text',
        },
        {
          field: 'disclosure',
          sourcePointer: '/disclosure',
          required: true,
          minLength: 1,
          maxLength: 300,
          format: 'plain-text',
        },
      ],
    },
    adapterVersions: [],
  },
  {
    id: '00000000-0000-7000-8000-000000001070',
    channelKey: 'directory-handoff',
    displayName: 'Directory Handoff',
    status: 'AVAILABLE',
    unavailableReason: null,
    packageTransformerKey: 'generic-web-package',
    packageSchemaVersion: '1.1.0',
    channelProfile: {
      channel: 'directory-handoff',
      profileVersion: '1.0.0',
      profileHash: '29f453d7023f06932d0fc0a0087e7ef2b0a63792923f19c04ba5bde28c71cce0',
      fieldRequirements: [
        {
          field: 'name',
          sourcePointer: '/title',
          required: true,
          minLength: 1,
          maxLength: 160,
          format: 'plain-text',
        },
        {
          field: 'description',
          sourcePointer: '/summary',
          required: true,
          minLength: 1,
          maxLength: 2_000,
          format: 'plain-text',
        },
        {
          field: 'disclosure',
          sourcePointer: '/disclosure',
          required: true,
          minLength: 1,
          maxLength: 800,
          format: 'plain-text',
        },
      ],
    },
    adapterVersions: [],
  },
];

const REVIEWED_TEST_PUBLISHER: ChannelRegistryEntry = {
  id: '00000000-0000-7000-8000-000000001001',
  channelKey: 'reviewed-test-publisher',
  displayName: 'Reviewed Test Publisher',
  status: 'AVAILABLE',
  unavailableReason: null,
  packageTransformerKey: 'generic-web-package',
  packageSchemaVersion: '1.0.0',
  adapterVersions: [
    {
      id: '00000000-0000-7000-8000-000000001002',
      adapterKey: 'fake-ambiguous',
      adapterVersion: 'v1',
      enabled: true,
      disabledReason: null,
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK'],
      requiredScopes: ['content:write'],
      termsVersion: 'test-terms-v1',
      termsStatus: 'ALLOWED',
      processingRegion: 'in-process-test-runtime',
      retentionPolicy: 'No package or credential retention outside process memory.',
      trainingPolicy: 'No training.',
      subprocessors: [],
      ratePolicy: { mode: 'deterministic-test-only' },
    },
  ],
};

const GIT_PULL_REQUEST: ChannelRegistryEntry = {
  id: '00000000-0000-7000-8000-000000001010',
  channelKey: 'git-pull-request',
  displayName: 'Git Pull Request',
  status: 'AVAILABLE',
  unavailableReason: null,
  packageTransformerKey: 'generic-web-package',
  packageSchemaVersion: '1.0.0',
  adapterVersions: [
    {
      id: '00000000-0000-7000-8000-000000001011',
      adapterKey: 'git-pull-request',
      adapterVersion: '1.0.0',
      enabled: true,
      disabledReason: null,
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'PULL_REQUEST_STATUS'],
      requiredScopes: ['contents:write', 'pull_requests:write', 'metadata:read'],
      termsVersion: 'git-test-terms-v1',
      termsStatus: 'ALLOWED',
      processingRegion: 'in-process-test-runtime',
      retentionPolicy: 'No credential or package retention outside process memory.',
      trainingPolicy: 'No training.',
      subprocessors: [],
      ratePolicy: { mode: 'deterministic-test-only' },
    },
  ],
};

const WORDPRESS_WOOCOMMERCE_DRAFT: ChannelRegistryEntry = {
  id: '00000000-0000-7000-8000-000000001020',
  channelKey: 'wordpress-woocommerce-draft',
  displayName: 'WordPress / WooCommerce Draft',
  status: 'AVAILABLE',
  unavailableReason: null,
  packageTransformerKey: 'generic-web-package',
  packageSchemaVersion: '1.0.0',
  adapterVersions: [
    {
      id: '00000000-0000-7000-8000-000000001021',
      adapterKey: 'wordpress-woocommerce-draft',
      adapterVersion: '1.0.0',
      enabled: true,
      disabledReason: null,
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
      requiredScopes: ['media:write', 'pages:write', 'posts:write', 'woocommerce:products:write'],
      termsVersion: 'wordpress-test-terms-v1',
      termsStatus: 'ALLOWED',
      processingRegion: 'in-process-test-runtime',
      retentionPolicy: 'No credential or package retention outside process memory.',
      trainingPolicy: 'No training.',
      subprocessors: [],
      ratePolicy: { mode: 'deterministic-test-only' },
    },
  ],
};

const SHOPIFY_DRAFT: ChannelRegistryEntry = {
  id: '00000000-0000-7000-8000-000000001030',
  channelKey: 'shopify-draft',
  displayName: 'Shopify Draft',
  status: 'AVAILABLE',
  unavailableReason: null,
  packageTransformerKey: 'generic-web-package',
  packageSchemaVersion: '1.0.0',
  adapterVersions: [
    {
      id: '00000000-0000-7000-8000-000000001031',
      adapterKey: 'shopify-draft',
      adapterVersion: '1.0.0',
      providerApiVersion: '2026-07',
      providerApiSupportedUntil: '2027-07-16T15:00:00.000Z',
      enabled: true,
      disabledReason: null,
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
      requiredScopes: ['write_content', 'write_products'],
      termsVersion: 'shopify-test-terms-v1',
      termsStatus: 'ALLOWED',
      processingRegion: 'in-process-test-runtime',
      retentionPolicy: 'No credential or package retention outside process memory.',
      trainingPolicy: 'No training.',
      subprocessors: [],
      ratePolicy: { apiVersion: '2026-07', mode: 'deterministic-test-only' },
    },
  ],
};

const SIGNED_WEBHOOK: ChannelRegistryEntry = {
  id: '00000000-0000-7000-8000-000000001040',
  channelKey: 'signed-webhook',
  displayName: 'Signed Webhook',
  status: 'AVAILABLE',
  unavailableReason: null,
  packageTransformerKey: 'generic-web-package',
  packageSchemaVersion: '1.0.0',
  adapterVersions: [
    {
      id: '00000000-0000-7000-8000-000000001041',
      adapterKey: 'signed-webhook',
      adapterVersion: '1.0.0',
      enabled: true,
      disabledReason: null,
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
      requiredScopes: ['webhook:deliver'],
      termsVersion: 'signed-webhook-contract-v1',
      termsStatus: 'ALLOWED',
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
  ],
};

export class InMemoryChannelRegistryStore implements ChannelRegistryStore {
  constructor(
    private readonly includeFakePublication = false,
    private readonly includeFakeGit = false,
    private readonly includeFakeWordPress = false,
    private readonly includeFakeShopify = false,
    private readonly includeFakeSignedWebhook = false,
  ) {}

  listEntries(): ReturnType<ChannelRegistryStore['listEntries']> {
    return Promise.resolve(this.listEntriesNow());
  }

  /** Fake-runtime atomic effect boundary; returns a detached current Registry snapshot. */
  listEntriesNow(): ChannelRegistryEntry[] {
    const entries = [PORTABLE_WEB_EXPORT, ...REVIEW_ONLY_HANDOFFS];
    if (this.includeFakePublication) entries.push(REVIEWED_TEST_PUBLISHER);
    if (this.includeFakePublication && this.includeFakeGit) entries.push(GIT_PULL_REQUEST);
    if (this.includeFakePublication && this.includeFakeWordPress) {
      entries.push(WORDPRESS_WOOCOMMERCE_DRAFT);
    }
    if (this.includeFakePublication && this.includeFakeShopify) entries.push(SHOPIFY_DRAFT);
    if (this.includeFakePublication && this.includeFakeSignedWebhook) entries.push(SIGNED_WEBHOOK);
    return structuredClone(entries);
  }
}
