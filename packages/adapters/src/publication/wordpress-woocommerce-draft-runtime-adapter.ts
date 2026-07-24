import type {
  PublicationAdapter,
  PublicationAdapterAuthorizationResult,
  PublicationAdapterCommand,
  PublicationAdapterDescriptor,
  PublicationAdapterPreviewCommand,
  PublicationAdapterPreviewResult,
  PublicationAdapterPublishResult,
  PublicationAdapterReconcileResult,
  PublicationAdapterRollbackCommand,
  PublicationAdapterRollbackResult,
} from '@aeostudio/application/channels-publishing';
import {
  decodeWordPressDraftTarget,
  wordpressAuthorizationTargetFor,
  wordpressRequiredScopesFor,
} from '@aeostudio/contracts/channels';
import type { PublicationRemoteState } from '@aeostudio/domain/channels-publishing';

import type {
  WordPressDraftRollbackHandle,
  WordPressPageDraftCommand,
  WordPressPageDraftPublishResult,
  WordPressWooCommerceDraftPublicationAdapter,
} from './wordpress-woocommerce-draft-publication-adapter.js';

export interface WordPressWooCommerceDraftRuntimeAdapterOptions {
  adapterKey: string;
  adapterVersion: string;
  descriptor: Omit<PublicationAdapterDescriptor, 'adapterKey' | 'adapterVersion'>;
  draftAdapter: WordPressWooCommerceDraftPublicationAdapter;
}

export class WordPressWooCommerceDraftRuntimeAdapter implements PublicationAdapter {
  readonly adapterKey: string;
  readonly adapterVersion: string;

  private readonly descriptor: Omit<PublicationAdapterDescriptor, 'adapterKey' | 'adapterVersion'>;
  private readonly draftAdapter: WordPressWooCommerceDraftPublicationAdapter;

  constructor(options: WordPressWooCommerceDraftRuntimeAdapterOptions) {
    this.adapterKey = options.adapterKey;
    this.adapterVersion = options.adapterVersion;
    this.descriptor = structuredClone(options.descriptor);
    this.draftAdapter = options.draftAdapter;
  }

  describe(): PublicationAdapterDescriptor {
    return {
      adapterKey: this.adapterKey,
      adapterVersion: this.adapterVersion,
      ...structuredClone(this.descriptor),
    };
  }

  authorizationTargetFor(publicationTarget: string): string {
    return wordpressAuthorizationTargetFor(publicationTarget);
  }

  requiredScopesFor(input: {
    target: string;
    channelPackage: PublicationAdapterCommand['channelPackage'];
  }): string[] {
    return wordpressRequiredScopesFor({
      target: input.target,
      assetRefs: input.channelPackage.manifest.assetRefs,
    });
  }

  async validateAuthorization(
    command: PublicationAdapterCommand,
  ): Promise<PublicationAdapterAuthorizationResult> {
    if (command.secretValue.length === 0) return { outcome: 'INVALID' };
    try {
      const result = await this.draftAdapter.validateAuthorization(this.toDraftCommand(command));
      if (result.outcome === 'VALID') return { outcome: 'VALID' };
      return {
        outcome: 'INVALID',
        reason:
          result.errorCode === 'WORDPRESS_SCOPE_INSUFFICIENT'
            ? 'SCOPE_INSUFFICIENT'
            : 'TARGET_NOT_ALLOWED',
      };
    } catch {
      return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
    }
  }

  preview(command: PublicationAdapterPreviewCommand): PublicationAdapterPreviewResult {
    this.toDraftPreview(command);
    return {
      packageChecksum: command.channelPackage.packageChecksum,
      files: { ...command.payload.files },
    };
  }

  async publish(command: PublicationAdapterCommand): Promise<PublicationAdapterPublishResult> {
    if (command.channelPackage.manifest.assetRefs.length > 0) {
      return {
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'WORDPRESS_MEDIA_RESOLVER_UNAVAILABLE',
      };
    }
    try {
      return toGenericResult(await this.draftAdapter.publish(this.toDraftCommand(command)));
    } catch {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'WORDPRESS_TARGET_INVALID' };
    }
  }

  async reconcile(command: PublicationAdapterCommand): Promise<PublicationAdapterReconcileResult> {
    if (command.channelPackage.manifest.assetRefs.length > 0) {
      return {
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'WORDPRESS_MEDIA_RESOLVER_UNAVAILABLE',
      };
    }
    try {
      return toGenericResult(await this.draftAdapter.reconcile(this.toDraftCommand(command)));
    } catch {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'WORDPRESS_TARGET_INVALID' };
    }
  }

  async rollback(
    command: PublicationAdapterRollbackCommand,
  ): Promise<PublicationAdapterRollbackResult> {
    try {
      const draftCommand = this.toDraftCommand(command);
      const target = decodeWordPressDraftTarget(command.target);
      const route =
        target.destination.kind === 'PAGE'
          ? '/wp/v2/pages'
          : target.destination.kind === 'POST'
            ? '/wp/v2/posts'
            : '/wc/v3/products';
      const remoteUrl = new URL(command.remoteRef);
      if (
        remoteUrl.origin !== new URL(target.siteUrl).origin ||
        remoteUrl.pathname !== '/wp-admin/post.php' ||
        remoteUrl.searchParams.get('action') !== 'edit'
      ) {
        return { outcome: 'DEFINITELY_NOT_ROLLED_BACK', errorCode: 'WORDPRESS_REMOTE_REF_INVALID' };
      }
      const remoteId = Number(remoteUrl.searchParams.get('post'));
      if (!Number.isSafeInteger(remoteId) || remoteId <= 0) {
        return { outcome: 'DEFINITELY_NOT_ROLLED_BACK', errorCode: 'WORDPRESS_REMOTE_REF_INVALID' };
      }
      const rollbackHandle: WordPressDraftRollbackHandle = {
        operation: 'TRASH_DRAFT',
        siteOrigin: target.siteUrl,
        resource: route,
        remoteId,
      };
      const result = await this.draftAdapter.rollback({ ...draftCommand, rollbackHandle });
      return result.outcome === 'ROLLED_BACK'
        ? { outcome: 'ROLLED_BACK', remoteRef: result.remoteRef }
        : { outcome: 'DEFINITELY_NOT_ROLLED_BACK', errorCode: result.errorCode };
    } catch {
      return { outcome: 'DEFINITELY_NOT_ROLLED_BACK', errorCode: 'WORDPRESS_ROLLBACK_REJECTED' };
    }
  }

  private toDraftCommand(command: PublicationAdapterCommand): WordPressPageDraftCommand {
    const preview = this.toDraftPreview(command);
    return {
      publicationId: command.publicationId,
      idempotencyKey: command.idempotencyKey,
      authorizationReference: command.secretValue,
      packageChecksum: command.channelPackage.packageChecksum,
      artifact: {
        artifactId: command.channelPackage.artifact.artifactId,
        artifactRevisionId: command.channelPackage.artifact.artifactRevisionId,
        revision: command.channelPackage.artifact.revision,
        contentHash: command.channelPackage.artifact.contentHash,
      },
      target: preview.target,
      document: preview.document,
      files: { ...command.payload.files },
      assetRefs: [...command.channelPackage.manifest.assetRefs],
      media: [],
    };
  }

  private toDraftPreview(command: PublicationAdapterPreviewCommand): {
    target: WordPressPageDraftCommand['target'];
    document: WordPressPageDraftCommand['document'];
  } {
    const target = decodeWordPressDraftTarget(command.target);
    const structuredData = parseStructuredData(command.payload.files['structured-data.json']);
    const destination = target.destination;
    return {
      target: {
        siteOrigin: target.siteUrl,
        contentKind: destination.kind,
        slug: destination.slug,
        ...('categoryIds' in destination ? { categoryIds: [...destination.categoryIds] } : {}),
        ...(destination.operation === 'UPDATE' ? { remoteId: destination.remoteId } : {}),
      },
      document: {
        title: structuredData.headline,
        summary: structuredData.abstract,
      },
    };
  }
}

function parseStructuredData(value: string): { headline: string; abstract: string } {
  const parsed = JSON.parse(value) as unknown;
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !('headline' in parsed) ||
    !('abstract' in parsed) ||
    typeof parsed.headline !== 'string' ||
    typeof parsed.abstract !== 'string' ||
    parsed.headline.trim().length === 0 ||
    parsed.abstract.trim().length === 0
  ) {
    throw new Error('WORDPRESS_DOCUMENT_METADATA_INVALID');
  }
  return { headline: parsed.headline, abstract: parsed.abstract };
}

function toGenericResult(
  result: WordPressPageDraftPublishResult,
): PublicationAdapterPublishResult | PublicationAdapterReconcileResult {
  if (result.outcome !== 'APPLIED') return { outcome: result.outcome, errorCode: result.errorCode };
  const remoteState: PublicationRemoteState = {
    status: 'DRAFT',
    number: result.remoteId,
    isProductionLive: false,
    rollbackHandle: { ...result.rollbackHandle },
  };
  return { outcome: 'APPLIED', remoteRef: result.remoteRef, remoteState };
}
