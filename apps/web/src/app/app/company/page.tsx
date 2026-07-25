import type { IndustryContextListEnvelope } from '@aeostudio/contracts';
import { redirect } from 'next/navigation';

import { makeT } from '../../../lib/i18n';
import { getLocale } from '../../../lib/i18n/get-locale';
import {
  fetchKnowledgeList,
  fetchWorkspaces,
  knowledgeBase,
  postKnowledge,
  resolveWorkspace,
  textList,
} from '../../../lib/knowledge';
import { WizardProgress } from '../wizard-progress';

type IndustryContextRevision = IndustryContextListEnvelope['data']['industryContexts'][number];

async function createIndustryContext(formData: FormData): Promise<never> {
  'use server';
  const tenantId = formData.get('tenantId');
  const workspaceId = formData.get('workspaceId');
  if (typeof tenantId !== 'string' || typeof workspaceId !== 'string') redirect('/app');
  const ok = await postKnowledge(`${knowledgeBase(tenantId, workspaceId)}/industry-context`, {
    industryLabels: textList(formData, 'industryLabels'),
    subIndustryLabels: textList(formData, 'subIndustryLabels'),
    taxonomyRefs: textList(formData, 'taxonomyRefs'),
    synonyms: textList(formData, 'synonyms'),
    commonTerms: textList(formData, 'commonTerms'),
    commonQuestions: textList(formData, 'commonQuestions'),
    regulations: textList(formData, 'regulations'),
    prohibitedClaims: textList(formData, 'prohibitedClaims'),
    seasonality: textList(formData, 'seasonality'),
    authoritativeSources: textList(formData, 'authoritativeSources'),
  });
  const contextQuery = `?tenant=${tenantId}&workspace=${workspaceId}`;
  redirect(`/app/company${contextQuery}&${ok ? 'notice=industrySaved' : 'error=industry'}`);
}

export default async function CompanyPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string; workspace?: string; notice?: string; error?: string }>;
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
  const base = knowledgeBase(current.tenant.id, current.workspace.id);
  const industryContexts = await fetchKnowledgeList<IndustryContextRevision>(
    `${base}/industry-context`,
    'industryContexts',
  );
  const latestIndustry = industryContexts[industryContexts.length - 1];

  return (
    <main className="wizard-page">
      <WizardProgress
        locale={locale}
        currentStep="company"
        completedSteps={['start']}
        contextQuery={contextQuery}
      />

      <div className="wizard-content">
        <header className="wizard-header">
          <h1>{t('wizard.company.title')}</h1>
          <p className="wizard-lede">{t('wizard.company.lede')}</p>
        </header>

        {params.notice === 'industrySaved' ? (
          <p className="success-message">{t('knowledge.saved')}</p>
        ) : null}
        {params.error === 'industry' ? (
          <p className="warning-message">{t('knowledge.saveFailed')}</p>
        ) : null}

        <div className="wizard-embed">
          <p>
            <a href={`/app/onboarding${contextQuery}`} className="button secondary">
              {t('nav.onboarding')}
            </a>
          </p>
        </div>

        <section className="shell-card">
          <h2>{t('knowledge.industry.heading')}</h2>
          <p className="field-help">{t('knowledge.industry.help')}</p>
          <form action={createIndustryContext} className="stacked-form">
            <input name="tenantId" type="hidden" value={current.tenant.id} />
            <input name="workspaceId" type="hidden" value={current.workspace.id} />
            <label htmlFor="industry-labels">{t('knowledge.industry.labels')}</label>
            <textarea
              defaultValue={latestIndustry?.industryLabels.join('\n') ?? ''}
              id="industry-labels"
              name="industryLabels"
              rows={3}
            />
            <p className="field-help">{t('knowledge.listHelp')}</p>
            <label htmlFor="industry-sub-labels">{t('knowledge.industry.subLabels')}</label>
            <textarea
              defaultValue={latestIndustry?.subIndustryLabels.join('\n') ?? ''}
              id="industry-sub-labels"
              name="subIndustryLabels"
              rows={3}
            />
            <label htmlFor="industry-synonyms">{t('knowledge.industry.synonyms')}</label>
            <textarea
              defaultValue={latestIndustry?.synonyms.join('\n') ?? ''}
              id="industry-synonyms"
              name="synonyms"
              rows={3}
            />
            <label htmlFor="industry-terms">{t('knowledge.industry.commonTerms')}</label>
            <textarea
              defaultValue={latestIndustry?.commonTerms.join('\n') ?? ''}
              id="industry-terms"
              name="commonTerms"
              rows={3}
            />
            <label htmlFor="industry-questions">{t('knowledge.industry.commonQuestions')}</label>
            <textarea
              defaultValue={latestIndustry?.commonQuestions.join('\n') ?? ''}
              id="industry-questions"
              name="commonQuestions"
              rows={3}
            />
            <label htmlFor="industry-regulations">{t('knowledge.industry.regulations')}</label>
            <textarea
              defaultValue={latestIndustry?.regulations.join('\n') ?? ''}
              id="industry-regulations"
              name="regulations"
              rows={3}
            />
            <label htmlFor="industry-prohibited">{t('knowledge.industry.prohibitedClaims')}</label>
            <textarea
              defaultValue={latestIndustry?.prohibitedClaims.join('\n') ?? ''}
              id="industry-prohibited"
              name="prohibitedClaims"
              rows={3}
            />
            <label htmlFor="industry-seasonality">{t('knowledge.industry.seasonality')}</label>
            <textarea
              defaultValue={latestIndustry?.seasonality.join('\n') ?? ''}
              id="industry-seasonality"
              name="seasonality"
              rows={2}
            />
            <label htmlFor="industry-sources">{t('knowledge.industry.authoritativeSources')}</label>
            <textarea
              defaultValue={latestIndustry?.authoritativeSources.join('\n') ?? ''}
              id="industry-sources"
              name="authoritativeSources"
              rows={3}
            />
            <details className="advanced-fields">
              <summary>{t('knowledge.advancedFields')}</summary>
              <label htmlFor="industry-taxonomy">{t('knowledge.industry.taxonomyRefs')}</label>
              <textarea
                defaultValue={latestIndustry?.taxonomyRefs.join('\n') ?? ''}
                id="industry-taxonomy"
                name="taxonomyRefs"
                rows={2}
              />
            </details>
            <button className="primary-action" type="submit">
              {t('knowledge.saveAction')}
            </button>
          </form>
        </section>

        {industryContexts.length === 0 ? null : (
          <section className="shell-card">
            <h2>{t('knowledge.historyHeading')}</h2>
            {industryContexts
              .slice()
              .reverse()
              .map((entry) => (
                <article className="nested-card" key={entry.id}>
                  <h3>{t('knowledge.revisionLabel', { revision: entry.revision })}</h3>
                  <p>
                    {t('knowledge.industry.labels')}
                    {entry.industryLabels.length === 0
                      ? t('knowledge.empty')
                      : entry.industryLabels.join('、')}
                  </p>
                  <p>{t('knowledge.contentHash', { hash: entry.contentHash })}</p>
                </article>
              ))}
          </section>
        )}

        <div className="wizard-actions">
          <a href={`/app/start${contextQuery}`} className="button secondary">
            {t('wizard.backAction')}
          </a>
          <a href={`/app/products${contextQuery}`} className="button primary">
            {t('wizard.nextAction')}
          </a>
        </div>
      </div>
    </main>
  );
}
