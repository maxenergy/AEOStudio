import type { JobLease } from '../jobs-budgets/index.js';
import { canonicalArtifactJson } from '../artifacts/index.js';
import type {
  ChannelAdapterVersion,
  ChannelPackagePayload,
  ChannelPackageRecord,
  PublicationRemoteState,
  PublicationStatus,
} from '@aeostudio/domain/channels-publishing';

export interface PublicationExecutionContext {
  publicationId: string;
  publicationStatus: PublicationStatus;
  idempotencyKey: string;
  target: string;
  /** Added for site-scoped Adapters; legacy exact-target stores may omit it. */
  authorizationTarget?: string;
  /** Added for dynamic least-privilege scope gates; legacy stores fall back to declared scopes. */
  authorizationGrantedScopes?: string[];
  remoteRef: string | null;
  reconciliationIntent?: PublicationAdapterReconciliationIntent;
  remoteState?: PublicationRemoteState | null;
  channelPackage: ChannelPackageRecord;
  adapterKey: string;
  adapterVersion: string;
  adapterProviderApiVersion?: string;
  adapterProviderApiSupportedUntil?: string;
  adapterCapabilities: string[];
  adapterRequiredScopes: string[];
  adapterTermsVersion: string;
  adapterProcessingRegion: string;
  adapterRetentionPolicy: string;
  adapterTrainingPolicy: string;
  adapterSubprocessors: Array<Record<string, unknown>>;
  adapterRatePolicy: Record<string, unknown>;
}

export interface PublicationAuthorizationMaterial {
  secretReference: string;
  credentialFingerprint: string;
}

/**
 * Worker-only boundary for the exact credential reference bound to a live Publication Job lease.
 * API/runtime metadata stores must never implement this by selecting sensitive columns directly.
 */
export interface PublicationAuthorizationMaterialReader {
  readForPublication(input: { lease: JobLease }): Promise<PublicationAuthorizationMaterial | null>;
}

export type PreparePublicationExecutionOutcome =
  | {
      outcome: 'PUBLISH' | 'RECONCILE';
      execution: PublicationExecutionContext;
      attemptId: string;
    }
  | {
      outcome: 'PUBLISHED';
      execution: PublicationExecutionContext;
    }
  | {
      outcome: 'REMOTE_APPLIED';
      execution: PublicationExecutionContext;
    }
  | { outcome: 'FENCED' }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'INVALID_STATE' }
  | { outcome: 'GATE_REJECTED'; errorCode: string };

export interface PublicationExecutionStore {
  prepare(input: {
    lease: JobLease;
    publishAttemptId: string;
    reconcileAttemptId: string;
    publishAuditEventId: string;
    recoveryAuditEventId: string;
    reconcileAuditEventId: string;
    gateFailureAuditEventId: string;
    now: Date;
  }): Promise<PreparePublicationExecutionOutcome>;
  runGuardedEffect<T>(
    input: {
      lease: JobLease;
      attemptId: string;
      operation: 'PUBLISH' | 'RECONCILE';
      expectedAuthorizationMaterial: PublicationAuthorizationMaterial;
      expectedRequiredScopes: string[];
    },
    effect: () => Promise<T>,
  ): Promise<
    { outcome: 'EXECUTED'; value: T } | { outcome: 'FENCED' } | { outcome: 'GATE_REJECTED' }
  >;
  recordPublishApplied(input: {
    lease: JobLease;
    attemptId: string;
    remoteRef: string;
    publicationStatus: 'PUBLISHED' | 'REMOTE_APPLIED';
    remoteState: PublicationRemoteState | null;
    auditEventId: string;
    now: Date;
  }): Promise<boolean>;
  recordPublishAmbiguous(input: {
    lease: JobLease;
    attemptId: string;
    errorCode: string;
    remoteRef?: string;
    auditEventId: string;
    now: Date;
  }): Promise<boolean>;
  recordReconcileApplied(input: {
    lease: JobLease;
    attemptId: string;
    remoteRef: string;
    publicationStatus: 'PUBLISHED' | 'REMOTE_APPLIED';
    remoteState: PublicationRemoteState | null;
    auditEventId: string;
    now: Date;
  }): Promise<boolean>;
  recordReconcileUnknown(input: {
    lease: JobLease;
    attemptId: string;
    errorCode: string;
    auditEventId: string;
    now: Date;
  }): Promise<boolean>;
  recordReconcileDefinitelyNotApplied(input: {
    lease: JobLease;
    attemptId: string;
    errorCode: string;
    auditEventId: string;
    now: Date;
  }): Promise<boolean>;
  recordRetryableFailure(input: {
    lease: JobLease;
    attemptId: string;
    operation: 'PUBLISH' | 'RECONCILE';
    errorCode: string;
    auditEventId: string;
    now: Date;
  }): Promise<boolean>;
  recordPreflightFailure(input: {
    lease: JobLease;
    attemptId: string;
    operation: 'PUBLISH' | 'RECONCILE';
    errorCode: string;
    auditEventId: string;
    now: Date;
  }): Promise<boolean>;
}

export interface PublicationAdapterCommand {
  publicationId: string;
  idempotencyKey: string;
  target: string;
  channelPackage: ChannelPackageRecord;
  payload: ChannelPackagePayload;
  secretValue: string;
}

export interface PublicationAdapterReconciliationIntent {
  readonly kind: 'COMPENSATE_UNSAFE_CREATE';
  readonly remoteRef: string;
}

export interface PublicationAdapterReconcileCommand extends PublicationAdapterCommand {
  readonly reconciliationIntent?: PublicationAdapterReconciliationIntent;
}

export type PublicationAdapterCoreCapability = 'PREVIEW' | 'PUBLISH' | 'RECONCILE' | 'ROLLBACK';

export interface PublicationAdapterDescriptor {
  adapterKey: string;
  adapterVersion: string;
  providerApiVersion?: string;
  /** Registry-driven and intentionally open to Adapter-specific capabilities. */
  capabilities: string[];
  requiredScopes: string[];
  termsVersion: string;
  processingRegion: string;
  retentionPolicy: string;
  trainingPolicy: string;
  subprocessors: Array<Record<string, unknown>>;
  ratePolicy: Record<string, unknown>;
}

export type PublicationAdapterAuthorizationInvalidReason =
  'SCOPE_INSUFFICIENT' | 'TARGET_NOT_ALLOWED' | 'BRANCH_POLICY_CONFLICT';

export interface ChannelAuthorizationValidationInput {
  tenantId: string;
  workspaceId: string;
  channelDefinitionId: string;
  /** Durable authorization coverage target, not a publication-specific target unless identical. */
  target: string;
  requestedScopes: string[];
  acceptedTermsVersion: string;
  secretValue: string;
}

export type ChannelAuthorizationValidationResult =
  | { outcome: 'VERIFIED'; actualTarget: string; actualScopes: string[] }
  | {
      outcome: 'INVALID';
      reason:
        | PublicationAdapterAuthorizationInvalidReason
        | 'TERMS_MISMATCH'
        | 'CREDENTIAL_INVALID'
        | 'ENDPOINT_NOT_VERIFIED';
    }
  | { outcome: 'UNKNOWN' };

export type PublicationAdapterAuthorizationResult =
  | { outcome: 'VALID' }
  | { outcome: 'INVALID'; reason?: PublicationAdapterAuthorizationInvalidReason }
  | { outcome: 'UNKNOWN' };

/** Convert the closed authorization reason vocabulary to safe, platform-owned diagnostics. */
export function publicationAuthorizationFailureCode(
  result: Exclude<PublicationAdapterAuthorizationResult, { outcome: 'VALID' }>,
): string {
  if (result.outcome === 'UNKNOWN') return 'ADAPTER_AUTHORIZATION_UNKNOWN';
  switch (result.reason) {
    case 'SCOPE_INSUFFICIENT':
      return 'ADAPTER_AUTHORIZATION_SCOPE_INSUFFICIENT';
    case 'TARGET_NOT_ALLOWED':
      return 'ADAPTER_AUTHORIZATION_TARGET_NOT_ALLOWED';
    case 'BRANCH_POLICY_CONFLICT':
      return 'ADAPTER_AUTHORIZATION_BRANCH_POLICY_CONFLICT';
    default:
      return 'ADAPTER_AUTHORIZATION_INVALID';
  }
}

export interface PublicationAdapterPreviewResult {
  packageChecksum: string;
  files: ChannelPackagePayload['files'];
}

/** Sandbox-safe preview input. Credentials and remote idempotency state are intentionally absent. */
export interface PublicationAdapterPreviewCommand {
  target: string;
  channelPackage: ChannelPackageRecord;
  payload: ChannelPackagePayload;
}

/** Adapter-owned errorCode values are untrusted diagnostics and must never be persisted as-is. */
export type PublicationAdapterPublishResult =
  | { outcome: 'APPLIED'; remoteRef: string; remoteState?: PublicationRemoteState }
  | { outcome: 'DEFINITELY_NOT_APPLIED'; errorCode: string }
  | { outcome: 'RETRYABLE_FAILURE' | 'TERMINAL_FAILURE'; errorCode: string }
  | {
      outcome: 'AMBIGUOUS';
      errorCode: string;
      reconciliationIntent?: PublicationAdapterReconciliationIntent;
    }
  | { outcome: 'UNKNOWN'; errorCode: string };

export type PublicationAdapterReconcileResult =
  | { outcome: 'APPLIED'; remoteRef: string; remoteState?: PublicationRemoteState }
  | { outcome: 'DEFINITELY_NOT_APPLIED'; errorCode: string }
  | { outcome: 'RETRYABLE_FAILURE' | 'TERMINAL_FAILURE'; errorCode: string }
  | { outcome: 'AMBIGUOUS' | 'UNKNOWN'; errorCode: string };

export type PublicationAdapterRemoteStatusResult =
  | { outcome: 'APPLIED'; remoteRef: string; remoteState: PublicationRemoteState }
  | { outcome: 'UNKNOWN'; errorCode: string };

export type PublicationAdapterRollbackCommand = PublicationAdapterCommand & { remoteRef: string };

export type PublicationAdapterRollbackResult =
  | { outcome: 'ROLLED_BACK'; remoteRef: string }
  | { outcome: 'DEFINITELY_NOT_ROLLED_BACK'; errorCode: string }
  | { outcome: 'UNKNOWN'; errorCode: string };

export interface PublicationAdapter {
  readonly adapterKey: string;
  readonly adapterVersion: string;
  /** Maps a publication-specific target to the durable authorization coverage target. */
  authorizationTargetFor?(publicationTarget: string): string;
  /** Resolves the least-privilege subset required for this exact target and immutable package. */
  requiredScopesFor?(input: { target: string; channelPackage: ChannelPackageRecord }): string[];
  describe(): PublicationAdapterDescriptor;
  /**
   * Worker-only, side-effect-free provider validation used before an authorization can become
   * eligible. Production owned adapters must implement it; absence fails closed in the Worker.
   */
  validateChannelAuthorization?(
    input: ChannelAuthorizationValidationInput,
  ): Promise<ChannelAuthorizationValidationResult>;
  validateAuthorization(
    command: PublicationAdapterCommand,
  ): Promise<PublicationAdapterAuthorizationResult>;
  preview(command: PublicationAdapterPreviewCommand): PublicationAdapterPreviewResult;
  publish(command: PublicationAdapterCommand): Promise<PublicationAdapterPublishResult>;
  reconcile(
    command: PublicationAdapterReconcileCommand,
  ): Promise<PublicationAdapterReconcileResult>;
  refreshRemoteStatus?(
    command: PublicationAdapterCommand,
  ): Promise<PublicationAdapterRemoteStatusResult>;
  rollback?(command: PublicationAdapterRollbackCommand): Promise<PublicationAdapterRollbackResult>;
}

export const ADAPTER_RUNTIME_METADATA_MISMATCH = 'ADAPTER_RUNTIME_METADATA_MISMATCH' as const;

/** A malformed configured cutoff also fails closed at every remote-effect boundary. */
export function providerApiVersionIsExpired(
  supportedUntil: string | undefined,
  now: Date,
): boolean {
  if (supportedUntil === undefined) return false;
  const cutoff = new Date(supportedUntil).getTime();
  return !Number.isFinite(cutoff) || cutoff <= now.getTime();
}

/**
 * Adapter implementations are deployment-time plugins, so TypeScript alone is not a trust
 * boundary. Validate the executable object and its self-description against current Registry
 * metadata before any secret or remote side effect is exposed to it.
 */
export function validatePublicationAdapterRuntime(
  adapter: PublicationAdapter,
  expected: Pick<
    ChannelAdapterVersion,
    | 'adapterKey'
    | 'adapterVersion'
    | 'providerApiVersion'
    | 'capabilities'
    | 'requiredScopes'
    | 'termsVersion'
    | 'processingRegion'
    | 'retentionPolicy'
    | 'trainingPolicy'
    | 'subprocessors'
    | 'ratePolicy'
  >,
): typeof ADAPTER_RUNTIME_METADATA_MISMATCH | null {
  const candidate = adapter as Partial<PublicationAdapter>;
  if (
    candidate.adapterKey !== expected.adapterKey ||
    candidate.adapterVersion !== expected.adapterVersion ||
    typeof candidate.describe !== 'function' ||
    typeof candidate.validateAuthorization !== 'function' ||
    typeof candidate.preview !== 'function' ||
    typeof candidate.publish !== 'function' ||
    typeof candidate.reconcile !== 'function'
  ) {
    return ADAPTER_RUNTIME_METADATA_MISMATCH;
  }

  let descriptor: PublicationAdapterDescriptor;
  try {
    descriptor = candidate.describe.call(adapter);
  } catch {
    return ADAPTER_RUNTIME_METADATA_MISMATCH;
  }
  try {
    if (
      descriptor === null ||
      typeof descriptor !== 'object' ||
      descriptor.adapterKey !== expected.adapterKey ||
      descriptor.adapterVersion !== expected.adapterVersion ||
      (expected.providerApiVersion !== undefined &&
        descriptor.providerApiVersion !== expected.providerApiVersion) ||
      !Array.isArray(descriptor.capabilities) ||
      !sameStringSet(descriptor.capabilities, expected.capabilities) ||
      !Array.isArray(descriptor.requiredScopes) ||
      !sameStringSet(descriptor.requiredScopes, expected.requiredScopes) ||
      descriptor.termsVersion !== expected.termsVersion ||
      descriptor.processingRegion !== expected.processingRegion ||
      descriptor.retentionPolicy !== expected.retentionPolicy ||
      descriptor.trainingPolicy !== expected.trainingPolicy ||
      !Array.isArray(descriptor.subprocessors) ||
      descriptor.subprocessors.some(
        (entry) => entry === null || typeof entry !== 'object' || Array.isArray(entry),
      ) ||
      descriptor.ratePolicy === null ||
      typeof descriptor.ratePolicy !== 'object' ||
      Array.isArray(descriptor.ratePolicy) ||
      canonicalArtifactJson(descriptor.subprocessors) !==
        canonicalArtifactJson(expected.subprocessors) ||
      canonicalArtifactJson(descriptor.ratePolicy) !== canonicalArtifactJson(expected.ratePolicy) ||
      (descriptor.capabilities.includes('ROLLBACK') && typeof candidate.rollback !== 'function') ||
      (descriptor.capabilities.includes('PULL_REQUEST_STATUS') &&
        typeof candidate.refreshRemoteStatus !== 'function')
    ) {
      return ADAPTER_RUNTIME_METADATA_MISMATCH;
    }
  } catch {
    return ADAPTER_RUNTIME_METADATA_MISMATCH;
  }
  return null;
}

function sameStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (
    actual.length !== new Set(actual).size ||
    expected.length !== new Set(expected).size ||
    actual.some((capability) => capability.trim().length === 0) ||
    expected.some((capability) => capability.trim().length === 0)
  ) {
    return false;
  }
  const actualSet = new Set<string>(actual);
  return actualSet.size === expected.length && expected.every((value) => actualSet.has(value));
}

export interface PublicationAdapterRegistry {
  resolve(adapterKey: string, adapterVersion: string): PublicationAdapter | null;
}

export interface PublicationAdapterGovernance {
  authorizationTarget: string;
  requiredScopes: string[];
}

/** Resolves Adapter-specific coverage without permitting undeclared scopes or malformed targets. */
export function resolvePublicationAdapterGovernance(
  adapter: PublicationAdapter,
  declaredRequiredScopes: readonly string[],
  input: { target: string; channelPackage: ChannelPackageRecord },
): PublicationAdapterGovernance | null {
  try {
    const authorizationTarget = adapter.authorizationTargetFor?.(input.target) ?? input.target;
    const requiredScopes = adapter.requiredScopesFor?.({
      target: input.target,
      channelPackage: input.channelPackage,
    }) ?? [...declaredRequiredScopes];
    if (
      authorizationTarget.length === 0 ||
      authorizationTarget.length > 2_048 ||
      requiredScopes.length !== new Set(requiredScopes).size ||
      requiredScopes.some(
        (scope) => scope.trim().length === 0 || !declaredRequiredScopes.includes(scope),
      )
    ) {
      return null;
    }
    return { authorizationTarget, requiredScopes: [...requiredScopes] };
  } catch {
    return null;
  }
}

export interface SecretValueProvider {
  getSecretValue(
    secretReference: string,
    expectedScope?: { tenantId: string; workspaceId: string },
  ): Promise<string>;
}
