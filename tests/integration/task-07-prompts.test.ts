import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import type {
  AuthorizationRequest,
  ExchangeCodeInput,
  OidcClient,
} from '@aeostudio/application/auth';
import {
  PromptBundleEnvelopeSchema,
  PromptRegistryEnvelopeSchema,
} from '@aeostudio/contracts/prompt-research';
import {
  AesGcmSessionCipher,
  PostgresAuthStore,
  PostgresProfileOfferingStore,
  PostgresPromptResearchStore,
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
    if (input.code === 'prompt-analyst-code') {
      return Promise.resolve({
        subject: 'prompt-analyst-subject',
        email: 'prompt-analyst@example.test',
        emailVerified: true,
      });
    }
    if (input.code === 'prompt-owner-b-code') {
      return Promise.resolve({
        subject: 'prompt-owner-b-subject',
        email: 'prompt-owner-b@example.test',
        emailVerified: true,
      });
    }
    return Promise.resolve({
      subject: 'prompt-owner-subject',
      email: 'prompt-owner@example.test',
      emailVerified: true,
    });
  },
};

async function signIn(app: ApiTestApp, code = 'prompt-owner-code'): Promise<string> {
  const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
  const loginToken = login.cookies.find((cookie) => cookie.name === '__Host-aeo_login')?.value;
  const state = new URL(login.headers.location ?? '').searchParams.get('state');
  const callback = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/callback?code=${code}&state=${state ?? ''}`,
    headers: { cookie: `__Host-aeo_login=${loginToken ?? ''}` },
  });
  const session = callback.cookies.find((cookie) => cookie.name === '__Host-aeo_session')?.value;
  if (session === undefined) throw new Error('PROMPT_TEST_LOGIN_FAILED');
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
  expect(response.statusCode).toBe(201);
  return response.json<{
    data: { tenant: { id: string }; workspace: { id: string } };
  }>().data;
}

async function createKnowledge(
  app: ApiTestApp,
  session: string,
  scope: Awaited<ReturnType<typeof createScope>>,
) {
  const headers = {
    cookie: `__Host-aeo_session=${session}`,
    origin: 'https://app.example.test',
  };
  const profileResponse = await app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles`,
    headers,
    payload: {
      displayName: 'Open Learning Guild',
      description: 'A community service offering guided learning sessions.',
      digitalAssets: [{ label: 'Website', url: 'https://learning.example.test' }],
      targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
    },
  });
  expect(profileResponse.statusCode).toBe(201);
  const profile = profileResponse.json<{
    data: { profile: { profileId: string; revision: number } };
  }>().data.profile;
  const offeringResponse = await app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles/${profile.profileId}/offerings`,
    headers,
    payload: {
      kind: 'guided-learning-service',
      name: 'Guided Learning Sessions',
      locale: 'en-SG',
      market: 'SG',
      taxonomy: ['learning', 'community'],
      principle: 'Guided practice and feedback support repeatable learning.',
      specifications: [],
      features: ['Facilitated sessions'],
      usage: ['Choose a session', 'Join the facilitator'],
      applicationScenarios: ['Community learning'],
      compatibility: ['Modern web browser'],
      evidenceHints: ['Attendance records'],
      attributes: [],
    },
  });
  expect(offeringResponse.statusCode).toBe(201);
  const offering = offeringResponse.json<{
    data: { offering: { offeringId: string; revision: number } };
  }>().data.offering;
  return {
    profile: { id: profile.profileId, revision: profile.revision },
    offering: { id: offering.offeringId, revision: offering.revision },
    claimRevisionIds: [] as string[],
  };
}

function scenario(overrides: Record<string, unknown> = {}) {
  return {
    providerKey: 'fixture-provider',
    surfaceKey: 'consumer-answer-sandbox',
    model: 'fixture-search-model',
    modelVersion: '2026-07',
    account: 'workspace-fixture-account',
    acquisitionMethod: 'MANUAL_IMPORT',
    freshSession: true,
    searchEnabled: true,
    parameters: { temperature: 0, language: 'en' },
    repetitions: 3,
    ...overrides,
  };
}

function scopeInput(overrides: Record<string, unknown> = {}) {
  return { market: 'SG', locale: 'en-SG', region: 'Singapore', ...overrides };
}

async function propose(
  app: ApiTestApp,
  session: string,
  scope: Awaited<ReturnType<typeof createScope>>,
  sourceContext: Awaited<ReturnType<typeof createKnowledge>>,
  overrides: Record<string, unknown> = {},
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/prompt-sets/proposals`,
    headers: {
      cookie: `__Host-aeo_session=${session}`,
      origin: 'https://app.example.test',
    },
    payload: {
      title: 'Guided learning discovery questions',
      subject: 'Guided Learning Sessions',
      sourceContext,
      scopes: [scopeInput()],
      scenario: scenario(),
      ...overrides,
    },
  });
}

describe('Task 7 Prompt Set and Measurement Scenario approval', () => {
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
      promptResearchStore: new PostgresPromptResearchStore(pool),
      tenancyStore: new PostgresTenancyStore(pool),
      webOrigin: 'https://app.example.test',
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  test('Registry read model keeps Provider and consumer Surface distinct and data-driven', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Registry');
    await pool.query(
      `INSERT INTO provider_surface_registry
         (id, provider_key, provider_name, surface_key, surface_name, surface_kind,
           acquisition_method, status, unavailable_reason, adapter_version, created_at,
           acquisition_class)
        VALUES ('00000000-0000-7000-8000-000000000703', 'custom-provider', 'Custom Provider',
          'custom-consumer-surface', 'Custom Consumer Surface', 'CONSUMER_SEARCH',
          'OFFICIAL_API', 'AVAILABLE', NULL, 'custom-v1', '2026-07-20T00:00:00Z',
          'SEARCH_DATA_API')`,
    );
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/measurement-registry`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });

    expect(response.statusCode).toBe(200);
    const entries = PromptRegistryEnvelopeSchema.parse(response.json()).data.entries;
    expect(entries.find((entry) => entry.providerKey === 'fixture-provider')).toMatchObject({
      providerKey: 'fixture-provider',
      surfaceKey: 'consumer-answer-sandbox',
      surfaceKind: 'CONSUMER_AI_ANSWER',
      acquisitionMethod: 'MANUAL_IMPORT',
    });
    expect(entries.some((entry) => entry.status === 'UNAVAILABLE')).toBe(true);
    expect(entries.find((entry) => entry.providerKey === 'custom-provider')).toMatchObject({
      surfaceKey: 'custom-consumer-surface',
      acquisitionMethod: 'OFFICIAL_API',
    });
  });

  test('deterministic proposal creates 20 editable Prompts and approves exact Scenario hashes', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Approval');
    const sourceContext = await createKnowledge(app, session, scope);
    const created = await propose(app, session, scope, sourceContext);
    expect(created.statusCode).toBe(201);
    const initial = PromptBundleEnvelopeSchema.parse(created.json()).data;
    expect(initial.revision.prompts).toHaveLength(20);
    expect(new Set(initial.revision.prompts.map((prompt) => prompt.id)).size).toBe(20);
    expect(new Set(initial.revision.prompts.map((prompt) => prompt.text)).size).toBe(20);
    expect(initial.revision.prompts[0]?.persona.length).toBeGreaterThan(0);
    expect(initial.revision.prompts[0]?.journeyStage.length).toBeGreaterThan(0);
    expect(initial.revision.prompts[0]?.queryType.length).toBeGreaterThan(0);
    expect(initial.revision.scopes).toEqual([scopeInput()]);
    expect(initial.scenario).toMatchObject({
      version: 1,
      providerKey: 'fixture-provider',
      surfaceKey: 'consumer-answer-sandbox',
      model: 'fixture-search-model',
      modelVersion: '2026-07',
      account: 'workspace-fixture-account',
      freshSession: true,
      searchEnabled: true,
      parameters: { temperature: 0, language: 'en' },
      repetitions: 3,
    });

    const wrongHashApproval = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/prompt-sets/${initial.promptSet.id}/revisions/${initial.revision.id}/approve`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        expectedPromptHash: '0'.repeat(64),
        expectedScenarioHash: initial.scenario.contentHash,
      },
    });
    expect(wrongHashApproval.statusCode).toBe(409);
    expect(wrongHashApproval.json()).toMatchObject({ code: 'PROMPT_APPROVAL_HASH_MISMATCH' });

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/prompt-sets/${initial.promptSet.id}/revisions/${initial.revision.id}/approve`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        expectedPromptHash: initial.revision.contentHash,
        expectedScenarioHash: initial.scenario.contentHash,
      },
    });
    expect(approved.statusCode).toBe(200);
    expect(PromptBundleEnvelopeSchema.parse(approved.json())).toMatchObject({
      data: {
        revision: { id: initial.revision.id, status: 'APPROVED' },
        approval: {
          promptContentHash: initial.revision.contentHash,
          scenarioContentHash: initial.scenario.contentHash,
        },
      },
    });

    const changedPrompts = initial.revision.prompts.map((prompt, index) =>
      index === 0 ? { ...prompt, text: `${prompt.text} Include accessibility needs.` } : prompt,
    );
    const edited = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/prompt-sets/${initial.promptSet.id}/revisions`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        expectedRevision: 1,
        prompts: changedPrompts,
        scopes: initial.revision.scopes,
        scenario: scenario(),
      },
    });
    expect(edited.statusCode).toBe(201);
    expect(PromptBundleEnvelopeSchema.parse(edited.json())).toMatchObject({
      data: {
        revision: { revision: 2, status: 'DRAFT' },
        approvalCurrent: false,
        previousApprovalStale: true,
      },
    });
    expect(PromptBundleEnvelopeSchema.parse(edited.json()).data.revision.prompts[0]?.id).toBe(
      initial.revision.prompts[0]?.id,
    );

    const current = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/prompt-sets/${initial.promptSet.id}`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(current.statusCode).toBe(200);
    expect(PromptBundleEnvelopeSchema.parse(current.json())).toMatchObject({
      data: {
        revision: { revision: 2, status: 'DRAFT' },
        approvalCurrent: false,
        previousApprovalStale: true,
      },
    });
  });

  test('an invited Analyst can configure and manually approve a Prompt Scenario', async () => {
    const ownerSession = await signIn(app);
    const scope = await createScope(app, ownerSession, 'Analyst');
    const sourceContext = await createKnowledge(app, ownerSession, scope);
    const invitation = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/invitations`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { email: 'prompt-analyst@example.test', role: 'ANALYST' },
    });
    expect(invitation.statusCode).toBe(201);
    const membershipId = invitation.json<{ data: { membership: { id: string } } }>().data.membership
      .id;
    const analystSession = await signIn(app, 'prompt-analyst-code');
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/memberships/${membershipId}/accept`,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
    });
    expect(accepted.statusCode).toBe(200);

    const created = await propose(app, analystSession, scope, sourceContext, {
      title: 'Analyst-managed Scenario',
    });
    expect(created.statusCode).toBe(201);
    const bundle = PromptBundleEnvelopeSchema.parse(created.json()).data;
    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/prompt-sets/${bundle.promptSet.id}/revisions/${bundle.revision.id}/approve`,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        expectedPromptHash: bundle.revision.contentHash,
        expectedScenarioHash: bundle.scenario.contentHash,
      },
    });
    expect(approved.statusCode).toBe(200);
    expect(PromptBundleEnvelopeSchema.parse(approved.json()).data.approvalCurrent).toBe(true);
  });

  test('approval rejects invalid Prompt count, scopes, repetitions and acquisition method', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Validation');
    const sourceContext = await createKnowledge(app, session, scope);
    const variants = [
      { name: 'too few prompts', promptCount: 19, issue: 'PROMPT_COUNT' },
      { name: 'too many prompts', promptCount: 51, issue: 'PROMPT_COUNT' },
      {
        name: 'too many scopes',
        scopes: Array.from({ length: 4 }, () => scopeInput()),
        issue: 'SCOPE_COUNT',
      },
      { name: 'missing market', scopes: [scopeInput({ market: '' })], issue: 'SCOPE_MARKET' },
      { name: 'missing locale', scopes: [scopeInput({ locale: '' })], issue: 'SCOPE_LOCALE' },
      { name: 'missing region', scopes: [scopeInput({ region: '' })], issue: 'SCOPE_REGION' },
      { name: 'too few repetitions', scenario: scenario({ repetitions: 2 }), issue: 'REPETITIONS' },
      {
        name: 'unknown acquisition method',
        scenario: scenario({ acquisitionMethod: 'UNREGISTERED_METHOD' }),
        issue: 'SURFACE_ACQUISITION_METHOD',
      },
    ];

    for (const variant of variants) {
      const created = await propose(app, session, scope, sourceContext, {
        ...(variant.scopes === undefined ? {} : { scopes: variant.scopes }),
        ...(variant.scenario === undefined ? {} : { scenario: variant.scenario }),
        title: `Validation ${variant.name}`,
      });
      expect(created.statusCode, variant.name).toBe(201);
      let bundle = PromptBundleEnvelopeSchema.parse(created.json()).data;
      if (variant.promptCount !== undefined) {
        const edited = await app.inject({
          method: 'POST',
          url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/prompt-sets/${bundle.promptSet.id}/revisions`,
          headers: {
            cookie: `__Host-aeo_session=${session}`,
            origin: 'https://app.example.test',
          },
          payload: {
            expectedRevision: bundle.revision.revision,
            prompts: Array.from({ length: variant.promptCount }, (_, index) => ({
              id: randomUUID(),
              text: `Question ${index + 1}?`,
              persona: `persona-${index % 3}`,
              journeyStage: `stage-${index % 4}`,
              queryType: `query-${index % 5}`,
            })),
            scopes: bundle.revision.scopes,
            scenario: scenario(),
          },
        });
        expect(edited.statusCode, variant.name).toBe(201);
        bundle = PromptBundleEnvelopeSchema.parse(edited.json()).data;
      }
      const approval = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/prompt-sets/${bundle.promptSet.id}/revisions/${bundle.revision.id}/approve`,
        headers: {
          cookie: `__Host-aeo_session=${session}`,
          origin: 'https://app.example.test',
        },
        payload: {
          expectedPromptHash: bundle.revision.contentHash,
          expectedScenarioHash: bundle.scenario.contentHash,
        },
      });
      expect(approval.statusCode, variant.name).toBe(409);
      const problem = approval.json<{ code: string; fieldErrors: { code: string }[] }>();
      expect(problem.code, variant.name).toBe('PROMPT_SCENARIO_NOT_APPROVABLE');
      expect(
        problem.fieldErrors.some((fieldError) => fieldError.code === variant.issue),
        variant.name,
      ).toBe(true);
    }
  });

  test('an unavailable but registered Surface remains approvable and configuration is preserved', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Unavailable');
    const sourceContext = await createKnowledge(app, session, scope);
    const created = await propose(app, session, scope, sourceContext, {
      scenario: scenario({
        providerKey: 'offline-fixture-provider',
        surfaceKey: 'regional-answer-fixture',
        acquisitionMethod: 'AUTHORIZED_BROWSER_SAMPLE',
      }),
    });
    expect(created.statusCode).toBe(201);
    const bundle = PromptBundleEnvelopeSchema.parse(created.json()).data;
    expect(bundle.scenario).toMatchObject({
      registryStatus: 'UNAVAILABLE',
      providerKey: 'offline-fixture-provider',
      surfaceKey: 'regional-answer-fixture',
    });

    const approval = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/prompt-sets/${bundle.promptSet.id}/revisions/${bundle.revision.id}/approve`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        expectedPromptHash: bundle.revision.contentHash,
        expectedScenarioHash: bundle.scenario.contentHash,
      },
    });
    expect(approval.statusCode).toBe(200);
  });

  test('Tenant B cannot use Tenant A Profile/Offering revisions as Prompt sources', async () => {
    const ownerASession = await signIn(app);
    const scopeA = await createScope(app, ownerASession, 'Prompt Isolation A');
    const sourceContextA = await createKnowledge(app, ownerASession, scopeA);
    const ownerBSession = await signIn(app, 'prompt-owner-b-code');
    const scopeB = await createScope(app, ownerBSession, 'Prompt Isolation B');

    const crossTenant = await propose(app, ownerBSession, scopeB, sourceContextA);
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.body).not.toContain('Open Learning Guild');
    expect(crossTenant.body).not.toContain('Guided Learning Sessions');
  });

  test('Prompt and Scenario audit metadata excludes Prompt text, subject and account', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Prompt Audit');
    const sourceContext = await createKnowledge(app, session, scope);
    const created = await propose(app, session, scope, sourceContext, {
      subject: 'Audit-sensitive subject label',
      scenario: scenario({ account: 'sensitive-account-reference' }),
    });
    expect(created.statusCode).toBe(201);
    const bundle = PromptBundleEnvelopeSchema.parse(created.json()).data;
    const approval = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/prompt-sets/${bundle.promptSet.id}/revisions/${bundle.revision.id}/approve`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        expectedPromptHash: bundle.revision.contentHash,
        expectedScenarioHash: bundle.scenario.contentHash,
      },
    });
    expect(approval.statusCode).toBe(200);

    const audit = await pool.query<{ action: string; outcome: string; metadata: unknown }>(
      `SELECT action, outcome, metadata
       FROM audit_events
       WHERE tenant_id = $1
         AND action IN ('PROMPT_SET_PROPOSED', 'PROMPT_SET_APPROVED')
       ORDER BY occurred_at, action`,
      [scope.tenant.id],
    );
    expect(audit.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'PROMPT_SET_PROPOSED', outcome: 'SUCCEEDED' }),
        expect.objectContaining({ action: 'PROMPT_SET_APPROVED', outcome: 'SUCCEEDED' }),
      ]),
    );
    const serialized = JSON.stringify(audit.rows);
    expect(serialized).not.toContain('Audit-sensitive subject label');
    expect(serialized).not.toContain('sensitive-account-reference');
    expect(serialized).not.toContain(bundle.revision.prompts[0]?.text ?? 'UNEXPECTED_PROMPT');
    expect(serialized).not.toContain('prompt-owner@example.test');
  });
});
