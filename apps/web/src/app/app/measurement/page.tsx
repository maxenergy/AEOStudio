import type {
  JobEnvelope,
  PromptRegistryEnvelope,
  WorkspaceListEnvelope,
} from '@aeostudio/contracts';
import type {
  MeasurementDashboardEnvelope,
  MeasurementPromptRunListEnvelope,
  MeasurementRunEnvelope,
  PromptRunEnvelope,
} from '@aeostudio/contracts/measurement';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { JobPoller } from '../jobs/job-poller';
import { formatDashboardCost } from './cost-summary';

function apiOrigin(): string {
  return process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3200';
}

function measurementPath(tenantId: string, workspaceId: string): string {
  return `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/measurement-runs`;
}

function measurementLocation(input: {
  tenantId: string;
  workspaceId: string;
  measurementRunId: string;
  rawMetric?: string;
  cohort?: string;
  promptRunId?: string;
  offset?: number;
}): string {
  const query = new URLSearchParams({
    tenant: input.tenantId,
    workspace: input.workspaceId,
    run: input.measurementRunId,
  });
  if (input.rawMetric !== undefined) query.set('raw', input.rawMetric);
  if (input.cohort !== undefined) query.set('cohort', input.cohort);
  if (input.promptRunId !== undefined) query.set('promptRun', input.promptRunId);
  if (input.offset !== undefined && input.offset > 0) query.set('offset', String(input.offset));
  return `/app/measurement?${query.toString()}`;
}

const METRIC_LABELS = {
  MENTION_RATE: 'Mention',
  CITATION_RATE: 'Citation',
  ACCURACY_RATE: 'Accuracy',
  COVERAGE_RATE: 'Coverage',
} as const;

const RAW_DIMENSIONS = [
  'MENTION_RATE',
  'CITATION_RATE',
  'ACCURACY_RATE',
  'COVERAGE_RATE',
  'COST',
  'ERROR',
] as const;
type RawDimension = (typeof RAW_DIMENSIONS)[number];
type PromptRunSummary = MeasurementPromptRunListEnvelope['data']['promptRuns'][number];

interface MeasurementPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function MeasurementPage({ searchParams }: MeasurementPageProps) {
  const query = await searchParams;
  const tenantId = typeof query.tenant === 'string' ? query.tenant : undefined;
  const workspaceId = typeof query.workspace === 'string' ? query.workspace : undefined;
  const measurementRunId = typeof query.run === 'string' ? query.run : undefined;
  if (tenantId === undefined || workspaceId === undefined || measurementRunId === undefined) {
    redirect('/app');
  }

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

  const requestedRawMetric = typeof query.raw === 'string' ? query.raw : undefined;
  const rawMetric = RAW_DIMENSIONS.find((dimension) => dimension === requestedRawMetric);
  const rawCohort = typeof query.cohort === 'string' ? query.cohort : undefined;
  const requestedOffset = typeof query.offset === 'string' ? Number(query.offset) : 0;
  const rawOffset =
    Number.isInteger(requestedOffset) && requestedOffset >= 0 && requestedOffset <= 100_000
      ? requestedOffset
      : 0;
  const promptRunQuery = new URLSearchParams({ limit: '100', offset: String(rawOffset) });
  if (rawCohort !== undefined) promptRunQuery.set('scopeKey', rawCohort);
  if (rawMetric !== undefined) promptRunQuery.set('dimension', rawMetric);

  const basePath = measurementPath(tenantId, workspaceId);
  let runResponse = await fetch(`${basePath}/${measurementRunId}`, {
    cache: 'no-store',
    headers: { cookie },
  });
  if (!runResponse.ok) redirect(`/app?tenant=${tenantId}&workspace=${workspaceId}`);
  let run = ((await runResponse.json()) as MeasurementRunEnvelope).data.measurementRun;

  let job: JobEnvelope['data']['job'] | undefined;
  if (run.jobId !== null) {
    const jobResponse = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/jobs/${run.jobId}`,
      { cache: 'no-store', headers: { cookie } },
    );
    if (jobResponse.ok) job = ((await jobResponse.json()) as JobEnvelope).data.job;

    // The fake browser runtime advances queued work when the Job is observed. Re-read the Run
    // after the Job response so the page never renders a stale progress value.
    // Use a distinct URL after observing the Job. React memoizes identical GET requests within
    // one Server Component render even when the underlying in-memory Job processor mutated Run
    // state during the first request.
    runResponse = await fetch(
      `${basePath}/${measurementRunId}?afterJob=${encodeURIComponent(job?.status ?? 'UNKNOWN')}`,
      {
        cache: 'no-store',
        headers: { cookie },
      },
    );
    if (runResponse.ok) {
      run = ((await runResponse.json()) as MeasurementRunEnvelope).data.measurementRun;
    }
  }

  const [registryResponse, dashboardResponse, promptRunsResponse] = await Promise.all([
    fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/measurement-registry`,
      { cache: 'no-store', headers: { cookie } },
    ),
    fetch(`${basePath}/${measurementRunId}/dashboard`, {
      cache: 'no-store',
      headers: { cookie },
    }),
    fetch(`${basePath}/${measurementRunId}/prompt-runs?${promptRunQuery.toString()}`, {
      cache: 'no-store',
      headers: { cookie },
    }),
  ]);

  const registry = registryResponse.ok
    ? ((await registryResponse.json()) as PromptRegistryEnvelope).data.entries
    : [];
  const registryEntry = registry.find(
    (entry) => entry.providerKey === run.providerKey && entry.surfaceKey === run.surfaceKey,
  );
  const dashboard = dashboardResponse.ok
    ? ((await dashboardResponse.json()) as MeasurementDashboardEnvelope).data
    : undefined;
  const promptRunEnvelope = promptRunsResponse.ok
    ? ((await promptRunsResponse.json()) as MeasurementPromptRunListEnvelope)
    : undefined;
  const promptRunList = promptRunEnvelope?.data.promptRuns ?? [];

  const selectedPromptRunId = typeof query.promptRun === 'string' ? query.promptRun : undefined;
  const metricSourceIds = new Set(
    rawMetric === undefined || rawMetric === 'COST' || rawMetric === 'ERROR'
      ? []
      : (dashboard?.snapshot.metrics.find(
          (metric) =>
            metric.metricKey === rawMetric &&
            (rawCohort === undefined || metric.cohort.scopeKey === rawCohort),
        )?.promptRunIds ?? []),
  );
  const rawPromptRuns = promptRunList
    .filter((promptRun) => rawCohort === undefined || promptRun.scopeKey === rawCohort)
    .filter((promptRun) => {
      if (rawMetric === undefined || rawMetric === 'COST') return true;
      if (rawMetric === 'ERROR') return promptRun.status === 'ERROR';
      return metricSourceIds.has(promptRun.id);
    });
  const promptRunsForEvidence = (() => {
    if (rawMetric === undefined) return [];
    const selected =
      selectedPromptRunId === undefined
        ? undefined
        : rawPromptRuns.find((promptRun) => promptRun.id === selectedPromptRunId);
    return [selected ?? rawPromptRuns[0]].filter((promptRun) => promptRun !== undefined);
  })();
  const evidence = await Promise.all(
    promptRunsForEvidence.map(async (promptRun) => {
      const response = await fetch(`${basePath}/${measurementRunId}/prompt-runs/${promptRun.id}`, {
        cache: 'no-store',
        headers: { cookie },
      });
      return response.ok ? ((await response.json()) as PromptRunEnvelope).data : undefined;
    }),
  );

  const measuredSection = dashboard?.sections.find(
    (section) => section.key === 'MEASURED_AI_VISIBILITY',
  );
  const technicalSection = dashboard?.sections.find(
    (section) => section.key === 'TECHNICAL_HEALTH',
  );
  const contentSection = dashboard?.sections.find(
    (section) => section.key === 'CONTENT_EVIDENCE_READINESS',
  );
  const pollStatus = job?.status ?? run.status;

  return (
    <main>
      <JobPoller status={pollStatus} />
      <p className="eyebrow">AEO Studio · Measurement Evidence</p>
      <h1>Measurement baseline dashboard</h1>
      <p className="lede">
        本页只解释一个 approved Scenario 的单一 Surface cohort；不会把 API、Search data 与 Consumer
        Surface 合成跨 Surface 总分，也不会把未检查或错误当作失败。
      </p>
      <nav aria-label="Measurement navigation" className="breadcrumb">
        <a href={`/app/prompts?tenant=${tenantId}&workspace=${workspaceId}`}>
          Prompt / Scenario Lab
        </a>
        <a href={`/app?tenant=${tenantId}&workspace=${workspaceId}`}>Workspace</a>
      </nav>

      <section aria-labelledby="measurement-execution-heading" className="shell-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Run evidence</p>
            <h2 id="measurement-execution-heading">Measurement execution</h2>
          </div>
          <strong className="status-badge neutral" data-testid="measurement-run-status">
            {run.status}
          </strong>
        </div>
        <p data-testid="measurement-run-progress">
          {run.completedPromptRunCount} / {run.expectedPromptRunCount} PromptRuns
        </p>
        <p className="monospace break-anywhere">Run ID：{run.id}</p>
        <p>
          Job：{job?.status ?? 'PENDING'} · {job?.progress ?? 0}% · expected{' '}
          {run.scenarioSnapshot.repetitions} repetitions for each Prompt / scope
        </p>
        <p>
          Started：{run.startedAt ?? '等待 Worker'} · Completed：{run.completedAt ?? '尚未完成'}
        </p>
        {dashboard === undefined ? (
          <p className="field-help">
            Snapshot 将在全部 fixture/manual-import PromptRuns 处理后生成。
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <caption>PromptRun result counts</caption>
              <thead>
                <tr>
                  {Object.keys(dashboard.resultCounts).map((status) => (
                    <th key={status} scope="col">
                      {status}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {Object.values(dashboard.resultCounts).map((count, index) => (
                    <td key={Object.keys(dashboard.resultCounts)[index]}>{count}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="technical-health-heading" className="shell-card">
        <p className="eyebrow">1 / 3</p>
        <h2 id="technical-health-heading">Technical Health</h2>
        {technicalSection?.summary.state === 'AVAILABLE' ? (
          <p>
            Owned-site baseline {technicalSection.summary.baselineId} ·{' '}
            {technicalSection.summary.status} · {technicalSection.summary.pageCount} pages ·{' '}
            {technicalSection.summary.findingCount} findings.
          </p>
        ) : (
          <p>此 Measurement Scenario 尚未绑定 owned-site technical baseline。</p>
        )}
        <p className="field-help">
          Technical Health 只来自已验证站点的 crawl/baseline，不从 AI visibility PromptRun 推断。
        </p>
        <a href={`/app/sites?tenant=${tenantId}&workspace=${workspaceId}`}>
          查看 Site Technical Baseline
        </a>
      </section>

      <section aria-labelledby="content-evidence-heading" className="shell-card">
        <p className="eyebrow">2 / 3</p>
        <h2 id="content-evidence-heading">Content &amp; Evidence Readiness</h2>
        {contentSection?.summary.state === 'AVAILABLE' ? (
          <p>
            Claim set {contentSection.summary.claimSetHash} · approved{' '}
            {contentSection.summary.approvedCount} · stale {contentSection.summary.staleCount} ·
            needs evidence {contentSection.summary.needsEvidenceCount}.
          </p>
        ) : (
          <p>此 Measurement Scenario 尚未绑定 exact Claim/Evidence set。</p>
        )}
        <p>
          Measurement 不会把 visibility observation 当成事实证据。公开事实仍须回到 exact approved
          Claim revision 与 Evidence Source 核验。
        </p>
        <a href={`/app/claims?tenant=${tenantId}&workspace=${workspaceId}`}>
          查看 Approved Claim / Evidence
        </a>
      </section>

      <section
        aria-labelledby="measured-visibility-heading"
        className="shell-card"
        data-testid="measured-ai-visibility"
      >
        <p className="eyebrow">3 / 3</p>
        <h2 id="measured-visibility-heading">Measured AI Visibility</h2>
        <p>
          Cohort：{registryEntry?.surfaceName ?? run.surfaceKey} ·{' '}
          {registryEntry?.providerName ?? run.providerKey} · {run.acquisitionMethod}
        </p>
        <p>
          Model：{run.model} · {run.modelVersion} · Scenario v{run.scenarioVersion}
        </p>
        {dashboard === undefined ? (
          <p className="field-help">Measured snapshot 尚未生成。</p>
        ) : (
          <>
            {(measuredSection?.cohorts ?? []).map((cohortEntry, cohortIndex) => {
              const cohortMetrics = dashboard.snapshot.metrics.filter(
                (metric) =>
                  metric.cohort.providerKey === cohortEntry.cohort.providerKey &&
                  metric.cohort.surfaceKey === cohortEntry.cohort.surfaceKey &&
                  metric.cohort.model === cohortEntry.cohort.model &&
                  metric.cohort.modelVersion === cohortEntry.cohort.modelVersion &&
                  metric.cohort.scenarioId === cohortEntry.cohort.scenarioId &&
                  metric.cohort.scenarioVersion === cohortEntry.cohort.scenarioVersion &&
                  metric.cohort.acquisitionClass === cohortEntry.cohort.acquisitionClass &&
                  metric.cohort.acquisitionMethod === cohortEntry.cohort.acquisitionMethod &&
                  metric.cohort.adapterKey === cohortEntry.cohort.adapterKey &&
                  metric.cohort.adapterVersion === cohortEntry.cohort.adapterVersion &&
                  metric.cohort.scopeKey === cohortEntry.cohort.scopeKey,
              );
              return (
                <article className="nested-card manifest-panel" key={cohortEntry.cohort.scopeKey}>
                  <h3>Surface cohort {cohortIndex + 1}</h3>
                  <p>
                    Scope：{cohortEntry.cohort.scopeKey} · Provider/Surface：
                    {cohortEntry.cohort.providerKey} / {cohortEntry.cohort.surfaceKey}
                  </p>
                  <p>
                    Acquisition：{cohortEntry.cohort.acquisitionClass} /{' '}
                    {cohortEntry.cohort.acquisitionMethod} · Model：{cohortEntry.cohort.model} ·{' '}
                    {cohortEntry.cohort.modelVersion}
                  </p>
                  <p>
                    Adapter：{cohortEntry.cohort.adapterKey} / {cohortEntry.cohort.adapterVersion} ·
                    Scenario v{cohortEntry.cohort.scenarioVersion}
                  </p>
                  <div className="table-scroll">
                    <table>
                      <caption>Metrics for this exact Surface and scope cohort</caption>
                      <thead>
                        <tr>
                          <th scope="col">Metric</th>
                          <th scope="col">Result</th>
                          <th scope="col">Eligible denominator</th>
                          <th scope="col">Excluded</th>
                          <th scope="col">Method</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cohortMetrics.map((metric) => (
                          <tr key={metric.id}>
                            <th scope="row">{METRIC_LABELS[metric.metricKey]}</th>
                            <td>
                              {metric.value === null
                                ? 'N/A'
                                : `${(metric.value * 100).toFixed(1)}%`}{' '}
                              ({metric.numerator}/{metric.eligibleDenominator})
                            </td>
                            <td>{metric.eligibleDenominator}</td>
                            <td>
                              ERROR {metric.excludedCounts.ERROR} · NOT_CHECKED{' '}
                              {metric.excludedCounts.NOT_CHECKED} · INCONCLUSIVE{' '}
                              {metric.excludedCounts.INCONCLUSIVE} · NOT_APPLICABLE{' '}
                              {metric.excludedCounts.NOT_APPLICABLE}
                            </td>
                            <td>{metric.methodVersion}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <nav aria-label={`Surface cohort ${cohortIndex + 1} raw evidence`}>
                    <ul>
                      {cohortMetrics.map((metric) => (
                        <li key={`raw-${metric.id}`}>
                          <a
                            href={measurementLocation({
                              tenantId,
                              workspaceId,
                              measurementRunId,
                              rawMetric: metric.metricKey,
                              cohort: cohortEntry.cohort.scopeKey,
                            })}
                          >
                            查看 {METRIC_LABELS[metric.metricKey]} raw PromptRuns
                          </a>
                        </li>
                      ))}
                      {(['Cost', 'Error'] as const).map((dimension) => (
                        <li key={`raw-${dimension}`}>
                          <a
                            href={measurementLocation({
                              tenantId,
                              workspaceId,
                              measurementRunId,
                              rawMetric: dimension.toUpperCase(),
                              cohort: cohortEntry.cohort.scopeKey,
                            })}
                          >
                            查看 {dimension} raw PromptRuns
                          </a>
                        </li>
                      ))}
                    </ul>
                  </nav>
                </article>
              );
            })}
            <p>
              Cost：{formatDashboardCost(dashboard)} for this run. ERROR、NOT_CHECKED、INCONCLUSIVE
              与 NOT_APPLICABLE 均保留并从 eligible denominator 排除。
            </p>
          </>
        )}
        <p className="warning-message">
          样本仅代表上述
          Provider、Surface、模型版本、scope、时间与采集方式；不保证排名、引用或推荐。
        </p>
      </section>

      {rawMetric === undefined ? null : (
        <section aria-labelledby="raw-evidence-heading" className="shell-card">
          <h2 id="raw-evidence-heading">Raw PromptRun evidence</h2>
          <p>
            Dimension：<strong data-testid="raw-dimension">{rawMetric}</strong> · Cohort：
            {rawCohort ?? 'current'} · 可审计 PromptRuns：
            <strong data-testid="raw-result-total">
              {promptRunEnvelope?.meta.total ?? rawPromptRuns.length}
            </strong>
            。当前页 offset {rawOffset}；下列清单与 total/分页均使用同一维度过滤条件。
          </p>
          <div className="table-scroll">
            <table>
              <caption>PromptRuns contributing to this exact drill-down dimension</caption>
              <thead>
                <tr>
                  <th scope="col">PromptRun</th>
                  <th scope="col">Dimension value</th>
                  <th scope="col">Status</th>
                  <th scope="col">Raw evidence</th>
                </tr>
              </thead>
              <tbody>
                {rawPromptRuns.map((promptRun) => (
                  <tr
                    data-run-status={promptRun.status}
                    data-testid="raw-prompt-run-row"
                    key={promptRun.id}
                  >
                    <th scope="row">
                      {promptRun.promptOrdinal}.{promptRun.repetition}
                    </th>
                    <td>{rawDimensionValue(promptRun, rawMetric)}</td>
                    <td>{promptRun.status}</td>
                    <td>
                      <a
                        href={measurementLocation({
                          tenantId,
                          workspaceId,
                          measurementRunId,
                          rawMetric,
                          ...(rawCohort === undefined ? {} : { cohort: rawCohort }),
                          promptRunId: promptRun.id,
                          offset: rawOffset,
                        })}
                      >
                        查看此 PromptRun raw evidence
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="channel-grid">
            {evidence.map((entry) =>
              entry === undefined ? null : (
                <article
                  className="nested-card"
                  data-testid="prompt-run-evidence"
                  key={entry.promptRun.id}
                >
                  <h3>
                    PromptRun {entry.promptRun.promptOrdinal}.{entry.promptRun.repetition}
                  </h3>
                  <p>
                    Status：<strong>{entry.promptRun.status}</strong>
                  </p>
                  <p>Raw response：{entry.rawEvidence.responseText ?? 'No response recorded.'}</p>
                  <p>
                    Citation：
                    {entry.rawEvidence.citations.length === 0
                      ? 'None recorded.'
                      : entry.rawEvidence.citations
                          .map((citation) => `${citation.title} — ${citation.url}`)
                          .join('；')}
                  </p>
                  <p>
                    Cost：{entry.promptRun.cost.amount} {entry.promptRun.cost.currency}
                  </p>
                  <p>
                    Error：
                    {entry.rawEvidence.error === null
                      ? 'None.'
                      : `${entry.promptRun.status} · ${entry.rawEvidence.error.code} · ${entry.rawEvidence.error.message}`}
                  </p>
                  <p className="monospace break-anywhere">
                    Evidence hash：{entry.rawEvidence.contentHash}
                  </p>
                </article>
              ),
            )}
          </div>
          <nav aria-label="Raw PromptRun pagination" className="breadcrumb">
            {rawOffset === 0 ? null : (
              <a
                href={measurementLocation({
                  tenantId,
                  workspaceId,
                  measurementRunId,
                  rawMetric,
                  ...(rawCohort === undefined ? {} : { cohort: rawCohort }),
                  offset: Math.max(0, rawOffset - (promptRunEnvelope?.meta.limit ?? 100)),
                })}
              >
                上一页 PromptRuns
              </a>
            )}
            {promptRunEnvelope?.meta.nextOffset === null ||
            promptRunEnvelope?.meta.nextOffset === undefined ? null : (
              <a
                href={measurementLocation({
                  tenantId,
                  workspaceId,
                  measurementRunId,
                  rawMetric,
                  ...(rawCohort === undefined ? {} : { cohort: rawCohort }),
                  offset: promptRunEnvelope.meta.nextOffset,
                })}
              >
                下一页 PromptRuns
              </a>
            )}
          </nav>
        </section>
      )}
    </main>
  );
}

function rawDimensionValue(promptRun: PromptRunSummary, dimension: RawDimension): string {
  const excluded = `Excluded (${promptRun.status})`;
  switch (dimension) {
    case 'MENTION_RATE':
      return `Mention observation：${booleanObservation(promptRun.observation.mention, excluded)}`;
    case 'CITATION_RATE':
      return `Citation observation：${booleanObservation(promptRun.observation.citation, excluded)}`;
    case 'ACCURACY_RATE':
      return `Accuracy observation：${promptRun.observation.accuracy ?? excluded}`;
    case 'COVERAGE_RATE':
      return `Coverage observation：${booleanObservation(promptRun.observation.coverage, excluded)}`;
    case 'COST':
      return `Cost：${promptRun.cost.amount} ${promptRun.cost.currency}`;
    case 'ERROR':
      return `Error status：${promptRun.status}${
        promptRun.policyReason === null ? '' : ` · ${promptRun.policyReason}`
      }`;
  }
}

function booleanObservation(value: boolean | null, excluded: string): string {
  return value === null ? excluded : value ? 'true' : 'false';
}
