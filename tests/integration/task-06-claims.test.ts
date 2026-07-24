import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import type {
  AuthorizationRequest,
  ExchangeCodeInput,
  OidcClient,
} from '@aeostudio/application/auth';
import {
  ClaimCurrentStateEnvelopeSchema,
  ClaimEvidenceDrillDownEnvelopeSchema,
  ClaimReviewEnvelopeSchema,
  EvidenceSnapshotEnvelopeSchema,
} from '@aeostudio/contracts/evidence-claims';
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
    if (input.code === 'claim-reviewer-code') {
      return Promise.resolve({
        subject: 'claim-reviewer-subject',
        email: 'claim-reviewer@example.test',
        emailVerified: true,
      });
    }
    if (input.code === 'claim-owner-b-code') {
      return Promise.resolve({
        subject: 'claim-owner-b-subject',
        email: 'claim-owner-b@example.test',
        emailVerified: true,
      });
    }
    return Promise.resolve({
      subject: 'claim-owner-subject',
      email: 'claim-owner@example.test',
      emailVerified: true,
    });
  },
};

async function signIn(app: ApiTestApp, code = 'claim-owner-code'): Promise<string> {
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
    throw new Error('CLAIM_TEST_LOGIN_FAILED');
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

async function createSource(
  app: ApiTestApp,
  session: string,
  scope: Awaited<ReturnType<typeof createScope>>,
  title: string,
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/evidence-sources`,
    headers: {
      cookie: `__Host-aeo_session=${session}`,
      origin: 'https://app.example.test',
    },
    payload: {
      sourceType: 'UPLOAD',
      title,
      uri: 'https://evidence.example.test/methodology.pdf',
      license: 'CC-BY-4.0',
      publicity: 'PUBLIC',
    },
  });
}

describe('Task 6 evidence-backed Claim ledger', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: ApiTestApp;
  let evidenceObjects: InMemoryEvidenceObjectStore;
  let claimNow = new Date('2026-07-20T06:00:00.000Z');

  beforeEach(() => {
    claimNow = new Date('2026-07-20T06:00:00.000Z');
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
      clock: { now: () => claimNow },
      webOrigin: 'https://app.example.test',
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  test('an Editor-facing API registers an Evidence Source with license and publicity', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Evidence');
    const response = await createSource(app, session, scope, 'Public methodology sheet');

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      data: {
        source: {
          sourceType: 'UPLOAD',
          title: 'Public methodology sheet',
          license: 'CC-BY-4.0',
          publicity: 'PUBLIC',
          currentSnapshotId: null,
        },
      },
      meta: { schemaVersion: '1.0.0' },
    });
  });

  test('an Evidence Source points to an immutable content-addressed snapshot', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Snapshot');
    const sourceResponse = await createSource(app, session, scope, 'Snapshot source');
    const sourceId = sourceResponse.json<{ data: { source: { id: string } } }>().data.source.id;
    const content = Buffer.from('Exact immutable evidence bytes.', 'utf8');
    const contentHash = createHash('sha256').update(content).digest('hex');

    const response = await app.inject({
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

    expect(response.statusCode).toBe(201);
    const body = EvidenceSnapshotEnvelopeSchema.parse(response.json());
    expect(body.data.snapshot).toMatchObject({
      sourceId,
      contentHash,
      contentType: 'text/plain',
      sizeBytes: content.byteLength,
    });
    expect(body.data.snapshot.objectRef).toContain(`/snapshots/${body.data.snapshot.id}/`);
    expect(body.data.snapshot).toHaveProperty('objectVersionId');
    expect(body.data.source.id).toBe(sourceId);
    expect(body.data.source.currentSnapshotId).toBe(body.data.snapshot.id);
  });

  test('a Claim cannot enter review when its exact immutable object no longer exists', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Missing Object');
    const sourceResponse = await createSource(app, session, scope, 'Missing object source');
    const sourceId = sourceResponse.json<{ data: { source: { id: string } } }>().data.source.id;
    const snippet = 'The exact object must still exist before review.';
    const content = Buffer.from(`Evidence body. ${snippet}`, 'utf8');
    const snapshotResponse = await app.inject({
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
    expect(snapshotResponse.statusCode).toBe(201);
    const snapshot = EvidenceSnapshotEnvelopeSchema.parse(snapshotResponse.json()).data.snapshot;
    const claimResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        statement: 'A Claim cannot outlive its exact Evidence object.',
        numericValue: null,
        unit: null,
        scope: 'Exact immutable object validation',
        conditions: ['Object remains readable'],
        expiresAt: '2030-01-01T00:00:00.000Z',
        evidence: [{ snapshotId: snapshot.id, snippet }],
      },
    });
    expect(claimResponse.statusCode).toBe(201);
    const claim = claimResponse.json<{
      data: { claim: { id: string }; revision: { id: string; status: string } };
    }>().data;
    expect(claim.revision.status).toBe('DRAFT');
    expect(
      evidenceObjects.deleteExact({
        objectRef: snapshot.objectRef,
        objectVersionId: snapshot.objectVersionId,
      }),
    ).toBe(true);

    const submitted = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims/${claim.claim.id}/revisions/${claim.revision.id}/submit`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {},
    });

    expect(submitted.statusCode).toBe(409);
    expect(submitted.json()).toMatchObject({ code: 'CLAIM_NEEDS_EVIDENCE' });
  });

  test('a snippet absent from the exact object cannot become reviewable Evidence', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Absent Snippet');
    const sourceResponse = await createSource(app, session, scope, 'Snippet source');
    const sourceId = sourceResponse.json<{ data: { source: { id: string } } }>().data.source.id;
    const content = Buffer.from('The source contains a bounded documented statement.', 'utf8');
    const snapshotResponse = await app.inject({
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
    const snapshot = EvidenceSnapshotEnvelopeSchema.parse(snapshotResponse.json()).data.snapshot;

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        statement: 'A fabricated excerpt must not be reviewable.',
        numericValue: null,
        unit: null,
        scope: 'Exact excerpt validation',
        conditions: ['Exact bytes are authoritative'],
        expiresAt: '2030-01-01T00:00:00.000Z',
        evidence: [
          {
            snapshotId: snapshot.id,
            snippet: 'This sentence does not occur in the exact object.',
          },
        ],
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      data: { revision: { status: 'NEEDS_EVIDENCE', evidence: [{ sourceHash: null }] } },
    });
  });

  test('a Reviewer cannot approve when the exact object disappears after submission', async () => {
    const ownerSession = await signIn(app);
    const scope = await createScope(app, ownerSession, 'Review Object Fence');
    const sourceResponse = await createSource(app, ownerSession, scope, 'Review-fenced source');
    const sourceId = sourceResponse.json<{ data: { source: { id: string } } }>().data.source.id;
    const snippet = 'Approval requires this exact immutable excerpt.';
    const content = Buffer.from(`Recorded methodology. ${snippet}`, 'utf8');
    const snapshotResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/evidence-sources/${sourceId}/snapshots`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        contentBase64: content.toString('base64'),
        contentType: 'text/plain',
      },
    });
    const snapshot = EvidenceSnapshotEnvelopeSchema.parse(snapshotResponse.json()).data.snapshot;
    const claimResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        statement: 'Approval is fenced by a live exact-object verification.',
        numericValue: null,
        unit: null,
        scope: 'Immutable exact-object review',
        conditions: ['Object remains readable'],
        expiresAt: '2030-01-01T00:00:00.000Z',
        evidence: [{ snapshotId: snapshot.id, snippet }],
      },
    });
    const claim = claimResponse.json<{
      data: { claim: { id: string }; revision: { id: string } };
    }>().data;
    const submitted = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims/${claim.claim.id}/revisions/${claim.revision.id}/submit`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {},
    });
    expect(submitted.statusCode).toBe(201);

    const invitation = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/invitations`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { email: 'claim-reviewer@example.test', role: 'REVIEWER' },
    });
    const membershipId = invitation.json<{
      data: { membership: { id: string } };
    }>().data.membership.id;
    const reviewerSession = await signIn(app, 'claim-reviewer-code');
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/memberships/${membershipId}/accept`,
      headers: {
        cookie: `__Host-aeo_session=${reviewerSession}`,
        origin: 'https://app.example.test',
      },
    });
    evidenceObjects.deleteExact({
      objectRef: snapshot.objectRef,
      objectVersionId: snapshot.objectVersionId,
    });

    const approval = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims/${claim.claim.id}/revisions/${claim.revision.id}/reviews`,
      headers: {
        cookie: `__Host-aeo_session=${reviewerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { decision: 'APPROVE', note: 'Must re-read the exact object.' },
    });

    expect(approval.statusCode).toBe(409);
    expect(approval.json()).toMatchObject({ code: 'CLAIM_NEEDS_EVIDENCE' });
  });

  test('a Claim missing exact evidence, scope and expiry remains NEEDS_EVIDENCE', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Incomplete Claim');
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        statement: 'The service reaches the declared outcome under documented conditions.',
        numericValue: null,
        unit: null,
        scope: null,
        conditions: [],
        expiresAt: null,
        evidence: [],
      },
    });

    expect(created.statusCode).toBe(201);
    const claim = created.json<{
      data: { claim: { id: string }; revision: { id: string; status: string } };
    }>().data;
    expect(claim.revision.status).toBe('NEEDS_EVIDENCE');

    const submitted = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims/${claim.claim.id}/revisions/${claim.revision.id}/submit`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {},
    });
    expect(submitted.statusCode).toBe(409);
    expect(submitted.json()).toMatchObject({ code: 'CLAIM_NEEDS_EVIDENCE' });
  });

  test('snippet, scope and expiry are each required for review submission', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Evidence Matrix');
    const sourceResponse = await createSource(app, session, scope, 'Matrix source');
    const sourceId = sourceResponse.json<{ data: { source: { id: string } } }>().data.source.id;
    const exactSnippet = 'Exact supporting excerpt.';
    const sourceBody = Buffer.from(`Method record. ${exactSnippet}`, 'utf8');
    const snapshotResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/evidence-sources/${sourceId}/snapshots`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        contentBase64: sourceBody.toString('base64'),
        contentType: 'text/plain',
      },
    });
    const snapshotId = snapshotResponse.json<{
      data: { snapshot: { id: string } };
    }>().data.snapshot.id;
    const complete = {
      statement: 'A bounded fact backed by an exact source excerpt.',
      numericValue: null,
      unit: null,
      scope: 'Evaluation revision 1',
      conditions: ['Declared method'],
      expiresAt: '2030-01-01T00:00:00.000Z',
      evidence: [{ snapshotId, snippet: exactSnippet }],
    };
    const variants = [
      {
        name: 'snippet',
        payload: { ...complete, evidence: [{ ...complete.evidence[0], snippet: null }] },
      },
      { name: 'scope', payload: { ...complete, scope: null } },
      { name: 'expiry', payload: { ...complete, expiresAt: null } },
    ];

    for (const variant of variants) {
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims`,
        headers: {
          cookie: `__Host-aeo_session=${session}`,
          origin: 'https://app.example.test',
        },
        payload: variant.payload,
      });
      expect(created.statusCode, variant.name).toBe(201);
      const claim = created.json<{
        data: { claim: { id: string }; revision: { id: string; status: string } };
      }>().data;
      expect(claim.revision.status, variant.name).toBe('NEEDS_EVIDENCE');
      const submitted = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims/${claim.claim.id}/revisions/${claim.revision.id}/submit`,
        headers: {
          cookie: `__Host-aeo_session=${session}`,
          origin: 'https://app.example.test',
        },
        payload: {},
      });
      expect(submitted.statusCode, variant.name).toBe(409);
      expect(submitted.json()).toMatchObject({ code: 'CLAIM_NEEDS_EVIDENCE' });
    }
  });

  test('the creator cannot self-approve while a Reviewer approves and drills into exact evidence', async () => {
    const ownerSession = await signIn(app);
    const scope = await createScope(app, ownerSession, 'Review');
    const sourceResponse = await createSource(app, ownerSession, scope, 'Reviewed source');
    const sourceId = sourceResponse.json<{ data: { source: { id: string } } }>().data.source.id;
    const exactSnippet = 'Completion rate: 92%; sample size: 120; protocol revision: 3.';
    const sourceBody = Buffer.from(`Evaluation result. ${exactSnippet}`, 'utf8');
    const snapshotResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/evidence-sources/${sourceId}/snapshots`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        contentBase64: sourceBody.toString('base64'),
        contentType: 'text/plain',
      },
    });
    const snapshot = EvidenceSnapshotEnvelopeSchema.parse(snapshotResponse.json()).data.snapshot;
    const snapshotId = snapshot.id;
    const sourceHash = snapshot.contentHash;
    const claimResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        statement: 'Documented completion rate is 92 percent for the declared evaluation.',
        numericValue: 92,
        unit: 'percent',
        scope: 'Declared evaluation protocol, locale en-SG',
        conditions: ['Sample size 120', 'Protocol revision 3'],
        expiresAt: '2030-01-01T00:00:00.000Z',
        evidence: [
          {
            snapshotId,
            snippet: exactSnippet,
          },
        ],
      },
    });
    expect(claimResponse.statusCode).toBe(201);
    const claim = claimResponse.json<{
      data: {
        claim: { id: string };
        revision: { id: string; contentHash: string; status: string };
      };
    }>().data;
    expect(claim.revision.status).toBe('DRAFT');
    const submitResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims/${claim.claim.id}/revisions/${claim.revision.id}/submit`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {},
    });
    expect(submitResponse.statusCode).toBe(201);
    expect(submitResponse.json()).toMatchObject({ data: { revision: { status: 'IN_REVIEW' } } });

    const selfApproval = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims/${claim.claim.id}/revisions/${claim.revision.id}/reviews`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { decision: 'APPROVE', note: 'Creator must still be denied.' },
    });
    expect(selfApproval.statusCode).toBe(409);
    expect(selfApproval.json()).toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });

    const invitation = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/invitations`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { email: 'claim-reviewer@example.test', role: 'REVIEWER' },
    });
    const membershipId = invitation.json<{
      data: { membership: { id: string } };
    }>().data.membership.id;
    const reviewerSession = await signIn(app, 'claim-reviewer-code');
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/memberships/${membershipId}/accept`,
      headers: {
        cookie: `__Host-aeo_session=${reviewerSession}`,
        origin: 'https://app.example.test',
      },
    });
    expect(accepted.statusCode).toBe(200);

    const approval = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims/${claim.claim.id}/revisions/${claim.revision.id}/reviews`,
      headers: {
        cookie: `__Host-aeo_session=${reviewerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { decision: 'APPROVE', note: 'Exact evidence and scope verified.' },
    });
    expect(approval.statusCode).toBe(200);
    const approvalBody = ClaimReviewEnvelopeSchema.parse(approval.json());
    expect(approvalBody).toMatchObject({
      data: {
        revision: {
          id: claim.revision.id,
          contentHash: claim.revision.contentHash,
          status: 'APPROVED',
        },
      },
    });

    const drillDown = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims/${claim.claim.id}/revisions/${claim.revision.id}/evidence`,
      headers: { cookie: `__Host-aeo_session=${reviewerSession}` },
    });
    expect(drillDown.statusCode).toBe(200);
    const drillDownBody = ClaimEvidenceDrillDownEnvelopeSchema.parse(drillDown.json());
    expect(drillDownBody).toMatchObject({
      data: {
        evidence: [
          {
            snapshot: { id: snapshotId, sourceId, contentHash: sourceHash },
            source: { id: sourceId, license: 'CC-BY-4.0', publicity: 'PUBLIC' },
            link: {
              sourceHash,
              snippet: 'Completion rate: 92%; sample size: 120; protocol revision: 3.',
            },
          },
        ],
      },
    });

    const replacementHash = 'c'.repeat(64);
    const replacementBody = Buffer.from('A replacement source revision.', 'utf8');
    const replacement = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/evidence-sources/${sourceId}/snapshots`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        contentBase64: replacementBody.toString('base64'),
        contentType: 'text/plain',
      },
    });
    expect(replacement.statusCode).toBe(201);
    expect(
      EvidenceSnapshotEnvelopeSchema.parse(replacement.json()).data.snapshot.contentHash,
    ).not.toBe(replacementHash);
    const changedSource = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims/${claim.claim.id}`,
      headers: { cookie: `__Host-aeo_session=${reviewerSession}` },
    });
    expect(changedSource.statusCode).toBe(200);
    const changedSourceBody = ClaimCurrentStateEnvelopeSchema.parse(changedSource.json());
    expect(changedSourceBody).toMatchObject({
      data: {
        revision: { id: claim.revision.id, status: 'STALE' },
        currentUsable: false,
        staleReasons: ['SOURCE_CHANGED'],
        reviewRequired: true,
      },
    });

    claimNow = new Date('2031-01-01T00:00:00.000Z');
    const expired = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/claims/${claim.claim.id}`,
      headers: { cookie: `__Host-aeo_session=${reviewerSession}` },
    });
    expect(expired.statusCode).toBe(200);
    const expiredBody = ClaimCurrentStateEnvelopeSchema.parse(expired.json());
    expect(expiredBody).toMatchObject({
      data: {
        currentUsable: false,
        staleReasons: ['SOURCE_CHANGED', 'EXPIRED'],
        reviewRequired: true,
      },
    });

    const audit = await pool.query<{ action: string; outcome: string; metadata: unknown }>(
      `SELECT action, outcome, metadata
       FROM audit_events
       WHERE tenant_id = $1
         AND action IN (
           'EVIDENCE_SOURCE_CREATED',
           'EVIDENCE_SNAPSHOT_CREATED',
           'CLAIM_REVISION_CREATED',
           'CLAIM_SUBMITTED',
           'CLAIM_APPROVE',
           'CLAIM_REVIEWED'
         )
       ORDER BY occurred_at, action`,
      [scope.tenant.id],
    );
    expect(audit.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'EVIDENCE_SOURCE_CREATED', outcome: 'SUCCEEDED' }),
        expect.objectContaining({ action: 'EVIDENCE_SNAPSHOT_CREATED', outcome: 'SUCCEEDED' }),
        expect.objectContaining({ action: 'CLAIM_REVISION_CREATED', outcome: 'SUCCEEDED' }),
        expect.objectContaining({ action: 'CLAIM_SUBMITTED', outcome: 'SUCCEEDED' }),
        expect.objectContaining({ action: 'CLAIM_APPROVE', outcome: 'DENIED' }),
        expect.objectContaining({ action: 'CLAIM_REVIEWED', outcome: 'SUCCEEDED' }),
      ]),
    );
    const auditSerialization = JSON.stringify(audit.rows);
    expect(auditSerialization).not.toContain(
      'Documented completion rate is 92 percent for the declared evaluation.',
    );
    expect(auditSerialization).not.toContain(
      'Completion rate: 92%; sample size: 120; protocol revision: 3.',
    );
    expect(auditSerialization).not.toContain('Creator must still be denied.');
    expect(auditSerialization).not.toContain('Exact evidence and scope verified.');
    expect(auditSerialization).not.toContain('claim-reviewer@example.test');
  });

  test('Tenant B cannot see Tenant A Claims or attach Tenant A Evidence', async () => {
    const ownerASession = await signIn(app);
    const scopeA = await createScope(app, ownerASession, 'Isolation A');
    const sourceResponse = await createSource(
      app,
      ownerASession,
      scopeA,
      'Tenant A private source',
    );
    const sourceId = sourceResponse.json<{ data: { source: { id: string } } }>().data.source.id;
    const claimResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scopeA.tenant.id}/workspaces/${scopeA.workspace.id}/claims`,
      headers: {
        cookie: `__Host-aeo_session=${ownerASession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        statement: 'Tenant A confidential draft statement.',
        numericValue: null,
        unit: null,
        scope: null,
        conditions: [],
        expiresAt: null,
        evidence: [],
      },
    });
    const claimId = claimResponse.json<{ data: { claim: { id: string } } }>().data.claim.id;

    const ownerBSession = await signIn(app, 'claim-owner-b-code');
    const scopeB = await createScope(app, ownerBSession, 'Isolation B');
    const guessedClaim = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scopeA.tenant.id}/workspaces/${scopeA.workspace.id}/claims/${claimId}`,
      headers: { cookie: `__Host-aeo_session=${ownerBSession}` },
    });
    expect(guessedClaim.statusCode).toBe(404);
    expect(guessedClaim.body).not.toContain('confidential');

    const crossTenantReference = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scopeB.tenant.id}/workspaces/${scopeB.workspace.id}/evidence-sources/${sourceId}/snapshots`,
      headers: {
        cookie: `__Host-aeo_session=${ownerBSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        contentBase64: Buffer.from('Tenant B content.', 'utf8').toString('base64'),
        contentType: 'text/plain',
      },
    });
    expect(crossTenantReference.statusCode).toBe(404);
    expect(crossTenantReference.body).not.toContain('Tenant A private source');
  });
});
