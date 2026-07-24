import { createServer } from 'node:http';
import { once } from 'node:events';

import { afterEach, describe, expect, test } from 'vitest';

import { NodeCrawlerHttpTransport } from './node-safe-crawler-fetch.js';

describe('Node crawler HTTP transport', () => {
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

  test('connects only to the pinned address while preserving the verified Host header', async () => {
    let observedHost = '';
    const server = createServer((request, response) => {
      observedHost = request.headers.host ?? '';
      response.setHeader('content-type', 'text/plain');
      response.end('pinned response');
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('TEST_SERVER_PORT_MISSING');

    const response = await new NodeCrawlerHttpTransport().get({
      url: `http://verified.example:${address.port}/robots.txt`,
      address: '127.0.0.1',
      timeoutMs: 1_000,
      maxBytes: 1_024,
    });

    expect(observedHost).toBe(`verified.example:${address.port}`);
    expect(response.connectedAddress).toBe('127.0.0.1');
    expect(new TextDecoder().decode(response.body)).toBe('pinned response');
  });

  test('terminates a chunked response as soon as the independent page limit is exceeded', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.write(Buffer.alloc(700, 1));
      response.write(Buffer.alloc(700, 2));
      response.end(Buffer.alloc(700, 3));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('TEST_SERVER_PORT_MISSING');

    await expect(
      new NodeCrawlerHttpTransport().get({
        url: `http://verified.example:${address.port}/page`,
        address: '127.0.0.1',
        timeoutMs: 1_000,
        maxBytes: 1_024,
      }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
});
