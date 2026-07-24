import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

interface Scope {
  tenantId: string;
  workspaceId: string;
}

function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value.length === 0) throw new Error(`ACCESSIBILITY_${name}_MISSING`);
  return value;
}

async function createSyntheticScope(page: Page): Promise<Scope> {
  await page.goto('/app');
  await page.getByRole('link', { name: '安全登录' }).click();
  await page.getByLabel('Tenant 名称').fill('Accessible Community Studio');
  await page.getByLabel('Workspace 名称').fill('Accessible Evidence Workspace');
  await page.getByRole('button', { name: '创建 Workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Accessible Evidence Workspace' })).toBeVisible();
  await expect(page).toHaveURL(/\/app\?tenant=[^&]+&workspace=[^&]+/u);
  const url = new URL(page.url());
  return { tenantId: requiredParam(url, 'tenant'), workspaceId: requiredParam(url, 'workspace') };
}

async function expectNoWcagViolations(page: Page, surface: string): Promise<void> {
  const scan = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const violations = scan.violations.map(({ id, impact, help, nodes }) => ({
    id,
    impact,
    help,
    targets: nodes.flatMap(({ target }) => target).slice(0, 5),
  }));
  expect(violations, `${surface} must have no WCAG 2.2 A/AA axe violations`).toEqual([]);
}

async function expectKeyboardFocus(page: Page, surface: string): Promise<void> {
  await page.locator('body').press('Home');
  await page.keyboard.press('Tab');
  const keyboardFocus = page.locator(':focus');
  await expect(
    keyboardFocus,
    `${surface}: keyboard navigation must move focus to an interactive control`,
  ).not.toHaveJSProperty('tagName', 'BODY');
  const focusStyle = await keyboardFocus.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focusStyle.outlineStyle, `${surface}: focus outline style`).not.toBe('none');
  expect(focusStyle.outlineWidth, `${surface}: focus outline width`).not.toBe('0px');
}

test('critical onboarding review publish and measurement surfaces pass axe and keyboard focus', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const scope = await createSyntheticScope(page);
  const query = `tenant=${scope.tenantId}&workspace=${scope.workspaceId}`;
  const surfaces = [
    { name: 'onboarding', path: `/app/onboarding?${query}` },
    { name: 'site baseline', path: `/app/sites?${query}` },
    { name: 'claim review', path: `/app/claims?${query}` },
    { name: 'prompt research', path: `/app/prompts?${query}` },
    { name: 'content plans', path: `/app/plans?${query}` },
    { name: 'artifacts review', path: `/app/artifacts?${query}` },
    { name: 'channels publish', path: `/app/channels?${query}` },
    { name: 'measurement dashboard', path: `/app/measurement?${query}` },
    { name: 'experiments', path: `/app/experiments?${query}` },
    { name: 'privacy and audit', path: `/app/privacy?${query}` },
  ];

  for (const surface of surfaces) {
    await page.goto(surface.path);
    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expectNoWcagViolations(page, surface.name);
    await expectKeyboardFocus(page, surface.name);
  }

  await page.goto(`/app?${query}`);
  await expectKeyboardFocus(page, 'workspace home');

  await page.goto(`/app/onboarding?${query}`);
  const requiredProfileName = page.getByLabel('公司或品牌名称');
  await page.getByRole('button', { name: '保存 Profile' }).click();
  await expect(
    requiredProfileName,
    'the first invalid field receives keyboard focus',
  ).toBeFocused();
  expect(
    await requiredProfileName.evaluate(
      (element) => (element as HTMLInputElement).validationMessage,
    ),
    'required-field failure must expose a browser accessibility error',
  ).not.toBe('');

  // Statuses remain text-labelled and color-independent; color is never the only signal.
  const labelledStatuses = page.locator('[role="status"]');
  for (let index = 0; index < (await labelledStatuses.count()); index += 1) {
    await expect(labelledStatuses.nth(index)).not.toHaveText(/^\s*$/u);
  }
});
