import * as AdapterRuntime from '@aeostudio/adapters';
import { describe, expect, test } from 'vitest';

type ShopifyContentKind = 'PAGE' | 'BLOG_ARTICLE' | 'PRODUCT';
type ShopifyRemoteState = 'UNPUBLISHED' | 'DRAFT' | 'PUBLISHED' | 'DELETED';

interface ShopifyDraftCommand {
  publicationId: string;
  idempotencyKey: string;
  authorizationReference: string;
  packageChecksum: string;
  artifact: {
    artifactId: string;
    artifactRevisionId: string;
    revision: number;
    contentHash: string;
  };
  target: {
    shopDomain: string;
    contentKind: ShopifyContentKind;
    handle: string;
    blogId?: string;
    articleAuthor?: { name: string };
    remoteId?: string;
  };
  document: {
    title: string;
    summary: string;
  };
  files: {
    'content.md': string;
    'content.html': string;
    'structured-data.json': string;
  };
}

interface ShopifyRevisionMapping {
  artifactId: string;
  artifactRevisionId: string;
  artifactRevision: number;
  artifactContentHash: string;
  packageChecksum: string;
}

interface ShopifyDraftRollbackHandle {
  operation: 'UNPUBLISH_DELETE_DRAFT';
  shopDomain: string;
  contentKind: ShopifyContentKind;
  remoteId: string;
}

interface ShopifyDraftReference {
  remoteRef: string;
  remoteId: string;
  adminUrl: string;
  status: 'UNPUBLISHED' | 'DRAFT';
  isProductionLive: false;
  revisionMapping: ShopifyRevisionMapping;
  rollbackHandle: ShopifyDraftRollbackHandle;
}

interface ShopifyUserErrorIssue {
  field: string;
  code: string;
}

type ShopifyDraftPublishResult =
  | ({ outcome: 'APPLIED' } & ShopifyDraftReference)
  | {
      outcome: 'DEFINITELY_NOT_APPLIED' | 'AMBIGUOUS' | 'RETRYABLE_FAILURE';
      errorCode: string;
      retryAfterSeconds?: number;
      userErrors?: ShopifyUserErrorIssue[];
    };

interface FakeShopifyRemoteObject {
  remoteId: string;
  contentKind: ShopifyContentKind;
  handle: string;
  blogId?: string;
  articleAuthor?: { name: string };
  title: string;
  bodyHtml: string;
  state: ShopifyRemoteState;
  isPublished: false | null;
  productStatus: 'DRAFT' | null;
  remoteIntent: string;
  revisionMapping: ShopifyRevisionMapping;
}

interface FakeShopifyAdminApiSnapshot {
  apiVersion: string;
  responseApiVersion: string;
  shopDomain: string;
  createCount: number;
  updateCount: number;
  deleteCount: number;
  unpublishCount: number;
  activeRemoteObjectCount: number;
  publishedObjectCount: number;
  orderReadCount: number;
  customerReadCount: number;
  themeWriteCount: number;
  restApiCallCount: number;
  privateApiCallCount: number;
  unstableApiCallCount: number;
  graphqlCalls: Array<{
    endpoint: string;
    responseApiVersion: string;
    operationName: string;
    variables: Record<string, unknown> | null;
  }>;
  objects: FakeShopifyRemoteObject[];
}

interface VersionedFakeShopifyAdminApi {
  queueFailure(mode: 'TIMEOUT_AFTER_EFFECT' | 'PUBLISH_INSTEAD_OF_DRAFT'): void;
  queueGraphQlErrors(errors: Array<{ message: string; code: string }>): void;
  queueGraphQlUserErrors(errors: Array<{ field: string[]; message: string; code: string }>): void;
  queueThrottle(input: {
    requestedQueryCost: number;
    currentlyAvailable: number;
    restoreRate: number;
  }): void;
  snapshot(): FakeShopifyAdminApiSnapshot;
}

type VersionedFakeShopifyAdminApiConstructor = new (options: {
  apiVersion: string;
  responseApiVersion?: string;
  shopDomain: string;
  authorization: {
    scopes: string[];
    accessToken: string;
  };
  log(entry: string): void;
}) => VersionedFakeShopifyAdminApi;

interface ShopifyDraftPublicationAdapter {
  describe(): {
    adapterKey: string;
    adapterVersion: string;
    providerApiVersion: string;
    capabilities: string[];
    requiredScopes: string[];
  };
  validateAuthorization(command: ShopifyDraftCommand): Promise<
    | { outcome: 'VALID' }
    | {
        outcome: 'INVALID';
        errorCode:
          | 'SHOPIFY_DOMAIN_NOT_ALLOWED'
          | 'SHOPIFY_SHOP_MISMATCH'
          | 'SHOPIFY_TOKEN_INVALID'
          | 'SHOPIFY_SCOPE_INSUFFICIENT'
          | 'SHOPIFY_API_VERSION_UNSUPPORTED'
          | 'SHOPIFY_RESPONSE_VERSION_MISMATCH';
      }
  >;
  publish(command: ShopifyDraftCommand): Promise<ShopifyDraftPublishResult>;
  reconcile(command: ShopifyDraftCommand): Promise<ShopifyDraftPublishResult>;
  rollback(command: ShopifyDraftCommand & { rollbackHandle: ShopifyDraftRollbackHandle }): Promise<
    | {
        outcome: 'ROLLED_BACK';
        remoteRef: string;
        status: 'DELETED';
        rollbackHandle: ShopifyDraftRollbackHandle;
      }
    | { outcome: 'DEFINITELY_NOT_ROLLED_BACK' | 'UNKNOWN'; errorCode: string }
  >;
}

type ShopifyDraftPublicationAdapterConstructor = new (options: {
  adapterKey: string;
  adapterVersion: string;
  providerApiVersion: string;
  supportedStableApiVersions: string[];
  api: VersionedFakeShopifyAdminApi;
  requiredScopesByContentKind: Record<ShopifyContentKind, string[]>;
  allowedShopDomains: string[];
}) => ShopifyDraftPublicationAdapter;

const apiConstructor = (
  AdapterRuntime as unknown as {
    VersionedFakeShopifyAdminApi?: VersionedFakeShopifyAdminApiConstructor;
  }
).VersionedFakeShopifyAdminApi;
const adapterConstructor = (
  AdapterRuntime as unknown as {
    ShopifyDraftPublicationAdapter?: ShopifyDraftPublicationAdapterConstructor;
  }
).ShopifyDraftPublicationAdapter;
const runtimeMissing = apiConstructor === undefined || adapterConstructor === undefined;

const shopDomain = 'tenant-shop.myshopify.com';
const adminApiVersion = '2026-07';
const adapterVersion = '1.0.0';
const tokenSentinel = 'shpat_task13_token_must_never_escape';

function requireRuntime(failureMessage: string): {
  Api: VersionedFakeShopifyAdminApiConstructor;
  Adapter: ShopifyDraftPublicationAdapterConstructor;
} {
  expect(apiConstructor, failureMessage).toBeTypeOf('function');
  expect(adapterConstructor, failureMessage).toBeTypeOf('function');
  if (apiConstructor === undefined || adapterConstructor === undefined) {
    throw new Error(failureMessage);
  }
  return { Api: apiConstructor, Adapter: adapterConstructor };
}

function createHarness(options?: {
  apiVersion?: string;
  configuredProviderApiVersion?: string;
  responseApiVersion?: string;
  shopDomain?: string;
  allowedShopDomains?: string[];
  scopes?: string[];
  accessToken?: string;
}): {
  api: VersionedFakeShopifyAdminApi;
  adapter: ShopifyDraftPublicationAdapter;
  logEntries: string[];
} {
  const { Api, Adapter } = requireRuntime('expected unpublished content');
  const logEntries: string[] = [];
  const api = new Api({
    apiVersion: options?.apiVersion ?? adminApiVersion,
    ...(options?.responseApiVersion === undefined
      ? {}
      : { responseApiVersion: options.responseApiVersion }),
    shopDomain: options?.shopDomain ?? shopDomain,
    authorization: {
      scopes: options?.scopes ?? ['write_content', 'write_products'],
      accessToken: options?.accessToken ?? tokenSentinel,
    },
    log: (entry) => logEntries.push(entry),
  });
  const adapter = new Adapter({
    adapterKey: 'shopify-draft',
    adapterVersion,
    providerApiVersion: options?.configuredProviderApiVersion ?? adminApiVersion,
    supportedStableApiVersions: [adminApiVersion],
    api,
    requiredScopesByContentKind: {
      PAGE: ['write_content'],
      BLOG_ARTICLE: ['write_content'],
      PRODUCT: ['write_products'],
    },
    allowedShopDomains: options?.allowedShopDomains ?? [shopDomain],
  });
  return { api, adapter, logEntries };
}

function commandFor(contentKind: ShopifyContentKind, suffix: string): ShopifyDraftCommand {
  return {
    publicationId: `publication-${suffix}`,
    idempotencyKey: `local-idempotency-${suffix}`,
    authorizationReference: 'secret://shopify/tenant-shop',
    packageChecksum: 'a'.repeat(64),
    artifact: {
      artifactId: '00000000-0000-7000-8000-000000001301',
      artifactRevisionId: '00000000-0000-7000-8000-000000001302',
      revision: 7,
      contentHash: 'b'.repeat(64),
    },
    target: {
      shopDomain,
      contentKind,
      handle: `approved-${contentKind.toLowerCase().replace('_', '-')}-${suffix}`,
      ...(contentKind === 'BLOG_ARTICLE'
        ? {
            blogId: 'gid://shopify/Blog/700000000001',
            articleAuthor: { name: 'AEO Studio Publisher' },
          }
        : {}),
    },
    document: {
      title: `Approved ${contentKind} content`,
      summary: 'Approved summary from the exact reviewed revision.',
    },
    files: {
      'content.md': `# Approved ${contentKind} content\n\nExact approved body.`,
      'content.html': `<article><h1>Approved ${contentKind} content</h1><p>Exact approved body.</p></article>`,
      'structured-data.json': JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: `Approved ${contentKind} content`,
      }),
    },
  };
}

function revisionMappingFor(command: ShopifyDraftCommand): ShopifyRevisionMapping {
  return {
    artifactId: command.artifact.artifactId,
    artifactRevisionId: command.artifact.artifactRevisionId,
    artifactRevision: command.artifact.revision,
    artifactContentHash: command.artifact.contentHash,
    packageChecksum: command.packageChecksum,
  };
}

function expectedRemoteId(contentKind: ShopifyContentKind): string {
  switch (contentKind) {
    case 'PAGE':
      return 'gid://shopify/Page/1';
    case 'BLOG_ARTICLE':
      return 'gid://shopify/Article/1';
    case 'PRODUCT':
      return 'gid://shopify/Product/1';
  }
}

function expectedAdminUrl(contentKind: ShopifyContentKind): string {
  switch (contentKind) {
    case 'PAGE':
      return 'https://admin.shopify.com/store/tenant-shop/pages/1';
    case 'BLOG_ARTICLE':
      return 'https://admin.shopify.com/store/tenant-shop/content/articles/1';
    case 'PRODUCT':
      return 'https://admin.shopify.com/store/tenant-shop/products/1';
  }
}

function expectedOperation(contentKind: ShopifyContentKind): string {
  switch (contentKind) {
    case 'PAGE':
      return 'PageCreate';
    case 'BLOG_ARTICLE':
      return 'ArticleCreate';
    case 'PRODUCT':
      return 'ProductCreate';
  }
}

function expectedState(contentKind: ShopifyContentKind): 'UNPUBLISHED' | 'DRAFT' {
  return contentKind === 'PRODUCT' ? 'DRAFT' : 'UNPUBLISHED';
}

function expectNoForbiddenShopifySurface(snapshot: FakeShopifyAdminApiSnapshot): void {
  expect(snapshot).toMatchObject({
    orderReadCount: 0,
    customerReadCount: 0,
    themeWriteCount: 0,
    restApiCallCount: 0,
    privateApiCallCount: 0,
    unstableApiCallCount: 0,
  });
  expect(JSON.stringify(snapshot)).not.toMatch(
    /orders|customers|theme(?:s|_code)|private|unstable/i,
  );
}

describe('Task 13 Shopify Draft Adapter public contract', () => {
  test('exports a versioned official Admin GraphQL fake and a stable 2026-07 draft Adapter', () => {
    const { Adapter, Api } = requireRuntime('expected unpublished content');
    const api = new Api({
      apiVersion: adminApiVersion,
      shopDomain,
      authorization: {
        scopes: ['write_content', 'write_products'],
        accessToken: tokenSentinel,
      },
      log: () => undefined,
    });
    const adapter = new Adapter({
      adapterKey: 'shopify-draft',
      adapterVersion,
      providerApiVersion: adminApiVersion,
      supportedStableApiVersions: [adminApiVersion],
      api,
      requiredScopesByContentKind: {
        PAGE: ['write_content'],
        BLOG_ARTICLE: ['write_content'],
        PRODUCT: ['write_products'],
      },
      allowedShopDomains: [shopDomain],
    });
    expect(adapter.describe()).toEqual({
      adapterKey: 'shopify-draft',
      adapterVersion,
      providerApiVersion: adminApiVersion,
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
      requiredScopes: ['write_content', 'write_products'],
    });
    expect(adapter.describe().requiredScopes).not.toEqual(
      expect.arrayContaining([
        'read_orders',
        'write_orders',
        'read_customers',
        'write_customers',
        'read_themes',
        'write_themes',
      ]),
    );
  });

  test.skipIf(runtimeMissing)(
    'maps PAGE, BLOG_ARTICLE, and PRODUCT through explicit unpublished GraphQL inputs',
    async () => {
      for (const contentKind of ['PAGE', 'BLOG_ARTICLE', 'PRODUCT'] as const) {
        const harness = createHarness();
        const command = commandFor(contentKind, `mapping-${contentKind.toLowerCase()}`);
        await expect(harness.adapter.validateAuthorization(command)).resolves.toEqual({
          outcome: 'VALID',
        });
        const result = await harness.adapter.publish(command);
        expect(result.outcome, 'expected unpublished content').toBe('APPLIED');
        if (result.outcome !== 'APPLIED') throw new Error('expected unpublished content');

        const remoteId = expectedRemoteId(contentKind);
        const adminUrl = expectedAdminUrl(contentKind);
        expect(result).toEqual({
          outcome: 'APPLIED',
          remoteRef: adminUrl,
          remoteId,
          adminUrl,
          status: expectedState(contentKind),
          isProductionLive: false,
          revisionMapping: revisionMappingFor(command),
          rollbackHandle: {
            operation: 'UNPUBLISH_DELETE_DRAFT',
            shopDomain,
            contentKind,
            remoteId,
          },
        });

        const snapshot = harness.api.snapshot();
        expect(snapshot).toMatchObject({
          apiVersion: adminApiVersion,
          responseApiVersion: adminApiVersion,
          shopDomain,
          createCount: 1,
          updateCount: 0,
          activeRemoteObjectCount: 1,
          publishedObjectCount: 0,
          graphqlCalls: [
            {
              endpoint: `/admin/api/${adminApiVersion}/graphql.json`,
              responseApiVersion: adminApiVersion,
              operationName: expectedOperation(contentKind),
            },
          ],
          objects: [
            {
              remoteId,
              contentKind,
              handle: command.target.handle,
              title: command.document.title,
              bodyHtml: command.files['content.html'],
              state: expectedState(contentKind),
              isPublished: contentKind === 'PRODUCT' ? null : false,
              productStatus: contentKind === 'PRODUCT' ? 'DRAFT' : null,
              revisionMapping: revisionMappingFor(command),
            },
          ],
        });
        expect(snapshot.objects[0]?.remoteIntent).toMatch(/^[a-f0-9]{64}$/);
        expect(snapshot.objects[0]?.remoteIntent).not.toBe(command.idempotencyKey);
        const mutationCall = snapshot.graphqlCalls[0];
        expect(mutationCall?.variables).toEqual(
          contentKind === 'PAGE'
            ? {
                page: {
                  title: command.document.title,
                  body: command.files['content.html'],
                  handle: command.target.handle,
                  isPublished: false,
                },
              }
            : contentKind === 'BLOG_ARTICLE'
              ? {
                  article: {
                    blogId: command.target.blogId,
                    title: command.document.title,
                    body: command.files['content.html'],
                    handle: command.target.handle,
                    isPublished: false,
                    author: command.target.articleAuthor,
                  },
                }
              : {
                  product: {
                    title: command.document.title,
                    descriptionHtml: command.files['content.html'],
                    handle: command.target.handle,
                    status: 'DRAFT',
                  },
                },
        );
        if (contentKind === 'BLOG_ARTICLE') {
          expect(snapshot.objects[0]).toMatchObject({
            blogId: command.target.blogId,
            articleAuthor: command.target.articleAuthor,
          });
        }
        expectNoForbiddenShopifySurface(snapshot);
        expect(JSON.stringify({ result, snapshot, logs: harness.logEntries })).not.toContain(
          tokenSentinel,
        );
      }
    },
  );

  test.skipIf(runtimeMissing)(
    'rejects shop/domain/token/scope/version and mismatched response versions before effects',
    async () => {
      const cases: Array<{
        name: string;
        harness: ReturnType<typeof createHarness>;
        command: ShopifyDraftCommand;
        errorCode:
          | 'SHOPIFY_DOMAIN_NOT_ALLOWED'
          | 'SHOPIFY_SHOP_MISMATCH'
          | 'SHOPIFY_TOKEN_INVALID'
          | 'SHOPIFY_SCOPE_INSUFFICIENT'
          | 'SHOPIFY_API_VERSION_UNSUPPORTED'
          | 'SHOPIFY_RESPONSE_VERSION_MISMATCH';
      }> = [
        {
          name: 'domain',
          harness: createHarness(),
          command: {
            ...commandFor('PAGE', 'invalid-domain'),
            target: {
              ...commandFor('PAGE', 'invalid-domain').target,
              shopDomain: 'tenant-shop.myshopify.com.evil.test',
            },
          },
          errorCode: 'SHOPIFY_DOMAIN_NOT_ALLOWED',
        },
        {
          name: 'shop',
          harness: createHarness({ shopDomain: 'different-shop.myshopify.com' }),
          command: commandFor('PAGE', 'shop-mismatch'),
          errorCode: 'SHOPIFY_SHOP_MISMATCH',
        },
        {
          name: 'token',
          harness: createHarness({ accessToken: '' }),
          command: commandFor('PAGE', 'token-invalid'),
          errorCode: 'SHOPIFY_TOKEN_INVALID',
        },
        {
          name: 'scope',
          harness: createHarness({ scopes: ['write_content'] }),
          command: commandFor('PRODUCT', 'scope-missing'),
          errorCode: 'SHOPIFY_SCOPE_INSUFFICIENT',
        },
        {
          name: 'unstable version',
          harness: createHarness({
            apiVersion: 'unstable',
            configuredProviderApiVersion: 'unstable',
          }),
          command: commandFor('PAGE', 'unstable-version'),
          errorCode: 'SHOPIFY_API_VERSION_UNSUPPORTED',
        },
        {
          name: 'expired version',
          harness: createHarness({
            apiVersion: '2025-01',
            configuredProviderApiVersion: '2025-01',
          }),
          command: commandFor('PAGE', 'expired-version'),
          errorCode: 'SHOPIFY_API_VERSION_UNSUPPORTED',
        },
        {
          name: 'response version',
          harness: createHarness({ responseApiVersion: '2026-04' }),
          command: commandFor('PAGE', 'response-version-mismatch'),
          errorCode: 'SHOPIFY_RESPONSE_VERSION_MISMATCH',
        },
      ];

      for (const candidate of cases) {
        await expect(
          candidate.harness.adapter.validateAuthorization(candidate.command),
          `expected scope/version rejection for ${candidate.name}`,
        ).resolves.toEqual({ outcome: 'INVALID', errorCode: candidate.errorCode });
        await expect(
          candidate.harness.adapter.publish(candidate.command),
          `expected scope/version rejection for ${candidate.name}`,
        ).resolves.toEqual({
          outcome: 'DEFINITELY_NOT_APPLIED',
          errorCode: candidate.errorCode,
        });
        expect(candidate.harness.api.snapshot().activeRemoteObjectCount).toBe(0);
      }
    },
  );

  test.skipIf(runtimeMissing)(
    'uses only official GraphQL content operations and never orders, customers, themes, REST, private, or unstable APIs',
    async () => {
      const harness = createHarness();
      for (const contentKind of ['PAGE', 'BLOG_ARTICLE', 'PRODUCT'] as const) {
        await harness.adapter.publish(commandFor(contentKind, `allowlist-${contentKind}`));
      }
      const snapshot = harness.api.snapshot();
      expect(snapshot.graphqlCalls.map(({ operationName }) => operationName)).toEqual([
        'PageCreate',
        'ArticleCreate',
        'ProductCreate',
      ]);
      expect(
        snapshot.graphqlCalls.every(
          ({ endpoint, responseApiVersion }) =>
            endpoint === `/admin/api/${adminApiVersion}/graphql.json` &&
            responseApiVersion === adminApiVersion,
        ),
      ).toBe(true);
      expectNoForbiddenShopifySurface(snapshot);
    },
  );

  test.skipIf(runtimeMissing)(
    'reuses one stable remote intent across local retries and updates only the same unpublished object',
    async () => {
      const harness = createHarness();
      const command = commandFor('PAGE', 'stable-intent');
      const first = await harness.adapter.publish(command);
      expect(first.outcome).toBe('APPLIED');
      const duplicate = await harness.adapter.publish({
        ...command,
        publicationId: 'publication-safe-platform-retry',
        idempotencyKey: 'different-local-retry-key',
      });
      expect(duplicate).toEqual(first);
      expect(harness.api.snapshot().createCount, 'expected one remote object').toBe(1);
      expect(harness.api.snapshot().activeRemoteObjectCount, 'expected one remote object').toBe(1);
      if (first.outcome !== 'APPLIED') throw new Error('expected unpublished content');

      const update: ShopifyDraftCommand = {
        ...command,
        publicationId: 'publication-exact-update',
        idempotencyKey: 'local-update-key',
        packageChecksum: 'c'.repeat(64),
        artifact: {
          ...command.artifact,
          artifactRevisionId: '00000000-0000-7000-8000-000000001303',
          revision: 8,
          contentHash: 'd'.repeat(64),
        },
        target: { ...command.target, remoteId: first.remoteId },
        document: {
          title: 'Approved updated PAGE content',
          summary: 'Approved updated summary from revision eight.',
        },
        files: {
          ...command.files,
          'content.md': '# Approved updated PAGE content\n\nExact approved revision eight.',
          'content.html':
            '<article><h1>Approved updated PAGE content</h1><p>Exact approved revision eight.</p></article>',
        },
      };
      await expect(harness.adapter.publish(update)).resolves.toMatchObject({
        outcome: 'APPLIED',
        remoteId: first.remoteId,
        status: 'UNPUBLISHED',
        revisionMapping: revisionMappingFor(update),
      });
      expect(harness.api.snapshot()).toMatchObject({
        activeRemoteObjectCount: 1,
        createCount: 1,
        updateCount: 1,
        publishedObjectCount: 0,
      });
      expect(
        harness.api.snapshot().graphqlCalls.map(({ operationName }) => operationName),
      ).toContain('PageUpdate');
      expect(harness.api.snapshot().objects[0]).toMatchObject({
        state: 'UNPUBLISHED',
        isPublished: false,
        revisionMapping: revisionMappingFor(update),
      });
    },
  );

  test.skipIf(runtimeMissing)(
    'maps GraphQL errors, mutation userErrors, and throttle cost into typed non-success outcomes',
    async () => {
      const topLevelError = createHarness();
      topLevelError.api.queueGraphQlErrors([
        { message: 'Access denied for pageCreate field.', code: 'ACCESS_DENIED' },
      ]);
      await expect(
        topLevelError.adapter.publish(commandFor('PAGE', 'graphql-error')),
      ).resolves.toEqual({
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'SHOPIFY_GRAPHQL_ACCESS_DENIED',
      });
      expect(topLevelError.api.snapshot().activeRemoteObjectCount).toBe(0);

      const userError = createHarness();
      userError.api.queueGraphQlUserErrors([
        { field: ['page', 'title'], message: 'Title is invalid.', code: 'INVALID' },
      ]);
      await expect(userError.adapter.publish(commandFor('PAGE', 'user-error'))).resolves.toEqual({
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'SHOPIFY_GRAPHQL_USER_ERROR',
        userErrors: [{ field: 'page.title', code: 'INVALID' }],
      });
      expect(
        userError.api.snapshot().activeRemoteObjectCount,
        'GraphQL userErrors were not mapped',
      ).toBe(0);

      const throttle = createHarness();
      throttle.api.queueThrottle({
        requestedQueryCost: 50,
        currentlyAvailable: 0,
        restoreRate: 10,
      });
      await expect(throttle.adapter.publish(commandFor('PRODUCT', 'throttled'))).resolves.toEqual({
        outcome: 'RETRYABLE_FAILURE',
        errorCode: 'SHOPIFY_THROTTLED',
        retryAfterSeconds: 5,
      });
      expect(throttle.api.snapshot().activeRemoteObjectCount).toBe(0);
    },
  );

  test.skipIf(runtimeMissing)(
    'reconciles a timeout-after-effect to the one exact remote revision without duplicating content',
    async () => {
      const harness = createHarness();
      const command = commandFor('BLOG_ARTICLE', 'timeout-after-effect');
      harness.api.queueFailure('TIMEOUT_AFTER_EFFECT');
      await expect(harness.adapter.publish(command)).resolves.toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'SHOPIFY_REMOTE_TIMEOUT',
      });
      expect(harness.api.snapshot().activeRemoteObjectCount).toBe(1);
      await expect(harness.adapter.publish(command)).resolves.toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'SHOPIFY_RECONCILE_REQUIRED',
      });
      await expect(harness.adapter.reconcile(command)).resolves.toMatchObject({
        outcome: 'APPLIED',
        remoteId: 'gid://shopify/Article/1',
        status: 'UNPUBLISHED',
        revisionMapping: revisionMappingFor(command),
      });
      expect(harness.api.snapshot()).toMatchObject({
        activeRemoteObjectCount: 1,
        createCount: 1,
        publishedObjectCount: 0,
      });
      expect(harness.api.snapshot().objects[0]).toMatchObject({
        remoteId: 'gid://shopify/Article/1',
        revisionMapping: revisionMappingFor(command),
      });
    },
  );

  test.skipIf(runtimeMissing)(
    'keeps the remote intent stable across OAuth token rotation while reconciling a timeout-after-effect',
    async () => {
      const harness = createHarness();
      const tokenA = 'shpat_rotated_token_a_must_never_escape';
      const tokenB = 'shpat_rotated_token_b_must_never_escape';
      const commandWithTokenA = {
        ...commandFor('PAGE', 'token-rotation-timeout'),
        authorizationReference: tokenA,
      };
      const commandWithTokenB = {
        ...commandWithTokenA,
        authorizationReference: tokenB,
      };

      harness.api.queueFailure('TIMEOUT_AFTER_EFFECT');
      const publishResult = await harness.adapter.publish(commandWithTokenA);
      expect(publishResult).toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'SHOPIFY_REMOTE_TIMEOUT',
      });
      const remoteIntent = harness.api.snapshot().objects[0]?.remoteIntent;
      expect(remoteIntent).toMatch(/^[a-f0-9]{64}$/);

      const reconcileResult = await harness.adapter.reconcile(commandWithTokenB);
      expect(reconcileResult).toMatchObject({
        outcome: 'APPLIED',
        remoteId: 'gid://shopify/Page/1',
        status: 'UNPUBLISHED',
        revisionMapping: revisionMappingFor(commandWithTokenB),
      });
      expect(harness.api.snapshot()).toMatchObject({
        activeRemoteObjectCount: 1,
        createCount: 1,
        updateCount: 0,
        objects: [expect.objectContaining({ remoteIntent })],
      });
      expect(
        JSON.stringify({
          remoteIntent,
          snapshot: harness.api.snapshot(),
          publishResult,
          reconcileResult,
          logs: harness.logEntries,
        }),
      ).not.toMatch(/shpat_rotated_token_[ab]_must_never_escape/);
    },
  );

  test.skipIf(runtimeMissing)(
    'rolls back an unsafe publish and deletes only the exact owned draft through its rollback record',
    async () => {
      const unsafe = createHarness();
      unsafe.api.queueFailure('PUBLISH_INSTEAD_OF_DRAFT');
      await expect(unsafe.adapter.publish(commandFor('PAGE', 'unsafe-publish'))).resolves.toEqual({
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'SHOPIFY_UNSAFE_PUBLISH_STATE_ROLLED_BACK',
      });
      expect(unsafe.api.snapshot()).toMatchObject({
        activeRemoteObjectCount: 0,
        publishedObjectCount: 0,
        unpublishCount: 1,
        deleteCount: 1,
      });

      const harness = createHarness();
      const command = commandFor('PRODUCT', 'rollback');
      const applied = await harness.adapter.publish(command);
      expect(applied.outcome).toBe('APPLIED');
      if (applied.outcome !== 'APPLIED') throw new Error('expected unpublished content');
      await expect(
        harness.adapter.rollback({
          ...command,
          rollbackHandle: {
            ...applied.rollbackHandle,
            remoteId: 'gid://shopify/Product/999',
          },
        }),
      ).resolves.toEqual({
        outcome: 'DEFINITELY_NOT_ROLLED_BACK',
        errorCode: 'SHOPIFY_ROLLBACK_TARGET_MISMATCH',
      });
      expect(harness.api.snapshot().activeRemoteObjectCount).toBe(1);
      await expect(
        harness.adapter.rollback({ ...command, rollbackHandle: applied.rollbackHandle }),
      ).resolves.toEqual({
        outcome: 'ROLLED_BACK',
        remoteRef: applied.remoteRef,
        status: 'DELETED',
        rollbackHandle: applied.rollbackHandle,
      });
      expect(harness.api.snapshot()).toMatchObject({
        activeRemoteObjectCount: 0,
        publishedObjectCount: 0,
        deleteCount: 1,
        objects: [
          {
            remoteId: applied.remoteId,
            state: 'DELETED',
            revisionMapping: revisionMappingFor(command),
          },
        ],
      });
      expectNoForbiddenShopifySurface(harness.api.snapshot());
      expect(
        JSON.stringify({
          result: applied,
          snapshot: harness.api.snapshot(),
          logs: harness.logEntries,
        }),
      ).not.toContain(tokenSentinel);
    },
  );
});
