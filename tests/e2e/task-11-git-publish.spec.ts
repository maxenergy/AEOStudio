import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test';
import { ArtifactBundleEnvelopeSchema } from '@aeostudio/contracts/artifacts';
import { PublicationDetailEnvelopeSchema } from '@aeostudio/contracts/channels';
import { setupArtifactPrerequisites } from './helpers.js';

const apiOrigin = 'http://127.0.0.1:3200';
const webOrigin = 'http://127.0.0.1:3100';
const secretArn =
  'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:e2e/git-provider-sensitive';

type TestIdentity = 'owner@example.test' | 'publisher@example.test' | 'reviewer@example.test';

interface ApprovedArtifactScope {
  tenantId: string;
  workspaceId: string;
  artifactId: string;
  artifactRevisionId: string;
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
  const response = await authenticatedApiGet(
    page,
    `${apiOrigin}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/artifacts/${artifactId}`,
  );
  expect(response.status()).toBe(200);
  const bundle = ArtifactBundleEnvelopeSchema.parse(await response.json()).data;
  if (bundle.revision === null) throw new Error('ARTIFACT_REVISION_MISSING');

  await page.getByRole('button', { name: '提交 exact revision/hash 审核' }).click();
  await page.getByLabel('Review note').fill('Approved exact revision for Git PR publication.');
  await page.getByRole('button', { name: '批准 exact revision/hash' }).click();
  await expect(page.getByText('Current approval：ELIGIBLE')).toBeVisible();
  return {
    tenantId,
    workspaceId,
    artifactId,
    artifactRevisionId: bundle.revision.id,
  };
}

async function openChannels(page: Page, scope: ApprovedArtifactScope): Promise<void> {
  await page.goto(
    `${webOrigin}/app/channels?tenant=${scope.tenantId}&workspace=${scope.workspaceId}&artifact=${scope.artifactId}`,
  );
  await expect(page.getByRole('heading', { name: /渠道包 \/ 发布/ })).toBeVisible();
}

async function buildGitPackage(page: Page, scope: ApprovedArtifactScope): Promise<void> {
  await page.getByLabel('Approved Artifact revision').selectOption(scope.artifactRevisionId);
  await selectRegistryEntry(page.getByLabel('Channel Registry'), 'Git Pull Request');
  await page.getByRole('button', { name: '生成渠道适配包' }).click();
  await expect(page.getByTestId('channel-package-checksum')).toHaveText(
    /^Package checksum：[a-f0-9]{64}$/,
  );
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

async function configureGitTarget(
  page: Page,
  pathPrefix: string,
  baseBranch = 'main',
): Promise<void> {
  await page.getByLabel('Git installation ID').fill('installation-tenant-a');
  await page.getByLabel('Git repository').fill('tenant-owned/site-content');
  await page.getByLabel('Protected base branch').fill(baseBranch);
  await page.getByLabel('Authorized path prefix').fill(pathPrefix);
  await page.getByLabel('AWS Secrets Manager ARN').fill(secretArn);
  await page.getByRole('button', { name: '保存 Git 授权' }).click();
}

test('an independent Publisher opens one reviewed PR without treating it as production-live', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const ownerContext = await browser.newContext();
  const publisherContext = await browser.newContext();
  const reviewerContext = await browser.newContext();
  try {
    const ownerPage = await ownerContext.newPage();
    await loginAs(ownerPage, 'owner@example.test');
    const scope = await createApprovedArtifact(
      ownerPage,
      'Git Pull Request Tenant',
      'Git Pull Request Workspace',
    );
    await openChannels(ownerPage, scope);
    await expect(
      ownerPage.getByTestId('channel-registry-entry').filter({ hasText: 'Git Pull Request' }),
    ).toHaveCount(1);
    await buildGitPackage(ownerPage, scope);

    await configureGitTarget(ownerPage, '../outside');
    await expect(
      ownerPage.getByRole('alert').filter({ hasText: 'GIT_TARGET_INVALID' }),
    ).toBeVisible();
    await expect(ownerPage.getByRole('button', { name: '审核后创建 Pull Request' })).toHaveCount(0);

    await configureGitTarget(ownerPage, 'content/approved', 'release');
    await expect(ownerPage.getByText(/Git 授权请求已保存，等待提供商验证/)).toBeVisible();
    await expect(ownerPage.locator('body')).not.toContainText(secretArn);
    await expect(ownerPage.getByTestId('publication-eligibility')).toContainText('PUBLISH_READY');
    const branchConflictUrl = new URL(ownerPage.url());

    await setWorkspaceBudget(ownerPage, scope, 100);
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
    await publisherPage.goto(branchConflictUrl.href);
    await publisherPage.getByRole('button', { name: '审核后创建 Pull Request' }).click();
    await expect(publisherPage.getByTestId('publication-status')).toHaveText('FAILED_TERMINAL', {
      timeout: 20_000,
    });
    await expect(publisherPage.getByTestId('publication-recovery-guidance')).toContainText(
      'branch policy 冲突',
    );
    await expect(publisherPage.getByTestId('publication-recovery-guidance')).toContainText(
      '可安全重试',
    );

    await ownerPage.goto(branchConflictUrl.href);
    await configureGitTarget(ownerPage, 'content/approved');
    await expect(ownerPage.getByText(/Git 授权请求已保存，等待提供商验证/)).toBeVisible();
    const plannedDiff = ownerPage.getByTestId('git-planned-diff');
    await expect(plannedDiff).toContainText('tenant-owned/site-content');
    await expect(plannedDiff).toContainText('main');
    await expect(plannedDiff).toContainText('content/approved/content.md');
    await expect(plannedDiff.getByTestId('git-planned-file')).toHaveCount(3);
    await expect(ownerPage.getByTestId('publication-eligibility')).toContainText('PUBLISH_READY');
    const packageUrl = new URL(ownerPage.url());
    requiredParam(packageUrl, 'target');
    await publisherPage.goto(packageUrl.href);
    await expect(publisherPage.getByTestId('git-planned-diff')).toBeVisible();
    const publishButton = publisherPage.getByRole('button', {
      name: '审核后创建 Pull Request',
    });
    await expect(publishButton).toBeVisible();
    await publishButton.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });

    await expect(publisherPage.getByTestId('publication-status')).toHaveText('REMOTE_APPLIED', {
      timeout: 20_000,
    });
    await expect(publisherPage.getByTestId('publication-remote-status')).toHaveText('PR_OPENED');
    await expect(publisherPage.getByTestId('publication-pr-number')).toHaveText('1');
    await expect(publisherPage.getByTestId('publication-production-live')).toContainText(
      '尚未生产上线',
    );
    await expect(publisherPage.getByTestId('publication-rollback-available')).toContainText(
      '可关闭 Pull Request',
    );
    const pullRequestLink = publisherPage.getByRole('link', { name: '打开 Pull Request' });
    await expect(pullRequestLink).toHaveAttribute(
      'href',
      'https://git.example.test/tenant-owned/site-content/pull/1',
    );
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
      status: 'REMOTE_APPLIED',
      remoteRef: 'https://git.example.test/tenant-owned/site-content/pull/1',
      remoteState: {
        status: 'PR_OPENED',
        number: 1,
        isProductionLive: false,
        rollbackHandle: {
          operation: 'CLOSE_PULL_REQUEST',
          repository: 'tenant-owned/site-content',
          pullRequestNumber: 1,
        },
      },
    });

    await publisherPage.goto(packageUrl.href);
    await publisherPage.getByRole('button', { name: '审核后创建 Pull Request' }).click();
    await expect(publisherPage.getByTestId('publication-status')).toHaveText('REMOTE_APPLIED', {
      timeout: 20_000,
    });
    expect(requiredParam(new URL(publisherPage.url()), 'publication')).toBe(publicationId);
    await expect(publisherPage.getByTestId('publication-pr-number')).toHaveText('1');

    await ownerPage.goto(packageUrl.href);
    const revokeButtons = ownerPage.getByRole('button', { name: '撤销授权' });
    await expect(revokeButtons.first()).toBeVisible({ timeout: 10_000 });
    const priorAuthorizationCount = await revokeButtons.count();
    for (let index = 0; index < priorAuthorizationCount; index += 1) {
      await revokeButtons.first().click();
      await expect(ownerPage.getByText('Channel 授权已撤销。')).toBeVisible();
    }
    await expect(revokeButtons).toHaveCount(0);
    await configureGitTarget(ownerPage, 'content/approved');
    await expect(ownerPage.getByText(/Git 授权请求已保存，等待提供商验证/)).toBeVisible();

    const refreshStatusButton = publisherPage.getByRole('button', {
      name: '刷新 Pull Request 状态',
    });
    await expect(refreshStatusButton).toBeVisible();
    await refreshStatusButton.click();
    await expect(
      publisherPage.getByText('Pull Request 状态已从 Provider 重新确认。'),
    ).toBeVisible();
    await expect(publisherPage.getByTestId('publication-remote-status')).toHaveText('PR_OPENED');
    await expect(publisherPage.getByTestId('publication-pr-number')).toHaveText('1');
    await expect(publisherPage.getByTestId('publication-production-live')).toContainText(
      '尚未生产上线',
    );
    await expect(publisherPage.getByTestId('publication-rollback-available')).toContainText(
      '可关闭 Pull Request',
    );

    const refreshedDetailResponse = await authenticatedApiGet(
      publisherPage,
      `${apiOrigin}/api/v1/tenants/${scope.tenantId}/workspaces/${scope.workspaceId}/publications/${publicationId}`,
    );
    expect(refreshedDetailResponse.status()).toBe(200);
    const refreshedDetailText = await refreshedDetailResponse.text();
    expect(refreshedDetailText).not.toContain(secretArn);
    expect(
      PublicationDetailEnvelopeSchema.parse(JSON.parse(refreshedDetailText)).data.publication,
    ).toMatchObject({
      id: publicationId,
      status: 'REMOTE_APPLIED',
      remoteRef: 'https://git.example.test/tenant-owned/site-content/pull/1',
      remoteState: {
        status: 'PR_OPENED',
        number: 1,
        isProductionLive: false,
        rollbackHandle: {
          operation: 'CLOSE_PULL_REQUEST',
          repository: 'tenant-owned/site-content',
          pullRequestNumber: 1,
        },
      },
    });

    const reviewerPage = await reviewerContext.newPage();
    await loginAs(reviewerPage, 'reviewer@example.test');
    await acceptInvitation(reviewerPage, reviewerInvitation, 'Reviewer');
    await reviewerPage.goto(publishedUrl.href);
    await expect(reviewerPage.getByTestId('publication-status')).toHaveText('REMOTE_APPLIED');
    await expect(reviewerPage.getByRole('button', { name: '审核后创建 Pull Request' })).toHaveCount(
      0,
    );
    await expect(reviewerPage.getByRole('button', { name: '刷新 Pull Request 状态' })).toHaveCount(
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
