import { z } from 'zod';

const SITE_TARGET_PREFIX = 'wordpress-site:v1:';
const DRAFT_TARGET_PREFIX = 'wordpress-draft:v1:';
const CONFUSABLE_SLASHES = new Set([0x2044, 0x2215, 0x29f8, 0xff0f]);

function hasControlOrConfusableSlash(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point === undefined || point <= 0x1f || point === 0x7f || CONFUSABLE_SLASHES.has(point);
  });
}

function isCanonicalSiteUrl(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 2_048 ||
    value.includes('%') ||
    value.includes('\\') ||
    hasControlOrConfusableSlash(value) ||
    /\/(?:\.{1,2})(?:\/|$)/u.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.hostname.length === 0 ||
      parsed.pathname.includes('//') ||
      (parsed.pathname !== '/' && parsed.pathname.endsWith('/'))
    ) {
      return false;
    }
    const canonical =
      parsed.pathname === '/' ? parsed.origin : `${parsed.origin}${parsed.pathname}`;
    return canonical === value;
  } catch {
    return false;
  }
}

function isCanonicalSlug(value: string): boolean {
  return value.length <= 200 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

const AuthModeSchema = z.enum(['OAUTH', 'APPLICATION_PASSWORD', 'APPROVED_TOKEN']);

export const WordPressSiteAuthorizationTargetV1Schema = z
  .object({
    schemaVersion: z.literal('wordpress-site-auth.v1'),
    siteUrl: z.string().refine(isCanonicalSiteUrl),
    authMode: AuthModeSchema,
  })
  .strict();

export type WordPressSiteAuthorizationTargetV1 = z.infer<
  typeof WordPressSiteAuthorizationTargetV1Schema
>;

const CategoryIdsSchema = z
  .array(z.number().int().positive().max(2_147_483_647))
  .max(100)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'category ids must be unique' });
    }
    for (let index = 1; index < values.length; index += 1) {
      const previous = values[index - 1];
      const current = values[index];
      if (previous !== undefined && current !== undefined && previous >= current) {
        context.addIssue({ code: 'custom', message: 'category ids must be canonically sorted' });
        break;
      }
    }
  });

const SlugSchema = z.string().refine(isCanonicalSlug);
const RemoteIdSchema = z.number().int().positive().max(2_147_483_647);

const PageCreateSchema = z
  .object({ kind: z.literal('PAGE'), operation: z.literal('CREATE'), slug: SlugSchema })
  .strict();
const PageUpdateSchema = z
  .object({
    kind: z.literal('PAGE'),
    operation: z.literal('UPDATE'),
    slug: SlugSchema,
    remoteId: RemoteIdSchema,
  })
  .strict();
const PostCreateSchema = z
  .object({
    kind: z.literal('POST'),
    operation: z.literal('CREATE'),
    slug: SlugSchema,
    categoryIds: CategoryIdsSchema,
  })
  .strict();
const PostUpdateSchema = z
  .object({
    kind: z.literal('POST'),
    operation: z.literal('UPDATE'),
    slug: SlugSchema,
    categoryIds: CategoryIdsSchema,
    remoteId: RemoteIdSchema,
  })
  .strict();
const ProductCreateSchema = z
  .object({
    kind: z.literal('PRODUCT'),
    operation: z.literal('CREATE'),
    slug: SlugSchema,
    categoryIds: CategoryIdsSchema,
  })
  .strict();
const ProductUpdateSchema = z
  .object({
    kind: z.literal('PRODUCT'),
    operation: z.literal('UPDATE'),
    slug: SlugSchema,
    categoryIds: CategoryIdsSchema,
    remoteId: RemoteIdSchema,
  })
  .strict();

export const WordPressDraftTargetV1Schema = z
  .object({
    schemaVersion: z.literal('wordpress-draft-target.v1'),
    siteUrl: z.string().refine(isCanonicalSiteUrl),
    authMode: AuthModeSchema,
    destination: z.union([
      PageCreateSchema,
      PageUpdateSchema,
      PostCreateSchema,
      PostUpdateSchema,
      ProductCreateSchema,
      ProductUpdateSchema,
    ]),
  })
  .strict();

export type WordPressDraftTargetV1 = z.infer<typeof WordPressDraftTargetV1Schema>;

function invalidTarget(): never {
  throw new Error('WORDPRESS_TARGET_INVALID');
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
    if (error instanceof Error && error.message === 'WORDPRESS_TARGET_INVALID') throw error;
    return invalidTarget();
  }
}

export function encodeWordPressSiteAuthorizationTarget(
  input: WordPressSiteAuthorizationTargetV1,
): string {
  const parsed = WordPressSiteAuthorizationTargetV1Schema.safeParse(input);
  if (!parsed.success) invalidTarget();
  const canonical: WordPressSiteAuthorizationTargetV1 = {
    schemaVersion: parsed.data.schemaVersion,
    siteUrl: parsed.data.siteUrl,
    authMode: parsed.data.authMode,
  };
  return encodeTarget(SITE_TARGET_PREFIX, canonical);
}

export function decodeWordPressSiteAuthorizationTarget(
  value: string,
): WordPressSiteAuthorizationTargetV1 {
  const parsed = WordPressSiteAuthorizationTargetV1Schema.safeParse(
    decodeTarget(value, SITE_TARGET_PREFIX),
  );
  if (!parsed.success || encodeWordPressSiteAuthorizationTarget(parsed.data) !== value) {
    return invalidTarget();
  }
  return parsed.data;
}

function canonicalDraftTarget(input: WordPressDraftTargetV1): WordPressDraftTargetV1 {
  return {
    schemaVersion: input.schemaVersion,
    siteUrl: input.siteUrl,
    authMode: input.authMode,
    destination: { ...input.destination },
  };
}

export function encodeWordPressDraftTarget(input: WordPressDraftTargetV1): string {
  const parsed = WordPressDraftTargetV1Schema.safeParse(input);
  if (!parsed.success) invalidTarget();
  return encodeTarget(DRAFT_TARGET_PREFIX, canonicalDraftTarget(parsed.data));
}

export function decodeWordPressDraftTarget(value: string): WordPressDraftTargetV1 {
  const parsed = WordPressDraftTargetV1Schema.safeParse(decodeTarget(value, DRAFT_TARGET_PREFIX));
  if (!parsed.success || encodeWordPressDraftTarget(parsed.data) !== value) return invalidTarget();
  return parsed.data;
}

export function wordpressAuthorizationTargetFor(publicationTarget: string): string {
  const target = decodeWordPressDraftTarget(publicationTarget);
  return encodeWordPressSiteAuthorizationTarget({
    schemaVersion: 'wordpress-site-auth.v1',
    siteUrl: target.siteUrl,
    authMode: target.authMode,
  });
}

export function wordpressAuthorizationCovers(
  authorizationTarget: string,
  publicationTarget: string,
): boolean {
  try {
    return authorizationTarget === wordpressAuthorizationTargetFor(publicationTarget);
  } catch {
    return false;
  }
}

export function wordpressRequiredScopesFor(input: {
  target: string;
  assetRefs: readonly string[];
}): string[] {
  const target = decodeWordPressDraftTarget(input.target);
  const scopes = new Set<string>();
  if (input.assetRefs.length > 0) scopes.add('media:write');
  switch (target.destination.kind) {
    case 'PAGE':
      scopes.add('pages:write');
      break;
    case 'POST':
      scopes.add('posts:write');
      break;
    case 'PRODUCT':
      scopes.add('woocommerce:products:write');
      break;
  }
  return [...scopes].sort((left, right) => left.localeCompare(right));
}
