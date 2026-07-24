import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test';

const apiOrigin = 'http://127.0.0.1:3200';
const webOrigin = 'http://127.0.0.1:3100';

type Identity = 'owner@example.test' | 'editor@example.test' | 'reviewer@example.test';

async function authenticatedApiGet(page: Page, url: string): Promise<APIResponse> {
  const cookies = (await page.context().cookies()).filter(
    ({ name }) => name === '__Host-aeo_session',
  );
  const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  if (cookie.length === 0) throw new Error('AUTHENTICATED_API_COOKIE_MISSING');
  return page.request.get(url, { headers: { cookie } });
}

async function loginAs(page: Page, email: Identity): Promise<void> {
  const hint = email === 'owner@example.test' ? '' : `?login_hint=${encodeURIComponent(email)}`;
  await page.goto(`${apiOrigin}/api/v1/auth/login${hint}`);
  await expect(page).toHaveURL(/\/app(?:\?|$)/u);
}

async function selectRegistryEntry(select: Locator, displayName: string): Promise<void> {
  const option = select.locator('option').filter({ hasText: displayName });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute('value');
  if (value === null) throw new Error('MANUAL_IMPORT_REGISTRY_OPTION_MISSING');
  await select.selectOption(value);
}

async function invite(
  page: Page,
  email: 'editor@example.test' | 'reviewer@example.test',
  role: 'ANALYST' | 'REVIEWER',
): Promise<string> {
  await page.getByLabel('受邀人邮箱').fill(email);
  await page.getByLabel('角色').selectOption(role);
  await page.getByRole('button', { name: '发送邀请' }).click();
  const href = await page.getByRole('link', { name: `${email} 接受邀请链接` }).getAttribute('href');
  if (href === null) throw new Error('MANUAL_IMPORT_INVITATION_LINK_MISSING');
  return href;
}

test('an Analyst submits exact manual evidence and a Reviewer explicitly approves it', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const ownerContext = await browser.newContext();
  const analystContext = await browser.newContext();
  const reviewerContext = await browser.newContext();
  try {
    const ownerPage = await ownerContext.newPage();
    await loginAs(ownerPage, 'owner@example.test');
    await ownerPage.goto('/app');
    await ownerPage.getByLabel('Tenant 名称').fill('Reviewed Manual Import Tenant');
    await ownerPage.getByLabel('Workspace 名称').fill('Reviewed Manual Import Workspace');
    await ownerPage.getByRole('button', { name: '创建 Workspace' }).click();
    await ownerPage.getByRole('link', { name: 'Prompt / Scenario Lab' }).click();
    await ownerPage.getByLabel('Prompt Set 标题').fill('Reviewed answer-surface evidence');
    await ownerPage.getByLabel('研究主题').fill('Workspace-defined offering');
    await ownerPage.getByLabel('Profile revision ID').fill('00000000-0000-7000-8000-000000000711');
    await ownerPage.getByLabel('Offering revision ID').fill('00000000-0000-7000-8000-000000000712');
    await ownerPage.getByLabel('Market', { exact: true }).fill('SG');
    await ownerPage.getByLabel('Locale', { exact: true }).fill('en-SG');
    await ownerPage.getByLabel('Region', { exact: true }).fill('Singapore');
    await selectRegistryEntry(
      ownerPage.getByLabel('Provider / Consumer Surface'),
      'ChatGPT Search',
    );
    await ownerPage.getByLabel('Model', { exact: true }).fill('reviewed-manual-import');
    await ownerPage.getByLabel('Model version').fill('captured-2026-07-21');
    await ownerPage.getByLabel('Account').fill('reviewed-workspace-capture');
    await ownerPage.getByRole('button', { name: '生成 20 个确定性问题草稿' }).click();
    await ownerPage.getByRole('button', { name: '批准 exact Prompt / Scenario hash' }).click();
    await expect(ownerPage.getByTestId('prompt-status')).toHaveText('APPROVED');
    await expect(ownerPage.getByTestId('measurement-policy-status')).toHaveText('NOT ELIGIBLE');
    await expect(ownerPage.getByLabel('Adapter version')).toHaveValue('manual-import-v1');
    await expect(ownerPage.getByLabel('Provider terms version')).toHaveValue(
      'manual-import-terms-v1',
    );
    await ownerPage.getByLabel('Terms approved').check();
    await ownerPage.getByLabel('Authorization approved').check();
    await ownerPage.getByLabel('Cross-border approved').check();
    await ownerPage
      .getByLabel('Policy purpose')
      .fill('Reviewed workspace evidence measurement only.');
    await ownerPage.getByLabel('Policy version').fill('workspace-policy-v1');
    await ownerPage.getByRole('button', { name: '保存 Provider policy' }).click();
    await expect(ownerPage.getByTestId('measurement-policy-status')).toHaveText('ELIGIBLE');
    const promptUrl = ownerPage.url();

    const workspaceUrl = new URL(promptUrl);
    const tenantId = workspaceUrl.searchParams.get('tenant');
    const workspaceId = workspaceUrl.searchParams.get('workspace');
    if (tenantId === null || workspaceId === null) throw new Error('MANUAL_IMPORT_SCOPE_MISSING');
    await ownerPage.goto(
      `${webOrigin}/app/jobs?tenant=${tenantId}&workspace=${workspaceId}` +
        '&profile=00000000-0000-7000-8000-000000000711',
    );
    await ownerPage.getByLabel('Workspace 预算上限', { exact: true }).fill('500');
    await ownerPage.getByRole('button', { name: '保存 Workspace 预算', exact: true }).click();
    await expect(ownerPage.getByText('预算上限已更新')).toBeVisible();
    await ownerPage.goto(`${webOrigin}/app?tenant=${tenantId}&workspace=${workspaceId}`);
    const analystInvitation = await invite(ownerPage, 'editor@example.test', 'ANALYST');
    const reviewerInvitation = await invite(ownerPage, 'reviewer@example.test', 'REVIEWER');

    const analystPage = await analystContext.newPage();
    await loginAs(analystPage, 'editor@example.test');
    await analystPage.goto(`${webOrigin}${analystInvitation}`);
    await analystPage.getByRole('button', { name: '接受 Workspace 邀请' }).click();
    await analystPage.goto(promptUrl);
    await expect(analystPage.getByTestId('measurement-policy-status')).toHaveText('ELIGIBLE');
    await expect(analystPage.getByRole('button', { name: '保存 Provider policy' })).toHaveCount(0);
    await expect(
      analystPage.getByRole('button', { name: '提交 Manual import 待审核' }),
    ).toBeVisible();
    const entries = JSON.parse(
      await analystPage.getByLabel('Manual import entries JSON').inputValue(),
    ) as Array<{
      result: {
        rawEvidence: {
          responseText: string;
          citations: Array<{ url: string; title: string; snippet: string }>;
        };
      };
    }>;
    entries[0]!.result.rawEvidence.responseText = 'Reviewer-visible exact captured answer.';
    entries[0]!.result.rawEvidence.citations = [
      {
        url: 'https://sources.example.test/reviewer-visible',
        title: 'Reviewer-visible source',
        snippet: 'Exact citation evidence for review.',
      },
    ];
    await analystPage.getByLabel('Manual import entries JSON').fill(JSON.stringify(entries));
    await analystPage.getByRole('button', { name: '提交 Manual import 待审核' }).click();
    await expect(analystPage.getByTestId('manual-import-status')).toHaveText('SUBMITTED');
    await expect(
      analystPage.getByRole('button', { name: '启动 Measurement baseline' }),
    ).toHaveCount(0);
    const submittedUrl = analystPage.url();

    const reviewerPage = await reviewerContext.newPage();
    await loginAs(reviewerPage, 'reviewer@example.test');
    await reviewerPage.goto(`${webOrigin}${reviewerInvitation}`);
    await reviewerPage.getByRole('button', { name: '接受 Workspace 邀请' }).click();
    await reviewerPage.goto(submittedUrl);
    await expect(reviewerPage.getByTestId('measurement-policy-status')).toHaveText('ELIGIBLE');
    await expect(reviewerPage.getByRole('button', { name: '保存 Provider policy' })).toHaveCount(0);
    await expect(reviewerPage.getByTestId('manual-import-status')).toHaveText('SUBMITTED');
    await expect(reviewerPage.getByTestId('manual-import-exact-hash')).toHaveText(
      /^[a-f0-9]{64}$/u,
    );
    await expect(reviewerPage.getByTestId('manual-import-expected-count')).toHaveText('60');
    await expect(reviewerPage.getByTestId('manual-import-provided-count')).toHaveText('1');
    await expect(reviewerPage.getByTestId('manual-import-slot')).toHaveCount(60);
    const providedSlot = reviewerPage.locator(
      '[data-testid="manual-import-slot"][data-provided="true"]',
    );
    await expect(providedSlot).toHaveCount(1);
    await expect(providedSlot).toContainText('Prompt 1');
    await expect(providedSlot).toContainText('SG / en-SG / Singapore');
    await expect(providedSlot).toContainText('Repetition：1');
    await expect(providedSlot).toContainText('PASS');
    await expect(providedSlot).toContainText('Reviewer-visible exact captured answer.');
    await expect(providedSlot).toContainText('Reviewer-visible source');
    await expect(providedSlot).toContainText('https://sources.example.test/reviewer-visible');
    await expect(providedSlot).toContainText('Error：None');
    await expect(providedSlot).toContainText('0.000000 USD');
    await expect(providedSlot.getByTestId('manual-import-raw-hash')).toHaveText(/^[a-f0-9]{64}$/u);
    await expect(providedSlot.getByTestId('manual-import-slot-hash')).toHaveText(/^[a-f0-9]{64}$/u);
    await expect(
      reviewerPage.locator('[data-testid="manual-import-slot"][data-provided="false"]'),
    ).toHaveCount(59);
    await expect(
      reviewerPage.getByRole('button', { name: '审核并批准 Manual import' }),
    ).toBeVisible();
    await expect(
      reviewerPage.getByRole('button', { name: '审核并拒绝 Manual import' }),
    ).toBeVisible();
    await reviewerPage
      .getByLabel('审核备注')
      .fill('Verified the exact prompt, scope, repetition, answer, and citation evidence.');
    await reviewerPage.getByRole('button', { name: '审核并批准 Manual import' }).click();
    await expect(reviewerPage.getByTestId('manual-import-status')).toHaveText('APPROVED');

    await analystPage.goto(reviewerPage.url());
    await expect(analystPage.getByTestId('manual-import-status')).toHaveText('APPROVED');
    await expect(
      analystPage.getByRole('button', { name: '启动 Measurement baseline' }),
    ).toBeVisible();

    const baselineIdempotencyKey = await analystPage
      .locator('input[name="idempotencyKey"][data-purpose="measurement-baseline"]')
      .inputValue();
    expect(baselineIdempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(
      await analystPage
        .locator('input[name="idempotencyKey"][data-purpose="measurement-baseline"]')
        .inputValue(),
    ).toBe(baselineIdempotencyKey);
    await analystPage.getByRole('button', { name: '启动 Measurement baseline' }).click();
    await expect(analystPage).toHaveURL(/\/app\/measurement\?/u);
    const measurementUrl = new URL(analystPage.url());
    const measurementRunId = measurementUrl.searchParams.get('run');
    if (measurementRunId === null) throw new Error('MANUAL_IMPORT_MEASUREMENT_RUN_MISSING');
    const runResponse = await authenticatedApiGet(
      analystPage,
      `${apiOrigin}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/measurement-runs/${measurementRunId}`,
    );
    expect(runResponse.ok()).toBe(true);
    const run = (await runResponse.json()) as {
      data: { measurementRun: { jobId: string | null } };
    };
    const jobId = run.data.measurementRun.jobId;
    if (jobId === null) throw new Error('MANUAL_IMPORT_MEASUREMENT_JOB_MISSING');
    let jobStatus = 'QUEUED';
    for (let poll = 0; poll < 3; poll += 1) {
      const jobResponse = await authenticatedApiGet(
        analystPage,
        `${apiOrigin}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/jobs/${jobId}`,
      );
      expect(jobResponse.ok()).toBe(true);
      const job = (await jobResponse.json()) as {
        data: { job: { status: string; errorCode: string | null } };
      };
      jobStatus = job.data.job.status;
      expect(job.data.job.errorCode).toBeNull();
    }
    expect(jobStatus).toBe('SUCCEEDED');
    await analystPage.reload();
    await expect(analystPage.getByTestId('measurement-run-status')).toHaveText('COMPLETED', {
      timeout: 20_000,
    });
    await expect(analystPage.getByTestId('measurement-run-progress')).toHaveText(
      '60 / 60 PromptRuns',
    );
    const promptRunsResponse = await authenticatedApiGet(
      analystPage,
      `${apiOrigin}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/measurement-runs/${measurementRunId}/prompt-runs?limit=100`,
    );
    expect(promptRunsResponse.ok()).toBe(true);
    const promptRuns = (await promptRunsResponse.json()) as {
      data: { promptRuns: Array<{ id: string; status: string; policyReason: string | null }> };
    };
    expect(promptRuns.data.promptRuns).toHaveLength(60);
    expect(promptRuns.data.promptRuns.every((run) => run.policyReason === null)).toBe(true);
    const importedPass = promptRuns.data.promptRuns.find((run) => run.status === 'PASS');
    expect(importedPass).toBeDefined();
    const evidenceResponse = await authenticatedApiGet(
      analystPage,
      `${apiOrigin}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/measurement-runs/${measurementRunId}/prompt-runs/${importedPass?.id ?? ''}`,
    );
    expect(evidenceResponse.ok()).toBe(true);
    expect(await evidenceResponse.json()).toMatchObject({
      data: {
        rawEvidence: { responseText: 'Reviewer-visible exact captured answer.' },
      },
    });

    await analystPage.goto(reviewerPage.url());
    await analystPage.getByRole('button', { name: '提交 Manual import 待审核' }).click();
    await expect(analystPage.getByTestId('manual-import-status')).toHaveText('SUBMITTED');
    await reviewerPage.goto(analystPage.url());
    await reviewerPage
      .getByLabel('审核备注')
      .fill('Rejected after reviewing the exact immutable slot manifest.');
    await reviewerPage.getByRole('button', { name: '审核并拒绝 Manual import' }).click();
    await expect(reviewerPage.getByTestId('manual-import-status')).toHaveText('REJECTED');
    await analystPage.goto(reviewerPage.url());
    await expect(analystPage.getByTestId('manual-import-status')).toHaveText('REJECTED');
    await expect(
      analystPage.getByRole('button', { name: '启动 Measurement baseline' }),
    ).toHaveCount(0);
  } finally {
    await Promise.all([ownerContext.close(), analystContext.close(), reviewerContext.close()]);
  }
});
