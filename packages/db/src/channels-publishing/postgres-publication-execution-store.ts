import type {
  PreparePublicationExecutionOutcome,
  PublicationAdapterReconciliationIntent,
  PublicationAuthorizationMaterial,
  PublicationExecutionContext,
  PublicationExecutionStore,
} from '@aeostudio/application/channels-publishing';
import type { TenantContext } from '@aeostudio/application/identity-access';
import type { JobLease } from '@aeostudio/application/jobs-budgets';
import type {
  ChannelPackageManifest,
  ChannelPackageRecord,
  PublicationRemoteState,
  PublicationStatus,
} from '@aeostudio/domain/channels-publishing';
import type { ArtifactType } from '@aeostudio/domain/artifacts';
import type { Pool, PoolClient } from 'pg';

import { TenantContextRunner } from '../tenant-context/index.js';

interface ExecutionRow {
  publication_id: string;
  publication_status: PublicationStatus;
  idempotency_key: string;
  target: string;
  authorization_target: string;
  authorization_granted_scopes: string[];
  remote_ref: string | null;
  remote_state: PublicationRemoteState | null;
  adapter_key: string;
  adapter_version: string;
  adapter_provider_api_version: string | null;
  adapter_provider_api_supported_until: Date | string | null;
  adapter_capabilities: string[];
  adapter_required_scopes: string[];
  adapter_terms_version: string;
  adapter_processing_region: string;
  adapter_retention_policy: string;
  adapter_training_policy: string;
  adapter_subprocessors: Array<Record<string, unknown>>;
  adapter_rate_policy: Record<string, unknown>;
  package_id: string;
  tenant_id: string;
  workspace_id: string;
  package_revision: number;
  channel_definition_id: string;
  channel_key: string;
  transformer_key: string;
  transformer_version: string;
  package_schema_version: string;
  artifact_id: string;
  artifact_revision_id: string;
  artifact_revision: number;
  artifact_content_hash: string;
  artifact_type: ArtifactType;
  artifact_locale: string;
  artifact_market: string;
  artifact_method_policy_version: string;
  manifest: ChannelPackageManifest;
  package_checksum: string;
  payload_object_ref: string;
  created_by_user_id: string;
  package_created_at: Date;
}

interface AttemptRow {
  id: string;
  attempt_number: number;
}

interface RecoveryEvidenceAttemptRow {
  operation: 'PUBLISH' | 'RECONCILE';
  outcome: string;
  finished_at: Date | string | null;
}

interface CompletedPublishAttemptRow {
  outcome: string;
  error_code: string | null;
  remote_ref: string | null;
}

const EXECUTION_SELECT_COLUMNS = `publication.id AS publication_id,
  publication.status AS publication_status,
  publication.idempotency_key,
  publication.target,
  publication.authorization_target,
  publication.remote_ref,
  publication.remote_state,
  adapter.adapter_key,
  adapter.adapter_version,
  adapter.provider_api_version AS adapter_provider_api_version,
  adapter.provider_api_supported_until AS adapter_provider_api_supported_until,
  adapter.capabilities AS adapter_capabilities,
  adapter.required_scopes AS adapter_required_scopes,
  adapter.terms_version AS adapter_terms_version,
  adapter.processing_region AS adapter_processing_region,
  adapter.retention_policy AS adapter_retention_policy,
  adapter.training_policy AS adapter_training_policy,
  adapter.subprocessors AS adapter_subprocessors,
  adapter.rate_policy AS adapter_rate_policy,
  channel_auth.validation_actual_scopes AS authorization_granted_scopes,
  package.id AS package_id,
  package.tenant_id,
  package.workspace_id,
  package.package_revision,
  package.channel_definition_id,
  package.channel_key,
  package.transformer_key,
  package.transformer_version,
  package.package_schema_version,
  package.artifact_id,
  package.artifact_revision_id,
  package.artifact_revision,
  package.artifact_content_hash,
  package.artifact_type,
  package.artifact_locale,
  package.artifact_market,
  package.artifact_method_policy_version,
  package.manifest,
  package.package_checksum,
  package.payload_object_ref,
  package.created_by_user_id,
  package.created_at AS package_created_at`;

export class PostgresPublicationExecutionStore implements PublicationExecutionStore {
  private readonly contexts: TenantContextRunner;

  constructor(pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  prepare(
    input: Parameters<PublicationExecutionStore['prepare']>[0],
  ): Promise<PreparePublicationExecutionOutcome> {
    return this.contexts.run<PreparePublicationExecutionOutcome>(
      workerContext(input.lease),
      async (client) => {
        if (!(await lockLiveLease(client, input.lease, input.now))) {
          return { outcome: 'FENCED' as const };
        }
        const base = await client.query<ExecutionRow>(
          `SELECT ${EXECUTION_SELECT_COLUMNS}
         FROM publication_records publication
         JOIN channel_packages package
           ON package.tenant_id = publication.tenant_id
          AND package.workspace_id = publication.workspace_id
          AND package.id = publication.channel_package_id
          AND package.package_checksum = publication.package_checksum
          AND package.artifact_revision_id = publication.artifact_revision_id
          AND package.artifact_content_hash = publication.artifact_content_hash
         JOIN adapter_versions adapter ON adapter.id = publication.adapter_version_id
         JOIN channel_authorizations channel_auth
           ON channel_auth.tenant_id = publication.tenant_id
          AND channel_auth.workspace_id = publication.workspace_id
          AND channel_auth.id = publication.channel_authorization_id
         WHERE publication.id = $1 AND publication.workspace_id = $2
           AND publication.job_id = $3
         FOR UPDATE OF publication`,
          [input.lease.job.aggregateId, input.lease.job.workspaceId, input.lease.job.id],
        );
        const baseRow = base.rows[0];
        if (baseRow === undefined) return { outcome: 'NOT_FOUND' as const };
        if (baseRow.publication_status === 'PUBLISHED') {
          return { outcome: 'PUBLISHED' as const, execution: mapExecution(baseRow) };
        }
        if (baseRow.publication_status === 'REMOTE_APPLIED') {
          return { outcome: 'REMOTE_APPLIED' as const, execution: mapExecution(baseRow) };
        }

        let row = baseRow;
        if (
          baseRow.publication_status === 'QUEUED' ||
          baseRow.publication_status === 'RETRY_WAIT'
        ) {
          const loaded = await client.query<ExecutionRow>(
            `SELECT publication.id AS publication_id,
           publication.status AS publication_status,
           publication.idempotency_key,
           publication.target,
           publication.authorization_target,
           publication.remote_ref,
           publication.remote_state,
           adapter.adapter_key,
           adapter.adapter_version,
           adapter.provider_api_version AS adapter_provider_api_version,
           adapter.provider_api_supported_until AS adapter_provider_api_supported_until,
           adapter.capabilities AS adapter_capabilities,
           adapter.required_scopes AS adapter_required_scopes,
           adapter.terms_version AS adapter_terms_version,
           adapter.processing_region AS adapter_processing_region,
           adapter.retention_policy AS adapter_retention_policy,
           adapter.training_policy AS adapter_training_policy,
           adapter.subprocessors AS adapter_subprocessors,
           adapter.rate_policy AS adapter_rate_policy,
           channel_auth.validation_actual_scopes AS authorization_granted_scopes,
           package.id AS package_id,
           package.tenant_id,
           package.workspace_id,
           package.package_revision,
           package.channel_definition_id,
           package.channel_key,
           package.transformer_key,
           package.transformer_version,
           package.package_schema_version,
           package.artifact_id,
           package.artifact_revision_id,
           package.artifact_revision,
           package.artifact_content_hash,
           package.artifact_type,
           package.artifact_locale,
           package.artifact_market,
           package.artifact_method_policy_version,
           package.manifest,
           package.package_checksum,
           package.payload_object_ref,
           package.created_by_user_id,
           package.created_at AS package_created_at
         FROM publication_records publication
         JOIN channel_packages package
           ON package.tenant_id = publication.tenant_id
          AND package.workspace_id = publication.workspace_id
          AND package.id = publication.channel_package_id
          AND package.package_checksum = publication.package_checksum
          AND package.artifact_revision_id = publication.artifact_revision_id
          AND package.artifact_content_hash = publication.artifact_content_hash
         JOIN adapter_versions adapter
           ON adapter.id = publication.adapter_version_id
          AND adapter.channel_definition_id = package.channel_definition_id
          AND adapter.enabled
          AND 'PUBLISH' = ANY(adapter.capabilities)
           AND 'RECONCILE' = ANY(adapter.capabilities)
           AND adapter.terms_status = 'ALLOWED'
           AND (adapter.provider_api_supported_until IS NULL OR adapter.provider_api_supported_until > $4)
         JOIN channel_definitions channel
           ON channel.id = adapter.channel_definition_id
          AND channel.status = 'AVAILABLE'
         JOIN channel_authorizations channel_auth
           ON channel_auth.tenant_id = publication.tenant_id
          AND channel_auth.workspace_id = publication.workspace_id
          AND channel_auth.id = publication.channel_authorization_id
          AND channel_auth.adapter_version_id = adapter.id
          AND channel_auth.target = publication.authorization_target
          AND channel_auth.status = 'ACTIVE'
          AND channel_auth.accepted_terms_version = adapter.terms_version
          AND channel_auth.validation_status = 'VERIFIED'
          AND channel_auth.validation_actual_target = publication.authorization_target
          AND channel_auth.validation_terms_version = adapter.terms_version
          AND channel_auth.granted_scopes <@ channel_auth.validation_actual_scopes
          AND channel_auth.validation_valid_until > $4
           AND (channel_auth.expires_at IS NULL OR channel_auth.expires_at > $4)
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
          AND revision.status = 'APPROVED'
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
         JOIN memberships membership
           ON membership.tenant_id = publication.tenant_id
          AND membership.user_id = publication.requested_by_user_id
          AND membership.status = 'ACTIVE'
         JOIN role_bindings binding
           ON binding.tenant_id = membership.tenant_id
          AND binding.workspace_id = publication.workspace_id
          AND binding.membership_id = membership.id
          AND binding.role IN ('OWNER', 'PUBLISHER')
         WHERE publication.id = $1
           AND publication.workspace_id = $2
           AND publication.job_id = $3
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
                      AND (claim_revision.expires_at IS NULL OR claim_revision.expires_at > $4)
                      AND snapshot.id = (evidence.value ->> 'snapshotId')::uuid
                      AND snapshot.source_id = (evidence.value ->> 'sourceId')::uuid
                      AND snapshot.content_hash = evidence.value ->> 'sourceHash'
                      AND claim_link.source_hash = evidence.value ->> 'sourceHash'
                  )
                )
           )
         FOR UPDATE OF publication`,
            [
              input.lease.job.aggregateId,
              input.lease.job.workspaceId,
              input.lease.job.id,
              input.now,
            ],
          );
          const gatedRow = loaded.rows[0];
          if (gatedRow === undefined) {
            await rejectExecutionGate(client, input, baseRow, false);
            return { outcome: 'GATE_REJECTED' as const, errorCode: 'PUBLICATION_GATE_STALE' };
          }
          row = gatedRow;
        } else {
          if (
            !(await hasDurableRecoveryEvidence(
              client,
              baseRow.publication_id,
              input.lease.job.workspaceId,
              baseRow.publication_status,
            ))
          ) {
            await rejectExecutionGate(client, input, baseRow, true);
            return {
              outcome: 'GATE_REJECTED' as const,
              errorCode: 'PUBLICATION_RECONCILE_GATE_UNAVAILABLE',
            };
          }
          const reconcileGate = await client.query(
            `SELECT publication.id
           FROM publication_records publication
           JOIN channel_packages package
             ON package.tenant_id = publication.tenant_id
            AND package.workspace_id = publication.workspace_id
            AND package.id = publication.channel_package_id
            AND package.package_checksum = publication.package_checksum
            AND package.artifact_revision_id = publication.artifact_revision_id
            AND package.artifact_content_hash = publication.artifact_content_hash
           JOIN artifact_revisions revision
             ON revision.tenant_id = package.tenant_id
            AND revision.workspace_id = package.workspace_id
            AND revision.artifact_id = package.artifact_id
            AND revision.id = package.artifact_revision_id
            AND revision.revision = package.artifact_revision
            AND revision.content_hash = package.artifact_content_hash
           JOIN adapter_versions adapter
             ON adapter.id = publication.adapter_version_id
            AND adapter.channel_definition_id = package.channel_definition_id
            AND adapter.enabled
             AND 'RECONCILE' = ANY(adapter.capabilities)
             AND adapter.terms_status = 'ALLOWED'
             AND (adapter.provider_api_supported_until IS NULL OR adapter.provider_api_supported_until > $4)
           JOIN channel_definitions channel
             ON channel.id = adapter.channel_definition_id AND channel.status = 'AVAILABLE'
           JOIN channel_authorizations channel_auth
             ON channel_auth.tenant_id = publication.tenant_id
            AND channel_auth.workspace_id = publication.workspace_id
            AND channel_auth.id = publication.channel_authorization_id
            AND channel_auth.adapter_version_id = adapter.id
            AND channel_auth.target = publication.authorization_target
            AND channel_auth.status = 'ACTIVE'
            AND channel_auth.accepted_terms_version = adapter.terms_version
            AND channel_auth.validation_status = 'VERIFIED'
            AND channel_auth.validation_actual_target = publication.authorization_target
            AND channel_auth.validation_terms_version = adapter.terms_version
            AND channel_auth.granted_scopes <@ channel_auth.validation_actual_scopes
            AND channel_auth.validation_valid_until > $4
            AND (channel_auth.expires_at IS NULL OR channel_auth.expires_at > $4)
           WHERE publication.id = $1 AND publication.workspace_id = $2
             AND publication.job_id = $3`,
            [
              input.lease.job.aggregateId,
              input.lease.job.workspaceId,
              input.lease.job.id,
              input.now,
            ],
          );
          if (reconcileGate.rows[0] === undefined) {
            await rejectExecutionGate(client, input, baseRow, true);
            return {
              outcome: 'GATE_REJECTED' as const,
              errorCode: 'PUBLICATION_RECONCILE_GATE_UNAVAILABLE',
            };
          }
        }
        const execution = mapExecution(row);
        if (row.publication_status === 'QUEUED' || row.publication_status === 'RETRY_WAIT') {
          const attemptNumber = await nextAttemptNumber(client, row.publication_id);
          await client.query(
            `UPDATE publication_records
           SET status = 'RUNNING', updated_at = $1
           WHERE id = $2 AND workspace_id = $3 AND status IN ('QUEUED', 'RETRY_WAIT')`,
            [input.now, row.publication_id, input.lease.job.workspaceId],
          );
          await insertStartedAttempt(client, {
            id: input.publishAttemptId,
            lease: input.lease,
            publicationId: row.publication_id,
            attemptNumber,
            operation: 'PUBLISH',
            now: input.now,
          });
          await appendPublicationAudit(client, {
            id: input.publishAuditEventId,
            publicationId: row.publication_id,
            action: 'PUBLICATION_PUBLISH_STARTED',
            operation: 'PUBLISH',
            outcome: 'STARTED',
            attemptId: input.publishAttemptId,
            now: input.now,
          });
          return {
            outcome: 'PUBLISH' as const,
            execution: { ...execution, publicationStatus: 'RUNNING' },
            attemptId: input.publishAttemptId,
          };
        }

        if (row.publication_status === 'RUNNING') {
          const interrupted = await client.query<AttemptRow>(
            `SELECT id, attempt_number
           FROM publication_attempts
           WHERE publication_id = $1 AND workspace_id = $2
             AND operation = 'PUBLISH' AND outcome = 'STARTED'
           ORDER BY attempt_number DESC
           LIMIT 1
           FOR UPDATE`,
            [row.publication_id, input.lease.job.workspaceId],
          );
          const attempt = interrupted.rows[0];
          if (attempt === undefined) return { outcome: 'INVALID_STATE' as const };
          await client.query(
            `UPDATE publication_attempts
           SET outcome = 'AMBIGUOUS', error_code = 'PUBLISH_INTERRUPTED_OUTCOME_UNKNOWN',
             finished_at = $1
           WHERE id = $2 AND publication_id = $3 AND outcome = 'STARTED'`,
            [input.now, attempt.id, row.publication_id],
          );
          await client.query(
            `UPDATE publication_records
           SET status = 'AMBIGUOUS', updated_at = $1
           WHERE id = $2 AND workspace_id = $3 AND status = 'RUNNING'`,
            [input.now, row.publication_id, input.lease.job.workspaceId],
          );
          await appendPublicationAudit(client, {
            id: input.recoveryAuditEventId,
            publicationId: row.publication_id,
            action: 'PUBLICATION_PUBLISH_AMBIGUOUS',
            operation: 'PUBLISH',
            outcome: 'AMBIGUOUS',
            attemptId: attempt.id,
            errorCode: 'PUBLISH_INTERRUPTED_OUTCOME_UNKNOWN',
            now: input.now,
          });
          row.publication_status = 'AMBIGUOUS';
        }

        const reconciliationIntent =
          row.publication_status === 'AMBIGUOUS' ||
          row.publication_status === 'RECONCILE_REQUIRED' ||
          row.publication_status === 'RECONCILING'
            ? await readUnsafeCreateCompensationIntent(
                client,
                row.publication_id,
                input.lease.job.workspaceId,
              )
            : undefined;
        const reconciliationExecution = {
          ...execution,
          ...(reconciliationIntent === undefined ? {} : { reconciliationIntent }),
        };

        if (
          row.publication_status === 'AMBIGUOUS' ||
          row.publication_status === 'RECONCILE_REQUIRED'
        ) {
          const attemptNumber = await nextAttemptNumber(client, row.publication_id);
          await insertStartedAttempt(client, {
            id: input.reconcileAttemptId,
            lease: input.lease,
            publicationId: row.publication_id,
            attemptNumber,
            operation: 'RECONCILE',
            now: input.now,
          });
          await client.query(
            `UPDATE publication_records
           SET status = 'RECONCILING', updated_at = $1
           WHERE id = $2 AND workspace_id = $3
             AND status IN ('AMBIGUOUS', 'RECONCILE_REQUIRED')`,
            [input.now, row.publication_id, input.lease.job.workspaceId],
          );
          await appendPublicationAudit(client, {
            id: input.reconcileAuditEventId,
            publicationId: row.publication_id,
            action: 'PUBLICATION_RECONCILE_STARTED',
            operation: 'RECONCILE',
            outcome: 'STARTED',
            attemptId: input.reconcileAttemptId,
            now: input.now,
          });
          return {
            outcome: 'RECONCILE' as const,
            execution: { ...reconciliationExecution, publicationStatus: 'RECONCILING' },
            attemptId: input.reconcileAttemptId,
          };
        }

        if (row.publication_status === 'RECONCILING') {
          const interrupted = await client.query<AttemptRow>(
            `SELECT id, attempt_number
           FROM publication_attempts
           WHERE publication_id = $1 AND workspace_id = $2
             AND operation = 'RECONCILE' AND outcome = 'STARTED'
           ORDER BY attempt_number DESC
           LIMIT 1
           FOR UPDATE`,
            [row.publication_id, input.lease.job.workspaceId],
          );
          const attempt = interrupted.rows[0];
          return attempt === undefined
            ? { outcome: 'INVALID_STATE' as const }
            : {
                outcome: 'RECONCILE' as const,
                execution: reconciliationExecution,
                attemptId: attempt.id,
              };
        }
        return { outcome: 'INVALID_STATE' as const };
      },
    );
  }

  recordPublishApplied(input: Parameters<PublicationExecutionStore['recordPublishApplied']>[0]) {
    return this.finishApplied({ ...input, operation: 'PUBLISH', expectedStatus: 'RUNNING' });
  }

  runGuardedEffect<T>(
    input: Parameters<PublicationExecutionStore['runGuardedEffect']>[0],
    effect: () => Promise<T>,
  ) {
    return this.contexts.run(workerContext(input.lease), async (client) => {
      if (
        input.operation === 'PUBLISH' &&
        !(await lockCurrentPromptSetParent(client, input.lease))
      ) {
        return { outcome: 'GATE_REJECTED' as const };
      }
      if (
        !(await lockExpectedAuthorizationMaterial(
          client,
          input.lease,
          input.attemptId,
          input.operation,
          input.expectedAuthorizationMaterial,
          input.expectedRequiredScopes,
        ))
      ) {
        return { outcome: 'GATE_REJECTED' as const };
      }
      const gateCurrent =
        input.operation === 'PUBLISH'
          ? (await hasCurrentPublishGate(client, input.lease)) &&
            (await lockCurrentPublishEvidenceGate(client, input.lease))
          : await hasCurrentReconcileGate(client, input.lease);
      if (!gateCurrent) return { outcome: 'GATE_REJECTED' as const };
      const attempt = await client.query(
        `SELECT id
         FROM publication_attempts
         WHERE id = $1
           AND publication_id = $2
           AND workspace_id = $3
           AND operation = $4
           AND outcome = 'STARTED'
         FOR SHARE`,
        [
          input.attemptId,
          input.lease.job.aggregateId,
          input.lease.job.workspaceId,
          input.operation,
        ],
      );
      if (attempt.rows[0] === undefined) return { outcome: 'GATE_REJECTED' as const };
      if (!(await lockLiveLeaseAtDatabaseTime(client, input.lease))) {
        return { outcome: 'FENCED' as const };
      }
      return { outcome: 'EXECUTED' as const, value: await effect() };
    });
  }

  recordPublishAmbiguous(
    input: Parameters<PublicationExecutionStore['recordPublishAmbiguous']>[0],
  ) {
    return this.contexts.run(workerContext(input.lease), async (client) => {
      if (!(await lockLiveLease(client, input.lease, input.now))) return false;
      if (!(await lockPublicationStatus(client, input.lease, 'RUNNING'))) return false;
      const attempt = await client.query(
        `SELECT id FROM publication_attempts
         WHERE id = $1 AND publication_id = $2 AND workspace_id = $3
           AND operation = 'PUBLISH' AND outcome = 'STARTED'
         FOR UPDATE`,
        [input.attemptId, input.lease.job.aggregateId, input.lease.job.workspaceId],
      );
      if (attempt.rows[0] === undefined) return false;
      await client.query(
        `UPDATE publication_attempts
         SET outcome = 'AMBIGUOUS', error_code = $1, remote_ref = $2, finished_at = $3
         WHERE id = $4`,
        [input.errorCode, input.remoteRef ?? null, input.now, input.attemptId],
      );
      await client.query(
        `UPDATE publication_records
         SET status = 'AMBIGUOUS', updated_at = $1
         WHERE id = $2 AND workspace_id = $3 AND status = 'RUNNING'`,
        [input.now, input.lease.job.aggregateId, input.lease.job.workspaceId],
      );
      await appendPublicationAudit(client, {
        id: input.auditEventId,
        publicationId: input.lease.job.aggregateId,
        action: 'PUBLICATION_PUBLISH_AMBIGUOUS',
        operation: 'PUBLISH',
        outcome: 'AMBIGUOUS',
        attemptId: input.attemptId,
        errorCode: input.errorCode,
        now: input.now,
      });
      return true;
    });
  }

  recordReconcileApplied(
    input: Parameters<PublicationExecutionStore['recordReconcileApplied']>[0],
  ) {
    return this.finishApplied({ ...input, operation: 'RECONCILE', expectedStatus: 'RECONCILING' });
  }

  recordReconcileUnknown(
    input: Parameters<PublicationExecutionStore['recordReconcileUnknown']>[0],
  ) {
    return this.contexts.run(workerContext(input.lease), async (client) => {
      if (!(await lockLiveLease(client, input.lease, input.now))) return false;
      if (!(await lockPublicationStatus(client, input.lease, 'RECONCILING'))) return false;
      const attempt = await client.query(
        `SELECT id FROM publication_attempts
         WHERE id = $1 AND publication_id = $2 AND workspace_id = $3
           AND operation = 'RECONCILE' AND outcome = 'STARTED'
         FOR UPDATE`,
        [input.attemptId, input.lease.job.aggregateId, input.lease.job.workspaceId],
      );
      if (attempt.rows[0] === undefined) return false;
      await client.query(
        `UPDATE publication_attempts
         SET outcome = 'UNKNOWN', error_code = $1, finished_at = $2
         WHERE id = $3`,
        [input.errorCode, input.now, input.attemptId],
      );
      await client.query(
        `UPDATE publication_records
         SET status = 'MANUAL_REVIEW_REQUIRED', updated_at = $1
         WHERE id = $2 AND workspace_id = $3 AND status = 'RECONCILING'`,
        [input.now, input.lease.job.aggregateId, input.lease.job.workspaceId],
      );
      await appendPublicationAudit(client, {
        id: input.auditEventId,
        publicationId: input.lease.job.aggregateId,
        action: 'PUBLICATION_RECONCILE_UNKNOWN',
        operation: 'RECONCILE',
        outcome: 'UNKNOWN',
        attemptId: input.attemptId,
        errorCode: input.errorCode,
        auditOutcome: 'FAILED',
        now: input.now,
      });
      return true;
    });
  }

  recordReconcileDefinitelyNotApplied(
    input: Parameters<PublicationExecutionStore['recordReconcileDefinitelyNotApplied']>[0],
  ) {
    return this.contexts.run(workerContext(input.lease), async (client) => {
      if (!(await lockLiveLease(client, input.lease, input.now))) return false;
      if (!(await lockPublicationStatus(client, input.lease, 'RECONCILING'))) return false;
      const attempt = await client.query(
        `SELECT id FROM publication_attempts
         WHERE id = $1 AND publication_id = $2 AND workspace_id = $3
           AND operation = 'RECONCILE' AND outcome = 'STARTED'
         FOR UPDATE`,
        [input.attemptId, input.lease.job.aggregateId, input.lease.job.workspaceId],
      );
      if (attempt.rows[0] === undefined) return false;
      await client.query(
        `UPDATE publication_attempts
         SET outcome = 'DEFINITELY_NOT_APPLIED', error_code = $1, finished_at = $2
         WHERE id = $3`,
        [input.errorCode, input.now, input.attemptId],
      );
      await client.query(
        `UPDATE publication_records
         SET status = 'FAILED_TERMINAL', updated_at = $1
         WHERE id = $2 AND workspace_id = $3 AND status = 'RECONCILING'`,
        [input.now, input.lease.job.aggregateId, input.lease.job.workspaceId],
      );
      await appendPublicationAudit(client, {
        id: input.auditEventId,
        publicationId: input.lease.job.aggregateId,
        action: 'PUBLICATION_RECONCILE_DEFINITELY_NOT_APPLIED',
        operation: 'RECONCILE',
        outcome: 'DEFINITELY_NOT_APPLIED',
        attemptId: input.attemptId,
        errorCode: input.errorCode,
        auditOutcome: 'FAILED',
        now: input.now,
      });
      return true;
    });
  }

  recordRetryableFailure(
    input: Parameters<PublicationExecutionStore['recordRetryableFailure']>[0],
  ) {
    return this.contexts.run(workerContext(input.lease), async (client) => {
      if (!(await lockLiveLease(client, input.lease, input.now))) return false;
      const expectedStatus = input.operation === 'PUBLISH' ? 'RUNNING' : 'RECONCILING';
      if (!(await lockPublicationStatus(client, input.lease, expectedStatus))) return false;
      const attempt = await client.query(
        `SELECT id FROM publication_attempts
         WHERE id = $1 AND publication_id = $2 AND workspace_id = $3
           AND operation = $4 AND outcome = 'STARTED'
         FOR UPDATE`,
        [
          input.attemptId,
          input.lease.job.aggregateId,
          input.lease.job.workspaceId,
          input.operation,
        ],
      );
      if (attempt.rows[0] === undefined) return false;
      await client.query(
        `UPDATE publication_attempts
         SET outcome = 'RETRYABLE_FAILURE', error_code = $1, finished_at = $2
         WHERE id = $3`,
        [input.errorCode, input.now, input.attemptId],
      );
      const publicationStatus = input.operation === 'PUBLISH' ? 'RETRY_WAIT' : 'RECONCILE_REQUIRED';
      await client.query(
        `UPDATE publication_records
         SET status = $1, updated_at = $2
         WHERE id = $3 AND workspace_id = $4 AND status = $5`,
        [
          publicationStatus,
          input.now,
          input.lease.job.aggregateId,
          input.lease.job.workspaceId,
          expectedStatus,
        ],
      );
      await appendPublicationAudit(client, {
        id: input.auditEventId,
        publicationId: input.lease.job.aggregateId,
        action: 'PUBLICATION_ADAPTER_RETRYABLE_FAILURE',
        operation: input.operation,
        outcome: 'RETRYABLE_FAILURE',
        attemptId: input.attemptId,
        errorCode: input.errorCode,
        auditOutcome: 'FAILED',
        now: input.now,
      });
      return true;
    });
  }

  recordPreflightFailure(
    input: Parameters<PublicationExecutionStore['recordPreflightFailure']>[0],
  ) {
    return this.contexts.run(workerContext(input.lease), async (client) => {
      if (!(await lockLiveLease(client, input.lease, input.now))) return false;
      const expectedStatus = input.operation === 'PUBLISH' ? 'RUNNING' : 'RECONCILING';
      if (!(await lockPublicationStatus(client, input.lease, expectedStatus))) return false;
      const attempt = await client.query(
        `SELECT id FROM publication_attempts
         WHERE id = $1 AND publication_id = $2 AND workspace_id = $3
           AND operation = $4 AND outcome = 'STARTED'
         FOR UPDATE`,
        [
          input.attemptId,
          input.lease.job.aggregateId,
          input.lease.job.workspaceId,
          input.operation,
        ],
      );
      if (attempt.rows[0] === undefined) return false;
      const attemptOutcome = input.operation === 'PUBLISH' ? 'DEFINITELY_NOT_APPLIED' : 'UNKNOWN';
      await client.query(
        `UPDATE publication_attempts
         SET outcome = $1, error_code = $2, finished_at = $3
         WHERE id = $4`,
        [attemptOutcome, input.errorCode, input.now, input.attemptId],
      );
      const publicationStatus =
        input.operation === 'PUBLISH' ? 'FAILED_TERMINAL' : 'MANUAL_REVIEW_REQUIRED';
      await client.query(
        `UPDATE publication_records
         SET status = $1, updated_at = $2
         WHERE id = $3 AND workspace_id = $4 AND status = $5`,
        [
          publicationStatus,
          input.now,
          input.lease.job.aggregateId,
          input.lease.job.workspaceId,
          expectedStatus,
        ],
      );
      await appendPublicationAudit(client, {
        id: input.auditEventId,
        publicationId: input.lease.job.aggregateId,
        action: 'PUBLICATION_PREFLIGHT_FAILED',
        operation: input.operation,
        outcome: attemptOutcome,
        attemptId: input.attemptId,
        errorCode: input.errorCode,
        auditOutcome: 'FAILED',
        now: input.now,
      });
      return true;
    });
  }

  private finishApplied(input: {
    lease: JobLease;
    attemptId: string;
    remoteRef: string;
    publicationStatus: 'PUBLISHED' | 'REMOTE_APPLIED';
    remoteState: PublicationRemoteState | null;
    auditEventId: string;
    now: Date;
    operation: 'PUBLISH' | 'RECONCILE';
    expectedStatus: 'RUNNING' | 'RECONCILING';
  }) {
    return this.contexts.run(workerContext(input.lease), async (client) => {
      if (!(await lockLiveLease(client, input.lease, input.now))) return false;
      if (!(await lockPublicationStatus(client, input.lease, input.expectedStatus))) return false;
      const attempt = await client.query(
        `SELECT id FROM publication_attempts
         WHERE id = $1 AND publication_id = $2 AND workspace_id = $3
           AND operation = $4 AND outcome = 'STARTED'
         FOR UPDATE`,
        [
          input.attemptId,
          input.lease.job.aggregateId,
          input.lease.job.workspaceId,
          input.operation,
        ],
      );
      if (attempt.rows[0] === undefined) return false;
      await client.query(
        `UPDATE publication_attempts
         SET outcome = 'APPLIED', remote_ref = $1, error_code = NULL, finished_at = $2
         WHERE id = $3`,
        [input.remoteRef, input.now, input.attemptId],
      );
      await client.query(
        `UPDATE publication_records
         SET status = $1, remote_ref = $2, remote_state = $3::jsonb, updated_at = $4
         WHERE id = $5 AND workspace_id = $6 AND status = $7`,
        [
          input.publicationStatus,
          input.remoteRef,
          input.remoteState === null ? null : JSON.stringify(input.remoteState),
          input.now,
          input.lease.job.aggregateId,
          input.lease.job.workspaceId,
          input.expectedStatus,
        ],
      );
      await appendPublicationAudit(client, {
        id: input.auditEventId,
        publicationId: input.lease.job.aggregateId,
        action:
          input.operation === 'PUBLISH'
            ? 'PUBLICATION_PUBLISH_APPLIED'
            : 'PUBLICATION_RECONCILE_APPLIED',
        operation: input.operation,
        outcome: 'APPLIED',
        attemptId: input.attemptId,
        now: input.now,
      });
      return true;
    });
  }
}

async function rejectExecutionGate(
  client: PoolClient,
  input: Parameters<PublicationExecutionStore['prepare']>[0],
  row: ExecutionRow,
  remoteOutcomeUncertain: boolean,
): Promise<void> {
  let attemptId: string | undefined;
  if (!remoteOutcomeUncertain) {
    await client.query(
      `UPDATE publication_records
       SET status = 'FAILED_TERMINAL', updated_at = $1
       WHERE id = $2 AND workspace_id = $3 AND status IN ('QUEUED', 'RETRY_WAIT')`,
      [input.now, row.publication_id, input.lease.job.workspaceId],
    );
  } else {
    const started = await client.query<{ id: string }>(
      `SELECT id FROM publication_attempts
       WHERE publication_id = $1 AND workspace_id = $2 AND outcome = 'STARTED'
       ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`,
      [row.publication_id, input.lease.job.workspaceId],
    );
    attemptId = started.rows[0]?.id;
    if (attemptId !== undefined) {
      await client.query(
        `UPDATE publication_attempts
         SET outcome = 'UNKNOWN', error_code = 'PUBLICATION_RECONCILE_GATE_UNAVAILABLE',
           finished_at = $1
         WHERE id = $2 AND outcome = 'STARTED'`,
        [input.now, attemptId],
      );
    }
    if (row.publication_status === 'RUNNING') {
      await client.query(
        `UPDATE publication_records SET status = 'AMBIGUOUS', updated_at = $1
         WHERE id = $2 AND workspace_id = $3 AND status = 'RUNNING'`,
        [input.now, row.publication_id, input.lease.job.workspaceId],
      );
      await client.query(
        `UPDATE publication_records SET status = 'MANUAL_REVIEW_REQUIRED', updated_at = $1
         WHERE id = $2 AND workspace_id = $3 AND status = 'AMBIGUOUS'`,
        [input.now, row.publication_id, input.lease.job.workspaceId],
      );
    } else if (
      ['AMBIGUOUS', 'RECONCILE_REQUIRED', 'RECONCILING'].includes(row.publication_status)
    ) {
      await client.query(
        `UPDATE publication_records SET status = 'MANUAL_REVIEW_REQUIRED', updated_at = $1
         WHERE id = $2 AND workspace_id = $3
           AND status IN ('AMBIGUOUS', 'RECONCILE_REQUIRED', 'RECONCILING')`,
        [input.now, row.publication_id, input.lease.job.workspaceId],
      );
    }
  }
  await appendPublicationAudit(client, {
    id: input.gateFailureAuditEventId,
    publicationId: row.publication_id,
    action: remoteOutcomeUncertain
      ? 'PUBLICATION_RECONCILE_GATE_UNAVAILABLE'
      : 'PUBLICATION_GATE_REJECTED',
    operation: remoteOutcomeUncertain ? 'RECONCILE' : 'PUBLISH',
    outcome: remoteOutcomeUncertain ? 'UNKNOWN' : 'DEFINITELY_NOT_APPLIED',
    ...(attemptId === undefined ? {} : { attemptId }),
    errorCode: remoteOutcomeUncertain
      ? 'PUBLICATION_RECONCILE_GATE_UNAVAILABLE'
      : 'PUBLICATION_GATE_STALE',
    auditOutcome: 'FAILED',
    now: input.now,
  });
}

/**
 * Prompt writers serialize on the parent before changing a revision. Acquire that same parent
 * first so the final effect fence cannot form prompt_revision -> prompt_set against the writer's
 * prompt_set -> prompt_revision order.
 */
async function lockCurrentPromptSetParent(client: PoolClient, lease: JobLease): Promise<boolean> {
  const result = await client.query(
    `SELECT prompt_set.id
     FROM publication_records publication
     JOIN channel_packages package
       ON package.tenant_id = publication.tenant_id
      AND package.workspace_id = publication.workspace_id
      AND package.id = publication.channel_package_id
      AND package.package_checksum = publication.package_checksum
      AND package.artifact_revision_id = publication.artifact_revision_id
      AND package.artifact_content_hash = publication.artifact_content_hash
     JOIN artifact_revisions revision
       ON revision.tenant_id = package.tenant_id
      AND revision.workspace_id = package.workspace_id
      AND revision.artifact_id = package.artifact_id
      AND revision.id = package.artifact_revision_id
      AND revision.revision = package.artifact_revision
      AND revision.content_hash = package.artifact_content_hash
     JOIN briefs brief
       ON brief.tenant_id = revision.tenant_id
      AND brief.workspace_id = revision.workspace_id
      AND brief.id = revision.brief_id
     JOIN content_plans plan
       ON plan.tenant_id = brief.tenant_id
      AND plan.workspace_id = brief.workspace_id
      AND plan.id = brief.content_plan_id
     JOIN prompt_sets prompt_set
       ON prompt_set.tenant_id = plan.tenant_id
      AND prompt_set.workspace_id = plan.workspace_id
      AND prompt_set.id::text = plan.input_snapshot ->> 'promptSetId'
     WHERE publication.id = $1
       AND publication.workspace_id = $2
       AND publication.job_id = $3
       AND publication.status = 'RUNNING'
     FOR SHARE OF prompt_set`,
    [lease.job.aggregateId, lease.job.workspaceId, lease.job.id],
  );
  return result.rows[0] !== undefined;
}

async function lockExpectedAuthorizationMaterial(
  client: PoolClient,
  lease: JobLease,
  attemptId: string,
  operation: 'PUBLISH' | 'RECONCILE',
  expected: PublicationAuthorizationMaterial,
  expectedRequiredScopes: string[],
): Promise<boolean> {
  const result = await client.query<{ accepted: boolean }>(
    `SELECT guard_publication_authorization_material(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
     ) AS accepted`,
    [
      lease.job.tenantId,
      lease.job.workspaceId,
      lease.job.aggregateId,
      lease.job.id,
      lease.messageId,
      lease.leaseToken,
      attemptId,
      operation,
      expected.secretReference,
      expected.credentialFingerprint,
      expectedRequiredScopes,
    ],
  );
  return result.rows[0]?.accepted === true;
}

/**
 * Re-check every mutable publish prerequisite immediately before the Adapter boundary. The
 * initial prepare transaction deliberately closes before payload/secret I/O, so its eligibility
 * result cannot be treated as an authorization token.
 */
async function hasCurrentPublishGate(client: PoolClient, lease: JobLease): Promise<boolean> {
  const result = await client.query(
    `SELECT publication.id
     FROM publication_records publication
     JOIN channel_packages package
       ON package.tenant_id = publication.tenant_id
      AND package.workspace_id = publication.workspace_id
      AND package.id = publication.channel_package_id
      AND package.package_checksum = publication.package_checksum
      AND package.artifact_revision_id = publication.artifact_revision_id
      AND package.artifact_content_hash = publication.artifact_content_hash
     JOIN adapter_versions adapter
       ON adapter.id = publication.adapter_version_id
      AND adapter.channel_definition_id = package.channel_definition_id
      AND adapter.enabled
      AND 'PUBLISH' = ANY(adapter.capabilities)
       AND 'RECONCILE' = ANY(adapter.capabilities)
       AND adapter.terms_status = 'ALLOWED'
       AND (adapter.provider_api_supported_until IS NULL OR adapter.provider_api_supported_until > clock_timestamp())
     JOIN channel_definitions channel
       ON channel.id = adapter.channel_definition_id
      AND channel.status = 'AVAILABLE'
     JOIN channel_authorizations channel_auth
       ON channel_auth.tenant_id = publication.tenant_id
      AND channel_auth.workspace_id = publication.workspace_id
      AND channel_auth.id = publication.channel_authorization_id
      AND channel_auth.adapter_version_id = adapter.id
      AND channel_auth.target = publication.authorization_target
      AND channel_auth.status = 'ACTIVE'
      AND channel_auth.accepted_terms_version = adapter.terms_version
      AND channel_auth.validation_status = 'VERIFIED'
      AND channel_auth.validation_actual_target = publication.authorization_target
      AND channel_auth.validation_terms_version = adapter.terms_version
      AND channel_auth.granted_scopes <@ channel_auth.validation_actual_scopes
      AND publication.required_scopes_snapshot <@ adapter.required_scopes
      AND publication.required_scopes_snapshot <@ channel_auth.granted_scopes
      AND publication.required_scopes_snapshot <@ channel_auth.validation_actual_scopes
      AND channel_auth.validation_valid_until > clock_timestamp()
      AND (channel_auth.expires_at IS NULL OR channel_auth.expires_at > clock_timestamp())
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
      AND revision.status = 'APPROVED'
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
      AND scenario.version = prompt_revision.revision
      AND scenario.registry_status = 'AVAILABLE'
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
     JOIN memberships membership
       ON membership.tenant_id = publication.tenant_id
      AND membership.user_id = publication.requested_by_user_id
      AND membership.status = 'ACTIVE'
     JOIN role_bindings binding
       ON binding.tenant_id = membership.tenant_id
      AND binding.workspace_id = publication.workspace_id
      AND binding.membership_id = membership.id
      AND binding.role IN ('OWNER', 'PUBLISHER')
     WHERE publication.id = $1
       AND publication.workspace_id = $2
       AND publication.job_id = $3
       AND publication.status = 'RUNNING'
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
                 JOIN claims claim
                   ON claim.tenant_id = claim_revision.tenant_id
                  AND claim.workspace_id = claim_revision.workspace_id
                  AND claim.id = claim_revision.claim_id
                  AND claim.current_revision = claim_revision.revision
                 JOIN claim_reviews claim_review
                   ON claim_review.tenant_id = claim_revision.tenant_id
                  AND claim_review.workspace_id = claim_revision.workspace_id
                  AND claim_review.claim_revision_id = claim_revision.id
                  AND claim_review.decision = 'APPROVE'
                  AND claim_review.content_hash = claim_revision.content_hash
                 JOIN claim_evidence_links claim_link
                   ON claim_link.tenant_id = claim_revision.tenant_id
                  AND claim_link.workspace_id = claim_revision.workspace_id
                  AND claim_link.claim_revision_id = claim_revision.id
                  AND claim_link.snippet IS NOT NULL
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
                   AND claim_revision.expires_at IS NOT NULL
                   AND claim_revision.expires_at > clock_timestamp()
                  AND snapshot.id = (evidence.value ->> 'snapshotId')::uuid
                  AND snapshot.source_id = (evidence.value ->> 'sourceId')::uuid
                  AND snapshot.content_hash = evidence.value ->> 'sourceHash'
                  AND claim_link.source_hash = evidence.value ->> 'sourceHash'
              )
            )
       )
     LIMIT 1
     FOR SHARE OF publication, artifact, revision,
       brief, plan, prompt_revision, prompt_set, crawl, site, membership, binding`,
    [lease.job.aggregateId, lease.job.workspaceId, lease.job.id],
  );
  return result.rows[0] !== undefined;
}

async function hasCurrentReconcileGate(client: PoolClient, lease: JobLease): Promise<boolean> {
  const result = await client.query(
    `SELECT publication.id
     FROM publication_records publication
     JOIN channel_packages package
       ON package.tenant_id = publication.tenant_id
      AND package.workspace_id = publication.workspace_id
      AND package.id = publication.channel_package_id
      AND package.package_checksum = publication.package_checksum
      AND package.artifact_revision_id = publication.artifact_revision_id
      AND package.artifact_content_hash = publication.artifact_content_hash
     JOIN artifact_revisions revision
       ON revision.tenant_id = package.tenant_id
      AND revision.workspace_id = package.workspace_id
      AND revision.artifact_id = package.artifact_id
      AND revision.id = package.artifact_revision_id
      AND revision.revision = package.artifact_revision
      AND revision.content_hash = package.artifact_content_hash
     JOIN adapter_versions adapter
       ON adapter.id = publication.adapter_version_id
      AND adapter.channel_definition_id = package.channel_definition_id
      AND adapter.enabled
       AND 'RECONCILE' = ANY(adapter.capabilities)
       AND adapter.terms_status = 'ALLOWED'
       AND (adapter.provider_api_supported_until IS NULL OR adapter.provider_api_supported_until > clock_timestamp())
     JOIN channel_definitions channel
       ON channel.id = adapter.channel_definition_id
      AND channel.status = 'AVAILABLE'
     JOIN channel_authorizations channel_auth
       ON channel_auth.tenant_id = publication.tenant_id
      AND channel_auth.workspace_id = publication.workspace_id
      AND channel_auth.id = publication.channel_authorization_id
      AND channel_auth.adapter_version_id = adapter.id
      AND channel_auth.target = publication.authorization_target
      AND channel_auth.status = 'ACTIVE'
      AND channel_auth.accepted_terms_version = adapter.terms_version
      AND channel_auth.validation_status = 'VERIFIED'
      AND channel_auth.validation_actual_target = publication.authorization_target
      AND channel_auth.validation_terms_version = adapter.terms_version
      AND channel_auth.granted_scopes <@ channel_auth.validation_actual_scopes
      AND publication.required_scopes_snapshot <@ adapter.required_scopes
      AND publication.required_scopes_snapshot <@ channel_auth.granted_scopes
      AND publication.required_scopes_snapshot <@ channel_auth.validation_actual_scopes
      AND channel_auth.validation_valid_until > clock_timestamp()
      AND (channel_auth.expires_at IS NULL OR channel_auth.expires_at > clock_timestamp())
     JOIN memberships membership
       ON membership.tenant_id = publication.tenant_id
      AND membership.user_id = publication.requested_by_user_id
      AND membership.status = 'ACTIVE'
     JOIN role_bindings binding
       ON binding.tenant_id = membership.tenant_id
      AND binding.workspace_id = publication.workspace_id
      AND binding.membership_id = membership.id
      AND binding.role IN ('OWNER', 'PUBLISHER')
     WHERE publication.id = $1
       AND publication.workspace_id = $2
       AND publication.job_id = $3
       AND publication.status = 'RECONCILING'
     LIMIT 1
     FOR SHARE OF publication, revision, membership, binding`,
    [lease.job.aggregateId, lease.job.workspaceId, lease.job.id],
  );
  return result.rows[0] !== undefined;
}

async function lockCurrentPublishEvidenceGate(
  client: PoolClient,
  lease: JobLease,
): Promise<boolean> {
  const result = await client.query<{ expected_count: number }>(
    `SELECT (
       SELECT COALESCE(sum(jsonb_array_length(expected_binding.value -> 'evidence')), 0)::integer
       FROM jsonb_array_elements(revision.claim_bindings) expected_binding(value)
     ) AS expected_count
     FROM publication_records publication
     JOIN channel_packages package
       ON package.tenant_id = publication.tenant_id
      AND package.workspace_id = publication.workspace_id
      AND package.id = publication.channel_package_id
      AND package.package_checksum = publication.package_checksum
      AND package.artifact_revision_id = publication.artifact_revision_id
      AND package.artifact_content_hash = publication.artifact_content_hash
     JOIN artifact_revisions revision
       ON revision.tenant_id = package.tenant_id
      AND revision.workspace_id = package.workspace_id
      AND revision.artifact_id = package.artifact_id
      AND revision.id = package.artifact_revision_id
      AND revision.revision = package.artifact_revision
      AND revision.content_hash = package.artifact_content_hash
     CROSS JOIN LATERAL jsonb_array_elements(revision.claim_bindings) claim_binding(value)
     CROSS JOIN LATERAL jsonb_array_elements(claim_binding.value -> 'evidence') evidence(value)
     JOIN claim_revisions claim_revision
       ON claim_revision.tenant_id = revision.tenant_id
      AND claim_revision.workspace_id = revision.workspace_id
      AND claim_revision.id = (claim_binding.value ->> 'claimRevisionId')::uuid
      AND claim_revision.claim_id = (claim_binding.value ->> 'claimId')::uuid
       AND claim_revision.content_hash = claim_binding.value ->> 'claimContentHash'
       AND claim_revision.statement = claim_binding.value ->> 'claimStatement'
       AND claim_revision.status = 'APPROVED'
       AND claim_revision.expires_at IS NOT NULL
       AND claim_revision.expires_at > clock_timestamp()
      JOIN claims claim
        ON claim.tenant_id = claim_revision.tenant_id
       AND claim.workspace_id = claim_revision.workspace_id
       AND claim.id = claim_revision.claim_id
       AND claim.current_revision = claim_revision.revision
      JOIN claim_reviews claim_review
        ON claim_review.tenant_id = claim_revision.tenant_id
       AND claim_review.workspace_id = claim_revision.workspace_id
       AND claim_review.claim_revision_id = claim_revision.id
       AND claim_review.decision = 'APPROVE'
       AND claim_review.content_hash = claim_revision.content_hash
      JOIN claim_evidence_links claim_link
        ON claim_link.tenant_id = claim_revision.tenant_id
       AND claim_link.workspace_id = claim_revision.workspace_id
       AND claim_link.claim_revision_id = claim_revision.id
       AND claim_link.snippet IS NOT NULL
     JOIN evidence_snapshots snapshot
       ON snapshot.tenant_id = claim_link.tenant_id
      AND snapshot.workspace_id = claim_link.workspace_id
      AND snapshot.id = claim_link.snapshot_id
      AND snapshot.id = (evidence.value ->> 'snapshotId')::uuid
      AND snapshot.source_id = (evidence.value ->> 'sourceId')::uuid
      AND snapshot.content_hash = evidence.value ->> 'sourceHash'
      AND claim_link.source_hash = evidence.value ->> 'sourceHash'
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
     WHERE publication.id = $1
       AND publication.workspace_id = $2
       AND publication.job_id = $3
       AND publication.status = 'RUNNING'
     FOR SHARE OF claim_revision, evidence_source`,
    [lease.job.aggregateId, lease.job.workspaceId, lease.job.id],
  );
  const expectedCount = result.rows[0]?.expected_count;
  return expectedCount !== undefined && expectedCount > 0 && result.rows.length === expectedCount;
}

async function lockLiveLeaseAtDatabaseTime(client: PoolClient, lease: JobLease): Promise<boolean> {
  if (!(await lockActivePublicationScope(client, lease))) return false;
  const result = await client.query(
    `SELECT id FROM jobs
     WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3
        AND job_type = 'PUBLICATION' AND aggregate_id = $4
        AND status = 'RUNNING' AND lease_token = $5
        AND lifecycle_frozen_at IS NULL
        AND lease_expires_at >= clock_timestamp() + interval '1 second'
     FOR SHARE`,
    [
      lease.job.id,
      lease.job.tenantId,
      lease.job.workspaceId,
      lease.job.aggregateId,
      lease.leaseToken,
    ],
  );
  return result.rows[0] !== undefined;
}

async function lockLiveLease(client: PoolClient, lease: JobLease, now: Date): Promise<boolean> {
  if (!(await lockActivePublicationScope(client, lease))) return false;
  const result = await client.query(
    `SELECT id FROM jobs
     WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3
        AND job_type = 'PUBLICATION' AND aggregate_id = $4
        AND status = 'RUNNING' AND lease_token = $5
        AND lifecycle_frozen_at IS NULL AND lease_expires_at >= $6
     FOR SHARE`,
    [
      lease.job.id,
      lease.job.tenantId,
      lease.job.workspaceId,
      lease.job.aggregateId,
      lease.leaseToken,
      now,
    ],
  );
  return result.rows[0] !== undefined;
}

async function lockActivePublicationScope(client: PoolClient, lease: JobLease): Promise<boolean> {
  const tenant = await client.query<{ id: string }>(
    `SELECT id FROM tenants
     WHERE id = $1 AND lifecycle_state = 'ACTIVE'
     FOR SHARE`,
    [lease.job.tenantId],
  );
  if (tenant.rows[0] === undefined) return false;
  const workspace = await client.query<{ id: string }>(
    `SELECT id FROM workspaces
     WHERE tenant_id = $1 AND id = $2 AND lifecycle_state = 'ACTIVE'
     FOR SHARE`,
    [lease.job.tenantId, lease.job.workspaceId],
  );
  return workspace.rows[0] !== undefined;
}

async function lockPublicationStatus(
  client: PoolClient,
  lease: JobLease,
  status: 'RUNNING' | 'RECONCILING',
): Promise<boolean> {
  const result = await client.query(
    `SELECT id FROM publication_records
     WHERE id = $1 AND workspace_id = $2 AND job_id = $3 AND status = $4
     FOR UPDATE`,
    [lease.job.aggregateId, lease.job.workspaceId, lease.job.id, status],
  );
  return result.rows[0] !== undefined;
}

async function nextAttemptNumber(client: PoolClient, publicationId: string): Promise<number> {
  const result = await client.query<{ next_attempt: number }>(
    `SELECT COALESCE(MAX(attempt_number), 0)::integer + 1 AS next_attempt
     FROM publication_attempts WHERE publication_id = $1`,
    [publicationId],
  );
  const next = result.rows[0]?.next_attempt;
  if (next === undefined) throw new Error('PUBLICATION_ATTEMPT_NUMBER_NOT_RETURNED');
  return next;
}

async function insertStartedAttempt(
  client: PoolClient,
  input: {
    id: string;
    lease: JobLease;
    publicationId: string;
    attemptNumber: number;
    operation: 'PUBLISH' | 'RECONCILE';
    now: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO publication_attempts
      (id, tenant_id, workspace_id, publication_id, attempt_number, operation, outcome,
        started_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'STARTED', $7)`,
    [
      input.id,
      input.lease.job.tenantId,
      input.lease.job.workspaceId,
      input.publicationId,
      input.attemptNumber,
      input.operation,
      input.now,
    ],
  );
}

async function appendPublicationAudit(
  client: PoolClient,
  input: {
    id: string;
    publicationId: string;
    action: string;
    operation: 'PUBLISH' | 'RECONCILE';
    outcome: string;
    attemptId?: string;
    errorCode?: string;
    auditOutcome?: 'SUCCEEDED' | 'FAILED';
    now: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
      (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
        outcome, metadata, occurred_at)
     SELECT $1, publication.tenant_id, publication.workspace_id,
       publication.requested_by_user_id, $2, 'PUBLICATION', publication.id, $3,
       jsonb_strip_nulls(jsonb_build_object(
         'operation', $4::text,
         'attemptId', $5::uuid,
         'outcome', $6::text,
         'errorCode', $7::text)),
       $8
     FROM publication_records publication
     WHERE publication.id = $9`,
    [
      input.id,
      input.action,
      input.auditOutcome ?? 'SUCCEEDED',
      input.operation,
      input.attemptId ?? null,
      input.outcome,
      input.errorCode ?? null,
      input.now,
      input.publicationId,
    ],
  );
}

async function readUnsafeCreateCompensationIntent(
  client: PoolClient,
  publicationId: string,
  workspaceId: string,
): Promise<PublicationAdapterReconciliationIntent | undefined> {
  const result = await client.query<CompletedPublishAttemptRow>(
    `SELECT outcome, error_code, remote_ref
     FROM publication_attempts
     WHERE publication_id = $1 AND workspace_id = $2
       AND operation = 'PUBLISH' AND finished_at IS NOT NULL
     ORDER BY attempt_number DESC
     LIMIT 1`,
    [publicationId, workspaceId],
  );
  const attempt = result.rows[0];
  return attempt?.outcome === 'AMBIGUOUS' &&
    attempt.error_code === 'UNSAFE_CREATE_COMPENSATION_PENDING' &&
    attempt.remote_ref !== null
    ? {
        kind: 'COMPENSATE_UNSAFE_CREATE',
        remoteRef: attempt.remote_ref,
      }
    : undefined;
}

async function hasDurableRecoveryEvidence(
  client: PoolClient,
  publicationId: string,
  workspaceId: string,
  status: PublicationStatus,
): Promise<boolean> {
  const result = await client.query<RecoveryEvidenceAttemptRow>(
    `SELECT operation, outcome, finished_at
     FROM publication_attempts
     WHERE publication_id = $1 AND workspace_id = $2
     ORDER BY attempt_number DESC
     LIMIT 1
     FOR UPDATE`,
    [publicationId, workspaceId],
  );
  const attempt = result.rows[0];
  if (attempt === undefined) return false;

  switch (status) {
    case 'RUNNING':
      return (
        attempt.operation === 'PUBLISH' &&
        attempt.outcome === 'STARTED' &&
        attempt.finished_at === null
      );
    case 'AMBIGUOUS':
      return (
        attempt.operation === 'PUBLISH' &&
        attempt.outcome === 'AMBIGUOUS' &&
        attempt.finished_at !== null
      );
    case 'RECONCILE_REQUIRED':
      return (
        attempt.operation === 'RECONCILE' &&
        attempt.outcome === 'RETRYABLE_FAILURE' &&
        attempt.finished_at !== null
      );
    case 'RECONCILING':
      return (
        attempt.operation === 'RECONCILE' &&
        attempt.outcome === 'STARTED' &&
        attempt.finished_at === null
      );
    default:
      return false;
  }
}

function mapExecution(row: ExecutionRow): PublicationExecutionContext {
  return {
    publicationId: row.publication_id,
    publicationStatus: row.publication_status,
    idempotencyKey: row.idempotency_key,
    target: row.target,
    authorizationTarget: row.authorization_target,
    authorizationGrantedScopes: row.authorization_granted_scopes,
    remoteRef: row.remote_ref,
    remoteState: row.remote_state,
    adapterKey: row.adapter_key,
    adapterVersion: row.adapter_version,
    ...(row.adapter_provider_api_version === null
      ? {}
      : { adapterProviderApiVersion: row.adapter_provider_api_version }),
    ...(row.adapter_provider_api_supported_until === null
      ? {}
      : {
          adapterProviderApiSupportedUntil: new Date(
            row.adapter_provider_api_supported_until,
          ).toISOString(),
        }),
    adapterCapabilities: row.adapter_capabilities,
    adapterRequiredScopes: row.adapter_required_scopes,
    adapterTermsVersion: row.adapter_terms_version,
    adapterProcessingRegion: row.adapter_processing_region,
    adapterRetentionPolicy: row.adapter_retention_policy,
    adapterTrainingPolicy: row.adapter_training_policy,
    adapterSubprocessors: row.adapter_subprocessors,
    adapterRatePolicy: row.adapter_rate_policy,
    channelPackage: mapPackage(row),
  };
}

function mapPackage(row: ExecutionRow): ChannelPackageRecord {
  return {
    id: row.package_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    packageRevision: row.package_revision,
    channel: { definitionId: row.channel_definition_id, channelKey: row.channel_key },
    transformer: { key: row.transformer_key, version: row.transformer_version },
    packageSchemaVersion: row.package_schema_version,
    artifact: {
      artifactId: row.artifact_id,
      artifactRevisionId: row.artifact_revision_id,
      revision: row.artifact_revision,
      contentHash: row.artifact_content_hash,
      type: row.artifact_type,
      locale: row.artifact_locale,
      market: row.artifact_market,
      methodPolicyVersion: row.artifact_method_policy_version,
    },
    manifest: row.manifest,
    packageChecksum: row.package_checksum,
    payloadObjectRef: row.payload_object_ref,
    createdByUserId: row.created_by_user_id,
    createdAt: row.package_created_at.toISOString(),
  };
}

function workerContext(lease: JobLease): TenantContext {
  return {
    tenantId: lease.job.tenantId,
    workspaceId: lease.job.workspaceId,
    actorUserId: lease.job.id,
    membershipId: lease.job.id,
    role: 'OWNER',
  };
}
