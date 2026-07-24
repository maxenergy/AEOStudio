import type { EvidenceClaimStore } from '@aeostudio/application/evidence-claims';
import type {
  ClaimBundle,
  ClaimCurrentState,
  ClaimEvidenceDrillDownRecord,
  ClaimEvidenceLinkRecord,
  ClaimRecord,
  ClaimReviewRecord,
  ClaimRevisionRecord,
  EvidenceSnapshotRecord,
  EvidenceSourceRecord,
} from '@aeostudio/domain/evidence-claims';
import type { Pool, PoolClient } from 'pg';

import { TenantContextRunner } from '../tenant-context/tenant-context-runner.js';

interface EvidenceSourceRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  source_type: EvidenceSourceRecord['sourceType'];
  title: string;
  uri: string | null;
  license: string;
  publicity: EvidenceSourceRecord['publicity'];
  current_snapshot_id: string | null;
  created_at: Date;
}

interface EvidenceSnapshotRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  source_id: string;
  content_hash: string;
  object_ref: string;
  object_version_id: string;
  content_type: string;
  size_bytes: string;
  captured_at: Date;
}

interface ClaimRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  current_revision: number;
  created_at: Date;
}

interface ClaimRevisionRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  claim_id: string;
  revision: number;
  statement: string;
  numeric_value: number | null;
  unit: string | null;
  scope: string | null;
  conditions: string[];
  expires_at: Date | null;
  content_hash: string;
  status: ClaimRevisionRecord['status'];
  created_by_user_id: string;
  created_at: Date;
}

interface ClaimEvidenceLinkRow {
  id: string;
  snapshot_id: string;
  source_hash: string | null;
  snippet: string | null;
}

export class PostgresEvidenceClaimStore implements EvidenceClaimStore {
  private readonly contexts: TenantContextRunner;

  constructor(pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  createSource(
    input: Parameters<EvidenceClaimStore['createSource']>[0],
  ): Promise<EvidenceSourceRecord> {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<EvidenceSourceRow>(
        `INSERT INTO evidence_sources
          (id, tenant_id, workspace_id, source_type, title, uri, license, publicity, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, tenant_id, workspace_id, source_type, title, uri, license, publicity,
           current_snapshot_id, created_at`,
        [
          input.sourceId,
          input.context.tenantId,
          input.context.workspaceId,
          input.sourceType,
          input.title,
          input.uri,
          input.license,
          input.publicity,
          input.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'EVIDENCE_SOURCE_CREATED', 'EVIDENCE_SOURCE', $5,
           'SUCCEEDED', jsonb_build_object('sourceType', $6::text, 'publicity', $7::text), $8)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.sourceId,
          input.sourceType,
          input.publicity,
          input.createdAt,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error('EVIDENCE_SOURCE_DID_NOT_RETURN_RESULT');
      }
      return this.mapSource(row);
    });
  }

  createSnapshot(
    input: Parameters<EvidenceClaimStore['createSnapshot']>[0],
  ): Promise<{ snapshot: EvidenceSnapshotRecord; source: EvidenceSourceRecord } | null> {
    return this.contexts.run(input.context, async (client) => {
      const source = await client.query<{ id: string }>(
        `SELECT id FROM evidence_sources
         WHERE id = $1 AND workspace_id = $2
         FOR UPDATE`,
        [input.sourceId, input.context.workspaceId],
      );
      if (source.rows[0] === undefined) {
        return null;
      }
      const snapshotResult = await client.query<EvidenceSnapshotRow>(
        `INSERT INTO evidence_snapshots
          (id, tenant_id, workspace_id, source_id, content_hash, object_ref, object_version_id,
            content_type, size_bytes, captured_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, tenant_id, workspace_id, source_id, content_hash, object_ref,
           object_version_id, content_type, size_bytes, captured_at`,
        [
          input.snapshotId,
          input.context.tenantId,
          input.context.workspaceId,
          input.sourceId,
          input.contentHash,
          input.objectRef,
          input.objectVersionId,
          input.contentType,
          input.sizeBytes,
          input.capturedAt,
        ],
      );
      const sourceResult = await client.query<EvidenceSourceRow>(
        `UPDATE evidence_sources
         SET current_snapshot_id = $1
         WHERE id = $2
         RETURNING id, tenant_id, workspace_id, source_type, title, uri, license, publicity,
           current_snapshot_id, created_at`,
        [input.snapshotId, input.sourceId],
      );
      const staleClaims = await client.query<{ id: string }>(
        `UPDATE claim_revisions revision
         SET status = 'STALE'
         FROM claim_evidence_links link
         JOIN evidence_snapshots linked_snapshot
           ON linked_snapshot.tenant_id = link.tenant_id
          AND linked_snapshot.id = link.snapshot_id
         WHERE revision.tenant_id = link.tenant_id
           AND revision.id = link.claim_revision_id
           AND linked_snapshot.source_id = $1
           AND link.snapshot_id <> $2
           AND revision.status = 'APPROVED'
         RETURNING revision.id`,
        [input.sourceId, input.snapshotId],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'EVIDENCE_SNAPSHOT_CREATED', 'EVIDENCE_SNAPSHOT', $5,
           'SUCCEEDED', jsonb_build_object('sourceId', $6::uuid, 'contentHash', $7::text,
             'staleClaimCount', $8::integer), $9)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.snapshotId,
          input.sourceId,
          input.contentHash,
          staleClaims.rowCount ?? 0,
          input.capturedAt,
        ],
      );
      const snapshot = snapshotResult.rows[0];
      const updatedSource = sourceResult.rows[0];
      if (snapshot === undefined || updatedSource === undefined) {
        throw new Error('EVIDENCE_SNAPSHOT_DID_NOT_RETURN_RESULT');
      }
      return { snapshot: this.mapSnapshot(snapshot), source: this.mapSource(updatedSource) };
    });
  }

  findSnapshots(
    input: Parameters<EvidenceClaimStore['findSnapshots']>[0],
  ): Promise<EvidenceSnapshotRecord[] | null> {
    return this.contexts.run(input.context, async (client) => {
      if (new Set(input.snapshotIds).size !== input.snapshotIds.length) return null;
      if (input.snapshotIds.length === 0) return [];
      const result = await client.query<EvidenceSnapshotRow>(
        `SELECT id, tenant_id, workspace_id, source_id, content_hash, object_ref,
           object_version_id, content_type, size_bytes, captured_at
         FROM evidence_snapshots
         WHERE id = ANY($1::uuid[]) AND workspace_id = $2`,
        [input.snapshotIds, input.context.workspaceId],
      );
      if (result.rows.length !== input.snapshotIds.length) return null;
      const byId = new Map(result.rows.map((row) => [row.id, this.mapSnapshot(row)]));
      return input.snapshotIds.map((snapshotId) => byId.get(snapshotId)!);
    });
  }

  createClaim(
    input: Parameters<EvidenceClaimStore['createClaim']>[0],
  ): Promise<ClaimBundle | null> {
    return this.contexts.run(input.context, async (client) => {
      const snapshotIds = input.evidence.map((entry) => entry.snapshotId);
      if (new Set(snapshotIds).size !== snapshotIds.length) {
        return null;
      }
      const evidenceRows =
        snapshotIds.length === 0
          ? []
          : (
              await client.query<{
                id: string;
                content_hash: string;
                current_snapshot_id: string | null;
                license: string;
              }>(
                `SELECT snapshot.id, snapshot.content_hash, source.current_snapshot_id,
                   source.license
                 FROM evidence_snapshots snapshot
                 JOIN evidence_sources source
                   ON source.tenant_id = snapshot.tenant_id AND source.id = snapshot.source_id
                 WHERE snapshot.id = ANY($1::uuid[]) AND snapshot.workspace_id = $2`,
                [snapshotIds, input.context.workspaceId],
              )
            ).rows;
      if (evidenceRows.length !== snapshotIds.length) {
        return null;
      }
      const evidenceById = new Map(evidenceRows.map((row) => [row.id, row]));
      const evidenceReady =
        input.evidence.length > 0 &&
        input.evidence.every((entry) => {
          const row = evidenceById.get(entry.snapshotId);
          return (
            row !== undefined &&
            entry.sourceHash === row.content_hash &&
            entry.snippet !== null &&
            entry.snippet.trim().length > 0 &&
            row.current_snapshot_id === entry.snapshotId &&
            row.license.trim().length > 0
          );
        });
      const claimReady =
        evidenceReady &&
        input.scope !== null &&
        input.scope.trim().length > 0 &&
        input.expiresAt !== null &&
        input.expiresAt.getTime() > input.createdAt.getTime() &&
        (input.numericValue === null || input.unit !== null);
      const status: ClaimRevisionRecord['status'] = claimReady ? 'DRAFT' : 'NEEDS_EVIDENCE';
      await client.query(
        `INSERT INTO claims (id, tenant_id, workspace_id, current_revision, created_at)
         VALUES ($1, $2, $3, 1, $4)`,
        [input.claimId, input.context.tenantId, input.context.workspaceId, input.createdAt],
      );
      const revisionResult = await client.query<ClaimRevisionRow>(
        `INSERT INTO claim_revisions
          (id, tenant_id, workspace_id, claim_id, revision, statement, numeric_value, unit,
            scope, conditions, expires_at, content_hash, status, created_by_user_id, created_at)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)
         RETURNING id, tenant_id, workspace_id, claim_id, revision, statement, numeric_value,
           unit, scope, conditions, expires_at, content_hash, status, created_by_user_id,
           created_at`,
        [
          input.revisionId,
          input.context.tenantId,
          input.context.workspaceId,
          input.claimId,
          input.statement,
          input.numericValue,
          input.unit,
          input.scope,
          JSON.stringify(input.conditions),
          input.expiresAt,
          input.contentHash,
          status,
          input.context.actorUserId,
          input.createdAt,
        ],
      );
      const links: ClaimEvidenceLinkRecord[] = [];
      for (const [index, entry] of input.evidence.entries()) {
        const linkId = input.evidenceLinkIds[index];
        if (linkId === undefined) {
          throw new Error('CLAIM_EVIDENCE_LINK_ID_MISSING');
        }
        await client.query(
          `INSERT INTO claim_evidence_links
            (id, tenant_id, workspace_id, claim_revision_id, snapshot_id, source_hash,
              snippet, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            linkId,
            input.context.tenantId,
            input.context.workspaceId,
            input.revisionId,
            entry.snapshotId,
            entry.sourceHash,
            entry.snippet,
            input.createdAt,
          ],
        );
        links.push({ id: linkId, ...entry });
      }
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'CLAIM_REVISION_CREATED', 'CLAIM', $5, 'SUCCEEDED',
           jsonb_build_object('revisionId', $6::uuid, 'revision', 1,
             'contentHash', $7::text, 'status', $8::text), $9)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.claimId,
          input.revisionId,
          input.contentHash,
          status,
          input.createdAt,
        ],
      );
      const revision = revisionResult.rows[0];
      if (revision === undefined) {
        throw new Error('CLAIM_REVISION_DID_NOT_RETURN_RESULT');
      }
      return {
        claim: {
          id: input.claimId,
          tenantId: input.context.tenantId,
          workspaceId: input.context.workspaceId,
          currentRevision: 1,
          createdAt: input.createdAt.toISOString(),
        },
        revision: { ...this.mapClaimRevision(revision), evidence: links },
      };
    });
  }

  submitClaim(
    input: Parameters<EvidenceClaimStore['submitClaim']>[0],
  ): ReturnType<EvidenceClaimStore['submitClaim']> {
    return this.contexts.run(input.context, async (client) => {
      const revisionResult = await client.query<ClaimRevisionRow>(
        `SELECT revision.*
         FROM claim_revisions revision
         JOIN claims claim
           ON claim.tenant_id = revision.tenant_id AND claim.id = revision.claim_id
         WHERE revision.id = $1 AND revision.claim_id = $2 AND revision.workspace_id = $3
           AND claim.current_revision = revision.revision
         FOR UPDATE OF revision`,
        [input.revisionId, input.claimId, input.context.workspaceId],
      );
      const revision = revisionResult.rows[0];
      if (revision === undefined) {
        return { outcome: 'NOT_FOUND' };
      }
      const evidence = await client.query<{
        id: string;
        snapshot_id: string;
        source_hash: string | null;
        snippet: string | null;
        actual_hash: string;
        current_snapshot_id: string | null;
        license: string;
      }>(
        `SELECT link.id, link.snapshot_id, link.source_hash, link.snippet,
           snapshot.content_hash AS actual_hash, source.current_snapshot_id, source.license
         FROM claim_evidence_links link
         JOIN evidence_snapshots snapshot
           ON snapshot.tenant_id = link.tenant_id AND snapshot.id = link.snapshot_id
         JOIN evidence_sources source
           ON source.tenant_id = snapshot.tenant_id AND source.id = snapshot.source_id
         WHERE link.claim_revision_id = $1`,
        [input.revisionId],
      );
      const exactEvidence =
        evidence.rows.length > 0 &&
        evidence.rows.every(
          (row) =>
            row.source_hash === row.actual_hash &&
            row.snippet !== null &&
            row.snippet.trim().length > 0 &&
            row.current_snapshot_id === row.snapshot_id &&
            row.license.trim().length > 0,
        );
      const ready =
        revision.status === 'DRAFT' &&
        exactEvidence &&
        revision.scope !== null &&
        revision.expires_at !== null &&
        revision.expires_at.getTime() > input.submittedAt.getTime() &&
        (revision.numeric_value === null || revision.unit !== null);
      if (!ready) {
        return { outcome: 'NEEDS_EVIDENCE' };
      }
      await client.query(`UPDATE claim_revisions SET status = 'IN_REVIEW' WHERE id = $1`, [
        input.revisionId,
      ]);
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'CLAIM_SUBMITTED', 'CLAIM_REVISION', $5, 'SUCCEEDED',
           jsonb_build_object('claimId', $6::uuid, 'contentHash', $7::text), $8)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.revisionId,
          input.claimId,
          revision.content_hash,
          input.submittedAt,
        ],
      );
      const bundle = await this.loadClaimBundle(
        client,
        input.claimId,
        input.revisionId,
        input.context.workspaceId,
      );
      if (bundle === null) {
        throw new Error('SUBMITTED_CLAIM_DID_NOT_RETURN_RESULT');
      }
      return { outcome: 'SUCCEEDED', bundle };
    });
  }

  findClaimForReview(
    input: Parameters<EvidenceClaimStore['findClaimForReview']>[0],
  ): Promise<ClaimBundle | null> {
    return this.contexts.run(input.context, (client) =>
      this.loadClaimBundle(client, input.claimId, input.revisionId, input.context.workspaceId),
    );
  }

  reviewClaim(
    input: Parameters<EvidenceClaimStore['reviewClaim']>[0],
  ): ReturnType<EvidenceClaimStore['reviewClaim']> {
    return this.contexts.run(input.context, async (client) => {
      const revisionResult = await client.query<ClaimRevisionRow>(
        `SELECT revision.*
         FROM claim_revisions revision
         JOIN claims claim
           ON claim.tenant_id = revision.tenant_id AND claim.id = revision.claim_id
         WHERE revision.id = $1 AND revision.claim_id = $2 AND revision.workspace_id = $3
           AND revision.content_hash = $4 AND claim.current_revision = revision.revision
         FOR UPDATE OF revision`,
        [input.revisionId, input.claimId, input.context.workspaceId, input.expectedContentHash],
      );
      const revision = revisionResult.rows[0];
      if (revision === undefined) {
        return { outcome: 'NOT_FOUND' };
      }
      if (revision.status !== 'IN_REVIEW') {
        return { outcome: 'NOT_IN_REVIEW' };
      }
      if (input.decision === 'APPROVE') {
        const evidence = await client.query<{
          snapshot_id: string;
          source_hash: string | null;
          snippet: string | null;
          actual_hash: string;
          current_snapshot_id: string | null;
          license: string;
        }>(
          `SELECT link.snapshot_id, link.source_hash, link.snippet,
             snapshot.content_hash AS actual_hash, source.current_snapshot_id, source.license
           FROM claim_evidence_links link
           JOIN evidence_snapshots snapshot
             ON snapshot.tenant_id = link.tenant_id AND snapshot.id = link.snapshot_id
           JOIN evidence_sources source
             ON source.tenant_id = snapshot.tenant_id AND source.id = snapshot.source_id
           WHERE link.claim_revision_id = $1`,
          [input.revisionId],
        );
        const evidenceCurrent =
          evidence.rows.length > 0 &&
          evidence.rows.every(
            (row) =>
              row.source_hash === row.actual_hash &&
              row.snippet !== null &&
              row.snippet.trim().length > 0 &&
              row.current_snapshot_id === row.snapshot_id &&
              row.license.trim().length > 0,
          );
        if (
          !evidenceCurrent ||
          revision.scope === null ||
          revision.expires_at === null ||
          revision.expires_at.getTime() <= input.reviewedAt.getTime()
        ) {
          await client.query(`UPDATE claim_revisions SET status = 'STALE' WHERE id = $1`, [
            input.revisionId,
          ]);
          return { outcome: 'NEEDS_EVIDENCE' };
        }
      }
      const nextStatus: ClaimRevisionRecord['status'] =
        input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      await client.query(`UPDATE claim_revisions SET status = $1 WHERE id = $2`, [
        nextStatus,
        input.revisionId,
      ]);
      await client.query(
        `INSERT INTO claim_reviews
          (id, tenant_id, workspace_id, claim_revision_id, decision, reviewer_user_id,
            content_hash, note, reviewed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.reviewId,
          input.context.tenantId,
          input.context.workspaceId,
          input.revisionId,
          input.decision,
          input.context.actorUserId,
          input.expectedContentHash,
          input.note,
          input.reviewedAt,
        ],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'CLAIM_REVIEWED', 'CLAIM_REVISION', $5, 'SUCCEEDED',
           jsonb_build_object('claimId', $6::uuid, 'decision', $7::text,
             'contentHash', $8::text), $9)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.revisionId,
          input.claimId,
          input.decision,
          input.expectedContentHash,
          input.reviewedAt,
        ],
      );
      const bundle = await this.loadClaimBundle(
        client,
        input.claimId,
        input.revisionId,
        input.context.workspaceId,
      );
      if (bundle === null) {
        throw new Error('REVIEWED_CLAIM_DID_NOT_RETURN_RESULT');
      }
      const review: ClaimReviewRecord = {
        id: input.reviewId,
        claimRevisionId: input.revisionId,
        decision: input.decision,
        reviewerUserId: input.context.actorUserId,
        contentHash: input.expectedContentHash,
        note: input.note,
        reviewedAt: input.reviewedAt.toISOString(),
      };
      return { outcome: 'SUCCEEDED', bundle, review };
    });
  }

  findEvidenceDrillDown(
    input: Parameters<EvidenceClaimStore['findEvidenceDrillDown']>[0],
  ): Promise<ClaimEvidenceDrillDownRecord[] | null> {
    return this.contexts.run(input.context, async (client) => {
      const exists = await client.query<{ id: string }>(
        `SELECT revision.id
         FROM claim_revisions revision
         JOIN claims claim
           ON claim.tenant_id = revision.tenant_id AND claim.id = revision.claim_id
         WHERE revision.id = $1 AND revision.claim_id = $2 AND revision.workspace_id = $3`,
        [input.revisionId, input.claimId, input.context.workspaceId],
      );
      if (exists.rows[0] === undefined) {
        return null;
      }
      const rows = await client.query<{
        link_id: string;
        link_snapshot_id: string;
        source_hash: string | null;
        snippet: string | null;
        snapshot_id: string;
        snapshot_tenant_id: string;
        snapshot_workspace_id: string;
        snapshot_source_id: string;
        content_hash: string;
        object_ref: string;
        object_version_id: string;
        content_type: string;
        size_bytes: string;
        captured_at: Date;
        source_id: string;
        source_tenant_id: string;
        source_workspace_id: string;
        source_type: EvidenceSourceRecord['sourceType'];
        source_title: string;
        source_uri: string | null;
        source_license: string;
        source_publicity: EvidenceSourceRecord['publicity'];
        current_snapshot_id: string | null;
        source_created_at: Date;
      }>(
        `SELECT link.id AS link_id, link.snapshot_id AS link_snapshot_id,
           link.source_hash, link.snippet,
           snapshot.id AS snapshot_id, snapshot.tenant_id AS snapshot_tenant_id,
           snapshot.workspace_id AS snapshot_workspace_id,
           snapshot.source_id AS snapshot_source_id, snapshot.content_hash,
           snapshot.object_ref, snapshot.object_version_id, snapshot.content_type,
           snapshot.size_bytes, snapshot.captured_at,
           source.id AS source_id, source.tenant_id AS source_tenant_id,
           source.workspace_id AS source_workspace_id, source.source_type,
           source.title AS source_title, source.uri AS source_uri,
           source.license AS source_license, source.publicity AS source_publicity,
           source.current_snapshot_id, source.created_at AS source_created_at
         FROM claim_evidence_links link
         JOIN evidence_snapshots snapshot
           ON snapshot.tenant_id = link.tenant_id AND snapshot.id = link.snapshot_id
         JOIN evidence_sources source
           ON source.tenant_id = snapshot.tenant_id AND source.id = snapshot.source_id
         WHERE link.claim_revision_id = $1
         ORDER BY link.id`,
        [input.revisionId],
      );
      return rows.rows.length === 0
        ? null
        : rows.rows.map((row) => ({
            link: {
              id: row.link_id,
              snapshotId: row.link_snapshot_id,
              sourceHash: row.source_hash,
              snippet: row.snippet,
            },
            snapshot: {
              id: row.snapshot_id,
              tenantId: row.snapshot_tenant_id,
              workspaceId: row.snapshot_workspace_id,
              sourceId: row.snapshot_source_id,
              contentHash: row.content_hash,
              objectRef: row.object_ref,
              objectVersionId: row.object_version_id,
              contentType: row.content_type,
              sizeBytes: Number(row.size_bytes),
              capturedAt: row.captured_at.toISOString(),
            },
            source: {
              id: row.source_id,
              tenantId: row.source_tenant_id,
              workspaceId: row.source_workspace_id,
              sourceType: row.source_type,
              title: row.source_title,
              uri: row.source_uri,
              license: row.source_license,
              publicity: row.source_publicity,
              currentSnapshotId: row.current_snapshot_id,
              createdAt: row.source_created_at.toISOString(),
            },
          }));
    });
  }

  findCurrentClaim(
    input: Parameters<EvidenceClaimStore['findCurrentClaim']>[0],
  ): Promise<ClaimCurrentState | null> {
    return this.contexts.run(input.context, async (client) => {
      const current = await client.query<{ revision_id: string }>(
        `SELECT revision.id AS revision_id
         FROM claims claim
         JOIN claim_revisions revision
           ON revision.tenant_id = claim.tenant_id
          AND revision.claim_id = claim.id
          AND revision.revision = claim.current_revision
         WHERE claim.id = $1 AND claim.workspace_id = $2
         FOR UPDATE OF revision`,
        [input.claimId, input.context.workspaceId],
      );
      const revisionId = current.rows[0]?.revision_id;
      if (revisionId === undefined) {
        return null;
      }
      let bundle = await this.loadClaimBundle(
        client,
        input.claimId,
        revisionId,
        input.context.workspaceId,
      );
      if (bundle === null) {
        return null;
      }
      const sourceState = await client.query<{
        snapshot_id: string;
        current_snapshot_id: string | null;
      }>(
        `SELECT link.snapshot_id, source.current_snapshot_id
         FROM claim_evidence_links link
         JOIN evidence_snapshots snapshot
           ON snapshot.tenant_id = link.tenant_id AND snapshot.id = link.snapshot_id
         JOIN evidence_sources source
           ON source.tenant_id = snapshot.tenant_id AND source.id = snapshot.source_id
         WHERE link.claim_revision_id = $1`,
        [revisionId],
      );
      const sourceChanged = sourceState.rows.some(
        (row) => row.snapshot_id !== row.current_snapshot_id,
      );
      const expired =
        bundle.revision.expiresAt !== null &&
        new Date(bundle.revision.expiresAt).getTime() <= input.evaluatedAt.getTime();
      if (bundle.revision.status === 'APPROVED' && (sourceChanged || expired)) {
        await client.query(`UPDATE claim_revisions SET status = 'STALE' WHERE id = $1`, [
          revisionId,
        ]);
        await client.query(
          `INSERT INTO audit_events
            (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
              outcome, metadata, occurred_at)
           VALUES ($1, $2, $3, $4, 'CLAIM_STALE', 'CLAIM_REVISION', $5, 'SUCCEEDED',
             jsonb_build_object('sourceChanged', $6::boolean, 'expired', $7::boolean,
               'contentHash', $8::text), $9)`,
          [
            input.auditEventId,
            input.context.tenantId,
            input.context.workspaceId,
            input.context.actorUserId,
            revisionId,
            sourceChanged,
            expired,
            bundle.revision.contentHash,
            input.evaluatedAt,
          ],
        );
        bundle = { ...bundle, revision: { ...bundle.revision, status: 'STALE' } };
      }
      const staleReasons: ClaimCurrentState['staleReasons'] = [];
      if (sourceChanged) {
        staleReasons.push('SOURCE_CHANGED');
      }
      if (expired) {
        staleReasons.push('EXPIRED');
      }
      if (bundle.revision.status !== 'APPROVED' && bundle.revision.status !== 'STALE') {
        staleReasons.push('NOT_APPROVED');
      }
      const currentUsable = bundle.revision.status === 'APPROVED' && staleReasons.length === 0;
      return {
        ...bundle,
        currentUsable,
        staleReasons,
        reviewRequired: !currentUsable,
      };
    });
  }

  private mapSource(row: EvidenceSourceRow): EvidenceSourceRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      sourceType: row.source_type,
      title: row.title,
      uri: row.uri,
      license: row.license,
      publicity: row.publicity,
      currentSnapshotId: row.current_snapshot_id,
      createdAt: row.created_at.toISOString(),
    };
  }

  private mapSnapshot(row: EvidenceSnapshotRow): EvidenceSnapshotRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      sourceId: row.source_id,
      contentHash: row.content_hash,
      objectRef: row.object_ref,
      objectVersionId: row.object_version_id,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      capturedAt: row.captured_at.toISOString(),
    };
  }

  private async loadClaimBundle(
    client: PoolClient,
    claimId: string,
    revisionId: string,
    workspaceId: string,
  ): Promise<ClaimBundle | null> {
    const claimResult = await client.query<ClaimRow>(
      `SELECT id, tenant_id, workspace_id, current_revision, created_at
       FROM claims WHERE id = $1 AND workspace_id = $2`,
      [claimId, workspaceId],
    );
    const revisionResult = await client.query<ClaimRevisionRow>(
      `SELECT id, tenant_id, workspace_id, claim_id, revision, statement, numeric_value,
         unit, scope, conditions, expires_at, content_hash, status, created_by_user_id,
         created_at
       FROM claim_revisions WHERE id = $1 AND claim_id = $2 AND workspace_id = $3`,
      [revisionId, claimId, workspaceId],
    );
    const linkResult = await client.query<ClaimEvidenceLinkRow>(
      `SELECT id, snapshot_id, source_hash, snippet
       FROM claim_evidence_links
       WHERE claim_revision_id = $1 AND workspace_id = $2 ORDER BY id`,
      [revisionId, workspaceId],
    );
    const claim = claimResult.rows[0];
    const revision = revisionResult.rows[0];
    if (claim === undefined || revision === undefined) {
      return null;
    }
    return {
      claim: this.mapClaim(claim),
      revision: {
        ...this.mapClaimRevision(revision),
        evidence: linkResult.rows.map((row) => ({
          id: row.id,
          snapshotId: row.snapshot_id,
          sourceHash: row.source_hash,
          snippet: row.snippet,
        })),
      },
    };
  }

  private mapClaim(row: ClaimRow): ClaimRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      currentRevision: row.current_revision,
      createdAt: row.created_at.toISOString(),
    };
  }

  private mapClaimRevision(row: ClaimRevisionRow): Omit<ClaimRevisionRecord, 'evidence'> {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      claimId: row.claim_id,
      revision: row.revision,
      statement: row.statement,
      numericValue: row.numeric_value,
      unit: row.unit,
      scope: row.scope,
      conditions: row.conditions,
      expiresAt: row.expires_at?.toISOString() ?? null,
      contentHash: row.content_hash,
      status: row.status,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at.toISOString(),
    };
  }
}
