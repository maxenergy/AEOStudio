import { afterEach, describe, expect, test } from 'vitest';
import { ProblemDetailsSchema } from '@aeostudio/contracts/auth';

import { createApiApp } from './app.js';

type ApiTestApp = Awaited<ReturnType<typeof createApiApp>>;

describe('Fastify request ID contract', () => {
  let app: ApiTestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  test('uses one validated x-request-id in header, response body and request telemetry', async () => {
    app = await createApiApp();
    const requestId = '018f84b3-7eb8-7c75-9ca5-25278969d3ef';

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': requestId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe(requestId);
    expect(response.json()).toMatchObject({ meta: { requestId } });
  });

  test('replaces an unsafe x-request-id with one generated UUID everywhere', async () => {
    app = await createApiApp();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'email@example.test?token=secret' },
    });

    const requestId = response.headers['x-request-id'];
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(response.json()).toMatchObject({ meta: { requestId } });
    expect(response.body).not.toContain('email@example.test');
  });

  test('returns redacted RFC problem details with the correlated request ID for unhandled errors', async () => {
    app = await createApiApp({
      readiness: () => Promise.reject(new Error('token=must-not-leak')),
    });
    const requestId = '018f84b3-7eb8-7c75-9ca5-25278969d3ef';

    const response = await app.inject({
      method: 'GET',
      url: '/ready',
      headers: { 'x-request-id': requestId },
    });

    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(ProblemDetailsSchema.parse(response.json())).toEqual({
      type: 'https://aeostudio.example/problems/internal-server-error',
      title: 'Internal Server Error',
      status: 500,
      code: 'INTERNAL_SERVER_ERROR',
      detail: 'The server could not complete the request.',
      requestId,
      retryable: true,
    });
    expect(response.body).not.toContain('must-not-leak');
  });

  test('serves controller-declared rejections as RFC problem details', async () => {
    app = await createApiApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(ProblemDetailsSchema.parse(response.json())).toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
  });

  test('preserves safe framework 400 and 404 statuses without exposing parser details', async () => {
    app = await createApiApp();

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        'content-type': 'application/json',
        origin: 'https://app.example.test',
      },
      payload: '{"secret":"must-not-leak"',
    });
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/not-a-real-route?token=must-not-leak',
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers['content-type']).toContain('application/problem+json');
    expect(ProblemDetailsSchema.parse(malformed.json())).toMatchObject({
      status: 400,
      code: 'BAD_REQUEST',
    });
    expect(malformed.body).not.toContain('must-not-leak');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('application/problem+json');
    expect(ProblemDetailsSchema.parse(missing.json())).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(missing.body).not.toContain('must-not-leak');
  });
});
