import { randomUUID } from 'node:crypto';

import type {
  ContentPlanBundleEnvelope,
  JobEnvelope,
  StartContentPlanEnvelope,
  WorkspaceListEnvelope,
} from '@aeostudio/contracts';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { JobPoller } from '../jobs/job-poller';

const FIXTURES = {
  profileId: '00000000-0000-7000-8000-000000000810',
  offeringId: '00000000-0000-7000-8000-000000000811',
  promptSetId: '00000000-0000-7000-8000-000000000812',
  promptRevisionId: '00000000-0000-7000-8000-000000000813',
  primaryClaimId: '00000000-0000-7000-8000-000000000814',
  comparisonClaimId: '00000000-0000-7000-8000-000000000815',
  baselineId: '00000000-0000-7000-8000-000000000816',
} as const;

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
  const value = formData.get(name);
  if (typeof value !== 'string') return [];
  return value
    .split(/[\r\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
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

  return (
    <main>
      <p className="eyebrow">AEO Studio</p>
      <h1>Content Plan / Briefs</h1>
      <p>
        由批准的业务资料、Claims、Prompt Set 与 site baseline 生成可解释优先级；visibility
        尚未测量时明确标记 UNKNOWN，不把它混入分数。
      </p>

      {membership.activeRole === 'OWNER' ? (
        <section className="shell-card">
          <h2>计划预算</h2>
          {query.notice === 'budget' ? <p role="status">计划预算已保存</p> : null}
          <form action={saveBudget} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <label htmlFor="plan-budget">预算上限</label>
            <input defaultValue="1000" id="plan-budget" min="1" name="limitUnits" type="number" />
            <button className="secondary-action" type="submit">
              保存计划预算
            </button>
          </form>
        </section>
      ) : null}

      {planId === undefined && mayStart ? (
        <section className="shell-card">
          <h2>冻结计划输入</h2>
          <p>所有 ID 都会作为 input artifact revision snapshot 保存，生成过程不调用真实 LLM。</p>
          <form action={startPlan} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <label htmlFor="plan-profile">Profile ID</label>
            <input defaultValue={FIXTURES.profileId} id="plan-profile" name="profileId" required />
            <label htmlFor="plan-profile-revision">Profile revision</label>
            <input
              defaultValue="1"
              id="plan-profile-revision"
              min="1"
              name="profileRevision"
              type="number"
            />
            <label htmlFor="plan-offering">Offering ID</label>
            <input
              defaultValue={FIXTURES.offeringId}
              id="plan-offering"
              name="offeringId"
              required
            />
            <label htmlFor="plan-offering-revision">Offering revision</label>
            <input
              defaultValue="1"
              id="plan-offering-revision"
              min="1"
              name="offeringRevision"
              type="number"
            />
            <label htmlFor="plan-prompt-set">Approved Prompt Set ID</label>
            <input
              defaultValue={FIXTURES.promptSetId}
              id="plan-prompt-set"
              name="promptSetId"
              required
            />
            <label htmlFor="plan-prompt-revision">Approved Prompt revision ID</label>
            <input
              defaultValue={FIXTURES.promptRevisionId}
              id="plan-prompt-revision"
              name="promptRevisionId"
              required
            />
            <label htmlFor="plan-primary-claims">Approved primary Claim revision IDs</label>
            <textarea
              defaultValue={FIXTURES.primaryClaimId}
              id="plan-primary-claims"
              name="primaryClaimRevisionIds"
            />
            <label htmlFor="plan-comparison-claims">
              Independently evidenced comparison Claim revision IDs
            </label>
            <textarea
              defaultValue={FIXTURES.comparisonClaimId}
              id="plan-comparison-claims"
              name="comparisonClaimRevisionIds"
            />
            <label htmlFor="plan-baseline">Site baseline ID</label>
            <input
              defaultValue={FIXTURES.baselineId}
              id="plan-baseline"
              name="baselineId"
              required
            />
            <button className="primary-action" type="submit">
              启动 Content Plan
            </button>
          </form>
        </section>
      ) : null}

      {job === undefined ? null : (
        <section className="shell-card" aria-labelledby="plan-job-heading">
          <h2 id="plan-job-heading">Plan Job</h2>
          <JobPoller status={job.status} />
          <p>
            状态：<strong data-testid="content-plan-job-status">{job.status}</strong>
          </p>
          <p>进度：{job.progress}%</p>
        </section>
      )}

      {bundle === undefined ? null : (
        <>
          <section className="shell-card">
            <h2>Plan {bundle.plan.status}</h2>
            <p>Method policy：{bundle.plan.methodPolicyVersion}</p>
            <p>Content hash：{bundle.plan.contentHash ?? 'pending'}</p>
            <p>Visibility gap：UNKNOWN（尚未执行真实多 Surface measurement）</p>
          </section>

          {bundle.opportunities.length === 0 ? null : (
            <section className="shell-card">
              <h2>Explainable opportunities</h2>
              <ol>
                {bundle.opportunities.map((opportunity) => (
                  <li key={opportunity.id}>
                    <h3>
                      #{opportunity.rank} {opportunity.assetKind}
                    </h3>
                    <p>
                      Business value {opportunity.businessValue} · Evidence readiness{' '}
                      {opportunity.evidenceReadiness} · Effort {opportunity.effort} · Risk{' '}
                      {opportunity.risk}
                    </p>
                    <p>Visibility gap：{opportunity.visibilityGap.status}</p>
                    <p>{opportunity.rankReason}</p>
                    <p>下一步：{opportunity.action}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {bundle.briefs.length === 0 ? null : (
            <section className="shell-card">
              <h2>Evidence-ready Briefs</h2>
              {selectedBriefId === undefined ? null : (
                <p role="status">Selected exact Brief ID：{selectedBriefId}</p>
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
                        <strong>Selected exact Brief</strong>
                      </p>
                    ) : null}
                    <h3>{brief.assetKind}</h3>
                    <p>{brief.title}</p>
                    <p>
                      审批状态：<strong>{brief.status}</strong> · Publish ready：false
                    </p>
                    <p>Prompt refs：{brief.promptIds.join(', ')}</p>
                    <p>Claim refs：{brief.claimRevisionIds.join(', ')}</p>
                    <p>Source artifact refs：{brief.sourceArtifactIds.join(', ')}</p>
                    {mayReview && brief.status === 'REVIEW_REQUIRED' && jobId !== undefined ? (
                      <form action={reviewBrief} className="stacked-form">
                        <input name="tenantId" type="hidden" value={tenantId} />
                        <input name="workspaceId" type="hidden" value={workspaceId} />
                        <input name="planId" type="hidden" value={bundle.plan.id} />
                        <input name="jobId" type="hidden" value={jobId} />
                        <input name="briefId" type="hidden" value={brief.id} />
                        <input name="contentHash" type="hidden" value={brief.contentHash} />
                        <input name="decision" type="hidden" value="APPROVE" />
                        <label htmlFor={`brief-note-${brief.id}`}>Review note</label>
                        <input id={`brief-note-${brief.id}`} name="note" required />
                        <button type="submit">批准 exact Brief hash</button>
                      </form>
                    ) : null}
                  </article>
                );
              })}
            </section>
          )}

          {bundle.evidenceTasks.length === 0 ? null : (
            <section className="shell-card">
              <h2>Evidence tasks</h2>
              {bundle.evidenceTasks.map((task) => (
                <article key={task.id}>
                  <h3>{task.assetKind}</h3>
                  <p>{task.reasonCode}</p>
                  <p>{task.detail}</p>
                  <p>Publish ready：false</p>
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}
