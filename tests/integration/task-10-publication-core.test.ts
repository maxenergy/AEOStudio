import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type {
  AuthorizationRequest,
  ExchangeCodeInput,
  OidcClient,
} from '@aeostudio/application/auth';
import { canonicalArtifactJson } from '@aeostudio/application/artifacts';
import { JobWorkerCoordinator, type JobLease } from '@aeostudio/application/jobs-budgets';
import type {
  ChannelPackagePayloadStore,
  PublicationAdapterDescriptor,
  PublicationExecutionStore,
} from '@aeostudio/application/channels-publishing';
import {
  DeterministicArtifactGenerator,
  InMemoryArtifactPayloadStore,
  InMemoryChannelPackagePayloadStore,
} from '@aeostudio/adapters/generation';
import type { ArtifactPayload } from '@aeostudio/domain/artifacts';
import {
  AesGcmSessionCipher,
  PostgresArtifactStore,
  PostgresAuthStore,
  PostgresChannelAuthorizationStore,
  PostgresChannelPackageStore,
  PostgresChannelRegistryStore,
  PostgresJobBudgetStore,
  PostgresPublicationCommandStore,
  PostgresPublicationQueryStore,
  PostgresTenancyStore,
  runMigrations,
} from '@aeostudio/db';
import * as DatabaseRuntime from '@aeostudio/db';
import {
  ChannelPackageEnvelopeSchema,
  ChannelPackageExportSchema,
  ChannelAuthorizationEnvelopeSchema,
  ChannelAuthorizationListEnvelopeSchema,
  ChannelRegistryEnvelopeSchema,
  ExportOnlyPublicationProblemSchema,
  PublicationDetailEnvelopeSchema,
  PublicationEligibilityEnvelopeSchema,
} from '@aeostudio/contracts/channels';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createApiApp } from '../../apps/api/src/app.js';
import { FAKE_ARTIFACT_LINEAGE } from '../../apps/api/src/artifacts/fake-artifact-lineage-fixture.js';
import {
  ArtifactGenerationHandler,
  ArtifactGenerationJobWorker,
} from '../../apps/worker/src/index.js';
import * as WorkerRuntime from '../../apps/worker/src/index.js';
import { seedTask10ApprovedArtifactSource } from './fixtures/task-10-approved-artifact-source.js';

type ApiTestApp = Awaited<ReturnType<typeof createApiApp>>;

const oidcClient: OidcClient = {
  createAuthorizationUrl(input: AuthorizationRequest) {
    const url = new URL('https://issuer.example/authorize');
    for (const [key, value] of Object.entries(input)) url.searchParams.set(key, String(value));
    return url.toString();
  },
  exchangeCode(input: ExchangeCodeInput) {
    if (input.code === 'authorization-editor-code') {
      return Promise.resolve({
        subject: 'authorization-editor-subject',
        email: 'authorization-editor@example.test',
        emailVerified: true,
      });
    }
    if (input.code === 'authorization-reviewer-code') {
      return Promise.resolve({
        subject: 'authorization-reviewer-subject',
        email: 'authorization-reviewer@example.test',
        emailVerified: true,
      });
    }
    if (input.code === 'authorization-publisher-code') {
      return Promise.resolve({
        subject: 'authorization-publisher-subject',
        email: 'authorization-publisher@example.test',
        emailVerified: true,
      });
    }
    if (input.code === 'channel-admin-code') {
      return Promise.resolve({
        subject: 'channel-admin-subject',
        email: 'channel-admin@example.test',
        emailVerified: true,
      });
    }
    if (input.code === 'channel-owner-b-code') {
      return Promise.resolve({
        subject: 'channel-owner-b-subject',
        email: 'channel-owner-b@example.test',
        emailVerified: true,
      });
    }
    if (input.code === 'channel-publisher-code') {
      return Promise.resolve({
        subject: 'channel-publisher-subject',
        email: 'channel-publisher@example.test',
        emailVerified: true,
      });
    }
    return Promise.resolve({
      subject: 'channel-owner-a-subject',
      email: 'channel-owner-a@example.test',
      emailVerified: true,
    });
  },
};

async function signIn(app: ApiTestApp, code = 'channel-owner-a-code'): Promise<string> {
  const login = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
  const loginToken = login.cookies.find((cookie) => cookie.name === '__Host-aeo_login')?.value;
  const state = new URL(login.headers.location ?? '').searchParams.get('state');
  const callback = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/callback?code=${code}&state=${state ?? ''}`,
    headers: { cookie: `__Host-aeo_login=${loginToken ?? ''}` },
  });
  const session = callback.cookies.find((cookie) => cookie.name === '__Host-aeo_session')?.value;
  if (session === undefined) throw new Error('CHANNEL_TEST_LOGIN_FAILED');
  return session;
}

async function createScope(app: ApiTestApp, session: string, suffix: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: {
      cookie: `__Host-aeo_session=${session}`,
      origin: 'https://app.example.test',
    },
    payload: { tenantName: `${suffix} Tenant`, workspaceName: `${suffix} Workspace` },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{
    data: { tenant: { id: string }; workspace: { id: string } };
  }>().data;
}

function mutationHeaders(session: string) {
  return {
    cookie: `__Host-aeo_session=${session}`,
    origin: 'https://app.example.test',
  };
}

async function generateArtifact(
  app: ApiTestApp,
  session: string,
  scope: { tenant: { id: string }; workspace: { id: string } },
  worker: ArtifactGenerationJobWorker,
) {
  const scopeUrl = `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}`;
  const budget = await app.inject({
    method: 'PUT',
    url: `${scopeUrl}/budget`,
    headers: mutationHeaders(session),
    payload: { limitUnits: 10_000 },
  });
  expect(budget.statusCode).toBe(200);
  const started = await app.inject({
    method: 'POST',
    url: `${scopeUrl}/artifacts`,
    headers: mutationHeaders(session),
    payload: {
      briefId: FAKE_ARTIFACT_LINEAGE.briefId,
      locale: 'en-SG',
      market: 'SG',
      methodPolicyVersion: 'artifact-fixture-v1',
      idempotencyKey: randomUUID(),
      estimatedUnits: 30,
    },
  });
  expect(started.statusCode).toBe(202);
  const startedData = started.json<{
    data: { artifact: { id: string }; job: { id: string } };
  }>().data;
  expect(
    await worker.process({
      messageId: randomUUID(),
      payload: {
        jobId: startedData.job.id,
        tenantId: scope.tenant.id,
        workspaceId: scope.workspace.id,
        schemaVersion: '1.0.0',
      },
    }),
  ).toMatchObject({ outcome: 'SUCCEEDED' });
  for (let poll = 0; poll < 3; poll += 1) {
    const job = await app.inject({
      method: 'GET',
      url: `${scopeUrl}/jobs/${startedData.job.id}`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(job.statusCode).toBe(200);
  }
  const artifactUrl = `${scopeUrl}/artifacts/${startedData.artifact.id}`;
  const generated = await app.inject({
    method: 'GET',
    url: artifactUrl,
    headers: { cookie: `__Host-aeo_session=${session}` },
  });
  expect(generated.statusCode).toBe(200);
  const generatedData = generated.json<{
    data: {
      artifact: { id: string };
      revision: { id: string; revision: number; contentHash: string; status: string };
      payload: ArtifactPayload;
    };
  }>().data;
  expect(generatedData.revision.status).toBe('DRAFT');
  return { scopeUrl, artifactUrl, ...generatedData };
}

async function approveArtifact(
  app: ApiTestApp,
  session: string,
  generated: Awaited<ReturnType<typeof generateArtifact>>,
) {
  const headers = mutationHeaders(session);
  const submitted = await app.inject({
    method: 'POST',
    url: `${generated.artifactUrl}/revisions/${generated.revision.revision}/submit`,
    headers,
    payload: { expectedContentHash: generated.revision.contentHash },
  });
  expect(submitted.statusCode).toBe(200);
  const reviewed = await app.inject({
    method: 'POST',
    url: `${generated.artifactUrl}/revisions/${generated.revision.revision}/review`,
    headers,
    payload: {
      decision: 'APPROVE',
      expectedContentHash: generated.revision.contentHash,
      note: 'Exact channel handoff revision reviewed.',
    },
  });
  expect(reviewed.statusCode).toBe(200);
}

describe('Task 10 generic Channel Registry and publication core', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: ApiTestApp;
  let artifactStore: PostgresArtifactStore;
  let artifactPayloads: InMemoryArtifactPayloadStore;
  let channelPackagePayloads: InMemoryChannelPackagePayloadStore;
  let artifactWorker: ArtifactGenerationJobWorker;
  let packageOwnerSession: string;
  let packageScope: { tenant: { id: string }; workspace: { id: string } };
  const runtimeAdapterDescriptors = new Map<string, PublicationAdapterDescriptor>();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18.3-alpine3.23').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(
      pool,
      fileURLToPath(new URL('../../packages/db/migrations', import.meta.url)),
    );
    artifactStore = new PostgresArtifactStore(pool);
    artifactPayloads = new InMemoryArtifactPayloadStore();
    channelPackagePayloads = new InMemoryChannelPackagePayloadStore();
    const generation = new ArtifactGenerationHandler(
      artifactStore,
      new DeterministicArtifactGenerator(),
      artifactPayloads,
      { next: randomUUID },
      { now: () => new Date() },
    );
    const jobs = new PostgresJobBudgetStore(pool);
    artifactWorker = new ArtifactGenerationJobWorker(
      new JobWorkerCoordinator(
        jobs,
        { now: () => new Date() },
        { next: randomUUID },
        'task-10-artifact-generation-v1',
      ),
      generation,
    );
    app = await createApiApp({
      oidcClient,
      store: new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 10))),
      artifactStore,
      artifactPayloadStore: artifactPayloads,
      channelAuthorizationStore: new PostgresChannelAuthorizationStore(pool),
      channelPackageStore: new PostgresChannelPackageStore(pool),
      channelPackagePayloadStore: channelPackagePayloads,
      channelRegistryStore: new PostgresChannelRegistryStore(pool),
      jobBudgetStore: jobs,
      publicationCommandStore: new PostgresPublicationCommandStore(pool),
      publicationQueryStore: new PostgresPublicationQueryStore(pool),
      runtimeChannelAdapters: {
        resolve(adapterKey, adapterVersion) {
          const descriptor = runtimeAdapterDescriptors.get(`${adapterKey}@${adapterVersion}`);
          return descriptor === undefined
            ? null
            : {
                adapterKey,
                adapterVersion,
                describe: () => structuredClone(descriptor),
                validateAuthorization: () => Promise.resolve({ outcome: 'UNKNOWN' as const }),
                preview: (command) => ({
                  packageChecksum: command.channelPackage.packageChecksum,
                  files: structuredClone(command.payload.files),
                }),
                publish: () =>
                  Promise.resolve({
                    outcome: 'DEFINITELY_NOT_APPLIED' as const,
                    errorCode: 'API_ELIGIBILITY_ONLY_RUNTIME',
                  }),
                reconcile: () =>
                  Promise.resolve({
                    outcome: 'DEFINITELY_NOT_APPLIED' as const,
                    errorCode: 'API_ELIGIBILITY_ONLY_RUNTIME',
                  }),
                ...(descriptor.capabilities.includes('ROLLBACK')
                  ? {
                      rollback: (command: { remoteRef: string }) =>
                        Promise.resolve({
                          outcome: 'DEFINITELY_NOT_ROLLED_BACK' as const,
                          errorCode: command.remoteRef,
                        }),
                    }
                  : {}),
              };
        },
      },
      tenancyStore: new PostgresTenancyStore(pool),
      webOrigin: 'https://app.example.test',
    });
    packageOwnerSession = await signIn(app);
    packageScope = await createScope(app, packageOwnerSession, 'Task 10 package');
    await seedTask10ApprovedArtifactSource(pool, packageScope);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await container?.stop();
  });

  test('Channel Registry is dynamic, globally readable through a Workspace and runtime read-only', async () => {
    const ownerASession = await signIn(app);
    const scopeA = await createScope(app, ownerASession, 'Channel A');
    const registryUrl =
      `/api/v1/tenants/${scopeA.tenant.id}/workspaces/${scopeA.workspace.id}` + '/channels';
    const initial = await app.inject({
      method: 'GET',
      url: registryUrl,
      headers: { cookie: `__Host-aeo_session=${ownerASession}` },
    });
    expect(
      initial.statusCode,
      `expected dynamic Channel Registry, received ${initial.statusCode}: ${initial.body}`,
    ).toBe(200);

    const dynamicChannelId = randomUUID();
    await pool.query(
      `INSERT INTO channel_definitions
        (id, channel_key, display_name, status, unavailable_reason,
          package_transformer_key, package_schema_version)
       VALUES ($1, 'community-catalog-v17', 'Community Catalog V17', 'AVAILABLE', NULL,
         'generic-web-package', '1.0.0')`,
      [dynamicChannelId],
    );
    await pool.query(
      `INSERT INTO adapter_versions
        (id, channel_definition_id, adapter_key, adapter_version, enabled, disabled_reason,
          capabilities, required_scopes, terms_version, terms_status, processing_region,
          retention_policy, training_policy, subprocessors, rate_policy)
       VALUES ($1, $2, 'fixture-catalog-adapter', '17.4.2', true, NULL,
         ARRAY['DRAFT','PUBLISH','RECONCILE'], ARRAY['catalog.write'], '2026-07', 'ALLOWED',
         'Singapore', 'remote-managed', 'not-used-for-training', '[]'::jsonb,
         '{"requestsPerMinute": 30}'::jsonb)`,
      [randomUUID(), dynamicChannelId],
    );
    await pool.query(
      `INSERT INTO channel_definitions
        (id, channel_key, display_name, status, unavailable_reason,
          package_transformer_key, package_schema_version)
       VALUES ($1, 'portable-export-only', 'Portable Export Only', 'AVAILABLE', NULL,
         'generic-web-package', '1.0.0')`,
      [randomUUID()],
    );

    const response = await app.inject({
      method: 'GET',
      url: registryUrl,
      headers: { cookie: `__Host-aeo_session=${ownerASession}` },
    });
    expect(response.statusCode).toBe(200);
    const body = ChannelRegistryEnvelopeSchema.parse(response.json());
    expect(body.meta.schemaVersion).toBe('1.0.0');
    expect(
      body.data.entries.find((entry) => entry.channelKey === 'community-catalog-v17'),
    ).toMatchObject({
      adapterVersions: [{ adapterKey: 'fixture-catalog-adapter', adapterVersion: '17.4.2' }],
    });
    expect(
      body.data.entries.find((entry) => entry.channelKey === 'portable-export-only'),
    ).toMatchObject({
      adapterVersions: [],
    });
    const socialHandoff = body.data.entries.find(
      (entry) => entry.channelKey === 'social-channel-handoff',
    );
    expect(socialHandoff).toMatchObject({
      channelProfile: {
        channel: 'social-channel-handoff',
        profileVersion: '1.0.0',
        profileHash: '56bda296dfc9287991e75505bd05c61a4b417a2c864003f6710cb925e21d0bb4',
      },
      adapterVersions: [],
    });
    expect(socialHandoff?.channelProfile?.fieldRequirements).toContainEqual({
      field: 'post',
      sourcePointer: '/summary',
      required: true,
      minLength: 1,
      maxLength: 280,
      format: 'plain-text',
    });

    const ownerBSession = await signIn(app, 'channel-owner-b-code');
    const scopeB = await createScope(app, ownerBSession, 'Channel B');
    const guessed = await app.inject({
      method: 'GET',
      url: registryUrl,
      headers: { cookie: `__Host-aeo_session=${ownerBSession}` },
    });
    expect(guessed.statusCode).toBe(404);
    expect(guessed.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });
    const ownRegistry = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${scopeB.tenant.id}/workspaces/${scopeB.workspace.id}/channels`,
      headers: { cookie: `__Host-aeo_session=${ownerBSession}` },
    });
    expect(ownRegistry.statusCode).toBe(200);
    const ownRegistryBody = ChannelRegistryEnvelopeSchema.parse(ownRegistry.json());
    expect(
      ownRegistryBody.data.entries.some((entry) => entry.channelKey === 'community-catalog-v17'),
    ).toBe(true);
    expect((await app.inject({ method: 'GET', url: registryUrl })).statusCode).toBe(401);

    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('channel_definitions', 'channel_profiles', 'adapter_versions')
          AND column_name = 'tenant_id'`,
    );
    expect(columns.rows).toEqual([]);
    const privileges = await pool.query<{
      channel_select: boolean;
      channel_insert: boolean;
      profile_select: boolean;
      profile_insert: boolean;
      adapter_select: boolean;
      adapter_update: boolean;
    }>(
      `SELECT
         has_table_privilege('aeostudio_runtime', 'channel_definitions', 'SELECT') AS channel_select,
         has_table_privilege('aeostudio_runtime', 'channel_definitions', 'INSERT') AS channel_insert,
         has_table_privilege('aeostudio_runtime', 'channel_profiles', 'SELECT') AS profile_select,
         has_table_privilege('aeostudio_runtime', 'channel_profiles', 'INSERT') AS profile_insert,
         has_table_privilege('aeostudio_runtime', 'adapter_versions', 'SELECT') AS adapter_select,
         has_table_privilege('aeostudio_runtime', 'adapter_versions', 'UPDATE') AS adapter_update`,
    );
    expect(privileges.rows[0]).toEqual({
      channel_select: true,
      channel_insert: false,
      profile_select: true,
      profile_insert: false,
      adapter_select: true,
      adapter_update: false,
    });
  });

  test('only an exact approved Artifact becomes an immutable, complete, exportable Channel Package', async () => {
    const session = packageOwnerSession;
    const scope = packageScope;
    const generated = await generateArtifact(app, session, scope, artifactWorker);
    const packagesUrl = `${generated.scopeUrl}/channel-packages`;
    const packageRequest = {
      artifactId: generated.artifact.id,
      artifactRevisionId: generated.revision.id,
      revision: generated.revision.revision,
      expectedContentHash: generated.revision.contentHash,
      channelKey: 'portable-web-export',
    };

    await approveArtifact(app, session, generated);
    const built = await app.inject({
      method: 'POST',
      url: packagesUrl,
      headers: mutationHeaders(session),
      payload: packageRequest,
    });
    expect(
      built.statusCode,
      `expected manifest/hash package, received ${built.statusCode}: ${built.body}`,
    ).toBe(201);
    const document = built.json<{
      data: {
        package: {
          id: string;
          packageRevision: number;
          packageChecksum: string;
          channel: { channelKey: string };
          transformer: { key: string; version: string };
          artifact: {
            artifactId: string;
            artifactRevisionId: string;
            revision: number;
            contentHash: string;
          };
          manifest: {
            schemaVersion: string;
            files: Array<{ path: string; mediaType: string; sha256: string; byteLength: number }>;
            assetRefs: string[];
            claimSourceMap: Array<{
              claimRevisionId: string;
              evidence: Array<{ sourceId: string; snapshotId: string; sourceHash: string }>;
            }>;
          };
          preview: { markdown: string; html: string; jsonLd: Record<string, unknown> };
        };
      };
    }>();
    const channelPackage = document.data.package;
    expect(channelPackage).toMatchObject({
      packageRevision: 1,
      channel: { channelKey: 'portable-web-export' },
      transformer: { key: 'generic-web-package', version: '1.0.0' },
      artifact: {
        artifactId: generated.artifact.id,
        artifactRevisionId: generated.revision.id,
        revision: 1,
        contentHash: generated.revision.contentHash,
      },
      manifest: {
        schemaVersion: '1.0.0',
        assetRefs: [],
      },
    });
    expect(channelPackage.packageChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(channelPackage.manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'content.md', mediaType: 'text/markdown' }),
        expect.objectContaining({ path: 'content.html', mediaType: 'text/html' }),
        expect.objectContaining({ path: 'structured-data.json', mediaType: 'application/ld+json' }),
      ]),
    );
    for (const file of channelPackage.manifest.files) {
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(file.byteLength).toBeGreaterThan(0);
    }
    expect(channelPackage.manifest.claimSourceMap).toEqual([
      expect.objectContaining({
        claimRevisionId: FAKE_ARTIFACT_LINEAGE.claimRevisionId,
        evidence: [
          expect.objectContaining({
            sourceId: FAKE_ARTIFACT_LINEAGE.evidenceSourceId,
            snapshotId: FAKE_ARTIFACT_LINEAGE.evidenceSnapshotId,
            sourceHash: FAKE_ARTIFACT_LINEAGE.evidenceHash,
          }),
        ],
      }),
    ]);
    expect(channelPackage.preview.markdown).toContain(generated.payload.title);
    expect(channelPackage.preview.html).toContain(generated.payload.title);
    expect(channelPackage.preview.jsonLd).toMatchObject({ '@context': 'https://schema.org' });

    const repeated = await app.inject({
      method: 'POST',
      url: packagesUrl,
      headers: mutationHeaders(session),
      payload: packageRequest,
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({
      data: {
        package: { id: channelPackage.id, packageChecksum: channelPackage.packageChecksum },
      },
    });

    const fetchedPreview = await app.inject({
      method: 'GET',
      url: `${packagesUrl}/${channelPackage.id}`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(fetchedPreview.statusCode).toBe(200);
    expect(fetchedPreview.json()).toMatchObject({
      data: {
        package: {
          id: channelPackage.id,
          packageRevision: 1,
          packageChecksum: channelPackage.packageChecksum,
          preview: channelPackage.preview,
        },
      },
    });

    const exported = await app.inject({
      method: 'GET',
      url: `${packagesUrl}/${channelPackage.id}/export`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain(
      'application/vnd.aeostudio.channel-package+json',
    );
    expect(exported.headers['content-disposition']).toBe(
      `attachment; filename="channel-package-${channelPackage.id}.json"`,
    );
    expect(exported.json()).toMatchObject({
      packageChecksum: channelPackage.packageChecksum,
      files: {
        'content.md': channelPackage.preview.markdown,
        'content.html': channelPackage.preview.html,
      },
    });

    const revised = await app.inject({
      method: 'POST',
      url: `${generated.artifactUrl}/revisions`,
      headers: mutationHeaders(session),
      payload: {
        expectedRevision: 1,
        payload: { ...generated.payload, summary: `${generated.payload.summary} Updated.` },
      },
    });
    expect(revised.statusCode).toBe(201);
    const revisionTwo = revised.json<{
      data: { revision: { id: string; revision: number; contentHash: string } };
    }>().data.revision;
    const staleEligibility = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications/eligibility`,
      headers: mutationHeaders(session),
      payload: {
        channelPackageId: channelPackage.id,
        target: 'https://example.test/reviewed-handoff',
        expectedPackageChecksum: channelPackage.packageChecksum,
      },
    });
    expect(staleEligibility.statusCode).toBe(409);
    expect(staleEligibility.json()).toMatchObject({ code: 'APPROVAL_STALE' });
    const stalePublication = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications`,
      headers: mutationHeaders(session),
      payload: {
        channelPackageId: channelPackage.id,
        target: 'https://example.test/reviewed-handoff',
        expectedPackageChecksum: channelPackage.packageChecksum,
        idempotencyKey: `stale-package-${randomUUID()}`,
      },
    });
    expect(stalePublication.statusCode).toBe(409);
    expect(stalePublication.json()).toMatchObject({ code: 'APPROVAL_STALE' });
    const historicalExport = await app.inject({
      method: 'GET',
      url: `${packagesUrl}/${channelPackage.id}/export`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(historicalExport.statusCode).toBe(200);
    expect(historicalExport.json()).toMatchObject({
      packageChecksum: channelPackage.packageChecksum,
    });
    const rejectedDraft = await app.inject({
      method: 'POST',
      url: packagesUrl,
      headers: mutationHeaders(session),
      payload: {
        ...packageRequest,
        artifactRevisionId: revisionTwo.id,
        revision: revisionTwo.revision,
        expectedContentHash: revisionTwo.contentHash,
      },
    });
    expect(rejectedDraft.statusCode).toBe(409);
    expect(rejectedDraft.json()).toMatchObject({ code: 'APPROVAL_REQUIRED' });

    const persisted = await pool.query<{
      artifact_revision: number;
      artifact_content_hash: string;
      package_checksum: string;
    }>(
      `SELECT artifact_revision, artifact_content_hash, package_checksum
       FROM channel_packages WHERE id = $1`,
      [channelPackage.id],
    );
    expect(persisted.rows).toEqual([
      {
        artifact_revision: 1,
        artifact_content_hash: generated.revision.contentHash,
        package_checksum: channelPackage.packageChecksum,
      },
    ]);
    await expect(
      pool.query(`UPDATE channel_packages SET package_checksum = $1 WHERE id = $2`, [
        '0'.repeat(64),
        channelPackage.id,
      ]),
    ).rejects.toThrow(/CHANNEL_PACKAGE_IMMUTABLE|permission denied/i);
  });

  test('a versioned data-driven Channel Profile produces a reviewed adaptation package with exact lineage', async () => {
    const generated = await generateArtifact(
      app,
      packageOwnerSession,
      packageScope,
      artifactWorker,
    );
    await approveArtifact(app, packageOwnerSession, generated);

    const suffix = randomUUID().slice(0, 8);
    const channelId = randomUUID();
    const profileId = randomUUID();
    const channel = `review-handoff-${suffix}`;
    const profileVersion = `2026.07.${suffix}`;
    const fieldRequirements = [
      {
        field: 'headline',
        sourcePointer: '/title',
        required: true,
        minLength: 1,
        maxLength: 120,
        format: 'plain-text',
      },
      {
        field: 'body',
        sourcePointer: '/summary',
        required: true,
        minLength: 1,
        maxLength: 2_000,
        format: 'plain-text',
      },
      {
        field: 'disclosure',
        sourcePointer: '/disclosure',
        required: true,
        minLength: 1,
        maxLength: 800,
        format: 'plain-text',
      },
    ];
    const profileHash = createHash('sha256')
      .update(
        canonicalArtifactJson({
          channel,
          fieldRequirements,
          profileVersion,
        }),
        'utf8',
      )
      .digest('hex');

    await pool.query(
      `INSERT INTO channel_definitions
        (id, channel_key, display_name, status, unavailable_reason,
          package_transformer_key, package_schema_version)
       VALUES ($1, $2, 'Review handoff fixture', 'AVAILABLE', NULL,
         'generic-web-package', '1.1.0')`,
      [channelId, channel],
    );
    await pool.query(
      `INSERT INTO channel_profiles
        (id, channel_definition_id, channel, profile_version, profile_hash, field_requirements)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        profileId,
        channelId,
        channel,
        profileVersion,
        profileHash,
        JSON.stringify(fieldRequirements),
      ],
    );
    await pool.query(
      `UPDATE channel_definitions
       SET current_channel_profile_id = $1
       WHERE id = $2`,
      [profileId, channelId],
    );

    const built = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/channel-packages`,
      headers: mutationHeaders(packageOwnerSession),
      payload: {
        artifactId: generated.artifact.id,
        artifactRevisionId: generated.revision.id,
        revision: generated.revision.revision,
        expectedContentHash: generated.revision.contentHash,
        channelKey: channel,
      },
    });
    expect(
      built.statusCode,
      `expected adaptation package, received ${built.statusCode}: ${built.body}`,
    ).toBe(201);
    const channelPackage = ChannelPackageEnvelopeSchema.parse(built.json()).data.package;
    expect(channelPackage.manifest.channelProfile).toEqual({
      channel,
      profileVersion,
      profileHash,
      fieldRequirements,
    });
    expect(channelPackage.manifest.files.map((file) => file.path).sort()).toEqual([
      'content.html',
      'content.md',
      'fields.json',
      'post.txt',
      'structured-data.json',
      'submission-checklist.md',
    ]);

    const exported = await app.inject({
      method: 'GET',
      url: `${generated.scopeUrl}/channel-packages/${channelPackage.id}/export`,
      headers: { cookie: `__Host-aeo_session=${packageOwnerSession}` },
    });
    expect(exported.statusCode).toBe(200);
    const packageExport = ChannelPackageExportSchema.parse(exported.json());
    expect(packageExport.files['post.txt']).toContain(generated.payload.title);
    expect(packageExport.files['post.txt']).toContain(generated.payload.summary);
    expect(packageExport.files['post.txt']).toContain(generated.payload.disclosure);
    expect(packageExport.files['submission-checklist.md']).toContain(
      'Review required before external publication',
    );
    expect(packageExport.files['submission-checklist.md']).toContain(profileHash);

    const fieldsFile = packageExport.files['fields.json'];
    if (fieldsFile === undefined) throw new Error('CHANNEL_PROFILE_FIELDS_FILE_MISSING');
    const fields = JSON.parse(fieldsFile) as {
      channel: string;
      profileVersion: string;
      profileHash: string;
      reviewedBeforePublish: boolean;
      fields: Array<{
        field: string;
        sourcePointer: string;
        value: string;
        requirements: {
          required: boolean;
          minLength: number | null;
          maxLength: number | null;
          format: string;
        };
      }>;
      lineage: {
        artifact: {
          artifactId: string;
          artifactRevisionId: string;
          revision: number;
          contentHash: string;
        };
        claims: Array<{
          claimRevisionId: string;
          evidence: Array<{ sourceId: string; snapshotId: string; sourceHash: string }>;
        }>;
      };
    };
    expect(fields).toMatchObject({
      channel,
      profileVersion,
      profileHash,
      reviewedBeforePublish: true,
      fields: [
        {
          field: 'headline',
          sourcePointer: '/title',
          value: generated.payload.title,
          requirements: {
            required: true,
            minLength: 1,
            maxLength: 120,
            format: 'plain-text',
          },
        },
        {
          field: 'body',
          sourcePointer: '/summary',
          value: generated.payload.summary,
          requirements: {
            required: true,
            minLength: 1,
            maxLength: 2_000,
            format: 'plain-text',
          },
        },
        {
          field: 'disclosure',
          sourcePointer: '/disclosure',
          value: generated.payload.disclosure,
          requirements: {
            required: true,
            minLength: 1,
            maxLength: 800,
            format: 'plain-text',
          },
        },
      ],
      lineage: {
        artifact: {
          artifactId: generated.artifact.id,
          artifactRevisionId: generated.revision.id,
          revision: generated.revision.revision,
          contentHash: generated.revision.contentHash,
        },
        claims: [
          {
            claimRevisionId: FAKE_ARTIFACT_LINEAGE.claimRevisionId,
            evidence: [
              {
                sourceId: FAKE_ARTIFACT_LINEAGE.evidenceSourceId,
                snapshotId: FAKE_ARTIFACT_LINEAGE.evidenceSnapshotId,
                sourceHash: FAKE_ARTIFACT_LINEAGE.evidenceHash,
              },
            ],
          },
        ],
      },
    });

    const nextFieldRequirements = fieldRequirements.map((requirement) =>
      requirement.field === 'headline' ? { ...requirement, maxLength: 100 } : requirement,
    );
    const nextProfileVersion = `${profileVersion}.2`;
    const nextProfileHash = createHash('sha256')
      .update(
        canonicalArtifactJson({
          channel,
          fieldRequirements: nextFieldRequirements,
          profileVersion: nextProfileVersion,
        }),
        'utf8',
      )
      .digest('hex');
    const nextProfileId = randomUUID();
    await pool.query(
      `INSERT INTO channel_profiles
        (id, channel_definition_id, channel, profile_version, profile_hash, field_requirements)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        nextProfileId,
        channelId,
        channel,
        nextProfileVersion,
        nextProfileHash,
        JSON.stringify(nextFieldRequirements),
      ],
    );
    await pool.query(
      `UPDATE channel_definitions
       SET current_channel_profile_id = $1
       WHERE id = $2`,
      [nextProfileId, channelId],
    );

    const rebuilt = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/channel-packages`,
      headers: mutationHeaders(packageOwnerSession),
      payload: {
        artifactId: generated.artifact.id,
        artifactRevisionId: generated.revision.id,
        revision: generated.revision.revision,
        expectedContentHash: generated.revision.contentHash,
        channelKey: channel,
      },
    });
    expect(rebuilt.statusCode).toBe(201);
    const nextPackage = ChannelPackageEnvelopeSchema.parse(rebuilt.json()).data.package;
    expect(nextPackage).toMatchObject({
      packageRevision: 2,
      manifest: {
        channelProfile: {
          channel,
          profileVersion: nextProfileVersion,
          profileHash: nextProfileHash,
          fieldRequirements: nextFieldRequirements,
        },
      },
    });
    expect(nextPackage.id).not.toBe(channelPackage.id);
    expect(nextPackage.packageChecksum).not.toBe(channelPackage.packageChecksum);

    const persistedProfiles = await pool.query<{
      id: string;
      channel_profile_hash: string;
      manifest_profile_hash: string;
    }>(
      `SELECT
         id,
         channel_profile_hash,
         manifest->'channelProfile'->>'profileHash' AS manifest_profile_hash
       FROM channel_packages
       WHERE tenant_id = $1 AND workspace_id = $2
         AND artifact_id = $3 AND channel_definition_id = $4
       ORDER BY package_revision`,
      [packageScope.tenant.id, packageScope.workspace.id, generated.artifact.id, channelId],
    );
    expect(persistedProfiles.rows).toEqual([
      {
        id: channelPackage.id,
        channel_profile_hash: profileHash,
        manifest_profile_hash: profileHash,
      },
      {
        id: nextPackage.id,
        channel_profile_hash: nextProfileHash,
        manifest_profile_hash: nextProfileHash,
      },
    ]);
  });

  test('a concurrent R2 committed during package payload I/O rejects the stale R1 build', async () => {
    const generated = await generateArtifact(
      app,
      packageOwnerSession,
      packageScope,
      artifactWorker,
    );
    await approveArtifact(app, packageOwnerSession, generated);

    const packagePayloads = new InMemoryChannelPackagePayloadStore();
    const payloadWriteEntered = deferred<void>();
    const releasePayloadWrite = deferred<void>();
    const blockingPackagePayloads: ChannelPackagePayloadStore = {
      async put(input) {
        payloadWriteEntered.resolve();
        await releasePayloadWrite.promise;
        return packagePayloads.put(input);
      },
      get(objectRef) {
        return packagePayloads.get(objectRef);
      },
    };
    const fenceApp = await createApiApp({
      oidcClient,
      store: new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 10))),
      artifactStore,
      artifactPayloadStore: artifactPayloads,
      artifactPayloadReader: artifactPayloads,
      channelPackageStore: new PostgresChannelPackageStore(pool),
      channelPackagePayloadStore: blockingPackagePayloads,
      channelPackagePayloadReader: packagePayloads,
      channelRegistryStore: new PostgresChannelRegistryStore(pool),
      tenancyStore: new PostgresTenancyStore(pool),
      webOrigin: 'https://app.example.test',
    });
    const packageRequest = {
      artifactId: generated.artifact.id,
      artifactRevisionId: generated.revision.id,
      revision: generated.revision.revision,
      expectedContentHash: generated.revision.contentHash,
      channelKey: 'portable-web-export',
    };

    try {
      const building = fenceApp.inject({
        method: 'POST',
        url: `${generated.scopeUrl}/channel-packages`,
        headers: mutationHeaders(packageOwnerSession),
        payload: packageRequest,
      });
      await payloadWriteEntered.promise;

      const revised = await app.inject({
        method: 'POST',
        url: `${generated.artifactUrl}/revisions`,
        headers: mutationHeaders(packageOwnerSession),
        payload: {
          expectedRevision: generated.revision.revision,
          payload: { ...generated.payload, summary: `${generated.payload.summary} Concurrent R2.` },
        },
      });
      expect(revised.statusCode).toBe(201);
      releasePayloadWrite.resolve();

      const staleBuild = await building;
      expect(
        staleBuild.statusCode,
        `expected a stale R1 rejection, received ${staleBuild.statusCode}: ${staleBuild.body}`,
      ).toBe(409);
      expect(staleBuild.json()).toMatchObject({ code: 'APPROVAL_STALE' });

      const persisted = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM channel_packages
         WHERE tenant_id = $1 AND workspace_id = $2 AND artifact_id = $3`,
        [packageScope.tenant.id, packageScope.workspace.id, generated.artifact.id],
      );
      expect(persisted.rows[0]?.count).toBe('0');
    } finally {
      releasePayloadWrite.resolve();
      await fenceApp.close();
    }
  });

  test('a Prompt lineage change committed during package payload I/O rejects the stale package', async () => {
    const generated = await generateArtifact(
      app,
      packageOwnerSession,
      packageScope,
      artifactWorker,
    );
    await approveArtifact(app, packageOwnerSession, generated);

    const packagePayloads = new InMemoryChannelPackagePayloadStore();
    const payloadWriteEntered = deferred<void>();
    const releasePayloadWrite = deferred<void>();
    const blockingPackagePayloads: ChannelPackagePayloadStore = {
      async put(input) {
        payloadWriteEntered.resolve();
        await releasePayloadWrite.promise;
        return packagePayloads.put(input);
      },
      get(objectRef) {
        return packagePayloads.get(objectRef);
      },
    };
    const fenceApp = await createApiApp({
      oidcClient,
      store: new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 10))),
      artifactStore,
      artifactPayloadStore: artifactPayloads,
      artifactPayloadReader: artifactPayloads,
      channelPackageStore: new PostgresChannelPackageStore(pool),
      channelPackagePayloadStore: blockingPackagePayloads,
      channelPackagePayloadReader: packagePayloads,
      channelRegistryStore: new PostgresChannelRegistryStore(pool),
      tenancyStore: new PostgresTenancyStore(pool),
      webOrigin: 'https://app.example.test',
    });

    try {
      const building = fenceApp.inject({
        method: 'POST',
        url: `${generated.scopeUrl}/channel-packages`,
        headers: mutationHeaders(packageOwnerSession),
        payload: {
          artifactId: generated.artifact.id,
          artifactRevisionId: generated.revision.id,
          revision: generated.revision.revision,
          expectedContentHash: generated.revision.contentHash,
          channelKey: 'portable-web-export',
        },
      });
      await payloadWriteEntered.promise;

      await pool.query(`UPDATE prompt_sets SET current_revision = 2 WHERE id = $1`, [
        FAKE_ARTIFACT_LINEAGE.promptSetId,
      ]);
      releasePayloadWrite.resolve();

      const staleBuild = await building;
      expect(
        staleBuild.statusCode,
        `expected a stale Prompt lineage rejection, received ${staleBuild.statusCode}: ${staleBuild.body}`,
      ).toBe(409);
      expect(staleBuild.json()).toMatchObject({ code: 'APPROVAL_STALE' });

      const persisted = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM channel_packages
         WHERE tenant_id = $1 AND workspace_id = $2 AND artifact_id = $3`,
        [packageScope.tenant.id, packageScope.workspace.id, generated.artifact.id],
      );
      expect(persisted.rows[0]?.count).toBe('0');
    } finally {
      releasePayloadWrite.resolve();
      await pool.query(`UPDATE prompt_sets SET current_revision = 1 WHERE id = $1`, [
        FAKE_ARTIFACT_LINEAGE.promptSetId,
      ]);
      await fenceApp.close();
    }
  });

  test('an evidence currentness change committed during package payload I/O rejects the stale package', async () => {
    const generated = await generateArtifact(
      app,
      packageOwnerSession,
      packageScope,
      artifactWorker,
    );
    await approveArtifact(app, packageOwnerSession, generated);

    const packagePayloads = new InMemoryChannelPackagePayloadStore();
    const payloadWriteEntered = deferred<void>();
    const releasePayloadWrite = deferred<void>();
    const blockingPackagePayloads: ChannelPackagePayloadStore = {
      async put(input) {
        payloadWriteEntered.resolve();
        await releasePayloadWrite.promise;
        return packagePayloads.put(input);
      },
      get(objectRef) {
        return packagePayloads.get(objectRef);
      },
    };
    const fenceApp = await createApiApp({
      oidcClient,
      store: new PostgresAuthStore(pool, new AesGcmSessionCipher(Buffer.alloc(32, 10))),
      artifactStore,
      artifactPayloadStore: artifactPayloads,
      artifactPayloadReader: artifactPayloads,
      channelPackageStore: new PostgresChannelPackageStore(pool),
      channelPackagePayloadStore: blockingPackagePayloads,
      channelPackagePayloadReader: packagePayloads,
      channelRegistryStore: new PostgresChannelRegistryStore(pool),
      tenancyStore: new PostgresTenancyStore(pool),
      webOrigin: 'https://app.example.test',
    });

    try {
      const building = fenceApp.inject({
        method: 'POST',
        url: `${generated.scopeUrl}/channel-packages`,
        headers: mutationHeaders(packageOwnerSession),
        payload: {
          artifactId: generated.artifact.id,
          artifactRevisionId: generated.revision.id,
          revision: generated.revision.revision,
          expectedContentHash: generated.revision.contentHash,
          channelKey: 'portable-web-export',
        },
      });
      await payloadWriteEntered.promise;

      await pool.query(`UPDATE evidence_sources SET current_snapshot_id = NULL WHERE id = $1`, [
        FAKE_ARTIFACT_LINEAGE.evidenceSourceId,
      ]);
      releasePayloadWrite.resolve();

      const staleBuild = await building;
      expect(
        staleBuild.statusCode,
        `expected a stale evidence rejection, received ${staleBuild.statusCode}: ${staleBuild.body}`,
      ).toBe(409);
      expect(staleBuild.json()).toMatchObject({ code: 'APPROVAL_STALE' });

      const persisted = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM channel_packages
         WHERE tenant_id = $1 AND workspace_id = $2 AND artifact_id = $3`,
        [packageScope.tenant.id, packageScope.workspace.id, generated.artifact.id],
      );
      expect(persisted.rows[0]?.count).toBe('0');
    } finally {
      releasePayloadWrite.resolve();
      await pool.query(`UPDATE evidence_sources SET current_snapshot_id = $1 WHERE id = $2`, [
        FAKE_ARTIFACT_LINEAGE.evidenceSnapshotId,
        FAKE_ARTIFACT_LINEAGE.evidenceSourceId,
      ]);
      await fenceApp.close();
    }
  });

  test('a publish click without Channel authorization stays EXPORT_ONLY with zero publication side effects', async () => {
    const session = packageOwnerSession;
    const scope = packageScope;
    const generated = await generateArtifact(app, session, scope, artifactWorker);
    await approveArtifact(app, session, generated);

    const suffix = randomUUID().slice(0, 8);
    const channelId = randomUUID();
    const adapterVersionId = randomUUID();
    const channelKey = `fixture-publish-${suffix}`;
    await pool.query(
      `INSERT INTO channel_definitions
        (id, channel_key, display_name, status, unavailable_reason,
          package_transformer_key, package_schema_version)
       VALUES ($1, $2, 'Fixture publish channel', 'AVAILABLE', NULL,
         'generic-web-package', '1.0.0')`,
      [channelId, channelKey],
    );
    await pool.query(
      `INSERT INTO adapter_versions
        (id, channel_definition_id, adapter_key, adapter_version, enabled, disabled_reason,
          capabilities, required_scopes, terms_version, terms_status, processing_region,
          retention_policy, training_policy, subprocessors, rate_policy)
       VALUES ($1, $2, $3, '1.0.0', true, NULL,
         ARRAY['PUBLISH','RECONCILE','ROLLBACK'], ARRAY['fixture.publish'], '2026-07', 'ALLOWED',
         'Singapore', 'ephemeral-fixture', 'not-used-for-training', '[]'::jsonb,
         '{"requestsPerMinute": 10}'::jsonb)`,
      [adapterVersionId, channelId, `fixture-adapter-${suffix}`],
    );

    const packageResponse = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/channel-packages`,
      headers: mutationHeaders(session),
      payload: {
        artifactId: generated.artifact.id,
        artifactRevisionId: generated.revision.id,
        revision: generated.revision.revision,
        expectedContentHash: generated.revision.contentHash,
        channelKey,
      },
    });
    expect(packageResponse.statusCode).toBe(201);
    const channelPackage = packageResponse.json<{
      data: { package: { id: string; packageChecksum: string } };
    }>().data.package;

    const publish = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications`,
      headers: mutationHeaders(session),
      payload: {
        channelPackageId: channelPackage.id,
        adapterVersionId,
        target: 'fixture://catalog/main',
        expectedPackageChecksum: channelPackage.packageChecksum,
        idempotencyKey: `missing-auth-${suffix}`,
      },
    });
    expect(
      publish.statusCode,
      `expected EXPORT_ONLY, received publish attempt; HTTP ${publish.statusCode}: ${publish.body}`,
    ).toBe(409);
    const publishBody = ExportOnlyPublicationProblemSchema.parse(publish.json());
    expect(publishBody).toMatchObject({
      code: 'EXPORT_ONLY',
      eligibility: {
        mode: 'EXPORT_ONLY',
        packageId: channelPackage.id,
        packageChecksum: channelPackage.packageChecksum,
      },
      export: {
        href: `${generated.scopeUrl}/channel-packages/${channelPackage.id}/export`,
        packageChecksum: channelPackage.packageChecksum,
      },
    });
    expect(publishBody.eligibility.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'AUTHORIZATION_MISSING' })]),
    );
    expect(publish.body).not.toMatch(/PUBLISHED|remoteRef|credential|token|secretArn/i);

    const sideEffects = await pool.query<{
      publications: string;
      attempts: string;
      publication_jobs: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM publication_records
           WHERE tenant_id = $1 AND workspace_id = $2) AS publications,
         (SELECT count(*)::text FROM publication_attempts
           WHERE tenant_id = $1 AND workspace_id = $2) AS attempts,
         (SELECT count(*)::text FROM jobs
           WHERE tenant_id = $1 AND workspace_id = $2 AND job_type = 'PUBLICATION')
           AS publication_jobs`,
      [scope.tenant.id, scope.workspace.id],
    );
    expect(sideEffects.rows[0]).toEqual({
      publications: '0',
      attempts: '0',
      publication_jobs: '0',
    });
  });

  test('a profiled Registry Channel with no Adapter remains a reviewed export-only handoff', async () => {
    const session = packageOwnerSession;
    const scope = packageScope;
    const generated = await generateArtifact(app, session, scope, artifactWorker);
    await approveArtifact(app, session, generated);
    const packageResponse = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/channel-packages`,
      headers: mutationHeaders(session),
      payload: {
        artifactId: generated.artifact.id,
        artifactRevisionId: generated.revision.id,
        revision: generated.revision.revision,
        expectedContentHash: generated.revision.contentHash,
        channelKey: 'social-channel-handoff',
      },
    });
    expect(packageResponse.statusCode).toBe(201);
    const channelPackage = ChannelPackageEnvelopeSchema.parse(packageResponse.json()).data.package;
    expect(channelPackage.manifest.channelProfile).toMatchObject({
      channel: 'social-channel-handoff',
      profileVersion: '1.0.0',
    });
    expect(channelPackage.manifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['post.txt', 'fields.json', 'submission-checklist.md']),
    );

    const publish = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications`,
      headers: mutationHeaders(session),
      payload: {
        channelPackageId: channelPackage.id,
        target: 'review-after-export',
        expectedPackageChecksum: channelPackage.packageChecksum,
        idempotencyKey: `no-adapter-${randomUUID()}`,
      },
    });
    expect(
      publish.statusCode,
      `expected EXPORT_ONLY for missing Adapter, received ${publish.statusCode}: ${publish.body}`,
    ).toBe(409);
    const body = ExportOnlyPublicationProblemSchema.parse(publish.json());
    expect(body.eligibility.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'ADAPTER_NOT_FOUND' })]),
    );
    expect(body.export).toMatchObject({
      href: `${generated.scopeUrl}/channel-packages/${channelPackage.id}/export`,
      packageChecksum: channelPackage.packageChecksum,
    });
    expect(publish.body).not.toMatch(/PUBLISHED|remoteRef|publicationId/i);

    const exported = await app.inject({
      method: 'GET',
      url: body.export.href,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(exported.statusCode).toBe(200);
    const packageExport = ChannelPackageExportSchema.parse(exported.json());
    expect(packageExport.files['post.txt']).toContain(generated.payload.summary);
    expect(packageExport.files['fields.json']).toContain(generated.revision.contentHash);
    expect(packageExport.files['submission-checklist.md']).toContain(
      'Review required before external publication',
    );

    const effects = await pool.query<{ publications: string; attempts: string; jobs: string }>(
      `SELECT
         (SELECT count(*)::text FROM publication_records
           WHERE tenant_id = $1 AND workspace_id = $2) AS publications,
         (SELECT count(*)::text FROM publication_attempts
           WHERE tenant_id = $1 AND workspace_id = $2) AS attempts,
         (SELECT count(*)::text FROM jobs
           WHERE tenant_id = $1 AND workspace_id = $2 AND job_type = 'PUBLICATION') AS jobs`,
      [scope.tenant.id, scope.workspace.id],
    );
    expect(effects.rows[0]).toEqual({ publications: '0', attempts: '0', jobs: '0' });
  });

  test('an Owner configures only redacted Channel authorization metadata backed by a secret ARN', async () => {
    const session = packageOwnerSession;
    const scope = packageScope;
    const scopeUrl = `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}`;
    const suffix = randomUUID().slice(0, 8);
    const channelId = randomUUID();
    const adapterVersionId = randomUUID();
    await pool.query(
      `INSERT INTO channel_definitions
        (id, channel_key, display_name, status, unavailable_reason,
          package_transformer_key, package_schema_version)
       VALUES ($1, $2, 'Authorization fixture channel', 'AVAILABLE', NULL,
         'generic-web-package', '1.0.0')`,
      [channelId, `fixture-authorization-${suffix}`],
    );
    await pool.query(
      `INSERT INTO adapter_versions
        (id, channel_definition_id, adapter_key, adapter_version, enabled, disabled_reason,
          capabilities, required_scopes, terms_version, terms_status, processing_region,
          retention_policy, training_policy, subprocessors, rate_policy)
       VALUES ($1, $2, $3, '1.0.0', true, NULL,
         ARRAY['PUBLISH','RECONCILE'], ARRAY['fixture.publish'], '2026-07', 'ALLOWED',
         'Singapore', 'ephemeral-fixture', 'not-used-for-training', '[]'::jsonb,
         '{"requestsPerMinute": 10}'::jsonb)`,
      [adapterVersionId, channelId, `fixture-authorization-adapter-${suffix}`],
    );
    const secretArn =
      `arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:` +
      `aeostudio/${scope.workspace.id}/${suffix}`;
    const expiresAt = '2027-07-21T00:00:00.000Z';
    const created = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/channel-authorizations`,
      headers: mutationHeaders(session),
      payload: {
        adapterVersionId,
        target: 'fixture://catalog/main',
        grantedScopes: ['fixture.publish'],
        acceptedTermsVersion: '2026-07',
        secretArn,
        expiresAt,
      },
    });
    expect(
      created.statusCode,
      `expected redacted authorization metadata, received ${created.statusCode}: ${created.body}`,
    ).toBe(201);
    const authorization = created.json<{
      data: {
        authorization: {
          id: string;
          adapterVersionId: string;
          status: string;
          target: string;
          grantedScopes: string[];
          acceptedTermsVersion: string;
          expiresAt: string;
          secretConfigured: boolean;
        };
      };
    }>().data.authorization;
    expect(authorization).toMatchObject({
      adapterVersionId,
      status: 'ACTIVE',
      target: 'fixture://catalog/main',
      grantedScopes: ['fixture.publish'],
      acceptedTermsVersion: '2026-07',
      expiresAt,
      secretConfigured: true,
    });
    expect(created.body).not.toContain(secretArn);
    expect(created.body).not.toMatch(/secretArn|secretRef|credential|token/i);

    const listed = await app.inject({
      method: 'GET',
      url: `${scopeUrl}/channel-authorizations`,
      headers: { cookie: `__Host-aeo_session=${session}` },
    });
    expect(listed.statusCode).toBe(200);
    const listedBody = ChannelAuthorizationListEnvelopeSchema.parse(listed.json());
    expect(listedBody.data.authorizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: authorization.id,
          adapterVersionId,
          secretConfigured: true,
        }),
      ]),
    );
    expect(listed.body).not.toContain(secretArn);

    const persisted = await pool.query<{
      secret_arn: string;
      adapter_version_id: string;
      target: string;
    }>(
      `SELECT secret_arn, adapter_version_id, target
       FROM channel_authorizations WHERE id = $1`,
      [authorization.id],
    );
    expect(persisted.rows).toEqual([
      {
        secret_arn: secretArn,
        adapter_version_id: adapterVersionId,
        target: 'fixture://catalog/main',
      },
    ]);
    const audit = await pool.query<{ document: string }>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(event))::text, '[]') AS document
       FROM audit_events event
       WHERE tenant_id = $1 AND workspace_id = $2`,
      [scope.tenant.id, scope.workspace.id],
    );
    expect(audit.rows[0]?.document).not.toContain(secretArn);

    const otherUserSession = await signIn(app, 'channel-owner-b-code');
    const guessed = await app.inject({
      method: 'GET',
      url: `${scopeUrl}/channel-authorizations`,
      headers: { cookie: `__Host-aeo_session=${otherUserSession}` },
    });
    expect(guessed.statusCode).toBe(404);
    expect(guessed.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });
  });

  test('an Owner revokes a Channel authorization through an idempotent public command', async () => {
    const session = packageOwnerSession;
    const scope = packageScope;
    const scopeUrl = `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}`;
    const suffix = randomUUID().slice(0, 8);
    const channelId = randomUUID();
    const adapterVersionId = randomUUID();
    await pool.query(
      `INSERT INTO channel_definitions
        (id, channel_key, display_name, status, unavailable_reason,
          package_transformer_key, package_schema_version)
       VALUES ($1, $2, 'Revocable authorization fixture', 'AVAILABLE', NULL,
         'generic-web-package', '1.0.0')`,
      [channelId, `fixture-revocable-${suffix}`],
    );
    await pool.query(
      `INSERT INTO adapter_versions
        (id, channel_definition_id, adapter_key, adapter_version, enabled, disabled_reason,
          capabilities, required_scopes, terms_version, terms_status, processing_region,
          retention_policy, training_policy, subprocessors, rate_policy)
       VALUES ($1, $2, $3, '1.0.0', true, NULL,
         ARRAY['PUBLISH','RECONCILE'], ARRAY['fixture.publish'], '2026-07', 'ALLOWED',
         'Singapore', 'ephemeral-fixture', 'not-used-for-training', '[]'::jsonb,
         '{"requestsPerMinute": 10}'::jsonb)`,
      [adapterVersionId, channelId, `fixture-revocable-adapter-${suffix}`],
    );
    const secretArn =
      `arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:` +
      `revocable/${scope.workspace.id}/${suffix}`;
    const created = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/channel-authorizations`,
      headers: mutationHeaders(session),
      payload: {
        adapterVersionId,
        target: `fixture://revocable/${suffix}`,
        grantedScopes: ['fixture.publish'],
        acceptedTermsVersion: '2026-07',
        secretArn,
        expiresAt: '2027-07-21T00:00:00.000Z',
      },
    });
    expect(created.statusCode).toBe(201);
    const authorizationId = ChannelAuthorizationEnvelopeSchema.parse(created.json()).data
      .authorization.id;
    const revokeUrl = `${scopeUrl}/channel-authorizations/${authorizationId}/revoke`;

    const wrongWorkspaceClient = await pool.connect();
    try {
      await wrongWorkspaceClient.query('BEGIN');
      await wrongWorkspaceClient.query('SET LOCAL ROLE aeostudio_runtime');
      await wrongWorkspaceClient.query(
        `SELECT
          set_config('app.tenant_id', $1, true),
          set_config('app.workspace_id', $2, true),
          set_config('app.actor_id', $3, true)`,
        [scope.tenant.id, randomUUID(), randomUUID()],
      );
      const wrongWorkspaceMutation = await wrongWorkspaceClient.query(
        `UPDATE channel_authorizations
         SET status = 'REVOKED', updated_at = now()
         WHERE id = $1`,
        [authorizationId],
      );
      expect(
        wrongWorkspaceMutation.rowCount,
        'expected RLS to scope Channel authorization mutation to the active Workspace',
      ).toBe(0);
    } finally {
      await wrongWorkspaceClient.query('ROLLBACK');
      wrongWorkspaceClient.release();
    }

    const otherTenantSession = await signIn(app, 'channel-owner-b-code');
    const crossTenant = await app.inject({
      method: 'POST',
      url: revokeUrl,
      headers: mutationHeaders(otherTenantSession),
      payload: {},
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });

    const revoked = await app.inject({
      method: 'POST',
      url: revokeUrl,
      headers: mutationHeaders(session),
      payload: {},
    });
    expect(
      revoked.statusCode,
      `expected an idempotent revoke command, received ${revoked.statusCode}: ${revoked.body}`,
    ).toBe(200);
    expect(
      ChannelAuthorizationEnvelopeSchema.parse(revoked.json()).data.authorization,
    ).toMatchObject({
      id: authorizationId,
      adapterVersionId,
      status: 'REVOKED',
      target: `fixture://revocable/${suffix}`,
      grantedScopes: ['fixture.publish'],
      acceptedTermsVersion: '2026-07',
      secretConfigured: true,
    });
    expect(revoked.body).not.toContain(secretArn);

    const repeated = await app.inject({
      method: 'POST',
      url: revokeUrl,
      headers: mutationHeaders(session),
      payload: {},
    });
    expect(repeated.statusCode).toBe(200);
    expect(
      ChannelAuthorizationEnvelopeSchema.parse(repeated.json()).data.authorization,
    ).toMatchObject({ id: authorizationId, status: 'REVOKED' });
    expect(repeated.body).not.toContain(secretArn);

    const malformed = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/channel-authorizations/not-a-uuid/revoke`,
      headers: mutationHeaders(session),
      payload: {},
    });
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });

    const audit = await pool.query<{ event_count: string; document: string }>(
      `SELECT count(*)::text AS event_count,
         COALESCE(jsonb_agg(to_jsonb(event))::text, '[]') AS document
       FROM audit_events event
       WHERE tenant_id = $1 AND workspace_id = $2
         AND action = 'CHANNEL_AUTHORIZATION_REVOKED'
         AND resource_type = 'CHANNEL_AUTHORIZATION'
         AND resource_id = $3`,
      [scope.tenant.id, scope.workspace.id, authorizationId],
    );
    expect(audit.rows[0]?.event_count).toBe('1');
    expect(audit.rows[0]?.document).not.toContain(secretArn);

    const privileges = await pool.query<{
      status_update: boolean;
      updated_at_update: boolean;
      target_update: boolean;
      secret_update: boolean;
      adapter_update: boolean;
    }>(
      `SELECT
         has_column_privilege(
           'aeostudio_runtime', 'channel_authorizations', 'status', 'UPDATE'
         ) AS status_update,
         has_column_privilege(
           'aeostudio_runtime', 'channel_authorizations', 'updated_at', 'UPDATE'
         ) AS updated_at_update,
         has_column_privilege(
           'aeostudio_runtime', 'channel_authorizations', 'target', 'UPDATE'
         ) AS target_update,
         has_column_privilege(
           'aeostudio_runtime', 'channel_authorizations', 'secret_arn', 'UPDATE'
         ) AS secret_update,
         has_column_privilege(
           'aeostudio_runtime', 'channel_authorizations', 'adapter_version_id', 'UPDATE'
         ) AS adapter_update`,
    );
    expect(privileges.rows[0]).toEqual({
      status_update: true,
      updated_at_update: true,
      target_update: false,
      secret_update: false,
      adapter_update: false,
    });

    const runtimeClient = await pool.connect();
    try {
      await runtimeClient.query('BEGIN');
      await runtimeClient.query('SET LOCAL ROLE aeostudio_runtime');
      await runtimeClient.query(
        `SELECT
          set_config('app.tenant_id', $1, true),
          set_config('app.workspace_id', $2, true),
          set_config('app.actor_id', $3, true)`,
        [scope.tenant.id, scope.workspace.id, randomUUID()],
      );
      await expect(
        runtimeClient.query(
          `UPDATE channel_authorizations
           SET status = 'ACTIVE', updated_at = now()
           WHERE id = $1`,
          [authorizationId],
        ),
        'expected authorization lifecycle to allow only ACTIVE -> REVOKED',
      ).rejects.toThrow(/CHANNEL_AUTHORIZATION_TRANSITION_FORBIDDEN/);
    } finally {
      await runtimeClient.query('ROLLBACK');
      runtimeClient.release();
    }

    const persisted = await pool.query<{
      status: string;
      adapter_version_id: string;
      target: string;
      secret_arn: string;
    }>(
      `SELECT status, adapter_version_id, target, secret_arn
       FROM channel_authorizations WHERE id = $1`,
      [authorizationId],
    );
    expect(persisted.rows[0]).toEqual({
      status: 'REVOKED',
      adapter_version_id: adapterVersionId,
      target: `fixture://revocable/${suffix}`,
      secret_arn: secretArn,
    });
  });

  test('an Admin manages the complete Channel authorization lifecycle', async () => {
    const ownerSession = packageOwnerSession;
    const scope = packageScope;
    const scopeUrl = `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}`;
    const invitation = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/invitations`,
      headers: mutationHeaders(ownerSession),
      payload: { email: 'channel-admin@example.test', role: 'ADMIN' },
    });
    expect(invitation.statusCode).toBe(201);
    const membershipId = invitation.json<{
      data: { membership: { id: string } };
    }>().data.membership.id;
    const adminSession = await signIn(app, 'channel-admin-code');
    const accepted = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/memberships/${membershipId}/accept`,
      headers: mutationHeaders(adminSession),
      payload: {},
    });
    expect(accepted.statusCode).toBe(200);

    const suffix = randomUUID().slice(0, 8);
    const channelId = randomUUID();
    const adapterVersionId = randomUUID();
    await pool.query(
      `INSERT INTO channel_definitions
        (id, channel_key, display_name, status, unavailable_reason,
          package_transformer_key, package_schema_version)
       VALUES ($1, $2, 'Admin authorization fixture', 'AVAILABLE', NULL,
         'generic-web-package', '1.0.0')`,
      [channelId, `fixture-admin-auth-${suffix}`],
    );
    await pool.query(
      `INSERT INTO adapter_versions
        (id, channel_definition_id, adapter_key, adapter_version, enabled, disabled_reason,
          capabilities, required_scopes, terms_version, terms_status, processing_region,
          retention_policy, training_policy, subprocessors, rate_policy)
       VALUES ($1, $2, $3, '1.0.0', true, NULL,
         ARRAY['PUBLISH','RECONCILE'], ARRAY['fixture.publish'], '2026-07', 'ALLOWED',
         'Singapore', 'ephemeral-fixture', 'not-used-for-training', '[]'::jsonb,
         '{"requestsPerMinute": 10}'::jsonb)`,
      [adapterVersionId, channelId, `fixture-admin-auth-adapter-${suffix}`],
    );
    const secretArn =
      `arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:` +
      `admin/${scope.workspace.id}/${suffix}`;
    const created = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/channel-authorizations`,
      headers: mutationHeaders(adminSession),
      payload: {
        adapterVersionId,
        target: `fixture://admin/${suffix}`,
        grantedScopes: [],
        acceptedTermsVersion: '2026-07',
        secretArn,
      },
    });
    expect(
      created.statusCode,
      `expected Admin authorization management, received ${created.statusCode}: ${created.body}`,
    ).toBe(201);
    const authorizationId = ChannelAuthorizationEnvelopeSchema.parse(created.json()).data
      .authorization.id;
    expect(
      ChannelAuthorizationEnvelopeSchema.parse(created.json()).data.authorization,
    ).toMatchObject({ grantedScopes: [], expiresAt: null });

    const listed = await app.inject({
      method: 'GET',
      url: `${scopeUrl}/channel-authorizations`,
      headers: { cookie: `__Host-aeo_session=${adminSession}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(ChannelAuthorizationListEnvelopeSchema.parse(listed.json()).data.authorizations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: authorizationId, status: 'ACTIVE' })]),
    );

    const revoked = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/channel-authorizations/${authorizationId}/revoke`,
      headers: mutationHeaders(adminSession),
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    expect(
      ChannelAuthorizationEnvelopeSchema.parse(revoked.json()).data.authorization,
    ).toMatchObject({ id: authorizationId, status: 'REVOKED' });
    expect(`${created.body}${listed.body}${revoked.body}`).not.toContain(secretArn);
  });

  test('Editor, Reviewer, and Publisher cannot manage Channel authorizations', async () => {
    const ownerSession = packageOwnerSession;
    const scope = packageScope;
    const scopeUrl = `/api/v1/tenants/${scope.tenant.id}/workspaces/${scope.workspace.id}`;
    const suffix = randomUUID().slice(0, 8);
    const channelId = randomUUID();
    const adapterVersionId = randomUUID();
    await pool.query(
      `INSERT INTO channel_definitions
        (id, channel_key, display_name, status, unavailable_reason,
          package_transformer_key, package_schema_version)
       VALUES ($1, $2, 'Authorization RBAC fixture', 'AVAILABLE', NULL,
         'generic-web-package', '1.0.0')`,
      [channelId, `fixture-auth-rbac-${suffix}`],
    );
    await pool.query(
      `INSERT INTO adapter_versions
        (id, channel_definition_id, adapter_key, adapter_version, enabled, disabled_reason,
          capabilities, required_scopes, terms_version, terms_status, processing_region,
          retention_policy, training_policy, subprocessors, rate_policy)
       VALUES ($1, $2, $3, '1.0.0', true, NULL,
         ARRAY['PUBLISH','RECONCILE'], ARRAY[]::text[], '2026-07', 'ALLOWED',
         'Singapore', 'ephemeral-fixture', 'not-used-for-training', '[]'::jsonb,
         '{"requestsPerMinute": 10}'::jsonb)`,
      [adapterVersionId, channelId, `fixture-auth-rbac-adapter-${suffix}`],
    );
    const secretArn =
      `arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:` +
      `rbac/${scope.workspace.id}/${suffix}`;
    const created = await app.inject({
      method: 'POST',
      url: `${scopeUrl}/channel-authorizations`,
      headers: mutationHeaders(ownerSession),
      payload: {
        adapterVersionId,
        target: `fixture://rbac/${suffix}`,
        grantedScopes: [],
        acceptedTermsVersion: '2026-07',
        secretArn,
        expiresAt: null,
      },
    });
    expect(created.statusCode).toBe(201);
    const authorizationId = ChannelAuthorizationEnvelopeSchema.parse(created.json()).data
      .authorization.id;
    const restrictedActors = [
      {
        role: 'EDITOR',
        email: 'authorization-editor@example.test',
        code: 'authorization-editor-code',
      },
      {
        role: 'REVIEWER',
        email: 'authorization-reviewer@example.test',
        code: 'authorization-reviewer-code',
      },
      {
        role: 'PUBLISHER',
        email: 'authorization-publisher@example.test',
        code: 'authorization-publisher-code',
      },
    ] as const;

    for (const actor of restrictedActors) {
      const invitation = await app.inject({
        method: 'POST',
        url: `${scopeUrl}/invitations`,
        headers: mutationHeaders(ownerSession),
        payload: { email: actor.email, role: actor.role },
      });
      expect(invitation.statusCode).toBe(201);
      const membershipId = invitation.json<{
        data: { membership: { id: string } };
      }>().data.membership.id;
      const session = await signIn(app, actor.code);
      const accepted = await app.inject({
        method: 'POST',
        url: `${scopeUrl}/memberships/${membershipId}/accept`,
        headers: mutationHeaders(session),
        payload: {},
      });
      expect(accepted.statusCode).toBe(200);

      const deniedCreate = await app.inject({
        method: 'POST',
        url: `${scopeUrl}/channel-authorizations`,
        headers: mutationHeaders(session),
        payload: {
          adapterVersionId,
          target: `fixture://rbac/${suffix}/${actor.role.toLowerCase()}`,
          grantedScopes: [],
          acceptedTermsVersion: '2026-07',
          secretArn,
          expiresAt: null,
        },
      });
      expect(deniedCreate.statusCode).toBe(403);

      const deniedList = await app.inject({
        method: 'GET',
        url: `${scopeUrl}/channel-authorizations`,
        headers: { cookie: `__Host-aeo_session=${session}` },
      });
      expect(deniedList.statusCode).toBe(403);

      const deniedRevoke = await app.inject({
        method: 'POST',
        url: `${scopeUrl}/channel-authorizations/${authorizationId}/revoke`,
        headers: mutationHeaders(session),
        payload: {},
      });
      expect(deniedRevoke.statusCode).toBe(403);
      expect(`${deniedCreate.body}${deniedList.body}${deniedRevoke.body}`).not.toContain(secretArn);
    }

    const ownerView = await app.inject({
      method: 'GET',
      url: `${scopeUrl}/channel-authorizations`,
      headers: { cookie: `__Host-aeo_session=${ownerSession}` },
    });
    expect(ownerView.statusCode).toBe(200);
    expect(
      ChannelAuthorizationListEnvelopeSchema.parse(ownerView.json()).data.authorizations,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: authorizationId, status: 'ACTIVE' })]),
    );
    const deniedAudits = await pool.query<{ event_count: string }>(
      `SELECT count(*)::text AS event_count
       FROM audit_events
       WHERE tenant_id = $1 AND workspace_id = $2
         AND action = 'CHANNEL_AUTHORIZATION_REVOKE'
         AND resource_type = 'CHANNEL_AUTHORIZATION'
         AND outcome = 'DENIED'`,
      [scope.tenant.id, scope.workspace.id],
    );
    expect(deniedAudits.rows[0]?.event_count).toBe('3');
  });

  test('disabled, expired, terms-blocked, under-scoped, and undeployed Adapters all stay EXPORT_ONLY', async () => {
    const session = packageOwnerSession;
    const scope = packageScope;
    const generated = await generateArtifact(app, session, scope, artifactWorker);
    await approveArtifact(app, session, generated);
    const actor = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM memberships
       WHERE tenant_id = $1 AND status = 'ACTIVE'
       ORDER BY created_at LIMIT 1`,
      [scope.tenant.id],
    );
    const actorUserId = actor.rows[0]?.user_id;
    if (actorUserId === undefined) throw new Error('TASK_10_OWNER_NOT_FOUND');

    const cases = [
      {
        name: 'disabled',
        enabled: false,
        termsStatus: 'ALLOWED',
        capabilities: ['PUBLISH', 'RECONCILE'],
        grantedScopes: ['fixture.publish'],
        expiresAt: '2027-07-21T00:00:00.000Z',
        runtime: true,
        expectedReason: 'ADAPTER_DISABLED',
      },
      {
        name: 'expired',
        enabled: true,
        termsStatus: 'ALLOWED',
        capabilities: ['PUBLISH', 'RECONCILE'],
        grantedScopes: ['fixture.publish'],
        expiresAt: '2025-07-21T00:00:00.000Z',
        runtime: true,
        expectedReason: 'AUTHORIZATION_EXPIRED',
      },
      {
        name: 'terms',
        enabled: true,
        termsStatus: 'PROHIBITED',
        capabilities: ['PUBLISH', 'RECONCILE'],
        grantedScopes: ['fixture.publish'],
        expiresAt: '2027-07-21T00:00:00.000Z',
        runtime: true,
        expectedReason: 'TERMS_NOT_APPROVED',
      },
      {
        name: 'scope',
        enabled: true,
        termsStatus: 'ALLOWED',
        capabilities: ['PUBLISH', 'RECONCILE'],
        grantedScopes: ['fixture.read'],
        expiresAt: '2027-07-21T00:00:00.000Z',
        runtime: true,
        expectedReason: 'AUTHORIZATION_SCOPE_INSUFFICIENT',
      },
      {
        name: 'runtime',
        enabled: true,
        termsStatus: 'ALLOWED',
        capabilities: ['PUBLISH', 'RECONCILE'],
        grantedScopes: ['fixture.publish'],
        expiresAt: '2027-07-21T00:00:00.000Z',
        runtime: false,
        expectedReason: 'ADAPTER_RUNTIME_UNAVAILABLE',
      },
      {
        name: 'reconcile-capability',
        enabled: true,
        termsStatus: 'ALLOWED',
        capabilities: ['PUBLISH'],
        grantedScopes: ['fixture.publish'],
        expiresAt: '2027-07-21T00:00:00.000Z',
        runtime: true,
        expectedReason: 'RECONCILE_CAPABILITY_MISSING',
      },
      {
        name: 'runtime-governance-drift',
        enabled: true,
        termsStatus: 'ALLOWED',
        capabilities: ['PUBLISH', 'RECONCILE'],
        grantedScopes: ['fixture.publish'],
        expiresAt: '2027-07-21T00:00:00.000Z',
        runtime: true,
        runtimeGovernanceDrift: true,
        expectedReason: 'ADAPTER_RUNTIME_METADATA_MISMATCH',
      },
    ] as const;

    const before = await pool.query<{ publications: string; attempts: string; jobs: string }>(
      `SELECT
         (SELECT count(*)::text FROM publication_records
           WHERE tenant_id = $1 AND workspace_id = $2) AS publications,
         (SELECT count(*)::text FROM publication_attempts
           WHERE tenant_id = $1 AND workspace_id = $2) AS attempts,
         (SELECT count(*)::text FROM jobs
           WHERE tenant_id = $1 AND workspace_id = $2 AND job_type = 'PUBLICATION') AS jobs`,
      [scope.tenant.id, scope.workspace.id],
    );

    for (const fixture of cases) {
      const suffix = randomUUID().slice(0, 8);
      const channelId = randomUUID();
      const adapterVersionId = randomUUID();
      const adapterKey = `fixture-${fixture.name}-${suffix}`;
      const channelKey = `fixture-${fixture.name}-channel-${suffix}`;
      const target = `fixture://catalog/${fixture.name}-${suffix}`;
      await pool.query(
        `INSERT INTO channel_definitions
          (id, channel_key, display_name, status, unavailable_reason,
            package_transformer_key, package_schema_version)
         VALUES ($1, $2, $3, 'AVAILABLE', NULL, 'generic-web-package', '1.0.0')`,
        [channelId, channelKey, `${fixture.name} fixture Channel`],
      );
      await pool.query(
        `INSERT INTO adapter_versions
          (id, channel_definition_id, adapter_key, adapter_version, enabled, disabled_reason,
            capabilities, required_scopes, terms_version, terms_status, processing_region,
            retention_policy, training_policy, subprocessors, rate_policy)
         VALUES ($1, $2, $3, '1.0.0', $4, $5,
           $6, ARRAY['fixture.publish'], '2026-07', $7,
           'Singapore', 'ephemeral-fixture', 'not-used-for-training', '[]'::jsonb,
           '{"requestsPerMinute": 10}'::jsonb)`,
        [
          adapterVersionId,
          channelId,
          adapterKey,
          fixture.enabled,
          fixture.enabled ? null : 'Fixture Adapter disabled.',
          fixture.capabilities,
          fixture.termsStatus,
        ],
      );
      if (fixture.runtime) {
        runtimeAdapterDescriptors.set(`${adapterKey}@1.0.0`, {
          adapterKey,
          adapterVersion: '1.0.0',
          capabilities: [...fixture.capabilities],
          requiredScopes: ['fixture.publish'],
          termsVersion: '2026-07',
          processingRegion: 'Singapore',
          retentionPolicy:
            'runtimeGovernanceDrift' in fixture ? 'drifted-runtime-retention' : 'ephemeral-fixture',
          trainingPolicy: 'not-used-for-training',
          subprocessors: [],
          ratePolicy: { requestsPerMinute: 10 },
        });
      }

      const built = await app.inject({
        method: 'POST',
        url: `${generated.scopeUrl}/channel-packages`,
        headers: mutationHeaders(session),
        payload: {
          artifactId: generated.artifact.id,
          artifactRevisionId: generated.revision.id,
          revision: generated.revision.revision,
          expectedContentHash: generated.revision.contentHash,
          channelKey,
        },
      });
      expect(built.statusCode).toBe(201);
      const channelPackage = built.json<{
        data: { package: { id: string; packageChecksum: string } };
      }>().data.package;
      const authorizationId = randomUUID();
      await pool.query(
        `INSERT INTO channel_authorizations
          (id, tenant_id, workspace_id, adapter_version_id, status, secret_arn,
            granted_scopes, accepted_terms_version, target, expires_at,
            created_by_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6, '2026-07', $7, $8, $9, now(), now())`,
        [
          authorizationId,
          scope.tenant.id,
          scope.workspace.id,
          adapterVersionId,
          `arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:matrix/${suffix}`,
          fixture.grantedScopes,
          target,
          fixture.expiresAt,
          actorUserId,
        ],
      );
      const publish = await app.inject({
        method: 'POST',
        url: `${generated.scopeUrl}/publications`,
        headers: mutationHeaders(session),
        payload: {
          channelPackageId: channelPackage.id,
          adapterVersionId,
          target,
          expectedPackageChecksum: channelPackage.packageChecksum,
          idempotencyKey: `matrix-${fixture.name}-${suffix}`,
        },
      });
      expect(
        publish.statusCode,
        `expected EXPORT_ONLY for ${fixture.name}, received ${publish.statusCode}: ${publish.body}`,
      ).toBe(409);
      const problem = ExportOnlyPublicationProblemSchema.parse(publish.json());
      expect(problem.eligibility.reasons).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: fixture.expectedReason })]),
      );
      expect(publish.body).not.toMatch(/PUBLISHED|remoteRef|credential|token|secretArn/i);
    }

    const after = await pool.query<{ publications: string; attempts: string; jobs: string }>(
      `SELECT
         (SELECT count(*)::text FROM publication_records
           WHERE tenant_id = $1 AND workspace_id = $2) AS publications,
         (SELECT count(*)::text FROM publication_attempts
           WHERE tenant_id = $1 AND workspace_id = $2) AS attempts,
         (SELECT count(*)::text FROM jobs
           WHERE tenant_id = $1 AND workspace_id = $2 AND job_type = 'PUBLICATION') AS jobs`,
      [scope.tenant.id, scope.workspace.id],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  test('an eligible Publisher command creates one durable Publication intent despite duplicate clicks', async () => {
    const ownerSession = packageOwnerSession;
    const scope = packageScope;
    const generated = await generateArtifact(app, ownerSession, scope, artifactWorker);
    await approveArtifact(app, ownerSession, generated);
    const suffix = randomUUID().slice(0, 8);
    const channelId = randomUUID();
    const adapterVersionId = randomUUID();
    const adapterKey = `fixture-command-adapter-${suffix}`;
    const channelKey = `fixture-command-channel-${suffix}`;
    const target = `fixture://catalog/command-${suffix}`;
    const secretSentinel = 'TASK10_SECRET_SENTINEL_DO_NOT_PERSIST';
    runtimeAdapterDescriptors.set(`${adapterKey}@1.0.0`, {
      adapterKey,
      adapterVersion: '1.0.0',
      capabilities: ['PUBLISH', 'RECONCILE', 'ROLLBACK'],
      requiredScopes: ['fixture.publish'],
      termsVersion: '2026-07',
      processingRegion: 'Singapore',
      retentionPolicy: 'ephemeral-fixture',
      trainingPolicy: 'not-used-for-training',
      subprocessors: [],
      ratePolicy: { requestsPerMinute: 10 },
    });
    await pool.query(
      `INSERT INTO channel_definitions
        (id, channel_key, display_name, status, unavailable_reason,
          package_transformer_key, package_schema_version)
       VALUES ($1, $2, 'Publication command fixture', 'AVAILABLE', NULL,
         'generic-web-package', '1.0.0')`,
      [channelId, channelKey],
    );
    await pool.query(
      `INSERT INTO adapter_versions
        (id, channel_definition_id, adapter_key, adapter_version, enabled, disabled_reason,
          capabilities, required_scopes, terms_version, terms_status, processing_region,
          retention_policy, training_policy, subprocessors, rate_policy)
       VALUES ($1, $2, $3, '1.0.0', true, NULL,
         ARRAY['PUBLISH','RECONCILE','ROLLBACK'], ARRAY['fixture.publish'], '2026-07', 'ALLOWED',
         'Singapore', 'ephemeral-fixture', 'not-used-for-training', '[]'::jsonb,
         '{"requestsPerMinute": 10}'::jsonb)`,
      [adapterVersionId, channelId, adapterKey],
    );
    const built = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/channel-packages`,
      headers: mutationHeaders(ownerSession),
      payload: {
        artifactId: generated.artifact.id,
        artifactRevisionId: generated.revision.id,
        revision: generated.revision.revision,
        expectedContentHash: generated.revision.contentHash,
        channelKey,
      },
    });
    expect(built.statusCode).toBe(201);
    const channelPackage = built.json<{
      data: {
        package: {
          id: string;
          packageChecksum: string;
          artifact: { artifactRevisionId: string; contentHash: string };
        };
      };
    }>().data.package;
    const secretArn =
      `arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:` + `publication/${suffix}`;
    const createActiveAuthorization = async () => {
      const response = await app.inject({
        method: 'POST',
        url: `${generated.scopeUrl}/channel-authorizations`,
        headers: mutationHeaders(ownerSession),
        payload: {
          adapterVersionId,
          target,
          grantedScopes: ['fixture.publish'],
          acceptedTermsVersion: '2026-07',
          secretArn,
          expiresAt: '2027-07-21T00:00:00.000Z',
        },
      });
      expect(response.statusCode).toBe(201);
      const authorizationId = response.json<{ data: { authorization: { id: string } } }>().data
        .authorization.id;
      const database = await pool.connect();
      try {
        await database.query('BEGIN');
        await database.query(
          `SELECT set_config(
             'app.channel_authorization_validation_transition',
             'authorized',
             true
           )`,
        );
        const verified = await database.query(
          `UPDATE channel_authorizations
           SET validation_status = 'VERIFIED',
               validation_actual_target = $2,
               validation_actual_scopes = ARRAY['fixture.publish'],
               validation_terms_version = '2026-07',
               validation_credential_fingerprint = $3,
               validated_at = now(),
               validation_valid_until = now() + interval '1 hour',
               validation_failure_code = NULL,
               updated_at = now()
           WHERE id = $1
             AND validation_status = 'PENDING_VALIDATION'`,
          [authorizationId, target, createHash('sha256').update(secretSentinel).digest('hex')],
        );
        expect(verified.rowCount).toBe(1);
        await database.query(
          `UPDATE channel_authorization_validation_commands
           SET status = 'COMPLETED',
               worker_id = 'task-10-provider-validation-fixture',
               lease_token = $2,
               lease_expires_at = now() + interval '1 minute',
               attempt_count = 1,
               completed_at = now()
           WHERE authorization_id = $1`,
          [authorizationId, randomUUID()],
        );
        await database.query('COMMIT');
      } catch (error) {
        await database.query('ROLLBACK');
        throw error;
      } finally {
        database.release();
      }
      return authorizationId;
    };
    let authorizationId = await createActiveAuthorization();

    const invitation = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/invitations`,
      headers: mutationHeaders(ownerSession),
      payload: { email: 'channel-publisher@example.test', role: 'PUBLISHER' },
    });
    expect(invitation.statusCode).toBe(201);
    const membershipId = invitation.json<{
      data: { membership: { id: string } };
    }>().data.membership.id;
    const publisherSession = await signIn(app, 'channel-publisher-code');
    const accepted = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/memberships/${membershipId}/accept`,
      headers: mutationHeaders(publisherSession),
      payload: {},
    });
    expect(accepted.statusCode).toBe(200);
    const publisher = await pool.query<{ user_id: string }>(
      `SELECT identity.user_id
       FROM external_identities identity
       WHERE identity.subject = 'channel-publisher-subject'`,
    );
    const publisherUserId = publisher.rows[0]?.user_id;
    if (publisherUserId === undefined) throw new Error('TASK_10_PUBLISHER_NOT_FOUND');

    const idempotencyKey = `publication-command-${suffix}`;
    const request = {
      channelPackageId: channelPackage.id,
      adapterVersionId,
      target,
      expectedPackageChecksum: channelPackage.packageChecksum,
      idempotencyKey,
    };
    const beforeEligibility = await pool.query<{
      publications: string;
      attempts: string;
      jobs: string;
      outbox: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM publication_records
           WHERE tenant_id = $1 AND workspace_id = $2) AS publications,
         (SELECT count(*)::text FROM publication_attempts
           WHERE tenant_id = $1 AND workspace_id = $2) AS attempts,
         (SELECT count(*)::text FROM jobs
           WHERE tenant_id = $1 AND workspace_id = $2 AND job_type = 'PUBLICATION') AS jobs,
         (SELECT count(*)::text FROM outbox_messages
           WHERE tenant_id = $1 AND workspace_id = $2 AND message_type = 'JOB_QUEUED'
             AND aggregate_id IN (
               SELECT id FROM jobs WHERE tenant_id = $1 AND workspace_id = $2
                 AND job_type = 'PUBLICATION'
             )) AS outbox`,
      [scope.tenant.id, scope.workspace.id],
    );
    const eligibility = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications/eligibility`,
      headers: mutationHeaders(publisherSession),
      payload: {
        channelPackageId: request.channelPackageId,
        adapterVersionId: request.adapterVersionId,
        target: request.target,
        expectedPackageChecksum: request.expectedPackageChecksum,
      },
    });
    expect(
      eligibility.statusCode,
      `expected side-effect-free PUBLISH_READY eligibility, received ${eligibility.statusCode}: ${eligibility.body}`,
    ).toBe(200);
    expect(PublicationEligibilityEnvelopeSchema.parse(eligibility.json()).data).toMatchObject({
      eligibility: {
        mode: 'PUBLISH_READY',
        packageId: channelPackage.id,
        packageChecksum: channelPackage.packageChecksum,
        adapterVersionId,
        channelAuthorizationId: authorizationId,
      },
      export: {
        href: `${generated.scopeUrl}/channel-packages/${channelPackage.id}/export`,
        packageChecksum: channelPackage.packageChecksum,
      },
    });
    const invalidEligibility = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications/eligibility`,
      headers: mutationHeaders(publisherSession),
      payload: request,
    });
    expect(invalidEligibility.statusCode).toBe(400);
    const maliciousLowEstimate = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications`,
      headers: mutationHeaders(publisherSession),
      payload: {
        ...request,
        idempotencyKey: `client-underestimate-${suffix}`,
        estimatedUnits: 1,
      },
    });
    expect(maliciousLowEstimate.statusCode).toBe(400);
    expect(maliciousLowEstimate.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    const afterEligibility = await pool.query<{
      publications: string;
      attempts: string;
      jobs: string;
      outbox: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM publication_records
           WHERE tenant_id = $1 AND workspace_id = $2) AS publications,
         (SELECT count(*)::text FROM publication_attempts
           WHERE tenant_id = $1 AND workspace_id = $2) AS attempts,
         (SELECT count(*)::text FROM jobs
           WHERE tenant_id = $1 AND workspace_id = $2 AND job_type = 'PUBLICATION') AS jobs,
         (SELECT count(*)::text FROM outbox_messages
           WHERE tenant_id = $1 AND workspace_id = $2 AND message_type = 'JOB_QUEUED'
             AND aggregate_id IN (
               SELECT id FROM jobs WHERE tenant_id = $1 AND workspace_id = $2
                 AND job_type = 'PUBLICATION'
             )) AS outbox`,
      [scope.tenant.id, scope.workspace.id],
    );
    expect(afterEligibility.rows[0]).toEqual(beforeEligibility.rows[0]);
    const first = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications`,
      headers: mutationHeaders(publisherSession),
      payload: request,
    });
    expect(
      first.statusCode,
      `expected one queued Publisher publication, received ${first.statusCode}: ${first.body}`,
    ).toBe(202);
    const firstData = first.json<{
      data: {
        publication: {
          id: string;
          status: string;
          channelPackageId: string;
          packageChecksum: string;
          artifactRevisionId: string;
          artifactContentHash: string;
          adapterVersionId: string;
          channelAuthorizationId: string;
          target: string;
          idempotencyKey: string;
          remoteRef: string | null;
          requestedByUserId: string;
        };
        job: {
          id: string;
          jobType: string;
          aggregateId: string;
          status: string;
          estimatedUnits: number;
        };
        created: boolean;
      };
    }>().data;
    expect(firstData.created).toBe(true);
    expect(firstData).toMatchObject({
      publication: {
        status: 'QUEUED',
        channelPackageId: channelPackage.id,
        packageChecksum: channelPackage.packageChecksum,
        artifactRevisionId: channelPackage.artifact.artifactRevisionId,
        artifactContentHash: channelPackage.artifact.contentHash,
        adapterVersionId,
        channelAuthorizationId: authorizationId,
        target,
        idempotencyKey,
        remoteRef: null,
        requestedByUserId: publisherUserId,
      },
      job: { jobType: 'PUBLICATION', status: 'QUEUED', estimatedUnits: 5 },
    });
    expect(firstData.job.aggregateId).toBe(firstData.publication.id);

    const duplicate = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications`,
      headers: mutationHeaders(publisherSession),
      payload: request,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      data: {
        publication: { id: firstData.publication.id },
        job: { id: firstData.job.id },
        created: false,
      },
    });

    const conflictingReuse = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications`,
      headers: mutationHeaders(publisherSession),
      payload: { ...request, target: `${request.target}/different` },
    });
    expect(conflictingReuse.statusCode).toBe(409);
    expect(conflictingReuse.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const persisted = await pool.query<{
      publication_count: string;
      attempt_count: string;
      job_count: string;
      outbox_count: string;
      publication_actor: string;
      job_actor: string;
      provider_key: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT
         (SELECT count(*)::text FROM publication_records WHERE id = $1) AS publication_count,
         (SELECT count(*)::text FROM publication_attempts WHERE publication_id = $1) AS attempt_count,
         (SELECT count(*)::text FROM jobs WHERE id = $2) AS job_count,
         (SELECT count(*)::text FROM outbox_messages WHERE aggregate_id = $2) AS outbox_count,
         (SELECT requested_by_user_id::text FROM publication_records WHERE id = $1)
           AS publication_actor,
         (SELECT requested_by_user_id::text FROM jobs WHERE id = $2) AS job_actor,
         (SELECT provider_key FROM jobs WHERE id = $2) AS provider_key,
         (SELECT payload FROM outbox_messages WHERE aggregate_id = $2 LIMIT 1) AS payload`,
      [firstData.publication.id, firstData.job.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      publication_count: '1',
      attempt_count: '0',
      job_count: '1',
      outbox_count: '1',
      publication_actor: publisherUserId,
      job_actor: publisherUserId,
      provider_key: adapterKey,
    });
    expect(Object.keys(persisted.rows[0]?.payload ?? {}).sort()).toEqual([
      'jobId',
      'schemaVersion',
      'tenantId',
      'workspaceId',
    ]);
    expect(first.body).not.toMatch(/secretArn|credential|token/i);

    type AdapterCommand = {
      publicationId: string;
      idempotencyKey: string;
      target: string;
      channelPackage: {
        id: string;
        packageChecksum: string;
        artifact: { artifactRevisionId: string; contentHash: string };
      };
      payload: { files: Record<string, string> };
      secretValue: string;
    };
    type FixtureAdapter = {
      adapterKey: string;
      adapterVersion: string;
      describe(): { adapterKey: string; adapterVersion: string; capabilities: string[] };
      validateAuthorization(
        command: AdapterCommand,
      ): Promise<{ outcome: 'VALID' | 'INVALID' | 'UNKNOWN' }>;
      preview(command: AdapterCommand): {
        packageChecksum: string;
        files: Record<string, string>;
      };
      publish(
        command: AdapterCommand,
      ): Promise<
        | { outcome: 'AMBIGUOUS' | 'RETRYABLE_FAILURE'; errorCode: string }
        | { outcome: 'TERMINAL_FAILURE'; errorCode: string }
      >;
      reconcile(
        command: AdapterCommand,
      ): Promise<
        | { outcome: 'APPLIED'; remoteRef: string }
        | { outcome: 'DEFINITELY_NOT_APPLIED'; errorCode: string }
        | { outcome: 'RETRYABLE_FAILURE' | 'TERMINAL_FAILURE'; errorCode: string }
      >;
      rollback(command: AdapterCommand): Promise<{
        outcome: 'ROLLED_BACK';
        remoteRef: string;
      }>;
    };
    type PublicationHandlerConstructor = new (
      store: unknown,
      payloads: {
        readPublicationPackage(input: {
          access: { publicationId: string; leaseToken: string };
          expected: { objectRef: string };
        }): ReturnType<InMemoryChannelPackagePayloadStore['get']>;
      },
      adapters: { resolve(adapterKey: string, adapterVersion: string): FixtureAdapter | null },
      authorizationMaterials: {
        readForPublication(input: { lease: JobLease }): Promise<{
          secretReference: string;
          credentialFingerprint: string;
        } | null>;
      },
      secrets: {
        readPublicationSecret(input: {
          access: { publicationId: string; leaseToken: string };
          expected: { secretReference: string };
        }): Promise<string>;
      },
      ids: { next(): string },
      clock: { now(): Date },
    ) => unknown;
    type PublicationWorkerConstructor = new (
      coordinator: JobWorkerCoordinator,
      handler: unknown,
    ) => {
      process(message: {
        messageId: string;
        payload: {
          jobId: string;
          tenantId: string;
          workspaceId: string;
          schemaVersion: '1.0.0';
        };
      }): Promise<{ outcome: string }>;
    };
    const executionStoreConstructor = (
      DatabaseRuntime as unknown as {
        PostgresPublicationExecutionStore?: new (database: Pool) => unknown;
      }
    ).PostgresPublicationExecutionStore;
    const handlerConstructor = (
      WorkerRuntime as unknown as {
        PublicationExecutionHandler?: PublicationHandlerConstructor;
      }
    ).PublicationExecutionHandler;
    const workerConstructor = (
      WorkerRuntime as unknown as { PublicationJobWorker?: PublicationWorkerConstructor }
    ).PublicationJobWorker;
    expect(
      executionStoreConstructor,
      'expected ambiguous state to reconcile through a durable Publication execution store',
    ).toBeTypeOf('function');
    expect(handlerConstructor, 'expected ambiguous state to reconcile').toBeTypeOf('function');
    expect(
      workerConstructor,
      'expected one remote effect, received no Publication Worker',
    ).toBeTypeOf('function');
    if (
      executionStoreConstructor === undefined ||
      handlerConstructor === undefined ||
      workerConstructor === undefined
    ) {
      throw new Error('PUBLICATION_WORKER_UNAVAILABLE');
    }

    const expectedRemoteRef = `fake://remote/${firstData.publication.id}`;
    const remoteEffects = new Map<string, string>();
    const expireLeaseAfterPublish = new Set<string>();
    const expireLeaseAfterReconcile = new Set<string>();
    const leakSecretAsRemoteRef = new Set<string>();
    const retryablePublish = new Set<string>();
    const retryableReconcile = new Set<string>();
    const definitelyNotAppliedReconcile = new Set<string>();
    let publishCalls = 0;
    let reconcileCalls = 0;
    let rollbackCalls = 0;
    let secretReads = 0;
    let revokeAuthorizationOnNextSecretRead = false;
    const fakeAdapter: FixtureAdapter = {
      adapterKey,
      adapterVersion: '1.0.0',
      describe() {
        return {
          adapterKey,
          adapterVersion: '1.0.0',
          capabilities: ['PUBLISH', 'RECONCILE', 'ROLLBACK'],
          requiredScopes: ['fixture.publish'],
          termsVersion: '2026-07',
          processingRegion: 'Singapore',
          retentionPolicy: 'ephemeral-fixture',
          trainingPolicy: 'not-used-for-training',
          subprocessors: [],
          ratePolicy: { requestsPerMinute: 10 },
        };
      },
      validateAuthorization(command) {
        expect(command.secretValue).toBe(secretSentinel);
        return Promise.resolve({ outcome: 'VALID' });
      },
      preview(command) {
        return {
          packageChecksum: command.channelPackage.packageChecksum,
          files: structuredClone(command.payload.files),
        };
      },
      publish(command) {
        publishCalls += 1;
        expect(command.secretValue).toBe(secretSentinel);
        expect(command.idempotencyKey).toBe(command.publicationId);
        expect(command.target).toBe(target);
        expect(command.channelPackage).toMatchObject({
          id: channelPackage.id,
          packageChecksum: channelPackage.packageChecksum,
          artifact: {
            artifactRevisionId: channelPackage.artifact.artifactRevisionId,
            contentHash: channelPackage.artifact.contentHash,
          },
        });
        expect(Object.keys(command.payload.files).sort()).toEqual([
          'content.html',
          'content.md',
          'structured-data.json',
        ]);
        if (retryablePublish.has(command.publicationId)) {
          return Promise.resolve({
            outcome: 'RETRYABLE_FAILURE',
            errorCode: secretSentinel,
          } as const);
        }
        if (
          !definitelyNotAppliedReconcile.has(command.publicationId) &&
          !remoteEffects.has(command.idempotencyKey)
        ) {
          remoteEffects.set(command.idempotencyKey, `fake://remote/${command.publicationId}`);
        }
        // A malicious/broken Adapter may echo credential material as an error code. The
        // coordinator must map this to a closed local code before any durable write.
        return Promise.resolve({ outcome: 'AMBIGUOUS', errorCode: secretSentinel } as const);
      },
      async reconcile(command) {
        reconcileCalls += 1;
        expect(command.secretValue).toBe(secretSentinel);
        expect(command.idempotencyKey).toBe(command.publicationId);
        if (definitelyNotAppliedReconcile.has(command.publicationId)) {
          return {
            outcome: 'DEFINITELY_NOT_APPLIED' as const,
            errorCode: secretSentinel,
          };
        }
        if (retryableReconcile.has(command.publicationId)) {
          return { outcome: 'RETRYABLE_FAILURE' as const, errorCode: secretSentinel };
        }
        if (leakSecretAsRemoteRef.has(command.publicationId)) {
          return Promise.resolve({ outcome: 'APPLIED' as const, remoteRef: secretSentinel });
        }
        const remoteRef = remoteEffects.get(command.idempotencyKey);
        if (remoteRef === undefined) throw new Error('FIXTURE_REMOTE_EFFECT_NOT_FOUND');
        return { outcome: 'APPLIED' as const, remoteRef };
      },
      rollback(command) {
        rollbackCalls += 1;
        expect(command.secretValue).toBe(secretSentinel);
        return Promise.resolve({
          outcome: 'ROLLED_BACK' as const,
          remoteRef: expectedRemoteRef,
        });
      },
    };
    const baseExecutionStore = new executionStoreConstructor(pool) as PublicationExecutionStore;
    const executionStore = Object.create(baseExecutionStore) as PublicationExecutionStore;
    executionStore.runGuardedEffect = async <T>(
      input: Parameters<PublicationExecutionStore['runGuardedEffect']>[0],
      effect: () => Promise<T>,
    ) => {
      const result = await baseExecutionStore.runGuardedEffect(input, effect);
      const shouldExpireLease =
        result.outcome === 'EXECUTED' &&
        ((input.operation === 'PUBLISH' &&
          expireLeaseAfterPublish.has(input.lease.job.aggregateId)) ||
          (input.operation === 'RECONCILE' &&
            expireLeaseAfterReconcile.has(input.lease.job.aggregateId)));
      if (shouldExpireLease) {
        await pool.query(
          `UPDATE jobs SET lease_expires_at = now() - interval '1 second'
           WHERE id = $1`,
          [input.lease.job.id],
        );
      }
      return result;
    };
    const handler = new handlerConstructor(
      executionStore,
      {
        readPublicationPackage(input) {
          return channelPackagePayloads.get(input.expected.objectRef);
        },
      },
      {
        resolve(candidateKey, candidateVersion) {
          return candidateKey === adapterKey && candidateVersion === '1.0.0' ? fakeAdapter : null;
        },
      },
      {
        readForPublication() {
          return Promise.resolve({
            secretReference: secretArn,
            credentialFingerprint: createHash('sha256')
              .update(secretSentinel, 'utf8')
              .digest('hex'),
          });
        },
      },
      {
        async readPublicationSecret(input) {
          secretReads += 1;
          expect(input.expected.secretReference).toBe(secretArn);
          if (revokeAuthorizationOnNextSecretRead) {
            revokeAuthorizationOnNextSecretRead = false;
            await pool.query(
              `UPDATE channel_authorizations
               SET status = 'REVOKED',
                   validation_status = 'INVALID',
                   validation_actual_target = NULL,
                   validation_actual_scopes = NULL,
                   validation_terms_version = NULL,
                   validation_credential_fingerprint = NULL,
                   validated_at = now(),
                   validation_valid_until = NULL,
                   validation_failure_code = 'AUTHORIZATION_REVOKED',
                   updated_at = now()
               WHERE id = $1`,
              [authorizationId],
            );
          }
          return secretSentinel;
        },
      },
      { next: randomUUID },
      { now: () => new Date() },
    );
    const publicationWorker = new workerConstructor(
      new JobWorkerCoordinator(
        new PostgresJobBudgetStore(pool),
        { now: () => new Date() },
        { next: randomUUID },
        'publish-workload-v1',
      ),
      handler,
    );
    const queued = await pool.query<{
      message_id: string;
      payload: {
        jobId: string;
        tenantId: string;
        workspaceId: string;
        schemaVersion: '1.0.0';
      };
    }>(
      `SELECT id::text AS message_id, payload
       FROM outbox_messages
       WHERE aggregate_id = $1 AND message_type = 'JOB_QUEUED'`,
      [firstData.job.id],
    );
    const message = queued.rows[0];
    if (message === undefined) throw new Error('PUBLICATION_OUTBOX_MESSAGE_NOT_FOUND');
    const queueMessage = { messageId: message.message_id, payload: message.payload };

    const firstPublicationResult = await publicationWorker.process(queueMessage);
    expect(firstPublicationResult).toMatchObject({
      outcome: 'SUCCEEDED',
    });
    expect(await publicationWorker.process(queueMessage)).toMatchObject({ outcome: 'DUPLICATE' });
    expect(remoteEffects.size, `expected one remote effect, received ${remoteEffects.size}`).toBe(
      1,
    );
    expect(publishCalls, `expected one remote effect, received ${publishCalls} publish calls`).toBe(
      1,
    );
    expect(reconcileCalls, 'expected ambiguous state to reconcile').toBe(1);
    expect(rollbackCalls).toBe(0);
    expect(secretReads, 'expected one transient secret read per remote operation').toBe(2);

    const execution = await pool.query<{
      publication_status: string;
      remote_ref: string | null;
      package_checksum: string;
      artifact_revision_id: string;
      artifact_content_hash: string;
      idempotency_key: string;
      requested_by_user_id: string;
      job_status: string;
      job_result: Record<string, unknown> | null;
    }>(
      `SELECT publication.status AS publication_status, publication.remote_ref,
         publication.package_checksum, publication.artifact_revision_id::text,
         publication.artifact_content_hash, publication.idempotency_key,
         publication.requested_by_user_id::text, job.status AS job_status,
         job.result AS job_result
       FROM publication_records publication
       JOIN jobs job ON job.id = publication.job_id
       WHERE publication.id = $1`,
      [firstData.publication.id],
    );
    expect(execution.rows[0]).toMatchObject({
      publication_status: 'PUBLISHED',
      remote_ref: expectedRemoteRef,
      package_checksum: channelPackage.packageChecksum,
      artifact_revision_id: channelPackage.artifact.artifactRevisionId,
      artifact_content_hash: channelPackage.artifact.contentHash,
      idempotency_key: idempotencyKey,
      requested_by_user_id: publisherUserId,
      job_status: 'SUCCEEDED',
      job_result: {
        publicationId: firstData.publication.id,
        publicationStatus: 'PUBLISHED',
        remoteRef: expectedRemoteRef,
        packageChecksum: channelPackage.packageChecksum,
      },
    });
    const attempts = await pool.query<{
      attempt_number: number;
      operation: string;
      outcome: string;
      remote_ref: string | null;
      error_code: string | null;
    }>(
      `SELECT attempt_number, operation, outcome, remote_ref, error_code
       FROM publication_attempts
       WHERE publication_id = $1
       ORDER BY attempt_number`,
      [firstData.publication.id],
    );
    expect(attempts.rows).toEqual([
      {
        attempt_number: 1,
        operation: 'PUBLISH',
        outcome: 'AMBIGUOUS',
        remote_ref: null,
        error_code: 'ADAPTER_PUBLISH_OUTCOME_UNKNOWN',
      },
      {
        attempt_number: 2,
        operation: 'RECONCILE',
        outcome: 'APPLIED',
        remote_ref: expectedRemoteRef,
        error_code: null,
      },
    ]);

    const publicationDetailResponse = await app.inject({
      method: 'GET',
      url: `${generated.scopeUrl}/publications/${firstData.publication.id}`,
      headers: { cookie: `__Host-aeo_session=${publisherSession}` },
    });
    expect(publicationDetailResponse.statusCode).toBe(200);
    const publicationDetail = PublicationDetailEnvelopeSchema.parse(
      publicationDetailResponse.json(),
    );
    expect(publicationDetail.data).toMatchObject({
      publication: {
        id: firstData.publication.id,
        status: 'PUBLISHED',
        packageChecksum: channelPackage.packageChecksum,
        artifactRevisionId: channelPackage.artifact.artifactRevisionId,
        artifactContentHash: channelPackage.artifact.contentHash,
        remoteRef: expectedRemoteRef,
      },
      job: {
        id: firstData.job.id,
        aggregateId: firstData.publication.id,
        status: 'SUCCEEDED',
      },
      attempts: [
        {
          attemptNumber: 1,
          operation: 'PUBLISH',
          outcome: 'AMBIGUOUS',
          remoteRef: null,
          errorCode: 'ADAPTER_PUBLISH_OUTCOME_UNKNOWN',
        },
        {
          attemptNumber: 2,
          operation: 'RECONCILE',
          outcome: 'APPLIED',
          remoteRef: expectedRemoteRef,
          errorCode: null,
        },
      ],
    });
    expect(publicationDetailResponse.body).not.toMatch(
      /secretArn|secretValue|credential|TASK10_SECRET_SENTINEL_DO_NOT_PERSIST/i,
    );
    const foreignSession = await signIn(app, 'channel-owner-b-code');
    const crossTenantDetail = await app.inject({
      method: 'GET',
      url: `${generated.scopeUrl}/publications/${firstData.publication.id}`,
      headers: { cookie: `__Host-aeo_session=${foreignSession}` },
    });
    expect(crossTenantDetail.statusCode).toBe(404);
    expect(crossTenantDetail.json()).toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });

    const queueRetryExhaustionFixture = async (name: string) => {
      const response = await app.inject({
        method: 'POST',
        url: `${generated.scopeUrl}/publications`,
        headers: mutationHeaders(publisherSession),
        payload: { ...request, idempotencyKey: `typed-retry-${name}-${suffix}` },
      });
      expect(response.statusCode).toBe(202);
      const data = response.json<{
        data: { publication: { id: string }; job: { id: string } };
      }>().data;
      await pool.query(`UPDATE jobs SET max_attempts = 1 WHERE id = $1`, [data.job.id]);
      const queued = await pool.query<{
        message_id: string;
        payload: {
          jobId: string;
          tenantId: string;
          workspaceId: string;
          schemaVersion: '1.0.0';
        };
      }>(
        `SELECT id::text AS message_id, payload
         FROM outbox_messages
         WHERE aggregate_id = $1 AND message_type = 'JOB_QUEUED'`,
        [data.job.id],
      );
      const message = queued.rows[0];
      if (message === undefined) throw new Error('TYPED_RETRY_OUTBOX_NOT_FOUND');
      return { ...data, queueMessage: { messageId: message.message_id, payload: message.payload } };
    };

    const safeRetry = await queueRetryExhaustionFixture('publish');
    retryablePublish.add(safeRetry.publication.id);
    const effectsBeforeSafeRetry = remoteEffects.size;
    const reconcilesBeforeSafeRetry = reconcileCalls;
    expect(await publicationWorker.process(safeRetry.queueMessage)).toMatchObject({
      outcome: 'FAILED_TERMINAL',
    });
    retryablePublish.delete(safeRetry.publication.id);
    expect(remoteEffects.size).toBe(effectsBeforeSafeRetry);
    expect(reconcileCalls).toBe(reconcilesBeforeSafeRetry);
    const safeRetryState = await pool.query<{
      publication_status: string;
      job_status: string;
      job_error_code: string | null;
      attempt_operation: string;
      attempt_outcome: string;
      attempt_error_code: string | null;
    }>(
      `SELECT publication.status AS publication_status, job.status AS job_status,
         job.error_code AS job_error_code, attempt.operation AS attempt_operation,
         attempt.outcome AS attempt_outcome, attempt.error_code AS attempt_error_code
       FROM publication_records publication
       JOIN jobs job ON job.id = publication.job_id
       JOIN publication_attempts attempt ON attempt.publication_id = publication.id
       WHERE publication.id = $1`,
      [safeRetry.publication.id],
    );
    expect(safeRetryState.rows).toEqual([
      {
        publication_status: 'FAILED_TERMINAL',
        job_status: 'FAILED_TERMINAL',
        job_error_code: 'PUBLICATION_EXECUTION_ATTEMPTS_EXHAUSTED',
        attempt_operation: 'PUBLISH',
        attempt_outcome: 'RETRYABLE_FAILURE',
        attempt_error_code: 'ADAPTER_PUBLISH_RETRYABLE_FAILURE',
      },
    ]);

    const uncertainRetry = await queueRetryExhaustionFixture('reconcile');
    retryableReconcile.add(uncertainRetry.publication.id);
    const effectsBeforeUncertainRetry = remoteEffects.size;
    expect(await publicationWorker.process(uncertainRetry.queueMessage)).toMatchObject({
      outcome: 'FAILED_TERMINAL',
    });
    retryableReconcile.delete(uncertainRetry.publication.id);
    expect(remoteEffects.size).toBe(effectsBeforeUncertainRetry + 1);
    const uncertainRetryState = await pool.query<{
      publication_status: string;
      job_status: string;
      job_error_code: string | null;
      operations: string[];
      outcomes: string[];
      error_codes: Array<string | null>;
    }>(
      `SELECT publication.status AS publication_status, job.status AS job_status,
         job.error_code AS job_error_code,
         array_agg(attempt.operation ORDER BY attempt.attempt_number) AS operations,
         array_agg(attempt.outcome ORDER BY attempt.attempt_number) AS outcomes,
         array_agg(attempt.error_code ORDER BY attempt.attempt_number) AS error_codes
       FROM publication_records publication
       JOIN jobs job ON job.id = publication.job_id
       JOIN publication_attempts attempt ON attempt.publication_id = publication.id
       WHERE publication.id = $1
       GROUP BY publication.status, job.status, job.error_code`,
      [uncertainRetry.publication.id],
    );
    expect(uncertainRetryState.rows).toEqual([
      {
        publication_status: 'MANUAL_REVIEW_REQUIRED',
        job_status: 'FAILED_TERMINAL',
        job_error_code: 'PUBLICATION_EXECUTION_ATTEMPTS_EXHAUSTED',
        operations: ['PUBLISH', 'RECONCILE'],
        outcomes: ['AMBIGUOUS', 'RETRYABLE_FAILURE'],
        error_codes: ['ADAPTER_PUBLISH_OUTCOME_UNKNOWN', 'ADAPTER_RECONCILE_RETRYABLE_FAILURE'],
      },
    ]);

    const definitelyNotApplied = await queueRetryExhaustionFixture(
      'reconcile-definitely-not-applied',
    );
    definitelyNotAppliedReconcile.add(definitelyNotApplied.publication.id);
    const effectsBeforeDefinitelyNotApplied = remoteEffects.size;
    expect(await publicationWorker.process(definitelyNotApplied.queueMessage)).toMatchObject({
      outcome: 'FAILED_TERMINAL',
    });
    definitelyNotAppliedReconcile.delete(definitelyNotApplied.publication.id);
    expect(remoteEffects.size).toBe(effectsBeforeDefinitelyNotApplied);
    const definitelyNotAppliedState = await pool.query<{
      publication_status: string;
      job_status: string;
      operation: string;
      outcome: string;
      error_code: string | null;
    }>(
      `SELECT publication.status AS publication_status, job.status AS job_status,
         attempt.operation, attempt.outcome, attempt.error_code
       FROM publication_records publication
       JOIN jobs job ON job.id = publication.job_id
       JOIN publication_attempts attempt ON attempt.publication_id = publication.id
       WHERE publication.id = $1 AND attempt.operation = 'RECONCILE'`,
      [definitelyNotApplied.publication.id],
    );
    expect(definitelyNotAppliedState.rows).toEqual([
      {
        publication_status: 'FAILED_TERMINAL',
        job_status: 'FAILED_TERMINAL',
        operation: 'RECONCILE',
        outcome: 'DEFINITELY_NOT_APPLIED',
        error_code: 'ADAPTER_RECONCILE_DEFINITELY_NOT_APPLIED',
      },
    ]);

    const durable = await pool.query<{ durable_text: string }>(
      `SELECT concat_ws(' ',
         COALESCE((SELECT result::text FROM jobs WHERE id = $1), ''),
         COALESCE((SELECT string_agg(payload::text, ' ') FROM outbox_messages
           WHERE tenant_id = $2 AND workspace_id = $3), ''),
         COALESCE((SELECT string_agg(metadata::text, ' ') FROM audit_events
           WHERE tenant_id = $2 AND workspace_id = $3), ''),
         COALESCE((SELECT string_agg(row_to_json(attempt_row)::text, ' ')
           FROM publication_attempts attempt_row WHERE publication_id = $4), ''),
         COALESCE((SELECT row_to_json(publication_row)::text
           FROM publication_records publication_row WHERE id = $4), '')
       ) AS durable_text`,
      [firstData.job.id, scope.tenant.id, scope.workspace.id, firstData.publication.id],
    );
    expect(durable.rows[0]?.durable_text).not.toContain(secretSentinel);

    const chaosRequest = {
      ...request,
      idempotencyKey: `publication-chaos-${suffix}`,
    };
    const chaosCommand = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications`,
      headers: mutationHeaders(publisherSession),
      payload: chaosRequest,
    });
    expect(chaosCommand.statusCode).toBe(202);
    const chaos = chaosCommand.json<{
      data: { publication: { id: string }; job: { id: string } };
    }>().data;
    const chaosOutbox = await pool.query<{
      message_id: string;
      payload: {
        jobId: string;
        tenantId: string;
        workspaceId: string;
        schemaVersion: '1.0.0';
      };
    }>(
      `SELECT id::text AS message_id, payload
       FROM outbox_messages
       WHERE aggregate_id = $1 AND message_type = 'JOB_QUEUED'`,
      [chaos.job.id],
    );
    const chaosMessage = chaosOutbox.rows[0];
    if (chaosMessage === undefined) throw new Error('PUBLICATION_CHAOS_OUTBOX_NOT_FOUND');
    const chaosQueueMessage = {
      messageId: chaosMessage.message_id,
      payload: chaosMessage.payload,
    };
    const effectsBeforeChaos = remoteEffects.size;
    const publishCallsBeforeChaos = publishCalls;
    const reconcileCallsBeforeChaos = reconcileCalls;
    const secretReadsBeforeChaos = secretReads;
    expireLeaseAfterPublish.add(chaos.publication.id);

    expect(
      await publicationWorker.process(chaosQueueMessage),
      'expected lease-loss after one remote effect to remain recoverable',
    ).toMatchObject({ outcome: 'LEASE_LOST' });
    const rejectedCancellation = await app.inject({
      method: 'DELETE',
      url: `${generated.scopeUrl}/jobs/${chaos.job.id}`,
      headers: mutationHeaders(ownerSession),
    });
    expect(rejectedCancellation.statusCode).toBe(409);
    expect(rejectedCancellation.json()).toMatchObject({
      code: 'PUBLICATION_CANCEL_REQUIRES_RECONCILIATION',
    });
    expect(
      await publicationWorker.process(chaosQueueMessage),
      'expected ambiguous state to reconcile after queue redelivery',
    ).toMatchObject({ outcome: 'SUCCEEDED' });
    expect(await publicationWorker.process(chaosQueueMessage)).toMatchObject({
      outcome: 'DUPLICATE',
    });
    expect(
      remoteEffects.size - effectsBeforeChaos,
      `expected one remote effect, received ${remoteEffects.size - effectsBeforeChaos}`,
    ).toBe(1);
    expect(publishCalls - publishCallsBeforeChaos, 'expected one remote publish before crash').toBe(
      1,
    );
    expect(
      reconcileCalls - reconcileCallsBeforeChaos,
      'expected ambiguous state to reconcile instead of publishing twice',
    ).toBe(1);
    expect(
      secretReads - secretReadsBeforeChaos,
      'expected transient secret resolution for publish and reconcile only',
    ).toBe(2);
    const chaosState = await pool.query<{
      publication_status: string;
      remote_ref: string | null;
      job_status: string;
    }>(
      `SELECT publication.status AS publication_status, publication.remote_ref,
         job.status AS job_status
       FROM publication_records publication
       JOIN jobs job ON job.id = publication.job_id
       WHERE publication.id = $1`,
      [chaos.publication.id],
    );
    expect(chaosState.rows[0]).toMatchObject({
      publication_status: 'PUBLISHED',
      remote_ref: `fake://remote/${chaos.publication.id}`,
      job_status: 'SUCCEEDED',
    });
    const chaosAttempts = await pool.query<{
      attempt_number: number;
      operation: string;
      outcome: string;
      error_code: string | null;
    }>(
      `SELECT attempt_number, operation, outcome, error_code
       FROM publication_attempts
       WHERE publication_id = $1
       ORDER BY attempt_number`,
      [chaos.publication.id],
    );
    expect(chaosAttempts.rows).toEqual([
      {
        attempt_number: 1,
        operation: 'PUBLISH',
        outcome: 'AMBIGUOUS',
        error_code: 'PUBLISH_INTERRUPTED_OUTCOME_UNKNOWN',
      },
      {
        attempt_number: 2,
        operation: 'RECONCILE',
        outcome: 'APPLIED',
        error_code: null,
      },
    ]);

    const staleGateCommand = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications`,
      headers: mutationHeaders(publisherSession),
      payload: { ...request, idempotencyKey: `publication-stale-gate-${suffix}` },
    });
    expect(staleGateCommand.statusCode).toBe(202);
    const staleGate = staleGateCommand.json<{
      data: { publication: { id: string }; job: { id: string } };
    }>().data;
    const staleGateOutbox = await pool.query<{
      message_id: string;
      payload: {
        jobId: string;
        tenantId: string;
        workspaceId: string;
        schemaVersion: '1.0.0';
      };
    }>(
      `SELECT id::text AS message_id, payload
       FROM outbox_messages
       WHERE aggregate_id = $1 AND message_type = 'JOB_QUEUED'`,
      [staleGate.job.id],
    );
    const staleGateMessage = staleGateOutbox.rows[0];
    if (staleGateMessage === undefined) throw new Error('PUBLICATION_STALE_GATE_OUTBOX_NOT_FOUND');
    const effectsBeforeStaleGate = remoteEffects.size;
    const publishCallsBeforeStaleGate = publishCalls;
    const secretReadsBeforeStaleGate = secretReads;
    const revokedAuthorization = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/channel-authorizations/${authorizationId}/revoke`,
      headers: mutationHeaders(ownerSession),
      payload: {},
    });
    expect(revokedAuthorization.statusCode).toBe(200);
    const revokedEligibility = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications/eligibility`,
      headers: mutationHeaders(publisherSession),
      payload: {
        channelPackageId: channelPackage.id,
        adapterVersionId,
        target,
        expectedPackageChecksum: channelPackage.packageChecksum,
      },
    });
    expect(revokedEligibility.statusCode).toBe(200);
    const revokedEligibilityResult = PublicationEligibilityEnvelopeSchema.parse(
      revokedEligibility.json(),
    ).data.eligibility;
    expect(revokedEligibilityResult.mode).toBe('EXPORT_ONLY');
    if (revokedEligibilityResult.mode !== 'EXPORT_ONLY') {
      throw new Error('EXPECTED_REVOKED_AUTHORIZATION_EXPORT_ONLY');
    }
    expect(revokedEligibilityResult.reasons.map((reason) => reason.code)).toContain(
      'AUTHORIZATION_REVOKED',
    );
    try {
      expect(
        await publicationWorker.process({
          messageId: staleGateMessage.message_id,
          payload: staleGateMessage.payload,
        }),
        'expected revoked authorization to block the queued remote effect',
      ).toMatchObject({ outcome: 'FAILED_TERMINAL' });
    } finally {
      authorizationId = await createActiveAuthorization();
    }
    expect(remoteEffects.size).toBe(effectsBeforeStaleGate);
    expect(publishCalls).toBe(publishCallsBeforeStaleGate);
    expect(secretReads).toBe(secretReadsBeforeStaleGate);
    const staleGateState = await pool.query<{
      publication_status: string;
      job_status: string;
      job_error_code: string | null;
      attempt_count: string;
      gate_audit_count: string;
      gate_audit_actor: string | null;
    }>(
      `SELECT publication.status AS publication_status, job.status AS job_status,
         job.error_code AS job_error_code,
         (SELECT count(*)::text FROM publication_attempts attempt
           WHERE attempt.publication_id = publication.id) AS attempt_count,
         (SELECT count(*)::text FROM audit_events audit
           WHERE audit.resource_id = publication.id
             AND audit.action = 'PUBLICATION_GATE_REJECTED') AS gate_audit_count,
         (SELECT audit.actor_user_id::text FROM audit_events audit
           WHERE audit.resource_id = publication.id
             AND audit.action = 'PUBLICATION_GATE_REJECTED' LIMIT 1) AS gate_audit_actor
       FROM publication_records publication
       JOIN jobs job ON job.id = publication.job_id
       WHERE publication.id = $1`,
      [staleGate.publication.id],
    );
    expect(staleGateState.rows[0]).toEqual({
      publication_status: 'FAILED_TERMINAL',
      job_status: 'FAILED_TERMINAL',
      job_error_code: 'PUBLICATION_GATE_STALE',
      attempt_count: '0',
      gate_audit_count: '1',
      gate_audit_actor: publisherUserId,
    });

    const maliciousRemoteCommand = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications`,
      headers: mutationHeaders(publisherSession),
      payload: { ...request, idempotencyKey: `publication-secret-remote-ref-${suffix}` },
    });
    expect(maliciousRemoteCommand.statusCode).toBe(202);
    const maliciousRemote = maliciousRemoteCommand.json<{
      data: { publication: { id: string }; job: { id: string } };
    }>().data;
    const maliciousRemoteOutbox = await pool.query<{
      message_id: string;
      payload: {
        jobId: string;
        tenantId: string;
        workspaceId: string;
        schemaVersion: '1.0.0';
      };
    }>(
      `SELECT id::text AS message_id, payload
       FROM outbox_messages
       WHERE aggregate_id = $1 AND message_type = 'JOB_QUEUED'`,
      [maliciousRemote.job.id],
    );
    const maliciousRemoteMessage = maliciousRemoteOutbox.rows[0];
    if (maliciousRemoteMessage === undefined) {
      throw new Error('PUBLICATION_MALICIOUS_REMOTE_OUTBOX_NOT_FOUND');
    }
    const effectsBeforeMaliciousRemote = remoteEffects.size;
    const publishCallsBeforeMaliciousRemote = publishCalls;
    const reconcileCallsBeforeMaliciousRemote = reconcileCalls;
    leakSecretAsRemoteRef.add(maliciousRemote.publication.id);
    expect(
      await publicationWorker.process({
        messageId: maliciousRemoteMessage.message_id,
        payload: maliciousRemoteMessage.payload,
      }),
      'expected credential-shaped remoteRef to require manual review without persistence',
    ).toMatchObject({ outcome: 'FAILED_TERMINAL' });
    expect(remoteEffects.size - effectsBeforeMaliciousRemote).toBe(1);
    expect(publishCalls - publishCallsBeforeMaliciousRemote).toBe(1);
    expect(reconcileCalls - reconcileCallsBeforeMaliciousRemote).toBe(1);
    const maliciousRemoteState = await pool.query<{
      publication_status: string;
      remote_ref: string | null;
      job_status: string;
      job_result: Record<string, unknown> | null;
    }>(
      `SELECT publication.status AS publication_status, publication.remote_ref,
         job.status AS job_status, job.result AS job_result
       FROM publication_records publication
       JOIN jobs job ON job.id = publication.job_id
       WHERE publication.id = $1`,
      [maliciousRemote.publication.id],
    );
    expect(maliciousRemoteState.rows[0]).toEqual({
      publication_status: 'MANUAL_REVIEW_REQUIRED',
      remote_ref: null,
      job_status: 'FAILED_TERMINAL',
      job_result: null,
    });
    const maliciousRemoteAttempts = await pool.query<{
      attempt_number: number;
      operation: string;
      outcome: string;
      remote_ref: string | null;
      error_code: string | null;
    }>(
      `SELECT attempt_number, operation, outcome, remote_ref, error_code
       FROM publication_attempts WHERE publication_id = $1 ORDER BY attempt_number`,
      [maliciousRemote.publication.id],
    );
    expect(maliciousRemoteAttempts.rows).toEqual([
      {
        attempt_number: 1,
        operation: 'PUBLISH',
        outcome: 'AMBIGUOUS',
        remote_ref: null,
        error_code: 'ADAPTER_PUBLISH_OUTCOME_UNKNOWN',
      },
      {
        attempt_number: 2,
        operation: 'RECONCILE',
        outcome: 'UNKNOWN',
        remote_ref: null,
        error_code: 'ADAPTER_RECONCILE_REMOTE_REF_INVALID',
      },
    ]);

    const boundaryGateCommand = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications`,
      headers: mutationHeaders(publisherSession),
      payload: { ...request, idempotencyKey: `publication-boundary-gate-${suffix}` },
    });
    expect(boundaryGateCommand.statusCode).toBe(202);
    const boundaryGate = boundaryGateCommand.json<{
      data: { publication: { id: string }; job: { id: string } };
    }>().data;
    const boundaryGateOutbox = await pool.query<{
      message_id: string;
      payload: {
        jobId: string;
        tenantId: string;
        workspaceId: string;
        schemaVersion: '1.0.0';
      };
    }>(
      `SELECT id::text AS message_id, payload
       FROM outbox_messages
       WHERE aggregate_id = $1 AND message_type = 'JOB_QUEUED'`,
      [boundaryGate.job.id],
    );
    const boundaryGateMessage = boundaryGateOutbox.rows[0];
    if (boundaryGateMessage === undefined) {
      throw new Error('PUBLICATION_BOUNDARY_GATE_OUTBOX_NOT_FOUND');
    }
    const boundaryQueueMessage = {
      messageId: boundaryGateMessage.message_id,
      payload: boundaryGateMessage.payload,
    };
    const effectsBeforeBoundaryGate = remoteEffects.size;
    const publishCallsBeforeBoundaryGate = publishCalls;
    const reconcileCallsBeforeBoundaryGate = reconcileCalls;
    revokeAuthorizationOnNextSecretRead = true;
    try {
      expect(
        await publicationWorker.process(boundaryQueueMessage),
        'expected final authorization fence before irreversible Adapter call',
      ).toMatchObject({ outcome: 'FAILED_TERMINAL' });
      expect(remoteEffects.size).toBe(effectsBeforeBoundaryGate);
      expect(publishCalls).toBe(publishCallsBeforeBoundaryGate);
      expect(reconcileCalls).toBe(reconcileCallsBeforeBoundaryGate);
      expect(await publicationWorker.process(boundaryQueueMessage)).toMatchObject({
        outcome: 'DUPLICATE',
      });
    } finally {
      authorizationId = await createActiveAuthorization();
    }
    expect(remoteEffects.size).toBe(effectsBeforeBoundaryGate);
    expect(publishCalls).toBe(publishCallsBeforeBoundaryGate);
    expect(reconcileCalls).toBe(reconcileCallsBeforeBoundaryGate);
    const boundaryGateState = await pool.query<{
      publication_status: string;
      remote_ref: string | null;
      job_status: string;
      attempt_operation: string;
      attempt_outcome: string;
      attempt_error_code: string | null;
    }>(
      `SELECT publication.status AS publication_status, publication.remote_ref,
         job.status AS job_status, attempt.operation AS attempt_operation,
         attempt.outcome AS attempt_outcome, attempt.error_code AS attempt_error_code
       FROM publication_records publication
       JOIN jobs job ON job.id = publication.job_id
       JOIN publication_attempts attempt ON attempt.publication_id = publication.id
       WHERE publication.id = $1`,
      [boundaryGate.publication.id],
    );
    expect(boundaryGateState.rows[0]).toEqual({
      publication_status: 'FAILED_TERMINAL',
      remote_ref: null,
      job_status: 'FAILED_TERMINAL',
      attempt_operation: 'PUBLISH',
      attempt_outcome: 'DEFINITELY_NOT_APPLIED',
      attempt_error_code: 'PUBLICATION_GATE_STALE',
    });

    const publishedRecoveryCommand = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications`,
      headers: mutationHeaders(publisherSession),
      payload: { ...request, idempotencyKey: `publication-published-recovery-${suffix}` },
    });
    expect(publishedRecoveryCommand.statusCode).toBe(202);
    const publishedRecovery = publishedRecoveryCommand.json<{
      data: { publication: { id: string }; job: { id: string } };
    }>().data;
    const publishedRecoveryOutbox = await pool.query<{
      message_id: string;
      payload: {
        jobId: string;
        tenantId: string;
        workspaceId: string;
        schemaVersion: '1.0.0';
      };
    }>(
      `SELECT id::text AS message_id, payload
       FROM outbox_messages
       WHERE aggregate_id = $1 AND message_type = 'JOB_QUEUED'`,
      [publishedRecovery.job.id],
    );
    const publishedRecoveryMessage = publishedRecoveryOutbox.rows[0];
    if (publishedRecoveryMessage === undefined) {
      throw new Error('PUBLICATION_PUBLISHED_RECOVERY_OUTBOX_NOT_FOUND');
    }
    const publishedRecoveryQueueMessage = {
      messageId: publishedRecoveryMessage.message_id,
      payload: publishedRecoveryMessage.payload,
    };
    const recoveryBaseCoordinator = new JobWorkerCoordinator(
      new PostgresJobBudgetStore(pool),
      { now: () => new Date() },
      { next: randomUUID },
      'publish-workload-v1',
    );
    let failCompletionOnce = true;
    const completionCrashCoordinator = {
      claim(message: Parameters<JobWorkerCoordinator['claim']>[0]) {
        return recoveryBaseCoordinator.claim(message);
      },
      heartbeat(lease: Parameters<JobWorkerCoordinator['heartbeat']>[0]) {
        return recoveryBaseCoordinator.heartbeat(lease);
      },
      reportProgress(
        lease: Parameters<JobWorkerCoordinator['reportProgress']>[0],
        progress: number,
      ) {
        return recoveryBaseCoordinator.reportProgress(lease, progress);
      },
      fail(
        lease: Parameters<JobWorkerCoordinator['fail']>[0],
        classification: Parameters<JobWorkerCoordinator['fail']>[1],
        errorCode: string,
      ) {
        return recoveryBaseCoordinator.fail(lease, classification, errorCode);
      },
      async complete(
        lease: Parameters<JobWorkerCoordinator['complete']>[0],
        result: Record<string, unknown>,
        actualUnits: number,
      ) {
        if (failCompletionOnce) {
          failCompletionOnce = false;
          await pool.query(
            `UPDATE jobs SET lease_expires_at = now() - interval '1 second'
             WHERE id = $1`,
            [lease.job.id],
          );
          return false;
        }
        return recoveryBaseCoordinator.complete(lease, result, actualUnits);
      },
    };
    const publishedRecoveryWorker = new workerConstructor(
      completionCrashCoordinator as unknown as JobWorkerCoordinator,
      handler,
    );
    const effectsBeforePublishedRecovery = remoteEffects.size;
    const publishCallsBeforePublishedRecovery = publishCalls;
    const reconcileCallsBeforePublishedRecovery = reconcileCalls;
    const secretReadsBeforePublishedRecovery = secretReads;
    expect(
      await publishedRecoveryWorker.process(publishedRecoveryQueueMessage),
      'expected crash after durable PUBLISHED and before local Job completion',
    ).toMatchObject({ outcome: 'LEASE_LOST' });
    const crashWindow = await pool.query<{
      publication_status: string;
      job_status: string;
    }>(
      `SELECT publication.status AS publication_status, job.status AS job_status
       FROM publication_records publication
       JOIN jobs job ON job.id = publication.job_id
       WHERE publication.id = $1`,
      [publishedRecovery.publication.id],
    );
    expect(crashWindow.rows[0]).toEqual({
      publication_status: 'PUBLISHED',
      job_status: 'RUNNING',
    });
    await pool.query(
      `UPDATE channel_authorizations
       SET status = 'REVOKED',
           validation_status = 'INVALID',
           validation_actual_target = NULL,
           validation_actual_scopes = NULL,
           validation_terms_version = NULL,
           validation_credential_fingerprint = NULL,
           validated_at = now(),
           validation_valid_until = NULL,
           validation_failure_code = 'AUTHORIZATION_REVOKED',
           updated_at = now()
       WHERE id = $1`,
      [authorizationId],
    );
    await pool.query(`UPDATE adapter_versions SET enabled = false WHERE id = $1`, [
      adapterVersionId,
    ]);
    try {
      expect(
        await publishedRecoveryWorker.process(publishedRecoveryQueueMessage),
        'expected durable PUBLISHED recovery without a second remote call',
      ).toMatchObject({ outcome: 'SUCCEEDED' });
      expect(await publishedRecoveryWorker.process(publishedRecoveryQueueMessage)).toMatchObject({
        outcome: 'DUPLICATE',
      });
    } finally {
      authorizationId = await createActiveAuthorization();
      await pool.query(`UPDATE adapter_versions SET enabled = true WHERE id = $1`, [
        adapterVersionId,
      ]);
    }
    expect(remoteEffects.size - effectsBeforePublishedRecovery).toBe(1);
    expect(publishCalls - publishCallsBeforePublishedRecovery).toBe(1);
    expect(reconcileCalls - reconcileCallsBeforePublishedRecovery).toBe(1);
    expect(secretReads - secretReadsBeforePublishedRecovery).toBe(2);
    const publishedRecoveryState = await pool.query<{
      publication_status: string;
      remote_ref: string | null;
      job_status: string;
      attempt_count: string;
    }>(
      `SELECT publication.status AS publication_status, publication.remote_ref,
         job.status AS job_status,
         (SELECT count(*)::text FROM publication_attempts attempt
          WHERE attempt.publication_id = publication.id) AS attempt_count
       FROM publication_records publication
       JOIN jobs job ON job.id = publication.job_id
       WHERE publication.id = $1`,
      [publishedRecovery.publication.id],
    );
    expect(publishedRecoveryState.rows[0]).toEqual({
      publication_status: 'PUBLISHED',
      remote_ref: `fake://remote/${publishedRecovery.publication.id}`,
      job_status: 'SUCCEEDED',
      attempt_count: '2',
    });

    const exhaustedCommand = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications`,
      headers: mutationHeaders(publisherSession),
      payload: { ...request, idempotencyKey: `publication-attempts-exhausted-${suffix}` },
    });
    expect(exhaustedCommand.statusCode).toBe(202);
    const exhausted = exhaustedCommand.json<{
      data: { publication: { id: string }; job: { id: string } };
    }>().data;
    const exhaustedOutbox = await pool.query<{
      message_id: string;
      payload: {
        jobId: string;
        tenantId: string;
        workspaceId: string;
        schemaVersion: '1.0.0';
      };
    }>(
      `SELECT id::text AS message_id, payload
       FROM outbox_messages
       WHERE aggregate_id = $1 AND message_type = 'JOB_QUEUED'`,
      [exhausted.job.id],
    );
    const exhaustedMessage = exhaustedOutbox.rows[0];
    if (exhaustedMessage === undefined) {
      throw new Error('PUBLICATION_ATTEMPTS_EXHAUSTED_OUTBOX_NOT_FOUND');
    }
    await pool.query(`UPDATE jobs SET max_attempts = 2 WHERE id = $1`, [exhausted.job.id]);
    expireLeaseAfterPublish.add(exhausted.publication.id);
    expireLeaseAfterReconcile.add(exhausted.publication.id);
    const publishCallsBeforeExhaustion = publishCalls;
    const reconcileCallsBeforeExhaustion = reconcileCalls;
    const exhaustedQueueMessage = {
      messageId: exhaustedMessage.message_id,
      payload: exhaustedMessage.payload,
    };
    expect(
      await publicationWorker.process(exhaustedQueueMessage),
      'expected first lost lease after the only publish effect',
    ).toMatchObject({ outcome: 'LEASE_LOST' });
    expect(
      await publicationWorker.process(exhaustedQueueMessage),
      'expected second lost lease after reconciliation observed the effect',
    ).toMatchObject({ outcome: 'LEASE_LOST' });
    expect(
      await publicationWorker.process(exhaustedQueueMessage),
      'expected the retry budget fence to stop unbounded reconciliation',
    ).toMatchObject({ outcome: 'NOT_AVAILABLE' });
    expect(publishCalls - publishCallsBeforeExhaustion).toBe(1);
    expect(reconcileCalls - reconcileCallsBeforeExhaustion).toBe(1);
    const exhaustedState = await pool.query<{
      publication_status: string;
      remote_ref: string | null;
      job_status: string;
      job_attempt: number;
      job_max_attempts: number;
      job_error_code: string | null;
    }>(
      `SELECT publication.status AS publication_status, publication.remote_ref,
         job.status AS job_status, job.attempt AS job_attempt,
         job.max_attempts AS job_max_attempts, job.error_code AS job_error_code
       FROM publication_records publication
       JOIN jobs job ON job.id = publication.job_id
       WHERE publication.id = $1`,
      [exhausted.publication.id],
    );
    expect(exhaustedState.rows[0]).toEqual({
      publication_status: 'MANUAL_REVIEW_REQUIRED',
      remote_ref: null,
      job_status: 'FAILED_TERMINAL',
      job_attempt: 2,
      job_max_attempts: 2,
      job_error_code: 'PUBLICATION_EXECUTION_ATTEMPTS_EXHAUSTED',
    });
    const exhaustedAttempts = await pool.query<{
      attempt_number: number;
      operation: string;
      outcome: string;
      error_code: string | null;
    }>(
      `SELECT attempt_number, operation, outcome, error_code
       FROM publication_attempts
       WHERE publication_id = $1
       ORDER BY attempt_number`,
      [exhausted.publication.id],
    );
    expect(exhaustedAttempts.rows).toEqual([
      {
        attempt_number: 1,
        operation: 'PUBLISH',
        outcome: 'AMBIGUOUS',
        error_code: 'PUBLISH_INTERRUPTED_OUTCOME_UNKNOWN',
      },
      {
        attempt_number: 2,
        operation: 'RECONCILE',
        outcome: 'UNKNOWN',
        error_code: 'PUBLICATION_EXECUTION_ATTEMPTS_EXHAUSTED',
      },
    ]);

    const preflightCrashCommand = await app.inject({
      method: 'POST',
      url: `${generated.scopeUrl}/publications`,
      headers: mutationHeaders(publisherSession),
      payload: { ...request, idempotencyKey: `publication-preflight-crash-${suffix}` },
    });
    expect(preflightCrashCommand.statusCode).toBe(202);
    const preflightCrash = preflightCrashCommand.json<{
      data: { publication: { id: string }; job: { id: string } };
    }>().data;
    const preflightCrashOutbox = await pool.query<{
      message_id: string;
      payload: {
        jobId: string;
        tenantId: string;
        workspaceId: string;
        schemaVersion: '1.0.0';
      };
    }>(
      `SELECT id::text AS message_id, payload
       FROM outbox_messages
       WHERE aggregate_id = $1 AND message_type = 'JOB_QUEUED'`,
      [preflightCrash.job.id],
    );
    const preflightCrashMessage = preflightCrashOutbox.rows[0];
    if (preflightCrashMessage === undefined) {
      throw new Error('PUBLICATION_PREFLIGHT_CRASH_OUTBOX_NOT_FOUND');
    }
    await pool.query(
      `UPDATE jobs
       SET status = 'RUNNING', attempt = 1, max_attempts = 1,
         lease_token = $1, lease_expires_at = now() - interval '1 second'
       WHERE id = $2`,
      [randomUUID(), preflightCrash.job.id],
    );
    const effectsBeforePreflightCrash = remoteEffects.size;
    expect(
      await publicationWorker.process({
        messageId: preflightCrashMessage.message_id,
        payload: preflightCrashMessage.payload,
      }),
      'expected max-attempt crash before prepare to close without a remote effect',
    ).toMatchObject({ outcome: 'NOT_AVAILABLE' });
    expect(remoteEffects.size).toBe(effectsBeforePreflightCrash);
    const preflightCrashState = await pool.query<{
      publication_status: string;
      job_status: string;
      attempt_count: string;
      audit_operation: string;
      audit_outcome: string;
    }>(
      `SELECT publication.status AS publication_status, job.status AS job_status,
         (SELECT count(*)::text FROM publication_attempts attempt
          WHERE attempt.publication_id = publication.id) AS attempt_count,
         audit.metadata ->> 'operation' AS audit_operation,
         audit.metadata ->> 'outcome' AS audit_outcome
       FROM publication_records publication
       JOIN jobs job ON job.id = publication.job_id
       JOIN audit_events audit ON audit.resource_id = publication.id
        AND audit.action = 'PUBLICATION_EXECUTION_ATTEMPTS_EXHAUSTED'
       WHERE publication.id = $1`,
      [preflightCrash.publication.id],
    );
    expect(preflightCrashState.rows[0]).toEqual({
      publication_status: 'FAILED_TERMINAL',
      job_status: 'FAILED_TERMINAL',
      attempt_count: '0',
      audit_operation: 'PUBLISH',
      audit_outcome: 'DEFINITELY_NOT_APPLIED',
    });

    const finalDurable = await pool.query<{ durable_text: string }>(
      `SELECT concat_ws(' ',
         COALESCE((SELECT string_agg(COALESCE(result::text, ''), ' ') FROM jobs
           WHERE tenant_id = $1 AND workspace_id = $2), ''),
         COALESCE((SELECT string_agg(payload::text, ' ') FROM outbox_messages
           WHERE tenant_id = $1 AND workspace_id = $2), ''),
         COALESCE((SELECT string_agg(metadata::text, ' ') FROM audit_events
           WHERE tenant_id = $1 AND workspace_id = $2), ''),
         COALESCE((SELECT string_agg(row_to_json(attempt_row)::text, ' ')
           FROM publication_attempts attempt_row
           WHERE tenant_id = $1 AND workspace_id = $2), '')
       ) AS durable_text`,
      [scope.tenant.id, scope.workspace.id],
    );
    expect(finalDurable.rows[0]?.durable_text).not.toContain(secretSentinel);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
