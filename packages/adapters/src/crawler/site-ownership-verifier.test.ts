import type { SiteRecord } from '@aeostudio/domain/site-crawl';
import { describe, expect, test, vi } from 'vitest';

import { SafeSiteOwnershipVerifier } from './site-ownership-verifier.js';

const site = {
  id: '50000000-0000-4000-8000-000000000001',
  tenantId: '50000000-0000-4000-8000-000000000002',
  workspaceId: '50000000-0000-4000-8000-000000000003',
  profileId: '50000000-0000-4000-8000-000000000004',
  origin: 'https://owned.example.test',
  hostname: 'owned.example.test',
  status: 'UNVERIFIED',
  verifiedAt: null,
} satisfies SiteRecord;

describe('SafeSiteOwnershipVerifier', () => {
  test('matches one exact DNS TXT record after joining its chunks', async () => {
    const queries: string[] = [];
    const verifier = new SafeSiteOwnershipVerifier(
      {
        resolveTxt(hostname) {
          queries.push(hostname);
          return Promise.resolve([['50000000-0000-', '4000-8000-000000000005']]);
        },
      },
      { fetch: () => Promise.reject(new Error('FILE_FETCH_NOT_EXPECTED')) },
    );

    await expect(
      verifier.verify({
        site,
        method: 'DNS',
        expectedToken: '50000000-0000-4000-8000-000000000005',
        challengePath: '_aeostudio-verification',
      }),
    ).resolves.toEqual({ matched: true });
    expect(queries).toEqual(['_aeostudio-verification.owned.example.test']);
  });

  test('fails closed when the DNS TXT lookup is unavailable', async () => {
    const verifier = new SafeSiteOwnershipVerifier(
      { resolveTxt: () => Promise.reject(new Error('ENOTFOUND')) },
      { fetch: () => Promise.reject(new Error('FILE_FETCH_NOT_EXPECTED')) },
    );

    await expect(
      verifier.verify({
        site,
        method: 'DNS',
        expectedToken: '50000000-0000-4000-8000-000000000005',
        challengePath: '_aeostudio-verification',
      }),
    ).resolves.toEqual({ matched: false });
  });

  test('fails closed after five seconds when the DNS TXT lookup never settles', async () => {
    vi.useFakeTimers();
    try {
      const verifier = new SafeSiteOwnershipVerifier(
        { resolveTxt: () => new Promise(() => undefined) },
        { fetch: () => Promise.reject(new Error('FILE_FETCH_NOT_EXPECTED')) },
      );
      let result: { matched: boolean } | undefined;
      void verifier
        .verify({
          site,
          method: 'DNS',
          expectedToken: '50000000-0000-4000-8000-000000000005',
          challengePath: '_aeostudio-verification',
        })
        .then((value) => {
          result = value;
        });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(result).toEqual({ matched: false });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('verifies an exact FILE token through the scoped crawl fetch boundary', async () => {
    const requests: Parameters<
      ConstructorParameters<typeof SafeSiteOwnershipVerifier>[1]['fetch']
    >[0][] = [];
    const expectedToken = '50000000-0000-4000-8000-000000000005';
    const verifier = new SafeSiteOwnershipVerifier(
      { resolveTxt: () => Promise.reject(new Error('DNS_LOOKUP_NOT_EXPECTED')) },
      {
        fetch(input) {
          requests.push(input);
          return Promise.resolve({
            outcome: 'SUCCEEDED',
            finalUrl: input.url,
            response: {
              status: 200,
              contentType: 'text/plain; charset=utf-8',
              body: new TextEncoder().encode(expectedToken),
            },
          });
        },
      },
    );

    await expect(
      verifier.verify({
        site,
        method: 'FILE',
        expectedToken,
        challengePath: '/.well-known/aeostudio-verification',
      }),
    ).resolves.toEqual({ matched: true });
    expect(requests).toEqual([
      {
        url: 'https://owned.example.test/.well-known/aeostudio-verification',
        allowedHostname: 'owned.example.test',
        maxBytes: 4_096,
        timeoutMs: 5_000,
      },
    ]);
  });

  test('fails closed when the FILE fetch boundary cannot resolve the host', async () => {
    const verifier = new SafeSiteOwnershipVerifier(
      { resolveTxt: () => Promise.reject(new Error('DNS_LOOKUP_NOT_EXPECTED')) },
      { fetch: () => Promise.reject(new Error('ENOTFOUND')) },
    );

    await expect(
      verifier.verify({
        site,
        method: 'FILE',
        expectedToken: '50000000-0000-4000-8000-000000000005',
        challengePath: '/.well-known/aeostudio-verification',
      }),
    ).resolves.toEqual({ matched: false });
  });

  test('rejects ownership evidence when the persisted origin and hostname disagree', async () => {
    const queries: string[] = [];
    const verifier = new SafeSiteOwnershipVerifier(
      {
        resolveTxt(hostname) {
          queries.push(hostname);
          return Promise.resolve([['50000000-0000-4000-8000-000000000005']]);
        },
      },
      { fetch: () => Promise.reject(new Error('FILE_FETCH_NOT_EXPECTED')) },
    );

    await expect(
      verifier.verify({
        site: { ...site, hostname: 'different.example.test' },
        method: 'DNS',
        expectedToken: '50000000-0000-4000-8000-000000000005',
        challengePath: '_aeostudio-verification',
      }),
    ).resolves.toEqual({ matched: false });
    expect(queries).toEqual([]);
  });

  test.each(['OAUTH', 'ADMIN'] as const)(
    '%s remains fail-closed without an approved provider',
    async (method) => {
      const verifier = new SafeSiteOwnershipVerifier(
        { resolveTxt: () => Promise.reject(new Error('DNS_LOOKUP_NOT_EXPECTED')) },
        { fetch: () => Promise.reject(new Error('FILE_FETCH_NOT_EXPECTED')) },
      );

      await expect(
        verifier.verify({ site, method, expectedToken: 'unused', challengePath: null }),
      ).resolves.toEqual({ matched: false });
    },
  );
});
