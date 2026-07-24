import { createHash } from 'node:crypto';

import * as AdapterRuntime from '@aeostudio/adapters';
import { describe, expect, test } from 'vitest';

interface WordPressPageDraftCommand {
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
    siteOrigin: string;
    contentKind: 'PAGE' | 'POST' | 'PRODUCT';
    slug: string;
    categoryIds?: number[];
    remoteId?: number;
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
  assetRefs?: string[];
  media?: Array<{
    assetRef: string;
    filename: string;
    mediaType: string;
    sha256: string;
    bytes: Uint8Array;
  }>;
}

interface WordPressRevisionMapping {
  artifactId: string;
  artifactRevisionId: string;
  artifactRevision: number;
  artifactContentHash: string;
  packageChecksum: string;
}

interface WordPressPageDraftReference {
  remoteRef: string;
  remoteId: number;
  adminPreviewUrl: string;
  status: 'DRAFT';
  isProductionLive: false;
  revisionMapping: WordPressRevisionMapping;
  rollbackHandle: {
    operation: 'TRASH_DRAFT';
    siteOrigin: string;
    resource: '/wp/v2/pages' | '/wp/v2/posts' | '/wc/v3/products';
    remoteId: number;
  };
}

type WordPressPageDraftPublishResult =
  | ({ outcome: 'APPLIED' } & WordPressPageDraftReference)
  | {
      outcome: 'DEFINITELY_NOT_APPLIED' | 'AMBIGUOUS';
      errorCode: string;
      fallback?: 'EXPORT_ONLY';
      packageChecksum?: string;
    };

interface FakeWordPressServerSnapshot {
  apiVersion: string;
  draftCreateCount: number;
  contentUpdateCount: number;
  publishedCreateCount: number;
  mediaCreateCount: number;
  media: Array<{
    id: number;
    requestPath: '/wp-json/wp/v2/media';
    assetRef: string;
    filename: string;
    mediaType: string;
    sha256: string;
  }>;
  objects: Array<{
    id: number;
    requestPath: '/wp-json/wp/v2/pages' | '/wp-json/wp/v2/posts' | '/wp-json/wc/v3/products';
    status: 'draft' | 'publish' | 'trash';
    slug: string;
    title: string;
    content: string;
    categoryIds?: number[];
    revisionMapping: WordPressRevisionMapping;
  }>;
}

interface VersionedFakeWordPressServer {
  queueFailure(mode: 'PUBLISH_INSTEAD_OF_DRAFT' | 'RESPONSE_404' | 'TIMEOUT_AFTER_EFFECT'): void;
  setObjectStatus(remoteId: number, status: 'draft' | 'publish' | 'trash'): void;
  snapshot(): FakeWordPressServerSnapshot;
}

type VersionedFakeWordPressServerConstructor = new (options: {
  apiVersion: string;
  siteOrigin: string;
  authorization: {
    mechanism: 'OAUTH' | 'APPLICATION_PASSWORD' | 'APPROVED_TOKEN';
    scopes: string[];
    credential: string;
  };
  woocommerceApiVersion?: 'wc/v3' | null;
  writableFields?: string[];
  log(entry: string): void;
}) => VersionedFakeWordPressServer;

interface WordPressWooCommerceDraftAdapter {
  describe(): {
    adapterKey: string;
    adapterVersion: string;
    providerApiVersion: string;
    capabilities: string[];
  };
  validateAuthorization(command: WordPressPageDraftCommand): Promise<
    | { outcome: 'VALID' }
    | {
        outcome: 'INVALID';
        errorCode:
          | 'WORDPRESS_TLS_REQUIRED'
          | 'WORDPRESS_AUTHORIZATION_INVALID'
          | 'WORDPRESS_SCOPE_INSUFFICIENT';
      }
  >;
  publish(command: WordPressPageDraftCommand): Promise<WordPressPageDraftPublishResult>;
  reconcile(command: WordPressPageDraftCommand): Promise<WordPressPageDraftPublishResult>;
  rollback(
    command: WordPressPageDraftCommand & {
      rollbackHandle: WordPressPageDraftReference['rollbackHandle'];
    },
  ): Promise<
    | {
        outcome: 'ROLLED_BACK';
        remoteRef: string;
        status: 'TRASH';
        rollbackHandle: WordPressPageDraftReference['rollbackHandle'];
      }
    | { outcome: 'DEFINITELY_NOT_ROLLED_BACK' | 'UNKNOWN'; errorCode: string }
  >;
}

type WordPressWooCommerceDraftAdapterConstructor = new (options: {
  adapterKey: string;
  adapterVersion: string;
  providerApiVersion: string;
  server: VersionedFakeWordPressServer;
  requiredScopes: string[];
  allowedSiteOrigins: string[];
}) => WordPressWooCommerceDraftAdapter;

const siteOrigin = 'https://cms.example.test';
const providerApiVersion = 'wp/v2';
const adapterVersion = '1.0.0';
const credentialSentinel = 'wp_task12_application_password_must_never_escape';

const command: WordPressPageDraftCommand = {
  publicationId: '00000000-0000-7000-8000-000000001201',
  idempotencyKey: '00000000-0000-7000-8000-000000001201',
  authorizationReference: 'secret://wordpress/cms-example-test',
  packageChecksum: 'a'.repeat(64),
  artifact: {
    artifactId: '00000000-0000-7000-8000-000000001211',
    artifactRevisionId: '00000000-0000-7000-8000-000000001212',
    revision: 7,
    contentHash: 'b'.repeat(64),
  },
  target: {
    siteOrigin,
    contentKind: 'PAGE',
    slug: 'approved-answer-guide',
  },
  document: {
    title: 'Approved answer guide',
    summary: 'Approved summary for the exact reviewed revision.',
  },
  files: {
    'content.md': '# Approved answer guide\n\nExact approved body.',
    'content.html': '<h1>Approved answer guide</h1><p>Exact approved body.</p>',
    'structured-data.json': JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'Approved answer guide',
    }),
  },
};

interface WordPressSiteAuthorizationTargetV1 {
  schemaVersion: 'wordpress-site-auth.v1';
  siteUrl: string;
  authMode: 'OAUTH' | 'APPLICATION_PASSWORD' | 'APPROVED_TOKEN';
}

interface WordPressDraftTargetV1 {
  schemaVersion: 'wordpress-draft-target.v1';
  siteUrl: string;
  authMode: WordPressSiteAuthorizationTargetV1['authMode'];
  destination:
    | { kind: 'PAGE'; operation: 'CREATE'; slug: string }
    | { kind: 'PAGE'; operation: 'UPDATE'; slug: string; remoteId: number }
    | { kind: 'POST'; operation: 'CREATE'; slug: string; categoryIds: number[] }
    | {
        kind: 'POST';
        operation: 'UPDATE';
        slug: string;
        categoryIds: number[];
        remoteId: number;
      }
    | { kind: 'PRODUCT'; operation: 'CREATE'; slug: string; categoryIds: number[] }
    | {
        kind: 'PRODUCT';
        operation: 'UPDATE';
        slug: string;
        categoryIds: number[];
        remoteId: number;
      };
}

describe('Task 12 WordPress/WooCommerce Draft Adapter public contract', () => {
  test('creates one official wp/v2 page draft with exact approved-revision mapping and no credential disclosure', async () => {
    const serverConstructor = (
      AdapterRuntime as unknown as {
        VersionedFakeWordPressServer?: VersionedFakeWordPressServerConstructor;
      }
    ).VersionedFakeWordPressServer;
    const adapterConstructor = (
      AdapterRuntime as unknown as {
        WordPressWooCommerceDraftPublicationAdapter?: WordPressWooCommerceDraftAdapterConstructor;
      }
    ).WordPressWooCommerceDraftPublicationAdapter;

    expect(serverConstructor, 'expected draft status, received publish/404').toBeTypeOf('function');
    expect(adapterConstructor, 'expected draft status, received publish/404').toBeTypeOf(
      'function',
    );
    if (serverConstructor === undefined || adapterConstructor === undefined) {
      throw new Error('expected draft status, received publish/404');
    }

    const logEntries: string[] = [];
    const server = new serverConstructor({
      apiVersion: providerApiVersion,
      siteOrigin,
      authorization: {
        mechanism: 'APPLICATION_PASSWORD',
        scopes: ['pages:write'],
        credential: credentialSentinel,
      },
      log: (entry) => logEntries.push(entry),
    });
    const adapter = new adapterConstructor({
      adapterKey: 'wordpress-woocommerce-draft',
      adapterVersion,
      providerApiVersion,
      server,
      requiredScopes: ['pages:write'],
      allowedSiteOrigins: [siteOrigin],
    });

    expect(adapter.describe()).toEqual({
      adapterKey: 'wordpress-woocommerce-draft',
      adapterVersion,
      providerApiVersion,
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK'],
    });

    const result = await adapter.publish(command);
    expect(result.outcome, 'expected draft status, received publish/404').toBe('APPLIED');
    if (result.outcome !== 'APPLIED') {
      throw new Error('expected draft status, received publish/404');
    }

    const expectedRevisionMapping: WordPressRevisionMapping = {
      artifactId: command.artifact.artifactId,
      artifactRevisionId: command.artifact.artifactRevisionId,
      artifactRevision: command.artifact.revision,
      artifactContentHash: command.artifact.contentHash,
      packageChecksum: command.packageChecksum,
    };
    expect(result).toEqual({
      outcome: 'APPLIED',
      remoteRef: `${siteOrigin}/wp-admin/post.php?post=1&action=edit`,
      remoteId: 1,
      adminPreviewUrl: `${siteOrigin}/wp-admin/post.php?post=1&action=edit`,
      status: 'DRAFT',
      isProductionLive: false,
      revisionMapping: expectedRevisionMapping,
      rollbackHandle: {
        operation: 'TRASH_DRAFT',
        siteOrigin,
        resource: '/wp/v2/pages',
        remoteId: 1,
      },
    });

    const snapshot = server.snapshot();
    expect(snapshot).toMatchObject({
      apiVersion: providerApiVersion,
      draftCreateCount: 1,
      publishedCreateCount: 0,
      objects: [
        {
          id: 1,
          requestPath: '/wp-json/wp/v2/pages',
          status: 'draft',
          slug: command.target.slug,
          title: command.document.title,
          revisionMapping: expectedRevisionMapping,
        },
      ],
    });
    expect(snapshot.objects).toHaveLength(1);
    expect(snapshot.objects[0]?.content).toContain(command.files['content.html']);
    expect(snapshot.objects[0]?.status).toBe('draft');
    expect(snapshot.objects[0]?.status).not.toBe('publish');
    expect(result.isProductionLive).toBe(false);

    const externallyVisibleState = JSON.stringify({ command, result, snapshot, logEntries });
    expect(externallyVisibleState).not.toContain(credentialSentinel);
  });

  test('fails closed on a publish response or missing official route and trashes any unsafe effect', async () => {
    const serverConstructor = (
      AdapterRuntime as unknown as {
        VersionedFakeWordPressServer?: VersionedFakeWordPressServerConstructor;
      }
    ).VersionedFakeWordPressServer;
    const adapterConstructor = (
      AdapterRuntime as unknown as {
        WordPressWooCommerceDraftPublicationAdapter?: WordPressWooCommerceDraftAdapterConstructor;
      }
    ).WordPressWooCommerceDraftPublicationAdapter;
    if (serverConstructor === undefined || adapterConstructor === undefined) {
      throw new Error('expected draft status, received publish/404');
    }

    for (const mode of ['PUBLISH_INSTEAD_OF_DRAFT', 'RESPONSE_404'] as const) {
      const server = new serverConstructor({
        apiVersion: providerApiVersion,
        siteOrigin,
        authorization: {
          mechanism: 'APPLICATION_PASSWORD',
          scopes: ['pages:write'],
          credential: credentialSentinel,
        },
        log: () => undefined,
      });
      expect(
        server.queueFailure.bind(server),
        `expected draft status, received ${mode === 'RESPONSE_404' ? '404' : 'publish'}`,
      ).toBeTypeOf('function');
      server.queueFailure(mode);
      const adapter = new adapterConstructor({
        adapterKey: 'wordpress-woocommerce-draft',
        adapterVersion,
        providerApiVersion,
        server,
        requiredScopes: ['pages:write'],
        allowedSiteOrigins: [siteOrigin],
      });

      const result = await adapter.publish({
        ...command,
        publicationId: `${command.publicationId}-${mode}`,
        idempotencyKey: `${command.idempotencyKey}-${mode}`,
      });
      expect(result.outcome, `expected draft status, received ${mode}`).not.toBe('APPLIED');
      const snapshot = server.snapshot();
      expect(snapshot.objects.filter((object) => object.status === 'publish')).toHaveLength(0);
      if (mode === 'PUBLISH_INSTEAD_OF_DRAFT') {
        expect(snapshot.objects).toHaveLength(1);
        expect(snapshot.objects[0]?.status).toBe('trash');
      } else {
        expect(snapshot.objects).toHaveLength(0);
      }
    }
  });

  test('validates supported REST authorization over TLS and rejects missing scope or insecure application passwords before effects', async () => {
    const serverConstructor = (
      AdapterRuntime as unknown as {
        VersionedFakeWordPressServer?: VersionedFakeWordPressServerConstructor;
      }
    ).VersionedFakeWordPressServer;
    const adapterConstructor = (
      AdapterRuntime as unknown as {
        WordPressWooCommerceDraftPublicationAdapter?: WordPressWooCommerceDraftAdapterConstructor;
      }
    ).WordPressWooCommerceDraftPublicationAdapter;
    if (serverConstructor === undefined || adapterConstructor === undefined) {
      throw new Error('scope validation missing');
    }

    for (const mechanism of ['OAUTH', 'APPLICATION_PASSWORD', 'APPROVED_TOKEN'] as const) {
      const server = new serverConstructor({
        apiVersion: providerApiVersion,
        siteOrigin,
        authorization: {
          mechanism,
          scopes: ['pages:write'],
          credential: credentialSentinel,
        },
        log: () => undefined,
      });
      const adapter = new adapterConstructor({
        adapterKey: 'wordpress-woocommerce-draft',
        adapterVersion,
        providerApiVersion,
        server,
        requiredScopes: ['pages:write'],
        allowedSiteOrigins: [siteOrigin],
      });
      await expect(adapter.validateAuthorization(command)).resolves.toEqual({ outcome: 'VALID' });
      expect(server.snapshot().objects).toHaveLength(0);
    }

    const insufficientServer = new serverConstructor({
      apiVersion: providerApiVersion,
      siteOrigin,
      authorization: {
        mechanism: 'OAUTH',
        scopes: ['pages:read'],
        credential: credentialSentinel,
      },
      log: () => undefined,
    });
    const insufficientAdapter = new adapterConstructor({
      adapterKey: 'wordpress-woocommerce-draft',
      adapterVersion,
      providerApiVersion,
      server: insufficientServer,
      requiredScopes: ['pages:write'],
      allowedSiteOrigins: [siteOrigin],
    });
    await expect(insufficientAdapter.validateAuthorization(command)).resolves.toEqual({
      outcome: 'INVALID',
      errorCode: 'WORDPRESS_SCOPE_INSUFFICIENT',
    });
    await expect(insufficientAdapter.publish(command)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'WORDPRESS_SCOPE_INSUFFICIENT',
    });
    expect(insufficientServer.snapshot().objects).toHaveLength(0);

    const insecureOrigin = 'http://cms-insecure.example.test';
    const insecureServer = new serverConstructor({
      apiVersion: providerApiVersion,
      siteOrigin: insecureOrigin,
      authorization: {
        mechanism: 'APPLICATION_PASSWORD',
        scopes: ['pages:write'],
        credential: credentialSentinel,
      },
      log: () => undefined,
    });
    const insecureAdapter = new adapterConstructor({
      adapterKey: 'wordpress-woocommerce-draft',
      adapterVersion,
      providerApiVersion,
      server: insecureServer,
      requiredScopes: ['pages:write'],
      allowedSiteOrigins: [insecureOrigin],
    });
    const insecureCommand = {
      ...command,
      target: { ...command.target, siteOrigin: insecureOrigin },
    };
    await expect(insecureAdapter.validateAuthorization(insecureCommand)).resolves.toEqual({
      outcome: 'INVALID',
      errorCode: 'WORDPRESS_TLS_REQUIRED',
    });
    await expect(insecureAdapter.publish(insecureCommand)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'WORDPRESS_TLS_REQUIRED',
    });
    expect(insecureServer.snapshot().objects).toHaveLength(0);
  });

  test('uses strict canonical site and draft targets while deriving least-privilege scopes per destination', () => {
    const runtime = AdapterRuntime as unknown as {
      encodeWordPressSiteAuthorizationTarget?: (
        input: WordPressSiteAuthorizationTargetV1,
      ) => string;
      decodeWordPressSiteAuthorizationTarget?: (
        target: string,
      ) => WordPressSiteAuthorizationTargetV1;
      encodeWordPressDraftTarget?: (input: WordPressDraftTargetV1) => string;
      decodeWordPressDraftTarget?: (target: string) => WordPressDraftTargetV1;
      wordpressAuthorizationTargetFor?: (publicationTarget: string) => string;
      wordpressAuthorizationCovers?: (
        authorizationTarget: string,
        publicationTarget: string,
      ) => boolean;
      wordpressRequiredScopesFor?: (input: { target: string; assetRefs: string[] }) => string[];
    };
    expect(runtime.encodeWordPressSiteAuthorizationTarget, 'site target codec missing').toBeTypeOf(
      'function',
    );
    expect(runtime.encodeWordPressDraftTarget, 'draft target codec missing').toBeTypeOf('function');
    if (
      runtime.encodeWordPressSiteAuthorizationTarget === undefined ||
      runtime.decodeWordPressSiteAuthorizationTarget === undefined ||
      runtime.encodeWordPressDraftTarget === undefined ||
      runtime.decodeWordPressDraftTarget === undefined ||
      runtime.wordpressAuthorizationTargetFor === undefined ||
      runtime.wordpressAuthorizationCovers === undefined ||
      runtime.wordpressRequiredScopesFor === undefined
    ) {
      throw new Error('WordPress target codec missing');
    }
    const encodeSiteTarget = runtime.encodeWordPressSiteAuthorizationTarget;
    const encodeDraftTarget = runtime.encodeWordPressDraftTarget;

    const siteTarget: WordPressSiteAuthorizationTargetV1 = {
      schemaVersion: 'wordpress-site-auth.v1',
      siteUrl: `${siteOrigin}/blog`,
      authMode: 'APPLICATION_PASSWORD',
    };
    const pageTarget: WordPressDraftTargetV1 = {
      schemaVersion: 'wordpress-draft-target.v1',
      siteUrl: siteTarget.siteUrl,
      authMode: siteTarget.authMode,
      destination: { kind: 'PAGE', operation: 'CREATE', slug: 'approved-answer-guide' },
    };
    const secondPageTarget: WordPressDraftTargetV1 = {
      ...pageTarget,
      destination: { kind: 'PAGE', operation: 'CREATE', slug: 'second-approved-guide' },
    };
    const encodedSite = runtime.encodeWordPressSiteAuthorizationTarget(siteTarget);
    const encodedPage = runtime.encodeWordPressDraftTarget(pageTarget);
    const encodedSecondPage = runtime.encodeWordPressDraftTarget(secondPageTarget);
    expect(runtime.decodeWordPressSiteAuthorizationTarget(encodedSite)).toEqual(siteTarget);
    expect(runtime.decodeWordPressDraftTarget(encodedPage)).toEqual(pageTarget);
    expect(runtime.wordpressAuthorizationTargetFor(encodedPage)).toBe(encodedSite);
    expect(runtime.wordpressAuthorizationTargetFor(encodedSecondPage)).toBe(encodedSite);
    expect(runtime.wordpressAuthorizationCovers(encodedSite, encodedPage)).toBe(true);
    expect(runtime.wordpressAuthorizationCovers(encodedSite, encodedSecondPage)).toBe(true);
    expect(
      runtime.wordpressAuthorizationCovers(
        runtime.encodeWordPressSiteAuthorizationTarget({
          ...siteTarget,
          siteUrl: 'https://other-cms.example.test',
        }),
        encodedPage,
      ),
    ).toBe(false);
    expect(runtime.wordpressRequiredScopesFor({ target: encodedPage, assetRefs: [] })).toEqual([
      'pages:write',
    ]);
    expect(
      runtime.wordpressRequiredScopesFor({ target: encodedPage, assetRefs: ['asset-1'] }),
    ).toEqual(['media:write', 'pages:write']);
    const postTarget = runtime.encodeWordPressDraftTarget({
      ...pageTarget,
      destination: {
        kind: 'POST',
        operation: 'CREATE',
        slug: 'approved-post',
        categoryIds: [2, 9],
      },
    });
    const productTarget = runtime.encodeWordPressDraftTarget({
      ...pageTarget,
      destination: {
        kind: 'PRODUCT',
        operation: 'UPDATE',
        slug: 'approved-product',
        categoryIds: [7],
        remoteId: 41,
      },
    });
    expect(runtime.wordpressRequiredScopesFor({ target: postTarget, assetRefs: [] })).toEqual([
      'posts:write',
    ]);
    expect(runtime.wordpressRequiredScopesFor({ target: productTarget, assetRefs: [] })).toEqual([
      'woocommerce:products:write',
    ]);

    const invalidSites = [
      { ...siteTarget, siteUrl: 'http://cms.example.test' },
      { ...siteTarget, siteUrl: 'https://user@cms.example.test' },
      { ...siteTarget, siteUrl: 'https://cms.example.test/blog?preview=1' },
      { ...siteTarget, unexpected: 'secret' },
    ];
    for (const invalid of invalidSites) {
      expect(() => encodeSiteTarget(invalid)).toThrow('WORDPRESS_TARGET_INVALID');
    }
    const invalidDrafts: unknown[] = [
      { ...pageTarget, destination: { ...pageTarget.destination, slug: '../outside' } },
      {
        ...pageTarget,
        destination: {
          kind: 'POST',
          operation: 'CREATE',
          slug: 'post',
          categoryIds: [9, 2],
        },
      },
      {
        ...pageTarget,
        destination: {
          kind: 'POST',
          operation: 'CREATE',
          slug: 'post',
          categoryIds: [2, 2],
        },
      },
      {
        ...pageTarget,
        destination: {
          kind: 'PAGE',
          operation: 'CREATE',
          slug: 'page',
          remoteId: 1,
        },
      },
      {
        ...pageTarget,
        destination: { kind: 'PAGE', operation: 'UPDATE', slug: 'page' },
      },
    ];
    for (const invalid of invalidDrafts) {
      expect(() => encodeDraftTarget(invalid as WordPressDraftTargetV1)).toThrow(
        'WORDPRESS_TARGET_INVALID',
      );
    }
  });

  test('maps posts and WooCommerce products only to official draft routes and exports when the plugin endpoint is absent', async () => {
    const serverConstructor = (
      AdapterRuntime as unknown as {
        VersionedFakeWordPressServer?: VersionedFakeWordPressServerConstructor;
      }
    ).VersionedFakeWordPressServer;
    const adapterConstructor = (
      AdapterRuntime as unknown as {
        WordPressWooCommerceDraftPublicationAdapter?: WordPressWooCommerceDraftAdapterConstructor;
      }
    ).WordPressWooCommerceDraftPublicationAdapter;
    if (serverConstructor === undefined || adapterConstructor === undefined) {
      throw new Error('expected draft status, received 404');
    }

    const createHarness = (woocommerceApiVersion: 'wc/v3' | null = 'wc/v3') => {
      const server = new serverConstructor({
        apiVersion: providerApiVersion,
        woocommerceApiVersion,
        siteOrigin,
        authorization: {
          mechanism: 'OAUTH',
          scopes: ['pages:write', 'posts:write', 'woocommerce:products:write'],
          credential: credentialSentinel,
        },
        log: () => undefined,
      });
      const adapter = new adapterConstructor({
        adapterKey: 'wordpress-woocommerce-draft',
        adapterVersion,
        providerApiVersion,
        server,
        requiredScopes: [],
        allowedSiteOrigins: [siteOrigin],
      });
      return { adapter, server };
    };

    const postHarness = createHarness();
    const postCommand: WordPressPageDraftCommand = {
      ...command,
      publicationId: `${command.publicationId}-post`,
      idempotencyKey: `${command.idempotencyKey}-post`,
      target: {
        siteOrigin,
        contentKind: 'POST',
        slug: 'approved-answer-post',
        categoryIds: [2, 9],
      },
    };
    const post = await postHarness.adapter.publish(postCommand);
    expect(post).toMatchObject({
      outcome: 'APPLIED',
      status: 'DRAFT',
      isProductionLive: false,
      rollbackHandle: { resource: '/wp/v2/posts' },
    });
    expect(postHarness.server.snapshot()).toMatchObject({
      draftCreateCount: 1,
      publishedCreateCount: 0,
      objects: [
        {
          requestPath: '/wp-json/wp/v2/posts',
          status: 'draft',
          slug: 'approved-answer-post',
          categoryIds: [2, 9],
        },
      ],
    });

    const productHarness = createHarness();
    const productCommand: WordPressPageDraftCommand = {
      ...command,
      publicationId: `${command.publicationId}-product`,
      idempotencyKey: `${command.idempotencyKey}-product`,
      target: {
        siteOrigin,
        contentKind: 'PRODUCT',
        slug: 'approved-answer-product',
        categoryIds: [7],
      },
    };
    const product = await productHarness.adapter.publish(productCommand);
    expect(product).toMatchObject({
      outcome: 'APPLIED',
      status: 'DRAFT',
      isProductionLive: false,
      rollbackHandle: { resource: '/wc/v3/products' },
    });
    expect(productHarness.server.snapshot()).toMatchObject({
      draftCreateCount: 1,
      publishedCreateCount: 0,
      objects: [
        {
          requestPath: '/wp-json/wc/v3/products',
          status: 'draft',
          slug: 'approved-answer-product',
          categoryIds: [7],
        },
      ],
    });

    const missingPluginHarness = createHarness(null);
    await expect(missingPluginHarness.adapter.publish(productCommand)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'WOOCOMMERCE_ENDPOINT_UNAVAILABLE',
      fallback: 'EXPORT_ONLY',
      packageChecksum: productCommand.packageChecksum,
    });
    expect(missingPluginHarness.server.snapshot().objects).toHaveLength(0);
  });

  test('reuses one draft across fresh local retries and rejects a same-slug different revision', async () => {
    const serverConstructor = (
      AdapterRuntime as unknown as {
        VersionedFakeWordPressServer?: VersionedFakeWordPressServerConstructor;
      }
    ).VersionedFakeWordPressServer;
    const adapterConstructor = (
      AdapterRuntime as unknown as {
        WordPressWooCommerceDraftPublicationAdapter?: WordPressWooCommerceDraftAdapterConstructor;
      }
    ).WordPressWooCommerceDraftPublicationAdapter;
    if (serverConstructor === undefined || adapterConstructor === undefined) {
      throw new Error('duplicate remote object count >1');
    }
    const server = new serverConstructor({
      apiVersion: providerApiVersion,
      siteOrigin,
      authorization: {
        mechanism: 'OAUTH',
        scopes: ['pages:write'],
        credential: credentialSentinel,
      },
      log: () => undefined,
    });
    const adapter = new adapterConstructor({
      adapterKey: 'wordpress-woocommerce-draft',
      adapterVersion,
      providerApiVersion,
      server,
      requiredScopes: ['pages:write'],
      allowedSiteOrigins: [siteOrigin],
    });

    const first = await adapter.publish(command);
    const freshLocalRetry = await adapter.publish({
      ...command,
      publicationId: '00000000-0000-7000-8000-000000001299',
      idempotencyKey: 'fresh-local-retry-key',
    });
    expect(first.outcome).toBe('APPLIED');
    expect(freshLocalRetry).toEqual(first);
    expect(server.snapshot().objects, 'duplicate remote object count >1').toHaveLength(1);
    expect(server.snapshot().draftCreateCount, 'duplicate remote object count >1').toBe(1);

    const differentRevision: WordPressPageDraftCommand = {
      ...command,
      publicationId: '00000000-0000-7000-8000-000000001298',
      idempotencyKey: 'different-approved-revision',
      packageChecksum: 'c'.repeat(64),
      artifact: {
        ...command.artifact,
        artifactRevisionId: '00000000-0000-7000-8000-000000001298',
        revision: command.artifact.revision + 1,
        contentHash: 'd'.repeat(64),
      },
      files: {
        ...command.files,
        'content.html': '<h1>Different approved revision</h1>',
      },
    };
    await expect(adapter.publish(differentRevision)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'WORDPRESS_SLUG_CONFLICT',
      fallback: 'EXPORT_ONLY',
      packageChecksum: differentRevision.packageChecksum,
    });
    expect(server.snapshot().objects).toHaveLength(1);
    expect(server.snapshot().objects[0]?.revisionMapping.artifactRevisionId).toBe(
      command.artifact.artifactRevisionId,
    );
  });

  test('reconciles a timeout after effect to the same exact draft without a duplicate write', async () => {
    const serverConstructor = (
      AdapterRuntime as unknown as {
        VersionedFakeWordPressServer?: VersionedFakeWordPressServerConstructor;
      }
    ).VersionedFakeWordPressServer;
    const adapterConstructor = (
      AdapterRuntime as unknown as {
        WordPressWooCommerceDraftPublicationAdapter?: WordPressWooCommerceDraftAdapterConstructor;
      }
    ).WordPressWooCommerceDraftPublicationAdapter;
    if (serverConstructor === undefined || adapterConstructor === undefined) {
      throw new Error('reconcile missing');
    }
    const server = new serverConstructor({
      apiVersion: providerApiVersion,
      siteOrigin,
      authorization: {
        mechanism: 'APPROVED_TOKEN',
        scopes: ['pages:write'],
        credential: credentialSentinel,
      },
      log: () => undefined,
    });
    const adapter = new adapterConstructor({
      adapterKey: 'wordpress-woocommerce-draft',
      adapterVersion,
      providerApiVersion,
      server,
      requiredScopes: ['pages:write'],
      allowedSiteOrigins: [siteOrigin],
    });
    server.queueFailure('TIMEOUT_AFTER_EFFECT');
    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'WORDPRESS_REMOTE_TIMEOUT',
    });
    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'WORDPRESS_RECONCILE_REQUIRED',
    });
    expect(server.snapshot().objects, 'duplicate remote object count >1').toHaveLength(1);

    const reconciled = await adapter.reconcile(command);
    expect(reconciled).toMatchObject({
      outcome: 'APPLIED',
      remoteId: 1,
      status: 'DRAFT',
      isProductionLive: false,
      revisionMapping: {
        artifactRevisionId: command.artifact.artifactRevisionId,
        artifactContentHash: command.artifact.contentHash,
        packageChecksum: command.packageChecksum,
      },
    });
    expect(server.snapshot().objects).toHaveLength(1);
    expect(server.snapshot().draftCreateCount).toBe(1);
  });

  test('trashes only the exact owned draft from a persisted rollback handle and is idempotent', async () => {
    const serverConstructor = (
      AdapterRuntime as unknown as {
        VersionedFakeWordPressServer?: VersionedFakeWordPressServerConstructor;
      }
    ).VersionedFakeWordPressServer;
    const adapterConstructor = (
      AdapterRuntime as unknown as {
        WordPressWooCommerceDraftPublicationAdapter?: WordPressWooCommerceDraftAdapterConstructor;
      }
    ).WordPressWooCommerceDraftPublicationAdapter;
    if (serverConstructor === undefined || adapterConstructor === undefined) {
      throw new Error('draft rollback missing');
    }
    const server = new serverConstructor({
      apiVersion: providerApiVersion,
      siteOrigin,
      authorization: {
        mechanism: 'OAUTH',
        scopes: ['pages:write'],
        credential: credentialSentinel,
      },
      log: () => undefined,
    });
    const adapter = new adapterConstructor({
      adapterKey: 'wordpress-woocommerce-draft',
      adapterVersion,
      providerApiVersion,
      server,
      requiredScopes: ['pages:write'],
      allowedSiteOrigins: [siteOrigin],
    });
    const published = await adapter.publish(command);
    expect(published.outcome).toBe('APPLIED');
    if (published.outcome !== 'APPLIED') throw new Error('expected a draft rollback handle');

    await expect(
      adapter.rollback({
        ...command,
        rollbackHandle: { ...published.rollbackHandle, remoteId: published.remoteId + 1 },
      }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_ROLLED_BACK',
      errorCode: 'WORDPRESS_ROLLBACK_TARGET_MISMATCH',
    });
    expect(server.snapshot().objects[0]?.status).toBe('draft');

    const rollbackCommand = { ...command, rollbackHandle: published.rollbackHandle };
    const rolledBack = await adapter.rollback(rollbackCommand);
    expect(rolledBack).toEqual({
      outcome: 'ROLLED_BACK',
      remoteRef: published.remoteRef,
      status: 'TRASH',
      rollbackHandle: published.rollbackHandle,
    });
    expect(server.snapshot().objects[0]?.status).toBe('trash');
    await expect(adapter.rollback(rollbackCommand)).resolves.toEqual(rolledBack);

    const secondCommand = {
      ...command,
      target: { ...command.target, slug: 'published-object-must-not-be-trashed' },
    };
    const second = await adapter.publish(secondCommand);
    expect(second.outcome).toBe('APPLIED');
    if (second.outcome !== 'APPLIED') throw new Error('expected second draft');
    server.setObjectStatus(second.remoteId, 'publish');
    await expect(
      adapter.rollback({ ...secondCommand, rollbackHandle: second.rollbackHandle }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_ROLLED_BACK',
      errorCode: 'WORDPRESS_ROLLBACK_REJECTED',
    });
    expect(server.snapshot().objects.find((object) => object.id === second.remoteId)?.status).toBe(
      'publish',
    );
  });

  test('validates every approved media asset checksum before effects and uploads valid media only through wp/v2/media', async () => {
    const serverConstructor = (
      AdapterRuntime as unknown as {
        VersionedFakeWordPressServer?: VersionedFakeWordPressServerConstructor;
      }
    ).VersionedFakeWordPressServer;
    const adapterConstructor = (
      AdapterRuntime as unknown as {
        WordPressWooCommerceDraftPublicationAdapter?: WordPressWooCommerceDraftAdapterConstructor;
      }
    ).WordPressWooCommerceDraftPublicationAdapter;
    if (serverConstructor === undefined || adapterConstructor === undefined) {
      throw new Error('media checksum validation missing');
    }
    const server = new serverConstructor({
      apiVersion: providerApiVersion,
      siteOrigin,
      authorization: {
        mechanism: 'OAUTH',
        scopes: ['media:write', 'pages:write'],
        credential: credentialSentinel,
      },
      log: () => undefined,
    });
    const adapter = new adapterConstructor({
      adapterKey: 'wordpress-woocommerce-draft',
      adapterVersion,
      providerApiVersion,
      server,
      requiredScopes: ['media:write', 'pages:write'],
      allowedSiteOrigins: [siteOrigin],
    });
    const bytes = new TextEncoder().encode('approved-media-bytes');
    const assetRef = 'asset://approved/hero-image';
    const mediaCommand: WordPressPageDraftCommand = {
      ...command,
      target: { ...command.target, slug: 'approved-guide-with-media' },
      assetRefs: [assetRef],
      media: [
        {
          assetRef,
          filename: 'hero-image.webp',
          mediaType: 'image/webp',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes,
        },
      ],
    };
    await expect(
      adapter.publish({
        ...mediaCommand,
        media: [{ ...mediaCommand.media![0]!, sha256: '0'.repeat(64) }],
      }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'WORDPRESS_MEDIA_CHECKSUM_MISMATCH',
      fallback: 'EXPORT_ONLY',
      packageChecksum: mediaCommand.packageChecksum,
    });
    expect(server.snapshot()).toMatchObject({
      mediaCreateCount: 0,
      draftCreateCount: 0,
      objects: [],
      media: [],
    });

    const result = await adapter.publish(mediaCommand);
    expect(result).toMatchObject({ outcome: 'APPLIED', status: 'DRAFT' });
    expect(server.snapshot()).toMatchObject({
      mediaCreateCount: 1,
      draftCreateCount: 1,
      media: [
        {
          requestPath: '/wp-json/wp/v2/media',
          assetRef,
          filename: 'hero-image.webp',
          mediaType: 'image/webp',
          sha256: mediaCommand.media![0]!.sha256,
        },
      ],
    });
    const duplicate = await adapter.publish({
      ...mediaCommand,
      publicationId: `${mediaCommand.publicationId}-media-retry`,
      idempotencyKey: `${mediaCommand.idempotencyKey}-media-retry`,
    });
    expect(duplicate).toEqual(result);
    expect(server.snapshot().mediaCreateCount).toBe(1);
    expect(server.snapshot().objects).toHaveLength(1);
  });

  test('embeds bounded JSON-LD without script escape while preserving reviewed unknown fields for export', async () => {
    const serverConstructor = (
      AdapterRuntime as unknown as {
        VersionedFakeWordPressServer?: VersionedFakeWordPressServerConstructor;
      }
    ).VersionedFakeWordPressServer;
    const adapterConstructor = (
      AdapterRuntime as unknown as {
        WordPressWooCommerceDraftPublicationAdapter?: WordPressWooCommerceDraftAdapterConstructor;
      }
    ).WordPressWooCommerceDraftPublicationAdapter;
    if (serverConstructor === undefined || adapterConstructor === undefined) {
      throw new Error('JSON-LD safe handling missing');
    }
    const server = new serverConstructor({
      apiVersion: providerApiVersion,
      siteOrigin,
      authorization: {
        mechanism: 'OAUTH',
        scopes: ['pages:write'],
        credential: credentialSentinel,
      },
      log: () => undefined,
    });
    const adapter = new adapterConstructor({
      adapterKey: 'wordpress-woocommerce-draft',
      adapterVersion,
      providerApiVersion,
      server,
      requiredScopes: ['pages:write'],
      allowedSiteOrigins: [siteOrigin],
    });
    const reviewedJsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'Approved answer guide',
      reviewedUnknownExtension: {
        payload: '</script><script>globalThis.compromised=true</script>\u2028safe',
      },
    });
    const safeCommand: WordPressPageDraftCommand = {
      ...command,
      target: { ...command.target, slug: 'approved-safe-json-ld' },
      files: { ...command.files, 'structured-data.json': reviewedJsonLd },
    };
    const safe = await adapter.publish(safeCommand);
    expect(safe.outcome).toBe('APPLIED');
    const remoteContent = server.snapshot().objects[0]?.content ?? '';
    expect(remoteContent).not.toContain('</script><script>');
    expect(remoteContent).toContain('\\u003c/script\\u003e\\u003cscript\\u003e');
    expect(remoteContent.match(/<script type="application\/ld\+json">/gu)).toHaveLength(1);
    expect(safeCommand.files['structured-data.json']).toBe(reviewedJsonLd);
    expect(JSON.parse(safeCommand.files['structured-data.json'])).toHaveProperty(
      'reviewedUnknownExtension.payload',
    );

    let nested: unknown = 'leaf';
    for (let depth = 0; depth < 70; depth += 1) nested = { child: nested };
    const unsafeCommand: WordPressPageDraftCommand = {
      ...command,
      target: { ...command.target, slug: 'unsafe-json-ld-must-not-write' },
      files: {
        ...command.files,
        'structured-data.json': JSON.stringify({ '@context': 'https://schema.org', nested }),
      },
    };
    await expect(adapter.publish(unsafeCommand)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'WORDPRESS_JSON_LD_UNSAFE',
      fallback: 'EXPORT_ONLY',
      packageChecksum: unsafeCommand.packageChecksum,
    });
    expect(server.snapshot().objects).toHaveLength(1);
    expect(server.snapshot().objects[0]?.slug).toBe('approved-safe-json-ld');
  });

  test('fails to reviewed export with zero effects when the official REST schema is not writable', async () => {
    const serverConstructor = (
      AdapterRuntime as unknown as {
        VersionedFakeWordPressServer?: VersionedFakeWordPressServerConstructor;
      }
    ).VersionedFakeWordPressServer;
    const adapterConstructor = (
      AdapterRuntime as unknown as {
        WordPressWooCommerceDraftPublicationAdapter?: WordPressWooCommerceDraftAdapterConstructor;
      }
    ).WordPressWooCommerceDraftPublicationAdapter;
    if (serverConstructor === undefined || adapterConstructor === undefined) {
      throw new Error('schema validation missing');
    }
    const server = new serverConstructor({
      apiVersion: providerApiVersion,
      siteOrigin,
      writableFields: ['slug', 'title', 'content'],
      authorization: {
        mechanism: 'OAUTH',
        scopes: ['pages:write'],
        credential: credentialSentinel,
      },
      log: () => undefined,
    });
    const adapter = new adapterConstructor({
      adapterKey: 'wordpress-woocommerce-draft',
      adapterVersion,
      providerApiVersion,
      server,
      requiredScopes: ['pages:write'],
      allowedSiteOrigins: [siteOrigin],
    });
    const originalFiles = structuredClone(command.files);
    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'WORDPRESS_SCHEMA_UNSUPPORTED',
      fallback: 'EXPORT_ONLY',
      packageChecksum: command.packageChecksum,
    });
    expect(server.snapshot()).toMatchObject({
      draftCreateCount: 0,
      mediaCreateCount: 0,
      objects: [],
      media: [],
    });
    expect(command.files).toEqual(originalFiles);
  });

  test('updates only the explicitly selected owned draft and never changes an already published object', async () => {
    const serverConstructor = (
      AdapterRuntime as unknown as {
        VersionedFakeWordPressServer?: VersionedFakeWordPressServerConstructor;
      }
    ).VersionedFakeWordPressServer;
    const adapterConstructor = (
      AdapterRuntime as unknown as {
        WordPressWooCommerceDraftPublicationAdapter?: WordPressWooCommerceDraftAdapterConstructor;
      }
    ).WordPressWooCommerceDraftPublicationAdapter;
    if (serverConstructor === undefined || adapterConstructor === undefined) {
      throw new Error('WordPress draft update missing');
    }
    const server = new serverConstructor({
      apiVersion: providerApiVersion,
      siteOrigin,
      authorization: {
        mechanism: 'OAUTH',
        scopes: ['pages:write'],
        credential: credentialSentinel,
      },
      log: () => undefined,
    });
    const adapter = new adapterConstructor({
      adapterKey: 'wordpress-woocommerce-draft',
      adapterVersion,
      providerApiVersion,
      server,
      requiredScopes: ['pages:write'],
      allowedSiteOrigins: [siteOrigin],
    });
    const first = await adapter.publish(command);
    expect(first.outcome).toBe('APPLIED');
    if (first.outcome !== 'APPLIED') throw new Error('expected original draft');

    const updateCommand: WordPressPageDraftCommand = {
      ...command,
      publicationId: `${command.publicationId}-update`,
      idempotencyKey: `${command.idempotencyKey}-update`,
      packageChecksum: 'e'.repeat(64),
      artifact: {
        ...command.artifact,
        artifactRevisionId: '00000000-0000-7000-8000-000000001297',
        revision: command.artifact.revision + 1,
        contentHash: 'f'.repeat(64),
      },
      target: { ...command.target, remoteId: first.remoteId },
      document: { ...command.document, summary: 'Updated exact approved summary.' },
      files: {
        ...command.files,
        'content.html': '<h1>Approved answer guide</h1><p>Updated exact approved body.</p>',
      },
    };
    const updated = await adapter.publish(updateCommand);
    expect(updated).toMatchObject({
      outcome: 'APPLIED',
      remoteId: first.remoteId,
      status: 'DRAFT',
    });
    expect(server.snapshot()).toMatchObject({
      draftCreateCount: 1,
      contentUpdateCount: 1,
      objects: [
        {
          id: first.remoteId,
          status: 'draft',
          revisionMapping: {
            artifactRevisionId: updateCommand.artifact.artifactRevisionId,
            artifactContentHash: updateCommand.artifact.contentHash,
            packageChecksum: updateCommand.packageChecksum,
          },
        },
      ],
    });

    server.setObjectStatus(first.remoteId, 'publish');
    const forbiddenUpdate = {
      ...updateCommand,
      packageChecksum: '1'.repeat(64),
      artifact: { ...updateCommand.artifact, contentHash: '2'.repeat(64) },
    };
    await expect(adapter.publish(forbiddenUpdate)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'WORDPRESS_UPDATE_TARGET_MISMATCH',
      fallback: 'EXPORT_ONLY',
      packageChecksum: forbiddenUpdate.packageChecksum,
    });
    expect(server.snapshot().contentUpdateCount).toBe(1);
    expect(server.snapshot().objects[0]?.status).toBe('publish');
  });
});
