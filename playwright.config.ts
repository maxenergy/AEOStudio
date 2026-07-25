import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'corepack pnpm --filter @aeostudio/api dev',
      env: {
        NODE_ENV: 'test',
        AEOSTUDIO_ALLOW_FAKE_RUNTIME: 'true',
        AEOSTUDIO_AUTH_MODE: 'fake',
        AEOSTUDIO_CHANNEL_ADAPTER_MODE: 'fake',
        AEOSTUDIO_GIT_PROVIDER_MODE: 'fake',
        AEOSTUDIO_MEASUREMENT_PROVIDER_MODE: 'fake',
        AEOSTUDIO_SHOPIFY_PROVIDER_MODE: 'fake',
        AEOSTUDIO_WEBHOOK_PROVIDER_MODE: 'fake',
        AEOSTUDIO_WORDPRESS_PROVIDER_MODE: 'fake',
        OIDC_REDIRECT_URI: 'http://127.0.0.1:3200/api/v1/auth/callback',
        WEB_ORIGIN: 'http://127.0.0.1:3100',
      },
      port: 3200,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'corepack pnpm --filter @aeostudio/web dev',
      env: {
        API_INTERNAL_ORIGIN: 'http://127.0.0.1:3200',
        API_PUBLIC_ORIGIN: 'http://127.0.0.1:3200',
        WEB_ORIGIN: 'http://127.0.0.1:3100',
      },
      port: 3100,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
