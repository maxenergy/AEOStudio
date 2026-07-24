import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createProductionPublicationAdapterRegistry } from '@aeostudio/adapters/publication';
import { validatePublicationAdapterRuntime } from '@aeostudio/application/channels-publishing';
import { runMigrations } from '@aeostudio/db';
import type { ChannelAdapterVersion } from '@aeostudio/domain/channels-publishing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

interface AdapterRegistryRow {
  adapter_key: string;
  adapter_version: string;
  provider_api_version: string | null;
  enabled: boolean;
  disabled_reason: string | null;
  capabilities: string[];
  required_scopes: string[];
  terms_version: string;
  terms_status: string;
  processing_region: string;
  retention_policy: string;
  training_policy: string;
  subprocessors: Array<Record<string, unknown>>;
  rate_policy: Record<string, unknown>;
}

describe.sequential('production publication Adapter Registry metadata', () => {
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

  test('keeps all installed production descriptors exact while policy activation remains disabled', async () => {
    const result = await pool.query<AdapterRegistryRow>(
      `SELECT adapter_key, adapter_version, provider_api_version, enabled, disabled_reason,
         capabilities, required_scopes, terms_version, terms_status, processing_region,
         retention_policy, training_policy, subprocessors, rate_policy
       FROM adapter_versions
       WHERE adapter_key = ANY($1::text[])
       ORDER BY adapter_key`,
      [['git-pull-request', 'shopify-draft', 'signed-webhook', 'wordpress-woocommerce-draft']],
    );
    expect(result.rows).toHaveLength(4);

    const registry = createProductionPublicationAdapterRegistry();
    for (const row of result.rows) {
      const adapter = registry.resolve(row.adapter_key, row.adapter_version);
      expect(adapter, row.adapter_key).not.toBeNull();
      if (adapter === null) throw new Error('PRODUCTION_ADAPTER_REQUIRED');
      const expected: Pick<
        ChannelAdapterVersion,
        | 'adapterKey'
        | 'adapterVersion'
        | 'providerApiVersion'
        | 'capabilities'
        | 'requiredScopes'
        | 'termsVersion'
        | 'processingRegion'
        | 'retentionPolicy'
        | 'trainingPolicy'
        | 'subprocessors'
        | 'ratePolicy'
      > = {
        adapterKey: row.adapter_key,
        adapterVersion: row.adapter_version,
        ...(row.provider_api_version === null
          ? {}
          : { providerApiVersion: row.provider_api_version }),
        capabilities: row.capabilities,
        requiredScopes: row.required_scopes,
        termsVersion: row.terms_version,
        processingRegion: row.processing_region,
        retentionPolicy: row.retention_policy,
        trainingPolicy: row.training_policy,
        subprocessors: row.subprocessors,
        ratePolicy: row.rate_policy,
      };
      expect(validatePublicationAdapterRuntime(adapter, expected), row.adapter_key).toBeNull();
      expect(row.enabled, row.adapter_key).toBe(false);
      expect(row.terms_status, row.adapter_key).toBe('REVIEW_REQUIRED');
      expect(row.disabled_reason, row.adapter_key).toMatch(/terms|approval/iu);
    }
  });

  test('revokes any legacy activation when the real-runtime metadata migration is applied', async () => {
    const adapterKeys = [
      'git-pull-request',
      'shopify-draft',
      'signed-webhook',
      'wordpress-woocommerce-draft',
    ];
    await pool.query(
      `UPDATE adapter_versions
       SET enabled = true, terms_status = 'ALLOWED', disabled_reason = NULL
       WHERE adapter_key = ANY($1::text[]) AND adapter_version = '1.0.0'`,
      [adapterKeys],
    );

    const migration = await readFile(
      fileURLToPath(
        new URL(
          '../../packages/db/migrations/0039_production_adapter_runtime_metadata.sql',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    await pool.query(migration);

    const result = await pool.query<
      Pick<AdapterRegistryRow, 'adapter_key' | 'enabled' | 'terms_status'>
    >(
      `SELECT adapter_key, enabled, terms_status
       FROM adapter_versions
       WHERE adapter_key = ANY($1::text[]) AND adapter_version = '1.0.0'
       ORDER BY adapter_key`,
      [adapterKeys],
    );
    expect(result.rows).toHaveLength(4);
    for (const row of result.rows) {
      expect(row.enabled, row.adapter_key).toBe(false);
      expect(row.terms_status, row.adapter_key).toBe('REVIEW_REQUIRED');
    }
  });
});
