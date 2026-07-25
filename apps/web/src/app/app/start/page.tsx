import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { makeT } from '../../../lib/i18n';
import { getLocale } from '../../../lib/i18n/get-locale';
import { WizardProgress } from '../wizard-progress';

function apiOrigin(): string {
  return process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3200';
}

interface WorkspaceEntry {
  tenant: { id: string; name: string };
  workspace: { id: string; name: string };
  activeRole: string;
}

async function fetchWorkspaces(): Promise<WorkspaceEntry[]> {
  try {
    const response = await fetch(`${apiOrigin()}/api/v1/workspaces`, {
      cache: 'no-store',
      headers: { cookie: (await cookies()).toString() },
    });
    if (!response.ok) return [];
    const result = (await response.json()) as {
      data: { workspaces: WorkspaceEntry[] };
    };
    return result.data.workspaces;
  } catch {
    return [];
  }
}

export default async function StartPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string; workspace?: string }>;
}) {
  const locale = await getLocale();
  const t = makeT(locale);
  const params = await searchParams;
  const workspaces = await fetchWorkspaces();

  const current =
    workspaces.find(
      (entry) => entry.tenant.id === params.tenant && entry.workspace.id === params.workspace,
    ) ?? workspaces[0];

  if (current === undefined) {
    redirect('/app');
  }

  const contextQuery = `?tenant=${current.tenant.id}&workspace=${current.workspace.id}`;

  return (
    <main className="wizard-page">
      <WizardProgress locale={locale} currentStep="start" contextQuery={contextQuery} />

      <div className="wizard-content">
        <header className="wizard-header">
          <h1>{t('wizard.start.title')}</h1>
          <p className="wizard-lede">{t('wizard.start.lede')}</p>
        </header>

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
