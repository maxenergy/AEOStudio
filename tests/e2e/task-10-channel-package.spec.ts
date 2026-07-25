import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test';
import { ArtifactBundleEnvelopeSchema } from '@aeostudio/contracts/artifacts';
import {
  ChannelAuthorizationListEnvelopeSchema,
  ChannelPackageExportSchema,
  PublicationDetailEnvelopeSchema,
} from '@aeostudio/contracts/channels';
import { setupArtifactPrerequisites } from './helpers.js';

const apiOrigin = 'http://127.0.0.1:3200';
const webOrigin = 'http://127.0.0.1:3100';
const sensitiveSecretArn =
  'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:e2e/reviewed-publisher-sensitive';
const reviewedTarget = 'fake://reviewed-publication-target';

type TestIdentity = 'owner@example.test' | 'publisher@example.test' | 'reviewer@example.test';

interface ApprovedArtifactScope {
  tenantId: string;
  workspaceId: string;
  artifactId: string;
  artifactRevisionId: string;
  revision: number;
  contentHash: string;
}

function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value.length === 0) throw new Error(`EXPECTED_${name.toUpperCase()}`);
  return value;
}

async function authenticatedApiGet(page: Page, url: string): Promise<APIResponse> {
  // `__Host-` session cookies are Secure; Playwright's URL filter excludes them for an HTTP
  // request context even though Chromium treats loopback origins as trustworthy.
  const cookies = (await page.context().cookies()).filter(
    ({ name }) => name === '__Host-aeo_session',
  );
  const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  if (cookie.length === 0) throw new Error('AUTHENTICATED_API_COOKIE_MISSING');
  return page.request.get(url, { headers: { cookie } });
}

async function loginAs(page: Page, email: TestIdentity): Promise<void> {
  const hint = email === 'owner@example.test' ? '' : `?login_hint=${encodeURIComponent(email)}`;
  await page.goto(`${apiOrigin}/api/v1/auth/login${hint}`);
  await expect(page).toHaveURL(/\/app(?:\?|$)/);
  await expect(page.getByText(email)).toBeVisible();
}

async function selectRegistryEntry(select: Locator, displayName: string): Promise<void> {
  const option = select.locator('option').filter({ hasText: displayName });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute('value');
  if (value === null || value.length === 0) throw new Error('REGISTRY_OPTION_VALUE_MISSING');
  await select.selectOption(value);
}

async function createApprovedArtifact(
  page: Page,
  tenantName: string,
  workspaceName: string,
): Promise<ApprovedArtifactScope> {
  await page.goto('/app');
  await page.getByLabel('团队名称').fill(tenantName);
  await page.getByLabel('工作空间名称').fill(workspaceName);
  await page.getByRole('button', { name: '创建工作空间' }).click();
  await expect(page.getByRole('heading', { name: workspaceName })).toBeVisible();

  await setupArtifactPrerequisites(page);

  await page.getByRole('link', { name: '内容稿件工作室' }).click();
  await page.getByRole('button', { name: '保存 Artifact 预算' }).click();
  await page.getByRole('button', { name: '生成内容稿件草稿' }).click();
  await expect(page.getByTestId('artifact-job-status')).toHaveText('SUCCEEDED', {
    timeout: 15_000,
  });

  const artifactUrl = new URL(page.url());
  const tenantId = requiredParam(artifactUrl, 'tenant');
  const workspaceId = requiredParam(artifactUrl, 'workspace');
  const artifactId = requiredParam(artifactUrl, 'artifact');
  const bundleResponse = await authenticatedApiGet(
    page,
    `${apiOrigin}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/artifacts/${artifactId}`,
  );
  expect(bundleResponse.status()).toBe(200);
  const bundle = ArtifactBundleEnvelopeSchema.parse(await bundleResponse.json()).data;
  if (bundle.revision === null) throw new Error('ARTIFACT_REVISION_MISSING');

  await page.getByRole('button', { name: '提交 exact revision/hash 审核' }).click();
  await expect(page.getByRole('heading', { name: 'Exact-revision review' })).toBeVisible();
  await page.getByLabel('Review note').fill('Reviewed for the exact immutable revision and hash.');
  await page.getByRole('button', { name: '批准 exact revision/hash' }).click();
  await expect(page.getByText('Current approval：ELIGIBLE')).toBeVisible();

  return {
    tenantId,
    workspaceId,
    artifactId,
    artifactRevisionId: bundle.revision.id,
    revision: bundle.revision.revision,
    contentHash: bundle.revision.contentHash,
  };
}

async function inviteAsOwner(
  page: Page,
  email: 'publisher@example.test' | 'reviewer@example.test',
  role: 'PUBLISHER' | 'REVIEWER',
): Promise<string> {
  await page.getByLabel('受邀人邮箱').fill(email);
  await page.getByLabel('角色').selectOption(role);
  await page.getByRole('button', { name: '发送邀请' }).click();
  await expect(page.getByText('邀请已创建，等待对方接受。')).toBeVisible();
  const href = await page.getByRole('link', { name: `${email} 接受邀请链接` }).getAttribute('href');
  if (href === null) throw new Error('INVITATION_ACCEPTANCE_LINK_MISSING');
  return href;
}

async function acceptInvitation(page: Page, acceptanceHref: string, role: string): Promise<void> {
  await page.goto(`${webOrigin}${acceptanceHref}`);
  await page.getByRole('button', { name: '接受工作空间邀请' }).click();
  await expect(page.getByText(`当前角色：${role}`)).toBeVisible();
}

async function openChannels(page: Page, scope: ApprovedArtifactScope): Promise<void> {
  await page.goto(
    `${webOrigin}/app/channels?tenant=${scope.tenantId}&workspace=${scope.workspaceId}&artifact=${scope.artifactId}`,
  );
  await expect(page.getByRole('heading', { name: /渠道包 \/ 发布/ })).toBeVisible();
}

async function setWorkspaceBudget(
  page: Page,
  scope: ApprovedArtifactScope,
  limitUnits: number,
): Promise<void> {
  await page.goto(
    `${webOrigin}/app/jobs?tenant=${scope.tenantId}&workspace=${scope.workspaceId}&profile=${scope.artifactId}`,
  );
  await page.getByLabel('工作空间预算上限', { exact: true }).fill(String(limitUnits));
  await page.getByRole('button', { name: '保存工作空间预算', exact: true }).click();
  await expect(page.getByText('预算上限已更新')).toBeVisible();
}

async function buildPackage(
  page: Page,
  scope: ApprovedArtifactScope,
  channelDisplayName: string,
): Promise<void> {
  await page.getByLabel('Approved Artifact revision').selectOption(scope.artifactRevisionId);
  await selectRegistryEntry(page.getByLabel('Channel Registry'), channelDisplayName);
  await page.getByRole('button', { name: '生成渠道适配包' }).click();
  await expect(page.getByTestId('channel-package-checksum')).toHaveText(
    /^Package checksum：[a-f0-9]{64}$/,
  );
}

async function assertExactPackagePreviewAndExport(
  page: Page,
  scope: ApprovedArtifactScope,
): Promise<void> {
  const exportLink = page.getByRole('link', { name: '下载渠道适配包' });
  await expect(exportLink).toBeVisible();
  const href = await exportLink.getAttribute('href');
  if (href === null) throw new Error('CHANNEL_PACKAGE_EXPORT_LINK_MISSING');
  const exportUrl = new URL(href, webOrigin);
  expect(exportUrl.origin).toBe(apiOrigin);
  expect(exportUrl.pathname).toMatch(
    new RegExp(
      `^/api/v1/tenants/${scope.tenantId}/workspaces/${scope.workspaceId}/channel-packages/[0-9a-f-]+/export$`,
    ),
  );

  const exportResponse = await authenticatedApiGet(page, exportUrl.href);
  expect(exportResponse.status()).toBe(200);
  expect(exportResponse.headers()['content-type']).toContain(
    'application/vnd.aeostudio.channel-package+json',
  );
  const exportedJson = (await exportResponse.json()) as unknown;
  const exportedPackageId = exportUrl.pathname.split('/').at(-2);
  expect(exportedJson).toMatchObject({ id: exportedPackageId, packageRevision: 1 });
  const exported = ChannelPackageExportSchema.parse(exportedJson);
  expect(exported.artifact).toMatchObject({
    artifactId: scope.artifactId,
    artifactRevisionId: scope.artifactRevisionId,
    revision: scope.revision,
    contentHash: scope.contentHash,
  });

  await expect(page.getByTestId('channel-package-checksum')).toHaveText(
    `Package checksum：${exported.packageChecksum}`,
  );
  await expect(page.getByTestId('channel-package-exact-artifact')).toContainText(
    scope.artifactRevisionId,
  );
  await expect(page.getByTestId('channel-package-exact-artifact')).toContainText(
    `R${scope.revision}`,
  );
  await expect(page.getByTestId('channel-package-exact-artifact')).toContainText(scope.contentHash);

  const manifest = page.getByTestId('channel-package-manifest');
  await expect(manifest).toBeVisible();
  await expect(manifest).toContainText(`Schema version：${exported.manifest.schemaVersion}`);
  const fileRows = manifest.getByTestId('channel-package-manifest-file');
  await expect(fileRows).toHaveCount(exported.manifest.files.length);
  for (const file of exported.manifest.files) {
    const row = fileRows.filter({ hasText: file.path });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(file.mediaType);
    await expect(row).toContainText(file.sha256);
    await expect(row).toContainText(String(file.byteLength));
  }

  const assetRefs = page.getByTestId('channel-package-asset-refs');
  await expect(assetRefs).toBeVisible();
  if (exported.manifest.assetRefs.length === 0) {
    await expect(assetRefs).toContainText('none');
  } else {
    for (const assetRef of exported.manifest.assetRefs)
      await expect(assetRefs).toContainText(assetRef);
  }

  const claimSourceMap = page.getByTestId('channel-package-claim-source-map');
  await expect(claimSourceMap).toBeVisible();
  for (const claim of exported.manifest.claimSourceMap) {
    await expect(claimSourceMap).toContainText(claim.claimId);
    await expect(claimSourceMap).toContainText(claim.claimRevisionId);
    await expect(claimSourceMap).toContainText(claim.claimContentHash);
    for (const evidence of claim.evidence) {
      await expect(claimSourceMap).toContainText(evidence.sourceId);
      await expect(claimSourceMap).toContainText(evidence.snapshotId);
      await expect(claimSourceMap).toContainText(evidence.sourceHash);
    }
  }

  await expect(page.getByTestId('channel-package-markdown')).toBeVisible();
  await expect(page.getByTestId('channel-package-markdown')).toHaveText(
    exported.files['content.md'],
  );
  await expect(page.getByTestId('channel-package-html-source')).toBeVisible();
  await expect(page.getByTestId('channel-package-html-source')).toHaveText(
    exported.files['content.html'],
  );
  const jsonLdSource = page.getByTestId('channel-package-json-ld');
  await expect(jsonLdSource).toBeVisible();
  expect(JSON.parse((await jsonLdSource.textContent()) ?? '')).toEqual(
    JSON.parse(exported.files['structured-data.json']),
  );
  expect(JSON.stringify(exported)).not.toContain(sensitiveSecretArn);
}

test('an approved Artifact becomes an exact portable package with an honest export-only handoff', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await loginAs(page, 'owner@example.test');
  const scope = await createApprovedArtifact(
    page,
    'Portable Package Tenant',
    'Portable Package Workspace',
  );

  await openChannels(page, scope);
  const registry = page.getByTestId('channel-registry-entry');
  await expect(registry.filter({ hasText: 'Portable Web Export' })).toHaveCount(1);
  await buildPackage(page, scope, 'Portable Web Export');
  await assertExactPackagePreviewAndExport(page, scope);

  const eligibility = page.getByTestId('publication-eligibility');
  await expect(eligibility).toContainText('EXPORT_ONLY');
  await expect(eligibility).toContainText('ADAPTER_NOT_FOUND');
  await expect(page.getByRole('button', { name: '审核后发布' })).toHaveCount(0);
  await expect(page.getByTestId('publication-remote-ref')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('fake://remote/');
});

test('a profiled channel produces a reviewable adaptation package without faking publication', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await loginAs(page, 'owner@example.test');
  const scope = await createApprovedArtifact(
    page,
    'Profiled Handoff Tenant',
    'Profiled Handoff Workspace',
  );

  await openChannels(page, scope);
  const registryEntry = page
    .getByTestId('channel-registry-entry')
    .filter({ hasText: 'Social Channel Handoff' });
  await expect(registryEntry).toHaveCount(1);
  await expect(registryEntry.getByTestId('channel-profile-summary')).toContainText(
    'Required fields：post, disclosure',
  );

  await buildPackage(page, scope, 'Social Channel Handoff');
  const profile = page.getByTestId('channel-package-profile');
  await expect(profile).toContainText('Reviewed-before-publish Channel Profile');
  await expect(profile).toContainText('social-channel-handoff');
  await expect(profile).toContainText('Profile version：1.0.0');

  const exportLink = page.getByRole('link', { name: '审核后导出渠道适配包' });
  await expect(exportLink).toBeVisible();
  const href = await exportLink.getAttribute('href');
  if (href === null) throw new Error('PROFILED_PACKAGE_EXPORT_LINK_MISSING');
  const response = await authenticatedApiGet(page, href);
  expect(response.status()).toBe(200);
  const exported = ChannelPackageExportSchema.parse(await response.json());
  expect(exported.manifest.channelProfile).toMatchObject({
    channel: 'social-channel-handoff',
    profileVersion: '1.0.0',
  });
  expect(Object.keys(exported.files)).toContain('post.txt');
  expect(Object.keys(exported.files)).toContain('fields.json');
  expect(Object.keys(exported.files)).toContain('submission-checklist.md');
  expect(exported.files['post.txt']).toBeTruthy();
  expect(exported.files['fields.json']).toContain(scope.contentHash);
  expect(exported.files['submission-checklist.md']).toContain(
    'Review required before external publication',
  );

  const eligibility = page.getByTestId('publication-eligibility');
  await expect(eligibility).toContainText('EXPORT_ONLY');
  await expect(eligibility).toContainText('ADAPTER_NOT_FOUND');
  await expect(page.getByRole('link', { name: '审核后导出 / 人工交接' })).toBeVisible();
  await expect(page.getByRole('button', { name: '审核后发布' })).toHaveCount(0);
  await expect(page.getByTestId('publication-status')).toHaveCount(0);
});

test('an independent Publisher publishes once through the explicit fake Adapter after review', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ownerContext = await browser.newContext();
  const publisherContext = await browser.newContext();
  const reviewerContext = await browser.newContext();
  try {
    const ownerPage = await ownerContext.newPage();
    await loginAs(ownerPage, 'owner@example.test');
    const scope = await createApprovedArtifact(
      ownerPage,
      'Reviewed Publication Tenant',
      'Reviewed Publication Workspace',
    );

    await openChannels(ownerPage, scope);
    await buildPackage(ownerPage, scope, 'Reviewed Test Publisher');
    const requiredScopes = ownerPage.getByTestId('channel-adapter-required-scopes');
    const termsVersion = ownerPage.getByTestId('channel-adapter-terms-version');
    await expect(requiredScopes).toHaveText(/\S+/);
    await expect(termsVersion).toHaveText(/\S+/);
    await ownerPage.getByLabel('授权目标').fill(reviewedTarget);
    await ownerPage.getByLabel('AWS Secrets Manager ARN').fill(sensitiveSecretArn);
    await ownerPage.getByLabel('授权到期时间').fill('2099-12-31T23:59:59+08:00');
    await ownerPage.getByRole('button', { name: '保存 Channel 授权' }).click();
    await expect(ownerPage.getByText(/Channel 授权请求已保存，等待提供商验证/)).toBeVisible();
    await expect(ownerPage.locator('body')).not.toContainText(sensitiveSecretArn);
    await expect(ownerPage.getByRole('button', { name: '审核后发布' })).toBeVisible();

    const packageUrl = new URL(ownerPage.url());
    requiredParam(packageUrl, 'package');
    const authorizationsResponse = await authenticatedApiGet(
      ownerPage,
      `${apiOrigin}/api/v1/tenants/${scope.tenantId}/workspaces/${scope.workspaceId}/channel-authorizations`,
    );
    expect(authorizationsResponse.status()).toBe(200);
    const authorizationsText = await authorizationsResponse.text();
    expect(authorizationsText).not.toContain(sensitiveSecretArn);
    const authorizations = ChannelAuthorizationListEnvelopeSchema.parse(
      JSON.parse(authorizationsText),
    );
    expect(authorizations.data.authorizations).toContainEqual(
      expect.objectContaining({
        target: reviewedTarget,
        secretConfigured: true,
        validationStatus: 'VERIFIED',
        validationSnapshot: expect.objectContaining({
          validatedAt: expect.any(String),
          validUntil: expect.any(String),
        }),
      }),
    );
    expect(authorizationsText).not.toContain('credentialFingerprint');
    await expect(
      ownerPage
        .getByTestId('channel-authorization')
        .filter({ hasText: reviewedTarget })
        .getByTestId('channel-authorization-validation'),
    ).toContainText('VERIFIED');
    await setWorkspaceBudget(ownerPage, scope, 1);

    await ownerPage.goto(
      `${webOrigin}/app?tenant=${scope.tenantId}&workspace=${scope.workspaceId}`,
    );
    const publisherAcceptanceHref = await inviteAsOwner(
      ownerPage,
      'publisher@example.test',
      'PUBLISHER',
    );
    const reviewerAcceptanceHref = await inviteAsOwner(
      ownerPage,
      'reviewer@example.test',
      'REVIEWER',
    );

    const publisherPage = await publisherContext.newPage();
    await loginAs(publisherPage, 'publisher@example.test');
    await acceptInvitation(publisherPage, publisherAcceptanceHref, 'Publisher');
    await publisherPage.goto(`${webOrigin}${packageUrl.pathname}${packageUrl.search}`);
    await expect(publisherPage.getByTestId('publication-eligibility')).toContainText(
      'PUBLISH_READY',
    );
    const publishButton = publisherPage.getByRole('button', { name: '审核后发布' });
    await expect(publishButton).toBeVisible();
    const publicationIntentInput = publisherPage.locator('input[name="publicationIntentId"]');
    await expect(publicationIntentInput).toHaveValue(/^reviewed-publication-v1:[a-f0-9]{64}$/);
    const publicationIntentId = await publicationIntentInput.inputValue();
    await publishButton.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(publisherPage.getByTestId('publication-status')).toHaveText('BUDGET_BLOCKED', {
      timeout: 20_000,
    });

    const blockedUrl = new URL(publisherPage.url());
    const blockedPublicationId = requiredParam(blockedUrl, 'publication');
    await expect(publisherPage.getByTestId('publication-remote-ref')).toHaveCount(0);
    await expect(publisherPage.getByTestId('publication-attempt')).toHaveCount(0);
    await expect(publisherPage.getByRole('button', { name: '审核后发布' })).toHaveCount(0);
    const retryButton = publisherPage.getByRole('button', { name: '重新审阅并重试' });
    await expect(retryButton).toBeVisible();
    const retryIntentInput = publisherPage.locator('input[name="publicationIntentId"]');
    await expect(retryIntentInput).toHaveValue(/^reviewed-publication-retry-v1:[a-f0-9]{64}$/);
    const retryIntentId = await retryIntentInput.inputValue();

    const blockedDetailResponse = await authenticatedApiGet(
      publisherPage,
      `${apiOrigin}/api/v1/tenants/${scope.tenantId}/workspaces/${scope.workspaceId}/publications/${blockedPublicationId}`,
    );
    expect(blockedDetailResponse.status()).toBe(200);
    const blockedDetail = PublicationDetailEnvelopeSchema.parse(
      await blockedDetailResponse.json(),
    ).data;
    expect(blockedDetail.publication).toMatchObject({
      id: blockedPublicationId,
      status: 'BUDGET_BLOCKED',
      idempotencyKey: publicationIntentId,
      remoteRef: null,
    });
    expect(blockedDetail.attempts).toHaveLength(0);
    expect(blockedDetail.job.status).toBe('BUDGET_BLOCKED');

    await setWorkspaceBudget(ownerPage, scope, 100);
    await publisherPage.reload();
    await expect(publisherPage.locator('input[name="publicationIntentId"]')).toHaveValue(
      retryIntentId,
    );
    await publisherPage
      .getByRole('button', { name: '重新审阅并重试' })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await expect(publisherPage.getByTestId('publication-status')).toHaveText('PUBLISHED', {
      timeout: 20_000,
    });

    const publishedUrl = new URL(publisherPage.url());
    const publicationId = requiredParam(publishedUrl, 'publication');
    expect(publicationId).not.toBe(blockedPublicationId);
    await expect(publisherPage.getByTestId('publication-remote-ref')).toHaveText(
      `fake://remote/${publicationId}`,
    );
    const attempts = publisherPage.getByTestId('publication-attempt');
    await expect(attempts).toHaveCount(2);
    await expect(attempts.nth(0)).toContainText('PUBLISH');
    await expect(attempts.nth(0)).toContainText('AMBIGUOUS');
    await expect(attempts.nth(1)).toContainText('RECONCILE');
    await expect(attempts.nth(1)).toContainText('APPLIED');

    const detailResponse = await authenticatedApiGet(
      publisherPage,
      `${apiOrigin}/api/v1/tenants/${scope.tenantId}/workspaces/${scope.workspaceId}/publications/${publicationId}`,
    );
    expect(detailResponse.status()).toBe(200);
    const detailText = await detailResponse.text();
    expect(detailText).not.toContain(sensitiveSecretArn);
    const detail = PublicationDetailEnvelopeSchema.parse(JSON.parse(detailText)).data;
    expect(detail.publication).toMatchObject({
      id: publicationId,
      status: 'PUBLISHED',
      remoteRef: `fake://remote/${publicationId}`,
      artifactRevisionId: scope.artifactRevisionId,
      artifactContentHash: scope.contentHash,
      idempotencyKey: retryIntentId,
    });
    expect(detail.attempts.map(({ operation, outcome }) => ({ operation, outcome }))).toEqual([
      { operation: 'PUBLISH', outcome: 'AMBIGUOUS' },
      { operation: 'RECONCILE', outcome: 'APPLIED' },
    ]);
    expect(detail.job.status).toBe('SUCCEEDED');
    await expect(publisherPage.getByRole('button', { name: '审核后发布' })).toHaveCount(0);

    await publisherPage.goto(`${webOrigin}${packageUrl.pathname}${packageUrl.search}`);
    const repeatedIntentInput = publisherPage.locator('input[name="publicationIntentId"]');
    await expect(repeatedIntentInput).toHaveValue(publicationIntentId);
    await publisherPage.getByRole('button', { name: '审核后发布' }).click();
    await expect(publisherPage.getByTestId('publication-status')).toHaveText('BUDGET_BLOCKED');
    expect(requiredParam(new URL(publisherPage.url()), 'publication')).toBe(blockedPublicationId);
    await expect(publisherPage.locator('input[name="publicationIntentId"]')).toHaveValue(
      retryIntentId,
    );
    await publisherPage.getByRole('button', { name: '重新审阅并重试' }).click();
    await expect(publisherPage.getByTestId('publication-status')).toHaveText('PUBLISHED', {
      timeout: 20_000,
    });
    expect(requiredParam(new URL(publisherPage.url()), 'publication')).toBe(publicationId);
    await expect(publisherPage.getByTestId('publication-attempt')).toHaveCount(2);
    await expect(publisherPage.getByRole('button', { name: '审核后发布' })).toHaveCount(0);

    const reviewerPage = await reviewerContext.newPage();
    await loginAs(reviewerPage, 'reviewer@example.test');
    await acceptInvitation(reviewerPage, reviewerAcceptanceHref, 'Reviewer');
    await reviewerPage.goto(`${webOrigin}${publishedUrl.pathname}${publishedUrl.search}`);
    await expect(reviewerPage.getByTestId('publication-status')).toHaveText('PUBLISHED');
    await expect(reviewerPage.getByRole('button', { name: '审核后发布' })).toHaveCount(0);

    await ownerPage.goto(`${webOrigin}${packageUrl.pathname}${packageUrl.search}`);
    const authorizationRow = ownerPage
      .getByTestId('channel-authorization')
      .filter({ hasText: reviewedTarget });
    await expect(authorizationRow).toContainText('ACTIVE');
    await authorizationRow.getByRole('button', { name: '撤销授权' }).click();
    await expect(ownerPage.getByText('Channel 授权已撤销。')).toBeVisible();
    await expect(
      ownerPage.getByTestId('channel-authorization').filter({ hasText: reviewedTarget }),
    ).toContainText('REVOKED');
    await expect(ownerPage.getByTestId('publication-eligibility')).toContainText(
      'AUTHORIZATION_REVOKED',
    );

    for (const page of [ownerPage, publisherPage, reviewerPage]) {
      await expect(page.locator('body')).not.toContainText(sensitiveSecretArn);
    }
  } finally {
    await Promise.all([ownerContext.close(), publisherContext.close(), reviewerContext.close()]);
  }
});
