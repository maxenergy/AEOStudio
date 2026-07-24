import { lookup } from 'node:dns/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import type {
  SignedWebhookDnsResolver,
  SignedWebhookHttpResponse,
  SignedWebhookHttpTransport,
} from './signed-webhook-http-client.js';

export class NodeSignedWebhookDnsResolver implements SignedWebhookDnsResolver {
  async resolve(hostname: string): Promise<string[]> {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return [...new Set(records.map((record) => record.address))];
  }
}

export interface NodeSignedWebhookHttpsTransportOptions {
  maxRequestBytes?: number;
}

const DEFAULT_MAX_REQUEST_BYTES = 8 * 1_024 * 1_024;
const MAX_TIMER_MILLISECONDS = 2_147_483_647;

/** Node HTTPS transport for one caller-validated, pinned signed-webhook address. */
export class NodeSignedWebhookHttpsTransport implements SignedWebhookHttpTransport {
  private readonly maxRequestBytes: number;

  constructor(options: NodeSignedWebhookHttpsTransportOptions = {}) {
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    if (!Number.isSafeInteger(this.maxRequestBytes) || this.maxRequestBytes < 1) {
      throw transportError('REQUEST_LIMIT_INVALID');
    }
  }

  post(input: {
    url: string;
    address: string;
    headers: Record<string, string>;
    body: Uint8Array;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<SignedWebhookHttpResponse> {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return Promise.reject(transportError('HTTPS_REQUIRED'));
    }
    if (url.protocol !== 'https:') {
      return Promise.reject(transportError('HTTPS_REQUIRED'));
    }
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > MAX_TIMER_MILLISECONDS
    ) {
      return Promise.reject(transportError('FETCH_TIMEOUT'));
    }
    if (!Number.isSafeInteger(input.maxResponseBytes) || input.maxResponseBytes < 1) {
      return Promise.reject(transportError('RESPONSE_TOO_LARGE'));
    }
    if (input.body.byteLength > this.maxRequestBytes) {
      return Promise.reject(transportError('REQUEST_TOO_LARGE'));
    }
    const family = isIP(input.address);
    if (family === 0) return Promise.reject(transportError('CONNECT_FAILED'));
    const body = Buffer.from(input.body);
    const headers = normalizedRequestHeaders(input.headers, url.host, body.byteLength);
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all === true) {
        callback(null, [{ address: input.address, family }]);
        return;
      }
      callback(null, input.address, family);
    };

    return new Promise<SignedWebhookHttpResponse>((resolve, reject) => {
      let settled = false;
      let requestFinished = false;
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
            hostname: url.hostname,
            port: url.port === '' ? undefined : Number(url.port),
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            servername: url.hostname,
            lookup: pinnedLookup,
            headers,
            agent: false,
          },
          (response) => {
            const connectedAddress = normalizeRemoteAddress(response.socket.remoteAddress);
            const declaredLength = Number(response.headers['content-length'] ?? 0);
            if (Number.isFinite(declaredLength) && declaredLength > input.maxResponseBytes) {
              const error = transportError('RESPONSE_TOO_LARGE');
              finishReject(error);
              response.destroy(error);
              return;
            }
            const chunks: Buffer[] = [];
            let responseSize = 0;
            response.on('data', (chunk: Buffer) => {
              responseSize += chunk.byteLength;
              if (responseSize > input.maxResponseBytes) {
                response.destroy(transportError('RESPONSE_TOO_LARGE'));
                return;
              }
              chunks.push(Buffer.from(chunk));
            });
            response.once('error', () => finishReject(transportError('REQUEST_RESULT_UNKNOWN')));
            response.once('end', () => {
              if (settled) return;
              if (connectedAddress === null) {
                finishReject(transportError('CONNECT_FAILED'));
                return;
              }
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
        finishReject(transportError('TRANSPORT_ERROR'));
        return;
      }
      deadline.timer = setTimeout(
        () => operation.destroy(transportError('FETCH_TIMEOUT')),
        input.timeoutMs,
      );
      deadline.timer.unref();
      operation.once('finish', () => {
        requestFinished = true;
      });
      operation.once('error', (error: NodeJS.ErrnoException) => {
        if (error.message === 'FETCH_TIMEOUT' || error.message === 'RESPONSE_TOO_LARGE') {
          finishReject(error);
          return;
        }
        if (requestFinished) {
          finishReject(transportError('REQUEST_RESULT_UNKNOWN'));
          return;
        }
        finishReject(transportError(isTlsError(error) ? 'TLS_FAILED' : 'CONNECT_FAILED'));
      });
      operation.end(body);
    });
  }
}

function normalizedRequestHeaders(
  source: Record<string, string>,
  host: string,
  contentLength: number,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) headers[name.toLowerCase()] = value;
  delete headers['transfer-encoding'];
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

function normalizeRemoteAddress(value: string | undefined): string | null {
  if (value === undefined) return null;
  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(value)?.[1];
  return mappedIpv4 ?? value;
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

function transportError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
