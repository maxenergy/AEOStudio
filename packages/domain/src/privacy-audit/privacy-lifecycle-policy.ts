const DAY_MS = 24 * 60 * 60 * 1_000;
const SECRET_FORCE_DELETE_MS = DAY_MS;

export const RETENTION_DAYS = Object.freeze({
  ACTIVE_TENANT_DATA: 30,
  BACKUP_COPY: 90,
  RAW_PROMPT_RESPONSE: 180,
  CRAWL_SNAPSHOT: 180,
  SCREENSHOT: 90,
  APPLICATION_LOG: 30,
  AUDIT_DIGEST: 365,
} as const);

export type RetainedObjectClass = keyof typeof RETENTION_DAYS;

export interface PrivacyClock {
  now(): Date;
}

export interface RetainedObject {
  objectKey: string;
  objectVersionId: string;
}

export interface LegalHold {
  id: string;
  name: string;
  reason: string;
  createdBy: string;
  visibleToTenant: true;
  target: RetainedObject;
}

export interface RetentionDecision {
  decision: 'RETAIN' | 'EXPIRE' | 'LEGAL_HOLD' | 'INVALID_TIMELINE';
  retained: boolean;
  deletionAllowed: boolean;
  policyDays: number;
  expiresAt: string | null;
  legalHold: LegalHold | null;
}

export interface SecretLifecycleDecision {
  state: 'REVOKED_PENDING_FORCE_DELETE' | 'FORCE_DELETED' | 'INVALID_TIMELINE';
  readable: false;
  revokedAt: string | null;
  forceDeleteAt: string | null;
}

export interface BreakGlassGrant {
  id: string;
  tenantId: string;
  workspaceId: string;
  operatorId: string;
  operatorName: string;
  reason: string;
  auditEventId: string;
  requestedAction: string;
  resourceType: string;
  resourceId: string;
  grantedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface BreakGlassDecision {
  decision: 'ALLOW' | 'DENY';
  state: 'ACTIVE' | 'NOT_YET_ACTIVE' | 'EXPIRED' | 'REVOKED' | 'INVALID_GRANT';
  grantId: string | null;
  operatorName: string | null;
  reason: string | null;
  auditEventId: string | null;
}

export interface RetentionEvaluationInput {
  objectClass: RetainedObjectClass;
  object: RetainedObject;
  createdAt: string;
  legalHolds?: readonly LegalHold[];
}

export interface SecretLifecycleInput {
  secretId: string;
  revokedAt: string;
}

export interface BreakGlassAccessInput {
  grant: Partial<BreakGlassGrant>;
  workspaceId: string;
  requestedAction: string;
  resourceType: string;
  resourceId: string;
}

export interface PrivacyLifecyclePolicy {
  evaluateRetention(input: RetentionEvaluationInput): RetentionDecision;
  evaluateSecretLifecycle(input: SecretLifecycleInput): SecretLifecycleDecision;
  evaluateBreakGlassAccess(input: BreakGlassAccessInput): BreakGlassDecision;
}

export function createPrivacyLifecyclePolicy(input: {
  clock: PrivacyClock;
}): PrivacyLifecyclePolicy {
  return Object.freeze({
    evaluateRetention: (request: RetentionEvaluationInput): RetentionDecision =>
      evaluateRetention(input.clock, request),
    evaluateSecretLifecycle: (request: SecretLifecycleInput): SecretLifecycleDecision =>
      evaluateSecretLifecycle(input.clock, request),
    evaluateBreakGlassAccess: (request: BreakGlassAccessInput): BreakGlassDecision =>
      evaluateBreakGlassAccess(input.clock, request),
  });
}

function evaluateRetention(
  clock: PrivacyClock,
  input: RetentionEvaluationInput,
): RetentionDecision {
  const policyDays = RETENTION_DAYS[input.objectClass];
  const nowMs = readClock(clock);
  const createdAtMs = parseInstant(input.createdAt);
  const expiresAtMs =
    createdAtMs === null ? null : safeAddMilliseconds(createdAtMs, policyDays * DAY_MS);

  if (
    nowMs === null ||
    createdAtMs === null ||
    expiresAtMs === null ||
    nowMs < createdAtMs ||
    !isNonBlank(input.object.objectKey) ||
    !isNonBlank(input.object.objectVersionId)
  ) {
    return retentionResult({
      decision: 'INVALID_TIMELINE',
      retained: true,
      deletionAllowed: false,
      policyDays,
      expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
      legalHold: null,
    });
  }

  const exactHolds = (input.legalHolds ?? []).filter(
    (hold) =>
      hold.target.objectKey === input.object.objectKey &&
      hold.target.objectVersionId === input.object.objectVersionId,
  );
  const validHold = exactHolds.find(isValidLegalHold);
  if (validHold !== undefined) {
    return retentionResult({
      decision: 'LEGAL_HOLD',
      retained: true,
      deletionAllowed: false,
      policyDays,
      expiresAt: new Date(expiresAtMs).toISOString(),
      legalHold: cloneLegalHold(validHold),
    });
  }

  // A malformed or hidden hold must not authorize deletion. It also cannot be
  // presented as a valid legal hold until its required metadata is repaired.
  if (exactHolds.length > 0) {
    return retentionResult({
      decision: 'INVALID_TIMELINE',
      retained: true,
      deletionAllowed: false,
      policyDays,
      expiresAt: new Date(expiresAtMs).toISOString(),
      legalHold: null,
    });
  }

  if (nowMs >= expiresAtMs) {
    return retentionResult({
      decision: 'EXPIRE',
      retained: false,
      deletionAllowed: true,
      policyDays,
      expiresAt: new Date(expiresAtMs).toISOString(),
      legalHold: null,
    });
  }

  return retentionResult({
    decision: 'RETAIN',
    retained: true,
    deletionAllowed: false,
    policyDays,
    expiresAt: new Date(expiresAtMs).toISOString(),
    legalHold: null,
  });
}

function evaluateSecretLifecycle(
  clock: PrivacyClock,
  input: SecretLifecycleInput,
): SecretLifecycleDecision {
  const nowMs = readClock(clock);
  const revokedAtMs = parseInstant(input.revokedAt);
  const forceDeleteAtMs =
    revokedAtMs === null ? null : safeAddMilliseconds(revokedAtMs, SECRET_FORCE_DELETE_MS);

  if (
    nowMs === null ||
    revokedAtMs === null ||
    forceDeleteAtMs === null ||
    nowMs < revokedAtMs ||
    !isNonBlank(input.secretId)
  ) {
    return Object.freeze({
      state: 'INVALID_TIMELINE',
      readable: false,
      revokedAt: revokedAtMs === null ? null : new Date(revokedAtMs).toISOString(),
      forceDeleteAt: forceDeleteAtMs === null ? null : new Date(forceDeleteAtMs).toISOString(),
    });
  }

  return Object.freeze({
    state: nowMs >= forceDeleteAtMs ? 'FORCE_DELETED' : 'REVOKED_PENDING_FORCE_DELETE',
    readable: false,
    revokedAt: new Date(revokedAtMs).toISOString(),
    forceDeleteAt: new Date(forceDeleteAtMs).toISOString(),
  });
}

function evaluateBreakGlassAccess(
  clock: PrivacyClock,
  request: BreakGlassAccessInput,
): BreakGlassDecision {
  const { grant } = request;
  const nowMs = readClock(clock);
  const grantedAtMs = parseOptionalInstant(grant.grantedAt);
  const expiresAtMs = parseOptionalInstant(grant.expiresAt);
  const revokedAtMs =
    grant.revokedAt === undefined ? undefined : parseOptionalInstant(grant.revokedAt);

  if (
    nowMs === null ||
    !hasRequiredGrantMetadata(grant) ||
    grantedAtMs === null ||
    expiresAtMs === null ||
    expiresAtMs <= grantedAtMs ||
    expiresAtMs - grantedAtMs > DAY_MS ||
    revokedAtMs === null ||
    (revokedAtMs !== undefined && (revokedAtMs < grantedAtMs || revokedAtMs > nowMs)) ||
    grant.workspaceId !== request.workspaceId ||
    grant.requestedAction !== request.requestedAction ||
    grant.resourceType !== request.resourceType ||
    grant.resourceId !== request.resourceId
  ) {
    return breakGlassResult('DENY', 'INVALID_GRANT', grant);
  }

  if (revokedAtMs !== undefined) {
    return breakGlassResult('DENY', 'REVOKED', grant);
  }
  if (nowMs < grantedAtMs) {
    return breakGlassResult('DENY', 'NOT_YET_ACTIVE', grant);
  }
  if (nowMs >= expiresAtMs) {
    return breakGlassResult('DENY', 'EXPIRED', grant);
  }
  return breakGlassResult('ALLOW', 'ACTIVE', grant);
}

function retentionResult(input: RetentionDecision): RetentionDecision {
  return Object.freeze(input);
}

function breakGlassResult(
  decision: BreakGlassDecision['decision'],
  state: BreakGlassDecision['state'],
  grant: Partial<BreakGlassGrant>,
): BreakGlassDecision {
  return Object.freeze({
    decision,
    state,
    grantId: nonBlankOrNull(grant.id),
    operatorName: nonBlankOrNull(grant.operatorName),
    reason: nonBlankOrNull(grant.reason),
    auditEventId: nonBlankOrNull(grant.auditEventId),
  });
}

function hasRequiredGrantMetadata(grant: Partial<BreakGlassGrant>): boolean {
  return (
    isNonBlank(grant.id) &&
    isNonBlank(grant.tenantId) &&
    isNonBlank(grant.workspaceId) &&
    isNonBlank(grant.operatorId) &&
    isNonBlank(grant.operatorName) &&
    isNonBlank(grant.reason) &&
    isNonBlank(grant.auditEventId) &&
    isNonBlank(grant.requestedAction) &&
    isNonBlank(grant.resourceType) &&
    isNonBlank(grant.resourceId) &&
    isNonBlank(grant.grantedAt) &&
    isNonBlank(grant.expiresAt)
  );
}

function isValidLegalHold(hold: LegalHold): boolean {
  return (
    hold.visibleToTenant === true &&
    isNonBlank(hold.id) &&
    isNonBlank(hold.name) &&
    isNonBlank(hold.reason) &&
    isNonBlank(hold.createdBy) &&
    isNonBlank(hold.target.objectKey) &&
    isNonBlank(hold.target.objectVersionId)
  );
}

function cloneLegalHold(hold: LegalHold): LegalHold {
  return Object.freeze({
    id: hold.id,
    name: hold.name,
    reason: hold.reason,
    createdBy: hold.createdBy,
    visibleToTenant: true,
    target: Object.freeze({
      objectKey: hold.target.objectKey,
      objectVersionId: hold.target.objectVersionId,
    }),
  });
}

function readClock(clock: PrivacyClock): number | null {
  try {
    const value = clock.now();
    return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null;
  } catch {
    return null;
  }
}

function parseOptionalInstant(value: string | undefined): number | null {
  return value === undefined ? null : parseInstant(value);
}

function parseInstant(value: string): number | null {
  if (!isNonBlank(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeAddMilliseconds(value: number, duration: number): number | null {
  const result = value + duration;
  return Number.isFinite(result) && !Number.isNaN(new Date(result).getTime()) ? result : null;
}

function nonBlankOrNull(value: string | undefined): string | null {
  return isNonBlank(value) ? value : null;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
