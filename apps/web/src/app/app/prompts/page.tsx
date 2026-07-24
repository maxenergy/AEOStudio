import type {
  PromptBundleEnvelope,
  PromptRegistryEnvelope,
  WorkspaceListEnvelope,
} from '@aeostudio/contracts';
import type {
  ManualMeasurementImportDetailEnvelope,
  ManualMeasurementImportEnvelope,
  MeasurementProviderPolicyStateEnvelope,
  StartMeasurementRunEnvelope,
} from '@aeostudio/contracts/measurement';
import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

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

function optionalText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function location(input: {
  tenantId: string;
  workspaceId: string;
  promptSetId?: string;
  manualImportId?: string;
}) {
  const query = new URLSearchParams({ tenant: input.tenantId, workspace: input.workspaceId });
  if (input.promptSetId !== undefined) query.set('promptSet', input.promptSetId);
  if (input.manualImportId !== undefined) query.set('manualImport', input.manualImportId);
  return `/app/prompts?${query.toString()}`;
}

function headers(cookie: string) {
  return { 'content-type': 'application/json', cookie, origin: webOrigin() };
}

function sourceContext(formData: FormData) {
  return {
    profile: {
      id: requiredText(formData, 'profileId'),
      revision: Number(requiredText(formData, 'profileRevision')),
    },
    offering: {
      id: requiredText(formData, 'offeringId'),
      revision: Number(requiredText(formData, 'offeringRevision')),
    },
    claimRevisionIds: optionalText(formData, 'claimRevisionIds')
      .split(/[,\r\n]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

function scenario(formData: FormData) {
  const [providerKey, surfaceKey, acquisitionMethod] = requiredText(
    formData,
    'providerSurface',
  ).split('::');
  if (providerKey === undefined || surfaceKey === undefined || acquisitionMethod === undefined) {
    throw new Error('INVALID_PROVIDER_SURFACE');
  }
  return {
    providerKey,
    surfaceKey,
    model: requiredText(formData, 'model'),
    modelVersion: requiredText(formData, 'modelVersion'),
    account: requiredText(formData, 'account'),
    acquisitionMethod,
    freshSession: formData.get('freshSession') === 'on',
    searchEnabled: formData.get('searchEnabled') === 'on',
    parameters: {},
    repetitions: Number(requiredText(formData, 'repetitions')),
  };
}

function scopeLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.split('|').map((part) => part.trim()))
    .filter((parts) => parts.some((part) => part.length > 0))
    .map(([market = '', locale = '', region = '']) => ({ market, locale, region }));
}

async function proposePromptSet(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/prompt-sets/proposals`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: headers((await cookies()).toString()),
      body: JSON.stringify({
        title: requiredText(formData, 'title'),
        subject: requiredText(formData, 'subject'),
        sourceContext: sourceContext(formData),
        scopes: [
          {
            market: requiredText(formData, 'market'),
            locale: requiredText(formData, 'locale'),
            region: requiredText(formData, 'region'),
          },
          ...scopeLines(optionalText(formData, 'additionalScopes')),
        ],
        scenario: scenario(formData),
      }),
    },
  );
  const base = location({ tenantId, workspaceId });
  if (!response.ok) redirect(`${base}&error=proposal`);
  const bundle = ((await response.json()) as PromptBundleEnvelope).data;
  redirect(`${location({ tenantId, workspaceId, promptSetId: bundle.promptSet.id })}&notice=draft`);
}

async function approvePromptSet(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const promptSetId = requiredText(formData, 'promptSetId');
  const revisionId = requiredText(formData, 'revisionId');
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/prompt-sets/${promptSetId}/revisions/${revisionId}/approve`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: headers((await cookies()).toString()),
      body: JSON.stringify({
        expectedPromptHash: requiredText(formData, 'promptHash'),
        expectedScenarioHash: requiredText(formData, 'scenarioHash'),
      }),
    },
  );
  const base = location({ tenantId, workspaceId, promptSetId });
  redirect(`${base}&${response.ok ? 'notice=approved' : 'error=approval'}`);
}

async function revisePromptSet(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const promptSetId = requiredText(formData, 'promptSetId');
  const existingIds = JSON.parse(requiredText(formData, 'promptIds')) as unknown;
  const promptIds = Array.isArray(existingIds)
    ? existingIds.filter((value): value is string => typeof value === 'string')
    : [];
  const prompts = requiredText(formData, 'promptLines')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [text = '', persona = '', journeyStage = '', queryType = ''] = line
        .split('\t')
        .map((value) => value.trim());
      return {
        id: promptIds[index] ?? randomUUID(),
        text,
        persona: persona || 'user-defined persona',
        journeyStage: journeyStage || 'user-defined journey stage',
        queryType: queryType || 'user-defined query type',
      };
    });
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/prompt-sets/${promptSetId}/revisions`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: headers((await cookies()).toString()),
      body: JSON.stringify({
        expectedRevision: Number(requiredText(formData, 'expectedRevision')),
        prompts,
        scopes: scopeLines(requiredText(formData, 'scopeLines')),
        scenario: JSON.parse(requiredText(formData, 'scenario')) as unknown,
      }),
    },
  );
  const base = location({ tenantId, workspaceId, promptSetId });
  redirect(`${base}&${response.ok ? 'notice=revision' : 'error=revision'}`);
}

async function startMeasurementRun(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const kind = requiredText(formData, 'kind');
  if (kind !== 'BASELINE' && kind !== 'REMEASUREMENT') {
    throw new Error('INVALID_MEASUREMENT_KIND');
  }
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/measurement-runs`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: headers((await cookies()).toString()),
      body: JSON.stringify({
        promptSetId: requiredText(formData, 'promptSetId'),
        promptRevisionId: requiredText(formData, 'promptRevisionId'),
        scenarioId: requiredText(formData, 'scenarioId'),
        expectedPromptHash: requiredText(formData, 'expectedPromptHash'),
        expectedScenarioHash: requiredText(formData, 'expectedScenarioHash'),
        ...(optionalText(formData, 'manualImportId').length === 0
          ? {}
          : {
              manualImportId: requiredText(formData, 'manualImportId'),
              expectedManualImportHash: requiredText(formData, 'expectedManualImportHash'),
            }),
        kind,
        idempotencyKey: requiredText(formData, 'idempotencyKey'),
      }),
    },
  );
  if (!response.ok) {
    redirect(
      `${location({
        tenantId,
        workspaceId,
        promptSetId: requiredText(formData, 'promptSetId'),
      })}&error=measurement`,
    );
  }
  const started = ((await response.json()) as StartMeasurementRunEnvelope).data;
  const query = new URLSearchParams({
    tenant: tenantId,
    workspace: workspaceId,
    run: started.measurementRun.id,
  });
  redirect(`/app/measurement?${query.toString()}`);
}

async function setMeasurementProviderPolicy(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const promptSetId = requiredText(formData, 'promptSetId');
  const manualImportId = optionalText(formData, 'manualImportId');
  const providerKey = requiredText(formData, 'providerKey');
  const surfaceKey = requiredText(formData, 'surfaceKey');
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}` +
      `/measurement-provider-policies/${encodeURIComponent(providerKey)}/${encodeURIComponent(surfaceKey)}`,
    {
      method: 'PUT',
      cache: 'no-store',
      headers: headers((await cookies()).toString()),
      body: JSON.stringify({
        adapterVersion: requiredText(formData, 'adapterVersion'),
        termsVersion: requiredText(formData, 'termsVersion'),
        termsApproved: formData.has('termsApproved'),
        authorizationApproved: formData.has('authorizationApproved'),
        crossBorderApproved: formData.has('crossBorderApproved'),
        purpose: requiredText(formData, 'purpose'),
        policyVersion: requiredText(formData, 'policyVersion'),
      }),
    },
  );
  redirect(
    `${location({
      tenantId,
      workspaceId,
      promptSetId,
      ...(manualImportId.length === 0 ? {} : { manualImportId }),
    })}&${response.ok ? 'notice=measurement-policy' : 'error=measurement-policy'}`,
  );
}

async function submitManualMeasurementImport(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const promptSetId = requiredText(formData, 'promptSetId');
  let entries: unknown;
  try {
    entries = JSON.parse(requiredText(formData, 'entriesJson')) as unknown;
  } catch {
    redirect(`${location({ tenantId, workspaceId, promptSetId })}&error=manual-import-json`);
  }
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/measurement-manual-imports`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: headers((await cookies()).toString()),
      body: JSON.stringify({
        schemaVersion: 'measurement-manual-import.v1',
        promptSetId,
        promptRevisionId: requiredText(formData, 'promptRevisionId'),
        scenarioId: requiredText(formData, 'scenarioId'),
        expectedPromptHash: requiredText(formData, 'expectedPromptHash'),
        expectedScenarioHash: requiredText(formData, 'expectedScenarioHash'),
        idempotencyKey: requiredText(formData, 'idempotencyKey'),
        entries,
      }),
    },
  );
  if (!response.ok) {
    redirect(`${location({ tenantId, workspaceId, promptSetId })}&error=manual-import`);
  }
  const imported = ((await response.json()) as ManualMeasurementImportEnvelope).data.manualImport;
  redirect(
    `${location({
      tenantId,
      workspaceId,
      promptSetId,
      manualImportId: imported.id,
    })}&notice=manual-import-submitted`,
  );
}

async function reviewManualMeasurementImport(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const promptSetId = requiredText(formData, 'promptSetId');
  const manualImportId = requiredText(formData, 'manualImportId');
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/measurement-manual-imports/${manualImportId}/review`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: headers((await cookies()).toString()),
      body: JSON.stringify({
        expectedContentHash: requiredText(formData, 'expectedContentHash'),
        decision: requiredText(formData, 'decision'),
        note: optionalText(formData, 'note') || undefined,
      }),
    },
  );
  redirect(
    `${location({ tenantId, workspaceId, promptSetId, manualImportId })}&${
      response.ok ? 'notice=manual-import-reviewed' : 'error=manual-import-review'
    }`,
  );
}

interface PromptsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PromptsPage({ searchParams }: PromptsPageProps) {
  const query = await searchParams;
  const tenantId = typeof query.tenant === 'string' ? query.tenant : undefined;
  const workspaceId = typeof query.workspace === 'string' ? query.workspace : undefined;
  if (tenantId === undefined || workspaceId === undefined) redirect('/app');
  const cookie = (await cookies()).toString();
  const workspaceResponse = await fetch(`${apiOrigin()}/api/v1/tenants`, {
    cache: 'no-store',
    headers: { cookie },
  });
  if (!workspaceResponse.ok) redirect('/login');
  const workspaces = (await workspaceResponse.json()) as WorkspaceListEnvelope;
  const membership = workspaces.data.workspaces.find(
    (entry) => entry.tenant.id === tenantId && entry.workspace.id === workspaceId,
  );
  if (membership === undefined) redirect('/app');
  const registryResponse = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/measurement-registry`,
    { cache: 'no-store', headers: { cookie } },
  );
  if (!registryResponse.ok) throw new Error('MEASUREMENT_REGISTRY_UNAVAILABLE');
  const registry = ((await registryResponse.json()) as PromptRegistryEnvelope).data.entries;
  const promptSetId = typeof query.promptSet === 'string' ? query.promptSet : undefined;
  const promptRevisionId =
    typeof query.promptRevision === 'string' ? query.promptRevision : undefined;
  let bundle: PromptBundleEnvelope['data'] | undefined;
  if (promptSetId !== undefined) {
    const promptPath =
      promptRevisionId === undefined
        ? `prompt-sets/${promptSetId}`
        : `prompt-sets/${promptSetId}/revisions/${promptRevisionId}`;
    const response = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/${promptPath}`,
      { cache: 'no-store', headers: { cookie } },
    );
    if (response.ok) bundle = ((await response.json()) as PromptBundleEnvelope).data;
  }
  const manualImportId = typeof query.manualImport === 'string' ? query.manualImport : undefined;
  let manualImportDetail: ManualMeasurementImportDetailEnvelope['data'] | undefined;
  if (manualImportId !== undefined) {
    const response = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/measurement-manual-imports/${manualImportId}`,
      { cache: 'no-store', headers: { cookie } },
    );
    if (response.ok) {
      manualImportDetail = ((await response.json()) as ManualMeasurementImportDetailEnvelope).data;
    }
  }
  const manualImport = manualImportDetail?.manualImport;
  const mayManage = ['OWNER', 'ADMIN', 'EDITOR', 'ANALYST'].includes(membership.activeRole);
  const mayApprove = mayManage || membership.activeRole === 'REVIEWER';
  const mayMeasure = ['OWNER', 'ADMIN', 'ANALYST'].includes(membership.activeRole);
  const mayReviewManualImport = ['OWNER', 'REVIEWER'].includes(membership.activeRole);
  const mayManageMeasurementPolicy = membership.activeRole === 'OWNER';
  const profileId = typeof query.profile === 'string' ? query.profile : '';
  const profileRevision = typeof query.profileRevision === 'string' ? query.profileRevision : '1';
  const offeringId = typeof query.offering === 'string' ? query.offering : '';
  const offeringRevision =
    typeof query.offeringRevision === 'string' ? query.offeringRevision : '1';
  const registryEntry =
    bundle === undefined
      ? undefined
      : registry.find(
          (entry) =>
            entry.providerKey === bundle.scenario.providerKey &&
            entry.surfaceKey === bundle.scenario.surfaceKey,
        );
  let measurementPolicyState: MeasurementProviderPolicyStateEnvelope['data']['state'] | undefined;
  if (registryEntry !== undefined) {
    const response = await fetch(
      `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}` +
        `/measurement-provider-policies/${encodeURIComponent(registryEntry.providerKey)}/${encodeURIComponent(registryEntry.surfaceKey)}`,
      { cache: 'no-store', headers: { cookie } },
    );
    if (response.ok) {
      measurementPolicyState = ((await response.json()) as MeasurementProviderPolicyStateEnvelope)
        .data.state;
    }
  }
  const requiresReviewedManualImport =
    registryEntry?.acquisitionClass === 'MANUAL_IMPORT' &&
    registryEntry.adapterVersion === 'manual-import-v1';
  const exampleManualEntries =
    bundle === undefined
      ? '[]'
      : JSON.stringify(
          [
            {
              promptId: bundle.revision.prompts[0]?.id,
              scope: bundle.revision.scopes[0],
              repetition: 1,
              observedAt: new Date().toISOString(),
              result: {
                status: 'PASS',
                observation: {
                  mention: true,
                  citation: true,
                  accuracy: 'MATCH',
                  coverage: true,
                },
                cost: { amount: '0.000000', currency: 'USD' },
                rawEvidence: {
                  responseText: 'Paste the captured answer here.',
                  citations: [],
                  error: null,
                },
              },
            },
          ],
          null,
          2,
        );

  return (
    <main>
      <p className="eyebrow">AEO Studio</p>
      <h1>Prompt / Scenario Lab</h1>
      <p>
        Consumer
        Surface、Provider、模型与采集方式分别保存；这里只配置和人工批准，不执行真实测量，也不生成跨
        Surface 总分。
      </p>

      {query.notice === 'manual-import-submitted' ? (
        <p className="success-message">Manual import 已提交，等待 Reviewer / Owner 审核。</p>
      ) : null}
      {query.notice === 'manual-import-reviewed' ? (
        <p className="success-message">Manual import 已审核，可绑定到新的 baseline。</p>
      ) : null}
      {query.notice === 'measurement-policy' ? (
        <p className="success-message">
          Provider policy 已保存，并重新计算 execution eligibility。
        </p>
      ) : null}
      {typeof query.error === 'string' && query.error.startsWith('manual-import') ? (
        <p className="warning-message">
          Manual import 操作失败，请检查 JSON、exact hash 与审核状态。
        </p>
      ) : null}
      {query.error === 'measurement-policy' ? (
        <p className="warning-message">
          Provider policy 保存失败；未批准的数据不会发送到 Adapter。
        </p>
      ) : null}

      {promptRevisionId !== undefined && bundle === undefined ? (
        <section className="shell-card">
          <h2>Exact Prompt revision</h2>
          <p>Exact Prompt revision ID：{promptRevisionId}</p>
          <p className="warning-message">该 exact Prompt revision 当前不可读取。</p>
        </section>
      ) : null}

      {bundle === undefined && mayManage ? (
        <section className="shell-card">
          <h2>提议可复现问题集</h2>
          <form action={proposePromptSet} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <label htmlFor="prompt-title">Prompt Set 标题</label>
            <input id="prompt-title" name="title" required />
            <label htmlFor="prompt-subject">研究主题</label>
            <input id="prompt-subject" name="subject" required />
            <label htmlFor="prompt-profile-id">Profile revision ID</label>
            <input defaultValue={profileId} id="prompt-profile-id" name="profileId" required />
            <label htmlFor="prompt-profile-revision">Profile revision</label>
            <input
              defaultValue={profileRevision}
              id="prompt-profile-revision"
              min="1"
              name="profileRevision"
              required
              type="number"
            />
            <label htmlFor="prompt-offering-id">Offering revision ID</label>
            <input defaultValue={offeringId} id="prompt-offering-id" name="offeringId" required />
            <label htmlFor="prompt-offering-revision">Offering revision</label>
            <input
              defaultValue={offeringRevision}
              id="prompt-offering-revision"
              min="1"
              name="offeringRevision"
              required
              type="number"
            />
            <label htmlFor="prompt-claims">Approved Claim revision IDs</label>
            <textarea defaultValue="" id="prompt-claims" name="claimRevisionIds" />
            <label htmlFor="prompt-market">Market</label>
            <input defaultValue="SG" id="prompt-market" name="market" required />
            <label htmlFor="prompt-locale">Locale</label>
            <input defaultValue="en-SG" id="prompt-locale" name="locale" required />
            <label htmlFor="prompt-region">Region</label>
            <input defaultValue="Singapore" id="prompt-region" name="region" required />
            <label htmlFor="additional-scopes">Additional scopes (market | locale | region)</label>
            <textarea
              aria-describedby="additional-scopes-help"
              id="additional-scopes"
              name="additionalScopes"
              placeholder={'US | en-US | United States\nDE | de-DE | Germany'}
              rows={2}
            />
            <p id="additional-scopes-help">批准时总计必须为 1–3 个完整 scope。</p>
            <label htmlFor="provider-surface">Provider / Consumer Surface</label>
            <select id="provider-surface" name="providerSurface">
              {registry.map((entry) => (
                <option
                  key={entry.id}
                  value={`${entry.providerKey}::${entry.surfaceKey}::${entry.acquisitionMethod}`}
                >
                  {entry.providerName} / {entry.surfaceName} ({entry.status})
                </option>
              ))}
            </select>
            <label htmlFor="scenario-model">Model</label>
            <input defaultValue="fixture-search-model" id="scenario-model" name="model" required />
            <label htmlFor="scenario-model-version">Model version</label>
            <input
              defaultValue="2026-07"
              id="scenario-model-version"
              name="modelVersion"
              required
            />
            <label htmlFor="scenario-account">Account</label>
            <input
              defaultValue="workspace-fixture-account"
              id="scenario-account"
              name="account"
              required
            />
            <label htmlFor="scenario-repetitions">Repetitions</label>
            <input
              defaultValue="3"
              id="scenario-repetitions"
              min="1"
              name="repetitions"
              required
              type="number"
            />
            <label>
              <input defaultChecked name="freshSession" type="checkbox" /> Fresh session
            </label>
            <label>
              <input defaultChecked name="searchEnabled" type="checkbox" /> Search enabled
            </label>
            <button className="primary-action" type="submit">
              生成 20 个确定性问题草稿
            </button>
          </form>
        </section>
      ) : null}

      {bundle === undefined ? null : (
        <>
          <section className="shell-card">
            <h2>Prompt revision {bundle.revision.revision}</h2>
            <p>Exact Prompt revision ID：{bundle.revision.id}</p>
            <p>Title：{bundle.revision.title}</p>
            <p>Subject：{bundle.revision.subject}</p>
            <p>
              状态：<strong data-testid="prompt-status">{bundle.revision.status}</strong>
            </p>
            <p>
              Prompt 数量：
              <strong data-testid="prompt-count">{bundle.revision.prompts.length}</strong>
            </p>
            <p>Prompt hash：{bundle.revision.contentHash}</p>
            <p>Scenario hash：{bundle.scenario.contentHash}</p>
            <p>Provider：{bundle.scenario.providerKey}</p>
            <p>Consumer Surface：{bundle.scenario.surfaceKey}</p>
            <p>
              Model/version：{bundle.scenario.model} / {bundle.scenario.modelVersion}
            </p>
            <p>
              Scope：
              {bundle.revision.scopes
                .map((scope) => `${scope.market}/${scope.locale}/${scope.region}`)
                .join(', ')}
            </p>
            <p>
              Fresh session/search/repetitions：{String(bundle.scenario.freshSession)} /{' '}
              {String(bundle.scenario.searchEnabled)} / {bundle.scenario.repetitions}
            </p>
            {bundle.previousApprovalStale ? <p className="warning-message">旧批准已失效</p> : null}
          </section>

          {mayApprove && bundle.revision.status === 'DRAFT' ? (
            <section className="shell-card">
              <form action={approvePromptSet} className="stacked-form">
                <input name="tenantId" type="hidden" value={tenantId} />
                <input name="workspaceId" type="hidden" value={workspaceId} />
                <input name="promptSetId" type="hidden" value={bundle.promptSet.id} />
                <input name="revisionId" type="hidden" value={bundle.revision.id} />
                <input name="promptHash" type="hidden" value={bundle.revision.contentHash} />
                <input name="scenarioHash" type="hidden" value={bundle.scenario.contentHash} />
                <button className="primary-action" type="submit">
                  批准 exact Prompt / Scenario hash
                </button>
              </form>
            </section>
          ) : null}

          {registryEntry !== undefined && measurementPolicyState !== undefined ? (
            <section className="shell-card" data-testid="measurement-policy-card">
              <h2>Provider policy &amp; execution eligibility</h2>
              <p>
                Provider / Surface：{registryEntry.providerName} / {registryEntry.surfaceName}（
                {registryEntry.providerKey} / {registryEntry.surfaceKey}）
              </p>
              <p>
                Execution：
                <strong data-testid="measurement-policy-status">
                  {measurementPolicyState.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE'}
                </strong>
              </p>
              <p>
                Required Adapter：{measurementPolicyState.requiredAdapterVersion} · Terms：
                {measurementPolicyState.requiredTermsVersion ?? 'Adapter descriptor unavailable'}
              </p>
              {measurementPolicyState.eligible ? (
                <p className="success-message">
                  Exact Adapter、terms、authorization 与 cross-border approval 均已满足。
                </p>
              ) : (
                <p className="warning-message">
                  当前 baseline 只会安全记录 NOT_CHECKED，不会把数据发送给 Adapter。原因：
                  {measurementPolicyState.reasons.join(', ')}
                </p>
              )}
              {measurementPolicyState.policy === null ? null : (
                <p>
                  Current policy：{measurementPolicyState.policy.policyVersion} · approved{' '}
                  {measurementPolicyState.policy.approvedAt}
                </p>
              )}
              {mayManageMeasurementPolicy ? (
                <form action={setMeasurementProviderPolicy} className="stacked-form">
                  <input name="tenantId" type="hidden" value={tenantId} />
                  <input name="workspaceId" type="hidden" value={workspaceId} />
                  <input name="promptSetId" type="hidden" value={bundle.promptSet.id} />
                  <input name="providerKey" type="hidden" value={registryEntry.providerKey} />
                  <input name="surfaceKey" type="hidden" value={registryEntry.surfaceKey} />
                  {manualImportId === undefined ? null : (
                    <input name="manualImportId" type="hidden" value={manualImportId} />
                  )}
                  <label htmlFor="measurement-policy-adapter-version">Adapter version</label>
                  <input
                    id="measurement-policy-adapter-version"
                    name="adapterVersion"
                    readOnly
                    value={measurementPolicyState.requiredAdapterVersion}
                  />
                  <label htmlFor="measurement-policy-terms-version">Provider terms version</label>
                  <input
                    defaultValue={
                      measurementPolicyState.policy?.termsVersion ??
                      measurementPolicyState.requiredTermsVersion ??
                      ''
                    }
                    id="measurement-policy-terms-version"
                    name="termsVersion"
                    required
                  />
                  <label>
                    <input
                      defaultChecked={measurementPolicyState.policy?.termsApproved ?? false}
                      name="termsApproved"
                      type="checkbox"
                    />{' '}
                    Terms approved
                  </label>
                  <label>
                    <input
                      defaultChecked={measurementPolicyState.policy?.authorizationApproved ?? false}
                      name="authorizationApproved"
                      type="checkbox"
                    />{' '}
                    Authorization approved
                  </label>
                  <label>
                    <input
                      defaultChecked={measurementPolicyState.policy?.crossBorderApproved ?? false}
                      name="crossBorderApproved"
                      type="checkbox"
                    />{' '}
                    Cross-border approved
                  </label>
                  <label htmlFor="measurement-policy-purpose">Policy purpose</label>
                  <textarea
                    defaultValue={measurementPolicyState.policy?.purpose ?? ''}
                    id="measurement-policy-purpose"
                    name="purpose"
                    required
                    rows={3}
                  />
                  <label htmlFor="measurement-policy-version">Policy version</label>
                  <input
                    defaultValue={measurementPolicyState.policy?.policyVersion ?? ''}
                    id="measurement-policy-version"
                    name="policyVersion"
                    required
                  />
                  <button className="primary-action" type="submit">
                    保存 Provider policy
                  </button>
                </form>
              ) : null}
            </section>
          ) : null}

          {requiresReviewedManualImport &&
          mayMeasure &&
          bundle.revision.status === 'APPROVED' &&
          bundle.approvalCurrent ? (
            <section className="shell-card">
              <h2>Reviewed manual import</h2>
              <p>
                提交人工采集的 exact Prompt / scope / repetition
                证据。服务端会补齐完整槽位集；未提供的槽位只会记录为 NOT_CHECKED，不会伪造成功。
              </p>
              <form action={submitManualMeasurementImport} className="stacked-form">
                <input name="tenantId" type="hidden" value={tenantId} />
                <input name="workspaceId" type="hidden" value={workspaceId} />
                <input name="promptSetId" type="hidden" value={bundle.promptSet.id} />
                <input name="promptRevisionId" type="hidden" value={bundle.revision.id} />
                <input name="scenarioId" type="hidden" value={bundle.scenario.id} />
                <input
                  name="expectedPromptHash"
                  type="hidden"
                  value={bundle.revision.contentHash}
                />
                <input
                  name="expectedScenarioHash"
                  type="hidden"
                  value={bundle.scenario.contentHash}
                />
                <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                <label htmlFor="manual-import-entries">Manual import entries JSON</label>
                <textarea
                  defaultValue={exampleManualEntries}
                  id="manual-import-entries"
                  name="entriesJson"
                  required
                  rows={20}
                />
                <button className="primary-action" type="submit">
                  提交 Manual import 待审核
                </button>
              </form>
            </section>
          ) : null}

          {manualImport !== undefined ? (
            <section className="shell-card" data-testid="manual-import-card">
              <h2>Manual import review</h2>
              <p>Import ID：{manualImport.id}</p>
              <p>
                Exact import hash：
                <span className="monospace break-anywhere" data-testid="manual-import-exact-hash">
                  {manualImport.contentHash}
                </span>
              </p>
              <p>
                状态：<strong data-testid="manual-import-status">{manualImport.status}</strong>
              </p>
              <p>
                槽位：
                <strong data-testid="manual-import-provided-count">
                  {manualImport.providedSlotCount}
                </strong>{' '}
                provided /{' '}
                <strong data-testid="manual-import-expected-count">
                  {manualImport.expectedSlotCount}
                </strong>{' '}
                expected。以下 manifest 绑定 exact Prompt hash{' '}
                <span className="monospace break-anywhere">{manualImport.promptContentHash}</span>。
              </p>
              <div className="channel-grid">
                {(manualImportDetail?.slots ?? []).map((slot) => (
                  <article
                    className="nested-card"
                    data-provided={String(slot.provided)}
                    data-testid="manual-import-slot"
                    key={`${slot.prompt.id}:${slot.scopeKey}:${slot.repetition}`}
                  >
                    <h3>
                      Prompt {slot.prompt.ordinal} · repetition {slot.repetition}
                    </h3>
                    <p>{slot.prompt.text}</p>
                    <p className="monospace break-anywhere">Prompt ID：{slot.prompt.id}</p>
                    <p>
                      Scope：{slot.scope.market} / {slot.scope.locale} / {slot.scope.region}
                    </p>
                    <p>Repetition：{slot.repetition}</p>
                    <p>
                      Provided：<strong>{slot.provided ? 'YES' : 'NO'}</strong> · Observed：
                      {slot.observedAt ?? 'Not provided'}
                    </p>
                    {slot.result === null ? (
                      <p className="warning-message">
                        Status：NOT_CHECKED candidate · 此 exact slot 未提供人工证据。
                      </p>
                    ) : (
                      <>
                        <p>
                          Status：<strong>{slot.result.status}</strong>
                        </p>
                        <p>
                          Response：
                          {slot.result.rawEvidence.responseText ?? 'No response recorded.'}
                        </p>
                        <p>
                          Citations：
                          {slot.result.rawEvidence.citations.length === 0
                            ? 'None'
                            : slot.result.rawEvidence.citations
                                .map(
                                  (citation) =>
                                    `${citation.title} — ${citation.url} — ${citation.snippet}`,
                                )
                                .join('；')}
                        </p>
                        <p>
                          Error：
                          {slot.result.rawEvidence.error === null
                            ? 'None'
                            : `${slot.result.rawEvidence.error.code} — ${slot.result.rawEvidence.error.message}`}
                        </p>
                        <p>
                          Cost：{slot.result.cost.amount} {slot.result.cost.currency}
                        </p>
                      </>
                    )}
                    <p className="monospace break-anywhere">
                      Raw evidence hash：
                      <span data-testid="manual-import-raw-hash">
                        {slot.rawEvidenceContentHash ?? 'Not provided'}
                      </span>
                    </p>
                    <p className="monospace break-anywhere">
                      Slot hash：
                      <span data-testid="manual-import-slot-hash">{slot.contentHash}</span>
                    </p>
                  </article>
                ))}
              </div>
              {mayReviewManualImport && manualImport.status === 'SUBMITTED' ? (
                <form action={reviewManualMeasurementImport} className="stacked-form">
                  <input name="tenantId" type="hidden" value={tenantId} />
                  <input name="workspaceId" type="hidden" value={workspaceId} />
                  <input name="promptSetId" type="hidden" value={bundle.promptSet.id} />
                  <input name="manualImportId" type="hidden" value={manualImport.id} />
                  <input
                    name="expectedContentHash"
                    type="hidden"
                    value={manualImport.contentHash}
                  />
                  <label htmlFor="manual-import-review-note">审核备注</label>
                  <textarea id="manual-import-review-note" name="note" required rows={3} />
                  <button className="primary-action" name="decision" type="submit" value="APPROVE">
                    审核并批准 Manual import
                  </button>
                  <button name="decision" type="submit" value="REJECT">
                    审核并拒绝 Manual import
                  </button>
                </form>
              ) : null}
            </section>
          ) : null}

          {requiresReviewedManualImport && manualImport?.status !== 'APPROVED' ? (
            <section className="shell-card">
              <p className="warning-message">
                新 baseline 需先绑定经 Reviewer / Owner 明确批准的 Manual import。
              </p>
            </section>
          ) : null}

          {mayMeasure &&
          bundle.revision.status === 'APPROVED' &&
          bundle.approvalCurrent &&
          (!requiresReviewedManualImport || manualImport?.status === 'APPROVED') ? (
            <section className="shell-card">
              <h2>Approved Measurement Scenario</h2>
              <p>
                Baseline 将绑定当前 exact Prompt 与 Scenario hash，并为每个 Prompt / scope
                执行配置的 repetitions。运行结果按单一 Surface cohort 报告。
              </p>
              <form action={startMeasurementRun}>
                <input name="tenantId" type="hidden" value={tenantId} />
                <input name="workspaceId" type="hidden" value={workspaceId} />
                <input name="promptSetId" type="hidden" value={bundle.promptSet.id} />
                <input name="promptRevisionId" type="hidden" value={bundle.revision.id} />
                <input name="scenarioId" type="hidden" value={bundle.scenario.id} />
                <input name="kind" type="hidden" value="BASELINE" />
                <input
                  data-purpose="measurement-baseline"
                  name="idempotencyKey"
                  type="hidden"
                  value={randomUUID()}
                />
                <input
                  name="expectedPromptHash"
                  type="hidden"
                  value={bundle.revision.contentHash}
                />
                <input
                  name="expectedScenarioHash"
                  type="hidden"
                  value={bundle.scenario.contentHash}
                />
                {manualImport?.status === 'APPROVED' ? (
                  <>
                    <input name="manualImportId" type="hidden" value={manualImport.id} />
                    <input
                      name="expectedManualImportHash"
                      type="hidden"
                      value={manualImport.contentHash}
                    />
                  </>
                ) : null}
                <button className="primary-action" type="submit">
                  启动 Measurement baseline
                </button>
              </form>
              <form action={startMeasurementRun}>
                <input name="tenantId" type="hidden" value={tenantId} />
                <input name="workspaceId" type="hidden" value={workspaceId} />
                <input name="promptSetId" type="hidden" value={bundle.promptSet.id} />
                <input name="promptRevisionId" type="hidden" value={bundle.revision.id} />
                <input name="scenarioId" type="hidden" value={bundle.scenario.id} />
                <input name="kind" type="hidden" value="REMEASUREMENT" />
                <input
                  data-purpose="measurement-remeasurement"
                  name="idempotencyKey"
                  type="hidden"
                  value={randomUUID()}
                />
                <input
                  name="expectedPromptHash"
                  type="hidden"
                  value={bundle.revision.contentHash}
                />
                <input
                  name="expectedScenarioHash"
                  type="hidden"
                  value={bundle.scenario.contentHash}
                />
                {manualImport?.status === 'APPROVED' ? (
                  <>
                    <input name="manualImportId" type="hidden" value={manualImport.id} />
                    <input
                      name="expectedManualImportHash"
                      type="hidden"
                      value={manualImport.contentHash}
                    />
                  </>
                ) : null}
                <button type="submit">启动 Measurement remeasurement</button>
              </form>
            </section>
          ) : null}

          {mayManage ? (
            <section className="shell-card">
              <h2>编辑问题</h2>
              <form action={revisePromptSet} className="stacked-form">
                <input name="tenantId" type="hidden" value={tenantId} />
                <input name="workspaceId" type="hidden" value={workspaceId} />
                <input name="promptSetId" type="hidden" value={bundle.promptSet.id} />
                <input name="expectedRevision" type="hidden" value={bundle.revision.revision} />
                <input
                  name="promptIds"
                  type="hidden"
                  value={JSON.stringify(bundle.revision.prompts.map((prompt) => prompt.id))}
                />
                <input
                  name="scenario"
                  type="hidden"
                  value={JSON.stringify({
                    providerKey: bundle.scenario.providerKey,
                    surfaceKey: bundle.scenario.surfaceKey,
                    model: bundle.scenario.model,
                    modelVersion: bundle.scenario.modelVersion,
                    account: bundle.scenario.account,
                    acquisitionMethod: bundle.scenario.acquisitionMethod,
                    freshSession: bundle.scenario.freshSession,
                    searchEnabled: bundle.scenario.searchEnabled,
                    parameters: bundle.scenario.parameters,
                    repetitions: bundle.scenario.repetitions,
                  })}
                />
                <label htmlFor="scope-editor">Scope editor (market | locale | region)</label>
                <textarea
                  defaultValue={bundle.revision.scopes
                    .map((scope) => `${scope.market} | ${scope.locale} | ${scope.region}`)
                    .join('\n')}
                  id="scope-editor"
                  name="scopeLines"
                  required
                  rows={3}
                />
                <label htmlFor="prompt-editor">Prompt 编辑器</label>
                <p>每行格式：问题 + Tab + persona + Tab + journey stage + Tab + query type。</p>
                <textarea
                  defaultValue={bundle.revision.prompts
                    .map(
                      (prompt) =>
                        `${prompt.text}\t${prompt.persona}\t${prompt.journeyStage}\t${prompt.queryType}`,
                    )
                    .join('\n')}
                  id="prompt-editor"
                  name="promptLines"
                  required
                  rows={24}
                />
                <button type="submit">保存为新修订</button>
              </form>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
