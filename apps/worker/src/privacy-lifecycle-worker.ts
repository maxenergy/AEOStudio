import { createHash } from 'node:crypto';

import type {
  AuditEvidenceObjectLockStore,
  BackupDeletionEvidenceStore,
  BackupDeletionVerifier,
  DeletionRequestWork,
  DeletionObjectInventoryStore,
  LegalHoldReconciliationStore,
  LegalHoldReconciliationWork,
  PhysicalDeletionLifecycleStore,
  PrivacyObjectWriteIntentStore,
  PrivacyObjectWriteIntentWork,
  PrivacyObjectInventoryBucket,
  PrivacyObjectInventoryVersion,
  PrivacyObjectVersionInventory,
  PrivacyAuditStore,
  SecretDeletionWork,
  TenantExportObjectStorage,
  WorkloadObjectDeletionStorage,
  WorkloadObjectRecoveryStorage,
  WorkloadObjectWriteIntentStore,
  WorkloadObjectWriteIntentWork,
} from '@aeostudio/application/privacy-audit';
import type {
  CapabilityBoundWorkloadObjectRecovery,
  WorkloadWriteRecoveryResult,
} from '@aeostudio/application/tenant-data-access';
import type {
  CapabilityBoundDeletionInventoryGateway,
  CapabilityBoundLegalHoldGateway,
  CapabilityBoundObjectDeletionGateway,
  CapabilityBoundPrivacyObjectWriter,
  CapabilityBoundSecretLifecycleGateway,
} from '@aeostudio/adapters/tenant-data-broker';

type LifecycleStore = Pick<
  PrivacyAuditStore,
  | 'claimDueDeletionRequests'
  | 'claimDueSecretDeletions'
  | 'markSecretDeletionRequested'
  | 'markSecretUnreadable'
  | 'finalizeDeletion'
> &
  PhysicalDeletionLifecycleStore &
  BackupDeletionEvidenceStore &
  LegalHoldReconciliationStore &
  PrivacyObjectWriteIntentStore &
  DeletionObjectInventoryStore;

type PhysicalObjectStorage = Pick<
  TenantExportObjectStorage,
  'putExportVersion' | 'deleteExportVersion' | 'holdExportVersion' | 'releaseExportVersionHold'
> &
  Pick<
    AuditEvidenceObjectLockStore,
    'putLockedAuditVersion' | 'deleteAuditVersion' | 'holdAuditVersion' | 'releaseAuditVersionHold'
  > &
  PrivacyObjectVersionInventory &
  Partial<WorkloadObjectDeletionStorage>;

export interface PrivacyLifecycleSecretManager {
  requestForceDelete(input: {
    channelAuthorizationId: string;
    leaseToken: string;
    tenantId: string;
    workspaceId: string;
    secretReference: string;
  }): Promise<void>;
  verifyUnreadable(input: {
    channelAuthorizationId: string;
    leaseToken: string;
    tenantId: string;
    workspaceId: string;
    secretReference: string;
  }): Promise<boolean>;
}

export type PrivacyLifecycleCapabilityGateway = Partial<
  CapabilityBoundPrivacyObjectWriter &
    CapabilityBoundDeletionInventoryGateway &
    CapabilityBoundObjectDeletionGateway &
    CapabilityBoundLegalHoldGateway
>;

export interface PrivacyLifecycleWorkerResult {
  claimedPrivacyObjectWrites: number;
  completedPrivacyObjectWrites: number;
  claimedWorkloadObjectWrites: number;
  completedWorkloadObjectWrites: number;
  claimedLegalHoldReconciliations: number;
  reconciledLegalHoldObjectVersions: number;
  claimedSecrets: number;
  verifiedSecrets: number;
  claimedDeletions: number;
  finalizedDeletions: number;
  physicallyDeletedObjectVersions: number;
  retainedAuditObjectVersions: number;
  retainedLegalHoldObjectVersions: number;
  leaseLost: number;
  failed: number;
}

export class PrivacyLifecycleWorker {
  private readonly limit: number;
  private readonly objectBatchLimit: number;

  public constructor(
    private readonly store: LifecycleStore,
    private readonly secrets: PrivacyLifecycleSecretManager | CapabilityBoundSecretLifecycleGateway,
    private readonly options: {
      clock: { now(): Date };
      ids: { next(): string };
      objects?: PhysicalObjectStorage;
      backupVerifier?: BackupDeletionVerifier;
      limit?: number;
      objectBatchLimit?: number;
      pollIntervalMs?: number;
      lifecycleGateway?: PrivacyLifecycleCapabilityGateway;
      privacyWrites?: {
        putAuthorizedPrivacyVersion(
          input: PrivacyObjectWriteIntentWork,
        ): Promise<Awaited<ReturnType<TenantExportObjectStorage['putExportVersion']>>>;
      };
      workloadWrites?: {
        intents: WorkloadObjectWriteIntentStore;
        objects: WorkloadObjectRecoveryStorage | CapabilityBoundWorkloadObjectRecovery;
      };
    },
  ) {
    this.limit = Math.max(1, Math.min(options.limit ?? 25, 100));
    this.objectBatchLimit = Math.max(1, Math.min(options.objectBatchLimit ?? 100, 1_000));
  }

  public async runOnce(): Promise<PrivacyLifecycleWorkerResult> {
    const result: PrivacyLifecycleWorkerResult = {
      claimedPrivacyObjectWrites: 0,
      completedPrivacyObjectWrites: 0,
      claimedWorkloadObjectWrites: 0,
      completedWorkloadObjectWrites: 0,
      claimedLegalHoldReconciliations: 0,
      reconciledLegalHoldObjectVersions: 0,
      claimedSecrets: 0,
      verifiedSecrets: 0,
      claimedDeletions: 0,
      finalizedDeletions: 0,
      physicallyDeletedObjectVersions: 0,
      retainedAuditObjectVersions: 0,
      retainedLegalHoldObjectVersions: 0,
      leaseLost: 0,
      failed: 0,
    };
    const privacyObjectWriteClaims = await this.store.claimPendingPrivacyObjectWriteIntents({
      leaseToken: this.options.ids.next(),
      limit: this.limit,
    });
    result.claimedPrivacyObjectWrites = privacyObjectWriteClaims.length;
    for (const claim of privacyObjectWriteClaims) {
      await this.processPrivacyObjectWrite(claim, result);
    }

    const workloadWrites = this.options.workloadWrites;
    if (workloadWrites !== undefined) {
      const workloadClaims = await workloadWrites.intents.claimPendingWorkloadObjectWriteIntents({
        leaseToken: this.options.ids.next(),
        limit: this.limit,
      });
      result.claimedWorkloadObjectWrites = workloadClaims.length;
      for (const claim of workloadClaims) {
        await this.processWorkloadObjectWrite(claim, workloadWrites, result);
      }
    }

    const legalHoldClaims = await this.store.claimPendingLegalHoldReconciliations({
      leaseToken: this.options.ids.next(),
      limit: this.limit,
    });
    result.claimedLegalHoldReconciliations = legalHoldClaims.length;
    for (const claim of legalHoldClaims) await this.processLegalHoldReconciliation(claim, result);

    const secretClaims = await this.store.claimDueSecretDeletions({
      leaseToken: this.options.ids.next(),
      limit: this.limit,
    });
    result.claimedSecrets = secretClaims.length;
    for (const claim of secretClaims) await this.processSecret(claim, result);

    const deletionClaims = await this.store.claimDueDeletionRequests({
      leaseToken: this.options.ids.next(),
      limit: this.limit,
    });
    result.claimedDeletions = deletionClaims.length;
    for (const claim of deletionClaims) await this.processDeletion(claim, result);
    return result;
  }

  private async processPrivacyObjectWrite(
    claim: PrivacyObjectWriteIntentWork,
    result: PrivacyLifecycleWorkerResult,
  ): Promise<void> {
    if (!this.leaseIsUsable(claim)) {
      result.leaseLost += 1;
      return;
    }
    try {
      const object =
        this.options.privacyWrites === undefined
          ? await this.putPrivacyObjectThroughLegacyPort(claim)
          : await this.options.privacyWrites.putAuthorizedPrivacyVersion(claim);
      if (!this.leaseIsUsable(claim)) {
        result.leaseLost += 1;
        return;
      }
      const completed = await this.store.completePrivacyObjectWriteIntent({
        operationId: claim.operationId,
        leaseToken: claim.leaseToken,
        object,
      });
      if (completed) result.completedPrivacyObjectWrites += 1;
      else result.leaseLost += 1;
    } catch {
      result.failed += 1;
      try {
        await this.store.releasePrivacyObjectWriteIntentLease({
          operationId: claim.operationId,
          leaseToken: claim.leaseToken,
          retryDelayMs: 30_000,
        });
      } catch {
        // The server-side lease expires and makes the immutable intent retryable.
      }
    }
  }

  private async processWorkloadObjectWrite(
    claim: WorkloadObjectWriteIntentWork,
    recovery: {
      intents: WorkloadObjectWriteIntentStore;
      objects: WorkloadObjectRecoveryStorage | CapabilityBoundWorkloadObjectRecovery;
    },
    result: PrivacyLifecycleWorkerResult,
  ): Promise<void> {
    if (!this.leaseIsUsable(claim)) {
      result.leaseLost += 1;
      return;
    }
    try {
      const metadata = {
        kind: claim.kind,
        tenantId: claim.tenantId,
        workspaceId: claim.workspaceId,
        objectKey: claim.objectKey,
        checksum: claim.checksum,
        contentType: claim.contentType,
        byteLength: claim.byteLength,
      };
      const recovered = await recoverWorkloadObject(recovery.objects, metadata, {
        operationId: claim.operationId,
        leaseToken: claim.leaseToken,
      });
      if (recovered.outcome === 'UNKNOWN') {
        result.failed += 1;
        return;
      }
      const object = recovered.outcome === 'FOUND' ? recovered.object : null;
      if (object === null) {
        await recovery.intents.releaseWorkloadObjectWriteIntentLease({
          operationId: claim.operationId,
          leaseToken: claim.leaseToken,
          retryDelayMs: 30_000,
        });
        return;
      }
      if (!this.leaseIsUsable(claim)) {
        result.leaseLost += 1;
        return;
      }
      const completed = await recovery.intents.completeWorkloadObjectWriteIntent({
        operationId: claim.operationId,
        leaseToken: claim.leaseToken,
        object,
      });
      if (completed) result.completedWorkloadObjectWrites += 1;
      else result.leaseLost += 1;
    } catch {
      result.failed += 1;
      try {
        await recovery.intents.releaseWorkloadObjectWriteIntentLease({
          operationId: claim.operationId,
          leaseToken: claim.leaseToken,
          retryDelayMs: 30_000,
        });
      } catch {
        // The exact database lease expires and keeps the intent retryable.
      }
    }
  }

  private async processLegalHoldReconciliation(
    claim: LegalHoldReconciliationWork,
    result: PrivacyLifecycleWorkerResult,
  ): Promise<void> {
    if (!this.leaseIsUsable(claim)) {
      result.leaseLost += 1;
      return;
    }
    try {
      const capabilityReconciliation =
        this.options.lifecycleGateway?.reconcileAuthorizedObjectLegalHold;
      const applied =
        capabilityReconciliation === undefined
          ? await this.reconcileLegalHoldThroughLegacyPort(claim)
          : await capabilityReconciliation.call(this.options.lifecycleGateway, {
              source: {
                tenantId: claim.tenantId,
                objectKey: claim.objectKey,
                objectVersionId: claim.objectVersionId,
                leaseToken: claim.leaseToken,
              },
              expected: {
                ...privacyObjectScope(claim.tenantId, claim.objectClass, claim.objectKey),
                desiredStatus: claim.desiredStatus,
                revision: claim.revision,
              },
            });
      if (!applied) {
        result.failed += 1;
        await this.releaseLegalHoldReconciliationLease(claim);
        return;
      }
      if (!this.leaseIsUsable(claim)) {
        result.leaseLost += 1;
        return;
      }
      const completed = await this.store.completeLegalHoldReconciliation({
        tenantId: claim.tenantId,
        objectKey: claim.objectKey,
        objectVersionId: claim.objectVersionId,
        desiredStatus: claim.desiredStatus,
        revision: claim.revision,
        leaseToken: claim.leaseToken,
      });
      if (completed) result.reconciledLegalHoldObjectVersions += 1;
      else result.leaseLost += 1;
    } catch {
      result.failed += 1;
      await this.releaseLegalHoldReconciliationLease(claim);
    }
  }

  private async releaseLegalHoldReconciliationLease(
    claim: LegalHoldReconciliationWork,
  ): Promise<void> {
    try {
      await this.store.releaseLegalHoldReconciliationLease({
        tenantId: claim.tenantId,
        objectKey: claim.objectKey,
        objectVersionId: claim.objectVersionId,
        leaseToken: claim.leaseToken,
      });
    } catch {
      // The lease expires server-side; failure here must not hide the original
      // reconciliation failure or stop other lifecycle work.
    }
  }

  private reconcileLegalHoldThroughLegacyPort(
    claim: LegalHoldReconciliationWork,
  ): Promise<boolean> {
    const objects = this.requireLegacyObjects();
    const command = {
      tenantId: claim.tenantId,
      objectKey: claim.objectKey,
      objectVersionId: claim.objectVersionId,
      holdId: `legal-hold-reconciliation:${claim.revision}`,
    };
    const audit = claim.objectClass === 'AUDIT_DIGEST';
    return claim.desiredStatus === 'ON'
      ? audit
        ? objects.holdAuditVersion(command)
        : objects.holdExportVersion(command)
      : audit
        ? objects.releaseAuditVersionHold(command)
        : objects.releaseExportVersionHold(command);
  }

  public async run(signal: AbortSignal): Promise<void> {
    const interval = Math.max(1, Math.min(this.options.pollIntervalMs ?? 1_000, 60_000));
    while (!signal.aborted) {
      try {
        await this.runOnce();
      } catch {
        // A transient claim-store failure must not permanently stop lifecycle enforcement.
      }
      await waitForNextPoll(signal, interval);
    }
  }

  private async processSecret(
    claim: SecretDeletionWork,
    result: PrivacyLifecycleWorkerResult,
  ): Promise<void> {
    if (!this.leaseIsUsable(claim)) {
      result.leaseLost += 1;
      return;
    }
    try {
      if (claim.state !== 'FORCE_DELETE_REQUESTED') {
        await requestConnectorSecretForceDelete(this.secrets, claim);
        if (!this.leaseIsUsable(claim)) {
          result.leaseLost += 1;
          return;
        }
      }
      const markedRequested = await this.store.markSecretDeletionRequested({
        tenantId: claim.tenantId,
        channelAuthorizationId: claim.channelAuthorizationId,
        leaseToken: claim.leaseToken,
      });
      if (!markedRequested) {
        result.leaseLost += 1;
        return;
      }
      const unreadable = await verifyConnectorSecretUnreadable(this.secrets, claim);
      if (!unreadable) {
        result.failed += 1;
        return;
      }
      if (!this.leaseIsUsable(claim)) {
        result.leaseLost += 1;
        return;
      }
      const markedUnreadable = await this.store.markSecretUnreadable({
        tenantId: claim.tenantId,
        channelAuthorizationId: claim.channelAuthorizationId,
        leaseToken: claim.leaseToken,
      });
      if (!markedUnreadable) {
        result.leaseLost += 1;
        return;
      }
      result.verifiedSecrets += 1;
    } catch {
      result.failed += 1;
    }
  }

  private async processDeletion(
    claim: DeletionRequestWork,
    result: PrivacyLifecycleWorkerResult,
  ): Promise<void> {
    if (!this.leaseIsUsable(claim)) {
      result.leaseLost += 1;
      return;
    }
    const effectiveAt = this.validNow();
    if (effectiveAt === null) {
      result.failed += 1;
      return;
    }
    try {
      if (claim.stage !== 'TOMBSTONE') {
        const inventoryReady = await this.reconcileDeletionObjectInventory(claim, result);
        if (!inventoryReady) return;
        const physicalDeletion = await this.deleteDueObjectVersions(claim, effectiveAt, result);
        if (!physicalDeletion) return;
      }
      if (claim.stage === 'OBJECT') {
        const released = await this.store.releaseDeletionLease({
          requestId: claim.requestId,
          leaseToken: claim.leaseToken,
        });
        if (!released) result.leaseLost += 1;
        return;
      }
      if (claim.stage === 'BACKUP') {
        const verifier = this.options.backupVerifier;
        if (verifier === undefined) {
          result.failed += 1;
          return;
        }
        const target = await this.store.getBackupDeletionVerificationTarget({
          requestId: claim.requestId,
          leaseToken: claim.leaseToken,
        });
        if (target.outcome !== 'SUCCEEDED') {
          if (target.outcome === 'INVALID_LEASE') result.leaseLost += 1;
          else result.failed += 1;
          return;
        }
        const verification = await verifier.verifyExpired(target.target);
        if (verification.outcome !== 'VERIFIED') {
          result.failed += 1;
          return;
        }
        const sourceDeletedAt = parseExactInstant(verification.sourceDeletedAt);
        const verifiedAt = parseExactInstant(verification.verifiedAt);
        if (
          target.target.requestId !== claim.requestId ||
          verification.sourceDeletedAt !== target.target.sourceDeletedAt ||
          sourceDeletedAt === null ||
          verifiedAt === null ||
          verifiedAt.getTime() < sourceDeletedAt.getTime() ||
          !/^[a-f0-9]{64}$/u.test(verification.evidenceHash) ||
          !isCanonicalBackupEvidence(
            verification.evidenceCanonicalJson,
            verification.evidenceHash,
            claim.requestId,
            verification.sourceDeletedAt,
            verification.verifiedAt,
          )
        ) {
          result.failed += 1;
          return;
        }
        if (!this.leaseIsUsable(claim)) {
          result.leaseLost += 1;
          return;
        }
        const recorded = await this.store.recordBackupDeletionVerification({
          requestId: claim.requestId,
          leaseToken: claim.leaseToken,
          evidenceCanonicalJson: verification.evidenceCanonicalJson,
          evidenceHash: verification.evidenceHash,
          sourceDeletedAt,
          verifiedAt,
        });
        if (!recorded) {
          result.leaseLost += 1;
          return;
        }
      }
      if (!this.leaseIsUsable(claim)) {
        result.leaseLost += 1;
        return;
      }
      const finalized = await this.store.finalizeDeletion({
        requestId: claim.requestId,
        leaseToken: claim.leaseToken,
        effectiveAt,
        tombstoneId: this.options.ids.next(),
        auditEventId: this.options.ids.next(),
      });
      if (finalized.outcome === 'SUCCEEDED') result.finalizedDeletions += 1;
      else if (finalized.outcome === 'INVALID_LEASE') result.leaseLost += 1;
      else result.failed += 1;
    } catch {
      result.failed += 1;
    }
  }

  private async reconcileDeletionObjectInventory(
    claim: DeletionRequestWork,
    result: PrivacyLifecycleWorkerResult,
  ): Promise<boolean> {
    if (
      this.store.getDeletionObjectInventoryPageTarget !== undefined &&
      this.store.recordDeletionObjectInventoryPage !== undefined
    ) {
      return this.reconcileDeletionObjectInventoryPage(claim, result);
    }
    try {
      const target = await this.store.getDeletionObjectInventoryTarget({
        requestId: claim.requestId,
        leaseToken: claim.leaseToken,
      });
      if (target.outcome === 'INVALID_LEASE') {
        result.leaseLost += 1;
        return false;
      }
      if (target.outcome === 'PENDING_WRITES' || target.outcome === 'DRAINING_WRITES') {
        result.failed += 1;
        await this.store.releaseDeletionLease({
          requestId: claim.requestId,
          leaseToken: claim.leaseToken,
        });
        return false;
      }
      if (target.outcome === 'NOT_REQUIRED' || target.outcome === 'COMPLETE') return true;
      if (target.outcome !== 'REQUIRED') return false;

      const [exportVersions, auditVersions] = await Promise.all([
        this.listAllPrivacyObjectVersions(target.target.tenantId, 'TENANT_EXPORTS'),
        this.listAllPrivacyObjectVersions(target.target.tenantId, 'AUDIT_EVIDENCE'),
      ]);
      if (!this.leaseIsUsable(claim)) {
        result.leaseLost += 1;
        return false;
      }
      const recorded = await this.store.recordDeletionObjectInventory({
        requestId: claim.requestId,
        leaseToken: claim.leaseToken,
        exportVersions,
        auditVersions,
      });
      if (!recorded) {
        result.leaseLost += 1;
        return false;
      }
      return true;
    } catch {
      result.failed += 1;
      try {
        await this.store.releaseDeletionLease({
          requestId: claim.requestId,
          leaseToken: claim.leaseToken,
        });
      } catch {
        // The exact server-side lease eventually expires and makes the scan retryable.
      }
      return false;
    }
  }

  private async reconcileDeletionObjectInventoryPage(
    claim: DeletionRequestWork,
    result: PrivacyLifecycleWorkerResult,
  ): Promise<boolean> {
    try {
      if (
        this.store.getDeletionObjectInventoryPageTarget === undefined ||
        this.store.recordDeletionObjectInventoryPage === undefined
      ) {
        return false;
      }
      const target = await this.store.getDeletionObjectInventoryPageTarget({
        requestId: claim.requestId,
        leaseToken: claim.leaseToken,
      });
      if (target.outcome === 'INVALID_LEASE') {
        result.leaseLost += 1;
        return false;
      }
      if (target.outcome === 'PENDING_WRITES' || target.outcome === 'DRAINING_WRITES') {
        await this.store.releaseDeletionLease({
          requestId: claim.requestId,
          leaseToken: claim.leaseToken,
        });
        return false;
      }
      if (target.outcome === 'NOT_REQUIRED' || target.outcome === 'COMPLETE') return true;
      if (target.outcome !== 'REQUIRED') return false;
      const capabilityInventory = this.options.lifecycleGateway?.listAuthorizedObjectVersions;
      const page =
        capabilityInventory === undefined
          ? await this.requireLegacyObjects().listPrivacyObjectVersions({
              tenantId: target.target.tenantId,
              workspaceId: target.target.workspaceId,
              bucket: target.target.bucket,
              cursor: target.target.cursor,
              limit: target.target.bucket === 'WORKLOAD_OBJECTS' ? 100 : 1_000,
            })
          : await capabilityInventory.call(this.options.lifecycleGateway, {
              source: {
                requestId: claim.requestId,
                leaseToken: claim.leaseToken,
              },
              expected: {
                tenantId: target.target.tenantId,
                scopeKind: target.target.scopeKind,
                workspaceId: target.target.workspaceId,
                objectClass: target.target.bucket,
              },
            });
      if (!this.leaseIsUsable(claim)) {
        result.leaseLost += 1;
        return false;
      }
      const recorded = await this.store.recordDeletionObjectInventoryPage({
        requestId: claim.requestId,
        leaseToken: claim.leaseToken,
        bucket: target.target.bucket,
        cursor: target.target.cursor,
        nextCursor: page.nextCursor,
        versions: page.versions,
      });
      if (recorded.outcome === 'INVALID_LEASE') {
        result.leaseLost += 1;
        return false;
      }
      if (recorded.outcome === 'COMPLETE') return true;
      const released = await this.store.releaseDeletionLease({
        requestId: claim.requestId,
        leaseToken: claim.leaseToken,
      });
      if (!released) result.leaseLost += 1;
      return false;
    } catch {
      result.failed += 1;
      try {
        await this.store.releaseDeletionLease({
          requestId: claim.requestId,
          leaseToken: claim.leaseToken,
        });
      } catch {
        // The exact server-side lease eventually expires and makes the page retryable.
      }
      return false;
    }
  }

  private async listAllPrivacyObjectVersions(
    tenantId: string,
    bucket: PrivacyObjectInventoryBucket,
  ): Promise<PrivacyObjectInventoryVersion[]> {
    const versions: PrivacyObjectInventoryVersion[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (let page = 0; page < 10_000; page += 1) {
      const result = await this.requireLegacyObjects().listPrivacyObjectVersions({
        tenantId,
        bucket,
        cursor,
        limit: 1_000,
      });
      versions.push(...result.versions);
      if (result.nextCursor === null) return versions;
      if (seenCursors.has(result.nextCursor)) {
        throw new Error('PRIVACY_OBJECT_INVENTORY_CURSOR_REPEATED');
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error('PRIVACY_OBJECT_INVENTORY_PAGE_LIMIT_EXCEEDED');
  }

  private async deleteDueObjectVersions(
    claim: DeletionRequestWork,
    effectiveAt: Date,
    result: PrivacyLifecycleWorkerResult,
  ): Promise<boolean> {
    const listed = await this.store.listDueDeletionObjectVersions({
      requestId: claim.requestId,
      leaseToken: claim.leaseToken,
      limit: this.objectBatchLimit,
    });
    if (listed.outcome === 'INVALID_LEASE') {
      result.leaseLost += 1;
      return false;
    }
    for (const object of listed.objects) {
      // Tamper-evident audit evidence has an independently frozen 365-day
      // retention schedule and S3 lifecycle. It is not the 90-day backup plane.
      if (object.objectClass === 'AUDIT_DIGEST') {
        result.retainedAuditObjectVersions += 1;
        continue;
      }
      if (object.legalHold) {
        result.retainedLegalHoldObjectVersions += 1;
        continue;
      }
      if (!this.leaseIsUsable(claim)) {
        result.leaseLost += 1;
        return false;
      }
      const capabilityDeletion = this.options.lifecycleGateway?.deleteAuthorizedObjectVersion;
      let deletionOutcome: Awaited<
        ReturnType<TenantExportObjectStorage['deleteExportVersion']>
      >['outcome'];
      if (capabilityDeletion === undefined) {
        const objects = this.requireLegacyObjects();
        const input = {
          tenantId: object.tenantId,
          objectKey: object.objectKey,
          objectVersionId: object.objectVersionId,
          at: effectiveAt,
          isDeleteMarker: object.isDeleteMarker === true,
        };
        const workspaceId = readWorkloadWorkspaceFromKey(object.tenantId, object.objectKey);
        const workloadDelete = objects.deleteWorkloadVersion;
        const deleted =
          workspaceId !== null && workloadDelete !== undefined
            ? await workloadDelete.call(objects, {
                tenantId: object.tenantId,
                workspaceId,
                objectKey: object.objectKey,
                objectVersionId: object.objectVersionId,
                isDeleteMarker: object.isDeleteMarker === true,
              })
            : await objects.deleteExportVersion(input);
        deletionOutcome = typeof deleted === 'string' ? deleted : deleted.outcome;
      } else {
        const head = this.options.lifecycleGateway?.headAuthorizedDeletionObject;
        const getLegalHold = this.options.lifecycleGateway?.getAuthorizedDeletionObjectLegalHold;
        if (head === undefined || getLegalHold === undefined) {
          throw new Error('PRIVACY_LIFECYCLE_CAPABILITY_DELETION_PORT_INCOMPLETE');
        }
        const authority = requireDatabaseSelectedDeletionAuthority(object);
        const expected = {
          scopeKind: authority.scopeKind,
          workspaceId: authority.workspaceId,
          objectClass: authority.objectClass,
          tenantId: object.tenantId,
          objectKey: object.objectKey,
          objectVersionId: object.objectVersionId,
        };
        const request = {
          source: {
            requestId: claim.requestId,
            leaseToken: claim.leaseToken,
          },
          expected,
        };
        if (object.isDeleteMarker === true || !authority.headEligible) {
          // Inventory-only versions have no trustworthy HEAD contract. The
          // exact VersionId delete is idempotent and converges after a prior
          // ambiguous success; S3 Object Lock still rejects a held version,
          // and the Broker role has no governance-retention bypass action.
          deletionOutcome = await capabilityDeletion.call(this.options.lifecycleGateway, {
            ...request,
            expected: {
              ...expected,
              isDeleteMarker: object.isDeleteMarker === true,
            },
          });
        } else {
          const remoteObject = await head.call(this.options.lifecycleGateway, request);
          if (!remoteObject.exists) {
            deletionOutcome = 'NOT_FOUND';
          } else {
            const remoteLegalHold = await getLegalHold.call(this.options.lifecycleGateway, request);
            if (remoteLegalHold === 'ON') {
              result.retainedLegalHoldObjectVersions += 1;
              continue;
            }
            deletionOutcome = await capabilityDeletion.call(this.options.lifecycleGateway, {
              ...request,
              expected: {
                ...expected,
                isDeleteMarker: false,
              },
            });
          }
        }
      }
      if (deletionOutcome !== 'DELETED' && deletionOutcome !== 'NOT_FOUND') {
        result.failed += 1;
        return false;
      }
      const acknowledged = await this.store.markDeletionObjectVersionDeleted({
        requestId: claim.requestId,
        leaseToken: claim.leaseToken,
        tenantId: object.tenantId,
        objectKey: object.objectKey,
        objectVersionId: object.objectVersionId,
      });
      if (!acknowledged) {
        result.leaseLost += 1;
        return false;
      }
      result.physicallyDeletedObjectVersions += 1;
    }
    if (listed.hasMore) {
      const released = await this.store.releaseDeletionLease({
        requestId: claim.requestId,
        leaseToken: claim.leaseToken,
      });
      if (!released) result.leaseLost += 1;
      return false;
    }
    return true;
  }

  private leaseIsUsable(claim: { leaseToken: string; leaseExpiresAt: string }): boolean {
    const now = this.validNow();
    const expiresAt = Date.parse(claim.leaseExpiresAt);
    return (
      now !== null &&
      isUuid(claim.leaseToken) &&
      Number.isFinite(expiresAt) &&
      expiresAt > now.getTime()
    );
  }

  private validNow(): Date | null {
    try {
      const value = this.options.clock.now();
      return value instanceof Date && Number.isFinite(value.getTime()) ? new Date(value) : null;
    } catch {
      return null;
    }
  }

  private putPrivacyObjectThroughLegacyPort(
    claim: PrivacyObjectWriteIntentWork,
  ): Promise<Awaited<ReturnType<TenantExportObjectStorage['putExportVersion']>>> {
    const objects = this.requireLegacyObjects();
    const command = {
      tenantId: claim.tenantId,
      objectKey: claim.objectKey,
      body: claim.canonicalPayload,
      contentType: claim.contentType,
      checksum: claim.checksum,
    };
    return claim.kind === 'AUDIT_DIGEST'
      ? objects.putLockedAuditVersion({
          ...command,
          lockedUntil: new Date(claim.lockedUntil ?? ''),
        })
      : objects.putExportVersion(command);
  }

  private requireLegacyObjects(): PhysicalObjectStorage {
    if (this.options.objects === undefined) {
      throw new Error('PRIVACY_LIFECYCLE_OBJECT_STORAGE_REQUIRED');
    }
    return this.options.objects;
  }
}

async function recoverWorkloadObject(
  storage: WorkloadObjectRecoveryStorage | CapabilityBoundWorkloadObjectRecovery,
  metadata: Parameters<WorkloadObjectRecoveryStorage['recoverWorkloadVersion']>[0],
  access: { operationId: string; leaseToken: string },
): Promise<WorkloadWriteRecoveryResult> {
  if ('recoverAuthorizedWorkloadVersion' in storage) {
    return storage.recoverAuthorizedWorkloadVersion(metadata, access);
  }
  const object = await storage.recoverWorkloadVersion(metadata);
  return object === null ? { outcome: 'ABSENT' } : { outcome: 'FOUND', object };
}

function requestConnectorSecretForceDelete(
  secrets: PrivacyLifecycleSecretManager | CapabilityBoundSecretLifecycleGateway,
  claim: SecretDeletionWork,
): Promise<void> {
  if ('requestAuthorizedConnectorSecretForceDelete' in secrets) {
    return secrets.requestAuthorizedConnectorSecretForceDelete({
      source: {
        channelAuthorizationId: claim.channelAuthorizationId,
        leaseToken: claim.leaseToken,
      },
      expected: {
        tenantId: claim.tenantId,
        workspaceId: claim.workspaceId,
        secretReference: claim.secretReference,
      },
    });
  }
  return secrets.requestForceDelete({
    channelAuthorizationId: claim.channelAuthorizationId,
    leaseToken: claim.leaseToken,
    tenantId: claim.tenantId,
    workspaceId: claim.workspaceId,
    secretReference: claim.secretReference,
  });
}

function verifyConnectorSecretUnreadable(
  secrets: PrivacyLifecycleSecretManager | CapabilityBoundSecretLifecycleGateway,
  claim: SecretDeletionWork,
): Promise<boolean> {
  if ('verifyAuthorizedConnectorSecretUnreadable' in secrets) {
    return secrets.verifyAuthorizedConnectorSecretUnreadable({
      source: {
        channelAuthorizationId: claim.channelAuthorizationId,
        leaseToken: claim.leaseToken,
      },
      expected: {
        tenantId: claim.tenantId,
        workspaceId: claim.workspaceId,
        secretReference: claim.secretReference,
      },
    });
  }
  return secrets.verifyUnreadable({
    channelAuthorizationId: claim.channelAuthorizationId,
    leaseToken: claim.leaseToken,
    tenantId: claim.tenantId,
    workspaceId: claim.workspaceId,
    secretReference: claim.secretReference,
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function readWorkloadWorkspaceFromKey(tenantId: string, objectKey: string): string | null {
  const prefix = `tenants/${tenantId.toLowerCase()}/workspaces/`;
  if (!objectKey.startsWith(prefix)) return null;
  const workspaceId = objectKey.slice(prefix.length).split('/', 1)[0] ?? '';
  return isUuid(workspaceId) ? workspaceId.toLowerCase() : null;
}

function privacyObjectScope(
  tenantId: string,
  objectClass: LegalHoldReconciliationWork['objectClass'],
  objectKey: string,
): {
  scopeKind: 'TENANT' | 'WORKSPACE';
  workspaceId: string | null;
  objectClass: PrivacyObjectInventoryBucket;
} {
  if (objectClass === 'TENANT_EXPORT') {
    return { scopeKind: 'TENANT', workspaceId: null, objectClass: 'TENANT_EXPORTS' };
  }
  if (objectClass === 'AUDIT_DIGEST') {
    return { scopeKind: 'TENANT', workspaceId: null, objectClass: 'AUDIT_EVIDENCE' };
  }
  const workspaceId = readWorkloadWorkspaceFromKey(tenantId, objectKey);
  return workspaceId === null
    ? { scopeKind: 'TENANT', workspaceId: null, objectClass: 'WORKLOAD_OBJECTS' }
    : { scopeKind: 'WORKSPACE', workspaceId, objectClass: 'WORKLOAD_OBJECTS' };
}

function requireDatabaseSelectedDeletionAuthority(object: {
  scopeKind?: 'TENANT' | 'WORKSPACE';
  workspaceId?: string | null;
  storageClass?: PrivacyObjectInventoryBucket;
  headEligible?: boolean;
}): {
  scopeKind: 'TENANT' | 'WORKSPACE';
  workspaceId: string | null;
  objectClass: PrivacyObjectInventoryBucket;
  headEligible: boolean;
} {
  if (
    (object.scopeKind !== 'TENANT' && object.scopeKind !== 'WORKSPACE') ||
    object.workspaceId === undefined ||
    (object.storageClass !== 'WORKLOAD_OBJECTS' &&
      object.storageClass !== 'TENANT_EXPORTS' &&
      object.storageClass !== 'AUDIT_EVIDENCE') ||
    typeof object.headEligible !== 'boolean'
  ) {
    throw new Error('PRIVACY_DELETION_OBJECT_AUTHORITY_INVALID');
  }
  if (
    (object.scopeKind === 'TENANT' && object.workspaceId !== null) ||
    (object.scopeKind === 'WORKSPACE' &&
      (object.workspaceId === null || !isUuid(object.workspaceId))) ||
    (object.storageClass !== 'WORKLOAD_OBJECTS' &&
      (object.scopeKind !== 'TENANT' || object.workspaceId !== null))
  ) {
    throw new Error('PRIVACY_DELETION_OBJECT_AUTHORITY_INVALID');
  }
  return {
    scopeKind: object.scopeKind,
    workspaceId: object.workspaceId,
    objectClass: object.storageClass,
    headEligible: object.headEligible,
  };
}

function parseExactInstant(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? parsed : null;
}

function isCanonicalBackupEvidence(
  canonicalEvidence: string,
  expectedHash: string,
  requestId: string,
  sourceDeletedAt: string,
  verifiedAt: string,
): boolean {
  if (
    typeof canonicalEvidence !== 'string' ||
    canonicalEvidence.length < 2 ||
    Buffer.byteLength(canonicalEvidence, 'utf8') > 1_048_576
  ) {
    return false;
  }
  try {
    const parsed = JSON.parse(canonicalEvidence) as unknown;
    if (
      parsed === null ||
      Array.isArray(parsed) ||
      typeof parsed !== 'object' ||
      canonicalJson(parsed) !== canonicalEvidence
    ) {
      return false;
    }
    const evidence = parsed as Record<string, unknown>;
    return (
      evidence.inventoryMethod === 'ListRecoveryPointsByResource' &&
      evidence.managedByAWSBackupOnly === false &&
      evidence.requestId === requestId.toLowerCase() &&
      evidence.schemaVersion === '2.0.0' &&
      evidence.sourceDeletedAt === sourceDeletedAt &&
      evidence.verifiedAt === verifiedAt &&
      createHash('sha256').update(canonicalEvidence).digest('hex') === expectedHash
    );
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

async function waitForNextPoll(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, delayMs);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
