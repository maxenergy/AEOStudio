import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test';
import { ArtifactBundleEnvelopeSchema } from '@aeostudio/contracts/artifacts';
import { PublicationDetailEnvelopeSchema } from '@aeostudio/contracts/channels';
import { setupArtifactPrerequisites } from './helpers.js';

const apiOrigin = 'http://127.0.0.1:3200';
const webOrigin = 'http://127.0.0.1:3100';
const shopDomain = 'tenant-a.myshopify.com';
const adminApiVersion = '2026-07';
const remoteGid = 'gid://shopify/Page/1';
const adminUrl = `https://${shopDomain}/admin/pages/1`;
const productRemoteGid = 'gid://shopify/Product/1';
const productAdminUrl = `https://${shopDomain}/admin/products/1`;
const secretArn =
  'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:e2e/shopify-oauth-sensitive';

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

async function createApprovedArtifact(page: Page): Promise<ApprovedArtifactScope> {
  await page.goto('/app');
  await page.getByLabel('团队名称').fill('Shopify Draft Tenant');
  await page.getByLabel('工作空间名称').fill('Shopify Draft Workspace');
  await page.getByRole('button', { name: '创建工作空间' }).click();
  await expect(page.getByRole('heading', { name: 'Shopify Draft Workspace' })).toBeVisible();

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
  const response = await authenticatedApiGet(
    page,
    `${apiOrigin}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/artifacts/${artifactId}`,
  );
  expect(response.status()).toBe(200);
  const bundle = ArtifactBundleEnvelopeSchema.parse(await response.json()).data;
  if (bundle.revision === null) throw new Error('ARTIFACT_REVISION_MISSING');

  await page.getByRole('button', { name: '提交 exact revision/hash 审核' }).click();
  await page.getByLabel('Review note').fill('Approved exact revision for Shopify draft creation.');
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

async function openChannels(page: Page, scope: ApprovedArtifactScope): Promise<void> {
  await page.goto(
    `${webOrigin}/app/channels?tenant=${scope.tenantId}&workspace=${scope.workspaceId}&artifact=${scope.artifactId}`,
  );
  await expect(page.getByRole('heading', { name: /渠道包 \/ 发布/ })).toBeVisible();
}

async function buildShopifyPackage(page: Page, scope: ApprovedArtifactScope): Promise<string> {
  await page.getByLabel('Approved Artifact revision').selectOption(scope.artifactRevisionId);
  await selectRegistryEntry(page.getByLabel('Channel Registry'), 'Shopify Draft');
  await page.getByRole('button', { name: '生成渠道适配包' }).click();
  const checksum = page.getByTestId('channel-package-checksum');
  await expect(checksum).toHaveText(/^Package checksum：[a-f0-9]{64}$/);
  const packageChecksum = ((await checksum.textContent()) ?? '').match(/[a-f0-9]{64}/)?.[0];
  if (packageChecksum === undefined) throw new Error('PACKAGE_CHECKSUM_MISSING');
  return packageChecksum;
}

async function configureShopifyPageDraft(page: Page): Promise<void> {
  await page.getByLabel('Shopify Shop domain').fill(shopDomain);
  await page.getByLabel('Shopify OAuth secret ARN').fill(secretArn);
  await page.getByLabel('Shopify Admin API version').selectOption(adminApiVersion);

  const contentType = page.getByLabel('Shopify content type');
  for (const value of ['PAGE', 'BLOG_ARTICLE', 'PRODUCT']) {
    await expect(contentType.locator(`option[value="${value}"]`)).toHaveCount(1);
  }
  await contentType.selectOption('PAGE');

  const operation = page.getByLabel('Shopify draft operation');
  await expect(operation.locator('option[value="CREATE"]')).toHaveCount(1);
  await expect(operation.locator('option[value="UPDATE"]')).toHaveCount(1);
  await operation.selectOption('CREATE');
  await page.getByLabel('Shopify handle').fill('approved-answer-guide');
  await expect(page.getByLabel('Shopify blog GID')).toBeDisabled();
  await expect(page.getByLabel('Shopify remote GID')).toBeDisabled();

  await page.getByRole('button', { name: '保存 Shopify 授权与草稿目标' }).click();
  await expect(page.getByText(/Shopify 授权与草稿目标已保存，等待提供商验证/)).toBeVisible();
}

async function configureShopifyProductDraft(page: Page): Promise<void> {
  await page.getByLabel('Shopify Shop domain').fill(shopDomain);
  await page.getByLabel('Shopify OAuth secret ARN').fill(secretArn);
  await page.getByLabel('Shopify Admin API version').selectOption(adminApiVersion);
  await page.getByLabel('Shopify content type').selectOption('PRODUCT');
  await page.getByLabel('Shopify draft operation').selectOption('CREATE');
  await page.getByLabel('Shopify handle').fill('approved-product-guide');
  await expect(page.getByLabel('Shopify blog GID')).toBeDisabled();
  await expect(page.getByLabel('Shopify remote GID')).toBeDisabled();
  await page.getByRole('button', { name: '保存 Shopify 授权与草稿目标' }).click();
  await expect(page.getByText(/Shopify 授权与草稿目标已保存，等待提供商验证/)).toBeVisible();
}

async function setWorkspaceBudget(page: Page, scope: ApprovedArtifactScope): Promise<void> {
  await page.goto(
    `${webOrigin}/app/jobs?tenant=${scope.tenantId}&workspace=${scope.workspaceId}&profile=${scope.artifactId}`,
  );
  await page.getByLabel('工作空间预算上限', { exact: true }).fill('100');
  await page.getByRole('button', { name: '保存工作空间预算', exact: true }).click();
  await expect(page.getByText('预算上限已更新')).toBeVisible();
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

async function acceptInvitation(page: Page, href: string, role: string): Promise<void> {
  await page.goto(`${webOrigin}${href}`);
  await page.getByRole('button', { name: '接受工作空间邀请' }).click();
  await expect(page.getByText(`当前角色：${role}`)).toBeVisible();
}

test('an independent Publisher creates one reviewed Shopify PAGE without publishing it', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const ownerContext = await browser.newContext();
  const publisherContext = await browser.newContext();
  const reviewerContext = await browser.newContext();
  try {
    const ownerPage = await ownerContext.newPage();
    await loginAs(ownerPage, 'owner@example.test');
    const scope = await createApprovedArtifact(ownerPage);
    await openChannels(ownerPage, scope);
    await expect(
      ownerPage.getByTestId('channel-registry-entry').filter({ hasText: 'Shopify Draft' }),
    ).toHaveCount(1);
    const packageChecksum = await buildShopifyPackage(ownerPage, scope);
    await configureShopifyPageDraft(ownerPage);

    const mappedPreview = ownerPage.getByTestId('shopify-mapped-graphql-preview');
    await expect(mappedPreview).toContainText(`POST /admin/api/${adminApiVersion}/graphql.json`);
    await expect(mappedPreview).toContainText('mutation PageCreate');
    await expect(mappedPreview).toContainText('pageCreate');
    await expect(mappedPreview).toContainText('isPublished: false');
    await expect(mappedPreview).toContainText('contentType：PAGE');
    await expect(mappedPreview).toContainText('operation：CREATE');
    await expect(mappedPreview).toContainText('handle：approved-answer-guide');
    await expect(mappedPreview).toContainText(scope.artifactRevisionId);
    await expect(mappedPreview).toContainText(`R${scope.revision}`);
    await expect(mappedPreview).toContainText(scope.contentHash);
    await expect(mappedPreview).toContainText(packageChecksum);
    await expect(ownerPage.getByTestId('publication-eligibility')).toContainText('PUBLISH_READY');
    await expect(ownerPage.locator('body')).not.toContainText(secretArn);
    const packageUrl = new URL(ownerPage.url());
    requiredParam(packageUrl, 'target');

    await setWorkspaceBudget(ownerPage, scope);
    await ownerPage.goto(
      `${webOrigin}/app?tenant=${scope.tenantId}&workspace=${scope.workspaceId}`,
    );
    const publisherInvitation = await inviteAsOwner(
      ownerPage,
      'publisher@example.test',
      'PUBLISHER',
    );
    const reviewerInvitation = await inviteAsOwner(ownerPage, 'reviewer@example.test', 'REVIEWER');

    const publisherPage = await publisherContext.newPage();
    await loginAs(publisherPage, 'publisher@example.test');
    await acceptInvitation(publisherPage, publisherInvitation, 'Publisher');
    await publisherPage.goto(packageUrl.href);
    await expect(publisherPage.getByTestId('shopify-mapped-graphql-preview')).toBeVisible();
    const publishButton = publisherPage.getByRole('button', {
      name: '审核后创建 Shopify 草稿',
    });
    await expect(publishButton).toBeVisible();
    await publishButton.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });

    await expect(publisherPage.getByTestId('publication-status')).toHaveText('REMOTE_APPLIED', {
      timeout: 20_000,
    });
    await expect(publisherPage.getByTestId('publication-remote-status')).toHaveText('UNPUBLISHED');
    await expect(publisherPage.getByTestId('shopify-remote-gid')).toHaveText(remoteGid);
    await expect(publisherPage.getByTestId('publication-production-live')).toContainText(
      '尚未生产上线',
    );
    await expect(publisherPage.getByTestId('publication-rollback-available')).toContainText(
      '可删除 Shopify 未公开内容',
    );
    await expect(
      publisherPage.getByRole('link', { name: '打开 Shopify 后台草稿' }),
    ).toHaveAttribute('href', adminUrl);

    const publishedUrl = new URL(publisherPage.url());
    const publicationId = requiredParam(publishedUrl, 'publication');
    const attempts = publisherPage.getByTestId('publication-attempt');
    await expect(attempts).toHaveCount(2);
    await expect(attempts.nth(0)).toContainText('PUBLISH · AMBIGUOUS');
    await expect(attempts.nth(1)).toContainText('RECONCILE · APPLIED');

    const detailResponse = await authenticatedApiGet(
      publisherPage,
      `${apiOrigin}/api/v1/tenants/${scope.tenantId}/workspaces/${scope.workspaceId}/publications/${publicationId}`,
    );
    expect(detailResponse.status()).toBe(200);
    const detailText = await detailResponse.text();
    expect(detailText).not.toContain(secretArn);
    const detail = PublicationDetailEnvelopeSchema.parse(JSON.parse(detailText)).data;
    expect(detail.publication).toMatchObject({
      id: publicationId,
      packageChecksum,
      artifactRevisionId: scope.artifactRevisionId,
      artifactContentHash: scope.contentHash,
      status: 'REMOTE_APPLIED',
      remoteRef: adminUrl,
      remoteState: {
        status: 'UNPUBLISHED',
        number: null,
        isProductionLive: false,
        rollbackHandle: {
          operation: 'DELETE_UNPUBLISHED_CONTENT',
          shopDomain,
          contentType: 'PAGE',
          remoteGid,
        },
      },
    });

    await publisherPage.goto(packageUrl.href);
    await publisherPage.getByRole('button', { name: '审核后创建 Shopify 草稿' }).click();
    await expect(publisherPage.getByTestId('publication-status')).toHaveText('REMOTE_APPLIED', {
      timeout: 20_000,
    });
    expect(requiredParam(new URL(publisherPage.url()), 'publication')).toBe(publicationId);
    await expect(publisherPage.getByTestId('shopify-remote-gid')).toHaveText(remoteGid);

    const reviewerPage = await reviewerContext.newPage();
    await loginAs(reviewerPage, 'reviewer@example.test');
    await acceptInvitation(reviewerPage, reviewerInvitation, 'Reviewer');
    await reviewerPage.goto(publishedUrl.href);
    await expect(reviewerPage.getByTestId('publication-status')).toHaveText('REMOTE_APPLIED');
    await expect(reviewerPage.getByRole('button', { name: '审核后创建 Shopify 草稿' })).toHaveCount(
      0,
    );

    for (const page of [ownerPage, publisherPage, reviewerPage]) {
      await expect(page.locator('body')).not.toContainText(secretArn);
      await expect(page.locator('body')).not.toContainText('生产已上线');
    }
  } finally {
    await Promise.all([ownerContext.close(), publisherContext.close(), reviewerContext.close()]);
  }
});

test('a Shopify PRODUCT draft remains distinguishable from a WordPress draft', async ({ page }) => {
  test.setTimeout(90_000);
  await loginAs(page, 'owner@example.test');
  const scope = await createApprovedArtifact(page);
  await openChannels(page, scope);
  await buildShopifyPackage(page, scope);
  await configureShopifyProductDraft(page);

  const preview = page.getByTestId('shopify-mapped-graphql-preview');
  await expect(preview).toContainText('mutation ProductCreate');
  await expect(preview).toContainText('productCreate');
  await expect(preview).toContainText('status: DRAFT');
  await expect(page.getByTestId('publication-eligibility')).toContainText('PUBLISH_READY');
  const packageUrl = page.url();
  await setWorkspaceBudget(page, scope);
  await page.goto(packageUrl);
  await page.getByRole('button', { name: '审核后创建 Shopify 草稿' }).click();

  await expect(page.getByTestId('publication-status')).toHaveText('REMOTE_APPLIED', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('publication-remote-status')).toHaveText('DRAFT');
  await expect(page.getByTestId('shopify-remote-gid')).toHaveText(productRemoteGid);
  await expect(page.getByRole('link', { name: '打开 Shopify 后台草稿' })).toHaveAttribute(
    'href',
    productAdminUrl,
  );
  await expect(page.getByTestId('publication-production-live')).toContainText('Shopify 未公开内容');
  await expect(page.getByTestId('publication-rollback-available')).toContainText(
    '可删除 Shopify 未公开内容',
  );
  await expect(page.getByTestId('publication-remote-state')).not.toContainText('WordPress');
  await expect(page.locator('body')).not.toContainText(secretArn);
  await expect(page.locator('body')).not.toContainText('生产已上线');
});
