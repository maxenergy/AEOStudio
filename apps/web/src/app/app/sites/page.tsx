import { randomUUID } from 'node:crypto';

import type {
  JobEnvelope,
  SiteBaselineEnvelope,
  SiteEnvelope,
  SiteVerificationEnvelope,
  WorkspaceListEnvelope,
} from '@aeostudio/contracts';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

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

function location(input: {
  tenantId: string;
  workspaceId: string;
  profileId: string;
  siteId?: string;
}): string {
  const query = new URLSearchParams({
    tenant: input.tenantId,
    workspace: input.workspaceId,
    profile: input.profileId,
  });
  if (input.siteId !== undefined) {
    query.set('site', input.siteId);
  }
  return `/app/sites?${query.toString()}`;
}

async function registerSite(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const profileId = requiredText(formData, 'profileId');
  const origin = requiredText(formData, 'origin');
  const cookieHeader = (await cookies()).toString();
  const registered = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/sites`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', cookie: cookieHeader, origin: webOrigin() },
      body: JSON.stringify({ profileId, origin }),
    },
  );
  const base = location({ tenantId, workspaceId, profileId });
  if (!registered.ok) {
    redirect(`${base}&error=site`);
  }
  const site = ((await registered.json()) as SiteEnvelope).data.site;
  const challenged = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/sites/${site.id}/verifications`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', cookie: cookieHeader, origin: webOrigin() },
      body: JSON.stringify({ method: 'FILE' }),
    },
  );
  if (!challenged.ok) {
    redirect(`${base}&site=${site.id}&error=challenge`);
  }
  const challenge = ((await challenged.json()) as SiteVerificationEnvelope).data.verification;
  const query = new URLSearchParams({
    verification: challenge.id,
    token: challenge.challengeToken,
    path: challenge.challengePath ?? '',
  });
  redirect(`${location({ tenantId, workspaceId, profileId, siteId: site.id })}&${query}`);
}

async function completeVerification(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const profileId = requiredText(formData, 'profileId');
  const siteId = requiredText(formData, 'siteId');
  const verificationId = requiredText(formData, 'verificationId');
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/sites/${siteId}/verifications/${verificationId}/complete`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        cookie: (await cookies()).toString(),
        origin: webOrigin(),
      },
      body: '{}',
    },
  );
  const base = location({ tenantId, workspaceId, profileId, siteId });
  redirect(`${base}&${response.ok ? 'notice=verified' : 'error=verification'}`);
}

async function setBudget(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const profileId = requiredText(formData, 'profileId');
  const siteId = requiredText(formData, 'siteId');
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
  const base = location({ tenantId, workspaceId, profileId, siteId });
  redirect(`${base}&${response.ok ? 'notice=budget' : 'error=budget'}`);
}

async function startCrawl(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const profileId = requiredText(formData, 'profileId');
  const siteId = requiredText(formData, 'siteId');
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/sites/${siteId}/crawls`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        cookie: (await cookies()).toString(),
        origin: webOrigin(),
      },
      body: JSON.stringify({ idempotencyKey: randomUUID() }),
    },
  );
  const base = location({ tenantId, workspaceId, profileId, siteId });
  if (!response.ok) {
    redirect(`${base}&error=crawl`);
  }
  const job = ((await response.json()) as JobEnvelope).data.job;
  redirect(`${base}&job=${job.id}`);
}

interface SitesPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SitesPage({ searchParams }: SitesPageProps) {
  const query = await searchParams;
  const tenantId = typeof query.tenant === 'string' ? query.tenant : undefined;
  const workspaceId = typeof query.workspace === 'string' ? query.workspace : undefined;
  const profileId = typeof query.profile === 'string' ? query.profile : undefined;
  if (tenantId === undefined || workspaceId === undefined || profileId === undefined) {
    redirect('/app');
  }
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
  const siteId = typeof query.site === 'string' ? query.site : undefined;
  let site: SiteEnvelope['data']['site'] | undefined;
  if (siteId !== undefined) {
    const response = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/sites/${siteId}`,
      { cache: 'no-store', headers: { cookie: cookieHeader } },
    );
    if (response.ok) {
      site = ((await response.json()) as SiteEnvelope).data.site;
    }
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
  let baseline: SiteBaselineEnvelope['data']['baseline'] | undefined;
  if (site !== undefined && job?.status === 'SUCCEEDED') {
    const response = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/sites/${site.id}/baseline`,
      { cache: 'no-store', headers: { cookie: cookieHeader } },
    );
    if (response.ok) {
      baseline = ((await response.json()) as SiteBaselineEnvelope).data.baseline;
    }
  }
  const hidden = (
    <>
      <input name="tenantId" type="hidden" value={tenantId} />
      <input name="workspaceId" type="hidden" value={workspaceId} />
      <input name="profileId" type="hidden" value={profileId} />
      {site === undefined ? null : <input name="siteId" type="hidden" value={site.id} />}
    </>
  );

  return (
    <main>
      <p className="eyebrow">AEO Studio</p>
      <h1>Site Baseline</h1>
      <p>只抓取已验证的自有 Site；每次 redirect 和 DNS 解析均重新执行 SSRF policy。</p>

      {site === undefined ? (
        <section className="shell-card">
          <h2>登记自有 Site</h2>
          <form action={registerSite} className="stacked-form">
            {hidden}
            <label htmlFor="site-origin">Site Origin</label>
            <input
              id="site-origin"
              name="origin"
              placeholder="https://example.com"
              required
              type="url"
            />
            <button className="primary-action" type="submit">
              登记 Site
            </button>
          </form>
        </section>
      ) : (
        <>
          <section className="shell-card">
            <h2>{site.origin}</h2>
            <p>
              状态：<strong data-testid="site-status">{site.status}</strong>
            </p>
            {site.status === 'UNVERIFIED' && typeof query.verification === 'string' ? (
              <>
                <p>请将以下 challenge 放到：</p>
                <code>{String(query.path ?? '')}</code>
                <p>
                  <code data-testid="challenge-token">{String(query.token ?? '')}</code>
                </p>
                <form action={completeVerification}>
                  {hidden}
                  <input name="verificationId" type="hidden" value={query.verification} />
                  <button className="primary-action" type="submit">
                    验证所有权
                  </button>
                </form>
              </>
            ) : null}
          </section>

          {site.status === 'VERIFIED' ? (
            <section className="shell-card">
              <h2>Crawl policy 与预算</h2>
              {membership.activeRole === 'OWNER' ? (
                <form action={setBudget} className="stacked-form">
                  {hidden}
                  <label htmlFor="crawl-budget">Crawl 预算上限</label>
                  <input
                    defaultValue="100"
                    id="crawl-budget"
                    min="1"
                    name="limitUnits"
                    required
                    type="number"
                  />
                  <button className="primary-action" type="submit">
                    保存 Crawl 预算
                  </button>
                </form>
              ) : null}
              <form action={startCrawl}>
                {hidden}
                <button className="primary-action" type="submit">
                  启动 Site Crawl
                </button>
              </form>
            </section>
          ) : null}
        </>
      )}

      {job === undefined ? null : (
        <section className="shell-card">
          <JobPoller status={job.status} />
          <h2>Crawl Job</h2>
          <p>Job ID：{job.id}</p>
          <p>
            状态：<strong data-testid="job-status">{job.status}</strong>
          </p>
          <p>进度：{job.progress}%</p>
          {job.errorCode === null ? null : <p>失败原因：{job.errorCode}</p>}
        </section>
      )}

      {baseline === undefined ? null : (
        <section className="shell-card">
          <h2>Technical / Content Baseline</h2>
          <p>
            状态：<strong data-testid="baseline-status">{baseline.status}</strong>
          </p>
          <p>Pages：{baseline.pageCount}</p>
          <p>Raw bytes：{baseline.totalBytes}</p>
          {baseline.errorCode === null ? null : <p>限制/失败原因：{baseline.errorCode}</p>}
          <h3>Snapshots</h3>
          <ul>
            {baseline.snapshots.map((snapshot) => (
              <li key={snapshot.id}>
                {snapshot.url} — Snapshot SHA-256 {snapshot.checksum} — {snapshot.contentType} —{' '}
                {snapshot.sizeBytes} bytes
              </li>
            ))}
          </ul>
          <h3>Findings</h3>
          <ul>
            {baseline.findings.map((finding) => (
              <li key={finding.id}>
                <strong>{finding.findingType}</strong> [{finding.severity}] {finding.detail} —
                snapshot {finding.snapshotId}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
