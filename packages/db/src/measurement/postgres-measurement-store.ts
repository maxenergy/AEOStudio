import type {
  MeasurementProviderPolicyRecord,
  MeasurementRunRecord,
  MeasurementStore,
  PromptRunRecord,
  StoredMetricObservation,
  StoredMetricSnapshot,
} from '@aeostudio/application/measurement';
import { measurementScopeKey } from '@aeostudio/application/measurement';
import {
  metricValueFromCounts,
  type MetricClassification,
  type MetricCohort,
} from '@aeostudio/domain/measurement';
import type { Pool, PoolClient } from 'pg';

import { TenantContextRunner } from '../tenant-context/tenant-context-runner.js';

interface MeasurementRunRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  prompt_set_id: string;
  prompt_revision_id: string;
  prompt_content_hash: string;
  scenario_id: string;
  scenario_version: number;
  scenario_content_hash: string;
  manual_import_id: string | null;
  manual_import_content_hash: string | null;
  job_id: string | null;
  kind: 'BASELINE' | 'REMEASUREMENT';
  status: MeasurementRunRecord['status'];
  expected_prompt_run_count: number;
  completed_prompt_run_count: number;
  provider_key: string;
  surface_key: string;
  model: string;
  model_version: string;
  acquisition_class: MeasurementRunRecord['acquisitionClass'];
  acquisition_method: string;
  adapter_version: string;
  scenario_snapshot: MeasurementRunRecord['scenarioSnapshot'];
  prompt_snapshot: { id: string; ordinal: number; text: string }[];
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

interface PromptRunRow {
  id: string;
  measurement_run_id: string;
  prompt_id: string;
  prompt_ordinal: number;
  repetition: number;
  scope_key: string;
  status: PromptRunRecord['status'];
  provider_key: string;
  surface_key: string;
  model: string;
  model_version: string;
  scenario_id: string;
  scenario_version: number;
  acquisition_class: PromptRunRecord['acquisitionClass'];
  acquisition_method: string;
  adapter_key: string;
  adapter_version: string;
  method_version: string;
  observation: PromptRunRecord['observation'];
  cost_amount: string;
  cost_currency: string;
  policy_reason: string | null;
  observed_at: Date;
  object_ref?: string | null;
  content_hash?: string | null;
}

interface PolicyRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  provider_key: string;
  surface_key: string;
  adapter_version: string;
  terms_version: string;
  terms_approved: boolean;
  authorization_approved: boolean;
  cross_border_approved: boolean;
  purpose: string;
  policy_version: string;
  approved_by_user_id: string;
  approved_at: Date;
}

interface SnapshotRow {
  id: string;
  measurement_run_id: string;
  metric_key: StoredMetricSnapshot['metricKey'];
  method_version: string;
  cohort: MetricCohort;
  numerator: number;
  eligible_denominator: number;
  value: string | null;
  excluded_counts: StoredMetricSnapshot['excludedCounts'];
  source_observation_ids: string[];
  source_hash: string;
  content_hash: string;
}

interface ObservationRow {
  id: string;
  prompt_run_id: string;
  metric_key: StoredMetricObservation['metricKey'];
  classification: MetricClassification;
  cohort: MetricCohort;
}

class MeasurementPersistenceLeaseLostError extends Error {}

const RUN_COLUMNS = `id, tenant_id, workspace_id, prompt_set_id, prompt_revision_id,
  prompt_content_hash, scenario_id, scenario_version, scenario_content_hash,
  manual_import_id, manual_import_content_hash,
  job_id, kind, status, expected_prompt_run_count,
  completed_prompt_run_count, provider_key, surface_key, model, model_version,
  acquisition_class, acquisition_method, adapter_version, scenario_snapshot, prompt_snapshot,
  created_at, started_at, completed_at`;

const PROMPT_RUN_COLUMNS = `id, measurement_run_id, prompt_id, prompt_ordinal, repetition,
  scope_key, status, provider_key, surface_key, model, model_version, scenario_id,
  scenario_version, acquisition_class, acquisition_method, adapter_key, adapter_version,
  method_version, observation, cost_amount::text, cost_currency, policy_reason, observed_at`;

const PROMPT_RUN_JOIN_COLUMNS = `prompt_run.id, prompt_run.measurement_run_id,
  prompt_run.prompt_id, prompt_run.prompt_ordinal, prompt_run.repetition, prompt_run.scope_key,
  prompt_run.status, prompt_run.provider_key, prompt_run.surface_key, prompt_run.model,
  prompt_run.model_version, prompt_run.scenario_id, prompt_run.scenario_version,
  prompt_run.acquisition_class, prompt_run.acquisition_method, prompt_run.adapter_key,
  prompt_run.adapter_version, prompt_run.method_version, prompt_run.observation,
  prompt_run.cost_amount::text, prompt_run.cost_currency, prompt_run.policy_reason,
  prompt_run.observed_at`;

export class PostgresMeasurementStore implements MeasurementStore {
  private readonly contexts: TenantContextRunner;

  constructor(private readonly pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  prepareRun(input: Parameters<MeasurementStore['prepareRun']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const source = input.approvedSource;
      const existing = await client.query<MeasurementRunRow>(
        `SELECT ${RUN_COLUMNS} FROM measurement_runs
         WHERE workspace_id = $1 AND idempotency_key = $2`,
        [input.context.workspaceId, input.idempotencyKey],
      );
      const existingRun = existing.rows[0];
      if (existingRun !== undefined) {
        return runMatchesIdempotentRequest(existingRun, source, input.kind)
          ? this.mapRun(existingRun)
          : null;
      }

      const expected =
        source.prompts.length *
        source.scenarioSnapshot.scopes.length *
        source.scenarioSnapshot.repetitions;
      if (expected !== source.expectedPromptRunCount) {
        throw new Error('MEASUREMENT_EXPECTED_COUNT_MISMATCH');
      }
      const approved = await client.query<{
        adapter_version: string;
        acquisition_class: MeasurementRunRecord['acquisitionClass'];
        acquisition_method: string;
        status: 'AVAILABLE' | 'UNAVAILABLE';
      }>(
        `SELECT registry.adapter_version, registry.acquisition_class,
           registry.acquisition_method, registry.status
         FROM prompt_sets prompt_set
         JOIN prompt_revisions revision
           ON revision.prompt_set_id = prompt_set.id AND revision.tenant_id = prompt_set.tenant_id
         JOIN measurement_scenarios scenario
           ON scenario.prompt_revision_id = revision.id AND scenario.tenant_id = revision.tenant_id
         JOIN prompt_approvals approval
           ON approval.prompt_revision_id = revision.id AND approval.scenario_id = scenario.id
             AND approval.tenant_id = revision.tenant_id
         JOIN provider_surface_registry registry
           ON registry.provider_key = scenario.provider_key
             AND registry.surface_key = scenario.surface_key
         WHERE prompt_set.id = $1 AND revision.id = $2 AND scenario.id = $3
           AND revision.workspace_id = $4 AND revision.status = 'APPROVED'
           AND revision.content_hash = $5 AND scenario.content_hash = $6
           AND approval.prompt_content_hash = revision.content_hash
           AND approval.scenario_content_hash = scenario.content_hash`,
        [
          source.promptSetId,
          source.promptRevisionId,
          source.scenarioSnapshot.id,
          input.context.workspaceId,
          source.promptContentHash,
          source.scenarioContentHash,
        ],
      );
      if (
        approved.rows[0] === undefined ||
        approved.rows[0].adapter_version !== source.adapterVersion ||
        approved.rows[0].acquisition_class !== source.scenarioSnapshot.acquisitionClass ||
        approved.rows[0].acquisition_method !== source.scenarioSnapshot.acquisitionMethod ||
        approved.rows[0].status !== source.scenarioSnapshot.registryStatus
      ) {
        return null;
      }
      const snapshot = source.scenarioSnapshot;
      if (snapshot.manualImport !== null) {
        const approvedImport = await client.query<{ id: string }>(
          `SELECT id FROM measurement_manual_imports
           WHERE id = $1 AND workspace_id = $2 AND status = 'APPROVED'
             AND content_hash = $3 AND prompt_set_id = $4 AND prompt_revision_id = $5
             AND prompt_content_hash = $6 AND scenario_id = $7 AND scenario_content_hash = $8
             AND provider_key = $9 AND surface_key = $10 AND adapter_version = $11
             AND expected_slot_count = $12`,
          [
            snapshot.manualImport.id,
            input.context.workspaceId,
            snapshot.manualImport.contentHash,
            source.promptSetId,
            source.promptRevisionId,
            source.promptContentHash,
            snapshot.id,
            source.scenarioContentHash,
            snapshot.providerKey,
            snapshot.surfaceKey,
            source.adapterVersion,
            expected,
          ],
        );
        if (approvedImport.rows[0] === undefined) return null;
      }
      const inserted = await client.query<MeasurementRunRow>(
        `INSERT INTO measurement_runs
          (id, tenant_id, workspace_id, prompt_set_id, prompt_revision_id,
            prompt_content_hash, scenario_id, scenario_version, scenario_content_hash,
            manual_import_id, manual_import_content_hash,
            kind, status, expected_prompt_run_count, provider_key, surface_key, model,
            model_version, acquisition_class, acquisition_method, adapter_version, scenario_snapshot,
            prompt_snapshot, idempotency_key, requested_by_user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'QUEUED', $13,
           $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22::jsonb, $23, $24, $25)
         ON CONFLICT (tenant_id, workspace_id, idempotency_key) DO NOTHING
         RETURNING ${RUN_COLUMNS}`,
        [
          input.measurementRunId,
          input.context.tenantId,
          input.context.workspaceId,
          source.promptSetId,
          source.promptRevisionId,
          source.promptContentHash,
          snapshot.id,
          snapshot.version,
          source.scenarioContentHash,
          snapshot.manualImport?.id ?? null,
          snapshot.manualImport?.contentHash ?? null,
          input.kind,
          expected,
          snapshot.providerKey,
          snapshot.surfaceKey,
          snapshot.model,
          snapshot.modelVersion,
          snapshot.acquisitionClass,
          snapshot.acquisitionMethod,
          source.adapterVersion,
          JSON.stringify(snapshot),
          JSON.stringify(source.prompts),
          input.idempotencyKey,
          input.context.actorUserId,
          input.createdAt,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        const winner = await client.query<MeasurementRunRow>(
          `SELECT ${RUN_COLUMNS} FROM measurement_runs
           WHERE workspace_id = $1 AND idempotency_key = $2`,
          [input.context.workspaceId, input.idempotencyKey],
        );
        const winnerRun = winner.rows[0];
        return winnerRun !== undefined && runMatchesIdempotentRequest(winnerRun, source, input.kind)
          ? this.mapRun(winnerRun)
          : null;
      }
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'MEASUREMENT_RUN_QUEUED', 'MEASUREMENT_RUN', $5,
           'SUCCEEDED', jsonb_build_object(
             'promptRevisionId', $6::uuid, 'scenarioId', $7::uuid,
             'promptHash', $8::text, 'scenarioHash', $9::text,
             'expectedPromptRunCount', $10::integer), $11)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.measurementRunId,
          source.promptRevisionId,
          snapshot.id,
          source.promptContentHash,
          source.scenarioContentHash,
          expected,
          input.createdAt,
        ],
      );
      return this.mapRun(row);
    });
  }

  bindJob(input: Parameters<MeasurementStore['bindJob']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<MeasurementRunRow>(
        `UPDATE measurement_runs SET job_id = $1
         WHERE id = $2 AND workspace_id = $3 AND job_id IS NULL AND status = 'QUEUED'
         RETURNING ${RUN_COLUMNS}`,
        [input.jobId, input.measurementRunId, input.context.workspaceId],
      );
      if (result.rows[0] !== undefined) return this.mapRun(result.rows[0]);
      const existing = await client.query<MeasurementRunRow>(
        `SELECT ${RUN_COLUMNS} FROM measurement_runs
         WHERE id = $1 AND workspace_id = $2 AND job_id = $3`,
        [input.measurementRunId, input.context.workspaceId, input.jobId],
      );
      return existing.rows[0] === undefined ? null : this.mapRun(existing.rows[0]);
    });
  }

  setProviderPolicy(input: Parameters<MeasurementStore['setProviderPolicy']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<PolicyRow>(
        `INSERT INTO measurement_provider_policies
          (id, tenant_id, workspace_id, provider_key, surface_key, adapter_version,
            terms_version, terms_approved, authorization_approved, cross_border_approved,
            purpose, policy_version, approved_by_user_id, approved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (tenant_id, workspace_id, provider_key, surface_key) DO UPDATE SET
           adapter_version = EXCLUDED.adapter_version,
           terms_version = EXCLUDED.terms_version,
           terms_approved = EXCLUDED.terms_approved,
           authorization_approved = EXCLUDED.authorization_approved,
           cross_border_approved = EXCLUDED.cross_border_approved,
           purpose = EXCLUDED.purpose,
           policy_version = EXCLUDED.policy_version,
           approved_by_user_id = EXCLUDED.approved_by_user_id,
           approved_at = EXCLUDED.approved_at
         RETURNING id, tenant_id, workspace_id, provider_key, surface_key, adapter_version,
           terms_version, terms_approved, authorization_approved, cross_border_approved,
           purpose, policy_version, approved_by_user_id, approved_at`,
        [
          input.policyId,
          input.context.tenantId,
          input.context.workspaceId,
          input.providerKey,
          input.surfaceKey,
          input.adapterVersion,
          input.termsVersion,
          input.termsApproved,
          input.authorizationApproved,
          input.crossBorderApproved,
          input.purpose,
          input.policyVersion,
          input.context.actorUserId,
          input.approvedAt,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('MEASUREMENT_POLICY_INSERT_FAILED');
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'MEASUREMENT_PROVIDER_POLICY_SET',
           'MEASUREMENT_PROVIDER_POLICY', $5, 'SUCCEEDED',
           jsonb_build_object('providerKey', $6::text, 'surfaceKey', $7::text,
             'adapterVersion', $8::text, 'policyVersion', $9::text,
             'termsApproved', $10::boolean, 'authorizationApproved', $11::boolean,
             'crossBorderApproved', $12::boolean), $13)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          row.id,
          input.providerKey,
          input.surfaceKey,
          input.adapterVersion,
          input.policyVersion,
          input.termsApproved,
          input.authorizationApproved,
          input.crossBorderApproved,
          input.approvedAt,
        ],
      );
      return this.mapPolicy(row);
    });
  }

  findProviderPolicy(input: Parameters<MeasurementStore['findProviderPolicy']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<PolicyRow>(
        `SELECT id, tenant_id, workspace_id, provider_key, surface_key, adapter_version,
           terms_version, terms_approved, authorization_approved, cross_border_approved,
           purpose, policy_version, approved_by_user_id, approved_at
         FROM measurement_provider_policies
         WHERE workspace_id = $1 AND provider_key = $2 AND surface_key = $3`,
        [input.context.workspaceId, input.providerKey, input.surfaceKey],
      );
      return result.rows[0] === undefined ? null : this.mapPolicy(result.rows[0]);
    });
  }

  findRun(input: Parameters<MeasurementStore['findRun']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<MeasurementRunRow>(
        `SELECT ${RUN_COLUMNS} FROM measurement_runs WHERE id = $1 AND workspace_id = $2`,
        [input.measurementRunId, input.context.workspaceId],
      );
      return result.rows[0] === undefined ? null : this.mapRun(result.rows[0]);
    });
  }

  listPromptRuns(input: Parameters<MeasurementStore['listPromptRuns']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const run = await client.query<{ id: string }>(
        'SELECT id FROM measurement_runs WHERE id = $1 AND workspace_id = $2',
        [input.measurementRunId, input.context.workspaceId],
      );
      if (run.rows[0] === undefined) return null;
      const [rows, count] = await Promise.all([
        client.query<PromptRunRow>(
          `SELECT ${PROMPT_RUN_COLUMNS} FROM prompt_runs
           WHERE measurement_run_id = $1 AND workspace_id = $2
             AND ($3::text IS NULL OR scope_key = $3)
             AND (
               $4::text IS NULL OR $4 = 'COST' OR ($4 = 'ERROR' AND status = 'ERROR')
               OR ($4 IN ('MENTION_RATE', 'CITATION_RATE', 'ACCURACY_RATE', 'COVERAGE_RATE')
                 AND EXISTS (
                   SELECT 1 FROM metric_observations source
                   WHERE source.measurement_run_id = prompt_runs.measurement_run_id
                     AND source.prompt_run_id = prompt_runs.id AND source.metric_key = $4
                 ))
             )
           ORDER BY prompt_ordinal, scope_key, repetition, id LIMIT $5 OFFSET $6`,
          [
            input.measurementRunId,
            input.context.workspaceId,
            input.scopeKey ?? null,
            input.dimension ?? null,
            input.limit,
            input.offset,
          ],
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM prompt_runs
           WHERE measurement_run_id = $1 AND workspace_id = $2
             AND ($3::text IS NULL OR scope_key = $3)
             AND (
               $4::text IS NULL OR $4 = 'COST' OR ($4 = 'ERROR' AND status = 'ERROR')
               OR ($4 IN ('MENTION_RATE', 'CITATION_RATE', 'ACCURACY_RATE', 'COVERAGE_RATE')
                 AND EXISTS (
                   SELECT 1 FROM metric_observations source
                   WHERE source.measurement_run_id = prompt_runs.measurement_run_id
                     AND source.prompt_run_id = prompt_runs.id AND source.metric_key = $4
                 ))
             )`,
          [
            input.measurementRunId,
            input.context.workspaceId,
            input.scopeKey ?? null,
            input.dimension ?? null,
          ],
        ),
      ]);
      return {
        promptRuns: rows.rows.map((row) => this.mapPromptRun(row)),
        total: Number(count.rows[0]?.count ?? 0),
      };
    });
  }

  findPromptRun(input: Parameters<MeasurementStore['findPromptRun']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<PromptRunRow>(
        `SELECT ${PROMPT_RUN_JOIN_COLUMNS}, evidence.object_ref, evidence.content_hash
         FROM prompt_runs prompt_run
         LEFT JOIN raw_evidence_refs evidence ON evidence.id = prompt_run.raw_evidence_ref_id
           AND evidence.measurement_run_id = prompt_run.measurement_run_id
         WHERE prompt_run.id = $1 AND prompt_run.measurement_run_id = $2
           AND prompt_run.workspace_id = $3`,
        [input.promptRunId, input.measurementRunId, input.context.workspaceId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        promptRun: this.mapPromptRun(row),
        rawEvidenceRef:
          row.object_ref === null || row.object_ref === undefined || row.content_hash == null
            ? null
            : { objectRef: row.object_ref, contentHash: row.content_hash },
      };
    });
  }

  loadDashboard(input: Parameters<MeasurementStore['loadDashboard']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const run = await this.findRunWithClient(
        client,
        input.measurementRunId,
        input.context.workspaceId,
      );
      if (run === null) return null;
      const promptRuns = await client.query<PromptRunRow>(
        `SELECT ${PROMPT_RUN_COLUMNS} FROM prompt_runs
         WHERE measurement_run_id = $1 AND workspace_id = $2
         ORDER BY prompt_ordinal, scope_key, repetition`,
        [input.measurementRunId, input.context.workspaceId],
      );
      const snapshots = await client.query<SnapshotRow>(
        `SELECT id, measurement_run_id, metric_key, method_version, cohort, numerator,
           eligible_denominator, value::text, excluded_counts, source_observation_ids,
           source_hash, content_hash
         FROM metric_snapshots WHERE measurement_run_id = $1 AND workspace_id = $2
         ORDER BY scope_key, metric_key`,
        [input.measurementRunId, input.context.workspaceId],
      );
      return {
        run,
        promptRuns: promptRuns.rows.map((row) => this.mapPromptRun(row)),
        snapshots: snapshots.rows.map((row) => this.mapSnapshot(row)),
      };
    });
  }

  loadExecutionPlan(input: Parameters<MeasurementStore['loadExecutionPlan']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const runResult = await client.query<MeasurementRunRow>(
        `SELECT ${RUN_COLUMNS} FROM measurement_runs
         WHERE id = $1 AND workspace_id = $2 AND job_id IS NOT NULL`,
        [input.measurementRunId, input.context.workspaceId],
      );
      const row = runResult.rows[0];
      if (row === undefined) return null;
      const run = this.mapRun(row);
      const policy = await client.query<PolicyRow>(
        `SELECT id, tenant_id, workspace_id, provider_key, surface_key, adapter_version,
           terms_version, terms_approved, authorization_approved, cross_border_approved,
           purpose, policy_version, approved_by_user_id, approved_at
         FROM measurement_provider_policies
         WHERE workspace_id = $1 AND provider_key = $2 AND surface_key = $3`,
        [input.context.workspaceId, run.providerKey, run.surfaceKey],
      );
      const promptRuns = await client.query<PromptRunRow>(
        `SELECT ${PROMPT_RUN_COLUMNS} FROM prompt_runs
         WHERE measurement_run_id = $1 AND workspace_id = $2
         ORDER BY prompt_ordinal, scope_key, repetition`,
        [input.measurementRunId, input.context.workspaceId],
      );
      const observations = await client.query<ObservationRow>(
        `SELECT id, prompt_run_id, metric_key, classification, cohort
         FROM metric_observations
         WHERE measurement_run_id = $1 AND workspace_id = $2
         ORDER BY prompt_run_id, metric_key`,
        [input.measurementRunId, input.context.workspaceId],
      );
      const observationsByPromptRun = new Map<string, ObservationRow[]>();
      for (const observation of observations.rows) {
        const grouped = observationsByPromptRun.get(observation.prompt_run_id) ?? [];
        grouped.push(observation);
        observationsByPromptRun.set(observation.prompt_run_id, grouped);
      }
      const snapshotCount = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM metric_snapshots
         WHERE measurement_run_id = $1 AND workspace_id = $2`,
        [input.measurementRunId, input.context.workspaceId],
      );
      return {
        run,
        prompts: structuredClone(row.prompt_snapshot),
        scopes: structuredClone(run.scenarioSnapshot.scopes),
        policy: policy.rows[0] === undefined ? null : this.mapPolicy(policy.rows[0]),
        completedSlots: promptRuns.rows.map((promptRunRow) => ({
          promptRun: this.mapPromptRun(promptRunRow),
          observations: (observationsByPromptRun.get(promptRunRow.id) ?? []).map((observation) => ({
            id: observation.id,
            promptRunId: observation.prompt_run_id,
            metricKey: observation.metric_key,
            classification: observation.classification,
            cohort: observation.cohort,
          })),
        })),
        snapshotCount: Number(snapshotCount.rows[0]?.count ?? 0),
      };
    });
  }

  markRunning(input: Parameters<MeasurementStore['markRunning']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      if (input.lease === null) return 'LEASE_LOST' as const;
      const current = await client.query<{ status: MeasurementRunRecord['status'] }>(
        `SELECT run.status
         FROM measurement_runs run
         JOIN jobs job
           ON job.id = run.job_id
          AND job.tenant_id = run.tenant_id
          AND job.workspace_id = run.workspace_id
          AND job.job_type = 'MEASUREMENT'
          AND job.aggregate_id = run.id
         WHERE run.id = $1 AND run.tenant_id = $2 AND run.workspace_id = $3
           AND job.id = $4 AND job.status = 'RUNNING' AND job.lease_token = $5
           AND job.lease_expires_at >= clock_timestamp()
         FOR UPDATE OF run, job`,
        [
          input.measurementRunId,
          input.context.tenantId,
          input.context.workspaceId,
          input.lease.jobId,
          input.lease.leaseToken,
        ],
      );
      if (current.rows[0] === undefined) return 'LEASE_LOST' as const;
      if (current.rows[0].status === 'RUNNING') return 'SUCCEEDED' as const;
      if (current.rows[0].status !== 'QUEUED') return 'CONFLICT' as const;
      const result = await client.query(
        `UPDATE measurement_runs SET status = 'RUNNING', started_at = $1
         WHERE id = $2 AND tenant_id = $3 AND workspace_id = $4 AND status = 'QUEUED'
           AND job_id = $5
         RETURNING id`,
        [
          input.startedAt,
          input.measurementRunId,
          input.context.tenantId,
          input.context.workspaceId,
          input.lease.jobId,
        ],
      );
      return result.rowCount === 1 ? ('SUCCEEDED' as const) : ('CONFLICT' as const);
    });
  }

  async recordPromptRun(input: Parameters<MeasurementStore['recordPromptRun']>[0]) {
    try {
      return await this.contexts.run(input.context, async (client) => {
        if (input.lease === null) return 'LEASE_LOST' as const;
        const lockedRun = await client.query<{ id: string }>(
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
            input.promptRun.measurementRunId,
            input.context.tenantId,
            input.context.workspaceId,
            input.lease.jobId,
            input.lease.leaseToken,
          ],
        );
        if (lockedRun.rows[0] === undefined) return 'LEASE_LOST' as const;
        const duplicate = await client.query<{ id: string }>(
          `SELECT id FROM prompt_runs
         WHERE measurement_run_id = $1 AND prompt_id = $2 AND scope_key = $3
           AND repetition = $4 AND workspace_id = $5`,
          [
            input.promptRun.measurementRunId,
            input.promptRun.promptId,
            input.promptRun.scopeKey,
            input.promptRun.repetition,
            input.context.workspaceId,
          ],
        );
        if (duplicate.rows[0] !== undefined) return 'CONFLICT' as const;
        if (input.rawEvidenceRef !== null) {
          await client.query(
            `INSERT INTO raw_evidence_refs
            (id, tenant_id, workspace_id, measurement_run_id, object_ref, content_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING`,
            [
              input.promptRun.id,
              input.context.tenantId,
              input.context.workspaceId,
              input.promptRun.measurementRunId,
              input.rawEvidenceRef.objectRef,
              input.rawEvidenceRef.contentHash,
              input.promptRun.observedAt,
            ],
          );
        }
        const run = input.promptRun;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO prompt_runs
          (id, tenant_id, workspace_id, measurement_run_id, prompt_id, prompt_ordinal,
            repetition, scope_key, status, provider_key, surface_key, model, model_version,
            scenario_id, scenario_version, acquisition_class, acquisition_method, adapter_key,
            adapter_version, method_version, observation, cost_amount, cost_currency,
            policy_reason, raw_evidence_ref_id, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15, $16, $17, $18, $19, $20, $21::jsonb, $22::numeric, $23, $24, $25, $26)
         ON CONFLICT (tenant_id, measurement_run_id, prompt_id, scope_key, repetition)
           DO NOTHING
         RETURNING id`,
          [
            run.id,
            input.context.tenantId,
            input.context.workspaceId,
            run.measurementRunId,
            run.promptId,
            run.promptOrdinal,
            run.repetition,
            run.scopeKey,
            run.status,
            run.providerKey,
            run.surfaceKey,
            run.model,
            run.modelVersion,
            run.scenarioId,
            run.scenarioVersion,
            run.acquisitionClass,
            run.acquisitionMethod,
            run.adapterKey,
            run.adapterVersion,
            run.methodVersion,
            JSON.stringify(run.observation),
            run.cost.amount,
            run.cost.currency,
            run.policyReason,
            input.rawEvidenceRef === null ? null : run.id,
            run.observedAt,
          ],
        );
        if (inserted.rows[0] === undefined) return 'CONFLICT' as const;
        for (const observation of input.observations) {
          await client.query(
            `INSERT INTO metric_observations
            (id, tenant_id, workspace_id, measurement_run_id, prompt_run_id, metric_key,
              scope_key, classification, cohort, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
           ON CONFLICT (tenant_id, prompt_run_id, metric_key) DO NOTHING`,
            [
              observation.id,
              input.context.tenantId,
              input.context.workspaceId,
              run.measurementRunId,
              run.id,
              observation.metricKey,
              measurementScopeKey(observation.cohort.scope),
              observation.classification,
              JSON.stringify(observation.cohort),
              run.observedAt,
            ],
          );
        }
        const leaseStillActive = await client.query(
          `SELECT id FROM jobs
         WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3
           AND job_type = 'MEASUREMENT' AND aggregate_id = $4
           AND status = 'RUNNING' AND lease_token = $5
           AND lease_expires_at >= clock_timestamp()
         FOR UPDATE`,
          [
            input.lease.jobId,
            input.context.tenantId,
            input.context.workspaceId,
            run.measurementRunId,
            input.lease.leaseToken,
          ],
        );
        if (leaseStillActive.rows[0] === undefined) {
          throw new MeasurementPersistenceLeaseLostError();
        }
        await client.query(
          `UPDATE measurement_runs run
         SET completed_prompt_run_count = counts.prompt_run_count
         FROM (
           SELECT measurement_run_id, count(*)::integer AS prompt_run_count
           FROM prompt_runs WHERE measurement_run_id = $1 GROUP BY measurement_run_id
         ) counts
         WHERE run.id = $1 AND run.workspace_id = $2 AND run.status = 'RUNNING'
           AND counts.measurement_run_id = run.id
           AND counts.prompt_run_count > run.completed_prompt_run_count`,
          [run.measurementRunId, input.context.workspaceId],
        );
        return 'SUCCEEDED' as const;
      });
    } catch (error) {
      if (error instanceof MeasurementPersistenceLeaseLostError) return 'LEASE_LOST' as const;
      throw error;
    }
  }

  async completeRun(input: Parameters<MeasurementStore['completeRun']>[0]) {
    try {
      return await this.contexts.run(input.context, async (client) => {
        if (input.lease === null) return { outcome: 'LEASE_LOST' as const };
        const locked = await client.query<{
          status: MeasurementRunRecord['status'];
          expected_prompt_run_count: number;
          prompt_run_count: number;
          observation_count: number;
          scope_count: number;
        }>(
          `SELECT run.status, run.expected_prompt_run_count,
           (SELECT count(*)::integer FROM prompt_runs prompt
            WHERE prompt.measurement_run_id = run.id) AS prompt_run_count,
           (SELECT count(*)::integer FROM metric_observations observation
            WHERE observation.measurement_run_id = run.id) AS observation_count,
           jsonb_array_length(run.scenario_snapshot -> 'scopes')::integer AS scope_count
         FROM measurement_runs run
         JOIN jobs job
           ON job.id = run.job_id
          AND job.tenant_id = run.tenant_id
          AND job.workspace_id = run.workspace_id
          AND job.job_type = 'MEASUREMENT'
          AND job.aggregate_id = run.id
         WHERE run.id = $1 AND run.tenant_id = $2 AND run.workspace_id = $3
           AND job.id = $4 AND job.status = 'RUNNING' AND job.lease_token = $5
           AND job.lease_expires_at >= clock_timestamp()
         FOR UPDATE OF run, job`,
          [
            input.measurementRunId,
            input.context.tenantId,
            input.context.workspaceId,
            input.lease.jobId,
            input.lease.leaseToken,
          ],
        );
        const state = locked.rows[0];
        if (state === undefined) return { outcome: 'LEASE_LOST' as const };
        if (
          state.status !== 'RUNNING' ||
          state.prompt_run_count !== state.expected_prompt_run_count ||
          state.observation_count !== state.expected_prompt_run_count * 4 ||
          input.snapshots.length !== state.scope_count * 4
        ) {
          throw new Error('MEASUREMENT_PROMPT_RUN_COUNT_INCOMPLETE');
        }
        for (const snapshot of input.snapshots) {
          const authoritativeValue = metricValueFromCounts(
            snapshot.numerator,
            snapshot.eligibleDenominator,
          );
          if (!Object.is(snapshot.value, authoritativeValue)) {
            throw new Error('MEASUREMENT_SNAPSHOT_VALUE_MISMATCH');
          }
          await client.query(
            `INSERT INTO metric_snapshots
            (id, tenant_id, workspace_id, measurement_run_id, schema_version, metric_key,
              scope_key, method_version, cohort, numerator, eligible_denominator, value,
              excluded_counts, source_observation_ids, source_hash, content_hash, created_at)
           VALUES ($1, $2, $3, $4, 'metric-snapshot.v1', $5, $6, $7, $8::jsonb, $9,
             $10, $11::numeric, $12::jsonb, $13::uuid[], $14, $15, $16)`,
            [
              snapshot.id,
              input.context.tenantId,
              input.context.workspaceId,
              input.measurementRunId,
              snapshot.metricKey,
              measurementScopeKey(snapshot.cohort.scope),
              snapshot.methodVersion,
              JSON.stringify(snapshot.cohort),
              snapshot.numerator,
              snapshot.eligibleDenominator,
              authoritativeValue,
              JSON.stringify(snapshot.excludedCounts),
              snapshot.sourceObservationIds,
              snapshot.sourceHash,
              snapshot.contentHash,
              input.completedAt,
            ],
          );
        }
        const completed = await client.query<MeasurementRunRow>(
          `UPDATE measurement_runs run SET
           status = 'COMPLETED',
           completed_prompt_run_count = counts.prompt_run_count,
           completed_at = $1
         FROM (
           SELECT measurement_run_id, count(*)::integer AS prompt_run_count
           FROM prompt_runs WHERE measurement_run_id = $2 GROUP BY measurement_run_id
         ) counts
         WHERE run.id = $2 AND run.tenant_id = $3 AND run.workspace_id = $4
           AND run.job_id = $5 AND run.status = 'RUNNING'
           AND counts.measurement_run_id = run.id
           AND counts.prompt_run_count = run.expected_prompt_run_count
           AND EXISTS (
             SELECT 1 FROM jobs job
             WHERE job.id = $5 AND job.tenant_id = $3 AND job.workspace_id = $4
               AND job.job_type = 'MEASUREMENT' AND job.aggregate_id = run.id
               AND job.status = 'RUNNING' AND job.lease_token = $6
               AND job.lease_expires_at >= clock_timestamp()
           )
         RETURNING ${RUN_COLUMNS}`,
          [
            input.completedAt,
            input.measurementRunId,
            input.context.tenantId,
            input.context.workspaceId,
            input.lease.jobId,
            input.lease.leaseToken,
          ],
        );
        const row = completed.rows[0];
        if (row === undefined) throw new MeasurementPersistenceLeaseLostError();
        await client.query(
          `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         SELECT $1, run.tenant_id, run.workspace_id, run.requested_by_user_id,
           'MEASUREMENT_RUN_COMPLETED', 'MEASUREMENT_RUN', run.id, 'SUCCEEDED',
           jsonb_build_object('promptRunCount', run.completed_prompt_run_count,
             'snapshotCount', $2::integer), $3
         FROM measurement_runs run WHERE run.id = $4`,
          [input.auditEventId, input.snapshots.length, input.completedAt, input.measurementRunId],
        );
        return {
          outcome: 'SUCCEEDED' as const,
          measurementRun: this.mapRun(row),
        };
      });
    } catch (error) {
      if (error instanceof MeasurementPersistenceLeaseLostError) {
        return { outcome: 'LEASE_LOST' as const };
      }
      throw error;
    }
  }

  private async findRunWithClient(
    client: PoolClient,
    measurementRunId: string,
    workspaceId: string,
  ): Promise<MeasurementRunRecord | null> {
    const result = await client.query<MeasurementRunRow>(
      `SELECT ${RUN_COLUMNS} FROM measurement_runs WHERE id = $1 AND workspace_id = $2`,
      [measurementRunId, workspaceId],
    );
    return result.rows[0] === undefined ? null : this.mapRun(result.rows[0]);
  }

  private mapRun(row: MeasurementRunRow): MeasurementRunRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      promptRevisionId: row.prompt_revision_id,
      scenarioId: row.scenario_id,
      scenarioVersion: row.scenario_version,
      jobId: row.job_id,
      kind: row.kind,
      status: row.status,
      expectedPromptRunCount: row.expected_prompt_run_count,
      completedPromptRunCount: row.completed_prompt_run_count,
      providerKey: row.provider_key,
      surfaceKey: row.surface_key,
      model: row.model,
      modelVersion: row.model_version,
      acquisitionClass: row.acquisition_class,
      acquisitionMethod: row.acquisition_method,
      adapterVersion: row.adapter_version,
      scenarioSnapshot: row.scenario_snapshot,
      createdAt: row.created_at.toISOString(),
      startedAt: row.started_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
    };
  }

  private mapPromptRun(row: PromptRunRow): PromptRunRecord {
    return {
      id: row.id,
      measurementRunId: row.measurement_run_id,
      promptId: row.prompt_id,
      promptOrdinal: row.prompt_ordinal,
      repetition: row.repetition,
      scopeKey: row.scope_key,
      status: row.status,
      providerKey: row.provider_key,
      surfaceKey: row.surface_key,
      model: row.model,
      modelVersion: row.model_version,
      scenarioId: row.scenario_id,
      scenarioVersion: row.scenario_version,
      acquisitionClass: row.acquisition_class,
      acquisitionMethod: row.acquisition_method,
      adapterKey: row.adapter_key,
      adapterVersion: row.adapter_version,
      methodVersion: row.method_version,
      observation: row.observation,
      cost: { amount: decimalSix(row.cost_amount), currency: row.cost_currency },
      policyReason: row.policy_reason,
      observedAt: row.observed_at.toISOString(),
    };
  }

  private mapPolicy(row: PolicyRow): MeasurementProviderPolicyRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      providerKey: row.provider_key,
      surfaceKey: row.surface_key,
      adapterVersion: row.adapter_version,
      termsVersion: row.terms_version,
      termsApproved: row.terms_approved,
      authorizationApproved: row.authorization_approved,
      crossBorderApproved: row.cross_border_approved,
      purpose: row.purpose,
      policyVersion: row.policy_version,
      approvedByUserId: row.approved_by_user_id,
      approvedAt: row.approved_at.toISOString(),
    };
  }

  private mapSnapshot(row: SnapshotRow): StoredMetricSnapshot {
    return {
      id: row.id,
      measurementRunId: row.measurement_run_id,
      metricKey: row.metric_key,
      methodVersion: row.method_version,
      cohort: row.cohort,
      numerator: row.numerator,
      eligibleDenominator: row.eligible_denominator,
      // `value` is a projection. PostgreSQL NUMERIC intentionally rounds its stored display value,
      // while the immutable counts and v1 content hash retain the original rational semantics.
      value: metricValueFromCounts(row.numerator, row.eligible_denominator),
      excludedCounts: row.excluded_counts,
      sourceObservationIds: row.source_observation_ids,
      sourceHash: row.source_hash,
      contentHash: row.content_hash,
    };
  }
}

function runMatchesIdempotentRequest(
  run: MeasurementRunRow,
  source: Parameters<MeasurementStore['prepareRun']>[0]['approvedSource'],
  kind: 'BASELINE' | 'REMEASUREMENT',
): boolean {
  return (
    run.prompt_set_id === source.promptSetId &&
    run.prompt_revision_id === source.promptRevisionId &&
    run.prompt_content_hash === source.promptContentHash &&
    run.scenario_id === source.scenarioSnapshot.id &&
    run.scenario_content_hash === source.scenarioContentHash &&
    run.manual_import_id === (source.scenarioSnapshot.manualImport?.id ?? null) &&
    run.manual_import_content_hash ===
      (source.scenarioSnapshot.manualImport?.contentHash ?? null) &&
    run.kind === kind
  );
}

function decimalSix(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(6, '0').slice(0, 6)}`;
}
