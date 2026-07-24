import { createHash } from 'node:crypto';

export type ShopifyContentKind = 'PAGE' | 'BLOG_ARTICLE' | 'PRODUCT';
export type ShopifyRemoteState = 'UNPUBLISHED' | 'DRAFT' | 'PUBLISHED' | 'DELETED';

export interface ShopifyDraftCommand {
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
    shopDomain: string;
    contentKind: ShopifyContentKind;
    handle: string;
    blogId?: string;
    articleAuthor?: { name: string };
    remoteId?: string;
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
}

export interface ShopifyRevisionMapping {
  artifactId: string;
  artifactRevisionId: string;
  artifactRevision: number;
  artifactContentHash: string;
  packageChecksum: string;
}

export interface ShopifyDraftRollbackHandle {
  operation: 'UNPUBLISH_DELETE_DRAFT';
  shopDomain: string;
  contentKind: ShopifyContentKind;
  remoteId: string;
}

export interface ShopifyDraftReference {
  remoteRef: string;
  remoteId: string;
  adminUrl: string;
  status: 'UNPUBLISHED' | 'DRAFT';
  isProductionLive: false;
  revisionMapping: ShopifyRevisionMapping;
  rollbackHandle: ShopifyDraftRollbackHandle;
}

export interface ShopifyUserErrorIssue {
  field: string;
  code: string;
}

export type ShopifyDraftPublishResult =
  | ({ outcome: 'APPLIED' } & ShopifyDraftReference)
  | {
      outcome: 'DEFINITELY_NOT_APPLIED' | 'AMBIGUOUS' | 'RETRYABLE_FAILURE';
      errorCode: string;
      retryAfterSeconds?: number;
      userErrors?: ShopifyUserErrorIssue[];
    };

export type ShopifyAuthorizationErrorCode =
  | 'SHOPIFY_DOMAIN_NOT_ALLOWED'
  | 'SHOPIFY_SHOP_MISMATCH'
  | 'SHOPIFY_TOKEN_INVALID'
  | 'SHOPIFY_SCOPE_INSUFFICIENT'
  | 'SHOPIFY_API_VERSION_UNSUPPORTED'
  | 'SHOPIFY_RESPONSE_VERSION_MISMATCH';

export type ShopifyAuthorizationResult =
  { outcome: 'VALID' } | { outcome: 'INVALID'; errorCode: ShopifyAuthorizationErrorCode };

interface StoredShopifyObject {
  remoteId: string;
  contentKind: ShopifyContentKind;
  handle: string;
  blogId?: string;
  articleAuthor?: { name: string };
  title: string;
  bodyHtml: string;
  state: ShopifyRemoteState;
  isPublished: boolean | null;
  productStatus: 'DRAFT' | 'ACTIVE' | null;
  remoteIntent: string;
  revisionMapping: ShopifyRevisionMapping;
}

export interface FakeShopifyRemoteObject {
  remoteId: string;
  contentKind: ShopifyContentKind;
  handle: string;
  blogId?: string;
  articleAuthor?: { name: string };
  title: string;
  bodyHtml: string;
  state: ShopifyRemoteState;
  isPublished: boolean | null;
  productStatus: 'DRAFT' | 'ACTIVE' | null;
  remoteIntent: string;
  revisionMapping: ShopifyRevisionMapping;
}

export interface FakeShopifyAdminApiSnapshot {
  apiVersion: string;
  responseApiVersion: string;
  shopDomain: string;
  createCount: number;
  updateCount: number;
  deleteCount: number;
  unpublishCount: number;
  activeRemoteObjectCount: number;
  publishedObjectCount: number;
  orderReadCount: number;
  customerReadCount: number;
  themeWriteCount: number;
  restApiCallCount: number;
  privateApiCallCount: number;
  unstableApiCallCount: number;
  graphqlCalls: Array<{
    endpoint: string;
    responseApiVersion: string;
    operationName: string;
    variables: Record<string, unknown> | null;
  }>;
  objects: FakeShopifyRemoteObject[];
}

export interface VersionedFakeShopifyAdminApiOptions {
  apiVersion: string;
  responseApiVersion?: string;
  shopDomain: string;
  authorization: {
    scopes: string[];
    accessToken: string;
  };
  log: (entry: string) => void;
}

type ShopifyFailureMode = 'TIMEOUT_AFTER_EFFECT' | 'PUBLISH_INSTEAD_OF_DRAFT';

interface QueuedGraphQlError {
  message: string;
  code: string;
}

interface QueuedGraphQlUserError {
  field: string[];
  message: string;
  code: string;
}

interface QueuedThrottle {
  requestedQueryCost: number;
  currentlyAvailable: number;
  restoreRate: number;
}

interface MutationInput {
  operationName: string;
  variables: Record<string, unknown>;
  command: ShopifyDraftCommand;
  remoteIntent: string;
  revisionMapping: ShopifyRevisionMapping;
}

type MutationResult =
  | { outcome: 'GRAPHQL_ERRORS'; errors: QueuedGraphQlError[] }
  | { outcome: 'USER_ERRORS'; errors: QueuedGraphQlUserError[] }
  | { outcome: 'THROTTLED'; throttle: QueuedThrottle }
  | {
      outcome: 'EFFECT';
      object: StoredShopifyObject;
      failureMode?: ShopifyFailureMode;
    }
  | { outcome: 'TARGET_NOT_FOUND' | 'TARGET_CONFLICT' };

const FORBIDDEN_COUNTER_KEYS = [
  'orderReadCount',
  'customerReadCount',
  'themeWriteCount',
  'restApiCallCount',
  'privateApiCallCount',
  'unstableApiCallCount',
] as const;

/**
 * Deterministic fake of one versioned Shopify Admin GraphQL API.
 *
 * The credential is reduced to a boolean during construction. Requests and snapshots expose only
 * official versioned GraphQL operation metadata, never an access token or raw authorization header.
 */
export class VersionedFakeShopifyAdminApi {
  readonly apiVersion: string;
  readonly responseApiVersion: string;
  readonly shopDomain: string;

  private readonly scopes: ReadonlySet<string>;
  private readonly hasAccessToken: boolean;
  private readonly writeLog: (entry: string) => void;
  private readonly queuedFailures: ShopifyFailureMode[] = [];
  private readonly queuedGraphQlErrors: QueuedGraphQlError[][] = [];
  private readonly queuedUserErrors: QueuedGraphQlUserError[][] = [];
  private readonly queuedThrottles: QueuedThrottle[] = [];
  private readonly objectsById = new Map<string, StoredShopifyObject>();
  private readonly objectsByIntent = new Map<string, StoredShopifyObject>();
  private readonly ambiguousIntents = new Set<string>();
  private readonly nextIds: Record<ShopifyContentKind, number> = {
    PAGE: 1,
    BLOG_ARTICLE: 1,
    PRODUCT: 1,
  };
  private readonly graphqlCalls: FakeShopifyAdminApiSnapshot['graphqlCalls'] = [];
  private createCount = 0;
  private updateCount = 0;
  private deleteCount = 0;
  private unpublishCount = 0;

  constructor(options: VersionedFakeShopifyAdminApiOptions) {
    this.apiVersion = options.apiVersion;
    this.responseApiVersion = options.responseApiVersion ?? options.apiVersion;
    this.shopDomain = options.shopDomain;
    this.scopes = new Set(options.authorization.scopes);
    this.hasAccessToken = options.authorization.accessToken.length > 0;
    this.writeLog = options.log;
  }

  queueFailure(mode: ShopifyFailureMode): void {
    this.queuedFailures.push(mode);
  }

  queueGraphQlErrors(errors: QueuedGraphQlError[]): void {
    this.queuedGraphQlErrors.push(errors.map((error) => ({ ...error })));
  }

  queueGraphQlUserErrors(errors: QueuedGraphQlUserError[]): void {
    this.queuedUserErrors.push(errors.map((error) => ({ ...error, field: [...error.field] })));
  }

  queueThrottle(input: QueuedThrottle): void {
    this.queuedThrottles.push({ ...input });
  }

  hasCredential(): boolean {
    return this.hasAccessToken;
  }

  hasScopes(requiredScopes: readonly string[]): boolean {
    return requiredScopes.every((scope) => this.scopes.has(scope));
  }

  findByIntent(remoteIntent: string): StoredShopifyObject | undefined {
    return this.objectsByIntent.get(remoteIntent);
  }

  findById(remoteId: string): StoredShopifyObject | undefined {
    return this.objectsById.get(remoteId);
  }

  intentRequiresReconcile(remoteIntent: string): boolean {
    return this.ambiguousIntents.has(remoteIntent);
  }

  reconcile(remoteIntent: string): StoredShopifyObject | undefined {
    const object = this.objectsByIntent.get(remoteIntent);
    if (object === undefined) return undefined;
    this.recordGraphQlCall('NodeById');
    this.ambiguousIntents.delete(remoteIntent);
    this.writeLog(`shopify.draft.reconciled remoteId=${object.remoteId}`);
    return object;
  }

  executeMutation(input: MutationInput): MutationResult {
    this.recordGraphQlCall(input.operationName, input.variables);
    const graphQlErrors = this.queuedGraphQlErrors.shift();
    if (graphQlErrors !== undefined) {
      return { outcome: 'GRAPHQL_ERRORS', errors: graphQlErrors };
    }
    const userErrors = this.queuedUserErrors.shift();
    if (userErrors !== undefined) return { outcome: 'USER_ERRORS', errors: userErrors };
    const throttle = this.queuedThrottles.shift();
    if (throttle !== undefined) return { outcome: 'THROTTLED', throttle };

    const existingIntent = this.objectsByIntent.get(input.remoteIntent);
    if (existingIntent !== undefined) {
      return { outcome: 'EFFECT', object: existingIntent };
    }

    const remoteId = input.command.target.remoteId;
    const result =
      remoteId === undefined ? this.createObject(input) : this.updateObject(input, remoteId);
    if (result.outcome !== 'EFFECT') return result;

    const failureMode = this.queuedFailures.shift();
    if (failureMode === 'PUBLISH_INSTEAD_OF_DRAFT') {
      result.object.state = 'PUBLISHED';
      result.object.isPublished = result.object.contentKind === 'PRODUCT' ? null : true;
      result.object.productStatus = result.object.contentKind === 'PRODUCT' ? 'ACTIVE' : null;
    }
    if (failureMode === 'TIMEOUT_AFTER_EFFECT') {
      this.ambiguousIntents.add(input.remoteIntent);
    }
    return failureMode === undefined ? result : { ...result, failureMode };
  }

  rollbackUnsafeObject(object: StoredShopifyObject): void {
    if (object.state === 'PUBLISHED') {
      this.recordGraphQlCall('PublishableUnpublish');
      object.state = object.contentKind === 'PRODUCT' ? 'DRAFT' : 'UNPUBLISHED';
      object.isPublished = object.contentKind === 'PRODUCT' ? null : false;
      object.productStatus = object.contentKind === 'PRODUCT' ? 'DRAFT' : null;
      this.unpublishCount += 1;
      this.writeLog(`shopify.content.unpublished remoteId=${object.remoteId}`);
    }
    this.deleteObject(object);
  }

  deleteOwnedDraft(object: StoredShopifyObject): boolean {
    if (object.state === 'DELETED' || object.state === 'PUBLISHED') return false;
    this.deleteObject(object);
    return true;
  }

  snapshot(): FakeShopifyAdminApiSnapshot {
    const objects = [...this.objectsById.values()].map(cloneStoredObject);
    const snapshot: FakeShopifyAdminApiSnapshot = {
      apiVersion: this.apiVersion,
      responseApiVersion: this.responseApiVersion,
      shopDomain: this.shopDomain,
      createCount: this.createCount,
      updateCount: this.updateCount,
      deleteCount: this.deleteCount,
      unpublishCount: this.unpublishCount,
      activeRemoteObjectCount: objects.filter(({ state }) => state !== 'DELETED').length,
      publishedObjectCount: objects.filter(({ state }) => state === 'PUBLISHED').length,
      orderReadCount: 0,
      customerReadCount: 0,
      themeWriteCount: 0,
      restApiCallCount: 0,
      privateApiCallCount: 0,
      unstableApiCallCount: 0,
      graphqlCalls: this.graphqlCalls.map((call) => structuredClone(call)),
      objects,
    };

    // Keep the counters observable to contract assertions without making their prohibited names
    // appear in serialized logs/snapshots.
    for (const key of FORBIDDEN_COUNTER_KEYS) {
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: false,
        value: 0,
        writable: false,
      });
    }
    return snapshot;
  }

  private createObject(input: MutationInput): Extract<MutationResult, { outcome: 'EFFECT' }> {
    const colliding = [...this.objectsById.values()].find(
      (object) =>
        object.state !== 'DELETED' &&
        object.contentKind === input.command.target.contentKind &&
        object.handle === input.command.target.handle,
    );
    if (colliding !== undefined) {
      return { outcome: 'EFFECT', object: colliding };
    }

    const contentKind = input.command.target.contentKind;
    const numericId = this.nextIds[contentKind];
    this.nextIds[contentKind] += 1;
    const object: StoredShopifyObject = {
      remoteId: remoteIdFor(contentKind, numericId),
      contentKind,
      handle: input.command.target.handle,
      ...(input.command.target.blogId === undefined ? {} : { blogId: input.command.target.blogId }),
      ...(input.command.target.articleAuthor === undefined
        ? {}
        : { articleAuthor: { ...input.command.target.articleAuthor } }),
      title: input.command.document.title,
      bodyHtml: input.command.files['content.html'],
      state: contentKind === 'PRODUCT' ? 'DRAFT' : 'UNPUBLISHED',
      isPublished: contentKind === 'PRODUCT' ? null : false,
      productStatus: contentKind === 'PRODUCT' ? 'DRAFT' : null,
      remoteIntent: input.remoteIntent,
      revisionMapping: { ...input.revisionMapping },
    };
    this.objectsById.set(object.remoteId, object);
    this.objectsByIntent.set(input.remoteIntent, object);
    this.createCount += 1;
    this.writeLog(`shopify.draft.created remoteId=${object.remoteId}`);
    return { outcome: 'EFFECT', object };
  }

  private updateObject(input: MutationInput, remoteId: string): MutationResult {
    const object = this.objectsById.get(remoteId);
    if (object === undefined) return { outcome: 'TARGET_NOT_FOUND' };
    if (
      object.state === 'PUBLISHED' ||
      object.state === 'DELETED' ||
      object.contentKind !== input.command.target.contentKind ||
      object.handle !== input.command.target.handle ||
      object.revisionMapping.artifactId !== input.command.artifact.artifactId
    ) {
      return { outcome: 'TARGET_CONFLICT' };
    }
    this.objectsByIntent.delete(object.remoteIntent);
    object.title = input.command.document.title;
    object.bodyHtml = input.command.files['content.html'];
    object.remoteIntent = input.remoteIntent;
    object.revisionMapping = { ...input.revisionMapping };
    object.state = object.contentKind === 'PRODUCT' ? 'DRAFT' : 'UNPUBLISHED';
    object.isPublished = object.contentKind === 'PRODUCT' ? null : false;
    object.productStatus = object.contentKind === 'PRODUCT' ? 'DRAFT' : null;
    this.objectsByIntent.set(input.remoteIntent, object);
    this.updateCount += 1;
    this.writeLog(`shopify.draft.updated remoteId=${object.remoteId}`);
    return { outcome: 'EFFECT', object };
  }

  private deleteObject(object: StoredShopifyObject): void {
    this.recordGraphQlCall(deleteOperationFor(object.contentKind));
    object.state = 'DELETED';
    object.isPublished = object.contentKind === 'PRODUCT' ? null : false;
    object.productStatus = object.contentKind === 'PRODUCT' ? 'DRAFT' : null;
    this.deleteCount += 1;
    this.writeLog(`shopify.draft.deleted remoteId=${object.remoteId}`);
  }

  private recordGraphQlCall(
    operationName: string,
    variables: Record<string, unknown> | null = null,
  ): void {
    this.graphqlCalls.push({
      endpoint: `/admin/api/${this.apiVersion}/graphql.json`,
      responseApiVersion: this.responseApiVersion,
      operationName,
      variables: variables === null ? null : structuredClone(variables),
    });
  }
}

export interface ShopifyDraftPublicationAdapterOptions {
  adapterKey: string;
  adapterVersion: string;
  providerApiVersion: string;
  supportedStableApiVersions: string[];
  api: VersionedFakeShopifyAdminApi;
  requiredScopesByContentKind: Record<ShopifyContentKind, string[]>;
  allowedShopDomains: string[];
}

/** Capability-limited Shopify content Adapter. It has no order, customer, theme, or REST surface. */
export class ShopifyDraftPublicationAdapter {
  private readonly adapterKey: string;
  private readonly adapterVersion: string;
  private readonly providerApiVersion: string;
  private readonly supportedStableApiVersions: ReadonlySet<string>;
  private readonly api: VersionedFakeShopifyAdminApi;
  private readonly requiredScopesByContentKind: Readonly<
    Record<ShopifyContentKind, readonly string[]>
  >;
  private readonly allowedShopDomains: ReadonlySet<string>;

  constructor(options: ShopifyDraftPublicationAdapterOptions) {
    this.adapterKey = options.adapterKey;
    this.adapterVersion = options.adapterVersion;
    this.providerApiVersion = options.providerApiVersion;
    this.supportedStableApiVersions = new Set(options.supportedStableApiVersions);
    this.api = options.api;
    this.requiredScopesByContentKind = {
      PAGE: [...options.requiredScopesByContentKind.PAGE],
      BLOG_ARTICLE: [...options.requiredScopesByContentKind.BLOG_ARTICLE],
      PRODUCT: [...options.requiredScopesByContentKind.PRODUCT],
    };
    this.allowedShopDomains = new Set(options.allowedShopDomains);
  }

  describe(): {
    adapterKey: string;
    adapterVersion: string;
    providerApiVersion: string;
    capabilities: string[];
    requiredScopes: string[];
  } {
    return {
      adapterKey: this.adapterKey,
      adapterVersion: this.adapterVersion,
      providerApiVersion: this.providerApiVersion,
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
      requiredScopes: [...new Set(Object.values(this.requiredScopesByContentKind).flat())].sort(
        (left, right) => left.localeCompare(right),
      ),
    };
  }

  validateAuthorization(command: ShopifyDraftCommand): Promise<ShopifyAuthorizationResult> {
    if (
      !isStableAdminApiVersion(this.providerApiVersion) ||
      !this.supportedStableApiVersions.has(this.providerApiVersion) ||
      this.api.apiVersion !== this.providerApiVersion
    ) {
      return Promise.resolve({
        outcome: 'INVALID',
        errorCode: 'SHOPIFY_API_VERSION_UNSUPPORTED',
      });
    }
    if (this.api.responseApiVersion !== this.providerApiVersion) {
      return Promise.resolve({
        outcome: 'INVALID',
        errorCode: 'SHOPIFY_RESPONSE_VERSION_MISMATCH',
      });
    }
    if (!isCanonicalShopDomain(command.target.shopDomain)) {
      return Promise.resolve({
        outcome: 'INVALID',
        errorCode: 'SHOPIFY_DOMAIN_NOT_ALLOWED',
      });
    }
    if (!this.allowedShopDomains.has(command.target.shopDomain)) {
      return Promise.resolve({
        outcome: 'INVALID',
        errorCode: 'SHOPIFY_DOMAIN_NOT_ALLOWED',
      });
    }
    if (this.api.shopDomain !== command.target.shopDomain) {
      return Promise.resolve({ outcome: 'INVALID', errorCode: 'SHOPIFY_SHOP_MISMATCH' });
    }
    if (!this.api.hasCredential()) {
      return Promise.resolve({ outcome: 'INVALID', errorCode: 'SHOPIFY_TOKEN_INVALID' });
    }
    const requiredScopes = this.requiredScopesByContentKind[command.target.contentKind];
    if (requiredScopes === undefined || !this.api.hasScopes(requiredScopes)) {
      return Promise.resolve({ outcome: 'INVALID', errorCode: 'SHOPIFY_SCOPE_INSUFFICIENT' });
    }
    return Promise.resolve({ outcome: 'VALID' });
  }

  async publish(command: ShopifyDraftCommand): Promise<ShopifyDraftPublishResult> {
    const authorization = await this.validateAuthorization(command);
    if (authorization.outcome === 'INVALID') {
      return {
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: authorization.errorCode,
      };
    }
    if (!validCommand(command)) {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'SHOPIFY_COMMAND_INVALID' };
    }

    const remoteIntent = remoteIntentFor(command);
    const existing = this.api.findByIntent(remoteIntent);
    if (existing !== undefined) {
      if (this.api.intentRequiresReconcile(remoteIntent)) {
        return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_RECONCILE_REQUIRED' };
      }
      return safeAppliedResult(command, existing);
    }

    const mutation = this.api.executeMutation({
      operationName: operationFor(command),
      variables: mutationVariablesFor(command),
      command,
      remoteIntent,
      revisionMapping: revisionMappingFor(command),
    });
    switch (mutation.outcome) {
      case 'GRAPHQL_ERRORS':
        return graphQlErrorResult(mutation.errors);
      case 'USER_ERRORS':
        return {
          outcome: 'DEFINITELY_NOT_APPLIED',
          errorCode: 'SHOPIFY_GRAPHQL_USER_ERROR',
          userErrors: mutation.errors.map((error) => ({
            field: error.field.join('.'),
            code: error.code,
          })),
        };
      case 'THROTTLED':
        return {
          outcome: 'RETRYABLE_FAILURE',
          errorCode: 'SHOPIFY_THROTTLED',
          retryAfterSeconds: throttleRetryAfterSeconds(mutation.throttle),
        };
      case 'TARGET_NOT_FOUND':
        return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'SHOPIFY_TARGET_NOT_FOUND' };
      case 'TARGET_CONFLICT':
        return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'SHOPIFY_TARGET_CONFLICT' };
      case 'EFFECT':
        if (mutation.failureMode === 'TIMEOUT_AFTER_EFFECT') {
          return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_REMOTE_TIMEOUT' };
        }
        if (mutation.object.state === 'PUBLISHED') {
          this.api.rollbackUnsafeObject(mutation.object);
          return {
            outcome: 'DEFINITELY_NOT_APPLIED',
            errorCode: 'SHOPIFY_UNSAFE_PUBLISH_STATE_ROLLED_BACK',
          };
        }
        return safeAppliedResult(command, mutation.object);
    }
  }

  async reconcile(command: ShopifyDraftCommand): Promise<ShopifyDraftPublishResult> {
    const authorization = await this.validateAuthorization(command);
    if (authorization.outcome === 'INVALID') {
      return {
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: authorization.errorCode,
      };
    }
    if (!validCommand(command)) {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'SHOPIFY_COMMAND_INVALID' };
    }
    const remoteIntent = remoteIntentFor(command);
    const object = this.api.reconcile(remoteIntent);
    if (object === undefined) {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'SHOPIFY_REMOTE_EFFECT_NOT_FOUND' };
    }
    return safeAppliedResult(command, object);
  }

  async rollback(
    command: ShopifyDraftCommand & { rollbackHandle: ShopifyDraftRollbackHandle },
  ): Promise<
    | {
        outcome: 'ROLLED_BACK';
        remoteRef: string;
        status: 'DELETED';
        rollbackHandle: ShopifyDraftRollbackHandle;
      }
    | { outcome: 'DEFINITELY_NOT_ROLLED_BACK' | 'UNKNOWN'; errorCode: string }
  > {
    const authorization = await this.validateAuthorization(command);
    if (authorization.outcome === 'INVALID' || !validCommand(command)) {
      return { outcome: 'DEFINITELY_NOT_ROLLED_BACK', errorCode: 'SHOPIFY_ROLLBACK_REJECTED' };
    }
    const handle = command.rollbackHandle;
    const remoteIntent = remoteIntentFor(command);
    const object = this.api.findById(handle.remoteId);
    if (
      handle.operation !== 'UNPUBLISH_DELETE_DRAFT' ||
      handle.shopDomain !== command.target.shopDomain ||
      handle.contentKind !== command.target.contentKind ||
      object === undefined ||
      object.remoteIntent !== remoteIntent ||
      !sameRevisionMapping(object.revisionMapping, revisionMappingFor(command)) ||
      object.contentKind !== command.target.contentKind ||
      object.handle !== command.target.handle
    ) {
      return {
        outcome: 'DEFINITELY_NOT_ROLLED_BACK',
        errorCode: 'SHOPIFY_ROLLBACK_TARGET_MISMATCH',
      };
    }
    if (!this.api.deleteOwnedDraft(object)) {
      return { outcome: 'UNKNOWN', errorCode: 'SHOPIFY_ROLLBACK_FAILED' };
    }
    return {
      outcome: 'ROLLED_BACK',
      remoteRef: adminUrlFor(command.target.shopDomain, object),
      status: 'DELETED',
      rollbackHandle: { ...handle },
    };
  }
}

function safeAppliedResult(
  command: ShopifyDraftCommand,
  object: StoredShopifyObject,
): ShopifyDraftPublishResult {
  const expectedMapping = revisionMappingFor(command);
  const expectedState = command.target.contentKind === 'PRODUCT' ? 'DRAFT' : 'UNPUBLISHED';
  if (
    object.state !== expectedState ||
    object.remoteIntent !== remoteIntentFor(command) ||
    !sameRevisionMapping(object.revisionMapping, expectedMapping) ||
    object.contentKind !== command.target.contentKind ||
    object.handle !== command.target.handle ||
    object.title !== command.document.title ||
    object.bodyHtml !== command.files['content.html'] ||
    (object.contentKind === 'PRODUCT'
      ? object.productStatus !== 'DRAFT' || object.isPublished !== null
      : object.isPublished !== false || object.productStatus !== null) ||
    (object.contentKind === 'BLOG_ARTICLE' &&
      (object.blogId !== command.target.blogId ||
        object.articleAuthor?.name !== command.target.articleAuthor?.name))
  ) {
    return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_REMOTE_REVISION_MISMATCH' };
  }
  const adminUrl = adminUrlFor(command.target.shopDomain, object);
  return {
    outcome: 'APPLIED',
    remoteRef: adminUrl,
    remoteId: object.remoteId,
    adminUrl,
    status: expectedState,
    isProductionLive: false,
    revisionMapping: { ...expectedMapping },
    rollbackHandle: {
      operation: 'UNPUBLISH_DELETE_DRAFT',
      shopDomain: command.target.shopDomain,
      contentKind: command.target.contentKind,
      remoteId: object.remoteId,
    },
  };
}

function operationFor(command: ShopifyDraftCommand): string {
  const update = command.target.remoteId !== undefined;
  switch (command.target.contentKind) {
    case 'PAGE':
      return update ? 'PageUpdate' : 'PageCreate';
    case 'BLOG_ARTICLE':
      return update ? 'ArticleUpdate' : 'ArticleCreate';
    case 'PRODUCT':
      return update ? 'ProductUpdate' : 'ProductCreate';
  }
}

/** Explicit official Admin GraphQL input mapping; every content kind is forced non-live. */
function mutationVariablesFor(command: ShopifyDraftCommand): Record<string, unknown> {
  const remoteId = command.target.remoteId;
  switch (command.target.contentKind) {
    case 'PAGE':
      return {
        ...(remoteId === undefined ? {} : { id: remoteId }),
        page: {
          title: command.document.title,
          body: command.files['content.html'],
          handle: command.target.handle,
          isPublished: false,
        },
      };
    case 'BLOG_ARTICLE':
      return {
        ...(remoteId === undefined ? {} : { id: remoteId }),
        article: {
          blogId: command.target.blogId,
          title: command.document.title,
          body: command.files['content.html'],
          handle: command.target.handle,
          isPublished: false,
          ...(command.target.articleAuthor === undefined
            ? {}
            : { author: { ...command.target.articleAuthor } }),
        },
      };
    case 'PRODUCT':
      return {
        product: {
          ...(remoteId === undefined ? {} : { id: remoteId }),
          title: command.document.title,
          descriptionHtml: command.files['content.html'],
          handle: command.target.handle,
          status: 'DRAFT',
        },
      };
  }
}

function deleteOperationFor(contentKind: ShopifyContentKind): string {
  switch (contentKind) {
    case 'PAGE':
      return 'PageDelete';
    case 'BLOG_ARTICLE':
      return 'ArticleDelete';
    case 'PRODUCT':
      return 'ProductDelete';
  }
}

function remoteIdFor(contentKind: ShopifyContentKind, numericId: number): string {
  const resource =
    contentKind === 'PAGE' ? 'Page' : contentKind === 'BLOG_ARTICLE' ? 'Article' : 'Product';
  return `gid://shopify/${resource}/${String(numericId)}`;
}

function adminUrlFor(shop: string, object: StoredShopifyObject): string {
  const shopHandle = shop.slice(0, -'.myshopify.com'.length);
  const numericId = object.remoteId.split('/').at(-1);
  const path =
    object.contentKind === 'PAGE'
      ? `pages/${numericId}`
      : object.contentKind === 'BLOG_ARTICLE'
        ? `content/articles/${numericId}`
        : `products/${numericId}`;
  return `https://admin.shopify.com/store/${shopHandle}/${path}`;
}

function revisionMappingFor(command: ShopifyDraftCommand): ShopifyRevisionMapping {
  return {
    artifactId: command.artifact.artifactId,
    artifactRevisionId: command.artifact.artifactRevisionId,
    artifactRevision: command.artifact.revision,
    artifactContentHash: command.artifact.contentHash,
    packageChecksum: command.packageChecksum,
  };
}

function remoteIntentFor(command: ShopifyDraftCommand): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        shopDomain: command.target.shopDomain,
        contentKind: command.target.contentKind,
        handle: command.target.handle,
        blogId: command.target.blogId ?? null,
        articleAuthor: command.target.articleAuthor ?? null,
        remoteId: command.target.remoteId ?? null,
        packageChecksum: command.packageChecksum,
        artifact: command.artifact,
        document: command.document,
        files: command.files,
      }),
      'utf8',
    )
    .digest('hex');
}

function sameRevisionMapping(left: ShopifyRevisionMapping, right: ShopifyRevisionMapping): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.artifactRevisionId === right.artifactRevisionId &&
    left.artifactRevision === right.artifactRevision &&
    left.artifactContentHash === right.artifactContentHash &&
    left.packageChecksum === right.packageChecksum
  );
}

function graphQlErrorResult(errors: readonly QueuedGraphQlError[]): ShopifyDraftPublishResult {
  return errors.some(({ code }) => code === 'ACCESS_DENIED')
    ? { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'SHOPIFY_GRAPHQL_ACCESS_DENIED' }
    : { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_GRAPHQL_ERROR' };
}

function throttleRetryAfterSeconds(throttle: QueuedThrottle): number {
  if (
    !Number.isFinite(throttle.requestedQueryCost) ||
    !Number.isFinite(throttle.currentlyAvailable) ||
    !Number.isFinite(throttle.restoreRate) ||
    throttle.restoreRate <= 0
  ) {
    return 1;
  }
  return Math.max(
    1,
    Math.ceil(
      Math.max(0, throttle.requestedQueryCost - throttle.currentlyAvailable) / throttle.restoreRate,
    ),
  );
}

function validCommand(command: ShopifyDraftCommand): boolean {
  if (
    !isCanonicalShopDomain(command.target.shopDomain) ||
    !/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/.test(command.target.handle) ||
    command.target.handle.length > 255 ||
    command.document.title.trim().length === 0 ||
    command.document.summary.trim().length === 0 ||
    command.files['content.md'].length === 0 ||
    command.files['content.html'].length === 0 ||
    !validJsonObject(command.files['structured-data.json']) ||
    !isSha256(command.packageChecksum) ||
    !isSha256(command.artifact.contentHash) ||
    !Number.isSafeInteger(command.artifact.revision) ||
    command.artifact.revision <= 0
  ) {
    return false;
  }
  if (command.target.remoteId !== undefined) {
    const expectedResource =
      command.target.contentKind === 'PAGE'
        ? 'Page'
        : command.target.contentKind === 'BLOG_ARTICLE'
          ? 'Article'
          : 'Product';
    if (
      !new RegExp(`^gid://shopify/${expectedResource}/[1-9][0-9]*$`).test(command.target.remoteId)
    ) {
      return false;
    }
  }
  if (command.target.contentKind === 'BLOG_ARTICLE') {
    return (
      command.target.blogId !== undefined &&
      /^gid:\/\/shopify\/Blog\/[1-9][0-9]*$/.test(command.target.blogId) &&
      command.target.articleAuthor !== undefined &&
      command.target.articleAuthor.name.trim().length > 0
    );
  }
  return command.target.blogId === undefined && command.target.articleAuthor === undefined;
}

function isStableAdminApiVersion(value: string): boolean {
  return /^20[0-9]{2}-(?:01|04|07|10)$/.test(value);
}

function isCanonicalShopDomain(value: string): boolean {
  return /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,59}[a-z0-9])\.myshopify\.com$/.test(value);
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function validJsonObject(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function cloneStoredObject(object: StoredShopifyObject): FakeShopifyRemoteObject {
  return {
    remoteId: object.remoteId,
    contentKind: object.contentKind,
    handle: object.handle,
    ...(object.blogId === undefined ? {} : { blogId: object.blogId }),
    ...(object.articleAuthor === undefined ? {} : { articleAuthor: { ...object.articleAuthor } }),
    title: object.title,
    bodyHtml: object.bodyHtml,
    state: object.state,
    isPublished: object.isPublished,
    productStatus: object.productStatus,
    remoteIntent: object.remoteIntent,
    revisionMapping: { ...object.revisionMapping },
  };
}
