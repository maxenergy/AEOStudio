import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { AuthorizationRequest, OidcClient } from '@aeostudio/application/auth';
import type { ArtifactGenerator, ArtifactPayloadStore } from '@aeostudio/application/artifacts';
import { JobWorkerCoordinator } from '@aeostudio/application/jobs-budgets';
import {
  DeterministicArtifactGenerator,
  InMemoryArtifactPayloadStore,
} from '@aeostudio/adapters/generation';
import {
  ArtifactBundleEnvelopeSchema,
  StartArtifactGenerationEnvelopeSchema,
} from '@aeostudio/contracts/artifacts';
import type { ArtifactPayload, ArtifactWriterContext } from '@aeostudio/domain/artifacts';
import {
  AesGcmSessionCipher,
  PostgresArtifactStore,
  PostgresAuthStore,
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
import {
  ArtifactGenerationHandler,
  ArtifactGenerationJobWorker,
} from '../../apps/worker/src/index.js';

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
    if (input.code === 'artifact-reviewer-code') {
      return Promise.resolve({
        subject: 'artifact-reviewer-subject',
        email: 'artifact-reviewer@example.test',
        emailVerified: true,
      });
    }
    return Promise.resolve({
      subject: 'artifact-editor-subject',
      email: 'artifact-editor@example.test',
      emailVerified: true,
    });
  },
};

async function signIn(app: ApiTestApp, code = 'artifact-editor-code'): Promise<string> {
  const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
  const token = login.cookies.find((cookie) => cookie.name === '__Host-aeo_login')?.value;
  const state = new URL(login.headers.location ?? '').searchParams.get('state');
  const callback = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/callback?code=${code}&state=${state ?? ''}`,
    headers: { cookie: `__Host-aeo_login=${token ?? ''}` },
  });
  const session = callback.cookies.find((cookie) => cookie.name === '__Host-aeo_session')?.value;
  if (session === undefined) throw new Error('ARTIFACT_TEST_LOGIN_FAILED');
  return session;
}

async function createScope(app: ApiTestApp, session: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
    payload: { tenantName: 'Artifact Tenant', workspaceName: 'Artifact Workspace' },
  });
  return response.json<{
    data: { tenant: { id: string }; workspace: { id: string } };
  }>().data;
}

async function addWorkspaceForExistingTenant(pool: Pool, tenantId: string): Promise<string> {
  const workspaceId = randomUUID();
  const membership = await pool.query<{ id: string }>(
    `SELECT id FROM memberships WHERE tenant_id = $1 AND status = 'ACTIVE' ORDER BY created_at LIMIT 1`,
    [tenantId],
  );
  const membershipId = membership.rows[0]?.id;
  if (membershipId === undefined) throw new Error('ACTIVE_MEMBERSHIP_NOT_FOUND');
  await pool.query(
    `INSERT INTO workspaces (id, tenant_id, name) VALUES ($1, $2, 'Same Tenant Other Workspace')`,
    [workspaceId, tenantId],
  );
  await pool.query(
    `INSERT INTO role_bindings (id, tenant_id, workspace_id, membership_id, role)
     VALUES ($1, $2, $3, $4, 'OWNER')`,
    [randomUUID(), tenantId, workspaceId, membershipId],
  );
  return workspaceId;
}

interface ApprovedBriefFixture {
  briefId: string;
  planId: string;
  profileRevisionId: string;
  offeringRevisionId: string;
  promptSetId: string;
  promptRevisionId: string;
  promptId: string;
  baselineId: string;
  claimId: string;
  claimRevisionId: string;
  evidenceSourceId: string;
  evidenceSnapshotId: string;
}

class CorruptibleArtifactPayloadStore implements ArtifactPayloadStore {
  private readonly objects = new Map<string, ArtifactPayload>();

  put(input: Parameters<ArtifactPayloadStore['put']>[0]) {
    const objectRef =
      `s3://corruptible-artifact-fixture/${input.tenantId}/${input.workspaceId}/` +
      `${input.artifactId}/r${input.revision}/${input.contentHash}.json`;
    this.objects.set(objectRef, structuredClone(input.payload));
    return Promise.resolve({ objectRef });
  }

  get(objectRef: string): Promise<ArtifactPayload | null> {
    const payload = this.objects.get(objectRef);
    return Promise.resolve(payload === undefined ? null : structuredClone(payload));
  }

  corrupt(objectRef: string, payload: ArtifactPayload): void {
    this.objects.set(objectRef, structuredClone(payload));
  }
}

async function seedApprovedBrief(
  pool: Pool,
  scope: { tenant: { id: string }; workspace: { id: string } },
  artifactType: 'DEFINITION_PRODUCT' | 'COMPARISON' | 'TECHNICAL_EVIDENCE' = 'DEFINITION_PRODUCT',
): Promise<ApprovedBriefFixture> {
  const client = await pool.connect();
  const now = new Date('2026-07-21T05:00:00.000Z');
  const hash = (character: string) => character.repeat(64);
  const profileId = randomUUID();
  const profileRevisionId = randomUUID();
  const offeringId = randomUUID();
  const offeringRevisionId = randomUUID();
  const promptSetId = randomUUID();
  const promptRevisionId = randomUUID();
  const promptId = randomUUID();
  const scenarioId = randomUUID();
  const siteId = randomUUID();
  const baselineJobId = randomUUID();
  const baselineId = randomUUID();
  const sourceId = randomUUID();
  const snapshotId = randomUUID();
  const claimId = randomUUID();
  const claimRevisionId = randomUUID();
  const planId = randomUUID();
  const opportunityId = randomUUID();
  const briefId = randomUUID();
  try {
    await client.query('BEGIN');
    const member = await client.query<{ user_id: string }>(
      `SELECT user_id FROM memberships WHERE tenant_id = $1 AND status = 'ACTIVE'`,
      [scope.tenant.id],
    );
    const actorUserId = member.rows[0]?.user_id;
    if (actorUserId === undefined) throw new Error('ARTIFACT_FIXTURE_ACTOR_NOT_FOUND');

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
        JSON.stringify({ name: 'Artifact fixture organization' }),
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
        JSON.stringify({ name: 'Artifact fixture offering' }),
        JSON.stringify({ percent: 100, missingFields: [] }),
        actorUserId,
        now,
      ],
    );
    await client.query(
      `INSERT INTO evidence_sources
        (id, tenant_id, workspace_id, source_type, title, license, publicity,
          current_snapshot_id, created_at)
       VALUES ($1, $2, $3, 'UPLOAD', 'Artifact evidence', 'Fixture license', 'PRIVATE',
         NULL, $4)`,
      [sourceId, scope.tenant.id, scope.workspace.id, now],
    );
    await client.query(
      `INSERT INTO evidence_snapshots
        (id, tenant_id, workspace_id, source_id, content_hash, object_ref, object_version_id,
          content_type, size_bytes, captured_at)
       VALUES ($1, $2, $3, $4, $5, 'fixture://artifact-evidence', 'fixture-v1', 'text/plain', 128, $6)`,
      [snapshotId, scope.tenant.id, scope.workspace.id, sourceId, hash('a'), now],
    );
    await client.query(`UPDATE evidence_sources SET current_snapshot_id = $1 WHERE id = $2`, [
      snapshotId,
      sourceId,
    ]);
    await client.query(
      `INSERT INTO claims (id, tenant_id, workspace_id, current_revision, created_at)
       VALUES ($1, $2, $3, 1, $4)`,
      [claimId, scope.tenant.id, scope.workspace.id, now],
    );
    await client.query(
      `INSERT INTO claim_revisions
       (id, tenant_id, workspace_id, claim_id, revision, statement, conditions,
          content_hash, status, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, 1, 'Artifact fixture claim', '[]'::jsonb, $5,
         'APPROVED', $6, $7)`,
      [claimRevisionId, scope.tenant.id, scope.workspace.id, claimId, hash('b'), actorUserId, now],
    );
    await client.query(
      `INSERT INTO claim_evidence_links
        (id, tenant_id, workspace_id, claim_revision_id, snapshot_id, source_hash,
          snippet, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'Artifact fixture excerpt', $7)`,
      [
        randomUUID(),
        scope.tenant.id,
        scope.workspace.id,
        claimRevisionId,
        snapshotId,
        hash('a'),
        now,
      ],
    );

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
       VALUES ($1, $2, $3, $4, 1, 'Artifact fixture prompts', 'Artifact subject',
         $5::jsonb, $6::jsonb, $7::jsonb, $8, 'APPROVED', $9, $10)`,
      [
        promptRevisionId,
        scope.tenant.id,
        scope.workspace.id,
        promptSetId,
        JSON.stringify({
          profile: { id: profileId, revision: 1 },
          offering: { id: offeringId, revision: 1 },
          claimRevisionIds: [claimRevisionId],
        }),
        JSON.stringify([
          {
            id: promptId,
            text: 'How does the fixture offering work?',
            persona: 'Evidence evaluator',
            journeyStage: 'DISCOVERY',
            queryType: 'EXPLANATORY',
          },
        ]),
        JSON.stringify([{ market: 'SG', locale: 'en-SG', region: 'ap-southeast-1' }]),
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

    const sourceArtifactIds = [profileRevisionId, offeringRevisionId, promptRevisionId, baselineId];
    const inputSnapshot = {
      profile: { id: profileId, revision: 1 },
      offering: { id: offeringId, revision: 1 },
      promptSetId,
      promptRevisionId,
      primaryClaimRevisionIds: [claimRevisionId],
      comparisonClaimRevisionIds: [],
      baselineId,
      methodPolicyVersion: 'content-plan-v1',
      profileRevisionId,
      offeringRevisionId,
      promptIds: [promptId],
      primaryEvidenceSnapshotIds: [snapshotId],
      comparisonEvidenceSnapshotIds: [],
      availableClaimRevisionIds: [claimRevisionId],
      availableSourceArtifactIds: sourceArtifactIds,
      comparisonEvidenceIndependent: false,
    };
    await client.query(
      `INSERT INTO content_plans
        (id, tenant_id, workspace_id, status, method_policy_version, input_snapshot,
          content_hash, created_by_user_id, created_at, completed_at)
       VALUES ($1, $2, $3, 'READY', 'content-plan-v1', $4::jsonb, $5, $6, $7, $7)`,
      [
        planId,
        scope.tenant.id,
        scope.workspace.id,
        JSON.stringify(inputSnapshot),
        hash('c'),
        actorUserId,
        now,
      ],
    );
    await client.query(
      `INSERT INTO opportunities
        (id, tenant_id, workspace_id, content_plan_id, opportunity_key, asset_kind,
          business_value, evidence_readiness, visibility_gap, effort, risk, priority_score,
          priority_rank, rank_reason, action, evidence_ready, publish_ready)
       VALUES ($1, $2, $3, $4, $5, $5, 90, 100,
         '{"status":"UNKNOWN","reason":"Fixture"}'::jsonb, 30, 20, 87, 1,
         'Fixture deterministic rank', 'BRIEF', true, false)`,
      [opportunityId, scope.tenant.id, scope.workspace.id, planId, artifactType],
    );
    await client.query(
      `INSERT INTO briefs
        (id, tenant_id, workspace_id, content_plan_id, opportunity_id, brief_key,
          asset_kind, title, prompt_ids, claim_revision_ids, source_artifact_ids, status,
          evidence_ready, publish_ready, content_hash, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6,
         'Approved Artifact brief', $7::jsonb, $8::jsonb, $9::jsonb, 'APPROVED', true,
         false, $10, $11, $12)`,
      [
        briefId,
        scope.tenant.id,
        scope.workspace.id,
        planId,
        opportunityId,
        artifactType,
        JSON.stringify(inputSnapshot.promptIds),
        JSON.stringify([claimRevisionId]),
        JSON.stringify(sourceArtifactIds),
        hash('d'),
        actorUserId,
        now,
      ],
    );
    await client.query('COMMIT');
    return {
      briefId,
      planId,
      profileRevisionId,
      offeringRevisionId,
      promptSetId,
      promptRevisionId,
      promptId,
      baselineId,
      claimId,
      claimRevisionId,
      evidenceSourceId: sourceId,
      evidenceSnapshotId: snapshotId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function setBudget(
  app: ApiTestApp,
  session: string,
  scope: { tenant: { id: string }; workspace: { id: string } },
) {
  const response = await app.inject({
    method: 'PUT',
    url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
    headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
    payload: { limitUnits: 1_000 },
  });
  expect(response.statusCode).toBe(200);
}

async function addWorkspaceForCurrentOwner(
  pool: Pool,
  scope: { tenant: { id: string }; workspace: { id: string } },
): Promise<string> {
  const workspaceId = randomUUID();
  const roleBindingId = randomUUID();
  const membership = await pool.query<{ id: string }>(
    `SELECT id FROM memberships WHERE tenant_id = $1 AND status = 'ACTIVE'`,
    [scope.tenant.id],
  );
  const membershipId = membership.rows[0]?.id;
  if (membershipId === undefined) throw new Error('ARTIFACT_FIXTURE_MEMBERSHIP_NOT_FOUND');
  await pool.query(
    `INSERT INTO workspaces (id, tenant_id, name)
     VALUES ($1, $2, 'Second Artifact Workspace')`,
    [workspaceId, scope.tenant.id],
  );
  await pool.query(
    `INSERT INTO role_bindings (id, tenant_id, workspace_id, membership_id, role)
     VALUES ($1, $2, $3, $4, 'OWNER')`,
    [roleBindingId, scope.tenant.id, workspaceId, membershipId],
  );
  return workspaceId;
}

async function expectRuntimeMutationDenied(input: {
  pool: Pool;
  tenantId: string;
  workspaceId: string;
  actorUserId: string;
  sql: string;
  values: unknown[];
  code: string;
}) {
  const client = await input.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE aeostudio_runtime');
    await client.query(
      `SELECT
        set_config('app.tenant_id', $1, true),
        set_config('app.workspace_id', $2, true),
        set_config('app.actor_id', $3, true)`,
      [input.tenantId, input.workspaceId, input.actorUserId],
    );
    await expect(client.query(input.sql, input.values)).rejects.toMatchObject({ code: input.code });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('Task 9 Artifact generation, lineage and exact revision review', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: ApiTestApp;
  let payloads: InMemoryArtifactPayloadStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    payloads = new InMemoryArtifactPayloadStore();
    await runMigrations(
      pool,
      fileURLToPath(new URL('../../packages/db/migrations', import.meta.url)),
    );
    app = await createApiApp({
      oidcClient,
      store: new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 9))),
      artifactStore: new PostgresArtifactStore(pool),
      artifactPayloadStore: payloads,
      evidenceClaimStore: new PostgresEvidenceClaimStore(pool),
      jobBudgetStore: new PostgresJobBudgetStore(pool),
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

  test('an Editor starts deterministic generation from an approved Brief', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session);
    const { briefId } = await seedApprovedBrief(pool, scope);
    await setBudget(app, session, scope);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/artifacts`,
      headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
      payload: {
        briefId,
        locale: 'en-SG',
        market: 'SG',
        methodPolicyVersion: 'artifact-fixture-v1',
        idempotencyKey: randomUUID(),
        estimatedUnits: 1,
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      data: {
        artifact: { status: 'PENDING', revision: 1 },
        job: { jobType: 'ARTIFACT_GENERATION', status: 'QUEUED', estimatedUnits: 5 },
      },
    });
  });

  test('an approved Brief from another Workspace cannot start Artifact generation', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session);
    const { briefId } = await seedApprovedBrief(pool, scope);
    const secondWorkspaceId = await addWorkspaceForCurrentOwner(pool, scope);
    const secondScope = { tenant: scope.tenant, workspace: { id: secondWorkspaceId } };
    await setBudget(app, session, secondScope);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${secondWorkspaceId}/artifacts`,
      headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
      payload: {
        briefId,
        locale: 'en-SG',
        market: 'SG',
        methodPolicyVersion: 'artifact-fixture-v1',
        idempotencyKey: randomUUID(),
        estimatedUnits: 30,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'ARTIFACT_INVALID_REFERENCE',
      referenceType: 'APPROVED_BRIEF',
    });
  });

  test('a dangling source Artifact reference is rejected instead of being echoed', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session);
    const fixture = await seedApprovedBrief(pool, scope);
    const danglingSourceId = randomUUID();
    const sourceArtifactIds = [
      danglingSourceId,
      fixture.offeringRevisionId,
      fixture.promptRevisionId,
      fixture.baselineId,
    ];
    await pool.query(
      `UPDATE content_plans
       SET input_snapshot = jsonb_set(input_snapshot, '{availableSourceArtifactIds}', $1::jsonb)
       WHERE id = $2`,
      [JSON.stringify(sourceArtifactIds), fixture.planId],
    );
    await pool.query(`UPDATE briefs SET source_artifact_ids = $1::jsonb WHERE id = $2`, [
      JSON.stringify(sourceArtifactIds),
      fixture.briefId,
    ]);
    await setBudget(app, session, scope);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/artifacts`,
      headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
      payload: {
        briefId: fixture.briefId,
        locale: 'en-SG',
        market: 'SG',
        methodPolicyVersion: 'artifact-fixture-v1',
        idempotencyKey: randomUUID(),
        estimatedUnits: 30,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'ARTIFACT_INVALID_REFERENCE',
      referenceType: 'SOURCE_ARTIFACTS',
    });
  });

  test('the approved Brief type selects each of the three auditable Artifact shapes', async () => {
    const session = await signIn(app);
    const labels = {
      DEFINITION_PRODUCT: 'Definition and offering',
      COMPARISON: 'Evidence-balanced comparison',
      TECHNICAL_EVIDENCE: 'Technical and evidence',
    } as const;
    for (const artifactType of Object.keys(labels) as (keyof typeof labels)[]) {
      const scope = await createScope(app, session);
      const { briefId } = await seedApprovedBrief(pool, scope, artifactType);
      await setBudget(app, session, scope);
      const startedResponse = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/artifacts`,
        headers: {
          cookie: `__Host-aeo_session=${session}`,
          origin: 'https://app.example.test',
        },
        payload: {
          briefId,
          locale: 'zh-CN',
          market: 'Global',
          methodPolicyVersion: 'artifact-fixture-v1',
          idempotencyKey: randomUUID(),
          estimatedUnits: 30,
        },
      });
      const started = StartArtifactGenerationEnvelopeSchema.parse(startedResponse.json()).data;
      const clock = { now: () => new Date('2026-07-21T05:45:00.000Z') };
      const worker = new ArtifactGenerationJobWorker(
        new JobWorkerCoordinator(
          new PostgresJobBudgetStore(pool),
          clock,
          { next: randomUUID },
          'artifact-generation-v1',
        ),
        new ArtifactGenerationHandler(
          new PostgresArtifactStore(pool),
          new DeterministicArtifactGenerator(),
          payloads,
          { next: randomUUID },
          clock,
        ),
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
      const bundle = (
        await app.inject({
          method: 'GET',
          url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/artifacts/${started.artifact.id}`,
          headers: { cookie: `__Host-aeo_session=${session}` },
        })
      ).json<{
        data: {
          artifact: { type: string };
          revision: { type: string; sourceArtifactIds: string[]; claimBindings: unknown[] };
          payload: { title: string };
        };
      }>().data;
      expect(bundle.artifact.type).toBe(artifactType);
      expect(bundle.revision).toMatchObject({ type: artifactType });
      expect(bundle.revision.sourceArtifactIds).toHaveLength(4);
      expect(bundle.revision.claimBindings).toHaveLength(1);
      expect(bundle.payload.title).toMatch(new RegExp(`^${labels[artifactType]}`));
    }
  });

  test('the Writer receives restricted approved context and persists exact lineage', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session);
    const fixture = await seedApprovedBrief(pool, scope);
    const { briefId } = fixture;
    await setBudget(app, session, scope);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/artifacts`,
      headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
      payload: {
        briefId,
        locale: 'en-SG',
        market: 'SG',
        methodPolicyVersion: 'artifact-fixture-v1',
        idempotencyKey: randomUUID(),
        estimatedUnits: 30,
      },
    });
    const started = StartArtifactGenerationEnvelopeSchema.parse(response.json()).data;
    const observed: ArtifactWriterContext[] = [];
    const fixtureGenerator = new DeterministicArtifactGenerator();
    const generator: ArtifactGenerator = {
      generate(context: ArtifactWriterContext): Promise<ArtifactPayload> {
        observed.push(structuredClone(context));
        return fixtureGenerator.generate(context);
      },
    };
    const clock = { now: () => new Date('2026-07-21T05:30:00.000Z') };
    const jobStore = new PostgresJobBudgetStore(pool);
    const worker = new ArtifactGenerationJobWorker(
      new JobWorkerCoordinator(jobStore, clock, { next: randomUUID }, 'artifact-generation-v1'),
      new ArtifactGenerationHandler(
        new PostgresArtifactStore(pool),
        generator,
        payloads,
        { next: randomUUID },
        clock,
      ),
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
    ).toMatchObject({ outcome: 'SUCCEEDED', artifactId: started.artifact.id });
    expect(observed).toHaveLength(1);
    expect(Object.keys(observed[0] ?? {}).sort()).toEqual([
      'brief',
      'claims',
      'locale',
      'market',
      'methodPolicyVersion',
      'schemaVersion',
      'type',
    ]);
    expect(JSON.stringify(observed[0])).not.toMatch(/secret|token|password|email|account/i);
    const artifactResponse = await app.inject({
      method: 'GET',
      url:
        `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/artifacts/` +
        started.artifact.id,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(artifactResponse.statusCode).toBe(200);
    const artifactDocument = ArtifactBundleEnvelopeSchema.parse(artifactResponse.json());
    expect(artifactDocument.data.artifact).toMatchObject({
      id: started.artifact.id,
      status: 'DRAFT',
      revision: 1,
    });
    const revision = artifactDocument.data.revision;
    const payload = artifactDocument.data.payload;
    expect(revision).not.toBeNull();
    expect(payload).not.toBeNull();
    if (revision === null || payload === null) throw new Error('ARTIFACT_PAYLOAD_MISSING');
    expect(revision).toMatchObject({
      revision: 1,
      type: 'DEFINITION_PRODUCT',
      schemaVersion: '1.0.0',
      locale: 'en-SG',
      market: 'SG',
      methodPolicyVersion: 'artifact-fixture-v1',
    });
    expect(revision.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(revision.payloadObjectRef).toMatch(/^s3:\/\/artifact-fixture\//);
    for (const sourceId of observed[0]?.brief.sourceArtifactIds ?? []) {
      expect(revision.sourceArtifactIds).toContain(sourceId);
    }
    const firstBinding = revision.claimBindings[0];
    expect(firstBinding?.claimRevisionId).toBe(observed[0]?.claims[0]?.revisionId);
    expect(firstBinding?.evidence[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.title.length).toBeGreaterThan(0);
    expect(payload.sections.length).toBeGreaterThan(0);
    expect(
      payload.claimMap.some((entry) => entry.claimRevisionId === firstBinding?.claimRevisionId),
    ).toBe(true);
    expect(revision.lineage).toMatchObject({
      contentPlanId: fixture.planId,
      brief: { id: fixture.briefId, contentHash: 'd'.repeat(64) },
      prompt: {
        promptSetId: fixture.promptSetId,
        promptRevisionId: fixture.promptRevisionId,
        contentHash: '7'.repeat(64),
        promptIds: [fixture.promptId],
      },
      sourceReferences: [
        { kind: 'PROFILE_REVISION', id: fixture.profileRevisionId },
        { kind: 'OFFERING_REVISION', id: fixture.offeringRevisionId },
        { kind: 'PROMPT_REVISION', id: fixture.promptRevisionId },
        { kind: 'SITE_BASELINE', id: fixture.baselineId },
      ],
    });
    expect(revision.claimBindings).toEqual([
      expect.objectContaining({
        claimId: fixture.claimId,
        claimRevisionId: fixture.claimRevisionId,
      }),
    ]);
    const exactPromptResponse = await app.inject({
      method: 'GET',
      url:
        `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
        `/prompt-sets/${fixture.promptSetId}/revisions/${fixture.promptRevisionId}`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(exactPromptResponse.statusCode, exactPromptResponse.body).toBe(200);
    expect(exactPromptResponse.json()).toMatchObject({
      data: {
        promptSet: { id: fixture.promptSetId },
        revision: { id: fixture.promptRevisionId, contentHash: '7'.repeat(64) },
      },
    });
    const exactClaimResponse = await app.inject({
      method: 'GET',
      url:
        `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
        `/claims/${fixture.claimId}/revisions/${fixture.claimRevisionId}`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(exactClaimResponse.statusCode, exactClaimResponse.body).toBe(200);
    expect(exactClaimResponse.json()).toMatchObject({
      data: {
        claim: { id: fixture.claimId },
        revision: { id: fixture.claimRevisionId, contentHash: 'b'.repeat(64) },
      },
    });

    const sameTenantOtherWorkspaceId = await addWorkspaceForExistingTenant(pool, scope.tenant.id);
    const crossWorkspacePrompt = await app.inject({
      method: 'GET',
      url:
        `/api/v1/tenants/${scope.tenant.id}/workspaces/${sameTenantOtherWorkspaceId}` +
        `/prompt-sets/${fixture.promptSetId}/revisions/${fixture.promptRevisionId}`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(crossWorkspacePrompt.statusCode).toBe(404);
    expect(crossWorkspacePrompt.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });
    const crossWorkspaceClaim = await app.inject({
      method: 'GET',
      url:
        `/api/v1/tenants/${scope.tenant.id}/workspaces/${sameTenantOtherWorkspaceId}` +
        `/claims/${fixture.claimId}/revisions/${fixture.claimRevisionId}`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(crossWorkspaceClaim.statusCode).toBe(404);
    expect(crossWorkspaceClaim.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });

    const foreignScope = await createScope(app, session);
    const crossTenantResponse = await app.inject({
      method: 'GET',
      url:
        `/api/v1/tenants/${foreignScope.tenant.id}/workspaces/${foreignScope.workspace.id}` +
        `/artifacts/${started.artifact.id}`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(crossTenantResponse.statusCode).toBe(404);
    expect(crossTenantResponse.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });
  });

  test('a generator payload that diverges from approved Claim bindings fails closed before storage', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session);
    const { briefId } = await seedApprovedBrief(pool, scope);
    await setBudget(app, session, scope);
    const startedResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/artifacts`,
      headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
      payload: {
        briefId,
        locale: 'en-SG',
        market: 'SG',
        methodPolicyVersion: 'artifact-fixture-v1',
        idempotencyKey: randomUUID(),
        estimatedUnits: 30,
      },
    });
    const started = StartArtifactGenerationEnvelopeSchema.parse(startedResponse.json()).data;
    const deterministic = new DeterministicArtifactGenerator();
    const maliciousGenerator: ArtifactGenerator = {
      async generate(context) {
        return { ...(await deterministic.generate(context)), claimMap: [] };
      },
    };
    let payloadWrites = 0;
    const rejectingBoundaryStore: ArtifactPayloadStore = {
      get: (objectRef) => payloads.get(objectRef),
      put: async (input) => {
        payloadWrites += 1;
        return payloads.put(input);
      },
    };
    const clock = { now: () => new Date('2026-07-21T06:05:00.000Z') };
    const worker = new ArtifactGenerationJobWorker(
      new JobWorkerCoordinator(
        new PostgresJobBudgetStore(pool),
        clock,
        { next: randomUUID },
        'artifact-generation-v1',
      ),
      new ArtifactGenerationHandler(
        new PostgresArtifactStore(pool),
        maliciousGenerator,
        rejectingBoundaryStore,
        { next: randomUUID },
        clock,
      ),
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
    ).toMatchObject({ outcome: 'FAILED_TERMINAL', artifactId: started.artifact.id });
    expect(payloadWrites).toBe(0);
  });

  test('generation fails closed when its Content Plan is invalidated after the Job is queued', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session);
    const { briefId, planId } = await seedApprovedBrief(pool, scope);
    await setBudget(app, session, scope);
    const startedResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/artifacts`,
      headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
      payload: {
        briefId,
        locale: 'en-SG',
        market: 'SG',
        methodPolicyVersion: 'artifact-fixture-v1',
        idempotencyKey: randomUUID(),
        estimatedUnits: 30,
      },
    });
    const started = StartArtifactGenerationEnvelopeSchema.parse(startedResponse.json()).data;
    await pool.query(`UPDATE content_plans SET status = 'INVALID' WHERE id = $1`, [planId]);
    let payloadWrites = 0;
    const observedPayloads: ArtifactPayloadStore = {
      get: (objectRef) => payloads.get(objectRef),
      put: async (input) => {
        payloadWrites += 1;
        return payloads.put(input);
      },
    };
    const clock = { now: () => new Date('2026-07-21T06:07:00.000Z') };
    const worker = new ArtifactGenerationJobWorker(
      new JobWorkerCoordinator(
        new PostgresJobBudgetStore(pool),
        clock,
        { next: randomUUID },
        'artifact-generation-v1',
      ),
      new ArtifactGenerationHandler(
        new PostgresArtifactStore(pool),
        new DeterministicArtifactGenerator(),
        observedPayloads,
        { next: randomUUID },
        clock,
      ),
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
    ).toMatchObject({ outcome: 'FAILED_TERMINAL', artifactId: started.artifact.id });
    expect(payloadWrites).toBe(0);
  });

  test('review rejects a payload whose bytes no longer match the immutable revision hash', async () => {
    const corruptiblePayloads = new CorruptibleArtifactPayloadStore();
    const integrityApp = await createApiApp({
      oidcClient,
      store: new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 9))),
      artifactStore: new PostgresArtifactStore(pool),
      artifactPayloadStore: corruptiblePayloads,
      artifactPayloadReader: {
        readAuthenticatedArtifactRevision: ({ expected }) =>
          corruptiblePayloads.get(expected.objectRef),
      },
      jobBudgetStore: new PostgresJobBudgetStore(pool),
      tenancyStore: new PostgresTenancyStore(pool),
      webOrigin: 'https://app.example.test',
    });
    try {
      const session = await signIn(integrityApp);
      const scope = await createScope(integrityApp, session);
      const { briefId } = await seedApprovedBrief(pool, scope);
      await setBudget(integrityApp, session, scope);
      const startedResponse = await integrityApp.inject({
        method: 'POST',
        url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/artifacts`,
        headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
        payload: {
          briefId,
          locale: 'en-SG',
          market: 'SG',
          methodPolicyVersion: 'artifact-fixture-v1',
          idempotencyKey: randomUUID(),
          estimatedUnits: 30,
        },
      });
      const started = StartArtifactGenerationEnvelopeSchema.parse(startedResponse.json()).data;
      const clock = { now: () => new Date('2026-07-21T06:10:00.000Z') };
      const worker = new ArtifactGenerationJobWorker(
        new JobWorkerCoordinator(
          new PostgresJobBudgetStore(pool),
          clock,
          { next: randomUUID },
          'artifact-generation-v1',
        ),
        new ArtifactGenerationHandler(
          new PostgresArtifactStore(pool),
          new DeterministicArtifactGenerator(),
          corruptiblePayloads,
          { next: randomUUID },
          clock,
        ),
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
      const artifactUrl =
        `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/artifacts/` +
        started.artifact.id;
      const bundle = ArtifactBundleEnvelopeSchema.parse(
        (
          await integrityApp.inject({
            method: 'GET',
            url: artifactUrl,
            headers: { cookie: `__Host-aeo_session=${session}` },
          })
        ).json(),
      ).data;
      if (bundle.revision === null || bundle.payload === null) {
        throw new Error('ARTIFACT_INTEGRITY_FIXTURE_MISSING');
      }
      expect(
        (
          await integrityApp.inject({
            method: 'POST',
            url: `${artifactUrl}/revisions/1/submit`,
            headers: {
              cookie: `__Host-aeo_session=${session}`,
              origin: 'https://app.example.test',
            },
            payload: { expectedContentHash: bundle.revision.contentHash },
          })
        ).statusCode,
      ).toBe(200);
      corruptiblePayloads.corrupt(bundle.revision.payloadObjectRef, {
        ...bundle.payload,
        summary: `${bundle.payload.summary} tampered`,
      });
      const review = await integrityApp.inject({
        method: 'POST',
        url: `${artifactUrl}/revisions/1/review`,
        headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
        payload: {
          decision: 'APPROVE',
          expectedContentHash: bundle.revision.contentHash,
          note: 'Exact bytes reviewed.',
        },
      });
      expect(review.statusCode).toBe(409);
      expect(review.json()).toMatchObject({ code: 'ARTIFACT_PAYLOAD_INTEGRITY' });
    } finally {
      await integrityApp.close();
    }
  });

  test('an approved Artifact becomes stale when its frozen Content Plan is invalidated', async () => {
    const session = await signIn(app);
    const scope = await createScope(app, session);
    const { briefId, planId } = await seedApprovedBrief(pool, scope);
    await setBudget(app, session, scope);
    const startedResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/artifacts`,
      headers: { cookie: `__Host-aeo_session=${session}`, origin: 'https://app.example.test' },
      payload: {
        briefId,
        locale: 'en-SG',
        market: 'SG',
        methodPolicyVersion: 'artifact-fixture-v1',
        idempotencyKey: randomUUID(),
        estimatedUnits: 30,
      },
    });
    const started = StartArtifactGenerationEnvelopeSchema.parse(startedResponse.json()).data;
    const clock = { now: () => new Date('2026-07-21T06:15:00.000Z') };
    const worker = new ArtifactGenerationJobWorker(
      new JobWorkerCoordinator(
        new PostgresJobBudgetStore(pool),
        clock,
        { next: randomUUID },
        'artifact-generation-v1',
      ),
      new ArtifactGenerationHandler(
        new PostgresArtifactStore(pool),
        new DeterministicArtifactGenerator(),
        payloads,
        { next: randomUUID },
        clock,
      ),
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
    const artifactUrl =
      `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/artifacts/` +
      started.artifact.id;
    const beforeReview = ArtifactBundleEnvelopeSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: artifactUrl,
          headers: { cookie: `__Host-aeo_session=${session}` },
        })
      ).json(),
    ).data;
    if (beforeReview.revision === null) throw new Error('ARTIFACT_REVISION_MISSING');
    const mutationHeaders = {
      cookie: `__Host-aeo_session=${session}`,
      origin: 'https://app.example.test',
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${artifactUrl}/revisions/1/submit`,
          headers: mutationHeaders,
          payload: { expectedContentHash: beforeReview.revision.contentHash },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${artifactUrl}/revisions/1/review`,
          headers: mutationHeaders,
          payload: {
            decision: 'APPROVE',
            expectedContentHash: beforeReview.revision.contentHash,
            note: 'Exact Agent-generated revision approved.',
          },
        })
      ).statusCode,
    ).toBe(200);

    await pool.query(`UPDATE content_plans SET status = 'INVALID' WHERE id = $1`, [planId]);
    const invalidated = ArtifactBundleEnvelopeSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: artifactUrl,
          headers: { cookie: `__Host-aeo_session=${session}` },
        })
      ).json(),
    ).data;
    expect(invalidated.approvalState).toBe('APPROVAL_STALE');
    expect(invalidated.selectableApprovedRevisions).toEqual([]);
    if (invalidated.payload === null) throw new Error('INVALIDATED_ARTIFACT_PAYLOAD_MISSING');
    const reviseAfterPlanInvalidation = await app.inject({
      method: 'POST',
      url: `${artifactUrl}/revisions`,
      headers: mutationHeaders,
      payload: {
        expectedRevision: 1,
        payload: { ...invalidated.payload, summary: `${invalidated.payload.summary}X` },
      },
    });
    expect(reviseAfterPlanInvalidation.statusCode).toBe(409);
    expect(reviseAfterPlanInvalidation.json()).toMatchObject({ code: 'APPROVAL_STALE' });
    const persistedRevisionCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM artifact_revisions WHERE artifact_id = $1`,
      [started.artifact.id],
    );
    expect(persistedRevisionCount.rows[0]?.count).toBe('1');
  });

  test('approval is exact to revision and hash while an unchanged approved R1 remains selectable', async () => {
    const ownerSession = await signIn(app);
    const scope = await createScope(app, ownerSession);
    const { briefId } = await seedApprovedBrief(pool, scope);
    await setBudget(app, ownerSession, scope);
    const invitation = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/invitations`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { email: 'artifact-reviewer@example.test', role: 'REVIEWER' },
    });
    const membershipId = invitation.json<{ data: { membership: { id: string } } }>().data.membership
      .id;
    const reviewerSession = await signIn(app, 'artifact-reviewer-code');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/memberships/${membershipId}/accept`,
          headers: {
            cookie: `__Host-aeo_session=${reviewerSession}`,
            origin: 'https://app.example.test',
          },
        })
      ).statusCode,
    ).toBe(200);
    const startedResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/artifacts`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        briefId,
        locale: 'en-SG',
        market: 'SG',
        methodPolicyVersion: 'artifact-fixture-v1',
        idempotencyKey: randomUUID(),
        estimatedUnits: 30,
      },
    });
    const started = StartArtifactGenerationEnvelopeSchema.parse(startedResponse.json()).data;
    const clock = { now: () => new Date('2026-07-21T06:00:00.000Z') };
    const worker = new ArtifactGenerationJobWorker(
      new JobWorkerCoordinator(
        new PostgresJobBudgetStore(pool),
        clock,
        { next: randomUUID },
        'artifact-generation-v1',
      ),
      new ArtifactGenerationHandler(
        new PostgresArtifactStore(pool),
        new DeterministicArtifactGenerator(),
        payloads,
        { next: randomUUID },
        clock,
      ),
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
    const artifactUrl = `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/artifacts/${started.artifact.id}`;
    const beforeReview = (
      await app.inject({
        method: 'GET',
        url: artifactUrl,
        headers: { cookie: `__Host-aeo_session=${ownerSession}` },
      })
    ).json<{ data: { revision: { contentHash: string }; payload: ArtifactPayload } }>().data;
    const mutationHeaders = {
      cookie: `__Host-aeo_session=${ownerSession}`,
      origin: 'https://app.example.test',
    };
    const submitR1 = await app.inject({
      method: 'POST',
      url: `${artifactUrl}/revisions/1/submit`,
      headers: mutationHeaders,
      payload: { expectedContentHash: beforeReview.revision.contentHash },
    });
    expect(submitR1.statusCode).toBe(200);
    expect(submitR1.json()).toMatchObject({ data: { revision: { status: 'IN_REVIEW' } } });
    const reviewUrl = `${artifactUrl}/revisions/1/review`;
    const wrongHash = await app.inject({
      method: 'POST',
      url: reviewUrl,
      headers: {
        cookie: `__Host-aeo_session=${reviewerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { decision: 'APPROVE', expectedContentHash: 'f'.repeat(64), note: 'Wrong hash.' },
    });
    expect(wrongHash.statusCode).toBe(409);
    expect(wrongHash.json()).toMatchObject({ code: 'ARTIFACT_REVIEW_HASH_MISMATCH' });
    const approvedR1 = await app.inject({
      method: 'POST',
      url: reviewUrl,
      headers: {
        cookie: `__Host-aeo_session=${reviewerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        decision: 'APPROVE',
        expectedContentHash: beforeReview.revision.contentHash,
        note: 'Lineage and claims verified.',
      },
    });
    expect(approvedR1.statusCode).toBe(200);
    const approvedR1Document = approvedR1.json<{
      data: {
        revision: { id: string; contentHash: string };
        review: { id: string; contentHash: string };
      };
    }>();
    expect(approvedR1Document).toMatchObject({
      data: {
        revision: {
          revision: 1,
          status: 'APPROVED',
          contentHash: beforeReview.revision.contentHash,
        },
        review: {
          revision: 1,
          decision: 'APPROVE',
          contentHash: beforeReview.revision.contentHash,
        },
      },
    });
    const audit = await pool.query<{
      action: string;
      actor_user_id: string;
      actor_kind: 'USER' | 'AGENT';
      actor_id: string;
      metadata: Record<string, unknown>;
      occurred_at: Date;
    }>(
      `SELECT action, actor_user_id, actor_kind, actor_id, metadata, occurred_at
       FROM audit_events
       WHERE tenant_id = $1
         AND resource_id = $2
         AND action IN ('ARTIFACT_REVISION_GENERATED', 'ARTIFACT_REVISION_REVIEWED')
       ORDER BY action`,
      [scope.tenant.id, approvedR1Document.data.revision.id],
    );
    const generatedAudit = audit.rows.find(
      (entry) => entry.action === 'ARTIFACT_REVISION_GENERATED',
    );
    const reviewedAudit = audit.rows.find((entry) => entry.action === 'ARTIFACT_REVISION_REVIEWED');
    expect(generatedAudit?.actor_kind).toBe('AGENT');
    expect(generatedAudit?.actor_id).toBe(started.job.id);
    expect(generatedAudit?.occurred_at.toISOString()).toBe('2026-07-21T06:00:00.000Z');
    expect(reviewedAudit?.actor_kind).toBe('USER');
    expect(reviewedAudit?.actor_id).toBe(reviewedAudit?.actor_user_id);
    expect(reviewedAudit?.occurred_at).toBeInstanceOf(Date);
    expect(JSON.stringify(audit.rows)).not.toMatch(/Artifact fixture claim|fixture excerpt/i);
    const owner = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM memberships WHERE tenant_id = $1 AND status = 'ACTIVE'
       ORDER BY created_at LIMIT 1`,
      [scope.tenant.id],
    );
    const ownerUserId = owner.rows[0]?.user_id;
    if (ownerUserId === undefined) throw new Error('ARTIFACT_OWNER_NOT_FOUND');
    await expectRuntimeMutationDenied({
      pool,
      tenantId: scope.tenant.id,
      workspaceId: scope.workspace.id,
      actorUserId: ownerUserId,
      sql: `UPDATE artifacts SET locale = 'fr-FR' WHERE id = $1`,
      values: [started.artifact.id],
      code: '42501',
    });
    await expectRuntimeMutationDenied({
      pool,
      tenantId: scope.tenant.id,
      workspaceId: scope.workspace.id,
      actorUserId: ownerUserId,
      sql: `UPDATE artifacts SET status = 'REJECTED' WHERE id = $1`,
      values: [started.artifact.id],
      code: 'P0001',
    });
    await expectRuntimeMutationDenied({
      pool,
      tenantId: scope.tenant.id,
      workspaceId: scope.workspace.id,
      actorUserId: ownerUserId,
      sql: `UPDATE artifact_revisions SET content_hash = $1 WHERE id = $2`,
      values: ['0'.repeat(64), approvedR1Document.data.revision.id],
      code: '42501',
    });
    await expectRuntimeMutationDenied({
      pool,
      tenantId: scope.tenant.id,
      workspaceId: scope.workspace.id,
      actorUserId: ownerUserId,
      sql: `DELETE FROM artifact_reviews WHERE id = $1`,
      values: [approvedR1Document.data.review.id],
      code: '42501',
    });
    await expectRuntimeMutationDenied({
      pool,
      tenantId: scope.tenant.id,
      workspaceId: scope.workspace.id,
      actorUserId: ownerUserId,
      sql: `UPDATE artifact_revisions SET status = 'REJECTED' WHERE id = $1`,
      values: [approvedR1Document.data.revision.id],
      code: 'P0001',
    });
    const divergentPayload = structuredClone(beforeReview.payload);
    divergentPayload.claimMap = [];
    const divergentRevision = await app.inject({
      method: 'POST',
      url: `${artifactUrl}/revisions`,
      headers: mutationHeaders,
      payload: { expectedRevision: 1, payload: divergentPayload },
    });
    expect(divergentRevision.statusCode).toBe(409);
    expect(divergentRevision.json()).toMatchObject({ code: 'APPROVAL_STALE' });
    const r2Payload = structuredClone(beforeReview.payload);
    r2Payload.summary += '!';
    const createR2 = await app.inject({
      method: 'POST',
      url: `${artifactUrl}/revisions`,
      headers: mutationHeaders,
      payload: { expectedRevision: 1, payload: r2Payload },
    });
    expect(createR2.statusCode).toBe(201);
    const r2 = createR2.json<{ data: { revision: { contentHash: string } } }>().data.revision;
    expect(r2.contentHash).not.toBe(beforeReview.revision.contentHash);
    const afterChange = await app.inject({
      method: 'GET',
      url: artifactUrl,
      headers: { cookie: `__Host-aeo_session=${ownerSession}` },
    });
    expect(afterChange.json()).toMatchObject({
      data: {
        artifact: { revision: 2, status: 'DRAFT' },
        revision: { revision: 2, status: 'DRAFT', contentHash: r2.contentHash },
        payload: { summary: r2Payload.summary },
        previousPayload: { summary: beforeReview.payload.summary },
        approvalState: 'APPROVAL_STALE',
        selectableApprovedRevisions: [
          { revision: 1, contentHash: beforeReview.revision.contentHash },
        ],
        revisions: [
          { revision: 1, status: 'APPROVED' },
          { revision: 2, status: 'DRAFT' },
        ],
      },
    });
    const submitR2 = await app.inject({
      method: 'POST',
      url: `${artifactUrl}/revisions/2/submit`,
      headers: mutationHeaders,
      payload: { expectedContentHash: r2.contentHash },
    });
    expect(submitR2.statusCode).toBe(200);
    const selfApproval = await app.inject({
      method: 'POST',
      url: `${artifactUrl}/revisions/2/review`,
      headers: mutationHeaders,
      payload: { decision: 'APPROVE', expectedContentHash: r2.contentHash, note: 'Self approve.' },
    });
    expect(selfApproval.statusCode).toBe(409);
    expect(selfApproval.json()).toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
    const rejectedR2 = await app.inject({
      method: 'POST',
      url: `${artifactUrl}/revisions/2/review`,
      headers: {
        cookie: `__Host-aeo_session=${reviewerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        decision: 'REJECT',
        expectedContentHash: r2.contentHash,
        note: 'Exact R2 needs revision.',
      },
    });
    expect(rejectedR2.statusCode).toBe(200);
    expect(rejectedR2.json()).toMatchObject({
      data: {
        revision: { revision: 2, status: 'REJECTED', contentHash: r2.contentHash },
        review: { revision: 2, decision: 'REJECT', contentHash: r2.contentHash },
      },
    });
    const r3Payload = structuredClone(r2Payload);
    r3Payload.summary += '?';
    const createR3 = await app.inject({
      method: 'POST',
      url: `${artifactUrl}/revisions`,
      headers: mutationHeaders,
      payload: { expectedRevision: 2, payload: r3Payload },
    });
    expect(createR3.statusCode).toBe(201);
    const r3 = createR3.json<{ data: { revision: { contentHash: string } } }>().data.revision;
    const submitR3 = await app.inject({
      method: 'POST',
      url: `${artifactUrl}/revisions/3/submit`,
      headers: mutationHeaders,
      payload: { expectedContentHash: r3.contentHash },
    });
    expect(submitR3.statusCode).toBe(200);
    await pool.query(
      `UPDATE claim_revisions SET expires_at = '2026-07-20T00:00:00.000Z'
       WHERE id IN (
         SELECT value::uuid FROM briefs, jsonb_array_elements_text(claim_revision_ids)
         WHERE briefs.id = $1
       )`,
      [briefId],
    );
    const staleReview = await app.inject({
      method: 'POST',
      url: `${artifactUrl}/revisions/3/review`,
      headers: {
        cookie: `__Host-aeo_session=${reviewerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        decision: 'APPROVE',
        expectedContentHash: r3.contentHash,
        note: 'Exact R3 verified.',
      },
    });
    expect(staleReview.statusCode).toBe(409);
    expect(staleReview.json()).toMatchObject({ code: 'APPROVAL_STALE' });
    const afterClaimExpiry = await app.inject({
      method: 'GET',
      url: artifactUrl,
      headers: { cookie: `__Host-aeo_session=${ownerSession}` },
    });
    expect(afterClaimExpiry.json()).toMatchObject({
      data: {
        artifact: { revision: 3, status: 'IN_REVIEW' },
        approvalState: 'APPROVAL_STALE',
        selectableApprovedRevisions: [],
      },
    });
  });
});
