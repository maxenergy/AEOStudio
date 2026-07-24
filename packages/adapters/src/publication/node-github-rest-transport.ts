import type {
  GitHubRestRequest,
  GitHubRestResponse,
  GitHubRestTransport,
} from './production-github-pull-request-publication-adapter.js';

export interface NodeGitHubRestTransportOptions {
  fetch?: typeof fetch;
  maxRequestBytes?: number;
}

const GITHUB_API_ORIGIN = 'https://api.github.com';
const DEFAULT_MAX_REQUEST_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMER_MILLISECONDS = 2_147_483_647;
const TRANSPORT_ERROR_MARKER = Symbol('NodeGitHubRestTransportError');

export class NodeGitHubRestTransport implements GitHubRestTransport {
  private readonly fetchImplementation: typeof fetch;
  private readonly maxRequestBytes: number;

  constructor(options: NodeGitHubRestTransportOptions = {}) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    if (!Number.isSafeInteger(this.maxRequestBytes) || this.maxRequestBytes < 1) {
      throw transportError('REQUEST_LIMIT_INVALID');
    }
  }

  async request(input: GitHubRestRequest): Promise<GitHubRestResponse> {
    const url = githubRequestUrl(input.path);
    const maxResponseBytes = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      throw transportError('RESPONSE_LIMIT_INVALID');
    }
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_MILLISECONDS) {
      throw transportError('TIMEOUT_INVALID');
    }
    const headers = normalizeRequestHeaders(input.headers);
    const body = encodeJsonBody(input.body);
    if (body !== undefined && Buffer.byteLength(body, 'utf8') > this.maxRequestBytes) {
      throw transportError('REQUEST_TOO_LARGE');
    }
    if (body !== undefined) headers.set('content-type', 'application/json');

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    deadline.unref();
    try {
      const response = await this.fetchImplementation(url, {
        method: input.method,
        headers,
        redirect: 'error',
        signal: controller.signal,
        ...(body === undefined ? {} : { body }),
      });
      const declaredResponseBytes = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(declaredResponseBytes) && declaredResponseBytes > maxResponseBytes) {
        throw transportError('RESPONSE_TOO_LARGE');
      }

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await readJsonBody(response, maxResponseBytes),
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

function githubRequestUrl(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw transportError('PATH_INVALID');
  }
  try {
    const url = new URL(path, GITHUB_API_ORIGIN);
    if (url.origin !== GITHUB_API_ORIGIN) throw transportError('PATH_INVALID');
    return url.toString();
  } catch {
    throw transportError('PATH_INVALID');
  }
}

function normalizeRequestHeaders(source: Record<string, string>): Headers {
  try {
    return new Headers(source);
  } catch {
    throw transportError('REQUEST_INVALID');
  }
}

function encodeJsonBody(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw transportError('REQUEST_INVALID');
    return encoded;
  } catch {
    throw transportError('REQUEST_INVALID');
  }
}

async function readJsonBody(response: Response, maxResponseBytes: number): Promise<unknown> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    byteLength += chunk.value.byteLength;
    if (byteLength > maxResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw transportError('RESPONSE_TOO_LARGE');
    }
    chunks.push(chunk.value);
  }
  const source = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  if (source.length === 0) return null;
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw transportError('RESPONSE_INVALID');
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
