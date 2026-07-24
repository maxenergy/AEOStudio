import type { PublicationStatus } from './publications.js';

// ============================================================================
// C08: Publishing Production Safety Validation
// ============================================================================

// --- Rollback Eligibility ---

export type RollbackEligibilityReasonCode =
  | 'ROLLBACK_CAPABILITY_MISSING'
  | 'STATUS_NOT_ROLLBACK_ELIGIBLE'
  | 'REMOTE_REF_MISSING'
  | 'ROLLBACK_HANDLE_MISSING'
  | 'INSUFFICIENT_PERMISSION';

export interface RollbackEligibilityReason {
  code: RollbackEligibilityReasonCode;
  message: string;
}

export interface RollbackEligibilityInput {
  publicationStatus: PublicationStatus;
  adapterCapabilities: string[];
  remoteRef: string | null;
  rollbackHandle: Record<string, unknown> | null;
  actorRole: string;
}

export interface RollbackEligibilityResult {
  eligible: boolean;
  reasons: RollbackEligibilityReason[];
}

const ROLLBACK_ELIGIBLE_STATUSES: PublicationStatus[] = ['REMOTE_APPLIED', 'PUBLISHED'];
const ROLLBACK_ALLOWED_ROLES = ['OWNER', 'ADMIN', 'EDITOR'];

export function validateRollbackEligibility(
  input: RollbackEligibilityInput,
): RollbackEligibilityResult {
  const reasons: RollbackEligibilityReason[] = [];

  if (!input.adapterCapabilities.includes('ROLLBACK')) {
    reasons.push({
      code: 'ROLLBACK_CAPABILITY_MISSING',
      message: 'The publication adapter does not support rollback.',
    });
  }

  if (!ROLLBACK_ELIGIBLE_STATUSES.includes(input.publicationStatus)) {
    reasons.push({
      code: 'STATUS_NOT_ROLLBACK_ELIGIBLE',
      message: `Publication status "${input.publicationStatus}" is not eligible for rollback.`,
    });
  }

  if (input.remoteRef === null || input.remoteRef.length === 0) {
    reasons.push({
      code: 'REMOTE_REF_MISSING',
      message: 'No remote reference exists for this publication.',
    });
  }

  if (input.rollbackHandle === null || Object.keys(input.rollbackHandle).length === 0) {
    reasons.push({
      code: 'ROLLBACK_HANDLE_MISSING',
      message: 'No rollback handle is available for this publication.',
    });
  }

  if (!ROLLBACK_ALLOWED_ROLES.includes(input.actorRole)) {
    reasons.push({
      code: 'INSUFFICIENT_PERMISSION',
      message: `Role "${input.actorRole}" does not have permission to rollback.`,
    });
  }

  return { eligible: reasons.length === 0, reasons };
}

// --- Publication Currentness Fence ---

export type PublicationCurrentnessFenceCode =
  | 'ARTIFACT_REVISION_STALE'
  | 'ARTIFACT_CONTENT_CHANGED'
  | 'AUTHORIZATION_REVOKED'
  | 'AUTHORIZATION_VALIDATION_EXPIRED'
  | 'CLAIM_REVISION_STALE';

export interface PublicationCurrentnessFenceReason {
  code: PublicationCurrentnessFenceCode;
  message: string;
}

export interface PublicationCurrentnessInput {
  artifactRevisionId: string;
  artifactContentHash: string;
  currentApprovedRevisionId: string;
  currentApprovedContentHash: string;
  authorizationStatus: 'ACTIVE' | 'REVOKED';
  authorizationValidUntil: string;
  claimRevisionIds: string[];
  currentApprovedClaimRevisionIds: string[];
  now: Date;
}

export interface PublicationCurrentnessResult {
  current: boolean;
  fencedReasons: PublicationCurrentnessFenceReason[];
}

export function validatePublicationCurrentness(
  input: PublicationCurrentnessInput,
): PublicationCurrentnessResult {
  const fencedReasons: PublicationCurrentnessFenceReason[] = [];

  if (input.artifactRevisionId !== input.currentApprovedRevisionId) {
    fencedReasons.push({
      code: 'ARTIFACT_REVISION_STALE',
      message: `Artifact revision ${input.artifactRevisionId} is no longer the current approved revision.`,
    });
  }

  if (input.artifactContentHash !== input.currentApprovedContentHash) {
    fencedReasons.push({
      code: 'ARTIFACT_CONTENT_CHANGED',
      message: 'Artifact content hash has changed since publication was requested.',
    });
  }

  if (input.authorizationStatus === 'REVOKED') {
    fencedReasons.push({
      code: 'AUTHORIZATION_REVOKED',
      message: 'The channel authorization has been revoked.',
    });
  }

  const validUntil = new Date(input.authorizationValidUntil).getTime();
  if (Number.isFinite(validUntil) && validUntil <= input.now.getTime()) {
    fencedReasons.push({
      code: 'AUTHORIZATION_VALIDATION_EXPIRED',
      message: 'The channel authorization validation has expired.',
    });
  }

  const currentClaims = new Set(input.currentApprovedClaimRevisionIds);
  for (const claimId of input.claimRevisionIds) {
    if (!currentClaims.has(claimId)) {
      fencedReasons.push({
        code: 'CLAIM_REVISION_STALE',
        message: `Claim revision ${claimId} is no longer approved.`,
      });
      break;
    }
  }

  return { current: fencedReasons.length === 0, fencedReasons };
}

// --- Credential Safety ---

export type CredentialLeakLocation = 'responseFields' | 'logMessages' | 'auditEventPayload';

export interface CredentialLeak {
  location: CredentialLeakLocation;
  path: string;
}

export interface CredentialSafetyInput {
  secretValue: string;
  responseFields: Record<string, unknown>;
  logMessages: string[];
  auditEventPayload: Record<string, unknown>;
}

export interface CredentialSafetyResult {
  safe: boolean;
  leaks: CredentialLeak[];
}

const MINIMUM_SECRET_PREFIX_LENGTH = 12;

export function validateCredentialSafety(input: CredentialSafetyInput): CredentialSafetyResult {
  const leaks: CredentialLeak[] = [];
  const secret = input.secretValue;

  if (secret.length === 0) {
    return { safe: true, leaks: [] };
  }

  // Use a prefix that is at least MINIMUM_SECRET_PREFIX_LENGTH but no more than half the secret
  const prefixLength = Math.min(
    Math.max(MINIMUM_SECRET_PREFIX_LENGTH, Math.floor(secret.length / 3)),
    secret.length,
  );
  const secretPrefix = secret.slice(0, prefixLength);

  const containsSecret = (text: string): boolean => {
    if (text.includes(secret)) return true;
    if (secretPrefix.length >= MINIMUM_SECRET_PREFIX_LENGTH && text.includes(secretPrefix))
      return true;
    return false;
  };

  const checkValue = (value: unknown, location: CredentialLeakLocation, path: string): void => {
    if (typeof value === 'string') {
      if (containsSecret(value)) {
        leaks.push({ location, path });
      }
    } else if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        checkValue(nested, location, `${path}.${key}`);
      }
    }
  };

  checkValue(input.responseFields, 'responseFields', '$');

  for (let i = 0; i < input.logMessages.length; i++) {
    const message = input.logMessages[i]!;
    if (containsSecret(message)) {
      leaks.push({ location: 'logMessages', path: `[${i}]` });
    }
  }

  checkValue(input.auditEventPayload, 'auditEventPayload', '$');

  return { safe: leaks.length === 0, leaks };
}
