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

import { makeT } from '../../../lib/i18n';
import { getLocale } from '../../../lib/i18n/get-locale';
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

  const t = makeT(await getLocale());
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
      <p className="eyebrow">{t('privacy.eyebrow')}</p>
      <h1>{t('privacy.title')}</h1>
      <nav aria-label={t('privacy.breadcrumbAria')} className="breadcrumb">
        {activeScope ? (
          <a href={`/app?tenant=${tenantId}&workspace=${workspaceId}`}>{current.workspace.name}</a>
        ) : (
          <span className="monospace">{t('privacy.frozenWorkspace', { id: workspaceId })}</span>
        )}
        <span aria-current="page">{t('privacy.title')}</span>
      </nav>

      {!activeScope ? (
        <p className="warning-message" data-testid="frozen-governance-mode" role="status">
          {t('privacy.frozenWarning')}
        </p>
      ) : null}

      {query.notice === 'export-request-returned' ? (
        <section className="field-help" role="status">
          <p>{t('privacy.exportReturned')}</p>
          {activeScope && typeof query.export === 'string' ? (
            <a
              href={`${publicApiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/privacy/exports/${encodeURIComponent(query.export)}/download`}
            >
              {t('privacy.downloadBundle')}
            </a>
          ) : null}
        </section>
      ) : null}
      {query.notice === 'legal-hold-request-returned' ? (
        <p className="field-help" role="status">
          {t('privacy.holdRequestReturned')}
        </p>
      ) : null}
      {query.notice === 'legal-hold-release-returned' ? (
        <p className="field-help" role="status">
          {t('privacy.holdReleaseReturned')}
        </p>
      ) : null}
      {query.notice === 'audit-digest-request-returned' ? (
        <p className="field-help" role="status">
          {t('privacy.digestReturned')}
        </p>
      ) : null}
      {typeof query.error === 'string' ? (
        <p className="error-message" role="alert">
          {t('privacy.errorGeneric', { code: query.error })}
        </p>
      ) : null}

      <section aria-labelledby="retention-heading" className="shell-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{t('privacy.currentStateEyebrow')}</p>
            <h2 id="retention-heading">{t('privacy.lifecycleHeading')}</h2>
          </div>
          <strong className="status-badge neutral">
            {overview?.lifecycleState ?? 'UNAVAILABLE'}
          </strong>
        </div>
        <dl>
          <dt>{t('privacy.lifecycleActiveDeletion')}</dt>
          <dd>{t('privacy.lifecycleActiveDeletionValue')}</dd>
          <dt>{t('privacy.lifecycleBackup')}</dt>
          <dd>{t('privacy.lifecycleBackupValue')}</dd>
          <dt>{t('privacy.lifecycleConnectorSecret')}</dt>
          <dd>{t('privacy.lifecycleConnectorSecretValue')}</dd>
          <dt>{t('privacy.lifecycleRawSnapshot')}</dt>
          <dd>{t('privacy.lifecycleRawSnapshotValue')}</dd>
          <dt>{t('privacy.lifecycleScreenshot')}</dt>
          <dd>{t('privacy.lifecycleScreenshotValue')}</dd>
          <dt>{t('privacy.lifecycleAppLog')}</dt>
          <dd>{t('privacy.lifecycleAppLogValue')}</dd>
          <dt>{t('privacy.lifecycleAuditDigest')}</dt>
          <dd>{t('privacy.lifecycleAuditDigestValue')}</dd>
        </dl>
        {overview === undefined ? (
          <p className="warning-message">{t('privacy.lifecycleUnavailable')}</p>
        ) : null}
      </section>

      <section aria-labelledby="export-heading" className="shell-card">
        <h2 id="export-heading">{t('privacy.exportHeading')}</h2>
        <p>{t('privacy.exportDescription')}</p>
        {activeScope ? (
          <form action={exportTenant} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <input name="from" type="hidden" value={exportFrom} />
            <input name="to" type="hidden" value={exportTo} />
            <button className="primary-action" type="submit">
              {t('privacy.exportAction')}
            </button>
          </form>
        ) : (
          <p className="warning-message">{t('privacy.exportFrozen')}</p>
        )}
        <p className="field-help">{t('privacy.exportHelp')}</p>
      </section>

      <section aria-labelledby="audit-heading" className="shell-card">
        <h2 id="audit-heading">{t('privacy.auditHeading')}</h2>
        <p>{t('privacy.auditDescription')}</p>
        <dl>
          <dt>{t('privacy.chainIntegrity')}</dt>
          <dd data-testid="audit-integrity-status">
            {integrity === undefined ? 'UNAVAILABLE' : integrity.valid ? 'VALID' : 'TAMPERED'}
          </dd>
          <dt>{t('privacy.verifiedEventCount')}</dt>
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
              {t('privacy.sealDigestAction')}
            </button>
          </form>
        ) : (
          <p className="field-help">{t('privacy.auditFrozen')}</p>
        )}
        {timeline === undefined || timeline.events.length === 0 ? (
          <p>{t('privacy.noAuditEvents')}</p>
        ) : (
          <div className="table-scroll">
            <table>
              <caption>{t('privacy.auditCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('privacy.colSequence')}</th>
                  <th scope="col">{t('privacy.colTime')}</th>
                  <th scope="col">{t('privacy.colActor')}</th>
                  <th scope="col">{t('privacy.colAction')}</th>
                  <th scope="col">{t('privacy.colOutcome')}</th>
                  <th scope="col">{t('privacy.colHash')}</th>
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
              <a href={auditNavigation.latestHref}>{t('privacy.auditLatest')}</a>
            )}
            {auditNavigation.nextHref === null ? null : (
              <a href={auditNavigation.nextHref}>{t('privacy.auditOlder')}</a>
            )}
          </nav>
        )}
      </section>

      <section aria-labelledby="holds-heading" className="shell-card">
        <h2 id="holds-heading">{t('privacy.holdsHeading')}</h2>
        {visibleHolds.length === 0 ? (
          <p>{t('privacy.noHolds')}</p>
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
                    {t('privacy.releaseHoldAction', { name: hold.name })}
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
            <label htmlFor="legal-hold-name">{t('privacy.holdNameLabel')}</label>
            <input id="legal-hold-name" maxLength={200} name="name" required />
            <label htmlFor="legal-hold-reason">{t('privacy.holdReasonLabel')}</label>
            <textarea id="legal-hold-reason" maxLength={2000} name="reason" required />
            <details className="advanced-fields" open>
              <summary>{t('privacy.advancedFields')}</summary>
              <label htmlFor="legal-hold-object-key">{t('privacy.holdObjectKeyLabel')}</label>
              <input id="legal-hold-object-key" name="objectKey" required />
              <label htmlFor="legal-hold-version">{t('privacy.holdObjectVersionLabel')}</label>
              <input id="legal-hold-version" name="objectVersionId" required />
            </details>
            <button type="submit">{t('privacy.holdSubmitAction')}</button>
          </form>
        ) : null}
        <p className="field-help">{t('privacy.holdHelp')}</p>
      </section>

      <section aria-labelledby="break-glass-heading" className="shell-card">
        <h2 id="break-glass-heading">{t('privacy.breakGlassHeading')}</h2>
        {(overview?.breakGlassGrants ?? []).length === 0 ? (
          <p>{t('privacy.noBreakGlass')}</p>
        ) : (
          <ul>
            {overview?.breakGlassGrants.map((grant) => (
              <li key={grant.id}>
                {t('privacy.breakGlassLine', {
                  operator: grant.operatorName,
                  reason: grant.reason,
                  expires: grant.expiresAt,
                })}
                {grant.revokedAt === null
                  ? ''
                  : t('privacy.breakGlassRevoked', { revoked: grant.revokedAt })}
              </li>
            ))}
          </ul>
        )}
        <p className="warning-message">{t('privacy.breakGlassWarning')}</p>
      </section>

      {activeScope ? (
        <section aria-labelledby="deletion-heading" className="shell-card">
          <h2 id="deletion-heading">{t('privacy.deletionHeading')}</h2>
          <p>{t('privacy.deletionDescription')}</p>
          <form action={requestWorkspaceDeletion} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <h3>{t('privacy.workspaceDeletionHeading')}</h3>
            <label htmlFor="workspace-deletion-reason">
              {t('privacy.workspaceDeletionReasonLabel')}
            </label>
            <textarea id="workspace-deletion-reason" maxLength={2000} name="reason" required />
            <label htmlFor="workspace-deletion-confirmation">
              {t('privacy.workspaceDeletionConfirmLabel')}
            </label>
            <input
              autoComplete="off"
              id="workspace-deletion-confirmation"
              name="confirmation"
              pattern="DELETE WORKSPACE"
              placeholder="DELETE WORKSPACE"
              required
            />
            <button className="danger-action" type="submit">
              {t('privacy.workspaceDeletionAction')}
            </button>
          </form>
          <form action={requestTenantDeletion} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <h3>{t('privacy.tenantDeletionHeading')}</h3>
            <label htmlFor="tenant-deletion-reason">{t('privacy.tenantDeletionReasonLabel')}</label>
            <textarea id="tenant-deletion-reason" maxLength={2000} name="reason" required />
            <label htmlFor="tenant-deletion-confirmation">
              {t('privacy.tenantDeletionConfirmLabel')}
            </label>
            <input
              autoComplete="off"
              id="tenant-deletion-confirmation"
              name="confirmation"
              pattern="DELETE TENANT"
              placeholder="DELETE TENANT"
              required
            />
            <button className="danger-action" type="submit">
              {t('privacy.tenantDeletionAction')}
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
