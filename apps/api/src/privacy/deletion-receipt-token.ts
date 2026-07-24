import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  TenantDeletionReceiptSchema,
  type TenantDeletionReceipt,
} from '@aeostudio/contracts/privacy-audit';

const TOKEN_SCHEMA_VERSION = 'deletion-receipt-capability.v1';
const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const MAX_TOKEN_LENGTH = 4_096;

export const DELETION_RECEIPT_COOKIE = '__Host-aeo_deletion_receipt';
export const DELETION_RECEIPT_TOKEN_HEADER = 'x-aeo-deletion-receipt-token';
export const DELETION_RECEIPT_COOKIE_TTL_SECONDS = DEFAULT_TTL_MS / 1_000;

export interface DeletionReceiptTokenService {
  isReady(): boolean;
  issue(receipt: TenantDeletionReceipt): string;
  verify(token: string): TenantDeletionReceipt | null;
}

export class MissingDeletionReceiptTokenService implements DeletionReceiptTokenService {
  isReady(): false {
    return false;
  }

  issue(): never {
    throw new Error('DELETION_RECEIPT_TOKEN_SERVICE_NOT_CONFIGURED');
  }

  verify(): null {
    return null;
  }
}

export class HmacDeletionReceiptTokenService implements DeletionReceiptTokenService {
  private readonly signingKey: Buffer;
  private readonly clock: { now(): Date };
  private readonly ttlMs: number;

  public constructor(input: { signingKey: Buffer; clock: { now(): Date }; ttlMs?: number }) {
    if (input.signingKey.byteLength < 32) {
      throw new Error('DELETION_RECEIPT_SIGNING_KEY_TOO_SHORT');
    }
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 10 * 60 * 1_000) {
      throw new Error('DELETION_RECEIPT_TTL_INVALID');
    }
    this.signingKey = Buffer.from(input.signingKey);
    this.clock = input.clock;
    this.ttlMs = ttlMs;
  }

  isReady(): true {
    return true;
  }

  issue(receipt: TenantDeletionReceipt): string {
    const parsedReceipt = TenantDeletionReceiptSchema.safeParse(receipt);
    const issuedAt = this.clock.now();
    if (!parsedReceipt.success || !Number.isFinite(issuedAt.getTime())) {
      throw new Error('DELETION_RECEIPT_INVALID');
    }
    const expiresAt = new Date(issuedAt.getTime() + this.ttlMs);
    const payload = Buffer.from(
      JSON.stringify({
        schemaVersion: TOKEN_SCHEMA_VERSION,
        receipt: parsedReceipt.data,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        nonce: randomUUID(),
      }),
      'utf8',
    ).toString('base64url');
    return `${payload}.${this.sign(payload).toString('base64url')}`;
  }

  verify(token: string): TenantDeletionReceipt | null {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, suppliedSignature] = parts;
    if (
      payload === undefined ||
      suppliedSignature === undefined ||
      !/^[A-Za-z0-9_-]+$/u.test(payload) ||
      !/^[A-Za-z0-9_-]+$/u.test(suppliedSignature)
    ) {
      return null;
    }
    let signature: Buffer;
    try {
      signature = Buffer.from(suppliedSignature, 'base64url');
    } catch {
      return null;
    }
    const expected = this.sign(payload);
    if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
      return null;
    }

    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
      if (!isTokenPayload(decoded)) return null;
      const receipt = TenantDeletionReceiptSchema.safeParse(decoded.receipt);
      if (!receipt.success) return null;
      const issuedAt = Date.parse(decoded.issuedAt);
      const expiresAt = Date.parse(decoded.expiresAt);
      const now = this.clock.now().getTime();
      if (
        !Number.isFinite(now) ||
        !Number.isFinite(issuedAt) ||
        !Number.isFinite(expiresAt) ||
        expiresAt - issuedAt !== this.ttlMs ||
        now < issuedAt ||
        now >= expiresAt
      ) {
        return null;
      }
      return receipt.data;
    } catch {
      return null;
    }
  }

  private sign(payload: string): Buffer {
    return createHmac('sha256', this.signingKey).update(payload, 'utf8').digest();
  }
}

function isTokenPayload(value: unknown): value is {
  schemaVersion: typeof TOKEN_SCHEMA_VERSION;
  receipt: unknown;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'expiresAt,issuedAt,nonce,receipt,schemaVersion') {
    return false;
  }
  return (
    record.schemaVersion === TOKEN_SCHEMA_VERSION &&
    typeof record.issuedAt === 'string' &&
    typeof record.expiresAt === 'string' &&
    typeof record.nonce === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(record.nonce)
  );
}
