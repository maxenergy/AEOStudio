import { expect, test } from '@playwright/test';

test('an Owner budgets and watches Profile Readiness progress to a deterministic result', async ({
  page,
}) => {
  await page.goto('/app');
  await page.getByRole('link', { name: '安全登录' }).click();
  await page.getByLabel('Tenant 名称').fill('Open Horizon');
  await page.getByLabel('Workspace 名称').fill('Readiness Lab');
  await page.getByRole('button', { name: '创建 Workspace' }).click();

  await page.getByRole('link', { name: '开始业务资料 Onboarding' }).click();
  await page.getByLabel('公司或品牌名称').fill('Open Horizon Studio');
  await page.getByLabel('简介').fill('提供可验证的知识服务与开放式解决方案。');
  await page.getByLabel('网站').fill('https://open-horizon.example');
  await page.getByRole('button', { name: '保存 Profile' }).click();

  await page.getByLabel('Offering 类型').fill('knowledge-service');
  await page.getByLabel('Offering 名称').fill('知识准备度服务');
  await page.getByLabel('原理').fill('以结构化资料和证据覆盖度形成确定性评分。');
  await page.getByLabel('功能').fill('资料梳理');
  await page.getByLabel('使用方法').fill('提交资料并查看分析');
  await page.getByLabel('应用场景').fill('上线前内容检查');
  await page.getByLabel('兼容性').fill('网页与文档资料');
  await page.getByLabel('证据提示').fill('公开说明页');
  await page.getByLabel('自定义维度 Key').fill('delivery_mode');
  await page.getByLabel('自定义维度名称').fill('交付方式');
  await page.getByLabel('自定义维度值').fill('在线');
  await page.getByRole('button', { name: '保存 Offering' }).click();

  await page.getByRole('link', { name: '启动 Profile Readiness' }).click();
  await expect(page.getByRole('heading', { name: 'Profile Readiness' })).toBeVisible();
  await page.getByLabel('Workspace 预算上限', { exact: true }).fill('10');
  await page.getByRole('button', { name: '保存 Workspace 预算' }).click();
  await expect(page.getByRole('status')).toContainText('预算上限已更新');

  await page.getByRole('button', { name: '启动分析' }).click();
  await expect(page.getByText(/Job ID：/)).toBeVisible();
  await expect(page.getByTestId('owner-budget-alert')).toContainText('Tenant 预算已达到 80%');
  await expect(page.getByTestId('job-status')).toHaveText('QUEUED');
  await expect(page.getByTestId('job-status')).toHaveText('RUNNING');
  await expect(page.getByTestId('job-progress')).toContainText('50%');
  await expect(page.getByTestId('job-status')).toHaveText('SUCCEEDED');
  await expect(page.getByTestId('job-result')).toContainText('readinessPercent');
});
