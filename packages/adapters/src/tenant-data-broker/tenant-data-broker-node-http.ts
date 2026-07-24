import { once } from 'node:events';
import type {
  ClientRequest,
  IncomingMessage,
  OutgoingHttpHeaders,
  RequestOptions,
  Server,
  ServerResponse,
} from 'node:http';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';

import type {
  TenantDataBrokerHttpRequest,
  TenantDataBrokerHttpResponse,
} from './tenant-data-broker-http.js';

export type TenantDataBrokerNodeRequestFactory = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

export interface TenantDataBrokerNodeHttpsClientTransportOptions {
  requestFactory?: TenantDataBrokerNodeRequestFactory;
}

export interface TenantDataBrokerNodeHttpServerOptions {
  audience: string;
  handler: {
    handle(request: TenantDataBrokerHttpRequest): Promise<TenantDataBrokerHttpResponse>;
  };
  readiness(): Promise<boolean>;
  clock: { now(): Date };
  requestDeadlineCapMs: number;
  gracefulCloseTimeoutMs: number;
}

export interface TenantDataBrokerNodeHttpServer {
  listen(input: { host: string; port: number }): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

const BROKER_PATH = '/internal/v1/tenant-data';
const HEALTH_PATH = '/internal/healthz';
const SIGNED_REQUEST_WINDOW_MS = 30_000;

export function createTenantDataBrokerNodeHttpsClientTransport(
  options: TenantDataBrokerNodeHttpsClientTransportOptions = {},
): (request: TenantDataBrokerHttpRequest) => Promise<TenantDataBrokerHttpResponse> {
  const requestFactory = options.requestFactory ?? httpsRequest;
  if (typeof requestFactory !== 'function') {
    throw new Error('TENANT_DATA_BROKER_NODE_REQUEST_FACTORY_INVALID');
  }
  return (request) => executeNodeHttpsRequest(requestFactory, request);
}

export function createTenantDataBrokerNodeHttpServer(
  options: TenantDataBrokerNodeHttpServerOptions,
): TenantDataBrokerNodeHttpServer {
  return new NodeTenantDataBrokerHttpServer(options);
}

class NodeTenantDataBrokerHttpServer implements TenantDataBrokerNodeHttpServer {
  private readonly audience: string;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly controllers = new Set<AbortController>();
  private closePromise: Promise<void> | null = null;
  private closed = false;

  public constructor(private readonly options: TenantDataBrokerNodeHttpServerOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      !validAudience(options.audience) ||
      !hasFunction(options.handler, 'handle') ||
      typeof options.readiness !== 'function' ||
      !hasFunction(options.clock, 'now') ||
      !validTimeout(options.requestDeadlineCapMs, SIGNED_REQUEST_WINDOW_MS) ||
      !validTimeout(options.gracefulCloseTimeoutMs, 60_000)
    ) {
      throw new Error('TENANT_DATA_BROKER_NODE_SERVER_OPTIONS_INVALID');
    }
    this.audience = options.audience;
    this.server = createServer((request, response) => {
      void this.route(request, response).catch(() => {
        try {
          if (!response.headersSent && !response.destroyed) {
            writeJsonFailure(response);
          } else if (!response.writableEnded) {
            response.destroy();
          }
        } catch {
          response.destroy();
        }
        if (!request.complete) request.destroy();
      });
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
  }

  public listen(input: { host: string; port: number }): Promise<{ host: string; port: number }> {
    if (
      this.closed ||
      input === null ||
      typeof input !== 'object' ||
      typeof input.host !== 'string' ||
      input.host.length < 1 ||
      input.host.length > 255 ||
      !Number.isInteger(input.port) ||
      input.port < 0 ||
      input.port > 65_535
    ) {
      return Promise.reject(new Error('TENANT_DATA_BROKER_NODE_LISTEN_INVALID'));
    }
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        const address = this.server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('TENANT_DATA_BROKER_NODE_LISTEN_INVALID'));
          return;
        }
        resolve({ host: address.address, port: address.port });
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(input.port, input.host);
    });
  }

  public close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    this.closePromise = new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const forceClose = () => {
        for (const controller of this.controllers) {
          controller.abort(new Error('TENANT_DATA_BROKER_SERVER_CLOSING'));
        }
        for (const socket of this.sockets) socket.destroy();
        this.server.closeAllConnections?.();
        finish();
      };
      const timer = setTimeout(forceClose, this.options.gracefulCloseTimeoutMs);
      if (!this.server.listening) {
        forceClose();
        return;
      }
      this.server.close(finish);
      this.server.closeIdleConnections?.();
    });
    return this.closePromise;
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url === HEALTH_PATH) {
      await this.health(request, response);
      return;
    }
    if (request.url !== BROKER_PATH) {
      writeEmptyResponse(response, 404);
      return;
    }
    if (request.method !== 'POST') {
      writeEmptyResponse(response, 405, { allow: 'POST' });
      return;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const headers = headersFromRaw(request.rawHeaders);
    const now = readNow(this.options.clock);
    const deadline = deriveServerDeadline(
      headers['x-aeostudio-timestamp'],
      now,
      this.options.requestDeadlineCapMs,
    );
    const delay = Math.max(1, deadline.getTime() - now.getTime());
    const deadlineTimer = setTimeout(
      () => controller.abort(new Error('TENANT_DATA_BROKER_DEADLINE_EXPIRED')),
      delay,
    );
    const abort = (reason: Error) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const onRequestAborted = () => abort(new Error('TENANT_DATA_BROKER_CLIENT_DISCONNECTED'));
    const onRequestError = (error: Error) => abort(error);
    const onRequestClose = () => {
      if (!request.complete) abort(new Error('TENANT_DATA_BROKER_CLIENT_DISCONNECTED'));
    };
    const onResponseClose = () => {
      if (!response.writableEnded) {
        abort(new Error('TENANT_DATA_BROKER_CLIENT_DISCONNECTED'));
      }
    };
    request.once('aborted', onRequestAborted);
    request.once('error', onRequestError);
    request.once('close', onRequestClose);
    response.once('close', onResponseClose);
    try {
      const brokerResponse = await raceWithAbort(
        this.options.handler.handle({
          method: request.method,
          url: `https://${this.audience}${BROKER_PATH}`,
          headers,
          body: incomingRequestBody(request, controller),
          signal: controller.signal,
          deadline,
        }),
        controller.signal,
      );
      await writeStreamingResponse(response, brokerResponse, controller.signal);
    } catch {
      if (!response.headersSent) {
        writeJsonFailure(response);
      } else {
        response.destroy();
      }
    } finally {
      clearTimeout(deadlineTimer);
      request.off('aborted', onRequestAborted);
      request.off('error', onRequestError);
      request.off('close', onRequestClose);
      response.off('close', onResponseClose);
      this.controllers.delete(controller);
      if (!request.complete) request.destroy();
    }
  }

  private async health(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET') {
      writeEmptyResponse(response, 405, { allow: 'GET' });
      return;
    }
    let ready: boolean;
    try {
      ready = (await this.options.readiness()) === true;
    } catch {
      ready = false;
    }
    writeEmptyResponse(response, ready ? 200 : 503);
  }
}

function incomingRequestBody(
  request: IncomingMessage,
  controller: AbortController,
): AsyncIterable<Uint8Array> {
  let used = false;
  return {
    [Symbol.asyncIterator]() {
      if (used) throw new Error('TENANT_DATA_BROKER_REQUEST_BODY_REUSED');
      used = true;
      const iterator = request[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          const next = await raceWithAbort(iterator.next(), controller.signal);
          if (next.done) return { done: true, value: undefined };
          if (!(next.value instanceof Uint8Array)) {
            throw new Error('TENANT_DATA_BROKER_BODY_CHUNK_INVALID');
          }
          return { done: false, value: next.value };
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          if (typeof iterator.return === 'function') {
            await iterator.return().catch(() => undefined);
          }
          if (!request.complete) request.destroy();
          return { done: true, value: undefined };
        },
        async throw(error?: unknown): Promise<IteratorResult<Uint8Array>> {
          if (typeof iterator.return === 'function') {
            await iterator.return().catch(() => undefined);
          }
          request.destroy(error instanceof Error ? error : undefined);
          throw error;
        },
      };
    },
  };
}

async function writeStreamingResponse(
  response: ServerResponse,
  brokerResponse: TenantDataBrokerHttpResponse,
  signal: AbortSignal,
): Promise<void> {
  if (
    brokerResponse === null ||
    typeof brokerResponse !== 'object' ||
    !Number.isInteger(brokerResponse.status) ||
    brokerResponse.status < 100 ||
    brokerResponse.status > 599 ||
    !isAsyncByteIterable(brokerResponse.body)
  ) {
    throw new Error('TENANT_DATA_BROKER_NODE_RESPONSE_INVALID');
  }
  response.writeHead(brokerResponse.status, brokerResponse.headers);
  const iterator = brokerResponse.body[Symbol.asyncIterator]();
  let complete = false;
  try {
    while (true) {
      const next = await raceWithAbort(iterator.next(), signal);
      if (next.done) {
        complete = true;
        response.end();
        return;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw new Error('TENANT_DATA_BROKER_BODY_CHUNK_INVALID');
      }
      if (!response.write(next.value)) {
        await raceWithAbort(
          once(response, 'drain').then(() => undefined),
          signal,
        );
      }
    }
  } finally {
    if (!complete && typeof iterator.return === 'function') {
      await iterator.return().catch(() => undefined);
    }
  }
}

function headersFromRaw(
  rawHeaders: readonly string[],
): Record<string, string | readonly string[] | undefined> {
  const headers: Record<string, string | readonly string[] | undefined> = {};
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const rawName = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (rawName === undefined || value === undefined) continue;
    const name = rawName.toLowerCase();
    const existing = headers[name];
    headers[name] =
      existing === undefined
        ? value
        : typeof existing === 'string'
          ? [existing, value]
          : [...existing, value];
  }
  return headers;
}

function deriveServerDeadline(
  timestampHeader: string | readonly string[] | undefined,
  now: Date,
  capMs: number,
): Date {
  const capped = now.getTime() + capMs;
  if (typeof timestampHeader !== 'string' || !/^[0-9]{10}$/u.test(timestampHeader)) {
    return new Date(capped);
  }
  const signedAt = Number(timestampHeader) * 1_000;
  if (!Number.isSafeInteger(signedAt)) return new Date(capped);
  return new Date(Math.min(capped, signedAt + SIGNED_REQUEST_WINDOW_MS));
}

function writeEmptyResponse(
  response: ServerResponse,
  status: number,
  additionalHeaders: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    ...noStoreHeaders(),
    ...additionalHeaders,
    'content-length': '0',
  });
  response.end();
}

function writeJsonFailure(response: ServerResponse): void {
  const body = Buffer.from('{"code":"TENANT_DATA_BROKER_UNAVAILABLE"}', 'utf8');
  response.writeHead(503, {
    ...noStoreHeaders(),
    'content-length': String(body.byteLength),
    'content-type': 'application/vnd.aeostudio.tenant-data+json',
  });
  response.end(body);
  body.fill(0);
}

function noStoreHeaders(): Readonly<Record<string, string>> {
  return {
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
  };
}

async function executeNodeHttpsRequest(
  requestFactory: TenantDataBrokerNodeRequestFactory,
  request: TenantDataBrokerHttpRequest,
): Promise<TenantDataBrokerHttpResponse> {
  const url = readHttpsUrl(request.url);
  if (
    request.method !== 'POST' ||
    !isAsyncByteIterable(request.body) ||
    !isAbortSignal(request.signal) ||
    !(request.deadline instanceof Date) ||
    !Number.isFinite(request.deadline.getTime())
  ) {
    throw new Error('TENANT_DATA_BROKER_NODE_REQUEST_INVALID');
  }
  assertActive(request.signal);
  const deadlineDelay = request.deadline.getTime() - Date.now();
  if (deadlineDelay <= 0) {
    throw new Error('TENANT_DATA_BROKER_DEADLINE_EXPIRED');
  }

  const incoming: { current: IncomingMessage | null } = { current: null };
  let settled = false;
  let resolveResponse: ((value: IncomingMessage) => void) | undefined;
  let rejectResponse: ((reason: unknown) => void) | undefined;
  const responsePromise = new Promise<IncomingMessage>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  // Upload failures can win before this promise is awaited; keep that parallel
  // rejection observed while preserving it for the later await.
  void responsePromise.catch(() => undefined);
  const nodeRequest = requestFactory(
    url,
    {
      method: request.method,
      headers: request.headers as OutgoingHttpHeaders,
    },
    (response) => {
      incoming.current = response;
      settled = true;
      resolveResponse?.(response);
    },
  );
  const abortError = () =>
    request.signal.reason instanceof Error
      ? request.signal.reason
      : new Error('TENANT_DATA_BROKER_REQUEST_ABORTED');
  const onAbort = () => {
    const error = abortError();
    incoming.current?.destroy(error);
    nodeRequest.destroy(error);
  };
  const onRequestError = (error: Error) => {
    if (!settled) rejectResponse?.(error);
  };
  request.signal.addEventListener('abort', onAbort, { once: true });
  nodeRequest.on('error', onRequestError);
  const deadlineTimer = setTimeout(() => {
    const error = new Error('TENANT_DATA_BROKER_DEADLINE_EXPIRED');
    incoming.current?.destroy(error);
    nodeRequest.destroy(error);
  }, deadlineDelay);
  deadlineTimer.unref();

  const cleanup = () => {
    clearTimeout(deadlineTimer);
    request.signal.removeEventListener('abort', onAbort);
    nodeRequest.off('error', onRequestError);
  };
  const iterator = request.body[Symbol.asyncIterator]();
  try {
    while (true) {
      assertActive(request.signal);
      const next = await raceWithRequestFailure(iterator.next(), nodeRequest, request.signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        throw new Error('TENANT_DATA_BROKER_BODY_CHUNK_INVALID');
      }
      if (!nodeRequest.write(next.value)) {
        await waitForDrain(nodeRequest, request.signal);
      }
    }
    await endRequest(nodeRequest, request.signal);
    const response = await responsePromise;
    const normalized = normalizeIncomingHeaders(response);
    if (response.statusCode === undefined) {
      throw new Error('TENANT_DATA_BROKER_NODE_RESPONSE_INVALID');
    }
    return {
      status: response.statusCode,
      headers: normalized,
      body: incomingMessageBody(response, cleanup),
    };
  } catch (error: unknown) {
    cleanup();
    nodeRequest.destroy(error instanceof Error ? error : undefined);
    incoming.current?.destroy(error instanceof Error ? error : undefined);
    if (typeof iterator.return === 'function') {
      await iterator.return().catch(() => undefined);
    }
    throw error;
  }
}

function incomingMessageBody(
  response: IncomingMessage,
  cleanup: () => void,
): AsyncIterable<Uint8Array> {
  let used = false;
  return {
    [Symbol.asyncIterator]() {
      if (used) {
        throw new Error('TENANT_DATA_BROKER_RESPONSE_BODY_REUSED');
      }
      used = true;
      const iterator = response[Symbol.asyncIterator]();
      let closed = false;
      const close = async (destroy: boolean): Promise<void> => {
        if (closed) return;
        closed = true;
        cleanup();
        if (destroy) response.destroy();
        if (typeof iterator.return === 'function') {
          await iterator.return().catch(() => undefined);
        }
      };
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (closed) return { done: true, value: undefined };
          try {
            const next = await iterator.next();
            if (next.done) {
              await close(false);
              return { done: true, value: undefined };
            }
            if (!(next.value instanceof Uint8Array)) {
              throw new Error('TENANT_DATA_BROKER_BODY_CHUNK_INVALID');
            }
            return { done: false, value: next.value };
          } catch (error: unknown) {
            await close(true);
            throw error;
          }
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          await close(true);
          return { done: true, value: undefined };
        },
        async throw(error?: unknown): Promise<IteratorResult<Uint8Array>> {
          await close(true);
          throw error;
        },
      };
    },
  };
}

function normalizeIncomingHeaders(response: IncomingMessage): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const rawName = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];
    if (rawName === undefined || value === undefined) {
      throw new Error('TENANT_DATA_BROKER_NODE_RESPONSE_INVALID');
    }
    const name = rawName.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(headers, name)) {
      throw new Error('TENANT_DATA_BROKER_NODE_RESPONSE_DUPLICATE_HEADER');
    }
    headers[name] = value;
  }
  return headers;
}

async function waitForDrain(request: ClientRequest, signal: AbortSignal): Promise<void> {
  await raceWithRequestFailure(
    once(request, 'drain').then(() => undefined),
    request,
    signal,
  );
}

async function endRequest(request: ClientRequest, signal: AbortSignal): Promise<void> {
  await raceWithRequestFailure(
    new Promise<void>((resolve) => request.end(resolve)),
    request,
    signal,
  );
}

async function raceWithRequestFailure<T>(
  effect: Promise<T>,
  request: ClientRequest,
  signal: AbortSignal,
): Promise<T> {
  assertActive(signal);
  let onAbort: (() => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('TENANT_DATA_BROKER_REQUEST_ABORTED'),
      );
    onError = (error) => reject(error);
    signal.addEventListener('abort', onAbort, { once: true });
    request.once('error', onError);
  });
  try {
    return await Promise.race([effect, interrupted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    if (onError !== undefined) request.off('error', onError);
  }
}

function readHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.hash.length !== 0
  ) {
    throw new Error('TENANT_DATA_BROKER_NODE_URL_INVALID');
  }
  return url;
}

async function raceWithAbort<T>(effect: Promise<T>, signal: AbortSignal): Promise<T> {
  assertActive(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('TENANT_DATA_BROKER_REQUEST_ABORTED'),
      );
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([effect, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

function validAudience(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::443)?$/u.test(
      value,
    )
  );
}

function validTimeout(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maximum;
}

function hasFunction(value: unknown, name: string): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  return typeof (value as Record<string, unknown>)[name] === 'function';
}

function readNow(clock: { now(): Date }): Date {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('TENANT_DATA_BROKER_TIME_INVALID');
  }
  return new Date(now);
}

function isAsyncByteIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function'
  );
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function' &&
    typeof (value as AbortSignal).removeEventListener === 'function'
  );
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('TENANT_DATA_BROKER_REQUEST_ABORTED');
  }
}
