import {
  canonicalPrivacyJson,
  privacySha256,
  type PrivacyAuditStore,
  type RequestDeletionStoreResult,
  type TenantExportCanonicalFile,
  type TenantExportSourceObject,
} from '@aeostudio/application/privacy-audit';
import type { InMemorySecretLifecycleStore } from '@aeostudio/adapters/secrets';
import type { FakePrivacyObjectStorage } from '@aeostudio/adapters/storage';
import {
  TenantExportManifestSchema,
  type AuditDigest,
  type AuditIntegrityVerification,
  type AuditTimelineEvent,
  type BreakGlassDecisionRecord,
  type BreakGlassGrantRecord,
  type TenantDeletionReceipt,
  type TenantExportManifest,
  type TenantVisibleLegalHold,
} from '@aeostudio/contracts/privacy-audit';
import { createPrivacyLifecyclePolicy } from '@aeostudio/domain';

import type { InMemoryAuthStore } from '../auth/auth-store.memory.js';
import type { InMemoryChannelAuthorizationStore } from '../channels/in-memory-channel-authorization-store.js';
import type { InMemoryJobBudgetStore } from '../jobs/in-memory-job-budget-store.js';
import type { InMemoryTenancyStore } from '../tenants/in-memory-tenancy-store.js';
import { InMemoryAuditSink } from './in-memory-audit-sink.js';
import type { InMemoryTenantExportArchive } from './in-memory-tenant-export-archive.js';
import type { InMemoryTenantExportSource } from './in-memory-tenant-export-source.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

interface StoredExport {
  exportId: string;
  tenantId: string;
  workspaceId: string;
  requestHash: string;
  manifest: TenantExportManifest;
  checksum: string;
  archiveChecksum: string;
  objectRef: string;
  objectKey: string;
  objectVersionId: string;
  createdAt: string;
}

interface StoredDeletion {
  tenantId: string;
  workspaceId: string;
  requestHash: string;
  receipt: TenantDeletionReceipt;
  state:
    'FROZEN' | 'ACTIVE_DATA_DELETED' | 'BLOCKED_BY_LEGAL_HOLD' | 'BACKUP_DELETED' | 'TOMBSTONED';
  pendingExportObjects: Array<{
    tenantId: string;
    objectKey: string;
    objectVersionId: string;
  }>;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
}

interface StoredSecretDeletion {
  tenantId: string;
  workspaceId: string;
  channelAuthorizationId: string;
  deletionRequestId: string;
  secretReference: string | null;
  secretReferenceHash: string | null;
  forceDeleteAt: string;
  state: 'REVOKED_PENDING_FORCE_DELETE' | 'FORCE_DELETE_REQUESTED' | 'VERIFIED_UNREADABLE';
  leaseToken: string | null;
  leaseExpiresAt: string | null;
}

interface StoredLegalHold {
  hold: TenantVisibleLegalHold;
  bucket: 'EXPORT' | 'AUDIT';
  workspaceId: string;
}

export interface InMemoryPrivacyAuditStoreOptions {
  auth: InMemoryAuthStore;
  tenancy: InMemoryTenancyStore;
  jobs: InMemoryJobBudgetStore;
  authorizations: InMemoryChannelAuthorizationStore;
  objects: FakePrivacyObjectStorage;
  secrets: InMemorySecretLifecycleStore;
  clock: { now(): Date };
  audit?: InMemoryAuditSink;
  exportSources?: readonly InMemoryTenantExportSource[];
}

/**
 * Explicit test/development composition for Task 17. It shares the same mutable
 * Auth, Tenancy, Jobs and Channel Authorization stores as the rest of the API so
 * the deletion request is the real lifecycle boundary, not a disconnected demo.
 */
export class InMemoryPrivacyAuditStore implements PrivacyAuditStore, InMemoryTenantExportArchive {
  private readonly exports = new Map<string, StoredExport>();
  private readonly deletions = new Map<string, StoredDeletion>();
  private readonly secretDeletions = new Map<string, StoredSecretDeletion>();
  private readonly legalHolds = new Map<string, StoredLegalHold>();
  private readonly legalHoldCreations = new Map<
    string,
    {
      fingerprint: string;
      result: ReturnType<PrivacyAuditStore['createLegalHold']>;
    }
  >();
  private readonly breakGlass = new Map<string, BreakGlassGrantRecord>();
  private readonly auditSink: InMemoryAuditSink;
  private readonly digests = new Map<string, AuditDigest>();
  private readonly digestWorkspaces = new Map<string, string>();
  private readonly auditDigestSeals = new Map<
    string,
    ReturnType<PrivacyAuditStore['sealAuditDigest']>
  >();
  private readonly auditDigestIds = new Map<
    string,
    {
      sealKey: string;
      result: ReturnType<PrivacyAuditStore['sealAuditDigest']>;
    }
  >();
  private readonly importedTenancyAudit = new Set<string>();
  private readonly tenantExportSaves = new Map<
    string,
    {
      checksum: string;
      result: ReturnType<PrivacyAuditStore['saveTenantExport']>;
    }
  >();

  public constructor(private readonly options: InMemoryPrivacyAuditStoreOptions) {
    this.auditSink = options.audit ?? new InMemoryAuditSink(options.clock);
  }

  public async loadTenantExportObjects(
    input: Parameters<PrivacyAuditStore['loadTenantExportObjects']>[0],
  ): ReturnType<PrivacyAuditStore['loadTenantExportObjects']> {
    if (!this.tenantExportContextIsCurrent(input.context)) {
      return { outcome: 'NOT_FOUND' };
    }
    this.syncTenancyAudit(input.context.tenantId);
    const objects: TenantExportSourceObject[] = [
      ...this.auditSink
        .listTenant(input.context.tenantId)
        .filter((event) => {
          const occurredAt = Date.parse(event.occurredAt);
          return occurredAt >= input.from.getTime() && occurredAt <= input.to.getTime();
        })
        .map<TenantExportSourceObject>((event) => ({
          tenantId: event.tenantId,
          workspaceId: event.workspaceId,
          kind: 'AUDIT_EVENT',
          objectId: event.id,
          occurredAt: event.occurredAt,
          payload: {
            tenantId: event.tenantId,
            workspaceId: event.workspaceId,
            action: event.action,
            resourceType: event.resourceType,
            resourceId: event.resourceId,
            outcome: event.outcome,
            occurredAt: event.occurredAt,
          },
        })),
    ];
    for (const source of this.options.exportSources ?? []) {
      const sourceObjects = await source.listTenantExportObjects({
        tenantId: input.context.tenantId,
        from: input.from,
        to: input.to,
      });
      if (!this.tenantExportContextIsCurrent(input.context)) {
        return { outcome: 'NOT_FOUND' };
      }
      if (
        sourceObjects.some(
          (object) =>
            object.tenantId !== input.context.tenantId ||
            (object.workspaceId !== null &&
              this.options.tenancy.getWorkspaceLifecycleState({
                tenantId: input.context.tenantId,
                workspaceId: object.workspaceId,
              }) !== 'ACTIVE'),
        )
      ) {
        return { outcome: 'PIPELINE_UNAVAILABLE' };
      }
      objects.push(...sourceObjects);
    }
    objects.sort((left, right) =>
      `${left.kind}:${left.objectId}`.localeCompare(`${right.kind}:${right.objectId}`),
    );
    return { outcome: 'SUCCEEDED', objects };
  }

  public saveTenantExport(
    input: Parameters<PrivacyAuditStore['saveTenantExport']>[0],
  ): ReturnType<PrivacyAuditStore['saveTenantExport']> {
    if (!this.tenantExportContextIsCurrent(input.context)) {
      return Promise.resolve({ outcome: 'PIPELINE_UNAVAILABLE' });
    }
    const saveKey = `${input.context.tenantId}:${input.requestHash}`;
    const inFlight = this.tenantExportSaves.get(saveKey);
    if (inFlight !== undefined) {
      if (inFlight.checksum !== input.checksum) {
        return Promise.resolve({ outcome: 'IDEMPOTENCY_CONFLICT' });
      }
      return inFlight.result.then((result) => {
        if (!this.tenantExportContextIsCurrent(input.context)) {
          return { outcome: 'PIPELINE_UNAVAILABLE' as const };
        }
        return result.outcome === 'SUCCEEDED' ? { ...result, created: false } : result;
      });
    }
    const save = this.persistTenantExport(input);
    const tracked = save.finally(() => {
      if (this.tenantExportSaves.get(saveKey)?.result === tracked) {
        this.tenantExportSaves.delete(saveKey);
      }
    });
    this.tenantExportSaves.set(saveKey, { checksum: input.checksum, result: tracked });
    return tracked;
  }

  private async persistTenantExport(
    input: Parameters<PrivacyAuditStore['saveTenantExport']>[0],
  ): ReturnType<PrivacyAuditStore['saveTenantExport']> {
    if (!this.tenantExportContextIsCurrent(input.context)) {
      return { outcome: 'PIPELINE_UNAVAILABLE' };
    }
    const conflicting = [...this.exports.values()].find(
      (stored) =>
        stored.tenantId === input.context.tenantId && stored.requestHash === input.requestHash,
    );
    if (conflicting !== undefined) {
      if (conflicting.checksum !== input.checksum) return { outcome: 'IDEMPOTENCY_CONFLICT' };
      return {
        outcome: 'SUCCEEDED',
        exportId: conflicting.exportId,
        created: false,
        archiveStatus: 'READY',
        archiveReady: true,
        objectRef: conflicting.objectRef,
        createdAt: conflicting.createdAt,
      };
    }
    const parsedManifest = TenantExportManifestSchema.safeParse(input.manifest);
    if (
      !parsedManifest.success ||
      parsedManifest.data.tenantId !== input.context.tenantId ||
      canonicalPrivacyJson(parsedManifest.data) !== canonicalPrivacyJson(input.manifest) ||
      privacySha256(canonicalPrivacyJson(input.manifest)) !== input.checksum ||
      !canonicalFilesMatchManifest(input.canonicalFiles, parsedManifest.data)
    ) {
      return { outcome: 'PIPELINE_UNAVAILABLE' };
    }
    const body = new TextEncoder().encode(
      canonicalPrivacyJson({
        schemaVersion: 'tenant-export-bundle.v1',
        manifest: input.manifest,
        files: input.canonicalFiles.map((file) => ({
          path: file.path,
          contentHash: file.contentHash,
          byteLength: file.byteLength,
          content: JSON.parse(file.content) as unknown,
        })),
      }),
    );
    const objectKey = `tenants/${input.context.tenantId}/exports/${input.exportId}.bundle.json`;
    const archiveChecksum = privacySha256(body);
    const object = await this.options.objects.putExportVersion({
      tenantId: input.context.tenantId,
      objectKey,
      body,
      contentType: 'application/json',
      checksum: archiveChecksum,
    });
    if (!this.tenantExportContextIsCurrent(input.context)) {
      const discarded = await this.options.objects.deleteExportVersion({
        tenantId: object.tenantId,
        objectKey: object.objectKey,
        objectVersionId: object.objectVersionId,
        at: this.safeNow(),
      });
      if (discarded.outcome !== 'DELETED' && discarded.outcome !== 'NOT_FOUND') {
        throw new Error('UNPUBLISHED_TENANT_EXPORT_DISCARD_FAILED');
      }
      return { outcome: 'PIPELINE_UNAVAILABLE' };
    }
    this.exports.set(input.exportId, {
      exportId: input.exportId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      requestHash: input.requestHash,
      manifest: structuredClone(input.manifest),
      checksum: input.checksum,
      archiveChecksum,
      objectRef: object.objectRef,
      objectKey,
      objectVersionId: object.objectVersionId,
      createdAt: input.createdAt.toISOString(),
    });
    this.appendAudit({
      id: input.auditEventId,
      context: input.context,
      action: 'TENANT_EXPORT_CREATED',
      resourceType: 'TENANT_EXPORT',
      resourceId: input.exportId,
      outcome: 'SUCCEEDED',
      occurredAt: input.createdAt,
      metadata: { checksum: input.checksum, objectKey, objectVersionId: object.objectVersionId },
    });
    return {
      outcome: 'SUCCEEDED',
      exportId: input.exportId,
      created: true,
      archiveStatus: 'READY',
      archiveReady: true,
      objectRef: object.objectRef,
      createdAt: input.createdAt.toISOString(),
    };
  }

  public async readTenantExportArchive(input: {
    sessionToken: string;
    context: Parameters<PrivacyAuditStore['loadTenantExportObjects']>[0]['context'];
    exportId: string;
  }): Promise<{
    body: Uint8Array;
    manifestChecksum: string;
    archiveChecksum: string;
    filename: string;
  } | null> {
    if (!this.tenantExportContextIsCurrent(input.context)) {
      return null;
    }
    const stored = this.exports.get(input.exportId);
    if (stored === undefined || stored.tenantId !== input.context.tenantId) {
      return null;
    }
    const object = await this.options.objects.readExportVersion({
      tenantId: input.context.tenantId,
      objectKey: stored.objectKey,
      objectVersionId: stored.objectVersionId,
    });
    if (
      !this.tenantExportContextIsCurrent(input.context) ||
      object === null ||
      object.object.checksum !== stored.archiveChecksum ||
      privacySha256(object.body) !== stored.archiveChecksum ||
      !archiveManifestMatches(object.body, stored.manifest, stored.checksum)
    ) {
      return null;
    }
    return {
      body: new Uint8Array(object.body),
      manifestChecksum: stored.checksum,
      archiveChecksum: stored.archiveChecksum,
      filename: `tenant-export-${stored.exportId}.json`,
    };
  }

  public getPrivacyOverview(
    input: Parameters<PrivacyAuditStore['getPrivacyOverview']>[0],
  ): ReturnType<PrivacyAuditStore['getPrivacyOverview']> {
    const tenantState = this.options.tenancy.getTenantLifecycleState(input.context.tenantId);
    if (tenantState === null) return Promise.resolve({ outcome: 'NOT_FOUND' });
    this.syncTenancyAudit(input.context.tenantId);
    const deletion = [...this.deletions.values()]
      .filter((entry) => entry.tenantId === input.context.tenantId)
      .sort((left, right) => right.receipt.requestedAt.localeCompare(left.receipt.requestedAt))[0];
    const legalHolds = [...this.legalHolds.values()]
      .map(({ hold }) => hold)
      .filter((hold) => hold.tenantId === input.context.tenantId && hold.releasedAt === null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const breakGlassGrants = [...this.breakGlass.values()]
      .filter((grant) => grant.tenantId === input.context.tenantId)
      .sort((left, right) => right.grantedAt.localeCompare(left.grantedAt));
    const latestAuditEventAt =
      this.auditSink.listTenant(input.context.tenantId).at(-1)?.occurredAt ?? null;
    return Promise.resolve({
      outcome: 'SUCCEEDED',
      overview: {
        tenantId: input.context.tenantId,
        lifecycleState: deletion === undefined ? tenantState : 'DELETION_IN_PROGRESS',
        retention: {
          activeTenantDataDays: 30,
          backupCopyDays: 90,
          secretForceDeleteHours: 24,
          rawEvidenceDays: 180,
          screenshotDays: 90,
          applicationLogDays: 30,
          auditEvidenceDays: 365,
        },
        legalHolds: structuredClone(legalHolds),
        breakGlassGrants: structuredClone(breakGlassGrants),
        latestAuditEventAt,
        latestDeletionReceipt: deletion === undefined ? null : structuredClone(deletion.receipt),
      },
    });
  }

  public listAuditEvents(
    input: Parameters<PrivacyAuditStore['listAuditEvents']>[0],
  ): ReturnType<PrivacyAuditStore['listAuditEvents']> {
    if (this.options.tenancy.getTenantLifecycleState(input.context.tenantId) === null) {
      return Promise.resolve({ outcome: 'NOT_FOUND' });
    }
    this.syncTenancyAudit(input.context.tenantId);
    const cursorSequence = input.cursor === null ? Number.POSITIVE_INFINITY : Number(input.cursor);
    if (!Number.isSafeInteger(cursorSequence) && cursorSequence !== Number.POSITIVE_INFINITY) {
      return Promise.resolve({ outcome: 'NOT_FOUND' });
    }
    const eligible = this.auditSink
      .listTenant(input.context.tenantId)
      .filter(
        (event) =>
          (event.workspaceId === null || event.workspaceId === input.context.workspaceId) &&
          Date.parse(event.occurredAt) >= input.from.getTime() &&
          Date.parse(event.occurredAt) <= input.to.getTime() &&
          event.sequence < cursorSequence,
      )
      .sort((left, right) => right.sequence - left.sequence);
    const events = eligible.slice(0, input.limit);
    return Promise.resolve({
      outcome: 'SUCCEEDED',
      timeline: {
        events: structuredClone(events),
        nextCursor:
          eligible.length > events.length && events.length > 0
            ? String(events.at(-1)?.sequence)
            : null,
      },
    });
  }

  public requestTenantDeletion(
    input: Parameters<PrivacyAuditStore['requestTenantDeletion']>[0],
  ): ReturnType<PrivacyAuditStore['requestTenantDeletion']> {
    return this.requestDeletion('TENANT', input);
  }

  public requestWorkspaceDeletion(
    input: Parameters<PrivacyAuditStore['requestWorkspaceDeletion']>[0],
  ): ReturnType<PrivacyAuditStore['requestWorkspaceDeletion']> {
    return this.requestDeletion('WORKSPACE', input);
  }

  public async finalizeDeletion(
    input: Parameters<PrivacyAuditStore['finalizeDeletion']>[0],
  ): ReturnType<PrivacyAuditStore['finalizeDeletion']> {
    const deletion = this.deletions.get(input.requestId);
    if (deletion === undefined) return { outcome: 'NOT_FOUND' };
    const now = this.safeNow();
    const effectiveAt = input.effectiveAt.getTime();
    const leaseExpiresAt = Date.parse(deletion.leaseExpiresAt ?? '');
    if (!Number.isFinite(effectiveAt) || effectiveAt > now.getTime()) {
      return { outcome: 'NOT_DUE' };
    }
    if (
      deletion.leaseToken !== input.leaseToken ||
      !Number.isFinite(leaseExpiresAt) ||
      leaseExpiresAt < now.getTime()
    ) {
      return { outcome: 'INVALID_LEASE' };
    }
    let state: 'ACTIVE_DATA_DELETED' | 'BACKUP_DELETED' | 'TOMBSTONED';
    if (deletion.state === 'FROZEN') {
      if (
        now.getTime() < Date.parse(deletion.receipt.activeDeleteBy) ||
        this.hasUnverifiedSecretDeletion(deletion)
      ) {
        return { outcome: 'NOT_DUE' };
      }
      this.captureTenantExportObjectsForDeletion(deletion);
      state = 'ACTIVE_DATA_DELETED';
    } else if (
      deletion.state === 'ACTIVE_DATA_DELETED' ||
      deletion.state === 'BLOCKED_BY_LEGAL_HOLD'
    ) {
      if (now.getTime() < Date.parse(deletion.receipt.backupDeleteBy)) {
        return { outcome: 'NOT_DUE' };
      }
      const retained: StoredDeletion['pendingExportObjects'] = [];
      let heldObjectCount = 0;
      let cleanupFailed = false;
      for (const object of deletion.pendingExportObjects) {
        const result = await this.options.objects.deleteExportVersion({
          tenantId: object.tenantId,
          objectKey: object.objectKey,
          objectVersionId: object.objectVersionId,
          at: now,
        });
        if (result.outcome === 'LEGAL_HOLD') {
          retained.push(object);
          heldObjectCount += 1;
        } else if (result.outcome !== 'DELETED' && result.outcome !== 'NOT_FOUND') {
          retained.push(object);
          cleanupFailed = true;
        }
      }
      deletion.pendingExportObjects = retained;
      if (cleanupFailed) {
        deletion.leaseToken = null;
        deletion.leaseExpiresAt = null;
        return { outcome: 'PIPELINE_UNAVAILABLE' };
      }
      if (heldObjectCount > 0) {
        const firstBlock = deletion.state !== 'BLOCKED_BY_LEGAL_HOLD';
        deletion.state = 'BLOCKED_BY_LEGAL_HOLD';
        deletion.leaseToken = null;
        deletion.leaseExpiresAt = null;
        if (firstBlock) {
          this.auditSink.append({
            id: input.auditEventId,
            tenantId: deletion.tenantId,
            workspaceId: deletion.workspaceId,
            actorKind: 'SYSTEM',
            actorId: 'privacy-lifecycle-worker',
            action: 'DELETION_BACKUP_BLOCKED_BY_LEGAL_HOLD',
            resourceType: 'DELETION_REQUEST',
            resourceId: input.requestId,
            outcome: 'FAILED',
            metadata: { heldObjectCount },
            occurredAt: now,
          });
        }
        return { outcome: 'LEGAL_HOLD' };
      }
      state = 'BACKUP_DELETED';
    } else if (deletion.state === 'BACKUP_DELETED') {
      state = 'TOMBSTONED';
    } else {
      return { outcome: 'INVALID_LEASE' };
    }
    deletion.state = state;
    deletion.leaseToken = null;
    deletion.leaseExpiresAt = null;
    this.auditSink.append({
      id: input.auditEventId,
      tenantId: deletion.tenantId,
      workspaceId: deletion.workspaceId,
      actorKind: 'SYSTEM',
      actorId: 'privacy-lifecycle-worker',
      action:
        state === 'ACTIVE_DATA_DELETED'
          ? 'DELETION_ACTIVE_DATA_COMPLETED'
          : state === 'BACKUP_DELETED'
            ? 'DELETION_BACKUP_COMPLETED'
            : 'DELETION_TOMBSTONED',
      resourceType: 'DELETION_REQUEST',
      resourceId: input.requestId,
      outcome: 'SUCCEEDED',
      metadata: { state },
      occurredAt: now,
    });
    return {
      outcome: 'SUCCEEDED',
      finalization: {
        requestId: input.requestId,
        state,
        effectiveAt: now.toISOString(),
        tombstoneId: state === 'TOMBSTONED' ? input.tombstoneId : null,
      },
    };
  }

  public claimDueDeletionRequests(
    input: Parameters<PrivacyAuditStore['claimDueDeletionRequests']>[0],
  ): ReturnType<PrivacyAuditStore['claimDueDeletionRequests']> {
    this.validateClaimInput(input.leaseToken, input.limit);
    const now = this.safeNow();
    const claims = [...this.deletions.values()]
      .filter((deletion) => {
        const leaseAvailable =
          deletion.leaseExpiresAt === null || Date.parse(deletion.leaseExpiresAt) <= now.getTime();
        if (!leaseAvailable) return false;
        if (deletion.state === 'FROZEN') {
          return (
            Date.parse(deletion.receipt.activeDeleteBy) <= now.getTime() &&
            !this.hasUnverifiedSecretDeletion(deletion)
          );
        }
        if (
          deletion.state === 'ACTIVE_DATA_DELETED' ||
          deletion.state === 'BLOCKED_BY_LEGAL_HOLD'
        ) {
          if (
            deletion.state === 'BLOCKED_BY_LEGAL_HOLD' &&
            this.hasActiveHoldForPendingExport(deletion)
          ) {
            return false;
          }
          return Date.parse(deletion.receipt.backupDeleteBy) <= now.getTime();
        }
        return deletion.state === 'BACKUP_DELETED';
      })
      .sort((left, right) => left.receipt.id.localeCompare(right.receipt.id))
      .slice(0, input.limit);
    const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1_000).toISOString();
    return Promise.resolve(
      claims.map((deletion) => {
        deletion.leaseToken = input.leaseToken;
        deletion.leaseExpiresAt = leaseExpiresAt;
        return {
          requestId: deletion.receipt.id,
          stage:
            deletion.state === 'FROZEN'
              ? ('ACTIVE' as const)
              : deletion.state === 'ACTIVE_DATA_DELETED' ||
                  deletion.state === 'BLOCKED_BY_LEGAL_HOLD'
                ? ('BACKUP' as const)
                : ('TOMBSTONE' as const),
          leaseToken: input.leaseToken,
          leaseExpiresAt,
        };
      }),
    );
  }

  public claimDueSecretDeletions(
    input: Parameters<PrivacyAuditStore['claimDueSecretDeletions']>[0],
  ): ReturnType<PrivacyAuditStore['claimDueSecretDeletions']> {
    this.validateClaimInput(input.leaseToken, input.limit);
    const now = this.safeNow();
    const claims = [...this.secretDeletions.values()]
      .filter(
        (secret) =>
          secret.state !== 'VERIFIED_UNREADABLE' &&
          secret.secretReference !== null &&
          (secret.leaseExpiresAt === null || Date.parse(secret.leaseExpiresAt) <= now.getTime()),
      )
      .sort(
        (left, right) =>
          left.forceDeleteAt.localeCompare(right.forceDeleteAt) ||
          left.channelAuthorizationId.localeCompare(right.channelAuthorizationId),
      )
      .slice(0, input.limit);
    const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1_000).toISOString();
    return Promise.resolve(
      claims.map((secret) => {
        if (secret.secretReference === null) {
          throw new Error('SECRET_DELETION_REFERENCE_MISSING');
        }
        if (secret.state === 'VERIFIED_UNREADABLE') {
          throw new Error('SECRET_DELETION_ALREADY_VERIFIED');
        }
        secret.leaseToken = input.leaseToken;
        secret.leaseExpiresAt = leaseExpiresAt;
        return {
          tenantId: secret.tenantId,
          workspaceId: secret.workspaceId,
          channelAuthorizationId: secret.channelAuthorizationId,
          deletionRequestId: secret.deletionRequestId,
          secretReference: secret.secretReference,
          forceDeleteAt: secret.forceDeleteAt,
          state: secret.state,
          leaseToken: input.leaseToken,
          leaseExpiresAt,
        };
      }),
    );
  }

  public markSecretDeletionRequested(
    input: Parameters<PrivacyAuditStore['markSecretDeletionRequested']>[0],
  ): ReturnType<PrivacyAuditStore['markSecretDeletionRequested']> {
    const secret = this.findLeasedSecret(input);
    if (secret === null || secret.state === 'VERIFIED_UNREADABLE') return Promise.resolve(false);
    secret.state = 'FORCE_DELETE_REQUESTED';
    return Promise.resolve(true);
  }

  public markSecretUnreadable(
    input: Parameters<PrivacyAuditStore['markSecretUnreadable']>[0],
  ): ReturnType<PrivacyAuditStore['markSecretUnreadable']> {
    const secret = this.findLeasedSecret(input);
    if (secret === null || secret.state === 'VERIFIED_UNREADABLE') return Promise.resolve(false);
    secret.state = 'VERIFIED_UNREADABLE';
    if (secret.secretReference !== null) {
      secret.secretReferenceHash = privacySha256(secret.secretReference);
      secret.secretReference = null;
    }
    secret.leaseToken = null;
    secret.leaseExpiresAt = null;
    return Promise.resolve(true);
  }

  public async createLegalHold(
    input: Parameters<PrivacyAuditStore['createLegalHold']>[0],
  ): ReturnType<PrivacyAuditStore['createLegalHold']> {
    const existing = this.legalHolds.get(input.holdId);
    if (existing !== undefined) {
      const exactReplay =
        existing.hold.tenantId === input.context.tenantId &&
        existing.workspaceId === input.context.workspaceId &&
        existing.hold.name === input.name &&
        existing.hold.reason === input.reason &&
        existing.hold.target.objectKey === input.objectKey &&
        existing.hold.target.objectVersionId === input.objectVersionId;
      return exactReplay
        ? {
            outcome: 'SUCCEEDED',
            hold: structuredClone(existing.hold),
            created: false,
          }
        : { outcome: 'IDEMPOTENCY_CONFLICT' };
    }
    const fingerprint = canonicalPrivacyJson({
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      name: input.name,
      reason: input.reason,
      objectKey: input.objectKey,
      objectVersionId: input.objectVersionId,
    });
    const inFlight = this.legalHoldCreations.get(input.holdId);
    if (inFlight !== undefined) {
      if (inFlight.fingerprint !== fingerprint) return { outcome: 'IDEMPOTENCY_CONFLICT' };
      const joined = await inFlight.result;
      return joined.outcome === 'SUCCEEDED'
        ? { ...joined, hold: structuredClone(joined.hold), created: false }
        : joined;
    }
    const creation = this.performLegalHoldCreation(input);
    const tracked = creation.finally(() => {
      if (this.legalHoldCreations.get(input.holdId)?.result === tracked) {
        this.legalHoldCreations.delete(input.holdId);
      }
    });
    this.legalHoldCreations.set(input.holdId, { fingerprint, result: tracked });
    return tracked;
  }

  private async performLegalHoldCreation(
    input: Parameters<PrivacyAuditStore['createLegalHold']>[0],
  ): ReturnType<PrivacyAuditStore['createLegalHold']> {
    const target = {
      tenantId: input.context.tenantId,
      objectKey: input.objectKey,
      objectVersionId: input.objectVersionId,
    };
    const exportObject = await this.options.objects.readExportVersion(target);
    const auditObject =
      exportObject === null ? await this.options.objects.readAuditVersion(target) : null;
    const bucket = exportObject === null ? (auditObject === null ? null : 'AUDIT') : 'EXPORT';
    if (bucket === null) return { outcome: 'OBJECT_NOT_FOUND' };
    if (
      bucket === 'EXPORT' &&
      ![...this.exports.values()].some(
        (stored) =>
          stored.tenantId === input.context.tenantId &&
          stored.workspaceId === input.context.workspaceId &&
          stored.objectKey === input.objectKey &&
          stored.objectVersionId === input.objectVersionId,
      )
    ) {
      return { outcome: 'OBJECT_NOT_FOUND' };
    }
    if (
      bucket === 'AUDIT' &&
      ![...this.digests.values()].some(
        (digest) =>
          digest.tenantId === input.context.tenantId &&
          this.digestWorkspaces.get(digest.id) === input.context.workspaceId &&
          digest.objectKey === input.objectKey &&
          digest.objectVersionId === input.objectVersionId,
      )
    ) {
      return { outcome: 'OBJECT_NOT_FOUND' };
    }
    const held =
      bucket === 'EXPORT'
        ? await this.options.objects.holdExportVersion({ ...target, holdId: input.holdId })
        : await this.options.objects.holdAuditVersion({ ...target, holdId: input.holdId });
    if (!held) return { outcome: 'OBJECT_NOT_FOUND' };
    const hold: TenantVisibleLegalHold = {
      id: input.holdId,
      tenantId: input.context.tenantId,
      name: input.name,
      reason: input.reason,
      createdBy: input.context.actorUserId,
      visibleToTenant: true,
      target: { objectKey: input.objectKey, objectVersionId: input.objectVersionId },
      createdAt: input.createdAt.toISOString(),
      releasedAt: null,
    };
    this.legalHolds.set(input.holdId, {
      hold,
      bucket,
      workspaceId: input.context.workspaceId,
    });
    this.appendAudit({
      id: input.auditEventId,
      context: input.context,
      action: 'LEGAL_HOLD_CREATED',
      resourceType: 'LEGAL_HOLD',
      resourceId: input.holdId,
      outcome: 'SUCCEEDED',
      occurredAt: input.createdAt,
      metadata: { objectKey: input.objectKey, objectVersionId: input.objectVersionId },
    });
    return { outcome: 'SUCCEEDED', hold: structuredClone(hold), created: true };
  }

  public listLegalHolds(
    input: Parameters<PrivacyAuditStore['listLegalHolds']>[0],
  ): ReturnType<PrivacyAuditStore['listLegalHolds']> {
    return Promise.resolve(
      [...this.legalHolds.values()]
        .map(({ hold }) => hold)
        .filter(
          (hold) =>
            hold.tenantId === input.context.tenantId &&
            (input.includeReleased || hold.releasedAt === null),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((hold) => structuredClone(hold)),
    );
  }

  public async releaseLegalHold(
    input: Parameters<PrivacyAuditStore['releaseLegalHold']>[0],
  ): ReturnType<PrivacyAuditStore['releaseLegalHold']> {
    const stored = this.legalHolds.get(input.holdId);
    if (
      stored === undefined ||
      stored.hold.tenantId !== input.context.tenantId ||
      stored.workspaceId !== input.context.workspaceId
    ) {
      return { outcome: 'NOT_FOUND' };
    }
    if (stored.hold.releasedAt !== null) {
      return { outcome: 'SUCCEEDED', hold: structuredClone(stored.hold) };
    }
    const target = {
      tenantId: input.context.tenantId,
      objectKey: stored.hold.target.objectKey,
      objectVersionId: stored.hold.target.objectVersionId,
      holdId: input.holdId,
    };
    const released =
      stored.bucket === 'EXPORT'
        ? await this.options.objects.releaseExportVersionHold(target)
        : await this.options.objects.releaseAuditVersionHold(target);
    if (!released) return { outcome: 'NOT_FOUND' };
    stored.hold.releasedAt = input.releasedAt.toISOString();
    this.appendAudit({
      id: input.auditEventId,
      context: input.context,
      action: 'LEGAL_HOLD_RELEASED',
      resourceType: 'LEGAL_HOLD',
      resourceId: input.holdId,
      outcome: 'SUCCEEDED',
      occurredAt: input.releasedAt,
      metadata: {
        objectKey: stored.hold.target.objectKey,
        objectVersionId: stored.hold.target.objectVersionId,
      },
    });
    return { outcome: 'SUCCEEDED', hold: structuredClone(stored.hold) };
  }

  public grantBreakGlass(
    input: Parameters<PrivacyAuditStore['grantBreakGlass']>[0],
  ): ReturnType<PrivacyAuditStore['grantBreakGlass']> {
    if (!this.scopeIsActive(input.tenantId, input.workspaceId)) {
      return Promise.resolve({ outcome: 'NOT_FOUND' });
    }
    const existing = this.breakGlass.get(input.grantId);
    if (existing !== undefined) {
      return Promise.resolve(
        existing.tenantId === input.tenantId &&
          existing.workspaceId === input.workspaceId &&
          existing.operatorId === input.operatorId &&
          existing.operatorName === input.operatorName &&
          existing.reason === input.reason &&
          existing.expiresAt === input.expiresAt.toISOString() &&
          existing.requestedAction === input.requestedAction &&
          existing.resourceType === input.resourceType &&
          existing.resourceId === input.resourceId &&
          existing.auditEventId === input.auditEventId
          ? { outcome: 'SUCCEEDED', grant: structuredClone(existing), created: false }
          : { outcome: 'IDEMPOTENCY_CONFLICT' },
      );
    }
    const grantedAt = this.safeNow();
    const grant: BreakGlassGrantRecord = {
      id: input.grantId,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      operatorId: input.operatorId,
      operatorName: input.operatorName,
      reason: input.reason,
      auditEventId: input.auditEventId,
      requestedAction: input.requestedAction,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      grantedAt: grantedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      revokedAt: null,
    };
    this.breakGlass.set(input.grantId, grant);
    this.appendAudit({
      id: input.auditEventId,
      context: {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        actorUserId: input.operatorId,
      },
      actorKind: 'PLATFORM_OPERATOR',
      action: 'BREAK_GLASS_GRANTED',
      resourceType: 'BREAK_GLASS_GRANT',
      resourceId: input.grantId,
      outcome: 'SUCCEEDED',
      occurredAt: grantedAt,
      metadata: {
        operatorId: input.operatorId,
        operatorName: input.operatorName,
        expiresAt: input.expiresAt.toISOString(),
        reasonHash: privacySha256(input.reason),
        requestedAction: input.requestedAction,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      },
    });
    return Promise.resolve({ outcome: 'SUCCEEDED', grant: structuredClone(grant), created: true });
  }

  public evaluateBreakGlassAccess(
    input: Parameters<PrivacyAuditStore['evaluateBreakGlassAccess']>[0],
  ): ReturnType<PrivacyAuditStore['evaluateBreakGlassAccess']> {
    const grant = this.breakGlass.get(input.grantId);
    const exactBinding =
      grant !== undefined &&
      this.scopeIsActive(input.tenantId, input.workspaceId) &&
      input.operatorId !== null &&
      input.operatorName !== null &&
      grant.tenantId === input.tenantId &&
      grant.workspaceId === input.workspaceId &&
      grant.operatorId === input.operatorId &&
      grant.operatorName === input.operatorName &&
      grant.requestedAction === input.requestedAction &&
      grant.resourceType === input.resourceType &&
      grant.resourceId === input.resourceId;
    const policyGrant =
      grant === undefined
        ? {}
        : {
            id: grant.id,
            tenantId: grant.tenantId,
            workspaceId: grant.workspaceId,
            operatorId: grant.operatorId,
            operatorName: grant.operatorName,
            reason: grant.reason,
            auditEventId: grant.auditEventId,
            requestedAction: grant.requestedAction,
            resourceType: grant.resourceType,
            resourceId: grant.resourceId,
            grantedAt: grant.grantedAt,
            expiresAt: grant.expiresAt,
            ...(grant.revokedAt === null ? {} : { revokedAt: grant.revokedAt }),
          };
    const evaluated = exactBinding
      ? createPrivacyLifecyclePolicy({ clock: this.options.clock }).evaluateBreakGlassAccess({
          grant: policyGrant,
          workspaceId: input.workspaceId,
          requestedAction: input.requestedAction,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
        })
      : {
          decision: 'DENY' as const,
          state: 'INVALID_GRANT' as const,
          grantId: null,
          operatorName: null,
          reason: null,
          auditEventId: null,
        };
    const decision: BreakGlassDecisionRecord = {
      ...evaluated,
      auditEventId: input.auditEventId,
    };
    const supportPrincipal = input.actorSubject.trim();
    this.appendAudit({
      id: input.auditEventId,
      context: {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        actorUserId:
          input.operatorId ??
          (supportPrincipal.length >= 1 && supportPrincipal.length <= 240
            ? supportPrincipal
            : 'unknown-break-glass-principal'),
      },
      actorKind: input.operatorId === null ? 'SUPPORT' : 'PLATFORM_OPERATOR',
      action:
        decision.decision === 'ALLOW' ? 'BREAK_GLASS_ACCESS_ALLOWED' : 'BREAK_GLASS_ACCESS_DENIED',
      resourceType: 'BREAK_GLASS_GRANT',
      resourceId: input.grantId,
      outcome: decision.decision === 'ALLOW' ? 'SUCCEEDED' : 'DENIED',
      occurredAt: this.safeNow(),
      metadata: {
        workspaceId: input.workspaceId,
        requestedAction: input.requestedAction,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        state: decision.state,
      },
    });
    return Promise.resolve(decision);
  }

  public revokeBreakGlass(
    input: Parameters<PrivacyAuditStore['revokeBreakGlass']>[0],
  ): ReturnType<PrivacyAuditStore['revokeBreakGlass']> {
    const grant = this.breakGlass.get(input.grantId);
    if (
      grant === undefined ||
      grant.tenantId !== input.tenantId ||
      grant.workspaceId !== input.workspaceId
    ) {
      return Promise.resolve({ outcome: 'NOT_FOUND' });
    }
    if (grant.revokedAt === null) {
      const revokedAt = this.safeNow();
      grant.revokedAt = revokedAt.toISOString();
      this.appendAudit({
        id: input.auditEventId,
        context: {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          actorUserId: input.operatorId,
        },
        actorKind: 'PLATFORM_OPERATOR',
        action: 'BREAK_GLASS_REVOKED',
        resourceType: 'BREAK_GLASS_GRANT',
        resourceId: input.grantId,
        outcome: 'SUCCEEDED',
        occurredAt: revokedAt,
        metadata: {
          operatorId: input.operatorId,
          operatorName: input.operatorName,
          grantOperatorId: grant.operatorId,
        },
      });
    }
    return Promise.resolve({ outcome: 'SUCCEEDED', grant: structuredClone(grant) });
  }

  public verifyAuditChain(
    input: Parameters<PrivacyAuditStore['verifyAuditChain']>[0],
  ): Promise<AuditIntegrityVerification> {
    this.syncTenancyAudit(input.context.tenantId);
    return Promise.resolve(this.auditSink.verifyTenant(input.context.tenantId));
  }

  public verifyAuditRange(
    input: Parameters<PrivacyAuditStore['verifyAuditRange']>[0],
  ): Promise<AuditIntegrityVerification> {
    this.syncTenancyAudit(input.context.tenantId);
    const chain = this.auditSink.verifyTenant(input.context.tenantId);
    if (!chain.valid) {
      return Promise.resolve({
        valid: false,
        eventCount: 0,
        lastSequence: 0,
        headHash: null,
        reason: chain.reason ?? 'Audit chain verification failed before range summarization.',
      });
    }
    const from = input.from.getTime();
    const to = input.to.getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      return Promise.resolve({
        valid: false,
        eventCount: 0,
        lastSequence: 0,
        headHash: null,
        reason: 'Audit range is invalid.',
      });
    }
    const selected = this.auditSink.listTenant(input.context.tenantId).filter((event) => {
      const occurredAt = Date.parse(event.occurredAt);
      return occurredAt >= from && occurredAt <= to;
    });
    const last = selected.at(-1);
    return Promise.resolve({
      valid: true,
      eventCount: selected.length,
      lastSequence: last?.sequence ?? 0,
      headHash: last?.eventHash ?? null,
      reason: null,
    });
  }

  public async sealAuditDigest(
    input: Parameters<PrivacyAuditStore['sealAuditDigest']>[0],
  ): ReturnType<PrivacyAuditStore['sealAuditDigest']> {
    if (!this.tenantExportContextIsCurrent(input.context)) {
      return { outcome: 'PIPELINE_UNAVAILABLE' };
    }
    const sealedAt = this.safeNow();
    if (
      !Number.isFinite(input.from.getTime()) ||
      !Number.isFinite(input.to.getTime()) ||
      input.from.getTime() > input.to.getTime() ||
      input.to.getTime() >= sealedAt.getTime()
    ) {
      return { outcome: 'INVALID_TIME_RANGE' };
    }
    const normalizedRange = {
      from: input.from.toISOString(),
      to: input.to.toISOString(),
    };
    const existingById = this.digests.get(input.digestId);
    if (
      existingById !== undefined &&
      (existingById.tenantId !== input.context.tenantId ||
        existingById.timeRange.from !== normalizedRange.from ||
        existingById.timeRange.to !== normalizedRange.to)
    ) {
      return { outcome: 'IDEMPOTENCY_CONFLICT' };
    }
    const existing = [...this.digests.values()].find(
      (digest) =>
        digest.tenantId === input.context.tenantId &&
        digest.timeRange.from === normalizedRange.from &&
        digest.timeRange.to === normalizedRange.to,
    );
    if (existing !== undefined) {
      return { outcome: 'SUCCEEDED', digest: structuredClone(existing), created: false };
    }
    const sealKey = `${input.context.tenantId}:${normalizedRange.from}:${normalizedRange.to}`;
    const activeId = this.auditDigestIds.get(input.digestId);
    if (activeId !== undefined) {
      if (activeId.sealKey !== sealKey) return { outcome: 'IDEMPOTENCY_CONFLICT' };
      const joined = await activeId.result;
      if (!this.tenantExportContextIsCurrent(input.context)) {
        return { outcome: 'PIPELINE_UNAVAILABLE' };
      }
      return joined.outcome === 'SUCCEEDED'
        ? { ...joined, digest: structuredClone(joined.digest), created: false }
        : joined;
    }
    const activeSeal = this.auditDigestSeals.get(sealKey);
    if (activeSeal !== undefined) {
      const joined = await activeSeal;
      if (!this.tenantExportContextIsCurrent(input.context)) {
        return { outcome: 'PIPELINE_UNAVAILABLE' };
      }
      return joined.outcome === 'SUCCEEDED'
        ? { ...joined, digest: structuredClone(joined.digest), created: false }
        : joined;
    }
    const seal = this.performAuditDigestSeal(input, sealedAt, normalizedRange);
    this.auditDigestSeals.set(sealKey, seal);
    this.auditDigestIds.set(input.digestId, { sealKey, result: seal });
    try {
      return await seal;
    } finally {
      if (this.auditDigestSeals.get(sealKey) === seal) this.auditDigestSeals.delete(sealKey);
      if (this.auditDigestIds.get(input.digestId)?.result === seal) {
        this.auditDigestIds.delete(input.digestId);
      }
    }
  }

  private async performAuditDigestSeal(
    input: Parameters<PrivacyAuditStore['sealAuditDigest']>[0],
    sealedAt: Date,
    normalizedRange: { from: string; to: string },
  ): ReturnType<PrivacyAuditStore['sealAuditDigest']> {
    const verification = await this.verifyAuditRange({
      context: input.context,
      from: input.from,
      to: input.to,
    });
    if (!verification.valid) {
      return {
        outcome: 'TAMPERED',
        eventCount: verification.eventCount,
        reason: verification.reason ?? 'Audit chain digest verification detected tampering.',
      };
    }
    if (!this.tenantExportContextIsCurrent(input.context)) {
      return { outcome: 'PIPELINE_UNAVAILABLE' };
    }
    const lockedUntil = new Date(sealedAt.getTime() + 365 * 24 * 60 * 60 * 1_000);
    const digestPayload = {
      id: input.digestId,
      tenantId: input.context.tenantId,
      schemaVersion: 'audit-digest.v1' as const,
      timeRange: normalizedRange,
      eventCount: verification.eventCount,
      lastSequence: verification.lastSequence,
      headHash: verification.headHash,
      lockedUntil: lockedUntil.toISOString(),
      sealedAt: sealedAt.toISOString(),
    };
    const digestHash = privacySha256(canonicalPrivacyJson(digestPayload));
    const body = new TextEncoder().encode(
      canonicalPrivacyJson({
        ...digestPayload,
        digestHash,
      }),
    );
    const objectKey = `tenants/${input.context.tenantId}/audit-digests/${input.digestId}.json`;
    const stagedObject = await this.options.objects.stageLockedAuditVersion({
      tenantId: input.context.tenantId,
      objectKey,
      body,
      contentType: 'application/json',
      checksum: privacySha256(body),
      lockedUntil,
    });
    const commitVerification = await this.verifyAuditRange({
      context: input.context,
      from: input.from,
      to: input.to,
    });
    if (!commitVerification.valid) {
      stagedObject.abort();
      return {
        outcome: 'TAMPERED',
        eventCount: commitVerification.eventCount,
        reason: commitVerification.reason ?? 'Audit chain digest verification detected tampering.',
      };
    }
    if (
      commitVerification.eventCount !== verification.eventCount ||
      commitVerification.lastSequence !== verification.lastSequence ||
      commitVerification.headHash !== verification.headHash
    ) {
      stagedObject.abort();
      return { outcome: 'PIPELINE_UNAVAILABLE' };
    }
    if (!this.tenantExportContextIsCurrent(input.context)) {
      stagedObject.abort();
      return { outcome: 'PIPELINE_UNAVAILABLE' };
    }
    const object = stagedObject.commit();
    const digest: AuditDigest = {
      ...digestPayload,
      digestHash,
      objectRef: object.objectRef,
      objectKey,
      objectVersionId: object.objectVersionId,
    };
    this.digests.set(input.digestId, digest);
    this.digestWorkspaces.set(input.digestId, input.context.workspaceId);
    this.appendAudit({
      id: input.auditEventId,
      context: input.context,
      action: 'AUDIT_DIGEST_SEALED',
      resourceType: 'AUDIT_DIGEST',
      resourceId: input.digestId,
      outcome: 'SUCCEEDED',
      occurredAt: sealedAt,
      metadata: {
        digestHash,
        objectKey,
        objectVersionId: object.objectVersionId,
      },
    });
    return { outcome: 'SUCCEEDED', digest: structuredClone(digest), created: true };
  }

  private async requestDeletion(
    scope: 'TENANT' | 'WORKSPACE',
    input: Parameters<PrivacyAuditStore['requestTenantDeletion']>[0],
  ): Promise<RequestDeletionStoreResult> {
    const freeze =
      scope === 'TENANT'
        ? this.options.tenancy.freezeTenant({
            tenantId: input.context.tenantId,
            frozenAt: input.requestedAt,
          })
        : this.options.tenancy.freezeWorkspace({
            tenantId: input.context.tenantId,
            workspaceId: input.context.workspaceId,
            frozenAt: input.requestedAt,
          });
    if (freeze === null) return { outcome: 'NOT_FOUND' };

    if (scope === 'TENANT') {
      this.options.jobs.freezeTenant(input.context.tenantId);
    } else {
      this.options.jobs.freezeWorkspace(input.context.tenantId, input.context.workspaceId);
    }
    const revokedAuthorizations =
      scope === 'TENANT'
        ? this.options.authorizations.revokeTenant(input.context.tenantId, input.requestedAt)
        : this.options.authorizations.revokeWorkspace(
            input.context.tenantId,
            input.context.workspaceId,
            input.requestedAt,
          );
    const forceDeleteAt = new Date(input.requestedAt.getTime() + DAY_MS);
    for (const authorization of revokedAuthorizations) {
      this.secretDeletions.set(
        this.secretDeletionKey(input.context.tenantId, authorization.authorizationId),
        {
          tenantId: input.context.tenantId,
          workspaceId: input.context.workspaceId,
          channelAuthorizationId: authorization.authorizationId,
          deletionRequestId: input.requestId,
          secretReference: authorization.secretArn,
          secretReferenceHash: null,
          forceDeleteAt: forceDeleteAt.toISOString(),
          state: 'REVOKED_PENDING_FORCE_DELETE',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      );
      try {
        await this.options.secrets.revoke({
          tenantId: input.context.tenantId,
          secretReference: authorization.secretArn,
          revokedAt: input.requestedAt,
          forceDeleteAt,
        });
      } catch {
        // Channel authorization revocation is already the publication credential gate.
        // A missing fake secret record cannot restore access and must not unfreeze scope.
      }
    }
    await this.options.auth.revokeSessionsForSubjects(freeze.subjects, input.requestedAt);

    const receipt: TenantDeletionReceipt = {
      id: input.requestId,
      scope,
      state: 'FROZEN',
      requestedAt: input.requestedAt.toISOString(),
      activeDeleteBy: new Date(input.requestedAt.getTime() + 30 * DAY_MS).toISOString(),
      backupDeleteBy: new Date(input.requestedAt.getTime() + 90 * DAY_MS).toISOString(),
      secretForceDeleteBy: forceDeleteAt.toISOString(),
    };
    this.deletions.set(input.requestId, {
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      requestHash: input.requestHash,
      receipt,
      state: 'FROZEN',
      pendingExportObjects: [],
      leaseToken: null,
      leaseExpiresAt: null,
    });
    this.appendAudit({
      id: input.auditEventId,
      context: input.context,
      action: `${scope}_DELETION_REQUESTED`,
      resourceType: scope,
      resourceId: scope === 'TENANT' ? input.context.tenantId : input.context.workspaceId,
      outcome: 'SUCCEEDED',
      occurredAt: input.requestedAt,
      metadata: {
        requestId: input.requestId,
        requestHash: input.requestHash,
        reasonHash: privacySha256(input.reason),
        activeDeleteBy: receipt.activeDeleteBy,
        backupDeleteBy: receipt.backupDeleteBy,
        secretForceDeleteBy: receipt.secretForceDeleteBy,
        revokedSessionCount: freeze.subjects.length,
        revokedConnectorCount: revokedAuthorizations.length,
      },
    });
    return { outcome: 'SUCCEEDED', receipt: structuredClone(receipt), created: true };
  }

  private syncTenancyAudit(tenantId: string): void {
    const now = this.safeNow();
    for (const record of this.options.tenancy.listTenantAuditRecords(tenantId)) {
      const key = `${tenantId}:${record.id}`;
      if (this.importedTenancyAudit.has(key)) continue;
      this.importedTenancyAudit.add(key);
      this.appendAudit({
        id: record.id,
        context: {
          tenantId: record.tenantId,
          workspaceId: record.workspaceId,
          actorUserId: record.actorUserId,
        },
        action: record.action,
        resourceType: record.resourceType,
        resourceId: null,
        outcome: record.outcome,
        occurredAt: now,
        metadata: { source: 'IN_MEMORY_TENANCY_AUDIT' },
      });
    }
  }

  private appendAudit(input: {
    id: string;
    context: { tenantId: string; workspaceId: string; actorUserId: string };
    action: string;
    resourceType: string;
    resourceId: string | null;
    outcome: string;
    occurredAt: Date;
    metadata: Record<string, unknown>;
    actorKind?: AuditTimelineEvent['actorKind'];
  }): void {
    this.auditSink.append({
      id: input.id,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      actorKind: input.actorKind ?? 'USER',
      actorId: input.context.actorUserId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      outcome: input.outcome,
      metadata: input.metadata,
      occurredAt: input.occurredAt,
    });
  }

  private safeNow(): Date {
    const value = this.options.clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error('INVALID_PRIVACY_CLOCK');
    }
    return new Date(value);
  }

  private hasUnverifiedSecretDeletion(deletion: StoredDeletion): boolean {
    return [...this.secretDeletions.values()].some(
      (secret) =>
        secret.deletionRequestId === deletion.receipt.id && secret.state !== 'VERIFIED_UNREADABLE',
    );
  }

  private captureTenantExportObjectsForDeletion(deletion: StoredDeletion): void {
    const captured = new Set(
      deletion.pendingExportObjects.map(
        ({ tenantId, objectKey, objectVersionId }) =>
          `${tenantId}\u0000${objectKey}\u0000${objectVersionId}`,
      ),
    );
    for (const [exportId, stored] of this.exports) {
      // Every archive is tenant-wide. A Workspace-scoped deletion therefore
      // invalidates all archives for that Tenant, regardless of which Workspace
      // initiated the export.
      if (stored.tenantId !== deletion.tenantId) continue;
      const key = `${stored.tenantId}\u0000${stored.objectKey}\u0000${stored.objectVersionId}`;
      if (!captured.has(key)) {
        deletion.pendingExportObjects.push({
          tenantId: stored.tenantId,
          objectKey: stored.objectKey,
          objectVersionId: stored.objectVersionId,
        });
        captured.add(key);
      }
      this.exports.delete(exportId);
    }
  }

  private hasActiveHoldForPendingExport(deletion: StoredDeletion): boolean {
    return deletion.pendingExportObjects.some((object) =>
      [...this.legalHolds.values()].some(
        ({ hold, bucket }) =>
          bucket === 'EXPORT' &&
          hold.tenantId === object.tenantId &&
          hold.releasedAt === null &&
          hold.target.objectKey === object.objectKey &&
          hold.target.objectVersionId === object.objectVersionId,
      ),
    );
  }

  private findLeasedSecret(input: {
    tenantId: string;
    channelAuthorizationId: string;
    leaseToken: string;
  }): StoredSecretDeletion | null {
    const secret = this.secretDeletions.get(
      this.secretDeletionKey(input.tenantId, input.channelAuthorizationId),
    );
    if (
      secret === undefined ||
      secret.leaseToken !== input.leaseToken ||
      secret.leaseExpiresAt === null ||
      Date.parse(secret.leaseExpiresAt) < this.safeNow().getTime()
    ) {
      return null;
    }
    return secret;
  }

  private validateClaimInput(leaseToken: string, limit: number): void {
    if (!isUuid(leaseToken) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('INVALID_DELETION_WORK_CLAIM');
    }
  }

  private secretDeletionKey(tenantId: string, channelAuthorizationId: string): string {
    return `${tenantId}:${channelAuthorizationId}`;
  }

  private scopeIsActive(tenantId: string, workspaceId: string): boolean {
    return (
      this.options.tenancy.getTenantLifecycleState(tenantId) === 'ACTIVE' &&
      this.options.tenancy.getWorkspaceLifecycleState({ tenantId, workspaceId }) === 'ACTIVE'
    );
  }

  private tenantExportScopeIsActive(tenantId: string): boolean {
    return this.options.tenancy.allTenantWorkspacesActive(tenantId);
  }

  private tenantExportContextIsCurrent(
    context: Parameters<PrivacyAuditStore['loadTenantExportObjects']>[0]['context'],
  ): boolean {
    return (
      this.options.tenancy.isCurrentOwnerContext(context) &&
      this.tenantExportScopeIsActive(context.tenantId)
    );
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function canonicalFilesMatchManifest(
  canonicalFiles: readonly TenantExportCanonicalFile[],
  manifest: TenantExportManifest,
): boolean {
  const manifestFiles = manifest.files;
  if (canonicalFiles.length !== manifestFiles.length) return false;
  if (canonicalFiles.length !== manifest.objects.length) return false;
  const manifestObjects = new Map<string, TenantExportManifest['objects'][number]>(
    manifest.objects.map((object) => [`${object.kind}:${object.objectId}`, object] as const),
  );
  const paths = new Set<string>();
  for (const [index, file] of canonicalFiles.entries()) {
    const manifestFile = manifestFiles[index];
    if (
      manifestFile === undefined ||
      paths.has(file.path) ||
      file.path !== manifestFile.path ||
      file.contentHash !== manifestFile.contentHash ||
      file.byteLength !== manifestFile.byteLength ||
      manifestFile.objectCount !== 1 ||
      privacySha256(file.content) !== file.contentHash ||
      Buffer.byteLength(file.content, 'utf8') !== file.byteLength
    ) {
      return false;
    }
    let content: unknown;
    try {
      content = JSON.parse(file.content) as unknown;
    } catch {
      return false;
    }
    if (!isRecord(content) || canonicalPrivacyJson(content) !== file.content) return false;
    const kind = content.kind;
    const objectId = content.objectId;
    const workspaceId = content.workspaceId;
    const occurredAt = content.occurredAt;
    if (
      content.schemaVersion !== 'tenant-export-object.v1' ||
      content.tenantId !== manifest.tenantId ||
      typeof kind !== 'string' ||
      typeof objectId !== 'string' ||
      (typeof workspaceId !== 'string' && workspaceId !== null) ||
      typeof occurredAt !== 'string' ||
      !Number.isFinite(Date.parse(occurredAt)) ||
      !Object.hasOwn(content, 'payload')
    ) {
      return false;
    }
    const objectKey = `${kind}:${objectId}`;
    const manifestObject = manifestObjects.get(objectKey);
    if (
      manifestObject === undefined ||
      manifestObject.contentHash !== file.contentHash ||
      file.path !== `objects/${kind.toLowerCase()}/${encodeURIComponent(objectId)}.json`
    ) {
      return false;
    }
    manifestObjects.delete(objectKey);
    paths.add(file.path);
  }
  return manifestObjects.size === 0;
}

function archiveManifestMatches(
  body: Uint8Array,
  manifest: TenantExportManifest,
  manifestChecksum: string,
): boolean {
  let archive: unknown;
  try {
    archive = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(archive) || archive.schemaVersion !== 'tenant-export-bundle.v1') return false;
  if (!isRecord(archive.manifest) || !Array.isArray(archive.files)) return false;
  try {
    if (
      canonicalPrivacyJson(archive.manifest) !== canonicalPrivacyJson(manifest) ||
      privacySha256(canonicalPrivacyJson(archive.manifest)) !== manifestChecksum
    ) {
      return false;
    }
  } catch {
    return false;
  }
  if (archive.files.length !== manifest.files.length) return false;
  for (const [index, rawFile] of archive.files.entries()) {
    const manifestFile = manifest.files[index];
    if (manifestFile === undefined || !isRecord(rawFile)) return false;
    const path = rawFile.path;
    const contentHash = rawFile.contentHash;
    const byteLength = rawFile.byteLength;
    if (
      typeof path !== 'string' ||
      typeof contentHash !== 'string' ||
      typeof byteLength !== 'number' ||
      path !== manifestFile.path ||
      contentHash !== manifestFile.contentHash ||
      byteLength !== manifestFile.byteLength ||
      !('content' in rawFile)
    ) {
      return false;
    }
    try {
      const content = canonicalPrivacyJson(rawFile.content);
      if (
        privacySha256(content) !== contentHash ||
        Buffer.byteLength(content, 'utf8') !== byteLength
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
