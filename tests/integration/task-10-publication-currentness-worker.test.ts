import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { canonicalArtifactJson } from '@aeostudio/application/artifacts';
import type { JobLease } from '@aeostudio/application/jobs-budgets';
import type {
  ChannelPackageManifest,
  ChannelPackagePayload,
} from '@aeostudio/domain/channels-publishing';
import {
  PostgresArtifactStore,
  PostgresEvidenceClaimStore,
  PostgresJobBudgetStore,
  PostgresPublicationExecutionStore,
  runMigrations,
} from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PublicationExecutionHandler } from '../../apps/worker/src/publication-execution-handler.js';
import { lockCurrentApprovedArtifactForPublication } from '../../packages/db/src/channels-publishing/postgres-current-approved-artifact-fence.js';

interface CurrentnessExecutionStore {
  prepare(input: {
    lease: JobLease;
    publishAttemptId: string;
    reconcileAttemptId: string;
    publishAuditEventId: string;
    recoveryAuditEventId: string;
    reconcileAuditEventId: string;
    gateFailureAuditEventId: string;
    now: Date;
  }): Promise<{ outcome: string; errorCode?: string; attemptId?: string }>;
  runGuardedEffect<T>(
    input: {
      lease: JobLease;
      attemptId: string;
      operation: 'PUBLISH' | 'RECONCILE';
      expectedAuthorizationMaterial: {
        secretReference: string;
        credentialFingerprint: string;
      };
      expectedRequiredScopes: string[];
    },
    effect: () => Promise<T>,
  ): Promise<
    { outcome: 'EXECUTED'; value: T } | { outcome: 'FENCED' } | { outcome: 'GATE_REJECTED' }
  >;
}

interface RunningPublicationOptions {
  claimCurrentRevision?: number;
  claimExpiresAt?: Date | null;
  claimSnippet?: string | null;
  duplicateClaimEvidence?: boolean;
  grantedScopes?: string[];
  includeClaimReview?: boolean;
  includeStartedAttempt?: boolean;
  publicationStatus?: 'AMBIGUOUS' | 'QUEUED' | 'RECONCILE_REQUIRED' | 'RUNNING';
  registryRequiredScopes?: string[];
  requiredScopesSnapshot?: string[];
  scenarioRegistryStatus?: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
  scenarioVersion?: number;
  validationActualScopes?: string[];
}

describe('Task 10 PostgreSQL publication worker Artifact currentness', () => {
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

  test('starts a fresh PUBLISH effect inside the guard and rejects it without an effect after Artifact r2', async () => {
    const fresh = await seedRunningPublication(pool);
    const store = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as CurrentnessExecutionStore;
    let effects = 0;

    await expect(
      store.runGuardedEffect(
        {
          lease: fresh.lease,
          attemptId: fresh.attemptId,
          operation: 'PUBLISH',
          expectedAuthorizationMaterial: fresh.authorizationMaterial,
          expectedRequiredScopes: ['content:write'],
        },
        () => {
          effects += 1;
          return Promise.resolve('fresh-effect');
        },
      ),
    ).resolves.toEqual({
      outcome: 'EXECUTED',
      value: 'fresh-effect',
    });

    const stale = await seedRunningPublication(pool);
    await advanceArtifactToRevisionTwo(pool, stale);
    await expect(
      store.runGuardedEffect(
        {
          lease: stale.lease,
          attemptId: stale.attemptId,
          operation: 'PUBLISH',
          expectedAuthorizationMaterial: stale.authorizationMaterial,
          expectedRequiredScopes: ['content:write'],
        },
        () => {
          effects += 1;
          return Promise.resolve('stale-effect');
        },
      ),
    ).resolves.toEqual({
      outcome: 'GATE_REJECTED',
    });
    expect(effects).toBe(1);

    const packageSnapshot = await pool.query<{ artifact_revision: number }>(
      `SELECT artifact_revision FROM channel_packages WHERE id = $1`,
      [stale.channelPackageId],
    );
    expect(packageSnapshot.rows).toEqual([{ artifact_revision: 1 }]);
  });

  test('allows a target-scoped Adapter effect when its dynamic scopes are a granted Registry subset', async () => {
    const fixture = await seedRunningPublication(pool, {
      registryRequiredScopes: ['content:write', 'content:admin'],
      grantedScopes: ['content:write'],
      includeStartedAttempt: false,
      publicationStatus: 'QUEUED',
      validationActualScopes: ['content:write'],
    });
    let publishCalls = 0;
    const adapter = {
      adapterKey: 'currentness-adapter',
      adapterVersion: '1.0.0',
      describe: () => ({
        adapterKey: 'currentness-adapter',
        adapterVersion: '1.0.0',
        capabilities: ['PUBLISH', 'RECONCILE'],
        requiredScopes: ['content:write', 'content:admin'],
        termsVersion: 'currentness-terms-v1',
        processingRegion: 'in-process-test-runtime',
        retentionPolicy: 'No retention.',
        trainingPolicy: 'No training.',
        subprocessors: [],
        ratePolicy: { mode: 'test' },
      }),
      requiredScopesFor: () => ['content:write'],
      validateAuthorization: () => Promise.resolve({ outcome: 'VALID' as const }),
      preview: () => ({
        packageChecksum: '',
        files: fixture.packagePayload.files,
      }),
      publish: () => {
        publishCalls += 1;
        return Promise.resolve({
          outcome: 'APPLIED' as const,
          remoteRef: 'currentness://remote/target-scoped',
        });
      },
      reconcile: () =>
        Promise.resolve({
          outcome: 'DEFINITELY_NOT_APPLIED' as const,
          errorCode: 'NOT_APPLIED',
        }),
    };
    const handler = new PublicationExecutionHandler(
      new PostgresPublicationExecutionStore(pool),
      {
        readPublicationPackage: () => Promise.resolve(fixture.packagePayload),
      },
      {
        resolve: () => adapter,
      },
      {
        readForPublication: () => Promise.resolve(fixture.authorizationMaterial),
      },
      {
        readPublicationSecret: () => Promise.resolve(fixture.secretValue),
      },
      { next: randomUUID },
      { now: () => fixture.now },
    );

    await expect(handler.run(fixture.lease)).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      publicationStatus: 'PUBLISHED',
      remoteRef: 'currentness://remote/target-scoped',
    });
    expect(publishCalls).toBe(1);
  });

  test('rejects a guarded effect when the durable dynamic scope is missing from the live authorization', async () => {
    const fixture = await seedRunningPublication(pool, {
      registryRequiredScopes: ['content:write', 'content:admin'],
      requiredScopesSnapshot: ['content:write', 'content:admin'],
      grantedScopes: ['content:write'],
      validationActualScopes: ['content:write'],
    });
    const store = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as CurrentnessExecutionStore;
    let effects = 0;

    await expect(
      store.runGuardedEffect(
        {
          lease: fixture.lease,
          attemptId: fixture.attemptId,
          operation: 'PUBLISH',
          expectedAuthorizationMaterial: fixture.authorizationMaterial,
          expectedRequiredScopes: ['content:write', 'content:admin'],
        },
        () => {
          effects += 1;
          return Promise.resolve('must-not-publish-with-missing-scope');
        },
      ),
    ).resolves.toEqual({ outcome: 'GATE_REJECTED' });
    expect(effects).toBe(0);
  });

  test('allows a legitimate empty dynamic scope snapshot but rejects an empty-parameter bypass', async () => {
    const empty = await seedRunningPublication(pool, {
      registryRequiredScopes: ['content:write'],
      requiredScopesSnapshot: [],
      grantedScopes: [],
      validationActualScopes: [],
    });
    const store = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as CurrentnessExecutionStore;
    await expect(
      store.runGuardedEffect(
        {
          lease: empty.lease,
          attemptId: empty.attemptId,
          operation: 'PUBLISH',
          expectedAuthorizationMaterial: empty.authorizationMaterial,
          expectedRequiredScopes: [],
        },
        () => Promise.resolve('empty-scope-effect'),
      ),
    ).resolves.toEqual({ outcome: 'EXECUTED', value: 'empty-scope-effect' });

    const nonempty = await seedRunningPublication(pool);
    let bypassEffects = 0;
    await expect(
      store.runGuardedEffect(
        {
          lease: nonempty.lease,
          attemptId: nonempty.attemptId,
          operation: 'PUBLISH',
          expectedAuthorizationMaterial: nonempty.authorizationMaterial,
          expectedRequiredScopes: [],
        },
        () => {
          bypassEffects += 1;
          return Promise.resolve('must-not-bypass-durable-scopes');
        },
      ),
    ).resolves.toEqual({ outcome: 'GATE_REJECTED' });
    expect(bypassEffects).toBe(0);
  });

  test.each([
    { snapshot: ['content:write', 'content:write'], kind: 'duplicate' },
    { snapshot: [' content:write'], kind: 'untrimmed' },
    { snapshot: ['content:undeclared'], kind: 'undeclared' },
  ] as const)('rejects a $kind durable publication scope snapshot', async ({ snapshot }) => {
    await expect(
      seedRunningPublication(pool, {
        registryRequiredScopes: ['content:write'],
        requiredScopesSnapshot: [...snapshot],
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test.each([
    { kind: 'Scenario version drift', options: { scenarioVersion: 2 } },
    { kind: 'unavailable Scenario', options: { scenarioRegistryStatus: 'UNAVAILABLE' as const } },
    { kind: 'historical Claim revision', options: { claimCurrentRevision: 2 } },
    { kind: 'missing Claim approval review', options: { includeClaimReview: false } },
    { kind: 'Claim without expiry', options: { claimExpiresAt: null } },
    { kind: 'Evidence without snippet', options: { claimSnippet: null } },
    { kind: 'duplicate bound Evidence', options: { duplicateClaimEvidence: true } },
  ] satisfies Array<{ kind: string; options: RunningPublicationOptions }>)(
    'rejects $kind at both package creation and final PUBLISH fences',
    async ({ options }) => {
      const fixture = await seedRunningPublication(pool, options);

      await expect(readPackageCurrentnessFence(pool, fixture)).resolves.toBe(false);

      const store = new PostgresPublicationExecutionStore(
        pool,
      ) as unknown as CurrentnessExecutionStore;
      let effects = 0;
      await expect(
        store.runGuardedEffect(
          {
            lease: fixture.lease,
            attemptId: fixture.attemptId,
            operation: 'PUBLISH',
            expectedAuthorizationMaterial: fixture.authorizationMaterial,
            expectedRequiredScopes: ['content:write'],
          },
          () => {
            effects += 1;
            return Promise.resolve('must-not-publish-incomplete-lineage');
          },
        ),
      ).resolves.toEqual({ outcome: 'GATE_REJECTED' });
      expect(effects).toBe(0);
    },
  );

  test('restricts runtime lineage DML to the six Store-owned projection/status columns', async () => {
    const permissions = await pool.query<{
      table_name: string;
      table_update: boolean;
      table_delete: boolean;
    }>(
      `SELECT protected.table_name,
              has_table_privilege(
                'aeostudio_runtime',
                'public.' || protected.table_name,
                'UPDATE'
              ) AS table_update,
              has_table_privilege(
                'aeostudio_runtime',
                'public.' || protected.table_name,
                'DELETE'
              ) AS table_delete
       FROM unnest(ARRAY[
         'profiles', 'profile_revisions', 'offerings', 'offering_revisions',
         'offering_attribute_definitions', 'offering_attribute_values',
         'evidence_sources', 'evidence_snapshots', 'claims', 'claim_revisions',
         'claim_evidence_links', 'claim_reviews', 'prompt_sets', 'prompt_revisions',
         'measurement_scenarios', 'prompt_approvals'
       ]) protected(table_name)
       ORDER BY protected.table_name`,
    );
    expect(permissions.rows).toHaveLength(16);
    expect(permissions.rows.every((row) => !row.table_update && !row.table_delete)).toBe(true);

    const allowedColumns = await pool.query<{ allowed: boolean }>(
      `SELECT has_column_privilege(
                'aeostudio_runtime', 'public.profiles', 'current_revision', 'UPDATE'
              )
              AND has_column_privilege(
                'aeostudio_runtime', 'public.offerings', 'current_revision', 'UPDATE'
              )
              AND has_column_privilege(
                'aeostudio_runtime', 'public.evidence_sources', 'current_snapshot_id', 'UPDATE'
              )
              AND has_column_privilege(
                'aeostudio_runtime', 'public.claim_revisions', 'status', 'UPDATE'
              )
              AND has_column_privilege(
                'aeostudio_runtime', 'public.prompt_sets', 'current_revision', 'UPDATE'
              )
              AND has_column_privilege(
                'aeostudio_runtime', 'public.prompt_revisions', 'status', 'UPDATE'
              ) AS allowed`,
    );
    expect(allowedColumns.rows).toEqual([{ allowed: true }]);

    const fixture = await seedRunningPublication(pool);
    await expect(
      queryAsRuntime(
        pool,
        fixture,
        `UPDATE claim_evidence_links SET source_hash = $1 WHERE id = $2`,
        ['f'.repeat(64), fixture.claimEvidenceLinkId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  test('holds current evidence and approved claims until the guarded PUBLISH callback finishes', async () => {
    const fixture = await seedRunningPublication(pool);
    const store = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as CurrentnessExecutionStore;
    const evidence = new PostgresEvidenceClaimStore(pool);
    let releaseEffect!: () => void;
    let markStarted!: () => void;
    const effectStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const effectRelease = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    const guarded = store.runGuardedEffect(
      {
        lease: fixture.lease,
        attemptId: fixture.attemptId,
        operation: 'PUBLISH',
        expectedAuthorizationMaterial: fixture.authorizationMaterial,
        expectedRequiredScopes: ['content:write'],
      },
      async () => {
        markStarted();
        await effectRelease;
        return 'effect-finished';
      },
    );
    await effectStarted;

    let mutationSettled = false;
    const mutation = evidence
      .createSnapshot({
        context: {
          tenantId: fixture.tenantId,
          workspaceId: fixture.workspaceId,
          actorUserId: fixture.userId,
          membershipId: fixture.membershipId,
          role: 'OWNER',
        },
        sourceId: fixture.evidenceSourceId,
        snapshotId: randomUUID(),
        contentHash: '8'.repeat(64),
        objectRef: 'fixture://guarded-effect-evidence-r2',
        contentType: 'text/plain',
        sizeBytes: 256,
        capturedAt: new Date(fixture.now.getTime() + 1_000),
        auditEventId: randomUUID(),
      })
      .finally(() => {
        mutationSettled = true;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mutationSettled).toBe(false);
    } finally {
      releaseEffect();
      await expect(guarded).resolves.toEqual({
        outcome: 'EXECUTED',
        value: 'effect-finished',
      });
      await expect(mutation).resolves.not.toBeNull();
    }
  });

  test('holds the exact claim evidence link row until the guarded PUBLISH callback finishes', async () => {
    const fixture = await seedRunningPublication(pool);
    const store = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as CurrentnessExecutionStore;
    const barrier = deferredBarrier();
    const guarded = store.runGuardedEffect(
      {
        lease: fixture.lease,
        attemptId: fixture.attemptId,
        operation: 'PUBLISH',
        expectedAuthorizationMaterial: fixture.authorizationMaterial,
        expectedRequiredScopes: ['content:write'],
      },
      async () => {
        barrier.markStarted();
        await barrier.release;
        return 'effect-finished';
      },
    );
    await barrier.started;

    let mutationSettled = false;
    const mutation = pool
      .query(`UPDATE claim_evidence_links SET source_hash = $1 WHERE id = $2`, [
        'f'.repeat(64),
        fixture.claimEvidenceLinkId,
      ])
      .finally(() => {
        mutationSettled = true;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mutationSettled).toBe(false);
    } finally {
      barrier.releaseNow();
      await expect(guarded).resolves.toEqual({
        outcome: 'EXECUTED',
        value: 'effect-finished',
      });
      await mutation;
    }
  });

  test('holds every append-only currentness-basis row across the guarded PUBLISH callback', async () => {
    const fixture = await seedRunningPublication(pool);
    const store = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as CurrentnessExecutionStore;
    const barrier = deferredBarrier();
    const guarded = store.runGuardedEffect(
      {
        lease: fixture.lease,
        attemptId: fixture.attemptId,
        operation: 'PUBLISH',
        expectedAuthorizationMaterial: fixture.authorizationMaterial,
        expectedRequiredScopes: ['content:write'],
      },
      async () => {
        barrier.markStarted();
        await barrier.release;
        return 'effect-finished';
      },
    );
    await barrier.started;

    const mutationInputs: Array<[string, unknown[]]> = [
      [
        `UPDATE profile_revisions SET content_hash = $1 WHERE id = $2`,
        ['a'.repeat(64), fixture.profileRevisionId],
      ],
      [
        `UPDATE offering_revisions SET content_hash = $1 WHERE id = $2`,
        ['b'.repeat(64), fixture.offeringRevisionId],
      ],
      [
        `UPDATE evidence_snapshots SET content_hash = $1 WHERE id = $2`,
        ['c'.repeat(64), fixture.evidenceSnapshotId],
      ],
      [
        `UPDATE measurement_scenarios SET content_hash = $1 WHERE id = $2`,
        ['d'.repeat(64), fixture.promptScenarioId],
      ],
      [
        `UPDATE prompt_approvals SET scenario_content_hash = $1 WHERE id = $2`,
        ['e'.repeat(64), fixture.promptApprovalId],
      ],
      [
        `UPDATE artifact_reviews SET note = note || '-mutated' WHERE id = $1`,
        [fixture.artifactReviewId],
      ],
      [
        `UPDATE artifact_claim_links SET source_hash = $1 WHERE id = $2`,
        ['f'.repeat(64), fixture.artifactClaimLinkId],
      ],
    ];
    const mutationSettled = mutationInputs.map(() => false);
    const mutations = mutationInputs.map(([text, values], index) =>
      pool.query(text, values).finally(() => {
        mutationSettled[index] = true;
      }),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mutationSettled).toEqual(mutationInputs.map(() => false));
    } finally {
      barrier.releaseNow();
      await expect(guarded).resolves.toEqual({
        outcome: 'EXECUTED',
        value: 'effect-finished',
      });
      const outcomes = await Promise.allSettled(mutations);
      expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    }
  });

  test('holds Artifact current_revision across the guarded PUBLISH callback', async () => {
    const fixture = await seedRunningPublication(pool);
    const store = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as CurrentnessExecutionStore;
    const artifacts = new PostgresArtifactStore(pool);
    const barrier = deferredBarrier();
    const guarded = store.runGuardedEffect(
      {
        lease: fixture.lease,
        attemptId: fixture.attemptId,
        operation: 'PUBLISH',
        expectedAuthorizationMaterial: fixture.authorizationMaterial,
        expectedRequiredScopes: ['content:write'],
      },
      async () => {
        barrier.markStarted();
        await barrier.release;
        return 'effect-finished';
      },
    );
    await barrier.started;

    let mutationSettled = false;
    const mutation = artifacts
      .createRevision({
        context: fixture.context,
        artifactId: fixture.artifactId,
        expectedRevision: 1,
        revisionId: randomUUID(),
        contentHash: '9'.repeat(64),
        payloadObjectRef: 'fixture://guarded-effect-artifact-r2',
        createdAt: new Date(fixture.now.getTime() + 1_000),
        claimLinkIds: [randomUUID()],
        auditEventId: randomUUID(),
      })
      .finally(() => {
        mutationSettled = true;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mutationSettled).toBe(false);
    } finally {
      barrier.releaseNow();
      await expect(guarded).resolves.toEqual({
        outcome: 'EXECUTED',
        value: 'effect-finished',
      });
      await expect(mutation).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
    }
  });

  test('acquires prompt_set before prompt_revision so a normal writer cannot deadlock the effect gate', async () => {
    const fixture = await seedRunningPublication(pool);
    const store = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as CurrentnessExecutionStore;
    const writer = await pool.connect();
    let writerCommitted = false;
    let effects = 0;
    let guarded: Promise<unknown> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query(`SET LOCAL deadlock_timeout = '100ms'`);
      const writerBackend = await writer.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
      const writerPid = writerBackend.rows[0]?.pid;
      if (writerPid === undefined) throw new Error('WRITER_BACKEND_PID_REQUIRED');
      await writer.query(`SELECT id FROM prompt_sets WHERE id = $1 FOR UPDATE`, [
        fixture.promptSetId,
      ]);

      guarded = store.runGuardedEffect(
        {
          lease: fixture.lease,
          attemptId: fixture.attemptId,
          operation: 'PUBLISH',
          expectedAuthorizationMaterial: fixture.authorizationMaterial,
          expectedRequiredScopes: ['content:write'],
        },
        () => {
          effects += 1;
          return Promise.resolve('must-not-run-after-prompt-stale');
        },
      );
      await waitForPromptLockWait(pool, writerPid);

      await expect(
        writer.query(`UPDATE prompt_revisions SET status = 'STALE' WHERE id = $1`, [
          fixture.promptRevisionId,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await writer.query('COMMIT');
      writerCommitted = true;

      await expect(guarded).resolves.toEqual({ outcome: 'GATE_REJECTED' });
      expect(effects).toBe(0);
    } finally {
      if (!writerCommitted) await writer.query('ROLLBACK');
      await guarded?.catch(() => undefined);
      writer.release();
    }
  });

  test('acquires prompt_set before prompt_revision in the package-creation Artifact fence', async () => {
    const fixture = await seedRunningPublication(pool);
    const writer = await pool.connect();
    const fenceClient = await pool.connect();
    let writerCommitted = false;
    let fenceCommitted = false;
    let fence: Promise<boolean> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query(`SET LOCAL deadlock_timeout = '100ms'`);
      const writerBackend = await writer.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
      const writerPid = writerBackend.rows[0]?.pid;
      if (writerPid === undefined) throw new Error('WRITER_BACKEND_PID_REQUIRED');
      await writer.query(`SELECT id FROM prompt_sets WHERE id = $1 FOR UPDATE`, [
        fixture.promptSetId,
      ]);

      await fenceClient.query('BEGIN');
      await fenceClient.query('SET LOCAL ROLE aeostudio_runtime');
      await fenceClient.query(
        `SELECT
           set_config('app.tenant_id', $1, true),
           set_config('app.workspace_id', $2, true),
           set_config('app.actor_id', $3, true)`,
        [fixture.tenantId, fixture.workspaceId, fixture.userId],
      );
      fence = lockCurrentApprovedArtifactForPublication(fenceClient, {
        tenantId: fixture.tenantId,
        workspaceId: fixture.workspaceId,
        artifactId: fixture.artifactId,
        artifactRevisionId: fixture.artifactRevisionId,
        revision: 1,
        contentHash: fixture.contentHash,
        effectiveAt: fixture.now,
      });
      void fence.catch(() => undefined);
      await waitForPromptLockWait(pool, writerPid);

      await expect(
        writer.query(`UPDATE prompt_revisions SET status = 'STALE' WHERE id = $1`, [
          fixture.promptRevisionId,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await writer.query('COMMIT');
      writerCommitted = true;

      await expect(fence).resolves.toBe(false);
      await fenceClient.query('COMMIT');
      fenceCommitted = true;
    } finally {
      if (!writerCommitted) await writer.query('ROLLBACK');
      if (!fenceCommitted) await fenceClient.query('ROLLBACK');
      await fence?.catch(() => undefined);
      writer.release();
      fenceClient.release();
    }
  });

  test('prevents an expired-lease recovery worker from crossing an in-flight PUBLISH guard', async () => {
    const fixture = await seedRunningPublication(pool);
    const store = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as CurrentnessExecutionStore;
    const jobs = new PostgresJobBudgetStore(pool);
    const barrier = deferredBarrier();
    const guarded = store.runGuardedEffect(
      {
        lease: fixture.lease,
        attemptId: fixture.attemptId,
        operation: 'PUBLISH',
        expectedAuthorizationMaterial: fixture.authorizationMaterial,
        expectedRequiredScopes: ['content:write'],
      },
      async () => {
        barrier.markStarted();
        await barrier.release;
        return 'effect-finished';
      },
    );
    await barrier.started;

    let recoverySettled = false;
    const recovery = jobs
      .claimJob({
        message: {
          messageId: randomUUID(),
          payload: {
            jobId: fixture.lease.job.id,
            tenantId: fixture.tenantId,
            workspaceId: fixture.workspaceId,
            schemaVersion: '1.0.0',
          },
        },
        consumer: `publication-currentness-recovery-${randomUUID()}`,
        inboxId: randomUUID(),
        leaseToken: randomUUID(),
        eventId: randomUUID(),
        now: new Date('2035-07-24T09:00:01.000Z'),
        leaseDurationMs: 30_000,
      })
      .finally(() => {
        recoverySettled = true;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(recoverySettled).toBe(false);
    } finally {
      barrier.releaseNow();
      await expect(guarded).resolves.toEqual({
        outcome: 'EXECUTED',
        value: 'effect-finished',
      });
      await expect(recovery).resolves.toMatchObject({ outcome: 'CLAIMED' });
    }
  });

  test('recovers an ambiguous STARTED effect with RECONCILE only after Artifact r2', async () => {
    const fixture = await seedRunningPublication(pool);
    const store = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as CurrentnessExecutionStore;
    await advanceArtifactToRevisionTwo(pool, fixture);
    const prepared = await store.prepare({
      lease: fixture.lease,
      publishAttemptId: randomUUID(),
      reconcileAttemptId: randomUUID(),
      publishAuditEventId: randomUUID(),
      recoveryAuditEventId: randomUUID(),
      reconcileAuditEventId: randomUUID(),
      gateFailureAuditEventId: randomUUID(),
      now: fixture.now,
    });
    expect(prepared.outcome).toBe('RECONCILE');
    if (prepared.attemptId === undefined) throw new Error('RECONCILE_ATTEMPT_REQUIRED');
    const publishCalls = 0;
    let reconcileCalls = 0;

    await expect(
      store.runGuardedEffect(
        {
          lease: fixture.lease,
          attemptId: prepared.attemptId,
          operation: 'RECONCILE',
          expectedAuthorizationMaterial: fixture.authorizationMaterial,
          expectedRequiredScopes: ['content:write'],
        },
        () => {
          reconcileCalls += 1;
          return Promise.resolve('reconciled-r1');
        },
      ),
    ).resolves.toEqual({
      outcome: 'EXECUTED',
      value: 'reconciled-r1',
    });
    expect(reconcileCalls).toBe(1);
    expect(publishCalls).toBe(0);
  });

  test.each(['AMBIGUOUS', 'RECONCILE_REQUIRED'] as const)(
    'refuses %s recovery without a durable predecessor attempt',
    async (publicationStatus) => {
      const fixture = await seedRunningPublication(pool, {
        includeStartedAttempt: false,
        publicationStatus,
      });
      const store = new PostgresPublicationExecutionStore(
        pool,
      ) as unknown as CurrentnessExecutionStore;

      await expect(
        store.prepare({
          lease: fixture.lease,
          publishAttemptId: randomUUID(),
          reconcileAttemptId: randomUUID(),
          publishAuditEventId: randomUUID(),
          recoveryAuditEventId: randomUUID(),
          reconcileAuditEventId: randomUUID(),
          gateFailureAuditEventId: randomUUID(),
          now: fixture.now,
        }),
      ).resolves.toEqual({
        outcome: 'GATE_REJECTED',
        errorCode: 'PUBLICATION_RECONCILE_GATE_UNAVAILABLE',
      });

      await expect(
        pool.query<{ attempt_count: string; publication_status: string }>(
          `SELECT publication.status AS publication_status,
             count(attempt.id)::text AS attempt_count
           FROM publication_records publication
           LEFT JOIN publication_attempts attempt
             ON attempt.publication_id = publication.id
            AND attempt.workspace_id = publication.workspace_id
           WHERE publication.id = $1
           GROUP BY publication.status`,
          [fixture.lease.job.aggregateId],
        ),
      ).resolves.toMatchObject({
        rows: [{ attempt_count: '0', publication_status: 'MANUAL_REVIEW_REQUIRED' }],
      });
    },
  );

  test('rejects PUBLISH when authorization material or current required scopes drift after read', async () => {
    const store = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as CurrentnessExecutionStore;
    let effects = 0;

    const secretRotated = await seedRunningPublication(pool);
    await expect(
      store.runGuardedEffect(
        {
          lease: secretRotated.lease,
          attemptId: secretRotated.attemptId,
          operation: 'PUBLISH',
          expectedAuthorizationMaterial: {
            ...secretRotated.authorizationMaterial,
            secretReference: `${secretRotated.authorizationMaterial.secretReference}-stale`,
          },
          expectedRequiredScopes: ['content:write'],
        },
        () => {
          effects += 1;
          return Promise.resolve('must-not-publish-with-rotated-secret');
        },
      ),
    ).resolves.toEqual({ outcome: 'GATE_REJECTED' });

    const fingerprintRotated = await seedRunningPublication(pool);
    await expect(
      store.runGuardedEffect(
        {
          lease: fingerprintRotated.lease,
          attemptId: fingerprintRotated.attemptId,
          operation: 'PUBLISH',
          expectedAuthorizationMaterial: {
            ...fingerprintRotated.authorizationMaterial,
            credentialFingerprint: 'e'.repeat(64),
          },
          expectedRequiredScopes: ['content:write'],
        },
        () => {
          effects += 1;
          return Promise.resolve('must-not-publish-with-rotated-fingerprint');
        },
      ),
    ).resolves.toEqual({ outcome: 'GATE_REJECTED' });

    const scopesDrifted = await seedRunningPublication(pool);
    await pool.query(
      `UPDATE adapter_versions
       SET required_scopes = ARRAY['content:admin']
       WHERE id = $1`,
      [scopesDrifted.adapterVersionId],
    );
    await expect(
      store.runGuardedEffect(
        {
          lease: scopesDrifted.lease,
          attemptId: scopesDrifted.attemptId,
          operation: 'PUBLISH',
          expectedAuthorizationMaterial: scopesDrifted.authorizationMaterial,
          expectedRequiredScopes: ['content:write'],
        },
        () => {
          effects += 1;
          return Promise.resolve('must-not-publish-after-scope-drift');
        },
      ),
    ).resolves.toEqual({ outcome: 'GATE_REJECTED' });
    expect(effects).toBe(0);
  });

  test('locks the current Adapter Registry row across the guarded PUBLISH callback', async () => {
    const fixture = await seedRunningPublication(pool);
    const store = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as CurrentnessExecutionStore;
    const barrier = deferredBarrier();
    const guarded = store.runGuardedEffect(
      {
        lease: fixture.lease,
        attemptId: fixture.attemptId,
        operation: 'PUBLISH',
        expectedAuthorizationMaterial: fixture.authorizationMaterial,
        expectedRequiredScopes: ['content:write'],
      },
      async () => {
        barrier.markStarted();
        await barrier.release;
        return 'published';
      },
    );
    await barrier.started;

    let registryMutationSettled = false;
    const registryMutation = pool
      .query(`UPDATE adapter_versions SET enabled = false WHERE id = $1`, [
        fixture.adapterVersionId,
      ])
      .finally(() => {
        registryMutationSettled = true;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(registryMutationSettled).toBe(false);
    } finally {
      barrier.releaseNow();
      await expect(guarded).resolves.toEqual({
        outcome: 'EXECUTED',
        value: 'published',
      });
      await registryMutation;
    }
  });

  test('rejects RECONCILE after actor revocation and locks the current role across its callback', async () => {
    const store = new PostgresPublicationExecutionStore(
      pool,
    ) as unknown as CurrentnessExecutionStore;
    const revoked = await seedRunningPublication(pool);
    const revokedPrepared = await store.prepare({
      lease: revoked.lease,
      publishAttemptId: randomUUID(),
      reconcileAttemptId: randomUUID(),
      publishAuditEventId: randomUUID(),
      recoveryAuditEventId: randomUUID(),
      reconcileAuditEventId: randomUUID(),
      gateFailureAuditEventId: randomUUID(),
      now: revoked.now,
    });
    expect(revokedPrepared.outcome).toBe('RECONCILE');
    if (revokedPrepared.attemptId === undefined) throw new Error('RECONCILE_ATTEMPT_REQUIRED');
    await pool.query(`UPDATE memberships SET status = 'REVOKED' WHERE id = $1`, [
      revoked.membershipId,
    ]);
    let effects = 0;
    await expect(
      store.runGuardedEffect(
        {
          lease: revoked.lease,
          attemptId: revokedPrepared.attemptId,
          operation: 'RECONCILE',
          expectedAuthorizationMaterial: revoked.authorizationMaterial,
          expectedRequiredScopes: ['content:write'],
        },
        () => {
          effects += 1;
          return Promise.resolve('must-not-reconcile-after-revocation');
        },
      ),
    ).resolves.toEqual({ outcome: 'GATE_REJECTED' });
    expect(effects).toBe(0);

    const concurrent = await seedRunningPublication(pool);
    const concurrentPrepared = await store.prepare({
      lease: concurrent.lease,
      publishAttemptId: randomUUID(),
      reconcileAttemptId: randomUUID(),
      publishAuditEventId: randomUUID(),
      recoveryAuditEventId: randomUUID(),
      reconcileAuditEventId: randomUUID(),
      gateFailureAuditEventId: randomUUID(),
      now: concurrent.now,
    });
    expect(concurrentPrepared.outcome).toBe('RECONCILE');
    if (concurrentPrepared.attemptId === undefined) {
      throw new Error('RECONCILE_ATTEMPT_REQUIRED');
    }
    const barrier = deferredBarrier();
    const guarded = store.runGuardedEffect(
      {
        lease: concurrent.lease,
        attemptId: concurrentPrepared.attemptId,
        operation: 'RECONCILE',
        expectedAuthorizationMaterial: concurrent.authorizationMaterial,
        expectedRequiredScopes: ['content:write'],
      },
      async () => {
        barrier.markStarted();
        await barrier.release;
        return 'reconciled';
      },
    );
    await barrier.started;
    let revocationSettled = false;
    const revocation = pool
      .query(`DELETE FROM role_bindings WHERE id = $1`, [concurrent.roleBindingId])
      .finally(() => {
        revocationSettled = true;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(revocationSettled).toBe(false);
    } finally {
      barrier.releaseNow();
      await expect(guarded).resolves.toEqual({
        outcome: 'EXECUTED',
        value: 'reconciled',
      });
      await revocation;
    }
  });
});

async function readPackageCurrentnessFence(
  pool: Pool,
  fixture: Awaited<ReturnType<typeof seedRunningPublication>>,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE aeostudio_runtime');
    await client.query(
      `SELECT
         set_config('app.tenant_id', $1, true),
         set_config('app.workspace_id', $2, true),
         set_config('app.actor_id', $3, true)`,
      [fixture.tenantId, fixture.workspaceId, fixture.userId],
    );
    const accepted = await lockCurrentApprovedArtifactForPublication(client, {
      tenantId: fixture.tenantId,
      workspaceId: fixture.workspaceId,
      artifactId: fixture.artifactId,
      artifactRevisionId: fixture.artifactRevisionId,
      revision: 1,
      contentHash: fixture.contentHash,
      effectiveAt: fixture.now,
    });
    await client.query('ROLLBACK');
    return accepted;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedRunningPublication(
  pool: Pool,
  options: RunningPublicationOptions = {},
): Promise<{
  adapterVersionId: string;
  artifactClaimLinkId: string;
  artifactId: string;
  artifactReviewId: string;
  artifactRevisionId: string;
  attemptId: string;
  authorizationId: string;
  authorizationMaterial: {
    secretReference: string;
    credentialFingerprint: string;
  };
  briefId: string;
  channelPackageId: string;
  claimEvidenceLinkId: string;
  contentHash: string;
  context: {
    tenantId: string;
    workspaceId: string;
    actorUserId: string;
    membershipId: string;
    role: 'OWNER';
  };
  evidenceSourceId: string;
  evidenceSnapshotId: string;
  lease: JobLease;
  membershipId: string;
  now: Date;
  packagePayload: ChannelPackagePayload;
  offeringRevisionId: string;
  profileRevisionId: string;
  promptApprovalId: string;
  promptRevisionId: string;
  promptScenarioId: string;
  promptSetId: string;
  roleBindingId: string;
  secretValue: string;
  tenantId: string;
  userId: string;
  workspaceId: string;
}> {
  const ids = {
    user: randomUUID(),
    tenant: randomUUID(),
    workspace: randomUUID(),
    membership: randomUUID(),
    roleBinding: randomUUID(),
    profile: randomUUID(),
    profileRevision: randomUUID(),
    offering: randomUUID(),
    offeringRevision: randomUUID(),
    evidenceSource: randomUUID(),
    evidenceSnapshot: randomUUID(),
    claim: randomUUID(),
    claimRevision: randomUUID(),
    claimEvidenceLink: randomUUID(),
    claimReview: randomUUID(),
    promptSet: randomUUID(),
    promptRevision: randomUUID(),
    promptScenario: randomUUID(),
    promptApproval: randomUUID(),
    site: randomUUID(),
    crawlJob: randomUUID(),
    crawl: randomUUID(),
    contentPlan: randomUUID(),
    opportunity: randomUUID(),
    brief: randomUUID(),
    artifact: randomUUID(),
    artifactRevision: randomUUID(),
    artifactReview: randomUUID(),
    artifactClaimLink: randomUUID(),
    channel: randomUUID(),
    adapterVersion: randomUUID(),
    channelPackage: randomUUID(),
    authorization: randomUUID(),
    publication: randomUUID(),
    job: randomUUID(),
    attempt: randomUUID(),
    leaseToken: randomUUID(),
    message: randomUUID(),
  };
  const now = new Date('2035-07-24T08:00:00.000Z');
  const contentHash = 'a'.repeat(64);
  const target = 'currentness://account/site';
  const grantedScopes = options.grantedScopes ?? ['content:write'];
  const registryRequiredScopes = options.registryRequiredScopes ?? ['content:write'];
  const requiredScopesSnapshot = options.requiredScopesSnapshot ?? ['content:write'];
  const validationActualScopes = options.validationActualScopes ?? ['content:write'];
  const secretValue = 'publication-currentness-secret';
  const credentialFingerprint = createHash('sha256').update(secretValue).digest('hex');
  const promptId = randomUUID();
  const profileHash = '1'.repeat(64);
  const offeringHash = '2'.repeat(64);
  const promptHash = '3'.repeat(64);
  const scenarioHash = '4'.repeat(64);
  const claimHash = '5'.repeat(64);
  const evidenceHash = '6'.repeat(64);
  const briefHash = '7'.repeat(64);
  const claimStatement = 'The guarded publication fixture is backed by current evidence.';
  const claimExpiresAt =
    options.claimExpiresAt === undefined
      ? new Date(now.getTime() + 24 * 60 * 60 * 1_000)
      : options.claimExpiresAt;
  const claimSnippet =
    options.claimSnippet === undefined ? 'Guarded effect fixture excerpt' : options.claimSnippet;
  const sourceArtifactIds = [
    ids.profileRevision,
    ids.offeringRevision,
    ids.promptRevision,
    ids.crawl,
  ];
  const inputSnapshot = {
    profile: { id: ids.profile, revision: 1 },
    offering: { id: ids.offering, revision: 1 },
    promptSetId: ids.promptSet,
    promptRevisionId: ids.promptRevision,
    primaryClaimRevisionIds: [ids.claimRevision],
    comparisonClaimRevisionIds: [],
    baselineId: ids.crawl,
    methodPolicyVersion: 'currentness-fixture-v1',
    profileRevisionId: ids.profileRevision,
    offeringRevisionId: ids.offeringRevision,
    promptIds: [promptId],
    primaryEvidenceSnapshotIds: [ids.evidenceSnapshot],
    comparisonEvidenceSnapshotIds: [],
    availableClaimRevisionIds: [ids.claimRevision],
    availableSourceArtifactIds: sourceArtifactIds,
    comparisonEvidenceIndependent: false,
  };
  const lineage = {
    contentPlanId: ids.contentPlan,
    brief: { id: ids.brief, contentHash: briefHash },
    prompt: {
      promptSetId: ids.promptSet,
      promptRevisionId: ids.promptRevision,
      contentHash: promptHash,
      promptIds: [promptId],
    },
    sourceReferences: [
      {
        kind: 'PROFILE_REVISION',
        id: ids.profileRevision,
        aggregateId: ids.profile,
        revision: 1,
        contentHash: profileHash,
      },
      {
        kind: 'OFFERING_REVISION',
        id: ids.offeringRevision,
        aggregateId: ids.offering,
        revision: 1,
        contentHash: offeringHash,
      },
      {
        kind: 'PROMPT_REVISION',
        id: ids.promptRevision,
        aggregateId: ids.promptSet,
        revision: 1,
        contentHash: promptHash,
      },
      {
        kind: 'SITE_BASELINE',
        id: ids.crawl,
        aggregateId: ids.site,
        revision: null,
        contentHash: null,
      },
    ],
  };
  const boundEvidence = {
    sourceId: ids.evidenceSource,
    snapshotId: ids.evidenceSnapshot,
    sourceHash: evidenceHash,
  };
  const claimBindings = [
    {
      claimId: ids.claim,
      claimRevisionId: ids.claimRevision,
      claimContentHash: claimHash,
      claimStatement,
      evidence: options.duplicateClaimEvidence
        ? [structuredClone(boundEvidence), structuredClone(boundEvidence)]
        : [boundEvidence],
    },
  ];
  const channelKey = `publication-currentness-${ids.channel}`;
  const packagePayload: ChannelPackagePayload = {
    files: {
      'content.md': '# Guarded publication fixture',
      'content.html': '<h1>Guarded publication fixture</h1>',
      'structured-data.json': '{"@context":"https://schema.org","@type":"Article"}',
    },
  };
  const manifest: ChannelPackageManifest = {
    schemaVersion: '1.0.0',
    files: Object.entries(packagePayload.files).map(([path, content]) => ({
      path,
      mediaType:
        path === 'content.md'
          ? 'text/markdown'
          : path === 'content.html'
            ? 'text/html'
            : 'application/ld+json',
      sha256: createHash('sha256').update(content).digest('hex'),
      byteLength: Buffer.byteLength(content, 'utf8'),
    })),
    assetRefs: [],
    claimSourceMap: claimBindings.map((binding) => ({
      claimId: binding.claimId,
      claimRevisionId: binding.claimRevisionId,
      claimContentHash: binding.claimContentHash,
      evidence: binding.evidence,
    })),
  };
  const packageChecksum = createHash('sha256')
    .update(
      canonicalArtifactJson({
        packageSchemaVersion: '1.0.0',
        channel: { definitionId: ids.channel, channelKey },
        transformer: { key: 'generic-web-package', version: '1.0.0' },
        artifact: {
          artifactId: ids.artifact,
          artifactRevisionId: ids.artifactRevision,
          revision: 1,
          contentHash,
          type: 'DEFINITION_PRODUCT',
          locale: 'en-SG',
          market: 'SG',
          methodPolicyVersion: 'currentness-fixture-v1',
        },
        manifest,
        payload: packagePayload,
      }),
    )
    .digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenant]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [ids.workspace]);
    await client.query("SELECT set_config('app.actor_id', $1, true)", [ids.user]);
    await client.query(
      `INSERT INTO users (id, email, created_at)
       VALUES ($1, $2, $3)`,
      [ids.user, `publication-currentness-${ids.user}@example.test`, now],
    );
    await client.query(
      `INSERT INTO tenants (id, name, created_at)
       VALUES ($1, 'Publication currentness tenant', $2)`,
      [ids.tenant, now],
    );
    await client.query(
      `INSERT INTO workspaces (id, tenant_id, name, created_at)
       VALUES ($1, $2, 'Publication currentness workspace', $3)`,
      [ids.workspace, ids.tenant, now],
    );
    await client.query(
      `INSERT INTO memberships
         (id, tenant_id, user_id, status, invited_email, invited_by_user_id, accepted_at, created_at)
       VALUES ($1, $2, $3, 'ACTIVE', $4, $3, $5, $5)`,
      [
        ids.membership,
        ids.tenant,
        ids.user,
        `publication-currentness-${ids.user}@example.test`,
        now,
      ],
    );
    await client.query(
      `INSERT INTO role_bindings (id, tenant_id, workspace_id, membership_id, role, created_at)
       VALUES ($1, $2, $3, $4, 'OWNER', $5)`,
      [ids.roleBinding, ids.tenant, ids.workspace, ids.membership, now],
    );
    await client.query(
      `INSERT INTO profiles (id, tenant_id, workspace_id, current_revision, created_at)
       VALUES ($1, $2, $3, 1, $4)`,
      [ids.profile, ids.tenant, ids.workspace, now],
    );
    await client.query(
      `INSERT INTO profile_revisions
         (id, tenant_id, workspace_id, profile_id, revision, content_hash, content,
          completeness, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, 1, $5, '{}'::jsonb,
         '{"percent":100,"missingFields":[]}'::jsonb, $6, $7)`,
      [ids.profileRevision, ids.tenant, ids.workspace, ids.profile, profileHash, ids.user, now],
    );
    await client.query(
      `INSERT INTO offerings
         (id, tenant_id, workspace_id, profile_id, current_revision, created_at)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [ids.offering, ids.tenant, ids.workspace, ids.profile, now],
    );
    await client.query(
      `INSERT INTO offering_revisions
         (id, tenant_id, workspace_id, offering_id, profile_id, revision, content_hash,
          content, completeness, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, '{}'::jsonb,
         '{"percent":100,"missingFields":[]}'::jsonb, $7, $8)`,
      [
        ids.offeringRevision,
        ids.tenant,
        ids.workspace,
        ids.offering,
        ids.profile,
        offeringHash,
        ids.user,
        now,
      ],
    );
    await client.query(
      `INSERT INTO evidence_sources
         (id, tenant_id, workspace_id, source_type, title, license, publicity,
          current_snapshot_id, created_at)
       VALUES ($1, $2, $3, 'UPLOAD', 'Guarded effect evidence', 'Fixture', 'PRIVATE',
         NULL, $4)`,
      [ids.evidenceSource, ids.tenant, ids.workspace, now],
    );
    await client.query(
      `INSERT INTO evidence_snapshots
         (id, tenant_id, workspace_id, source_id, content_hash, object_ref, content_type,
          size_bytes, captured_at)
       VALUES ($1, $2, $3, $4, $5, 'fixture://guarded-effect-evidence',
         'text/plain', 128, $6)`,
      [ids.evidenceSnapshot, ids.tenant, ids.workspace, ids.evidenceSource, evidenceHash, now],
    );
    await client.query(`UPDATE evidence_sources SET current_snapshot_id = $1 WHERE id = $2`, [
      ids.evidenceSnapshot,
      ids.evidenceSource,
    ]);
    await client.query(
      `INSERT INTO claims (id, tenant_id, workspace_id, current_revision, created_at)
        VALUES ($1, $2, $3, $4, $5)`,
      [ids.claim, ids.tenant, ids.workspace, options.claimCurrentRevision ?? 1, now],
    );
    await client.query(
      `INSERT INTO claim_revisions
          (id, tenant_id, workspace_id, claim_id, revision, statement, conditions,
           expires_at, content_hash, status, created_by_user_id, created_at)
        VALUES ($1, $2, $3, $4, 1, $5, '{}'::jsonb, $6, $7, 'APPROVED', $8, $9)`,
      [
        ids.claimRevision,
        ids.tenant,
        ids.workspace,
        ids.claim,
        claimStatement,
        claimExpiresAt,
        claimHash,
        ids.user,
        now,
      ],
    );
    if (options.includeClaimReview !== false) {
      await client.query(
        `INSERT INTO claim_reviews
           (id, tenant_id, workspace_id, claim_revision_id, decision, reviewer_user_id,
            content_hash, note, reviewed_at)
         VALUES ($1, $2, $3, $4, 'APPROVE', $5, $6, 'Currentness fixture approval', $7)`,
        [ids.claimReview, ids.tenant, ids.workspace, ids.claimRevision, ids.user, claimHash, now],
      );
    }
    await client.query(
      `INSERT INTO claim_evidence_links
          (id, tenant_id, workspace_id, claim_revision_id, snapshot_id, source_hash,
           snippet, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        ids.claimEvidenceLink,
        ids.tenant,
        ids.workspace,
        ids.claimRevision,
        ids.evidenceSnapshot,
        evidenceHash,
        claimSnippet,
        now,
      ],
    );
    await client.query(
      `INSERT INTO prompt_sets (id, tenant_id, workspace_id, current_revision, created_at)
       VALUES ($1, $2, $3, 1, $4)`,
      [ids.promptSet, ids.tenant, ids.workspace, now],
    );
    await client.query(
      `INSERT INTO prompt_revisions
         (id, tenant_id, workspace_id, prompt_set_id, revision, title, subject,
          source_context, prompts, scopes, content_hash, status, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, 1, 'Guarded effect prompts', 'Guarded effect subject',
         $5::jsonb, $6::jsonb, '[]'::jsonb, $7, 'APPROVED', $8, $9)`,
      [
        ids.promptRevision,
        ids.tenant,
        ids.workspace,
        ids.promptSet,
        JSON.stringify({
          profile: { id: ids.profile, revision: 1 },
          offering: { id: ids.offering, revision: 1 },
          claimRevisionIds: [ids.claimRevision],
        }),
        JSON.stringify([
          {
            id: promptId,
            text: 'How is the guarded publication claim supported?',
            persona: 'Evaluator',
            journeyStage: 'DISCOVERY',
            queryType: 'EXPLANATORY',
          },
        ]),
        promptHash,
        ids.user,
        now,
      ],
    );
    await client.query(
      `INSERT INTO measurement_scenarios
          (id, tenant_id, workspace_id, prompt_revision_id, version, provider_key,
           surface_key, model, model_version, account_ref, acquisition_method,
           fresh_session, search_enabled, parameters, repetitions, content_hash,
           registry_status, created_at)
        VALUES ($1, $2, $3, $4, $5, 'fixture-provider', 'fixture-surface',
          'fixture-model', 'fixture-v1', 'fixture-account', 'MANUAL_IMPORT', true, false,
          '{}'::jsonb, 1, $6, $7, $8)`,
      [
        ids.promptScenario,
        ids.tenant,
        ids.workspace,
        ids.promptRevision,
        options.scenarioVersion ?? 1,
        scenarioHash,
        options.scenarioRegistryStatus ?? 'AVAILABLE',
        now,
      ],
    );
    await client.query(
      `INSERT INTO prompt_approvals
         (id, tenant_id, workspace_id, prompt_revision_id, scenario_id, prompt_content_hash,
          scenario_content_hash, approved_by_user_id, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ids.promptApproval,
        ids.tenant,
        ids.workspace,
        ids.promptRevision,
        ids.promptScenario,
        promptHash,
        scenarioHash,
        ids.user,
        now,
      ],
    );
    await client.query(
      `INSERT INTO sites
         (id, tenant_id, workspace_id, profile_id, origin, hostname, status, verified_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'VERIFIED', $7, $7)`,
      [
        ids.site,
        ids.tenant,
        ids.workspace,
        ids.profile,
        `https://${ids.site}.example.test`,
        `${ids.site}.example.test`,
        now,
      ],
    );
    await client.query(
      `INSERT INTO jobs
         (id, tenant_id, workspace_id, job_type, aggregate_id, status, progress,
          idempotency_key, estimated_units, requested_by_user_id, result, created_at, updated_at)
       VALUES ($1, $2, $3, 'SITE_CRAWL', $4, 'SUCCEEDED', 100, $5, 1, $6,
         '{"baselineStatus":"COMPLETE"}'::jsonb, $7, $7)`,
      [
        ids.crawlJob,
        ids.tenant,
        ids.workspace,
        ids.site,
        `publication-currentness-crawl-${ids.crawlJob}`,
        ids.user,
        now,
      ],
    );
    await client.query(
      `INSERT INTO crawl_runs
         (id, tenant_id, workspace_id, site_id, job_id, status, page_count, total_bytes,
          completed_at)
       VALUES ($1, $2, $3, $4, $5, 'COMPLETE', 1, 128, $6)`,
      [ids.crawl, ids.tenant, ids.workspace, ids.site, ids.crawlJob, now],
    );
    await client.query(
      `INSERT INTO content_plans
         (id, tenant_id, workspace_id, status, method_policy_version, input_snapshot,
          content_hash, created_by_user_id, created_at, completed_at)
       VALUES ($1, $2, $3, 'READY', 'currentness-fixture-v1', $4::jsonb, $5, $6, $7, $7)`,
      [
        ids.contentPlan,
        ids.tenant,
        ids.workspace,
        JSON.stringify(inputSnapshot),
        contentHash,
        ids.user,
        now,
      ],
    );
    await client.query(
      `INSERT INTO opportunities
         (id, tenant_id, workspace_id, content_plan_id, opportunity_key, asset_kind,
          business_value, evidence_readiness, visibility_gap, effort, risk, priority_score,
          priority_rank, rank_reason, action, evidence_ready, publish_ready)
       VALUES ($1, $2, $3, $4, 'DEFINITION_PRODUCT', 'DEFINITION_PRODUCT', 100, 100,
         '{}'::jsonb, 1, 1, 99, 1, 'Currentness fixture', 'BRIEF', true, false)`,
      [ids.opportunity, ids.tenant, ids.workspace, ids.contentPlan],
    );
    await client.query(
      `INSERT INTO briefs
         (id, tenant_id, workspace_id, content_plan_id, opportunity_id, brief_key, asset_kind,
          title, prompt_ids, claim_revision_ids, source_artifact_ids, status, evidence_ready,
          publish_ready, content_hash, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'DEFINITION_PRODUCT', 'DEFINITION_PRODUCT',
         'Publication currentness fixture', $6::jsonb, $7::jsonb, $8::jsonb,
         'APPROVED', true, false, $9, $10, $11)`,
      [
        ids.brief,
        ids.tenant,
        ids.workspace,
        ids.contentPlan,
        ids.opportunity,
        JSON.stringify([promptId]),
        JSON.stringify([ids.claimRevision]),
        JSON.stringify(sourceArtifactIds),
        briefHash,
        ids.user,
        now,
      ],
    );
    await client.query(
      `INSERT INTO artifacts
         (id, tenant_id, workspace_id, brief_id, artifact_type, current_revision, status,
          locale, market, method_policy_version, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, 'DEFINITION_PRODUCT', 1, 'IN_REVIEW', 'en-SG', 'SG',
         'currentness-fixture-v1', $5, $6)`,
      [ids.artifact, ids.tenant, ids.workspace, ids.brief, ids.user, now],
    );
    await client.query(
      `INSERT INTO artifact_revisions
         (id, tenant_id, workspace_id, artifact_id, revision, brief_id, artifact_type,
          schema_version, content_hash, status, locale, market, source_artifact_ids, lineage,
          claim_bindings, method_policy_version, created_by_actor_kind, created_by_actor_id,
          created_at, payload_object_ref)
       VALUES ($1, $2, $3, $4, 1, $5, 'DEFINITION_PRODUCT', '1.0.0', $6, 'IN_REVIEW',
         'en-SG', 'SG', $7::jsonb, $8::jsonb, $9::jsonb, 'currentness-fixture-v1',
         'AGENT', $10, $11, 'memory://publication-currentness-r1')`,
      [
        ids.artifactRevision,
        ids.tenant,
        ids.workspace,
        ids.artifact,
        ids.brief,
        contentHash,
        JSON.stringify(sourceArtifactIds),
        JSON.stringify(lineage),
        JSON.stringify(claimBindings),
        ids.user,
        now,
      ],
    );
    await client.query(
      `INSERT INTO artifact_reviews
         (id, tenant_id, workspace_id, artifact_id, artifact_revision_id, revision,
          content_hash, decision, reviewer_user_id, note, created_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, 'APPROVE', $7, 'Guarded effect fixture', $8)`,
      [
        ids.artifactReview,
        ids.tenant,
        ids.workspace,
        ids.artifact,
        ids.artifactRevision,
        contentHash,
        ids.user,
        now,
      ],
    );
    await client.query(
      `INSERT INTO artifact_claim_links
         (id, tenant_id, workspace_id, artifact_revision_id, claim_revision_id,
          source_id, snapshot_id, source_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        ids.artifactClaimLink,
        ids.tenant,
        ids.workspace,
        ids.artifactRevision,
        ids.claimRevision,
        ids.evidenceSource,
        ids.evidenceSnapshot,
        evidenceHash,
      ],
    );
    await client.query(`UPDATE artifact_revisions SET status = 'APPROVED' WHERE id = $1`, [
      ids.artifactRevision,
    ]);
    await client.query(`UPDATE artifacts SET status = 'APPROVED' WHERE id = $1`, [ids.artifact]);
    await client.query(
      `INSERT INTO channel_definitions
         (id, channel_key, display_name, status, package_transformer_key,
          package_schema_version, created_at, updated_at)
       VALUES ($1, $2, 'Publication currentness channel', 'AVAILABLE',
         'generic-web-package', '1.0.0', $3, $3)`,
      [ids.channel, channelKey, now],
    );
    await client.query(
      `INSERT INTO adapter_versions
         (id, channel_definition_id, adapter_key, adapter_version, enabled, capabilities,
          required_scopes, terms_version, terms_status, processing_region, retention_policy,
          training_policy, subprocessors, rate_policy, created_at)
       VALUES ($1, $2, 'currentness-adapter', '1.0.0', true,
         ARRAY['PUBLISH','RECONCILE'], $4, 'currentness-terms-v1',
         'ALLOWED', 'in-process-test-runtime', 'No retention.', 'No training.',
         '[]'::jsonb, '{"mode":"test"}'::jsonb, $3)`,
      [ids.adapterVersion, ids.channel, now, registryRequiredScopes],
    );
    await client.query(
      `INSERT INTO channel_packages
         (id, tenant_id, workspace_id, package_revision, channel_definition_id, channel_key,
          transformer_key, transformer_version, package_schema_version, artifact_id,
          artifact_revision_id, artifact_revision, artifact_content_hash, artifact_type,
          artifact_locale, artifact_market, artifact_method_policy_version, manifest,
          package_checksum, payload_object_ref, created_by_user_id, created_at)
       VALUES ($1, $2, $3, 1, $4, $11, 'generic-web-package', '1.0.0', '1.0.0',
         $5, $6, 1, $7, 'DEFINITION_PRODUCT', 'en-SG', 'SG', 'currentness-fixture-v1',
         $12::jsonb,
         $8, 'memory://publication-currentness-package-r1', $9, $10)`,
      [
        ids.channelPackage,
        ids.tenant,
        ids.workspace,
        ids.channel,
        ids.artifact,
        ids.artifactRevision,
        contentHash,
        packageChecksum,
        ids.user,
        now,
        channelKey,
        JSON.stringify(manifest),
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
         'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:currentness/adapter',
         $8, 'currentness-terms-v1', $5, 'VERIFIED', $5,
         $9, 'currentness-terms-v1', $10, $7,
         $7::timestamptz + interval '1 hour', $6, $7, $7)`,
      [
        ids.authorization,
        ids.tenant,
        ids.workspace,
        ids.adapterVersion,
        target,
        ids.user,
        now,
        grantedScopes,
        validationActualScopes,
        credentialFingerprint,
      ],
    );
    await client.query(
      `INSERT INTO jobs
         (id, tenant_id, workspace_id, job_type, aggregate_id, status, progress, attempt,
          max_attempts, idempotency_key, estimated_units, requested_by_user_id, lease_token,
          lease_expires_at, heartbeat_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'PUBLICATION', $4, 'RUNNING', 10, 1, 3, $5, 5, $6, $7,
         $8, $9, $9, $9)`,
      [
        ids.job,
        ids.tenant,
        ids.workspace,
        ids.publication,
        `publication-currentness-job-${ids.job}`,
        ids.user,
        ids.leaseToken,
        new Date('2035-07-24T09:00:00.000Z'),
        now,
      ],
    );
    await client.query(
      `INSERT INTO publication_records
         (id, tenant_id, workspace_id, channel_package_id, package_checksum,
           artifact_revision_id, artifact_content_hash, adapter_version_id,
           channel_authorization_id, authorization_target, target, idempotency_key, request_hash,
           status, job_id, requested_by_user_id, created_at, updated_at, required_scopes_snapshot)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12,
          $17, $13, $14, $15, $15, $16)`,
      [
        ids.publication,
        ids.tenant,
        ids.workspace,
        ids.channelPackage,
        packageChecksum,
        ids.artifactRevision,
        contentHash,
        ids.adapterVersion,
        ids.authorization,
        target,
        `publication-currentness-${ids.publication}`,
        'c'.repeat(64),
        ids.job,
        ids.user,
        now,
        requiredScopesSnapshot,
        options.publicationStatus ?? 'RUNNING',
      ],
    );
    if (options.includeStartedAttempt !== false) {
      await client.query(
        `INSERT INTO publication_attempts
           (id, tenant_id, workspace_id, publication_id, attempt_number, operation, outcome,
            started_at)
         VALUES ($1, $2, $3, $4, 1, 'PUBLISH', 'STARTED', $5)`,
        [ids.attempt, ids.tenant, ids.workspace, ids.publication, now],
      );
    }
    await client.query(
      `INSERT INTO outbox_messages
         (id, tenant_id, workspace_id, aggregate_id, message_type, payload, published_at, created_at)
       VALUES ($1, $2, $3, $4, 'JOB_QUEUED', $5::jsonb, $6, $6)`,
      [
        ids.message,
        ids.tenant,
        ids.workspace,
        ids.job,
        JSON.stringify({
          jobId: ids.job,
          tenantId: ids.tenant,
          workspaceId: ids.workspace,
          schemaVersion: '1.0.0',
        }),
        now,
      ],
    );
    await client.query(
      `INSERT INTO inbox_messages
         (id, tenant_id, workspace_id, consumer, message_id, status, received_at)
       VALUES ($1, $2, $3, 'publish-workload-v1', $4, 'PROCESSING', $5)`,
      [randomUUID(), ids.tenant, ids.workspace, ids.message, now],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    adapterVersionId: ids.adapterVersion,
    artifactClaimLinkId: ids.artifactClaimLink,
    artifactId: ids.artifact,
    artifactReviewId: ids.artifactReview,
    artifactRevisionId: ids.artifactRevision,
    attemptId: ids.attempt,
    authorizationId: ids.authorization,
    authorizationMaterial: {
      secretReference:
        'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:currentness/adapter',
      credentialFingerprint,
    },
    briefId: ids.brief,
    channelPackageId: ids.channelPackage,
    claimEvidenceLinkId: ids.claimEvidenceLink,
    contentHash,
    context: {
      tenantId: ids.tenant,
      workspaceId: ids.workspace,
      actorUserId: ids.user,
      membershipId: ids.membership,
      role: 'OWNER',
    },
    evidenceSourceId: ids.evidenceSource,
    evidenceSnapshotId: ids.evidenceSnapshot,
    lease: {
      job: {
        id: ids.job,
        tenantId: ids.tenant,
        workspaceId: ids.workspace,
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
      messageId: ids.message,
    },
    membershipId: ids.membership,
    now,
    packagePayload,
    offeringRevisionId: ids.offeringRevision,
    profileRevisionId: ids.profileRevision,
    promptApprovalId: ids.promptApproval,
    promptRevisionId: ids.promptRevision,
    promptScenarioId: ids.promptScenario,
    promptSetId: ids.promptSet,
    roleBindingId: ids.roleBinding,
    secretValue,
    tenantId: ids.tenant,
    userId: ids.user,
    workspaceId: ids.workspace,
  };
}

function deferredBarrier(): {
  started: Promise<void>;
  markStarted(): void;
  release: Promise<void>;
  releaseNow(): void;
} {
  let markStarted!: () => void;
  let releaseNow!: () => void;
  return {
    started: new Promise<void>((resolve) => {
      markStarted = resolve;
    }),
    markStarted: () => markStarted(),
    release: new Promise<void>((resolve) => {
      releaseNow = resolve;
    }),
    releaseNow: () => releaseNow(),
  };
}

async function queryAsRuntime(
  pool: Pool,
  fixture: Awaited<ReturnType<typeof seedRunningPublication>>,
  text: string,
  values: unknown[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE aeostudio_runtime');
    await client.query(
      `SELECT
         set_config('app.tenant_id', $1, true),
         set_config('app.workspace_id', $2, true),
         set_config('app.actor_id', $3, true)`,
      [fixture.tenantId, fixture.workspaceId, fixture.userId],
    );
    await client.query(text, values);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function waitForPromptLockWait(pool: Pool, excludedPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> $1
           AND pid <> pg_backend_pid()
           AND state = 'active'
           AND wait_event_type = 'Lock'
       ) AS waiting`,
      [excludedPid],
    );
    if (waiting.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('PROMPT_LOCK_WAIT_NOT_OBSERVED');
}

async function advanceArtifactToRevisionTwo(
  pool: Pool,
  fixture: Awaited<ReturnType<typeof seedRunningPublication>>,
): Promise<void> {
  const revisionTwoId = randomUUID();
  const revisionTwoHash = 'e'.repeat(64);
  await pool.query(
    `INSERT INTO artifact_revisions
       (id, tenant_id, workspace_id, artifact_id, revision, brief_id, artifact_type,
        schema_version, content_hash, status, locale, market, source_artifact_ids, lineage,
        claim_bindings, method_policy_version, created_by_actor_kind, created_by_actor_id,
        created_at, payload_object_ref)
     VALUES ($1, $2, $3, $4, 2, $5, 'DEFINITION_PRODUCT', '1.0.0', $6, 'DRAFT',
       'en-SG', 'SG', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 'currentness-fixture-v1',
       'USER', $7, $8, 'memory://publication-currentness-r2')`,
    [
      revisionTwoId,
      fixture.tenantId,
      fixture.workspaceId,
      fixture.artifactId,
      fixture.briefId,
      revisionTwoHash,
      fixture.userId,
      fixture.now,
    ],
  );
  await pool.query(
    `UPDATE artifacts
     SET current_revision = 2, status = 'DRAFT'
     WHERE id = $1 AND current_revision = 1`,
    [fixture.artifactId],
  );
}
