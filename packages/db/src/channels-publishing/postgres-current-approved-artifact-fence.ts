import type { ArtifactRevisionRecord } from '@aeostudio/domain/artifacts';
import type { PoolClient } from 'pg';

interface CurrentApprovedArtifactFenceInput {
  tenantId: string;
  workspaceId: string;
  artifactId: string;
  artifactRevisionId: string;
  revision: number;
  contentHash: string;
  effectiveAt: Date;
}

interface CurrentApprovedArtifactRow {
  id: string;
  claim_bindings: ArtifactRevisionRecord['claimBindings'];
}

/**
 * Locks and verifies the same complete Artifact lineage used by the publication gate.
 * Callers must keep the surrounding transaction open until their guarded write commits.
 */
export async function lockCurrentApprovedArtifactForPublication(
  client: PoolClient,
  input: CurrentApprovedArtifactFenceInput,
): Promise<boolean> {
  const promptSet = await client.query(
    `SELECT prompt_set.id
     FROM artifacts artifact
     JOIN artifact_revisions revision
       ON revision.tenant_id = artifact.tenant_id
      AND revision.workspace_id = artifact.workspace_id
      AND revision.artifact_id = artifact.id
      AND revision.id = $4
      AND revision.revision = $5
      AND revision.content_hash = $6
     JOIN briefs brief
       ON brief.tenant_id = revision.tenant_id
      AND brief.workspace_id = revision.workspace_id
      AND brief.id = revision.brief_id
     JOIN content_plans plan
       ON plan.tenant_id = brief.tenant_id
      AND plan.workspace_id = brief.workspace_id
      AND plan.id = brief.content_plan_id
     JOIN prompt_sets prompt_set
       ON prompt_set.tenant_id = plan.tenant_id
      AND prompt_set.workspace_id = plan.workspace_id
      AND prompt_set.id::text = plan.input_snapshot ->> 'promptSetId'
     WHERE artifact.tenant_id = $1
       AND artifact.workspace_id = $2
       AND artifact.id = $3
       AND artifact.current_revision = revision.revision
     FOR SHARE OF prompt_set`,
    [
      input.tenantId,
      input.workspaceId,
      input.artifactId,
      input.artifactRevisionId,
      input.revision,
      input.contentHash,
    ],
  );
  if (promptSet.rows[0] === undefined) return false;

  const immutableBasis = await client.query<{ accepted: boolean }>(
    `SELECT guard_current_approved_artifact_basis(
       $1, $2, $3, $4, $5, $6, $7
     ) AS accepted`,
    [
      input.tenantId,
      input.workspaceId,
      input.artifactId,
      input.artifactRevisionId,
      input.revision,
      input.contentHash,
      input.effectiveAt,
    ],
  );
  if (immutableBasis.rows[0]?.accepted !== true) return false;

  const current = await client.query<CurrentApprovedArtifactRow>(
    `SELECT revision.id, revision.claim_bindings
     FROM artifacts artifact
     JOIN artifact_revisions revision
       ON revision.tenant_id = artifact.tenant_id
      AND revision.workspace_id = artifact.workspace_id
      AND revision.artifact_id = artifact.id
      AND revision.id = $4
      AND revision.revision = $5
      AND revision.content_hash = $6
      AND revision.status = 'APPROVED'
     JOIN artifact_reviews review
       ON review.tenant_id = revision.tenant_id
      AND review.workspace_id = revision.workspace_id
      AND review.artifact_id = revision.artifact_id
      AND review.artifact_revision_id = revision.id
      AND review.revision = revision.revision
      AND review.content_hash = revision.content_hash
      AND review.decision = 'APPROVE'
     JOIN briefs brief
       ON brief.tenant_id = revision.tenant_id
      AND brief.workspace_id = revision.workspace_id
      AND brief.id = revision.brief_id
      AND brief.status = 'APPROVED'
     JOIN content_plans plan
       ON plan.tenant_id = brief.tenant_id
      AND plan.workspace_id = brief.workspace_id
      AND plan.id = brief.content_plan_id
      AND plan.status = 'READY'
     JOIN profile_revisions profile_revision
       ON profile_revision.tenant_id = plan.tenant_id
      AND profile_revision.workspace_id = plan.workspace_id
      AND profile_revision.id::text = plan.input_snapshot ->> 'profileRevisionId'
      AND profile_revision.profile_id::text = plan.input_snapshot #>> '{profile,id}'
      AND profile_revision.revision::text = plan.input_snapshot #>> '{profile,revision}'
     JOIN offering_revisions offering_revision
       ON offering_revision.tenant_id = plan.tenant_id
      AND offering_revision.workspace_id = plan.workspace_id
      AND offering_revision.id::text = plan.input_snapshot ->> 'offeringRevisionId'
      AND offering_revision.offering_id::text = plan.input_snapshot #>> '{offering,id}'
      AND offering_revision.revision::text = plan.input_snapshot #>> '{offering,revision}'
      AND offering_revision.profile_id = profile_revision.profile_id
     JOIN prompt_revisions prompt_revision
       ON prompt_revision.tenant_id = plan.tenant_id
      AND prompt_revision.workspace_id = plan.workspace_id
      AND prompt_revision.id::text = plan.input_snapshot ->> 'promptRevisionId'
      AND prompt_revision.status = 'APPROVED'
     JOIN prompt_sets prompt_set
       ON prompt_set.tenant_id = prompt_revision.tenant_id
      AND prompt_set.workspace_id = prompt_revision.workspace_id
      AND prompt_set.id = prompt_revision.prompt_set_id
      AND prompt_set.id::text = plan.input_snapshot ->> 'promptSetId'
      AND prompt_set.current_revision = prompt_revision.revision
     JOIN measurement_scenarios scenario
       ON scenario.tenant_id = prompt_revision.tenant_id
      AND scenario.workspace_id = prompt_revision.workspace_id
      AND scenario.prompt_revision_id = prompt_revision.id
      AND scenario.version = prompt_revision.revision
      AND scenario.registry_status = 'AVAILABLE'
     JOIN prompt_approvals prompt_approval
       ON prompt_approval.tenant_id = prompt_revision.tenant_id
      AND prompt_approval.workspace_id = prompt_revision.workspace_id
      AND prompt_approval.prompt_revision_id = prompt_revision.id
      AND prompt_approval.scenario_id = scenario.id
      AND prompt_approval.prompt_content_hash = prompt_revision.content_hash
      AND prompt_approval.scenario_content_hash = scenario.content_hash
     JOIN crawl_runs crawl
       ON crawl.tenant_id = plan.tenant_id
      AND crawl.workspace_id = plan.workspace_id
      AND crawl.id::text = plan.input_snapshot ->> 'baselineId'
      AND crawl.status IN ('COMPLETE', 'PARTIAL')
     JOIN sites site
       ON site.tenant_id = crawl.tenant_id
      AND site.workspace_id = crawl.workspace_id
      AND site.id = crawl.site_id
      AND site.profile_id = profile_revision.profile_id
     WHERE artifact.tenant_id = $1
       AND artifact.workspace_id = $2
       AND artifact.id = $3
       AND artifact.current_revision = revision.revision
       AND artifact.status = 'APPROVED'
       AND brief.source_artifact_ids = plan.input_snapshot -> 'availableSourceArtifactIds'
       AND brief.source_artifact_ids = jsonb_build_array(
         profile_revision.id, offering_revision.id, prompt_revision.id, crawl.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(brief.prompt_ids) AS brief_prompt(id)
         WHERE NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(prompt_revision.prompts) AS prompt(value)
           WHERE prompt.value ->> 'id' = brief_prompt.id
         )
       )
       AND revision.lineage = jsonb_build_object(
         'contentPlanId', plan.id,
         'brief', jsonb_build_object('id', brief.id, 'contentHash', brief.content_hash),
         'prompt', jsonb_build_object(
           'promptSetId', prompt_set.id,
           'promptRevisionId', prompt_revision.id,
           'contentHash', prompt_revision.content_hash,
           'promptIds', brief.prompt_ids
         ),
         'sourceReferences', jsonb_build_array(
           jsonb_build_object(
             'kind', 'PROFILE_REVISION', 'id', profile_revision.id,
             'aggregateId', profile_revision.profile_id,
             'revision', profile_revision.revision,
             'contentHash', profile_revision.content_hash
           ),
           jsonb_build_object(
             'kind', 'OFFERING_REVISION', 'id', offering_revision.id,
             'aggregateId', offering_revision.offering_id,
             'revision', offering_revision.revision,
             'contentHash', offering_revision.content_hash
           ),
           jsonb_build_object(
             'kind', 'PROMPT_REVISION', 'id', prompt_revision.id,
             'aggregateId', prompt_set.id,
             'revision', prompt_revision.revision,
             'contentHash', prompt_revision.content_hash
           ),
           jsonb_build_object(
             'kind', 'SITE_BASELINE', 'id', crawl.id,
             'aggregateId', site.id,
             'revision', NULL::integer,
             'contentHash', NULL::text
           )
         )
       )
     FOR SHARE OF artifact, revision, brief, plan,
       prompt_revision, prompt_set, crawl, site`,
    [
      input.tenantId,
      input.workspaceId,
      input.artifactId,
      input.artifactRevisionId,
      input.revision,
      input.contentHash,
    ],
  );
  const row = current.rows[0];
  if (row === undefined || row.claim_bindings.length === 0) return false;

  const seenEvidenceBindings = new Set<string>();
  for (const binding of row.claim_bindings) {
    if (binding.evidence.length === 0) return false;
    for (const evidence of binding.evidence) {
      const evidenceBindingKey = [
        binding.claimRevisionId,
        evidence.sourceId,
        evidence.snapshotId,
        evidence.sourceHash,
      ].join('\u0000');
      if (seenEvidenceBindings.has(evidenceBindingKey)) return false;
      seenEvidenceBindings.add(evidenceBindingKey);

      const currentEvidence = await client.query(
        `SELECT 1
          FROM claim_revisions claim_revision
          JOIN claims claim
            ON claim.tenant_id = claim_revision.tenant_id
           AND claim.workspace_id = claim_revision.workspace_id
           AND claim.id = claim_revision.claim_id
           AND claim.current_revision = claim_revision.revision
          JOIN claim_reviews claim_review
            ON claim_review.tenant_id = claim_revision.tenant_id
           AND claim_review.workspace_id = claim_revision.workspace_id
           AND claim_review.claim_revision_id = claim_revision.id
           AND claim_review.decision = 'APPROVE'
           AND claim_review.content_hash = claim_revision.content_hash
          JOIN claim_evidence_links claim_link
            ON claim_link.tenant_id = claim_revision.tenant_id
           AND claim_link.workspace_id = claim_revision.workspace_id
           AND claim_link.claim_revision_id = claim_revision.id
           AND claim_link.snippet IS NOT NULL
         JOIN evidence_snapshots snapshot
           ON snapshot.tenant_id = claim_link.tenant_id
          AND snapshot.workspace_id = claim_link.workspace_id
          AND snapshot.id = claim_link.snapshot_id
         JOIN evidence_sources evidence_source
           ON evidence_source.tenant_id = snapshot.tenant_id
          AND evidence_source.workspace_id = snapshot.workspace_id
          AND evidence_source.id = snapshot.source_id
          AND evidence_source.current_snapshot_id = snapshot.id
         JOIN artifact_claim_links artifact_link
           ON artifact_link.tenant_id = claim_revision.tenant_id
          AND artifact_link.workspace_id = claim_revision.workspace_id
          AND artifact_link.artifact_revision_id = $9
          AND artifact_link.claim_revision_id = claim_revision.id
          AND artifact_link.snapshot_id = snapshot.id
          AND artifact_link.source_id = snapshot.source_id
          AND artifact_link.source_hash = snapshot.content_hash
         WHERE claim_revision.tenant_id = $1
           AND claim_revision.workspace_id = $2
           AND claim_revision.id = $3
           AND claim_revision.claim_id = $4
            AND claim_revision.content_hash = $5
            AND claim_revision.statement = $6
            AND claim_revision.status = 'APPROVED'
            AND claim_revision.expires_at IS NOT NULL
            AND claim_revision.expires_at > $10
           AND snapshot.id = $7
           AND snapshot.source_id = $8
           AND snapshot.content_hash = $11
           AND claim_link.source_hash = $11
         FOR SHARE OF claim_revision, evidence_source`,
        [
          input.tenantId,
          input.workspaceId,
          binding.claimRevisionId,
          binding.claimId,
          binding.claimContentHash,
          binding.claimStatement,
          evidence.snapshotId,
          evidence.sourceId,
          row.id,
          input.effectiveAt,
          evidence.sourceHash,
        ],
      );
      if (currentEvidence.rowCount !== 1) return false;
    }
  }
  return true;
}
