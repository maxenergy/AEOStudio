import type { PublicationRemoteStatusRefreshStore } from '@aeostudio/application/channels-publishing';
import type { TenantContext } from '@aeostudio/application/identity-access';
import type {
  PublicationRecord,
  PublicationRemoteState,
  PublicationStatus,
} from '@aeostudio/domain/channels-publishing';
import type { Pool } from 'pg';

import { TenantContextRunner } from '../tenant-context/index.js';

type GitPullRequestStatus = 'PR_OPENED' | 'MERGED' | 'CLOSED' | 'FAILED';

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

const PUBLICATION_COLUMNS = `id, tenant_id, workspace_id, channel_package_id,
  package_checksum, artifact_revision_id, artifact_content_hash, adapter_version_id,
  channel_authorization_id, target, idempotency_key, request_hash, status, job_id,
  remote_ref, remote_state, requested_by_user_id, created_at, updated_at`;

export type RecordPublicationRemoteStatusOutcome =
  | { outcome: 'SUCCEEDED'; publication: PublicationRecord }
  | { outcome: 'NOT_FOUND' | 'STALE' | 'INVALID' };

/**
 * PostgreSQL CAS for Provider lifecycle metadata.
 *
 * Provider I/O remains outside the transaction. The complete previously observed remote state is
 * compared during UPDATE, so racing refreshes cannot overwrite a terminal state selected by an
 * earlier request.
 */
export class PostgresPublicationRemoteStatusRefreshStore implements PublicationRemoteStatusRefreshStore {
  private readonly contexts: TenantContextRunner;

  constructor(pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  /** Production has no approved Git Provider runtime in Task 11; fail explicitly, never locally. */
  refresh(): Promise<{ outcome: 'ADAPTER_UNAVAILABLE' }> {
    return Promise.resolve({ outcome: 'ADAPTER_UNAVAILABLE' });
  }

  record(input: {
    context: TenantContext;
    publicationId: string;
    expectedRemoteRef: string;
    expectedRemoteState: PublicationRemoteState;
    remoteState: PublicationRemoteState;
    auditEventId: string;
    now: Date;
  }): Promise<RecordPublicationRemoteStatusOutcome> {
    const expected = parseGitPullRequestState(input.expectedRemoteState);
    const next = parseGitPullRequestState(input.remoteState);
    if (
      expected === null ||
      next === null ||
      expected.number !== next.number ||
      !statusTransitionAllowed(expected.status, next.status) ||
      !safeRemoteRef(input.expectedRemoteRef)
    ) {
      return Promise.resolve({ outcome: 'INVALID' });
    }

    return this.contexts.run(input.context, async (client) => {
      const updated = await client.query<PublicationRow>(
        `UPDATE publication_records
         SET remote_state = $1::jsonb, updated_at = $2
         WHERE workspace_id = $3 AND id = $4
           AND status = 'REMOTE_APPLIED'
           AND remote_ref = $5
           AND remote_state = $6::jsonb
         RETURNING ${PUBLICATION_COLUMNS}`,
        [
          JSON.stringify(next),
          input.now,
          input.context.workspaceId,
          input.publicationId,
          input.expectedRemoteRef,
          JSON.stringify(expected),
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        const visible = await client.query(
          `SELECT id FROM publication_records WHERE workspace_id = $1 AND id = $2`,
          [input.context.workspaceId, input.publicationId],
        );
        return visible.rows[0] === undefined
          ? ({ outcome: 'NOT_FOUND' } as const)
          : ({ outcome: 'STALE' } as const);
      }
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'PUBLICATION_REMOTE_STATUS_REFRESHED', 'PUBLICATION', $5,
           'SUCCEEDED', jsonb_build_object(
             'remoteStatus', $6::text,
             'pullRequestNumber', $7::integer), $8)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.publicationId,
          next.status,
          next.number,
          input.now,
        ],
      );
      return { outcome: 'SUCCEEDED' as const, publication: mapPublication(row) };
    });
  }
}

function parseGitPullRequestState(
  value: unknown,
): (PublicationRemoteState & { status: GitPullRequestStatus; number: number }) | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, REMOTE_STATE_KEYS)) return null;
  const candidate = value;
  const status = candidate.status;
  const number = candidate.number;
  if (
    typeof status !== 'string' ||
    !['PR_OPENED', 'MERGED', 'CLOSED', 'FAILED'].includes(status) ||
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    candidate.isProductionLive !== false ||
    serializedLength(candidate) > 4_096
  ) {
    return null;
  }
  if (status === 'PR_OPENED') {
    const handle = candidate.rollbackHandle;
    if (
      !isPlainRecord(handle) ||
      !hasExactKeys(handle, ROLLBACK_HANDLE_KEYS) ||
      handle.operation !== 'CLOSE_PULL_REQUEST' ||
      typeof handle.repository !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(handle.repository) ||
      handle.pullRequestNumber !== number
    ) {
      return null;
    }
  } else if (candidate.rollbackHandle !== null) {
    return null;
  }
  return structuredClone(candidate) as unknown as PublicationRemoteState & {
    status: GitPullRequestStatus;
    number: number;
  };
}

const REMOTE_STATE_KEYS = ['status', 'number', 'isProductionLive', 'rollbackHandle'] as const;
const ROLLBACK_HANDLE_KEYS = ['operation', 'repository', 'pullRequestNumber'] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function serializedLength(value: Record<string, unknown>): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function statusTransitionAllowed(
  current: GitPullRequestStatus,
  next: GitPullRequestStatus,
): boolean {
  return current === 'PR_OPENED' || current === next;
}

function safeRemoteRef(value: string): boolean {
  if (!(
    value.length > 0 &&
    value.length <= 2_048 &&
    ![...value].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 0x1f || point === 0x7f);
    })
  )) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0
    );
  } catch {
    return false;
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
