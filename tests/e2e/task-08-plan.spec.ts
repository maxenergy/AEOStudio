import { expect, test } from '@playwright/test';

import { setupPlanPrerequisites } from './helpers.js';

test('an Editor sees explainable priorities, three Brief types and Evidence tasks', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('link', { name: '安全登录' }).click();
  await page.getByLabel('团队名称').fill('Content Planning Cooperative');
  await page.getByLabel('工作空间名称').fill('Planning Workspace');
  await page.getByRole('button', { name: '创建工作空间' }).click();

  // Set up prerequisites: Profile + Offering + Baseline + approved PromptSet
  await setupPlanPrerequisites(page);

  await page.getByRole('link', { name: '内容计划 / 创作摘要' }).click();
  await expect(page.getByRole('heading', { name: '内容计划 / 创作摘要' })).toBeVisible();
  await page.getByRole('button', { name: '保存计划预算' }).click();
  await expect(page.getByText('计划预算已保存')).toBeVisible();

  // Fill primary claim revision IDs so the plan generates Briefs (not just Evidence Tasks)
  await page
    .getByLabel('已批准的主要事实声明 revision IDs')
    .fill('00000000-0000-7000-8000-000000000701');

  await page.getByRole('button', { name: '启动内容计划' }).click();
  await expect(page.getByTestId('content-plan-job-status')).toHaveText('SUCCEEDED', {
    timeout: 15_000,
  });
  await expect(page.getByRole('heading', { name: 'Plan READY' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Explainable opportunities' })).toBeVisible();
  await expect(page.getByText(/Business value 90 · Evidence readiness 100/)).toBeVisible();
  await expect(page.getByText('Visibility gap：UNKNOWN').first()).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'DEFINITION_PRODUCT', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'COMPARISON', exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'TECHNICAL_EVIDENCE', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/审批状态：REVIEW_REQUIRED · Publish ready：false/).first(),
  ).toBeVisible();
});
