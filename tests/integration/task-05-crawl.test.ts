import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import type { AuthorizationRequest, OidcClient } from '@aeostudio/application/auth';
import { JobWorkerCoordinator, OutboxRelay } from '@aeostudio/application/jobs-budgets';
import {
  SiteCrawlService,
  type CrawlObjectStorage,
  type CrawlPageFetcher,
  type SiteCrawlStore,
  type SiteOwnershipVerifier,
} from '@aeostudio/application/site-crawl';
import { FakeJobQueue } from '@aeostudio/adapters/queue';
import { FakeS3ObjectStorage } from '@aeostudio/adapters/storage';
import { SiteBaselineEnvelopeSchema } from '@aeostudio/contracts/site-crawl';
import {
  MAX_CRAWL_BYTES,
  MAX_CRAWL_PAGES,
  SiteCrawlHandler,
  SiteCrawlJobWorker,
} from '@aeostudio/worker';
import {
  AesGcmSessionCipher,
  PostgresAuthStore,
  PostgresJobBudgetStore,
  PostgresProfileOfferingStore,
  PostgresSiteCrawlStore,
  PostgresTenancyStore,
  runMigrations,
} from '@aeostudio/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createApiApp } from '../../apps/api/src/app.js';

type ApiTestApp = Awaited<ReturnType<typeof createApiApp>>;

class FixtureOwnershipVerifier implements SiteOwnershipVerifier {
  observedToken = 'wrong-token';

  verify(input: Parameters<SiteOwnershipVerifier['verify']>[0]): Promise<{ matched: boolean }> {
    return Promise.resolve({ matched: this.observedToken === input.expectedToken });
  }
}

const ownershipVerifier = new FixtureOwnershipVerifier();

const oidcClient: OidcClient = {
  createAuthorizationUrl(input: AuthorizationRequest) {
    const url = new URL('https://issuer.example/authorize');
    url.searchParams.set('client_id', input.client_id);
    url.searchParams.set('code_challenge', input.code_challenge);
    url.searchParams.set('code_challenge_method', input.code_challenge_method);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('redirect_uri', input.redirect_uri);
    url.searchParams.set('response_type', input.response_type);
    url.searchParams.set('scope', input.scope);
    url.searchParams.set('state', input.state);
    return url.toString();
  },
  exchangeCode() {
    return Promise.resolve({
      subject: 'site-editor-subject',
      email: 'site-editor@example.test',
      emailVerified: true,
    });
  },
};

async function signIn(app: ApiTestApp): Promise<string> {
  const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
  const loginToken = login.cookies.find((cookie) => cookie.name === '__Host-aeo_login')?.value;
  const state = new URL(login.headers.location ?? '').searchParams.get('state');
  const callback = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/callback?code=site-code&state=${state ?? ''}`,
    headers: { cookie: `__Host-aeo_login=${loginToken ?? ''}` },
  });
  const sessionToken = callback.cookies.find(
    (cookie) => cookie.name === '__Host-aeo_session',
  )?.value;
  if (sessionToken === undefined) {
    throw new Error('TEST_LOGIN_DID_NOT_CREATE_SESSION');
  }
  return sessionToken;
}

describe('Task 5 verified Site crawl', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: ApiTestApp;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(
      pool,
      fileURLToPath(new URL('../../packages/db/migrations', import.meta.url)),
    );
    app = await createApiApp({
      oidcClient,
      store: new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 5))),
      jobBudgetStore: new PostgresJobBudgetStore(pool),
      tenancyStore: new PostgresTenancyStore(pool),
      profileOfferingStore: new PostgresProfileOfferingStore(pool),
      siteCrawlStore: new PostgresSiteCrawlStore(pool),
      siteOwnershipVerifier: ownershipVerifier,
      webOrigin: 'https://app.example.test',
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  test('an Editor may start a verified crawl while a Viewer is denied and audited', async () => {
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const site = {
      id: randomUUID(),
      tenantId,
      workspaceId,
      profileId: randomUUID(),
      origin: 'https://roles.example.test',
      hostname: 'roles.example.test',
      status: 'VERIFIED' as const,
      verifiedAt: '2026-07-20T00:00:00.000Z',
    };
    const deniedActions: string[] = [];
    const service = new SiteCrawlService(
      {
        findSite: () => Promise.resolve(site),
      } as unknown as SiteCrawlStore,
      {
        resolveTenantContext: (input) =>
          Promise.resolve({
            tenantId,
            workspaceId,
            actorUserId: randomUUID(),
            membershipId: randomUUID(),
            role: input.actorSubject === 'editor' ? ('EDITOR' as const) : ('VIEWER' as const),
          }),
        appendDeniedAudit: (input) => {
          deniedActions.push(input.action);
          return Promise.resolve();
        },
      },
      { next: randomUUID },
      { verify: () => Promise.resolve({ matched: true }) },
      { now: () => new Date('2026-07-20T00:00:00.000Z') },
    );

    await expect(
      service.authorizeCrawl({ actorSubject: 'editor', tenantId, workspaceId, siteId: site.id }),
    ).resolves.toMatchObject({ outcome: 'ALLOWED', site: { id: site.id } });
    await expect(
      service.authorizeCrawl({ actorSubject: 'viewer', tenantId, workspaceId, siteId: site.id }),
    ).resolves.toEqual({ outcome: 'FORBIDDEN' });
    expect(deniedActions).toEqual(['CRAWL_START']);
  });

  test('an unverified Site cannot start a crawl', async () => {
    const session = await signIn(app);
    const tenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Site Tenant', workspaceName: 'Site Workspace' },
    });
    const scope = tenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const profileResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        displayName: 'Site Profile',
        targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
      },
    });
    const profileId = profileResponse.json<{ data: { profile: { profileId: string } } }>().data
      .profile.profileId;

    const registered = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/sites`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { profileId, origin: 'https://docs.example.test' },
    });
    expect(registered.statusCode).toBe(201);
    const site = registered.json<{
      data: { site: { id: string; origin: string; status: string } };
    }>().data.site;
    expect(site).toMatchObject({
      origin: 'https://docs.example.test',
      status: 'UNVERIFIED',
    });

    const crawl = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/sites/${site.id}/crawls`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { idempotencyKey: 'unverified-crawl' },
    });
    expect(crawl.statusCode).toBe(409);
    expect(crawl.json()).toMatchObject({ code: 'SITE_NOT_VERIFIED', retryable: false });
  });

  test('a FILE ownership challenge requires exact evidence before verifying a Site', async () => {
    const session = await signIn(app);
    const tenantResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { tenantName: 'Verification Tenant', workspaceName: 'Verification Workspace' },
    });
    const scope = tenantResponse.json<{
      data: { tenant: { id: string }; workspace: { id: string } };
    }>().data;
    const profileResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/profiles`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {
        displayName: 'Verified Profile',
        targetMarkets: [{ locale: 'en-SG', market: 'SG' }],
      },
    });
    const profileId = profileResponse.json<{ data: { profile: { profileId: string } } }>().data
      .profile.profileId;
    const registered = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/sites`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { profileId, origin: 'https://verified.example.test' },
    });
    const siteId = registered.json<{ data: { site: { id: string } } }>().data.site.id;

    const challenge = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/sites/${siteId}/verifications`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { method: 'FILE' },
    });
    expect(challenge.statusCode).toBe(201);
    const verification = challenge.json<{
      data: {
        verification: { id: string; challengeToken: string; challengePath: string };
      };
    }>().data.verification;
    expect(verification.challengePath).toBe('/.well-known/aeostudio-verification');

    const mismatch = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/sites/${siteId}/verifications/${verification.id}/complete`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {},
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ code: 'VERIFICATION_MISMATCH' });

    ownershipVerifier.observedToken = verification.challengeToken;
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/sites/${siteId}/verifications/${verification.id}/complete`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: {},
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ data: { site: { status: 'VERIFIED' } } });

    const budget = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/budget`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { limitUnits: 100 },
    });
    expect(budget.statusCode).toBe(200);
    const crawl = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/sites/${siteId}/crawls`,
      headers: {
        cookie: `__Host-aeo_session=${session}`,
        origin: 'https://app.example.test',
      },
      payload: { idempotencyKey: 'verified-crawl' },
    });
    expect(crawl.statusCode).toBe(202);
    expect(crawl.json()).toMatchObject({
      data: { job: { jobType: 'SITE_CRAWL', aggregateId: siteId, status: 'QUEUED' } },
    });
    const pendingBaseline = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/sites/${siteId}/baseline`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(pendingBaseline.statusCode).toBe(404);
    expect(pendingBaseline.json()).toMatchObject({ code: 'BASELINE_NOT_READY' });

    const jobId = crawl.json<{ data: { job: { id: string } } }>().data.job.id;
    const fetcher: CrawlPageFetcher = {
      fetch(input) {
        const fixtures: Record<string, { contentType: string; text: string }> = {
          'https://verified.example.test/robots.txt': {
            contentType: 'text/plain',
            text: 'User-agent: *\nSitemap: https://verified.example.test/sitemap.xml',
          },
          'https://verified.example.test/sitemap.xml': {
            contentType: 'application/xml',
            text: '<urlset><url><loc>https://verified.example.test/</loc></url></urlset>',
          },
          'https://verified.example.test/': {
            contentType: 'text/html',
            text: '<html><head><title>Verified fixture</title></head><body>Content</body></html>',
          },
        };
        const fixture = fixtures[input.url];
        return Promise.resolve(
          fixture === undefined
            ? { outcome: 'FETCH_FAILED' as const, errorCode: 'FIXTURE_NOT_FOUND' }
            : {
                outcome: 'SUCCEEDED' as const,
                finalUrl: input.url,
                response: {
                  status: 200,
                  contentType: fixture.contentType,
                  body: new TextEncoder().encode(fixture.text),
                },
              },
        );
      },
    };
    const storage: CrawlObjectStorage = {
      putObject: (input) => Promise.resolve({ objectRef: `s3://fixture-bucket/${input.key}` }),
    };
    const executionStore = new PostgresSiteCrawlStore(pool);
    const jobStore = new PostgresJobBudgetStore(pool);
    const queue = new FakeJobQueue();
    const clock = { now: () => new Date('2026-07-20T02:30:00.000Z') };
    const relay = new OutboxRelay(jobStore, queue, clock);
    expect(await relay.relay()).toBe(1);
    const message = queue.receive();
    if (message === undefined) {
      throw new Error('SITE_CRAWL_MESSAGE_MISSING');
    }
    const coordinator = new JobWorkerCoordinator(jobStore, clock, { next: randomUUID });
    const worker = new SiteCrawlJobWorker(
      coordinator,
      executionStore,
      new SiteCrawlHandler(fetcher, storage, { next: randomUUID }, clock),
      { next: randomUUID },
      clock,
    );
    expect(
      await worker.process(message, {
        maxPages: 500,
        maxBytes: 2 * 1024 * 1024 * 1024,
        timeoutMs: 5_000,
      }),
    ).toMatchObject({ outcome: 'SUCCEEDED' });
    const baseline = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/sites/${siteId}/baseline`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(baseline.statusCode).toBe(200);
    const baselineBody = SiteBaselineEnvelopeSchema.parse(baseline.json());
    expect(baselineBody.data.baseline.status).toBe('COMPLETE');
    expect(baselineBody.data.baseline.pageCount).toBe(1);
    expect(
      baselineBody.data.baseline.snapshots.some(
        (snapshot) =>
          /^[a-f0-9]{64}$/.test(snapshot.checksum) &&
          /^s3:\/\/fixture-bucket\//.test(snapshot.objectRef),
      ),
    ).toBe(true);
    expect(
      baselineBody.data.baseline.findings.some(
        (finding) =>
          finding.findingType === 'technical-html:META_DESCRIPTION_MISSING' &&
          finding.severity === 'WARNING',
      ),
    ).toBe(true);
    const snapshotIds = new Set(
      baselineBody.data.baseline.snapshots.map((snapshot) => snapshot.id),
    );
    expect(
      baselineBody.data.baseline.findings.every((finding) => snapshotIds.has(finding.snapshotId)),
    ).toBe(true);
    const completedJob = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}/jobs/${jobId}`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(completedJob.json()).toMatchObject({
      data: { job: { status: 'SUCCEEDED', progress: 100, result: { baselineStatus: 'COMPLETE' } } },
    });
  });

  test('a verified Site produces content-addressed snapshots and drill-down findings', async () => {
    const responses = new Map([
      [
        'https://docs.example.test/robots.txt',
        {
          contentType: 'text/plain',
          body: new TextEncoder().encode(
            'User-agent: *\nAllow: /\nSitemap: https://docs.example.test/sitemap.xml',
          ),
        },
      ],
      [
        'https://docs.example.test/sitemap.xml',
        {
          contentType: 'application/xml',
          body: new TextEncoder().encode(
            '<urlset><url><loc>https://docs.example.test/</loc></url><url><loc>https://docs.example.test/guide</loc></url></urlset>',
          ),
        },
      ],
      [
        'https://docs.example.test/',
        {
          contentType: 'text/html',
          body: new TextEncoder().encode(
            '<html><head><title>Documentation</title><meta name="description" content="Evidence-backed guide"><link rel="canonical" href="https://docs.example.test/"><script type="application/ld+json">{"@type":"WebSite"}</script></head><body>Trusted as data only.</body></html>',
          ),
        },
      ],
      [
        'https://docs.example.test/guide',
        {
          contentType: 'text/html',
          body: new TextEncoder().encode('<html><body>Guide without metadata.</body></html>'),
        },
      ],
    ]);
    const fetcher: CrawlPageFetcher = {
      fetch: (input) => {
        const fixture = responses.get(input.url);
        return Promise.resolve(
          fixture === undefined
            ? { outcome: 'FETCH_FAILED' as const, errorCode: 'FIXTURE_NOT_FOUND' }
            : {
                outcome: 'SUCCEEDED' as const,
                finalUrl: input.url,
                response: { status: 200, ...fixture },
              },
        );
      },
    };
    const storage = new FakeS3ObjectStorage();
    let sequence = 0;
    const handler = new SiteCrawlHandler(
      fetcher,
      storage,
      { next: () => `fixture-${(sequence += 1)}` },
      { now: () => new Date('2026-07-20T02:00:00.000Z') },
    );

    const result = await handler.run(
      {
        id: '00000000-0000-7000-8000-000000000501',
        tenantId: '00000000-0000-7000-8000-000000000502',
        workspaceId: '00000000-0000-7000-8000-000000000503',
        profileId: '00000000-0000-7000-8000-000000000504',
        origin: 'https://docs.example.test',
        hostname: 'docs.example.test',
        status: 'VERIFIED',
        verifiedAt: '2026-07-20T01:00:00.000Z',
      },
      { maxPages: 500, maxBytes: 2 * 1024 * 1024 * 1024, timeoutMs: 5_000 },
    );

    expect(result).toMatchObject({
      status: 'COMPLETE',
      errorCode: null,
      pageCount: 2,
    });
    expect(result.snapshots).toHaveLength(4);
    expect(storage.size).toBe(4);
    for (const snapshot of result.snapshots) {
      expect(snapshot.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(typeof snapshot.contentType).toBe('string');
      expect(typeof snapshot.sizeBytes).toBe('number');
      expect(snapshot.capturedAt).toBe('2026-07-20T02:00:00.000Z');
      expect(snapshot.objectRef).toMatch(/^s3\+memory:\/\//);
    }
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ findingType: 'ROBOTS_PRESENT' }),
        expect.objectContaining({ findingType: 'SITEMAP_PRESENT' }),
        expect.objectContaining({ findingType: 'structured-data:JSONLD_VALID' }),
        expect.objectContaining({
          findingType: 'technical-html:TITLE_MISSING',
          severity: 'WARNING',
        }),
        expect.objectContaining({ findingType: 'technical-html:META_DESCRIPTION_MISSING' }),
        expect.objectContaining({ findingType: 'indexability:CANONICAL_MISSING' }),
      ]),
    );
    const snapshotIds = new Set(result.snapshots.map((snapshot) => snapshot.id));
    expect(result.findings.every((finding) => snapshotIds.has(finding.snapshotId))).toBe(true);
  });

  test('robots rules prevent a disallowed sitemap URL from being fetched', async () => {
    const fetchedUrls: string[] = [];
    const fetcher: CrawlPageFetcher = {
      fetch(input) {
        fetchedUrls.push(input.url);
        const text = input.url.endsWith('/robots.txt')
          ? 'User-agent: *\nDisallow: /private\nAllow: /\nSitemap: https://policy.example.test/sitemap.xml'
          : input.url.endsWith('/sitemap.xml')
            ? '<urlset><url><loc>https://policy.example.test/</loc></url><url><loc>https://policy.example.test/public</loc></url><url><loc>https://policy.example.test/private</loc></url></urlset>'
            : '<html><head><title>Allowed</title></head><body>Page</body></html>';
        const contentType = input.url.endsWith('/robots.txt')
          ? 'text/plain'
          : input.url.endsWith('/sitemap.xml')
            ? 'application/xml'
            : 'text/html';
        return Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          finalUrl: input.url,
          response: { status: 200, contentType, body: new TextEncoder().encode(text) },
        });
      },
    };
    const handler = new SiteCrawlHandler(
      fetcher,
      {
        putObject: (input) => Promise.resolve({ objectRef: `memory://${input.key}` }),
      },
      { next: randomUUID },
      { now: () => new Date('2026-07-20T03:00:00.000Z') },
    );

    const result = await handler.run(
      {
        id: randomUUID(),
        tenantId: randomUUID(),
        workspaceId: randomUUID(),
        profileId: randomUUID(),
        origin: 'https://policy.example.test',
        hostname: 'policy.example.test',
        status: 'VERIFIED',
        verifiedAt: '2026-07-20T02:00:00.000Z',
      },
      { maxPages: 500, maxBytes: 2 * 1024 * 1024 * 1024, timeoutMs: 5_000 },
    );

    expect(result).toMatchObject({ status: 'COMPLETE', pageCount: 2 });
    expect(fetchedUrls).not.toContain('https://policy.example.test/private');
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ findingType: 'ROBOTS_BLOCKED' })]),
    );
  });

  test('AEOStudioCrawler-specific robots groups override wildcard rules and support wildcard/end anchors', async () => {
    const fetchedUrls: string[] = [];
    const fetcher: CrawlPageFetcher = {
      fetch(input) {
        fetchedUrls.push(input.url);
        const text = input.url.endsWith('/robots.txt')
          ? [
              'User-agent: *',
              'Allow: /',
              '',
              'User-agent: AEOStudioCrawler',
              'Disallow: /private/*',
              'Allow: /private/public$',
              'Sitemap: https://specific-policy.example.test/sitemap.xml',
            ].join('\n')
          : input.url.endsWith('/sitemap.xml')
            ? [
                '<urlset>',
                '<url><loc>https://specific-policy.example.test/</loc></url>',
                '<url><loc>https://specific-policy.example.test/private/secret</loc></url>',
                '<url><loc>https://specific-policy.example.test/private/public</loc></url>',
                '<url><loc>https://specific-policy.example.test/private/public/more</loc></url>',
                '</urlset>',
              ].join('')
            : '<html><head><title>Allowed</title></head><body>Page</body></html>';
        const contentType = input.url.endsWith('/robots.txt')
          ? 'text/plain'
          : input.url.endsWith('/sitemap.xml')
            ? 'application/xml'
            : 'text/html';
        return Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          finalUrl: input.url,
          response: { status: 200, contentType, body: new TextEncoder().encode(text) },
        });
      },
    };
    const result = await new SiteCrawlHandler(
      fetcher,
      { putObject: (input) => Promise.resolve({ objectRef: `memory://${input.key}` }) },
      { next: randomUUID },
      { now: () => new Date('2026-07-20T03:15:00.000Z') },
    ).run(
      {
        id: randomUUID(),
        tenantId: randomUUID(),
        workspaceId: randomUUID(),
        profileId: randomUUID(),
        origin: 'https://specific-policy.example.test',
        hostname: 'specific-policy.example.test',
        status: 'VERIFIED',
        verifiedAt: '2026-07-20T03:00:00.000Z',
      },
      { maxPages: 500, maxBytes: MAX_CRAWL_BYTES, timeoutMs: 5_000 },
    );

    expect(result).toMatchObject({ status: 'COMPLETE', pageCount: 2 });
    expect(fetchedUrls).toContain('https://specific-policy.example.test/private/public');
    expect(fetchedUrls).not.toContain('https://specific-policy.example.test/private/secret');
    expect(fetchedUrls).not.toContain('https://specific-policy.example.test/private/public/more');
  });

  test('each response gets an independent 10 MiB cap even when crawl quota is 2 GiB', async () => {
    const observedMaxBytes: number[] = [];
    const fetcher: CrawlPageFetcher = {
      fetch(input) {
        observedMaxBytes.push(input.maxBytes);
        return Promise.resolve({ outcome: 'FETCH_FAILED' as const, errorCode: 'FIXTURE_STOP' });
      },
    };
    await new SiteCrawlHandler(
      fetcher,
      { putObject: (input) => Promise.resolve({ objectRef: `memory://${input.key}` }) },
      { next: randomUUID },
      { now: () => new Date('2026-07-20T03:20:00.000Z') },
    ).run(
      {
        id: randomUUID(),
        tenantId: randomUUID(),
        workspaceId: randomUUID(),
        profileId: randomUUID(),
        origin: 'https://page-cap.example.test',
        hostname: 'page-cap.example.test',
        status: 'VERIFIED',
        verifiedAt: '2026-07-20T03:00:00.000Z',
      },
      { maxPages: 500, maxBytes: MAX_CRAWL_BYTES, timeoutMs: 5_000 },
    );

    expect(observedMaxBytes.length).toBeGreaterThan(0);
    expect(Math.max(...observedMaxBytes)).toBe(10 * 1024 * 1024);
  });

  test('crawl policy hard-caps pages at 500 and raw responses at 2 GiB', async () => {
    const locations = Array.from(
      { length: MAX_CRAWL_PAGES + 1 },
      (_, index) => `<url><loc>https://limits.example.test/page-${index}</loc></url>`,
    ).join('');
    const fetcher: CrawlPageFetcher = {
      fetch(input) {
        const text = input.url.endsWith('/robots.txt')
          ? 'User-agent: *\nAllow: /\nSitemap: https://limits.example.test/sitemap.xml'
          : input.url.endsWith('/sitemap.xml')
            ? `<urlset>${locations}</urlset>`
            : '<html><head><title>Bounded</title></head></html>';
        const contentType = input.url.endsWith('/robots.txt')
          ? 'text/plain'
          : input.url.endsWith('/sitemap.xml')
            ? 'application/xml'
            : 'text/html';
        return Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          finalUrl: input.url,
          response: { status: 200, contentType, body: new TextEncoder().encode(text) },
        });
      },
    };
    const storage: CrawlObjectStorage = {
      putObject: (input) => Promise.resolve({ objectRef: `memory://${input.key}` }),
    };
    const site = {
      id: randomUUID(),
      tenantId: randomUUID(),
      workspaceId: randomUUID(),
      profileId: randomUUID(),
      origin: 'https://limits.example.test',
      hostname: 'limits.example.test',
      status: 'VERIFIED' as const,
      verifiedAt: '2026-07-20T03:00:00.000Z',
    };
    const bounded = await new SiteCrawlHandler(
      fetcher,
      storage,
      { next: randomUUID },
      { now: () => new Date('2026-07-20T03:30:00.000Z') },
    ).run(site, { maxPages: 999, maxBytes: Number.MAX_SAFE_INTEGER, timeoutMs: 5_000 });
    expect(bounded).toMatchObject({
      status: 'PARTIAL',
      errorCode: 'PAGE_LIMIT_REACHED',
      pageCount: MAX_CRAWL_PAGES,
    });

    const oversizedFetcher: CrawlPageFetcher = {
      fetch: (input) =>
        Promise.resolve({
          outcome: 'SUCCEEDED' as const,
          finalUrl: input.url,
          response: {
            status: 200,
            contentType: input.url.endsWith('/robots.txt')
              ? 'text/plain'
              : input.url.endsWith('/sitemap.xml')
                ? 'application/xml'
                : 'text/html',
            body: { byteLength: MAX_CRAWL_BYTES + 1 } as unknown as Uint8Array,
          },
        }),
    };
    const byteLimited = await new SiteCrawlHandler(
      oversizedFetcher,
      storage,
      { next: randomUUID },
      { now: () => new Date('2026-07-20T03:30:00.000Z') },
    ).run(site, { maxPages: 999, maxBytes: Number.MAX_SAFE_INTEGER, timeoutMs: 5_000 });
    expect(byteLimited).toMatchObject({
      status: 'PARTIAL',
      errorCode: 'BYTE_LIMIT_REACHED',
      pageCount: 0,
      totalBytes: 0,
      snapshots: [],
    });
  });

  test('a zero-page transient crawl failure enters retry wait without publishing a baseline', async () => {
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    const siteId = randomUUID();
    const jobId = randomUUID();
    const message = {
      messageId: randomUUID(),
      payload: { jobId, tenantId, workspaceId, schemaVersion: '1.0.0' as const },
    };
    const lease = {
      messageId: message.messageId,
      leaseToken: randomUUID(),
      job: {
        id: jobId,
        tenantId,
        workspaceId,
        jobType: 'SITE_CRAWL' as const,
        aggregateId: siteId,
        status: 'RUNNING' as const,
        progress: 0,
        attempt: 1,
        maxAttempts: 3,
        budgetWarning: false,
        estimatedUnits: 10,
        heartbeatAt: '2026-07-20T04:00:00.000Z',
        result: null,
        errorCode: null,
      },
    };
    const failures: { classification: string; errorCode: string }[] = [];
    const coordinator = {
      claim: () => Promise.resolve({ outcome: 'CLAIMED' as const, lease }),
      reportProgress: () => Promise.resolve(true),
      heartbeat: () => Promise.resolve(true),
      fail: (_lease: typeof lease, classification: string, errorCode: string) => {
        failures.push({ classification, errorCode });
        return Promise.resolve('RETRY_WAIT' as const);
      },
      complete: () => Promise.reject(new Error('transient failure must not complete the job')),
    } as unknown as JobWorkerCoordinator;
    let persisted = false;
    const executionStore = {
      loadVerifiedSite: () =>
        Promise.resolve({
          id: siteId,
          tenantId,
          workspaceId,
          profileId: randomUUID(),
          origin: 'https://retry.example.test',
          hostname: 'retry.example.test',
          status: 'VERIFIED' as const,
          verifiedAt: '2026-07-20T03:00:00.000Z',
        }),
      persistBaseline: () => {
        persisted = true;
        return Promise.reject(new Error('transient failure must not publish a baseline'));
      },
    };
    const handler = new SiteCrawlHandler(
      {
        fetch: () => Promise.resolve({ outcome: 'FETCH_FAILED', errorCode: 'FETCH_TIMEOUT' }),
      },
      {
        putObject: () => Promise.reject(new Error('no successful response to persist')),
      },
      { next: randomUUID },
      { now: () => new Date('2026-07-20T04:00:00.000Z') },
    );
    const worker = new SiteCrawlJobWorker(
      coordinator,
      executionStore,
      handler,
      { next: randomUUID },
      { now: () => new Date('2026-07-20T04:00:00.000Z') },
    );

    await expect(
      worker.process(message, { maxPages: 500, maxBytes: MAX_CRAWL_BYTES, timeoutMs: 5_000 }),
    ).resolves.toEqual({ outcome: 'RETRY_WAIT' });
    expect(failures).toEqual([{ classification: 'RETRYABLE', errorCode: 'FETCH_TIMEOUT' }]);
    expect(persisted).toBe(false);
  });
});
