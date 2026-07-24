import { describe, expect, test, vi } from 'vitest';

import {
  ProductionWordPressWooCommerceDraftPublicationAdapter,
  type SafeWordPressJsonHttpRequest,
} from '../../packages/adapters/src/publication/production-wordpress-woocommerce-draft-publication-adapter.js';
import type {
  PublicationAdapterCommand,
  PublicationAdapterDescriptor,
} from '@aeostudio/application/channels-publishing';
import {
  encodeWordPressDraftTarget,
  encodeWordPressSiteAuthorizationTarget,
} from '@aeostudio/contracts/channels';
import type {
  ChannelPackagePayload,
  ChannelPackageRecord,
} from '@aeostudio/domain/channels-publishing';

describe('production WordPress/WooCommerce draft publication Adapter', () => {
  test('derives write scopes from authenticated provider capabilities, not credential claims', async () => {
    const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
      expect(input.method).toBe('GET');
      expect(input.url).toBe('https://cms.example.test/wp-json/wp/v2/users/me?context=edit');
      return Promise.resolve({
        status: 200,
        headers: {},
        body: {
          capabilities: {
            upload_files: true,
            edit_pages: true,
            edit_posts: true,
            edit_products: false,
          },
        },
      });
    });
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });
    const command = wordpressCommand();
    const authorizationTarget = encodeWordPressSiteAuthorizationTarget({
      schemaVersion: 'wordpress-site-auth.v1',
      siteUrl: 'https://cms.example.test',
      authMode: 'APPLICATION_PASSWORD',
    });

    await expect(
      adapter.validateChannelAuthorization?.({
        tenantId: command.channelPackage.tenantId,
        workspaceId: command.channelPackage.workspaceId,
        channelDefinitionId: command.channelPackage.channel.definitionId,
        target: authorizationTarget,
        requestedScopes: ['media:write', 'pages:write', 'posts:write'],
        acceptedTermsVersion: 'wordpress-production-terms-v1',
        secretValue: command.secretValue,
      }),
    ).resolves.toEqual({
      outcome: 'VERIFIED',
      actualTarget: authorizationTarget,
      actualScopes: ['media:write', 'pages:write', 'posts:write'],
    });
  });

  test('fails closed when WordPress revokes provider capabilities after initial verification', async () => {
    const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
      expect(input).toMatchObject({
        method: 'GET',
        url: 'https://cms.example.test/wp-json/wp/v2/users/me?context=edit',
      });
      return Promise.resolve({
        status: 200,
        headers: {},
        body: {
          capabilities: {
            upload_files: true,
            edit_pages: false,
            edit_posts: true,
            edit_products: false,
          },
        },
      });
    });
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });

    await expect(adapter.validateAuthorization(wordpressCommand())).resolves.toEqual({
      outcome: 'INVALID',
      reason: 'SCOPE_INSUFFICIENT',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.some(([input]) => input.method !== 'GET')).toBe(false);
  });

  test('creates one page draft with a durable AEOStudio marker and reconciles it without process state', async () => {
    let storedDraft: Record<string, unknown> | null = null;
    const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
      if (input.method === 'GET' && input.url.includes('?slug=')) {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: storedDraft === null ? [] : [storedDraft],
        });
      }
      if (input.method === 'POST' && input.url === 'https://cms.example.test/wp-json/wp/v2/pages') {
        const body = input.body as Record<string, unknown>;
        storedDraft = { id: 41, ...body };
        return Promise.resolve({ status: 201, headers: {}, body: storedDraft });
      }
      throw new Error(`UNEXPECTED_WORDPRESS_REQUEST:${input.method}:${input.url}`);
    });
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });
    const command = wordpressCommand();

    const published = await adapter.publish(command);

    expect(published).toEqual({
      outcome: 'APPLIED',
      remoteRef: 'https://cms.example.test/wp-admin/post.php?post=41&action=edit',
      remoteState: {
        status: 'DRAFT',
        number: 41,
        isProductionLive: false,
        rollbackHandle: {
          operation: 'TRASH_DRAFT',
          siteUrl: 'https://cms.example.test',
          resourcePath: '/wp-json/wp/v2/pages',
          remoteId: 41,
        },
      },
    });
    const stored = requireRecord(storedDraft);
    expect(stored).toMatchObject({
      status: 'draft',
      slug: 'approved-guide',
    });
    const metadata = requireRecord(requireRecord(stored.meta).aeostudio_publication);
    expect(metadata.schemaVersion).toBe('aeostudio.wordpress-publication.v1');
    expect(metadata.intent).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.checksum).toBe(command.channelPackage.packageChecksum);
    expect(requireRecord(metadata.revision)).toEqual({
      artifactRevisionId: command.channelPackage.artifact.artifactRevisionId,
      number: command.channelPackage.artifact.revision,
      contentHash: command.channelPackage.artifact.contentHash,
    });
    expect(JSON.stringify(request.mock.calls)).not.toContain(command.secretValue);

    const freshAdapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });
    await expect(freshAdapter.reconcile(command)).resolves.toEqual(published);
    expect(request.mock.calls.filter(([input]) => input.method === 'POST')).toHaveLength(1);
  });

  test('uses a standard WordPress content marker when unregistered REST meta is not persisted', async () => {
    let storedDraft: Record<string, unknown> | null = null;
    const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
      if (input.method === 'GET' && input.url.includes('?slug=')) {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: storedDraft === null ? [] : [storedDraft],
        });
      }
      if (input.method === 'POST') {
        const body = { ...(input.body as Record<string, unknown>) };
        delete body.meta;
        storedDraft = { id: 410, ...body, meta: {} };
        return Promise.resolve({ status: 201, headers: {}, body: storedDraft });
      }
      throw new Error(`UNEXPECTED_WORDPRESS_REQUEST:${input.method}:${input.url}`);
    });
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });
    const command = wordpressCommand();

    const published = await adapter.publish(command);

    expect(published).toMatchObject({
      outcome: 'APPLIED',
      remoteState: { status: 'DRAFT', number: 410, isProductionLive: false },
    });
    const stored = requireRecord(storedDraft);
    expect(stored.meta).toEqual({});
    expect(stored.content).toMatch(/<!-- aeostudio-publication:v1 [A-Za-z0-9_-]+ -->$/u);
    const freshAdapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });
    await expect(freshAdapter.reconcile(command)).resolves.toEqual(published);
  });

  test('creates a post draft with the exact approved category ids', async () => {
    const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
      if (input.method === 'GET') {
        return Promise.resolve({ status: 200, headers: {}, body: [] });
      }
      if (input.method === 'POST') {
        const body = input.body as Record<string, unknown>;
        return Promise.resolve({
          status: 201,
          headers: {},
          body: { id: 42, ...body },
        });
      }
      throw new Error(`UNEXPECTED_WORDPRESS_REQUEST:${input.method}:${input.url}`);
    });
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });
    const command = wordpressCommand({
      destination: {
        kind: 'POST',
        operation: 'CREATE',
        slug: 'approved-post',
        categoryIds: [7, 19],
      },
      scopes: ['posts:write'],
    });

    await expect(adapter.publish(command)).resolves.toMatchObject({
      outcome: 'APPLIED',
      remoteState: { status: 'DRAFT', isProductionLive: false },
    });
    expect(request.mock.calls.find(([input]) => input.method === 'POST')?.[0].body).toMatchObject({
      status: 'draft',
      slug: 'approved-post',
      categories: [7, 19],
    });
  });

  test('creates a WooCommerce product draft with provider-native fields and the same ownership contract', async () => {
    const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
      if (input.method === 'GET') {
        return Promise.resolve({ status: 200, headers: {}, body: [] });
      }
      if (input.method === 'POST') {
        const body = input.body as Record<string, unknown>;
        const metadata = (body.meta_data as Array<{ key: string; value: unknown }>)[0]?.value;
        return Promise.resolve({
          status: 201,
          headers: {},
          body: {
            id: 43,
            status: body.status,
            slug: body.slug,
            name: body.name,
            description: body.description,
            categories: body.categories,
            meta_data: [{ key: 'aeostudio_publication', value: metadata }],
          },
        });
      }
      throw new Error(`UNEXPECTED_WORDPRESS_REQUEST:${input.method}:${input.url}`);
    });
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });
    const command = wordpressCommand({
      destination: {
        kind: 'PRODUCT',
        operation: 'CREATE',
        slug: 'approved-product',
        categoryIds: [11],
      },
      scopes: ['woocommerce:products:write'],
    });

    await expect(adapter.publish(command)).resolves.toMatchObject({
      outcome: 'APPLIED',
      remoteState: { status: 'DRAFT', number: 43, isProductionLive: false },
    });
    const productRequest = request.mock.calls.find(([input]) => input.method === 'POST')?.[0];
    expect(productRequest).toBeDefined();
    if (productRequest === undefined) throw new Error('PRODUCT_REQUEST_REQUIRED');
    const productBody = requireRecord(productRequest.body);
    expect(productRequest).toMatchObject({
      url: 'https://cms.example.test/wp-json/wc/v3/products',
    });
    expect(productBody).toMatchObject({
      status: 'draft',
      slug: 'approved-product',
      name: 'Approved guide',
      categories: [{ id: 11 }],
    });
    expect(productBody.description).toContain('<article>');
    expect(Array.isArray(productBody.meta_data)).toBe(true);
    if (!Array.isArray(productBody.meta_data)) throw new Error('PRODUCT_METADATA_REQUIRED');
    const metadataEntry = requireRecord(productBody.meta_data[0]);
    expect(metadataEntry.key).toBe('aeostudio_publication');
    const metadata = requireRecord(metadataEntry.value);
    expect(metadata.schemaVersion).toBe('aeostudio.wordpress-publication.v1');
    expect(metadata.intent).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.checksum).toBe(command.channelPackage.packageChecksum);
  });

  test('rolls back only the exact marked create draft by moving that object to trash', async () => {
    let storedDraft: Record<string, unknown> | null = null;
    const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
      if (input.method === 'GET' && input.url.includes('?slug=')) {
        return Promise.resolve({ status: 200, headers: {}, body: [] });
      }
      if (input.method === 'POST') {
        storedDraft = { id: 44, ...(input.body as Record<string, unknown>) };
        return Promise.resolve({ status: 201, headers: {}, body: storedDraft });
      }
      if (
        input.method === 'GET' &&
        input.url === 'https://cms.example.test/wp-json/wp/v2/pages/44?context=edit'
      ) {
        return Promise.resolve({ status: 200, headers: {}, body: storedDraft });
      }
      if (
        input.method === 'DELETE' &&
        input.url === 'https://cms.example.test/wp-json/wp/v2/pages/44?force=false'
      ) {
        storedDraft = { ...(storedDraft ?? {}), status: 'trash' };
        return Promise.resolve({ status: 200, headers: {}, body: storedDraft });
      }
      throw new Error(`UNEXPECTED_WORDPRESS_REQUEST:${input.method}:${input.url}`);
    });
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });
    const command = wordpressCommand();
    const published = await adapter.publish(command);
    if (published.outcome !== 'APPLIED') throw new Error('DRAFT_REQUIRED');

    await expect(
      adapter.rollback?.({ ...command, remoteRef: published.remoteRef }),
    ).resolves.toEqual({
      outcome: 'ROLLED_BACK',
      remoteRef: published.remoteRef,
    });
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
      method: 'DELETE',
      url: 'https://cms.example.test/wp-json/wp/v2/pages/44?force=false',
    });
    expect(storedDraft).toMatchObject({ id: 44, status: 'trash' });

    await expect(
      adapter.rollback?.({ ...command, remoteRef: published.remoteRef }),
    ).resolves.toEqual({
      outcome: 'ROLLED_BACK',
      remoteRef: published.remoteRef,
    });
    expect(request.mock.calls.filter(([input]) => input.method === 'DELETE')).toHaveLength(1);
  });

  test.each([404, 410])(
    'treats provider status %i for the exact rollback object id as already rolled back',
    async (status) => {
      const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
        if (
          input.method === 'GET' &&
          input.url === 'https://cms.example.test/wp-json/wp/v2/pages/44?context=edit'
        ) {
          return Promise.resolve({ status, headers: {}, body: { code: 'rest_post_invalid_id' } });
        }
        throw new Error(`UNEXPECTED_WORDPRESS_REQUEST:${input.method}:${input.url}`);
      });
      const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
        descriptor: descriptor(),
        httpClient: { request },
      });
      const command = wordpressCommand();
      const remoteRef = 'https://cms.example.test/wp-admin/post.php?post=44&action=edit';

      await expect(adapter.rollback?.({ ...command, remoteRef })).resolves.toEqual({
        outcome: 'ROLLED_BACK',
        remoteRef,
      });
      expect(request.mock.calls.filter(([input]) => input.method === 'DELETE')).toHaveLength(0);
    },
  );

  test.each([
    {
      name: 'an UPDATE target',
      command: () =>
        wordpressCommand({
          destination: {
            kind: 'PAGE',
            operation: 'UPDATE',
            slug: 'approved-guide',
            remoteId: 91,
          },
        }),
      errorCode: 'WORDPRESS_UPDATE_UNSUPPORTED',
    },
    {
      name: 'an unresolved asset reference',
      command: () => wordpressCommand({ assetRefs: ['asset://approved/hero-image'] }),
      errorCode: 'WORDPRESS_ASSET_RESOLVER_UNAVAILABLE',
    },
  ])('fails closed before HTTP for $name', async ({ command, errorCode }) => {
    const request = vi.fn();
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });

    await expect(adapter.publish(command())).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode,
    });
    expect(request).not.toHaveBeenCalled();
  });

  test('rejects a draft that cannot fit the bounded create and read-back contract before HTTP', async () => {
    const request = vi.fn();
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });
    const command = wordpressCommand();
    command.payload.files['content.html'] =
      `<article><h1>Approved guide</h1><p>${'x'.repeat(512 * 1_024)}</p></article>`;

    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'WORDPRESS_DRAFT_REQUEST_TOO_LARGE',
    });
    expect(request).not.toHaveBeenCalled();
  });

  test('binds the credential envelope to the exact canonical site, auth mode, and least-privilege scope set', async () => {
    const request = vi.fn();
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });
    const targetMismatch = wordpressCommand({
      credential: { siteUrl: 'https://other.example.test' },
    });
    const scopeMismatch = wordpressCommand({
      credential: { scopes: ['pages:write', 'posts:write'] },
    });

    await expect(adapter.validateAuthorization(targetMismatch)).resolves.toEqual({
      outcome: 'INVALID',
      reason: 'TARGET_NOT_ALLOWED',
    });
    await expect(adapter.validateAuthorization(scopeMismatch)).resolves.toEqual({
      outcome: 'INVALID',
      reason: 'SCOPE_INSUFFICIENT',
    });
    await expect(
      adapter.validateAuthorization(
        wordpressCommand({ credential: { authorizationHeader: 'Basic ' } }),
      ),
    ).resolves.toEqual({
      outcome: 'INVALID',
      reason: 'TARGET_NOT_ALLOWED',
    });
    expect(request).not.toHaveBeenCalled();
  });

  test('does not create through an occupied slug when the existing draft lacks the exact ownership marker', async () => {
    const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
      if (input.method === 'GET') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: [
            {
              id: 45,
              status: 'draft',
              slug: 'approved-guide',
              meta: {},
            },
          ],
        });
      }
      throw new Error('POST_MUST_NOT_RUN_FOR_UNOWNED_SLUG');
    });
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });

    await expect(adapter.publish(wordpressCommand())).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'WORDPRESS_REMOTE_EFFECT_CONFLICT',
    });
    expect(request.mock.calls.filter(([input]) => input.method === 'POST')).toHaveLength(0);
  });

  test('does not reconcile a marked draft whose remote content no longer matches the approved package', async () => {
    let storedDraft: Record<string, unknown> | null = null;
    const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
      if (input.method === 'GET') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: storedDraft === null ? [] : [storedDraft],
        });
      }
      if (input.method === 'POST') {
        storedDraft = { id: 46, ...(input.body as Record<string, unknown>) };
        return Promise.resolve({ status: 201, headers: {}, body: storedDraft });
      }
      throw new Error(`UNEXPECTED_WORDPRESS_REQUEST:${input.method}:${input.url}`);
    });
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });
    const command = wordpressCommand();
    await expect(adapter.publish(command)).resolves.toMatchObject({ outcome: 'APPLIED' });
    storedDraft = { ...(storedDraft ?? {}), content: '<p>remote edit</p>' };

    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'WORDPRESS_REMOTE_EFFECT_CONFLICT',
    });
  });

  test('immediately trashes an exact owned create result if the provider violates draft-only status', async () => {
    let deleteCount = 0;
    const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
      if (input.method === 'GET') {
        return Promise.resolve({ status: 200, headers: {}, body: [] });
      }
      if (input.method === 'POST') {
        return Promise.resolve({
          status: 201,
          headers: {},
          body: {
            id: 47,
            ...(input.body as Record<string, unknown>),
            status: 'publish',
          },
        });
      }
      if (
        input.method === 'DELETE' &&
        input.url === 'https://cms.example.test/wp-json/wp/v2/pages/47?force=false'
      ) {
        deleteCount += 1;
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { id: 47, status: 'trash' },
        });
      }
      throw new Error(`UNEXPECTED_WORDPRESS_REQUEST:${input.method}:${input.url}`);
    });
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });

    await expect(adapter.publish(wordpressCommand())).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'WORDPRESS_NON_DRAFT_ROLLED_BACK',
    });
    expect(deleteCount).toBe(1);
  });

  test('retries exact-id compensation during page reconciliation after the first live-create rollback timed out', async () => {
    let storedPage: Record<string, unknown> | null = null;
    let deleteAttempts = 0;
    const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
      if (input.method === 'GET' && input.url.includes('?slug=')) {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: storedPage === null ? [] : [storedPage],
        });
      }
      if (input.method === 'POST') {
        storedPage = {
          id: 470,
          ...(input.body as Record<string, unknown>),
          status: 'publish',
        };
        return Promise.resolve({ status: 201, headers: {}, body: storedPage });
      }
      if (
        input.method === 'DELETE' &&
        input.url === 'https://cms.example.test/wp-json/wp/v2/pages/470?force=false'
      ) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          return Promise.reject(new Error('TIMEOUT_AFTER_LIVE_CREATE'));
        }
        storedPage = { ...(storedPage ?? {}), status: 'trash' };
        return Promise.resolve({ status: 200, headers: {}, body: storedPage });
      }
      throw new Error(`UNEXPECTED_WORDPRESS_REQUEST:${input.method}:${input.url}`);
    });
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });
    const command = wordpressCommand();

    const published = await adapter.publish(command);
    expect(published).toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'WORDPRESS_NON_DRAFT_ROLLBACK_UNKNOWN',
      reconciliationIntent: {
        kind: 'COMPENSATE_UNSAFE_CREATE',
        remoteRef: 'https://cms.example.test/wp-admin/post.php?post=470&action=edit',
      },
    });
    if (published.outcome !== 'AMBIGUOUS' || published.reconciliationIntent === undefined) {
      throw new Error('UNSAFE_CREATE_INTENT_REQUIRED');
    }
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'WORDPRESS_REMOTE_EFFECT_CONFLICT',
    });
    await expect(
      adapter.reconcile({
        ...command,
        reconciliationIntent: {
          kind: 'COMPENSATE_UNSAFE_CREATE',
          remoteRef: 'https://cms.example.test/wp-admin/post.php?post=999&action=edit',
        },
      }),
    ).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'WORDPRESS_REMOTE_EFFECT_CONFLICT',
    });
    expect(deleteAttempts).toBe(1);
    await expect(
      adapter.reconcile({
        ...command,
        reconciliationIntent: published.reconciliationIntent,
      }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'WORDPRESS_NON_DRAFT_ROLLED_BACK',
    });
    expect(deleteAttempts).toBe(2);
    expect(storedPage).toMatchObject({ id: 470, status: 'trash' });

    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'WORDPRESS_REMOTE_EFFECT_NOT_FOUND',
    });
    expect(deleteAttempts).toBe(2);
  });

  test.each([
    {
      kind: 'POST' as const,
      id: 471,
      collectionPath: '/wp-json/wp/v2/posts',
      command: () =>
        wordpressCommand({
          destination: {
            kind: 'POST',
            operation: 'CREATE',
            slug: 'approved-post',
            categoryIds: [7, 19],
          },
          scopes: ['posts:write'],
        }),
    },
    {
      kind: 'PRODUCT' as const,
      id: 472,
      collectionPath: '/wp-json/wc/v3/products',
      command: () =>
        wordpressCommand({
          destination: {
            kind: 'PRODUCT',
            operation: 'CREATE',
            slug: 'approved-product',
            categoryIds: [11],
          },
          scopes: ['woocommerce:products:write'],
        }),
    },
  ])(
    'retries exact-id compensation during $kind reconciliation after the first live-create rollback timed out',
    async ({ id, collectionPath, command: createCommand }) => {
      let storedObject: Record<string, unknown> | null = null;
      let deleteAttempts = 0;
      const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
        if (input.method === 'GET' && input.url.includes('?slug=')) {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: storedObject === null ? [] : [storedObject],
          });
        }
        if (input.method === 'POST') {
          storedObject = {
            id,
            ...(input.body as Record<string, unknown>),
            status: 'publish',
          };
          return Promise.resolve({ status: 201, headers: {}, body: storedObject });
        }
        if (
          input.method === 'DELETE' &&
          input.url === `https://cms.example.test${collectionPath}/${String(id)}?force=false`
        ) {
          deleteAttempts += 1;
          if (deleteAttempts === 1) {
            return Promise.reject(new Error('TIMEOUT_AFTER_LIVE_CREATE'));
          }
          storedObject = { ...(storedObject ?? {}), status: 'trash' };
          return Promise.resolve({ status: 200, headers: {}, body: storedObject });
        }
        throw new Error(`UNEXPECTED_WORDPRESS_REQUEST:${input.method}:${input.url}`);
      });
      const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
        descriptor: descriptor(),
        httpClient: { request },
      });
      const command = createCommand();

      const intent = {
        kind: 'COMPENSATE_UNSAFE_CREATE' as const,
        remoteRef: `https://cms.example.test/wp-admin/post.php?post=${String(id)}&action=edit`,
      };
      await expect(adapter.publish(command)).resolves.toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'WORDPRESS_NON_DRAFT_ROLLBACK_UNKNOWN',
        reconciliationIntent: intent,
      });
      await expect(adapter.reconcile(command)).resolves.toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'WORDPRESS_REMOTE_EFFECT_CONFLICT',
      });
      await expect(
        adapter.reconcile({
          ...command,
          reconciliationIntent: {
            kind: 'COMPENSATE_UNSAFE_CREATE',
            remoteRef:
              `https://cms.example.test/wp-admin/post.php?post=${String(id + 1000)}` +
              '&action=edit',
          },
        }),
      ).resolves.toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'WORDPRESS_REMOTE_EFFECT_CONFLICT',
      });
      expect(deleteAttempts).toBe(1);
      await expect(
        adapter.reconcile({ ...command, reconciliationIntent: intent }),
      ).resolves.toEqual({
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'WORDPRESS_NON_DRAFT_ROLLED_BACK',
      });
      expect(deleteAttempts).toBe(2);
      expect(storedObject).toMatchObject({ id, status: 'trash' });
    },
  );

  test('keeps reconciliation ambiguous when retrying exact-id live-object compensation also fails', async () => {
    let storedPage: Record<string, unknown> | null = null;
    let deleteAttempts = 0;
    const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
      if (input.method === 'GET' && input.url.includes('?slug=')) {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: storedPage === null ? [] : [storedPage],
        });
      }
      if (input.method === 'POST') {
        storedPage = {
          id: 473,
          ...(input.body as Record<string, unknown>),
          status: 'publish',
        };
        return Promise.resolve({ status: 201, headers: {}, body: storedPage });
      }
      if (input.method === 'DELETE') {
        deleteAttempts += 1;
        return Promise.reject(new Error('WORDPRESS_DELETE_TIMEOUT'));
      }
      throw new Error(`UNEXPECTED_WORDPRESS_REQUEST:${input.method}:${input.url}`);
    });
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });
    const command = wordpressCommand();

    const published = await adapter.publish(command);
    expect(published).toMatchObject({
      outcome: 'AMBIGUOUS',
      reconciliationIntent: {
        kind: 'COMPENSATE_UNSAFE_CREATE',
        remoteRef: 'https://cms.example.test/wp-admin/post.php?post=473&action=edit',
      },
    });
    if (published.outcome !== 'AMBIGUOUS' || published.reconciliationIntent === undefined) {
      throw new Error('UNSAFE_CREATE_INTENT_REQUIRED');
    }
    await expect(
      adapter.reconcile({
        ...command,
        reconciliationIntent: published.reconciliationIntent,
      }),
    ).resolves.toMatchObject({
      outcome: 'AMBIGUOUS',
      errorCode: 'WORDPRESS_NON_DRAFT_ROLLBACK_UNKNOWN',
    });
    expect(deleteAttempts).toBe(2);
    expect(storedPage).toMatchObject({ id: 473, status: 'publish' });
  });

  test('does not issue a second create when a repeated publish sees the exact live object awaiting compensation', async () => {
    let storedPage: Record<string, unknown> | null = null;
    let postCount = 0;
    let deleteCount = 0;
    const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
      if (input.method === 'GET' && input.url.includes('?slug=')) {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: storedPage === null ? [] : [storedPage],
        });
      }
      if (input.method === 'POST') {
        postCount += 1;
        storedPage = {
          id: 476,
          ...(input.body as Record<string, unknown>),
          status: 'publish',
        };
        return Promise.resolve({ status: 201, headers: {}, body: storedPage });
      }
      if (input.method === 'DELETE') {
        deleteCount += 1;
        return Promise.reject(new Error('FIRST_COMPENSATION_TIMEOUT'));
      }
      throw new Error(`UNEXPECTED_WORDPRESS_REQUEST:${input.method}:${input.url}`);
    });
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });
    const command = wordpressCommand();

    await expect(adapter.publish(command)).resolves.toMatchObject({ outcome: 'AMBIGUOUS' });
    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'WORDPRESS_REMOTE_EFFECT_CONFLICT',
    });
    expect(postCount).toBe(1);
    expect(deleteCount).toBe(1);
  });

  test.each([
    {
      name: 'a foreign publication marker',
      mutate: (page: Record<string, unknown>) => [
        withPageMetadata(page, (metadata) => {
          metadata.intent = 'f'.repeat(64);
        }),
      ],
    },
    {
      name: 'multiple exact owned candidates',
      mutate: (page: Record<string, unknown>) => [page, { ...page, id: 475 }],
    },
    {
      name: 'a different remote title',
      mutate: (page: Record<string, unknown>) => [{ ...page, title: 'Remote title edit' }],
    },
    {
      name: 'different artifact lineage',
      mutate: (page: Record<string, unknown>) => [
        withPageMetadata(page, (metadata) => {
          metadata.revision = {
            ...requireRecord(metadata.revision),
            artifactRevisionId: '00000000-0000-7000-8000-000000009999',
          };
        }),
      ],
    },
  ])(
    'does not compensate during reconciliation when the live lookup contains $name',
    async ({ mutate }) => {
      let storedPage: Record<string, unknown> | null = null;
      let lookupBody: unknown[] = [];
      let deleteAttempts = 0;
      const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
        if (input.method === 'GET' && input.url.includes('?slug=')) {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: lookupBody,
          });
        }
        if (input.method === 'POST') {
          storedPage = {
            id: 474,
            ...(input.body as Record<string, unknown>),
            status: 'publish',
          };
          lookupBody = [storedPage];
          return Promise.resolve({ status: 201, headers: {}, body: storedPage });
        }
        if (input.method === 'DELETE') {
          deleteAttempts += 1;
          return Promise.reject(new Error('FIRST_COMPENSATION_TIMEOUT'));
        }
        throw new Error(`UNEXPECTED_WORDPRESS_REQUEST:${input.method}:${input.url}`);
      });
      const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
        descriptor: descriptor(),
        httpClient: { request },
      });
      const command = wordpressCommand();

      const published = await adapter.publish(command);
      expect(published).toMatchObject({
        outcome: 'AMBIGUOUS',
        reconciliationIntent: {
          kind: 'COMPENSATE_UNSAFE_CREATE',
          remoteRef: 'https://cms.example.test/wp-admin/post.php?post=474&action=edit',
        },
      });
      if (published.outcome !== 'AMBIGUOUS' || published.reconciliationIntent === undefined) {
        throw new Error('UNSAFE_CREATE_INTENT_REQUIRED');
      }
      if (storedPage === null) throw new Error('LIVE_PAGE_REQUIRED');
      lookupBody = mutate(storedPage);
      const deleteAttemptsBeforeReconcile = deleteAttempts;

      await expect(
        adapter.reconcile({
          ...command,
          reconciliationIntent: published.reconciliationIntent,
        }),
      ).resolves.toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'WORDPRESS_REMOTE_EFFECT_CONFLICT',
      });
      expect(deleteAttempts).toBe(deleteAttemptsBeforeReconcile);
    },
  );

  test('reports an ambiguous result when the draft create may have succeeded before the connection failed', async () => {
    let storedDraft: Record<string, unknown> | null = null;
    let deleteCount = 0;
    const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
      if (input.method === 'GET' && input.url.includes('?slug=')) {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: storedDraft === null ? [] : [storedDraft],
        });
      }
      if (input.method === 'POST') {
        storedDraft = { id: 49, ...(input.body as Record<string, unknown>) };
        return Promise.reject(new Error('CONNECTION_RESET_AFTER_REMOTE_EFFECT'));
      }
      if (input.method === 'DELETE') {
        deleteCount += 1;
        return Promise.resolve({ status: 200, headers: {}, body: { id: 49, status: 'trash' } });
      }
      throw new Error(`UNEXPECTED_WORDPRESS_REQUEST:${input.method}:${input.url}`);
    });
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });

    await expect(adapter.publish(wordpressCommand())).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'WORDPRESS_REMOTE_WRITE_RESULT_UNKNOWN',
    });
    expect(storedDraft).toMatchObject({ id: 49, status: 'draft' });
    storedDraft = { ...requireRecord(storedDraft), status: 'publish' };

    await expect(adapter.reconcile(wordpressCommand())).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'WORDPRESS_REMOTE_EFFECT_CONFLICT',
    });
    expect(deleteCount).toBe(0);
  });

  test('refuses rollback without deleting when the remote ownership marker differs', async () => {
    let deleteCount = 0;
    const command = wordpressCommand();
    const request = vi.fn((input: SafeWordPressJsonHttpRequest) => {
      if (input.method === 'GET' && input.url.includes('?slug=')) {
        return Promise.resolve({ status: 200, headers: {}, body: [] });
      }
      if (input.method === 'POST') {
        return Promise.resolve({
          status: 201,
          headers: {},
          body: { id: 48, ...(input.body as Record<string, unknown>) },
        });
      }
      if (input.method === 'GET' && input.url.includes('/48?context=edit')) {
        const body = createTamperedPageResponse(input, command);
        return Promise.resolve({ status: 200, headers: {}, body });
      }
      if (input.method === 'DELETE') {
        deleteCount += 1;
        return Promise.resolve({ status: 200, headers: {}, body: {} });
      }
      throw new Error(`UNEXPECTED_WORDPRESS_REQUEST:${input.method}:${input.url}`);
    });
    const adapter = new ProductionWordPressWooCommerceDraftPublicationAdapter({
      descriptor: descriptor(),
      httpClient: { request },
    });
    const published = await adapter.publish(command);
    if (published.outcome !== 'APPLIED') throw new Error('DRAFT_REQUIRED');

    await expect(
      adapter.rollback?.({ ...command, remoteRef: published.remoteRef }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_ROLLED_BACK',
      errorCode: 'WORDPRESS_ROLLBACK_OWNERSHIP_MISMATCH',
    });
    expect(deleteCount).toBe(0);
  });
});

function descriptor(): PublicationAdapterDescriptor {
  return {
    adapterKey: 'wordpress-woocommerce-draft',
    adapterVersion: '1.0.0',
    providerApiVersion: 'wp/v2',
    capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
    requiredScopes: ['media:write', 'pages:write', 'posts:write', 'woocommerce:products:write'],
    termsVersion: 'wordpress-production-terms-v1',
    processingRegion: 'remote-provider',
    retentionPolicy: 'No credential or package retention.',
    trainingPolicy: 'No training.',
    subprocessors: [],
    ratePolicy: { mode: 'provider-enforced' },
  };
}

function wordpressCommand(
  overrides: {
    destination?:
      | { kind: 'PAGE'; operation: 'CREATE'; slug: string }
      | {
          kind: 'PAGE';
          operation: 'UPDATE';
          slug: string;
          remoteId: number;
        }
      | {
          kind: 'POST' | 'PRODUCT';
          operation: 'CREATE';
          slug: string;
          categoryIds: number[];
        };
    scopes?: string[];
    assetRefs?: string[];
    credential?: {
      siteUrl?: string;
      scopes?: string[];
      authorizationHeader?: string;
    };
  } = {},
): PublicationAdapterCommand {
  const payload: ChannelPackagePayload = {
    files: {
      'content.md': '# Approved guide\n\nApproved summary.',
      'content.html': '<article><h1>Approved guide</h1><p>Approved summary.</p></article>',
      'structured-data.json': JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: 'Approved guide',
        abstract: 'Approved summary.',
      }),
    },
  };
  const channelPackage: ChannelPackageRecord = {
    id: '00000000-0000-7000-8000-000000008210',
    tenantId: '00000000-0000-7000-8000-000000008211',
    workspaceId: '00000000-0000-7000-8000-000000008212',
    packageRevision: 1,
    channel: {
      definitionId: '00000000-0000-7000-8000-000000008213',
      channelKey: 'wordpress-woocommerce-draft',
    },
    transformer: { key: 'generic-web-package', version: '1.0.0' },
    packageSchemaVersion: '1.0.0',
    artifact: {
      artifactId: '00000000-0000-7000-8000-000000008214',
      artifactRevisionId: '00000000-0000-7000-8000-000000008215',
      revision: 3,
      contentHash: 'a'.repeat(64),
      type: 'DEFINITION_PRODUCT',
      locale: 'en-SG',
      market: 'SG',
      methodPolicyVersion: 'production-wordpress-test-v1',
    },
    manifest: {
      schemaVersion: '1.0.0',
      files: [],
      assetRefs: overrides.assetRefs ?? [],
      claimSourceMap: [],
    },
    packageChecksum: 'b'.repeat(64),
    payloadObjectRef: 's3://test-bucket/channel-package.json',
    createdByUserId: '00000000-0000-7000-8000-000000008216',
    createdAt: '2026-07-24T00:00:00.000Z',
  };
  return {
    publicationId: '00000000-0000-7000-8000-000000008217',
    idempotencyKey: '00000000-0000-7000-8000-000000008217',
    target: encodeWordPressDraftTarget({
      schemaVersion: 'wordpress-draft-target.v1',
      siteUrl: 'https://cms.example.test',
      authMode: 'APPLICATION_PASSWORD',
      destination: overrides.destination ?? {
        kind: 'PAGE',
        operation: 'CREATE',
        slug: 'approved-guide',
      },
    }),
    channelPackage,
    payload,
    secretValue: JSON.stringify({
      schemaVersion: 'aeostudio.wordpress-credential.v1',
      siteUrl: overrides.credential?.siteUrl ?? 'https://cms.example.test',
      authMode: 'APPLICATION_PASSWORD',
      scopes: overrides.credential?.scopes ?? overrides.scopes ?? ['pages:write'],
      authorizationHeader:
        overrides.credential?.authorizationHeader ?? 'Basic dXNlcjphcHAtcGFzc3dvcmQ=',
    }),
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RECORD_REQUIRED');
  }
  return value as Record<string, unknown>;
}

function createTamperedPageResponse(
  _input: SafeWordPressJsonHttpRequest,
  command: PublicationAdapterCommand,
): Record<string, unknown> {
  const structuredData = JSON.parse(command.payload.files['structured-data.json']) as {
    headline: string;
  };
  const content =
    `${command.payload.files['content.html']}<script type="application/ld+json">` +
    `${command.payload.files['structured-data.json']}</script>`;
  return {
    id: 48,
    status: 'draft',
    slug: 'approved-guide',
    title: structuredData.headline,
    content,
    meta: {
      aeostudio_publication: {
        schemaVersion: 'aeostudio.wordpress-publication.v1',
        intent: 'f'.repeat(64),
        revision: {
          artifactRevisionId: command.channelPackage.artifact.artifactRevisionId,
          number: command.channelPackage.artifact.revision,
          contentHash: command.channelPackage.artifact.contentHash,
        },
        checksum: 'e'.repeat(64),
      },
    },
  };
}

function withPageMetadata(
  page: Record<string, unknown>,
  mutate: (metadata: Record<string, unknown>) => void,
): Record<string, unknown> {
  const result = structuredClone(page);
  const metadata = structuredClone(requireRecord(requireRecord(result.meta).aeostudio_publication));
  mutate(metadata);
  result.meta = {
    ...requireRecord(result.meta),
    aeostudio_publication: metadata,
  };
  if (typeof result.content !== 'string') throw new Error('PAGE_CONTENT_REQUIRED');
  const markerPrefix = '<!-- aeostudio-publication:v1 ';
  const markerStart = result.content.lastIndexOf(markerPrefix);
  if (markerStart < 0) throw new Error('PAGE_MARKER_REQUIRED');
  result.content =
    result.content.slice(0, markerStart) +
    markerPrefix +
    Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url') +
    ' -->';
  return result;
}
