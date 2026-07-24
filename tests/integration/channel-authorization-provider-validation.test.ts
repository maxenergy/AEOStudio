import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  PostgresChannelAuthorizationStore,
  PostgresChannelAuthorizationValidationStore,
  runMigrations,
} from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const now = new Date('2026-07-24T06:00:00.000Z');

describe('provider-validated Channel authorization PostgreSQL boundary', () => {
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

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  test('persists pending commands, isolates same-Tenant Workspaces, and completes only a live lease', async () => {
    const ids = {
      user: randomUUID(),
      tenant: randomUUID(),
      workspaceA: randomUUID(),
      workspaceB: randomUUID(),
      channel: randomUUID(),
      adapter: randomUUID(),
      authorizationA: randomUUID(),
      authorizationB: randomUUID(),
    };
    await seed(ids);
    const authorizations = new PostgresChannelAuthorizationStore(pool);
    const contextA = context(ids.tenant, ids.workspaceA, ids.user);
    const contextB = context(ids.tenant, ids.workspaceB, ids.user);
    await authorizations.create({
      context: contextA,
      authorizationId: ids.authorizationA,
      adapterVersionId: ids.adapter,
      target: 'fixture://provider-validation/a',
      grantedScopes: ['content:write'],
      acceptedTermsVersion: 'provider-terms-v1',
      secretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:provider-validation/a',
      expiresAt: new Date('2026-07-25T06:00:00.000Z'),
      createdAt: new Date('2026-07-24T05:58:00.000Z'),
      auditEventId: randomUUID(),
    });
    await authorizations.create({
      context: contextB,
      authorizationId: ids.authorizationB,
      adapterVersionId: ids.adapter,
      target: 'fixture://provider-validation/b',
      grantedScopes: ['content:write'],
      acceptedTermsVersion: 'provider-terms-v1',
      secretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:provider-validation/b',
      expiresAt: new Date('2026-07-25T06:00:00.000Z'),
      createdAt: new Date('2026-07-24T05:59:00.000Z'),
      auditEventId: randomUUID(),
    });

    await expect(authorizations.list({ context: contextA })).resolves.toMatchObject([
      {
        id: ids.authorizationA,
        validationStatus: 'PENDING_VALIDATION',
        validationSnapshot: null,
      },
    ]);
    await expect(authorizations.list({ context: contextB })).resolves.toMatchObject([
      { id: ids.authorizationB, validationStatus: 'PENDING_VALIDATION' },
    ]);

    const privileges = await pool.query<{
      runtime_claim: boolean;
      lifecycle_claim: boolean;
      runtime_complete: boolean;
      lifecycle_complete: boolean;
    }>(
      `SELECT
        has_function_privilege(
          'aeostudio_runtime',
          'claim_channel_authorization_validation(text,uuid,timestamptz,timestamptz)',
          'EXECUTE'
        ) AS runtime_claim,
        has_function_privilege(
          'aeostudio_lifecycle_worker',
          'claim_channel_authorization_validation(text,uuid,timestamptz,timestamptz)',
          'EXECUTE'
        ) AS lifecycle_claim,
        has_function_privilege(
          'aeostudio_runtime',
          'complete_channel_authorization_validation_verified(uuid,uuid,uuid,uuid,text,uuid,text,text[],text,text,timestamptz,timestamptz)',
          'EXECUTE'
        ) AS runtime_complete,
        has_function_privilege(
          'aeostudio_lifecycle_worker',
          'complete_channel_authorization_validation_verified(uuid,uuid,uuid,uuid,text,uuid,text,text[],text,text,timestamptz,timestamptz)',
          'EXECUTE'
        ) AS lifecycle_complete`,
    );
    expect(privileges.rows[0]).toEqual({
      runtime_claim: false,
      lifecycle_claim: true,
      runtime_complete: false,
      lifecycle_complete: true,
    });

    const validation = new PostgresChannelAuthorizationValidationStore(pool);
    const lease = await validation.claimNext({
      workerId: 'provider-validator-integration',
      leaseToken: randomUUID(),
      now,
      leaseUntil: new Date('2026-07-24T06:01:00.000Z'),
    });
    expect(lease).toMatchObject({
      tenantId: ids.tenant,
      workspaceId: ids.workspaceA,
      authorizationId: ids.authorizationA,
      adapterKey: 'fixture-provider-adapter',
      adapterVersion: '1.0.0',
    });
    if (lease === null) throw new Error('VALIDATION_LEASE_REQUIRED');
    await expect(
      validation.completeVerified({
        lease: { ...lease, workspaceId: ids.workspaceB },
        actualTarget: lease.target,
        actualScopes: ['content:write'],
        acceptedTermsVersion: lease.acceptedTermsVersion,
        credentialFingerprint: 'a'.repeat(64),
        validatedAt: now,
        validUntil: new Date('2026-07-24T07:00:00.000Z'),
      }),
    ).resolves.toBe(false);
    await expect(
      validation.completeVerified({
        lease,
        actualTarget: lease.target,
        actualScopes: ['content:write'],
        acceptedTermsVersion: lease.acceptedTermsVersion,
        credentialFingerprint: 'a'.repeat(64),
        validatedAt: now,
        validUntil: new Date('2026-07-24T07:00:00.000Z'),
      }),
    ).resolves.toBe(true);

    const publicMetadata = await authorizations.list({ context: contextA });
    expect(publicMetadata).toMatchObject([
      {
        validationStatus: 'VERIFIED',
        validationSnapshot: {
          actualTarget: lease.target,
          actualScopes: ['content:write'],
          acceptedTermsVersion: 'provider-terms-v1',
          validatedAt: now.toISOString(),
          validUntil: '2026-07-24T07:00:00.000Z',
        },
      },
    ]);
    expect(JSON.stringify(publicMetadata)).not.toContain('credentialFingerprint');
    const eligibilityMetadata = await authorizations.findForTarget({
      context: contextA,
      adapterVersionId: ids.adapter,
      target: lease.target,
    });
    expect(eligibilityMetadata).toMatchObject({
      validationSnapshot: {
        actualTarget: lease.target,
        actualScopes: ['content:write'],
        acceptedTermsVersion: 'provider-terms-v1',
      },
    });
    expect(JSON.stringify(eligibilityMetadata)).not.toContain('credentialFingerprint');

    await pool.query(
      `DELETE FROM channel_authorization_validation_commands
       WHERE authorization_id = $1`,
      [ids.authorizationB],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE aeostudio_runtime');
      await client.query(
        `SELECT
          set_config('app.tenant_id', $1, true),
          set_config('app.workspace_id', $2, true),
          set_config('app.actor_id', $3, true)`,
        [ids.tenant, ids.workspaceA, ids.user],
      );
      await expect(
        client.query(
          `INSERT INTO channel_authorization_validation_commands
            (id, tenant_id, workspace_id, authorization_id, status, created_at)
           VALUES ($1, $2, $3, $4, 'PENDING', $5)`,
          [randomUUID(), ids.tenant, ids.workspaceB, ids.authorizationB, now],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }, 120_000);

  async function seed(ids: {
    user: string;
    tenant: string;
    workspaceA: string;
    workspaceB: string;
    channel: string;
    adapter: string;
  }) {
    await pool.query(
      `INSERT INTO users (id, email, created_at)
       VALUES ($1, $2, $3)`,
      [ids.user, `provider-validation-${ids.user}@example.test`, now],
    );
    await pool.query(
      `INSERT INTO tenants (id, name, created_at)
       VALUES ($1, 'Provider validation tenant', $2)`,
      [ids.tenant, now],
    );
    await pool.query(
      `INSERT INTO workspaces (id, tenant_id, name, created_at)
       VALUES
         ($1, $3, 'Provider validation A', $4),
         ($2, $3, 'Provider validation B', $4)`,
      [ids.workspaceA, ids.workspaceB, ids.tenant, now],
    );
    await pool.query(
      `INSERT INTO channel_definitions
        (id, channel_key, display_name, status, unavailable_reason,
          package_transformer_key, package_schema_version)
       VALUES ($1, $2, 'Provider validation fixture', 'AVAILABLE', NULL,
         'generic-web-package', '1.0.0')`,
      [ids.channel, `provider-validation-${ids.channel}`],
    );
    await pool.query(
      `INSERT INTO adapter_versions
        (id, channel_definition_id, adapter_key, adapter_version, enabled, disabled_reason,
          capabilities, required_scopes, terms_version, terms_status, processing_region,
          retention_policy, training_policy, subprocessors, rate_policy)
       VALUES ($1, $2, 'fixture-provider-adapter', '1.0.0', true, NULL,
         ARRAY['PUBLISH','RECONCILE'], ARRAY['content:write'], 'provider-terms-v1', 'ALLOWED',
         'provider-controlled', 'provider policy', 'no training', '[]'::jsonb,
         '{"mode":"provider"}'::jsonb)`,
      [ids.adapter, ids.channel],
    );
  }
});

function context(tenantId: string, workspaceId: string, actorUserId: string) {
  return {
    tenantId,
    workspaceId,
    actorUserId,
    membershipId: randomUUID(),
    role: 'OWNER' as const,
  };
}
