import type {
  StoredWorkloadObjectVersion,
  WorkloadObjectWriteIntentStore,
  WorkloadObjectWriteIntentWork,
  WorkloadObjectWriteKind,
} from '@aeostudio/application/privacy-audit';
import type { Pool } from 'pg';

interface WorkloadIntentRow {
  status: 'PENDING' | 'READY';
  operation_id: string;
  kind: WorkloadObjectWriteKind;
  tenant_id: string;
  workspace_id: string;
  object_key: string;
  checksum: string;
  content_type: string;
  byte_length: number | string;
  object_ref: string | null;
  object_version_id: string | null;
  object_created_at: Date | null;
}

interface WorkloadClaimRow {
  operation_id: string;
  kind: WorkloadObjectWriteKind;
  tenant_id: string;
  workspace_id: string;
  object_key: string;
  checksum: string;
  content_type: string;
  byte_length: number | string;
  lease_token: string;
  lease_expires_at: Date;
}

export class PostgresWorkloadObjectWriteIntentStore implements WorkloadObjectWriteIntentStore {
  public constructor(private readonly pool: Pool) {}

  public async reserveWorkloadObjectWriteIntent(
    input: Parameters<WorkloadObjectWriteIntentStore['reserveWorkloadObjectWriteIntent']>[0],
  ): ReturnType<WorkloadObjectWriteIntentStore['reserveWorkloadObjectWriteIntent']> {
    const result = await this.pool.query<WorkloadIntentRow>(
      `SELECT * FROM reserve_workload_object_write_intent(
         $1, $2, $3, $4, $5, $6, $7, $8
       )`,
      [
        input.operationId,
        input.tenantId,
        input.workspaceId,
        input.kind,
        input.objectKey,
        input.checksum,
        input.contentType,
        input.byteLength,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('WORKLOAD_OBJECT_WRITE_RESERVATION_NOT_RETURNED');
    if (row.status === 'PENDING') return { outcome: 'PENDING', operationId: row.operation_id };
    return { outcome: 'READY', operationId: row.operation_id, object: mapStoredObject(row) };
  }

  public async claimWorkloadObjectWriteIntent(
    input: Parameters<WorkloadObjectWriteIntentStore['claimWorkloadObjectWriteIntent']>[0],
  ): ReturnType<WorkloadObjectWriteIntentStore['claimWorkloadObjectWriteIntent']> {
    const result = await this.pool.query<{ claimed: boolean }>(
      `SELECT claim_workload_object_write_intent($1, $2, $3) AS claimed`,
      [input.operationId, input.tenantId, input.leaseToken],
    );
    return result.rows[0]?.claimed === true;
  }

  public async claimPendingWorkloadObjectWriteIntents(
    input: Parameters<WorkloadObjectWriteIntentStore['claimPendingWorkloadObjectWriteIntents']>[0],
  ): ReturnType<WorkloadObjectWriteIntentStore['claimPendingWorkloadObjectWriteIntents']> {
    const result = await this.pool.query<WorkloadClaimRow>(
      `SELECT * FROM claim_pending_workload_object_write_intents($1, $2)`,
      [input.leaseToken, input.limit],
    );
    return result.rows.map(mapClaim);
  }

  public async completeWorkloadObjectWriteIntent(
    input: Parameters<WorkloadObjectWriteIntentStore['completeWorkloadObjectWriteIntent']>[0],
  ): ReturnType<WorkloadObjectWriteIntentStore['completeWorkloadObjectWriteIntent']> {
    const object = input.object;
    const result = await this.pool.query<{ completed: boolean }>(
      `SELECT complete_workload_object_write_intent(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
       ) AS completed`,
      [
        input.operationId,
        input.leaseToken,
        object.kind,
        object.tenantId,
        object.workspaceId,
        object.objectRef,
        object.objectKey,
        object.objectVersionId,
        object.checksum,
        object.contentType,
        object.byteLength,
        new Date(object.createdAt),
      ],
    );
    return result.rows[0]?.completed === true;
  }

  public async releaseWorkloadObjectWriteIntentLease(
    input: Parameters<WorkloadObjectWriteIntentStore['releaseWorkloadObjectWriteIntentLease']>[0],
  ): ReturnType<WorkloadObjectWriteIntentStore['releaseWorkloadObjectWriteIntentLease']> {
    const retryDelayMs = input.retryDelayMs ?? 0;
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 300_000) {
      throw new Error('WORKLOAD_OBJECT_WRITE_RETRY_DELAY_INVALID');
    }
    const retryDelaySeconds = Math.ceil(retryDelayMs / 1_000);
    const result = await this.pool.query<{ released: boolean }>(
      `SELECT release_workload_object_write_intent_lease($1, $2, NULL, $3) AS released`,
      [input.operationId, input.leaseToken, retryDelaySeconds],
    );
    return result.rows[0]?.released === true;
  }
}

function mapStoredObject(row: WorkloadIntentRow): StoredWorkloadObjectVersion {
  if (
    row.object_ref === null ||
    row.object_version_id === null ||
    !(row.object_created_at instanceof Date)
  ) {
    throw new Error('WORKLOAD_OBJECT_WRITE_READY_METADATA_INVALID');
  }
  return {
    kind: row.kind,
    objectClass: row.kind,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    objectRef: row.object_ref,
    objectKey: row.object_key,
    objectVersionId: row.object_version_id,
    checksum: row.checksum,
    contentType: row.content_type,
    byteLength: toSafeInteger(row.byte_length),
    createdAt: row.object_created_at.toISOString(),
  };
}

function mapClaim(row: WorkloadClaimRow): WorkloadObjectWriteIntentWork {
  return {
    operationId: row.operation_id,
    kind: row.kind,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    objectKey: row.object_key,
    checksum: row.checksum,
    contentType: row.content_type,
    byteLength: toSafeInteger(row.byte_length),
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
  };
}

function toSafeInteger(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('WORKLOAD_OBJECT_WRITE_BYTE_LENGTH_INVALID');
  }
  return parsed;
}
