import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as signEd25519,
  timingSafeEqual,
  verify as verifyEd25519,
} from 'node:crypto';

import { canonicalArtifactJson } from '@aeostudio/application/artifacts';

export type SignedWebhookSigningAlgorithm = 'HMAC_SHA256' | 'ED25519';

export const SIGNED_WEBHOOK_SIGNATURE_VALIDITY_SECONDS = 300;
export const SIGNED_WEBHOOK_CLOCK_SKEW_TOLERANCE_SECONDS = 30;

export interface SignedWebhookClock {
  now(): Date;
}

export interface SignedWebhookSigningKey {
  keyId: string;
  algorithm: SignedWebhookSigningAlgorithm;
  signingMaterial: string;
  validFrom: string;
  validUntil: string | null;
}

export interface SignedWebhookVerificationKey {
  keyId: string;
  algorithm: SignedWebhookSigningAlgorithm;
  verificationMaterial: string;
  validFrom: string;
  validUntil: string | null;
}

export interface SignedWebhookRequest {
  body: Uint8Array;
  bodySha256: string;
  headers: Record<string, string>;
}

export interface VerifiedSignedWebhookRequest {
  bodySha256: string;
  keyId: string;
  algorithm: SignedWebhookSigningAlgorithm;
  nonce: string;
  created: number;
  expires: number;
}

export type SignedWebhookVerificationResult =
  | { outcome: 'VERIFIED'; verified: VerifiedSignedWebhookRequest }
  | { outcome: 'SIGNATURE_REJECTED' | 'TIMESTAMP_REJECTED' | 'REPLAY_REJECTED' };

const SIGNATURE_LABEL = 'aeo';
const SIGNATURE_TAG = 'aeostudio-signed-webhook-v1';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const SCHEMA_VERSION = '1.0.0';
const COVERED_COMPONENTS = [
  '@method',
  '@target-uri',
  'content-type',
  'content-digest',
  'webhook-id',
  'aeostudio-schema-version',
] as const;
const NONCE_PATTERN = /^[A-Za-z0-9._~-]{16,200}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function canonicalSignedWebhookBody(value: unknown): {
  body: Uint8Array;
  bodySha256: string;
} {
  assertJcsValue(value, new WeakSet<object>());
  const canonical = canonicalArtifactJson(value);
  if (typeof canonical !== 'string') throw new Error('WEBHOOK_BODY_INVALID');
  const body = new TextEncoder().encode(canonical);
  return { body, bodySha256: sha256Hex(body) };
}

export function parseSignedWebhookKeyRing(value: string): {
  activeKeyId: string;
  keys: SignedWebhookSigningKey[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('WEBHOOK_KEY_RING_INVALID');
  }
  if (!isPlainRecord(parsed) || !hasExactKeys(parsed, ['schemaVersion', 'activeKeyId', 'keys'])) {
    throw new Error('WEBHOOK_KEY_RING_INVALID');
  }
  if (
    parsed.schemaVersion !== 'signed-webhook-key-ring.v1' ||
    typeof parsed.activeKeyId !== 'string' ||
    !KEY_ID_PATTERN.test(parsed.activeKeyId) ||
    !Array.isArray(parsed.keys) ||
    parsed.keys.length === 0 ||
    parsed.keys.length > 20
  ) {
    throw new Error('WEBHOOK_KEY_RING_INVALID');
  }
  const keys = parsed.keys.map(parseSigningKey);
  if (new Set(keys.map(({ keyId }) => keyId)).size !== keys.length) {
    throw new Error('WEBHOOK_KEY_RING_INVALID');
  }
  if (!keys.some(({ keyId }) => keyId === parsed.activeKeyId)) {
    throw new Error('WEBHOOK_KEY_RING_INVALID');
  }
  return { activeKeyId: parsed.activeKeyId, keys };
}

export function requireActiveSigningKey(input: {
  secretValue: string;
  targetKeyId: string;
  targetAlgorithm: SignedWebhookSigningAlgorithm;
  now: Date;
}): SignedWebhookSigningKey {
  const ring = parseSignedWebhookKeyRing(input.secretValue);
  if (ring.activeKeyId !== input.targetKeyId) throw new Error('WEBHOOK_ACTIVE_KEY_MISMATCH');
  return requireTargetKey(ring.keys, input);
}

export function requireReconciliationSigningKey(input: {
  secretValue: string;
  targetKeyId: string;
  targetAlgorithm: SignedWebhookSigningAlgorithm;
  now: Date;
}): SignedWebhookSigningKey {
  const ring = parseSignedWebhookKeyRing(input.secretValue);
  return requireTargetKey(ring.keys, input);
}

export function createSignedWebhookRequest(input: {
  url: string;
  webhookId: string;
  bodyValue: unknown;
  key: SignedWebhookSigningKey;
  now: Date;
  nonce: string;
  maxTimestampSkewSeconds: number;
}): SignedWebhookRequest {
  if (!NONCE_PATTERN.test(input.nonce)) throw new Error('WEBHOOK_NONCE_INVALID');
  if (input.maxTimestampSkewSeconds !== SIGNED_WEBHOOK_SIGNATURE_VALIDITY_SECONDS) {
    throw new Error('WEBHOOK_TIMESTAMP_POLICY_INVALID');
  }
  const { body, bodySha256 } = canonicalSignedWebhookBody(input.bodyValue);
  const contentDigest = `sha-256=:${Buffer.from(bodySha256, 'hex').toString('base64')}:`;
  const created = Math.floor(input.now.getTime() / 1_000);
  const expires = created + input.maxTimestampSkewSeconds;
  const signatureParameters = serializeSignatureParameters({
    created,
    expires,
    nonce: input.nonce,
    keyId: input.key.keyId,
    algorithm: input.key.algorithm,
  });
  const headers: Record<string, string> = {
    'content-type': CONTENT_TYPE,
    'content-digest': contentDigest,
    'webhook-id': input.webhookId,
    'aeostudio-schema-version': SCHEMA_VERSION,
    'signature-input': `${SIGNATURE_LABEL}=${signatureParameters}`,
  };
  const signatureBase = createSignatureBase({
    url: input.url,
    headers,
    signatureParameters,
  });
  const signature = signSignature(input.key, new TextEncoder().encode(signatureBase));
  headers.signature = `${SIGNATURE_LABEL}=:${signature.toString('base64')}:`;
  return { body, bodySha256, headers };
}

export function verifySignedWebhookRequest(input: {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
  verificationKeys: SignedWebhookVerificationKey[];
  now: Date;
  maxTimestampSkewSeconds: number;
  nonceWasUsed(keyId: string, nonce: string, nowEpochSeconds: number): boolean;
  rememberNonce(keyId: string, nonce: string, expiresEpochSeconds: number): void;
}): SignedWebhookVerificationResult {
  const headers = normalizeHeaders(input.headers);
  if (headers === null) return { outcome: 'SIGNATURE_REJECTED' };
  const contentType = headers['content-type'];
  const contentDigest = headers['content-digest'];
  const webhookId = headers['webhook-id'];
  const schemaVersion = headers['aeostudio-schema-version'];
  const signatureInput = headers['signature-input'];
  const signatureHeader = headers.signature;
  if (
    contentType !== CONTENT_TYPE ||
    webhookId === undefined ||
    schemaVersion !== SCHEMA_VERSION ||
    contentDigest === undefined ||
    signatureInput === undefined ||
    signatureHeader === undefined
  ) {
    return { outcome: 'SIGNATURE_REJECTED' };
  }
  const digest = parseContentDigest(contentDigest);
  if (digest === null) return { outcome: 'SIGNATURE_REJECTED' };
  const actualBodySha256 = sha256Hex(input.body);
  if (!safeHexEqual(digest, actualBodySha256)) return { outcome: 'SIGNATURE_REJECTED' };

  const parameters = parseSignatureInput(signatureInput);
  const signature = parseSignature(signatureHeader);
  if (parameters === null || signature === null) return { outcome: 'SIGNATURE_REJECTED' };
  if (
    input.maxTimestampSkewSeconds !== SIGNED_WEBHOOK_SIGNATURE_VALIDITY_SECONDS ||
    parameters.expires - parameters.created !== SIGNED_WEBHOOK_SIGNATURE_VALIDITY_SECONDS
  ) {
    return { outcome: 'TIMESTAMP_REJECTED' };
  }
  const key = input.verificationKeys.find(
    ({ keyId, algorithm }) => keyId === parameters.keyId && algorithm === parameters.algorithm,
  );
  if (key === undefined || !keyIsValidAt(key, input.now)) {
    return { outcome: 'SIGNATURE_REJECTED' };
  }
  const signatureBase = createSignatureBase({
    url: input.url,
    headers,
    signatureParameters: parameters.serialized,
  });
  if (!verifySignature(key, new TextEncoder().encode(signatureBase), signature)) {
    return { outcome: 'SIGNATURE_REJECTED' };
  }

  const nowEpochSeconds = Math.floor(input.now.getTime() / 1_000);
  if (
    parameters.created > nowEpochSeconds + SIGNED_WEBHOOK_CLOCK_SKEW_TOLERANCE_SECONDS ||
    parameters.expires < nowEpochSeconds - SIGNED_WEBHOOK_CLOCK_SKEW_TOLERANCE_SECONDS
  ) {
    return { outcome: 'TIMESTAMP_REJECTED' };
  }
  if (input.nonceWasUsed(parameters.keyId, parameters.nonce, nowEpochSeconds)) {
    return { outcome: 'REPLAY_REJECTED' };
  }
  input.rememberNonce(
    parameters.keyId,
    parameters.nonce,
    parameters.expires + SIGNED_WEBHOOK_CLOCK_SKEW_TOLERANCE_SECONDS,
  );
  return {
    outcome: 'VERIFIED',
    verified: {
      bodySha256: actualBodySha256,
      keyId: parameters.keyId,
      algorithm: parameters.algorithm,
      nonce: parameters.nonce,
      created: parameters.created,
      expires: parameters.expires,
    },
  };
}

export function decodeCanonicalSignedWebhookBody(body: Uint8Array): unknown {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('WEBHOOK_BODY_INVALID');
  }
  assertJcsValue(parsed, new WeakSet<object>());
  if (canonicalArtifactJson(parsed) !== text) throw new Error('WEBHOOK_BODY_INVALID');
  return parsed;
}

export function sha256Hex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function parseSigningKey(value: unknown): SignedWebhookSigningKey {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['keyId', 'algorithm', 'signingMaterial', 'validFrom', 'validUntil']) ||
    typeof value.keyId !== 'string' ||
    !KEY_ID_PATTERN.test(value.keyId) ||
    (value.algorithm !== 'HMAC_SHA256' && value.algorithm !== 'ED25519') ||
    typeof value.signingMaterial !== 'string' ||
    typeof value.validFrom !== 'string' ||
    (value.validUntil !== null && typeof value.validUntil !== 'string') ||
    !isCanonicalInstant(value.validFrom) ||
    (value.validUntil !== null && !isCanonicalInstant(value.validUntil))
  ) {
    throw new Error('WEBHOOK_KEY_RING_INVALID');
  }
  if (
    value.validUntil !== null &&
    new Date(value.validUntil).getTime() <= new Date(value.validFrom).getTime()
  ) {
    throw new Error('WEBHOOK_KEY_RING_INVALID');
  }
  return {
    keyId: value.keyId,
    algorithm: value.algorithm,
    signingMaterial: value.signingMaterial,
    validFrom: value.validFrom,
    validUntil: value.validUntil,
  };
}

function validateSigningMaterial(key: SignedWebhookSigningKey): void {
  if (key.algorithm === 'HMAC_SHA256') {
    if (Buffer.byteLength(key.signingMaterial, 'utf8') < 32) {
      throw new Error('WEBHOOK_SIGNING_KEY_UNAVAILABLE');
    }
    return;
  }
  try {
    const privateKey = createPrivateKey(key.signingMaterial);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
  } catch {
    throw new Error('WEBHOOK_SIGNING_KEY_UNAVAILABLE');
  }
}

function requireTargetKey(
  keys: SignedWebhookSigningKey[],
  input: {
    targetKeyId: string;
    targetAlgorithm: SignedWebhookSigningAlgorithm;
    now: Date;
  },
): SignedWebhookSigningKey {
  const key = keys.find(({ keyId }) => keyId === input.targetKeyId);
  if (
    key === undefined ||
    key.algorithm !== input.targetAlgorithm ||
    !keyIsValidAt(key, input.now)
  ) {
    throw new Error('WEBHOOK_SIGNING_KEY_UNAVAILABLE');
  }
  validateSigningMaterial(key);
  return key;
}

function keyIsValidAt(
  key: Pick<SignedWebhookSigningKey, 'validFrom' | 'validUntil'>,
  now: Date,
): boolean {
  const timestamp = now.getTime();
  const validFrom = new Date(key.validFrom).getTime();
  const validUntil =
    key.validUntil === null ? Number.POSITIVE_INFINITY : new Date(key.validUntil).getTime();
  return Number.isFinite(timestamp) && timestamp >= validFrom && timestamp < validUntil;
}

function serializeSignatureParameters(input: {
  created: number;
  expires: number;
  nonce: string;
  keyId: string;
  algorithm: SignedWebhookSigningAlgorithm;
}): string {
  return (
    `(${COVERED_COMPONENTS.map((component) => `"${component}"`).join(' ')})` +
    `;created=${input.created};expires=${input.expires};nonce="${input.nonce}"` +
    `;keyid="${input.keyId}";alg="${algorithmToken(input.algorithm)}";tag="${SIGNATURE_TAG}"`
  );
}

function createSignatureBase(input: {
  url: string;
  headers: Record<string, string>;
  signatureParameters: string;
}): string {
  return [
    `"@method": POST`,
    `"@target-uri": ${input.url}`,
    `"content-type": ${input.headers['content-type'] ?? ''}`,
    `"content-digest": ${input.headers['content-digest'] ?? ''}`,
    `"webhook-id": ${input.headers['webhook-id'] ?? ''}`,
    `"aeostudio-schema-version": ${input.headers['aeostudio-schema-version'] ?? ''}`,
    `"@signature-params": ${input.signatureParameters}`,
  ].join('\n');
}

function parseSignatureInput(value: string): {
  serialized: string;
  created: number;
  expires: number;
  nonce: string;
  keyId: string;
  algorithm: SignedWebhookSigningAlgorithm;
} | null {
  const components = COVERED_COMPONENTS.map((component) => `"${component}"`).join(' ');
  const prefix = `${SIGNATURE_LABEL}=(${components});created=`;
  if (!value.startsWith(prefix)) return null;
  const rest = value.slice(prefix.length);
  const match =
    /^(\d{1,12});expires=(\d{1,12});nonce="([A-Za-z0-9._~-]{16,200})";keyid="([A-Za-z0-9][A-Za-z0-9._-]{0,119})";alg="(hmac-sha256|ed25519)";tag="aeostudio-signed-webhook-v1"$/u.exec(
      rest,
    );
  if (match === null) return null;
  const created = Number(match[1]);
  const expires = Number(match[2]);
  if (!Number.isSafeInteger(created) || !Number.isSafeInteger(expires) || expires <= created) {
    return null;
  }
  const nonce = match[3];
  const keyId = match[4];
  const algorithmTokenValue = match[5];
  if (nonce === undefined || keyId === undefined || algorithmTokenValue === undefined) return null;
  const serialized = value.slice(`${SIGNATURE_LABEL}=`.length);
  return {
    serialized,
    created,
    expires,
    nonce,
    keyId,
    algorithm: algorithmTokenValue === 'hmac-sha256' ? 'HMAC_SHA256' : 'ED25519',
  };
}

function parseSignature(value: string): Buffer | null {
  const match = /^aeo=:([A-Za-z0-9+/]+={0,2}):$/u.exec(value);
  const encoded = match?.[1];
  if (encoded === undefined) return null;
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.toString('base64') === encoded ? decoded : null;
}

function parseContentDigest(value: string): string | null {
  const match = /^sha-256=:([A-Za-z0-9+/]+={0,2}):$/u.exec(value);
  const encoded = match?.[1];
  if (encoded === undefined) return null;
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.byteLength !== 32 || decoded.toString('base64') !== encoded) return null;
  const hex = decoded.toString('hex');
  return SHA256_PATTERN.test(hex) ? hex : null;
}

function signSignature(key: SignedWebhookSigningKey, data: Uint8Array): Buffer {
  if (key.algorithm === 'HMAC_SHA256') {
    return createHmac('sha256', key.signingMaterial).update(data).digest();
  }
  return signEd25519(null, data, createPrivateKey(key.signingMaterial));
}

function verifySignature(
  key: SignedWebhookVerificationKey,
  data: Uint8Array,
  signature: Buffer,
): boolean {
  try {
    if (key.algorithm === 'HMAC_SHA256') {
      if (Buffer.byteLength(key.verificationMaterial, 'utf8') < 32) return false;
      const expected = createHmac('sha256', key.verificationMaterial).update(data).digest();
      return expected.byteLength === signature.byteLength && timingSafeEqual(expected, signature);
    }
    const publicKey = createPublicKey(key.verificationMaterial);
    return (
      publicKey.asymmetricKeyType === 'ed25519' && verifyEd25519(null, data, publicKey, signature)
    );
  } catch {
    return false;
  }
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> | null {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (normalized[lowerName] !== undefined) return null;
    normalized[lowerName] = value;
  }
  return normalized;
}

function algorithmToken(algorithm: SignedWebhookSigningAlgorithm): 'hmac-sha256' | 'ed25519' {
  return algorithm === 'HMAC_SHA256' ? 'hmac-sha256' : 'ed25519';
}

function safeHexEqual(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCanonicalInstant(value: string): boolean {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function assertJcsValue(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (!hasWellFormedUnicode(value)) throw new Error('WEBHOOK_BODY_INVALID');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('WEBHOOK_BODY_INVALID');
    return;
  }
  if (typeof value !== 'object') throw new Error('WEBHOOK_BODY_INVALID');
  if (seen.has(value)) throw new Error('WEBHOOK_BODY_INVALID');
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new Error('WEBHOOK_BODY_INVALID');
      assertJcsValue(value[index], seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('WEBHOOK_BODY_INVALID');
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!hasWellFormedUnicode(key)) throw new Error('WEBHOOK_BODY_INVALID');
      assertJcsValue(entry, seen);
    }
  }
  seen.delete(value);
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
