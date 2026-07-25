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

export default async function ContentPage({
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
      <WizardProgress
        locale={locale}
        currentStep="content"
        completedSteps={[
          'start',
          'company',
          'products',
          'audiences',
          'evidence',
          'strategy',
          'channels',
        ]}
        contextQuery={contextQuery}
      />

      <div className="wizard-content">
        <header className="wizard-header">
          <h1>{t('wizard.content.title')}</h1>
          <p className="wizard-lede">{t('wizard.content.lede')}</p>
        </header>

        <div className="wizard-embed">
          <p>
            <a href={`/app/artifacts${contextQuery}`} className="button primary">
              {t('nav.artifacts')}
            </a>
          </p>
        </div>

        <div className="wizard-actions">
          <a href={`/app/channels-wizard${contextQuery}`} className="button secondary">
            {t('wizard.backAction')}
          </a>
          <a href={`/app${contextQuery}`} className="button primary">
            {t('wizard.finishAction')}
          </a>
        </div>
      </div>
    </main>
  );
}
