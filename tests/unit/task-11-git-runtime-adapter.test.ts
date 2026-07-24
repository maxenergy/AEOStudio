import * as PublicationAdapters from '@aeostudio/adapters/publication';
import type {
  PublicationAdapter,
  PublicationAdapterCommand,
  PublicationAdapterDescriptor,
} from '@aeostudio/application/channels-publishing';
import type { ChannelPackageRecord } from '@aeostudio/domain/channels-publishing';
import { describe, expect, test } from 'vitest';

interface GitTargetV1 {
  schemaVersion: 'git-pr-target.v1';
  provider: 'GITHUB';
  installationId: string;
  repository: string;
  baseBranch: string;
  pathPrefix: string;
}

type GitProviderConstructor = new (options: {
  apiVersion: string;
  installation: {
    installationId: string;
    repositories: string[];
    scopes: string[];
    token: string;
  };
  protectedBranches: Array<{ repository: string; branch: string }>;
  symlinkPaths: Array<{ repository: string; path: string }>;
  log(entry: string): void;
}) => {
  snapshot(): { pullRequestCreateCount: number; directProtectedBranchWriteCount: number };
  setPullRequestStatus(
    repository: string,
    pullRequestNumber: number,
    status: 'PR_OPENED' | 'MERGED' | 'CLOSED' | 'FAILED',
  ): void;
};

type GitAdapterConstructor = new (options: {
  adapterKey: string;
  adapterVersion: string;
  providerApiVersion: string;
  provider: InstanceType<GitProviderConstructor>;
  requiredScopes: string[];
  allowedInstallationIds: string[];
  allowedRepositories: string[];
  allowedPathPrefixes: string[];
}) => unknown;

type RuntimeAdapterConstructor = new (options: {
  adapterKey: string;
  adapterVersion: string;
  descriptor: Omit<PublicationAdapterDescriptor, 'adapterKey' | 'adapterVersion'>;
  gitAdapter: unknown;
}) => PublicationAdapter & {
  refreshRemoteStatus(command: PublicationAdapterCommand): Promise<{
    outcome: 'APPLIED';
    remoteRef: string;
    remoteState: {
      status: string;
      number: number | null;
      isProductionLive: boolean;
      rollbackHandle: Record<string, string | number | boolean> | null;
    };
  }>;
};

const channelPackage: ChannelPackageRecord = {
  id: '00000000-0000-7000-8000-000000001101',
  tenantId: '00000000-0000-7000-8000-000000001102',
  workspaceId: '00000000-0000-7000-8000-000000001103',
  packageRevision: 1,
  channel: {
    definitionId: '00000000-0000-7000-8000-000000001104',
    channelKey: 'git-pull-request',
  },
  transformer: { key: 'generic-web-package', version: '1.0.0' },
  packageSchemaVersion: '1.0.0',
  artifact: {
    artifactId: '00000000-0000-7000-8000-000000001105',
    artifactRevisionId: '00000000-0000-7000-8000-000000001106',
    revision: 1,
    contentHash: 'a'.repeat(64),
    type: 'DEFINITION_PRODUCT',
    locale: 'en-SG',
    market: 'SG',
    methodPolicyVersion: 'fixture-v1',
  },
  manifest: {
    schemaVersion: '1.0.0',
    files: [
      {
        path: 'content.md',
        mediaType: 'text/markdown',
        sha256: 'b'.repeat(64),
        byteLength: 7,
      },
    ],
    assetRefs: [],
    claimSourceMap: [],
  },
  packageChecksum: 'c'.repeat(64),
  payloadObjectRef: 'memory://task-11-package',
  createdByUserId: '00000000-0000-7000-8000-000000001107',
  createdAt: '2026-07-21T00:00:00.000Z',
};

describe('Task 11 Git Adapter bridge to the generic publication coordinator', () => {
  test('canonicalizes a scoped target and reuses one PR across safe platform retries without exposing the credential', async () => {
    const exports = PublicationAdapters as unknown as {
      VersionedFakeGitProvider?: GitProviderConstructor;
      GitPullRequestPublicationAdapter?: GitAdapterConstructor;
      GitPullRequestRuntimeAdapter?: RuntimeAdapterConstructor;
      encodeGitPullRequestTarget?: (target: GitTargetV1) => string;
      decodeGitPullRequestTarget?: (value: string) => GitTargetV1;
    };
    expect(
      exports.GitPullRequestRuntimeAdapter,
      'expected generic Git publication bridge, adapter unavailable',
    ).toBeTypeOf('function');
    expect(exports.encodeGitPullRequestTarget).toBeTypeOf('function');
    expect(exports.decodeGitPullRequestTarget).toBeTypeOf('function');
    expect(exports.VersionedFakeGitProvider).toBeTypeOf('function');
    expect(exports.GitPullRequestPublicationAdapter).toBeTypeOf('function');
    if (
      exports.GitPullRequestRuntimeAdapter === undefined ||
      exports.encodeGitPullRequestTarget === undefined ||
      exports.decodeGitPullRequestTarget === undefined ||
      exports.VersionedFakeGitProvider === undefined ||
      exports.GitPullRequestPublicationAdapter === undefined
    ) {
      throw new Error('GIT_RUNTIME_ADAPTER_UNAVAILABLE');
    }

    const target: GitTargetV1 = {
      schemaVersion: 'git-pr-target.v1',
      provider: 'GITHUB',
      installationId: 'installation-tenant-a',
      repository: 'tenant-owned/site-content',
      baseBranch: 'main',
      pathPrefix: 'content/approved',
    };
    const encodedTarget = exports.encodeGitPullRequestTarget(target);
    expect(encodedTarget).toMatch(/^git-pr:v1:[A-Za-z0-9_-]+$/);
    expect(exports.decodeGitPullRequestTarget(encodedTarget)).toEqual(target);
    expect(() =>
      exports.decodeGitPullRequestTarget?.(
        exports.encodeGitPullRequestTarget?.({ ...target, pathPrefix: '../outside' }) ?? '',
      ),
    ).toThrow('GIT_TARGET_INVALID');
    for (const baseBranch of ['main~1', 'feature@{candidate}', 'refs/heads/main.lock']) {
      expect(() => exports.encodeGitPullRequestTarget?.({ ...target, baseBranch })).toThrow(
        'GIT_TARGET_INVALID',
      );
    }

    const secretSentinel = 'task-11-provider-secret-must-not-escape';
    const provider = new exports.VersionedFakeGitProvider({
      apiVersion: '2026-03-10',
      installation: {
        installationId: target.installationId,
        repositories: [target.repository],
        scopes: ['contents:write', 'pull_requests:write', 'metadata:read'],
        token: secretSentinel,
      },
      protectedBranches: [{ repository: target.repository, branch: target.baseBranch }],
      symlinkPaths: [],
      log: () => undefined,
    });
    const gitAdapter = new exports.GitPullRequestPublicationAdapter({
      adapterKey: 'git-pull-request',
      adapterVersion: '1.0.0',
      providerApiVersion: '2026-03-10',
      provider,
      requiredScopes: ['contents:write', 'pull_requests:write', 'metadata:read'],
      allowedInstallationIds: [target.installationId],
      allowedRepositories: [target.repository],
      allowedPathPrefixes: [target.pathPrefix],
    });
    const adapter = new exports.GitPullRequestRuntimeAdapter({
      adapterKey: 'git-pull-request',
      adapterVersion: '1.0.0',
      descriptor: {
        capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'PULL_REQUEST_STATUS'],
        requiredScopes: ['contents:write', 'pull_requests:write', 'metadata:read'],
        termsVersion: 'git-test-terms-v1',
        processingRegion: 'in-process-test-runtime',
        retentionPolicy: 'No credential or package retention outside process memory.',
        trainingPolicy: 'No training.',
        subprocessors: [],
        ratePolicy: { mode: 'deterministic-test-only' },
      },
      gitAdapter,
    });

    const command = (publicationId: string, idempotencyKey: string): PublicationAdapterCommand => ({
      publicationId,
      idempotencyKey,
      target: encodedTarget,
      channelPackage,
      payload: {
        files: {
          'content.md': '# Hello',
          'content.html': '<h1>Hello</h1>',
          'structured-data.json': '{"@context":"https://schema.org"}',
        },
      },
      secretValue: secretSentinel,
    });
    const unprotectedTarget = exports.encodeGitPullRequestTarget({
      ...target,
      baseBranch: 'release',
    });
    await expect(
      adapter.validateAuthorization({
        ...command(
          '00000000-0000-7000-8000-000000001108',
          'reviewed-publication-v1:branch-policy-conflict',
        ),
        target: unprotectedTarget,
      }),
    ).resolves.toEqual({ outcome: 'INVALID', reason: 'BRANCH_POLICY_CONFLICT' });
    const first = await adapter.publish(
      command(
        '00000000-0000-7000-8000-000000001108',
        'reviewed-publication-v1:first-platform-intent',
      ),
    );
    const retried = await adapter.publish(
      command(
        '00000000-0000-7000-8000-000000001109',
        'reviewed-publication-retry-v1:second-platform-intent',
      ),
    );

    expect(first).toMatchObject({
      outcome: 'APPLIED',
      remoteState: { status: 'PR_OPENED', isProductionLive: false },
    });
    expect(retried).toEqual(first);
    provider.setPullRequestStatus(target.repository, 1, 'MERGED');
    await expect(
      adapter.refreshRemoteStatus(
        command(
          '00000000-0000-7000-8000-000000001109',
          'reviewed-publication-retry-v1:second-platform-intent',
        ),
      ),
    ).resolves.toMatchObject({
      outcome: 'APPLIED',
      remoteRef: 'https://git.example.test/tenant-owned/site-content/pull/1',
      remoteState: {
        status: 'MERGED',
        number: 1,
        isProductionLive: false,
        rollbackHandle: null,
      },
    });
    expect(provider.snapshot()).toMatchObject({
      pullRequestCreateCount: 1,
      directProtectedBranchWriteCount: 0,
    });
    expect(JSON.stringify({ first, retried, snapshot: provider.snapshot() })).not.toContain(
      secretSentinel,
    );
  });
});
