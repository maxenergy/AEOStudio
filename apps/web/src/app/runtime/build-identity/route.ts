import { resolveEcsRuntimeBuildIdentity } from '@aeostudio/adapters';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface WebRuntimeBuildIdentityDependencies {
  environment: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

const SESSION_COOKIE = '__Host-aeo_session';

export async function handleWebRuntimeBuildIdentityRequest(
  request: Request,
  dependencies: WebRuntimeBuildIdentityDependencies,
): Promise<Response> {
  const sessionCookie = exactSessionCookie(request.headers.get('cookie'));
  if (sessionCookie === null) return problem(401, 'UNAUTHENTICATED');

  const fetchRuntime = dependencies.fetch ?? globalThis.fetch;
  let session: Response;
  try {
    session = await fetchRuntime(
      new URL('/api/v1/auth/session', apiInternalOrigin(dependencies.environment)),
      {
        cache: 'no-store',
        headers: { accept: 'application/json', cookie: sessionCookie },
        redirect: 'error',
        signal: AbortSignal.timeout(2_000),
      },
    );
  } catch {
    return problem(503, 'SESSION_VALIDATION_UNAVAILABLE');
  }
  if (!session.ok) return problem(401, 'UNAUTHENTICATED');

  try {
    const identity = await resolveEcsRuntimeBuildIdentity({
      service: 'web',
      environment: dependencies.environment,
      fetch: (url, init) => fetchRuntime(url, init),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    if (identity === null) return problem(503, 'RUNTIME_BUILD_IDENTITY_UNAVAILABLE');
    return Response.json(
      { data: { identity } },
      { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } },
    );
  } catch {
    return problem(503, 'RUNTIME_BUILD_IDENTITY_UNAVAILABLE');
  }
}

export async function GET(request: Request): Promise<Response> {
  return handleWebRuntimeBuildIdentityRequest(request, { environment: process.env });
}

function exactSessionCookie(header: string | null): string | null {
  if (header === null) return null;
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (values.length !== 1 || values[0] === undefined) return null;
  const value = values[0].slice(SESSION_COOKIE.length + 1);
  if (value.length === 0 || /[\s;,]/u.test(value)) return null;
  return `${SESSION_COOKIE}=${value}`;
}

function apiInternalOrigin(environment: Readonly<Record<string, string | undefined>>): string {
  const raw = environment.API_INTERNAL_ORIGIN?.trim() ?? 'http://127.0.0.1:3200';
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error: unknown) {
    throw new Error('API_INTERNAL_ORIGIN_INVALID', { cause: error });
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('API_INTERNAL_ORIGIN_INVALID');
  }
  return url.origin;
}

function problem(status: 401 | 503, code: string): Response {
  return Response.json(
    {
      type: `https://aeostudio.local/problems/${code.toLowerCase().replaceAll('_', '-')}`,
      title: status === 401 ? 'Authentication required' : 'Runtime identity unavailable',
      status,
      code,
      retryable: status === 503,
    },
    {
      status,
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    },
  );
}
