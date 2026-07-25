import { randomUUID } from 'node:crypto';

import type {
  BudgetAlertsEnvelope,
  JobEnvelope,
  WorkspaceListEnvelope,
} from '@aeostudio/contracts';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { makeT } from '../../../lib/i18n';
import { getLocale } from '../../../lib/i18n/get-locale';
import { JobPoller } from './job-poller';

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

function location(input: { tenantId: string; workspaceId: string; profileId: string }): string {
  return `/app/jobs?tenant=${input.tenantId}&workspace=${input.workspaceId}&profile=${input.profileId}`;
}

async function setBudget(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const profileId = requiredText(formData, 'profileId');
  const limitUnits = Number(requiredText(formData, 'limitUnits'));
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/budget`,
    {
      method: 'PUT',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        cookie: (await cookies()).toString(),
        origin: webOrigin(),
      },
      body: JSON.stringify({ limitUnits }),
    },
  );
  const base = location({ tenantId, workspaceId, profileId });
  redirect(`${base}&${response.ok ? 'notice=budget' : 'error=budget'}`);
}

async function setTenantBudget(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const profileId = requiredText(formData, 'profileId');
  const limitUnits = Number(requiredText(formData, 'limitUnits'));
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/budget/tenant`,
    {
      method: 'PUT',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        cookie: (await cookies()).toString(),
        origin: webOrigin(),
      },
      body: JSON.stringify({ limitUnits }),
    },
  );
  const base = location({ tenantId, workspaceId, profileId });
  redirect(`${base}&${response.ok ? 'notice=tenant-budget' : 'error=tenant-budget'}`);
}

async function setProviderBudget(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const profileId = requiredText(formData, 'profileId');
  const providerKey = requiredText(formData, 'providerKey');
  const limitUnits = Number(requiredText(formData, 'limitUnits'));
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/budget/providers/${encodeURIComponent(providerKey)}`,
    {
      method: 'PUT',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        cookie: (await cookies()).toString(),
        origin: webOrigin(),
      },
      body: JSON.stringify({ limitUnits }),
    },
  );
  const base = location({ tenantId, workspaceId, profileId });
  redirect(`${base}&${response.ok ? 'notice=provider-budget' : 'error=provider-budget'}`);
}

async function submitReadiness(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const profileId = requiredText(formData, 'profileId');
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/jobs`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        cookie: (await cookies()).toString(),
        origin: webOrigin(),
      },
      body: JSON.stringify({
        jobType: 'PROFILE_READINESS',
        aggregateId: profileId,
        idempotencyKey: randomUUID(),
        estimatedUnits: 10,
      }),
    },
  );
  const base = location({ tenantId, workspaceId, profileId });
  if (!response.ok) {
    redirect(`${base}&error=submit`);
  }
  const envelope = (await response.json()) as JobEnvelope;
  redirect(`${base}&job=${envelope.data.job.id}`);
}

async function cancelJob(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const profileId = requiredText(formData, 'profileId');
  const jobId = requiredText(formData, 'jobId');
  await fetch(`${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/jobs/${jobId}`, {
    method: 'DELETE',
    cache: 'no-store',
    headers: { cookie: (await cookies()).toString(), origin: webOrigin() },
  });
  redirect(`${location({ tenantId, workspaceId, profileId })}&job=${jobId}`);
}

interface JobsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function JobsPage({ searchParams }: JobsPageProps) {
  const query = await searchParams;
  const tenantId = typeof query.tenant === 'string' ? query.tenant : undefined;
  const workspaceId = typeof query.workspace === 'string' ? query.workspace : undefined;
  const profileId = typeof query.profile === 'string' ? query.profile : undefined;
  if (tenantId === undefined || workspaceId === undefined || profileId === undefined) {
    redirect('/app');
  }
  const t = makeT(await getLocale());
  const cookieHeader = (await cookies()).toString();
  const workspaceResponse = await fetch(`${apiOrigin()}/api/v1/tenants`, {
    cache: 'no-store',
    headers: { cookie: cookieHeader },
  });
  if (!workspaceResponse.ok) {
    redirect('/login');
  }
  const workspaces = (await workspaceResponse.json()) as WorkspaceListEnvelope;
  const membership = workspaces.data.workspaces.find(
    (entry) => entry.tenant.id === tenantId && entry.workspace.id === workspaceId,
  );
  if (membership === undefined) {
    redirect('/app');
  }
  const jobId = typeof query.job === 'string' ? query.job : undefined;
  let job: JobEnvelope['data']['job'] | undefined;
  if (jobId !== undefined) {
    const response = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/jobs/${jobId}`,
      { cache: 'no-store', headers: { cookie: cookieHeader } },
    );
    if (response.ok) {
      job = ((await response.json()) as JobEnvelope).data.job;
    }
  }
  let budgetAlerts: BudgetAlertsEnvelope['data']['alerts'] = [];
  if (membership.activeRole === 'OWNER') {
    const response = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/budget/alerts`,
      { cache: 'no-store', headers: { cookie: cookieHeader } },
    );
    if (response.ok) {
      budgetAlerts = ((await response.json()) as BudgetAlertsEnvelope).data.alerts;
    }
  }

  return (
    <main>
      <p className="eyebrow">{t('jobs.eyebrow')}</p>
      <h1>{t('jobs.title')}</h1>
      <p>{t('jobs.lede')}</p>

      {membership.activeRole === 'OWNER' ? (
        <section className="shell-card">
          <h2>{t('jobs.budgetHeading')}</h2>
          {['budget', 'tenant-budget', 'provider-budget'].includes(
            typeof query.notice === 'string' ? query.notice : '',
          ) ? (
            <p className="success-message" role="status">
              {t('jobs.budgetUpdated')}
            </p>
          ) : null}
          <form action={setBudget} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <input name="profileId" type="hidden" value={profileId} />
            <label htmlFor="budget-limit">{t('jobs.workspaceBudgetLabel')}</label>
            <input
              defaultValue="100"
              id="budget-limit"
              min="1"
              name="limitUnits"
              required
              type="number"
            />
            <button className="primary-action" type="submit">
              {t('jobs.saveWorkspaceBudgetAction')}
            </button>
          </form>
          <form action={setTenantBudget} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <input name="profileId" type="hidden" value={profileId} />
            <label htmlFor="tenant-budget-limit">{t('jobs.tenantBudgetLabel')}</label>
            <input
              defaultValue="100"
              id="tenant-budget-limit"
              min="1"
              name="limitUnits"
              required
              type="number"
            />
            <button className="secondary-action" type="submit">
              {t('jobs.saveTenantBudgetAction')}
            </button>
          </form>
          <form action={setProviderBudget} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <input name="profileId" type="hidden" value={profileId} />
            <label htmlFor="provider-key">{t('jobs.providerKeyLabel')}</label>
            <input id="provider-key" maxLength={160} name="providerKey" required type="text" />
            <label htmlFor="provider-budget-limit">{t('jobs.providerBudgetLabel')}</label>
            <input
              defaultValue="100"
              id="provider-budget-limit"
              min="1"
              name="limitUnits"
              required
              type="number"
            />
            <button className="secondary-action" type="submit">
              {t('jobs.saveProviderBudgetAction')}
            </button>
          </form>
        </section>
      ) : null}

      {membership.activeRole === 'OWNER' ? (
        <section aria-labelledby="budget-alert-heading" className="shell-card">
          <h2 id="budget-alert-heading">{t('jobs.budgetAlertHeading')}</h2>
          {budgetAlerts.length === 0 ? (
            <p>{t('jobs.noBudgetAlerts')}</p>
          ) : (
            <ul>
              {budgetAlerts.map((alert) => (
                <li data-testid="owner-budget-alert" key={alert.id}>
                  {alert.budgetScope === 'TENANT'
                    ? t('jobs.tenantBudgetAlert', { percent: alert.thresholdPercent })
                    : t('jobs.providerBudgetAlert', {
                        provider: alert.providerKey ?? '',
                        percent: alert.thresholdPercent,
                      })}
                  {t('jobs.alertSource', { workspace: alert.sourceWorkspaceId })}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="shell-card">
        <h2>{t('jobs.readinessHeading')}</h2>
        {job === undefined ? (
          <form action={submitReadiness}>
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <input name="profileId" type="hidden" value={profileId} />
            <button className="primary-action" type="submit">
              {t('jobs.startAction')}
            </button>
          </form>
        ) : (
          <>
            <JobPoller status={job.status} />
            <p>{t('jobs.jobId', { id: job.id })}</p>
            <p>
              {t('jobs.statusLabel')}
              <strong data-testid="job-status">{job.status}</strong>
            </p>
            <p data-testid="job-progress">{t('jobs.jobProgress', { progress: job.progress })}</p>
            {job.heartbeatAt === null ? null : (
              <p>{t('jobs.heartbeat', { heartbeat: job.heartbeatAt })}</p>
            )}
            {job.budgetWarning ? (
              <p className="warning-message">{t('jobs.budgetWarning')}</p>
            ) : null}
            {job.result === null ? null : (
              <pre data-testid="job-result">{JSON.stringify(job.result, null, 2)}</pre>
            )}
            {['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(job.status) ? (
              <form action={cancelJob}>
                <input name="tenantId" type="hidden" value={tenantId} />
                <input name="workspaceId" type="hidden" value={workspaceId} />
                <input name="profileId" type="hidden" value={profileId} />
                <input name="jobId" type="hidden" value={job.id} />
                <button className="secondary-action" type="submit">
                  {t('jobs.cancelAction')}
                </button>
              </form>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
