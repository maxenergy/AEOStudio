import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import type { AuthorizationRequest, OidcClient } from '@aeostudio/application/auth';
import {
  JobWorkerCoordinator,
  OutboxRelay,
  type JobQueueMessage,
} from '@aeostudio/application/jobs-budgets';
import {
  AwsSqsJobQueue,
  AwsSqsJobQueueConsumer,
  FakeJobQueue,
  readInboundJobMessage,
} from '@aeostudio/adapters/queue';
import {
  AesGcmSessionCipher,
  PostgresAuthStore,
  PostgresJobBudgetStore,
  PostgresProfileOfferingStore,
  PostgresTenancyStore,
  runMigrations,
} from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { createApiApp } from '../../apps/api/src/app.js';
import { createMeasurementWorkerRuntime } from '../../apps/worker/src/measurement-worker-runtime.js';
import { ProfileReadinessHandler } from '../../apps/worker/src/profile-readiness-handler.js';
import { ProfileReadinessJobWorker } from '../../apps/worker/src/profile-readiness-job-worker.js';

type ApiTestApp = Awaited<ReturnType<typeof createApiApp>>;

class FakeClock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

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
    if (input.code === 'jobs-editor-code') {
      return Promise.resolve({
        subject: 'jobs-editor-subject',
        email: 'jobs-editor@example.test',
        emailVerified: true,
      });
    }
    return Promise.resolve({
      subject: 'jobs-owner-subject',
      email: 'jobs-owner@example.test',
      emailVerified: true,
    });
  },
};

async function signIn(app: ApiTestApp, code = 'owner-code'): Promise<string> {
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

const claimBarrierNamespace = 15_404;
const propagatedTraceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

async function waitForClaimBarrier(
  pool: Pool,
  barrierKey: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_locks
         WHERE locktype = 'advisory'
           AND classid = $1::oid
           AND objid = $2::oid
           AND objsubid = 2
           AND NOT granted
       ) AS waiting`,
      [claimBarrierNamespace, barrierKey],
    );
    if (waiting.rows[0]?.waiting === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe('Task 4 durable jobs and budget hard stop', () => {
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
      store: new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 4))),
      jobBudgetStore: new PostgresJobBudgetStore(pool),
      tenancyStore: new PostgresTenancyStore(pool),
      profileOfferingStore: new PostgresProfileOfferingStore(pool),
      webOrigin: 'https://app.example.test',
      jobTraceContextProvider: {
        capture: (requestId: string) => ({
          traceparent: propagatedTraceparent,
          requestId,
        }),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  test('job command atomically reserves budget and writes a content-free outbox message', async () => {
    const session = await signIn(app);
    const tenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Job Tenant', workspaceName: 'Readiness Workspace' },
    });
    const scope = tenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const profileResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        displayName: 'Job Profile',
        targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
      },
    });
    const profileId = profileResponse.json<{ data: { profile: { profileId: string } } }>().data
      .profile.profileId;

    const budgetResponse = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { limitUnits: 100 },
    });
    expect(budgetResponse.statusCode).toBe(200);

    const startedAt = performance.now();
    const jobResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        jobType: 'PROFILE_READINESS',
        aggregateId: profileId,
        idempotencyKey: 'readiness-initial',
        estimatedUnits: 10,
      },
    });
    const acknowledgementMs = performance.now() - startedAt;

    expect(jobResponse.statusCode).toBe(202);
    expect(acknowledgementMs).toBeLessThan(2_000);
    expect(jobResponse.headers['server-timing']).toMatch(/^job-ack;dur=\d+(?:\.\d{2})?$/);
    const job = jobResponse.json<{
      data: { job: { id: string; status: string; budgetWarning: boolean } };
    }>().data.job;
    expect(job).toMatchObject({ status: 'QUEUED', budgetWarning: false });

    const atomicRows = await pool.query<{
      jobs: string;
      reservations: string;
      outbox: string;
    }>(
      `SELECT
        (SELECT count(*) FROM jobs WHERE id = $1)::text AS jobs,
        (SELECT count(*) FROM budget_reservations WHERE job_id = $1)::text AS reservations,
        (SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1)::text AS outbox`,
      [job.id],
    );
    expect(atomicRows.rows[0]).toEqual({ jobs: '1', reservations: '1', outbox: '1' });

    const payload = await pool.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM outbox_messages WHERE aggregate_id = $1',
      [job.id],
    );
    expect(Object.keys(payload.rows[0]?.payload ?? {}).sort()).toEqual([
      'jobId',
      'schemaVersion',
      'tenantId',
      'workspaceId',
    ]);

    let thresholdJob: { id: string; status: string; budgetWarning: boolean } | undefined;
    for (let index = 2; index <= 10; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs`,
        headers: {
          cookie: `__Host-aeo_session=${session}`,
          origin: 'https://app.example.test',
        },
        payload: {
          jobType: 'PROFILE_READINESS',
          aggregateId: profileId,
          idempotencyKey: `readiness-${index}`,
          estimatedUnits: 10,
        },
      });
      expect(response.statusCode).toBe(202);
      const submitted = response.json<{
        data: { job: { id: string; status: string; budgetWarning: boolean } };
      }>().data.job;
      if (index === 8) {
        thresholdJob = submitted;
      }
      expect(submitted.status).toBe('QUEUED');
    }
    expect(thresholdJob).toMatchObject({ status: 'QUEUED', budgetWarning: true });

    const blockedResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        jobType: 'PROFILE_READINESS',
        aggregateId: profileId,
        idempotencyKey: 'readiness-blocked',
        estimatedUnits: 10,
      },
    });
    expect(blockedResponse.statusCode).toBe(202);
    const blockedJob = blockedResponse.json<{
      data: { job: { id: string; status: string; budgetWarning: boolean } };
    }>().data.job;
    expect(blockedJob).toMatchObject({ status: 'BUDGET_BLOCKED', budgetWarning: true });
    const blockedEffects = await pool.query<{ reservations: string; outbox: string }>(
      `SELECT
        (SELECT count(*) FROM budget_reservations WHERE job_id = $1)::text AS reservations,
        (SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1)::text AS outbox`,
      [blockedJob.id],
    );
    expect(blockedEffects.rows[0]).toEqual({ reservations: '0', outbox: '0' });
    const alerts = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM budget_alerts WHERE tenant_id = $1',
      [scope.tenant.id],
    );
    expect(alerts.rows[0]?.count).toBe('1');

    const raised = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { limitUnits: 120 },
    });
    expect(raised.statusCode).toBe(200);
    const resumed = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        jobType: 'PROFILE_READINESS',
        aggregateId: profileId,
        idempotencyKey: 'readiness-after-raise',
        estimatedUnits: 10,
      },
    });
    expect(resumed.statusCode).toBe(202);
    expect(resumed.json()).toMatchObject({ data: { job: { status: 'QUEUED' } } });

    const replayedCommand = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        jobType: 'PROFILE_READINESS',
        aggregateId: profileId,
        idempotencyKey: 'readiness-after-raise',
        estimatedUnits: 10,
      },
    });
    expect(replayedCommand.statusCode).toBe(202);
    expect(replayedCommand.json()).toMatchObject({ data: { job: { status: 'QUEUED' } } });
    const idempotentCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM jobs
       WHERE tenant_id = $1 AND idempotency_key = 'readiness-after-raise'`,
      [scope.tenant.id],
    );
    expect(idempotentCount.rows[0]?.count).toBe('1');
    await pool.query('UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL');
  });

  test('provider-bound jobs reserve against both Tenant and Provider budgets', async () => {
    const session = await signIn(app);
    const tenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Scoped Budget Tenant', workspaceName: 'Scoped Budget Workspace' },
    });
    const scope = tenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const profileResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        displayName: 'Provider-neutral budget profile',
        targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
      },
    });
    const profileId = profileResponse.json<{ data: { profile: { profileId: string } } }>().data
      .profile.profileId;
    const budgetBase = `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`;
    for (const [url, limitUnits] of [
      [budgetBase, 1_000],
      [`${budgetBase}/tenant`, 1_000],
      [`${budgetBase}/providers/industry-neutral-provider`, 100],
      [`${budgetBase}/providers/alternate-provider`, 1_000],
    ] as const) {
      const response = await app.inject({
        method: 'PUT',
        url,
        headers: {
          cookie: `__Host-aeo_session=${session}`,
          origin: 'https://app.example.test',
        },
        payload: { limitUnits },
      });
      expect(response.statusCode, response.body).toBe(200);
    }

    const context = await new PostgresTenancyStore(pool).resolveTenantContext({
      actorSubject: 'jobs-owner-subject',
      tenantId: scope.tenant.id,
      workspaceId: scope.workspace.id,
    });
    if (context === null) throw new Error('SCOPED_BUDGET_CONTEXT_MISSING');
    const store = new PostgresJobBudgetStore(pool);
    const submit = (idempotencyKey: string, providerKey: string) =>
      store.submitJob({
        context,
        jobId: randomUUID(),
        jobType: 'PROFILE_READINESS',
        aggregateId: profileId,
        idempotencyKey,
        estimatedUnits: 10,
        providerKey,
        reservationId: randomUUID(),
        budgetAlertId: randomUUID(),
        outboxMessageId: randomUUID(),
        auditEventId: randomUUID(),
      });

    let thresholdJob: Awaited<ReturnType<typeof submit>> = null;
    for (let index = 1; index <= 10; index += 1) {
      const job = await submit(`provider-primary-${index}`, 'industry-neutral-provider');
      expect(job?.status).toBe('QUEUED');
      if (index === 8) thresholdJob = job;
    }
    expect(thresholdJob).toMatchObject({
      providerKey: 'industry-neutral-provider',
      budgetWarning: true,
    });
    await expect(
      submit('provider-primary-blocked', 'industry-neutral-provider'),
    ).resolves.toMatchObject({
      providerKey: 'industry-neutral-provider',
      status: 'BUDGET_BLOCKED',
    });

    const tenantBudget = await app.inject({
      method: 'PUT',
      url: `${budgetBase}/tenant`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { limitUnits: 120 },
    });
    expect(tenantBudget.statusCode, tenantBudget.body).toBe(200);
    await expect(submit('tenant-cap-110', 'alternate-provider')).resolves.toMatchObject({
      status: 'QUEUED',
    });
    await expect(submit('tenant-cap-120', 'alternate-provider')).resolves.toMatchObject({
      status: 'QUEUED',
    });
    await expect(submit('tenant-cap-blocked', 'alternate-provider')).resolves.toMatchObject({
      providerKey: 'alternate-provider',
      status: 'BUDGET_BLOCKED',
    });

    const persisted = await pool.query<{
      provider_key: string;
      status: string;
    }>(
      `SELECT provider_key, status
       FROM jobs
       WHERE tenant_id = $1 AND idempotency_key = 'provider-primary-8'`,
      [scope.tenant.id],
    );
    expect(persisted.rows[0]).toEqual({
      provider_key: 'industry-neutral-provider',
      status: 'QUEUED',
    });
    await pool.query('UPDATE outbox_messages SET published_at = now() WHERE tenant_id = $1', [
      scope.tenant.id,
    ]);
  });

  test('serializes Provider reservations and isolates idempotency and budgets by Tenant', async () => {
    const session = await signIn(app);
    const createScope = async (suffix: string) => {
      const tenantResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants',
        headers: {
          cookie: `__Host-aeo_session=${session}`,
          origin: 'https://app.example.test',
        },
        payload: {
          tenantName: `Provider Race ${suffix}`,
          workspaceName: `Provider Race Workspace ${suffix}`,
        },
      });
      const scope = tenantResponse.json<{
        data: { tenant: { id: string }; workspace: { id: string } };
      }>().data;
      const profileResponse = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles`,
        headers: {
          cookie: `__Host-aeo_session=${session}`,
          origin: 'https://app.example.test',
        },
        payload: {
          displayName: `Provider race profile ${suffix}`,
          targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
        },
      });
      const profileId = profileResponse.json<{ data: { profile: { profileId: string } } }>().data
        .profile.profileId;
      const budgetBase = `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`;
      for (const [url, limitUnits] of [
        [budgetBase, 100],
        [`${budgetBase}/tenant`, 100],
        [`${budgetBase}/providers/shared-neutral-provider`, 10],
        [`${budgetBase}/providers/alternate-neutral-provider`, 100],
      ] as const) {
        const response = await app.inject({
          method: 'PUT',
          url,
          headers: {
            cookie: `__Host-aeo_session=${session}`,
            origin: 'https://app.example.test',
          },
          payload: { limitUnits },
        });
        expect(response.statusCode, response.body).toBe(200);
      }
      const context = await new PostgresTenancyStore(pool).resolveTenantContext({
        actorSubject: 'jobs-owner-subject',
        tenantId: scope.tenant.id,
        workspaceId: scope.workspace.id,
      });
      if (context === null) throw new Error('PROVIDER_RACE_CONTEXT_MISSING');
      return { scope, profileId, context };
    };
    const first = await createScope('A');
    const second = await createScope('B');
    const store = new PostgresJobBudgetStore(pool);
    const submit = (
      fixture: Awaited<ReturnType<typeof createScope>>,
      idempotencyKey: string,
      providerKey: string,
    ) =>
      store.submitJob({
        context: fixture.context,
        jobId: randomUUID(),
        jobType: 'PROFILE_READINESS',
        aggregateId: fixture.profileId,
        idempotencyKey,
        estimatedUnits: 10,
        providerKey,
        reservationId: randomUUID(),
        budgetAlertId: randomUUID(),
        outboxMessageId: randomUUID(),
        auditEventId: randomUUID(),
      });

    const raced = await Promise.all([
      submit(first, 'provider-race-a-1', 'shared-neutral-provider'),
      submit(first, 'provider-race-a-2', 'shared-neutral-provider'),
    ]);
    expect(raced.map((job) => job?.status).sort()).toEqual(['BUDGET_BLOCKED', 'QUEUED']);
    expect(
      raced.filter((job) => job?.status === 'QUEUED').map((job) => job?.budgetWarning),
    ).toEqual([true]);

    const queued = raced.find((job) => job?.status === 'QUEUED');
    if (queued === undefined || queued === null) throw new Error('PROVIDER_RACE_WINNER_MISSING');
    const replay = await store.submitJob({
      context: first.context,
      jobId: randomUUID(),
      jobType: queued.jobType,
      aggregateId: queued.aggregateId,
      idempotencyKey: queued.id === raced[0]?.id ? 'provider-race-a-1' : 'provider-race-a-2',
      estimatedUnits: queued.estimatedUnits,
      providerKey: queued.providerKey,
      reservationId: randomUUID(),
      budgetAlertId: randomUUID(),
      outboxMessageId: randomUUID(),
      auditEventId: randomUUID(),
    });
    expect(replay?.id).toBe(queued.id);
    await expect(
      store.submitJob({
        context: first.context,
        jobId: randomUUID(),
        jobType: queued.jobType,
        aggregateId: queued.aggregateId,
        idempotencyKey: queued.id === raced[0]?.id ? 'provider-race-a-1' : 'provider-race-a-2',
        estimatedUnits: queued.estimatedUnits,
        providerKey: 'alternate-neutral-provider',
        reservationId: randomUUID(),
        budgetAlertId: randomUUID(),
        outboxMessageId: randomUUID(),
        auditEventId: randomUUID(),
      }),
    ).resolves.toBeNull();

    await expect(
      submit(second, 'provider-race-b-1', 'shared-neutral-provider'),
    ).resolves.toMatchObject({
      status: 'QUEUED',
      providerKey: 'shared-neutral-provider',
    });
    await expect(
      submit(
        { ...second, context: first.context },
        'cross-tenant-aggregate',
        'shared-neutral-provider',
      ),
    ).resolves.toBeNull();

    const policies = await pool.query<{ tenant_id: string; limit_units: string }>(
      `SELECT tenant_id, limit_units::text
       FROM provider_budget_policies
       WHERE provider_key = 'shared-neutral-provider'
         AND tenant_id IN ($1, $2)
       ORDER BY tenant_id`,
      [first.scope.tenant.id, second.scope.tenant.id],
    );
    expect(policies.rows).toHaveLength(2);
    expect(policies.rows.every((policy) => policy.limit_units === '10')).toBe(true);
    await pool.query(
      'UPDATE outbox_messages SET published_at = now() WHERE tenant_id IN ($1, $2)',
      [first.scope.tenant.id, second.scope.tenant.id],
    );
  });

  test('persists deduplicated Tenant Owner alerts when an Editor crosses a Provider warning', async () => {
    const ownerSession = await signIn(app);
    const tenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Owner Alert Tenant', workspaceName: 'Owner Alert Workspace' },
    });
    const scope = tenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const profileResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: {
        displayName: 'Owner alert profile',
        targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
      },
    });
    const profileId = profileResponse.json<{ data: { profile: { profileId: string } } }>().data
      .profile.profileId;
    const budgetBase = `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`;
    for (const [url, limitUnits] of [
      [budgetBase, 1_000],
      [`${budgetBase}/tenant`, 1_000],
      [`${budgetBase}/providers/neutral-alert-provider`, 100],
    ] as const) {
      const response = await app.inject({
        method: 'PUT',
        url,
        headers: {
          cookie: `__Host-aeo_session=${ownerSession}`,
          origin: 'https://app.example.test',
        },
        payload: { limitUnits },
      });
      expect(response.statusCode, response.body).toBe(200);
    }

    const invitationResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/invitations`,
      headers: {
        cookie: `__Host-aeo_session=${ownerSession}`,
        origin: 'https://app.example.test',
      },
      payload: { email: 'jobs-editor@example.test', role: 'EDITOR' },
    });
    expect(invitationResponse.statusCode, invitationResponse.body).toBe(201);
    const membershipId = invitationResponse.json<{
      data: { membership: { id: string } };
    }>().data.membership.id;
    const editorSession = await signIn(app, 'jobs-editor-code');
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/memberships/${membershipId}/accept`,
      headers: {
        cookie: `__Host-aeo_session=${editorSession}`,
        origin: 'https://app.example.test',
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);

    const context = await new PostgresTenancyStore(pool).resolveTenantContext({
      actorSubject: 'jobs-editor-subject',
      tenantId: scope.tenant.id,
      workspaceId: scope.workspace.id,
    });
    if (context === null) throw new Error('OWNER_ALERT_EDITOR_CONTEXT_MISSING');
    const store = new PostgresJobBudgetStore(pool);
    const submit = (index: number) =>
      store.submitJob({
        context,
        jobId: randomUUID(),
        jobType: 'PROFILE_READINESS',
        aggregateId: profileId,
        idempotencyKey: `owner-alert-provider-${index}`,
        estimatedUnits: 10,
        providerKey: 'neutral-alert-provider',
        reservationId: randomUUID(),
        budgetAlertId: randomUUID(),
        outboxMessageId: randomUUID(),
        auditEventId: randomUUID(),
      });
    for (let index = 1; index <= 8; index += 1) {
      await expect(submit(index)).resolves.toMatchObject({
        status: 'QUEUED',
        budgetWarning: index === 8,
      });
    }

    const ownerAlerts = await app.inject({
      method: 'GET',
      url: `${budgetBase}/alerts`,
      headers: { cookie: `__Host-aeo_session=${ownerSession}` },
    });
    expect(ownerAlerts.statusCode, ownerAlerts.body).toBe(200);
    expect(ownerAlerts.json()).toMatchObject({
      data: {
        alerts: [
          {
            audience: 'TENANT_OWNER',
            budgetScope: 'PROVIDER',
            providerKey: 'neutral-alert-provider',
            sourceWorkspaceId: scope.workspace.id,
            thresholdPercent: 80,
          },
        ],
      },
    });

    const editorAlerts = await app.inject({
      method: 'GET',
      url: `${budgetBase}/alerts`,
      headers: { cookie: `__Host-aeo_session=${editorSession}` },
    });
    expect(editorAlerts.statusCode).toBe(403);
    await expect(submit(9)).resolves.toMatchObject({ status: 'QUEUED', budgetWarning: true });
    const deduplicated = await app.inject({
      method: 'GET',
      url: `${budgetBase}/alerts`,
      headers: { cookie: `__Host-aeo_session=${ownerSession}` },
    });
    expect(deduplicated.json()).toMatchObject({ data: { alerts: [expect.any(Object)] } });

    const recipients = await pool.query<{
      audience: string;
      recipient_email: string;
    }>(
      `SELECT recipient.audience, user_account.email AS recipient_email
       FROM tenant_owner_budget_alert_recipients recipient
       JOIN users user_account ON user_account.id = recipient.recipient_user_id
       WHERE recipient.tenant_id = $1`,
      [scope.tenant.id],
    );
    expect(recipients.rows).toEqual([
      { audience: 'TENANT_OWNER', recipient_email: 'jobs-owner@example.test' },
    ]);
    await pool.query('UPDATE outbox_messages SET published_at = now() WHERE tenant_id = $1', [
      scope.tenant.id,
    ]);
  });

  test('runs a load-compatible PROFILE_READINESS message to SUCCEEDED on the generation worker', async () => {
    const session = await signIn(app);
    const tenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Load Runtime Tenant', workspaceName: 'Load Runtime Workspace' },
    });
    const scope = tenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const profileResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        displayName: 'Industry-neutral load profile',
        description: 'A product profile used by the Task 18 production workload contract.',
        digitalAssets: [{ label: 'Website', url: 'https://example.test/' }],
        targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
      },
    });
    const profileId = profileResponse.json<{ data: { profile: { profileId: string } } }>().data
      .profile.profileId;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { limitUnits: 100 },
    });
    const submitted = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        jobType: 'PROFILE_READINESS',
        aggregateId: profileId,
        idempotencyKey: `task18-load-readiness-${profileId}`,
        estimatedUnits: 10,
      },
    });
    expect(submitted.statusCode).toBe(202);
    const jobId = submitted.json<{ data: { job: { id: string } } }>().data.job.id;
    const outbox = await pool.query<{ id: string; payload: JobQueueMessage['payload'] }>(
      `SELECT id, payload
       FROM outbox_messages
       WHERE tenant_id = $1 AND workspace_id = $2 AND aggregate_id = $3`,
      [scope.tenant.id, scope.workspace.id, jobId],
    );
    const delivery = outbox.rows[0];
    if (delivery === undefined) throw new Error('PROFILE_READINESS_DELIVERY_MISSING');
    const clock = { now: () => new Date() };
    const executionStore = new PostgresJobBudgetStore(pool);
    const worker = new ProfileReadinessJobWorker(
      new JobWorkerCoordinator(
        executionStore,
        clock,
        { next: randomUUID },
        'generation-workload-v1',
      ),
      new PostgresProfileOfferingStore(pool),
      new ProfileReadinessHandler(),
    );

    await expect(
      worker.process({ messageId: delivery.id, payload: delivery.payload }),
    ).resolves.toEqual({ outcome: 'SUCCEEDED' });
    await executionStore.markOutboxPublished(delivery.id, scope.tenant.id, clock.now());
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs/${jobId}`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      data: {
        job: {
          status: 'SUCCEEDED',
          progress: 100,
          result: {
            readinessPercent: 100,
            profileRevision: 1,
          },
        },
      },
    });
  });

  test('propagates one HTTP trace through the outbox and SQS attributes into Worker processing', async () => {
    const requestId = '018f84b3-7eb8-7c75-9ca5-25278969d3ef';
    const session = await signIn(app);
    const tenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Trace Tenant', workspaceName: 'Trace Workspace' },
    });
    const scope = tenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const profileResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        displayName: 'Trace Profile',
        targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
      },
    });
    const profileId = profileResponse.json<{ data: { profile: { profileId: string } } }>().data
      .profile.profileId;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { limitUnits: 100 },
    });

    const submitted = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
        traceparent: propagatedTraceparent,
        'x-request-id': requestId,
      },
      payload: {
        jobType: 'PROFILE_READINESS',
        aggregateId: profileId,
        idempotencyKey: 'trace-propagation',
        estimatedUnits: 10,
      },
    });
    expect(submitted.statusCode, submitted.body).toBe(202);
    const jobId = submitted.json<{ data: { job: { id: string } } }>().data.job.id;

    const persisted = await pool.query<{ traceparent: string; request_id: string }>(
      `SELECT traceparent, request_id::text
       FROM outbox_messages
       WHERE aggregate_id = $1`,
      [jobId],
    );
    expect(persisted.rows[0]).toEqual({
      traceparent: propagatedTraceparent,
      request_id: requestId,
    });
    await expect(
      pool.query('UPDATE outbox_messages SET traceparent = NULL WHERE aggregate_id = $1', [jobId]),
    ).rejects.toThrow(/outbox_messages_trace_context_pair/u);
    const payload = await pool.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM outbox_messages WHERE aggregate_id = $1',
      [jobId],
    );
    expect(payload.rows[0]?.payload).not.toHaveProperty('traceparent');
    expect(payload.rows[0]?.payload).not.toHaveProperty('requestId');

    let sent:
      | {
          QueueUrl: string;
          MessageBody: string;
          MessageAttributes?: Record<string, { DataType: string; StringValue?: string }>;
        }
      | undefined;
    const sqsApi = {
      sendMessage: (input: NonNullable<typeof sent>) => {
        sent = input;
        return Promise.resolve({ MessageId: 'aws-trace-message' });
      },
      receiveMessage: () =>
        Promise.resolve({
          Messages:
            sent === undefined
              ? []
              : [
                  {
                    MessageId: 'aws-trace-message',
                    ReceiptHandle: 'opaque-trace-receipt',
                    Body: sent.MessageBody,
                    MessageAttributes: sent.MessageAttributes,
                  },
                ],
        }),
      deleteMessage: () => Promise.resolve({}),
      changeMessageVisibility: () => Promise.resolve({}),
    };
    const queueUrl = 'https://sqs.ap-southeast-1.amazonaws.com/123456789012/aeostudio-trace-jobs';
    const producer = new AwsSqsJobQueue(sqsApi, { queueUrl });
    const traceRuns: Array<{ operation: string; traceContext: unknown }> = [];
    let activeTraceContext: unknown;
    const traceRunner = {
      async run<T>(
        input: { operation: string; traceContext: unknown },
        operation: () => Promise<T>,
      ): Promise<T> {
        traceRuns.push(input);
        const previous = activeTraceContext;
        activeTraceContext = input.traceContext;
        try {
          return await operation();
        } finally {
          activeTraceContext = previous;
        }
      },
    };
    const executionStore = new PostgresJobBudgetStore(pool);
    const relay = new OutboxRelay(
      executionStore,
      producer,
      new FakeClock(new Date('2026-07-21T00:00:00.000Z')),
      traceRunner,
    );
    expect(await relay.relay()).toBe(1);
    const queuedMessage = readInboundJobMessage(JSON.parse(sent?.MessageBody ?? '{}') as unknown);
    expect(queuedMessage.messageId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(queuedMessage.payload).toEqual({
      jobId,
      tenantId: scope.tenant.id,
      workspaceId: scope.workspace.id,
      schemaVersion: '1.0.0',
    });
    expect(sent?.MessageAttributes).toEqual({
      traceparent: { DataType: 'String', StringValue: propagatedTraceparent },
      request_id: { DataType: 'String', StringValue: requestId },
    });

    const consumer = new AwsSqsJobQueueConsumer(sqsApi, {
      queueUrl,
      visibilityTimeoutSeconds: 60,
      waitTimeSeconds: 20,
    });
    const delivery = await consumer.receive();
    expect(delivery?.traceContext).toEqual({ traceparent: propagatedTraceparent, requestId });
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const runtime = createMeasurementWorkerRuntime({
      queue: { receive: () => Promise.resolve(delivery) },
      processor: {
        process: () => {
          expect(activeTraceContext).toEqual({ traceparent: propagatedTraceparent, requestId });
          return Promise.resolve({ outcome: 'SUCCEEDED' as const });
        },
      },
      traceRunner,
      pollIntervalMs: 1,
      logger,
    });
    await runtime.runOnce();

    expect(traceRuns.map((run) => run.operation)).toEqual(['OUTBOX_RELAY', 'WORKER_PROCESS']);
    expect(logger.info).toHaveBeenCalledWith(
      'WORKER_JOB_RECEIVED',
      expect.objectContaining({
        correlation: {
          jobId,
          requestId,
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        },
      }),
    );
  });

  test('concurrent cross-type claims share one tenant-scoped five-job semaphore', async () => {
    const session = await signIn(app);
    const tenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        tenantName: 'Concurrent Claim Tenant',
        workspaceName: 'Concurrent Claim Workspace',
      },
    });
    expect(tenantResponse.statusCode, tenantResponse.body).toBe(201);
    const scope = tenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const owner = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'jobs-owner@example.test'`,
    );
    const ownerId = owner.rows[0]?.id;
    if (ownerId === undefined) throw new Error('CONCURRENT_CLAIM_OWNER_NOT_FOUND');

    const now = new Date();
    const activeLeaseExpiresAt = new Date(now.getTime() + 60_000).toISOString();
    const activeJobs = (
      ['PROFILE_READINESS', 'SITE_CRAWL', 'CONTENT_PLAN', 'ARTIFACT_GENERATION'] as const
    ).map((jobType, index) => ({
      id: randomUUID(),
      aggregate_id: randomUUID(),
      job_type: jobType,
      status: 'RUNNING',
      attempt: 1,
      idempotency_key: `claim-active-${index}-${randomUUID()}`,
      lease_token: randomUUID(),
      lease_expires_at: activeLeaseExpiresAt,
    }));
    const targets = [
      {
        id: randomUUID(),
        aggregate_id: randomUUID(),
        job_type: 'MEASUREMENT',
        status: 'QUEUED',
        attempt: 0,
        idempotency_key: `claim-measurement-${randomUUID()}`,
        lease_token: null,
        lease_expires_at: null,
        barrierKey: 1,
      },
      {
        id: randomUUID(),
        aggregate_id: randomUUID(),
        job_type: 'PROFILE_READINESS',
        status: 'QUEUED',
        attempt: 0,
        idempotency_key: `claim-readiness-${randomUUID()}`,
        lease_token: null,
        lease_expires_at: null,
        barrierKey: 2,
      },
    ] as const;
    await pool.query(
      `INSERT INTO jobs
        (id, tenant_id, workspace_id, job_type, aggregate_id, status, attempt,
          idempotency_key, estimated_units, requested_by_user_id, lease_token, lease_expires_at)
       SELECT fixture.id, $1, $2, fixture.job_type, fixture.aggregate_id, fixture.status,
         fixture.attempt, fixture.idempotency_key, 1, $3, fixture.lease_token,
         fixture.lease_expires_at
       FROM jsonb_to_recordset($4::jsonb) AS fixture(
         id uuid, aggregate_id uuid, job_type text, status text, attempt integer,
         idempotency_key text, lease_token uuid, lease_expires_at timestamptz
       )`,
      [scope.tenant.id, scope.workspace.id, ownerId, JSON.stringify([...activeJobs, ...targets])],
    );
    await pool.query(`
      CREATE TABLE task04_claim_barriers (
        job_id uuid PRIMARY KEY,
        barrier_key integer NOT NULL
      );
      GRANT SELECT ON task04_claim_barriers TO aeostudio_runtime;
      INSERT INTO task04_claim_barriers (job_id, barrier_key)
      VALUES ('${targets[0].id}', ${targets[0].barrierKey}),
        ('${targets[1].id}', ${targets[1].barrierKey});
      CREATE FUNCTION task04_wait_before_claim_update() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      DECLARE
        selected_barrier_key integer;
      BEGIN
        SELECT barrier_key INTO selected_barrier_key
        FROM task04_claim_barriers
        WHERE job_id = NEW.id;
        IF selected_barrier_key IS NOT NULL
           AND OLD.status <> 'RUNNING' AND NEW.status = 'RUNNING' THEN
          PERFORM pg_advisory_xact_lock(${claimBarrierNamespace}, selected_barrier_key);
        END IF;
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER task04_claim_update_barrier
      BEFORE UPDATE OF status ON jobs
      FOR EACH ROW EXECUTE FUNCTION task04_wait_before_claim_update();
    `);

    const executionStore = new PostgresJobBudgetStore(pool);
    const barrierHolders = [await pool.connect(), await pool.connect()];
    const claimPromises: Array<ReturnType<PostgresJobBudgetStore['claimJob']>> = [];
    let barriersHeld = false;
    try {
      await Promise.all(
        barrierHolders.map((holder, index) =>
          holder.query('SELECT pg_advisory_lock($1, $2)', [claimBarrierNamespace, index + 1]),
        ),
      );
      barriersHeld = true;
      const claimTarget = (
        claimScope: { tenant: { id: string }; workspace: { id: string } },
        jobId: string,
      ) =>
        executionStore.claimJob({
          message: {
            messageId: randomUUID(),
            payload: {
              jobId,
              tenantId: claimScope.tenant.id,
              workspaceId: claimScope.workspace.id,
              schemaVersion: '1.0.0',
            },
          },
          consumer: 'task04-tenant-semaphore-v1',
          inboxId: randomUUID(),
          leaseToken: randomUUID(),
          eventId: randomUUID(),
          now,
          leaseDurationMs: 30_000,
        });

      claimPromises.push(claimTarget(scope, targets[0].id));
      expect(await waitForClaimBarrier(pool, targets[0].barrierKey, 5_000)).toBe(true);
      claimPromises.push(
        claimTarget(
          {
            tenant: { id: scope.tenant.id.toUpperCase() },
            workspace: scope.workspace,
          },
          targets[1].id,
        ),
      );
      await waitForClaimBarrier(pool, targets[1].barrierKey, 2_000);
      await Promise.all(
        barrierHolders.map((holder, index) =>
          holder.query('SELECT pg_advisory_unlock($1, $2)', [claimBarrierNamespace, index + 1]),
        ),
      );
      barriersHeld = false;

      const claims = await Promise.all(claimPromises);
      const active = await pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM jobs
         WHERE tenant_id = $1 AND status = 'RUNNING' AND lease_expires_at >= $2`,
        [scope.tenant.id, now],
      );
      expect({
        outcomes: claims.map((claim) => claim.outcome).sort(),
        active: active.rows[0]?.count,
      }).toEqual({
        outcomes: ['CLAIMED', 'CONCURRENCY_LIMIT'],
        active: 5,
      });

      const limitedTarget =
        targets[claims.findIndex((claim) => claim.outcome === 'CONCURRENCY_LIMIT')];
      if (limitedTarget === undefined) throw new Error('CONCURRENCY_LIMIT_TARGET_NOT_FOUND');
      await pool.query('UPDATE jobs SET lease_expires_at = $1 WHERE id = $2', [
        new Date(now.getTime() - 1_000),
        activeJobs[0]?.id,
      ]);
      const otherTenantResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants',
        headers: {
          cookie: `__Host-aeo_session=${session}`,
          origin: 'https://app.example.test',
        },
        payload: {
          tenantName: 'Independent Claim Tenant',
          workspaceName: 'Independent Claim Workspace',
        },
      });
      expect(otherTenantResponse.statusCode, otherTenantResponse.body).toBe(201);
      const otherScope = otherTenantResponse.json<{
        data: { tenant: { id: string }; workspace: { id: string } };
      }>().data;
      const otherJobId = randomUUID();
      await pool.query(
        `INSERT INTO jobs
          (id, tenant_id, workspace_id, job_type, aggregate_id, status, idempotency_key,
            estimated_units, requested_by_user_id)
         VALUES ($1, $2, $3, 'MEASUREMENT', $4, 'QUEUED', $5, 1, $6)`,
        [
          otherJobId,
          otherScope.tenant.id,
          otherScope.workspace.id,
          randomUUID(),
          `claim-independent-${randomUUID()}`,
          ownerId,
        ],
      );
      const limitedBarrierHolder = barrierHolders[limitedTarget.barrierKey - 1];
      if (limitedBarrierHolder === undefined) throw new Error('LIMITED_BARRIER_HOLDER_NOT_FOUND');
      await limitedBarrierHolder.query('SELECT pg_advisory_lock($1, $2)', [
        claimBarrierNamespace,
        limitedTarget.barrierKey,
      ]);
      barriersHeld = true;
      const blockedTenantClaim = claimTarget(scope, limitedTarget.id);
      claimPromises.push(blockedTenantClaim);
      expect(await waitForClaimBarrier(pool, limitedTarget.barrierKey, 5_000)).toBe(true);
      const independentTenantClaim = claimTarget(otherScope, otherJobId);
      claimPromises.push(independentTenantClaim);
      let independentTimeout: ReturnType<typeof setTimeout> | undefined;
      const independentResult = await Promise.race([
        independentTenantClaim,
        new Promise<never>((_resolve, reject) => {
          independentTimeout = setTimeout(
            () => reject(new Error('CROSS_TENANT_CLAIM_WAS_BLOCKED')),
            2_000,
          );
        }),
      ]).finally(() => clearTimeout(independentTimeout));
      expect(independentResult.outcome).toBe('CLAIMED');
      await limitedBarrierHolder.query('SELECT pg_advisory_unlock($1, $2)', [
        claimBarrierNamespace,
        limitedTarget.barrierKey,
      ]);
      barriersHeld = false;
      await expect(blockedTenantClaim).resolves.toMatchObject({ outcome: 'CLAIMED' });
    } finally {
      if (barriersHeld) {
        await Promise.all(
          barrierHolders.map((holder, index) =>
            holder.query('SELECT pg_advisory_unlock($1, $2)', [claimBarrierNamespace, index + 1]),
          ),
        );
      }
      await Promise.allSettled(claimPromises);
      barrierHolders.forEach((holder) => holder.release());
      await pool.query(`
        DROP TRIGGER task04_claim_update_barrier ON jobs;
        DROP FUNCTION task04_wait_before_claim_update();
        DROP TABLE task04_claim_barriers;
      `);
    }
  });

  test('redelivery settles once and an expired lease rejects stale Worker completion', async () => {
    const session = await signIn(app);
    const tenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Worker Tenant', workspaceName: 'Worker Workspace' },
    });
    const scope = tenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const profileResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        displayName: 'Worker Profile',
        targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
      },
    });
    const profileId = profileResponse.json<{ data: { profile: { profileId: string } } }>().data
      .profile.profileId;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { limitUnits: 100 },
    });
    const submitted = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        jobType: 'PROFILE_READINESS',
        aggregateId: profileId,
        idempotencyKey: 'worker-readiness',
        estimatedUnits: 10,
      },
    });
    const jobId = submitted.json<{ data: { job: { id: string } } }>().data.job.id;

    const executionStore = new PostgresJobBudgetStore(pool);
    const queue = new FakeJobQueue();
    const clock = new FakeClock(new Date('2026-07-20T00:00:00.000Z'));
    const relay = new OutboxRelay(executionStore, queue, clock);
    const worker = new JobWorkerCoordinator(executionStore, clock, { next: randomUUID });

    const pending = await executionStore.listPendingOutbox(1);
    expect(pending[0]?.jobType).toBe('PROFILE_READINESS');
    expect(await relay.relay()).toBe(1);
    const message = queue.receive();
    expect(message?.payload).toEqual({
      jobId,
      tenantId: scope.tenant.id,
      workspaceId: scope.workspace.id,
      schemaVersion: '1.0.0',
    });
    if (message === undefined) {
      throw new Error('QUEUE_MESSAGE_MISSING');
    }

    const firstClaim = await worker.claim(message);
    expect(firstClaim.outcome).toBe('CLAIMED');
    if (firstClaim.outcome !== 'CLAIMED') {
      throw new Error('FIRST_LEASE_MISSING');
    }
    expect(JobWorkerCoordinator.heartbeatIntervalMs).toBeLessThanOrEqual(15_000);
    expect(await worker.reportProgress(firstClaim.lease, 50)).toBe(true);
    clock.advance(15_000);
    expect(await worker.heartbeat(firstClaim.lease)).toBe(true);
    const observableHeartbeat = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs/${jobId}`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(observableHeartbeat.statusCode).toBe(200);
    expect(observableHeartbeat.json()).toMatchObject({
      data: { job: { heartbeatAt: '2026-07-20T00:00:15.000Z', progress: 50 } },
    });

    clock.advance(31_000);
    const replacementClaim = await worker.claim(message);
    expect(replacementClaim.outcome).toBe('CLAIMED');
    if (replacementClaim.outcome !== 'CLAIMED') {
      throw new Error('REPLACEMENT_LEASE_MISSING');
    }
    expect(await worker.reportProgress(firstClaim.lease, 75)).toBe(false);
    expect(await worker.complete(firstClaim.lease, { readinessPercent: 75 }, 7)).toBe(false);
    expect(await worker.complete(replacementClaim.lease, { readinessPercent: 75 }, 7)).toBe(true);

    queue.redeliver(message);
    const replayed = queue.receive();
    if (replayed === undefined) {
      throw new Error('REDELIVERED_MESSAGE_MISSING');
    }
    expect((await worker.claim(replayed)).outcome).toBe('DUPLICATE');
    const settlement = await pool.query<{ usage_count: string; units: number; status: string }>(
      `SELECT
        (SELECT count(*) FROM usage_ledger WHERE job_id = $1)::text AS usage_count,
        (SELECT units::integer FROM usage_ledger WHERE job_id = $1) AS units,
        (SELECT status FROM jobs WHERE id = $1) AS status`,
      [jobId],
    );
    expect(settlement.rows[0]).toEqual({ usage_count: '1', units: 7, status: 'SUCCEEDED' });

    for (let index = 1; index <= 6; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs`,
        headers: {
          cookie: `__Host-aeo_session=${session}`,
          origin: 'https://app.example.test',
        },
        payload: {
          jobType: 'PROFILE_READINESS',
          aggregateId: profileId,
          idempotencyKey: `concurrency-${index}`,
          estimatedUnits: 10,
        },
      });
      expect(response.statusCode).toBe(202);
    }
    expect(await relay.relay()).toBe(6);
    const concurrencyOutcomes: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const concurrentMessage = queue.receive();
      if (concurrentMessage === undefined) {
        throw new Error('CONCURRENCY_MESSAGE_MISSING');
      }
      concurrencyOutcomes.push((await worker.claim(concurrentMessage)).outcome);
    }
    expect(concurrencyOutcomes).toEqual([
      'CLAIMED',
      'CLAIMED',
      'CLAIMED',
      'CLAIMED',
      'CLAIMED',
      'CONCURRENCY_LIMIT',
    ]);
    const queuedAfterLimit = await pool.query<{ queued: string; running: string }>(
      `SELECT
        count(*) FILTER (WHERE status = 'QUEUED')::text AS queued,
        count(*) FILTER (WHERE status = 'RUNNING')::text AS running
       FROM jobs
       WHERE tenant_id = $1 AND idempotency_key LIKE 'concurrency-%'`,
      [scope.tenant.id],
    );
    expect(queuedAfterLimit.rows[0]).toEqual({ queued: '1', running: '5' });
  });

  test('retryable failure, terminal failure and cancellation remain distinct', async () => {
    const session = await signIn(app);
    const tenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Failure Tenant', workspaceName: 'Failure Workspace' },
    });
    const scope = tenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const profileResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        displayName: 'Failure Profile',
        targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
      },
    });
    const profileId = profileResponse.json<{ data: { profile: { profileId: string } } }>().data
      .profile.profileId;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { limitUnits: 100 },
    });
    const retrySubmission = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        jobType: 'PROFILE_READINESS',
        aggregateId: profileId,
        idempotencyKey: 'retryable-job',
        estimatedUnits: 10,
      },
    });
    expect(retrySubmission.statusCode).toBe(202);

    const executionStore = new PostgresJobBudgetStore(pool);
    const queue = new FakeJobQueue();
    const clock = new FakeClock(new Date('2026-07-20T01:00:00.000Z'));
    const relay = new OutboxRelay(executionStore, queue, clock);
    const worker = new JobWorkerCoordinator(executionStore, clock, { next: randomUUID });
    expect(await relay.relay()).toBe(1);
    const message = queue.receive();
    if (message === undefined) {
      throw new Error('RETRY_MESSAGE_MISSING');
    }
    const firstClaim = await worker.claim(message);
    if (firstClaim.outcome !== 'CLAIMED') {
      throw new Error('RETRY_LEASE_MISSING');
    }
    expect(await worker.fail(firstClaim.lease, 'RETRYABLE', 'TRANSIENT_FIXTURE')).toBe(
      'RETRY_WAIT',
    );
    expect((await worker.claim(message)).outcome).toBe('BUSY');
    clock.advance(31_000);
    const retryClaim = await worker.claim(message);
    if (retryClaim.outcome !== 'CLAIMED') {
      throw new Error('SECOND_RETRY_LEASE_MISSING');
    }
    expect(await worker.fail(retryClaim.lease, 'TERMINAL', 'INVALID_FIXTURE')).toBe(
      'FAILED_TERMINAL',
    );

    const cancelSubmission = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        jobType: 'PROFILE_READINESS',
        aggregateId: profileId,
        idempotencyKey: 'cancelled-job',
        estimatedUnits: 10,
      },
    });
    const cancelJobId = cancelSubmission.json<{ data: { job: { id: string } } }>().data.job.id;
    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs/${cancelJobId}`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ data: { job: { status: 'CANCELLED' } } });
    const terminalStates = await pool.query<{
      key: string;
      status: string;
      reservation_status: string;
    }>(
      `SELECT job.idempotency_key AS key, job.status,
         reservation.status AS reservation_status
       FROM jobs job
       JOIN budget_reservations reservation ON reservation.job_id = job.id
       WHERE job.tenant_id = $1
       ORDER BY job.idempotency_key`,
      [scope.tenant.id],
    );
    expect(terminalStates.rows).toEqual([
      { key: 'cancelled-job', status: 'CANCELLED', reservation_status: 'RELEASED' },
      {
        key: 'retryable-job',
        status: 'FAILED_TERMINAL',
        reservation_status: 'RELEASED',
      },
    ]);
  });

  test('a committed tenant deletion freeze rejects stale submissions and queue deliveries', async () => {
    const session = await signIn(app);
    const tenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Frozen Job Tenant', workspaceName: 'Frozen Job Workspace' },
    });
    const scope = tenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const profileResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        displayName: 'Frozen Job Profile',
        targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
      },
    });
    const profileId = profileResponse.json<{ data: { profile: { profileId: string } } }>().data
      .profile.profileId;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { limitUnits: 100 },
    });
    const actor = await pool.query<{ user_id: string; membership_id: string }>(
      `SELECT identity.user_id, membership.id AS membership_id
       FROM external_identities identity
       JOIN memberships membership ON membership.user_id = identity.user_id
       WHERE identity.subject = 'jobs-owner-subject' AND membership.tenant_id = $1`,
      [scope.tenant.id],
    );
    const owner = actor.rows[0];
    if (owner === undefined) throw new Error('FROZEN_JOB_OWNER_NOT_FOUND');
    await pool.query(`SELECT * FROM request_tenant_deletion($1, $2, $3, $4, $5, $6, $7, $8)`, [
      'jobs-owner-subject',
      scope.tenant.id,
      scope.workspace.id,
      randomUUID(),
      'Task 17 worker lifecycle fence fixture',
      '7'.repeat(64),
      new Date(),
      randomUUID(),
    ]);

    const executionStore = new PostgresJobBudgetStore(pool);
    const jobId = randomUUID();
    const submitted = await executionStore.submitJob({
      context: {
        tenantId: scope.tenant.id,
        workspaceId: scope.workspace.id,
        actorUserId: owner.user_id,
        membershipId: owner.membership_id,
        role: 'OWNER',
      },
      jobId,
      jobType: 'PROFILE_READINESS',
      aggregateId: profileId,
      idempotencyKey: `frozen-job-${jobId}`,
      estimatedUnits: 10,
      reservationId: randomUUID(),
      budgetAlertId: randomUUID(),
      outboxMessageId: randomUUID(),
      auditEventId: randomUUID(),
    });

    expect(submitted).toBeNull();
    const sideEffects = await pool.query<{ jobs: string; outbox: string }>(
      `SELECT
         (SELECT count(*)::text FROM jobs WHERE id = $1) AS jobs,
         (SELECT count(*)::text FROM outbox_messages WHERE aggregate_id = $1) AS outbox`,
      [jobId],
    );
    expect(sideEffects.rows[0]).toEqual({ jobs: '0', outbox: '0' });

    const staleJobId = randomUUID();
    const staleMessageId = randomUUID();
    await pool.query(
      `INSERT INTO jobs
        (id, tenant_id, workspace_id, job_type, aggregate_id, status, idempotency_key,
          estimated_units, requested_by_user_id)
       VALUES ($1, $2, $3, 'PROFILE_READINESS', $4, 'QUEUED', $5, 10, $6)`,
      [
        staleJobId,
        scope.tenant.id,
        scope.workspace.id,
        profileId,
        `stale-delivery-${staleJobId}`,
        owner.user_id,
      ],
    );
    await pool.query(
      `INSERT INTO outbox_messages
        (id, tenant_id, workspace_id, aggregate_id, message_type, payload, published_at)
       VALUES ($1, $2, $3, $4, 'JOB_QUEUED', $5::jsonb, now())`,
      [
        staleMessageId,
        scope.tenant.id,
        scope.workspace.id,
        staleJobId,
        JSON.stringify({
          jobId: staleJobId,
          tenantId: scope.tenant.id,
          workspaceId: scope.workspace.id,
          schemaVersion: '1.0.0',
        }),
      ],
    );
    const worker = new JobWorkerCoordinator(
      executionStore,
      { now: () => new Date() },
      { next: randomUUID },
    );

    expect(
      await worker.claim({
        messageId: staleMessageId,
        payload: {
          jobId: staleJobId,
          tenantId: scope.tenant.id,
          workspaceId: scope.workspace.id,
          schemaVersion: '1.0.0',
        },
      }),
    ).toEqual({ outcome: 'NOT_AVAILABLE' });
    const staleState = await pool.query<{ status: string; attempt: number; inbox: string }>(
      `SELECT job.status, job.attempt,
         (SELECT count(*)::text FROM inbox_messages WHERE message_id = $2) AS inbox
       FROM jobs job WHERE job.id = $1`,
      [staleJobId, staleMessageId],
    );
    expect(staleState.rows[0]).toEqual({ status: 'QUEUED', attempt: 0, inbox: '0' });

    const staleLeaseToken = randomUUID();
    await pool.query(
      `UPDATE jobs
       SET status = 'RUNNING', attempt = 1, lease_token = $1,
         lease_expires_at = now() + interval '5 minutes', heartbeat_at = now()
       WHERE id = $2`,
      [staleLeaseToken, staleJobId],
    );
    const staleLease = {
      job: {
        id: staleJobId,
        tenantId: scope.tenant.id,
        workspaceId: scope.workspace.id,
        providerKey: null,
        jobType: 'PROFILE_READINESS' as const,
        aggregateId: profileId,
        status: 'RUNNING' as const,
        progress: 0,
        attempt: 1,
        maxAttempts: 3,
        budgetWarning: false,
        estimatedUnits: 10,
        heartbeatAt: new Date().toISOString(),
        result: null,
        errorCode: null,
      },
      leaseToken: staleLeaseToken,
      messageId: staleMessageId,
    };

    await expect(worker.heartbeat(staleLease)).resolves.toBe(false);
    await expect(worker.reportProgress(staleLease, 50)).resolves.toBe(false);
    await expect(worker.complete(staleLease, { shouldNotPersist: true }, 10)).resolves.toBe(false);
    await expect(worker.fail(staleLease, 'RETRYABLE', 'SHOULD_NOT_RETRY')).resolves.toBe(false);
    const leaseSideEffects = await pool.query<{
      status: string;
      progress: number;
      usage: string;
      events: string;
    }>(
      `SELECT job.status, job.progress,
         (SELECT count(*)::text FROM usage_ledger WHERE job_id = $1) AS usage,
         (SELECT count(*)::text FROM job_events WHERE job_id = $1) AS events
       FROM jobs job WHERE job.id = $1`,
      [staleJobId],
    );
    expect(leaseSideEffects.rows[0]).toEqual({
      status: 'RUNNING',
      progress: 0,
      usage: '0',
      events: '0',
    });

    const suppressedMessageId = randomUUID();
    await pool.query(
      `INSERT INTO outbox_messages
        (id, tenant_id, workspace_id, aggregate_id, message_type, payload,
          suppressed_at, suppression_reason)
       VALUES ($1, $2, $3, $4, 'JOB_QUEUED', $5::jsonb, now(),
         'TENANT_LIFECYCLE_FROZEN')`,
      [
        suppressedMessageId,
        scope.tenant.id,
        scope.workspace.id,
        staleJobId,
        JSON.stringify({
          jobId: staleJobId,
          tenantId: scope.tenant.id,
          workspaceId: scope.workspace.id,
          schemaVersion: '1.0.0',
        }),
      ],
    );
    await expect(
      executionStore.markOutboxPublished(suppressedMessageId, scope.tenant.id, new Date()),
    ).resolves.toBeUndefined();
    const suppressed = await pool.query<{ published_at: Date | null }>(
      'SELECT published_at FROM outbox_messages WHERE id = $1',
      [suppressedMessageId],
    );
    expect(suppressed.rows[0]?.published_at).toBeNull();
  });

  test('completion atomically tops up an underestimated reservation or fails closed', async () => {
    const session = await signIn(app);
    const tenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Top-up Tenant', workspaceName: 'Top-up Workspace' },
    });
    const scope = tenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const profileResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        displayName: 'Top-up Profile',
        targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
      },
    });
    const profileId = profileResponse.json<{ data: { profile: { profileId: string } } }>().data
      .profile.profileId;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { limitUnits: 20 },
    });

    const submit = async (idempotencyKey: string, estimatedUnits: number) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs`,
        headers: {
          cookie: `__Host-aeo_session=${session}`,
          origin: 'https://app.example.test',
        },
        payload: {
          jobType: 'PROFILE_READINESS',
          aggregateId: profileId,
          idempotencyKey,
          estimatedUnits,
        },
      });
      expect(response.statusCode).toBe(202);
      return response.json<{ data: { job: { id: string; status: string } } }>().data.job;
    };
    const messageFor = async (jobId: string): Promise<JobQueueMessage> => {
      const outbox = await pool.query<{ id: string }>(
        'SELECT id FROM outbox_messages WHERE aggregate_id = $1',
        [jobId],
      );
      const messageId = outbox.rows[0]?.id;
      if (messageId === undefined) throw new Error('TOP_UP_OUTBOX_MISSING');
      return {
        messageId,
        payload: {
          jobId,
          tenantId: scope.tenant.id,
          workspaceId: scope.workspace.id,
          schemaVersion: '1.0.0',
        },
      };
    };
    const executionStore = new PostgresJobBudgetStore(pool);
    const worker = new JobWorkerCoordinator(
      executionStore,
      { now: () => new Date() },
      { next: randomUUID },
    );

    const withinLimit = await submit('top-up-within-limit', 10);
    expect(withinLimit.status).toBe('QUEUED');
    const withinLimitClaim = await worker.claim(await messageFor(withinLimit.id));
    expect(withinLimitClaim.outcome).toBe('CLAIMED');
    if (withinLimitClaim.outcome !== 'CLAIMED') throw new Error('TOP_UP_LEASE_MISSING');
    await expect(
      worker.complete(withinLimitClaim.lease, { readinessPercent: 100 }, 15),
    ).resolves.toBe(true);
    const toppedUp = await pool.query<{
      job_status: string;
      reservation_status: string;
      estimated_units: number;
      actual_units: number;
      ledger_units: number;
    }>(
      `SELECT
         job.status AS job_status,
         reservation.status AS reservation_status,
         reservation.estimated_units::integer,
         reservation.actual_units::integer,
         ledger.units::integer AS ledger_units
       FROM jobs job
       JOIN budget_reservations reservation ON reservation.job_id = job.id
       JOIN usage_ledger ledger ON ledger.job_id = job.id
       WHERE job.id = $1`,
      [withinLimit.id],
    );
    expect(toppedUp.rows[0]).toEqual({
      job_status: 'SUCCEEDED',
      reservation_status: 'SETTLED',
      estimated_units: 15,
      actual_units: 15,
      ledger_units: 15,
    });

    const beyondLimit = await submit('top-up-beyond-limit', 5);
    expect(beyondLimit.status).toBe('QUEUED');
    const beyondLimitClaim = await worker.claim(await messageFor(beyondLimit.id));
    expect(beyondLimitClaim.outcome).toBe('CLAIMED');
    if (beyondLimitClaim.outcome !== 'CLAIMED') throw new Error('HARD_STOP_LEASE_MISSING');
    await expect(
      worker.complete(beyondLimitClaim.lease, { readinessPercent: 100 }, 6),
    ).resolves.toBe(false);
    const hardStop = await pool.query<{
      job_status: string;
      reservation_status: string;
      estimated_units: number;
      actual_units: number | null;
      usage_count: string;
    }>(
      `SELECT
         job.status AS job_status,
         reservation.status AS reservation_status,
         reservation.estimated_units::integer,
         reservation.actual_units::integer,
         (SELECT count(*)::text FROM usage_ledger ledger WHERE ledger.job_id = job.id)
           AS usage_count
       FROM jobs job
       JOIN budget_reservations reservation ON reservation.job_id = job.id
       WHERE job.id = $1`,
      [beyondLimit.id],
    );
    expect(hardStop.rows[0]).toEqual({
      job_status: 'RUNNING',
      reservation_status: 'RESERVED',
      estimated_units: 5,
      actual_units: null,
      usage_count: '0',
    });
  });

  test('a lifecycle-frozen job is unavailable even while its scope remains active', async () => {
    const session = await signIn(app);
    const tenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Frozen Lease Tenant', workspaceName: 'Frozen Lease Workspace' },
    });
    const scope = tenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const actor = await pool.query<{ user_id: string }>(
      `SELECT identity.user_id
       FROM external_identities identity
       JOIN memberships membership ON membership.user_id = identity.user_id
       WHERE identity.subject = 'jobs-owner-subject' AND membership.tenant_id = $1`,
      [scope.tenant.id],
    );
    const actorUserId = actor.rows[0]?.user_id;
    if (actorUserId === undefined) throw new Error('FROZEN_LEASE_OWNER_NOT_FOUND');
    const jobId = randomUUID();
    const messageId = randomUUID();
    const leaseToken = randomUUID();
    const aggregateId = randomUUID();
    await pool.query(
      `INSERT INTO jobs
        (id, tenant_id, workspace_id, job_type, aggregate_id, status, progress, attempt,
          idempotency_key, estimated_units, requested_by_user_id, lease_token, lease_expires_at,
          heartbeat_at, lifecycle_frozen_at, lifecycle_freeze_request_id)
       VALUES ($1, $2, $3, 'PROFILE_READINESS', $4, 'RUNNING', 20, 1, $5, 10, $6, $7,
         now() + interval '5 minutes', now(), now(), $8)`,
      [
        jobId,
        scope.tenant.id,
        scope.workspace.id,
        aggregateId,
        `frozen-lease-${jobId}`,
        actorUserId,
        leaseToken,
        randomUUID(),
      ],
    );
    await pool.query(
      `INSERT INTO outbox_messages
        (id, tenant_id, workspace_id, aggregate_id, message_type, payload, published_at)
       VALUES ($1, $2, $3, $4, 'JOB_QUEUED', $5::jsonb, now())`,
      [
        messageId,
        scope.tenant.id,
        scope.workspace.id,
        jobId,
        JSON.stringify({
          jobId,
          tenantId: scope.tenant.id,
          workspaceId: scope.workspace.id,
          schemaVersion: '1.0.0',
        }),
      ],
    );
    const store = new PostgresJobBudgetStore(pool);
    const worker = new JobWorkerCoordinator(store, { now: () => new Date() }, { next: randomUUID });
    const message = {
      messageId,
      payload: {
        jobId,
        tenantId: scope.tenant.id,
        workspaceId: scope.workspace.id,
        schemaVersion: '1.0.0' as const,
      },
    };
    expect(await worker.claim(message)).toEqual({ outcome: 'NOT_AVAILABLE' });
    const lease = {
      job: {
        id: jobId,
        tenantId: scope.tenant.id,
        workspaceId: scope.workspace.id,
        providerKey: null,
        jobType: 'PROFILE_READINESS' as const,
        aggregateId,
        status: 'RUNNING' as const,
        progress: 20,
        attempt: 1,
        maxAttempts: 3,
        budgetWarning: false,
        estimatedUnits: 10,
        heartbeatAt: new Date().toISOString(),
        result: null,
        errorCode: null,
      },
      leaseToken,
      messageId,
    };
    await expect(worker.heartbeat(lease)).resolves.toBe(false);
    await expect(worker.reportProgress(lease, 50)).resolves.toBe(false);
    await expect(worker.complete(lease, { shouldNotPersist: true }, 10)).resolves.toBe(false);
    await expect(worker.fail(lease, 'RETRYABLE', 'SHOULD_NOT_RETRY')).resolves.toBe(false);
    const state = await pool.query<{ status: string; progress: number; attempt: number }>(
      'SELECT status, progress, attempt FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(state.rows[0]).toEqual({ status: 'RUNNING', progress: 20, attempt: 1 });
  });
});
