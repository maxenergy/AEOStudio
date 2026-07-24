import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type {
  AuthorizationRequest,
  ExchangeCodeInput,
  OidcClient,
} from '@aeostudio/application/auth';
import {
  ExperimentEnvelopeSchema,
  ExperimentOptionsEnvelopeSchema,
  IncompatibleExperimentSchema,
  type CreateExperimentRequest,
} from '@aeostudio/contracts/experiments';
import {
  buildMetricSnapshot,
  type MetricClassification,
  type MetricCohort,
} from '@aeostudio/domain/measurement';
import {
  AesGcmSessionCipher,
  PostgresAuthStore,
  PostgresExperimentStore,
  PostgresTenancyStore,
  runMigrations,
} from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createApiApp } from '../../apps/api/src/app.js';
import {
  FAKE_ARTIFACT_LINEAGE,
  FAKE_ARTIFACT_PROMPT_IDS,
} from '../../apps/api/src/artifacts/fake-artifact-lineage-fixture.js';
import { seedTask10ApprovedArtifactSource } from './fixtures/task-10-approved-artifact-source.js';

type ApiTestApp = Awaited<ReturnType<typeof createApiApp>>;
type ScopeIds = { tenant: { id: string }; workspace: { id: string } };

const identities = {
  'experiment-owner-code': {
    subject: 'experiment-owner-subject',
    email: 'experiment-owner@example.test',
  },
  'experiment-analyst-code': {
    subject: 'experiment-analyst-subject',
    email: 'experiment-analyst@example.test',
  },
  'experiment-viewer-code': {
    subject: 'experiment-viewer-subject',
    email: 'experiment-viewer@example.test',
  },
  'experiment-other-owner-code': {
    subject: 'experiment-other-owner-subject',
    email: 'experiment-other-owner@example.test',
  },
} as const;

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
    const identity = identities[input.code as keyof typeof identities];
    if (identity === undefined) throw new Error('EXPERIMENT_IDENTITY_FIXTURE_MISSING');
    return Promise.resolve({ ...identity, emailVerified: true });
  },
};

async function signIn(app: ApiTestApp, code: keyof typeof identities): Promise<string> {
  const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
  const loginToken = login.cookies.find((cookie) => cookie.name === '__Host-aeo_login')?.value;
  const state = new URL(login.headers.location ?? '').searchParams.get('state');
  const callback = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/callback?code=${code}&state=${state ?? ''}`,
    headers: { cookie: `__Host-aeo_login=${loginToken ?? ''}` },
  });
  const session = callback.cookies.find((cookie) => cookie.name === '__Host-aeo_session')?.value;
  if (session === undefined) throw new Error('EXPERIMENT_TEST_LOGIN_FAILED');
  return session;
}

async function createScope(app: ApiTestApp, session: string, label: string): Promise<ScopeIds> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: {
      cookie: `__Host-aeo_session=${session}`,
      origin: 'https://app.example.test',
    },
    payload: { tenantName: `${label} Tenant`, workspaceName: `${label} Workspace` },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ data: ScopeIds }>().data;
}

async function inviteAndAccept(input: {
  app: ApiTestApp;
  ownerSession: string;
  scope: ScopeIds;
  role: 'ANALYST' | 'VIEWER';
  email: string;
  code: keyof typeof identities;
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

const METRIC_KEYS = ['MENTION_RATE', 'CITATION_RATE', 'ACCURACY_RATE', 'COVERAGE_RATE'] as const;
type MetricKey = (typeof METRIC_KEYS)[number];

interface ExperimentFixture {
  ownerUserId: string;
  analystUserId: string;
  artifactId: string;
  artifactRevisionId: string;
  artifactReviewId: string;
  artifactContentHash: string;
  publicationRecordId: string;
  publicationAttemptId: string;
  laterPublicationAttemptId: string;
  unpublishedRecordId: string;
  unpublishedAttemptId: string;
  channelPackageId: string;
  packageChecksum: string;
  baselineRunId: string;
  remeasurementRunId: string;
  incompatibleRunId: string;
  methodMismatchRunId: string;
  runWindowRunId: string;
  staleEvidenceRunId: string;
  baselineSnapshotIds: Record<MetricKey, string>;
  remeasurementSnapshotIds: Record<MetricKey, string>;
}

const SCOPE_KEY = 'market=SG|locale=en-SG|region=Singapore';
const SNAPSHOT_METHOD = 'ai-visibility-snapshot-v1';
const BASELINE_STARTED_AT = new Date('2026-07-21T06:00:00.000Z');
const BASELINE_COMPLETED_AT = new Date('2026-07-21T06:10:00.000Z');
const APPROVED_AT = new Date('2026-07-21T06:15:00.000Z');
const PUBLISHED_AT = new Date('2026-07-21T06:20:00.000Z');
const REMEASUREMENT_STARTED_AT = new Date('2026-07-21T06:30:00.000Z');
const REMEASUREMENT_COMPLETED_AT = new Date('2026-07-21T06:40:00.000Z');

function classifications(numerator: number, eligibleDenominator: number): MetricClassification[] {
  return [
    ...Array.from({ length: numerator }, () => 'PASS' as const),
    ...Array.from({ length: eligibleDenominator - numerator }, () => 'FAIL' as const),
    'ERROR',
    'NOT_CHECKED',
    'INCONCLUSIVE',
    'NOT_APPLICABLE',
  ];
}

function metricCohort(modelVersion = 'fixture-v1'): MetricCohort {
  return {
    scenarioId: FAKE_ARTIFACT_LINEAGE.promptScenarioId,
    scenarioVersion: 1,
    providerKey: 'fixture-provider',
    surfaceKey: 'consumer-answer-sandbox',
    acquisitionClass: 'MANUAL_IMPORT',
    acquisitionMethod: 'MANUAL_IMPORT',
    adapterKey: 'fixture-manual-import',
    adapterVersion: 'manual-import-v1',
    model: 'fixture-model',
    modelVersion,
    scope: { market: 'SG', locale: 'en-SG', region: 'Singapore' },
    parameters: {
      freshSession: true,
      searchEnabled: true,
      nested: {
        phase: 'remeasurement',
        numberMatrix: [
          1,
          Number('1.0'),
          1.25,
          1e-7,
          1e21,
          Number.MAX_VALUE,
          Number.MIN_VALUE,
          -0,
          Number('31722300588172750'),
        ],
        unicode: { ΩKey: 'BMP value', '😀Key': 'non-BMP value' },
      },
    },
  };
}

async function seedExperimentData(input: {
  pool: Pool;
  scope: ScopeIds;
  ownerUserId: string;
  analystUserId: string;
}): Promise<ExperimentFixture> {
  const artifactId = randomUUID();
  const artifactRevisionId = randomUUID();
  const artifactReviewId = randomUUID();
  const artifactContentHash = '2'.repeat(64);
  const adapterVersionId = randomUUID();
  const channelPackageId = randomUUID();
  const packageChecksum = '3'.repeat(64);
  const authorizationId = randomUUID();
  const publicationRecordId = randomUUID();
  const publicationAttemptId = randomUUID();
  const laterPublicationAttemptId = randomUUID();
  const unpublishedRecordId = randomUUID();
  const unpublishedAttemptId = randomUUID();
  const baselineRunId = randomUUID();
  const remeasurementRunId = randomUUID();
  const incompatibleRunId = randomUUID();
  const methodMismatchRunId = randomUUID();
  const runWindowRunId = randomUUID();
  const staleEvidenceRunId = randomUUID();
  const client = await input.pool.connect();
  const baselineSnapshotIds = {} as Record<MetricKey, string>;
  const remeasurementSnapshotIds = {} as Record<MetricKey, string>;
  const promptSnapshot = FAKE_ARTIFACT_PROMPT_IDS.map((id, index) => ({
    id,
    text: `Task 16 immutable prompt ${index + 1}`,
  }));

  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.scope.tenant.id]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [
      input.scope.workspace.id,
    ]);
    await client.query("SELECT set_config('app.actor_id', $1, true)", [input.ownerUserId]);

    await client.query(
      `INSERT INTO artifacts
        (id, tenant_id, workspace_id, brief_id, artifact_type, current_revision, status,
          locale, market, method_policy_version, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, 'DEFINITION_PRODUCT', 1, 'IN_REVIEW', 'en-SG', 'SG',
         'task16-fixture-v1', $5, $6)`,
      [
        artifactId,
        input.scope.tenant.id,
        input.scope.workspace.id,
        FAKE_ARTIFACT_LINEAGE.briefId,
        input.ownerUserId,
        new Date('2026-07-21T06:12:00.000Z'),
      ],
    );
    await client.query(
      `INSERT INTO artifact_revisions
        (id, tenant_id, workspace_id, artifact_id, revision, brief_id, artifact_type,
          schema_version, content_hash, status, locale, market, source_artifact_ids,
          lineage, claim_bindings, method_policy_version, created_by_actor_kind,
          created_by_actor_id, created_at, payload_object_ref)
       VALUES ($1, $2, $3, $4, 1, $5, 'DEFINITION_PRODUCT', '1.0.0', $6, 'IN_REVIEW',
         'en-SG', 'SG', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 'task16-fixture-v1',
         'AGENT', $7, $8, 'memory://task16-artifact')`,
      [
        artifactRevisionId,
        input.scope.tenant.id,
        input.scope.workspace.id,
        artifactId,
        FAKE_ARTIFACT_LINEAGE.briefId,
        artifactContentHash,
        randomUUID(),
        new Date('2026-07-21T06:13:00.000Z'),
      ],
    );
    await client.query(
      `INSERT INTO artifact_reviews
        (id, tenant_id, workspace_id, artifact_id, artifact_revision_id, revision,
          content_hash, decision, reviewer_user_id, note, created_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, 'APPROVE', $7,
         'Exact Task 16 intervention approved.', $8)`,
      [
        artifactReviewId,
        input.scope.tenant.id,
        input.scope.workspace.id,
        artifactId,
        artifactRevisionId,
        artifactContentHash,
        input.ownerUserId,
        APPROVED_AT,
      ],
    );
    await client.query(`UPDATE artifact_revisions SET status = 'APPROVED' WHERE id = $1`, [
      artifactRevisionId,
    ]);
    await client.query(`UPDATE artifacts SET status = 'APPROVED' WHERE id = $1`, [artifactId]);

    await client.query(
      `INSERT INTO adapter_versions
        (id, channel_definition_id, adapter_key, adapter_version, enabled, capabilities,
          required_scopes, terms_version, terms_status, processing_region, retention_policy,
          training_policy, subprocessors, rate_policy, created_at)
       VALUES ($1, '00000000-0000-7000-8000-000000001000', 'task16-fixture', '1.0.0',
         true, ARRAY['PUBLISH'], ARRAY['content:write'], 'task16-terms-v1', 'ALLOWED',
         'ap-southeast-1', 'No fixture retention.', 'No fixture training.', '[]'::jsonb,
         '{"mode":"fixture"}'::jsonb, $2)`,
      [adapterVersionId, APPROVED_AT],
    );
    await client.query(
      `INSERT INTO channel_packages
        (id, tenant_id, workspace_id, package_revision, channel_definition_id, channel_key,
          transformer_key, transformer_version, package_schema_version, artifact_id,
          artifact_revision_id, artifact_revision, artifact_content_hash, artifact_type,
          artifact_locale, artifact_market, artifact_method_policy_version, manifest,
          package_checksum, payload_object_ref, created_by_user_id, created_at)
       VALUES ($1, $2, $3, 1, '00000000-0000-7000-8000-000000001000',
         'portable-web-export', 'generic-web-package', '1.0.0', '1.0.0', $4, $5, 1, $6,
         'DEFINITION_PRODUCT', 'en-SG', 'SG', 'task16-fixture-v1', '{}'::jsonb, $7,
         'memory://task16-package', $8, $9)`,
      [
        channelPackageId,
        input.scope.tenant.id,
        input.scope.workspace.id,
        artifactId,
        artifactRevisionId,
        artifactContentHash,
        packageChecksum,
        input.ownerUserId,
        new Date('2026-07-21T06:17:00.000Z'),
      ],
    );
    await client.query(
      `INSERT INTO channel_authorizations
        (id, tenant_id, workspace_id, adapter_version_id, status, secret_arn, granted_scopes,
          accepted_terms_version, target, created_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE',
         'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:task16/publish',
         ARRAY['content:write'], 'task16-terms-v1', 'https://publish.example.test', $5, $6, $6)`,
      [
        authorizationId,
        input.scope.tenant.id,
        input.scope.workspace.id,
        adapterVersionId,
        input.ownerUserId,
        new Date('2026-07-21T06:18:00.000Z'),
      ],
    );

    for (const publication of [
      {
        id: publicationRecordId,
        jobId: randomUUID(),
        status: 'PUBLISHED',
        progress: 100,
        jobStatus: 'SUCCEEDED',
        remoteRef: 'https://publish.example.test/task16-live',
        updatedAt: new Date('2026-07-21T08:00:00.000Z'),
      },
      {
        id: unpublishedRecordId,
        jobId: randomUUID(),
        status: 'ROLLBACK_QUEUED',
        progress: 100,
        jobStatus: 'SUCCEEDED',
        remoteRef: 'https://publish.example.test/task16-not-published',
        updatedAt: new Date('2026-07-21T08:00:00.000Z'),
      },
    ] as const) {
      await client.query(
        `INSERT INTO jobs
          (id, tenant_id, workspace_id, job_type, aggregate_id, status, progress,
            idempotency_key, estimated_units, requested_by_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'PUBLICATION', $4, $5, $6, $7, 1, $8, $9, $9)`,
        [
          publication.jobId,
          input.scope.tenant.id,
          input.scope.workspace.id,
          publication.id,
          publication.jobStatus,
          publication.progress,
          `task16-job-${publication.id}`,
          input.ownerUserId,
          new Date('2026-07-21T06:18:00.000Z'),
        ],
      );
      await client.query(
        `INSERT INTO publication_records
          (id, tenant_id, workspace_id, channel_package_id, package_checksum,
            artifact_revision_id, artifact_content_hash, adapter_version_id,
            channel_authorization_id, authorization_target, target, idempotency_key,
            request_hash, status, job_id, remote_ref, requested_by_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
           'https://publish.example.test', 'https://publish.example.test', $10, $11, $12,
           $13, $14, $15, $16, $17)`,
        [
          publication.id,
          input.scope.tenant.id,
          input.scope.workspace.id,
          channelPackageId,
          packageChecksum,
          artifactRevisionId,
          artifactContentHash,
          adapterVersionId,
          authorizationId,
          `task16-publication-${publication.id}`,
          publication.id === publicationRecordId ? '4'.repeat(64) : '5'.repeat(64),
          publication.status,
          publication.jobId,
          publication.remoteRef,
          input.ownerUserId,
          new Date('2026-07-21T06:18:00.000Z'),
          publication.updatedAt,
        ],
      );
    }
    await client.query(
      `INSERT INTO publication_attempts
        (id, tenant_id, workspace_id, publication_id, attempt_number, operation, outcome,
          remote_ref, started_at, finished_at)
       VALUES ($1, $2, $3, $4, 1, 'PUBLISH', 'APPLIED',
         'https://publish.example.test/task16-live', $5, $6)`,
      [
        publicationAttemptId,
        input.scope.tenant.id,
        input.scope.workspace.id,
        publicationRecordId,
        new Date('2026-07-21T06:19:00.000Z'),
        PUBLISHED_AT,
      ],
    );
    await client.query(
      `INSERT INTO publication_attempts
        (id, tenant_id, workspace_id, publication_id, attempt_number, operation, outcome,
          remote_ref, started_at, finished_at)
       VALUES ($1, $2, $3, $4, 2, 'RECONCILE', 'APPLIED',
         'https://publish.example.test/task16-live', $5, $6)`,
      [
        laterPublicationAttemptId,
        input.scope.tenant.id,
        input.scope.workspace.id,
        publicationRecordId,
        new Date('2026-07-21T06:24:00.000Z'),
        new Date('2026-07-21T06:25:00.000Z'),
      ],
    );
    await client.query(
      `INSERT INTO publication_attempts
        (id, tenant_id, workspace_id, publication_id, attempt_number, operation, outcome,
          remote_ref, started_at, finished_at)
       VALUES ($1, $2, $3, $4, 1, 'PUBLISH', 'APPLIED',
         'https://publish.example.test/task16-not-published', $5, $6)`,
      [
        unpublishedAttemptId,
        input.scope.tenant.id,
        input.scope.workspace.id,
        unpublishedRecordId,
        new Date('2026-07-21T06:19:00.000Z'),
        PUBLISHED_AT,
      ],
    );

    const insertRun = async (run: {
      id: string;
      kind: 'BASELINE' | 'REMEASUREMENT';
      modelVersion: string;
      startedAt: Date;
      completedAt: Date;
    }) => {
      await client.query(
        `INSERT INTO measurement_runs
          (id, tenant_id, workspace_id, prompt_set_id, prompt_revision_id,
            prompt_content_hash, scenario_id, scenario_version, scenario_content_hash,
            kind, status, expected_prompt_run_count, completed_prompt_run_count, provider_key,
            surface_key, model, model_version, acquisition_class, acquisition_method,
            adapter_version, scenario_snapshot, prompt_snapshot, idempotency_key,
            requested_by_user_id, created_at, started_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, 'COMPLETED', 8, 8,
           'fixture-provider', 'consumer-answer-sandbox', 'fixture-model', $10,
           'MANUAL_IMPORT', 'MANUAL_IMPORT', 'manual-import-v1', $11::jsonb, $12::jsonb,
           $13, $14, $15, $15, $16)`,
        [
          run.id,
          input.scope.tenant.id,
          input.scope.workspace.id,
          FAKE_ARTIFACT_LINEAGE.promptSetId,
          FAKE_ARTIFACT_LINEAGE.promptRevisionId,
          FAKE_ARTIFACT_LINEAGE.promptHash,
          FAKE_ARTIFACT_LINEAGE.promptScenarioId,
          '1'.repeat(64),
          run.kind,
          run.modelVersion,
          JSON.stringify({ fixture: 'task16', modelVersion: run.modelVersion }),
          JSON.stringify(promptSnapshot),
          `task16-run-${run.id}`,
          input.analystUserId,
          run.startedAt,
          run.completedAt,
        ],
      );
    };
    await insertRun({
      id: baselineRunId,
      kind: 'BASELINE',
      modelVersion: 'fixture-v1',
      startedAt: BASELINE_STARTED_AT,
      completedAt: BASELINE_COMPLETED_AT,
    });
    for (const run of [
      { id: remeasurementRunId, modelVersion: 'fixture-v1' },
      { id: incompatibleRunId, modelVersion: 'fixture-v1' },
      { id: methodMismatchRunId, modelVersion: 'fixture-v1' },
      { id: staleEvidenceRunId, modelVersion: 'fixture-v1' },
    ]) {
      await insertRun({
        ...run,
        kind: 'REMEASUREMENT',
        startedAt: REMEASUREMENT_STARTED_AT,
        completedAt: REMEASUREMENT_COMPLETED_AT,
      });
    }
    await insertRun({
      id: runWindowRunId,
      kind: 'REMEASUREMENT',
      modelVersion: 'fixture-v1',
      startedAt: new Date('2026-07-21T06:18:00.000Z'),
      completedAt: REMEASUREMENT_COMPLETED_AT,
    });

    const statuses: MetricClassification[] = [
      'PASS',
      'FAIL',
      'ERROR',
      'NOT_CHECKED',
      'INCONCLUSIVE',
      'NOT_APPLICABLE',
      'PASS',
      'FAIL',
    ];
    const insertPromptRuns = async (runId: string, firstObservedAt: Date, cost: string) => {
      for (const [index, status] of statuses.entries()) {
        const promptId = FAKE_ARTIFACT_PROMPT_IDS[index];
        if (promptId === undefined) throw new Error('TASK16_PROMPT_ID_MISSING');
        await client.query(
          `INSERT INTO prompt_runs
            (id, tenant_id, workspace_id, measurement_run_id, prompt_id, prompt_ordinal,
              repetition, scope_key, status, provider_key, surface_key, model, model_version,
              scenario_id, scenario_version, acquisition_class, acquisition_method, adapter_key,
              adapter_version, method_version, observation, cost_amount, cost_currency,
              policy_reason, observed_at)
           VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, 'fixture-provider',
             'consumer-answer-sandbox', 'fixture-model', 'fixture-v1', $9, 1,
             'MANUAL_IMPORT', 'MANUAL_IMPORT', 'fixture-manual-import', 'manual-import-v1',
             'answer-observation-v1', $10::jsonb, $11::numeric, 'USD', $12, $13)`,
          [
            randomUUID(),
            input.scope.tenant.id,
            input.scope.workspace.id,
            runId,
            promptId,
            index + 1,
            SCOPE_KEY,
            status,
            FAKE_ARTIFACT_LINEAGE.promptScenarioId,
            JSON.stringify({ fixture: true, status }),
            cost,
            ['PASS', 'FAIL'].includes(status) ? null : `EXCLUDED_${status}`,
            new Date(firstObservedAt.getTime() + index * 60_000),
          ],
        );
      }
    };
    await insertPromptRuns(baselineRunId, new Date('2026-07-21T06:01:00.000Z'), '0.010000');
    await insertPromptRuns(remeasurementRunId, new Date('2026-07-21T06:31:00.000Z'), '0.020000');
    await insertPromptRuns(incompatibleRunId, new Date('2026-07-21T06:31:00.000Z'), '0.000000');
    await insertPromptRuns(methodMismatchRunId, new Date('2026-07-21T06:31:00.000Z'), '0.000000');
    await insertPromptRuns(runWindowRunId, new Date('2026-07-21T06:31:00.000Z'), '0.000000');
    await insertPromptRuns(staleEvidenceRunId, new Date('2026-07-21T06:11:00.000Z'), '0.000000');

    const metricCounts: Record<MetricKey, [[number, number], [number, number]]> = {
      MENTION_RATE: [
        [2, 4],
        [3, 4],
      ],
      CITATION_RATE: [
        [2, 10],
        [7, 10],
      ],
      ACCURACY_RATE: [
        [1, 8192],
        [2, 8192],
      ],
      COVERAGE_RATE: [
        [2, 6],
        [1, 6],
      ],
    };
    const insertSnapshots = async (
      runId: string,
      modelVersion: string,
      side: 0 | 1,
      captureIds?: Record<MetricKey, string>,
      methodVersion = SNAPSHOT_METHOD,
    ) => {
      for (const metricKey of METRIC_KEYS) {
        const [numerator, eligibleDenominator] = metricCounts[metricKey][side];
        const snapshot = buildMetricSnapshot({
          metricKey,
          methodVersion,
          observations: classifications(numerator, eligibleDenominator).map((classification) => ({
            id: randomUUID(),
            promptRunId: randomUUID(),
            metricKey,
            classification,
            cohort: metricCohort(modelVersion),
          })),
        });
        const snapshotId = randomUUID();
        if (captureIds !== undefined) captureIds[metricKey] = snapshotId;
        await client.query(
          `INSERT INTO metric_snapshots
            (id, tenant_id, workspace_id, measurement_run_id, schema_version, metric_key,
              scope_key, method_version, cohort, numerator, eligible_denominator, value,
              excluded_counts, source_observation_ids, source_hash, content_hash, created_at)
           VALUES ($1, $2, $3, $4, 'metric-snapshot.v1', $5, $6, $7, $8::jsonb,
             $9, $10, $11, $12::jsonb, $13::uuid[], $14, $15, $16)`,
          [
            snapshotId,
            input.scope.tenant.id,
            input.scope.workspace.id,
            runId,
            metricKey,
            SCOPE_KEY,
            snapshot.methodVersion,
            JSON.stringify(snapshot.cohort),
            snapshot.numerator,
            snapshot.eligibleDenominator,
            snapshot.value,
            JSON.stringify(snapshot.excludedCounts),
            snapshot.sourceObservationIds,
            snapshot.sourceHash,
            snapshot.contentHash,
            REMEASUREMENT_COMPLETED_AT,
          ],
        );
      }
    };
    await insertSnapshots(baselineRunId, 'fixture-v1', 0, baselineSnapshotIds);
    await insertSnapshots(remeasurementRunId, 'fixture-v1', 1, remeasurementSnapshotIds);
    await insertSnapshots(incompatibleRunId, 'fixture-v2', 1);
    await insertSnapshots(methodMismatchRunId, 'fixture-v1', 1, undefined, 'snapshot-method-v2');
    await insertSnapshots(runWindowRunId, 'fixture-v1', 1);
    await insertSnapshots(staleEvidenceRunId, 'fixture-v1', 1);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    ownerUserId: input.ownerUserId,
    analystUserId: input.analystUserId,
    artifactId,
    artifactRevisionId,
    artifactReviewId,
    artifactContentHash,
    publicationRecordId,
    publicationAttemptId,
    laterPublicationAttemptId,
    unpublishedRecordId,
    unpublishedAttemptId,
    channelPackageId,
    packageChecksum,
    baselineRunId,
    remeasurementRunId,
    incompatibleRunId,
    methodMismatchRunId,
    runWindowRunId,
    staleEvidenceRunId,
    baselineSnapshotIds,
    remeasurementSnapshotIds,
  };
}

async function beginRuntime(client: PoolClient, scope: ScopeIds, actorUserId: string) {
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE aeostudio_runtime');
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenant.id]);
  await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspace.id]);
  await client.query("SELECT set_config('app.actor_id', $1, true)", [actorUserId]);
}

async function insertBuildingCopy(input: {
  client: PoolClient;
  sourceExperimentId: string;
  targetExperimentId: string;
  idempotencyKey: string;
  remeasurementRunId?: string;
}) {
  await input.client.query(
    `INSERT INTO experiments
      (id, tenant_id, workspace_id, schema_version, status, baseline_run_id,
        remeasurement_run_id, scenario_version, intervention_kind, publication_record_id,
        publication_attempt_id, channel_package_id, package_checksum, artifact_id,
        artifact_review_id, artifact_revision_id, artifact_revision, artifact_content_hash,
        intervention_observed_at, compatibility_hash, report, idempotency_key, request_hash,
        created_by_user_id, created_at, sealed_at)
     SELECT $1, tenant_id, workspace_id, schema_version, 'BUILDING', baseline_run_id,
       COALESCE($4::uuid, remeasurement_run_id), scenario_version, intervention_kind, publication_record_id,
       publication_attempt_id, channel_package_id, package_checksum, artifact_id,
       artifact_review_id, artifact_revision_id, artifact_revision, artifact_content_hash,
       intervention_observed_at, NULL, NULL, $2, request_hash, created_by_user_id, created_at, NULL
     FROM experiments WHERE id = $3`,
    [
      input.targetExperimentId,
      input.idempotencyKey,
      input.sourceExperimentId,
      input.remeasurementRunId ?? null,
    ],
  );
}

async function insertSnapshotLinkCopies(input: {
  client: PoolClient;
  sourceExperimentId: string;
  targetExperimentId: string;
}) {
  await input.client.query(
    `INSERT INTO experiment_snapshot_links
      (tenant_id, workspace_id, experiment_id, ordinal, metric_key, scope_key,
        baseline_snapshot_id, baseline_content_hash, remeasurement_snapshot_id,
        remeasurement_content_hash, compatibility_key, compatibility_hash)
     SELECT tenant_id, workspace_id, $1, ordinal, metric_key, scope_key,
       baseline_snapshot_id, baseline_content_hash, remeasurement_snapshot_id,
       remeasurement_content_hash, compatibility_key, compatibility_hash
     FROM experiment_snapshot_links WHERE experiment_id = $2`,
    [input.targetExperimentId, input.sourceExperimentId],
  );
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`TASK16_${label}_OBJECT_MISSING`);
  }
  return value as Record<string, unknown>;
}

function firstComparison(report: Record<string, unknown>): Record<string, unknown> {
  const comparisons = report.comparisons;
  if (!Array.isArray(comparisons) || comparisons.length === 0) {
    throw new Error('TASK16_COMPARISON_FIXTURE_MISSING');
  }
  return jsonRecord(comparisons[0], 'COMPARISON');
}

async function expectP0001(operation: Promise<unknown>, message: string): Promise<void> {
  return expectDatabaseGuard(operation, 'P0001', message);
}

async function expectDatabaseGuard(
  operation: Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  try {
    await operation;
    throw new Error('EXPECTED_DATABASE_GUARD_REJECTION');
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    expect(error).toMatchObject({ code });
    expect(error.message).toContain(message);
  }
}

function publishedIntervention(
  fixture: ExperimentFixture,
): Extract<CreateExperimentRequest['intervention'], { kind: 'PUBLISHED_PUBLICATION' }> {
  return {
    kind: 'PUBLISHED_PUBLICATION',
    publicationRecordId: fixture.publicationRecordId,
    publicationAttemptId: fixture.publicationAttemptId,
    channelPackageId: fixture.channelPackageId,
    artifactId: fixture.artifactId,
    artifactReviewId: fixture.artifactReviewId,
    artifactRevisionId: fixture.artifactRevisionId,
    artifactContentHash: fixture.artifactContentHash,
    observedAt: PUBLISHED_AT.toISOString(),
  };
}

function approvedIntervention(
  fixture: ExperimentFixture,
): Extract<CreateExperimentRequest['intervention'], { kind: 'APPROVED_ARTIFACT' }> {
  return {
    kind: 'APPROVED_ARTIFACT',
    artifactId: fixture.artifactId,
    artifactReviewId: fixture.artifactReviewId,
    artifactRevisionId: fixture.artifactRevisionId,
    artifactContentHash: fixture.artifactContentHash,
    observedAt: APPROVED_AT.toISOString(),
  };
}

describe('Task 16 immutable Experiment comparison', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: ApiTestApp;
  let scope: ScopeIds;
  let otherScope: ScopeIds;
  let siblingWorkspaceId: string;
  let ownerSession: string;
  let analystSession: string;
  let viewerSession: string;
  let otherOwnerSession: string;
  let fixture: ExperimentFixture;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(
      pool,
      fileURLToPath(new URL('../../packages/db/migrations', import.meta.url)),
    );
    app = await createApiApp({
      oidcClient,
      store: new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 16))),
      experimentStore: new PostgresExperimentStore(pool),
      tenancyStore: new PostgresTenancyStore(pool),
      webOrigin: 'https://app.example.test',
    });
    ownerSession = await signIn(app, 'experiment-owner-code');
    scope = await createScope(app, ownerSession, 'Experiment');
    await seedTask10ApprovedArtifactSource(pool, scope);
    const owner = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM memberships WHERE tenant_id = $1 AND status = 'ACTIVE'`,
      [scope.tenant.id],
    );
    const ownerUserId = owner.rows[0]?.user_id;
    if (ownerUserId === undefined) throw new Error('EXPERIMENT_OWNER_FIXTURE_MISSING');
    analystSession = await inviteAndAccept({
      app,
      ownerSession,
      scope,
      role: 'ANALYST',
      email: identities['experiment-analyst-code'].email,
      code: 'experiment-analyst-code',
    });
    viewerSession = await inviteAndAccept({
      app,
      ownerSession,
      scope,
      role: 'VIEWER',
      email: identities['experiment-viewer-code'].email,
      code: 'experiment-viewer-code',
    });
    const analyst = await pool.query<{ user_id: string; membership_id: string }>(
      `SELECT user_id, id AS membership_id FROM memberships
       WHERE tenant_id = $1 AND invited_email = $2 AND status = 'ACTIVE'`,
      [scope.tenant.id, identities['experiment-analyst-code'].email],
    );
    const analystIdentity = analyst.rows[0];
    if (analystIdentity === undefined) throw new Error('EXPERIMENT_ANALYST_FIXTURE_MISSING');
    fixture = await seedExperimentData({
      pool,
      scope,
      ownerUserId,
      analystUserId: analystIdentity.user_id,
    });

    siblingWorkspaceId = randomUUID();
    await pool.query(
      `INSERT INTO workspaces (id, tenant_id, name) VALUES ($1, $2, 'Sibling Workspace')`,
      [siblingWorkspaceId, scope.tenant.id],
    );
    await pool.query(
      `INSERT INTO role_bindings (id, tenant_id, workspace_id, membership_id, role)
       VALUES ($1, $2, $3, $4, 'ANALYST')`,
      [randomUUID(), scope.tenant.id, siblingWorkspaceId, analystIdentity.membership_id],
    );
    otherOwnerSession = await signIn(app, 'experiment-other-owner-code');
    otherScope = await createScope(app, otherOwnerSession, 'Other Experiment');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  test('a real Analyst creates and reads an exact published Experiment with four immutable metric pairs', async () => {
    const optionsResponse = await app.inject({
      method: 'GET',
      url:
        `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
        '/experiments/options',
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(optionsResponse.statusCode, optionsResponse.body).toBe(200);
    const options = ExperimentOptionsEnvelopeSchema.parse(optionsResponse.json()).data.options;
    expect(
      options.compatibleCombinations
        .map((combination) => `${combination.remeasurementRunId}:${combination.intervention.kind}`)
        .sort(),
    ).toEqual(
      [
        `${fixture.remeasurementRunId}:APPROVED_ARTIFACT`,
        `${fixture.remeasurementRunId}:PUBLISHED_PUBLICATION`,
        `${fixture.runWindowRunId}:APPROVED_ARTIFACT`,
      ].sort(),
    );
    expect(
      options.compatibleCombinations.map(
        (combination) => combination.intervention.artifactReviewId,
      ),
    ).toEqual([fixture.artifactReviewId, fixture.artifactReviewId, fixture.artifactReviewId]);
    const publishedCombination = options.compatibleCombinations.find(
      (combination) => combination.intervention.kind === 'PUBLISHED_PUBLICATION',
    );
    if (publishedCombination === undefined) throw new Error('TASK16_PUBLISHED_OPTION_MISSING');

    const idempotencyKey = randomUUID();
    const payload: CreateExperimentRequest = {
      baselineRunId: publishedCombination.baselineRunId,
      remeasurementRunId: publishedCombination.remeasurementRunId,
      intervention: publishedCombination.intervention,
      idempotencyKey,
    };
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/experiments`,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload,
    });
    expect(response.statusCode, response.body).toBe(201);
    const experiment = ExperimentEnvelopeSchema.parse(response.json()).data.experiment;
    expect(experiment.createdByUserId).toBe(fixture.analystUserId);
    expect(experiment.createdByUserId).not.toBe(fixture.ownerUserId);
    expect(experiment.intervention).toMatchObject({
      kind: 'PUBLISHED_PUBLICATION',
      publicationRecordId: fixture.publicationRecordId,
      publicationAttemptId: fixture.publicationAttemptId,
      channelPackageId: fixture.channelPackageId,
      artifactId: fixture.artifactId,
      artifactRevisionId: fixture.artifactRevisionId,
      artifactContentHash: fixture.artifactContentHash,
      applicationState: 'PUBLISHED',
      observedAt: PUBLISHED_AT.toISOString(),
    });
    expect(experiment.measurementContext).toMatchObject({
      scenarioId: FAKE_ARTIFACT_LINEAGE.promptScenarioId,
      scenarioVersion: 1,
      providerKey: 'fixture-provider',
      surfaceKey: 'consumer-answer-sandbox',
      model: 'fixture-model',
      modelVersion: 'fixture-v1',
      timeline: {
        baseline: {
          runId: fixture.baselineRunId,
          startedAt: BASELINE_STARTED_AT.toISOString(),
          completedAt: BASELINE_COMPLETED_AT.toISOString(),
          evidenceWindow: {
            minObservedAt: '2026-07-21T06:01:00.000Z',
            maxObservedAt: '2026-07-21T06:08:00.000Z',
          },
        },
        remeasurement: {
          runId: fixture.remeasurementRunId,
          startedAt: REMEASUREMENT_STARTED_AT.toISOString(),
          completedAt: REMEASUREMENT_COMPLETED_AT.toISOString(),
          evidenceWindow: {
            minObservedAt: '2026-07-21T06:31:00.000Z',
            maxObservedAt: '2026-07-21T06:38:00.000Z',
          },
        },
      },
    });
    expect(experiment.comparisons).toHaveLength(4);
    expect(new Set(experiment.comparisons.map((comparison) => comparison.metricKey))).toEqual(
      new Set(METRIC_KEYS),
    );
    const mention = experiment.comparisons.find(
      (comparison) => comparison.metricKey === 'MENTION_RATE',
    );
    expect(mention).toMatchObject({
      baseline: { numerator: 2, eligibleDenominator: 4, value: 0.5, sampleSize: 8 },
      remeasurement: { numerator: 3, eligibleDenominator: 4, value: 0.75, sampleSize: 8 },
      delta: { numerator: 1, eligibleDenominator: 0, value: 0.25 },
    });
    expect(
      experiment.comparisons.find((comparison) => comparison.metricKey === 'CITATION_RATE')?.delta
        .value,
    ).toBe(0.5);
    expect(
      experiment.comparisons.find((comparison) => comparison.metricKey === 'COVERAGE_RATE')?.delta
        .value,
    ).toBe(-0.166666666666);
    expect(
      experiment.comparisons.find((comparison) => comparison.metricKey === 'ACCURACY_RATE'),
    ).toMatchObject({
      baseline: { value: 0.000122070313 },
      remeasurement: { value: 0.000244140625 },
      delta: { value: 0.000122070312 },
    });
    expect(experiment.sample).toEqual({ baseline: 8, remeasurement: 8 });
    expect(experiment.excludedCounts).toEqual({
      baseline: { ERROR: 1, NOT_CHECKED: 1, INCONCLUSIVE: 1, NOT_APPLICABLE: 1 },
      remeasurement: { ERROR: 1, NOT_CHECKED: 1, INCONCLUSIVE: 1, NOT_APPLICABLE: 1 },
    });
    expect(experiment.costBreakdown).toEqual({
      baseline: [{ amount: '0.080000', currency: 'USD' }],
      remeasurement: [{ amount: '0.160000', currency: 'USD' }],
    });
    expect(experiment.observedAssociation).toMatch(/does not establish causation/iu);
    expect(experiment.caveat).toMatch(/uncertainty/iu);
    expect(experiment.noGuarantee).toMatch(/does not guarantee/iu);
    const publicationLineage = await pool.query<{
      updated_at: Date;
      attempt_ids: string[];
    }>(
      `SELECT publication.updated_at,
         array_agg(attempt.id ORDER BY attempt.finished_at, attempt.attempt_number)
           AS attempt_ids
       FROM publication_records publication
       JOIN publication_attempts attempt ON attempt.publication_id = publication.id
       WHERE publication.id = $1 GROUP BY publication.updated_at`,
      [fixture.publicationRecordId],
    );
    expect(publicationLineage.rows[0]).toEqual({
      updated_at: new Date('2026-07-21T08:00:00.000Z'),
      attempt_ids: [fixture.publicationAttemptId, fixture.laterPublicationAttemptId],
    });
    const derivedCompatibility = await pool.query<{
      metric_key: MetricKey;
      compatibility_key: string;
      compatibility_hash: string;
    }>(
      `SELECT metric_key,
         aeostudio_experiment_compatibility_key(metric_key, method_version, cohort)
           AS compatibility_key,
         encode(sha256(convert_to(
           aeostudio_experiment_compatibility_key(metric_key, method_version, cohort),
           'UTF8'
         )), 'hex') AS compatibility_hash
       FROM metric_snapshots WHERE measurement_run_id = $1 ORDER BY metric_key`,
      [fixture.baselineRunId],
    );
    for (const row of derivedCompatibility.rows) {
      const comparison = experiment.comparisons.find(
        (candidate) => candidate.metricKey === row.metric_key,
      );
      expect(comparison).toMatchObject({
        compatibilityKey: row.compatibility_key,
        compatibilityHash: row.compatibility_hash,
      });
    }

    const repeated = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/experiments`,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload,
    });
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(ExperimentEnvelopeSchema.parse(repeated.json()).data.experiment).toEqual(experiment);

    const get = await app.inject({
      method: 'GET',
      url:
        `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
        `/experiments/${experiment.id}`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(get.statusCode, get.body).toBe(200);
    expect(ExperimentEnvelopeSchema.parse(get.json()).data.experiment).toEqual(experiment);
  }, 120_000);

  test('database guards reject direct SEALED rows, partial links, forged reports and compatibility hashes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/experiments`,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        baselineRunId: fixture.baselineRunId,
        remeasurementRunId: fixture.remeasurementRunId,
        intervention: publishedIntervention(fixture),
        idempotencyKey: randomUUID(),
      } satisfies CreateExperimentRequest,
    });
    expect(response.statusCode, response.body).toBe(201);
    const sourceExperiment = ExperimentEnvelopeSchema.parse(response.json()).data.experiment;
    const sourceRow = await pool.query<{ compatibility_hash: string }>(
      `SELECT compatibility_hash FROM experiments WHERE id = $1`,
      [sourceExperiment.id],
    );
    const compatibilityHash = sourceRow.rows[0]?.compatibility_hash;
    if (compatibilityHash === undefined) throw new Error('TASK16_COMPATIBILITY_HASH_MISSING');

    const directClient = await pool.connect();
    try {
      await beginRuntime(directClient, scope, fixture.analystUserId);
      await expectP0001(
        directClient.query(
          `INSERT INTO experiments
            (id, tenant_id, workspace_id, schema_version, status, baseline_run_id,
              remeasurement_run_id, scenario_version, intervention_kind,
              publication_record_id, publication_attempt_id, channel_package_id,
              package_checksum, artifact_id, artifact_review_id, artifact_revision_id,
              artifact_revision, artifact_content_hash, intervention_observed_at,
              compatibility_hash, report, idempotency_key, request_hash, created_by_user_id,
              created_at, sealed_at)
           SELECT $1, tenant_id, workspace_id, schema_version, 'SEALED', baseline_run_id,
             remeasurement_run_id, scenario_version, intervention_kind,
             publication_record_id, publication_attempt_id, channel_package_id,
             package_checksum, artifact_id, artifact_review_id, artifact_revision_id,
             artifact_revision, artifact_content_hash, intervention_observed_at,
             compatibility_hash, report, $2, request_hash, created_by_user_id,
             created_at, sealed_at
           FROM experiments WHERE id = $3`,
          [randomUUID(), randomUUID(), sourceExperiment.id],
        ),
        'EXPERIMENT_MUST_START_BUILDING',
      );
      await directClient.query('ROLLBACK');

      const partialId = randomUUID();
      await beginRuntime(directClient, scope, fixture.analystUserId);
      await insertBuildingCopy({
        client: directClient,
        sourceExperimentId: sourceExperiment.id,
        targetExperimentId: partialId,
        idempotencyKey: randomUUID(),
      });
      await directClient.query(
        `INSERT INTO experiment_snapshot_links
          (tenant_id, workspace_id, experiment_id, ordinal, metric_key, scope_key,
            baseline_snapshot_id, baseline_content_hash, remeasurement_snapshot_id,
            remeasurement_content_hash, compatibility_key, compatibility_hash)
         SELECT tenant_id, workspace_id, $1, ordinal, metric_key, scope_key,
           baseline_snapshot_id, baseline_content_hash, remeasurement_snapshot_id,
           remeasurement_content_hash, compatibility_key, compatibility_hash
         FROM experiment_snapshot_links WHERE experiment_id = $2
         ORDER BY ordinal LIMIT 1`,
        [partialId, sourceExperiment.id],
      );
      const partialReport = structuredClone(sourceExperiment);
      partialReport.id = partialId;
      partialReport.comparisons = partialReport.comparisons.slice(0, 1);
      await expectP0001(
        directClient.query(
          `UPDATE experiments SET status = 'SEALED', compatibility_hash = $1,
             report = $2::jsonb, sealed_at = created_at
           WHERE id = $3`,
          [compatibilityHash, JSON.stringify(partialReport), partialId],
        ),
        'EXPERIMENT_SNAPSHOT_LINKS_INVALID',
      );
      await directClient.query('ROLLBACK');

      for (const forgedField of ['compatibility_key', 'compatibility_hash'] as const) {
        const forgedLinkId = randomUUID();
        await beginRuntime(directClient, scope, fixture.analystUserId);
        await insertBuildingCopy({
          client: directClient,
          sourceExperimentId: sourceExperiment.id,
          targetExperimentId: forgedLinkId,
          idempotencyKey: randomUUID(),
        });
        await expectP0001(
          directClient.query(
            `INSERT INTO experiment_snapshot_links
              (tenant_id, workspace_id, experiment_id, ordinal, metric_key, scope_key,
                baseline_snapshot_id, baseline_content_hash, remeasurement_snapshot_id,
                remeasurement_content_hash, compatibility_key, compatibility_hash)
             SELECT tenant_id, workspace_id, $1, ordinal, metric_key, scope_key,
               baseline_snapshot_id, baseline_content_hash, remeasurement_snapshot_id,
               remeasurement_content_hash,
               CASE WHEN $3 = 'compatibility_key' THEN 'forged-key' ELSE compatibility_key END,
               CASE WHEN $3 = 'compatibility_hash' THEN $4 ELSE compatibility_hash END
             FROM experiment_snapshot_links WHERE experiment_id = $2
             ORDER BY ordinal LIMIT 1`,
            [forgedLinkId, sourceExperiment.id, forgedField, '0'.repeat(64)],
          ),
          'EXPERIMENT_SNAPSHOT_LINK_INVALID',
        );
        await directClient.query('ROLLBACK');
      }

      for (const mismatchRunId of [fixture.incompatibleRunId, fixture.methodMismatchRunId]) {
        const mismatchExperimentId = randomUUID();
        await beginRuntime(directClient, scope, fixture.analystUserId);
        await insertBuildingCopy({
          client: directClient,
          sourceExperimentId: sourceExperiment.id,
          targetExperimentId: mismatchExperimentId,
          idempotencyKey: randomUUID(),
          remeasurementRunId: mismatchRunId,
        });
        await expectP0001(
          directClient.query(
            `INSERT INTO experiment_snapshot_links
              (tenant_id, workspace_id, experiment_id, ordinal, metric_key, scope_key,
                baseline_snapshot_id, baseline_content_hash, remeasurement_snapshot_id,
                remeasurement_content_hash, compatibility_key, compatibility_hash)
             SELECT source.tenant_id, source.workspace_id, $1, source.ordinal,
               source.metric_key, source.scope_key, source.baseline_snapshot_id,
               source.baseline_content_hash, mismatch.id, mismatch.content_hash,
               source.compatibility_key, source.compatibility_hash
             FROM experiment_snapshot_links source
             JOIN metric_snapshots mismatch
               ON mismatch.measurement_run_id = $3
              AND mismatch.metric_key = source.metric_key
              AND mismatch.scope_key = source.scope_key
             WHERE source.experiment_id = $2 ORDER BY source.ordinal LIMIT 1`,
            [mismatchExperimentId, sourceExperiment.id, mismatchRunId],
          ),
          'EXPERIMENT_SNAPSHOT_LINK_INVALID',
        );
        await directClient.query('ROLLBACK');
      }

      for (const outOfWindowRunId of [fixture.staleEvidenceRunId, fixture.runWindowRunId]) {
        await beginRuntime(directClient, scope, fixture.analystUserId);
        await expectP0001(
          insertBuildingCopy({
            client: directClient,
            sourceExperimentId: sourceExperiment.id,
            targetExperimentId: randomUUID(),
            idempotencyKey: randomUUID(),
            remeasurementRunId: outOfWindowRunId,
          }),
          'EXPERIMENT_EVIDENCE_WINDOW_INVALID',
        );
        await directClient.query('ROLLBACK');
      }

      const forgedReportId = randomUUID();
      await beginRuntime(directClient, scope, fixture.analystUserId);
      await insertBuildingCopy({
        client: directClient,
        sourceExperimentId: sourceExperiment.id,
        targetExperimentId: forgedReportId,
        idempotencyKey: randomUUID(),
      });
      await directClient.query(
        `INSERT INTO experiment_snapshot_links
          (tenant_id, workspace_id, experiment_id, ordinal, metric_key, scope_key,
            baseline_snapshot_id, baseline_content_hash, remeasurement_snapshot_id,
            remeasurement_content_hash, compatibility_key, compatibility_hash)
         SELECT tenant_id, workspace_id, $1, ordinal, metric_key, scope_key,
           baseline_snapshot_id, baseline_content_hash, remeasurement_snapshot_id,
           remeasurement_content_hash, compatibility_key, compatibility_hash
         FROM experiment_snapshot_links WHERE experiment_id = $2`,
        [forgedReportId, sourceExperiment.id],
      );
      const forgedReport = structuredClone(sourceExperiment);
      forgedReport.id = forgedReportId;
      const firstComparison = forgedReport.comparisons[0];
      if (firstComparison === undefined) throw new Error('TASK16_COMPARISON_FIXTURE_MISSING');
      firstComparison.baseline.snapshotId = randomUUID();
      await expectP0001(
        directClient.query(
          `UPDATE experiments SET status = 'SEALED', compatibility_hash = $1,
             report = $2::jsonb, sealed_at = created_at
           WHERE id = $3`,
          [compatibilityHash, JSON.stringify(forgedReport), forgedReportId],
        ),
        'EXPERIMENT_REPORT_COMPARISON_INVALID',
      );
      await directClient.query('ROLLBACK');

      const forgedTopHashId = randomUUID();
      await beginRuntime(directClient, scope, fixture.analystUserId);
      await insertBuildingCopy({
        client: directClient,
        sourceExperimentId: sourceExperiment.id,
        targetExperimentId: forgedTopHashId,
        idempotencyKey: randomUUID(),
      });
      await directClient.query(
        `INSERT INTO experiment_snapshot_links
          (tenant_id, workspace_id, experiment_id, ordinal, metric_key, scope_key,
            baseline_snapshot_id, baseline_content_hash, remeasurement_snapshot_id,
            remeasurement_content_hash, compatibility_key, compatibility_hash)
         SELECT tenant_id, workspace_id, $1, ordinal, metric_key, scope_key,
           baseline_snapshot_id, baseline_content_hash, remeasurement_snapshot_id,
           remeasurement_content_hash, compatibility_key, compatibility_hash
         FROM experiment_snapshot_links WHERE experiment_id = $2`,
        [forgedTopHashId, sourceExperiment.id],
      );
      const validCopiedReport = structuredClone(sourceExperiment);
      validCopiedReport.id = forgedTopHashId;
      await expectP0001(
        directClient.query(
          `UPDATE experiments SET status = 'SEALED', compatibility_hash = $1,
             report = $2::jsonb, sealed_at = created_at
           WHERE id = $3`,
          ['0'.repeat(64), JSON.stringify(validCopiedReport), forgedTopHashId],
        ),
        'EXPERIMENT_COMPATIBILITY_HASH_INVALID',
      );
      await directClient.query('ROLLBACK');
    } finally {
      directClient.release();
    }

    const persisted = await pool.query<{ status: string; link_count: number }>(
      `SELECT experiment.status,
         (SELECT count(*)::integer FROM experiment_snapshot_links link
          WHERE link.experiment_id = experiment.id) AS link_count
       FROM experiments experiment WHERE experiment.id = $1`,
      [sourceExperiment.id],
    );
    expect(persisted.rows[0]).toEqual({ status: 'SEALED', link_count: 4 });
  }, 120_000);

  test('database seal fails closed when required disclosure and intervention strings are missing or null', async () => {
    const createSource = async (intervention: CreateExperimentRequest['intervention']) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` + '/experiments',
        headers: {
          cookie: `__Host-aeo_session=${analystSession}`,
          origin: 'https://app.example.test',
        },
        payload: {
          baselineRunId: fixture.baselineRunId,
          remeasurementRunId: fixture.remeasurementRunId,
          intervention,
          idempotencyKey: randomUUID(),
        } satisfies CreateExperimentRequest,
      });
      expect(response.statusCode, response.body).toBe(201);
      return ExperimentEnvelopeSchema.parse(response.json()).data.experiment;
    };
    const publishedSource = await createSource(publishedIntervention(fixture));
    const approvedSource = await createSource(approvedIntervention(fixture));
    const sourceHashes = await pool.query<{ id: string; compatibility_hash: string }>(
      `SELECT id, compatibility_hash FROM experiments WHERE id = ANY($1::uuid[])`,
      [[publishedSource.id, approvedSource.id]],
    );
    const compatibilityBySource = new Map(
      sourceHashes.rows.map((row) => [row.id, row.compatibility_hash]),
    );
    type SourceExperiment = typeof publishedSource;
    interface SealVariant {
      label: string;
      source: SourceExperiment;
      expectedError: string;
      mutate(report: Record<string, unknown>): void;
    }
    const variants: SealVariant[] = [];
    const addMissingAndNull = (input: {
      label: string;
      source: SourceExperiment;
      expectedError: string;
      record(report: Record<string, unknown>): Record<string, unknown>;
      field: string;
    }) => {
      variants.push(
        {
          label: `${input.label} missing`,
          source: input.source,
          expectedError: input.expectedError,
          mutate(report) {
            delete input.record(report)[input.field];
          },
        },
        {
          label: `${input.label} null`,
          source: input.source,
          expectedError: input.expectedError,
          mutate(report) {
            input.record(report)[input.field] = null;
          },
        },
      );
    };
    const interventionRecord = (report: Record<string, unknown>) =>
      jsonRecord(report.intervention, 'INTERVENTION');

    addMissingAndNull({
      label: 'published applicationState',
      source: publishedSource,
      expectedError: 'EXPERIMENT_REPORT_PUBLICATION_IDENTITY_INVALID',
      record: interventionRecord,
      field: 'applicationState',
    });
    addMissingAndNull({
      label: 'published intervention href',
      source: publishedSource,
      expectedError: 'EXPERIMENT_REPORT_PUBLICATION_IDENTITY_INVALID',
      record: interventionRecord,
      field: 'href',
    });
    variants.push({
      label: 'published intervention href wrong',
      source: publishedSource,
      expectedError: 'EXPERIMENT_REPORT_PUBLICATION_IDENTITY_INVALID',
      mutate(report) {
        interventionRecord(report).href = '/app/channels?publication=wrong';
      },
    });
    addMissingAndNull({
      label: 'approved applicationState',
      source: approvedSource,
      expectedError: 'EXPERIMENT_REPORT_APPROVAL_IDENTITY_INVALID',
      record: interventionRecord,
      field: 'applicationState',
    });
    addMissingAndNull({
      label: 'approved applicationDisclosure',
      source: approvedSource,
      expectedError: 'EXPERIMENT_REPORT_APPROVAL_IDENTITY_INVALID',
      record: interventionRecord,
      field: 'applicationDisclosure',
    });
    addMissingAndNull({
      label: 'approved intervention href',
      source: approvedSource,
      expectedError: 'EXPERIMENT_REPORT_APPROVAL_IDENTITY_INVALID',
      record: interventionRecord,
      field: 'href',
    });
    variants.push({
      label: 'approved intervention href wrong',
      source: approvedSource,
      expectedError: 'EXPERIMENT_REPORT_APPROVAL_IDENTITY_INVALID',
      mutate(report) {
        interventionRecord(report).href = '/app/artifacts?artifact=wrong';
      },
    });
    for (const field of ['observedAssociation', 'caveat', 'noGuarantee']) {
      addMissingAndNull({
        label: `top ${field}`,
        source: publishedSource,
        expectedError: 'EXPERIMENT_REPORT_DISCLOSURE_INVALID',
        record: (report) => report,
        field,
      });
      addMissingAndNull({
        label: `comparison ${field}`,
        source: publishedSource,
        expectedError: 'EXPERIMENT_REPORT_DISCLOSURE_INVALID',
        record: firstComparison,
        field,
      });
    }
    variants.push({
      label: 'top caveat contradictory despite uncertainty token',
      source: publishedSource,
      expectedError: 'EXPERIMENT_REPORT_DISCLOSURE_INVALID',
      mutate(report) {
        report.caveat =
          'Uncertainty is irrelevant because this intervention caused guaranteed ranking results.';
      },
    });
    addMissingAndNull({
      label: 'comparisons array',
      source: publishedSource,
      expectedError: 'EXPERIMENT_SNAPSHOT_LINKS_INVALID',
      record: (report) => report,
      field: 'comparisons',
    });

    const attemptedIds: string[] = [];
    const directClient = await pool.connect();
    try {
      for (const variant of variants) {
        const targetExperimentId = randomUUID();
        attemptedIds.push(targetExperimentId);
        await beginRuntime(directClient, scope, fixture.analystUserId);
        try {
          await insertBuildingCopy({
            client: directClient,
            sourceExperimentId: variant.source.id,
            targetExperimentId,
            idempotencyKey: randomUUID(),
          });
          await insertSnapshotLinkCopies({
            client: directClient,
            sourceExperimentId: variant.source.id,
            targetExperimentId,
          });
          const report = jsonRecord(structuredClone(variant.source), 'REPORT');
          report.id = targetExperimentId;
          variant.mutate(report);
          let rejection: unknown;
          try {
            await directClient.query(
              `UPDATE experiments SET status = 'SEALED', compatibility_hash = $1,
                 report = $2::jsonb, sealed_at = created_at WHERE id = $3`,
              [
                compatibilityBySource.get(variant.source.id),
                JSON.stringify(report),
                targetExperimentId,
              ],
            );
          } catch (error: unknown) {
            rejection = error;
          }
          expect(rejection, `${variant.label} must be rejected`).toMatchObject({ code: 'P0001' });
          expect((rejection as Error).message, variant.label).toContain(variant.expectedError);
        } finally {
          await directClient.query('ROLLBACK');
        }
      }
    } finally {
      directClient.release();
    }
    const leaked = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM experiments WHERE id = ANY($1::uuid[])`,
      [attemptedIds],
    );
    expect(leaked.rows[0]?.count).toBe(0);
  }, 120_000);

  test('exact approval succeeds while incompatible, stale, wrong-hash and unpublished inputs fail structurally', async () => {
    const post = (payload: CreateExperimentRequest) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/experiments`,
        headers: {
          cookie: `__Host-aeo_session=${analystSession}`,
          origin: 'https://app.example.test',
        },
        payload,
      });
    const optionsResponse = await app.inject({
      method: 'GET',
      url:
        `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
        '/experiments/options',
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(optionsResponse.statusCode, optionsResponse.body).toBe(200);
    const options = ExperimentOptionsEnvelopeSchema.parse(optionsResponse.json()).data.options;
    const approvedCombination = options.compatibleCombinations.find(
      (combination) => combination.intervention.kind === 'APPROVED_ARTIFACT',
    );
    if (approvedCombination === undefined) throw new Error('TASK16_APPROVED_OPTION_MISSING');
    const approvedPayload: CreateExperimentRequest = {
      baselineRunId: approvedCombination.baselineRunId,
      remeasurementRunId: approvedCombination.remeasurementRunId,
      intervention: approvedCombination.intervention,
      idempotencyKey: randomUUID(),
    };
    const approved = await post(approvedPayload);
    expect(approved.statusCode, approved.body).toBe(201);
    const approvedExperiment = ExperimentEnvelopeSchema.parse(approved.json()).data.experiment;
    expect(approvedExperiment.intervention).toMatchObject({
      kind: 'APPROVED_ARTIFACT',
      artifactId: fixture.artifactId,
      artifactReviewId: fixture.artifactReviewId,
      artifactRevisionId: fixture.artifactRevisionId,
      artifactContentHash: fixture.artifactContentHash,
      applicationState: 'APPROVED_NOT_PUBLISHED',
      observedAt: APPROVED_AT.toISOString(),
      applicationDisclosure:
        'Approval is a recorded review event, not proof of external application or causation.',
    });
    expect(approvedExperiment.intervention.href).toBe(
      `/app/artifacts?tenant=${scope.tenant.id}&workspace=${scope.workspace.id}` +
        `&artifact=${fixture.artifactId}`,
    );
    expect(approvedExperiment.observedAssociation).toMatch(/does not prove external application/iu);

    const incompatible = await post({
      ...approvedPayload,
      remeasurementRunId: fixture.incompatibleRunId,
      idempotencyKey: randomUUID(),
    });
    expect(incompatible.statusCode, incompatible.body).toBe(409);
    const incompatibleBody = incompatible.json<{ comparison?: unknown }>();
    expect(incompatibleBody).toMatchObject({
      status: 409,
      code: 'INCOMPATIBLE_SCENARIO',
      retryable: false,
    });
    expect(IncompatibleExperimentSchema.parse(incompatibleBody.comparison)).toMatchObject({
      outcome: 'INCOMPATIBLE_SCENARIO',
      differingFields: ['modelVersion'],
      decision: 'STRATIFY',
    });

    const staleEvidence = await post({
      ...approvedPayload,
      intervention: publishedIntervention(fixture),
      remeasurementRunId: fixture.staleEvidenceRunId,
      idempotencyKey: randomUUID(),
    });
    expect(staleEvidence.statusCode, staleEvidence.body).toBe(409);
    expect(staleEvidence.json()).toMatchObject({
      status: 409,
      code: 'INTERVENTION_OUTSIDE_MEASUREMENT_WINDOW',
      retryable: false,
    });

    for (const wrongHash of [
      { ...publishedIntervention(fixture), artifactContentHash: '0'.repeat(64) },
      { ...approvedIntervention(fixture), artifactContentHash: '0'.repeat(64) },
    ]) {
      const rejected = await post({
        baselineRunId: fixture.baselineRunId,
        remeasurementRunId: fixture.remeasurementRunId,
        intervention: wrongHash,
        idempotencyKey: randomUUID(),
      });
      expect(rejected.statusCode, rejected.body).toBe(409);
      expect(rejected.json()).toMatchObject({
        status: 409,
        code: 'EXACT_INTERVENTION_REQUIRED',
        retryable: false,
      });
    }

    const unpublished = await post({
      baselineRunId: fixture.baselineRunId,
      remeasurementRunId: fixture.remeasurementRunId,
      intervention: {
        ...publishedIntervention(fixture),
        publicationRecordId: fixture.unpublishedRecordId,
        publicationAttemptId: fixture.unpublishedAttemptId,
      },
      idempotencyKey: randomUUID(),
    });
    expect(unpublished.statusCode, unpublished.body).toBe(409);
    expect(unpublished.json()).toMatchObject({
      status: 409,
      code: 'INTERVENTION_NOT_APPLIED',
      retryable: false,
    });

    const idempotencyConflict = await post({
      ...approvedPayload,
      remeasurementRunId: fixture.incompatibleRunId,
    });
    expect(idempotencyConflict.statusCode, idempotencyConflict.body).toBe(409);
    expect(idempotencyConflict.json()).toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
      retryable: false,
    });
  }, 120_000);

  test('Viewer mutation is denied and tenant/workspace reads are opaque while sealed evidence remains immutable', async () => {
    const payload: CreateExperimentRequest = {
      baselineRunId: fixture.baselineRunId,
      remeasurementRunId: fixture.remeasurementRunId,
      intervention: publishedIntervention(fixture),
      idempotencyKey: randomUUID(),
    };
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/experiments`,
      headers: {
        cookie: `__Host-aeo_session=${analystSession}`,
        origin: 'https://app.example.test',
      },
      payload,
    });
    expect(created.statusCode, created.body).toBe(201);
    const experiment = ExperimentEnvelopeSchema.parse(created.json()).data.experiment;

    const ownerCreated = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/experiments`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        baselineRunId: fixture.baselineRunId,
        remeasurementRunId: fixture.remeasurementRunId,
        intervention: approvedIntervention(fixture),
        idempotencyKey: randomUUID(),
      } satisfies CreateExperimentRequest,
    });
    expect(ownerCreated.statusCode, ownerCreated.body).toBe(201);
    const ownerExperiment = ExperimentEnvelopeSchema.parse(ownerCreated.json()).data.experiment;
    expect(ownerExperiment.createdByUserId).toBe(fixture.ownerUserId);
    const ownerRead = await app.inject({
      method: 'GET',
      url:
        `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
        `/experiments/${ownerExperiment.id}`,
      headers: { cookie: `__Host-aeo_session=${ownerSession}` },
    });
    expect(ownerRead.statusCode, ownerRead.body).toBe(200);
    expect(ExperimentEnvelopeSchema.parse(ownerRead.json()).data.experiment.id).toBe(
      ownerExperiment.id,
    );

    const viewerMutation = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/experiments`,
      headers: {
        cookie: `__Host-aeo_session=${viewerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { ...payload, idempotencyKey: randomUUID() },
    });
    expect(viewerMutation.statusCode, viewerMutation.body).toBe(403);
    expect(viewerMutation.json()).toMatchObject({ status: 403, code: 'FORBIDDEN' });

    const viewerRead = await app.inject({
      method: 'GET',
      url:
        `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}` +
        `/experiments/${experiment.id}`,
      headers: { cookie: `__Host-aeo_session=${viewerSession}` },
    });
    expect(viewerRead.statusCode, viewerRead.body).toBe(200);
    expect(ExperimentEnvelopeSchema.parse(viewerRead.json()).data.experiment.id).toBe(
      experiment.id,
    );

    const siblingRead = await app.inject({
      method: 'GET',
      url:
        `/api/v1/tenants/${scope.tenant.id}/workspaces/${siblingWorkspaceId}` +
        `/experiments/${experiment.id}`,
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(siblingRead.statusCode, siblingRead.body).toBe(404);
    expect(siblingRead.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });

    const siblingOptions = await app.inject({
      method: 'GET',
      url:
        `/api/v1/tenants/${scope.tenant.id}/workspaces/${siblingWorkspaceId}` +
        '/experiments/options',
      headers: { cookie: `__Host-aeo_session=${analystSession}` },
    });
    expect(siblingOptions.statusCode, siblingOptions.body).toBe(200);
    expect(ExperimentOptionsEnvelopeSchema.parse(siblingOptions.json()).data.options).toEqual({
      baselineRuns: [],
      remeasurementRuns: [],
      interventions: [],
      compatibleCombinations: [],
    });

    const crossTenantRead = await app.inject({
      method: 'GET',
      url:
        `/api/v1/tenants/${otherScope.tenant.id}/workspaces/${otherScope.workspace.id}` +
        `/experiments/${experiment.id}`,
      headers: { cookie: `__Host-aeo_session=${otherOwnerSession}` },
    });
    expect(crossTenantRead.statusCode, crossTenantRead.body).toBe(404);
    expect(crossTenantRead.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });

    await expectP0001(
      pool.query(
        `UPDATE experiments SET report = report || '{"tampered":true}'::jsonb WHERE id = $1`,
        [experiment.id],
      ),
      'EXPERIMENT_IMMUTABLE',
    );
    await expectDatabaseGuard(
      pool.query(`DELETE FROM experiments WHERE id = $1`, [experiment.id]),
      '42501',
      'LIFECYCLE_DELETE_CONTEXT_REQUIRED',
    );
    await expectP0001(
      pool.query(
        `UPDATE experiment_snapshot_links SET ordinal = ordinal + 10 WHERE experiment_id = $1`,
        [experiment.id],
      ),
      'EXPERIMENT_SNAPSHOT_LINK_IMMUTABLE',
    );
    await expectP0001(
      pool.query(`UPDATE metric_snapshots SET numerator = numerator WHERE id = $1`, [
        fixture.baselineSnapshotIds.MENTION_RATE,
      ]),
      'MEASUREMENT_EVIDENCE_IMMUTABLE',
    );
    await expectP0001(
      pool.query(`UPDATE publication_attempts SET finished_at = finished_at WHERE id = $1`, [
        fixture.publicationAttemptId,
      ]),
      'PUBLICATION_ATTEMPT_IMMUTABLE',
    );

    const unchanged = await pool.query<{
      status: string;
      link_count: number;
      applied_at: Date;
    }>(
      `SELECT experiment.status,
         (SELECT count(*)::integer FROM experiment_snapshot_links link
          WHERE link.experiment_id = experiment.id) AS link_count,
         (SELECT finished_at FROM publication_attempts WHERE id = $2) AS applied_at
       FROM experiments experiment WHERE experiment.id = $1`,
      [experiment.id, fixture.publicationAttemptId],
    );
    expect(unchanged.rows[0]).toEqual({
      status: 'SEALED',
      link_count: 4,
      applied_at: PUBLISHED_AT,
    });

    const duplicateReviewClient = await pool.connect();
    try {
      await duplicateReviewClient.query('BEGIN');
      await duplicateReviewClient.query("SELECT set_config('app.tenant_id', $1, true)", [
        scope.tenant.id,
      ]);
      await duplicateReviewClient.query("SELECT set_config('app.workspace_id', $1, true)", [
        scope.workspace.id,
      ]);
      await duplicateReviewClient.query("SELECT set_config('app.actor_id', $1, true)", [
        fixture.ownerUserId,
      ]);
      await expectP0001(
        duplicateReviewClient.query(
          `INSERT INTO artifact_reviews
            (id, tenant_id, workspace_id, artifact_id, artifact_revision_id, revision,
              content_hash, decision, reviewer_user_id, note, created_at)
           VALUES ($1, $2, $3, $4, $5, 1, $6, 'APPROVE', $7,
             'A duplicate approval must not replace the exact review.', $8)`,
          [
            randomUUID(),
            scope.tenant.id,
            scope.workspace.id,
            fixture.artifactId,
            fixture.artifactRevisionId,
            fixture.artifactContentHash,
            fixture.ownerUserId,
            new Date('2026-07-21T06:16:00.000Z'),
          ],
        ),
        'ARTIFACT_REVIEW_EXACT_REVISION_REQUIRED',
      );
      await duplicateReviewClient.query('ROLLBACK');
    } finally {
      duplicateReviewClient.release();
    }
    const exactReviewCount = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM artifact_reviews
       WHERE artifact_revision_id = $1 AND decision = 'APPROVE'`,
      [fixture.artifactRevisionId],
    );
    expect(exactReviewCount.rows[0]?.count).toBe(1);
  }, 120_000);
});
