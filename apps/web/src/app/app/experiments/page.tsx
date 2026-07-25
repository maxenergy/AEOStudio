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

import { makeT, type TFunction } from '../../../lib/i18n';
import { getLocale } from '../../../lib/i18n/get-locale';

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
  const t = makeT(await getLocale());
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
      <p className="eyebrow">{t('experiments.eyebrow')}</p>
      <h1>{t('experiments.title')}</h1>
      <p>{t('experiments.lede')}</p>
      <a href={`/app?tenant=${tenantId}&workspace=${workspaceId}`}>
        {t('experiments.backToWorkspace')}
      </a>

      {query.notice === 'created' ? (
        <p className="success-message" role="status">
          {t('experiments.createdNotice')}
        </p>
      ) : null}
      {typeof query.error === 'string' ? (
        <p className="error-message" role="alert">
          {t('experiments.createError', { error: query.error })}
        </p>
      ) : null}

      <section aria-labelledby="experiment-input-heading" className="shell-card">
        <h2 id="experiment-input-heading">{t('experiments.inputHeading')}</h2>
        <p>{t('experiments.inputHelp')}</p>
        {!candidatesAvailable ? (
          <p data-testid="experiment-options-empty">{t('experiments.optionsEmpty')}</p>
        ) : null}
        {canCreate && candidatesAvailable ? (
          <form action={createExperiment} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <input name="idempotencyKey" type="hidden" value={randomUUID()} />
            <label htmlFor="experiment-compatible-inputs">
              {t('experiments.compatibleInputsField')}
            </label>
            <select id="experiment-compatible-inputs" name="combination" required>
              {options.compatibleCombinations.map((combination) => (
                <option
                  key={`${combination.baselineRunId}:${combination.intervention.kind}:${interventionOptionId(combination.intervention)}:${combination.remeasurementRunId}`}
                  value={JSON.stringify(combination)}
                >
                  {combination.intervention.kind === 'PUBLISHED_PUBLICATION'
                    ? t('experiments.optionPublished', {
                        baseline: combination.baselineRunId,
                        publication: combination.intervention.publicationRecordId,
                        attempt: combination.intervention.publicationAttemptId,
                        review: combination.intervention.artifactReviewId,
                        remeasurement: combination.remeasurementRunId,
                      })
                    : t('experiments.optionApproved', {
                        baseline: combination.baselineRunId,
                        review: combination.intervention.artifactReviewId,
                        remeasurement: combination.remeasurementRunId,
                      })}
                </option>
              ))}
            </select>
            <button className="primary-action" type="submit">
              {t('experiments.createAction')}
            </button>
          </form>
        ) : null}
      </section>

      {experiment === undefined ? null : <ExperimentReport experiment={experiment} t={t} />}

      <p className="warning-message">{t('experiments.noCausationWarning')}</p>
    </main>
  );
}

function ExperimentReport({ experiment, t }: { experiment: Experiment; t: TFunction }) {
  return (
    <section
      aria-labelledby="experiment-report-heading"
      className="shell-card"
      data-testid="experiment-report"
    >
      <p className="eyebrow">{t('experiments.reportEyebrow')}</p>
      <h2 id="experiment-report-heading">{t('experiments.reportHeading')}</h2>
      <p data-testid="experiment-scenario-version">
        {t('experiments.scenarioVersion', { version: experiment.scenarioVersion })}
      </p>
      <section data-testid="experiment-measurement-context">
        <h3>{t('experiments.contextHeading')}</h3>
        <p>{t('experiments.scenarioValue', { value: experiment.measurementContext.scenarioId })}</p>
        <p>
          {t('experiments.providerValue', { value: experiment.measurementContext.providerKey })}
        </p>
        <p>{t('experiments.surfaceValue', { value: experiment.measurementContext.surfaceKey })}</p>
        <p>
          {t('experiments.modelValue', {
            model: experiment.measurementContext.model,
            version: experiment.measurementContext.modelVersion,
          })}
        </p>
        <article data-testid="experiment-baseline-timeline">
          <h4>{t('experiments.baselineTimelineHeading')}</h4>
          <p>
            {t('experiments.runStarted', {
              value: experiment.measurementContext.timeline.baseline.startedAt,
            })}
          </p>
          <p>
            {t('experiments.runCompleted', {
              value: experiment.measurementContext.timeline.baseline.completedAt,
            })}
          </p>
          <p>
            {t('experiments.evidenceWindow', {
              from: experiment.measurementContext.timeline.baseline.evidenceWindow.minObservedAt,
              until: experiment.measurementContext.timeline.baseline.evidenceWindow.maxObservedAt,
            })}
          </p>
        </article>
        <article data-testid="experiment-remeasurement-timeline">
          <h4>{t('experiments.remeasurementTimelineHeading')}</h4>
          <p>
            {t('experiments.runStarted', {
              value: experiment.measurementContext.timeline.remeasurement.startedAt,
            })}
          </p>
          <p>
            {t('experiments.runCompleted', {
              value: experiment.measurementContext.timeline.remeasurement.completedAt,
            })}
          </p>
          <p>
            {t('experiments.evidenceWindow', {
              from: experiment.measurementContext.timeline.remeasurement.evidenceWindow
                .minObservedAt,
              until:
                experiment.measurementContext.timeline.remeasurement.evidenceWindow.maxObservedAt,
            })}
          </p>
        </article>
      </section>
      <p>{experiment.observedAssociation}</p>
      <p>{experiment.caveat}</p>
      <p>{experiment.noGuarantee}</p>

      <article data-testid="experiment-intervention">
        <h3>
          {experiment.intervention.kind === 'PUBLISHED_PUBLICATION'
            ? t('experiments.interventionPublishedHeading')
            : t('experiments.interventionApprovedHeading')}
        </h3>
        <p>{t('experiments.stateValue', { value: experiment.intervention.applicationState })}</p>
        <p>{t('experiments.eventRecordedAt', { value: experiment.intervention.observedAt })}</p>
        <p>{t('experiments.artifactValue', { value: experiment.intervention.artifactId })}</p>
        <p>
          {t('experiments.artifactRevisionValue', {
            value: experiment.intervention.artifactRevisionId,
          })}
        </p>
        <p>
          {t('experiments.artifactHashValue', {
            value: experiment.intervention.artifactContentHash,
          })}
        </p>
        {experiment.intervention.kind === 'PUBLISHED_PUBLICATION' ? (
          <>
            <p>
              {t('experiments.publicationValue', {
                value: experiment.intervention.publicationRecordId,
              })}
            </p>
            <p>
              {t('experiments.appliedAttemptValue', {
                value: experiment.intervention.publicationAttemptId,
              })}
            </p>
            <p>
              {t('experiments.approvalReviewValue', {
                value: experiment.intervention.artifactReviewId,
              })}
            </p>
          </>
        ) : (
          <>
            <p>
              {t('experiments.approvalReviewValue', {
                value: experiment.intervention.artifactReviewId,
              })}
            </p>
            <p>{experiment.intervention.applicationDisclosure}</p>
          </>
        )}
        <a href={experiment.drillDown.interventionHref}>
          {experiment.intervention.kind === 'PUBLISHED_PUBLICATION'
            ? t('experiments.viewPublishedIntervention')
            : t('experiments.viewApprovedArtifact')}
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
            <p>{t('experiments.scopeValue', { value: comparison.scopeKey })}</p>
            <p>{t('experiments.compatibilityValue', { value: comparison.compatibilityHash })}</p>
            <p>
              {t('experiments.descriptiveDelta', {
                value:
                  comparison.delta.value === null
                    ? 'NOT_COMPUTABLE'
                    : comparison.delta.value.toFixed(6),
              })}
            </p>
            <p>
              {t('experiments.sample', {
                baseline: comparison.baseline.sampleSize,
                remeasurement: comparison.remeasurement.sampleSize,
              })}
            </p>
            <p>
              {t('experiments.eligibleDenominator', {
                baseline: comparison.baseline.eligibleDenominator,
                remeasurement: comparison.remeasurement.eligibleDenominator,
              })}
            </p>
            <p>
              {t('experiments.excludedBaseline', {
                value: formatExcluded(comparison.baseline.excludedCounts),
              })}
            </p>
            <p>
              {t('experiments.excludedRemeasurement', {
                value: formatExcluded(comparison.remeasurement.excludedCounts),
              })}
            </p>
            <p>
              {t('experiments.costBaseline', {
                value: formatCosts(comparison.costBreakdown.baseline, t),
              })}
            </p>
            <p>
              {t('experiments.costRemeasurement', {
                value: formatCosts(comparison.costBreakdown.remeasurement, t),
              })}
            </p>
          </article>
        ))}
      </div>

      <nav aria-label={t('experiments.drillDownNavAria')}>
        <a href={experiment.drillDown.baselineRunHref}>{t('experiments.viewBaselineEvidence')}</a>
        <a href={experiment.drillDown.remeasurementRunHref}>
          {t('experiments.viewRemeasurementEvidence')}
        </a>
      </nav>
    </section>
  );
}

function formatExcluded(counts: Experiment['excludedCounts']['baseline']): string {
  return `ERROR ${counts.ERROR} · NOT_CHECKED ${counts.NOT_CHECKED} · INCONCLUSIVE ${counts.INCONCLUSIVE} · NOT_APPLICABLE ${counts.NOT_APPLICABLE}`;
}

function formatCosts(costs: Experiment['costBreakdown']['baseline'], t: TFunction): string {
  return costs.length === 0
    ? t('experiments.noCosts')
    : `${costs.map((entry) => `${entry.amount} ${entry.currency}`).join(' + ')}${t('experiments.costSuffix')}`;
}

function interventionOptionId(
  intervention: ExperimentCompatibleCombination['intervention'],
): string {
  return intervention.kind === 'PUBLISHED_PUBLICATION'
    ? `${intervention.publicationRecordId}:${intervention.publicationAttemptId}:${intervention.artifactReviewId}`
    : intervention.artifactReviewId;
}
