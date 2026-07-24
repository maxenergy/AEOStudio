import { randomUUID } from 'node:crypto';

import {
  DeterministicArtifactGenerator,
  FakeOidcClient,
  FakeAmbiguousPublicationAdapter,
} from '@aeostudio/adapters';
import {
  ChannelAuthorizationService,
  ChannelPackageService,
  DefaultChannelPackageTransformerRegistry,
  PublicationCommandService,
  PublicationEligibilityService,
  PublicationQueryService,
  hashArtifactRevision,
} from '@aeostudio/application';
import type { TenantContext, TenancyStore } from '@aeostudio/application/identity-access';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { resolveApiRuntime } from '../../apps/api/src/runtime/resolve-runtime.js';
import {
  FAKE_ARTIFACT_LINEAGE,
  fakeArtifactClaimBundle,
  fakeArtifactClaimEvidence,
  fakeArtifactPromptBundle,
} from '../../apps/api/src/artifacts/fake-artifact-lineage-fixture.js';
import type { InMemoryEvidenceClaimStore } from '../../apps/api/src/claims/in-memory-evidence-claim-store.js';
import { InMemoryJobBudgetStore } from '../../apps/api/src/jobs/in-memory-job-budget-store.js';
import type { InMemoryPromptResearchStore } from '../../apps/api/src/prompts/in-memory-prompt-research-store.js';

const ORIGINAL_AUTH_MODE = process.env.AEOSTUDIO_AUTH_MODE;
const ORIGINAL_ADAPTER_MODE = process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE;
const ORIGINAL_ALLOW_FAKE_RUNTIME = process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_API_DATABASE_POOL_MAX = process.env.API_DATABASE_POOL_MAX;
const ORIGINAL_SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY;
const ORIGINAL_DELETION_RECEIPT_SIGNING_KEY = process.env.DELETION_RECEIPT_SIGNING_KEY;
const ORIGINAL_AWS_REGION = process.env.AWS_REGION;
const ORIGINAL_AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID;
const ORIGINAL_ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET;
const ORIGINAL_AUDIT_EVIDENCE_BUCKET = process.env.AUDIT_EVIDENCE_BUCKET;
const ORIGINAL_S3_KMS_KEY_ARN = process.env.S3_KMS_KEY_ARN;
const ORIGINAL_TENANT_DATA_BROKER_ENDPOINT = process.env.TENANT_DATA_BROKER_ENDPOINT;
const ORIGINAL_TENANT_DATA_BROKER_AUDIENCE = process.env.TENANT_DATA_BROKER_AUDIENCE;
const ORIGINAL_TENANT_DATA_BROKER_HMAC_KEY_RING = process.env.TENANT_DATA_BROKER_HMAC_KEY_RING;

const context = {
  tenantId: '00000000-0000-7000-8000-000000000001',
  workspaceId: '00000000-0000-7000-8000-000000000002',
  actorUserId: '00000000-0000-7000-8000-000000000003',
  membershipId: '00000000-0000-7000-8000-000000000004',
  role: 'PUBLISHER' as const,
};
type RuntimeOverrides = Parameters<typeof resolveApiRuntime>[0];

afterEach(() => {
  restoreEnvironment('AEOSTUDIO_AUTH_MODE', ORIGINAL_AUTH_MODE);
  restoreEnvironment('AEOSTUDIO_CHANNEL_ADAPTER_MODE', ORIGINAL_ADAPTER_MODE);
  restoreEnvironment('AEOSTUDIO_ALLOW_FAKE_RUNTIME', ORIGINAL_ALLOW_FAKE_RUNTIME);
  restoreEnvironment('NODE_ENV', ORIGINAL_NODE_ENV);
  restoreEnvironment('DATABASE_URL', ORIGINAL_DATABASE_URL);
  restoreEnvironment('API_DATABASE_POOL_MAX', ORIGINAL_API_DATABASE_POOL_MAX);
  restoreEnvironment('SESSION_ENCRYPTION_KEY', ORIGINAL_SESSION_ENCRYPTION_KEY);
  restoreEnvironment('DELETION_RECEIPT_SIGNING_KEY', ORIGINAL_DELETION_RECEIPT_SIGNING_KEY);
  restoreEnvironment('AWS_REGION', ORIGINAL_AWS_REGION);
  restoreEnvironment('AWS_ACCOUNT_ID', ORIGINAL_AWS_ACCOUNT_ID);
  restoreEnvironment('ARTIFACT_BUCKET', ORIGINAL_ARTIFACT_BUCKET);
  restoreEnvironment('AUDIT_EVIDENCE_BUCKET', ORIGINAL_AUDIT_EVIDENCE_BUCKET);
  restoreEnvironment('S3_KMS_KEY_ARN', ORIGINAL_S3_KMS_KEY_ARN);
  restoreEnvironment('TENANT_DATA_BROKER_ENDPOINT', ORIGINAL_TENANT_DATA_BROKER_ENDPOINT);
  restoreEnvironment('TENANT_DATA_BROKER_AUDIENCE', ORIGINAL_TENANT_DATA_BROKER_AUDIENCE);
  restoreEnvironment('TENANT_DATA_BROKER_HMAC_KEY_RING', ORIGINAL_TENANT_DATA_BROKER_HMAC_KEY_RING);
});

describe.sequential('Task 10 explicit fake publication runtime', () => {
  test('fails closed when any fake runtime switch is configured in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AEOSTUDIO_AUTH_MODE = 'fake';
    process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE = 'fake';

    await expect(resolveApiRuntime({})).rejects.toThrow('FAKE_RUNTIME_FORBIDDEN_IN_PRODUCTION');
  });

  test('installs Broker-backed payload stores instead of process-memory stores in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AEOSTUDIO_AUTH_MODE;
    delete process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE;
    process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/unused';
    process.env.API_DATABASE_POOL_MAX = '5';
    process.env.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64url');
    process.env.DELETION_RECEIPT_SIGNING_KEY = Buffer.alloc(32, 17).toString('base64url');
    configureProductionTenantDataBrokerEnvironment();

    const runtime = await resolveApiRuntime({
      oidcClient: new FakeOidcClient('http://127.0.0.1/unused-fake-oidc'),
    });
    expect(runtime.options.channelPackagePayloadStore).toBeDefined();
    expect(runtime.options.artifactPayloadStore).toBeDefined();
    await runtime.cleanup();
  });

  test('isolates committed budget units by both tenant and workspace', async () => {
    const jobs = new InMemoryJobBudgetStore();
    const otherWorkspaceContext = {
      ...context,
      workspaceId: '00000000-0000-7000-8000-000000000099',
      membershipId: '00000000-0000-7000-8000-000000000098',
    };
    for (const scopedContext of [context, otherWorkspaceContext]) {
      await jobs.setBudget({
        context: scopedContext,
        policyId: randomUUID(),
        limitUnits: 5,
        auditEventId: randomUUID(),
      });
    }
    const submit = (scopedContext: typeof context, suffix: string) =>
      jobs.submitJob({
        context: scopedContext,
        jobId: randomUUID(),
        jobType: 'PUBLICATION',
        aggregateId: randomUUID(),
        idempotencyKey: `workspace-budget-${suffix}`,
        estimatedUnits: 5,
        reservationId: randomUUID(),
        budgetAlertId: randomUUID(),
        outboxMessageId: randomUUID(),
        auditEventId: randomUUID(),
      });

    await expect(submit(context, 'primary')).resolves.toMatchObject({ status: 'QUEUED' });
    await expect(submit(otherWorkspaceContext, 'other')).resolves.toMatchObject({
      status: 'QUEUED',
    });
  });

  test('provides an explicit Publisher identity for the fake OIDC login flow', async () => {
    const identity = await new FakeOidcClient('http://127.0.0.1/fake-authorize').exchangeCode({
      code: 'fake-code-publisher',
      codeVerifier: 'fake-verifier',
      expectedNonce: 'fake-nonce',
      redirectUri: 'http://127.0.0.1/callback',
    });

    expect(identity).toEqual({
      subject: 'fake-publisher-subject',
      email: 'publisher@example.test',
      emailVerified: true,
    });
  });

  test('registers publishing metadata and executable stores only when both fake switches are enabled', async () => {
    process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME = 'true';
    process.env.AEOSTUDIO_AUTH_MODE = 'fake';
    delete process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE;

    const authOnly = await resolveApiRuntime({});
    const authOnlyChannels = await authOnly.options.channelRegistryStore?.listEntries({ context });
    expect(authOnlyChannels?.map((channel) => channel.channelKey)).toEqual([
      'portable-web-export',
      'third-party-site-handoff',
      'social-channel-handoff',
      'directory-handoff',
    ]);
    expect(authOnly.options.channelAuthorizationStore).toBeUndefined();
    expect(authOnly.options.publicationCommandStore).toBeUndefined();
    expect(authOnly.options.publicationQueryStore).toBeUndefined();
    expect(authOnly.options.runtimeChannelAdapters).toBeUndefined();
    await authOnly.cleanup();

    delete process.env.AEOSTUDIO_AUTH_MODE;
    process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE = 'fake';
    const adapterOnly = await resolveApiRuntime({});
    expect(adapterOnly.options.channelRegistryStore).toBeUndefined();
    expect(adapterOnly.options.channelAuthorizationStore).toBeUndefined();
    expect(adapterOnly.options.publicationCommandStore).toBeUndefined();
    expect(adapterOnly.options.publicationQueryStore).toBeUndefined();
    expect(adapterOnly.options.runtimeChannelAdapters).toBeUndefined();
    await adapterOnly.cleanup();

    process.env.AEOSTUDIO_AUTH_MODE = 'fake';
    process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE = 'fake';
    const explicitFakePublication = await resolveApiRuntime({});
    const channels = await explicitFakePublication.options.channelRegistryStore?.listEntries({
      context,
    });

    expect(channels?.map((channel) => channel.channelKey)).toEqual([
      'portable-web-export',
      'third-party-site-handoff',
      'social-channel-handoff',
      'directory-handoff',
      'reviewed-test-publisher',
    ]);
    expect(
      channels?.find((channel) => channel.channelKey === 'reviewed-test-publisher'),
    ).toMatchObject({
      displayName: 'Reviewed Test Publisher',
      adapterVersions: [
        {
          adapterKey: 'fake-ambiguous',
          adapterVersion: 'v1',
          requiredScopes: ['content:write'],
        },
      ],
    });
    expect(explicitFakePublication.options.channelAuthorizationStore).toBeDefined();
    expect(explicitFakePublication.options.publicationCommandStore).toBeDefined();
    expect(explicitFakePublication.options.publicationQueryStore).toBe(
      explicitFakePublication.options.publicationCommandStore,
    );
    expect(
      explicitFakePublication.options.runtimeChannelAdapters?.resolve('fake-ambiguous', 'v1'),
    ).not.toBeNull();
    await explicitFakePublication.cleanup();
  });

  test('runs an approved and budgeted Publisher command through ambiguity and reconciliation exactly once', async () => {
    process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME = 'true';
    process.env.AEOSTUDIO_AUTH_MODE = 'fake';
    process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE = 'fake';
    const now = new Date('2026-07-21T00:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const runtime = await resolveApiRuntime({ clock });
    const ids = { next: randomUUID };
    const tenancy = required(runtime.options.tenancyStore, 'tenancyStore');
    const artifactStore = required(runtime.options.artifactStore, 'artifactStore');
    const artifactPayloads = required(runtime.options.artifactPayloadStore, 'artifactPayloadStore');
    const artifactPayloadReader = required(
      runtime.options.artifactPayloadReader,
      'artifactPayloadReader',
    );
    const packageStore = required(runtime.options.channelPackageStore, 'channelPackageStore');
    const packagePayloads = required(
      runtime.options.channelPackagePayloadStore,
      'channelPackagePayloadStore',
    );
    const packagePayloadReader = required(
      runtime.options.channelPackagePayloadReader,
      'channelPackagePayloadReader',
    );
    const registry = required(runtime.options.channelRegistryStore, 'channelRegistryStore');
    const authorizations = required(
      runtime.options.channelAuthorizationStore,
      'channelAuthorizationStore',
    );
    const runtimeAdapters = required(
      runtime.options.runtimeChannelAdapters,
      'runtimeChannelAdapters',
    );
    const publicationStore = required(
      runtime.options.publicationCommandStore,
      'publicationCommandStore',
    );
    const publicationQueries = required(
      runtime.options.publicationQueryStore,
      'publicationQueryStore',
    );
    const jobs = required(runtime.options.jobBudgetStore, 'jobBudgetStore');
    const promptStore = required(
      runtime.options.promptResearchStore,
      'promptResearchStore',
    ) as InMemoryPromptResearchStore;
    const promptLineageRead = vi.spyOn(promptStore, 'findRevisionNow');
    const claimLineageRead = vi.spyOn(
      required(
        runtime.options.evidenceClaimStore,
        'evidenceClaimStore',
      ) as InMemoryEvidenceClaimStore,
      'findClaimForReviewNow',
    );

    const ownerContext = await bootstrapPublisherWorkspace(tenancy);
    const publisherContext = required(
      await tenancy.resolveTenantContext({
        actorSubject: 'fake-publisher-subject',
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
      }),
      'publisherContext',
    );
    await jobs.setBudget({
      context: ownerContext,
      policyId: randomUUID(),
      limitUnits: 100,
      auditEventId: randomUUID(),
    });

    const approved = await prepareApprovedArtifact({
      artifactStore,
      artifactPayloads,
      ownerContext,
      now,
    });
    const packageService = new ChannelPackageService(
      packageStore,
      packagePayloads,
      packagePayloadReader,
      registry,
      new DefaultChannelPackageTransformerRegistry(),
      artifactStore,
      artifactPayloadReader,
      tenancy,
      ids,
      clock,
    );
    const built = await packageService.build({
      actorSubject: 'fake-publisher-subject',
      sessionToken: 'task-10-explicit-fake-session',
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      artifactId: approved.artifactId,
      artifactRevisionId: approved.artifactRevisionId,
      revision: 1,
      expectedContentHash: approved.contentHash,
      channelKey: 'reviewed-test-publisher',
    });
    expect(built.outcome).toBe('SUCCEEDED');
    if (built.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_APPROVED_PACKAGE');

    const authorizationService = new ChannelAuthorizationService(
      authorizations,
      registry,
      tenancy,
      ids,
      clock,
    );
    const authorization = await authorizationService.create({
      actorSubject: 'fake-owner-subject',
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      adapterVersionId: '00000000-0000-7000-8000-000000001002',
      target: 'fixture://reviewed/arbitrary-target',
      grantedScopes: ['content:write'],
      acceptedTermsVersion: 'test-terms-v1',
      secretArn: 'arn:aws:secretsmanager:test:000000000000:secret:fixture-secret-ref',
      expiresAt: '2036-01-01T00:00:00.000Z',
    });
    expect(authorization.outcome).toBe('SUCCEEDED');
    const authorizationList = await authorizationService.list({
      actorSubject: 'fake-owner-subject',
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
    });
    expect(authorizationList.outcome).toBe('SUCCEEDED');
    expect(JSON.stringify(authorizationList)).not.toContain('fixture-secret-ref');
    expect(JSON.stringify(authorizationList)).not.toContain('secretArn');

    const eligibility = new PublicationEligibilityService(
      packageService,
      registry,
      authorizations,
      runtimeAdapters,
      tenancy,
      clock,
    );
    const commands = new PublicationCommandService(
      eligibility,
      publicationStore,
      tenancy,
      ids,
      clock,
    );
    const request = {
      actorSubject: 'fake-publisher-subject',
      sessionToken: 'task-10-explicit-fake-session',
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      channelPackageId: built.package.id,
      adapterVersionId: '00000000-0000-7000-8000-000000001002',
      target: 'fixture://reviewed/arbitrary-target',
      expectedPackageChecksum: built.package.packageChecksum,
      idempotencyKey: 'publish-approved-r1',
    };
    const [submitted, concurrentDuplicate] = await Promise.all([
      commands.request(request),
      commands.request(request),
    ]);
    expect(submitted.outcome).toBe('SUCCEEDED');
    if (submitted.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_PUBLICATION_SUBMISSION');
    expect(concurrentDuplicate).toMatchObject({
      outcome: 'SUCCEEDED',
      created: false,
      publication: { id: submitted.publication.id },
      job: { id: submitted.job.id },
    });
    expect(submitted.publication.status).toBe('QUEUED');
    expect(submitted.job.status).toBe('QUEUED');

    await jobs.findJob({ context: publisherContext, jobId: submitted.job.id });
    await jobs.findJob({ context: publisherContext, jobId: submitted.job.id });
    await jobs.findJob({ context: publisherContext, jobId: submitted.job.id });

    const query = new PublicationQueryService(publicationQueries, tenancy);
    const detail = required(
      await query.get({
        actorSubject: 'fake-publisher-subject',
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        publicationId: submitted.publication.id,
      }),
      'publicationDetail',
    );
    expect(detail.job.errorCode).toBeNull();
    expect(detail.publication).toMatchObject({
      id: submitted.publication.id,
      status: 'PUBLISHED',
      remoteRef: `fake://remote/${submitted.publication.id}`,
    });
    expect(detail.attempts.map(({ operation, outcome }) => ({ operation, outcome }))).toEqual([
      { operation: 'PUBLISH', outcome: 'AMBIGUOUS' },
      { operation: 'RECONCILE', outcome: 'APPLIED' },
    ]);
    expect(detail.job).toMatchObject({ status: 'SUCCEEDED', progress: 100, attempt: 1 });
    expect(promptLineageRead).toHaveBeenCalledWith(
      expect.objectContaining({
        promptSetId: FAKE_ARTIFACT_LINEAGE.promptSetId,
        revisionId: FAKE_ARTIFACT_LINEAGE.promptRevisionId,
      }),
    );
    expect(claimLineageRead).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: FAKE_ARTIFACT_LINEAGE.claimId,
        revisionId: FAKE_ARTIFACT_LINEAGE.claimRevisionId,
      }),
    );

    const duplicate = await commands.request(request);
    expect(duplicate).toMatchObject({
      outcome: 'SUCCEEDED',
      created: false,
      publication: { id: submitted.publication.id, status: 'PUBLISHED' },
      job: { id: submitted.job.id, status: 'SUCCEEDED' },
    });
    const adapter = runtimeAdapters.resolve('fake-ambiguous', 'v1');
    expect(adapter).toBeInstanceOf(FakeAmbiguousPublicationAdapter);
    if (!(adapter instanceof FakeAmbiguousPublicationAdapter)) {
      throw new Error('EXPECTED_FAKE_AMBIGUOUS_ADAPTER');
    }
    expect(adapter.snapshot()).toMatchObject({
      effectCount: 1,
      publishCalls: 1,
      reconcileCalls: 1,
    });

    const registrySnapshot = await registry.listEntries({ context: publisherContext });
    const assertRegistryGate = async (
      name: string,
      mutate: (entry: (typeof registrySnapshot)[number]) => (typeof registrySnapshot)[number],
    ) => {
      const gateStale = await commands.request({
        ...request,
        idempotencyKey: `publish-registry-gate-${name}`,
      });
      expect(gateStale.outcome).toBe('SUCCEEDED');
      if (gateStale.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_STALE_GATE_SUBMISSION');
      const registrySpy = vi
        .spyOn(registry, 'listEntries')
        .mockResolvedValue(
          registrySnapshot.map((entry) =>
            entry.channelKey === 'reviewed-test-publisher' ? mutate(entry) : entry,
          ),
        );
      await jobs.findJob({ context: publisherContext, jobId: gateStale.job.id });
      await jobs.findJob({ context: publisherContext, jobId: gateStale.job.id });
      await jobs.findJob({ context: publisherContext, jobId: gateStale.job.id });
      registrySpy.mockRestore();
      const gateStaleDetail = required(
        await query.get({
          actorSubject: 'fake-publisher-subject',
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          publicationId: gateStale.publication.id,
        }),
        'gateStalePublicationDetail',
      );
      expect(gateStaleDetail).toMatchObject({
        publication: { status: 'FAILED_TERMINAL', remoteRef: null },
        job: { status: 'FAILED_TERMINAL', errorCode: 'PUBLICATION_GATE_STALE' },
      });
      expect(adapter.snapshot()).toMatchObject({
        effectCount: 1,
        publishCalls: 1,
        reconcileCalls: 1,
      });
    };
    await assertRegistryGate('channel-unavailable', (entry) => ({
      ...entry,
      status: 'UNAVAILABLE',
      unavailableReason: 'Fixture gate closed.',
    }));
    await assertRegistryGate('adapter-disabled', (entry) => ({
      ...entry,
      adapterVersions: entry.adapterVersions.map((adapterVersion) => ({
        ...adapterVersion,
        enabled: false,
        disabledReason: 'Fixture gate closed.',
      })),
    }));
    await assertRegistryGate('reconcile-capability-missing', (entry) => ({
      ...entry,
      adapterVersions: entry.adapterVersions.map((adapterVersion) => ({
        ...adapterVersion,
        capabilities: adapterVersion.capabilities.filter(
          (capability) => capability !== 'RECONCILE',
        ),
      })),
    }));
    await assertRegistryGate('terms-prohibited', (entry) => ({
      ...entry,
      adapterVersions: entry.adapterVersions.map((adapterVersion) => ({
        ...adapterVersion,
        termsStatus: 'PROHIBITED',
      })),
    }));

    const roleStale = await commands.request({
      ...request,
      idempotencyKey: 'publish-role-became-ineligible',
    });
    expect(roleStale.outcome).toBe('SUCCEEDED');
    if (roleStale.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_ROLE_STALE_SUBMISSION');
    await tenancy.changeMembershipRole({
      context: ownerContext,
      membershipId: publisherContext.membershipId,
      role: 'REVIEWER',
      auditEventId: randomUUID(),
    });
    await jobs.findJob({ context: publisherContext, jobId: roleStale.job.id });
    await jobs.findJob({ context: publisherContext, jobId: roleStale.job.id });
    await jobs.findJob({ context: publisherContext, jobId: roleStale.job.id });
    const roleStaleDetail = required(
      await query.get({
        actorSubject: 'fake-publisher-subject',
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        publicationId: roleStale.publication.id,
      }),
      'roleStalePublicationDetail',
    );
    expect(roleStaleDetail).toMatchObject({
      publication: { status: 'FAILED_TERMINAL', remoteRef: null },
      job: { status: 'FAILED_TERMINAL', errorCode: 'PUBLICATION_GATE_STALE' },
    });
    expect(adapter.snapshot()).toMatchObject({
      effectCount: 1,
      publishCalls: 1,
      reconcileCalls: 1,
    });
    await tenancy.changeMembershipRole({
      context: ownerContext,
      membershipId: publisherContext.membershipId,
      role: 'PUBLISHER',
      auditEventId: randomUUID(),
    });

    const approvalStale = await commands.request({
      ...request,
      idempotencyKey: 'publish-approval-became-stale',
    });
    expect(approvalStale.outcome).toBe('SUCCEEDED');
    if (approvalStale.outcome !== 'SUCCEEDED') {
      throw new Error('EXPECTED_APPROVAL_STALE_SUBMISSION');
    }
    const findBundle = artifactStore.findBundle.bind(artifactStore);
    const artifactSpy = vi.spyOn(artifactStore, 'findBundle').mockImplementation(async (input) => {
      const bundle = await findBundle(input);
      return bundle === null ? null : { ...bundle, selectableApprovedRevisions: [] };
    });
    await jobs.findJob({ context: publisherContext, jobId: approvalStale.job.id });
    await jobs.findJob({ context: publisherContext, jobId: approvalStale.job.id });
    await jobs.findJob({ context: publisherContext, jobId: approvalStale.job.id });
    artifactSpy.mockRestore();
    const approvalStaleDetail = required(
      await query.get({
        actorSubject: 'fake-publisher-subject',
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        publicationId: approvalStale.publication.id,
      }),
      'approvalStalePublicationDetail',
    );
    expect(approvalStaleDetail).toMatchObject({
      publication: { status: 'FAILED_TERMINAL', remoteRef: null },
      job: { status: 'FAILED_TERMINAL', errorCode: 'PUBLICATION_GATE_STALE' },
    });
    expect(adapter.snapshot()).toMatchObject({
      effectCount: 1,
      publishCalls: 1,
      reconcileCalls: 1,
    });

    const typedTerminal = await commands.request({
      ...request,
      idempotencyKey: 'publish-typed-terminal-failure',
    });
    expect(typedTerminal.outcome).toBe('SUCCEEDED');
    if (typedTerminal.outcome !== 'SUCCEEDED') {
      throw new Error('EXPECTED_TYPED_TERMINAL_SUBMISSION');
    }
    const publishSpy = vi.spyOn(adapter, 'publish').mockResolvedValue({
      outcome: 'TERMINAL_FAILURE',
      errorCode: 'fake-secret-must-not-persist',
    });
    await jobs.findJob({ context: publisherContext, jobId: typedTerminal.job.id });
    await jobs.findJob({ context: publisherContext, jobId: typedTerminal.job.id });
    await jobs.findJob({ context: publisherContext, jobId: typedTerminal.job.id });
    publishSpy.mockRestore();
    const typedTerminalDetail = required(
      await query.get({
        actorSubject: 'fake-publisher-subject',
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        publicationId: typedTerminal.publication.id,
      }),
      'typedTerminalPublicationDetail',
    );
    expect(typedTerminalDetail).toMatchObject({
      publication: { status: 'FAILED_TERMINAL', remoteRef: null },
      attempts: [
        {
          operation: 'PUBLISH',
          outcome: 'TERMINAL_FAILURE',
          errorCode: 'ADAPTER_PUBLISH_TERMINAL_FAILURE',
        },
      ],
      job: { status: 'FAILED_TERMINAL', errorCode: 'ADAPTER_PUBLISH_TERMINAL_FAILURE' },
    });
    expect(adapter.snapshot()).toMatchObject({
      effectCount: 1,
      publishCalls: 1,
      reconcileCalls: 1,
    });

    const reconcileGateStale = await commands.request({
      ...request,
      idempotencyKey: 'publish-reconcile-gate-became-stale',
    });
    expect(reconcileGateStale.outcome).toBe('SUCCEEDED');
    if (reconcileGateStale.outcome !== 'SUCCEEDED') {
      throw new Error('EXPECTED_RECONCILE_GATE_STALE_SUBMISSION');
    }
    const reconcileSpy = vi.spyOn(adapter, 'reconcile').mockResolvedValueOnce({
      outcome: 'RETRYABLE_FAILURE',
      errorCode: 'fake-secret-must-not-persist',
    });
    await jobs.findJob({ context: publisherContext, jobId: reconcileGateStale.job.id });
    await jobs.findJob({ context: publisherContext, jobId: reconcileGateStale.job.id });
    await jobs.findJob({ context: publisherContext, jobId: reconcileGateStale.job.id });
    const retryWaitingDetail = required(
      await query.get({
        actorSubject: 'fake-publisher-subject',
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        publicationId: reconcileGateStale.publication.id,
      }),
      'retryWaitingPublicationDetail',
    );
    expect(retryWaitingDetail).toMatchObject({
      publication: { status: 'RECONCILE_REQUIRED', remoteRef: null },
      job: { status: 'RUNNING', errorCode: 'ADAPTER_RECONCILE_RETRYABLE_FAILURE' },
    });
    expect(
      retryWaitingDetail.attempts.map(({ operation, outcome }) => ({ operation, outcome })),
    ).toEqual([
      { operation: 'PUBLISH', outcome: 'AMBIGUOUS' },
      { operation: 'RECONCILE', outcome: 'RETRYABLE_FAILURE' },
    ]);

    if (authorization.outcome !== 'SUCCEEDED') {
      throw new Error('EXPECTED_CHANNEL_AUTHORIZATION');
    }
    await expect(
      authorizationService.revoke({
        actorSubject: 'fake-owner-subject',
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        authorizationId: authorization.authorization.id,
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
    await jobs.findJob({ context: publisherContext, jobId: reconcileGateStale.job.id });
    await jobs.findJob({ context: publisherContext, jobId: reconcileGateStale.job.id });
    reconcileSpy.mockRestore();
    const gateFailedReconcileDetail = required(
      await query.get({
        actorSubject: 'fake-publisher-subject',
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        publicationId: reconcileGateStale.publication.id,
      }),
      'gateFailedReconcilePublicationDetail',
    );
    expect(gateFailedReconcileDetail).toMatchObject({
      publication: { status: 'MANUAL_REVIEW_REQUIRED', remoteRef: null },
      job: { status: 'FAILED_TERMINAL', errorCode: 'PUBLICATION_AUTHORIZATION_STALE' },
    });
    expect(
      gateFailedReconcileDetail.attempts.map(({ operation, outcome }) => ({ operation, outcome })),
    ).toEqual([
      { operation: 'PUBLISH', outcome: 'AMBIGUOUS' },
      { operation: 'RECONCILE', outcome: 'RETRYABLE_FAILURE' },
    ]);

    now.setSeconds(now.getSeconds() + 1);
    await expect(
      authorizationService.create({
        actorSubject: 'fake-owner-subject',
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        adapterVersionId: '00000000-0000-7000-8000-000000001002',
        target: 'fixture://reviewed/arbitrary-target',
        grantedScopes: ['content:write'],
        acceptedTermsVersion: 'test-terms-v1',
        secretArn: 'arn:aws:secretsmanager:test:000000000000:secret:fixture-secret-ref',
        expiresAt: '2036-01-01T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });

    await jobs.setBudget({
      context: ownerContext,
      policyId: randomUUID(),
      limitUnits: 5,
      auditEventId: randomUUID(),
    });
    const budgetBlocked = await commands.request({
      ...request,
      idempotencyKey: 'publish-over-budget',
    });
    expect(budgetBlocked).toMatchObject({
      outcome: 'SUCCEEDED',
      publication: { status: 'BUDGET_BLOCKED', remoteRef: null },
      job: { status: 'BUDGET_BLOCKED' },
    });
    expect(adapter.snapshot()).toMatchObject({
      effectCount: 2,
      publishCalls: 2,
      reconcileCalls: 1,
    });
    const currentBundle = required(
      await artifactStore.findBundle({
        context: ownerContext,
        artifactId: approved.artifactId,
        effectiveAt: clock.now(),
      }),
      'currentArtifactBundle',
    );
    const currentRevision = required(currentBundle.revision, 'currentArtifactRevision');
    const currentPayload = required(
      await artifactPayloads.get(currentRevision.payloadObjectRef),
      'currentArtifactPayload',
    );
    const revisedPayload = { ...currentPayload, summary: `${currentPayload.summary}X` };
    const revisionTwoHash = hashArtifactRevision({
      schemaVersion: currentRevision.schemaVersion,
      artifactId: currentRevision.artifactId,
      revision: 2,
      type: currentRevision.type,
      locale: currentRevision.locale,
      market: currentRevision.market,
      sourceArtifactIds: currentRevision.sourceArtifactIds,
      lineage: currentRevision.lineage,
      claimBindings: currentRevision.claimBindings,
      methodPolicyVersion: currentRevision.methodPolicyVersion,
      payload: revisedPayload,
    });
    const storedRevisionTwo = await artifactPayloads.put({
      tenantId: ownerContext.tenantId,
      workspaceId: ownerContext.workspaceId,
      artifactId: approved.artifactId,
      revision: 2,
      contentHash: revisionTwoHash,
      payload: revisedPayload,
    });
    await expect(
      artifactStore.createRevision({
        context: ownerContext,
        artifactId: approved.artifactId,
        expectedRevision: 1,
        revisionId: randomUUID(),
        contentHash: revisionTwoHash,
        payloadObjectRef: storedRevisionTwo.objectRef,
        createdAt: clock.now(),
        claimLinkIds: currentRevision.claimBindings.flatMap((binding) =>
          binding.evidence.map(() => randomUUID()),
        ),
        auditEventId: randomUUID(),
      }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' });
    await expect(eligibility.check(request)).resolves.toMatchObject({ outcome: 'APPROVAL_STALE' });
    await expect(
      commands.request({
        ...request,
        idempotencyKey: 'publish-approved-r1-after-r2',
      }),
    ).resolves.toMatchObject({ outcome: 'APPROVAL_STALE' });
    await expect(
      packageService.export({
        actorSubject: 'fake-publisher-subject',
        sessionToken: request.sessionToken,
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        packageId: built.package.id,
      }),
    ).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      package: { id: built.package.id, packageChecksum: built.package.packageChecksum },
    });

    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain('fixture-secret-ref');
    expect(serialized).not.toContain('fake-publication-secret');
    expect(serialized).not.toContain('secretArn');
    expect(serialized).not.toContain('secretValue');
    await runtime.cleanup();
  });

  test('rejects fake-runtime package creation after its approved Prompt lineage advances', async () => {
    const fixture = await createFakePackageBuildFixture();
    try {
      const approvedPrompt = await seedApprovedPrompt(fixture.prompts, fixture.ownerContext);
      await fixture.prompts.createRevision({
        context: fixture.ownerContext,
        promptSetId: approvedPrompt.promptSet.id,
        expectedRevision: approvedPrompt.revision.revision,
        revisionId: randomUUID(),
        scenarioId: randomUUID(),
        prompts: approvedPrompt.revision.prompts,
        scopes: approvedPrompt.revision.scopes,
        scenario: promptScenarioInput(approvedPrompt),
        promptContentHash: '9'.repeat(64),
        scenarioContentHash: '8'.repeat(64),
        createdAt: fixture.clock.now(),
        auditEventId: randomUUID(),
      });

      await expect(fixture.build()).resolves.toEqual({ outcome: 'APPROVAL_STALE' });
    } finally {
      await fixture.runtime.cleanup();
    }
  });

  test('rejects fake-runtime package creation after its approved Claim expires', async () => {
    const fixture = await createFakePackageBuildFixture();
    try {
      fixture.setNow(new Date('2037-01-01T00:00:00.000Z'));

      await expect(fixture.build()).resolves.toEqual({ outcome: 'APPROVAL_STALE' });
    } finally {
      await fixture.runtime.cleanup();
    }
  });

  test('rejects fake-runtime package creation after its Evidence source advances', async () => {
    const fixture = await createFakePackageBuildFixture();
    try {
      await seedApprovedClaim(fixture.claims, fixture.ownerContext, fixture.clock.now());
      await fixture.claims.createSnapshot({
        context: fixture.ownerContext,
        snapshotId: randomUUID(),
        sourceId: FAKE_ARTIFACT_LINEAGE.evidenceSourceId,
        contentHash: '7'.repeat(64),
        objectRef: 'memory://fake-package-currentness/evidence-r2',
        contentType: 'text/plain',
        sizeBytes: 256,
        capturedAt: fixture.clock.now(),
        auditEventId: randomUUID(),
      });

      await expect(fixture.build()).resolves.toEqual({ outcome: 'APPROVAL_STALE' });
    } finally {
      await fixture.runtime.cleanup();
    }
  });

  test.each([
    {
      kind: 'Prompt',
      overrides: {
        promptResearchStore: {} as NonNullable<RuntimeOverrides['promptResearchStore']>,
      },
    },
    {
      kind: 'Claim',
      overrides: {
        evidenceClaimStore: {} as NonNullable<RuntimeOverrides['evidenceClaimStore']>,
      },
    },
  ])(
    'fails closed when the fake package fence has no synchronous in-memory $kind truth',
    async ({ overrides }) => {
      const fixture = await createFakePackageBuildFixture(overrides);
      try {
        await expect(fixture.build()).resolves.toEqual({ outcome: 'APPROVAL_STALE' });
      } finally {
        await fixture.runtime.cleanup();
      }
    },
  );
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configureProductionTenantDataBrokerEnvironment(): void {
  process.env.AWS_REGION = 'ap-southeast-1';
  process.env.AWS_ACCOUNT_ID = '123456789012';
  process.env.ARTIFACT_BUCKET = 'aeostudio-test-artifacts';
  process.env.AUDIT_EVIDENCE_BUCKET = 'aeostudio-test-audit-evidence';
  process.env.S3_KMS_KEY_ARN =
    'arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-4000-8000-000000000018';
  process.env.TENANT_DATA_BROKER_ENDPOINT =
    'https://broker.example.internal/internal/v1/tenant-data';
  process.env.TENANT_DATA_BROKER_AUDIENCE = 'broker.example.internal';
  process.env.TENANT_DATA_BROKER_HMAC_KEY_RING = JSON.stringify({
    schemaVersion: 'aeostudio.tenant-data-broker-key-ring.v1',
    current: {
      id: 'current-2026-07',
      value: Buffer.alloc(32, 41).toString('base64url'),
    },
  });
}

function required<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) throw new Error(`EXPECTED_${name.toUpperCase()}`);
  return value;
}

async function bootstrapPublisherWorkspace(tenancy: TenancyStore): Promise<TenantContext> {
  await tenancy.bootstrapTenant({
    actorSubject: 'fake-owner-subject',
    actorEmail: 'owner@example.test',
    userId: context.actorUserId,
    tenantId: context.tenantId,
    tenantName: 'Fake Publication Tenant',
    workspaceId: context.workspaceId,
    workspaceName: 'Fake Publication Workspace',
    membershipId: context.membershipId,
    roleBindingId: randomUUID(),
    auditEventId: randomUUID(),
  });
  const ownerContext = required(
    await tenancy.resolveTenantContext({
      actorSubject: 'fake-owner-subject',
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
    }),
    'ownerContext',
  );
  const invited = await tenancy.inviteMembership({
    context: ownerContext,
    invitedEmail: 'publisher@example.test',
    role: 'PUBLISHER',
    invitedUserId: '00000000-0000-7000-8000-000000000005',
    membershipId: '00000000-0000-7000-8000-000000000006',
    roleBindingId: randomUUID(),
    auditEventId: randomUUID(),
  });
  await tenancy.acceptMembership({
    actorSubject: 'fake-publisher-subject',
    actorEmail: 'publisher@example.test',
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    membershipId: invited.id,
    auditEventId: randomUUID(),
  });
  return ownerContext;
}

async function createFakePackageBuildFixture(overrides: RuntimeOverrides = {}) {
  process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME = 'true';
  process.env.AEOSTUDIO_AUTH_MODE = 'fake';
  process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE = 'fake';
  let currentNow = new Date('2026-07-24T00:00:00.000Z');
  const clock = { now: () => new Date(currentNow) };
  const runtime = await resolveApiRuntime({ ...overrides, clock });
  try {
    const tenancy = required(runtime.options.tenancyStore, 'tenancyStore');
    const ownerContext = await bootstrapPublisherWorkspace(tenancy);
    const artifactStore = required(runtime.options.artifactStore, 'artifactStore');
    const artifactPayloads = required(runtime.options.artifactPayloadStore, 'artifactPayloadStore');
    const approved = await prepareApprovedArtifact({
      artifactStore,
      artifactPayloads,
      ownerContext,
      now: clock.now(),
    });
    const packages = new ChannelPackageService(
      required(runtime.options.channelPackageStore, 'channelPackageStore'),
      required(runtime.options.channelPackagePayloadStore, 'channelPackagePayloadStore'),
      required(runtime.options.channelPackagePayloadReader, 'channelPackagePayloadReader'),
      required(runtime.options.channelRegistryStore, 'channelRegistryStore'),
      new DefaultChannelPackageTransformerRegistry(),
      artifactStore,
      required(runtime.options.artifactPayloadReader, 'artifactPayloadReader'),
      tenancy,
      { next: randomUUID },
      clock,
    );
    const prompts = required(
      runtime.options.promptResearchStore,
      'promptResearchStore',
    ) as InMemoryPromptResearchStore;
    const claims = required(
      runtime.options.evidenceClaimStore,
      'evidenceClaimStore',
    ) as InMemoryEvidenceClaimStore;
    return {
      runtime,
      ownerContext,
      clock,
      prompts,
      claims,
      setNow(value: Date) {
        currentNow = new Date(value);
      },
      build: () =>
        packages.build({
          actorSubject: 'fake-publisher-subject',
          sessionToken: 'task-10-fake-package-currentness-session',
          tenantId: ownerContext.tenantId,
          workspaceId: ownerContext.workspaceId,
          artifactId: approved.artifactId,
          artifactRevisionId: approved.artifactRevisionId,
          revision: 1,
          expectedContentHash: approved.contentHash,
          channelKey: 'reviewed-test-publisher',
        }),
    };
  } catch (error) {
    await runtime.cleanup();
    throw error;
  }
}

async function prepareApprovedArtifact(input: {
  artifactStore: NonNullable<
    Awaited<ReturnType<typeof resolveApiRuntime>>['options']['artifactStore']
  >;
  artifactPayloads: NonNullable<
    Awaited<ReturnType<typeof resolveApiRuntime>>['options']['artifactPayloadStore']
  >;
  ownerContext: TenantContext;
  now: Date;
}): Promise<{ artifactId: string; artifactRevisionId: string; contentHash: string }> {
  const artifactId = randomUUID();
  await input.artifactStore.prepareArtifact({
    context: input.ownerContext,
    artifactId,
    briefId: '00000000-0000-7000-8000-000000000910',
    locale: 'en-US',
    market: 'global',
    methodPolicyVersion: 'artifact-fixture-v1',
    createdAt: input.now,
    auditEventId: randomUUID(),
  });
  const writer = required(
    await input.artifactStore.loadWriterContext({
      context: input.ownerContext,
      artifactId,
      effectiveAt: input.now,
    }),
    'artifactWriterContext',
  );
  const payload = await new DeterministicArtifactGenerator().generate(writer);
  const claimBindings = writer.claims.map((claim) => ({
    claimId: claim.claimId,
    claimRevisionId: claim.revisionId,
    claimContentHash: claim.contentHash,
    claimStatement: claim.statement,
    evidence: claim.evidence,
  }));
  const contentHash = hashArtifactRevision({
    schemaVersion: writer.schemaVersion,
    artifactId,
    revision: 1,
    type: writer.type,
    locale: writer.locale,
    market: writer.market,
    sourceArtifactIds: writer.brief.sourceArtifactIds,
    lineage: writer.brief.lineage,
    claimBindings,
    methodPolicyVersion: writer.methodPolicyVersion,
    payload,
  });
  const stored = await input.artifactPayloads.put({
    tenantId: input.ownerContext.tenantId,
    workspaceId: input.ownerContext.workspaceId,
    artifactId,
    revision: 1,
    contentHash,
    payload,
  });
  const artifactRevisionId = randomUUID();
  await input.artifactStore.completeGeneration({
    context: input.ownerContext,
    artifactId,
    revisionId: artifactRevisionId,
    contentHash,
    payloadObjectRef: stored.objectRef,
    sourceArtifactIds: writer.brief.sourceArtifactIds,
    lineage: writer.brief.lineage,
    claimBindings,
    claimLinkIds: claimBindings.flatMap((binding) => binding.evidence.map(() => randomUUID())),
    schemaVersion: writer.schemaVersion,
    createdByActor: { kind: 'AGENT', id: randomUUID() },
    createdAt: input.now,
    auditEventId: randomUUID(),
  });
  await input.artifactStore.submitRevision({
    context: input.ownerContext,
    artifactId,
    revision: 1,
    expectedContentHash: contentHash,
    submittedAt: input.now,
    auditEventId: randomUUID(),
  });
  await input.artifactStore.reviewRevision({
    context: input.ownerContext,
    artifactId,
    revision: 1,
    expectedContentHash: contentHash,
    decision: 'APPROVE',
    note: 'Approved exact fixture revision for fake publication runtime.',
    reviewId: randomUUID(),
    reviewedAt: input.now,
    auditEventId: randomUUID(),
  });
  return { artifactId, artifactRevisionId, contentHash };
}

async function seedApprovedClaim(
  store: InMemoryEvidenceClaimStore,
  ownerContext: TenantContext,
  now: Date,
) {
  const claim = fakeArtifactClaimBundle({
    tenantId: ownerContext.tenantId,
    workspaceId: ownerContext.workspaceId,
    actorUserId: ownerContext.actorUserId,
  });
  const [evidence] = fakeArtifactClaimEvidence({
    tenantId: ownerContext.tenantId,
    workspaceId: ownerContext.workspaceId,
  });
  if (evidence === undefined) throw new Error('EXPECTED_FAKE_CLAIM_EVIDENCE');
  await store.createSource({
    context: ownerContext,
    sourceId: evidence.source.id,
    sourceType: evidence.source.sourceType,
    title: evidence.source.title,
    uri: evidence.source.uri,
    license: evidence.source.license,
    publicity: evidence.source.publicity,
    createdAt: new Date(evidence.source.createdAt),
    auditEventId: randomUUID(),
  });
  await store.createSnapshot({
    context: ownerContext,
    snapshotId: evidence.snapshot.id,
    sourceId: evidence.source.id,
    contentHash: evidence.snapshot.contentHash,
    objectRef: evidence.snapshot.objectRef,
    contentType: evidence.snapshot.contentType,
    sizeBytes: evidence.snapshot.sizeBytes,
    capturedAt: new Date(evidence.snapshot.capturedAt),
    auditEventId: randomUUID(),
  });
  await store.createClaim({
    context: ownerContext,
    claimId: claim.claim.id,
    revisionId: claim.revision.id,
    evidenceLinkIds: [evidence.link.id],
    statement: claim.revision.statement,
    numericValue: claim.revision.numericValue,
    unit: claim.revision.unit,
    scope: claim.revision.scope,
    conditions: claim.revision.conditions,
    expiresAt: claim.revision.expiresAt === null ? null : new Date(claim.revision.expiresAt),
    evidence: [
      {
        snapshotId: evidence.snapshot.id,
        sourceHash: evidence.link.sourceHash,
        snippet: evidence.link.snippet,
      },
    ],
    contentHash: claim.revision.contentHash,
    createdAt: new Date(claim.revision.createdAt),
    auditEventId: randomUUID(),
  });
  await store.submitClaim({
    context: ownerContext,
    claimId: claim.claim.id,
    revisionId: claim.revision.id,
    submittedAt: now,
    auditEventId: randomUUID(),
  });
  const approved = await store.reviewClaim({
    context: ownerContext,
    claimId: claim.claim.id,
    revisionId: claim.revision.id,
    expectedContentHash: claim.revision.contentHash,
    reviewId: randomUUID(),
    decision: 'APPROVE',
    note: 'Approved exact Claim revision for fake package currentness.',
    reviewedAt: now,
    auditEventId: randomUUID(),
  });
  expect(approved.outcome).toBe('SUCCEEDED');
  if (approved.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_APPROVED_CLAIM');
  return approved.bundle;
}

async function seedApprovedPrompt(store: InMemoryPromptResearchStore, ownerContext: TenantContext) {
  const prompt = fakeArtifactPromptBundle({
    tenantId: ownerContext.tenantId,
    workspaceId: ownerContext.workspaceId,
    actorUserId: ownerContext.actorUserId,
  });
  await store.createProposal({
    context: ownerContext,
    promptSetId: prompt.promptSet.id,
    revisionId: prompt.revision.id,
    scenarioId: prompt.scenario.id,
    title: prompt.revision.title,
    subject: prompt.revision.subject,
    sourceContext: prompt.revision.sourceContext,
    prompts: prompt.revision.prompts,
    scopes: prompt.revision.scopes,
    scenario: promptScenarioInput(prompt),
    promptContentHash: prompt.revision.contentHash,
    scenarioContentHash: prompt.scenario.contentHash,
    createdAt: new Date(prompt.revision.createdAt),
    auditEventId: randomUUID(),
  });
  const approved = await store.approveRevision({
    context: ownerContext,
    promptSetId: prompt.promptSet.id,
    revisionId: prompt.revision.id,
    expectedPromptHash: prompt.revision.contentHash,
    expectedScenarioHash: prompt.scenario.contentHash,
    approvalId: prompt.approval!.id,
    approvedAt: new Date(prompt.approval!.approvedAt),
    auditEventId: randomUUID(),
  });
  expect(approved.outcome).toBe('SUCCEEDED');
  if (approved.outcome !== 'SUCCEEDED') throw new Error('EXPECTED_APPROVED_PROMPT');
  return approved.bundle;
}

function promptScenarioInput(prompt: ReturnType<typeof fakeArtifactPromptBundle>) {
  return {
    providerKey: prompt.scenario.providerKey,
    surfaceKey: prompt.scenario.surfaceKey,
    model: prompt.scenario.model,
    modelVersion: prompt.scenario.modelVersion,
    account: prompt.scenario.account,
    acquisitionMethod: prompt.scenario.acquisitionMethod,
    freshSession: prompt.scenario.freshSession,
    searchEnabled: prompt.scenario.searchEnabled,
    parameters: prompt.scenario.parameters,
    repetitions: prompt.scenario.repetitions,
  };
}
