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

export default async function ProductsPage({
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
        currentStep="products"
        completedSteps={['start', 'company']}
        contextQuery={contextQuery}
      />

      <div className="wizard-content">
        <header className="wizard-header">
          <h1>{t('wizard.products.title')}</h1>
          <p className="wizard-lede">{t('wizard.products.lede')}</p>
        </header>

        <div className="wizard-embed">
          <p>
            <a href={`/app/onboarding${contextQuery}`} className="button primary">
              {t('nav.onboarding')}
            </a>
          </p>
        </div>

        <div className="wizard-actions">
          <a href={`/app/company${contextQuery}`} className="button secondary">
            {t('wizard.backAction')}
          </a>
          <a href={`/app/audiences${contextQuery}`} className="button primary">
            {t('wizard.nextAction')}
          </a>
        </div>
      </div>
    </main>
  );
}
