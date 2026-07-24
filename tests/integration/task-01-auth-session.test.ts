import { afterEach, describe, expect, test } from 'vitest';
import type { AuthorizationRequest, ExchangeCodeInput } from '@aeostudio/application/auth';
import {
  HealthEnvelopeSchema,
  ProblemDetailsSchema,
  SessionEnvelopeSchema,
} from '@aeostudio/contracts/auth';

import { createApiApp } from '../../apps/api/src/app.js';

function fakeAuthorizationUrl(input: AuthorizationRequest): string {
  const url = new URL('https://issuer.example/authorize');
  url.searchParams.set('client_id', input.client_id);
  url.searchParams.set('code_challenge', input.code_challenge);
  url.searchParams.set('code_challenge_method', input.code_challenge_method);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('redirect_uri', input.redirect_uri);
  url.searchParams.set('response_type', input.response_type);
  url.searchParams.set('scope', input.scope);
  url.searchParams.set('state', input.state);
  return url.toString();
}

describe('Task 1 secure server session', () => {
  let app: Awaited<ReturnType<typeof createApiApp>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  test('an unauthenticated caller receives a non-disclosing 401 session response', async () => {
    app = await createApiApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
    });

    expect(response.statusCode).toBe(401);
    expect(() => ProblemDetailsSchema.parse(response.json())).not.toThrow();
    expect(response.json()).toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
      retryable: false,
    });
  });

  test('starting login creates a PKCE transaction and redirects to the configured issuer', async () => {
    const authorizationRequests: AuthorizationRequest[] = [];
    const oidcClient = {
      createAuthorizationUrl(input: AuthorizationRequest) {
        authorizationRequests.push(input);
        return fakeAuthorizationUrl(input);
      },
      exchangeCode() {
        return Promise.reject(new Error('exchangeCode is not expected while starting login'));
      },
    };

    app = await createApiApp({
      oidcClient,
      now: () => new Date('2026-07-20T10:00:00.000Z'),
      randomToken: (() => {
        const values = ['login-cookie-token', 'state-token', 'nonce-token', 'pkce-verifier-token'];
        return () => values.shift() ?? 'unexpected-token';
      })(),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/login',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toMatch(/^https:\/\/issuer\.example\/authorize\?/);
    expect(authorizationRequests).toHaveLength(1);
    expect(authorizationRequests[0]).toMatchObject({
      state: 'state-token',
      nonce: 'nonce-token',
      code_challenge_method: 'S256',
    });
    expect(authorizationRequests[0]?.code_challenge).not.toBe('pkce-verifier-token');

    const loginCookie = response.cookies.find((cookie) => cookie.name === '__Host-aeo_login');
    expect(loginCookie).toMatchObject({
      value: 'login-cookie-token',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
    });
  });

  test('the callback consumes the login transaction and rotates it into an opaque session', async () => {
    const exchangeRequests: ExchangeCodeInput[] = [];
    const oidcClient = {
      createAuthorizationUrl(input: AuthorizationRequest) {
        return fakeAuthorizationUrl(input);
      },
      exchangeCode(input: ExchangeCodeInput) {
        exchangeRequests.push(input);
        return Promise.resolve({
          subject: 'oidc-subject-123',
          email: 'owner@example.test',
          emailVerified: true,
        });
      },
    };
    const values = [
      'login-cookie-token',
      'state-token',
      'nonce-token',
      'pkce-verifier-token',
      'opaque-session-token',
    ];

    app = await createApiApp({
      oidcClient,
      now: () => new Date('2026-07-20T10:00:00.000Z'),
      randomToken: () => values.shift() ?? 'unexpected-token',
      webOrigin: 'https://app.example.test',
    });

    const loginResponse = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    const loginCookie = loginResponse.cookies.find((cookie) => cookie.name === '__Host-aeo_login');
    const authorizationUrl = new URL(loginResponse.headers.location ?? '');

    const callbackResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=valid-code&state=${authorizationUrl.searchParams.get('state') ?? ''}`,
      headers: {
        cookie: `__Host-aeo_login=${loginCookie?.value ?? ''}`,
      },
    });

    expect(callbackResponse.statusCode).toBe(302);
    expect(callbackResponse.headers.location).toBe('https://app.example.test/app');
    expect(callbackResponse.body).not.toContain('valid-code');
    expect(exchangeRequests).toEqual([
      {
        code: 'valid-code',
        codeVerifier: 'pkce-verifier-token',
        expectedNonce: 'nonce-token',
        redirectUri: 'http://127.0.0.1:3200/api/v1/auth/callback',
      },
    ]);

    const sessionCookie = callbackResponse.cookies.find(
      (cookie) => cookie.name === '__Host-aeo_session',
    );
    expect(sessionCookie).toMatchObject({
      value: 'opaque-session-token',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
    });
    expect(sessionCookie?.value).not.toBe(loginCookie?.value);

    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: {
        cookie: `__Host-aeo_session=${sessionCookie?.value ?? ''}`,
      },
    });
    expect(sessionResponse.statusCode).toBe(200);
    expect(() => SessionEnvelopeSchema.parse(sessionResponse.json())).not.toThrow();
    expect(sessionResponse.json()).toMatchObject({
      data: {
        email: 'owner@example.test',
      },
      meta: {
        schemaVersion: '1.0.0',
      },
    });
    expect(sessionResponse.body).not.toContain('oidc-subject-123');
    expect(sessionResponse.body).not.toContain('opaque-session-token');
  });

  test('logout revokes the server session so the previous cookie immediately receives 401', async () => {
    const oidcClient = {
      createAuthorizationUrl(input: AuthorizationRequest) {
        return fakeAuthorizationUrl(input);
      },
      exchangeCode() {
        return Promise.resolve({
          subject: 'oidc-subject-logout',
          email: 'owner@example.test',
          emailVerified: true,
        });
      },
    };
    const values = ['login-token', 'state', 'nonce', 'verifier', 'session-to-revoke'];
    app = await createApiApp({
      oidcClient,
      now: () => new Date('2026-07-20T10:00:00.000Z'),
      randomToken: () => values.shift() ?? 'unexpected-token',
      webOrigin: 'https://app.example.test',
    });

    const loginResponse = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    const loginToken = loginResponse.cookies.find(
      (cookie) => cookie.name === '__Host-aeo_login',
    )?.value;
    const state = new URL(loginResponse.headers.location ?? '').searchParams.get('state');
    const callbackResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=valid-code&state=${state ?? ''}`,
      headers: { cookie: `__Host-aeo_login=${loginToken ?? ''}` },
    });
    const sessionToken = callbackResponse.cookies.find(
      (cookie) => cookie.name === '__Host-aeo_session',
    )?.value;

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: `__Host-aeo_session=${sessionToken ?? ''}`,
        origin: 'https://app.example.test',
      },
    });

    expect(logoutResponse.statusCode).toBe(204);
    const clearedCookie = logoutResponse.cookies.find(
      (cookie) => cookie.name === '__Host-aeo_session',
    );
    expect(clearedCookie?.value).toBe('');

    const revokedResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: `__Host-aeo_session=${sessionToken ?? ''}` },
    });
    expect(revokedResponse.statusCode).toBe(401);
    expect(revokedResponse.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  test('the idle TTL slides on activity and revokes a session after 30 inactive minutes', async () => {
    let now = new Date('2026-07-20T10:00:00.000Z');
    const oidcClient = {
      createAuthorizationUrl(input: AuthorizationRequest) {
        return fakeAuthorizationUrl(input);
      },
      exchangeCode() {
        return Promise.resolve({
          subject: 'oidc-subject-idle',
          email: 'owner@example.test',
          emailVerified: true,
        });
      },
    };
    const values = ['login-token', 'state', 'nonce', 'verifier', 'idle-session'];
    app = await createApiApp({
      oidcClient,
      now: () => now,
      randomToken: () => values.shift() ?? 'unexpected-token',
      webOrigin: 'https://app.example.test',
    });
    const loginResponse = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    const loginToken = loginResponse.cookies.find(
      (cookie) => cookie.name === '__Host-aeo_login',
    )?.value;
    const state = new URL(loginResponse.headers.location ?? '').searchParams.get('state');
    const callbackResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=valid-code&state=${state ?? ''}`,
      headers: { cookie: `__Host-aeo_login=${loginToken ?? ''}` },
    });
    const sessionToken = callbackResponse.cookies.find(
      (cookie) => cookie.name === '__Host-aeo_session',
    )?.value;
    const read = () =>
      app?.inject({
        method: 'GET',
        url: '/api/v1/auth/session',
        headers: { cookie: `__Host-aeo_session=${sessionToken ?? ''}` },
      });

    now = new Date('2026-07-20T10:29:00.000Z');
    await expect(read()).resolves.toMatchObject({ statusCode: 200 });
    now = new Date('2026-07-20T10:58:00.000Z');
    await expect(read()).resolves.toMatchObject({ statusCode: 200 });
    now = new Date('2026-07-20T11:28:01.000Z');
    const expired = await read();
    expect(expired?.statusCode).toBe(401);
    expect(expired?.json()).toMatchObject({ code: 'UNAUTHENTICATED' });

    now = new Date('2026-07-20T11:29:00.000Z');
    await expect(read()).resolves.toMatchObject({ statusCode: 401 });
  });

  test('a cross-site logout is rejected without revoking the valid session', async () => {
    const oidcClient = {
      createAuthorizationUrl(input: AuthorizationRequest) {
        return fakeAuthorizationUrl(input);
      },
      exchangeCode() {
        return Promise.resolve({
          subject: 'oidc-subject-csrf',
          email: 'owner@example.test',
          emailVerified: true,
        });
      },
    };
    const values = ['login-token', 'state', 'nonce', 'verifier', 'csrf-safe-session'];
    app = await createApiApp({
      oidcClient,
      now: () => new Date('2026-07-20T10:00:00.000Z'),
      randomToken: () => values.shift() ?? 'unexpected-token',
      webOrigin: 'https://app.example.test',
    });
    const loginResponse = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    const loginToken = loginResponse.cookies.find(
      (cookie) => cookie.name === '__Host-aeo_login',
    )?.value;
    const state = new URL(loginResponse.headers.location ?? '').searchParams.get('state');
    const callbackResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=valid-code&state=${state ?? ''}`,
      headers: { cookie: `__Host-aeo_login=${loginToken ?? ''}` },
    });
    const sessionToken = callbackResponse.cookies.find(
      (cookie) => cookie.name === '__Host-aeo_session',
    )?.value;

    const attackResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: `__Host-aeo_session=${sessionToken ?? ''}`,
        origin: 'https://attacker.example',
      },
    });

    expect(attackResponse.statusCode).toBe(403);
    expect(attackResponse.json()).toMatchObject({ code: 'CSRF_REJECTED' });

    const stillValidResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: `__Host-aeo_session=${sessionToken ?? ''}` },
    });
    expect(stillValidResponse.statusCode).toBe(200);
  });

  test('health stays alive while readiness reports an unavailable dependency', async () => {
    app = await createApiApp({ readiness: () => Promise.resolve(false) });

    const healthResponse = await app.inject({ method: 'GET', url: '/health' });
    const readyResponse = await app.inject({ method: 'GET', url: '/ready' });

    expect(healthResponse.statusCode).toBe(200);
    expect(() => HealthEnvelopeSchema.parse(healthResponse.json())).not.toThrow();
    expect(healthResponse.json()).toMatchObject({ data: { status: 'alive' } });
    expect(readyResponse.statusCode).toBe(503);
    expect(() => ProblemDetailsSchema.parse(readyResponse.json())).not.toThrow();
    expect(readyResponse.json()).toMatchObject({
      status: 503,
      code: 'DEPENDENCY_NOT_READY',
      retryable: true,
    });
  });

  test('production startup refuses to fall back to an ephemeral auth store', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousAuthMode = process.env.AEOSTUDIO_AUTH_MODE;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    let booted: Awaited<ReturnType<typeof createApiApp>> | undefined;
    let startupError: unknown;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.AEOSTUDIO_AUTH_MODE;
      delete process.env.DATABASE_URL;
      try {
        booted = await createApiApp();
      } catch (error) {
        startupError = error;
      }
    } finally {
      await booted?.close();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousAuthMode === undefined) delete process.env.AEOSTUDIO_AUTH_MODE;
      else process.env.AEOSTUDIO_AUTH_MODE = previousAuthMode;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }

    expect(startupError).toBeInstanceOf(Error);
    expect((startupError as Error).message).toContain('DATABASE_URL');
  });
});
