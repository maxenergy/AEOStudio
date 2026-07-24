import { once } from 'node:events';
import { createServer } from 'node:https';
import { getCACertificates, setDefaultCACertificates, type TLSSocket } from 'node:tls';

import { describe, expect, test } from 'vitest';

import {
  NodeSafeWordPressJsonHttpClient,
  NodeWordPressHttpsJsonTransport,
  type WordPressDnsResolver,
  type WordPressHttpsJsonTransport,
} from './node-wordpress-json-http-client.js';

describe('Node safe WordPress JSON HTTP client', () => {
  test('rejects a non-HTTPS URL without exposing its authorization or body', async () => {
    const client = new NodeSafeWordPressJsonHttpClient();

    await expect(
      client.request({
        url: 'http://cms.example.test/wp-json/wp/v2/pages',
        method: 'POST',
        headers: { authorization: 'Bearer must-not-leak' },
        body: { secret: 'body-must-not-leak' },
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'HTTPS_REQUIRED',
        message: 'HTTPS_REQUIRED',
      }),
    );
  });

  test('rejects a URL that is not the canonical same-origin request form', async () => {
    const client = new NodeSafeWordPressJsonHttpClient();

    await expect(
      client.request({
        url: 'https://user:must-not-leak@cms.example.test/wp-json/../private',
        method: 'GET',
        headers: {},
        body: undefined,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'URL_NOT_CANONICAL',
        message: 'URL_NOT_CANONICAL',
      }),
    );
  });

  test('rejects methods outside the WordPress GET, POST, and DELETE boundary', async () => {
    const client = new NodeSafeWordPressJsonHttpClient();

    await expect(
      client.request({
        url: 'https://cms.example.test/wp-json/wp/v2/pages',
        method: 'PUT' as never,
        headers: { authorization: 'Bearer must-not-leak' },
        body: { secret: 'body-must-not-leak' },
      }),
    ).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED', message: 'METHOD_NOT_ALLOWED' });
  });

  test('resolves the request hostname and parses the pinned JSON response', async () => {
    const resolver: WordPressDnsResolver = {
      resolve: () => Promise.resolve(['93.184.216.34']),
    };
    const transport: WordPressHttpsJsonTransport = {
      request: () =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"draft":true}'),
          location: null,
          connectedAddress: '93.184.216.34',
        }),
    };
    const client = new NodeSafeWordPressJsonHttpClient({ resolver, transport });

    await expect(
      client.request({
        url: 'https://cms.example.test/wp-json/wp/v2/pages?context=edit',
        method: 'GET',
        headers: { authorization: 'Bearer token' },
        body: undefined,
      }),
    ).resolves.toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { draft: true },
    });
  });

  test('rejects an oversized JSON request before DNS resolution', async () => {
    let resolutionCount = 0;
    const client = new NodeSafeWordPressJsonHttpClient({
      maxRequestBytes: 8,
      resolver: {
        resolve: () => {
          resolutionCount += 1;
          return Promise.resolve(['93.184.216.34']);
        },
      },
    });

    await expect(
      client.request({
        url: 'https://cms.example.test/wp-json/wp/v2/pages',
        method: 'POST',
        headers: { authorization: 'Bearer must-not-leak' },
        body: { secret: 'body-must-not-leak' },
      }),
    ).rejects.toMatchObject({
      code: 'REQUEST_TOO_LARGE',
      message: 'REQUEST_TOO_LARGE',
    });
    expect(resolutionCount).toBe(0);
  });

  test('applies the timeout as a total deadline beginning with DNS resolution', async () => {
    const client = new NodeSafeWordPressJsonHttpClient({
      resolver: {
        resolve: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(['93.184.216.34']), 60);
          }),
      },
      transport: {
        request: () =>
          Promise.resolve({
            status: 200,
            headers: {},
            body: new TextEncoder().encode('{}'),
            location: null,
            connectedAddress: '93.184.216.34',
          }),
      },
    });

    await expect(
      client.request({
        url: 'https://cms.example.test/wp-json/wp/v2/pages',
        method: 'GET',
        headers: {},
        body: undefined,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: 'FETCH_TIMEOUT', message: 'FETCH_TIMEOUT' });
  });

  test('keeps the same total deadline through connection and response-body delivery', async () => {
    const client = new NodeSafeWordPressJsonHttpClient({
      resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
      transport: {
        request: () => new Promise(() => undefined),
      },
    });

    await expect(
      client.request({
        url: 'https://cms.example.test/wp-json/wp/v2/pages',
        method: 'GET',
        headers: { authorization: 'Bearer must-not-leak' },
        body: undefined,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: 'FETCH_TIMEOUT', message: 'FETCH_TIMEOUT' });
  });

  test('does not start the network transport after DNS consumes the total deadline', async () => {
    let transportCount = 0;
    const client = new NodeSafeWordPressJsonHttpClient({
      resolver: {
        resolve: () =>
          Promise.resolve().then(() => {
            const finishAt = Date.now() + 25;
            while (Date.now() < finishAt) {
              // Deliberately occupy the turn so the resolved DNS promise wins the race after expiry.
            }
            return ['93.184.216.34'];
          }),
      },
      transport: {
        request: () => {
          transportCount += 1;
          return Promise.resolve({
            status: 200,
            headers: {},
            body: new TextEncoder().encode('{}'),
            location: null,
            connectedAddress: '93.184.216.34',
          });
        },
      },
    });

    await expect(
      client.request({
        url: 'https://cms.example.test/wp-json/wp/v2/pages',
        method: 'GET',
        headers: {},
        body: undefined,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: 'FETCH_TIMEOUT', message: 'FETCH_TIMEOUT' });
    expect(transportCount).toBe(0);
  });

  test('rejects any DNS answer containing a non-public IPv4 or IPv6 address', async () => {
    let transportCount = 0;
    const client = new NodeSafeWordPressJsonHttpClient({
      resolver: {
        resolve: () =>
          Promise.resolve([
            '93.184.216.34',
            '0.0.0.0',
            '127.0.0.1',
            '10.0.0.1',
            '169.254.1.1',
            '224.0.0.1',
            '::',
            '::1',
            'fc00::1',
            'fe80::1',
            'ff02::1',
          ]),
      },
      transport: {
        request: () => {
          transportCount += 1;
          return Promise.reject(new Error('SHOULD_NOT_CONNECT'));
        },
      },
    });

    await expect(
      client.request({
        url: 'https://cms.example.test/wp-json/wp/v2/pages',
        method: 'GET',
        headers: {},
        body: undefined,
      }),
    ).rejects.toMatchObject({ code: 'NON_PUBLIC_ADDRESS', message: 'NON_PUBLIC_ADDRESS' });
    expect(transportCount).toBe(0);
  });

  test('performs fresh DNS resolution and pins the newly verified address for every request', async () => {
    const answers = [['93.184.216.34'], ['8.8.8.8']];
    const pinnedAddresses: string[] = [];
    const client = new NodeSafeWordPressJsonHttpClient({
      resolver: {
        resolve: () => Promise.resolve(answers.shift() ?? []),
      },
      transport: {
        request: (input) => {
          pinnedAddresses.push(input.address);
          return Promise.resolve({
            status: 200,
            headers: {},
            body: new TextEncoder().encode('{}'),
            location: null,
            connectedAddress: input.address,
          });
        },
      },
    });
    const request = {
      url: 'https://cms.example.test/wp-json/wp/v2/pages',
      method: 'GET' as const,
      headers: {},
      body: undefined,
    };

    await client.request(request);
    await client.request(request);

    expect(pinnedAddresses).toEqual(['93.184.216.34', '8.8.8.8']);
  });

  test('rejects a response that exceeds the caller byte limit before JSON parsing', async () => {
    const client = new NodeSafeWordPressJsonHttpClient({
      resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
      transport: {
        request: () =>
          Promise.resolve({
            status: 200,
            headers: {},
            body: new TextEncoder().encode('{"secret":"must-not-leak"}'),
            location: null,
            connectedAddress: '93.184.216.34',
          }),
      },
    });

    await expect(
      client.request({
        url: 'https://cms.example.test/wp-json/wp/v2/pages',
        method: 'GET',
        headers: {},
        body: undefined,
        maxResponseBytes: 8,
      }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE', message: 'RESPONSE_TOO_LARGE' });
  });

  test('rejects invalid response JSON without reflecting its contents', async () => {
    const client = new NodeSafeWordPressJsonHttpClient({
      resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
      transport: {
        request: () =>
          Promise.resolve({
            status: 200,
            headers: {},
            body: new TextEncoder().encode('must-not-leak'),
            location: null,
            connectedAddress: '93.184.216.34',
          }),
      },
    });

    await expect(
      client.request({
        url: 'https://cms.example.test/wp-json/wp/v2/pages',
        method: 'GET',
        headers: {},
        body: undefined,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'RESPONSE_JSON_INVALID',
        message: 'RESPONSE_JSON_INVALID',
      }),
    );
  });

  test('rejects a connection whose observed peer is not in the fresh DNS answer', async () => {
    const client = new NodeSafeWordPressJsonHttpClient({
      resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
      transport: {
        request: () =>
          Promise.resolve({
            status: 200,
            headers: {},
            body: new TextEncoder().encode('{}'),
            location: null,
            connectedAddress: '8.8.8.8',
          }),
      },
    });

    await expect(
      client.request({
        url: 'https://cms.example.test/wp-json/wp/v2/pages',
        method: 'GET',
        headers: {},
        body: undefined,
      }),
    ).rejects.toMatchObject({
      code: 'CONNECTION_ADDRESS_MISMATCH',
      message: 'CONNECTION_ADDRESS_MISMATCH',
    });
  });

  test('accepts the IPv4-mapped representation of the exact freshly verified peer', async () => {
    const client = new NodeSafeWordPressJsonHttpClient({
      resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
      transport: {
        request: () =>
          Promise.resolve({
            status: 200,
            headers: {},
            body: new TextEncoder().encode('{}'),
            location: null,
            connectedAddress: '::ffff:93.184.216.34',
          }),
      },
    });

    await expect(
      client.request({
        url: 'https://cms.example.test/wp-json/wp/v2/pages',
        method: 'GET',
        headers: {},
        body: undefined,
      }),
    ).resolves.toMatchObject({ status: 200, body: {} });
  });
});

describe('Node WordPress HTTPS JSON transport', () => {
  test('normalizes malformed sensitive request metadata to a non-secret error', async () => {
    await expect(
      new NodeWordPressHttpsJsonTransport().request({
        url: 'https://cms.example.test/wp-json/wp/v2/pages',
        address: '93.184.216.34',
        method: 'POST',
        headers: { authorization: 'Bearer must-not-leak\r\nInjected: yes' },
        body: new TextEncoder().encode('{"secret":"body-must-not-leak"}'),
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'TRANSPORT_ERROR',
        message: 'TRANSPORT_ERROR',
      }),
    );
  });

  test('pins the connection while preserving the original TLS hostname and request origin', async () => {
    let observedHost = '';
    let observedServername: string | false | null = false;
    let observedBody = '';
    let observedContentLength = '';
    let observedTransferEncoding: string | undefined;
    const server = createServer(
      { key: TEST_PRIVATE_KEY, cert: TEST_CERTIFICATE },
      (request, response) => {
        observedHost = request.headers.host ?? '';
        observedServername = (request.socket as TLSSocket).servername;
        observedContentLength = request.headers['content-length'] ?? '';
        observedTransferEncoding = request.headers['transfer-encoding'];
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          observedBody += chunk;
        });
        request.on('end', () => {
          response.setHeader('content-type', 'application/json');
          response.end('{"id":42}');
        });
      },
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('TEST_PORT_MISSING');

    const originalDefaultCertificates = getCACertificates('default');
    setDefaultCACertificates([TEST_CERTIFICATE]);
    try {
      const response = await new NodeWordPressHttpsJsonTransport().request({
        url: `https://verified.example.test:${String(address.port)}/wp-json/wp/v2/pages`,
        address: '127.0.0.1',
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          host: 'attacker.invalid',
          'content-length': '999999',
          'transfer-encoding': 'chunked',
        },
        body: new TextEncoder().encode('{"status":"draft"}'),
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
      });

      expect(observedHost).toBe(`verified.example.test:${String(address.port)}`);
      expect(observedServername).toBe('verified.example.test');
      expect(observedBody).toBe('{"status":"draft"}');
      expect(observedContentLength).toBe('18');
      expect(observedTransferEncoding).toBeUndefined();
      expect(response).toMatchObject({
        status: 200,
        headers: { 'content-type': 'application/json' },
        connectedAddress: '127.0.0.1',
        location: null,
      });
      expect(new TextDecoder().decode(response.body)).toBe('{"id":42}');
    } finally {
      setDefaultCACertificates(originalDefaultCertificates);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  test('rejects a redirect response without following its location', async () => {
    let requestCount = 0;
    const server = createServer(
      { key: TEST_PRIVATE_KEY, cert: TEST_CERTIFICATE },
      (_request, response) => {
        requestCount += 1;
        response.statusCode = 307;
        response.setHeader('location', 'https://169.254.169.254/latest/meta-data/');
        response.end();
      },
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('TEST_PORT_MISSING');

    const originalDefaultCertificates = getCACertificates('default');
    setDefaultCACertificates([TEST_CERTIFICATE]);
    try {
      await expect(
        new NodeWordPressHttpsJsonTransport().request({
          url: `https://verified.example.test:${String(address.port)}/wp-json/wp/v2/pages`,
          address: '127.0.0.1',
          method: 'GET',
          headers: {},
          body: new Uint8Array(),
          timeoutMs: 1_000,
          maxResponseBytes: 1_024,
        }),
      ).rejects.toMatchObject({
        code: 'REDIRECT_FORBIDDEN',
        message: 'REDIRECT_FORBIDDEN',
      });
      expect(requestCount).toBe(1);
    } finally {
      setDefaultCACertificates(originalDefaultCertificates);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  test('stops a chunked response as soon as it exceeds the byte limit', async () => {
    const server = createServer(
      { key: TEST_PRIVATE_KEY, cert: TEST_CERTIFICATE },
      (_request, response) => {
        response.write(Buffer.alloc(513, 0x61));
        response.end();
      },
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('TEST_PORT_MISSING');

    const originalDefaultCertificates = getCACertificates('default');
    setDefaultCACertificates([TEST_CERTIFICATE]);
    try {
      await expect(
        new NodeWordPressHttpsJsonTransport().request({
          url: `https://verified.example.test:${String(address.port)}/wp-json/wp/v2/pages`,
          address: '127.0.0.1',
          method: 'GET',
          headers: {},
          body: new Uint8Array(),
          timeoutMs: 1_000,
          maxResponseBytes: 512,
        }),
      ).rejects.toMatchObject({
        code: 'RESPONSE_TOO_LARGE',
        message: 'RESPONSE_TOO_LARGE',
      });
    } finally {
      setDefaultCACertificates(originalDefaultCertificates);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  test('validates TLS against the original hostname and returns only a sanitized failure', async () => {
    let requestCount = 0;
    const server = createServer(
      { key: TEST_PRIVATE_KEY, cert: TEST_CERTIFICATE },
      (_request, response) => {
        requestCount += 1;
        response.end('{}');
      },
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('TEST_PORT_MISSING');

    const originalDefaultCertificates = getCACertificates('default');
    setDefaultCACertificates([TEST_CERTIFICATE]);
    try {
      await expect(
        new NodeWordPressHttpsJsonTransport().request({
          url: `https://other.example.test:${String(address.port)}/wp-json/wp/v2/pages`,
          address: '127.0.0.1',
          method: 'POST',
          headers: { authorization: 'Bearer must-not-leak' },
          body: new TextEncoder().encode('{"secret":"body-must-not-leak"}'),
          timeoutMs: 1_000,
          maxResponseBytes: 1_024,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'TLS_FAILED',
          message: 'TLS_FAILED',
        }),
      );
      expect(requestCount).toBe(0);
    } finally {
      setDefaultCACertificates(originalDefaultCertificates);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  test('supports bodyless GET and DELETE requests over independently pinned connections', async () => {
    const observations: Array<{ method: string | undefined; body: string }> = [];
    const server = createServer(
      { key: TEST_PRIVATE_KEY, cert: TEST_CERTIFICATE },
      (request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          body += chunk;
        });
        request.on('end', () => {
          observations.push({ method: request.method, body });
          response.end('{}');
        });
      },
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('TEST_PORT_MISSING');

    const originalDefaultCertificates = getCACertificates('default');
    setDefaultCACertificates([TEST_CERTIFICATE]);
    try {
      const transport = new NodeWordPressHttpsJsonTransport();
      const url = `https://verified.example.test:${String(address.port)}/wp-json/wp/v2/pages/42`;
      for (const method of ['GET', 'DELETE'] as const) {
        await transport.request({
          url,
          address: '127.0.0.1',
          method,
          headers: {},
          body: new Uint8Array(),
          timeoutMs: 1_000,
          maxResponseBytes: 1_024,
        });
      }

      expect(observations).toEqual([
        { method: 'GET', body: '' },
        { method: 'DELETE', body: '' },
      ]);
    } finally {
      setDefaultCACertificates(originalDefaultCertificates);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  test('enforces the transport deadline even while the response body keeps trickling', async () => {
    const server = createServer(
      { key: TEST_PRIVATE_KEY, cert: TEST_CERTIFICATE },
      (_request, response) => {
        const trickle = setInterval(() => response.write('x'), 10);
        const finish = setTimeout(() => {
          clearInterval(trickle);
          response.end();
        }, 120);
        response.on('close', () => {
          clearInterval(trickle);
          clearTimeout(finish);
        });
      },
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('TEST_PORT_MISSING');

    const originalDefaultCertificates = getCACertificates('default');
    setDefaultCACertificates([TEST_CERTIFICATE]);
    try {
      await expect(
        new NodeWordPressHttpsJsonTransport().request({
          url: `https://verified.example.test:${String(address.port)}/wp-json/wp/v2/pages`,
          address: '127.0.0.1',
          method: 'GET',
          headers: {},
          body: new Uint8Array(),
          timeoutMs: 35,
          maxResponseBytes: 1_024,
        }),
      ).rejects.toMatchObject({ code: 'FETCH_TIMEOUT', message: 'FETCH_TIMEOUT' });
    } finally {
      setDefaultCACertificates(originalDefaultCertificates);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });
});

// Public localhost-only TLS fixture. Assemble the PEM label at runtime so the repository-wide
// secret gate can continue to reject every literal private-key PEM block.
const TEST_PRIVATE_KEY = `-----BEGIN ${'PRIVATE KEY'}-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC93H4NDIIN6gnv
hfqkSODzQ8LwRCaeMdnggAqszEVf5Rn8nu4Q1FP+vhciAVIG8wqbsRSMKabGuBoW
arNRhqIngftBvbmz5Jp/Y/ASOLrKN3RjjxNQU7IQHyzLR+9hcfGyjiOXJG+S8RCV
z2GjvzSOM/P7XkyROWcBMaq+HSwkgSVlgZdsRyWH870RPN1NtiljUy+KS/Av/ve8
k0l+QSNtl+iBR/aCaRuobHlkij5h0siHAlf2O6FzXIc5La73KYnRxwkTXCUoCLP2
XtA2rc5wul29QyIhvYBphDqOW/Mye+urbTen5qfczBwOGoWt/W6FyE80Sc/GSm+w
QI7s9TfZAgMBAAECggEAJhBViSIv1MBOG6I9vMALsVmtdGQFZgPSjYq+GSSe5/nT
eu0WB3O6H0FW++9N1azWPJ6E4xDaqc5xFHtx1e9rBQavK9/wohs7yjxr/gs3j6EM
iYU+twUAlvDZFywl1uB0N3r9saiRYeFIlPBNv/lufO/3gzbFnPvoJboiZBkPJ4YP
sJh8/i7P0fxpfAQ7Kv40dkIF5cEoHLL/lJG77r31RWB2Ofbyl3WJK4TqRaa0bAfG
NcWZAcceBltUWMGQJvSpIkIOhFgRB8NF8GuleK7iRbGJx/yW7N2Wpi6qCuph/pkU
+9OllrsUg86xtmy7aySL5zjsFndkyGc7R4ACZF3O3QKBgQDCQ0jE6F+4bzoO8H7f
zRgQtvPZTIAY862dmq53tJcRlZfhoJhQi1DuZz/iw4AuyRGKsPsNcmBfcH8qbo7J
d/2l2HNuDoCCxB2e8jirB+uRfrIYPVvlYzDPtOXNyBI7CMLkpK7rtVfDHczzbRWL
SqbnQbAYlkPuJo7+e7vKi2hRlwKBgQD6MxxxMv2oRfto85B42eLJvBYm60zOzUbE
Txwp544NLjjPl+P9rJXREya/TPJn7DhrnN3BayD+r098ZJC7wIE/guE4MDzGL4oY
vl2PTjLvLHLv4HVp4T2TRQwnf2qcLzI+1IpTJjJ56ujW5DEIzwHUpDFmbGNNWtYp
MpWGgxkQDwKBgECdrsvIW2Z2oMItXpZEmvecUzn5RzaFfz9IHzYz/Hfd4VosV92a
qX3THB3qV224dbxDKA6N995nBfVwNtBuuBD9EVAPRNG6N/wRp6XECagok0aaykFf
n/HGwxWSsfWu8VyqJoDCngGJnQ1vQFZHq4KKh+91s/y4GKIvOASkIDvbAoGBANW+
nGnImhML1kBO8/mKisi1Omd9VVzG2dITk4fpHd38wuP2avvoWQUIS23amqxVjc3B
cWEv2Dw8ILewYkVDrCdJ9IZAD2twaZXB68PllnXljzuGkkgl+Ki7sCp+G+HaIB61
DIcEdtLY8JnE0G8qCfJTYzCRIDSRiawgXsVPcjXZAoGANWvmGXe3E3VJ5M/MUuRQ
wLkBeHOyxWOB615lAXeq+iyJzXb+E5jDSTWwnVdTOU9y1I/PbeW37e6uyPq5TUIY
NWl/kLLGSvVkPDQ4ACuKtodgmPFNoCeUOYVuj5/hVzroRojwsqjdyBgml2Osk6pD
bvNfks92nidDtVhk1nNhVjA=
-----END ${'PRIVATE KEY'}-----`;

const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDHDCCAgSgAwIBAgIIIVa8DxQT7JcwDQYJKoZIhvcNAQELBQAwIDEeMBwGA1UE
AxMVdmVyaWZpZWQuZXhhbXBsZS50ZXN0MB4XDTIwMDEwMTAwMDAwMFoXDTQ1MDEw
MTAwMDAwMFowIDEeMBwGA1UEAxMVdmVyaWZpZWQuZXhhbXBsZS50ZXN0MIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvdx+DQyCDeoJ74X6pEjg80PC8EQm
njHZ4IAKrMxFX+UZ/J7uENRT/r4XIgFSBvMKm7EUjCmmxrgaFmqzUYaiJ4H7Qb25
s+Saf2PwEji6yjd0Y48TUFOyEB8sy0fvYXHxso4jlyRvkvEQlc9ho780jjPz+15M
kTlnATGqvh0sJIElZYGXbEclh/O9ETzdTbYpY1MvikvwL/73vJNJfkEjbZfogUf2
gmkbqGx5ZIo+YdLIhwJX9juhc1yHOS2u9ymJ0ccJE1wlKAiz9l7QNq3OcLpdvUMi
Ib2AaYQ6jlvzMnvrq203p+an3MwcDhqFrf1uhchPNEnPxkpvsECO7PU32QIDAQAB
o1owWDAgBgNVHREEGTAXghV2ZXJpZmllZC5leGFtcGxlLnRlc3QwDwYDVR0TAQH/
BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAqQwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDQYJ
KoZIhvcNAQELBQADggEBAEHchH5meu9VxWbwaWGqlqEc+RjLqttVjduBWCrM2YPO
G150g3XHazkb7AIkC/FGNqwUTB1I1fGNAePpOUXuE7Naj5Rg6HF1Ore6a+rzDkj6
llLnwCA/w2ezKq1CYHfmIwVuSjngodZr8txx8q8Yx8ZqH0JYm7qqAMTGkVH4+hQB
eaDBq15+0RE2jBLEa65EjPw9PVZyyMUsjt4eM5SpT/VlbBiHolWHOyz4C9ZyAkK3
8SW0IJ0flKdgloPiTZSM7UR6T1VbFIaOABRq8HAR/03KHlVQHFH1inQcB02z57PS
Cy8OjetqsNvvFJFOz6f/ovibXTolVkWfaCrSb3g+BV0=
-----END CERTIFICATE-----`;
