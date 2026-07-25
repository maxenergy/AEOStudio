import { expect, test, type Page } from '@playwright/test';

const apiOrigin = 'http://127.0.0.1:3200';
const webOrigin = 'http://127.0.0.1:3100';

function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value.length === 0) throw new Error(`EXPECTED_${name.toUpperCase()}`);
  return value;
}

async function loginAs(page: Page, email: 'owner@example.test' | 'editor@example.test') {
  const hint = email === 'owner@example.test' ? '' : `?login_hint=${encodeURIComponent(email)}`;
  await page.goto(`${apiOrigin}/api/v1/auth/login${hint}`);
  await expect(page).toHaveURL(/\/app(?:\?|$)/u);
  await expect(page.getByText(email)).toBeVisible();
}

async function createApprovedScenario(page: Page): Promise<{
  promptUrl: string;
  tenantId: string;
  workspaceId: string;
}> {
  await page.goto('/app');
  await page.getByLabel('团队名称').fill('Measurement Evidence Tenant');
  await page.getByLabel('工作空间名称').fill('Measurement Evidence Workspace');
  await page.getByRole('button', { name: '创建工作空间' }).click();
  await page.getByRole('link', { name: '问题集 / 场景实验室' }).click();

  await page.getByLabel('问题集标题').fill('Evidence-backed discovery baseline');
  await page.getByLabel('研究主题').fill('Accessible professional learning service');
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
  await expect(page.getByTestId('prompt-count')).toHaveText('20');
  await page.getByRole('button', { name: '批准 exact Prompt / Scenario hash' }).click();
  await expect(page.getByTestId('prompt-status')).toHaveText('APPROVED');

  const promptUrl = new URL(page.url());
  return {
    promptUrl: promptUrl.href,
    tenantId: requiredParam(promptUrl, 'tenant'),
    workspaceId: requiredParam(promptUrl, 'workspace'),
  };
}

async function setBudgetAndInviteAnalyst(
  page: Page,
  scope: { tenantId: string; workspaceId: string },
): Promise<string> {
  await page.goto(
    `${webOrigin}/app/jobs?tenant=${scope.tenantId}&workspace=${scope.workspaceId}` +
      '&profile=00000000-0000-7000-8000-000000000711',
  );
  await page.getByLabel('工作空间预算上限', { exact: true }).fill('500');
  await page.getByRole('button', { name: '保存工作空间预算', exact: true }).click();
  await expect(page.getByText('预算上限已更新')).toBeVisible();

  await page.goto(`${webOrigin}/app?tenant=${scope.tenantId}&workspace=${scope.workspaceId}`);
  await page.getByLabel('受邀人邮箱').fill('editor@example.test');
  await page.getByLabel('角色').selectOption('ANALYST');
  await page.getByRole('button', { name: '发送邀请' }).click();
  const href = await page
    .getByRole('link', { name: 'editor@example.test 接受邀请链接' })
    .getAttribute('href');
  if (href === null) throw new Error('ANALYST_INVITATION_LINK_MISSING');
  return href;
}

test('an Analyst runs a reproducible baseline and drills through separated metrics to raw evidence', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const ownerContext = await browser.newContext();
  const analystContext = await browser.newContext();
  try {
    const ownerPage = await ownerContext.newPage();
    await loginAs(ownerPage, 'owner@example.test');
    const scope = await createApprovedScenario(ownerPage);
    const invitationHref = await setBudgetAndInviteAnalyst(ownerPage, scope);

    const analystPage = await analystContext.newPage();
    await loginAs(analystPage, 'editor@example.test');
    await analystPage.goto(`${webOrigin}${invitationHref}`);
    await analystPage.getByRole('button', { name: '接受工作空间邀请' }).click();
    await expect(analystPage.getByText('当前角色：Analyst')).toBeVisible();

    await analystPage.goto(scope.promptUrl);
    const startBaseline = analystPage.getByRole('button', {
      name: '启动 Measurement baseline',
    });
    await expect(
      startBaseline,
      'expected Analyst baseline action for the approved Prompt/Scenario revision',
    ).toBeVisible();
    await startBaseline.click();

    await expect(analystPage).toHaveURL(/\/app\/measurement\?/u, { timeout: 20_000 });
    await expect(analystPage.getByTestId('measurement-run-status')).toHaveText('COMPLETED', {
      timeout: 20_000,
    });
    await expect(analystPage.getByTestId('measurement-run-progress')).toHaveText(
      '60 / 60 PromptRuns',
    );
    await expect(analystPage.getByRole('heading', { name: 'Technical Health' })).toBeVisible();
    await expect(
      analystPage.getByText('此 Measurement Scenario 尚未绑定 owned-site technical baseline'),
    ).toBeVisible();
    await expect(
      analystPage.getByRole('link', { name: '查看 Site Technical Baseline' }),
    ).toBeVisible();
    await expect(
      analystPage.getByRole('heading', { name: 'Content & Evidence Readiness' }),
    ).toBeVisible();
    await expect(
      analystPage.getByText('此 Measurement Scenario 尚未绑定 exact Claim/Evidence set'),
    ).toBeVisible();
    await expect(
      analystPage.getByRole('heading', { name: 'Measured AI Visibility' }),
    ).toBeVisible();

    const measured = analystPage.getByTestId('measured-ai-visibility');
    await expect(measured).toContainText('Consumer Answer Sandbox');
    await expect(measured).toContainText('MANUAL_IMPORT');
    await expect(measured).toContainText('fixture-search-model · 2026-07');
    await expect(measured).toContainText('Eligible denominator');
    await expect(measured).toContainText('ERROR');
    await expect(measured).toContainText('NOT_CHECKED');
    await expect(measured).toContainText('INCONCLUSIVE');
    await expect(measured).toContainText('Cost');
    await expect(analystPage.getByText('不保证排名、引用或推荐')).toBeVisible();

    const claimLink = analystPage.getByRole('link', { name: '查看 Approved Claim / Evidence' });
    await expect(claimLink).toHaveAttribute('href', /\/app\/claims\?/u);

    const drillDowns = {
      Mention: 'MENTION_RATE',
      Citation: 'CITATION_RATE',
      Accuracy: 'ACCURACY_RATE',
      Coverage: 'COVERAGE_RATE',
      Cost: 'COST',
      Error: 'ERROR',
    } as const;
    for (const [drillDown, rawDimension] of Object.entries(drillDowns)) {
      const link = analystPage.getByRole('link', {
        name: `查看 ${drillDown} raw PromptRuns`,
      });
      await expect(
        link,
        `expected ${drillDown} drill-down to raw PromptRun evidence`,
      ).toBeVisible();
      await expect(link).toHaveAttribute('href', new RegExp(`raw=${rawDimension}.*cohort=`, 'u'));
    }

    const expectedDrillDowns = [
      ['Mention', 'MENTION_RATE', 'Mention observation', 60],
      ['Citation', 'CITATION_RATE', 'Citation observation', 60],
      ['Accuracy', 'ACCURACY_RATE', 'Accuracy observation', 60],
      ['Coverage', 'COVERAGE_RATE', 'Coverage observation', 60],
      ['Cost', 'COST', 'Cost', 60],
      ['Error', 'ERROR', 'Error status', 10],
    ] as const;
    for (const [label, dimension, rowLabel, expectedTotal] of expectedDrillDowns) {
      await analystPage.getByRole('link', { name: `查看 ${label} raw PromptRuns` }).click();
      await expect(
        analystPage.getByRole('heading', { name: 'Raw PromptRun evidence' }),
      ).toBeVisible();
      await expect(analystPage.getByTestId('raw-dimension')).toHaveText(dimension);
      await expect(analystPage.getByTestId('raw-result-total')).toHaveText(String(expectedTotal));
      const rows = analystPage.getByTestId('raw-prompt-run-row');
      await expect(rows.first()).toBeVisible();
      await expect(rows.first()).toContainText(rowLabel);
      if (dimension === 'ERROR') {
        await expect(rows).toHaveCount(10);
        const statuses = await rows.evaluateAll((entries) =>
          entries.map((entry) => entry.getAttribute('data-run-status')),
        );
        expect(new Set(statuses)).toEqual(new Set(['ERROR']));
      }
      await rows
        .first()
        .getByRole('link', { name: /查看此 PromptRun raw evidence/u })
        .click();
      await expect(analystPage).toHaveURL(new RegExp(`raw=${dimension}.*promptRun=`, 'u'));
      await expect(analystPage.getByTestId('prompt-run-evidence')).toHaveCount(1);
      await expect(analystPage.getByTestId('prompt-run-evidence')).toContainText('Raw response');
      await expect(analystPage.getByTestId('prompt-run-evidence')).toContainText('Citation');
      await expect(analystPage.getByTestId('prompt-run-evidence')).toContainText('Cost');
    }
  } finally {
    await Promise.all([ownerContext.close(), analystContext.close()]);
  }
});
