import type {
  ShopifyGraphqlRequest,
  ShopifyGraphqlResponse,
  ShopifyGraphqlTransport,
} from './production-shopify-draft-publication-adapter.js';

export interface NodeShopifyGraphqlTransportOptions {
  fetch?: typeof fetch;
  maxRequestBytes?: number;
}

const SHOPIFY_GRAPHQL_URL_PATTERN =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com\/admin\/api\/\d{4}-(?:01|04|07|10)\/graphql\.json$/u;
const DEFAULT_MAX_REQUEST_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMER_MILLISECONDS = 2_147_483_647;
const TRANSPORT_ERROR_MARKER = Symbol('NodeShopifyGraphqlTransportError');

export class NodeShopifyGraphqlTransport implements ShopifyGraphqlTransport {
  private readonly fetchImplementation: typeof fetch;
  private readonly maxRequestBytes: number;

  constructor(options: NodeShopifyGraphqlTransportOptions = {}) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    if (!Number.isSafeInteger(this.maxRequestBytes) || this.maxRequestBytes < 1) {
      throw transportError('REQUEST_LIMIT_INVALID');
    }
  }

  async request(input: ShopifyGraphqlRequest): Promise<ShopifyGraphqlResponse> {
    if (!SHOPIFY_GRAPHQL_URL_PATTERN.test(input.url)) {
      throw transportError('URL_INVALID');
    }
    const maxResponseBytes = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      throw transportError('RESPONSE_LIMIT_INVALID');
    }
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_MILLISECONDS) {
      throw transportError('TIMEOUT_INVALID');
    }
    const headers = normalizeRequestHeaders(input.headers);
    headers.set('content-type', 'application/json');
    const body = encodeJsonBody(input.body);
    if (Buffer.byteLength(body, 'utf8') > this.maxRequestBytes) {
      throw transportError('REQUEST_TOO_LARGE');
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    deadline.unref();
    try {
      const response = await raceWithAbort(
        this.fetchImplementation(input.url, {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
          signal: controller.signal,
        }),
        controller.signal,
      );
      const declaredResponseBytes = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(declaredResponseBytes) && declaredResponseBytes > maxResponseBytes) {
        throw transportError('RESPONSE_TOO_LARGE');
      }

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await readJsonBody(response, maxResponseBytes, controller.signal),
      };
    } catch (error) {
      if (controller.signal.aborted) throw transportError('FETCH_TIMEOUT');
      if (isTransportError(error)) throw error;
      throw transportError('REQUEST_FAILED');
    } finally {
      clearTimeout(deadline);
    }
  }
}

function transportError(code: string): Error & { code: string } {
  const error = Object.assign(new Error(code), { code });
  Object.defineProperty(error, TRANSPORT_ERROR_MARKER, { value: true });
  return error;
}

function isTransportError(value: unknown): value is Error & { code: string } {
  return (
    value instanceof Error &&
    (value as unknown as Record<PropertyKey, unknown>)[TRANSPORT_ERROR_MARKER] === true
  );
}

function normalizeRequestHeaders(source: Record<string, string>): Headers {
  try {
    return new Headers(source);
  } catch {
    throw transportError('REQUEST_INVALID');
  }
}

function encodeJsonBody(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw transportError('REQUEST_INVALID');
    return encoded;
  } catch {
    throw transportError('REQUEST_INVALID');
  }
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(transportError('FETCH_TIMEOUT'));
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : transportError('REQUEST_FAILED'));
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function readJsonBody(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  let rejectAbort: (reason: unknown) => void = () => undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    rejectAbort(transportError('FETCH_TIMEOUT'));
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), abortPromise]);
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw transportError('RESPONSE_TOO_LARGE');
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  const source = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  if (source.length === 0) return null;
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw transportError('RESPONSE_INVALID');
  }
}
