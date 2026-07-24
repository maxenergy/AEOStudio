import { z } from 'zod';

const SHOP_TARGET_PREFIX = 'shopify-shop:v1:';
const DRAFT_TARGET_PREFIX = 'shopify-draft:v1:';
const ShopDomainSchema = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/u);
const ApiVersionSchema = z.string().regex(/^\d{4}-(?:01|04|07|10)$/u);
const HandleSchema = z
  .string()
  .max(255)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const BlogIdSchema = z.string().regex(/^gid:\/\/shopify\/Blog\/[1-9][0-9]*$/u);
const PageIdSchema = z.string().regex(/^gid:\/\/shopify\/Page\/[1-9][0-9]*$/u);
const ArticleIdSchema = z.string().regex(/^gid:\/\/shopify\/Article\/[1-9][0-9]*$/u);
const ProductIdSchema = z.string().regex(/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/u);

export const ShopifyShopAuthorizationTargetV1Schema = z
  .object({
    schemaVersion: z.literal('shopify-shop-auth.v1'),
    shopDomain: ShopDomainSchema,
  })
  .strict();

export type ShopifyShopAuthorizationTargetV1 = z.infer<
  typeof ShopifyShopAuthorizationTargetV1Schema
>;

const PageCreateSchema = z
  .object({ kind: z.literal('PAGE'), operation: z.literal('CREATE'), handle: HandleSchema })
  .strict();
const PageUpdateSchema = z
  .object({
    kind: z.literal('PAGE'),
    operation: z.literal('UPDATE'),
    handle: HandleSchema,
    remoteId: PageIdSchema,
  })
  .strict();
const ArticleCreateSchema = z
  .object({
    kind: z.literal('BLOG_ARTICLE'),
    operation: z.literal('CREATE'),
    handle: HandleSchema,
    blogId: BlogIdSchema,
  })
  .strict();
const ArticleUpdateSchema = z
  .object({
    kind: z.literal('BLOG_ARTICLE'),
    operation: z.literal('UPDATE'),
    handle: HandleSchema,
    blogId: BlogIdSchema,
    remoteId: ArticleIdSchema,
  })
  .strict();
const ProductCreateSchema = z
  .object({ kind: z.literal('PRODUCT'), operation: z.literal('CREATE'), handle: HandleSchema })
  .strict();
const ProductUpdateSchema = z
  .object({
    kind: z.literal('PRODUCT'),
    operation: z.literal('UPDATE'),
    handle: HandleSchema,
    remoteId: ProductIdSchema,
  })
  .strict();

export const ShopifyDraftTargetV1Schema = z
  .object({
    schemaVersion: z.literal('shopify-draft-target.v1'),
    shopDomain: ShopDomainSchema,
    apiVersion: ApiVersionSchema,
    destination: z.union([
      PageCreateSchema,
      PageUpdateSchema,
      ArticleCreateSchema,
      ArticleUpdateSchema,
      ProductCreateSchema,
      ProductUpdateSchema,
    ]),
  })
  .strict();

export type ShopifyDraftTargetV1 = z.infer<typeof ShopifyDraftTargetV1Schema>;

function invalidTarget(): never {
  throw new Error('SHOPIFY_TARGET_INVALID');
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value: string): string {
  const paddingLength = (4 - (value.length % 4)) % 4;
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat(paddingLength));
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

function encodeTarget(prefix: string, value: unknown): string {
  return `${prefix}${encodeBase64Url(JSON.stringify(value))}`;
}

function decodeTarget(value: string, prefix: string): unknown {
  try {
    if (!value.startsWith(prefix) || value.length > 8_192) invalidTarget();
    const encoded = value.slice(prefix.length);
    if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) invalidTarget();
    const decoded = decodeBase64Url(encoded);
    if (encodeBase64Url(decoded) !== encoded) invalidTarget();
    return JSON.parse(decoded) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message === 'SHOPIFY_TARGET_INVALID') throw error;
    return invalidTarget();
  }
}

export function encodeShopifyShopAuthorizationTarget(
  input: ShopifyShopAuthorizationTargetV1,
): string {
  const parsed = ShopifyShopAuthorizationTargetV1Schema.safeParse(input);
  if (!parsed.success) invalidTarget();
  return encodeTarget(SHOP_TARGET_PREFIX, {
    schemaVersion: parsed.data.schemaVersion,
    shopDomain: parsed.data.shopDomain,
  });
}

export function decodeShopifyShopAuthorizationTarget(
  value: string,
): ShopifyShopAuthorizationTargetV1 {
  const parsed = ShopifyShopAuthorizationTargetV1Schema.safeParse(
    decodeTarget(value, SHOP_TARGET_PREFIX),
  );
  if (!parsed.success || encodeShopifyShopAuthorizationTarget(parsed.data) !== value) {
    return invalidTarget();
  }
  return parsed.data;
}

export function encodeShopifyDraftTarget(input: ShopifyDraftTargetV1): string {
  const parsed = ShopifyDraftTargetV1Schema.safeParse(input);
  if (!parsed.success) invalidTarget();
  return encodeTarget(DRAFT_TARGET_PREFIX, {
    schemaVersion: parsed.data.schemaVersion,
    shopDomain: parsed.data.shopDomain,
    apiVersion: parsed.data.apiVersion,
    destination: { ...parsed.data.destination },
  });
}

export function decodeShopifyDraftTarget(value: string): ShopifyDraftTargetV1 {
  const parsed = ShopifyDraftTargetV1Schema.safeParse(decodeTarget(value, DRAFT_TARGET_PREFIX));
  if (!parsed.success || encodeShopifyDraftTarget(parsed.data) !== value) return invalidTarget();
  return parsed.data;
}

export function shopifyAuthorizationTargetFor(publicationTarget: string): string {
  const target = decodeShopifyDraftTarget(publicationTarget);
  return encodeShopifyShopAuthorizationTarget({
    schemaVersion: 'shopify-shop-auth.v1',
    shopDomain: target.shopDomain,
  });
}

export function shopifyAuthorizationCovers(
  authorizationTarget: string,
  publicationTarget: string,
): boolean {
  try {
    return authorizationTarget === shopifyAuthorizationTargetFor(publicationTarget);
  } catch {
    return false;
  }
}

export function shopifyRequiredScopesFor(publicationTarget: string): string[] {
  const target = decodeShopifyDraftTarget(publicationTarget);
  return [target.destination.kind === 'PRODUCT' ? 'write_products' : 'write_content'];
}
