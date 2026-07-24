import { expect, test, type Page } from '@playwright/test';

const apiOrigin = 'http://127.0.0.1:3200';
const webOrigin = 'http://127.0.0.1:3100';

async function loginAs(page: Page, email?: 'editor@example.test' | 'reviewer@example.test') {
  const hint = email === undefined ? '' : `?login_hint=${encodeURIComponent(email)}`;
  await page.goto(`${apiOrigin}/api/v1/auth/login${hint}`);
  await expect(page).toHaveURL(/\/app(?:\?|$)/);
  await expect(page.getByText(email ?? 'owner@example.test')).toBeVisible();
}

async function inviteAsOwner(
  page: Page,
  email: 'editor@example.test' | 'reviewer@example.test',
  role: 'EDITOR' | 'REVIEWER',
): Promise<string> {
  await page.getByLabel('受邀人邮箱').fill(email);
  await page.getByLabel('角色').selectOption(role);
  await page.getByRole('button', { name: '发送邀请' }).click();
  await expect(page.getByText('邀请已创建，等待对方接受。')).toBeVisible();
  const href = await page.getByRole('link', { name: `${email} 接受邀请链接` }).getAttribute('href');
  if (href === null) throw new Error('INVITATION_ACCEPTANCE_LINK_MISSING');
  return href;
}

test('an Editor generates and revises while an independent Reviewer approves the exact deep-link', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const ownerContext = await browser.newContext();
  const editorContext = await browser.newContext();
  const reviewerContext = await browser.newContext();
  try {
    const ownerPage = await ownerContext.newPage();
    await loginAs(ownerPage);
    await ownerPage.getByLabel('Tenant 名称').fill('Role-separated Artifact Tenant');
    await ownerPage.getByLabel('Workspace 名称').fill('Role-separated Workspace');
    await ownerPage.getByRole('button', { name: '创建 Workspace' }).click();
    await expect(
      ownerPage.getByRole('heading', { name: 'Role-separated Workspace' }),
    ).toBeVisible();
    const artifactStudioHref = await ownerPage
      .getByRole('link', { name: 'Artifact Studio' })
      .getAttribute('href');
    if (artifactStudioHref === null) throw new Error('WORKSPACE_SCOPE_LINK_MISSING');
    const workspaceScope = new URL(artifactStudioHref, webOrigin);
    const tenantId = workspaceScope.searchParams.get('tenant');
    const workspaceId = workspaceScope.searchParams.get('workspace');
    if (tenantId === null || workspaceId === null) throw new Error('WORKSPACE_SCOPE_MISSING');

    const editorAcceptanceHref = await inviteAsOwner(ownerPage, 'editor@example.test', 'EDITOR');
    const reviewerAcceptanceHref = await inviteAsOwner(
      ownerPage,
      'reviewer@example.test',
      'REVIEWER',
    );
    await ownerPage.getByRole('link', { name: 'Artifact Studio' }).click();
    await ownerPage.getByRole('button', { name: '保存 Artifact 预算' }).click();

    const editorPage = await editorContext.newPage();
    await loginAs(editorPage, 'editor@example.test');
    await editorPage.goto(`${webOrigin}${editorAcceptanceHref}`);
    await editorPage.getByRole('button', { name: '接受 Workspace 邀请' }).click();
    await expect(editorPage.getByText('当前角色：Editor')).toBeVisible();
    await editorPage.goto(`${webOrigin}/app/artifacts?tenant=${tenantId}&workspace=${workspaceId}`);
    await expect(editorPage.getByRole('heading', { name: 'Artifact 预算' })).toHaveCount(0);
    await expect(editorPage.getByRole('button', { name: '生成 Artifact Draft' })).toBeVisible();
    await editorPage.getByRole('button', { name: '生成 Artifact Draft' }).click();
    await expect(editorPage.getByTestId('artifact-job-status')).toHaveText('SUCCEEDED', {
      timeout: 15_000,
    });
    const generatedUrl = new URL(editorPage.url());
    const artifactId = generatedUrl.searchParams.get('artifact');
    const jobId = generatedUrl.searchParams.get('job');
    if (artifactId === null || jobId === null) throw new Error('ARTIFACT_SCOPE_MISSING');
    await editorPage.getByRole('button', { name: '提交 exact revision/hash 审核' }).click();
    await expect(editorPage.getByRole('heading', { name: 'Exact-revision review' })).toHaveCount(0);

    const reviewerPage = await reviewerContext.newPage();
    await loginAs(reviewerPage, 'reviewer@example.test');
    await reviewerPage.goto(`${webOrigin}${reviewerAcceptanceHref}`);
    await reviewerPage.getByRole('button', { name: '接受 Workspace 邀请' }).click();
    await expect(reviewerPage.getByText('当前角色：Reviewer')).toBeVisible();
    await reviewerPage.goto(
      `${webOrigin}/app/artifacts?tenant=${tenantId}&workspace=${workspaceId}&artifact=${artifactId}`,
    );
    await expect(
      reviewerPage.getByRole('heading', { name: 'Exact-revision review' }),
    ).toBeVisible();
    await expect(reviewerPage.getByLabel('Summary（保存会创建新 revision）')).toHaveCount(0);
    await reviewerPage.getByLabel('Review note').fill('Independent Reviewer verified exact R1.');
    await reviewerPage.getByRole('button', { name: '批准 exact revision/hash' }).click();
    await expect(reviewerPage.getByText('Current approval：ELIGIBLE')).toBeVisible();

    await editorPage.goto(
      `${webOrigin}/app/artifacts?tenant=${tenantId}&workspace=${workspaceId}&artifact=${artifactId}&job=${jobId}`,
    );
    await expect(editorPage.getByText('Current approval：ELIGIBLE')).toBeVisible();
    const summary = editorPage.getByLabel('Summary（保存会创建新 revision）');
    const exactR1Summary = await summary.inputValue();
    await summary.fill(`${exactR1Summary}X`);
    await editorPage.getByRole('button', { name: '创建 immutable next revision' }).click();
    await expect(editorPage.getByText('Current approval：APPROVAL_STALE')).toBeVisible();
    await expect(editorPage.getByTestId('artifact-previous-summary')).toHaveText(exactR1Summary);
    await expect(editorPage.getByTestId('artifact-current-summary')).toHaveText(
      `${exactR1Summary}X`,
    );
  } finally {
    await Promise.all([ownerContext.close(), editorContext.close(), reviewerContext.close()]);
  }
});
