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
  PublicationAdapterReconcileCommand,
  PublicationAdapterReconcileResult,
  PublicationAdapterReconciliationIntent,
  PublicationAdapterRollbackCommand,
  PublicationAdapterRollbackResult,
} from '@aeostudio/application/channels-publishing';
import {
  decodeWordPressDraftTarget,
  decodeWordPressSiteAuthorizationTarget,
  wordpressAuthorizationTargetFor,
  wordpressRequiredScopesFor,
  type WordPressDraftTargetV1,
} from '@aeostudio/contracts/channels';

export const AEOSTUDIO_WORDPRESS_PUBLICATION_META_KEY = 'aeostudio_publication' as const;
const AEOSTUDIO_WORDPRESS_PUBLICATION_MARKER_PREFIX = '<!-- aeostudio-publication:v1 ' as const;
const AEOSTUDIO_WORDPRESS_PUBLICATION_MARKER_SUFFIX = ' -->' as const;
// Reconciliation and rollback read back at most 512 KiB; reserve provider-response headroom.
const MAX_WORDPRESS_DRAFT_REQUEST_BYTES = 384 * 1_024;

export interface AeoStudioWordPressPublicationMetadataV1 {
  schemaVersion: 'aeostudio.wordpress-publication.v1';
  intent: string;
  revision: {
    artifactRevisionId: string;
    number: number;
    contentHash: string;
  };
  checksum: string;
}

export interface SafeWordPressJsonHttpRequest {
  url: string;
  method: 'GET' | 'POST' | 'DELETE';
  headers: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface SafeWordPressJsonHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * This boundary must perform fresh DNS resolution, public-address validation, address pinning,
 * TLS hostname verification, redirect rejection, and response-size enforcement.
 */
export interface SafeWordPressJsonHttpClient {
  request(input: SafeWordPressJsonHttpRequest): Promise<SafeWordPressJsonHttpResponse>;
}

export interface ProductionWordPressWooCommerceDraftPublicationAdapterOptions {
  descriptor: PublicationAdapterDescriptor;
  httpClient: SafeWordPressJsonHttpClient;
}

interface WordPressCredentialV1 {
  siteUrl: string;
  authMode: WordPressDraftTargetV1['authMode'];
  scopes: string[];
  authorizationHeader: string;
}

interface PreparedCommand {
  target: WordPressDraftTargetV1;
  credential: WordPressCredentialV1;
  route: WordPressRoute;
  metadata: AeoStudioWordPressPublicationMetadataV1;
  title: string;
  content: string;
}

interface WordPressRoute {
  collectionPath: '/wp-json/wp/v2/pages' | '/wp-json/wp/v2/posts' | '/wp-json/wc/v3/products';
}

interface RemoteOwnedObject {
  id: number;
  status: string;
  slug: string;
  title: string;
  content: string;
  categoryIds: number[];
  metadata: AeoStudioWordPressPublicationMetadataV1;
}

interface RemoteDraft extends RemoteOwnedObject {
  status: 'draft';
}

export class ProductionWordPressWooCommerceDraftPublicationAdapter implements PublicationAdapter {
  readonly adapterKey: string;
  readonly adapterVersion: string;

  private readonly descriptor: PublicationAdapterDescriptor;

  constructor(
    private readonly options: ProductionWordPressWooCommerceDraftPublicationAdapterOptions,
  ) {
    this.descriptor = structuredClone(options.descriptor);
    this.adapterKey = this.descriptor.adapterKey;
    this.adapterVersion = this.descriptor.adapterVersion;
  }

  describe(): PublicationAdapterDescriptor {
    return structuredClone(this.descriptor);
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

  async validateChannelAuthorization(
    input: ChannelAuthorizationValidationInput,
  ): Promise<ChannelAuthorizationValidationResult> {
    let target: ReturnType<typeof decodeWordPressSiteAuthorizationTarget>;
    let credential: WordPressCredentialV1;
    try {
      target = decodeWordPressSiteAuthorizationTarget(input.target);
      credential = parseCredential(input.secretValue);
    } catch {
      return { outcome: 'INVALID', reason: 'CREDENTIAL_INVALID' };
    }
    if (input.acceptedTermsVersion !== this.descriptor.termsVersion) {
      return { outcome: 'INVALID', reason: 'TERMS_MISMATCH' };
    }
    if (credential.siteUrl !== target.siteUrl || credential.authMode !== target.authMode) {
      return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
    }
    try {
      const response = await this.options.httpClient.request({
        method: 'GET',
        url: `${target.siteUrl}/wp-json/wp/v2/users/me?context=edit`,
        headers: requestHeaders(credential.authorizationHeader),
        body: undefined,
        timeoutMs: 10_000,
        maxResponseBytes: 256 * 1_024,
      });
      if (response.status === 401 || response.status === 403) {
        return { outcome: 'INVALID', reason: 'CREDENTIAL_INVALID' };
      }
      if (response.status !== 200) return { outcome: 'UNKNOWN' };
      const capabilities =
        isRecord(response.body) && isRecord(response.body.capabilities)
          ? response.body.capabilities
          : null;
      if (capabilities === null) {
        return { outcome: 'INVALID', reason: 'SCOPE_INSUFFICIENT' };
      }
      const actualScopes = [
        capabilities.upload_files === true ? 'media:write' : null,
        capabilities.edit_pages === true ? 'pages:write' : null,
        capabilities.edit_posts === true ? 'posts:write' : null,
        capabilities.edit_products === true ? 'woocommerce:products:write' : null,
      ].filter((scope): scope is string => scope !== null);
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
    try {
      prepareCommand(command);
    } catch (error) {
      return {
        outcome: 'INVALID',
        reason:
          error instanceof Error && error.message === 'WORDPRESS_SCOPE_INSUFFICIENT'
            ? 'SCOPE_INSUFFICIENT'
            : 'TARGET_NOT_ALLOWED',
      };
    }
    const providerValidation = await this.validateChannelAuthorization({
      tenantId: command.channelPackage.tenantId,
      workspaceId: command.channelPackage.workspaceId,
      channelDefinitionId: command.channelPackage.channel.definitionId,
      target: this.authorizationTargetFor(command.target),
      requestedScopes: this.requiredScopesFor({
        target: command.target,
        channelPackage: command.channelPackage,
      }),
      acceptedTermsVersion: this.descriptor.termsVersion,
      secretValue: command.secretValue,
    });
    return publicationAuthorizationFromProviderValidation(providerValidation);
  }

  preview(command: PublicationAdapterPreviewCommand): PublicationAdapterPreviewResult {
    decodeWordPressDraftTarget(command.target);
    return {
      packageChecksum: command.channelPackage.packageChecksum,
      files: { ...command.payload.files },
    };
  }

  async publish(command: PublicationAdapterCommand): Promise<PublicationAdapterPublishResult> {
    // Provider capabilities are re-read by validateAuthorization in the Worker immediately before
    // its lease fence. prepareCommand repeats the local target/scope envelope checks without a
    // second provider request.
    let prepared: PreparedCommand;
    let remoteWriteStarted = false;
    try {
      prepared = prepareCommand(command);
    } catch (error) {
      return definitelyNotApplied(error);
    }
    if (
      new TextEncoder().encode(JSON.stringify(createDraftBody(prepared))).byteLength >
      MAX_WORDPRESS_DRAFT_REQUEST_BYTES
    ) {
      return {
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'WORDPRESS_DRAFT_REQUEST_TOO_LARGE',
      };
    }

    try {
      const existing = await this.findDraft(prepared);
      if (existing.outcome === 'MATCH') return applied(prepared, existing.draft);
      if (existing.outcome !== 'NOT_FOUND') {
        return { outcome: 'AMBIGUOUS', errorCode: 'WORDPRESS_REMOTE_EFFECT_CONFLICT' };
      }
      remoteWriteStarted = true;
      const response = await this.options.httpClient.request({
        method: 'POST',
        url: `${prepared.target.siteUrl}${prepared.route.collectionPath}`,
        headers: requestHeaders(prepared.credential.authorizationHeader),
        body: createDraftBody(prepared),
        timeoutMs: 10_000,
        maxResponseBytes: 512 * 1024,
      });
      const created = parseRemoteOwnedObject(response.body, prepared.target.destination.kind);
      if (response.status !== 201 || created === null || !sameOwnedObject(created, prepared)) {
        return { outcome: 'AMBIGUOUS', errorCode: 'WORDPRESS_DRAFT_CREATE_RESULT_UNKNOWN' };
      }
      if (created.status !== 'draft') {
        const reconciliationIntent: PublicationAdapterReconciliationIntent = {
          kind: 'COMPENSATE_UNSAFE_CREATE',
          remoteRef: adminRemoteRef(prepared, created.id),
        };
        try {
          const rollback = await this.options.httpClient.request({
            method: 'DELETE',
            url:
              `${prepared.target.siteUrl}${prepared.route.collectionPath}/${String(created.id)}` +
              '?force=false',
            headers: requestHeaders(prepared.credential.authorizationHeader),
            body: undefined,
            timeoutMs: 10_000,
            maxResponseBytes: 512 * 1024,
          });
          return rollback.status === 200 &&
            isRecord(rollback.body) &&
            rollback.body.id === created.id &&
            rollback.body.status === 'trash'
            ? {
                outcome: 'DEFINITELY_NOT_APPLIED',
                errorCode: 'WORDPRESS_NON_DRAFT_ROLLED_BACK',
              }
            : {
                outcome: 'AMBIGUOUS',
                errorCode: 'WORDPRESS_NON_DRAFT_ROLLBACK_UNKNOWN',
                reconciliationIntent,
              };
        } catch {
          return {
            outcome: 'AMBIGUOUS',
            errorCode: 'WORDPRESS_NON_DRAFT_ROLLBACK_UNKNOWN',
            reconciliationIntent,
          };
        }
      }
      const draft: RemoteDraft = { ...created, status: 'draft' };
      return applied(prepared, draft);
    } catch {
      return remoteWriteStarted
        ? { outcome: 'AMBIGUOUS', errorCode: 'WORDPRESS_REMOTE_WRITE_RESULT_UNKNOWN' }
        : { outcome: 'RETRYABLE_FAILURE', errorCode: 'WORDPRESS_PROVIDER_UNAVAILABLE' };
    }
  }

  async reconcile(
    command: PublicationAdapterReconcileCommand,
  ): Promise<PublicationAdapterReconcileResult> {
    let prepared: PreparedCommand;
    try {
      prepared = prepareCommand(command);
    } catch (error) {
      return definitelyNotApplied(error);
    }
    try {
      const result = await this.findDraft(prepared);
      if (result.outcome === 'MATCH') return applied(prepared, result.draft);
      if (result.outcome === 'NON_DRAFT_MATCH') {
        if (
          compensationRemoteId(command.reconciliationIntent, prepared.target.siteUrl) !==
          result.object.id
        ) {
          return { outcome: 'AMBIGUOUS', errorCode: 'WORDPRESS_REMOTE_EFFECT_CONFLICT' };
        }
        try {
          const response = await this.options.httpClient.request({
            method: 'DELETE',
            url:
              `${prepared.target.siteUrl}${prepared.route.collectionPath}/` +
              `${String(result.object.id)}?force=false`,
            headers: requestHeaders(prepared.credential.authorizationHeader),
            body: undefined,
            timeoutMs: 10_000,
            maxResponseBytes: 512 * 1024,
          });
          return response.status === 200 &&
            isRecord(response.body) &&
            response.body.id === result.object.id &&
            response.body.status === 'trash'
            ? {
                outcome: 'DEFINITELY_NOT_APPLIED',
                errorCode: 'WORDPRESS_NON_DRAFT_ROLLED_BACK',
              }
            : { outcome: 'AMBIGUOUS', errorCode: 'WORDPRESS_NON_DRAFT_ROLLBACK_UNKNOWN' };
        } catch {
          return { outcome: 'AMBIGUOUS', errorCode: 'WORDPRESS_NON_DRAFT_ROLLBACK_UNKNOWN' };
        }
      }
      if (result.outcome === 'TRASHED_MATCH') {
        return {
          outcome: 'DEFINITELY_NOT_APPLIED',
          errorCode: 'WORDPRESS_REMOTE_EFFECT_NOT_FOUND',
        };
      }
      return result.outcome === 'NOT_FOUND'
        ? { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'WORDPRESS_REMOTE_EFFECT_NOT_FOUND' }
        : { outcome: 'AMBIGUOUS', errorCode: 'WORDPRESS_REMOTE_EFFECT_CONFLICT' };
    } catch {
      return { outcome: 'AMBIGUOUS', errorCode: 'WORDPRESS_RECONCILIATION_UNAVAILABLE' };
    }
  }

  async rollback(
    command: PublicationAdapterRollbackCommand,
  ): Promise<PublicationAdapterRollbackResult> {
    let prepared: PreparedCommand;
    let remoteId: number;
    try {
      prepared = prepareCommand(command);
      remoteId = remoteIdFromAdminRef(command.remoteRef, prepared.target.siteUrl);
    } catch {
      return {
        outcome: 'DEFINITELY_NOT_ROLLED_BACK',
        errorCode: 'WORDPRESS_ROLLBACK_TARGET_INVALID',
      };
    }
    const objectUrl = `${prepared.target.siteUrl}${prepared.route.collectionPath}/${String(remoteId)}`;
    try {
      const lookup = await this.options.httpClient.request({
        method: 'GET',
        url: `${objectUrl}?context=edit`,
        headers: requestHeaders(prepared.credential.authorizationHeader),
        body: undefined,
        timeoutMs: 10_000,
        maxResponseBytes: 512 * 1024,
      });
      if (lookup.status === 404 || lookup.status === 410) {
        return { outcome: 'ROLLED_BACK', remoteRef: command.remoteRef };
      }
      const ownedObject = parseRemoteOwnedObject(lookup.body, prepared.target.destination.kind);
      if (
        lookup.status !== 200 ||
        ownedObject === null ||
        ownedObject.id !== remoteId ||
        !sameOwnedObject(ownedObject, prepared)
      ) {
        return {
          outcome: 'DEFINITELY_NOT_ROLLED_BACK',
          errorCode: 'WORDPRESS_ROLLBACK_OWNERSHIP_MISMATCH',
        };
      }
      if (ownedObject.status === 'trash') {
        return { outcome: 'ROLLED_BACK', remoteRef: command.remoteRef };
      }
      if (ownedObject.status !== 'draft') {
        return {
          outcome: 'DEFINITELY_NOT_ROLLED_BACK',
          errorCode: 'WORDPRESS_ROLLBACK_TARGET_NOT_DRAFT',
        };
      }
      const response = await this.options.httpClient.request({
        method: 'DELETE',
        url: `${objectUrl}?force=false`,
        headers: requestHeaders(prepared.credential.authorizationHeader),
        body: undefined,
        timeoutMs: 10_000,
        maxResponseBytes: 512 * 1024,
      });
      if (
        response.status !== 200 ||
        !isRecord(response.body) ||
        response.body.id !== remoteId ||
        response.body.status !== 'trash'
      ) {
        return { outcome: 'UNKNOWN', errorCode: 'WORDPRESS_ROLLBACK_RESULT_UNKNOWN' };
      }
      return { outcome: 'ROLLED_BACK', remoteRef: command.remoteRef };
    } catch {
      return { outcome: 'UNKNOWN', errorCode: 'WORDPRESS_ROLLBACK_UNAVAILABLE' };
    }
  }

  private async findDraft(
    prepared: PreparedCommand,
  ): Promise<
    | { outcome: 'MATCH'; draft: RemoteDraft }
    | { outcome: 'NON_DRAFT_MATCH'; object: RemoteOwnedObject }
    | { outcome: 'TRASHED_MATCH' }
    | { outcome: 'NOT_FOUND' }
    | { outcome: 'CONFLICT' }
  > {
    const response = await this.options.httpClient.request({
      method: 'GET',
      url:
        `${prepared.target.siteUrl}${prepared.route.collectionPath}` +
        `?slug=${encodeURIComponent(prepared.target.destination.slug)}` +
        '&status=any&context=edit&per_page=100',
      headers: requestHeaders(prepared.credential.authorizationHeader),
      body: undefined,
      timeoutMs: 10_000,
      maxResponseBytes: 512 * 1024,
    });
    if (response.status !== 200 || !Array.isArray(response.body)) {
      return { outcome: 'CONFLICT' };
    }
    if (response.body.length === 0) return { outcome: 'NOT_FOUND' };
    const candidates = response.body
      .map((value) => parseRemoteOwnedObject(value, prepared.target.destination.kind))
      .filter((value): value is RemoteOwnedObject => value !== null);
    if (candidates.length !== response.body.length) return { outcome: 'CONFLICT' };
    const matches = candidates.filter((candidate) => sameOwnedObject(candidate, prepared));
    if (matches.length === 1 && candidates.length === 1) {
      const match = matches[0];
      if (match === undefined) return { outcome: 'CONFLICT' };
      if (match.status === 'draft') {
        return { outcome: 'MATCH', draft: { ...match, status: 'draft' } };
      }
      return match.status === 'trash'
        ? { outcome: 'TRASHED_MATCH' }
        : { outcome: 'NON_DRAFT_MATCH', object: match };
    }
    return { outcome: 'CONFLICT' };
  }
}

function publicationAuthorizationFromProviderValidation(
  result: ChannelAuthorizationValidationResult,
): PublicationAdapterAuthorizationResult {
  if (result.outcome === 'VERIFIED') return { outcome: 'VALID' };
  if (result.outcome === 'UNKNOWN') return { outcome: 'UNKNOWN' };
  return {
    outcome: 'INVALID',
    reason: result.reason === 'SCOPE_INSUFFICIENT' ? 'SCOPE_INSUFFICIENT' : 'TARGET_NOT_ALLOWED',
  };
}

function prepareCommand(command: PublicationAdapterCommand): PreparedCommand {
  const target = decodeWordPressDraftTarget(command.target);
  if (target.destination.operation !== 'CREATE') throw new Error('WORDPRESS_UPDATE_UNSUPPORTED');
  if (command.channelPackage.manifest.assetRefs.length > 0) {
    throw new Error('WORDPRESS_ASSET_RESOLVER_UNAVAILABLE');
  }
  const credential = parseCredential(command.secretValue);
  if (credential.siteUrl !== target.siteUrl || credential.authMode !== target.authMode) {
    throw new Error('WORDPRESS_CREDENTIAL_TARGET_MISMATCH');
  }
  const requiredScopes = wordpressRequiredScopesFor({
    target: command.target,
    assetRefs: command.channelPackage.manifest.assetRefs,
  });
  if (!sameStringArray(credential.scopes, requiredScopes)) {
    throw new Error('WORDPRESS_SCOPE_INSUFFICIENT');
  }
  const document = parseDocument(command.payload.files['structured-data.json']);
  const metadata = metadataFor(command);
  return {
    target,
    credential,
    route: routeFor(target.destination.kind),
    metadata,
    title: document.headline,
    content: composeContent(command.payload.files, metadata),
  };
}

function parseCredential(secretValue: string): WordPressCredentialV1 {
  let value: unknown;
  try {
    value = JSON.parse(secretValue) as unknown;
  } catch {
    throw new Error('WORDPRESS_CREDENTIAL_INVALID');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'siteUrl',
      'authMode',
      'scopes',
      'authorizationHeader',
    ]) ||
    value.schemaVersion !== 'aeostudio.wordpress-credential.v1' ||
    typeof value.siteUrl !== 'string' ||
    typeof value.authMode !== 'string' ||
    !['OAUTH', 'APPLICATION_PASSWORD', 'APPROVED_TOKEN'].includes(value.authMode) ||
    !Array.isArray(value.scopes) ||
    value.scopes.some((scope) => typeof scope !== 'string') ||
    typeof value.authorizationHeader !== 'string'
  ) {
    throw new Error('WORDPRESS_CREDENTIAL_INVALID');
  }
  const scopes = value.scopes as string[];
  if (
    scopes.length === 0 ||
    scopes.length > 16 ||
    !sameStringArray(
      scopes,
      [...new Set(scopes)].sort((left, right) => left.localeCompare(right)),
    ) ||
    scopes.some((scope) => !/^[a-z][a-z0-9-]{0,63}(?::[a-z][a-z0-9-]{0,63})+$/u.test(scope)) ||
    value.authorizationHeader.length === 0 ||
    value.authorizationHeader.length > 4_096 ||
    hasControlCharacter(value.authorizationHeader) ||
    !validAuthorizationHeader(
      value.authMode as WordPressCredentialV1['authMode'],
      value.authorizationHeader,
    )
  ) {
    throw new Error('WORDPRESS_CREDENTIAL_INVALID');
  }
  return {
    siteUrl: value.siteUrl,
    authMode: value.authMode as WordPressCredentialV1['authMode'],
    scopes: [...scopes],
    authorizationHeader: value.authorizationHeader,
  };
}

function parseDocument(value: string): { headline: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('WORDPRESS_PACKAGE_INVALID');
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.headline !== 'string' ||
    parsed.headline.trim().length === 0 ||
    parsed.headline.length > 500
  ) {
    throw new Error('WORDPRESS_PACKAGE_INVALID');
  }
  return { headline: parsed.headline };
}

function composeContent(
  files: PublicationAdapterCommand['payload']['files'],
  metadata: AeoStudioWordPressPublicationMetadataV1,
): string {
  if (
    Buffer.byteLength(files['content.html'], 'utf8') > 10 * 1024 * 1024 ||
    Buffer.byteLength(files['structured-data.json'], 'utf8') > 256 * 1024 ||
    files['content.html'].includes(AEOSTUDIO_WORDPRESS_PUBLICATION_MARKER_PREFIX) ||
    files['structured-data.json'].includes(AEOSTUDIO_WORDPRESS_PUBLICATION_MARKER_PREFIX)
  ) {
    throw new Error('WORDPRESS_PACKAGE_INVALID');
  }
  const jsonLd = files['structured-data.json']
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  const marker = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url');
  return (
    `${files['content.html']}<script type="application/ld+json">${jsonLd}</script>` +
    `${AEOSTUDIO_WORDPRESS_PUBLICATION_MARKER_PREFIX}${marker}` +
    AEOSTUDIO_WORDPRESS_PUBLICATION_MARKER_SUFFIX
  );
}

function metadataFor(command: PublicationAdapterCommand): AeoStudioWordPressPublicationMetadataV1 {
  return {
    schemaVersion: 'aeostudio.wordpress-publication.v1',
    intent: createHash('sha256')
      .update(
        JSON.stringify({
          tenantId: command.channelPackage.tenantId,
          workspaceId: command.channelPackage.workspaceId,
          publicationId: command.publicationId,
          target: command.target,
          packageId: command.channelPackage.id,
          checksum: command.channelPackage.packageChecksum,
        }),
        'utf8',
      )
      .digest('hex'),
    revision: {
      artifactRevisionId: command.channelPackage.artifact.artifactRevisionId,
      number: command.channelPackage.artifact.revision,
      contentHash: command.channelPackage.artifact.contentHash,
    },
    checksum: command.channelPackage.packageChecksum,
  };
}

function createDraftBody(prepared: PreparedCommand): Record<string, unknown> {
  if (prepared.target.destination.kind === 'PRODUCT') {
    return {
      status: 'draft',
      slug: prepared.target.destination.slug,
      name: prepared.title,
      description: prepared.content,
      categories: prepared.target.destination.categoryIds.map((id) => ({ id })),
      meta_data: [
        {
          key: AEOSTUDIO_WORDPRESS_PUBLICATION_META_KEY,
          value: structuredClone(prepared.metadata),
        },
      ],
    };
  }
  const body: Record<string, unknown> = {
    status: 'draft',
    slug: prepared.target.destination.slug,
    title: prepared.title,
    content: prepared.content,
    meta: { [AEOSTUDIO_WORDPRESS_PUBLICATION_META_KEY]: structuredClone(prepared.metadata) },
  };
  if (prepared.target.destination.kind === 'POST') {
    body.categories = [...prepared.target.destination.categoryIds];
  }
  return body;
}

function parseRemoteOwnedObject(
  value: unknown,
  kind: WordPressDraftTargetV1['destination']['kind'],
): RemoteOwnedObject | null {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) <= 0 ||
    typeof value.status !== 'string' ||
    value.status.length === 0 ||
    value.status.length > 64 ||
    typeof value.slug !== 'string'
  ) {
    return null;
  }
  const title = readEditableString(kind === 'PRODUCT' ? value.name : value.title);
  const content = readEditableString(kind === 'PRODUCT' ? value.description : value.content);
  const embeddedMetadata = content === null ? null : metadataFromContentMarker(content);
  const metadata =
    kind === 'PRODUCT'
      ? metadataFromWooCommerce(value.meta_data)
      : metadataFromWordPressResponse(value.meta, embeddedMetadata);
  const categoryIds =
    kind === 'PAGE'
      ? []
      : kind === 'PRODUCT'
        ? readWooCommerceCategoryIds(value.categories)
        : readWordPressCategoryIds(value.categories);
  return metadata === null || title === null || content === null || categoryIds === null
    ? null
    : {
        id: value.id as number,
        status: value.status,
        slug: value.slug,
        title,
        content,
        categoryIds,
        metadata,
      };
}

function metadataFromWordPressResponse(
  meta: unknown,
  embeddedMetadata: AeoStudioWordPressPublicationMetadataV1 | null,
): AeoStudioWordPressPublicationMetadataV1 | null {
  if (embeddedMetadata === null) return null;
  if (!isRecord(meta) || !(AEOSTUDIO_WORDPRESS_PUBLICATION_META_KEY in meta)) {
    return embeddedMetadata;
  }
  const restMetadata = parseMetadata(meta[AEOSTUDIO_WORDPRESS_PUBLICATION_META_KEY]);
  return restMetadata !== null && JSON.stringify(restMetadata) === JSON.stringify(embeddedMetadata)
    ? embeddedMetadata
    : null;
}

function metadataFromContentMarker(
  content: string,
): AeoStudioWordPressPublicationMetadataV1 | null {
  const markerStart = content.lastIndexOf(AEOSTUDIO_WORDPRESS_PUBLICATION_MARKER_PREFIX);
  if (
    markerStart < 0 ||
    content.indexOf(AEOSTUDIO_WORDPRESS_PUBLICATION_MARKER_PREFIX) !== markerStart ||
    !content.endsWith(AEOSTUDIO_WORDPRESS_PUBLICATION_MARKER_SUFFIX)
  ) {
    return null;
  }
  const encodedStart = markerStart + AEOSTUDIO_WORDPRESS_PUBLICATION_MARKER_PREFIX.length;
  const encodedEnd = content.length - AEOSTUDIO_WORDPRESS_PUBLICATION_MARKER_SUFFIX.length;
  const encoded = content.slice(encodedStart, encodedEnd);
  if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
  try {
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) return null;
    return parseMetadata(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)));
  } catch {
    return null;
  }
}

function metadataFromWooCommerce(value: unknown): AeoStudioWordPressPublicationMetadataV1 | null {
  if (!Array.isArray(value)) return null;
  const candidates = value.filter(
    (entry) => isRecord(entry) && entry.key === AEOSTUDIO_WORDPRESS_PUBLICATION_META_KEY,
  );
  if (candidates.length !== 1) return null;
  return parseMetadata((candidates[0] as Record<string, unknown> | undefined)?.value);
}

function parseMetadata(value: unknown): AeoStudioWordPressPublicationMetadataV1 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'intent', 'revision', 'checksum']) ||
    value.schemaVersion !== 'aeostudio.wordpress-publication.v1' ||
    typeof value.intent !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.intent) ||
    typeof value.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.checksum) ||
    !isRecord(value.revision) ||
    !hasExactKeys(value.revision, ['artifactRevisionId', 'number', 'contentHash']) ||
    typeof value.revision.artifactRevisionId !== 'string' ||
    !Number.isSafeInteger(value.revision.number) ||
    (value.revision.number as number) <= 0 ||
    typeof value.revision.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.revision.contentHash)
  ) {
    return null;
  }
  return {
    schemaVersion: 'aeostudio.wordpress-publication.v1',
    intent: value.intent,
    revision: {
      artifactRevisionId: value.revision.artifactRevisionId,
      number: value.revision.number as number,
      contentHash: value.revision.contentHash,
    },
    checksum: value.checksum,
  };
}

function sameOwnedObject(object: RemoteOwnedObject, prepared: PreparedCommand): boolean {
  const expectedCategoryIds =
    prepared.target.destination.kind === 'PAGE' ? [] : prepared.target.destination.categoryIds;
  return (
    object.slug === prepared.target.destination.slug &&
    object.title === prepared.title &&
    object.content === prepared.content &&
    sameNumberArray(object.categoryIds, expectedCategoryIds) &&
    JSON.stringify(object.metadata) === JSON.stringify(prepared.metadata)
  );
}

function applied(
  prepared: PreparedCommand,
  draft: RemoteDraft,
): Extract<PublicationAdapterPublishResult, { outcome: 'APPLIED' }> {
  return {
    outcome: 'APPLIED',
    remoteRef: adminRemoteRef(prepared, draft.id),
    remoteState: {
      status: 'DRAFT',
      number: draft.id,
      isProductionLive: false,
      rollbackHandle: {
        operation: 'TRASH_DRAFT',
        siteUrl: prepared.target.siteUrl,
        resourcePath: prepared.route.collectionPath,
        remoteId: draft.id,
      },
    },
  };
}

function adminRemoteRef(prepared: PreparedCommand, remoteId: number): string {
  return `${prepared.target.siteUrl}/wp-admin/post.php?post=${String(remoteId)}&action=edit`;
}

function compensationRemoteId(
  intent: PublicationAdapterReconciliationIntent | undefined,
  siteUrl: string,
): number | null {
  try {
    return intent?.kind === 'COMPENSATE_UNSAFE_CREATE'
      ? remoteIdFromAdminRef(intent.remoteRef, siteUrl)
      : null;
  } catch {
    return null;
  }
}

function routeFor(kind: WordPressDraftTargetV1['destination']['kind']): WordPressRoute {
  switch (kind) {
    case 'PAGE':
      return {
        collectionPath: '/wp-json/wp/v2/pages',
      };
    case 'POST':
      return {
        collectionPath: '/wp-json/wp/v2/posts',
      };
    case 'PRODUCT':
      return {
        collectionPath: '/wp-json/wc/v3/products',
      };
  }
}

function remoteIdFromAdminRef(remoteRef: string, siteUrl: string): number {
  const remote = new URL(remoteRef);
  const site = new URL(siteUrl);
  const sitePath = site.pathname === '/' ? '' : site.pathname;
  if (
    remote.origin !== site.origin ||
    remote.pathname !== `${sitePath}/wp-admin/post.php` ||
    remote.searchParams.size !== 2 ||
    remote.searchParams.get('action') !== 'edit'
  ) {
    throw new Error('WORDPRESS_REMOTE_REF_INVALID');
  }
  const remoteIdValue = remote.searchParams.get('post');
  if (remoteIdValue === null || !/^[1-9][0-9]{0,9}$/u.test(remoteIdValue)) {
    throw new Error('WORDPRESS_REMOTE_REF_INVALID');
  }
  const remoteId = Number(remoteIdValue);
  if (!Number.isSafeInteger(remoteId) || remoteId > 2_147_483_647) {
    throw new Error('WORDPRESS_REMOTE_REF_INVALID');
  }
  return remoteId;
}

function requestHeaders(authorization: string): Record<string, string> {
  return {
    accept: 'application/json',
    authorization,
    'content-type': 'application/json',
    'user-agent': 'AEOStudio-Publication-Adapter/1.0',
  };
}

function definitelyNotApplied(error: unknown): PublicationAdapterPublishResult {
  const errorCode =
    error instanceof Error &&
    [
      'WORDPRESS_UPDATE_UNSUPPORTED',
      'WORDPRESS_ASSET_RESOLVER_UNAVAILABLE',
      'WORDPRESS_SCOPE_INSUFFICIENT',
    ].includes(error.message)
      ? error.message
      : 'WORDPRESS_AUTHORIZATION_INVALID';
  return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode };
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameNumberArray(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readEditableString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return isRecord(value) && typeof value.raw === 'string' ? value.raw : null;
}

function readWordPressCategoryIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return canonicalCategoryIds(value);
}

function readWooCommerceCategoryIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return canonicalCategoryIds(value.map((entry) => (isRecord(entry) ? entry.id : undefined)));
}

function canonicalCategoryIds(values: unknown[]): number[] | null {
  if (
    values.some(
      (value) =>
        !Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 2_147_483_647,
    )
  ) {
    return null;
  }
  const categoryIds = [...(values as number[])].sort((left, right) => left - right);
  return new Set(categoryIds).size === categoryIds.length ? categoryIds : null;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point === undefined || point <= 0x1f || point === 0x7f;
  });
}

function validAuthorizationHeader(
  authMode: WordPressCredentialV1['authMode'],
  value: string,
): boolean {
  if (authMode !== 'APPLICATION_PASSWORD') {
    const token = value.startsWith('Bearer ') ? value.slice('Bearer '.length) : '';
    return token.length > 0 && /^[A-Za-z0-9._~+/=-]+$/u.test(token);
  }
  const encoded = value.startsWith('Basic ') ? value.slice('Basic '.length) : '';
  if (
    encoded.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  ) {
    return false;
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return false;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  return separator > 0 && separator < decoded.length - 1 && !hasControlCharacter(decoded);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
