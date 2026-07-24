import { createHash, randomUUID } from 'node:crypto';

import { createProductionPublicationAdapterRegistry } from '@aeostudio/adapters/publication';
import { canonicalArtifactJson } from '@aeostudio/application/artifacts';
import type { PublicationAdapter } from '@aeostudio/application/channels-publishing';
import type { JobLease } from '@aeostudio/application/jobs-budgets';
import {
  encodeGitPullRequestTarget,
  encodeWordPressDraftTarget,
} from '@aeostudio/contracts/channels';
import type {
  ChannelPackagePayload,
  ChannelPackageRecord,
} from '@aeostudio/domain/channels-publishing';
import { describe, expect, test, vi } from 'vitest';

import { PublicationExecutionHandler } from './publication-execution-handler.js';

describe('publication execution capability context', () => {
  test('binds package and secret reads to the same publication job lease', async () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Reviewed',
        'content.html': '<h1>Reviewed</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const channelPackage = makePackage(payload);
    const lease = makeLease(channelPackage);
    const readPublicationPackage = vi.fn().mockResolvedValue(payload);
    const readForPublication = vi.fn().mockResolvedValue({
      secretReference: 'arn:fixture:secret',
      credentialFingerprint: createHash('sha256').update('fixture-secret').digest('hex'),
    });
    const readPublicationSecret = vi.fn().mockResolvedValue('fixture-secret');
    const recordPublishApplied = vi.fn().mockResolvedValue(true);
    const store = {
      prepare: vi.fn().mockResolvedValue({
        outcome: 'PUBLISH',
        attemptId: randomUUID(),
        execution: {
          publicationId: lease.job.aggregateId,
          publicationStatus: 'RUNNING',
          idempotencyKey: 'capability-context',
          target: 'fixture://reviewed-target',
          remoteRef: null,
          channelPackage,
          adapterKey: 'fixture-adapter',
          adapterVersion: '1.0.0',
          adapterCapabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
          adapterRequiredScopes: ['fixture.publish'],
          adapterTermsVersion: 'fixture-terms-v1',
          adapterProcessingRegion: 'fixture-region',
          adapterRetentionPolicy: 'fixture-retention',
          adapterTrainingPolicy: 'fixture-training',
          adapterSubprocessors: [],
          adapterRatePolicy: { requestsPerMinute: 10 },
        },
      }),
      runGuardedEffect: guardedEffect(),
      recordPublishApplied,
      recordPublishAmbiguous: vi.fn(),
      recordReconcileApplied: vi.fn(),
      recordReconcileUnknown: vi.fn(),
      recordReconcileDefinitelyNotApplied: vi.fn(),
      recordRetryableFailure: vi.fn(),
      recordPreflightFailure: vi.fn(),
    };
    const adapter = {
      adapterKey: 'fixture-adapter',
      adapterVersion: '1.0.0',
      describe: () => ({
        adapterKey: 'fixture-adapter',
        adapterVersion: '1.0.0',
        capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
        requiredScopes: ['fixture.publish'],
        termsVersion: 'fixture-terms-v1',
        processingRegion: 'fixture-region',
        retentionPolicy: 'fixture-retention',
        trainingPolicy: 'fixture-training',
        subprocessors: [],
        ratePolicy: { requestsPerMinute: 10 },
      }),
      validateAuthorization: vi.fn().mockResolvedValue({ outcome: 'VALID' }),
      preview: vi.fn(),
      publish: vi.fn().mockResolvedValue({
        outcome: 'APPLIED',
        remoteRef: 'https://provider.example.test/publication/result',
      }),
      reconcile: vi.fn(),
    };
    const handler = new PublicationExecutionHandler(
      store,
      { readPublicationPackage },
      { resolve: vi.fn().mockReturnValue(adapter) },
      { readForPublication },
      { readPublicationSecret },
      { next: randomUUID },
      { now: () => new Date('2026-07-23T10:00:00.000Z') },
    );

    await expect(handler.run(lease)).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      publicationId: lease.job.aggregateId,
    });
    const access = {
      publicationId: lease.job.aggregateId,
      leaseToken: lease.leaseToken,
    };
    expect(readPublicationPackage).toHaveBeenCalledWith({
      access,
      expected: {
        objectRef: channelPackage.payloadObjectRef,
        tenantId: channelPackage.tenantId,
        workspaceId: channelPackage.workspaceId,
        packageChecksum: channelPackage.packageChecksum,
      },
    });
    expect(readForPublication).toHaveBeenCalledWith({ lease });
    expect(readPublicationSecret).toHaveBeenCalledWith({
      access,
      expected: {
        secretReference: 'arn:fixture:secret',
        tenantId: lease.job.tenantId,
        workspaceId: lease.job.workspaceId,
      },
    });
  });

  test('fails closed before the provider boundary when the live secret was rotated', async () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Reviewed',
        'content.html': '<h1>Reviewed</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const channelPackage = makePackage(payload);
    const lease = makeLease(channelPackage);
    const recordPreflightFailure = vi.fn().mockResolvedValue(true);
    const runGuardedEffect = vi.fn();
    const store = {
      prepare: vi.fn().mockResolvedValue({
        outcome: 'PUBLISH',
        attemptId: randomUUID(),
        execution: {
          publicationId: lease.job.aggregateId,
          publicationStatus: 'RUNNING',
          idempotencyKey: 'rotated-secret',
          target: 'fixture://reviewed-target',
          remoteRef: null,
          channelPackage,
          adapterKey: 'fixture-adapter',
          adapterVersion: '1.0.0',
          adapterCapabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
          adapterRequiredScopes: ['fixture.publish'],
          adapterTermsVersion: 'fixture-terms-v1',
          adapterProcessingRegion: 'fixture-region',
          adapterRetentionPolicy: 'fixture-retention',
          adapterTrainingPolicy: 'fixture-training',
          adapterSubprocessors: [],
          adapterRatePolicy: { requestsPerMinute: 10 },
        },
      }),
      runGuardedEffect,
      recordPublishApplied: vi.fn(),
      recordPublishAmbiguous: vi.fn(),
      recordReconcileApplied: vi.fn(),
      recordReconcileUnknown: vi.fn(),
      recordReconcileDefinitelyNotApplied: vi.fn(),
      recordRetryableFailure: vi.fn(),
      recordPreflightFailure,
    };
    const adapter = {
      adapterKey: 'fixture-adapter',
      adapterVersion: '1.0.0',
      describe: () => ({
        adapterKey: 'fixture-adapter',
        adapterVersion: '1.0.0',
        capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
        requiredScopes: ['fixture.publish'],
        termsVersion: 'fixture-terms-v1',
        processingRegion: 'fixture-region',
        retentionPolicy: 'fixture-retention',
        trainingPolicy: 'fixture-training',
        subprocessors: [],
        ratePolicy: { requestsPerMinute: 10 },
      }),
      validateAuthorization: vi.fn(),
      preview: vi.fn(),
      publish: vi.fn(),
      reconcile: vi.fn(),
    };
    const handler = new PublicationExecutionHandler(
      store,
      { readPublicationPackage: vi.fn().mockResolvedValue(payload) },
      { resolve: vi.fn().mockReturnValue(adapter) },
      {
        readForPublication: vi.fn().mockResolvedValue({
          secretReference: 'arn:fixture:secret',
          credentialFingerprint: sha256('previous-secret'),
        }),
      },
      { readPublicationSecret: vi.fn().mockResolvedValue('rotated-secret') },
      { next: randomUUID },
      { now: () => new Date('2026-07-23T10:00:00.000Z') },
    );

    await expect(handler.run(lease)).resolves.toEqual({
      outcome: 'TERMINAL_FAILURE',
      errorCode: 'PUBLICATION_AUTHORIZATION_STALE',
    });
    expect(recordPreflightFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'PUBLICATION_AUTHORIZATION_STALE',
        operation: 'PUBLISH',
      }),
    );
    expect(runGuardedEffect).not.toHaveBeenCalled();
    expect(adapter.validateAuthorization).not.toHaveBeenCalled();
    expect(adapter.publish).not.toHaveBeenCalled();
  });

  test('does not cross the GitHub effect boundary after provider permissions are revoked', async () => {
    let providerPermissionsRevoked = false;
    const providerRequest = vi.fn((input: { method: string; path: string }) => {
      if (input.method === 'GET' && input.path === '/installation') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: {
            id: 42,
            permissions: {
              contents: providerPermissionsRevoked ? 'read' : 'write',
              pull_requests: 'write',
              metadata: 'read',
            },
          },
        });
      }
      if (
        !providerPermissionsRevoked &&
        input.method === 'GET' &&
        input.path === '/installation/repositories?per_page=100&page=1'
      ) {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { total_count: 1, repositories: [{ full_name: 'example/docs' }] },
        });
      }
      if (
        !providerPermissionsRevoked &&
        input.method === 'GET' &&
        input.path === '/repos/example/docs'
      ) {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { full_name: 'example/docs' },
        });
      }
      if (
        !providerPermissionsRevoked &&
        input.method === 'GET' &&
        input.path === '/repos/example/docs/branches/main'
      ) {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { name: 'main', protected: true },
        });
      }
      throw new Error(`GITHUB_REMOTE_EFFECT_MUST_NOT_RUN:${input.method}:${input.path}`);
    });
    const adapter = createProductionPublicationAdapterRegistry({
      github: { request: providerRequest },
    }).resolve('git-pull-request', '1.0.0');
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');
    const secretValue = JSON.stringify({
      schemaVersion: 'aeostudio.github-installation-credential.v1',
      installationId: '42',
      permissions: {
        contents: 'write',
        pull_requests: 'write',
        metadata: 'read',
      },
      token: 'github-installation-token-value',
    });
    const target = encodeGitPullRequestTarget({
      schemaVersion: 'git-pr-target.v1',
      provider: 'GITHUB',
      installationId: '42',
      repository: 'example/docs',
      baseBranch: 'main',
      pathPrefix: 'content/approved',
    });
    const payload = providerPayload();
    const channelPackage = makePackage(payload, 'git-pull-request');

    await expect(
      adapter.validateChannelAuthorization?.({
        tenantId: channelPackage.tenantId,
        workspaceId: channelPackage.workspaceId,
        channelDefinitionId: channelPackage.channel.definitionId,
        target,
        requestedScopes: adapter.describe().requiredScopes,
        acceptedTermsVersion: adapter.describe().termsVersion,
        secretValue,
      }),
    ).resolves.toMatchObject({ outcome: 'VERIFIED' });
    providerPermissionsRevoked = true;
    providerRequest.mockClear();
    await expectProviderRevocationToFailClosed({
      adapter,
      target,
      secretValue,
      payload,
      channelPackage,
    });
    expect(providerRequest.mock.calls.map(([input]) => input.path)).toEqual(['/installation']);
    expect(providerRequest.mock.calls.some(([input]) => input.method !== 'GET')).toBe(false);
  });

  test('does not cross the WordPress effect boundary after provider capabilities are revoked', async () => {
    let providerCapabilitiesRevoked = false;
    const providerRequest = vi.fn((input: { method: string; url: string; body: unknown }) => {
      if (
        input.method === 'GET' &&
        input.url === 'https://cms.example.test/wp-json/wp/v2/users/me?context=edit'
      ) {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: {
            capabilities: {
              upload_files: true,
              edit_pages: !providerCapabilitiesRevoked,
              edit_posts: true,
              edit_products: false,
            },
          },
        });
      }
      throw new Error(`WORDPRESS_REMOTE_EFFECT_MUST_NOT_RUN:${input.method}:${input.url}`);
    });
    const adapter = createProductionPublicationAdapterRegistry({
      wordpress: { request: providerRequest },
    }).resolve('wordpress-woocommerce-draft', '1.0.0');
    if (adapter === null) throw new Error('WORDPRESS_ADAPTER_REQUIRED');
    const secretValue = JSON.stringify({
      schemaVersion: 'aeostudio.wordpress-credential.v1',
      siteUrl: 'https://cms.example.test',
      authMode: 'APPLICATION_PASSWORD',
      scopes: ['pages:write'],
      authorizationHeader: 'Basic dXNlcjphcHAtcGFzc3dvcmQ=',
    });
    const target = encodeWordPressDraftTarget({
      schemaVersion: 'wordpress-draft-target.v1',
      siteUrl: 'https://cms.example.test',
      authMode: 'APPLICATION_PASSWORD',
      destination: {
        kind: 'PAGE',
        operation: 'CREATE',
        slug: 'approved-guide',
      },
    });
    const payload = providerPayload();
    const channelPackage = makePackage(payload, 'wordpress-woocommerce-draft');

    await expect(
      adapter.validateChannelAuthorization?.({
        tenantId: channelPackage.tenantId,
        workspaceId: channelPackage.workspaceId,
        channelDefinitionId: channelPackage.channel.definitionId,
        target: adapter.authorizationTargetFor?.(target) ?? target,
        requestedScopes: ['pages:write'],
        acceptedTermsVersion: adapter.describe().termsVersion,
        secretValue,
      }),
    ).resolves.toMatchObject({ outcome: 'VERIFIED' });
    providerCapabilitiesRevoked = true;
    providerRequest.mockClear();
    await expectProviderRevocationToFailClosed({
      adapter,
      target,
      secretValue,
      payload,
      channelPackage,
    });
    expect(providerRequest).toHaveBeenCalledTimes(1);
    expect(providerRequest.mock.calls.some(([input]) => input.method !== 'GET')).toBe(false);
  });
});

async function expectProviderRevocationToFailClosed(input: {
  adapter: PublicationAdapter;
  target: string;
  secretValue: string;
  payload: ChannelPackagePayload;
  channelPackage: ChannelPackageRecord;
}): Promise<void> {
  const lease = makeLease(input.channelPackage);
  const descriptor = input.adapter.describe();
  const requiredScopes =
    input.adapter.requiredScopesFor?.({
      target: input.target,
      channelPackage: input.channelPackage,
    }) ?? descriptor.requiredScopes;
  const authorizationTarget = input.adapter.authorizationTargetFor?.(input.target) ?? input.target;
  const recordPreflightFailure = vi.fn().mockResolvedValue(true);
  const runGuardedEffect = vi.fn();
  const publish = vi.spyOn(input.adapter, 'publish');
  const store = {
    prepare: vi.fn().mockResolvedValue({
      outcome: 'PUBLISH',
      attemptId: randomUUID(),
      execution: {
        publicationId: lease.job.aggregateId,
        publicationStatus: 'RUNNING',
        idempotencyKey: lease.job.aggregateId,
        target: input.target,
        authorizationTarget,
        authorizationGrantedScopes: requiredScopes,
        remoteRef: null,
        channelPackage: input.channelPackage,
        adapterKey: descriptor.adapterKey,
        adapterVersion: descriptor.adapterVersion,
        ...(descriptor.providerApiVersion === undefined
          ? {}
          : { adapterProviderApiVersion: descriptor.providerApiVersion }),
        adapterCapabilities: descriptor.capabilities,
        adapterRequiredScopes: descriptor.requiredScopes,
        adapterTermsVersion: descriptor.termsVersion,
        adapterProcessingRegion: descriptor.processingRegion,
        adapterRetentionPolicy: descriptor.retentionPolicy,
        adapterTrainingPolicy: descriptor.trainingPolicy,
        adapterSubprocessors: descriptor.subprocessors,
        adapterRatePolicy: descriptor.ratePolicy,
      },
    }),
    runGuardedEffect,
    recordPublishApplied: vi.fn(),
    recordPublishAmbiguous: vi.fn(),
    recordReconcileApplied: vi.fn(),
    recordReconcileUnknown: vi.fn(),
    recordReconcileDefinitelyNotApplied: vi.fn(),
    recordRetryableFailure: vi.fn(),
    recordPreflightFailure,
  };
  const handler = new PublicationExecutionHandler(
    store,
    { readPublicationPackage: vi.fn().mockResolvedValue(input.payload) },
    { resolve: vi.fn().mockReturnValue(input.adapter) },
    {
      readForPublication: vi.fn().mockResolvedValue({
        secretReference: 'arn:fixture:provider-credential',
        credentialFingerprint: sha256(input.secretValue),
      }),
    },
    { readPublicationSecret: vi.fn().mockResolvedValue(input.secretValue) },
    { next: randomUUID },
    { now: () => new Date('2026-07-24T00:00:00.000Z') },
  );

  await expect(handler.run(lease)).resolves.toEqual({
    outcome: 'TERMINAL_FAILURE',
    errorCode: 'ADAPTER_AUTHORIZATION_SCOPE_INSUFFICIENT',
  });
  expect(recordPreflightFailure).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: 'PUBLISH',
      errorCode: 'ADAPTER_AUTHORIZATION_SCOPE_INSUFFICIENT',
    }),
  );
  expect(runGuardedEffect).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
}

function providerPayload(): ChannelPackagePayload {
  return {
    files: {
      'content.md': '# Approved guide\n\nApproved summary.',
      'content.html': '<article><h1>Approved guide</h1><p>Approved summary.</p></article>',
      'structured-data.json': JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: 'Approved guide',
        abstract: 'Approved summary.',
      }),
    },
  };
}

function makePackage(
  payload: ChannelPackagePayload,
  channelKey = 'fixture-channel',
): ChannelPackageRecord {
  const tenantId = '00000000-0000-7000-8000-000000008001';
  const workspaceId = '00000000-0000-7000-8000-000000008002';
  const packageSchemaVersion = '1.0.0';
  const channel = {
    definitionId: '00000000-0000-7000-8000-000000008003',
    channelKey,
  };
  const transformer = { key: 'generic-web-package', version: '1.0.0' };
  const artifact = {
    artifactId: '00000000-0000-7000-8000-000000008004',
    artifactRevisionId: '00000000-0000-7000-8000-000000008005',
    revision: 1,
    contentHash: 'a'.repeat(64),
    type: 'DEFINITION_PRODUCT' as const,
    locale: 'en-SG',
    market: 'SG',
    methodPolicyVersion: 'fixture-v1',
  };
  const manifest = {
    schemaVersion: packageSchemaVersion,
    files: Object.entries(payload.files).map(([path, content]) => ({
      path,
      mediaType:
        path === 'content.md'
          ? 'text/markdown'
          : path === 'content.html'
            ? 'text/html'
            : 'application/ld+json',
      sha256: sha256(content),
      byteLength: Buffer.byteLength(content, 'utf8'),
    })),
    assetRefs: [],
    claimSourceMap: [],
  };
  const packageChecksum = sha256(
    canonicalArtifactJson({
      packageSchemaVersion,
      channel,
      transformer,
      artifact,
      manifest,
      payload,
    }),
  );
  return {
    id: '00000000-0000-7000-8000-000000008006',
    tenantId,
    workspaceId,
    packageRevision: 1,
    channel,
    transformer,
    packageSchemaVersion,
    artifact,
    manifest,
    packageChecksum,
    payloadObjectRef: 's3://expected-only/package?versionId=v1',
    createdByUserId: '00000000-0000-7000-8000-000000008007',
    createdAt: '2026-07-23T10:00:00.000Z',
  };
}

function makeLease(channelPackage: ChannelPackageRecord): JobLease {
  return {
    job: {
      id: '00000000-0000-7000-8000-000000008008',
      tenantId: channelPackage.tenantId,
      workspaceId: channelPackage.workspaceId,
      jobType: 'PUBLICATION',
      aggregateId: '00000000-0000-7000-8000-000000008009',
      status: 'RUNNING',
      progress: 10,
      attempt: 1,
      maxAttempts: 3,
      budgetWarning: false,
      estimatedUnits: 5,
      providerKey: 'fixture-adapter',
      heartbeatAt: '2026-07-23T10:00:00.000Z',
      result: null,
      errorCode: null,
    },
    leaseToken: randomUUID(),
    messageId: 'capability-context-message',
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function guardedEffect() {
  return async <T>(_input: unknown, effect: () => Promise<T>) => ({
    outcome: 'EXECUTED' as const,
    value: await effect(),
  });
}
