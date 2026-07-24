import type {
  ChannelAuthorizationEligibility,
  ChannelAuthorizationMetadata,
  ChannelPackagePayload,
  ChannelPackageRecord,
  ChannelRegistryEntry,
  PublicationAttemptRecord,
  PublicationRecord,
} from '@aeostudio/domain/channels-publishing';
import type { JobRecord } from '@aeostudio/domain/jobs-budgets';

import type { TenantContext } from '../identity-access/index.js';
import type { JobTraceContext } from '../jobs-budgets/index.js';
import type { PublicationAdapter } from './publication-execution.js';

export interface ChannelRegistryStore {
  listEntries(input: { context: TenantContext }): Promise<ChannelRegistryEntry[]>;
}

export interface ChannelPackageStore {
  createOrFind(input: {
    context: TenantContext;
    packageId: string;
    channel: ChannelPackageRecord['channel'];
    transformer: ChannelPackageRecord['transformer'];
    packageSchemaVersion: string;
    artifact: ChannelPackageRecord['artifact'];
    manifest: ChannelPackageRecord['manifest'];
    packageChecksum: string;
    payloadObjectRef: string;
    createdAt: Date;
    auditEventId: string;
  }): Promise<
    | {
        outcome: 'SUCCEEDED';
        record: ChannelPackageRecord;
        created: boolean;
      }
    | { outcome: 'APPROVAL_STALE' }
  >;
  findById(input: {
    context: TenantContext;
    packageId: string;
  }): Promise<ChannelPackageRecord | null>;
}

export interface ChannelPackagePayloadWriter {
  put(input: {
    tenantId: string;
    workspaceId: string;
    packageChecksum: string;
    payload: ChannelPackagePayload;
  }): Promise<{ objectRef: string }>;
}

/** Raw storage port retained for worker/fake adapters; API reads must use a capability reader. */
export interface ChannelPackagePayloadStore extends ChannelPackagePayloadWriter {
  get(objectRef: string): Promise<ChannelPackagePayload | null>;
}

export interface ChannelAuthorizationStore {
  create(input: {
    context: TenantContext;
    authorizationId: string;
    adapterVersionId: string;
    /** Required by fake/deferred validation queues; PostgreSQL re-resolves these from Registry. */
    adapterKey?: string;
    adapterVersion?: string;
    channelDefinitionId?: string;
    target: string;
    grantedScopes: string[];
    acceptedTermsVersion: string;
    secretArn: string;
    expiresAt: Date | null;
    createdAt: Date;
    auditEventId: string;
  }): Promise<ChannelAuthorizationMetadata>;
  revoke(input: {
    context: TenantContext;
    authorizationId: string;
    revokedAt: Date;
    auditEventId: string;
  }): Promise<ChannelAuthorizationMetadata | null>;
  list(input: { context: TenantContext }): Promise<ChannelAuthorizationMetadata[]>;
  findForTarget(input: {
    context: TenantContext;
    adapterVersionId: string;
    target: string;
  }): Promise<ChannelAuthorizationEligibility | null>;
}

export interface ChannelAuthorizationValidationLease {
  commandId: string;
  tenantId: string;
  workspaceId: string;
  authorizationId: string;
  channelDefinitionId: string;
  adapterVersionId: string;
  adapterKey: string;
  adapterVersion: string;
  target: string;
  requestedScopes: string[];
  acceptedTermsVersion: string;
  secretReference: string;
  authorizationExpiresAt: string | null;
  workerId: string;
  leaseToken: string;
  leaseExpiresAt: string;
}

/**
 * Worker-only durable command boundary. API services receive only ChannelAuthorizationStore and
 * therefore cannot claim commands or read secret references.
 */
export interface ChannelAuthorizationValidationCommandStore {
  claimNext(input: {
    workerId: string;
    leaseToken: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<ChannelAuthorizationValidationLease | null>;
  completeVerified(input: {
    lease: ChannelAuthorizationValidationLease;
    actualTarget: string;
    actualScopes: string[];
    acceptedTermsVersion: string;
    credentialFingerprint: string;
    validatedAt: Date;
    validUntil: Date;
  }): Promise<boolean>;
  completeInvalid(input: {
    lease: ChannelAuthorizationValidationLease;
    failureCode: string;
    validatedAt: Date;
  }): Promise<boolean>;
}

/** Worker-only boundary. API eligibility code must not depend on or receive this value. */
export interface ChannelAuthorizationSecretReferenceStore {
  findSecretArn(input: { context: TenantContext; authorizationId: string }): Promise<string | null>;
}

/**
 * Runtime implementations are deliberately registered separately from Registry metadata.
 * An enabled database row never proves that executable publishing code is deployed.
 */
export type RuntimeChannelAdapter = PublicationAdapter;

export interface RuntimeChannelAdapterRegistry {
  resolve(adapterKey: string, adapterVersion: string): RuntimeChannelAdapter | null;
}

export interface SignedWebhookEndpointVerificationRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  channelDefinitionId: string;
  status: 'PENDING' | 'VERIFIED' | 'REVOKED';
  endpointUrl: string;
  receiptUrl: string;
  algorithm: 'HMAC_SHA256' | 'ED25519';
  keyId: string;
  verificationReference: string;
  createdByUserId: string;
  createdAt: string;
  challengeExpiresAt: string;
  verifiedAt: string | null;
  revokedAt: string | null;
}

export type ActiveSignedWebhookEndpointVerification = SignedWebhookEndpointVerificationRecord & {
  endpointVerificationId: string;
  status: 'VERIFIED';
  verifiedAt: string;
  revokedAt: null;
};

export type SignedWebhookEndpointVerificationPurpose =
  'DELIVERY' | 'RECEIPT' | 'DELIVERY_AND_RECEIPT';

export interface SignedWebhookEndpointVerificationProof {
  purpose: SignedWebhookEndpointVerificationPurpose;
  exactUrl: string;
  challenge: string;
  challengeExpiresAt: string;
}

export type PendingSignedWebhookEndpointVerification = SignedWebhookEndpointVerificationRecord & {
  status: 'PENDING';
  proofs: SignedWebhookEndpointVerificationProof[];
  verifiedAt: null;
  revokedAt: null;
};

export interface SignedWebhookEndpointOwnershipVerifier {
  verifyOwnership(input: {
    verificationId: string;
    purpose: SignedWebhookEndpointVerificationPurpose;
    exactUrl: string;
    challenge: string;
  }): Promise<
    | { outcome: 'VERIFIED' }
    | {
        outcome: 'FAILED';
        reason:
          | 'CHALLENGE_EXPIRED'
          | 'CHALLENGE_MISMATCH'
          | 'INVALID_RESPONSE'
          | 'SSRF_BLOCKED'
          | 'TRANSPORT_FAILED';
      }
  >;
}

/**
 * Durable, platform-owned receiver verification state. Publication Adapters
 * must re-read this port at every remote-effect boundary.
 */
export interface SignedWebhookEndpointVerificationStore {
  createPending(input: {
    context: TenantContext;
    verificationId: string;
    channelDefinitionId: string;
    endpointUrl: string;
    receiptUrl: string;
    algorithm: 'HMAC_SHA256' | 'ED25519';
    keyId: string;
    verificationReference: string;
    proofs: Array<{
      purpose: SignedWebhookEndpointVerificationPurpose;
      exactUrl: string;
      challenge: string;
      challengeExpiresAt: Date;
    }>;
    createdAt: Date;
    auditEventId: string;
  }): Promise<PendingSignedWebhookEndpointVerification>;
  list(input: { context: TenantContext }): Promise<SignedWebhookEndpointVerificationRecord[]>;
  findPending(input: {
    context: TenantContext;
    verificationId: string;
  }): Promise<PendingSignedWebhookEndpointVerification | null>;
  markVerified(input: {
    context: TenantContext;
    verificationId: string;
    expectedProofs: SignedWebhookEndpointVerificationProof[];
    verifiedAt: Date;
    auditEventId: string;
  }): Promise<ActiveSignedWebhookEndpointVerification | null>;
  revoke(input: {
    context: TenantContext;
    verificationId: string;
    revokedAt: Date;
    auditEventId: string;
  }): Promise<SignedWebhookEndpointVerificationRecord | null>;
  findVerifiedEndpoint(input: {
    tenantId: string;
    workspaceId: string;
    channelDefinitionId: string;
    endpointVerificationId: string;
  }): Promise<ActiveSignedWebhookEndpointVerification | null>;
}

export interface PublicationCommandStore {
  findExisting(input: {
    context: TenantContext;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<
    | {
        outcome: 'SUCCEEDED';
        publication: PublicationRecord;
        job: JobRecord;
        created: false;
      }
    | { outcome: 'NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' }
  >;
  submit(input: {
    context: TenantContext;
    /** Needed by explicit test/dev execution to re-resolve current membership at queue time. */
    actorSubject: string;
    publicationId: string;
    jobId: string;
    reservationId: string;
    budgetAlertId: string;
    outboxMessageId: string;
    auditEventId: string;
    jobAuditEventId: string;
    channelPackage: ChannelPackageRecord;
    adapterVersionId: string;
    channelAuthorization: ChannelAuthorizationEligibility;
    requiredScopes: string[];
    target: string;
    idempotencyKey: string;
    requestHash: string;
    estimatedUnits: number;
    createdAt: Date;
    traceContext?: JobTraceContext;
  }): Promise<
    | {
        outcome: 'SUCCEEDED';
        publication: PublicationRecord;
        job: JobRecord;
        created: boolean;
      }
    | { outcome: 'IDEMPOTENCY_CONFLICT' }
    | { outcome: 'APPROVAL_STALE' | 'NOT_FOUND' | 'PIPELINE_UNAVAILABLE' }
  >;
}

export interface PublicationQueryStore {
  findDetail(input: { context: TenantContext; publicationId: string }): Promise<{
    publication: PublicationRecord;
    attempts: PublicationAttemptRecord[];
    job: JobRecord;
  } | null>;
}

/**
 * Command boundary for refreshing an already-created remote effect.
 *
 * Implementations own the final Publication/Adapter/authorization re-check so a successful
 * read cannot be replayed later as authority to call a Provider or mutate remote state.
 */
export interface PublicationRemoteStatusRefreshStore {
  refresh(input: { context: TenantContext; actorSubject: string; publicationId: string }): Promise<
    | { outcome: 'SUCCEEDED'; publication: PublicationRecord }
    | {
        outcome:
          | 'NOT_FOUND'
          | 'INVALID_STATE'
          | 'GATE_REJECTED'
          | 'ADAPTER_UNAVAILABLE'
          | 'REMOTE_STATUS_UNAVAILABLE'
          | 'REMOTE_STATUS_INVALID';
      }
  >;
}
