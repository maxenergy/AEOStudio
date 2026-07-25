import { createHash } from 'node:crypto';
import {
  decodeShopifyDraftTarget,
  encodeShopifyDraftTarget,
  encodeShopifyShopAuthorizationTarget,
  shopifyRequiredScopesFor,
  type ShopifyDraftTargetV1,
} from '@aeostudio/contracts/channels/shopify-draft';
import {
  decodeSignedWebhookTarget,
  encodeSignedWebhookTarget,
  signedWebhookRequiredScopes,
  type SignedWebhookTargetV1,
} from '@aeostudio/contracts/channels/signed-webhook-target';
import {
  decodeWordPressDraftTarget,
  encodeWordPressDraftTarget,
  encodeWordPressSiteAuthorizationTarget,
  type WordPressDraftTargetV1,
  wordpressRequiredScopesFor,
} from '@aeostudio/contracts/channels/wordpress-draft';
import type {
  ArtifactBundleEnvelope,
  ChannelAuthorizationEnvelope,
  ChannelPackageEnvelope,
  ChannelRegistryEnvelope,
  PublicationCommandEnvelope,
  PublicationDetailEnvelope,
  PublicationEligibilityEnvelope,
  WorkspaceListEnvelope,
} from '@aeostudio/contracts';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { makeT, type TFunction } from '../../../lib/i18n';
import { getLocale } from '../../../lib/i18n/get-locale';
import { JobPoller } from '../jobs/job-poller';
import { ShopifyTargetFields } from './shopify-target-fields';

interface GitPullRequestTargetInput {
  schemaVersion: 'git-pr-target.v1';
  provider: 'GITHUB';
  installationId: string;
  repository: string;
  baseBranch: string;
  pathPrefix: string;
}

const GIT_TARGET_KEYS = [
  'schemaVersion',
  'provider',
  'installationId',
  'repository',
  'baseBranch',
  'pathPrefix',
] as const;

function hasGitPathControlOrConfusableSlash(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return (
      point === undefined ||
      point <= 0x1f ||
      point === 0x7f ||
      [0x2044, 0x2215, 0x29f8, 0xff0f].includes(point)
    );
  });
}

function validGitPath(value: string, maximumLength: number): boolean {
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('//') ||
    value.includes('\\') ||
    value.includes('%') ||
    /^[A-Za-z]:/.test(value) ||
    hasGitPathControlOrConfusableSlash(value)
  ) {
    return false;
  }
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function validGitBranch(value: string): boolean {
  if (
    !validGitPath(value, 240) ||
    value.startsWith('-') ||
    value === '@' ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('@{') ||
    [...value].some((character) => ' ~^:?*['.includes(character))
  ) {
    return false;
  }
  return value
    .split('/')
    .every((segment) => !segment.startsWith('.') && !segment.endsWith('.lock'));
}

function validateGitTarget(target: GitPullRequestTargetInput): void {
  const pathSegments = target.pathPrefix.toLowerCase().split('/');
  if (
    target.schemaVersion !== 'git-pr-target.v1' ||
    target.provider !== 'GITHUB' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(target.installationId) ||
    !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(target.repository) ||
    !validGitBranch(target.baseBranch) ||
    !validGitPath(target.pathPrefix, 1_024) ||
    pathSegments.includes('.git') ||
    (pathSegments[0] === '.github' && pathSegments[1] === 'workflows')
  ) {
    throw new Error('GIT_TARGET_INVALID');
  }
}

function encodeGitPullRequestTarget(target: GitPullRequestTargetInput): string {
  validateGitTarget(target);
  return `git-pr:v1:${Buffer.from(JSON.stringify(target), 'utf8').toString('base64url')}`;
}

function decodeGitPullRequestTarget(value: string): GitPullRequestTargetInput {
  try {
    if (!value.startsWith('git-pr:v1:') || value.length > 4_096) {
      throw new Error('GIT_TARGET_INVALID');
    }
    const encoded = value.slice('git-pr:v1:'.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('GIT_TARGET_INVALID');
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) throw new Error('GIT_TARGET_INVALID');
    const candidate = JSON.parse(decoded.toString('utf8')) as unknown;
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('GIT_TARGET_INVALID');
    }
    const keys = Object.keys(candidate);
    if (
      keys.length !== GIT_TARGET_KEYS.length ||
      GIT_TARGET_KEYS.some((key) => !keys.includes(key))
    ) {
      throw new Error('GIT_TARGET_INVALID');
    }
    const parsed = candidate as GitPullRequestTargetInput;
    validateGitTarget(parsed);
    if (encodeGitPullRequestTarget(parsed) !== value) throw new Error('GIT_TARGET_INVALID');
    return parsed;
  } catch {
    throw new Error('GIT_TARGET_INVALID');
  }
}

function apiOrigin(): string {
  return process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3200';
}

function publicApiOrigin(): string {
  return process.env.API_PUBLIC_ORIGIN ?? 'http://127.0.0.1:3200';
}

function webOrigin(): string {
  return process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3100';
}

function requiredText(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`INVALID_${name}`);
  return value.trim();
}

function optionalText(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseWordPressCategoryIds(value: string | undefined): number[] {
  if (value === undefined) return [];
  const parts = value.split(',').map((part) => part.trim());
  if (
    parts.some((part) => !/^[1-9][0-9]*$/u.test(part)) ||
    parts.some((part) => Number(part) > 2_147_483_647)
  ) {
    throw new Error('WORDPRESS_CATEGORY_IDS_INVALID');
  }
  const ids = parts.map(Number);
  if (new Set(ids).size !== ids.length || ids.length > 100) {
    throw new Error('WORDPRESS_CATEGORY_IDS_INVALID');
  }
  return ids.sort((left, right) => left - right);
}

function wordPressDestinationFromForm(formData: FormData): WordPressDraftTargetV1['destination'] {
  const kind = requiredText(formData, 'wordpressContentType');
  const operation = requiredText(formData, 'wordpressOperation');
  const slug = requiredText(formData, 'wordpressSlug');
  const remoteIdText = optionalText(formData, 'wordpressRemoteId');
  const remoteId = remoteIdText === undefined ? undefined : Number(remoteIdText);
  if (
    !['PAGE', 'POST', 'PRODUCT'].includes(kind) ||
    !['CREATE', 'UPDATE'].includes(operation) ||
    (operation === 'UPDATE' &&
      (remoteId === undefined || !Number.isSafeInteger(remoteId) || remoteId <= 0)) ||
    (operation === 'CREATE' && remoteId !== undefined)
  ) {
    throw new Error('WORDPRESS_TARGET_INVALID');
  }
  if (kind === 'PAGE') {
    return operation === 'CREATE'
      ? { kind: 'PAGE', operation: 'CREATE', slug }
      : { kind: 'PAGE', operation: 'UPDATE', slug, remoteId: remoteId as number };
  }
  const categoryIds = parseWordPressCategoryIds(optionalText(formData, 'wordpressCategoryIds'));
  if (kind === 'POST') {
    return operation === 'CREATE'
      ? { kind: 'POST', operation: 'CREATE', slug, categoryIds }
      : {
          kind: 'POST',
          operation: 'UPDATE',
          slug,
          categoryIds,
          remoteId: remoteId as number,
        };
  }
  return operation === 'CREATE'
    ? { kind: 'PRODUCT', operation: 'CREATE', slug, categoryIds }
    : {
        kind: 'PRODUCT',
        operation: 'UPDATE',
        slug,
        categoryIds,
        remoteId: remoteId as number,
      };
}

function shopifyDestinationFromForm(formData: FormData): ShopifyDraftTargetV1['destination'] {
  const kind = requiredText(formData, 'shopifyContentType');
  const operation = requiredText(formData, 'shopifyOperation');
  const handle = requiredText(formData, 'shopifyHandle');
  const blogId = optionalText(formData, 'shopifyBlogId');
  const remoteId = optionalText(formData, 'shopifyRemoteId');
  if (
    !['PAGE', 'BLOG_ARTICLE', 'PRODUCT'].includes(kind) ||
    !['CREATE', 'UPDATE'].includes(operation) ||
    (kind === 'BLOG_ARTICLE' ? blogId === undefined : blogId !== undefined) ||
    (operation === 'UPDATE' ? remoteId === undefined : remoteId !== undefined)
  ) {
    throw new Error('SHOPIFY_TARGET_INVALID');
  }
  if (kind === 'PAGE') {
    return operation === 'CREATE'
      ? { kind: 'PAGE', operation: 'CREATE', handle }
      : { kind: 'PAGE', operation: 'UPDATE', handle, remoteId: remoteId as string };
  }
  if (kind === 'BLOG_ARTICLE') {
    return operation === 'CREATE'
      ? { kind: 'BLOG_ARTICLE', operation: 'CREATE', handle, blogId: blogId as string }
      : {
          kind: 'BLOG_ARTICLE',
          operation: 'UPDATE',
          handle,
          blogId: blogId as string,
          remoteId: remoteId as string,
        };
  }
  return operation === 'CREATE'
    ? { kind: 'PRODUCT', operation: 'CREATE', handle }
    : { kind: 'PRODUCT', operation: 'UPDATE', handle, remoteId: remoteId as string };
}

function publicationRecoveryGuidance(errorCode: string | null, t: TFunction): string | null {
  switch (errorCode) {
    case 'ADAPTER_AUTHORIZATION_SCOPE_INSUFFICIENT':
      return t('channels.recoveryScopeInsufficient');
    case 'ADAPTER_AUTHORIZATION_BRANCH_POLICY_CONFLICT':
      return t('channels.recoveryBranchPolicyConflict');
    case 'ADAPTER_AUTHORIZATION_TARGET_NOT_ALLOWED':
      return t('channels.recoveryTargetNotAllowed');
    default:
      return null;
  }
}

interface PublicationIntentInput {
  tenantId: string;
  workspaceId: string;
  packageId: string;
  packageChecksum: string;
  adapterVersionId: string;
  target: string;
}

function publicationIntentKey(input: PublicationIntentInput): string {
  return `reviewed-publication-v1:${publicationIntentDigest(input)}`;
}

function publicationRetryIntentKey(
  input: PublicationIntentInput & { priorPublicationId: string },
): string {
  return `reviewed-publication-retry-v1:${publicationIntentDigest(input)}`;
}

function publicationIntentDigest(input: PublicationIntentInput & { priorPublicationId?: string }) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.tenantId,
        input.workspaceId,
        input.packageId,
        input.packageChecksum,
        input.adapterVersionId,
        input.target,
        input.priorPublicationId ?? null,
      ]),
    )
    .digest('hex');
}

function isSafePublicationRetryStatus(status: string): boolean {
  return ['BUDGET_BLOCKED', 'FAILED_TERMINAL', 'ROLLED_BACK'].includes(status);
}

interface ChannelLocation {
  tenantId: string;
  workspaceId: string;
  artifactId?: string;
  artifactRevisionId?: string;
  channelKey?: string;
  packageId?: string;
  adapterVersionId?: string;
  target?: string;
  publicationId?: string;
  jobId?: string;
  notice?: string;
  error?: string;
  code?: string;
}

function channelsLocation(input: ChannelLocation): string {
  const query = new URLSearchParams({ tenant: input.tenantId, workspace: input.workspaceId });
  const optional: Array<[string, string | undefined]> = [
    ['artifact', input.artifactId],
    ['artifactRevision', input.artifactRevisionId],
    ['channel', input.channelKey],
    ['package', input.packageId],
    ['adapter', input.adapterVersionId],
    ['target', input.target],
    ['publication', input.publicationId],
    ['job', input.jobId],
    ['notice', input.notice],
    ['error', input.error],
    ['code', input.code],
  ];
  for (const [key, value] of optional) if (value !== undefined) query.set(key, value);
  return `/app/channels?${query.toString()}`;
}

function mutationHeaders(cookie: string) {
  return { 'content-type': 'application/json', cookie, origin: webOrigin() };
}

async function responseCode(response: Response): Promise<string> {
  try {
    const problem = (await response.json()) as { code?: unknown };
    return typeof problem.code === 'string' ? problem.code : `HTTP_${response.status}`;
  } catch {
    return `HTTP_${response.status}`;
  }
}

async function buildChannelPackage(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const artifactId = requiredText(formData, 'artifactId');
  const artifactRevisionId = requiredText(formData, 'artifactRevisionId');
  const channelKey = requiredText(formData, 'channelKey');
  const cookie = (await cookies()).toString();
  const scope = `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}`;

  // Re-read both sources on the trusted server boundary. Hidden fields choose records; they do
  // not supply the approval hash, revision number, Adapter, or Registry policy used below.
  const [artifactResponse, registryResponse] = await Promise.all([
    fetch(`${scope}/artifacts/${artifactId}`, { cache: 'no-store', headers: { cookie } }),
    fetch(`${scope}/channels`, { cache: 'no-store', headers: { cookie } }),
  ]);
  if (!artifactResponse.ok || !registryResponse.ok) {
    redirect(
      channelsLocation({ tenantId, workspaceId, artifactId, error: 'build', code: 'NOT_FOUND' }),
    );
  }
  const bundle = (await artifactResponse.json()) as ArtifactBundleEnvelope;
  const registry = (await registryResponse.json()) as ChannelRegistryEnvelope;
  const revision = bundle.data.revisions.find((entry) => entry.id === artifactRevisionId);
  const isSelectable =
    revision !== undefined &&
    bundle.data.selectableApprovedRevisions.some(
      (entry) => entry.revision === revision.revision && entry.contentHash === revision.contentHash,
    );
  const channel = registry.data.entries.find((entry) => entry.channelKey === channelKey);
  if (revision === undefined || !isSelectable || channel === undefined) {
    redirect(
      channelsLocation({
        tenantId,
        workspaceId,
        artifactId,
        artifactRevisionId,
        channelKey,
        error: 'build',
        code: revision === undefined || !isSelectable ? 'APPROVAL_STALE' : 'CHANNEL_NOT_FOUND',
      }),
    );
  }

  const response = await fetch(`${scope}/channel-packages`, {
    method: 'POST',
    cache: 'no-store',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({
      artifactId,
      artifactRevisionId: revision.id,
      revision: revision.revision,
      expectedContentHash: revision.contentHash,
      channelKey: channel.channelKey,
    }),
  });
  if (!response.ok) {
    redirect(
      channelsLocation({
        tenantId,
        workspaceId,
        artifactId,
        artifactRevisionId,
        channelKey,
        error: 'build',
        code: await responseCode(response),
      }),
    );
  }
  const result = (await response.json()) as ChannelPackageEnvelope;
  const adapterVersionId = channel.adapterVersions[0]?.id;
  redirect(
    channelsLocation({
      tenantId,
      workspaceId,
      artifactId,
      artifactRevisionId,
      channelKey,
      packageId: result.data.package.id,
      ...(adapterVersionId === undefined ? {} : { adapterVersionId }),
      target: `reviewed://${channel.channelKey}/default`,
      notice: 'package',
    }),
  );
}

async function saveChannelAuthorization(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const artifactId = requiredText(formData, 'artifactId');
  const artifactRevisionId = requiredText(formData, 'artifactRevisionId');
  const channelKey = requiredText(formData, 'channelKey');
  const packageId = requiredText(formData, 'packageId');
  const adapterVersionId = requiredText(formData, 'adapterVersionId');
  const adapterKey = requiredText(formData, 'adapterKey');
  let authorizationTarget: string;
  let publicationTarget: string;
  if (adapterKey === 'git-pull-request') {
    try {
      publicationTarget = encodeGitPullRequestTarget({
        schemaVersion: 'git-pr-target.v1',
        provider: 'GITHUB',
        installationId: requiredText(formData, 'gitInstallationId'),
        repository: requiredText(formData, 'gitRepository'),
        baseBranch: requiredText(formData, 'gitBaseBranch'),
        pathPrefix: requiredText(formData, 'gitPathPrefix'),
      });
    } catch {
      redirect(
        channelsLocation({
          tenantId,
          workspaceId,
          artifactId,
          artifactRevisionId,
          channelKey,
          packageId,
          adapterVersionId,
          error: 'authorization',
          code: 'GIT_TARGET_INVALID',
        }),
      );
    }
    authorizationTarget = publicationTarget;
  } else if (adapterKey === 'wordpress-woocommerce-draft') {
    try {
      const siteUrl = requiredText(formData, 'wordpressSiteUrl');
      const authModeInput = requiredText(formData, 'wordpressAuthMode');
      if (!['OAUTH', 'APPLICATION_PASSWORD', 'APPROVED_TOKEN'].includes(authModeInput)) {
        throw new Error('WORDPRESS_TARGET_INVALID');
      }
      const authMode = authModeInput as WordPressDraftTargetV1['authMode'];
      publicationTarget = encodeWordPressDraftTarget({
        schemaVersion: 'wordpress-draft-target.v1',
        siteUrl,
        authMode,
        destination: wordPressDestinationFromForm(formData),
      });
      authorizationTarget = encodeWordPressSiteAuthorizationTarget({
        schemaVersion: 'wordpress-site-auth.v1',
        siteUrl,
        authMode,
      });
    } catch {
      redirect(
        channelsLocation({
          tenantId,
          workspaceId,
          artifactId,
          artifactRevisionId,
          channelKey,
          packageId,
          adapterVersionId,
          error: 'authorization',
          code: 'WORDPRESS_TARGET_INVALID',
        }),
      );
    }
  } else if (adapterKey === 'shopify-draft') {
    try {
      const shopDomain = requiredText(formData, 'shopifyShopDomain');
      publicationTarget = encodeShopifyDraftTarget({
        schemaVersion: 'shopify-draft-target.v1',
        shopDomain,
        apiVersion: requiredText(formData, 'shopifyApiVersion'),
        destination: shopifyDestinationFromForm(formData),
      });
      authorizationTarget = encodeShopifyShopAuthorizationTarget({
        schemaVersion: 'shopify-shop-auth.v1',
        shopDomain,
      });
    } catch {
      redirect(
        channelsLocation({
          tenantId,
          workspaceId,
          artifactId,
          artifactRevisionId,
          channelKey,
          packageId,
          adapterVersionId,
          error: 'authorization',
          code: 'SHOPIFY_TARGET_INVALID',
        }),
      );
    }
  } else if (adapterKey === 'signed-webhook') {
    try {
      const algorithmInput = requiredText(formData, 'webhookSigningAlgorithm');
      if (algorithmInput !== 'HMAC_SHA256' && algorithmInput !== 'ED25519') {
        throw new Error('SIGNED_WEBHOOK_TARGET_INVALID');
      }
      publicationTarget = encodeSignedWebhookTarget({
        schemaVersion: 'signed-webhook-target.v1',
        endpointUrl: requiredText(formData, 'webhookDeliveryEndpoint'),
        receiptUrl: requiredText(formData, 'webhookReceiptEndpoint'),
        endpointVerificationId: requiredText(formData, 'webhookEndpointVerificationId'),
        algorithm: algorithmInput,
        keyId: requiredText(formData, 'webhookSigningKeyId'),
      });
      authorizationTarget = publicationTarget;
    } catch {
      redirect(
        channelsLocation({
          tenantId,
          workspaceId,
          artifactId,
          artifactRevisionId,
          channelKey,
          packageId,
          adapterVersionId,
          error: 'authorization',
          code: 'SIGNED_WEBHOOK_TARGET_INVALID',
        }),
      );
    }
  } else {
    publicationTarget = requiredText(formData, 'target');
    authorizationTarget = publicationTarget;
  }
  const secretArn = requiredText(formData, 'secretArn');
  const rawExpiresAt = formData.get('expiresAt');
  const expiresAtInput = typeof rawExpiresAt === 'string' ? rawExpiresAt.trim() : '';
  const expiresAt = expiresAtInput.length === 0 ? null : new Date(expiresAtInput);
  const base = {
    tenantId,
    workspaceId,
    artifactId,
    artifactRevisionId,
    channelKey,
    packageId,
    adapterVersionId,
    target: publicationTarget,
  };
  if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) {
    redirect(channelsLocation({ ...base, error: 'authorization', code: 'INVALID_EXPIRY' }));
  }
  const cookie = (await cookies()).toString();
  const scope = `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}`;
  const [registryResponse, packageResponse] = await Promise.all([
    fetch(`${scope}/channels`, { cache: 'no-store', headers: { cookie } }),
    fetch(`${scope}/channel-packages/${packageId}`, { cache: 'no-store', headers: { cookie } }),
  ]);
  if (!registryResponse.ok || !packageResponse.ok) {
    redirect(channelsLocation({ ...base, error: 'authorization', code: 'NOT_FOUND' }));
  }
  const registry = (await registryResponse.json()) as ChannelRegistryEnvelope;
  const channelPackage = (await packageResponse.json()) as ChannelPackageEnvelope;
  const adapter = registry.data.entries
    .find((entry) => entry.channelKey === channelKey)
    ?.adapterVersions.find((entry) => entry.id === adapterVersionId);
  if (adapter === undefined || adapter.adapterKey !== adapterKey) {
    redirect(channelsLocation({ ...base, error: 'authorization', code: 'ADAPTER_NOT_FOUND' }));
  }
  const grantedScopes =
    adapterKey === 'wordpress-woocommerce-draft'
      ? wordpressRequiredScopesFor({
          target: publicationTarget,
          assetRefs: channelPackage.data.package.manifest.assetRefs,
        })
      : adapterKey === 'shopify-draft'
        ? shopifyRequiredScopesFor(publicationTarget)
        : adapterKey === 'signed-webhook'
          ? signedWebhookRequiredScopes()
          : adapter.requiredScopes;
  const response = await fetch(`${scope}/channel-authorizations`, {
    method: 'POST',
    cache: 'no-store',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({
      adapterVersionId: adapter.id,
      target: authorizationTarget,
      grantedScopes,
      acceptedTermsVersion: adapter.termsVersion,
      secretArn,
      expiresAt: expiresAt?.toISOString() ?? null,
    }),
  });
  if (!response.ok) {
    redirect(
      channelsLocation({
        ...base,
        error: 'authorization',
        code: await responseCode(response),
      }),
    );
  }
  redirect(
    channelsLocation({
      ...base,
      notice:
        adapterKey === 'git-pull-request'
          ? 'git-authorization'
          : adapterKey === 'wordpress-woocommerce-draft'
            ? 'wordpress-authorization'
            : adapterKey === 'shopify-draft'
              ? 'shopify-authorization'
              : adapterKey === 'signed-webhook'
                ? 'signed-webhook-authorization'
                : 'authorization',
    }),
  );
}

async function revokeChannelAuthorization(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const artifactId = requiredText(formData, 'artifactId');
  const artifactRevisionId = requiredText(formData, 'artifactRevisionId');
  const channelKey = requiredText(formData, 'channelKey');
  const packageId = requiredText(formData, 'packageId');
  const adapterVersionId = requiredText(formData, 'adapterVersionId');
  const target = requiredText(formData, 'target');
  const authorizationId = requiredText(formData, 'authorizationId');
  const base = {
    tenantId,
    workspaceId,
    artifactId,
    artifactRevisionId,
    channelKey,
    packageId,
    adapterVersionId,
    target,
  };
  const cookie = (await cookies()).toString();
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/channel-authorizations/${authorizationId}/revoke`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: mutationHeaders(cookie),
      body: JSON.stringify({}),
    },
  );
  if (!response.ok) {
    redirect(
      channelsLocation({
        ...base,
        error: 'authorization-revoke',
        code: await responseCode(response),
      }),
    );
  }
  redirect(channelsLocation({ ...base, notice: 'authorization-revoked' }));
}

async function publishReviewedPackage(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const artifactId = requiredText(formData, 'artifactId');
  const artifactRevisionId = requiredText(formData, 'artifactRevisionId');
  const channelKey = requiredText(formData, 'channelKey');
  const packageId = requiredText(formData, 'packageId');
  const adapterVersionId = requiredText(formData, 'adapterVersionId');
  const target = requiredText(formData, 'target');
  const submittedPublicationIntentId = requiredText(formData, 'publicationIntentId');
  const retryFromPublicationId = optionalText(formData, 'retryFromPublicationId');
  const cookie = (await cookies()).toString();
  const scope = `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}`;
  const packageResponse = await fetch(`${scope}/channel-packages/${packageId}`, {
    cache: 'no-store',
    headers: { cookie },
  });
  const base = {
    tenantId,
    workspaceId,
    artifactId,
    artifactRevisionId,
    channelKey,
    packageId,
    adapterVersionId,
    target,
  };
  if (!packageResponse.ok) {
    redirect(channelsLocation({ ...base, error: 'publish', code: 'PACKAGE_NOT_FOUND' }));
  }
  const channelPackage = (await packageResponse.json()) as ChannelPackageEnvelope;
  const intentInput = {
    tenantId,
    workspaceId,
    packageId,
    packageChecksum: channelPackage.data.package.packageChecksum,
    adapterVersionId,
    target,
  };
  let publicationIntentId = publicationIntentKey(intentInput);
  if (retryFromPublicationId !== undefined) {
    const priorResponse = await fetch(`${scope}/publications/${retryFromPublicationId}`, {
      cache: 'no-store',
      headers: { cookie },
    });
    if (!priorResponse.ok) {
      redirect(channelsLocation({ ...base, error: 'publish', code: 'RETRY_SOURCE_NOT_FOUND' }));
    }
    const prior = ((await priorResponse.json()) as PublicationDetailEnvelope).data.publication;
    if (
      !isSafePublicationRetryStatus(prior.status) ||
      prior.channelPackageId !== packageId ||
      prior.packageChecksum !== intentInput.packageChecksum ||
      prior.adapterVersionId !== adapterVersionId ||
      prior.target !== target
    ) {
      redirect(channelsLocation({ ...base, error: 'publish', code: 'RETRY_SOURCE_NOT_SAFE' }));
    }
    publicationIntentId = publicationRetryIntentKey({
      ...intentInput,
      priorPublicationId: prior.id,
    });
  }
  if (submittedPublicationIntentId !== publicationIntentId) {
    redirect(channelsLocation({ ...base, error: 'publish', code: 'PUBLICATION_INTENT_INVALID' }));
  }
  const response = await fetch(`${scope}/publications`, {
    method: 'POST',
    cache: 'no-store',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({
      channelPackageId: packageId,
      adapterVersionId,
      target,
      expectedPackageChecksum: channelPackage.data.package.packageChecksum,
      idempotencyKey: publicationIntentId,
    }),
  });
  if (!response.ok) {
    redirect(channelsLocation({ ...base, error: 'publish', code: await responseCode(response) }));
  }
  const result = (await response.json()) as PublicationCommandEnvelope;
  redirect(
    channelsLocation({
      ...base,
      publicationId: result.data.publication.id,
      jobId: result.data.job.id,
      notice: 'publication',
    }),
  );
}

async function refreshPublicationRemoteStatus(formData: FormData): Promise<never> {
  'use server';
  const tenantId = requiredText(formData, 'tenantId');
  const workspaceId = requiredText(formData, 'workspaceId');
  const publicationId = requiredText(formData, 'publicationId');
  const artifactId = optionalText(formData, 'artifactId');
  const artifactRevisionId = optionalText(formData, 'artifactRevisionId');
  const channelKey = optionalText(formData, 'channelKey');
  const packageId = optionalText(formData, 'packageId');
  const adapterVersionId = optionalText(formData, 'adapterVersionId');
  const target = optionalText(formData, 'target');
  const base = {
    tenantId,
    workspaceId,
    publicationId,
    ...(artifactId === undefined ? {} : { artifactId }),
    ...(artifactRevisionId === undefined ? {} : { artifactRevisionId }),
    ...(channelKey === undefined ? {} : { channelKey }),
    ...(packageId === undefined ? {} : { packageId }),
    ...(adapterVersionId === undefined ? {} : { adapterVersionId }),
    ...(target === undefined ? {} : { target }),
  };
  const cookie = (await cookies()).toString();
  const response = await fetch(
    `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/publications/${publicationId}/remote-status/refresh`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: mutationHeaders(cookie),
      body: JSON.stringify({}),
    },
  );
  if (!response.ok) {
    redirect(
      channelsLocation({
        ...base,
        error: 'remote-status-refresh',
        code: await responseCode(response),
      }),
    );
  }
  redirect(channelsLocation({ ...base, notice: 'remote-status-refreshed' }));
}

interface ChannelsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ChannelsPage({ searchParams }: ChannelsPageProps) {
  const locale = await getLocale();
  const t = makeT(locale);
  const query = await searchParams;
  const tenantId = typeof query.tenant === 'string' ? query.tenant : undefined;
  const workspaceId = typeof query.workspace === 'string' ? query.workspace : undefined;
  if (tenantId === undefined || workspaceId === undefined) redirect('/app');
  const cookie = (await cookies()).toString();
  const scope = `${apiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}`;
  const [workspacesResponse, registryResponse] = await Promise.all([
    fetch(`${apiOrigin()}/api/v1/tenants`, { cache: 'no-store', headers: { cookie } }),
    fetch(`${scope}/channels`, { cache: 'no-store', headers: { cookie } }),
  ]);
  if (!workspacesResponse.ok || !registryResponse.ok) redirect('/login');
  const workspaces = (await workspacesResponse.json()) as WorkspaceListEnvelope;
  const membership = workspaces.data.workspaces.find(
    (entry) => entry.tenant.id === tenantId && entry.workspace.id === workspaceId,
  );
  if (membership === undefined) redirect('/app');
  const registry = (await registryResponse.json()) as ChannelRegistryEnvelope;
  const artifactId = typeof query.artifact === 'string' ? query.artifact : undefined;
  const requestedRevisionId =
    typeof query.artifactRevision === 'string' ? query.artifactRevision : undefined;
  const channelKey = typeof query.channel === 'string' ? query.channel : undefined;
  const packageId = typeof query.package === 'string' ? query.package : undefined;
  const adapterVersionId = typeof query.adapter === 'string' ? query.adapter : undefined;
  const target = typeof query.target === 'string' ? query.target : undefined;
  const publicationId = typeof query.publication === 'string' ? query.publication : undefined;

  let artifact: ArtifactBundleEnvelope['data'] | undefined;
  if (artifactId !== undefined) {
    const response = await fetch(`${scope}/artifacts/${artifactId}`, {
      cache: 'no-store',
      headers: { cookie },
    });
    if (response.ok) artifact = ((await response.json()) as ArtifactBundleEnvelope).data;
  }
  const approvedRevisions =
    artifact?.revisions.filter((revision) =>
      artifact?.selectableApprovedRevisions.some(
        (approved) =>
          approved.revision === revision.revision && approved.contentHash === revision.contentHash,
      ),
    ) ?? [];
  const selectedRevisionId = requestedRevisionId ?? approvedRevisions.at(-1)?.id;

  let channelPackage: ChannelPackageEnvelope['data']['package'] | undefined;
  if (packageId !== undefined) {
    const response = await fetch(`${scope}/channel-packages/${packageId}`, {
      cache: 'no-store',
      headers: { cookie },
    });
    if (response.ok)
      channelPackage = ((await response.json()) as ChannelPackageEnvelope).data.package;
  }
  const selectedChannel =
    registry.data.entries.find((entry) => entry.channelKey === channelKey) ??
    registry.data.entries.find((entry) => entry.id === channelPackage?.channel.definitionId);
  const selectedAdapter =
    selectedChannel?.adapterVersions.find((adapter) => adapter.id === adapterVersionId) ??
    selectedChannel?.adapterVersions[0];
  const effectiveTarget = target ?? `reviewed://${selectedChannel?.channelKey ?? 'export'}/default`;
  let gitTarget: ReturnType<typeof decodeGitPullRequestTarget> | undefined;
  if (selectedAdapter?.adapterKey === 'git-pull-request') {
    try {
      gitTarget = decodeGitPullRequestTarget(effectiveTarget);
    } catch {
      gitTarget = undefined;
    }
  }
  let wordpressTarget: ReturnType<typeof decodeWordPressDraftTarget> | undefined;
  if (selectedAdapter?.adapterKey === 'wordpress-woocommerce-draft') {
    try {
      wordpressTarget = decodeWordPressDraftTarget(effectiveTarget);
    } catch {
      wordpressTarget = undefined;
    }
  }
  const wordpressRequestPath =
    wordpressTarget === undefined
      ? undefined
      : wordpressTarget.destination.kind === 'PAGE'
        ? '/wp-json/wp/v2/pages'
        : wordpressTarget.destination.kind === 'POST'
          ? '/wp-json/wp/v2/posts'
          : '/wp-json/wc/v3/products';
  let shopifyTarget: ReturnType<typeof decodeShopifyDraftTarget> | undefined;
  if (selectedAdapter?.adapterKey === 'shopify-draft') {
    try {
      shopifyTarget = decodeShopifyDraftTarget(effectiveTarget);
    } catch {
      shopifyTarget = undefined;
    }
  }
  const shopifyMutation =
    shopifyTarget === undefined
      ? undefined
      : shopifyTarget.destination.kind === 'PAGE'
        ? shopifyTarget.destination.operation === 'CREATE'
          ? { operationName: 'PageCreate', field: 'pageCreate', guard: 'isPublished: false' }
          : { operationName: 'PageUpdate', field: 'pageUpdate', guard: 'isPublished: false' }
        : shopifyTarget.destination.kind === 'BLOG_ARTICLE'
          ? shopifyTarget.destination.operation === 'CREATE'
            ? {
                operationName: 'ArticleCreate',
                field: 'articleCreate',
                guard: 'isPublished: false',
              }
            : {
                operationName: 'ArticleUpdate',
                field: 'articleUpdate',
                guard: 'isPublished: false',
              }
          : shopifyTarget.destination.operation === 'CREATE'
            ? { operationName: 'ProductCreate', field: 'productCreate', guard: 'status: DRAFT' }
            : { operationName: 'ProductUpdate', field: 'productUpdate', guard: 'status: DRAFT' };
  let signedWebhookTarget: SignedWebhookTargetV1 | undefined;
  if (selectedAdapter?.adapterKey === 'signed-webhook') {
    try {
      signedWebhookTarget = decodeSignedWebhookTarget(effectiveTarget);
    } catch {
      signedWebhookTarget = undefined;
    }
  }
  const mayBuild = ['OWNER', 'PUBLISHER'].includes(membership.activeRole);
  const canManageAuthorizations = ['OWNER', 'ADMIN'].includes(membership.activeRole);

  let channelAuthorizations: ChannelAuthorizationEnvelope['data']['authorization'][] = [];
  if (channelPackage !== undefined && canManageAuthorizations) {
    const response = await fetch(`${scope}/channel-authorizations`, {
      cache: 'no-store',
      headers: { cookie },
    });
    if (response.ok) {
      channelAuthorizations = (
        (await response.json()) as {
          data: { authorizations: ChannelAuthorizationEnvelope['data']['authorization'][] };
        }
      ).data.authorizations;
    }
  }

  let eligibility: PublicationEligibilityEnvelope['data'] | undefined;
  let eligibilityProblem: { code: string; detail?: string } | undefined;
  if (channelPackage !== undefined && mayBuild) {
    const response = await fetch(`${scope}/publications/eligibility`, {
      method: 'POST',
      cache: 'no-store',
      headers: mutationHeaders(cookie),
      body: JSON.stringify({
        channelPackageId: channelPackage.id,
        ...(selectedAdapter === undefined ? {} : { adapterVersionId: selectedAdapter.id }),
        target: effectiveTarget,
        expectedPackageChecksum: channelPackage.packageChecksum,
      }),
    });
    if (response.ok) {
      eligibility = ((await response.json()) as PublicationEligibilityEnvelope).data;
    } else {
      const problem = (await response.json()) as { code?: string; detail?: string };
      eligibilityProblem = {
        code: problem.code ?? `HTTP_${response.status}`,
        ...(problem.detail === undefined ? {} : { detail: problem.detail }),
      };
    }
  }

  let publication: PublicationDetailEnvelope['data'] | undefined;
  if (publicationId !== undefined) {
    const response = await fetch(`${scope}/publications/${publicationId}`, {
      cache: 'no-store',
      headers: { cookie },
    });
    if (response.ok) publication = ((await response.json()) as PublicationDetailEnvelope).data;
  }
  const publicationRollbackHandle = publication?.publication.remoteState?.rollbackHandle;
  const isShopifyRemoteState =
    publicationRollbackHandle?.operation === 'DELETE_UNPUBLISHED_CONTENT' &&
    typeof publicationRollbackHandle.shopDomain === 'string' &&
    typeof publicationRollbackHandle.contentType === 'string' &&
    typeof publicationRollbackHandle.remoteGid === 'string';
  const shopifyRemoteGid = isShopifyRemoteState
    ? (publicationRollbackHandle.remoteGid as string)
    : undefined;

  const publicationIntentInput =
    channelPackage === undefined || selectedAdapter === undefined
      ? undefined
      : {
          tenantId,
          workspaceId,
          packageId: channelPackage.id,
          packageChecksum: channelPackage.packageChecksum,
          adapterVersionId: selectedAdapter.id,
          target: effectiveTarget,
        };
  const retryFromPublicationId =
    publication !== undefined && isSafePublicationRetryStatus(publication.publication.status)
      ? publication.publication.id
      : undefined;
  const publicationIntentId =
    publicationIntentInput === undefined
      ? undefined
      : retryFromPublicationId === undefined
        ? publication === undefined
          ? publicationIntentKey(publicationIntentInput)
          : undefined
        : publicationRetryIntentKey({
            ...publicationIntentInput,
            priorPublicationId: retryFromPublicationId,
          });

  const claimCount = channelPackage?.manifest.claimSourceMap.length ?? 0;
  const evidenceCount =
    channelPackage === undefined
      ? 0
      : channelPackage.manifest.claimSourceMap.reduce(
          (sum, claim) => sum + claim.evidence.length,
          0,
        );
  const deliveryModeKey =
    selectedAdapter?.adapterKey === 'git-pull-request'
      ? 'channels.confirmDeliveryPr'
      : selectedAdapter?.adapterKey === 'wordpress-woocommerce-draft'
        ? 'channels.confirmDeliveryDraft'
        : selectedAdapter?.adapterKey === 'shopify-draft'
          ? 'channels.confirmDeliveryDraft'
          : selectedAdapter?.adapterKey === 'signed-webhook'
            ? 'channels.confirmDeliveryWebhook'
            : 'channels.confirmDeliveryPackage';

  return (
    <main>
      <p className="eyebrow">{t('channels.eyebrow')}</p>
      <h1>{t('channels.title')}</h1>
      <p className="lede">{t('channels.lede')}</p>
      <nav aria-label={t('channels.breadcrumbAria')} className="breadcrumb">
        <a href={`/app?tenant=${tenantId}&workspace=${workspaceId}`}>
          {t('channels.breadcrumbWorkspace')}
        </a>
        <span aria-hidden="true">/</span>
        <a href={`/app/artifacts?tenant=${tenantId}&workspace=${workspaceId}`}>
          {t('channels.breadcrumbArtifacts')}
        </a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{t('channels.breadcrumbChannels')}</span>
      </nav>

      {query.notice === 'package' ? (
        <p className="success-message" role="status">
          {t('channels.noticePackage')}
        </p>
      ) : null}
      {query.notice === 'authorization' ? (
        <p className="success-message" role="status">
          {t('channels.noticeAuthorization')}
        </p>
      ) : null}
      {query.notice === 'git-authorization' ? (
        <p className="success-message" role="status">
          {t('channels.noticeGitAuthorization')}
        </p>
      ) : null}
      {query.notice === 'wordpress-authorization' ? (
        <p className="success-message" role="status">
          {t('channels.noticeWordPressAuthorization')}
        </p>
      ) : null}
      {query.notice === 'shopify-authorization' ? (
        <p className="success-message" role="status">
          {t('channels.noticeShopifyAuthorization')}
        </p>
      ) : null}
      {query.notice === 'signed-webhook-authorization' ? (
        <p className="success-message" role="status">
          {t('channels.noticeSignedWebhookAuthorization')}
        </p>
      ) : null}
      {query.notice === 'authorization-revoked' ? (
        <p className="success-message" role="status">
          {t('channels.noticeAuthorizationRevoked')}
        </p>
      ) : null}
      {query.notice === 'publication' ? (
        <p className="success-message" role="status">
          {t('channels.noticePublication')}
        </p>
      ) : null}
      {query.notice === 'remote-status-refreshed' ? (
        <p className="success-message" role="status">
          {t('channels.noticeRemoteStatusRefreshed')}
        </p>
      ) : null}
      {typeof query.error === 'string' ? (
        <p className="error-message" role="alert">
          {typeof query.code === 'string' && query.code === 'UNSUPPORTED_CLAIM_BLOCKS_PUBLICATION'
            ? t('channels.unsupportedBlock')
            : t('channels.errorGeneric', {
                code: typeof query.code === 'string' ? query.code : query.error,
              })}
        </p>
      ) : null}

      <section aria-labelledby="registry-heading" className="shell-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{t('channels.registryEyebrow')}</p>
            <h2 id="registry-heading">{t('channels.registryHeading')}</h2>
          </div>
          <span className="status-badge neutral">
            {t('channels.registryCount', { count: registry.data.entries.length })}
          </span>
        </div>
        <div className="channel-grid">
          {registry.data.entries.map((entry) => (
            <article className="nested-card" data-testid="channel-registry-entry" key={entry.id}>
              <h3>{entry.displayName}</h3>
              <p>
                <code>{entry.channelKey}</code>
              </p>
              <p>{t('channels.registryStatus', { status: entry.status })}</p>
              <p>{t('channels.registryPackageSchema', { version: entry.packageSchemaVersion })}</p>
              <p>
                {t('channels.registryAdaptersLabel')}
                {entry.adapterVersions.length === 0
                  ? t('channels.registryNoAdapters')
                  : entry.adapterVersions
                      .map((adapter) => `${adapter.adapterKey}@${adapter.adapterVersion}`)
                      .join(', ')}
              </p>
              {entry.channelProfile === undefined || entry.channelProfile === null ? null : (
                <div data-testid="channel-profile-summary">
                  <p className="monospace break-anywhere">
                    {t('channels.profileSummary', {
                      version: entry.channelProfile.profileVersion,
                      hash: entry.channelProfile.profileHash,
                    })}
                  </p>
                  <p>
                    {t('channels.requiredFields', {
                      fields: entry.channelProfile.fieldRequirements
                        .map((requirement) => requirement.field)
                        .join(', '),
                    })}
                  </p>
                  <p className="field-help">{t('channels.profileHelp')}</p>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="package-builder-heading" className="shell-card">
        <h2 id="package-builder-heading">{t('channels.builderHeading')}</h2>
        {artifact === undefined ? (
          <p>
            {t('channels.builderNeedArtifactPrefix')}{' '}
            <a href={`/app/artifacts?tenant=${tenantId}&workspace=${workspaceId}`}>
              {t('channels.builderArtifactStudioLink')}
            </a>{' '}
            {t('channels.builderNeedArtifactSuffix')}
          </p>
        ) : approvedRevisions.length === 0 ? (
          <p className="error-message" role="status">
            {t('channels.builderNoRevisions')}
          </p>
        ) : !mayBuild ? (
          <p>{t('channels.builderNoPermission')}</p>
        ) : (
          <form action={buildChannelPackage} className="stacked-form wide-form">
            <input name="tenantId" type="hidden" value={tenantId} />
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <input name="artifactId" type="hidden" value={artifact.artifact.id} />
            <label htmlFor="approved-artifact-revision">
              {t('channels.approvedRevisionLabel')}
            </label>
            <select
              defaultValue={selectedRevisionId}
              id="approved-artifact-revision"
              name="artifactRevisionId"
              required
            >
              {approvedRevisions.map((revision) => (
                <option key={revision.id} value={revision.id}>
                  R{revision.revision} · {revision.contentHash}
                </option>
              ))}
            </select>
            <p className="field-help">{t('channels.approvedRevisionHelp')}</p>
            <label htmlFor="channel-registry-select">{t('channels.registrySelectLabel')}</label>
            <select
              defaultValue={selectedChannel?.channelKey}
              id="channel-registry-select"
              name="channelKey"
              required
            >
              {registry.data.entries.map((entry) => (
                <option key={entry.id} value={entry.channelKey}>
                  {entry.displayName}
                </option>
              ))}
            </select>
            <button className="primary-action" type="submit">
              {t('channels.buildAction')}
            </button>
          </form>
        )}
      </section>

      {channelPackage === undefined || packageId === undefined ? null : (
        <>
          <section aria-labelledby="package-preview-heading" className="shell-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">
                  {t('channels.packageEyebrow', { revision: channelPackage.packageRevision })}
                </p>
                <h2 id="package-preview-heading">{t('channels.packagePreviewHeading')}</h2>
              </div>
              <span className="status-badge ready">{t('channels.packageVerifiedBadge')}</span>
            </div>
            <p data-testid="channel-package-checksum" className="monospace break-anywhere">
              {t('channels.packageChecksum', { checksum: channelPackage.packageChecksum })}
            </p>
            <p data-testid="channel-package-exact-artifact" className="monospace break-anywhere">
              {t('channels.packageArtifactRevision', {
                id: channelPackage.artifact.artifactRevisionId,
                revision: channelPackage.artifact.revision,
                hash: channelPackage.artifact.contentHash,
              })}
            </p>
            <p>{t('channels.packageChannel', { channel: channelPackage.channel.channelKey })}</p>
            <a
              className="secondary-action download-action"
              href={`${publicApiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/channel-packages/${packageId}/export`}
            >
              {channelPackage.manifest.channelProfile === undefined
                ? t('channels.downloadAction')
                : t('channels.downloadReviewedAction')}
            </a>

            <div data-testid="channel-package-manifest" className="manifest-panel">
              <h3>{t('channels.manifestHeading')}</h3>
              <p>
                {t('channels.manifestSchemaVersion', {
                  version: channelPackage.manifest.schemaVersion,
                })}
              </p>
              {channelPackage.manifest.channelProfile === undefined ? null : (
                <div className="nested-card" data-testid="channel-package-profile">
                  <p>
                    <strong>{t('channels.profileReviewedHeading')}</strong>
                  </p>
                  <p>
                    {t('channels.profileChannel', {
                      channel: channelPackage.manifest.channelProfile.channel,
                    })}
                  </p>
                  <p>
                    {t('channels.profileVersion', {
                      version: channelPackage.manifest.channelProfile.profileVersion,
                    })}
                  </p>
                  <p className="monospace break-anywhere">
                    {t('channels.profileHash', {
                      hash: channelPackage.manifest.channelProfile.profileHash,
                    })}
                  </p>
                  <ul>
                    {channelPackage.manifest.channelProfile.fieldRequirements.map((requirement) => (
                      <li key={requirement.field}>
                        <strong>{requirement.field}</strong> ← {requirement.sourcePointer} ·{' '}
                        {requirement.required
                          ? t('channels.requirementRequired')
                          : t('channels.requirementOptional')}{' '}
                        · {t('channels.requirementLength')}{' '}
                        {requirement.minLength ?? t('channels.requirementNone')}..
                        {requirement.maxLength ?? t('channels.requirementNone')} ·{' '}
                        {requirement.format}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t('channels.manifestColPath')}</th>
                      <th>{t('channels.manifestColMediaType')}</th>
                      <th>{t('channels.manifestColSha256')}</th>
                      <th>{t('channels.manifestColBytes')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channelPackage.manifest.files.map((file) => (
                      <tr data-testid="channel-package-manifest-file" key={file.path}>
                        <td>{file.path}</td>
                        <td>{file.mediaType}</td>
                        <td className="monospace">{file.sha256}</td>
                        <td>{file.byteLength}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div data-testid="channel-package-asset-refs">
                <h3>{t('channels.assetRefsHeading')}</h3>
                {channelPackage.manifest.assetRefs.length === 0 ? (
                  <p>{t('channels.assetRefsNone')}</p>
                ) : (
                  <ul>
                    {channelPackage.manifest.assetRefs.map((ref) => (
                      <li key={ref}>{ref}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div data-testid="channel-package-claim-source-map">
                <h3>{t('channels.claimSourceMapHeading')}</h3>
                {channelPackage.manifest.claimSourceMap.map((claim) => (
                  <article className="nested-card" key={claim.claimRevisionId}>
                    <p className="monospace break-anywhere">
                      {t('channels.claimMapClaim', {
                        id: claim.claimId,
                        revision: claim.claimRevisionId,
                        hash: claim.claimContentHash,
                      })}
                    </p>
                    {claim.evidence.map((evidence) => (
                      <p className="monospace break-anywhere" key={evidence.snapshotId}>
                        {t('channels.claimMapEvidence', {
                          source: evidence.sourceId,
                          snapshot: evidence.snapshotId,
                          hash: evidence.sourceHash,
                        })}
                      </p>
                    ))}
                  </article>
                ))}
              </div>
            </div>

            <details open>
              <summary>{t('channels.markdownPreviewSummary')}</summary>
              <pre data-testid="channel-package-markdown">{channelPackage.preview.markdown}</pre>
            </details>
            <details open>
              <summary>{t('channels.htmlSourceSummary')}</summary>
              <pre data-testid="channel-package-html-source">{channelPackage.preview.html}</pre>
            </details>
            <details open>
              <summary>{t('channels.jsonLdSummary')}</summary>
              <pre data-testid="channel-package-json-ld">
                {JSON.stringify(channelPackage.preview.jsonLd, null, 2)}
              </pre>
            </details>
          </section>

          <section aria-labelledby="eligibility-heading" className="shell-card">
            <h2 id="eligibility-heading">{t('channels.eligibilityHeading')}</h2>
            <div data-testid="publication-eligibility" aria-live="polite">
              {eligibility === undefined ? (
                <p>
                  {eligibilityProblem === undefined
                    ? t('channels.eligibilityViewOnly')
                    : t('channels.eligibilityProblem', {
                        code: eligibilityProblem.code,
                        detail:
                          eligibilityProblem.detail ??
                          t('channels.eligibilityProblemDefaultDetail'),
                      })}
                </p>
              ) : eligibility.eligibility.mode === 'EXPORT_ONLY' ? (
                <div className="state-panel export-only">
                  <p>
                    <strong>EXPORT_ONLY</strong> {t('channels.exportOnlyNote')}
                  </p>
                  <ul>
                    {eligibility.eligibility.reasons.map((reason) => (
                      <li key={`${reason.code}:${reason.detail}`}>
                        <strong>{reason.code}</strong> · {reason.detail}
                      </li>
                    ))}
                  </ul>
                  {channelPackage.manifest.channelProfile === undefined ? null : (
                    <a
                      className="secondary-action download-action"
                      href={`${publicApiOrigin()}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/channel-packages/${packageId}/export`}
                    >
                      {t('channels.exportHandoffAction')}
                    </a>
                  )}
                </div>
              ) : (
                <div className="state-panel publish-ready">
                  <p>
                    <strong>PUBLISH_READY</strong> {t('channels.publishReadyNote')}
                  </p>
                </div>
              )}
            </div>

            {gitTarget === undefined ? null : (
              <div className="nested-card" data-testid="git-planned-diff">
                <p className="eyebrow">{t('channels.gitDiffEyebrow')}</p>
                <h3>{t('channels.gitTargetHeading')}</h3>
                <p>
                  {t('channels.gitRepositoryValue')}
                  <strong>{gitTarget.repository}</strong>
                </p>
                <p>
                  {t('channels.gitProtectedBaseValue')}
                  <strong>{gitTarget.baseBranch}</strong>
                </p>
                <p>
                  {t('channels.gitAuthorizedPathValue')}
                  <strong>{gitTarget.pathPrefix}</strong>
                </p>
                <p className="field-help">{t('channels.gitDiffHelp')}</p>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('channels.gitColPlannedPath')}</th>
                        <th>{t('channels.gitColOperation')}</th>
                        <th>{t('channels.manifestColSha256')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {channelPackage.manifest.files.map((file) => (
                        <tr data-testid="git-planned-file" key={file.path}>
                          <td>{`${gitTarget.pathPrefix}/${file.path}`}</td>
                          <td>{t('channels.gitOperationCell')}</td>
                          <td className="monospace">{file.sha256}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {wordpressTarget === undefined || wordpressRequestPath === undefined ? null : (
              <div className="nested-card" data-testid="wordpress-mapped-payload-preview">
                <p className="eyebrow">{t('channels.wordpressEyebrow')}</p>
                <h3>{t('channels.wordpressTargetHeading')}</h3>
                <p className="monospace">
                  POST {wordpressRequestPath}
                  {wordpressTarget.destination.operation === 'UPDATE'
                    ? `/${String(wordpressTarget.destination.remoteId)}`
                    : ''}
                </p>
                <p>{t('channels.wordpressStatusDraft')}</p>
                <p>
                  {t('channels.wordpressOperationValue', {
                    operation: wordpressTarget.destination.operation,
                  })}
                </p>
                <p>
                  {t('channels.wordpressContentTypeValue', {
                    kind: wordpressTarget.destination.kind,
                  })}
                </p>
                <p>
                  {t('channels.wordpressSlugValue', { slug: wordpressTarget.destination.slug })}
                </p>
                {'categoryIds' in wordpressTarget.destination ? (
                  <p>
                    {t('channels.wordpressCategoriesLabel')}
                    {wordpressTarget.destination.categoryIds.join(', ') ||
                      t('channels.wordpressCategoriesNone')}
                  </p>
                ) : null}
                <p className="monospace break-anywhere">
                  {t('channels.packageArtifactRevision', {
                    id: channelPackage.artifact.artifactRevisionId,
                    revision: channelPackage.artifact.revision,
                    hash: channelPackage.artifact.contentHash,
                  })}
                </p>
                <p className="monospace break-anywhere">
                  {t('channels.packageChecksum', { checksum: channelPackage.packageChecksum })}
                </p>
                <p className="field-help">{t('channels.wordpressPreviewHelp')}</p>
              </div>
            )}

            {shopifyTarget === undefined || shopifyMutation === undefined ? null : (
              <div className="nested-card" data-testid="shopify-mapped-graphql-preview">
                <p className="eyebrow">{t('channels.shopifyEyebrow')}</p>
                <h3>{t('channels.shopifyTargetHeading')}</h3>
                <p className="monospace">POST /admin/api/{shopifyTarget.apiVersion}/graphql.json</p>
                <p className="monospace">mutation {shopifyMutation.operationName}</p>
                <p className="monospace">{shopifyMutation.field}</p>
                <p>{shopifyMutation.guard}</p>
                <p>
                  {t('channels.shopifyContentTypeValue', { kind: shopifyTarget.destination.kind })}
                </p>
                <p>
                  {t('channels.shopifyOperationValue', {
                    operation: shopifyTarget.destination.operation,
                  })}
                </p>
                <p>
                  {t('channels.shopifyHandleValue', { handle: shopifyTarget.destination.handle })}
                </p>
                <p className="monospace break-anywhere">
                  {t('channels.packageArtifactRevision', {
                    id: channelPackage.artifact.artifactRevisionId,
                    revision: channelPackage.artifact.revision,
                    hash: channelPackage.artifact.contentHash,
                  })}
                </p>
                <p className="monospace break-anywhere">
                  {t('channels.packageChecksum', { checksum: channelPackage.packageChecksum })}
                </p>
                <p className="field-help">{t('channels.shopifyPreviewHelp')}</p>
              </div>
            )}

            {signedWebhookTarget === undefined ? null : (
              <div className="nested-card" data-testid="signed-webhook-delivery-preview">
                <p className="eyebrow">{t('channels.webhookEyebrow')}</p>
                <h3>{t('channels.webhookTargetHeading')}</h3>
                <p className="monospace break-anywhere">POST {signedWebhookTarget.endpointUrl}</p>
                <p className="monospace break-anywhere">
                  Reconcile POST {signedWebhookTarget.receiptUrl}
                </p>
                <p>{t('channels.webhookSchemaVersionValue')}</p>
                <p>{t('channels.webhookEventTypeValue')}</p>
                <p>
                  {t('channels.webhookAlgorithmValue', {
                    algorithm: signedWebhookTarget.algorithm,
                  })}
                </p>
                <p>{t('channels.webhookKeyIdValue', { keyId: signedWebhookTarget.keyId })}</p>
                <p className="monospace break-anywhere">
                  {t('channels.packageArtifactRevision', {
                    id: channelPackage.artifact.artifactRevisionId,
                    revision: channelPackage.artifact.revision,
                    hash: channelPackage.artifact.contentHash,
                  })}
                </p>
                <p className="monospace break-anywhere">
                  {t('channels.packageChecksum', { checksum: channelPackage.packageChecksum })}
                </p>
                <p className="field-help">{t('channels.webhookPreviewHelp')}</p>
              </div>
            )}

            {canManageAuthorizations && selectedAdapter !== undefined ? (
              <form action={saveChannelAuthorization} className="stacked-form wide-form">
                <h3>{t('channels.authorizationHeading')}</h3>
                <input name="tenantId" type="hidden" value={tenantId} />
                <input name="workspaceId" type="hidden" value={workspaceId} />
                <input name="artifactId" type="hidden" value={channelPackage.artifact.artifactId} />
                <input
                  name="artifactRevisionId"
                  type="hidden"
                  value={channelPackage.artifact.artifactRevisionId}
                />
                <input
                  name="channelKey"
                  type="hidden"
                  value={selectedChannel?.channelKey ?? channelPackage.channel.channelKey}
                />
                <input name="packageId" type="hidden" value={packageId} />
                <input name="adapterVersionId" type="hidden" value={selectedAdapter.id} />
                <input name="adapterKey" type="hidden" value={selectedAdapter.adapterKey} />
                <p>
                  {t('channels.authorizationAdapterLabel')}
                  <code>
                    {selectedAdapter.adapterKey}@{selectedAdapter.adapterVersion}
                  </code>
                </p>
                <p>
                  {t('channels.authorizationRequiredScopesLabel')}
                  <strong data-testid="channel-adapter-required-scopes">
                    {selectedAdapter.requiredScopes.join(', ') || t('channels.authorizationNone')}
                  </strong>
                </p>
                <p>
                  {t('channels.authorizationTermsVersionLabel')}
                  <strong data-testid="channel-adapter-terms-version">
                    {selectedAdapter.termsVersion}
                  </strong>{' '}
                  · {selectedAdapter.termsStatus}
                </p>
                {selectedAdapter.adapterKey === 'git-pull-request' ? (
                  <>
                    <label htmlFor="git-installation-id">
                      {t('channels.gitInstallationIdField')}
                    </label>
                    <input
                      defaultValue={gitTarget?.installationId ?? ''}
                      id="git-installation-id"
                      name="gitInstallationId"
                      required
                    />
                    <label htmlFor="git-repository">{t('channels.gitRepositoryField')}</label>
                    <input
                      defaultValue={gitTarget?.repository ?? ''}
                      id="git-repository"
                      name="gitRepository"
                      placeholder="owner/repository"
                      required
                    />
                    <label htmlFor="git-base-branch">{t('channels.gitBaseBranchField')}</label>
                    <input
                      defaultValue={gitTarget?.baseBranch ?? 'main'}
                      id="git-base-branch"
                      name="gitBaseBranch"
                      required
                    />
                    <label htmlFor="git-path-prefix">{t('channels.gitPathPrefixField')}</label>
                    <input
                      defaultValue={gitTarget?.pathPrefix ?? ''}
                      id="git-path-prefix"
                      name="gitPathPrefix"
                      placeholder="content/approved"
                      required
                    />
                  </>
                ) : selectedAdapter.adapterKey === 'wordpress-woocommerce-draft' ? (
                  <>
                    <label htmlFor="wordpress-site-url">
                      {t('channels.wordpressSiteUrlField')}
                    </label>
                    <input
                      defaultValue={wordpressTarget?.siteUrl ?? ''}
                      id="wordpress-site-url"
                      name="wordpressSiteUrl"
                      placeholder="https://cms.example.com"
                      required
                      type="url"
                    />
                    <label htmlFor="wordpress-auth-mode">
                      {t('channels.wordpressAuthModeField')}
                    </label>
                    <select
                      defaultValue={wordpressTarget?.authMode ?? 'APPLICATION_PASSWORD'}
                      id="wordpress-auth-mode"
                      name="wordpressAuthMode"
                      required
                    >
                      <option value="APPLICATION_PASSWORD">
                        {t('channels.wordpressAuthModePassword')}
                      </option>
                      <option value="OAUTH">{t('channels.wordpressAuthModeOAuth')}</option>
                      <option value="APPROVED_TOKEN">{t('channels.wordpressAuthModeToken')}</option>
                    </select>
                    <label htmlFor="wordpress-content-type">
                      {t('channels.wordpressContentTypeField')}
                    </label>
                    <select
                      defaultValue={wordpressTarget?.destination.kind ?? 'PAGE'}
                      id="wordpress-content-type"
                      name="wordpressContentType"
                      required
                    >
                      <option value="PAGE">{t('channels.wordpressContentTypePage')}</option>
                      <option value="POST">{t('channels.wordpressContentTypePost')}</option>
                      <option value="PRODUCT">{t('channels.wordpressContentTypeProduct')}</option>
                    </select>
                    <label htmlFor="wordpress-operation">
                      {t('channels.wordpressOperationField')}
                    </label>
                    <select
                      defaultValue={wordpressTarget?.destination.operation ?? 'CREATE'}
                      id="wordpress-operation"
                      name="wordpressOperation"
                      required
                    >
                      <option value="CREATE">{t('channels.wordpressOperationCreate')}</option>
                      <option value="UPDATE">{t('channels.wordpressOperationUpdate')}</option>
                    </select>
                    <label htmlFor="wordpress-slug">{t('channels.wordpressSlugField')}</label>
                    <input
                      defaultValue={wordpressTarget?.destination.slug ?? ''}
                      id="wordpress-slug"
                      name="wordpressSlug"
                      placeholder="approved-answer-guide"
                      required
                    />
                    <label htmlFor="wordpress-remote-id">
                      {t('channels.wordpressRemoteIdField')}
                    </label>
                    <input
                      defaultValue={
                        wordpressTarget?.destination.operation === 'UPDATE'
                          ? wordpressTarget.destination.remoteId
                          : ''
                      }
                      id="wordpress-remote-id"
                      min="1"
                      name="wordpressRemoteId"
                      type="number"
                    />
                    <label htmlFor="wordpress-category-ids">
                      {t('channels.wordpressCategoryIdsField')}
                    </label>
                    <input
                      defaultValue={
                        wordpressTarget !== undefined &&
                        'categoryIds' in wordpressTarget.destination
                          ? wordpressTarget.destination.categoryIds.join(',')
                          : ''
                      }
                      id="wordpress-category-ids"
                      name="wordpressCategoryIds"
                      placeholder="2,5,8"
                    />
                  </>
                ) : selectedAdapter.adapterKey === 'shopify-draft' ? (
                  <>
                    <label htmlFor="shopify-shop-domain">
                      {t('channels.shopifyShopDomainField')}
                    </label>
                    <input
                      defaultValue={shopifyTarget?.shopDomain ?? ''}
                      id="shopify-shop-domain"
                      name="shopifyShopDomain"
                      placeholder="store.myshopify.com"
                      required
                    />
                    <ShopifyTargetFields
                      apiVersion={
                        shopifyTarget?.apiVersion ?? selectedAdapter.providerApiVersion ?? '2026-07'
                      }
                      contentType={shopifyTarget?.destination.kind ?? 'PAGE'}
                      handle={shopifyTarget?.destination.handle ?? ''}
                      locale={locale}
                      operation={shopifyTarget?.destination.operation ?? 'CREATE'}
                      {...(shopifyTarget?.destination.kind === 'BLOG_ARTICLE'
                        ? { blogId: shopifyTarget.destination.blogId }
                        : {})}
                      {...(shopifyTarget?.destination.operation === 'UPDATE'
                        ? { remoteId: shopifyTarget.destination.remoteId }
                        : {})}
                    />
                  </>
                ) : selectedAdapter.adapterKey === 'signed-webhook' ? (
                  <>
                    <label htmlFor="webhook-delivery-endpoint">
                      {t('channels.webhookDeliveryEndpointField')}
                    </label>
                    <input
                      defaultValue={signedWebhookTarget?.endpointUrl ?? ''}
                      id="webhook-delivery-endpoint"
                      name="webhookDeliveryEndpoint"
                      placeholder="https://cms.example.com/v1/channel-packages"
                      required
                      type="url"
                    />
                    <label htmlFor="webhook-receipt-endpoint">
                      {t('channels.webhookReceiptEndpointField')}
                    </label>
                    <input
                      defaultValue={signedWebhookTarget?.receiptUrl ?? ''}
                      id="webhook-receipt-endpoint"
                      name="webhookReceiptEndpoint"
                      placeholder="https://cms.example.com/v1/channel-package-receipts"
                      required
                      type="url"
                    />
                    <label htmlFor="webhook-endpoint-verification-id">
                      {t('channels.webhookVerificationIdField')}
                    </label>
                    <input
                      defaultValue={signedWebhookTarget?.endpointVerificationId ?? ''}
                      id="webhook-endpoint-verification-id"
                      name="webhookEndpointVerificationId"
                      required
                    />
                    <label htmlFor="webhook-signing-algorithm">
                      {t('channels.webhookAlgorithmField')}
                    </label>
                    <select
                      defaultValue={signedWebhookTarget?.algorithm ?? 'HMAC_SHA256'}
                      id="webhook-signing-algorithm"
                      name="webhookSigningAlgorithm"
                      required
                    >
                      <option value="HMAC_SHA256">{t('channels.webhookAlgorithmHmac')}</option>
                      <option value="ED25519">{t('channels.webhookAlgorithmEd25519')}</option>
                    </select>
                    <label htmlFor="webhook-signing-key-id">
                      {t('channels.webhookKeyIdField')}
                    </label>
                    <input
                      defaultValue={signedWebhookTarget?.keyId ?? ''}
                      id="webhook-signing-key-id"
                      name="webhookSigningKeyId"
                      required
                    />
                  </>
                ) : (
                  <>
                    <label htmlFor="channel-authorization-target">
                      {t('channels.authorizationTargetField')}
                    </label>
                    <input
                      defaultValue={effectiveTarget}
                      id="channel-authorization-target"
                      name="target"
                      required
                    />
                  </>
                )}
                <details className="advanced-fields" open>
                  <summary>{t('channels.advancedFields')}</summary>
                  <label htmlFor="channel-secret-arn">
                    {selectedAdapter.adapterKey === 'wordpress-woocommerce-draft'
                      ? t('channels.wordpressSecretArnField')
                      : selectedAdapter.adapterKey === 'shopify-draft'
                        ? t('channels.shopifySecretArnField')
                        : selectedAdapter.adapterKey === 'signed-webhook'
                          ? t('channels.webhookSecretArnField')
                          : t('channels.secretArnField')}
                  </label>
                  <input autoComplete="off" id="channel-secret-arn" name="secretArn" required />
                  <p className="field-help">{t('channels.secretArnHelp')}</p>
                  <label htmlFor="channel-authorization-expiry">
                    {t('channels.authorizationExpiryField')}
                  </label>
                  <input
                    id="channel-authorization-expiry"
                    name="expiresAt"
                    placeholder="2099-12-31T23:59:59+08:00"
                  />
                </details>
                <button className="secondary-button" type="submit">
                  {selectedAdapter.adapterKey === 'git-pull-request'
                    ? t('channels.saveGitAuthorizationAction')
                    : selectedAdapter.adapterKey === 'wordpress-woocommerce-draft'
                      ? t('channels.saveWordPressAuthorizationAction')
                      : selectedAdapter.adapterKey === 'shopify-draft'
                        ? t('channels.saveShopifyAuthorizationAction')
                        : selectedAdapter.adapterKey === 'signed-webhook'
                          ? t('channels.saveWebhookAuthorizationAction')
                          : t('channels.saveAuthorizationAction')}
                </button>
              </form>
            ) : null}

            {canManageAuthorizations ? (
              <div className="stacked-form" data-testid="channel-authorization-list">
                <h3>{t('channels.authorizationListHeading')}</h3>
                {channelAuthorizations.length === 0 ? (
                  <p>{t('channels.noAuthorizations')}</p>
                ) : (
                  channelAuthorizations.map((authorization) => (
                    <article
                      className="nested-card"
                      data-testid="channel-authorization"
                      key={authorization.id}
                    >
                      <p>
                        <strong>{authorization.status}</strong> · {authorization.target}
                      </p>
                      <p className="monospace break-anywhere">
                        {t('channels.authorizationAdapterVersion', {
                          id: authorization.adapterVersionId,
                        })}
                      </p>
                      <p>
                        {t('channels.authorizationScopesLabel')}
                        {authorization.grantedScopes.join(', ') ||
                          t('channels.authorizationNone')}{' '}
                        {t('channels.authorizationExpiresLabel')}
                        {authorization.expiresAt ?? t('channels.authorizationNone')}{' '}
                        {t('channels.authorizationSecretLabel')}
                        {authorization.secretConfigured
                          ? t('channels.authorizationSecretConfigured')
                          : t('channels.authorizationSecretMissing')}
                      </p>
                      <p data-testid="channel-authorization-validation">
                        {t('channels.authorizationValidationLabel')}
                        <strong>{authorization.validationStatus}</strong>
                        {authorization.validationSnapshot === null
                          ? authorization.validationFailureCode === null
                            ? t('channels.authorizationValidationPending')
                            : t('channels.authorizationValidationFailure', {
                                code: authorization.validationFailureCode,
                              })
                          : t('channels.authorizationValidationWindow', {
                              from: authorization.validationSnapshot.validatedAt,
                              until: authorization.validationSnapshot.validUntil,
                            })}
                      </p>
                      {authorization.status === 'ACTIVE' ? (
                        <form action={revokeChannelAuthorization}>
                          <input name="tenantId" type="hidden" value={tenantId} />
                          <input name="workspaceId" type="hidden" value={workspaceId} />
                          <input
                            name="artifactId"
                            type="hidden"
                            value={channelPackage.artifact.artifactId}
                          />
                          <input
                            name="artifactRevisionId"
                            type="hidden"
                            value={channelPackage.artifact.artifactRevisionId}
                          />
                          <input
                            name="channelKey"
                            type="hidden"
                            value={selectedChannel?.channelKey ?? channelPackage.channel.channelKey}
                          />
                          <input name="packageId" type="hidden" value={packageId} />
                          <input
                            name="adapterVersionId"
                            type="hidden"
                            value={authorization.adapterVersionId}
                          />
                          <input name="target" type="hidden" value={authorization.target} />
                          <input name="authorizationId" type="hidden" value={authorization.id} />
                          <button className="secondary-button" type="submit">
                            {t('channels.revokeAuthorizationAction')}
                          </button>
                        </form>
                      ) : null}
                    </article>
                  ))
                )}
              </div>
            ) : null}

            {['OWNER', 'PUBLISHER'].includes(membership.activeRole) &&
            eligibility?.eligibility.mode === 'PUBLISH_READY' &&
            selectedAdapter !== undefined &&
            publicationIntentId !== undefined ? (
              <>
                <div className="nested-card" data-testid="publication-confirmation">
                  <h3>{t('channels.confirmHeading')}</h3>
                  <p>
                    {t('channels.confirmChannel', { channel: channelPackage.channel.channelKey })}
                  </p>
                  <p>
                    {t('channels.confirmAdapter', {
                      adapter: `${selectedAdapter.adapterKey}@${selectedAdapter.adapterVersion}`,
                    })}
                  </p>
                  <p className="monospace break-anywhere">
                    {t('channels.confirmTarget', { target: effectiveTarget })}
                  </p>
                  <p>{t('channels.confirmDelivery', { mode: t(deliveryModeKey) })}</p>
                  <p className="monospace break-anywhere">
                    {t('channels.confirmRevision', {
                      revision: channelPackage.artifact.revision,
                      hash: channelPackage.artifact.contentHash,
                    })}
                  </p>
                  <p>
                    {t('channels.confirmEvidence', {
                      claims: claimCount,
                      evidence: evidenceCount,
                    })}
                  </p>
                  <p className="field-help">{t('channels.confirmHelp')}</p>
                </div>
                <form action={publishReviewedPackage} className="stacked-form">
                  <input name="tenantId" type="hidden" value={tenantId} />
                  <input name="workspaceId" type="hidden" value={workspaceId} />
                  <input
                    name="artifactId"
                    type="hidden"
                    value={channelPackage.artifact.artifactId}
                  />
                  <input
                    name="artifactRevisionId"
                    type="hidden"
                    value={channelPackage.artifact.artifactRevisionId}
                  />
                  <input
                    name="channelKey"
                    type="hidden"
                    value={selectedChannel?.channelKey ?? channelPackage.channel.channelKey}
                  />
                  <input name="packageId" type="hidden" value={packageId} />
                  <input name="adapterVersionId" type="hidden" value={selectedAdapter.id} />
                  <input name="target" type="hidden" value={effectiveTarget} />
                  <input name="publicationIntentId" type="hidden" value={publicationIntentId} />
                  {retryFromPublicationId === undefined ? null : (
                    <input
                      name="retryFromPublicationId"
                      type="hidden"
                      value={retryFromPublicationId}
                    />
                  )}
                  <button className="primary-action" type="submit">
                    {retryFromPublicationId === undefined
                      ? selectedAdapter.adapterKey === 'git-pull-request'
                        ? t('channels.publishGitAction')
                        : selectedAdapter.adapterKey === 'wordpress-woocommerce-draft'
                          ? t('channels.publishWordPressAction')
                          : selectedAdapter.adapterKey === 'shopify-draft'
                            ? t('channels.publishShopifyAction')
                            : selectedAdapter.adapterKey === 'signed-webhook'
                              ? t('channels.publishWebhookAction')
                              : t('channels.publishAction')
                      : t('channels.retryPublicationAction')}
                  </button>
                </form>
              </>
            ) : null}
          </section>
        </>
      )}

      {publication === undefined ? null : (
        <section aria-labelledby="publication-heading" className="shell-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{t('channels.publicationEyebrow')}</p>
              <h2 id="publication-heading">{t('channels.publicationHeading')}</h2>
            </div>
            <strong
              className={`status-badge ${publication.publication.status === 'PUBLISHED' ? 'ready' : 'neutral'}`}
              data-testid="publication-status"
            >
              {publication.publication.status}
            </strong>
          </div>
          <JobPoller status={publication.job.status} />
          <p>
            {t('channels.publicationJob', {
              id: publication.job.id,
              status: publication.job.status,
              attempt: publication.job.attempt,
              maxAttempts: publication.job.maxAttempts,
            })}
          </p>
          <p className="monospace break-anywhere">
            {t('channels.packageChecksum', { checksum: publication.publication.packageChecksum })}
          </p>
          {publicationRecoveryGuidance(publication.job.errorCode, t) === null ? null : (
            <p className="error-panel" data-testid="publication-recovery-guidance" role="alert">
              {publicationRecoveryGuidance(publication.job.errorCode, t)}
            </p>
          )}
          {publication.publication.remoteRef === null ? null : isShopifyRemoteState ? (
            <p className="monospace break-anywhere" data-testid="publication-remote-ref">
              <a href={publication.publication.remoteRef}>{t('channels.openShopifyDraft')}</a>
            </p>
          ) : publication.publication.remoteState?.status === 'DRAFT' ? (
            <p className="monospace break-anywhere" data-testid="publication-remote-ref">
              <a href={publication.publication.remoteRef}>{t('channels.openWordPressDraft')}</a>
            </p>
          ) : publication.publication.remoteState?.status.startsWith('PR_') ||
            ['MERGED', 'CLOSED', 'FAILED'].includes(
              publication.publication.remoteState?.status ?? '',
            ) ? (
            <p className="monospace break-anywhere" data-testid="publication-remote-ref">
              <a href={publication.publication.remoteRef}>{t('channels.openPullRequest')}</a>
            </p>
          ) : (
            <p className="monospace break-anywhere" data-testid="publication-remote-ref">
              {publication.publication.remoteRef}
            </p>
          )}
          {publication.publication.remoteState === null ||
          publication.publication.remoteState === undefined ? null : (
            <div className="state-panel" data-testid="publication-remote-state">
              <p>
                {t('channels.remoteStatusLabel')}
                <strong data-testid="publication-remote-status">
                  {publication.publication.remoteState.status}
                </strong>
              </p>
              {publication.publication.remoteState.number === null ? null : (
                <p>
                  {publication.publication.remoteState.status === 'DRAFT' ? (
                    <>
                      {t('channels.wordpressDraftIdLabel')}
                      <strong data-testid="wordpress-draft-id">
                        {publication.publication.remoteState.number}
                      </strong>
                    </>
                  ) : (
                    <>
                      {t('channels.pullRequestNumberLabel')}
                      <strong data-testid="publication-pr-number">
                        {publication.publication.remoteState.number}
                      </strong>
                    </>
                  )}
                </p>
              )}
              {shopifyRemoteGid === undefined ? null : (
                <p>
                  {t('channels.shopifyGidLabel')}
                  <strong data-testid="shopify-remote-gid">{shopifyRemoteGid}</strong>
                </p>
              )}
              <p data-testid="publication-production-live">
                {publication.publication.remoteState.isProductionLive
                  ? t('channels.productionLive')
                  : publication.publication.remoteState.status === 'DELIVERED'
                    ? t('channels.webhookDeliveredNotLive')
                    : isShopifyRemoteState
                      ? t('channels.shopifyContentNotLive')
                      : publication.publication.remoteState.status === 'DRAFT'
                        ? t('channels.wordpressDraftNotLive')
                        : t('channels.pullRequestNotLive')}
              </p>
              <p data-testid="publication-rollback-available">
                {publication.publication.remoteState.rollbackHandle === null
                  ? t('channels.noRollback')
                  : isShopifyRemoteState
                    ? t('channels.shopifyRollback')
                    : publication.publication.remoteState.status === 'DRAFT'
                      ? t('channels.wordpressRollback')
                      : t('channels.pullRequestRollback')}
              </p>
            </div>
          )}
          {mayBuild &&
          publication.publication.status === 'REMOTE_APPLIED' &&
          publication.publication.remoteState !== null &&
          publication.publication.remoteState !== undefined &&
          ['PR_OPENED', 'MERGED', 'CLOSED', 'FAILED'].includes(
            publication.publication.remoteState.status,
          ) ? (
            <form action={refreshPublicationRemoteStatus}>
              <input name="tenantId" type="hidden" value={tenantId} />
              <input name="workspaceId" type="hidden" value={workspaceId} />
              <input name="publicationId" type="hidden" value={publication.publication.id} />
              {artifactId === undefined ? null : (
                <input name="artifactId" type="hidden" value={artifactId} />
              )}
              {selectedRevisionId === undefined ? null : (
                <input name="artifactRevisionId" type="hidden" value={selectedRevisionId} />
              )}
              {selectedChannel === undefined ? null : (
                <input name="channelKey" type="hidden" value={selectedChannel.channelKey} />
              )}
              {channelPackage === undefined ? null : (
                <input name="packageId" type="hidden" value={channelPackage.id} />
              )}
              {selectedAdapter === undefined ? null : (
                <input name="adapterVersionId" type="hidden" value={selectedAdapter.id} />
              )}
              <input name="target" type="hidden" value={publication.publication.target} />
              <button className="secondary-action" type="submit">
                {t('channels.refreshPullRequestStatusAction')}
              </button>
            </form>
          ) : null}
          <h3>{t('channels.attemptsHeading')}</h3>
          <ol className="attempt-list">
            {publication.attempts.map((attempt) => (
              <li data-testid="publication-attempt" key={attempt.id}>
                <strong>
                  #{attempt.attemptNumber} · {attempt.operation} · {attempt.outcome}
                </strong>
                {attempt.errorCode === null ? null : <span> · {attempt.errorCode}</span>}
                {attempt.remoteRef === null ? null : (
                  <span className="monospace"> · {attempt.remoteRef}</span>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}
