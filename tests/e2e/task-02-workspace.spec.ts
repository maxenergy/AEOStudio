import { expect, test } from '@playwright/test';

test('an Owner creates, switches and invites from the Workspace shell', async ({ page }) => {
  await page.goto('/app');
  await page.getByRole('link', { name: '安全登录' }).click();

  await expect(page.getByRole('heading', { name: '工作空间尚未创建' })).toBeVisible();
  await page.getByLabel('团队名称').fill('通用品牌一');
  await page.getByLabel('工作空间名称').fill('市场一');
  await page.getByRole('button', { name: '创建工作空间' }).click();
  await expect(page.getByRole('heading', { name: '市场一' })).toBeVisible();
  await expect(page.getByText('当前角色：Owner')).toBeVisible();

  await page.getByLabel('团队名称').fill('通用品牌二');
  await page.getByLabel('工作空间名称').fill('市场二');
  await page.getByRole('button', { name: '创建工作空间' }).click();
  await expect(page.getByRole('heading', { name: '市场二' })).toBeVisible();

  await page.getByLabel('切换工作空间').selectOption({ label: '通用品牌一 / 市场一' });
  await expect(page.getByRole('heading', { name: '市场一' })).toBeVisible();

  await page.getByLabel('受邀人邮箱').fill('reviewer@example.test');
  await page.getByLabel('角色').selectOption('REVIEWER');
  await page.getByRole('button', { name: '发送邀请' }).click();
  await expect(page.getByText('邀请已创建，等待对方接受。')).toBeVisible();
});
