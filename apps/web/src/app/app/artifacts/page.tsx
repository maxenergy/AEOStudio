import { randomUUID } from 'node:crypto';
import type {
  ArtifactBundleEnvelope,
  JobEnvelope,
  StartArtifactGenerationEnvelope,
  WorkspaceListEnvelope,
} from '@aeostudio/contracts';
import type { ApprovedBriefListEnvelope } from '@aeostudio/contracts/content-planning';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { makeT } from '../../../lib/i18n';
import { getLocale } from '../../../lib/i18n/get-locale';
import { JobPoller } from '../jobs/job-poller';

function apiOrigin(): string {
  return process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3200';
}

function webOrigin(): string {
  return process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3100';
}

function requiredText(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`INVALID_${name}`);
  return value.trim();
}

function location(input: {
  tenantId: string;
  workspaceId: string;
  artifactId?: string;
  jobId?: string;
  suffix?: string;
}): string {
  const query = new URLSearchParams({ tenant: input.tenantId, workspace: input.workspaceId });
  if (input.artifactId !== undefined) query.set('artifact', input.artifactId);
  if (input.jobId !== undefined) query.set('job', input.jobId);
  return `/app/artifacts?${query.toString()}${input.suffix ?? ''}`;
}

function mutationHeaders(cookie: string) {
  return { 'content-type': 'application/json', cookie, origin: webOrigin() };
}

async function saveBudget(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/budget`,
    {
      method: 'PUT',
      cache: 'no-store',
      headers: mutationHeaders((await cookies()).toString()),
      body: JSON.stringify({ limitUnits: Number(requiredText(formData, 'limitUnits')) }),
    },
  );
  redirect(
    location({ tenantId, workspaceId, suffix: response.ok ? '&notice=budget' : '&error=budget' }),
  );
}

async function startArtifact(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/artifacts`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: mutationHeaders((await cookies()).toString()),
      body: JSON.stringify({
        briefId: requiredText(formData, 'briefId'),
        locale: requiredText(formData, 'locale'),
        market: requiredText(formData, 'market'),
        methodPolicyVersion: 'artifact-fixture-v1',
        idempotencyKey: randomUUID(),
      }),
    },
  );
  if (!response.ok) redirect(location({ tenantId, workspaceId, suffix: '&error=start' }));
  const started = (await response.json()) as StartArtifactGenerationEnvelope;
  redirect(
    location({
      tenantId,
      workspaceId,
      artifactId: started.data.artifact.id,
      jobId: started.data.job.id,
    }),
  );
}

async function reviseArtifact(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const artifactId = requiredText(formData, 'artifactId');
  const effectiveJobId = requiredText(formData, 'jobId');
  const cookie = (await cookies()).toString();
  const artifactUrl = `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/artifacts/${artifactId}`;
  const current = await fetch(artifactUrl, { cache: 'no-store', headers: { cookie } });
  if (!current.ok)
    redirect(
      location({
        tenantId,
        workspaceId,
        artifactId,
        jobId: effectiveJobId,
        suffix: '&error=revision',
      }),
    );
  const bundle = (await current.json()) as ArtifactBundleEnvelope;
  if (bundle.data.payload === null) throw new Error('ARTIFACT_PAYLOAD_MISSING');
  const response = await fetch(`${artifactUrl}/revisions`, {
    method: 'POST',
    cache: 'no-store',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({
      expectedRevision: bundle.data.artifact.revision,
      payload: { ...bundle.data.payload, summary: requiredText(formData, 'summary') },
    }),
  });
  redirect(
    location({
      tenantId,
      workspaceId,
      artifactId,
      jobId: effectiveJobId,
      suffix: response.ok ? '&notice=revised' : '&error=revision',
    }),
  );
}

async function submitRevision(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const artifactId = requiredText(formData, 'artifactId');
  const effectiveJobId = requiredText(formData, 'jobId');
  const revision = requiredText(formData, 'revision');
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/artifacts/${artifactId}/revisions/${revision}/submit`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: mutationHeaders((await cookies()).toString()),
      body: JSON.stringify({ expectedContentHash: requiredText(formData, 'contentHash') }),
    },
  );
  redirect(
    location({
      tenantId,
      workspaceId,
      artifactId,
      jobId: effectiveJobId,
      suffix: response.ok ? '&notice=submitted' : '&error=submit',
    }),
  );
}

async function reviewRevision(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const artifactId = requiredText(formData, 'artifactId');
  const effectiveJobId = requiredText(formData, 'jobId');
  const revision = requiredText(formData, 'revision');
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/artifacts/${artifactId}/revisions/${revision}/review`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: mutationHeaders((await cookies()).toString()),
      body: JSON.stringify({
        decision: requiredText(formData, 'decision'),
        expectedContentHash: requiredText(formData, 'contentHash'),
        note: requiredText(formData, 'note'),
      }),
    },
  );
  redirect(
    location({
      tenantId,
      workspaceId,
      artifactId,
      jobId: effectiveJobId,
      suffix: response.ok ? '&notice=reviewed' : '&error=review',
    }),
  );
}

interface ArtifactsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ArtifactsPage({ searchParams }: ArtifactsPageProps) {
  const t = makeT(await getLocale());
  const query = await searchParams;
  const tenantId = typeof query.tenant === 'string' ? query.tenant : undefined;
  const workspaceId = typeof query.workspace === 'string' ? query.workspace : undefined;
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
  const artifactId = typeof query.artifact === 'string' ? query.artifact : undefined;
  const queryJobId = typeof query.job === 'string' ? query.job : undefined;
  let job: JobEnvelope['data']['job'] | undefined;
  if (queryJobId !== undefined) {
    const response = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/jobs/${queryJobId}`,
      { cache: 'no-store', headers: { cookie } },
    );
    if (response.ok) job = ((await response.json()) as JobEnvelope).data.job;
  }
  let bundle: ArtifactBundleEnvelope['data'] | undefined;
  if (artifactId !== undefined) {
    const response = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/artifacts/${artifactId}`,
      { cache: 'no-store', headers: { cookie } },
    );
    if (response.ok) bundle = ((await response.json()) as ArtifactBundleEnvelope).data;
  }
  const effectiveJobId = queryJobId ?? bundle?.artifact.jobId ?? undefined;
  if (job === undefined && effectiveJobId !== undefined) {
    const response = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/jobs/${effectiveJobId}`,
      { cache: 'no-store', headers: { cookie } },
    );
    if (response.ok) job = ((await response.json()) as JobEnvelope).data.job;
  }
  const mayEdit = ['OWNER', 'ADMIN', 'EDITOR'].includes(membership.activeRole);
  const mayReview = ['OWNER', 'REVIEWER'].includes(membership.activeRole);
  const mayPackage = ['OWNER', 'PUBLISHER'].includes(membership.activeRole);

  let approvedBriefs: ApprovedBriefListEnvelope['data']['briefs'] = [];
  if (mayEdit && artifactId === undefined) {
    const briefsRes = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/content-plans/briefs/approved`,
      { cache: 'no-store', headers: { cookie } },
    );
    if (briefsRes.ok)
      approvedBriefs = ((await briefsRes.json()) as ApprovedBriefListEnvelope).data.briefs;
  }
  const profileSource = bundle?.revision?.lineage.sourceReferences.find(
    (reference) => reference.kind === 'PROFILE_REVISION',
  );

  return (
    <main>
      <p className="eyebrow">{t('artifacts.eyebrow')}</p>
      <h1>{t('artifacts.title')}</h1>
      <p>{t('artifacts.lede')}</p>

      {membership.activeRole === 'OWNER' ? (
        <section className="shell-card">
          <h2>{t('artifacts.budgetHeading')}</h2>
          <form action={saveBudget} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <label htmlFor="artifact-budget">{t('artifacts.budgetLimit')}</label>
            <input
              defaultValue="1000"
              id="artifact-budget"
              min="1"
              name="limitUnits"
              type="number"
            />
            <button className="secondary-action" type="submit">
              {t('artifacts.budgetSaveAction')}
            </button>
          </form>
        </section>
      ) : null}

      {artifactId === undefined && mayEdit ? (
        <section className="shell-card">
          <h2>{t('artifacts.generateHeading')}</h2>
          {approvedBriefs.length === 0 ? (
            <p role="alert">{t('artifacts.noBriefs')}</p>
          ) : (
            <form action={startArtifact} className="stacked-form">
              <input name="tenantId" type="hidden" value={tenantId} />
              <input name="workspaceId" type="hidden" value={workspaceId} />
              <label htmlFor="artifact-brief">{t('artifacts.briefLabel')}</label>
              <select id="artifact-brief" name="briefId" required>
                {approvedBriefs.map((b) => (
                  <option key={b.briefId} value={b.briefId}>
                    {b.title} [{b.assetKind}]
                  </option>
                ))}
              </select>
              <label htmlFor="artifact-locale">{t('artifacts.localeLabel')}</label>
              <input defaultValue="zh-CN" id="artifact-locale" name="locale" required />
              <label htmlFor="artifact-market">{t('artifacts.marketLabel')}</label>
              <input defaultValue="Global" id="artifact-market" name="market" required />
              <button className="primary-action" type="submit">
                {t('artifacts.generateAction')}
              </button>
            </form>
          )}
        </section>
      ) : null}

      {job === undefined ? null : (
        <section className="shell-card">
          <h2>{t('artifacts.jobHeading')}</h2>
          <JobPoller status={job.status} />
          <p>
            {t('artifacts.jobStatusLabel')}
            <strong data-testid="artifact-job-status">{job.status}</strong>
          </p>
          <p>{t('artifacts.jobProgress', { progress: job.progress })}</p>
        </section>
      )}

      {bundle?.revision === undefined ||
      bundle.revision === null ||
      bundle.payload === null ? null : (
        <>
          <section className="shell-card">
            <h2>{t('artifacts.previewHeading', { title: bundle.payload.title })}</h2>
            <p>{bundle.payload.summary}</p>
            {bundle.payload.sections.map((section) => (
              <article className="nested-card" key={section.heading}>
                <h3>{section.heading}</h3>
                <p>{section.body}</p>
              </article>
            ))}
            <p>{bundle.payload.disclosure}</p>
            <p>
              {t('artifacts.currentApproval')}
              <strong>{bundle.approvalState}</strong>
            </p>
          </section>

          <section className="shell-card">
            <h2>{t('artifacts.lineageHeading')}</h2>
            <p>
              {t('artifacts.artifactRevisionLine', {
                id: bundle.artifact.id,
                revision: bundle.revision.revision,
              })}
            </p>
            <p>{t('artifacts.contentHash', { hash: bundle.revision.contentHash })}</p>
            <p>
              {t('artifacts.schemaMethod', {
                schema: bundle.revision.schemaVersion,
                method: bundle.revision.methodPolicyVersion,
              })}
            </p>
            <p>
              <a
                href={`/app/plans?tenant=${tenantId}&workspace=${workspaceId}&plan=${bundle.revision.lineage.contentPlanId}&brief=${bundle.revision.lineage.brief.id}#brief-${bundle.revision.lineage.brief.id}`}
              >
                {t('artifacts.viewApprovedBrief', { id: bundle.revision.lineage.brief.id })}
              </a>
            </p>
            <p>
              <a
                href={`/app/prompts?tenant=${tenantId}&workspace=${workspaceId}&promptSet=${bundle.revision.lineage.prompt.promptSetId}&promptRevision=${bundle.revision.lineage.prompt.promptRevisionId}`}
              >
                {t('artifacts.viewApprovedPromptRevision', {
                  id: bundle.revision.lineage.prompt.promptRevisionId,
                })}
              </a>
            </p>
            <details>
              <summary>{t('artifacts.resolvedSources')}</summary>
              <ul>
                {bundle.revision.lineage.sourceReferences.map((reference) => {
                  const href =
                    reference.kind === 'PROFILE_REVISION'
                      ? `/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${reference.aggregateId}`
                      : reference.kind === 'OFFERING_REVISION'
                        ? `/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${profileSource?.aggregateId ?? ''}&offering=${reference.aggregateId}&revision=${reference.revision ?? 1}`
                        : reference.kind === 'PROMPT_REVISION'
                          ? `/app/prompts?tenant=${tenantId}&workspace=${workspaceId}&promptSet=${reference.aggregateId}&promptRevision=${reference.id}`
                          : `/app/sites?tenant=${tenantId}&workspace=${workspaceId}&profile=${profileSource?.aggregateId ?? ''}&site=${reference.aggregateId}`;
                  return (
                    <li key={reference.id}>
                      <a href={href}>{reference.kind}</a>
                      {t('artifacts.sourceMeta', { id: reference.id })}{' '}
                      {reference.contentHash ?? t('artifacts.hashNotApplicable')}
                    </li>
                  );
                })}
              </ul>
            </details>
            {bundle.revision.claimBindings.map((binding) => (
              <article className="nested-card" key={binding.claimRevisionId}>
                <h3>
                  <a
                    href={`/app/claims?tenant=${tenantId}&workspace=${workspaceId}&claim=${binding.claimId}&claimRevision=${binding.claimRevisionId}`}
                  >
                    {t('artifacts.claimRevision', { id: binding.claimRevisionId })}
                  </a>
                </h3>
                <p>{t('artifacts.claimHash', { hash: binding.claimContentHash })}</p>
                <p
                  data-testid={`claim-evidence-status-${binding.claimRevisionId}`}
                  style={{
                    color: binding.evidence.length > 0 ? '#1a7f37' : '#b42318',
                    fontWeight: 600,
                  }}
                >
                  {binding.evidence.length > 0 ? '✓ ' : '⚠ '}
                  {binding.evidence.length > 0
                    ? t('artifacts.evidenceSupported')
                    : t('artifacts.evidenceUnsupported')}
                </p>
                {binding.evidence.map((evidence) => (
                  <p key={evidence.snapshotId}>
                    <a
                      href={`/app/claims?tenant=${tenantId}&workspace=${workspaceId}&claim=${binding.claimId}&claimRevision=${binding.claimRevisionId}&source=${evidence.sourceId}&snapshot=${evidence.snapshotId}`}
                    >
                      {t('artifacts.evidenceLink', {
                        source: evidence.sourceId,
                        snapshot: evidence.snapshotId,
                        hash: evidence.sourceHash,
                      })}
                    </a>
                  </p>
                ))}
              </article>
            ))}
          </section>

          <section className="shell-card">
            <h2>{t('artifacts.diffHeading')}</h2>
            {bundle.revisions.length < 2 ? (
              <p>{t('artifacts.firstRevision')}</p>
            ) : (
              <>
                <p>
                  {t('artifacts.revisionDiffLine', {
                    prevRevision: bundle.revisions.at(-2)?.revision ?? '',
                    prevHash: bundle.revisions.at(-2)?.contentHash ?? '',
                    revision: bundle.revision.revision,
                    hash: bundle.revision.contentHash,
                  })}
                </p>
                {bundle.previousPayload === null ? (
                  <p>{t('artifacts.prevPayloadUnavailable')}</p>
                ) : (
                  <div aria-label={t('artifacts.summaryDiffAria')} className="nested-card">
                    <p>{t('artifacts.summaryDiffLabel')}</p>
                    <p>
                      <del data-testid="artifact-previous-summary">
                        {bundle.previousPayload.summary}
                      </del>
                    </p>
                    <p>
                      <ins data-testid="artifact-current-summary">{bundle.payload.summary}</ins>
                    </p>
                  </div>
                )}
              </>
            )}
            <p>
              {t('artifacts.selectableRevisions')}
              {bundle.selectableApprovedRevisions.map((entry) => `R${entry.revision}`).join(', ') ||
                t('artifacts.selectableNone')}
            </p>
            {mayPackage &&
            bundle.selectableApprovedRevisions.some(
              (entry) =>
                entry.revision === bundle.revision?.revision &&
                entry.contentHash === bundle.revision?.contentHash,
            ) ? (
              <a
                className="primary-action"
                href={`/app/channels?tenant=${tenantId}&workspace=${workspaceId}&artifact=${bundle.artifact.id}&artifactRevision=${bundle.revision.id}`}
              >
                {t('artifacts.createPackageAction')}
              </a>
            ) : null}
          </section>

          {mayEdit &&
          ['DRAFT', 'APPROVED', 'REJECTED'].includes(bundle.revision.status) &&
          effectiveJobId !== undefined ? (
            <section className="shell-card">
              <h2>{t('artifacts.revisionOpsHeading')}</h2>
              <form action={reviseArtifact} className="stacked-form">
                <input name="tenantId" type="hidden" value={tenantId} />
                <input name="workspaceId" type="hidden" value={workspaceId} />
                <input name="artifactId" type="hidden" value={bundle.artifact.id} />
                <input name="jobId" type="hidden" value={effectiveJobId} />
                <label htmlFor="artifact-summary">{t('artifacts.summaryLabel')}</label>
                <textarea
                  defaultValue={bundle.payload.summary}
                  id="artifact-summary"
                  name="summary"
                  required
                />
                <button type="submit">{t('artifacts.createRevisionAction')}</button>
              </form>
              {bundle.revision.status === 'DRAFT' ? (
                <form action={submitRevision} className="stacked-form">
                  <input name="tenantId" type="hidden" value={tenantId} />
                  <input name="workspaceId" type="hidden" value={workspaceId} />
                  <input name="artifactId" type="hidden" value={bundle.artifact.id} />
                  <input name="jobId" type="hidden" value={effectiveJobId} />
                  <input name="revision" type="hidden" value={bundle.revision.revision} />
                  <input name="contentHash" type="hidden" value={bundle.revision.contentHash} />
                  <button className="primary-action" type="submit">
                    {t('artifacts.submitReviewAction')}
                  </button>
                </form>
              ) : null}
            </section>
          ) : null}

          {mayReview && bundle.revision.status === 'IN_REVIEW' && effectiveJobId !== undefined ? (
            <section className="shell-card">
              <h2>{t('artifacts.reviewHeading')}</h2>
              <form action={reviewRevision} className="stacked-form">
                <input name="tenantId" type="hidden" value={tenantId} />
                <input name="workspaceId" type="hidden" value={workspaceId} />
                <input name="artifactId" type="hidden" value={bundle.artifact.id} />
                <input name="jobId" type="hidden" value={effectiveJobId} />
                <input name="revision" type="hidden" value={bundle.revision.revision} />
                <input name="contentHash" type="hidden" value={bundle.revision.contentHash} />
                <label htmlFor="artifact-review-note">{t('artifacts.reviewNoteLabel')}</label>
                <input id="artifact-review-note" name="note" required />
                <button name="decision" type="submit" value="APPROVE">
                  {t('artifacts.approveAction')}
                </button>
                <button name="decision" type="submit" value="REJECT">
                  {t('artifacts.rejectAction')}
                </button>
              </form>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
