import type { ArtifactStore } from '@aeostudio/application/artifacts';
import type {
  ArtifactClaimBinding,
  ArtifactLineage,
  ArtifactReviewRecord,
  ArtifactRecord,
  ArtifactRevisionRecord,
  ArtifactWriterContext,
} from '@aeostudio/domain/artifacts';
import type { Pool } from 'pg';

import { TenantContextRunner } from '../tenant-context/tenant-context-runner.js';

interface ArtifactRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  brief_id: string;
  artifact_type: ArtifactRecord['type'];
  current_revision: number;
  status: ArtifactRecord['status'];
  locale: string;
  market: string;
  method_policy_version: string;
  job_id: string | null;
  created_by_user_id: string;
  created_at: Date;
}

interface WriterSourceRow extends ArtifactRow {
  brief_content_hash: string;
  brief_title: string;
  prompt_ids: string[];
  source_artifact_ids: string[];
  claim_revision_ids: string[];
}

interface WriterClaimRow {
  claim_id: string;
  revision_id: string;
  content_hash: string;
  statement: string;
  conditions: Record<string, unknown>;
  source_id: string;
  snapshot_id: string;
  source_hash: string;
}

interface ArtifactRevisionRow {
  id: string;
  artifact_id: string;
  revision: number;
  brief_id: string;
  artifact_type: ArtifactRevisionRecord['type'];
  schema_version: '1.0.0';
  content_hash: string;
  status: ArtifactRevisionRecord['status'];
  locale: string;
  market: string;
  source_artifact_ids: string[];
  lineage: ArtifactLineage;
  claim_bindings: ArtifactClaimBinding[];
  method_policy_version: string;
  created_by_actor_kind: 'USER' | 'AGENT';
  created_by_actor_id: string;
  created_at: Date;
  payload_object_ref: string;
}

interface ArtifactLineageRow {
  content_plan_id: string;
  brief_id: string;
  brief_content_hash: string;
  prompt_set_id: string;
  prompt_revision_id: string;
  prompt_revision: number;
  prompt_content_hash: string;
  prompt_ids: string[];
  profile_revision_id: string;
  profile_id: string;
  profile_revision: number;
  profile_content_hash: string;
  offering_revision_id: string;
  offering_id: string;
  offering_revision: number;
  offering_content_hash: string;
  baseline_id: string;
  site_id: string;
}

interface ArtifactReviewRow {
  id: string;
  artifact_id: string;
  artifact_revision_id: string;
  revision: number;
  content_hash: string;
  decision: 'APPROVE' | 'REJECT';
  reviewer_user_id: string;
  note: string;
  created_at: Date;
}

export class PostgresArtifactStore implements ArtifactStore {
  private readonly contexts: TenantContextRunner;

  constructor(pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  prepareArtifact(input: Parameters<ArtifactStore['prepareArtifact']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const source = await client.query<{ asset_kind: ArtifactRecord['type'] }>(
        `SELECT brief.asset_kind
         FROM briefs brief
         JOIN content_plans plan ON plan.id = brief.content_plan_id
         WHERE brief.id = $1
           AND brief.workspace_id = $3
           AND plan.workspace_id = $3
           AND brief.status = 'APPROVED'
           AND plan.status = 'READY'
           AND NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements_text(brief.claim_revision_ids) claim_ref
             LEFT JOIN claim_revisions revision ON revision.id = claim_ref.value::uuid
             WHERE revision.id IS NULL
               OR revision.workspace_id <> $3
               OR revision.status <> 'APPROVED'
               OR (revision.expires_at IS NOT NULL AND revision.expires_at <= $2)
               OR NOT EXISTS (
                 SELECT 1
                 FROM claim_evidence_links link
                 JOIN evidence_snapshots snapshot ON snapshot.id = link.snapshot_id
                 JOIN evidence_sources evidence_source
                   ON evidence_source.id = snapshot.source_id
                   AND evidence_source.current_snapshot_id = snapshot.id
                 WHERE link.claim_revision_id = revision.id
                   AND link.workspace_id = $3
                   AND snapshot.workspace_id = $3
                   AND evidence_source.workspace_id = $3
                   AND link.source_hash = snapshot.content_hash
               )
           )`,
        [input.briefId, input.createdAt, input.context.workspaceId],
      );
      const sourceRow = source.rows[0];
      if (sourceRow === undefined) {
        return { outcome: 'INVALID_REFERENCE' as const, referenceType: 'APPROVED_BRIEF' };
      }
      if ((await this.resolveLineage(client, input.briefId, input.context.workspaceId)) === null) {
        return { outcome: 'INVALID_REFERENCE' as const, referenceType: 'SOURCE_ARTIFACTS' };
      }
      const inserted = await client.query<ArtifactRow>(
        `INSERT INTO artifacts
          (id, tenant_id, workspace_id, brief_id, artifact_type, current_revision, status,
            locale, market, method_policy_version, created_by_user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, 1, 'PENDING', $6, $7, $8, $9, $10)
         RETURNING id, tenant_id, workspace_id, brief_id, artifact_type, current_revision,
           status, locale, market, method_policy_version, job_id, created_by_user_id, created_at`,
        [
          input.artifactId,
          input.context.tenantId,
          input.context.workspaceId,
          input.briefId,
          sourceRow.asset_kind,
          input.locale,
          input.market,
          input.methodPolicyVersion,
          input.context.actorUserId,
          input.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'ARTIFACT_GENERATION_PREPARED', 'ARTIFACT', $5,
           'SUCCEEDED', jsonb_build_object('briefId', $6::uuid, 'type', $7::text,
             'methodPolicyVersion', $8::text, 'revision', 1), $9)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.artifactId,
          input.briefId,
          sourceRow.asset_kind,
          input.methodPolicyVersion,
          input.createdAt,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('ARTIFACT_DID_NOT_RETURN_RESULT');
      return { outcome: 'SUCCEEDED' as const, artifact: this.mapArtifact(row) };
    });
  }

  bindJob(input: Parameters<ArtifactStore['bindJob']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<ArtifactRow>(
        `UPDATE artifacts SET job_id = $1
         WHERE id = $2 AND workspace_id = $3
         RETURNING id, tenant_id, workspace_id, brief_id, artifact_type, current_revision,
           status, locale, market, method_policy_version, job_id, created_by_user_id, created_at`,
        [input.jobId, input.artifactId, input.context.workspaceId],
      );
      return result.rows[0] === undefined ? null : this.mapArtifact(result.rows[0]);
    });
  }

  loadWriterContext(input: Parameters<ArtifactStore['loadWriterContext']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const source = await client.query<WriterSourceRow>(
        `SELECT artifact.id, artifact.tenant_id, artifact.workspace_id, artifact.brief_id,
           artifact.artifact_type, artifact.current_revision, artifact.status, artifact.locale,
           artifact.market, artifact.method_policy_version, artifact.job_id,
           artifact.created_by_user_id, artifact.created_at,
           brief.content_hash AS brief_content_hash, brief.title AS brief_title,
           brief.prompt_ids, brief.source_artifact_ids, brief.claim_revision_ids
         FROM artifacts artifact
         JOIN briefs brief ON brief.id = artifact.brief_id
         JOIN content_plans plan ON plan.id = brief.content_plan_id
         WHERE artifact.id = $1
           AND artifact.workspace_id = $2
           AND brief.workspace_id = $2
           AND plan.workspace_id = $2
           AND artifact.status = 'PENDING'
           AND brief.status = 'APPROVED'
           AND plan.status = 'READY'
           AND brief.prompt_ids <@ (plan.input_snapshot -> 'promptIds')
           AND brief.source_artifact_ids <@ (plan.input_snapshot -> 'availableSourceArtifactIds')`,
        [input.artifactId, input.context.workspaceId],
      );
      const sourceRow = source.rows[0];
      if (sourceRow === undefined) return null;
      const lineage = await this.resolveLineage(
        client,
        sourceRow.brief_id,
        input.context.workspaceId,
      );
      if (lineage === null) return null;
      const requestedClaims = [...new Set(sourceRow.claim_revision_ids)];
      const claims = await client.query<WriterClaimRow>(
        `SELECT revision.claim_id, revision.id AS revision_id, revision.content_hash,
           revision.statement, revision.conditions,
           evidence_source.id AS source_id, snapshot.id AS snapshot_id,
           snapshot.content_hash AS source_hash
         FROM claim_revisions revision
         JOIN claim_evidence_links link ON link.claim_revision_id = revision.id
         JOIN evidence_snapshots snapshot ON snapshot.id = link.snapshot_id
         JOIN evidence_sources evidence_source
           ON evidence_source.id = snapshot.source_id
           AND evidence_source.current_snapshot_id = snapshot.id
         WHERE revision.id = ANY($1::uuid[])
           AND revision.workspace_id = $3
           AND link.workspace_id = $3
           AND snapshot.workspace_id = $3
           AND evidence_source.workspace_id = $3
           AND revision.status = 'APPROVED'
           AND (revision.expires_at IS NULL OR revision.expires_at > $2)
           AND link.source_hash = snapshot.content_hash
         ORDER BY revision.id, snapshot.id`,
        [requestedClaims, input.effectiveAt, input.context.workspaceId],
      );
      const grouped = new Map<string, ArtifactWriterContext['claims'][number]>();
      for (const row of claims.rows) {
        const claim = grouped.get(row.revision_id) ?? {
          claimId: row.claim_id,
          revisionId: row.revision_id,
          contentHash: row.content_hash,
          statement: row.statement,
          conditions: row.conditions,
          evidence: [],
        };
        claim.evidence.push({
          sourceId: row.source_id,
          snapshotId: row.snapshot_id,
          sourceHash: row.source_hash,
        });
        grouped.set(row.revision_id, claim);
      }
      if (requestedClaims.some((id) => !grouped.has(id))) return null;
      return {
        schemaVersion: '1.0.0' as const,
        type: sourceRow.artifact_type,
        locale: sourceRow.locale,
        market: sourceRow.market,
        methodPolicyVersion: sourceRow.method_policy_version,
        brief: {
          id: sourceRow.brief_id,
          contentHash: sourceRow.brief_content_hash,
          title: sourceRow.brief_title,
          promptIds: sourceRow.prompt_ids,
          sourceArtifactIds: sourceRow.source_artifact_ids,
          lineage,
        },
        claims: requestedClaims.map(
          (id) => grouped.get(id) as ArtifactWriterContext['claims'][number],
        ),
      };
    });
  }

  completeGeneration(input: Parameters<ArtifactStore['completeGeneration']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const current = await client.query<WriterSourceRow>(
        `SELECT artifact.id, artifact.tenant_id, artifact.workspace_id, artifact.brief_id,
           artifact.artifact_type, artifact.current_revision, artifact.status, artifact.locale,
           artifact.market, artifact.method_policy_version, artifact.job_id,
           artifact.created_by_user_id, artifact.created_at,
           brief.content_hash AS brief_content_hash, brief.title AS brief_title,
           brief.prompt_ids, brief.source_artifact_ids, brief.claim_revision_ids
         FROM artifacts artifact
         JOIN briefs brief ON brief.id = artifact.brief_id
         WHERE artifact.id = $1 AND artifact.workspace_id = $2
         FOR UPDATE OF artifact`,
        [input.artifactId, input.context.workspaceId],
      );
      const artifact = current.rows[0];
      if (artifact === undefined || artifact.status !== 'PENDING') return null;
      if (!this.sameIds(artifact.source_artifact_ids, input.sourceArtifactIds)) return null;
      const currentLineage = await this.resolveLineage(
        client,
        artifact.brief_id,
        input.context.workspaceId,
      );
      if (currentLineage === null || !this.sameJson(currentLineage, input.lineage)) {
        return null;
      }
      if (
        !this.sameIds(
          artifact.claim_revision_ids,
          input.claimBindings.map((binding) => binding.claimRevisionId),
        )
      ) {
        return null;
      }
      const evidence = input.claimBindings.flatMap((binding) =>
        binding.evidence.map((entry) => ({ binding, entry })),
      );
      if (evidence.length !== input.claimLinkIds.length) return null;
      for (const { binding, entry } of evidence) {
        const valid = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM claim_revisions revision
             JOIN claim_evidence_links link ON link.claim_revision_id = revision.id
             JOIN evidence_snapshots snapshot ON snapshot.id = link.snapshot_id
             JOIN evidence_sources evidence_source
               ON evidence_source.id = snapshot.source_id
               AND evidence_source.current_snapshot_id = snapshot.id
             WHERE revision.id = $1
               AND revision.claim_id = $5
               AND revision.content_hash = $6
               AND revision.statement = $8
               AND revision.workspace_id = $7
               AND revision.status = 'APPROVED'
               AND (revision.expires_at IS NULL OR revision.expires_at > $9)
               AND link.workspace_id = $7
               AND snapshot.workspace_id = $7
               AND evidence_source.workspace_id = $7
               AND link.snapshot_id = $2 AND snapshot.source_id = $3
               AND snapshot.content_hash = $4 AND link.source_hash = $4
           ) AS exists`,
          [
            binding.claimRevisionId,
            entry.snapshotId,
            entry.sourceId,
            entry.sourceHash,
            binding.claimId,
            binding.claimContentHash,
            input.context.workspaceId,
            binding.claimStatement,
            input.createdAt,
          ],
        );
        if (valid.rows[0]?.exists !== true) return null;
      }
      const revision = await client.query<ArtifactRevisionRow>(
        `INSERT INTO artifact_revisions
          (id, tenant_id, workspace_id, artifact_id, revision, brief_id, artifact_type,
            schema_version, content_hash, status, locale, market, source_artifact_ids,
            lineage, claim_bindings, method_policy_version, created_by_actor_kind,
            created_by_actor_id, created_at, payload_object_ref)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, 'DRAFT', $9, $10, $11::jsonb,
           $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18)
         RETURNING id, artifact_id, revision, brief_id, artifact_type, schema_version,
           content_hash, status, locale, market, source_artifact_ids, lineage, claim_bindings,
           method_policy_version, created_by_actor_kind, created_by_actor_id, created_at,
           payload_object_ref`,
        [
          input.revisionId,
          input.context.tenantId,
          input.context.workspaceId,
          input.artifactId,
          artifact.brief_id,
          artifact.artifact_type,
          input.schemaVersion,
          input.contentHash,
          artifact.locale,
          artifact.market,
          JSON.stringify(input.sourceArtifactIds),
          JSON.stringify(input.lineage),
          JSON.stringify(input.claimBindings),
          artifact.method_policy_version,
          input.createdByActor.kind,
          input.createdByActor.id,
          input.createdAt,
          input.payloadObjectRef,
        ],
      );
      for (const [index, { binding, entry }] of evidence.entries()) {
        await client.query(
          `INSERT INTO artifact_claim_links
            (id, tenant_id, workspace_id, artifact_revision_id, claim_revision_id,
              source_id, snapshot_id, source_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            input.claimLinkIds[index],
            input.context.tenantId,
            input.context.workspaceId,
            input.revisionId,
            binding.claimRevisionId,
            entry.sourceId,
            entry.snapshotId,
            entry.sourceHash,
          ],
        );
      }
      const updated = await client.query<ArtifactRow>(
        `UPDATE artifacts SET status = 'DRAFT'
         WHERE id = $1
         RETURNING id, tenant_id, workspace_id, brief_id, artifact_type, current_revision,
           status, locale, market, method_policy_version, job_id, created_by_user_id, created_at`,
        [input.artifactId],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, actor_kind, actor_id, action,
            resource_type, resource_id, outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'ARTIFACT_REVISION_GENERATED',
           'ARTIFACT_REVISION', $7, 'SUCCEEDED',
           jsonb_build_object('artifactId', $8::uuid, 'revision', 1,
             'contentHash', $9::text, 'type', $10::text, 'claimCount', $11::integer,
             'sourceArtifactCount', $12::integer, 'requestedByUserId', $4::uuid), $13)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          artifact.created_by_user_id,
          input.createdByActor.kind,
          input.createdByActor.id,
          input.revisionId,
          input.artifactId,
          input.contentHash,
          artifact.artifact_type,
          input.claimBindings.length,
          input.sourceArtifactIds.length,
          input.createdAt,
        ],
      );
      const artifactRow = updated.rows[0];
      const revisionRow = revision.rows[0];
      if (artifactRow === undefined || revisionRow === undefined) return null;
      return {
        artifact: this.mapArtifact(artifactRow),
        revision: this.mapRevision(revisionRow),
      };
    });
  }

  createRevision(input: Parameters<ArtifactStore['createRevision']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const aggregate = await client.query<ArtifactRow>(
        `SELECT id, tenant_id, workspace_id, brief_id, artifact_type, current_revision,
           status, locale, market, method_policy_version, job_id, created_by_user_id, created_at
         FROM artifacts WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [input.artifactId, input.context.workspaceId],
      );
      const artifact = aggregate.rows[0];
      if (artifact === undefined) return { outcome: 'NOT_FOUND' as const };
      if (artifact.current_revision !== input.expectedRevision) {
        return { outcome: 'REVISION_CONFLICT' as const };
      }
      const baseResult = await client.query<ArtifactRevisionRow>(
        `SELECT id, artifact_id, revision, brief_id, artifact_type, schema_version,
           content_hash, status, locale, market, source_artifact_ids, lineage, claim_bindings,
           method_policy_version, created_by_actor_kind, created_by_actor_id, created_at,
           payload_object_ref
         FROM artifact_revisions WHERE artifact_id = $1 AND revision = $2`,
        [input.artifactId, input.expectedRevision],
      );
      const base = baseResult.rows[0];
      if (
        base === undefined ||
        !(await this.revisionIsCurrent(client, base, input.createdAt, input.context.workspaceId))
      ) {
        return { outcome: 'INVALID_REFERENCE' as const };
      }
      const evidence = base.claim_bindings.flatMap((binding) =>
        binding.evidence.map((entry) => ({ binding, entry })),
      );
      if (evidence.length !== input.claimLinkIds.length) {
        return { outcome: 'INVALID_REFERENCE' as const };
      }
      const nextRevision = input.expectedRevision + 1;
      const inserted = await client.query<ArtifactRevisionRow>(
        `INSERT INTO artifact_revisions
          (id, tenant_id, workspace_id, artifact_id, revision, brief_id, artifact_type,
            schema_version, content_hash, status, locale, market, source_artifact_ids,
            lineage, claim_bindings, method_policy_version, created_by_actor_kind,
            created_by_actor_id, created_at, payload_object_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'DRAFT', $10, $11, $12::jsonb,
           $13::jsonb, $14::jsonb, $15, 'USER', $16, $17, $18)
         RETURNING id, artifact_id, revision, brief_id, artifact_type, schema_version,
           content_hash, status, locale, market, source_artifact_ids, lineage, claim_bindings,
           method_policy_version, created_by_actor_kind, created_by_actor_id, created_at,
           payload_object_ref`,
        [
          input.revisionId,
          input.context.tenantId,
          input.context.workspaceId,
          input.artifactId,
          nextRevision,
          base.brief_id,
          base.artifact_type,
          base.schema_version,
          input.contentHash,
          base.locale,
          base.market,
          JSON.stringify(base.source_artifact_ids),
          JSON.stringify(base.lineage),
          JSON.stringify(base.claim_bindings),
          base.method_policy_version,
          input.context.actorUserId,
          input.createdAt,
          input.payloadObjectRef,
        ],
      );
      for (const [index, { binding, entry }] of evidence.entries()) {
        await client.query(
          `INSERT INTO artifact_claim_links
            (id, tenant_id, workspace_id, artifact_revision_id, claim_revision_id,
              source_id, snapshot_id, source_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            input.claimLinkIds[index],
            input.context.tenantId,
            input.context.workspaceId,
            input.revisionId,
            binding.claimRevisionId,
            entry.sourceId,
            entry.snapshotId,
            entry.sourceHash,
          ],
        );
      }
      const updated = await client.query<ArtifactRow>(
        `UPDATE artifacts SET current_revision = $1, status = 'DRAFT'
         WHERE id = $2
         RETURNING id, tenant_id, workspace_id, brief_id, artifact_type, current_revision,
           status, locale, market, method_policy_version, job_id, created_by_user_id, created_at`,
        [nextRevision, input.artifactId],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'ARTIFACT_REVISION_CREATED', 'ARTIFACT_REVISION', $5,
           'SUCCEEDED', jsonb_build_object('artifactId', $6::uuid, 'revision', $7::integer,
             'contentHash', $8::text, 'previousRevision', $9::integer), $10)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.revisionId,
          input.artifactId,
          nextRevision,
          input.contentHash,
          input.expectedRevision,
          input.createdAt,
        ],
      );
      const artifactRow = updated.rows[0];
      const revisionRow = inserted.rows[0];
      if (artifactRow === undefined || revisionRow === undefined)
        throw new Error('ARTIFACT_REVISION_NOT_RETURNED');
      return {
        outcome: 'SUCCEEDED' as const,
        artifact: this.mapArtifact(artifactRow),
        revision: this.mapRevision(revisionRow),
      };
    });
  }

  submitRevision(input: Parameters<ArtifactStore['submitRevision']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<ArtifactRevisionRow & { current_revision: number }>(
        `SELECT revision.id, revision.artifact_id, revision.revision, revision.brief_id,
           revision.artifact_type, revision.schema_version, revision.content_hash,
           revision.status, revision.locale, revision.market, revision.source_artifact_ids,
           revision.lineage, revision.claim_bindings, revision.method_policy_version,
           revision.created_by_actor_kind, revision.created_by_actor_id, revision.created_at,
           revision.payload_object_ref, artifact.current_revision
         FROM artifact_revisions revision
         JOIN artifacts artifact ON artifact.id = revision.artifact_id
         WHERE revision.artifact_id = $1 AND revision.revision = $2
           AND revision.workspace_id = $3
         FOR UPDATE OF revision, artifact`,
        [input.artifactId, input.revision, input.context.workspaceId],
      );
      const row = result.rows[0];
      if (row === undefined) return { outcome: 'NOT_FOUND' as const };
      if (row.content_hash !== input.expectedContentHash)
        return { outcome: 'HASH_MISMATCH' as const };
      if (row.status !== 'DRAFT') return { outcome: 'INVALID_STATE' as const };
      const updated = await client.query<ArtifactRevisionRow>(
        `UPDATE artifact_revisions SET status = 'IN_REVIEW' WHERE id = $1
         RETURNING id, artifact_id, revision, brief_id, artifact_type, schema_version,
           content_hash, status, locale, market, source_artifact_ids, lineage, claim_bindings,
           method_policy_version, created_by_actor_kind, created_by_actor_id, created_at,
           payload_object_ref`,
        [row.id],
      );
      if (row.current_revision === row.revision) {
        await client.query(`UPDATE artifacts SET status = 'IN_REVIEW' WHERE id = $1`, [
          input.artifactId,
        ]);
      }
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'ARTIFACT_REVISION_SUBMITTED', 'ARTIFACT_REVISION', $5,
           'SUCCEEDED', jsonb_build_object('artifactId', $6::uuid, 'revision', $7::integer,
             'contentHash', $8::text), $9)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          row.id,
          input.artifactId,
          row.revision,
          row.content_hash,
          input.submittedAt,
        ],
      );
      const revision = updated.rows[0];
      if (revision === undefined) throw new Error('SUBMITTED_ARTIFACT_REVISION_NOT_RETURNED');
      return { outcome: 'SUCCEEDED' as const, revision: this.mapRevision(revision) };
    });
  }

  reviewRevision(input: Parameters<ArtifactStore['reviewRevision']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<ArtifactRevisionRow & { current_revision: number }>(
        `SELECT revision.id, revision.artifact_id, revision.revision, revision.brief_id,
           revision.artifact_type, revision.schema_version, revision.content_hash,
           revision.status, revision.locale, revision.market, revision.source_artifact_ids,
           revision.lineage, revision.claim_bindings, revision.method_policy_version,
           revision.created_by_actor_kind, revision.created_by_actor_id, revision.created_at,
           revision.payload_object_ref, artifact.current_revision
         FROM artifact_revisions revision
         JOIN artifacts artifact ON artifact.id = revision.artifact_id
         WHERE revision.artifact_id = $1 AND revision.revision = $2
           AND revision.workspace_id = $3
         FOR UPDATE OF revision, artifact`,
        [input.artifactId, input.revision, input.context.workspaceId],
      );
      const row = result.rows[0];
      if (row === undefined) return { outcome: 'NOT_FOUND' as const };
      if (row.content_hash !== input.expectedContentHash)
        return { outcome: 'HASH_MISMATCH' as const };
      if (
        row.created_by_actor_kind === 'USER' &&
        row.created_by_actor_id === input.context.actorUserId
      ) {
        return { outcome: 'SELF_APPROVAL' as const };
      }
      if (row.status !== 'IN_REVIEW') return { outcome: 'INVALID_STATE' as const };
      const currentLineage = await this.resolveLineage(
        client,
        row.brief_id,
        input.context.workspaceId,
      );
      if (
        !(await this.referencesAreCurrent(client, row, input.reviewedAt)) ||
        currentLineage === null ||
        !this.sameJson(currentLineage, row.lineage)
      ) {
        return { outcome: 'INVALID_REFERENCE' as const };
      }
      const duplicate = await client.query(
        `SELECT 1 FROM artifact_reviews WHERE artifact_revision_id = $1`,
        [row.id],
      );
      if (duplicate.rowCount !== 0) return { outcome: 'ALREADY_REVIEWED' as const };
      const reviewResult = await client.query<ArtifactReviewRow>(
        `INSERT INTO artifact_reviews
          (id, tenant_id, workspace_id, artifact_id, artifact_revision_id, revision,
            content_hash, decision, reviewer_user_id, note, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, artifact_id, artifact_revision_id, revision, content_hash, decision,
           reviewer_user_id, note, created_at`,
        [
          input.reviewId,
          input.context.tenantId,
          input.context.workspaceId,
          input.artifactId,
          row.id,
          row.revision,
          row.content_hash,
          input.decision,
          input.context.actorUserId,
          input.note,
          input.reviewedAt,
        ],
      );
      const status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      const revisionResult = await client.query<ArtifactRevisionRow>(
        `UPDATE artifact_revisions SET status = $1 WHERE id = $2
         RETURNING id, artifact_id, revision, brief_id, artifact_type, schema_version,
           content_hash, status, locale, market, source_artifact_ids, lineage, claim_bindings,
           method_policy_version, created_by_actor_kind, created_by_actor_id, created_at,
           payload_object_ref`,
        [status, row.id],
      );
      if (row.current_revision === row.revision) {
        await client.query(`UPDATE artifacts SET status = $1 WHERE id = $2`, [
          status,
          input.artifactId,
        ]);
      }
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'ARTIFACT_REVISION_REVIEWED', 'ARTIFACT_REVISION', $5,
           'SUCCEEDED', jsonb_build_object('artifactId', $6::uuid, 'revision', $7::integer,
             'contentHash', $8::text, 'decision', $9::text), $10)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          row.id,
          input.artifactId,
          row.revision,
          row.content_hash,
          input.decision,
          input.reviewedAt,
        ],
      );
      const revision = revisionResult.rows[0];
      const review = reviewResult.rows[0];
      if (revision === undefined || review === undefined)
        throw new Error('ARTIFACT_REVIEW_NOT_RETURNED');
      return {
        outcome: 'SUCCEEDED' as const,
        revision: this.mapRevision(revision),
        review: this.mapReview(review),
      };
    });
  }

  findBundle(input: Parameters<ArtifactStore['findBundle']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const artifactResult = await client.query<ArtifactRow>(
        `SELECT id, tenant_id, workspace_id, brief_id, artifact_type, current_revision,
           status, locale, market, method_policy_version, job_id, created_by_user_id, created_at
         FROM artifacts WHERE id = $1 AND workspace_id = $2`,
        [input.artifactId, input.context.workspaceId],
      );
      const artifact = artifactResult.rows[0];
      if (artifact === undefined) return null;
      const revisionResult = await client.query<ArtifactRevisionRow>(
        `SELECT id, artifact_id, revision, brief_id, artifact_type, schema_version,
           content_hash, status, locale, market, source_artifact_ids, lineage, claim_bindings,
           method_policy_version, created_by_actor_kind, created_by_actor_id, created_at,
           payload_object_ref
         FROM artifact_revisions
         WHERE artifact_id = $1 ORDER BY revision`,
        [input.artifactId],
      );
      const reviewResult = await client.query<ArtifactReviewRow>(
        `SELECT id, artifact_id, artifact_revision_id, revision, content_hash, decision,
           reviewer_user_id, note, created_at
         FROM artifact_reviews WHERE artifact_id = $1 ORDER BY revision`,
        [input.artifactId],
      );
      const revisions = revisionResult.rows.map((row) => this.mapRevision(row));
      const current =
        revisions.find((revision) => revision.revision === artifact.current_revision) ?? null;
      const currentRow = revisionResult.rows.find(
        (row) => row.revision === artifact.current_revision,
      );
      const currentRefsValid =
        currentRow !== undefined &&
        (await this.revisionIsCurrent(
          client,
          currentRow,
          input.effectiveAt,
          input.context.workspaceId,
        ));
      const selectableApprovedRevisions: { revision: number; contentHash: string }[] = [];
      for (const row of revisionResult.rows) {
        if (
          row.status === 'APPROVED' &&
          (await this.revisionIsCurrent(client, row, input.effectiveAt, input.context.workspaceId))
        ) {
          selectableApprovedRevisions.push({
            revision: row.revision,
            contentHash: row.content_hash,
          });
        }
      }
      const approvalState =
        current === null
          ? ('APPROVAL_REQUIRED' as const)
          : !currentRefsValid
            ? ('APPROVAL_STALE' as const)
            : current.status === 'APPROVED'
              ? ('ELIGIBLE' as const)
              : selectableApprovedRevisions.length > 0
                ? ('APPROVAL_STALE' as const)
                : ('APPROVAL_REQUIRED' as const);
      return {
        artifact: this.mapArtifact(artifact),
        revision: current,
        revisions,
        reviews: reviewResult.rows.map((row) => this.mapReview(row)),
        approvalState,
        selectableApprovedRevisions,
      };
    });
  }

  private mapArtifact(row: ArtifactRow): ArtifactRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      briefId: row.brief_id,
      type: row.artifact_type,
      revision: row.current_revision,
      status: row.status,
      locale: row.locale,
      market: row.market,
      methodPolicyVersion: row.method_policy_version,
      jobId: row.job_id,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at.toISOString(),
    };
  }

  private mapRevision(row: ArtifactRevisionRow): ArtifactRevisionRecord {
    return {
      id: row.id,
      artifactId: row.artifact_id,
      revision: row.revision,
      briefId: row.brief_id,
      type: row.artifact_type,
      schemaVersion: row.schema_version,
      contentHash: row.content_hash,
      status: row.status,
      locale: row.locale,
      market: row.market,
      sourceArtifactIds: row.source_artifact_ids,
      lineage: row.lineage,
      claimBindings: row.claim_bindings,
      methodPolicyVersion: row.method_policy_version,
      createdByActor: { kind: row.created_by_actor_kind, id: row.created_by_actor_id },
      createdAt: row.created_at.toISOString(),
      payloadObjectRef: row.payload_object_ref,
    };
  }

  private mapReview(row: ArtifactReviewRow): ArtifactReviewRecord {
    return {
      id: row.id,
      artifactId: row.artifact_id,
      artifactRevisionId: row.artifact_revision_id,
      revision: row.revision,
      contentHash: row.content_hash,
      decision: row.decision,
      reviewerUserId: row.reviewer_user_id,
      note: row.note,
      createdAt: row.created_at.toISOString(),
    };
  }

  private async resolveLineage(
    client: { query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> },
    briefId: string,
    workspaceId: string,
  ): Promise<ArtifactLineage | null> {
    const result = await client.query<ArtifactLineageRow>(
      `SELECT plan.id AS content_plan_id,
         brief.id AS brief_id,
         brief.content_hash AS brief_content_hash,
         prompt_set.id AS prompt_set_id,
         prompt_revision.id AS prompt_revision_id,
         prompt_revision.revision AS prompt_revision,
         prompt_revision.content_hash AS prompt_content_hash,
         brief.prompt_ids,
         profile_revision.id AS profile_revision_id,
         profile_revision.profile_id,
         profile_revision.revision AS profile_revision,
         profile_revision.content_hash AS profile_content_hash,
         offering_revision.id AS offering_revision_id,
         offering_revision.offering_id,
         offering_revision.revision AS offering_revision,
         offering_revision.content_hash AS offering_content_hash,
         crawl.id AS baseline_id,
         crawl.site_id
       FROM briefs brief
       JOIN content_plans plan
         ON plan.id = brief.content_plan_id
        AND plan.workspace_id = brief.workspace_id
       JOIN profile_revisions profile_revision
         ON profile_revision.id::text = plan.input_snapshot ->> 'profileRevisionId'
        AND profile_revision.workspace_id = brief.workspace_id
        AND profile_revision.profile_id::text = plan.input_snapshot #>> '{profile,id}'
        AND profile_revision.revision::text = plan.input_snapshot #>> '{profile,revision}'
       JOIN offering_revisions offering_revision
         ON offering_revision.id::text = plan.input_snapshot ->> 'offeringRevisionId'
        AND offering_revision.workspace_id = brief.workspace_id
        AND offering_revision.offering_id::text = plan.input_snapshot #>> '{offering,id}'
        AND offering_revision.revision::text = plan.input_snapshot #>> '{offering,revision}'
        AND offering_revision.profile_id = profile_revision.profile_id
       JOIN prompt_revisions prompt_revision
         ON prompt_revision.id::text = plan.input_snapshot ->> 'promptRevisionId'
        AND prompt_revision.workspace_id = brief.workspace_id
        AND prompt_revision.status = 'APPROVED'
       JOIN prompt_sets prompt_set
         ON prompt_set.id = prompt_revision.prompt_set_id
        AND prompt_set.workspace_id = brief.workspace_id
        AND prompt_set.id::text = plan.input_snapshot ->> 'promptSetId'
        AND prompt_set.current_revision = prompt_revision.revision
       JOIN measurement_scenarios scenario
         ON scenario.prompt_revision_id = prompt_revision.id
        AND scenario.workspace_id = brief.workspace_id
       JOIN prompt_approvals approval
         ON approval.prompt_revision_id = prompt_revision.id
        AND approval.scenario_id = scenario.id
        AND approval.workspace_id = brief.workspace_id
        AND approval.prompt_content_hash = prompt_revision.content_hash
        AND approval.scenario_content_hash = scenario.content_hash
       JOIN crawl_runs crawl
         ON crawl.id::text = plan.input_snapshot ->> 'baselineId'
        AND crawl.workspace_id = brief.workspace_id
        AND crawl.status IN ('COMPLETE', 'PARTIAL')
       JOIN sites site
         ON site.id = crawl.site_id
        AND site.workspace_id = brief.workspace_id
        AND site.profile_id = profile_revision.profile_id
       WHERE brief.id = $1
         AND brief.workspace_id = $2
         AND brief.status = 'APPROVED'
         AND plan.status = 'READY'
         AND brief.source_artifact_ids = plan.input_snapshot -> 'availableSourceArtifactIds'
         AND brief.source_artifact_ids = jsonb_build_array(
           profile_revision.id,
           offering_revision.id,
           prompt_revision.id,
           crawl.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(brief.prompt_ids) AS brief_prompt(id)
           WHERE NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements(prompt_revision.prompts) AS prompt(value)
             WHERE prompt.value ->> 'id' = brief_prompt.id
           )
         )`,
      [briefId, workspaceId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      contentPlanId: row.content_plan_id,
      brief: { id: row.brief_id, contentHash: row.brief_content_hash },
      prompt: {
        promptSetId: row.prompt_set_id,
        promptRevisionId: row.prompt_revision_id,
        contentHash: row.prompt_content_hash,
        promptIds: row.prompt_ids,
      },
      sourceReferences: [
        {
          kind: 'PROFILE_REVISION',
          id: row.profile_revision_id,
          aggregateId: row.profile_id,
          revision: row.profile_revision,
          contentHash: row.profile_content_hash,
        },
        {
          kind: 'OFFERING_REVISION',
          id: row.offering_revision_id,
          aggregateId: row.offering_id,
          revision: row.offering_revision,
          contentHash: row.offering_content_hash,
        },
        {
          kind: 'PROMPT_REVISION',
          id: row.prompt_revision_id,
          aggregateId: row.prompt_set_id,
          revision: row.prompt_revision,
          contentHash: row.prompt_content_hash,
        },
        {
          kind: 'SITE_BASELINE',
          id: row.baseline_id,
          aggregateId: row.site_id,
          revision: null,
          contentHash: null,
        },
      ],
    };
  }

  private async referencesAreCurrent(
    client: { query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> },
    revision: ArtifactRevisionRow,
    effectiveAt: Date,
  ): Promise<boolean> {
    for (const binding of revision.claim_bindings) {
      for (const evidence of binding.evidence) {
        const result = await client.query<{ valid: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM claim_revisions claim_revision
             JOIN claim_evidence_links link ON link.claim_revision_id = claim_revision.id
             JOIN evidence_snapshots snapshot ON snapshot.id = link.snapshot_id
             JOIN evidence_sources evidence_source
               ON evidence_source.id = snapshot.source_id
               AND evidence_source.current_snapshot_id = snapshot.id
             JOIN artifact_claim_links artifact_link
               ON artifact_link.artifact_revision_id = $9
               AND artifact_link.claim_revision_id = claim_revision.id
               AND artifact_link.snapshot_id = snapshot.id
               AND artifact_link.source_id = snapshot.source_id
               AND artifact_link.source_hash = snapshot.content_hash
             WHERE claim_revision.id = $1
               AND claim_revision.claim_id = $6
               AND claim_revision.content_hash = $7
               AND claim_revision.statement = $8
               AND claim_revision.status = 'APPROVED'
               AND (claim_revision.expires_at IS NULL OR claim_revision.expires_at > $2)
               AND snapshot.id = $3 AND snapshot.source_id = $4
               AND snapshot.content_hash = $5 AND link.source_hash = $5
           ) AS valid`,
          [
            binding.claimRevisionId,
            effectiveAt,
            evidence.snapshotId,
            evidence.sourceId,
            evidence.sourceHash,
            binding.claimId,
            binding.claimContentHash,
            binding.claimStatement,
            revision.id,
          ],
        );
        if (result.rows[0]?.valid !== true) return false;
      }
    }
    return revision.claim_bindings.length > 0;
  }

  private async revisionIsCurrent(
    client: { query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> },
    revision: ArtifactRevisionRow,
    effectiveAt: Date,
    workspaceId: string,
  ): Promise<boolean> {
    if (!(await this.referencesAreCurrent(client, revision, effectiveAt))) return false;
    const lineage = await this.resolveLineage(client, revision.brief_id, workspaceId);
    return lineage !== null && this.sameJson(lineage, revision.lineage);
  }

  private sameIds(left: string[], right: string[]): boolean {
    return [...new Set(left)].sort().join(':') === [...new Set(right)].sort().join(':');
  }

  private sameJson(left: unknown, right: unknown): boolean {
    return this.canonicalJson(left) === this.canonicalJson(right);
  }

  private canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return `[${value.map((entry) => this.canonicalJson(entry)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${this.canonicalJson(record[key])}`)
      .join(',')}}`;
  }
}
