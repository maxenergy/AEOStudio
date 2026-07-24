import {
  SignedWebhookDeliveryV1Schema,
  SignedWebhookReceiptQueryV1Schema,
  SignedWebhookReceiptV1Schema,
  type SignedWebhookDeliveryV1,
  type SignedWebhookReceiptQueryV1,
  type SignedWebhookReceiptV1,
} from '@aeostudio/contracts/channels';

import type {
  SignedWebhookHttpResponse,
  SignedWebhookHttpTransport,
} from './signed-webhook-http-client.js';
import {
  canonicalSignedWebhookBody,
  decodeCanonicalSignedWebhookBody,
  SIGNED_WEBHOOK_SIGNATURE_VALIDITY_SECONDS,
  verifySignedWebhookRequest,
  type SignedWebhookClock,
  type SignedWebhookSigningAlgorithm,
  type SignedWebhookVerificationKey,
  type VerifiedSignedWebhookRequest,
} from './signed-webhook-protocol.js';
import { receiptRemoteRef } from './signed-webhook-publication-adapter.js';

export type FakeSignedWebhookFailureMode =
  | 'TIMEOUT_AFTER_EFFECT'
  | 'FIVE_HUNDRED_AFTER_EFFECT'
  | 'ACCEPTED_PENDING'
  | 'TOO_MANY_REQUESTS'
  | 'ARBITRARY_FOUR_HUNDRED'
  | 'MALFORMED_UNICODE_RECEIPT'
  | 'TAMPER_BODY';

export interface VersionedFakeWebhookReceiverOptions {
  deliveryUrl: string;
  receiptUrl: string;
  endpointVerificationId: string;
  address: string;
  verificationKeys: SignedWebhookVerificationKey[];
  clock: SignedWebhookClock;
  maxTimestampSkewSeconds: number;
  log(entry: string): void;
}

export interface VersionedFakeWebhookReceiverSnapshot {
  effectCount: number;
  deliveryRequestCount: number;
  receiptQueryCount: number;
  replayRejectCount: number;
  signatureRejectCount: number;
  timestampRejectCount: number;
  receiptQueryKeyIds: string[];
  effects: Array<{
    deliveryId: string;
    receiverEffectId: string;
    keyId: string;
    algorithm: SignedWebhookSigningAlgorithm;
    requestBodySha256: string;
    packageChecksum: string;
    artifactRevisionId: string;
    artifactContentHash: string;
  }>;
}

interface StoredEffect {
  deliveryId: string;
  publicationId: string;
  receiverEffectId: string;
  keyId: string;
  algorithm: SignedWebhookSigningAlgorithm;
  requestBodySha256: string;
  channelPackageId: string;
  packageRevision: number;
  packageChecksum: string;
  artifactRevisionId: string;
  artifactContentHash: string;
  receivedAt: string;
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** In-memory receiver used only by contract tests and explicitly enabled fake runtimes. */
export class VersionedFakeWebhookReceiver implements SignedWebhookHttpTransport {
  private readonly deliveryUrl: string;
  private readonly receiptUrl: string;
  private readonly endpointVerificationId: string;
  private readonly address: string;
  private readonly verificationKeys: SignedWebhookVerificationKey[];
  private readonly clock: SignedWebhookClock;
  private readonly maxTimestampSkewSeconds: number;
  private readonly log: (entry: string) => void;
  private readonly nonceExpirations = new Map<string, number>();
  private readonly effects = new Map<string, StoredEffect>();
  private readonly failures: FakeSignedWebhookFailureMode[] = [];

  private deliveryRequestCount = 0;
  private receiptQueryCount = 0;
  private replayRejectCount = 0;
  private signatureRejectCount = 0;
  private timestampRejectCount = 0;
  private readonly receiptQueryKeyIds: string[] = [];
  private lastDeliveryRequest: CapturedRequest | null = null;

  constructor(options: VersionedFakeWebhookReceiverOptions) {
    this.deliveryUrl = options.deliveryUrl;
    this.receiptUrl = options.receiptUrl;
    this.endpointVerificationId = options.endpointVerificationId;
    this.address = options.address;
    this.verificationKeys = options.verificationKeys.map((key) => ({ ...key }));
    this.clock = options.clock;
    this.maxTimestampSkewSeconds = options.maxTimestampSkewSeconds;
    this.log = (entry) => options.log(entry);
    if (!isUuid(this.endpointVerificationId)) throw new Error('WEBHOOK_RECEIVER_CONFIG_INVALID');
    if (this.maxTimestampSkewSeconds !== SIGNED_WEBHOOK_SIGNATURE_VALIDITY_SECONDS) {
      throw new Error('WEBHOOK_RECEIVER_CONFIG_INVALID');
    }
  }

  queueFailure(mode: FakeSignedWebhookFailureMode): void {
    this.failures.push(mode);
  }

  post(input: {
    url: string;
    address: string;
    headers: Record<string, string>;
    body: Uint8Array;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<SignedWebhookHttpResponse> {
    if (input.address !== this.address) {
      return Promise.resolve(this.response(502, { reason: 'CONNECTED_ADDRESS_MISMATCH' }));
    }
    if (input.url === this.deliveryUrl) {
      return Promise.resolve(
        this.receiveDelivery({
          url: input.url,
          headers: { ...input.headers },
          body: input.body.slice(),
        }),
      );
    }
    if (input.url === this.receiptUrl) {
      return Promise.resolve(
        this.receiveReceiptQuery({
          url: input.url,
          headers: { ...input.headers },
          body: input.body.slice(),
        }),
      );
    }
    return Promise.resolve(this.response(404, { reason: 'ENDPOINT_NOT_FOUND' }));
  }

  replayLastRequest(): Promise<{ status: number; reason: string }> {
    const request = this.lastDeliveryRequest;
    if (request === null) return Promise.resolve({ status: 404, reason: 'NO_REQUEST' });
    const verified = this.verifyRequest(request);
    if (verified.outcome === 'REPLAY_REJECTED') {
      return Promise.resolve({ status: 409, reason: 'REPLAY_REJECTED' });
    }
    return Promise.resolve({ status: 400, reason: 'REPLAY_NOT_REJECTED' });
  }

  snapshot(): VersionedFakeWebhookReceiverSnapshot {
    return {
      effectCount: this.effects.size,
      deliveryRequestCount: this.deliveryRequestCount,
      receiptQueryCount: this.receiptQueryCount,
      replayRejectCount: this.replayRejectCount,
      signatureRejectCount: this.signatureRejectCount,
      timestampRejectCount: this.timestampRejectCount,
      receiptQueryKeyIds: [...this.receiptQueryKeyIds],
      effects: [...this.effects.values()].map((effect) => ({
        deliveryId: effect.deliveryId,
        receiverEffectId: effect.receiverEffectId,
        keyId: effect.keyId,
        algorithm: effect.algorithm,
        requestBodySha256: effect.requestBodySha256,
        packageChecksum: effect.packageChecksum,
        artifactRevisionId: effect.artifactRevisionId,
        artifactContentHash: effect.artifactContentHash,
      })),
    };
  }

  private receiveDelivery(request: CapturedRequest): SignedWebhookHttpResponse {
    this.deliveryRequestCount += 1;
    this.lastDeliveryRequest = cloneRequest(request);
    const mode = this.failures.shift();
    if (mode === 'TAMPER_BODY') {
      const tampered = request.body.slice();
      if (tampered.byteLength === 0) return this.signatureRejectedResponse();
      tampered[tampered.byteLength - 1] = (tampered[tampered.byteLength - 1] ?? 0) ^ 1;
      const result = this.verifyRequest({ ...request, body: tampered });
      if (result.outcome !== 'SIGNATURE_REJECTED') {
        return this.response(500, { reason: 'TAMPER_TEST_FAILED' });
      }
      return this.signatureRejectedResponse(false);
    }

    const verification = this.verifyRequest(request);
    if (verification.outcome !== 'VERIFIED') return this.rejectionResponse(verification.outcome);
    const delivery = parseDelivery(request.body);
    if (delivery === null || headerValue(request.headers, 'webhook-id') !== delivery.deliveryId) {
      return this.response(400, { reason: 'DELIVERY_SCHEMA_INVALID' }, 'WEBHOOK_PACKAGE_REJECTED');
    }
    if (mode === 'ACCEPTED_PENDING') {
      this.safeLog(`pending delivery=${delivery.deliveryId}`);
      return this.response(202, { reason: 'PENDING' });
    }
    if (mode === 'TOO_MANY_REQUESTS') {
      this.safeLog(`rate-limited delivery=${delivery.deliveryId}`);
      return this.response(429, { reason: 'RATE_LIMITED_RESULT_UNKNOWN' });
    }
    if (mode === 'ARBITRARY_FOUR_HUNDRED') {
      return this.response(400, { reason: 'UNSPECIFIED_REJECTION' }, 'WEBHOOK_FAKE_REJECTION');
    }

    const existing = this.effects.get(delivery.deliveryId);
    if (existing !== undefined && existing.requestBodySha256 !== verification.verified.bodySha256) {
      return this.response(409, { reason: 'DELIVERY_ID_CONFLICT' });
    }
    const effect = existing ?? this.createEffect(delivery, verification.verified);
    if (existing === undefined) this.effects.set(delivery.deliveryId, effect);
    this.safeLog(
      `${existing === undefined ? 'applied' : 'duplicate'} delivery=${effect.deliveryId} key=${effect.keyId} alg=${effect.algorithm}`,
    );

    if (mode === 'TIMEOUT_AFTER_EFFECT') throw new FakeWebhookTransportError('FETCH_TIMEOUT');
    if (mode === 'FIVE_HUNDRED_AFTER_EFFECT') {
      return this.response(500, { reason: 'RECEIPT_TEMPORARILY_UNAVAILABLE' });
    }
    if (mode === 'MALFORMED_UNICODE_RECEIPT') {
      return this.malformedUnicodeReceiptResponse(effect);
    }
    const status = existing === undefined ? 'APPLIED' : 'ALREADY_APPLIED';
    return this.receiptResponse(
      existing === undefined ? 201 : 200,
      this.receiptForEffect(effect, status),
    );
  }

  private receiveReceiptQuery(request: CapturedRequest): SignedWebhookHttpResponse {
    this.receiptQueryCount += 1;
    const verification = this.verifyRequest(request);
    if (verification.outcome !== 'VERIFIED') return this.rejectionResponse(verification.outcome);
    this.receiptQueryKeyIds.push(verification.verified.keyId);
    const query = parseReceiptQuery(request.body);
    if (query === null || headerValue(request.headers, 'webhook-id') !== query.deliveryId) {
      return this.response(400, { reason: 'RECEIPT_QUERY_INVALID' }, 'WEBHOOK_PACKAGE_REJECTED');
    }
    const effect = this.effects.get(query.deliveryId);
    if (effect === undefined) {
      return this.receiptResponse(200, this.receiptForMissingQuery(query, verification.verified));
    }
    if (!effectMatchesQuery(effect, query)) {
      return this.receiptResponse(200, this.receiptForConflict(query, verification.verified));
    }
    this.safeLog(`receipt delivery=${effect.deliveryId} key=${verification.verified.keyId}`);
    return this.receiptResponse(200, this.receiptForEffect(effect, 'APPLIED'));
  }

  private verifyRequest(
    request: CapturedRequest,
  ):
    | { outcome: 'VERIFIED'; verified: VerifiedSignedWebhookRequest }
    | { outcome: 'SIGNATURE_REJECTED' | 'TIMESTAMP_REJECTED' | 'REPLAY_REJECTED' } {
    const result = verifySignedWebhookRequest({
      url: request.url,
      headers: request.headers,
      body: request.body,
      verificationKeys: this.verificationKeys,
      now: this.clock.now(),
      maxTimestampSkewSeconds: this.maxTimestampSkewSeconds,
      nonceWasUsed: (keyId, nonce, nowEpochSeconds) => {
        for (const [cachedNonce, expires] of this.nonceExpirations) {
          if (expires < nowEpochSeconds) this.nonceExpirations.delete(cachedNonce);
        }
        return this.nonceExpirations.has(`${keyId}:${nonce}`);
      },
      rememberNonce: (keyId, nonce, expires) =>
        this.nonceExpirations.set(`${keyId}:${nonce}`, expires),
    });
    if (result.outcome === 'SIGNATURE_REJECTED') this.signatureRejectCount += 1;
    if (result.outcome === 'TIMESTAMP_REJECTED') this.timestampRejectCount += 1;
    if (result.outcome === 'REPLAY_REJECTED') this.replayRejectCount += 1;
    return result;
  }

  private rejectionResponse(
    outcome: 'SIGNATURE_REJECTED' | 'TIMESTAMP_REJECTED' | 'REPLAY_REJECTED',
  ): SignedWebhookHttpResponse {
    switch (outcome) {
      case 'SIGNATURE_REJECTED':
        return this.signatureRejectedResponse(false);
      case 'TIMESTAMP_REJECTED':
        return this.response(401, { reason: outcome }, 'WEBHOOK_TIMESTAMP_REJECTED');
      case 'REPLAY_REJECTED':
        return this.response(409, { reason: outcome }, 'WEBHOOK_REPLAY_REJECTED');
    }
  }

  private signatureRejectedResponse(increment = true): SignedWebhookHttpResponse {
    if (increment) this.signatureRejectCount += 1;
    return this.response(401, { reason: 'SIGNATURE_REJECTED' }, 'WEBHOOK_SIGNATURE_REJECTED');
  }

  private createEffect(
    delivery: SignedWebhookDeliveryV1,
    verified: VerifiedSignedWebhookRequest,
  ): StoredEffect {
    return {
      deliveryId: delivery.deliveryId,
      publicationId: delivery.publicationId,
      receiverEffectId: `effect:${delivery.deliveryId}`,
      keyId: verified.keyId,
      algorithm: verified.algorithm,
      requestBodySha256: verified.bodySha256,
      channelPackageId: delivery.channelPackage.id,
      packageRevision: delivery.channelPackage.packageRevision,
      packageChecksum: delivery.channelPackage.packageChecksum,
      artifactRevisionId: delivery.channelPackage.artifact.artifactRevisionId,
      artifactContentHash: delivery.channelPackage.artifact.contentHash,
      receivedAt: this.clock.now().toISOString(),
    };
  }

  private receiptForEffect(
    effect: StoredEffect,
    status: 'APPLIED' | 'ALREADY_APPLIED',
  ): SignedWebhookReceiptV1 {
    return requireReceipt({
      schemaVersion: '1.0.0',
      receiptType: 'channel-package.delivery-receipt.v1',
      receiptId: `receipt:${effect.deliveryId}`,
      status,
      deliveryId: effect.deliveryId,
      publicationId: effect.publicationId,
      channelPackageId: effect.channelPackageId,
      packageRevision: effect.packageRevision,
      packageChecksum: effect.packageChecksum,
      artifactRevisionId: effect.artifactRevisionId,
      artifactContentHash: effect.artifactContentHash,
      requestBodySha256: effect.requestBodySha256,
      receiverEffectId: effect.receiverEffectId,
      verifiedKeyId: effect.keyId,
      verifiedAlgorithm: effect.algorithm,
      receivedAt: effect.receivedAt,
      remoteRef: receiptRemoteRef(this.receiptUrl, effect.deliveryId),
      isProductionLive: false,
    });
  }

  private receiptForMissingQuery(
    query: SignedWebhookReceiptQueryV1,
    verified: VerifiedSignedWebhookRequest,
  ): SignedWebhookReceiptV1 {
    return requireReceipt({
      schemaVersion: '1.0.0',
      receiptType: 'channel-package.delivery-receipt.v1',
      receiptId: `receipt:not-found:${query.deliveryId}`,
      status: 'NOT_FOUND',
      deliveryId: query.deliveryId,
      publicationId: query.publicationId,
      channelPackageId: query.channelPackageId,
      packageRevision: query.packageRevision,
      packageChecksum: query.packageChecksum,
      artifactRevisionId: query.artifactRevisionId,
      artifactContentHash: query.artifactContentHash,
      requestBodySha256: query.requestBodySha256,
      receiverEffectId: null,
      verifiedKeyId: verified.keyId,
      verifiedAlgorithm: verified.algorithm,
      receivedAt: this.clock.now().toISOString(),
      remoteRef: receiptRemoteRef(this.receiptUrl, query.deliveryId),
      isProductionLive: false,
    });
  }

  private receiptForConflict(
    query: SignedWebhookReceiptQueryV1,
    verified: VerifiedSignedWebhookRequest,
  ): SignedWebhookReceiptV1 {
    return requireReceipt({
      schemaVersion: '1.0.0',
      receiptType: 'channel-package.delivery-receipt.v1',
      receiptId: `receipt:conflict:${query.deliveryId}`,
      status: 'CONFLICT',
      deliveryId: query.deliveryId,
      publicationId: query.publicationId,
      channelPackageId: query.channelPackageId,
      packageRevision: query.packageRevision,
      packageChecksum: query.packageChecksum,
      artifactRevisionId: query.artifactRevisionId,
      artifactContentHash: query.artifactContentHash,
      requestBodySha256: query.requestBodySha256,
      receiverEffectId: null,
      verifiedKeyId: verified.keyId,
      verifiedAlgorithm: verified.algorithm,
      receivedAt: this.clock.now().toISOString(),
      remoteRef: receiptRemoteRef(this.receiptUrl, query.deliveryId),
      isProductionLive: false,
    });
  }

  private receiptResponse(
    status: number,
    receipt: SignedWebhookReceiptV1,
  ): SignedWebhookHttpResponse {
    const canonical = canonicalSignedWebhookBody(receipt);
    return {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: canonical.body,
      location: null,
      connectedAddress: this.address,
    };
  }

  private malformedUnicodeReceiptResponse(effect: StoredEffect): SignedWebhookHttpResponse {
    const receipt = this.receiptForEffect(effect, 'APPLIED');
    const canonical = new TextDecoder().decode(canonicalSignedWebhookBody(receipt).body);
    const invalidCanonical = canonical.replace(JSON.stringify(receipt.receiptId), '"\\ud800"');
    return {
      status: 201,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: new TextEncoder().encode(invalidCanonical),
      location: null,
      connectedAddress: this.address,
    };
  }

  private response(
    status: number,
    bodyValue: Record<string, string>,
    errorCode?: string,
  ): SignedWebhookHttpResponse {
    const canonical = canonicalSignedWebhookBody(bodyValue);
    return {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        ...(errorCode === undefined ? {} : { 'aeostudio-webhook-error': errorCode }),
      },
      body: canonical.body,
      location: null,
      connectedAddress: this.address,
    };
  }

  private safeLog(entry: string): void {
    this.log(`signed-webhook ${entry}`);
  }
}

class FakeWebhookTransportError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'FakeWebhookTransportError';
    this.code = code;
  }
}

function parseDelivery(body: Uint8Array): SignedWebhookDeliveryV1 | null {
  try {
    const result = SignedWebhookDeliveryV1Schema.safeParse(decodeCanonicalSignedWebhookBody(body));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function parseReceiptQuery(body: Uint8Array): SignedWebhookReceiptQueryV1 | null {
  try {
    const result = SignedWebhookReceiptQueryV1Schema.safeParse(
      decodeCanonicalSignedWebhookBody(body),
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function requireReceipt(value: unknown): SignedWebhookReceiptV1 {
  const parsed = SignedWebhookReceiptV1Schema.safeParse(value);
  if (!parsed.success) throw new Error('WEBHOOK_RECEIPT_INVALID');
  return parsed.data;
}

function effectMatchesQuery(effect: StoredEffect, query: SignedWebhookReceiptQueryV1): boolean {
  return (
    effect.deliveryId === query.deliveryId &&
    effect.publicationId === query.publicationId &&
    effect.channelPackageId === query.channelPackageId &&
    effect.packageRevision === query.packageRevision &&
    effect.packageChecksum === query.packageChecksum &&
    effect.artifactRevisionId === query.artifactRevisionId &&
    effect.artifactContentHash === query.artifactContentHash &&
    effect.requestBodySha256 === query.requestBodySha256
  );
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function cloneRequest(request: CapturedRequest): CapturedRequest {
  return {
    url: request.url,
    headers: { ...request.headers },
    body: request.body.slice(),
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
