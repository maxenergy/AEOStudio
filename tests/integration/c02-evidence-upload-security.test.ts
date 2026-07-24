import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import type {
  AuthorizationRequest,
  ExchangeCodeInput,
  OidcClient,
} from '@aeostudio/application/auth';
import { EvidenceSnapshotEnvelopeSchema } from '@aeostudio/contracts/evidence-claims';
import {
  AesGcmSessionCipher,
  PostgresAuthStore,
  PostgresEvidenceClaimStore,
  PostgresTenancyStore,
  runMigrations,
} from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { createApiApp } from '../../apps/api/src/app.js';
import { InMemoryEvidenceObjectStore } from '../../apps/api/src/claims/in-memory-evidence-object-store.js';

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
    if (input.code === 'tenant-b-code') {
      return Promise.resolve({
        subject: 'tenant-b-subject',
        email: 'tenant-b@example.test',
        emailVerified: true,
      });
    }
    return Promise.resolve({
      subject: 'c02-owner-subject',
      email: 'c02-owner@example.test',
      emailVerified: true,
    });
  },
};

async function signIn(app: ApiTestApp, code = 'c02-owner-code'): Promise<string> {
  const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
  const loginToken = login.cookies.find((cookie) => cookie.name === '__Host-aeo_login')?.value;
  const state = new URL(login.headers.location ?? '').searchParams.get('state');
  const callback = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/callback?code=${code}&state=${state ?? ''}`,
    headers: { cookie: `__Host-aeo_login=${loginToken ?? ''}` },
  });
  const session = callback.cookies.find((cookie) => cookie.name === '__Host-aeo_session')?.value;
  if (session === undefined) {
    throw new Error('C02_TEST_LOGIN_FAILED');
  }
  return session;
}

async function createScope(app: ApiTestApp, session: string, suffix: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: {
      cookie: `__Host-aeo_session=${session}`,
      origin: 'https://app.example.test',
    },
    payload: { tenantName: `${suffix} Tenant`, workspaceName: `${suffix} Workspace` },
  });
  return response.json<{
    data: { tenant: { id: string }; workspace: { id: string } };
  }>().data;
}

describe('C02 Evidence upload security gate', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: ApiTestApp;
  let evidenceObjects: InMemoryEvidenceObjectStore;
  let c02Now = new Date('2026-07-25T06:00:00.000Z');

  beforeEach(() => {
    c02Now = new Date('2026-07-25T06:00:00.000Z');
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(
      pool,
      fileURLToPath(new URL('../../packages/db/migrations', import.meta.url)),
    );
    evidenceObjects = new InMemoryEvidenceObjectStore();
    app = await createApiApp({
      oidcClient,
      store: new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 6))),
      evidenceClaimStore: new PostgresEvidenceClaimStore(pool),
      evidenceObjectStore: evidenceObjects,
      tenancyStore: new PostgresTenancyStore(pool),
      clock: { now: () => c02Now },
      webOrigin: 'https://app.example.test',
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  test('browser cannot forge objectRef or hash — server computes them from content', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Forge');

    // Create evidence source
    const sourceResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/evidence-sources`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        sourceType: 'UPLOAD',
        title: 'Forge test source',
        uri: 'https://evidence.example.test/forge.pdf',
        license: 'CC-BY-4.0',
        publicity: 'PUBLIC',
      },
    });
    expect(sourceResponse.statusCode).toBe(201);
    const sourceId = sourceResponse.json<{ data: { source: { id: string } } }>().data.source.id;

    const content = Buffer.from('Real evidence content for forge test.', 'utf8');
    const realHash = createHash('sha256').update(content).digest('hex');
    const forgedHash = 'a'.repeat(64); // Attacker-forged hash
    const forgedObjectRef = 's3://attacker-bucket/forged-object';

    // Attempt to send forged hash/objectRef alongside valid contentBase64
    // The API contract only accepts contentBase64 + contentType (strict schema)
    // Any extra fields (contentHash, objectRef) should be rejected by strict validation
    const responseWithForgedFields = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/evidence-sources/${sourceId}/snapshots`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        contentBase64: content.toString('base64'),
        contentType: 'text/plain',
        contentHash: forgedHash,
        objectRef: forgedObjectRef,
      },
    });

    // Strict schema should reject unknown fields
    expect(responseWithForgedFields.statusCode).toBe(400);

    // Valid request without forged fields
    const validResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/evidence-sources/${sourceId}/snapshots`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        contentBase64: content.toString('base64'),
        contentType: 'text/plain',
      },
    });

    expect(validResponse.statusCode).toBe(201);
    const snapshot = EvidenceSnapshotEnvelopeSchema.parse(validResponse.json()).data.snapshot;

    // Server computed the real hash, not the forged one
    expect(snapshot.contentHash).toBe(realHash);
    expect(snapshot.contentHash).not.toBe(forgedHash);
    // Server generated its own objectRef, not the forged one
    expect(snapshot.objectRef).not.toBe(forgedObjectRef);
    expect(snapshot.objectRef).toContain(`/snapshots/${snapshot.id}/`);
  });

  test('cross-tenant snapshot cannot be used in another tenant claim', async () => {
    // Tenant A creates evidence
    const sessionA = await signIn(app);
    const scopeA = await createScope(app, sessionA, 'TenantA');

    const sourceResponseA = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scopeA.tenant.id}/workspaces/${scopeA.workspace.id}/evidence-sources`,
      headers: {
        cookie: `__Host-aeo_session=${sessionA}`,
        origin: 'https://app.example.test',
      },
      payload: {
        sourceType: 'UPLOAD',
        title: 'Tenant A evidence',
        uri: 'https://a.example.test/evidence.pdf',
        license: 'CC-BY-4.0',
        publicity: 'PUBLIC',
      },
    });
    expect(sourceResponseA.statusCode).toBe(201);
    const sourceIdA = sourceResponseA.json<{ data: { source: { id: string } } }>().data.source.id;

    const contentA = Buffer.from('Tenant A confidential evidence snippet.', 'utf8');
    const snapshotResponseA = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scopeA.tenant.id}/workspaces/${scopeA.workspace.id}/evidence-sources/${sourceIdA}/snapshots`,
      headers: {
        cookie: `__Host-aeo_session=${sessionA}`,
        origin: 'https://app.example.test',
      },
      payload: {
        contentBase64: contentA.toString('base64'),
        contentType: 'text/plain',
      },
    });
    expect(snapshotResponseA.statusCode).toBe(201);
    const snapshotA = EvidenceSnapshotEnvelopeSchema.parse(snapshotResponseA.json()).data.snapshot;

    // Tenant B tries to use Tenant A's snapshot in a claim
    const sessionB = await signIn(app, 'tenant-b-code');
    const scopeB = await createScope(app, sessionB, 'TenantB');

    const claimResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scopeB.tenant.id}/workspaces/${scopeB.workspace.id}/claims`,
      headers: {
        cookie: `__Host-aeo_session=${sessionB}`,
        origin: 'https://app.example.test',
      },
      payload: {
        statement: 'Tenant B tries to use Tenant A evidence.',
        numericValue: null,
        unit: null,
        scope: 'Cross-tenant test',
        conditions: ['Should fail'],
        expiresAt: '2030-01-01T00:00:00.000Z',
        evidence: [{ snapshotId: snapshotA.id, snippet: 'confidential evidence' }],
      },
    });

    // Cross-tenant evidence reference must be rejected (NOT_FOUND because RLS isolates)
    expect(claimResponse.statusCode).toBe(404);
  });

  test('cross-tenant snapshot upload completion is rejected', async () => {
    // Tenant A creates a source
    const sessionA = await signIn(app);
    const scopeA = await createScope(app, sessionA, 'UploadA');

    const sourceResponseA = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scopeA.tenant.id}/workspaces/${scopeA.workspace.id}/evidence-sources`,
      headers: {
        cookie: `__Host-aeo_session=${sessionA}`,
        origin: 'https://app.example.test',
      },
      payload: {
        sourceType: 'UPLOAD',
        title: 'Tenant A upload source',
        uri: 'https://a.example.test/upload.pdf',
        license: 'CC-BY-4.0',
        publicity: 'PRIVATE',
      },
    });
    expect(sourceResponseA.statusCode).toBe(201);
    const sourceIdA = sourceResponseA.json<{ data: { source: { id: string } } }>().data.source.id;

    // Tenant B tries to upload a snapshot to Tenant A's source
    const sessionB = await signIn(app, 'tenant-b-code');
    const scopeB = await createScope(app, sessionB, 'UploadB');

    const content = Buffer.from('Cross-tenant upload attempt.', 'utf8');
    const crossTenantUpload = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scopeB.tenant.id}/workspaces/${scopeB.workspace.id}/evidence-sources/${sourceIdA}/snapshots`,
      headers: {
        cookie: `__Host-aeo_session=${sessionB}`,
        origin: 'https://app.example.test',
      },
      payload: {
        contentBase64: content.toString('base64'),
        contentType: 'text/plain',
      },
    });

    // Must be rejected — source belongs to Tenant A
    expect(crossTenantUpload.statusCode).toBe(404);
  });

  test('upload rejects content exceeding size limit', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'SizeLimit');

    const sourceResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/evidence-sources`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        sourceType: 'UPLOAD',
        title: 'Size limit source',
        uri: 'https://example.test/large.pdf',
        license: 'CC-BY-4.0',
        publicity: 'PUBLIC',
      },
    });
    expect(sourceResponse.statusCode).toBe(201);
    const sourceId = sourceResponse.json<{ data: { source: { id: string } } }>().data.source.id;

    // Create content just over 10MB limit
    const oversizedContent = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/evidence-sources/${sourceId}/snapshots`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        contentBase64: oversizedContent.toString('base64'),
        contentType: 'text/plain',
      },
    });

    // Should be rejected due to size limit (413 Payload Too Large or 400 Validation)
    expect([400, 413]).toContain(response.statusCode);
  });

  test('upload rejects invalid content type', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'ContentType');

    const sourceResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/evidence-sources`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        sourceType: 'UPLOAD',
        title: 'Content type source',
        uri: 'https://example.test/doc.pdf',
        license: 'CC-BY-4.0',
        publicity: 'PUBLIC',
      },
    });
    expect(sourceResponse.statusCode).toBe(201);
    const sourceId = sourceResponse.json<{ data: { source: { id: string } } }>().data.source.id;

    const content = Buffer.from('Some content', 'utf8');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/evidence-sources/${sourceId}/snapshots`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        contentBase64: content.toString('base64'),
        contentType: 'not-a-valid-content-type',
      },
    });

    // Invalid content type should be rejected
    expect(response.statusCode).toBe(422);
  });
});
