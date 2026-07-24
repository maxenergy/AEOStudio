import { isPublicNetworkAddress } from '../crawler/ip-policy.js';

export interface SignedWebhookDnsResolver {
  resolve(hostname: string): Promise<string[]>;
}

export interface SignedWebhookHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  location: string | null;
  connectedAddress: string;
}

export interface SignedWebhookHttpTransport {
  post(input: {
    url: string;
    address: string;
    headers: Record<string, string>;
    body: Uint8Array;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<SignedWebhookHttpResponse>;
}

export type SafeSignedWebhookPostResult =
  | { outcome: 'SUCCEEDED'; response: SignedWebhookHttpResponse }
  | { outcome: 'SSRF_BLOCKED' | 'TRANSPORT_FAILED'; errorCode: string };

/**
 * POST-only, exact-endpoint transport. Signed requests are never redirected or sent to an address
 * outside the fresh public DNS set.
 */
export class SafeSignedWebhookHttpClient {
  constructor(
    private readonly resolver: SignedWebhookDnsResolver,
    private readonly transport: SignedWebhookHttpTransport,
  ) {}

  async post(input: {
    url: string;
    verifiedUrl: string;
    headers: Record<string, string>;
    body: Uint8Array;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<SafeSignedWebhookPostResult> {
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > MAX_TIMER_MILLISECONDS
    ) {
      return { outcome: 'TRANSPORT_FAILED', errorCode: 'FETCH_TIMEOUT' };
    }
    const deadline = Date.now() + input.timeoutMs;
    let url: URL;
    let verifiedUrl: URL;
    try {
      url = new URL(input.url);
      verifiedUrl = new URL(input.verifiedUrl);
    } catch {
      return { outcome: 'SSRF_BLOCKED', errorCode: 'INVALID_URL' };
    }
    const urlRejection = unsafeUrlReason(url);
    if (urlRejection !== null) return { outcome: 'SSRF_BLOCKED', errorCode: urlRejection };
    if (unsafeUrlReason(verifiedUrl) !== null || url.href !== verifiedUrl.href) {
      return { outcome: 'SSRF_BLOCKED', errorCode: 'ENDPOINT_NOT_VERIFIED' };
    }

    let addresses: string[];
    try {
      const resolution = await withinDeadline(
        this.resolver.resolve(url.hostname),
        deadline - Date.now(),
      );
      if (resolution === DEADLINE_EXCEEDED) {
        return { outcome: 'TRANSPORT_FAILED', errorCode: 'FETCH_TIMEOUT' };
      }
      addresses = resolution;
    } catch {
      return { outcome: 'TRANSPORT_FAILED', errorCode: 'DNS_RESOLUTION_FAILED' };
    }
    if (addresses.length === 0) {
      return { outcome: 'TRANSPORT_FAILED', errorCode: 'DNS_NO_ADDRESS' };
    }
    if (addresses.some((address) => !isPublicNetworkAddress(address))) {
      return { outcome: 'SSRF_BLOCKED', errorCode: 'NON_PUBLIC_ADDRESS' };
    }

    let response: SignedWebhookHttpResponse;
    try {
      const remainingMilliseconds = deadline - Date.now();
      const transported = await withinDeadline(
        this.transport.post({
          url: url.href,
          address: addresses[0]!,
          headers: { ...input.headers },
          body: input.body.slice(),
          timeoutMs: Math.max(1, remainingMilliseconds),
          maxResponseBytes: input.maxResponseBytes,
        }),
        remainingMilliseconds,
      );
      if (transported === DEADLINE_EXCEEDED) {
        return { outcome: 'TRANSPORT_FAILED', errorCode: 'FETCH_TIMEOUT' };
      }
      response = transported;
    } catch (error) {
      return { outcome: 'TRANSPORT_FAILED', errorCode: safeTransportErrorCode(error) };
    }
    if (
      !addresses.includes(response.connectedAddress) ||
      !isPublicNetworkAddress(response.connectedAddress)
    ) {
      return { outcome: 'SSRF_BLOCKED', errorCode: 'CONNECTION_ADDRESS_MISMATCH' };
    }
    if (response.status >= 300 && response.status < 400) {
      return { outcome: 'SSRF_BLOCKED', errorCode: 'REDIRECT_FORBIDDEN' };
    }
    if (response.body.byteLength > input.maxResponseBytes) {
      return { outcome: 'TRANSPORT_FAILED', errorCode: 'RESPONSE_TOO_LARGE' };
    }
    return {
      outcome: 'SUCCEEDED',
      response: {
        ...response,
        headers: { ...response.headers },
        body: response.body.slice(),
      },
    };
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

function unsafeUrlReason(url: URL): string | null {
  if (url.protocol !== 'https:') return 'HTTPS_REQUIRED';
  if (url.username !== '' || url.password !== '') return 'URL_CREDENTIALS_FORBIDDEN';
  if (url.search !== '') return 'URL_QUERY_FORBIDDEN';
  if (url.hash !== '') return 'URL_FRAGMENT_FORBIDDEN';
  if (url.port !== '') return 'URL_PORT_FORBIDDEN';
  return null;
}

function safeTransportErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'TRANSPORT_ERROR';
  const code = String(error.code);
  return [
    'CONNECT_FAILED',
    'DNS_NO_ADDRESS',
    'FETCH_TIMEOUT',
    'REQUEST_TOO_LARGE',
    'REQUEST_RESULT_UNKNOWN',
    'TLS_FAILED',
    'TRANSPORT_ERROR',
  ].includes(code)
    ? code
    : 'TRANSPORT_ERROR';
}
