import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

const apiOrigin = 'http://127.0.0.1:3200';

test('a forged deletion receipt query cannot render a trusted acknowledgement', async ({
  page,
}) => {
  const forged = new URLSearchParams({
    request: '019b7653-cfb0-7000-8000-000000000001',
    scope: 'TENANT',
    state: 'FROZEN',
    requestedAt: '2026-07-22T05:00:00.000Z',
    activeDeleteBy: '2026-08-21T05:00:00.000Z',
    backupDeleteBy: '2026-10-20T05:00:00.000Z',
    secretForceDeleteBy: '2026-07-23T05:00:00.000Z',
  });

  await page.goto(`/privacy/deletion-receipt?${forged.toString()}`);

  await expect(page).toHaveURL(/\/login(?:\?|$)/u);
  await expect(page.getByRole('heading', { name: '删除请求已冻结访问' })).toHaveCount(0);
});

test('an Owner can export Tenant data and deletion immediately revokes the business session', async ({
  page,
}) => {
  await page.goto(`${apiOrigin}/api/v1/auth/login`);
  await expect(page).toHaveURL(/\/app(?:\?|$)/u);

  await page.getByLabel('团队名称').fill('Privacy RED Tenant');
  await page.getByLabel('工作空间名称').fill('Privacy RED Workspace');
  await page.getByRole('button', { name: '创建工作空间' }).click();
  await expect(page.getByRole('heading', { name: 'Privacy RED Workspace' })).toBeVisible();

  const scopeHref = await page.getByRole('link', { name: '内容稿件工作室' }).getAttribute('href');
  if (scopeHref === null) throw new Error('PRIVACY_SCOPE_LINK_MISSING');
  const scope = new URL(scopeHref, page.url());
  const tenantId = scope.searchParams.get('tenant');
  const workspaceId = scope.searchParams.get('workspace');
  if (tenantId === null || workspaceId === null) throw new Error('PRIVACY_SCOPE_MISSING');

  const privacyHref = `/app/privacy?tenant=${tenantId}&workspace=${workspaceId}`;
  await expect
    .soft(
      page.getByRole('link', { name: '隐私与审计' }),
      'expected scoped navigation to expose 隐私与审计',
    )
    .toHaveAttribute('href', privacyHref);

  await page.getByRole('link', { name: '开始业务资料 Onboarding' }).click();
  await page.getByLabel('公司或品牌名称').fill('Task 17 Export Brand');
  await page.getByLabel('简介').fill('A tenant-owned service used to verify complete exports.');
  await page.getByLabel('网站').fill('https://task-17-export.example.test');
  await page.getByLabel('Locale').fill('zh-CN');
  await page.getByLabel('Market').fill('TW');
  await page.getByRole('button', { name: '保存 Profile' }).click();
  await page.getByLabel('产品/服务类型').fill('tenant-defined-service');
  await page.getByLabel('产品/服务名称').fill('Task 17 Export Offering');
  await page.getByLabel('原理').fill('Tenant-defined operating principles.');
  await page.getByLabel('功能').fill('Feature A\nFeature B');
  await page.getByLabel('使用方法').fill('Step one\nStep two');
  await page.getByLabel('应用场景').fill('Tenant-defined use case');
  await page.getByLabel('兼容性').fill('Modern browsers');
  await page.getByLabel('证据提示').fill('Tenant-owned evidence record');
  await page.getByLabel('自定义维度 Key').fill('delivery_model');
  await page.getByLabel('自定义维度名称').fill('Delivery model');
  await page.getByLabel('自定义维度值').fill('Tenant-defined');
  await page.getByRole('button', { name: '保存产品/服务' }).click();
  await expect(page.getByText('Onboarding 已保存')).toBeVisible();

  await page.goto(privacyHref);
  await expect(
    page.getByRole('heading', { name: 'Privacy & Audit' }),
    'expected /app/privacy to render the Owner workbench',
  ).toBeVisible();

  await expect(page.getByText('删除请求后最多 30 天')).toBeVisible();
  await expect(page.getByText('删除请求后最多 90 天')).toBeVisible();
  await expect(page.getByText('立即撤销且不可读取，24 小时内强制删除')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Audit timeline' })).toBeVisible();

  const ownerGrantResponse = await page
    .context()
    .request.post(
      `${apiOrigin}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/privacy/break-glass`,
      {
        headers: { origin: 'http://127.0.0.1:3100' },
        data: {
          reason: 'A Tenant Owner must not impersonate a platform operator.',
          expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
          requestedAction: 'READ_SENSITIVE_EVIDENCE',
          resourceType: 'AUDIT_EVIDENCE',
          resourceId: 'object-version-17',
        },
      },
    );
  expect(ownerGrantResponse.status()).toBe(404);
  const ownerRevokeResponse = await page
    .context()
    .request.post(
      `${apiOrigin}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/privacy/` +
        'break-glass/019b7653-cfb0-7000-8000-000000000099/revoke',
      { headers: { origin: 'http://127.0.0.1:3100' } },
    );
  expect(ownerRevokeResponse.status()).toBe(404);

  const ownerEvaluateResponse = await page.goto(
    `${apiOrigin}/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/privacy/` +
      `break-glass/019b7653-cfb0-7000-8000-000000000099/evaluate?` +
      new URLSearchParams({
        requestedAction: 'READ_SENSITIVE_EVIDENCE',
        resourceType: 'AUDIT_EVIDENCE',
        resourceId: 'object-version-17',
      }).toString(),
  );
  expect(ownerEvaluateResponse?.status()).toBe(404);
  await page.goto(privacyHref);
  await expect(page.getByRole('heading', { name: 'Privacy & Audit' })).toBeVisible();
  await expect(page.getByRole('button', { name: '登记限时 break-glass' })).toHaveCount(0);

  await page.goto(
    `${privacyHref}&${new URLSearchParams({
      notice: 'export-request-returned',
      export: '019b7653-cfb0-7000-8000-000000000099',
      checksum: 'a'.repeat(64),
      objectRef: 's3://forged/object?versionId=forged',
      archiveStatus: 'READY',
    }).toString()}`,
  );
  await expect(page.getByText('Tenant-only export 已生成。')).toHaveCount(0);
  await expect(page.getByText('s3://forged/object?versionId=forged')).toHaveCount(0);
  await expect(page.getByTestId('tenant-export-checksum')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText(
    '导出请求已返回；是否可下载以服务端校验结果为准。',
  );
  await page.goto(privacyHref);

  const exportButton = page.getByRole('button', { name: '生成 Tenant export' });
  await expect(exportButton, 'expected the Tenant-only export action to be enabled').toBeEnabled();
  await exportButton.click();
  await expect(page.getByRole('status')).toContainText(
    '导出请求已返回；是否可下载以服务端校验结果为准。',
  );
  const downloadLink = page.getByRole('link', { name: '验证并下载 JSON bundle' });
  await expect(downloadLink).toBeVisible();
  const downloadHref = await downloadLink.getAttribute('href');
  if (downloadHref === null) throw new Error('PRIVACY_EXPORT_DOWNLOAD_HREF_MISSING');
  const downloadPromise = page.waitForEvent('download');
  await downloadLink.click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  if (downloadedPath === null) throw new Error('PRIVACY_EXPORT_DOWNLOAD_PATH_MISSING');
  const bundle = JSON.parse(await readFile(downloadedPath, 'utf8')) as {
    schemaVersion: string;
    manifest: { tenantId: string };
    files: Array<{
      content: {
        tenantId: string;
        workspaceId: string | null;
        kind: string;
        payload: unknown;
      };
    }>;
  };
  expect(bundle.schemaVersion).toBe('tenant-export-bundle.v1');
  expect(bundle.manifest.tenantId).toBe(tenantId);
  expect(bundle.files.every((file) => file.content.tenantId === tenantId)).toBe(true);
  expect(bundle.files.some((file) => file.content.kind === 'PROFILE_REVISION')).toBe(true);
  expect(bundle.files.some((file) => file.content.kind === 'OFFERING_REVISION')).toBe(true);
  expect(JSON.stringify(bundle)).toContain('Task 17 Export Brand');
  expect(JSON.stringify(bundle)).toContain('delivery_model');
  expect(JSON.stringify(bundle)).toContain('Tenant-defined');
  const exportObjectRef = new URL(page.url()).searchParams.get('objectRef');
  if (exportObjectRef === null) throw new Error('PRIVACY_EXPORT_OBJECT_REF_MISSING');
  const exportObject = new URL(exportObjectRef);
  const exportObjectVersion = exportObject.searchParams.get('versionId');
  if (exportObjectVersion === null) throw new Error('PRIVACY_EXPORT_VERSION_MISSING');
  const holdName = 'Task 17 exact export hold';
  await page.getByLabel('Legal Hold 名称').fill(holdName);
  await page.getByLabel('Legal Hold 理由').fill('Preserve this exact exported object version.');
  await page.getByLabel('Object key').fill(exportObject.pathname.slice(1));
  await page.getByLabel('Object version ID').fill(exportObjectVersion);
  await page.getByRole('button', { name: '保留这个确切对象版本' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Legal Hold 请求已返回；以下服务端列表是当前生效状态。',
  );
  await expect(page.getByText(holdName, { exact: true })).toBeVisible();

  await expect(page.getByTestId('audit-integrity-status')).toHaveText('VALID');
  const sealDigestButton = page.getByRole('button', { name: '封存 Audit digest' });
  await expect(sealDigestButton).toBeEnabled();
  await sealDigestButton.click();
  await expect(page.getByRole('status')).toContainText(
    'Audit digest 请求已返回；完整性状态以服务端重新读取结果为准。',
  );
  await expect(page.getByTestId('audit-integrity-status')).toHaveText('VALID');

  await page
    .getByLabel('删除原因', { exact: true })
    .fill('Task 17 deletion lifecycle browser acceptance.');
  await page.getByLabel('确认删除 Tenant').fill('DELETE TENANT');
  await page.getByRole('button', { name: '发起 Tenant 删除并冻结访问' }).click();

  await expect(page).toHaveURL(/\/privacy\/deletion-receipt$/u);
  await expect(page.getByRole('heading', { name: '删除请求已冻结访问' })).toBeVisible();
  await expect(page.getByTestId('active-delete-deadline')).not.toBeEmpty();
  await expect(page.getByTestId('backup-delete-deadline')).not.toBeEmpty();
  await expect(page.getByTestId('secret-delete-deadline')).not.toBeEmpty();

  await page.goto('/app');
  await expect(page).toHaveURL(/\/login(?:\?|$)/u);
  await expect
    .poll(async () =>
      (await page.context().cookies()).some(({ name }) => name === '__Host-aeo_session'),
    )
    .toBe(false);

  await page.goto(`${apiOrigin}/api/v1/auth/login`);
  await expect(page).toHaveURL(/\/app(?:\?|$)/u);
  await page.goto(privacyHref);
  await expect(page.getByRole('heading', { name: 'Privacy & Audit' })).toBeVisible();
  await expect(page.getByTestId('frozen-governance-mode')).toContainText('此 Tenant 已冻结');
  await expect(page.getByRole('heading', { name: 'Audit timeline' })).toBeVisible();
  await expect(page.getByText(holdName, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '生成 Tenant export' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '验证并下载 JSON bundle' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保留这个确切对象版本' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '封存 Audit digest' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发起 Tenant 删除并冻结访问' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发起 Workspace 删除并冻结访问' })).toHaveCount(0);

  const frozenDownload = await page.goto(downloadHref);
  expect(frozenDownload?.status()).toBe(404);

  await page.goto(scopeHref);
  await expect(page).toHaveURL(/\/app(?:\?|$)/u);
  await expect(page.getByRole('heading', { name: '内容稿件工作室' })).toHaveCount(0);

  await page.goto(privacyHref);
  const releaseHoldButton = page.getByRole('button', {
    name: `释放 Legal Hold：${holdName}`,
  });
  await expect(releaseHoldButton).toBeEnabled();
  await releaseHoldButton.click();
  await expect(
    page.getByText('Legal Hold 释放请求已返回；以下服务端列表是当前生效状态。'),
  ).toBeVisible();
  await expect(page.getByText(holdName)).toHaveCount(0);
});
