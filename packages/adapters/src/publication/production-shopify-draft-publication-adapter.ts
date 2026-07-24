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
  PublicationAdapterReconciliationIntent,
  PublicationAdapterReconcileResult,
  PublicationAdapterRollbackCommand,
  PublicationAdapterRollbackResult,
} from '@aeostudio/application/channels-publishing';
import {
  decodeShopifyDraftTarget,
  decodeShopifyShopAuthorizationTarget,
  shopifyAuthorizationTargetFor,
  shopifyRequiredScopesFor,
} from '@aeostudio/contracts/channels';

export interface ShopifyGraphqlRequest {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface ShopifyGraphqlResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface ShopifyGraphqlTransport {
  request(input: ShopifyGraphqlRequest): Promise<ShopifyGraphqlResponse>;
}

export interface ShopifyCredentialRotationRequest {
  credentialId: string;
  tenantId: string;
  workspaceId: string;
  publicationId: string;
  shopDomain: string;
  apiVersion: string;
  expectedRotationVersion: string;
  reason: 'ACCESS_TOKEN_EXPIRED' | 'ACCESS_TOKEN_NEAR_EXPIRY' | 'REFRESH_TOKEN_EXPIRED';
}

/**
 * Boundary for a secret-store owner to refresh and atomically persist Shopify's newly rotated
 * access and refresh token pair. Implementations must compare expectedRotationVersion and must
 * never include either token in diagnostics. The publication Adapter intentionally does not call
 * this port until its Worker command carries a stable secret reference.
 */
export interface ShopifyCredentialRotationPort {
  rotateAndPersist(
    request: ShopifyCredentialRotationRequest,
  ): Promise<
    | { outcome: 'ROTATED' }
    | { outcome: 'REAUTHORIZATION_REQUIRED' }
    | { outcome: 'RETRYABLE_FAILURE' }
  >;
}

export interface ProductionShopifyDraftPublicationAdapterOptions {
  descriptor: PublicationAdapterDescriptor;
  transport: ShopifyGraphqlTransport;
  clock?: { now(): Date };
}

interface ShopifyOfflineCredential {
  shopDomain: string;
  apiVersion: string;
  accessToken: string;
  mode: 'NON_EXPIRING' | 'EXPIRING_PUBLIC';
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  credentialId?: string;
  rotationVersion?: string;
}

const ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1_000;
const SHOPIFY_GRAPHQL_MAX_REQUEST_BYTES = 8 * 1_024 * 1_024;

const AUTHORIZATION_QUERY = `query AEOStudioPublicationAuthorization {
  shop { myshopifyDomain }
  currentAppInstallation { accessScopes { handle } }
}`;
const FIND_PAGE_QUERY = `query AEOStudioFindPage($query: String!) {
  pages(first: 2, query: $query) {
    nodes {
      id
      title
      body
      handle
      isPublished
      metafield(namespace: "aeostudio", key: "publication") { value }
    }
  }
}`;
const GET_PAGE_BY_ID_QUERY = `query AEOStudioGetPageById($id: ID!) {
  page(id: $id) {
    id
    title
    body
    handle
    isPublished
    metafield(namespace: "aeostudio", key: "publication") { value }
  }
}`;
const CREATE_PAGE_MUTATION = `mutation AEOStudioCreatePage($page: PageCreateInput!) {
  pageCreate(page: $page) {
    page {
      id
      title
      body
      handle
      isPublished
      metafield(namespace: "aeostudio", key: "publication") { value }
    }
    userErrors { code field message }
  }
}`;
const DELETE_PAGE_MUTATION = `mutation AEOStudioDeletePage($id: ID!) {
  pageDelete(id: $id) {
    deletedPageId
    userErrors { code field message }
  }
}`;
const FIND_ARTICLE_QUERY = `query AEOStudioFindArticle($query: String!) {
  articles(first: 2, query: $query) {
    nodes {
      id
      title
      body
      handle
      isPublished
      blog { id }
      metafield(namespace: "aeostudio", key: "publication") { value }
    }
  }
}`;
const GET_ARTICLE_BY_ID_QUERY = `query AEOStudioGetArticleById($id: ID!) {
  article(id: $id) {
    id
    title
    body
    handle
    isPublished
    blog { id }
    metafield(namespace: "aeostudio", key: "publication") { value }
  }
}`;
const CREATE_ARTICLE_MUTATION = `mutation AEOStudioCreateArticle($article: ArticleCreateInput!) {
  articleCreate(article: $article) {
    article {
      id
      title
      body
      handle
      isPublished
      blog { id }
      metafield(namespace: "aeostudio", key: "publication") { value }
    }
    userErrors { code field message }
  }
}`;
const DELETE_ARTICLE_MUTATION = `mutation AEOStudioDeleteArticle($id: ID!) {
  articleDelete(id: $id) {
    deletedArticleId
    userErrors { code field message }
  }
}`;
const FIND_PRODUCT_QUERY = `query AEOStudioFindProduct($query: String!) {
  products(first: 2, query: $query) {
    nodes {
      id
      title
      descriptionHtml
      handle
      status
      metafield(namespace: "aeostudio", key: "publication") { value }
    }
  }
}`;
const GET_PRODUCT_BY_ID_QUERY = `query AEOStudioGetProductById($id: ID!) {
  product(id: $id) {
    id
    title
    descriptionHtml
    handle
    status
    metafield(namespace: "aeostudio", key: "publication") { value }
  }
}`;
const CREATE_PRODUCT_MUTATION = `mutation AEOStudioCreateProduct($product: ProductCreateInput!) {
  productCreate(product: $product) {
    product {
      id
      title
      descriptionHtml
      handle
      status
      metafield(namespace: "aeostudio", key: "publication") { value }
    }
    userErrors { field message }
  }
}`;
const DELETE_PRODUCT_MUTATION = `mutation AEOStudioDeleteProduct($input: ProductDeleteInput!) {
  productDelete(input: $input) {
    deletedProductId
    userErrors { field message }
  }
}`;

export class ProductionShopifyDraftPublicationAdapter implements PublicationAdapter {
  readonly adapterKey: string;
  readonly adapterVersion: string;

  private readonly descriptor: PublicationAdapterDescriptor;

  constructor(private readonly options: ProductionShopifyDraftPublicationAdapterOptions) {
    this.descriptor = structuredClone(options.descriptor);
    this.adapterKey = this.descriptor.adapterKey;
    this.adapterVersion = this.descriptor.adapterVersion;
  }

  describe(): PublicationAdapterDescriptor {
    return structuredClone(this.descriptor);
  }

  authorizationTargetFor(publicationTarget: string): string {
    return shopifyAuthorizationTargetFor(publicationTarget);
  }

  requiredScopesFor(input: { target: string }): string[] {
    return shopifyRequiredScopesFor(input.target);
  }

  async validateChannelAuthorization(
    input: ChannelAuthorizationValidationInput,
  ): Promise<ChannelAuthorizationValidationResult> {
    let target: ReturnType<typeof decodeShopifyShopAuthorizationTarget>;
    let credential: ShopifyOfflineCredential;
    try {
      target = decodeShopifyShopAuthorizationTarget(input.target);
      credential = parseShopifyOfflineCredential(input.secretValue);
    } catch {
      return { outcome: 'INVALID', reason: 'CREDENTIAL_INVALID' };
    }
    if (input.acceptedTermsVersion !== this.descriptor.termsVersion) {
      return { outcome: 'INVALID', reason: 'TERMS_MISMATCH' };
    }
    if (
      credentialRequiresRefresh(credential, this.now()) ||
      credential.shopDomain !== target.shopDomain ||
      credential.apiVersion !== this.descriptor.providerApiVersion
    ) {
      return credentialRequiresRefresh(credential, this.now())
        ? { outcome: 'UNKNOWN' }
        : { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
    }
    try {
      const response = await this.options.transport.request({
        url: shopifyGraphqlUrl(target.shopDomain, credential.apiVersion),
        headers: shopifyHeaders(credential.accessToken),
        body: { query: AUTHORIZATION_QUERY, variables: {} },
        timeoutMs: 10_000,
        maxResponseBytes: 512 * 1024,
      });
      if (
        response.status !== 200 ||
        headerValue(response.headers, 'x-shopify-api-version') !== credential.apiVersion
      ) {
        return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
      }
      const authorization = parseAuthorizationResponse(response.body);
      if (
        authorization === null ||
        authorization.shopDomain !== target.shopDomain ||
        authorization.scopes.size > 100
      ) {
        return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
      }
      const actualScopes = [...authorization.scopes].sort();
      if (
        actualScopes.some((scope) => scope.length < 1 || scope.length > 160) ||
        input.requestedScopes.some((scope) => !authorization.scopes.has(scope))
      ) {
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
    let target: ReturnType<typeof decodeShopifyDraftTarget>;
    let credential: ShopifyOfflineCredential;
    try {
      target = decodeShopifyDraftTarget(command.target);
      credential = parseShopifyOfflineCredential(command.secretValue);
    } catch {
      return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
    }
    if (credentialRequiresRefresh(credential, this.now())) {
      return { outcome: 'UNKNOWN' };
    }
    if (
      target.shopDomain !== credential.shopDomain ||
      target.apiVersion !== credential.apiVersion ||
      target.apiVersion !== this.descriptor.providerApiVersion
    ) {
      return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
    }
    try {
      const response = await this.options.transport.request({
        url: shopifyGraphqlUrl(target.shopDomain, target.apiVersion),
        headers: shopifyHeaders(credential.accessToken),
        body: { query: AUTHORIZATION_QUERY, variables: {} },
        timeoutMs: 10_000,
        maxResponseBytes: 512 * 1024,
      });
      if (
        response.status !== 200 ||
        headerValue(response.headers, 'x-shopify-api-version') !== target.apiVersion
      ) {
        return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
      }
      const authorization = parseAuthorizationResponse(response.body);
      if (authorization === null || authorization.shopDomain !== target.shopDomain) {
        return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
      }
      const required = shopifyRequiredScopesFor(command.target);
      return required.every((scope) => authorization.scopes.has(scope))
        ? { outcome: 'VALID' }
        : { outcome: 'INVALID', reason: 'SCOPE_INSUFFICIENT' };
    } catch {
      return { outcome: 'UNKNOWN' };
    }
  }

  preview(command: PublicationAdapterPreviewCommand): PublicationAdapterPreviewResult {
    decodeShopifyDraftTarget(command.target);
    return {
      packageChecksum: command.channelPackage.packageChecksum,
      files: { ...command.payload.files },
    };
  }

  credentialRotationRequestFor(
    command: PublicationAdapterCommand,
  ): ShopifyCredentialRotationRequest | null {
    let credential: ShopifyOfflineCredential;
    let target: ReturnType<typeof decodeShopifyDraftTarget>;
    try {
      credential = parseShopifyOfflineCredential(command.secretValue);
      target = decodeShopifyDraftTarget(command.target);
    } catch {
      return null;
    }
    const now = this.now().getTime();
    if (
      credential.mode !== 'EXPIRING_PUBLIC' ||
      credential.credentialId === undefined ||
      credential.rotationVersion === undefined ||
      credential.accessTokenExpiresAt === undefined ||
      credential.refreshTokenExpiresAt === undefined ||
      credential.accessTokenExpiresAt - now > ACCESS_TOKEN_REFRESH_SKEW_MS ||
      credential.shopDomain !== target.shopDomain ||
      credential.apiVersion !== target.apiVersion
    ) {
      return null;
    }
    return {
      credentialId: credential.credentialId,
      tenantId: command.channelPackage.tenantId,
      workspaceId: command.channelPackage.workspaceId,
      publicationId: command.publicationId,
      shopDomain: credential.shopDomain,
      apiVersion: credential.apiVersion,
      expectedRotationVersion: credential.rotationVersion,
      reason:
        credential.refreshTokenExpiresAt <= now
          ? 'REFRESH_TOKEN_EXPIRED'
          : credential.accessTokenExpiresAt <= now
            ? 'ACCESS_TOKEN_EXPIRED'
            : 'ACCESS_TOKEN_NEAR_EXPIRY',
    };
  }

  async publish(command: PublicationAdapterCommand): Promise<PublicationAdapterPublishResult> {
    if (secretValueRequiresCredentialRefresh(command.secretValue, this.now())) {
      return {
        outcome: 'RETRYABLE_FAILURE',
        errorCode: 'SHOPIFY_CREDENTIAL_REFRESH_REQUIRED',
      };
    }
    const authorization = await this.validateAuthorization(command);
    if (authorization.outcome === 'INVALID') {
      return {
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode:
          authorization.reason === 'SCOPE_INSUFFICIENT'
            ? 'SHOPIFY_SCOPE_INSUFFICIENT'
            : 'SHOPIFY_TARGET_NOT_ALLOWED',
      };
    }
    if (authorization.outcome === 'UNKNOWN') {
      return { outcome: 'RETRYABLE_FAILURE', errorCode: 'SHOPIFY_AUTHORIZATION_UNAVAILABLE' };
    }

    let prepared: ReturnType<typeof preparePageCommand>;
    let credential: ShopifyOfflineCredential;
    try {
      const target = decodeShopifyDraftTarget(command.target);
      if (target.destination.operation !== 'CREATE') {
        return {
          outcome: 'DEFINITELY_NOT_APPLIED',
          errorCode: 'SHOPIFY_UPDATE_REQUIRES_SAFE_RESTORE',
        };
      }
      credential = parseShopifyOfflineCredential(command.secretValue);
      if (target.destination.kind === 'BLOG_ARTICLE') {
        return await this.publishArticle(prepareArticleCommand(command, target), credential);
      }
      if (target.destination.kind === 'PRODUCT') {
        return await this.publishProduct(prepareProductCommand(command, target), credential);
      }
      if (target.destination.kind !== 'PAGE') {
        return {
          outcome: 'DEFINITELY_NOT_APPLIED',
          errorCode: 'SHOPIFY_CONTENT_KIND_NOT_INSTALLED',
        };
      }
      prepared = preparePageCommand(command, target);
    } catch {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'SHOPIFY_PACKAGE_INVALID' };
    }

    let mutationStarted = false;
    try {
      const existing = await this.findPage(prepared, credential);
      if (existing.outcome === 'EXACT')
        return appliedPage(prepared.target.shopDomain, existing.page);
      if (existing.outcome === 'UNSAFE_LIVE') {
        return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT' };
      }
      if (existing.outcome === 'CONFLICT') {
        return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'SHOPIFY_HANDLE_CONFLICT' };
      }
      if (existing.outcome === 'UNAVAILABLE') {
        return { outcome: 'RETRYABLE_FAILURE', errorCode: 'SHOPIFY_RECONCILE_LOOKUP_FAILED' };
      }

      const mutation = {
        query: CREATE_PAGE_MUTATION,
        variables: {
          page: {
            title: prepared.title,
            body: prepared.body,
            handle: prepared.target.destination.handle,
            isPublished: false,
            metafields: [
              {
                namespace: 'aeostudio',
                key: 'publication',
                type: 'json',
                value: prepared.marker,
              },
            ],
          },
        },
      };
      if (!graphqlRequestBodyFitsNodeTransport(mutation)) {
        return {
          outcome: 'DEFINITELY_NOT_APPLIED',
          errorCode: 'SHOPIFY_MUTATION_REQUEST_TOO_LARGE',
        };
      }
      mutationStarted = true;
      const response = await this.request(prepared.target, credential, mutation);
      const evidence = parsePageCreateEvidence(response);
      const page = evidence?.object ?? null;
      if (page !== null && page.isPublished && pageOwnedContentMatches(page, prepared)) {
        return this.compensateUnsafeCreation(
          prepared.target,
          credential,
          { query: DELETE_PAGE_MUTATION, variables: { id: page.id } },
          page.id,
          parseDeletedPageId,
          undefined,
          {
            kind: 'COMPENSATE_UNSAFE_CREATE',
            remoteRef: pageRemoteRef(prepared.target.shopDomain, page.id),
          },
        );
      }
      if (evidence?.hasErrors === true) {
        return page === null
          ? { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'SHOPIFY_MUTATION_REJECTED' }
          : { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_MUTATION_MIXED_RESULT' };
      }
      if (page === null) {
        return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_MUTATION_RESULT_UNKNOWN' };
      }
      if (!pageMatches(page, prepared)) {
        return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_DRAFT_READBACK_MISMATCH' };
      }
      return appliedPage(prepared.target.shopDomain, page);
    } catch {
      return mutationStarted
        ? { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_MUTATION_RESULT_UNKNOWN' }
        : { outcome: 'RETRYABLE_FAILURE', errorCode: 'SHOPIFY_PROVIDER_UNAVAILABLE' };
    }
  }

  async reconcile(
    command: PublicationAdapterReconcileCommand,
  ): Promise<PublicationAdapterReconcileResult> {
    if (secretValueRequiresCredentialRefresh(command.secretValue, this.now())) {
      return {
        outcome: 'RETRYABLE_FAILURE',
        errorCode: 'SHOPIFY_CREDENTIAL_REFRESH_REQUIRED',
      };
    }
    const authorization = await this.validateAuthorization(command);
    if (authorization.outcome === 'INVALID') {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'SHOPIFY_AUTHORIZATION_INVALID' };
    }
    if (authorization.outcome === 'UNKNOWN') {
      return { outcome: 'RETRYABLE_FAILURE', errorCode: 'SHOPIFY_AUTHORIZATION_UNAVAILABLE' };
    }
    try {
      const target = decodeShopifyDraftTarget(command.target);
      if (target.destination.operation !== 'CREATE') {
        return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'SHOPIFY_TARGET_UNSUPPORTED' };
      }
      const credential = parseShopifyOfflineCredential(command.secretValue);
      if (target.destination.kind === 'BLOG_ARTICLE') {
        const prepared = prepareArticleCommand(command, target);
        const result = await this.findArticle(prepared, credential);
        switch (result.outcome) {
          case 'EXACT':
            return appliedArticle(target.shopDomain, result.article);
          case 'MISSING':
            return {
              outcome: 'DEFINITELY_NOT_APPLIED',
              errorCode: 'SHOPIFY_REMOTE_EFFECT_NOT_FOUND',
            };
          case 'UNSAFE_LIVE':
            if (
              articleCompensationId(command.reconciliationIntent, target.shopDomain) !==
              result.article.id
            ) {
              return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT' };
            }
            return this.compensateUnsafeCreation(
              prepared.target,
              credential,
              {
                query: DELETE_ARTICLE_MUTATION,
                variables: { id: result.article.id },
              },
              result.article.id,
              parseDeletedArticleId,
            );
          case 'CONFLICT':
            return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT' };
          case 'UNAVAILABLE':
            return {
              outcome: 'RETRYABLE_FAILURE',
              errorCode: 'SHOPIFY_RECONCILE_LOOKUP_FAILED',
            };
        }
      }
      if (target.destination.kind === 'PRODUCT') {
        const prepared = prepareProductCommand(command, target);
        const result = await this.findProduct(prepared, credential);
        switch (result.outcome) {
          case 'EXACT':
            return appliedProduct(target.shopDomain, result.product);
          case 'MISSING':
            return {
              outcome: 'DEFINITELY_NOT_APPLIED',
              errorCode: 'SHOPIFY_REMOTE_EFFECT_NOT_FOUND',
            };
          case 'UNSAFE_LIVE':
            if (
              productCompensationId(command.reconciliationIntent, target.shopDomain) !==
              result.product.id
            ) {
              return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT' };
            }
            return this.compensateUnsafeCreation(
              prepared.target,
              credential,
              {
                query: DELETE_PRODUCT_MUTATION,
                variables: { input: { id: result.product.id } },
              },
              result.product.id,
              parseDeletedProductId,
              async () =>
                (await this.getProductById(prepared.target, credential, result.product.id))
                  .outcome === 'MISSING',
            );
          case 'CONFLICT':
            return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT' };
          case 'UNAVAILABLE':
            return {
              outcome: 'RETRYABLE_FAILURE',
              errorCode: 'SHOPIFY_RECONCILE_LOOKUP_FAILED',
            };
        }
      }
      if (target.destination.kind !== 'PAGE') {
        return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'SHOPIFY_TARGET_UNSUPPORTED' };
      }
      const prepared = preparePageCommand(command, target);
      const result = await this.findPage(prepared, credential);
      switch (result.outcome) {
        case 'EXACT':
          return appliedPage(target.shopDomain, result.page);
        case 'MISSING':
          return {
            outcome: 'DEFINITELY_NOT_APPLIED',
            errorCode: 'SHOPIFY_REMOTE_EFFECT_NOT_FOUND',
          };
        case 'UNSAFE_LIVE':
          if (
            pageCompensationId(command.reconciliationIntent, target.shopDomain) !== result.page.id
          ) {
            return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT' };
          }
          return this.compensateUnsafeCreation(
            prepared.target,
            credential,
            {
              query: DELETE_PAGE_MUTATION,
              variables: { id: result.page.id },
            },
            result.page.id,
            parseDeletedPageId,
          );
        case 'CONFLICT':
          return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT' };
        case 'UNAVAILABLE':
          return { outcome: 'RETRYABLE_FAILURE', errorCode: 'SHOPIFY_RECONCILE_LOOKUP_FAILED' };
      }
    } catch {
      return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_RECONCILIATION_UNAVAILABLE' };
    }
  }

  async rollback(
    command: PublicationAdapterRollbackCommand,
  ): Promise<PublicationAdapterRollbackResult> {
    if (secretValueRequiresCredentialRefresh(command.secretValue, this.now())) {
      return {
        outcome: 'UNKNOWN',
        errorCode: 'SHOPIFY_CREDENTIAL_REFRESH_REQUIRED',
      };
    }
    const authorization = await this.validateAuthorization(command);
    if (authorization.outcome === 'INVALID') {
      return {
        outcome: 'DEFINITELY_NOT_ROLLED_BACK',
        errorCode: 'SHOPIFY_AUTHORIZATION_INVALID',
      };
    }
    if (authorization.outcome === 'UNKNOWN') {
      return { outcome: 'UNKNOWN', errorCode: 'SHOPIFY_AUTHORIZATION_UNAVAILABLE' };
    }

    let mutationStarted = false;
    try {
      const target = decodeShopifyDraftTarget(command.target);
      if (target.destination.operation !== 'CREATE') {
        return {
          outcome: 'DEFINITELY_NOT_ROLLED_BACK',
          errorCode: 'SHOPIFY_ROLLBACK_TARGET_UNSUPPORTED',
        };
      }
      const credential = parseShopifyOfflineCredential(command.secretValue);
      if (target.destination.kind === 'BLOG_ARTICLE') {
        const prepared = prepareArticleCommand(command, target);
        const remoteId = articleIdFromRemoteRef(command.remoteRef, target.shopDomain);
        if (remoteId === null) {
          return {
            outcome: 'DEFINITELY_NOT_ROLLED_BACK',
            errorCode: 'SHOPIFY_ROLLBACK_REMOTE_REF_MISMATCH',
          };
        }
        const existing = await this.getArticleById(prepared.target, credential, remoteId);
        if (existing.outcome === 'MISSING') {
          return { outcome: 'ROLLED_BACK', remoteRef: command.remoteRef };
        }
        if (existing.outcome === 'UNAVAILABLE') {
          return { outcome: 'UNKNOWN', errorCode: 'SHOPIFY_ROLLBACK_LOOKUP_FAILED' };
        }
        if (
          existing.article.marker !== prepared.marker ||
          existing.article.isPublished ||
          existing.article.blogId !== target.destination.blogId
        ) {
          return {
            outcome: 'DEFINITELY_NOT_ROLLED_BACK',
            errorCode: 'SHOPIFY_ROLLBACK_REMOTE_EFFECT_CONFLICT',
          };
        }
        const mutation = {
          query: DELETE_ARTICLE_MUTATION,
          variables: { id: remoteId },
        };
        if (!graphqlRequestBodyFitsNodeTransport(mutation)) {
          return {
            outcome: 'DEFINITELY_NOT_ROLLED_BACK',
            errorCode: 'SHOPIFY_ROLLBACK_REQUEST_TOO_LARGE',
          };
        }
        mutationStarted = true;
        const response = await this.request(target, credential, mutation);
        const deletedArticleId = parseDeletedArticleId(response);
        if (deletedArticleId === remoteId) {
          return { outcome: 'ROLLED_BACK', remoteRef: command.remoteRef };
        }
        if (responseHasMixedDeleteEvidence(response, 'articleDelete', 'deletedArticleId')) {
          return { outcome: 'UNKNOWN', errorCode: 'SHOPIFY_ROLLBACK_RESULT_UNKNOWN' };
        }
        return responseHasUserErrors(response, 'articleDelete')
          ? {
              outcome: 'DEFINITELY_NOT_ROLLED_BACK',
              errorCode: 'SHOPIFY_ROLLBACK_REJECTED',
            }
          : { outcome: 'UNKNOWN', errorCode: 'SHOPIFY_ROLLBACK_RESULT_UNKNOWN' };
      }
      if (target.destination.kind === 'PRODUCT') {
        const prepared = prepareProductCommand(command, target);
        const remoteId = productIdFromRemoteRef(command.remoteRef, target.shopDomain);
        if (remoteId === null) {
          return {
            outcome: 'DEFINITELY_NOT_ROLLED_BACK',
            errorCode: 'SHOPIFY_ROLLBACK_REMOTE_REF_MISMATCH',
          };
        }
        const existing = await this.getProductById(prepared.target, credential, remoteId);
        if (existing.outcome === 'MISSING') {
          return { outcome: 'ROLLED_BACK', remoteRef: command.remoteRef };
        }
        if (existing.outcome === 'UNAVAILABLE') {
          return { outcome: 'UNKNOWN', errorCode: 'SHOPIFY_ROLLBACK_LOOKUP_FAILED' };
        }
        if (existing.product.marker !== prepared.marker || existing.product.status !== 'DRAFT') {
          return {
            outcome: 'DEFINITELY_NOT_ROLLED_BACK',
            errorCode: 'SHOPIFY_ROLLBACK_REMOTE_EFFECT_CONFLICT',
          };
        }
        const mutation = {
          query: DELETE_PRODUCT_MUTATION,
          variables: { input: { id: remoteId } },
        };
        if (!graphqlRequestBodyFitsNodeTransport(mutation)) {
          return {
            outcome: 'DEFINITELY_NOT_ROLLED_BACK',
            errorCode: 'SHOPIFY_ROLLBACK_REQUEST_TOO_LARGE',
          };
        }
        mutationStarted = true;
        const response = await this.request(target, credential, mutation);
        const deletedProductId = parseDeletedProductId(response);
        if (deletedProductId === remoteId) {
          return { outcome: 'ROLLED_BACK', remoteRef: command.remoteRef };
        }
        if (responseHasMixedDeleteEvidence(response, 'productDelete', 'deletedProductId')) {
          return { outcome: 'UNKNOWN', errorCode: 'SHOPIFY_ROLLBACK_RESULT_UNKNOWN' };
        }
        return responseHasUserErrors(response, 'productDelete')
          ? {
              outcome: 'DEFINITELY_NOT_ROLLED_BACK',
              errorCode: 'SHOPIFY_ROLLBACK_REJECTED',
            }
          : { outcome: 'UNKNOWN', errorCode: 'SHOPIFY_ROLLBACK_RESULT_UNKNOWN' };
      }
      if (target.destination.kind !== 'PAGE') {
        return {
          outcome: 'DEFINITELY_NOT_ROLLED_BACK',
          errorCode: 'SHOPIFY_ROLLBACK_TARGET_UNSUPPORTED',
        };
      }
      const prepared = preparePageCommand(command, target);
      const remoteId = pageIdFromRemoteRef(command.remoteRef, target.shopDomain);
      if (remoteId === null) {
        return {
          outcome: 'DEFINITELY_NOT_ROLLED_BACK',
          errorCode: 'SHOPIFY_ROLLBACK_REMOTE_REF_MISMATCH',
        };
      }
      const existing = await this.getPageById(prepared.target, credential, remoteId);
      if (existing.outcome === 'MISSING') {
        return { outcome: 'ROLLED_BACK', remoteRef: command.remoteRef };
      }
      if (existing.outcome === 'UNAVAILABLE') {
        return { outcome: 'UNKNOWN', errorCode: 'SHOPIFY_ROLLBACK_LOOKUP_FAILED' };
      }
      if (existing.page.marker !== prepared.marker || existing.page.isPublished) {
        return {
          outcome: 'DEFINITELY_NOT_ROLLED_BACK',
          errorCode: 'SHOPIFY_ROLLBACK_REMOTE_EFFECT_CONFLICT',
        };
      }

      const mutation = {
        query: DELETE_PAGE_MUTATION,
        variables: { id: remoteId },
      };
      if (!graphqlRequestBodyFitsNodeTransport(mutation)) {
        return {
          outcome: 'DEFINITELY_NOT_ROLLED_BACK',
          errorCode: 'SHOPIFY_ROLLBACK_REQUEST_TOO_LARGE',
        };
      }
      mutationStarted = true;
      const response = await this.request(target, credential, mutation);
      const deletedPageId = parseDeletedPageId(response);
      if (deletedPageId === remoteId) {
        return { outcome: 'ROLLED_BACK', remoteRef: command.remoteRef };
      }
      if (responseHasMixedDeleteEvidence(response, 'pageDelete', 'deletedPageId')) {
        return { outcome: 'UNKNOWN', errorCode: 'SHOPIFY_ROLLBACK_RESULT_UNKNOWN' };
      }
      return responseHasUserErrors(response, 'pageDelete')
        ? {
            outcome: 'DEFINITELY_NOT_ROLLED_BACK',
            errorCode: 'SHOPIFY_ROLLBACK_REJECTED',
          }
        : { outcome: 'UNKNOWN', errorCode: 'SHOPIFY_ROLLBACK_RESULT_UNKNOWN' };
    } catch {
      return mutationStarted
        ? { outcome: 'UNKNOWN', errorCode: 'SHOPIFY_ROLLBACK_RESULT_UNKNOWN' }
        : { outcome: 'UNKNOWN', errorCode: 'SHOPIFY_ROLLBACK_UNAVAILABLE' };
    }
  }

  private async findPage(
    prepared: PreparedPageCommand,
    credential: ShopifyOfflineCredential,
  ): Promise<
    | { outcome: 'EXACT'; page: ShopifyPage }
    | { outcome: 'UNSAFE_LIVE'; page: ShopifyPage }
    | { outcome: 'MISSING' }
    | { outcome: 'CONFLICT' }
    | { outcome: 'UNAVAILABLE' }
  > {
    const response = await this.request(prepared.target, credential, {
      query: FIND_PAGE_QUERY,
      variables: { query: `handle:${prepared.target.destination.handle}` },
    });
    const pages = parsePageQuery(response);
    if (pages === null) return { outcome: 'UNAVAILABLE' };
    const exact = pages.find((page) => pageMatches(page, prepared));
    if (exact !== undefined) return { outcome: 'EXACT', page: exact };
    if (
      pages.length === 1 &&
      pages[0] !== undefined &&
      pages[0].isPublished &&
      pageOwnedContentMatches(pages[0], prepared)
    ) {
      return { outcome: 'UNSAFE_LIVE', page: pages[0] };
    }
    return pages.length === 0 ? { outcome: 'MISSING' } : { outcome: 'CONFLICT' };
  }

  private async getPageById(
    target: ShopifyPageCreateTarget,
    credential: ShopifyOfflineCredential,
    id: string,
  ): Promise<
    { outcome: 'EXACT'; page: ShopifyPage } | { outcome: 'MISSING' } | { outcome: 'UNAVAILABLE' }
  > {
    const response = await this.request(target, credential, {
      query: GET_PAGE_BY_ID_QUERY,
      variables: { id },
    });
    const page = parsePageByIdQuery(response);
    if (page === undefined || (page !== null && page.id !== id)) return { outcome: 'UNAVAILABLE' };
    return page === null ? { outcome: 'MISSING' } : { outcome: 'EXACT', page };
  }

  private async publishArticle(
    prepared: PreparedArticleCommand,
    credential: ShopifyOfflineCredential,
  ): Promise<PublicationAdapterPublishResult> {
    let mutationStarted = false;
    try {
      const existing = await this.findArticle(prepared, credential);
      if (existing.outcome === 'EXACT') {
        return appliedArticle(prepared.target.shopDomain, existing.article);
      }
      if (existing.outcome === 'UNSAFE_LIVE') {
        return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT' };
      }
      if (existing.outcome === 'CONFLICT') {
        return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'SHOPIFY_HANDLE_CONFLICT' };
      }
      if (existing.outcome === 'UNAVAILABLE') {
        return { outcome: 'RETRYABLE_FAILURE', errorCode: 'SHOPIFY_RECONCILE_LOOKUP_FAILED' };
      }

      const mutation = {
        query: CREATE_ARTICLE_MUTATION,
        variables: {
          article: {
            blogId: prepared.target.destination.blogId,
            title: prepared.title,
            body: prepared.body,
            handle: prepared.target.destination.handle,
            isPublished: false,
            author: { name: 'AEO Studio Publisher' },
            metafields: [
              {
                namespace: 'aeostudio',
                key: 'publication',
                type: 'json',
                value: prepared.marker,
              },
            ],
          },
        },
      };
      if (!graphqlRequestBodyFitsNodeTransport(mutation)) {
        return {
          outcome: 'DEFINITELY_NOT_APPLIED',
          errorCode: 'SHOPIFY_MUTATION_REQUEST_TOO_LARGE',
        };
      }
      mutationStarted = true;
      const response = await this.request(prepared.target, credential, mutation);
      const evidence = parseArticleCreateEvidence(response);
      const article = evidence?.object ?? null;
      if (
        article !== null &&
        article.isPublished &&
        articleOwnedContentMatches(article, prepared)
      ) {
        return this.compensateUnsafeCreation(
          prepared.target,
          credential,
          { query: DELETE_ARTICLE_MUTATION, variables: { id: article.id } },
          article.id,
          parseDeletedArticleId,
          undefined,
          {
            kind: 'COMPENSATE_UNSAFE_CREATE',
            remoteRef: articleRemoteRef(prepared.target.shopDomain, article.id),
          },
        );
      }
      if (evidence?.hasErrors === true) {
        return article === null
          ? { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'SHOPIFY_MUTATION_REJECTED' }
          : { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_MUTATION_MIXED_RESULT' };
      }
      if (article === null) {
        return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_MUTATION_RESULT_UNKNOWN' };
      }
      if (!articleMatches(article, prepared)) {
        return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_DRAFT_READBACK_MISMATCH' };
      }
      return appliedArticle(prepared.target.shopDomain, article);
    } catch {
      return mutationStarted
        ? { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_MUTATION_RESULT_UNKNOWN' }
        : { outcome: 'RETRYABLE_FAILURE', errorCode: 'SHOPIFY_PROVIDER_UNAVAILABLE' };
    }
  }

  private async findArticle(
    prepared: PreparedArticleCommand,
    credential: ShopifyOfflineCredential,
  ): Promise<
    | { outcome: 'EXACT'; article: ShopifyArticle }
    | { outcome: 'UNSAFE_LIVE'; article: ShopifyArticle }
    | { outcome: 'MISSING' }
    | { outcome: 'CONFLICT' }
    | { outcome: 'UNAVAILABLE' }
  > {
    const blogNumericId = prepared.target.destination.blogId.split('/').at(-1);
    if (blogNumericId === undefined) return { outcome: 'UNAVAILABLE' };
    const response = await this.request(prepared.target, credential, {
      query: FIND_ARTICLE_QUERY,
      variables: {
        query: `handle:${prepared.target.destination.handle} blog_id:${blogNumericId}`,
      },
    });
    const articles = parseArticleQuery(response);
    if (articles === null) return { outcome: 'UNAVAILABLE' };
    const exact = articles.find((article) => articleMatches(article, prepared));
    if (exact !== undefined) return { outcome: 'EXACT', article: exact };
    if (
      articles.length === 1 &&
      articles[0] !== undefined &&
      articles[0].isPublished &&
      articleOwnedContentMatches(articles[0], prepared)
    ) {
      return { outcome: 'UNSAFE_LIVE', article: articles[0] };
    }
    return articles.length === 0 ? { outcome: 'MISSING' } : { outcome: 'CONFLICT' };
  }

  private async getArticleById(
    target: ShopifyArticleCreateTarget,
    credential: ShopifyOfflineCredential,
    id: string,
  ): Promise<
    | { outcome: 'EXACT'; article: ShopifyArticle }
    | { outcome: 'MISSING' }
    | { outcome: 'UNAVAILABLE' }
  > {
    const response = await this.request(target, credential, {
      query: GET_ARTICLE_BY_ID_QUERY,
      variables: { id },
    });
    const article = parseArticleByIdQuery(response);
    if (article === undefined || (article !== null && article.id !== id)) {
      return { outcome: 'UNAVAILABLE' };
    }
    return article === null ? { outcome: 'MISSING' } : { outcome: 'EXACT', article };
  }

  private async publishProduct(
    prepared: PreparedProductCommand,
    credential: ShopifyOfflineCredential,
  ): Promise<PublicationAdapterPublishResult> {
    let mutationStarted = false;
    try {
      const existing = await this.findProduct(prepared, credential);
      if (existing.outcome === 'EXACT') {
        return appliedProduct(prepared.target.shopDomain, existing.product);
      }
      if (existing.outcome === 'UNSAFE_LIVE') {
        return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_REMOTE_EFFECT_CONFLICT' };
      }
      if (existing.outcome === 'CONFLICT') {
        return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'SHOPIFY_HANDLE_CONFLICT' };
      }
      if (existing.outcome === 'UNAVAILABLE') {
        return { outcome: 'RETRYABLE_FAILURE', errorCode: 'SHOPIFY_RECONCILE_LOOKUP_FAILED' };
      }

      const mutation = {
        query: CREATE_PRODUCT_MUTATION,
        variables: {
          product: {
            title: prepared.title,
            descriptionHtml: prepared.body,
            handle: prepared.target.destination.handle,
            status: 'DRAFT',
            metafields: [
              {
                namespace: 'aeostudio',
                key: 'publication',
                type: 'json',
                value: prepared.marker,
              },
            ],
          },
        },
      };
      if (!graphqlRequestBodyFitsNodeTransport(mutation)) {
        return {
          outcome: 'DEFINITELY_NOT_APPLIED',
          errorCode: 'SHOPIFY_MUTATION_REQUEST_TOO_LARGE',
        };
      }
      mutationStarted = true;
      const response = await this.request(prepared.target, credential, mutation);
      const evidence = parseProductCreateEvidence(response);
      const product = evidence?.object ?? null;
      if (
        product !== null &&
        product.status !== 'DRAFT' &&
        productOwnedContentMatches(product, prepared)
      ) {
        return this.compensateUnsafeCreation(
          prepared.target,
          credential,
          {
            query: DELETE_PRODUCT_MUTATION,
            variables: { input: { id: product.id } },
          },
          product.id,
          parseDeletedProductId,
          async () =>
            (await this.getProductById(prepared.target, credential, product.id)).outcome ===
            'MISSING',
          {
            kind: 'COMPENSATE_UNSAFE_CREATE',
            remoteRef: productRemoteRef(prepared.target.shopDomain, product.id),
          },
        );
      }
      if (evidence?.hasErrors === true) {
        return product === null
          ? { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'SHOPIFY_MUTATION_REJECTED' }
          : { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_MUTATION_MIXED_RESULT' };
      }
      if (product === null) {
        return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_MUTATION_RESULT_UNKNOWN' };
      }
      if (!productMatches(product, prepared)) {
        return { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_DRAFT_READBACK_MISMATCH' };
      }
      return appliedProduct(prepared.target.shopDomain, product);
    } catch {
      return mutationStarted
        ? { outcome: 'AMBIGUOUS', errorCode: 'SHOPIFY_MUTATION_RESULT_UNKNOWN' }
        : { outcome: 'RETRYABLE_FAILURE', errorCode: 'SHOPIFY_PROVIDER_UNAVAILABLE' };
    }
  }

  private async findProduct(
    prepared: PreparedProductCommand,
    credential: ShopifyOfflineCredential,
  ): Promise<
    | { outcome: 'EXACT'; product: ShopifyProduct }
    | { outcome: 'UNSAFE_LIVE'; product: ShopifyProduct }
    | { outcome: 'MISSING' }
    | { outcome: 'CONFLICT' }
    | { outcome: 'UNAVAILABLE' }
  > {
    const response = await this.request(prepared.target, credential, {
      query: FIND_PRODUCT_QUERY,
      variables: { query: `handle:${prepared.target.destination.handle}` },
    });
    const products = parseProductQuery(response);
    if (products === null) return { outcome: 'UNAVAILABLE' };
    const exact = products.find((product) => productMatches(product, prepared));
    if (exact !== undefined) return { outcome: 'EXACT', product: exact };
    if (
      products.length === 1 &&
      products[0] !== undefined &&
      products[0].status !== 'DRAFT' &&
      productOwnedContentMatches(products[0], prepared)
    ) {
      return { outcome: 'UNSAFE_LIVE', product: products[0] };
    }
    return products.length === 0 ? { outcome: 'MISSING' } : { outcome: 'CONFLICT' };
  }

  private async getProductById(
    target: ShopifyProductCreateTarget,
    credential: ShopifyOfflineCredential,
    id: string,
  ): Promise<
    | { outcome: 'EXACT'; product: ShopifyProduct }
    | { outcome: 'MISSING' }
    | { outcome: 'UNAVAILABLE' }
  > {
    const response = await this.request(target, credential, {
      query: GET_PRODUCT_BY_ID_QUERY,
      variables: { id },
    });
    const product = parseProductByIdQuery(response);
    if (product === undefined || (product !== null && product.id !== id)) {
      return { outcome: 'UNAVAILABLE' };
    }
    return product === null ? { outcome: 'MISSING' } : { outcome: 'EXACT', product };
  }

  private async request(
    target: ReturnType<typeof decodeShopifyDraftTarget>,
    credential: ShopifyOfflineCredential,
    body: ShopifyGraphqlRequest['body'],
  ): Promise<ShopifyGraphqlResponse> {
    const response = await this.options.transport.request({
      url: shopifyGraphqlUrl(target.shopDomain, target.apiVersion),
      headers: shopifyHeaders(credential.accessToken),
      body,
      timeoutMs: 10_000,
      maxResponseBytes: 1024 * 1024,
    });
    if (
      response.status !== 200 ||
      headerValue(response.headers, 'x-shopify-api-version') !== target.apiVersion
    ) {
      throw new Error('SHOPIFY_API_VERSION_OR_STATUS_INVALID');
    }
    return response;
  }

  private async compensateUnsafeCreation(
    target: ShopifyPageCreateTarget | ShopifyArticleCreateTarget | ShopifyProductCreateTarget,
    credential: ShopifyOfflineCredential,
    body: ShopifyGraphqlRequest['body'],
    expectedDeletedId: string,
    parseDeletedId: (response: ShopifyGraphqlResponse) => string | null,
    confirmAbsent?: () => Promise<boolean>,
    failureIntent?: PublicationAdapterReconciliationIntent,
  ): Promise<PublicationAdapterPublishResult> {
    if (!graphqlRequestBodyFitsNodeTransport(body)) {
      return {
        outcome: 'AMBIGUOUS',
        errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATION_FAILED',
        ...(failureIntent === undefined ? {} : { reconciliationIntent: failureIntent }),
      };
    }
    try {
      const response = await this.request(target, credential, body);
      if (
        parseDeletedId(response) !== expectedDeletedId ||
        (confirmAbsent !== undefined && !(await confirmAbsent()))
      ) {
        return {
          outcome: 'AMBIGUOUS',
          errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATION_FAILED',
          ...(failureIntent === undefined ? {} : { reconciliationIntent: failureIntent }),
        };
      }
      return {
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATED',
      };
    } catch {
      return {
        outcome: 'AMBIGUOUS',
        errorCode: 'SHOPIFY_UNSAFE_CREATE_COMPENSATION_FAILED',
        ...(failureIntent === undefined ? {} : { reconciliationIntent: failureIntent }),
      };
    }
  }

  private now(): Date {
    return this.options.clock?.now() ?? new Date();
  }
}

function parseShopifyOfflineCredential(secretValue: string): ShopifyOfflineCredential {
  let value: unknown;
  try {
    value = JSON.parse(secretValue) as unknown;
  } catch {
    throw new Error('SHOPIFY_CREDENTIAL_INVALID');
  }
  if (!isRecord(value)) {
    throw new Error('SHOPIFY_CREDENTIAL_INVALID');
  }
  if (value.schemaVersion === 'aeostudio.shopify-offline-credential.v1') {
    if (
      !hasExactKeys(value, ['schemaVersion', 'shopDomain', 'apiVersion', 'accessToken']) ||
      typeof value.shopDomain !== 'string' ||
      typeof value.apiVersion !== 'string' ||
      !validSecret(value.accessToken)
    ) {
      throw new Error('SHOPIFY_CREDENTIAL_INVALID');
    }
    return {
      shopDomain: value.shopDomain,
      apiVersion: value.apiVersion,
      accessToken: value.accessToken,
      mode: 'NON_EXPIRING',
    };
  }
  if (
    value.schemaVersion !== 'aeostudio.shopify-expiring-offline-credential.v2' ||
    !hasExactKeys(value, [
      'schemaVersion',
      'distribution',
      'credentialId',
      'shopDomain',
      'apiVersion',
      'accessToken',
      'issuedAt',
      'accessTokenExpiresAt',
      'refreshToken',
      'refreshTokenExpiresAt',
      'rotationVersion',
    ]) ||
    value.distribution !== 'PUBLIC' ||
    typeof value.credentialId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,256}$/u.test(value.credentialId) ||
    typeof value.shopDomain !== 'string' ||
    typeof value.apiVersion !== 'string' ||
    !validSecret(value.accessToken) ||
    !validSecret(value.refreshToken) ||
    typeof value.rotationVersion !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.rotationVersion)
  ) {
    throw new Error('SHOPIFY_CREDENTIAL_INVALID');
  }
  const issuedAt = parseCanonicalTimestamp(value.issuedAt);
  const accessTokenExpiresAt = parseCanonicalTimestamp(value.accessTokenExpiresAt);
  const refreshTokenExpiresAt = parseCanonicalTimestamp(value.refreshTokenExpiresAt);
  if (
    issuedAt === null ||
    accessTokenExpiresAt === null ||
    refreshTokenExpiresAt === null ||
    accessTokenExpiresAt - issuedAt !== 3_600_000 ||
    refreshTokenExpiresAt <= accessTokenExpiresAt ||
    refreshTokenExpiresAt - issuedAt > 7_776_000_000
  ) {
    throw new Error('SHOPIFY_CREDENTIAL_INVALID');
  }
  return {
    shopDomain: value.shopDomain,
    apiVersion: value.apiVersion,
    accessToken: value.accessToken,
    mode: 'EXPIRING_PUBLIC',
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    credentialId: value.credentialId,
    rotationVersion: value.rotationVersion,
  };
}

function secretValueRequiresCredentialRefresh(secretValue: string, now: Date): boolean {
  try {
    return credentialRequiresRefresh(parseShopifyOfflineCredential(secretValue), now);
  } catch {
    return false;
  }
}

function credentialRequiresRefresh(credential: ShopifyOfflineCredential, now: Date): boolean {
  return (
    credential.mode === 'EXPIRING_PUBLIC' &&
    credential.accessTokenExpiresAt !== undefined &&
    credential.accessTokenExpiresAt - now.getTime() <= ACCESS_TOKEN_REFRESH_SKEW_MS
  );
}

function validSecret(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 2_048 &&
    !hasControlCharacter(value)
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function parseCanonicalTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? parsed.getTime()
    : null;
}

function graphqlRequestBodyFitsNodeTransport(body: ShopifyGraphqlRequest['body']): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(body), 'utf8') <= SHOPIFY_GRAPHQL_MAX_REQUEST_BYTES;
  } catch {
    return false;
  }
}

function shopifyGraphqlUrl(shopDomain: string, apiVersion: string): string {
  return `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
}

function shopifyHeaders(accessToken: string): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-shopify-access-token': accessToken,
  };
}

function parseAuthorizationResponse(
  value: unknown,
): { shopDomain: string; scopes: ReadonlySet<string> } | null {
  if (!isRecord(value) || 'errors' in value || !isRecord(value.data)) return null;
  const shop = value.data.shop;
  const installation = value.data.currentAppInstallation;
  if (
    !isRecord(shop) ||
    typeof shop.myshopifyDomain !== 'string' ||
    !isRecord(installation) ||
    !Array.isArray(installation.accessScopes)
  ) {
    return null;
  }
  const scopes = new Set<string>();
  for (const entry of installation.accessScopes) {
    if (!isRecord(entry) || typeof entry.handle !== 'string') return null;
    scopes.add(entry.handle);
  }
  return { shopDomain: shop.myshopifyDomain, scopes };
}

type ShopifyDraftTarget = ReturnType<typeof decodeShopifyDraftTarget>;
type ShopifyPageCreateTarget = Omit<ShopifyDraftTarget, 'destination'> & {
  destination: Extract<ShopifyDraftTarget['destination'], { kind: 'PAGE'; operation: 'CREATE' }>;
};
type ShopifyArticleCreateTarget = Omit<ShopifyDraftTarget, 'destination'> & {
  destination: Extract<
    ShopifyDraftTarget['destination'],
    { kind: 'BLOG_ARTICLE'; operation: 'CREATE' }
  >;
};
type ShopifyProductCreateTarget = Omit<ShopifyDraftTarget, 'destination'> & {
  destination: Extract<ShopifyDraftTarget['destination'], { kind: 'PRODUCT'; operation: 'CREATE' }>;
};

interface PreparedPageCommand {
  target: ShopifyPageCreateTarget;
  title: string;
  body: string;
  marker: string;
}

interface PreparedArticleCommand {
  target: ShopifyArticleCreateTarget;
  title: string;
  body: string;
  marker: string;
}

interface PreparedProductCommand {
  target: ShopifyProductCreateTarget;
  title: string;
  body: string;
  marker: string;
}

interface ShopifyPage {
  id: string;
  title: string;
  body: string;
  handle: string;
  isPublished: boolean;
  marker: string | null;
}

interface ShopifyArticle {
  id: string;
  blogId: string;
  title: string;
  body: string;
  handle: string;
  isPublished: boolean;
  marker: string | null;
}

interface ShopifyProduct {
  id: string;
  title: string;
  descriptionHtml: string;
  handle: string;
  status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
  marker: string | null;
}

function preparePageCommand(
  command: PublicationAdapterCommand,
  target: ReturnType<typeof decodeShopifyDraftTarget>,
): PreparedPageCommand {
  const destination = target.destination;
  if (destination.kind !== 'PAGE' || destination.operation !== 'CREATE') {
    throw new Error('SHOPIFY_PAGE_CREATE_REQUIRED');
  }
  return {
    target: { ...target, destination },
    ...preparePackageContent(command),
  };
}

function prepareArticleCommand(
  command: PublicationAdapterCommand,
  target: ReturnType<typeof decodeShopifyDraftTarget>,
): PreparedArticleCommand {
  const destination = target.destination;
  if (destination.kind !== 'BLOG_ARTICLE' || destination.operation !== 'CREATE') {
    throw new Error('SHOPIFY_ARTICLE_CREATE_REQUIRED');
  }
  return {
    target: { ...target, destination },
    ...preparePackageContent(command),
  };
}

function prepareProductCommand(
  command: PublicationAdapterCommand,
  target: ReturnType<typeof decodeShopifyDraftTarget>,
): PreparedProductCommand {
  const destination = target.destination;
  if (destination.kind !== 'PRODUCT' || destination.operation !== 'CREATE') {
    throw new Error('SHOPIFY_PRODUCT_CREATE_REQUIRED');
  }
  return {
    target: { ...target, destination },
    ...preparePackageContent(command),
  };
}

function preparePackageContent(
  command: PublicationAdapterCommand,
): Pick<PreparedPageCommand, 'title' | 'body' | 'marker'> {
  const fileNames = Object.keys(command.payload.files).sort();
  if (
    fileNames.length !== 3 ||
    fileNames[0] !== 'content.html' ||
    fileNames[1] !== 'content.md' ||
    fileNames[2] !== 'structured-data.json'
  ) {
    throw new Error('SHOPIFY_PACKAGE_INVALID');
  }
  const body = command.payload.files['content.html'];
  if (body === undefined || body.trim().length === 0) throw new Error('SHOPIFY_PACKAGE_INVALID');
  let structured: unknown;
  try {
    structured = JSON.parse(command.payload.files['structured-data.json'] ?? '') as unknown;
  } catch {
    throw new Error('SHOPIFY_PACKAGE_INVALID');
  }
  if (
    !isRecord(structured) ||
    typeof structured.headline !== 'string' ||
    structured.headline.trim().length === 0
  ) {
    throw new Error('SHOPIFY_PACKAGE_INVALID');
  }
  const marker = JSON.stringify({
    schemaVersion: 'aeostudio.shopify-publication.v1',
    remoteIntent: createHash('sha256')
      .update(
        JSON.stringify([
          command.channelPackage.tenantId,
          command.channelPackage.workspaceId,
          command.publicationId,
          command.target,
          command.channelPackage.id,
          command.channelPackage.packageChecksum,
        ]),
        'utf8',
      )
      .digest('hex'),
    publicationId: command.publicationId,
    packageChecksum: command.channelPackage.packageChecksum,
    artifactId: command.channelPackage.artifact.artifactId,
    artifactRevisionId: command.channelPackage.artifact.artifactRevisionId,
    artifactRevision: command.channelPackage.artifact.revision,
    artifactContentHash: command.channelPackage.artifact.contentHash,
  });
  return {
    title: structured.headline,
    body,
    marker,
  };
}

function parsePageQuery(response: ShopifyGraphqlResponse): ShopifyPage[] | null {
  if (!isRecord(response.body) || 'errors' in response.body || !isRecord(response.body.data)) {
    return null;
  }
  const pages = response.body.data.pages;
  if (!isRecord(pages) || !Array.isArray(pages.nodes)) return null;
  const parsed = pages.nodes.map(parsePage);
  return parsed.every((page): page is ShopifyPage => page !== null) ? parsed : null;
}

function parsePageByIdQuery(response: ShopifyGraphqlResponse): ShopifyPage | null | undefined {
  if (!isRecord(response.body) || 'errors' in response.body || !isRecord(response.body.data)) {
    return undefined;
  }
  if (response.body.data.page === null) return null;
  return parsePage(response.body.data.page) ?? undefined;
}

function parsePageCreateEvidence(
  response: ShopifyGraphqlResponse,
): { object: ShopifyPage | null; hasErrors: boolean } | null {
  if (!isRecord(response.body) || !isRecord(response.body.data)) return null;
  const payload = response.body.data.pageCreate;
  if (!isRecord(payload) || !Array.isArray(payload.userErrors)) return null;
  const hasErrors =
    payload.userErrors.length > 0 ||
    ('errors' in response.body &&
      (!Array.isArray(response.body.errors) || response.body.errors.length > 0));
  if (payload.page === null) return { object: null, hasErrors };
  const page = parsePage(payload.page);
  return page === null ? null : { object: page, hasErrors };
}

function parseArticleQuery(response: ShopifyGraphqlResponse): ShopifyArticle[] | null {
  if (!isRecord(response.body) || 'errors' in response.body || !isRecord(response.body.data)) {
    return null;
  }
  const articles = response.body.data.articles;
  if (!isRecord(articles) || !Array.isArray(articles.nodes)) return null;
  const parsed = articles.nodes.map(parseArticle);
  return parsed.every((article): article is ShopifyArticle => article !== null) ? parsed : null;
}

function parseArticleByIdQuery(
  response: ShopifyGraphqlResponse,
): ShopifyArticle | null | undefined {
  if (!isRecord(response.body) || 'errors' in response.body || !isRecord(response.body.data)) {
    return undefined;
  }
  if (response.body.data.article === null) return null;
  return parseArticle(response.body.data.article) ?? undefined;
}

function parseArticleCreateEvidence(
  response: ShopifyGraphqlResponse,
): { object: ShopifyArticle | null; hasErrors: boolean } | null {
  if (!isRecord(response.body) || !isRecord(response.body.data)) return null;
  const payload = response.body.data.articleCreate;
  if (!isRecord(payload) || !Array.isArray(payload.userErrors)) return null;
  const hasErrors =
    payload.userErrors.length > 0 ||
    ('errors' in response.body &&
      (!Array.isArray(response.body.errors) || response.body.errors.length > 0));
  if (payload.article === null) return { object: null, hasErrors };
  const article = parseArticle(payload.article);
  return article === null ? null : { object: article, hasErrors };
}

function parseProductQuery(response: ShopifyGraphqlResponse): ShopifyProduct[] | null {
  if (!isRecord(response.body) || 'errors' in response.body || !isRecord(response.body.data)) {
    return null;
  }
  const products = response.body.data.products;
  if (!isRecord(products) || !Array.isArray(products.nodes)) return null;
  const parsed = products.nodes.map(parseProduct);
  return parsed.every((product): product is ShopifyProduct => product !== null) ? parsed : null;
}

function parseProductByIdQuery(
  response: ShopifyGraphqlResponse,
): ShopifyProduct | null | undefined {
  if (!isRecord(response.body) || 'errors' in response.body || !isRecord(response.body.data)) {
    return undefined;
  }
  if (response.body.data.product === null) return null;
  return parseProduct(response.body.data.product) ?? undefined;
}

function parseProductCreateEvidence(
  response: ShopifyGraphqlResponse,
): { object: ShopifyProduct | null; hasErrors: boolean } | null {
  if (!isRecord(response.body) || !isRecord(response.body.data)) return null;
  const payload = response.body.data.productCreate;
  if (!isRecord(payload) || !Array.isArray(payload.userErrors)) return null;
  const hasErrors =
    payload.userErrors.length > 0 ||
    ('errors' in response.body &&
      (!Array.isArray(response.body.errors) || response.body.errors.length > 0));
  if (payload.product === null) return { object: null, hasErrors };
  const product = parseProduct(payload.product);
  return product === null ? null : { object: product, hasErrors };
}

function responseHasUserErrors(
  response: ShopifyGraphqlResponse,
  field:
    | 'pageCreate'
    | 'pageDelete'
    | 'articleCreate'
    | 'articleDelete'
    | 'productCreate'
    | 'productDelete',
): boolean {
  if (!isRecord(response.body) || !isRecord(response.body.data)) return false;
  const payload = response.body.data[field];
  return isRecord(payload) && Array.isArray(payload.userErrors) && payload.userErrors.length > 0;
}

function responseHasMixedDeleteEvidence(
  response: ShopifyGraphqlResponse,
  field: 'pageDelete' | 'articleDelete' | 'productDelete',
  deletedIdField: 'deletedPageId' | 'deletedArticleId' | 'deletedProductId',
): boolean {
  if (!isRecord(response.body) || !isRecord(response.body.data)) return false;
  const payload = response.body.data[field];
  return (
    isRecord(payload) &&
    Array.isArray(payload.userErrors) &&
    payload.userErrors.length > 0 &&
    payload[deletedIdField] !== null &&
    payload[deletedIdField] !== undefined
  );
}

function parseDeletedProductId(response: ShopifyGraphqlResponse): string | null {
  if (!isRecord(response.body) || 'errors' in response.body || !isRecord(response.body.data)) {
    return null;
  }
  const payload = response.body.data.productDelete;
  return isRecord(payload) &&
    Array.isArray(payload.userErrors) &&
    payload.userErrors.length === 0 &&
    typeof payload.deletedProductId === 'string' &&
    /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/u.test(payload.deletedProductId)
    ? payload.deletedProductId
    : null;
}

function parseDeletedArticleId(response: ShopifyGraphqlResponse): string | null {
  if (!isRecord(response.body) || 'errors' in response.body || !isRecord(response.body.data)) {
    return null;
  }
  const payload = response.body.data.articleDelete;
  return isRecord(payload) &&
    Array.isArray(payload.userErrors) &&
    payload.userErrors.length === 0 &&
    typeof payload.deletedArticleId === 'string' &&
    /^gid:\/\/shopify\/Article\/[1-9][0-9]*$/u.test(payload.deletedArticleId)
    ? payload.deletedArticleId
    : null;
}

function parseDeletedPageId(response: ShopifyGraphqlResponse): string | null {
  if (!isRecord(response.body) || 'errors' in response.body || !isRecord(response.body.data)) {
    return null;
  }
  const payload = response.body.data.pageDelete;
  return isRecord(payload) &&
    Array.isArray(payload.userErrors) &&
    payload.userErrors.length === 0 &&
    typeof payload.deletedPageId === 'string' &&
    /^gid:\/\/shopify\/Page\/[1-9][0-9]*$/u.test(payload.deletedPageId)
    ? payload.deletedPageId
    : null;
}

function parsePage(value: unknown): ShopifyPage | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !/^gid:\/\/shopify\/Page\/[1-9][0-9]*$/u.test(value.id) ||
    typeof value.title !== 'string' ||
    typeof value.body !== 'string' ||
    typeof value.handle !== 'string' ||
    typeof value.isPublished !== 'boolean'
  ) {
    return null;
  }
  const marker =
    isRecord(value.metafield) && typeof value.metafield.value === 'string'
      ? value.metafield.value
      : null;
  return {
    id: value.id,
    title: value.title,
    body: value.body,
    handle: value.handle,
    isPublished: value.isPublished,
    marker,
  };
}

function parseArticle(value: unknown): ShopifyArticle | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !/^gid:\/\/shopify\/Article\/[1-9][0-9]*$/u.test(value.id) ||
    typeof value.title !== 'string' ||
    typeof value.body !== 'string' ||
    typeof value.handle !== 'string' ||
    typeof value.isPublished !== 'boolean' ||
    !isRecord(value.blog) ||
    typeof value.blog.id !== 'string' ||
    !/^gid:\/\/shopify\/Blog\/[1-9][0-9]*$/u.test(value.blog.id)
  ) {
    return null;
  }
  const marker =
    isRecord(value.metafield) && typeof value.metafield.value === 'string'
      ? value.metafield.value
      : null;
  return {
    id: value.id,
    blogId: value.blog.id,
    title: value.title,
    body: value.body,
    handle: value.handle,
    isPublished: value.isPublished,
    marker,
  };
}

function parseProduct(value: unknown): ShopifyProduct | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/u.test(value.id) ||
    typeof value.title !== 'string' ||
    typeof value.descriptionHtml !== 'string' ||
    typeof value.handle !== 'string' ||
    (value.status !== 'ACTIVE' && value.status !== 'ARCHIVED' && value.status !== 'DRAFT')
  ) {
    return null;
  }
  const marker =
    isRecord(value.metafield) && typeof value.metafield.value === 'string'
      ? value.metafield.value
      : null;
  return {
    id: value.id,
    title: value.title,
    descriptionHtml: value.descriptionHtml,
    handle: value.handle,
    status: value.status,
    marker,
  };
}

function pageMatches(page: ShopifyPage, prepared: PreparedPageCommand): boolean {
  return pageOwnedContentMatches(page, prepared) && page.isPublished === false;
}

function pageOwnedContentMatches(page: ShopifyPage, prepared: PreparedPageCommand): boolean {
  return (
    page.handle === prepared.target.destination.handle &&
    page.title === prepared.title &&
    page.body === prepared.body &&
    page.marker === prepared.marker
  );
}

function articleMatches(article: ShopifyArticle, prepared: PreparedArticleCommand): boolean {
  return articleOwnedContentMatches(article, prepared) && article.isPublished === false;
}

function articleOwnedContentMatches(
  article: ShopifyArticle,
  prepared: PreparedArticleCommand,
): boolean {
  return (
    article.blogId === prepared.target.destination.blogId &&
    article.handle === prepared.target.destination.handle &&
    article.title === prepared.title &&
    article.body === prepared.body &&
    article.marker === prepared.marker
  );
}

function productMatches(product: ShopifyProduct, prepared: PreparedProductCommand): boolean {
  return productOwnedContentMatches(product, prepared) && product.status === 'DRAFT';
}

function productOwnedContentMatches(
  product: ShopifyProduct,
  prepared: PreparedProductCommand,
): boolean {
  return (
    product.handle === prepared.target.destination.handle &&
    product.title === prepared.title &&
    product.descriptionHtml === prepared.body &&
    product.marker === prepared.marker
  );
}

function appliedPage(
  shopDomain: string,
  page: ShopifyPage,
): Extract<PublicationAdapterPublishResult, { outcome: 'APPLIED' }> {
  return {
    outcome: 'APPLIED',
    remoteRef: pageRemoteRef(shopDomain, page.id),
    remoteState: {
      status: 'DRAFT',
      number: null,
      isProductionLive: false,
      rollbackHandle: {
        operation: 'DELETE_CREATED_DRAFT',
        shopDomain,
        contentKind: 'PAGE',
        remoteId: page.id,
      },
    },
  };
}

function appliedArticle(
  shopDomain: string,
  article: ShopifyArticle,
): Extract<PublicationAdapterPublishResult, { outcome: 'APPLIED' }> {
  return {
    outcome: 'APPLIED',
    remoteRef: articleRemoteRef(shopDomain, article.id),
    remoteState: {
      status: 'UNPUBLISHED',
      number: null,
      isProductionLive: false,
      rollbackHandle: {
        operation: 'DELETE_CREATED_DRAFT',
        shopDomain,
        contentKind: 'BLOG_ARTICLE',
        remoteId: article.id,
      },
    },
  };
}

function appliedProduct(
  shopDomain: string,
  product: ShopifyProduct,
): Extract<PublicationAdapterPublishResult, { outcome: 'APPLIED' }> {
  return {
    outcome: 'APPLIED',
    remoteRef: productRemoteRef(shopDomain, product.id),
    remoteState: {
      status: 'DRAFT',
      number: null,
      isProductionLive: false,
      rollbackHandle: {
        operation: 'DELETE_CREATED_DRAFT',
        shopDomain,
        contentKind: 'PRODUCT',
        remoteId: product.id,
      },
    },
  };
}

function pageRemoteRef(shopDomain: string, pageId: string): string {
  const numericId = pageId.split('/').at(-1);
  if (numericId === undefined) throw new Error('SHOPIFY_PAGE_ID_INVALID');
  const shopHandle = shopDomain.slice(0, -'.myshopify.com'.length);
  return `https://admin.shopify.com/store/${shopHandle}/pages/${numericId}`;
}

function pageIdFromRemoteRef(remoteRef: string, shopDomain: string): string | null {
  const shopHandle = shopDomain.slice(0, -'.myshopify.com'.length);
  const prefix = `https://admin.shopify.com/store/${shopHandle}/pages/`;
  if (!remoteRef.startsWith(prefix)) return null;
  const numericId = remoteRef.slice(prefix.length);
  return /^[1-9][0-9]*$/u.test(numericId) ? `gid://shopify/Page/${numericId}` : null;
}

function pageCompensationId(
  intent: PublicationAdapterReconciliationIntent | undefined,
  shopDomain: string,
): string | null {
  return intent?.kind === 'COMPENSATE_UNSAFE_CREATE' && typeof intent.remoteRef === 'string'
    ? pageIdFromRemoteRef(intent.remoteRef, shopDomain)
    : null;
}

function articleRemoteRef(shopDomain: string, articleId: string): string {
  const numericId = articleId.split('/').at(-1);
  if (numericId === undefined) throw new Error('SHOPIFY_ARTICLE_ID_INVALID');
  const shopHandle = shopDomain.slice(0, -'.myshopify.com'.length);
  return `https://admin.shopify.com/store/${shopHandle}/content/articles/${numericId}`;
}

function articleIdFromRemoteRef(remoteRef: string, shopDomain: string): string | null {
  const shopHandle = shopDomain.slice(0, -'.myshopify.com'.length);
  const prefix = `https://admin.shopify.com/store/${shopHandle}/content/articles/`;
  if (!remoteRef.startsWith(prefix)) return null;
  const numericId = remoteRef.slice(prefix.length);
  return /^[1-9][0-9]*$/u.test(numericId) ? `gid://shopify/Article/${numericId}` : null;
}

function articleCompensationId(
  intent: PublicationAdapterReconciliationIntent | undefined,
  shopDomain: string,
): string | null {
  return intent?.kind === 'COMPENSATE_UNSAFE_CREATE' && typeof intent.remoteRef === 'string'
    ? articleIdFromRemoteRef(intent.remoteRef, shopDomain)
    : null;
}

function productRemoteRef(shopDomain: string, productId: string): string {
  const numericId = productId.split('/').at(-1);
  if (numericId === undefined) throw new Error('SHOPIFY_PRODUCT_ID_INVALID');
  const shopHandle = shopDomain.slice(0, -'.myshopify.com'.length);
  return `https://admin.shopify.com/store/${shopHandle}/products/${numericId}`;
}

function productIdFromRemoteRef(remoteRef: string, shopDomain: string): string | null {
  const shopHandle = shopDomain.slice(0, -'.myshopify.com'.length);
  const prefix = `https://admin.shopify.com/store/${shopHandle}/products/`;
  if (!remoteRef.startsWith(prefix)) return null;
  const numericId = remoteRef.slice(prefix.length);
  return /^[1-9][0-9]*$/u.test(numericId) ? `gid://shopify/Product/${numericId}` : null;
}

function productCompensationId(
  intent: PublicationAdapterReconciliationIntent | undefined,
  shopDomain: string,
): string | null {
  return intent?.kind === 'COMPENSATE_UNSAFE_CREATE' && typeof intent.remoteRef === 'string'
    ? productIdFromRemoteRef(intent.remoteRef, shopDomain)
    : null;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
