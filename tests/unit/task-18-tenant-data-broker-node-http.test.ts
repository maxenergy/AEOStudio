import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'vitest';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        }),
    ),
  );
});

describe('Task 18 Tenant Data Broker Node HTTP bridge', () => {
  test('client bridge sends one AsyncIterable body without buffering and keeps the response streaming', async () => {
    const received: Uint8Array[] = [];
    const server = createServer((request, response) => {
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/internal/v1/tenant-data');
      expect(request.headers['content-length']).toBe('6');
      request.on('data', (chunk: Buffer) => received.push(Uint8Array.from(chunk)));
      request.on('end', () => {
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-length': '2',
          'content-type': 'application/vnd.aeostudio.tenant-data+json',
          pragma: 'no-cache',
          'x-content-type-options': 'nosniff',
        });
        response.end('{}');
      });
    });
    servers.push(server);
    const address = await listen(server);
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;
    const factory = broker.createTenantDataBrokerNodeHttpsClientTransport;
    expect(factory).toBeTypeOf('function');
    let pulls = 0;
    const transport = (
      factory as (options: Record<string, unknown>) => (request: unknown) => Promise<unknown>
    )({
      requestFactory(
        url: URL,
        options: Record<string, unknown>,
        onResponse: (response: unknown) => void,
      ) {
        const localUrl = new URL(url.pathname, `http://127.0.0.1:${String(address.port)}`);
        return httpRequest(localUrl, options, onResponse as never);
      },
    });

    const response = (await transport({
      method: 'POST',
      url: 'https://tenant-data-broker.staging.internal/internal/v1/tenant-data',
      headers: {
        'content-length': '6',
        'content-type': 'application/vnd.aeostudio.tenant-data-request',
      },
      body: onePassBody([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5, 6])], () => {
        pulls += 1;
      }),
      signal: AbortSignal.timeout(5_000),
      deadline: new Date(Date.now() + 5_000),
    })) as {
      status: number;
      headers: Readonly<Record<string, string>>;
      body: AsyncIterable<Uint8Array>;
    };

    expect(response.status).toBe(200);
    expect(response.headers['content-length']).toBe('2');
    expect(await consume(response.body)).toEqual(new TextEncoder().encode('{}'));
    expect(pulls).toBe(2);
    expect(await consumeChunks(received)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  test('client bridge honors socket backpressure and aborts the request plus source iterator', async () => {
    const server = createServer((request) => {
      request.pause();
    });
    servers.push(server);
    const address = await listen(server);
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;
    const factory = broker.createTenantDataBrokerNodeHttpsClientTransport as (
      options: Record<string, unknown>,
    ) => (request: unknown) => Promise<unknown>;
    const transport = factory({
      requestFactory(
        url: URL,
        options: Record<string, unknown>,
        onResponse: (response: unknown) => void,
      ) {
        const localUrl = new URL(url.pathname, `http://127.0.0.1:${String(address.port)}`);
        return httpRequest(localUrl, options, onResponse as never);
      },
    });
    const chunkCount = 256;
    const chunks = Array.from({ length: chunkCount }, () => new Uint8Array(64 * 1_024));
    let pulls = 0;
    let returned = 0;
    const controller = new AbortController();
    const pending = transport({
      method: 'POST',
      url: 'https://tenant-data-broker.staging.internal/internal/v1/tenant-data',
      headers: {
        'content-length': String(chunkCount * chunks[0]!.byteLength),
        'content-type': 'application/vnd.aeostudio.tenant-data-request',
      },
      body: trackedBody(chunks, {
        onPull: () => {
          pulls += 1;
        },
        onReturn: () => {
          returned += 1;
        },
      }),
      signal: controller.signal,
      deadline: new Date(Date.now() + 5_000),
    });

    await waitFor(() => pulls > 0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(pulls).toBeLessThan(chunkCount);
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
    expect(returned).toBe(1);
  });

  test('client deadline destroys a backpressured upload and returns its source iterator', async () => {
    const server = createServer((request) => {
      request.pause();
    });
    servers.push(server);
    const address = await listen(server);
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;
    const factory = broker.createTenantDataBrokerNodeHttpsClientTransport as (
      options: Record<string, unknown>,
    ) => (request: unknown) => Promise<unknown>;
    const transport = factory({
      requestFactory(
        url: URL,
        options: Record<string, unknown>,
        onResponse: (response: unknown) => void,
      ) {
        const localUrl = new URL(url.pathname, `http://127.0.0.1:${String(address.port)}`);
        return httpRequest(localUrl, options, onResponse as never);
      },
    });
    const chunk = new Uint8Array(64 * 1_024);
    let returned = 0;
    const pending = transport({
      method: 'POST',
      url: 'https://tenant-data-broker.staging.internal/internal/v1/tenant-data',
      headers: {
        'content-length': String(4_096 * chunk.byteLength),
        'content-type': 'application/vnd.aeostudio.tenant-data-request',
      },
      body: trackedBody(
        Array.from({ length: 4_096 }, () => chunk),
        {
          onPull: () => undefined,
          onReturn: () => {
            returned += 1;
          },
        },
      ),
      signal: new AbortController().signal,
      deadline: new Date(Date.now() + 40),
    });

    await expect(pending).rejects.toThrow('TENANT_DATA_BROKER_DEADLINE_EXPIRED');
    expect(returned).toBe(1);
  });

  test('client response iterator return destroys the incoming socket', async () => {
    let socketClosed = false;
    const server = createServer((request, response) => {
      request.resume();
      request.once('end', () => {
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'application/vnd.aeostudio.tenant-data+json',
          pragma: 'no-cache',
          'x-content-type-options': 'nosniff',
        });
        response.write(new Uint8Array([1]));
        const interval = setInterval(() => response.write(new Uint8Array([2])), 5);
        response.socket?.once('close', () => {
          clearInterval(interval);
          socketClosed = true;
        });
      });
    });
    servers.push(server);
    const address = await listen(server);
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;
    const factory = broker.createTenantDataBrokerNodeHttpsClientTransport as (
      options: Record<string, unknown>,
    ) => (request: unknown) => Promise<unknown>;
    const transport = factory({
      requestFactory(
        url: URL,
        options: Record<string, unknown>,
        onResponse: (response: unknown) => void,
      ) {
        const localUrl = new URL(url.pathname, `http://127.0.0.1:${String(address.port)}`);
        return httpRequest(localUrl, options, onResponse as never);
      },
    });

    const response = (await transport({
      method: 'POST',
      url: 'https://tenant-data-broker.staging.internal/internal/v1/tenant-data',
      headers: {
        'content-length': '0',
        'content-type': 'application/vnd.aeostudio.tenant-data-request',
      },
      body: onePassBody([], () => undefined),
      signal: new AbortController().signal,
      deadline: new Date(Date.now() + 5_000),
    })) as { body: AsyncIterable<Uint8Array> };

    const iterator = response.body[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error('response ended before its first chunk');
    expect(Array.from(first.value)).toEqual([1]);
    await iterator.return?.();
    await waitFor(() => socketClosed);
  });

  test('client deadline remains active while the streaming response is consumed', async () => {
    let socketClosed = false;
    const server = createServer((request, response) => {
      request.resume();
      request.once('end', () => {
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-length': '2',
          'content-type': 'application/octet-stream',
          pragma: 'no-cache',
          'x-content-type-options': 'nosniff',
        });
        response.write(new Uint8Array([1]));
        response.socket?.once('close', () => {
          socketClosed = true;
        });
      });
    });
    servers.push(server);
    const address = await listen(server);
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;
    const factory = broker.createTenantDataBrokerNodeHttpsClientTransport as (
      options: Record<string, unknown>,
    ) => (request: unknown) => Promise<unknown>;
    const transport = factory({
      requestFactory(
        url: URL,
        options: Record<string, unknown>,
        onResponse: (response: unknown) => void,
      ) {
        const localUrl = new URL(url.pathname, `http://127.0.0.1:${String(address.port)}`);
        return httpRequest(localUrl, options, onResponse as never);
      },
    });
    const response = (await transport({
      method: 'POST',
      url: 'https://tenant-data-broker.staging.internal/internal/v1/tenant-data',
      headers: {
        'content-length': '0',
        'content-type': 'application/vnd.aeostudio.tenant-data-request',
      },
      body: onePassBody([], () => undefined),
      signal: new AbortController().signal,
      deadline: new Date(Date.now() + 50),
    })) as { body: AsyncIterable<Uint8Array> };

    const iterator = response.body[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await expect(iterator.next()).rejects.toThrow('TENANT_DATA_BROKER_DEADLINE_EXPIRED');
    await waitFor(() => socketClosed);
  });

  test('server bridge ignores spoofed forwarding headers and preserves raw duplicate headers', async () => {
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;
    const factory = broker.createTenantDataBrokerNodeHttpServer;
    expect(factory).toBeTypeOf('function');
    const now = new Date('2026-07-23T08:00:00.000Z');
    type ObservedRequest = {
      url: string;
      headers: Record<string, string | readonly string[] | undefined>;
      deadline: Date;
    };
    const observed: { current: ObservedRequest | null } = { current: null };
    const runtime = (
      factory as (options: Record<string, unknown>) => {
        listen(input: { host: string; port: number }): Promise<{ host: string; port: number }>;
        close(): Promise<void>;
      }
    )({
      audience: 'tenant-data-broker.staging.internal',
      handler: {
        handle(request: ObservedRequest) {
          observed.current = request;
          const body = new TextEncoder().encode('{"code":"TENANT_DATA_ACCESS_DENIED"}');
          return Promise.resolve({
            status: 403,
            headers: {
              'cache-control': 'no-store',
              'content-length': String(body.byteLength),
              'content-type': 'application/vnd.aeostudio.tenant-data+json',
              pragma: 'no-cache',
              'x-content-type-options': 'nosniff',
            },
            body: onePassBody([body], () => undefined),
          });
        },
      },
      readiness: () => Promise.resolve(true),
      clock: { now: () => new Date(now) },
      requestDeadlineCapMs: 5_000,
      gracefulCloseTimeoutMs: 100,
    });
    const address = await runtime.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await localRequest({
        port: address.port,
        method: 'POST',
        path: '/internal/v1/tenant-data',
        headers: {
          host: 'attacker.example',
          'x-forwarded-host': 'also-attacker.example',
          'x-aeostudio-timestamp': String(Math.floor(now.getTime() / 1_000)),
          'x-aeostudio-nonce': ['first', 'second'],
          'content-length': '0',
        },
      });

      expect(response.status).toBe(403);
      const captured = observed.current;
      if (captured === null) throw new Error('handler did not observe request');
      expect(captured.url).toBe(
        'https://tenant-data-broker.staging.internal/internal/v1/tenant-data',
      );
      expect(captured.headers['x-aeostudio-nonce']).toEqual(['first', 'second']);
      expect(captured.headers.host).toBe('attacker.example');
      expect(captured.headers['x-forwarded-host']).toBe('also-attacker.example');
      expect(captured.deadline).toEqual(new Date(now.getTime() + 5_000));
    } finally {
      await runtime.close();
    }
  });

  test('server deadline is the earlier of the signed window and configured cap', async () => {
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;
    const factory = broker.createTenantDataBrokerNodeHttpServer as (
      options: Record<string, unknown>,
    ) => {
      listen(input: { host: string; port: number }): Promise<{ host: string; port: number }>;
      close(): Promise<void>;
    };
    const now = new Date('2026-07-23T08:00:00.000Z');
    const deadlines: Date[] = [];
    const runtime = factory({
      audience: 'tenant-data-broker.staging.internal',
      handler: {
        handle(request: { deadline: Date }) {
          deadlines.push(request.deadline);
          return Promise.resolve({
            status: 204,
            headers: {
              'cache-control': 'no-store',
              'content-length': '0',
              pragma: 'no-cache',
              'x-content-type-options': 'nosniff',
            },
            body: onePassBody([], () => undefined),
          });
        },
      },
      readiness: () => Promise.resolve(true),
      clock: { now: () => new Date(now) },
      requestDeadlineCapMs: 20_000,
      gracefulCloseTimeoutMs: 100,
    });
    const address = await runtime.listen({ host: '127.0.0.1', port: 0 });
    try {
      await localRequest({
        port: address.port,
        method: 'POST',
        path: '/internal/v1/tenant-data',
        headers: {
          'content-length': '0',
          'x-aeostudio-timestamp': String(Math.floor(now.getTime() / 1_000)),
        },
      });
      await localRequest({
        port: address.port,
        method: 'POST',
        path: '/internal/v1/tenant-data',
        headers: {
          'content-length': '0',
          'x-aeostudio-timestamp': String(Math.floor((now.getTime() - 25_000) / 1_000)),
        },
      });

      expect(deadlines).toEqual([
        new Date(now.getTime() + 20_000),
        new Date(now.getTime() + 5_000),
      ]);
    } finally {
      await runtime.close();
    }
  });

  test('server bridge returns a stable no-store failure when its handler rejects', async () => {
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;
    const factory = broker.createTenantDataBrokerNodeHttpServer as (
      options: Record<string, unknown>,
    ) => {
      listen(input: { host: string; port: number }): Promise<{ host: string; port: number }>;
      close(): Promise<void>;
    };
    const runtime = factory({
      audience: 'tenant-data-broker.staging.internal',
      handler: {
        handle() {
          return Promise.reject(new Error('internal secret must not escape'));
        },
      },
      readiness: () => Promise.resolve(true),
      clock: { now: () => new Date() },
      requestDeadlineCapMs: 5_000,
      gracefulCloseTimeoutMs: 100,
    });
    const address = await runtime.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await localRequest({
        port: address.port,
        method: 'POST',
        path: '/internal/v1/tenant-data',
        headers: { 'content-length': '0' },
      });
      expect(response.status).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(new TextDecoder().decode(response.body)).toBe(
        '{"code":"TENANT_DATA_BROKER_UNAVAILABLE"}',
      );
    } finally {
      await runtime.close();
    }
  });

  test('server bridge contains clock failures instead of leaving an unhandled request', async () => {
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;
    const factory = broker.createTenantDataBrokerNodeHttpServer as (
      options: Record<string, unknown>,
    ) => {
      listen(input: { host: string; port: number }): Promise<{ host: string; port: number }>;
      close(): Promise<void>;
    };
    const runtime = factory({
      audience: 'tenant-data-broker.staging.internal',
      handler: {
        handle() {
          return Promise.reject(new Error('handler should not run'));
        },
      },
      readiness: () => Promise.resolve(true),
      clock: {
        now() {
          throw new Error('clock unavailable');
        },
      },
      requestDeadlineCapMs: 5_000,
      gracefulCloseTimeoutMs: 100,
    });
    const address = await runtime.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await Promise.race([
        localRequest({
          port: address.port,
          method: 'POST',
          path: '/internal/v1/tenant-data',
          headers: { 'content-length': '0' },
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('request hung')), 500),
        ),
      ]);
      expect(response.status).toBe(503);
    } finally {
      await runtime.close();
    }
  });

  test('server response disconnect aborts the handler signal and returns its stream iterator', async () => {
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;
    const factory = broker.createTenantDataBrokerNodeHttpServer as (
      options: Record<string, unknown>,
    ) => {
      listen(input: { host: string; port: number }): Promise<{ host: string; port: number }>;
      close(): Promise<void>;
    };
    let handlerSignal: AbortSignal | null = null;
    let returned = 0;
    const runtime = factory({
      audience: 'tenant-data-broker.staging.internal',
      handler: {
        handle(request: { signal: AbortSignal }) {
          handlerSignal = request.signal;
          let pulls = 0;
          return Promise.resolve({
            status: 200,
            headers: {
              'cache-control': 'no-store',
              'content-type': 'application/octet-stream',
              pragma: 'no-cache',
              'x-content-type-options': 'nosniff',
            },
            body: {
              [Symbol.asyncIterator]() {
                return {
                  next(): Promise<IteratorResult<Uint8Array>> {
                    pulls += 1;
                    if (pulls === 1) {
                      return Promise.resolve({ done: false, value: new Uint8Array([1]) });
                    }
                    return new Promise(() => undefined);
                  },
                  return(): Promise<IteratorResult<Uint8Array>> {
                    returned += 1;
                    return Promise.resolve({ done: true, value: undefined });
                  },
                };
              },
            },
          });
        },
      },
      readiness: () => Promise.resolve(true),
      clock: { now: () => new Date() },
      requestDeadlineCapMs: 5_000,
      gracefulCloseTimeoutMs: 100,
    });
    const address = await runtime.listen({ host: '127.0.0.1', port: 0 });
    try {
      await new Promise<void>((resolve, reject) => {
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port: address.port,
            method: 'POST',
            path: '/internal/v1/tenant-data',
            headers: { 'content-length': '0' },
          },
          (response) => {
            response.once('data', () => {
              response.destroy();
              request.destroy();
              resolve();
            });
          },
        );
        request.once('error', (error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
        });
        request.end();
      });
      await waitFor(() => handlerSignal?.aborted === true && returned === 1);
      expect(handlerSignal?.reason).toBeInstanceOf(Error);
    } finally {
      await runtime.close();
    }
  });

  test('server request disconnect aborts the same signal passed to the handler', async () => {
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;
    const factory = broker.createTenantDataBrokerNodeHttpServer as (
      options: Record<string, unknown>,
    ) => {
      listen(input: { host: string; port: number }): Promise<{ host: string; port: number }>;
      close(): Promise<void>;
    };
    let handlerSignal: AbortSignal | null = null;
    const runtime = factory({
      audience: 'tenant-data-broker.staging.internal',
      handler: {
        handle(request: { signal: AbortSignal }) {
          handlerSignal = request.signal;
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener(
              'abort',
              () =>
                reject(
                  request.signal.reason instanceof Error
                    ? request.signal.reason
                    : new Error('request aborted'),
                ),
              { once: true },
            );
          });
        },
      },
      readiness: () => Promise.resolve(true),
      clock: { now: () => new Date() },
      requestDeadlineCapMs: 5_000,
      gracefulCloseTimeoutMs: 100,
    });
    const address = await runtime.listen({ host: '127.0.0.1', port: 0 });
    const request = httpRequest({
      host: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: '/internal/v1/tenant-data',
      headers: { 'content-length': String(1024 * 1024) },
    });
    request.once('error', () => undefined);
    request.write(new Uint8Array([1]));
    try {
      await waitFor(() => handlerSignal !== null);
      const passedSignal = handlerSignal;
      request.destroy();
      await waitFor(() => passedSignal?.aborted === true);
      expect(handlerSignal).toBe(passedSignal);
      expect(passedSignal?.reason).toBeInstanceOf(Error);
    } finally {
      request.destroy();
      await runtime.close();
    }
  });

  test('server bridge applies response socket backpressure before pulling the next body chunk', async () => {
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;
    const factory = broker.createTenantDataBrokerNodeHttpServer as (
      options: Record<string, unknown>,
    ) => {
      listen(input: { host: string; port: number }): Promise<{ host: string; port: number }>;
      close(): Promise<void>;
    };
    const totalChunks = 4_096;
    const chunk = new Uint8Array(64 * 1_024);
    let pulls = 0;
    let returned = 0;
    const runtime = factory({
      audience: 'tenant-data-broker.staging.internal',
      handler: {
        handle() {
          return Promise.resolve({
            status: 200,
            headers: {
              'cache-control': 'no-store',
              'content-type': 'application/octet-stream',
              pragma: 'no-cache',
              'x-content-type-options': 'nosniff',
            },
            body: {
              [Symbol.asyncIterator]() {
                return {
                  next(): Promise<IteratorResult<Uint8Array>> {
                    if (pulls >= totalChunks) {
                      return Promise.resolve({ done: true, value: undefined });
                    }
                    pulls += 1;
                    return Promise.resolve({ done: false, value: chunk });
                  },
                  return(): Promise<IteratorResult<Uint8Array>> {
                    returned += 1;
                    return Promise.resolve({ done: true, value: undefined });
                  },
                };
              },
            },
          });
        },
      },
      readiness: () => Promise.resolve(true),
      clock: { now: () => new Date() },
      requestDeadlineCapMs: 5_000,
      gracefulCloseTimeoutMs: 100,
    });
    const address = await runtime.listen({ host: '127.0.0.1', port: 0 });
    const clientResponse: { current: IncomingMessage | null } = { current: null };
    try {
      await new Promise<void>((resolve, reject) => {
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port: address.port,
            method: 'POST',
            path: '/internal/v1/tenant-data',
            headers: { 'content-length': '0' },
          },
          (response) => {
            clientResponse.current = response;
            response.pause();
            resolve();
          },
        );
        request.once('error', reject);
        request.end();
      });
      await waitFor(() => pulls > 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(pulls).toBeLessThan(totalChunks);
      clientResponse.current?.destroy();
      await waitFor(() => returned === 1);
    } finally {
      clientResponse.current?.destroy();
      await runtime.close();
    }
  });

  test('health endpoint is GET-only, no-store, and reflects readiness failures', async () => {
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;
    const factory = broker.createTenantDataBrokerNodeHttpServer as (
      options: Record<string, unknown>,
    ) => {
      listen(input: { host: string; port: number }): Promise<{ host: string; port: number }>;
      close(): Promise<void>;
    };
    let readiness: true | false | 'THROW' = true;
    const runtime = factory({
      audience: 'tenant-data-broker.staging.internal',
      handler: {
        handle() {
          return Promise.reject(new Error('broker route should not run'));
        },
      },
      readiness: () => {
        if (readiness === 'THROW') throw new Error('dependency unavailable');
        return Promise.resolve(readiness);
      },
      clock: { now: () => new Date() },
      requestDeadlineCapMs: 5_000,
      gracefulCloseTimeoutMs: 100,
    });
    const address = await runtime.listen({ host: '127.0.0.1', port: 0 });
    try {
      const ready = await localRequest({
        port: address.port,
        method: 'GET',
        path: '/internal/healthz',
      });
      expect(ready.status).toBe(200);
      expect(ready.headers['cache-control']).toBe('no-store');
      expect(ready.headers['content-length']).toBe('0');
      expect(ready.body).toHaveLength(0);

      readiness = false;
      expect(
        (
          await localRequest({
            port: address.port,
            method: 'GET',
            path: '/internal/healthz',
          })
        ).status,
      ).toBe(503);

      readiness = 'THROW';
      expect(
        (
          await localRequest({
            port: address.port,
            method: 'GET',
            path: '/internal/healthz',
          })
        ).status,
      ).toBe(503);
      expect(
        (
          await localRequest({
            port: address.port,
            method: 'POST',
            path: '/internal/healthz',
          })
        ).status,
      ).toBe(405);
      expect(
        (
          await localRequest({
            port: address.port,
            method: 'GET',
            path: '/internal/healthz?spoof=1',
          })
        ).status,
      ).toBe(404);
    } finally {
      await runtime.close();
    }
  });

  test('broker route accepts only POST on the exact fixed path', async () => {
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;
    const factory = broker.createTenantDataBrokerNodeHttpServer as (
      options: Record<string, unknown>,
    ) => {
      listen(input: { host: string; port: number }): Promise<{ host: string; port: number }>;
      close(): Promise<void>;
    };
    let calls = 0;
    const runtime = factory({
      audience: 'tenant-data-broker.staging.internal',
      handler: {
        handle() {
          calls += 1;
          return Promise.reject(new Error('not reached by invalid routes'));
        },
      },
      readiness: () => Promise.resolve(true),
      clock: { now: () => new Date() },
      requestDeadlineCapMs: 5_000,
      gracefulCloseTimeoutMs: 100,
    });
    const address = await runtime.listen({ host: '127.0.0.1', port: 0 });
    try {
      const wrongMethod = await localRequest({
        port: address.port,
        method: 'GET',
        path: '/internal/v1/tenant-data',
      });
      const querySpoof = await localRequest({
        port: address.port,
        method: 'POST',
        path: '/internal/v1/tenant-data?alternate=true',
        headers: { 'content-length': '0' },
      });
      const suffixSpoof = await localRequest({
        port: address.port,
        method: 'POST',
        path: '/internal/v1/tenant-data/',
        headers: { 'content-length': '0' },
      });

      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.allow).toBe('POST');
      expect(querySpoof.status).toBe(404);
      expect(suffixSpoof.status).toBe(404);
      expect(calls).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  test('graceful close is idempotent, bounded, and aborts hanging in-flight work', async () => {
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;
    const factory = broker.createTenantDataBrokerNodeHttpServer as (
      options: Record<string, unknown>,
    ) => {
      listen(input: { host: string; port: number }): Promise<{ host: string; port: number }>;
      close(): Promise<void>;
    };
    let handlerSignal: AbortSignal | null = null;
    const runtime = factory({
      audience: 'tenant-data-broker.staging.internal',
      handler: {
        handle(request: { signal: AbortSignal }) {
          handlerSignal = request.signal;
          return new Promise(() => undefined);
        },
      },
      readiness: () => Promise.resolve(true),
      clock: { now: () => new Date() },
      requestDeadlineCapMs: 5_000,
      gracefulCloseTimeoutMs: 30,
    });
    const address = await runtime.listen({ host: '127.0.0.1', port: 0 });
    const clientSettled = new Promise<void>((resolve) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        method: 'POST',
        path: '/internal/v1/tenant-data',
        headers: { 'content-length': '0' },
      });
      request.once('response', (response) => response.once('close', resolve));
      request.once('error', () => resolve());
      request.end();
    });
    await waitFor(() => handlerSignal !== null);

    const startedAt = Date.now();
    const firstClose = runtime.close();
    const secondClose = runtime.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(handlerSignal?.aborted).toBe(true);
    await clientSettled;
  });
});

function listen(server: Server): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server address unavailable'));
        return;
      }
      resolve({ port: address.port });
    });
  });
}

function onePassBody(chunks: readonly Uint8Array[], onPull: () => void): AsyncIterable<Uint8Array> {
  let used = false;
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      if (used) throw new Error('body reused');
      used = true;
      for (const chunk of chunks) {
        onPull();
        yield chunk;
      }
    },
  };
}

function trackedBody(
  chunks: readonly Uint8Array[],
  callbacks: { onPull(): void; onReturn(): void },
): AsyncIterable<Uint8Array> {
  let used = false;
  return {
    [Symbol.asyncIterator]() {
      if (used) throw new Error('body reused');
      used = true;
      let index = 0;
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          const value = chunks[index];
          if (value === undefined) {
            return Promise.resolve({ done: true, value: undefined });
          }
          index += 1;
          callbacks.onPull();
          return Promise.resolve({ done: false, value });
        },
        return(): Promise<IteratorResult<Uint8Array>> {
          callbacks.onReturn();
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

async function consume(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(Uint8Array.from(chunk));
  return consumeChunks(chunks);
}

async function consumeChunks(chunks: readonly Uint8Array[]): Promise<Uint8Array> {
  await Promise.resolve();
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function localRequest(input: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string | readonly string[]>;
}): Promise<{
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: Uint8Array;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: input.port,
        method: input.method,
        path: input.path,
        headers: input.headers,
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(Uint8Array.from(chunk)));
        response.on('end', () => {
          void consumeChunks(chunks).then((body) =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
          );
        });
      },
    );
    request.once('error', reject);
    request.end();
  });
}
