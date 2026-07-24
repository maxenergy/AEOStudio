import type {
  PublicationAdapter,
  PublicationAdapterAuthorizationResult,
  PublicationAdapterCommand,
  PublicationAdapterDescriptor,
  PublicationAdapterPreviewCommand,
  PublicationAdapterPreviewResult,
  PublicationAdapterPublishResult,
  PublicationAdapterReconcileResult,
} from '@aeostudio/application/channels-publishing';
import {
  decodeSignedWebhookTarget,
  signedWebhookRequiredScopes,
  SignedWebhookDeliveryV1Schema,
  SignedWebhookReceiptQueryV1Schema,
  SignedWebhookReceiptV1Schema,
  type SignedWebhookDeliveryV1,
  type SignedWebhookReceiptQueryV1,
  type SignedWebhookReceiptV1,
  type SignedWebhookTargetV1,
} from '@aeostudio/contracts/channels';
import type { PublicationRemoteState } from '@aeostudio/domain/channels-publishing';

import {
  SafeSignedWebhookHttpClient,
  type SafeSignedWebhookPostResult,
  type SignedWebhookDnsResolver,
  type SignedWebhookHttpResponse,
  type SignedWebhookHttpTransport,
} from './signed-webhook-http-client.js';
import {
  canonicalSignedWebhookBody,
  createSignedWebhookRequest,
  decodeCanonicalSignedWebhookBody,
  requireActiveSigningKey,
  requireReconciliationSigningKey,
  SIGNED_WEBHOOK_SIGNATURE_VALIDITY_SECONDS,
  type SignedWebhookClock,
  type SignedWebhookSigningKey,
} from './signed-webhook-protocol.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
const GENERIC_REJECTION = 'WEBHOOK_CONFIGURATION_REJECTED';

export interface SignedWebhookVerifiedEndpoint {
  endpointUrl: string;
  receiptUrl: string;
  endpointVerificationId: string;
  algorithm: SignedWebhookTargetV1['algorithm'];
  keyId: string;
}

export interface SignedWebhookPublicationAdapterOptions {
  adapterKey: string;
  adapterVersion: string;
  descriptor: Omit<PublicationAdapterDescriptor, 'adapterKey' | 'adapterVersion'>;
  verifiedEndpoints: SignedWebhookVerifiedEndpoint[];
  resolver: SignedWebhookDnsResolver;
  transport: SignedWebhookHttpTransport;
  clock: SignedWebhookClock;
  nextNonce(): string;
  maxTimestampSkewSeconds: number;
  timeoutMs: number;
}

/** Generic publication Adapter for one pre-verified, versioned signed-webhook endpoint. */
export class SignedWebhookPublicationAdapter implements PublicationAdapter {
  readonly adapterKey: string;
  readonly adapterVersion: string;

  private readonly descriptor: Omit<PublicationAdapterDescriptor, 'adapterKey' | 'adapterVersion'>;
  private readonly verifiedEndpoints: SignedWebhookVerifiedEndpoint[];
  private readonly client: SafeSignedWebhookHttpClient;
  private readonly clock: SignedWebhookClock;
  private readonly nextNonce: () => string;
  private readonly maxTimestampSkewSeconds: number;
  private readonly timeoutMs: number;

  constructor(options: SignedWebhookPublicationAdapterOptions) {
    this.adapterKey = options.adapterKey;
    this.adapterVersion = options.adapterVersion;
    this.descriptor = structuredClone(options.descriptor);
    this.verifiedEndpoints = options.verifiedEndpoints.map((endpoint) => ({ ...endpoint }));
    this.client = new SafeSignedWebhookHttpClient(options.resolver, options.transport);
    this.clock = options.clock;
    this.nextNonce = () => options.nextNonce();
    this.maxTimestampSkewSeconds = options.maxTimestampSkewSeconds;
    this.timeoutMs = options.timeoutMs;
    if (this.maxTimestampSkewSeconds !== SIGNED_WEBHOOK_SIGNATURE_VALIDITY_SECONDS) {
      throw new Error('WEBHOOK_TIMESTAMP_POLICY_INVALID');
    }
  }

  describe(): PublicationAdapterDescriptor {
    return {
      adapterKey: this.adapterKey,
      adapterVersion: this.adapterVersion,
      ...structuredClone(this.descriptor),
    };
  }

  authorizationTargetFor(publicationTarget: string): string {
    this.requireVerifiedTarget(publicationTarget);
    return publicationTarget;
  }

  requiredScopesFor(input: {
    target: string;
    channelPackage: PublicationAdapterCommand['channelPackage'];
  }): string[] {
    this.requireVerifiedTarget(input.target);
    return signedWebhookRequiredScopes();
  }

  validateAuthorization(
    command: PublicationAdapterCommand,
  ): Promise<PublicationAdapterAuthorizationResult> {
    try {
      const target = this.requireVerifiedTarget(command.target);
      // The Worker uses this common preflight for both PUBLISH and RECONCILE. During an explicit
      // rotation overlap an ambiguous delivery keeps its immutable old target, so the target key
      // may be a still-valid historical key. The operation-specific boundary below remains
      // fail-closed: publish requires the active key, while reconcile requires the exact target key.
      requireReconciliationSigningKey({
        secretValue: command.secretValue,
        targetKeyId: target.keyId,
        targetAlgorithm: target.algorithm,
        now: this.clock.now(),
      });
      this.buildDelivery(command);
      return Promise.resolve({ outcome: 'VALID' });
    } catch {
      return Promise.resolve({ outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' });
    }
  }

  preview(command: PublicationAdapterPreviewCommand): PublicationAdapterPreviewResult {
    this.requireVerifiedTarget(command.target);
    this.buildDelivery({
      ...command,
      publicationId: command.channelPackage.id,
      idempotencyKey: command.channelPackage.id,
      secretValue: '',
    });
    return {
      packageChecksum: command.channelPackage.packageChecksum,
      files: { ...command.payload.files },
    };
  }

  async publish(command: PublicationAdapterCommand): Promise<PublicationAdapterPublishResult> {
    try {
      const prepared = this.prepareDelivery(command, 'PUBLISH');
      const result = await this.client.post({
        url: prepared.target.endpointUrl,
        verifiedUrl: prepared.target.endpointUrl,
        headers: prepared.request.headers,
        body: prepared.request.body,
        timeoutMs: this.timeoutMs,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });
      return this.classifyPostResult(result, prepared.expectedReceipt, 'PUBLISH');
    } catch {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: GENERIC_REJECTION };
    }
  }

  async reconcile(command: PublicationAdapterCommand): Promise<PublicationAdapterReconcileResult> {
    try {
      const prepared = this.prepareDelivery(command, 'RECONCILE');
      const query = receiptQueryFor(command, prepared.request.bodySha256);
      const request = this.signBody({
        target: prepared.target,
        key: prepared.key,
        webhookId: command.publicationId,
        url: prepared.target.receiptUrl,
        bodyValue: query,
      });
      const result = await this.client.post({
        url: prepared.target.receiptUrl,
        verifiedUrl: prepared.target.receiptUrl,
        headers: request.headers,
        body: request.body,
        timeoutMs: this.timeoutMs,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });
      return this.classifyPostResult(result, prepared.expectedReceipt, 'RECONCILE');
    } catch {
      return { outcome: 'AMBIGUOUS', errorCode: 'WEBHOOK_RECONCILIATION_UNAVAILABLE' };
    }
  }

  private prepareDelivery(
    command: PublicationAdapterCommand,
    operation: 'PUBLISH' | 'RECONCILE',
  ): {
    target: SignedWebhookTargetV1;
    key: SignedWebhookSigningKey;
    request: ReturnType<typeof createSignedWebhookRequest>;
    expectedReceipt: ExpectedReceipt;
  } {
    const target = this.requireVerifiedTarget(command.target);
    const signingKeyInput = {
      secretValue: command.secretValue,
      targetKeyId: target.keyId,
      targetAlgorithm: target.algorithm,
      now: this.clock.now(),
    };
    const key =
      operation === 'PUBLISH'
        ? requireActiveSigningKey(signingKeyInput)
        : requireReconciliationSigningKey(signingKeyInput);
    const delivery = this.buildDelivery(command);
    const request = this.signBody({
      target,
      key,
      webhookId: command.publicationId,
      url: target.endpointUrl,
      bodyValue: delivery,
    });
    return {
      target,
      key,
      request,
      expectedReceipt: expectedReceiptFor(command, target, request.bodySha256),
    };
  }

  private signBody(input: {
    target: SignedWebhookTargetV1;
    key: SignedWebhookSigningKey;
    webhookId: string;
    url: string;
    bodyValue: unknown;
  }): ReturnType<typeof createSignedWebhookRequest> {
    return createSignedWebhookRequest({
      url: input.url,
      webhookId: input.webhookId,
      bodyValue: input.bodyValue,
      key: input.key,
      now: this.clock.now(),
      nonce: this.nextNonce(),
      maxTimestampSkewSeconds: this.maxTimestampSkewSeconds,
    });
  }

  private requireVerifiedTarget(value: string): SignedWebhookTargetV1 {
    let target: SignedWebhookTargetV1;
    try {
      target = decodeSignedWebhookTarget(value);
    } catch {
      throw new Error('WEBHOOK_TARGET_INVALID');
    }
    const verified = this.verifiedEndpoints.some(
      (endpoint) =>
        endpoint.endpointUrl === target.endpointUrl &&
        endpoint.receiptUrl === target.receiptUrl &&
        endpoint.endpointVerificationId === target.endpointVerificationId &&
        endpoint.algorithm === target.algorithm &&
        endpoint.keyId === target.keyId,
    );
    if (!verified) throw new Error('WEBHOOK_TARGET_NOT_VERIFIED');
    return target;
  }

  private buildDelivery(command: PublicationAdapterCommand): SignedWebhookDeliveryV1 {
    const fileNames = Object.keys(command.payload.files).sort();
    if (
      fileNames.length !== 3 ||
      fileNames[0] !== 'content.html' ||
      fileNames[1] !== 'content.md' ||
      fileNames[2] !== 'structured-data.json'
    ) {
      throw new Error('WEBHOOK_PACKAGE_INVALID');
    }
    const candidate = {
      schemaVersion: '1.0.0',
      eventType: 'channel-package.approved.v1',
      deliveryId: command.publicationId,
      publicationId: command.publicationId,
      channelPackage: {
        tenantId: command.channelPackage.tenantId,
        workspaceId: command.channelPackage.workspaceId,
        id: command.channelPackage.id,
        packageRevision: command.channelPackage.packageRevision,
        packageChecksum: command.channelPackage.packageChecksum,
        packageSchemaVersion: command.channelPackage.packageSchemaVersion,
        channel: { ...command.channelPackage.channel },
        transformer: { ...command.channelPackage.transformer },
        artifact: structuredClone(command.channelPackage.artifact),
        manifest: structuredClone(command.channelPackage.manifest),
        files: {
          'content.md': command.payload.files['content.md'],
          'content.html': command.payload.files['content.html'],
          'structured-data.json': command.payload.files['structured-data.json'],
        },
      },
    };
    const parsed = SignedWebhookDeliveryV1Schema.safeParse(candidate);
    if (!parsed.success) throw new Error('WEBHOOK_PACKAGE_INVALID');
    return parsed.data;
  }

  private classifyPostResult(
    result: SafeSignedWebhookPostResult,
    expected: ExpectedReceipt,
    operation: 'PUBLISH' | 'RECONCILE',
  ): PublicationAdapterPublishResult | PublicationAdapterReconcileResult {
    if (result.outcome !== 'SUCCEEDED') {
      return classifyClientFailure(result.errorCode, operation);
    }
    return classifyHttpResponse(result.response, expected, operation);
  }
}

interface ExpectedReceipt {
  deliveryId: string;
  publicationId: string;
  channelPackageId: string;
  packageRevision: number;
  packageChecksum: string;
  artifactRevisionId: string;
  artifactContentHash: string;
  requestBodySha256: string;
  remoteRef: string;
  verifiedKeyId: string;
  verifiedAlgorithm: SignedWebhookTargetV1['algorithm'];
}

function expectedReceiptFor(
  command: PublicationAdapterCommand,
  target: SignedWebhookTargetV1,
  requestBodySha256: string,
): ExpectedReceipt {
  return {
    deliveryId: command.publicationId,
    publicationId: command.publicationId,
    channelPackageId: command.channelPackage.id,
    packageRevision: command.channelPackage.packageRevision,
    packageChecksum: command.channelPackage.packageChecksum,
    artifactRevisionId: command.channelPackage.artifact.artifactRevisionId,
    artifactContentHash: command.channelPackage.artifact.contentHash,
    requestBodySha256,
    remoteRef: receiptRemoteRef(target.receiptUrl, command.publicationId),
    verifiedKeyId: target.keyId,
    verifiedAlgorithm: target.algorithm,
  };
}

function receiptQueryFor(
  command: PublicationAdapterCommand,
  requestBodySha256: string,
): SignedWebhookReceiptQueryV1 {
  const parsed = SignedWebhookReceiptQueryV1Schema.safeParse({
    schemaVersion: '1.0.0',
    queryType: 'channel-package.delivery-receipt.v1',
    deliveryId: command.publicationId,
    publicationId: command.publicationId,
    channelPackageId: command.channelPackage.id,
    packageRevision: command.channelPackage.packageRevision,
    packageChecksum: command.channelPackage.packageChecksum,
    artifactRevisionId: command.channelPackage.artifact.artifactRevisionId,
    artifactContentHash: command.channelPackage.artifact.contentHash,
    requestBodySha256,
  });
  if (!parsed.success) throw new Error('WEBHOOK_PACKAGE_INVALID');
  return parsed.data;
}

function classifyClientFailure(
  errorCode: string,
  operation: 'PUBLISH' | 'RECONCILE',
): PublicationAdapterPublishResult | PublicationAdapterReconcileResult {
  if (operation === 'RECONCILE') {
    return { outcome: 'AMBIGUOUS', errorCode: `WEBHOOK_${errorCode}` };
  }
  switch (errorCode) {
    case 'CONNECTION_ADDRESS_MISMATCH':
    case 'CONNECT_FAILED':
    case 'FETCH_TIMEOUT':
    case 'REDIRECT_FORBIDDEN':
    case 'REQUEST_RESULT_UNKNOWN':
    case 'RESPONSE_TOO_LARGE':
    case 'TRANSPORT_ERROR':
      return { outcome: 'AMBIGUOUS', errorCode: `WEBHOOK_${errorCode}` };
    case 'DNS_NO_ADDRESS':
    case 'DNS_RESOLUTION_FAILED':
    case 'REQUEST_TOO_LARGE':
    case 'TLS_FAILED':
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: `WEBHOOK_${errorCode}` };
    default:
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'WEBHOOK_SSRF_BLOCKED' };
  }
}

function classifyHttpResponse(
  response: SignedWebhookHttpResponse,
  expected: ExpectedReceipt,
  operation: 'PUBLISH' | 'RECONCILE',
): PublicationAdapterPublishResult | PublicationAdapterReconcileResult {
  if (response.status === 200 || response.status === 201) {
    const receipt = parseReceipt(response.body);
    if (receipt === null || !receiptMatches(receipt, expected)) {
      return { outcome: 'AMBIGUOUS', errorCode: 'WEBHOOK_RECEIPT_MISMATCH' };
    }
    switch (receipt.status) {
      case 'APPLIED':
      case 'ALREADY_APPLIED':
        return appliedReceipt(receipt);
      case 'NOT_FOUND':
        return operation === 'RECONCILE'
          ? { outcome: 'AMBIGUOUS', errorCode: 'WEBHOOK_RECEIPT_NOT_FOUND' }
          : { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'WEBHOOK_RECEIPT_NOT_FOUND' };
      case 'PENDING':
        return { outcome: 'AMBIGUOUS', errorCode: 'WEBHOOK_RECEIPT_PENDING' };
      case 'CONFLICT':
        return { outcome: 'AMBIGUOUS', errorCode: 'WEBHOOK_RECEIPT_CONFLICT' };
    }
  }
  if (response.status === 202) {
    return { outcome: 'AMBIGUOUS', errorCode: 'WEBHOOK_RECEIPT_PENDING' };
  }
  if (response.status === 429) {
    return { outcome: 'AMBIGUOUS', errorCode: 'WEBHOOK_RATE_LIMITED_RESULT_UNKNOWN' };
  }
  if (response.status === 408 || response.status >= 500) {
    return { outcome: 'AMBIGUOUS', errorCode: 'WEBHOOK_REMOTE_RESULT_UNKNOWN' };
  }
  if (response.status === 409) {
    return { outcome: 'AMBIGUOUS', errorCode: 'WEBHOOK_RECEIPT_CONFLICT' };
  }
  const receiverError = safeReceiverError(response.headers);
  if (response.status >= 400 && response.status < 500 && operation === 'PUBLISH') {
    return explicitNoEffectRejection(response.status, receiverError)
      ? { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: receiverError }
      : { outcome: 'AMBIGUOUS', errorCode: 'WEBHOOK_REQUEST_REJECTED_RESULT_UNKNOWN' };
  }
  return { outcome: 'AMBIGUOUS', errorCode: 'WEBHOOK_REMOTE_RESULT_UNKNOWN' };
}

function parseReceipt(body: Uint8Array): SignedWebhookReceiptV1 | null {
  try {
    const parsed = SignedWebhookReceiptV1Schema.safeParse(decodeCanonicalSignedWebhookBody(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function receiptMatches(receipt: SignedWebhookReceiptV1, expected: ExpectedReceipt): boolean {
  return (
    receipt.deliveryId === expected.deliveryId &&
    receipt.publicationId === expected.publicationId &&
    receipt.channelPackageId === expected.channelPackageId &&
    receipt.packageRevision === expected.packageRevision &&
    receipt.packageChecksum === expected.packageChecksum &&
    receipt.artifactRevisionId === expected.artifactRevisionId &&
    receipt.artifactContentHash === expected.artifactContentHash &&
    receipt.requestBodySha256 === expected.requestBodySha256 &&
    receipt.remoteRef === expected.remoteRef &&
    receipt.verifiedKeyId === expected.verifiedKeyId &&
    receipt.verifiedAlgorithm === expected.verifiedAlgorithm &&
    receipt.isProductionLive === false
  );
}

function appliedReceipt(receipt: SignedWebhookReceiptV1): PublicationAdapterPublishResult {
  if (receipt.receiverEffectId === null) {
    return { outcome: 'AMBIGUOUS', errorCode: 'WEBHOOK_RECEIPT_MISMATCH' };
  }
  const remoteState: PublicationRemoteState = {
    status: 'DELIVERED',
    number: null,
    isProductionLive: false,
    rollbackHandle: null,
    receiptEvidence: {
      schemaVersion: 'signed-webhook-receipt-evidence.v1',
      receiptId: receipt.receiptId,
      deliveryId: receipt.deliveryId,
      receiverEffectId: receipt.receiverEffectId,
      requestBodySha256: receipt.requestBodySha256,
      verifiedKeyId: receipt.verifiedKeyId,
      verifiedAlgorithm: receipt.verifiedAlgorithm,
      receivedAt: receipt.receivedAt,
    },
  };
  return { outcome: 'APPLIED', remoteRef: receipt.remoteRef, remoteState };
}

function safeReceiverError(headers: Record<string, string>): string | null {
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'aeostudio-webhook-error',
  );
  const value = entry?.[1];
  return value !== undefined && /^WEBHOOK_[A-Z0-9_]{1,112}$/u.test(value) ? value : null;
}

function explicitNoEffectRejection(status: number, errorCode: string | null): errorCode is string {
  return (
    (status === 401 &&
      (errorCode === 'WEBHOOK_SIGNATURE_REJECTED' || errorCode === 'WEBHOOK_TIMESTAMP_REJECTED')) ||
    (status === 400 && errorCode === 'WEBHOOK_PACKAGE_REJECTED')
  );
}

export function receiptRemoteRef(receiptUrl: string, deliveryId: string): string {
  return `${receiptUrl.endsWith('/') ? receiptUrl.slice(0, -1) : receiptUrl}/${deliveryId}`;
}

export function requestBodySha256ForDelivery(delivery: SignedWebhookDeliveryV1): string {
  return canonicalSignedWebhookBody(delivery).bodySha256;
}
