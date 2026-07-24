export const CHANNEL_AUTHORIZATION_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export type ChannelAuthorizationStatus = (typeof CHANNEL_AUTHORIZATION_STATUSES)[number];

export const CHANNEL_AUTHORIZATION_VALIDATION_STATUSES = [
  'PENDING_VALIDATION',
  'VERIFIED',
  'INVALID',
] as const;
export type ChannelAuthorizationValidationStatus =
  (typeof CHANNEL_AUTHORIZATION_VALIDATION_STATUSES)[number];

export interface ChannelAuthorizationValidationSnapshot {
  /** Provider-observed coverage target, never a browser assertion. */
  actualTarget: string;
  /** Provider-observed or provider-proven least-privilege scopes. */
  actualScopes: string[];
  /** Registry terms version that the validation command was bound to. */
  acceptedTermsVersion: string;
  validatedAt: string;
  /** Exclusive freshness boundary; eligibility fails closed at this instant. */
  validUntil: string;
}

export interface ChannelAuthorizationRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  adapterVersionId: string;
  status: ChannelAuthorizationStatus;
  secretArn: string;
  grantedScopes: string[];
  acceptedTermsVersion: string;
  target: string;
  expiresAt: string | null;
  validationStatus: ChannelAuthorizationValidationStatus;
  validationSnapshot: ChannelAuthorizationValidationSnapshot | null;
  validationFailureCode: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export type ChannelAuthorizationEligibility = Omit<ChannelAuthorizationRecord, 'secretArn'>;

export type ChannelAuthorizationPublicValidationSnapshot = ChannelAuthorizationValidationSnapshot;

export interface ChannelAuthorizationMetadata extends Omit<
  ChannelAuthorizationEligibility,
  'validationSnapshot'
> {
  validationSnapshot: ChannelAuthorizationPublicValidationSnapshot | null;
  secretConfigured: true;
}

export const PUBLICATION_STATUSES = [
  'REQUESTED',
  'BUDGET_BLOCKED',
  'QUEUED',
  'RUNNING',
  'RETRY_WAIT',
  'AMBIGUOUS',
  'RECONCILE_REQUIRED',
  'RECONCILING',
  'MANUAL_REVIEW_REQUIRED',
  'REMOTE_APPLIED',
  'PUBLISHED',
  'FAILED_TERMINAL',
  'ROLLBACK_QUEUED',
  'ROLLED_BACK',
  'ROLLBACK_FAILED',
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/**
 * Receiver-authenticated evidence for one exact signed-webhook delivery. The evidence is stored
 * beside the PublicationRecord lineage; it contains identifiers and hashes only, never signing
 * material or the delivered body.
 */
export interface SignedWebhookReceiptEvidence {
  readonly schemaVersion: 'signed-webhook-receipt-evidence.v1';
  readonly receiptId: string;
  readonly deliveryId: string;
  readonly receiverEffectId: string;
  readonly requestBodySha256: string;
  readonly verifiedKeyId: string;
  readonly verifiedAlgorithm: 'HMAC_SHA256' | 'ED25519';
  readonly receivedAt: string;
}

/**
 * Adapter-owned lifecycle metadata for a durable remote effect. A remote effect may be useful
 * without being production-live (for example, an opened pull request or a CMS draft).
 *
 * The Worker treats Adapter values as untrusted input and persists only a validated, bounded
 * copy of this shape.
 */
export interface PublicationRemoteState {
  status: string;
  number: number | null;
  isProductionLive: boolean;
  rollbackHandle: Record<string, string | number | boolean> | null;
  /** Immutable once stored; present only for a verified, non-live DELIVERED webhook effect. */
  readonly receiptEvidence?: SignedWebhookReceiptEvidence;
}

export const PUBLICATION_ATTEMPT_OPERATIONS = ['PUBLISH', 'RECONCILE', 'ROLLBACK'] as const;
export type PublicationAttemptOperation = (typeof PUBLICATION_ATTEMPT_OPERATIONS)[number];

export const PUBLICATION_ATTEMPT_OUTCOMES = [
  'STARTED',
  'APPLIED',
  'AMBIGUOUS',
  'DEFINITELY_NOT_APPLIED',
  'RETRYABLE_FAILURE',
  'TERMINAL_FAILURE',
  'UNKNOWN',
  'ROLLED_BACK',
  'ROLLBACK_FAILED',
] as const;
export type PublicationAttemptOutcome = (typeof PUBLICATION_ATTEMPT_OUTCOMES)[number];

export const PUBLICATION_ELIGIBILITY_REASON_CODES = [
  'AUTHORIZATION_MISSING',
  'AUTHORIZATION_EXPIRED',
  'AUTHORIZATION_REVOKED',
  'AUTHORIZATION_VALIDATION_PENDING',
  'AUTHORIZATION_VALIDATION_INVALID',
  'AUTHORIZATION_VALIDATION_STALE',
  'AUTHORIZATION_VALIDATED_TARGET_MISMATCH',
  'AUTHORIZATION_VALIDATED_SCOPE_INSUFFICIENT',
  'AUTHORIZATION_VALIDATED_TERMS_MISMATCH',
  'ADAPTER_NOT_FOUND',
  'ADAPTER_DISABLED',
  'ADAPTER_RUNTIME_UNAVAILABLE',
  'ADAPTER_RUNTIME_METADATA_MISMATCH',
  'ADAPTER_PROVIDER_API_VERSION_EXPIRED',
  'CHANNEL_UNAVAILABLE',
  'PUBLISH_CAPABILITY_MISSING',
  'RECONCILE_CAPABILITY_MISSING',
  'TERMS_NOT_APPROVED',
  'AUTHORIZATION_SCOPE_INSUFFICIENT',
] as const;
export type PublicationEligibilityReasonCode =
  (typeof PUBLICATION_ELIGIBILITY_REASON_CODES)[number];

export interface PublicationEligibilityReason {
  code: PublicationEligibilityReasonCode;
  detail: string;
}

export interface PublicationRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  channelPackageId: string;
  packageChecksum: string;
  artifactRevisionId: string;
  artifactContentHash: string;
  adapterVersionId: string;
  channelAuthorizationId: string;
  target: string;
  idempotencyKey: string;
  requestHash: string;
  status: PublicationStatus;
  jobId: string | null;
  remoteRef: string | null;
  /** Added by remote-lifecycle-aware Adapters; absent on legacy records until migrated. */
  remoteState?: PublicationRemoteState | null;
  requestedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicationAttemptRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  publicationId: string;
  attemptNumber: number;
  operation: PublicationAttemptOperation;
  outcome: PublicationAttemptOutcome;
  remoteRef: string | null;
  errorCode: string | null;
  startedAt: string;
  finishedAt: string | null;
}
