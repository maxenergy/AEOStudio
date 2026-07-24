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
  decodeShopifyDraftTarget,
  shopifyAuthorizationTargetFor,
  shopifyRequiredScopesFor,
} from '@aeostudio/contracts/channels';
import type { PublicationRemoteState } from '@aeostudio/domain/channels-publishing';

import type {
  ShopifyDraftCommand,
  ShopifyDraftPublicationAdapter,
  ShopifyDraftPublishResult,
  ShopifyDraftRollbackHandle,
} from './shopify-draft-publication-adapter.js';

const SHOPIFY_PACKAGE_INVALID = 'SHOPIFY_PACKAGE_INVALID';
const SHOPIFY_API_VERSION_UNSUPPORTED = 'SHOPIFY_API_VERSION_UNSUPPORTED';
const SHOPIFY_TARGET_INVALID = 'SHOPIFY_TARGET_INVALID';
const SHOPIFY_RUNTIME_REJECTED = 'SHOPIFY_RUNTIME_REJECTED';
const SHOPIFY_ROLLBACK_REJECTED = 'SHOPIFY_ROLLBACK_REJECTED';
const DEFAULT_ARTICLE_AUTHOR = 'AEO Studio Publisher';

export interface ShopifyDraftRuntimeAdapterOptions {
  adapterKey: string;
  adapterVersion: string;
  descriptor: Omit<PublicationAdapterDescriptor, 'adapterKey' | 'adapterVersion'>;
  providerApiVersion: string;
  supportedStableApiVersions: string[];
  draftAdapter: ShopifyDraftPublicationAdapter;
}

/** Bridges the generic publication runtime to the capability-limited Shopify draft Adapter. */
export class ShopifyDraftRuntimeAdapter implements PublicationAdapter {
  readonly adapterKey: string;
  readonly adapterVersion: string;

  private readonly descriptor: Omit<PublicationAdapterDescriptor, 'adapterKey' | 'adapterVersion'>;
  private readonly providerApiVersion: string;
  private readonly supportedStableApiVersions: ReadonlySet<string>;
  private readonly draftAdapter: ShopifyDraftPublicationAdapter;
  private readonly runtimeConfigurationValid: boolean;

  constructor(options: ShopifyDraftRuntimeAdapterOptions) {
    this.adapterKey = options.adapterKey;
    this.adapterVersion = options.adapterVersion;
    this.descriptor = structuredClone(options.descriptor);
    this.providerApiVersion = options.providerApiVersion;
    this.supportedStableApiVersions = new Set(options.supportedStableApiVersions);
    this.draftAdapter = options.draftAdapter;
    this.runtimeConfigurationValid = this.validateRuntimeConfiguration();
  }

  describe(): PublicationAdapterDescriptor {
    return {
      adapterKey: this.adapterKey,
      adapterVersion: this.adapterVersion,
      ...structuredClone(this.descriptor),
      providerApiVersion: this.providerApiVersion,
    };
  }

  authorizationTargetFor(publicationTarget: string): string {
    this.requireSupportedTarget(publicationTarget);
    return shopifyAuthorizationTargetFor(publicationTarget);
  }

  requiredScopesFor(input: {
    target: string;
    channelPackage: PublicationAdapterCommand['channelPackage'];
  }): string[] {
    this.requireSupportedTarget(input.target);
    return shopifyRequiredScopesFor(input.target);
  }

  async validateAuthorization(
    command: PublicationAdapterCommand,
  ): Promise<PublicationAdapterAuthorizationResult> {
    if (command.secretValue.length === 0) return { outcome: 'INVALID' };
    try {
      this.requireSupportedTarget(command.target);
      const result = await this.draftAdapter.validateAuthorization(this.toDraftCommand(command));
      if (result.outcome === 'VALID') return { outcome: 'VALID' };
      if (result.errorCode === 'SHOPIFY_SCOPE_INSUFFICIENT') {
        return { outcome: 'INVALID', reason: 'SCOPE_INSUFFICIENT' };
      }
      if (
        result.errorCode === 'SHOPIFY_DOMAIN_NOT_ALLOWED' ||
        result.errorCode === 'SHOPIFY_SHOP_MISMATCH' ||
        result.errorCode === 'SHOPIFY_API_VERSION_UNSUPPORTED'
      ) {
        return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
      }
      return { outcome: 'INVALID' };
    } catch (error) {
      return runtimeInputErrorCode(error) === SHOPIFY_TARGET_INVALID ||
        runtimeInputErrorCode(error) === SHOPIFY_API_VERSION_UNSUPPORTED
        ? { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' }
        : { outcome: 'INVALID' };
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
    try {
      return toGenericResult(await this.draftAdapter.publish(this.toDraftCommand(command)));
    } catch (error) {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: runtimeInputErrorCode(error) };
    }
  }

  async reconcile(command: PublicationAdapterCommand): Promise<PublicationAdapterReconcileResult> {
    try {
      return toGenericResult(await this.draftAdapter.reconcile(this.toDraftCommand(command)));
    } catch (error) {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: runtimeInputErrorCode(error) };
    }
  }

  async rollback(
    command: PublicationAdapterRollbackCommand,
  ): Promise<PublicationAdapterRollbackResult> {
    try {
      const draftCommand = this.toDraftCommand(command);
      const rollbackHandle = rollbackHandleFromRemoteRef(command.target, command.remoteRef);
      if (rollbackHandle === null) {
        return {
          outcome: 'DEFINITELY_NOT_ROLLED_BACK',
          errorCode: SHOPIFY_ROLLBACK_REJECTED,
        };
      }
      const result = await this.draftAdapter.rollback({ ...draftCommand, rollbackHandle });
      if (result.outcome === 'ROLLED_BACK') {
        return { outcome: 'ROLLED_BACK', remoteRef: result.remoteRef };
      }
      return { outcome: result.outcome, errorCode: safeAdapterErrorCode(result.errorCode) };
    } catch {
      return {
        outcome: 'DEFINITELY_NOT_ROLLED_BACK',
        errorCode: SHOPIFY_ROLLBACK_REJECTED,
      };
    }
  }

  private toDraftCommand(command: PublicationAdapterCommand): ShopifyDraftCommand {
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
      files: preview.files,
    };
  }

  private toDraftPreview(command: PublicationAdapterPreviewCommand): {
    target: ShopifyDraftCommand['target'];
    document: ShopifyDraftCommand['document'];
    files: ShopifyDraftCommand['files'];
  } {
    const target = this.requireSupportedTarget(command.target);
    const files = parseGenericPackage(command.payload.files);
    const document = parseStructuredData(files['structured-data.json']);
    const destination = target.destination;
    let draftTarget: ShopifyDraftCommand['target'];
    switch (destination.kind) {
      case 'PAGE':
        draftTarget = {
          shopDomain: target.shopDomain,
          contentKind: 'PAGE',
          handle: destination.handle,
          ...(destination.operation === 'UPDATE' ? { remoteId: destination.remoteId } : {}),
        };
        break;
      case 'BLOG_ARTICLE':
        draftTarget = {
          shopDomain: target.shopDomain,
          contentKind: 'BLOG_ARTICLE',
          handle: destination.handle,
          blogId: destination.blogId,
          articleAuthor: { name: DEFAULT_ARTICLE_AUTHOR },
          ...(destination.operation === 'UPDATE' ? { remoteId: destination.remoteId } : {}),
        };
        break;
      case 'PRODUCT':
        draftTarget = {
          shopDomain: target.shopDomain,
          contentKind: 'PRODUCT',
          handle: destination.handle,
          ...(destination.operation === 'UPDATE' ? { remoteId: destination.remoteId } : {}),
        };
        break;
    }
    return { target: draftTarget, document, files };
  }

  private requireSupportedTarget(targetValue: string): ReturnType<typeof decodeShopifyDraftTarget> {
    let target: ReturnType<typeof decodeShopifyDraftTarget>;
    try {
      target = decodeShopifyDraftTarget(targetValue);
    } catch {
      throw new Error(SHOPIFY_TARGET_INVALID);
    }
    if (
      !this.runtimeConfigurationValid ||
      !isStableAdminApiVersion(target.apiVersion) ||
      target.apiVersion !== this.providerApiVersion ||
      !this.supportedStableApiVersions.has(target.apiVersion)
    ) {
      throw new Error(SHOPIFY_API_VERSION_UNSUPPORTED);
    }
    return target;
  }

  private validateRuntimeConfiguration(): boolean {
    try {
      const draftDescriptor = this.draftAdapter.describe();
      return (
        isStableAdminApiVersion(this.providerApiVersion) &&
        this.supportedStableApiVersions.has(this.providerApiVersion) &&
        [...this.supportedStableApiVersions].every(isStableAdminApiVersion) &&
        draftDescriptor.adapterKey === this.adapterKey &&
        draftDescriptor.adapterVersion === this.adapterVersion &&
        draftDescriptor.providerApiVersion === this.providerApiVersion
      );
    } catch {
      return false;
    }
  }
}

function parseGenericPackage(
  files: PublicationAdapterPreviewCommand['payload']['files'],
): ShopifyDraftCommand['files'] {
  const contentMarkdown = files['content.md'];
  const contentHtml = files['content.html'];
  const structuredData = files['structured-data.json'];
  if (
    typeof contentMarkdown !== 'string' ||
    contentMarkdown.trim().length === 0 ||
    typeof contentHtml !== 'string' ||
    contentHtml.trim().length === 0 ||
    typeof structuredData !== 'string' ||
    structuredData.trim().length === 0
  ) {
    throw new Error(SHOPIFY_PACKAGE_INVALID);
  }
  return {
    'content.md': contentMarkdown,
    'content.html': contentHtml,
    'structured-data.json': structuredData,
  };
}

function parseStructuredData(value: string): ShopifyDraftCommand['document'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(SHOPIFY_PACKAGE_INVALID);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(SHOPIFY_PACKAGE_INVALID);
  }
  const data = parsed as Record<string, unknown>;
  if (
    typeof data.headline !== 'string' ||
    typeof data.abstract !== 'string' ||
    data.headline.trim().length === 0 ||
    data.abstract.trim().length === 0
  ) {
    throw new Error(SHOPIFY_PACKAGE_INVALID);
  }
  return { title: data.headline, summary: data.abstract };
}

function toGenericResult(
  result: ShopifyDraftPublishResult,
): PublicationAdapterPublishResult | PublicationAdapterReconcileResult {
  if (result.outcome !== 'APPLIED') {
    return { outcome: result.outcome, errorCode: safeAdapterErrorCode(result.errorCode) };
  }
  const remoteState: PublicationRemoteState = {
    status: result.status,
    number: null,
    isProductionLive: false,
    rollbackHandle: {
      operation: 'DELETE_UNPUBLISHED_CONTENT',
      shopDomain: result.rollbackHandle.shopDomain,
      contentType: result.rollbackHandle.contentKind,
      remoteGid: result.rollbackHandle.remoteId,
    },
  };
  return { outcome: 'APPLIED', remoteRef: shopAdminUrl(result.rollbackHandle), remoteState };
}

function shopAdminUrl(handle: ShopifyDraftRollbackHandle): string {
  const numericId = handle.remoteId.split('/').at(-1);
  if (numericId === undefined || !/^[1-9][0-9]*$/u.test(numericId)) {
    throw new Error(SHOPIFY_RUNTIME_REJECTED);
  }
  const resource =
    handle.contentKind === 'PAGE'
      ? 'pages'
      : handle.contentKind === 'BLOG_ARTICLE'
        ? 'articles'
        : 'products';
  return `https://${handle.shopDomain}/admin/${resource}/${numericId}`;
}

function rollbackHandleFromRemoteRef(
  targetValue: string,
  remoteRef: string,
): ShopifyDraftRollbackHandle | null {
  let target: ReturnType<typeof decodeShopifyDraftTarget>;
  let remoteUrl: URL;
  try {
    target = decodeShopifyDraftTarget(targetValue);
    remoteUrl = new URL(remoteRef);
  } catch {
    return null;
  }
  if (
    remoteUrl.protocol !== 'https:' ||
    remoteUrl.port !== '' ||
    remoteUrl.username !== '' ||
    remoteUrl.password !== '' ||
    remoteUrl.search !== '' ||
    remoteUrl.hash !== ''
  ) {
    return null;
  }
  const destination = target.destination;
  const resourcePath =
    destination.kind === 'PAGE'
      ? 'pages'
      : destination.kind === 'BLOG_ARTICLE'
        ? 'articles'
        : 'products';
  const prefix = `/admin/${resourcePath}/`;
  if (remoteUrl.hostname !== target.shopDomain) return null;
  if (!remoteUrl.pathname.startsWith(prefix)) return null;
  const numericId = remoteUrl.pathname.slice(prefix.length);
  if (!/^[1-9][0-9]*$/u.test(numericId)) return null;
  const resource =
    destination.kind === 'PAGE'
      ? 'Page'
      : destination.kind === 'BLOG_ARTICLE'
        ? 'Article'
        : 'Product';
  const remoteId = `gid://shopify/${resource}/${numericId}`;
  if (destination.operation === 'UPDATE' && destination.remoteId !== remoteId) return null;
  return {
    operation: 'UNPUBLISH_DELETE_DRAFT',
    shopDomain: target.shopDomain,
    contentKind: destination.kind,
    remoteId,
  };
}

function runtimeInputErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return SHOPIFY_RUNTIME_REJECTED;
  switch (error.message) {
    case SHOPIFY_PACKAGE_INVALID:
    case SHOPIFY_API_VERSION_UNSUPPORTED:
    case SHOPIFY_TARGET_INVALID:
      return error.message;
    default:
      return SHOPIFY_RUNTIME_REJECTED;
  }
}

function safeAdapterErrorCode(value: string): string {
  return /^SHOPIFY_[A-Z0-9_]{1,112}$/u.test(value) ? value : SHOPIFY_RUNTIME_REJECTED;
}

function isStableAdminApiVersion(value: string): boolean {
  return /^20[0-9]{2}-(?:01|04|07|10)$/u.test(value);
}
