import type { WebsiteImportEnvelope } from '@aeostudio/contracts';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { makeT } from '../../../lib/i18n';
import { getLocale } from '../../../lib/i18n/get-locale';
import {
  checkboxValue,
  fetchWorkspaces,
  idList,
  knowledgeBase,
  optionalText,
  postKnowledge,
  resolveWorkspace,
  webOrigin,
} from '../../../lib/knowledge';
import { WizardProgress } from '../wizard-progress';

type WebsiteImportSession = WebsiteImportEnvelope['data']['websiteImport'];

async function startWebsiteImport(formData: FormData): Promise<never> {
  'use server';
  const tenantId = formData.get('tenantId');
  const workspaceId = formData.get('workspaceId');
  if (typeof tenantId !== 'string' || typeof workspaceId !== 'string') redirect('/app');
  const contextQuery = `tenant=${tenantId}&workspace=${workspaceId}`;
  const url = optionalText(formData, 'websiteUrl');
  if (url.length === 0) {
    redirect(`/app/start?${contextQuery}&error=importUrl`);
  }
  let importId: string | null = null;
  try {
    const response = await fetch(`${knowledgeBase(tenantId, workspaceId)}/import/website`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        cookie: (await cookies()).toString(),
        origin: webOrigin(),
      },
      body: JSON.stringify({ url }),
    });
    if (response.ok) {
      const result = (await response.json()) as WebsiteImportEnvelope;
      importId = result.data.websiteImport.importId;
    }
  } catch {
    importId = null;
  }
  if (importId === null) {
    redirect(`/app/start?${contextQuery}&error=importStart`);
  }
  redirect(`/app/start?${contextQuery}&importId=${importId}`);
}

async function confirmWebsiteImport(formData: FormData): Promise<never> {
  'use server';
  const tenantId = formData.get('tenantId');
  const workspaceId = formData.get('workspaceId');
  const importId = formData.get('importId');
  if (
    typeof tenantId !== 'string' ||
    typeof workspaceId !== 'string' ||
    typeof importId !== 'string'
  ) {
    redirect('/app');
  }
  const ok = await postKnowledge(
    `${knowledgeBase(tenantId, workspaceId)}/import/website/${importId}/confirm`,
    {
      createProfile: checkboxValue(formData, 'createProfile'),
      offeringCandidateIds: idList(formData, 'offeringCandidateIds'),
    },
  );
  redirect(
    `/app/company?tenant=${tenantId}&workspace=${workspaceId}&${
      ok ? 'notice=importConfirmed' : 'error=importConfirm'
    }`,
  );
}

async function fetchImportSession(
  tenantId: string,
  workspaceId: string,
  importId: string,
): Promise<WebsiteImportSession | null> {
  try {
    const response = await fetch(
      `${knowledgeBase(tenantId, workspaceId)}/import/website/${importId}`,
      {
        cache: 'no-store',
        headers: { cookie: (await cookies()).toString() },
      },
    );
    if (!response.ok) return null;
    const result = (await response.json()) as WebsiteImportEnvelope;
    return result.data.websiteImport;
  } catch {
    return null;
  }
}

export default async function StartPage({
  searchParams,
}: {
  searchParams: Promise<{
    tenant?: string;
    workspace?: string;
    importId?: string;
    notice?: string;
    error?: string;
  }>;
}) {
  const locale = await getLocale();
  const t = makeT(locale);
  const params = await searchParams;
  const workspaces = await fetchWorkspaces();

  const current = resolveWorkspace(workspaces, params);

  if (current === undefined) {
    redirect('/app');
  }

  const contextQuery = `?tenant=${current.tenant.id}&workspace=${current.workspace.id}`;

  const importSession =
    params.importId === undefined
      ? null
      : await fetchImportSession(current.tenant.id, current.workspace.id, params.importId);
  const showConfirm = importSession !== null && importSession.status === 'PENDING_CONFIRMATION';

  return (
    <main className="wizard-page">
      <WizardProgress locale={locale} currentStep="start" contextQuery={contextQuery} />

      <div className="wizard-content">
        <header className="wizard-header">
          <h1>{t('wizard.start.title')}</h1>
          <p className="wizard-lede">{t('wizard.start.lede')}</p>
        </header>

        {params.notice === 'importConfirmed' ? (
          <p className="success-message">{t('import.confirmed')}</p>
        ) : null}
        {params.error === 'importUrl' ? (
          <p className="warning-message">{t('import.urlRequired')}</p>
        ) : null}
        {params.error === 'importStart' ? (
          <p className="warning-message">{t('import.startFailed')}</p>
        ) : null}

        <section className="shell-card">
          <h2>{t('import.heading')}</h2>
          <p className="field-help">{t('import.help')}</p>
          {showConfirm && importSession !== null ? (
            <form action={confirmWebsiteImport} className="stacked-form">
              <input name="tenantId" type="hidden" value={current.tenant.id} />
              <input name="workspaceId" type="hidden" value={current.workspace.id} />
              <input name="importId" type="hidden" value={importSession.importId} />

              <h3>{t('import.profileCandidate')}</h3>
              <label className="check-item">
                <input defaultChecked name="createProfile" type="checkbox" />
                <span>
                  {importSession.profile.displayName}
                  {importSession.profile.description.length > 0
                    ? ` — ${importSession.profile.description}`
                    : ''}
                </span>
              </label>

              <h3>{t('import.offeringCandidates')}</h3>
              <div className="check-list">
                {importSession.offerings.map((offering) => (
                  <label className="check-item" key={offering.candidateId}>
                    <input
                      defaultChecked
                      name="offeringCandidateIds"
                      type="checkbox"
                      value={offering.candidateId}
                    />
                    <span>
                      {offering.name} ({offering.kind})
                    </span>
                  </label>
                ))}
              </div>

              <h3>{t('import.faqCandidates')}</h3>
              <p className="field-help">{t('import.faqNote')}</p>
              <ul>
                {importSession.faqs.map((faq) => (
                  <li key={faq.candidateId}>
                    <strong>{faq.question}</strong>
                    <br />
                    {faq.answer}
                  </li>
                ))}
              </ul>

              <div className="wizard-actions">
                <button className="button primary" type="submit">
                  {t('import.confirmAction')}
                </button>
                <a href={`/app/start${contextQuery}`} className="button secondary">
                  {t('import.cancelAction')}
                </a>
              </div>
            </form>
          ) : (
            <form action={startWebsiteImport} className="stacked-form">
              <input name="tenantId" type="hidden" value={current.tenant.id} />
              <input name="workspaceId" type="hidden" value={current.workspace.id} />
              <label htmlFor="website-url">{t('import.urlLabel')}</label>
              <input id="website-url" name="websiteUrl" placeholder="https://" type="url" />
              <div className="wizard-actions">
                <button className="button primary" type="submit">
                  {t('import.startAction')}
                </button>
              </div>
            </form>
          )}
        </section>

        <div className="wizard-cards">
          <div className="wizard-card">
            <div className="wizard-card-icon">🏢</div>
            <h2>{t('wizard.start.step1')}</h2>
            <p>{t('wizard.start.step1Desc')}</p>
          </div>
          <div className="wizard-card">
            <div className="wizard-card-icon">📋</div>
            <h2>{t('wizard.start.step2')}</h2>
            <p>{t('wizard.start.step2Desc')}</p>
          </div>
          <div className="wizard-card">
            <div className="wizard-card-icon">🚀</div>
            <h2>{t('wizard.start.step3')}</h2>
            <p>{t('wizard.start.step3Desc')}</p>
          </div>
        </div>

        <div className="wizard-actions">
          <a href={`/app/company${contextQuery}`} className="button primary">
            {t('wizard.start.beginAction')}
          </a>
          <a href={`/app${contextQuery}`} className="button secondary">
            {t('wizard.start.expertMode')}
          </a>
        </div>
      </div>
    </main>
  );
}
