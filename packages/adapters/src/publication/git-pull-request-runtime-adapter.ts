import { createHash } from 'node:crypto';

import type {
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
import type { PublicationRemoteState } from '@aeostudio/domain/channels-publishing';

import type {
  GitPublishCommand,
  GitPublishResult,
  GitPullRequestPublicationAdapter,
  GitPullRequestReference,
  GitReconcileResult,
  GitRollbackHandle,
} from './git-pull-request-publication-adapter.js';

export {
  decodeGitPullRequestTarget,
  encodeGitPullRequestTarget,
  type GitPullRequestTargetV1,
} from '@aeostudio/contracts/channels';

export interface GitPullRequestRuntimeAdapterOptions {
  adapterKey: string;
  adapterVersion: string;
  descriptor: Omit<PublicationAdapterDescriptor, 'adapterKey' | 'adapterVersion'>;
  gitAdapter: GitPullRequestPublicationAdapter;
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

function toRemoteState(reference: GitPullRequestReference): PublicationRemoteState {
  return {
    status: reference.status,
    number: reference.number,
    isProductionLive: false,
    rollbackHandle: reference.status === 'PR_OPENED' ? { ...reference.rollbackHandle } : null,
  };
}

function appliedResult(
  result: Extract<GitPublishResult | GitReconcileResult, { outcome: 'APPLIED' }>,
): Extract<PublicationAdapterPublishResult, { outcome: 'APPLIED' }> {
  return {
    outcome: 'APPLIED',
    remoteRef: result.remoteRef,
    remoteState: toRemoteState(result),
  };
}

/**
 * Bridges the capability-limited Git implementation to the generic Task 10 coordinator.
 *
 * The remote intent deliberately excludes the platform PublicationRecord id and retry key. A
 * fresh local retry of the same tenant/workspace/target/exact package therefore discovers the
 * same provider PR rather than opening a second one.
 */
export class GitPullRequestRuntimeAdapter implements PublicationAdapter {
  readonly adapterKey: string;
  readonly adapterVersion: string;

  private readonly descriptor: Omit<PublicationAdapterDescriptor, 'adapterKey' | 'adapterVersion'>;
  private readonly gitAdapter: GitPullRequestPublicationAdapter;
  private readonly rollbackHandles = new Map<
    string,
    { remoteRef: string; handle: GitRollbackHandle }
  >();

  constructor(options: GitPullRequestRuntimeAdapterOptions) {
    this.adapterKey = options.adapterKey;
    this.adapterVersion = options.adapterVersion;
    this.descriptor = structuredClone(options.descriptor);
    this.gitAdapter = options.gitAdapter;
  }

  describe(): PublicationAdapterDescriptor {
    return {
      adapterKey: this.adapterKey,
      adapterVersion: this.adapterVersion,
      ...structuredClone(this.descriptor),
    };
  }

  async validateAuthorization(
    command: PublicationAdapterCommand,
  ): Promise<PublicationAdapterAuthorizationResult> {
    if (command.secretValue.length === 0) return { outcome: 'INVALID' };
    try {
      const result = await this.gitAdapter.validateAuthorization(this.toGitCommand(command));
      if (result.outcome === 'VALID') return { outcome: 'VALID' };
      const reason =
        result.errorCode === 'GIT_SCOPE_INSUFFICIENT'
          ? 'SCOPE_INSUFFICIENT'
          : result.errorCode === 'GIT_BRANCH_NOT_ALLOWED'
            ? 'BRANCH_POLICY_CONFLICT'
            : 'TARGET_NOT_ALLOWED';
      return { outcome: 'INVALID', reason };
    } catch {
      return { outcome: 'INVALID' };
    }
  }

  preview(command: PublicationAdapterPreviewCommand): PublicationAdapterPreviewResult {
    decodeGitPullRequestTarget(command.target);
    return {
      packageChecksum: command.channelPackage.packageChecksum,
      files: { ...command.payload.files },
    };
  }

  async publish(command: PublicationAdapterCommand): Promise<PublicationAdapterPublishResult> {
    let gitCommand: GitPublishCommand;
    try {
      if (command.secretValue.length === 0) {
        return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'GIT_AUTHORIZATION_INVALID' };
      }
      gitCommand = this.toGitCommand(command);
    } catch {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'GIT_TARGET_INVALID' };
    }
    const result = await this.gitAdapter.publish(gitCommand);
    if (result.outcome === 'APPLIED') {
      this.rememberRollback(gitCommand.idempotencyKey, result);
      return appliedResult(result);
    }
    return { ...result };
  }

  async reconcile(command: PublicationAdapterCommand): Promise<PublicationAdapterReconcileResult> {
    let gitCommand: GitPublishCommand;
    try {
      if (command.secretValue.length === 0) {
        return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'GIT_AUTHORIZATION_INVALID' };
      }
      gitCommand = this.toGitCommand(command);
    } catch {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'GIT_TARGET_INVALID' };
    }
    const result = await this.gitAdapter.reconcile(gitCommand);
    if (result.outcome === 'APPLIED') {
      this.rememberRollback(gitCommand.idempotencyKey, result);
      return appliedResult(result);
    }
    return { ...result };
  }

  async rollback(
    command: PublicationAdapterRollbackCommand,
  ): Promise<PublicationAdapterRollbackResult> {
    let gitCommand: GitPublishCommand;
    try {
      gitCommand = this.toGitCommand(command);
    } catch {
      return { outcome: 'DEFINITELY_NOT_ROLLED_BACK', errorCode: 'GIT_TARGET_INVALID' };
    }
    const remembered = this.rollbackHandles.get(gitCommand.idempotencyKey);
    if (remembered === undefined || remembered.remoteRef !== command.remoteRef) {
      return { outcome: 'DEFINITELY_NOT_ROLLED_BACK', errorCode: 'GIT_ROLLBACK_HANDLE_MISSING' };
    }
    try {
      const result = await this.gitAdapter.rollback({
        ...gitCommand,
        rollbackHandle: remembered.handle,
      });
      return { outcome: 'ROLLED_BACK', remoteRef: result.remoteRef };
    } catch {
      return { outcome: 'DEFINITELY_NOT_ROLLED_BACK', errorCode: 'GIT_ROLLBACK_REJECTED' };
    }
  }

  async getPullRequestStatus(command: PublicationAdapterCommand): Promise<{
    remoteRef: string;
    remoteState: PublicationRemoteState;
  }> {
    const gitCommand = this.toGitCommand(command);
    const result = await this.gitAdapter.getPullRequestStatus(gitCommand);
    this.rememberRollback(gitCommand.idempotencyKey, result);
    return { remoteRef: result.url, remoteState: toRemoteState(result) };
  }

  async refreshRemoteStatus(
    command: PublicationAdapterCommand,
  ): Promise<PublicationAdapterRemoteStatusResult> {
    try {
      if (command.secretValue.length === 0) {
        return { outcome: 'UNKNOWN', errorCode: 'GIT_AUTHORIZATION_INVALID' };
      }
      const refreshed = await this.getPullRequestStatus(command);
      return { outcome: 'APPLIED', ...refreshed };
    } catch {
      return { outcome: 'UNKNOWN', errorCode: 'GIT_REMOTE_STATUS_UNAVAILABLE' };
    }
  }

  private toGitCommand(command: PublicationAdapterCommand): GitPublishCommand {
    const target = decodeGitPullRequestTarget(command.target);
    const intent = remoteIntent(command);
    return {
      publicationId: `intent-${intent}`,
      idempotencyKey: intent,
      packageChecksum: command.channelPackage.packageChecksum,
      authorizationReference: `installation:${target.installationId}`,
      target: {
        installationId: target.installationId,
        repository: target.repository,
        baseBranch: target.baseBranch,
        pathPrefix: target.pathPrefix,
      },
      files: { ...command.payload.files },
    };
  }

  private rememberRollback(intent: string, reference: GitPullRequestReference): void {
    if (reference.status !== 'PR_OPENED') {
      this.rollbackHandles.delete(intent);
      return;
    }
    this.rollbackHandles.set(intent, {
      remoteRef: reference.url,
      handle: { ...reference.rollbackHandle },
    });
  }
}
