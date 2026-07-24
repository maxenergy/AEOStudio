import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import type { AuthorizationRequest, OidcClient } from '@aeostudio/application/auth';
import { JobWorkerCoordinator, OutboxRelay } from '@aeostudio/application/jobs-budgets';
import { FakeJobQueue } from '@aeostudio/adapters/queue';
import {
  ContentPlanBundleEnvelopeSchema,
  StartContentPlanEnvelopeSchema,
} from '@aeostudio/contracts/content-planning';
import {
  AesGcmSessionCipher,
  PostgresAuthStore,
  PostgresContentPlanningStore,
  PostgresJobBudgetStore,
  PostgresTenancyStore,
  runMigrations,
} from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createApiApp } from '../../apps/api/src/app.js';
import { ContentPlanHandler, ContentPlanJobWorker } from '../../apps/worker/src/index.js';

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
  exchangeCode(input) {
    if (input.code === 'plan-reviewer-code') {
      return Promise.resolve({
        subject: 'plan-reviewer-subject',
        email: 'plan-reviewer@example.test',
        emailVerified: true,
      });
    }
    return Promise.resolve({
      subject: input.code === 'plan-owner-b-code' ? 'plan-owner-b-subject' : 'plan-owner-subject',
      email:
        input.code === 'plan-owner-b-code'
          ? 'plan-owner-b@example.test'
          : 'plan-owner@example.test',
      emailVerified: true,
    });
  },
};

async function signIn(app: ApiTestApp, code = 'plan-owner-code'): Promise<string> {
  const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
  const token = login.cookies.find((cookie) => cookie.name === '__Host-aeo_login')?.value;
  const state = new URL(login.headers.location ?? '').searchParams.get('state');
  const callback = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/callback?code=${code}&state=${state ?? ''}`,
    headers: { cookie: `__Host-aeo_login=${token ?? ''}` },
  });
  const session = callback.cookies.find((cookie) => cookie.name === '__Host-aeo_session')?.value;
  if (session === undefined) throw new Error('PLAN_TEST_LOGIN_FAILED');
  return session;
}

async function createScope(app: ApiTestApp, session: string, suffix: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
    payload: { tenantName: `${suffix} Tenant`, workspaceName: `${suffix} Workspace` },
  });
  return response.json<{
    data: { tenant: { id: string }; workspace: { id: string } };
  }>().data;
}

interface ScopeIds {
  tenant: { id: string };
  workspace: { id: string };
}

async function seedPlanningFixture(
  pool: Pool,
  scope: ScopeIds,
  input: { comparisonEvidence?: boolean; sharedComparisonEvidence?: boolean } = {},
) {
  const client = await pool.connect();
  const now = new Date('2026-07-21T01:00:00.000Z');
  const hash = (character: string) => character.repeat(64);
  const profileId = randomUUID();
  const profileRevisionId = randomUUID();
  const offeringId = randomUUID();
  const offeringRevisionId = randomUUID();
  const primarySourceId = randomUUID();
  const primarySnapshotId = randomUUID();
  const primaryClaimId = randomUUID();
  const primaryClaimRevisionId = randomUUID();
  const comparisonSourceId = randomUUID();
  const comparisonSnapshotId = randomUUID();
  const comparisonClaimId = randomUUID();
  const comparisonClaimRevisionId = randomUUID();
  const promptSetId = randomUUID();
  const promptRevisionId = randomUUID();
  const scenarioId = randomUUID();
  const promptIds = Array.from({ length: 20 }, () => randomUUID());
  const siteId = randomUUID();
  const baselineJobId = randomUUID();
  const baselineId = randomUUID();
  try {
    await client.query('BEGIN');
    const member = await client.query<{ user_id: string }>(
      `SELECT user_id FROM memberships
       WHERE tenant_id = $1 AND status = 'ACTIVE'`,
      [scope.tenant.id],
    );
    const actorUserId = member.rows[0]?.user_id;
    if (actorUserId === undefined) throw new Error('PLANNING_FIXTURE_ACTOR_NOT_FOUND');

    await client.query(
      `INSERT INTO profiles (id, tenant_id, workspace_id, current_revision, created_at)
       VALUES ($1, $2, $3, 1, $4)`,
      [profileId, scope.tenant.id, scope.workspace.id, now],
    );
    await client.query(
      `INSERT INTO profile_revisions
        (id, tenant_id, workspace_id, profile_id, revision, content_hash, content,
          completeness, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, $7::jsonb, $8, $9)`,
      [
        profileRevisionId,
        scope.tenant.id,
        scope.workspace.id,
        profileId,
        hash('1'),
        JSON.stringify({ name: 'Fixture organization', positioning: 'Traceable value' }),
        JSON.stringify({ percent: 100, missingFields: [] }),
        actorUserId,
        now,
      ],
    );
    await client.query(
      `INSERT INTO offerings
        (id, tenant_id, workspace_id, profile_id, current_revision, created_at)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [offeringId, scope.tenant.id, scope.workspace.id, profileId, now],
    );
    await client.query(
      `INSERT INTO offering_revisions
        (id, tenant_id, workspace_id, offering_id, profile_id, revision, content_hash,
          content, completeness, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7::jsonb, $8::jsonb, $9, $10)`,
      [
        offeringRevisionId,
        scope.tenant.id,
        scope.workspace.id,
        offeringId,
        profileId,
        hash('2'),
        JSON.stringify({ name: 'Fixture offering', principles: ['Verifiable operation'] }),
        JSON.stringify({ percent: 100, missingFields: [] }),
        actorUserId,
        now,
      ],
    );

    await client.query(
      `INSERT INTO evidence_sources
        (id, tenant_id, workspace_id, source_type, title, uri, license, publicity,
          current_snapshot_id, created_at)
       VALUES ($1, $2, $3, 'UPLOAD', 'Primary source', NULL, 'Fixture license', 'PRIVATE',
         NULL, $4)`,
      [primarySourceId, scope.tenant.id, scope.workspace.id, now],
    );
    await client.query(
      `INSERT INTO evidence_snapshots
        (id, tenant_id, workspace_id, source_id, content_hash, object_ref, object_version_id,
          content_type, size_bytes, captured_at)
       VALUES ($1, $2, $3, $4, $5, 'fixture://primary', 'fixture-v1', 'text/plain', 128, $6)`,
      [primarySnapshotId, scope.tenant.id, scope.workspace.id, primarySourceId, hash('3'), now],
    );
    await client.query(`UPDATE evidence_sources SET current_snapshot_id = $1 WHERE id = $2`, [
      primarySnapshotId,
      primarySourceId,
    ]);
    await client.query(
      `INSERT INTO claims (id, tenant_id, workspace_id, current_revision, created_at)
       VALUES ($1, $2, $3, 1, $4)`,
      [primaryClaimId, scope.tenant.id, scope.workspace.id, now],
    );
    await client.query(
      `INSERT INTO claim_revisions
        (id, tenant_id, workspace_id, claim_id, revision, statement, conditions,
          content_hash, status, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, 1, 'Primary fixture claim', '{}'::jsonb, $5,
         'APPROVED', $6, $7)`,
      [
        primaryClaimRevisionId,
        scope.tenant.id,
        scope.workspace.id,
        primaryClaimId,
        hash('4'),
        actorUserId,
        now,
      ],
    );
    await client.query(
      `INSERT INTO claim_evidence_links
        (id, tenant_id, workspace_id, claim_revision_id, snapshot_id, source_hash,
          snippet, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'Primary fixture excerpt', $7)`,
      [
        randomUUID(),
        scope.tenant.id,
        scope.workspace.id,
        primaryClaimRevisionId,
        primarySnapshotId,
        hash('3'),
        now,
      ],
    );

    if (input.comparisonEvidence !== false) {
      if (input.sharedComparisonEvidence !== true) {
        await client.query(
          `INSERT INTO evidence_sources
            (id, tenant_id, workspace_id, source_type, title, uri, license, publicity,
              current_snapshot_id, created_at)
           VALUES ($1, $2, $3, 'PUBLIC', 'Independent comparison source',
             'https://evidence.example.test/comparison', 'Fixture public license', 'PUBLIC',
             NULL, $4)`,
          [comparisonSourceId, scope.tenant.id, scope.workspace.id, now],
        );
        await client.query(
          `INSERT INTO evidence_snapshots
            (id, tenant_id, workspace_id, source_id, content_hash, object_ref, object_version_id,
              content_type, size_bytes, captured_at)
           VALUES ($1, $2, $3, $4, $5, 'fixture://comparison', 'fixture-v1', 'text/plain', 128, $6)`,
          [
            comparisonSnapshotId,
            scope.tenant.id,
            scope.workspace.id,
            comparisonSourceId,
            hash('5'),
            now,
          ],
        );
        await client.query(`UPDATE evidence_sources SET current_snapshot_id = $1 WHERE id = $2`, [
          comparisonSnapshotId,
          comparisonSourceId,
        ]);
      }
      await client.query(
        `INSERT INTO claims (id, tenant_id, workspace_id, current_revision, created_at)
         VALUES ($1, $2, $3, 1, $4)`,
        [comparisonClaimId, scope.tenant.id, scope.workspace.id, now],
      );
      await client.query(
        `INSERT INTO claim_revisions
          (id, tenant_id, workspace_id, claim_id, revision, statement, conditions,
            content_hash, status, created_by_user_id, created_at)
         VALUES ($1, $2, $3, $4, 1, 'Independent comparison claim', '{}'::jsonb, $5,
           'APPROVED', $6, $7)`,
        [
          comparisonClaimRevisionId,
          scope.tenant.id,
          scope.workspace.id,
          comparisonClaimId,
          hash('6'),
          actorUserId,
          now,
        ],
      );
      await client.query(
        `INSERT INTO claim_evidence_links
          (id, tenant_id, workspace_id, claim_revision_id, snapshot_id, source_hash,
            snippet, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'Independent comparison excerpt', $7)`,
        [
          randomUUID(),
          scope.tenant.id,
          scope.workspace.id,
          comparisonClaimRevisionId,
          input.sharedComparisonEvidence === true ? primarySnapshotId : comparisonSnapshotId,
          input.sharedComparisonEvidence === true ? hash('3') : hash('5'),
          now,
        ],
      );
    }

    await client.query(
      `INSERT INTO prompt_sets
        (id, tenant_id, workspace_id, current_revision, created_at)
       VALUES ($1, $2, $3, 1, $4)`,
      [promptSetId, scope.tenant.id, scope.workspace.id, now],
    );
    await client.query(
      `INSERT INTO prompt_revisions
        (id, tenant_id, workspace_id, prompt_set_id, revision, title, subject,
          source_context, prompts, scopes, content_hash, status, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, 1, 'Fixture prompt set', 'Fixture subject', $5::jsonb,
         $6::jsonb, $7::jsonb, $8, 'APPROVED', $9, $10)`,
      [
        promptRevisionId,
        scope.tenant.id,
        scope.workspace.id,
        promptSetId,
        JSON.stringify({
          profile: { id: profileId, revision: 1 },
          offering: { id: offeringId, revision: 1 },
          claimRevisionIds: [
            primaryClaimRevisionId,
            ...(input.comparisonEvidence === false ? [] : [comparisonClaimRevisionId]),
          ],
        }),
        JSON.stringify(
          promptIds.map((id, index) => ({
            id,
            text: `Fixture question ${index + 1}?`,
            persona: 'Evidence evaluator',
            journeyStage: 'DISCOVERY',
            queryType: 'EXPLANATORY',
          })),
        ),
        JSON.stringify([{ region: 'GLOBAL', language: 'en', audience: 'GENERAL' }]),
        hash('7'),
        actorUserId,
        now,
      ],
    );
    await client.query(
      `INSERT INTO measurement_scenarios
        (id, tenant_id, workspace_id, prompt_revision_id, version, provider_key,
          surface_key, model, model_version, account_ref, acquisition_method,
          fresh_session, search_enabled, parameters, repetitions, content_hash,
          registry_status, created_at)
       VALUES ($1, $2, $3, $4, 1, 'fixture-provider', 'consumer-answer-sandbox',
         'fixture-model', 'fixture-v1', 'fixture-account', 'MANUAL_IMPORT', true, true,
         '{}'::jsonb, 3, $5, 'AVAILABLE', $6)`,
      [scenarioId, scope.tenant.id, scope.workspace.id, promptRevisionId, hash('8'), now],
    );
    await client.query(
      `INSERT INTO prompt_approvals
        (id, tenant_id, workspace_id, prompt_revision_id, scenario_id, prompt_content_hash,
          scenario_content_hash, approved_by_user_id, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        scope.tenant.id,
        scope.workspace.id,
        promptRevisionId,
        scenarioId,
        hash('7'),
        hash('8'),
        actorUserId,
        now,
      ],
    );

    await client.query(
      `INSERT INTO sites
        (id, tenant_id, workspace_id, profile_id, origin, hostname, status, verified_at,
          created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'VERIFIED', $7, $7)`,
      [
        siteId,
        scope.tenant.id,
        scope.workspace.id,
        profileId,
        `https://${siteId}.example.test`,
        `${siteId}.example.test`,
        now,
      ],
    );
    await client.query(
      `INSERT INTO jobs
        (id, tenant_id, workspace_id, job_type, aggregate_id, status, progress,
          idempotency_key, estimated_units, requested_by_user_id, result, created_at, updated_at)
       VALUES ($1, $2, $3, 'SITE_CRAWL', $4, 'SUCCEEDED', 100, $5, 1, $6,
         '{"baselineStatus":"COMPLETE"}'::jsonb, $7, $7)`,
      [
        baselineJobId,
        scope.tenant.id,
        scope.workspace.id,
        siteId,
        `baseline-${baselineJobId}`,
        actorUserId,
        now,
      ],
    );
    await client.query(
      `INSERT INTO crawl_runs
        (id, tenant_id, workspace_id, site_id, job_id, status, page_count, total_bytes,
          completed_at)
       VALUES ($1, $2, $3, $4, $5, 'COMPLETE', 1, 128, $6)`,
      [baselineId, scope.tenant.id, scope.workspace.id, siteId, baselineJobId, now],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return {
    profile: { id: profileId, revision: 1 },
    offering: { id: offeringId, revision: 1 },
    promptSetId,
    promptRevisionId,
    primaryClaimRevisionIds: [primaryClaimRevisionId],
    comparisonClaimRevisionIds:
      input.comparisonEvidence === false ? [] : [comparisonClaimRevisionId],
    baselineId,
    methodPolicyVersion: 'content-plan-v1' as const,
    idempotencyKey: randomUUID(),
    estimatedUnits: 20,
  };
}

async function setBudget(app: ApiTestApp, session: string, scope: ScopeIds) {
  const response = await app.inject({
    method: 'PUT',
    url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
    headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
    payload: { limitUnits: 1_000 },
  });
  expect(response.statusCode).toBe(200);
}

async function setScopeRole(pool: Pool, scope: ScopeIds, role: 'EDITOR' | 'OWNER') {
  await pool.query(
    `UPDATE role_bindings SET role = $1
     WHERE tenant_id = $2 AND workspace_id = $3`,
    [role, scope.tenant.id, scope.workspace.id],
  );
}

describe('Task 8 evidence-ready Content Plan and Briefs', () => {
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
      store: new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 8))),
      contentPlanningStore: new PostgresContentPlanningStore(pool),
      jobBudgetStore: new PostgresJobBudgetStore(pool),
      tenancyStore: new PostgresTenancyStore(pool),
      webOrigin: 'https://app.example.test',
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  test('an Editor starts a durable deterministic Content Plan job', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Plan Job');
    const fixture = await seedPlanningFixture(pool, scope);
    await setBudget(app, session, scope);
    await setScopeRole(pool, scope, 'EDITOR');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/content-plans`,
      headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
      payload: { ...fixture, estimatedUnits: 1 },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      data: {
        plan: { status: 'PENDING', methodPolicyVersion: 'content-plan-v1' },
        job: {
          jobType: 'CONTENT_PLAN',
          status: 'QUEUED',
          progress: 0,
          estimatedUnits: 4,
        },
      },
    });
  });

  test('a dangling Claim or Prompt reference makes the plan invalid', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Dangling');
    const fixture = await seedPlanningFixture(pool, scope);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/content-plans`,
      headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
      payload: { ...fixture, primaryClaimRevisionIds: [randomUUID()] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'CONTENT_PLAN_INVALID_REFERENCE' });
  });

  test.each([
    {
      name: 'Profile revision',
      mutate: (promptRevisionId: string) =>
        pool.query(
          `UPDATE prompt_revisions
           SET source_context = jsonb_set(source_context, '{profile,id}', to_jsonb($1::text))
           WHERE id = $2`,
          [randomUUID(), promptRevisionId],
        ),
    },
    {
      name: 'Claim revision set',
      mutate: (promptRevisionId: string) =>
        pool.query(
          `UPDATE prompt_revisions
           SET source_context = jsonb_set(source_context, '{claimRevisionIds}', '[]'::jsonb)
           WHERE id = $1`,
          [promptRevisionId],
        ),
    },
  ])(
    'rejects an approved Prompt whose $name source context differs from the Plan inputs',
    async ({ mutate }) => {
      const session = await signIn(app);
      const scope = await createScope(app, session, 'Prompt Lineage Mismatch');
      const fixture = await seedPlanningFixture(pool, scope);
      await setBudget(app, session, scope);
      await mutate(fixture.promptRevisionId);

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/content-plans`,
        headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
        payload: fixture,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'CONTENT_PLAN_INVALID_REFERENCE',
        referenceType: 'PROMPT_SOURCE_CONTEXT',
      });
      const aggregates = await pool.query<{ plan_count: string; job_count: string }>(
        `SELECT
           (SELECT count(*) FROM content_plans
             WHERE tenant_id = $1 AND workspace_id = $2)::text AS plan_count,
           (SELECT count(*) FROM jobs
             WHERE tenant_id = $1 AND workspace_id = $2
               AND job_type = 'CONTENT_PLAN')::text AS job_count`,
        [scope.tenant.id, scope.workspace.id],
      );
      expect(aggregates.rows[0]).toEqual({ plan_count: '0', job_count: '0' });
    },
  );

  test('a reference that becomes dangling during execution invalidates the Plan and fails the job', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Runtime Dangling');
    const fixture = await seedPlanningFixture(pool, scope);
    await setBudget(app, session, scope);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/content-plans`,
      headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
      payload: fixture,
    });
    const started = StartContentPlanEnvelopeSchema.parse(response.json()).data;
    await pool.query(
      `UPDATE content_plans
       SET input_snapshot = jsonb_set(input_snapshot, '{availableClaimRevisionIds}', '[]'::jsonb)
       WHERE id = $1`,
      [started.plan.id],
    );
    const clock = { now: () => new Date('2026-07-21T02:30:00.000Z') };
    const jobStore = new PostgresJobBudgetStore(pool);
    const worker = new ContentPlanJobWorker(
      new JobWorkerCoordinator(jobStore, clock, { next: randomUUID }, 'content-plan-v1'),
      new ContentPlanHandler(new PostgresContentPlanningStore(pool), { next: randomUUID }, clock),
    );
    expect(
      await worker.process({
        messageId: randomUUID(),
        payload: {
          jobId: started.job.id,
          tenantId: scope.tenant.id,
          workspaceId: scope.workspace.id,
          schemaVersion: '1.0.0',
        },
      }),
    ).toMatchObject({ outcome: 'FAILED_TERMINAL', planId: started.plan.id });
    const plan = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/content-plans/${started.plan.id}`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    const invalid = ContentPlanBundleEnvelopeSchema.parse(plan.json()).data;
    expect(invalid.plan.status).toBe('INVALID');
    expect(invalid.briefs).toEqual([]);
    const job = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs/${started.job.id}`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(job.json()).toMatchObject({
      data: {
        job: { status: 'FAILED_TERMINAL', errorCode: 'CONTENT_PLAN_INVALID_REFERENCE' },
      },
    });
  });

  test('Tenant B cannot read Tenant A Content Plans or Brief references', async () => {
    const sessionA = await signIn(app);
    const scopeA = await createScope(app, sessionA, 'Isolated A');
    const fixture = await seedPlanningFixture(pool, scopeA);
    await setBudget(app, sessionA, scopeA);
    const startedResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scopeA.tenant.id}/workspaces/${scopeA.workspace.id}/content-plans`,
      headers: { cookie: `__Host-aeo_session=${sessionA}`, origin: 'https://app.example.test' },
      payload: fixture,
    });
    const started = StartContentPlanEnvelopeSchema.parse(startedResponse.json()).data;
    const sessionB = await signIn(app, 'plan-owner-b-code');
    await createScope(app, sessionB, 'Isolated B');
    const crossTenant = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scopeA.tenant.id}/workspaces/${scopeA.workspace.id}/content-plans/${started.plan.id}`,
      headers: { cookie: `__Host-aeo_session=${sessionB}` },
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });
  });

  test('the durable worker produces deterministic ranked opportunities and three resolvable Briefs', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Deterministic Plan');
    const fixture = await seedPlanningFixture(pool, scope);
    await setBudget(app, session, scope);
    const start = async (idempotencyKey: string) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/content-plans`,
        headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
        payload: { ...fixture, idempotencyKey },
      });
      expect(response.statusCode).toBe(202);
      return StartContentPlanEnvelopeSchema.parse(response.json()).data;
    };
    const first = await start(randomUUID());
    const second = await start(randomUUID());
    const jobStore = new PostgresJobBudgetStore(pool);
    const queue = new FakeJobQueue();
    const clock = { now: () => new Date('2026-07-21T02:00:00.000Z') };
    await new OutboxRelay(jobStore, queue, clock).relay();
    const messages = new Map<string, NonNullable<ReturnType<FakeJobQueue['receive']>>>();
    for (let message = queue.receive(); message !== undefined; message = queue.receive()) {
      messages.set(message.payload.jobId, message);
    }
    const worker = new ContentPlanJobWorker(
      new JobWorkerCoordinator(jobStore, clock, { next: randomUUID }, 'content-plan-v1'),
      new ContentPlanHandler(new PostgresContentPlanningStore(pool), { next: randomUUID }, clock),
    );
    const firstMessage = messages.get(first.job.id);
    const secondMessage = messages.get(second.job.id);
    if (firstMessage === undefined || secondMessage === undefined) {
      throw new Error('CONTENT_PLAN_QUEUE_MESSAGE_MISSING');
    }
    expect(await worker.process(firstMessage)).toMatchObject({ outcome: 'SUCCEEDED' });
    expect(await worker.process(secondMessage)).toMatchObject({ outcome: 'SUCCEEDED' });

    const load = async (planId: string) => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/content-plans/${planId}`,
        headers: { cookie: `__Host-aeo_session=${session}` },
      });
      expect(response.statusCode).toBe(200);
      return ContentPlanBundleEnvelopeSchema.parse(response.json()).data;
    };
    const firstBundle = await load(first.plan.id);
    const secondBundle = await load(second.plan.id);
    expect(firstBundle.plan).toMatchObject({
      status: 'READY',
      methodPolicyVersion: 'content-plan-v1',
    });
    expect(firstBundle.plan.contentHash).toBe(secondBundle.plan.contentHash);
    expect(
      firstBundle.opportunities.map(({ assetKind, priorityScore, rank, rankReason }) => ({
        assetKind,
        priorityScore,
        rank,
        rankReason,
      })),
    ).toEqual(
      secondBundle.opportunities.map(({ assetKind, priorityScore, rank, rankReason }) => ({
        assetKind,
        priorityScore,
        rank,
        rankReason,
      })),
    );
    expect(firstBundle.opportunities.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    expect(firstBundle.briefs.map((brief) => brief.assetKind).sort()).toEqual([
      'COMPARISON',
      'DEFINITION_PRODUCT',
      'TECHNICAL_EVIDENCE',
    ]);
    const snapshot = firstBundle.plan.inputSnapshot;
    for (const brief of firstBundle.briefs) {
      expect(brief.promptIds.every((id) => snapshot.promptIds.includes(id))).toBe(true);
      expect(
        brief.claimRevisionIds.every((id) => snapshot.availableClaimRevisionIds.includes(id)),
      ).toBe(true);
      expect(
        brief.sourceArtifactIds.every((id) => snapshot.availableSourceArtifactIds.includes(id)),
      ).toBe(true);
      expect(brief).toMatchObject({ status: 'REVIEW_REQUIRED', publishReady: false });
    }
    const completedJob = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs/${first.job.id}`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(completedJob.json()).toMatchObject({
      data: { job: { status: 'SUCCEEDED', progress: 100, result: { contentPlanStatus: 'READY' } } },
    });
  });

  test('missing comparison evidence produces an Evidence task instead of a publishable Brief', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Evidence Task');
    const fixture = await seedPlanningFixture(pool, scope, { comparisonEvidence: false });
    await setBudget(app, session, scope);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/content-plans`,
      headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
      payload: fixture,
    });
    expect(response.statusCode).toBe(202);
    const started = StartContentPlanEnvelopeSchema.parse(response.json()).data;
    const clock = { now: () => new Date('2026-07-21T03:00:00.000Z') };
    const jobStore = new PostgresJobBudgetStore(pool);
    const worker = new ContentPlanJobWorker(
      new JobWorkerCoordinator(jobStore, clock, { next: randomUUID }, 'content-plan-v1'),
      new ContentPlanHandler(new PostgresContentPlanningStore(pool), { next: randomUUID }, clock),
    );
    expect(
      await worker.process({
        messageId: randomUUID(),
        payload: {
          jobId: started.job.id,
          tenantId: scope.tenant.id,
          workspaceId: scope.workspace.id,
          schemaVersion: '1.0.0',
        },
      }),
    ).toMatchObject({ outcome: 'SUCCEEDED' });
    const plan = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/content-plans/${started.plan.id}`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    const bundle = ContentPlanBundleEnvelopeSchema.parse(plan.json()).data;
    expect(bundle.plan.status).toBe('READY');
    expect(bundle.opportunities).toContainEqual(
      expect.objectContaining({
        assetKind: 'COMPARISON',
        action: 'EVIDENCE_TASK',
        evidenceReady: false,
        publishReady: false,
      }),
    );
    expect(bundle.briefs.some((brief) => brief.assetKind === 'COMPARISON')).toBe(false);
    expect(bundle.evidenceTasks).toContainEqual(
      expect.objectContaining({
        assetKind: 'COMPARISON',
        reasonCode: 'INDEPENDENT_COMPARISON_EVIDENCE_REQUIRED',
      }),
    );
  });

  test('a comparison Claim backed only by primary evidence remains an Evidence task', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session, 'Independent Evidence');
    const fixture = await seedPlanningFixture(pool, scope, { sharedComparisonEvidence: true });
    await setBudget(app, session, scope);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/content-plans`,
      headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
      payload: fixture,
    });
    const started = StartContentPlanEnvelopeSchema.parse(response.json()).data;
    expect(started.plan.inputSnapshot.comparisonEvidenceIndependent).toBe(false);
    const clock = { now: () => new Date('2026-07-21T03:30:00.000Z') };
    const jobStore = new PostgresJobBudgetStore(pool);
    const worker = new ContentPlanJobWorker(
      new JobWorkerCoordinator(jobStore, clock, { next: randomUUID }, 'content-plan-v1'),
      new ContentPlanHandler(new PostgresContentPlanningStore(pool), { next: randomUUID }, clock),
    );
    await worker.process({
      messageId: randomUUID(),
      payload: {
        jobId: started.job.id,
        tenantId: scope.tenant.id,
        workspaceId: scope.workspace.id,
        schemaVersion: '1.0.0',
      },
    });
    const plan = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/content-plans/${started.plan.id}`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    const bundle = ContentPlanBundleEnvelopeSchema.parse(plan.json()).data;
    expect(bundle.briefs.some((brief) => brief.assetKind === 'COMPARISON')).toBe(false);
    expect(bundle.evidenceTasks).toContainEqual(
      expect.objectContaining({
        assetKind: 'COMPARISON',
        reasonCode: 'INDEPENDENT_COMPARISON_EVIDENCE_REQUIRED',
      }),
    );
  });

  test('a Brief remains review-gated until a different Reviewer approves its exact hash', async () => {
    const ownerSession = await signIn(app);
    const scope = await createScope(app, ownerSession, 'Brief Review');
    const fixture = await seedPlanningFixture(pool, scope);
    await setBudget(app, ownerSession, scope);
    const invitation = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/invitations`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { email: 'plan-reviewer@example.test', role: 'REVIEWER' },
    });
    const membershipId = invitation.json<{ data: { membership: { id: string } } }>().data.membership
      .id;
    const reviewerSession = await signIn(app, 'plan-reviewer-code');
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/memberships/${membershipId}/accept`,
      headers: {
        cookie: `__Host-aeo_session=${reviewerSession}`,
        origin: 'https://app.example.test',
      },
    });
    expect(accepted.statusCode).toBe(200);
    const startedResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/content-plans`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: fixture,
    });
    const started = StartContentPlanEnvelopeSchema.parse(startedResponse.json()).data;
    const clock = { now: () => new Date('2026-07-21T04:00:00.000Z') };
    const jobStore = new PostgresJobBudgetStore(pool);
    const worker = new ContentPlanJobWorker(
      new JobWorkerCoordinator(jobStore, clock, { next: randomUUID }, 'content-plan-v1'),
      new ContentPlanHandler(new PostgresContentPlanningStore(pool), { next: randomUUID }, clock),
    );
    await worker.process({
      messageId: randomUUID(),
      payload: {
        jobId: started.job.id,
        tenantId: scope.tenant.id,
        workspaceId: scope.workspace.id,
        schemaVersion: '1.0.0',
      },
    });
    const planResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/content-plans/${started.plan.id}`,
      headers: { cookie: `__Host-aeo_session=${ownerSession}` },
    });
    const plan = ContentPlanBundleEnvelopeSchema.parse(planResponse.json()).data;
    const brief = plan.briefs[0];
    if (brief === undefined) throw new Error('REVIEWABLE_BRIEF_MISSING');
    const reviewUrl = `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/content-plans/${started.plan.id}/briefs/${brief.id}/review`;
    const selfReview = await app.inject({
      method: 'POST',
      url: reviewUrl,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        decision: 'APPROVE',
        expectedContentHash: brief.contentHash,
        note: 'Creator must not approve the generated Brief.',
      },
    });
    expect(selfReview.statusCode).toBe(409);
    expect(selfReview.json()).toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
    const wrongHash = await app.inject({
      method: 'POST',
      url: reviewUrl,
      headers: {
        cookie: `__Host-aeo_session=${reviewerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        decision: 'APPROVE',
        expectedContentHash: 'f'.repeat(64),
        note: 'A stale or incorrect hash must not approve.',
      },
    });
    expect(wrongHash.statusCode).toBe(409);
    expect(wrongHash.json()).toMatchObject({ code: 'BRIEF_REVIEW_HASH_MISMATCH' });
    const approved = await app.inject({
      method: 'POST',
      url: reviewUrl,
      headers: {
        cookie: `__Host-aeo_session=${reviewerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        decision: 'APPROVE',
        expectedContentHash: brief.contentHash,
        note: 'Prompt, Claims and source references verified.',
      },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      data: {
        brief: { id: brief.id, status: 'APPROVED', contentHash: brief.contentHash },
        review: { decision: 'APPROVE', contentHash: brief.contentHash },
      },
    });
  });
});
