import { createHash } from 'node:crypto';

import type {
  CreateExperimentStoreResult,
  ExperimentInterventionOption,
  ExperimentRunOption,
  ExperimentStore,
} from '@aeostudio/application/experiments';
import type { Experiment, ExperimentMetricComparison } from '@aeostudio/contracts/experiments';
import { compareMetricSnapshots } from '@aeostudio/domain/measurement';
import type { MetricSnapshot } from '@aeostudio/domain/measurement';
import type { Pool, PoolClient } from 'pg';

import { TenantContextRunner } from '../tenant-context/index.js';

interface RunRow {
  id: string;
  kind: 'BASELINE' | 'REMEASUREMENT';
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'ERROR' | 'CANCELLED';
  scenario_id: string;
  scenario_version: number;
  provider_key: string;
  surface_key: string;
  model: string;
  model_version: string;
  started_at: Date | null;
  completed_at: Date | null;
}

interface ArtifactRow {
  artifact_id: string;
  artifact_revision_id: string;
  artifact_revision: number;
  artifact_content_hash: string;
  artifact_status: string;
  artifact_review_id: string;
  review_decision: string | null;
  review_created_at: Date | null;
}

interface PublicationInterventionRow extends ArtifactRow {
  publication_record_id: string;
  publication_status: string;
  channel_package_id: string;
  package_checksum: string;
  publication_attempt_id: string;
  publication_applied_at: Date;
}

interface PublicationResolutionRow extends ArtifactRow {
  publication_record_id: string;
  publication_status: string;
  channel_package_id: string;
  package_checksum: string;
  publication_attempt_id: string | null;
  publication_applied_at: Date | null;
}

interface SnapshotRow {
  id: string;
  measurement_run_id: string;
  schema_version: 'metric-snapshot.v1';
  metric_key: 'MENTION_RATE' | 'CITATION_RATE' | 'ACCURACY_RATE' | 'COVERAGE_RATE';
  scope_key: string;
  method_version: string;
  cohort: MetricSnapshot['cohort'];
  numerator: number;
  eligible_denominator: number;
  value: string | null;
  excluded_counts: MetricSnapshot['excludedCounts'];
  source_observation_ids: string[];
  source_hash: string;
  content_hash: string;
}

interface ExperimentRow {
  id: string;
  request_hash: string;
  report: Experiment | null;
  status: 'BUILDING' | 'SEALED';
}

interface RunSummary {
  sample: number;
  excludedCounts: Experiment['excludedCounts']['baseline'];
  costBreakdown: Experiment['costBreakdown']['baseline'];
  evidenceWindow: { minObservedAt: Date; maxObservedAt: Date } | null;
}

interface ResolvedIntervention {
  kind: 'PUBLISHED_PUBLICATION' | 'APPROVED_ARTIFACT';
  publicationRecordId: string | null;
  publicationAttemptId: string | null;
  channelPackageId: string | null;
  packageChecksum: string | null;
  artifactId: string;
  artifactReviewId: string;
  artifactRevisionId: string;
  artifactRevision: number;
  artifactContentHash: string;
  observedAt: Date;
}

const RUN_OPTION_COLUMNS = `id, kind, status, scenario_id, scenario_version, provider_key,
  surface_key, model, model_version, started_at, completed_at`;
const SNAPSHOT_COLUMNS = `id, measurement_run_id, schema_version, metric_key, scope_key,
  method_version, cohort, numerator, eligible_denominator, value::text, excluded_counts,
  source_observation_ids, source_hash, content_hash`;

export class PostgresExperimentStore implements ExperimentStore {
  private readonly contexts: TenantContextRunner;

  constructor(pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  listOptions(input: Parameters<ExperimentStore['listOptions']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const baseline = await client.query<RunRow>(
        `SELECT ${RUN_OPTION_COLUMNS} FROM measurement_runs
         WHERE workspace_id = $1 AND kind = 'BASELINE' AND status = 'COMPLETED'
           AND started_at IS NOT NULL AND completed_at IS NOT NULL
         ORDER BY completed_at DESC, id DESC LIMIT $2`,
        [input.context.workspaceId, input.limit],
      );
      const remeasurement = await client.query<RunRow>(
        `SELECT ${RUN_OPTION_COLUMNS} FROM measurement_runs
         WHERE workspace_id = $1 AND kind = 'REMEASUREMENT' AND status = 'COMPLETED'
           AND started_at IS NOT NULL AND completed_at IS NOT NULL
         ORDER BY completed_at DESC, id DESC LIMIT $2`,
        [input.context.workspaceId, input.limit],
      );
      const publications = await client.query<PublicationInterventionRow>(
        `SELECT publication.id AS publication_record_id,
           publication.status AS publication_status,
           publication.channel_package_id, publication.package_checksum,
           attempt.id AS publication_attempt_id,
           attempt.finished_at AS publication_applied_at,
           revision.artifact_id, revision.id AS artifact_revision_id,
           revision.revision AS artifact_revision,
           revision.content_hash AS artifact_content_hash,
           revision.status AS artifact_status, review.id AS artifact_review_id,
           review.decision AS review_decision, review.created_at AS review_created_at
         FROM publication_records publication
         JOIN LATERAL (
           SELECT applied.id, applied.finished_at
           FROM publication_attempts applied
           WHERE applied.tenant_id = publication.tenant_id
             AND applied.workspace_id = publication.workspace_id
             AND applied.publication_id = publication.id
             AND applied.operation IN ('PUBLISH', 'RECONCILE')
             AND applied.outcome = 'APPLIED'
             AND applied.finished_at IS NOT NULL
             AND applied.remote_ref = publication.remote_ref
           ORDER BY applied.finished_at, applied.attempt_number, applied.id
           LIMIT 1
         ) attempt ON true
         JOIN artifact_revisions revision
           ON revision.tenant_id = publication.tenant_id
          AND revision.workspace_id = publication.workspace_id
          AND revision.id = publication.artifact_revision_id
          AND revision.content_hash = publication.artifact_content_hash
         JOIN artifact_reviews review
           ON review.tenant_id = revision.tenant_id
          AND review.workspace_id = revision.workspace_id
          AND review.artifact_revision_id = revision.id
          AND review.artifact_id = revision.artifact_id
          AND review.revision = revision.revision
          AND review.content_hash = revision.content_hash
          AND review.decision = 'APPROVE'
         WHERE publication.workspace_id = $1 AND publication.status = 'PUBLISHED'
           AND revision.status = 'APPROVED'
         ORDER BY attempt.finished_at DESC, publication.id DESC,
           review.created_at, review.id LIMIT $2`,
        [input.context.workspaceId, input.limit],
      );
      const approvals = await client.query<ArtifactRow>(
        `SELECT revision.artifact_id, revision.id AS artifact_revision_id,
           revision.revision AS artifact_revision,
           revision.content_hash AS artifact_content_hash,
           revision.status AS artifact_status, review.id AS artifact_review_id,
           review.decision AS review_decision, review.created_at AS review_created_at
         FROM artifact_revisions revision
         JOIN artifact_reviews review
           ON review.tenant_id = revision.tenant_id
          AND review.workspace_id = revision.workspace_id
          AND review.artifact_revision_id = revision.id
          AND review.artifact_id = revision.artifact_id
          AND review.revision = revision.revision
          AND review.content_hash = revision.content_hash
          AND review.decision = 'APPROVE'
         WHERE revision.workspace_id = $1 AND revision.status = 'APPROVED'
         ORDER BY review.created_at DESC, revision.id DESC, review.id DESC LIMIT $2`,
        [input.context.workspaceId, input.limit],
      );
      const runIds = [...baseline.rows, ...remeasurement.rows].map((run) => run.id);
      const snapshots =
        runIds.length === 0
          ? []
          : (
              await client.query<SnapshotRow>(
                `SELECT ${SNAPSHOT_COLUMNS} FROM metric_snapshots
                 WHERE workspace_id = $1 AND measurement_run_id = ANY($2::uuid[])
                 ORDER BY measurement_run_id, metric_key, scope_key, id`,
                [input.context.workspaceId, runIds],
              )
            ).rows;
      const snapshotsByRun = new Map<string, SnapshotRow[]>();
      for (const snapshot of snapshots) {
        const group = snapshotsByRun.get(snapshot.measurement_run_id) ?? [];
        group.push(snapshot);
        snapshotsByRun.set(snapshot.measurement_run_id, group);
      }
      const evidenceWindows = await loadEvidenceWindows(
        client,
        input.context.workspaceId,
        runIds,
        null,
      );
      const interventionOptions: ExperimentInterventionOption[] = [
        ...publications.rows.map(mapPublicationInterventionOption),
        ...approvals.rows.map(mapApprovedInterventionOption),
      ].sort((left, right) =>
        left.observedAt > right.observedAt
          ? -1
          : left.observedAt < right.observedAt
            ? 1
            : interventionKey(left) < interventionKey(right)
              ? -1
              : 1,
      );
      const validBaselineIds = new Set<string>();
      const validRemeasurementIds = new Set<string>();
      const validInterventionKeys = new Set<string>();
      const compatibleCombinations: Array<{
        baselineRunId: string;
        intervention: ExperimentInterventionOption;
        remeasurementRunId: string;
      }> = [];
      for (const baselineRun of baseline.rows) {
        const baselineWindow = evidenceWindows.get(baselineRun.id);
        if (
          baselineRun.started_at === null ||
          baselineRun.completed_at === null ||
          baselineWindow === undefined
        ) {
          continue;
        }
        for (const remeasurementRun of remeasurement.rows) {
          const remeasurementWindow = evidenceWindows.get(remeasurementRun.id);
          if (
            remeasurementRun.started_at === null ||
            remeasurementRun.completed_at === null ||
            remeasurementWindow === undefined ||
            !snapshotSetsAreCompatible(
              snapshotsByRun.get(baselineRun.id) ?? [],
              snapshotsByRun.get(remeasurementRun.id) ?? [],
            )
          ) {
            continue;
          }
          for (const intervention of interventionOptions) {
            const interventionTime = new Date(intervention.observedAt);
            if (
              baselineRun.completed_at <= interventionTime &&
              interventionTime <= remeasurementRun.started_at &&
              baselineWindow.maxObservedAt <= interventionTime &&
              interventionTime <= remeasurementWindow.minObservedAt
            ) {
              compatibleCombinations.push({
                baselineRunId: baselineRun.id,
                intervention,
                remeasurementRunId: remeasurementRun.id,
              });
            }
          }
        }
      }
      const limitedCombinations = compatibleCombinations.slice(0, input.limit);
      for (const combination of limitedCombinations) {
        validBaselineIds.add(combination.baselineRunId);
        validRemeasurementIds.add(combination.remeasurementRunId);
        validInterventionKeys.add(interventionKey(combination.intervention));
      }
      return {
        baselineRuns: baseline.rows.filter((run) => validBaselineIds.has(run.id)).map(mapRunOption),
        remeasurementRuns: remeasurement.rows
          .filter((run) => validRemeasurementIds.has(run.id))
          .map(mapRunOption),
        interventions: interventionOptions.filter((intervention) =>
          validInterventionKeys.has(interventionKey(intervention)),
        ),
        compatibleCombinations: limitedCombinations,
      };
    });
  }

  create(input: Parameters<ExperimentStore['create']>[0]): Promise<CreateExperimentStoreResult> {
    return this.contexts.run(input.context, async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(
          hashtext($1), hashtext($2)
        )`,
        [
          `${input.context.tenantId}:${input.context.workspaceId}`,
          `experiment:${input.idempotencyKey}`,
        ],
      );
      const existing = await client.query<ExperimentRow>(
        `SELECT id, request_hash, report, status FROM experiments
         WHERE workspace_id = $1 AND idempotency_key = $2`,
        [input.context.workspaceId, input.idempotencyKey],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (prior.request_hash !== input.requestHash) return { outcome: 'IDEMPOTENCY_CONFLICT' };
        if (prior.status !== 'SEALED' || prior.report === null) {
          throw new Error('EXPERIMENT_IDEMPOTENT_ROW_NOT_SEALED');
        }
        return { outcome: 'SUCCEEDED', experiment: prior.report, created: false };
      }

      const intervention = await this.resolveIntervention(client, input);
      if (intervention.outcome !== 'SUCCEEDED') return intervention;

      const runs = await client.query<RunRow>(
        `SELECT ${RUN_OPTION_COLUMNS} FROM measurement_runs
         WHERE workspace_id = $1 AND id = ANY($2::uuid[])
         ORDER BY id FOR SHARE`,
        [input.context.workspaceId, [input.baselineRunId, input.remeasurementRunId]],
      );
      const baseline = runs.rows.find((row) => row.id === input.baselineRunId);
      const remeasurement = runs.rows.find((row) => row.id === input.remeasurementRunId);
      if (baseline === undefined || remeasurement === undefined) return { outcome: 'NOT_FOUND' };
      if (baseline.kind !== 'BASELINE' || remeasurement.kind !== 'REMEASUREMENT') {
        return { outcome: 'INVALID_RUN_KIND' };
      }
      if (
        baseline.status !== 'COMPLETED' ||
        baseline.started_at === null ||
        baseline.completed_at === null
      ) {
        return { outcome: 'BASELINE_NOT_COMPLETED' };
      }
      if (
        remeasurement.status !== 'COMPLETED' ||
        remeasurement.started_at === null ||
        remeasurement.completed_at === null
      ) {
        return { outcome: 'REMEASUREMENT_NOT_COMPLETED' };
      }
      const snapshots = await client.query<SnapshotRow>(
        `SELECT ${SNAPSHOT_COLUMNS} FROM metric_snapshots
         WHERE workspace_id = $1 AND measurement_run_id = ANY($2::uuid[])
         ORDER BY measurement_run_id, metric_key, scope_key, id`,
        [input.context.workspaceId, [baseline.id, remeasurement.id]],
      );
      const baselineSnapshots = snapshots.rows.filter(
        (snapshot) => snapshot.measurement_run_id === baseline.id,
      );
      const remeasurementSnapshots = snapshots.rows.filter(
        (snapshot) => snapshot.measurement_run_id === remeasurement.id,
      );
      const baselineByMetric = new Map(
        baselineSnapshots.map((snapshot) => [snapshotPairKey(snapshot), snapshot]),
      );
      const remeasurementByMetric = new Map(
        remeasurementSnapshots.map((snapshot) => [snapshotPairKey(snapshot), snapshot]),
      );
      if (
        baselineByMetric.size === 0 ||
        baselineByMetric.size !== remeasurementByMetric.size ||
        [...baselineByMetric.keys()].some((key) => !remeasurementByMetric.has(key))
      ) {
        return { outcome: 'SNAPSHOT_SET_MISMATCH' };
      }

      const baselineSummary = await loadRunSummary(
        client,
        input.context.workspaceId,
        baseline.id,
        input.createdAt,
      );
      const remeasurementSummary = await loadRunSummary(
        client,
        input.context.workspaceId,
        remeasurement.id,
        input.createdAt,
      );
      if (
        baselineSummary.evidenceWindow === null ||
        remeasurementSummary.evidenceWindow === null ||
        baseline.completed_at > intervention.intervention.observedAt ||
        intervention.intervention.observedAt > remeasurement.started_at ||
        baselineSummary.evidenceWindow.maxObservedAt > intervention.intervention.observedAt ||
        intervention.intervention.observedAt > remeasurementSummary.evidenceWindow.minObservedAt
      ) {
        return { outcome: 'INTERVENTION_OUTSIDE_MEASUREMENT_WINDOW' };
      }
      const comparisons: ExperimentMetricComparison[] = [];
      const incompatible = new Set<string>();
      const baselineCompatibilityKeys: string[] = [];
      const remeasurementCompatibilityKeys: string[] = [];
      let decision: 'REBASELINE' | 'STRATIFY' = 'STRATIFY';

      for (const [key, baselineSnapshot] of [...baselineByMetric.entries()].sort(
        ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
      )) {
        const remeasurementSnapshot = remeasurementByMetric.get(key);
        if (remeasurementSnapshot === undefined) return { outcome: 'SNAPSHOT_SET_MISMATCH' };
        const comparison = compareMetricSnapshots({
          baseline: {
            snapshotId: baselineSnapshot.id,
            snapshot: mapMetricSnapshot(baselineSnapshot),
            costBreakdown: baselineSummary.costBreakdown,
          },
          remeasurement: {
            snapshotId: remeasurementSnapshot.id,
            snapshot: mapMetricSnapshot(remeasurementSnapshot),
            costBreakdown: remeasurementSummary.costBreakdown,
          },
        });
        if (comparison.outcome === 'INCOMPATIBLE_SCENARIO') {
          for (const field of comparison.differingFields) incompatible.add(field);
          baselineCompatibilityKeys.push(comparison.baseline.compatibilityKey);
          remeasurementCompatibilityKeys.push(comparison.remeasurement.compatibilityKey);
          if (comparison.decision === 'REBASELINE') decision = 'REBASELINE';
          continue;
        }
        comparisons.push({
          metricKey: baselineSnapshot.metric_key,
          scopeKey: baselineSnapshot.scope_key,
          compatibilityKey: comparison.compatibilityKey,
          compatibilityHash: comparison.compatibilityHash,
          baseline: comparison.baseline,
          remeasurement: comparison.remeasurement,
          delta: comparison.delta,
          costBreakdown: comparison.costBreakdown,
          observedAssociation: comparison.observedAssociation,
          caveat: comparison.caveat,
          noGuarantee: comparison.noGuarantee,
        });
      }
      if (incompatible.size > 0) {
        return {
          outcome: 'INCOMPATIBLE_SCENARIO',
          differingFields: [...incompatible].sort(),
          decision,
          baselineCompatibilityKeys,
          remeasurementCompatibilityKeys,
          caveat:
            'Direct delta is unavailable because the snapshots belong to incompatible measurement cohorts.',
        };
      }

      const workspaceQuery = `tenant=${encodeURIComponent(input.context.tenantId)}&workspace=${encodeURIComponent(input.context.workspaceId)}`;
      const interventionView =
        intervention.intervention.kind === 'PUBLISHED_PUBLICATION'
          ? {
              kind: 'PUBLISHED_PUBLICATION' as const,
              publicationRecordId: intervention.intervention.publicationRecordId!,
              publicationAttemptId: intervention.intervention.publicationAttemptId!,
              channelPackageId: intervention.intervention.channelPackageId!,
              artifactId: intervention.intervention.artifactId,
              artifactReviewId: intervention.intervention.artifactReviewId,
              artifactRevisionId: intervention.intervention.artifactRevisionId,
              artifactContentHash: intervention.intervention.artifactContentHash,
              applicationState: 'PUBLISHED' as const,
              observedAt: intervention.intervention.observedAt.toISOString(),
              href: `/app/channels?${workspaceQuery}&publication=${encodeURIComponent(intervention.intervention.publicationRecordId!)}`,
            }
          : {
              kind: 'APPROVED_ARTIFACT' as const,
              artifactId: intervention.intervention.artifactId,
              artifactReviewId: intervention.intervention.artifactReviewId,
              artifactRevisionId: intervention.intervention.artifactRevisionId,
              artifactContentHash: intervention.intervention.artifactContentHash,
              applicationState: 'APPROVED_NOT_PUBLISHED' as const,
              observedAt: intervention.intervention.observedAt.toISOString(),
              href: `/app/artifacts?${workspaceQuery}&artifact=${encodeURIComponent(intervention.intervention.artifactId)}`,
              applicationDisclosure:
                'Approval is a recorded review event, not proof of external application or causation.' as const,
            };
      const experiment: Experiment = {
        id: input.experimentId,
        tenantId: input.context.tenantId,
        workspaceId: input.context.workspaceId,
        schemaVersion: 'experiment.v1',
        baselineRunId: baseline.id,
        remeasurementRunId: remeasurement.id,
        scenarioVersion: baseline.scenario_version,
        measurementContext: {
          scenarioId: baseline.scenario_id,
          scenarioVersion: baseline.scenario_version,
          providerKey: baseline.provider_key,
          surfaceKey: baseline.surface_key,
          model: baseline.model,
          modelVersion: baseline.model_version,
          timeline: {
            baseline: {
              runId: baseline.id,
              startedAt: baseline.started_at.toISOString(),
              completedAt: baseline.completed_at.toISOString(),
              evidenceWindow: {
                minObservedAt: baselineSummary.evidenceWindow.minObservedAt.toISOString(),
                maxObservedAt: baselineSummary.evidenceWindow.maxObservedAt.toISOString(),
              },
            },
            remeasurement: {
              runId: remeasurement.id,
              startedAt: remeasurement.started_at.toISOString(),
              completedAt: remeasurement.completed_at.toISOString(),
              evidenceWindow: {
                minObservedAt: remeasurementSummary.evidenceWindow.minObservedAt.toISOString(),
                maxObservedAt: remeasurementSummary.evidenceWindow.maxObservedAt.toISOString(),
              },
            },
          },
        },
        intervention: interventionView,
        comparisons,
        sample: {
          baseline: baselineSummary.sample,
          remeasurement: remeasurementSummary.sample,
        },
        excludedCounts: {
          baseline: baselineSummary.excludedCounts,
          remeasurement: remeasurementSummary.excludedCounts,
        },
        costBreakdown: {
          baseline: baselineSummary.costBreakdown,
          remeasurement: remeasurementSummary.costBreakdown,
        },
        observedAssociation:
          intervention.intervention.kind === 'PUBLISHED_PUBLICATION'
            ? 'This report describes an observed association across a recorded applied publication event; it does not establish causation.'
            : 'This report describes an observed association across a recorded approval event; approval does not prove external application or causation.',
        caveat:
          `The exact ${intervention.intervention.kind === 'PUBLISHED_PUBLICATION' ? 'applied publication' : 'approval'} event was recorded at ${intervention.intervention.observedAt.toISOString()}; ` +
          'sample size, excluded outcomes, Provider behavior, timing, external changes and uncertainty can affect the descriptive delta.',
        noGuarantee:
          'This Experiment does not guarantee ranking, citation, recommendation, traffic or future performance.',
        drillDown: {
          baselineRunHref: `/app/measurement?${workspaceQuery}&run=${encodeURIComponent(baseline.id)}`,
          remeasurementRunHref: `/app/measurement?${workspaceQuery}&run=${encodeURIComponent(remeasurement.id)}`,
          interventionHref: interventionView.href,
        },
        createdByUserId: input.context.actorUserId,
        createdAt: input.createdAt.toISOString(),
      };
      const compatibilityHash = createHash('sha256')
        .update(comparisons.map((comparison) => comparison.compatibilityHash).join(''), 'utf8')
        .digest('hex');

      await client.query(
        `INSERT INTO experiments
          (id, tenant_id, workspace_id, schema_version, status, baseline_run_id,
            remeasurement_run_id, scenario_version, intervention_kind, publication_record_id,
            publication_attempt_id, channel_package_id, package_checksum, artifact_id,
            artifact_review_id, artifact_revision_id, artifact_revision,
            artifact_content_hash, intervention_observed_at,
            compatibility_hash, report, idempotency_key, request_hash, created_by_user_id,
            created_at, sealed_at)
         VALUES ($1, $2, $3, 'experiment.v1', 'BUILDING', $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, NULL, NULL, $18, $19, $20, $21, NULL)`,
        [
          experiment.id,
          input.context.tenantId,
          input.context.workspaceId,
          baseline.id,
          remeasurement.id,
          baseline.scenario_version,
          intervention.intervention.kind,
          intervention.intervention.publicationRecordId,
          intervention.intervention.publicationAttemptId,
          intervention.intervention.channelPackageId,
          intervention.intervention.packageChecksum,
          intervention.intervention.artifactId,
          intervention.intervention.artifactReviewId,
          intervention.intervention.artifactRevisionId,
          intervention.intervention.artifactRevision,
          intervention.intervention.artifactContentHash,
          intervention.intervention.observedAt,
          input.idempotencyKey,
          input.requestHash,
          input.context.actorUserId,
          input.createdAt,
        ],
      );
      for (const [index, comparison] of comparisons.entries()) {
        await client.query(
          `INSERT INTO experiment_snapshot_links
            (tenant_id, workspace_id, experiment_id, ordinal, metric_key, scope_key,
              baseline_snapshot_id, baseline_content_hash, remeasurement_snapshot_id,
              remeasurement_content_hash, compatibility_key, compatibility_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            input.context.tenantId,
            input.context.workspaceId,
            experiment.id,
            index + 1,
            comparison.metricKey,
            comparison.scopeKey,
            comparison.baseline.snapshotId,
            comparison.baseline.contentHash,
            comparison.remeasurement.snapshotId,
            comparison.remeasurement.contentHash,
            comparison.compatibilityKey,
            comparison.compatibilityHash,
          ],
        );
      }
      await client.query(
        `UPDATE experiments SET status = 'SEALED', compatibility_hash = $1,
           report = $2::jsonb, sealed_at = $3
         WHERE workspace_id = $4 AND id = $5 AND status = 'BUILDING'`,
        [
          compatibilityHash,
          JSON.stringify(experiment),
          input.createdAt,
          input.context.workspaceId,
          experiment.id,
        ],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'EXPERIMENT_CREATED', 'EXPERIMENT', $5, 'SUCCEEDED',
           jsonb_build_object('baselineRunId', $6::text, 'remeasurementRunId', $7::text,
             'interventionKind', $8::text, 'comparisonCount', $9::integer), $10)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          experiment.id,
          baseline.id,
          remeasurement.id,
          intervention.intervention.kind,
          comparisons.length,
          input.createdAt,
        ],
      );
      return { outcome: 'SUCCEEDED', experiment, created: true };
    });
  }

  find(input: Parameters<ExperimentStore['find']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<ExperimentRow>(
        `SELECT id, request_hash, report, status FROM experiments
         WHERE workspace_id = $1 AND id = $2 AND status = 'SEALED'`,
        [input.context.workspaceId, input.experimentId],
      );
      return result.rows[0]?.report ?? null;
    });
  }

  private async resolveIntervention(
    client: PoolClient,
    input: Parameters<ExperimentStore['create']>[0],
  ): Promise<
    | { outcome: 'SUCCEEDED'; intervention: ResolvedIntervention }
    | { outcome: 'EXACT_INTERVENTION_REQUIRED' | 'INTERVENTION_NOT_APPLIED' }
  > {
    if (input.intervention.kind === 'PUBLISHED_PUBLICATION') {
      const result = await client.query<PublicationResolutionRow>(
        `SELECT publication.id AS publication_record_id,
           publication.status AS publication_status,
           publication.channel_package_id, publication.package_checksum,
           attempt.id AS publication_attempt_id,
           attempt.finished_at AS publication_applied_at,
           revision.artifact_id, revision.id AS artifact_revision_id,
           revision.revision AS artifact_revision,
           revision.content_hash AS artifact_content_hash,
           revision.status AS artifact_status, review.id AS artifact_review_id,
           review.decision AS review_decision, review.created_at AS review_created_at
         FROM publication_records publication
         LEFT JOIN LATERAL (
           SELECT applied.id, applied.finished_at
           FROM publication_attempts applied
           WHERE applied.tenant_id = publication.tenant_id
             AND applied.workspace_id = publication.workspace_id
             AND applied.publication_id = publication.id
             AND applied.operation IN ('PUBLISH', 'RECONCILE')
             AND applied.outcome = 'APPLIED'
             AND applied.finished_at IS NOT NULL
             AND applied.remote_ref = publication.remote_ref
           ORDER BY applied.finished_at, applied.attempt_number, applied.id
           LIMIT 1
         ) attempt ON true
         JOIN artifact_revisions revision
           ON revision.tenant_id = publication.tenant_id
          AND revision.workspace_id = publication.workspace_id
          AND revision.id = publication.artifact_revision_id
          AND revision.content_hash = publication.artifact_content_hash
         LEFT JOIN artifact_reviews review
           ON review.tenant_id = revision.tenant_id
          AND review.workspace_id = revision.workspace_id
          AND review.artifact_revision_id = revision.id
          AND review.artifact_id = revision.artifact_id
          AND review.revision = revision.revision
          AND review.content_hash = revision.content_hash
          AND review.decision = 'APPROVE'
          AND review.id = $3
         WHERE publication.workspace_id = $1 AND publication.id = $2
         FOR SHARE OF publication`,
        [
          input.context.workspaceId,
          input.intervention.publicationRecordId,
          input.intervention.artifactReviewId,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) return { outcome: 'EXACT_INTERVENTION_REQUIRED' };
      if (row.publication_status !== 'PUBLISHED') {
        return { outcome: 'INTERVENTION_NOT_APPLIED' };
      }
      if (row.publication_attempt_id === null || row.publication_applied_at === null) {
        return { outcome: 'INTERVENTION_NOT_APPLIED' };
      }
      if (
        row.publication_attempt_id !== input.intervention.publicationAttemptId ||
        row.channel_package_id !== input.intervention.channelPackageId ||
        row.artifact_id !== input.intervention.artifactId ||
        row.artifact_review_id !== input.intervention.artifactReviewId ||
        row.artifact_revision_id !== input.intervention.artifactRevisionId ||
        row.artifact_content_hash !== input.intervention.artifactContentHash ||
        row.artifact_status !== 'APPROVED' ||
        row.review_decision !== 'APPROVE' ||
        row.review_created_at === null ||
        row.publication_applied_at?.toISOString() !== input.intervention.observedAt
      ) {
        return { outcome: 'EXACT_INTERVENTION_REQUIRED' };
      }
      return {
        outcome: 'SUCCEEDED',
        intervention: {
          kind: 'PUBLISHED_PUBLICATION',
          publicationRecordId: row.publication_record_id,
          publicationAttemptId: row.publication_attempt_id,
          channelPackageId: row.channel_package_id,
          packageChecksum: row.package_checksum,
          artifactId: row.artifact_id,
          artifactReviewId: row.artifact_review_id,
          artifactRevisionId: row.artifact_revision_id,
          artifactRevision: row.artifact_revision,
          artifactContentHash: row.artifact_content_hash,
          observedAt: row.publication_applied_at,
        },
      };
    }

    const result = await client.query<ArtifactRow>(
      `SELECT revision.artifact_id, revision.id AS artifact_revision_id,
         revision.revision AS artifact_revision, revision.content_hash AS artifact_content_hash,
         revision.status AS artifact_status, review.id AS artifact_review_id,
         review.decision AS review_decision,
         review.created_at AS review_created_at
       FROM artifact_revisions revision
       LEFT JOIN artifact_reviews review
         ON review.tenant_id = revision.tenant_id
        AND review.workspace_id = revision.workspace_id
        AND review.artifact_revision_id = revision.id
        AND review.artifact_id = revision.artifact_id
        AND review.revision = revision.revision
        AND review.content_hash = revision.content_hash
        AND review.decision = 'APPROVE'
        AND review.id = $3
       WHERE revision.workspace_id = $1 AND revision.id = $2`,
      [
        input.context.workspaceId,
        input.intervention.artifactRevisionId,
        input.intervention.artifactReviewId,
      ],
    );
    const row = result.rows[0];
    if (
      row === undefined ||
      row.artifact_id !== input.intervention.artifactId ||
      row.artifact_review_id !== input.intervention.artifactReviewId ||
      row.artifact_content_hash !== input.intervention.artifactContentHash ||
      row.artifact_status !== 'APPROVED' ||
      row.review_decision !== 'APPROVE' ||
      row.review_created_at === null ||
      row.review_created_at.toISOString() !== input.intervention.observedAt
    ) {
      return { outcome: 'EXACT_INTERVENTION_REQUIRED' };
    }
    return {
      outcome: 'SUCCEEDED',
      intervention: {
        kind: 'APPROVED_ARTIFACT',
        publicationRecordId: null,
        publicationAttemptId: null,
        channelPackageId: null,
        packageChecksum: null,
        artifactId: row.artifact_id,
        artifactReviewId: row.artifact_review_id,
        artifactRevisionId: row.artifact_revision_id,
        artifactRevision: row.artifact_revision,
        artifactContentHash: row.artifact_content_hash,
        observedAt: row.review_created_at,
      },
    };
  }
}

function mapRunOption(row: RunRow): ExperimentRunOption {
  if (row.completed_at === null) throw new Error('EXPERIMENT_COMPLETED_RUN_TIMESTAMP_MISSING');
  return {
    id: row.id,
    kind: row.kind,
    scenarioId: row.scenario_id,
    scenarioVersion: row.scenario_version,
    providerKey: row.provider_key,
    surfaceKey: row.surface_key,
    model: row.model,
    modelVersion: row.model_version,
    completedAt: row.completed_at.toISOString(),
  };
}

function mapPublicationInterventionOption(
  row: PublicationInterventionRow,
): ExperimentInterventionOption {
  return {
    kind: 'PUBLISHED_PUBLICATION',
    publicationRecordId: row.publication_record_id,
    publicationAttemptId: row.publication_attempt_id,
    channelPackageId: row.channel_package_id,
    artifactId: row.artifact_id,
    artifactReviewId: row.artifact_review_id,
    artifactRevisionId: row.artifact_revision_id,
    artifactContentHash: row.artifact_content_hash,
    observedAt: row.publication_applied_at.toISOString(),
  };
}

function mapApprovedInterventionOption(row: ArtifactRow): ExperimentInterventionOption {
  if (row.review_created_at === null) throw new Error('EXPERIMENT_APPROVAL_TIMESTAMP_MISSING');
  return {
    kind: 'APPROVED_ARTIFACT',
    artifactId: row.artifact_id,
    artifactReviewId: row.artifact_review_id,
    artifactRevisionId: row.artifact_revision_id,
    artifactContentHash: row.artifact_content_hash,
    observedAt: row.review_created_at.toISOString(),
  };
}

function interventionKey(intervention: ExperimentInterventionOption): string {
  return intervention.kind === 'PUBLISHED_PUBLICATION'
    ? `publication:${intervention.publicationRecordId}:${intervention.publicationAttemptId}:${intervention.channelPackageId}:${intervention.artifactId}:${intervention.artifactReviewId}:${intervention.artifactRevisionId}:${intervention.artifactContentHash}:${intervention.observedAt}`
    : `approval:${intervention.artifactId}:${intervention.artifactReviewId}:${intervention.artifactRevisionId}:${intervention.artifactContentHash}:${intervention.observedAt}`;
}

function snapshotPairKey(row: SnapshotRow): string {
  return JSON.stringify([row.metric_key, row.scope_key]);
}

function mapMetricSnapshot(row: SnapshotRow): MetricSnapshot {
  return {
    schemaVersion: row.schema_version,
    metricKey: row.metric_key,
    methodVersion: row.method_version,
    cohort: structuredClone(row.cohort),
    numerator: row.numerator,
    eligibleDenominator: row.eligible_denominator,
    value: row.value === null ? null : Number(row.value),
    excludedCounts: structuredClone(row.excluded_counts),
    sourceObservationIds: [...row.source_observation_ids],
    sourceHash: row.source_hash,
    contentHash: row.content_hash,
  };
}

function snapshotSetsAreCompatible(
  baselineSnapshots: SnapshotRow[],
  remeasurementSnapshots: SnapshotRow[],
): boolean {
  const baselineByMetric = new Map(
    baselineSnapshots.map((snapshot) => [snapshotPairKey(snapshot), snapshot]),
  );
  const remeasurementByMetric = new Map(
    remeasurementSnapshots.map((snapshot) => [snapshotPairKey(snapshot), snapshot]),
  );
  if (
    baselineByMetric.size === 0 ||
    baselineByMetric.size !== remeasurementByMetric.size ||
    [...baselineByMetric.keys()].some((key) => !remeasurementByMetric.has(key))
  ) {
    return false;
  }
  return [...baselineByMetric.entries()].every(([key, baseline]) => {
    const remeasurement = remeasurementByMetric.get(key);
    return (
      remeasurement !== undefined &&
      compareMetricSnapshots({
        baseline: {
          snapshotId: baseline.id,
          snapshot: mapMetricSnapshot(baseline),
          costBreakdown: [],
        },
        remeasurement: {
          snapshotId: remeasurement.id,
          snapshot: mapMetricSnapshot(remeasurement),
          costBreakdown: [],
        },
      }).outcome === 'COMPARABLE'
    );
  });
}

async function loadRunSummary(
  client: PoolClient,
  workspaceId: string,
  measurementRunId: string,
  notAfter: Date,
): Promise<RunSummary> {
  const counts = await client.query<{
    sample: number;
    error: number;
    not_checked: number;
    inconclusive: number;
    not_applicable: number;
    min_observed_at: Date | null;
    max_observed_at: Date | null;
    all_not_future: boolean | null;
  }>(
    `SELECT count(*)::integer AS sample,
       count(*) FILTER (WHERE status = 'ERROR')::integer AS error,
       count(*) FILTER (WHERE status = 'NOT_CHECKED')::integer AS not_checked,
       count(*) FILTER (WHERE status = 'INCONCLUSIVE')::integer AS inconclusive,
       count(*) FILTER (WHERE status = 'NOT_APPLICABLE')::integer AS not_applicable,
       min(observed_at) AS min_observed_at, max(observed_at) AS max_observed_at,
       bool_and(observed_at <= $3 AND observed_at <= transaction_timestamp()) AS all_not_future
     FROM prompt_runs WHERE workspace_id = $1 AND measurement_run_id = $2`,
    [workspaceId, measurementRunId, notAfter],
  );
  const costs = await client.query<{ currency: string; amount: string }>(
    `SELECT cost_currency AS currency, sum(cost_amount)::numeric(18, 6)::text AS amount
     FROM prompt_runs WHERE workspace_id = $1 AND measurement_run_id = $2
     GROUP BY cost_currency ORDER BY cost_currency`,
    [workspaceId, measurementRunId],
  );
  const count = counts.rows[0];
  if (count === undefined) throw new Error('EXPERIMENT_RUN_SUMMARY_MISSING');
  const evidenceWindow =
    count.sample > 0 &&
    count.min_observed_at !== null &&
    count.max_observed_at !== null &&
    count.all_not_future === true
      ? { minObservedAt: count.min_observed_at, maxObservedAt: count.max_observed_at }
      : null;
  return {
    sample: count.sample,
    evidenceWindow,
    excludedCounts: {
      ERROR: count.error,
      NOT_CHECKED: count.not_checked,
      INCONCLUSIVE: count.inconclusive,
      NOT_APPLICABLE: count.not_applicable,
    },
    costBreakdown: costs.rows,
  };
}

async function loadEvidenceWindows(
  client: PoolClient,
  workspaceId: string,
  measurementRunIds: string[],
  notAfter: Date | null,
): Promise<Map<string, { minObservedAt: Date; maxObservedAt: Date }>> {
  if (measurementRunIds.length === 0) return new Map();
  const result = await client.query<{
    measurement_run_id: string;
    min_observed_at: Date;
    max_observed_at: Date;
    all_not_future: boolean;
  }>(
    `SELECT measurement_run_id, min(observed_at) AS min_observed_at,
       max(observed_at) AS max_observed_at,
       bool_and(
         observed_at <= COALESCE($3::timestamptz, transaction_timestamp())
         AND observed_at <= transaction_timestamp()
       ) AS all_not_future
     FROM prompt_runs
     WHERE workspace_id = $1 AND measurement_run_id = ANY($2::uuid[])
     GROUP BY measurement_run_id`,
    [workspaceId, measurementRunIds, notAfter],
  );
  return new Map(
    result.rows
      .filter(
        (row) => row.all_not_future && row.min_observed_at !== null && row.max_observed_at !== null,
      )
      .map((row) => [
        row.measurement_run_id,
        { minObservedAt: row.min_observed_at, maxObservedAt: row.max_observed_at },
      ]),
  );
}
