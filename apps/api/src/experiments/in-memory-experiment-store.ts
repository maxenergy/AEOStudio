import type {
  CreateExperimentStoreResult,
  ExperimentInterventionOption,
  ExperimentStore,
} from '@aeostudio/application/experiments';
import { measurementScopeKey } from '@aeostudio/application/measurement';
import type {
  MeasurementDashboardSource,
  PromptRunRecord,
  StoredMetricSnapshot,
} from '@aeostudio/application/measurement';
import type { Experiment, ExperimentMetricComparison } from '@aeostudio/contracts/experiments';
import { compareMetricSnapshots } from '@aeostudio/domain/measurement';
import type { MetricSnapshot } from '@aeostudio/domain/measurement';

import type { InMemoryArtifactStore } from '../artifacts/in-memory-artifact-store.js';
import type { InMemoryPublicationStore } from '../channels/in-memory-publication-store.js';
import type { InMemoryMeasurementStore } from '../measurement/in-memory-measurement-store.js';

interface StoredExperiment {
  requestHash: string;
  experiment: Experiment;
}

interface InMemoryResolvedIntervention {
  kind: 'PUBLISHED_PUBLICATION' | 'APPROVED_ARTIFACT';
  publicationRecordId: string | null;
  publicationAttemptId: string | null;
  channelPackageId: string | null;
  artifactId: string;
  artifactRevisionId: string;
  artifactContentHash: string;
  artifactReviewId: string;
  observedAt: string;
}

export class InMemoryExperimentStore implements ExperimentStore {
  private readonly experiments = new Map<string, StoredExperiment>();

  constructor(
    private readonly sources: {
      measurements: InMemoryMeasurementStore;
      publications: InMemoryPublicationStore;
      artifacts: InMemoryArtifactStore;
      clock: { now(): Date };
    },
  ) {}

  listOptions(input: Parameters<ExperimentStore['listOptions']>[0]) {
    const runs = this.sources.measurements.listCompletedForExperiment(input.context);
    const publications = this.sources.publications.listPublishedForExperiment(input.context);
    const approvals = this.sources.artifacts.listApprovedForExperiment(input.context);
    const baselines = runs.filter(({ run }) => run.kind === 'BASELINE');
    const remeasurements = runs.filter(({ run }) => run.kind === 'REMEASUREMENT');
    const validBaselineIds = new Set<string>();
    const validRemeasurementIds = new Set<string>();
    const validInterventionKeys = new Set<string>();
    const compatibleCombinations: Array<{
      baselineRunId: string;
      intervention: ExperimentInterventionOption;
      remeasurementRunId: string;
    }> = [];
    const now = this.sources.clock.now();
    const interventions = [
      ...publications.flatMap(({ publication, publicationAttemptId, appliedAt }) => {
        const approval = approvals.find(
          (candidate) =>
            candidate.artifactRevisionId === publication.artifactRevisionId &&
            candidate.artifactContentHash === publication.artifactContentHash,
        );
        return approval === undefined
          ? []
          : [
              {
                kind: 'PUBLISHED_PUBLICATION' as const,
                publicationRecordId: publication.id,
                publicationAttemptId,
                channelPackageId: publication.channelPackageId,
                artifactId: approval.artifactId,
                artifactReviewId: approval.artifactReviewId,
                artifactRevisionId: publication.artifactRevisionId,
                artifactContentHash: publication.artifactContentHash,
                observedAt: appliedAt,
              },
            ];
      }),
      ...approvals.map((approval) => ({
        kind: 'APPROVED_ARTIFACT' as const,
        artifactId: approval.artifactId,
        artifactReviewId: approval.artifactReviewId,
        artifactRevisionId: approval.artifactRevisionId,
        artifactContentHash: approval.artifactContentHash,
        observedAt: approval.approvedAt,
      })),
    ].sort((left, right) =>
      left.observedAt > right.observedAt
        ? -1
        : left.observedAt < right.observedAt
          ? 1
          : interventionKey(left) < interventionKey(right)
            ? -1
            : 1,
    );
    for (const baseline of baselines) {
      const baselineWindow = evidenceWindow(baseline.promptRuns, now);
      if (
        baseline.run.startedAt === null ||
        baseline.run.completedAt === null ||
        baselineWindow === null
      ) {
        continue;
      }
      for (const remeasurement of remeasurements) {
        const remeasurementWindow = evidenceWindow(remeasurement.promptRuns, now);
        if (
          remeasurement.run.startedAt === null ||
          remeasurement.run.completedAt === null ||
          remeasurementWindow === null ||
          compareDashboards(baseline, remeasurement).outcome !== 'SUCCEEDED'
        ) {
          continue;
        }
        for (const intervention of interventions) {
          const interventionTime = Date.parse(intervention.observedAt);
          if (
            Date.parse(baseline.run.completedAt) <= interventionTime &&
            interventionTime <= Date.parse(remeasurement.run.startedAt) &&
            Date.parse(baselineWindow.maxObservedAt) <= interventionTime &&
            interventionTime <= Date.parse(remeasurementWindow.minObservedAt)
          ) {
            compatibleCombinations.push({
              baselineRunId: baseline.run.id,
              intervention,
              remeasurementRunId: remeasurement.run.id,
            });
          }
        }
      }
    }
    const runOptions = runs.map(({ run }) => ({
      id: run.id,
      kind: run.kind,
      scenarioId: run.scenarioId,
      scenarioVersion: run.scenarioVersion,
      providerKey: run.providerKey,
      surfaceKey: run.surfaceKey,
      model: run.model,
      modelVersion: run.modelVersion,
      completedAt: run.completedAt!,
    }));
    const limitedCombinations = compatibleCombinations.slice(0, input.limit);
    for (const combination of limitedCombinations) {
      validBaselineIds.add(combination.baselineRunId);
      validRemeasurementIds.add(combination.remeasurementRunId);
      validInterventionKeys.add(interventionKey(combination.intervention));
    }
    return Promise.resolve({
      baselineRuns: runOptions
        .filter((run) => run.kind === 'BASELINE' && validBaselineIds.has(run.id))
        .slice(0, input.limit),
      remeasurementRuns: runOptions
        .filter((run) => run.kind === 'REMEASUREMENT' && validRemeasurementIds.has(run.id))
        .slice(0, input.limit),
      interventions: interventions
        .filter((intervention) => validInterventionKeys.has(interventionKey(intervention)))
        .slice(0, input.limit),
      compatibleCombinations: limitedCombinations,
    });
  }

  create(input: Parameters<ExperimentStore['create']>[0]): Promise<CreateExperimentStoreResult> {
    const idempotencyKey = this.idempotencyKey(
      input.context.tenantId,
      input.context.workspaceId,
      input.idempotencyKey,
    );
    const prior = this.experiments.get(idempotencyKey);
    if (prior !== undefined) {
      return Promise.resolve(
        prior.requestHash === input.requestHash
          ? { outcome: 'SUCCEEDED', experiment: structuredClone(prior.experiment), created: false }
          : { outcome: 'IDEMPOTENCY_CONFLICT' },
      );
    }
    const approvals = this.sources.artifacts.listApprovedForExperiment(input.context);
    let resolvedIntervention: InMemoryResolvedIntervention | undefined;
    if (input.intervention.kind === 'PUBLISHED_PUBLICATION') {
      const publishedRequest = input.intervention;
      const published = this.sources.publications
        .listPublishedForExperiment(input.context)
        .find(({ publication }) => publication.id === publishedRequest.publicationRecordId);
      const approval = approvals.find(
        (candidate) =>
          candidate.artifactId === publishedRequest.artifactId &&
          candidate.artifactReviewId === publishedRequest.artifactReviewId &&
          candidate.artifactRevisionId === publishedRequest.artifactRevisionId &&
          candidate.artifactContentHash === publishedRequest.artifactContentHash &&
          candidate.approvedAt <= publishedRequest.observedAt,
      );
      if (
        published !== undefined &&
        approval !== undefined &&
        published.publicationAttemptId === publishedRequest.publicationAttemptId &&
        published.publication.channelPackageId === publishedRequest.channelPackageId &&
        published.publication.artifactRevisionId === publishedRequest.artifactRevisionId &&
        published.publication.artifactContentHash === publishedRequest.artifactContentHash &&
        published.appliedAt === publishedRequest.observedAt
      ) {
        resolvedIntervention = {
          kind: 'PUBLISHED_PUBLICATION',
          publicationRecordId: published.publication.id,
          publicationAttemptId: published.publicationAttemptId,
          channelPackageId: published.publication.channelPackageId,
          artifactId: approval.artifactId,
          artifactRevisionId: approval.artifactRevisionId,
          artifactContentHash: approval.artifactContentHash,
          artifactReviewId: approval.artifactReviewId,
          observedAt: published.appliedAt,
        };
      }
    } else {
      const approval = approvals.find(
        (candidate) =>
          candidate.artifactId === input.intervention.artifactId &&
          candidate.artifactReviewId === input.intervention.artifactReviewId &&
          candidate.artifactRevisionId === input.intervention.artifactRevisionId &&
          candidate.artifactContentHash === input.intervention.artifactContentHash &&
          candidate.approvedAt === input.intervention.observedAt,
      );
      if (approval !== undefined) {
        resolvedIntervention = {
          kind: 'APPROVED_ARTIFACT',
          publicationRecordId: null,
          publicationAttemptId: null,
          channelPackageId: null,
          artifactId: approval.artifactId,
          artifactRevisionId: approval.artifactRevisionId,
          artifactContentHash: approval.artifactContentHash,
          artifactReviewId: approval.artifactReviewId,
          observedAt: approval.approvedAt,
        };
      }
    }
    if (resolvedIntervention === undefined) {
      return Promise.resolve({ outcome: 'EXACT_INTERVENTION_REQUIRED' });
    }
    const runs = this.sources.measurements.listCompletedForExperiment(input.context);
    const baseline = runs.find((candidate) => candidate.run.id === input.baselineRunId);
    const remeasurement = runs.find((candidate) => candidate.run.id === input.remeasurementRunId);
    if (baseline === undefined || remeasurement === undefined) {
      return Promise.resolve({ outcome: 'NOT_FOUND' });
    }
    if (baseline.run.kind !== 'BASELINE' || remeasurement.run.kind !== 'REMEASUREMENT') {
      return Promise.resolve({ outcome: 'INVALID_RUN_KIND' });
    }
    if (
      baseline.run.status !== 'COMPLETED' ||
      baseline.run.startedAt === null ||
      baseline.run.completedAt === null
    ) {
      return Promise.resolve({ outcome: 'BASELINE_NOT_COMPLETED' });
    }
    if (
      remeasurement.run.status !== 'COMPLETED' ||
      remeasurement.run.startedAt === null ||
      remeasurement.run.completedAt === null
    ) {
      return Promise.resolve({ outcome: 'REMEASUREMENT_NOT_COMPLETED' });
    }
    const baselineWindow = evidenceWindow(baseline.promptRuns, input.createdAt);
    const remeasurementWindow = evidenceWindow(remeasurement.promptRuns, input.createdAt);
    const interventionObservedAt = Date.parse(resolvedIntervention.observedAt);
    if (
      baselineWindow === null ||
      remeasurementWindow === null ||
      Date.parse(baseline.run.completedAt) > interventionObservedAt ||
      interventionObservedAt > Date.parse(remeasurement.run.startedAt) ||
      Date.parse(baselineWindow.maxObservedAt) > interventionObservedAt ||
      interventionObservedAt > Date.parse(remeasurementWindow.minObservedAt)
    ) {
      return Promise.resolve({ outcome: 'INTERVENTION_OUTSIDE_MEASUREMENT_WINDOW' });
    }
    const comparison = compareDashboards(baseline, remeasurement);
    if (comparison.outcome !== 'SUCCEEDED') return Promise.resolve(comparison);

    const workspaceQuery = `tenant=${encodeURIComponent(input.context.tenantId)}&workspace=${encodeURIComponent(input.context.workspaceId)}`;
    const baselineSummary = summarizePromptRuns(baseline.promptRuns);
    const remeasurementSummary = summarizePromptRuns(remeasurement.promptRuns);
    const interventionView =
      resolvedIntervention.kind === 'PUBLISHED_PUBLICATION'
        ? {
            kind: 'PUBLISHED_PUBLICATION' as const,
            publicationRecordId: resolvedIntervention.publicationRecordId!,
            publicationAttemptId: resolvedIntervention.publicationAttemptId!,
            channelPackageId: resolvedIntervention.channelPackageId!,
            artifactId: resolvedIntervention.artifactId,
            artifactReviewId: resolvedIntervention.artifactReviewId,
            artifactRevisionId: resolvedIntervention.artifactRevisionId,
            artifactContentHash: resolvedIntervention.artifactContentHash,
            applicationState: 'PUBLISHED' as const,
            observedAt: resolvedIntervention.observedAt,
            href: `/app/channels?${workspaceQuery}&publication=${encodeURIComponent(resolvedIntervention.publicationRecordId!)}`,
          }
        : {
            kind: 'APPROVED_ARTIFACT' as const,
            artifactId: resolvedIntervention.artifactId,
            artifactReviewId: resolvedIntervention.artifactReviewId,
            artifactRevisionId: resolvedIntervention.artifactRevisionId,
            artifactContentHash: resolvedIntervention.artifactContentHash,
            applicationState: 'APPROVED_NOT_PUBLISHED' as const,
            observedAt: resolvedIntervention.observedAt,
            href: `/app/artifacts?${workspaceQuery}&artifact=${encodeURIComponent(resolvedIntervention.artifactId)}`,
            applicationDisclosure:
              'Approval is a recorded review event, not proof of external application or causation.' as const,
          };
    const experiment: Experiment = {
      id: input.experimentId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      schemaVersion: 'experiment.v1',
      baselineRunId: baseline.run.id,
      remeasurementRunId: remeasurement.run.id,
      scenarioVersion: baseline.run.scenarioVersion,
      measurementContext: {
        scenarioId: baseline.run.scenarioId,
        scenarioVersion: baseline.run.scenarioVersion,
        providerKey: baseline.run.providerKey,
        surfaceKey: baseline.run.surfaceKey,
        model: baseline.run.model,
        modelVersion: baseline.run.modelVersion,
        timeline: {
          baseline: {
            runId: baseline.run.id,
            startedAt: baseline.run.startedAt,
            completedAt: baseline.run.completedAt,
            evidenceWindow: baselineWindow,
          },
          remeasurement: {
            runId: remeasurement.run.id,
            startedAt: remeasurement.run.startedAt,
            completedAt: remeasurement.run.completedAt,
            evidenceWindow: remeasurementWindow,
          },
        },
      },
      intervention: interventionView,
      comparisons: comparison.comparisons,
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
        resolvedIntervention.kind === 'PUBLISHED_PUBLICATION'
          ? 'This report describes an observed association across a recorded applied publication event; it does not establish causation.'
          : 'This report describes an observed association across a recorded approval event; approval does not prove external application or causation.',
      caveat:
        `The exact ${resolvedIntervention.kind === 'PUBLISHED_PUBLICATION' ? 'applied publication' : 'approval'} event was recorded at ${resolvedIntervention.observedAt}; ` +
        'sample size, excluded outcomes, Provider behavior, timing, external changes and uncertainty can affect the descriptive delta.',
      noGuarantee:
        'This Experiment does not guarantee ranking, citation, recommendation, traffic or future performance.',
      drillDown: {
        baselineRunHref: `/app/measurement?${workspaceQuery}&run=${encodeURIComponent(baseline.run.id)}`,
        remeasurementRunHref: `/app/measurement?${workspaceQuery}&run=${encodeURIComponent(remeasurement.run.id)}`,
        interventionHref: interventionView.href,
      },
      createdByUserId: input.context.actorUserId,
      createdAt: input.createdAt.toISOString(),
    };
    this.experiments.set(idempotencyKey, {
      requestHash: input.requestHash,
      experiment: structuredClone(experiment),
    });
    return Promise.resolve({ outcome: 'SUCCEEDED', experiment, created: true });
  }

  find(input: Parameters<ExperimentStore['find']>[0]) {
    const found = [...this.experiments.values()].find(
      ({ experiment }) =>
        experiment.id === input.experimentId &&
        experiment.tenantId === input.context.tenantId &&
        experiment.workspaceId === input.context.workspaceId,
    );
    return Promise.resolve(found === undefined ? null : structuredClone(found.experiment));
  }

  private idempotencyKey(tenantId: string, workspaceId: string, key: string): string {
    return JSON.stringify([tenantId, workspaceId, key]);
  }
}

function compareDashboards(
  baseline: MeasurementDashboardSource,
  remeasurement: MeasurementDashboardSource,
):
  | { outcome: 'SUCCEEDED'; comparisons: ExperimentMetricComparison[] }
  | Extract<CreateExperimentStoreResult, { outcome: 'INCOMPATIBLE_SCENARIO' }>
  | { outcome: 'SNAPSHOT_SET_MISMATCH' } {
  const baselineByKey = new Map(
    baseline.snapshots.map((snapshot) => [snapshotKey(snapshot), snapshot]),
  );
  const remeasurementByKey = new Map(
    remeasurement.snapshots.map((snapshot) => [snapshotKey(snapshot), snapshot]),
  );
  if (
    baselineByKey.size === 0 ||
    baselineByKey.size !== remeasurementByKey.size ||
    [...baselineByKey.keys()].some((key) => !remeasurementByKey.has(key))
  ) {
    return { outcome: 'SNAPSHOT_SET_MISMATCH' };
  }
  const baselineSummary = summarizePromptRuns(baseline.promptRuns);
  const remeasurementSummary = summarizePromptRuns(remeasurement.promptRuns);
  const comparisons: ExperimentMetricComparison[] = [];
  const differingFields = new Set<string>();
  const baselineCompatibilityKeys: string[] = [];
  const remeasurementCompatibilityKeys: string[] = [];
  let decision: 'REBASELINE' | 'STRATIFY' = 'STRATIFY';
  for (const [key, baselineSnapshot] of [...baselineByKey.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const remeasurementSnapshot = remeasurementByKey.get(key);
    if (remeasurementSnapshot === undefined) return { outcome: 'SNAPSHOT_SET_MISMATCH' };
    const result = compareMetricSnapshots({
      baseline: {
        snapshotId: baselineSnapshot.id,
        snapshot: domainSnapshot(baselineSnapshot),
        costBreakdown: baselineSummary.costBreakdown,
      },
      remeasurement: {
        snapshotId: remeasurementSnapshot.id,
        snapshot: domainSnapshot(remeasurementSnapshot),
        costBreakdown: remeasurementSummary.costBreakdown,
      },
    });
    if (result.outcome === 'INCOMPATIBLE_SCENARIO') {
      for (const field of result.differingFields) differingFields.add(field);
      baselineCompatibilityKeys.push(result.baseline.compatibilityKey);
      remeasurementCompatibilityKeys.push(result.remeasurement.compatibilityKey);
      if (result.decision === 'REBASELINE') decision = 'REBASELINE';
      continue;
    }
    comparisons.push({
      metricKey: baselineSnapshot.metricKey,
      scopeKey: measurementScopeKey(baselineSnapshot.cohort.scope),
      compatibilityKey: result.compatibilityKey,
      compatibilityHash: result.compatibilityHash,
      baseline: result.baseline,
      remeasurement: result.remeasurement,
      delta: result.delta,
      costBreakdown: result.costBreakdown,
      observedAssociation: result.observedAssociation,
      caveat: result.caveat,
      noGuarantee: result.noGuarantee,
    });
  }
  return differingFields.size === 0
    ? { outcome: 'SUCCEEDED', comparisons }
    : {
        outcome: 'INCOMPATIBLE_SCENARIO',
        differingFields: [...differingFields].sort(),
        decision,
        baselineCompatibilityKeys,
        remeasurementCompatibilityKeys,
        caveat:
          'Direct delta is unavailable because the snapshots belong to incompatible measurement cohorts.',
      };
}

function snapshotKey(snapshot: StoredMetricSnapshot): string {
  return JSON.stringify([snapshot.metricKey, measurementScopeKey(snapshot.cohort.scope)]);
}

function domainSnapshot(snapshot: StoredMetricSnapshot): MetricSnapshot {
  return {
    schemaVersion: 'metric-snapshot.v1',
    metricKey: snapshot.metricKey,
    methodVersion: snapshot.methodVersion,
    cohort: structuredClone(snapshot.cohort),
    numerator: snapshot.numerator,
    eligibleDenominator: snapshot.eligibleDenominator,
    value: snapshot.value,
    excludedCounts: structuredClone(snapshot.excludedCounts),
    sourceObservationIds: [...snapshot.sourceObservationIds],
    sourceHash: snapshot.sourceHash,
    contentHash: snapshot.contentHash,
  };
}

function summarizePromptRuns(promptRuns: PromptRunRecord[]) {
  const excludedCounts = { ERROR: 0, NOT_CHECKED: 0, INCONCLUSIVE: 0, NOT_APPLICABLE: 0 };
  const costMicros = new Map<string, bigint>();
  for (const promptRun of promptRuns) {
    if (promptRun.status in excludedCounts) {
      excludedCounts[promptRun.status as keyof typeof excludedCounts] += 1;
    }
    const amount = BigInt(promptRun.cost.amount.replace('.', ''));
    costMicros.set(
      promptRun.cost.currency,
      (costMicros.get(promptRun.cost.currency) ?? 0n) + amount,
    );
  }
  return {
    sample: promptRuns.length,
    excludedCounts,
    costBreakdown: [...costMicros.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([currency, amount]) => ({
        currency,
        amount: `${amount / 1_000_000n}.${String(amount % 1_000_000n).padStart(6, '0')}`,
      })),
  };
}

function evidenceWindow(
  promptRuns: PromptRunRecord[],
  notAfter: Date,
): { minObservedAt: string; maxObservedAt: string } | null {
  if (promptRuns.length === 0) return null;
  const observations = promptRuns
    .map((promptRun) => ({ value: promptRun.observedAt, time: Date.parse(promptRun.observedAt) }))
    .sort((left, right) => left.time - right.time);
  const first = observations[0];
  const last = observations.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    !Number.isFinite(first.time) ||
    !Number.isFinite(last.time) ||
    last.time > notAfter.getTime()
  ) {
    return null;
  }
  return { minObservedAt: first.value, maxObservedAt: last.value };
}

function interventionKey(intervention: {
  kind: 'PUBLISHED_PUBLICATION' | 'APPROVED_ARTIFACT';
  publicationRecordId?: string;
  publicationAttemptId?: string;
  channelPackageId?: string;
  artifactId?: string;
  artifactReviewId?: string;
  artifactRevisionId?: string;
  artifactContentHash?: string;
  observedAt?: string;
}): string {
  return intervention.kind === 'PUBLISHED_PUBLICATION'
    ? `publication:${intervention.publicationRecordId ?? ''}:${intervention.publicationAttemptId ?? ''}:${intervention.channelPackageId ?? ''}:${intervention.artifactId ?? ''}:${intervention.artifactReviewId ?? ''}:${intervention.artifactRevisionId ?? ''}:${intervention.artifactContentHash ?? ''}:${intervention.observedAt ?? ''}`
    : `approval:${intervention.artifactId ?? ''}:${intervention.artifactReviewId ?? ''}:${intervention.artifactRevisionId ?? ''}:${intervention.artifactContentHash ?? ''}:${intervention.observedAt ?? ''}`;
}
