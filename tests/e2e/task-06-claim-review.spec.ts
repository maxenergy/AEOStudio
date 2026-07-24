import { expect, test } from '@playwright/test';

test('an Editor-facing ledger submits an evidence-backed Claim for independent review', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByRole('link', { name: '安全登录' }).click();
  await page.getByLabel('Tenant 名称').fill('Evidence Review Cooperative');
  await page.getByLabel('Workspace 名称').fill('Review Workspace');
  await page.getByRole('button', { name: '创建 Workspace' }).click();

  await page.getByRole('link', { name: 'Evidence / Claim Ledger' }).click();
  await expect(page.getByRole('heading', { name: 'Evidence / Claim Ledger' })).toBeVisible();
  await page.getByLabel('Evidence 标题').fill('Evaluation methodology');
  await page.getByLabel('Evidence URI').fill('https://evidence.example.test/evaluation.txt');
  await page.getByLabel('License').fill('CC-BY-4.0');
  await page.getByLabel('Snapshot SHA-256').fill('f'.repeat(64));
  await page.getByLabel('对象引用').fill(`s3://evidence-fixture/${'f'.repeat(64)}`);
  await page.getByLabel('Claim statement').fill('Documented completion rate is 92 percent.');
  await page.getByLabel('数值').fill('92');
  await page.getByLabel('单位').fill('percent');
  await page.getByLabel('适用范围').fill('Evaluation protocol revision 3');
  await page.getByLabel('适用条件').fill('Sample size 120');
  await page.getByLabel('Expiry').fill('2030-01-01');
  await page
    .getByLabel('Exact evidence snippet')
    .fill('Completion rate: 92%; sample size: 120; protocol revision: 3.');
  await page.getByRole('button', { name: '创建并提交独立审核' }).click();

  await expect(page.getByTestId('claim-status')).toHaveText('IN_REVIEW');
  await expect(page.getByText('创建者不可自批')).toBeVisible();
  await expect(page.getByText(/Completion rate: 92%/)).toBeVisible();
  await expect(page.getByText(/CC-BY-4.0/)).toBeVisible();
  await expect(
    page.getByText(new RegExp(`^Snapshot/source hash：${'f'.repeat(64)}$`)),
  ).toBeVisible();
});
