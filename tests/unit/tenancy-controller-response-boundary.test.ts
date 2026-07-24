import type { AuthorizationRequest } from '@aeostudio/application/auth';
import { CreateTenantEnvelopeSchema } from '@aeostudio/contracts/identity-access';
import { afterEach, describe, expect, test } from 'vitest';

import { createApiApp } from '../../apps/api/src/app.js';
import { InMemoryAuthStore } from '../../apps/api/src/auth/auth-store.memory.js';
import { InMemoryTenancyStore } from '../../apps/api/src/tenants/in-memory-tenancy-store.js';

function authorizationUrl(input: AuthorizationRequest): string {
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

describe('Tenant creation response boundary', () => {
  let app: Awaited<ReturnType<typeof createApiApp>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  test('projects the fake runtime Owner membership into the strict public envelope', async () => {
    const oidcClient = {
      createAuthorizationUrl: authorizationUrl,
      exchangeCode() {
        return Promise.resolve({
          subject: 'owner-subject',
          email: 'owner@example.test',
          emailVerified: true,
        });
      },
    };
    const tokens = ['login-token', 'state', 'nonce', 'verifier', 'session-token'];
    app = await createApiApp({
      oidcClient,
      store: new InMemoryAuthStore(),
      tenancyStore: new InMemoryTenancyStore(),
      webOrigin: 'https://app.example.test',
      now: () => new Date('2026-07-24T00:00:00.000Z'),
      randomToken: () => tokens.shift() ?? 'unexpected-token',
    });
    const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    const loginToken = login.cookies.find((cookie) => cookie.name === '__Host-aeo_login')?.value;
    const state = new URL(login.headers.location ?? '').searchParams.get('state');
    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=valid-code&state=${state ?? ''}`,
      headers: { cookie: `__Host-aeo_login=${loginToken ?? ''}` },
    });
    const sessionToken = callback.cookies.find(
      (cookie) => cookie.name === '__Host-aeo_session',
    )?.value;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${sessionToken ?? ''}`,
        origin: 'https://app.example.test',
      },
      payload: {
        tenantName: 'Synthetic Company',
        workspaceName: 'Default Workspace',
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    const body = CreateTenantEnvelopeSchema.parse(response.json());
    expect(body).toMatchObject({
      data: {
        membership: {
          role: 'OWNER',
          status: 'ACTIVE',
        },
      },
    });
    expect(body).not.toHaveProperty('data.membership.email');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants',
      headers: { cookie: `__Host-aeo_session=${sessionToken ?? ''}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      data: {
        workspaces: [
          {
            tenant: { name: 'Synthetic Company' },
            workspace: { name: 'Default Workspace' },
            activeRole: 'OWNER',
          },
        ],
      },
    });
  });
});
