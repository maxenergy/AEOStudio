import { randomUUID } from 'node:crypto';

import type {
  AuditDigest,
  AuditIntegrityVerification,
  AuditTimeline,
  BreakGlassGrantRecord,
  PrivacyOverview,
  TenantDeletionReceipt,
  TenantExportManifest,
  TenantVisibleLegalHold,
} from '@aeostudio/contracts/privacy-audit';
import { TenantExportManifestSchema } from '@aeostudio/contracts/privacy-audit';
import {
  canonicalPrivacyJson,
  privacySha256,
  type AuditEvidenceObjectLockStore,
  type BackupDeletionEvidenceStore,
  type DeletionObjectInventoryStore,
  type LegalHoldReconciliationStore,
  type PhysicalDeletionLifecycleStore,
  type JsonValue,
  type PrivacyAuditStore,
  type PrivacyObjectWriteIntentStore,
  type PrivacyObjectWriteIntentWork,
  type RequestDeletionStoreResult,
  type StoredPrivacyObjectVersion,
  type TenantExportCanonicalFile,
  type TenantExportObjectStorage,
  type TenantExportSourceObject,
} from '@aeostudio/application/privacy-audit';
import type { TenantContext } from '@aeostudio/application/identity-access';
import type { CapabilityBoundTenantExportArchiveReader } from '@aeostudio/application/tenant-data-access';
import type { Pool, PoolClient } from 'pg';

import { TenantContextRunner } from '../tenant-context/index.js';

interface TenantExportObjectRow {
  tenant_id: string;
  workspace_id: string | null;
  kind: string;
  object_id: string;
  occurred_at: Date;
  payload: JsonValue;
}

interface TenantExportRow {
  id: string;
  status: 'ARCHIVE_PENDING' | 'ARCHIVE_READY' | 'FAILED';
  checksum: string;
  object_ref: string | null;
  object_version_id?: string | null;
  object_checksum?: string | null;
  manifest?: TenantExportManifest;
  requested_at: Date;
}

interface TenantExportArchiveRow {
  id: string;
  checksum: string;
  manifest: TenantExportManifest;
  object_ref: string;
  object_key: string;
  object_version_id: string;
  object_checksum: string;
}

interface DeletionRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  scope_kind: 'TENANT' | 'WORKSPACE';
  state:
    | 'FROZEN'
    | 'FINALIZING'
    | 'ACTIVE_DATA_DELETED'
    | 'BACKUP_DELETED'
    | 'TOMBSTONED'
    | 'BLOCKED_BY_LEGAL_HOLD'
    | 'FAILED';
  requested_by_user_id: string;
  reason: string;
  request_hash?: string;
  requested_at: Date;
  frozen_at: Date;
  active_delete_by: Date;
  backup_delete_by: Date;
  secret_force_delete_by: Date;
}

interface LegalHoldRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  name: string;
  reason: string;
  visible_to_tenant: true;
  status: 'ACTIVE' | 'RELEASED';
  created_by_user_id: string;
  created_at: Date;
  released_at: Date | null;
  object_key: string;
  object_version_id: string;
}

interface BreakGlassRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  operator_id: string;
  operator_name: string;
  reason: string;
  audit_event_id: string;
  requested_action: string;
  resource_type: string;
  resource_id: string;
  granted_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

interface BreakGlassDecisionRow {
  decision: 'ALLOW' | 'DENY';
  state: 'ACTIVE' | 'NOT_YET_ACTIVE' | 'EXPIRED' | 'REVOKED' | 'INVALID_GRANT';
  grant_id: string | null;
  operator_name: string | null;
  reason: string | null;
  audit_event_id: string;
}

interface AuditVerificationRow {
  valid: boolean;
  event_count: number | string;
  last_sequence: number | string;
  head_hash: string | null;
  failure_reason: string | null;
}

interface AuditTimelineRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  sequence: number | string;
  previous_hash: string | null;
  event_hash: string;
  actor_kind: 'USER' | 'AGENT' | 'SYSTEM' | 'SUPPORT' | 'PLATFORM_OPERATOR';
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: string;
  metadata: Record<string, unknown>;
  occurred_at: Date;
}

interface AuditDigestRow {
  id: string;
  tenant_id: string;
  schema_version: 'audit-digest.v1';
  range_from: Date;
  range_to: Date;
  event_count: number | string;
  last_sequence: number | string;
  head_hash: string | null;
  digest_hash: string;
  object_ref: string;
  object_key: string;
  object_version_id: string;
  locked_until: Date;
  sealed_at: Date;
}

interface AuditDigestPreparationRow {
  status: 'READY' | 'TAMPERED' | 'INVALID_TIME_RANGE';
  event_count: number | string;
  last_sequence: number | string;
  head_hash: string | null;
  failure_reason: string | null;
  sealed_at: Date | null;
  locked_until: Date | null;
}

interface TenantLifecycleRow {
  lifecycle_state: 'ACTIVE' | 'FROZEN' | 'ACTIVE_DATA_DELETED' | 'TOMBSTONED';
}

interface LatestAuditRow {
  occurred_at: Date | null;
}

interface DeletionFinalizationRow {
  request_id: string;
  state: 'ACTIVE_DATA_DELETED' | 'BACKUP_DELETED' | 'TOMBSTONED' | 'BLOCKED_BY_LEGAL_HOLD';
  effective_at: Date;
  tombstone_id: string | null;
}

interface DeletionRequestWorkRow {
  request_id: string;
  stage: 'ACTIVE' | 'OBJECT' | 'BACKUP' | 'TOMBSTONE';
  lease_token: string;
  lease_expires_at: Date;
}

interface BackupDeletionVerificationTargetRow {
  request_id: string;
  source_deleted_at: Date;
}

interface DueDeletionObjectVersionRow {
  tenant_id: string;
  object_class:
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
  object_key: string;
  object_version_id: string;
  legal_hold: boolean;
  is_delete_marker: boolean;
  scope_kind: string;
  workspace_id: string | null;
  storage_class: string;
  head_eligible: boolean;
}

interface LegalHoldReconciliationWorkRow {
  tenant_id: string;
  object_class: DueDeletionObjectVersionRow['object_class'];
  object_key: string;
  object_version_id: string;
  desired_status: 'ON' | 'OFF';
  desired_revision: number | string;
  lease_token: string;
  lease_expires_at: Date;
}

interface SecretDeletionWorkRow {
  tenant_id: string;
  workspace_id: string;
  channel_authorization_id: string;
  deletion_request_id: string;
  secret_reference: string;
  force_delete_at: Date;
  state: 'REVOKED_PENDING_FORCE_DELETE' | 'FORCE_DELETE_REQUESTED' | 'FAILED';
  lease_token: string;
  lease_expires_at: Date;
}

interface PrivacyObjectWriteIntentRow {
  operation_id: string;
  kind: 'TENANT_EXPORT' | 'AUDIT_DIGEST';
  tenant_id: string;
  workspace_id: string;
  object_key: string;
  canonical_payload: Buffer;
  checksum: string;
  content_type: string;
  locked_until: Date | null;
  sealed_at: Date | null;
  lease_token: string;
  lease_expires_at: Date;
}

interface DeletionObjectInventoryTargetRow {
  status:
    | 'REQUIRED'
    | 'COMPLETE'
    | 'NOT_REQUIRED'
    | 'PENDING_WRITES'
    | 'DRAINING_WRITES'
    | 'INVALID_LEASE';
  request_id: string | null;
  tenant_id: string | null;
}

interface DeletionObjectInventoryPageTargetRow extends DeletionObjectInventoryTargetRow {
  scope_kind: 'TENANT' | 'WORKSPACE' | null;
  workspace_id: string | null;
  bucket_kind: 'TENANT_EXPORTS' | 'AUDIT_EVIDENCE' | 'WORKLOAD_OBJECTS' | null;
  inventory_cursor: string | null;
}

const EXPORT_OBJECT_QUERY = `
  SELECT tenant_id, workspace_id, kind, object_id, occurred_at, payload
  FROM (
    SELECT revision.tenant_id, revision.workspace_id, 'PROFILE_REVISION'::text AS kind,
      revision.id::text AS object_id, revision.created_at AS occurred_at,
      jsonb_build_object(
        'id', revision.id,
        'profileId', revision.profile_id,
        'revision', revision.revision,
        'contentHash', revision.content_hash,
        'content', revision.content,
        'completeness', revision.completeness,
        'createdAt', revision.created_at
      ) AS payload
    FROM profiles profile
    JOIN profile_revisions revision
     ON revision.tenant_id = profile.tenant_id
     AND revision.workspace_id = profile.workspace_id
     AND revision.profile_id = profile.id
    WHERE profile.tenant_id = $1

    UNION ALL

    SELECT revision.tenant_id, revision.workspace_id, 'OFFERING_REVISION'::text, revision.id::text,
      revision.created_at,
      jsonb_build_object(
        'id', revision.id,
        'offeringId', revision.offering_id,
        'profileId', revision.profile_id,
        'revision', revision.revision,
        'contentHash', revision.content_hash,
        'content', revision.content,
        'completeness', revision.completeness,
        'createdAt', revision.created_at
      )
    FROM offerings offering
    JOIN offering_revisions revision
     ON revision.tenant_id = offering.tenant_id
     AND revision.workspace_id = offering.workspace_id
     AND revision.offering_id = offering.id
    WHERE offering.tenant_id = $1

    UNION ALL

    SELECT revision.tenant_id, revision.workspace_id, 'CLAIM_REVISION'::text, revision.id::text,
      revision.created_at,
      jsonb_build_object(
        'id', revision.id,
        'claimId', revision.claim_id,
        'revision', revision.revision,
        'statement', revision.statement,
        'numericValue', revision.numeric_value,
        'unit', revision.unit,
        'scope', revision.scope,
        'conditions', revision.conditions,
        'expiresAt', revision.expires_at,
        'contentHash', revision.content_hash,
        'status', revision.status,
        'createdAt', revision.created_at
      )
    FROM claims claim
    JOIN claim_revisions revision
     ON revision.tenant_id = claim.tenant_id
     AND revision.workspace_id = claim.workspace_id
     AND revision.claim_id = claim.id
    WHERE claim.tenant_id = $1

    UNION ALL

    SELECT revision.tenant_id, revision.workspace_id, 'ARTIFACT'::text, revision.id::text,
      revision.created_at,
      jsonb_build_object(
        'id', revision.id,
        'artifactId', revision.artifact_id,
        'revision', revision.revision,
        'artifactType', revision.artifact_type,
        'schemaVersion', revision.schema_version,
        'contentHash', revision.content_hash,
        'status', revision.status,
        'locale', revision.locale,
        'market', revision.market,
        'sourceArtifactIds', revision.source_artifact_ids,
        'lineage', revision.lineage,
        'claimBindings', revision.claim_bindings,
        'methodPolicyVersion', revision.method_policy_version,
        'payloadObjectRef', revision.payload_object_ref,
        'createdAt', revision.created_at
      )
    FROM artifacts artifact
    JOIN artifact_revisions revision
     ON revision.tenant_id = artifact.tenant_id
     AND revision.workspace_id = artifact.workspace_id
     AND revision.artifact_id = artifact.id
    WHERE artifact.tenant_id = $1

    UNION ALL

    SELECT run.tenant_id, run.workspace_id, 'MEASUREMENT_RUN'::text, run.id::text, run.created_at,
      jsonb_build_object(
        'id', run.id,
        'kind', run.kind,
        'status', run.status,
        'providerKey', run.provider_key,
        'surfaceKey', run.surface_key,
        'model', run.model,
        'modelVersion', run.model_version,
        'acquisitionClass', run.acquisition_class,
        'acquisitionMethod', run.acquisition_method,
        'adapterVersion', run.adapter_version,
        'scenarioId', run.scenario_id,
        'scenarioVersion', run.scenario_version,
        'createdAt', run.created_at,
        'startedAt', run.started_at,
        'completedAt', run.completed_at
      )
    FROM measurement_runs run
    WHERE run.tenant_id = $1

    UNION ALL

    SELECT snapshot.tenant_id, snapshot.workspace_id, 'METRIC_SNAPSHOT'::text, snapshot.id::text,
      snapshot.created_at,
      jsonb_build_object(
        'id', snapshot.id,
        'measurementRunId', snapshot.measurement_run_id,
        'schemaVersion', snapshot.schema_version,
        'metricKey', snapshot.metric_key,
        'scopeKey', snapshot.scope_key,
        'methodVersion', snapshot.method_version,
        'cohort', snapshot.cohort,
        'numerator', snapshot.numerator,
        'eligibleDenominator', snapshot.eligible_denominator,
        'value', snapshot.value,
        'excludedCounts', snapshot.excluded_counts,
        'sourceObservationIds', snapshot.source_observation_ids,
        'sourceHash', snapshot.source_hash,
        'contentHash', snapshot.content_hash,
        'createdAt', snapshot.created_at
      )
    FROM metric_snapshots snapshot
    WHERE snapshot.tenant_id = $1

    UNION ALL

    SELECT publication.tenant_id, publication.workspace_id, 'PUBLICATION'::text,
      publication.id::text, publication.created_at,
      jsonb_build_object(
        'id', publication.id,
        'channelPackageId', publication.channel_package_id,
        'packageChecksum', publication.package_checksum,
        'artifactRevisionId', publication.artifact_revision_id,
        'artifactContentHash', publication.artifact_content_hash,
        'adapterVersionId', publication.adapter_version_id,
        'status', publication.status,
        'createdAt', publication.created_at,
        'updatedAt', publication.updated_at
      )
    FROM publication_records publication
    WHERE publication.tenant_id = $1

    UNION ALL

    SELECT event.tenant_id, event.workspace_id, 'AUDIT_EVENT'::text, event.id::text,
      event.occurred_at,
      jsonb_build_object(
        'id', event.id,
        'workspaceId', event.workspace_id,
        'actorKind', event.actor_principal_kind,
        'actorId', event.actor_principal_id,
        'action', event.action,
        'resourceType', event.resource_type,
        'resourceId', event.resource_id,
        'outcome', event.outcome,
        'occurredAt', event.occurred_at
      )
    FROM audit_events event
    WHERE event.tenant_id = $1
  ) export_objects
  WHERE occurred_at >= $2 AND occurred_at <= $3
  ORDER BY kind, object_id`;

const LEGAL_HOLD_COLUMNS_QUERY = `SELECT hold.id, hold.tenant_id, hold.workspace_id, hold.name,
  hold.reason, hold.visible_to_tenant, hold.status, hold.created_by_user_id, hold.created_at,
  hold.released_at, target.object_key, target.object_version_id
  FROM legal_holds hold
  JOIN legal_hold_object_versions target
    ON target.tenant_id = hold.tenant_id AND target.hold_id = hold.id`;

const RAW_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export class PostgresPrivacyAuditStore
  implements
    PrivacyAuditStore,
    PhysicalDeletionLifecycleStore,
    BackupDeletionEvidenceStore,
    LegalHoldReconciliationStore,
    PrivacyObjectWriteIntentStore,
    DeletionObjectInventoryStore
{
  private readonly contexts: TenantContextRunner;

  public constructor(
    private readonly pool: Pool,
    private readonly options?: {
      objects?: TenantExportObjectStorage & AuditEvidenceObjectLockStore;
      privacyWriter?: {
        putAuthorizedPrivacyVersion(
          input: PrivacyObjectWriteIntentWork,
        ): Promise<StoredPrivacyObjectVersion>;
      };
      tenantExportReader?: CapabilityBoundTenantExportArchiveReader;
    },
  ) {
    this.contexts = new TenantContextRunner(pool);
  }

  public loadTenantExportObjects(
    input: Parameters<PrivacyAuditStore['loadTenantExportObjects']>[0],
  ): ReturnType<PrivacyAuditStore['loadTenantExportObjects']> {
    return this.contexts.runActive(input.context, async (client) => {
      await lockAuthorizedActiveTenantForExport(client, input.context);
      const result = await client.query<TenantExportObjectRow>(EXPORT_OBJECT_QUERY, [
        input.context.tenantId,
        input.from,
        input.to,
      ]);
      return {
        outcome: 'SUCCEEDED',
        objects: result.rows.map(mapExportObject),
      };
    });
  }

  public saveTenantExport(
    input: Parameters<PrivacyAuditStore['saveTenantExport']>[0],
  ): ReturnType<PrivacyAuditStore['saveTenantExport']> {
    if (this.options !== undefined) return this.saveDurableTenantExport(input);
    return this.contexts.runActive(input.context, async (client) => {
      await lockAuthorizedActiveTenantForExport(client, input.context);
      const inserted = await client.query<TenantExportRow>(
        `INSERT INTO tenant_exports
          (id, tenant_id, workspace_id, schema_version, request_hash, requested_by_user_id,
            requested_at, range_from, range_to, manifest, checksum, object_ref,
            object_version_id, object_checksum, completed_at, status)
         VALUES ($1, $2, $3, '1.0.0', $4, $5, $6, $7, $8, $9::jsonb,
           $10, NULL, NULL, NULL, NULL, 'ARCHIVE_PENDING')
         ON CONFLICT (tenant_id, request_hash) DO NOTHING
         RETURNING id, status, checksum, object_ref, requested_at`,
        [
          input.exportId,
          input.context.tenantId,
          input.context.workspaceId,
          input.requestHash,
          input.context.actorUserId,
          input.createdAt,
          input.manifest.timeRange.from,
          input.manifest.timeRange.to,
          JSON.stringify(input.manifest),
          input.checksum,
        ],
      );
      const created = inserted.rows[0];
      if (created !== undefined) {
        for (const [offset, object] of input.manifest.objects.entries()) {
          await client.query(
            `INSERT INTO tenant_export_items
              (tenant_id, export_id, ordinal, object_kind, source_object_id,
                source_content_hash, exported_content_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $6)`,
            [
              input.context.tenantId,
              input.exportId,
              offset + 1,
              object.kind,
              object.objectId,
              object.contentHash,
            ],
          );
        }
        if (this.options?.objects !== undefined) {
          const archive = buildTenantExportArchive(
            input.canonicalFiles,
            input.manifest,
            input.checksum,
          );
          if (archive === null) throw new Error('TENANT_EXPORT_ARCHIVE_INVALID');
          const objectKey = `tenants/${input.context.tenantId}/exports/${input.exportId}.bundle.json`;
          const object = await this.options.objects.putExportVersion({
            tenantId: input.context.tenantId,
            objectKey,
            body: archive.body,
            contentType: 'application/json',
            checksum: archive.checksum,
          });
          assertStoredObject(object, {
            tenantId: input.context.tenantId,
            objectKey,
            checksum: archive.checksum,
            contentType: 'application/json',
            byteLength: archive.body.byteLength,
            lockedUntil: null,
          });
          const completedAt = new Date(object.createdAt);
          const completed = await client.query<{ completed: boolean }>(
            `SELECT complete_tenant_export_archive(
               $1, $2, $3, $4, $5, $6, $7, $8, $9
             ) AS completed`,
            [
              input.context.tenantId,
              input.exportId,
              object.objectRef,
              object.objectKey,
              object.objectVersionId,
              object.checksum,
              object.contentType,
              object.byteLength,
              completedAt,
            ],
          );
          if (completed.rows[0]?.completed !== true) {
            throw new Error('TENANT_EXPORT_ARCHIVE_COMPLETION_FAILED');
          }
          await insertAuditEvent(client, {
            id: input.auditEventId,
            context: input.context,
            action: 'TENANT_EXPORT_CREATED',
            resourceType: 'TENANT_EXPORT',
            resourceId: input.exportId,
            metadata: {
              schemaVersion: '1.0.0',
              checksum: input.checksum,
              objectKey: object.objectKey,
              objectVersionId: object.objectVersionId,
            },
            occurredAt: completedAt,
          });
          return {
            outcome: 'SUCCEEDED',
            exportId: created.id,
            created: true,
            archiveStatus: 'READY',
            archiveReady: true,
            objectRef: object.objectRef,
            createdAt: created.requested_at.toISOString(),
          };
        }
        await insertAuditEvent(client, {
          id: input.auditEventId,
          context: input.context,
          action: 'TENANT_EXPORT_ARCHIVE_QUEUED',
          resourceType: 'TENANT_EXPORT',
          resourceId: input.exportId,
          metadata: { schemaVersion: '1.0.0', checksum: input.checksum },
          occurredAt: input.createdAt,
        });
        return {
          outcome: 'SUCCEEDED',
          exportId: created.id,
          created: true,
          archiveStatus: 'PENDING',
          archiveReady: false,
          objectRef: created.object_ref,
          createdAt: created.requested_at.toISOString(),
        };
      }

      const existing = await client.query<TenantExportRow>(
        `SELECT id, status, checksum, object_ref, requested_at
         FROM tenant_exports
         WHERE tenant_id = $1 AND request_hash = $2`,
        [input.context.tenantId, input.requestHash],
      );
      const row = existing.rows[0];
      if (row === undefined) return { outcome: 'PIPELINE_UNAVAILABLE' };
      if (row.checksum !== input.checksum) return { outcome: 'IDEMPOTENCY_CONFLICT' };
      return {
        outcome: 'SUCCEEDED',
        exportId: row.id,
        created: false,
        archiveStatus:
          row.status === 'ARCHIVE_READY' ? 'READY' : row.status === 'FAILED' ? 'FAILED' : 'PENDING',
        archiveReady: row.status === 'ARCHIVE_READY',
        objectRef: row.object_ref,
        createdAt: row.requested_at.toISOString(),
      };
    });
  }

  public async claimPendingPrivacyObjectWriteIntents(
    input: Parameters<PrivacyObjectWriteIntentStore['claimPendingPrivacyObjectWriteIntents']>[0],
  ): ReturnType<PrivacyObjectWriteIntentStore['claimPendingPrivacyObjectWriteIntents']> {
    const result = await this.pool.query<PrivacyObjectWriteIntentRow>(
      `SELECT operation_id, kind, tenant_id, workspace_id, object_key,
         canonical_payload, checksum, content_type, locked_until, sealed_at,
         lease_token, lease_expires_at
       FROM claim_pending_privacy_object_write_intents($1, $2)`,
      [input.leaseToken, input.limit],
    );
    return result.rows.map(mapPrivacyObjectWriteIntent);
  }

  public async completePrivacyObjectWriteIntent(
    input: Parameters<PrivacyObjectWriteIntentStore['completePrivacyObjectWriteIntent']>[0],
  ): ReturnType<PrivacyObjectWriteIntentStore['completePrivacyObjectWriteIntent']> {
    const result = await this.pool.query<{ completed: boolean }>(
      `SELECT complete_privacy_object_write_intent(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
       ) AS completed`,
      [
        input.operationId,
        input.leaseToken,
        input.object.objectRef,
        input.object.objectKey,
        input.object.objectVersionId,
        input.object.checksum,
        input.object.contentType,
        input.object.byteLength,
        new Date(input.object.createdAt),
        input.object.lockedUntil === null ? null : new Date(input.object.lockedUntil),
      ],
    );
    return result.rows[0]?.completed === true;
  }

  public async releasePrivacyObjectWriteIntentLease(
    input: Parameters<PrivacyObjectWriteIntentStore['releasePrivacyObjectWriteIntentLease']>[0],
  ): ReturnType<PrivacyObjectWriteIntentStore['releasePrivacyObjectWriteIntentLease']> {
    const retryDelayMs = input.retryDelayMs ?? 0;
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 300_000) {
      throw new Error('PRIVACY_OBJECT_WRITE_RETRY_DELAY_INVALID');
    }
    const retryDelaySeconds = Math.ceil(retryDelayMs / 1_000);
    const result = await this.pool.query<{ released: boolean }>(
      'SELECT release_privacy_object_write_intent_lease($1, $2, NULL, $3) AS released',
      [input.operationId, input.leaseToken, retryDelaySeconds],
    );
    return result.rows[0]?.released === true;
  }

  public async readTenantExportArchive(input: {
    sessionToken: string;
    context: TenantContext;
    exportId: string;
  }): Promise<{
    body: Uint8Array;
    manifestChecksum: string;
    archiveChecksum: string;
    filename: string;
  } | null> {
    if (!RAW_SESSION_TOKEN_PATTERN.test(input.sessionToken)) return null;
    const reader = this.options?.tenantExportReader;
    if (reader === undefined) return null;
    const row = await this.contexts.runActive(input.context, async (client) => {
      await lockAuthorizedActiveTenantForExport(client, input.context);
      const result = await client.query<TenantExportArchiveRow>(
        `SELECT export.id, export.checksum, export.manifest, export.object_ref,
           object.object_key, export.object_version_id, export.object_checksum
         FROM tenant_exports export
         JOIN managed_object_versions object
           ON object.tenant_id = export.tenant_id
          AND object.object_ref = export.object_ref
          AND object.object_version_id = export.object_version_id
          AND object.checksum = export.object_checksum
          AND object.object_class = 'TENANT_EXPORT'
          AND object.lifecycle_state = 'ACTIVE'
         WHERE export.tenant_id = $1 AND export.id = $2
           AND export.status = 'ARCHIVE_READY'`,
        [input.context.tenantId, input.exportId],
      );
      return result.rows[0] ?? null;
    });
    if (row === null) return null;
    const expected = {
      objectRef: row.object_ref,
      objectKey: row.object_key,
      objectVersionId: row.object_version_id,
      checksum: row.object_checksum,
    };
    const stored = await reader.readAuthenticatedTenantExportArchive({
      sessionToken: input.sessionToken,
      context: input.context,
      authority: { kind: 'TENANT_EXPORT', exportId: row.id },
      expected,
    });
    if (
      stored === null ||
      stored.object.tenantId !== input.context.tenantId ||
      stored.object.objectRef !== expected.objectRef ||
      stored.object.objectKey !== expected.objectKey ||
      stored.object.objectVersionId !== expected.objectVersionId ||
      stored.object.checksum !== expected.checksum ||
      privacySha256(stored.body) !== row.object_checksum ||
      !archiveManifestMatches(stored.body, row.manifest, row.checksum)
    ) {
      return null;
    }
    return {
      body: new Uint8Array(stored.body),
      manifestChecksum: row.checksum,
      archiveChecksum: row.object_checksum,
      filename: `tenant-export-${row.id}.json`,
    };
  }

  public getPrivacyOverview(
    input: Parameters<PrivacyAuditStore['getPrivacyOverview']>[0],
  ): ReturnType<PrivacyAuditStore['getPrivacyOverview']> {
    return this.contexts.run(input.context, async (client) => {
      const tenantResult = await client.query<TenantLifecycleRow>(
        `SELECT lifecycle_state
         FROM tenants
         WHERE id = $1`,
        [input.context.tenantId],
      );
      const tenant = tenantResult.rows[0];
      if (tenant === undefined) return { outcome: 'NOT_FOUND' };

      const holds = await this.listLegalHoldsInContext(client, input.context, false);
      const grantRows = await client.query<BreakGlassRow>(
        `SELECT id, tenant_id, workspace_id, operator_id, operator_name, reason,
           audit_event_id, requested_action, resource_type, resource_id,
           granted_at, expires_at, revoked_at
         FROM break_glass_grants
         WHERE tenant_id = $1 AND workspace_id = $2
         ORDER BY granted_at DESC, id DESC`,
        [input.context.tenantId, input.context.workspaceId],
      );
      const latestAuditResult = await client.query<LatestAuditRow>(
        `SELECT max(occurred_at) AS occurred_at
         FROM audit_events
         WHERE tenant_id = $1 AND (workspace_id IS NULL OR workspace_id = $2)`,
        [input.context.tenantId, input.context.workspaceId],
      );
      const deletionResult = await client.query<DeletionRow>(
        `SELECT id, tenant_id, workspace_id, scope_kind, state, requested_by_user_id, reason,
           request_hash, requested_at, frozen_at, active_delete_by, backup_delete_by,
           secret_force_delete_by
         FROM deletion_requests
         WHERE tenant_id = $1 AND (workspace_id IS NULL OR workspace_id = $2)
         ORDER BY requested_at DESC, id DESC
         LIMIT 1`,
        [input.context.tenantId, input.context.workspaceId],
      );

      return {
        outcome: 'SUCCEEDED',
        overview: {
          tenantId: input.context.tenantId,
          lifecycleState: mapTenantLifecycleState(tenant.lifecycle_state),
          retention: {
            activeTenantDataDays: 30,
            backupCopyDays: 90,
            secretForceDeleteHours: 24,
            rawEvidenceDays: 180,
            screenshotDays: 90,
            applicationLogDays: 30,
            auditEvidenceDays: 365,
          },
          legalHolds: holds,
          breakGlassGrants: grantRows.rows.map(mapBreakGlass),
          latestAuditEventAt: latestAuditResult.rows[0]?.occurred_at?.toISOString() ?? null,
          latestDeletionReceipt:
            deletionResult.rows[0] === undefined
              ? null
              : mapDeletionReceipt(deletionResult.rows[0]),
        },
      };
    });
  }

  public listAuditEvents(
    input: Parameters<PrivacyAuditStore['listAuditEvents']>[0],
  ): ReturnType<PrivacyAuditStore['listAuditEvents']> {
    return this.contexts.run(input.context, async (client) => {
      const cursorSequence = parseAuditCursor(input.cursor);
      if (input.cursor !== null && cursorSequence === null) return { outcome: 'NOT_FOUND' };
      const limit = Math.max(1, Math.min(200, input.limit));
      const result = await client.query<AuditTimelineRow>(
        `SELECT id, tenant_id, workspace_id, chain_sequence AS sequence, previous_hash, event_hash,
           actor_principal_kind AS actor_kind, actor_principal_id AS actor_id,
           action, resource_type, resource_id::text, outcome, metadata, occurred_at
         FROM audit_events
         WHERE tenant_id = $1
           AND (workspace_id IS NULL OR workspace_id = $2)
           AND occurred_at >= $3 AND occurred_at <= $4
           AND ($5::bigint IS NULL OR chain_sequence < $5::bigint)
         ORDER BY chain_sequence DESC, id DESC
         LIMIT $6`,
        [
          input.context.tenantId,
          input.context.workspaceId,
          input.from,
          input.to,
          cursorSequence,
          limit + 1,
        ],
      );
      const hasMore = result.rows.length > limit;
      const page = hasMore ? result.rows.slice(0, limit) : result.rows;
      const last = page.at(-1);
      const timeline: AuditTimeline = {
        events: page.map((row) => ({
          id: row.id,
          tenantId: row.tenant_id,
          workspaceId: row.workspace_id,
          sequence: toSafeInteger(row.sequence, 'AUDIT_SEQUENCE_OUT_OF_RANGE'),
          previousHash: row.previous_hash,
          eventHash: row.event_hash,
          actorKind: row.actor_kind,
          actorId: row.actor_id,
          action: row.action,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          outcome: row.outcome,
          metadata: row.metadata,
          occurredAt: row.occurred_at.toISOString(),
        })),
        nextCursor:
          hasMore && last !== undefined
            ? toSafeInteger(last.sequence, 'AUDIT_SEQUENCE_OUT_OF_RANGE').toString()
            : null,
      };
      return { outcome: 'SUCCEEDED', timeline };
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
    try {
      const result = await this.pool.query<DeletionFinalizationRow>(
        'SELECT * FROM finalize_deletion($1, $2, $3, $4, $5)',
        [
          input.requestId,
          input.leaseToken,
          input.effectiveAt,
          input.tombstoneId,
          input.auditEventId,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) return { outcome: 'NOT_FOUND' };
      if (row.state === 'BLOCKED_BY_LEGAL_HOLD') return { outcome: 'LEGAL_HOLD' };
      return {
        outcome: 'SUCCEEDED',
        finalization: {
          requestId: row.request_id,
          state: row.state,
          effectiveAt: row.effective_at.toISOString(),
          tombstoneId: row.tombstone_id,
        },
      };
    } catch (error) {
      const message = postgresErrorMessage(error);
      if (/FINALIZATION_LEASE_INVALID/iu.test(message)) return { outcome: 'INVALID_LEASE' };
      if (/NOT_DUE/iu.test(message)) return { outcome: 'NOT_DUE' };
      if (/LEGAL_HOLD/iu.test(message)) return { outcome: 'LEGAL_HOLD' };
      return { outcome: 'PIPELINE_UNAVAILABLE' };
    }
  }

  public async claimDueDeletionRequests(
    input: Parameters<PrivacyAuditStore['claimDueDeletionRequests']>[0],
  ): ReturnType<PrivacyAuditStore['claimDueDeletionRequests']> {
    const result = await this.pool.query<DeletionRequestWorkRow>(
      `SELECT request_id, stage, lease_token, lease_expires_at
       FROM claim_due_deletion_requests($1, $2)`,
      [input.leaseToken, input.limit],
    );
    return result.rows.map((row) => ({
      requestId: row.request_id,
      stage: row.stage,
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at.toISOString(),
    }));
  }

  public async getBackupDeletionVerificationTarget(
    input: Parameters<BackupDeletionEvidenceStore['getBackupDeletionVerificationTarget']>[0],
  ): ReturnType<BackupDeletionEvidenceStore['getBackupDeletionVerificationTarget']> {
    try {
      const result = await this.pool.query<BackupDeletionVerificationTargetRow>(
        'SELECT request_id, source_deleted_at FROM get_backup_deletion_verification_target($1, $2)',
        [input.requestId, input.leaseToken],
      );
      const row = result.rows[0];
      if (row === undefined) return { outcome: 'NOT_DUE' };
      return {
        outcome: 'SUCCEEDED',
        target: {
          requestId: row.request_id,
          sourceDeletedAt: row.source_deleted_at.toISOString(),
        },
      };
    } catch (error: unknown) {
      const message = postgresErrorMessage(error);
      if (/FINALIZATION_LEASE_INVALID/iu.test(message)) return { outcome: 'INVALID_LEASE' };
      if (/BACKUP_NOT_DUE/iu.test(message)) return { outcome: 'NOT_DUE' };
      throw error;
    }
  }

  public async recordBackupDeletionVerification(
    input: Parameters<BackupDeletionEvidenceStore['recordBackupDeletionVerification']>[0],
  ): ReturnType<BackupDeletionEvidenceStore['recordBackupDeletionVerification']> {
    const result = await this.pool.query<{ recorded: boolean }>(
      `SELECT record_backup_deletion_verification($1, $2, $3, $4, $5, $6) AS recorded`,
      [
        input.requestId,
        input.leaseToken,
        input.sourceDeletedAt,
        input.verifiedAt,
        input.evidenceCanonicalJson,
        input.evidenceHash,
      ],
    );
    return result.rows[0]?.recorded === true;
  }

  public async getDeletionObjectInventoryTarget(
    input: Parameters<DeletionObjectInventoryStore['getDeletionObjectInventoryTarget']>[0],
  ): ReturnType<DeletionObjectInventoryStore['getDeletionObjectInventoryTarget']> {
    const result = await this.pool.query<DeletionObjectInventoryTargetRow>(
      'SELECT status, request_id, tenant_id FROM get_deletion_object_inventory_target($1, $2)',
      [input.requestId, input.leaseToken],
    );
    const row = result.rows[0];
    if (row === undefined) return { outcome: 'INVALID_LEASE' };
    if (row.status !== 'REQUIRED') return { outcome: row.status };
    if (row.request_id === null || row.tenant_id === null) return { outcome: 'INVALID_LEASE' };
    return {
      outcome: 'REQUIRED',
      target: { requestId: row.request_id, tenantId: row.tenant_id },
    };
  }

  public async recordDeletionObjectInventory(
    input: Parameters<DeletionObjectInventoryStore['recordDeletionObjectInventory']>[0],
  ): ReturnType<DeletionObjectInventoryStore['recordDeletionObjectInventory']> {
    const result = await this.pool.query<{ recorded: boolean }>(
      `SELECT record_deletion_object_inventory($1, $2, $3::jsonb, $4::jsonb)
         AS recorded`,
      [
        input.requestId,
        input.leaseToken,
        JSON.stringify(input.exportVersions),
        JSON.stringify(input.auditVersions),
      ],
    );
    return result.rows[0]?.recorded === true;
  }

  public async getDeletionObjectInventoryPageTarget(
    input: Parameters<
      NonNullable<DeletionObjectInventoryStore['getDeletionObjectInventoryPageTarget']>
    >[0],
  ): ReturnType<NonNullable<DeletionObjectInventoryStore['getDeletionObjectInventoryPageTarget']>> {
    const result = await this.pool.query<DeletionObjectInventoryPageTargetRow>(
      `SELECT status, request_id, tenant_id, scope_kind, workspace_id,
              bucket_kind, inventory_cursor
       FROM get_deletion_object_inventory_page_target($1, $2)`,
      [input.requestId, input.leaseToken],
    );
    const row = result.rows[0];
    if (row === undefined) return { outcome: 'INVALID_LEASE' };
    if (row.status !== 'REQUIRED') return { outcome: row.status };
    if (
      row.request_id === null ||
      row.tenant_id === null ||
      row.scope_kind === null ||
      row.bucket_kind === null ||
      (row.scope_kind === 'WORKSPACE' && row.workspace_id === null)
    ) {
      return { outcome: 'INVALID_LEASE' };
    }
    return {
      outcome: 'REQUIRED',
      target: {
        requestId: row.request_id,
        tenantId: row.tenant_id,
        scopeKind: row.scope_kind,
        workspaceId: row.workspace_id,
        bucket: row.bucket_kind,
        cursor: row.inventory_cursor,
      },
    };
  }

  public async recordDeletionObjectInventoryPage(
    input: Parameters<
      NonNullable<DeletionObjectInventoryStore['recordDeletionObjectInventoryPage']>
    >[0],
  ): ReturnType<NonNullable<DeletionObjectInventoryStore['recordDeletionObjectInventoryPage']>> {
    const result = await this.pool.query<{
      outcome: 'PROGRESS' | 'COMPLETE' | 'DRAINING_WRITES' | 'INVALID_LEASE';
    }>(
      `SELECT record_deletion_object_inventory_page(
         $1, $2, $3, $4, $5, $6::jsonb
       ) AS outcome`,
      [
        input.requestId,
        input.leaseToken,
        input.bucket,
        input.cursor,
        input.nextCursor,
        JSON.stringify(input.versions),
      ],
    );
    return { outcome: result.rows[0]?.outcome ?? 'INVALID_LEASE' };
  }

  public async listDueDeletionObjectVersions(
    input: Parameters<PhysicalDeletionLifecycleStore['listDueDeletionObjectVersions']>[0],
  ): ReturnType<PhysicalDeletionLifecycleStore['listDueDeletionObjectVersions']> {
    try {
      const result = await this.pool.query<DueDeletionObjectVersionRow>(
        `SELECT tenant_id, object_class, object_key, object_version_id, legal_hold,
                is_delete_marker, scope_kind, workspace_id, storage_class,
                head_eligible
         FROM list_due_deletion_object_versions($1, $2, $3)`,
        [input.requestId, input.leaseToken, input.limit],
      );
      return {
        outcome: 'SUCCEEDED',
        hasMore: result.rows.length > input.limit,
        objects: result.rows.slice(0, input.limit).map((row) => {
          if (
            (row.scope_kind !== 'TENANT' && row.scope_kind !== 'WORKSPACE') ||
            (row.scope_kind === 'TENANT' ? row.workspace_id !== null : row.workspace_id === null) ||
            (row.storage_class !== 'TENANT_EXPORTS' &&
              row.storage_class !== 'AUDIT_EVIDENCE' &&
              row.storage_class !== 'WORKLOAD_OBJECTS') ||
            typeof row.head_eligible !== 'boolean'
          ) {
            throw new Error('PRIVACY_DELETION_OBJECT_AUTHORITY_INVALID');
          }
          return {
            tenantId: row.tenant_id,
            objectClass: row.object_class,
            objectKey: row.object_key,
            objectVersionId: row.object_version_id,
            legalHold: row.legal_hold,
            isDeleteMarker: row.is_delete_marker,
            scopeKind: row.scope_kind,
            workspaceId: row.workspace_id,
            storageClass: row.storage_class,
            headEligible: row.head_eligible,
          };
        }),
      };
    } catch (error: unknown) {
      if (/FINALIZATION_LEASE_INVALID/iu.test(postgresErrorMessage(error))) {
        return { outcome: 'INVALID_LEASE' };
      }
      throw error;
    }
  }

  public async markDeletionObjectVersionDeleted(
    input: Parameters<PhysicalDeletionLifecycleStore['markDeletionObjectVersionDeleted']>[0],
  ): ReturnType<PhysicalDeletionLifecycleStore['markDeletionObjectVersionDeleted']> {
    const result = await this.pool.query<{ marked: boolean }>(
      `SELECT mark_deletion_object_version_deleted($1, $2, $3, $4, $5) AS marked`,
      [input.requestId, input.leaseToken, input.tenantId, input.objectKey, input.objectVersionId],
    );
    return result.rows[0]?.marked === true;
  }

  public async releaseDeletionLease(
    input: Parameters<PhysicalDeletionLifecycleStore['releaseDeletionLease']>[0],
  ): ReturnType<PhysicalDeletionLifecycleStore['releaseDeletionLease']> {
    const result = await this.pool.query<{ released: boolean }>(
      'SELECT release_deletion_work_lease($1, $2) AS released',
      [input.requestId, input.leaseToken],
    );
    return result.rows[0]?.released === true;
  }

  public async claimPendingLegalHoldReconciliations(
    input: Parameters<LegalHoldReconciliationStore['claimPendingLegalHoldReconciliations']>[0],
  ): ReturnType<LegalHoldReconciliationStore['claimPendingLegalHoldReconciliations']> {
    const result = await this.pool.query<LegalHoldReconciliationWorkRow>(
      `SELECT tenant_id, object_class, object_key, object_version_id, desired_status,
         desired_revision, lease_token, lease_expires_at
       FROM claim_pending_legal_hold_reconciliations($1, $2)`,
      [input.leaseToken, input.limit],
    );
    return result.rows.map((row) => ({
      tenantId: row.tenant_id,
      objectClass: row.object_class,
      objectKey: row.object_key,
      objectVersionId: row.object_version_id,
      desiredStatus: row.desired_status,
      revision: Number(row.desired_revision),
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at.toISOString(),
    }));
  }

  public async completeLegalHoldReconciliation(
    input: Parameters<LegalHoldReconciliationStore['completeLegalHoldReconciliation']>[0],
  ): ReturnType<LegalHoldReconciliationStore['completeLegalHoldReconciliation']> {
    const result = await this.pool.query<{ completed: boolean }>(
      `SELECT complete_legal_hold_reconciliation($1, $2, $3, $4, $5, $6)
         AS completed`,
      [
        input.tenantId,
        input.objectKey,
        input.objectVersionId,
        input.desiredStatus,
        input.revision,
        input.leaseToken,
      ],
    );
    return result.rows[0]?.completed === true;
  }

  public async releaseLegalHoldReconciliationLease(
    input: Parameters<LegalHoldReconciliationStore['releaseLegalHoldReconciliationLease']>[0],
  ): ReturnType<LegalHoldReconciliationStore['releaseLegalHoldReconciliationLease']> {
    const result = await this.pool.query<{ released: boolean }>(
      `SELECT release_legal_hold_reconciliation_lease($1, $2, $3, $4) AS released`,
      [input.tenantId, input.objectKey, input.objectVersionId, input.leaseToken],
    );
    return result.rows[0]?.released === true;
  }

  public async claimDueSecretDeletions(
    input: Parameters<PrivacyAuditStore['claimDueSecretDeletions']>[0],
  ): ReturnType<PrivacyAuditStore['claimDueSecretDeletions']> {
    const result = await this.pool.query<SecretDeletionWorkRow>(
      `SELECT tenant_id, workspace_id, channel_authorization_id, deletion_request_id,
         secret_reference, force_delete_at, state, lease_token, lease_expires_at
       FROM claim_due_secret_deletions($1, $2)`,
      [input.leaseToken, input.limit],
    );
    return result.rows.map((row) => ({
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      channelAuthorizationId: row.channel_authorization_id,
      deletionRequestId: row.deletion_request_id,
      secretReference: row.secret_reference,
      forceDeleteAt: row.force_delete_at.toISOString(),
      state: row.state,
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at.toISOString(),
    }));
  }

  public async markSecretDeletionRequested(
    input: Parameters<PrivacyAuditStore['markSecretDeletionRequested']>[0],
  ): ReturnType<PrivacyAuditStore['markSecretDeletionRequested']> {
    const result = await this.pool.query<{ marked: boolean }>(
      'SELECT worker_mark_secret_deletion_requested($1, $2, $3) AS marked',
      [input.tenantId, input.channelAuthorizationId, input.leaseToken],
    );
    return result.rows[0]?.marked === true;
  }

  public async markSecretUnreadable(
    input: Parameters<PrivacyAuditStore['markSecretUnreadable']>[0],
  ): ReturnType<PrivacyAuditStore['markSecretUnreadable']> {
    const result = await this.pool.query<{ marked: boolean }>(
      'SELECT worker_mark_secret_unreadable($1, $2, $3) AS marked',
      [input.tenantId, input.channelAuthorizationId, input.leaseToken],
    );
    return result.rows[0]?.marked === true;
  }

  public createLegalHold(
    input: Parameters<PrivacyAuditStore['createLegalHold']>[0],
  ): ReturnType<PrivacyAuditStore['createLegalHold']> {
    return this.contexts
      .run(input.context, async (client) => {
        const result = await client.query<LegalHoldRow>(
          `SELECT id, tenant_id, workspace_id, name, reason, visible_to_tenant, status,
             created_by_user_id, created_at, released_at, object_key, object_version_id
           FROM create_legal_hold($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            input.context.tenantId,
            input.context.workspaceId,
            input.holdId,
            input.context.actorUserId,
            input.name,
            input.reason,
            input.objectKey,
            input.objectVersionId,
            input.auditEventId,
          ],
        );
        const row = result.rows[0];
        return row === undefined
          ? ({ outcome: 'NOT_FOUND' } as const)
          : ({ outcome: 'SUCCEEDED', hold: mapLegalHold(row), created: true } as const);
      })
      .catch((error: unknown) => {
        const message = postgresErrorMessage(error);
        if (message.includes('LEGAL_HOLD_OBJECT_NOT_FOUND')) {
          return { outcome: 'OBJECT_NOT_FOUND' } as const;
        }
        if (message.includes('LEGAL_HOLD_IDEMPOTENCY_CONFLICT')) {
          return { outcome: 'IDEMPOTENCY_CONFLICT' } as const;
        }
        throw error;
      });
  }

  public listLegalHolds(
    input: Parameters<PrivacyAuditStore['listLegalHolds']>[0],
  ): ReturnType<PrivacyAuditStore['listLegalHolds']> {
    return this.contexts.run(input.context, (client) =>
      this.listLegalHoldsInContext(client, input.context, input.includeReleased),
    );
  }

  public async releaseLegalHold(
    input: Parameters<PrivacyAuditStore['releaseLegalHold']>[0],
  ): ReturnType<PrivacyAuditStore['releaseLegalHold']> {
    const released = await this.contexts.run(input.context, async (client) => {
      const result = await client.query<LegalHoldRow>(
        `SELECT id, tenant_id, workspace_id, name, reason, visible_to_tenant, status,
           created_by_user_id, created_at, released_at, object_key, object_version_id
         FROM release_legal_hold($1, $2, $3, $4, $5)`,
        [
          input.context.tenantId,
          input.context.workspaceId,
          input.holdId,
          input.context.actorUserId,
          input.auditEventId,
        ],
      );
      return result.rows[0] ?? null;
    });
    if (released === null) return { outcome: 'NOT_FOUND' };
    return { outcome: 'SUCCEEDED', hold: mapLegalHold(released) };
  }

  public grantBreakGlass(
    input: Parameters<PrivacyAuditStore['grantBreakGlass']>[0],
  ): ReturnType<PrivacyAuditStore['grantBreakGlass']> {
    return this.pool
      .query<BreakGlassRow>(
        `SELECT id, tenant_id, workspace_id, operator_id, operator_name, reason,
           audit_event_id, requested_action, resource_type, resource_id,
           granted_at, expires_at, revoked_at
         FROM grant_break_glass($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          input.tenantId,
          input.workspaceId,
          input.grantId,
          input.operatorId,
          input.operatorName,
          input.reason,
          input.expiresAt,
          input.requestedAction,
          input.resourceType,
          input.resourceId,
          input.auditEventId,
        ],
      )
      .then((result) => {
        const row = result.rows[0];
        return row === undefined
          ? ({ outcome: 'NOT_FOUND' } as const)
          : ({ outcome: 'SUCCEEDED', grant: mapBreakGlass(row), created: true } as const);
      })
      .catch((error: unknown) => {
        if (postgresErrorMessage(error).includes('BREAK_GLASS_IDEMPOTENCY_CONFLICT')) {
          return { outcome: 'IDEMPOTENCY_CONFLICT' } as const;
        }
        throw error;
      });
  }

  public async evaluateBreakGlassAccess(
    input: Parameters<PrivacyAuditStore['evaluateBreakGlassAccess']>[0],
  ): ReturnType<PrivacyAuditStore['evaluateBreakGlassAccess']> {
    const result = await this.pool.query<BreakGlassDecisionRow>(
      `SELECT decision, state, grant_id, operator_name, reason, audit_event_id
       FROM evaluate_break_glass_access($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.actorSubject,
        input.tenantId,
        input.workspaceId,
        input.grantId,
        input.operatorId,
        input.operatorName,
        input.requestedAction,
        input.resourceType,
        input.resourceId,
        input.auditEventId,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('BREAK_GLASS_DECISION_AUDIT_MISSING');
    return {
      decision: row.decision,
      state: row.state,
      grantId: row.grant_id,
      operatorName: row.operator_name,
      reason: row.reason,
      auditEventId: row.audit_event_id,
    };
  }

  public revokeBreakGlass(
    input: Parameters<PrivacyAuditStore['revokeBreakGlass']>[0],
  ): ReturnType<PrivacyAuditStore['revokeBreakGlass']> {
    return this.pool
      .query<BreakGlassRow>(
        `SELECT id, tenant_id, workspace_id, operator_id, operator_name, reason,
           audit_event_id, requested_action, resource_type, resource_id,
           granted_at, expires_at, revoked_at
         FROM revoke_break_glass($1, $2, $3, $4, $5, $6)`,
        [
          input.tenantId,
          input.workspaceId,
          input.grantId,
          input.operatorId,
          input.operatorName,
          input.auditEventId,
        ],
      )
      .then((result) => {
        const row = result.rows[0];
        return row === undefined
          ? ({ outcome: 'NOT_FOUND' } as const)
          : ({ outcome: 'SUCCEEDED', grant: mapBreakGlass(row) } as const);
      });
  }

  public async verifyAuditChain(
    input: Parameters<PrivacyAuditStore['verifyAuditChain']>[0],
  ): ReturnType<PrivacyAuditStore['verifyAuditChain']> {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<AuditVerificationRow>(
        'SELECT * FROM verify_audit_chain($1)',
        [input.context.tenantId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return {
          valid: false,
          eventCount: 0,
          lastSequence: 0,
          headHash: null,
          reason: 'Audit chain verification did not return a result.',
        };
      }
      return mapAuditVerification(row);
    });
  }

  public async verifyAuditRange(
    input: Parameters<PrivacyAuditStore['verifyAuditRange']>[0],
  ): ReturnType<PrivacyAuditStore['verifyAuditRange']> {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<AuditVerificationRow>(
        'SELECT * FROM verify_audit_range($1, $2, $3)',
        [input.context.tenantId, input.from, input.to],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return {
          valid: false,
          eventCount: 0,
          lastSequence: 0,
          headHash: null,
          reason: 'Audit range verification did not return a result.',
        };
      }
      return mapAuditVerification(row);
    });
  }

  public sealAuditDigest(
    input: Parameters<PrivacyAuditStore['sealAuditDigest']>[0],
  ): ReturnType<PrivacyAuditStore['sealAuditDigest']> {
    if (this.options !== undefined) return this.sealDurableAuditDigest(input);
    return this.contexts.runActive(input.context, async (client) => {
      const prior = await client.query<AuditDigestRow>(
        `SELECT id, tenant_id, schema_version, range_from, range_to, event_count,
           last_sequence, head_hash, digest_hash, object_ref, object_key,
           object_version_id, locked_until, sealed_at
         FROM audit_digests
         WHERE tenant_id = $1 AND range_from = $2 AND range_to = $3`,
        [input.context.tenantId, input.from, input.to],
      );
      const priorDigest = prior.rows[0];
      if (priorDigest !== undefined) {
        return {
          outcome: 'SUCCEEDED',
          digest: mapAuditDigest(priorDigest),
          created: false,
        };
      }

      const preparation = await client.query<AuditDigestPreparationRow>(
        'SELECT * FROM prepare_audit_digest_seal($1, $2, $3)',
        [input.context.tenantId, input.from, input.to],
      );
      const prepared = preparation.rows[0];
      if (prepared === undefined) return { outcome: 'PIPELINE_UNAVAILABLE' };
      if (prepared.status === 'INVALID_TIME_RANGE') return { outcome: 'INVALID_TIME_RANGE' };
      if (prepared.status === 'TAMPERED') {
        return {
          outcome: 'TAMPERED',
          eventCount: toSafeInteger(prepared.event_count, 'AUDIT_EVENT_COUNT_OUT_OF_RANGE'),
          reason: prepared.failure_reason ?? 'Audit chain digest verification detected tampering.',
        };
      }
      if (prepared.sealed_at === null || prepared.locked_until === null) {
        return { outcome: 'PIPELINE_UNAVAILABLE' };
      }

      // prepare_audit_digest_seal holds the Tenant chain head. A concurrent
      // seal may have committed while this transaction waited for that lock;
      // re-read before creating an immutable version so retries cannot leave a
      // second locked object that no digest row references.
      const committedWhileWaiting = await client.query<AuditDigestRow>(
        `SELECT id, tenant_id, schema_version, range_from, range_to, event_count,
           last_sequence, head_hash, digest_hash, object_ref, object_key,
           object_version_id, locked_until, sealed_at
         FROM audit_digests
         WHERE tenant_id = $1 AND range_from = $2 AND range_to = $3`,
        [input.context.tenantId, input.from, input.to],
      );
      const committedDigest = committedWhileWaiting.rows[0];
      if (committedDigest !== undefined) {
        return {
          outcome: 'SUCCEEDED',
          digest: mapAuditDigest(committedDigest),
          created: false,
        };
      }

      const objectKey = `tenants/${input.context.tenantId}/audit-digests/${input.digestId}.json`;
      const eventCount = toSafeInteger(prepared.event_count, 'AUDIT_EVENT_COUNT_OUT_OF_RANGE');
      const lastSequence = toSafeInteger(prepared.last_sequence, 'AUDIT_SEQUENCE_OUT_OF_RANGE');
      const digestPayload = {
        id: input.digestId,
        tenantId: input.context.tenantId,
        schemaVersion: 'audit-digest.v1' as const,
        timeRange: { from: input.from.toISOString(), to: input.to.toISOString() },
        eventCount,
        lastSequence,
        headHash: prepared.head_hash,
        lockedUntil: prepared.locked_until.toISOString(),
        sealedAt: prepared.sealed_at.toISOString(),
      };
      const digestHash = privacySha256(canonicalPrivacyJson(digestPayload));
      let objectRef = `audit-evidence://${objectKey}`;
      let objectVersionId = input.digestId;
      let storedAuditObject: StoredPrivacyObjectVersion | null = null;
      if (this.options?.objects !== undefined) {
        const body = new TextEncoder().encode(
          canonicalPrivacyJson({ ...digestPayload, digestHash }),
        );
        const checksum = privacySha256(body);
        storedAuditObject = await this.options.objects.putLockedAuditVersion({
          tenantId: input.context.tenantId,
          objectKey,
          body,
          contentType: 'application/json',
          checksum,
          lockedUntil: prepared.locked_until,
        });
        assertStoredObject(storedAuditObject, {
          tenantId: input.context.tenantId,
          objectKey,
          checksum,
          contentType: 'application/json',
          byteLength: body.byteLength,
          lockedUntil: prepared.locked_until.toISOString(),
        });
        objectRef = storedAuditObject.objectRef;
        objectVersionId = storedAuditObject.objectVersionId;
      }
      const inserted = await client.query<AuditDigestRow>(
        `INSERT INTO audit_digests
          (id, tenant_id, workspace_id, schema_version, range_from, range_to, event_count,
            last_sequence, head_hash, digest_hash, object_ref, object_key, object_version_id,
            locked_until, sealed_at, audit_event_id)
         VALUES ($1, $2, $3, 'audit-digest.v1', $4, $5, $6, $7, $8, $9, $10, $11,
           $12, $13, $14, $15)
         ON CONFLICT (tenant_id, range_from, range_to) DO NOTHING
         RETURNING id, tenant_id, schema_version, range_from, range_to, event_count,
           last_sequence, head_hash, digest_hash, object_ref, object_key, object_version_id,
           locked_until, sealed_at`,
        [
          input.digestId,
          input.context.tenantId,
          input.context.workspaceId,
          input.from,
          input.to,
          eventCount,
          lastSequence,
          prepared.head_hash,
          digestHash,
          objectRef,
          objectKey,
          objectVersionId,
          prepared.locked_until,
          prepared.sealed_at,
          input.auditEventId,
        ],
      );
      const created = inserted.rows[0];
      if (created !== undefined) {
        if (storedAuditObject !== null) {
          await client.query(
            `INSERT INTO managed_object_versions
              (id, tenant_id, workspace_id, object_class, object_ref, object_key,
                object_version_id, checksum, content_type, byte_length, lifecycle_state,
                created_at, expires_at, locked_until, deletion_request_id, deleted_at)
             VALUES ($1, $2, $3, 'AUDIT_DIGEST', $4, $5, $6, $7, $8, $9,
               'ACTIVE', $10, $11, $11, NULL, NULL)`,
            [
              input.digestId,
              input.context.tenantId,
              input.context.workspaceId,
              storedAuditObject.objectRef,
              storedAuditObject.objectKey,
              storedAuditObject.objectVersionId,
              storedAuditObject.checksum,
              storedAuditObject.contentType,
              storedAuditObject.byteLength,
              new Date(storedAuditObject.createdAt),
              prepared.locked_until,
            ],
          );
        }
        await insertAuditEvent(client, {
          id: input.auditEventId,
          context: input.context,
          action: 'AUDIT_DIGEST_SEALED',
          resourceType: 'AUDIT_DIGEST',
          resourceId: input.digestId,
          metadata: {
            digestHash,
            lastSequence,
            lockedUntil: prepared.locked_until.toISOString(),
            objectKey,
            objectVersionId,
          },
          occurredAt: prepared.sealed_at,
        });
        return { outcome: 'SUCCEEDED', digest: mapAuditDigest(created), created: true };
      }
      const existing = await client.query<AuditDigestRow>(
        `SELECT id, tenant_id, schema_version, range_from, range_to, event_count,
           last_sequence, head_hash, digest_hash, object_ref, object_key, object_version_id,
           locked_until, sealed_at
         FROM audit_digests
         WHERE tenant_id = $1 AND range_from = $2 AND range_to = $3`,
        [input.context.tenantId, input.from, input.to],
      );
      const row = existing.rows[0];
      if (row === undefined) return { outcome: 'PIPELINE_UNAVAILABLE' };
      return { outcome: 'SUCCEEDED', digest: mapAuditDigest(row), created: false };
    });
  }

  private async saveDurableTenantExport(
    input: Parameters<PrivacyAuditStore['saveTenantExport']>[0],
  ): ReturnType<PrivacyAuditStore['saveTenantExport']> {
    const archive = buildTenantExportArchive(input.canonicalFiles, input.manifest, input.checksum);
    if (archive === null) return { outcome: 'PIPELINE_UNAVAILABLE' };

    const reserved = await this.contexts.runActive(input.context, async (client) => {
      await lockAuthorizedActiveTenantForExport(client, input.context);
      const inserted = await client.query<TenantExportRow>(
        `INSERT INTO tenant_exports
          (id, tenant_id, workspace_id, schema_version, request_hash, requested_by_user_id,
            requested_at, range_from, range_to, manifest, checksum, object_ref,
            object_version_id, object_checksum, completed_at, status)
         VALUES ($1, $2, $3, '1.0.0', $4, $5, $6, $7, $8, $9::jsonb,
           $10, NULL, NULL, NULL, NULL, 'ARCHIVE_PENDING')
         ON CONFLICT (tenant_id, request_hash) DO NOTHING
         RETURNING id, status, checksum, object_ref, requested_at`,
        [
          input.exportId,
          input.context.tenantId,
          input.context.workspaceId,
          input.requestHash,
          input.context.actorUserId,
          input.createdAt,
          input.manifest.timeRange.from,
          input.manifest.timeRange.to,
          JSON.stringify(input.manifest),
          input.checksum,
        ],
      );
      const created = inserted.rows[0];
      if (created !== undefined) {
        for (const [offset, object] of input.manifest.objects.entries()) {
          await client.query(
            `INSERT INTO tenant_export_items
              (tenant_id, export_id, ordinal, object_kind, source_object_id,
                source_content_hash, exported_content_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $6)`,
            [
              input.context.tenantId,
              input.exportId,
              offset + 1,
              object.kind,
              object.objectId,
              object.contentHash,
            ],
          );
        }
        const objectKey = `tenants/${input.context.tenantId}/exports/${input.exportId}.bundle.json`;
        await client.query(
          `INSERT INTO privacy_object_write_intents (
             operation_id, tenant_id, workspace_id, kind, request_identity,
             business_id, actor_user_id, audit_event_id, object_key,
             canonical_payload, checksum, content_type, byte_length,
             sealed_at, locked_until, business_payload, status,
             created_at, updated_at
           ) VALUES (
             $1, $2, $3, 'TENANT_EXPORT', $4, $1, $5, $6, $7,
             $8, $9, 'application/json', $10, NULL, NULL, $11::jsonb,
             'PENDING', $12, $12
           )`,
          [
            input.exportId,
            input.context.tenantId,
            input.context.workspaceId,
            input.requestHash,
            input.context.actorUserId,
            input.auditEventId,
            objectKey,
            Buffer.from(archive.body),
            archive.checksum,
            archive.body.byteLength,
            JSON.stringify({ manifestChecksum: input.checksum }),
            input.createdAt,
          ],
        );
        await client.query(
          `INSERT INTO privacy_object_write_outbox
             (operation_id, tenant_id, available_at, dispatched_at)
           VALUES ($1, $2, $3, NULL)`,
          [input.exportId, input.context.tenantId, input.createdAt],
        );
        return {
          outcome: 'SUCCEEDED' as const,
          exportId: created.id,
          created: true,
          archiveStatus: 'PENDING' as const,
          archiveReady: false,
          objectRef: created.object_ref,
          createdAt: created.requested_at.toISOString(),
        };
      }

      const existing = await client.query<TenantExportRow>(
        `SELECT id, status, checksum, object_ref, requested_at
         FROM tenant_exports
         WHERE tenant_id = $1 AND request_hash = $2`,
        [input.context.tenantId, input.requestHash],
      );
      const row = existing.rows[0];
      if (row === undefined) return { outcome: 'PIPELINE_UNAVAILABLE' as const };
      if (row.checksum !== input.checksum) return { outcome: 'IDEMPOTENCY_CONFLICT' as const };
      return {
        outcome: 'SUCCEEDED' as const,
        exportId: row.id,
        created: false,
        archiveStatus:
          row.status === 'ARCHIVE_READY'
            ? ('READY' as const)
            : row.status === 'FAILED'
              ? ('FAILED' as const)
              : ('PENDING' as const),
        archiveReady: row.status === 'ARCHIVE_READY',
        objectRef: row.object_ref,
        createdAt: row.requested_at.toISOString(),
      };
    });

    if (reserved.outcome !== 'SUCCEEDED' || reserved.archiveReady) return reserved;
    try {
      await this.reconcilePrivacyObjectWriteIntentInContext(input.context, reserved.exportId);
    } catch {
      // The durable intent is already committed. A worker or a later request
      // replays the exact payload/key, so an ambiguous remote outcome remains pending.
      return reserved;
    }

    return this.contexts.runActive(input.context, async (client) => {
      const result = await client.query<TenantExportRow>(
        `SELECT id, status, checksum, object_ref, requested_at
         FROM tenant_exports
         WHERE tenant_id = $1 AND id = $2`,
        [input.context.tenantId, reserved.exportId],
      );
      const row = result.rows[0];
      if (row === undefined || row.checksum !== input.checksum) return reserved;
      return {
        outcome: 'SUCCEEDED' as const,
        exportId: row.id,
        created: reserved.created,
        archiveStatus:
          row.status === 'ARCHIVE_READY'
            ? ('READY' as const)
            : row.status === 'FAILED'
              ? ('FAILED' as const)
              : ('PENDING' as const),
        archiveReady: row.status === 'ARCHIVE_READY',
        objectRef: row.object_ref,
        createdAt: row.requested_at.toISOString(),
      };
    });
  }

  private async reconcilePrivacyObjectWriteIntentInContext(
    context: TenantContext,
    operationId: string,
  ): Promise<boolean> {
    if (this.options?.privacyWriter === undefined && this.options?.objects === undefined) {
      return false;
    }
    const leaseToken = randomUUID();
    const intent = await this.contexts.runActive(context, async (client) => {
      const claimed = await client.query<{ claimed: boolean }>(
        'SELECT claim_privacy_object_write_intent($1, $2, $3) AS claimed',
        [operationId, context.tenantId, leaseToken],
      );
      if (claimed.rows[0]?.claimed !== true) return null;
      const result = await client.query<PrivacyObjectWriteIntentRow>(
        `SELECT operation_id, kind, tenant_id, workspace_id, object_key,
           canonical_payload, checksum, content_type, locked_until, sealed_at,
           work_lease_token AS lease_token,
           work_lease_expires_at AS lease_expires_at
         FROM privacy_object_write_intents
         WHERE tenant_id = $1 AND operation_id = $2`,
        [context.tenantId, operationId],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapPrivacyObjectWriteIntent(row);
    });
    if (intent === null) return false;

    try {
      const object =
        this.options.privacyWriter !== undefined
          ? await this.options.privacyWriter.putAuthorizedPrivacyVersion(intent)
          : intent.kind === 'TENANT_EXPORT'
            ? await this.options.objects!.putExportVersion({
                tenantId: intent.tenantId,
                objectKey: intent.objectKey,
                body: intent.canonicalPayload,
                contentType: intent.contentType,
                checksum: intent.checksum,
              })
            : await this.options.objects!.putLockedAuditVersion({
                tenantId: intent.tenantId,
                objectKey: intent.objectKey,
                body: intent.canonicalPayload,
                contentType: intent.contentType,
                checksum: intent.checksum,
                lockedUntil: new Date(requiredIntentLockedUntil(intent)),
              });
      assertStoredObject(object, {
        tenantId: intent.tenantId,
        objectKey: intent.objectKey,
        checksum: intent.checksum,
        contentType: intent.contentType,
        byteLength: intent.canonicalPayload.byteLength,
        lockedUntil: intent.lockedUntil,
      });
      const completed = await this.contexts.runActive(context, async (client) => {
        const result = await client.query<{ completed: boolean }>(
          `SELECT complete_privacy_object_write_intent(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
           ) AS completed`,
          [
            intent.operationId,
            intent.leaseToken,
            object.objectRef,
            object.objectKey,
            object.objectVersionId,
            object.checksum,
            object.contentType,
            object.byteLength,
            new Date(object.createdAt),
            object.lockedUntil === null ? null : new Date(object.lockedUntil),
          ],
        );
        return result.rows[0]?.completed === true;
      });
      return completed;
    } catch (error) {
      await this.contexts
        .runActive(context, async (client) => {
          await client.query('SELECT release_privacy_object_write_intent_lease($1, $2, $3)', [
            intent.operationId,
            intent.leaseToken,
            postgresErrorMessage(error),
          ]);
        })
        .catch(() => undefined);
      throw error;
    }
  }

  private async sealDurableAuditDigest(
    input: Parameters<PrivacyAuditStore['sealAuditDigest']>[0],
  ): ReturnType<PrivacyAuditStore['sealAuditDigest']> {
    const requestIdentity = privacySha256(
      canonicalPrivacyJson({
        kind: 'AUDIT_DIGEST',
        tenantId: input.context.tenantId,
        rangeFrom: input.from.toISOString(),
        rangeTo: input.to.toISOString(),
      }),
    );
    const reserved = await this.contexts.runActive(input.context, async (client) => {
      const prior = await client.query<AuditDigestRow>(
        `SELECT id, tenant_id, schema_version, range_from, range_to, event_count,
           last_sequence, head_hash, digest_hash, object_ref, object_key,
           object_version_id, locked_until, sealed_at
         FROM audit_digests
         WHERE tenant_id = $1 AND range_from = $2 AND range_to = $3`,
        [input.context.tenantId, input.from, input.to],
      );
      const priorDigest = prior.rows[0];
      if (priorDigest !== undefined) {
        return {
          outcome: 'READY' as const,
          digest: mapAuditDigest(priorDigest),
          created: false,
        };
      }

      const pendingBeforePreparation = await findAuditWriteIntent(
        client,
        input.context.tenantId,
        requestIdentity,
      );
      if (pendingBeforePreparation !== null) {
        return {
          outcome: 'PENDING' as const,
          operationId: pendingBeforePreparation,
          created: false,
        };
      }

      const preparation = await client.query<AuditDigestPreparationRow>(
        'SELECT * FROM prepare_audit_digest_seal($1, $2, $3)',
        [input.context.tenantId, input.from, input.to],
      );
      const prepared = preparation.rows[0];
      if (prepared === undefined) return { outcome: 'PIPELINE_UNAVAILABLE' as const };
      if (prepared.status === 'INVALID_TIME_RANGE') {
        return { outcome: 'INVALID_TIME_RANGE' as const };
      }
      if (prepared.status === 'TAMPERED') {
        return {
          outcome: 'TAMPERED' as const,
          eventCount: toSafeInteger(prepared.event_count, 'AUDIT_EVENT_COUNT_OUT_OF_RANGE'),
          reason: prepared.failure_reason ?? 'Audit chain digest verification detected tampering.',
        };
      }
      if (prepared.sealed_at === null || prepared.locked_until === null) {
        return { outcome: 'PIPELINE_UNAVAILABLE' as const };
      }

      // The preparation function serializes on the Tenant chain head. Re-read
      // after acquiring that lock so concurrent requests converge on one intent.
      const committedWhileWaiting = await findAuditWriteIntent(
        client,
        input.context.tenantId,
        requestIdentity,
      );
      if (committedWhileWaiting !== null) {
        return {
          outcome: 'PENDING' as const,
          operationId: committedWhileWaiting,
          created: false,
        };
      }

      const eventCount = toSafeInteger(prepared.event_count, 'AUDIT_EVENT_COUNT_OUT_OF_RANGE');
      const lastSequence = toSafeInteger(prepared.last_sequence, 'AUDIT_SEQUENCE_OUT_OF_RANGE');
      const digestPayload = {
        id: input.digestId,
        tenantId: input.context.tenantId,
        schemaVersion: 'audit-digest.v1' as const,
        timeRange: { from: input.from.toISOString(), to: input.to.toISOString() },
        eventCount,
        lastSequence,
        headHash: prepared.head_hash,
        lockedUntil: prepared.locked_until.toISOString(),
        sealedAt: prepared.sealed_at.toISOString(),
      };
      const digestHash = privacySha256(canonicalPrivacyJson(digestPayload));
      const body = new TextEncoder().encode(canonicalPrivacyJson({ ...digestPayload, digestHash }));
      const checksum = privacySha256(body);
      const objectKey = `tenants/${input.context.tenantId}/audit-digests/${input.digestId}.json`;
      await client.query(
        `INSERT INTO privacy_object_write_intents (
           operation_id, tenant_id, workspace_id, kind, request_identity,
           business_id, actor_user_id, audit_event_id, object_key,
           canonical_payload, checksum, content_type, byte_length,
           sealed_at, locked_until, business_payload, status,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, 'AUDIT_DIGEST', $4, $1, $5, $6, $7,
           $8, $9, 'application/json', $10, $11, $12, $13::jsonb,
           'PENDING', $11, $11
         )`,
        [
          input.digestId,
          input.context.tenantId,
          input.context.workspaceId,
          requestIdentity,
          input.context.actorUserId,
          input.auditEventId,
          objectKey,
          Buffer.from(body),
          checksum,
          body.byteLength,
          prepared.sealed_at,
          prepared.locked_until,
          JSON.stringify({
            rangeFrom: input.from.toISOString(),
            rangeTo: input.to.toISOString(),
            eventCount,
            lastSequence,
            headHash: prepared.head_hash,
            digestHash,
          }),
        ],
      );
      await client.query(
        `INSERT INTO privacy_object_write_outbox
           (operation_id, tenant_id, available_at, dispatched_at)
         VALUES ($1, $2, $3, NULL)`,
        [input.digestId, input.context.tenantId, prepared.sealed_at],
      );
      return {
        outcome: 'PENDING' as const,
        operationId: input.digestId,
        created: true,
      };
    });

    if (reserved.outcome === 'READY') {
      return { outcome: 'SUCCEEDED', digest: reserved.digest, created: false };
    }
    if (reserved.outcome !== 'PENDING') return reserved;
    let reconciled: boolean;
    try {
      reconciled = await this.reconcilePrivacyObjectWriteIntentInContext(
        input.context,
        reserved.operationId,
      );
    } catch {
      return { outcome: 'PIPELINE_UNAVAILABLE' };
    }
    const digest = await this.waitForDurableAuditDigest(
      input.context,
      reserved.operationId,
      reconciled ? 1 : 12,
    );
    if (digest === null) return { outcome: 'PIPELINE_UNAVAILABLE' };
    return {
      outcome: 'SUCCEEDED',
      digest,
      created: reserved.created,
    };
  }

  private async waitForDurableAuditDigest(
    context: TenantContext,
    digestId: string,
    attempts: number,
  ): Promise<AuditDigest | null> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const digest = await this.contexts.runActive(context, async (client) => {
        const result = await client.query<AuditDigestRow>(
          `SELECT id, tenant_id, schema_version, range_from, range_to, event_count,
             last_sequence, head_hash, digest_hash, object_ref, object_key,
             object_version_id, locked_until, sealed_at
           FROM audit_digests
           WHERE tenant_id = $1 AND id = $2`,
          [context.tenantId, digestId],
        );
        const row = result.rows[0];
        return row === undefined ? null : mapAuditDigest(row);
      });
      if (digest !== null) return digest;
      if (attempt + 1 < attempts) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    return null;
  }

  private async requestDeletion(
    scope: 'TENANT' | 'WORKSPACE',
    input: Parameters<PrivacyAuditStore['requestTenantDeletion']>[0],
  ): Promise<RequestDeletionStoreResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existingResult = await client.query<DeletionRow>(
        `SELECT id, tenant_id, workspace_id, scope_kind, state, requested_by_user_id, reason,
           request_hash, requested_at, frozen_at, active_delete_by, backup_delete_by,
           secret_force_delete_by
         FROM deletion_requests
         WHERE id = $1 AND tenant_id = $2
         FOR UPDATE`,
        [input.requestId, input.context.tenantId],
      );
      const existing = existingResult.rows[0];
      if (existing !== undefined) {
        await client.query('COMMIT');
        if (
          existing.scope_kind !== scope ||
          existing.workspace_id !== (scope === 'TENANT' ? null : input.context.workspaceId) ||
          existing.reason !== input.reason ||
          (existing.request_hash !== undefined && existing.request_hash !== input.requestHash)
        ) {
          return { outcome: 'IDEMPOTENCY_CONFLICT' };
        }
        return { outcome: 'SUCCEEDED', receipt: mapDeletionReceipt(existing), created: false };
      }

      const functionName =
        scope === 'TENANT' ? 'request_tenant_deletion' : 'request_workspace_deletion';
      const result = await client.query<DeletionRow>(
        `SELECT * FROM ${functionName}($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.actorSubject,
          input.context.tenantId,
          input.context.workspaceId,
          input.requestId,
          input.reason,
          input.requestHash,
          input.requestedAt,
          input.auditEventId,
        ],
      );
      const created = result.rows[0];
      if (created === undefined) {
        await client.query('ROLLBACK');
        return { outcome: 'NOT_FOUND' };
      }
      await client.query('COMMIT');
      return { outcome: 'SUCCEEDED', receipt: mapDeletionReceipt(created), created: true };
    } catch (error) {
      await client.query('ROLLBACK');
      const code = postgresErrorCode(error);
      if (postgresErrorMessage(error).includes('DELETION_REQUEST_TIME_IN_FUTURE')) {
        return { outcome: 'INVALID_REQUEST' };
      }
      if (code === '42501' || code === 'P0001') return { outcome: 'NOT_FOUND' };
      if (code === '23505') return { outcome: 'IDEMPOTENCY_CONFLICT' };
      return { outcome: 'PIPELINE_UNAVAILABLE' };
    } finally {
      client.release();
    }
  }

  private async listLegalHoldsInContext(
    client: PoolClient,
    context: TenantContext,
    includeReleased: boolean,
  ): Promise<TenantVisibleLegalHold[]> {
    const result = await client.query<LegalHoldRow>(
      `${LEGAL_HOLD_COLUMNS_QUERY}
       WHERE hold.tenant_id = $1 AND hold.workspace_id = $2
         AND ($3::boolean OR hold.status = 'ACTIVE')
       ORDER BY hold.created_at DESC, hold.id DESC`,
      [context.tenantId, context.workspaceId, includeReleased],
    );
    return result.rows.map(mapLegalHold);
  }

  private async findLegalHoldInContext(
    client: PoolClient,
    context: TenantContext,
    holdId: string,
  ): Promise<TenantVisibleLegalHold | null> {
    const result = await client.query<LegalHoldRow>(
      `${LEGAL_HOLD_COLUMNS_QUERY}
       WHERE hold.tenant_id = $1 AND hold.workspace_id = $2 AND hold.id = $3`,
      [context.tenantId, context.workspaceId, holdId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapLegalHold(row);
  }
}

async function lockAuthorizedActiveTenantForExport(
  client: PoolClient,
  context: TenantContext,
): Promise<void> {
  const owner = await client.query(
    `SELECT 1
     FROM tenants tenant
     JOIN workspaces workspace
       ON workspace.tenant_id = tenant.id AND workspace.id = $2
     JOIN memberships membership
       ON membership.tenant_id = tenant.id
      AND membership.id = $3
      AND membership.user_id = $4
      AND membership.status = 'ACTIVE'
     JOIN role_bindings binding
       ON binding.tenant_id = membership.tenant_id
      AND binding.workspace_id = workspace.id
      AND binding.membership_id = membership.id
      AND binding.role = 'OWNER'
     WHERE tenant.id = $1
       AND tenant.lifecycle_state = 'ACTIVE'
       AND workspace.lifecycle_state = 'ACTIVE'
     FOR SHARE OF tenant, workspace, membership, binding`,
    [context.tenantId, context.workspaceId, context.membershipId, context.actorUserId],
  );
  if (owner.rowCount !== 1) throw new Error('TENANT_EXPORT_OWNER_CONTEXT_INVALID');

  const workspaces = await client.query<{ lifecycle_state: string }>(
    `SELECT lifecycle_state
     FROM workspaces
     WHERE tenant_id = $1
     ORDER BY id
     FOR SHARE`,
    [context.tenantId],
  );
  if (
    workspaces.rows.length === 0 ||
    workspaces.rows.some(({ lifecycle_state }) => lifecycle_state !== 'ACTIVE')
  ) {
    throw new Error('TENANT_SCOPE_NOT_ACTIVE');
  }
}

function mapExportObject(row: TenantExportObjectRow): TenantExportSourceObject {
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    objectId: row.object_id,
    occurredAt: row.occurred_at.toISOString(),
    payload: row.payload,
  };
}

function buildTenantExportArchive(
  canonicalFiles: readonly TenantExportCanonicalFile[],
  manifest: TenantExportManifest,
  manifestChecksum: string,
): { body: Uint8Array; checksum: string } | null {
  const parsedManifest = TenantExportManifestSchema.safeParse(manifest);
  if (
    !parsedManifest.success ||
    canonicalPrivacyJson(parsedManifest.data) !== canonicalPrivacyJson(manifest) ||
    privacySha256(canonicalPrivacyJson(manifest)) !== manifestChecksum ||
    !canonicalFilesMatchManifest(canonicalFiles, parsedManifest.data)
  ) {
    return null;
  }
  const body = new TextEncoder().encode(
    canonicalPrivacyJson({
      schemaVersion: 'tenant-export-bundle.v1',
      manifest: parsedManifest.data,
      files: canonicalFiles.map((file) => ({
        path: file.path,
        contentHash: file.contentHash,
        byteLength: file.byteLength,
        content: JSON.parse(file.content) as unknown,
      })),
    }),
  );
  return { body, checksum: privacySha256(body) };
}

function canonicalFilesMatchManifest(
  canonicalFiles: readonly TenantExportCanonicalFile[],
  manifest: TenantExportManifest,
): boolean {
  if (
    canonicalFiles.length !== manifest.files.length ||
    canonicalFiles.length !== manifest.objects.length
  ) {
    return false;
  }
  const manifestObjects = new Map<string, TenantExportManifest['objects'][number]>(
    manifest.objects.map((object) => [`${object.kind}:${object.objectId}`, object] as const),
  );
  const paths = new Set<string>();
  for (const [index, file] of canonicalFiles.entries()) {
    const manifestFile = manifest.files[index];
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
    const { kind, objectId, workspaceId, occurredAt } = content;
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
    const manifestObject = manifestObjects.get(`${kind}:${objectId}`);
    if (
      manifestObject === undefined ||
      manifestObject.contentHash !== file.contentHash ||
      file.path !== `objects/${kind.toLowerCase()}/${encodeURIComponent(objectId)}.json`
    ) {
      return false;
    }
    manifestObjects.delete(`${kind}:${objectId}`);
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
    const { path, contentHash, byteLength } = rawFile;
    if (
      typeof path !== 'string' ||
      typeof contentHash !== 'string' ||
      typeof byteLength !== 'number' ||
      path !== manifestFile.path ||
      contentHash !== manifestFile.contentHash ||
      byteLength !== manifestFile.byteLength ||
      !Object.hasOwn(rawFile, 'content')
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

function assertStoredObject(
  object: StoredPrivacyObjectVersion,
  expected: {
    tenantId: string;
    objectKey: string;
    checksum: string;
    contentType: string;
    byteLength: number;
    lockedUntil: string | null;
  },
): void {
  if (
    object.tenantId !== expected.tenantId ||
    object.objectKey !== expected.objectKey ||
    object.checksum !== expected.checksum ||
    object.contentType !== expected.contentType ||
    object.byteLength !== expected.byteLength ||
    object.lockedUntil !== expected.lockedUntil ||
    object.objectRef.length === 0 ||
    object.objectVersionId.length === 0 ||
    !Number.isFinite(Date.parse(object.createdAt))
  ) {
    throw new Error('PRIVACY_OBJECT_STORAGE_METADATA_MISMATCH');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapDeletionReceipt(row: DeletionRow): TenantDeletionReceipt {
  return {
    id: row.id,
    scope: row.scope_kind,
    state: 'FROZEN',
    requestedAt: row.requested_at.toISOString(),
    activeDeleteBy: row.active_delete_by.toISOString(),
    backupDeleteBy: row.backup_delete_by.toISOString(),
    secretForceDeleteBy: row.secret_force_delete_by.toISOString(),
  };
}

function mapLegalHold(row: LegalHoldRow): TenantVisibleLegalHold {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    reason: row.reason,
    createdBy: row.created_by_user_id,
    visibleToTenant: true,
    target: { objectKey: row.object_key, objectVersionId: row.object_version_id },
    createdAt: row.created_at.toISOString(),
    releasedAt: row.released_at?.toISOString() ?? null,
  };
}

function mapBreakGlass(row: BreakGlassRow): BreakGlassGrantRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    reason: row.reason,
    auditEventId: row.audit_event_id,
    requestedAction: row.requested_action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    grantedAt: row.granted_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

function mapAuditVerification(row: AuditVerificationRow): AuditIntegrityVerification {
  return {
    valid: row.valid,
    eventCount: toSafeInteger(row.event_count, 'AUDIT_EVENT_COUNT_OUT_OF_RANGE'),
    lastSequence: toSafeInteger(row.last_sequence, 'AUDIT_SEQUENCE_OUT_OF_RANGE'),
    headHash: row.head_hash,
    reason: row.failure_reason,
  };
}

function mapAuditDigest(row: AuditDigestRow): AuditDigest {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    schemaVersion: row.schema_version,
    timeRange: { from: row.range_from.toISOString(), to: row.range_to.toISOString() },
    eventCount: toSafeInteger(row.event_count, 'AUDIT_EVENT_COUNT_OUT_OF_RANGE'),
    lastSequence: toSafeInteger(row.last_sequence, 'AUDIT_SEQUENCE_OUT_OF_RANGE'),
    headHash: row.head_hash,
    digestHash: row.digest_hash,
    objectRef: row.object_ref,
    objectKey: row.object_key,
    objectVersionId: row.object_version_id,
    lockedUntil: row.locked_until.toISOString(),
    sealedAt: row.sealed_at.toISOString(),
  };
}

function mapTenantLifecycleState(
  state: TenantLifecycleRow['lifecycle_state'],
): PrivacyOverview['lifecycleState'] {
  return state === 'ACTIVE_DATA_DELETED' ? 'DELETION_IN_PROGRESS' : state;
}

function parseAuditCursor(cursor: string | null): number | null {
  if (cursor === null) return null;
  if (!/^\d+$/u.test(cursor)) return null;
  const parsed = Number(cursor);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function toSafeInteger(value: number | string, errorCode: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(errorCode);
  return parsed;
}

function mapPrivacyObjectWriteIntent(
  row: PrivacyObjectWriteIntentRow,
): PrivacyObjectWriteIntentWork {
  return {
    operationId: row.operation_id,
    kind: row.kind,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    objectKey: row.object_key,
    canonicalPayload: new Uint8Array(row.canonical_payload),
    checksum: row.checksum,
    contentType: row.content_type,
    lockedUntil: row.locked_until?.toISOString() ?? null,
    sealedAt: row.sealed_at?.toISOString() ?? null,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
  };
}

function requiredIntentLockedUntil(intent: PrivacyObjectWriteIntentWork): string {
  if (intent.lockedUntil === null) throw new Error('AUDIT_DIGEST_LOCK_MISSING');
  return intent.lockedUntil;
}

async function findAuditWriteIntent(
  client: PoolClient,
  tenantId: string,
  requestIdentity: string,
): Promise<string | null> {
  const result = await client.query<{ operation_id: string }>(
    `SELECT operation_id
     FROM privacy_object_write_intents
     WHERE tenant_id = $1 AND kind = 'AUDIT_DIGEST' AND request_identity = $2`,
    [tenantId, requestIdentity],
  );
  return result.rows[0]?.operation_id ?? null;
}

function postgresErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function postgresErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '';
  return error.message;
}

async function insertAuditEvent(
  client: PoolClient,
  input: {
    id: string;
    context: TenantContext;
    action: string;
    resourceType: string;
    resourceId: string | null;
    metadata: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
      (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
        outcome, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'SUCCEEDED', $8::jsonb, $9)`,
    [
      input.id,
      input.context.tenantId,
      input.context.workspaceId,
      input.context.actorUserId,
      input.action,
      input.resourceType,
      input.resourceId,
      JSON.stringify(input.metadata),
      input.occurredAt,
    ],
  );
}
