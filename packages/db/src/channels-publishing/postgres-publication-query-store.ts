import type { PublicationQueryStore } from '@aeostudio/application/channels-publishing';
import type {
  PublicationAttemptOperation,
  PublicationAttemptOutcome,
  PublicationAttemptRecord,
  PublicationRecord,
  PublicationRemoteState,
  PublicationStatus,
} from '@aeostudio/domain/channels-publishing';
import type { JobRecord, JobStatus } from '@aeostudio/domain/jobs-budgets';
import type { Pool } from 'pg';

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

interface AttemptRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  publication_id: string;
  attempt_number: number;
  operation: PublicationAttemptOperation;
  outcome: PublicationAttemptOutcome;
  remote_ref: string | null;
  error_code: string | null;
  started_at: Date;
  finished_at: Date | null;
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

const PUBLICATION_COLUMNS = `id, tenant_id, workspace_id, channel_package_id,
  package_checksum, artifact_revision_id, artifact_content_hash, adapter_version_id,
  channel_authorization_id, target, idempotency_key, request_hash, status, job_id,
  remote_ref, remote_state, requested_by_user_id, created_at, updated_at`;

const ATTEMPT_COLUMNS = `id, tenant_id, workspace_id, publication_id, attempt_number,
  operation, outcome, remote_ref, error_code, started_at, finished_at`;

const JOB_COLUMNS = `id, tenant_id, workspace_id, provider_key, job_type, aggregate_id, status, progress,
  attempt, max_attempts, budget_warning, estimated_units::integer, heartbeat_at, result,
  error_code`;

/** Read projection deliberately excludes Channel authorization secret references. */
export class PostgresPublicationQueryStore implements PublicationQueryStore {
  private readonly contexts: TenantContextRunner;

  constructor(pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  findDetail(input: Parameters<PublicationQueryStore['findDetail']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const publications = await client.query<PublicationRow>(
        `SELECT ${PUBLICATION_COLUMNS}
         FROM publication_records
         WHERE workspace_id = $1 AND id = $2`,
        [input.context.workspaceId, input.publicationId],
      );
      const row = publications.rows[0];
      if (row === undefined) return null;
      if (row.job_id === null) throw new Error('PUBLICATION_JOB_BINDING_MISSING');

      const [attempts, jobs] = await Promise.all([
        client.query<AttemptRow>(
          `SELECT ${ATTEMPT_COLUMNS}
           FROM publication_attempts
           WHERE workspace_id = $1 AND publication_id = $2
           ORDER BY attempt_number`,
          [input.context.workspaceId, input.publicationId],
        ),
        client.query<JobRow>(
          `SELECT ${JOB_COLUMNS}
           FROM jobs
           WHERE workspace_id = $1 AND id = $2 AND job_type = 'PUBLICATION'`,
          [input.context.workspaceId, row.job_id],
        ),
      ]);
      const job = jobs.rows[0];
      if (job === undefined || job.aggregate_id !== row.id) {
        throw new Error('PUBLICATION_JOB_BINDING_INVALID');
      }
      return {
        publication: mapPublication(row),
        attempts: attempts.rows.map(mapAttempt),
        job: mapJob(job),
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

function mapAttempt(row: AttemptRow): PublicationAttemptRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    publicationId: row.publication_id,
    attemptNumber: row.attempt_number,
    operation: row.operation,
    outcome: row.outcome,
    remoteRef: row.remote_ref,
    errorCode: row.error_code,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
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
