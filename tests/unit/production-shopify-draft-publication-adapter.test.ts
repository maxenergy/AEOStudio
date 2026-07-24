import { describe, expect, test, vi } from 'vitest';

import {
  createProductionPublicationAdapterRegistry,
  NodeShopifyGraphqlTransport,
  ProductionShopifyDraftPublicationAdapter,
} from '@aeostudio/adapters/publication';
import type { PublicationAdapterCommand } from '@aeostudio/application/channels-publishing';
import {
  encodeShopifyDraftTarget,
  encodeShopifyShopAuthorizationTarget,
} from '@aeostudio/contracts/channels';
import type {
  ChannelPackagePayload,
  ChannelPackageRecord,
} from '@aeostudio/domain/channels-publishing';

describe('production Shopify Draft publication Adapter', () => {
  test('persists only scopes returned by the current app installation provider query', async () => {
    const request = vi.fn(() =>
      Promise.resolve({
        status: 200,
        headers: { 'x-shopify-api-version': '2026-07' },
        body: {
          data: {
            shop: { myshopifyDomain: 'example-store.myshopify.com' },
            currentAppInstallation: {
              accessScopes: [{ handle: 'write_content' }, { handle: 'write_products' }],
            },
          },
        },
      }),
    );
    const adapter = createProductionPublicationAdapterRegistry({ shopify: { request } }).resolve(
      'shopify-draft',
      '1.0.0',
    );
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const command = shopifyPageCommand();
    const authorizationTarget = encodeShopifyShopAuthorizationTarget({
      schemaVersion: 'shopify-shop-auth.v1',
      shopDomain: 'example-store.myshopify.com',
    });

    await expect(
      adapter.validateChannelAuthorization?.({
        tenantId: command.channelPackage.tenantId,
        workspaceId: command.channelPackage.workspaceId,
        channelDefinitionId: command.channelPackage.channel.definitionId,
        target: authorizationTarget,
        requestedScopes: ['write_content', 'write_products'],
        acceptedTermsVersion: 'shopify-provider-terms-v1',
        secretValue: command.secretValue,
      }),
    ).resolves.toEqual({
      outcome: 'VERIFIED',
      actualTarget: authorizationTarget,
      actualScopes: ['write_content', 'write_products'],
    });
    expect(request).toHaveBeenCalledOnce();
  });

  test('creates one unpublished Page with an exact lineage marker and reconciles by that marker', async () => {
    let storedPage: Record<string, unknown> | null = null;
    let deleteResponseMode: 'SUCCESS' | 'PURE_REJECT' | 'MIXED' = 'SUCCESS';
    const request = vi.fn(
      (input: {
        url: string;
        headers: Record<string, string>;
        body: { query: string; variables: Record<string, unknown> };
      }) => {
        const response = (body: unknown) =>
          Promise.resolve({
            status: 200,
            headers: { 'x-shopify-api-version': '2026-07' },
            body,
          });
        if (input.body.query.includes('AEOStudioPublicationAuthorization')) {
          return response({
            data: {
              shop: { myshopifyDomain: 'example-store.myshopify.com' },
              currentAppInstallation: { accessScopes: [{ handle: 'write_content' }] },
            },
          });
        }
        if (input.body.query.includes('AEOStudioFindPage')) {
          const query = input.body.variables.query;
          return response({
            data: {
              pages: {
                nodes:
                  storedPage !== null && query === `handle:${String(storedPage.handle)}`
                    ? [storedPage]
                    : [],
              },
            },
          });
        }
        if (input.body.query.includes('AEOStudioGetPageById')) {
          return response({
            data: {
              page:
                storedPage !== null && input.body.variables.id === storedPage.id
                  ? storedPage
                  : null,
            },
          });
        }
        if (input.body.query.includes('AEOStudioCreatePage')) {
          const page = input.body.variables.page as {
            title: string;
            body: string;
            handle: string;
            isPublished: boolean;
            metafields: Array<{ value: string }>;
          };
          storedPage = {
            id: 'gid://shopify/Page/123',
            title: page.title,
            body: page.body,
            handle: page.handle,
            isPublished: page.isPublished,
            metafield: { value: page.metafields[0]?.value },
          };
          return response({
            data: { pageCreate: { page: storedPage, userErrors: [] } },
          });
        }
        if (input.body.query.includes('AEOStudioDeletePage')) {
          const id = input.body.variables.id;
          if (storedPage?.id !== id) {
            return response({
              data: {
                pageDelete: {
                  deletedPageId: null,
                  userErrors: [{ code: 'NOT_FOUND', field: ['id'], message: 'not found' }],
                },
              },
            });
          }
          if (deleteResponseMode === 'PURE_REJECT') {
            return response({
              data: {
                pageDelete: {
                  deletedPageId: null,
                  userErrors: [
                    { code: 'REJECTED', field: ['id'], message: 'provider rejected deletion' },
                  ],
                },
              },
            });
          }
          if (deleteResponseMode === 'MIXED') {
            return response({
              data: {
                pageDelete: {
                  deletedPageId: id,
                  userErrors: [
                    {
                      code: 'PARTIAL_FAILURE',
                      field: ['id'],
                      message: 'provider returned deletedId and an error',
                    },
                  ],
                },
              },
            });
          }
          storedPage = null;
          return response({
            data: { pageDelete: { deletedPageId: id, userErrors: [] } },
          });
        }
        throw new Error(`UNEXPECTED_SHOPIFY_QUERY:${input.body.query}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const command = shopifyPageCommand();

    const result = await adapter.publish(command);

    expect(result).toMatchObject({
      outcome: 'APPLIED',
      remoteRef: 'https://admin.shopify.com/store/example-store/pages/123',
      remoteState: {
        status: 'DRAFT',
        number: null,
        isProductionLive: false,
        rollbackHandle: {
          operation: 'DELETE_CREATED_DRAFT',
          shopDomain: 'example-store.myshopify.com',
          contentKind: 'PAGE',
          remoteId: 'gid://shopify/Page/123',
        },
      },
    });
    const mutation = request.mock.calls
      .map(([input]) => input)
      .find((input) => input.body.query.includes('AEOStudioCreatePage'));
    expect(mutation?.body.variables).toMatchObject({
      page: {
        title: 'Approved Page',
        body: '<article><h1>Approved Page</h1></article>',
        handle: 'approved-page',
        isPublished: false,
        metafields: [
          {
            namespace: 'aeostudio',
            key: 'publication',
            type: 'json',
          },
        ],
      },
    });
    const marker = JSON.parse(
      (
        mutation?.body.variables.page as {
          metafields: Array<{ value: string }>;
        }
      ).metafields[0]?.value ?? '',
    ) as Record<string, unknown>;
    expect(marker).toMatchObject({
      schemaVersion: 'aeostudio.shopify-publication.v1',
      publicationId: command.publicationId,
      packageChecksum: command.channelPackage.packageChecksum,
      artifactRevisionId: command.channelPackage.artifact.artifactRevisionId,
      artifactContentHash: command.channelPackage.artifact.contentHash,
    });
    expect(JSON.stringify(mutation?.body.variables)).not.toContain('shopify-offline-access-token');

    await expect(adapter.reconcile(command)).resolves.toMatchObject({
      outcome: 'APPLIED',
      remoteRef: 'https://admin.shopify.com/store/example-store/pages/123',
      remoteState: { status: 'DRAFT', isProductionLive: false },
    });
    expect(
      request.mock.calls.filter(([input]) => input.body.query.includes('AEOStudioCreatePage')),
    ).toHaveLength(1);
    if (adapter.rollback === undefined) throw new Error('SHOPIFY_ROLLBACK_REQUIRED');
    const otherPublication = {
      ...command,
      publicationId: '00000000-0000-7000-8000-000000007018',
      idempotencyKey: '00000000-0000-7000-8000-000000007018',
    };
    await expect(adapter.publish(otherPublication)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'SHOPIFY_HANDLE_CONFLICT',
    });
    await expect(adapter.reconcile(otherPublication)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    await expect(
      adapter.rollback({
        ...otherPublication,
        remoteRef: 'https://admin.shopify.com/store/example-store/pages/123',
      }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_ROLLED_BACK',
      errorCode: 'SHOPIFY_ROLLBACK_REMOTE_EFFECT_CONFLICT',
    });
    expect(
      request.mock.calls.filter(([input]) => input.body.query.includes('AEOStudioDeletePage')),
    ).toHaveLength(0);
    deleteResponseMode = 'PURE_REJECT';
    await expect(
      adapter.rollback({
        ...command,
        remoteRef: 'https://admin.shopify.com/store/example-store/pages/123',
      }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_ROLLED_BACK',
      errorCode: 'SHOPIFY_ROLLBACK_REJECTED',
    });
    deleteResponseMode = 'MIXED';
    await expect(
      adapter.rollback({
        ...command,
        remoteRef: 'https://admin.shopify.com/store/example-store/pages/123',
      }),
    ).resolves.toEqual({
      outcome: 'UNKNOWN',
      errorCode: 'SHOPIFY_ROLLBACK_RESULT_UNKNOWN',
    });
    deleteResponseMode = 'SUCCESS';
    storedPage = {
      ...requiredStoredRecord(storedPage, 'SHOPIFY_PAGE_REQUIRED'),
      handle: 'renamed-after-create',
    };
    await expect(
      adapter.rollback({
        ...command,
        remoteRef: 'https://admin.shopify.com/store/example-store/pages/123',
      }),
    ).resolves.toEqual({
      outcome: 'ROLLED_BACK',
      remoteRef: 'https://admin.shopify.com/store/example-store/pages/123',
    });
    expect(
      request.mock.calls.filter(([input]) => input.body.query.includes('AEOStudioDeletePage')),
    ).toHaveLength(3);
    expect(
      request.mock.calls
        .map(([input]) => input)
        .find((input) => input.body.query.includes('AEOStudioGetPageById'))?.body.variables,
    ).toEqual({ id: 'gid://shopify/Page/123' });
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_NOT_FOUND',
    });
  });

  test('compensates an exact owned Page when Shopify creates it published', async () => {
    const request = vi.fn(
      (input: { body: { query: string; variables: Record<string, unknown> } }) => {
        const response = (body: unknown) =>
          Promise.resolve({
            status: 200,
            headers: { 'x-shopify-api-version': '2026-07' },
            body,
          });
        if (input.body.query.includes('AEOStudioPublicationAuthorization')) {
          return response({
            data: {
              shop: { myshopifyDomain: 'example-store.myshopify.com' },
              currentAppInstallation: { accessScopes: [{ handle: 'write_content' }] },
            },
          });
        }
        if (input.body.query.includes('AEOStudioFindPage')) {
          return response({ data: { pages: { nodes: [] } } });
        }
        if (input.body.query.includes('AEOStudioCreatePage')) {
          const page = input.body.variables.page as {
            title: string;
            body: string;
            handle: string;
            metafields: Array<{ value: string }>;
          };
          return response({
            data: {
              pageCreate: {
                page: {
                  id: 'gid://shopify/Page/123',
                  title: page.title,
                  body: page.body,
                  handle: page.handle,
                  isPublished: true,
                  metafield: { value: page.metafields[0]?.value },
                },
                userErrors: [
                  {
                    code: 'PARTIAL_FAILURE',
                    field: ['page'],
                    message: 'provider returned an object and an error',
                  },
                ],
              },
            },
          });
        }
        if (input.body.query.includes('AEOStudioDeletePage')) {
          return response({
            data: {
              pageDelete: {
                deletedPageId: input.body.variables.id,
                userErrors: [],
              },
            },
          });
        }
        throw new Error(`UNEXPECTED_SHOPIFY_QUERY:${input.body.query}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');

    await expect(adapter.publish(shopifyPageCommand())).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATED',
    });
    expect(
      request.mock.calls
        .map(([input]) => input)
        .find((input) => input.body.query.includes('AEOStudioDeletePage'))?.body.variables,
    ).toEqual({ id: 'gid://shopify/Page/123' });
  });

  test('reports an ambiguous Page outcome when unsafe-create compensation is unknown', async () => {
    const request = publishedPageRequest('THROW');
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');

    const result = await adapter.publish(shopifyPageCommand());

    expect(result).toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATION_FAILED',
      reconciliationIntent: {
        kind: 'COMPENSATE_UNSAFE_CREATE',
        remoteRef: 'https://admin.shopify.com/store/example-store/pages/123',
      },
    });
    expect(JSON.stringify(result)).not.toContain('refresh-or-access-secret');
  });

  test('reports an ambiguous Page outcome when Shopify rejects unsafe-create compensation', async () => {
    const request = publishedPageRequest('FAILURE');
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');

    await expect(adapter.publish(shopifyPageCommand())).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATION_FAILED',
      reconciliationIntent: {
        kind: 'COMPENSATE_UNSAFE_CREATE',
        remoteRef: 'https://admin.shopify.com/store/example-store/pages/123',
      },
    });
    expect(
      request.mock.calls.filter(([input]) => input.body.query.includes('AEOStudioDeletePage')),
    ).toHaveLength(1);
  });

  test('reconcile retries exact-ID Page compensation only with durable unsafe-create intent', async () => {
    let storedPage: Record<string, unknown> | null = null;
    let deleteAttempts = 0;
    const request = vi.fn(
      (input: { body: { query: string; variables: Record<string, unknown> } }) => {
        const response = (body: unknown) =>
          Promise.resolve({
            status: 200,
            headers: { 'x-shopify-api-version': '2026-07' },
            body,
          });
        if (input.body.query.includes('AEOStudioPublicationAuthorization')) {
          return response({
            data: {
              shop: { myshopifyDomain: 'example-store.myshopify.com' },
              currentAppInstallation: { accessScopes: [{ handle: 'write_content' }] },
            },
          });
        }
        if (input.body.query.includes('AEOStudioFindPage')) {
          return response({ data: { pages: { nodes: storedPage === null ? [] : [storedPage] } } });
        }
        if (input.body.query.includes('AEOStudioCreatePage')) {
          const page = requiredInputRecord(input.body.variables.page);
          storedPage = {
            id: 'gid://shopify/Page/123',
            title: page.title,
            body: page.body,
            handle: page.handle,
            isPublished: true,
            metafield: markerMetafield(page),
          };
          return response({
            data: { pageCreate: { page: storedPage, userErrors: [] } },
          });
        }
        if (input.body.query.includes('AEOStudioDeletePage')) {
          deleteAttempts += 1;
          expect(input.body.variables).toEqual({ id: 'gid://shopify/Page/123' });
          if (deleteAttempts <= 2) throw new Error('fixture delete timeout');
          storedPage = null;
          return response({
            data: {
              pageDelete: {
                deletedPageId: 'gid://shopify/Page/123',
                userErrors: [],
              },
            },
          });
        }
        throw new Error(`UNEXPECTED_SHOPIFY_QUERY:${input.body.query}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const command = shopifyPageCommand();

    const initial = await adapter.publish(command);
    expect(initial).toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATION_FAILED',
      reconciliationIntent: {
        kind: 'COMPENSATE_UNSAFE_CREATE',
        remoteRef: 'https://admin.shopify.com/store/example-store/pages/123',
      },
    });
    if (initial.outcome !== 'AMBIGUOUS' || initial.reconciliationIntent === undefined) {
      throw new Error('SHOPIFY_PAGE_COMPENSATION_INTENT_REQUIRED');
    }
    const reconcileWithIntent = {
      ...command,
      reconciliationIntent: initial.reconciliationIntent,
    };
    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    expect(
      request.mock.calls.filter(([input]) => input.body.query.includes('AEOStudioCreatePage')),
    ).toHaveLength(1);
    expect(deleteAttempts).toBe(1);
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    await expect(
      adapter.reconcile({
        ...command,
        reconciliationIntent: {
          kind: 'COMPENSATE_UNSAFE_CREATE',
          remoteRef: 'https://admin.shopify.com/store/example-store/pages/999',
        },
      }),
    ).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    expect(deleteAttempts).toBe(1);
    await expect(adapter.reconcile(reconcileWithIntent)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATION_FAILED',
    });
    await expect(adapter.reconcile(reconcileWithIntent)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATED',
    });
    expect(deleteAttempts).toBe(3);
    expect(storedPage).toBeNull();
  });

  test('reconcile never deletes live Page candidates with foreign lineage, multiple matches, or content drift', async () => {
    let nodes: Array<Record<string, unknown>> = [];
    let exactLivePage: Record<string, unknown> | null = null;
    const request = vi.fn(
      (input: { body: { query: string; variables: Record<string, unknown> } }) => {
        const response = (body: unknown) =>
          Promise.resolve({
            status: 200,
            headers: { 'x-shopify-api-version': '2026-07' },
            body,
          });
        if (input.body.query.includes('AEOStudioPublicationAuthorization')) {
          return response({
            data: {
              shop: { myshopifyDomain: 'example-store.myshopify.com' },
              currentAppInstallation: { accessScopes: [{ handle: 'write_content' }] },
            },
          });
        }
        if (input.body.query.includes('AEOStudioFindPage')) {
          return response({ data: { pages: { nodes } } });
        }
        if (input.body.query.includes('AEOStudioCreatePage')) {
          const page = requiredInputRecord(input.body.variables.page);
          exactLivePage = {
            id: 'gid://shopify/Page/123',
            title: page.title,
            body: page.body,
            handle: page.handle,
            isPublished: true,
            metafield: markerMetafield(page),
          };
          return response({
            data: {
              pageCreate: {
                page: null,
                userErrors: [{ code: 'REJECTED', field: ['page'], message: 'fixture reject' }],
              },
            },
          });
        }
        if (input.body.query.includes('AEOStudioDeletePage')) {
          throw new Error('DELETE_MUST_NOT_RUN');
        }
        throw new Error(`UNEXPECTED_SHOPIFY_QUERY:${input.body.query}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const command = shopifyPageCommand();
    await expect(adapter.publish(command)).resolves.toMatchObject({
      outcome: 'DEFINITELY_NOT_APPLIED',
    });
    const exact = requiredStoredRecord(exactLivePage, 'EXACT_LIVE_PAGE_REQUIRED');
    const foreign = {
      ...exact,
      metafield: { value: '{"schemaVersion":"foreign-lineage"}' },
    };

    nodes = [foreign];
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    nodes = [exact, foreign];
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    nodes = [{ ...exact, title: 'Changed outside AEOStudio' }];
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    expect(
      request.mock.calls.some(([input]) => input.body.query.includes('AEOStudioDeletePage')),
    ).toBe(false);
  });

  test('never compensates a published Page carrying another Publication lineage marker', async () => {
    let firstPublicationMarker: string | null = null;
    let servingSecondPublication = false;
    const request = vi.fn(
      (input: { body: { query: string; variables: Record<string, unknown> } }) => {
        const response = (body: unknown) =>
          Promise.resolve({
            status: 200,
            headers: { 'x-shopify-api-version': '2026-07' },
            body,
          });
        if (input.body.query.includes('AEOStudioPublicationAuthorization')) {
          return response({
            data: {
              shop: { myshopifyDomain: 'example-store.myshopify.com' },
              currentAppInstallation: { accessScopes: [{ handle: 'write_content' }] },
            },
          });
        }
        if (input.body.query.includes('AEOStudioFindPage')) {
          return response({ data: { pages: { nodes: [] } } });
        }
        if (input.body.query.includes('AEOStudioCreatePage')) {
          const page = input.body.variables.page as {
            title: string;
            body: string;
            handle: string;
            metafields: Array<{ value: string }>;
          };
          if (!servingSecondPublication) {
            firstPublicationMarker = page.metafields[0]?.value ?? null;
            return response({
              data: {
                pageCreate: {
                  page: null,
                  userErrors: [{ code: 'REJECTED', field: ['page'], message: 'fixture reject' }],
                },
              },
            });
          }
          return response({
            data: {
              pageCreate: {
                page: {
                  id: 'gid://shopify/Page/123',
                  title: page.title,
                  body: page.body,
                  handle: page.handle,
                  isPublished: true,
                  metafield: { value: firstPublicationMarker },
                },
                userErrors: [
                  {
                    code: 'PARTIAL_FAILURE',
                    field: ['page'],
                    message: 'foreign object and provider error',
                  },
                ],
              },
            },
          });
        }
        if (input.body.query.includes('AEOStudioDeletePage')) {
          return response({
            data: {
              pageDelete: {
                deletedPageId: input.body.variables.id,
                userErrors: [],
              },
            },
          });
        }
        throw new Error(`UNEXPECTED_SHOPIFY_QUERY:${input.body.query}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const first = shopifyPageCommand();
    await expect(adapter.publish(first)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'SHOPIFY_MUTATION_REJECTED',
    });
    servingSecondPublication = true;
    const second = {
      ...first,
      publicationId: '00000000-0000-7000-8000-000000007018',
      idempotencyKey: '00000000-0000-7000-8000-000000007018',
    };

    await expect(adapter.publish(second)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_MUTATION_MIXED_RESULT',
    });
    expect(
      request.mock.calls.filter(([input]) => input.body.query.includes('AEOStudioDeletePage')),
    ).toHaveLength(0);
    expect(JSON.parse(firstPublicationMarker ?? '')).toMatchObject({
      publicationId: first.publicationId,
    });
  });

  test('creates, reconciles, and rolls back only its exact unpublished Blog Article', async () => {
    let storedArticle: Record<string, unknown> | null = null;
    let deleteResponseMode: 'SUCCESS' | 'PURE_REJECT' | 'MIXED' = 'SUCCESS';
    const request = vi.fn(
      (input: {
        url: string;
        headers: Record<string, string>;
        body: { query: string; variables: Record<string, unknown> };
      }) => {
        const response = (body: unknown) =>
          Promise.resolve({
            status: 200,
            headers: { 'x-shopify-api-version': '2026-07' },
            body,
          });
        if (input.body.query.includes('AEOStudioPublicationAuthorization')) {
          return response({
            data: {
              shop: { myshopifyDomain: 'example-store.myshopify.com' },
              currentAppInstallation: { accessScopes: [{ handle: 'write_content' }] },
            },
          });
        }
        if (input.body.query.includes('AEOStudioFindArticle')) {
          const query = input.body.variables.query;
          return response({
            data: {
              articles: {
                nodes:
                  storedArticle !== null &&
                  typeof query === 'string' &&
                  query.includes(`handle:${String(storedArticle.handle)}`)
                    ? [storedArticle]
                    : [],
              },
            },
          });
        }
        if (input.body.query.includes('AEOStudioGetArticleById')) {
          return response({
            data: {
              article:
                storedArticle !== null && input.body.variables.id === storedArticle.id
                  ? storedArticle
                  : null,
            },
          });
        }
        if (input.body.query.includes('AEOStudioCreateArticle')) {
          const article = input.body.variables.article as {
            blogId: string;
            title: string;
            body: string;
            handle: string;
            isPublished: boolean;
            author: { name: string };
            metafields: Array<{ value: string }>;
          };
          storedArticle = {
            id: 'gid://shopify/Article/456',
            title: article.title,
            body: article.body,
            handle: article.handle,
            isPublished: article.isPublished,
            blog: { id: article.blogId },
            metafield: { value: article.metafields[0]?.value },
          };
          return response({
            data: { articleCreate: { article: storedArticle, userErrors: [] } },
          });
        }
        if (input.body.query.includes('AEOStudioDeleteArticle')) {
          const id = input.body.variables.id;
          if (storedArticle?.id !== id) {
            return response({
              data: {
                articleDelete: {
                  deletedArticleId: null,
                  userErrors: [{ code: 'NOT_FOUND', field: ['id'], message: 'not found' }],
                },
              },
            });
          }
          if (deleteResponseMode === 'PURE_REJECT') {
            return response({
              data: {
                articleDelete: {
                  deletedArticleId: null,
                  userErrors: [
                    { code: 'REJECTED', field: ['id'], message: 'provider rejected deletion' },
                  ],
                },
              },
            });
          }
          if (deleteResponseMode === 'MIXED') {
            return response({
              data: {
                articleDelete: {
                  deletedArticleId: id,
                  userErrors: [
                    {
                      code: 'PARTIAL_FAILURE',
                      field: ['id'],
                      message: 'provider returned deletedId and an error',
                    },
                  ],
                },
              },
            });
          }
          storedArticle = null;
          return response({
            data: { articleDelete: { deletedArticleId: id, userErrors: [] } },
          });
        }
        throw new Error(`UNEXPECTED_SHOPIFY_QUERY:${input.body.query}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const command = shopifyCommand(
      {
        kind: 'BLOG_ARTICLE',
        operation: 'CREATE',
        handle: 'approved-article',
        blogId: 'gid://shopify/Blog/700000000001',
      },
      'Approved Article',
    );

    const result = await adapter.publish(command);

    expect(result).toMatchObject({
      outcome: 'APPLIED',
      remoteRef: 'https://admin.shopify.com/store/example-store/content/articles/456',
      remoteState: {
        status: 'UNPUBLISHED',
        number: null,
        isProductionLive: false,
        rollbackHandle: {
          operation: 'DELETE_CREATED_DRAFT',
          shopDomain: 'example-store.myshopify.com',
          contentKind: 'BLOG_ARTICLE',
          remoteId: 'gid://shopify/Article/456',
        },
      },
    });
    const mutation = request.mock.calls
      .map(([input]) => input)
      .find((input) => input.body.query.includes('AEOStudioCreateArticle'));
    expect(mutation?.body.variables).toMatchObject({
      article: {
        blogId: 'gid://shopify/Blog/700000000001',
        title: 'Approved Article',
        body: '<article><h1>Approved Article</h1></article>',
        handle: 'approved-article',
        isPublished: false,
        author: { name: 'AEO Studio Publisher' },
        metafields: [
          {
            namespace: 'aeostudio',
            key: 'publication',
            type: 'json',
          },
        ],
      },
    });
    const marker = JSON.parse(
      (
        mutation?.body.variables.article as {
          metafields: Array<{ value: string }>;
        }
      ).metafields[0]?.value ?? '',
    ) as Record<string, unknown>;
    expect(marker).toMatchObject({
      schemaVersion: 'aeostudio.shopify-publication.v1',
      publicationId: command.publicationId,
      packageChecksum: command.channelPackage.packageChecksum,
      artifactRevisionId: command.channelPackage.artifact.artifactRevisionId,
      artifactContentHash: command.channelPackage.artifact.contentHash,
    });
    expect(JSON.stringify({ result, variables: mutation?.body.variables })).not.toContain(
      'shopify-offline-access-token',
    );
    await expect(adapter.publish(command)).resolves.toMatchObject({
      outcome: 'APPLIED',
      remoteRef: 'https://admin.shopify.com/store/example-store/content/articles/456',
    });
    await expect(adapter.reconcile(command)).resolves.toMatchObject({
      outcome: 'APPLIED',
      remoteRef: 'https://admin.shopify.com/store/example-store/content/articles/456',
      remoteState: { status: 'UNPUBLISHED', isProductionLive: false },
    });
    expect(
      request.mock.calls.filter(([input]) => input.body.query.includes('AEOStudioCreateArticle')),
    ).toHaveLength(1);
    if (adapter.rollback === undefined) throw new Error('SHOPIFY_ROLLBACK_REQUIRED');
    const exactArticle = requiredStoredRecord(storedArticle, 'SHOPIFY_ARTICLE_REQUIRED');
    const otherPublication = {
      ...command,
      publicationId: '00000000-0000-7000-8000-000000007018',
      idempotencyKey: '00000000-0000-7000-8000-000000007018',
    };
    await expect(adapter.publish(otherPublication)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'SHOPIFY_HANDLE_CONFLICT',
    });
    await expect(adapter.reconcile(otherPublication)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    await expect(
      adapter.rollback({
        ...otherPublication,
        remoteRef: 'https://admin.shopify.com/store/example-store/content/articles/456',
      }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_ROLLED_BACK',
      errorCode: 'SHOPIFY_ROLLBACK_REMOTE_EFFECT_CONFLICT',
    });
    storedArticle = {
      ...exactArticle,
      metafield: { value: '{"schemaVersion":"foreign-lineage"}' },
    };
    await expect(
      adapter.rollback({
        ...command,
        remoteRef: 'https://admin.shopify.com/store/example-store/content/articles/456',
      }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_ROLLED_BACK',
      errorCode: 'SHOPIFY_ROLLBACK_REMOTE_EFFECT_CONFLICT',
    });
    storedArticle = exactArticle;
    await expect(
      adapter.rollback({
        ...command,
        remoteRef: 'https://admin.shopify.com/store/example-store/products/456',
      }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_ROLLED_BACK',
      errorCode: 'SHOPIFY_ROLLBACK_REMOTE_REF_MISMATCH',
    });
    expect(
      request.mock.calls.filter(([input]) => input.body.query.includes('AEOStudioDeleteArticle')),
    ).toHaveLength(0);
    deleteResponseMode = 'PURE_REJECT';
    await expect(
      adapter.rollback({
        ...command,
        remoteRef: 'https://admin.shopify.com/store/example-store/content/articles/456',
      }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_ROLLED_BACK',
      errorCode: 'SHOPIFY_ROLLBACK_REJECTED',
    });
    deleteResponseMode = 'MIXED';
    await expect(
      adapter.rollback({
        ...command,
        remoteRef: 'https://admin.shopify.com/store/example-store/content/articles/456',
      }),
    ).resolves.toEqual({
      outcome: 'UNKNOWN',
      errorCode: 'SHOPIFY_ROLLBACK_RESULT_UNKNOWN',
    });
    deleteResponseMode = 'SUCCESS';
    storedArticle = { ...exactArticle, handle: 'renamed-after-create' };
    await expect(
      adapter.rollback({
        ...command,
        remoteRef: 'https://admin.shopify.com/store/example-store/content/articles/456',
      }),
    ).resolves.toEqual({
      outcome: 'ROLLED_BACK',
      remoteRef: 'https://admin.shopify.com/store/example-store/content/articles/456',
    });
    expect(
      request.mock.calls.filter(([input]) => input.body.query.includes('AEOStudioDeleteArticle')),
    ).toHaveLength(3);
    expect(
      request.mock.calls
        .map(([input]) => input)
        .find((input) => input.body.query.includes('AEOStudioGetArticleById'))?.body.variables,
    ).toEqual({ id: 'gid://shopify/Article/456' });
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_NOT_FOUND',
    });
  });

  test('compensates an exact owned Blog Article when Shopify creates it published', async () => {
    const request = vi.fn(
      (input: { body: { query: string; variables: Record<string, unknown> } }) => {
        const response = (body: unknown) =>
          Promise.resolve({
            status: 200,
            headers: { 'x-shopify-api-version': '2026-07' },
            body,
          });
        if (input.body.query.includes('AEOStudioPublicationAuthorization')) {
          return response({
            data: {
              shop: { myshopifyDomain: 'example-store.myshopify.com' },
              currentAppInstallation: { accessScopes: [{ handle: 'write_content' }] },
            },
          });
        }
        if (input.body.query.includes('AEOStudioFindArticle')) {
          return response({ data: { articles: { nodes: [] } } });
        }
        if (input.body.query.includes('AEOStudioCreateArticle')) {
          const article = input.body.variables.article as {
            blogId: string;
            title: string;
            body: string;
            handle: string;
            metafields: Array<{ value: string }>;
          };
          return response({
            data: {
              articleCreate: {
                article: {
                  id: 'gid://shopify/Article/456',
                  title: article.title,
                  body: article.body,
                  handle: article.handle,
                  isPublished: true,
                  blog: { id: article.blogId },
                  metafield: { value: article.metafields[0]?.value },
                },
                userErrors: [
                  {
                    code: 'PARTIAL_FAILURE',
                    field: ['article'],
                    message: 'provider returned an object and an error',
                  },
                ],
              },
            },
          });
        }
        if (input.body.query.includes('AEOStudioDeleteArticle')) {
          return response({
            data: {
              articleDelete: {
                deletedArticleId: input.body.variables.id,
                userErrors: [],
              },
            },
          });
        }
        throw new Error(`UNEXPECTED_SHOPIFY_QUERY:${input.body.query}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const command = shopifyCommand(
      {
        kind: 'BLOG_ARTICLE',
        operation: 'CREATE',
        handle: 'approved-article',
        blogId: 'gid://shopify/Blog/700000000001',
      },
      'Approved Article',
    );

    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATED',
    });
    expect(
      request.mock.calls
        .map(([input]) => input)
        .find((input) => input.body.query.includes('AEOStudioDeleteArticle'))?.body.variables,
    ).toEqual({ id: 'gid://shopify/Article/456' });
  });

  test('reconcile retries exact-ID Article compensation only with durable unsafe-create intent', async () => {
    let storedArticle: Record<string, unknown> | null = null;
    let deleteAttempts = 0;
    const request = vi.fn(
      (input: { body: { query: string; variables: Record<string, unknown> } }) => {
        const response = (body: unknown) =>
          Promise.resolve({
            status: 200,
            headers: { 'x-shopify-api-version': '2026-07' },
            body,
          });
        if (input.body.query.includes('AEOStudioPublicationAuthorization')) {
          return response({
            data: {
              shop: { myshopifyDomain: 'example-store.myshopify.com' },
              currentAppInstallation: { accessScopes: [{ handle: 'write_content' }] },
            },
          });
        }
        if (input.body.query.includes('AEOStudioFindArticle')) {
          return response({
            data: { articles: { nodes: storedArticle === null ? [] : [storedArticle] } },
          });
        }
        if (input.body.query.includes('AEOStudioCreateArticle')) {
          const article = requiredInputRecord(input.body.variables.article);
          storedArticle = {
            id: 'gid://shopify/Article/456',
            title: article.title,
            body: article.body,
            handle: article.handle,
            isPublished: true,
            blog: { id: article.blogId },
            metafield: markerMetafield(article),
          };
          return response({
            data: { articleCreate: { article: storedArticle, userErrors: [] } },
          });
        }
        if (input.body.query.includes('AEOStudioDeleteArticle')) {
          deleteAttempts += 1;
          expect(input.body.variables).toEqual({ id: 'gid://shopify/Article/456' });
          if (deleteAttempts <= 2) throw new Error('fixture delete timeout');
          storedArticle = null;
          return response({
            data: {
              articleDelete: {
                deletedArticleId: 'gid://shopify/Article/456',
                userErrors: [],
              },
            },
          });
        }
        throw new Error(`UNEXPECTED_SHOPIFY_QUERY:${input.body.query}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const command = shopifyCommand(
      {
        kind: 'BLOG_ARTICLE',
        operation: 'CREATE',
        handle: 'approved-article',
        blogId: 'gid://shopify/Blog/700000000001',
      },
      'Approved Article',
    );

    const initial = await adapter.publish(command);
    expect(initial).toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATION_FAILED',
      reconciliationIntent: {
        kind: 'COMPENSATE_UNSAFE_CREATE',
        remoteRef: 'https://admin.shopify.com/store/example-store/content/articles/456',
      },
    });
    if (initial.outcome !== 'AMBIGUOUS' || initial.reconciliationIntent === undefined) {
      throw new Error('SHOPIFY_ARTICLE_COMPENSATION_INTENT_REQUIRED');
    }
    const reconcileWithIntent = {
      ...command,
      reconciliationIntent: initial.reconciliationIntent,
    };
    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    expect(
      request.mock.calls.filter(([input]) => input.body.query.includes('AEOStudioCreateArticle')),
    ).toHaveLength(1);
    const exactLiveArticle = requiredStoredRecord(storedArticle, 'EXACT_LIVE_ARTICLE_REQUIRED');
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    await expect(
      adapter.reconcile({
        ...command,
        reconciliationIntent: {
          kind: 'COMPENSATE_UNSAFE_CREATE',
          remoteRef: 'https://admin.shopify.com/store/example-store/content/articles/999',
        },
      }),
    ).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    storedArticle = {
      ...exactLiveArticle,
      metafield: { value: '{"schemaVersion":"foreign-lineage"}' },
    };
    await expect(adapter.reconcile(reconcileWithIntent)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    storedArticle = {
      ...exactLiveArticle,
      blog: { id: 'gid://shopify/Blog/700000000099' },
    };
    await expect(adapter.reconcile(reconcileWithIntent)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    expect(deleteAttempts).toBe(1);
    storedArticle = exactLiveArticle;
    await expect(adapter.reconcile(reconcileWithIntent)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATION_FAILED',
    });
    await expect(adapter.reconcile(reconcileWithIntent)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATED',
    });
    expect(deleteAttempts).toBe(3);
    expect(storedArticle).toBeNull();
  });

  test('creates, reconciles, and rolls back only its exact draft Product', async () => {
    let storedProduct: Record<string, unknown> | null = null;
    let deleteResponseMode: 'SUCCESS' | 'PURE_REJECT' | 'MIXED' = 'SUCCESS';
    const request = vi.fn(
      (input: {
        url: string;
        headers: Record<string, string>;
        body: { query: string; variables: Record<string, unknown> };
      }) => {
        const response = (body: unknown) =>
          Promise.resolve({
            status: 200,
            headers: { 'x-shopify-api-version': '2026-07' },
            body,
          });
        if (input.body.query.includes('AEOStudioPublicationAuthorization')) {
          return response({
            data: {
              shop: { myshopifyDomain: 'example-store.myshopify.com' },
              currentAppInstallation: { accessScopes: [{ handle: 'write_products' }] },
            },
          });
        }
        if (input.body.query.includes('AEOStudioFindProduct')) {
          const query = input.body.variables.query;
          return response({
            data: {
              products: {
                nodes:
                  storedProduct !== null && query === `handle:${String(storedProduct.handle)}`
                    ? [storedProduct]
                    : [],
              },
            },
          });
        }
        if (input.body.query.includes('AEOStudioGetProductById')) {
          return response({
            data: {
              product:
                storedProduct !== null && input.body.variables.id === storedProduct.id
                  ? storedProduct
                  : null,
            },
          });
        }
        if (input.body.query.includes('AEOStudioCreateProduct')) {
          const product = input.body.variables.product as {
            title: string;
            descriptionHtml: string;
            handle: string;
            status: string;
            metafields: Array<{ value: string }>;
          };
          storedProduct = {
            id: 'gid://shopify/Product/789',
            title: product.title,
            descriptionHtml: product.descriptionHtml,
            handle: product.handle,
            status: product.status,
            metafield: { value: product.metafields[0]?.value },
          };
          return response({
            data: { productCreate: { product: storedProduct, userErrors: [] } },
          });
        }
        if (input.body.query.includes('AEOStudioDeleteProduct')) {
          const deleteInput = input.body.variables.input as { id?: unknown };
          if (storedProduct?.id !== deleteInput.id) {
            return response({
              data: {
                productDelete: {
                  deletedProductId: null,
                  userErrors: [{ field: ['id'], message: 'not found' }],
                },
              },
            });
          }
          if (deleteResponseMode === 'PURE_REJECT') {
            return response({
              data: {
                productDelete: {
                  deletedProductId: null,
                  userErrors: [{ field: ['id'], message: 'provider rejected deletion' }],
                },
              },
            });
          }
          if (deleteResponseMode === 'MIXED') {
            return response({
              data: {
                productDelete: {
                  deletedProductId: deleteInput.id,
                  userErrors: [
                    {
                      field: ['id'],
                      message: 'provider returned deletedId and an error',
                    },
                  ],
                },
              },
            });
          }
          storedProduct = null;
          return response({
            data: {
              productDelete: { deletedProductId: deleteInput.id, userErrors: [] },
            },
          });
        }
        throw new Error(`UNEXPECTED_SHOPIFY_QUERY:${input.body.query}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const command = shopifyCommand(
      { kind: 'PRODUCT', operation: 'CREATE', handle: 'approved-product' },
      'Approved Product',
    );

    const result = await adapter.publish(command);

    expect(result).toMatchObject({
      outcome: 'APPLIED',
      remoteRef: 'https://admin.shopify.com/store/example-store/products/789',
      remoteState: {
        status: 'DRAFT',
        number: null,
        isProductionLive: false,
        rollbackHandle: {
          operation: 'DELETE_CREATED_DRAFT',
          shopDomain: 'example-store.myshopify.com',
          contentKind: 'PRODUCT',
          remoteId: 'gid://shopify/Product/789',
        },
      },
    });
    const mutation = request.mock.calls
      .map(([input]) => input)
      .find((input) => input.body.query.includes('AEOStudioCreateProduct'));
    expect(mutation?.body.variables).toMatchObject({
      product: {
        title: 'Approved Product',
        descriptionHtml: '<article><h1>Approved Product</h1></article>',
        handle: 'approved-product',
        status: 'DRAFT',
        metafields: [
          {
            namespace: 'aeostudio',
            key: 'publication',
            type: 'json',
          },
        ],
      },
    });
    const marker = JSON.parse(
      (
        mutation?.body.variables.product as {
          metafields: Array<{ value: string }>;
        }
      ).metafields[0]?.value ?? '',
    ) as Record<string, unknown>;
    expect(marker).toMatchObject({
      schemaVersion: 'aeostudio.shopify-publication.v1',
      publicationId: command.publicationId,
      packageChecksum: command.channelPackage.packageChecksum,
      artifactRevisionId: command.channelPackage.artifact.artifactRevisionId,
      artifactContentHash: command.channelPackage.artifact.contentHash,
    });
    expect(JSON.stringify({ result, variables: mutation?.body.variables })).not.toContain(
      'shopify-offline-access-token',
    );
    await expect(adapter.publish(command)).resolves.toMatchObject({
      outcome: 'APPLIED',
      remoteRef: 'https://admin.shopify.com/store/example-store/products/789',
    });
    await expect(adapter.reconcile(command)).resolves.toMatchObject({
      outcome: 'APPLIED',
      remoteRef: 'https://admin.shopify.com/store/example-store/products/789',
      remoteState: { status: 'DRAFT', isProductionLive: false },
    });
    expect(
      request.mock.calls.filter(([input]) => input.body.query.includes('AEOStudioCreateProduct')),
    ).toHaveLength(1);
    if (adapter.rollback === undefined) throw new Error('SHOPIFY_ROLLBACK_REQUIRED');
    const exactProduct = requiredStoredRecord(storedProduct, 'SHOPIFY_PRODUCT_REQUIRED');
    const otherPublication = {
      ...command,
      publicationId: '00000000-0000-7000-8000-000000007018',
      idempotencyKey: '00000000-0000-7000-8000-000000007018',
    };
    await expect(adapter.publish(otherPublication)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'SHOPIFY_HANDLE_CONFLICT',
    });
    await expect(adapter.reconcile(otherPublication)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    await expect(
      adapter.rollback({
        ...otherPublication,
        remoteRef: 'https://admin.shopify.com/store/example-store/products/789',
      }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_ROLLED_BACK',
      errorCode: 'SHOPIFY_ROLLBACK_REMOTE_EFFECT_CONFLICT',
    });
    storedProduct = {
      ...exactProduct,
      metafield: { value: '{"schemaVersion":"foreign-lineage"}' },
    };
    await expect(
      adapter.rollback({
        ...command,
        remoteRef: 'https://admin.shopify.com/store/example-store/products/789',
      }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_ROLLED_BACK',
      errorCode: 'SHOPIFY_ROLLBACK_REMOTE_EFFECT_CONFLICT',
    });
    storedProduct = exactProduct;
    await expect(
      adapter.rollback({
        ...command,
        remoteRef: 'https://admin.shopify.com/store/example-store/pages/789',
      }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_ROLLED_BACK',
      errorCode: 'SHOPIFY_ROLLBACK_REMOTE_REF_MISMATCH',
    });
    expect(
      request.mock.calls.filter(([input]) => input.body.query.includes('AEOStudioDeleteProduct')),
    ).toHaveLength(0);
    deleteResponseMode = 'PURE_REJECT';
    await expect(
      adapter.rollback({
        ...command,
        remoteRef: 'https://admin.shopify.com/store/example-store/products/789',
      }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_ROLLED_BACK',
      errorCode: 'SHOPIFY_ROLLBACK_REJECTED',
    });
    deleteResponseMode = 'MIXED';
    await expect(
      adapter.rollback({
        ...command,
        remoteRef: 'https://admin.shopify.com/store/example-store/products/789',
      }),
    ).resolves.toEqual({
      outcome: 'UNKNOWN',
      errorCode: 'SHOPIFY_ROLLBACK_RESULT_UNKNOWN',
    });
    deleteResponseMode = 'SUCCESS';
    storedProduct = { ...exactProduct, handle: 'renamed-after-create' };
    await expect(
      adapter.rollback({
        ...command,
        remoteRef: 'https://admin.shopify.com/store/example-store/products/789',
      }),
    ).resolves.toEqual({
      outcome: 'ROLLED_BACK',
      remoteRef: 'https://admin.shopify.com/store/example-store/products/789',
    });
    expect(
      request.mock.calls.filter(([input]) => input.body.query.includes('AEOStudioDeleteProduct')),
    ).toHaveLength(3);
    expect(
      request.mock.calls
        .map(([input]) => input)
        .find((input) => input.body.query.includes('AEOStudioGetProductById'))?.body.variables,
    ).toEqual({ id: 'gid://shopify/Product/789' });
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_NOT_FOUND',
    });
  });

  test('compensates an exact owned Product when Shopify creates it outside DRAFT', async () => {
    const request = vi.fn(
      (input: { body: { query: string; variables: Record<string, unknown> } }) => {
        const response = (body: unknown) =>
          Promise.resolve({
            status: 200,
            headers: { 'x-shopify-api-version': '2026-07' },
            body,
          });
        if (input.body.query.includes('AEOStudioPublicationAuthorization')) {
          return response({
            data: {
              shop: { myshopifyDomain: 'example-store.myshopify.com' },
              currentAppInstallation: { accessScopes: [{ handle: 'write_products' }] },
            },
          });
        }
        if (input.body.query.includes('AEOStudioFindProduct')) {
          return response({ data: { products: { nodes: [] } } });
        }
        if (input.body.query.includes('AEOStudioCreateProduct')) {
          const product = input.body.variables.product as {
            title: string;
            descriptionHtml: string;
            handle: string;
            metafields: Array<{ value: string }>;
          };
          return response({
            data: {
              productCreate: {
                product: {
                  id: 'gid://shopify/Product/789',
                  title: product.title,
                  descriptionHtml: product.descriptionHtml,
                  handle: product.handle,
                  status: 'ACTIVE',
                  metafield: { value: product.metafields[0]?.value },
                },
                userErrors: [
                  {
                    field: ['product'],
                    message: 'provider returned an object and an error',
                  },
                ],
              },
            },
          });
        }
        if (input.body.query.includes('AEOStudioDeleteProduct')) {
          const product = input.body.variables.input as { id: string };
          return response({
            data: {
              productDelete: {
                deletedProductId: product.id,
                userErrors: [],
              },
            },
          });
        }
        if (input.body.query.includes('AEOStudioGetProductById')) {
          return response({ data: { product: null } });
        }
        throw new Error(`UNEXPECTED_SHOPIFY_QUERY:${input.body.query}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const command = shopifyCommand(
      { kind: 'PRODUCT', operation: 'CREATE', handle: 'approved-product' },
      'Approved Product',
    );

    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATED',
    });
    expect(
      request.mock.calls
        .map(([input]) => input)
        .find((input) => input.body.query.includes('AEOStudioDeleteProduct'))?.body.variables,
    ).toEqual({ input: { id: 'gid://shopify/Product/789' } });
    expect(
      request.mock.calls
        .map(([input]) => input)
        .find((input) => input.body.query.includes('AEOStudioGetProductById'))?.body.variables,
    ).toEqual({ id: 'gid://shopify/Product/789' });
  });

  test('reconcile retries exact-ID Product compensation only with durable unsafe-create intent', async () => {
    let storedProduct: Record<string, unknown> | null = null;
    let deleteAttempts = 0;
    const request = vi.fn(
      (input: { body: { query: string; variables: Record<string, unknown> } }) => {
        const response = (body: unknown) =>
          Promise.resolve({
            status: 200,
            headers: { 'x-shopify-api-version': '2026-07' },
            body,
          });
        if (input.body.query.includes('AEOStudioPublicationAuthorization')) {
          return response({
            data: {
              shop: { myshopifyDomain: 'example-store.myshopify.com' },
              currentAppInstallation: { accessScopes: [{ handle: 'write_products' }] },
            },
          });
        }
        if (input.body.query.includes('AEOStudioFindProduct')) {
          return response({
            data: { products: { nodes: storedProduct === null ? [] : [storedProduct] } },
          });
        }
        if (input.body.query.includes('AEOStudioCreateProduct')) {
          const product = requiredInputRecord(input.body.variables.product);
          storedProduct = {
            id: 'gid://shopify/Product/789',
            title: product.title,
            descriptionHtml: product.descriptionHtml,
            handle: product.handle,
            status: 'ACTIVE',
            metafield: markerMetafield(product),
          };
          return response({
            data: { productCreate: { product: storedProduct, userErrors: [] } },
          });
        }
        if (input.body.query.includes('AEOStudioDeleteProduct')) {
          deleteAttempts += 1;
          expect(input.body.variables).toEqual({
            input: { id: 'gid://shopify/Product/789' },
          });
          if (deleteAttempts <= 2) throw new Error('fixture delete timeout');
          storedProduct = null;
          return response({
            data: {
              productDelete: {
                deletedProductId: 'gid://shopify/Product/789',
                userErrors: [],
              },
            },
          });
        }
        if (input.body.query.includes('AEOStudioGetProductById')) {
          return response({ data: { product: storedProduct } });
        }
        throw new Error(`UNEXPECTED_SHOPIFY_QUERY:${input.body.query}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const command = shopifyCommand(
      { kind: 'PRODUCT', operation: 'CREATE', handle: 'approved-product' },
      'Approved Product',
    );

    const initial = await adapter.publish(command);
    expect(initial).toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATION_FAILED',
      reconciliationIntent: {
        kind: 'COMPENSATE_UNSAFE_CREATE',
        remoteRef: 'https://admin.shopify.com/store/example-store/products/789',
      },
    });
    if (initial.outcome !== 'AMBIGUOUS' || initial.reconciliationIntent === undefined) {
      throw new Error('SHOPIFY_PRODUCT_COMPENSATION_INTENT_REQUIRED');
    }
    const reconcileWithIntent = {
      ...command,
      reconciliationIntent: initial.reconciliationIntent,
    };
    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    expect(
      request.mock.calls.filter(([input]) => input.body.query.includes('AEOStudioCreateProduct')),
    ).toHaveLength(1);
    const exactLiveProduct = requiredStoredRecord(storedProduct, 'EXACT_LIVE_PRODUCT_REQUIRED');
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    await expect(
      adapter.reconcile({
        ...command,
        reconciliationIntent: {
          kind: 'COMPENSATE_UNSAFE_CREATE',
          remoteRef: 'https://admin.shopify.com/store/example-store/products/999',
        },
      }),
    ).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    storedProduct = {
      ...exactLiveProduct,
      metafield: { value: '{"schemaVersion":"foreign-lineage"}' },
    };
    await expect(adapter.reconcile(reconcileWithIntent)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    storedProduct = {
      ...exactLiveProduct,
      descriptionHtml: '<p>Changed outside AEOStudio</p>',
    };
    await expect(adapter.reconcile(reconcileWithIntent)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT',
    });
    expect(deleteAttempts).toBe(1);
    storedProduct = exactLiveProduct;
    await expect(adapter.reconcile(reconcileWithIntent)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATION_FAILED',
    });
    await expect(adapter.reconcile(reconcileWithIntent)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATED',
    });
    expect(deleteAttempts).toBe(3);
    expect(storedProduct).toBeNull();
    expect(
      request.mock.calls.filter(([input]) => input.body.query.includes('AEOStudioGetProductById')),
    ).toHaveLength(1);
  });

  test('rejects every UPDATE target before any content mutation because safe restore is unavailable', async () => {
    const request = vi.fn(
      (input: { body: { query: string; variables: Record<string, unknown> } }) => {
        if (!input.body.query.includes('AEOStudioPublicationAuthorization')) {
          throw new Error(`UNEXPECTED_SHOPIFY_MUTATION:${input.body.query}`);
        }
        return Promise.resolve({
          status: 200,
          headers: { 'x-shopify-api-version': '2026-07' },
          body: {
            data: {
              shop: { myshopifyDomain: 'example-store.myshopify.com' },
              currentAppInstallation: {
                accessScopes: [{ handle: 'write_content' }, { handle: 'write_products' }],
              },
            },
          },
        });
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const targets = [
      encodeShopifyDraftTarget({
        schemaVersion: 'shopify-draft-target.v1',
        shopDomain: 'example-store.myshopify.com',
        apiVersion: '2026-07',
        destination: {
          kind: 'PAGE',
          operation: 'UPDATE',
          handle: 'approved-page',
          remoteId: 'gid://shopify/Page/123',
        },
      }),
      encodeShopifyDraftTarget({
        schemaVersion: 'shopify-draft-target.v1',
        shopDomain: 'example-store.myshopify.com',
        apiVersion: '2026-07',
        destination: {
          kind: 'BLOG_ARTICLE',
          operation: 'UPDATE',
          handle: 'approved-article',
          blogId: 'gid://shopify/Blog/700000000001',
          remoteId: 'gid://shopify/Article/456',
        },
      }),
      encodeShopifyDraftTarget({
        schemaVersion: 'shopify-draft-target.v1',
        shopDomain: 'example-store.myshopify.com',
        apiVersion: '2026-07',
        destination: {
          kind: 'PRODUCT',
          operation: 'UPDATE',
          handle: 'approved-product',
          remoteId: 'gid://shopify/Product/789',
        },
      }),
    ];

    const results = [];
    for (const target of targets) {
      results.push(await adapter.publish({ ...shopifyPageCommand(), target }));
    }

    expect(results).toEqual(
      targets.map(() => ({
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'SHOPIFY_UPDATE_REQUIRES_SAFE_RESTORE',
      })),
    );
    expect(request.mock.calls).toHaveLength(3);
    expect(
      request.mock.calls.every(([input]) =>
        input.body.query.includes('AEOStudioPublicationAuthorization'),
      ),
    ).toBe(true);
    expect(JSON.stringify(results)).not.toContain('shopify-offline-access-token');
  });

  test.each([
    {
      label: 'Page',
      command: () => shopifyPageCommand(),
      findOperation: 'AEOStudioFindPage',
      findData: { pages: { nodes: [] } },
      createOperation: 'AEOStudioCreatePage',
      createField: 'pageCreate',
      objectField: 'page',
    },
    {
      label: 'Blog Article',
      command: () =>
        shopifyCommand(
          {
            kind: 'BLOG_ARTICLE',
            operation: 'CREATE',
            handle: 'approved-article',
            blogId: 'gid://shopify/Blog/700000000001',
          },
          'Approved Article',
        ),
      findOperation: 'AEOStudioFindArticle',
      findData: { articles: { nodes: [] } },
      createOperation: 'AEOStudioCreateArticle',
      createField: 'articleCreate',
      objectField: 'article',
    },
    {
      label: 'Product',
      command: () =>
        shopifyCommand(
          { kind: 'PRODUCT', operation: 'CREATE', handle: 'approved-product' },
          'Approved Product',
        ),
      findOperation: 'AEOStudioFindProduct',
      findData: { products: { nodes: [] } },
      createOperation: 'AEOStudioCreateProduct',
      createField: 'productCreate',
      objectField: 'product',
    },
  ])(
    'keeps pure $label userErrors with no returned object definitely not applied',
    async ({ command, findOperation, findData, createOperation, createField, objectField }) => {
      const request = vi.fn(
        (input: { body: { query: string; variables: Record<string, unknown> } }) => {
          const response = (body: unknown) =>
            Promise.resolve({
              status: 200,
              headers: { 'x-shopify-api-version': '2026-07' },
              body,
            });
          if (input.body.query.includes('AEOStudioPublicationAuthorization')) {
            return response({
              data: {
                shop: { myshopifyDomain: 'example-store.myshopify.com' },
                currentAppInstallation: {
                  accessScopes: [{ handle: 'write_content' }, { handle: 'write_products' }],
                },
              },
            });
          }
          if (input.body.query.includes(findOperation)) {
            return response({ data: findData });
          }
          if (input.body.query.includes(createOperation)) {
            return response({
              data: {
                [createField]: {
                  [objectField]: null,
                  userErrors: [{ field: [objectField], message: 'fixture rejected' }],
                },
              },
            });
          }
          throw new Error(`UNEXPECTED_SHOPIFY_QUERY:${input.body.query}`);
        },
      );
      const adapter = createProductionPublicationAdapterRegistry({
        shopify: { request },
      }).resolve('shopify-draft', '1.0.0');
      if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');

      await expect(adapter.publish(command())).resolves.toEqual({
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'SHOPIFY_MUTATION_REJECTED',
      });
      expect(
        request.mock.calls.some(([input]) => input.body.query.includes('AEOStudioDelete')),
      ).toBe(false);
    },
  );

  test.each([
    {
      kind: 'PAGE' as const,
      label: 'Page',
      command: () => shopifyPageCommand(),
      findOperation: 'AEOStudioFindPage',
      findData: { pages: { nodes: [] } },
      createOperation: 'AEOStudioCreatePage',
    },
    {
      kind: 'BLOG_ARTICLE' as const,
      label: 'Blog Article',
      command: () =>
        shopifyCommand(
          {
            kind: 'BLOG_ARTICLE',
            operation: 'CREATE',
            handle: 'approved-article',
            blogId: 'gid://shopify/Blog/700000000001',
          },
          'Approved Article',
        ),
      findOperation: 'AEOStudioFindArticle',
      findData: { articles: { nodes: [] } },
      createOperation: 'AEOStudioCreateArticle',
    },
    {
      kind: 'PRODUCT' as const,
      label: 'Product',
      command: () =>
        shopifyCommand(
          { kind: 'PRODUCT', operation: 'CREATE', handle: 'approved-product' },
          'Approved Product',
        ),
      findOperation: 'AEOStudioFindProduct',
      findData: { products: { nodes: [] } },
      createOperation: 'AEOStudioCreateProduct',
    },
  ])(
    'keeps mixed safe $label object plus userErrors ambiguous without deleting it',
    async ({ kind, command, findOperation, findData, createOperation }) => {
      const request = vi.fn(
        (input: { body: { query: string; variables: Record<string, unknown> } }) => {
          const response = (body: unknown) =>
            Promise.resolve({
              status: 200,
              headers: { 'x-shopify-api-version': '2026-07' },
              body,
            });
          if (input.body.query.includes('AEOStudioPublicationAuthorization')) {
            return response({
              data: {
                shop: { myshopifyDomain: 'example-store.myshopify.com' },
                currentAppInstallation: {
                  accessScopes: [{ handle: 'write_content' }, { handle: 'write_products' }],
                },
              },
            });
          }
          if (input.body.query.includes(findOperation)) {
            return response({ data: findData });
          }
          if (input.body.query.includes(createOperation)) {
            const { createField, objectField, object } = mixedSafeCreateObject(
              kind,
              input.body.variables,
            );
            return response({
              data: {
                [createField]: {
                  [objectField]: object,
                  userErrors: [{ field: [objectField], message: 'mixed fixture result' }],
                },
              },
            });
          }
          throw new Error(`UNEXPECTED_SHOPIFY_QUERY:${input.body.query}`);
        },
      );
      const adapter = createProductionPublicationAdapterRegistry({
        shopify: { request },
      }).resolve('shopify-draft', '1.0.0');
      if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');

      await expect(adapter.publish(command())).resolves.toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'SHOPIFY_MUTATION_MIXED_RESULT',
      });
      expect(
        request.mock.calls.some(([input]) => input.body.query.includes('AEOStudioDelete')),
      ).toBe(false);
    },
  );

  test('rejects an expired public-app offline access token without contacting Shopify', async () => {
    const request = vi.fn();
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const command = withPublicAppCredential(shopifyPageCommand(), {
      issuedAt: '2020-01-01T00:00:00.000Z',
      accessTokenExpiresAt: '2020-01-01T01:00:00.000Z',
      refreshTokenExpiresAt: '2020-03-31T00:00:00.000Z',
    });

    await expect(adapter.validateAuthorization(command)).resolves.toEqual({
      outcome: 'UNKNOWN',
    });
    const result = await adapter.publish(command);

    expect(result).toEqual({
      outcome: 'RETRYABLE_FAILURE',
      errorCode: 'SHOPIFY_CREDENTIAL_REFRESH_REQUIRED',
    });
    expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('public-refresh-token-sentinel');
  });

  test('rejects a public-app token at the five-minute refresh boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T02:00:00.000Z'));
    try {
      const request = vi.fn();
      const adapter = createProductionPublicationAdapterRegistry({
        shopify: { request },
      }).resolve('shopify-draft', '1.0.0');
      if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
      const command = withPublicAppCredential(shopifyPageCommand(), {
        issuedAt: '2026-07-24T01:05:00.000Z',
        accessTokenExpiresAt: '2026-07-24T02:05:00.000Z',
        refreshTokenExpiresAt: '2026-10-22T01:05:00.000Z',
      });

      await expect(adapter.publish(command)).resolves.toEqual({
        outcome: 'RETRYABLE_FAILURE',
        errorCode: 'SHOPIFY_CREDENTIAL_REFRESH_REQUIRED',
      });
      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('exposes a token-free rotation request for an atomic credential rotation port', () => {
    const adapter = directShopifyAdapter(vi.fn(), new Date('2026-07-24T02:00:00.000Z'));
    const command = withPublicAppCredential(shopifyPageCommand(), {
      issuedAt: '2026-07-24T01:05:00.000Z',
      accessTokenExpiresAt: '2026-07-24T02:05:00.000Z',
      refreshTokenExpiresAt: '2026-10-22T01:05:00.000Z',
    });

    const request = adapter.credentialRotationRequestFor(command);

    expect(request).toEqual({
      credentialId: 'shopify-credential-example-store',
      tenantId: command.channelPackage.tenantId,
      workspaceId: command.channelPackage.workspaceId,
      publicationId: command.publicationId,
      shopDomain: 'example-store.myshopify.com',
      apiVersion: '2026-07',
      expectedRotationVersion: 'rotation-v1',
      reason: 'ACCESS_TOKEN_NEAR_EXPIRY',
    });
    expect(JSON.stringify(request)).not.toContain('public-access-token-sentinel');
    expect(JSON.stringify(request)).not.toContain('public-refresh-token-sentinel');
  });

  test('fails reconciliation and rollback closed when the public-app token requires refresh', async () => {
    const request = vi.fn();
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null || adapter.rollback === undefined) {
      throw new Error('SHOPIFY_ADAPTER_WITH_ROLLBACK_REQUIRED');
    }
    const command = withPublicAppCredential(shopifyPageCommand(), {
      issuedAt: '2020-01-01T00:00:00.000Z',
      accessTokenExpiresAt: '2020-01-01T01:00:00.000Z',
      refreshTokenExpiresAt: '2020-03-31T00:00:00.000Z',
    });

    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'RETRYABLE_FAILURE',
      errorCode: 'SHOPIFY_CREDENTIAL_REFRESH_REQUIRED',
    });
    await expect(
      adapter.rollback({
        ...command,
        remoteRef: 'https://admin.shopify.com/store/example-store/pages/123',
      }),
    ).resolves.toEqual({
      outcome: 'UNKNOWN',
      errorCode: 'SHOPIFY_CREDENTIAL_REFRESH_REQUIRED',
    });
    expect(request).not.toHaveBeenCalled();
  });

  test('rejects an over-8-MiB GraphQL mutation body before the Node transport can send it', async () => {
    const observedQueries: string[] = [];
    const fetchImplementation: typeof fetch = (_input, init) => {
      const requestBody = JSON.parse(stringRequestBody(init)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      observedQueries.push(requestBody.query);
      const body = requestBody.query.includes('AEOStudioPublicationAuthorization')
        ? {
            data: {
              shop: { myshopifyDomain: 'example-store.myshopify.com' },
              currentAppInstallation: { accessScopes: [{ handle: 'write_content' }] },
            },
          }
        : requestBody.query.includes('AEOStudioFindPage')
          ? { data: { pages: { nodes: [] } } }
          : { errors: [{ message: 'mutation unexpectedly reached the network' }] };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-shopify-api-version': '2026-07',
          },
        }),
      );
    };
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: new NodeShopifyGraphqlTransport({ fetch: fetchImplementation }),
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const command = shopifyPageCommand();
    command.payload.files['content.html'] = 'x'.repeat(8 * 1_024 * 1_024);

    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'SHOPIFY_MUTATION_REQUEST_TOO_LARGE',
    });
    expect(observedQueries).toHaveLength(2);
    expect(observedQueries.every((query) => !query.includes('mutation'))).toBe(true);
  });

  test('rejects an over-8-MiB Article mutation body before the Node transport can send it', async () => {
    const observedQueries: string[] = [];
    const fetchImplementation: typeof fetch = (_input, init) => {
      const requestBody = JSON.parse(stringRequestBody(init)) as { query: string };
      observedQueries.push(requestBody.query);
      return Promise.resolve(
        new Response(
          JSON.stringify(
            requestBody.query.includes('AEOStudioPublicationAuthorization')
              ? {
                  data: {
                    shop: { myshopifyDomain: 'example-store.myshopify.com' },
                    currentAppInstallation: { accessScopes: [{ handle: 'write_content' }] },
                  },
                }
              : { data: { articles: { nodes: [] } } },
          ),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-shopify-api-version': '2026-07',
            },
          },
        ),
      );
    };
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: new NodeShopifyGraphqlTransport({ fetch: fetchImplementation }),
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const command = shopifyCommand(
      {
        kind: 'BLOG_ARTICLE',
        operation: 'CREATE',
        handle: 'approved-article',
        blogId: 'gid://shopify/Blog/700000000001',
      },
      'Approved Article',
    );
    command.payload.files['content.html'] = 'x'.repeat(8 * 1_024 * 1_024);

    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'SHOPIFY_MUTATION_REQUEST_TOO_LARGE',
    });
    expect(observedQueries).toHaveLength(2);
  });

  test('rejects an over-8-MiB Product mutation body before the Node transport can send it', async () => {
    const observedQueries: string[] = [];
    const fetchImplementation: typeof fetch = (_input, init) => {
      const requestBody = JSON.parse(stringRequestBody(init)) as { query: string };
      observedQueries.push(requestBody.query);
      return Promise.resolve(
        new Response(
          JSON.stringify(
            requestBody.query.includes('AEOStudioPublicationAuthorization')
              ? {
                  data: {
                    shop: { myshopifyDomain: 'example-store.myshopify.com' },
                    currentAppInstallation: { accessScopes: [{ handle: 'write_products' }] },
                  },
                }
              : { data: { products: { nodes: [] } } },
          ),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-shopify-api-version': '2026-07',
            },
          },
        ),
      );
    };
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: new NodeShopifyGraphqlTransport({ fetch: fetchImplementation }),
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const command = shopifyCommand(
      { kind: 'PRODUCT', operation: 'CREATE', handle: 'approved-product' },
      'Approved Product',
    );
    command.payload.files['content.html'] = 'x'.repeat(8 * 1_024 * 1_024);

    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'SHOPIFY_MUTATION_REQUEST_TOO_LARGE',
    });
    expect(observedQueries).toHaveLength(2);
  });

  test('maps provider failures to safe diagnostics without exposing credential material', async () => {
    const credentialSentinel = 'shopify-secret-that-must-never-escape';
    const request = vi.fn(() =>
      Promise.reject(new Error(`provider failed with ${credentialSentinel}`)),
    );
    const adapter = createProductionPublicationAdapterRegistry({
      shopify: { request },
    }).resolve('shopify-draft', '1.0.0');
    if (adapter === null) throw new Error('SHOPIFY_ADAPTER_REQUIRED');
    const command = {
      ...shopifyPageCommand(),
      secretValue: JSON.stringify({
        schemaVersion: 'aeostudio.shopify-offline-credential.v1',
        shopDomain: 'example-store.myshopify.com',
        apiVersion: '2026-07',
        accessToken: credentialSentinel,
      }),
    };

    const result = await adapter.publish(command);

    expect(result).toEqual({
      outcome: 'RETRYABLE_FAILURE',
      errorCode: 'SHOPIFY_AUTHORIZATION_UNAVAILABLE',
    });
    expect(JSON.stringify(result)).not.toContain(credentialSentinel);
  });
});

type ShopifyCreateDestination =
  | { kind: 'PAGE'; operation: 'CREATE'; handle: string }
  | {
      kind: 'BLOG_ARTICLE';
      operation: 'CREATE';
      handle: string;
      blogId: string;
    }
  | { kind: 'PRODUCT'; operation: 'CREATE'; handle: string };

function shopifyPageCommand(): PublicationAdapterCommand {
  return shopifyCommand(
    { kind: 'PAGE', operation: 'CREATE', handle: 'approved-page' },
    'Approved Page',
  );
}

function shopifyCommand(
  destination: ShopifyCreateDestination,
  headline: string,
): PublicationAdapterCommand {
  const payload: ChannelPackagePayload = {
    files: {
      'content.md': `# ${headline}\n`,
      'content.html': `<article><h1>${headline}</h1></article>`,
      'structured-data.json': JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline,
        abstract: 'Approved summary',
      }),
    },
  };
  const channelPackage: ChannelPackageRecord = {
    id: '00000000-0000-7000-8000-000000007010',
    tenantId: '00000000-0000-7000-8000-000000007011',
    workspaceId: '00000000-0000-7000-8000-000000007012',
    packageRevision: 1,
    channel: {
      definitionId: '00000000-0000-7000-8000-000000007013',
      channelKey: 'shopify-draft',
    },
    transformer: { key: 'generic-web-package', version: '1.0.0' },
    packageSchemaVersion: '1.0.0',
    artifact: {
      artifactId: '00000000-0000-7000-8000-000000007014',
      artifactRevisionId: '00000000-0000-7000-8000-000000007015',
      revision: 1,
      contentHash: 'a'.repeat(64),
      type: 'DEFINITION_PRODUCT',
      locale: 'en-SG',
      market: 'SG',
      methodPolicyVersion: 'production-shopify-test-v1',
    },
    manifest: {
      schemaVersion: '1.0.0',
      files: Object.entries(payload.files).map(([path, value]) => ({
        path,
        mediaType:
          path === 'content.md'
            ? 'text/markdown'
            : path === 'content.html'
              ? 'text/html'
              : 'application/ld+json',
        sha256: 'b'.repeat(64),
        byteLength: Buffer.byteLength(value, 'utf8'),
      })),
      assetRefs: [],
      claimSourceMap: [],
    },
    packageChecksum: 'c'.repeat(64),
    payloadObjectRef: 's3://test-bucket/channel-package.json',
    createdByUserId: '00000000-0000-7000-8000-000000007016',
    createdAt: '2026-07-24T00:00:00.000Z',
  };
  return {
    publicationId: '00000000-0000-7000-8000-000000007017',
    idempotencyKey: '00000000-0000-7000-8000-000000007017',
    target: encodeShopifyDraftTarget({
      schemaVersion: 'shopify-draft-target.v1',
      shopDomain: 'example-store.myshopify.com',
      apiVersion: '2026-07',
      destination,
    }),
    channelPackage,
    payload,
    secretValue: JSON.stringify({
      schemaVersion: 'aeostudio.shopify-offline-credential.v1',
      shopDomain: 'example-store.myshopify.com',
      apiVersion: '2026-07',
      accessToken: 'shopify-offline-access-token',
    }),
  };
}

function withPublicAppCredential(
  command: PublicationAdapterCommand,
  timestamps: {
    issuedAt: string;
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
  },
): PublicationAdapterCommand {
  return {
    ...command,
    secretValue: JSON.stringify({
      schemaVersion: 'aeostudio.shopify-expiring-offline-credential.v2',
      distribution: 'PUBLIC',
      credentialId: 'shopify-credential-example-store',
      shopDomain: 'example-store.myshopify.com',
      apiVersion: '2026-07',
      accessToken: 'public-access-token-sentinel',
      issuedAt: timestamps.issuedAt,
      accessTokenExpiresAt: timestamps.accessTokenExpiresAt,
      refreshToken: 'public-refresh-token-sentinel',
      refreshTokenExpiresAt: timestamps.refreshTokenExpiresAt,
      rotationVersion: 'rotation-v1',
    }),
  };
}

function directShopifyAdapter(
  request: (input: {
    url: string;
    headers: Record<string, string>;
    body: { query: string; variables: Record<string, unknown> };
    timeoutMs?: number;
    maxResponseBytes?: number;
  }) => Promise<{ status: number; headers: Record<string, string>; body: unknown }>,
  now: Date,
) {
  return new ProductionShopifyDraftPublicationAdapter({
    descriptor: {
      adapterKey: 'shopify-draft',
      adapterVersion: '1.0.0',
      providerApiVersion: '2026-07',
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
      requiredScopes: ['write_content', 'write_products'],
      termsVersion: 'shopify-provider-terms-v1',
      processingRegion: 'Provider-controlled',
      retentionPolicy: 'Shopify policy',
      trainingPolicy: 'No training',
      subprocessors: [],
      ratePolicy: { mode: 'graphql-cost-throttle' },
    },
    transport: { request },
    clock: { now: () => new Date(now) },
  });
}

function requiredStoredRecord(
  value: Record<string, unknown> | null,
  errorCode: string,
): Record<string, unknown> {
  if (value === null) throw new Error(errorCode);
  return value;
}

function stringRequestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('STRING_REQUEST_BODY_REQUIRED');
  return init.body;
}

function mixedSafeCreateObject(
  kind: 'PAGE' | 'BLOG_ARTICLE' | 'PRODUCT',
  variables: Record<string, unknown>,
): { createField: string; objectField: string; object: Record<string, unknown> } {
  if (kind === 'PAGE') {
    const page = requiredInputRecord(variables.page);
    return {
      createField: 'pageCreate',
      objectField: 'page',
      object: {
        id: 'gid://shopify/Page/123',
        title: page.title,
        body: page.body,
        handle: page.handle,
        isPublished: false,
        metafield: markerMetafield(page),
      },
    };
  }
  if (kind === 'BLOG_ARTICLE') {
    const article = requiredInputRecord(variables.article);
    return {
      createField: 'articleCreate',
      objectField: 'article',
      object: {
        id: 'gid://shopify/Article/456',
        title: article.title,
        body: article.body,
        handle: article.handle,
        isPublished: false,
        blog: { id: article.blogId },
        metafield: markerMetafield(article),
      },
    };
  }
  const product = requiredInputRecord(variables.product);
  return {
    createField: 'productCreate',
    objectField: 'product',
    object: {
      id: 'gid://shopify/Product/789',
      title: product.title,
      descriptionHtml: product.descriptionHtml,
      handle: product.handle,
      status: 'DRAFT',
      metafield: markerMetafield(product),
    },
  };
}

function requiredInputRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SHOPIFY_INPUT_RECORD_REQUIRED');
  }
  return value as Record<string, unknown>;
}

function markerMetafield(input: Record<string, unknown>): { value: unknown } {
  if (!Array.isArray(input.metafields)) throw new Error('SHOPIFY_METAFIELDS_REQUIRED');
  const first = requiredInputRecord(input.metafields[0]);
  return { value: first.value };
}

function publishedPageRequest(compensation: 'SUCCESS' | 'FAILURE' | 'THROW') {
  return vi.fn((input: { body: { query: string; variables: Record<string, unknown> } }) => {
    const response = (body: unknown) =>
      Promise.resolve({
        status: 200,
        headers: { 'x-shopify-api-version': '2026-07' },
        body,
      });
    if (input.body.query.includes('AEOStudioPublicationAuthorization')) {
      return response({
        data: {
          shop: { myshopifyDomain: 'example-store.myshopify.com' },
          currentAppInstallation: { accessScopes: [{ handle: 'write_content' }] },
        },
      });
    }
    if (input.body.query.includes('AEOStudioFindPage')) {
      return response({ data: { pages: { nodes: [] } } });
    }
    if (input.body.query.includes('AEOStudioCreatePage')) {
      const page = input.body.variables.page as {
        title: string;
        body: string;
        handle: string;
        metafields: Array<{ value: string }>;
      };
      return response({
        data: {
          pageCreate: {
            page: {
              id: 'gid://shopify/Page/123',
              title: page.title,
              body: page.body,
              handle: page.handle,
              isPublished: true,
              metafield: { value: page.metafields[0]?.value },
            },
            userErrors: [],
          },
        },
      });
    }
    if (input.body.query.includes('AEOStudioDeletePage')) {
      if (compensation === 'THROW') {
        throw new Error('provider leaked refresh-or-access-secret');
      }
      return response({
        data: {
          pageDelete: {
            deletedPageId: compensation === 'SUCCESS' ? input.body.variables.id : null,
            userErrors:
              compensation === 'SUCCESS'
                ? []
                : [{ code: 'LOCKED', field: ['id'], message: 'cannot delete' }],
          },
        },
      });
    }
    throw new Error(`UNEXPECTED_SHOPIFY_QUERY:${input.body.query}`);
  });
}
