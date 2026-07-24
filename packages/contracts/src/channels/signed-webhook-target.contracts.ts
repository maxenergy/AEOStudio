import { z } from 'zod';

const TARGET_PREFIX = 'signed-webhook:v1:';
const UuidSchema = z.uuid();
export const SignedWebhookKeyIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

export const SignedWebhookSigningAlgorithmSchema = z.enum(['HMAC_SHA256', 'ED25519']);

function isCanonicalWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.port === '' &&
      url.hostname === url.hostname.toLowerCase() &&
      url.href === value
    );
  } catch {
    return false;
  }
}

export const SignedWebhookUrlSchema = z
  .string()
  .max(2_048)
  .refine(isCanonicalWebhookUrl, 'canonical HTTPS URL required');

export const SignedWebhookTargetV1Schema = z
  .object({
    schemaVersion: z.literal('signed-webhook-target.v1'),
    endpointUrl: SignedWebhookUrlSchema,
    receiptUrl: SignedWebhookUrlSchema,
    endpointVerificationId: UuidSchema,
    algorithm: SignedWebhookSigningAlgorithmSchema,
    keyId: SignedWebhookKeyIdSchema,
  })
  .strict()
  .refine(
    ({ endpointUrl, receiptUrl }) => new URL(endpointUrl).origin === new URL(receiptUrl).origin,
    'delivery and receipt endpoints must share one verified origin',
  );

export type SignedWebhookTargetV1 = z.infer<typeof SignedWebhookTargetV1Schema>;

function invalidTarget(): never {
  throw new Error('SIGNED_WEBHOOK_TARGET_INVALID');
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

export function encodeSignedWebhookTarget(input: SignedWebhookTargetV1): string {
  const parsed = SignedWebhookTargetV1Schema.safeParse(input);
  if (!parsed.success) invalidTarget();
  return `${TARGET_PREFIX}${encodeBase64Url(JSON.stringify(parsed.data))}`;
}

export function decodeSignedWebhookTarget(value: string): SignedWebhookTargetV1 {
  try {
    if (!value.startsWith(TARGET_PREFIX) || value.length > 8_192) invalidTarget();
    const encoded = value.slice(TARGET_PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) invalidTarget();
    const decoded = decodeBase64Url(encoded);
    if (encodeBase64Url(decoded) !== encoded) invalidTarget();
    const parsed = SignedWebhookTargetV1Schema.safeParse(JSON.parse(decoded) as unknown);
    if (!parsed.success || encodeSignedWebhookTarget(parsed.data) !== value) invalidTarget();
    return parsed.data;
  } catch (error) {
    if (error instanceof Error && error.message === 'SIGNED_WEBHOOK_TARGET_INVALID') throw error;
    return invalidTarget();
  }
}

export function signedWebhookRequiredScopes(): string[] {
  return ['webhook:deliver'];
}
