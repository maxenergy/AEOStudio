import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { InMemoryArtifactPayloadStore } from '@aeostudio/adapters/generation';
import type { ArtifactStore } from '@aeostudio/application/artifacts';
import type { AuthorizationRequest, OidcClient } from '@aeostudio/application/auth';
import { StartArtifactGenerationEnvelopeSchema } from '@aeostudio/contracts/artifacts';
import { StartContentPlanEnvelopeSchema } from '@aeostudio/contracts/content-planning';
import {
  AesGcmSessionCipher,
  PostgresArtifactStore,
  PostgresAuthStore,
  PostgresContentPlanningStore,
  PostgresEvidenceClaimStore,
  PostgresJobBudgetStore,
  PostgresPromptResearchStore,
  PostgresTenancyStore,
  runMigrations,
} from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createApiApp } from '../../apps/api/src/app.js';
import { FAKE_ARTIFACT_LINEAGE } from '../../apps/api/src/artifacts/fake-artifact-lineage-fixture.js';
import { seedTask10ApprovedArtifactSource } from './fixtures/task-10-approved-artifact-source.js';

type ApiTestApp = Awaited<ReturnType<typeof createApiApp>>;
const durableCrossRouteIdempotencyKey = `durable-cross-route-${randomUUID()}`;

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
  exchangeCode() {
    return Promise.resolve({
      subject: 'p1-idempotency-owner',
      email: 'p1-idempotency-owner@example.test',
      emailVerified: true,
    });
  },
};

describe.sequential('P1 durable generation start idempotency', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: ApiTestApp;
  let session: string;
  let tenantId: string;
  let workspaceId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(
      pool,
      fileURLToPath(new URL('../../packages/db/migrations', import.meta.url)),
    );
    app = await createPostgresApp(pool);
    session = await signIn(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: mutationHeaders(session),
      payload: {
        tenantName: 'P1 Durable Idempotency Tenant',
        workspaceName: 'P1 Durable Idempotency Workspace',
      },
    });
    const scope = created.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    tenantId = scope.tenant.id;
    workspaceId = scope.workspace.id;
    await seedTask10ApprovedArtifactSource(pool, scope);
    const budget = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/budget`,
      headers: mutationHeaders(session),
      payload: { limitUnits: 1_000 },
    });
    expect(budget.statusCode, budget.body).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  test('replays after an API restart without creating another aggregate, lineage, Job or budget effect', async () => {
    const payload = {
      briefId: FAKE_ARTIFACT_LINEAGE.briefId,
      locale: 'en-SG',
      market: 'SG',
      methodPolicyVersion: 'artifact-fixture-v1' as const,
      idempotencyKey: durableCrossRouteIdempotencyKey,
    };
    const url = `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/artifacts`;
    const firstResponse = await app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(session),
      payload,
    });
    expect(firstResponse.statusCode, firstResponse.body).toBe(202);
    const first = StartArtifactGenerationEnvelopeSchema.parse(firstResponse.json()).data;

    await app.close();
    app = await createPostgresApp(pool);
    const replayResponse = await app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(session),
      payload,
    });
    expect(replayResponse.statusCode, replayResponse.body).toBe(202);
    const replay = StartArtifactGenerationEnvelopeSchema.parse(replayResponse.json()).data;
    expect(replay.artifact.id).toBe(first.artifact.id);
    expect(replay.job.id).toBe(first.job.id);

    const effects = await pool.query<{
      start_intents: string;
      artifacts: string;
      revisions: string;
      claim_links: string;
      jobs: string;
      reservations: string;
      outbox: string;
    }>(
      `SELECT
        (SELECT count(*) FROM generation_start_intents
          WHERE tenant_id = $1 AND workspace_id = $2)::text AS start_intents,
        (SELECT count(*) FROM artifacts
          WHERE tenant_id = $1 AND workspace_id = $2)::text AS artifacts,
        (SELECT count(*) FROM artifact_revisions
          WHERE tenant_id = $1 AND workspace_id = $2)::text AS revisions,
        (SELECT count(*) FROM artifact_claim_links
          WHERE tenant_id = $1 AND workspace_id = $2)::text AS claim_links,
        (SELECT count(*) FROM jobs
          WHERE tenant_id = $1 AND workspace_id = $2
            AND job_type = 'ARTIFACT_GENERATION')::text AS jobs,
        (SELECT count(*) FROM budget_reservations reservation
          JOIN jobs job ON job.tenant_id = reservation.tenant_id AND job.id = reservation.job_id
          WHERE job.tenant_id = $1 AND job.workspace_id = $2
            AND job.job_type = 'ARTIFACT_GENERATION')::text AS reservations,
        (SELECT count(*) FROM outbox_messages message
          JOIN jobs job ON job.tenant_id = message.tenant_id AND job.id = message.aggregate_id
          WHERE job.tenant_id = $1 AND job.workspace_id = $2
            AND job.job_type = 'ARTIFACT_GENERATION')::text AS outbox`,
      [tenantId, workspaceId],
    );
    expect(effects.rows[0]).toEqual({
      start_intents: '1',
      artifacts: '1',
      revisions: '0',
      claim_links: '0',
      jobs: '1',
      reservations: '1',
      outbox: '1',
    });

    const conflict = await app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(session),
      payload: { ...payload, market: 'MY' },
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'ARTIFACT_IDEMPOTENCY_CONFLICT' });
  });

  test('serializes concurrent Artifact starts into one aggregate, Job and budget effect', async () => {
    const payload = {
      briefId: FAKE_ARTIFACT_LINEAGE.briefId,
      locale: 'en-SG',
      market: 'SG',
      methodPolicyVersion: 'artifact-fixture-v1' as const,
      idempotencyKey: `concurrent-artifact-${randomUUID()}`,
    };
    const url = `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/artifacts`;
    const [leftResponse, rightResponse] = await Promise.all([
      app.inject({ method: 'POST', url, headers: mutationHeaders(session), payload }),
      app.inject({ method: 'POST', url, headers: mutationHeaders(session), payload }),
    ]);
    expect(leftResponse.statusCode, leftResponse.body).toBe(202);
    expect(rightResponse.statusCode, rightResponse.body).toBe(202);
    const left = StartArtifactGenerationEnvelopeSchema.parse(leftResponse.json()).data;
    const right = StartArtifactGenerationEnvelopeSchema.parse(rightResponse.json()).data;
    expect(right.artifact.id).toBe(left.artifact.id);
    expect(right.job.id).toBe(left.job.id);

    const effects = await loadArtifactStartEffects(
      pool,
      tenantId,
      workspaceId,
      payload.idempotencyKey,
      left.artifact.id,
      left.job.id,
    );
    expect(effects).toEqual({
      start_intents: '1',
      artifacts: '1',
      revisions: '0',
      claim_links: '0',
      jobs: '1',
      reservations: '1',
      outbox: '1',
      artifact_job_id: left.job.id,
    });
  });

  test('recovers the frozen Artifact and Job identities after failure between aggregate creation and enqueue', async () => {
    const payload = {
      briefId: FAKE_ARTIFACT_LINEAGE.briefId,
      locale: 'en-SG',
      market: 'SG',
      methodPolicyVersion: 'artifact-fixture-v1' as const,
      idempotencyKey: `recover-artifact-${randomUUID()}`,
    };
    const url = `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/artifacts`;

    await app.close();
    app = await createPostgresApp(pool, {
      artifactStore: failOnceAfterArtifactPrepare(new PostgresArtifactStore(pool)),
    });
    const interruptedResponse = await app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(session),
      payload,
    });
    expect(interruptedResponse.statusCode, interruptedResponse.body).toBe(500);

    const frozen = await pool.query<{
      aggregate_id: string;
      job_id: string;
      estimated_units: string;
      requested_at: Date;
    }>(
      `SELECT aggregate_id, job_id, estimated_units::text, requested_at
       FROM generation_start_intents
       WHERE tenant_id = $1 AND workspace_id = $2
         AND operation = 'ARTIFACT_GENERATION' AND idempotency_key = $3`,
      [tenantId, workspaceId, payload.idempotencyKey],
    );
    expect(frozen.rowCount).toBe(1);
    expect(Number(frozen.rows[0]?.estimated_units)).toBeGreaterThan(0);
    expect(frozen.rows[0]?.requested_at).toBeInstanceOf(Date);

    const interruptedEffects = await loadArtifactStartEffects(
      pool,
      tenantId,
      workspaceId,
      payload.idempotencyKey,
      frozen.rows[0]?.aggregate_id ?? '',
      frozen.rows[0]?.job_id ?? '',
    );
    expect(interruptedEffects).toEqual({
      start_intents: '1',
      artifacts: '1',
      revisions: '0',
      claim_links: '0',
      jobs: '0',
      reservations: '0',
      outbox: '0',
      artifact_job_id: null,
    });

    await app.close();
    app = await createPostgresApp(pool);
    const replayResponse = await app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(session),
      payload,
    });
    expect(replayResponse.statusCode, replayResponse.body).toBe(202);
    const replay = StartArtifactGenerationEnvelopeSchema.parse(replayResponse.json()).data;
    expect(replay.artifact.id).toBe(frozen.rows[0]?.aggregate_id);
    expect(replay.job.id).toBe(frozen.rows[0]?.job_id);

    const recoveredEffects = await loadArtifactStartEffects(
      pool,
      tenantId,
      workspaceId,
      payload.idempotencyKey,
      replay.artifact.id,
      replay.job.id,
    );
    expect(recoveredEffects).toEqual({
      start_intents: '1',
      artifacts: '1',
      revisions: '0',
      claim_links: '0',
      jobs: '1',
      reservations: '1',
      outbox: '1',
      artifact_job_id: replay.job.id,
    });
  });

  test('durably replays a Content Plan start and keeps its aggregate and Job singular', async () => {
    const promptIds = [randomUUID(), randomUUID(), randomUUID()];
    await pool.query(
      `UPDATE prompt_revisions SET prompts = $1::jsonb
       WHERE id = $2`,
      [
        JSON.stringify(
          promptIds.map((id, index) => ({
            id,
            text: `P1 durable Content Plan prompt ${index + 1}`,
            persona: 'Evidence evaluator',
            journeyStage: 'DISCOVERY',
            queryType: 'EXPLANATORY',
          })),
        ),
        FAKE_ARTIFACT_LINEAGE.promptRevisionId,
      ],
    );
    const payload = {
      profile: { id: FAKE_ARTIFACT_LINEAGE.profileId, revision: 1 },
      offering: { id: FAKE_ARTIFACT_LINEAGE.offeringId, revision: 1 },
      promptSetId: FAKE_ARTIFACT_LINEAGE.promptSetId,
      promptRevisionId: FAKE_ARTIFACT_LINEAGE.promptRevisionId,
      primaryClaimRevisionIds: [FAKE_ARTIFACT_LINEAGE.claimRevisionId],
      comparisonClaimRevisionIds: [],
      baselineId: FAKE_ARTIFACT_LINEAGE.siteBaselineId,
      methodPolicyVersion: 'content-plan-v1' as const,
      idempotencyKey: durableCrossRouteIdempotencyKey,
    };
    const url = `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/content-plans`;
    const firstResponse = await app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(session),
      payload,
    });
    expect(firstResponse.statusCode, firstResponse.body).toBe(202);
    const first = StartContentPlanEnvelopeSchema.parse(firstResponse.json()).data;

    await app.close();
    app = await createPostgresApp(pool);
    const replayResponse = await app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(session),
      payload,
    });
    expect(replayResponse.statusCode, replayResponse.body).toBe(202);
    const replay = StartContentPlanEnvelopeSchema.parse(replayResponse.json()).data;
    expect(replay.plan.id).toBe(first.plan.id);
    expect(replay.job.id).toBe(first.job.id);

    const effects = await pool.query<{
      start_intents: string;
      plans: string;
      jobs: string;
      reservations: string;
      outbox: string;
    }>(
      `SELECT
        (SELECT count(*) FROM generation_start_intents
          WHERE tenant_id = $1 AND workspace_id = $2
            AND operation = 'CONTENT_PLAN')::text AS start_intents,
        (SELECT count(*) FROM content_plans
          WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3)::text AS plans,
        (SELECT count(*) FROM jobs
          WHERE tenant_id = $1 AND workspace_id = $2
            AND job_type = 'CONTENT_PLAN' AND aggregate_id = $3)::text AS jobs,
        (SELECT count(*) FROM budget_reservations reservation
          JOIN jobs job ON job.tenant_id = reservation.tenant_id AND job.id = reservation.job_id
          WHERE job.tenant_id = $1 AND job.workspace_id = $2
            AND job.job_type = 'CONTENT_PLAN' AND job.aggregate_id = $3)::text AS reservations,
        (SELECT count(*) FROM outbox_messages message
          JOIN jobs job ON job.tenant_id = message.tenant_id AND job.id = message.aggregate_id
          WHERE job.tenant_id = $1 AND job.workspace_id = $2
            AND job.job_type = 'CONTENT_PLAN' AND job.aggregate_id = $3)::text AS outbox`,
      [tenantId, workspaceId, first.plan.id],
    );
    expect(effects.rows[0]).toEqual({
      start_intents: '1',
      plans: '1',
      jobs: '1',
      reservations: '1',
      outbox: '1',
    });
    const routeScopedEffects = await pool.query<{ intents: string; jobs: string }>(
      `SELECT
        (SELECT count(*) FROM generation_start_intents
          WHERE tenant_id = $1 AND workspace_id = $2 AND idempotency_key = $3)::text AS intents,
        (SELECT count(*) FROM jobs
          WHERE tenant_id = $1 AND workspace_id = $2 AND idempotency_key = $3
            AND job_type IN ('CONTENT_PLAN', 'ARTIFACT_GENERATION'))::text AS jobs`,
      [tenantId, workspaceId, durableCrossRouteIdempotencyKey],
    );
    expect(routeScopedEffects.rows[0]).toEqual({ intents: '2', jobs: '2' });

    const conflict = await app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(session),
      payload: { ...payload, baselineId: randomUUID() },
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'CONTENT_PLAN_IDEMPOTENCY_CONFLICT' });
  });

  test('isolates durable start keys by both Workspace and Tenant', async () => {
    const idempotencyKey = `durable-isolation-${randomUUID()}`;
    const sameTenantWorkspaceId = await addWorkspaceForCurrentOwner(pool, tenantId);
    const secondTenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: mutationHeaders(session),
      payload: {
        tenantName: 'P1 Durable Isolated Tenant',
        workspaceName: 'P1 Durable Isolated Workspace',
      },
    });
    expect(secondTenantResponse.statusCode, secondTenantResponse.body).toBe(201);
    const secondTenantScope = secondTenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;

    const tenancy = new PostgresTenancyStore(pool);
    const contexts = await Promise.all([
      tenancy.resolveTenantContext({
        actorSubject: 'p1-idempotency-owner',
        tenantId,
        workspaceId,
      }),
      tenancy.resolveTenantContext({
        actorSubject: 'p1-idempotency-owner',
        tenantId,
        workspaceId: sameTenantWorkspaceId,
      }),
      tenancy.resolveTenantContext({
        actorSubject: 'p1-idempotency-owner',
        tenantId: secondTenantScope.tenant.id,
        workspaceId: secondTenantScope.workspace.id,
      }),
    ]);
    const [primaryContext, sameTenantContext, secondTenantContext] = contexts;
    if (
      primaryContext === null ||
      primaryContext === undefined ||
      sameTenantContext === null ||
      sameTenantContext === undefined ||
      secondTenantContext === null ||
      secondTenantContext === undefined
    ) {
      throw new Error('P1_DURABLE_ISOLATION_CONTEXT_NOT_FOUND');
    }
    const resolvedContexts = [primaryContext, sameTenantContext, secondTenantContext];

    const jobStore = new PostgresJobBudgetStore(pool);
    const starts = await Promise.all(
      resolvedContexts.map((context) =>
        jobStore.reserveGenerationStart({
          context,
          operation: 'CONTENT_PLAN',
          idempotencyKey,
          requestHash: 'a'.repeat(64),
          aggregateId: randomUUID(),
          jobId: randomUUID(),
          estimatedUnits: 7,
          requestedAt: new Date('2026-07-25T00:00:00.000Z'),
        }),
      ),
    );
    if (starts.some((start) => start.outcome !== 'RESERVED')) {
      throw new Error('P1_DURABLE_ISOLATION_RESERVATION_FAILED');
    }
    const identities = starts.map((start) => {
      if (start.outcome !== 'RESERVED') throw new Error('P1_DURABLE_ISOLATION_UNREACHABLE');
      return `${start.aggregateId}:${start.jobId}`;
    });
    expect(new Set(identities).size).toBe(3);

    const conflict = await jobStore.reserveGenerationStart({
      context: primaryContext,
      operation: 'CONTENT_PLAN',
      idempotencyKey,
      requestHash: 'b'.repeat(64),
      aggregateId: randomUUID(),
      jobId: randomUUID(),
      estimatedUnits: 7,
      requestedAt: new Date('2026-07-25T00:00:01.000Z'),
    });
    expect(conflict).toEqual({ outcome: 'IDEMPOTENCY_CONFLICT' });

    const persisted = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM generation_start_intents
       WHERE idempotency_key = $1 AND operation = 'CONTENT_PLAN'`,
      [idempotencyKey],
    );
    expect(persisted.rows[0]?.count).toBe('3');
  });
});

function createPostgresApp(pool: Pool, options: { artifactStore?: ArtifactStore } = {}) {
  const payloads = new InMemoryArtifactPayloadStore();
  return createApiApp({
    oidcClient,
    store: new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 19))),
    artifactStore: options.artifactStore ?? new PostgresArtifactStore(pool),
    artifactPayloadStore: payloads,
    contentPlanningStore: new PostgresContentPlanningStore(pool),
    evidenceClaimStore: new PostgresEvidenceClaimStore(pool),
    jobBudgetStore: new PostgresJobBudgetStore(pool),
    promptResearchStore: new PostgresPromptResearchStore(pool),
    tenancyStore: new PostgresTenancyStore(pool),
    webOrigin: 'https://app.example.test',
    runtimeBuildIdentity: null,
  });
}

function failOnceAfterArtifactPrepare(store: ArtifactStore): ArtifactStore {
  let failed = false;
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'prepareArtifact') {
        return async (input: Parameters<ArtifactStore['prepareArtifact']>[0]) => {
          const result = await target.prepareArtifact(input);
          if (!failed && result.outcome === 'SUCCEEDED') {
            failed = true;
            throw new Error('P1_SIMULATED_CRASH_AFTER_ARTIFACT_PREPARE');
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      return method.bind(target);
    },
  });
}

async function loadArtifactStartEffects(
  pool: Pool,
  tenantId: string,
  workspaceId: string,
  idempotencyKey: string,
  artifactId: string,
  jobId: string,
) {
  const effects = await pool.query<{
    start_intents: string;
    artifacts: string;
    revisions: string;
    claim_links: string;
    jobs: string;
    reservations: string;
    outbox: string;
    artifact_job_id: string | null;
  }>(
    `SELECT
      (SELECT count(*) FROM generation_start_intents
        WHERE tenant_id = $1 AND workspace_id = $2
          AND operation = 'ARTIFACT_GENERATION' AND idempotency_key = $3)::text
        AS start_intents,
      (SELECT count(*) FROM artifacts
        WHERE tenant_id = $1 AND workspace_id = $2 AND id = $4)::text AS artifacts,
      (SELECT count(*) FROM artifact_revisions
        WHERE tenant_id = $1 AND workspace_id = $2 AND artifact_id = $4)::text AS revisions,
      (SELECT count(*) FROM artifact_claim_links claim_link
        JOIN artifact_revisions revision
          ON revision.tenant_id = claim_link.tenant_id
         AND revision.id = claim_link.artifact_revision_id
        WHERE claim_link.tenant_id = $1 AND claim_link.workspace_id = $2
          AND revision.artifact_id = $4)::text AS claim_links,
      (SELECT count(*) FROM jobs
        WHERE tenant_id = $1 AND workspace_id = $2 AND id = $5
          AND job_type = 'ARTIFACT_GENERATION' AND aggregate_id = $4)::text AS jobs,
      (SELECT count(*) FROM budget_reservations
        WHERE tenant_id = $1 AND job_id = $5)::text AS reservations,
      (SELECT count(*) FROM outbox_messages
        WHERE tenant_id = $1 AND aggregate_id = $5)::text AS outbox,
      (SELECT job_id FROM artifacts
        WHERE tenant_id = $1 AND workspace_id = $2 AND id = $4) AS artifact_job_id`,
    [tenantId, workspaceId, idempotencyKey, artifactId, jobId],
  );
  return effects.rows[0];
}

async function addWorkspaceForCurrentOwner(pool: Pool, tenantId: string): Promise<string> {
  const membership = await pool.query<{ id: string }>(
    `SELECT id FROM memberships
     WHERE tenant_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at
     LIMIT 1`,
    [tenantId],
  );
  const membershipId = membership.rows[0]?.id;
  if (membershipId === undefined) throw new Error('P1_DURABLE_ISOLATION_MEMBERSHIP_NOT_FOUND');
  const workspaceId = randomUUID();
  await pool.query(
    `INSERT INTO workspaces (id, tenant_id, name, created_at)
     VALUES ($1, $2, 'P1 Durable Isolated Workspace', clock_timestamp())`,
    [workspaceId, tenantId],
  );
  await pool.query(
    `INSERT INTO role_bindings
      (id, tenant_id, workspace_id, membership_id, role, created_at)
     VALUES ($1, $2, $3, $4, 'OWNER', clock_timestamp())`,
    [randomUUID(), tenantId, workspaceId, membershipId],
  );
  return workspaceId;
}

async function signIn(app: ApiTestApp): Promise<string> {
  const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
  const loginToken = login.cookies.find((cookie) => cookie.name === '__Host-aeo_login')?.value;
  const state = new URL(login.headers.location ?? '').searchParams.get('state');
  const callback = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/callback?code=p1-idempotency-code&state=${state ?? ''}`,
    headers: { cookie: `__Host-aeo_login=${loginToken ?? ''}` },
  });
  const session = callback.cookies.find((cookie) => cookie.name === '__Host-aeo_session')?.value;
  if (session === undefined) throw new Error('P1_POSTGRES_IDEMPOTENCY_LOGIN_FAILED');
  return session;
}

function mutationHeaders(session: string) {
  return {
    cookie: `__Host-aeo_session=${session}`,
    origin: 'https://app.example.test',
  };
}
