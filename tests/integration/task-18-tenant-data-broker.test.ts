import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  TenantDataBrokerAuthorizer,
  type TenantDataAccessGrant,
} from '@aeostudio/application/tenant-data-access';
import {
  PostgresTenancyStore,
  PostgresWorkloadObjectWriteIntentStore,
  runMigrations,
} from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const ARTIFACT_BUCKET = 'aeostudio-staging-123456789012-artifacts';
const AUDIT_BUCKET = 'aeostudio-staging-123456789012-audit';
const ACCOUNT_ID = '123456789012';
const KMS_KEY_ARN =
  'arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-4000-8000-000000000018';

interface WorkloadCapability {
  capabilityId: string;
  leaseToken: string;
  operationId: string;
  resource: {
    bucket: string;
    byteLength: number;
    checksumSha256: string;
    contentType: string;
    key: string;
  };
  resourceHash: string;
}

interface PrivacyCapability {
  capabilityId: string;
  leaseToken: string;
  operationId: string;
  resource: {
    bucket: string;
    byteLength: number;
    checksumSha256: string;
    contentType: string;
    key: string;
  };
  resourceHash: string;
}

describe('Task 18 Tenant Data Broker PostgreSQL authority and effect fence', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let workloadStore: PostgresWorkloadObjectWriteIntentStore;
  let tenantId: string;
  let workspaceId: string;
  let ownerUserId: string;
  let deletionTenantId: string;
  let deletionWorkspaceId: string;
  let deletionOwnerUserId: string;
  let deletionRequestId: string;
  let deletionLeaseToken: string;
  let deletionWorkloadKey: string;
  let deletionWorkloadVersionId: string;
  let deletionExportKey: string;
  let deletionExportVersionId: string;
  let legalHoldAuditKey: string;
  let legalHoldAuditVersionId: string;
  let legalHoldLeaseToken: string;
  let liveLegalHoldId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 25 });
    await runMigrations(
      pool,
      fileURLToPath(new URL('../../packages/db/migrations', import.meta.url)),
    );
    tenantId = randomUUID();
    workspaceId = randomUUID();
    ownerUserId = randomUUID();
    await new PostgresTenancyStore(pool).bootstrapTenant({
      actorSubject: 'task18-tenant-data-broker-owner',
      actorEmail: 'task18-tenant-data-broker-owner@example.test',
      userId: ownerUserId,
      tenantId,
      tenantName: 'Task18 Tenant Data Broker Tenant',
      workspaceId,
      workspaceName: 'Task18 Tenant Data Broker Workspace',
      membershipId: randomUUID(),
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    workloadStore = new PostgresWorkloadObjectWriteIntentStore(pool);

    // The migration login owns this one-row authority. Runtime principals have
    // no table access and cannot select a different bucket/account/KMS key.
    await pool.query(
      `INSERT INTO tenant_data_broker_resource_authority (
         singleton, workload_bucket, tenant_export_bucket,
         audit_evidence_bucket, aws_account_id, kms_key_arn, configured_at
       ) VALUES (true, $1, $1, $2, $3, $4, clock_timestamp())`,
      [ARTIFACT_BUCKET, AUDIT_BUCKET, ACCOUNT_ID, KMS_KEY_ARN],
    );

    deletionTenantId = randomUUID();
    deletionWorkspaceId = randomUUID();
    deletionOwnerUserId = randomUUID();
    deletionRequestId = randomUUID();
    deletionLeaseToken = randomUUID();
    legalHoldLeaseToken = randomUUID();
    liveLegalHoldId = randomUUID();
    await new PostgresTenancyStore(pool).bootstrapTenant({
      actorSubject: 'task18-tenant-data-broker-deletion-owner',
      actorEmail: 'task18-tenant-data-broker-deletion-owner@example.test',
      userId: deletionOwnerUserId,
      tenantId: deletionTenantId,
      tenantName: 'Task18 Tenant Data Broker Deletion Tenant',
      workspaceId: deletionWorkspaceId,
      workspaceName: 'Task18 Tenant Data Broker Deletion Workspace',
      membershipId: randomUUID(),
      roleBindingId: randomUUID(),
      auditEventId: randomUUID(),
    });
    const deletionRequestedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    await pool.query(
      `INSERT INTO deletion_requests (
         id, tenant_id, workspace_id, scope_kind, state, requested_by_user_id,
         requested_membership_id, requested_workspace_id,
         requested_subject_digest, reason, request_hash, requested_at, frozen_at,
         active_delete_by, backup_delete_by, secret_force_delete_by,
         finalization_lease_token, finalization_lease_expires_at,
         finalization_attempt_count, finalization_last_claimed_at
       ) VALUES (
         $1, $2, $3, 'WORKSPACE', 'FROZEN', $4, $5, $3, $6,
         'Broker physical deletion fixture', $7, $8::timestamptz, $8::timestamptz,
         $8::timestamptz + interval '30 days',
         $8::timestamptz + interval '90 days',
         $8::timestamptz + interval '24 hours',
         $9, clock_timestamp() + interval '5 minutes', 1, clock_timestamp()
       )`,
      [
        deletionRequestId,
        deletionTenantId,
        deletionWorkspaceId,
        deletionOwnerUserId,
        randomUUID(),
        sha256(`subject:${deletionRequestId}`),
        sha256(`request:${deletionRequestId}`),
        deletionRequestedAt,
        deletionLeaseToken,
      ],
    );
    await pool.query(
      `INSERT INTO privacy_object_inventory_requirements (
         scope_tenant_id, required_at
       ) VALUES ($1, clock_timestamp())`,
      [deletionTenantId],
    );
    const inventoryCursor = Buffer.from(
      JSON.stringify({
        keyMarker: `tenants/${deletionTenantId}/exports/page-1`,
        versionIdMarker: 'inventory-version-1',
      }),
      'utf8',
    ).toString('base64url');
    await pool.query(
      `INSERT INTO privacy_object_inventory_page_progress (
         deletion_request_id, tenant_id, scope_kind, workspace_id,
         export_cursor, updated_at
       ) VALUES ($1, $2, 'WORKSPACE', $3, $4, clock_timestamp())`,
      [deletionRequestId, deletionTenantId, deletionWorkspaceId, inventoryCursor],
    );

    deletionWorkloadKey =
      `tenants/${deletionTenantId}/workspaces/${deletionWorkspaceId}/artifacts/` +
      `${randomUUID()}/revisions/1/${'c'.repeat(64)}.json`;
    deletionWorkloadVersionId = 'workload-delete-version-1';
    deletionExportKey = `tenants/${deletionTenantId}/exports/${randomUUID()}.bundle.json`;
    deletionExportVersionId = 'export-delete-version-1';
    legalHoldAuditKey = `tenants/${deletionTenantId}/audit-digests/2026/07/23/${randomUUID()}.json`;
    legalHoldAuditVersionId = 'audit-hold-version-1';
    await pool.query(
      `INSERT INTO managed_object_versions (
         id, tenant_id, workspace_id, object_class, object_ref, object_key,
         object_version_id, checksum, content_type, byte_length,
         lifecycle_state, created_at
       ) VALUES
       ($1, $2, $3, 'ARTIFACT_PAYLOAD', $4, $5, $6, $7,
        'application/json', 128, 'ACTIVE', clock_timestamp()),
       ($8, $2, $3, 'TENANT_EXPORT', $9, $10, $11, $12,
        'application/json', 256, 'ACTIVE', clock_timestamp()),
       ($13, $2, $3, 'AUDIT_DIGEST', $14, $15, $16, $17,
        'application/json', 512, 'ACTIVE', clock_timestamp())`,
      [
        randomUUID(),
        deletionTenantId,
        deletionWorkspaceId,
        `s3://${ARTIFACT_BUCKET}/${deletionWorkloadKey}`,
        deletionWorkloadKey,
        deletionWorkloadVersionId,
        'c'.repeat(64),
        randomUUID(),
        `s3://${ARTIFACT_BUCKET}/${deletionExportKey}`,
        deletionExportKey,
        deletionExportVersionId,
        'd'.repeat(64),
        randomUUID(),
        `s3://${AUDIT_BUCKET}/${legalHoldAuditKey}`,
        legalHoldAuditKey,
        legalHoldAuditVersionId,
        'e'.repeat(64),
      ],
    );
    await pool.query(
      `INSERT INTO legal_hold_object_reconciliations (
         tenant_id, object_key, object_version_id, object_class,
         desired_status, desired_revision, applied_status, applied_revision,
         work_lease_token, work_lease_expires_at, work_attempt_count, updated_at
       ) VALUES (
         $1, $2, $3, 'AUDIT_DIGEST', 'ON', 1, 'UNKNOWN', 0,
         $4, clock_timestamp() + interval '5 minutes', 1, clock_timestamp()
       )`,
      [deletionTenantId, legalHoldAuditKey, legalHoldAuditVersionId, legalHoldLeaseToken],
    );
    await pool.query(
      `INSERT INTO legal_holds (
         id, tenant_id, workspace_id, name, reason, visible_to_tenant,
         status, created_by_user_id, created_at, audit_event_id
       ) VALUES (
         $1, $2, $3, 'Task18 broker live hold',
         'Validates live legal hold source state', true, 'ACTIVE',
         $4, clock_timestamp(), $5
       )`,
      [liveLegalHoldId, deletionTenantId, deletionWorkspaceId, deletionOwnerUserId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO legal_hold_object_versions (
         tenant_id, hold_id, object_key, object_version_id
       ) VALUES ($1, $2, $3, $4)`,
      [deletionTenantId, liveLegalHoldId, legalHoldAuditKey, legalHoldAuditVersionId],
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  test('reconciles exactly one immutable resource authority and rejects drift', async () => {
    await expect(
      pool.query(
        `SELECT configure_tenant_data_broker_resource_authority($1, $1, $2, $3, $4)
           AS configured`,
        [ARTIFACT_BUCKET, AUDIT_BUCKET, ACCOUNT_ID, KMS_KEY_ARN],
      ),
    ).resolves.toMatchObject({ rows: [{ configured: true }] });

    await expect(
      pool.query(`SELECT configure_tenant_data_broker_resource_authority($1, $2, $3, $4, $5)`, [
        ARTIFACT_BUCKET,
        'different-export-bucket',
        AUDIT_BUCKET,
        ACCOUNT_ID,
        KMS_KEY_ARN,
      ]),
    ).rejects.toThrow(/TENANT_DATA_BROKER_RESOURCE_AUTHORITY_INVALID/u);
    await expect(
      pool.query(`SELECT configure_tenant_data_broker_resource_authority($1, $1, $2, $3, $4)`, [
        'different-artifact-bucket',
        AUDIT_BUCKET,
        ACCOUNT_ID,
        KMS_KEY_ARN,
      ]),
    ).rejects.toThrow(/TENANT_DATA_BROKER_RESOURCE_AUTHORITY_DRIFT/u);
    for (const invalidBucket of [
      '192.168.0.1',
      'invalid..bucket',
      'invalid.-bucket',
      'invalid-.bucket',
    ]) {
      await expect(
        pool.query(
          `SELECT configure_tenant_data_broker_resource_authority(
             $1, $1, $2, $3, $4
           )`,
          [invalidBucket, AUDIT_BUCKET, ACCOUNT_ID, KMS_KEY_ARN],
        ),
      ).rejects.toThrow(/TENANT_DATA_BROKER_RESOURCE_AUTHORITY_INVALID/u);
    }
  });

  test.each(['TENANT_EXPORT', 'AUDIT_DIGEST'] as const)(
    'rejects fixed-placement %s rows relabeled as workload objects',
    async (objectClass) => {
      const objectKey = `tenants/${tenantId}/workspaces/${workspaceId}/invalid-placement/${randomUUID()}.json`;
      await expect(
        pool.query(
          `INSERT INTO managed_object_versions (
             id, tenant_id, workspace_id, object_class, object_ref, object_key,
             object_version_id, checksum, content_type, byte_length,
             lifecycle_state, created_at, storage_class
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8,
             'application/json', 32, 'ACTIVE', clock_timestamp(),
             'WORKLOAD_OBJECTS'
           )`,
          [
            randomUUID(),
            tenantId,
            workspaceId,
            objectClass,
            `s3://${ARTIFACT_BUCKET}/${objectKey}`,
            objectKey,
            randomUUID(),
            'f'.repeat(64),
          ],
        ),
      ).rejects.toThrow(/MANAGED_OBJECT_WORKLOAD_CLASS_INVALID/u);
    },
  );

  test('does not let stale reconciliation rows for deleted objects starve live legal-hold work', async () => {
    const staleTargets: Array<{ key: string; versionId: string }> = [];
    for (let index = 0; index < 25; index += 1) {
      const key = `tenants/${tenantId}/workspaces/${workspaceId}/stale-holds/${index}.json`;
      const versionId = `deleted-stale-${index}`;
      staleTargets.push({ key, versionId });
      await pool.query(
        `INSERT INTO managed_object_versions (
           id, tenant_id, workspace_id, object_class, object_ref, object_key,
           object_version_id, checksum, content_type, byte_length,
           lifecycle_state, created_at, deleted_at, storage_class
         ) VALUES (
           $1, $2, $3, 'APPLICATION_LOG', $4, $5, $6, $7,
           'application/json', 32, 'DELETED', clock_timestamp() - interval '2 hours',
           clock_timestamp() - interval '1 hour', 'WORKLOAD_OBJECTS'
         )`,
        [
          randomUUID(),
          tenantId,
          workspaceId,
          `s3://${ARTIFACT_BUCKET}/${key}`,
          key,
          versionId,
          sha256(`${key}:${versionId}`),
        ],
      );
      await pool.query(
        `INSERT INTO legal_hold_object_reconciliations (
           tenant_id, object_key, object_version_id, object_class,
           desired_status, desired_revision, applied_status, applied_revision,
           work_attempt_count, updated_at
         ) VALUES (
           $1, $2, $3, 'APPLICATION_LOG', 'OFF', 2, 'ON', 1, 0,
           clock_timestamp() - interval '1 hour'
         )`,
        [tenantId, key, versionId],
      );
    }

    const liveKey = `tenants/${tenantId}/workspaces/${workspaceId}/live-holds/${randomUUID()}.json`;
    const liveVersionId = 'live-hold-version';
    await pool.query(
      `INSERT INTO managed_object_versions (
         id, tenant_id, workspace_id, object_class, object_ref, object_key,
         object_version_id, checksum, content_type, byte_length,
         lifecycle_state, created_at, storage_class
       ) VALUES (
         $1, $2, $3, 'APPLICATION_LOG', $4, $5, $6, $7,
         'application/json', 32, 'ACTIVE', clock_timestamp(), 'WORKLOAD_OBJECTS'
       )`,
      [
        randomUUID(),
        tenantId,
        workspaceId,
        `s3://${ARTIFACT_BUCKET}/${liveKey}`,
        liveKey,
        liveVersionId,
        sha256(`${liveKey}:${liveVersionId}`),
      ],
    );
    await pool.query(
      `INSERT INTO legal_hold_object_reconciliations (
         tenant_id, object_key, object_version_id, object_class,
         desired_status, desired_revision, applied_status, applied_revision,
         work_attempt_count, updated_at
       ) VALUES (
         $1, $2, $3, 'APPLICATION_LOG', 'ON', 1, 'UNKNOWN', 0, 0,
         clock_timestamp()
       )`,
      [tenantId, liveKey, liveVersionId],
    );

    const leaseToken = randomUUID();
    const claimed = await pool.query<{ object_key: string; object_version_id: string }>(
      `SELECT object_key, object_version_id
       FROM claim_pending_legal_hold_reconciliations($1, 25)`,
      [leaseToken],
    );
    expect(claimed.rows).toEqual([{ object_key: liveKey, object_version_id: liveVersionId }]);
    expect(claimed.rows).not.toEqual(
      expect.arrayContaining(
        staleTargets.map(({ key, versionId }) => ({
          object_key: key,
          object_version_id: versionId,
        })),
      ),
    );
  });

  test('issues an exact database-derived workload grant and returns only the lease digest', async () => {
    const capability = await createWorkloadCapability('exact-grant');
    const result = await pool.query<{
      lease_token_sha256: string;
      operation: string;
      resource: Record<string, unknown>;
      resource_hash: string;
    }>(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
      capability.capabilityId,
      capability.leaseToken,
    ]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      lease_token_sha256: sha256(capability.leaseToken),
      operation: 'PUT_WORKLOAD_OBJECT',
      resource: {
        kind: 'WORKLOAD_OBJECT_PUT',
        objectClass: 'WORKLOAD_OBJECTS',
        bucket: ARTIFACT_BUCKET,
      },
      resource_hash: capability.resourceHash,
    });
    expect(result.fields.map((field) => field.name)).not.toContain('lease_token');
    expect(capability.resourceHash).toBe(sha256(canonicalJson(result.rows[0]!.resource)));

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'tenant_data_capabilities'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain('source_lease_token');

    const unknownPut = await beginEffect(capability, sha256('workload-recovery-head-unknown'));
    await expect(
      pool.query(
        `SELECT finish_tenant_data_broker_effect(
           $1, $2, 'UNKNOWN', NULL
         ) AS finished`,
        [unknownPut.rows[0]!.attempt_id, capability.leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });
    const recoveryCapabilityId = randomUUID();
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_workload_object_recovery_head_capability($1, $2, $3)
           AS capability_id`,
        [capability.operationId, capability.leaseToken, recoveryCapabilityId],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: recoveryCapabilityId }] });
    await expect(
      pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        recoveryCapabilityId,
        capability.leaseToken,
      ]),
    ).resolves.toMatchObject({
      rows: [
        {
          operation: 'HEAD_WORKLOAD_OBJECT',
          resource: {
            kind: 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD',
            objectClass: 'WORKLOAD_OBJECTS',
            bucket: ARTIFACT_BUCKET,
            key: capability.resource.key,
            expectedChecksumSha256: capability.resource.checksumSha256,
            expectedContentType: capability.resource.contentType,
            expectedByteLength: capability.resource.byteLength,
            lockedUntil: null,
            sealedAt: null,
          },
        },
      ],
    });
  });

  test('binds publication reads to one checksum-keyed managed package version', async () => {
    const now = new Date();
    const contentPlanId = randomUUID();
    const opportunityId = randomUUID();
    const briefId = randomUUID();
    const artifactId = randomUUID();
    const artifactRevisionId = randomUUID();
    const channelDefinitionId = randomUUID();
    const channelPackageId = randomUUID();
    const authorizationId = randomUUID();
    const adapterVersionId = randomUUID();
    const publicationId = randomUUID();
    const jobId = randomUUID();
    const leaseToken = randomUUID();
    const contentHash = sha256(`publication-content:${publicationId}`);
    const packageChecksum = sha256(`publication-package:${publicationId}`);
    const payloadObjectRef = `s3://${ARTIFACT_BUCKET}/packages/${channelPackageId}`;
    const canonicalObjectKey =
      `tenants/${tenantId}/workspaces/${workspaceId}/channel-packages/` + `${packageChecksum}.json`;
    const forgedObjectKey =
      `tenants/${tenantId}/workspaces/${workspaceId}/channel-packages/` + `${'0'.repeat(64)}.json`;
    const target = `https://publication-${publicationId}.example.test`;
    const channelKey = `task18-package-${channelDefinitionId}`;

    await pool.query(
      `INSERT INTO content_plans (
         id, tenant_id, workspace_id, status, method_policy_version,
         input_snapshot, content_hash, created_by_user_id, created_at, completed_at
       ) VALUES (
         $1, $2, $3, 'READY', 'task18-package-v1', '{}'::jsonb,
         $4, $5, $6, $6
       )`,
      [contentPlanId, tenantId, workspaceId, contentHash, ownerUserId, now],
    );
    await pool.query(
      `INSERT INTO opportunities (
         id, tenant_id, workspace_id, content_plan_id, opportunity_key,
         asset_kind, business_value, evidence_readiness, visibility_gap,
         effort, risk, priority_score, priority_rank, rank_reason, action,
         evidence_ready, publish_ready
       ) VALUES (
         $1, $2, $3, $4, 'DEFINITION_PRODUCT', 'DEFINITION_PRODUCT',
         100, 100, '{}'::jsonb, 1, 1, 99, 1, 'Task18 package binding',
         'BRIEF', true, false
       )`,
      [opportunityId, tenantId, workspaceId, contentPlanId],
    );
    await pool.query(
      `INSERT INTO briefs (
         id, tenant_id, workspace_id, content_plan_id, opportunity_id,
         brief_key, asset_kind, title, prompt_ids, claim_revision_ids,
         source_artifact_ids, status, evidence_ready, publish_ready,
         content_hash, created_by_user_id, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'DEFINITION_PRODUCT', 'DEFINITION_PRODUCT',
         'Task18 package binding', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
         'APPROVED', true, false, $6, $7, $8
       )`,
      [briefId, tenantId, workspaceId, contentPlanId, opportunityId, contentHash, ownerUserId, now],
    );
    await pool.query(
      `INSERT INTO artifacts (
         id, tenant_id, workspace_id, brief_id, artifact_type,
         current_revision, status, locale, market, method_policy_version,
         created_by_user_id, created_at
       ) VALUES (
         $1, $2, $3, $4, 'DEFINITION_PRODUCT', 1, 'APPROVED',
         'zh-CN', 'CN', 'task18-package-v1', $5, $6
       )`,
      [artifactId, tenantId, workspaceId, briefId, ownerUserId, now],
    );
    await pool.query(
      `INSERT INTO artifact_revisions (
         id, tenant_id, workspace_id, artifact_id, revision, brief_id,
         artifact_type, schema_version, content_hash, status, locale, market,
         source_artifact_ids, lineage, claim_bindings, method_policy_version,
         created_by_actor_kind, created_by_actor_id, created_at,
         payload_object_ref
       ) VALUES (
         $1, $2, $3, $4, 1, $5, 'DEFINITION_PRODUCT', '1.0.0', $6,
         'APPROVED', 'zh-CN', 'CN', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb,
         'task18-package-v1', 'USER', $7, $8, 'memory://task18-artifact'
       )`,
      [
        artifactRevisionId,
        tenantId,
        workspaceId,
        artifactId,
        briefId,
        contentHash,
        ownerUserId,
        now,
      ],
    );
    await pool.query(
      `INSERT INTO channel_definitions (
         id, channel_key, display_name, status, package_transformer_key,
         package_schema_version, created_at, updated_at
       ) VALUES (
         $1, $2, 'Task18 package binding', 'AVAILABLE',
         'task18-package-transformer', '1.0.0', $3, $3
       )`,
      [channelDefinitionId, channelKey, now],
    );
    await pool.query(
      `INSERT INTO adapter_versions (
         id, channel_definition_id, adapter_key, adapter_version, enabled,
         capabilities, required_scopes, terms_version, terms_status,
         processing_region, retention_policy, training_policy, subprocessors,
         rate_policy, created_at
       ) VALUES (
         $1, $2, 'task18-package-adapter', '1.0.0', true,
         ARRAY['PUBLISH','RECONCILE'], ARRAY['publish:write'],
         'task18-terms-v1', 'ALLOWED', 'ap-southeast-1', 'No retention.',
         'No training.', '[]'::jsonb, '{"mode":"test"}'::jsonb, $3
       )`,
      [adapterVersionId, channelDefinitionId, now],
    );
    await pool.query(
      `INSERT INTO channel_authorizations (
         id, tenant_id, workspace_id, adapter_version_id, status, secret_arn,
         granted_scopes, accepted_terms_version, target, created_by_user_id,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'ACTIVE',
         $5, ARRAY['publish:write'], 'task18-terms-v1', $6, $7, $8, $8
       )`,
      [
        authorizationId,
        tenantId,
        workspaceId,
        adapterVersionId,
        `arn:aws:secretsmanager:ap-southeast-1:${ACCOUNT_ID}:secret:tenant-${tenantId}/workspace-${workspaceId}/publication`,
        target,
        ownerUserId,
        now,
      ],
    );
    await pool.query(
      `INSERT INTO managed_object_versions (
         id, tenant_id, workspace_id, object_class, object_ref, object_key,
         object_version_id, checksum, content_type, byte_length,
         lifecycle_state, created_at
       ) VALUES (
         $1, $2, $3, 'CHANNEL_PACKAGE', $4, $5, 'forged-version',
         $6, 'application/json', 256, 'ACTIVE', $7
       )`,
      [
        randomUUID(),
        tenantId,
        workspaceId,
        payloadObjectRef,
        forgedObjectKey,
        packageChecksum,
        now,
      ],
    );
    await pool.query(
      `INSERT INTO channel_packages (
         id, tenant_id, workspace_id, package_revision, channel_definition_id,
         channel_key, transformer_key, transformer_version,
         package_schema_version, artifact_id, artifact_revision_id,
         artifact_revision, artifact_content_hash, artifact_type,
         artifact_locale, artifact_market, artifact_method_policy_version,
         manifest, package_checksum, payload_object_ref, created_by_user_id,
         created_at
       ) VALUES (
         $1, $2, $3, 1, $4, $5, 'task18-package-transformer', '1.0.0',
         '1.0.0', $6, $7, 1, $8, 'DEFINITION_PRODUCT', 'zh-CN', 'CN',
         'task18-package-v1',
         '{"schemaVersion":"1.0.0","files":[],"assetRefs":[],"claimSourceMap":[]}'::jsonb,
         $9, $10, $11, $12
       )`,
      [
        channelPackageId,
        tenantId,
        workspaceId,
        channelDefinitionId,
        channelKey,
        artifactId,
        artifactRevisionId,
        contentHash,
        packageChecksum,
        payloadObjectRef,
        ownerUserId,
        now,
      ],
    );
    await pool.query(
      `INSERT INTO jobs (
         id, tenant_id, workspace_id, job_type, aggregate_id, status, progress,
         attempt, max_attempts, idempotency_key, estimated_units,
         requested_by_user_id, lease_token, lease_expires_at, heartbeat_at,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'PUBLICATION', $4, 'RUNNING', 10, 1, 3, $5, 5,
         $6, $7, clock_timestamp() + interval '5 minutes', clock_timestamp(),
         clock_timestamp(), clock_timestamp()
       )`,
      [
        jobId,
        tenantId,
        workspaceId,
        publicationId,
        `task18-package-job-${jobId}`,
        ownerUserId,
        leaseToken,
      ],
    );
    await pool.query(
      `INSERT INTO publication_records (
         id, tenant_id, workspace_id, channel_package_id, package_checksum,
         artifact_revision_id, artifact_content_hash, adapter_version_id,
         channel_authorization_id, authorization_target, target,
         idempotency_key, request_hash, status, job_id, requested_by_user_id,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10,
         $11, $12, 'RUNNING', $13, $14, clock_timestamp(), clock_timestamp()
       )`,
      [
        publicationId,
        tenantId,
        workspaceId,
        channelPackageId,
        packageChecksum,
        artifactRevisionId,
        contentHash,
        adapterVersionId,
        authorizationId,
        target,
        `task18-package-publication-${publicationId}`,
        sha256(`request:${publicationId}`),
        jobId,
        ownerUserId,
      ],
    );

    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_publication_package_read_capability(
           $1, $2, $3
         ) AS capability_id`,
        [publicationId, leaseToken, randomUUID()],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: null }] });

    const exactVersionId = 'exact-package-version';
    await pool.query(
      `INSERT INTO managed_object_versions (
         id, tenant_id, workspace_id, object_class, object_ref, object_key,
         object_version_id, checksum, content_type, byte_length,
         lifecycle_state, created_at
       ) VALUES (
         $1, $2, $3, 'CHANNEL_PACKAGE', $4, $5, $6, $7,
         'application/json', 256, 'ACTIVE', clock_timestamp()
       )`,
      [
        randomUUID(),
        tenantId,
        workspaceId,
        payloadObjectRef,
        canonicalObjectKey,
        exactVersionId,
        packageChecksum,
      ],
    );
    const exactCapabilityId = randomUUID();
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_publication_package_read_capability(
           $1, $2, $3
         ) AS capability_id`,
        [publicationId, leaseToken, exactCapabilityId],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: exactCapabilityId }] });
    await expect(
      pool.query(
        `SELECT operation, resource
         FROM load_active_tenant_data_capability($1, $2)`,
        [exactCapabilityId, leaseToken],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          operation: 'READ_WORKLOAD_OBJECT',
          resource: {
            kind: 'OBJECT_VERSION',
            objectClass: 'WORKLOAD_OBJECTS',
            bucket: ARTIFACT_BUCKET,
            key: canonicalObjectKey,
            versionId: exactVersionId,
            checksumSha256: packageChecksum,
            contentType: 'application/json',
            byteLength: 256,
          },
        },
      ],
    });
    await expect(
      pool.query(
        `INSERT INTO managed_object_versions (
           id, tenant_id, workspace_id, object_class, object_ref, object_key,
           object_version_id, checksum, content_type, byte_length,
           lifecycle_state, created_at
         ) VALUES (
           $1, $2, $3, 'CHANNEL_PACKAGE', $4, $5, 'duplicate-package-version',
           $6, 'application/json', 256, 'ACTIVE', clock_timestamp()
         )`,
        [
          randomUUID(),
          tenantId,
          workspaceId,
          payloadObjectRef,
          canonicalObjectKey,
          packageChecksum,
        ],
      ),
    ).rejects.toThrow(/CHANNEL_PACKAGE_OBJECT_BINDING_AMBIGUOUS/u);
  });

  test('denies load and begin immediately after the authoritative source lease changes', async () => {
    const capability = await createWorkloadCapability('lease-revocation');
    await pool.query(
      `UPDATE workload_object_write_intents
       SET work_lease_token = $2,
           work_lease_expires_at = clock_timestamp() + interval '2 minutes'
       WHERE operation_id = $1`,
      [capability.operationId, randomUUID()],
    );

    await expect(
      pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        capability.capabilityId,
        capability.leaseToken,
      ]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(beginEffect(capability, sha256(randomUUID()))).resolves.toMatchObject({
      rows: [],
    });
  });

  test('derives a tenant-scoped privacy PUT grant and revokes it with the source lease', async () => {
    const operationId = randomUUID();
    const leaseToken = randomUUID();
    const capabilityId = randomUUID();
    const payload = Buffer.from('{"schemaVersion":"1.0.0","objects":[]}', 'utf8');
    const checksum = createHash('sha256').update(payload).digest('hex');
    const objectKey = `tenants/${tenantId}/exports/${operationId}.bundle.json`;
    const manifest = {
      schemaVersion: '1.0.0',
      tenantId,
      timeRange: {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-02T00:00:00.000Z',
      },
      objects: [],
      files: [],
      disclosures: {},
    };
    await pool.query(
      `INSERT INTO tenant_exports (
         id, tenant_id, workspace_id, schema_version, status, requested_by_user_id,
         request_hash, requested_at, range_from, range_to, manifest, checksum
       ) VALUES (
         $1, $2, $3, '1.0.0', 'ARCHIVE_PENDING', $4, $5,
         clock_timestamp(), '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z',
         $6::jsonb, $7
       )`,
      [
        operationId,
        tenantId,
        workspaceId,
        ownerUserId,
        sha256(`privacy-request:${operationId}`),
        JSON.stringify(manifest),
        sha256(canonicalJson(manifest)),
      ],
    );
    await pool.query(
      `INSERT INTO privacy_object_write_intents (
         operation_id, tenant_id, workspace_id, kind, request_identity,
         business_id, actor_user_id, audit_event_id, object_key,
         canonical_payload, checksum, content_type, byte_length,
         sealed_at, locked_until, business_payload, status, created_at, updated_at,
         work_lease_token, work_lease_expires_at, work_attempt_count
       ) VALUES (
         $1, $2, $3, 'TENANT_EXPORT', $4, $1, $5, $6, $7,
         $8, $9, 'application/json', $10,
         NULL, NULL, $11::jsonb, 'PENDING', clock_timestamp(), clock_timestamp(),
         $12, clock_timestamp() + interval '2 minutes', 1
       )`,
      [
        operationId,
        tenantId,
        workspaceId,
        sha256(`privacy-intent:${operationId}`),
        ownerUserId,
        randomUUID(),
        objectKey,
        payload,
        checksum,
        payload.byteLength,
        JSON.stringify({ manifestChecksum: checksum }),
        leaseToken,
      ],
    );

    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_privacy_object_put_capability($1, $2, $3) AS capability_id`,
        [operationId, leaseToken, capabilityId],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: capabilityId }] });
    await expect(
      pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        capabilityId,
        leaseToken,
      ]),
    ).resolves.toMatchObject({
      rows: [
        {
          authority_kind: 'PRIVACY_WRITE_INTENT',
          scope_kind: 'TENANT',
          tenant_id: tenantId,
          workspace_id: null,
          operation: 'PUT_PRIVACY_OBJECT',
          resource: {
            kind: 'PRIVACY_OBJECT_PUT',
            objectClass: 'TENANT_EXPORTS',
            bucket: ARTIFACT_BUCKET,
            key: objectKey,
            checksumSha256: checksum,
            contentType: 'application/json',
            byteLength: payload.byteLength,
            lockedUntil: null,
            sealedAt: null,
          },
        },
      ],
    });

    const putGrant = await pool.query<{ resource_hash: string }>(
      `SELECT resource_hash
       FROM load_active_tenant_data_capability($1, $2)`,
      [capabilityId, leaseToken],
    );
    const unknownPut = await beginAuthenticatedEffect(
      capabilityId,
      leaseToken,
      'PUT_PRIVACY_OBJECT',
      putGrant.rows[0]!.resource_hash,
    );
    await expect(
      pool.query(
        `SELECT finish_tenant_data_broker_effect(
           $1, $2, 'UNKNOWN', NULL
         ) AS finished`,
        [unknownPut.rows[0]!.attempt_id, leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });
    const recoveryCapabilityId = randomUUID();
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_privacy_object_recovery_head_capability($1, $2, $3)
           AS capability_id`,
        [operationId, leaseToken, recoveryCapabilityId],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: recoveryCapabilityId }] });
    await expect(
      pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        recoveryCapabilityId,
        leaseToken,
      ]),
    ).resolves.toMatchObject({
      rows: [
        {
          operation: 'HEAD_PRIVACY_OBJECT',
          resource: {
            kind: 'PRIVACY_OBJECT_WRITE_RECOVERY_HEAD',
            objectClass: 'TENANT_EXPORTS',
            bucket: ARTIFACT_BUCKET,
            key: objectKey,
            expectedChecksumSha256: checksum,
            expectedContentType: 'application/json',
            expectedByteLength: payload.byteLength,
            lockedUntil: null,
            sealedAt: null,
          },
        },
      ],
    });

    await pool.query(
      `UPDATE privacy_object_write_intents
       SET work_lease_token = $2, work_attempt_count = work_attempt_count + 1
       WHERE operation_id = $1`,
      [operationId, randomUUID()],
    );
    await expect(
      pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        capabilityId,
        leaseToken,
      ]),
    ).resolves.toMatchObject({ rows: [] });
  });

  test('binds authenticated object reads to session, membership, role epoch, and exact version', async () => {
    const sessionToken = createHash('sha256')
      .update(`authenticated-read:${randomUUID()}`, 'utf8')
      .digest('base64url');
    const sessionTokenDigest = createHash('sha256')
      .update(sessionToken, 'utf8')
      .digest('base64url');
    await pool.query(
      `INSERT INTO auth_sessions (
         token_digest, subject_digest, identity_ciphertext, created_at,
         expires_at, revoked_at, last_seen_at
       ) VALUES (
         $1, $2, 'opaque-test-session', clock_timestamp(),
         clock_timestamp() + interval '1 hour', NULL, clock_timestamp()
       )`,
      [sessionTokenDigest, sha256('task18-tenant-data-broker-owner')],
    );
    const actor = await pool.query<{
      membership_id: string;
      role_binding_id: string;
    }>(
      `SELECT membership.id AS membership_id,
              binding.id AS role_binding_id
       FROM memberships membership
       JOIN role_bindings binding
         ON binding.tenant_id = membership.tenant_id
        AND binding.membership_id = membership.id
        AND binding.workspace_id = $2
       WHERE membership.tenant_id = $1
         AND membership.user_id = $3
         AND membership.status = 'ACTIVE'`,
      [tenantId, workspaceId, ownerUserId],
    );
    const membershipId = actor.rows[0]!.membership_id;
    const roleBindingId = actor.rows[0]!.role_binding_id;
    const workloadObjectId = randomUUID();
    const workloadKey =
      `tenants/${tenantId}/workspaces/${workspaceId}/artifacts/` +
      `${randomUUID()}/revisions/1/${'8'.repeat(64)}.json`;
    const workloadVersionId = 'authenticated-workload-v1';
    const exportObjectId = randomUUID();
    const exportKey = `tenants/${tenantId}/exports/${randomUUID()}.bundle.json`;
    const exportVersionId = 'authenticated-export-v1';
    await pool.query(
      `INSERT INTO managed_object_versions (
         id, tenant_id, workspace_id, object_class, object_ref, object_key,
         object_version_id, checksum, content_type, byte_length,
         lifecycle_state, created_at
       ) VALUES
       ($1, $2, $3, 'ARTIFACT_PAYLOAD', $4, $5, $6, $7,
        'application/json', 321, 'ACTIVE', clock_timestamp()),
       ($8, $2, $3, 'TENANT_EXPORT', $9, $10, $11, $12,
        'application/json', 654, 'ACTIVE', clock_timestamp())`,
      [
        workloadObjectId,
        tenantId,
        workspaceId,
        `s3://${ARTIFACT_BUCKET}/${workloadKey}?versionId=${workloadVersionId}`,
        workloadKey,
        workloadVersionId,
        '8'.repeat(64),
        exportObjectId,
        `s3://${ARTIFACT_BUCKET}/${exportKey}?versionId=${exportVersionId}`,
        exportKey,
        exportVersionId,
        '9'.repeat(64),
      ],
    );

    const issue = (
      token: string,
      objectKey: string,
      objectVersionId: string,
      leaseToken: string,
      capabilityId: string,
    ) =>
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_authenticated_object_read_capability(
           $1, $2, $3, $4, $5, $6, $7, $8
         ) AS capability_id`,
        [
          token,
          membershipId,
          tenantId,
          workspaceId,
          objectKey,
          objectVersionId,
          leaseToken,
          capabilityId,
        ],
      );

    const workloadLeaseToken = randomUUID();
    const workloadCapabilityId = randomUUID();
    const wrongToken = createHash('sha256')
      .update(`wrong-session:${randomUUID()}`, 'utf8')
      .digest('base64url');
    await expect(
      issue(wrongToken, workloadKey, workloadVersionId, workloadLeaseToken, workloadCapabilityId),
    ).resolves.toMatchObject({ rows: [{ capability_id: null }] });
    await expect(
      issue(
        sessionToken,
        `tenants/${deletionTenantId}/workspaces/${deletionWorkspaceId}/forged.json`,
        workloadVersionId,
        workloadLeaseToken,
        workloadCapabilityId,
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: null }] });
    await expect(
      issue(sessionToken, workloadKey, workloadVersionId, workloadLeaseToken, workloadCapabilityId),
    ).resolves.toMatchObject({ rows: [{ capability_id: workloadCapabilityId }] });

    const workloadGrant = await pool.query<{
      authority_kind: string;
      authority_reference: string;
      operation: string;
      resource: Record<string, unknown>;
      scope_kind: string;
      workspace_id: string | null;
    }>('SELECT * FROM load_active_tenant_data_capability($1, $2)', [
      workloadCapabilityId,
      workloadLeaseToken,
    ]);
    expect(workloadGrant.rows).toMatchObject([
      {
        authority_kind: 'AUTHENTICATED_OBJECT_READ',
        authority_reference: workloadCapabilityId,
        operation: 'READ_WORKLOAD_OBJECT',
        scope_kind: 'WORKSPACE',
        workspace_id: workspaceId,
        resource: {
          kind: 'OBJECT_VERSION',
          objectClass: 'WORKLOAD_OBJECTS',
          bucket: ARTIFACT_BUCKET,
          key: workloadKey,
          versionId: workloadVersionId,
          checksumSha256: '8'.repeat(64),
          contentType: 'application/json',
          byteLength: 321,
        },
      },
    ]);
    const persistedSource = await pool.query<{
      serialized: string;
      session_token_digest: string;
    }>(
      `SELECT source.session_token_digest,
              to_jsonb(source)::text AS serialized
       FROM tenant_data_authenticated_object_read_sources source
       WHERE source.source_id = $1`,
      [workloadCapabilityId],
    );
    expect(persistedSource.rows[0]?.session_token_digest).toBe(sessionTokenDigest);
    expect(persistedSource.rows[0]?.serialized).not.toContain(sessionToken);

    await pool.query(
      `UPDATE role_bindings
       SET role = 'VIEWER'
       WHERE id = $1`,
      [roleBindingId],
    );
    await expect(
      pool.query('SELECT * FROM load_active_tenant_data_capability($1, $2)', [
        workloadCapabilityId,
        workloadLeaseToken,
      ]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      issue(sessionToken, exportKey, exportVersionId, randomUUID(), randomUUID()),
    ).resolves.toMatchObject({ rows: [{ capability_id: null }] });

    await pool.query(
      `UPDATE role_bindings
       SET role = 'OWNER'
       WHERE id = $1`,
      [roleBindingId],
    );
    await expect(
      pool.query('SELECT * FROM load_active_tenant_data_capability($1, $2)', [
        workloadCapabilityId,
        workloadLeaseToken,
      ]),
    ).resolves.toMatchObject({ rows: [] });
    const exportLeaseToken = randomUUID();
    const exportCapabilityId = randomUUID();
    await expect(
      issue(sessionToken, exportKey, exportVersionId, exportLeaseToken, exportCapabilityId),
    ).resolves.toMatchObject({ rows: [{ capability_id: exportCapabilityId }] });
    const exportGrant = await pool.query<{
      operation: string;
      resource: {
        key: string;
        objectClass: string;
        versionId: string;
      };
      scope_kind: string;
      workspace_id: string | null;
    }>('SELECT * FROM load_active_tenant_data_capability($1, $2)', [
      exportCapabilityId,
      exportLeaseToken,
    ]);
    expect(exportGrant.rows).toMatchObject([
      {
        operation: 'READ_PRIVACY_OBJECT',
        scope_kind: 'TENANT',
        workspace_id: null,
        resource: {
          objectClass: 'TENANT_EXPORTS',
          key: exportKey,
          versionId: exportVersionId,
        },
      },
    ]);

    await pool.query(
      `UPDATE tenant_data_authenticated_object_read_sources
       SET workspace_access_epoch = workspace_access_epoch + 1
       WHERE source_id = $1`,
      [exportCapabilityId],
    );
    await expect(
      pool.query('SELECT * FROM load_active_tenant_data_capability($1, $2)', [
        exportCapabilityId,
        exportLeaseToken,
      ]),
    ).resolves.toMatchObject({ rows: [] });

    const finalLeaseToken = randomUUID();
    const finalCapabilityId = randomUUID();
    await expect(
      issue(sessionToken, workloadKey, workloadVersionId, finalLeaseToken, finalCapabilityId),
    ).resolves.toMatchObject({ rows: [{ capability_id: finalCapabilityId }] });
    await pool.query(
      `UPDATE auth_sessions
       SET revoked_at = clock_timestamp()
       WHERE token_digest = $1`,
      [sessionTokenDigest],
    );
    await expect(
      pool.query('SELECT * FROM load_active_tenant_data_capability($1, $2)', [
        finalCapabilityId,
        finalLeaseToken,
      ]),
    ).resolves.toMatchObject({ rows: [] });
  });

  test('emits canonical UTC retention instants that pass the application authorizer', async () => {
    const operationId = randomUUID();
    const leaseToken = randomUUID();
    const capabilityId = randomUUID();
    const payload = Buffer.from('{"audit":"digest"}', 'utf8');
    const checksum = createHash('sha256').update(payload).digest('hex');
    const sealedAt = new Date('2026-07-23T06:59:00.000Z');
    const lockedUntil = new Date('2027-07-23T06:59:00.000Z');
    const objectKey = `tenants/${tenantId}/audit-digests/2026/07/23/${operationId}.json`;
    await pool.query(
      `INSERT INTO privacy_object_write_intents (
         operation_id, tenant_id, workspace_id, kind, request_identity,
         business_id, actor_user_id, audit_event_id, object_key,
         canonical_payload, checksum, content_type, byte_length,
         sealed_at, locked_until, business_payload, status, created_at,
         updated_at, work_lease_token, work_lease_expires_at, work_attempt_count
       ) VALUES (
         $1, $2, $3, 'AUDIT_DIGEST', $4, $5, $6, $7, $8,
         $9, $10, 'application/json', $11, $12, $13,
         '{}'::jsonb, 'PENDING', clock_timestamp(), clock_timestamp(),
         $14, clock_timestamp() + interval '2 minutes', 1
       )`,
      [
        operationId,
        tenantId,
        workspaceId,
        sha256(`audit-intent:${operationId}`),
        randomUUID(),
        ownerUserId,
        randomUUID(),
        objectKey,
        payload,
        checksum,
        payload.byteLength,
        sealedAt,
        lockedUntil,
        leaseToken,
      ],
    );
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_privacy_object_put_capability($1, $2, $3)
           AS capability_id`,
        [operationId, leaseToken, capabilityId],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: capabilityId }] });
    const loaded = await pool.query<{
      authority_kind: TenantDataAccessGrant['authorityKind'];
      authority_reference: string;
      capability_id: string;
      expires_at: Date;
      lease_token_sha256: string;
      operation: TenantDataAccessGrant['operation'];
      resource: Record<string, unknown>;
      scope_kind: 'TENANT';
      tenant_id: string;
      workspace_id: null;
    }>(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [capabilityId, leaseToken]);
    expect(loaded.rows[0]?.resource).toMatchObject({
      objectClass: 'AUDIT_EVIDENCE',
      sealedAt: sealedAt.toISOString(),
      lockedUntil: lockedUntil.toISOString(),
    });
    const row = loaded.rows[0]!;
    const grant = {
      capabilityId: row.capability_id,
      leaseTokenSha256: row.lease_token_sha256,
      authorityKind: row.authority_kind,
      authorityReference: row.authority_reference,
      scopeKind: row.scope_kind,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      operation: row.operation,
      resource: row.resource,
      expiresAt: row.expires_at.toISOString(),
    } as TenantDataAccessGrant;
    const authorizer = new TenantDataBrokerAuthorizer(
      { loadActiveGrant: () => Promise.resolve(grant) },
      { now: () => new Date() },
    );
    await expect(
      authorizer.authorize({
        capabilityId,
        leaseToken,
        authorityReference: operationId,
        scopeKind: 'TENANT',
        tenantId,
        workspaceId: null,
        operation: 'PUT_PRIVACY_OBJECT',
      }),
    ).resolves.toMatchObject({ outcome: 'AUTHORIZED' });
  });

  test('binds secret describe/delete/verify grants to the exact deletion state and lease', async () => {
    const channelId = randomUUID();
    const adapterId = randomUUID();
    const authorizationId = randomUUID();
    const deletionRequestId = randomUUID();
    const leaseToken = randomUUID();
    const secretArn =
      `arn:aws:secretsmanager:ap-southeast-1:${ACCOUNT_ID}:secret:` +
      `tenant-${tenantId}/workspace-${workspaceId}/connector`;
    await pool.query(
      `INSERT INTO channel_definitions (
         id, channel_key, display_name, status, unavailable_reason,
         package_transformer_key, package_schema_version
       ) VALUES ($1, $2, 'Broker secret fixture', 'AVAILABLE', NULL,
         'generic-web-package', '1.0.0')`,
      [channelId, `broker-secret-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO adapter_versions (
         id, channel_definition_id, adapter_key, adapter_version, enabled,
         disabled_reason, capabilities, required_scopes, terms_version,
         terms_status, processing_region, retention_policy, training_policy,
         subprocessors, rate_policy
       ) VALUES (
         $1, $2, $3, '1.0.0', true, NULL,
         ARRAY['PUBLISH','RECONCILE'], ARRAY['fixture.publish'], '2026-07',
         'ALLOWED', 'Singapore', 'ephemeral', 'not-used-for-training',
         '[]'::jsonb, '{"requestsPerMinute":10}'::jsonb
       )`,
      [adapterId, channelId, `broker-secret-adapter-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO channel_authorizations (
         id, tenant_id, workspace_id, adapter_version_id, status, secret_arn,
         secret_arn_hash,
         granted_scopes, accepted_terms_version, target, expires_at,
         created_by_user_id, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'REVOKED', NULL, $5, ARRAY['fixture.publish'],
         '2026-07', $6, NULL, $7, clock_timestamp(), clock_timestamp()
       )`,
      [
        authorizationId,
        tenantId,
        workspaceId,
        adapterId,
        sha256(secretArn),
        `fixture://secret/${authorizationId}`,
        ownerUserId,
      ],
    );
    const requestedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    await pool.query(
      `INSERT INTO deletion_requests (
         id, tenant_id, workspace_id, scope_kind, state, requested_by_user_id,
         requested_membership_id, requested_workspace_id,
         requested_subject_digest, reason, request_hash, requested_at, frozen_at,
         active_delete_by, backup_delete_by, secret_force_delete_by
       ) VALUES (
         $1, $2, $3, 'WORKSPACE', 'FROZEN', $4, $5, $3, $6,
         'Broker secret lifecycle fixture', $7, $8::timestamptz, $8::timestamptz,
         $8::timestamptz + interval '30 days',
         $8::timestamptz + interval '90 days',
         $8::timestamptz + interval '24 hours'
       )`,
      [
        deletionRequestId,
        tenantId,
        workspaceId,
        ownerUserId,
        randomUUID(),
        sha256(`subject:${deletionRequestId}`),
        sha256(`request:${deletionRequestId}`),
        requestedAt,
      ],
    );
    await pool.query(
      `INSERT INTO connector_secret_deletions (
         tenant_id, workspace_id, channel_authorization_id, secret_reference,
         secret_reference_hash, state, deletion_request_id, revoked_at,
         force_delete_at, work_lease_token, work_lease_expires_at,
         work_attempt_count, work_last_claimed_at
       ) VALUES (
         $1, $2, $3, $4, NULL, 'REVOKED_PENDING_FORCE_DELETE', $5,
         $6::timestamptz, $6::timestamptz + interval '24 hours',
         $7, clock_timestamp() + interval '5 minutes',
         1, clock_timestamp()
       )`,
      [
        tenantId,
        workspaceId,
        authorizationId,
        secretArn,
        deletionRequestId,
        requestedAt,
        leaseToken,
      ],
    );

    const foreignAuthorizationId = randomUUID();
    const foreignSecretArn =
      `arn:aws:secretsmanager:ap-southeast-1:${ACCOUNT_ID}:secret:` +
      `tenant-${randomUUID()}/workspace-${workspaceId}/connector`;
    const futureAuthorizationId = randomUUID();
    const futureSecretArn =
      `arn:aws:secretsmanager:ap-southeast-1:${ACCOUNT_ID}:secret:` +
      `tenant-${tenantId}/workspace-${workspaceId}/future-connector`;
    await pool.query(
      `INSERT INTO channel_authorizations (
         id, tenant_id, workspace_id, adapter_version_id, status, secret_arn,
         secret_arn_hash, granted_scopes, accepted_terms_version, target,
         expires_at, created_by_user_id, created_at, updated_at
       ) VALUES
       ($1, $2, $3, $4, 'REVOKED', NULL, $5, ARRAY['fixture.publish'],
        '2026-07', $6, NULL, $7, clock_timestamp(), clock_timestamp()),
       ($8, $2, $3, $4, 'REVOKED', NULL, $9, ARRAY['fixture.publish'],
        '2026-07', $10, NULL, $7, clock_timestamp(), clock_timestamp())`,
      [
        foreignAuthorizationId,
        tenantId,
        workspaceId,
        adapterId,
        sha256(foreignSecretArn),
        `fixture://secret/${foreignAuthorizationId}`,
        ownerUserId,
        futureAuthorizationId,
        sha256(futureSecretArn),
        `fixture://secret/${futureAuthorizationId}`,
      ],
    );
    await pool.query(
      `INSERT INTO connector_secret_deletions (
         tenant_id, workspace_id, channel_authorization_id, secret_reference,
         secret_reference_hash, state, deletion_request_id, revoked_at,
         force_delete_at, work_lease_token, work_lease_expires_at,
         work_attempt_count, work_last_claimed_at
       ) VALUES
       ($1, $2, $3, $4, NULL, 'REVOKED_PENDING_FORCE_DELETE', $5,
        $6::timestamptz, $6::timestamptz + interval '24 hours',
        $7, clock_timestamp() + interval '5 minutes', 1, clock_timestamp()),
       ($1, $2, $8, $9, NULL, 'REVOKED_PENDING_FORCE_DELETE', $5,
        statement_timestamp(), statement_timestamp() + interval '24 hours',
        $7, clock_timestamp() + interval '5 minutes', 1, clock_timestamp())`,
      [
        tenantId,
        workspaceId,
        foreignAuthorizationId,
        foreignSecretArn,
        deletionRequestId,
        requestedAt,
        leaseToken,
        futureAuthorizationId,
        futureSecretArn,
      ],
    );
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_connector_secret_describe_capability($1, $2, $3)
           AS capability_id`,
        [foreignAuthorizationId, leaseToken, randomUUID()],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: null }] });
    const futureDescribeCapabilityId = randomUUID();
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_connector_secret_describe_capability($1, $2, $3)
           AS capability_id`,
        [futureAuthorizationId, leaseToken, futureDescribeCapabilityId],
      ),
    ).resolves.toMatchObject({
      rows: [{ capability_id: futureDescribeCapabilityId }],
    });
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_connector_secret_delete_capability($1, $2, $3)
           AS capability_id`,
        [futureAuthorizationId, leaseToken, randomUUID()],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: null }] });

    for (const issuer of [
      'issue_connector_secret_describe_capability',
      'issue_connector_secret_delete_capability',
    ]) {
      const capabilityId = randomUUID();
      await expect(
        pool.query<{ capability_id: string | null }>(
          `SELECT ${issuer}($1, $2, $3) AS capability_id`,
          [authorizationId, leaseToken, capabilityId],
        ),
      ).resolves.toMatchObject({ rows: [{ capability_id: capabilityId }] });
    }

    const deleteCapability = await pool.query<{ capability_id: string | null }>(
      `SELECT issue_connector_secret_delete_capability($1, $2, $3)
         AS capability_id`,
      [authorizationId, leaseToken, randomUUID()],
    );
    const deleteCapabilityId = deleteCapability.rows[0]?.capability_id;
    if (deleteCapabilityId === null || deleteCapabilityId === undefined) {
      throw new Error('SECRET_DELETE_CAPABILITY_NOT_ISSUED');
    }
    const deleteGrant = await pool.query<{ resource_hash: string }>(
      `SELECT resource_hash
       FROM load_active_tenant_data_capability($1, $2)`,
      [deleteCapabilityId, leaseToken],
    );
    const firstDelete = await beginAuthenticatedEffect(
      deleteCapabilityId,
      leaseToken,
      'DELETE_CONNECTOR_SECRET',
      deleteGrant.rows[0]!.resource_hash,
    );
    const describeCapability = await pool.query<{ capability_id: string | null }>(
      `SELECT issue_connector_secret_describe_capability($1, $2, $3)
         AS capability_id`,
      [authorizationId, leaseToken, randomUUID()],
    );
    const describeCapabilityId = describeCapability.rows[0]?.capability_id;
    if (describeCapabilityId === null || describeCapabilityId === undefined) {
      throw new Error('SECRET_DESCRIBE_CAPABILITY_NOT_ISSUED');
    }
    const describeGrant = await pool.query<{ resource_hash: string }>(
      `SELECT resource_hash
       FROM load_active_tenant_data_capability($1, $2)`,
      [describeCapabilityId, leaseToken],
    );
    const ambiguousDelete = await beginAuthenticatedEffect(
      deleteCapabilityId,
      leaseToken,
      'DELETE_CONNECTOR_SECRET',
      deleteGrant.rows[0]!.resource_hash,
    );
    expect(ambiguousDelete.rows[0]?.outcome).toBe('AMBIGUOUS');
    const concurrentProbe = await beginAuthenticatedEffect(
      describeCapabilityId,
      leaseToken,
      'DESCRIBE_CONNECTOR_SECRET',
      describeGrant.rows[0]!.resource_hash,
    );
    await expect(
      pool.query(
        `SELECT resolve_tenant_data_broker_secret_delete_effect(
           $1, $2, 'EXISTS'
         ) AS resolution`,
        [concurrentProbe.rows[0]!.attempt_id, leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ resolution: 'NOT_RESOLVED' }] });
    await expect(
      pool.query(
        `SELECT effect.state,
                delete_attempt.outcome AS delete_outcome,
                ambiguous_attempt.outcome AS ambiguous_outcome,
                probe_attempt.outcome AS probe_outcome
         FROM tenant_data_broker_effects effect
         JOIN tenant_data_broker_attempts delete_attempt
           ON delete_attempt.attempt_id = effect.active_attempt_id
         JOIN tenant_data_broker_attempts ambiguous_attempt
           ON ambiguous_attempt.attempt_id = $2
         JOIN tenant_data_broker_attempts probe_attempt
           ON probe_attempt.attempt_id = $3
         WHERE effect.effect_identity =
           'CONNECTOR_SECRET_DELETE:' || $1::text`,
        [authorizationId, ambiguousDelete.rows[0]!.attempt_id, concurrentProbe.rows[0]!.attempt_id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: 'STARTED',
          delete_outcome: 'STARTED',
          ambiguous_outcome: 'UNKNOWN',
          probe_outcome: 'STARTED',
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT finish_tenant_data_broker_effect(
           $1, $2, 'FAILED', NULL
         ) AS finished`,
        [concurrentProbe.rows[0]!.attempt_id, leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });
    await expect(
      pool.query(
        `SELECT finish_tenant_data_broker_effect(
           $1, $2, 'UNKNOWN', NULL
         ) AS finished`,
        [firstDelete.rows[0]!.attempt_id, leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });

    const nullProbe = await beginAuthenticatedEffect(
      describeCapabilityId,
      leaseToken,
      'DESCRIBE_CONNECTOR_SECRET',
      describeGrant.rows[0]!.resource_hash,
    );
    await expect(
      pool.query(
        `SELECT resolve_tenant_data_broker_secret_delete_effect(
           $1, $2, NULL
         ) AS resolution`,
        [nullProbe.rows[0]!.attempt_id, leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ resolution: 'NOT_RESOLVED' }] });
    await expect(
      pool.query(
        `SELECT effect.state, probe.outcome AS probe_outcome
         FROM tenant_data_broker_effects effect
         JOIN tenant_data_broker_attempts probe
           ON probe.attempt_id = $2
         WHERE effect.effect_identity =
           'CONNECTOR_SECRET_DELETE:' || $1::text`,
        [authorizationId, nullProbe.rows[0]!.attempt_id],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: 'UNKNOWN', probe_outcome: 'STARTED' }],
    });
    await expect(
      pool.query(
        `SELECT finish_tenant_data_broker_effect(
           $1, $2, 'FAILED', NULL
         ) AS finished`,
        [nullProbe.rows[0]!.attempt_id, leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });
    const existsProbe = await beginAuthenticatedEffect(
      describeCapabilityId,
      leaseToken,
      'DESCRIBE_CONNECTOR_SECRET',
      describeGrant.rows[0]!.resource_hash,
    );
    await expect(
      pool.query(
        `SELECT resolve_tenant_data_broker_secret_delete_effect(
           $1, $2, 'EXISTS'
         ) AS resolution`,
        [existsProbe.rows[0]!.attempt_id, leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ resolution: 'NOT_RESOLVED' }] });
    await expect(
      pool.query(
        `SELECT effect.state,
                delete_attempt.outcome AS delete_outcome,
                probe_attempt.outcome AS probe_outcome
         FROM tenant_data_broker_effects effect
         JOIN tenant_data_broker_attempts delete_attempt
           ON delete_attempt.attempt_id = effect.active_attempt_id
         JOIN tenant_data_broker_attempts probe_attempt
           ON probe_attempt.attempt_id = $2
         WHERE effect.effect_identity =
           'CONNECTOR_SECRET_DELETE:' || $1::text`,
        [authorizationId, existsProbe.rows[0]!.attempt_id],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: 'UNKNOWN', delete_outcome: 'UNKNOWN', probe_outcome: 'STARTED' }],
    });
    await expect(
      pool.query(
        `SELECT finish_tenant_data_broker_effect(
           $1, $2, 'FAILED', NULL
         ) AS finished`,
        [existsProbe.rows[0]!.attempt_id, leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });

    await pool.query(
      `WITH frozen AS (SELECT clock_timestamp() AS database_now)
       UPDATE tenant_data_capabilities
       SET issued_at = frozen.database_now - interval '4 minutes',
           expires_at = frozen.database_now - interval '2 minutes'
       FROM frozen
       WHERE capability_id = $1`,
      [deleteCapabilityId],
    );
    await pool.query(
      `WITH frozen AS (SELECT clock_timestamp() AS database_now)
       UPDATE tenant_data_broker_nonces nonce
       SET signed_at = frozen.database_now - interval '3 minutes',
           expires_at =
             frozen.database_now - interval '2 minutes 30 seconds',
           first_seen_at = frozen.database_now - interval '3 minutes'
       FROM tenant_data_broker_attempts attempt, frozen
       WHERE attempt.attempt_id = $1
         AND nonce.nonce = attempt.nonce`,
      [firstDelete.rows[0]!.attempt_id],
    );
    await pool.query(
      `UPDATE tenant_data_broker_attempts
       SET started_at = clock_timestamp() - interval '2 minutes'
       WHERE attempt_id = $1`,
      [firstDelete.rows[0]!.attempt_id],
    );
    const recoveryLeaseToken = randomUUID();
    const leaseClient = await pool.connect();
    try {
      await leaseClient.query('BEGIN');
      await leaseClient.query(
        `SELECT set_config(
           'app.secret_deletion_lease', 'authorized', true
         )`,
      );
      await leaseClient.query(
        `UPDATE connector_secret_deletions
         SET work_lease_token = $2,
             work_lease_expires_at =
               clock_timestamp() + interval '5 minutes',
             work_attempt_count = work_attempt_count + 1,
             work_last_claimed_at = clock_timestamp()
         WHERE tenant_id = $1 AND channel_authorization_id = $3`,
        [tenantId, recoveryLeaseToken, authorizationId],
      );
      await leaseClient.query('COMMIT');
    } catch (error: unknown) {
      await leaseClient.query('ROLLBACK');
      throw error;
    } finally {
      leaseClient.release();
    }
    const recoveryDeleteCapabilityId = randomUUID();
    const recoveryDescribeCapabilityId = randomUUID();
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_connector_secret_delete_capability(
           $1, $2, $3
         ) AS capability_id`,
        [authorizationId, recoveryLeaseToken, recoveryDeleteCapabilityId],
      ),
    ).resolves.toMatchObject({
      rows: [{ capability_id: recoveryDeleteCapabilityId }],
    });
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_connector_secret_describe_capability(
           $1, $2, $3
         ) AS capability_id`,
        [authorizationId, recoveryLeaseToken, recoveryDescribeCapabilityId],
      ),
    ).resolves.toMatchObject({
      rows: [{ capability_id: recoveryDescribeCapabilityId }],
    });
    const recoveryDeleteGrant = await pool.query<{ resource_hash: string }>(
      `SELECT resource_hash
       FROM load_active_tenant_data_capability($1, $2)`,
      [recoveryDeleteCapabilityId, recoveryLeaseToken],
    );
    const recoveryDescribeGrant = await pool.query<{ resource_hash: string }>(
      `SELECT resource_hash
       FROM load_active_tenant_data_capability($1, $2)`,
      [recoveryDescribeCapabilityId, recoveryLeaseToken],
    );
    const elapsedExistsProbe = await beginAuthenticatedEffect(
      recoveryDescribeCapabilityId,
      recoveryLeaseToken,
      'DESCRIBE_CONNECTOR_SECRET',
      recoveryDescribeGrant.rows[0]!.resource_hash,
    );
    await expect(
      pool.query(
        `SELECT resolve_tenant_data_broker_secret_delete_effect(
           $1, $2, 'EXISTS'
         ) AS resolution`,
        [elapsedExistsProbe.rows[0]!.attempt_id, recoveryLeaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ resolution: 'RESOLVED_FAILED' }] });

    const retriedDelete = await beginAuthenticatedEffect(
      recoveryDeleteCapabilityId,
      recoveryLeaseToken,
      'DELETE_CONNECTOR_SECRET',
      recoveryDeleteGrant.rows[0]!.resource_hash,
    );
    expect(retriedDelete.rows[0]?.outcome).toBe('STARTED');
    await expect(
      pool.query(
        `SELECT finish_tenant_data_broker_effect(
           $1, $2, 'UNKNOWN', NULL
         ) AS finished`,
        [retriedDelete.rows[0]!.attempt_id, recoveryLeaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });
    const absentProbe = await beginAuthenticatedEffect(
      recoveryDescribeCapabilityId,
      recoveryLeaseToken,
      'DESCRIBE_CONNECTOR_SECRET',
      recoveryDescribeGrant.rows[0]!.resource_hash,
    );
    await expect(
      pool.query(
        `SELECT resolve_tenant_data_broker_secret_delete_effect(
           $1, $2, 'ABSENT'
         ) AS resolution`,
        [absentProbe.rows[0]!.attempt_id, recoveryLeaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ resolution: 'RESOLVED_SUCCESS' }] });
    await expect(
      beginAuthenticatedEffect(
        recoveryDeleteCapabilityId,
        recoveryLeaseToken,
        'DELETE_CONNECTOR_SECRET',
        recoveryDeleteGrant.rows[0]!.resource_hash,
      ),
    ).resolves.toMatchObject({
      rows: [{ outcome: 'ALREADY_SUCCEEDED', success_receipt: {} }],
    });

    const verifyBeforeDelete = await pool.query<{ capability_id: string | null }>(
      `SELECT issue_connector_secret_verify_unreadable_capability($1, $2, $3)
         AS capability_id`,
      [authorizationId, recoveryLeaseToken, randomUUID()],
    );
    expect(verifyBeforeDelete.rows).toEqual([{ capability_id: null }]);

    await expect(
      pool.query<{ transitioned: boolean }>(
        `SELECT worker_mark_secret_deletion_requested($1, $2, $3) AS transitioned`,
        [tenantId, authorizationId, recoveryLeaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ transitioned: true }] });
    const verifyCapabilityId = randomUUID();
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_connector_secret_verify_unreadable_capability($1, $2, $3)
           AS capability_id`,
        [authorizationId, recoveryLeaseToken, verifyCapabilityId],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: verifyCapabilityId }] });
    await expect(
      pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        verifyCapabilityId,
        recoveryLeaseToken,
      ]),
    ).resolves.toMatchObject({
      rows: [
        {
          operation: 'VERIFY_CONNECTOR_SECRET_UNREADABLE',
          resource: {
            kind: 'CONNECTOR_SECRET_UNREADABLE_VERIFICATION',
            secretArn,
            resultKind: 'BOOLEAN_ONLY',
          },
        },
      ],
    });
    await pool.query(
      `UPDATE deletion_requests
       SET state = 'FAILED', failure_code = 'TEST_FIXTURE_CLOSED'
       WHERE id = $1`,
      [deletionRequestId],
    );
  });

  test('issues each deletion inventory page only from the current database cursor and scope', async () => {
    await expect(
      pool.query(`SELECT * FROM get_deletion_object_inventory_page_target($1, $2)`, [
        deletionRequestId,
        deletionLeaseToken,
      ]),
    ).resolves.toMatchObject({
      rows: [{ status: 'REQUIRED', bucket_kind: 'TENANT_EXPORTS' }],
    });
    await expect(
      pool.query(
        `WITH stored AS (
           SELECT export_cursor AS value
           FROM privacy_object_inventory_page_progress
           WHERE deletion_request_id = $1
         ), decoded AS (
           SELECT value,
             decode(
               translate(value, '-_', '+/') ||
                 repeat('=', (4 - length(value) % 4) % 4),
               'base64'
             ) AS bytes
           FROM stored
         )
         SELECT tenant_data_decode_inventory_cursor_private(value) AS cursor,
           rtrim(
             replace(
               translate(encode(bytes, 'base64'), '+/', '-_'),
               E'\n', ''
             ),
             '='
           ) = value AS canonical,
           convert_from(bytes, 'UTF8')::jsonb AS decoded
         FROM decoded`,
        [deletionRequestId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          canonical: true,
          cursor: {
            keyMarker: `tenants/${deletionTenantId}/exports/page-1`,
            versionIdMarker: 'inventory-version-1',
          },
          decoded: {
            keyMarker: `tenants/${deletionTenantId}/exports/page-1`,
            versionIdMarker: 'inventory-version-1',
          },
        },
      ],
    });
    const exportCapabilityId = randomUUID();
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_deletion_inventory_capability($1, $2, $3, 1000)
           AS capability_id`,
        [deletionRequestId, deletionLeaseToken, exportCapabilityId],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: exportCapabilityId }] });
    await expect(
      pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        exportCapabilityId,
        deletionLeaseToken,
      ]),
    ).resolves.toMatchObject({
      rows: [
        {
          authority_kind: 'DELETION_INVENTORY_INTENT',
          authority_reference: deletionRequestId,
          scope_kind: 'TENANT',
          tenant_id: deletionTenantId,
          workspace_id: null,
          operation: 'LIST_TENANT_OBJECT_VERSIONS',
          resource: {
            kind: 'OBJECT_VERSION_INVENTORY',
            objectClass: 'TENANT_EXPORTS',
            bucket: ARTIFACT_BUCKET,
            prefix: `tenants/${deletionTenantId}/exports/`,
            cursor: {
              keyMarker: `tenants/${deletionTenantId}/exports/page-1`,
              versionIdMarker: 'inventory-version-1',
            },
            limit: 1000,
          },
        },
      ],
    });

    await pool.query(
      `UPDATE privacy_object_inventory_page_progress
       SET export_complete = true, export_cursor = NULL, updated_at = clock_timestamp()
       WHERE deletion_request_id = $1`,
      [deletionRequestId],
    );
    await expect(
      pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        exportCapabilityId,
        deletionLeaseToken,
      ]),
    ).resolves.toMatchObject({ rows: [] });

    const auditCapabilityId = randomUUID();
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_deletion_inventory_capability($1, $2, $3, 250)
           AS capability_id`,
        [deletionRequestId, deletionLeaseToken, randomUUID()],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: null }] });
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_deletion_inventory_capability($1, $2, $3, 1000)
           AS capability_id`,
        [deletionRequestId, deletionLeaseToken, auditCapabilityId],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: auditCapabilityId }] });
    await expect(
      pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        auditCapabilityId,
        deletionLeaseToken,
      ]),
    ).resolves.toMatchObject({
      rows: [
        {
          scope_kind: 'TENANT',
          workspace_id: null,
          resource: {
            kind: 'OBJECT_VERSION_INVENTORY',
            objectClass: 'AUDIT_EVIDENCE',
            bucket: AUDIT_BUCKET,
            prefix: `tenants/${deletionTenantId}/audit-digests/`,
            cursor: null,
            limit: 1000,
          },
        },
      ],
    });

    await pool.query(
      `UPDATE privacy_object_inventory_page_progress
       SET audit_complete = true, workload_fenced_at = clock_timestamp() - interval '31 seconds',
           updated_at = clock_timestamp()
       WHERE deletion_request_id = $1`,
      [deletionRequestId],
    );
    const workloadCapabilityId = randomUUID();
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_deletion_inventory_capability($1, $2, $3, 1000)
           AS capability_id`,
        [deletionRequestId, deletionLeaseToken, workloadCapabilityId],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: workloadCapabilityId }] });
    await expect(
      pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        workloadCapabilityId,
        deletionLeaseToken,
      ]),
    ).resolves.toMatchObject({
      rows: [
        {
          scope_kind: 'WORKSPACE',
          workspace_id: deletionWorkspaceId,
          resource: {
            kind: 'OBJECT_VERSION_INVENTORY',
            objectClass: 'WORKLOAD_OBJECTS',
            bucket: ARTIFACT_BUCKET,
            prefix: `tenants/${deletionTenantId}/workspaces/${deletionWorkspaceId}/`,
            cursor: null,
            limit: 1000,
          },
        },
      ],
    });
    await pool.query(
      `UPDATE privacy_object_inventory_page_progress
       SET workload_cursor = 'not-base64*', updated_at = clock_timestamp()
       WHERE deletion_request_id = $1`,
      [deletionRequestId],
    );
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_deletion_inventory_capability($1, $2, $3, 1000)
           AS capability_id`,
        [deletionRequestId, deletionLeaseToken, randomUUID()],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: null }] });
  });

  test('issues exact-version deletion and legal-hold grants and revokes live source drift', async () => {
    const workloadHeadCapabilityId = randomUUID();
    const workloadDeleteCapabilityId = randomUUID();
    const exportLegalHoldCapabilityId = randomUUID();
    for (const [issuer, capabilityId] of [
      ['issue_deletion_object_head_capability', workloadHeadCapabilityId],
      ['issue_deletion_object_delete_capability', workloadDeleteCapabilityId],
    ] as const) {
      await expect(
        pool.query<{ capability_id: string | null }>(
          `SELECT ${issuer}($1, $2, $3, $4, $5) AS capability_id`,
          [
            deletionRequestId,
            deletionLeaseToken,
            capabilityId,
            deletionWorkloadKey,
            deletionWorkloadVersionId,
          ],
        ),
      ).resolves.toMatchObject({ rows: [{ capability_id: capabilityId }] });
    }
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_deletion_object_get_legal_hold_capability(
           $1, $2, $3, $4, $5
         ) AS capability_id`,
        [
          deletionRequestId,
          deletionLeaseToken,
          exportLegalHoldCapabilityId,
          deletionExportKey,
          deletionExportVersionId,
        ],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: exportLegalHoldCapabilityId }] });

    await expect(
      pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        workloadHeadCapabilityId,
        deletionLeaseToken,
      ]),
    ).resolves.toMatchObject({
      rows: [
        {
          operation: 'HEAD_WORKLOAD_OBJECT',
          scope_kind: 'WORKSPACE',
          workspace_id: deletionWorkspaceId,
          resource: {
            kind: 'OBJECT_VERSION',
            objectClass: 'WORKLOAD_OBJECTS',
            bucket: ARTIFACT_BUCKET,
            key: deletionWorkloadKey,
            versionId: deletionWorkloadVersionId,
            checksumSha256: 'c'.repeat(64),
            contentType: 'application/json',
            byteLength: 128,
          },
        },
      ],
    });
    await expect(
      pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        workloadDeleteCapabilityId,
        deletionLeaseToken,
      ]),
    ).resolves.toMatchObject({
      rows: [
        {
          operation: 'DELETE_WORKLOAD_OBJECT_VERSION',
          resource: {
            kind: 'OBJECT_VERSION_DELETE',
            objectClass: 'WORKLOAD_OBJECTS',
            bucket: ARTIFACT_BUCKET,
            key: deletionWorkloadKey,
            versionId: deletionWorkloadVersionId,
            isDeleteMarker: false,
          },
        },
      ],
    });
    await expect(
      pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        exportLegalHoldCapabilityId,
        deletionLeaseToken,
      ]),
    ).resolves.toMatchObject({
      rows: [
        {
          operation: 'GET_OBJECT_LEGAL_HOLD',
          scope_kind: 'TENANT',
          workspace_id: null,
          resource: {
            kind: 'OBJECT_LEGAL_HOLD_READ',
            objectClass: 'TENANT_EXPORTS',
            bucket: ARTIFACT_BUCKET,
            key: deletionExportKey,
            versionId: deletionExportVersionId,
          },
        },
      ],
    });

    const legalHoldCapabilityId = randomUUID();
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_legal_hold_set_capability($1, $2, $3, $4, $5)
           AS capability_id`,
        [
          deletionTenantId,
          legalHoldAuditKey,
          legalHoldAuditVersionId,
          legalHoldLeaseToken,
          legalHoldCapabilityId,
        ],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: legalHoldCapabilityId }] });
    await expect(
      pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        legalHoldCapabilityId,
        legalHoldLeaseToken,
      ]),
    ).resolves.toMatchObject({
      rows: [
        {
          authority_kind: 'LEGAL_HOLD_RECONCILIATION_INTENT',
          scope_kind: 'TENANT',
          tenant_id: deletionTenantId,
          workspace_id: null,
          operation: 'SET_OBJECT_LEGAL_HOLD',
          resource: {
            kind: 'OBJECT_LEGAL_HOLD_WRITE',
            objectClass: 'AUDIT_EVIDENCE',
            bucket: AUDIT_BUCKET,
            key: legalHoldAuditKey,
            versionId: legalHoldAuditVersionId,
            desiredStatus: 'ON',
            revision: 1,
          },
        },
      ],
    });

    const legalHoldSetGrant = await pool.query<{ resource_hash: string }>(
      `SELECT resource_hash
       FROM load_active_tenant_data_capability($1, $2)`,
      [legalHoldCapabilityId, legalHoldLeaseToken],
    );
    const setStart = await beginAuthenticatedEffect(
      legalHoldCapabilityId,
      legalHoldLeaseToken,
      'SET_OBJECT_LEGAL_HOLD',
      legalHoldSetGrant.rows[0]!.resource_hash,
    );
    await expect(
      pool.query<{ finished: boolean }>(
        `SELECT finish_tenant_data_broker_effect(
           $1, $2, 'UNKNOWN', NULL
         ) AS finished`,
        [setStart.rows[0]!.attempt_id, legalHoldLeaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });
    await expect(
      beginAuthenticatedEffect(
        legalHoldCapabilityId,
        legalHoldLeaseToken,
        'SET_OBJECT_LEGAL_HOLD',
        legalHoldSetGrant.rows[0]!.resource_hash,
      ),
    ).resolves.toMatchObject({ rows: [{ outcome: 'AMBIGUOUS' }] });

    const legalHoldProbeCapabilityId = randomUUID();
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_legal_hold_get_recovery_capability(
           $1, $2, $3, $4, $5
         ) AS capability_id`,
        [
          deletionTenantId,
          legalHoldAuditKey,
          legalHoldAuditVersionId,
          legalHoldLeaseToken,
          legalHoldProbeCapabilityId,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [{ capability_id: legalHoldProbeCapabilityId }],
    });
    const legalHoldProbeGrant = await pool.query<{
      resource: Record<string, unknown>;
      resource_hash: string;
    }>(
      `SELECT resource, resource_hash
       FROM load_active_tenant_data_capability($1, $2)`,
      [legalHoldProbeCapabilityId, legalHoldLeaseToken],
    );
    expect(legalHoldProbeGrant.rows[0]?.resource).toEqual({
      kind: 'OBJECT_LEGAL_HOLD_READ',
      objectClass: 'AUDIT_EVIDENCE',
      bucket: AUDIT_BUCKET,
      key: legalHoldAuditKey,
      versionId: legalHoldAuditVersionId,
    });
    const negativeProbeStart = await beginAuthenticatedEffect(
      legalHoldProbeCapabilityId,
      legalHoldLeaseToken,
      'GET_OBJECT_LEGAL_HOLD',
      legalHoldProbeGrant.rows[0]!.resource_hash,
    );
    await expect(
      pool.query<{ resolved: string }>(
        `SELECT resolve_tenant_data_broker_legal_hold_effect(
           $1, $2, 'OFF'
         ) AS resolved`,
        [negativeProbeStart.rows[0]!.attempt_id, legalHoldLeaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ resolved: 'NOT_RESOLVED' }] });
    await expect(
      pool.query(
        `SELECT state
         FROM tenant_data_broker_effects
         WHERE effect_identity = (
           SELECT 'LEGAL_HOLD_SET:' || source_reference || ':1'
           FROM tenant_data_capabilities
           WHERE capability_id = $1
         )`,
        [legalHoldCapabilityId],
      ),
    ).resolves.toMatchObject({ rows: [{ state: 'UNKNOWN' }] });
    await expect(
      pool.query(
        `SELECT finish_tenant_data_broker_effect(
           $1, $2, 'FAILED', NULL
         ) AS finished`,
        [negativeProbeStart.rows[0]!.attempt_id, legalHoldLeaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });
    const probeStart = await beginAuthenticatedEffect(
      legalHoldProbeCapabilityId,
      legalHoldLeaseToken,
      'GET_OBJECT_LEGAL_HOLD',
      legalHoldProbeGrant.rows[0]!.resource_hash,
    );
    await expect(
      pool.query<{ resolved: string }>(
        `SELECT resolve_tenant_data_broker_legal_hold_effect(
           $1, $2, 'ON'
         ) AS resolved`,
        [probeStart.rows[0]!.attempt_id, legalHoldLeaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ resolved: 'RESOLVED_SUCCESS' }] });
    await expect(
      beginAuthenticatedEffect(
        legalHoldCapabilityId,
        legalHoldLeaseToken,
        'SET_OBJECT_LEGAL_HOLD',
        legalHoldSetGrant.rows[0]!.resource_hash,
      ),
    ).resolves.toMatchObject({
      rows: [{ outcome: 'ALREADY_SUCCEEDED', success_receipt: {} }],
    });
    await pool.query(
      `DELETE FROM legal_hold_object_versions
       WHERE tenant_id = $1 AND hold_id = $2
         AND object_key = $3 AND object_version_id = $4`,
      [deletionTenantId, liveLegalHoldId, legalHoldAuditKey, legalHoldAuditVersionId],
    );
    await expect(
      pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        legalHoldCapabilityId,
        legalHoldLeaseToken,
      ]),
    ).resolves.toMatchObject({ rows: [] });

    const orphanKey =
      `tenants/${deletionTenantId}/workspaces/${deletionWorkspaceId}/` + `orphan/${randomUUID()}`;
    const orphanVersionId = 'orphan-version-1';
    const deleteMarkerKey =
      `tenants/${deletionTenantId}/workspaces/${deletionWorkspaceId}/` + `orphan/${randomUUID()}`;
    const deleteMarkerVersionId = 'delete-marker-version-1';
    await pool.query(
      `INSERT INTO managed_object_versions (
         id, tenant_id, workspace_id, object_class, object_ref, object_key,
         object_version_id, checksum, content_type, byte_length,
         is_delete_marker, lifecycle_state, created_at
       ) VALUES
       ($1, $2, $3, 'ACTIVE_TENANT_DATA', $4, $5, $6, NULL,
        'application/octet-stream', 64, false, 'ACTIVE', clock_timestamp()),
       ($7, $2, $3, 'ACTIVE_TENANT_DATA', $8, $9, $10, NULL,
        'application/x-s3-delete-marker', 0, true, 'ACTIVE', clock_timestamp())`,
      [
        randomUUID(),
        deletionTenantId,
        deletionWorkspaceId,
        `s3-inventory://${sha256(`${orphanKey}:${orphanVersionId}`)}`,
        orphanKey,
        orphanVersionId,
        randomUUID(),
        `s3-inventory://${sha256(`${deleteMarkerKey}:${deleteMarkerVersionId}`)}`,
        deleteMarkerKey,
        deleteMarkerVersionId,
      ],
    );
    const dueRows = await pool.query<{
      object_key: string;
      scope_kind: 'TENANT' | 'WORKSPACE';
      workspace_id: string | null;
      storage_class: 'TENANT_EXPORTS' | 'AUDIT_EVIDENCE' | 'WORKLOAD_OBJECTS';
      head_eligible: boolean;
      is_delete_marker: boolean;
    }>(
      `SELECT object_key, scope_kind, workspace_id, storage_class,
              head_eligible, is_delete_marker
       FROM list_due_deletion_object_versions($1, $2, 1000)`,
      [deletionRequestId, deletionLeaseToken],
    );
    expect(dueRows.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          object_key: deletionWorkloadKey,
          scope_kind: 'WORKSPACE',
          workspace_id: deletionWorkspaceId,
          storage_class: 'WORKLOAD_OBJECTS',
          head_eligible: true,
          is_delete_marker: false,
        }),
        expect.objectContaining({
          object_key: deletionExportKey,
          scope_kind: 'TENANT',
          workspace_id: null,
          storage_class: 'TENANT_EXPORTS',
          head_eligible: true,
          is_delete_marker: false,
        }),
        expect.objectContaining({
          object_key: orphanKey,
          scope_kind: 'WORKSPACE',
          workspace_id: deletionWorkspaceId,
          storage_class: 'WORKLOAD_OBJECTS',
          head_eligible: false,
          is_delete_marker: false,
        }),
        expect.objectContaining({
          object_key: deleteMarkerKey,
          scope_kind: 'WORKSPACE',
          workspace_id: deletionWorkspaceId,
          storage_class: 'WORKLOAD_OBJECTS',
          head_eligible: false,
          is_delete_marker: true,
        }),
      ]),
    );
    for (const [key, versionId, isDeleteMarker] of [
      [orphanKey, orphanVersionId, false],
      [deleteMarkerKey, deleteMarkerVersionId, true],
    ] as const) {
      const capabilityId = randomUUID();
      await expect(
        pool.query<{ capability_id: string | null }>(
          `SELECT issue_deletion_object_delete_capability(
             $1, $2, $3, $4, $5
           ) AS capability_id`,
          [deletionRequestId, deletionLeaseToken, capabilityId, key, versionId],
        ),
      ).resolves.toMatchObject({ rows: [{ capability_id: capabilityId }] });
      const exactDeleteGrant = await pool.query<{
        operation: string;
        resource: Record<string, unknown>;
        resource_hash: string;
      }>(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        capabilityId,
        deletionLeaseToken,
      ]);
      expect(exactDeleteGrant).toMatchObject({
        rows: [
          {
            operation: 'DELETE_WORKLOAD_OBJECT_VERSION',
            resource: {
              kind: 'OBJECT_VERSION_DELETE',
              objectClass: 'WORKLOAD_OBJECTS',
              bucket: ARTIFACT_BUCKET,
              key,
              versionId,
              isDeleteMarker,
            },
          },
        ],
      });
      const firstDelete = await beginAuthenticatedEffect(
        capabilityId,
        deletionLeaseToken,
        'DELETE_WORKLOAD_OBJECT_VERSION',
        exactDeleteGrant.rows[0]!.resource_hash,
      );
      expect(firstDelete.rows[0]?.outcome).toBe('STARTED');
      await expect(
        pool.query(
          `SELECT finish_tenant_data_broker_effect(
             $1, $2, 'UNKNOWN', NULL
           ) AS finished`,
          [firstDelete.rows[0]!.attempt_id, deletionLeaseToken],
        ),
      ).resolves.toMatchObject({ rows: [{ finished: true }] });
      const idempotentRetry = await beginAuthenticatedEffect(
        capabilityId,
        deletionLeaseToken,
        'DELETE_WORKLOAD_OBJECT_VERSION',
        exactDeleteGrant.rows[0]!.resource_hash,
      );
      expect(idempotentRetry.rows[0]?.outcome).toBe('STARTED');
      await expect(
        pool.query(
          `SELECT finish_tenant_data_broker_effect(
             $1, $2, 'SUCCESS', '{}'::jsonb
           ) AS finished`,
          [idempotentRetry.rows[0]!.attempt_id, deletionLeaseToken],
        ),
      ).resolves.toMatchObject({ rows: [{ finished: true }] });
      await expect(
        beginAuthenticatedEffect(
          capabilityId,
          deletionLeaseToken,
          'DELETE_WORKLOAD_OBJECT_VERSION',
          exactDeleteGrant.rows[0]!.resource_hash,
        ),
      ).resolves.toMatchObject({
        rows: [{ outcome: 'ALREADY_SUCCEEDED', success_receipt: {} }],
      });
    }

    await pool.query(
      `UPDATE legal_hold_object_reconciliations
       SET desired_status = 'OFF', desired_revision = 2, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND object_key = $2 AND object_version_id = $3`,
      [deletionTenantId, legalHoldAuditKey, legalHoldAuditVersionId],
    );
    await expect(
      pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
        legalHoldCapabilityId,
        legalHoldLeaseToken,
      ]),
    ).resolves.toMatchObject({ rows: [] });

    await pool.query(
      `UPDATE deletion_requests
       SET finalization_attempt_count = finalization_attempt_count + 1
       WHERE id = $1`,
      [deletionRequestId],
    );
    for (const capabilityId of [
      workloadHeadCapabilityId,
      workloadDeleteCapabilityId,
      exportLegalHoldCapabilityId,
    ]) {
      await expect(
        pool.query(`SELECT * FROM load_active_tenant_data_capability($1, $2)`, [
          capabilityId,
          deletionLeaseToken,
        ]),
      ).resolves.toMatchObject({ rows: [] });
    }
  });

  test('never issues legal-hold cloud work for an already deleted managed version', async () => {
    const objectKey = `tenants/${deletionTenantId}/audit-digests/2026/07/23/${randomUUID()}.json`;
    const versionId = 'deleted-audit-version';
    const leaseToken = randomUUID();
    await pool.query(
      `INSERT INTO managed_object_versions (
         id, tenant_id, workspace_id, object_class, object_ref, object_key,
         object_version_id, checksum, content_type, byte_length,
         lifecycle_state, created_at, deleted_at
       ) VALUES (
         $1, $2, $3, 'AUDIT_DIGEST', $4, $5, $6, $7,
         'application/json', 32, 'DELETED', clock_timestamp(), clock_timestamp()
       )`,
      [
        randomUUID(),
        deletionTenantId,
        deletionWorkspaceId,
        `s3://${AUDIT_BUCKET}/${objectKey}`,
        objectKey,
        versionId,
        sha256(`deleted:${objectKey}:${versionId}`),
      ],
    );
    await pool.query(
      `INSERT INTO legal_hold_object_reconciliations (
         tenant_id, object_key, object_version_id, object_class,
         desired_status, desired_revision, applied_status, applied_revision,
         work_lease_token, work_lease_expires_at, work_attempt_count, updated_at
       ) VALUES (
         $1, $2, $3, 'AUDIT_DIGEST', 'OFF', 1, 'UNKNOWN', 0,
         $4, clock_timestamp() + interval '5 minutes', 1, clock_timestamp()
       )`,
      [deletionTenantId, objectKey, versionId, leaseToken],
    );
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_legal_hold_set_capability(
           $1, $2, $3, $4, $5
         ) AS capability_id`,
        [deletionTenantId, objectKey, versionId, leaseToken, randomUUID()],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: null }] });
  });

  test('accepts one of 100 concurrent nonce claims and retains the replay fence', async () => {
    const nonce = randomUUID();
    const signedAt = new Date();
    const expiresAt = new Date(signedAt.getTime() + 30_000);
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        pool.query<{ consumed: boolean }>(
          `SELECT consume_tenant_data_broker_nonce($1, $2, $3) AS consumed`,
          [nonce, signedAt, expiresAt],
        ),
      ),
    );
    expect(results.filter((result) => result.rows[0]?.consumed)).toHaveLength(1);
    await expect(
      pool.query<{ consumed: boolean }>(
        `SELECT consume_tenant_data_broker_nonce($1, $2, $3) AS consumed`,
        [nonce, signedAt, expiresAt],
      ),
    ).resolves.toMatchObject({ rows: [{ consumed: false }] });

    const outsideSkew = new Date(Date.now() - 31_000);
    await expect(
      pool.query<{ consumed: boolean }>(
        `SELECT consume_tenant_data_broker_nonce($1, $2, $3) AS consumed`,
        [randomUUID(), outsideSkew, new Date(outsideSkew.getTime() + 30_000)],
      ),
    ).resolves.toMatchObject({ rows: [{ consumed: false }] });
  });

  test('atomically consumes one nonce and starts at most one broker attempt', async () => {
    const capability = await createWorkloadCapability('atomic-authenticated-begin');
    const nonce = randomUUID();
    const signedAt = new Date();
    const expiresAt = new Date(signedAt.getTime() + 30_000);
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        pool.query<{
          attempt_id: string;
          outcome: string;
          success_receipt: Record<string, unknown> | null;
        }>(
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
    const started = results.flatMap((result) =>
      result.rows.filter((row) => row.outcome === 'STARTED'),
    );
    expect(started).toHaveLength(1);
    expect(results.filter((result) => result.rows.length === 0)).toHaveLength(99);
    await expect(
      pool.query(
        `SELECT nonce, nonce_hash
         FROM tenant_data_broker_attempts
         WHERE attempt_id = $1`,
        [started[0]!.attempt_id],
      ),
    ).resolves.toMatchObject({
      rows: [{ nonce, nonce_hash: sha256(nonce) }],
    });
    await expect(
      pool.query(
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
      pool.query(
        `SELECT finish_tenant_data_broker_effect(
           $1, $2, 'FAILED', NULL
         ) AS finished`,
        [started[0]!.attempt_id, capability.leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });

    const invalidNonce = randomUUID();
    const invalidSignedAt = new Date();
    await expect(
      pool.query(
        `SELECT * FROM begin_authenticated_tenant_data_broker_effect(
           $1, $2, $3, $4, $5, 'PUT_WORKLOAD_OBJECT', $6
         )`,
        [
          invalidNonce,
          invalidSignedAt,
          new Date(invalidSignedAt.getTime() + 30_000),
          randomUUID(),
          capability.leaseToken,
          capability.resourceHash,
        ],
      ),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      pool.query(
        `SELECT count(*)::text AS count
         FROM tenant_data_broker_nonces
         WHERE nonce = $1`,
        [invalidNonce],
      ),
    ).resolves.toMatchObject({ rows: [{ count: '0' }] });
  });

  test('resolves exact PUT recovery hits and preserves fresh negative observations as UNKNOWN', async () => {
    for (const storageKind of ['WORKLOAD', 'PRIVACY'] as const) {
      for (const observation of ['FOUND', 'MISSING', 'MISMATCH'] as const) {
        const capability =
          storageKind === 'WORKLOAD'
            ? await createWorkloadCapability(`put-recovery-${storageKind}-${observation}`)
            : await createPrivacyCapability(`put-recovery-${storageKind}-${observation}`);
        const putOperation =
          storageKind === 'WORKLOAD' ? 'PUT_WORKLOAD_OBJECT' : 'PUT_PRIVACY_OBJECT';
        const recoveryOperation =
          storageKind === 'WORKLOAD' ? 'HEAD_WORKLOAD_OBJECT' : 'HEAD_PRIVACY_OBJECT';
        const putStart = await beginAuthenticatedEffect(
          capability.capabilityId,
          capability.leaseToken,
          putOperation,
          capability.resourceHash,
        );
        await expect(
          pool.query(
            `SELECT finish_tenant_data_broker_effect(
               $1, $2, 'UNKNOWN', NULL
             ) AS finished`,
            [putStart.rows[0]!.attempt_id, capability.leaseToken],
          ),
        ).resolves.toMatchObject({ rows: [{ finished: true }] });

        const recoveryCapabilityId = randomUUID();
        const issuer =
          storageKind === 'WORKLOAD'
            ? 'issue_workload_object_recovery_head_capability'
            : 'issue_privacy_object_recovery_head_capability';
        await expect(
          pool.query<{ capability_id: string | null }>(
            `SELECT ${issuer}($1, $2, $3) AS capability_id`,
            [capability.operationId, capability.leaseToken, recoveryCapabilityId],
          ),
        ).resolves.toMatchObject({
          rows: [{ capability_id: recoveryCapabilityId }],
        });
        const recoveryGrant = await pool.query<{
          resource_hash: string;
        }>(
          `SELECT resource_hash
           FROM load_active_tenant_data_capability($1, $2)`,
          [recoveryCapabilityId, capability.leaseToken],
        );
        const probeStart = await beginAuthenticatedEffect(
          recoveryCapabilityId,
          capability.leaseToken,
          recoveryOperation,
          recoveryGrant.rows[0]!.resource_hash,
        );
        const versionId = `recovered-${storageKind.toLowerCase()}-${observation.toLowerCase()}`;
        const resolution = await pool.query<{ resolved: string }>(
          `SELECT resolve_tenant_data_broker_object_put_effect(
             $1, $2, $3, $4, $5, $6, $7
           ) AS resolved`,
          [
            probeStart.rows[0]!.attempt_id,
            capability.leaseToken,
            observation,
            observation === 'FOUND' ? versionId : null,
            observation === 'FOUND' ? capability.resource.checksumSha256 : null,
            observation === 'FOUND' ? capability.resource.contentType : null,
            observation === 'FOUND' ? capability.resource.byteLength : null,
          ],
        );
        const expectedResolution = observation === 'FOUND' ? 'RESOLVED_SUCCESS' : 'NOT_RESOLVED';
        expect(resolution.rows).toEqual([{ resolved: expectedResolution }]);
        if (observation !== 'FOUND') {
          await expect(
            pool.query(
              `SELECT finish_tenant_data_broker_effect(
                 $1, $2, 'FAILED', NULL
               ) AS finished`,
              [probeStart.rows[0]!.attempt_id, capability.leaseToken],
            ),
          ).resolves.toMatchObject({ rows: [{ finished: true }] });
        }
        const retry = await beginAuthenticatedEffect(
          capability.capabilityId,
          capability.leaseToken,
          putOperation,
          capability.resourceHash,
        );
        if (observation === 'FOUND') {
          expect(retry.rows).toMatchObject([
            {
              outcome: 'ALREADY_SUCCEEDED',
              success_receipt: {
                bucket: capability.resource.bucket,
                key: capability.resource.key,
                versionId,
                checksum: capability.resource.checksumSha256,
                contentType: capability.resource.contentType,
                byteLength: capability.resource.byteLength,
              },
            },
          ]);
        } else {
          expect(retry.rows).toMatchObject([{ outcome: 'AMBIGUOUS' }]);
          await expect(
            pool.query(
              `SELECT state
               FROM tenant_data_broker_effects
               WHERE effect_identity = $1`,
              [
                storageKind === 'WORKLOAD'
                  ? `WORKLOAD_OBJECT_WRITE:${capability.operationId}`
                  : `PRIVACY_OBJECT_WRITE:${capability.operationId}`,
              ],
            ),
          ).resolves.toMatchObject({ rows: [{ state: 'UNKNOWN' }] });
        }
      }
    }

    const source = await createWorkloadCapability('put-recovery-cross-source');
    const other = await createWorkloadCapability('put-recovery-other-source');
    const putStart = await beginAuthenticatedEffect(
      source.capabilityId,
      source.leaseToken,
      'PUT_WORKLOAD_OBJECT',
      source.resourceHash,
    );
    await pool.query(`SELECT finish_tenant_data_broker_effect($1, $2, 'UNKNOWN', NULL)`, [
      putStart.rows[0]!.attempt_id,
      source.leaseToken,
    ]);
    const recoveryCapabilityId = randomUUID();
    await pool.query(`SELECT issue_workload_object_recovery_head_capability($1, $2, $3)`, [
      source.operationId,
      source.leaseToken,
      recoveryCapabilityId,
    ]);
    const recoveryGrant = await pool.query<{ resource_hash: string }>(
      `SELECT resource_hash
       FROM load_active_tenant_data_capability($1, $2)`,
      [recoveryCapabilityId, source.leaseToken],
    );
    const probeStart = await beginAuthenticatedEffect(
      recoveryCapabilityId,
      source.leaseToken,
      'HEAD_WORKLOAD_OBJECT',
      recoveryGrant.rows[0]!.resource_hash,
    );
    await expect(
      pool.query(
        `SELECT resolve_tenant_data_broker_object_put_effect(
           $1, $2, 'MISSING', NULL, NULL, NULL, NULL
         ) AS resolved`,
        [probeStart.rows[0]!.attempt_id, other.leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ resolved: 'NOT_RESOLVED' }] });
    await pool.query(
      `UPDATE workload_object_write_intents
       SET work_lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE operation_id = $1`,
      [source.operationId],
    );
    await expect(
      pool.query(
        `SELECT resolve_tenant_data_broker_object_put_effect(
           $1, $2, 'MISSING', NULL, NULL, NULL, NULL
         ) AS resolved`,
        [probeStart.rows[0]!.attempt_id, source.leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ resolved: 'NOT_RESOLVED' }] });
    await expect(
      pool.query(
        `SELECT state
         FROM tenant_data_broker_effects
         WHERE effect_identity = $1`,
        [`WORKLOAD_OBJECT_WRITE:${source.operationId}`],
      ),
    ).resolves.toMatchObject({ rows: [{ state: 'UNKNOWN' }] });
  });

  test('allows exactly one of 100 concurrent starts and returns the durable success receipt', async () => {
    const capability = await createWorkloadCapability('effect-concurrency');
    const starts = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        beginEffect(capability, sha256(`effect-concurrency-${index}`)),
      ),
    );
    const rows = starts.flatMap((result) => result.rows);
    expect(rows.filter((row) => row.outcome === 'STARTED')).toHaveLength(1);
    expect(rows.filter((row) => row.outcome === 'AMBIGUOUS')).toHaveLength(99);

    const started = rows.find((row) => row.outcome === 'STARTED');
    expect(started).toBeDefined();
    const receipt = {
      bucket: capability.resource.bucket,
      key: capability.resource.key,
      versionId: 'version-1',
      checksum: capability.resource.checksumSha256,
      contentType: capability.resource.contentType,
      byteLength: capability.resource.byteLength,
    };
    await expect(
      pool.query<{ finished: boolean }>(
        `SELECT finish_tenant_data_broker_effect($1, $2, 'SUCCESS', $3::jsonb) AS finished`,
        [started!.attempt_id, capability.leaseToken, JSON.stringify(receipt)],
      ),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });
    await expect(beginEffect(capability, sha256('cached-success'))).resolves.toMatchObject({
      rows: [{ outcome: 'ALREADY_SUCCEEDED', success_receipt: receipt }],
    });
  });

  test('retries a definite failure, but UNKNOWN and revoked post-dispatch success remain fenced', async () => {
    const failedCapability = await createWorkloadCapability('definite-failure');
    const first = await beginEffect(failedCapability, sha256('definite-failure-1'));
    await expect(
      pool.query<{ finished: boolean }>(
        `SELECT finish_tenant_data_broker_effect($1, $2, 'FAILED', NULL) AS finished`,
        [first.rows[0]!.attempt_id, failedCapability.leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });
    const retry = await beginEffect(failedCapability, sha256('definite-failure-2'));
    expect(retry.rows[0]?.outcome).toBe('STARTED');
    await expect(
      pool.query<{ finished: boolean }>(
        `SELECT finish_tenant_data_broker_effect($1, $2, 'UNKNOWN', NULL) AS finished`,
        [retry.rows[0]!.attempt_id, failedCapability.leaseToken],
      ),
    ).resolves.toMatchObject({ rows: [{ finished: true }] });
    await expect(
      beginEffect(failedCapability, sha256('definite-failure-3')),
    ).resolves.toMatchObject({ rows: [{ outcome: 'AMBIGUOUS' }] });

    const revokedCapability = await createWorkloadCapability('revoked-after-dispatch');
    const dispatched = await beginEffect(revokedCapability, sha256('revoked-after-dispatch'));
    await pool.query(
      `UPDATE workload_object_write_intents
       SET work_lease_token = $2,
           work_lease_expires_at = clock_timestamp() + interval '2 minutes'
       WHERE operation_id = $1`,
      [revokedCapability.operationId, randomUUID()],
    );
    await expect(
      pool.query<{ finished: boolean }>(
        `SELECT finish_tenant_data_broker_effect($1, $2, 'SUCCESS', $3::jsonb) AS finished`,
        [
          dispatched.rows[0]!.attempt_id,
          revokedCapability.leaseToken,
          JSON.stringify({
            bucket: ARTIFACT_BUCKET,
            key: 'revoked',
            versionId: 'version-revoked',
            checksum: 'b'.repeat(64),
            contentType: 'application/json',
            byteLength: 64,
          }),
        ],
      ),
    ).resolves.toMatchObject({ rows: [{ finished: false }] });
    await expect(
      pool.query(
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

  test('exposes only the exact issuer and broker function privileges', async () => {
    const privileges = await pool.query<{
      broker_atomic_begin: boolean;
      broker_begin: boolean;
      broker_consume: boolean;
      broker_finish: boolean;
      broker_issue: boolean;
      broker_load: boolean;
      lifecycle_begin: boolean;
      lifecycle_issue: boolean;
      public_issue: boolean;
      runtime_issue: boolean;
    }>(
      `SELECT
         has_function_privilege('public',
           'issue_workload_object_put_capability(uuid,uuid,uuid)', 'EXECUTE')
           AS public_issue,
         has_function_privilege('aeostudio_runtime',
           'issue_workload_object_put_capability(uuid,uuid,uuid)', 'EXECUTE')
           AS runtime_issue,
         has_function_privilege('aeostudio_lifecycle_worker',
           'issue_workload_object_put_capability(uuid,uuid,uuid)', 'EXECUTE')
           AS lifecycle_issue,
         has_function_privilege('aeostudio_tenant_data_broker',
           'issue_workload_object_put_capability(uuid,uuid,uuid)', 'EXECUTE')
           AS broker_issue,
         has_function_privilege('aeostudio_tenant_data_broker',
           'consume_tenant_data_broker_nonce(uuid,timestamptz,timestamptz)', 'EXECUTE')
           AS broker_consume,
         has_function_privilege('aeostudio_tenant_data_broker',
           'load_active_tenant_data_capability(uuid,uuid)', 'EXECUTE')
           AS broker_load,
         has_function_privilege('aeostudio_tenant_data_broker',
           'begin_tenant_data_broker_effect(uuid,uuid,uuid,text,text)', 'EXECUTE')
           AS broker_begin,
         has_function_privilege('aeostudio_tenant_data_broker',
           'begin_authenticated_tenant_data_broker_effect(uuid,timestamptz,timestamptz,uuid,uuid,text,text)',
           'EXECUTE') AS broker_atomic_begin,
         has_function_privilege('aeostudio_tenant_data_broker',
           'finish_tenant_data_broker_effect(uuid,uuid,text,jsonb)', 'EXECUTE')
           AS broker_finish,
         has_function_privilege('aeostudio_lifecycle_worker',
           'begin_tenant_data_broker_effect(uuid,uuid,uuid,text,text)', 'EXECUTE')
           AS lifecycle_begin`,
    );
    expect(privileges.rows).toEqual([
      {
        public_issue: false,
        runtime_issue: true,
        lifecycle_issue: true,
        broker_issue: false,
        broker_consume: false,
        broker_load: true,
        broker_begin: false,
        broker_atomic_begin: true,
        broker_finish: true,
        lifecycle_begin: false,
      },
    ]);

    const lifecycleIssuerSignatures = [
      'issue_workload_object_put_capability(uuid,uuid,uuid)',
      'issue_publication_package_read_capability(uuid,uuid,uuid)',
      'issue_publication_secret_read_capability(uuid,uuid,uuid)',
      'issue_privacy_object_put_capability(uuid,uuid,uuid)',
      'issue_workload_object_recovery_head_capability(uuid,uuid,uuid)',
      'issue_privacy_object_recovery_head_capability(uuid,uuid,uuid)',
      'issue_connector_secret_describe_capability(uuid,uuid,uuid)',
      'issue_connector_secret_delete_capability(uuid,uuid,uuid)',
      'issue_connector_secret_verify_unreadable_capability(uuid,uuid,uuid)',
      'issue_deletion_inventory_capability(uuid,uuid,uuid,integer)',
      'issue_deletion_object_head_capability(uuid,uuid,uuid,text,text)',
      'issue_deletion_object_get_legal_hold_capability(uuid,uuid,uuid,text,text)',
      'issue_deletion_object_delete_capability(uuid,uuid,uuid,text,text)',
      'issue_legal_hold_set_capability(uuid,text,text,uuid,uuid)',
      'issue_legal_hold_get_recovery_capability(uuid,text,text,uuid,uuid)',
    ];
    const runtimeIssuerSignatures = [
      'issue_authenticated_object_read_capability(text,uuid,uuid,uuid,text,text,uuid,uuid)',
    ];
    const runtimeWorkflowIssuerSignatures = [
      'issue_workload_object_put_capability(uuid,uuid,uuid)',
      'issue_publication_package_read_capability(uuid,uuid,uuid)',
      'issue_publication_secret_read_capability(uuid,uuid,uuid)',
      'issue_privacy_object_put_capability(uuid,uuid,uuid)',
      'issue_workload_object_recovery_head_capability(uuid,uuid,uuid)',
      'issue_privacy_object_recovery_head_capability(uuid,uuid,uuid)',
    ];
    const brokerFunctionSignatures = [
      'load_active_tenant_data_capability(uuid,uuid)',
      'begin_authenticated_tenant_data_broker_effect(uuid,timestamptz,timestamptz,uuid,uuid,text,text)',
      'finish_tenant_data_broker_effect(uuid,uuid,text,jsonb)',
      'resolve_tenant_data_broker_object_put_effect(uuid,uuid,text,text,text,text,bigint)',
      'resolve_tenant_data_broker_legal_hold_effect(uuid,uuid,text)',
      'resolve_tenant_data_broker_secret_delete_effect(uuid,uuid,text)',
    ];
    const privateFunctionSignatures = [
      'configure_tenant_data_broker_resource_authority(text,text,text,text,text)',
      'consume_tenant_data_broker_nonce(uuid,timestamptz,timestamptz)',
      'begin_tenant_data_broker_effect(uuid,uuid,uuid,text,text)',
      'tenant_data_canonical_utc_instant_private(timestamptz)',
      'tenant_data_issue_capability_private(uuid,text,text,bigint,uuid,text,text,text,text,uuid,uuid,text,jsonb,timestamptz)',
      'bind_tenant_data_channel_package_object_private(uuid,uuid,uuid)',
      'bind_tenant_data_channel_package_after_insert_private()',
      'bind_tenant_data_managed_package_after_insert_private()',
      'tenant_data_bump_role_binding_revision_private()',
      'tenant_data_bump_membership_revision_private()',
      'issue_connector_secret_deletion_capability_private(uuid,uuid,uuid,text)',
      'tenant_data_decode_inventory_cursor_private(text)',
      'tenant_data_managed_object_storage_class_private(managed_object_versions)',
      'tenant_data_live_legal_hold_status_private(uuid,text,text)',
      'tenant_data_load_due_deletion_object_private(uuid,uuid,text,text,timestamptz)',
      'issue_deletion_object_capability_private(uuid,uuid,uuid,text,text,text)',
      'tenant_data_validate_deletion_inventory_capability_private(tenant_data_capabilities,uuid,timestamptz)',
      'tenant_data_validate_deletion_object_capability_private(tenant_data_capabilities,uuid,timestamptz)',
      'tenant_data_validate_legal_hold_capability_private(tenant_data_capabilities,uuid,timestamptz)',
      'tenant_data_capability_source_lease_expires_at(tenant_data_capabilities,uuid,timestamptz)',
      'tenant_data_broker_source_lease_expires_at_private(tenant_data_capabilities)',
      'tenant_data_broker_provider_grace_elapsed_private(text,timestamptz)',
      'tenant_data_mark_stale_broker_effect_unknown_private()',
      'tenant_data_capability_source_lease_expires_at_task18_legacy(tenant_data_capabilities,uuid,timestamptz)',
      'resolve_tenant_data_broker_object_put_effect_task18_legacy(uuid,uuid,text,text,text,text,bigint)',
      'resolve_tenant_data_broker_legal_hold_effect_task18_legacy(uuid,uuid,text)',
    ];
    const roles = [
      'public',
      'aeostudio_runtime',
      'aeostudio_lifecycle_worker',
      'aeostudio_tenant_data_broker',
    ];
    const signatures = [
      ...lifecycleIssuerSignatures,
      ...runtimeIssuerSignatures,
      ...brokerFunctionSignatures,
      ...privateFunctionSignatures,
    ];
    const completePrivileges = await pool.query<{
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
      [roles, signatures],
    );
    const allowedFunctions = new Set([
      ...lifecycleIssuerSignatures.map((signature) => `aeostudio_lifecycle_worker|${signature}`),
      ...runtimeIssuerSignatures.map((signature) => `aeostudio_runtime|${signature}`),
      ...runtimeWorkflowIssuerSignatures.map((signature) => `aeostudio_runtime|${signature}`),
      ...brokerFunctionSignatures.map((signature) => `aeostudio_tenant_data_broker|${signature}`),
    ]);
    expect(completePrivileges.rows).toHaveLength(roles.length * signatures.length);
    for (const privilege of completePrivileges.rows) {
      expect(privilege.function_exists, privilege.function_signature).toBe(true);
      expect(privilege.can_execute, `${privilege.role_name}|${privilege.function_signature}`).toBe(
        allowedFunctions.has(`${privilege.role_name}|${privilege.function_signature}`),
      );
    }

    const expectedProcedures = await pool.query<{ function_signature: string }>(
      `SELECT to_regprocedure(function_signature)::regprocedure::text
                AS function_signature
       FROM unnest($1::text[]) AS function_signature
       ORDER BY function_signature`,
      [signatures],
    );
    const functionNames = signatures.map((signature) => signature.split('(', 1)[0]!);
    const actualProcedures = await pool.query<{ function_signature: string }>(
      `SELECT procedure.oid::regprocedure::text AS function_signature
       FROM pg_proc procedure
       WHERE procedure.pronamespace = 'public'::regnamespace
         AND procedure.proname = ANY($1::text[])
       ORDER BY function_signature`,
      [functionNames],
    );
    expect(actualProcedures.rows).toEqual(expectedProcedures.rows);

    const tablePrivileges = await pool.query<{
      broker_capability_table: boolean;
      lifecycle_capability_table: boolean;
      runtime_capability_table: boolean;
    }>(
      `SELECT
         has_table_privilege('aeostudio_runtime',
           'tenant_data_capabilities', 'SELECT,INSERT,UPDATE,DELETE')
           AS runtime_capability_table,
         has_table_privilege('aeostudio_lifecycle_worker',
           'tenant_data_capabilities', 'SELECT,INSERT,UPDATE,DELETE')
           AS lifecycle_capability_table,
         has_table_privilege('aeostudio_tenant_data_broker',
           'tenant_data_capabilities', 'SELECT,INSERT,UPDATE,DELETE')
           AS broker_capability_table`,
    );
    expect(tablePrivileges.rows).toEqual([
      {
        runtime_capability_table: false,
        lifecycle_capability_table: false,
        broker_capability_table: false,
      },
    ]);
  });

  async function createWorkloadCapability(label: string): Promise<WorkloadCapability> {
    const operationId = randomUUID();
    const leaseToken = randomUUID();
    const capabilityId = randomUUID();
    const checksum = sha256(`payload:${label}`);
    const objectKey =
      `tenants/${tenantId}/workspaces/${workspaceId}/artifacts/${randomUUID()}/` +
      `revisions/1/${checksum}.json`;
    await workloadStore.reserveWorkloadObjectWriteIntent({
      operationId,
      kind: 'ARTIFACT_PAYLOAD',
      tenantId,
      workspaceId,
      objectKey,
      checksum,
      contentType: 'application/json',
      byteLength: 128,
    });
    await expect(
      workloadStore.claimWorkloadObjectWriteIntent({ operationId, tenantId, leaseToken }),
    ).resolves.toBe(true);
    const issued = await pool.query<{ capability_id: string | null }>(
      `SELECT issue_workload_object_put_capability($1, $2, $3) AS capability_id`,
      [operationId, leaseToken, capabilityId],
    );
    expect(issued.rows[0]?.capability_id).toBe(capabilityId);
    const loaded = await pool.query<{
      resource: WorkloadCapability['resource'];
      resource_hash: string;
    }>(`SELECT resource, resource_hash FROM load_active_tenant_data_capability($1, $2)`, [
      capabilityId,
      leaseToken,
    ]);
    expect(loaded.rows).toHaveLength(1);
    return {
      capabilityId,
      leaseToken,
      operationId,
      resource: loaded.rows[0]!.resource,
      resourceHash: loaded.rows[0]!.resource_hash,
    };
  }

  async function createPrivacyCapability(label: string): Promise<PrivacyCapability> {
    const operationId = randomUUID();
    const leaseToken = randomUUID();
    const capabilityId = randomUUID();
    const payload = Buffer.from(JSON.stringify({ label }), 'utf8');
    const checksum = createHash('sha256').update(payload).digest('hex');
    const objectKey = `tenants/${tenantId}/exports/${operationId}.bundle.json`;
    await pool.query(
      `INSERT INTO privacy_object_write_intents (
         operation_id, tenant_id, workspace_id, kind, request_identity,
         business_id, actor_user_id, audit_event_id, object_key,
         canonical_payload, checksum, content_type, byte_length,
         sealed_at, locked_until, business_payload, status, created_at,
         updated_at, work_lease_token, work_lease_expires_at, work_attempt_count
       ) VALUES (
         $1, $2, $3, 'TENANT_EXPORT', $4, $5, $6, $7, $8,
         $9, $10, 'application/json', $11, NULL, NULL,
         '{}'::jsonb, 'PENDING', clock_timestamp(), clock_timestamp(),
         $12, clock_timestamp() + interval '2 minutes', 1
       )`,
      [
        operationId,
        tenantId,
        workspaceId,
        sha256(`privacy:${label}:${operationId}`),
        randomUUID(),
        ownerUserId,
        randomUUID(),
        objectKey,
        payload,
        checksum,
        payload.byteLength,
        leaseToken,
      ],
    );
    await expect(
      pool.query<{ capability_id: string | null }>(
        `SELECT issue_privacy_object_put_capability($1, $2, $3)
           AS capability_id`,
        [operationId, leaseToken, capabilityId],
      ),
    ).resolves.toMatchObject({ rows: [{ capability_id: capabilityId }] });
    const loaded = await pool.query<{
      resource: PrivacyCapability['resource'];
      resource_hash: string;
    }>(
      `SELECT resource, resource_hash
       FROM load_active_tenant_data_capability($1, $2)`,
      [capabilityId, leaseToken],
    );
    return {
      capabilityId,
      leaseToken,
      operationId,
      resource: loaded.rows[0]!.resource,
      resourceHash: loaded.rows[0]!.resource_hash,
    };
  }

  function beginAuthenticatedEffect(
    capabilityId: string,
    leaseToken: string,
    operation: string,
    resourceHash: string,
    nonce = randomUUID(),
  ) {
    const signedAt = new Date();
    return pool.query<{
      attempt_id: string;
      outcome: 'ALREADY_SUCCEEDED' | 'AMBIGUOUS' | 'STARTED';
      success_receipt: Record<string, unknown> | null;
    }>(
      `SELECT * FROM begin_authenticated_tenant_data_broker_effect(
         $1, $2, $3, $4, $5, $6, $7
       )`,
      [
        nonce,
        signedAt,
        new Date(signedAt.getTime() + 30_000),
        capabilityId,
        leaseToken,
        operation,
        resourceHash,
      ],
    );
  }

  function beginEffect(capability: WorkloadCapability, nonceHash: string) {
    void nonceHash;
    return beginAuthenticatedEffect(
      capability.capabilityId,
      capability.leaseToken,
      'PUT_WORKLOAD_OBJECT',
      capability.resourceHash,
    );
  }
});

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
