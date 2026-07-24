import { fileURLToPath } from 'node:url';

import { PostgresChannelRegistryStore, PostgresTenancyStore, runMigrations } from '@aeostudio/db';
import * as DatabaseRuntime from '@aeostudio/db';
import type { SignedWebhookEndpointVerificationStore } from '@aeostudio/application/channels-publishing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { InMemoryChannelRegistryStore } from '../../apps/api/src/channels/in-memory-channel-registry-store.js';
import { resolveApiRuntime } from '../../apps/api/src/runtime/resolve-runtime.js';

const context = {
  tenantId: '00000000-0000-7000-8000-000000000001',
  workspaceId: '00000000-0000-7000-8000-000000000002',
  actorUserId: '00000000-0000-7000-8000-000000000003',
  membershipId: '00000000-0000-7000-8000-000000000004',
  role: 'OWNER' as const,
};

const environment = {
  NODE_ENV: process.env.NODE_ENV,
  AEOSTUDIO_AUTH_MODE: process.env.AEOSTUDIO_AUTH_MODE,
  AEOSTUDIO_CHANNEL_ADAPTER_MODE: process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE,
  AEOSTUDIO_GIT_PROVIDER_MODE: process.env.AEOSTUDIO_GIT_PROVIDER_MODE,
  AEOSTUDIO_WORDPRESS_PROVIDER_MODE: process.env.AEOSTUDIO_WORDPRESS_PROVIDER_MODE,
  AEOSTUDIO_SHOPIFY_PROVIDER_MODE: process.env.AEOSTUDIO_SHOPIFY_PROVIDER_MODE,
  AEOSTUDIO_WEBHOOK_PROVIDER_MODE: process.env.AEOSTUDIO_WEBHOOK_PROVIDER_MODE,
  AEOSTUDIO_ALLOW_FAKE_RUNTIME: process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME,
};

describe.sequential('Task 14 signed webhook Registry governance', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(
      pool,
      fileURLToPath(new URL('../../packages/db/migrations', import.meta.url)),
    );
  }, 120_000);

  afterEach(() => {
    for (const [name, value] of Object.entries(environment)) restoreEnvironment(name, value);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  test('migration 0014 registers a disabled review-required non-rollback production Adapter', async () => {
    const migration = await pool.query<{ id: string }>(
      `SELECT id
       FROM schema_migrations
       WHERE id LIKE '0014\\_%' ESCAPE '\\'`,
    );
    expect(migration.rows, 'expected Task 14 migration 0014').toHaveLength(1);

    const adapter = await pool.query<{
      channel_id: string;
      adapter_id: string;
      channel_key: string;
      display_name: string;
      package_schema_version: string;
      adapter_key: string;
      adapter_version: string;
      enabled: boolean;
      disabled_reason: string | null;
      terms_status: string;
      capabilities: string[];
      required_scopes: string[];
    }>(
      `SELECT channel.id AS channel_id, adapter.id AS adapter_id,
         channel.channel_key, channel.display_name, channel.package_schema_version,
         adapter.adapter_key, adapter.adapter_version, adapter.enabled,
         adapter.disabled_reason, adapter.terms_status,
         adapter.capabilities, adapter.required_scopes
       FROM channel_definitions channel
       JOIN adapter_versions adapter ON adapter.channel_definition_id = channel.id
       WHERE channel.channel_key = 'signed-webhook'`,
    );
    expect(adapter.rows, 'expected signed-webhook production Registry seed').toHaveLength(1);
    expect(adapter.rows[0]).toMatchObject({
      channel_id: '00000000-0000-7000-8000-000000001040',
      adapter_id: '00000000-0000-7000-8000-000000001041',
      channel_key: 'signed-webhook',
      display_name: 'Signed Webhook',
      package_schema_version: '1.0.0',
      adapter_key: 'signed-webhook',
      adapter_version: '1.0.0',
      enabled: false,
      terms_status: 'REVIEW_REQUIRED',
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
      required_scopes: ['webhook:deliver'],
    });
    expect(adapter.rows[0]?.disabled_reason).not.toBeNull();
    expect(adapter.rows[0]?.disabled_reason).not.toHaveLength(0);
    expect(adapter.rows[0]?.capabilities).not.toContain('ROLLBACK');
  });

  test('migrations provide a durable Tenant and Workspace isolated endpoint verification table', async () => {
    const table = await pool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE oid = to_regclass('public.signed_webhook_endpoint_verifications')`,
    );
    expect(table.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'signed_webhook_endpoint_verifications'
       ORDER BY ordinal_position`,
    );
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual([
      'id',
      'tenant_id',
      'workspace_id',
      'channel_definition_id',
      'status',
      'endpoint_url',
      'receipt_url',
      'algorithm',
      'key_id',
      'verification_reference',
      'challenge',
      'challenge_expires_at',
      'receipt_challenge',
      'receipt_challenge_expires_at',
      'created_by_user_id',
      'created_at',
      'verified_by_user_id',
      'verified_at',
      'revoked_at',
    ]);

    const policy = await pool.query<{ qual: string; with_check: string }>(
      `SELECT qual, with_check
       FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = 'signed_webhook_endpoint_verifications'
         AND policyname = 'signed_webhook_endpoint_verification_isolation'`,
    );
    expect(policy.rows).toHaveLength(1);
    expect(policy.rows[0]?.qual).toContain('aeostudio_current_tenant_id');
    expect(policy.rows[0]?.qual).toContain('app.workspace_id');
    expect(policy.rows[0]?.with_check).toContain('aeostudio_current_tenant_id');
    expect(policy.rows[0]?.with_check).toContain('app.workspace_id');
  });

  test('PostgreSQL verification state stays exact-scope, challenge-gated, and revocable', async () => {
    const Store = (
      DatabaseRuntime as unknown as {
        PostgresSignedWebhookEndpointVerificationStore?: new (
          pool: Pool,
        ) => SignedWebhookEndpointVerificationStore;
      }
    ).PostgresSignedWebhookEndpointVerificationStore;
    expect(Store, 'expected durable signed-webhook endpoint verification store').toBeTypeOf(
      'function',
    );
    if (Store === undefined) throw new Error('SIGNED_WEBHOOK_ENDPOINT_STORE_REQUIRED');
    await new PostgresTenancyStore(pool).bootstrapTenant({
      actorSubject: 'task14-endpoint-owner',
      actorEmail: 'task14-endpoint-owner@example.test',
      userId: context.actorUserId,
      tenantId: context.tenantId,
      tenantName: 'Task 14 Endpoint Tenant',
      workspaceId: context.workspaceId,
      workspaceName: 'Task 14 Endpoint Workspace',
      membershipId: context.membershipId,
      roleBindingId: '00000000-0000-7000-8000-000000000005',
      auditEventId: '00000000-0000-7000-8000-000000000006',
    });
    const store = new Store(pool);
    const verificationId = '00000000-0000-7000-8000-000000001490';
    const deliveryChallenge = 'delivery_challenge_that_is_long_enough_00000000001';
    const receiptChallenge = 'receipt_challenge_that_is_long_enough_000000000001';
    const createdAt = new Date('2026-07-24T00:00:00.000Z');
    const challengeExpiresAt = new Date('2026-07-24T00:15:00.000Z');
    const expectedProofs = [
      {
        purpose: 'DELIVERY' as const,
        exactUrl: 'https://receiver.example.test/hooks/aeostudio',
        challenge: deliveryChallenge,
        challengeExpiresAt: challengeExpiresAt.toISOString(),
      },
      {
        purpose: 'RECEIPT' as const,
        exactUrl: 'https://receiver.example.test/hooks/aeostudio/receipts',
        challenge: receiptChallenge,
        challengeExpiresAt: challengeExpiresAt.toISOString(),
      },
    ];
    const pending = await store.createPending({
      context,
      verificationId,
      channelDefinitionId: '00000000-0000-7000-8000-000000001040',
      endpointUrl: 'https://receiver.example.test/hooks/aeostudio',
      receiptUrl: 'https://receiver.example.test/hooks/aeostudio/receipts',
      algorithm: 'HMAC_SHA256',
      keyId: 'durable-hmac-2026-07',
      verificationReference: 'change-task14-durable',
      proofs: expectedProofs.map((proof) => ({
        ...proof,
        challengeExpiresAt,
      })),
      createdAt,
      auditEventId: '00000000-0000-7000-8000-000000001491',
    });
    expect(pending).toMatchObject({
      id: verificationId,
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      status: 'PENDING',
      proofs: expectedProofs,
      verifiedAt: null,
    });
    expect(JSON.stringify(await store.list({ context }))).not.toContain(deliveryChallenge);
    expect(JSON.stringify(await store.list({ context }))).not.toContain(receiptChallenge);
    await expect(
      store.findVerifiedEndpoint({
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        channelDefinitionId: '00000000-0000-7000-8000-000000001040',
        endpointVerificationId: verificationId,
      }),
    ).resolves.toBeNull();
    await expect(
      store.markVerified({
        context,
        verificationId,
        expectedProofs: expectedProofs.map((proof) =>
          proof.purpose === 'RECEIPT'
            ? { ...proof, challenge: 'wrong_challenge_that_is_long_enough_000000000001' }
            : proof,
        ),
        verifiedAt: new Date('2026-07-24T00:05:00.000Z'),
        auditEventId: '00000000-0000-7000-8000-000000001492',
      }),
    ).resolves.toBeNull();

    const verified = await store.markVerified({
      context,
      verificationId,
      expectedProofs,
      verifiedAt: new Date('2026-07-24T00:05:00.000Z'),
      auditEventId: '00000000-0000-7000-8000-000000001493',
    });
    expect(verified).toMatchObject({ id: verificationId, status: 'VERIFIED' });
    await expect(
      store.findVerifiedEndpoint({
        tenantId: context.tenantId,
        workspaceId: '00000000-0000-7000-8000-000000000099',
        channelDefinitionId: '00000000-0000-7000-8000-000000001040',
        endpointVerificationId: verificationId,
      }),
    ).resolves.toBeNull();
    await expect(
      store.findVerifiedEndpoint({
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        channelDefinitionId: '00000000-0000-7000-8000-000000001040',
        endpointVerificationId: verificationId,
      }),
    ).resolves.toMatchObject({ id: verificationId, status: 'VERIFIED' });

    await expect(
      store.revoke({
        context,
        verificationId,
        revokedAt: new Date('2026-07-24T00:06:00.000Z'),
        auditEventId: '00000000-0000-7000-8000-000000001494',
      }),
    ).resolves.toMatchObject({ id: verificationId, status: 'REVOKED' });
    await expect(
      store.findVerifiedEndpoint({
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        channelDefinitionId: '00000000-0000-7000-8000-000000001040',
        endpointVerificationId: verificationId,
      }),
    ).resolves.toBeNull();
  });

  test('concurrent and replayed proof completion creates one verified transition', async () => {
    const Store = (
      DatabaseRuntime as unknown as {
        PostgresSignedWebhookEndpointVerificationStore?: new (
          pool: Pool,
        ) => SignedWebhookEndpointVerificationStore;
      }
    ).PostgresSignedWebhookEndpointVerificationStore;
    if (Store === undefined) throw new Error('SIGNED_WEBHOOK_ENDPOINT_STORE_REQUIRED');
    const store = new Store(pool);
    const verificationId = '00000000-0000-7000-8000-000000001495';
    const challengeExpiresAt = new Date('2026-07-24T01:15:00.000Z');
    const proofs = [
      {
        purpose: 'DELIVERY' as const,
        exactUrl: 'https://receiver.example.test/hooks/concurrent',
        challenge: 'concurrent_delivery_challenge_00000000000000000001',
        challengeExpiresAt,
      },
      {
        purpose: 'RECEIPT' as const,
        exactUrl: 'https://receiver.example.test/hooks/concurrent/receipts',
        challenge: 'concurrent_receipt_challenge_000000000000000000001',
        challengeExpiresAt,
      },
    ];
    await store.createPending({
      context,
      verificationId,
      channelDefinitionId: '00000000-0000-7000-8000-000000001040',
      endpointUrl: proofs[0]!.exactUrl,
      receiptUrl: proofs[1]!.exactUrl,
      algorithm: 'ED25519',
      keyId: 'concurrent-ed25519-2026-07',
      verificationReference: 'change-task14-concurrent',
      proofs,
      createdAt: new Date('2026-07-24T01:00:00.000Z'),
      auditEventId: '00000000-0000-7000-8000-000000001496',
    });
    const expectedProofs = proofs.map((proof) => ({
      ...proof,
      challengeExpiresAt: proof.challengeExpiresAt.toISOString(),
    }));

    const completions = await Promise.all([
      store.markVerified({
        context,
        verificationId,
        expectedProofs,
        verifiedAt: new Date('2026-07-24T01:05:00.000Z'),
        auditEventId: '00000000-0000-7000-8000-000000001497',
      }),
      store.markVerified({
        context,
        verificationId,
        expectedProofs,
        verifiedAt: new Date('2026-07-24T01:05:00.000Z'),
        auditEventId: '00000000-0000-7000-8000-000000001498',
      }),
    ]);

    expect(completions.filter((result) => result !== null)).toHaveLength(1);
    await expect(
      store.markVerified({
        context,
        verificationId,
        expectedProofs,
        verifiedAt: new Date('2026-07-24T01:06:00.000Z'),
        auditEventId: '00000000-0000-7000-8000-000000001499',
      }),
    ).resolves.toBeNull();
    const audits = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM audit_events
       WHERE resource_id = $1
         AND action = 'SIGNED_WEBHOOK_ENDPOINT_OWNERSHIP_VERIFIED'`,
      [verificationId],
    );
    expect(audits.rows).toEqual([{ count: '1' }]);
  });

  test('one expired receipt-path proof keeps the entire tuple pending', async () => {
    const Store = (
      DatabaseRuntime as unknown as {
        PostgresSignedWebhookEndpointVerificationStore?: new (
          pool: Pool,
        ) => SignedWebhookEndpointVerificationStore;
      }
    ).PostgresSignedWebhookEndpointVerificationStore;
    if (Store === undefined) throw new Error('SIGNED_WEBHOOK_ENDPOINT_STORE_REQUIRED');
    const store = new Store(pool);
    const verificationId = '00000000-0000-7000-8000-000000001500';
    const proofs = [
      {
        purpose: 'DELIVERY' as const,
        exactUrl: 'https://receiver.example.test/hooks/expiring',
        challenge: 'expiring_delivery_challenge_000000000000000000001',
        challengeExpiresAt: new Date('2026-07-24T02:15:00.000Z'),
      },
      {
        purpose: 'RECEIPT' as const,
        exactUrl: 'https://receiver.example.test/hooks/expiring/receipts',
        challenge: 'expiring_receipt_challenge_0000000000000000000001',
        challengeExpiresAt: new Date('2026-07-24T02:04:00.000Z'),
      },
    ];
    const pending = await store.createPending({
      context,
      verificationId,
      channelDefinitionId: '00000000-0000-7000-8000-000000001040',
      endpointUrl: proofs[0]!.exactUrl,
      receiptUrl: proofs[1]!.exactUrl,
      algorithm: 'HMAC_SHA256',
      keyId: 'expiring-hmac-2026-07',
      verificationReference: 'change-task14-expiring',
      proofs,
      createdAt: new Date('2026-07-24T02:00:00.000Z'),
      auditEventId: '00000000-0000-7000-8000-000000001501',
    });
    expect(pending.challengeExpiresAt).toBe('2026-07-24T02:04:00.000Z');

    await expect(
      store.markVerified({
        context,
        verificationId,
        expectedProofs: proofs.map((proof) => ({
          ...proof,
          challengeExpiresAt: proof.challengeExpiresAt.toISOString(),
        })),
        verifiedAt: new Date('2026-07-24T02:05:00.000Z'),
        auditEventId: '00000000-0000-7000-8000-000000001502',
      }),
    ).resolves.toBeNull();
    await expect(store.findPending({ context, verificationId })).resolves.toMatchObject({
      id: verificationId,
      status: 'PENDING',
    });
  });

  test('explicit fake runtime preserves the production contract identity but enables only its reviewed fixture', async () => {
    process.env.NODE_ENV = 'test';
    process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME = 'true';
    process.env.AEOSTUDIO_AUTH_MODE = 'fake';
    process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE = 'fake';
    delete process.env.AEOSTUDIO_GIT_PROVIDER_MODE;
    delete process.env.AEOSTUDIO_WORDPRESS_PROVIDER_MODE;
    delete process.env.AEOSTUDIO_SHOPIFY_PROVIDER_MODE;
    delete process.env.AEOSTUDIO_WEBHOOK_PROVIDER_MODE;

    const withoutWebhook = await resolveApiRuntime({});
    expect(withoutWebhook.options.channelRegistryStore).toBeInstanceOf(
      InMemoryChannelRegistryStore,
    );
    expect(
      (await withoutWebhook.options.channelRegistryStore?.listEntries({ context }))?.some(
        ({ channelKey }) => channelKey === 'signed-webhook',
      ),
    ).toBe(false);
    await withoutWebhook.cleanup();

    process.env.AEOSTUDIO_WEBHOOK_PROVIDER_MODE = 'fake';
    const runtime = await resolveApiRuntime({});
    const fakeEntry = (await runtime.options.channelRegistryStore?.listEntries({ context }))?.find(
      ({ channelKey }) => channelKey === 'signed-webhook',
    );
    await runtime.cleanup();

    expect(fakeEntry, 'expected signed-webhook only behind every fake runtime switch').toEqual({
      id: '00000000-0000-7000-8000-000000001040',
      channelKey: 'signed-webhook',
      displayName: 'Signed Webhook',
      status: 'AVAILABLE',
      unavailableReason: null,
      packageTransformerKey: 'generic-web-package',
      packageSchemaVersion: '1.0.0',
      adapterVersions: [
        expect.objectContaining({
          id: '00000000-0000-7000-8000-000000001041',
          adapterKey: 'signed-webhook',
          adapterVersion: '1.0.0',
          enabled: true,
          disabledReason: null,
          capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
          requiredScopes: ['webhook:deliver'],
          termsStatus: 'ALLOWED',
        }),
      ],
    });

    const productionEntry = (
      await new PostgresChannelRegistryStore(pool).listEntries({ context })
    ).find(({ channelKey }) => channelKey === 'signed-webhook');
    expect(productionEntry).toBeDefined();
    expect(registryContractIdentity(fakeEntry)).toEqual(registryContractIdentity(productionEntry));
    expect(productionEntry?.adapterVersions[0]).toMatchObject({
      enabled: false,
      termsStatus: 'REVIEW_REQUIRED',
    });
  });

  test('requires the explicit fake-runtime allow gate even in test', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME;
    delete process.env.AEOSTUDIO_AUTH_MODE;
    delete process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE;
    delete process.env.AEOSTUDIO_GIT_PROVIDER_MODE;
    delete process.env.AEOSTUDIO_WORDPRESS_PROVIDER_MODE;
    delete process.env.AEOSTUDIO_SHOPIFY_PROVIDER_MODE;
    process.env.AEOSTUDIO_WEBHOOK_PROVIDER_MODE = 'fake';

    await expect(resolveApiRuntime({})).rejects.toThrow('FAKE_RUNTIME_FORBIDDEN_IN_PRODUCTION');
  });

  test.each([undefined, 'staging', 'production'] as const)(
    'refuses fake runtime switches outside test/development when NODE_ENV=$nodeEnv',
    async (nodeEnv) => {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME = 'true';
      delete process.env.AEOSTUDIO_AUTH_MODE;
      delete process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE;
      delete process.env.AEOSTUDIO_GIT_PROVIDER_MODE;
      delete process.env.AEOSTUDIO_WORDPRESS_PROVIDER_MODE;
      delete process.env.AEOSTUDIO_SHOPIFY_PROVIDER_MODE;
      process.env.AEOSTUDIO_WEBHOOK_PROVIDER_MODE = 'fake';

      await expect(resolveApiRuntime({})).rejects.toThrow('FAKE_RUNTIME_FORBIDDEN_IN_PRODUCTION');
    },
  );

  test('refuses the fake signed webhook provider switch in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AEOSTUDIO_AUTH_MODE;
    delete process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE;
    delete process.env.AEOSTUDIO_GIT_PROVIDER_MODE;
    delete process.env.AEOSTUDIO_WORDPRESS_PROVIDER_MODE;
    delete process.env.AEOSTUDIO_SHOPIFY_PROVIDER_MODE;
    process.env.AEOSTUDIO_WEBHOOK_PROVIDER_MODE = 'fake';

    await expect(resolveApiRuntime({})).rejects.toThrow('FAKE_RUNTIME_FORBIDDEN_IN_PRODUCTION');
  });

  test('migration accepts legacy remote state and only the exact bounded receipt-evidence shape', async () => {
    const legacyState = {
      status: 'PR_OPENED',
      number: 41,
      isProductionLive: false,
      rollbackHandle: { operation: 'CLOSE_PULL_REQUEST' },
    };
    const receiptState = signedWebhookRemoteState();

    await expect(remoteStateIsValid(pool, legacyState)).resolves.toBe(true);
    await expect(remoteStateIsValid(pool, receiptState)).resolves.toBe(true);

    for (const invalid of [
      { ...receiptState, unexpected: true },
      { ...receiptState, status: 'PR_OPENED' },
      { ...receiptState, number: 1 },
      { ...receiptState, isProductionLive: true },
      { ...receiptState, rollbackHandle: { operation: 'DELETE' } },
      {
        ...receiptState,
        receiptEvidence: { ...receiptState.receiptEvidence, unexpected: true },
      },
      {
        ...receiptState,
        receiptEvidence: { ...receiptState.receiptEvidence, receiptId: 'x'.repeat(501) },
      },
      {
        ...receiptState,
        receiptEvidence: { ...receiptState.receiptEvidence, requestBodySha256: 'A'.repeat(64) },
      },
      {
        ...receiptState,
        receiptEvidence: { ...receiptState.receiptEvidence, receivedAt: '2026-99-99T12:00:00Z' },
      },
    ]) {
      await expect(remoteStateIsValid(pool, invalid)).resolves.toBe(false);
    }
  });

  test('database binds receipt delivery lineage to the immutable PublicationRecord ID', async () => {
    const client = await pool.connect();
    const insertPublication = (publicationId: string, state: unknown, suffix: string) =>
      client.query(
        `INSERT INTO task14_publication_lineage
          (id, tenant_id, workspace_id, channel_package_id, package_checksum,
           artifact_revision_id, artifact_content_hash, adapter_version_id,
            channel_authorization_id, authorization_target, target, idempotency_key,
            request_hash, status, job_id, remote_ref, remote_state, requested_by_user_id,
            created_at, updated_at, required_scopes_snapshot)
         VALUES
          ($1, '00000000-0000-7000-8000-000000001421',
           '00000000-0000-7000-8000-000000001422',
           '00000000-0000-7000-8000-000000001420', $2,
           '00000000-0000-7000-8000-000000001425', $3,
           '00000000-0000-7000-8000-000000001441',
           '00000000-0000-7000-8000-000000001442', $4, $4, $5, $6,
           'REMOTE_APPLIED', '00000000-0000-7000-8000-000000001443', $7,
            $8::jsonb, '00000000-0000-7000-8000-000000001426', $9, $9,
            ARRAY['webhook:deliver'])`,
        [
          publicationId,
          'e'.repeat(64),
          'a'.repeat(64),
          'signed-webhook:v1:fixture',
          `task14-lineage-${suffix}`,
          'f'.repeat(64),
          `https://cms.receiver.example.test/receipts/${publicationId}`,
          JSON.stringify(state),
          new Date('2026-07-21T12:00:00.000Z'),
        ],
      );
    try {
      await client.query('BEGIN');
      await client.query(
        'CREATE TEMP TABLE task14_publication_lineage (LIKE publication_records INCLUDING CONSTRAINTS) ON COMMIT DROP',
      );
      await client.query(
        `CREATE TRIGGER task14_publication_immutable_guard
         BEFORE UPDATE OR DELETE ON task14_publication_lineage
         FOR EACH ROW EXECUTE FUNCTION guard_publication_record_mutation()`,
      );
      const matchingPublicationId = '00000000-0000-7000-8000-000000001418';
      await expect(
        insertPublication(
          matchingPublicationId,
          signedWebhookRemoteState(matchingPublicationId),
          'matching',
        ),
      ).resolves.toBeDefined();

      await client.query('SAVEPOINT receipt_evidence_immutable');
      await expect(
        client.query(
          `UPDATE task14_publication_lineage
           SET remote_state = jsonb_set(remote_state, '{receiptEvidence,receiptId}', '"replacement"')
           WHERE id = $1`,
          [matchingPublicationId],
        ),
      ).rejects.toMatchObject({ code: 'P0001', message: 'PUBLICATION_REMOTE_STATE_IMMUTABLE' });
      await client.query('ROLLBACK TO SAVEPOINT receipt_evidence_immutable');

      const mismatchedPublicationId = '00000000-0000-7000-8000-000000001419';
      await expect(
        insertPublication(
          mismatchedPublicationId,
          signedWebhookRemoteState('00000000-0000-7000-8000-000000001417'),
          'mismatched',
        ),
      ).rejects.toMatchObject({ constraint: 'publication_records_receipt_delivery_lineage_check' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

function registryContractIdentity(
  entry:
    | {
        id: string;
        channelKey: string;
        displayName: string;
        packageTransformerKey: string;
        packageSchemaVersion: string;
        adapterVersions: Array<{
          id: string;
          adapterKey: string;
          adapterVersion: string;
          capabilities: string[];
          requiredScopes: string[];
        }>;
      }
    | undefined,
) {
  if (entry === undefined) return undefined;
  return {
    id: entry.id,
    channelKey: entry.channelKey,
    displayName: entry.displayName,
    packageTransformerKey: entry.packageTransformerKey,
    packageSchemaVersion: entry.packageSchemaVersion,
    adapterVersions: entry.adapterVersions.map((adapter) => ({
      id: adapter.id,
      adapterKey: adapter.adapterKey,
      adapterVersion: adapter.adapterVersion,
      capabilities: adapter.capabilities,
      requiredScopes: adapter.requiredScopes,
    })),
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function remoteStateIsValid(pool: Pool, value: unknown): Promise<boolean> {
  const result = await pool.query<{ valid: boolean }>(
    'SELECT publication_remote_state_is_valid($1::jsonb) AS valid',
    [JSON.stringify(value)],
  );
  return result.rows[0]?.valid ?? false;
}

function signedWebhookRemoteState(deliveryId = '00000000-0000-7000-8000-000000001418') {
  return {
    status: 'DELIVERED',
    number: null,
    isProductionLive: false,
    rollbackHandle: null,
    receiptEvidence: {
      schemaVersion: 'signed-webhook-receipt-evidence.v1',
      receiptId: `receipt:${deliveryId}`,
      deliveryId,
      receiverEffectId: `effect:${deliveryId}`,
      requestBodySha256: 'b'.repeat(64),
      verifiedKeyId: 'hmac-2026-07',
      verifiedAlgorithm: 'HMAC_SHA256',
      receivedAt: '2026-07-21T12:00:00.000Z',
    },
  };
}
