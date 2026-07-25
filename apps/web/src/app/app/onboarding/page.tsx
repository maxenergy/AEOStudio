import type { OfferingEnvelope, ProfileEnvelope } from '@aeostudio/contracts';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { makeT } from '../../../lib/i18n';
import { getLocale } from '../../../lib/i18n/get-locale';
import { OfferingAttributesFields } from './offering-attributes-fields';

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

function lines(value: FormDataEntryValue | null): string[] {
  return typeof value === 'string'
    ? value
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
}

async function saveProfile(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const locale = requiredText(formData, 'locale');
  const market = requiredText(formData, 'market');
  const rawProfileId = formData.get('profileId');
  const profileId =
    typeof rawProfileId === 'string' && rawProfileId.trim().length > 0
      ? rawProfileId.trim()
      : undefined;
  const rawReturnOffering = formData.get('returnOffering');
  const returnOffering =
    typeof rawReturnOffering === 'string' && rawReturnOffering.trim().length > 0
      ? rawReturnOffering.trim()
      : undefined;
  const rawReturnOfferingRevision = formData.get('returnOfferingRevision');
  const returnOfferingRevision =
    typeof rawReturnOfferingRevision === 'string' && rawReturnOfferingRevision.trim().length > 0
      ? rawReturnOfferingRevision.trim()
      : undefined;
  const website = formData.get('website');
  const endpoint =
    profileId === undefined
      ? `${apiOrigin()}/api/v1/tenants/${encodeURIComponent(tenantId)}/workspaces/${encodeURIComponent(workspaceId)}/profiles`
      : `${apiOrigin()}/api/v1/tenants/${encodeURIComponent(tenantId)}/workspaces/${encodeURIComponent(workspaceId)}/profiles/${encodeURIComponent(profileId)}/revisions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      cookie: (await cookies()).toString(),
      origin: webOrigin(),
    },
    body: JSON.stringify({
      displayName: requiredText(formData, 'displayName'),
      description: requiredText(formData, 'description'),
      digitalAssets:
        typeof website === 'string' && website.trim().length > 0
          ? [{ label: 'Website', url: website.trim() }]
          : [],
      targetMarkets: [{ locale, market }],
    }),
  });
  if (!response.ok) {
    redirect(
      `/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}${profileId === undefined ? '' : `&profile=${profileId}&editProfile=1`}&error=profile`,
    );
  }
  const result = (await response.json()) as ProfileEnvelope;
  if (profileId !== undefined) {
    redirect(
      `/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${result.data.profile.profileId}&profileRevision=${result.data.profile.revision}&viewProfile=1${returnOffering === undefined || returnOfferingRevision === undefined ? '' : `&returnOffering=${returnOffering}&returnOfferingRevision=${returnOfferingRevision}`}`,
    );
  }
  redirect(
    `/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${result.data.profile.profileId}&profileRevision=${result.data.profile.revision}&locale=${locale}&market=${market}`,
  );
}

function dynamicValue(valueType: string, rawValue: string): unknown {
  if (valueType === 'number') {
    return Number(rawValue);
  }
  if (valueType === 'boolean') {
    return rawValue === 'true';
  }
  if (valueType === 'string_list') {
    return rawValue
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return rawValue;
}

function dynamicAttributes(formData: FormData) {
  const keys = formData.getAll('attributeKey');
  const labels = formData.getAll('attributeLabel');
  const types = formData.getAll('attributeType');
  const values = formData.getAll('attributeValue');
  if (new Set([keys.length, labels.length, types.length, values.length]).size !== 1) {
    throw new Error('INVALID_ATTRIBUTE_ROWS');
  }
  const result: {
    key: string;
    label: string;
    valueType: string;
    required: boolean;
    value: unknown;
  }[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = typeof keys[index] === 'string' ? (keys[index] as string).trim() : '';
    const label = typeof labels[index] === 'string' ? (labels[index] as string).trim() : '';
    const valueType = typeof types[index] === 'string' ? (types[index] as string).trim() : 'text';
    const rawValue = typeof values[index] === 'string' ? (values[index] as string).trim() : '';
    if (key.length === 0 && label.length === 0 && rawValue.length === 0) continue;
    if (key.length === 0 || label.length === 0 || rawValue.length === 0) {
      throw new Error('INVALID_ATTRIBUTE_ROWS');
    }
    result.push({
      key,
      label,
      valueType,
      required: false,
      value: dynamicValue(valueType, rawValue),
    });
  }
  return result;
}

/** 结构化业务字段对应的标准 attribute key，存入 Offering attributes */
export const BUSINESS_ATTRIBUTE_KEYS = [
  'industry',
  'company_size',
  'competitors',
  'aeo_target_keywords',
  'geo_target_engines',
  'optimization_goals',
] as const;

function optionalText(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return value.trim();
}

function optionalList(formData: FormData, name: string): string[] {
  const value = formData.get(name);
  if (typeof value !== 'string') return [];
  return value
    .split(/[\n,，]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function businessAttributes(formData: FormData) {
  const result: {
    key: string;
    label: string;
    valueType: string;
    required: boolean;
    value: unknown;
  }[] = [];
  const industry = optionalText(formData, 'industry');
  if (industry !== undefined) {
    result.push({
      key: 'industry',
      label: '行业',
      valueType: 'text',
      required: false,
      value: industry,
    });
  }
  const companySize = optionalText(formData, 'companySize');
  if (companySize !== undefined) {
    result.push({
      key: 'company_size',
      label: '公司规模',
      valueType: 'text',
      required: false,
      value: companySize,
    });
  }
  const competitors = optionalList(formData, 'competitors');
  if (competitors.length > 0) {
    result.push({
      key: 'competitors',
      label: '主要竞品',
      valueType: 'string_list',
      required: false,
      value: competitors,
    });
  }
  const aeoKeywords = optionalList(formData, 'aeoKeywords');
  if (aeoKeywords.length > 0) {
    result.push({
      key: 'aeo_target_keywords',
      label: 'AEO 目标关键词',
      valueType: 'string_list',
      required: false,
      value: aeoKeywords,
    });
  }
  const geoEngines = optionalList(formData, 'geoEngines');
  if (geoEngines.length > 0) {
    result.push({
      key: 'geo_target_engines',
      label: 'GEO 目标引擎',
      valueType: 'string_list',
      required: false,
      value: geoEngines,
    });
  }
  const goals = optionalList(formData, 'optimizationGoals');
  if (goals.length > 0) {
    result.push({
      key: 'optimization_goals',
      label: '优化目标',
      valueType: 'string_list',
      required: false,
      value: goals,
    });
  }
  return result;
}

async function saveOffering(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const profileId = requiredText(formData, 'profileId');
  const profileRevision = requiredText(formData, 'profileRevision');
  const locale = requiredText(formData, 'locale');
  const market = requiredText(formData, 'market');
  const rawSpecificationName = formData.get('specificationName');
  const rawSpecificationValue = formData.get('specificationValue');
  const rawSpecificationUnit = formData.get('specificationUnit');
  if (
    typeof rawSpecificationName !== 'string' ||
    typeof rawSpecificationValue !== 'string' ||
    typeof rawSpecificationUnit !== 'string'
  ) {
    throw new Error('INVALID_SPECIFICATION_ROW');
  }
  const specificationName = rawSpecificationName.trim();
  const specificationValue = rawSpecificationValue.trim();
  const specificationUnit = rawSpecificationUnit.trim();
  if (
    (specificationName.length === 0) !== (specificationValue.length === 0) ||
    (specificationName.length === 0 && specificationUnit.length > 0)
  ) {
    throw new Error('INVALID_SPECIFICATION_ROW');
  }
  const specifications =
    specificationName.length === 0
      ? []
      : [
          {
            name: specificationName,
            value: specificationValue,
            ...(specificationUnit.length === 0 ? {} : { unit: specificationUnit }),
          },
        ];
  const rawOfferingId = formData.get('offeringId');
  const offeringId =
    typeof rawOfferingId === 'string' && rawOfferingId.trim().length > 0
      ? rawOfferingId.trim()
      : undefined;
  const structured = businessAttributes(formData);
  const structuredKeys = new Set(structured.map((entry) => entry.key));
  const custom = dynamicAttributes(formData).filter((entry) => !structuredKeys.has(entry.key));
  const endpoint =
    offeringId === undefined
      ? `${apiOrigin()}/api/v1/tenants/${encodeURIComponent(tenantId)}/workspaces/${encodeURIComponent(workspaceId)}/profiles/${encodeURIComponent(profileId)}/offerings`
      : `${apiOrigin()}/api/v1/tenants/${encodeURIComponent(tenantId)}/workspaces/${encodeURIComponent(workspaceId)}/offerings/${encodeURIComponent(offeringId)}/revisions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      cookie: (await cookies()).toString(),
      origin: webOrigin(),
    },
    body: JSON.stringify({
      kind: requiredText(formData, 'kind'),
      name: requiredText(formData, 'name'),
      locale,
      market,
      taxonomy: lines(formData.get('taxonomy')),
      principle: requiredText(formData, 'principle'),
      specifications,
      features: lines(formData.get('features')),
      usage: lines(formData.get('usage')),
      applicationScenarios: lines(formData.get('applicationScenarios')),
      compatibility: lines(formData.get('compatibility')),
      evidenceHints: lines(formData.get('evidenceHints')),
      attributes: [...structured, ...custom],
    }),
  });
  if (!response.ok) {
    redirect(
      `/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${profileId}&locale=${locale}&market=${market}${offeringId === undefined ? '' : `&offering=${offeringId}`}&error=offering`,
    );
  }
  const result = (await response.json()) as OfferingEnvelope;
  redirect(
    `/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${profileId}&profileRevision=${profileRevision}&offering=${result.data.offering.offeringId}&revision=${result.data.offering.revision}&notice=saved`,
  );
}

type OfferingData = OfferingEnvelope['data']['offering'];

function attrValue(offering: OfferingData | undefined, key: string): string {
  const attribute = offering?.attributes.find((entry) => entry.key === key);
  if (attribute === undefined) return '';
  if (Array.isArray(attribute.value)) return attribute.value.join('\n');
  return String(attribute.value);
}

interface OnboardingPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const locale = await getLocale();
  const t = makeT(locale);
  const query = await searchParams;
  const tenantId = typeof query.tenant === 'string' ? query.tenant : undefined;
  const workspaceId = typeof query.workspace === 'string' ? query.workspace : undefined;
  if (tenantId === undefined || workspaceId === undefined) {
    redirect('/app');
  }
  const profileId = typeof query.profile === 'string' ? query.profile : undefined;
  const profileRevision =
    typeof query.profileRevision === 'string'
      ? query.profileRevision
      : profileId === undefined
        ? undefined
        : '1';
  const offeringId = typeof query.offering === 'string' ? query.offering : undefined;
  const revision = typeof query.revision === 'string' ? query.revision : undefined;
  const editMode = query.edit === '1';
  const editProfileMode = query.editProfile === '1';
  const viewProfileMode = query.viewProfile === '1';
  const returnOffering =
    typeof query.returnOffering === 'string' ? query.returnOffering : undefined;
  const returnOfferingRevision =
    typeof query.returnOfferingRevision === 'string' ? query.returnOfferingRevision : undefined;
  let profile: ProfileEnvelope['data']['profile'] | undefined;
  if (profileId !== undefined && profileRevision !== undefined) {
    const response = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/profiles/${profileId}/revisions/${profileRevision}`,
      { cache: 'no-store', headers: { cookie: (await cookies()).toString() } },
    );
    if (response.ok) {
      profile = ((await response.json()) as ProfileEnvelope).data.profile;
    }
  }
  let offering: OfferingEnvelope['data']['offering'] | undefined;
  if (offeringId !== undefined && revision !== undefined) {
    const response = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/offerings/${offeringId}/revisions/${revision}`,
      { cache: 'no-store', headers: { cookie: (await cookies()).toString() } },
    );
    if (response.ok) {
      offering = ((await response.json()) as OfferingEnvelope).data.offering;
    }
  }

  return (
    <main>
      <p className="eyebrow">{t('onboarding.eyebrow')}</p>
      <h1>{t('onboarding.title')}</h1>
      <p>{t('onboarding.lede')}</p>

      {profile !== undefined && viewProfileMode ? (
        <section className="shell-card">
          <h2>{t('onboarding.profileRevisionHeading', { revision: profile.revision })}</h2>
          <p>{profile.displayName}</p>
          <p>{profile.description}</p>
          <p>{t('onboarding.profileHash', { hash: profile.contentHash })}</p>
          <a
            className="secondary-action"
            href={`/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${profile.profileId}&profileRevision=${profile.revision}&editProfile=1${returnOffering === undefined || returnOfferingRevision === undefined ? '' : `&returnOffering=${returnOffering}&returnOfferingRevision=${returnOfferingRevision}`}`}
          >
            {t('onboarding.editProfileRevision')}
          </a>
          {profile.revision <= 1 ? null : (
            <a
              className="secondary-action"
              href={`/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${profile.profileId}&profileRevision=${profile.revision - 1}&viewProfile=1${returnOffering === undefined || returnOfferingRevision === undefined ? '' : `&returnOffering=${returnOffering}&returnOfferingRevision=${returnOfferingRevision}`}`}
            >
              {t('onboarding.viewProfileRevision', { revision: profile.revision - 1 })}
            </a>
          )}
          {returnOffering === undefined || returnOfferingRevision === undefined ? null : (
            <a
              className="primary-action"
              href={`/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${profile.profileId}&profileRevision=${profile.revision}&offering=${returnOffering}&revision=${returnOfferingRevision}`}
            >
              {t('onboarding.backToOffering', { revision: returnOfferingRevision })}
            </a>
          )}
        </section>
      ) : offering !== undefined && !editMode && !editProfileMode ? (
        <section className="shell-card">
          <p className="success-message" role="status">
            {t('onboarding.saved')}
          </p>
          <h2>{offering.name}</h2>
          <p>{t('onboarding.revision', { revision: offering.revision })}</p>
          {attrValue(offering, 'industry') === '' &&
          attrValue(offering, 'company_size') === '' &&
          attrValue(offering, 'competitors') === '' ? null : (
            <>
              <h3>{t('onboarding.businessSection')}</h3>
              <ul>
                {attrValue(offering, 'industry') === '' ? null : (
                  <li>
                    {t('onboarding.industryValue', { value: attrValue(offering, 'industry') })}
                  </li>
                )}
                {attrValue(offering, 'company_size') === '' ? null : (
                  <li>
                    {t('onboarding.companySizeValue', {
                      value: attrValue(offering, 'company_size'),
                    })}
                  </li>
                )}
                {attrValue(offering, 'competitors') === '' ? null : (
                  <li>
                    {t('onboarding.competitorsValue', {
                      value: attrValue(offering, 'competitors').replace(/\n/g, '、'),
                    })}
                  </li>
                )}
              </ul>
            </>
          )}
          {attrValue(offering, 'aeo_target_keywords') === '' &&
          attrValue(offering, 'geo_target_engines') === '' &&
          attrValue(offering, 'optimization_goals') === '' ? null : (
            <>
              <h3>{t('onboarding.aeoConfigSection')}</h3>
              <ul>
                {attrValue(offering, 'aeo_target_keywords') === '' ? null : (
                  <li>
                    {t('onboarding.aeoKeywordsValue', {
                      value: attrValue(offering, 'aeo_target_keywords').replace(/\n/g, '、'),
                    })}
                  </li>
                )}
                {attrValue(offering, 'geo_target_engines') === '' ? null : (
                  <li>
                    {t('onboarding.geoEnginesValue', {
                      value: attrValue(offering, 'geo_target_engines').replace(/\n/g, '、'),
                    })}
                  </li>
                )}
                {attrValue(offering, 'optimization_goals') === '' ? null : (
                  <li>
                    {t('onboarding.goalsValue', {
                      value: attrValue(offering, 'optimization_goals').replace(/\n/g, '、'),
                    })}
                  </li>
                )}
              </ul>
            </>
          )}
          <h3>{t('onboarding.specsSection')}</h3>
          <ul>
            {offering.specifications.map((specification) => (
              <li key={`${specification.name}:${specification.value}`}>
                {t('onboarding.nameValue', {
                  name: specification.name,
                  value: specification.value,
                })}
                {specification.unit === undefined ? '' : ` ${specification.unit}`}
              </li>
            ))}
          </ul>
          <h3>{t('onboarding.customDimensionsSection')}</h3>
          <ul>
            {offering.attributes
              .filter(
                (attribute) =>
                  !(
                    [
                      'industry',
                      'company_size',
                      'competitors',
                      'aeo_target_keywords',
                      'geo_target_engines',
                      'optimization_goals',
                    ] as readonly string[]
                  ).includes(attribute.key),
              )
              .map((attribute) => (
                <li key={attribute.key}>
                  {t('onboarding.nameValue', {
                    name: attribute.label,
                    value: Array.isArray(attribute.value)
                      ? attribute.value.join('、')
                      : String(attribute.value),
                  })}
                </li>
              ))}
          </ul>
          <p>{t('onboarding.completeness', { percent: offering.completeness.percent })}</p>
          <p>{t('onboarding.contentHash', { hash: offering.contentHash })}</p>
          <a
            className="secondary-action"
            href={`/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${profileId}&profileRevision=${profileRevision ?? 1}&offering=${offering.offeringId}&revision=${offering.revision}&edit=1`}
          >
            {t('onboarding.editNewRevision')}
          </a>
          <a
            className="secondary-action"
            href={`/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${profileId}&profileRevision=${profileRevision ?? 1}&editProfile=1&returnOffering=${offering.offeringId}&returnOfferingRevision=${offering.revision}`}
          >
            {t('onboarding.editProfileNewRevision')}
          </a>
          {offering.revision <= 1 ? null : (
            <a
              className="secondary-action"
              href={`/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${profileId}&profileRevision=${profileRevision ?? 1}&offering=${offering.offeringId}&revision=${offering.revision - 1}`}
            >
              {t('onboarding.viewRevision', { revision: offering.revision - 1 })}
            </a>
          )}
          <a
            className="secondary-action"
            href={`/app/prompts?tenant=${tenantId}&workspace=${workspaceId}&profile=${profileId}&profileRevision=${profileRevision ?? 1}&offering=${offering.offeringId}&offeringRevision=${offering.revision}`}
          >
            {t('onboarding.useKnowledge')}
          </a>
          <a
            className="primary-action"
            href={`/app/jobs?tenant=${tenantId}&workspace=${workspaceId}&profile=${profileId}`}
          >
            {t('onboarding.startReadiness')}
          </a>
          <br />
          <a
            className="primary-action"
            href={`/app/sites?tenant=${tenantId}&workspace=${workspaceId}&profile=${profileId}`}
          >
            {t('onboarding.verifySite')}
          </a>
          <br />
          <a href={`/app?tenant=${tenantId}&workspace=${workspaceId}`}>
            {t('onboarding.backToWorkspace')}
          </a>
        </section>
      ) : profileId === undefined || (profile !== undefined && editProfileMode) ? (
        <section className="shell-card">
          <h2>
            {profile === undefined ? t('onboarding.createProfile') : t('onboarding.editProfile')}
          </h2>
          {profile === undefined ? null : (
            <p>{t('onboarding.currentProfileHash', { hash: profile.contentHash })}</p>
          )}
          <form action={saveProfile} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            {profile === undefined ? null : (
              <input name="profileId" type="hidden" value={profile.profileId} />
            )}
            {returnOffering === undefined || returnOfferingRevision === undefined ? null : (
              <>
                <input name="returnOffering" type="hidden" value={returnOffering} />
                <input name="returnOfferingRevision" type="hidden" value={returnOfferingRevision} />
              </>
            )}
            <label htmlFor="profile-name">{t('onboarding.profileName')}</label>
            <input
              defaultValue={profile?.displayName}
              id="profile-name"
              name="displayName"
              required
            />
            <label htmlFor="profile-description">{t('onboarding.profileDescription')}</label>
            <textarea
              defaultValue={profile?.description}
              id="profile-description"
              name="description"
              required
              rows={4}
            />
            <label htmlFor="profile-website">{t('onboarding.profileWebsite')}</label>
            <input
              defaultValue={profile?.digitalAssets[0]?.url}
              id="profile-website"
              name="website"
              type="url"
            />
            <label htmlFor="profile-locale">{t('onboarding.profileLocale')}</label>
            <input
              defaultValue={profile?.targetMarkets[0]?.locale ?? 'zh-CN'}
              id="profile-locale"
              name="locale"
              required
            />
            <label htmlFor="profile-market">{t('onboarding.profileMarket')}</label>
            <input
              defaultValue={profile?.targetMarkets[0]?.market ?? 'CN'}
              id="profile-market"
              name="market"
              required
            />
            <button className="primary-action" type="submit">
              {profile === undefined
                ? t('onboarding.saveProfile')
                : t('onboarding.saveProfileRevision')}
            </button>
          </form>
        </section>
      ) : (
        <section className="shell-card">
          <h2>
            {offering === undefined
              ? t('onboarding.describeOffering')
              : t('onboarding.editOffering')}
          </h2>
          <p>{t('onboarding.offeringHelp')}</p>
          <form action={saveOffering} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <input name="profileId" type="hidden" value={profileId} />
            <input name="profileRevision" type="hidden" value={profileRevision ?? 1} />
            {offering === undefined ? null : (
              <input name="offeringId" type="hidden" value={offering.offeringId} />
            )}
            <input
              name="locale"
              type="hidden"
              value={offering?.locale ?? String(query.locale ?? 'zh-CN')}
            />
            <input
              name="market"
              type="hidden"
              value={offering?.market ?? String(query.market ?? 'CN')}
            />
            <label htmlFor="offering-kind">{t('onboarding.offeringKind')}</label>
            <input defaultValue={offering?.kind} id="offering-kind" name="kind" required />
            <label htmlFor="offering-name">{t('onboarding.offeringName')}</label>
            <input defaultValue={offering?.name} id="offering-name" name="name" required />
            <h3>{t('onboarding.businessInfoSection')}</h3>
            <label htmlFor="offering-industry">{t('onboarding.industry')}</label>
            <select
              defaultValue={attrValue(offering, 'industry')}
              id="offering-industry"
              name="industry"
            >
              <option value="">{t('onboarding.industryPlaceholder')}</option>
              <option value="software">{t('onboarding.industry.software')}</option>
              <option value="ai">{t('onboarding.industry.ai')}</option>
              <option value="hardware">{t('onboarding.industry.hardware')}</option>
              <option value="ecommerce">{t('onboarding.industry.ecommerce')}</option>
              <option value="finance">{t('onboarding.industry.finance')}</option>
              <option value="healthcare">{t('onboarding.industry.healthcare')}</option>
              <option value="education">{t('onboarding.industry.education')}</option>
              <option value="manufacturing">{t('onboarding.industry.manufacturing')}</option>
              <option value="logistics">{t('onboarding.industry.logistics')}</option>
              <option value="energy">{t('onboarding.industry.energy')}</option>
              <option value="media">{t('onboarding.industry.media')}</option>
              <option value="food">{t('onboarding.industry.food')}</option>
              <option value="realestate">{t('onboarding.industry.realestate')}</option>
              <option value="legal">{t('onboarding.industry.legal')}</option>
              <option value="other">{t('onboarding.industry.other')}</option>
            </select>
            <label htmlFor="offering-company-size">{t('onboarding.companySize')}</label>
            <select
              defaultValue={attrValue(offering, 'company_size')}
              id="offering-company-size"
              name="companySize"
            >
              <option value="">{t('onboarding.companySizePlaceholder')}</option>
              <option value="1-10">{t('onboarding.size.1-10')}</option>
              <option value="11-50">{t('onboarding.size.11-50')}</option>
              <option value="51-200">{t('onboarding.size.51-200')}</option>
              <option value="201-500">{t('onboarding.size.201-500')}</option>
              <option value="501-1000">{t('onboarding.size.501-1000')}</option>
              <option value="1000+">{t('onboarding.size.1000plus')}</option>
            </select>
            <label htmlFor="offering-competitors">{t('onboarding.competitors')}</label>
            <textarea
              defaultValue={attrValue(offering, 'competitors')}
              id="offering-competitors"
              name="competitors"
              placeholder={t('onboarding.competitorsPlaceholder')}
              rows={3}
            />
            <label htmlFor="offering-principle">{t('onboarding.principle')}</label>
            <textarea
              defaultValue={offering?.principle}
              id="offering-principle"
              name="principle"
              required
              rows={4}
            />
            <h3>{t('onboarding.specsSection')}</h3>
            <label htmlFor="specification-name-1">{t('onboarding.specName1')}</label>
            <input
              defaultValue={offering?.specifications[0]?.name}
              id="specification-name-1"
              name="specificationName"
            />
            <label htmlFor="specification-value-1">{t('onboarding.specValue1')}</label>
            <input
              defaultValue={offering?.specifications[0]?.value}
              id="specification-value-1"
              name="specificationValue"
            />
            <label htmlFor="specification-unit-1">{t('onboarding.specUnit1')}</label>
            <input
              defaultValue={offering?.specifications[0]?.unit}
              id="specification-unit-1"
              name="specificationUnit"
            />
            <label htmlFor="offering-taxonomy">{t('onboarding.taxonomy')}</label>
            <textarea
              defaultValue={offering?.taxonomy.join('\n')}
              id="offering-taxonomy"
              name="taxonomy"
              rows={3}
            />
            <label htmlFor="offering-features">{t('onboarding.features')}</label>
            <textarea
              defaultValue={offering?.features.join('\n')}
              id="offering-features"
              name="features"
              rows={3}
            />
            <label htmlFor="offering-usage">{t('onboarding.usage')}</label>
            <textarea
              defaultValue={offering?.usage.join('\n')}
              id="offering-usage"
              name="usage"
              rows={3}
            />
            <label htmlFor="offering-scenarios">{t('onboarding.scenarios')}</label>
            <textarea
              defaultValue={offering?.applicationScenarios.join('\n')}
              id="offering-scenarios"
              name="applicationScenarios"
              rows={3}
            />
            <label htmlFor="offering-compatibility">{t('onboarding.compatibility')}</label>
            <textarea
              defaultValue={offering?.compatibility.join('\n')}
              id="offering-compatibility"
              name="compatibility"
              rows={3}
            />
            <label htmlFor="offering-evidence">{t('onboarding.evidenceHints')}</label>
            <textarea
              defaultValue={offering?.evidenceHints.join('\n')}
              id="offering-evidence"
              name="evidenceHints"
              rows={3}
            />
            <h3>{t('onboarding.aeoConfigSection')}</h3>
            <p className="field-help">{t('onboarding.aeoGeoHelp')}</p>
            <label htmlFor="offering-aeo-keywords">{t('onboarding.aeoKeywords')}</label>
            <textarea
              defaultValue={attrValue(offering, 'aeo_target_keywords')}
              id="offering-aeo-keywords"
              name="aeoKeywords"
              placeholder={t('onboarding.aeoKeywordsPlaceholder')}
              rows={3}
            />
            <label htmlFor="offering-geo-engines">{t('onboarding.geoEngines')}</label>
            <textarea
              defaultValue={attrValue(offering, 'geo_target_engines')}
              id="offering-geo-engines"
              name="geoEngines"
              placeholder={t('onboarding.geoEnginesPlaceholder')}
              rows={3}
            />
            <label htmlFor="offering-goals">{t('onboarding.goals')}</label>
            <textarea
              defaultValue={attrValue(offering, 'optimization_goals')}
              id="offering-goals"
              name="optimizationGoals"
              placeholder={t('onboarding.goalsPlaceholder')}
              rows={3}
            />
            <OfferingAttributesFields
              {...(offering === undefined ? {} : { initialAttributes: offering.attributes })}
              locale={locale}
            />
            <button className="primary-action" type="submit">
              {offering === undefined
                ? t('onboarding.saveOffering')
                : t('onboarding.saveOfferingRevision')}
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
