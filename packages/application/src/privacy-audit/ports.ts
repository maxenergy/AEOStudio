import type {
  AuditDigest,
  AuditIntegrityVerification,
  AuditTimeline,
  BreakGlassDecisionRecord,
  BreakGlassGrantRecord,
  PrivacyOverview,
  TenantDeletionReceipt,
  TenantExportManifest,
  TenantVisibleLegalHold,
} from '@aeostudio/contracts/privacy-audit';

import type { TenantContext } from '../identity-access/index.js';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface TenantExportSourceObject {
  tenantId: string;
  workspaceId: string | null;
  kind: string;
  objectId: string;
  occurredAt: string;
  payload: JsonValue;
}

export interface TenantExportCanonicalFile {
  path: string;
  content: string;
  contentHash: string;
  byteLength: number;
}

export type LoadTenantExportObjectsResult =
  | { outcome: 'SUCCEEDED'; objects: TenantExportSourceObject[] }
  | { outcome: 'NOT_FOUND' | 'PIPELINE_UNAVAILABLE' };

export type SaveTenantExportResult =
  | {
      outcome: 'SUCCEEDED';
      exportId: string;
      created: boolean;
      archiveStatus: 'PENDING' | 'READY' | 'FAILED';
      archiveReady: boolean;
      objectRef: string | null;
      createdAt: string;
    }
  | { outcome: 'IDEMPOTENCY_CONFLICT' | 'PIPELINE_UNAVAILABLE' };

export interface TenantExportStore {
  loadTenantExportObjects(input: {
    context: TenantContext;
    from: Date;
    to: Date;
  }): Promise<LoadTenantExportObjectsResult>;
  saveTenantExport(input: {
    context: TenantContext;
    exportId: string;
    manifest: TenantExportManifest;
    canonicalFiles: TenantExportCanonicalFile[];
    checksum: string;
    requestHash: string;
    createdAt: Date;
    auditEventId: string;
  }): Promise<SaveTenantExportResult>;
}

export interface PrivacyOverviewStore {
  getPrivacyOverview(input: {
    context: TenantContext;
    at: Date;
  }): Promise<{ outcome: 'SUCCEEDED'; overview: PrivacyOverview } | { outcome: 'NOT_FOUND' }>;
  listAuditEvents(input: {
    context: TenantContext;
    from: Date;
    to: Date;
    cursor: string | null;
    limit: number;
  }): Promise<{ outcome: 'SUCCEEDED'; timeline: AuditTimeline } | { outcome: 'NOT_FOUND' }>;
}

export type RequestDeletionStoreResult =
  | { outcome: 'SUCCEEDED'; receipt: TenantDeletionReceipt; created: boolean }
  | {
      outcome: 'NOT_FOUND' | 'INVALID_REQUEST' | 'IDEMPOTENCY_CONFLICT' | 'PIPELINE_UNAVAILABLE';
    };

export interface DeletionFinalization {
  requestId: string;
  state: 'ACTIVE_DATA_DELETED' | 'BACKUP_DELETED' | 'TOMBSTONED' | 'BLOCKED_BY_LEGAL_HOLD';
  effectiveAt: string;
  tombstoneId: string | null;
}

export type FinalizeDeletionStoreResult =
  | { outcome: 'SUCCEEDED'; finalization: DeletionFinalization }
  | {
      outcome: 'NOT_FOUND' | 'NOT_DUE' | 'INVALID_LEASE' | 'LEGAL_HOLD' | 'PIPELINE_UNAVAILABLE';
    };

export interface DeletionLifecycleStore {
  requestTenantDeletion(input: {
    actorSubject: string;
    context: TenantContext;
    requestId: string;
    reason: string;
    requestHash: string;
    requestedAt: Date;
    auditEventId: string;
  }): Promise<RequestDeletionStoreResult>;
  requestWorkspaceDeletion(input: {
    actorSubject: string;
    context: TenantContext;
    requestId: string;
    reason: string;
    requestHash: string;
    requestedAt: Date;
    auditEventId: string;
  }): Promise<RequestDeletionStoreResult>;
  finalizeDeletion(input: {
    requestId: string;
    leaseToken: string;
    effectiveAt: Date;
    tombstoneId: string;
    auditEventId: string;
  }): Promise<FinalizeDeletionStoreResult>;
  claimDueDeletionRequests(input: {
    leaseToken: string;
    limit: number;
  }): Promise<DeletionRequestWork[]>;
  claimDueSecretDeletions(input: {
    leaseToken: string;
    limit: number;
  }): Promise<SecretDeletionWork[]>;
  markSecretDeletionRequested(input: {
    tenantId: string;
    channelAuthorizationId: string;
    leaseToken: string;
  }): Promise<boolean>;
  markSecretUnreadable(input: {
    tenantId: string;
    channelAuthorizationId: string;
    leaseToken: string;
  }): Promise<boolean>;
}

export interface DeletionRequestWork {
  requestId: string;
  stage: 'ACTIVE' | 'OBJECT' | 'BACKUP' | 'TOMBSTONE';
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface DueDeletionObjectVersion {
  tenantId: string;
  objectClass:
    | 'ACTIVE_TENANT_DATA'
    | 'BACKUP_COPY'
    | 'RAW_PROMPT_RESPONSE'
    | 'CRAWL_SNAPSHOT'
    | 'SCREENSHOT'
    | 'APPLICATION_LOG'
    | 'AUDIT_DIGEST'
    | 'ARTIFACT_PAYLOAD'
    | 'CHANNEL_PACKAGE'
    | 'EVIDENCE_SNAPSHOT'
    | 'TENANT_EXPORT';
  objectKey: string;
  objectVersionId: string;
  legalHold: boolean;
  isDeleteMarker?: boolean;
  /**
   * Capability-mode deletion authority selected from the leased deletion
   * request and managed-object row by PostgreSQL. These values are optional
   * only for the legacy direct-storage adapter; a capability-backed worker
   * must reject a row that does not carry the complete authority tuple.
   */
  scopeKind?: 'TENANT' | 'WORKSPACE';
  workspaceId?: string | null;
  storageClass?: PrivacyObjectInventoryBucket;
  /**
   * True only when the managed ledger contains the exact metadata required by
   * the Broker HEAD capability. Inventory-only orphans and DeleteMarkers are
   * deliberately false.
   */
  headEligible?: boolean;
}

/**
 * Narrow worker-only read boundary. Implementations must validate the exact
 * unexpired deletion lease before returning any Tenant-scoped object identity.
 */
export interface PhysicalDeletionLifecycleStore {
  listDueDeletionObjectVersions(input: {
    requestId: string;
    leaseToken: string;
    limit: number;
  }): Promise<
    | { outcome: 'SUCCEEDED'; objects: DueDeletionObjectVersion[]; hasMore: boolean }
    | { outcome: 'INVALID_LEASE' }
  >;
  markDeletionObjectVersionDeleted(input: {
    requestId: string;
    leaseToken: string;
    tenantId: string;
    objectKey: string;
    objectVersionId: string;
  }): Promise<boolean>;
  releaseDeletionLease(input: { requestId: string; leaseToken: string }): Promise<boolean>;
}

export interface BackupDeletionVerificationTarget {
  requestId: string;
  sourceDeletedAt: string;
}

export type BackupDeletionVerification =
  | {
      outcome: 'VERIFIED';
      evidenceCanonicalJson: string;
      evidenceHash: string;
      sourceDeletedAt: string;
      verifiedAt: string;
    }
  | { outcome: 'RECOVERY_POINTS_RETAINED' };

/**
 * Cloud boundary used only for the 90-day backup plane. A successful result
 * proves the exact configured recovery surfaces no longer expose a restore
 * point created at or before the active-data deletion instant.
 */
export interface BackupDeletionVerifier {
  verifyExpired(input: BackupDeletionVerificationTarget): Promise<BackupDeletionVerification>;
}

/** Exact-lease database boundary for binding a cloud proof to finalization. */
export interface BackupDeletionEvidenceStore {
  getBackupDeletionVerificationTarget(input: {
    requestId: string;
    leaseToken: string;
  }): Promise<
    | { outcome: 'SUCCEEDED'; target: BackupDeletionVerificationTarget }
    | { outcome: 'INVALID_LEASE' | 'NOT_DUE' }
  >;
  recordBackupDeletionVerification(input: {
    requestId: string;
    leaseToken: string;
    evidenceHash: string;
    evidenceCanonicalJson: string;
    sourceDeletedAt: Date;
    verifiedAt: Date;
  }): Promise<boolean>;
}

export interface LegalHoldReconciliationWork {
  tenantId: string;
  objectClass: DueDeletionObjectVersion['objectClass'];
  objectKey: string;
  objectVersionId: string;
  desiredStatus: 'ON' | 'OFF';
  revision: number;
  leaseToken: string;
  leaseExpiresAt: string;
}

/**
 * Worker-only exact-version reconciliation boundary. Legal-hold API writes
 * persist a monotonic desired revision in the same database transaction as
 * the hold itself; a single leased worker then applies that revision to S3.
 */
export interface LegalHoldReconciliationStore {
  claimPendingLegalHoldReconciliations(input: {
    leaseToken: string;
    limit: number;
  }): Promise<LegalHoldReconciliationWork[]>;
  completeLegalHoldReconciliation(input: {
    tenantId: string;
    objectKey: string;
    objectVersionId: string;
    desiredStatus: 'ON' | 'OFF';
    revision: number;
    leaseToken: string;
  }): Promise<boolean>;
  releaseLegalHoldReconciliationLease(input: {
    tenantId: string;
    objectKey: string;
    objectVersionId: string;
    leaseToken: string;
  }): Promise<boolean>;
}

export type PrivacyObjectWriteKind = 'TENANT_EXPORT' | 'AUDIT_DIGEST';

export interface PrivacyObjectWriteIntentWork {
  operationId: string;
  kind: PrivacyObjectWriteKind;
  tenantId: string;
  workspaceId: string;
  objectKey: string;
  canonicalPayload: Uint8Array;
  checksum: string;
  contentType: string;
  lockedUntil: string | null;
  sealedAt: string | null;
  leaseToken: string;
  leaseExpiresAt: string;
}

/**
 * Durable transactional-outbox boundary for privacy S3 writes. The database
 * commits the immutable payload and identity before a worker performs a remote
 * effect; completion then binds the exact S3 VersionId with a lease CAS.
 */
export interface PrivacyObjectWriteIntentStore {
  claimPendingPrivacyObjectWriteIntents(input: {
    leaseToken: string;
    limit: number;
  }): Promise<PrivacyObjectWriteIntentWork[]>;
  completePrivacyObjectWriteIntent(input: {
    operationId: string;
    leaseToken: string;
    object: StoredPrivacyObjectVersion;
  }): Promise<boolean>;
  releasePrivacyObjectWriteIntentLease(input: {
    operationId: string;
    leaseToken: string;
    retryDelayMs?: number;
  }): Promise<boolean>;
}

export type WorkloadObjectWriteKind = 'CRAWL_SNAPSHOT' | 'ARTIFACT_PAYLOAD' | 'CHANNEL_PACKAGE';

export interface WorkloadObjectWriteIntentMetadata {
  kind: WorkloadObjectWriteKind;
  tenantId: string;
  workspaceId: string;
  objectKey: string;
  checksum: string;
  contentType: string;
  byteLength: number;
}

export interface PreparedWorkloadObjectWrite extends WorkloadObjectWriteIntentMetadata {
  canonicalPayload: Uint8Array;
}

export interface StoredWorkloadObjectVersion {
  kind: WorkloadObjectWriteKind;
  objectClass: WorkloadObjectWriteKind;
  tenantId: string;
  workspaceId: string;
  objectRef: string;
  objectKey: string;
  objectVersionId: string;
  checksum: string;
  contentType: string;
  byteLength: number;
  createdAt: string;
}

export interface WorkloadObjectWriteIntentWork extends WorkloadObjectWriteIntentMetadata {
  operationId: string;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface WorkloadObjectWriteIntentStore {
  reserveWorkloadObjectWriteIntent(
    input: WorkloadObjectWriteIntentMetadata & { operationId: string },
  ): Promise<
    | { outcome: 'PENDING'; operationId: string }
    | { outcome: 'READY'; operationId: string; object: StoredWorkloadObjectVersion }
  >;
  claimWorkloadObjectWriteIntent(input: {
    operationId: string;
    tenantId: string;
    leaseToken: string;
  }): Promise<boolean>;
  claimPendingWorkloadObjectWriteIntents(input: {
    leaseToken: string;
    limit: number;
  }): Promise<WorkloadObjectWriteIntentWork[]>;
  completeWorkloadObjectWriteIntent(input: {
    operationId: string;
    leaseToken: string;
    object: StoredWorkloadObjectVersion;
  }): Promise<boolean>;
  releaseWorkloadObjectWriteIntentLease(input: {
    operationId: string;
    leaseToken: string;
    retryDelayMs?: number;
  }): Promise<boolean>;
}

export interface WorkloadObjectVersionStorage {
  putWorkloadVersion(input: PreparedWorkloadObjectWrite): Promise<StoredWorkloadObjectVersion>;
}

/**
 * Metadata-only recovery boundary for an ambiguous workload Put. It may adopt
 * only the current exact immutable key when every persisted scope/hash/length
 * attribute matches; it never reconstructs or writes missing payload bytes.
 */
export interface WorkloadObjectRecoveryStorage {
  recoverWorkloadVersion(
    input: WorkloadObjectWriteIntentMetadata,
  ): Promise<StoredWorkloadObjectVersion | null>;
}

export interface WorkloadObjectDeletionStorage {
  deleteWorkloadVersion(input: {
    tenantId: string;
    workspaceId: string;
    objectKey: string;
    objectVersionId: string;
    isDeleteMarker?: boolean;
  }): Promise<'DELETED' | 'NOT_FOUND'>;
}

export type PrivacyObjectInventoryBucket = 'TENANT_EXPORTS' | 'AUDIT_EVIDENCE' | 'WORKLOAD_OBJECTS';

export interface PrivacyObjectInventoryVersion {
  objectKey: string;
  objectVersionId: string;
  workspaceId?: string;
  checksum?: string;
  contentType?: string;
  byteLength?: number;
  createdAt?: string;
  isDeleteMarker?: true;
}

/** Complete, paginated ListObjectVersions boundary for privacy and workload prefixes. */
export interface PrivacyObjectVersionInventory {
  listPrivacyObjectVersions(input: {
    tenantId: string;
    bucket: PrivacyObjectInventoryBucket;
    workspaceId?: string | null;
    cursor: string | null;
    limit: number;
  }): Promise<{
    versions: PrivacyObjectInventoryVersion[];
    nextCursor: string | null;
  }>;
}

export interface DeletionObjectInventoryTarget {
  requestId: string;
  tenantId: string;
}

export interface DeletionObjectInventoryPageTarget extends DeletionObjectInventoryTarget {
  scopeKind: 'TENANT' | 'WORKSPACE';
  workspaceId: string | null;
  bucket: PrivacyObjectInventoryBucket;
  cursor: string | null;
}

/** Lease-bound database checkpoint that makes an inventory scan deletion evidence. */
export interface DeletionObjectInventoryStore {
  getDeletionObjectInventoryTarget(input: { requestId: string; leaseToken: string }): Promise<
    | { outcome: 'REQUIRED'; target: DeletionObjectInventoryTarget }
    | {
        outcome:
          'COMPLETE' | 'NOT_REQUIRED' | 'PENDING_WRITES' | 'DRAINING_WRITES' | 'INVALID_LEASE';
      }
  >;
  recordDeletionObjectInventory(input: {
    requestId: string;
    leaseToken: string;
    exportVersions: PrivacyObjectInventoryVersion[];
    auditVersions: PrivacyObjectInventoryVersion[];
  }): Promise<boolean>;
  getDeletionObjectInventoryPageTarget?(input: { requestId: string; leaseToken: string }): Promise<
    | { outcome: 'REQUIRED'; target: DeletionObjectInventoryPageTarget }
    | {
        outcome:
          'COMPLETE' | 'NOT_REQUIRED' | 'PENDING_WRITES' | 'DRAINING_WRITES' | 'INVALID_LEASE';
      }
  >;
  recordDeletionObjectInventoryPage?(input: {
    requestId: string;
    leaseToken: string;
    bucket: PrivacyObjectInventoryBucket;
    cursor: string | null;
    nextCursor: string | null;
    versions: PrivacyObjectInventoryVersion[];
  }): Promise<{
    outcome: 'PROGRESS' | 'COMPLETE' | 'DRAINING_WRITES' | 'INVALID_LEASE';
  }>;
}

export interface SecretDeletionWork {
  tenantId: string;
  workspaceId: string;
  channelAuthorizationId: string;
  deletionRequestId: string;
  secretReference: string;
  forceDeleteAt: string;
  state?: 'REVOKED_PENDING_FORCE_DELETE' | 'FORCE_DELETE_REQUESTED' | 'FAILED';
  leaseToken: string;
  leaseExpiresAt: string;
}

export type CreateLegalHoldStoreResult =
  | { outcome: 'SUCCEEDED'; hold: TenantVisibleLegalHold; created: boolean }
  | { outcome: 'NOT_FOUND' | 'OBJECT_NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' };

export interface LegalHoldStore {
  createLegalHold(input: {
    context: TenantContext;
    holdId: string;
    name: string;
    reason: string;
    objectKey: string;
    objectVersionId: string;
    createdAt: Date;
    auditEventId: string;
  }): Promise<CreateLegalHoldStoreResult>;
  listLegalHolds(input: {
    context: TenantContext;
    includeReleased: boolean;
  }): Promise<TenantVisibleLegalHold[]>;
  releaseLegalHold(input: {
    context: TenantContext;
    holdId: string;
    releasedAt: Date;
    auditEventId: string;
  }): Promise<{ outcome: 'SUCCEEDED'; hold: TenantVisibleLegalHold } | { outcome: 'NOT_FOUND' }>;
}

export type GrantBreakGlassStoreResult =
  | { outcome: 'SUCCEEDED'; grant: BreakGlassGrantRecord; created: boolean }
  | { outcome: 'NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' };

export interface BreakGlassStore {
  grantBreakGlass(input: {
    tenantId: string;
    workspaceId: string;
    grantId: string;
    operatorId: string;
    operatorName: string;
    reason: string;
    expiresAt: Date;
    requestedAction: string;
    resourceType: string;
    resourceId: string;
    auditEventId: string;
  }): Promise<GrantBreakGlassStoreResult>;
  evaluateBreakGlassAccess(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    grantId: string;
    operatorId: string | null;
    operatorName: string | null;
    requestedAction: string;
    resourceType: string;
    resourceId: string;
    auditEventId: string;
  }): Promise<BreakGlassDecisionRecord>;
  revokeBreakGlass(input: {
    tenantId: string;
    workspaceId: string;
    grantId: string;
    operatorId: string;
    operatorName: string;
    auditEventId: string;
  }): Promise<{ outcome: 'SUCCEEDED'; grant: BreakGlassGrantRecord } | { outcome: 'NOT_FOUND' }>;
}

export interface PlatformBreakGlassPrincipal {
  operatorId: string;
  operatorName: string;
}

export interface PlatformBreakGlassAuthorizationInput {
  actorSubject: string;
  tenantId: string;
  workspaceId: string;
  operation: 'GRANT' | 'EVALUATE' | 'REVOKE';
  requestedAction: string;
  resourceType: string;
  resourceId: string;
}

export interface PlatformBreakGlassAuthorizer {
  authorize(
    input: PlatformBreakGlassAuthorizationInput,
  ): Promise<PlatformBreakGlassPrincipal | null>;
}

export interface AuditIntegrityStore {
  verifyAuditChain(input: { context: TenantContext }): Promise<AuditIntegrityVerification>;
  verifyAuditRange(input: {
    context: TenantContext;
    from: Date;
    to: Date;
  }): Promise<AuditIntegrityVerification>;
  sealAuditDigest(input: {
    context: TenantContext;
    digestId: string;
    from: Date;
    to: Date;
    auditEventId: string;
  }): Promise<
    | { outcome: 'SUCCEEDED'; digest: AuditDigest; created: boolean }
    | { outcome: 'TAMPERED'; eventCount: number; reason: string }
    | { outcome: 'INVALID_TIME_RANGE' | 'IDEMPOTENCY_CONFLICT' | 'PIPELINE_UNAVAILABLE' }
  >;
}

export interface PrivacyAuditStore
  extends
    TenantExportStore,
    PrivacyOverviewStore,
    DeletionLifecycleStore,
    LegalHoldStore,
    BreakGlassStore,
    AuditIntegrityStore {}

export interface StoredPrivacyObjectVersion {
  tenantId: string;
  objectRef: string;
  objectKey: string;
  objectVersionId: string;
  checksum: string;
  contentType: string;
  byteLength: number;
  createdAt: string;
  lockedUntil: string | null;
}

export type PrivacyObjectDeleteResult =
  | { outcome: 'DELETED'; object?: StoredPrivacyObjectVersion }
  | { outcome: 'NOT_FOUND' | 'LEGAL_HOLD' | 'OBJECT_LOCKED' | 'INVALID_TIMELINE' };

export interface TenantExportObjectStorage {
  putExportVersion(input: {
    tenantId: string;
    objectKey: string;
    body: Uint8Array;
    contentType: string;
    checksum: string;
  }): Promise<StoredPrivacyObjectVersion>;
  readExportVersion(input: {
    tenantId: string;
    objectKey: string;
    objectVersionId: string;
  }): Promise<{ object: StoredPrivacyObjectVersion; body: Uint8Array } | null>;
  deleteExportVersion(input: {
    tenantId: string;
    objectKey: string;
    objectVersionId: string;
    at: Date;
    isDeleteMarker?: boolean;
  }): Promise<PrivacyObjectDeleteResult>;
  holdExportVersion(input: {
    tenantId: string;
    objectKey: string;
    objectVersionId: string;
    holdId: string;
  }): Promise<boolean>;
  releaseExportVersionHold(input: {
    tenantId: string;
    objectKey: string;
    objectVersionId: string;
    holdId: string;
  }): Promise<boolean>;
}

export interface AuditEvidenceObjectLockStore {
  putLockedAuditVersion(input: {
    tenantId: string;
    objectKey: string;
    body: Uint8Array;
    contentType: string;
    checksum: string;
    lockedUntil: Date;
  }): Promise<StoredPrivacyObjectVersion>;
  readAuditVersion(input: {
    tenantId: string;
    objectKey: string;
    objectVersionId: string;
  }): Promise<{ object: StoredPrivacyObjectVersion; body: Uint8Array } | null>;
  deleteAuditVersion(input: {
    tenantId: string;
    objectKey: string;
    objectVersionId: string;
    at: Date;
    isDeleteMarker?: boolean;
  }): Promise<PrivacyObjectDeleteResult>;
  holdAuditVersion(input: {
    tenantId: string;
    objectKey: string;
    objectVersionId: string;
    holdId: string;
  }): Promise<boolean>;
  releaseAuditVersionHold(input: {
    tenantId: string;
    objectKey: string;
    objectVersionId: string;
    holdId: string;
  }): Promise<boolean>;
}

export interface SecretLifecycleMetadata {
  tenantId: string;
  secretReference: string;
  state: 'ACTIVE' | 'REVOKED_PENDING_FORCE_DELETE' | 'FORCE_DELETED';
  readable: boolean;
  revokedAt: string | null;
  forceDeleteAt: string | null;
}

export interface SecretLifecycleStore {
  revoke(input: {
    tenantId: string;
    secretReference: string;
    revokedAt: Date;
    forceDeleteAt: Date;
  }): Promise<SecretLifecycleMetadata>;
  describe(input: {
    tenantId: string;
    secretReference: string;
    at: Date;
  }): Promise<SecretLifecycleMetadata | null>;
  forceDeleteDue(input: { tenantId: string; at: Date }): Promise<number>;
}
