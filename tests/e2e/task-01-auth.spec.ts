import { expect, test } from '@playwright/test';

test('an unauthenticated visitor is redirected from the application shell to login', async ({
  page,
}) => {
  await page.goto('/app');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
});

test('fake OIDC login enters the protected shell without exposing browser tokens', async ({
  context,
  page,
}) => {
  await page.goto('/app');
  await page.getByRole('link', { name: '安全登录' }).click();

  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('heading', { name: 'AEO Studio 工作台' })).toBeVisible();
  await expect(page.getByText('owner@example.test')).toBeVisible();

  const cookies = await context.cookies();
  const sessionCookie = cookies.find((cookie) => cookie.name === '__Host-aeo_session');
  expect(sessionCookie).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  });
  expect(cookies.some((cookie) => cookie.name === '__Host-aeo_login')).toBe(false);

  const storageKeys = await page.evaluate(() => Object.keys(window.localStorage));
  expect(storageKeys.filter((key) => /token|session|auth/i.test(key))).toEqual([]);
  await expect(page.getByText(/token|authorization code/i)).toHaveCount(0);
});
