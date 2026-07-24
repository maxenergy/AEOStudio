import { randomUUID } from 'node:crypto';

import { canonicalPrivacyJson, privacySha256 } from '@aeostudio/application/privacy-audit';
import type {
  AuditIntegrityVerification,
  AuditTimelineEvent,
} from '@aeostudio/contracts/privacy-audit';

const SENSITIVE_METADATA_KEY =
  /(?:secret(?:arn|reference|value)|clientsecret|api[_-]?key|token(?:digest|value)?|password|passwd|credential|cookie|authorizationheader|session(?:id|digest|token))/i;
const SENSITIVE_METADATA_VALUE =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:api[_-]?key|client[_-]?secret|password)\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|arn:aws:secretsmanager:)/i;
const MAX_METADATA_BYTES = 16_384;

export interface InMemoryAuditAppendInput {
  id: string;
  tenantId: string;
  workspaceId: string | null;
  actorKind?: AuditTimelineEvent['actorKind'];
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  outcome: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

interface PendingSubjectEvent {
  id: string;
  actorSubject: string;
  actorKind: AuditTimelineEvent['actorKind'];
  action: string;
  resourceType: string;
  resourceId: string | null;
  outcome: string;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}

interface SubjectTenantBinding {
  tenantId: string;
  actorUserId: string;
}

/**
 * One append-only, tenant-scoped hash chain for the explicit fake runtime.
 *
 * Call sites pass identifiers and bounded operational metadata only. This sink
 * additionally rejects credential-shaped metadata keys so a later adapter
 * cannot accidentally copy a token, secret, cookie or session into Audit.
 */
export class InMemoryAuditSink {
  private readonly events = new Map<string, AuditTimelineEvent[]>();
  private readonly subjectBindings = new Map<string, SubjectTenantBinding[]>();
  private readonly pendingSubjectEvents = new Map<string, PendingSubjectEvent[]>();

  public constructor(private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  public append(input: InMemoryAuditAppendInput): void {
    const metadata = sanitizeMetadata(input.metadata ?? {});
    const occurredAt = validDate(
      input.occurredAt ?? this.clock.now(),
      input.occurredAt === undefined ? 'INVALID_AUDIT_CLOCK' : 'INVALID_AUDIT_OCCURRED_AT',
    );
    const tenantEvents = this.events.get(input.tenantId) ?? [];
    if (tenantEvents.some((event) => event.id === input.id)) return;
    const eventWithoutHash: Omit<AuditTimelineEvent, 'eventHash'> = {
      id: input.id,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      sequence: tenantEvents.length + 1,
      previousHash: tenantEvents.at(-1)?.eventHash ?? null,
      actorKind: input.actorKind ?? 'USER',
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      outcome: input.outcome,
      metadata,
      occurredAt: occurredAt.toISOString(),
    };
    tenantEvents.push({
      ...eventWithoutHash,
      eventHash: hashAuditEvent(eventWithoutHash),
    });
    this.events.set(input.tenantId, tenantEvents);
  }

  public appendForSubject(
    input: Omit<PendingSubjectEvent, 'id' | 'metadata' | 'occurredAt'> & {
      id?: string;
      metadata?: Record<string, unknown>;
      occurredAt?: Date;
    },
  ): void {
    const event: PendingSubjectEvent = {
      ...input,
      id: input.id ?? randomUUID(),
      metadata: sanitizeMetadata(input.metadata ?? {}),
      occurredAt: validDate(input.occurredAt ?? this.clock.now(), 'INVALID_AUDIT_CLOCK'),
    };
    const bindings = this.subjectBindings.get(input.actorSubject) ?? [];
    if (bindings.length === 0) {
      const pending = this.pendingSubjectEvents.get(input.actorSubject) ?? [];
      if (!pending.some((candidate) => candidate.id === event.id)) pending.push(event);
      this.pendingSubjectEvents.set(input.actorSubject, pending);
      return;
    }
    for (const binding of bindings) this.appendBoundSubjectEvent(event, binding);
  }

  public bindSubject(input: { actorSubject: string; tenantId: string; actorUserId: string }): void {
    const bindings = this.subjectBindings.get(input.actorSubject) ?? [];
    if (!bindings.some((binding) => binding.tenantId === input.tenantId)) {
      bindings.push({ tenantId: input.tenantId, actorUserId: input.actorUserId });
      bindings.sort((left, right) => compareCodeUnits(left.tenantId, right.tenantId));
      this.subjectBindings.set(input.actorSubject, bindings);
    }
    const binding = bindings.find((candidate) => candidate.tenantId === input.tenantId);
    if (binding === undefined) return;
    const pending = [...(this.pendingSubjectEvents.get(input.actorSubject) ?? [])].sort(
      (left, right) =>
        left.occurredAt.getTime() - right.occurredAt.getTime() ||
        compareCodeUnits(left.id, right.id),
    );
    for (const event of pending) this.appendBoundSubjectEvent(event, binding);
    this.pendingSubjectEvents.delete(input.actorSubject);
  }

  public listTenant(tenantId: string): AuditTimelineEvent[] {
    return structuredClone(this.events.get(tenantId) ?? []);
  }

  public verifyTenant(tenantId: string): AuditIntegrityVerification {
    const events = this.events.get(tenantId) ?? [];
    let previousHash: string | null = null;
    for (const [index, event] of events.entries()) {
      const { eventHash, ...eventWithoutHash } = event;
      if (
        event.sequence !== index + 1 ||
        event.previousHash !== previousHash ||
        eventHash !== hashAuditEvent(eventWithoutHash)
      ) {
        return {
          valid: false,
          eventCount: events.length,
          lastSequence: index,
          headHash: previousHash,
          reason: 'Audit chain digest mismatch detected.',
        };
      }
      previousHash = eventHash;
    }
    return {
      valid: true,
      eventCount: events.length,
      lastSequence: events.length,
      headHash: previousHash,
      reason: null,
    };
  }

  private appendBoundSubjectEvent(event: PendingSubjectEvent, binding: SubjectTenantBinding): void {
    this.append({
      id: event.id,
      tenantId: binding.tenantId,
      workspaceId: null,
      actorKind: event.actorKind,
      actorId: binding.actorUserId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      outcome: event.outcome,
      metadata: event.metadata,
      occurredAt: event.occurredAt,
    });
  }
}

function hashAuditEvent(input: Omit<AuditTimelineEvent, 'eventHash'>): string {
  return privacySha256(canonicalPrivacyJson(input));
}

function sanitizeMetadata(input: Record<string, unknown>): Record<string, unknown> {
  rejectSensitiveKeys(input);
  const clone = structuredClone(input);
  const byteLength = new TextEncoder().encode(canonicalPrivacyJson(clone)).byteLength;
  if (byteLength > MAX_METADATA_BYTES) throw new Error('AUDIT_METADATA_TOO_LARGE');
  return clone;
}

function rejectSensitiveKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) rejectSensitiveKeys(entry);
    return;
  }
  if (typeof value === 'string') {
    if (SENSITIVE_METADATA_VALUE.test(value)) {
      throw new Error('SENSITIVE_AUDIT_METADATA_REJECTED');
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_METADATA_KEY.test(key)) throw new Error('SENSITIVE_AUDIT_METADATA_REJECTED');
    rejectSensitiveKeys(entry);
  }
}

function validDate(value: Date, errorCode: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(errorCode);
  return new Date(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
