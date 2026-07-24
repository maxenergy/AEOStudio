import type {
  TenantDataAccessRequest,
  TenantDataOperation,
} from './tenant-data-broker-authorizer.js';

export type TenantDataBrokerSuccessReceipt = Readonly<Record<string, unknown>> | null;

export type TenantDataBrokerAuthenticatedBeginResult =
  | { outcome: 'DENIED' }
  | { outcome: 'STARTED'; attemptId: string }
  | {
      outcome: 'ALREADY_SUCCEEDED';
      successReceipt: TenantDataBrokerSuccessReceipt;
    }
  | { outcome: 'AMBIGUOUS' };

/**
 * The nonce and durable effect attempt are created by one database function.
 * Implementations must never expose separate consume/begin operations.
 */
export interface TenantDataBrokerAttemptStore {
  beginAuthenticated(input: {
    nonce: string;
    signedAt: Date;
    expiresAt: Date;
    capabilityId: string;
    leaseToken: string;
    operation: TenantDataOperation;
    resourceReferenceSha256: string;
  }): Promise<TenantDataBrokerAuthenticatedBeginResult>;

  complete(input: {
    attemptId: string;
    leaseToken: string;
    receipt: TenantDataBrokerSuccessReceipt;
  }): Promise<void>;

  fail(input: {
    attemptId: string;
    leaseToken: string;
    outcome: 'FAILED' | 'UNKNOWN';
  }): Promise<void>;
}

export type TenantDataBrokerEffectResolution =
  'RESOLVED_SUCCESS' | 'RESOLVED_FAILED' | 'NOT_RESOLVED';

export interface TenantDataBrokerEffectResolver {
  resolveObjectPut(input: {
    probeAttemptId: string;
    leaseToken: string;
    observation: 'FOUND' | 'MISSING' | 'MISMATCH';
    observedVersionId: string | null;
    observedChecksum: string | null;
    observedContentType: string | null;
    observedByteLength: number | null;
  }): Promise<TenantDataBrokerEffectResolution>;

  resolveLegalHold(input: {
    probeAttemptId: string;
    leaseToken: string;
    observedStatus: 'ON' | 'OFF';
  }): Promise<TenantDataBrokerEffectResolution>;

  resolveSecretDelete(input: {
    probeAttemptId: string;
    leaseToken: string;
    observation: 'ABSENT' | 'DELETION_REQUESTED' | 'EXISTS';
  }): Promise<TenantDataBrokerEffectResolution>;
}

export interface TenantDataCapabilityIssuer<TInput> {
  issue(input: TInput): Promise<TenantDataAccessRequest | null>;
}
