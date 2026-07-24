import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  createReviewedManualMeasurementImportAdapterRegistry,
  manualMeasurementImportHash,
  type MeasurementStore,
  type MeasurementSurfaceAdapter,
  type MeasurementSurfaceExecutionResult,
} from '@aeostudio/application/measurement';
import type {
  AuthorizationRequest,
  ExchangeCodeInput,
  OidcClient,
} from '@aeostudio/application/auth';
import { JobWorkerCoordinator } from '@aeostudio/application/jobs-budgets';
import {
  ManualMeasurementImportDetailEnvelopeSchema,
  MeasurementDashboardEnvelopeSchema,
  MeasurementProviderPolicyStateEnvelopeSchema,
  MeasurementPromptRunListEnvelopeSchema,
  MeasurementRunEnvelopeSchema,
  PromptRunEnvelopeSchema,
  StartMeasurementRunEnvelopeSchema,
} from '@aeostudio/contracts/measurement';
import { PromptBundleEnvelopeSchema } from '@aeostudio/contracts/prompt-research';
import {
  buildMetricSnapshot,
  type MetricClassification,
  type MetricCohort,
} from '@aeostudio/domain/measurement';
import {
  AesGcmSessionCipher,
  PostgresAuthStore,
  PostgresJobBudgetStore,
  PostgresManualMeasurementImportStore,
  PostgresMeasurementRawEvidenceStore,
  PostgresMeasurementStore,
  PostgresProfileOfferingStore,
  PostgresPromptResearchStore,
  PostgresTenancyStore,
  runMigrations,
} from '@aeostudio/db';
import {
  createMeasurementWorkerRuntime,
  MeasurementExecutionHandler,
  MeasurementRunJobWorker,
  PostgresMeasurementOutboxQueue,
} from '@aeostudio/worker';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createApiApp } from '../../apps/api/src/app.js';

type ApiTestApp = Awaited<ReturnType<typeof createApiApp>>;
type ScopeIds = { tenant: { id: string }; workspace: { id: string } };

const providerKey = 'fixture-provider';
const surfaceKey = 'consumer-answer-sandbox';
const adapterVersion = 'fixture-v1';
const acquisitionMethod = 'MANUAL_IMPORT';
const observationMethodVersion = 'answer-observation-v1';
const snapshotMethodVersion = 'ai-visibility-snapshot-v1';

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
    const identities: Record<string, { subject: string; email: string }> = {
      'measurement-owner-a-code': {
        subject: 'measurement-owner-a-subject',
        email: 'measurement-owner-a@example.test',
      },
      'measurement-analyst-code': {
        subject: 'measurement-analyst-subject',
        email: 'measurement-analyst@example.test',
      },
      'measurement-publisher-code': {
        subject: 'measurement-publisher-subject',
        email: 'measurement-publisher@example.test',
      },
      'measurement-reviewer-code': {
        subject: 'measurement-reviewer-subject',
        email: 'measurement-reviewer@example.test',
      },
      'measurement-owner-b-code': {
        subject: 'measurement-owner-b-subject',
        email: 'measurement-owner-b@example.test',
      },
    };
    const identity = identities[input.code] ?? identities['measurement-owner-a-code'];
    if (identity === undefined) throw new Error('MEASUREMENT_IDENTITY_FIXTURE_MISSING');
    return Promise.resolve({ ...identity, emailVerified: true });
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
  const session = callback.cookies.find((cookie) => cookie.name === '__Host-aeo_session')?.value;
  if (session === undefined) throw new Error('MEASUREMENT_TEST_LOGIN_FAILED');
  return session;
}

async function createScope(app: ApiTestApp, session: string, suffix: string): Promise<ScopeIds> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: {
      cookie: `__Host-aeo_session=${session}`,
      origin: 'https://app.example.test',
    },
    payload: { tenantName: `${suffix} Tenant`, workspaceName: `${suffix} Workspace` },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ data: ScopeIds }>().data;
}

async function inviteAndAccept(input: {
  app: ApiTestApp;
  ownerSession: string;
  scope: ScopeIds;
  role: 'ANALYST' | 'PUBLISHER' | 'REVIEWER';
  email: string;
  code: string;
}): Promise<string> {
  const invitation = await input.app.inject({
    method: 'POST',
    url:
      `/api/v1/tenants/${input.scope.tenant.id}/workspaces/${input.scope.workspace.id}` +
      '/invitations',
    headers: {
      cookie: `__Host-aeo_session=${input.ownerSession}`,
      origin: 'https://app.example.test',
    },
    payload: { email: input.email, role: input.role },
  });
  expect(invitation.statusCode, invitation.body).toBe(201);
  const membershipId = invitation.json<{ data: { membership: { id: string } } }>().data.membership
    .id;
  const session = await signIn(input.app, input.code);
  const accepted = await input.app.inject({
    method: 'POST',
    url:
      `/api/v1/tenants/${input.scope.tenant.id}/workspaces/${input.scope.workspace.id}` +
      `/memberships/${membershipId}/accept`,
    headers: {
      cookie: `__Host-aeo_session=${session}`,
      origin: 'https://app.example.test',
    },
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  return session;
}

async function createApprovedPromptScenario(
  app: ApiTestApp,
  ownerSession: string,
  analystSession: string,
  scope: ScopeIds,
  measurementScopes = [{ market: 'SG', locale: 'en-SG', region: 'Singapore' }],
  scenarioOverride: Partial<{
    providerKey: string;
    surfaceKey: string;
    model: string;
    modelVersion: string;
    account: string;
    acquisitionMethod: string;
  }> = {},
) {
  const ownerHeaders = {
    cookie: `__Host-aeo_session=${ownerSession}`,
    origin: 'https://app.example.test',
  };
  const profileResponse = await app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles`,
    headers: ownerHeaders,
    payload: {
      displayName: 'Open Learning Guild',
      description: 'A community service offering guided learning sessions.',
      digitalAssets: [{ label: 'Website', url: 'https://learning.example.test' }],
      targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
    },
  });
  expect(profileResponse.statusCode, profileResponse.body).toBe(201);
  const profile = profileResponse.json<{
    data: { profile: { profileId: string; revision: number } };
  }>().data.profile;
  const offeringResponse = await app.inject({
    method: 'POST',
    url:
      `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
      `/profiles/${profile.profileId}/offerings`,
    headers: ownerHeaders,
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
  expect(offeringResponse.statusCode, offeringResponse.body).toBe(201);
  const offering = offeringResponse.json<{
    data: { offering: { offeringId: string; revision: number } };
  }>().data.offering;
  const analystHeaders = {
    cookie: `__Host-aeo_session=${analystSession}`,
    origin: 'https://app.example.test',
  };
  const proposed = await app.inject({
    method: 'POST',
    url:
      `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
      '/prompt-sets/proposals',
    headers: analystHeaders,
    payload: {
      title: 'Guided learning measurement baseline',
      subject: 'Guided Learning Sessions',
      sourceContext: {
        profile: { id: profile.profileId, revision: profile.revision },
        offering: { id: offering.offeringId, revision: offering.revision },
        claimRevisionIds: [],
      },
      scopes: measurementScopes,
      scenario: {
        providerKey: scenarioOverride.providerKey ?? providerKey,
        surfaceKey: scenarioOverride.surfaceKey ?? surfaceKey,
        model: scenarioOverride.model ?? 'fixture-search-model',
        modelVersion: scenarioOverride.modelVersion ?? '2026-07',
        account: scenarioOverride.account ?? 'workspace-fixture-account',
        acquisitionMethod: scenarioOverride.acquisitionMethod ?? acquisitionMethod,
        freshSession: true,
        searchEnabled: true,
        parameters: { temperature: 0, language: 'en' },
        repetitions: 3,
      },
    },
  });
  expect(proposed.statusCode, proposed.body).toBe(201);
  const draft = PromptBundleEnvelopeSchema.parse(proposed.json()).data;
  expect(draft.revision.prompts).toHaveLength(20);
  expect(draft.revision.scopes).toHaveLength(measurementScopes.length);
  expect(draft.scenario.repetitions).toBe(3);

  const approved = await app.inject({
    method: 'POST',
    url:
      `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
      `/prompt-sets/${draft.promptSet.id}/revisions/${draft.revision.id}/approve`,
    headers: analystHeaders,
    payload: {
      expectedPromptHash: draft.revision.contentHash,
      expectedScenarioHash: draft.scenario.contentHash,
    },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  return PromptBundleEnvelopeSchema.parse(approved.json()).data;
}

function fixtureResult(slot: number, currency = 'USD'): MeasurementSurfaceExecutionResult {
  const common = {
    providerKey,
    surfaceKey,
    acquisitionMethod,
    adapterVersion,
    methodVersion: observationMethodVersion,
    observedAt: '2026-07-21T12:00:00.000Z',
    cost: { amount: '0.001000', currency },
  };
  switch (slot) {
    case 0:
      return {
        ...common,
        status: 'PASS',
        observation: { mention: true, citation: true, accuracy: 'MATCH', coverage: true },
        rawEvidence: {
          responseText: 'The fixture answer mentions the guided learning service.',
          citations: [
            {
              url: 'https://sources.example.test/guided-learning',
              title: 'Guided learning source fixture',
              snippet: 'Recorded fixture citation for measurement verification.',
            },
          ],
          error: null,
        },
      };
    case 1:
      return {
        ...common,
        status: 'FAIL',
        observation: {
          mention: false,
          citation: false,
          accuracy: 'NOT_APPLICABLE',
          coverage: false,
        },
        rawEvidence: {
          responseText: 'The fixture answer does not mention the measured offering.',
          citations: [],
          error: null,
        },
      };
    case 2:
      return {
        ...common,
        status: 'FAIL',
        observation: { mention: true, citation: true, accuracy: 'MISMATCH', coverage: true },
        rawEvidence: {
          responseText: 'The fixture answer contains a deliberately mismatched claim.',
          citations: [
            {
              url: 'https://sources.example.test/mismatch',
              title: 'Mismatch fixture',
              snippet: 'The citation does not support the observed answer.',
            },
          ],
          error: null,
        },
      };
    case 3:
      return {
        ...common,
        status: 'ERROR',
        observation: { mention: null, citation: null, accuracy: null, coverage: null },
        rawEvidence: {
          responseText: null,
          citations: [],
          error: {
            code: 'FIXTURE_PROVIDER_TIMEOUT',
            message: 'Recorded fixture timeout; no external network was called.',
          },
        },
      };
    case 4:
      return {
        ...common,
        status: 'NOT_CHECKED',
        observation: { mention: null, citation: null, accuracy: null, coverage: null },
        rawEvidence: {
          responseText: null,
          citations: [],
          error: { code: 'FIXTURE_NOT_AVAILABLE', message: 'Recorded surface sample unavailable.' },
        },
      };
    default:
      return {
        ...common,
        status: 'INCONCLUSIVE',
        observation: { mention: null, citation: null, accuracy: null, coverage: null },
        rawEvidence: {
          responseText: 'The fixture answer cannot be classified conclusively.',
          citations: [],
          error: null,
        },
      };
  }
}

describe('Task 15 multi-Surface measurement baseline and raw evidence', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: ApiTestApp;
  let jobStore: PostgresJobBudgetStore;
  let measurementStore: PostgresMeasurementStore;
  let rawEvidenceStore: PostgresMeasurementRawEvidenceStore;
  let manualImportStore: PostgresManualMeasurementImportStore;
  let reviewedManualRuntimeAdapters: ReturnType<
    typeof createReviewedManualMeasurementImportAdapterRegistry
  >;
  let adapterExecuteCalls = 0;
  let throwNextAdapterExecution = false;
  let timeoutNextAdapterExecution = false;
  let timeoutAbortObserved = false;
  let nextAdapterCostCurrency: string | undefined;
  let afterNextAdapterExecution:
    ((scope: { tenantId: string; workspaceId: string }) => Promise<void>) | undefined;
  const adapterIdempotencyKeys: string[] = [];

  const fixtureAdapter: MeasurementSurfaceAdapter = {
    adapterKey: 'recorded-measurement-fixture',
    adapterVersion,
    describe() {
      return {
        adapterKey: 'recorded-measurement-fixture',
        adapterVersion,
        providerKey,
        surfaceKey,
        surfaceKind: 'CONSUMER_AI_ANSWER',
        acquisitionClass: 'MANUAL_IMPORT',
        acquisitionMethod,
        termsVersion: 'fixture-terms-2026-07',
        processingRegion: 'us-east-fixture',
        storageRegion: 'ephemeral-fixture',
        retentionPolicy: 'discard-after-import',
        trainingPolicy: 'not-used-for-training',
        subprocessors: [],
        requiresAuthorization: true,
      };
    },
    async executeScenario(command) {
      adapterExecuteCalls += 1;
      expect(command.idempotencyKey).toMatch(/^measurement-slot:[a-f0-9]{64}$/u);
      expect(command.signal).toBeInstanceOf(AbortSignal);
      adapterIdempotencyKeys.push(command.idempotencyKey);
      if (timeoutNextAdapterExecution) {
        timeoutNextAdapterExecution = false;
        return new Promise<MeasurementSurfaceExecutionResult>((_resolve, reject) => {
          command.signal.addEventListener(
            'abort',
            () => {
              timeoutAbortObserved = true;
              reject(new Error('FIXTURE_ABORTED_BY_DEADLINE'));
            },
            { once: true },
          );
        });
      }
      if (throwNextAdapterExecution) {
        throwNextAdapterExecution = false;
        throw new Error('FIXTURE_SECRET_ERROR_MUST_NOT_ESCAPE');
      }
      expect(command.scenario.providerKey).toBe(providerKey);
      expect(command.scenario.surfaceKey).toBe(surfaceKey);
      expect(command.scenario.acquisitionMethod).toBe(acquisitionMethod);
      const slot = ((command.prompt.ordinal - 1) * 3 + command.repetition - 1) % 6;
      const result = fixtureResult(slot, nextAdapterCostCurrency ?? 'USD');
      nextAdapterCostCurrency = undefined;
      const afterExecution = afterNextAdapterExecution;
      afterNextAdapterExecution = undefined;
      await afterExecution?.({ tenantId: command.tenantId, workspaceId: command.workspaceId });
      return result;
    },
  };

  const runtimeAdapters = {
    resolve(requestedProvider: string, requestedSurface: string, requestedVersion: string) {
      const fixture =
        requestedProvider === providerKey &&
        requestedSurface === surfaceKey &&
        requestedVersion === adapterVersion
          ? fixtureAdapter
          : null;
      return (
        fixture ??
        reviewedManualRuntimeAdapters.resolve(requestedProvider, requestedSurface, requestedVersion)
      );
    },
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(
      pool,
      fileURLToPath(new URL('../../packages/db/migrations', import.meta.url)),
    );
    jobStore = new PostgresJobBudgetStore(pool);
    measurementStore = new PostgresMeasurementStore(pool);
    rawEvidenceStore = new PostgresMeasurementRawEvidenceStore(pool);
    manualImportStore = new PostgresManualMeasurementImportStore(pool);
    reviewedManualRuntimeAdapters =
      createReviewedManualMeasurementImportAdapterRegistry(manualImportStore);
    app = await createApiApp({
      oidcClient,
      store: new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 15))),
      jobBudgetStore: jobStore,
      measurementStore,
      measurementRawEvidenceStore: rawEvidenceStore,
      manualMeasurementImportStore: manualImportStore,
      measurementSurfaceAdapters: runtimeAdapters,
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

  async function startApprovedPolicyRun(suffix: string) {
    const ownerSession = await signIn(app, 'measurement-owner-a-code');
    const scope = await createScope(app, ownerSession, suffix);
    const analystSession = await inviteAndAccept({
      app,
      ownerSession,
      scope,
      role: 'ANALYST',
      email: 'measurement-analyst@example.test',
      code: 'measurement-analyst-code',
    });
    const bundle = await createApprovedPromptScenario(app, ownerSession, analystSession, scope);
    const ownerHeaders = {
      cookie: `__Host-aeo_session=${ownerSession}`,
      origin: 'https://app.example.test',
    };
    const budget = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
      headers: ownerHeaders,
      payload: { limitUnits: 1_000 },
    });
    expect(budget.statusCode, budget.body).toBe(200);
    const policy = await app.inject({
      method: 'PUT',
      url:
        `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
        `/measurement-provider-policies/${providerKey}/${surfaceKey}`,
      headers: ownerHeaders,
      payload: {
        adapterVersion,
        termsVersion: 'fixture-terms-2026-07',
        termsApproved: true,
        authorizationApproved: true,
        crossBorderApproved: true,
        purpose: `${suffix} policy fixture`,
        policyVersion: 'measurement-provider-policy-v1',
      },
    });
    expect(policy.statusCode, policy.body).toBe(200);
    const startUrl =
      `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` + '/measurement-runs';
    const startedResponse = await app.inject({
      method: 'POST',
      url: startUrl,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        promptSetId: bundle.promptSet.id,
        promptRevisionId: bundle.revision.id,
        scenarioId: bundle.scenario.id,
        expectedPromptHash: bundle.revision.contentHash,
        expectedScenarioHash: bundle.scenario.contentHash,
        kind: 'BASELINE',
        idempotencyKey: randomUUID(),
      },
    });
    expect(startedResponse.statusCode, startedResponse.body).toBe(202);
    const started = StartMeasurementRunEnvelopeSchema.parse(startedResponse.json()).data;
    const boundProvider = await pool.query<{ provider_key: string | null }>(
      'SELECT provider_key FROM jobs WHERE tenant_id = $1 AND id = $2',
      [scope.tenant.id, started.job.id],
    );
    expect(boundProvider.rows[0]?.provider_key).toBe(providerKey);
    await pool.query(
      'UPDATE outbox_messages SET published_at = clock_timestamp() WHERE aggregate_id = $1',
      [started.job.id],
    );
    return { analystSession, scope, started };
  }

  function withPolicyReader(
    findProviderPolicy: MeasurementStore['findProviderPolicy'],
  ): MeasurementStore {
    return {
      prepareRun: (input) => measurementStore.prepareRun(input),
      bindJob: (input) => measurementStore.bindJob(input),
      setProviderPolicy: (input) => measurementStore.setProviderPolicy(input),
      findProviderPolicy,
      findRun: (input) => measurementStore.findRun(input),
      listPromptRuns: (input) => measurementStore.listPromptRuns(input),
      findPromptRun: (input) => measurementStore.findPromptRun(input),
      loadDashboard: (input) => measurementStore.loadDashboard(input),
      loadExecutionPlan: (input) => measurementStore.loadExecutionPlan(input),
      markRunning: (input) => measurementStore.markRunning(input),
      recordPromptRun: (input) => measurementStore.recordPromptRun(input),
      completeRun: (input) => measurementStore.completeRun(input),
    };
  }

  test('Measurement persistence rejects every same-tenant cross-workspace parent reference', async () => {
    const { scope, started } = await startApprovedPolicyRun('Measurement Workspace Graph');
    const siblingWorkspaceId = randomUUID();
    const siblingPromptSetId = randomUUID();
    const siblingPromptRevisionId = randomUUID();
    const siblingScenarioId = randomUUID();
    const siblingRunId = randomUUID();
    const sourcePromptRunId = randomUUID();
    const siblingPromptRunId = randomUUID();
    const sourceRawEvidenceId = randomUUID();
    const siblingRawEvidenceId = randomUUID();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO workspaces (id, tenant_id, name)
         VALUES ($1, $2, 'Measurement graph sibling workspace')`,
        [siblingWorkspaceId, scope.tenant.id],
      );
      const source = await client.query<{
        prompt_set_id: string;
        prompt_revision_id: string;
        scenario_id: string;
      }>(
        `SELECT prompt_set_id, prompt_revision_id, scenario_id
         FROM measurement_runs WHERE id = $1`,
        [started.measurementRun.id],
      );
      const sourceIds = source.rows[0];
      if (sourceIds === undefined) throw new Error('MEASUREMENT_WORKSPACE_GRAPH_SOURCE_MISSING');
      const deletedApproval = await client.query<{
        approved_at: Date;
        approved_by_user_id: string;
        prompt_content_hash: string;
        scenario_content_hash: string;
      }>(
        `DELETE FROM prompt_approvals WHERE prompt_revision_id = $1
         RETURNING prompt_content_hash, scenario_content_hash, approved_by_user_id, approved_at`,
        [sourceIds.prompt_revision_id],
      );
      const approval = deletedApproval.rows[0];
      if (approval === undefined) throw new Error('MEASUREMENT_WORKSPACE_APPROVAL_SOURCE_MISSING');

      await client.query(
        `INSERT INTO prompt_sets (id, tenant_id, workspace_id, current_revision, created_at)
         SELECT $2, tenant_id, $3, current_revision, created_at
         FROM prompt_sets WHERE id = $1`,
        [sourceIds.prompt_set_id, siblingPromptSetId, siblingWorkspaceId],
      );
      await client.query(
        `INSERT INTO prompt_revisions
          (id, tenant_id, workspace_id, prompt_set_id, revision, title, subject, source_context,
            prompts, scopes, content_hash, status, created_by_user_id, created_at)
         SELECT $2, tenant_id, $3, $4, revision, title, subject, source_context, prompts, scopes,
           content_hash, status, created_by_user_id, created_at
         FROM prompt_revisions WHERE id = $1`,
        [
          sourceIds.prompt_revision_id,
          siblingPromptRevisionId,
          siblingWorkspaceId,
          siblingPromptSetId,
        ],
      );
      await client.query(
        `INSERT INTO measurement_scenarios
          (id, tenant_id, workspace_id, prompt_revision_id, version, provider_key, surface_key,
            model, model_version, account_ref, acquisition_method, fresh_session, search_enabled,
            parameters, repetitions, content_hash, registry_status, created_at)
         SELECT $2, tenant_id, $3, $4, version, provider_key, surface_key, model, model_version,
           account_ref, acquisition_method, fresh_session, search_enabled, parameters, repetitions,
           content_hash, registry_status, created_at
         FROM measurement_scenarios WHERE id = $1`,
        [sourceIds.scenario_id, siblingScenarioId, siblingWorkspaceId, siblingPromptRevisionId],
      );

      const insertRun = `INSERT INTO measurement_runs
        (id, tenant_id, workspace_id, prompt_set_id, prompt_revision_id, prompt_content_hash,
          scenario_id, scenario_version, scenario_content_hash, job_id, kind, status,
          expected_prompt_run_count, completed_prompt_run_count, provider_key, surface_key, model,
          model_version, acquisition_class, acquisition_method, adapter_version, scenario_snapshot,
          prompt_snapshot, idempotency_key, requested_by_user_id, created_at, started_at,
          completed_at, manual_import_id, manual_import_content_hash)
        SELECT $2, tenant_id, $3, $4, $5, prompt_content_hash, $6, scenario_version,
          scenario_content_hash, $7, kind, 'QUEUED', expected_prompt_run_count, 0, provider_key,
          surface_key, model, model_version, acquisition_class, acquisition_method, adapter_version,
          scenario_snapshot, prompt_snapshot, $8, requested_by_user_id, created_at, NULL, NULL,
          NULL, NULL
        FROM measurement_runs WHERE id = $1`;
      await client.query(insertRun, [
        started.measurementRun.id,
        siblingRunId,
        siblingWorkspaceId,
        siblingPromptSetId,
        siblingPromptRevisionId,
        siblingScenarioId,
        null,
        randomUUID(),
      ]);
      await client.query(
        `INSERT INTO raw_evidence_refs
          (id, tenant_id, workspace_id, measurement_run_id, object_ref, content_hash, payload,
            created_at)
         VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, clock_timestamp()),
                ($7, $2, $8, $9, $10, $6, '{}'::jsonb, clock_timestamp())`,
        [
          sourceRawEvidenceId,
          scope.tenant.id,
          scope.workspace.id,
          started.measurementRun.id,
          'measurement://workspace-graph/source',
          'a'.repeat(64),
          siblingRawEvidenceId,
          siblingWorkspaceId,
          siblingRunId,
          'measurement://workspace-graph/sibling',
        ],
      );
      const insertPromptRun = `INSERT INTO prompt_runs
        (id, tenant_id, workspace_id, measurement_run_id, prompt_id, prompt_ordinal, repetition,
          scope_key, status, provider_key, surface_key, model, model_version, scenario_id,
          scenario_version, acquisition_class, acquisition_method, adapter_key, adapter_version,
          method_version, observation, cost_amount, cost_currency, policy_reason,
          raw_evidence_ref_id, observed_at)
        SELECT $1, tenant_id, $2, $3, $4, 1, 1, $5, 'PASS', provider_key, surface_key, model,
          model_version, $6, scenario_version, acquisition_class, acquisition_method,
          'fixture-adapter', adapter_version, $7, '{}'::jsonb, 0, 'USD', NULL, $8,
          clock_timestamp()
        FROM measurement_runs WHERE id = $3`;
      await client.query(insertPromptRun, [
        sourcePromptRunId,
        scope.workspace.id,
        started.measurementRun.id,
        randomUUID(),
        'source-workspace-slot',
        sourceIds.scenario_id,
        observationMethodVersion,
        sourceRawEvidenceId,
      ]);
      await client.query(insertPromptRun, [
        siblingPromptRunId,
        siblingWorkspaceId,
        siblingRunId,
        randomUUID(),
        'sibling-workspace-slot',
        siblingScenarioId,
        observationMethodVersion,
        siblingRawEvidenceId,
      ]);

      const captureOutcome = async (sql: string, values: readonly unknown[]) => {
        await client.query('SAVEPOINT cross_workspace_attempt');
        let outcome = 'ACCEPTED';
        try {
          await client.query(sql, [...values]);
        } catch (error) {
          outcome =
            typeof error === 'object' && error !== null && 'code' in error
              ? String(error.code)
              : 'UNKNOWN_ERROR';
        }
        await client.query('ROLLBACK TO SAVEPOINT cross_workspace_attempt');
        await client.query('RELEASE SAVEPOINT cross_workspace_attempt');
        return outcome;
      };
      const crossRun = (input: {
        promptSetId: string;
        promptRevisionId: string;
        scenarioId: string;
        jobId: string | null;
      }) =>
        captureOutcome(insertRun, [
          started.measurementRun.id,
          randomUUID(),
          siblingWorkspaceId,
          input.promptSetId,
          input.promptRevisionId,
          input.scenarioId,
          input.jobId,
          randomUUID(),
        ]);
      const insertApproval = `INSERT INTO prompt_approvals
        (id, tenant_id, workspace_id, prompt_revision_id, scenario_id, prompt_content_hash,
          scenario_content_hash, approved_by_user_id, approved_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

      const outcomes = {
        approvalToPromptRevision: await captureOutcome(insertApproval, [
          randomUUID(),
          scope.tenant.id,
          siblingWorkspaceId,
          sourceIds.prompt_revision_id,
          siblingScenarioId,
          approval.prompt_content_hash,
          approval.scenario_content_hash,
          approval.approved_by_user_id,
          approval.approved_at,
        ]),
        approvalToScenario: await captureOutcome(insertApproval, [
          randomUUID(),
          scope.tenant.id,
          siblingWorkspaceId,
          siblingPromptRevisionId,
          sourceIds.scenario_id,
          approval.prompt_content_hash,
          approval.scenario_content_hash,
          approval.approved_by_user_id,
          approval.approved_at,
        ]),
        runToPromptSet: await crossRun({
          promptSetId: sourceIds.prompt_set_id,
          promptRevisionId: siblingPromptRevisionId,
          scenarioId: siblingScenarioId,
          jobId: null,
        }),
        runToPromptRevision: await crossRun({
          promptSetId: siblingPromptSetId,
          promptRevisionId: sourceIds.prompt_revision_id,
          scenarioId: siblingScenarioId,
          jobId: null,
        }),
        runToScenario: await crossRun({
          promptSetId: siblingPromptSetId,
          promptRevisionId: siblingPromptRevisionId,
          scenarioId: sourceIds.scenario_id,
          jobId: null,
        }),
        runToJob: await crossRun({
          promptSetId: siblingPromptSetId,
          promptRevisionId: siblingPromptRevisionId,
          scenarioId: siblingScenarioId,
          jobId: started.job.id,
        }),
        rawEvidenceToRun: await captureOutcome(
          `INSERT INTO raw_evidence_refs
            (id, tenant_id, workspace_id, measurement_run_id, object_ref, content_hash, payload,
              created_at)
           VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, clock_timestamp())`,
          [
            randomUUID(),
            scope.tenant.id,
            siblingWorkspaceId,
            started.measurementRun.id,
            'measurement://workspace-graph/cross-raw',
            'b'.repeat(64),
          ],
        ),
        promptRunToRun: await captureOutcome(insertPromptRun, [
          randomUUID(),
          siblingWorkspaceId,
          started.measurementRun.id,
          randomUUID(),
          'cross-run-slot',
          siblingScenarioId,
          observationMethodVersion,
          null,
        ]),
        promptRunToScenario: await captureOutcome(insertPromptRun, [
          randomUUID(),
          siblingWorkspaceId,
          siblingRunId,
          randomUUID(),
          'cross-scenario-slot',
          sourceIds.scenario_id,
          observationMethodVersion,
          null,
        ]),
        promptRunToRawEvidence: await captureOutcome(insertPromptRun, [
          randomUUID(),
          siblingWorkspaceId,
          siblingRunId,
          randomUUID(),
          'cross-raw-evidence-slot',
          siblingScenarioId,
          observationMethodVersion,
          sourceRawEvidenceId,
        ]),
        observationToPromptRun: await captureOutcome(
          `INSERT INTO metric_observations
            (id, tenant_id, workspace_id, measurement_run_id, prompt_run_id, metric_key,
              scope_key, classification, cohort, created_at)
           VALUES ($1, $2, $3, $4, $5, 'MENTION_RATE', $6, 'PASS', '{}'::jsonb,
             clock_timestamp())`,
          [
            randomUUID(),
            scope.tenant.id,
            siblingWorkspaceId,
            siblingRunId,
            sourcePromptRunId,
            'cross-prompt-observation',
          ],
        ),
        snapshotToRun: await captureOutcome(
          `INSERT INTO metric_snapshots
            (id, tenant_id, workspace_id, measurement_run_id, schema_version, metric_key,
              scope_key, method_version, cohort, numerator, eligible_denominator, value,
              excluded_counts, source_observation_ids, source_hash, content_hash, created_at)
           VALUES ($1, $2, $3, $4, 'metric-snapshot.v1', 'MENTION_RATE', $5, $6, '{}'::jsonb,
             1, 1, 1, '{"ERROR":0,"NOT_CHECKED":0,"INCONCLUSIVE":0,"NOT_APPLICABLE":0}'::jsonb,
             ARRAY[$7::uuid], $8, $9, clock_timestamp())`,
          [
            randomUUID(),
            scope.tenant.id,
            siblingWorkspaceId,
            started.measurementRun.id,
            'cross-run-snapshot',
            snapshotMethodVersion,
            randomUUID(),
            'c'.repeat(64),
            'd'.repeat(64),
          ],
        ),
      };

      expect(outcomes).toEqual({
        approvalToPromptRevision: '23503',
        approvalToScenario: '23503',
        runToPromptSet: '23503',
        runToPromptRevision: '23503',
        runToScenario: '23503',
        runToJob: '23503',
        rawEvidenceToRun: '23503',
        promptRunToRun: '23503',
        promptRunToScenario: '23503',
        promptRunToRawEvidence: '23503',
        observationToPromptRun: '23503',
        snapshotToRun: '23503',
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }, 120_000);

  test('the Measurement outbox exposes only actionable deliveries and preserves redelivery until ACK', async () => {
    const ownerSession = await signIn(app, 'measurement-owner-a-code');
    const scope = await createScope(app, ownerSession, 'Measurement Outbox Eligibility');
    const owner = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'measurement-owner-a@example.test'`,
    );
    const ownerId = owner.rows[0]?.id;
    if (ownerId === undefined) throw new Error('MEASUREMENT_OUTBOX_OWNER_NOT_FOUND');

    const now = Date.now();
    const fixture = {
      running: { jobId: randomUUID(), aggregateId: randomUUID(), messageId: randomUUID() },
      retry: { jobId: randomUUID(), aggregateId: randomUUID(), messageId: randomUUID() },
      queued: { jobId: randomUUID(), aggregateId: randomUUID(), messageId: randomUUID() },
      terminal: { jobId: randomUUID(), aggregateId: randomUUID(), messageId: randomUUID() },
    };
    const jobs = [
      {
        id: fixture.running.jobId,
        aggregate_id: fixture.running.aggregateId,
        status: 'RUNNING',
        idempotency_key: `outbox-running-${fixture.running.jobId}`,
        lease_token: randomUUID(),
        lease_expires_at: new Date(now + 60_000).toISOString(),
        next_attempt_at: null,
        created_at: new Date(now - 40_000).toISOString(),
      },
      {
        id: fixture.retry.jobId,
        aggregate_id: fixture.retry.aggregateId,
        status: 'RETRY_WAIT',
        idempotency_key: `outbox-retry-${fixture.retry.jobId}`,
        lease_token: null,
        lease_expires_at: null,
        next_attempt_at: new Date(now + 60_000).toISOString(),
        created_at: new Date(now - 30_000).toISOString(),
      },
      {
        id: fixture.queued.jobId,
        aggregate_id: fixture.queued.aggregateId,
        status: 'QUEUED',
        idempotency_key: `outbox-queued-${fixture.queued.jobId}`,
        lease_token: null,
        lease_expires_at: null,
        next_attempt_at: null,
        created_at: new Date(now - 20_000).toISOString(),
      },
      {
        id: fixture.terminal.jobId,
        aggregate_id: fixture.terminal.aggregateId,
        status: 'SUCCEEDED',
        idempotency_key: `outbox-terminal-${fixture.terminal.jobId}`,
        lease_token: null,
        lease_expires_at: null,
        next_attempt_at: null,
        created_at: new Date(now - 10_000).toISOString(),
      },
    ];
    const messages = [
      {
        id: fixture.running.messageId,
        job_id: fixture.running.jobId,
        created_at: jobs[0]?.created_at,
      },
      {
        id: fixture.retry.messageId,
        job_id: fixture.retry.jobId,
        created_at: jobs[1]?.created_at,
      },
      {
        id: fixture.queued.messageId,
        job_id: fixture.queued.jobId,
        created_at: jobs[2]?.created_at,
      },
      {
        id: fixture.terminal.messageId,
        job_id: fixture.terminal.jobId,
        created_at: jobs[3]?.created_at,
      },
    ];
    await pool.query(
      `INSERT INTO jobs
        (id, tenant_id, workspace_id, job_type, aggregate_id, status, idempotency_key,
          estimated_units, requested_by_user_id, lease_token, lease_expires_at, next_attempt_at,
          created_at)
       SELECT fixture.id, $1, $2, 'MEASUREMENT', fixture.aggregate_id, fixture.status,
         fixture.idempotency_key, 1, $3, fixture.lease_token, fixture.lease_expires_at,
         fixture.next_attempt_at, fixture.created_at
       FROM jsonb_to_recordset($4::jsonb) AS fixture(
         id uuid, aggregate_id uuid, status text, idempotency_key text, lease_token uuid,
         lease_expires_at timestamptz, next_attempt_at timestamptz, created_at timestamptz
       )`,
      [scope.tenant.id, scope.workspace.id, ownerId, JSON.stringify(jobs)],
    );
    await pool.query(
      `INSERT INTO outbox_messages
        (id, tenant_id, workspace_id, aggregate_id, message_type, payload, created_at)
       SELECT fixture.id, $1, $2, fixture.job_id, 'JOB_QUEUED',
         jsonb_build_object(
           'jobId', fixture.job_id,
           'tenantId', $1::uuid,
           'workspaceId', $2::uuid,
           'schemaVersion', '1.0.0'
         ), fixture.created_at
       FROM jsonb_to_recordset($3::jsonb) AS fixture(
         id uuid, job_id uuid, created_at timestamptz
       )`,
      [scope.tenant.id, scope.workspace.id, JSON.stringify(messages)],
    );

    const clock = { now: () => new Date() };
    const queue = new PostgresMeasurementOutboxQueue(pool, jobStore, clock);
    const queuedDelivery = await queue.receive();
    expect(queuedDelivery?.message.payload.jobId).toBe(fixture.queued.jobId);
    await queuedDelivery?.release();

    const queuedRedelivery = await queue.receive();
    expect(queuedRedelivery?.message.payload.jobId).toBe(fixture.queued.jobId);
    await queuedRedelivery?.acknowledge();

    const terminalWorker = new MeasurementRunJobWorker(
      new JobWorkerCoordinator(jobStore, clock, { next: randomUUID }, 'measurement-outbox-v1'),
      new MeasurementExecutionHandler(
        measurementStore,
        rawEvidenceStore,
        runtimeAdapters,
        { next: randomUUID },
        clock,
        { observationMethodVersion, snapshotMethodVersion },
      ),
    );
    const terminalRuntime = createMeasurementWorkerRuntime({
      queue,
      processor: terminalWorker,
      pollIntervalMs: 1,
    });
    await expect(terminalRuntime.runOnce()).resolves.toEqual({ outcome: 'NOT_AVAILABLE' });
    const terminalOutbox = await pool.query<{ published_at: Date | null }>(
      'SELECT published_at FROM outbox_messages WHERE id = $1',
      [fixture.terminal.messageId],
    );
    expect(terminalOutbox.rows[0]?.published_at).toBeInstanceOf(Date);

    await pool.query(
      `UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [fixture.running.jobId],
    );
    const expiredLeaseDelivery = await queue.receive();
    expect(expiredLeaseDelivery?.message.payload.jobId).toBe(fixture.running.jobId);
    await expiredLeaseDelivery?.acknowledge();

    await pool.query(
      `UPDATE jobs SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [fixture.retry.jobId],
    );
    const dueRetryDelivery = await queue.receive();
    expect(dueRetryDelivery?.message.payload.jobId).toBe(fixture.retry.jobId);
    await dueRetryDelivery?.acknowledge();

    await expect(queue.receive()).resolves.toBeNull();
  });

  test('the Measurement outbox counts every live tenant job before exposing a concurrency-limited delivery', async () => {
    const ownerSession = await signIn(app, 'measurement-owner-a-code');
    const blockedScope = await createScope(
      app,
      ownerSession,
      'Measurement Outbox Capacity Blocked',
    );
    const availableScope = await createScope(
      app,
      ownerSession,
      'Measurement Outbox Capacity Available',
    );
    const owner = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'measurement-owner-a@example.test'`,
    );
    const ownerId = owner.rows[0]?.id;
    if (ownerId === undefined) throw new Error('MEASUREMENT_OUTBOX_CAPACITY_OWNER_NOT_FOUND');

    const activeJobs = Array.from({ length: 5 }, () => ({
      id: randomUUID(),
      aggregate_id: randomUUID(),
      idempotency_key: `active-profile-${randomUUID()}`,
      lease_token: randomUUID(),
    }));
    const blockedJobId = randomUUID();
    const availableJobId = randomUUID();
    const blockedMessageId = randomUUID();
    const availableMessageId = randomUUID();
    await pool.query(
      `INSERT INTO jobs
        (id, tenant_id, workspace_id, job_type, aggregate_id, status, idempotency_key,
          estimated_units, requested_by_user_id, lease_token, lease_expires_at, created_at)
       SELECT fixture.id, $1, $2, 'PROFILE_READINESS', fixture.aggregate_id, 'RUNNING',
         fixture.idempotency_key, 1, $3, fixture.lease_token,
         clock_timestamp() + interval '1 minute', clock_timestamp() - interval '1 minute'
       FROM jsonb_to_recordset($4::jsonb) AS fixture(
         id uuid, aggregate_id uuid, idempotency_key text, lease_token uuid
       )`,
      [blockedScope.tenant.id, blockedScope.workspace.id, ownerId, JSON.stringify(activeJobs)],
    );
    await pool.query(
      `INSERT INTO jobs
        (id, tenant_id, workspace_id, job_type, aggregate_id, status, idempotency_key,
          estimated_units, requested_by_user_id, created_at)
       VALUES
        ($1, $2, $3, 'MEASUREMENT', $4, 'QUEUED', $5, 1, $6,
          clock_timestamp() - interval '20 seconds'),
        ($7, $8, $9, 'MEASUREMENT', $10, 'QUEUED', $11, 1, $6,
          clock_timestamp() - interval '10 seconds')`,
      [
        blockedJobId,
        blockedScope.tenant.id,
        blockedScope.workspace.id,
        randomUUID(),
        `blocked-measurement-${blockedJobId}`,
        ownerId,
        availableJobId,
        availableScope.tenant.id,
        availableScope.workspace.id,
        randomUUID(),
        `available-measurement-${availableJobId}`,
      ],
    );
    await pool.query(
      `INSERT INTO outbox_messages
        (id, tenant_id, workspace_id, aggregate_id, message_type, payload, created_at)
       VALUES
        ($1, $2, $3, $4, 'JOB_QUEUED',
          jsonb_build_object(
            'jobId', $4::uuid,
            'tenantId', $2::uuid,
            'workspaceId', $3::uuid,
            'schemaVersion', '1.0.0'
          ), clock_timestamp() - interval '20 seconds'),
        ($5, $6, $7, $8, 'JOB_QUEUED',
          jsonb_build_object(
            'jobId', $8::uuid,
            'tenantId', $6::uuid,
            'workspaceId', $7::uuid,
            'schemaVersion', '1.0.0'
          ), clock_timestamp() - interval '10 seconds')`,
      [
        blockedMessageId,
        blockedScope.tenant.id,
        blockedScope.workspace.id,
        blockedJobId,
        availableMessageId,
        availableScope.tenant.id,
        availableScope.workspace.id,
        availableJobId,
      ],
    );

    const queue = new PostgresMeasurementOutboxQueue(pool, jobStore, { now: () => new Date() });
    const availableDelivery = await queue.receive();
    expect(availableDelivery?.message.payload.jobId).toBe(availableJobId);
    await availableDelivery?.acknowledge();
    await expect(queue.receive()).resolves.toBeNull();

    await pool.query(
      `UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [activeJobs[0]?.id],
    );
    const unblockedDelivery = await queue.receive();
    expect(unblockedDelivery?.message.payload.jobId).toBe(blockedJobId);
    await unblockedDelivery?.acknowledge();
  });

  test('a stale Measurement Worker cannot persist evidence after another lease takes ownership', async () => {
    const ownerSession = await signIn(app, 'measurement-owner-a-code');
    const scope = await createScope(app, ownerSession, 'Measurement Lease Fence');
    const analystSession = await inviteAndAccept({
      app,
      ownerSession,
      scope,
      role: 'ANALYST',
      email: 'measurement-analyst@example.test',
      code: 'measurement-analyst-code',
    });
    const bundle = await createApprovedPromptScenario(app, ownerSession, analystSession, scope);
    const ownerHeaders = {
      cookie: `__Host-aeo_session=${ownerSession}`,
      origin: 'https://app.example.test',
    };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
          headers: ownerHeaders,
          payload: { limitUnits: 1_000 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url:
            `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
            `/measurement-provider-policies/${providerKey}/${surfaceKey}`,
          headers: ownerHeaders,
          payload: {
            adapterVersion,
            termsVersion: 'fixture-terms-2026-07',
            termsApproved: true,
            authorizationApproved: true,
            crossBorderApproved: true,
            purpose: 'lease-fenced measurement fixture',
            policyVersion: 'measurement-provider-policy-v1',
          },
        })
      ).statusCode,
    ).toBe(200);
    const startedResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/measurement-runs`,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        promptSetId: bundle.promptSet.id,
        promptRevisionId: bundle.revision.id,
        scenarioId: bundle.scenario.id,
        expectedPromptHash: bundle.revision.contentHash,
        expectedScenarioHash: bundle.scenario.contentHash,
        kind: 'BASELINE',
        idempotencyKey: randomUUID(),
      },
    });
    expect(startedResponse.statusCode, startedResponse.body).toBe(202);
    const started = StartMeasurementRunEnvelopeSchema.parse(startedResponse.json()).data;
    await pool.query(
      'UPDATE outbox_messages SET published_at = clock_timestamp() WHERE aggregate_id = $1',
      [started.job.id],
    );
    let leaseStolen = false;
    const leaseStealingRawEvidenceStore = {
      async put(input: Parameters<PostgresMeasurementRawEvidenceStore['put']>[0]) {
        if (!leaseStolen) {
          leaseStolen = true;
          await pool.query(
            `UPDATE jobs
             SET lease_token = $1, lease_expires_at = clock_timestamp() + interval '30 seconds'
             WHERE id = $2 AND tenant_id = $3 AND workspace_id = $4 AND status = 'RUNNING'`,
            [randomUUID(), started.job.id, scope.tenant.id, scope.workspace.id],
          );
        }
        return rawEvidenceStore.put(input);
      },
      get(input: Parameters<PostgresMeasurementRawEvidenceStore['get']>[0]) {
        return rawEvidenceStore.get(input);
      },
    };
    const clock = { now: () => new Date() };
    const worker = new MeasurementRunJobWorker(
      new JobWorkerCoordinator(jobStore, clock, { next: randomUUID }, 'measurement-lease-fence-v1'),
      new MeasurementExecutionHandler(
        measurementStore,
        leaseStealingRawEvidenceStore,
        runtimeAdapters,
        { next: randomUUID },
        clock,
        { observationMethodVersion, snapshotMethodVersion },
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
    ).toMatchObject({ outcome: 'LEASE_LOST', measurementRunId: started.measurementRun.id });
    expect(leaseStolen).toBe(true);
    const staleWrites = await pool.query<{
      raw_evidence_count: number;
      prompt_run_count: number;
      run_status: string;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM raw_evidence_refs WHERE measurement_run_id = run.id)
           AS raw_evidence_count,
         (SELECT count(*)::integer FROM prompt_runs WHERE measurement_run_id = run.id)
           AS prompt_run_count,
         run.status AS run_status
       FROM measurement_runs run
       WHERE run.id = $1`,
      [started.measurementRun.id],
    );
    expect(staleWrites.rows[0]).toEqual({
      raw_evidence_count: 0,
      prompt_run_count: 0,
      run_status: 'RUNNING',
    });
  }, 120_000);

  test('an expired Measurement lease cannot seal snapshots after the completion transaction starts', async () => {
    const ownerSession = await signIn(app, 'measurement-owner-a-code');
    const scope = await createScope(app, ownerSession, 'Measurement Completion Fence');
    const analystSession = await inviteAndAccept({
      app,
      ownerSession,
      scope,
      role: 'ANALYST',
      email: 'measurement-analyst@example.test',
      code: 'measurement-analyst-code',
    });
    const bundle = await createApprovedPromptScenario(app, ownerSession, analystSession, scope);
    const ownerHeaders = {
      cookie: `__Host-aeo_session=${ownerSession}`,
      origin: 'https://app.example.test',
    };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
          headers: ownerHeaders,
          payload: { limitUnits: 1_000 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url:
            `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
            `/measurement-provider-policies/${providerKey}/${surfaceKey}`,
          headers: ownerHeaders,
          payload: {
            adapterVersion,
            termsVersion: 'fixture-terms-2026-07',
            termsApproved: true,
            authorizationApproved: true,
            crossBorderApproved: true,
            purpose: 'completion lease-fence fixture',
            policyVersion: 'measurement-provider-policy-v1',
          },
        })
      ).statusCode,
    ).toBe(200);
    const startedResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/measurement-runs`,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        promptSetId: bundle.promptSet.id,
        promptRevisionId: bundle.revision.id,
        scenarioId: bundle.scenario.id,
        expectedPromptHash: bundle.revision.contentHash,
        expectedScenarioHash: bundle.scenario.contentHash,
        kind: 'BASELINE',
        idempotencyKey: randomUUID(),
      },
    });
    expect(startedResponse.statusCode, startedResponse.body).toBe(202);
    const started = StartMeasurementRunEnvelopeSchema.parse(startedResponse.json()).data;
    await pool.query(
      'UPDATE outbox_messages SET published_at = clock_timestamp() WHERE aggregate_id = $1',
      [started.job.id],
    );
    const expiringCompletionStore: MeasurementStore = {
      prepareRun: (input) => measurementStore.prepareRun(input),
      bindJob: (input) => measurementStore.bindJob(input),
      setProviderPolicy: (input) => measurementStore.setProviderPolicy(input),
      findProviderPolicy: (input) => measurementStore.findProviderPolicy(input),
      findRun: (input) => measurementStore.findRun(input),
      listPromptRuns: (input) => measurementStore.listPromptRuns(input),
      findPromptRun: (input) => measurementStore.findPromptRun(input),
      loadDashboard: (input) => measurementStore.loadDashboard(input),
      loadExecutionPlan: (input) => measurementStore.loadExecutionPlan(input),
      markRunning: (input) => measurementStore.markRunning(input),
      recordPromptRun: (input) => measurementStore.recordPromptRun(input),
      async completeRun(input) {
        await pool.query(
          `UPDATE jobs
           SET lease_expires_at = clock_timestamp() + interval '1 second'
           WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3
             AND status = 'RUNNING' AND lease_token = $4`,
          [input.lease?.jobId, scope.tenant.id, scope.workspace.id, input.lease?.leaseToken],
        );
        return measurementStore.completeRun(input);
      },
    };
    await pool.query(
      `CREATE FUNCTION task15_delay_metric_snapshot() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         PERFORM pg_sleep(1.1);
         RETURN NEW;
       END
       $$`,
    );
    await pool.query(
      `CREATE TRIGGER task15_delay_metric_snapshot
       BEFORE INSERT ON metric_snapshots
       FOR EACH ROW EXECUTE FUNCTION task15_delay_metric_snapshot()`,
    );
    const clock = { now: () => new Date() };
    const worker = new MeasurementRunJobWorker(
      new JobWorkerCoordinator(
        jobStore,
        clock,
        { next: randomUUID },
        'measurement-completion-fence-v1',
      ),
      new MeasurementExecutionHandler(
        expiringCompletionStore,
        rawEvidenceStore,
        runtimeAdapters,
        { next: randomUUID },
        clock,
        { observationMethodVersion, snapshotMethodVersion },
      ),
    );
    try {
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
      ).toMatchObject({ outcome: 'LEASE_LOST', measurementRunId: started.measurementRun.id });
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS task15_delay_metric_snapshot ON metric_snapshots');
      await pool.query('DROP FUNCTION IF EXISTS task15_delay_metric_snapshot()');
    }
    const completionState = await pool.query<{
      run_status: string;
      snapshot_count: number;
    }>(
      `SELECT run.status AS run_status,
         (SELECT count(*)::integer FROM metric_snapshots snapshot
          WHERE snapshot.measurement_run_id = run.id) AS snapshot_count
       FROM measurement_runs run WHERE run.id = $1`,
      [started.measurementRun.id],
    );
    expect(completionState.rows[0]).toEqual({ run_status: 'RUNNING', snapshot_count: 0 });
  }, 120_000);

  test('an expired Measurement lease cannot commit a PromptRun after its transaction starts', async () => {
    const ownerSession = await signIn(app, 'measurement-owner-a-code');
    const scope = await createScope(app, ownerSession, 'Measurement PromptRun Fence');
    const analystSession = await inviteAndAccept({
      app,
      ownerSession,
      scope,
      role: 'ANALYST',
      email: 'measurement-analyst@example.test',
      code: 'measurement-analyst-code',
    });
    const bundle = await createApprovedPromptScenario(app, ownerSession, analystSession, scope);
    const ownerHeaders = {
      cookie: `__Host-aeo_session=${ownerSession}`,
      origin: 'https://app.example.test',
    };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
          headers: ownerHeaders,
          payload: { limitUnits: 1_000 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url:
            `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
            `/measurement-provider-policies/${providerKey}/${surfaceKey}`,
          headers: ownerHeaders,
          payload: {
            adapterVersion,
            termsVersion: 'fixture-terms-2026-07',
            termsApproved: true,
            authorizationApproved: true,
            crossBorderApproved: true,
            purpose: 'PromptRun lease-fence fixture',
            policyVersion: 'measurement-provider-policy-v1',
          },
        })
      ).statusCode,
    ).toBe(200);
    const startedResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/measurement-runs`,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        promptSetId: bundle.promptSet.id,
        promptRevisionId: bundle.revision.id,
        scenarioId: bundle.scenario.id,
        expectedPromptHash: bundle.revision.contentHash,
        expectedScenarioHash: bundle.scenario.contentHash,
        kind: 'BASELINE',
        idempotencyKey: randomUUID(),
      },
    });
    expect(startedResponse.statusCode, startedResponse.body).toBe(202);
    const started = StartMeasurementRunEnvelopeSchema.parse(startedResponse.json()).data;
    await pool.query(
      'UPDATE outbox_messages SET published_at = clock_timestamp() WHERE aggregate_id = $1',
      [started.job.id],
    );
    let leaseExpiryInjected = false;
    const expiringPromptRunStore: MeasurementStore = {
      prepareRun: (input) => measurementStore.prepareRun(input),
      bindJob: (input) => measurementStore.bindJob(input),
      setProviderPolicy: (input) => measurementStore.setProviderPolicy(input),
      findProviderPolicy: (input) => measurementStore.findProviderPolicy(input),
      findRun: (input) => measurementStore.findRun(input),
      listPromptRuns: (input) => measurementStore.listPromptRuns(input),
      findPromptRun: (input) => measurementStore.findPromptRun(input),
      loadDashboard: (input) => measurementStore.loadDashboard(input),
      loadExecutionPlan: (input) => measurementStore.loadExecutionPlan(input),
      markRunning: (input) => measurementStore.markRunning(input),
      async recordPromptRun(input) {
        if (!leaseExpiryInjected) {
          leaseExpiryInjected = true;
          await pool.query(
            `UPDATE jobs
             SET lease_expires_at = clock_timestamp() + interval '1 second'
             WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3
               AND status = 'RUNNING' AND lease_token = $4`,
            [input.lease?.jobId, scope.tenant.id, scope.workspace.id, input.lease?.leaseToken],
          );
        }
        return measurementStore.recordPromptRun(input);
      },
      completeRun: (input) => measurementStore.completeRun(input),
    };
    await pool.query(
      `CREATE FUNCTION task15_delay_prompt_run() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         PERFORM pg_sleep(1.1);
         RETURN NEW;
       END
       $$`,
    );
    await pool.query(
      `CREATE TRIGGER task15_delay_prompt_run
       BEFORE INSERT ON prompt_runs
       FOR EACH ROW EXECUTE FUNCTION task15_delay_prompt_run()`,
    );
    const clock = { now: () => new Date() };
    const worker = new MeasurementRunJobWorker(
      new JobWorkerCoordinator(
        jobStore,
        clock,
        { next: randomUUID },
        'measurement-prompt-run-fence-v1',
      ),
      new MeasurementExecutionHandler(
        expiringPromptRunStore,
        rawEvidenceStore,
        runtimeAdapters,
        { next: randomUUID },
        clock,
        { observationMethodVersion, snapshotMethodVersion },
      ),
    );
    try {
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
      ).toMatchObject({ outcome: 'LEASE_LOST', measurementRunId: started.measurementRun.id });
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS task15_delay_prompt_run ON prompt_runs');
      await pool.query('DROP FUNCTION IF EXISTS task15_delay_prompt_run()');
    }
    expect(leaseExpiryInjected).toBe(true);
    const promptRunState = await pool.query<{
      completed_prompt_run_count: number;
      observation_count: number;
      prompt_run_count: number;
      raw_evidence_count: number;
      run_status: string;
    }>(
      `SELECT run.status AS run_status, run.completed_prompt_run_count,
         (SELECT count(*)::integer FROM raw_evidence_refs evidence
          WHERE evidence.measurement_run_id = run.id) AS raw_evidence_count,
         (SELECT count(*)::integer FROM prompt_runs prompt
          WHERE prompt.measurement_run_id = run.id) AS prompt_run_count,
         (SELECT count(*)::integer FROM metric_observations observation
          WHERE observation.measurement_run_id = run.id) AS observation_count
       FROM measurement_runs run WHERE run.id = $1`,
      [started.measurementRun.id],
    );
    expect(promptRunState.rows[0]).toEqual({
      completed_prompt_run_count: 0,
      observation_count: 0,
      prompt_run_count: 0,
      raw_evidence_count: 1,
      run_status: 'RUNNING',
    });
  }, 120_000);

  test('a Measurement Worker does not send after losing its lease during a fresh policy read', async () => {
    const { scope, started } = await startApprovedPolicyRun('Measurement Policy Lease Guard');
    let leaseStolen = false;
    const store = withPolicyReader(async (input) => {
      const policy = await measurementStore.findProviderPolicy(input);
      if (!leaseStolen) {
        leaseStolen = true;
        await pool.query(
          `UPDATE jobs
           SET lease_token = $1, lease_expires_at = clock_timestamp() + interval '30 seconds'
           WHERE id = $2 AND tenant_id = $3 AND workspace_id = $4 AND status = 'RUNNING'`,
          [randomUUID(), started.job.id, scope.tenant.id, scope.workspace.id],
        );
      }
      return policy;
    });
    const callsBefore = adapterExecuteCalls;
    const clock = { now: () => new Date() };
    const worker = new MeasurementRunJobWorker(
      new JobWorkerCoordinator(
        jobStore,
        clock,
        { next: randomUUID },
        'measurement-policy-lease-guard-v1',
      ),
      new MeasurementExecutionHandler(
        store,
        rawEvidenceStore,
        runtimeAdapters,
        { next: randomUUID },
        clock,
        { observationMethodVersion, snapshotMethodVersion },
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
    ).toMatchObject({ outcome: 'LEASE_LOST', measurementRunId: started.measurementRun.id });
    expect(leaseStolen).toBe(true);
    expect(adapterExecuteCalls - callsBefore).toBe(0);
    const writes = await pool.query<{ prompt_run_count: number; raw_evidence_count: number }>(
      `SELECT
         (SELECT count(*)::integer FROM prompt_runs WHERE measurement_run_id = run.id)
           AS prompt_run_count,
         (SELECT count(*)::integer FROM raw_evidence_refs WHERE measurement_run_id = run.id)
           AS raw_evidence_count
       FROM measurement_runs run WHERE run.id = $1`,
      [started.measurementRun.id],
    );
    expect(writes.rows[0]).toEqual({ prompt_run_count: 0, raw_evidence_count: 0 });
  }, 120_000);

  test('a fresh Provider policy read failure retries without sending or recording NOT_CHECKED', async () => {
    const { scope, started } = await startApprovedPolicyRun('Measurement Policy Read Failure');
    const store = withPolicyReader(() =>
      Promise.reject(new Error('POLICY_DATABASE_SECRET_MUST_NOT_ESCAPE')),
    );
    const callsBefore = adapterExecuteCalls;
    const clock = { now: () => new Date() };
    const worker = new MeasurementRunJobWorker(
      new JobWorkerCoordinator(
        jobStore,
        clock,
        { next: randomUUID },
        'measurement-policy-read-failure-v1',
      ),
      new MeasurementExecutionHandler(
        store,
        rawEvidenceStore,
        runtimeAdapters,
        { next: randomUUID },
        clock,
        { observationMethodVersion, snapshotMethodVersion },
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
    ).toMatchObject({ outcome: 'RETRY_WAIT', measurementRunId: started.measurementRun.id });
    expect(adapterExecuteCalls - callsBefore).toBe(0);
    const persistence = await pool.query<{
      error_code: string | null;
      prompt_run_count: number;
      status: string;
    }>(
      `SELECT job.status, job.error_code,
         (SELECT count(*)::integer FROM prompt_runs prompt
          WHERE prompt.measurement_run_id = job.aggregate_id) AS prompt_run_count
       FROM jobs job WHERE job.id = $1`,
      [started.job.id],
    );
    expect(persistence.rows[0]).toEqual({
      error_code: 'MEASUREMENT_EXECUTION_TRANSIENT_FAILURE',
      prompt_run_count: 0,
      status: 'RETRY_WAIT',
    });
  }, 120_000);

  test('a running Measurement baseline stops external sends after its Provider policy is revoked', async () => {
    const ownerSession = await signIn(app, 'measurement-owner-a-code');
    const scope = await createScope(app, ownerSession, 'Measurement Live Policy');
    const analystSession = await inviteAndAccept({
      app,
      ownerSession,
      scope,
      role: 'ANALYST',
      email: 'measurement-analyst@example.test',
      code: 'measurement-analyst-code',
    });
    const bundle = await createApprovedPromptScenario(app, ownerSession, analystSession, scope);
    const ownerHeaders = {
      cookie: `__Host-aeo_session=${ownerSession}`,
      origin: 'https://app.example.test',
    };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
          headers: ownerHeaders,
          payload: { limitUnits: 1_000 },
        })
      ).statusCode,
    ).toBe(200);
    const policyUrl =
      `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
      `/measurement-provider-policies/${providerKey}/${surfaceKey}`;
    const policyPayload = {
      adapterVersion,
      termsVersion: 'fixture-terms-2026-07',
      termsApproved: true,
      authorizationApproved: true,
      crossBorderApproved: true,
      purpose: 'live Provider policy revocation fixture',
      policyVersion: 'measurement-provider-policy-v1',
    };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: policyUrl,
          headers: ownerHeaders,
          payload: policyPayload,
        })
      ).statusCode,
    ).toBe(200);
    const startUrl =
      `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` + '/measurement-runs';
    const startedResponse = await app.inject({
      method: 'POST',
      url: startUrl,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        promptSetId: bundle.promptSet.id,
        promptRevisionId: bundle.revision.id,
        scenarioId: bundle.scenario.id,
        expectedPromptHash: bundle.revision.contentHash,
        expectedScenarioHash: bundle.scenario.contentHash,
        kind: 'BASELINE',
        idempotencyKey: randomUUID(),
      },
    });
    expect(startedResponse.statusCode, startedResponse.body).toBe(202);
    const started = StartMeasurementRunEnvelopeSchema.parse(startedResponse.json()).data;
    await pool.query(
      'UPDATE outbox_messages SET published_at = clock_timestamp() WHERE aggregate_id = $1',
      [started.job.id],
    );
    let policyRevoked = false;
    afterNextAdapterExecution = async (executedScope) => {
      expect(executedScope).toEqual({
        tenantId: scope.tenant.id,
        workspaceId: scope.workspace.id,
      });
      const revoked = await app.inject({
        method: 'PUT',
        url: policyUrl,
        headers: ownerHeaders,
        payload: { ...policyPayload, termsApproved: false },
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      policyRevoked = true;
    };
    const callsBefore = adapterExecuteCalls;
    nextAdapterCostCurrency = 'EUR';
    const clock = { now: () => new Date() };
    const worker = new MeasurementRunJobWorker(
      new JobWorkerCoordinator(jobStore, clock, { next: randomUUID }, 'measurement-live-policy-v1'),
      new MeasurementExecutionHandler(
        measurementStore,
        rawEvidenceStore,
        runtimeAdapters,
        { next: randomUUID },
        clock,
        { observationMethodVersion, snapshotMethodVersion },
      ),
    );
    try {
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
      ).toMatchObject({ outcome: 'SUCCEEDED', measurementRunId: started.measurementRun.id });
    } finally {
      afterNextAdapterExecution = undefined;
      nextAdapterCostCurrency = undefined;
    }
    expect(policyRevoked).toBe(true);
    expect(adapterExecuteCalls - callsBefore).toBe(1);

    const runResponse = await app.inject({
      method: 'GET',
      url: `${startUrl}/${started.measurementRun.id}`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(runResponse.statusCode, runResponse.body).toBe(200);
    expect(
      MeasurementRunEnvelopeSchema.parse(runResponse.json()).data.measurementRun,
    ).toMatchObject({
      status: 'COMPLETED',
      expectedPromptRunCount: 60,
      completedPromptRunCount: 60,
    });
    const promptRunsResponse = await app.inject({
      method: 'GET',
      url: `${startUrl}/${started.measurementRun.id}/prompt-runs?limit=100`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    const promptRuns = MeasurementPromptRunListEnvelopeSchema.parse(promptRunsResponse.json()).data
      .promptRuns;
    expect(promptRuns).toHaveLength(60);
    expect(promptRuns.filter((run) => run.policyReason === null)).toHaveLength(1);
    expect(
      promptRuns.filter(
        (run) =>
          run.status === 'NOT_CHECKED' && run.policyReason === 'PROVIDER_POLICY_NOT_APPROVED',
      ),
    ).toHaveLength(59);
    const dashboardResponse = await app.inject({
      method: 'GET',
      url: `${startUrl}/${started.measurementRun.id}/dashboard`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(dashboardResponse.statusCode, dashboardResponse.body).toBe(200);
    const dashboard = MeasurementDashboardEnvelopeSchema.parse(dashboardResponse.json()).data;
    expect(dashboard.resultCounts).toEqual({
      PASS: 1,
      FAIL: 0,
      ERROR: 0,
      NOT_CHECKED: 59,
      INCONCLUSIVE: 0,
      NOT_APPLICABLE: 0,
    });
    expect(dashboard.cost).toBeNull();
    expect(dashboard.costBreakdown).toEqual([
      { amount: '0.001000', currency: 'EUR' },
      { amount: '0.000000', currency: 'USD' },
    ]);
    expect(dashboard.sections[2].cohorts).toEqual([
      expect.objectContaining({ cost: null, costBreakdown: dashboard.costBreakdown }),
    ]);
    expect(
      dashboard.snapshot.metrics.every(
        (metric) => metric.eligibleDenominator === 1 && metric.excludedCounts.NOT_CHECKED === 59,
      ),
    ).toBe(true);
  }, 120_000);

  test('an Analyst runs one approved 20x3 baseline with honest exclusions and tenant-safe evidence drill-down', async () => {
    const adapterCallsAtStart = adapterExecuteCalls;
    const declaredSurfaces = await pool.query<{
      provider_key: string;
      surface_key: string;
      acquisition_class: string;
      acquisition_method: string;
      status: string;
    }>(
      `SELECT provider_key, surface_key, acquisition_class, acquisition_method, status
       FROM provider_surface_registry
       WHERE (provider_key, surface_key) IN (
         ('google-search-console', 'search-performance'),
         ('bing-webmaster-tools', 'search-performance'),
         ('openai', 'chatgpt-search'),
         ('google', 'ai-mode'),
         ('google', 'ai-overviews'),
         ('perplexity', 'answer-surface')
       )
       ORDER BY provider_key, surface_key`,
    );
    expect(declaredSurfaces.rows).toEqual([
      {
        provider_key: 'bing-webmaster-tools',
        surface_key: 'search-performance',
        acquisition_class: 'SEARCH_DATA_API',
        acquisition_method: 'OFFICIAL_API',
        status: 'UNAVAILABLE',
      },
      {
        provider_key: 'google',
        surface_key: 'ai-mode',
        acquisition_class: 'MANUAL_IMPORT',
        acquisition_method: 'MANUAL_IMPORT',
        status: 'UNAVAILABLE',
      },
      {
        provider_key: 'google',
        surface_key: 'ai-overviews',
        acquisition_class: 'MANUAL_IMPORT',
        acquisition_method: 'MANUAL_IMPORT',
        status: 'UNAVAILABLE',
      },
      {
        provider_key: 'google-search-console',
        surface_key: 'search-performance',
        acquisition_class: 'SEARCH_DATA_API',
        acquisition_method: 'OFFICIAL_API',
        status: 'UNAVAILABLE',
      },
      {
        provider_key: 'openai',
        surface_key: 'chatgpt-search',
        acquisition_class: 'MANUAL_IMPORT',
        acquisition_method: 'MANUAL_IMPORT',
        status: 'UNAVAILABLE',
      },
      {
        provider_key: 'perplexity',
        surface_key: 'answer-surface',
        acquisition_class: 'MANUAL_IMPORT',
        acquisition_method: 'MANUAL_IMPORT',
        status: 'UNAVAILABLE',
      },
    ]);

    const ownerSession = await signIn(app, 'measurement-owner-a-code');
    const scope = await createScope(app, ownerSession, 'Measurement A');
    const analystSession = await inviteAndAccept({
      app,
      ownerSession,
      scope,
      role: 'ANALYST',
      email: 'measurement-analyst@example.test',
      code: 'measurement-analyst-code',
    });
    const publisherSession = await inviteAndAccept({
      app,
      ownerSession,
      scope,
      role: 'PUBLISHER',
      email: 'measurement-publisher@example.test',
      code: 'measurement-publisher-code',
    });
    const bundle = await createApprovedPromptScenario(app, ownerSession, analystSession, scope);
    const budget = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { limitUnits: 1_000 },
    });
    expect(budget.statusCode, budget.body).toBe(200);

    const startUrl =
      `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` + '/measurement-runs';
    const startPayload = {
      promptSetId: bundle.promptSet.id,
      promptRevisionId: bundle.revision.id,
      scenarioId: bundle.scenario.id,
      expectedPromptHash: bundle.revision.contentHash,
      expectedScenarioHash: bundle.scenario.contentHash,
      kind: 'BASELINE',
      idempotencyKey: randomUUID(),
    };
    const publisherDenied = await app.inject({
      method: 'POST',
      url: startUrl,
      headers: {
        cookie: `__Host-aeo_session=${publisherSession}`,
        origin: 'https://app.example.test',
      },
      payload: startPayload,
    });
    expect(publisherDenied.statusCode, publisherDenied.body).toBe(403);
    expect(publisherDenied.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(adapterExecuteCalls - adapterCallsAtStart).toBe(0);

    const blockedStartResponse = await app.inject({
      method: 'POST',
      url: startUrl,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload: { ...startPayload, idempotencyKey: randomUUID() },
    });
    expect(blockedStartResponse.statusCode, blockedStartResponse.body).toBe(202);
    const blockedStart = StartMeasurementRunEnvelopeSchema.parse(blockedStartResponse.json()).data;
    const clock = { now: () => new Date() };
    const worker = new MeasurementRunJobWorker(
      new JobWorkerCoordinator(jobStore, clock, { next: randomUUID }, 'measurement-baseline-v1'),
      new MeasurementExecutionHandler(
        measurementStore,
        rawEvidenceStore,
        runtimeAdapters,
        { next: randomUUID },
        clock,
        { observationMethodVersion, snapshotMethodVersion },
      ),
    );
    const workerRuntime = createMeasurementWorkerRuntime({
      queue: new PostgresMeasurementOutboxQueue(pool, jobStore, clock),
      processor: worker,
      pollIntervalMs: 1,
    });
    expect(await workerRuntime.runOnce()).toMatchObject({
      outcome: 'SUCCEEDED',
      measurementRunId: blockedStart.measurementRun.id,
    });
    const publishedOutbox = await pool.query<{ id: string; published_at: Date | null }>(
      'SELECT id, published_at FROM outbox_messages WHERE aggregate_id = $1',
      [blockedStart.job.id],
    );
    expect(publishedOutbox.rows[0]?.published_at).toBeInstanceOf(Date);
    const completedInbox = await pool.query<{ status: string }>(
      `SELECT status
       FROM inbox_messages
       WHERE consumer = 'measurement-baseline-v1' AND message_id = $1`,
      [publishedOutbox.rows[0]?.id],
    );
    expect(completedInbox.rows[0]?.status).toBe('COMPLETED');
    expect(
      adapterExecuteCalls - adapterCallsAtStart,
      'expected an unapproved Provider policy to avoid every adapter execution',
    ).toBe(0);

    const blockedRunsResponse = await app.inject({
      method: 'GET',
      url: `${startUrl}/${blockedStart.measurementRun.id}/prompt-runs?limit=100`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(blockedRunsResponse.statusCode, blockedRunsResponse.body).toBe(200);
    const blockedRuns = MeasurementPromptRunListEnvelopeSchema.parse(blockedRunsResponse.json())
      .data.promptRuns;
    expect(blockedRuns).toHaveLength(60);
    expect(new Set(blockedRuns.map((run) => run.status))).toEqual(new Set(['NOT_CHECKED']));
    expect(blockedRuns.every((run) => run.cost.amount === '0.000000')).toBe(true);
    expect(blockedRuns.every((run) => run.policyReason === 'PROVIDER_POLICY_NOT_APPROVED')).toBe(
      true,
    );
    const blockedDrilldownResponse = await app.inject({
      method: 'GET',
      url: `${startUrl}/${blockedStart.measurementRun.id}/prompt-runs/${blockedRuns[0]?.id ?? ''}`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(blockedDrilldownResponse.statusCode, blockedDrilldownResponse.body).toBe(200);
    expect(
      PromptRunEnvelopeSchema.parse(blockedDrilldownResponse.json()).data.rawEvidence.error,
    ).toMatchObject({ code: 'PROVIDER_POLICY_NOT_APPROVED' });

    const approvePolicy = await app.inject({
      method: 'PUT',
      url:
        `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
        `/measurement-provider-policies/${providerKey}/${surfaceKey}`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        adapterVersion,
        termsVersion: 'fixture-terms-2026-07',
        termsApproved: true,
        authorizationApproved: true,
        crossBorderApproved: true,
        purpose: 'approved measurement fixture',
        policyVersion: 'measurement-provider-policy-v1',
      },
    });
    expect(approvePolicy.statusCode, approvePolicy.body).toBe(200);

    const mainStartPayload = { ...startPayload, idempotencyKey: randomUUID() };
    await pool.query(`
      CREATE FUNCTION task15_measurement_insert_race_barrier() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      BEGIN
        PERFORM pg_sleep(0.25);
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER task15_measurement_insert_race_barrier
      BEFORE INSERT ON measurement_runs
      FOR EACH ROW EXECUTE FUNCTION task15_measurement_insert_race_barrier();
      CREATE FUNCTION task15_job_insert_race_barrier() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      BEGIN
        PERFORM pg_sleep(0.25);
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER task15_job_insert_race_barrier
      BEFORE INSERT ON jobs
      FOR EACH ROW EXECUTE FUNCTION task15_job_insert_race_barrier();
    `);
    let concurrentStarts: Awaited<ReturnType<typeof app.inject>>[];
    try {
      concurrentStarts = await Promise.all(
        [0, 1].map(() =>
          app.inject({
            method: 'POST',
            url: startUrl,
            headers: {
              cookie: `__Host-aeo_session=${analystSession}`,
              origin: 'https://app.example.test',
            },
            payload: mainStartPayload,
          }),
        ),
      );
    } finally {
      await pool.query(`
        DROP TRIGGER task15_job_insert_race_barrier ON jobs;
        DROP FUNCTION task15_job_insert_race_barrier();
        DROP TRIGGER task15_measurement_insert_race_barrier ON measurement_runs;
        DROP FUNCTION task15_measurement_insert_race_barrier();
      `);
    }
    const [startedResponse, replayedStartResponse] = concurrentStarts;
    if (startedResponse === undefined || replayedStartResponse === undefined) {
      throw new Error('EXPECTED_TWO_CONCURRENT_MEASUREMENT_STARTS');
    }
    expect(startedResponse.statusCode, startedResponse.body).toBe(202);
    expect(replayedStartResponse.statusCode, replayedStartResponse.body).toBe(202);
    const started = StartMeasurementRunEnvelopeSchema.parse(startedResponse.json()).data;
    expect(started.measurementRun).toMatchObject({
      status: 'QUEUED',
      kind: 'BASELINE',
      expectedPromptRunCount: 60,
      promptRevisionId: bundle.revision.id,
      scenarioId: bundle.scenario.id,
    });
    const replayedStart = StartMeasurementRunEnvelopeSchema.parse(
      replayedStartResponse.json(),
    ).data;
    expect(replayedStart.measurementRun.id).toBe(started.measurementRun.id);
    expect(replayedStart.job.id).toBe(started.job.id);
    const idempotentCounts = await pool.query<{
      runs: string;
      jobs: string;
      reservations: string;
      outbox: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM measurement_runs WHERE idempotency_key = $1) AS runs,
         (SELECT count(*)::text FROM jobs WHERE idempotency_key = $1) AS jobs,
         (SELECT count(*)::text FROM budget_reservations WHERE job_id = $2) AS reservations,
         (SELECT count(*)::text FROM outbox_messages WHERE aggregate_id = $2) AS outbox`,
      [mainStartPayload.idempotencyKey, started.job.id],
    );
    expect(idempotentCounts.rows[0]).toEqual({
      runs: '1',
      jobs: '1',
      reservations: '1',
      outbox: '1',
    });
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
    ).toMatchObject({ outcome: 'SUCCEEDED', measurementRunId: started.measurementRun.id });
    expect(adapterExecuteCalls - adapterCallsAtStart).toBe(60);

    const runResponse = await app.inject({
      method: 'GET',
      url: `${startUrl}/${started.measurementRun.id}`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(runResponse.statusCode, runResponse.body).toBe(200);
    const completedRun = MeasurementRunEnvelopeSchema.parse(runResponse.json()).data.measurementRun;
    expect(completedRun).toMatchObject({
      id: started.measurementRun.id,
      status: 'COMPLETED',
      expectedPromptRunCount: 60,
      completedPromptRunCount: 60,
      scenarioId: bundle.scenario.id,
      scenarioVersion: 1,
      providerKey,
      surfaceKey,
      model: 'fixture-search-model',
      modelVersion: '2026-07',
      acquisitionClass: 'MANUAL_IMPORT',
      acquisitionMethod,
      adapterVersion,
    });
    expect(completedRun.scenarioSnapshot).toMatchObject({
      providerKey,
      surfaceKey,
      model: 'fixture-search-model',
      modelVersion: '2026-07',
      acquisitionClass: 'MANUAL_IMPORT',
      acquisitionMethod,
      registryStatus: 'AVAILABLE',
      repetitions: 3,
      scopes: [{ market: 'SG', locale: 'en-SG', region: 'Singapore' }],
    });

    const promptRunsResponse = await app.inject({
      method: 'GET',
      url: `${startUrl}/${started.measurementRun.id}/prompt-runs?limit=100`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(promptRunsResponse.statusCode, promptRunsResponse.body).toBe(200);
    const promptRuns = MeasurementPromptRunListEnvelopeSchema.parse(promptRunsResponse.json()).data
      .promptRuns;
    expect(promptRuns).toHaveLength(60);
    expect(new Set(promptRuns.map((run) => run.promptId))).toEqual(
      new Set(bundle.revision.prompts.map((prompt) => prompt.id)),
    );
    for (const prompt of bundle.revision.prompts) {
      expect(
        promptRuns
          .filter((run) => run.promptId === prompt.id)
          .map((run) => run.repetition)
          .sort(),
      ).toEqual([1, 2, 3]);
    }
    expect(new Set(promptRuns.map((run) => run.scopeKey)).size).toBe(1);
    expect(
      promptRuns.every(
        (run) =>
          run.providerKey === providerKey &&
          run.surfaceKey === surfaceKey &&
          run.model === 'fixture-search-model' &&
          run.modelVersion === '2026-07' &&
          run.scenarioId === bundle.scenario.id &&
          run.scenarioVersion === 1 &&
          run.acquisitionMethod === acquisitionMethod &&
          run.acquisitionClass === 'MANUAL_IMPORT' &&
          run.adapterKey === 'recorded-measurement-fixture' &&
          run.adapterVersion === adapterVersion &&
          run.methodVersion === observationMethodVersion,
      ),
    ).toBe(true);
    expect(
      promptRuns.reduce<Record<string, number>>((counts, run) => {
        counts[run.status] = (counts[run.status] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({ PASS: 10, FAIL: 20, ERROR: 10, NOT_CHECKED: 10, INCONCLUSIVE: 10 });

    const excludedStatuses = new Set(['ERROR', 'NOT_CHECKED', 'INCONCLUSIVE', 'NOT_APPLICABLE']);
    const mentionEligible = promptRuns.filter((run) => !excludedStatuses.has(run.status));
    const mentionNumerator = mentionEligible.filter((run) => run.observation.mention === true);
    const dashboardResponse = await app.inject({
      method: 'GET',
      url: `${startUrl}/${started.measurementRun.id}/dashboard`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(dashboardResponse.statusCode, dashboardResponse.body).toBe(200);
    const dashboard = MeasurementDashboardEnvelopeSchema.parse(dashboardResponse.json()).data;
    expect(dashboard.sections.map((section) => section.key)).toEqual([
      'TECHNICAL_HEALTH',
      'CONTENT_EVIDENCE_READINESS',
      'MEASURED_AI_VISIBILITY',
    ]);
    expect(dashboard.sections[0]).toEqual({
      key: 'TECHNICAL_HEALTH',
      sourceKind: 'OWNED_SITE_BASELINE',
      summary: {
        state: 'NOT_LINKED',
        reason: 'MEASUREMENT_SCENARIO_SITE_NOT_LINKED',
      },
    });
    expect(dashboard.sections[1]).toEqual({
      key: 'CONTENT_EVIDENCE_READINESS',
      sourceKind: 'CLAIM_EVIDENCE_LEDGER',
      summary: {
        state: 'NOT_LINKED',
        reason: 'MEASUREMENT_SCENARIO_CLAIM_SET_NOT_LINKED',
      },
    });
    const measuredSection = dashboard.sections.find(
      (section) => section.key === 'MEASURED_AI_VISIBILITY',
    );
    expect(measuredSection, 'expected surface cohorts separated').toBeDefined();
    expect(measuredSection?.cohorts).toHaveLength(1);
    expect(measuredSection?.cohorts[0]?.cohort).toEqual({
      providerKey,
      surfaceKey,
      acquisitionClass: 'MANUAL_IMPORT',
      acquisitionMethod,
      adapterKey: 'recorded-measurement-fixture',
      adapterVersion,
      model: 'fixture-search-model',
      modelVersion: '2026-07',
      scenarioId: bundle.scenario.id,
      scenarioVersion: 1,
      scopeKey: promptRuns[0]?.scopeKey,
    });
    expect(measuredSection?.crossSurfaceAggregate).toBeUndefined();

    const mentionMetric = dashboard.snapshot.metrics.find(
      (metric) => metric.metricKey === 'MENTION_RATE',
    );
    expect(
      mentionMetric?.eligibleDenominator,
      `expected eligible denominator ${mentionEligible.length}, received ${mentionMetric?.eligibleDenominator}`,
    ).toBe(mentionEligible.length);
    expect(mentionMetric).toMatchObject({
      numerator: mentionNumerator.length,
      eligibleDenominator: 30,
      excludedCounts: {
        ERROR: 10,
        NOT_CHECKED: 10,
        INCONCLUSIVE: 10,
        NOT_APPLICABLE: 0,
      },
      methodVersion: snapshotMethodVersion,
    });
    const persistedMentionObservations = await pool.query<{
      id: string;
      prompt_run_id: string;
      classification: MetricClassification;
      cohort: MetricCohort;
    }>(
      `SELECT id, prompt_run_id, classification, cohort
       FROM metric_observations
       WHERE measurement_run_id = $1 AND metric_key = 'MENTION_RATE'
       ORDER BY id`,
      [started.measurementRun.id],
    );
    const recomputedMentionMetric = buildMetricSnapshot({
      metricKey: 'MENTION_RATE',
      methodVersion: snapshotMethodVersion,
      observations: persistedMentionObservations.rows.map((row) => ({
        id: row.id,
        promptRunId: row.prompt_run_id,
        metricKey: 'MENTION_RATE',
        classification: row.classification,
        cohort: row.cohort,
      })),
    });
    expect(mentionMetric).toMatchObject({
      numerator: recomputedMentionMetric.numerator,
      eligibleDenominator: recomputedMentionMetric.eligibleDenominator,
      value: recomputedMentionMetric.value,
      excludedCounts: recomputedMentionMetric.excludedCounts,
      sourceHash: recomputedMentionMetric.sourceHash,
      contentHash: recomputedMentionMetric.contentHash,
    });
    expect(new Set(mentionMetric?.promptRunIds)).toEqual(new Set(promptRuns.map((run) => run.id)));
    expect(dashboard.snapshot.metrics.map((metric) => metric.metricKey).sort()).toEqual([
      'ACCURACY_RATE',
      'CITATION_RATE',
      'COVERAGE_RATE',
      'MENTION_RATE',
    ]);
    const accuracyMetric = dashboard.snapshot.metrics.find(
      (metric) => metric.metricKey === 'ACCURACY_RATE',
    );
    expect(accuracyMetric).toMatchObject({
      numerator: 10,
      eligibleDenominator: 20,
      excludedCounts: {
        ERROR: 10,
        NOT_CHECKED: 10,
        INCONCLUSIVE: 10,
        NOT_APPLICABLE: 10,
      },
      methodVersion: snapshotMethodVersion,
    });
    expect(dashboard.cost).toEqual({ amount: '0.060000', currency: 'USD' });
    expect(dashboard.resultCounts).toEqual({
      PASS: 10,
      FAIL: 20,
      ERROR: 10,
      NOT_CHECKED: 10,
      INCONCLUSIVE: 10,
      NOT_APPLICABLE: 0,
    });

    const metricDimensions = [
      'MENTION_RATE',
      'CITATION_RATE',
      'ACCURACY_RATE',
      'COVERAGE_RATE',
    ] as const;
    for (const dimension of metricDimensions) {
      const dimensionResponse = await app.inject({
        method: 'GET',
        url:
          `${startUrl}/${started.measurementRun.id}/prompt-runs?limit=100&dimension=` + dimension,
        headers: { cookie: `__Host-aeo_session=${analystSession}` },
      });
      expect(dimensionResponse.statusCode, dimensionResponse.body).toBe(200);
      const dimensionRuns = MeasurementPromptRunListEnvelopeSchema.parse(dimensionResponse.json());
      const snapshot = dashboard.snapshot.metrics.find((metric) => metric.metricKey === dimension);
      expect(dimensionRuns.meta.total).toBe(snapshot?.promptRunIds.length);
      expect(new Set(dimensionRuns.data.promptRuns.map((run) => run.id))).toEqual(
        new Set(snapshot?.promptRunIds),
      );
    }
    const costRunsResponse = await app.inject({
      method: 'GET',
      url: `${startUrl}/${started.measurementRun.id}/prompt-runs?limit=100&dimension=COST`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    const costRuns = MeasurementPromptRunListEnvelopeSchema.parse(costRunsResponse.json());
    expect(costRuns.meta.total).toBe(60);
    const errorRunsResponse = await app.inject({
      method: 'GET',
      url: `${startUrl}/${started.measurementRun.id}/prompt-runs?limit=100&dimension=ERROR`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    const errorRuns = MeasurementPromptRunListEnvelopeSchema.parse(errorRunsResponse.json());
    expect(errorRuns.meta.total, 'expected filtered Error PromptRun total').toBe(10);
    expect(errorRuns.data.promptRuns).toHaveLength(10);
    expect(new Set(errorRuns.data.promptRuns.map((run) => run.status))).toEqual(new Set(['ERROR']));
    const invalidDimension = await app.inject({
      method: 'GET',
      url: `${startUrl}/${started.measurementRun.id}/prompt-runs?dimension=NOT_A_DIMENSION`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(invalidDimension.statusCode, invalidDimension.body).toBe(400);

    const citedRun = promptRuns.find((run) => run.observation.citation === true);
    const errorRun = promptRuns.find((run) => run.status === 'ERROR');
    expect(citedRun, 'expected raw PromptRun drill-down').toBeDefined();
    expect(errorRun, 'expected raw PromptRun error drill-down').toBeDefined();
    for (const expected of [citedRun, errorRun]) {
      if (expected === undefined) continue;
      const drilldownResponse = await app.inject({
        method: 'GET',
        url: `${startUrl}/${started.measurementRun.id}/prompt-runs/${expected.id}`,
        headers: { cookie: `__Host-aeo_session=${analystSession}` },
      });
      expect(drilldownResponse.statusCode, 'expected raw PromptRun drill-down').toBe(200);
      const drilldown = PromptRunEnvelopeSchema.parse(drilldownResponse.json()).data;
      expect(drilldown.promptRun).toMatchObject({
        id: expected.id,
        measurementRunId: started.measurementRun.id,
        providerKey,
        surfaceKey,
        model: 'fixture-search-model',
        modelVersion: '2026-07',
        scenarioId: bundle.scenario.id,
        scenarioVersion: 1,
        acquisitionMethod,
        acquisitionClass: 'MANUAL_IMPORT',
        adapterKey: 'recorded-measurement-fixture',
        adapterVersion,
        methodVersion: observationMethodVersion,
        cost: { amount: '0.001000', currency: 'USD' },
      });
      expect(drilldown.rawEvidence.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
    const citedDrilldown = PromptRunEnvelopeSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `${startUrl}/${started.measurementRun.id}/prompt-runs/${citedRun?.id ?? ''}`,
          headers: { cookie: `__Host-aeo_session=${analystSession}` },
        })
      ).json(),
    ).data;
    expect(citedDrilldown.rawEvidence.citations[0]).toMatchObject({
      url: 'https://sources.example.test/guided-learning',
      snippet: 'Recorded fixture citation for measurement verification.',
    });
    const durableReference = await pool.query<{ object_ref: string; content_hash: string }>(
      `SELECT object_ref, content_hash FROM raw_evidence_refs
       WHERE id = $1 AND measurement_run_id = $2`,
      [citedRun?.id, started.measurementRun.id],
    );
    const persistedPayload = await new PostgresMeasurementRawEvidenceStore(pool).get({
      tenantId: scope.tenant.id,
      workspaceId: scope.workspace.id,
      objectRef: durableReference.rows[0]?.object_ref ?? '',
      contentHash: durableReference.rows[0]?.content_hash ?? '',
    });
    expect(persistedPayload?.citations[0]).toMatchObject({
      url: 'https://sources.example.test/guided-learning',
    });
    const errorDrilldown = PromptRunEnvelopeSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `${startUrl}/${started.measurementRun.id}/prompt-runs/${errorRun?.id ?? ''}`,
          headers: { cookie: `__Host-aeo_session=${analystSession}` },
        })
      ).json(),
    ).data;
    expect(errorDrilldown.rawEvidence.error).toEqual({
      code: 'FIXTURE_PROVIDER_TIMEOUT',
      message: 'Recorded fixture timeout; no external network was called.',
    });

    const ownerBSession = await signIn(app, 'measurement-owner-b-code');
    const scopeB = await createScope(app, ownerBSession, 'Measurement B');
    const crossTenantApi = await app.inject({
      method: 'GET',
      url: `${startUrl}/${started.measurementRun.id}`,
      headers: { cookie: `__Host-aeo_session=${ownerBSession}` },
    });
    expect(crossTenantApi.statusCode, crossTenantApi.body).toBe(404);
    expect(crossTenantApi.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });
    expect(crossTenantApi.body).not.toContain(providerKey);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE aeostudio_runtime');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scopeB.tenant.id]);
      const hiddenRuns = await client.query<{ count: string }>(
        'SELECT count(*) FROM measurement_runs WHERE id = $1',
        [started.measurementRun.id],
      );
      const hiddenPromptRuns = await client.query<{ count: string }>(
        'SELECT count(*) FROM prompt_runs WHERE measurement_run_id = $1',
        [started.measurementRun.id],
      );
      expect(hiddenRuns.rows[0]?.count).toBe('0');
      expect(hiddenPromptRuns.rows[0]?.count).toBe('0');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }, 120_000);

  test('a two-scope run resumes unfinished slots, contains adapter failure, and paginates exact cohorts', async () => {
    const ownerSession = await signIn(app, 'measurement-owner-a-code');
    const scope = await createScope(app, ownerSession, 'Measurement Resume');
    const analystSession = await inviteAndAccept({
      app,
      ownerSession,
      scope,
      role: 'ANALYST',
      email: 'measurement-analyst@example.test',
      code: 'measurement-analyst-code',
    });
    const bundle = await createApprovedPromptScenario(app, ownerSession, analystSession, scope, [
      { market: 'SG', locale: 'en-SG', region: 'Singapore' },
      { market: 'TW', locale: 'zh-TW', region: 'Taiwan' },
    ]);
    const ownerHeaders = {
      cookie: `__Host-aeo_session=${ownerSession}`,
      origin: 'https://app.example.test',
    };
    const budget = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
      headers: ownerHeaders,
      payload: { limitUnits: 1_000 },
    });
    expect(budget.statusCode, budget.body).toBe(200);
    const policy = await app.inject({
      method: 'PUT',
      url:
        `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
        `/measurement-provider-policies/${providerKey}/${surfaceKey}`,
      headers: ownerHeaders,
      payload: {
        adapterVersion,
        termsVersion: 'fixture-terms-2026-07',
        termsApproved: true,
        authorizationApproved: true,
        crossBorderApproved: true,
        purpose: 'approved resumable measurement fixture',
        policyVersion: 'measurement-provider-policy-v1',
      },
    });
    expect(policy.statusCode, policy.body).toBe(200);

    const baseUrl = `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/measurement-runs`;
    const startedResponse = await app.inject({
      method: 'POST',
      url: baseUrl,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        promptSetId: bundle.promptSet.id,
        promptRevisionId: bundle.revision.id,
        scenarioId: bundle.scenario.id,
        expectedPromptHash: bundle.revision.contentHash,
        expectedScenarioHash: bundle.scenario.contentHash,
        kind: 'BASELINE',
        idempotencyKey: randomUUID(),
      },
    });
    expect(startedResponse.statusCode, startedResponse.body).toBe(202);
    const started = StartMeasurementRunEnvelopeSchema.parse(startedResponse.json()).data;
    expect(started.measurementRun.expectedPromptRunCount).toBe(120);

    let recordAttempts = 0;
    let interruptAfterFive = true;
    const resumableStore: MeasurementStore = {
      prepareRun: (input) => measurementStore.prepareRun(input),
      bindJob: (input) => measurementStore.bindJob(input),
      setProviderPolicy: (input) => measurementStore.setProviderPolicy(input),
      findProviderPolicy: (input) => measurementStore.findProviderPolicy(input),
      findRun: (input) => measurementStore.findRun(input),
      listPromptRuns: (input) => measurementStore.listPromptRuns(input),
      findPromptRun: (input) => measurementStore.findPromptRun(input),
      loadDashboard: (input) => measurementStore.loadDashboard(input),
      loadExecutionPlan: (input) => measurementStore.loadExecutionPlan(input),
      markRunning: (input) => measurementStore.markRunning(input),
      async recordPromptRun(input) {
        recordAttempts += 1;
        if (interruptAfterFive && recordAttempts === 5) {
          interruptAfterFive = false;
          throw new Error('FIXTURE_PERSISTENCE_SECRET_MUST_NOT_ESCAPE');
        }
        return measurementStore.recordPromptRun(input);
      },
      completeRun: (input) => measurementStore.completeRun(input),
    };
    let nowMs = Date.now();
    const clock = { now: () => new Date(nowMs) };
    const worker = new MeasurementRunJobWorker(
      new JobWorkerCoordinator(jobStore, clock, { next: randomUUID }, 'measurement-resume-v1'),
      new MeasurementExecutionHandler(
        resumableStore,
        rawEvidenceStore,
        runtimeAdapters,
        { next: randomUUID },
        clock,
        { observationMethodVersion, snapshotMethodVersion },
        { adapterTimeoutMs: 25 },
      ),
    );
    const messagePayload = {
      jobId: started.job.id,
      tenantId: scope.tenant.id,
      workspaceId: scope.workspace.id,
      schemaVersion: '1.0.0',
    } as const;
    const callsBefore = adapterExecuteCalls;
    const keysBefore = adapterIdempotencyKeys.length;
    timeoutNextAdapterExecution = true;
    throwNextAdapterExecution = true;
    expect(
      await worker.process({ messageId: randomUUID(), payload: messagePayload }),
    ).toMatchObject({
      outcome: 'RETRY_WAIT',
      measurementRunId: started.measurementRun.id,
    });
    expect(adapterExecuteCalls - callsBefore).toBe(5);
    expect(timeoutAbortObserved).toBe(true);

    const interruptedResponse = await app.inject({
      method: 'GET',
      url: `${baseUrl}/${started.measurementRun.id}`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    const interrupted = MeasurementRunEnvelopeSchema.parse(interruptedResponse.json()).data
      .measurementRun;
    expect(interrupted).toMatchObject({ status: 'RUNNING', completedPromptRunCount: 4 });
    const retryJob = await pool.query<{ status: string; error_code: string }>(
      'SELECT status, error_code FROM jobs WHERE id = $1',
      [started.job.id],
    );
    expect(retryJob.rows[0]).toEqual({
      status: 'RETRY_WAIT',
      error_code: 'MEASUREMENT_EXECUTION_TRANSIENT_FAILURE',
    });

    nowMs += 120_000;
    const resumedOutcome = await worker.process({
      messageId: randomUUID(),
      payload: messagePayload,
    });
    expect(resumedOutcome).toMatchObject({
      outcome: 'SUCCEEDED',
      measurementRunId: started.measurementRun.id,
    });
    expect(
      'providerFailureCount' in resumedOutcome ? (resumedOutcome.providerFailureCount ?? 0) : 0,
    ).toBeGreaterThanOrEqual(2);
    expect(adapterExecuteCalls - callsBefore).toBe(121);
    const resumedKeys = adapterIdempotencyKeys.slice(keysBefore);
    expect(new Set(resumedKeys).size).toBe(120);
    expect(
      [...new Set(resumedKeys)].filter(
        (key) => resumedKeys.filter((candidate) => candidate === key).length === 2,
      ),
      'expected the post-provider/pre-persistence retry to reuse one exact slot idempotency key',
    ).toHaveLength(1);

    const firstPageResponse = await app.inject({
      method: 'GET',
      url: `${baseUrl}/${started.measurementRun.id}/prompt-runs?limit=100&offset=0`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    const firstPage = MeasurementPromptRunListEnvelopeSchema.parse(firstPageResponse.json());
    expect(firstPage.data.promptRuns).toHaveLength(100);
    expect(firstPage.meta).toMatchObject({ total: 120, limit: 100, offset: 0, nextOffset: 100 });
    const secondPageResponse = await app.inject({
      method: 'GET',
      url: `${baseUrl}/${started.measurementRun.id}/prompt-runs?limit=100&offset=${firstPage.meta.nextOffset ?? 0}`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    const secondPage = MeasurementPromptRunListEnvelopeSchema.parse(secondPageResponse.json());
    expect(secondPage.data.promptRuns).toHaveLength(20);
    expect(secondPage.meta).toMatchObject({ total: 120, offset: 100, nextOffset: null });
    const allRuns = [...firstPage.data.promptRuns, ...secondPage.data.promptRuns];
    expect(new Set(allRuns.map((run) => run.id)).size).toBe(120);
    const scopeKeys = [...new Set(allRuns.map((run) => run.scopeKey))];
    expect(scopeKeys).toHaveLength(2);
    for (const exactScopeKey of scopeKeys) {
      const scopedResponse = await app.inject({
        method: 'GET',
        url:
          `${baseUrl}/${started.measurementRun.id}/prompt-runs?limit=100&offset=0&scopeKey=` +
          encodeURIComponent(exactScopeKey),
        headers: { cookie: `__Host-aeo_session=${analystSession}` },
      });
      const scoped = MeasurementPromptRunListEnvelopeSchema.parse(scopedResponse.json());
      expect(scoped.meta).toMatchObject({ total: 60, nextOffset: null });
      expect(scoped.data.promptRuns).toHaveLength(60);
      expect(scoped.data.promptRuns.every((run) => run.scopeKey === exactScopeKey)).toBe(true);
    }

    const adapterFailures = allRuns.filter(
      (run) => run.status === 'ERROR' && run.cost.amount === '0.000000',
    );
    expect(adapterFailures.length).toBeGreaterThanOrEqual(2);
    const failureEvidence = await Promise.all(
      adapterFailures.map((adapterFailure) =>
        app.inject({
          method: 'GET',
          url: `${baseUrl}/${started.measurementRun.id}/prompt-runs/${adapterFailure.id}`,
          headers: { cookie: `__Host-aeo_session=${analystSession}` },
        }),
      ),
    );
    expect(failureEvidence.map((response) => response.body).join('')).not.toContain(
      'FIXTURE_SECRET',
    );
    const safeErrors = failureEvidence.map(
      (response) => PromptRunEnvelopeSchema.parse(response.json()).data.rawEvidence.error,
    );
    expect(safeErrors).toContainEqual({
      code: 'MEASUREMENT_ADAPTER_TIMEOUT',
      message: 'The approved measurement Adapter exceeded its execution deadline.',
    });
    expect(safeErrors).toContainEqual({
      code: 'MEASUREMENT_ADAPTER_EXECUTION_ERROR',
      message: 'The approved measurement Adapter execution failed.',
    });
    const oneFailureResponse = await app.inject({
      method: 'GET',
      url: `${baseUrl}/${started.measurementRun.id}/prompt-runs/${adapterFailures[0]?.id ?? ''}`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(oneFailureResponse.statusCode).toBe(200);

    const dashboardResponse = await app.inject({
      method: 'GET',
      url: `${baseUrl}/${started.measurementRun.id}/dashboard`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    const dashboard = MeasurementDashboardEnvelopeSchema.parse(dashboardResponse.json()).data;
    expect(dashboard.snapshot.metrics).toHaveLength(8);
    const cohorts = dashboard.sections.find(
      (section) => section.key === 'MEASURED_AI_VISIBILITY',
    )?.cohorts;
    expect(cohorts).toHaveLength(2);
    for (const cohort of cohorts ?? []) {
      expect(cohort.metricIds).toHaveLength(4);
      expect(Object.values(cohort.resultCounts).reduce((sum, count) => sum + count, 0)).toBe(60);
      expect(cohort.costBreakdown).toHaveLength(1);
      expect(cohort.costBreakdown[0]?.currency).toBe('USD');
      expect(cohort.cost).toEqual(cohort.costBreakdown[0]);
      expect(
        dashboard.snapshot.metrics
          .filter((metric) => cohort.metricIds.includes(metric.id))
          .every((metric) => metric.promptRunIds.length === 60),
      ).toBe(true);
    }
  }, 120_000);

  test('a reviewed manual import is bound to one approved source and consumed only by a new baseline', async () => {
    const ownerSession = await signIn(app, 'measurement-owner-a-code');
    const scope = await createScope(app, ownerSession, 'Reviewed Manual Import');
    const analystSession = await inviteAndAccept({
      app,
      ownerSession,
      scope,
      role: 'ANALYST',
      email: 'measurement-analyst@example.test',
      code: 'measurement-analyst-code',
    });
    const reviewerSession = await inviteAndAccept({
      app,
      ownerSession,
      scope,
      role: 'REVIEWER',
      email: 'measurement-reviewer@example.test',
      code: 'measurement-reviewer-code',
    });
    const bundle = await createApprovedPromptScenario(
      app,
      ownerSession,
      analystSession,
      scope,
      [{ market: 'SG', locale: 'en-SG', region: 'Singapore' }],
      {
        providerKey: 'openai',
        surfaceKey: 'chatgpt-search',
        model: 'reviewed-manual-import',
        modelVersion: 'captured-2026-07-21',
        account: 'reviewed-workspace-capture',
        acquisitionMethod: 'MANUAL_IMPORT',
      },
    );
    const importUrl =
      `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
      '/measurement-manual-imports';
    const importHeaders = {
      cookie: `__Host-aeo_session=${analystSession}`,
      origin: 'https://app.example.test',
    };
    const importIdempotencyKey = randomUUID();
    const importPayload = {
      schemaVersion: 'measurement-manual-import.v1',
      promptSetId: bundle.promptSet.id,
      promptRevisionId: bundle.revision.id,
      scenarioId: bundle.scenario.id,
      expectedPromptHash: bundle.revision.contentHash,
      expectedScenarioHash: bundle.scenario.contentHash,
      idempotencyKey: importIdempotencyKey,
      entries: [
        {
          promptId: bundle.revision.prompts[0]?.id,
          scope: bundle.revision.scopes[0],
          repetition: 1,
          observedAt: '2026-07-21T11:59:00.000Z',
          result: {
            status: 'PASS',
            observation: {
              mention: true,
              citation: true,
              accuracy: 'MATCH',
              coverage: true,
            },
            cost: { amount: '0.000000', currency: 'USD' },
            rawEvidence: {
              responseText: 'Reviewed manual capture for the approved prompt and exact scope.',
              citations: [
                {
                  url: 'https://sources.example.test/reviewed-manual-capture',
                  title: 'Reviewed manual capture',
                  snippet: 'Evidence captured by the workspace analyst.',
                },
              ],
              error: null,
            },
          },
        },
      ],
    } as const;
    const [submitted, concurrentReplay] = await Promise.all([
      app.inject({
        method: 'POST',
        url: importUrl,
        headers: importHeaders,
        payload: importPayload,
      }),
      app.inject({
        method: 'POST',
        url: importUrl,
        headers: importHeaders,
        payload: importPayload,
      }),
    ]);
    expect(submitted.statusCode, submitted.body).toBe(201);
    expect(concurrentReplay.statusCode, concurrentReplay.body).toBe(201);
    expect(submitted.json()).toMatchObject({
      data: {
        manualImport: {
          status: 'SUBMITTED',
          expectedSlotCount: 60,
          providedSlotCount: 1,
        },
      },
    });
    const submittedImport = submitted.json<{
      data: { manualImport: { id: string; contentHash: string } };
    }>().data.manualImport;
    expect(
      concurrentReplay.json<{ data: { manualImport: { id: string } } }>().data.manualImport.id,
    ).toBe(submittedImport.id);
    const firstEntry = importPayload.entries[0];
    const idempotencyConflict = await app.inject({
      method: 'POST',
      url: importUrl,
      headers: importHeaders,
      payload: {
        ...importPayload,
        entries: [{ ...firstEntry, observedAt: '2026-07-21T11:58:00.000Z' }],
      },
    });
    expect(idempotencyConflict.statusCode, idempotencyConflict.body).toBe(409);
    expect(idempotencyConflict.json()).toMatchObject({
      code: 'MANUAL_IMPORT_IDEMPOTENCY_CONFLICT',
    });
    const evidenceHashConflict = await app.inject({
      method: 'POST',
      url: importUrl,
      headers: importHeaders,
      payload: {
        ...importPayload,
        idempotencyKey: randomUUID(),
        entries: [
          {
            ...firstEntry,
            result: {
              ...firstEntry.result,
              rawEvidence: {
                ...firstEntry.result.rawEvidence,
                contentHash: '0'.repeat(64),
              },
            },
          },
        ],
      },
    });
    expect(evidenceHashConflict.statusCode, evidenceHashConflict.body).toBe(409);
    expect(evidenceHashConflict.json()).toMatchObject({
      code: 'MANUAL_IMPORT_EVIDENCE_HASH_MISMATCH',
    });
    const duplicateSlot = await app.inject({
      method: 'POST',
      url: importUrl,
      headers: importHeaders,
      payload: {
        ...importPayload,
        idempotencyKey: randomUUID(),
        entries: [firstEntry, firstEntry],
      },
    });
    expect(duplicateSlot.statusCode, duplicateSlot.body).toBe(400);
    expect(duplicateSlot.json()).toMatchObject({ code: 'MANUAL_IMPORT_ENTRIES_INVALID' });
    const mixedCurrency = await app.inject({
      method: 'POST',
      url: importUrl,
      headers: importHeaders,
      payload: {
        ...importPayload,
        idempotencyKey: randomUUID(),
        entries: [
          firstEntry,
          {
            ...firstEntry,
            promptId: bundle.revision.prompts[1]?.id,
            result: {
              ...firstEntry.result,
              cost: { amount: '0.000000', currency: 'EUR' },
            },
          },
        ],
      },
    });
    expect(mixedCurrency.statusCode, mixedCurrency.body).toBe(400);
    expect(mixedCurrency.json()).toMatchObject({ code: 'MANUAL_IMPORT_ENTRIES_INVALID' });
    const persistedImport = await pool.query<{
      import_count: string;
      slot_count: string;
      provided_count: string;
      raw_evidence_content_hash: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM measurement_manual_imports WHERE id = $1) AS import_count,
         count(*)::text AS slot_count,
         count(*) FILTER (WHERE slot.provided)::text AS provided_count,
         max(slot.raw_evidence_content_hash) FILTER (WHERE slot.provided)
           AS raw_evidence_content_hash
       FROM measurement_manual_import_slots slot WHERE slot.manual_import_id = $1`,
      [submittedImport.id],
    );
    expect(persistedImport.rows[0]).toEqual({
      import_count: '1',
      slot_count: '60',
      provided_count: '1',
      raw_evidence_content_hash: manualMeasurementImportHash(firstEntry.result.rawEvidence),
    });
    const reviewDetailResponse = await app.inject({
      method: 'GET',
      url: `${importUrl}/${submittedImport.id}`,
      headers: { cookie: `__Host-aeo_session=${reviewerSession}` },
    });
    expect(reviewDetailResponse.statusCode, reviewDetailResponse.body).toBe(200);
    const reviewDetail = ManualMeasurementImportDetailEnvelopeSchema.parse(
      reviewDetailResponse.json(),
    ).data;
    expect(reviewDetail.manualImport).toMatchObject({
      id: submittedImport.id,
      status: 'SUBMITTED',
      contentHash: submittedImport.contentHash,
      expectedSlotCount: 60,
      providedSlotCount: 1,
    });
    expect(reviewDetail.slots).toHaveLength(60);
    const providedReviewSlot = reviewDetail.slots.find((slot) => slot.provided);
    expect(providedReviewSlot).toMatchObject({
      prompt: {
        id: firstEntry.promptId,
        ordinal: 1,
        text: bundle.revision.prompts[0]?.text,
      },
      scope: firstEntry.scope,
      repetition: 1,
      observedAt: firstEntry.observedAt,
      result: firstEntry.result,
      rawEvidenceContentHash: manualMeasurementImportHash(firstEntry.result.rawEvidence),
    });
    expect(providedReviewSlot?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    const missingReviewSlot = reviewDetail.slots.find((slot) => !slot.provided);
    expect(missingReviewSlot).toMatchObject({
      observedAt: null,
      result: null,
      rawEvidenceContentHash: null,
    });
    expect(missingReviewSlot?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    const rlsTables = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('measurement_manual_imports', 'measurement_manual_import_slots')
       ORDER BY relname`,
    );
    expect(rlsTables.rows).toEqual([
      {
        relname: 'measurement_manual_import_slots',
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: 'measurement_manual_imports',
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
    ]);
    const reviewUrl =
      `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
      `/measurement-manual-imports/${submittedImport.id}/review`;
    const budget = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { limitUnits: 1_000 },
    });
    expect(budget.statusCode, budget.body).toBe(200);
    const startUrl =
      `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` + '/measurement-runs';
    const startPayload = {
      promptSetId: bundle.promptSet.id,
      promptRevisionId: bundle.revision.id,
      scenarioId: bundle.scenario.id,
      expectedPromptHash: bundle.revision.contentHash,
      expectedScenarioHash: bundle.scenario.contentHash,
      manualImportId: submittedImport.id,
      expectedManualImportHash: submittedImport.contentHash,
      kind: 'BASELINE',
      idempotencyKey: randomUUID(),
    } as const;
    const unreviewedStart = await app.inject({
      method: 'POST',
      url: startUrl,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload: startPayload,
    });
    expect(unreviewedStart.statusCode, unreviewedStart.body).toBe(409);
    expect(unreviewedStart.json()).toMatchObject({ code: 'MANUAL_IMPORT_NOT_APPROVED' });
    const analystReview = await app.inject({
      method: 'POST',
      url: reviewUrl,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload: { expectedContentHash: submittedImport.contentHash, decision: 'APPROVE' },
    });
    expect(analystReview.statusCode, analystReview.body).toBe(403);
    const reviewed = await app.inject({
      method: 'POST',
      url: reviewUrl,
      headers: {
        cookie: `__Host-aeo_session=${reviewerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        expectedContentHash: submittedImport.contentHash,
        decision: 'APPROVE',
        note: 'Verified against the captured answer surface and approved source bundle.',
      },
    });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(reviewed.json()).toMatchObject({
      data: {
        manualImport: {
          id: submittedImport.id,
          status: 'APPROVED',
          contentHash: submittedImport.contentHash,
        },
      },
    });
    const wrongImportHash = await app.inject({
      method: 'POST',
      url: startUrl,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        ...startPayload,
        expectedManualImportHash: '0'.repeat(64),
        idempotencyKey: randomUUID(),
      },
    });
    expect(wrongImportHash.statusCode, wrongImportHash.body).toBe(409);
    expect(wrongImportHash.json()).toMatchObject({ code: 'MANUAL_IMPORT_NOT_APPROVED' });
    const clock = { now: () => new Date() };
    const manualAdapters = createReviewedManualMeasurementImportAdapterRegistry(
      manualImportStore,
      clock,
    );
    const worker = new MeasurementRunJobWorker(
      new JobWorkerCoordinator(jobStore, clock, { next: randomUUID }, 'measurement-manual-v1'),
      new MeasurementExecutionHandler(
        measurementStore,
        rawEvidenceStore,
        manualAdapters,
        { next: randomUUID },
        clock,
        { observationMethodVersion, snapshotMethodVersion },
      ),
    );
    const policyBlockedStartResponse = await app.inject({
      method: 'POST',
      url: startUrl,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload: { ...startPayload, idempotencyKey: randomUUID() },
    });
    expect(policyBlockedStartResponse.statusCode, policyBlockedStartResponse.body).toBe(202);
    const policyBlockedStart = StartMeasurementRunEnvelopeSchema.parse(
      policyBlockedStartResponse.json(),
    ).data;
    expect(
      await worker.process({
        messageId: randomUUID(),
        payload: {
          jobId: policyBlockedStart.job.id,
          tenantId: scope.tenant.id,
          workspaceId: scope.workspace.id,
          schemaVersion: '1.0.0',
        },
      }),
    ).toMatchObject({ outcome: 'SUCCEEDED' });
    const policyBlockedRunsResponse = await app.inject({
      method: 'GET',
      url: `${startUrl}/${policyBlockedStart.measurementRun.id}/prompt-runs?limit=100`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    const policyBlockedRuns = MeasurementPromptRunListEnvelopeSchema.parse(
      policyBlockedRunsResponse.json(),
    ).data.promptRuns;
    expect(policyBlockedRuns).toHaveLength(60);
    expect(policyBlockedRuns.every((run) => run.status === 'NOT_CHECKED')).toBe(true);
    expect(
      policyBlockedRuns.every((run) => run.policyReason === 'PROVIDER_POLICY_NOT_APPROVED'),
    ).toBe(true);

    const policyUrl =
      `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
      '/measurement-provider-policies/openai/chatgpt-search';
    const missingPolicyResponse = await app.inject({
      method: 'GET',
      url: policyUrl,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(missingPolicyResponse.statusCode, missingPolicyResponse.body).toBe(200);
    expect(
      MeasurementProviderPolicyStateEnvelopeSchema.parse(missingPolicyResponse.json()).data.state,
    ).toMatchObject({
      providerKey: 'openai',
      surfaceKey: 'chatgpt-search',
      requiredAdapterVersion: 'manual-import-v1',
      requiredTermsVersion: 'manual-import-terms-v1',
      eligible: false,
      reasons: ['POLICY_MISSING'],
      policy: null,
    });
    const reviewerPolicyWrite = await app.inject({
      method: 'PUT',
      url: policyUrl,
      headers: {
        cookie: `__Host-aeo_session=${reviewerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        adapterVersion: 'manual-import-v1',
        termsVersion: 'manual-import-terms-v1',
        termsApproved: true,
        authorizationApproved: true,
        crossBorderApproved: true,
        purpose: 'reviewed manual measurement import',
        policyVersion: 'measurement-provider-policy-v1',
      },
    });
    expect(reviewerPolicyWrite.statusCode, reviewerPolicyWrite.body).toBe(403);
    const policy = await app.inject({
      method: 'PUT',
      url: policyUrl,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        adapterVersion: 'manual-import-v1',
        termsVersion: 'manual-import-terms-v1',
        termsApproved: true,
        authorizationApproved: true,
        crossBorderApproved: true,
        purpose: 'reviewed manual measurement import',
        policyVersion: 'measurement-provider-policy-v1',
      },
    });
    expect(policy.statusCode, policy.body).toBe(200);
    const approvedPolicyResponse = await app.inject({
      method: 'GET',
      url: policyUrl,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(approvedPolicyResponse.statusCode, approvedPolicyResponse.body).toBe(200);
    expect(
      MeasurementProviderPolicyStateEnvelopeSchema.parse(approvedPolicyResponse.json()).data.state,
    ).toMatchObject({
      eligible: true,
      reasons: [],
      policy: {
        adapterVersion: 'manual-import-v1',
        termsVersion: 'manual-import-terms-v1',
        termsApproved: true,
        authorizationApproved: true,
        crossBorderApproved: true,
      },
    });
    const startedResponse = await app.inject({
      method: 'POST',
      url: startUrl,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload: { ...startPayload, idempotencyKey: randomUUID() },
    });
    expect(startedResponse.statusCode, startedResponse.body).toBe(202);
    const started = StartMeasurementRunEnvelopeSchema.parse(startedResponse.json()).data;
    expect(started.measurementRun.scenarioSnapshot.manualImport).toEqual({
      id: submittedImport.id,
      contentHash: submittedImport.contentHash,
    });
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
    ).toMatchObject({ outcome: 'SUCCEEDED', measurementRunId: started.measurementRun.id });
    const importedRunsResponse = await app.inject({
      method: 'GET',
      url: `${startUrl}/${started.measurementRun.id}/prompt-runs?limit=100`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(importedRunsResponse.statusCode, importedRunsResponse.body).toBe(200);
    const importedRuns = MeasurementPromptRunListEnvelopeSchema.parse(importedRunsResponse.json())
      .data.promptRuns;
    expect(importedRuns).toHaveLength(60);
    expect(importedRuns.filter((run) => run.status === 'PASS')).toHaveLength(1);
    expect(importedRuns.filter((run) => run.status === 'NOT_CHECKED')).toHaveLength(59);
    expect(importedRuns.every((run) => run.policyReason === null)).toBe(true);
    const importedPass = importedRuns.find((run) => run.status === 'PASS');
    const importedPassEvidence = await app.inject({
      method: 'GET',
      url: `${startUrl}/${started.measurementRun.id}/prompt-runs/${importedPass?.id ?? ''}`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(importedPassEvidence.statusCode, importedPassEvidence.body).toBe(200);
    expect(PromptRunEnvelopeSchema.parse(importedPassEvidence.json()).data.rawEvidence).toEqual({
      contentHash: manualMeasurementImportHash(firstEntry.result.rawEvidence),
      ...firstEntry.result.rawEvidence,
    });
    const missingRun = importedRuns.find((run) => run.status === 'NOT_CHECKED');
    const missingEvidence = await app.inject({
      method: 'GET',
      url: `${startUrl}/${started.measurementRun.id}/prompt-runs/${missingRun?.id ?? ''}`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(
      PromptRunEnvelopeSchema.parse(missingEvidence.json()).data.rawEvidence.error,
    ).toMatchObject({ code: 'MANUAL_IMPORT_SLOT_MISSING' });
    const sealedBefore = await pool.query<{ scenario_snapshot: unknown }>(
      'SELECT scenario_snapshot FROM measurement_runs WHERE id = $1',
      [started.measurementRun.id],
    );
    const laterImport = await app.inject({
      method: 'POST',
      url: importUrl,
      headers: importHeaders,
      payload: {
        ...importPayload,
        idempotencyKey: randomUUID(),
        entries: [
          {
            ...firstEntry,
            result: {
              ...firstEntry.result,
              rawEvidence: {
                ...firstEntry.result.rawEvidence,
                responseText: 'A later capture must only be eligible for a new baseline.',
              },
            },
          },
        ],
      },
    });
    expect(laterImport.statusCode, laterImport.body).toBe(201);
    expect(
      laterImport.json<{ data: { manualImport: { id: string } } }>().data.manualImport.id,
    ).not.toBe(submittedImport.id);
    const sealedAfter = await pool.query<{ scenario_snapshot: unknown }>(
      'SELECT scenario_snapshot FROM measurement_runs WHERE id = $1',
      [started.measurementRun.id],
    );
    expect(sealedAfter.rows[0]?.scenario_snapshot).toEqual(sealedBefore.rows[0]?.scenario_snapshot);
    await expect(
      pool.query(
        `UPDATE measurement_runs
         SET scenario_snapshot = jsonb_set(scenario_snapshot, '{modelVersion}', '"tampered"')
         WHERE id = $1`,
        [started.measurementRun.id],
      ),
    ).rejects.toThrow(/MEASUREMENT_RUN_IMMUTABLE_FIELDS/u);
    const siblingWorkspaceId = randomUUID();
    await pool.query(
      `INSERT INTO workspaces (id, tenant_id, name)
       VALUES ($1, $2, 'Manual import sibling workspace')`,
      [siblingWorkspaceId, scope.tenant.id],
    );
    await expect(
      pool.query(
        `INSERT INTO measurement_manual_imports
          (id, tenant_id, workspace_id, schema_version, prompt_set_id, prompt_revision_id,
            prompt_content_hash, scenario_id, scenario_content_hash, provider_key, surface_key,
            adapter_version, acquisition_class, acquisition_method, status, content_hash,
            expected_slot_count, provided_slot_count, cost_currency, idempotency_key,
            submitted_by_user_id, submitted_at)
         SELECT $2, tenant_id, $3, schema_version, prompt_set_id, prompt_revision_id,
           prompt_content_hash, scenario_id, scenario_content_hash, provider_key, surface_key,
           adapter_version, acquisition_class, acquisition_method, 'SUBMITTED', content_hash,
           expected_slot_count, provided_slot_count, cost_currency, $4,
           submitted_by_user_id, submitted_at
         FROM measurement_manual_imports WHERE id = $1`,
        [submittedImport.id, randomUUID(), siblingWorkspaceId, randomUUID()],
      ),
    ).rejects.toThrow(/foreign key constraint/u);
    await expect(
      pool.query(
        `INSERT INTO measurement_manual_import_slots
          (tenant_id, workspace_id, manual_import_id, prompt_id, scope, scope_key, repetition,
            provided, observed_at, result, raw_evidence_content_hash, content_hash)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, 1, false, NULL, NULL, NULL, $7)`,
        [
          scope.tenant.id,
          siblingWorkspaceId,
          submittedImport.id,
          randomUUID(),
          JSON.stringify({ market: 'SG', locale: 'en-SG', region: 'Singapore' }),
          'cross-workspace-slot',
          'f'.repeat(64),
        ],
      ),
    ).rejects.toThrow(/foreign key constraint/u);
    await expect(
      pool.query(
        `INSERT INTO measurement_runs
          (id, tenant_id, workspace_id, prompt_set_id, prompt_revision_id,
            prompt_content_hash, scenario_id, scenario_version, scenario_content_hash,
            manual_import_id, manual_import_content_hash, job_id, kind, status,
            expected_prompt_run_count, completed_prompt_run_count, provider_key, surface_key,
            model, model_version, acquisition_class, acquisition_method, adapter_version,
            scenario_snapshot, prompt_snapshot, idempotency_key, requested_by_user_id, created_at,
            started_at, completed_at)
         SELECT $2, tenant_id, $3, prompt_set_id, prompt_revision_id,
           prompt_content_hash, scenario_id, scenario_version, scenario_content_hash,
           manual_import_id, manual_import_content_hash, NULL, kind, 'QUEUED',
           expected_prompt_run_count, 0, provider_key, surface_key, model, model_version,
           acquisition_class, acquisition_method, adapter_version, scenario_snapshot,
           prompt_snapshot, $4, requested_by_user_id, created_at, NULL, NULL
         FROM measurement_runs WHERE id = $1`,
        [started.measurementRun.id, randomUUID(), siblingWorkspaceId, randomUUID()],
      ),
    ).rejects.toThrow(/foreign key constraint/u);
    const ownImport = await app.inject({
      method: 'GET',
      url: `${importUrl}/${submittedImport.id}`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(ownImport.statusCode, ownImport.body).toBe(200);
    const ownerBSession = await signIn(app, 'measurement-owner-b-code');
    const scopeB = await createScope(app, ownerBSession, 'Reviewed Manual Import B');
    const crossTenantImport = await app.inject({
      method: 'GET',
      url:
        `/api/v1/tenants/${scopeB.tenant.id}/workspaces/${scopeB.workspace.id}` +
        `/measurement-manual-imports/${submittedImport.id}`,
      headers: { cookie: `__Host-aeo_session=${ownerBSession}` },
    });
    expect(crossTenantImport.statusCode, crossTenantImport.body).toBe(404);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE aeostudio_runtime');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scopeB.tenant.id]);
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scopeB.workspace.id]);
      const hiddenImports = await client.query<{ count: string }>(
        'SELECT count(*) FROM measurement_manual_imports WHERE id = $1',
        [submittedImport.id],
      );
      const hiddenSlots = await client.query<{ count: string }>(
        'SELECT count(*) FROM measurement_manual_import_slots WHERE manual_import_id = $1',
        [submittedImport.id],
      );
      expect(hiddenImports.rows[0]?.count).toBe('0');
      expect(hiddenSlots.rows[0]?.count).toBe('0');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }, 120_000);
});
