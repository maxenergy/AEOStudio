import { expect, test } from '@playwright/test';

test('an Owner verifies a Site, crawls it and drills into the baseline', async ({ page }) => {
  await page.goto('/app');
  await page.getByRole('link', { name: '安全登录' }).click();
  await page.getByLabel('团队名称').fill('Baseline Cooperative');
  await page.getByLabel('工作空间名称').fill('Open Web Baseline');
  await page.getByRole('button', { name: '创建工作空间' }).click();

  await page.getByRole('link', { name: '开始业务资料 Onboarding' }).click();
  await page.getByLabel('公司或品牌名称').fill('Baseline Cooperative');
  await page.getByLabel('简介').fill('公开知识与资料服务。');
  await page.getByLabel('网站').fill('https://baseline.example.test');
  await page.getByRole('button', { name: '保存 Profile' }).click();
  await page.getByLabel('产品/服务类型').fill('documentation-service');
  await page.getByLabel('产品/服务名称').fill('公开资料服务');
  await page.getByLabel('原理').fill('以结构化公开资料支持用户检索。');
  await page.getByLabel('自定义维度 Key').fill('document_format');
  await page.getByLabel('自定义维度名称').fill('资料格式');
  await page.getByLabel('自定义维度值').fill('HTML');
  await page.getByRole('button', { name: '保存产品/服务' }).click();

  await page.getByRole('link', { name: '验证并抓取 Site' }).click();
  await expect(page.getByRole('heading', { name: 'Site Baseline' })).toBeVisible();
  await page.getByLabel('Site Origin').fill('https://baseline.example.test');
  await page.getByRole('button', { name: '登记 Site' }).click();
  await expect(page.getByText('/.well-known/aeostudio-verification')).toBeVisible();
  await expect(page.getByTestId('challenge-token')).not.toBeEmpty();

  await page.getByRole('button', { name: '验证所有权' }).click();
  await expect(page.getByTestId('site-status')).toHaveText('VERIFIED');
  await page.getByLabel('Crawl 预算上限').fill('100');
  await page.getByRole('button', { name: '保存 Crawl 预算' }).click();
  await page.getByRole('button', { name: '启动 Site Crawl' }).click();
  await expect(page.getByTestId('job-status')).toHaveText('QUEUED');
  await expect(page.getByTestId('job-status')).toHaveText('RUNNING');
  await expect(page.getByTestId('job-status')).toHaveText('SUCCEEDED');

  await expect(page.getByTestId('baseline-status')).toHaveText('COMPLETE');
  await expect(page.getByText(/Pages：1/)).toBeVisible();
  await expect(page.getByText(/Snapshot SHA-256/).first()).toBeVisible();
  await expect(page.getByText('HTTP_STATUS')).toBeVisible();
});
