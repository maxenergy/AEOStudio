import type { PublicationCommandStore } from '@aeostudio/application/channels-publishing';
import { readJobTraceContext } from '@aeostudio/application/jobs-budgets';
import type {
  PublicationRecord,
  PublicationRemoteState,
  PublicationStatus,
} from '@aeostudio/domain/channels-publishing';
import type { JobRecord, JobStatus } from '@aeostudio/domain/jobs-budgets';
import type { Pool } from 'pg';

import { persistTenantOwnerBudgetAlert } from '../jobs-budgets/postgres-budget-alerts.js';
import { TenantContextRunner } from '../tenant-context/index.js';

interface PublicationRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  channel_package_id: string;
  package_checksum: string;
  artifact_revision_id: string;
  artifact_content_hash: string;
  adapter_version_id: string;
  channel_authorization_id: string;
  target: string;
  idempotency_key: string;
  request_hash: string;
  status: PublicationStatus;
  job_id: string | null;
  remote_ref: string | null;
  remote_state: PublicationRemoteState | null;
  requested_by_user_id: string;
  created_at: Date;
  updated_at: Date;
}

interface JobRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  provider_key: string | null;
  job_type: 'PUBLICATION';
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

interface BudgetStateRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  limit_units: number;
  warning_percent: number;
  spent_units: number;
  reserved_units: number;
}

interface TenantBudgetStateRow {
  id: string;
  tenant_id: string;
  limit_units: number;
  warning_percent: number;
  spent_units: number;
  reserved_units: number;
}

interface ProviderBudgetStateRow extends TenantBudgetStateRow {
  provider_key: string;
}

const PUBLICATION_COLUMNS = `id, tenant_id, workspace_id, channel_package_id,
  package_checksum, artifact_revision_id, artifact_content_hash, adapter_version_id,
  channel_authorization_id, target, idempotency_key, request_hash, status, job_id,
  remote_ref, remote_state, requested_by_user_id, created_at, updated_at`;

const JOB_COLUMNS = `id, tenant_id, workspace_id, provider_key, job_type, aggregate_id, status, progress,
  attempt, max_attempts, budget_warning, estimated_units::integer, heartbeat_at, result,
  error_code`;

export class PostgresPublicationCommandStore implements PublicationCommandStore {
  private readonly contexts: TenantContextRunner;

  constructor(pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  findExisting(input: Parameters<PublicationCommandStore['findExisting']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const existing = await client.query<PublicationRow>(
        `SELECT ${PUBLICATION_COLUMNS}
         FROM publication_records
         WHERE workspace_id = $1 AND idempotency_key = $2`,
        [input.context.workspaceId, input.idempotencyKey],
      );
      const prior = existing.rows[0];
      if (prior === undefined) return { outcome: 'NOT_FOUND' as const };
      if (prior.request_hash !== input.requestHash) {
        return { outcome: 'IDEMPOTENCY_CONFLICT' as const };
      }
      if (prior.job_id === null) throw new Error('PUBLICATION_JOB_BINDING_MISSING');
      const priorJob = await client.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM jobs
         WHERE id = $1 AND workspace_id = $2 AND job_type = 'PUBLICATION'`,
        [prior.job_id, input.context.workspaceId],
      );
      const job = priorJob.rows[0];
      if (job === undefined) throw new Error('PUBLICATION_JOB_NOT_FOUND');
      return {
        outcome: 'SUCCEEDED' as const,
        publication: mapPublication(prior),
        job: mapJob(job),
        created: false as const,
      };
    });
  }

  submit(input: Parameters<PublicationCommandStore['submit']>[0]) {
    const traceContext =
      input.traceContext === undefined ? undefined : readJobTraceContext(input.traceContext);
    return this.contexts.run(input.context, async (client) => {
      // Serializes same-scope idempotency keys without putting request content in a lock table.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${input.context.tenantId}:${input.context.workspaceId}:${input.idempotencyKey}`,
      ]);

      const existing = await client.query<PublicationRow>(
        `SELECT ${PUBLICATION_COLUMNS}
         FROM publication_records
         WHERE workspace_id = $1 AND idempotency_key = $2`,
        [input.context.workspaceId, input.idempotencyKey],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (prior.request_hash !== input.requestHash) {
          return { outcome: 'IDEMPOTENCY_CONFLICT' as const };
        }
        if (prior.job_id === null) throw new Error('PUBLICATION_JOB_BINDING_MISSING');
        const priorJob = await client.query<JobRow>(
          `SELECT ${JOB_COLUMNS} FROM jobs
           WHERE id = $1 AND workspace_id = $2 AND job_type = 'PUBLICATION'`,
          [prior.job_id, input.context.workspaceId],
        );
        const job = priorJob.rows[0];
        if (job === undefined) throw new Error('PUBLICATION_JOB_NOT_FOUND');
        return {
          outcome: 'SUCCEEDED' as const,
          publication: mapPublication(prior),
          job: mapJob(job),
          created: false,
        };
      }

      // Re-check the complete publish gate in this same transaction. The application boundary
      // verifies package bytes; this query independently binds current actor authority, Registry
      // policy, authorization, exact approval, Brief/Prompt/baseline lineage, and Claim evidence.
      const approved = await client.query<{ id: string; provider_key: string }>(
        `SELECT package.id, adapter.adapter_key AS provider_key
         FROM channel_packages package
         JOIN artifacts artifact
           ON artifact.tenant_id = package.tenant_id
          AND artifact.workspace_id = package.workspace_id
          AND artifact.id = package.artifact_id
          AND artifact.current_revision = package.artifact_revision
         JOIN artifact_revisions revision
           ON revision.tenant_id = package.tenant_id
          AND revision.workspace_id = package.workspace_id
          AND revision.artifact_id = package.artifact_id
          AND revision.id = package.artifact_revision_id
          AND revision.revision = package.artifact_revision
          AND revision.content_hash = package.artifact_content_hash
         JOIN artifact_reviews review
           ON review.tenant_id = revision.tenant_id
          AND review.workspace_id = revision.workspace_id
          AND review.artifact_id = revision.artifact_id
          AND review.artifact_revision_id = revision.id
          AND review.revision = revision.revision
           AND review.content_hash = revision.content_hash
           AND review.decision = 'APPROVE'
         JOIN briefs brief
           ON brief.tenant_id = revision.tenant_id
          AND brief.workspace_id = revision.workspace_id
          AND brief.id = revision.brief_id
          AND brief.status = 'APPROVED'
         JOIN content_plans plan
           ON plan.tenant_id = brief.tenant_id
          AND plan.workspace_id = brief.workspace_id
          AND plan.id = brief.content_plan_id
          AND plan.status = 'READY'
         JOIN profile_revisions profile_revision
           ON profile_revision.tenant_id = plan.tenant_id
          AND profile_revision.workspace_id = plan.workspace_id
          AND profile_revision.id::text = plan.input_snapshot ->> 'profileRevisionId'
          AND profile_revision.profile_id::text = plan.input_snapshot #>> '{profile,id}'
          AND profile_revision.revision::text = plan.input_snapshot #>> '{profile,revision}'
         JOIN offering_revisions offering_revision
           ON offering_revision.tenant_id = plan.tenant_id
          AND offering_revision.workspace_id = plan.workspace_id
          AND offering_revision.id::text = plan.input_snapshot ->> 'offeringRevisionId'
          AND offering_revision.offering_id::text = plan.input_snapshot #>> '{offering,id}'
          AND offering_revision.revision::text = plan.input_snapshot #>> '{offering,revision}'
          AND offering_revision.profile_id = profile_revision.profile_id
         JOIN prompt_revisions prompt_revision
           ON prompt_revision.tenant_id = plan.tenant_id
          AND prompt_revision.workspace_id = plan.workspace_id
          AND prompt_revision.id::text = plan.input_snapshot ->> 'promptRevisionId'
          AND prompt_revision.status = 'APPROVED'
         JOIN prompt_sets prompt_set
           ON prompt_set.tenant_id = prompt_revision.tenant_id
          AND prompt_set.workspace_id = prompt_revision.workspace_id
          AND prompt_set.id = prompt_revision.prompt_set_id
          AND prompt_set.id::text = plan.input_snapshot ->> 'promptSetId'
          AND prompt_set.current_revision = prompt_revision.revision
         JOIN measurement_scenarios scenario
           ON scenario.tenant_id = prompt_revision.tenant_id
          AND scenario.workspace_id = prompt_revision.workspace_id
          AND scenario.prompt_revision_id = prompt_revision.id
         JOIN prompt_approvals prompt_approval
           ON prompt_approval.tenant_id = prompt_revision.tenant_id
          AND prompt_approval.workspace_id = prompt_revision.workspace_id
          AND prompt_approval.prompt_revision_id = prompt_revision.id
          AND prompt_approval.scenario_id = scenario.id
          AND prompt_approval.prompt_content_hash = prompt_revision.content_hash
          AND prompt_approval.scenario_content_hash = scenario.content_hash
         JOIN crawl_runs crawl
           ON crawl.tenant_id = plan.tenant_id
          AND crawl.workspace_id = plan.workspace_id
          AND crawl.id::text = plan.input_snapshot ->> 'baselineId'
          AND crawl.status IN ('COMPLETE', 'PARTIAL')
         JOIN sites site
           ON site.tenant_id = crawl.tenant_id
          AND site.workspace_id = crawl.workspace_id
          AND site.id = crawl.site_id
          AND site.profile_id = profile_revision.profile_id
         JOIN channel_definitions channel
           ON channel.id = package.channel_definition_id
          AND channel.status = 'AVAILABLE'
         JOIN adapter_versions adapter
           ON adapter.id = $6
          AND adapter.channel_definition_id = channel.id
           AND adapter.enabled
           AND 'PUBLISH' = ANY(adapter.capabilities)
           AND adapter.terms_status = 'ALLOWED'
           AND (adapter.provider_api_supported_until IS NULL OR adapter.provider_api_supported_until > $9)
         JOIN channel_authorizations channel_auth
           ON channel_auth.tenant_id = package.tenant_id
          AND channel_auth.workspace_id = package.workspace_id
          AND channel_auth.id = $7
          AND channel_auth.adapter_version_id = adapter.id
          AND channel_auth.target = $8
          AND channel_auth.status = 'ACTIVE'
          AND channel_auth.accepted_terms_version = adapter.terms_version
          AND channel_auth.validation_status = 'VERIFIED'
          AND channel_auth.validation_actual_target = $8
          AND channel_auth.validation_terms_version = adapter.terms_version
          AND $12::text[] <@ channel_auth.validation_actual_scopes
          AND channel_auth.validation_valid_until > $9
          AND $12::text[] <@ channel_auth.granted_scopes
          AND $12::text[] <@ adapter.required_scopes
          AND (channel_auth.expires_at IS NULL OR channel_auth.expires_at > $9)
         JOIN memberships membership
           ON membership.tenant_id = package.tenant_id
          AND membership.id = $10
          AND membership.user_id = $11
          AND membership.status = 'ACTIVE'
         JOIN role_bindings binding
           ON binding.tenant_id = membership.tenant_id
          AND binding.workspace_id = package.workspace_id
          AND binding.membership_id = membership.id
          AND binding.role IN ('OWNER', 'PUBLISHER')
         WHERE package.id = $1
           AND package.workspace_id = $2
           AND package.package_checksum = $3
           AND package.artifact_revision_id = $4
           AND package.artifact_content_hash = $5
           AND revision.status = 'APPROVED'
           AND brief.source_artifact_ids = plan.input_snapshot -> 'availableSourceArtifactIds'
           AND brief.source_artifact_ids = jsonb_build_array(
             profile_revision.id, offering_revision.id, prompt_revision.id, crawl.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(brief.prompt_ids) AS brief_prompt(id)
             WHERE NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements(prompt_revision.prompts) AS prompt(value)
               WHERE prompt.value ->> 'id' = brief_prompt.id
             )
           )
           AND revision.lineage = jsonb_build_object(
             'contentPlanId', plan.id,
             'brief', jsonb_build_object('id', brief.id, 'contentHash', brief.content_hash),
             'prompt', jsonb_build_object(
               'promptSetId', prompt_set.id,
               'promptRevisionId', prompt_revision.id,
               'contentHash', prompt_revision.content_hash,
               'promptIds', brief.prompt_ids
             ),
             'sourceReferences', jsonb_build_array(
               jsonb_build_object(
                 'kind', 'PROFILE_REVISION', 'id', profile_revision.id,
                 'aggregateId', profile_revision.profile_id,
                 'revision', profile_revision.revision,
                 'contentHash', profile_revision.content_hash
               ),
               jsonb_build_object(
                 'kind', 'OFFERING_REVISION', 'id', offering_revision.id,
                 'aggregateId', offering_revision.offering_id,
                 'revision', offering_revision.revision,
                 'contentHash', offering_revision.content_hash
               ),
               jsonb_build_object(
                 'kind', 'PROMPT_REVISION', 'id', prompt_revision.id,
                 'aggregateId', prompt_set.id,
                 'revision', prompt_revision.revision,
                 'contentHash', prompt_revision.content_hash
               ),
               jsonb_build_object(
                 'kind', 'SITE_BASELINE', 'id', crawl.id,
                 'aggregateId', site.id,
                 'revision', NULL::integer,
                 'contentHash', NULL::text
               )
             )
           )
           AND jsonb_array_length(revision.claim_bindings) > 0
           AND NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements(revision.claim_bindings) AS claim_binding(value)
             WHERE jsonb_array_length(claim_binding.value -> 'evidence') = 0
                OR EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(claim_binding.value -> 'evidence') AS evidence(value)
                  WHERE NOT EXISTS (
                    SELECT 1
                    FROM claim_revisions claim_revision
                    JOIN claim_evidence_links claim_link
                      ON claim_link.tenant_id = claim_revision.tenant_id
                     AND claim_link.workspace_id = claim_revision.workspace_id
                     AND claim_link.claim_revision_id = claim_revision.id
                    JOIN evidence_snapshots snapshot
                      ON snapshot.tenant_id = claim_link.tenant_id
                     AND snapshot.workspace_id = claim_link.workspace_id
                     AND snapshot.id = claim_link.snapshot_id
                    JOIN evidence_sources evidence_source
                      ON evidence_source.tenant_id = snapshot.tenant_id
                     AND evidence_source.workspace_id = snapshot.workspace_id
                     AND evidence_source.id = snapshot.source_id
                     AND evidence_source.current_snapshot_id = snapshot.id
                    JOIN artifact_claim_links artifact_link
                      ON artifact_link.tenant_id = revision.tenant_id
                     AND artifact_link.workspace_id = revision.workspace_id
                     AND artifact_link.artifact_revision_id = revision.id
                     AND artifact_link.claim_revision_id = claim_revision.id
                     AND artifact_link.snapshot_id = snapshot.id
                     AND artifact_link.source_id = snapshot.source_id
                     AND artifact_link.source_hash = snapshot.content_hash
                    WHERE claim_revision.tenant_id = revision.tenant_id
                      AND claim_revision.workspace_id = revision.workspace_id
                      AND claim_revision.id = (claim_binding.value ->> 'claimRevisionId')::uuid
                      AND claim_revision.claim_id = (claim_binding.value ->> 'claimId')::uuid
                      AND claim_revision.content_hash = claim_binding.value ->> 'claimContentHash'
                      AND claim_revision.statement = claim_binding.value ->> 'claimStatement'
                      AND claim_revision.status = 'APPROVED'
                      AND (claim_revision.expires_at IS NULL OR claim_revision.expires_at > $9)
                      AND snapshot.id = (evidence.value ->> 'snapshotId')::uuid
                      AND snapshot.source_id = (evidence.value ->> 'sourceId')::uuid
                      AND snapshot.content_hash = evidence.value ->> 'sourceHash'
                      AND claim_link.source_hash = evidence.value ->> 'sourceHash'
                  )
                )
           )
         FOR SHARE OF artifact, revision, brief, plan, prompt_revision, prompt_set,
           crawl, site, membership, binding`,
        [
          input.channelPackage.id,
          input.context.workspaceId,
          input.channelPackage.packageChecksum,
          input.channelPackage.artifact.artifactRevisionId,
          input.channelPackage.artifact.contentHash,
          input.adapterVersionId,
          input.channelAuthorization.id,
          input.channelAuthorization.target,
          input.createdAt,
          input.context.membershipId,
          input.context.actorUserId,
          input.requiredScopes,
        ],
      );
      const approvedBinding = approved.rows[0];
      if (approvedBinding === undefined) return { outcome: 'APPROVAL_STALE' as const };
      const providerKey = approvedBinding.provider_key;

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
      if (policy === undefined) return { outcome: 'NOT_FOUND' as const };

      await client.query(
        `INSERT INTO tenant_budget_policies
          (id, tenant_id, limit_units)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id) DO UPDATE
           SET limit_units = EXCLUDED.limit_units, updated_at = now()
         WHERE NOT tenant_budget_policies.explicitly_configured`,
        [policy.id, input.context.tenantId, policy.limit_units],
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
      const providerPolicy = providerBudget.rows[0];
      if (providerPolicy === undefined) throw new Error('PROVIDER_BUDGET_POLICY_MISSING');

      const workspaceProjected = policy.spent_units + policy.reserved_units + input.estimatedUnits;
      const tenantProjected =
        tenantPolicy.spent_units + tenantPolicy.reserved_units + input.estimatedUnits;
      const providerProjected =
        providerPolicy.spent_units + providerPolicy.reserved_units + input.estimatedUnits;
      const workspaceWarning =
        workspaceProjected * 100 >= policy.limit_units * policy.warning_percent;
      const tenantWarning =
        tenantProjected * 100 >= tenantPolicy.limit_units * tenantPolicy.warning_percent;
      const providerWarning =
        providerProjected * 100 >= providerPolicy.limit_units * providerPolicy.warning_percent;
      const budgetWarning = workspaceWarning || tenantWarning || providerWarning;
      const status: Extract<JobStatus, 'QUEUED' | 'BUDGET_BLOCKED'> =
        workspaceProjected > policy.limit_units ||
        tenantProjected > tenantPolicy.limit_units ||
        providerProjected > providerPolicy.limit_units
          ? 'BUDGET_BLOCKED'
          : 'QUEUED';

      await client.query(
        `INSERT INTO publication_records
          (id, tenant_id, workspace_id, channel_package_id, package_checksum,
            artifact_revision_id, artifact_content_hash, adapter_version_id,
            channel_authorization_id, authorization_target, target, idempotency_key,
            request_hash, status, requested_by_user_id, created_at, updated_at,
            required_scopes_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            'REQUESTED', $14, $15, $15, $16)`,
        [
          input.publicationId,
          input.context.tenantId,
          input.context.workspaceId,
          input.channelPackage.id,
          input.channelPackage.packageChecksum,
          input.channelPackage.artifact.artifactRevisionId,
          input.channelPackage.artifact.contentHash,
          input.adapterVersionId,
          input.channelAuthorization.id,
          input.channelAuthorization.target,
          input.target,
          input.idempotencyKey,
          input.requestHash,
          input.context.actorUserId,
          input.createdAt,
          input.requiredScopes,
        ],
      );

      const insertedJob = await client.query<JobRow>(
        `INSERT INTO jobs
          (id, tenant_id, workspace_id, provider_key, job_type, aggregate_id, status,
            idempotency_key, estimated_units, budget_warning, requested_by_user_id,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'PUBLICATION', $5, $6, $7, $8, $9, $10, $11, $11)
         RETURNING ${JOB_COLUMNS}`,
        [
          input.jobId,
          input.context.tenantId,
          input.context.workspaceId,
          providerKey,
          input.publicationId,
          status,
          `publication-job:${input.jobId}`,
          input.estimatedUnits,
          budgetWarning,
          input.context.actorUserId,
          input.createdAt,
        ],
      );

      if (status === 'QUEUED') {
        await client.query(
          `INSERT INTO budget_reservations
            (id, tenant_id, workspace_id, job_id, estimated_units, status, created_at)
           VALUES ($1, $2, $3, $4, $5, 'RESERVED', $6)`,
          [
            input.reservationId,
            input.context.tenantId,
            input.context.workspaceId,
            input.jobId,
            input.estimatedUnits,
            input.createdAt,
          ],
        );
        await client.query(
          `INSERT INTO outbox_messages
            (id, tenant_id, workspace_id, aggregate_id, message_type, payload, created_at,
              traceparent, request_id)
           VALUES ($1, $2, $3, $4, 'JOB_QUEUED', $5::jsonb, $6, $7, $8)`,
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
            input.createdAt,
            traceContext?.traceparent ?? null,
            traceContext?.requestId ?? null,
          ],
        );
      }
      if (workspaceWarning) {
        await client.query(
          `INSERT INTO budget_alerts
            (id, tenant_id, workspace_id, policy_id, threshold_percent, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, workspace_id, policy_id, threshold_percent) DO NOTHING`,
          [
            input.budgetAlertId,
            input.context.tenantId,
            input.context.workspaceId,
            policy.id,
            policy.warning_percent,
            input.createdAt,
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
          createdAt: input.createdAt,
        });
      }
      if (providerWarning) {
        await persistTenantOwnerBudgetAlert(client, {
          tenantId: input.context.tenantId,
          sourceWorkspaceId: input.context.workspaceId,
          jobId: input.jobId,
          budgetScope: 'PROVIDER',
          policyId: providerPolicy.id,
          providerKey,
          thresholdPercent: providerPolicy.warning_percent,
          createdAt: input.createdAt,
        });
      }

      const updated = await client.query<PublicationRow>(
        `UPDATE publication_records
         SET status = $1, job_id = $2, updated_at = $3
         WHERE id = $4 AND workspace_id = $5 AND status = 'REQUESTED'
         RETURNING ${PUBLICATION_COLUMNS}`,
        [status, input.jobId, input.createdAt, input.publicationId, input.context.workspaceId],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, $5, 'JOB', $6, 'SUCCEEDED',
           jsonb_build_object(
             'status', $7::text,
             'estimatedUnits', $8::integer,
             'publicationId', $9::uuid),
           $10)`,
        [
          input.jobAuditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          status === 'BUDGET_BLOCKED' ? 'JOB_BUDGET_BLOCKED' : 'JOB_QUEUED',
          input.jobId,
          status,
          input.estimatedUnits,
          input.publicationId,
          input.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, $5, 'PUBLICATION', $6, 'SUCCEEDED',
           jsonb_build_object(
             'status', $7::text,
             'jobId', $8::uuid,
             'channelPackageId', $9::uuid,
             'adapterVersionId', $10::uuid,
             'estimatedUnits', $11::integer),
           $12)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          status === 'BUDGET_BLOCKED' ? 'PUBLICATION_BUDGET_BLOCKED' : 'PUBLICATION_QUEUED',
          input.publicationId,
          status,
          input.jobId,
          input.channelPackage.id,
          input.adapterVersionId,
          input.estimatedUnits,
          input.createdAt,
        ],
      );

      const publication = updated.rows[0];
      const job = insertedJob.rows[0];
      if (publication === undefined || job === undefined) {
        throw new Error('PUBLICATION_COMMAND_DID_NOT_RETURN_RESULT');
      }
      return {
        outcome: 'SUCCEEDED' as const,
        publication: mapPublication(publication),
        job: mapJob(job),
        created: true,
      };
    });
  }
}

function mapPublication(row: PublicationRow): PublicationRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    channelPackageId: row.channel_package_id,
    packageChecksum: row.package_checksum,
    artifactRevisionId: row.artifact_revision_id,
    artifactContentHash: row.artifact_content_hash,
    adapterVersionId: row.adapter_version_id,
    channelAuthorizationId: row.channel_authorization_id,
    target: row.target,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    status: row.status,
    jobId: row.job_id,
    remoteRef: row.remote_ref,
    remoteState: row.remote_state,
    requestedByUserId: row.requested_by_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapJob(row: JobRow): JobRecord {
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
