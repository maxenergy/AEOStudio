import type { OfferingEnvelope, ProfileEnvelope } from '@aeostudio/contracts';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

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
      <p className="eyebrow">AEO Studio</p>
      <h1>业务资料 Onboarding</h1>
      <p>用开放字段描述公司、品牌、产品、服务或解决方案；类型与自定义维度不受行业枚举限制。</p>

      {profile !== undefined && viewProfileMode ? (
        <section className="shell-card">
          <h2>Profile Revision {profile.revision}</h2>
          <p>{profile.displayName}</p>
          <p>{profile.description}</p>
          <p>Profile 内容哈希：{profile.contentHash}</p>
          <a
            className="secondary-action"
            href={`/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${profile.profileId}&profileRevision=${profile.revision}&editProfile=1${returnOffering === undefined || returnOfferingRevision === undefined ? '' : `&returnOffering=${returnOffering}&returnOfferingRevision=${returnOfferingRevision}`}`}
          >
            编辑并创建新 Profile Revision
          </a>
          {profile.revision <= 1 ? null : (
            <a
              className="secondary-action"
              href={`/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${profile.profileId}&profileRevision=${profile.revision - 1}&viewProfile=1${returnOffering === undefined || returnOfferingRevision === undefined ? '' : `&returnOffering=${returnOffering}&returnOfferingRevision=${returnOfferingRevision}`}`}
            >
              查看 Profile Revision {profile.revision - 1}
            </a>
          )}
          {returnOffering === undefined || returnOfferingRevision === undefined ? null : (
            <a
              className="primary-action"
              href={`/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${profile.profileId}&profileRevision=${profile.revision}&offering=${returnOffering}&revision=${returnOfferingRevision}`}
            >
              返回 Offering Revision {returnOfferingRevision}
            </a>
          )}
        </section>
      ) : offering !== undefined && !editMode && !editProfileMode ? (
        <section className="shell-card">
          <p className="success-message" role="status">
            Onboarding 已保存
          </p>
          <h2>{offering.name}</h2>
          <p>Revision {offering.revision}</p>
          {attrValue(offering, 'industry') === '' &&
          attrValue(offering, 'company_size') === '' &&
          attrValue(offering, 'competitors') === '' ? null : (
            <>
              <h3>企业与行业</h3>
              <ul>
                {attrValue(offering, 'industry') === '' ? null : (
                  <li>行业：{attrValue(offering, 'industry')}</li>
                )}
                {attrValue(offering, 'company_size') === '' ? null : (
                  <li>公司规模：{attrValue(offering, 'company_size')}</li>
                )}
                {attrValue(offering, 'competitors') === '' ? null : (
                  <li>主要竞品：{attrValue(offering, 'competitors').replace(/\n/g, '、')}</li>
                )}
              </ul>
            </>
          )}
          {attrValue(offering, 'aeo_target_keywords') === '' &&
          attrValue(offering, 'geo_target_engines') === '' &&
          attrValue(offering, 'optimization_goals') === '' ? null : (
            <>
              <h3>AEO / GEO 优化配置</h3>
              <ul>
                {attrValue(offering, 'aeo_target_keywords') === '' ? null : (
                  <li>
                    AEO 目标关键词：
                    {attrValue(offering, 'aeo_target_keywords').replace(/\n/g, '、')}
                  </li>
                )}
                {attrValue(offering, 'geo_target_engines') === '' ? null : (
                  <li>
                    GEO 目标引擎：
                    {attrValue(offering, 'geo_target_engines').replace(/\n/g, '、')}
                  </li>
                )}
                {attrValue(offering, 'optimization_goals') === '' ? null : (
                  <li>
                    优化目标：{attrValue(offering, 'optimization_goals').replace(/\n/g, '、')}
                  </li>
                )}
              </ul>
            </>
          )}
          <h3>规格</h3>
          <ul>
            {offering.specifications.map((specification) => (
              <li key={`${specification.name}:${specification.value}`}>
                {specification.name}：{specification.value}
                {specification.unit === undefined ? '' : ` ${specification.unit}`}
              </li>
            ))}
          </ul>
          <h3>自定义维度</h3>
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
                  {attribute.label}：
                  {Array.isArray(attribute.value)
                    ? attribute.value.join('、')
                    : String(attribute.value)}
                </li>
              ))}
          </ul>
          <p>完整度 {offering.completeness.percent}%</p>
          <p>内容哈希：{offering.contentHash}</p>
          <a
            className="secondary-action"
            href={`/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${profileId}&profileRevision=${profileRevision ?? 1}&offering=${offering.offeringId}&revision=${offering.revision}&edit=1`}
          >
            编辑并创建新 Revision
          </a>
          <a
            className="secondary-action"
            href={`/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${profileId}&profileRevision=${profileRevision ?? 1}&editProfile=1&returnOffering=${offering.offeringId}&returnOfferingRevision=${offering.revision}`}
          >
            编辑 Profile 并创建新 Revision
          </a>
          {offering.revision <= 1 ? null : (
            <a
              className="secondary-action"
              href={`/app/onboarding?tenant=${tenantId}&workspace=${workspaceId}&profile=${profileId}&profileRevision=${profileRevision ?? 1}&offering=${offering.offeringId}&revision=${offering.revision - 1}`}
            >
              查看 Revision {offering.revision - 1}
            </a>
          )}
          <a
            className="secondary-action"
            href={`/app/prompts?tenant=${tenantId}&workspace=${workspaceId}&profile=${profileId}&profileRevision=${profileRevision ?? 1}&offering=${offering.offeringId}&offeringRevision=${offering.revision}`}
          >
            使用此知识建立 Prompt / Scenario
          </a>
          <a
            className="primary-action"
            href={`/app/jobs?tenant=${tenantId}&workspace=${workspaceId}&profile=${profileId}`}
          >
            启动 Profile Readiness
          </a>
          <br />
          <a
            className="primary-action"
            href={`/app/sites?tenant=${tenantId}&workspace=${workspaceId}&profile=${profileId}`}
          >
            验证并抓取 Site
          </a>
          <br />
          <a href={`/app?tenant=${tenantId}&workspace=${workspaceId}`}>返回 Workspace</a>
        </section>
      ) : profileId === undefined || (profile !== undefined && editProfileMode) ? (
        <section className="shell-card">
          <h2>{profile === undefined ? '建立 Profile' : '编辑 Profile'}</h2>
          {profile === undefined ? null : <p>当前 Profile 内容哈希：{profile.contentHash}</p>}
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
            <label htmlFor="profile-name">公司或品牌名称</label>
            <input
              defaultValue={profile?.displayName}
              id="profile-name"
              name="displayName"
              required
            />
            <label htmlFor="profile-description">简介</label>
            <textarea
              defaultValue={profile?.description}
              id="profile-description"
              name="description"
              required
              rows={4}
            />
            <label htmlFor="profile-website">网站</label>
            <input
              defaultValue={profile?.digitalAssets[0]?.url}
              id="profile-website"
              name="website"
              type="url"
            />
            <label htmlFor="profile-locale">Locale</label>
            <input
              defaultValue={profile?.targetMarkets[0]?.locale ?? 'zh-CN'}
              id="profile-locale"
              name="locale"
              required
            />
            <label htmlFor="profile-market">Market</label>
            <input
              defaultValue={profile?.targetMarkets[0]?.market ?? 'CN'}
              id="profile-market"
              name="market"
              required
            />
            <button className="primary-action" type="submit">
              {profile === undefined ? '保存 Profile' : '保存为新 Profile Revision'}
            </button>
          </form>
        </section>
      ) : (
        <section className="shell-card">
          <h2>{offering === undefined ? '描述 Offering' : '编辑 Offering'}</h2>
          <p>可填写产品、服务或解决方案；以下维度均为可编辑建议。</p>
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
            <label htmlFor="offering-kind">Offering 类型</label>
            <input defaultValue={offering?.kind} id="offering-kind" name="kind" required />
            <label htmlFor="offering-name">Offering 名称</label>
            <input defaultValue={offering?.name} id="offering-name" name="name" required />
            <h3>企业与行业信息</h3>
            <label htmlFor="offering-industry">行业</label>
            <select
              defaultValue={attrValue(offering, 'industry')}
              id="offering-industry"
              name="industry"
            >
              <option value="">请选择行业（可选）</option>
              <option value="software">软件 / SaaS</option>
              <option value="ai">人工智能 / 大模型</option>
              <option value="hardware">硬件 / 智能制造</option>
              <option value="ecommerce">电商 / 零售</option>
              <option value="finance">金融 / 保险</option>
              <option value="healthcare">医疗 / 健康</option>
              <option value="education">教育 / 培训</option>
              <option value="manufacturing">制造业</option>
              <option value="logistics">物流 / 供应链</option>
              <option value="energy">能源 / 环保</option>
              <option value="media">媒体 / 文娱</option>
              <option value="food">餐饮 / 食品</option>
              <option value="realestate">房地产 / 建筑</option>
              <option value="legal">法律 / 咨询</option>
              <option value="other">其他</option>
            </select>
            <label htmlFor="offering-company-size">公司规模</label>
            <select
              defaultValue={attrValue(offering, 'company_size')}
              id="offering-company-size"
              name="companySize"
            >
              <option value="">请选择规模（可选）</option>
              <option value="1-10">1–10 人</option>
              <option value="11-50">11–50 人</option>
              <option value="51-200">51–200 人</option>
              <option value="201-500">201–500 人</option>
              <option value="501-1000">501–1000 人</option>
              <option value="1000+">1000 人以上</option>
            </select>
            <label htmlFor="offering-competitors">主要竞品（每行一个，或逗号分隔）</label>
            <textarea
              defaultValue={attrValue(offering, 'competitors')}
              id="offering-competitors"
              name="competitors"
              placeholder={'例如：\nCompetitorA\nCompetitorB'}
              rows={3}
            />
            <label htmlFor="offering-principle">原理</label>
            <textarea
              defaultValue={offering?.principle}
              id="offering-principle"
              name="principle"
              required
              rows={4}
            />
            <h3>规格</h3>
            <label htmlFor="specification-name-1">规格名称 1</label>
            <input
              defaultValue={offering?.specifications[0]?.name}
              id="specification-name-1"
              name="specificationName"
            />
            <label htmlFor="specification-value-1">规格值 1</label>
            <input
              defaultValue={offering?.specifications[0]?.value}
              id="specification-value-1"
              name="specificationValue"
            />
            <label htmlFor="specification-unit-1">规格单位 1</label>
            <input
              defaultValue={offering?.specifications[0]?.unit}
              id="specification-unit-1"
              name="specificationUnit"
            />
            <label htmlFor="offering-taxonomy">Taxonomy（每行一个标签）</label>
            <textarea
              defaultValue={offering?.taxonomy.join('\n')}
              id="offering-taxonomy"
              name="taxonomy"
              rows={3}
            />
            <label htmlFor="offering-features">功能</label>
            <textarea
              defaultValue={offering?.features.join('\n')}
              id="offering-features"
              name="features"
              rows={3}
            />
            <label htmlFor="offering-usage">使用方法</label>
            <textarea
              defaultValue={offering?.usage.join('\n')}
              id="offering-usage"
              name="usage"
              rows={3}
            />
            <label htmlFor="offering-scenarios">应用场景</label>
            <textarea
              defaultValue={offering?.applicationScenarios.join('\n')}
              id="offering-scenarios"
              name="applicationScenarios"
              rows={3}
            />
            <label htmlFor="offering-compatibility">兼容性</label>
            <textarea
              defaultValue={offering?.compatibility.join('\n')}
              id="offering-compatibility"
              name="compatibility"
              rows={3}
            />
            <label htmlFor="offering-evidence">证据提示</label>
            <textarea
              defaultValue={offering?.evidenceHints.join('\n')}
              id="offering-evidence"
              name="evidenceHints"
              rows={3}
            />
            <h3>AEO / GEO 优化配置</h3>
            <p className="field-help">
              AEO（Answer Engine Optimization）关注 AI 回答中的可见度；GEO（Generative Engine
              Optimization）关注生成式引擎的引用与推荐。
            </p>
            <label htmlFor="offering-aeo-keywords">AEO 目标关键词 / 问题（每行一个）</label>
            <textarea
              defaultValue={attrValue(offering, 'aeo_target_keywords')}
              id="offering-aeo-keywords"
              name="aeoKeywords"
              placeholder={'例如：\n最好的企业AI平台是哪个\nAIBOX 和竞品对比如何'}
              rows={3}
            />
            <label htmlFor="offering-geo-engines">GEO 目标引擎（每行一个）</label>
            <textarea
              defaultValue={attrValue(offering, 'geo_target_engines')}
              id="offering-geo-engines"
              name="geoEngines"
              placeholder={'例如：\nChatGPT\nClaude\nGemini\nPerplexity\n豆包\nKimi'}
              rows={3}
            />
            <label htmlFor="offering-goals">优化目标（每行一个）</label>
            <textarea
              defaultValue={attrValue(offering, 'optimization_goals')}
              id="offering-goals"
              name="optimizationGoals"
              placeholder={
                '例如：\n提升品牌在AI回答中的引用率\n增加官网自然流量\n建立行业权威内容资产'
              }
              rows={3}
            />
            <OfferingAttributesFields
              {...(offering === undefined ? {} : { initialAttributes: offering.attributes })}
            />
            <button className="primary-action" type="submit">
              {offering === undefined ? '保存 Offering' : '保存为新 Revision'}
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
