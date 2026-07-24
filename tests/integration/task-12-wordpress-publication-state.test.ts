import { fileURLToPath } from 'node:url';

import { PostgresChannelRegistryStore, runMigrations } from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

describe('Task 12 WordPress authorization/publication persistence', () => {
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

  test('stores the site authorization target separately and registers a disabled production draft Adapter', async () => {
    const column = await pool.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'publication_records'
         AND column_name = 'authorization_target'`,
    );
    expect(column.rows).toEqual([{ is_nullable: 'NO', column_default: null }]);

    const authorizationForeignKey = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_constraint constraint_row
       WHERE constraint_row.conrelid = 'publication_records'::regclass
         AND constraint_row.confrelid = 'channel_authorizations'::regclass
         AND constraint_row.contype = 'f'`,
    );
    expect(authorizationForeignKey.rows).toHaveLength(1);
    expect(authorizationForeignKey.rows[0]?.definition).toContain('authorization_target');
    expect(authorizationForeignKey.rows[0]?.definition).not.toMatch(
      /FOREIGN KEY \([^)]*, target\)/u,
    );

    const adapter = await pool.query<{
      channel_key: string;
      adapter_key: string;
      adapter_version: string;
      enabled: boolean;
      terms_status: string;
      capabilities: string[];
      required_scopes: string[];
    }>(
      `SELECT channel.channel_key, adapter.adapter_key, adapter.adapter_version,
         adapter.enabled, adapter.terms_status, adapter.capabilities, adapter.required_scopes
       FROM channel_definitions channel
       JOIN adapter_versions adapter ON adapter.channel_definition_id = channel.id
       WHERE channel.channel_key = 'wordpress-woocommerce-draft'`,
    );
    expect(adapter.rows).toEqual([
      {
        channel_key: 'wordpress-woocommerce-draft',
        adapter_key: 'wordpress-woocommerce-draft',
        adapter_version: '1.0.0',
        enabled: false,
        terms_status: 'REVIEW_REQUIRED',
        capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
        required_scopes: [
          'media:write',
          'pages:write',
          'posts:write',
          'woocommerce:products:write',
        ],
      },
    ]);

    const registry = new PostgresChannelRegistryStore(pool);
    const entries = await registry.listEntries({
      context: {
        tenantId: '00000000-0000-7000-8000-000000000001',
        workspaceId: '00000000-0000-7000-8000-000000000002',
        actorUserId: '00000000-0000-7000-8000-000000000003',
        membershipId: '00000000-0000-7000-8000-000000000004',
        role: 'OWNER',
      },
    });
    expect(
      entries.find((entry) => entry.channelKey === 'wordpress-woocommerce-draft'),
    ).toMatchObject({
      displayName: 'WordPress / WooCommerce Draft',
      status: 'AVAILABLE',
      adapterVersions: [{ enabled: false, termsStatus: 'REVIEW_REQUIRED' }],
    });
  });
});
