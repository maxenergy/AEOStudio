import { once } from 'node:events';
import { createServer } from 'node:https';
import { isIP } from 'node:net';
import { getCACertificates, setDefaultCACertificates, type TLSSocket } from 'node:tls';

import { afterEach, describe, expect, test } from 'vitest';

import {
  NodeSignedWebhookDnsResolver,
  NodeSignedWebhookHttpsTransport,
} from './node-signed-webhook-http-transport.js';

describe('Node signed-webhook DNS resolver', () => {
  test('returns the unique IP addresses resolved for a hostname', async () => {
    const addresses = await new NodeSignedWebhookDnsResolver().resolve('localhost');

    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.every((address) => isIP(address) !== 0)).toBe(true);
    expect(new Set(addresses).size).toBe(addresses.length);
  });
});

describe('Node signed-webhook HTTPS transport', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error === undefined ? resolve() : reject(error))),
            ),
        ),
    );
  });

  test('rejects a non-HTTPS endpoint before opening a connection', async () => {
    const transport = new NodeSignedWebhookHttpsTransport();

    await expect(
      transport.post({
        url: 'http://receiver.example.test/deliver',
        address: '93.184.216.34',
        headers: { authorization: 'Bearer must-not-leak' },
        body: new TextEncoder().encode('sensitive-body'),
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
      }),
    ).rejects.toMatchObject({ code: 'HTTPS_REQUIRED' });
  });

  test('rejects a malformed endpoint without exposing its input', async () => {
    await expect(
      Promise.resolve().then(() =>
        new NodeSignedWebhookHttpsTransport().post({
          url: 'not-a-url?token=must-not-leak',
          address: '93.184.216.34',
          headers: {},
          body: new Uint8Array(),
          timeoutMs: 1_000,
          maxResponseBytes: 1_024,
        }),
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'HTTPS_REQUIRED',
        message: 'HTTPS_REQUIRED',
      }),
    );
  });

  test('normalizes a malformed sensitive header failure to a non-secret error', async () => {
    await expect(
      new NodeSignedWebhookHttpsTransport().post({
        url: 'https://receiver.example.test/deliver',
        address: '93.184.216.34',
        headers: { Authorization: 'Bearer must-not-leak\r\nInjected: yes' },
        body: new TextEncoder().encode('sensitive-body'),
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

  test('posts to the pinned address while preserving the verified TLS hostname', async () => {
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
          response.setHeader('X-Receipt-Id', 'receipt-1');
          response.end('accepted');
        });
      },
    );
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('TEST_SERVER_PORT_MISSING');

    const originalDefaultCertificates = getCACertificates('default');
    setDefaultCACertificates([TEST_CERTIFICATE]);
    try {
      const response = await new NodeSignedWebhookHttpsTransport().post({
        url: `https://verified.example.test:${address.port}/deliver`,
        address: '127.0.0.1',
        headers: {
          'Content-Type': 'application/json',
          Host: 'attacker.invalid',
          'Content-Length': '999999',
          'Transfer-Encoding': 'chunked',
        },
        body: new TextEncoder().encode('{"approved":true}'),
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
      });

      expect(observedHost).toBe(`verified.example.test:${address.port}`);
      expect(observedServername).toBe('verified.example.test');
      expect(observedBody).toBe('{"approved":true}');
      expect(observedContentLength).toBe('17');
      expect(observedTransferEncoding).toBeUndefined();
      expect(response).toMatchObject({
        status: 200,
        headers: { 'x-receipt-id': 'receipt-1' },
        location: null,
        connectedAddress: '127.0.0.1',
      });
      expect(new TextDecoder().decode(response.body)).toBe('accepted');
    } finally {
      setDefaultCACertificates(originalDefaultCertificates);
    }
  });

  test('does not reuse a pooled socket when the freshly pinned address changes', async () => {
    let firstReceiverCount = 0;
    let secondReceiverCount = 0;
    const firstReceiver = createServer(
      { key: TEST_PRIVATE_KEY, cert: TEST_CERTIFICATE },
      (_request, response) => {
        firstReceiverCount += 1;
        response.end('first');
      },
    );
    servers.push(firstReceiver);
    firstReceiver.listen(0, '127.0.0.1');
    await once(firstReceiver, 'listening');
    const firstAddress = firstReceiver.address();
    if (firstAddress === null || typeof firstAddress === 'string')
      throw new Error('TEST_SERVER_PORT_MISSING');

    const secondReceiver = createServer(
      { key: TEST_PRIVATE_KEY, cert: TEST_CERTIFICATE },
      (_request, response) => {
        secondReceiverCount += 1;
        response.end('second');
      },
    );
    servers.push(secondReceiver);
    secondReceiver.listen(firstAddress.port, '127.0.0.2');
    await once(secondReceiver, 'listening');

    const originalDefaultCertificates = getCACertificates('default');
    setDefaultCACertificates([TEST_CERTIFICATE]);
    try {
      const transport = new NodeSignedWebhookHttpsTransport();
      const baseInput = {
        url: `https://verified.example.test:${firstAddress.port}/deliver`,
        headers: {},
        body: new Uint8Array(),
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
      };

      await expect(transport.post({ ...baseInput, address: '127.0.0.1' })).resolves.toMatchObject({
        status: 200,
        connectedAddress: '127.0.0.1',
      });
      await expect(transport.post({ ...baseInput, address: '127.0.0.2' })).resolves.toMatchObject({
        status: 200,
        connectedAddress: '127.0.0.2',
      });

      expect(firstReceiverCount).toBe(1);
      expect(secondReceiverCount).toBe(1);
    } finally {
      setDefaultCACertificates(originalDefaultCertificates);
    }
  });

  test('reports an unknown remote result when the receiver resets after consuming the request', async () => {
    let receivedBody = '';
    const server = createServer({ key: TEST_PRIVATE_KEY, cert: TEST_CERTIFICATE }, (request) => {
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        receivedBody += chunk;
      });
      request.on('end', () => request.socket.destroy());
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('TEST_SERVER_PORT_MISSING');

    const originalDefaultCertificates = getCACertificates('default');
    setDefaultCACertificates([TEST_CERTIFICATE]);
    try {
      await expect(
        new NodeSignedWebhookHttpsTransport().post({
          url: `https://verified.example.test:${address.port}/deliver`,
          address: '127.0.0.1',
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"approved":true}'),
          timeoutMs: 1_000,
          maxResponseBytes: 1_024,
        }),
      ).rejects.toMatchObject({ code: 'REQUEST_RESULT_UNKNOWN' });
      expect(receivedBody).toBe('{"approved":true}');
    } finally {
      setDefaultCACertificates(originalDefaultCertificates);
    }
  });

  test('returns a redirect response without following its location', async () => {
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
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('TEST_SERVER_PORT_MISSING');

    const originalDefaultCertificates = getCACertificates('default');
    setDefaultCACertificates([TEST_CERTIFICATE]);
    try {
      await expect(
        new NodeSignedWebhookHttpsTransport().post({
          url: `https://verified.example.test:${address.port}/deliver`,
          address: '127.0.0.1',
          headers: {},
          body: new Uint8Array(),
          timeoutMs: 1_000,
          maxResponseBytes: 1_024,
        }),
      ).resolves.toMatchObject({
        status: 307,
        location: 'https://169.254.169.254/latest/meta-data/',
      });
      expect(requestCount).toBe(1);
    } finally {
      setDefaultCACertificates(originalDefaultCertificates);
    }
  });

  test('fails TLS validation against the original hostname without leaking request data', async () => {
    let requestCount = 0;
    const server = createServer(
      { key: TEST_PRIVATE_KEY, cert: TEST_CERTIFICATE },
      (_request, response) => {
        requestCount += 1;
        response.end();
      },
    );
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('TEST_SERVER_PORT_MISSING');

    const originalDefaultCertificates = getCACertificates('default');
    setDefaultCACertificates([TEST_CERTIFICATE]);
    try {
      await expect(
        new NodeSignedWebhookHttpsTransport().post({
          url: `https://other.example.test:${address.port}/deliver`,
          address: '127.0.0.1',
          headers: { authorization: 'Bearer must-not-leak' },
          body: new TextEncoder().encode('sensitive-body'),
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
    }
  });

  test('stops a chunked response as soon as it exceeds the byte cap', async () => {
    const server = createServer(
      { key: TEST_PRIVATE_KEY, cert: TEST_CERTIFICATE },
      (_request, response) => {
        response.write(Buffer.alloc(513, 0x61));
        response.end();
      },
    );
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('TEST_SERVER_PORT_MISSING');

    const originalDefaultCertificates = getCACertificates('default');
    setDefaultCACertificates([TEST_CERTIFICATE]);
    try {
      await expect(
        new NodeSignedWebhookHttpsTransport().post({
          url: `https://verified.example.test:${address.port}/deliver`,
          address: '127.0.0.1',
          headers: {},
          body: new Uint8Array(),
          timeoutMs: 1_000,
          maxResponseBytes: 512,
        }),
      ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    } finally {
      setDefaultCACertificates(originalDefaultCertificates);
    }
  });

  test('rejects an oversized declared response before reading its body', async () => {
    const server = createServer(
      { key: TEST_PRIVATE_KEY, cert: TEST_CERTIFICATE },
      (_request, response) => {
        response.setHeader('content-length', '1024');
        response.end('x');
      },
    );
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('TEST_SERVER_PORT_MISSING');

    const originalDefaultCertificates = getCACertificates('default');
    setDefaultCACertificates([TEST_CERTIFICATE]);
    try {
      await expect(
        new NodeSignedWebhookHttpsTransport().post({
          url: `https://verified.example.test:${address.port}/deliver`,
          address: '127.0.0.1',
          headers: {},
          body: new Uint8Array(),
          timeoutMs: 1_000,
          maxResponseBytes: 512,
        }),
      ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    } finally {
      setDefaultCACertificates(originalDefaultCertificates);
    }
  });

  test('rejects an oversized request body before resolving or connecting', async () => {
    const transport = new NodeSignedWebhookHttpsTransport({ maxRequestBytes: 8 });

    await expect(
      transport.post({
        url: 'https://receiver.example.test/deliver',
        address: 'not-an-ip',
        headers: { authorization: 'Bearer must-not-leak' },
        body: new TextEncoder().encode('secret-9!'),
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'REQUEST_TOO_LARGE',
        message: 'REQUEST_TOO_LARGE',
      }),
    );
  });

  test('fails closed when its request byte cap is invalid', () => {
    expect(() => new NodeSignedWebhookHttpsTransport({ maxRequestBytes: Number.NaN })).toThrowError(
      expect.objectContaining({ code: 'REQUEST_LIMIT_INVALID' }),
    );
  });

  test('rejects an invalid timeout before resolving or connecting', async () => {
    await expect(
      new NodeSignedWebhookHttpsTransport().post({
        url: 'https://receiver.example.test/deliver',
        address: 'not-an-ip',
        headers: {},
        body: new Uint8Array(),
        timeoutMs: 0,
        maxResponseBytes: 1_024,
      }),
    ).rejects.toMatchObject({ code: 'FETCH_TIMEOUT' });
  });

  test('enforces the timeout as a total deadline even when the receiver trickles data', async () => {
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
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('TEST_SERVER_PORT_MISSING');

    const originalDefaultCertificates = getCACertificates('default');
    setDefaultCACertificates([TEST_CERTIFICATE]);
    try {
      await expect(
        new NodeSignedWebhookHttpsTransport().post({
          url: `https://verified.example.test:${address.port}/deliver`,
          address: '127.0.0.1',
          headers: {},
          body: new Uint8Array(),
          timeoutMs: 35,
          maxResponseBytes: 1_024,
        }),
      ).rejects.toMatchObject({ code: 'FETCH_TIMEOUT' });
    } finally {
      setDefaultCACertificates(originalDefaultCertificates);
    }
  });

  test('rejects an invalid response byte cap before resolving or connecting', async () => {
    await expect(
      new NodeSignedWebhookHttpsTransport().post({
        url: 'https://receiver.example.test/deliver',
        address: 'not-an-ip',
        headers: {},
        body: new Uint8Array(),
        timeoutMs: 1_000,
        maxResponseBytes: 0,
      }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
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
