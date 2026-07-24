import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import {
  FAKE_ARTIFACT_LINEAGE,
  FAKE_ARTIFACT_PROMPT_IDS,
} from '../../../apps/api/src/artifacts/fake-artifact-lineage-fixture.js';

export async function seedTask10ApprovedArtifactSource(
  pool: Pool,
  scope: { tenant: { id: string }; workspace: { id: string } },
): Promise<void> {
  const client = await pool.connect();
  const now = new Date('2026-07-21T05:00:00.000Z');
  const hash = (character: string) => character.repeat(64);
  const baselineJobId = randomUUID();
  const opportunityId = randomUUID();
  const promptId = FAKE_ARTIFACT_PROMPT_IDS[0];
  if (promptId === undefined) throw new Error('TASK_10_PROMPT_FIXTURE_MISSING');
  try {
    await client.query('BEGIN');
    const member = await client.query<{ user_id: string }>(
      `SELECT user_id FROM memberships WHERE tenant_id = $1 AND status = 'ACTIVE'`,
      [scope.tenant.id],
    );
    const actorUserId = member.rows[0]?.user_id;
    if (actorUserId === undefined) throw new Error('TASK_10_FIXTURE_ACTOR_NOT_FOUND');

    await client.query(
      `INSERT INTO profiles (id, tenant_id, workspace_id, current_revision, created_at)
       VALUES ($1, $2, $3, 1, $4)`,
      [FAKE_ARTIFACT_LINEAGE.profileId, scope.tenant.id, scope.workspace.id, now],
    );
    await client.query(
      `INSERT INTO profile_revisions
        (id, tenant_id, workspace_id, profile_id, revision, content_hash, content,
          completeness, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, $7::jsonb, $8, $9)`,
      [
        FAKE_ARTIFACT_LINEAGE.profileRevisionId,
        scope.tenant.id,
        scope.workspace.id,
        FAKE_ARTIFACT_LINEAGE.profileId,
        hash('d'),
        JSON.stringify({ name: 'Generic organization fixture' }),
        JSON.stringify({ percent: 100, missingFields: [] }),
        actorUserId,
        now,
      ],
    );
    await client.query(
      `INSERT INTO offerings
        (id, tenant_id, workspace_id, profile_id, current_revision, created_at)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [
        FAKE_ARTIFACT_LINEAGE.offeringId,
        scope.tenant.id,
        scope.workspace.id,
        FAKE_ARTIFACT_LINEAGE.profileId,
        now,
      ],
    );
    await client.query(
      `INSERT INTO offering_revisions
        (id, tenant_id, workspace_id, offering_id, profile_id, revision, content_hash,
          content, completeness, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7::jsonb, $8::jsonb, $9, $10)`,
      [
        FAKE_ARTIFACT_LINEAGE.offeringRevisionId,
        scope.tenant.id,
        scope.workspace.id,
        FAKE_ARTIFACT_LINEAGE.offeringId,
        FAKE_ARTIFACT_LINEAGE.profileId,
        hash('e'),
        JSON.stringify({ name: 'Generic offering fixture' }),
        JSON.stringify({ percent: 100, missingFields: [] }),
        actorUserId,
        now,
      ],
    );
    await client.query(
      `INSERT INTO evidence_sources
        (id, tenant_id, workspace_id, source_type, title, license, publicity,
          current_snapshot_id, created_at)
       VALUES ($1, $2, $3, 'UPLOAD', 'Package evidence', 'Fixture license', 'PRIVATE',
         NULL, $4)`,
      [FAKE_ARTIFACT_LINEAGE.evidenceSourceId, scope.tenant.id, scope.workspace.id, now],
    );
    await client.query(
      `INSERT INTO evidence_snapshots
        (id, tenant_id, workspace_id, source_id, content_hash, object_ref, object_version_id,
          content_type, size_bytes, captured_at)
       VALUES ($1, $2, $3, $4, $5, 'fixture://package-evidence', 'fixture-version-v1',
         'text/plain', 128, $6)`,
      [
        FAKE_ARTIFACT_LINEAGE.evidenceSnapshotId,
        scope.tenant.id,
        scope.workspace.id,
        FAKE_ARTIFACT_LINEAGE.evidenceSourceId,
        FAKE_ARTIFACT_LINEAGE.evidenceHash,
        now,
      ],
    );
    await client.query(`UPDATE evidence_sources SET current_snapshot_id = $1 WHERE id = $2`, [
      FAKE_ARTIFACT_LINEAGE.evidenceSnapshotId,
      FAKE_ARTIFACT_LINEAGE.evidenceSourceId,
    ]);
    await client.query(
      `INSERT INTO claims (id, tenant_id, workspace_id, current_revision, created_at)
       VALUES ($1, $2, $3, 1, $4)`,
      [FAKE_ARTIFACT_LINEAGE.claimId, scope.tenant.id, scope.workspace.id, now],
    );
    await client.query(
      `INSERT INTO claim_revisions
        (id, tenant_id, workspace_id, claim_id, revision, statement, conditions,
          expires_at, content_hash, status, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, 1,
         'The approved fixture claim is traceable to current evidence.',
         '{}'::jsonb, '2036-01-01T00:00:00.000Z', $5, 'APPROVED', $6, $7)`,
      [
        FAKE_ARTIFACT_LINEAGE.claimRevisionId,
        scope.tenant.id,
        scope.workspace.id,
        FAKE_ARTIFACT_LINEAGE.claimId,
        FAKE_ARTIFACT_LINEAGE.claimHash,
        actorUserId,
        now,
      ],
    );
    await client.query(
      `INSERT INTO claim_reviews
        (id, tenant_id, workspace_id, claim_revision_id, decision, reviewer_user_id,
          content_hash, note, reviewed_at)
       VALUES ($1, $2, $3, $4, 'APPROVE', $5, $6,
         'Approved exact fixture Claim revision for package currentness.', $7)`,
      [
        FAKE_ARTIFACT_LINEAGE.claimReviewId,
        scope.tenant.id,
        scope.workspace.id,
        FAKE_ARTIFACT_LINEAGE.claimRevisionId,
        actorUserId,
        FAKE_ARTIFACT_LINEAGE.claimHash,
        now,
      ],
    );
    await client.query(
      `INSERT INTO claim_evidence_links
        (id, tenant_id, workspace_id, claim_revision_id, snapshot_id, source_hash,
          snippet, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'Package fixture excerpt', $7)`,
      [
        FAKE_ARTIFACT_LINEAGE.evidenceLinkId,
        scope.tenant.id,
        scope.workspace.id,
        FAKE_ARTIFACT_LINEAGE.claimRevisionId,
        FAKE_ARTIFACT_LINEAGE.evidenceSnapshotId,
        FAKE_ARTIFACT_LINEAGE.evidenceHash,
        now,
      ],
    );

    await client.query(
      `INSERT INTO prompt_sets
        (id, tenant_id, workspace_id, current_revision, created_at)
       VALUES ($1, $2, $3, 1, $4)`,
      [FAKE_ARTIFACT_LINEAGE.promptSetId, scope.tenant.id, scope.workspace.id, now],
    );
    await client.query(
      `INSERT INTO prompt_revisions
        (id, tenant_id, workspace_id, prompt_set_id, revision, title, subject,
          source_context, prompts, scopes, content_hash, status, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, 1, 'Package fixture prompts', 'Generic subject',
         $5::jsonb, $6::jsonb, $7::jsonb, $8, 'APPROVED', $9, $10)`,
      [
        FAKE_ARTIFACT_LINEAGE.promptRevisionId,
        scope.tenant.id,
        scope.workspace.id,
        FAKE_ARTIFACT_LINEAGE.promptSetId,
        JSON.stringify({
          profile: { id: FAKE_ARTIFACT_LINEAGE.profileId, revision: 1 },
          offering: { id: FAKE_ARTIFACT_LINEAGE.offeringId, revision: 1 },
          claimRevisionIds: [FAKE_ARTIFACT_LINEAGE.claimRevisionId],
        }),
        JSON.stringify([
          {
            id: promptId,
            text: 'How should an evaluator assess the documented capabilities?',
            persona: 'Evidence evaluator',
            journeyStage: 'DISCOVERY',
            queryType: 'EXPLANATORY',
          },
        ]),
        JSON.stringify([{ market: 'SG', locale: 'en-SG', region: 'ap-southeast-1' }]),
        FAKE_ARTIFACT_LINEAGE.promptHash,
        actorUserId,
        now,
      ],
    );
    await client.query(
      `INSERT INTO measurement_scenarios
        (id, tenant_id, workspace_id, prompt_revision_id, version, provider_key,
          surface_key, model, model_version, account_ref, acquisition_method,
          fresh_session, search_enabled, parameters, repetitions, content_hash,
          registry_status, created_at)
       VALUES ($1, $2, $3, $4, 1, 'fixture-provider', 'consumer-answer-sandbox',
         'fixture-model', 'fixture-v1', 'fixture-account', 'MANUAL_IMPORT', true, true,
         '{}'::jsonb, 3, $5, 'AVAILABLE', $6)`,
      [
        FAKE_ARTIFACT_LINEAGE.promptScenarioId,
        scope.tenant.id,
        scope.workspace.id,
        FAKE_ARTIFACT_LINEAGE.promptRevisionId,
        hash('1'),
        now,
      ],
    );
    await client.query(
      `INSERT INTO prompt_approvals
        (id, tenant_id, workspace_id, prompt_revision_id, scenario_id, prompt_content_hash,
          scenario_content_hash, approved_by_user_id, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        FAKE_ARTIFACT_LINEAGE.promptApprovalId,
        scope.tenant.id,
        scope.workspace.id,
        FAKE_ARTIFACT_LINEAGE.promptRevisionId,
        FAKE_ARTIFACT_LINEAGE.promptScenarioId,
        FAKE_ARTIFACT_LINEAGE.promptHash,
        hash('1'),
        actorUserId,
        now,
      ],
    );

    await client.query(
      `INSERT INTO sites
        (id, tenant_id, workspace_id, profile_id, origin, hostname, status, verified_at,
          created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'VERIFIED', $7, $7)`,
      [
        FAKE_ARTIFACT_LINEAGE.siteId,
        scope.tenant.id,
        scope.workspace.id,
        FAKE_ARTIFACT_LINEAGE.profileId,
        'https://package-source.example.test',
        'package-source.example.test',
        now,
      ],
    );
    await client.query(
      `INSERT INTO jobs
        (id, tenant_id, workspace_id, job_type, aggregate_id, status, progress,
          idempotency_key, estimated_units, requested_by_user_id, result, created_at, updated_at)
       VALUES ($1, $2, $3, 'SITE_CRAWL', $4, 'SUCCEEDED', 100, $5, 1, $6,
         '{"baselineStatus":"COMPLETE"}'::jsonb, $7, $7)`,
      [
        baselineJobId,
        scope.tenant.id,
        scope.workspace.id,
        FAKE_ARTIFACT_LINEAGE.siteId,
        `baseline-${baselineJobId}`,
        actorUserId,
        now,
      ],
    );
    await client.query(
      `INSERT INTO crawl_runs
        (id, tenant_id, workspace_id, site_id, job_id, status, page_count, total_bytes,
          completed_at)
       VALUES ($1, $2, $3, $4, $5, 'COMPLETE', 1, 128, $6)`,
      [
        FAKE_ARTIFACT_LINEAGE.siteBaselineId,
        scope.tenant.id,
        scope.workspace.id,
        FAKE_ARTIFACT_LINEAGE.siteId,
        baselineJobId,
        now,
      ],
    );

    const sourceArtifactIds = [
      FAKE_ARTIFACT_LINEAGE.profileRevisionId,
      FAKE_ARTIFACT_LINEAGE.offeringRevisionId,
      FAKE_ARTIFACT_LINEAGE.promptRevisionId,
      FAKE_ARTIFACT_LINEAGE.siteBaselineId,
    ];
    const inputSnapshot = {
      profile: { id: FAKE_ARTIFACT_LINEAGE.profileId, revision: 1 },
      offering: { id: FAKE_ARTIFACT_LINEAGE.offeringId, revision: 1 },
      promptSetId: FAKE_ARTIFACT_LINEAGE.promptSetId,
      promptRevisionId: FAKE_ARTIFACT_LINEAGE.promptRevisionId,
      primaryClaimRevisionIds: [FAKE_ARTIFACT_LINEAGE.claimRevisionId],
      comparisonClaimRevisionIds: [],
      baselineId: FAKE_ARTIFACT_LINEAGE.siteBaselineId,
      methodPolicyVersion: 'content-plan-v1',
      profileRevisionId: FAKE_ARTIFACT_LINEAGE.profileRevisionId,
      offeringRevisionId: FAKE_ARTIFACT_LINEAGE.offeringRevisionId,
      promptIds: [promptId],
      primaryEvidenceSnapshotIds: [FAKE_ARTIFACT_LINEAGE.evidenceSnapshotId],
      comparisonEvidenceSnapshotIds: [],
      availableClaimRevisionIds: [FAKE_ARTIFACT_LINEAGE.claimRevisionId],
      availableSourceArtifactIds: sourceArtifactIds,
      comparisonEvidenceIndependent: false,
    };
    await client.query(
      `INSERT INTO content_plans
        (id, tenant_id, workspace_id, status, method_policy_version, input_snapshot,
          content_hash, created_by_user_id, created_at, completed_at)
       VALUES ($1, $2, $3, 'READY', 'content-plan-v1', $4::jsonb, $5, $6, $7, $7)`,
      [
        FAKE_ARTIFACT_LINEAGE.contentPlanId,
        scope.tenant.id,
        scope.workspace.id,
        JSON.stringify(inputSnapshot),
        hash('b'),
        actorUserId,
        now,
      ],
    );
    await client.query(
      `INSERT INTO opportunities
        (id, tenant_id, workspace_id, content_plan_id, opportunity_key, asset_kind,
          business_value, evidence_readiness, visibility_gap, effort, risk, priority_score,
          priority_rank, rank_reason, action, evidence_ready, publish_ready)
       VALUES ($1, $2, $3, $4, 'DEFINITION_PRODUCT', 'DEFINITION_PRODUCT', 90, 100,
         '{"status":"UNKNOWN","reason":"Fixture"}'::jsonb, 30, 20, 87, 1,
         'Fixture deterministic rank', 'BRIEF', true, false)`,
      [opportunityId, scope.tenant.id, scope.workspace.id, FAKE_ARTIFACT_LINEAGE.contentPlanId],
    );
    await client.query(
      `INSERT INTO briefs
        (id, tenant_id, workspace_id, content_plan_id, opportunity_id, brief_key,
          asset_kind, title, prompt_ids, claim_revision_ids, source_artifact_ids, status,
          evidence_ready, publish_ready, content_hash, created_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'DEFINITION_PRODUCT', 'DEFINITION_PRODUCT',
         'Approved Channel Package brief', $6::jsonb, $7::jsonb, $8::jsonb, 'APPROVED',
         true, false, $9, $10, $11)`,
      [
        FAKE_ARTIFACT_LINEAGE.briefId,
        scope.tenant.id,
        scope.workspace.id,
        FAKE_ARTIFACT_LINEAGE.contentPlanId,
        opportunityId,
        JSON.stringify([promptId]),
        JSON.stringify([FAKE_ARTIFACT_LINEAGE.claimRevisionId]),
        JSON.stringify(sourceArtifactIds),
        hash('9'),
        actorUserId,
        now,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
