import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import {
  SafeCrawlerFetch,
  type CrawlerDnsResolver,
  type CrawlerHttpResponse,
  type CrawlerHttpTransport,
} from './safe-crawler-fetch.js';

export class NodeCrawlerDnsResolver implements CrawlerDnsResolver {
  async resolve(hostname: string): Promise<string[]> {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return [...new Set(records.map((record) => record.address))];
  }
}

/** GET-only transport that connects to a caller-validated IP without a second DNS lookup. */
export class NodeCrawlerHttpTransport implements CrawlerHttpTransport {
  get(input: {
    url: string;
    address: string;
    timeoutMs: number;
    maxBytes: number;
  }): Promise<CrawlerHttpResponse> {
    const url = new URL(input.url);
    if (isIP(input.address) === 0) return Promise.reject(transportError('CONNECT_FAILED'));
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
      return Promise.reject(transportError('RESPONSE_TOO_LARGE'));
    }
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
      return Promise.reject(transportError('FETCH_TIMEOUT'));
    }
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<CrawlerHttpResponse>((resolve, reject) => {
      let settled = false;
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const operation = request(
        {
          protocol: url.protocol,
          hostname: input.address,
          port: url.port === '' ? undefined : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            Host: url.host,
            Accept: 'text/html,application/xhtml+xml,application/xml,text/xml,text/plain',
            'Accept-Encoding': 'identity',
            'User-Agent': 'AEOStudioCrawler/1.0',
          },
          ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
        },
        (response) => {
          const connectedAddress = normalizeRemoteAddress(response.socket?.remoteAddress);
          const declaredLength = Number(response.headers['content-length'] ?? 0);
          if (Number.isFinite(declaredLength) && declaredLength > input.maxBytes) {
            response.destroy(transportError('RESPONSE_TOO_LARGE'));
            return;
          }
          const chunks: Uint8Array[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > input.maxBytes) {
              response.destroy(transportError('RESPONSE_TOO_LARGE'));
              return;
            }
            chunks.push(new Uint8Array(chunk));
          });
          response.once('error', finishReject);
          response.once('end', () => {
            if (settled) return;
            if (connectedAddress === null) {
              finishReject(transportError('CONNECT_FAILED'));
              return;
            }
            settled = true;
            const locationHeader = response.headers.location;
            resolve({
              status: response.statusCode ?? 0,
              contentType:
                typeof response.headers['content-type'] === 'string'
                  ? response.headers['content-type']
                  : null,
              body: new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))),
              location: typeof locationHeader === 'string' ? locationHeader : null,
              connectedAddress,
            });
          });
        },
      );
      operation.setTimeout(input.timeoutMs, () =>
        operation.destroy(transportError('FETCH_TIMEOUT')),
      );
      operation.once('error', (error: NodeJS.ErrnoException) => {
        if (error.message === 'FETCH_TIMEOUT' || error.message === 'RESPONSE_TOO_LARGE') {
          finishReject(error);
          return;
        }
        finishReject(
          transportError(
            error.code !== undefined && error.code.startsWith('ERR_TLS')
              ? 'TLS_FAILED'
              : 'CONNECT_FAILED',
          ),
        );
      });
      operation.end();
    });
  }
}

export function createNodeSafeCrawlerFetch(): SafeCrawlerFetch {
  return new SafeCrawlerFetch(new NodeCrawlerDnsResolver(), new NodeCrawlerHttpTransport());
}

function normalizeRemoteAddress(value: string | undefined): string | null {
  if (value === undefined) return null;
  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(value)?.[1];
  return mappedIpv4 ?? value;
}

function transportError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
