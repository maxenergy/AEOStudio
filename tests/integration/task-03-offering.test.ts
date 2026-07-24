import { fileURLToPath } from 'node:url';

import type {
  AuthorizationRequest,
  ExchangeCodeInput,
  OidcClient,
} from '@aeostudio/application/auth';
import {
  AesGcmSessionCipher,
  PostgresAuthStore,
  PostgresProfileOfferingStore,
  PostgresTenancyStore,
  runMigrations,
} from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createApiApp } from '../../apps/api/src/app.js';

type ApiTestApp = Awaited<ReturnType<typeof createApiApp>>;

const oidcClient: OidcClient = {
  createAuthorizationUrl(input: AuthorizationRequest) {
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
  },
  exchangeCode(input: ExchangeCodeInput) {
    if (input.code === 'editor-code') {
      return Promise.resolve({
        subject: 'neutral-editor-subject',
        email: 'neutral-editor@example.test',
        emailVerified: true,
      });
    }
    if (input.code === 'tenant-b-code') {
      return Promise.resolve({
        subject: 'neutral-owner-b-subject',
        email: 'neutral-owner-b@example.test',
        emailVerified: true,
      });
    }
    if (input.code === 'viewer-code') {
      return Promise.resolve({
        subject: 'neutral-viewer-subject',
        email: 'neutral-viewer@example.test',
        emailVerified: true,
      });
    }
    return Promise.resolve({
      subject: 'neutral-owner-a-subject',
      email: 'neutral-owner-a@example.test',
      emailVerified: true,
    });
  },
};

async function signIn(app: ApiTestApp, code: string): Promise<string> {
  const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
  const loginToken = login.cookies.find((cookie) => cookie.name === '__Host-aeo_login')?.value;
  const state = new URL(login.headers.location ?? '').searchParams.get('state');
  const callback = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/callback?code=${code}&state=${state ?? ''}`,
    headers: { cookie: `__Host-aeo_login=${loginToken ?? ''}` },
  });
  const sessionToken = callback.cookies.find(
    (cookie) => cookie.name === '__Host-aeo_session',
  )?.value;
  if (sessionToken === undefined) {
    throw new Error('TEST_LOGIN_DID_NOT_CREATE_SESSION');
  }
  return sessionToken;
}

describe('Task 3 industry-neutral Profile and Offering onboarding', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: ApiTestApp;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(
      pool,
      fileURLToPath(new URL('../../packages/db/migrations', import.meta.url)),
    );
    app = await createApiApp({
      oidcClient,
      store: new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 7))),
      profileOfferingStore: new PostgresProfileOfferingStore(pool),
      tenancyStore: new PostgresTenancyStore(pool),
      webOrigin: 'https://app.example.test',
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  test('an Editor round-trips arbitrary service attributes through immutable revisions', async () => {
    const ownerSession = await signIn(app, 'owner-code');
    const tenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Northstar Cooperative', workspaceName: 'Learning Services' },
    });
    const scope = tenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const invitation = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/invitations`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { email: 'neutral-editor@example.test', role: 'EDITOR' },
    });
    const membershipId = invitation.json<{ data: { membership: { id: string } } }>().data.membership
      .id;
    const editorSession = await signIn(app, 'editor-code');
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/memberships/${membershipId}/accept`,
      headers: {
        cookie: `__Host-aeo_session=${editorSession}`,
        origin: 'https://app.example.test',
      },
    });

    const profile = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles`,
      headers: {
        cookie: `__Host-aeo_session=${editorSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        displayName: 'Northstar Learning Collective',
        description: 'A community-based language tutoring cooperative.',
        digitalAssets: [{ label: 'Primary site', url: 'https://northstar.example' }],
        targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
      },
    });

    expect(profile.statusCode).toBe(201);
    const createdProfile = profile.json<{
      data: {
        profile: {
          profileId: string;
          revision: number;
          displayName: string;
          contentHash: string;
        };
      };
    }>().data.profile;
    expect(createdProfile).toMatchObject({
      revision: 1,
      displayName: 'Northstar Learning Collective',
    });
    expect(createdProfile.contentHash).toMatch(/^[a-f0-9]{64}$/);
    const profileId = createdProfile.profileId;

    const revisedProfile = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles/${profileId}/revisions`,
      headers: {
        cookie: `__Host-aeo_session=${editorSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        displayName: 'Northstar Learning Collective',
        description: 'A community-owned language tutoring and cultural exchange cooperative.',
        digitalAssets: [{ label: 'Primary site', url: 'https://northstar.example' }],
        targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
      },
    });
    expect(revisedProfile.statusCode).toBe(201);
    expect(revisedProfile.json()).toMatchObject({
      data: { profile: { profileId, revision: 2 } },
    });
    expect(
      revisedProfile.json<{ data: { profile: { contentHash: string } } }>().data.profile
        .contentHash,
    ).not.toBe(createdProfile.contentHash);

    const originalProfile = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles/${profileId}/revisions/1`,
      headers: { cookie: `__Host-aeo_session=${editorSession}` },
    });
    expect(originalProfile.statusCode).toBe(200);
    expect(originalProfile.json()).toMatchObject({
      data: {
        profile: {
          revision: 1,
          description: 'A community-based language tutoring cooperative.',
          contentHash: createdProfile.contentHash,
        },
      },
    });

    const offeringInput = {
      kind: 'community-language-service',
      name: 'Conversation Circle Membership',
      locale: 'en-SG',
      market: 'SG',
      taxonomy: ['language-learning', 'community-service'],
      principle: 'Small peer groups build fluency through guided weekly practice.',
      specifications: [{ name: 'Session length', value: '60', unit: 'minutes' }],
      features: ['Facilitated peer practice', 'Flexible weekly themes'],
      usage: ['Choose a weekly circle', 'Join the guided session'],
      applicationScenarios: ['New residents practicing everyday conversations'],
      compatibility: ['Modern web browser'],
      evidenceHints: ['Facilitator attendance records'],
      attributes: [
        {
          key: 'group_size',
          label: 'Maximum group size',
          valueType: 'number',
          required: true,
          value: 8,
        },
        {
          key: 'session_formats',
          label: 'Session formats',
          valueType: 'string_list',
          required: false,
          value: ['online', 'in-person'],
        },
      ],
    };
    const offering = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles/${profileId}/offerings`,
      headers: {
        cookie: `__Host-aeo_session=${editorSession}`,
        origin: 'https://app.example.test',
      },
      payload: offeringInput,
    });

    expect(offering.statusCode).toBe(201);
    const offeringBody = offering.json<{
      data: {
        offering: {
          offeringId: string;
          revision: number;
          kind: string;
          name: string;
          taxonomy: string[];
          attributes: { key: string; valueType: string; value: unknown }[];
          contentHash: string;
        };
      };
    }>().data.offering;
    expect(offeringBody).toMatchObject({
      revision: 1,
      kind: 'community-language-service',
      name: 'Conversation Circle Membership',
      taxonomy: ['language-learning', 'community-service'],
      attributes: [
        { key: 'group_size', valueType: 'number', value: 8 },
        {
          key: 'session_formats',
          valueType: 'string_list',
          value: ['online', 'in-person'],
        },
      ],
    });
    expect(offeringBody.contentHash).toMatch(/^[a-f0-9]{64}$/);
    const createdOffering = offeringBody;

    const revisedInput = {
      ...offeringInput,
      principle: 'Guided practice plus individual feedback builds conversational confidence.',
      attributes: offeringInput.attributes.map((attribute) =>
        attribute.key === 'group_size' ? { ...attribute, value: 6 } : attribute,
      ),
    };
    const revised = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/offerings/${createdOffering.offeringId}/revisions`,
      headers: {
        cookie: `__Host-aeo_session=${editorSession}`,
        origin: 'https://app.example.test',
      },
      payload: revisedInput,
    });
    expect(revised.statusCode).toBe(201);
    expect(revised.json()).toMatchObject({
      data: {
        offering: {
          revision: 2,
          attributes: [
            { key: 'group_size', value: 6 },
            { key: 'session_formats', value: ['online', 'in-person'] },
          ],
        },
      },
    });
    expect(
      revised.json<{ data: { offering: { contentHash: string } } }>().data.offering.contentHash,
    ).not.toBe(createdOffering.contentHash);

    const original = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/offerings/${createdOffering.offeringId}/revisions/1`,
      headers: { cookie: `__Host-aeo_session=${editorSession}` },
    });
    expect(original.statusCode).toBe(200);
    const originalOffering = original.json<{
      data: {
        offering: {
          revision: number;
          contentHash: string;
          attributes: { key: string; value: unknown }[];
        };
      };
    }>().data.offering;
    expect(originalOffering.revision).toBe(1);
    expect(originalOffering.contentHash).toBe(createdOffering.contentHash);
    expect(originalOffering.attributes[0]).toMatchObject({ key: 'group_size', value: 8 });

    const invalid = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles/${profileId}/offerings`,
      headers: {
        cookie: `__Host-aeo_session=${editorSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        ...offeringInput,
        attributes: [
          {
            key: 'group_size',
            label: 'Maximum group size',
            valueType: 'number',
            required: true,
            value: 'eight',
          },
        ],
      },
    });
    expect(invalid.statusCode).toBe(400);
    const invalidBody = invalid.json<{ code: string; errors: { path: string }[] }>();
    expect(invalidBody.code).toBe('VALIDATION_ERROR');
    expect(invalidBody.errors.map((error) => error.path)).toContain('attributes.0.value');

    const tenantBSession = await signIn(app, 'tenant-b-code');
    const tenantBResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${tenantBSession}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Separate Cooperative', workspaceName: 'Separate Workspace' },
    });
    const scopeB = tenantBResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const crossTenant = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scopeB.tenant.id}/workspaces/${scopeB.workspace.id}/offerings/${createdOffering.offeringId}/revisions/1`,
      headers: { cookie: `__Host-aeo_session=${tenantBSession}` },
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });
    expect(crossTenant.body).not.toContain('Conversation Circle Membership');

    const viewerInvitation = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/invitations`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { email: 'neutral-viewer@example.test', role: 'VIEWER' },
    });
    const viewerMembershipId = viewerInvitation.json<{
      data: { membership: { id: string } };
    }>().data.membership.id;
    const viewerSession = await signIn(app, 'viewer-code');
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/memberships/${viewerMembershipId}/accept`,
      headers: {
        cookie: `__Host-aeo_session=${viewerSession}`,
        origin: 'https://app.example.test',
      },
    });
    const forbiddenWrite = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles`,
      headers: {
        cookie: `__Host-aeo_session=${viewerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        displayName: 'Must not be stored',
        targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
      },
    });
    expect(forbiddenWrite.statusCode).toBe(403);
    expect(forbiddenWrite.json()).toMatchObject({ code: 'FORBIDDEN' });

    const audit = await pool.query<{ action: string; metadata: unknown }>(
      `SELECT action, metadata
       FROM audit_events
       WHERE tenant_id = $1
         AND action IN ('PROFILE_REVISION_CREATED', 'OFFERING_REVISION_CREATED', 'PROFILE_WRITE')
       ORDER BY occurred_at`,
      [scope.tenant.id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      'PROFILE_REVISION_CREATED',
      'PROFILE_REVISION_CREATED',
      'OFFERING_REVISION_CREATED',
      'OFFERING_REVISION_CREATED',
      'PROFILE_WRITE',
    ]);
    const auditSerialization = JSON.stringify(audit.rows);
    expect(auditSerialization).not.toContain('Northstar Learning Collective');
    expect(auditSerialization).not.toContain('group_size');
    expect(auditSerialization).not.toContain('neutral-editor@example.test');
  });
});
