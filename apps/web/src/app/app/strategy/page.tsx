import type {
  AudiencePersonaListEnvelope,
  ContentPolicyListEnvelope,
  OfferingListEnvelope,
  PromotionStrategyListEnvelope,
} from '@aeostudio/contracts';
import { redirect } from 'next/navigation';

import { makeT } from '../../../lib/i18n';
import { getLocale } from '../../../lib/i18n/get-locale';
import {
  checkboxValue,
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

type PromotionStrategyRevision =
  PromotionStrategyListEnvelope['data']['promotionStrategies'][number];
type ContentPolicyRevision = ContentPolicyListEnvelope['data']['contentPolicies'][number];
type AudiencePersonaRevision = AudiencePersonaListEnvelope['data']['audiencePersonas'][number];
type OfferingSummary = OfferingListEnvelope['data']['offerings'][number];

async function createPromotionStrategy(formData: FormData): Promise<never> {
  'use server';
  const tenantId = formData.get('tenantId');
  const workspaceId = formData.get('workspaceId');
  if (typeof tenantId !== 'string' || typeof workspaceId !== 'string') redirect('/app');
  const ok = await postKnowledge(`${knowledgeBase(tenantId, workspaceId)}/promotion-strategy`, {
    objectives: textList(formData, 'objectives'),
    priorityOfferingIds: idList(formData, 'priorityOfferingIds'),
    targetPersonaIds: idList(formData, 'targetPersonaIds'),
    targetMarkets: textList(formData, 'targetMarkets'),
    channelPriorities: textList(formData, 'channelPriorities'),
    contentTypes: textList(formData, 'contentTypes'),
    primaryCta: optionalText(formData, 'primaryCta'),
    measurementGoals: textList(formData, 'measurementGoals'),
  });
  const contextQuery = `?tenant=${tenantId}&workspace=${workspaceId}`;
  redirect(`/app/strategy${contextQuery}&${ok ? 'notice=strategySaved' : 'error=strategy'}`);
}

async function createContentPolicy(formData: FormData): Promise<never> {
  'use server';
  const tenantId = formData.get('tenantId');
  const workspaceId = formData.get('workspaceId');
  if (typeof tenantId !== 'string' || typeof workspaceId !== 'string') redirect('/app');
  const ok = await postKnowledge(`${knowledgeBase(tenantId, workspaceId)}/content-policy`, {
    locale: requiredText(formData, 'policyLocale'),
    audienceId: optionalText(formData, 'policyAudienceId'),
    journeyStage: optionalText(formData, 'policyJourneyStage'),
    objective: optionalText(formData, 'policyObjective'),
    tone: optionalText(formData, 'policyTone'),
    readingLevel: optionalText(formData, 'policyReadingLevel'),
    answerFirst: checkboxValue(formData, 'policyAnswerFirst'),
    includeFaq: checkboxValue(formData, 'policyIncludeFaq'),
    requiredEntities: textList(formData, 'policyRequiredEntities'),
    prohibitedTerms: textList(formData, 'policyProhibitedTerms'),
    requiredClaimRevisionIds: idList(formData, 'policyClaimRevisionIds'),
    schemaTypes: textList(formData, 'policySchemaTypes'),
    ctaPolicy: optionalText(formData, 'policyCtaPolicy'),
  });
  const contextQuery = `?tenant=${tenantId}&workspace=${workspaceId}`;
  redirect(`/app/strategy${contextQuery}&${ok ? 'notice=policySaved' : 'error=policy'}`);
}

export default async function StrategyPage({
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

  const [strategies, policies, offerings, personas] = await Promise.all([
    fetchKnowledgeList<PromotionStrategyRevision>(
      `${base}/promotion-strategy`,
      'promotionStrategies',
    ),
    fetchKnowledgeList<ContentPolicyRevision>(`${base}/content-policy`, 'contentPolicies'),
    fetchKnowledgeList<OfferingSummary>(`${base}/offerings`, 'offerings'),
    fetchKnowledgeList<AudiencePersonaRevision>(`${base}/audience-personas`, 'audiencePersonas'),
  ]);
  const latestPolicy = policies[policies.length - 1];

  return (
    <main className="wizard-page">
      <WizardProgress
        locale={locale}
        currentStep="strategy"
        completedSteps={['start', 'company', 'products', 'audiences', 'evidence']}
        contextQuery={contextQuery}
      />

      <div className="wizard-content">
        <header className="wizard-header">
          <h1>{t('wizard.strategy.title')}</h1>
          <p className="wizard-lede">{t('wizard.strategy.lede')}</p>
        </header>

        {params.notice === 'strategySaved' || params.notice === 'policySaved' ? (
          <p className="success-message">{t('knowledge.saved')}</p>
        ) : null}
        {params.error === 'strategy' || params.error === 'policy' ? (
          <p className="warning-message">{t('knowledge.saveFailed')}</p>
        ) : null}

        <section className="shell-card">
          <h2>{t('knowledge.strategy.heading')}</h2>
          <p className="field-help">{t('knowledge.strategy.help')}</p>
          <form action={createPromotionStrategy} className="stacked-form">
            <input name="tenantId" type="hidden" value={current.tenant.id} />
            <input name="workspaceId" type="hidden" value={current.workspace.id} />
            <label htmlFor="strategy-objectives">{t('knowledge.strategy.objectives')}</label>
            <textarea id="strategy-objectives" name="objectives" rows={3} />
            <p className="field-help">{t('knowledge.listHelp')}</p>
            <label htmlFor="strategy-markets">{t('knowledge.strategy.targetMarkets')}</label>
            <textarea id="strategy-markets" name="targetMarkets" rows={2} />
            <label htmlFor="strategy-channels">{t('knowledge.strategy.channelPriorities')}</label>
            <textarea id="strategy-channels" name="channelPriorities" rows={2} />
            <label htmlFor="strategy-content-types">{t('knowledge.strategy.contentTypes')}</label>
            <textarea id="strategy-content-types" name="contentTypes" rows={2} />
            <label htmlFor="strategy-cta">{t('knowledge.strategy.primaryCta')}</label>
            <input id="strategy-cta" name="primaryCta" />
            <label htmlFor="strategy-measurement">{t('knowledge.strategy.measurementGoals')}</label>
            <textarea id="strategy-measurement" name="measurementGoals" rows={2} />

            {offerings.length === 0 ? null : (
              <>
                <span className="stacked-form-label">
                  {t('knowledge.strategy.priorityOfferings')}
                </span>
                <div className="check-list">
                  {offerings.map((offering) => (
                    <label className="check-item" key={offering.id}>
                      <input name="priorityOfferingIds" type="checkbox" value={offering.id} />
                      <span>{offering.name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {personas.length === 0 ? null : (
              <>
                <span className="stacked-form-label">{t('knowledge.strategy.targetPersonas')}</span>
                <div className="check-list">
                  {personas.map((persona) => (
                    <label className="check-item" key={persona.id}>
                      <input name="targetPersonaIds" type="checkbox" value={persona.id} />
                      <span>{persona.name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}

            <button className="primary-action" type="submit">
              {t('knowledge.saveAction')}
            </button>
          </form>
        </section>

        {strategies.length === 0 ? null : (
          <section className="shell-card">
            <h2>{t('knowledge.strategy.listHeading')}</h2>
            {strategies
              .slice()
              .reverse()
              .map((entry) => (
                <article className="nested-card" key={entry.id}>
                  <h3>{t('knowledge.revisionLabel', { revision: entry.revision })}</h3>
                  {entry.objectives.length === 0 ? null : (
                    <p>
                      {t('knowledge.strategy.objectives')}
                      {entry.objectives.join('、')}
                    </p>
                  )}
                  {entry.primaryCta === '' ? null : (
                    <p>
                      {t('knowledge.strategy.primaryCta')}
                      {entry.primaryCta}
                    </p>
                  )}
                </article>
              ))}
          </section>
        )}

        <section className="shell-card">
          <h2>{t('knowledge.policy.heading')}</h2>
          <p className="field-help">{t('knowledge.policy.help')}</p>
          <form action={createContentPolicy} className="stacked-form">
            <input name="tenantId" type="hidden" value={current.tenant.id} />
            <input name="workspaceId" type="hidden" value={current.workspace.id} />
            <label htmlFor="policy-locale">{t('knowledge.policy.locale')}</label>
            <input
              defaultValue={latestPolicy?.locale ?? 'zh-CN'}
              id="policy-locale"
              name="policyLocale"
              required
            />
            <label htmlFor="policy-audience">{t('knowledge.policy.audienceId')}</label>
            <input
              defaultValue={latestPolicy?.audienceId ?? ''}
              id="policy-audience"
              name="policyAudienceId"
            />
            <label htmlFor="policy-journey">{t('knowledge.policy.journeyStage')}</label>
            <input
              defaultValue={latestPolicy?.journeyStage ?? ''}
              id="policy-journey"
              name="policyJourneyStage"
            />
            <label htmlFor="policy-objective">{t('knowledge.policy.objective')}</label>
            <input
              defaultValue={latestPolicy?.objective ?? ''}
              id="policy-objective"
              name="policyObjective"
            />
            <label htmlFor="policy-tone">{t('knowledge.policy.tone')}</label>
            <input defaultValue={latestPolicy?.tone ?? ''} id="policy-tone" name="policyTone" />
            <label htmlFor="policy-reading-level">{t('knowledge.policy.readingLevel')}</label>
            <input
              defaultValue={latestPolicy?.readingLevel ?? ''}
              id="policy-reading-level"
              name="policyReadingLevel"
            />
            <label>
              <input
                defaultChecked={latestPolicy?.answerFirst ?? true}
                name="policyAnswerFirst"
                type="checkbox"
              />{' '}
              {t('knowledge.policy.answerFirst')}
            </label>
            <label>
              <input
                defaultChecked={latestPolicy?.includeFaq ?? true}
                name="policyIncludeFaq"
                type="checkbox"
              />{' '}
              {t('knowledge.policy.includeFaq')}
            </label>
            <label htmlFor="policy-entities">{t('knowledge.policy.requiredEntities')}</label>
            <textarea
              defaultValue={latestPolicy?.requiredEntities.join('\n') ?? ''}
              id="policy-entities"
              name="policyRequiredEntities"
              rows={2}
            />
            <p className="field-help">{t('knowledge.listHelp')}</p>
            <label htmlFor="policy-prohibited">{t('knowledge.policy.prohibitedTerms')}</label>
            <textarea
              defaultValue={latestPolicy?.prohibitedTerms.join('\n') ?? ''}
              id="policy-prohibited"
              name="policyProhibitedTerms"
              rows={2}
            />
            <label htmlFor="policy-schema-types">{t('knowledge.policy.schemaTypes')}</label>
            <textarea
              defaultValue={latestPolicy?.schemaTypes.join('\n') ?? ''}
              id="policy-schema-types"
              name="policySchemaTypes"
              rows={2}
            />
            <label htmlFor="policy-cta-policy">{t('knowledge.policy.ctaPolicy')}</label>
            <input
              defaultValue={latestPolicy?.ctaPolicy ?? ''}
              id="policy-cta-policy"
              name="policyCtaPolicy"
            />
            <details className="advanced-fields">
              <summary>{t('knowledge.advancedFields')}</summary>
              <label htmlFor="policy-claim-ids">{t('knowledge.policy.claimRevisionIds')}</label>
              <textarea id="policy-claim-ids" name="policyClaimRevisionIds" rows={2} />
            </details>
            <button className="primary-action" type="submit">
              {t('knowledge.saveAction')}
            </button>
          </form>
        </section>

        {policies.length === 0 ? null : (
          <section className="shell-card">
            <h2>{t('knowledge.policy.listHeading')}</h2>
            {policies
              .slice()
              .reverse()
              .map((entry) => (
                <article className="nested-card" key={entry.id}>
                  <h3>
                    {entry.locale} · {t('knowledge.revisionLabel', { revision: entry.revision })}
                  </h3>
                  {entry.tone === '' ? null : (
                    <p>
                      {t('knowledge.policy.tone')}
                      {entry.tone}
                    </p>
                  )}
                  {entry.objective === '' ? null : (
                    <p>
                      {t('knowledge.policy.objective')}
                      {entry.objective}
                    </p>
                  )}
                </article>
              ))}
          </section>
        )}

        <div className="wizard-actions">
          <a href={`/app/evidence${contextQuery}`} className="button secondary">
            {t('wizard.backAction')}
          </a>
          <a href={`/app/channels${contextQuery}`} className="button primary">
            {t('wizard.nextAction')}
          </a>
        </div>
      </div>
    </main>
  );
}
