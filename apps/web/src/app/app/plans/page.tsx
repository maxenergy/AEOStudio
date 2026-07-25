import { randomUUID } from 'node:crypto';

import type {
  ContentPlanBundleEnvelope,
  JobEnvelope,
  StartContentPlanEnvelope,
  WorkspaceListEnvelope,
} from '@aeostudio/contracts';
import type {
  ProfileListEnvelope,
  OfferingListEnvelope,
} from '@aeostudio/contracts/profile-offering';
import type { ApprovedPromptSetListEnvelope } from '@aeostudio/contracts/prompt-research';
import type { ApprovedClaimListEnvelope } from '@aeostudio/contracts/evidence-claims';
import type { SiteBaselineListEnvelope } from '@aeostudio/contracts/site-crawl';
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
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`INVALID_${name.toUpperCase()}`);
  }
  return value.trim();
}

function optionalIds(formData: FormData, name: string): string[] {
  const all = formData.getAll(name);
  if (all.length > 0) {
    return all
      .flatMap((entry) => (typeof entry === 'string' ? entry.split(/[\r\n,]+/) : []))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function location(input: {
  tenantId: string;
  workspaceId: string;
  planId?: string;
  jobId?: string;
}): string {
  const query = new URLSearchParams({ tenant: input.tenantId, workspace: input.workspaceId });
  if (input.planId !== undefined) query.set('plan', input.planId);
  if (input.jobId !== undefined) query.set('job', input.jobId);
  return `/app/plans?${query.toString()}`;
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
    `${location({ tenantId, workspaceId })}&${response.ok ? 'notice=budget' : 'error=budget'}`,
  );
}

async function startPlan(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/content-plans`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: mutationHeaders((await cookies()).toString()),
      body: JSON.stringify({
        profile: {
          id: requiredText(formData, 'profileId'),
          revision: Number(requiredText(formData, 'profileRevision')),
        },
        offering: {
          id: requiredText(formData, 'offeringId'),
          revision: Number(requiredText(formData, 'offeringRevision')),
        },
        promptSetId: requiredText(formData, 'promptSetId'),
        promptRevisionId: requiredText(formData, 'promptRevisionId'),
        primaryClaimRevisionIds: optionalIds(formData, 'primaryClaimRevisionIds'),
        comparisonClaimRevisionIds: optionalIds(formData, 'comparisonClaimRevisionIds'),
        baselineId: requiredText(formData, 'baselineId'),
        methodPolicyVersion: 'content-plan-v1',
        idempotencyKey: randomUUID(),
      }),
    },
  );
  if (!response.ok) redirect(`${location({ tenantId, workspaceId })}&error=start`);
  const started = (await response.json()) as StartContentPlanEnvelope;
  redirect(
    location({
      tenantId,
      workspaceId,
      planId: started.data.plan.id,
      jobId: started.data.job.id,
    }),
  );
}

async function reviewBrief(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const planId = requiredText(formData, 'planId');
  const jobId = requiredText(formData, 'jobId');
  const briefId = requiredText(formData, 'briefId');
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/content-plans/${planId}/briefs/${briefId}/review`,
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
    `${location({ tenantId, workspaceId, planId, jobId })}&${response.ok ? 'notice=reviewed' : 'error=review'}`,
  );
}

interface PlansPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PlansPage({ searchParams }: PlansPageProps) {
  const t = makeT(await getLocale());
  const query = await searchParams;
  const tenantId = typeof query.tenant === 'string' ? query.tenant : undefined;
  const workspaceId = typeof query.workspace === 'string' ? query.workspace : undefined;
  if (tenantId === undefined || workspaceId === undefined) redirect('/app');
  const cookie = (await cookies()).toString();
  const workspaceResponse = await fetch(`${apiOrigin()}/api/v1/tenants`, {
    cache: 'no-store',
    headers: { cookie },
  });
  if (!workspaceResponse.ok) redirect('/login');
  const workspaces = (await workspaceResponse.json()) as WorkspaceListEnvelope;
  const membership = workspaces.data.workspaces.find(
    (entry) => entry.tenant.id === tenantId && entry.workspace.id === workspaceId,
  );
  if (membership === undefined) redirect('/app');
  const planId = typeof query.plan === 'string' ? query.plan : undefined;
  const selectedBriefId = typeof query.brief === 'string' ? query.brief : undefined;
  const jobId = typeof query.job === 'string' ? query.job : undefined;
  let job: JobEnvelope['data']['job'] | undefined;
  if (jobId !== undefined) {
    const response = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/jobs/${jobId}`,
      { cache: 'no-store', headers: { cookie } },
    );
    if (response.ok) job = ((await response.json()) as JobEnvelope).data.job;
  }
  let bundle: ContentPlanBundleEnvelope['data'] | undefined;
  if (planId !== undefined) {
    const response = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/content-plans/${planId}`,
      { cache: 'no-store', headers: { cookie } },
    );
    if (response.ok) bundle = ((await response.json()) as ContentPlanBundleEnvelope).data;
  }
  const mayStart = ['OWNER', 'ADMIN', 'EDITOR'].includes(membership.activeRole);
  const mayReview = membership.activeRole === 'REVIEWER';

  const base = `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}`;
  const headers = { cookie };
  let profiles: ProfileListEnvelope['data']['profiles'] = [];
  let offerings: OfferingListEnvelope['data']['offerings'] = [];
  let promptSets: ApprovedPromptSetListEnvelope['data']['promptSets'] = [];
  let claims: ApprovedClaimListEnvelope['data']['claims'] = [];
  let baselines: SiteBaselineListEnvelope['data']['baselines'] = [];
  if (mayStart && planId === undefined) {
    const [profilesRes, offeringsRes, promptSetsRes, claimsRes, baselinesRes] = await Promise.all([
      fetch(`${base}/profiles`, { cache: 'no-store', headers }),
      fetch(`${base}/offerings`, { cache: 'no-store', headers }),
      fetch(`${base}/prompt-sets/approved`, { cache: 'no-store', headers }),
      fetch(`${base}/claims/approved`, { cache: 'no-store', headers }),
      fetch(`${base}/sites/baselines`, { cache: 'no-store', headers }),
    ]);
    if (profilesRes.ok)
      profiles = ((await profilesRes.json()) as ProfileListEnvelope).data.profiles;
    if (offeringsRes.ok)
      offerings = ((await offeringsRes.json()) as OfferingListEnvelope).data.offerings;
    if (promptSetsRes.ok)
      promptSets = ((await promptSetsRes.json()) as ApprovedPromptSetListEnvelope).data.promptSets;
    if (claimsRes.ok) claims = ((await claimsRes.json()) as ApprovedClaimListEnvelope).data.claims;
    if (baselinesRes.ok)
      baselines = ((await baselinesRes.json()) as SiteBaselineListEnvelope).data.baselines;
  }

  return (
    <main>
      <p className="eyebrow">{t('plans.eyebrow')}</p>
      <h1>{t('plans.title')}</h1>
      <p>{t('plans.lede')}</p>

      {membership.activeRole === 'OWNER' ? (
        <section className="shell-card">
          <h2>{t('plans.budgetHeading')}</h2>
          {query.notice === 'budget' ? <p role="status">{t('plans.budgetSaved')}</p> : null}
          <form action={saveBudget} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <label htmlFor="plan-budget">{t('plans.budgetLimit')}</label>
            <input defaultValue="1000" id="plan-budget" min="1" name="limitUnits" type="number" />
            <button className="secondary-action" type="submit">
              {t('plans.budgetSaveAction')}
            </button>
          </form>
        </section>
      ) : null}

      {planId === undefined && mayStart ? (
        <section className="shell-card">
          <h2>{t('plans.freezeHeading')}</h2>
          <p>{t('plans.freezeHelp')}</p>
          {profiles.length === 0 && promptSets.length === 0 ? (
            <p role="alert">{t('plans.noResources')}</p>
          ) : (
            <form action={startPlan} className="stacked-form">
              <input name="tenantId" type="hidden" value={tenantId} />
              <input name="workspaceId" type="hidden" value={workspaceId} />
              <label htmlFor="plan-profile">{t('plans.field.profile')}</label>
              <select id="plan-profile" name="profileId" required>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName} (rev {p.currentRevision})
                  </option>
                ))}
              </select>
              <label htmlFor="plan-profile-revision">{t('plans.field.profileRevision')}</label>
              <input
                defaultValue={profiles[0]?.currentRevision ?? 1}
                id="plan-profile-revision"
                min="1"
                name="profileRevision"
                type="number"
              />
              <label htmlFor="plan-offering">{t('plans.field.offering')}</label>
              <select id="plan-offering" name="offeringId" required>
                {offerings.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} [{o.kind}] (rev {o.currentRevision})
                  </option>
                ))}
              </select>
              <label htmlFor="plan-offering-revision">{t('plans.field.offeringRevision')}</label>
              <input
                defaultValue={offerings[0]?.currentRevision ?? 1}
                id="plan-offering-revision"
                min="1"
                name="offeringRevision"
                type="number"
              />
              <label htmlFor="plan-prompt-set">{t('plans.field.promptSet')}</label>
              <select id="plan-prompt-set" name="promptSetId" required>
                {promptSets.map((ps) => (
                  <option key={ps.promptSetId} value={ps.promptSetId}>
                    {ps.title} (rev {ps.revision})
                  </option>
                ))}
              </select>
              <label htmlFor="plan-prompt-revision">{t('plans.field.promptRevision')}</label>
              <select id="plan-prompt-revision" name="promptRevisionId" required>
                {promptSets.map((ps) => (
                  <option key={ps.revisionId} value={ps.revisionId}>
                    {ps.title} rev {ps.revision}
                  </option>
                ))}
              </select>
              <label htmlFor="plan-primary-claims">{t('plans.field.primaryClaims')}</label>
              <input
                defaultValue={claims.map((c) => c.revisionId).join(',')}
                id="plan-primary-claims"
                list="plan-primary-claim-options"
                name="primaryClaimRevisionIds"
              />
              <datalist id="plan-primary-claim-options">
                {claims.map((c) => (
                  <option key={c.revisionId} value={c.revisionId}>
                    {c.statement} (R{c.revision})
                  </option>
                ))}
              </datalist>
              <p className="field-help">{t('plans.claimsHelp')}</p>
              <label htmlFor="plan-comparison-claims">{t('plans.field.comparisonClaims')}</label>
              <input
                defaultValue=""
                id="plan-comparison-claims"
                list="plan-comparison-claim-options"
                name="comparisonClaimRevisionIds"
              />
              <datalist id="plan-comparison-claim-options">
                {claims.map((c) => (
                  <option key={c.revisionId} value={c.revisionId}>
                    {c.statement} (R{c.revision})
                  </option>
                ))}
              </datalist>
              <p className="field-help">{t('plans.claimsHelp')}</p>
              <label htmlFor="plan-baseline">{t('plans.field.baseline')}</label>
              <select id="plan-baseline" name="baselineId" required>
                {baselines.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.status} · {b.pageCount} pages · {b.completedAt}
                  </option>
                ))}
              </select>
              <button className="primary-action" type="submit">
                {t('plans.startAction')}
              </button>
            </form>
          )}
        </section>
      ) : null}

      {job === undefined ? null : (
        <section className="shell-card" aria-labelledby="plan-job-heading">
          <h2 id="plan-job-heading">{t('plans.jobHeading')}</h2>
          <JobPoller status={job.status} />
          <p>
            {t('plans.jobStatusLabel')}
            <strong data-testid="content-plan-job-status">{job.status}</strong>
          </p>
          <p>{t('plans.jobProgress', { progress: job.progress })}</p>
        </section>
      )}

      {bundle === undefined ? null : (
        <>
          <section className="shell-card">
            <h2>{t('plans.planHeading', { status: bundle.plan.status })}</h2>
            <p>{t('plans.methodPolicy', { version: bundle.plan.methodPolicyVersion })}</p>
            <p>
              {t('plans.planContentHash', { hash: bundle.plan.contentHash ?? t('plans.pending') })}
            </p>
            <p>{t('plans.planVisibilityGap')}</p>
          </section>

          {bundle.opportunities.length === 0 ? null : (
            <section className="shell-card">
              <h2>{t('plans.opportunitiesHeading')}</h2>
              <ol>
                {bundle.opportunities.map((opportunity) => (
                  <li key={opportunity.id}>
                    <h3>
                      {t('plans.opportunityRank', {
                        rank: opportunity.rank,
                        assetKind: opportunity.assetKind,
                      })}
                    </h3>
                    <p>
                      {t('plans.opportunityMetrics', {
                        businessValue: opportunity.businessValue,
                        evidenceReadiness: opportunity.evidenceReadiness,
                        effort: opportunity.effort,
                        risk: opportunity.risk,
                      })}
                    </p>
                    <p>
                      {t('plans.opportunityVisibilityGap', {
                        status: opportunity.visibilityGap.status,
                      })}
                    </p>
                    <p>{opportunity.rankReason}</p>
                    <p>{t('plans.opportunityNextStep', { action: opportunity.action })}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {bundle.briefs.length === 0 ? null : (
            <section className="shell-card">
              <h2>{t('plans.briefsHeading')}</h2>
              {selectedBriefId === undefined ? null : (
                <p role="status">{t('plans.selectedBriefId', { id: selectedBriefId })}</p>
              )}
              {bundle.briefs.map((brief) => {
                const isSelected = brief.id === selectedBriefId;
                return (
                  <article
                    aria-current={isSelected ? 'true' : undefined}
                    className="nested-card"
                    id={`brief-${brief.id}`}
                    key={brief.id}
                    style={
                      isSelected
                        ? {
                            outline: '3px solid #1859b7',
                            outlineOffset: '3px',
                            scrollMarginTop: '1rem',
                          }
                        : { scrollMarginTop: '1rem' }
                    }
                  >
                    {isSelected ? (
                      <p>
                        <strong>{t('plans.selectedBrief')}</strong>
                      </p>
                    ) : null}
                    <h3>{brief.assetKind}</h3>
                    <p>{brief.title}</p>
                    <p>
                      {t('plans.briefStatusLabel')}
                      <strong>{brief.status}</strong>
                      {t('plans.briefPublishReady')}
                    </p>
                    <p>{t('plans.briefPromptRefs', { refs: brief.promptIds.join(', ') })}</p>
                    <p>{t('plans.briefClaimRefs', { refs: brief.claimRevisionIds.join(', ') })}</p>
                    <p>
                      {t('plans.briefSourceRefs', { refs: brief.sourceArtifactIds.join(', ') })}
                    </p>
                    {mayReview && brief.status === 'REVIEW_REQUIRED' && jobId !== undefined ? (
                      <form action={reviewBrief} className="stacked-form">
                        <input name="tenantId" type="hidden" value={tenantId} />
                        <input name="workspaceId" type="hidden" value={workspaceId} />
                        <input name="planId" type="hidden" value={bundle.plan.id} />
                        <input name="jobId" type="hidden" value={jobId} />
                        <input name="briefId" type="hidden" value={brief.id} />
                        <input name="contentHash" type="hidden" value={brief.contentHash} />
                        <input name="decision" type="hidden" value="APPROVE" />
                        <label htmlFor={`brief-note-${brief.id}`}>
                          {t('plans.briefReviewNote')}
                        </label>
                        <input id={`brief-note-${brief.id}`} name="note" required />
                        <button type="submit">{t('plans.briefApproveAction')}</button>
                      </form>
                    ) : null}
                  </article>
                );
              })}
            </section>
          )}

          {bundle.evidenceTasks.length === 0 ? null : (
            <section className="shell-card">
              <h2>{t('plans.evidenceTasksHeading')}</h2>
              {bundle.evidenceTasks.map((task) => (
                <article key={task.id}>
                  <h3>{task.assetKind}</h3>
                  <p>{task.reasonCode}</p>
                  <p>{task.detail}</p>
                  <p>{t('plans.evidenceTaskPublishReady')}</p>
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}
