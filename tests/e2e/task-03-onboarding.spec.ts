import { expect, test } from '@playwright/test';

test('an Editor-facing wizard saves an arbitrary service with a custom dimension', async ({
  page,
}) => {
  await page.goto('/app');
  await page.getByRole('link', { name: '安全登录' }).click();
  await page.getByLabel('团队名称').fill('Northstar Cooperative');
  await page.getByLabel('工作空间名称').fill('Learning Services');
  await page.getByRole('button', { name: '创建工作空间' }).click();

  await page.getByRole('link', { name: '开始业务资料 Onboarding' }).click();
  await expect(page.getByRole('heading', { name: '业务资料 Onboarding' })).toBeVisible();
  await expect(page.getByLabel('行业')).toHaveCount(0);

  await page.getByLabel('公司或品牌名称').fill('Northstar Learning Collective');
  await page.getByLabel('简介').fill('面向社区的语言辅导与文化交流服务。');
  await page.getByLabel('网站').fill('https://northstar.example');
  await page.getByLabel('Locale').fill('zh-CN');
  await page.getByLabel('Market').fill('CN');
  await page.getByRole('button', { name: '保存 Profile' }).click();

  await expect(page.getByRole('heading', { name: '描述产品/服务' })).toBeVisible();
  await page.getByLabel('产品/服务类型').fill('community-membership-service');
  await page.getByLabel('产品/服务名称').fill('社区语言会话会员服务');
  await page.getByLabel('原理').fill('通过小组引导练习与个别反馈建立会话信心。');
  await page.getByLabel('规格名称 1').fill('会话时长');
  await page.getByLabel('规格值 1').fill('60');
  await page.getByLabel('规格单位 1').fill('分钟');
  await page.getByLabel('功能').fill('引导师带领\n每周灵活主题');
  await page.getByLabel('使用方法').fill('选择小组\n参加每周会话');
  await page.getByLabel('应用场景').fill('新居民练习日常会话');
  await page.getByLabel('兼容性').fill('现代网页浏览器');
  await page.getByLabel('证据提示').fill('引导师出勤记录');
  await page.getByLabel('自定义维度 Key').fill('learning_format');
  await page.getByLabel('自定义维度名称').fill('学习形式');
  await page.getByLabel('自定义维度值').fill('线上小组');
  await page.getByRole('button', { name: '添加自定义维度' }).click();
  await page.getByLabel('自定义维度 Key 2').fill('sessions_per_week');
  await page.getByLabel('自定义维度名称 2').fill('每周场次');
  await page.getByLabel('自定义维度类型 2').selectOption('number');
  await page.getByLabel('自定义维度值 2').fill('3');
  await page.getByRole('button', { name: '保存产品/服务' }).click();

  await expect(page.getByText('Onboarding 已保存')).toBeVisible();
  await expect(page.getByText('社区语言会话会员服务')).toBeVisible();
  await expect(page.getByText('Revision 1')).toBeVisible();
  await expect(page.getByText('会话时长：60 分钟')).toBeVisible();
  await expect(page.getByText('学习形式：线上小组')).toBeVisible();
  await expect(page.getByText('每周场次：3')).toBeVisible();
  await expect(page.getByText(/完整度 \d+%/)).toBeVisible();

  const revisionOneHash = await page.getByText(/^内容哈希：/).textContent();
  await page.getByRole('link', { name: '编辑并创建新 Revision' }).click();
  await expect(page.getByRole('heading', { name: '编辑产品/服务' })).toBeVisible();
  await expect(page.getByLabel('规格值 1')).toHaveValue('60');
  await expect(page.getByLabel('自定义维度值 2')).toHaveValue('3');
  await page.getByLabel('产品/服务名称').fill('社区语言会话会员服务进阶版');
  await page.getByLabel('规格值 1').fill('75');
  await page.getByLabel('自定义维度值 2').fill('4');
  await page.getByRole('button', { name: '保存为新 Revision' }).click();

  await expect(page.getByText('Revision 2')).toBeVisible();
  await expect(page.getByText('社区语言会话会员服务进阶版')).toBeVisible();
  await expect(page.getByText('会话时长：75 分钟')).toBeVisible();
  await expect(page.getByText('每周场次：4')).toBeVisible();
  const revisionTwoHash = await page.getByText(/^内容哈希：/).textContent();
  expect(revisionTwoHash).not.toBe(revisionOneHash);

  await page.getByRole('link', { name: '查看 Revision 1' }).click();
  await expect(page.getByText('Revision 1')).toBeVisible();
  await expect(page.getByText('社区语言会话会员服务', { exact: true })).toBeVisible();
  await expect(page.getByText('会话时长：60 分钟')).toBeVisible();
  await expect(page.getByText('每周场次：3')).toBeVisible();
  await expect(page.getByText(/^内容哈希：/)).toHaveText(revisionOneHash ?? '');

  await page.goBack();
  await expect(page.getByText('Revision 2')).toBeVisible();
  await page.getByRole('link', { name: '编辑 Profile 并创建新 Revision' }).click();
  await expect(page.getByRole('heading', { name: '编辑 Profile' })).toBeVisible();
  const profileRevisionOneHash = (
    await page.getByText(/^当前 Profile 内容哈希：/).textContent()
  )?.replace('当前 Profile 内容哈希：', '');
  await expect(page.getByLabel('公司或品牌名称')).toHaveValue('Northstar Learning Collective');
  await page.getByLabel('公司或品牌名称').fill('Northstar Learning Collective 进阶');
  await page.getByRole('button', { name: '保存为新 Profile Revision' }).click();

  await expect(page.getByRole('heading', { name: 'Profile Revision 2' })).toBeVisible();
  await expect(page.getByText('Northstar Learning Collective 进阶')).toBeVisible();
  const profileRevisionTwoHash = (
    await page.getByText(/^Profile 内容哈希：/).textContent()
  )?.replace('Profile 内容哈希：', '');
  expect(profileRevisionTwoHash).not.toBe(profileRevisionOneHash);
  await expect(page.getByRole('link', { name: '返回 Offering Revision 2' })).toHaveAttribute(
    'href',
    /profileRevision=2/,
  );
  await page.getByRole('link', { name: '返回 Offering Revision 2' }).click();
  await expect(
    page.getByRole('link', { name: '使用此知识建立 Prompt / Scenario' }),
  ).toHaveAttribute('href', /profileRevision=2/);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Profile Revision 2' })).toBeVisible();

  await page.getByRole('link', { name: '查看 Profile Revision 1' }).click();
  await expect(page.getByRole('heading', { name: 'Profile Revision 1' })).toBeVisible();
  await expect(page.getByText('Northstar Learning Collective', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Profile 内容哈希：/)).toHaveText(
    `Profile 内容哈希：${profileRevisionOneHash ?? ''}`,
  );
});
