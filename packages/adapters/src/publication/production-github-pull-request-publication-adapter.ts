import { createHash } from 'node:crypto';

import type {
  ChannelAuthorizationValidationInput,
  ChannelAuthorizationValidationResult,
  PublicationAdapter,
  PublicationAdapterAuthorizationResult,
  PublicationAdapterCommand,
  PublicationAdapterDescriptor,
  PublicationAdapterPreviewCommand,
  PublicationAdapterPreviewResult,
  PublicationAdapterPublishResult,
  PublicationAdapterReconcileResult,
  PublicationAdapterRemoteStatusResult,
  PublicationAdapterRollbackCommand,
  PublicationAdapterRollbackResult,
} from '@aeostudio/application/channels-publishing';
import { decodeGitPullRequestTarget } from '@aeostudio/contracts/channels';

const GITHUB_TRANSPORT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const GITHUB_BLOB_REQUEST_JSON_OVERHEAD = Buffer.byteLength(
  JSON.stringify({ content: '', encoding: 'base64' }),
  'utf8',
);

export interface GitHubRestResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface GitHubRestRequest {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface GitHubRestTransport {
  request(input: GitHubRestRequest): Promise<GitHubRestResponse>;
}

export interface ProductionGitHubPullRequestPublicationAdapterOptions {
  descriptor: PublicationAdapterDescriptor;
  transport: GitHubRestTransport;
}

interface GitHubInstallationCredential {
  installationId: string;
  permissions: {
    contents: 'read' | 'write';
    pull_requests: 'read' | 'write';
    metadata: 'read' | 'write';
  };
  token: string;
}

export class ProductionGitHubPullRequestPublicationAdapter implements PublicationAdapter {
  readonly adapterKey: string;
  readonly adapterVersion: string;

  private readonly descriptor: PublicationAdapterDescriptor;

  constructor(private readonly options: ProductionGitHubPullRequestPublicationAdapterOptions) {
    this.descriptor = structuredClone(options.descriptor);
    this.adapterKey = this.descriptor.adapterKey;
    this.adapterVersion = this.descriptor.adapterVersion;
  }

  describe(): PublicationAdapterDescriptor {
    return structuredClone(this.descriptor);
  }

  authorizationTargetFor(publicationTarget: string): string {
    decodeGitPullRequestTarget(publicationTarget);
    return publicationTarget;
  }

  requiredScopesFor(input: { target: string }): string[] {
    decodeGitPullRequestTarget(input.target);
    return [...this.descriptor.requiredScopes];
  }

  async validateChannelAuthorization(
    input: ChannelAuthorizationValidationInput,
  ): Promise<ChannelAuthorizationValidationResult> {
    let target: ReturnType<typeof decodeGitPullRequestTarget>;
    let credential: GitHubInstallationCredential;
    try {
      target = decodeGitPullRequestTarget(input.target);
      credential = parseGitHubInstallationCredential(input.secretValue);
    } catch {
      return { outcome: 'INVALID', reason: 'CREDENTIAL_INVALID' };
    }
    if (input.acceptedTermsVersion !== this.descriptor.termsVersion) {
      return { outcome: 'INVALID', reason: 'TERMS_MISMATCH' };
    }
    if (credential.installationId !== target.installationId) {
      return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
    }
    const headers = githubHeaders(credential.token);
    try {
      const installation = await this.options.transport.request({
        method: 'GET',
        path: '/installation',
        headers,
        timeoutMs: 10_000,
        maxResponseBytes: 256 * 1024,
      });
      const providerInstallationId =
        isRecord(installation.body) &&
        (typeof installation.body.id === 'string' || typeof installation.body.id === 'number')
          ? String(installation.body.id)
          : null;
      if (
        installation.status !== 200 ||
        providerInstallationId !== credential.installationId ||
        !installationHasRequiredPermissions(installation.body)
      ) {
        return { outcome: 'INVALID', reason: 'SCOPE_INSUFFICIENT' };
      }
      if (
        !(await installationTokenCoversRepository(
          this.options.transport,
          headers,
          target.repository,
        ))
      ) {
        return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
      }
      const repositoryPath = `/repos/${githubRepositoryPath(target.repository)}`;
      const repository = await this.options.transport.request({
        method: 'GET',
        path: repositoryPath,
        headers,
        timeoutMs: 10_000,
        maxResponseBytes: 256 * 1024,
      });
      if (
        repository.status !== 200 ||
        !isRecord(repository.body) ||
        typeof repository.body.full_name !== 'string' ||
        repository.body.full_name.toLowerCase() !== target.repository.toLowerCase()
      ) {
        return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
      }
      const branch = await this.options.transport.request({
        method: 'GET',
        path: `${repositoryPath}/branches/${encodeURIComponent(target.baseBranch)}`,
        headers,
        timeoutMs: 10_000,
        maxResponseBytes: 256 * 1024,
      });
      if (
        branch.status !== 200 ||
        !isRecord(branch.body) ||
        branch.body.name !== target.baseBranch ||
        branch.body.protected !== true
      ) {
        return { outcome: 'INVALID', reason: 'BRANCH_POLICY_CONFLICT' };
      }
      const actualScopes = ['contents:write', 'pull_requests:write', 'metadata:read'];
      if (input.requestedScopes.some((scope) => !actualScopes.includes(scope))) {
        return { outcome: 'INVALID', reason: 'SCOPE_INSUFFICIENT' };
      }
      return { outcome: 'VERIFIED', actualTarget: input.target, actualScopes };
    } catch {
      return { outcome: 'UNKNOWN' };
    }
  }

  async validateAuthorization(
    command: PublicationAdapterCommand,
  ): Promise<PublicationAdapterAuthorizationResult> {
    let target: ReturnType<typeof decodeGitPullRequestTarget>;
    let credential: GitHubInstallationCredential;
    try {
      target = decodeGitPullRequestTarget(command.target);
      credential = parseGitHubInstallationCredential(command.secretValue);
    } catch {
      return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
    }
    if (credential.installationId !== target.installationId) {
      return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
    }
    if (!installationHasRequiredPermissions(credential)) {
      return { outcome: 'INVALID', reason: 'SCOPE_INSUFFICIENT' };
    }
    const providerValidation = await this.validateChannelAuthorization({
      tenantId: command.channelPackage.tenantId,
      workspaceId: command.channelPackage.workspaceId,
      channelDefinitionId: command.channelPackage.channel.definitionId,
      target: command.target,
      requestedScopes: this.requiredScopesFor({ target: command.target }),
      acceptedTermsVersion: this.descriptor.termsVersion,
      secretValue: command.secretValue,
    });
    return publicationAuthorizationFromProviderValidation(providerValidation);
  }

  preview(command: PublicationAdapterPreviewCommand): PublicationAdapterPreviewResult {
    decodeGitPullRequestTarget(command.target);
    return {
      packageChecksum: command.channelPackage.packageChecksum,
      files: { ...command.payload.files },
    };
  }

  async publish(command: PublicationAdapterCommand): Promise<PublicationAdapterPublishResult> {
    // The Worker invokes the provider-backed validateAuthorization exactly once, then fences the
    // lease immediately before calling publish. Repeat only local envelope checks here so a
    // successful effect does not consume a second provider authorization read.
    let target: ReturnType<typeof decodeGitPullRequestTarget>;
    let credential: GitHubInstallationCredential;
    try {
      target = decodeGitPullRequestTarget(command.target);
      credential = parseGitHubInstallationCredential(command.secretValue);
      if (
        credential.installationId !== target.installationId ||
        !installationHasRequiredPermissions(credential)
      ) {
        return {
          outcome: 'DEFINITELY_NOT_APPLIED',
          errorCode:
            credential.installationId !== target.installationId
              ? 'GITHUB_TARGET_NOT_ALLOWED'
              : 'GITHUB_SCOPE_INSUFFICIENT',
        };
      }
      requireCanonicalPackageFiles(command.payload.files);
    } catch {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'GITHUB_PACKAGE_INVALID' };
    }

    const headers = githubHeaders(credential.token);
    const repositoryPath = `/repos/${githubRepositoryPath(target.repository)}`;
    const intent = remoteIntent(command);
    const fingerprint = commandFingerprint(command);
    const headBranch = `aeostudio/publication-${intent.slice(0, 32)}`;
    const marker = pullRequestMarker({
      intent,
      fingerprint,
      packageChecksum: command.channelPackage.packageChecksum,
    });
    const expectedCommitMessage = gitCommitMessage(marker, command.channelPackage.packageChecksum);
    let remoteWriteStarted = false;
    try {
      const existing = await this.options.transport.request({
        method: 'GET',
        path:
          `${repositoryPath}/pulls?state=all` +
          `&head=${encodeURIComponent(`${target.repository.split('/')[0]}:${headBranch}`)}` +
          `&base=${encodeURIComponent(target.baseBranch)}&per_page=100`,
        headers,
        timeoutMs: 10_000,
        maxResponseBytes: 512 * 1024,
      });
      if (existing.status !== 200 || !Array.isArray(existing.body)) {
        return { outcome: 'RETRYABLE_FAILURE', errorCode: 'GITHUB_RECONCILE_LOOKUP_FAILED' };
      }
      const matchingSummaries = existing.body
        .map(parsePullRequest)
        .filter((candidate): candidate is ParsedPullRequest => candidate !== null)
        .filter(
          (candidate) =>
            candidate.head === headBranch &&
            candidate.base === target.baseBranch &&
            candidate.body.includes(marker),
        );
      if (matchingSummaries.length > 1) {
        return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_PULL_REQUEST_CONFLICT' };
      }
      const matchingSummary = matchingSummaries[0];
      if (matchingSummary !== undefined) {
        if (!remoteRefMatches(matchingSummary.url, command.target, matchingSummary.number)) {
          return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_PULL_REQUEST_CONFLICT' };
        }
        const matchingBranch = await inspectDeterministicBranch({
          transport: this.options.transport,
          repositoryPath,
          headers,
          headBranch,
          expectedCommitMessage,
        });
        if (matchingBranch.kind !== 'MATCH') {
          return {
            outcome: 'AMBIGUOUS',
            errorCode:
              matchingBranch.kind === 'UNKNOWN'
                ? 'GITHUB_PULL_REQUEST_STATUS_UNKNOWN'
                : 'GITHUB_PULL_REQUEST_CONFLICT',
          };
        }
        const matching = await completePullRequest(
          this.options.transport,
          repositoryPath,
          headers,
          matchingSummary,
        );
        if (matching === null) {
          return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_PULL_REQUEST_STATUS_UNKNOWN' };
        }
        if (
          !fullExistingPullRequestMatches({
            pullRequest: matching,
            targetValue: command.target,
            repository: target.repository,
            expectedHeadSha: matchingBranch.commitSha,
            headBranch,
            baseBranch: target.baseBranch,
            marker,
          })
        ) {
          return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_PULL_REQUEST_CONFLICT' };
        }
        return appliedPullRequest(target.repository, matching);
      }
      if (existing.body.length > 0) {
        return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_PULL_REQUEST_CONFLICT' };
      }

      const existingBranch = await inspectDeterministicBranch({
        transport: this.options.transport,
        repositoryPath,
        headers,
        headBranch,
        expectedCommitMessage,
      });
      if (existingBranch.kind === 'CONFLICT') {
        return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_BRANCH_CONFLICT' };
      }
      if (existingBranch.kind === 'UNKNOWN') {
        return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_BRANCH_STATUS_UNKNOWN' };
      }
      if (existingBranch.kind === 'MATCH') {
        remoteWriteStarted = true;
        const resumedPullResponse = await this.options.transport.request({
          method: 'POST',
          path: `${repositoryPath}/pulls`,
          headers,
          body: {
            title: 'AEOStudio approved content package',
            body: marker,
            head: headBranch,
            base: target.baseBranch,
            draft: true,
            maintainer_can_modify: false,
          },
          timeoutMs: 10_000,
          maxResponseBytes: 512 * 1024,
        });
        const resumedPullRequest = parsePullRequestResponse(resumedPullResponse, 201);
        if (
          resumedPullRequest === null ||
          resumedPullRequest.state !== 'open' ||
          resumedPullRequest.merged !== false ||
          !resumedPullRequest.draft ||
          !remoteRefMatches(resumedPullRequest.url, command.target, resumedPullRequest.number) ||
          resumedPullRequest.head !== headBranch ||
          resumedPullRequest.base !== target.baseBranch ||
          resumedPullRequest.body !== marker
        ) {
          return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_PULL_REQUEST_RESULT_UNKNOWN' };
        }
        const fullResumedPullRequest = await completePullRequest(
          this.options.transport,
          repositoryPath,
          headers,
          resumedPullRequest,
        );
        if (
          fullResumedPullRequest === null ||
          !fullCreatedPullRequestMatches({
            pullRequest: fullResumedPullRequest,
            targetValue: command.target,
            repository: target.repository,
            expectedHeadSha: existingBranch.commitSha,
            headBranch,
            baseBranch: target.baseBranch,
            marker,
          })
        ) {
          return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_PULL_REQUEST_RESULT_UNKNOWN' };
        }
        return appliedPullRequest(target.repository, fullResumedPullRequest);
      }

      const baseRef = await this.options.transport.request({
        method: 'GET',
        path: `${repositoryPath}/git/ref/heads/${encodeURIComponent(target.baseBranch)}`,
        headers,
        timeoutMs: 10_000,
        maxResponseBytes: 256 * 1024,
      });
      const baseCommitSha = responseNestedString(baseRef, 200, ['object', 'sha']);
      if (baseCommitSha === null) {
        return { outcome: 'RETRYABLE_FAILURE', errorCode: 'GITHUB_BASE_REF_UNAVAILABLE' };
      }
      const baseCommit = await this.options.transport.request({
        method: 'GET',
        path: `${repositoryPath}/git/commits/${encodeURIComponent(baseCommitSha)}`,
        headers,
        timeoutMs: 10_000,
        maxResponseBytes: 256 * 1024,
      });
      const baseTreeSha = responseNestedString(baseCommit, 200, ['tree', 'sha']);
      if (baseTreeSha === null) {
        return { outcome: 'RETRYABLE_FAILURE', errorCode: 'GITHUB_BASE_TREE_UNAVAILABLE' };
      }
      const baseTree = await this.options.transport.request({
        method: 'GET',
        path: `${repositoryPath}/git/trees/${encodeURIComponent(baseTreeSha)}?recursive=1`,
        headers,
        timeoutMs: 10_000,
        maxResponseBytes: 4 * 1024 * 1024,
      });
      if (!treeAllowsTarget(baseTree, target.pathPrefix, Object.keys(command.payload.files))) {
        return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'GITHUB_PATH_NOT_ALLOWED' };
      }

      const blobs: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
      for (const [path, content] of sortedFileEntries(command.payload.files)) {
        remoteWriteStarted = true;
        const response = await this.options.transport.request({
          method: 'POST',
          path: `${repositoryPath}/git/blobs`,
          headers,
          body: {
            content: Buffer.from(content, 'utf8').toString('base64'),
            encoding: 'base64',
          },
          timeoutMs: 10_000,
          maxResponseBytes: 256 * 1024,
        });
        const sha = responseString(response, 201, 'sha');
        if (sha === null) {
          return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_BLOB_WRITE_RESULT_UNKNOWN' };
        }
        blobs.push({
          path: `${target.pathPrefix}/${path}`,
          mode: '100644',
          type: 'blob',
          sha,
        });
      }

      const treeResponse = await this.options.transport.request({
        method: 'POST',
        path: `${repositoryPath}/git/trees`,
        headers,
        body: { base_tree: baseTreeSha, tree: blobs },
        timeoutMs: 10_000,
        maxResponseBytes: 256 * 1024,
      });
      const treeSha = responseString(treeResponse, 201, 'sha');
      if (treeSha === null) {
        return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_TREE_WRITE_RESULT_UNKNOWN' };
      }
      const commitResponse = await this.options.transport.request({
        method: 'POST',
        path: `${repositoryPath}/git/commits`,
        headers,
        body: {
          message: expectedCommitMessage,
          tree: treeSha,
          parents: [baseCommitSha],
        },
        timeoutMs: 10_000,
        maxResponseBytes: 256 * 1024,
      });
      const commitSha = responseString(commitResponse, 201, 'sha');
      if (commitSha === null) {
        return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_COMMIT_WRITE_RESULT_UNKNOWN' };
      }
      let publishedHeadSha = commitSha;
      const refResponse = await this.options.transport.request({
        method: 'POST',
        path: `${repositoryPath}/git/refs`,
        headers,
        body: { ref: `refs/heads/${headBranch}`, sha: commitSha },
        timeoutMs: 10_000,
        maxResponseBytes: 256 * 1024,
      });
      if (responseNestedString(refResponse, 201, ['object', 'sha']) !== commitSha) {
        if (refResponse.status !== 422) {
          return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_BRANCH_WRITE_RESULT_UNKNOWN' };
        }
        const concurrentBranch = await inspectDeterministicBranch({
          transport: this.options.transport,
          repositoryPath,
          headers,
          headBranch,
          expectedCommitMessage,
        });
        if (concurrentBranch.kind !== 'MATCH') {
          return {
            outcome: 'AMBIGUOUS',
            errorCode:
              concurrentBranch.kind === 'CONFLICT'
                ? 'GITHUB_BRANCH_CONFLICT'
                : 'GITHUB_BRANCH_STATUS_UNKNOWN',
          };
        }
        publishedHeadSha = concurrentBranch.commitSha;
      }
      const pullResponse = await this.options.transport.request({
        method: 'POST',
        path: `${repositoryPath}/pulls`,
        headers,
        body: {
          title: 'AEOStudio approved content package',
          body: marker,
          head: headBranch,
          base: target.baseBranch,
          draft: true,
          maintainer_can_modify: false,
        },
        timeoutMs: 10_000,
        maxResponseBytes: 512 * 1024,
      });
      const pullRequest = parsePullRequestResponse(pullResponse, 201);
      if (
        pullRequest === null ||
        pullRequest.state !== 'open' ||
        pullRequest.merged !== false ||
        !pullRequest.draft ||
        !remoteRefMatches(pullRequest.url, command.target, pullRequest.number) ||
        pullRequest.head !== headBranch ||
        pullRequest.base !== target.baseBranch ||
        pullRequest.body !== marker
      ) {
        return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_PULL_REQUEST_RESULT_UNKNOWN' };
      }
      const fullPullRequest = await completePullRequest(
        this.options.transport,
        repositoryPath,
        headers,
        pullRequest,
      );
      if (
        fullPullRequest === null ||
        !fullCreatedPullRequestMatches({
          pullRequest: fullPullRequest,
          targetValue: command.target,
          repository: target.repository,
          expectedHeadSha: publishedHeadSha,
          headBranch,
          baseBranch: target.baseBranch,
          marker,
        })
      ) {
        return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_PULL_REQUEST_RESULT_UNKNOWN' };
      }
      return appliedPullRequest(target.repository, fullPullRequest);
    } catch {
      return remoteWriteStarted
        ? { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_REMOTE_WRITE_RESULT_UNKNOWN' }
        : { outcome: 'RETRYABLE_FAILURE', errorCode: 'GITHUB_PROVIDER_UNAVAILABLE' };
    }
  }

  async reconcile(command: PublicationAdapterCommand): Promise<PublicationAdapterReconcileResult> {
    // Reconciliation is reached through the same Worker preflight and lease fence as publication.
    try {
      const target = decodeGitPullRequestTarget(command.target);
      const credential = parseGitHubInstallationCredential(command.secretValue);
      if (
        credential.installationId !== target.installationId ||
        !installationHasRequiredPermissions(credential)
      ) {
        return {
          outcome: 'DEFINITELY_NOT_APPLIED',
          errorCode:
            credential.installationId !== target.installationId
              ? 'GITHUB_TARGET_NOT_ALLOWED'
              : 'GITHUB_SCOPE_INSUFFICIENT',
        };
      }
      const intent = remoteIntent(command);
      const headBranch = `aeostudio/publication-${intent.slice(0, 32)}`;
      const marker = pullRequestMarker({
        intent,
        fingerprint: commandFingerprint(command),
        packageChecksum: command.channelPackage.packageChecksum,
      });
      const repositoryPath = `/repos/${githubRepositoryPath(target.repository)}`;
      const headers = githubHeaders(credential.token);
      const response = await this.options.transport.request({
        method: 'GET',
        path:
          `${repositoryPath}/pulls?state=all` +
          `&head=${encodeURIComponent(`${target.repository.split('/')[0]}:${headBranch}`)}` +
          `&base=${encodeURIComponent(target.baseBranch)}&per_page=100`,
        headers,
        timeoutMs: 10_000,
        maxResponseBytes: 512 * 1024,
      });
      if (response.status !== 200 || !Array.isArray(response.body)) {
        return { outcome: 'RETRYABLE_FAILURE', errorCode: 'GITHUB_RECONCILE_LOOKUP_FAILED' };
      }
      const candidates = response.body
        .map(parsePullRequest)
        .filter((candidate): candidate is ParsedPullRequest => candidate !== null);
      const matchingSummaries = candidates.filter(
        (candidate) =>
          candidate.head === headBranch &&
          candidate.base === target.baseBranch &&
          candidate.body.includes(marker),
      );
      if (matchingSummaries.length > 1) {
        return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_REMOTE_EFFECT_CONFLICT' };
      }
      const matchingSummary = matchingSummaries[0];
      if (matchingSummary !== undefined) {
        if (!remoteRefMatches(matchingSummary.url, command.target, matchingSummary.number)) {
          return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_REMOTE_EFFECT_CONFLICT' };
        }
        const matchingBranch = await inspectDeterministicBranch({
          transport: this.options.transport,
          repositoryPath,
          headers,
          headBranch,
          expectedCommitMessage: gitCommitMessage(marker, command.channelPackage.packageChecksum),
        });
        if (matchingBranch.kind !== 'MATCH') {
          return {
            outcome: 'AMBIGUOUS',
            errorCode:
              matchingBranch.kind === 'UNKNOWN'
                ? 'GITHUB_PULL_REQUEST_STATUS_UNKNOWN'
                : 'GITHUB_REMOTE_EFFECT_CONFLICT',
          };
        }
        const matching = await completePullRequest(
          this.options.transport,
          repositoryPath,
          headers,
          matchingSummary,
        );
        if (matching === null) {
          return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_PULL_REQUEST_STATUS_UNKNOWN' };
        }
        if (
          !fullExistingPullRequestMatches({
            pullRequest: matching,
            targetValue: command.target,
            repository: target.repository,
            expectedHeadSha: matchingBranch.commitSha,
            headBranch,
            baseBranch: target.baseBranch,
            marker,
          })
        ) {
          return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_REMOTE_EFFECT_CONFLICT' };
        }
        return appliedPullRequest(target.repository, matching);
      }
      if (candidates.length > 0) {
        return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_REMOTE_EFFECT_CONFLICT' };
      }
      const branch = await inspectDeterministicBranch({
        transport: this.options.transport,
        repositoryPath,
        headers,
        headBranch,
        expectedCommitMessage: gitCommitMessage(marker, command.channelPackage.packageChecksum),
      });
      switch (branch.kind) {
        case 'MISSING':
          return {
            outcome: 'DEFINITELY_NOT_APPLIED',
            errorCode: 'GITHUB_REMOTE_EFFECT_NOT_FOUND',
          };
        case 'MATCH':
          return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_PARTIAL_REMOTE_EFFECT_FOUND' };
        case 'CONFLICT':
          return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_BRANCH_CONFLICT' };
        default:
          return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_BRANCH_STATUS_UNKNOWN' };
      }
    } catch {
      return { outcome: 'AMBIGUOUS', errorCode: 'GITHUB_RECONCILIATION_UNAVAILABLE' };
    }
  }

  refreshRemoteStatus(
    command: PublicationAdapterCommand,
  ): Promise<PublicationAdapterRemoteStatusResult> {
    return this.reconcile(command).then((result) =>
      result.outcome === 'APPLIED' && result.remoteState !== undefined
        ? {
            outcome: 'APPLIED' as const,
            remoteRef: result.remoteRef,
            remoteState: result.remoteState,
          }
        : {
            outcome: 'UNKNOWN' as const,
            errorCode:
              result.outcome === 'DEFINITELY_NOT_APPLIED'
                ? 'GITHUB_REMOTE_EFFECT_NOT_FOUND'
                : 'GITHUB_REMOTE_STATUS_UNAVAILABLE',
          },
    );
  }

  async rollback(
    command: PublicationAdapterRollbackCommand,
  ): Promise<PublicationAdapterRollbackResult> {
    const reconciled = await this.reconcile(command);
    if (reconciled.outcome !== 'APPLIED' || reconciled.remoteState === undefined) {
      return reconciled.outcome === 'DEFINITELY_NOT_APPLIED'
        ? { outcome: 'DEFINITELY_NOT_ROLLED_BACK', errorCode: 'GITHUB_REMOTE_EFFECT_NOT_FOUND' }
        : { outcome: 'UNKNOWN', errorCode: 'GITHUB_ROLLBACK_RECONCILIATION_REQUIRED' };
    }
    if (
      reconciled.remoteRef !== command.remoteRef ||
      typeof reconciled.remoteState.number !== 'number' ||
      !remoteRefMatches(command.remoteRef, command.target, reconciled.remoteState.number)
    ) {
      return { outcome: 'DEFINITELY_NOT_ROLLED_BACK', errorCode: 'GITHUB_ROLLBACK_NOT_ALLOWED' };
    }
    if (reconciled.remoteState.status === 'CLOSED') {
      return { outcome: 'ROLLED_BACK', remoteRef: reconciled.remoteRef };
    }
    if (reconciled.remoteState.status !== 'PR_OPENED') {
      return { outcome: 'DEFINITELY_NOT_ROLLED_BACK', errorCode: 'GITHUB_ROLLBACK_NOT_ALLOWED' };
    }
    try {
      const target = decodeGitPullRequestTarget(command.target);
      const credential = parseGitHubInstallationCredential(command.secretValue);
      const marker = pullRequestMarker({
        intent: remoteIntent(command),
        fingerprint: commandFingerprint(command),
        packageChecksum: command.channelPackage.packageChecksum,
      });
      const response = await this.options.transport.request({
        method: 'PATCH',
        path:
          `/repos/${githubRepositoryPath(target.repository)}/pulls/` +
          String(reconciled.remoteState.number),
        headers: githubHeaders(credential.token),
        body: { state: 'closed' },
        timeoutMs: 10_000,
        maxResponseBytes: 512 * 1024,
      });
      const closed = parsePullRequestResponse(response, 200);
      if (
        closed === null ||
        closed.state !== 'closed' ||
        closed.merged ||
        closed.url !== command.remoteRef ||
        !closed.body.includes(marker)
      ) {
        return { outcome: 'UNKNOWN', errorCode: 'GITHUB_ROLLBACK_RESULT_UNKNOWN' };
      }
      return { outcome: 'ROLLED_BACK', remoteRef: closed.url };
    } catch {
      return { outcome: 'UNKNOWN', errorCode: 'GITHUB_ROLLBACK_RESULT_UNKNOWN' };
    }
  }
}

function parseGitHubInstallationCredential(secretValue: string): GitHubInstallationCredential {
  let value: unknown;
  try {
    value = JSON.parse(secretValue) as unknown;
  } catch {
    throw new Error('GITHUB_CREDENTIAL_INVALID');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'installationId', 'permissions', 'token']) ||
    value.schemaVersion !== 'aeostudio.github-installation-credential.v1' ||
    typeof value.installationId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value.installationId) ||
    !isRecord(value.permissions) ||
    !hasExactKeys(value.permissions, ['contents', 'metadata', 'pull_requests']) ||
    (value.permissions.contents !== 'read' && value.permissions.contents !== 'write') ||
    (value.permissions.pull_requests !== 'read' && value.permissions.pull_requests !== 'write') ||
    (value.permissions.metadata !== 'read' && value.permissions.metadata !== 'write') ||
    typeof value.token !== 'string' ||
    value.token.length < 1 ||
    value.token.length > 2_048 ||
    containsAsciiControlCharacter(value.token)
  ) {
    throw new Error('GITHUB_CREDENTIAL_INVALID');
  }
  return {
    installationId: value.installationId,
    permissions: {
      contents: value.permissions.contents,
      pull_requests: value.permissions.pull_requests,
      metadata: value.permissions.metadata,
    },
    token: value.token,
  };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'AEOStudio-Publication-Adapter/1.0',
    'x-github-api-version': '2026-03-10',
  };
}

function publicationAuthorizationFromProviderValidation(
  result: ChannelAuthorizationValidationResult,
): PublicationAdapterAuthorizationResult {
  if (result.outcome === 'VERIFIED') return { outcome: 'VALID' };
  if (result.outcome === 'UNKNOWN') return { outcome: 'UNKNOWN' };
  switch (result.reason) {
    case 'SCOPE_INSUFFICIENT':
      return { outcome: 'INVALID', reason: 'SCOPE_INSUFFICIENT' };
    case 'BRANCH_POLICY_CONFLICT':
      return { outcome: 'INVALID', reason: 'BRANCH_POLICY_CONFLICT' };
    default:
      return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
  }
}

function remoteIntent(command: PublicationAdapterCommand): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        command.channelPackage.tenantId,
        command.channelPackage.workspaceId,
        command.target,
        command.channelPackage.id,
        command.channelPackage.packageChecksum,
      ]),
      'utf8',
    )
    .digest('hex');
}

function commandFingerprint(command: PublicationAdapterCommand): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        packageChecksum: command.channelPackage.packageChecksum,
        target: command.target,
        files: sortedFileEntries(command.payload.files).map(([path, content]) => [
          path,
          createHash('sha256').update(content, 'utf8').digest('hex'),
        ]),
      }),
      'utf8',
    )
    .digest('hex');
}

function pullRequestMarker(input: {
  intent: string;
  fingerprint: string;
  packageChecksum: string;
}): string {
  return `<!-- aeostudio-publication:v1 ${JSON.stringify(input)} -->`;
}

function gitCommitMessage(marker: string, packageChecksum: string): string {
  return `AEOStudio approved package ${packageChecksum}\n\n${marker}`;
}

function sortedFileEntries(files: Record<string, string>): Array<[string, string]> {
  return Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
}

function requireCanonicalPackageFiles(files: Record<string, string>): void {
  const entries = sortedFileEntries(files);
  if (entries.length === 0 || entries.length > 100) throw new Error('GITHUB_PACKAGE_INVALID');
  for (const [path, content] of entries) {
    const contentBytes = Buffer.byteLength(content, 'utf8');
    const encodedContentBytes = 4 * Math.ceil(contentBytes / 3);
    if (
      path.length === 0 ||
      path.length > 1_024 ||
      path.startsWith('/') ||
      path.endsWith('/') ||
      path.includes('\\') ||
      path.includes('%') ||
      path.includes('\u0000') ||
      path
        .split('/')
        .some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
      contentBytes > 10 * 1024 * 1024 ||
      encodedContentBytes + GITHUB_BLOB_REQUEST_JSON_OVERHEAD > GITHUB_TRANSPORT_MAX_REQUEST_BYTES
    ) {
      throw new Error('GITHUB_PACKAGE_INVALID');
    }
    const segments = path.toLowerCase().split('/');
    if (segments.includes('.git') || (segments[0] === '.github' && segments[1] === 'workflows')) {
      throw new Error('GITHUB_PACKAGE_INVALID');
    }
  }
}

function treeAllowsTarget(
  response: GitHubRestResponse,
  pathPrefix: string,
  filePaths: string[],
): boolean {
  if (
    response.status !== 200 ||
    !isRecord(response.body) ||
    response.body.truncated !== false ||
    !Array.isArray(response.body.tree)
  ) {
    return false;
  }
  const targets = filePaths.map((path) => `${pathPrefix}/${path}`);
  return response.body.tree.every((entry) => {
    if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.mode !== 'string') {
      return false;
    }
    const entryPath = entry.path;
    const entryMode = entry.mode;
    if (entryMode !== '120000' && entryMode !== '160000') return true;
    return targets.every(
      (target) =>
        !(
          target === entryPath ||
          target.startsWith(`${entryPath}/`) ||
          entryPath.startsWith(`${target}/`)
        ),
    );
  });
}

interface ParsedPullRequest {
  number: number;
  url: string;
  state: 'open' | 'closed';
  merged: boolean | null;
  draft: boolean;
  head: string;
  headSha: string | null;
  headRepository: string | null;
  base: string;
  baseRepository: string | null;
  body: string;
}

function parsePullRequestResponse(
  response: GitHubRestResponse,
  status: number,
): ParsedPullRequest | null {
  return response.status === status ? parsePullRequest(response.body) : null;
}

function parsePullRequest(value: unknown): ParsedPullRequest | null {
  const merged =
    isRecord(value) && typeof value.merged === 'boolean'
      ? value.merged
      : isRecord(value) && value.merged_at === null
        ? false
        : isRecord(value) && typeof value.merged_at === 'string' && value.merged_at.length > 0
          ? true
          : null;
  if (
    !isRecord(value) ||
    typeof value.number !== 'number' ||
    !Number.isSafeInteger(value.number) ||
    value.number <= 0 ||
    typeof value.html_url !== 'string' ||
    (value.state !== 'open' && value.state !== 'closed') ||
    typeof value.draft !== 'boolean' ||
    !isRecord(value.head) ||
    typeof value.head.ref !== 'string' ||
    !isRecord(value.base) ||
    typeof value.base.ref !== 'string'
  ) {
    return null;
  }
  return {
    number: value.number,
    url: value.html_url,
    state: value.state,
    merged,
    draft: value.draft,
    head: value.head.ref,
    headSha: typeof value.head.sha === 'string' ? value.head.sha : null,
    headRepository:
      isRecord(value.head.repo) && typeof value.head.repo.full_name === 'string'
        ? value.head.repo.full_name
        : null,
    base: value.base.ref,
    baseRepository:
      isRecord(value.base.repo) && typeof value.base.repo.full_name === 'string'
        ? value.base.repo.full_name
        : null,
    body: typeof value.body === 'string' ? value.body : '',
  };
}

function appliedPullRequest(
  repository: string,
  pullRequest: ParsedPullRequest & { merged: boolean },
): Extract<PublicationAdapterPublishResult, { outcome: 'APPLIED' }> {
  const status = pullRequest.merged
    ? 'MERGED'
    : pullRequest.state === 'closed'
      ? 'CLOSED'
      : 'PR_OPENED';
  return {
    outcome: 'APPLIED',
    remoteRef: pullRequest.url,
    remoteState: {
      status,
      number: pullRequest.number,
      isProductionLive: false,
      rollbackHandle:
        status === 'PR_OPENED'
          ? {
              operation: 'CLOSE_PULL_REQUEST',
              repository,
              pullRequestNumber: pullRequest.number,
            }
          : null,
    },
  };
}

async function completePullRequest(
  transport: GitHubRestTransport,
  repositoryPath: string,
  headers: Record<string, string>,
  pullRequest: ParsedPullRequest,
): Promise<(ParsedPullRequest & { merged: boolean }) | null> {
  const response = await transport.request({
    method: 'GET',
    path: `${repositoryPath}/pulls/${String(pullRequest.number)}`,
    headers,
    timeoutMs: 10_000,
    maxResponseBytes: 512 * 1024,
  });
  const complete = parsePullRequestResponse(response, 200);
  return complete !== null && complete.merged !== null && complete.number === pullRequest.number
    ? (complete as ParsedPullRequest & { merged: boolean })
    : null;
}

function fullCreatedPullRequestMatches(input: {
  pullRequest: ParsedPullRequest & { merged: boolean };
  targetValue: string;
  repository: string;
  expectedHeadSha: string;
  headBranch: string;
  baseBranch: string;
  marker: string;
}): boolean {
  return (
    input.pullRequest.state === 'open' &&
    !input.pullRequest.merged &&
    input.pullRequest.draft &&
    remoteRefMatches(input.pullRequest.url, input.targetValue, input.pullRequest.number) &&
    input.pullRequest.head === input.headBranch &&
    input.pullRequest.headSha === input.expectedHeadSha &&
    repositoryMatches(input.pullRequest.headRepository, input.repository) &&
    input.pullRequest.base === input.baseBranch &&
    repositoryMatches(input.pullRequest.baseRepository, input.repository) &&
    input.pullRequest.body === input.marker
  );
}

function fullExistingPullRequestMatches(input: {
  pullRequest: ParsedPullRequest & { merged: boolean };
  targetValue: string;
  repository: string;
  expectedHeadSha: string;
  headBranch: string;
  baseBranch: string;
  marker: string;
}): boolean {
  return (
    !(input.pullRequest.state === 'open' && input.pullRequest.merged) &&
    !(
      input.pullRequest.state === 'closed' &&
      input.pullRequest.merged &&
      input.pullRequest.draft
    ) &&
    remoteRefMatches(input.pullRequest.url, input.targetValue, input.pullRequest.number) &&
    input.pullRequest.head === input.headBranch &&
    input.pullRequest.headSha === input.expectedHeadSha &&
    repositoryMatches(input.pullRequest.headRepository, input.repository) &&
    input.pullRequest.base === input.baseBranch &&
    repositoryMatches(input.pullRequest.baseRepository, input.repository) &&
    input.pullRequest.body === input.marker
  );
}

async function inspectDeterministicBranch(input: {
  transport: GitHubRestTransport;
  repositoryPath: string;
  headers: Record<string, string>;
  headBranch: string;
  expectedCommitMessage: string;
}): Promise<
  | { kind: 'MISSING' }
  | { kind: 'MATCH'; commitSha: string }
  | { kind: 'CONFLICT' }
  | { kind: 'UNKNOWN' }
> {
  const reference = await input.transport.request({
    method: 'GET',
    path: `${input.repositoryPath}/git/ref/heads/${encodeURIComponent(input.headBranch)}`,
    headers: input.headers,
    timeoutMs: 10_000,
    maxResponseBytes: 256 * 1024,
  });
  if (reference.status === 404) return { kind: 'MISSING' };
  const commitSha = responseNestedString(reference, 200, ['object', 'sha']);
  if (commitSha === null) return { kind: 'UNKNOWN' };
  const commit = await input.transport.request({
    method: 'GET',
    path: `${input.repositoryPath}/git/commits/${encodeURIComponent(commitSha)}`,
    headers: input.headers,
    timeoutMs: 10_000,
    maxResponseBytes: 256 * 1024,
  });
  if (commit.status !== 200 || !isRecord(commit.body) || typeof commit.body.message !== 'string') {
    return { kind: 'UNKNOWN' };
  }
  return commit.body.message === input.expectedCommitMessage
    ? { kind: 'MATCH', commitSha }
    : { kind: 'CONFLICT' };
}

function responseString(
  response: GitHubRestResponse,
  expectedStatus: number,
  field: string,
): string | null {
  return response.status === expectedStatus &&
    isRecord(response.body) &&
    typeof response.body[field] === 'string' &&
    response.body[field].length > 0
    ? response.body[field]
    : null;
}

function responseNestedString(
  response: GitHubRestResponse,
  expectedStatus: number,
  path: [string, string],
): string | null {
  if (response.status !== expectedStatus || !isRecord(response.body)) return null;
  const parent = response.body[path[0]];
  if (!isRecord(parent)) return null;
  const value = parent[path[1]];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function installationTokenCoversRepository(
  transport: GitHubRestTransport,
  headers: Record<string, string>,
  targetRepository: string,
): Promise<boolean> {
  let expectedTotal: number | null = null;
  let repositoriesSeen = 0;
  for (let page = 1; page <= 100; page += 1) {
    const response = await transport.request({
      method: 'GET',
      path: `/installation/repositories?per_page=100&page=${String(page)}`,
      headers,
      timeoutMs: 10_000,
      maxResponseBytes: 4 * 1024 * 1024,
    });
    const parsed = parseInstallationRepositoryPage(response);
    if (parsed === null) return false;
    if (expectedTotal === null) expectedTotal = parsed.totalCount;
    if (parsed.totalCount !== expectedTotal) return false;
    if (
      parsed.repositories.some(
        (repository) => repository.toLowerCase() === targetRepository.toLowerCase(),
      )
    ) {
      return true;
    }
    repositoriesSeen += parsed.repositories.length;
    if (repositoriesSeen >= expectedTotal) return false;
    if (parsed.repositories.length !== 100) return false;
  }
  return false;
}

function parseInstallationRepositoryPage(
  response: GitHubRestResponse,
): { totalCount: number; repositories: string[] } | null {
  if (
    response.status !== 200 ||
    !isRecord(response.body) ||
    typeof response.body.total_count !== 'number' ||
    !Number.isSafeInteger(response.body.total_count) ||
    response.body.total_count < 0 ||
    !Array.isArray(response.body.repositories) ||
    response.body.repositories.length > 100
  ) {
    return null;
  }
  const repositories: string[] = [];
  for (const repository of response.body.repositories) {
    if (
      !isRecord(repository) ||
      typeof repository.full_name !== 'string' ||
      repository.full_name.length === 0
    ) {
      return null;
    }
    repositories.push(repository.full_name);
  }
  return { totalCount: response.body.total_count, repositories };
}

function installationHasRequiredPermissions(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.permissions)) return false;
  return (
    value.permissions.contents === 'write' &&
    value.permissions.pull_requests === 'write' &&
    (value.permissions.metadata === 'read' || value.permissions.metadata === 'write')
  );
}

function githubRepositoryPath(repository: string): string {
  const [owner, name] = repository.split('/');
  if (owner === undefined || name === undefined) throw new Error('GITHUB_REPOSITORY_INVALID');
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function repositoryMatches(actual: string | null, expected: string): boolean {
  return actual !== null && actual.toLowerCase() === expected.toLowerCase();
}

function containsAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function remoteRefMatches(remoteRef: string, targetValue: string, number: number): boolean {
  try {
    const target = decodeGitPullRequestTarget(targetValue);
    const value = new URL(remoteRef);
    return (
      value.protocol === 'https:' &&
      value.hostname === 'github.com' &&
      value.port === '' &&
      value.username === '' &&
      value.password === '' &&
      value.search === '' &&
      value.hash === '' &&
      value.pathname.toLowerCase() === `/${target.repository}/pull/${String(number)}`.toLowerCase()
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
