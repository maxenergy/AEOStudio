import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { createApiApp } from '../../apps/api/src/app.js';

type ApiTestApp = Awaited<ReturnType<typeof createApiApp>>;

const ENVIRONMENT_KEYS = [
  'NODE_ENV',
  'AEOSTUDIO_ALLOW_FAKE_RUNTIME',
  'AEOSTUDIO_AUTH_MODE',
  'AEOSTUDIO_CHANNEL_ADAPTER_MODE',
  'AEOSTUDIO_WEBHOOK_PROVIDER_MODE',
  'WEB_ORIGIN',
] as const;
const originalEnvironment = new Map<string, string | undefined>();

describe.sequential('signed-webhook endpoint verification API', () => {
  let app: ApiTestApp;
  let session: string;
  let tenantId: string;
  let workspaceId: string;
  const verifyOwnership = vi.fn(
    (input: { purpose: 'DELIVERY' | 'RECEIPT' | 'DELIVERY_AND_RECEIPT'; exactUrl: string }) =>
      Promise.resolve(
        input.exactUrl.includes('unowned') || input.exactUrl.endsWith('/shared/receipt-denied')
          ? { outcome: 'FAILED' as const, reason: 'CHALLENGE_MISMATCH' as const }
          : { outcome: 'VERIFIED' as const },
      ),
  );

  beforeAll(async () => {
    for (const key of ENVIRONMENT_KEYS) originalEnvironment.set(key, process.env[key]);
    process.env.NODE_ENV = 'test';
    process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME = 'true';
    process.env.AEOSTUDIO_AUTH_MODE = 'fake';
    process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE = 'fake';
    process.env.AEOSTUDIO_WEBHOOK_PROVIDER_MODE = 'fake';
    process.env.WEB_ORIGIN = 'https://app.example.test';

    app = await createApiApp({
      runtimeBuildIdentity: null,
      signedWebhookEndpointOwnershipVerifier: { verifyOwnership },
    });
    session = await signIn(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: mutationHeaders(session),
      payload: {
        tenantName: 'Durable Webhook Tenant',
        workspaceName: 'Durable Webhook Workspace',
      },
    });
    expect(created.statusCode).toBe(201);
    const scope = created.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    tenantId = scope.tenant.id;
    workspaceId = scope.workspace.id;
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

  test('requires exact endpoint challenge proof before an Admin can verify and revoke a receiver tuple', async () => {
    const scopeUrl = `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}`;
    const endpoint = {
      channelDefinitionId: '00000000-0000-7000-8000-000000001040',
      endpointUrl: 'https://receiver.example.test/hooks/aeostudio',
      receiptUrl: 'https://receiver.example.test/hooks/aeostudio/receipts',
      algorithm: 'HMAC_SHA256',
      keyId: 'receiver-hmac-2026-07',
      verificationReference: `change-${randomUUID()}`,
    };
    const created = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/signed-webhook-endpoint-verifications`,
      headers: mutationHeaders(session),
      payload: endpoint,
    });

    expect(created.statusCode).toBe(201);
    const record = created.json<{
      data: {
        verification: {
          id: string;
          status: string;
          challengeExpiresAt: string;
          proofs: Array<{
            purpose: 'DELIVERY' | 'RECEIPT' | 'DELIVERY_AND_RECEIPT';
            exactUrl: string;
            challenge: string;
            challengeExpiresAt: string;
          }>;
          revokedAt: string | null;
        };
      };
    }>().data.verification;
    expect(record).toMatchObject({
      status: 'PENDING',
      revokedAt: null,
    });
    expect(created.headers['cache-control']).toBe('private, no-store');
    expect(record.proofs).toHaveLength(2);
    expect(record.proofs.map(({ purpose, exactUrl }) => ({ purpose, exactUrl }))).toEqual([
      { purpose: 'DELIVERY', exactUrl: endpoint.endpointUrl },
      { purpose: 'RECEIPT', exactUrl: endpoint.receiptUrl },
    ]);
    expect(record.proofs[0]?.challenge).toMatch(/^[A-Za-z0-9_-]{32,128}$/u);
    expect(record.proofs[1]?.challenge).toMatch(/^[A-Za-z0-9_-]{32,128}$/u);
    expect(record.proofs[0]?.challenge).not.toBe(record.proofs[1]?.challenge);
    expect(new Date(record.challengeExpiresAt).getTime()).toBeGreaterThan(Date.now());

    const listed = await app.inject({
      method: 'GET',
      url: `${scopeUrl}/signed-webhook-endpoint-verifications`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed.json<{ data: { verifications: Array<{ id: string; status: string }> } }>().data
        .verifications,
    ).toContainEqual(expect.objectContaining({ id: record.id, status: 'PENDING' }));
    for (const proof of record.proofs) expect(listed.body).not.toContain(proof.challenge);

    const verified = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/signed-webhook-endpoint-verifications/${record.id}/verify`,
      headers: mutationHeaders(session),
      payload: {},
    });
    expect(verified.statusCode).toBe(200);
    expect(
      verified.json<{
        data: { verification: { id: string; status: string; verifiedAt: string } };
      }>().data.verification,
    ).toMatchObject({ id: record.id, status: 'VERIFIED' });
    expect(verifyOwnership.mock.calls.map(([proof]) => proof)).toEqual(
      record.proofs.map((proof) => ({
        verificationId: record.id,
        purpose: proof.purpose,
        exactUrl: proof.exactUrl,
        challenge: proof.challenge,
      })),
    );

    const revoked = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/signed-webhook-endpoint-verifications/${record.id}/revoke`,
      headers: mutationHeaders(session),
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    expect(
      revoked.json<{ data: { verification: { id: string; status: string; revokedAt: string } } }>()
        .data.verification,
    ).toMatchObject({ id: record.id, status: 'REVOKED' });
  });

  test('keeps a forged reference PENDING when the endpoint cannot return the challenge', async () => {
    const scopeUrl = `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}`;
    const created = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/signed-webhook-endpoint-verifications`,
      headers: mutationHeaders(session),
      payload: {
        channelDefinitionId: '00000000-0000-7000-8000-000000001040',
        endpointUrl: 'https://unowned.example.test/hooks/aeostudio',
        receiptUrl: 'https://unowned.example.test/hooks/aeostudio/receipts',
        algorithm: 'ED25519',
        keyId: 'unowned-ed25519-2026-07',
        verificationReference: `forged-${randomUUID()}`,
      },
    });
    expect(created.statusCode).toBe(201);
    const record = created.json<{ data: { verification: { id: string; status: string } } }>().data
      .verification;
    expect(record.status).toBe('PENDING');

    const attempted = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/signed-webhook-endpoint-verifications/${record.id}/verify`,
      headers: mutationHeaders(session),
      payload: {},
    });
    expect(attempted.statusCode).toBe(422);
    expect(attempted.json<{ code: string }>().code).toBe('ENDPOINT_OWNERSHIP_NOT_VERIFIED');

    const listed = await app.inject({
      method: 'GET',
      url: `${scopeUrl}/signed-webhook-endpoint-verifications`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    const pending = listed
      .json<{ data: { verifications: Array<{ id: string; status: string }> } }>()
      .data.verifications.find(({ id }) => id === record.id);
    expect(pending).toEqual({ ...pending, id: record.id, status: 'PENDING' });
  });

  test('does not trust another tenant path on the same shared SaaS origin', async () => {
    verifyOwnership.mockClear();
    const scopeUrl = `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}`;
    const endpointUrl = 'https://hooks.shared-saas.test/shared/delivery';
    const receiptUrl = 'https://hooks.shared-saas.test/shared/receipt-denied';
    const created = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/signed-webhook-endpoint-verifications`,
      headers: mutationHeaders(session),
      payload: {
        channelDefinitionId: '00000000-0000-7000-8000-000000001040',
        endpointUrl,
        receiptUrl,
        algorithm: 'HMAC_SHA256',
        keyId: 'shared-saas-hmac-2026-07',
        verificationReference: `shared-${randomUUID()}`,
      },
    });
    expect(created.statusCode).toBe(201);
    const verification = created.json<{
      data: { verification: { id: string; status: string } };
    }>().data.verification;

    const attempted = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/signed-webhook-endpoint-verifications/${verification.id}/verify`,
      headers: mutationHeaders(session),
      payload: {},
    });

    expect(attempted.statusCode).toBe(422);
    expect(
      verifyOwnership.mock.calls.map(([proof]) => ({
        purpose: proof.purpose,
        exactUrl: proof.exactUrl,
      })),
    ).toEqual([
      { purpose: 'DELIVERY', exactUrl: endpointUrl },
      { purpose: 'RECEIPT', exactUrl: receiptUrl },
    ]);
    const listed = await app.inject({
      method: 'GET',
      url: `${scopeUrl}/signed-webhook-endpoint-verifications`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(
      listed
        .json<{ data: { verifications: Array<{ id: string; status: string }> } }>()
        .data.verifications.find(({ id }) => id === verification.id),
    ).toMatchObject({ id: verification.id, status: 'PENDING' });
  });

  test('uses one combined proof when delivery and receipt URLs are exactly identical', async () => {
    verifyOwnership.mockClear();
    const scopeUrl = `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}`;
    const exactUrl = 'https://receiver.example.test/hooks/combined';
    const created = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/signed-webhook-endpoint-verifications`,
      headers: mutationHeaders(session),
      payload: {
        channelDefinitionId: '00000000-0000-7000-8000-000000001040',
        endpointUrl: exactUrl,
        receiptUrl: exactUrl,
        algorithm: 'ED25519',
        keyId: 'combined-ed25519-2026-07',
        verificationReference: `combined-${randomUUID()}`,
      },
    });
    const verification = created.json<{
      data: {
        verification: {
          id: string;
          proofs: Array<{ purpose: string; exactUrl: string }>;
        };
      };
    }>().data.verification;
    expect(verification.proofs).toHaveLength(1);
    expect(verification.proofs[0]).toMatchObject({
      purpose: 'DELIVERY_AND_RECEIPT',
      exactUrl,
    });

    const verified = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/signed-webhook-endpoint-verifications/${verification.id}/verify`,
      headers: mutationHeaders(session),
      payload: {},
    });

    expect(verified.statusCode).toBe(200);
    expect(verifyOwnership).toHaveBeenCalledTimes(1);
    expect(verifyOwnership.mock.calls[0]?.[0]).toMatchObject({
      purpose: 'DELIVERY_AND_RECEIPT',
      exactUrl,
    });
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
  if (session === undefined) throw new Error('SIGNED_WEBHOOK_VERIFICATION_LOGIN_FAILED');
  return session;
}

function mutationHeaders(session: string) {
  return {
    cookie: `__Host-aeo_session=${session}`,
    origin: 'https://app.example.test',
  };
}
