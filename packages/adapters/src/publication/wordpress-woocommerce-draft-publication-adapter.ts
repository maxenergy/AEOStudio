import { createHash } from 'node:crypto';

export {
  decodeWordPressDraftTarget,
  decodeWordPressSiteAuthorizationTarget,
  encodeWordPressDraftTarget,
  encodeWordPressSiteAuthorizationTarget,
  wordpressAuthorizationCovers,
  wordpressAuthorizationTargetFor,
  wordpressRequiredScopesFor,
  type WordPressDraftTargetV1,
  type WordPressSiteAuthorizationTargetV1,
} from '@aeostudio/contracts/channels';

export interface WordPressRevisionMapping {
  artifactId: string;
  artifactRevisionId: string;
  artifactRevision: number;
  artifactContentHash: string;
  packageChecksum: string;
}

export interface WordPressPageDraftCommand {
  publicationId: string;
  idempotencyKey: string;
  authorizationReference: string;
  packageChecksum: string;
  artifact: {
    artifactId: string;
    artifactRevisionId: string;
    revision: number;
    contentHash: string;
  };
  target: {
    siteOrigin: string;
    contentKind: 'PAGE' | 'POST' | 'PRODUCT';
    slug: string;
    categoryIds?: number[];
    remoteId?: number;
  };
  document: {
    title: string;
    summary: string;
  };
  files: {
    'content.md': string;
    'content.html': string;
    'structured-data.json': string;
  };
  assetRefs?: string[];
  media?: WordPressResolvedMediaAsset[];
}

export interface WordPressResolvedMediaAsset {
  assetRef: string;
  filename: string;
  mediaType: string;
  sha256: string;
  bytes: Uint8Array;
}

interface WordPressPageDraftObject {
  id: number;
  requestPath: '/wp-json/wp/v2/pages' | '/wp-json/wp/v2/posts' | '/wp-json/wc/v3/products';
  status: 'draft' | 'publish' | 'trash';
  slug: string;
  title: string;
  content: string;
  categoryIds?: number[];
  revisionMapping: WordPressRevisionMapping;
  remoteIntent: string;
}

interface WordPressMediaObject {
  id: number;
  requestPath: '/wp-json/wp/v2/media';
  assetRef: string;
  filename: string;
  mediaType: string;
  sha256: string;
  remoteIntent: string;
}

interface WordPressRestSchema {
  route: WordPressPageDraftObject['requestPath'];
  methods: ['GET', 'POST', 'DELETE'];
  writableFields: string[];
}

export interface FakeWordPressServerSnapshot {
  apiVersion: string;
  draftCreateCount: number;
  contentUpdateCount: number;
  publishedCreateCount: number;
  mediaCreateCount: number;
  objects: WordPressPageDraftObject[];
  media: WordPressMediaObject[];
}

export interface VersionedFakeWordPressServerOptions {
  apiVersion: string;
  siteOrigin: string;
  authorization: {
    mechanism: 'OAUTH' | 'APPLICATION_PASSWORD' | 'APPROVED_TOKEN';
    scopes: string[];
    credential: string;
  };
  woocommerceApiVersion?: 'wc/v3' | null;
  writableFields?: string[];
  log(entry: string): void;
}

interface CreatePageDraftRequest {
  method: 'POST';
  url: string;
  authorizationReference: string;
  requiredScopes: string[];
  body: {
    kind: 'CONTENT';
    status: 'draft';
    slug: string;
    title: string;
    content: string;
    categoryIds?: number[];
    revisionMapping: WordPressRevisionMapping;
    remoteIntent: string;
  };
}

interface UploadMediaRequest {
  method: 'POST';
  url: string;
  authorizationReference: string;
  requiredScopes: string[];
  body: {
    kind: 'MEDIA';
    assetRef: string;
    filename: string;
    mediaType: string;
    sha256: string;
    remoteIntent: string;
  };
}

interface ReadPageDraftRequest {
  method: 'GET' | 'DELETE' | 'OPTIONS';
  url: string;
  authorizationReference: string;
  requiredScopes: string[];
}

type WordPressFakeRequest = CreatePageDraftRequest | UploadMediaRequest | ReadPageDraftRequest;

interface WordPressFakeResponse {
  status: number;
  body:
    | WordPressPageDraftObject
    | WordPressPageDraftObject[]
    | WordPressMediaObject
    | WordPressRestSchema
    | { code: string };
}

function canonicalOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.pathname !== '/'
    ) {
      return null;
    }
    return parsed.origin === value ? value : null;
  } catch {
    return null;
  }
}

function canonicalHttpsOrigin(value: string): string | null {
  const origin = canonicalOrigin(value);
  return origin !== null && new URL(origin).protocol === 'https:' ? origin : null;
}

function isCanonicalSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) && value.length <= 200;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function revisionMappingFor(command: WordPressPageDraftCommand): WordPressRevisionMapping {
  return {
    artifactId: command.artifact.artifactId,
    artifactRevisionId: command.artifact.artifactRevisionId,
    artifactRevision: command.artifact.revision,
    artifactContentHash: command.artifact.contentHash,
    packageChecksum: command.packageChecksum,
  };
}

/**
 * Versioned in-process REST fake used only by explicit test/dev composition. It models the
 * official wp/v2 page route and deliberately keeps credential material in a private field.
 */
export class VersionedFakeWordPressServer {
  private readonly apiVersion: string;
  private readonly siteOrigin: string;
  private readonly authorization: VersionedFakeWordPressServerOptions['authorization'];
  private readonly woocommerceApiVersion: 'wc/v3' | null;
  private readonly writableFields: string[];
  private readonly log: (entry: string) => void;
  private readonly objects = new Map<number, WordPressPageDraftObject>();
  private readonly media = new Map<number, WordPressMediaObject>();
  private nextId = 1;
  private draftCreateCount = 0;
  private contentUpdateCount = 0;
  private publishedCreateCount = 0;
  private mediaCreateCount = 0;
  private nextFailure: 'PUBLISH_INSTEAD_OF_DRAFT' | 'RESPONSE_404' | 'TIMEOUT_AFTER_EFFECT' | null =
    null;

  constructor(options: VersionedFakeWordPressServerOptions) {
    const siteOrigin = canonicalOrigin(options.siteOrigin);
    if (siteOrigin === null || options.apiVersion !== 'wp/v2') {
      throw new Error('WORDPRESS_FAKE_CONFIGURATION_INVALID');
    }
    this.apiVersion = options.apiVersion;
    this.siteOrigin = siteOrigin;
    this.authorization = {
      mechanism: options.authorization.mechanism,
      scopes: [...options.authorization.scopes],
      credential: options.authorization.credential,
    };
    this.woocommerceApiVersion =
      options.woocommerceApiVersion === undefined ? 'wc/v3' : options.woocommerceApiVersion;
    this.writableFields = [
      ...(options.writableFields ?? [
        'categories',
        'content',
        'description',
        'name',
        'slug',
        'status',
        'title',
      ]),
    ];
    this.log = (entry) => options.log(entry);
  }

  request(input: WordPressFakeRequest): Promise<WordPressFakeResponse> {
    if (
      this.authorizationError({
        siteOrigin: new URL(input.url).origin,
        authorizationReference: input.authorizationReference,
        requiredScopes: input.requiredScopes,
      }) !== null
    ) {
      return Promise.resolve({ status: 403, body: { code: 'rest_forbidden' } });
    }
    const requestUrl = new URL(input.url);
    if (requestUrl.origin !== this.siteOrigin) {
      return Promise.resolve({ status: 404, body: { code: 'rest_no_route' } });
    }

    const routeMatch =
      /^(\/wp-json\/(?:wp\/v2\/(?:pages|posts|media)|wc\/v3\/products))(?:\/(\d+))?$/u.exec(
        requestUrl.pathname,
      );
    if (
      routeMatch === null ||
      (routeMatch[1] === '/wp-json/wc/v3/products' && this.woocommerceApiVersion === null)
    ) {
      return Promise.resolve({ status: 404, body: { code: 'rest_no_route' } });
    }
    const matchedPath = routeMatch[1];
    const remoteId = routeMatch[2] === undefined ? null : Number(routeMatch[2]);

    if (
      input.method === 'POST' &&
      remoteId === null &&
      matchedPath === '/wp-json/wp/v2/media' &&
      input.body.kind === 'MEDIA'
    ) {
      const object: WordPressMediaObject = {
        id: this.nextId,
        requestPath: '/wp-json/wp/v2/media',
        assetRef: input.body.assetRef,
        filename: input.body.filename,
        mediaType: input.body.mediaType,
        sha256: input.body.sha256,
        remoteIntent: input.body.remoteIntent,
      };
      this.nextId += 1;
      this.media.set(object.id, object);
      this.mediaCreateCount += 1;
      this.log(`POST /wp-json/wp/v2/media -> ${String(object.id)}`);
      return Promise.resolve({ status: 201, body: structuredClone(object) });
    }
    if (matchedPath === '/wp-json/wp/v2/media') {
      return Promise.resolve({ status: 404, body: { code: 'rest_no_route' } });
    }
    const requestPath = matchedPath as WordPressPageDraftObject['requestPath'];

    if (input.method === 'OPTIONS' && remoteId === null) {
      return Promise.resolve({
        status: 200,
        body: {
          route: requestPath,
          methods: ['GET', 'POST', 'DELETE'],
          writableFields: [...this.writableFields],
        },
      });
    }

    if (input.method === 'GET' && remoteId === null) {
      const slug = requestUrl.searchParams.get('slug');
      if (slug === null || [...requestUrl.searchParams.keys()].some((key) => key !== 'slug')) {
        return Promise.resolve({ status: 400, body: { code: 'rest_invalid_param' } });
      }
      return Promise.resolve({
        status: 200,
        body: [...this.objects.values()]
          .filter(
            (object) =>
              object.requestPath === requestPath &&
              object.slug === slug &&
              object.status !== 'trash',
          )
          .map((object) => structuredClone(object)),
      });
    }

    if (input.method === 'POST' && remoteId === null && input.body.kind === 'CONTENT') {
      const failure = this.nextFailure;
      this.nextFailure = null;
      if (failure === 'RESPONSE_404') {
        return Promise.resolve({ status: 404, body: { code: 'rest_no_route' } });
      }
      const object: WordPressPageDraftObject = {
        id: this.nextId,
        requestPath,
        status: failure === 'PUBLISH_INSTEAD_OF_DRAFT' ? 'publish' : input.body.status,
        slug: input.body.slug,
        title: input.body.title,
        content: input.body.content,
        ...(input.body.categoryIds === undefined
          ? {}
          : { categoryIds: [...input.body.categoryIds] }),
        revisionMapping: structuredClone(input.body.revisionMapping),
        remoteIntent: input.body.remoteIntent,
      };
      this.nextId += 1;
      this.objects.set(object.id, object);
      if (object.status === 'draft') this.draftCreateCount += 1;
      if (object.status === 'publish') this.publishedCreateCount += 1;
      this.log(`POST ${requestPath} -> ${String(object.id)} ${object.status}`);
      if (failure === 'TIMEOUT_AFTER_EFFECT') {
        return Promise.resolve({ status: 599, body: { code: 'remote_timeout' } });
      }
      return Promise.resolve({ status: 201, body: structuredClone(object) });
    }

    if (input.method === 'POST' && remoteId !== null && input.body.kind === 'CONTENT') {
      const object = this.objects.get(remoteId);
      if (object === undefined || object.requestPath !== requestPath || object.status !== 'draft') {
        return Promise.resolve({ status: 409, body: { code: 'rest_update_rejected' } });
      }
      object.status = input.body.status;
      object.slug = input.body.slug;
      object.title = input.body.title;
      object.content = input.body.content;
      object.revisionMapping = structuredClone(input.body.revisionMapping);
      object.remoteIntent = input.body.remoteIntent;
      if (input.body.categoryIds === undefined) delete object.categoryIds;
      else object.categoryIds = [...input.body.categoryIds];
      this.contentUpdateCount += 1;
      this.log(`POST ${requestPath}/${String(remoteId)} -> update draft`);
      return Promise.resolve({ status: 200, body: structuredClone(object) });
    }

    if (input.method === 'GET' && remoteId !== null) {
      const object = this.objects.get(remoteId);
      return Promise.resolve(
        object === undefined || object.requestPath !== requestPath
          ? { status: 404, body: { code: 'rest_post_invalid_id' } }
          : { status: 200, body: structuredClone(object) },
      );
    }

    if (input.method === 'DELETE' && remoteId !== null) {
      const object = this.objects.get(remoteId);
      if (object === undefined || object.requestPath !== requestPath) {
        return Promise.resolve({ status: 404, body: { code: 'rest_post_invalid_id' } });
      }
      object.status = 'trash';
      this.log(`DELETE ${requestPath}/${String(remoteId)} -> trash`);
      return Promise.resolve({ status: 200, body: structuredClone(object) });
    }

    return Promise.resolve({ status: 404, body: { code: 'rest_no_route' } });
  }

  snapshot(): FakeWordPressServerSnapshot {
    return {
      apiVersion: this.apiVersion,
      draftCreateCount: this.draftCreateCount,
      contentUpdateCount: this.contentUpdateCount,
      publishedCreateCount: this.publishedCreateCount,
      mediaCreateCount: this.mediaCreateCount,
      objects: [...this.objects.values()].map((object) => structuredClone(object)),
      media: [...this.media.values()].map((object) => structuredClone(object)),
    };
  }

  queueFailure(mode: 'PUBLISH_INSTEAD_OF_DRAFT' | 'RESPONSE_404' | 'TIMEOUT_AFTER_EFFECT'): void {
    if (this.nextFailure !== null) throw new Error('WORDPRESS_FAKE_FAILURE_ALREADY_QUEUED');
    this.nextFailure = mode;
  }

  setObjectStatus(remoteId: number, status: 'draft' | 'publish' | 'trash'): void {
    const object = this.objects.get(remoteId);
    if (object === undefined) throw new Error('WORDPRESS_FAKE_OBJECT_NOT_FOUND');
    object.status = status;
  }

  validateAuthorization(input: {
    siteOrigin: string;
    authorizationReference: string;
    requiredScopes: readonly string[];
  }):
    | 'WORDPRESS_TLS_REQUIRED'
    | 'WORDPRESS_AUTHORIZATION_INVALID'
    | 'WORDPRESS_SCOPE_INSUFFICIENT'
    | null {
    return this.authorizationError(input);
  }

  private authorizationError(input: {
    siteOrigin: string;
    authorizationReference: string;
    requiredScopes: readonly string[];
  }):
    | 'WORDPRESS_TLS_REQUIRED'
    | 'WORDPRESS_AUTHORIZATION_INVALID'
    | 'WORDPRESS_SCOPE_INSUFFICIENT'
    | null {
    if (canonicalHttpsOrigin(input.siteOrigin) === null) return 'WORDPRESS_TLS_REQUIRED';
    if (
      input.siteOrigin !== this.siteOrigin ||
      input.authorizationReference.length === 0 ||
      this.authorization.credential.length === 0
    ) {
      return 'WORDPRESS_AUTHORIZATION_INVALID';
    }
    return input.requiredScopes.every((scope) => this.authorization.scopes.includes(scope))
      ? null
      : 'WORDPRESS_SCOPE_INSUFFICIENT';
  }
}

export type WordPressPageDraftPublishResult =
  | {
      outcome: 'APPLIED';
      remoteRef: string;
      remoteId: number;
      adminPreviewUrl: string;
      status: 'DRAFT';
      isProductionLive: false;
      revisionMapping: WordPressRevisionMapping;
      rollbackHandle: {
        operation: 'TRASH_DRAFT';
        siteOrigin: string;
        resource: '/wp/v2/pages' | '/wp/v2/posts' | '/wc/v3/products';
        remoteId: number;
      };
    }
  | {
      outcome: 'DEFINITELY_NOT_APPLIED' | 'AMBIGUOUS';
      errorCode: string;
      fallback?: 'EXPORT_ONLY';
      packageChecksum?: string;
    };

export type WordPressDraftRollbackHandle = Extract<
  WordPressPageDraftPublishResult,
  { outcome: 'APPLIED' }
>['rollbackHandle'];

export type WordPressDraftRollbackResult =
  | {
      outcome: 'ROLLED_BACK';
      remoteRef: string;
      status: 'TRASH';
      rollbackHandle: WordPressDraftRollbackHandle;
    }
  | { outcome: 'DEFINITELY_NOT_ROLLED_BACK' | 'UNKNOWN'; errorCode: string };

export interface WordPressWooCommerceDraftPublicationAdapterOptions {
  adapterKey: string;
  adapterVersion: string;
  providerApiVersion: string;
  server: VersionedFakeWordPressServer;
  requiredScopes: string[];
  allowedSiteOrigins: string[];
}

export class WordPressWooCommerceDraftPublicationAdapter {
  private readonly options: WordPressWooCommerceDraftPublicationAdapterOptions;
  private readonly ambiguousIntents = new Set<string>();

  constructor(options: WordPressWooCommerceDraftPublicationAdapterOptions) {
    this.options = {
      ...options,
      requiredScopes: [...options.requiredScopes],
      allowedSiteOrigins: [...options.allowedSiteOrigins],
    };
  }

  describe(): {
    adapterKey: string;
    adapterVersion: string;
    providerApiVersion: string;
    capabilities: string[];
  } {
    return {
      adapterKey: this.options.adapterKey,
      adapterVersion: this.options.adapterVersion,
      providerApiVersion: this.options.providerApiVersion,
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK'],
    };
  }

  validateAuthorization(command: WordPressPageDraftCommand): Promise<
    | { outcome: 'VALID' }
    | {
        outcome: 'INVALID';
        errorCode:
          | 'WORDPRESS_TLS_REQUIRED'
          | 'WORDPRESS_AUTHORIZATION_INVALID'
          | 'WORDPRESS_SCOPE_INSUFFICIENT';
      }
  > {
    const origin = canonicalOrigin(command.target.siteOrigin);
    if (origin === null || !this.options.allowedSiteOrigins.includes(origin)) {
      return Promise.resolve({
        outcome: 'INVALID',
        errorCode: 'WORDPRESS_AUTHORIZATION_INVALID',
      });
    }
    const errorCode = this.options.server.validateAuthorization({
      siteOrigin: origin,
      authorizationReference: command.authorizationReference,
      requiredScopes: this.requiredScopesFor(command),
    });
    return Promise.resolve(
      errorCode === null ? { outcome: 'VALID' } : { outcome: 'INVALID', errorCode },
    );
  }

  async publish(command: WordPressPageDraftCommand): Promise<WordPressPageDraftPublishResult> {
    const authorization = await this.validateAuthorization(command);
    if (authorization.outcome === 'INVALID') {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: authorization.errorCode };
    }
    if (!this.validCommand(command)) {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'WORDPRESS_REQUEST_INVALID' };
    }
    if (!validJsonLd(command.files['structured-data.json'])) {
      return {
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'WORDPRESS_JSON_LD_UNSAFE',
        fallback: 'EXPORT_ONLY',
        packageChecksum: command.packageChecksum,
      };
    }
    if (!validMedia(command)) {
      return {
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'WORDPRESS_MEDIA_CHECKSUM_MISMATCH',
        fallback: 'EXPORT_ONLY',
        packageChecksum: command.packageChecksum,
      };
    }
    const remoteIntent = remoteIntentFor(command);
    if (this.ambiguousIntents.has(remoteIntent)) {
      return { outcome: 'AMBIGUOUS', errorCode: 'WORDPRESS_RECONCILE_REQUIRED' };
    }
    const revisionMapping = revisionMappingFor(command);
    const route = routeFor(command.target.contentKind);
    const schemaResponse = await this.options.server.request({
      method: 'OPTIONS',
      url: `${command.target.siteOrigin}${route.requestPath}`,
      authorizationReference: command.authorizationReference,
      requiredScopes: this.requiredScopesFor(command),
    });
    if (schemaResponse.status === 404 && command.target.contentKind === 'PRODUCT') {
      return {
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'WOOCOMMERCE_ENDPOINT_UNAVAILABLE',
        fallback: 'EXPORT_ONLY',
        packageChecksum: command.packageChecksum,
      };
    }
    const schemaBody = schemaResponse.body;
    if (
      schemaResponse.status !== 200 ||
      !isRestSchema(schemaBody) ||
      schemaBody.route !== route.requestPath ||
      !schemaFieldsFor(command.target.contentKind).every(
        (field) => isRestSchema(schemaBody) && schemaBody.writableFields.includes(field),
      )
    ) {
      return {
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'WORDPRESS_SCHEMA_UNSUPPORTED',
        fallback: 'EXPORT_ONLY',
        packageChecksum: command.packageChecksum,
      };
    }
    const jsonLd = command.files['structured-data.json']
      .replaceAll('<', '\\u003c')
      .replaceAll('>', '\\u003e')
      .replaceAll('&', '\\u0026')
      .replaceAll('\u2028', '\\u2028')
      .replaceAll('\u2029', '\\u2029');
    const content = `${command.files['content.html']}<script type="application/ld+json">${jsonLd}</script>`;
    const categoryIds = command.target.categoryIds ?? [];
    let writeUrl = `${command.target.siteOrigin}${route.requestPath}`;
    if (command.target.remoteId === undefined) {
      const existingResponse = await this.options.server.request({
        method: 'GET',
        url: `${command.target.siteOrigin}${route.requestPath}?slug=${encodeURIComponent(command.target.slug)}`,
        authorizationReference: command.authorizationReference,
        requiredScopes: this.requiredScopesFor(command),
      });
      if (existingResponse.status !== 200 || !Array.isArray(existingResponse.body)) {
        return command.target.contentKind === 'PRODUCT' && existingResponse.status === 404
          ? {
              outcome: 'DEFINITELY_NOT_APPLIED',
              errorCode: 'WOOCOMMERCE_ENDPOINT_UNAVAILABLE',
              fallback: 'EXPORT_ONLY',
              packageChecksum: command.packageChecksum,
            }
          : { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'WORDPRESS_SLUG_LOOKUP_FAILED' };
      }
      if (existingResponse.body.length > 0) {
        const existing = existingResponse.body[0];
        if (
          existingResponse.body.length === 1 &&
          existing !== undefined &&
          sameExactDraft(existing, {
            requestPath: route.requestPath,
            slug: command.target.slug,
            title: command.document.title,
            content,
            categoryIds,
            revisionMapping,
            remoteIntent,
          })
        ) {
          return appliedDraft(command, existing, route.resource, revisionMapping);
        }
        return {
          outcome: 'DEFINITELY_NOT_APPLIED',
          errorCode: 'WORDPRESS_SLUG_CONFLICT',
          fallback: 'EXPORT_ONLY',
          packageChecksum: command.packageChecksum,
        };
      }
    } else {
      writeUrl = `${writeUrl}/${String(command.target.remoteId)}`;
      const targetResponse = await this.options.server.request({
        method: 'GET',
        url: writeUrl,
        authorizationReference: command.authorizationReference,
        requiredScopes: this.requiredScopesFor(command),
      });
      if (targetResponse.status !== 200 || !isPageObject(targetResponse.body)) {
        return updateTargetMismatch(command.packageChecksum);
      }
      if (
        sameExactDraft(targetResponse.body, {
          requestPath: route.requestPath,
          slug: command.target.slug,
          title: command.document.title,
          content,
          categoryIds,
          revisionMapping,
          remoteIntent,
        })
      ) {
        return appliedDraft(command, targetResponse.body, route.resource, revisionMapping);
      }
      if (
        targetResponse.body.status !== 'draft' ||
        targetResponse.body.requestPath !== route.requestPath ||
        targetResponse.body.slug !== command.target.slug ||
        targetResponse.body.revisionMapping.artifactId !== command.artifact.artifactId
      ) {
        return updateTargetMismatch(command.packageChecksum);
      }
    }
    for (const media of command.media ?? []) {
      const uploadResponse = await this.options.server.request({
        method: 'POST',
        url: `${command.target.siteOrigin}/wp-json/wp/v2/media`,
        authorizationReference: command.authorizationReference,
        requiredScopes: this.requiredScopesFor(command),
        body: {
          kind: 'MEDIA',
          assetRef: media.assetRef,
          filename: media.filename,
          mediaType: media.mediaType,
          sha256: media.sha256,
          remoteIntent,
        },
      });
      if (uploadResponse.status !== 201 || !isMediaObject(uploadResponse.body)) {
        this.ambiguousIntents.add(remoteIntent);
        return { outcome: 'AMBIGUOUS', errorCode: 'WORDPRESS_MEDIA_UPLOAD_UNKNOWN' };
      }
    }
    const createResponse = await this.options.server.request({
      method: 'POST',
      url: writeUrl,
      authorizationReference: command.authorizationReference,
      requiredScopes: this.requiredScopesFor(command),
      body: {
        kind: 'CONTENT',
        status: 'draft',
        slug: command.target.slug,
        title: command.document.title,
        content,
        ...(command.target.categoryIds === undefined
          ? {}
          : { categoryIds: [...command.target.categoryIds] }),
        revisionMapping,
        remoteIntent,
      },
    });
    if (createResponse.status === 599) {
      this.ambiguousIntents.add(remoteIntent);
      return { outcome: 'AMBIGUOUS', errorCode: 'WORDPRESS_REMOTE_TIMEOUT' };
    }
    const expectedWriteStatus = command.target.remoteId === undefined ? 201 : 200;
    if (createResponse.status !== expectedWriteStatus || !isPageObject(createResponse.body)) {
      return command.target.contentKind === 'PRODUCT' && createResponse.status === 404
        ? {
            outcome: 'DEFINITELY_NOT_APPLIED',
            errorCode: 'WOOCOMMERCE_ENDPOINT_UNAVAILABLE',
            fallback: 'EXPORT_ONLY',
            packageChecksum: command.packageChecksum,
          }
        : command.target.remoteId === undefined
          ? { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'WORDPRESS_DRAFT_CREATE_REJECTED' }
          : updateTargetMismatch(command.packageChecksum);
    }
    const readResponse = await this.options.server.request({
      method: 'GET',
      url: `${command.target.siteOrigin}${route.requestPath}/${String(createResponse.body.id)}`,
      authorizationReference: command.authorizationReference,
      requiredScopes: this.requiredScopesFor(command),
    });
    if (
      readResponse.status !== 200 ||
      !isPageObject(readResponse.body) ||
      readResponse.body.status !== 'draft' ||
      readResponse.body.requestPath !== route.requestPath ||
      readResponse.body.slug !== command.target.slug ||
      readResponse.body.title !== command.document.title ||
      readResponse.body.content !== content ||
      JSON.stringify(readResponse.body.categoryIds ?? []) !== JSON.stringify(categoryIds) ||
      JSON.stringify(readResponse.body.revisionMapping) !== JSON.stringify(revisionMapping)
    ) {
      const rollbackResponse = await this.options.server.request({
        method: 'DELETE',
        url: `${command.target.siteOrigin}${route.requestPath}/${String(createResponse.body.id)}`,
        authorizationReference: command.authorizationReference,
        requiredScopes: this.requiredScopesFor(command),
      });
      return rollbackResponse.status === 200
        ? {
            outcome: 'DEFINITELY_NOT_APPLIED',
            errorCode: 'WORDPRESS_NON_DRAFT_ROLLED_BACK',
          }
        : { outcome: 'AMBIGUOUS', errorCode: 'WORDPRESS_DRAFT_READBACK_MISMATCH' };
    }
    return appliedDraft(command, readResponse.body, route.resource, revisionMapping);
  }

  async reconcile(command: WordPressPageDraftCommand): Promise<WordPressPageDraftPublishResult> {
    const authorization = await this.validateAuthorization(command);
    if (authorization.outcome === 'INVALID') {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: authorization.errorCode };
    }
    if (!this.validCommand(command)) {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'WORDPRESS_REQUEST_INVALID' };
    }
    if (!validJsonLd(command.files['structured-data.json'])) {
      return {
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'WORDPRESS_JSON_LD_UNSAFE',
        fallback: 'EXPORT_ONLY',
        packageChecksum: command.packageChecksum,
      };
    }
    if (!validMedia(command)) {
      return {
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'WORDPRESS_MEDIA_CHECKSUM_MISMATCH',
        fallback: 'EXPORT_ONLY',
        packageChecksum: command.packageChecksum,
      };
    }
    const route = routeFor(command.target.contentKind);
    const revisionMapping = revisionMappingFor(command);
    const remoteIntent = remoteIntentFor(command);
    const jsonLd = command.files['structured-data.json']
      .replaceAll('<', '\\u003c')
      .replaceAll('>', '\\u003e')
      .replaceAll('&', '\\u0026')
      .replaceAll('\u2028', '\\u2028')
      .replaceAll('\u2029', '\\u2029');
    const content = `${command.files['content.html']}<script type="application/ld+json">${jsonLd}</script>`;
    const response = await this.options.server.request({
      method: 'GET',
      url: `${command.target.siteOrigin}${route.requestPath}?slug=${encodeURIComponent(command.target.slug)}`,
      authorizationReference: command.authorizationReference,
      requiredScopes: this.requiredScopesFor(command),
    });
    if (response.status !== 200 || !Array.isArray(response.body)) {
      return { outcome: 'AMBIGUOUS', errorCode: 'WORDPRESS_RECONCILE_UNAVAILABLE' };
    }
    const object = response.body[0];
    if (
      response.body.length !== 1 ||
      object === undefined ||
      !sameExactDraft(object, {
        requestPath: route.requestPath,
        slug: command.target.slug,
        title: command.document.title,
        content,
        categoryIds: command.target.categoryIds ?? [],
        revisionMapping,
        remoteIntent,
      })
    ) {
      return response.body.length === 0
        ? { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'WORDPRESS_DRAFT_NOT_FOUND' }
        : { outcome: 'AMBIGUOUS', errorCode: 'WORDPRESS_RECONCILE_MISMATCH' };
    }
    this.ambiguousIntents.delete(remoteIntent);
    return appliedDraft(command, object, route.resource, revisionMapping);
  }

  async rollback(
    command: WordPressPageDraftCommand & { rollbackHandle: WordPressDraftRollbackHandle },
  ): Promise<WordPressDraftRollbackResult> {
    const authorization = await this.validateAuthorization(command);
    if (authorization.outcome === 'INVALID' || !this.validCommand(command)) {
      return { outcome: 'DEFINITELY_NOT_ROLLED_BACK', errorCode: 'WORDPRESS_ROLLBACK_REJECTED' };
    }
    if (!validJsonLd(command.files['structured-data.json'])) {
      return { outcome: 'DEFINITELY_NOT_ROLLED_BACK', errorCode: 'WORDPRESS_ROLLBACK_REJECTED' };
    }
    const route = routeFor(command.target.contentKind);
    const handle = command.rollbackHandle;
    if (
      handle.siteOrigin !== command.target.siteOrigin ||
      handle.resource !== route.resource ||
      !Number.isSafeInteger(handle.remoteId) ||
      handle.remoteId <= 0
    ) {
      return {
        outcome: 'DEFINITELY_NOT_ROLLED_BACK',
        errorCode: 'WORDPRESS_ROLLBACK_TARGET_MISMATCH',
      };
    }
    const response = await this.options.server.request({
      method: 'GET',
      url: `${command.target.siteOrigin}${route.requestPath}/${String(handle.remoteId)}`,
      authorizationReference: command.authorizationReference,
      requiredScopes: this.requiredScopesFor(command),
    });
    if (response.status === 404) {
      return {
        outcome: 'DEFINITELY_NOT_ROLLED_BACK',
        errorCode: 'WORDPRESS_ROLLBACK_TARGET_MISMATCH',
      };
    }
    if (response.status !== 200 || !isPageObject(response.body)) {
      return { outcome: 'UNKNOWN', errorCode: 'WORDPRESS_ROLLBACK_LOOKUP_FAILED' };
    }
    const revisionMapping = revisionMappingFor(command);
    const jsonLd = command.files['structured-data.json']
      .replaceAll('<', '\\u003c')
      .replaceAll('>', '\\u003e')
      .replaceAll('&', '\\u0026')
      .replaceAll('\u2028', '\\u2028')
      .replaceAll('\u2029', '\\u2029');
    const content = `${command.files['content.html']}<script type="application/ld+json">${jsonLd}</script>`;
    if (
      !sameExactObject(response.body, {
        requestPath: route.requestPath,
        slug: command.target.slug,
        title: command.document.title,
        content,
        categoryIds: command.target.categoryIds ?? [],
        revisionMapping,
        remoteIntent: remoteIntentFor(command),
      }) ||
      response.body.status === 'publish'
    ) {
      return { outcome: 'DEFINITELY_NOT_ROLLED_BACK', errorCode: 'WORDPRESS_ROLLBACK_REJECTED' };
    }
    const remoteRef = `${command.target.siteOrigin}/wp-admin/post.php?post=${String(handle.remoteId)}&action=edit`;
    if (response.body.status === 'trash') {
      return { outcome: 'ROLLED_BACK', remoteRef, status: 'TRASH', rollbackHandle: { ...handle } };
    }
    const trashResponse = await this.options.server.request({
      method: 'DELETE',
      url: `${command.target.siteOrigin}${route.requestPath}/${String(handle.remoteId)}`,
      authorizationReference: command.authorizationReference,
      requiredScopes: this.requiredScopesFor(command),
    });
    return trashResponse.status === 200 && isPageObject(trashResponse.body)
      ? { outcome: 'ROLLED_BACK', remoteRef, status: 'TRASH', rollbackHandle: { ...handle } }
      : { outcome: 'UNKNOWN', errorCode: 'WORDPRESS_ROLLBACK_FAILED' };
  }

  private validCommand(command: WordPressPageDraftCommand): boolean {
    const targetOrigin = canonicalOrigin(command.target.siteOrigin);
    if (
      targetOrigin === null ||
      !this.options.allowedSiteOrigins.includes(targetOrigin) ||
      this.options.providerApiVersion !== 'wp/v2' ||
      !isCanonicalSlug(command.target.slug) ||
      command.document.title.trim().length === 0 ||
      command.document.summary.trim().length === 0 ||
      !isSha256(command.packageChecksum) ||
      !isSha256(command.artifact.contentHash) ||
      !Number.isSafeInteger(command.artifact.revision) ||
      command.artifact.revision <= 0
    ) {
      return false;
    }
    const categories = command.target.categoryIds;
    if (
      command.target.remoteId !== undefined &&
      (!Number.isSafeInteger(command.target.remoteId) || command.target.remoteId <= 0)
    ) {
      return false;
    }
    if (command.target.contentKind === 'PAGE') {
      if (categories !== undefined) return false;
    } else if (
      categories === undefined ||
      categories.length > 100 ||
      categories.some(
        (value, index) =>
          !Number.isSafeInteger(value) ||
          value <= 0 ||
          (index > 0 && (categories[index - 1] ?? value) >= value),
      )
    ) {
      return false;
    }
    return true;
  }

  private requiredScopesFor(command: WordPressPageDraftCommand): string[] {
    const scopes = new Set(this.options.requiredScopes);
    if ((command.assetRefs?.length ?? 0) > 0) scopes.add('media:write');
    scopes.add(
      command.target.contentKind === 'PAGE'
        ? 'pages:write'
        : command.target.contentKind === 'POST'
          ? 'posts:write'
          : 'woocommerce:products:write',
    );
    return [...scopes].sort((left, right) => left.localeCompare(right));
  }
}

function isPageObject(value: WordPressFakeResponse['body']): value is WordPressPageDraftObject {
  return (
    !Array.isArray(value) &&
    'requestPath' in value &&
    value.requestPath !== '/wp-json/wp/v2/media' &&
    typeof value.id === 'number'
  );
}

function isMediaObject(value: WordPressFakeResponse['body']): value is WordPressMediaObject {
  return (
    !Array.isArray(value) &&
    'requestPath' in value &&
    value.requestPath === '/wp-json/wp/v2/media' &&
    typeof value.id === 'number'
  );
}

function isRestSchema(value: WordPressFakeResponse['body']): value is WordPressRestSchema {
  return !Array.isArray(value) && 'writableFields' in value && Array.isArray(value.writableFields);
}

function sameExactDraft(
  object: WordPressPageDraftObject,
  expected: {
    requestPath: WordPressPageDraftObject['requestPath'];
    slug: string;
    title: string;
    content: string;
    categoryIds: number[];
    revisionMapping: WordPressRevisionMapping;
    remoteIntent: string;
  },
): boolean {
  return object.status === 'draft' && sameExactObject(object, expected);
}

function sameExactObject(
  object: WordPressPageDraftObject,
  expected: {
    requestPath: WordPressPageDraftObject['requestPath'];
    slug: string;
    title: string;
    content: string;
    categoryIds: number[];
    revisionMapping: WordPressRevisionMapping;
    remoteIntent: string;
  },
): boolean {
  return (
    object.requestPath === expected.requestPath &&
    object.slug === expected.slug &&
    object.title === expected.title &&
    object.content === expected.content &&
    JSON.stringify(object.categoryIds ?? []) === JSON.stringify(expected.categoryIds) &&
    JSON.stringify(object.revisionMapping) === JSON.stringify(expected.revisionMapping) &&
    object.remoteIntent === expected.remoteIntent
  );
}

function appliedDraft(
  command: WordPressPageDraftCommand,
  object: WordPressPageDraftObject,
  resource: '/wp/v2/pages' | '/wp/v2/posts' | '/wc/v3/products',
  revisionMapping: WordPressRevisionMapping,
): Extract<WordPressPageDraftPublishResult, { outcome: 'APPLIED' }> {
  const adminPreviewUrl = `${command.target.siteOrigin}/wp-admin/post.php?post=${String(object.id)}&action=edit`;
  return {
    outcome: 'APPLIED',
    remoteRef: adminPreviewUrl,
    remoteId: object.id,
    adminPreviewUrl,
    status: 'DRAFT',
    isProductionLive: false,
    revisionMapping,
    rollbackHandle: {
      operation: 'TRASH_DRAFT',
      siteOrigin: command.target.siteOrigin,
      resource,
      remoteId: object.id,
    },
  };
}

function routeFor(contentKind: WordPressPageDraftCommand['target']['contentKind']): {
  requestPath: WordPressPageDraftObject['requestPath'];
  resource: '/wp/v2/pages' | '/wp/v2/posts' | '/wc/v3/products';
} {
  switch (contentKind) {
    case 'PAGE':
      return { requestPath: '/wp-json/wp/v2/pages', resource: '/wp/v2/pages' };
    case 'POST':
      return { requestPath: '/wp-json/wp/v2/posts', resource: '/wp/v2/posts' };
    case 'PRODUCT':
      return { requestPath: '/wp-json/wc/v3/products', resource: '/wc/v3/products' };
  }
}

function schemaFieldsFor(
  contentKind: WordPressPageDraftCommand['target']['contentKind'],
): string[] {
  switch (contentKind) {
    case 'PAGE':
      return ['content', 'slug', 'status', 'title'];
    case 'POST':
      return ['categories', 'content', 'slug', 'status', 'title'];
    case 'PRODUCT':
      return ['categories', 'description', 'name', 'slug', 'status'];
  }
}

function updateTargetMismatch(packageChecksum: string): WordPressPageDraftPublishResult {
  return {
    outcome: 'DEFINITELY_NOT_APPLIED',
    errorCode: 'WORDPRESS_UPDATE_TARGET_MISMATCH',
    fallback: 'EXPORT_ONLY',
    packageChecksum,
  };
}

function remoteIntentFor(command: WordPressPageDraftCommand): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        siteOrigin: command.target.siteOrigin,
        contentKind: command.target.contentKind,
        slug: command.target.slug,
        categoryIds: command.target.categoryIds ?? [],
        remoteId: command.target.remoteId ?? null,
        artifactId: command.artifact.artifactId,
        artifactRevisionId: command.artifact.artifactRevisionId,
        artifactRevision: command.artifact.revision,
        artifactContentHash: command.artifact.contentHash,
        packageChecksum: command.packageChecksum,
        media: (command.media ?? []).map((asset) => ({
          assetRef: asset.assetRef,
          filename: asset.filename,
          mediaType: asset.mediaType,
          sha256: asset.sha256,
        })),
      }),
      'utf8',
    )
    .digest('hex');
}

function validMedia(command: WordPressPageDraftCommand): boolean {
  const assetRefs = command.assetRefs ?? [];
  const media = command.media ?? [];
  if (
    new Set(assetRefs).size !== assetRefs.length ||
    new Set(media.map((asset) => asset.assetRef)).size !== media.length ||
    assetRefs.length !== media.length
  ) {
    return false;
  }
  const mediaByRef = new Map(media.map((asset) => [asset.assetRef, asset]));
  return assetRefs.every((assetRef) => {
    const asset = mediaByRef.get(assetRef);
    if (
      asset === undefined ||
      !/^asset:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u.test(assetRef) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(asset.filename) ||
      !/^image\/(?:gif|jpeg|png|webp)$/u.test(asset.mediaType) ||
      !(asset.bytes instanceof Uint8Array) ||
      asset.bytes.byteLength === 0 ||
      asset.bytes.byteLength > 10 * 1_024 * 1_024 ||
      !isSha256(asset.sha256)
    ) {
      return false;
    }
    return createHash('sha256').update(asset.bytes).digest('hex') === asset.sha256;
  });
}

function validJsonLd(value: string): boolean {
  if (Buffer.byteLength(value, 'utf8') > 256 * 1_024) return false;
  let root: unknown;
  try {
    root = JSON.parse(value) as unknown;
  } catch {
    return false;
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return false;
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodeCount = 0;
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined || entry.depth > 32) return false;
    nodeCount += 1;
    if (nodeCount > 10_000) return false;
    const candidate = entry.value;
    if (candidate === null || typeof candidate === 'boolean') continue;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) return false;
      continue;
    }
    if (typeof candidate === 'string') {
      if (candidate.length > 100_000 || candidate.includes('\u0000')) return false;
      continue;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > 1_000) return false;
      for (const child of candidate) pending.push({ value: child, depth: entry.depth + 1 });
      continue;
    }
    if (typeof candidate !== 'object' || Object.getPrototypeOf(candidate) !== Object.prototype) {
      return false;
    }
    const entries = Object.entries(candidate as Record<string, unknown>);
    if (entries.length > 1_000) return false;
    for (const [key, child] of entries) {
      if (
        key.length === 0 ||
        key.length > 256 ||
        key === '__proto__' ||
        key === 'constructor' ||
        key === 'prototype'
      ) {
        return false;
      }
      pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
  return true;
}
