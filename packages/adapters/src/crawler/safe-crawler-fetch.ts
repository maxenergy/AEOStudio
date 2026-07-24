import { isPublicNetworkAddress } from './ip-policy.js';

export interface CrawlerDnsResolver {
  resolve(hostname: string): Promise<string[]>;
}

export interface CrawlerHttpResponse {
  status: number;
  contentType: string | null;
  body: Uint8Array;
  location: string | null;
  connectedAddress: string;
}

export interface CrawlerHttpTransport {
  get(input: {
    url: string;
    address: string;
    timeoutMs: number;
    maxBytes: number;
  }): Promise<CrawlerHttpResponse>;
}

export type SafeCrawlerFetchResult =
  | {
      outcome: 'SUCCEEDED';
      finalUrl: string;
      response: CrawlerHttpResponse;
    }
  | { outcome: 'SSRF_BLOCKED' | 'FETCH_FAILED'; errorCode: string };

export class SafeCrawlerFetch {
  constructor(
    private readonly resolver: CrawlerDnsResolver,
    private readonly transport: CrawlerHttpTransport,
  ) {}

  async fetch(input: {
    url: string;
    allowedHostname: string;
    maxBytes: number;
    timeoutMs: number;
  }): Promise<SafeCrawlerFetchResult> {
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > MAX_TIMER_MILLISECONDS
    ) {
      return { outcome: 'FETCH_FAILED', errorCode: 'FETCH_TIMEOUT' };
    }
    const deadline = Date.now() + input.timeoutMs;
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return { outcome: 'SSRF_BLOCKED', errorCode: 'INVALID_URL' };
    }
    if (url.username !== '' || url.password !== '') {
      return { outcome: 'SSRF_BLOCKED', errorCode: 'URL_CREDENTIALS_FORBIDDEN' };
    }
    const allowedHostname = input.allowedHostname.toLowerCase();
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      if (!['http:', 'https:'].includes(url.protocol)) {
        return { outcome: 'SSRF_BLOCKED', errorCode: 'SCHEME_NOT_ALLOWED' };
      }
      if (url.hostname.toLowerCase() !== allowedHostname) {
        return { outcome: 'SSRF_BLOCKED', errorCode: 'HOST_NOT_ALLOWED' };
      }
      let addresses: string[];
      try {
        const resolution = await withinDeadline(
          this.resolver.resolve(url.hostname),
          deadline - Date.now(),
        );
        if (resolution === DEADLINE_EXCEEDED) {
          return { outcome: 'FETCH_FAILED', errorCode: 'FETCH_TIMEOUT' };
        }
        addresses = resolution;
      } catch {
        return { outcome: 'FETCH_FAILED', errorCode: 'DNS_NO_ADDRESS' };
      }
      if (
        addresses.length > 0 &&
        addresses.some((candidate) => !isPublicNetworkAddress(candidate))
      ) {
        return { outcome: 'SSRF_BLOCKED', errorCode: 'NON_PUBLIC_ADDRESS' };
      }
      const address = addresses[0];
      if (address === undefined) {
        return { outcome: 'FETCH_FAILED', errorCode: 'DNS_NO_ADDRESS' };
      }
      let response: CrawlerHttpResponse;
      try {
        const remainingMilliseconds = deadline - Date.now();
        const transported = await withinDeadline(
          this.transport.get({
            url: url.href,
            address,
            timeoutMs: Math.max(1, remainingMilliseconds),
            maxBytes: input.maxBytes,
          }),
          remainingMilliseconds,
        );
        if (transported === DEADLINE_EXCEEDED) {
          return { outcome: 'FETCH_FAILED', errorCode: 'FETCH_TIMEOUT' };
        }
        response = transported;
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'TRANSPORT_ERROR';
        return {
          outcome: 'FETCH_FAILED',
          errorCode: ['RESPONSE_TOO_LARGE', 'FETCH_TIMEOUT'].includes(code)
            ? code
            : 'TRANSPORT_ERROR',
        };
      }
      if (!addresses.includes(response.connectedAddress)) {
        return { outcome: 'SSRF_BLOCKED', errorCode: 'CONNECTION_ADDRESS_MISMATCH' };
      }
      if (response.status >= 300 && response.status < 400 && response.location !== null) {
        if (redirectCount === 5) {
          return { outcome: 'FETCH_FAILED', errorCode: 'TOO_MANY_REDIRECTS' };
        }
        url = new URL(response.location, url);
        continue;
      }
      return { outcome: 'SUCCEEDED', finalUrl: url.href, response };
    }
    return { outcome: 'FETCH_FAILED', errorCode: 'TOO_MANY_REDIRECTS' };
  }
}

const DEADLINE_EXCEEDED = Symbol('DEADLINE_EXCEEDED');
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
