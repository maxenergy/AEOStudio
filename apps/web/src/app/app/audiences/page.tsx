import type {
  AudiencePersonaListEnvelope,
  CompetitorSetListEnvelope,
  OfferingListEnvelope,
} from '@aeostudio/contracts';
import { redirect } from 'next/navigation';

import { makeT } from '../../../lib/i18n';
import { getLocale } from '../../../lib/i18n/get-locale';
import {
  fetchKnowledgeList,
  fetchWorkspaces,
  idList,
  knowledgeBase,
  optionalText,
  postKnowledge,
  requiredText,
  resolveWorkspace,
  textList,
} from '../../../lib/knowledge';
import { WizardProgress } from '../wizard-progress';

type AudiencePersonaRevision = AudiencePersonaListEnvelope['data']['audiencePersonas'][number];
type CompetitorSetRevision = CompetitorSetListEnvelope['data']['competitorSets'][number];
type OfferingSummary = OfferingListEnvelope['data']['offerings'][number];

async function createAudiencePersona(formData: FormData): Promise<never> {
  'use server';
  const tenantId = formData.get('tenantId');
  const workspaceId = formData.get('workspaceId');
  if (typeof tenantId !== 'string' || typeof workspaceId !== 'string') redirect('/app');
  const ok = await postKnowledge(`${knowledgeBase(tenantId, workspaceId)}/audience-personas`, {
    name: requiredText(formData, 'personaName'),
    role: optionalText(formData, 'personaRole'),
    industry: optionalText(formData, 'personaIndustry'),
    region: optionalText(formData, 'personaRegion'),
    goals: textList(formData, 'personaGoals'),
    painPoints: textList(formData, 'personaPainPoints'),
    questions: textList(formData, 'personaQuestions'),
    objections: textList(formData, 'personaObjections'),
    decisionCriteria: textList(formData, 'personaDecisionCriteria'),
    channels: textList(formData, 'personaChannels'),
    journeyStages: textList(formData, 'personaJourneyStages'),
  });
  const contextQuery = `?tenant=${tenantId}&workspace=${workspaceId}`;
  redirect(`/app/audiences${contextQuery}&${ok ? 'notice=personaSaved' : 'error=persona'}`);
}

async function createCompetitorSet(formData: FormData): Promise<never> {
  'use server';
  const tenantId = formData.get('tenantId');
  const workspaceId = formData.get('workspaceId');
  if (typeof tenantId !== 'string' || typeof workspaceId !== 'string') redirect('/app');
  const ok = await postKnowledge(`${knowledgeBase(tenantId, workspaceId)}/competitor-sets`, {
    competitorName: requiredText(formData, 'competitorName'),
    website: optionalText(formData, 'competitorWebsite'),
    positioning: optionalText(formData, 'competitorPositioning'),
    matchedOfferingIds: idList(formData, 'matchedOfferingIds'),
    comparisonDimensions: textList(formData, 'comparisonDimensions'),
    allowedComparisons: textList(formData, 'allowedComparisons'),
    prohibitedComparisons: textList(formData, 'prohibitedComparisons'),
    evidenceSourceIds: idList(formData, 'evidenceSourceIds'),
  });
  const contextQuery = `?tenant=${tenantId}&workspace=${workspaceId}`;
  redirect(`/app/audiences${contextQuery}&${ok ? 'notice=competitorSaved' : 'error=competitor'}`);
}

export default async function AudiencesPage({
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

  const [personas, competitors, offerings] = await Promise.all([
    fetchKnowledgeList<AudiencePersonaRevision>(`${base}/audience-personas`, 'audiencePersonas'),
    fetchKnowledgeList<CompetitorSetRevision>(`${base}/competitor-sets`, 'competitorSets'),
    fetchKnowledgeList<OfferingSummary>(`${base}/offerings`, 'offerings'),
  ]);

  return (
    <main className="wizard-page">
      <WizardProgress
        locale={locale}
        currentStep="audiences"
        completedSteps={['start', 'company', 'products']}
        contextQuery={contextQuery}
      />

      <div className="wizard-content">
        <header className="wizard-header">
          <h1>{t('wizard.audiences.title')}</h1>
          <p className="wizard-lede">{t('wizard.audiences.lede')}</p>
        </header>

        {params.notice === 'personaSaved' || params.notice === 'competitorSaved' ? (
          <p className="success-message">{t('knowledge.saved')}</p>
        ) : null}
        {params.error === 'persona' || params.error === 'competitor' ? (
          <p className="warning-message">{t('knowledge.saveFailed')}</p>
        ) : null}

        <section className="shell-card">
          <h2>{t('knowledge.persona.heading')}</h2>
          <p className="field-help">{t('knowledge.persona.help')}</p>
          <form action={createAudiencePersona} className="stacked-form">
            <input name="tenantId" type="hidden" value={current.tenant.id} />
            <input name="workspaceId" type="hidden" value={current.workspace.id} />
            <label htmlFor="persona-name">{t('knowledge.persona.name')}</label>
            <input id="persona-name" name="personaName" required />
            <label htmlFor="persona-role">{t('knowledge.persona.role')}</label>
            <input id="persona-role" name="personaRole" />
            <label htmlFor="persona-industry">{t('knowledge.persona.industry')}</label>
            <input id="persona-industry" name="personaIndustry" />
            <label htmlFor="persona-region">{t('knowledge.persona.region')}</label>
            <input id="persona-region" name="personaRegion" />
            <label htmlFor="persona-goals">{t('knowledge.persona.goals')}</label>
            <textarea id="persona-goals" name="personaGoals" rows={3} />
            <p className="field-help">{t('knowledge.listHelp')}</p>
            <label htmlFor="persona-pain-points">{t('knowledge.persona.painPoints')}</label>
            <textarea id="persona-pain-points" name="personaPainPoints" rows={3} />
            <label htmlFor="persona-questions">{t('knowledge.persona.questions')}</label>
            <textarea id="persona-questions" name="personaQuestions" rows={3} />
            <label htmlFor="persona-objections">{t('knowledge.persona.objections')}</label>
            <textarea id="persona-objections" name="personaObjections" rows={3} />
            <label htmlFor="persona-criteria">{t('knowledge.persona.decisionCriteria')}</label>
            <textarea id="persona-criteria" name="personaDecisionCriteria" rows={3} />
            <label htmlFor="persona-channels">{t('knowledge.persona.channels')}</label>
            <textarea id="persona-channels" name="personaChannels" rows={2} />
            <label htmlFor="persona-journey">{t('knowledge.persona.journeyStages')}</label>
            <textarea id="persona-journey" name="personaJourneyStages" rows={2} />
            <button className="primary-action" type="submit">
              {t('knowledge.saveAction')}
            </button>
          </form>
        </section>

        {personas.length === 0 ? null : (
          <section className="shell-card">
            <h2>{t('knowledge.persona.listHeading')}</h2>
            {personas
              .slice()
              .reverse()
              .map((entry) => (
                <article className="nested-card" key={entry.id}>
                  <h3>{entry.name}</h3>
                  <p>
                    {entry.role === '' ? null : (
                      <span>
                        {t('knowledge.persona.role')}
                        {entry.role} ·{' '}
                      </span>
                    )}
                    {t('knowledge.revisionLabel', { revision: entry.revision })}
                  </p>
                  {entry.goals.length === 0 ? null : (
                    <p>
                      {t('knowledge.persona.goals')}
                      {entry.goals.join('、')}
                    </p>
                  )}
                </article>
              ))}
          </section>
        )}

        <section className="shell-card">
          <h2>{t('knowledge.competitor.heading')}</h2>
          <p className="field-help">{t('knowledge.competitor.help')}</p>
          <form action={createCompetitorSet} className="stacked-form">
            <input name="tenantId" type="hidden" value={current.tenant.id} />
            <input name="workspaceId" type="hidden" value={current.workspace.id} />
            <label htmlFor="competitor-name">{t('knowledge.competitor.name')}</label>
            <input id="competitor-name" name="competitorName" required />
            <label htmlFor="competitor-website">{t('knowledge.competitor.website')}</label>
            <input id="competitor-website" name="competitorWebsite" type="url" />
            <label htmlFor="competitor-positioning">{t('knowledge.competitor.positioning')}</label>
            <textarea id="competitor-positioning" name="competitorPositioning" rows={3} />
            <label htmlFor="competitor-dimensions">{t('knowledge.competitor.dimensions')}</label>
            <textarea id="competitor-dimensions" name="comparisonDimensions" rows={3} />
            <p className="field-help">{t('knowledge.listHelp')}</p>
            <label htmlFor="competitor-allowed">{t('knowledge.competitor.allowed')}</label>
            <textarea id="competitor-allowed" name="allowedComparisons" rows={2} />
            <label htmlFor="competitor-prohibited">{t('knowledge.competitor.prohibited')}</label>
            <textarea id="competitor-prohibited" name="prohibitedComparisons" rows={2} />

            {offerings.length === 0 ? null : (
              <>
                <span className="stacked-form-label">{t('knowledge.competitor.matched')}</span>
                <div className="check-list">
                  {offerings.map((offering) => (
                    <label className="check-item" key={offering.id}>
                      <input name="matchedOfferingIds" type="checkbox" value={offering.id} />
                      <span>{offering.name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}

            <details className="advanced-fields">
              <summary>{t('knowledge.advancedFields')}</summary>
              <label htmlFor="competitor-evidence-ids">
                {t('knowledge.competitor.evidenceSourceIds')}
              </label>
              <textarea id="competitor-evidence-ids" name="evidenceSourceIds" rows={2} />
            </details>
            <button className="primary-action" type="submit">
              {t('knowledge.saveAction')}
            </button>
          </form>
        </section>

        {competitors.length === 0 ? null : (
          <section className="shell-card">
            <h2>{t('knowledge.competitor.listHeading')}</h2>
            {competitors
              .slice()
              .reverse()
              .map((entry) => (
                <article className="nested-card" key={entry.id}>
                  <h3>{entry.competitorName}</h3>
                  <p>
                    {entry.website === '' ? null : <span>{entry.website} · </span>}
                    {t('knowledge.revisionLabel', { revision: entry.revision })}
                  </p>
                  {entry.positioning === '' ? null : <p>{entry.positioning}</p>}
                </article>
              ))}
          </section>
        )}

        <div className="wizard-actions">
          <a href={`/app/products${contextQuery}`} className="button secondary">
            {t('wizard.backAction')}
          </a>
          <a href={`/app/evidence${contextQuery}`} className="button primary">
            {t('wizard.nextAction')}
          </a>
        </div>
      </div>
    </main>
  );
}
