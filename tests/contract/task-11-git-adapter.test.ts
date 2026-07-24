import * as AdapterRuntime from '@aeostudio/adapters';
import { describe, expect, test } from 'vitest';

type GitPullRequestStatus = 'PR_OPENED' | 'MERGED' | 'CLOSED' | 'FAILED';
type FakeGitFailureMode = 'CONFLICT_AFTER_EFFECT' | 'TIMEOUT_AFTER_EFFECT';

interface GitTarget {
  installationId: string;
  repository: string;
  baseBranch: string;
  pathPrefix: string;
}

interface GitPublishCommand {
  publicationId: string;
  idempotencyKey: string;
  packageChecksum: string;
  authorizationReference: string;
  target: GitTarget;
  files: Record<string, string>;
}

interface GitPullRequestReference {
  number: number;
  url: string;
  status: GitPullRequestStatus;
  isProductionLive: false;
  rollbackHandle: {
    operation: 'CLOSE_PULL_REQUEST';
    repository: string;
    pullRequestNumber: number;
  };
}

type GitAuthorizationResult =
  | { outcome: 'VALID' }
  | {
      outcome: 'INVALID';
      errorCode:
        | 'GIT_INSTALLATION_MISMATCH'
        | 'GIT_SCOPE_INSUFFICIENT'
        | 'GIT_REPOSITORY_NOT_ALLOWED'
        | 'GIT_BRANCH_NOT_ALLOWED'
        | 'GIT_PATH_NOT_ALLOWED';
    };

type GitPublishResult =
  | ({ outcome: 'APPLIED'; remoteRef: string } & GitPullRequestReference)
  | {
      outcome: 'DEFINITELY_NOT_APPLIED';
      errorCode: Exclude<GitAuthorizationResult, { outcome: 'VALID' }>['errorCode'];
    }
  | {
      outcome: 'AMBIGUOUS';
      errorCode: 'GIT_REMOTE_CONFLICT' | 'GIT_REMOTE_TIMEOUT' | 'GIT_RECONCILE_REQUIRED';
    };

interface FakeGitProviderSnapshot {
  apiVersion: string;
  branchCreateCount: number;
  commitCreateCount: number;
  pullRequestCreateCount: number;
  directProtectedBranchWriteCount: number;
  mergeCount: number;
  repositorySettingsWriteCount: number;
  pullRequests: Array<{
    repository: string;
    baseBranch: string;
    headBranch: string;
    number: number;
    url: string;
    status: GitPullRequestStatus;
    changedPaths: string[];
  }>;
}

interface VersionedFakeGitProvider {
  queuePullRequestFailure(mode: FakeGitFailureMode): void;
  setPullRequestStatus(
    repository: string,
    pullRequestNumber: number,
    status: GitPullRequestStatus,
  ): void;
  snapshot(): FakeGitProviderSnapshot;
}

type VersionedFakeGitProviderConstructor = new (options: {
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
}) => VersionedFakeGitProvider;

interface GitPullRequestAdapter {
  describe(): {
    adapterKey: string;
    adapterVersion: string;
    providerApiVersion: string;
    capabilities: string[];
  };
  validateAuthorization(command: GitPublishCommand): Promise<GitAuthorizationResult>;
  preview(command: GitPublishCommand): Promise<{
    repository: string;
    baseBranch: string;
    pathPrefix: string;
    packageChecksum: string;
    diff: Array<{ path: string; operation: 'CREATE' | 'UPDATE' }>;
  }>;
  publish(command: GitPublishCommand): Promise<GitPublishResult>;
  reconcile(command: GitPublishCommand): Promise<
    | ({ outcome: 'APPLIED'; remoteRef: string } & GitPullRequestReference)
    | {
        outcome: 'DEFINITELY_NOT_APPLIED';
        errorCode: string;
      }
  >;
  getPullRequestStatus(command: GitPublishCommand): Promise<GitPullRequestReference>;
  rollback(
    command: GitPublishCommand & { rollbackHandle: GitPullRequestReference['rollbackHandle'] },
  ): Promise<{
    outcome: 'ROLLED_BACK';
    remoteRef: string;
    status: 'CLOSED';
    rollbackHandle: GitPullRequestReference['rollbackHandle'];
  }>;
}

type GitPullRequestAdapterConstructor = new (options: {
  adapterKey: string;
  adapterVersion: string;
  providerApiVersion: string;
  provider: VersionedFakeGitProvider;
  requiredScopes: string[];
  allowedInstallationIds: string[];
  allowedRepositories: string[];
  allowedPathPrefixes: string[];
}) => GitPullRequestAdapter;

const providerApiVersion = '2026-07-21';
const adapterVersion = '1.0.0';
const installationId = 'installation-4101';
const repository = 'tenant-owned/site-content';
const protectedBranch = 'main';
const tokenSentinel = 'ghs_task11_token_must_never_escape';

const baseCommand: GitPublishCommand = {
  publicationId: '00000000-0000-7000-8000-000000001101',
  idempotencyKey: '00000000-0000-7000-8000-000000001101',
  packageChecksum: 'a'.repeat(64),
  authorizationReference: 'secret://git/installation-4101',
  target: {
    installationId,
    repository,
    baseBranch: protectedBranch,
    pathPrefix: 'content/approved',
  },
  files: {
    'content.md': '# Approved content',
    'structured-data.json': '{"@context":"https://schema.org"}',
  },
};

function expectPullRequestReference(
  result: GitPublishResult | Awaited<ReturnType<GitPullRequestAdapter['reconcile']>>,
): asserts result is Extract<GitPublishResult, { outcome: 'APPLIED' }> {
  expect(result.outcome).toBe('APPLIED');
  if (result.outcome !== 'APPLIED') throw new Error('expected applied Git pull request result');
  expect(result.remoteRef).toMatch(/^https:\/\/git\.example\.test\//);
  expect(result.number).toBeTypeOf('number');
  expect(result.url).toMatch(/^https:\/\/git\.example\.test\//);
  expect(result.status).toBe('PR_OPENED');
  expect(result.isProductionLive).toBe(false);
  expect(result.rollbackHandle).toEqual({
    operation: 'CLOSE_PULL_REQUEST',
    repository,
    pullRequestNumber: result.number,
  });
}

describe('Task 11 Git Pull Request Adapter public contract', () => {
  test('versioned fake provider fails closed, opens one idempotent PR, reconciles ambiguous writes, and never leaks its token', async () => {
    const providerConstructor = (
      AdapterRuntime as unknown as {
        VersionedFakeGitProvider?: VersionedFakeGitProviderConstructor;
      }
    ).VersionedFakeGitProvider;
    const adapterConstructor = (
      AdapterRuntime as unknown as {
        GitPullRequestPublicationAdapter?: GitPullRequestAdapterConstructor;
      }
    ).GitPullRequestPublicationAdapter;

    expect(adapterConstructor, 'expected pull request creation, adapter unavailable').toBeTypeOf(
      'function',
    );
    expect(providerConstructor, 'expected pull request creation, adapter unavailable').toBeTypeOf(
      'function',
    );
    if (adapterConstructor === undefined || providerConstructor === undefined) {
      throw new Error('expected pull request creation, adapter unavailable');
    }

    const logEntries: string[] = [];
    const createHarness = (
      scopes = ['contents:write', 'pull_requests:write'],
      options: {
        protectedBaseBranch?: string;
        allowedPathPrefixes?: string[];
        symlinkPaths?: Array<{ repository: string; path: string }>;
      } = {},
    ) => {
      const provider = new providerConstructor({
        apiVersion: providerApiVersion,
        installation: {
          installationId,
          repositories: [repository],
          scopes,
          token: tokenSentinel,
        },
        protectedBranches: [{ repository, branch: options.protectedBaseBranch ?? protectedBranch }],
        symlinkPaths: options.symlinkPaths ?? [{ repository, path: 'content/approved/linked' }],
        log: (entry) => logEntries.push(entry),
      });
      const adapter = new adapterConstructor({
        adapterKey: 'git-pull-request',
        adapterVersion,
        providerApiVersion,
        provider,
        requiredScopes: ['contents:write', 'pull_requests:write'],
        allowedInstallationIds: [installationId],
        allowedRepositories: [repository],
        allowedPathPrefixes: options.allowedPathPrefixes ?? ['content/approved'],
      });
      return { adapter, provider };
    };

    const { adapter, provider } = createHarness();
    expect(adapter.describe()).toEqual({
      adapterKey: 'git-pull-request',
      adapterVersion,
      providerApiVersion,
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'PULL_REQUEST_STATUS'],
    });
    expect(JSON.stringify(baseCommand)).not.toContain(tokenSentinel);
    await expect(adapter.validateAuthorization(baseCommand)).resolves.toEqual({ outcome: 'VALID' });

    const invalidTargets: Array<{
      command: GitPublishCommand;
      errorCode: Exclude<GitAuthorizationResult, { outcome: 'VALID' }>['errorCode'];
    }> = [
      {
        command: {
          ...baseCommand,
          target: { ...baseCommand.target, installationId: 'installation-not-authorized' },
        },
        errorCode: 'GIT_INSTALLATION_MISMATCH',
      },
      {
        command: {
          ...baseCommand,
          target: { ...baseCommand.target, repository: 'tenant-owned/other-repository' },
        },
        errorCode: 'GIT_REPOSITORY_NOT_ALLOWED',
      },
      ...['release', 'main~1', 'feature@{candidate}', 'refs/heads/main.lock'].map((baseBranch) => ({
        command: { ...baseCommand, target: { ...baseCommand.target, baseBranch } },
        errorCode: 'GIT_BRANCH_NOT_ALLOWED' as const,
      })),
      ...[
        '../outside',
        '/content/approved',
        'content/approved/%2e%2e/outside',
        'content/approved-link',
        'content/approved/linked',
      ].map((pathPrefix) => ({
        command: { ...baseCommand, target: { ...baseCommand.target, pathPrefix } },
        errorCode: 'GIT_PATH_NOT_ALLOWED' as const,
      })),
    ];
    for (const invalid of invalidTargets) {
      await expect(adapter.validateAuthorization(invalid.command)).resolves.toEqual({
        outcome: 'INVALID',
        errorCode: invalid.errorCode,
      });
      await expect(adapter.publish(invalid.command)).resolves.toEqual({
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: invalid.errorCode,
      });
    }
    const insufficientScope = createHarness(['contents:write']).adapter;
    await expect(insufficientScope.validateAuthorization(baseCommand)).resolves.toEqual({
      outcome: 'INVALID',
      errorCode: 'GIT_SCOPE_INSUFFICIENT',
    });
    await expect(insufficientScope.publish(baseCommand)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'GIT_SCOPE_INSUFFICIENT',
    });
    expect(provider.snapshot()).toMatchObject({
      branchCreateCount: 0,
      commitCreateCount: 0,
      pullRequestCreateCount: 0,
      directProtectedBranchWriteCount: 0,
    });

    const reservedFileCommands: GitPublishCommand[] = [
      { ...baseCommand, files: { '.git/config': 'must never be written' } },
      {
        ...baseCommand,
        target: { ...baseCommand.target, pathPrefix: '.github' },
        files: { 'workflows/pwn.yml': 'must never be written' },
      },
    ];
    const reservedHarnesses = [
      createHarness(),
      createHarness(undefined, { allowedPathPrefixes: ['.github'], symlinkPaths: [] }),
    ];
    for (const [index, invalid] of reservedFileCommands.entries()) {
      const harness = reservedHarnesses[index];
      if (harness === undefined) throw new Error('reserved path harness missing');
      await expect(harness.adapter.validateAuthorization(invalid)).resolves.toEqual({
        outcome: 'INVALID',
        errorCode: 'GIT_PATH_NOT_ALLOWED',
      });
      await expect(harness.adapter.publish(invalid)).resolves.toEqual({
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'GIT_PATH_NOT_ALLOWED',
      });
      expect(harness.provider.snapshot()).toMatchObject({
        branchCreateCount: 0,
        commitCreateCount: 0,
        pullRequestCreateCount: 0,
        directProtectedBranchWriteCount: 0,
      });
    }

    const collidingBranch = 'aeostudio/publication-p';
    const collisionHarness = createHarness(undefined, {
      protectedBaseBranch: collidingBranch,
    });
    const collisionCommand: GitPublishCommand = {
      ...baseCommand,
      publicationId: 'p',
      idempotencyKey: 'head-base-collision',
      target: { ...baseCommand.target, baseBranch: collidingBranch },
    };
    await expect(collisionHarness.adapter.publish(collisionCommand)).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'GIT_BRANCH_NOT_ALLOWED',
    });
    expect(collisionHarness.provider.snapshot()).toMatchObject({
      branchCreateCount: 0,
      commitCreateCount: 0,
      pullRequestCreateCount: 0,
      directProtectedBranchWriteCount: 0,
    });
    await expect(
      adapter.publish({
        ...baseCommand,
        publicationId: 'p~1',
        idempotencyKey: 'invalid-head-ref',
      }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'GIT_BRANCH_NOT_ALLOWED',
    });

    await expect(adapter.preview(baseCommand)).resolves.toEqual({
      repository,
      baseBranch: protectedBranch,
      pathPrefix: 'content/approved',
      packageChecksum: baseCommand.packageChecksum,
      diff: [
        { path: 'content/approved/content.md', operation: 'CREATE' },
        { path: 'content/approved/structured-data.json', operation: 'CREATE' },
      ],
    });
    expect(provider.snapshot().pullRequestCreateCount).toBe(0);

    const first = await adapter.publish(baseCommand);
    expectPullRequestReference(first);
    const duplicate = await adapter.publish(baseCommand);
    expectPullRequestReference(duplicate);
    expect(duplicate).toEqual(first);
    expect(provider.snapshot()).toMatchObject({
      apiVersion: providerApiVersion,
      branchCreateCount: 1,
      commitCreateCount: 1,
      pullRequestCreateCount: 1,
      directProtectedBranchWriteCount: 0,
      mergeCount: 0,
      repositorySettingsWriteCount: 0,
      pullRequests: [
        {
          repository,
          baseBranch: protectedBranch,
          number: first.number,
          url: first.url,
          status: 'PR_OPENED',
          changedPaths: ['content/approved/content.md', 'content/approved/structured-data.json'],
        },
      ],
    });
    expect(
      provider.snapshot().directProtectedBranchWriteCount,
      'expected zero direct protected-branch writes',
    ).toBe(0);
    expect(first.status).toBe('PR_OPENED');
    expect(first.status).not.toBe('MERGED');
    expect(first.status).not.toBe('CLOSED');
    expect(first.status).not.toBe('FAILED');
    expect(first.isProductionLive).toBe(false);

    const ambiguousCommands: Record<FakeGitFailureMode, GitPublishCommand> = {
      CONFLICT_AFTER_EFFECT: {
        ...baseCommand,
        publicationId: '00000000-0000-7000-8000-000000001102',
        idempotencyKey: '00000000-0000-7000-8000-000000001102',
      },
      TIMEOUT_AFTER_EFFECT: {
        ...baseCommand,
        publicationId: '00000000-0000-7000-8000-000000001103',
        idempotencyKey: '00000000-0000-7000-8000-000000001103',
      },
    };
    for (const failureMode of ['CONFLICT_AFTER_EFFECT', 'TIMEOUT_AFTER_EFFECT'] as const) {
      const ambiguousHarness = createHarness();
      const ambiguousCommand = ambiguousCommands[failureMode];
      ambiguousHarness.provider.queuePullRequestFailure(failureMode);
      const ambiguous = await ambiguousHarness.adapter.publish(ambiguousCommand);
      expect(ambiguous).toEqual({
        outcome: 'AMBIGUOUS',
        errorCode:
          failureMode === 'CONFLICT_AFTER_EFFECT' ? 'GIT_REMOTE_CONFLICT' : 'GIT_REMOTE_TIMEOUT',
      });
      await expect(ambiguousHarness.adapter.publish(ambiguousCommand)).resolves.toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'GIT_RECONCILE_REQUIRED',
      });
      const reconciled = await ambiguousHarness.adapter.reconcile(ambiguousCommand);
      expectPullRequestReference(reconciled);
      expect(
        ambiguousHarness.provider.snapshot().pullRequestCreateCount,
        'duplicate PR count mismatch',
      ).toBe(1);
      expect(ambiguousHarness.provider.snapshot().directProtectedBranchWriteCount).toBe(0);
    }

    provider.setPullRequestStatus(repository, first.number, 'MERGED');
    await expect(adapter.getPullRequestStatus(baseCommand)).resolves.toMatchObject({
      number: first.number,
      status: 'MERGED',
      isProductionLive: false,
    });
    provider.setPullRequestStatus(repository, first.number, 'FAILED');
    await expect(adapter.getPullRequestStatus(baseCommand)).resolves.toMatchObject({
      number: first.number,
      status: 'FAILED',
      isProductionLive: false,
    });
    provider.setPullRequestStatus(repository, first.number, 'PR_OPENED');
    const rolledBack = await adapter.rollback({
      ...baseCommand,
      rollbackHandle: first.rollbackHandle,
    });
    expect(rolledBack).toEqual({
      outcome: 'ROLLED_BACK',
      remoteRef: first.remoteRef,
      status: 'CLOSED',
      rollbackHandle: first.rollbackHandle,
    });
    await expect(adapter.getPullRequestStatus(baseCommand)).resolves.toMatchObject({
      number: first.number,
      status: 'CLOSED',
      isProductionLive: false,
    });

    const externallyVisibleState = JSON.stringify({
      command: baseCommand,
      result: first,
      rollback: rolledBack,
      snapshot: provider.snapshot(),
      logs: logEntries,
    });
    expect(externallyVisibleState).not.toContain(tokenSentinel);
  });
});
