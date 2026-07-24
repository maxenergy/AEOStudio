import { isCanonicalGitBranchName } from '@aeostudio/contracts/channels';

export type GitPullRequestStatus = 'PR_OPENED' | 'MERGED' | 'CLOSED' | 'FAILED';

export type FakeGitFailureMode = 'CONFLICT_AFTER_EFFECT' | 'TIMEOUT_AFTER_EFFECT';

export interface GitTarget {
  installationId: string;
  repository: string;
  baseBranch: string;
  pathPrefix: string;
}

export interface GitPublishCommand {
  publicationId: string;
  idempotencyKey: string;
  packageChecksum: string;
  authorizationReference: string;
  target: GitTarget;
  files: Record<string, string>;
}

export interface GitRollbackHandle {
  operation: 'CLOSE_PULL_REQUEST';
  repository: string;
  pullRequestNumber: number;
}

export interface GitPullRequestReference {
  number: number;
  url: string;
  status: GitPullRequestStatus;
  isProductionLive: false;
  rollbackHandle: GitRollbackHandle;
}

export type GitAuthorizationErrorCode =
  | 'GIT_INSTALLATION_MISMATCH'
  | 'GIT_SCOPE_INSUFFICIENT'
  | 'GIT_REPOSITORY_NOT_ALLOWED'
  | 'GIT_BRANCH_NOT_ALLOWED'
  | 'GIT_PATH_NOT_ALLOWED';

export type GitAuthorizationResult =
  { outcome: 'VALID' } | { outcome: 'INVALID'; errorCode: GitAuthorizationErrorCode };

export type GitPublishResult =
  | ({ outcome: 'APPLIED'; remoteRef: string } & GitPullRequestReference)
  | { outcome: 'DEFINITELY_NOT_APPLIED'; errorCode: GitAuthorizationErrorCode }
  | {
      outcome: 'AMBIGUOUS';
      errorCode: 'GIT_REMOTE_CONFLICT' | 'GIT_REMOTE_TIMEOUT' | 'GIT_RECONCILE_REQUIRED';
    };

export type GitReconcileResult =
  | ({ outcome: 'APPLIED'; remoteRef: string } & GitPullRequestReference)
  | { outcome: 'DEFINITELY_NOT_APPLIED'; errorCode: string };

export interface FakeGitProviderSnapshot {
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

export interface VersionedFakeGitProviderOptions {
  apiVersion: string;
  installation: {
    installationId: string;
    repositories: string[];
    scopes: string[];
    token: string;
  };
  protectedBranches: Array<{ repository: string; branch: string }>;
  symlinkPaths: Array<{ repository: string; path: string }>;
  log: (entry: string) => void;
}

interface StoredPullRequest {
  publicationId: string;
  idempotencyKey: string;
  commandFingerprint: string;
  repository: string;
  baseBranch: string;
  headBranch: string;
  number: number;
  url: string;
  status: GitPullRequestStatus;
  changedPaths: string[];
  reconciliationRequired: boolean;
}

interface CreatePullRequestRequest {
  publicationId: string;
  idempotencyKey: string;
  commandFingerprint: string;
  installationId: string;
  repository: string;
  baseBranch: string;
  changedPaths: string[];
}

interface CreatePullRequestResult {
  pullRequest: StoredPullRequest;
  failureMode?: FakeGitFailureMode;
}

function pullRequestKey(repository: string, pullRequestNumber: number): string {
  return `${repository}\u0000${String(pullRequestNumber)}`;
}

function isCanonicalRelativeGitPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.includes('%') ||
    path.includes('\u0000') ||
    /^[A-Za-z]:/.test(path)
  ) {
    return false;
  }

  const segments = path.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function pathIsWithin(path: string, allowedPrefix: string): boolean {
  return path === allowedPrefix || path.startsWith(`${allowedPrefix}/`);
}

function isReservedGitWritePath(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  return segments.includes('.git') || (segments[0] === '.github' && segments[1] === 'workflows');
}

function publicationHeadBranch(publicationId: string): string {
  return `aeostudio/publication-${publicationId}`;
}

function sortedFileEntries(files: Record<string, string>): Array<[string, string]> {
  return Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
}

function commandFingerprint(command: GitPublishCommand): string {
  return JSON.stringify({
    publicationId: command.publicationId,
    packageChecksum: command.packageChecksum,
    authorizationReference: command.authorizationReference,
    target: command.target,
    files: sortedFileEntries(command.files),
  });
}

function cloneStoredPullRequest(pullRequest: StoredPullRequest): StoredPullRequest {
  return {
    ...pullRequest,
    changedPaths: [...pullRequest.changedPaths],
  };
}

/**
 * Deterministic, in-memory fake of a versioned Git provider API.
 *
 * The installation credential is intentionally reduced to a boolean during construction. The
 * token value is never retained, logged, or included in snapshots, which makes accidental
 * disclosure through this test boundary impossible.
 */
export class VersionedFakeGitProvider {
  readonly apiVersion: string;

  private readonly installationId: string;
  private readonly repositories: ReadonlySet<string>;
  private readonly scopes: ReadonlySet<string>;
  private readonly hasCredential: boolean;
  private readonly protectedBranches: ReadonlySet<string>;
  private readonly symlinkPaths: ReadonlyMap<string, ReadonlySet<string>>;
  private readonly writeLog: (entry: string) => void;
  private readonly pullRequestsByIntent = new Map<string, StoredPullRequest>();
  private readonly pullRequestsByNumber = new Map<string, StoredPullRequest>();
  private readonly queuedFailures: FakeGitFailureMode[] = [];
  private nextPullRequestNumber = 1;
  private branchCreateCount = 0;
  private commitCreateCount = 0;
  private pullRequestCreateCount = 0;
  private directProtectedBranchWriteCount = 0;

  constructor(options: VersionedFakeGitProviderOptions) {
    this.apiVersion = options.apiVersion;
    this.installationId = options.installation.installationId;
    this.repositories = new Set(options.installation.repositories);
    this.scopes = new Set(options.installation.scopes);
    this.hasCredential = options.installation.token.length > 0;
    this.protectedBranches = new Set(
      options.protectedBranches.map(({ repository, branch }) => `${repository}\u0000${branch}`),
    );
    const symlinkPaths = new Map<string, Set<string>>();
    for (const entry of options.symlinkPaths) {
      if (!isCanonicalRelativeGitPath(entry.path)) {
        throw new Error('GIT_FAKE_PROVIDER_INVALID_SYMLINK_PATH');
      }
      const repositoryPaths = symlinkPaths.get(entry.repository) ?? new Set<string>();
      repositoryPaths.add(entry.path);
      symlinkPaths.set(entry.repository, repositoryPaths);
    }
    this.symlinkPaths = symlinkPaths;
    this.writeLog = options.log;
  }

  queuePullRequestFailure(mode: FakeGitFailureMode): void {
    this.queuedFailures.push(mode);
  }

  matchesInstallation(installationId: string): boolean {
    return this.hasCredential && installationId === this.installationId;
  }

  allowsRepository(repository: string): boolean {
    return this.repositories.has(repository);
  }

  hasScopes(requiredScopes: readonly string[]): boolean {
    return this.hasCredential && requiredScopes.every((scope) => this.scopes.has(scope));
  }

  pathTraversesSymlink(repository: string, path: string): boolean {
    const repositoryPaths = this.symlinkPaths.get(repository);
    if (repositoryPaths === undefined) return false;
    return [...repositoryPaths].some((symlinkPath) => pathIsWithin(path, symlinkPath));
  }

  isProtectedBranch(repository: string, branch: string): boolean {
    return this.protectedBranches.has(`${repository}\u0000${branch}`);
  }

  findPullRequest(idempotencyKey: string): StoredPullRequest | undefined {
    const pullRequest = this.pullRequestsByIntent.get(idempotencyKey);
    return pullRequest === undefined ? undefined : cloneStoredPullRequest(pullRequest);
  }

  createPullRequest(request: CreatePullRequestRequest): CreatePullRequestResult {
    if (!this.matchesInstallation(request.installationId)) {
      throw new Error('GIT_FAKE_PROVIDER_INSTALLATION_MISMATCH');
    }
    if (!this.allowsRepository(request.repository)) {
      throw new Error('GIT_FAKE_PROVIDER_REPOSITORY_NOT_ALLOWED');
    }
    if (this.pullRequestsByIntent.has(request.idempotencyKey)) {
      throw new Error('GIT_FAKE_PROVIDER_DUPLICATE_INTENT');
    }

    const headBranch = publicationHeadBranch(request.publicationId);
    if (
      !isCanonicalGitBranchName(request.baseBranch) ||
      !this.isProtectedBranch(request.repository, request.baseBranch) ||
      !isCanonicalGitBranchName(headBranch) ||
      headBranch === request.baseBranch ||
      this.isProtectedBranch(request.repository, headBranch)
    ) {
      throw new Error('GIT_FAKE_PROVIDER_BRANCH_POLICY_REJECTED');
    }
    if (
      request.changedPaths.length === 0 ||
      request.changedPaths.some(
        (path) =>
          !isCanonicalRelativeGitPath(path) ||
          isReservedGitWritePath(path) ||
          this.pathTraversesSymlink(request.repository, path),
      )
    ) {
      throw new Error('GIT_FAKE_PROVIDER_PATH_REJECTED');
    }

    const number = this.nextPullRequestNumber;
    this.nextPullRequestNumber += 1;
    const url = `https://git.example.test/${request.repository}/pull/${String(number)}`;
    const pullRequest: StoredPullRequest = {
      publicationId: request.publicationId,
      idempotencyKey: request.idempotencyKey,
      commandFingerprint: request.commandFingerprint,
      repository: request.repository,
      baseBranch: request.baseBranch,
      headBranch,
      number,
      url,
      status: 'PR_OPENED',
      changedPaths: [...request.changedPaths],
      reconciliationRequired: false,
    };

    // This fake deliberately has no protected-branch write primitive. The only effect path is a
    // topic branch, one commit, and one pull request.
    this.branchCreateCount += 1;
    if (this.isProtectedBranch(request.repository, headBranch)) {
      this.directProtectedBranchWriteCount += 1;
    }
    this.commitCreateCount += 1;
    this.pullRequestCreateCount += 1;
    this.pullRequestsByIntent.set(request.idempotencyKey, pullRequest);
    this.pullRequestsByNumber.set(pullRequestKey(request.repository, number), pullRequest);
    this.writeLog(`git.branch.created repository=${request.repository} branch=${headBranch}`);
    this.writeLog(`git.commit.created repository=${request.repository} branch=${headBranch}`);
    this.writeLog(
      `git.pull_request.created repository=${request.repository} number=${String(number)}`,
    );

    const failureMode = this.queuedFailures.shift();
    if (failureMode !== undefined) {
      pullRequest.reconciliationRequired = true;
      return { pullRequest: cloneStoredPullRequest(pullRequest), failureMode };
    }
    return { pullRequest: cloneStoredPullRequest(pullRequest) };
  }

  reconcilePullRequest(idempotencyKey: string): StoredPullRequest | undefined {
    const pullRequest = this.pullRequestsByIntent.get(idempotencyKey);
    if (pullRequest === undefined) return undefined;
    pullRequest.reconciliationRequired = false;
    this.writeLog(
      `git.pull_request.reconciled repository=${pullRequest.repository} number=${String(pullRequest.number)}`,
    );
    return cloneStoredPullRequest(pullRequest);
  }

  setPullRequestStatus(
    repository: string,
    pullRequestNumber: number,
    status: GitPullRequestStatus,
  ): void {
    const pullRequest = this.pullRequestsByNumber.get(
      pullRequestKey(repository, pullRequestNumber),
    );
    if (pullRequest === undefined) throw new Error('GIT_PULL_REQUEST_NOT_FOUND');
    pullRequest.status = status;
  }

  closePullRequest(repository: string, pullRequestNumber: number): StoredPullRequest {
    const pullRequest = this.pullRequestsByNumber.get(
      pullRequestKey(repository, pullRequestNumber),
    );
    if (pullRequest === undefined) throw new Error('GIT_PULL_REQUEST_NOT_FOUND');
    if (pullRequest.status === 'MERGED') throw new Error('GIT_PULL_REQUEST_ALREADY_MERGED');
    pullRequest.status = 'CLOSED';
    this.writeLog(
      `git.pull_request.closed repository=${repository} number=${String(pullRequestNumber)}`,
    );
    return cloneStoredPullRequest(pullRequest);
  }

  snapshot(): FakeGitProviderSnapshot {
    return {
      apiVersion: this.apiVersion,
      branchCreateCount: this.branchCreateCount,
      commitCreateCount: this.commitCreateCount,
      pullRequestCreateCount: this.pullRequestCreateCount,
      directProtectedBranchWriteCount: this.directProtectedBranchWriteCount,
      mergeCount: 0,
      repositorySettingsWriteCount: 0,
      pullRequests: [...this.pullRequestsByNumber.values()].map((pullRequest) => ({
        repository: pullRequest.repository,
        baseBranch: pullRequest.baseBranch,
        headBranch: pullRequest.headBranch,
        number: pullRequest.number,
        url: pullRequest.url,
        status: pullRequest.status,
        changedPaths: [...pullRequest.changedPaths],
      })),
    };
  }
}

export interface GitPullRequestPublicationAdapterOptions {
  adapterKey: string;
  adapterVersion: string;
  providerApiVersion: string;
  provider: VersionedFakeGitProvider;
  requiredScopes: string[];
  allowedInstallationIds: string[];
  allowedRepositories: string[];
  allowedPathPrefixes: string[];
}

function appliedResult(pullRequest: StoredPullRequest): GitPublishResult {
  return {
    outcome: 'APPLIED',
    remoteRef: pullRequest.url,
    number: pullRequest.number,
    url: pullRequest.url,
    status: pullRequest.status,
    isProductionLive: false,
    rollbackHandle: {
      operation: 'CLOSE_PULL_REQUEST',
      repository: pullRequest.repository,
      pullRequestNumber: pullRequest.number,
    },
  };
}

function reconcileAppliedResult(pullRequest: StoredPullRequest): GitReconcileResult {
  const result = appliedResult(pullRequest);
  if (result.outcome !== 'APPLIED') throw new Error('GIT_APPLIED_RESULT_INVARIANT');
  return result;
}

/** Git publication Adapter that can only create a branch, commit, and pull request. */
export class GitPullRequestPublicationAdapter {
  private readonly adapterKey: string;
  private readonly adapterVersion: string;
  private readonly providerApiVersion: string;
  private readonly provider: VersionedFakeGitProvider;
  private readonly requiredScopes: readonly string[];
  private readonly allowedInstallationIds: ReadonlySet<string>;
  private readonly allowedRepositories: ReadonlySet<string>;
  private readonly allowedPathPrefixes: readonly string[];

  constructor(options: GitPullRequestPublicationAdapterOptions) {
    if (options.provider.apiVersion !== options.providerApiVersion) {
      throw new Error('GIT_PROVIDER_API_VERSION_MISMATCH');
    }
    if (!options.allowedPathPrefixes.every(isCanonicalRelativeGitPath)) {
      throw new Error('GIT_ADAPTER_INVALID_ALLOWED_PATH_PREFIX');
    }
    this.adapterKey = options.adapterKey;
    this.adapterVersion = options.adapterVersion;
    this.providerApiVersion = options.providerApiVersion;
    this.provider = options.provider;
    this.requiredScopes = [...options.requiredScopes];
    this.allowedInstallationIds = new Set(options.allowedInstallationIds);
    this.allowedRepositories = new Set(options.allowedRepositories);
    this.allowedPathPrefixes = [...options.allowedPathPrefixes];
  }

  describe(): {
    adapterKey: string;
    adapterVersion: string;
    providerApiVersion: string;
    capabilities: string[];
  } {
    return {
      adapterKey: this.adapterKey,
      adapterVersion: this.adapterVersion,
      providerApiVersion: this.providerApiVersion,
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'PULL_REQUEST_STATUS'],
    };
  }

  validateAuthorization(command: GitPublishCommand): Promise<GitAuthorizationResult> {
    if (
      !this.allowedInstallationIds.has(command.target.installationId) ||
      !this.provider.matchesInstallation(command.target.installationId)
    ) {
      return Promise.resolve({
        outcome: 'INVALID',
        errorCode: 'GIT_INSTALLATION_MISMATCH',
      });
    }
    if (
      !this.allowedRepositories.has(command.target.repository) ||
      !this.provider.allowsRepository(command.target.repository)
    ) {
      return Promise.resolve({
        outcome: 'INVALID',
        errorCode: 'GIT_REPOSITORY_NOT_ALLOWED',
      });
    }
    if (!this.provider.hasScopes(this.requiredScopes)) {
      return Promise.resolve({ outcome: 'INVALID', errorCode: 'GIT_SCOPE_INSUFFICIENT' });
    }
    if (
      !isCanonicalGitBranchName(command.target.baseBranch) ||
      !this.provider.isProtectedBranch(command.target.repository, command.target.baseBranch) ||
      !isCanonicalGitBranchName(publicationHeadBranch(command.publicationId)) ||
      publicationHeadBranch(command.publicationId) === command.target.baseBranch ||
      this.provider.isProtectedBranch(
        command.target.repository,
        publicationHeadBranch(command.publicationId),
      )
    ) {
      return Promise.resolve({ outcome: 'INVALID', errorCode: 'GIT_BRANCH_NOT_ALLOWED' });
    }
    if (!this.commandPathsAreAllowed(command)) {
      return Promise.resolve({ outcome: 'INVALID', errorCode: 'GIT_PATH_NOT_ALLOWED' });
    }
    return Promise.resolve({ outcome: 'VALID' });
  }

  async preview(command: GitPublishCommand): Promise<{
    repository: string;
    baseBranch: string;
    pathPrefix: string;
    packageChecksum: string;
    diff: Array<{ path: string; operation: 'CREATE' | 'UPDATE' }>;
  }> {
    const authorization = await this.validateAuthorization(command);
    if (authorization.outcome === 'INVALID') throw new Error(authorization.errorCode);
    return {
      repository: command.target.repository,
      baseBranch: command.target.baseBranch,
      pathPrefix: command.target.pathPrefix,
      packageChecksum: command.packageChecksum,
      diff: sortedFileEntries(command.files).map(([filePath]) => ({
        path: `${command.target.pathPrefix}/${filePath}`,
        operation: 'CREATE',
      })),
    };
  }

  async publish(command: GitPublishCommand): Promise<GitPublishResult> {
    const authorization = await this.validateAuthorization(command);
    if (authorization.outcome === 'INVALID') {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: authorization.errorCode };
    }

    const fingerprint = commandFingerprint(command);
    const existing = this.provider.findPullRequest(command.idempotencyKey);
    if (existing !== undefined) {
      if (
        existing.publicationId !== command.publicationId ||
        existing.commandFingerprint !== fingerprint ||
        existing.reconciliationRequired
      ) {
        return { outcome: 'AMBIGUOUS', errorCode: 'GIT_RECONCILE_REQUIRED' };
      }
      return appliedResult(existing);
    }

    const changedPaths = sortedFileEntries(command.files).map(
      ([filePath]) => `${command.target.pathPrefix}/${filePath}`,
    );
    const created = this.provider.createPullRequest({
      publicationId: command.publicationId,
      idempotencyKey: command.idempotencyKey,
      commandFingerprint: fingerprint,
      installationId: command.target.installationId,
      repository: command.target.repository,
      baseBranch: command.target.baseBranch,
      changedPaths,
    });
    if (created.failureMode === 'CONFLICT_AFTER_EFFECT') {
      return { outcome: 'AMBIGUOUS', errorCode: 'GIT_REMOTE_CONFLICT' };
    }
    if (created.failureMode === 'TIMEOUT_AFTER_EFFECT') {
      return { outcome: 'AMBIGUOUS', errorCode: 'GIT_REMOTE_TIMEOUT' };
    }
    return appliedResult(created.pullRequest);
  }

  async reconcile(command: GitPublishCommand): Promise<GitReconcileResult> {
    const authorization = await this.validateAuthorization(command);
    if (authorization.outcome === 'INVALID') {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: authorization.errorCode };
    }
    const existing = this.provider.findPullRequest(command.idempotencyKey);
    if (
      existing === undefined ||
      existing.publicationId !== command.publicationId ||
      existing.commandFingerprint !== commandFingerprint(command)
    ) {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'GIT_REMOTE_EFFECT_NOT_FOUND' };
    }
    const reconciled = this.provider.reconcilePullRequest(command.idempotencyKey);
    if (reconciled === undefined) {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'GIT_REMOTE_EFFECT_NOT_FOUND' };
    }
    return reconcileAppliedResult(reconciled);
  }

  async getPullRequestStatus(command: GitPublishCommand): Promise<GitPullRequestReference> {
    const authorization = await this.validateAuthorization(command);
    if (authorization.outcome === 'INVALID') throw new Error(authorization.errorCode);
    const pullRequest = this.provider.findPullRequest(command.idempotencyKey);
    if (
      pullRequest === undefined ||
      pullRequest.publicationId !== command.publicationId ||
      pullRequest.commandFingerprint !== commandFingerprint(command)
    ) {
      throw new Error('GIT_PULL_REQUEST_NOT_FOUND');
    }
    return {
      number: pullRequest.number,
      url: pullRequest.url,
      status: pullRequest.status,
      isProductionLive: false,
      rollbackHandle: {
        operation: 'CLOSE_PULL_REQUEST',
        repository: pullRequest.repository,
        pullRequestNumber: pullRequest.number,
      },
    };
  }

  async rollback(command: GitPublishCommand & { rollbackHandle: GitRollbackHandle }): Promise<{
    outcome: 'ROLLED_BACK';
    remoteRef: string;
    status: 'CLOSED';
    rollbackHandle: GitRollbackHandle;
  }> {
    const authorization = await this.validateAuthorization(command);
    if (authorization.outcome === 'INVALID') throw new Error(authorization.errorCode);
    const existing = this.provider.findPullRequest(command.idempotencyKey);
    if (
      existing === undefined ||
      existing.publicationId !== command.publicationId ||
      existing.commandFingerprint !== commandFingerprint(command) ||
      command.rollbackHandle.operation !== 'CLOSE_PULL_REQUEST' ||
      command.rollbackHandle.repository !== existing.repository ||
      command.rollbackHandle.pullRequestNumber !== existing.number
    ) {
      throw new Error('GIT_ROLLBACK_HANDLE_MISMATCH');
    }
    const closed = this.provider.closePullRequest(existing.repository, existing.number);
    return {
      outcome: 'ROLLED_BACK',
      remoteRef: closed.url,
      status: 'CLOSED',
      rollbackHandle: { ...command.rollbackHandle },
    };
  }

  private commandPathsAreAllowed(command: GitPublishCommand): boolean {
    const pathPrefix = command.target.pathPrefix;
    if (!isCanonicalRelativeGitPath(pathPrefix) || isReservedGitWritePath(pathPrefix)) return false;
    if (!this.allowedPathPrefixes.some((allowed) => pathIsWithin(pathPrefix, allowed))) {
      return false;
    }
    if (this.provider.pathTraversesSymlink(command.target.repository, pathPrefix)) return false;

    const filePaths = Object.keys(command.files);
    if (filePaths.length === 0) return false;
    return filePaths.every((filePath) => {
      if (!isCanonicalRelativeGitPath(filePath)) return false;
      const resolvedPath = `${pathPrefix}/${filePath}`;
      return (
        !isReservedGitWritePath(resolvedPath) &&
        !this.provider.pathTraversesSymlink(command.target.repository, resolvedPath)
      );
    });
  }
}
