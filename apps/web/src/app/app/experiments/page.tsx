import { randomUUID } from 'node:crypto';

import type { WorkspaceListEnvelope } from '@aeostudio/contracts';
import {
  ExperimentCompatibleCombinationSchema,
  ExperimentEnvelopeSchema,
  ExperimentOptionsEnvelopeSchema,
  type ExperimentCompatibleCombination,
  type Experiment,
} from '@aeostudio/contracts/experiments';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

function apiOrigin(): string {
  return process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3200';
}

function webOrigin(): string {
  return process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3100';
}

function requiredText(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`EXPERIMENT_${name}_REQUIRED`);
  return value;
}

function experimentLocation(input: {
  tenantId: string;
  workspaceId: string;
  experimentId?: string;
  notice?: string;
  error?: string;
}): string {
  const query = new URLSearchParams({ tenant: input.tenantId, workspace: input.workspaceId });
  if (input.experimentId !== undefined) query.set('experiment', input.experimentId);
  if (input.notice !== undefined) query.set('notice', input.notice);
  if (input.error !== undefined) query.set('error', input.error);
  return `/app/experiments?${query.toString()}`;
}

async function createExperiment(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const combinationValue = requiredText(formData, 'combination');
  let combination: ReturnType<typeof ExperimentCompatibleCombinationSchema.parse>;
  try {
    combination = ExperimentCompatibleCombinationSchema.parse(JSON.parse(combinationValue));
  } catch {
    redirect(experimentLocation({ tenantId, workspaceId, error: 'invalid-combination' }));
  }
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/experiments`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        cookie: (await cookies()).toString(),
        origin: webOrigin(),
      },
      body: JSON.stringify({
        baselineRunId: combination.baselineRunId,
        remeasurementRunId: combination.remeasurementRunId,
        intervention: combination.intervention,
        idempotencyKey: requiredText(formData, 'idempotencyKey'),
      }),
    },
  );
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof problem?.code === 'string' ? problem.code.toLowerCase() : 'create-failed';
    redirect(experimentLocation({ tenantId, workspaceId, error: code }));
  }
  const experiment = ExperimentEnvelopeSchema.parse(await response.json()).data.experiment;
  redirect(
    experimentLocation({
      tenantId,
      workspaceId,
      experimentId: experiment.id,
      notice: 'created',
    }),
  );
}

interface ExperimentPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ExperimentPage({ searchParams }: ExperimentPageProps) {
  const query = await searchParams;
  const tenantId = typeof query.tenant === 'string' ? query.tenant : undefined;
  const workspaceId = typeof query.workspace === 'string' ? query.workspace : undefined;
  const experimentId = typeof query.experiment === 'string' ? query.experiment : undefined;
  if (tenantId === undefined || workspaceId === undefined) redirect('/app');

  const cookie = (await cookies()).toString();
  const workspacesResponse = await fetch(`${apiOrigin()}/api/v1/tenants`, {
    cache: 'no-store',
    headers: { cookie },
  });
  if (!workspacesResponse.ok) redirect('/login');
  const workspaces = (await workspacesResponse.json()) as WorkspaceListEnvelope;
  const membership = workspaces.data.workspaces.find(
    (entry) => entry.tenant.id === tenantId && entry.workspace.id === workspaceId,
  );
  if (membership === undefined) redirect('/app');

  const optionsResponse = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/experiments/options?limit=100`,
    { cache: 'no-store', headers: { cookie } },
  );
  const options = optionsResponse.ok
    ? ExperimentOptionsEnvelopeSchema.parse(await optionsResponse.json()).data.options
    : {
        baselineRuns: [],
        remeasurementRuns: [],
        interventions: [],
        compatibleCombinations: [],
      };

  let experiment: Experiment | undefined;
  if (experimentId !== undefined) {
    const response = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/experiments/${experimentId}`,
      { cache: 'no-store', headers: { cookie } },
    );
    if (response.ok)
      experiment = ExperimentEnvelopeSchema.parse(await response.json()).data.experiment;
  }

  const canCreate = ['OWNER', 'ADMIN', 'ANALYST'].includes(membership.activeRole);
  const candidatesAvailable = options.compatibleCombinations.length > 0;

  return (
    <main>
      <p className="eyebrow">AEO Studio · Measurement</p>
      <h1>Experiment Comparison</h1>
      <p>
        只比较完全兼容的 immutable MetricSnapshot，并把一次 exact published 或 approved intervention
        event 放在 baseline 与 remeasurement 之间解释。结果仅为描述性 observed association。
      </p>
      <a href={`/app?tenant=${tenantId}&workspace=${workspaceId}`}>返回 Workspace</a>

      {query.notice === 'created' ? (
        <p className="success-message" role="status">
          Experiment 已按 exact snapshots 与 intervention 封存。
        </p>
      ) : null}
      {typeof query.error === 'string' ? (
        <p className="error-message" role="alert">
          Experiment 未创建：{query.error}。不兼容时请建立新 baseline 或按 scope 分层。
        </p>
      ) : null}

      <section aria-labelledby="experiment-input-heading" className="shell-card">
        <h2 id="experiment-input-heading">选择可比较输入</h2>
        <p>
          Baseline 必须早于 intervention event；remeasurement 必须晚于 event，且
          scenario、method、Provider、Surface、model、scope 与采集方式必须兼容。
        </p>
        {!candidatesAvailable ? (
          <p data-testid="experiment-options-empty">
            尚缺 COMPLETED baseline、COMPLETED remeasurement，或时间窗口内的 exact PUBLISHED /
            APPROVED intervention event。
          </p>
        ) : null}
        {canCreate && candidatesAvailable ? (
          <form action={createExperiment} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <input name="idempotencyKey" type="hidden" value={randomUUID()} />
            <label htmlFor="experiment-compatible-inputs">Compatible Experiment inputs</label>
            <select id="experiment-compatible-inputs" name="combination" required>
              {options.compatibleCombinations.map((combination) => (
                <option
                  key={`${combination.baselineRunId}:${combination.intervention.kind}:${interventionOptionId(combination.intervention)}:${combination.remeasurementRunId}`}
                  value={JSON.stringify(combination)}
                >
                  Baseline {combination.baselineRunId} ·{' '}
                  {combination.intervention.kind === 'PUBLISHED_PUBLICATION'
                    ? `Publication ${combination.intervention.publicationRecordId} / attempt ${combination.intervention.publicationAttemptId} / review ${combination.intervention.artifactReviewId}`
                    : `Approval ${combination.intervention.artifactReviewId}`}{' '}
                  · Remeasurement {combination.remeasurementRunId}
                </option>
              ))}
            </select>
            <button className="primary-action" type="submit">
              创建 Experiment comparison
            </button>
          </form>
        ) : null}
      </section>

      {experiment === undefined ? null : <ExperimentReport experiment={experiment} />}

      <p className="warning-message">
        本报告不证明 intervention 导致任何变化，也不保证排名、引用、推荐、流量或业务结果。
      </p>
    </main>
  );
}

function ExperimentReport({ experiment }: { experiment: Experiment }) {
  return (
    <section
      aria-labelledby="experiment-report-heading"
      className="shell-card"
      data-testid="experiment-report"
    >
      <p className="eyebrow">COMPARABLE · immutable snapshot report</p>
      <h2 id="experiment-report-heading">Observed association（描述性，不是因果）</h2>
      <p data-testid="experiment-scenario-version">
        Scenario version：{experiment.scenarioVersion}
      </p>
      <section data-testid="experiment-measurement-context">
        <h3>Sealed measurement context</h3>
        <p>Scenario：{experiment.measurementContext.scenarioId}</p>
        <p>Provider：{experiment.measurementContext.providerKey}</p>
        <p>Surface：{experiment.measurementContext.surfaceKey}</p>
        <p>
          Model：{experiment.measurementContext.model} /{' '}
          {experiment.measurementContext.modelVersion}
        </p>
        <article data-testid="experiment-baseline-timeline">
          <h4>Baseline timeline</h4>
          <p>Run started：{experiment.measurementContext.timeline.baseline.startedAt}</p>
          <p>Run completed：{experiment.measurementContext.timeline.baseline.completedAt}</p>
          <p>
            Evidence window：
            {experiment.measurementContext.timeline.baseline.evidenceWindow.minObservedAt} →{' '}
            {experiment.measurementContext.timeline.baseline.evidenceWindow.maxObservedAt}
          </p>
        </article>
        <article data-testid="experiment-remeasurement-timeline">
          <h4>Remeasurement timeline</h4>
          <p>Run started：{experiment.measurementContext.timeline.remeasurement.startedAt}</p>
          <p>Run completed：{experiment.measurementContext.timeline.remeasurement.completedAt}</p>
          <p>
            Evidence window：
            {
              experiment.measurementContext.timeline.remeasurement.evidenceWindow.minObservedAt
            } → {experiment.measurementContext.timeline.remeasurement.evidenceWindow.maxObservedAt}
          </p>
        </article>
      </section>
      <p>{experiment.observedAssociation}</p>
      <p>{experiment.caveat}</p>
      <p>{experiment.noGuarantee}</p>

      <article data-testid="experiment-intervention">
        <h3>
          {experiment.intervention.kind === 'PUBLISHED_PUBLICATION'
            ? 'Exact published intervention'
            : 'Exact approved Artifact event'}
        </h3>
        <p>State：{experiment.intervention.applicationState}</p>
        <p>Event recorded at：{experiment.intervention.observedAt}</p>
        <p>Artifact：{experiment.intervention.artifactId}</p>
        <p>Artifact revision：{experiment.intervention.artifactRevisionId}</p>
        <p>Artifact hash：{experiment.intervention.artifactContentHash}</p>
        {experiment.intervention.kind === 'PUBLISHED_PUBLICATION' ? (
          <>
            <p>Publication：{experiment.intervention.publicationRecordId}</p>
            <p>Applied attempt：{experiment.intervention.publicationAttemptId}</p>
            <p>Approval review：{experiment.intervention.artifactReviewId}</p>
          </>
        ) : (
          <>
            <p>Approval review：{experiment.intervention.artifactReviewId}</p>
            <p>{experiment.intervention.applicationDisclosure}</p>
          </>
        )}
        <a href={experiment.drillDown.interventionHref}>
          {experiment.intervention.kind === 'PUBLISHED_PUBLICATION'
            ? '查看 exact published intervention'
            : '查看 exact approved Artifact'}
        </a>
      </article>

      <div className="metric-grid">
        {experiment.comparisons.map((comparison) => (
          <article
            className="metric-card"
            data-testid="experiment-metric"
            key={comparison.compatibilityHash}
          >
            <h3>{comparison.metricKey}</h3>
            <p>Scope：{comparison.scopeKey}</p>
            <p>Compatibility：{comparison.compatibilityHash}</p>
            <p>
              Descriptive delta：
              {comparison.delta.value === null
                ? 'NOT_COMPUTABLE'
                : comparison.delta.value.toFixed(6)}
            </p>
            <p>
              Sample：baseline {comparison.baseline.sampleSize} / remeasurement{' '}
              {comparison.remeasurement.sampleSize}
            </p>
            <p>
              Eligible denominator：{comparison.baseline.eligibleDenominator} →{' '}
              {comparison.remeasurement.eligibleDenominator}
            </p>
            <p>Excluded baseline：{formatExcluded(comparison.baseline.excludedCounts)}</p>
            <p>Excluded remeasurement：{formatExcluded(comparison.remeasurement.excludedCounts)}</p>
            <p>Cost baseline：{formatCosts(comparison.costBreakdown.baseline)}</p>
            <p>Cost remeasurement：{formatCosts(comparison.costBreakdown.remeasurement)}</p>
          </article>
        ))}
      </div>

      <nav aria-label="Experiment evidence drill-down">
        <a href={experiment.drillDown.baselineRunHref}>查看 baseline raw evidence</a>
        <a href={experiment.drillDown.remeasurementRunHref}>查看 remeasurement raw evidence</a>
      </nav>
    </section>
  );
}

function formatExcluded(counts: Experiment['excludedCounts']['baseline']): string {
  return `ERROR ${counts.ERROR} · NOT_CHECKED ${counts.NOT_CHECKED} · INCONCLUSIVE ${counts.INCONCLUSIVE} · NOT_APPLICABLE ${counts.NOT_APPLICABLE}`;
}

function formatCosts(costs: Experiment['costBreakdown']['baseline']): string {
  return costs.length === 0
    ? 'none recorded'
    : `${costs.map((entry) => `${entry.amount} ${entry.currency}`).join(' + ')}（未换汇）`;
}

function interventionOptionId(
  intervention: ExperimentCompatibleCombination['intervention'],
): string {
  return intervention.kind === 'PUBLISHED_PUBLICATION'
    ? `${intervention.publicationRecordId}:${intervention.publicationAttemptId}:${intervention.artifactReviewId}`
    : intervention.artifactReviewId;
}
