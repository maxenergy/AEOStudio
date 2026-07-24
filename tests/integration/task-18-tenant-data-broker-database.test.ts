import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { reconcileDatabasePrincipals } from '../../packages/db/src/bootstrap-main.js';
import { runMigrations } from '../../packages/db/src/migrations.js';

const WORKLOAD_BUCKET = 'aeostudio-staging-123456789012-artifacts';
const AUDIT_BUCKET = 'aeostudio-staging-123456789012-audit';
const ACCOUNT_ID = '123456789012';
const KMS_KEY_ARN =
  'arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-4000-8000-000000000018';

const FUNCTION_SIGNATURES = [
  'bind_tenant_data_channel_package_object_private(uuid,uuid,uuid)',
  'bind_tenant_data_channel_package_after_insert_private()',
  'bind_tenant_data_managed_package_after_insert_private()',
  'configure_tenant_data_broker_resource_authority(text,text,text,text,text)',
  'consume_tenant_data_broker_nonce(uuid,timestamptz,timestamptz)',
  'tenant_data_canonical_utc_instant_private(timestamptz)',
  'issue_workload_object_put_capability(uuid,uuid,uuid)',
  'tenant_data_issue_capability_private(uuid,text,text,bigint,uuid,text,text,text,text,uuid,uuid,text,jsonb,timestamptz)',
  'issue_publication_package_read_capability(uuid,uuid,uuid)',
  'issue_publication_secret_read_capability(uuid,uuid,uuid)',
  'issue_privacy_object_put_capability(uuid,uuid,uuid)',
  'issue_workload_object_recovery_head_capability(uuid,uuid,uuid)',
  'issue_privacy_object_recovery_head_capability(uuid,uuid,uuid)',
  'issue_authenticated_object_read_capability(text,uuid,uuid,uuid,text,text,uuid,uuid)',
  'issue_connector_secret_deletion_capability_private(uuid,uuid,uuid,text)',
  'issue_connector_secret_describe_capability(uuid,uuid,uuid)',
  'issue_connector_secret_delete_capability(uuid,uuid,uuid)',
  'issue_connector_secret_verify_unreadable_capability(uuid,uuid,uuid)',
  'tenant_data_decode_inventory_cursor_private(text)',
  'tenant_data_managed_object_storage_class_private(managed_object_versions)',
  'tenant_data_live_legal_hold_status_private(uuid,text,text)',
  'tenant_data_bump_role_binding_revision_private()',
  'tenant_data_bump_membership_revision_private()',
  'tenant_data_load_due_deletion_object_private(uuid,uuid,text,text,timestamptz)',
  'issue_deletion_inventory_capability(uuid,uuid,uuid,integer)',
  'issue_deletion_object_capability_private(uuid,uuid,uuid,text,text,text)',
  'issue_deletion_object_head_capability(uuid,uuid,uuid,text,text)',
  'issue_deletion_object_get_legal_hold_capability(uuid,uuid,uuid,text,text)',
  'issue_deletion_object_delete_capability(uuid,uuid,uuid,text,text)',
  'issue_legal_hold_set_capability(uuid,text,text,uuid,uuid)',
  'issue_legal_hold_get_recovery_capability(uuid,text,text,uuid,uuid)',
  'tenant_data_validate_deletion_inventory_capability_private(tenant_data_capabilities,uuid,timestamptz)',
  'tenant_data_validate_deletion_object_capability_private(tenant_data_capabilities,uuid,timestamptz)',
  'tenant_data_validate_legal_hold_capability_private(tenant_data_capabilities,uuid,timestamptz)',
  'tenant_data_capability_source_lease_expires_at(tenant_data_capabilities,uuid,timestamptz)',
  'load_active_tenant_data_capability(uuid,uuid)',
  'begin_tenant_data_broker_effect(uuid,uuid,uuid,text,text)',
  'begin_authenticated_tenant_data_broker_effect(uuid,timestamptz,timestamptz,uuid,uuid,text,text)',
  'finish_tenant_data_broker_effect(uuid,uuid,text,jsonb)',
  'resolve_tenant_data_broker_object_put_effect(uuid,uuid,text,text,text,text,bigint)',
  'resolve_tenant_data_broker_legal_hold_effect(uuid,uuid,text)',
  'resolve_tenant_data_broker_secret_delete_effect(uuid,uuid,text)',
  'tenant_data_broker_source_lease_expires_at_private(tenant_data_capabilities)',
  'tenant_data_broker_provider_grace_elapsed_private(text,timestamptz)',
  'tenant_data_mark_stale_broker_effect_unknown_private()',
  'tenant_data_capability_source_lease_expires_at_task18_legacy(tenant_data_capabilities,uuid,timestamptz)',
  'resolve_tenant_data_broker_object_put_effect_task18_legacy(uuid,uuid,text,text,text,text,bigint)',
  'resolve_tenant_data_broker_legal_hold_effect_task18_legacy(uuid,uuid,text)',
] as const;

const DATA_TABLES = [
  'tenant_data_authenticated_object_read_sources',
  'tenant_data_channel_package_object_bindings',
  'tenant_data_broker_nonces',
  'tenant_data_broker_resource_authority',
  'tenant_data_capabilities',
  'tenant_data_broker_attempts',
  'tenant_data_broker_effects',
] as const;

interface TenantFixture {
  actorUserId: string;
  membershipId: string;
  roleBindingId: string;
  tenantId: string;
  workspaceId: string;
}

interface WorkloadResource {
  bucket: string;
  byteLength: number;
  checksumSha256: string;
  contentType: string;
  key: string;
  kind: 'WORKLOAD_OBJECT_PUT';
  lockedUntil: null;
  objectClass: 'WORKLOAD_OBJECTS';
  sealedAt: null;
}

interface WorkloadCapability {
  capabilityId: string;
  effectIdentity: string;
  leaseToken: string;
  operationId: string;
  resource: WorkloadResource;
  resourceHash: string;
}

interface BeginRow {
  attempt_id: string;
  outcome: 'ALREADY_SUCCEEDED' | 'AMBIGUOUS' | 'STARTED';
  success_receipt: Record<string, unknown> | null;
}

interface WorkloadReceipt {
  bucket: string;
  byteLength: number;
  checksum: string;
  contentType: string;
  key: string;
  versionId: string;
}

describe.sequential('Task 18 Tenant Data Broker database security contract', () => {
  let container: StartedPostgreSqlContainer;
  let superuser: Client;
  let migration: Pool;
  let application: Pool;
  let lifecycle: Pool;
  let broker: Pool;
  let fixture: TenantFixture;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23')
      .withCommand(['postgres', '-c', 'max_connections=250'])
      .start();
    superuser = new Client({ connectionString: container.getConnectionUri() });
    await superuser.connect();

    const passwords = new Map([
      ['aeostudio_app_login', 'TASK18_BROKER_DB_APP_PASSWORD'.padEnd(43, 'A')],
      ['aeostudio_lifecycle_login', 'TASK18_BROKER_DB_LIFECYCLE_PASSWORD'.padEnd(43, 'L')],
      ['aeostudio_migration_login', 'TASK18_BROKER_DB_MIGRATION_PASSWORD'.padEnd(43, 'M')],
      ['aeostudio_tenant_data_broker_login', 'TASK18_BROKER_DB_BROKER_PASSWORD'.padEnd(43, 'B')],
    ]);
    await reconcileDatabasePrincipals(superuser, container.getDatabase(), passwords);

    migration = loginPool(
      container,
      'aeostudio_migration_login',
      passwords.get('aeostudio_migration_login')!,
      20,
    );
    application = loginPool(
      container,
      'aeostudio_app_login',
      passwords.get('aeostudio_app_login')!,
      20,
    );
    lifecycle = loginPool(
      container,
      'aeostudio_lifecycle_login',
      passwords.get('aeostudio_lifecycle_login')!,
      20,
    );
    broker = loginPool(
      container,
      'aeostudio_tenant_data_broker_login',
      passwords.get('aeostudio_tenant_data_broker_login')!,
      45,
    );

    await runMigrations(
      migration,
      fileURLToPath(new URL('../../packages/db/migrations', import.meta.url)),
    );
    fixture = await bootstrapTenant(migration);

    // Keep the rest of this suite independently useful when the governed
    // configuration function itself is RED. Only the migration owner can seed
    // this exact fixture row.
    await seedResourceAuthority(migration);
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled([
      broker?.end(),
      lifecycle?.end(),
      application?.end(),
      migration?.end(),
    ]);
    await superuser?.end();
    await container?.stop();
  });

  test('configures one immutable environment authority and rejects drift', async () => {
    await migration.query('DELETE FROM tenant_data_broker_resource_authority');
    try {
      await expect(
        migration.query<{ configured: boolean }>(
          `SELECT configure_tenant_data_broker_resource_authority(
             $1, $1, $2, $3, $4
           ) AS configured`,
          [WORKLOAD_BUCKET, AUDIT_BUCKET, ACCOUNT_ID, KMS_KEY_ARN],
        ),
      ).resolves.toMatchObject({ rows: [{ configured: true }] });
      await expect(
        migration.query<{ configured: boolean }>(
          `SELECT configure_tenant_data_broker_resource_authority(
             $1, $1, $2, $3, $4
           ) AS configured`,
          [WORKLOAD_BUCKET, AUDIT_BUCKET, ACCOUNT_ID, KMS_KEY_ARN],
        ),
      ).resolves.toMatchObject({ rows: [{ configured: true }] });
      await expect(
        migration.query(
          `SELECT configure_tenant_data_broker_resource_authority(
             $1, $1, $2, $3, $4
           )`,
          ['different-artifact-bucket', AUDIT_BUCKET, ACCOUNT_ID, KMS_KEY_ARN],
        ),
      ).rejects.toThrow(/TENANT_DATA_BROKER_RESOURCE_AUTHORITY_DRIFT/u);
      await expect(
        migration.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM tenant_data_broker_resource_authority',
        ),
      ).resolves.toMatchObject({ rows: [{ count: '1' }] });
    } finally {
      await seedResourceAuthority(migration);
    }
  });

  test('issues and loads only an exact source-derived workload grant without returning the raw lease', async () => {
    const source = await seedWorkloadSource('issuer-load');
    const capabilityId = randomUUID();
    await expect(
      lifecycle.query<{ capability_id: string | null }>(
        `SELECT issue_workload_object_put_capability($1, $2, $3) AS capability_id`,
        [source.operationId, source.leaseToken, capabilityId],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: capabilityId }] });
    await expect(
      application.query<{ capability_id: string | null }>(
        `SELECT issue_workload_object_put_capability($1, $2, $3)
           AS capability_id`,
        [source.operationId, source.leaseToken, randomUUID()],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: capabilityId }] });

    const loaded = await broker.query<{
      authority_kind: string;
      authority_reference: string;
      capability_id: string;
      effect_identity: string;
      expires_at: Date;
      lease_token_sha256: string;
      operation: string;
      resource: WorkloadResource;
      resource_hash: string;
      scope_kind: string;
      tenant_id: string;
      workspace_id: string;
    }>('SELECT * FROM load_active_tenant_data_capability($1, $2)', [
      capabilityId,
      source.leaseToken,
    ]);

    expect(loaded.rows).toHaveLength(1);
    expect(loaded.fields.map((field) => field.name)).not.toContain('lease_token');
    expect(loaded.rows[0]).toMatchObject({
      authority_kind: 'WORKLOAD_WRITE_INTENT',
      authority_reference: source.operationId,
      capability_id: capabilityId,
      effect_identity: `WORKLOAD_OBJECT_WRITE:${source.operationId}`,
      lease_token_sha256: sha256(source.leaseToken),
      operation: 'PUT_WORKLOAD_OBJECT',
      resource: source.resource,
      scope_kind: 'WORKSPACE',
      tenant_id: fixture.tenantId,
      workspace_id: fixture.workspaceId,
    });
    expect(loaded.rows[0]?.resource_hash).toBe(sha256(canonicalJson(source.resource)));
    expect(loaded.rows[0]?.expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(loaded.rows[0]!.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  });

  test('issues authenticated exact-version reads through the production application login', async () => {
    const sessionToken = createHash('sha256')
      .update(`database-authenticated-read:${randomUUID()}`, 'utf8')
      .digest('base64url');
    const sessionTokenDigest = createHash('sha256')
      .update(sessionToken, 'utf8')
      .digest('base64url');
    const objectId = randomUUID();
    const objectVersionId = `database-authenticated-version-${randomUUID()}`;
    const checksum = sha256(`database-authenticated-object:${objectId}`);
    const objectKey =
      `tenants/${fixture.tenantId}/workspaces/${fixture.workspaceId}/artifacts/` +
      `${randomUUID()}/revisions/1/${checksum}.json`;
    await migration.query(
      `INSERT INTO auth_sessions (
         token_digest, subject_digest, identity_ciphertext, created_at,
         expires_at, revoked_at, last_seen_at
       ) VALUES (
         $1, $2, 'opaque-database-authenticated-session',
         clock_timestamp(), clock_timestamp() + interval '1 hour',
         NULL, clock_timestamp()
       )`,
      [sessionTokenDigest, sha256('task18-tenant-data-broker-database-owner')],
    );
    await migration.query(
      `INSERT INTO managed_object_versions (
         id, tenant_id, workspace_id, object_class, object_ref, object_key,
         object_version_id, checksum, content_type, byte_length,
         lifecycle_state, created_at
       ) VALUES (
         $1, $2, $3, 'ARTIFACT_PAYLOAD', $4, $5, $6, $7,
         'application/json', 256, 'ACTIVE', clock_timestamp()
       )`,
      [
        objectId,
        fixture.tenantId,
        fixture.workspaceId,
        `s3://${WORKLOAD_BUCKET}/${objectKey}?versionId=${objectVersionId}`,
        objectKey,
        objectVersionId,
        checksum,
      ],
    );

    await expect(
      application.query<{ current_user: string; rls_active: boolean; session_user: string }>(
        `SELECT current_user, session_user,
                row_security_active('managed_object_versions') AS rls_active`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          current_user: 'aeostudio_app_login',
          rls_active: true,
          session_user: 'aeostudio_app_login',
        },
      ],
    });

    const leaseToken = randomUUID();
    const capabilityId = randomUUID();
    await expect(
      application.query<{ capability_id: string | null }>(
        `SELECT issue_authenticated_object_read_capability(
           $1, $2, $3, $4, $5, $6, $7, $8
         ) AS capability_id`,
        [
          sessionToken,
          fixture.membershipId,
          fixture.tenantId,
          fixture.workspaceId,
          objectKey,
          objectVersionId,
          leaseToken,
          capabilityId,
        ],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: capabilityId }] });

    await expect(
      broker.query<{
        authority_kind: string;
        authority_reference: string;
        operation: string;
        resource: Record<string, unknown>;
        scope_kind: string;
        tenant_id: string;
        workspace_id: string | null;
      }>('SELECT * FROM load_active_tenant_data_capability($1, $2)', [capabilityId, leaseToken]),
    ).resolves.toMatchObject({
      rows: [
        {
          authority_kind: 'AUTHENTICATED_OBJECT_READ',
          authority_reference: capabilityId,
          operation: 'READ_WORKLOAD_OBJECT',
          scope_kind: 'WORKSPACE',
          tenant_id: fixture.tenantId,
          workspace_id: fixture.workspaceId,
          resource: {
            bucket: WORKLOAD_BUCKET,
            byteLength: 256,
            checksumSha256: checksum,
            contentType: 'application/json',
            key: objectKey,
            kind: 'OBJECT_VERSION',
            objectClass: 'WORKLOAD_OBJECTS',
            versionId: objectVersionId,
          },
        },
      ],
    });
  });

  test('keeps issuer, broker functions, helper, and tables behind the exact role matrix', async () => {
    const roles = [
      'public',
      'aeostudio_runtime',
      'aeostudio_lifecycle_worker',
      'aeostudio_tenant_data_broker',
    ] as const;
    const privileges = await superuser.query<{
      can_execute: boolean;
      function_exists: boolean;
      function_signature: string;
      role_name: string;
    }>(
      `SELECT role_name, function_signature,
              to_regprocedure(function_signature) IS NOT NULL AS function_exists,
              COALESCE(
                has_function_privilege(
                  role_name, to_regprocedure(function_signature), 'EXECUTE'
                ),
                false
              ) AS can_execute
       FROM unnest($1::text[]) AS role_name
       CROSS JOIN unnest($2::text[]) AS function_signature
       ORDER BY role_name, function_signature`,
      [roles, FUNCTION_SIGNATURES],
    );
    const allowed = new Set([
      'aeostudio_runtime|issue_authenticated_object_read_capability(text,uuid,uuid,uuid,text,text,uuid,uuid)',
      'aeostudio_runtime|issue_workload_object_put_capability(uuid,uuid,uuid)',
      'aeostudio_runtime|issue_publication_package_read_capability(uuid,uuid,uuid)',
      'aeostudio_runtime|issue_publication_secret_read_capability(uuid,uuid,uuid)',
      'aeostudio_runtime|issue_privacy_object_put_capability(uuid,uuid,uuid)',
      'aeostudio_runtime|issue_workload_object_recovery_head_capability(uuid,uuid,uuid)',
      'aeostudio_runtime|issue_privacy_object_recovery_head_capability(uuid,uuid,uuid)',
      'aeostudio_lifecycle_worker|issue_workload_object_put_capability(uuid,uuid,uuid)',
      'aeostudio_lifecycle_worker|issue_publication_package_read_capability(uuid,uuid,uuid)',
      'aeostudio_lifecycle_worker|issue_publication_secret_read_capability(uuid,uuid,uuid)',
      'aeostudio_lifecycle_worker|issue_privacy_object_put_capability(uuid,uuid,uuid)',
      'aeostudio_lifecycle_worker|issue_workload_object_recovery_head_capability(uuid,uuid,uuid)',
      'aeostudio_lifecycle_worker|issue_privacy_object_recovery_head_capability(uuid,uuid,uuid)',
      'aeostudio_lifecycle_worker|issue_connector_secret_describe_capability(uuid,uuid,uuid)',
      'aeostudio_lifecycle_worker|issue_connector_secret_delete_capability(uuid,uuid,uuid)',
      'aeostudio_lifecycle_worker|issue_connector_secret_verify_unreadable_capability(uuid,uuid,uuid)',
      'aeostudio_lifecycle_worker|issue_deletion_inventory_capability(uuid,uuid,uuid,integer)',
      'aeostudio_lifecycle_worker|issue_deletion_object_head_capability(uuid,uuid,uuid,text,text)',
      'aeostudio_lifecycle_worker|issue_deletion_object_get_legal_hold_capability(uuid,uuid,uuid,text,text)',
      'aeostudio_lifecycle_worker|issue_deletion_object_delete_capability(uuid,uuid,uuid,text,text)',
      'aeostudio_lifecycle_worker|issue_legal_hold_set_capability(uuid,text,text,uuid,uuid)',
      'aeostudio_lifecycle_worker|issue_legal_hold_get_recovery_capability(uuid,text,text,uuid,uuid)',
      'aeostudio_tenant_data_broker|load_active_tenant_data_capability(uuid,uuid)',
      'aeostudio_tenant_data_broker|begin_authenticated_tenant_data_broker_effect(uuid,timestamptz,timestamptz,uuid,uuid,text,text)',
      'aeostudio_tenant_data_broker|finish_tenant_data_broker_effect(uuid,uuid,text,jsonb)',
      'aeostudio_tenant_data_broker|resolve_tenant_data_broker_object_put_effect(uuid,uuid,text,text,text,text,bigint)',
      'aeostudio_tenant_data_broker|resolve_tenant_data_broker_legal_hold_effect(uuid,uuid,text)',
      'aeostudio_tenant_data_broker|resolve_tenant_data_broker_secret_delete_effect(uuid,uuid,text)',
    ]);
    expect(privileges.rows).toHaveLength(roles.length * FUNCTION_SIGNATURES.length);
    for (const privilege of privileges.rows) {
      expect(privilege.function_exists, privilege.function_signature).toBe(true);
      expect(privilege.can_execute, `${privilege.role_name}|${privilege.function_signature}`).toBe(
        allowed.has(`${privilege.role_name}|${privilege.function_signature}`),
      );
    }

    const tablePrivileges = await superuser.query<{
      has_any_dml: boolean;
      role_name: string;
      table_name: string;
    }>(
      `SELECT role_name, table_name,
              EXISTS (
                SELECT 1
                FROM unnest(ARRAY[
                  'SELECT', 'INSERT', 'UPDATE', 'DELETE',
                  'TRUNCATE', 'REFERENCES', 'TRIGGER'
                ]) AS privilege_name
                WHERE has_table_privilege(
                  role_name, to_regclass(table_name), privilege_name
                )
              ) AS has_any_dml
       FROM unnest($1::text[]) AS role_name
       CROSS JOIN unnest($2::text[]) AS table_name
       ORDER BY role_name, table_name`,
      [roles, DATA_TABLES],
    );
    expect(tablePrivileges.rows).toHaveLength(roles.length * DATA_TABLES.length);
    expect(tablePrivileges.rows.every((row) => !row.has_any_dml)).toBe(true);

    await expect(
      application.query(
        `SELECT consume_tenant_data_broker_nonce(
           $1, clock_timestamp(), clock_timestamp() + interval '30 seconds'
         )`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      broker.query(`SELECT issue_workload_object_put_capability($1, $2, $3)`, [
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ]),
    ).rejects.toThrow(/permission denied/u);
  });

  test('accepts exactly one of 100 simultaneous authenticated starts and keeps the replay row', async () => {
    const capability = await seedCapabilityDirectly('atomic-nonce-race');
    const nonce = randomUUID();
    const signedAt = new Date();
    const expiresAt = new Date(signedAt.getTime() + 30_000);
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        broker.query<BeginRow>(
          `SELECT * FROM begin_authenticated_tenant_data_broker_effect(
             $1, $2, $3, $4, $5, 'PUT_WORKLOAD_OBJECT', $6
           )`,
          [
            nonce,
            signedAt,
            expiresAt,
            capability.capabilityId,
            capability.leaseToken,
            capability.resourceHash,
          ],
        ),
      ),
    );
    expect(results.filter((result) => result.rows[0]?.outcome === 'STARTED')).toHaveLength(1);
    expect(results.filter((result) => result.rows.length === 0)).toHaveLength(99);
    await expect(
      broker.query<BeginRow>(
        `SELECT * FROM begin_authenticated_tenant_data_broker_effect(
           $1, $2, $3, $4, $5, 'PUT_WORKLOAD_OBJECT', $6
         )`,
        [
          nonce,
          signedAt,
          expiresAt,
          capability.capabilityId,
          capability.leaseToken,
          capability.resourceHash,
        ],
      ),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      migration.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM tenant_data_broker_nonces WHERE nonce = $1',
        [nonce],
      ),
    ).resolves.toMatchObject({ rows: [{ count: '1' }] });
  }, 30_000);

  test('allows exactly one of 100 simultaneous starts for the same stable effect', async () => {
    const capability = await seedCapabilityDirectly('effect-race');
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) => beginEffect(capability, `effect-race-${index}`)),
    );
    const rows = results.flatMap((result) => result.rows);
    expect(rows.filter((row) => row.outcome === 'STARTED')).toHaveLength(1);
    expect(rows.filter((row) => row.outcome === 'AMBIGUOUS')).toHaveLength(99);

    const started = rows.find((row) => row.outcome === 'STARTED')!;
    const durable = await migration.query<{
      active_attempt_id: string;
      started_count: string;
      state: string;
      unknown_count: string;
    }>(
      `SELECT effect.active_attempt_id, effect.state,
                count(*) FILTER (WHERE attempt.outcome = 'STARTED')::text AS started_count,
                count(*) FILTER (WHERE attempt.outcome = 'UNKNOWN')::text AS unknown_count
         FROM tenant_data_broker_effects effect
         JOIN tenant_data_broker_attempts attempt
           ON attempt.effect_identity = effect.effect_identity
         WHERE effect.effect_identity = $1
         GROUP BY effect.active_attempt_id, effect.state`,
      [capability.effectIdentity],
    );
    expect(durable.rows).toEqual([
      {
        active_attempt_id: started.attempt_id,
        started_count: '1',
        state: 'STARTED',
        unknown_count: '99',
      },
    ]);
  }, 30_000);

  test('fences STARTED only after its capability, source lease, nonce, and provider grace expire', async () => {
    const capability = await seedCapabilityDirectly('stale-started-effect');
    const first = await beginEffect(capability, 'stale-started-effect-first');
    expect(first.rows[0]?.outcome).toBe('STARTED');
    await migration.query(
      `UPDATE tenant_data_broker_attempts
       SET started_at = clock_timestamp() - interval '2 minutes'
       WHERE attempt_id = $1`,
      [first.rows[0]!.attempt_id],
    );
    await migration.query(
      `UPDATE tenant_data_broker_effects
       SET updated_at = clock_timestamp() - interval '2 minutes'
       WHERE effect_identity = $1`,
      [capability.effectIdentity],
    );

    await expect(beginEffect(capability, 'stale-started-effect-retry')).resolves.toMatchObject({
      rows: [{ outcome: 'AMBIGUOUS' }],
    });
    await expect(
      migration.query(
        `SELECT effect.state,
                count(*) FILTER (WHERE attempt.outcome = 'STARTED')::text AS started_count,
                count(*) FILTER (WHERE attempt.outcome = 'UNKNOWN')::text AS unknown_count
         FROM tenant_data_broker_effects effect
         JOIN tenant_data_broker_attempts attempt
           ON attempt.effect_identity = effect.effect_identity
         WHERE effect.effect_identity = $1
         GROUP BY effect.state`,
        [capability.effectIdentity],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: 'STARTED', started_count: '1', unknown_count: '1' }],
    });

    await migration.query(
      `UPDATE tenant_data_capabilities
       SET issued_at = clock_timestamp() - interval '4 minutes',
           expires_at = clock_timestamp() - interval '2 minutes'
       WHERE capability_id = $1`,
      [capability.capabilityId],
    );
    await migration.query(
      `WITH frozen AS (SELECT clock_timestamp() AS database_now)
       UPDATE tenant_data_broker_nonces nonce
       SET signed_at = frozen.database_now - interval '3 minutes',
           expires_at =
             frozen.database_now - interval '2 minutes 30 seconds',
           first_seen_at = frozen.database_now - interval '3 minutes'
       FROM tenant_data_broker_attempts attempt, frozen
       WHERE attempt.attempt_id = $1
         AND nonce.nonce = attempt.nonce`,
      [first.rows[0]!.attempt_id],
    );
    const renewedLease = randomUUID();
    await rotateSourceLease(capability.operationId, renewedLease);
    const renewedCapability = await insertCapabilityForSource({
      ...capability,
      capabilityId: randomUUID(),
      leaseToken: renewedLease,
    });

    await expect(
      beginEffect(renewedCapability, 'stale-started-effect-after-provider-grace'),
    ).resolves.toMatchObject({
      rows: [{ outcome: 'AMBIGUOUS' }],
    });
    await expect(
      migration.query(
        `SELECT effect.state,
                count(*) FILTER (WHERE attempt.outcome = 'STARTED')::text AS started_count,
                count(*) FILTER (WHERE attempt.outcome = 'UNKNOWN')::text AS unknown_count
         FROM tenant_data_broker_effects effect
         JOIN tenant_data_broker_attempts attempt
           ON attempt.effect_identity = effect.effect_identity
         WHERE effect.effect_identity = $1
         GROUP BY effect.state`,
        [capability.effectIdentity],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: 'UNKNOWN', started_count: '0', unknown_count: '3' }],
    });
  });

  test('delays negative PUT recovery until provider grace but resolves a positive observation immediately', async () => {
    const negative = await seedCapabilityDirectly('negative-recovery-grace');
    const negativePut = await beginEffect(negative, 'negative-recovery-grace-put');
    await expect(
      finishEffect(negative, negativePut.rows[0]!.attempt_id, 'UNKNOWN', null),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });

    const freshRecoveryId = randomUUID();
    await expect(
      lifecycle.query<{ capability_id: string | null }>(
        `SELECT issue_workload_object_recovery_head_capability(
           $1, $2, $3
         ) AS capability_id`,
        [negative.operationId, negative.leaseToken, freshRecoveryId],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: freshRecoveryId }] });
    const freshRecovery = await loadCapability(freshRecoveryId, negative.leaseToken);
    const freshProbe = await beginBrokerOperation(
      freshRecoveryId,
      negative.leaseToken,
      'HEAD_WORKLOAD_OBJECT',
      freshRecovery.resource_hash,
    );
    await expect(
      broker.query(
        `SELECT resolve_tenant_data_broker_object_put_effect(
           $1, $2, 'MISSING', NULL, NULL, NULL, NULL
         ) AS resolution`,
        [freshProbe.rows[0]!.attempt_id, negative.leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ resolution: 'NOT_RESOLVED' }] });
    await expect(
      broker.query(
        `SELECT finish_tenant_data_broker_effect(
           $1, $2, 'FAILED', NULL
         ) AS finished`,
        [freshProbe.rows[0]!.attempt_id, negative.leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });

    await expireAttemptAuthorization(
      negativePut.rows[0]!.attempt_id,
      negative.capabilityId,
      negative.effectIdentity,
    );
    const renewedLease = randomUUID();
    await rotateSourceLease(negative.operationId, renewedLease);
    const elapsedRecoveryId = randomUUID();
    await expect(
      lifecycle.query<{ capability_id: string | null }>(
        `SELECT issue_workload_object_recovery_head_capability(
           $1, $2, $3
         ) AS capability_id`,
        [negative.operationId, renewedLease, elapsedRecoveryId],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: elapsedRecoveryId }] });
    const elapsedRecovery = await loadCapability(elapsedRecoveryId, renewedLease);
    const elapsedProbe = await beginBrokerOperation(
      elapsedRecoveryId,
      renewedLease,
      'HEAD_WORKLOAD_OBJECT',
      elapsedRecovery.resource_hash,
    );
    await expect(
      broker.query(
        `SELECT resolve_tenant_data_broker_object_put_effect(
           $1, $2, 'MISSING', NULL, NULL, NULL, NULL
         ) AS resolution`,
        [elapsedProbe.rows[0]!.attempt_id, renewedLease],
      ),
    ).resolves.toMatchObject({ rows: [{ resolution: 'RESOLVED_FAILED' }] });

    const positive = await seedCapabilityDirectly('positive-recovery-immediate');
    const positivePut = await beginEffect(positive, 'positive-recovery-immediate-put');
    await finishEffect(positive, positivePut.rows[0]!.attempt_id, 'UNKNOWN', null);
    const positiveRecoveryId = randomUUID();
    await lifecycle.query(`SELECT issue_workload_object_recovery_head_capability($1, $2, $3)`, [
      positive.operationId,
      positive.leaseToken,
      positiveRecoveryId,
    ]);
    const positiveRecovery = await loadCapability(positiveRecoveryId, positive.leaseToken);
    const positiveProbe = await beginBrokerOperation(
      positiveRecoveryId,
      positive.leaseToken,
      'HEAD_WORKLOAD_OBJECT',
      positiveRecovery.resource_hash,
    );
    await expect(
      broker.query(
        `SELECT resolve_tenant_data_broker_object_put_effect(
           $1, $2, 'FOUND', $3, $4, $5, $6
         ) AS resolution`,
        [
          positiveProbe.rows[0]!.attempt_id,
          positive.leaseToken,
          'positive-version',
          positive.resource.checksumSha256,
          positive.resource.contentType,
          positive.resource.byteLength,
        ],
      ),
    ).resolves.toMatchObject({ rows: [{ resolution: 'RESOLVED_SUCCESS' }] });
  });

  test('issues workload HEAD recovery for safely stale STARTED and durable SUCCESS effects', async () => {
    const stale = await seedCapabilityDirectly('recovery-issuer-stale-started');
    const stalePut = await beginEffect(stale, 'recovery-issuer-stale-started-put');
    await expireAttemptAuthorization(
      stalePut.rows[0]!.attempt_id,
      stale.capabilityId,
      stale.effectIdentity,
    );
    const staleRenewedLease = randomUUID();
    await rotateSourceLease(stale.operationId, staleRenewedLease);
    const staleRecoveryId = randomUUID();
    await expect(
      lifecycle.query<{ capability_id: string | null }>(
        `SELECT issue_workload_object_recovery_head_capability(
           $1, $2, $3
         ) AS capability_id`,
        [stale.operationId, staleRenewedLease, staleRecoveryId],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: staleRecoveryId }] });
    await expect(
      migration.query(
        `SELECT effect.state, attempt.outcome
         FROM tenant_data_broker_effects effect
         JOIN tenant_data_broker_attempts attempt
           ON attempt.attempt_id = effect.active_attempt_id
         WHERE effect.effect_identity = $1`,
        [stale.effectIdentity],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: 'UNKNOWN', outcome: 'UNKNOWN' }],
    });
    await expect(loadCapability(staleRecoveryId, staleRenewedLease)).resolves.toMatchObject({
      operation: 'HEAD_WORKLOAD_OBJECT',
    });

    const succeeded = await seedCapabilityDirectly('recovery-issuer-success');
    const succeededPut = await beginEffect(succeeded, 'recovery-issuer-success-put');
    const durableReceipt = workloadReceipt(succeeded, 'durable-success-version');
    await finishEffect(succeeded, succeededPut.rows[0]!.attempt_id, 'SUCCESS', durableReceipt);
    const successRenewedLease = randomUUID();
    await rotateSourceLease(succeeded.operationId, successRenewedLease);
    const successRecoveryId = randomUUID();
    await expect(
      lifecycle.query<{ capability_id: string | null }>(
        `SELECT issue_workload_object_recovery_head_capability(
           $1, $2, $3
         ) AS capability_id`,
        [succeeded.operationId, successRenewedLease, successRecoveryId],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: successRecoveryId }] });
    const successRecovery = await loadCapability(successRecoveryId, successRenewedLease);
    const successProbe = await beginBrokerOperation(
      successRecoveryId,
      successRenewedLease,
      'HEAD_WORKLOAD_OBJECT',
      successRecovery.resource_hash,
    );
    await expect(
      broker.query(
        `SELECT resolve_tenant_data_broker_object_put_effect(
           $1, $2, 'FOUND', $3, $4, $5, $6
         ) AS resolution`,
        [
          successProbe.rows[0]!.attempt_id,
          successRenewedLease,
          durableReceipt.versionId,
          durableReceipt.checksum,
          durableReceipt.contentType,
          durableReceipt.byteLength,
        ],
      ),
    ).resolves.toMatchObject({ rows: [{ resolution: 'RESOLVED_SUCCESS' }] });
    await expect(
      migration.query(
        `SELECT state, success_receipt
         FROM tenant_data_broker_effects
         WHERE effect_identity = $1`,
        [succeeded.effectIdentity],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: 'SUCCESS', success_receipt: durableReceipt }],
    });

    const missingProbe = await beginBrokerOperation(
      successRecoveryId,
      successRenewedLease,
      'HEAD_WORKLOAD_OBJECT',
      successRecovery.resource_hash,
    );
    await expect(
      broker.query(
        `SELECT resolve_tenant_data_broker_object_put_effect(
           $1, $2, 'MISSING', NULL, NULL, NULL, NULL
         ) AS resolution`,
        [missingProbe.rows[0]!.attempt_id, successRenewedLease],
      ),
    ).resolves.toMatchObject({ rows: [{ resolution: 'NOT_RESOLVED' }] });
    await expect(
      migration.query(
        `SELECT state, success_receipt
         FROM tenant_data_broker_effects
         WHERE effect_identity = $1`,
        [succeeded.effectIdentity],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: 'SUCCESS', success_receipt: durableReceipt }],
    });
  });

  test('denies load and begin after lease rotation or capability expiry', async () => {
    const rotated = await seedCapabilityDirectly('lease-rotation');
    const replacementLease = randomUUID();
    await rotateSourceLease(rotated.operationId, replacementLease);

    for (const leaseToken of [rotated.leaseToken, replacementLease]) {
      await expect(
        broker.query('SELECT * FROM load_active_tenant_data_capability($1, $2)', [
          rotated.capabilityId,
          leaseToken,
        ]),
      ).resolves.toMatchObject({ rows: [] });
      await expect(
        beginEffect(rotated, `rotated-${leaseToken}`, leaseToken),
      ).resolves.toMatchObject({
        rows: [],
      });
    }

    const expired = await seedCapabilityDirectly('expired-capability', {
      issuedAt: new Date(Date.now() - 6 * 60_000),
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(
      broker.query('SELECT * FROM load_active_tenant_data_capability($1, $2)', [
        expired.capabilityId,
        expired.leaseToken,
      ]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(beginEffect(expired, 'expired-capability')).resolves.toMatchObject({ rows: [] });
  });

  test('rejects a secret-bearing or resource-unbound SUCCESS receipt without changing durable state', async () => {
    const capability = await seedCapabilityDirectly('receipt-validation');
    const started = await beginEffect(capability, 'receipt-validation');
    const attemptId = started.rows[0]!.attempt_id;

    await expect(
      finishEffect(capability, attemptId, 'SUCCESS', {
        secretValue: 'MUST_NOT_REACH_THE_EFFECT_JOURNAL',
      }),
    ).resolves.toMatchObject({ rows: [{ finished: false }] });
    await expect(
      migration.query(
        `SELECT attempt.outcome AS attempt_outcome, effect.state AS effect_state,
                effect.success_receipt
         FROM tenant_data_broker_attempts attempt
         JOIN tenant_data_broker_effects effect
           ON effect.effect_identity = attempt.effect_identity
         WHERE attempt.attempt_id = $1`,
        [attemptId],
      ),
    ).resolves.toMatchObject({
      rows: [{ attempt_outcome: 'STARTED', effect_state: 'STARTED', success_receipt: null }],
    });
    const leaked = await migration.query<{ leaked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM tenant_data_broker_effects
         WHERE success_receipt::text LIKE '%MUST_NOT_REACH_THE_EFFECT_JOURNAL%'
       ) AS leaked`,
    );
    expect(leaked.rows).toEqual([{ leaked: false }]);
  });

  test('persists one immutable SUCCESS receipt and returns it without redispatch', async () => {
    const capability = await seedCapabilityDirectly('success-receipt');
    const started = await beginEffect(capability, 'success-receipt');
    const receipt = workloadReceipt(capability, 'version-success');
    await expect(
      finishEffect(capability, started.rows[0]!.attempt_id, 'SUCCESS', receipt),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });

    await expect(beginEffect(capability, 'success-receipt-retry')).resolves.toMatchObject({
      rows: [
        {
          outcome: 'ALREADY_SUCCEEDED',
          success_receipt: receipt,
        },
      ],
    });
    await expect(
      finishEffect(capability, started.rows[0]!.attempt_id, 'SUCCESS', {
        ...receipt,
        versionId: 'tampered-version',
      }),
    ).resolves.toMatchObject({ rows: [{ finished: false }] });

    const durable = await migration.query(
      `SELECT attempt.outcome, effect.state, effect.success_receipt
       FROM tenant_data_broker_attempts attempt
       JOIN tenant_data_broker_effects effect
         ON effect.effect_identity = attempt.effect_identity
       WHERE attempt.attempt_id = $1`,
      [started.rows[0]!.attempt_id],
    );
    expect(durable.rows).toEqual([
      {
        outcome: 'SUCCESS',
        state: 'SUCCESS',
        success_receipt: receipt,
      },
    ]);
  });

  test('retries FAILED, fences UNKNOWN, and atomically records revocation after dispatch', async () => {
    const failed = await seedCapabilityDirectly('failed-retry');
    const first = await beginEffect(failed, 'failed-retry-1');
    await expect(
      finishEffect(failed, first.rows[0]!.attempt_id, 'FAILED', null),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });
    const retry = await beginEffect(failed, 'failed-retry-2');
    expect(retry.rows[0]?.outcome).toBe('STARTED');
    await expect(
      finishEffect(failed, retry.rows[0]!.attempt_id, 'UNKNOWN', null),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });
    await expect(beginEffect(failed, 'failed-retry-3')).resolves.toMatchObject({
      rows: [{ outcome: 'AMBIGUOUS' }],
    });

    const revoked = await seedCapabilityDirectly('revoked-after-dispatch');
    const dispatched = await beginEffect(revoked, 'revoked-after-dispatch');
    await rotateSourceLease(revoked.operationId, randomUUID());
    await expect(
      finishEffect(
        revoked,
        dispatched.rows[0]!.attempt_id,
        'SUCCESS',
        workloadReceipt(revoked, 'version-revoked'),
      ),
    ).resolves.toMatchObject({ rows: [{ finished: false }] });
    await expect(
      migration.query(
        `SELECT attempt.outcome AS attempt_outcome, effect.state AS effect_state,
                effect.success_receipt
         FROM tenant_data_broker_attempts attempt
         JOIN tenant_data_broker_effects effect
           ON effect.effect_identity = attempt.effect_identity
         WHERE attempt.attempt_id = $1`,
        [dispatched.rows[0]!.attempt_id],
      ),
    ).resolves.toMatchObject({
      rows: [{ attempt_outcome: 'UNKNOWN', effect_state: 'UNKNOWN', success_receipt: null }],
    });
  });

  test('a new capability after more than five minutes reuses the stable success effect', async () => {
    const original = await seedCapabilityDirectly('stable-effect-renewal');
    const first = await beginEffect(original, 'stable-effect-renewal-1');
    const receipt = workloadReceipt(original, 'version-stable');
    await expect(
      finishEffect(original, first.rows[0]!.attempt_id, 'SUCCESS', receipt),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });

    await migration.query(
      `WITH frozen AS (SELECT clock_timestamp() AS database_now)
       UPDATE tenant_data_capabilities
       SET issued_at = frozen.database_now - interval '11 minutes',
           expires_at = frozen.database_now - interval '6 minutes'
       FROM frozen
       WHERE capability_id = $1`,
      [original.capabilityId],
    );
    await migration.query(
      `UPDATE tenant_data_broker_attempts
       SET started_at = clock_timestamp() - interval '10 minutes',
           finished_at = clock_timestamp() - interval '10 minutes'
       WHERE attempt_id = $1`,
      [first.rows[0]!.attempt_id],
    );
    await migration.query(
      `UPDATE tenant_data_broker_effects
       SET updated_at = clock_timestamp() - interval '10 minutes'
       WHERE effect_identity = $1`,
      [original.effectIdentity],
    );

    const renewedLease = randomUUID();
    await rotateSourceLease(original.operationId, renewedLease);
    const renewed = await insertCapabilityForSource({
      ...original,
      capabilityId: randomUUID(),
      leaseToken: renewedLease,
    });
    await expect(beginEffect(renewed, 'stable-effect-renewal-2')).resolves.toMatchObject({
      rows: [{ outcome: 'ALREADY_SUCCEEDED', success_receipt: receipt }],
    });
    const durable = await migration.query<{ effect_count: string; started_count: string }>(
      `SELECT
         (SELECT count(*)::text FROM tenant_data_broker_effects
          WHERE effect_identity = $1) AS effect_count,
         (SELECT count(*)::text FROM tenant_data_broker_attempts
          WHERE effect_identity = $1 AND outcome = 'STARTED') AS started_count`,
      [original.effectIdentity],
    );
    expect(durable.rows).toEqual([{ effect_count: '1', started_count: '0' }]);
  });

  async function seedWorkloadSource(
    label: string,
  ): Promise<Omit<WorkloadCapability, 'capabilityId' | 'effectIdentity' | 'resourceHash'>> {
    const operationId = randomUUID();
    const leaseToken = randomUUID();
    const checksum = sha256(`payload:${label}`);
    const resource: WorkloadResource = {
      kind: 'WORKLOAD_OBJECT_PUT',
      objectClass: 'WORKLOAD_OBJECTS',
      bucket: WORKLOAD_BUCKET,
      key:
        `tenants/${fixture.tenantId}/workspaces/${fixture.workspaceId}/artifacts/` +
        `${randomUUID()}/revisions/1/${checksum}.json`,
      checksumSha256: checksum,
      contentType: 'application/json',
      byteLength: 128,
      lockedUntil: null,
      sealedAt: null,
    };
    await application.query(
      `SELECT * FROM reserve_workload_object_write_intent(
         $1, $2, $3, 'ARTIFACT_PAYLOAD', $4, $5, $6, $7
       )`,
      [
        operationId,
        fixture.tenantId,
        fixture.workspaceId,
        resource.key,
        checksum,
        resource.contentType,
        resource.byteLength,
      ],
    );
    await expect(
      application.query<{ claimed: boolean }>(
        'SELECT claim_workload_object_write_intent($1, $2, $3) AS claimed',
        [operationId, fixture.tenantId, leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ claimed: true }] });
    return { operationId, leaseToken, resource };
  }

  async function seedCapabilityDirectly(
    label: string,
    timing: { expiresAt?: Date; issuedAt?: Date } = {},
  ): Promise<WorkloadCapability> {
    const source = await seedWorkloadSource(label);
    return insertCapabilityForSource({
      ...source,
      capabilityId: randomUUID(),
      effectIdentity: `WORKLOAD_OBJECT_WRITE:${source.operationId}`,
      resourceHash: sha256(canonicalJson(source.resource)),
      ...(timing.issuedAt === undefined ? {} : { issuedAt: timing.issuedAt }),
      ...(timing.expiresAt === undefined ? {} : { expiresAt: timing.expiresAt }),
    });
  }

  async function insertCapabilityForSource(
    input: WorkloadCapability & { expiresAt?: Date; issuedAt?: Date },
  ): Promise<WorkloadCapability> {
    const now = Date.now();
    const issuedAt = input.issuedAt ?? new Date(now);
    const expiresAt = input.expiresAt ?? new Date(now + 90_000);
    const source = await migration.query<{ work_attempt_count: string }>(
      `SELECT work_attempt_count::text
       FROM workload_object_write_intents
       WHERE operation_id = $1`,
      [input.operationId],
    );
    await migration.query(
      `INSERT INTO tenant_data_capabilities (
         capability_id, source_kind, source_reference, source_revision,
         lease_token_sha256, effect_identity, authority_kind, authority_reference,
         scope_kind, tenant_id, workspace_id, operation, resource, resource_hash,
         issued_at, expires_at
       ) VALUES (
         $1, 'WORKLOAD_WRITE_INTENT', $2, $3,
         $4, $5, 'WORKLOAD_WRITE_INTENT', $2,
         'WORKSPACE', $6, $7, 'PUT_WORKLOAD_OBJECT', $8::jsonb, $9,
         $10, $11
       )`,
      [
        input.capabilityId,
        input.operationId,
        source.rows[0]!.work_attempt_count,
        sha256(input.leaseToken),
        input.effectIdentity,
        fixture.tenantId,
        fixture.workspaceId,
        JSON.stringify(input.resource),
        input.resourceHash,
        issuedAt,
        expiresAt,
      ],
    );
    return {
      capabilityId: input.capabilityId,
      effectIdentity: input.effectIdentity,
      leaseToken: input.leaseToken,
      operationId: input.operationId,
      resource: input.resource,
      resourceHash: input.resourceHash,
    };
  }

  function beginEffect(
    capability: WorkloadCapability,
    _nonceLabel: string,
    leaseToken = capability.leaseToken,
  ) {
    const signedAt = new Date();
    return broker.query<BeginRow>(
      `SELECT * FROM begin_authenticated_tenant_data_broker_effect(
         $1, $2, $3, $4, $5, 'PUT_WORKLOAD_OBJECT', $6
       )`,
      [
        randomUUID(),
        signedAt,
        new Date(signedAt.getTime() + 30_000),
        capability.capabilityId,
        leaseToken,
        capability.resourceHash,
      ],
    );
  }

  function finishEffect(
    capability: WorkloadCapability,
    attemptId: string,
    outcome: 'FAILED' | 'SUCCESS' | 'UNKNOWN',
    receipt: WorkloadReceipt | Record<string, unknown> | null,
  ) {
    return broker.query<{ finished: boolean }>(
      `SELECT finish_tenant_data_broker_effect(
         $1, $2, $3, $4::jsonb
       ) AS finished`,
      [
        attemptId,
        capability.leaseToken,
        outcome,
        receipt === null ? null : JSON.stringify(receipt),
      ],
    );
  }

  async function loadCapability(
    capabilityId: string,
    leaseToken: string,
  ): Promise<{ operation: string; resource_hash: string }> {
    const result = await broker.query<{ operation: string; resource_hash: string }>(
      `SELECT operation, resource_hash
       FROM load_active_tenant_data_capability($1, $2)`,
      [capabilityId, leaseToken],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('RECOVERY_CAPABILITY_NOT_ACTIVE');
    return row;
  }

  function beginBrokerOperation(
    capabilityId: string,
    leaseToken: string,
    operation: string,
    resourceHash: string,
  ) {
    const signedAt = new Date();
    return broker.query<BeginRow>(
      `SELECT * FROM begin_authenticated_tenant_data_broker_effect(
         $1, $2, $3, $4, $5, $6, $7
       )`,
      [
        randomUUID(),
        signedAt,
        new Date(signedAt.getTime() + 30_000),
        capabilityId,
        leaseToken,
        operation,
        resourceHash,
      ],
    );
  }

  async function expireAttemptAuthorization(
    attemptId: string,
    capabilityId: string,
    effectIdentity: string,
  ): Promise<void> {
    await migration.query(
      `WITH frozen AS (SELECT clock_timestamp() AS database_now)
       UPDATE tenant_data_capabilities
       SET issued_at = frozen.database_now - interval '4 minutes',
           expires_at = frozen.database_now - interval '2 minutes'
       FROM frozen
       WHERE capability_id = $1`,
      [capabilityId],
    );
    await migration.query(
      `WITH frozen AS (SELECT clock_timestamp() AS database_now)
       UPDATE tenant_data_broker_nonces nonce
       SET signed_at = frozen.database_now - interval '3 minutes',
           expires_at =
             frozen.database_now - interval '2 minutes 30 seconds',
           first_seen_at = frozen.database_now - interval '3 minutes'
       FROM tenant_data_broker_attempts attempt, frozen
       WHERE attempt.attempt_id = $1
         AND nonce.nonce = attempt.nonce`,
      [attemptId],
    );
    await migration.query(
      `UPDATE tenant_data_broker_attempts
       SET started_at = clock_timestamp() - interval '2 minutes'
       WHERE attempt_id = $1`,
      [attemptId],
    );
    await migration.query(
      `UPDATE tenant_data_broker_effects
       SET updated_at = clock_timestamp() - interval '2 minutes'
       WHERE effect_identity = $1`,
      [effectIdentity],
    );
  }

  async function rotateSourceLease(operationId: string, leaseToken: string): Promise<void> {
    await migration.query(
      `UPDATE workload_object_write_intents
       SET work_lease_token = $2,
           work_lease_expires_at = clock_timestamp() + interval '2 minutes',
           work_attempt_count = work_attempt_count + 1,
           updated_at = clock_timestamp()
       WHERE operation_id = $1`,
      [operationId, leaseToken],
    );
  }
});

function loginPool(
  container: StartedPostgreSqlContainer,
  user: string,
  password: string,
  max: number,
): Pool {
  return new Pool({
    database: container.getDatabase(),
    host: container.getHost(),
    max,
    password,
    port: container.getPort(),
    user,
  });
}

async function bootstrapTenant(pool: Pool): Promise<TenantFixture> {
  const fixture = {
    actorUserId: randomUUID(),
    auditEventId: randomUUID(),
    membershipId: randomUUID(),
    roleBindingId: randomUUID(),
    tenantId: randomUUID(),
    workspaceId: randomUUID(),
  };
  await pool.query(
    `SELECT * FROM bootstrap_tenant(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
     )`,
    [
      'task18-tenant-data-broker-database-owner',
      'task18-tenant-data-broker-database-owner@example.test',
      fixture.actorUserId,
      fixture.tenantId,
      'Task18 Tenant Data Broker Database Tenant',
      fixture.workspaceId,
      'Task18 Tenant Data Broker Database Workspace',
      fixture.membershipId,
      fixture.roleBindingId,
      fixture.auditEventId,
    ],
  );
  return fixture;
}

async function seedResourceAuthority(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_data_broker_resource_authority (
       singleton, workload_bucket, tenant_export_bucket, audit_evidence_bucket,
       aws_account_id, kms_key_arn, configured_at
     ) VALUES (true, $1, $1, $2, $3, $4, clock_timestamp())
     ON CONFLICT (singleton) DO NOTHING`,
    [WORKLOAD_BUCKET, AUDIT_BUCKET, ACCOUNT_ID, KMS_KEY_ARN],
  );
}

function workloadReceipt(capability: WorkloadCapability, versionId: string): WorkloadReceipt {
  return {
    bucket: capability.resource.bucket,
    key: capability.resource.key,
    versionId,
    checksum: capability.resource.checksumSha256,
    contentType: capability.resource.contentType,
    byteLength: capability.resource.byteLength,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
