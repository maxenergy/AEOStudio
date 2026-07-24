import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { chromium, type Browser, type Route } from '@playwright/test';
import { describe, expect, test } from 'vitest';

import { completeSyntheticCognitoLogin, generateTotp } from '../../scripts/smoke/cognito-login.mjs';
import { runStagingSmoke } from '../../scripts/smoke/staging-smoke-runner.mjs';
import {
  createStagingSyntheticHappyPathFixture,
  stagingSyntheticIds,
  stagingSyntheticSmokeConfig,
} from './fixtures/staging-synthetic-happy-path.js';

const repositoryRoot = process.cwd();

describe('Task 18 staging smoke login', () => {
  test('generates the current Cognito software-token MFA code without logging or persisting its seed', () => {
    expect(
      generateTotp({
        secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        now: new Date('1970-01-01T00:00:59.000Z'),
      }),
    ).toBe('287082');
  });

  test('completes the application Cognito authorization-code PKCE callback and keeps its session cookie inside the browser', async () => {
    const stagingOrigin = 'https://staging.example.test';
    const cognitoOrigin = 'https://auth.staging.example.test';
    const username = 'synthetic-operator@example.test';
    const password = 'correct horse battery staple';
    const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const now = new Date('1970-01-01T00:00:59.000Z');
    const callbackUrl = `${stagingOrigin}/api/v1/auth/callback?code=synthetic-code&state=synthetic-state`;
    let browser: Browser | undefined;
    let observedPkce = false;
    let observedPassword = false;
    let observedTotp = false;
    let observedAuthenticatedMutation = false;

    const authenticated = await completeSyntheticCognitoLogin(
      { stagingOrigin, cognitoOrigin, username, password, totpSecret },
      {
        now: () => now,
        launchBrowser: async () => {
          browser = await chromium.launch({ headless: true });
          return {
            close: () => browser?.close(),
            newContext: async (options: Record<string, unknown>) => {
              if (browser === undefined) throw new Error('TEST_BROWSER_MISSING');
              const context = await browser.newContext(options);
              await context.route('**/*', async (route: Route) => {
                const request = route.request();
                const url = new URL(request.url());

                if (url.origin === stagingOrigin && url.pathname === '/api/v1/auth/login') {
                  const authorization = new URL('/oauth2/authorize', cognitoOrigin);
                  authorization.searchParams.set('response_type', 'code');
                  authorization.searchParams.set(
                    'code_challenge',
                    'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDEFG',
                  );
                  authorization.searchParams.set('code_challenge_method', 'S256');
                  authorization.searchParams.set('nonce', 'synthetic-nonce');
                  authorization.searchParams.set('state', 'synthetic-state');
                  authorization.searchParams.set(
                    'redirect_uri',
                    `${stagingOrigin}/api/v1/auth/callback`,
                  );
                  await route.fulfill({
                    contentType: 'text/html',
                    body: `<script>window.location.replace(${JSON.stringify(authorization.toString())})</script>`,
                  });
                  return;
                }

                if (
                  url.origin === cognitoOrigin &&
                  url.pathname === '/oauth2/authorize' &&
                  request.method() === 'GET'
                ) {
                  observedPkce =
                    url.searchParams.get('response_type') === 'code' &&
                    url.searchParams.get('code_challenge_method') === 'S256' &&
                    url.searchParams.get('redirect_uri') ===
                      `${stagingOrigin}/api/v1/auth/callback`;
                  await route.fulfill({
                    contentType: 'text/html',
                    body: [
                      '<form method="post" action="/login">',
                      '<input name="username" autocomplete="username">',
                      '<input name="password" type="password" autocomplete="current-password">',
                      '<button type="submit">Sign in</button>',
                      '</form>',
                    ].join(''),
                  });
                  return;
                }

                if (
                  url.origin === cognitoOrigin &&
                  url.pathname === '/login' &&
                  request.method() === 'POST'
                ) {
                  const form = new URLSearchParams(request.postData() ?? '');
                  observedPassword =
                    form.get('username') === username && form.get('password') === password;
                  await route.fulfill({
                    contentType: 'text/html',
                    body: [
                      '<form method="post" action="/mfa">',
                      '<input name="totp_code" autocomplete="one-time-code" inputmode="numeric">',
                      '<button type="submit">Verify</button>',
                      '</form>',
                    ].join(''),
                  });
                  return;
                }

                if (
                  url.origin === cognitoOrigin &&
                  url.pathname === '/mfa' &&
                  request.method() === 'POST'
                ) {
                  const form = new URLSearchParams(request.postData() ?? '');
                  observedTotp =
                    form.get('totp_code') === generateTotp({ secret: totpSecret, now });
                  await route.fulfill({
                    contentType: 'text/html',
                    body: `<script>window.location.replace(${JSON.stringify(callbackUrl)})</script>`,
                  });
                  return;
                }

                if (url.origin === stagingOrigin && url.pathname === '/api/v1/auth/callback') {
                  await route.fulfill({
                    contentType: 'text/html',
                    headers: {
                      'set-cookie':
                        '__Host-aeo_session=opaque-run-session; Path=/; Secure; HttpOnly; SameSite=Lax',
                    },
                    body: `<script>window.location.replace(${JSON.stringify(`${stagingOrigin}/app`)})</script>`,
                  });
                  return;
                }

                if (url.origin === stagingOrigin && url.pathname === '/app') {
                  await route.fulfill({
                    contentType: 'text/html',
                    body: '<main>Authenticated AEOStudio</main>',
                  });
                  return;
                }

                if (url.origin === stagingOrigin && url.pathname === '/api/v1/auth/session') {
                  expect(request.headers().cookie).toContain(
                    '__Host-aeo_session=opaque-run-session',
                  );
                  await route.fulfill({
                    contentType: 'application/json',
                    body: JSON.stringify({
                      data: {
                        email: username,
                        expiresAt: '2026-07-23T12:00:00.000Z',
                      },
                    }),
                  });
                  return;
                }

                if (
                  url.origin === stagingOrigin &&
                  url.pathname === '/api/v1/synthetic-probe' &&
                  request.method() === 'POST'
                ) {
                  expect(request.headers().cookie).toContain(
                    '__Host-aeo_session=opaque-run-session',
                  );
                  expect(request.headers().origin).toBe(stagingOrigin);
                  expect(request.headers()['x-request-id']).toBe(
                    '00000000-0000-4000-8000-000000000018',
                  );
                  expect(request.postDataJSON()).toEqual({ synthetic: true });
                  observedAuthenticatedMutation = true;
                  await route.fulfill({
                    status: 201,
                    contentType: 'application/json',
                    body: JSON.stringify({ data: { accepted: true } }),
                  });
                  return;
                }

                await route.abort('blockedbyclient');
              });
              return context;
            },
          };
        },
      },
    );

    try {
      const session = await authenticated.getJson('/api/v1/auth/session');
      const mutation = await authenticated.requestJson('/api/v1/synthetic-probe', {
        body: { synthetic: true },
        method: 'POST',
        requestId: '00000000-0000-4000-8000-000000000018',
      });
      expect(session.body?.data?.email).toBe(username);
      expect(mutation).toMatchObject({
        body: { data: { accepted: true } },
        status: 201,
      });
      expect(observedPkce).toBe(true);
      expect(observedPassword).toBe(true);
      expect(observedTotp).toBe(true);
      expect(observedAuthenticatedMutation).toBe(true);
      expect(Object.keys(authenticated).sort()).toEqual([
        'close',
        'flow',
        'getJson',
        'requestJson',
      ]);
      expect(JSON.stringify(authenticated.flow)).not.toContain(username);
      expect(JSON.stringify(authenticated.flow)).not.toContain(password);
      expect(JSON.stringify(authenticated.flow)).not.toContain(totpSecret);
      expect(JSON.stringify(authenticated.flow)).not.toContain('opaque-run-session');
    } finally {
      await authenticated.close();
    }
  }, 60_000);

  test('refuses to enter synthetic credentials after a login redirect leaves the configured Cognito origin', async () => {
    const stagingOrigin = 'https://staging.example.test';
    const cognitoOrigin = 'https://auth.staging.example.test';
    const attackerOrigin = 'https://credential-capture.example.test';
    let browserClosed = false;
    let browserConnected = true;
    let attackerReceivedCredentials = false;

    await expect(
      completeSyntheticCognitoLogin(
        {
          stagingOrigin,
          cognitoOrigin,
          username: 'synthetic-operator@example.test',
          password: 'synthetic-password-value',
          totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        },
        {
          timeoutMs: 500,
          launchBrowser: () => ({
            close: () => {
              browserClosed = true;
              browserConnected = false;
              return Promise.resolve();
            },
            newContext: () => ({
              newPage: () => ({
                setDefaultTimeout: () => undefined,
                setDefaultNavigationTimeout: () => undefined,
                on: () => undefined,
                goto: () => undefined,
                waitForURL: (predicate: (candidate: URL) => boolean) => {
                  if (predicate(new URL(`${attackerOrigin}/login`))) return;
                  throw new Error('redirect left configured Cognito origin');
                },
                url: () => `${attackerOrigin}/login`,
                locator: () => {
                  attackerReceivedCredentials = true;
                  throw new Error('CREDENTIAL_LOCATOR_MUST_NOT_BE_CREATED');
                },
              }),
            }),
          }),
        },
      ),
    ).rejects.toThrow('COGNITO_LOGIN_ENTRY_FAILED');
    expect(attackerReceivedCredentials).toBe(false);
    expect(browserClosed).toBe(true);
    expect(browserConnected).toBe(false);
  }, 30_000);

  test('creates and rereads a fresh synthetic Profile-to-Experiment chain without touching a real external channel', async () => {
    const config = stagingSyntheticSmokeConfig();
    const fixture = createStagingSyntheticHappyPathFixture(config);
    const evidence = await runStagingSmoke(config, {
      completeLogin: fixture.completeLogin,
      getPublicJson: fixture.getPublicJson,
      nextRequestId: () => crypto.randomUUID(),
      now: () => new Date('2026-07-23T12:00:30.000Z'),
      sleep: () => Promise.resolve(),
    });

    expect(fixture.closed.sort()).toEqual(['operator', 'reviewer']);
    expect(evidence.syntheticFlow).toMatchObject({
      prerequisites: {
        profileId: config.prerequisiteProfileId,
        siteBaselineId: config.prerequisiteBaselineId,
        syntheticAdapterVersionId: config.syntheticAdapterVersionId,
      },
      created: {
        profileRevision: {
          id: stagingSyntheticIds.profileRevisionId,
          revision: 7,
        },
        offering: { id: stagingSyntheticIds.offeringId, revision: 1 },
        claim: {
          id: stagingSyntheticIds.claimId,
          revisionId: stagingSyntheticIds.claimRevisionId,
          status: 'APPROVED',
        },
        promptSet: {
          id: stagingSyntheticIds.promptSetId,
          revisionId: stagingSyntheticIds.promptRevisionId,
          status: 'APPROVED',
        },
        contentPlan: {
          id: stagingSyntheticIds.contentPlanId,
          status: 'READY',
        },
        artifact: {
          id: stagingSyntheticIds.artifactId,
          revisionId: stagingSyntheticIds.artifactRevisionId,
          status: 'APPROVED',
        },
        publication: {
          deliverySemantics: 'NON_LIVE_CONTROLLED_SYNTHETIC_RECEIVER',
          id: stagingSyntheticIds.publicationId,
          status: 'REMOTE_APPLIED',
          isProductionLive: false,
        },
        baseline: {
          runId: stagingSyntheticIds.baselineRunId,
          status: 'COMPLETED',
        },
        remeasurement: {
          runId: stagingSyntheticIds.remeasurementRunId,
          status: 'COMPLETED',
        },
        experiment: {
          id: stagingSyntheticIds.experimentId,
          interventionKind: 'APPROVED_ARTIFACT',
          publishedArtifactClaimed: false,
          sealState: 'SEALED',
        },
      },
    });
    expect(evidence.syntheticFlow.created.baseline.metricIds).toHaveLength(4);
    expect(evidence.syntheticFlow.created.remeasurement.metricIds).toHaveLength(4);
    expect(evidence.syntheticFlow.created.baseline.coverage).toMatchObject({
      expectedSlotCount: 60,
      providedSlotCount: 1,
      missingSlotCount: 59,
      missingSlotDisposition: 'NOT_CHECKED',
      resultCounts: { PASS: 1, NOT_CHECKED: 59 },
    });
    expect(evidence.syntheticFlow.created.baseline.coverage.metricSamples).toHaveLength(4);
    expect(
      evidence.syntheticFlow.created.baseline.coverage.metricSamples.every(
        (metric) =>
          metric.sampleSize === 60 &&
          metric.eligibleDenominator === 1 &&
          metric.excludedCounts.NOT_CHECKED === 59,
      ),
    ).toBe(true);

    const experimentCalls = fixture.calls.filter((call) => call.path.includes('/experiments'));
    expect(experimentCalls.map(({ method, path }) => ({ method, path }))).toEqual([
      {
        method: 'POST',
        path: `/api/v1/tenants/${config.tenantId}/workspaces/${config.workspaceId}/experiments`,
      },
      {
        method: 'GET',
        path:
          `/api/v1/tenants/${config.tenantId}/workspaces/${config.workspaceId}` +
          `/experiments/${stagingSyntheticIds.experimentId}`,
      },
    ]);
    expect(
      (
        experimentCalls.find((call) => call.method === 'POST')?.body as {
          intervention?: { kind?: string };
        }
      ).intervention?.kind,
    ).toBe('APPROVED_ARTIFACT');
    expect(
      JSON.stringify(experimentCalls.find((call) => call.method === 'POST')?.body),
    ).not.toContain('PUBLISHED_ARTIFACT');
    expect(
      fixture.calls
        .filter((call) => call.method !== 'GET')
        .every(
          (call) =>
            call.body !== undefined &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              call.requestId ?? '',
            ),
        ),
    ).toBe(true);
    expect(
      fixture.calls.find(
        (call) =>
          call.path.endsWith('/publications/eligibility') &&
          (call.body as { adapterVersionId?: string }).adapterVersionId ===
            config.syntheticAdapterVersionId,
      ),
    ).toBeDefined();
    expect(evidence.runtimeBuildIdentity).toMatchObject({
      schemaVersion: 'aeostudio.runtime-build-identity.v1',
      service: 'api',
      imageDigest: config.imageDigest,
    });
    expect(evidence.webRuntimeBuildIdentity).toMatchObject({
      schemaVersion: 'aeostudio.runtime-build-identity.v1',
      service: 'web',
      imageDigest: config.webImageDigest,
    });
    expect(evidence.endpoint).toEqual({ origin: config.stagingOrigin });
    const serialized = JSON.stringify(evidence);
    for (const secret of [
      config.username,
      config.password,
      config.totpSecret,
      config.reviewerUsername,
      config.reviewerPassword,
      config.reviewerTotpSecret,
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test('rejects a Content Plan that exceeds 15 minutes from accepted to READY', async () => {
    const config = stagingSyntheticSmokeConfig();
    const fixture = createStagingSyntheticHappyPathFixture(config);
    const monotonicValues = [0, 0, 15 * 60 * 1_000 + 1];

    await expect(
      runStagingSmoke(config, {
        completeLogin: fixture.completeLogin,
        getPublicJson: fixture.getPublicJson,
        monotonicNow: () => monotonicValues.shift() ?? monotonicValues.at(-1) ?? 0,
        nextRequestId: () => crypto.randomUUID(),
        now: () => new Date('2026-07-23T12:00:30.000Z'),
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow('SMOKE_CONTENT_PLAN_SLO_EXCEEDED:900001');
    expect(fixture.closed.sort()).toEqual(['operator', 'reviewer']);
  });

  test('rejects a baseline measurement that exceeds two hours after its POST is accepted', async () => {
    const config = stagingSyntheticSmokeConfig();
    const fixture = createStagingSyntheticHappyPathFixture(config);
    const monotonicValues = [0, 0, 100, 100, 100, 100, 100, 100, 2 * 60 * 60 * 1_000 + 101];

    await expect(
      runStagingSmoke(config, {
        completeLogin: fixture.completeLogin,
        getPublicJson: fixture.getPublicJson,
        monotonicNow: () => monotonicValues.shift() ?? monotonicValues.at(-1) ?? 0,
        nextRequestId: () => crypto.randomUUID(),
        now: () => new Date('2026-07-23T12:00:30.000Z'),
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow('SMOKE_BASELINE_MEASUREMENT_SLO_EXCEEDED:7200001');
    expect(fixture.closed.sort()).toEqual(['operator', 'reviewer']);
  });

  test('rejects a manual import that collapses the approved 20x1x3 measurement cohort to one expected slot', async () => {
    const config = stagingSyntheticSmokeConfig();
    const fixture = createStagingSyntheticHappyPathFixture(config, {
      manualImportExpectedSlotCount: 1,
    });

    await expect(
      runStagingSmoke(config, {
        completeLogin: fixture.completeLogin,
        getPublicJson: fixture.getPublicJson,
        nextRequestId: () => crypto.randomUUID(),
        now: () => new Date('2026-07-23T12:00:30.000Z'),
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow('SMOKE_MANUAL_IMPORT_EXPECTED_SLOT_COUNT_MISMATCH');
    expect(fixture.closed.sort()).toEqual(['operator', 'reviewer']);
  });

  test('rejects a dashboard that hides the unprovided cohort slots instead of reporting NOT_CHECKED exclusions', async () => {
    const config = stagingSyntheticSmokeConfig();
    const fixture = createStagingSyntheticHappyPathFixture(config, {
      dashboardNotCheckedCount: 0,
    });

    await expect(
      runStagingSmoke(config, {
        completeLogin: fixture.completeLogin,
        getPublicJson: fixture.getPublicJson,
        nextRequestId: () => crypto.randomUUID(),
        now: () => new Date('2026-07-23T12:00:30.000Z'),
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow('SMOKE_MEASUREMENT_RESULT_COUNTS_INVALID');
    expect(fixture.closed.sort()).toEqual(['operator', 'reviewer']);
  });

  test('creates a fresh Cognito PKCE session for each smoke run instead of injecting a saved session cookie', async () => {
    const [smoke, login, runner, workflow] = await Promise.all([
      readFile(join(repositoryRoot, 'scripts/smoke/staging-smoke.mjs'), 'utf8'),
      readFile(join(repositoryRoot, 'scripts/smoke/cognito-login.mjs'), 'utf8'),
      readFile(join(repositoryRoot, 'scripts/smoke/staging-smoke-runner.mjs'), 'utf8'),
      readFile(join(repositoryRoot, '.github/workflows/build-attest.yml'), 'utf8'),
    ]);
    const smokeImplementation = [smoke, login, runner].join('\n');

    expect(smokeImplementation).not.toContain('AEO_SMOKE_SESSION_COOKIE');
    expect(workflow).not.toContain('AEO_STAGING_SMOKE_SESSION_COOKIE');
    expect(smokeImplementation).toContain('/api/v1/auth/login');
    expect(smokeImplementation).toContain('completeSyntheticCognitoLogin');
    expect(workflow).toContain('AEO_SMOKE_COGNITO_USERNAME');
    expect(workflow).toContain('AEO_SMOKE_COGNITO_PASSWORD');
    expect(workflow).toContain('AEO_SMOKE_COGNITO_TOTP_SECRET');
    expect(workflow).toContain('AEO_SMOKE_COGNITO_ORIGIN: ${{ vars.AEO_STAGING_COGNITO_ORIGIN }}');
    expect(workflow).toContain(
      'AEO_SMOKE_COGNITO_USERNAME: ${{ secrets.AEO_STAGING_SMOKE_COGNITO_USERNAME }}',
    );
    expect(workflow).toContain(
      'AEO_SMOKE_COGNITO_PASSWORD: ${{ secrets.AEO_STAGING_SMOKE_COGNITO_PASSWORD }}',
    );
    expect(workflow).toContain(
      'AEO_SMOKE_COGNITO_TOTP_SECRET: ${{ secrets.AEO_STAGING_SMOKE_COGNITO_TOTP_SECRET }}',
    );
    expect(workflow).toContain('pnpm exec playwright install --with-deps chromium');
    expect(smoke).toContain("flag: 'wx'");
    expect(smoke).toContain('mode: 0o600');

    const stagingSmokeSteps = workflow.slice(
      workflow.indexOf('- name: Install locked staging-smoke dependencies'),
      workflow.indexOf('- name: Bind smoke evidence to the full promoted release'),
    );
    for (const credential of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_SECURITY_TOKEN',
    ]) {
      expect(stagingSmokeSteps.split(`${credential}: ''`)).toHaveLength(4);
    }
    expect(stagingSmokeSteps.split("AWS_EC2_METADATA_DISABLED: 'true'")).toHaveLength(4);
  });

  test('requires reviewed synthetic prerequisites and cannot reuse a pre-existing Experiment', async () => {
    const [entry, workflow] = await Promise.all([
      readFile(join(repositoryRoot, 'scripts/smoke/staging-smoke.mjs'), 'utf8'),
      readFile(join(repositoryRoot, '.github/workflows/build-attest.yml'), 'utf8'),
    ]);

    expect(entry).not.toContain('AEO_SMOKE_EXPERIMENT_ID');
    expect(workflow).not.toContain('AEO_STAGING_SMOKE_EXPERIMENT_ID');
    for (const name of [
      'AEO_SMOKE_REVIEWER_COGNITO_USERNAME',
      'AEO_SMOKE_REVIEWER_COGNITO_PASSWORD',
      'AEO_SMOKE_REVIEWER_COGNITO_TOTP_SECRET',
      'AEO_SMOKE_PREREQUISITE_PROFILE_ID',
      'AEO_SMOKE_PREREQUISITE_BASELINE_ID',
      'AEO_SMOKE_SYNTHETIC_CHANNEL_KEY',
      'AEO_SMOKE_SYNTHETIC_ADAPTER_VERSION_ID',
      'AEO_SMOKE_SYNTHETIC_PUBLICATION_TARGET',
      'AEO_SMOKE_MANUAL_PROVIDER_KEY',
      'AEO_SMOKE_MANUAL_SURFACE_KEY',
      'AEO_SMOKE_MANUAL_ADAPTER_VERSION',
      'AEO_SMOKE_MANUAL_TERMS_VERSION',
    ]) {
      expect(entry).toContain(`required('${name}')`);
      expect(workflow).toContain(`${name}:`);
    }
    expect(workflow).not.toContain('AEOSTUDIO_ALLOW_FAKE_RUNTIME');
    expect(workflow).not.toContain('AEOSTUDIO_CHANNEL_ADAPTER_MODE');
    expect(workflow).not.toContain('AEOSTUDIO_MEASUREMENT_PROVIDER_MODE');
  });
});
