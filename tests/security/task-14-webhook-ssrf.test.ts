import * as AdapterRuntime from '@aeostudio/adapters';
import { describe, expect, test } from 'vitest';

interface DnsResolver {
  resolve(hostname: string): Promise<string[]>;
}

interface HttpTransport {
  post(input: {
    url: string;
    address: string;
    headers: Record<string, string>;
    body: Uint8Array;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: Uint8Array;
    location: string | null;
    connectedAddress: string;
  }>;
}

interface SafeClient {
  post(input: {
    url: string;
    verifiedUrl: string;
    headers: Record<string, string>;
    body: Uint8Array;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<
    | { outcome: 'SUCCEEDED'; response: Awaited<ReturnType<HttpTransport['post']>> }
    | { outcome: 'SSRF_BLOCKED' | 'TRANSPORT_FAILED'; errorCode: string }
  >;
}

type SafeClientConstructor = new (resolver: DnsResolver, transport: HttpTransport) => SafeClient;
const Constructor = (
  AdapterRuntime as unknown as { SafeSignedWebhookHttpClient?: SafeClientConstructor }
).SafeSignedWebhookHttpClient;

describe('Task 14 signed webhook SSRF boundary', () => {
  test('exports the fail-closed signed webhook transport', () => {
    expect(Constructor, 'expected SSRF_BLOCKED, safe webhook client unavailable').toBeTypeOf(
      'function',
    );
  });

  test.skipIf(Constructor === undefined).each([
    ['not-a-url', 'not-a-url', 'INVALID_URL'],
    ['http://receiver.example.test/hook', 'http://receiver.example.test/hook', 'HTTPS_REQUIRED'],
    [
      'https://user:password@receiver.example.test/hook',
      'https://user:password@receiver.example.test/hook',
      'URL_CREDENTIALS_FORBIDDEN',
    ],
    [
      'https://receiver.example.test/hook?token=secret',
      'https://receiver.example.test/hook?token=secret',
      'URL_QUERY_FORBIDDEN',
    ],
    [
      'https://other.example.test/hook',
      'https://receiver.example.test/hook',
      'ENDPOINT_NOT_VERIFIED',
    ],
  ])('blocks URL %s before transport', async (url, verifiedUrl, errorCode) => {
    const transport = rejectingTransport();
    const client = new Constructor!(publicResolver(), transport);
    await expect(post(client, url, verifiedUrl)).resolves.toEqual({
      outcome: 'SSRF_BLOCKED',
      errorCode,
    });
  });

  test
    .skipIf(Constructor === undefined)
    .each([
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
      '2001:2::1',
      '2001:10::1',
      '2001:20::1',
      '2002::1',
      '2620:4f:8000::1',
      '3fff::1',
    ])('blocks non-public DNS address %s before sending a signature', async (address) => {
    const transport = rejectingTransport();
    const client = new Constructor!({ resolve: () => Promise.resolve([address]) }, transport);
    await expect(
      post(client, 'https://receiver.example.test/hook', 'https://receiver.example.test/hook'),
    ).resolves.toEqual({ outcome: 'SSRF_BLOCKED', errorCode: 'NON_PUBLIC_ADDRESS' });
  });

  test.skipIf(Constructor === undefined)(
    'blocks redirects without forwarding the signed request to a second location',
    async () => {
      let calls = 0;
      const transport: HttpTransport = {
        post: (input) => {
          calls += 1;
          return Promise.resolve({
            status: 307,
            headers: {},
            body: new Uint8Array(),
            location: 'http://169.254.169.254/latest/meta-data/',
            connectedAddress: input.address,
          });
        },
      };
      const client = new Constructor!(publicResolver(), transport);
      await expect(
        post(client, 'https://receiver.example.test/hook', 'https://receiver.example.test/hook'),
      ).resolves.toEqual({ outcome: 'SSRF_BLOCKED', errorCode: 'REDIRECT_FORBIDDEN' });
      expect(calls).toBe(1);
    },
  );

  test.skipIf(Constructor === undefined)(
    'blocks DNS rebinding/connected-address mismatch and accepts a pinned public connection',
    async () => {
      const mismatch: HttpTransport = {
        post: () =>
          Promise.resolve({
            status: 200,
            headers: {},
            body: new Uint8Array(),
            location: null,
            connectedAddress: '127.0.0.1',
          }),
      };
      const blocked = new Constructor!(publicResolver(), mismatch);
      await expect(
        post(blocked, 'https://receiver.example.test/hook', 'https://receiver.example.test/hook'),
      ).resolves.toEqual({
        outcome: 'SSRF_BLOCKED',
        errorCode: 'CONNECTION_ADDRESS_MISMATCH',
      });

      const pinned: HttpTransport = {
        post: (input) =>
          Promise.resolve({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode('{}'),
            location: null,
            connectedAddress: input.address,
          }),
      };
      const allowed = new Constructor!(publicResolver(), pinned);
      await expect(
        post(allowed, 'https://receiver.example.test/hook', 'https://receiver.example.test/hook'),
      ).resolves.toMatchObject({ outcome: 'SUCCEEDED', response: { status: 200 } });
    },
  );

  test.skipIf(Constructor === undefined)(
    'enforces one total deadline across DNS resolution and transport',
    async () => {
      const never = new Promise<never>(() => undefined);
      const dnsBlocked = new Constructor!({ resolve: () => never }, rejectingTransport());
      await expect(
        postWithTimeout(
          dnsBlocked,
          'https://receiver.example.test/hook',
          'https://receiver.example.test/hook',
          20,
        ),
      ).resolves.toEqual({ outcome: 'TRANSPORT_FAILED', errorCode: 'FETCH_TIMEOUT' });

      const transportBlocked = new Constructor!(publicResolver(), {
        post: () => never,
      });
      await expect(
        postWithTimeout(
          transportBlocked,
          'https://receiver.example.test/hook',
          'https://receiver.example.test/hook',
          20,
        ),
      ).resolves.toEqual({ outcome: 'TRANSPORT_FAILED', errorCode: 'FETCH_TIMEOUT' });
    },
  );
});

function publicResolver(): DnsResolver {
  return { resolve: () => Promise.resolve(['93.184.216.34']) };
}

function rejectingTransport(): HttpTransport {
  return { post: () => Promise.reject(new Error('transport must not be called')) };
}

function post(client: SafeClient, url: string, verifiedUrl: string) {
  return postWithTimeout(client, url, verifiedUrl, 5_000);
}

function postWithTimeout(client: SafeClient, url: string, verifiedUrl: string, timeoutMs: number) {
  return client.post({
    url,
    verifiedUrl,
    headers: { 'aeo-webhook-signature': 'must-not-leak' },
    body: new TextEncoder().encode('{}'),
    timeoutMs,
    maxResponseBytes: 256_000,
  });
}
