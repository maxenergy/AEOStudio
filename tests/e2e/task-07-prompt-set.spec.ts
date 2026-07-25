import { expect, test } from '@playwright/test';

test('an Analyst-facing lab proposes, approves and invalidates an exact Prompt Set revision', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('link', { name: '安全登录' }).click();
  await page.getByLabel('团队名称').fill('Prompt Research Cooperative');
  await page.getByLabel('工作空间名称').fill('Research Workspace');
  await page.getByRole('button', { name: '创建工作空间' }).click();

  await page.getByRole('link', { name: '问题集 / 场景实验室' }).click();
  await expect(page.getByRole('heading', { name: '问题集 / 场景实验室' })).toBeVisible();
  await page.getByLabel('问题集标题').fill('Guided service discovery');
  await page.getByLabel('研究主题').fill('Guided community learning service');
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
  await expect(page.getByTestId('prompt-status')).toHaveText('DRAFT');
  await expect(page.getByText(/Prompt hash：[a-f0-9]{64}/)).toBeVisible();
  await expect(page.getByText(/Scenario hash：[a-f0-9]{64}/)).toBeVisible();
  await expect(page.getByText('Consumer Surface：consumer-answer-sandbox')).toBeVisible();
  await page.getByRole('button', { name: '批准 exact Prompt / Scenario hash' }).click();
  await expect(page.getByTestId('prompt-status')).toHaveText('APPROVED');

  const editor = page.getByLabel('Prompt 编辑器');
  await editor.fill(`${await editor.inputValue()}\nWhat accessibility support is available?`);
  await page.getByRole('button', { name: '保存为新修订' }).click();
  await expect(page.getByText('Revision 2')).toBeVisible();
  await expect(page.getByTestId('prompt-status')).toHaveText('DRAFT');
  await expect(page.getByText('旧批准已失效')).toBeVisible();
});
