import {
  readJobTraceContext,
  type JobBudgetStore,
  type JobClaimResult,
  type JobExecutionStore,
  type PendingOutboxMessage,
} from '@aeostudio/application/jobs-budgets';
import type { TenantContext } from '@aeostudio/application/identity-access';
import type {
  BudgetAlertRecord,
  BudgetPolicyRecord,
  JobRecord,
  JobStatus,
  JobType,
  ProviderBudgetPolicyRecord,
  TenantBudgetPolicyRecord,
} from '@aeostudio/domain/jobs-budgets';
import type { Pool, PoolClient } from 'pg';

import { TenantContextRunner } from '../tenant-context/tenant-context-runner.js';
import { persistTenantOwnerBudgetAlert } from './postgres-budget-alerts.js';

interface BudgetPolicyRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  limit_units: number;
  warning_percent: number;
}

interface BudgetStateRow extends BudgetPolicyRow {
  spent_units: number;
  reserved_units: number;
}

interface TenantBudgetPolicyRow {
  id: string;
  tenant_id: string;
  limit_units: number;
  warning_percent: number;
}

interface TenantBudgetStateRow extends TenantBudgetPolicyRow {
  spent_units: number;
  reserved_units: number;
}

interface ProviderBudgetPolicyRow extends TenantBudgetPolicyRow {
  provider_key: string;
}

interface ProviderBudgetStateRow extends ProviderBudgetPolicyRow {
  spent_units: number;
  reserved_units: number;
}

interface BudgetAlertRow {
  id: string;
  tenant_id: string;
  source_workspace_id: string;
  job_id: string;
  budget_scope: BudgetAlertRecord['budgetScope'];
  policy_id: string;
  provider_key: string | null;
  threshold_percent: number;
  audience: BudgetAlertRecord['audience'];
  recipient_user_id: string;
  created_at: Date;
}

interface JobRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  provider_key: string | null;
  job_type: JobType;
  aggregate_id: string;
  status: JobStatus;
  progress: number;
  attempt: number;
  max_attempts: number;
  budget_warning: boolean;
  estimated_units: number;
  heartbeat_at: Date | null;
  result: Record<string, unknown> | null;
  error_code: string | null;
}

interface GenerationStartIntentRow {
  operation: 'CONTENT_PLAN' | 'ARTIFACT_GENERATION';
  request_hash: string;
  aggregate_id: string;
  job_id: string;
  estimated_units: number;
  requested_at: Date;
}

interface PendingOutboxRow {
  message_id: string;
  tenant_id: string;
  workspace_id: string;
  job_type: JobType;
  payload: PendingOutboxMessage['payload'];
  traceparent: string | null;
  request_id: string | null;
}

export class PostgresJobBudgetStore implements JobBudgetStore, JobExecutionStore {
  private readonly contexts: TenantContextRunner;

  constructor(private readonly pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  setBudget(input: Parameters<JobBudgetStore['setBudget']>[0]): Promise<BudgetPolicyRecord> {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<BudgetPolicyRow>(
        `INSERT INTO budget_policies
          (id, tenant_id, workspace_id, limit_units)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, workspace_id) DO UPDATE
           SET limit_units = EXCLUDED.limit_units, updated_at = now()
         RETURNING id, tenant_id, workspace_id, limit_units::integer, warning_percent`,
        [input.policyId, input.context.tenantId, input.context.workspaceId, input.limitUnits],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error('BUDGET_POLICY_DID_NOT_RETURN_RESULT');
      }
      await client.query(
        `INSERT INTO tenant_budget_policies
          (id, tenant_id, limit_units)
         VALUES ($1, $2, (
           SELECT sum(policy.limit_units)
           FROM budget_policies policy
           WHERE policy.tenant_id = $2
         ))
         ON CONFLICT (tenant_id) DO UPDATE
           SET limit_units = EXCLUDED.limit_units, updated_at = now()
         WHERE NOT tenant_budget_policies.explicitly_configured`,
        [row.id, input.context.tenantId],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata)
         VALUES ($1, $2, $3, $4, 'BUDGET_POLICY_CHANGED', 'BUDGET_POLICY', $5,
           'SUCCEEDED', jsonb_build_object('limitUnits', $6::integer))`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          row.id,
          input.limitUnits,
        ],
      );
      return this.mapPolicy(row);
    });
  }

  setTenantBudget(
    input: Parameters<JobBudgetStore['setTenantBudget']>[0],
  ): Promise<TenantBudgetPolicyRecord> {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<TenantBudgetPolicyRow>(
        `INSERT INTO tenant_budget_policies
          (id, tenant_id, limit_units, explicitly_configured)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (tenant_id) DO UPDATE
           SET limit_units = EXCLUDED.limit_units,
             explicitly_configured = true,
             updated_at = now()
         RETURNING id, tenant_id, limit_units::integer, warning_percent`,
        [input.policyId, input.context.tenantId, input.limitUnits],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('TENANT_BUDGET_POLICY_DID_NOT_RETURN_RESULT');
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata)
         VALUES ($1, $2, $3, $4, 'TENANT_BUDGET_POLICY_CHANGED',
           'TENANT_BUDGET_POLICY', $5, 'SUCCEEDED',
           jsonb_build_object('limitUnits', $6::integer))`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          row.id,
          input.limitUnits,
        ],
      );
      return this.mapTenantPolicy(row);
    });
  }

  setProviderBudget(
    input: Parameters<JobBudgetStore['setProviderBudget']>[0],
  ): Promise<ProviderBudgetPolicyRecord> {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<ProviderBudgetPolicyRow>(
        `INSERT INTO provider_budget_policies
          (id, tenant_id, provider_key, limit_units, explicitly_configured)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (tenant_id, provider_key) DO UPDATE
           SET limit_units = EXCLUDED.limit_units,
             explicitly_configured = true,
             updated_at = now()
         RETURNING id, tenant_id, provider_key, limit_units::integer, warning_percent`,
        [input.policyId, input.context.tenantId, input.providerKey, input.limitUnits],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('PROVIDER_BUDGET_POLICY_DID_NOT_RETURN_RESULT');
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata)
         VALUES ($1, $2, $3, $4, 'PROVIDER_BUDGET_POLICY_CHANGED',
           'PROVIDER_BUDGET_POLICY', $5, 'SUCCEEDED',
           jsonb_build_object('providerKey', $6::text, 'limitUnits', $7::integer))`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          row.id,
          input.providerKey,
          input.limitUnits,
        ],
      );
      return this.mapProviderPolicy(row);
    });
  }

  listBudgetAlerts(
    input: Parameters<JobBudgetStore['listBudgetAlerts']>[0],
  ): Promise<BudgetAlertRecord[]> {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<BudgetAlertRow>(
        `SELECT alert.id, alert.tenant_id, alert.source_workspace_id, alert.job_id,
           alert.budget_scope,
           COALESCE(
             alert.tenant_budget_policy_id,
             alert.provider_budget_policy_id
           ) AS policy_id,
           alert.provider_key, alert.threshold_percent, alert.audience,
           recipient.recipient_user_id, alert.created_at
         FROM tenant_owner_budget_alerts alert
         JOIN tenant_owner_budget_alert_recipients recipient
           ON recipient.tenant_id = alert.tenant_id
          AND recipient.alert_id = alert.id
          AND recipient.audience = alert.audience
         WHERE alert.tenant_id = $1
           AND alert.audience = 'TENANT_OWNER'
           AND recipient.recipient_user_id = $2
         ORDER BY alert.created_at DESC, alert.id DESC`,
        [input.context.tenantId, input.context.actorUserId],
      );
      return result.rows.map((row) => this.mapBudgetAlert(row));
    });
  }

  reserveGenerationStart(
    input: Parameters<JobBudgetStore['reserveGenerationStart']>[0],
  ): ReturnType<JobBudgetStore['reserveGenerationStart']> {
    return this.contexts.run(input.context, async (client) => {
      if (
        !(await lockActiveLifecycleScope(client, input.context.tenantId, input.context.workspaceId))
      ) {
        return { outcome: 'NOT_FOUND' as const };
      }
      await lockIdempotencyScope(
        client,
        input.context.tenantId,
        input.context.workspaceId,
        input.operation,
        input.idempotencyKey,
      );
      const existing = await findGenerationStartIntent(
        client,
        input.context.tenantId,
        input.context.workspaceId,
        input.operation,
        input.idempotencyKey,
      );
      if (existing !== undefined) return mapGenerationStartIntent(existing, input);

      const existingJob = await client.query<{ id: string }>(
        `SELECT id FROM jobs
         WHERE tenant_id = $1 AND workspace_id = $2
           AND job_type = $3 AND idempotency_key = $4`,
        [input.context.tenantId, input.context.workspaceId, input.operation, input.idempotencyKey],
      );
      if (existingJob.rows[0] !== undefined) {
        return { outcome: 'IDEMPOTENCY_CONFLICT' as const };
      }

      const inserted = await client.query<GenerationStartIntentRow>(
        `INSERT INTO generation_start_intents
          (tenant_id, workspace_id, operation, idempotency_key, request_hash,
            aggregate_id, job_id, estimated_units, requested_by_user_id, requested_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, workspace_id, operation, idempotency_key) DO NOTHING
         RETURNING operation, request_hash, aggregate_id, job_id,
           estimated_units::integer, requested_at`,
        [
          input.context.tenantId,
          input.context.workspaceId,
          input.operation,
          input.idempotencyKey,
          input.requestHash,
          input.aggregateId,
          input.jobId,
          input.estimatedUnits,
          input.context.actorUserId,
          input.requestedAt,
        ],
      );
      const row =
        inserted.rows[0] ??
        (await findGenerationStartIntent(
          client,
          input.context.tenantId,
          input.context.workspaceId,
          input.operation,
          input.idempotencyKey,
        ));
      if (row === undefined) throw new Error('GENERATION_START_INTENT_DID_NOT_RETURN_RESULT');
      return mapGenerationStartIntent(row, input);
    });
  }

  submitJob(input: Parameters<JobBudgetStore['submitJob']>[0]): Promise<JobRecord | null> {
    const traceContext =
      input.traceContext === undefined ? undefined : readJobTraceContext(input.traceContext);
    const providerKey = input.providerKey ?? null;
    return this.contexts.run(input.context, async (client) => {
      // Publication creation has a stricter atomic coordinator that binds the immutable package,
      // authorization, PublicationRecord, budget, Job, outbox, and audits together. The generic
      // Job entry point must never create an orphan PUBLICATION Job.
      if (input.jobType === 'PUBLICATION') return null;
      if (
        !(await lockActiveLifecycleScope(client, input.context.tenantId, input.context.workspaceId))
      ) {
        return null;
      }
      await lockIdempotencyScope(
        client,
        input.context.tenantId,
        input.context.workspaceId,
        input.jobType,
        input.idempotencyKey,
      );
      const generationIntent = await findGenerationStartIntent(
        client,
        input.context.tenantId,
        input.context.workspaceId,
        input.jobType,
        input.idempotencyKey,
      );
      if (generationIntent !== undefined && !generationStartMatchesJob(generationIntent, input)) {
        return null;
      }
      const existing = await client.query<JobRow>(
        `SELECT id, tenant_id, workspace_id, provider_key, job_type, aggregate_id, status, progress,
           attempt, max_attempts, budget_warning, estimated_units::integer, heartbeat_at,
           result, error_code
         FROM jobs
         WHERE tenant_id = $1 AND workspace_id = $2
           AND job_type = $3 AND idempotency_key = $4`,
        [input.context.tenantId, input.context.workspaceId, input.jobType, input.idempotencyKey],
      );
      if (existing.rows[0] !== undefined) {
        return jobMatchesIdempotentRequest(existing.rows[0], input)
          ? this.mapJob(existing.rows[0])
          : null;
      }

      const aggregate =
        input.jobType === 'PROFILE_READINESS'
          ? await client.query<{ id: string }>(
              'SELECT id FROM profiles WHERE id = $1 AND workspace_id = $2',
              [input.aggregateId, input.context.workspaceId],
            )
          : input.jobType === 'SITE_CRAWL'
            ? await client.query<{ id: string }>(
                `SELECT id FROM sites
                 WHERE id = $1 AND workspace_id = $2 AND status = 'VERIFIED'`,
                [input.aggregateId, input.context.workspaceId],
              )
            : input.jobType === 'CONTENT_PLAN'
              ? await client.query<{ id: string }>(
                  `SELECT id FROM content_plans
                 WHERE id = $1 AND workspace_id = $2 AND status = 'PENDING'`,
                  [input.aggregateId, input.context.workspaceId],
                )
              : input.jobType === 'ARTIFACT_GENERATION'
                ? await client.query<{ id: string }>(
                    `SELECT id FROM artifacts
                     WHERE id = $1 AND workspace_id = $2 AND status = 'PENDING'`,
                    [input.aggregateId, input.context.workspaceId],
                  )
                : await client.query<{ id: string }>(
                    `SELECT id FROM measurement_runs
                     WHERE id = $1 AND workspace_id = $2 AND status = 'QUEUED'`,
                    [input.aggregateId, input.context.workspaceId],
                  );
      if (aggregate.rows[0] === undefined) {
        return null;
      }

      const budget = await client.query<BudgetStateRow>(
        `SELECT policy.id, policy.tenant_id, policy.workspace_id,
           policy.limit_units::integer, policy.warning_percent,
           COALESCE((
             SELECT sum(ledger.units) FROM usage_ledger ledger
             WHERE ledger.tenant_id = policy.tenant_id
               AND ledger.workspace_id = policy.workspace_id
           ), 0)::integer AS spent_units,
           COALESCE((
             SELECT sum(reservation.estimated_units) FROM budget_reservations reservation
             WHERE reservation.tenant_id = policy.tenant_id
               AND reservation.workspace_id = policy.workspace_id
               AND reservation.status = 'RESERVED'
           ), 0)::integer AS reserved_units
         FROM budget_policies policy
         WHERE policy.tenant_id = $1 AND policy.workspace_id = $2
         FOR UPDATE OF policy`,
        [input.context.tenantId, input.context.workspaceId],
      );
      const policy = budget.rows[0];
      if (policy === undefined) {
        return null;
      }
      // The budget-policy row is the Workspace submit serialization fence. A concurrent request
      // may have committed the same idempotency key while this transaction waited for the lock.
      const serializedReplay = await client.query<JobRow>(
        `SELECT id, tenant_id, workspace_id, provider_key, job_type, aggregate_id, status, progress,
           attempt, max_attempts, budget_warning, estimated_units::integer, heartbeat_at,
           result, error_code
         FROM jobs
         WHERE tenant_id = $1 AND workspace_id = $2
           AND job_type = $3 AND idempotency_key = $4`,
        [input.context.tenantId, input.context.workspaceId, input.jobType, input.idempotencyKey],
      );
      const replayedJob = serializedReplay.rows[0];
      if (replayedJob !== undefined) {
        return jobMatchesIdempotentRequest(replayedJob, input) ? this.mapJob(replayedJob) : null;
      }
      await client.query(
        `INSERT INTO tenant_budget_policies
          (id, tenant_id, limit_units)
         VALUES ($1, $2, (
           SELECT sum(candidate.limit_units)
           FROM budget_policies candidate
           WHERE candidate.tenant_id = $2
         ))
         ON CONFLICT (tenant_id) DO UPDATE
           SET limit_units = EXCLUDED.limit_units, updated_at = now()
         WHERE NOT tenant_budget_policies.explicitly_configured`,
        [policy.id, input.context.tenantId],
      );
      const tenantBudget = await client.query<TenantBudgetStateRow>(
        `SELECT policy.id, policy.tenant_id, policy.limit_units::integer,
           policy.warning_percent,
           COALESCE((
             SELECT sum(ledger.units)
             FROM usage_ledger ledger
             WHERE ledger.tenant_id = policy.tenant_id
           ), 0)::integer AS spent_units,
           COALESCE((
             SELECT sum(reservation.estimated_units)
             FROM budget_reservations reservation
             WHERE reservation.tenant_id = policy.tenant_id
               AND reservation.status = 'RESERVED'
           ), 0)::integer AS reserved_units
         FROM tenant_budget_policies policy
         WHERE policy.tenant_id = $1
         FOR UPDATE OF policy`,
        [input.context.tenantId],
      );
      const tenantPolicy = tenantBudget.rows[0];
      if (tenantPolicy === undefined) throw new Error('TENANT_BUDGET_POLICY_MISSING');

      let providerPolicy: ProviderBudgetStateRow | undefined;
      if (providerKey !== null) {
        await client.query(
          `INSERT INTO provider_budget_policies
            (id, tenant_id, provider_key, limit_units)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, provider_key) DO UPDATE
             SET limit_units = EXCLUDED.limit_units, updated_at = now()
           WHERE NOT provider_budget_policies.explicitly_configured`,
          [input.jobId, input.context.tenantId, providerKey, tenantPolicy.limit_units],
        );
        const providerBudget = await client.query<ProviderBudgetStateRow>(
          `SELECT policy.id, policy.tenant_id, policy.provider_key,
             policy.limit_units::integer, policy.warning_percent,
             COALESCE((
               SELECT sum(ledger.units)
               FROM usage_ledger ledger
               JOIN jobs job
                 ON job.tenant_id = ledger.tenant_id AND job.id = ledger.job_id
               WHERE ledger.tenant_id = policy.tenant_id
                 AND job.provider_key = policy.provider_key
             ), 0)::integer AS spent_units,
             COALESCE((
               SELECT sum(reservation.estimated_units)
               FROM budget_reservations reservation
               JOIN jobs job
                 ON job.tenant_id = reservation.tenant_id AND job.id = reservation.job_id
               WHERE reservation.tenant_id = policy.tenant_id
                 AND reservation.status = 'RESERVED'
                 AND job.provider_key = policy.provider_key
             ), 0)::integer AS reserved_units
           FROM provider_budget_policies policy
           WHERE policy.tenant_id = $1 AND policy.provider_key = $2
           FOR UPDATE OF policy`,
          [input.context.tenantId, providerKey],
        );
        providerPolicy = providerBudget.rows[0];
        if (providerPolicy === undefined) throw new Error('PROVIDER_BUDGET_POLICY_MISSING');
      }

      const workspaceProjected = policy.spent_units + policy.reserved_units + input.estimatedUnits;
      const tenantProjected =
        tenantPolicy.spent_units + tenantPolicy.reserved_units + input.estimatedUnits;
      const providerProjected =
        providerPolicy === undefined
          ? null
          : providerPolicy.spent_units + providerPolicy.reserved_units + input.estimatedUnits;
      const workspaceWarning =
        workspaceProjected * 100 >= policy.limit_units * policy.warning_percent;
      const tenantWarning =
        tenantProjected * 100 >= tenantPolicy.limit_units * tenantPolicy.warning_percent;
      const providerWarning =
        providerPolicy !== undefined &&
        providerProjected !== null &&
        providerProjected * 100 >= providerPolicy.limit_units * providerPolicy.warning_percent;
      const budgetWarning = workspaceWarning || tenantWarning || providerWarning;
      const blocked =
        workspaceProjected > policy.limit_units ||
        tenantProjected > tenantPolicy.limit_units ||
        (providerPolicy !== undefined &&
          providerProjected !== null &&
          providerProjected > providerPolicy.limit_units);
      const status: JobStatus = blocked ? 'BUDGET_BLOCKED' : 'QUEUED';
      const inserted = await client.query<JobRow>(
        `INSERT INTO jobs
          (id, tenant_id, workspace_id, provider_key, job_type, aggregate_id, status,
            idempotency_key, estimated_units, budget_warning, requested_by_user_id, error_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, tenant_id, workspace_id, provider_key, job_type, aggregate_id, status, progress,
           attempt, max_attempts, budget_warning, estimated_units::integer, heartbeat_at,
           result, error_code`,
        [
          input.jobId,
          input.context.tenantId,
          input.context.workspaceId,
          providerKey,
          input.jobType,
          input.aggregateId,
          status,
          input.idempotencyKey,
          input.estimatedUnits,
          budgetWarning,
          input.context.actorUserId,
          blocked ? 'BUDGET_LIMIT_REACHED' : null,
        ],
      );
      if (status === 'QUEUED') {
        await client.query(
          `INSERT INTO budget_reservations
            (id, tenant_id, workspace_id, job_id, estimated_units, status)
           VALUES ($1, $2, $3, $4, $5, 'RESERVED')`,
          [
            input.reservationId,
            input.context.tenantId,
            input.context.workspaceId,
            input.jobId,
            input.estimatedUnits,
          ],
        );
        await client.query(
          `INSERT INTO outbox_messages
            (id, tenant_id, workspace_id, aggregate_id, message_type, payload,
              traceparent, request_id)
           VALUES ($1, $2, $3, $4, 'JOB_QUEUED', $5::jsonb, $6, $7)`,
          [
            input.outboxMessageId,
            input.context.tenantId,
            input.context.workspaceId,
            input.jobId,
            JSON.stringify({
              jobId: input.jobId,
              tenantId: input.context.tenantId,
              workspaceId: input.context.workspaceId,
              schemaVersion: '1.0.0',
            }),
            traceContext?.traceparent ?? null,
            traceContext?.requestId ?? null,
          ],
        );
      }
      if (workspaceWarning) {
        await client.query(
          `INSERT INTO budget_alerts
            (id, tenant_id, workspace_id, policy_id, threshold_percent)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, workspace_id, policy_id, threshold_percent) DO NOTHING`,
          [
            input.budgetAlertId,
            input.context.tenantId,
            input.context.workspaceId,
            policy.id,
            policy.warning_percent,
          ],
        );
      }
      if (tenantWarning) {
        await persistTenantOwnerBudgetAlert(client, {
          tenantId: input.context.tenantId,
          sourceWorkspaceId: input.context.workspaceId,
          jobId: input.jobId,
          budgetScope: 'TENANT',
          policyId: tenantPolicy.id,
          providerKey: null,
          thresholdPercent: tenantPolicy.warning_percent,
        });
      }
      if (providerWarning && providerPolicy !== undefined) {
        await persistTenantOwnerBudgetAlert(client, {
          tenantId: input.context.tenantId,
          sourceWorkspaceId: input.context.workspaceId,
          jobId: input.jobId,
          budgetScope: 'PROVIDER',
          policyId: providerPolicy.id,
          providerKey: providerPolicy.provider_key,
          thresholdPercent: providerPolicy.warning_percent,
        });
      }
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata)
         VALUES ($1, $2, $3, $4, $5, 'JOB', $6, 'SUCCEEDED',
           jsonb_build_object('status', $7::text, 'estimatedUnits', $8::integer))`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          status === 'BUDGET_BLOCKED' ? 'JOB_BUDGET_BLOCKED' : 'JOB_QUEUED',
          input.jobId,
          status,
          input.estimatedUnits,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error('JOB_DID_NOT_RETURN_RESULT');
      }
      return this.mapJob(row);
    });
  }

  findJob(input: Parameters<JobBudgetStore['findJob']>[0]): Promise<JobRecord | null> {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<JobRow>(
        `SELECT id, tenant_id, workspace_id, provider_key, job_type, aggregate_id, status, progress,
           attempt, max_attempts, budget_warning, estimated_units::integer, heartbeat_at,
           result, error_code
         FROM jobs
         WHERE id = $1 AND workspace_id = $2`,
        [input.jobId, input.context.workspaceId],
      );
      const row = result.rows[0];
      return row === undefined ? null : this.mapJob(row);
    });
  }

  cancelJob(input: Parameters<JobBudgetStore['cancelJob']>[0]): Promise<JobRecord | null> {
    return this.contexts.run(input.context, async (client) => {
      const current = await client.query<JobRow>(
        `SELECT id, tenant_id, workspace_id, provider_key, job_type, aggregate_id, status, progress,
           attempt, max_attempts, budget_warning, estimated_units::integer, heartbeat_at,
           result, error_code
         FROM jobs
         WHERE id = $1 AND workspace_id = $2
         FOR UPDATE`,
        [input.jobId, input.context.workspaceId],
      );
      const currentJob = current.rows[0];
      if (currentJob === undefined) {
        return null;
      }
      if (
        currentJob.job_type === 'PUBLICATION' &&
        ['RUNNING', 'RETRY_WAIT'].includes(currentJob.status)
      ) {
        // Once an Adapter boundary may have been crossed, cancellation cannot prove the remote
        // effect absent. Preserve the live/recoverable Job so the Publication Worker can fence and
        // reconcile it instead of sealing an unknown effect behind CANCELLED.
        await client.query(
          `INSERT INTO audit_events
            (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
              outcome, metadata)
           VALUES ($1, $2, $3, $4, 'PUBLICATION_CANCEL_REJECTED', 'JOB', $5, 'DENIED',
             jsonb_build_object('status', $6::text))`,
          [
            input.auditEventId,
            input.context.tenantId,
            input.context.workspaceId,
            input.context.actorUserId,
            input.jobId,
            currentJob.status,
          ],
        );
        return this.mapJob(currentJob);
      }
      if (['SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED'].includes(currentJob.status)) {
        return this.mapJob(currentJob);
      }
      if (
        currentJob.job_type === 'PUBLICATION' &&
        ['QUEUED', 'BUDGET_BLOCKED'].includes(currentJob.status)
      ) {
        await client.query(
          `UPDATE publication_records
           SET status = 'FAILED_TERMINAL', updated_at = now()
           WHERE id = $1 AND workspace_id = $2
             AND status IN ('QUEUED', 'BUDGET_BLOCKED')`,
          [currentJob.aggregate_id, input.context.workspaceId],
        );
      }
      const result = await client.query<JobRow>(
        `UPDATE jobs
         SET status = 'CANCELLED', lease_token = NULL, lease_expires_at = NULL,
           error_code = 'JOB_CANCELLED', updated_at = now()
         WHERE id = $1
         RETURNING id, tenant_id, workspace_id, provider_key, job_type, aggregate_id, status, progress,
           attempt, max_attempts, budget_warning, estimated_units::integer, heartbeat_at,
           result, error_code`,
        [input.jobId],
      );
      await client.query(
        `UPDATE budget_reservations
         SET status = 'RELEASED', settled_at = now()
         WHERE job_id = $1 AND status = 'RESERVED'`,
        [input.jobId],
      );
      await client.query(
        `UPDATE inbox_messages inbox
         SET status = 'COMPLETED', completed_at = now()
         WHERE inbox.message_id IN (
           SELECT message.id FROM outbox_messages message WHERE message.aggregate_id = $1
         )`,
        [input.jobId],
      );
      await client.query(
        `INSERT INTO job_events
          (id, tenant_id, workspace_id, job_id, event_type)
         VALUES ($1, $2, $3, $4, 'JOB_CANCELLED')`,
        [input.eventId, input.context.tenantId, input.context.workspaceId, input.jobId],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome)
         VALUES ($1, $2, $3, $4, 'JOB_CANCELLED', 'JOB', $5, 'SUCCEEDED')`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.jobId,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error('CANCELLED_JOB_DID_NOT_RETURN_RESULT');
      }
      return this.mapJob(row);
    });
  }

  async listPendingOutbox(limit: number): Promise<PendingOutboxMessage[]> {
    const result = await this.pool.query<PendingOutboxRow>(
      'SELECT * FROM list_pending_job_outbox($1)',
      [limit],
    );
    return result.rows.map((row) => ({
      messageId: row.message_id,
      jobType: row.job_type,
      tenantId: row.tenant_id,
      payload: row.payload,
      ...(row.traceparent === null || row.request_id === null
        ? {}
        : {
            traceContext: {
              traceparent: row.traceparent,
              requestId: row.request_id,
            },
          }),
    }));
  }

  async markOutboxPublished(messageId: string, tenantId: string, publishedAt: Date): Promise<void> {
    await this.pool.query('SELECT mark_job_outbox_published($1, $2, $3)', [
      messageId,
      tenantId,
      publishedAt,
    ]);
  }

  claimJob(input: Parameters<JobExecutionStore['claimJob']>[0]): Promise<JobClaimResult> {
    const context = this.workerContext(input.message.payload);
    return this.contexts.run(context, async (client) => {
      if (
        !(await lockActiveLifecycleScope(
          client,
          input.message.payload.tenantId,
          input.message.payload.workspaceId,
        ))
      ) {
        return { outcome: 'NOT_AVAILABLE' };
      }
      const inbox = await client.query<{ status: 'PROCESSING' | 'COMPLETED' }>(
        'SELECT status FROM inbox_messages WHERE consumer = $1 AND message_id = $2',
        [input.consumer, input.message.messageId],
      );
      if (inbox.rows[0]?.status === 'COMPLETED') {
        return { outcome: 'DUPLICATE' };
      }
      await client.query(
        `SELECT pg_advisory_xact_lock(
           ('x' || substr(lock_key.value, 1, 8))::bit(32)::integer,
           ('x' || substr(lock_key.value, 9, 8))::bit(32)::integer
         )
         FROM (
           SELECT md5('aeostudio:job-tenant-semaphore:' || $1::uuid::text) AS value
         ) lock_key`,
        [input.message.payload.tenantId],
      );
      const result = await client.query<
        JobRow & { lease_expires_at: Date | null; next_attempt_at: Date | null }
      >(
        `SELECT id, tenant_id, workspace_id, provider_key, job_type, aggregate_id, status, progress,
           attempt, max_attempts, budget_warning, estimated_units::integer, heartbeat_at,
           result, error_code, lease_expires_at, next_attempt_at
         FROM jobs
         WHERE id = $1 AND workspace_id = $2
           AND lifecycle_frozen_at IS NULL
         FOR UPDATE`,
        [input.message.payload.jobId, input.message.payload.workspaceId],
      );
      const job = result.rows[0];
      if (job === undefined || ['SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED'].includes(job.status)) {
        return { outcome: 'NOT_AVAILABLE' };
      }
      if (
        job.status === 'RUNNING' &&
        job.lease_expires_at !== null &&
        job.lease_expires_at.getTime() >= input.now.getTime()
      ) {
        return { outcome: 'BUSY' };
      }
      if (
        job.status === 'RUNNING' &&
        job.attempt >= job.max_attempts &&
        !(await this.isPublishedRecovery(client, job))
      ) {
        await this.terminalizeExpiredAttemptLimit(client, input, job);
        return { outcome: 'NOT_AVAILABLE' };
      }
      if (
        job.status === 'RETRY_WAIT' &&
        job.next_attempt_at !== null &&
        job.next_attempt_at.getTime() > input.now.getTime()
      ) {
        return { outcome: 'BUSY' };
      }
      const active = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM jobs
         WHERE tenant_id = $1
            AND status = 'RUNNING'
            AND lifecycle_frozen_at IS NULL
            AND lease_expires_at >= $2
           AND id <> $3`,
        [input.message.payload.tenantId, input.now, input.message.payload.jobId],
      );
      if ((active.rows[0]?.count ?? 0) >= 5) {
        return { outcome: 'CONCURRENCY_LIMIT' };
      }
      await client.query(
        `INSERT INTO inbox_messages
          (id, tenant_id, workspace_id, consumer, message_id, status, received_at)
         VALUES ($1, $2, $3, $4, $5, 'PROCESSING', $6)
         ON CONFLICT (consumer, message_id) DO UPDATE
           SET status = 'PROCESSING', received_at = EXCLUDED.received_at`,
        [
          input.inboxId,
          input.message.payload.tenantId,
          input.message.payload.workspaceId,
          input.consumer,
          input.message.messageId,
          input.now,
        ],
      );
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseDurationMs);
      const claimed = await client.query<JobRow>(
        `UPDATE jobs
         SET status = 'RUNNING', attempt = attempt + 1, lease_token = $1,
           lease_expires_at = $2, heartbeat_at = $3, updated_at = $3,
           error_code = NULL
         WHERE id = $4
         RETURNING id, tenant_id, workspace_id, provider_key, job_type, aggregate_id, status, progress,
           attempt, max_attempts, budget_warning, estimated_units::integer, heartbeat_at,
           result, error_code`,
        [input.leaseToken, leaseExpiresAt, input.now, input.message.payload.jobId],
      );
      await client.query(
        `INSERT INTO job_events
          (id, tenant_id, workspace_id, job_id, event_type, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'JOB_STARTED',
           jsonb_build_object('attempt', $5::integer), $6)`,
        [
          input.eventId,
          input.message.payload.tenantId,
          input.message.payload.workspaceId,
          input.message.payload.jobId,
          claimed.rows[0]?.attempt ?? job.attempt + 1,
          input.now,
        ],
      );
      const claimedJob = claimed.rows[0];
      if (claimedJob === undefined) {
        throw new Error('CLAIMED_JOB_DID_NOT_RETURN_RESULT');
      }
      return {
        outcome: 'CLAIMED',
        lease: {
          job: this.mapJob(claimedJob),
          leaseToken: input.leaseToken,
          messageId: input.message.messageId,
        },
      };
    });
  }

  heartbeat(input: Parameters<JobExecutionStore['heartbeat']>[0]): Promise<boolean> {
    const context = this.workerContext({
      jobId: input.lease.job.id,
      tenantId: input.lease.job.tenantId,
      workspaceId: input.lease.job.workspaceId,
    });
    return this.contexts.run(context, async (client) => {
      if (
        !(await lockActiveLifecycleScope(
          client,
          input.lease.job.tenantId,
          input.lease.job.workspaceId,
        ))
      ) {
        return false;
      }
      const result = await client.query(
        `UPDATE jobs
         SET heartbeat_at = $1, lease_expires_at = $2, updated_at = $1
         WHERE id = $3 AND status = 'RUNNING' AND lease_token = $4
            AND lease_expires_at >= $1
            AND lifecycle_frozen_at IS NULL
         RETURNING id`,
        [
          input.now,
          new Date(input.now.getTime() + input.leaseDurationMs),
          input.lease.job.id,
          input.lease.leaseToken,
        ],
      );
      return result.rowCount === 1;
    });
  }

  reportProgress(input: Parameters<JobExecutionStore['reportProgress']>[0]): Promise<boolean> {
    const context = this.workerContext({
      jobId: input.lease.job.id,
      tenantId: input.lease.job.tenantId,
      workspaceId: input.lease.job.workspaceId,
    });
    return this.contexts.run(context, async (client) => {
      if (
        !(await lockActiveLifecycleScope(
          client,
          input.lease.job.tenantId,
          input.lease.job.workspaceId,
        ))
      ) {
        return false;
      }
      const result = await client.query(
        `UPDATE jobs
         SET progress = GREATEST(progress, $1), updated_at = $2
         WHERE id = $3 AND status = 'RUNNING' AND lease_token = $4
            AND lease_expires_at >= $2
            AND lifecycle_frozen_at IS NULL
         RETURNING id`,
        [input.progress, input.now, input.lease.job.id, input.lease.leaseToken],
      );
      return result.rowCount === 1;
    });
  }

  complete(input: Parameters<JobExecutionStore['complete']>[0]): Promise<boolean> {
    const context = this.workerContext({
      jobId: input.lease.job.id,
      tenantId: input.lease.job.tenantId,
      workspaceId: input.lease.job.workspaceId,
    });
    return this.contexts.run(context, async (client) => {
      if (!Number.isSafeInteger(input.actualUnits) || input.actualUnits < 0) {
        return false;
      }
      if (
        !(await lockActiveLifecycleScope(
          client,
          input.lease.job.tenantId,
          input.lease.job.workspaceId,
        ))
      ) {
        return false;
      }
      const candidate = await client.query<{
        provider_key: string | null;
        reserved_units: number;
      }>(
        `SELECT job.provider_key, reservation.estimated_units::integer AS reserved_units
         FROM jobs job
         JOIN budget_reservations reservation
           ON reservation.tenant_id = job.tenant_id AND reservation.job_id = job.id
         WHERE job.id = $1 AND job.tenant_id = $2 AND job.workspace_id = $3
           AND job.status = 'RUNNING' AND job.lease_token = $4
           AND job.lease_expires_at >= $5
           AND job.lifecycle_frozen_at IS NULL
           AND reservation.status = 'RESERVED'
         FOR UPDATE OF job, reservation`,
        [
          input.lease.job.id,
          input.lease.job.tenantId,
          input.lease.job.workspaceId,
          input.lease.leaseToken,
          input.now,
        ],
      );
      const completionCandidate = candidate.rows[0];
      if (completionCandidate === undefined) return false;

      let topUpWarnings:
        | {
            workspace: { id: string; thresholdPercent: number } | null;
            tenant: { id: string; thresholdPercent: number } | null;
            provider: {
              id: string;
              providerKey: string;
              thresholdPercent: number;
            } | null;
          }
        | undefined;
      if (input.actualUnits > completionCandidate.reserved_units) {
        const additionalUnits = input.actualUnits - completionCandidate.reserved_units;
        const workspaceBudget = await client.query<BudgetStateRow>(
          `SELECT policy.id, policy.tenant_id, policy.workspace_id,
             policy.limit_units::integer, policy.warning_percent,
             COALESCE((
               SELECT sum(ledger.units)
               FROM usage_ledger ledger
               WHERE ledger.tenant_id = policy.tenant_id
                 AND ledger.workspace_id = policy.workspace_id
             ), 0)::integer AS spent_units,
             COALESCE((
               SELECT sum(reservation.estimated_units)
               FROM budget_reservations reservation
               WHERE reservation.tenant_id = policy.tenant_id
                 AND reservation.workspace_id = policy.workspace_id
                 AND reservation.status = 'RESERVED'
             ), 0)::integer AS reserved_units
           FROM budget_policies policy
           WHERE policy.tenant_id = $1 AND policy.workspace_id = $2
           FOR UPDATE OF policy`,
          [input.lease.job.tenantId, input.lease.job.workspaceId],
        );
        const workspacePolicy = workspaceBudget.rows[0];
        if (workspacePolicy === undefined) return false;

        const tenantBudget = await client.query<TenantBudgetStateRow>(
          `SELECT policy.id, policy.tenant_id, policy.limit_units::integer,
             policy.warning_percent,
             COALESCE((
               SELECT sum(ledger.units)
               FROM usage_ledger ledger
               WHERE ledger.tenant_id = policy.tenant_id
             ), 0)::integer AS spent_units,
             COALESCE((
               SELECT sum(reservation.estimated_units)
               FROM budget_reservations reservation
               WHERE reservation.tenant_id = policy.tenant_id
                 AND reservation.status = 'RESERVED'
             ), 0)::integer AS reserved_units
           FROM tenant_budget_policies policy
           WHERE policy.tenant_id = $1
           FOR UPDATE OF policy`,
          [input.lease.job.tenantId],
        );
        const tenantPolicy = tenantBudget.rows[0];
        if (tenantPolicy === undefined) return false;

        let providerPolicy: ProviderBudgetStateRow | undefined;
        if (completionCandidate.provider_key !== null) {
          const providerBudget = await client.query<ProviderBudgetStateRow>(
            `SELECT policy.id, policy.tenant_id, policy.provider_key,
               policy.limit_units::integer, policy.warning_percent,
               COALESCE((
                 SELECT sum(ledger.units)
                 FROM usage_ledger ledger
                 JOIN jobs job
                   ON job.tenant_id = ledger.tenant_id AND job.id = ledger.job_id
                 WHERE ledger.tenant_id = policy.tenant_id
                   AND job.provider_key = policy.provider_key
               ), 0)::integer AS spent_units,
               COALESCE((
                 SELECT sum(reservation.estimated_units)
                 FROM budget_reservations reservation
                 JOIN jobs job
                   ON job.tenant_id = reservation.tenant_id AND job.id = reservation.job_id
                 WHERE reservation.tenant_id = policy.tenant_id
                   AND reservation.status = 'RESERVED'
                   AND job.provider_key = policy.provider_key
               ), 0)::integer AS reserved_units
             FROM provider_budget_policies policy
             WHERE policy.tenant_id = $1 AND policy.provider_key = $2
             FOR UPDATE OF policy`,
            [input.lease.job.tenantId, completionCandidate.provider_key],
          );
          providerPolicy = providerBudget.rows[0];
          if (providerPolicy === undefined) return false;
        }

        const workspaceProjected =
          workspacePolicy.spent_units + workspacePolicy.reserved_units + additionalUnits;
        const tenantProjected =
          tenantPolicy.spent_units + tenantPolicy.reserved_units + additionalUnits;
        const providerProjected =
          providerPolicy === undefined
            ? null
            : providerPolicy.spent_units + providerPolicy.reserved_units + additionalUnits;
        if (
          workspaceProjected > workspacePolicy.limit_units ||
          tenantProjected > tenantPolicy.limit_units ||
          (providerPolicy !== undefined &&
            providerProjected !== null &&
            providerProjected > providerPolicy.limit_units)
        ) {
          return false;
        }
        topUpWarnings = {
          workspace:
            workspaceProjected * 100 >=
            workspacePolicy.limit_units * workspacePolicy.warning_percent
              ? {
                  id: workspacePolicy.id,
                  thresholdPercent: workspacePolicy.warning_percent,
                }
              : null,
          tenant:
            tenantProjected * 100 >= tenantPolicy.limit_units * tenantPolicy.warning_percent
              ? { id: tenantPolicy.id, thresholdPercent: tenantPolicy.warning_percent }
              : null,
          provider:
            providerPolicy !== undefined &&
            providerProjected !== null &&
            providerProjected * 100 >= providerPolicy.limit_units * providerPolicy.warning_percent
              ? {
                  id: providerPolicy.id,
                  providerKey: providerPolicy.provider_key,
                  thresholdPercent: providerPolicy.warning_percent,
                }
              : null,
        };
      }

      const completed = await client.query<{ id: string }>(
        `UPDATE jobs
         SET status = 'SUCCEEDED', progress = 100, result = $1::jsonb,
           lease_token = NULL, lease_expires_at = NULL, updated_at = $2
         WHERE id = $3 AND status = 'RUNNING' AND lease_token = $4
            AND lease_expires_at >= $2
            AND lifecycle_frozen_at IS NULL
         RETURNING id`,
        [JSON.stringify(input.result), input.now, input.lease.job.id, input.lease.leaseToken],
      );
      if (completed.rows[0] === undefined) {
        return false;
      }
      await client.query(
        `INSERT INTO usage_ledger
          (id, tenant_id, workspace_id, job_id, units, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, job_id) DO NOTHING`,
        [
          input.usageLedgerId,
          input.lease.job.tenantId,
          input.lease.job.workspaceId,
          input.lease.job.id,
          input.actualUnits,
          input.now,
        ],
      );
      await client.query(
        `UPDATE budget_reservations
         SET status = 'SETTLED',
           estimated_units = GREATEST(estimated_units, $1),
           actual_units = $1,
           settled_at = $2
         WHERE job_id = $3 AND status = 'RESERVED'`,
        [input.actualUnits, input.now, input.lease.job.id],
      );
      if (topUpWarnings?.workspace !== null && topUpWarnings?.workspace !== undefined) {
        await client.query(
          `INSERT INTO budget_alerts
            (id, tenant_id, workspace_id, policy_id, threshold_percent)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, workspace_id, policy_id, threshold_percent) DO NOTHING`,
          [
            input.eventId,
            input.lease.job.tenantId,
            input.lease.job.workspaceId,
            topUpWarnings.workspace.id,
            topUpWarnings.workspace.thresholdPercent,
          ],
        );
      }
      if (topUpWarnings?.tenant !== null && topUpWarnings?.tenant !== undefined) {
        await persistTenantOwnerBudgetAlert(client, {
          tenantId: input.lease.job.tenantId,
          sourceWorkspaceId: input.lease.job.workspaceId,
          jobId: input.lease.job.id,
          budgetScope: 'TENANT',
          policyId: topUpWarnings.tenant.id,
          providerKey: null,
          thresholdPercent: topUpWarnings.tenant.thresholdPercent,
          createdAt: input.now,
        });
      }
      if (topUpWarnings?.provider !== null && topUpWarnings?.provider !== undefined) {
        await persistTenantOwnerBudgetAlert(client, {
          tenantId: input.lease.job.tenantId,
          sourceWorkspaceId: input.lease.job.workspaceId,
          jobId: input.lease.job.id,
          budgetScope: 'PROVIDER',
          policyId: topUpWarnings.provider.id,
          providerKey: topUpWarnings.provider.providerKey,
          thresholdPercent: topUpWarnings.provider.thresholdPercent,
          createdAt: input.now,
        });
      }
      await client.query(
        `UPDATE inbox_messages
         SET status = 'COMPLETED', completed_at = $1
         WHERE message_id = $2`,
        [input.now, input.lease.messageId],
      );
      await client.query(
        `INSERT INTO job_events
          (id, tenant_id, workspace_id, job_id, event_type, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'JOB_SUCCEEDED',
           jsonb_build_object('actualUnits', $5::integer), $6)`,
        [
          input.eventId,
          input.lease.job.tenantId,
          input.lease.job.workspaceId,
          input.lease.job.id,
          input.actualUnits,
          input.now,
        ],
      );
      return true;
    });
  }

  fail(input: Parameters<JobExecutionStore['fail']>[0]): Promise<JobStatus | false> {
    const context = this.workerContext({
      jobId: input.lease.job.id,
      tenantId: input.lease.job.tenantId,
      workspaceId: input.lease.job.workspaceId,
    });
    return this.contexts.run(context, async (client) => {
      if (
        !(await lockActiveLifecycleScope(
          client,
          input.lease.job.tenantId,
          input.lease.job.workspaceId,
        ))
      ) {
        return false;
      }
      const current = await client.query<{ attempt: number; max_attempts: number }>(
        `SELECT attempt, max_attempts
         FROM jobs
         WHERE id = $1 AND status = 'RUNNING' AND lease_token = $2
            AND lease_expires_at >= $3
            AND lifecycle_frozen_at IS NULL
         FOR UPDATE`,
        [input.lease.job.id, input.lease.leaseToken, input.now],
      );
      const job = current.rows[0];
      if (job === undefined) {
        return false;
      }
      const status: JobStatus =
        input.classification === 'RETRYABLE' && job.attempt < job.max_attempts
          ? 'RETRY_WAIT'
          : 'FAILED_TERMINAL';
      const publicationRetryExhausted =
        status === 'FAILED_TERMINAL' &&
        input.classification === 'RETRYABLE' &&
        input.lease.job.jobType === 'PUBLICATION';
      const persistedErrorCode = publicationRetryExhausted
        ? 'PUBLICATION_EXECUTION_ATTEMPTS_EXHAUSTED'
        : input.errorCode;
      if (publicationRetryExhausted) {
        const publication = await client.query<{
          id: string;
          requested_by_user_id: string;
          status: 'RETRY_WAIT' | 'RECONCILE_REQUIRED';
        }>(
          `SELECT id, requested_by_user_id, status
           FROM publication_records
           WHERE id = $1 AND workspace_id = $2 AND job_id = $3
             AND status IN ('RETRY_WAIT', 'RECONCILE_REQUIRED')
           FOR UPDATE`,
          [input.lease.job.aggregateId, input.lease.job.workspaceId, input.lease.job.id],
        );
        const currentPublication = publication.rows[0];
        if (currentPublication !== undefined) {
          const publicationStatus =
            currentPublication.status === 'RETRY_WAIT'
              ? 'FAILED_TERMINAL'
              : 'MANUAL_REVIEW_REQUIRED';
          await client.query(
            `UPDATE publication_records
             SET status = $1, updated_at = $2
             WHERE id = $3 AND workspace_id = $4 AND status = $5`,
            [
              publicationStatus,
              input.now,
              currentPublication.id,
              input.lease.job.workspaceId,
              currentPublication.status,
            ],
          );
          await client.query(
            `INSERT INTO audit_events
              (id, tenant_id, workspace_id, actor_user_id, action, resource_type,
                resource_id, outcome, metadata, occurred_at)
             VALUES ($1, $2, $3, $4, 'PUBLICATION_EXECUTION_ATTEMPTS_EXHAUSTED',
               'PUBLICATION', $5, 'FAILED',
               jsonb_build_object(
                 'operation', $6::text,
                 'outcome', $7::text,
                 'errorCode', 'PUBLICATION_EXECUTION_ATTEMPTS_EXHAUSTED'::text), $8)`,
            [
              input.eventId,
              input.lease.job.tenantId,
              input.lease.job.workspaceId,
              currentPublication.requested_by_user_id,
              currentPublication.id,
              currentPublication.status === 'RETRY_WAIT' ? 'PUBLISH' : 'RECONCILE',
              currentPublication.status === 'RETRY_WAIT' ? 'DEFINITELY_NOT_APPLIED' : 'UNKNOWN',
              input.now,
            ],
          );
        }
      }
      await client.query(
        `UPDATE jobs
         SET status = $1, error_code = $2, next_attempt_at = $3,
           lease_token = NULL, lease_expires_at = NULL, updated_at = $4
         WHERE id = $5`,
        [
          status,
          persistedErrorCode,
          status === 'RETRY_WAIT' ? input.retryAt : null,
          input.now,
          input.lease.job.id,
        ],
      );
      if (status === 'FAILED_TERMINAL') {
        await client.query(
          `UPDATE budget_reservations
           SET status = 'RELEASED', settled_at = $1
           WHERE job_id = $2 AND status = 'RESERVED'`,
          [input.now, input.lease.job.id],
        );
        await client.query(
          `UPDATE inbox_messages
           SET status = 'COMPLETED', completed_at = $1
           WHERE message_id = $2`,
          [input.now, input.lease.messageId],
        );
      }
      await client.query(
        `INSERT INTO job_events
          (id, tenant_id, workspace_id, job_id, event_type, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, $5,
           jsonb_build_object('errorCode', $6::text), $7)`,
        [
          input.eventId,
          input.lease.job.tenantId,
          input.lease.job.workspaceId,
          input.lease.job.id,
          status === 'RETRY_WAIT' ? 'JOB_RETRY_SCHEDULED' : 'JOB_FAILED_TERMINAL',
          persistedErrorCode,
          input.now,
        ],
      );
      return status;
    });
  }

  private async isPublishedRecovery(client: PoolClient, job: JobRow): Promise<boolean> {
    if (job.job_type !== 'PUBLICATION') return false;
    const publication = await client.query(
      `SELECT id FROM publication_records
       WHERE id = $1 AND workspace_id = $2 AND job_id = $3
         AND status IN ('PUBLISHED', 'REMOTE_APPLIED')`,
      [job.aggregate_id, job.workspace_id, job.id],
    );
    // Finishing the local Job after a durable remote-effect write has no additional remote side
    // effect. Keep that recovery path available even when earlier leases consumed the retry budget.
    return publication.rows[0] !== undefined;
  }

  private async terminalizeExpiredAttemptLimit(
    client: PoolClient,
    input: Parameters<JobExecutionStore['claimJob']>[0],
    job: JobRow,
  ): Promise<void> {
    const errorCode =
      job.job_type === 'PUBLICATION'
        ? 'PUBLICATION_EXECUTION_ATTEMPTS_EXHAUSTED'
        : 'JOB_MAX_ATTEMPTS_EXHAUSTED';
    if (job.job_type === 'PUBLICATION') {
      const publication = await client.query<{
        id: string;
        requested_by_user_id: string;
        status: string;
      }>(
        `SELECT id, requested_by_user_id, status
         FROM publication_records
         WHERE id = $1 AND workspace_id = $2 AND job_id = $3
         FOR UPDATE`,
        [job.aggregate_id, job.workspace_id, job.id],
      );
      const current = publication.rows[0];
      if (current !== undefined) {
        const started = await client.query<{ id: string; operation: 'PUBLISH' | 'RECONCILE' }>(
          `SELECT id, operation
           FROM publication_attempts
           WHERE publication_id = $1 AND workspace_id = $2 AND outcome = 'STARTED'
           ORDER BY attempt_number DESC
           LIMIT 1
           FOR UPDATE`,
          [job.aggregate_id, job.workspace_id],
        );
        const attempt = started.rows[0];
        if (attempt !== undefined) {
          await client.query(
            `UPDATE publication_attempts
             SET outcome = $1, error_code = $2, finished_at = $3
             WHERE id = $4 AND outcome = 'STARTED'`,
            [
              attempt.operation === 'PUBLISH' ? 'AMBIGUOUS' : 'UNKNOWN',
              errorCode,
              input.now,
              attempt.id,
            ],
          );
        }
        if (current.status === 'QUEUED' || current.status === 'RETRY_WAIT') {
          // No execution attempt reached an Adapter boundary.
          await client.query(
            `UPDATE publication_records
             SET status = 'FAILED_TERMINAL', updated_at = $1
             WHERE id = $2 AND workspace_id = $3 AND status IN ('QUEUED', 'RETRY_WAIT')`,
            [input.now, job.aggregate_id, job.workspace_id],
          );
        } else {
          if (current.status === 'RUNNING') {
            // RUNNING cannot transition directly to manual review. First make the unknown remote
            // outcome explicit, then use the state machine's AMBIGUOUS recovery edge.
            await client.query(
              `UPDATE publication_records
               SET status = 'AMBIGUOUS', updated_at = $1
               WHERE id = $2 AND workspace_id = $3 AND status = 'RUNNING'`,
              [input.now, job.aggregate_id, job.workspace_id],
            );
          }
          await client.query(
            `UPDATE publication_records
             SET status = 'MANUAL_REVIEW_REQUIRED', updated_at = $1
             WHERE id = $2 AND workspace_id = $3
               AND status IN ('AMBIGUOUS', 'RECONCILE_REQUIRED', 'RECONCILING')`,
            [input.now, job.aggregate_id, job.workspace_id],
          );
        }
        await client.query(
          `INSERT INTO audit_events
            (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
              outcome, metadata, occurred_at)
           VALUES ($1, $2, $3, $4, 'PUBLICATION_EXECUTION_ATTEMPTS_EXHAUSTED',
             'PUBLICATION', $5, 'FAILED',
             jsonb_strip_nulls(jsonb_build_object(
               'attemptId', $6::uuid,
               'operation', $7::text,
               'outcome', $8::text,
               'errorCode', $9::text)), $10)`,
          [
            input.eventId,
            job.tenant_id,
            job.workspace_id,
            current.requested_by_user_id,
            job.aggregate_id,
            attempt?.id ?? null,
            attempt?.operation ?? 'PUBLISH',
            attempt === undefined
              ? 'DEFINITELY_NOT_APPLIED'
              : attempt.operation === 'PUBLISH'
                ? 'AMBIGUOUS'
                : 'UNKNOWN',
            errorCode,
            input.now,
          ],
        );
      }
    }
    await client.query(
      `UPDATE jobs
       SET status = 'FAILED_TERMINAL', error_code = $1, next_attempt_at = NULL,
         lease_token = NULL, lease_expires_at = NULL, updated_at = $2
       WHERE id = $3 AND status = 'RUNNING'`,
      [errorCode, input.now, job.id],
    );
    await client.query(
      `UPDATE budget_reservations
       SET status = 'RELEASED', settled_at = $1
       WHERE job_id = $2 AND status = 'RESERVED'`,
      [input.now, job.id],
    );
    await client.query(
      `UPDATE inbox_messages
       SET status = 'COMPLETED', completed_at = $1
       WHERE consumer = $2 AND message_id = $3`,
      [input.now, input.consumer, input.message.messageId],
    );
    await client.query(
      `INSERT INTO job_events
        (id, tenant_id, workspace_id, job_id, event_type, metadata, occurred_at)
       VALUES ($1, $2, $3, $4, 'JOB_FAILED_TERMINAL',
         jsonb_build_object('errorCode', $5::text), $6)`,
      [input.eventId, job.tenant_id, job.workspace_id, job.id, errorCode, input.now],
    );
  }

  private workerContext(payload: {
    jobId: string;
    tenantId: string;
    workspaceId: string;
  }): TenantContext {
    return {
      tenantId: payload.tenantId,
      workspaceId: payload.workspaceId,
      actorUserId: payload.jobId,
      membershipId: payload.jobId,
      role: 'OWNER',
    };
  }

  private mapPolicy(row: BudgetPolicyRow): BudgetPolicyRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      limitUnits: row.limit_units,
      warningPercent: row.warning_percent,
    };
  }

  private mapTenantPolicy(row: TenantBudgetPolicyRow): TenantBudgetPolicyRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      limitUnits: row.limit_units,
      warningPercent: row.warning_percent,
    };
  }

  private mapProviderPolicy(row: ProviderBudgetPolicyRow): ProviderBudgetPolicyRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      providerKey: row.provider_key,
      limitUnits: row.limit_units,
      warningPercent: row.warning_percent,
    };
  }

  private mapBudgetAlert(row: BudgetAlertRow): BudgetAlertRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      sourceWorkspaceId: row.source_workspace_id,
      jobId: row.job_id,
      budgetScope: row.budget_scope,
      policyId: row.policy_id,
      providerKey: row.provider_key,
      thresholdPercent: row.threshold_percent,
      audience: row.audience,
      recipientUserId: row.recipient_user_id,
      createdAt: row.created_at.toISOString(),
    };
  }

  private mapJob(row: JobRow): JobRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      providerKey: row.provider_key,
      jobType: row.job_type,
      aggregateId: row.aggregate_id,
      status: row.status,
      progress: row.progress,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      budgetWarning: row.budget_warning,
      estimatedUnits: row.estimated_units,
      heartbeatAt: row.heartbeat_at?.toISOString() ?? null,
      result: row.result,
      errorCode: row.error_code,
    };
  }
}

async function lockIdempotencyScope(
  client: PoolClient,
  tenantId: string,
  workspaceId: string,
  operation: string,
  idempotencyKey: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${tenantId}:${workspaceId}:${operation}:${idempotencyKey}`,
  ]);
}

async function findGenerationStartIntent(
  client: PoolClient,
  tenantId: string,
  workspaceId: string,
  operation: string,
  idempotencyKey: string,
): Promise<GenerationStartIntentRow | undefined> {
  const result = await client.query<GenerationStartIntentRow>(
    `SELECT operation, request_hash, aggregate_id, job_id,
       estimated_units::integer, requested_at
     FROM generation_start_intents
     WHERE tenant_id = $1 AND workspace_id = $2
       AND operation = $3 AND idempotency_key = $4`,
    [tenantId, workspaceId, operation, idempotencyKey],
  );
  return result.rows[0];
}

function mapGenerationStartIntent(
  row: GenerationStartIntentRow,
  input: Parameters<JobBudgetStore['reserveGenerationStart']>[0],
):
  | {
      outcome: 'RESERVED';
      aggregateId: string;
      jobId: string;
      estimatedUnits: number;
      requestedAt: Date;
    }
  | { outcome: 'IDEMPOTENCY_CONFLICT' } {
  if (row.operation !== input.operation || row.request_hash !== input.requestHash) {
    return { outcome: 'IDEMPOTENCY_CONFLICT' };
  }
  return {
    outcome: 'RESERVED',
    aggregateId: row.aggregate_id,
    jobId: row.job_id,
    estimatedUnits: row.estimated_units,
    requestedAt: row.requested_at,
  };
}

function generationStartMatchesJob(
  intent: GenerationStartIntentRow,
  input: Parameters<JobBudgetStore['submitJob']>[0],
): boolean {
  return (
    intent.operation === input.jobType &&
    intent.aggregate_id === input.aggregateId &&
    intent.job_id === input.jobId &&
    intent.estimated_units === input.estimatedUnits
  );
}

async function lockActiveLifecycleScope(
  client: PoolClient,
  tenantId: string,
  workspaceId: string,
): Promise<boolean> {
  const tenant = await client.query<{ id: string }>(
    `SELECT id FROM tenants
     WHERE id = $1 AND lifecycle_state = 'ACTIVE'
     FOR SHARE`,
    [tenantId],
  );
  if (tenant.rows[0] === undefined) return false;
  const workspace = await client.query<{ id: string }>(
    `SELECT id FROM workspaces
     WHERE tenant_id = $1 AND id = $2 AND lifecycle_state = 'ACTIVE'
     FOR SHARE`,
    [tenantId, workspaceId],
  );
  return workspace.rows[0] !== undefined;
}

function jobMatchesIdempotentRequest(
  job: JobRow,
  input: Parameters<JobBudgetStore['submitJob']>[0],
): boolean {
  return (
    job.provider_key === (input.providerKey ?? null) &&
    job.job_type === input.jobType &&
    job.aggregate_id === input.aggregateId &&
    job.estimated_units === input.estimatedUnits
  );
}
