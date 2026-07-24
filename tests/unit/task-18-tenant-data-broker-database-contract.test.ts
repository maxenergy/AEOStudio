import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

const MIGRATION = new URL(
  '../../packages/db/migrations/0029_task18_tenant_data_broker.sql',
  import.meta.url,
);

describe('Task 18 Tenant Data Broker database contract', () => {
  test('owns replay, capability, durable attempt, and stable effect receipts behind narrow functions', async () => {
    const sql = await readFile(MIGRATION, 'utf8');

    expect(sql).toContain('CREATE TABLE tenant_data_broker_nonces');
    expect(sql).toContain('CREATE TABLE tenant_data_capabilities');
    expect(sql).toContain('CREATE TABLE tenant_data_broker_attempts');
    expect(sql).toContain('CREATE TABLE tenant_data_broker_effects');
    expect(sql).toContain('CREATE TABLE tenant_data_broker_resource_authority');
    expect(sql).toContain('CREATE TABLE tenant_data_authenticated_object_read_sources');
    expect(sql).toContain('CREATE FUNCTION configure_tenant_data_broker_resource_authority');
    expect(sql).toContain('CREATE FUNCTION issue_workload_object_put_capability');
    expect(sql).toContain('CREATE FUNCTION issue_authenticated_object_read_capability');
    expect(sql).toContain('CREATE FUNCTION consume_tenant_data_broker_nonce');
    expect(sql).toContain('CREATE FUNCTION load_active_tenant_data_capability');
    expect(sql).toContain('CREATE FUNCTION begin_tenant_data_broker_effect');
    expect(sql).toContain('CREATE FUNCTION begin_authenticated_tenant_data_broker_effect');
    expect(sql).toContain('CREATE FUNCTION finish_tenant_data_broker_effect');
    expect(sql).toContain('CREATE FUNCTION resolve_tenant_data_broker_object_put_effect');
    expect(sql).toContain('CREATE FUNCTION resolve_tenant_data_broker_legal_hold_effect');
    expect(sql).toMatch(
      /UNIQUE\s*\(\s*source_kind,\s*source_reference,\s*operation,\s*source_revision,\s*effect_identity\s*\)/u,
    );
    expect(sql).toContain('lease_token_sha256 text NOT NULL');
    expect(sql).not.toContain('source_lease_token uuid NOT NULL');
    expect(sql).toMatch(/expires_at\s*<\s*database_now\s*-\s*interval '10 minutes'/u);
    expect(sql).toMatch(/LIMIT 1000/u);
    expect(sql).toMatch(/abs\(extract\(epoch from \(p_signed_at - database_now\)\)\)\s*>\s*30/u);
    expect(sql).toMatch(/p_expires_at\s*<>\s*p_signed_at\s*\+\s*interval '30 seconds'/u);
    expect(sql).toMatch(/candidate_count\s*<>\s*1/u);
    expect(sql).toMatch(/LEAST\([^;]*source_lease_expires_at/u);
    expect(sql).toMatch(/workload_bucket\s*=\s*tenant_export_bucket/u);
    expect(sql).toContain('pg_advisory_xact_lock(hashtextextended(capability.effect_identity, 0))');
    expect(sql).toContain('aeostudio_backup_evidence_canonical_json(derived_resource)');
    expect(sql).toMatch(
      /CREATE FUNCTION issue_workload_object_put_capability\(\s*p_operation_id uuid,\s*p_lease_token uuid,\s*p_capability_id uuid\s*\)/u,
    );
    expect(sql).not.toMatch(/RETURN QUERY SELECT candidate\.capability_id,\s*p_lease_token/u);

    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION consume_tenant_data_broker_nonce\(\s*uuid,\s*timestamptz,\s*timestamptz\s*\) FROM PUBLIC, aeostudio_tenant_data_broker/u,
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION load_active_tenant_data_capability(uuid, uuid)',
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION begin_tenant_data_broker_effect\(\s*uuid,\s*uuid,\s*uuid,\s*text,\s*text\s*\) FROM PUBLIC, aeostudio_tenant_data_broker/u,
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION begin_authenticated_tenant_data_broker_effect(',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION finish_tenant_data_broker_effect(uuid, uuid, text, jsonb)',
    );
    expect(sql).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|ALL)[^;]*tenant_data_(?:capabilities|broker_)/iu,
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION issue_workload_object_put_capability(uuid, uuid, uuid)',
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION issue_authenticated_object_read_capability\(\s*text,\s*uuid,\s*uuid,\s*uuid,\s*text,\s*text,\s*uuid,\s*uuid\s*\) TO aeostudio_runtime/u,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION issue_workload_object_put_capability\(uuid, uuid, uuid\)\s+TO aeostudio_lifecycle_worker, aeostudio_runtime/u,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION issue_workload_object_put_capability\(\s*uuid,\s*uuid,\s*uuid\s*\) FROM PUBLIC/u,
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION (?:consume|load_active|begin|finish)_tenant_data_broker_[^(]+\([^;]+TO aeostudio_(?:runtime|lifecycle_worker)/u,
    );
  });
});
