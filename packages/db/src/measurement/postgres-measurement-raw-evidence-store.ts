import { createHash } from 'node:crypto';

import type {
  MeasurementRawEvidenceStore,
  RawMeasurementEvidencePayload,
} from '@aeostudio/application/measurement';
import type { Pool, PoolClient } from 'pg';

interface RawEvidenceRow {
  object_ref: string;
  content_hash: string;
  payload: RawMeasurementEvidencePayload | null;
}

const STORAGE_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

export class PostgresMeasurementRawEvidenceStore implements MeasurementRawEvidenceStore {
  constructor(private readonly pool: Pool) {}

  put(input: Parameters<MeasurementRawEvidenceStore['put']>[0]) {
    return this.run(input.tenantId, input.workspaceId, input.promptRunId, async (client) => {
      if (input.lease === null) return { outcome: 'LEASE_LOST' as const };
      const activeLease = await client.query(
        `SELECT run.id
         FROM measurement_runs run
         JOIN jobs job
           ON job.id = run.job_id
          AND job.tenant_id = run.tenant_id
          AND job.workspace_id = run.workspace_id
          AND job.job_type = 'MEASUREMENT'
          AND job.aggregate_id = run.id
         WHERE run.id = $1 AND run.tenant_id = $2 AND run.workspace_id = $3
           AND run.status = 'RUNNING'
           AND job.id = $4 AND job.status = 'RUNNING' AND job.lease_token = $5
           AND job.lease_expires_at >= clock_timestamp()
         FOR UPDATE OF run, job`,
        [
          input.measurementRunId,
          input.tenantId,
          input.workspaceId,
          input.lease.jobId,
          input.lease.leaseToken,
        ],
      );
      if (activeLease.rows[0] === undefined) return { outcome: 'LEASE_LOST' as const };
      const payload = structuredClone(input.payload);
      const contentHash = payloadHash(payload);
      const objectRef =
        `postgresql+measurement-evidence://${input.tenantId}/${input.workspaceId}/` +
        `${input.measurementRunId}/${input.promptRunId}`;
      await client.query(
        `INSERT INTO raw_evidence_refs
            (id, tenant_id, workspace_id, measurement_run_id, object_ref, content_hash,
              payload, created_at)
           SELECT $1, run.tenant_id, run.workspace_id, run.id, $5, $6, $7::jsonb, now()
           FROM measurement_runs run
           WHERE run.id = $4 AND run.tenant_id = $2 AND run.workspace_id = $3
           ON CONFLICT (id) DO NOTHING`,
        [
          input.promptRunId,
          input.tenantId,
          input.workspaceId,
          input.measurementRunId,
          objectRef,
          contentHash,
          JSON.stringify(payload),
        ],
      );
      const stored = await client.query<RawEvidenceRow>(
        `SELECT object_ref, content_hash, payload
           FROM raw_evidence_refs
           WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3
             AND measurement_run_id = $4`,
        [input.promptRunId, input.tenantId, input.workspaceId, input.measurementRunId],
      );
      const row = stored.rows[0];
      if (
        row === undefined ||
        row.object_ref !== objectRef ||
        row.content_hash !== contentHash ||
        row.payload === null ||
        payloadHash(row.payload) !== contentHash
      ) {
        throw new Error('MEASUREMENT_RAW_EVIDENCE_PERSISTENCE_CONFLICT');
      }
      return {
        outcome: 'SUCCEEDED' as const,
        reference: { objectRef, contentHash },
      };
    });
  }

  get(input: Parameters<MeasurementRawEvidenceStore['get']>[0]) {
    return this.run(input.tenantId, input.workspaceId, STORAGE_ACTOR_ID, async (client) => {
      const stored = await client.query<RawEvidenceRow>(
        `SELECT object_ref, content_hash, payload
         FROM raw_evidence_refs
         WHERE tenant_id = $1 AND workspace_id = $2 AND object_ref = $3
           AND content_hash = $4`,
        [input.tenantId, input.workspaceId, input.objectRef, input.contentHash],
      );
      const payload = stored.rows[0]?.payload;
      return payload === undefined || payload === null || payloadHash(payload) !== input.contentHash
        ? null
        : structuredClone(payload);
    });
  }

  private async run<T>(
    tenantId: string,
    workspaceId: string,
    actorId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE aeostudio_runtime');
      await client.query(
        `SELECT
          set_config('app.tenant_id', $1, true),
          set_config('app.workspace_id', $2, true),
          set_config('app.actor_id', $3, true)`,
        [tenantId, workspaceId, actorId],
      );
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function payloadHash(payload: RawMeasurementEvidencePayload): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
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
