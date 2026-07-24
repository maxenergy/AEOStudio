import { describe, expect, test, vi } from 'vitest';

import {
  SafeCrawlerFetch,
  type CrawlerDnsResolver,
  type CrawlerHttpTransport,
} from '@aeostudio/adapters/crawler';

describe('Task 5 SSRF-safe fetch boundary', () => {
  test.each([
    ['not-a-url', 'INVALID_URL'],
    ['file:///etc/passwd', 'SCHEME_NOT_ALLOWED'],
    ['https://other.example.test/', 'HOST_NOT_ALLOWED'],
  ])('fails closed for disallowed URL %s', async (url, errorCode) => {
    const resolver: CrawlerDnsResolver = {
      resolve: () => Promise.resolve(['93.184.216.34']),
    };
    const transport: CrawlerHttpTransport = {
      get: () => Promise.reject(new Error('transport must not be called')),
    };
    const fetcher = new SafeCrawlerFetch(resolver, transport);

    await expect(
      fetcher.fetch({
        url,
        allowedHostname: 'docs.example.test',
        maxBytes: 1_000_000,
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({ outcome: 'SSRF_BLOCKED', errorCode });
  });

  test('an HTTP(S) page on the verified hostname is retrievable through the pinned address', async () => {
    const resolver: CrawlerDnsResolver = {
      resolve: () => Promise.resolve(['93.184.216.34']),
    };
    const transport: CrawlerHttpTransport = {
      get: (input) =>
        Promise.resolve({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: new TextEncoder().encode('<html><title>Fixture</title></html>'),
          location: null,
          connectedAddress: input.address,
        }),
    };
    const fetcher = new SafeCrawlerFetch(resolver, transport);

    await expect(
      fetcher.fetch({
        url: 'https://docs.example.test/',
        allowedHostname: 'docs.example.test',
        maxBytes: 1_000_000,
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      finalUrl: 'https://docs.example.test/',
      response: { status: 200, contentType: 'text/html; charset=utf-8' },
    });
  });

  test.each([
    '127.0.0.1',
    '10.0.0.7',
    '172.16.0.9',
    '192.168.1.8',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    'fe80::1',
    'fd00:ec2::254',
    '::ffff:127.0.0.1',
  ])('blocks non-public address %s before transport', async (address) => {
    const resolver: CrawlerDnsResolver = {
      resolve: () => Promise.resolve([address]),
    };
    const transport: CrawlerHttpTransport = {
      get: (input) =>
        Promise.resolve({
          status: 200,
          contentType: 'text/html',
          body: new Uint8Array(),
          location: null,
          connectedAddress: input.address,
        }),
    };
    const fetcher = new SafeCrawlerFetch(resolver, transport);

    await expect(
      fetcher.fetch({
        url: 'https://docs.example.test/',
        allowedHostname: 'docs.example.test',
        maxBytes: 1_000_000,
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({ outcome: 'SSRF_BLOCKED', errorCode: 'NON_PUBLIC_ADDRESS' });
  });

  test('blocks a redirect from the verified host to a metadata endpoint', async () => {
    const resolver: CrawlerDnsResolver = {
      resolve: () => Promise.resolve(['93.184.216.34']),
    };
    const transport: CrawlerHttpTransport = {
      get: (input) =>
        Promise.resolve({
          status: 302,
          contentType: 'text/html',
          body: new Uint8Array(),
          location: 'http://169.254.169.254/latest/meta-data/',
          connectedAddress: input.address,
        }),
    };
    const fetcher = new SafeCrawlerFetch(resolver, transport);

    await expect(
      fetcher.fetch({
        url: 'https://docs.example.test/redirect',
        allowedHostname: 'docs.example.test',
        maxBytes: 1_000_000,
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({ outcome: 'SSRF_BLOCKED', errorCode: 'HOST_NOT_ALLOWED' });
  });

  test.each(['RESPONSE_TOO_LARGE', 'FETCH_TIMEOUT'] as const)(
    'reports controlled transport failure %s without a false success',
    async (errorCode) => {
      const resolver: CrawlerDnsResolver = {
        resolve: () => Promise.resolve(['93.184.216.34']),
      };
      const transport: CrawlerHttpTransport = {
        get: () =>
          Promise.reject(Object.assign(new Error('controlled fixture'), { code: errorCode })),
      };
      const fetcher = new SafeCrawlerFetch(resolver, transport);

      await expect(
        fetcher.fetch({
          url: 'https://docs.example.test/',
          allowedHostname: 'docs.example.test',
          maxBytes: 10,
          timeoutMs: 5,
        }),
      ).resolves.toEqual({ outcome: 'FETCH_FAILED', errorCode });
    },
  );

  test('applies one timeout budget while DNS resolution is still pending', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = new SafeCrawlerFetch(
        { resolve: () => new Promise(() => undefined) },
        { get: () => Promise.reject(new Error('transport must not be called')) },
      );
      const pending = fetcher.fetch({
        url: 'https://docs.example.test/',
        allowedHostname: 'docs.example.test',
        maxBytes: 1_000_000,
        timeoutMs: 50,
      });
      const guarded = Promise.race([
        pending,
        new Promise<'TEST_DEADLINE_MISSED'>((resolve) =>
          setTimeout(() => resolve('TEST_DEADLINE_MISSED'), 51),
        ),
      ]);

      await vi.advanceTimersByTimeAsync(51);
      await expect(guarded).resolves.toEqual({
        outcome: 'FETCH_FAILED',
        errorCode: 'FETCH_TIMEOUT',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('re-resolves the verified host after a redirect and blocks DNS rebinding', async () => {
    let resolution = 0;
    const resolver: CrawlerDnsResolver = {
      resolve: () => Promise.resolve([resolution++ === 0 ? '93.184.216.34' : '169.254.169.254']),
    };
    const transport: CrawlerHttpTransport = {
      get: (input) =>
        Promise.resolve({
          status: 302,
          contentType: 'text/html',
          body: new Uint8Array(),
          location: '/second-hop',
          connectedAddress: input.address,
        }),
    };
    const fetcher = new SafeCrawlerFetch(resolver, transport);

    await expect(
      fetcher.fetch({
        url: 'https://docs.example.test/first-hop',
        allowedHostname: 'docs.example.test',
        maxBytes: 1_000_000,
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({ outcome: 'SSRF_BLOCKED', errorCode: 'NON_PUBLIC_ADDRESS' });
  });

  test('blocks a connection that does not use one of the approved DNS addresses', async () => {
    const resolver: CrawlerDnsResolver = {
      resolve: () => Promise.resolve(['93.184.216.34']),
    };
    const transport: CrawlerHttpTransport = {
      get: () =>
        Promise.resolve({
          status: 200,
          contentType: 'text/html',
          body: new Uint8Array(),
          location: null,
          connectedAddress: '93.184.216.35',
        }),
    };
    const fetcher = new SafeCrawlerFetch(resolver, transport);

    await expect(
      fetcher.fetch({
        url: 'https://docs.example.test/',
        allowedHostname: 'docs.example.test',
        maxBytes: 1_000_000,
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({
      outcome: 'SSRF_BLOCKED',
      errorCode: 'CONNECTION_ADDRESS_MISMATCH',
    });
  });
});
