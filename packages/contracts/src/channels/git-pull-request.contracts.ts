import { z } from 'zod';

const TARGET_PREFIX = 'git-pr:v1:';
const CONFUSABLE_SLASHES = new Set([0x2044, 0x2215, 0x29f8, 0xff0f]);

function hasControlOrConfusableSlash(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point === undefined || point <= 0x1f || point === 0x7f || CONFUSABLE_SLASHES.has(point);
  });
}

function isCanonicalPath(value: string, maximumLength: number): boolean {
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('//') ||
    value.includes('\\') ||
    value.includes('%') ||
    /^[A-Za-z]:/.test(value) ||
    hasControlOrConfusableSlash(value)
  ) {
    return false;
  }
  return value
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function isCanonicalGitBranchName(value: string): boolean {
  if (
    !isCanonicalPath(value, 240) ||
    value.startsWith('-') ||
    value === '@' ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('@{') ||
    [...value].some((character) => ' ~^:?*['.includes(character))
  ) {
    return false;
  }

  return value
    .split('/')
    .every((segment) => !segment.startsWith('.') && !segment.endsWith('.lock'));
}

export const GitPullRequestTargetV1Schema = z
  .object({
    schemaVersion: z.literal('git-pr-target.v1'),
    provider: z.literal('GITHUB'),
    installationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
    repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
    baseBranch: z.string().refine(isCanonicalGitBranchName),
    pathPrefix: z
      .string()
      .refine((value) => isCanonicalPath(value, 1_024))
      .refine((value) => {
        const segments = value.toLowerCase().split('/');
        return (
          !segments.includes('.git') && !(segments[0] === '.github' && segments[1] === 'workflows')
        );
      }),
  })
  .strict();

export type GitPullRequestTargetV1 = z.infer<typeof GitPullRequestTargetV1Schema>;

function invalidTarget(): never {
  throw new Error('GIT_TARGET_INVALID');
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

export function encodeGitPullRequestTarget(input: GitPullRequestTargetV1): string {
  const parsed = GitPullRequestTargetV1Schema.safeParse(input);
  if (!parsed.success) invalidTarget();
  const canonical: GitPullRequestTargetV1 = {
    schemaVersion: parsed.data.schemaVersion,
    provider: parsed.data.provider,
    installationId: parsed.data.installationId,
    repository: parsed.data.repository,
    baseBranch: parsed.data.baseBranch,
    pathPrefix: parsed.data.pathPrefix,
  };
  return `${TARGET_PREFIX}${encodeBase64Url(JSON.stringify(canonical))}`;
}

export function decodeGitPullRequestTarget(value: string): GitPullRequestTargetV1 {
  try {
    if (!value.startsWith(TARGET_PREFIX) || value.length > 4_096) invalidTarget();
    const encoded = value.slice(TARGET_PREFIX.length);
    if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) invalidTarget();
    const decoded = decodeBase64Url(encoded);
    if (encodeBase64Url(decoded) !== encoded) invalidTarget();
    const parsed = GitPullRequestTargetV1Schema.safeParse(JSON.parse(decoded) as unknown);
    if (!parsed.success || encodeGitPullRequestTarget(parsed.data) !== value) invalidTarget();
    return parsed.data;
  } catch (error) {
    if (error instanceof Error && error.message === 'GIT_TARGET_INVALID') throw error;
    return invalidTarget();
  }
}
