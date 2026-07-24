import {
  AuditDigestSchema,
  AuditIntegrityVerificationSchema,
  AuditTimelineSchema,
  BreakGlassDecisionSchema,
  BreakGlassGrantSchema,
  GrantBreakGlassRequestSchema,
  MAX_BREAK_GLASS_TTL_MS,
  PrivacyOverviewSchema,
  TENANT_EXPORT_INTEGRITY_DISCLOSURE,
  TENANT_EXPORT_NO_GUARANTEE_DISCLOSURE,
  TENANT_EXPORT_SCOPE_DISCLOSURE,
  TenantDeletionReceiptSchema,
  TenantExportSchema,
  TenantExportManifestSchema,
  TenantVisibleLegalHoldSchema,
  type TenantExportManifest,
} from '@aeostudio/contracts/privacy-audit';
import {
  createPrivacyLifecyclePolicy,
  RETENTION_DAYS,
  type LegalHold,
  type RetainedObjectClass,
} from '@aeostudio/domain';

import type { TenancyStore, TenantContext } from '../identity-access/index.js';
import { canonicalPrivacyJson, privacySha256 } from './canonical-json.js';
import type {
  PlatformBreakGlassAuthorizer,
  PlatformBreakGlassPrincipal,
  PrivacyAuditStore,
  TenantExportCanonicalFile,
  TenantExportSourceObject,
} from './ports.js';

type ScopedInput = { actorSubject: string; tenantId: string; workspaceId: string };
const AUDIT_OBJECT_LOCK_MS = 365 * 24 * 60 * 60 * 1_000;
const DENY_PLATFORM_BREAK_GLASS: PlatformBreakGlassAuthorizer = Object.freeze({
  authorize: () => Promise.resolve(null),
});

export class PrivacyAuditService {
  public constructor(
    private readonly store: PrivacyAuditStore,
    private readonly tenancy: Pick<
      TenancyStore,
      'resolveTenantContext' | 'resolvePrivacyGovernanceContext' | 'appendDeniedAudit'
    >,
    private readonly ids: { next(): string },
    private readonly clock: { now(): Date },
    private readonly platformBreakGlass: PlatformBreakGlassAuthorizer = DENY_PLATFORM_BREAK_GLASS,
  ) {}

  public async exportTenant(input: ScopedInput & { from: string; to: string }) {
    const authorized = await this.resolveOwner(input, 'TENANT_EXPORT', 'TENANT');
    if (authorized.outcome !== 'SUCCEEDED') return authorized;
    const timeRange = parseTimeRange(input.from, input.to);
    const createdAt = validNow(this.clock);
    if (timeRange === null || createdAt === null || timeRange.to.getTime() >= createdAt.getTime()) {
      return { outcome: 'INVALID_TIME_RANGE' as const };
    }
    const normalizedTimeRange = {
      from: timeRange.from.toISOString(),
      to: timeRange.to.toISOString(),
    };

    try {
      const loaded = await this.store.loadTenantExportObjects({
        context: authorized.context,
        from: timeRange.from,
        to: timeRange.to,
      });
      if (loaded.outcome !== 'SUCCEEDED') return { outcome: loaded.outcome };
      const exportBundle = buildTenantExportBundle({
        tenantId: input.tenantId,
        ...normalizedTimeRange,
        objects: loaded.objects,
      });
      if (exportBundle === null) return { outcome: 'PIPELINE_UNAVAILABLE' as const };
      const { manifest, canonicalFiles } = exportBundle;
      const checksum = privacySha256(canonicalPrivacyJson(manifest));
      const exportId = this.ids.next();
      const saved = await this.store.saveTenantExport({
        context: authorized.context,
        exportId,
        manifest,
        checksum,
        requestHash: privacySha256(
          canonicalPrivacyJson({
            tenantId: input.tenantId,
            timeRange: manifest.timeRange,
          }),
        ),
        canonicalFiles,
        createdAt,
        auditEventId: this.ids.next(),
      });
      if (saved.outcome !== 'SUCCEEDED') return { outcome: saved.outcome };
      const exported = TenantExportSchema.safeParse({
        id: saved.exportId,
        manifest,
        checksum,
        archiveStatus: saved.archiveStatus,
        archiveReady: saved.archiveReady,
        objectRef: saved.objectRef,
        createdAt: saved.createdAt,
      });
      return exported.success
        ? { outcome: 'SUCCEEDED' as const, export: exported.data }
        : { outcome: 'PIPELINE_UNAVAILABLE' as const };
    } catch {
      return { outcome: 'PIPELINE_UNAVAILABLE' as const };
    }
  }

  public requestTenantDeletion(input: ScopedInput & { reason: string }) {
    return this.requestDeletion('TENANT', input);
  }

  public requestWorkspaceDeletion(input: ScopedInput & { reason: string }) {
    return this.requestDeletion('WORKSPACE', input);
  }

  public async finalizeDeletion(input: { requestId: string; leaseToken: string }) {
    const effectiveAt = validNow(this.clock);
    if (effectiveAt === null || !isUuid(input.requestId) || !isUuid(input.leaseToken)) {
      return { outcome: 'INVALID_TIMELINE' as const };
    }
    try {
      return await this.store.finalizeDeletion({
        requestId: input.requestId,
        leaseToken: input.leaseToken,
        effectiveAt,
        tombstoneId: this.ids.next(),
        auditEventId: this.ids.next(),
      });
    } catch {
      return { outcome: 'PIPELINE_UNAVAILABLE' as const };
    }
  }

  public async createLegalHold(
    input: ScopedInput & {
      name: string;
      reason: string;
      objectKey: string;
      objectVersionId: string;
    },
  ) {
    const authorized = await this.resolveOwner(input, 'LEGAL_HOLD_CREATED', 'LEGAL_HOLD');
    if (authorized.outcome !== 'SUCCEEDED') return authorized;
    const createdAt = validNow(this.clock);
    const name = input.name.trim();
    const reason = input.reason.trim();
    if (
      createdAt === null ||
      name.length === 0 ||
      name.length > 200 ||
      reason.length === 0 ||
      reason.length > 1_000 ||
      !validTenantObjectKey(input.objectKey, input.tenantId) ||
      input.objectVersionId.trim().length === 0
    ) {
      return { outcome: 'INVALID_HOLD' as const };
    }
    const holdId = this.ids.next();
    try {
      const result = await this.store.createLegalHold({
        context: authorized.context,
        holdId,
        name,
        reason,
        objectKey: input.objectKey,
        objectVersionId: input.objectVersionId,
        createdAt,
        auditEventId: this.ids.next(),
      });
      if (result.outcome !== 'SUCCEEDED') return { outcome: result.outcome };
      const parsed = TenantVisibleLegalHoldSchema.safeParse(result.hold);
      if (
        !parsed.success ||
        parsed.data.id !== holdId ||
        parsed.data.tenantId !== input.tenantId ||
        parsed.data.createdBy !== authorized.context.actorUserId ||
        parsed.data.target.objectKey !== input.objectKey ||
        parsed.data.target.objectVersionId !== input.objectVersionId ||
        parsed.data.releasedAt !== null
      ) {
        return { outcome: 'INVALID_HOLD' as const };
      }
      return { outcome: 'SUCCEEDED' as const, hold: parsed.data };
    } catch {
      return { outcome: 'PIPELINE_UNAVAILABLE' as const };
    }
  }

  public async listLegalHolds(input: ScopedInput) {
    const authorized = await this.resolveOwner(input, 'LEGAL_HOLD_LIST', 'LEGAL_HOLD', true);
    if (authorized.outcome !== 'SUCCEEDED') return authorized;
    try {
      const holds = await this.store.listLegalHolds({
        context: authorized.context,
        includeReleased: false,
      });
      const parsed = holds.map((hold) => TenantVisibleLegalHoldSchema.safeParse(hold));
      if (
        parsed.some(
          (entry) =>
            !entry.success ||
            entry.data.tenantId !== input.tenantId ||
            entry.data.visibleToTenant !== true ||
            entry.data.releasedAt !== null,
        )
      ) {
        return { outcome: 'PIPELINE_UNAVAILABLE' as const };
      }
      return {
        outcome: 'SUCCEEDED' as const,
        holds: parsed.map((entry) => {
          if (!entry.success) throw new Error('LEGAL_HOLD_PARSE_INVARIANT');
          return entry.data;
        }),
      };
    } catch {
      return { outcome: 'PIPELINE_UNAVAILABLE' as const };
    }
  }

  public async releaseLegalHold(input: ScopedInput & { holdId: string }) {
    const authorized = await this.resolveOwner(input, 'LEGAL_HOLD_RELEASED', 'LEGAL_HOLD', true);
    if (authorized.outcome !== 'SUCCEEDED') return authorized;
    const releasedAt = validNow(this.clock);
    if (releasedAt === null || input.holdId.trim().length === 0) {
      return { outcome: 'INVALID_HOLD' as const };
    }
    try {
      return await this.store.releaseLegalHold({
        context: authorized.context,
        holdId: input.holdId,
        releasedAt,
        auditEventId: this.ids.next(),
      });
    } catch {
      return { outcome: 'PIPELINE_UNAVAILABLE' as const };
    }
  }

  public async evaluateRetention(
    input: ScopedInput & {
      objectClass: RetainedObjectClass;
      objectKey: string;
      objectVersionId: string;
      createdAt: string;
    },
  ) {
    const authorized = await this.resolveOwner(input, 'RETENTION_EVALUATED', 'RETAINED_OBJECT');
    if (authorized.outcome !== 'SUCCEEDED') return invalidRetention(input.objectClass);
    try {
      const records = await this.store.listLegalHolds({
        context: authorized.context,
        includeReleased: false,
      });
      const holds: LegalHold[] = records
        .filter(
          (record) =>
            record.tenantId === input.tenantId &&
            record.visibleToTenant === true &&
            record.releasedAt === null,
        )
        .map((record) => ({
          id: record.id,
          name: record.name,
          reason: record.reason,
          createdBy: record.createdBy,
          visibleToTenant: true,
          target: { ...record.target },
        }));
      return createPrivacyLifecyclePolicy({ clock: this.clock }).evaluateRetention({
        objectClass: input.objectClass,
        object: { objectKey: input.objectKey, objectVersionId: input.objectVersionId },
        createdAt: input.createdAt,
        legalHolds: holds,
      });
    } catch {
      return invalidRetention(input.objectClass);
    }
  }

  public async grantBreakGlass(
    input: ScopedInput & {
      reason: string;
      expiresAt: string;
      requestedAction: string;
      resourceType: string;
      resourceId: string;
    },
  ) {
    const grantedAt = validNow(this.clock);
    const request = GrantBreakGlassRequestSchema.safeParse({
      reason: input.reason,
      expiresAt: input.expiresAt,
      requestedAction: input.requestedAction,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    });
    if (
      !request.success ||
      grantedAt === null ||
      !validBreakGlassScope(input) ||
      input.actorSubject.trim().length === 0
    ) {
      return { outcome: 'INVALID_GRANT' as const };
    }
    const expiresAt = new Date(request.data.expiresAt);
    const ttl = expiresAt.getTime() - grantedAt.getTime();
    if (!Number.isFinite(expiresAt.getTime()) || ttl <= 0 || ttl > MAX_BREAK_GLASS_TTL_MS) {
      return { outcome: 'INVALID_GRANT' as const };
    }
    const principal = await this.authorizePlatform({
      actorSubject: input.actorSubject,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      operation: 'GRANT',
      requestedAction: request.data.requestedAction,
      resourceType: request.data.resourceType,
      resourceId: request.data.resourceId,
    });
    if (principal === null) {
      await this.auditDeniedBreakGlass({
        actorSubject: input.actorSubject,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        requestedAction: request.data.requestedAction,
        resourceType: request.data.resourceType,
        resourceId: request.data.resourceId,
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    const grantId = this.ids.next();
    const auditEventId = this.ids.next();
    try {
      const result = await this.store.grantBreakGlass({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        grantId,
        operatorId: principal.operatorId,
        operatorName: principal.operatorName,
        reason: request.data.reason,
        expiresAt,
        requestedAction: request.data.requestedAction,
        resourceType: request.data.resourceType,
        resourceId: request.data.resourceId,
        auditEventId,
      });
      if (result.outcome !== 'SUCCEEDED') return { outcome: result.outcome };
      const parsed = BreakGlassGrantSchema.safeParse(result.grant);
      if (
        !parsed.success ||
        parsed.data.id !== grantId ||
        parsed.data.tenantId !== input.tenantId ||
        parsed.data.workspaceId !== input.workspaceId ||
        parsed.data.operatorId !== principal.operatorId ||
        parsed.data.operatorName !== principal.operatorName ||
        parsed.data.reason !== request.data.reason ||
        parsed.data.auditEventId !== auditEventId ||
        parsed.data.requestedAction !== request.data.requestedAction ||
        parsed.data.resourceType !== request.data.resourceType ||
        parsed.data.resourceId !== request.data.resourceId ||
        parsed.data.expiresAt !== expiresAt.toISOString() ||
        parsed.data.revokedAt !== null
      ) {
        return { outcome: 'INVALID_GRANT' as const };
      }
      return { outcome: 'SUCCEEDED' as const, grant: parsed.data };
    } catch {
      return { outcome: 'INVALID_GRANT' as const };
    }
  }

  public async evaluateBreakGlassAccess(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    grantId: string;
    requestedAction: string;
    resourceType: string;
    resourceId: string;
  }) {
    if (
      input.actorSubject.trim().length === 0 ||
      !validBreakGlassScope(input) ||
      input.grantId.trim().length === 0 ||
      !validBreakGlassBinding(input)
    ) {
      return invalidBreakGlass();
    }
    const principal = await this.authorizePlatform({
      actorSubject: input.actorSubject,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      operation: 'EVALUATE',
      requestedAction: input.requestedAction,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    });
    const auditEventId = this.ids.next();
    try {
      const decision = await this.store.evaluateBreakGlassAccess({
        actorSubject: input.actorSubject,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        grantId: input.grantId,
        operatorId: principal?.operatorId ?? null,
        operatorName: principal?.operatorName ?? null,
        requestedAction: input.requestedAction,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        auditEventId,
      });
      const parsed = BreakGlassDecisionSchema.safeParse(decision);
      if (
        !parsed.success ||
        parsed.data.auditEventId !== auditEventId ||
        (principal === null && parsed.data.decision !== 'DENY')
      ) {
        return invalidBreakGlass();
      }
      return parsed.data;
    } catch {
      return invalidBreakGlass();
    }
  }

  public async revokeBreakGlass(input: ScopedInput & { grantId: string }) {
    if (!validBreakGlassScope(input) || input.grantId.trim().length === 0) {
      return { outcome: 'INVALID_GRANT' as const };
    }
    const principal = await this.authorizePlatform({
      actorSubject: input.actorSubject,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      operation: 'REVOKE',
      requestedAction: 'BREAK_GLASS_REVOKE',
      resourceType: 'BREAK_GLASS_GRANT',
      resourceId: input.grantId,
    });
    if (principal === null) {
      await this.auditDeniedBreakGlass({
        actorSubject: input.actorSubject,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        grantId: input.grantId,
        requestedAction: 'BREAK_GLASS_REVOKE',
        resourceType: 'BREAK_GLASS_GRANT',
        resourceId: input.grantId,
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    try {
      return await this.store.revokeBreakGlass({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        grantId: input.grantId,
        operatorId: principal.operatorId,
        operatorName: principal.operatorName,
        auditEventId: this.ids.next(),
      });
    } catch {
      return { outcome: 'INVALID_GRANT' as const };
    }
  }

  private async authorizePlatform(
    input: Parameters<PlatformBreakGlassAuthorizer['authorize']>[0],
  ): Promise<PlatformBreakGlassPrincipal | null> {
    try {
      const principal = await this.platformBreakGlass.authorize(input);
      if (
        principal === null ||
        !isUuid(principal.operatorId) ||
        principal.operatorName.trim().length === 0 ||
        principal.operatorName.trim().length > 200
      ) {
        return null;
      }
      return {
        operatorId: principal.operatorId,
        operatorName: principal.operatorName.trim(),
      };
    } catch {
      return null;
    }
  }

  private async auditDeniedBreakGlass(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    grantId?: string;
    requestedAction: string;
    resourceType: string;
    resourceId: string;
  }): Promise<void> {
    try {
      await this.store.evaluateBreakGlassAccess({
        ...input,
        grantId: input.grantId ?? this.ids.next(),
        operatorId: null,
        operatorName: null,
        auditEventId: this.ids.next(),
      });
    } catch {
      // Authorization remains denied even when its mandatory evidence sink is unavailable.
    }
  }

  public async verifyAuditIntegrity(input: ScopedInput) {
    const authorized = await this.resolveOwner(
      input,
      'AUDIT_INTEGRITY_VERIFIED',
      'AUDIT_CHAIN',
      true,
    );
    if (authorized.outcome !== 'SUCCEEDED') {
      return { outcome: 'NOT_FOUND' as const, valid: false, eventCount: 0, reason: null };
    }
    try {
      const verification = AuditIntegrityVerificationSchema.safeParse(
        await this.store.verifyAuditChain({ context: authorized.context }),
      );
      if (!verification.success) return invalidAuditIntegrity();
      if (verification.data.valid) {
        return {
          outcome: 'SUCCEEDED' as const,
          valid: true,
          eventCount: verification.data.eventCount,
          reason: null,
        };
      }
      return {
        outcome: 'TAMPERED' as const,
        valid: false,
        eventCount: verification.data.eventCount,
        reason: verification.data.reason ?? 'Audit chain digest verification detected tampering.',
      };
    } catch {
      return invalidAuditIntegrity();
    }
  }

  public async getPrivacyOverview(input: ScopedInput) {
    const authorized = await this.resolveOwner(input, 'PRIVACY_OVERVIEW_VIEWED', 'TENANT', true);
    if (authorized.outcome !== 'SUCCEEDED') return authorized;
    const at = validNow(this.clock);
    if (at === null) return { outcome: 'PIPELINE_UNAVAILABLE' as const };
    try {
      const result = await this.store.getPrivacyOverview({ context: authorized.context, at });
      if (result.outcome !== 'SUCCEEDED') return result;
      const overview = PrivacyOverviewSchema.safeParse(result.overview);
      if (
        !overview.success ||
        overview.data.tenantId !== input.tenantId ||
        overview.data.legalHolds.some((hold) => hold.tenantId !== input.tenantId) ||
        overview.data.breakGlassGrants.some((grant) => grant.tenantId !== input.tenantId)
      ) {
        return { outcome: 'PIPELINE_UNAVAILABLE' as const };
      }
      return { outcome: 'SUCCEEDED' as const, overview: overview.data };
    } catch {
      return { outcome: 'PIPELINE_UNAVAILABLE' as const };
    }
  }

  public async listAuditEvents(
    input: ScopedInput & {
      from: string;
      to: string;
      cursor?: string | null;
      limit?: number;
    },
  ) {
    const authorized = await this.resolveOwner(input, 'AUDIT_TIMELINE_VIEWED', 'AUDIT_EVENT', true);
    if (authorized.outcome !== 'SUCCEEDED') return authorized;
    const timeRange = parseTimeRange(input.from, input.to);
    const cursor = input.cursor ?? null;
    const limit = input.limit ?? 50;
    if (
      timeRange === null ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      (cursor !== null && (cursor.trim().length === 0 || cursor.length > 500))
    ) {
      return { outcome: 'INVALID_REQUEST' as const };
    }
    try {
      const result = await this.store.listAuditEvents({
        context: authorized.context,
        from: timeRange.from,
        to: timeRange.to,
        cursor,
        limit,
      });
      if (result.outcome !== 'SUCCEEDED') return result;
      const timeline = AuditTimelineSchema.safeParse(result.timeline);
      if (
        !timeline.success ||
        timeline.data.events.some(
          (event) =>
            event.tenantId !== input.tenantId ||
            (event.workspaceId !== null && event.workspaceId !== input.workspaceId),
        )
      ) {
        return { outcome: 'PIPELINE_UNAVAILABLE' as const };
      }
      return { outcome: 'SUCCEEDED' as const, timeline: timeline.data };
    } catch {
      return { outcome: 'PIPELINE_UNAVAILABLE' as const };
    }
  }

  public async sealAuditDigest(input: ScopedInput & { from: string; to: string }) {
    const authorized = await this.resolveOwner(input, 'AUDIT_DIGEST_SEALED', 'AUDIT_DIGEST');
    if (authorized.outcome !== 'SUCCEEDED') return authorized;
    const timeRange = parseTimeRange(input.from, input.to);
    if (timeRange === null) return { outcome: 'INVALID_TIME_RANGE' as const };
    try {
      const digestId = this.ids.next();
      const result = await this.store.sealAuditDigest({
        context: authorized.context,
        digestId,
        from: timeRange.from,
        to: timeRange.to,
        auditEventId: this.ids.next(),
      });
      if (result.outcome === 'TAMPERED') {
        return {
          outcome: 'TAMPERED' as const,
          valid: false,
          eventCount: result.eventCount,
          reason: result.reason,
        };
      }
      if (result.outcome !== 'SUCCEEDED') return { outcome: result.outcome };
      const digest = AuditDigestSchema.safeParse(result.digest);
      if (!digest.success) return { outcome: 'PIPELINE_UNAVAILABLE' as const };
      const normalizedRange = {
        from: timeRange.from.toISOString(),
        to: timeRange.to.toISOString(),
      };
      const sealedAt = Date.parse(digest.data.sealedAt);
      const lockedUntil = Date.parse(digest.data.lockedUntil);
      const expectedDigestHash = privacySha256(
        canonicalPrivacyJson({
          id: digest.data.id,
          tenantId: digest.data.tenantId,
          schemaVersion: digest.data.schemaVersion,
          timeRange: digest.data.timeRange,
          eventCount: digest.data.eventCount,
          lastSequence: digest.data.lastSequence,
          headHash: digest.data.headHash,
          lockedUntil: digest.data.lockedUntil,
          sealedAt: digest.data.sealedAt,
        }),
      );
      if (
        (result.created && digest.data.id !== digestId) ||
        digest.data.tenantId !== input.tenantId ||
        digest.data.timeRange.from !== normalizedRange.from ||
        digest.data.timeRange.to !== normalizedRange.to ||
        !Number.isFinite(sealedAt) ||
        !Number.isFinite(lockedUntil) ||
        Date.parse(normalizedRange.to) >= sealedAt ||
        lockedUntil !== sealedAt + AUDIT_OBJECT_LOCK_MS ||
        digest.data.digestHash !== expectedDigestHash ||
        !validTenantObjectKey(digest.data.objectKey, input.tenantId)
      ) {
        return { outcome: 'PIPELINE_UNAVAILABLE' as const };
      }
      return { outcome: 'SUCCEEDED' as const, digest: digest.data };
    } catch {
      return { outcome: 'PIPELINE_UNAVAILABLE' as const };
    }
  }

  private async requestDeletion(
    scope: 'TENANT' | 'WORKSPACE',
    input: ScopedInput & { reason: string },
  ) {
    const authorized = await this.resolveOwner(input, `${scope}_DELETION_REQUEST`, scope);
    if (authorized.outcome !== 'SUCCEEDED') return authorized;
    const requestedAt = validNow(this.clock);
    const reason = input.reason.trim();
    if (requestedAt === null || reason.length === 0 || reason.length > 1_000) {
      return { outcome: 'INVALID_REQUEST' as const };
    }
    const requestId = this.ids.next();
    const requestHash = privacySha256(
      canonicalPrivacyJson({
        scope,
        tenantId: input.tenantId,
        workspaceId: scope === 'WORKSPACE' ? input.workspaceId : null,
        reason,
      }),
    );
    try {
      const result =
        scope === 'TENANT'
          ? await this.store.requestTenantDeletion({
              actorSubject: input.actorSubject,
              context: authorized.context,
              requestId,
              reason,
              requestHash,
              requestedAt,
              auditEventId: this.ids.next(),
            })
          : await this.store.requestWorkspaceDeletion({
              actorSubject: input.actorSubject,
              context: authorized.context,
              requestId,
              reason,
              requestHash,
              requestedAt,
              auditEventId: this.ids.next(),
            });
      if (result.outcome !== 'SUCCEEDED') return { outcome: result.outcome };
      const parsed = TenantDeletionReceiptSchema.safeParse(result.receipt);
      if (
        !parsed.success ||
        (result.created && parsed.data.id !== requestId) ||
        parsed.data.scope !== scope
      ) {
        return { outcome: 'PIPELINE_UNAVAILABLE' as const };
      }
      return { outcome: 'SUCCEEDED' as const, receipt: parsed.data };
    } catch {
      // A store must leave a partially processed request frozen and retryable.
      return { outcome: 'PIPELINE_UNAVAILABLE' as const };
    }
  }

  private async resolveOwner(
    input: ScopedInput,
    action: string,
    resourceType: string,
    privacyGovernance = false,
  ): Promise<
    { outcome: 'SUCCEEDED'; context: TenantContext } | { outcome: 'FORBIDDEN' | 'NOT_FOUND' }
  > {
    let context: TenantContext | null;
    try {
      context = privacyGovernance
        ? await this.tenancy.resolvePrivacyGovernanceContext(input)
        : await this.tenancy.resolveTenantContext(input);
    } catch {
      return { outcome: 'NOT_FOUND' };
    }
    if (context === null) return { outcome: 'NOT_FOUND' };
    if (context.role !== 'OWNER') {
      try {
        await this.tenancy.appendDeniedAudit({
          context,
          auditEventId: this.ids.next(),
          action,
          resourceType,
        });
      } catch {
        // Authorization remains denied even when the audit sink is unavailable.
      }
      return { outcome: 'FORBIDDEN' };
    }
    return { outcome: 'SUCCEEDED', context };
  }
}

function buildTenantExportBundle(input: {
  tenantId: string;
  from: string;
  to: string;
  objects: TenantExportSourceObject[];
}): { manifest: TenantExportManifest; canonicalFiles: TenantExportCanonicalFile[] } | null {
  const normalized: Array<{
    kind: string;
    objectId: string;
    contentHash: string;
    canonicalPayload: string;
  }> = [];
  const unique = new Set<string>();
  for (const object of input.objects) {
    if (
      object.tenantId !== input.tenantId ||
      !/^[A-Z][A-Z0-9_]{0,63}$/u.test(object.kind) ||
      object.objectId.trim().length === 0 ||
      containsForeignTenantId(object.payload, input.tenantId) ||
      containsSecretMaterial(object.payload)
    ) {
      return null;
    }
    const key = `${object.kind}:${object.objectId}`;
    if (unique.has(key)) return null;
    unique.add(key);
    let canonicalPayload: string;
    try {
      canonicalPayload = canonicalPrivacyJson({
        schemaVersion: 'tenant-export-object.v1',
        tenantId: object.tenantId,
        workspaceId: object.workspaceId,
        kind: object.kind,
        objectId: object.objectId,
        occurredAt: object.occurredAt,
        payload: object.payload,
      });
    } catch {
      return null;
    }
    normalized.push({
      kind: object.kind,
      objectId: object.objectId,
      contentHash: privacySha256(canonicalPayload),
      canonicalPayload,
    });
  }
  normalized.sort((left, right) =>
    `${left.kind}:${left.objectId}`.localeCompare(`${right.kind}:${right.objectId}`),
  );
  const manifest = {
    schemaVersion: '1.0.0' as const,
    tenantId: input.tenantId,
    timeRange: { from: input.from, to: input.to },
    objects: normalized.map(({ kind, objectId, contentHash }) => ({
      kind,
      objectId,
      contentHash,
    })),
    files: normalized
      .map(({ kind, objectId, contentHash, canonicalPayload }) => ({
        path: `objects/${kind.toLowerCase()}/${encodeURIComponent(objectId)}.json`,
        contentHash,
        byteLength: Buffer.byteLength(canonicalPayload, 'utf8'),
        objectCount: 1,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    disclosures: {
      tenantScope: TENANT_EXPORT_SCOPE_DISCLOSURE,
      integrity: TENANT_EXPORT_INTEGRITY_DISCLOSURE,
      noGuarantee: TENANT_EXPORT_NO_GUARANTEE_DISCLOSURE,
    },
  };
  const parsed = TenantExportManifestSchema.safeParse(manifest);
  if (!parsed.success) return null;
  return {
    manifest: parsed.data,
    canonicalFiles: normalized
      .map(({ kind, objectId, contentHash, canonicalPayload }) => ({
        path: `objects/${kind.toLowerCase()}/${encodeURIComponent(objectId)}.json`,
        content: canonicalPayload,
        contentHash,
        byteLength: Buffer.byteLength(canonicalPayload, 'utf8'),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function parseTimeRange(from: string, to: string): { from: Date; to: Date } | null {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  return Number.isFinite(fromDate.getTime()) &&
    Number.isFinite(toDate.getTime()) &&
    fromDate.getTime() <= toDate.getTime()
    ? { from: fromDate, to: toDate }
    : null;
}

function validNow(clock: { now(): Date }): Date | null {
  try {
    const now = clock.now();
    return now instanceof Date && Number.isFinite(now.getTime()) ? new Date(now) : null;
  } catch {
    return null;
  }
}

function validTenantObjectKey(objectKey: string, tenantId: string): boolean {
  return (
    objectKey.length <= 1_024 &&
    objectKey.startsWith(`tenants/${tenantId}/`) &&
    !objectKey.includes('..') &&
    !objectKey.includes('\\')
  );
}

function validBreakGlassScope(input: { tenantId: string; workspaceId: string }): boolean {
  return isUuid(input.tenantId) && isUuid(input.workspaceId);
}

function validBreakGlassBinding(input: {
  requestedAction: string;
  resourceType: string;
  resourceId: string;
}): boolean {
  return (
    input.requestedAction.trim().length >= 1 &&
    input.requestedAction.trim().length <= 160 &&
    input.resourceType.trim().length >= 1 &&
    input.resourceType.trim().length <= 160 &&
    input.resourceId.trim().length >= 1 &&
    input.resourceId.trim().length <= 500
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function invalidRetention(objectClass: RetainedObjectClass) {
  return {
    decision: 'INVALID_TIMELINE' as const,
    retained: true,
    deletionAllowed: false,
    policyDays: RETENTION_DAYS[objectClass],
    expiresAt: null,
    legalHold: null,
  };
}

function invalidBreakGlass() {
  return {
    decision: 'DENY' as const,
    state: 'INVALID_GRANT' as const,
    grantId: null,
    operatorName: null,
    reason: null,
    auditEventId: null,
  };
}

function invalidAuditIntegrity() {
  return {
    outcome: 'TAMPERED' as const,
    valid: false,
    eventCount: 0,
    reason: 'Audit chain digest verification could not establish integrity.',
  };
}

const SECRET_KEYS = new Set([
  'access_token',
  'accesstoken',
  'credential',
  'secret_arn',
  'secret_value',
  'secretarn',
  'secretvalue',
  'token_digest',
  'tokendigest',
]);

function containsSecretMaterial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretMaterial);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) => SECRET_KEYS.has(key.toLowerCase()) || containsSecretMaterial(entry),
  );
}

function containsForeignTenantId(value: unknown, tenantId: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsForeignTenantId(entry, tenantId));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) => {
    const normalized = key.replaceAll('_', '').toLowerCase();
    if (normalized === 'tenantid') return typeof entry !== 'string' || entry !== tenantId;
    return containsForeignTenantId(entry, tenantId);
  });
}
