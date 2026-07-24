import type { WorkspaceListEnvelope } from '@aeostudio/contracts';
import {
  AuditDigestSchema,
  AuditTimelineSchema,
  PrivacyOverviewSchema,
  TenantDeletionReceiptSchema,
  TenantExportSchema,
  TenantVisibleLegalHoldSchema,
  type AuditTimeline,
  type PrivacyOverview,
  type TenantVisibleLegalHold,
} from '@aeostudio/contracts/privacy-audit';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { auditTimelineNavigation } from './privacy-navigation';

function apiOrigin(): string {
  return process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3200';
}

function webOrigin(): string {
  return process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3100';
}

function publicApiOrigin(): string {
  return process.env.API_PUBLIC_ORIGIN ?? 'http://127.0.0.1:3200';
}

const DELETION_RECEIPT_COOKIE = '__Host-aeo_deletion_receipt';
const DELETION_RECEIPT_TOKEN_HEADER = 'x-aeo-deletion-receipt-token';

function requiredText(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`PRIVACY_${name.toUpperCase()}_REQUIRED`);
  }
  return value.trim();
}

function privacyLocation(input: {
  tenantId: string;
  workspaceId: string;
  notice?: string;
  error?: string;
  exportId?: string;
  objectRef?: string;
}): string {
  const query = new URLSearchParams({ tenant: input.tenantId, workspace: input.workspaceId });
  if (input.notice !== undefined) query.set('notice', input.notice);
  if (input.error !== undefined) query.set('error', input.error);
  if (input.exportId !== undefined) query.set('export', input.exportId);
  if (input.objectRef !== undefined) query.set('objectRef', input.objectRef);
  return `/app/privacy?${query.toString()}`;
}

async function privacyMutation(
  formData: FormData,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  return fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/privacy/${path}`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        cookie: (await cookies()).toString(),
        origin: webOrigin(),
      },
      body: JSON.stringify(body),
    },
  );
}

async function problemCode(response: Response): Promise<string> {
  const problem = (await response.json().catch(() => null)) as { code?: unknown } | null;
  return typeof problem?.code === 'string' ? problem.code.toLowerCase() : 'request-failed';
}

async function exportTenant(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const response = await privacyMutation(formData, 'exports', {
    from: requiredText(formData, 'from'),
    to: requiredText(formData, 'to'),
  });
  if (!response.ok) {
    redirect(privacyLocation({ tenantId, workspaceId, error: await problemCode(response) }));
  }
  const payload = (await response.json()) as { data?: { export?: unknown } };
  const parsed = TenantExportSchema.safeParse(payload.data?.export);
  if (!parsed.success) {
    redirect(privacyLocation({ tenantId, workspaceId, error: 'invalid-export-response' }));
  }
  redirect(
    privacyLocation({
      tenantId,
      workspaceId,
      notice: 'export-request-returned',
      exportId: parsed.data.id,
      ...(parsed.data.objectRef === null ? {} : { objectRef: parsed.data.objectRef }),
    }),
  );
}

async function requestTenantDeletion(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  if (requiredText(formData, 'confirmation') !== 'DELETE TENANT') {
    redirect(privacyLocation({ tenantId, workspaceId, error: 'confirmation-required' }));
  }
  const response = await privacyMutation(formData, 'deletions/tenant', {
    reason: requiredText(formData, 'reason'),
  });
  if (!response.ok) {
    redirect(privacyLocation({ tenantId, workspaceId, error: await problemCode(response) }));
  }
  const payload = (await response.json()) as { data?: { receipt?: unknown } };
  const parsed = TenantDeletionReceiptSchema.safeParse(payload.data?.receipt);
  if (!parsed.success) {
    redirect(privacyLocation({ tenantId, workspaceId, error: 'invalid-deletion-response' }));
  }
  const receiptToken = response.headers.get(DELETION_RECEIPT_TOKEN_HEADER);
  if (receiptToken === null || !/^[A-Za-z0-9_.-]{1,4096}$/u.test(receiptToken)) {
    redirect(privacyLocation({ tenantId, workspaceId, error: 'invalid-deletion-receipt-token' }));
  }
  const cookieStore = await cookies();
  cookieStore.set(DELETION_RECEIPT_COOKIE, receiptToken, {
    httpOnly: true,
    maxAge: 5 * 60,
    path: '/',
    sameSite: 'lax',
    secure: true,
  });
  cookieStore.set('__Host-aeo_session', '', {
    expires: new Date(0),
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    secure: true,
  });
  redirect('/privacy/deletion-receipt');
}

async function requestWorkspaceDeletion(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  if (requiredText(formData, 'confirmation') !== 'DELETE WORKSPACE') {
    redirect(privacyLocation({ tenantId, workspaceId, error: 'confirmation-required' }));
  }
  const response = await privacyMutation(formData, 'deletions/workspace', {
    reason: requiredText(formData, 'reason'),
  });
  if (!response.ok) {
    redirect(privacyLocation({ tenantId, workspaceId, error: await problemCode(response) }));
  }
  const payload = (await response.json()) as { data?: { receipt?: unknown } };
  const parsed = TenantDeletionReceiptSchema.safeParse(payload.data?.receipt);
  if (!parsed.success) {
    redirect(privacyLocation({ tenantId, workspaceId, error: 'invalid-deletion-response' }));
  }
  const receiptToken = response.headers.get(DELETION_RECEIPT_TOKEN_HEADER);
  if (receiptToken === null || !/^[A-Za-z0-9_.-]{1,4096}$/u.test(receiptToken)) {
    redirect(privacyLocation({ tenantId, workspaceId, error: 'invalid-deletion-receipt-token' }));
  }
  const cookieStore = await cookies();
  cookieStore.set(DELETION_RECEIPT_COOKIE, receiptToken, {
    httpOnly: true,
    maxAge: 5 * 60,
    path: '/',
    sameSite: 'lax',
    secure: true,
  });
  cookieStore.set('__Host-aeo_session', '', {
    expires: new Date(0),
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    secure: true,
  });
  redirect('/privacy/deletion-receipt');
}

async function createLegalHold(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const response = await privacyMutation(formData, 'legal-holds', {
    name: requiredText(formData, 'name'),
    reason: requiredText(formData, 'reason'),
    objectKey: requiredText(formData, 'objectKey'),
    objectVersionId: requiredText(formData, 'objectVersionId'),
  });
  if (!response.ok) {
    redirect(privacyLocation({ tenantId, workspaceId, error: await problemCode(response) }));
  }
  const payload = (await response.json()) as { data?: { hold?: unknown } };
  if (!TenantVisibleLegalHoldSchema.safeParse(payload.data?.hold).success) {
    redirect(privacyLocation({ tenantId, workspaceId, error: 'invalid-legal-hold-response' }));
  }
  redirect(privacyLocation({ tenantId, workspaceId, notice: 'legal-hold-request-returned' }));
}

async function releaseLegalHold(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const holdId = requiredText(formData, 'holdId');
  const response = await privacyMutation(
    formData,
    `legal-holds/${encodeURIComponent(holdId)}/release`,
    {},
  );
  if (!response.ok) {
    redirect(privacyLocation({ tenantId, workspaceId, error: await problemCode(response) }));
  }
  const payload = (await response.json()) as { data?: { hold?: unknown } };
  const parsed = TenantVisibleLegalHoldSchema.safeParse(payload.data?.hold);
  if (!parsed.success || parsed.data.id !== holdId || parsed.data.releasedAt === null) {
    redirect(privacyLocation({ tenantId, workspaceId, error: 'invalid-legal-hold-response' }));
  }
  redirect(privacyLocation({ tenantId, workspaceId, notice: 'legal-hold-release-returned' }));
}

async function sealAuditDigest(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const response = await privacyMutation(formData, 'audit-digests', {
    from: requiredText(formData, 'from'),
    to: requiredText(formData, 'to'),
  });
  if (!response.ok) {
    redirect(privacyLocation({ tenantId, workspaceId, error: await problemCode(response) }));
  }
  const payload = (await response.json()) as { data?: { digest?: unknown } };
  const parsed = AuditDigestSchema.safeParse(payload.data?.digest);
  if (!parsed.success || parsed.data.tenantId !== tenantId) {
    redirect(privacyLocation({ tenantId, workspaceId, error: 'invalid-audit-digest-response' }));
  }
  redirect(privacyLocation({ tenantId, workspaceId, notice: 'audit-digest-request-returned' }));
}

interface PrivacyPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PrivacyPage({ searchParams }: PrivacyPageProps) {
  const query = await searchParams;
  const tenantId = typeof query.tenant === 'string' ? query.tenant : undefined;
  const workspaceId = typeof query.workspace === 'string' ? query.workspace : undefined;
  if (tenantId === undefined || workspaceId === undefined) redirect('/app');

  const cookieHeader = (await cookies()).toString();
  const now = new Date();
  const exportFrom = new Date(0).toISOString();
  const exportTo = new Date(now.getTime() - 1).toISOString();
  const auditFrom = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1_000).toISOString();
  const auditCursor = typeof query.auditCursor === 'string' ? query.auditCursor : undefined;
  const basePath = `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/privacy`;
  const [workspacesResponse, overviewResponse, auditResponse, integrityResponse, holdsResponse] =
    await Promise.all([
      fetch(`${apiOrigin()}/api/v1/tenants`, {
        cache: 'no-store',
        headers: { cookie: cookieHeader },
      }),
      fetch(`${basePath}/overview`, { cache: 'no-store', headers: { cookie: cookieHeader } }),
      fetch(
        `${basePath}/audit-events?${new URLSearchParams({
          from: auditFrom,
          to: exportTo,
          limit: '50',
          ...(auditCursor === undefined ? {} : { cursor: auditCursor }),
        }).toString()}`,
        { cache: 'no-store', headers: { cookie: cookieHeader } },
      ),
      fetch(`${basePath}/audit-integrity`, {
        cache: 'no-store',
        headers: { cookie: cookieHeader },
      }),
      fetch(`${basePath}/legal-holds`, { cache: 'no-store', headers: { cookie: cookieHeader } }),
    ]);
  if (workspacesResponse.status === 401 || overviewResponse.status === 401) redirect('/login');
  const workspaces = workspacesResponse.ok
    ? ((await workspacesResponse.json().catch(() => null)) as WorkspaceListEnvelope | null)
    : null;
  const current = workspaces?.data.workspaces.find(
    (entry) => entry.tenant.id === tenantId && entry.workspace.id === workspaceId,
  );
  if (current !== undefined && current.activeRole !== 'OWNER') redirect('/app');
  const overview = await parseOverview(overviewResponse);
  const timeline = await parseTimeline(auditResponse);
  const integrity = await parseIntegrity(integrityResponse);
  const listedHolds = await parseLegalHolds(holdsResponse);
  const activeScope = current?.activeRole === 'OWNER';
  if (!activeScope && overview === undefined) redirect('/app');
  const visibleHolds = listedHolds ?? overview?.legalHolds ?? [];
  const auditNavigation = auditTimelineNavigation({
    tenantId,
    workspaceId,
    currentCursor: auditCursor,
    nextCursor: timeline?.nextCursor,
  });
  return (
    <main>
      <p className="eyebrow">Tenant privacy control</p>
      <h1>Privacy &amp; Audit</h1>
      <nav aria-label="Privacy breadcrumb" className="breadcrumb">
        {activeScope ? (
          <a href={`/app?tenant=${tenantId}&workspace=${workspaceId}`}>{current.workspace.name}</a>
        ) : (
          <span className="monospace">Frozen workspace {workspaceId}</span>
        )}
        <span aria-current="page">Privacy &amp; Audit</span>
      </nav>

      {!activeScope ? (
        <p className="warning-message" data-testid="frozen-governance-mode" role="status">
          此 Tenant 已冻结。仅保留 Owner 的隐私治理视图、Audit timeline 与 exact-version Legal Hold
          释放能力；业务访问、导出、封存和删除写操作均已关闭。
        </p>
      ) : null}

      {query.notice === 'export-request-returned' ? (
        <section className="field-help" role="status">
          <p>导出请求已返回；是否可下载以服务端校验结果为准。</p>
          {activeScope && typeof query.export === 'string' ? (
            <a
              href={`${publicApiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/privacy/exports/${encodeURIComponent(query.export)}/download`}
            >
              验证并下载 JSON bundle
            </a>
          ) : null}
        </section>
      ) : null}
      {query.notice === 'legal-hold-request-returned' ? (
        <p className="field-help" role="status">
          Legal Hold 请求已返回；以下服务端列表是当前生效状态。
        </p>
      ) : null}
      {query.notice === 'legal-hold-release-returned' ? (
        <p className="field-help" role="status">
          Legal Hold 释放请求已返回；以下服务端列表是当前生效状态。
        </p>
      ) : null}
      {query.notice === 'audit-digest-request-returned' ? (
        <p className="field-help" role="status">
          Audit digest 请求已返回；完整性状态以服务端重新读取结果为准。
        </p>
      ) : null}
      {typeof query.error === 'string' ? (
        <p className="error-message" role="alert">
          Privacy 操作未完成：{query.error}
        </p>
      ) : null}

      <section aria-labelledby="retention-heading" className="shell-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Current state</p>
            <h2 id="retention-heading">数据生命周期</h2>
          </div>
          <strong className="status-badge neutral">
            {overview?.lifecycleState ?? 'UNAVAILABLE'}
          </strong>
        </div>
        <dl>
          <dt>Active data deletion</dt>
          <dd>删除请求后最多 30 天</dd>
          <dt>Backup expiry</dt>
          <dd>删除请求后最多 90 天</dd>
          <dt>Connector secret</dt>
          <dd>立即撤销且不可读取，24 小时内强制删除</dd>
          <dt>Raw response / crawl snapshot</dt>
          <dd>180 天</dd>
          <dt>Screenshot</dt>
          <dd>90 天</dd>
          <dt>Ordinary application log</dt>
          <dd>30 天；不作为 tamper-evident Audit Evidence</dd>
          <dt>Audit Evidence digest</dt>
          <dd>365 天，独立 Object Lock 端口</dd>
        </dl>
        {overview === undefined ? (
          <p className="warning-message">
            当前 lifecycle 读模型不可用；写操作仍由 API fail closed。
          </p>
        ) : null}
      </section>

      <section aria-labelledby="export-heading" className="shell-card">
        <h2 id="export-heading">Tenant-only export</h2>
        <p>
          导出仅包含当前 Tenant 的安全投影；manifest 列出 schema version、时间范围、对象 hash 与
          checksum，且不包含凭据或其他 Tenant 对象。
        </p>
        {activeScope ? (
          <form action={exportTenant} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <input name="from" type="hidden" value={exportFrom} />
            <input name="to" type="hidden" value={exportTo} />
            <button className="primary-action" type="submit">
              生成 Tenant export
            </button>
          </form>
        ) : (
          <p className="warning-message">冻结后不能创建或下载新的 Tenant export。</p>
        )}
        <p className="field-help">
          Point-in-time export 只用于完整性核对，不构成法律认证，也不保证未来排名、引用或业务结果。
        </p>
      </section>

      <section aria-labelledby="audit-heading" className="shell-card">
        <h2 id="audit-heading">Audit timeline</h2>
        <p>
          登录、角色、审批、发布、预算、export、deletion 与具名限时 break-glass 位于 append-only
          hash chain；普通应用日志不冒充 Audit Evidence。
        </p>
        <dl>
          <dt>Chain integrity</dt>
          <dd data-testid="audit-integrity-status">
            {integrity === undefined ? 'UNAVAILABLE' : integrity.valid ? 'VALID' : 'TAMPERED'}
          </dd>
          <dt>Verified event count</dt>
          <dd>{integrity?.eventCount ?? '—'}</dd>
        </dl>
        {integrity?.valid === false && integrity.reason !== null ? (
          <p className="error-message" role="alert">
            {integrity.reason}
          </p>
        ) : null}
        {activeScope ? (
          <form action={sealAuditDigest} className="inline-actions">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <input name="from" type="hidden" value={auditFrom} />
            <input name="to" type="hidden" value={exportTo} />
            <button disabled={integrity?.valid !== true} type="submit">
              封存 Audit digest
            </button>
          </form>
        ) : (
          <p className="field-help">冻结治理模式只允许验证与查看，不允许生成新的 Audit digest。</p>
        )}
        {timeline === undefined || timeline.events.length === 0 ? (
          <p>当前时间范围内没有可显示的 Audit Event。</p>
        ) : (
          <div className="table-scroll">
            <table>
              <caption>最近 365 天 Tenant Audit Events</caption>
              <thead>
                <tr>
                  <th scope="col">Sequence</th>
                  <th scope="col">Time</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Action</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Hash</th>
                </tr>
              </thead>
              <tbody>
                {timeline.events.map((event) => (
                  <tr key={event.id}>
                    <td>{event.sequence}</td>
                    <td>{event.occurredAt}</td>
                    <td>{event.actorKind}</td>
                    <td>{event.action}</td>
                    <td>{event.outcome}</td>
                    <td className="monospace break-anywhere">{event.eventHash}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {auditNavigation.latestHref === null && auditNavigation.nextHref === null ? null : (
          <nav aria-label="Audit timeline pages" className="inline-actions">
            {auditNavigation.latestHref === null ? null : (
              <a href={auditNavigation.latestHref}>返回最新 Audit Events</a>
            )}
            {auditNavigation.nextHref === null ? null : (
              <a href={auditNavigation.nextHref}>查看更早 Audit Events</a>
            )}
          </nav>
        )}
      </section>

      <section aria-labelledby="holds-heading" className="shell-card">
        <h2 id="holds-heading">Visible exact-version Legal Holds</h2>
        {visibleHolds.length === 0 ? (
          <p>没有生效中的 Legal Hold。</p>
        ) : (
          <ul>
            {visibleHolds.map((hold) => (
              <li key={hold.id}>
                <strong>{hold.name}</strong> — {hold.reason}
                <br />
                <span className="monospace break-anywhere">
                  {hold.target.objectKey} @ {hold.target.objectVersionId}
                </span>
                <form action={releaseLegalHold} className="inline-actions">
                  <input name="tenantId" type="hidden" value={tenantId} />
                  <input name="workspaceId" type="hidden" value={workspaceId} />
                  <input name="holdId" type="hidden" value={hold.id} />
                  <button className="danger-action" type="submit">
                    释放 Legal Hold：{hold.name}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {activeScope ? (
          <form action={createLegalHold} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <label htmlFor="legal-hold-name">Legal Hold 名称</label>
            <input id="legal-hold-name" maxLength={200} name="name" required />
            <label htmlFor="legal-hold-reason">Legal Hold 理由</label>
            <textarea id="legal-hold-reason" maxLength={2000} name="reason" required />
            <label htmlFor="legal-hold-object-key">Object key</label>
            <input id="legal-hold-object-key" name="objectKey" required />
            <label htmlFor="legal-hold-version">Object version ID</label>
            <input id="legal-hold-version" name="objectVersionId" required />
            <button type="submit">保留这个确切对象版本</button>
          </form>
        ) : null}
        <p className="field-help">
          Legal Hold 必须具名、说明理由并对 Tenant 可见；不会恢复已冻结访问，也不会自动保留同 key
          的其他版本。
        </p>
      </section>

      <section aria-labelledby="break-glass-heading" className="shell-card">
        <h2 id="break-glass-heading">Named expiring break-glass</h2>
        {(overview?.breakGlassGrants ?? []).length === 0 ? (
          <p>没有登记中的 break-glass grant。</p>
        ) : (
          <ul>
            {overview?.breakGlassGrants.map((grant) => (
              <li key={grant.id}>
                {grant.operatorName} — {grant.reason} — expires {grant.expiresAt}
                {grant.revokedAt === null ? '' : ` — revoked ${grant.revokedAt}`}
              </li>
            ))}
          </ul>
        )}
        <p className="warning-message">
          Tenant Owner 不能签发 break-glass。具名操作者身份必须来自受信的平台支持控制面，并绑定确切
          Workspace、操作与资源；默认配置为拒绝。
        </p>
      </section>

      {activeScope ? (
        <section aria-labelledby="deletion-heading" className="shell-card">
          <h2 id="deletion-heading">Deletion freeze</h2>
          <p>
            发起删除会先在同一生命周期边界冻结业务访问，并撤销 Session、Job 与
            Connector；后续外部清理失败时 Tenant 仍保持 frozen。Legal Hold
            只阻止目标对象版本的销毁。
          </p>
          <form action={requestWorkspaceDeletion} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <h3>只删除当前 Workspace</h3>
            <label htmlFor="workspace-deletion-reason">Workspace 删除原因</label>
            <textarea id="workspace-deletion-reason" maxLength={2000} name="reason" required />
            <label htmlFor="workspace-deletion-confirmation">确认删除 Workspace</label>
            <input
              autoComplete="off"
              id="workspace-deletion-confirmation"
              name="confirmation"
              pattern="DELETE WORKSPACE"
              placeholder="DELETE WORKSPACE"
              required
            />
            <button className="danger-action" type="submit">
              发起 Workspace 删除并冻结访问
            </button>
          </form>
          <form action={requestTenantDeletion} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <h3>删除整个 Tenant</h3>
            <label htmlFor="tenant-deletion-reason">删除原因</label>
            <textarea id="tenant-deletion-reason" maxLength={2000} name="reason" required />
            <label htmlFor="tenant-deletion-confirmation">确认删除 Tenant</label>
            <input
              autoComplete="off"
              id="tenant-deletion-confirmation"
              name="confirmation"
              pattern="DELETE TENANT"
              placeholder="DELETE TENANT"
              required
            />
            <button className="danger-action" type="submit">
              发起 Tenant 删除并冻结访问
            </button>
          </form>
        </section>
      ) : null}
    </main>
  );
}

async function parseOverview(response: Response): Promise<PrivacyOverview | undefined> {
  if (!response.ok) return undefined;
  const payload = (await response.json().catch(() => null)) as { data?: { overview?: unknown } };
  const parsed = PrivacyOverviewSchema.safeParse(payload?.data?.overview);
  return parsed.success ? parsed.data : undefined;
}

async function parseTimeline(response: Response): Promise<AuditTimeline | undefined> {
  if (!response.ok) return undefined;
  const payload = (await response.json().catch(() => null)) as { data?: { timeline?: unknown } };
  const parsed = AuditTimelineSchema.safeParse(payload?.data?.timeline);
  return parsed.success ? parsed.data : undefined;
}

async function parseLegalHolds(response: Response): Promise<TenantVisibleLegalHold[] | undefined> {
  if (!response.ok) return undefined;
  const payload = (await response.json().catch(() => null)) as { data?: { holds?: unknown } };
  if (!Array.isArray(payload?.data?.holds)) return undefined;
  const parsed = payload.data.holds.map((hold) => TenantVisibleLegalHoldSchema.safeParse(hold));
  if (parsed.some((hold) => !hold.success)) return undefined;
  return parsed.flatMap((hold) => (hold.success ? [hold.data] : []));
}

interface AuditIntegrityView {
  valid: boolean;
  eventCount: number;
  reason: string | null;
}

async function parseIntegrity(response: Response): Promise<AuditIntegrityView | undefined> {
  if (!response.ok) return undefined;
  const payload = (await response.json().catch(() => null)) as {
    data?: { verification?: unknown };
  } | null;
  const value = payload?.data?.verification;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.valid !== 'boolean' ||
    typeof record.eventCount !== 'number' ||
    !Number.isSafeInteger(record.eventCount) ||
    (record.reason !== null && typeof record.reason !== 'string')
  ) {
    return undefined;
  }
  return {
    valid: record.valid,
    eventCount: record.eventCount,
    reason: record.reason,
  };
}
