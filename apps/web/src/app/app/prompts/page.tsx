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
import type {
  OfferingListEnvelope,
  ProfileListEnvelope,
} from '@aeostudio/contracts/profile-offering';
import type { ApprovedClaimListEnvelope } from '@aeostudio/contracts/evidence-claims';
import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { makeT } from '../../../lib/i18n';
import { getLocale } from '../../../lib/i18n/get-locale';

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
    claimRevisionIds: formData
      .getAll('claimRevisionIds')
      .flatMap((value) => (typeof value === 'string' ? value.split(/[,\r\n]+/) : []))
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
  const t = makeT(await getLocale());
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
  let profileOptions: ProfileListEnvelope['data']['profiles'] = [];
  let offeringOptions: OfferingListEnvelope['data']['offerings'] = [];
  let claimOptions: ApprovedClaimListEnvelope['data']['claims'] = [];
  if (bundle === undefined && mayManage) {
    const [profilesResponse, offeringsResponse, claimsResponse] = await Promise.all([
      fetch(`${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/profiles`, {
        cache: 'no-store',
        headers: { cookie },
      }),
      fetch(`${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/offerings`, {
        cache: 'no-store',
        headers: { cookie },
      }),
      fetch(`${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/claims/approved`, {
        cache: 'no-store',
        headers: { cookie },
      }),
    ]);
    if (profilesResponse.ok) {
      profileOptions = ((await profilesResponse.json()) as ProfileListEnvelope).data.profiles;
    }
    if (offeringsResponse.ok) {
      offeringOptions = ((await offeringsResponse.json()) as OfferingListEnvelope).data.offerings;
    }
    if (claimsResponse.ok) {
      claimOptions = ((await claimsResponse.json()) as ApprovedClaimListEnvelope).data.claims;
    }
  }
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
      <p className="eyebrow">{t('prompts.eyebrow')}</p>
      <h1>{t('prompts.title')}</h1>
      <p>{t('prompts.lede')}</p>

      {query.notice === 'manual-import-submitted' ? (
        <p className="success-message">{t('prompts.notice.manualImportSubmitted')}</p>
      ) : null}
      {query.notice === 'manual-import-reviewed' ? (
        <p className="success-message">{t('prompts.notice.manualImportReviewed')}</p>
      ) : null}
      {query.notice === 'measurement-policy' ? (
        <p className="success-message">{t('prompts.notice.policySaved')}</p>
      ) : null}
      {typeof query.error === 'string' && query.error.startsWith('manual-import') ? (
        <p className="warning-message">{t('prompts.error.manualImport')}</p>
      ) : null}
      {query.error === 'measurement-policy' ? (
        <p className="warning-message">{t('prompts.error.policy')}</p>
      ) : null}

      {promptRevisionId !== undefined && bundle === undefined ? (
        <section className="shell-card">
          <h2>{t('prompts.revisionUnavailableHeading')}</h2>
          <p>{t('prompts.revisionId', { id: promptRevisionId })}</p>
          <p className="warning-message">{t('prompts.revisionUnavailable')}</p>
        </section>
      ) : null}

      {bundle === undefined && mayManage ? (
        <section className="shell-card">
          <h2>{t('prompts.proposeHeading')}</h2>
          <form action={proposePromptSet} className="stacked-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <label htmlFor="prompt-title">{t('prompts.field.title')}</label>
            <input id="prompt-title" name="title" required />
            <label htmlFor="prompt-subject">{t('prompts.field.subject')}</label>
            <input id="prompt-subject" name="subject" required />
            <label htmlFor="prompt-profile-id">{t('prompts.field.profileRevisionId')}</label>
            <input
              defaultValue={profileId}
              id="prompt-profile-id"
              list="prompt-profile-options"
              name="profileId"
              required
            />
            <datalist id="prompt-profile-options">
              {profileOptions.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.displayName} (rev {profile.currentRevision})
                </option>
              ))}
            </datalist>
            <label htmlFor="prompt-profile-revision">{t('prompts.field.profileRevision')}</label>
            <input
              defaultValue={profileRevision}
              id="prompt-profile-revision"
              min="1"
              name="profileRevision"
              required
              type="number"
            />
            <label htmlFor="prompt-offering-id">{t('prompts.field.offeringRevisionId')}</label>
            <input
              defaultValue={offeringId}
              id="prompt-offering-id"
              list="prompt-offering-options"
              name="offeringId"
              required
            />
            <datalist id="prompt-offering-options">
              {offeringOptions.map((offering) => (
                <option key={offering.id} value={offering.id}>
                  {offering.name} [{offering.kind}] (rev {offering.currentRevision})
                </option>
              ))}
            </datalist>
            <label htmlFor="prompt-offering-revision">{t('prompts.field.offeringRevision')}</label>
            <input
              defaultValue={offeringRevision}
              id="prompt-offering-revision"
              min="1"
              name="offeringRevision"
              required
              type="number"
            />
            <label htmlFor="prompt-claims">{t('prompts.field.claimRevisionIds')}</label>
            <input
              defaultValue=""
              id="prompt-claims"
              list="prompt-claim-options"
              name="claimRevisionIds"
            />
            <datalist id="prompt-claim-options">
              {claimOptions.map((c) => (
                <option key={c.revisionId} value={c.revisionId}>
                  {c.statement} (R{c.revision})
                </option>
              ))}
            </datalist>
            <p className="field-help">{t('prompts.claimsHelp')}</p>
            <label htmlFor="prompt-market">{t('prompts.field.market')}</label>
            <input defaultValue="SG" id="prompt-market" name="market" required />
            <label htmlFor="prompt-locale">{t('prompts.field.locale')}</label>
            <input defaultValue="en-SG" id="prompt-locale" name="locale" required />
            <label htmlFor="prompt-region">{t('prompts.field.region')}</label>
            <input defaultValue="Singapore" id="prompt-region" name="region" required />
            <label htmlFor="additional-scopes">{t('prompts.field.additionalScopes')}</label>
            <textarea
              aria-describedby="additional-scopes-help"
              id="additional-scopes"
              name="additionalScopes"
              placeholder={'US | en-US | United States\nDE | de-DE | Germany'}
              rows={2}
            />
            <p id="additional-scopes-help">{t('prompts.additionalScopesHelp')}</p>
            <label htmlFor="provider-surface">{t('prompts.field.providerSurface')}</label>
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
            <label htmlFor="scenario-model">{t('prompts.field.model')}</label>
            <input id="scenario-model" name="model" placeholder="e.g. gpt-4o" required />
            <label htmlFor="scenario-model-version">{t('prompts.field.modelVersion')}</label>
            <input
              defaultValue="2026-07"
              id="scenario-model-version"
              name="modelVersion"
              required
            />
            <label htmlFor="scenario-account">{t('prompts.field.account')}</label>
            <input
              id="scenario-account"
              name="account"
              placeholder="e.g. workspace account"
              required
            />
            <label htmlFor="scenario-repetitions">{t('prompts.field.repetitions')}</label>
            <input
              defaultValue="3"
              id="scenario-repetitions"
              min="1"
              name="repetitions"
              required
              type="number"
            />
            <label>
              <input defaultChecked name="freshSession" type="checkbox" />{' '}
              {t('prompts.field.freshSession')}
            </label>
            <label>
              <input defaultChecked name="searchEnabled" type="checkbox" />{' '}
              {t('prompts.field.searchEnabled')}
            </label>
            <button className="primary-action" type="submit">
              {t('prompts.proposeAction')}
            </button>
          </form>
        </section>
      ) : null}

      {bundle === undefined ? null : (
        <>
          <section className="shell-card">
            <h2>{t('prompts.revisionHeading', { revision: bundle.revision.revision })}</h2>
            <p>{t('prompts.revisionId', { id: bundle.revision.id })}</p>
            <p>{t('prompts.revisionTitle', { value: bundle.revision.title })}</p>
            <p>{t('prompts.revisionSubject', { value: bundle.revision.subject })}</p>
            <p>
              {t('prompts.statusLabel')}
              <strong data-testid="prompt-status">{bundle.revision.status}</strong>
            </p>
            <p>
              {t('prompts.promptCountLabel')}
              <strong data-testid="prompt-count">{bundle.revision.prompts.length}</strong>
            </p>
            <p>{t('prompts.promptHash', { hash: bundle.revision.contentHash })}</p>
            <p>{t('prompts.scenarioHash', { hash: bundle.scenario.contentHash })}</p>
            <p>{t('prompts.providerValue', { value: bundle.scenario.providerKey })}</p>
            <p>{t('prompts.consumerSurfaceValue', { value: bundle.scenario.surfaceKey })}</p>
            <p>
              {t('prompts.modelVersionValue', {
                model: bundle.scenario.model,
                version: bundle.scenario.modelVersion,
              })}
            </p>
            <p>
              {t('prompts.scopeValue', {
                value: bundle.revision.scopes
                  .map((scope) => `${scope.market}/${scope.locale}/${scope.region}`)
                  .join(', '),
              })}
            </p>
            <p>
              {t('prompts.scenarioFlags', {
                fresh: String(bundle.scenario.freshSession),
                search: String(bundle.scenario.searchEnabled),
                repetitions: bundle.scenario.repetitions,
              })}
            </p>
            {bundle.previousApprovalStale ? (
              <p className="warning-message">{t('prompts.approvalStale')}</p>
            ) : null}
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
                  {t('prompts.approveAction')}
                </button>
              </form>
            </section>
          ) : null}

          {registryEntry !== undefined && measurementPolicyState !== undefined ? (
            <section className="shell-card" data-testid="measurement-policy-card">
              <h2>{t('prompts.policy.heading')}</h2>
              <p>
                {t('prompts.policy.providerSurface', {
                  providerName: registryEntry.providerName,
                  surfaceName: registryEntry.surfaceName,
                  providerKey: registryEntry.providerKey,
                  surfaceKey: registryEntry.surfaceKey,
                })}
              </p>
              <p>
                {t('prompts.policy.executionLabel')}
                <strong data-testid="measurement-policy-status">
                  {measurementPolicyState.eligible
                    ? t('prompts.policy.eligible')
                    : t('prompts.policy.notEligible')}
                </strong>
              </p>
              <p>
                {t('prompts.policy.required', {
                  adapter: measurementPolicyState.requiredAdapterVersion,
                  terms:
                    measurementPolicyState.requiredTermsVersion ??
                    t('prompts.policy.termsUnavailable'),
                })}
              </p>
              {measurementPolicyState.eligible ? (
                <p className="success-message">{t('prompts.policy.eligibleMessage')}</p>
              ) : (
                <p className="warning-message">
                  {t('prompts.policy.notEligibleMessage', {
                    reasons: measurementPolicyState.reasons.join(', '),
                  })}
                </p>
              )}
              {measurementPolicyState.policy === null ? null : (
                <p>
                  {t('prompts.policy.current', {
                    version: measurementPolicyState.policy.policyVersion,
                    approvedAt: measurementPolicyState.policy.approvedAt,
                  })}
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
                  <label htmlFor="measurement-policy-adapter-version">
                    {t('prompts.policy.field.adapterVersion')}
                  </label>
                  <input
                    id="measurement-policy-adapter-version"
                    name="adapterVersion"
                    readOnly
                    value={measurementPolicyState.requiredAdapterVersion}
                  />
                  <label htmlFor="measurement-policy-terms-version">
                    {t('prompts.policy.field.termsVersion')}
                  </label>
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
                    {t('prompts.policy.field.termsApproved')}
                  </label>
                  <label>
                    <input
                      defaultChecked={measurementPolicyState.policy?.authorizationApproved ?? false}
                      name="authorizationApproved"
                      type="checkbox"
                    />{' '}
                    {t('prompts.policy.field.authorizationApproved')}
                  </label>
                  <label>
                    <input
                      defaultChecked={measurementPolicyState.policy?.crossBorderApproved ?? false}
                      name="crossBorderApproved"
                      type="checkbox"
                    />{' '}
                    {t('prompts.policy.field.crossBorderApproved')}
                  </label>
                  <label htmlFor="measurement-policy-purpose">
                    {t('prompts.policy.field.purpose')}
                  </label>
                  <textarea
                    defaultValue={measurementPolicyState.policy?.purpose ?? ''}
                    id="measurement-policy-purpose"
                    name="purpose"
                    required
                    rows={3}
                  />
                  <label htmlFor="measurement-policy-version">
                    {t('prompts.policy.field.policyVersion')}
                  </label>
                  <input
                    defaultValue={measurementPolicyState.policy?.policyVersion ?? ''}
                    id="measurement-policy-version"
                    name="policyVersion"
                    required
                  />
                  <button className="primary-action" type="submit">
                    {t('prompts.policy.saveAction')}
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
              <h2>{t('prompts.manualImport.heading')}</h2>
              <p>{t('prompts.manualImport.help')}</p>
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
                <label htmlFor="manual-import-entries">
                  {t('prompts.manualImport.field.entries')}
                </label>
                <textarea
                  defaultValue={exampleManualEntries}
                  id="manual-import-entries"
                  name="entriesJson"
                  required
                  rows={20}
                />
                <button className="primary-action" type="submit">
                  {t('prompts.manualImport.submitAction')}
                </button>
              </form>
            </section>
          ) : null}

          {manualImport !== undefined ? (
            <section className="shell-card" data-testid="manual-import-card">
              <h2>{t('prompts.manualImport.reviewHeading')}</h2>
              <p>{t('prompts.manualImport.id', { id: manualImport.id })}</p>
              <p>
                {t('prompts.manualImport.hashLabel')}
                <span className="monospace break-anywhere" data-testid="manual-import-exact-hash">
                  {manualImport.contentHash}
                </span>
              </p>
              <p>
                {t('prompts.manualImport.statusLabel')}
                <strong data-testid="manual-import-status">{manualImport.status}</strong>
              </p>
              <p>
                {t('prompts.manualImport.slotsLabel')}
                <strong data-testid="manual-import-provided-count">
                  {manualImport.providedSlotCount}
                </strong>{' '}
                {t('prompts.manualImport.provided')} /{' '}
                <strong data-testid="manual-import-expected-count">
                  {manualImport.expectedSlotCount}
                </strong>{' '}
                {t('prompts.manualImport.expectedManifest')}{' '}
                <span className="monospace break-anywhere">{manualImport.promptContentHash}</span>
                {t('prompts.manualImport.manifestSuffix')}
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
                      {t('prompts.manualImport.slotHeading', {
                        ordinal: slot.prompt.ordinal,
                        repetition: slot.repetition,
                      })}
                    </h3>
                    <p>{slot.prompt.text}</p>
                    <p className="monospace break-anywhere">
                      {t('prompts.manualImport.promptId', { id: slot.prompt.id })}
                    </p>
                    <p>
                      {t('prompts.manualImport.scope', {
                        market: slot.scope.market,
                        locale: slot.scope.locale,
                        region: slot.scope.region,
                      })}
                    </p>
                    <p>{t('prompts.manualImport.repetition', { repetition: slot.repetition })}</p>
                    <p>
                      {t('prompts.manualImport.providedLabel')}
                      <strong>
                        {slot.provided
                          ? t('prompts.manualImport.yes')
                          : t('prompts.manualImport.no')}
                      </strong>
                      {t('prompts.manualImport.observedLabel')}
                      {slot.observedAt ?? t('prompts.manualImport.notProvided')}
                    </p>
                    {slot.result === null ? (
                      <p className="warning-message">{t('prompts.manualImport.unchecked')}</p>
                    ) : (
                      <>
                        <p>
                          {t('prompts.manualImport.resultStatusLabel')}
                          <strong>{slot.result.status}</strong>
                        </p>
                        <p>
                          {t('prompts.manualImport.responseLabel')}
                          {slot.result.rawEvidence.responseText ??
                            t('prompts.manualImport.noResponse')}
                        </p>
                        <p>
                          {t('prompts.manualImport.citationsLabel')}
                          {slot.result.rawEvidence.citations.length === 0
                            ? t('prompts.manualImport.none')
                            : slot.result.rawEvidence.citations
                                .map(
                                  (citation) =>
                                    `${citation.title} — ${citation.url} — ${citation.snippet}`,
                                )
                                .join('；')}
                        </p>
                        <p>
                          {t('prompts.manualImport.errorLabel')}
                          {slot.result.rawEvidence.error === null
                            ? t('prompts.manualImport.none')
                            : `${slot.result.rawEvidence.error.code} — ${slot.result.rawEvidence.error.message}`}
                        </p>
                        <p>
                          {t('prompts.manualImport.cost', {
                            amount: slot.result.cost.amount,
                            currency: slot.result.cost.currency,
                          })}
                        </p>
                      </>
                    )}
                    <p className="monospace break-anywhere">
                      {t('prompts.manualImport.rawHashLabel')}
                      <span data-testid="manual-import-raw-hash">
                        {slot.rawEvidenceContentHash ?? t('prompts.manualImport.notProvided')}
                      </span>
                    </p>
                    <p className="monospace break-anywhere">
                      {t('prompts.manualImport.slotHashLabel')}
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
                  <label htmlFor="manual-import-review-note">
                    {t('prompts.manualImport.field.reviewNote')}
                  </label>
                  <textarea id="manual-import-review-note" name="note" required rows={3} />
                  <button className="primary-action" name="decision" type="submit" value="APPROVE">
                    {t('prompts.manualImport.approveAction')}
                  </button>
                  <button name="decision" type="submit" value="REJECT">
                    {t('prompts.manualImport.rejectAction')}
                  </button>
                </form>
              ) : null}
            </section>
          ) : null}

          {requiresReviewedManualImport && manualImport?.status !== 'APPROVED' ? (
            <section className="shell-card">
              <p className="warning-message">{t('prompts.manualImport.requiredWarning')}</p>
            </section>
          ) : null}

          {mayMeasure &&
          bundle.revision.status === 'APPROVED' &&
          bundle.approvalCurrent &&
          (!requiresReviewedManualImport || manualImport?.status === 'APPROVED') ? (
            <section className="shell-card">
              <h2>{t('prompts.measurement.heading')}</h2>
              <p>{t('prompts.measurement.help')}</p>
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
                  {t('prompts.measurement.baselineAction')}
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
                <button type="submit">{t('prompts.measurement.remeasurementAction')}</button>
              </form>
            </section>
          ) : null}

          {mayManage ? (
            <section className="shell-card">
              <h2>{t('prompts.edit.heading')}</h2>
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
                <label htmlFor="scope-editor">{t('prompts.edit.field.scopeEditor')}</label>
                <textarea
                  defaultValue={bundle.revision.scopes
                    .map((scope) => `${scope.market} | ${scope.locale} | ${scope.region}`)
                    .join('\n')}
                  id="scope-editor"
                  name="scopeLines"
                  required
                  rows={3}
                />
                <label htmlFor="prompt-editor">{t('prompts.edit.field.promptEditor')}</label>
                <p>{t('prompts.edit.promptEditorHelp')}</p>
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
                <button type="submit">{t('prompts.edit.saveAction')}</button>
              </form>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
