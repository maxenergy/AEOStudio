import { lookup } from 'node:dns/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import { isPublicNetworkAddress } from '../crawler/ip-policy.js';
import type {
  SafeWordPressJsonHttpClient,
  SafeWordPressJsonHttpRequest,
  SafeWordPressJsonHttpResponse,
} from './production-wordpress-woocommerce-draft-publication-adapter.js';

export interface WordPressDnsResolver {
  resolve(hostname: string): Promise<string[]>;
}

export interface WordPressHttpsJsonTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  location: string | null;
  connectedAddress: string;
}

export interface WordPressHttpsJsonTransport {
  request(input: {
    url: string;
    address: string;
    method: SafeWordPressJsonHttpRequest['method'];
    headers: Record<string, string>;
    body: Uint8Array;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<WordPressHttpsJsonTransportResponse>;
}

export interface NodeSafeWordPressJsonHttpClientOptions {
  resolver?: WordPressDnsResolver;
  transport?: WordPressHttpsJsonTransport;
  maxRequestBytes?: number;
}

export class NodeWordPressDnsResolver implements WordPressDnsResolver {
  async resolve(hostname: string): Promise<string[]> {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return [...new Set(records.map((record) => record.address))];
  }
}

export class NodeWordPressHttpsJsonTransport implements WordPressHttpsJsonTransport {
  request(input: {
    url: string;
    address: string;
    method: SafeWordPressJsonHttpRequest['method'];
    headers: Record<string, string>;
    body: Uint8Array;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<WordPressHttpsJsonTransportResponse> {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return Promise.reject(clientError('HTTPS_REQUIRED'));
    }
    if (url.protocol !== 'https:') return Promise.reject(clientError('HTTPS_REQUIRED'));
    if (!isCanonicalRequestUrl(input.url, url)) {
      return Promise.reject(clientError('URL_NOT_CANONICAL'));
    }
    if (!isAllowedMethod(input.method)) {
      return Promise.reject(clientError('METHOD_NOT_ALLOWED'));
    }
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > MAX_TIMER_MILLISECONDS
    ) {
      return Promise.reject(clientError('FETCH_TIMEOUT'));
    }
    if (!Number.isSafeInteger(input.maxResponseBytes) || input.maxResponseBytes < 1) {
      return Promise.reject(clientError('RESPONSE_TOO_LARGE'));
    }
    const family = isIP(input.address);
    if (family === 0) return Promise.reject(clientError('CONNECT_FAILED'));
    const hostname = hostnameWithoutBrackets(url.hostname);
    const headers = normalizedRequestHeaders(input.headers, url.host, input.body.byteLength);
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all === true) {
        callback(null, [{ address: input.address, family }]);
        return;
      }
      callback(null, input.address, family);
    };

    return new Promise<WordPressHttpsJsonTransportResponse>((resolve, reject) => {
      let settled = false;
      const deadline: { timer: ReturnType<typeof setTimeout> | undefined } = {
        timer: undefined,
      };
      const clearDeadline = () => {
        if (deadline.timer !== undefined) clearTimeout(deadline.timer);
      };
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        clearDeadline();
        reject(error);
      };
      let operation: ReturnType<typeof httpsRequest>;
      try {
        operation = httpsRequest(
          {
            protocol: 'https:',
            hostname,
            port: url.port === '' ? undefined : Number(url.port),
            path: `${url.pathname}${url.search}`,
            method: input.method,
            servername: hostname,
            lookup: pinnedLookup,
            headers,
            agent: false,
          },
          (response) => {
            const connectedAddress = normalizeNetworkAddress(response.socket.remoteAddress);
            const expectedAddress = normalizeNetworkAddress(input.address);
            if (connectedAddress === null || connectedAddress !== expectedAddress) {
              const error = clientError('CONNECTION_ADDRESS_MISMATCH');
              finishReject(error);
              response.destroy(error);
              return;
            }
            if (
              response.statusCode !== undefined &&
              response.statusCode >= 300 &&
              response.statusCode < 400
            ) {
              const error = clientError('REDIRECT_FORBIDDEN');
              finishReject(error);
              response.destroy(error);
              return;
            }
            const declaredLength = Number(response.headers['content-length'] ?? 0);
            if (Number.isFinite(declaredLength) && declaredLength > input.maxResponseBytes) {
              const error = clientError('RESPONSE_TOO_LARGE');
              finishReject(error);
              response.destroy(error);
              return;
            }
            const chunks: Buffer[] = [];
            let responseSize = 0;
            response.on('data', (chunk: Buffer) => {
              responseSize += chunk.byteLength;
              if (responseSize > input.maxResponseBytes) {
                response.destroy(clientError('RESPONSE_TOO_LARGE'));
                return;
              }
              chunks.push(Buffer.from(chunk));
            });
            response.once('error', finishReject);
            response.once('end', () => {
              if (settled) return;
              settled = true;
              clearDeadline();
              resolve({
                status: response.statusCode ?? 0,
                headers: normalizedResponseHeaders(response.headers),
                body: new Uint8Array(Buffer.concat(chunks)),
                location:
                  typeof response.headers.location === 'string' ? response.headers.location : null,
                connectedAddress,
              });
            });
          },
        );
      } catch {
        finishReject(clientError('TRANSPORT_ERROR'));
        return;
      }
      deadline.timer = setTimeout(
        () => operation.destroy(clientError('FETCH_TIMEOUT')),
        input.timeoutMs,
      );
      deadline.timer.unref();
      operation.once('error', (error: NodeJS.ErrnoException) => {
        if (isSafeTransportError(error)) {
          finishReject(clientError(error.message));
          return;
        }
        finishReject(clientError(isTlsError(error) ? 'TLS_FAILED' : 'CONNECT_FAILED'));
      });
      try {
        operation.end(input.body);
      } catch {
        operation.destroy();
        finishReject(clientError('TRANSPORT_ERROR'));
      }
    });
  }
}

export class NodeSafeWordPressJsonHttpClient implements SafeWordPressJsonHttpClient {
  private readonly resolver: WordPressDnsResolver;
  private readonly transport: WordPressHttpsJsonTransport;
  private readonly maxRequestBytes: number;

  constructor(options: NodeSafeWordPressJsonHttpClientOptions = {}) {
    this.resolver = options.resolver ?? new NodeWordPressDnsResolver();
    this.transport = options.transport ?? new NodeWordPressHttpsJsonTransport();
    this.maxRequestBytes = options.maxRequestBytes ?? 12 * 1_024 * 1_024;
    if (!Number.isSafeInteger(this.maxRequestBytes) || this.maxRequestBytes < 1) {
      throw clientError('REQUEST_LIMIT_INVALID');
    }
  }

  async request(input: SafeWordPressJsonHttpRequest): Promise<SafeWordPressJsonHttpResponse> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_MILLISECONDS) {
      throw clientError('FETCH_TIMEOUT');
    }
    const maxResponseBytes = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      throw clientError('RESPONSE_TOO_LARGE');
    }
    const deadline = Date.now() + timeoutMs;
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw clientError('HTTPS_REQUIRED');
    }
    if (url.protocol !== 'https:') {
      throw clientError('HTTPS_REQUIRED');
    }
    if (!isCanonicalRequestUrl(input.url, url)) {
      throw clientError('URL_NOT_CANONICAL');
    }
    if (!isAllowedMethod(input.method)) {
      throw clientError('METHOD_NOT_ALLOWED');
    }
    let body: Uint8Array;
    try {
      const json = input.body === undefined ? '' : JSON.stringify(input.body);
      if (json === undefined) throw clientError('REQUEST_JSON_INVALID');
      body = new TextEncoder().encode(json);
    } catch {
      throw clientError('REQUEST_JSON_INVALID');
    }
    if (body.byteLength > this.maxRequestBytes) {
      throw clientError('REQUEST_TOO_LARGE');
    }
    let addresses: string[];
    try {
      const remainingMilliseconds = deadline - Date.now();
      if (remainingMilliseconds <= 0) throw clientError('FETCH_TIMEOUT');
      const resolution = await withinDeadline(
        this.resolver.resolve(hostnameWithoutBrackets(url.hostname)),
        remainingMilliseconds,
      );
      if (resolution === DEADLINE_EXCEEDED) throw clientError('FETCH_TIMEOUT');
      addresses = resolution;
    } catch (error) {
      if (hasErrorCode(error, 'FETCH_TIMEOUT')) throw clientError('FETCH_TIMEOUT');
      throw clientError('DNS_RESOLUTION_FAILED');
    }
    if (addresses.length === 0) throw clientError('DNS_NO_ADDRESS');
    if (addresses.some((address) => !isPublicNetworkAddress(address))) {
      throw clientError('NON_PUBLIC_ADDRESS');
    }
    let response: WordPressHttpsJsonTransportResponse;
    try {
      const remainingMilliseconds = deadline - Date.now();
      if (remainingMilliseconds <= 0) throw clientError('FETCH_TIMEOUT');
      const transported = await withinDeadline(
        this.transport.request({
          url: input.url,
          address: addresses[0]!,
          method: input.method,
          headers: { ...input.headers },
          body,
          timeoutMs: remainingMilliseconds,
          maxResponseBytes,
        }),
        remainingMilliseconds,
      );
      if (transported === DEADLINE_EXCEEDED) throw clientError('FETCH_TIMEOUT');
      response = transported;
    } catch (error) {
      throw clientError(safeClientTransportErrorCode(error));
    }
    const connectedAddress = normalizeNetworkAddress(response.connectedAddress);
    const verifiedAddresses = addresses.map((address) => normalizeNetworkAddress(address));
    if (
      connectedAddress === null ||
      !isPublicNetworkAddress(connectedAddress) ||
      !verifiedAddresses.includes(connectedAddress)
    ) {
      throw clientError('CONNECTION_ADDRESS_MISMATCH');
    }
    if (response.status >= 300 && response.status < 400) {
      throw clientError('REDIRECT_FORBIDDEN');
    }
    if (response.body.byteLength > maxResponseBytes) {
      throw clientError('RESPONSE_TOO_LARGE');
    }
    let parsedBody: unknown = null;
    if (response.body.byteLength > 0) {
      try {
        parsedBody = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(response.body),
        ) as unknown;
      } catch {
        throw clientError('RESPONSE_JSON_INVALID');
      }
    }
    return {
      status: response.status,
      headers: { ...response.headers },
      body: parsedBody,
    };
  }
}

const DEADLINE_EXCEEDED = Symbol('DEADLINE_EXCEEDED');
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1_024;
const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const MAX_TIMER_MILLISECONDS = 2_147_483_647;

async function withinDeadline<Value>(
  operation: Promise<Value>,
  remainingMilliseconds: number,
): Promise<Value | typeof DEADLINE_EXCEEDED> {
  if (remainingMilliseconds <= 0) return DEADLINE_EXCEEDED;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEADLINE_EXCEEDED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_EXCEEDED), remainingMilliseconds);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isCanonicalRequestUrl(source: string, url: URL): boolean {
  return (
    source.length <= 8_192 &&
    !hasControlCharacter(source) &&
    !source.includes('\\') &&
    url.username === '' &&
    url.password === '' &&
    url.hash === '' &&
    url.hostname.length > 0 &&
    !url.hostname.endsWith('.') &&
    !url.pathname.includes('//') &&
    !/%(?:2e|2f|5c)/iu.test(url.pathname) &&
    `${url.origin}${url.pathname}${url.search}` === source
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function isAllowedMethod(value: unknown): value is SafeWordPressJsonHttpRequest['method'] {
  return value === 'GET' || value === 'POST' || value === 'DELETE';
}

function normalizedRequestHeaders(
  source: Record<string, string>,
  host: string,
  contentLength: number,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) headers[name.toLowerCase()] = value;
  for (const forbidden of [
    'connection',
    'content-length',
    'expect',
    'host',
    'proxy-authorization',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]) {
    delete headers[forbidden];
  }
  headers.host = host;
  headers['content-length'] = String(contentLength);
  return headers;
}

function normalizedResponseHeaders(source: IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'string') headers[name.toLowerCase()] = value;
    else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(', ');
  }
  return headers;
}

function normalizeNetworkAddress(value: string | undefined): string | null {
  if (value === undefined) return null;
  const withoutZone = value.toLowerCase().split('%', 1)[0] ?? '';
  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(withoutZone)?.[1];
  return mappedIpv4 ?? withoutZone;
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isSafeTransportError(error: NodeJS.ErrnoException): boolean {
  return [
    'CONNECTION_ADDRESS_MISMATCH',
    'FETCH_TIMEOUT',
    'REDIRECT_FORBIDDEN',
    'RESPONSE_TOO_LARGE',
    'TRANSPORT_ERROR',
  ].includes(error.message);
}

function isTlsError(error: NodeJS.ErrnoException): boolean {
  const code = error.code ?? '';
  return (
    code.startsWith('ERR_TLS') ||
    code.includes('CERT') ||
    code.includes('SSL') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && String(error.code) === code
  );
}

function safeClientTransportErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return 'TRANSPORT_ERROR';
  }
  const code = String(error.code);
  return [
    'CONNECT_FAILED',
    'CONNECTION_ADDRESS_MISMATCH',
    'FETCH_TIMEOUT',
    'HTTPS_REQUIRED',
    'REDIRECT_FORBIDDEN',
    'RESPONSE_TOO_LARGE',
    'TLS_FAILED',
    'TRANSPORT_ERROR',
    'URL_NOT_CANONICAL',
  ].includes(code)
    ? code
    : 'TRANSPORT_ERROR';
}

function clientError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
