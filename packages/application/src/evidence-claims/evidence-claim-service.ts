import type { IdentityIdGenerator, TenantContext, TenancyStore } from '../identity-access/index.js';
import { createHash } from 'node:crypto';
import { approvalAllowed, roleAllows } from '@aeostudio/domain/identity-access';
import type { EvidencePublicity, EvidenceSourceType } from '@aeostudio/domain/evidence-claims';

import type {
  EvidenceClaimStore,
  EvidenceObjectRead,
  EvidenceObjectRecord,
  EvidenceObjectStore,
} from './ports.js';

export class EvidenceClaimService {
  constructor(
    private readonly store: EvidenceClaimStore,
    private readonly objects: EvidenceObjectStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext' | 'appendDeniedAudit'>,
    private readonly ids: IdentityIdGenerator,
    private readonly clock: { now(): Date },
  ) {}

  async registerSource(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    sourceType: EvidenceSourceType;
    title: string;
    uri: string | null;
    license: string;
    publicity: EvidencePublicity;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' as const };
    }
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'EVIDENCE_SOURCE_CREATE',
        resourceType: 'EVIDENCE_SOURCE',
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    const source = await this.store.createSource({
      context,
      sourceId: this.ids.next(),
      sourceType: input.sourceType,
      title: input.title,
      uri: input.uri,
      license: input.license,
      publicity: input.publicity,
      createdAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
    return { outcome: 'SUCCEEDED' as const, source };
  }

  async addSnapshot(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    sourceId: string;
    contentBase64: string;
    contentType: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' as const };
    }
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'EVIDENCE_SNAPSHOT_CREATE',
        resourceType: 'EVIDENCE_SNAPSHOT',
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    const body = decodeEvidenceBody(input.contentBase64);
    const contentType = normalizeContentType(input.contentType);
    if (body === null || contentType === null) {
      return { outcome: 'OBJECT_UNVERIFIED' as const };
    }
    const snapshotId = this.ids.next();
    const contentHash = createHash('sha256').update(body).digest('hex');
    const expected = {
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      sourceId: input.sourceId,
      snapshotId,
      contentHash,
      contentType,
      sizeBytes: body.byteLength,
    };
    const object = await this.objects.ingestExact({ ...expected, body });
    if (!matchesExpectedObject(object, expected)) {
      return { outcome: 'OBJECT_UNVERIFIED' as const };
    }
    const verified = await this.objects.readExact(object);
    if (!isExactObjectRead(verified, object)) {
      return { outcome: 'OBJECT_UNVERIFIED' as const };
    }
    const created = await this.store.createSnapshot({
      context,
      snapshotId,
      sourceId: input.sourceId,
      contentHash,
      objectRef: object.objectRef,
      objectVersionId: object.objectVersionId,
      contentType,
      sizeBytes: body.byteLength,
      capturedAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
    return created === null
      ? { outcome: 'NOT_FOUND' as const }
      : { outcome: 'SUCCEEDED' as const, ...created };
  }

  async proposeClaim(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    statement: string;
    numericValue: number | null;
    unit: string | null;
    scope: string | null;
    conditions: string[];
    expiresAt: string | null;
    evidence: { snapshotId: string; snippet: string | null }[];
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' as const };
    }
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'CLAIM_PROPOSE',
        resourceType: 'CLAIM',
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    const requestedEvidence = [...input.evidence].sort((left, right) =>
      left.snapshotId.localeCompare(right.snapshotId),
    );
    const snapshots = await this.store.findSnapshots({
      context,
      snapshotIds: requestedEvidence.map((entry) => entry.snapshotId),
    });
    if (snapshots === null) return { outcome: 'NOT_FOUND' as const };
    const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    const normalizedEvidence: {
      snapshotId: string;
      sourceHash: string | null;
      snippet: string | null;
    }[] = [];
    for (const entry of requestedEvidence) {
      const snapshot = snapshotById.get(entry.snapshotId);
      if (snapshot === undefined) return { outcome: 'NOT_FOUND' as const };
      const expected = evidenceObjectFromSnapshot(snapshot);
      let read: EvidenceObjectRead | null = null;
      try {
        read = await this.objects.readExact(expected);
      } catch {
        // An unavailable or mismatched object can never establish exact Evidence.
      }
      const exact =
        read !== null &&
        isExactObjectRead(read, expected) &&
        snippetOccursInExactObject(read.body, read.contentType, entry.snippet);
      normalizedEvidence.push({
        snapshotId: entry.snapshotId,
        sourceHash: exact ? snapshot.contentHash : null,
        snippet: entry.snippet,
      });
    }
    const contentHash = createHash('sha256')
      .update(
        JSON.stringify({
          statement: input.statement,
          numericValue: input.numericValue,
          unit: input.unit,
          scope: input.scope,
          conditions: input.conditions,
          expiresAt: input.expiresAt,
          evidence: normalizedEvidence,
        }),
      )
      .digest('hex');
    const created = await this.store.createClaim({
      context,
      claimId: this.ids.next(),
      revisionId: this.ids.next(),
      evidenceLinkIds: normalizedEvidence.map(() => this.ids.next()),
      statement: input.statement,
      numericValue: input.numericValue,
      unit: input.unit,
      scope: input.scope,
      conditions: input.conditions,
      expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
      evidence: normalizedEvidence,
      contentHash,
      createdAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
    return created === null
      ? { outcome: 'NOT_FOUND' as const }
      : { outcome: 'SUCCEEDED' as const, ...created };
  }

  async submitClaim(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    claimId: string;
    revisionId: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' as const };
    }
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'CLAIM_SUBMIT',
        resourceType: 'CLAIM_REVISION',
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    if (!(await this.hasCurrentExactObjects(context, input.claimId, input.revisionId))) {
      return { outcome: 'NEEDS_EVIDENCE' as const };
    }
    return this.store.submitClaim({
      context,
      claimId: input.claimId,
      revisionId: input.revisionId,
      submittedAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
  }

  private async hasCurrentExactObjects(
    context: TenantContext,
    claimId: string,
    revisionId: string,
  ): Promise<boolean> {
    const evidence = await this.store.findEvidenceDrillDown({ context, claimId, revisionId });
    if (evidence === null || evidence.length === 0) return false;
    try {
      for (const entry of evidence) {
        const expected: EvidenceObjectRecord = {
          ...evidenceObjectFromSnapshot(entry.snapshot),
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
        };
        const read = await this.objects.readExact(expected);
        if (
          read === null ||
          !isExactObjectRead(read, expected) ||
          entry.link.sourceHash !== expected.contentHash ||
          !snippetOccursInExactObject(read.body, read.contentType, entry.link.snippet)
        ) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async reviewClaim(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    claimId: string;
    revisionId: string;
    decision: 'APPROVE' | 'REJECT';
    note: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' as const };
    }
    const bundle = await this.store.findClaimForReview({
      context,
      claimId: input.claimId,
      revisionId: input.revisionId,
    });
    if (bundle === null) {
      return { outcome: 'NOT_FOUND' as const };
    }
    if (context.actorUserId === bundle.revision.createdByUserId) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'CLAIM_APPROVE',
        resourceType: 'CLAIM_REVISION',
      });
      return { outcome: 'SELF_APPROVAL_FORBIDDEN' as const };
    }
    if (
      !approvalAllowed({
        actorKind: 'USER',
        actorId: context.actorUserId,
        creatorActorId: bundle.revision.createdByUserId,
        role: context.role,
        action: 'CLAIM_APPROVE',
      })
    ) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'CLAIM_APPROVE',
        resourceType: 'CLAIM_REVISION',
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    if (
      input.decision === 'APPROVE' &&
      !(await this.hasCurrentExactObjects(context, input.claimId, input.revisionId))
    ) {
      return { outcome: 'NEEDS_EVIDENCE' as const };
    }
    return this.store.reviewClaim({
      context,
      claimId: input.claimId,
      revisionId: input.revisionId,
      expectedContentHash: bundle.revision.contentHash,
      reviewId: this.ids.next(),
      decision: input.decision,
      note: input.note,
      reviewedAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
  }

  async getEvidenceDrillDown(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    claimId: string;
    revisionId: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) {
      return null;
    }
    return this.store.findEvidenceDrillDown({
      context,
      claimId: input.claimId,
      revisionId: input.revisionId,
    });
  }

  async getClaimRevision(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    claimId: string;
    revisionId: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) return null;
    return this.store.findClaimForReview({
      context,
      claimId: input.claimId,
      revisionId: input.revisionId,
    });
  }

  async getClaim(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    claimId: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) {
      return null;
    }
    return this.store.findCurrentClaim({
      context,
      claimId: input.claimId,
      evaluatedAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
  }

  async listApprovedClaims(input: { actorSubject: string; tenantId: string; workspaceId: string }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) return null;
    return this.store.listApprovedClaims({ context });
  }
}

const MAX_EVIDENCE_OBJECT_BYTES = 10 * 1024 * 1024;

function decodeEvidenceBody(value: string): Uint8Array | null {
  try {
    const body = Buffer.from(value, 'base64');
    if (
      body.byteLength < 1 ||
      body.byteLength > MAX_EVIDENCE_OBJECT_BYTES ||
      body.toString('base64') !== value
    ) {
      return null;
    }
    return new Uint8Array(body);
  } catch {
    return null;
  }
}

function normalizeContentType(value: string): string | null {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u.test(normalized)
    ? normalized
    : null;
}

function matchesExpectedObject(
  actual: EvidenceObjectRecord,
  expected: Omit<EvidenceObjectRecord, 'objectRef' | 'objectVersionId'>,
): boolean {
  return (
    actual.tenantId === expected.tenantId &&
    actual.workspaceId === expected.workspaceId &&
    actual.sourceId === expected.sourceId &&
    actual.snapshotId === expected.snapshotId &&
    actual.contentHash === expected.contentHash &&
    actual.contentType === expected.contentType &&
    actual.sizeBytes === expected.sizeBytes &&
    actual.objectRef.length > 0 &&
    actual.objectVersionId.length > 0
  );
}

function isExactObjectRead(
  actual: EvidenceObjectRead | null,
  expected: EvidenceObjectRecord,
): boolean {
  return (
    actual !== null &&
    matchesExpectedObject(actual, expected) &&
    actual.objectRef === expected.objectRef &&
    actual.objectVersionId === expected.objectVersionId &&
    actual.body.byteLength === expected.sizeBytes &&
    createHash('sha256').update(actual.body).digest('hex') === expected.contentHash
  );
}

function evidenceObjectFromSnapshot(snapshot: {
  tenantId: string;
  workspaceId: string;
  sourceId: string;
  id: string;
  objectRef: string;
  objectVersionId: string;
  contentHash: string;
  contentType: string;
  sizeBytes: number;
}): EvidenceObjectRecord {
  return {
    tenantId: snapshot.tenantId,
    workspaceId: snapshot.workspaceId,
    sourceId: snapshot.sourceId,
    snapshotId: snapshot.id,
    objectRef: snapshot.objectRef,
    objectVersionId: snapshot.objectVersionId,
    contentHash: snapshot.contentHash,
    contentType: snapshot.contentType,
    sizeBytes: snapshot.sizeBytes,
  };
}

function snippetOccursInExactObject(
  body: Uint8Array,
  contentType: string,
  snippet: string | null,
): boolean {
  if (snippet === null || snippet.trim().length === 0 || !isTextualContentType(contentType)) {
    return false;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body).includes(snippet);
  } catch {
    return false;
  }
}

function isTextualContentType(contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    contentType === 'application/json' ||
    contentType === 'application/xml' ||
    contentType === 'application/xhtml+xml'
  );
}
