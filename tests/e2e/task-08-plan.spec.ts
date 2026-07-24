import { expect, test } from '@playwright/test';

test('an Editor sees explainable priorities, three Brief types and Evidence tasks', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('link', { name: '安全登录' }).click();
  await page.getByLabel('Tenant 名称').fill('Content Planning Cooperative');
  await page.getByLabel('Workspace 名称').fill('Planning Workspace');
  await page.getByRole('button', { name: '创建 Workspace' }).click();

  await page.getByRole('link', { name: 'Content Plan / Briefs' }).click();
  await expect(page.getByRole('heading', { name: 'Content Plan / Briefs' })).toBeVisible();
  await page.getByRole('button', { name: '保存计划预算' }).click();
  await expect(page.getByText('计划预算已保存')).toBeVisible();
  await page.getByRole('button', { name: '启动 Content Plan' }).click();
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
