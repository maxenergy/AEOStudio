import type {
  ManualMeasurementImportRecord,
  ManualMeasurementImportSlot,
  ManualMeasurementImportStore,
} from '@aeostudio/application/measurement';
import {
  manualImportSlotContentHash,
  manualMeasurementImportHash,
} from '@aeostudio/application/measurement';
import type { Pool, PoolClient } from 'pg';

import { TenantContextRunner } from '../tenant-context/tenant-context-runner.js';

interface ManualImportRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  schema_version: 'measurement-manual-import.v1';
  prompt_set_id: string;
  prompt_revision_id: string;
  prompt_content_hash: string;
  scenario_id: string;
  scenario_content_hash: string;
  provider_key: string;
  surface_key: string;
  adapter_version: string;
  acquisition_class: 'MANUAL_IMPORT';
  acquisition_method: 'MANUAL_IMPORT';
  status: ManualMeasurementImportRecord['status'];
  content_hash: string;
  expected_slot_count: number;
  provided_slot_count: number;
  cost_currency: string;
  submitted_by_user_id: string;
  submitted_at: Date;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
}

interface ManualImportSlotRow {
  prompt_id: string;
  scope: ManualMeasurementImportSlot['scope'];
  scope_key: string;
  repetition: number;
  provided: boolean;
  observed_at: Date | null;
  result: ManualMeasurementImportSlot['result'];
  raw_evidence_content_hash: string | null;
  content_hash: string;
}

const IMPORT_COLUMNS = `id, tenant_id, workspace_id, schema_version, prompt_set_id,
  prompt_revision_id, prompt_content_hash, scenario_id, scenario_content_hash, provider_key,
  surface_key, adapter_version, acquisition_class, acquisition_method, status, content_hash,
  expected_slot_count, provided_slot_count, cost_currency, submitted_by_user_id, submitted_at,
  reviewed_by_user_id, reviewed_at, review_note`;

const SLOT_COLUMNS = `prompt_id, scope, scope_key, repetition, provided, observed_at, result,
  raw_evidence_content_hash, content_hash`;

export class PostgresManualMeasurementImportStore implements ManualMeasurementImportStore {
  private readonly contexts: TenantContextRunner;

  constructor(private readonly pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  submit(input: Parameters<ManualMeasurementImportStore['submit']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const replay = await client.query<ManualImportRow>(
        `SELECT ${IMPORT_COLUMNS} FROM measurement_manual_imports
         WHERE workspace_id = $1 AND idempotency_key = $2`,
        [input.context.workspaceId, input.idempotencyKey],
      );
      const existing = replay.rows[0];
      if (existing !== undefined) {
        return existing.content_hash === input.manualImport.contentHash
          ? ({ outcome: 'SUCCEEDED', manualImport: mapImport(existing) } as const)
          : ({ outcome: 'IDEMPOTENCY_CONFLICT' } as const);
      }

      const record = input.manualImport;
      const inserted = await client.query<ManualImportRow>(
        `INSERT INTO measurement_manual_imports
          (id, tenant_id, workspace_id, schema_version, prompt_set_id, prompt_revision_id,
            prompt_content_hash, scenario_id, scenario_content_hash, provider_key, surface_key,
            adapter_version, acquisition_class, acquisition_method, status, content_hash,
            expected_slot_count, provided_slot_count, cost_currency, idempotency_key, submitted_by_user_id,
            submitted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           'SUBMITTED', $15, $16, $17, $18, $19, $20, $21)
         ON CONFLICT (tenant_id, workspace_id, idempotency_key) DO NOTHING
         RETURNING ${IMPORT_COLUMNS}`,
        [
          record.id,
          record.tenantId,
          record.workspaceId,
          record.schemaVersion,
          record.promptSetId,
          record.promptRevisionId,
          record.promptContentHash,
          record.scenarioId,
          record.scenarioContentHash,
          record.providerKey,
          record.surfaceKey,
          record.adapterVersion,
          record.acquisitionClass,
          record.acquisitionMethod,
          record.contentHash,
          record.expectedSlotCount,
          record.providedSlotCount,
          record.costCurrency,
          input.idempotencyKey,
          record.submittedByUserId,
          record.submittedAt,
        ],
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow === undefined) {
        const concurrent = await client.query<ManualImportRow>(
          `SELECT ${IMPORT_COLUMNS} FROM measurement_manual_imports
           WHERE workspace_id = $1 AND idempotency_key = $2`,
          [input.context.workspaceId, input.idempotencyKey],
        );
        const winner = concurrent.rows[0];
        return winner !== undefined && winner.content_hash === input.manualImport.contentHash
          ? ({ outcome: 'SUCCEEDED', manualImport: mapImport(winner) } as const)
          : ({ outcome: 'IDEMPOTENCY_CONFLICT' } as const);
      }
      await insertSlots(client, record, input.slots);
      const counts = await slotCounts(client, record.id);
      if (
        counts.total !== record.expectedSlotCount ||
        counts.provided !== record.providedSlotCount
      ) {
        throw new Error('MEASUREMENT_MANUAL_IMPORT_SLOT_COUNT_MISMATCH');
      }
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'MEASUREMENT_MANUAL_IMPORT_SUBMITTED',
           'MEASUREMENT_MANUAL_IMPORT', $5, 'SUCCEEDED',
           jsonb_build_object('contentHash', $6::text, 'expectedSlotCount', $7::integer,
             'providedSlotCount', $8::integer, 'scenarioId', $9::uuid), $10)`,
        [
          input.auditEventId,
          record.tenantId,
          record.workspaceId,
          record.submittedByUserId,
          record.id,
          record.contentHash,
          record.expectedSlotCount,
          record.providedSlotCount,
          record.scenarioId,
          record.submittedAt,
        ],
      );
      return { outcome: 'SUCCEEDED', manualImport: mapImport(insertedRow) } as const;
    });
  }

  find(input: Parameters<ManualMeasurementImportStore['find']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<ManualImportRow>(
        `SELECT ${IMPORT_COLUMNS} FROM measurement_manual_imports
         WHERE id = $1 AND workspace_id = $2`,
        [input.manualImportId, input.context.workspaceId],
      );
      return result.rows[0] === undefined ? null : mapImport(result.rows[0]);
    });
  }

  findWithSlots(input: Parameters<ManualMeasurementImportStore['findWithSlots']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const imported = await client.query<ManualImportRow>(
        `SELECT ${IMPORT_COLUMNS} FROM measurement_manual_imports
         WHERE id = $1 AND workspace_id = $2`,
        [input.manualImportId, input.context.workspaceId],
      );
      const row = imported.rows[0];
      if (row === undefined) return null;
      return {
        manualImport: mapImport(row),
        slots: await loadSlots(client, row.id, row.workspace_id),
      };
    });
  }

  review(input: Parameters<ManualMeasurementImportStore['review']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const locked = await client.query<ManualImportRow>(
        `SELECT ${IMPORT_COLUMNS} FROM measurement_manual_imports
         WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [input.manualImportId, input.context.workspaceId],
      );
      const current = locked.rows[0];
      if (current === undefined) return { outcome: 'NOT_FOUND' } as const;
      if (current.content_hash !== input.expectedContentHash) {
        return { outcome: 'HASH_MISMATCH' } as const;
      }
      if (current.submitted_by_user_id === input.context.actorUserId) {
        return { outcome: 'SELF_REVIEW' } as const;
      }
      if (current.status !== 'SUBMITTED') return { outcome: 'ALREADY_REVIEWED' } as const;
      const slots = await loadSlots(client, current.id, current.workspace_id);
      if (!importIntegrityValid(current, slots)) {
        return { outcome: 'INVALID_SLOT_SET' } as const;
      }
      const status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      const updated = await client.query<ManualImportRow>(
        `UPDATE measurement_manual_imports
         SET status = $3, reviewed_by_user_id = $4, reviewed_at = $5, review_note = $6
         WHERE id = $1 AND workspace_id = $2 AND status = 'SUBMITTED'
         RETURNING ${IMPORT_COLUMNS}`,
        [
          current.id,
          input.context.workspaceId,
          status,
          input.context.actorUserId,
          input.reviewedAt,
          input.note,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) return { outcome: 'ALREADY_REVIEWED' } as const;
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'MEASUREMENT_MANUAL_IMPORT_REVIEWED',
           'MEASUREMENT_MANUAL_IMPORT', $5, 'SUCCEEDED',
           jsonb_build_object('decision', $6::text, 'contentHash', $7::text), $8)`,
        [
          input.auditEventId,
          current.tenant_id,
          current.workspace_id,
          input.context.actorUserId,
          current.id,
          input.decision,
          current.content_hash,
          input.reviewedAt,
        ],
      );
      return { outcome: 'SUCCEEDED', manualImport: mapImport(row) } as const;
    });
  }

  readReviewedSlot(input: Parameters<ManualMeasurementImportStore['readReviewedSlot']>[0]) {
    return this.runAsActor(input, async (client) => {
      const imported = await client.query<ManualImportRow>(
        `SELECT ${IMPORT_COLUMNS} FROM measurement_manual_imports
         WHERE id = $1 AND workspace_id = $2 AND status = 'APPROVED'
           AND content_hash = $3`,
        [input.manualImportId, input.workspaceId, input.expectedContentHash],
      );
      const record = imported.rows[0];
      if (record === undefined) return { outcome: 'INVALID' } as const;
      const selected = await client.query<ManualImportSlotRow>(
        `SELECT ${SLOT_COLUMNS} FROM measurement_manual_import_slots
         WHERE manual_import_id = $1 AND workspace_id = $2 AND prompt_id = $3
           AND scope_key = $4 AND repetition = $5`,
        [input.manualImportId, input.workspaceId, input.promptId, input.scopeKey, input.repetition],
      );
      const row = selected.rows[0];
      if (row === undefined) {
        return { outcome: 'INVALID', costCurrency: record.cost_currency } as const;
      }
      const slot = mapSlot(row);
      if (!slotIntegrityValid(slot)) {
        return { outcome: 'INVALID', costCurrency: record.cost_currency } as const;
      }
      return slot.provided
        ? ({ outcome: 'FOUND', slot } as const)
        : ({ outcome: 'MISSING', costCurrency: record.cost_currency } as const);
    });
  }

  private async runAsActor<T>(
    input: { tenantId: string; workspaceId: string; actorId: string },
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.contexts.run(
      {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        actorUserId: input.actorId,
        membershipId: input.actorId,
        role: 'OWNER',
      },
      operation,
    );
  }
}

async function insertSlots(
  client: PoolClient,
  imported: ManualMeasurementImportRecord,
  slots: ManualMeasurementImportSlot[],
): Promise<void> {
  await client.query(
    `INSERT INTO measurement_manual_import_slots
      (tenant_id, workspace_id, manual_import_id, prompt_id, scope, scope_key, repetition,
        provided, observed_at, result, raw_evidence_content_hash, content_hash)
     SELECT $1, $2, $3, slot.prompt_id, slot.scope, slot.scope_key, slot.repetition,
       slot.provided, slot.observed_at, slot.result, slot.raw_evidence_content_hash,
       slot.content_hash
     FROM jsonb_to_recordset($4::jsonb) AS slot(
       prompt_id uuid, scope jsonb, scope_key text, repetition integer, provided boolean,
       observed_at timestamptz, result jsonb, raw_evidence_content_hash text, content_hash text
     )`,
    [
      imported.tenantId,
      imported.workspaceId,
      imported.id,
      JSON.stringify(
        slots.map((slot) => ({
          prompt_id: slot.promptId,
          scope: slot.scope,
          scope_key: slot.scopeKey,
          repetition: slot.repetition,
          provided: slot.provided,
          observed_at: slot.observedAt,
          result: slot.result,
          raw_evidence_content_hash: slot.rawEvidenceContentHash,
          content_hash: slot.contentHash,
        })),
      ),
    ],
  );
}

async function slotCounts(
  client: PoolClient,
  manualImportId: string,
): Promise<{ total: number; provided: number }> {
  const result = await client.query<{ total: number; provided: number }>(
    `SELECT count(*)::integer AS total,
       count(*) FILTER (WHERE provided)::integer AS provided
     FROM measurement_manual_import_slots WHERE manual_import_id = $1`,
    [manualImportId],
  );
  return result.rows[0] ?? { total: 0, provided: 0 };
}

async function loadSlots(
  client: PoolClient,
  manualImportId: string,
  workspaceId: string,
): Promise<ManualMeasurementImportSlot[]> {
  const result = await client.query<ManualImportSlotRow>(
    `SELECT ${SLOT_COLUMNS} FROM measurement_manual_import_slots
     WHERE manual_import_id = $1 AND workspace_id = $2
     ORDER BY scope_key, prompt_id, repetition`,
    [manualImportId, workspaceId],
  );
  return result.rows.map(mapSlot);
}

function importIntegrityValid(
  imported: ManualImportRow,
  slots: ManualMeasurementImportSlot[],
): boolean {
  if (
    slots.length !== imported.expected_slot_count ||
    slots.filter((slot) => slot.provided).length !== imported.provided_slot_count ||
    slots.some((slot) => !slotIntegrityValid(slot))
  ) {
    return false;
  }
  const contentHash = manualMeasurementImportHash({
    schemaVersion: imported.schema_version,
    promptSetId: imported.prompt_set_id,
    promptRevisionId: imported.prompt_revision_id,
    promptContentHash: imported.prompt_content_hash,
    scenarioId: imported.scenario_id,
    scenarioContentHash: imported.scenario_content_hash,
    providerKey: imported.provider_key,
    surfaceKey: imported.surface_key,
    adapterVersion: imported.adapter_version,
    acquisitionClass: imported.acquisition_class,
    acquisitionMethod: imported.acquisition_method,
    costCurrency: imported.cost_currency,
    slots,
  });
  return contentHash === imported.content_hash;
}

function slotIntegrityValid(slot: ManualMeasurementImportSlot): boolean {
  const { contentHash, ...withoutContentHash } = slot;
  if (manualImportSlotContentHash(withoutContentHash) !== contentHash) return false;
  if (!slot.provided) return slot.result === null && slot.rawEvidenceContentHash === null;
  return (
    slot.result !== null &&
    slot.rawEvidenceContentHash === manualMeasurementImportHash(slot.result.rawEvidence)
  );
}

function mapImport(row: ManualImportRow): ManualMeasurementImportRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    schemaVersion: row.schema_version,
    promptSetId: row.prompt_set_id,
    promptRevisionId: row.prompt_revision_id,
    promptContentHash: row.prompt_content_hash,
    scenarioId: row.scenario_id,
    scenarioContentHash: row.scenario_content_hash,
    providerKey: row.provider_key,
    surfaceKey: row.surface_key,
    adapterVersion: row.adapter_version,
    acquisitionClass: row.acquisition_class,
    acquisitionMethod: row.acquisition_method,
    status: row.status,
    contentHash: row.content_hash,
    expectedSlotCount: row.expected_slot_count,
    providedSlotCount: row.provided_slot_count,
    costCurrency: row.cost_currency,
    submittedByUserId: row.submitted_by_user_id,
    submittedAt: row.submitted_at.toISOString(),
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    reviewNote: row.review_note,
  };
}

function mapSlot(row: ManualImportSlotRow): ManualMeasurementImportSlot {
  return {
    promptId: row.prompt_id,
    scope: structuredClone(row.scope),
    scopeKey: row.scope_key,
    repetition: row.repetition,
    provided: row.provided,
    observedAt: row.observed_at?.toISOString() ?? null,
    result: structuredClone(row.result),
    rawEvidenceContentHash: row.raw_evidence_content_hash,
    contentHash: row.content_hash,
  };
}
