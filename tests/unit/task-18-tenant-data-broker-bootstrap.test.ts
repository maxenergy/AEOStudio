import type { Client } from 'pg';
import { describe, expect, test } from 'vitest';

import {
  createInitialTenantDataBrokerKeyRing,
  reconcileDatabasePrincipals,
} from '../../packages/db/src/bootstrap-main.js';

describe('Task 18 Tenant Data Broker bootstrap', () => {
  test('creates a separate NOLOGIN privilege role and login without inheriting shared runtime roles', async () => {
    const statements: string[] = [];
    const connection = {
      query: (statement: string) => {
        statements.push(statement);
        return Promise.resolve({ rows: [] });
      },
    } as unknown as Client;
    const passwords = new Map([
      ['aeostudio_app_login', 'a'.repeat(43)],
      ['aeostudio_lifecycle_login', 'b'.repeat(43)],
      ['aeostudio_migration_login', 'c'.repeat(43)],
      ['aeostudio_tenant_data_broker_login', 'd'.repeat(43)],
    ]);

    await reconcileDatabasePrincipals(connection, 'aeostudio', passwords);

    const sql = statements.join('\n');
    expect(sql).toContain('CREATE ROLE aeostudio_tenant_data_broker');
    expect(sql).toContain('ALTER ROLE aeostudio_tenant_data_broker NOLOGIN INHERIT');
    expect(sql).toContain("'aeostudio_tenant_data_broker_login'");
    expect(sql).toContain(
      'GRANT aeostudio_tenant_data_broker TO aeostudio_tenant_data_broker_login',
    );
    expect(sql).not.toMatch(
      /GRANT aeostudio_(?:runtime|lifecycle_worker) TO aeostudio_tenant_data_broker_login/u,
    );
  });

  test('generates the exact initial versioned HMAC key-ring schema without a previous key', () => {
    const parsed: unknown = JSON.parse(
      createInitialTenantDataBrokerKeyRing('staging', new Set(['reserved-value'])),
    );
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('TENANT_DATA_BROKER_KEY_RING_FIXTURE_INVALID');
    }
    const keyRing = parsed as Record<string, unknown>;
    const current = keyRing.current;
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error('TENANT_DATA_BROKER_CURRENT_KEY_FIXTURE_INVALID');
    }
    const currentKey = current as Record<string, unknown>;

    expect(Object.keys(keyRing).sort()).toEqual(['current', 'schemaVersion']);
    expect(keyRing.schemaVersion).toBe('aeostudio.tenant-data-broker-key-ring.v1');
    expect(currentKey.id).toBe('broker-staging-v1');
    expect(currentKey.value).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(keyRing).not.toHaveProperty('previous');
  });
});
