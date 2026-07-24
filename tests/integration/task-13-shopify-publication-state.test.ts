import { fileURLToPath } from 'node:url';

import { PostgresChannelRegistryStore, runMigrations } from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

describe('Task 13 Shopify versioned draft Registry persistence', () => {
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

  test('registers only a stable official API version and least-privilege draft scopes', async () => {
    const versionColumn = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'adapter_versions'
         AND column_name = 'provider_api_version'`,
    );
    expect(versionColumn.rows).toEqual([{ is_nullable: 'YES' }]);

    const supportColumn = await pool.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'adapter_versions'
         AND column_name = 'provider_api_supported_until'`,
    );
    expect(supportColumn.rows).toEqual([
      { data_type: 'timestamp with time zone', is_nullable: 'YES' },
    ]);

    const adapter = await pool.query<{
      channel_key: string;
      adapter_key: string;
      adapter_version: string;
      provider_api_version: string | null;
      provider_api_supported_until: Date | null;
      enabled: boolean;
      terms_status: string;
      capabilities: string[];
      required_scopes: string[];
    }>(
      `SELECT channel.channel_key, adapter.adapter_key, adapter.adapter_version,
         adapter.provider_api_version, adapter.provider_api_supported_until,
         adapter.enabled, adapter.terms_status,
         adapter.capabilities, adapter.required_scopes
       FROM channel_definitions channel
       JOIN adapter_versions adapter ON adapter.channel_definition_id = channel.id
       WHERE channel.channel_key = 'shopify-draft'`,
    );
    expect(adapter.rows).toEqual([
      {
        channel_key: 'shopify-draft',
        adapter_key: 'shopify-draft',
        adapter_version: '1.0.0',
        provider_api_version: '2026-07',
        provider_api_supported_until: new Date('2027-07-16T15:00:00.000Z'),
        enabled: false,
        terms_status: 'REVIEW_REQUIRED',
        capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
        required_scopes: ['write_content', 'write_products'],
      },
    ]);
    expect(adapter.rows[0]?.required_scopes.join(',')).not.toMatch(/orders|customers|themes/u);

    const entries = await new PostgresChannelRegistryStore(pool).listEntries({
      context: {
        tenantId: '00000000-0000-7000-8000-000000000001',
        workspaceId: '00000000-0000-7000-8000-000000000002',
        actorUserId: '00000000-0000-7000-8000-000000000003',
        membershipId: '00000000-0000-7000-8000-000000000004',
        role: 'OWNER',
      },
    });
    expect(entries.find((entry) => entry.channelKey === 'shopify-draft')).toMatchObject({
      displayName: 'Shopify Draft',
      status: 'AVAILABLE',
      adapterVersions: [
        {
          providerApiVersion: '2026-07',
          providerApiSupportedUntil: '2027-07-16T15:00:00.000Z',
          enabled: false,
          termsStatus: 'REVIEW_REQUIRED',
          requiredScopes: ['write_content', 'write_products'],
        },
      ],
    });
  });
});
