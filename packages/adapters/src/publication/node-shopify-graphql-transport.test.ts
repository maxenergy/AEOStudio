import { describe, expect, test } from 'vitest';

import { NodeShopifyGraphqlTransport } from './node-shopify-graphql-transport.js';

describe('Node Shopify GraphQL transport', () => {
  test('posts JSON to an exact Shopify Admin GraphQL endpoint and normalizes response headers', async () => {
    let observedUrl = '';
    let observedInit: RequestInit | undefined;
    const fetchImplementation: typeof fetch = (input, init) => {
      observedUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      observedInit = init;
      return Promise.resolve(
        new Response(JSON.stringify({ data: { shop: { name: 'Acme' } } }), {
          status: 200,
          headers: {
            'X-Shopify-Api-Version': '2026-07',
            'X-Request-Id': 'request-1',
          },
        }),
      );
    };

    const response = await new NodeShopifyGraphqlTransport({
      fetch: fetchImplementation,
    }).request({
      url: 'https://acme-shop.myshopify.com/admin/api/2026-07/graphql.json',
      headers: {
        Accept: 'application/json',
        'X-Shopify-Access-Token': 'shopify-token',
      },
      body: {
        query: 'query ShopName { shop { name } }',
        variables: {},
      },
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
    });

    expect(observedUrl).toBe('https://acme-shop.myshopify.com/admin/api/2026-07/graphql.json');
    expect(observedInit?.method).toBe('POST');
    expect(observedInit?.body).toBe(
      JSON.stringify({
        query: 'query ShopName { shop { name } }',
        variables: {},
      }),
    );
    expect(observedInit?.redirect).toBe('error');
    expect(new Headers(observedInit?.headers).get('accept')).toBe('application/json');
    expect(new Headers(observedInit?.headers).get('content-type')).toBe('application/json');
    expect(new Headers(observedInit?.headers).get('x-shopify-access-token')).toBe('shopify-token');
    expect(response).toEqual({
      status: 200,
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
        'x-request-id': 'request-1',
        'x-shopify-api-version': '2026-07',
      },
      body: { data: { shop: { name: 'Acme' } } },
    });
  });

  test.each([
    'http://acme.myshopify.com/admin/api/2026-07/graphql.json',
    'https://api.shopify.com/admin/api/2026-07/graphql.json',
    'https://acme.myshopify.com.attacker.test/admin/api/2026-07/graphql.json',
    'https://acme.myshopify.com:443/admin/api/2026-07/graphql.json',
    'https://user@acme.myshopify.com/admin/api/2026-07/graphql.json',
    'https://acme.myshopify.com/admin/api/2026-08/graphql.json',
    'https://acme.myshopify.com/admin/api/2026-07/graphql.json?redirect=1',
    'https://acme.myshopify.com/admin/api/2026-07/graphql.json#fragment',
    'https://-acme.myshopify.com/admin/api/2026-07/graphql.json',
  ])('rejects a non-canonical Shopify GraphQL URL before fetch: %s', async (url) => {
    let requestCount = 0;
    const fetchImplementation: typeof fetch = () => {
      requestCount += 1;
      return Promise.resolve(new Response('{}'));
    };

    let rejected: unknown;
    try {
      await new NodeShopifyGraphqlTransport({ fetch: fetchImplementation }).request({
        url,
        headers: { 'x-shopify-access-token': 'must-not-leak' },
        body: { query: 'query Sensitive { secret }', variables: {} },
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toMatchObject({
      code: 'URL_INVALID',
      message: 'URL_INVALID',
    });
    expect(String(rejected)).not.toContain(url);
    expect(String(rejected)).not.toContain('must-not-leak');
    expect(requestCount).toBe(0);
  });

  test('rejects invalid request headers without exposing the access token', async () => {
    let requestCount = 0;
    const fetchImplementation: typeof fetch = () => {
      requestCount += 1;
      return Promise.resolve(new Response('{}'));
    };

    let rejected: unknown;
    try {
      await new NodeShopifyGraphqlTransport({ fetch: fetchImplementation }).request({
        url: 'https://acme.myshopify.com/admin/api/2026-07/graphql.json',
        headers: {
          'x-shopify-access-token': 'must-not-leak\r\nx-injected: yes',
        },
        body: { query: 'query Shop { shop { name } }', variables: {} },
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toMatchObject({
      code: 'REQUEST_INVALID',
      message: 'REQUEST_INVALID',
    });
    expect(String(rejected)).not.toContain('must-not-leak');
    expect(requestCount).toBe(0);
  });

  test('redacts request content when JSON serialization fails', async () => {
    const variables = {
      toJSON() {
        throw new Error('serialization exposed sensitive-body');
      },
    };

    let rejected: unknown;
    try {
      await new NodeShopifyGraphqlTransport({
        fetch: () => Promise.resolve(new Response('{}')),
      }).request({
        url: 'https://acme.myshopify.com/admin/api/2026-07/graphql.json',
        headers: { 'x-shopify-access-token': 'must-not-leak' },
        body: { query: 'mutation Sensitive { secret }', variables },
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toMatchObject({
      code: 'REQUEST_INVALID',
      message: 'REQUEST_INVALID',
    });
    expect(String(rejected)).not.toContain('must-not-leak');
    expect(String(rejected)).not.toContain('sensitive-body');
  });

  test('rejects an oversized GraphQL request before it can leave the process', async () => {
    let requestCount = 0;
    const fetchImplementation: typeof fetch = () => {
      requestCount += 1;
      return Promise.resolve(new Response('{}'));
    };

    let rejected: unknown;
    try {
      await new NodeShopifyGraphqlTransport({
        fetch: fetchImplementation,
        maxRequestBytes: 8,
      }).request({
        url: 'https://acme.myshopify.com/admin/api/2026-07/graphql.json',
        headers: { 'x-shopify-access-token': 'must-not-leak' },
        body: {
          query: 'mutation Sensitive { secret }',
          variables: { content: 'sensitive-body' },
        },
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toMatchObject({
      code: 'REQUEST_TOO_LARGE',
      message: 'REQUEST_TOO_LARGE',
    });
    expect(String(rejected)).not.toContain('must-not-leak');
    expect(String(rejected)).not.toContain('sensitive-body');
    expect(requestCount).toBe(0);
  });

  test.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
    'fails closed when the configured request byte cap is invalid: %s',
    (maxRequestBytes) => {
      expect(() => new NodeShopifyGraphqlTransport({ maxRequestBytes })).toThrowError(
        expect.objectContaining({
          code: 'REQUEST_LIMIT_INVALID',
          message: 'REQUEST_LIMIT_INVALID',
        }),
      );
    },
  );

  test('rejects an oversized declared response without exposing token, body, or URL', async () => {
    const url = 'https://acme.myshopify.com/admin/api/2026-07/graphql.json';
    const fetchImplementation: typeof fetch = () =>
      Promise.resolve(
        new Response('{"secret":"sensitive-response"}', {
          headers: { 'content-length': '4096' },
        }),
      );

    let rejected: unknown;
    try {
      await new NodeShopifyGraphqlTransport({ fetch: fetchImplementation }).request({
        url,
        headers: { 'x-shopify-access-token': 'must-not-leak' },
        body: { query: 'query Shop { shop { name } }', variables: {} },
        maxResponseBytes: 32,
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      message: 'RESPONSE_TOO_LARGE',
    });
    expect(String(rejected)).not.toContain('must-not-leak');
    expect(String(rejected)).not.toContain('sensitive-response');
    expect(String(rejected)).not.toContain(url);
  });

  test('stops an undeclared response stream once its bytes exceed the cap', async () => {
    let streamCancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":"'));
        controller.enqueue(new TextEncoder().encode('x'.repeat(64)));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
      cancel() {
        streamCancelled = true;
      },
    });
    const fetchImplementation: typeof fetch = () => Promise.resolve(new Response(responseBody));

    await expect(
      new NodeShopifyGraphqlTransport({ fetch: fetchImplementation }).request({
        url: 'https://acme.myshopify.com/admin/api/2026-07/graphql.json',
        headers: {},
        body: { query: 'query Shop { shop { name } }', variables: {} },
        maxResponseBytes: 32,
      }),
    ).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      message: 'RESPONSE_TOO_LARGE',
    });
    expect(streamCancelled).toBe(true);
  });

  test.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid response byte cap before issuing a request: %s',
    async (maxResponseBytes) => {
      let requestCount = 0;
      const fetchImplementation: typeof fetch = () => {
        requestCount += 1;
        return Promise.resolve(new Response('{}'));
      };

      await expect(
        new NodeShopifyGraphqlTransport({ fetch: fetchImplementation }).request({
          url: 'https://acme.myshopify.com/admin/api/2026-07/graphql.json',
          headers: {},
          body: { query: 'query Shop { shop { name } }', variables: {} },
          maxResponseBytes,
        }),
      ).rejects.toMatchObject({
        code: 'RESPONSE_LIMIT_INVALID',
        message: 'RESPONSE_LIMIT_INVALID',
      });
      expect(requestCount).toBe(0);
    },
  );

  test('aborts a pending Shopify request when its total deadline expires', async () => {
    const fetchImplementation: typeof fetch = (_input, init) =>
      new Promise<Response>((resolve, reject) => {
        const completion = setTimeout(() => resolve(new Response('{}')), 100);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(completion);
            reject(new Error('abort exposed must-not-leak and sensitive-body'));
          },
          { once: true },
        );
      });

    let rejected: unknown;
    try {
      await new NodeShopifyGraphqlTransport({ fetch: fetchImplementation }).request({
        url: 'https://acme.myshopify.com/admin/api/2026-07/graphql.json',
        headers: { 'x-shopify-access-token': 'must-not-leak' },
        body: {
          query: 'mutation Sensitive { secret }',
          variables: { content: 'sensitive-body' },
        },
        timeoutMs: 10,
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toMatchObject({
      code: 'FETCH_TIMEOUT',
      message: 'FETCH_TIMEOUT',
    });
    expect(String(rejected)).not.toContain('must-not-leak');
    expect(String(rejected)).not.toContain('sensitive-body');
  });

  test('applies the total deadline while reading a stalled response body', async () => {
    let streamCancelled = false;
    let completion: ReturnType<typeof setTimeout> | undefined;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        completion = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('{}'));
          controller.close();
        }, 500);
      },
      cancel() {
        streamCancelled = true;
        if (completion !== undefined) clearTimeout(completion);
      },
    });
    const fetchImplementation: typeof fetch = () => Promise.resolve(new Response(responseBody));
    const startedAt = performance.now();

    await expect(
      new NodeShopifyGraphqlTransport({ fetch: fetchImplementation }).request({
        url: 'https://acme.myshopify.com/admin/api/2026-07/graphql.json',
        headers: { 'x-shopify-access-token': 'must-not-leak' },
        body: { query: 'query Shop { shop { name } }', variables: {} },
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      code: 'FETCH_TIMEOUT',
      message: 'FETCH_TIMEOUT',
    });

    expect(performance.now() - startedAt).toBeLessThan(300);
    expect(streamCancelled).toBe(true);
  });

  test('enforces the total deadline even when an injected fetch ignores abort', async () => {
    const fetchImplementation: typeof fetch = () =>
      new Promise<Response>((resolve) => {
        const completion = setTimeout(() => resolve(new Response('{}')), 500);
        completion.unref();
      });
    const startedAt = performance.now();

    await expect(
      new NodeShopifyGraphqlTransport({ fetch: fetchImplementation }).request({
        url: 'https://acme.myshopify.com/admin/api/2026-07/graphql.json',
        headers: {},
        body: { query: 'query Shop { shop { name } }', variables: {} },
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      code: 'FETCH_TIMEOUT',
      message: 'FETCH_TIMEOUT',
    });

    expect(performance.now() - startedAt).toBeLessThan(300);
  });

  test.each([0, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'rejects an invalid total timeout before issuing a request: %s',
    async (timeoutMs) => {
      let requestCount = 0;
      const fetchImplementation: typeof fetch = () => {
        requestCount += 1;
        return Promise.resolve(new Response('{}'));
      };

      await expect(
        new NodeShopifyGraphqlTransport({ fetch: fetchImplementation }).request({
          url: 'https://acme.myshopify.com/admin/api/2026-07/graphql.json',
          headers: {},
          body: { query: 'query Shop { shop { name } }', variables: {} },
          timeoutMs,
        }),
      ).rejects.toMatchObject({
        code: 'TIMEOUT_INVALID',
        message: 'TIMEOUT_INVALID',
      });
      expect(requestCount).toBe(0);
    },
  );

  test('redacts token, request body, and URL from provider failures', async () => {
    const url = 'https://acme.myshopify.com/admin/api/2026-07/graphql.json';
    const fetchImplementation: typeof fetch = () =>
      Promise.reject(
        new Error(`socket failed at ${url} with token must-not-leak while sending sensitive-body`),
      );

    let rejected: unknown;
    try {
      await new NodeShopifyGraphqlTransport({ fetch: fetchImplementation }).request({
        url,
        headers: { 'x-shopify-access-token': 'must-not-leak' },
        body: {
          query: 'mutation Sensitive { secret }',
          variables: { content: 'sensitive-body' },
        },
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toMatchObject({
      code: 'REQUEST_FAILED',
      message: 'REQUEST_FAILED',
    });
    expect(String(rejected)).not.toContain('must-not-leak');
    expect(String(rejected)).not.toContain('sensitive-body');
    expect(String(rejected)).not.toContain(url);
  });
});
