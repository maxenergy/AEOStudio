import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { URL } from 'node:url';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CALLBACK_PATH = '/api/v1/auth/callback';
const LOGIN_PATH = '/api/v1/auth/login';
const SESSION_COOKIE_NAME = '__Host-aeo_session';

export function generateTotp({ secret, now = new Date() }) {
  const key = decodeBase32(secret);
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error('COGNITO_TOTP_TIME_INVALID');

  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(instant.getTime() / 30_000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

export async function completeSyntheticCognitoLogin(input, dependencies = {}) {
  const stagingOrigin = exactHttpsOrigin(input.stagingOrigin, 'STAGING_SMOKE_REQUIRES_HTTPS');
  const cognitoOrigin = exactHttpsOrigin(input.cognitoOrigin, 'AEO_SMOKE_COGNITO_ORIGIN_INVALID');
  if (stagingOrigin === cognitoOrigin) throw new Error('COGNITO_ORIGIN_MUST_BE_SEPARATE');
  const username = requiredSecret(input.username, 'AEO_SMOKE_COGNITO_USERNAME_REQUIRED');
  const password = requiredSecret(input.password, 'AEO_SMOKE_COGNITO_PASSWORD_REQUIRED');
  const totpSecret = requiredSecret(input.totpSecret, 'AEO_SMOKE_COGNITO_TOTP_SECRET_REQUIRED');
  const timeoutMs = dependencies.timeoutMs ?? 45_000;
  const launchBrowser = dependencies.launchBrowser ?? launchChromium;
  const browser = await launchBrowser();
  let closed = false;

  try {
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);

    let authorizationObserved = false;
    let callbackObserved = false;
    page.on('request', (request) => {
      if (!request.isNavigationRequest()) return;
      const url = safeUrl(request.url());
      if (url === null) return;
      if (url.origin === cognitoOrigin && isValidAuthorizationRequest(url, stagingOrigin)) {
        authorizationObserved = true;
      }
      if (
        url.origin === stagingOrigin &&
        url.pathname === CALLBACK_PATH &&
        nonEmpty(url.searchParams.get('code')) &&
        nonEmpty(url.searchParams.get('state'))
      ) {
        callbackObserved = true;
      }
    });

    await safeBrowserStep('COGNITO_LOGIN_ENTRY_FAILED', async () => {
      await page.goto(new URL(LOGIN_PATH, stagingOrigin).toString(), {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForURL((candidate) => candidate.origin === cognitoOrigin, {
        waitUntil: 'domcontentloaded',
      });
    });
    assertPageOrigin(page.url(), cognitoOrigin, 'COGNITO_LOGIN_ORIGIN_MISMATCH');
    if (!authorizationObserved) throw new Error('COGNITO_PKCE_AUTHORIZATION_NOT_OBSERVED');

    const usernameInput = page
      .locator('input[name="username"], input[name="email"], input[autocomplete="username"]')
      .first();
    const passwordInput = page
      .locator('input[name="password"], input[autocomplete="current-password"]')
      .first();
    await safeBrowserStep('COGNITO_PASSWORD_FORM_UNAVAILABLE', async () => {
      await usernameInput.waitFor({ state: 'visible' });
      await passwordInput.waitFor({ state: 'visible' });
      assertPageOrigin(page.url(), cognitoOrigin, 'COGNITO_CREDENTIAL_ORIGIN_MISMATCH');
      await usernameInput.fill(username);
      await passwordInput.fill(password);
      await passwordInput.press('Enter');
    });

    const totpInput = page
      .locator(
        [
          'input[autocomplete="one-time-code"]',
          'input[name*="totp" i]',
          'input[name*="mfa" i]',
          'input[inputmode="numeric"]',
        ].join(', '),
      )
      .first();
    await safeBrowserStep('COGNITO_TOTP_FORM_UNAVAILABLE', async () => {
      await totpInput.waitFor({ state: 'visible' });
      assertPageOrigin(page.url(), cognitoOrigin, 'COGNITO_TOTP_ORIGIN_MISMATCH');
      const now = dependencies.now?.() ?? new Date();
      await totpInput.fill(generateTotp({ secret: totpSecret, now }));
    });

    await safeBrowserStep('COGNITO_CALLBACK_FAILED', () =>
      Promise.all([
        page.waitForURL(
          (candidate) => candidate.origin === stagingOrigin && candidate.pathname === '/app',
          { waitUntil: 'domcontentloaded' },
        ),
        totpInput.press('Enter'),
      ]),
    );
    if (!callbackObserved) throw new Error('COGNITO_CALLBACK_NOT_OBSERVED');
    const sessionCookies = await context.cookies(stagingOrigin);
    if (!sessionCookies.some((cookie) => cookie.name === SESSION_COOKIE_NAME)) {
      throw new Error('COGNITO_SESSION_COOKIE_NOT_ESTABLISHED');
    }

    return {
      flow: Object.freeze({
        callbackPath: CALLBACK_PATH,
        mfa: 'software-token-totp',
        pkce: 'S256',
        protocol: 'authorization-code',
      }),
      getJson: async (path, options) =>
        browserRequestJson(page, stagingOrigin, path, { ...options, method: 'GET' }, timeoutMs),
      requestJson: async (path, options) =>
        browserRequestJson(page, stagingOrigin, path, options, timeoutMs),
      close: async () => {
        if (closed) return;
        closed = true;
        await browser.close();
      },
    };
  } catch (error) {
    closed = true;
    await browser.close().catch(() => undefined);
    throw error;
  }
}

function decodeBase32(value) {
  const normalized = value.replaceAll(/\s+/gu, '').replaceAll(/=+$/gu, '').toUpperCase();
  if (normalized.length < 16 || !/^[A-Z2-7]+$/u.test(normalized)) {
    throw new Error('AEO_SMOKE_COGNITO_TOTP_SECRET_INVALID');
  }

  const bytes = [];
  let accumulator = 0;
  let availableBits = 0;
  for (const character of normalized) {
    accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character);
    availableBits += 5;
    if (availableBits < 8) continue;
    availableBits -= 8;
    bytes.push((accumulator >>> availableBits) & 0xff);
    accumulator &= (1 << availableBits) - 1;
  }
  return Buffer.from(bytes);
}

function exactHttpsOrigin(value, code) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(code);
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(code);
  }
  return url.origin;
}

function requiredSecret(value, code) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(code);
  }
  return value;
}

async function launchChromium() {
  const { chromium } = await import('@playwright/test');
  return chromium.launch({ headless: true });
}

function isValidAuthorizationRequest(url, stagingOrigin) {
  const redirectUri = safeUrl(url.searchParams.get('redirect_uri'));
  return (
    url.searchParams.get('response_type') === 'code' &&
    url.searchParams.get('code_challenge_method') === 'S256' &&
    /^[A-Za-z0-9_-]{43,128}$/u.test(url.searchParams.get('code_challenge') ?? '') &&
    nonEmpty(url.searchParams.get('nonce')) &&
    nonEmpty(url.searchParams.get('state')) &&
    redirectUri?.origin === stagingOrigin &&
    redirectUri.pathname === CALLBACK_PATH &&
    redirectUri.search === '' &&
    redirectUri.hash === ''
  );
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0;
}

function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function assertPageOrigin(value, expectedOrigin, code) {
  const url = safeUrl(value);
  if (url?.origin !== expectedOrigin || url.protocol !== 'https:') throw new Error(code);
}

async function safeBrowserStep(code, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message)) throw error;
    // Deliberately omit the browser error as a cause: it can contain OAuth query values.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(code);
  }
}

async function browserRequestJson(page, stagingOrigin, path, options = {}, timeoutMs = 45_000) {
  const url = new URL(path, stagingOrigin);
  if (url.origin !== stagingOrigin || !url.pathname.startsWith('/')) {
    throw new Error('SMOKE_REQUEST_ORIGIN_INVALID');
  }
  const method = options.method ?? 'GET';
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw new Error('SMOKE_REQUEST_METHOD_INVALID');
  }
  if ((method === 'GET' || method === 'DELETE') && options.body !== undefined) {
    throw new Error('SMOKE_REQUEST_BODY_FORBIDDEN');
  }
  const requestId = options.requestId;
  if (
    requestId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)
  ) {
    throw new Error('SMOKE_REQUEST_ID_INVALID');
  }
  let serializedBody;
  if (options.body !== undefined) {
    try {
      serializedBody = JSON.stringify(options.body);
    } catch {
      throw new Error('SMOKE_REQUEST_BODY_INVALID');
    }
    if (serializedBody === undefined) throw new Error('SMOKE_REQUEST_BODY_INVALID');
  }
  const before = performance.now();
  let response;
  try {
    response = await page.evaluate(
      async ({ method, requestUrl, requestId, serializedBody, timeoutMs }) => {
        const result = await globalThis.fetch(requestUrl, {
          method,
          credentials: 'same-origin',
          headers: {
            accept: 'application/json',
            ...(serializedBody === undefined ? {} : { 'content-type': 'application/json' }),
            ...(requestId === undefined ? {} : { 'x-request-id': requestId }),
          },
          ...(serializedBody === undefined ? {} : { body: serializedBody }),
          redirect: 'error',
          signal: globalThis.AbortSignal.timeout(timeoutMs),
        });
        return {
          body: await result.json().catch(() => null),
          status: result.status,
        };
      },
      {
        method,
        requestId,
        requestUrl: url.toString(),
        serializedBody,
        timeoutMs,
      },
    );
  } catch {
    // Browser errors can contain redirect locations or OAuth query values.
    throw new Error(`SMOKE_REQUEST_FAILED:${url.pathname}`);
  }
  const durationMs = Math.round((performance.now() - before) * 100) / 100;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`SMOKE_HTTP_${String(response.status)}:${url.pathname}`);
  }
  return { ...response, durationMs };
}
