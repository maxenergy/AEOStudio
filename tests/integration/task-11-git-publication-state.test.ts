import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { TenantContext } from '@aeostudio/application/identity-access';
import type { JobLease } from '@aeostudio/application/jobs-budgets';
import {
  PostgresChannelRegistryStore,
  PostgresPublicationExecutionStore,
  PostgresPublicationQueryStore,
  PostgresPublicationRemoteStatusRefreshStore,
  runMigrations,
} from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

interface GitPullRequestRemoteState {
  status: 'PR_OPENED';
  number: number;
  isProductionLive: false;
  rollbackHandle: {
    operation: 'CLOSE_PULL_REQUEST';
    repository: string;
    pullRequestNumber: number;
  };
}

interface Task11PublicationExecutionStore {
  recordPublishApplied(input: {
    lease: JobLease;
    attemptId: string;
    remoteRef: string;
    publicationStatus: 'REMOTE_APPLIED';
    remoteState: GitPullRequestRemoteState;
    auditEventId: string;
    now: Date;
  }): Promise<boolean>;
  recordPublishAmbiguous(input: {
    lease: JobLease;
    attemptId: string;
    errorCode: string;
    remoteRef?: string;
    auditEventId: string;
    now: Date;
  }): Promise<boolean>;
  prepare(input: {
    lease: JobLease;
    publishAttemptId: string;
    reconcileAttemptId: string;
    publishAuditEventId: string;
    recoveryAuditEventId: string;
    reconcileAuditEventId: string;
    gateFailureAuditEventId: string;
    now: Date;
  }): Promise<{
    outcome: string;
    attemptId?: string;
    execution?: {
      reconciliationIntent?: {
        kind: 'COMPENSATE_UNSAFE_CREATE';
        remoteRef: string;
      };
    };
  }>;
}

describe('Task 11 Git PublicationRecord persistence', () => {
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

  test('durably returns an opened PR as tenant-isolated REMOTE_APPLIED state, not live content', async () => {
    const fixture = await seedRunningGitPublication(pool);
    const registry = await new PostgresChannelRegistryStore(pool).listEntries({
      context: fixture.ownerContext,
    });
    expect(registry.find(({ channelKey }) => channelKey === 'git-pull-request')).toMatchObject({
      displayName: 'Git Pull Request',
      status: 'AVAILABLE',
      adapterVersions: [
        {
          adapterKey: 'git-pull-request',
          adapterVersion: '1.0.0',
          enabled: false,
          capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'PULL_REQUEST_STATUS'],
          requiredScopes: ['contents:write', 'pull_requests:write', 'metadata:read'],
          termsStatus: 'REVIEW_REQUIRED',
        },
      ],
    });
    const remoteRef = 'https://git.example.test/tenant-owned/site-content/pull/41';
    const remoteState: GitPullRequestRemoteState = {
      status: 'PR_OPENED',
      number: 41,
      isProductionLive: false,
      rollbackHandle: {
        operation: 'CLOSE_PULL_REQUEST',
        repository: 'tenant-owned/site-content',
        pullRequestNumber: 41,
      },
    };
    const executionStore = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as Task11PublicationExecutionStore;

    expect(
      await executionStore.recordPublishApplied({
        lease: fixture.lease,
        attemptId: fixture.attemptId,
        remoteRef,
        publicationStatus: 'REMOTE_APPLIED',
        remoteState,
        auditEventId: randomUUID(),
        now: fixture.now,
      }),
    ).toBe(true);

    const queryStore = new PostgresPublicationQueryStore(pool);
    const ownerView = await queryStore.findDetail({
      context: fixture.ownerContext,
      publicationId: fixture.publicationId,
    });
    expect.soft(ownerView?.publication).toMatchObject({
      id: fixture.publicationId,
      status: 'REMOTE_APPLIED',
      remoteRef,
      remoteState,
    });
    expect.soft(ownerView?.publication).not.toMatchObject({ status: 'PUBLISHED' });

    const crossTenantGuess = await queryStore.findDetail({
      context: fixture.crossTenantContext,
      publicationId: fixture.publicationId,
    });
    expect(crossTenantGuess).toBeNull();

    const mergedState = {
      status: 'MERGED' as const,
      number: 41,
      isProductionLive: false as const,
      rollbackHandle: null,
    };
    const statusStore = new PostgresPublicationRemoteStatusRefreshStore(pool);
    await expect(
      statusStore.record({
        context: fixture.ownerContext,
        publicationId: fixture.publicationId,
        expectedRemoteRef: remoteRef,
        expectedRemoteState: remoteState,
        remoteState: mergedState,
        auditEventId: randomUUID(),
        now: new Date('2026-07-21T08:05:00.000Z'),
      }),
    ).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      publication: {
        id: fixture.publicationId,
        status: 'REMOTE_APPLIED',
        remoteRef,
        remoteState: mergedState,
      },
    });

    await expect(
      statusStore.record({
        context: fixture.ownerContext,
        publicationId: fixture.publicationId,
        expectedRemoteRef: remoteRef,
        expectedRemoteState: remoteState,
        remoteState: {
          status: 'CLOSED',
          number: 41,
          isProductionLive: false,
          rollbackHandle: null,
        },
        auditEventId: randomUUID(),
        now: new Date('2026-07-21T08:06:00.000Z'),
      }),
    ).resolves.toEqual({ outcome: 'STALE' });

    await expect(
      statusStore.record({
        context: fixture.ownerContext,
        publicationId: fixture.publicationId,
        expectedRemoteRef: remoteRef,
        expectedRemoteState: mergedState,
        remoteState: {
          ...mergedState,
          secret: 'must-not-be-persisted',
        } as unknown as GitPullRequestRemoteState,
        auditEventId: randomUUID(),
        now: new Date('2026-07-21T08:06:30.000Z'),
      }),
    ).resolves.toEqual({ outcome: 'INVALID' });

    await expect(
      statusStore.record({
        context: fixture.crossTenantContext,
        publicationId: fixture.publicationId,
        expectedRemoteRef: remoteRef,
        expectedRemoteState: remoteState,
        remoteState: mergedState,
        auditEventId: randomUUID(),
        now: new Date('2026-07-21T08:07:00.000Z'),
      }),
    ).resolves.toEqual({ outcome: 'NOT_FOUND' });
  });

  test('durably recovers an exact unsafe-create compensation intent for initial and interrupted reconciliation', async () => {
    const fixture = await seedRunningGitPublication(pool);
    const remoteRef = 'https://git.example.test/tenant-owned/site-content/pull/41';
    const executionStore = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as Task11PublicationExecutionStore;

    await expect(
      executionStore.recordPublishAmbiguous({
        lease: fixture.lease,
        attemptId: fixture.attemptId,
        errorCode: 'UNSAFE_CREATE_COMPENSATION_PENDING',
        remoteRef,
        auditEventId: randomUUID(),
        now: fixture.now,
      }),
    ).resolves.toBe(true);

    const firstReconcile = await executionStore.prepare({
      lease: fixture.lease,
      publishAttemptId: randomUUID(),
      reconcileAttemptId: randomUUID(),
      publishAuditEventId: randomUUID(),
      recoveryAuditEventId: randomUUID(),
      reconcileAuditEventId: randomUUID(),
      gateFailureAuditEventId: randomUUID(),
      now: fixture.now,
    });
    expect(firstReconcile).toMatchObject({
      outcome: 'RECONCILE',
      execution: {
        reconciliationIntent: {
          kind: 'COMPENSATE_UNSAFE_CREATE',
          remoteRef,
        },
      },
    });

    const interruptedReconcile = await executionStore.prepare({
      lease: fixture.lease,
      publishAttemptId: randomUUID(),
      reconcileAttemptId: randomUUID(),
      publishAuditEventId: randomUUID(),
      recoveryAuditEventId: randomUUID(),
      reconcileAuditEventId: randomUUID(),
      gateFailureAuditEventId: randomUUID(),
      now: fixture.now,
    });
    expect(interruptedReconcile).toMatchObject({
      outcome: 'RECONCILE',
      attemptId: firstReconcile.attemptId,
      execution: {
        reconciliationIntent: {
          kind: 'COMPENSATE_UNSAFE_CREATE',
          remoteRef,
        },
      },
    });

    const attempts = await pool.query<{
      outcome: string;
      error_code: string | null;
      remote_ref: string | null;
    }>(
      `SELECT outcome, error_code, remote_ref
       FROM publication_attempts
       WHERE publication_id = $1 AND operation = 'PUBLISH'
       ORDER BY attempt_number DESC
       LIMIT 1`,
      [fixture.publicationId],
    );
    expect(attempts.rows).toEqual([
      {
        outcome: 'AMBIGUOUS',
        error_code: 'UNSAFE_CREATE_COMPENSATION_PENDING',
        remote_ref: remoteRef,
      },
    ]);
  });

  test('does not invent compensation intent when a publish worker crashes without durable proof', async () => {
    const fixture = await seedRunningGitPublication(pool);
    const executionStore = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as Task11PublicationExecutionStore;

    const recovered = await executionStore.prepare({
      lease: fixture.lease,
      publishAttemptId: randomUUID(),
      reconcileAttemptId: randomUUID(),
      publishAuditEventId: randomUUID(),
      recoveryAuditEventId: randomUUID(),
      reconcileAuditEventId: randomUUID(),
      gateFailureAuditEventId: randomUUID(),
      now: fixture.now,
    });
    expect(recovered).toMatchObject({ outcome: 'RECONCILE' });
    expect(recovered.execution).not.toHaveProperty('reconciliationIntent');

    const interruptedReconcile = await executionStore.prepare({
      lease: fixture.lease,
      publishAttemptId: randomUUID(),
      reconcileAttemptId: randomUUID(),
      publishAuditEventId: randomUUID(),
      recoveryAuditEventId: randomUUID(),
      reconcileAuditEventId: randomUUID(),
      gateFailureAuditEventId: randomUUID(),
      now: fixture.now,
    });
    expect(interruptedReconcile).toMatchObject({
      outcome: 'RECONCILE',
      attemptId: recovered.attemptId,
    });
    expect(interruptedReconcile.execution).not.toHaveProperty('reconciliationIntent');

    const attempts = await pool.query<{
      outcome: string;
      error_code: string | null;
      remote_ref: string | null;
    }>(
      `SELECT outcome, error_code, remote_ref
       FROM publication_attempts
       WHERE publication_id = $1 AND operation = 'PUBLISH'
       ORDER BY attempt_number DESC
       LIMIT 1`,
      [fixture.publicationId],
    );
    expect(attempts.rows).toEqual([
      {
        outcome: 'AMBIGUOUS',
        error_code: 'PUBLISH_INTERRUPTED_OUTCOME_UNKNOWN',
        remote_ref: null,
      },
    ]);
  });

  test('does not resurrect an older compensation intent after a later generic publish attempt', async () => {
    const fixture = await seedRunningGitPublication(pool);
    const remoteRef = 'https://git.example.test/tenant-owned/site-content/pull/41';
    const executionStore = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as Task11PublicationExecutionStore;

    await expect(
      executionStore.recordPublishAmbiguous({
        lease: fixture.lease,
        attemptId: fixture.attemptId,
        errorCode: 'UNSAFE_CREATE_COMPENSATION_PENDING',
        remoteRef,
        auditEventId: randomUUID(),
        now: fixture.now,
      }),
    ).resolves.toBe(true);
    await pool.query(
      `INSERT INTO publication_attempts
         (id, tenant_id, workspace_id, publication_id, attempt_number, operation, outcome,
          remote_ref, error_code, started_at, finished_at)
       VALUES ($1, $2, $3, $4, 2, 'PUBLISH', 'AMBIGUOUS', NULL,
         'ADAPTER_PUBLISH_OUTCOME_UNKNOWN', $5, $5)`,
      [
        randomUUID(),
        fixture.lease.job.tenantId,
        fixture.lease.job.workspaceId,
        fixture.publicationId,
        fixture.now,
      ],
    );

    const reconcile = await executionStore.prepare({
      lease: fixture.lease,
      publishAttemptId: randomUUID(),
      reconcileAttemptId: randomUUID(),
      publishAuditEventId: randomUUID(),
      recoveryAuditEventId: randomUUID(),
      reconcileAuditEventId: randomUUID(),
      gateFailureAuditEventId: randomUUID(),
      now: fixture.now,
    });

    expect(reconcile).toMatchObject({ outcome: 'RECONCILE' });
    expect(reconcile.execution).not.toHaveProperty('reconciliationIntent');
  });
});

async function seedRunningGitPublication(pool: Pool): Promise<{
  publicationId: string;
  attemptId: string;
  now: Date;
  lease: JobLease;
  ownerContext: TenantContext;
  crossTenantContext: TenantContext;
}> {
  const ids = {
    userA: randomUUID(),
    userB: randomUUID(),
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    workspaceA: randomUUID(),
    workspaceB: randomUUID(),
    contentPlan: randomUUID(),
    opportunity: randomUUID(),
    brief: randomUUID(),
    artifact: randomUUID(),
    artifactRevision: randomUUID(),
    channel: randomUUID(),
    adapterVersion: randomUUID(),
    channelPackage: randomUUID(),
    authorization: randomUUID(),
    publication: randomUUID(),
    job: randomUUID(),
    attempt: randomUUID(),
    leaseToken: randomUUID(),
  };
  const now = new Date('2026-07-21T08:00:00.000Z');
  const contentHash = 'a'.repeat(64);
  const packageChecksum = 'b'.repeat(64);
  const target = 'git-pr://installation-4101/tenant-owned/site-content/main/content';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedIdentityScope(client, ids, now);
    await seedArtifactAndPackage(client, ids, {
      now,
      contentHash,
      packageChecksum,
      target,
    });
    await seedPublicationIntent(client, ids, {
      now,
      contentHash,
      packageChecksum,
      target,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const lease: JobLease = {
    job: {
      id: ids.job,
      tenantId: ids.tenantA,
      workspaceId: ids.workspaceA,
      providerKey: null,
      jobType: 'PUBLICATION',
      aggregateId: ids.publication,
      status: 'RUNNING',
      progress: 10,
      attempt: 1,
      maxAttempts: 3,
      budgetWarning: false,
      estimatedUnits: 5,
      heartbeatAt: now.toISOString(),
      result: null,
      errorCode: null,
    },
    leaseToken: ids.leaseToken,
    messageId: randomUUID(),
  };
  const ownerContext: TenantContext = {
    tenantId: ids.tenantA,
    workspaceId: ids.workspaceA,
    actorUserId: ids.userA,
    membershipId: randomUUID(),
    role: 'OWNER',
  };
  return {
    publicationId: ids.publication,
    attemptId: ids.attempt,
    now,
    lease,
    ownerContext,
    crossTenantContext: {
      ...ownerContext,
      tenantId: ids.tenantB,
      actorUserId: ids.userB,
      membershipId: randomUUID(),
    },
  };
}

async function seedIdentityScope(client: PoolClient, ids: FixtureIds, now: Date): Promise<void> {
  await client.query(
    `INSERT INTO users (id, email, created_at)
     VALUES ($1, $3, $5),
            ($2, $4, $5)`,
    [
      ids.userA,
      ids.userB,
      `task11-${ids.userA}@example.test`,
      `task11-${ids.userB}@example.test`,
      now,
    ],
  );
  await client.query(
    `INSERT INTO tenants (id, name, created_at)
     VALUES ($1, 'Task 11 Tenant A', $3),
            ($2, 'Task 11 Tenant B', $3)`,
    [ids.tenantA, ids.tenantB, now],
  );
  await client.query(
    `INSERT INTO workspaces (id, tenant_id, name, created_at)
     VALUES ($1, $2, 'Task 11 Workspace A', $5),
            ($3, $4, 'Task 11 Workspace B', $5)`,
    [ids.workspaceA, ids.tenantA, ids.workspaceB, ids.tenantB, now],
  );
}

async function seedArtifactAndPackage(
  client: PoolClient,
  ids: FixtureIds,
  input: FixtureValues,
): Promise<void> {
  const channelKey = `git-pull-request-test-${ids.channel}`;
  await client.query(
    `INSERT INTO content_plans
       (id, tenant_id, workspace_id, status, method_policy_version, input_snapshot,
        content_hash, created_by_user_id, created_at, completed_at)
     VALUES ($1, $2, $3, 'READY', 'task11-fixture-v1', '{}'::jsonb, $4, $5, $6, $6)`,
    [ids.contentPlan, ids.tenantA, ids.workspaceA, input.contentHash, ids.userA, input.now],
  );
  await client.query(
    `INSERT INTO opportunities
       (id, tenant_id, workspace_id, content_plan_id, opportunity_key, asset_kind,
        business_value, evidence_readiness, visibility_gap, effort, risk, priority_score,
        priority_rank, rank_reason, action, evidence_ready, publish_ready)
     VALUES ($1, $2, $3, $4, 'DEFINITION_PRODUCT', 'DEFINITION_PRODUCT', 100, 100,
       '{}'::jsonb, 1, 1, 99, 1, 'Task 11 persistence fixture', 'BRIEF', true, false)`,
    [ids.opportunity, ids.tenantA, ids.workspaceA, ids.contentPlan],
  );
  await client.query(
    `INSERT INTO briefs
       (id, tenant_id, workspace_id, content_plan_id, opportunity_id, brief_key, asset_kind,
        title, prompt_ids, claim_revision_ids, source_artifact_ids, status, evidence_ready,
        publish_ready, content_hash, created_by_user_id, created_at)
     VALUES ($1, $2, $3, $4, $5, 'DEFINITION_PRODUCT', 'DEFINITION_PRODUCT',
       'Task 11 PR persistence fixture', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
       'APPROVED', true, false, $6, $7, $8)`,
    [
      ids.brief,
      ids.tenantA,
      ids.workspaceA,
      ids.contentPlan,
      ids.opportunity,
      input.contentHash,
      ids.userA,
      input.now,
    ],
  );
  await client.query(
    `INSERT INTO artifacts
       (id, tenant_id, workspace_id, brief_id, artifact_type, current_revision, status,
        locale, market, method_policy_version, created_by_user_id, created_at)
     VALUES ($1, $2, $3, $4, 'DEFINITION_PRODUCT', 1, 'APPROVED', 'en-SG', 'SG',
       'task11-fixture-v1', $5, $6)`,
    [ids.artifact, ids.tenantA, ids.workspaceA, ids.brief, ids.userA, input.now],
  );
  await client.query(
    `INSERT INTO artifact_revisions
       (id, tenant_id, workspace_id, artifact_id, revision, brief_id, artifact_type,
        schema_version, content_hash, status, locale, market, source_artifact_ids, lineage,
        claim_bindings, method_policy_version, created_by_actor_kind, created_by_actor_id,
        created_at, payload_object_ref)
     VALUES ($1, $2, $3, $4, 1, $5, 'DEFINITION_PRODUCT', '1.0.0', $6, 'APPROVED',
       'en-SG', 'SG', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 'task11-fixture-v1',
       'USER', $7, $8, 'memory://task11-artifact')`,
    [
      ids.artifactRevision,
      ids.tenantA,
      ids.workspaceA,
      ids.artifact,
      ids.brief,
      input.contentHash,
      ids.userA,
      input.now,
    ],
  );
  await client.query(
    `INSERT INTO channel_definitions
       (id, channel_key, display_name, status, package_transformer_key,
        package_schema_version, created_at, updated_at)
     VALUES ($1, $2, 'Git Pull Request Test', 'AVAILABLE',
       'generic-web-package', '1.0.0', $3, $3)`,
    [ids.channel, channelKey, input.now],
  );
  await client.query(
    `INSERT INTO adapter_versions
       (id, channel_definition_id, adapter_key, adapter_version, enabled, capabilities,
        required_scopes, terms_version, terms_status, processing_region, retention_policy,
        training_policy, subprocessors, rate_policy, created_at)
     VALUES ($1, $2, 'git-pull-request', '1.0.0', true,
       ARRAY['PREVIEW','PUBLISH','RECONCILE','ROLLBACK','PULL_REQUEST_STATUS'],
       ARRAY['contents:write','pull_requests:write'], 'git-test-terms-v1', 'ALLOWED',
       'in-process-test-runtime', 'No retention.', 'No training.', '[]'::jsonb,
       '{"mode":"deterministic-test-only"}'::jsonb, $3)`,
    [ids.adapterVersion, ids.channel, input.now],
  );
  await client.query(
    `INSERT INTO channel_packages
       (id, tenant_id, workspace_id, package_revision, channel_definition_id, channel_key,
        transformer_key, transformer_version, package_schema_version, artifact_id,
        artifact_revision_id, artifact_revision, artifact_content_hash, artifact_type,
        artifact_locale, artifact_market, artifact_method_policy_version, manifest,
        package_checksum, payload_object_ref, created_by_user_id, created_at)
     VALUES ($1, $2, $3, 1, $4, $11, 'generic-web-package', '1.0.0',
       '1.0.0', $5, $6, 1, $7, 'DEFINITION_PRODUCT', 'en-SG', 'SG',
       'task11-fixture-v1', '{"schemaVersion":"1.0.0","files":[],"assetRefs":[],"claimSourceMap":[]}'::jsonb,
       $8, 'memory://task11-package', $9, $10)`,
    [
      ids.channelPackage,
      ids.tenantA,
      ids.workspaceA,
      ids.channel,
      ids.artifact,
      ids.artifactRevision,
      input.contentHash,
      input.packageChecksum,
      ids.userA,
      input.now,
      channelKey,
    ],
  );
  await client.query(
    `INSERT INTO channel_authorizations
       (id, tenant_id, workspace_id, adapter_version_id, status, secret_arn, granted_scopes,
        accepted_terms_version, target, validation_status, validation_actual_target,
        validation_actual_scopes, validation_terms_version,
        validation_credential_fingerprint, validated_at, validation_valid_until,
        created_by_user_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'ACTIVE',
        'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:task11/git-pr',
        ARRAY['contents:write','pull_requests:write'], 'git-test-terms-v1', $5,
        'VERIFIED', $5, ARRAY['contents:write','pull_requests:write'],
        'git-test-terms-v1', repeat('d', 64), $7, $7::timestamptz + interval '1 hour',
        $6, $7, $7)`,
    [
      ids.authorization,
      ids.tenantA,
      ids.workspaceA,
      ids.adapterVersion,
      input.target,
      ids.userA,
      input.now,
    ],
  );
}

async function seedPublicationIntent(
  client: PoolClient,
  ids: FixtureIds,
  input: FixtureValues,
): Promise<void> {
  await client.query(
    `INSERT INTO jobs
       (id, tenant_id, workspace_id, job_type, aggregate_id, status, progress, attempt,
        max_attempts, idempotency_key, estimated_units, requested_by_user_id, lease_token,
        lease_expires_at, heartbeat_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'PUBLICATION', $4, 'RUNNING', 10, 1, 3,
       'task11-publication-job', 5, $5, $6, $7, $8, $8, $8)`,
    [
      ids.job,
      ids.tenantA,
      ids.workspaceA,
      ids.publication,
      ids.userA,
      ids.leaseToken,
      new Date('2026-07-21T09:00:00.000Z'),
      input.now,
    ],
  );
  await client.query(
    `INSERT INTO publication_records
       (id, tenant_id, workspace_id, channel_package_id, package_checksum,
        artifact_revision_id, artifact_content_hash, adapter_version_id,
        channel_authorization_id, authorization_target, target, idempotency_key, request_hash, status, job_id,
        requested_by_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10,
       'task11-reviewed-intent', $11, 'RUNNING', $12, $13, $14, $14)`,
    [
      ids.publication,
      ids.tenantA,
      ids.workspaceA,
      ids.channelPackage,
      input.packageChecksum,
      ids.artifactRevision,
      input.contentHash,
      ids.adapterVersion,
      ids.authorization,
      input.target,
      'c'.repeat(64),
      ids.job,
      ids.userA,
      input.now,
    ],
  );
  await client.query(
    `INSERT INTO publication_attempts
       (id, tenant_id, workspace_id, publication_id, attempt_number, operation, outcome,
        started_at)
     VALUES ($1, $2, $3, $4, 1, 'PUBLISH', 'STARTED', $5)`,
    [ids.attempt, ids.tenantA, ids.workspaceA, ids.publication, input.now],
  );
}

type FixtureIds = {
  userA: string;
  userB: string;
  tenantA: string;
  tenantB: string;
  workspaceA: string;
  workspaceB: string;
  contentPlan: string;
  opportunity: string;
  brief: string;
  artifact: string;
  artifactRevision: string;
  channel: string;
  adapterVersion: string;
  channelPackage: string;
  authorization: string;
  publication: string;
  job: string;
  attempt: string;
  leaseToken: string;
};

interface FixtureValues {
  now: Date;
  contentHash: string;
  packageChecksum: string;
  target: string;
}
