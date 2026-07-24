import { randomUUID } from 'node:crypto';

import { StartContentPlanEnvelopeSchema } from '@aeostudio/contracts/content-planning';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createApiApp } from '../../apps/api/src/app.js';

type ApiTestApp = Awaited<ReturnType<typeof createApiApp>>;

const ENVIRONMENT_KEYS = [
  'NODE_ENV',
  'AEOSTUDIO_ALLOW_FAKE_RUNTIME',
  'AEOSTUDIO_AUTH_MODE',
  'WEB_ORIGIN',
] as const;
const originalEnvironment = new Map<string, string | undefined>();

describe.sequential('P1 generation start idempotency', () => {
  let app: ApiTestApp;
  let session: string;
  let tenantId: string;
  let workspaceId: string;

  beforeAll(async () => {
    for (const key of ENVIRONMENT_KEYS) originalEnvironment.set(key, process.env[key]);
    process.env.NODE_ENV = 'test';
    process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME = 'true';
    process.env.AEOSTUDIO_AUTH_MODE = 'fake';
    process.env.WEB_ORIGIN = 'https://app.example.test';

    app = await createApiApp({ runtimeBuildIdentity: null });
    session = await signIn(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: mutationHeaders(session),
      payload: {
        tenantName: 'P1 Idempotency Tenant',
        workspaceName: 'P1 Idempotency Workspace',
      },
    });
    expect(created.statusCode).toBe(201);
    const scope = created.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    tenantId = scope.tenant.id;
    workspaceId = scope.workspace.id;
    const budget = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/budget`,
      headers: mutationHeaders(session),
      payload: { limitUnits: 1_000 },
    });
    expect(budget.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
    for (const key of ENVIRONMENT_KEYS) {
      const value = originalEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnvironment.clear();
  });

  test('replays the same Content Plan start as the same aggregate and Job', async () => {
    const idempotencyKey = `content-plan-${randomUUID()}`;
    const payload = {
      profile: { id: randomUUID(), revision: 1 },
      offering: { id: randomUUID(), revision: 1 },
      promptSetId: randomUUID(),
      promptRevisionId: randomUUID(),
      primaryClaimRevisionIds: [randomUUID()],
      comparisonClaimRevisionIds: [randomUUID()],
      baselineId: randomUUID(),
      methodPolicyVersion: 'content-plan-v1' as const,
      idempotencyKey,
    };
    const submit = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/content-plans`,
        headers: mutationHeaders(session),
        payload,
      });

    const firstResponse = await submit();
    expect(firstResponse.statusCode, firstResponse.body).toBe(202);
    const first = StartContentPlanEnvelopeSchema.parse(firstResponse.json()).data;

    const replayResponse = await submit();
    expect(replayResponse.statusCode, replayResponse.body).toBe(202);
    const replay = StartContentPlanEnvelopeSchema.parse(replayResponse.json()).data;

    expect(replay.plan.id).toBe(first.plan.id);
    expect(replay.plan.jobId).toBe(first.job.id);
    expect(replay.job.id).toBe(first.job.id);
    expect(replay.job.aggregateId).toBe(first.plan.id);
  });

  test('rejects a reused Content Plan idempotency key when the payload changes', async () => {
    const idempotencyKey = `content-plan-conflict-${randomUUID()}`;
    const payload = {
      profile: { id: randomUUID(), revision: 1 },
      offering: { id: randomUUID(), revision: 1 },
      promptSetId: randomUUID(),
      promptRevisionId: randomUUID(),
      primaryClaimRevisionIds: [randomUUID()],
      comparisonClaimRevisionIds: [randomUUID()],
      baselineId: randomUUID(),
      methodPolicyVersion: 'content-plan-v1' as const,
      idempotencyKey,
    };
    const url = `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/content-plans`;
    const first = await app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(session),
      payload,
    });
    expect(first.statusCode, first.body).toBe(202);

    const conflict = await app.inject({
      method: 'POST',
      url,
      headers: mutationHeaders(session),
      payload: { ...payload, baselineId: randomUUID() },
    });

    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'CONTENT_PLAN_IDEMPOTENCY_CONFLICT' });
  });
});

async function signIn(app: ApiTestApp): Promise<string> {
  const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
  const loginToken = login.cookies.find((cookie) => cookie.name === '__Host-aeo_login')?.value;
  const state = new URL(login.headers.location ?? '').searchParams.get('state');
  const callback = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/callback?code=fake-code&state=${state ?? ''}`,
    headers: { cookie: `__Host-aeo_login=${loginToken ?? ''}` },
  });
  const session = callback.cookies.find((cookie) => cookie.name === '__Host-aeo_session')?.value;
  if (session === undefined) throw new Error('P1_IDEMPOTENCY_LOGIN_FAILED');
  return session;
}

function mutationHeaders(session: string) {
  return {
    cookie: `__Host-aeo_session=${session}`,
    origin: 'https://app.example.test',
  };
}
