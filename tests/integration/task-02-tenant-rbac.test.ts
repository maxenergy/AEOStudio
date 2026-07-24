import { fileURLToPath } from 'node:url';

import type {
  AuthorizationRequest,
  ExchangeCodeInput,
  OidcClient,
} from '@aeostudio/application/auth';
import {
  AesGcmSessionCipher,
  PostgresAuthStore,
  PostgresTenancyStore,
  runMigrations,
} from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createApiApp } from '../../apps/api/src/app.js';

type ApiTestApp = Awaited<ReturnType<typeof createApiApp>>;

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

const ownerOidcClient: OidcClient = {
  createAuthorizationUrl: authorizationUrl,
  exchangeCode(input: ExchangeCodeInput) {
    if (input.code === 'future-owner-code') {
      return Promise.resolve({
        subject: 'future-owner-subject',
        email: 'future-owner@example.test',
        emailVerified: true,
      });
    }
    if (input.code === 'editor-code') {
      return Promise.resolve({
        subject: 'editor-subject',
        email: 'editor@example.test',
        emailVerified: true,
      });
    }
    if (input.code === 'owner-b-code') {
      return Promise.resolve({
        subject: 'owner-b-subject',
        email: 'owner-b@example.test',
        emailVerified: true,
      });
    }
    return Promise.resolve({
      subject: 'owner-a-subject',
      email: 'owner-a@example.test',
      emailVerified: true,
    });
  },
};

async function signIn(app: ApiTestApp, code = 'owner-a-code'): Promise<string> {
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

describe('Task 2 Tenant/Workspace isolation and RBAC', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: ApiTestApp;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const migrationsDirectory = fileURLToPath(
      new URL('../../packages/db/migrations', import.meta.url),
    );
    await runMigrations(pool, migrationsDirectory);
    app = await createApiApp({
      oidcClient: ownerOidcClient,
      store: new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 9))),
      tenancyStore: new PostgresTenancyStore(pool),
      webOrigin: 'https://app.example.test',
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  test('a signed-in user creates a Tenant and first Workspace as Owner', async () => {
    const sessionToken = await signIn(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${sessionToken}`,
        origin: 'https://app.example.test',
      },
      payload: {
        tenantName: 'Synthetic Company',
        workspaceName: 'Default Workspace',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      data: {
        tenant: { name: 'Synthetic Company' },
        workspace: { name: 'Default Workspace' },
        membership: { role: 'OWNER', status: 'ACTIVE' },
      },
      meta: { schemaVersion: '1.0.0' },
    });

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants',
      headers: { cookie: `__Host-aeo_session=${sessionToken}` },
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({
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

  test('a Tenant owner can read their Workspace while another Tenant receives opaque 404', async () => {
    const ownerASession = await signIn(app, 'owner-a-code');
    const tenantAResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${ownerASession}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Tenant A', workspaceName: 'Workspace A' },
    });
    const tenantA = tenantAResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;

    const ownerBSession = await signIn(app, 'owner-b-code');
    const tenantBResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${ownerBSession}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Tenant B', workspaceName: 'Workspace B' },
    });
    const tenantB = tenantBResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;

    const ownResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantA.tenant.id}/workspaces/${tenantA.workspace.id}`,
      headers: { cookie: `__Host-aeo_session=${ownerASession}` },
    });
    const crossTenantResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantB.tenant.id}/workspaces/${tenantB.workspace.id}`,
      headers: { cookie: `__Host-aeo_session=${ownerASession}` },
    });

    expect(ownResponse.statusCode).toBe(200);
    expect(ownResponse.json()).toMatchObject({
      data: {
        workspace: { id: tenantA.workspace.id, name: 'Workspace A' },
        activeRole: 'OWNER',
      },
    });
    expect(crossTenantResponse.statusCode).toBe(404);
    expect(crossTenantResponse.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });
    expect(crossTenantResponse.body).not.toContain('Tenant B');
  });

  test('Owner invites an Editor who can accept and read but cannot invite another member', async () => {
    const ownerSession = await signIn(app, 'owner-a-code');
    const tenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Invite Tenant', workspaceName: 'Invite Workspace' },
    });
    const tenant = tenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;

    const inviteResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenant.tenant.id}/workspaces/${tenant.workspace.id}/invitations`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { email: 'editor@example.test', role: 'EDITOR' },
    });

    expect(inviteResponse.statusCode).toBe(201);
    const invited = inviteResponse.json<{
      data: { membership: { id: string; status: string; role: string } };
    }>().data.membership;
    expect(invited).toMatchObject({ status: 'PENDING', role: 'EDITOR' });

    for (const [role, email] of [
      ['ADMIN', 'admin@example.test'],
      ['REVIEWER', 'reviewer@example.test'],
      ['PUBLISHER', 'publisher@example.test'],
      ['ANALYST', 'analyst@example.test'],
      ['VIEWER', 'viewer@example.test'],
    ] as const) {
      const roleInvite = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${tenant.tenant.id}/workspaces/${tenant.workspace.id}/invitations`,
        headers: {
          cookie: `__Host-aeo_session=${ownerSession}`,
          origin: 'https://app.example.test',
        },
        payload: { email, role },
      });
      expect(roleInvite.statusCode).toBe(201);
      expect(roleInvite.json()).toMatchObject({
        data: { membership: { email, role, status: 'PENDING' } },
      });
    }

    const editorSession = await signIn(app, 'editor-code');
    const acceptResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenant.tenant.id}/workspaces/${tenant.workspace.id}/memberships/${invited.id}/accept`,
      headers: {
        cookie: `__Host-aeo_session=${editorSession}`,
        origin: 'https://app.example.test',
      },
    });
    expect(acceptResponse.statusCode).toBe(200);
    expect(acceptResponse.json()).toMatchObject({
      data: { membership: { id: invited.id, status: 'ACTIVE', role: 'EDITOR' } },
    });

    const workspaceResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenant.tenant.id}/workspaces/${tenant.workspace.id}`,
      headers: { cookie: `__Host-aeo_session=${editorSession}` },
    });
    expect(workspaceResponse.statusCode).toBe(200);
    expect(workspaceResponse.json()).toMatchObject({ data: { activeRole: 'EDITOR' } });

    const forbiddenInvite = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenant.tenant.id}/workspaces/${tenant.workspace.id}/invitations`,
      headers: {
        cookie: `__Host-aeo_session=${editorSession}`,
        origin: 'https://app.example.test',
      },
      payload: { email: 'viewer@example.test', role: 'VIEWER' },
    });
    expect(forbiddenInvite.statusCode).toBe(403);
    expect(forbiddenInvite.json()).toMatchObject({ code: 'FORBIDDEN' });

    const forbiddenRoleChange = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenants/${tenant.tenant.id}/workspaces/${tenant.workspace.id}/memberships/${invited.id}`,
      headers: {
        cookie: `__Host-aeo_session=${editorSession}`,
        origin: 'https://app.example.test',
      },
      payload: { role: 'VIEWER' },
    });
    expect(forbiddenRoleChange.statusCode).toBe(403);
    expect(forbiddenRoleChange.json()).toMatchObject({ code: 'FORBIDDEN' });

    const roleChange = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenants/${tenant.tenant.id}/workspaces/${tenant.workspace.id}/memberships/${invited.id}`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { role: 'VIEWER' },
    });
    expect(roleChange.statusCode, roleChange.body).toBe(200);
    expect(roleChange.json()).toMatchObject({
      data: { membership: { id: invited.id, status: 'ACTIVE', role: 'VIEWER' } },
    });

    const viewerWorkspace = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenant.tenant.id}/workspaces/${tenant.workspace.id}`,
      headers: { cookie: `__Host-aeo_session=${editorSession}` },
    });
    expect(viewerWorkspace.statusCode).toBe(200);
    expect(viewerWorkspace.json()).toMatchObject({ data: { activeRole: 'VIEWER' } });

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenants/${tenant.tenant.id}/workspaces/${tenant.workspace.id}/memberships/${invited.id}`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({
      data: { membership: { id: invited.id, status: 'REVOKED', role: 'VIEWER' } },
    });

    const revokedWorkspace = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenant.tenant.id}/workspaces/${tenant.workspace.id}`,
      headers: { cookie: `__Host-aeo_session=${editorSession}` },
    });
    expect(revokedWorkspace.statusCode).toBe(404);
    expect(revokedWorkspace.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });

    const audit = await pool.query<{ action: string; outcome: string }>(
      `SELECT action, outcome
       FROM audit_events
       WHERE tenant_id = $1 AND resource_type = 'MEMBERSHIP'
       ORDER BY occurred_at, action`,
      [tenant.tenant.id],
    );
    expect(audit.rows).toEqual(
      expect.arrayContaining([
        { action: 'MEMBERSHIP_INVITED', outcome: 'SUCCEEDED' },
        { action: 'MEMBERSHIP_ACCEPTED', outcome: 'SUCCEEDED' },
        { action: 'MEMBERSHIP_INVITE', outcome: 'DENIED' },
        { action: 'MEMBERSHIP_ROLE_CHANGE', outcome: 'DENIED' },
        { action: 'MEMBERSHIP_ROLE_CHANGED', outcome: 'SUCCEEDED' },
        { action: 'MEMBERSHIP_REVOKED', outcome: 'SUCCEEDED' },
      ]),
    );
  });

  test('runtime repository context and FORCE RLS prevent direct cross-Tenant reads', async () => {
    const ownerASession = await signIn(app, 'owner-a-code');
    const ownerBSession = await signIn(app, 'owner-b-code');
    const tenantAResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${ownerASession}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'RLS Tenant A', workspaceName: 'RLS Workspace A' },
    });
    const tenantBResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${ownerBSession}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'RLS Tenant B', workspaceName: 'RLS Workspace B' },
    });
    const tenantA = tenantAResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const tenantB = tenantBResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const store = new PostgresTenancyStore(pool);
    const contextA = await store.resolveTenantContext({
      actorSubject: 'owner-a-subject',
      tenantId: tenantA.tenant.id,
      workspaceId: tenantA.workspace.id,
    });
    expect(contextA).not.toBeNull();

    await expect(store.findWorkspaceInContext(undefined, tenantA.workspace.id)).rejects.toThrow(
      'TENANT_CONTEXT_REQUIRED',
    );
    expect(
      await store.findWorkspaceInContext(contextA ?? undefined, tenantB.workspace.id),
    ).toBeNull();

    const rlsTables = await pool.query<{
      table_name: string;
      row_security: boolean;
      force_row_security: boolean;
    }>(
      `SELECT columns.table_name,
              class.relrowsecurity AS row_security,
              class.relforcerowsecurity AS force_row_security
       FROM information_schema.columns AS columns
       JOIN pg_class AS class ON class.relname = columns.table_name
       JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
       WHERE columns.table_schema = 'public'
         AND columns.column_name = 'tenant_id'
         AND namespace.nspname = 'public'
       ORDER BY columns.table_name`,
    );
    expect(rlsTables.rows).toEqual([
      { table_name: 'artifact_claim_links', row_security: true, force_row_security: true },
      { table_name: 'artifact_reviews', row_security: true, force_row_security: true },
      { table_name: 'artifact_revisions', row_security: true, force_row_security: true },
      { table_name: 'artifacts', row_security: true, force_row_security: true },
      { table_name: 'audit_chain_heads', row_security: true, force_row_security: true },
      { table_name: 'audit_digests', row_security: true, force_row_security: true },
      { table_name: 'audit_events', row_security: true, force_row_security: true },
      { table_name: 'baseline_findings', row_security: true, force_row_security: true },
      { table_name: 'break_glass_grants', row_security: true, force_row_security: true },
      { table_name: 'brief_reviews', row_security: true, force_row_security: true },
      { table_name: 'briefs', row_security: true, force_row_security: true },
      { table_name: 'budget_alerts', row_security: true, force_row_security: true },
      { table_name: 'budget_policies', row_security: true, force_row_security: true },
      { table_name: 'budget_reservations', row_security: true, force_row_security: true },
      {
        table_name: 'channel_authorization_validation_commands',
        row_security: true,
        force_row_security: true,
      },
      { table_name: 'channel_authorizations', row_security: true, force_row_security: true },
      { table_name: 'channel_packages', row_security: true, force_row_security: true },
      { table_name: 'claim_evidence_links', row_security: true, force_row_security: true },
      { table_name: 'claim_reviews', row_security: true, force_row_security: true },
      { table_name: 'claim_revisions', row_security: true, force_row_security: true },
      { table_name: 'claims', row_security: true, force_row_security: true },
      { table_name: 'connector_secret_deletions', row_security: true, force_row_security: true },
      { table_name: 'content_plans', row_security: true, force_row_security: true },
      { table_name: 'crawl_runs', row_security: true, force_row_security: true },
      { table_name: 'crawl_snapshots', row_security: true, force_row_security: true },
      { table_name: 'deletion_requests', row_security: true, force_row_security: true },
      { table_name: 'deletion_tombstones', row_security: true, force_row_security: true },
      { table_name: 'evidence_snapshots', row_security: true, force_row_security: true },
      { table_name: 'evidence_sources', row_security: true, force_row_security: true },
      { table_name: 'evidence_tasks', row_security: true, force_row_security: true },
      { table_name: 'experiment_snapshot_links', row_security: true, force_row_security: true },
      { table_name: 'experiments', row_security: true, force_row_security: true },
      { table_name: 'inbox_messages', row_security: true, force_row_security: true },
      { table_name: 'job_events', row_security: true, force_row_security: true },
      { table_name: 'jobs', row_security: true, force_row_security: true },
      {
        table_name: 'legal_hold_object_reconciliations',
        row_security: true,
        force_row_security: true,
      },
      {
        table_name: 'legal_hold_object_versions',
        row_security: true,
        force_row_security: true,
      },
      { table_name: 'legal_holds', row_security: true, force_row_security: true },
      { table_name: 'managed_object_versions', row_security: true, force_row_security: true },
      {
        table_name: 'measurement_manual_import_slots',
        row_security: true,
        force_row_security: true,
      },
      { table_name: 'measurement_manual_imports', row_security: true, force_row_security: true },
      { table_name: 'measurement_provider_policies', row_security: true, force_row_security: true },
      { table_name: 'measurement_runs', row_security: true, force_row_security: true },
      { table_name: 'measurement_scenarios', row_security: true, force_row_security: true },
      { table_name: 'memberships', row_security: true, force_row_security: true },
      { table_name: 'metric_observations', row_security: true, force_row_security: true },
      { table_name: 'metric_snapshots', row_security: true, force_row_security: true },
      {
        table_name: 'offering_attribute_definitions',
        row_security: true,
        force_row_security: true,
      },
      {
        table_name: 'offering_attribute_values',
        row_security: true,
        force_row_security: true,
      },
      { table_name: 'offering_revisions', row_security: true, force_row_security: true },
      { table_name: 'offerings', row_security: true, force_row_security: true },
      { table_name: 'opportunities', row_security: true, force_row_security: true },
      { table_name: 'outbox_messages', row_security: true, force_row_security: true },
      {
        table_name: 'privacy_object_inventory_page_progress',
        row_security: true,
        force_row_security: true,
      },
      {
        table_name: 'privacy_object_inventory_seen_cursors',
        row_security: true,
        force_row_security: true,
      },
      {
        table_name: 'privacy_object_write_intents',
        row_security: true,
        force_row_security: true,
      },
      {
        table_name: 'privacy_object_write_outbox',
        row_security: true,
        force_row_security: true,
      },
      { table_name: 'profile_revisions', row_security: true, force_row_security: true },
      { table_name: 'profiles', row_security: true, force_row_security: true },
      { table_name: 'prompt_approvals', row_security: true, force_row_security: true },
      { table_name: 'prompt_revisions', row_security: true, force_row_security: true },
      { table_name: 'prompt_runs', row_security: true, force_row_security: true },
      { table_name: 'prompt_sets', row_security: true, force_row_security: true },
      { table_name: 'provider_budget_policies', row_security: true, force_row_security: true },
      { table_name: 'publication_attempts', row_security: true, force_row_security: true },
      { table_name: 'publication_records', row_security: true, force_row_security: true },
      { table_name: 'raw_evidence_refs', row_security: true, force_row_security: true },
      { table_name: 'role_bindings', row_security: true, force_row_security: true },
      {
        table_name: 'signed_webhook_endpoint_verifications',
        row_security: true,
        force_row_security: true,
      },
      { table_name: 'site_verifications', row_security: true, force_row_security: true },
      { table_name: 'sites', row_security: true, force_row_security: true },
      { table_name: 'tenant_budget_policies', row_security: true, force_row_security: true },
      {
        table_name: 'tenant_data_authenticated_object_read_sources',
        row_security: true,
        force_row_security: true,
      },
      {
        table_name: 'tenant_data_capabilities',
        row_security: true,
        force_row_security: true,
      },
      {
        table_name: 'tenant_data_channel_package_object_bindings',
        row_security: true,
        force_row_security: true,
      },
      { table_name: 'tenant_export_items', row_security: true, force_row_security: true },
      { table_name: 'tenant_exports', row_security: true, force_row_security: true },
      {
        table_name: 'tenant_owner_budget_alert_recipients',
        row_security: true,
        force_row_security: true,
      },
      {
        table_name: 'tenant_owner_budget_alerts',
        row_security: true,
        force_row_security: true,
      },
      { table_name: 'tenants', row_security: true, force_row_security: true },
      { table_name: 'usage_ledger', row_security: true, force_row_security: true },
      {
        table_name: 'workload_object_write_intents',
        row_security: true,
        force_row_security: true,
      },
      {
        table_name: 'workload_object_write_outbox',
        row_security: true,
        force_row_security: true,
      },
      { table_name: 'workspaces', row_security: true, force_row_security: true },
    ]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE aeostudio_runtime');
      const role = await client.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'aeostudio_runtime'",
      );
      expect(role.rows[0]?.rolbypassrls).toBe(false);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA.tenant.id]);
      const crossTenantRows = await client.query<{ count: string }>(
        'SELECT count(*) FROM workspaces WHERE id = $1',
        [tenantB.workspace.id],
      );
      expect(crossTenantRows.rows[0]?.count).toBe('0');
      await client.query('SET LOCAL row_security = off');
      await expect(client.query('SELECT count(*) FROM workspaces')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('an invited identity can create another Tenant before accepting and then access both', async () => {
    const ownerSession = await signIn(app, 'owner-a-code');
    const invitedTenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Inviting Tenant', workspaceName: 'Inviting Workspace' },
    });
    const invitingScope = invitedTenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const invitation = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${invitingScope.tenant.id}/workspaces/${invitingScope.workspace.id}/invitations`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { email: 'future-owner@example.test', role: 'ANALYST' },
    });
    const membershipId = invitation.json<{ data: { membership: { id: string } } }>().data.membership
      .id;

    const invitedSession = await signIn(app, 'future-owner-code');
    const ownTenant = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${invitedSession}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Owned Tenant', workspaceName: 'Owned Workspace' },
    });
    expect(ownTenant.statusCode, ownTenant.body).toBe(201);

    const accept = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${invitingScope.tenant.id}/workspaces/${invitingScope.workspace.id}/memberships/${membershipId}/accept`,
      headers: {
        cookie: `__Host-aeo_session=${invitedSession}`,
        origin: 'https://app.example.test',
      },
    });
    expect(accept.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants',
      headers: { cookie: `__Host-aeo_session=${invitedSession}` },
    });
    expect(list.statusCode).toBe(200);
    const listedWorkspaces = list.json<{
      data: { workspaces: { tenant: { name: string }; activeRole: string }[] };
    }>().data.workspaces;
    expect(listedWorkspaces).toHaveLength(2);
    expect(
      listedWorkspaces.map((entry) => ({
        tenantName: entry.tenant.name,
        activeRole: entry.activeRole,
      })),
    ).toEqual([
      { tenantName: 'Owned Tenant', activeRole: 'OWNER' },
      { tenantName: 'Inviting Tenant', activeRole: 'ANALYST' },
    ]);
  });
});
