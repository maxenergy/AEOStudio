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

import { makeT, type TFunction } from '../../../lib/i18n';
import { getLocale } from '../../../lib/i18n/get-locale';
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

  const t = makeT(await getLocale());
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
      <p className="eyebrow">{t('measurement.eyebrow')}</p>
      <h1>{t('measurement.title')}</h1>
      <p className="lede">{t('measurement.lede')}</p>
      <nav aria-label={t('measurement.navAria')} className="breadcrumb">
        <a href={`/app/prompts?tenant=${tenantId}&workspace=${workspaceId}`}>
          {t('measurement.breadcrumbPrompts')}
        </a>
        <a href={`/app?tenant=${tenantId}&workspace=${workspaceId}`}>
          {t('measurement.breadcrumbWorkspace')}
        </a>
      </nav>

      <section aria-labelledby="measurement-execution-heading" className="shell-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{t('measurement.runEvidenceEyebrow')}</p>
            <h2 id="measurement-execution-heading">{t('measurement.executionHeading')}</h2>
          </div>
          <strong className="status-badge neutral" data-testid="measurement-run-status">
            {run.status}
          </strong>
        </div>
        <p data-testid="measurement-run-progress">
          {t('measurement.runProgress', {
            completed: run.completedPromptRunCount,
            expected: run.expectedPromptRunCount,
          })}
        </p>
        <p className="monospace break-anywhere">{t('measurement.runId', { id: run.id })}</p>
        <p>
          {t('measurement.jobLine', {
            status: job?.status ?? 'PENDING',
            progress: job?.progress ?? 0,
            repetitions: run.scenarioSnapshot.repetitions,
          })}
        </p>
        <p>
          {t('measurement.startedLabel')}
          {run.startedAt ?? t('measurement.awaitingWorker')}
          {t('measurement.completedLabel')}
          {run.completedAt ?? t('measurement.notCompleted')}
        </p>
        {dashboard === undefined ? (
          <p className="field-help">{t('measurement.snapshotPending')}</p>
        ) : (
          <div className="table-scroll">
            <table>
              <caption>{t('measurement.resultCountsCaption')}</caption>
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
        <p className="eyebrow">{t('measurement.stepOne')}</p>
        <h2 id="technical-health-heading">{t('measurement.technicalHeading')}</h2>
        {technicalSection?.summary.state === 'AVAILABLE' ? (
          <p>
            {t('measurement.technicalSummary', {
              baselineId: technicalSection.summary.baselineId,
              status: technicalSection.summary.status,
              pageCount: technicalSection.summary.pageCount,
              findingCount: technicalSection.summary.findingCount,
            })}
          </p>
        ) : (
          <p>{t('measurement.technicalNotLinked')}</p>
        )}
        <p className="field-help">{t('measurement.technicalHelp')}</p>
        <a href={`/app/sites?tenant=${tenantId}&workspace=${workspaceId}`}>
          {t('measurement.viewTechnicalBaseline')}
        </a>
      </section>

      <section aria-labelledby="content-evidence-heading" className="shell-card">
        <p className="eyebrow">{t('measurement.stepTwo')}</p>
        <h2 id="content-evidence-heading">{t('measurement.contentHeading')}</h2>
        {contentSection?.summary.state === 'AVAILABLE' ? (
          <p>
            {t('measurement.contentSummary', {
              hash: contentSection.summary.claimSetHash,
              approved: contentSection.summary.approvedCount,
              stale: contentSection.summary.staleCount,
              needs: contentSection.summary.needsEvidenceCount,
            })}
          </p>
        ) : (
          <p>{t('measurement.contentNotLinked')}</p>
        )}
        <p>{t('measurement.contentNote')}</p>
        <a href={`/app/claims?tenant=${tenantId}&workspace=${workspaceId}`}>
          {t('measurement.viewClaims')}
        </a>
      </section>

      <section
        aria-labelledby="measured-visibility-heading"
        className="shell-card"
        data-testid="measured-ai-visibility"
      >
        <p className="eyebrow">{t('measurement.stepThree')}</p>
        <h2 id="measured-visibility-heading">{t('measurement.visibilityHeading')}</h2>
        <p>
          {t('measurement.cohortLine', {
            surface: registryEntry?.surfaceName ?? run.surfaceKey,
            provider: registryEntry?.providerName ?? run.providerKey,
            method: run.acquisitionMethod,
          })}
        </p>
        <p>
          {t('measurement.modelLine', {
            model: run.model,
            version: run.modelVersion,
            scenario: run.scenarioVersion,
          })}
        </p>
        {dashboard === undefined ? (
          <p className="field-help">{t('measurement.snapshotNotReady')}</p>
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
                  <h3>{t('measurement.surfaceCohort', { index: cohortIndex + 1 })}</h3>
                  <p>
                    {t('measurement.scopeLine', {
                      scope: cohortEntry.cohort.scopeKey,
                      provider: cohortEntry.cohort.providerKey,
                      surface: cohortEntry.cohort.surfaceKey,
                    })}
                  </p>
                  <p>
                    {t('measurement.acquisitionLine', {
                      class: cohortEntry.cohort.acquisitionClass,
                      method: cohortEntry.cohort.acquisitionMethod,
                      model: cohortEntry.cohort.model,
                      version: cohortEntry.cohort.modelVersion,
                    })}
                  </p>
                  <p>
                    {t('measurement.adapterLine', {
                      key: cohortEntry.cohort.adapterKey,
                      version: cohortEntry.cohort.adapterVersion,
                      scenario: cohortEntry.cohort.scenarioVersion,
                    })}
                  </p>
                  <div className="table-scroll">
                    <table>
                      <caption>{t('measurement.metricsCaption')}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{t('measurement.colMetric')}</th>
                          <th scope="col">{t('measurement.colResult')}</th>
                          <th scope="col">{t('measurement.colDenominator')}</th>
                          <th scope="col">{t('measurement.colExcluded')}</th>
                          <th scope="col">{t('measurement.colMethod')}</th>
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
                              {t('measurement.excludedLine', {
                                error: metric.excludedCounts.ERROR,
                                notChecked: metric.excludedCounts.NOT_CHECKED,
                                inconclusive: metric.excludedCounts.INCONCLUSIVE,
                                notApplicable: metric.excludedCounts.NOT_APPLICABLE,
                              })}
                            </td>
                            <td>{metric.methodVersion}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <nav aria-label={t('measurement.rawEvidenceNavAria', { index: cohortIndex + 1 })}>
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
                            {t('measurement.viewMetricRaw', {
                              metric: METRIC_LABELS[metric.metricKey],
                            })}
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
                            {t('measurement.viewMetricRaw', { metric: dimension })}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </nav>
                </article>
              );
            })}
            <p>
              {t('measurement.costLabel')}
              {formatDashboardCost(dashboard, t('measurement.costNotConvertedSuffix'))}{' '}
              {t('measurement.costRunSuffix')}
            </p>
          </>
        )}
        <p className="warning-message">{t('measurement.sampleWarning')}</p>
      </section>

      {rawMetric === undefined ? null : (
        <section aria-labelledby="raw-evidence-heading" className="shell-card">
          <h2 id="raw-evidence-heading">{t('measurement.rawEvidenceHeading')}</h2>
          <p>
            {t('measurement.dimensionLabel')}
            <strong data-testid="raw-dimension">{rawMetric}</strong>
            {t('measurement.cohortSeparator')}
            {rawCohort ?? t('measurement.currentCohort')}
            {t('measurement.auditableSeparator')}
            <strong data-testid="raw-result-total">
              {promptRunEnvelope?.meta.total ?? rawPromptRuns.length}
            </strong>
            {t('measurement.offsetNote', { offset: rawOffset })}
          </p>
          <div className="table-scroll">
            <table>
              <caption>{t('measurement.drillDownCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('measurement.colPromptRun')}</th>
                  <th scope="col">{t('measurement.colDimensionValue')}</th>
                  <th scope="col">{t('measurement.colStatus')}</th>
                  <th scope="col">{t('measurement.colRawEvidence')}</th>
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
                    <td>{rawDimensionValue(promptRun, rawMetric, t)}</td>
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
                        {t('measurement.viewRunEvidence')}
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
                    {t('measurement.promptRunTitle', {
                      ordinal: entry.promptRun.promptOrdinal,
                      repetition: entry.promptRun.repetition,
                    })}
                  </h3>
                  <p>
                    {t('measurement.statusLabel')}
                    <strong>{entry.promptRun.status}</strong>
                  </p>
                  <p>
                    {t('measurement.rawResponseLabel')}
                    {entry.rawEvidence.responseText ?? t('measurement.noResponse')}
                  </p>
                  <p>
                    {t('measurement.citationLabel')}
                    {entry.rawEvidence.citations.length === 0
                      ? t('measurement.noCitations')
                      : entry.rawEvidence.citations
                          .map((citation) => `${citation.title} — ${citation.url}`)
                          .join(t('measurement.citationSeparator'))}
                  </p>
                  <p>
                    {t('measurement.costValue', {
                      amount: entry.promptRun.cost.amount,
                      currency: entry.promptRun.cost.currency,
                    })}
                  </p>
                  <p>
                    {t('measurement.errorLabel')}
                    {entry.rawEvidence.error === null
                      ? t('measurement.noError')
                      : t('measurement.errorValue', {
                          status: entry.promptRun.status,
                          code: entry.rawEvidence.error.code,
                          message: entry.rawEvidence.error.message,
                        })}
                  </p>
                  <p className="monospace break-anywhere">
                    {t('measurement.evidenceHash', { hash: entry.rawEvidence.contentHash })}
                  </p>
                </article>
              ),
            )}
          </div>
          <nav aria-label={t('measurement.paginationNavAria')} className="breadcrumb">
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
                {t('measurement.prevPage')}
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
                {t('measurement.nextPage')}
              </a>
            )}
          </nav>
        </section>
      )}
    </main>
  );
}

function rawDimensionValue(
  promptRun: PromptRunSummary,
  dimension: RawDimension,
  t: TFunction,
): string {
  const excluded = t('measurement.excludedStatus', { status: promptRun.status });
  switch (dimension) {
    case 'MENTION_RATE':
      return t('measurement.mentionObservation', {
        value: booleanObservation(promptRun.observation.mention, excluded),
      });
    case 'CITATION_RATE':
      return t('measurement.citationObservation', {
        value: booleanObservation(promptRun.observation.citation, excluded),
      });
    case 'ACCURACY_RATE':
      return t('measurement.accuracyObservation', {
        value: promptRun.observation.accuracy ?? excluded,
      });
    case 'COVERAGE_RATE':
      return t('measurement.coverageObservation', {
        value: booleanObservation(promptRun.observation.coverage, excluded),
      });
    case 'COST':
      return t('measurement.costObservation', {
        amount: promptRun.cost.amount,
        currency: promptRun.cost.currency,
      });
    case 'ERROR':
      return `${t('measurement.errorObservation', { status: promptRun.status })}${
        promptRun.policyReason === null
          ? ''
          : t('measurement.errorPolicySuffix', { reason: promptRun.policyReason })
      }`;
  }
}

function booleanObservation(value: boolean | null, excluded: string): string {
  return value === null ? excluded : value ? 'true' : 'false';
}
