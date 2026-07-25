import { expect, type Page } from '@playwright/test';

const API_ORIGIN = 'http://127.0.0.1:3200';

/**
 * Shared e2e helpers to set up prerequisite resources via UI actions.
 * Each function assumes the user is already logged in and on the /app page
 * with a workspace created.
 */

/** Create a Profile and Offering via the Onboarding page. */
export async function createProfileAndOffering(page: Page): Promise<void> {
  await page.getByRole('link', { name: '开始业务资料 Onboarding' }).click();
  await expect(page.getByRole('heading', { name: '业务资料 Onboarding' })).toBeVisible();

  await page.getByLabel('公司或品牌名称').fill('Test Corp');
  await page.getByLabel('简介').fill('Test company for e2e setup.');
  await page.getByLabel('网站').fill('https://test.example');
  await page.getByRole('button', { name: '保存 Profile' }).click();

  await page.getByLabel('产品/服务类型').fill('test-service');
  await page.getByLabel('产品/服务名称').fill('Test Service');
  await page.getByLabel('原理').fill('Deterministic test principle.');
  await page.getByLabel('功能').fill('Feature A');
  await page.getByLabel('使用方法').fill('Run tests');
  await page.getByLabel('应用场景').fill('E2E validation');
  await page.getByLabel('兼容性').fill('Modern browsers');
  await page.getByLabel('证据提示').fill('Test reports');
  await page.getByRole('button', { name: '保存产品/服务' }).click();
}

/** Register a site, verify ownership, and run a crawl to create a baseline. */
export async function createSiteBaseline(page: Page): Promise<void> {
  // The "验证并抓取 Site" link is on the onboarding page after Profile+Offering
  await page.getByRole('link', { name: '验证并抓取 Site' }).click();
  await expect(page.getByRole('heading', { name: 'Site Baseline' })).toBeVisible();

  await page.getByLabel('Site Origin').fill('https://test.example');
  await page.getByRole('button', { name: '登记 Site' }).click();
  await page.getByRole('button', { name: '验证所有权' }).click();
  await expect(page.getByTestId('site-status')).toHaveText('VERIFIED');
  await page.getByLabel('Crawl 预算上限').fill('100');
  await page.getByRole('button', { name: '保存 Crawl 预算' }).click();
  await page.getByRole('button', { name: '启动 Site Crawl' }).click();
  await expect(page.getByTestId('job-status')).toHaveText('SUCCEEDED', { timeout: 15_000 });
  await expect(page.getByTestId('baseline-status')).toHaveText('COMPLETE');
}

/** Create and approve a Prompt Set via the Prompts page (sidebar link). */
export async function createApprovedPromptSet(page: Page): Promise<void> {
  await page.getByRole('link', { name: '问题集 / 场景实验室' }).click();
  await expect(page.getByRole('heading', { name: '问题集 / 场景实验室' })).toBeVisible();

  await page.getByLabel('问题集标题').fill('E2E Setup Prompts');
  await page.getByLabel('研究主题').fill('Test service discovery');
  await page.getByLabel('Profile revision ID').fill('00000000-0000-7000-8000-000000000711');
  await page.getByLabel('Offering revision ID').fill('00000000-0000-7000-8000-000000000712');
  await page.getByLabel('Market', { exact: true }).fill('SG');
  await page.getByLabel('Locale', { exact: true }).fill('en-SG');
  await page.getByLabel('Region', { exact: true }).fill('Singapore');
  await page.getByLabel('Model', { exact: true }).fill('fixture-search-model');
  await page.getByLabel('Model version').fill('2026-07');
  await page.getByLabel('Account').fill('workspace-fixture-account');
  await page.getByLabel('Repetitions').fill('3');
  await page.getByRole('button', { name: '生成 20 个确定性问题草稿' }).click();

  await expect(page.getByTestId('prompt-status')).toHaveText('DRAFT');
  await page.getByRole('button', { name: '批准 exact Prompt / Scenario hash' }).click();
  await expect(page.getByTestId('prompt-status')).toHaveText('APPROVED');
}

/**
 * Full setup: Profile + Offering + Baseline + PromptSet.
 * Order matters: site link is on onboarding page, prompts via sidebar.
 * After this, the Content Plan form will be visible.
 */
export async function setupPlanPrerequisites(page: Page): Promise<void> {
  await createProfileAndOffering(page);
  await createSiteBaseline(page);
  await createApprovedPromptSet(page);
}

/**
 * Start a Content Plan and approve the first Brief via an independent REVIEWER.
 * Assumes plan prerequisites are met (Profile + Offering + PromptSet + Baseline).
 *
 * Brief approval requires REVIEWER role (not OWNER), and the brief's creator
 * (the plan starter) cannot self-approve. This helper:
 * 1. Fills placeholder claim IDs so the plan generates Briefs
 * 2. Starts the Content Plan
 * 3. Invites a REVIEWER
 * 4. The reviewer accepts and approves the first Brief
 */
export async function createApprovedBrief(page: Page): Promise<void> {
  await page.getByRole('link', { name: '内容计划 / 创作摘要' }).click();
  await expect(page.getByRole('heading', { name: '内容计划 / 创作摘要' })).toBeVisible();

  // Save budget (OWNER role)
  await page.getByRole('button', { name: '保存计划预算' }).click();
  await expect(page.getByText('计划预算已保存')).toBeVisible();

  // Fill placeholder claim revision IDs so the plan generates Briefs
  // (without approved claims the textarea is empty and only Evidence Tasks are produced)
  await page
    .getByLabel('已批准的主要事实声明 revision IDs')
    .fill('00000000-0000-7000-8000-000000000701');

  // Start content plan
  await page.getByRole('button', { name: '启动内容计划' }).click();
  await expect(page.getByTestId('content-plan-job-status')).toHaveText('SUCCEEDED', {
    timeout: 15_000,
  });

  // Extract scope and plan/job IDs from the current URL
  const planUrl = new URL(page.url());
  const tenantId = planUrl.searchParams.get('tenant');
  const workspaceId = planUrl.searchParams.get('workspace');
  const planId = planUrl.searchParams.get('plan');
  const jobId = planUrl.searchParams.get('job');
  if (!tenantId || !workspaceId || !planId || !jobId) {
    throw new Error('EXPECTED_PLAN_SCOPE_IN_URL');
  }

  // Navigate to workspace shell to invite a REVIEWER (use a dedicated email to avoid
  // conflicts with tests that invite their own reviewer@example.test)
  await page.goto(`/app?tenant=${tenantId}&workspace=${workspaceId}`);
  await page.getByLabel('受邀人邮箱').fill('brief-reviewer@example.test');
  await page.getByLabel('角色').selectOption('REVIEWER');
  await page.getByRole('button', { name: '发送邀请' }).click();
  await expect(page.getByText('邀请已创建，等待对方接受。')).toBeVisible();

  // Get the acceptance link
  const acceptHref = await page
    .getByRole('link', { name: 'brief-reviewer@example.test 接受邀请链接' })
    .getAttribute('href');
  if (!acceptHref) throw new Error('INVITATION_ACCEPTANCE_LINK_MISSING');

  // Create a new browser context for the reviewer
  const browser = page.context().browser();
  if (!browser) throw new Error('BROWSER_NOT_AVAILABLE');
  const reviewerContext = await browser.newContext();
  try {
    const reviewerPage = await reviewerContext.newPage();

    // Login as brief-reviewer via fake auth
    await reviewerPage.goto(
      `${API_ORIGIN}/api/v1/auth/login?login_hint=${encodeURIComponent('brief-reviewer@example.test')}`,
    );
    await expect(reviewerPage).toHaveURL(/\/app(?:\?|$)/);

    // Accept the invitation
    await reviewerPage.goto(`http://127.0.0.1:3100${acceptHref}`);
    await reviewerPage.getByRole('button', { name: '接受工作空间邀请' }).click();
    await expect(reviewerPage.getByText('当前角色：Reviewer')).toBeVisible();

    // Navigate to the plans page with plan+job context
    await reviewerPage.goto(
      `/app/plans?tenant=${tenantId}&workspace=${workspaceId}&plan=${planId}&job=${jobId}`,
    );
    await expect(reviewerPage.getByRole('heading', { name: '内容计划 / 创作摘要' })).toBeVisible();

    // Approve the first brief
    await reviewerPage.getByLabel('Review note').first().fill('E2E reviewer approves.');
    await reviewerPage.getByRole('button', { name: '批准 exact Brief hash' }).first().click();
    await expect(reviewerPage.getByText(/审批状态：APPROVED/).first()).toBeVisible();
  } finally {
    await reviewerContext.close();
  }

  // Return owner page to workspace shell so callers can use the invitation form
  await page.goto(`/app?tenant=${tenantId}&workspace=${workspaceId}`);
}

/**
 * Full artifact prerequisites: Profile + Offering + Baseline + PromptSet + approved Brief.
 * After this, the 内容稿件工作室 "生成内容稿件草稿" button will be visible.
 */
export async function setupArtifactPrerequisites(page: Page): Promise<void> {
  await setupPlanPrerequisites(page);
  await createApprovedBrief(page);
}
