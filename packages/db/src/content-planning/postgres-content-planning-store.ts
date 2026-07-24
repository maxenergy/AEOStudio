import type { ContentPlanningStore } from '@aeostudio/application/content-planning';
import {
  contentPlanReferenceErrors,
  type BriefRecord,
  type BriefReviewRecord,
  type ContentPlanBundle,
  type ContentPlanInputSnapshot,
  type ContentPlanRecord,
  type ContentPlanSourceInput,
  type EvidenceTaskRecord,
  type OpportunityRecord,
  type PlannedAssetKind,
} from '@aeostudio/domain/content-planning';
import type { Pool, PoolClient } from 'pg';

import { TenantContextRunner } from '../tenant-context/tenant-context-runner.js';

interface ContentPlanRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  job_id: string | null;
  status: ContentPlanRecord['status'];
  method_policy_version: string;
  input_snapshot: ContentPlanInputSnapshot;
  content_hash: string | null;
  created_by_user_id: string;
  created_at: Date;
  completed_at: Date | null;
}

interface OpportunityRow {
  id: string;
  content_plan_id: string;
  opportunity_key: PlannedAssetKind;
  asset_kind: PlannedAssetKind;
  business_value: number;
  evidence_readiness: number;
  visibility_gap: OpportunityRecord['visibilityGap'];
  effort: number;
  risk: number;
  priority_score: number;
  priority_rank: number;
  rank_reason: string;
  action: OpportunityRecord['action'];
  evidence_ready: boolean;
  publish_ready: false;
}

interface BriefRow {
  id: string;
  content_plan_id: string;
  opportunity_id: string;
  brief_key: PlannedAssetKind;
  asset_kind: PlannedAssetKind;
  title: string;
  prompt_ids: string[];
  claim_revision_ids: string[];
  source_artifact_ids: string[];
  status: BriefRecord['status'];
  evidence_ready: true;
  publish_ready: false;
  content_hash: string;
  created_by_user_id: string;
  created_at: Date;
}

interface BriefReviewRow {
  id: string;
  brief_id: string;
  decision: BriefReviewRecord['decision'];
  content_hash: string;
  reviewer_user_id: string;
  note: string;
  reviewed_at: Date;
}

interface EvidenceTaskRow {
  id: string;
  content_plan_id: string;
  opportunity_id: string;
  task_key: PlannedAssetKind;
  asset_kind: PlannedAssetKind;
  reason_code: EvidenceTaskRecord['reasonCode'];
  detail: string;
}

interface KnowledgeRow {
  profile_revision_id: string;
  offering_revision_id: string;
}

interface PromptRow {
  prompt_revision_id: string;
  prompts: { id?: unknown }[];
  source_context: unknown;
}

interface ClaimEvidenceRow {
  claim_revision_id: string;
  snapshot_id: string;
}

export class PostgresContentPlanningStore implements ContentPlanningStore {
  private readonly contexts: TenantContextRunner;

  constructor(pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  preparePlan(input: Parameters<ContentPlanningStore['preparePlan']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const knowledge = await client.query<KnowledgeRow>(
        `SELECT profile_revision.id AS profile_revision_id,
           offering_revision.id AS offering_revision_id
         FROM profile_revisions profile_revision
         JOIN offering_revisions offering_revision
           ON offering_revision.profile_id = profile_revision.profile_id
         WHERE profile_revision.profile_id = $1
           AND profile_revision.revision = $2
           AND offering_revision.offering_id = $3
           AND offering_revision.revision = $4`,
        [
          input.sourceInput.profile.id,
          input.sourceInput.profile.revision,
          input.sourceInput.offering.id,
          input.sourceInput.offering.revision,
        ],
      );
      const knowledgeRow = knowledge.rows[0];
      if (knowledgeRow === undefined) {
        return { outcome: 'INVALID_REFERENCE' as const, referenceType: 'PROFILE_OR_OFFERING' };
      }

      const prompt = await client.query<PromptRow>(
        `SELECT revision.id AS prompt_revision_id, revision.prompts, revision.source_context
         FROM prompt_sets prompt_set
         JOIN prompt_revisions revision
           ON revision.prompt_set_id = prompt_set.id
           AND revision.revision = prompt_set.current_revision
         JOIN measurement_scenarios scenario ON scenario.prompt_revision_id = revision.id
         JOIN prompt_approvals approval
           ON approval.prompt_revision_id = revision.id
           AND approval.scenario_id = scenario.id
         WHERE prompt_set.id = $1
           AND revision.id = $2
           AND revision.status = 'APPROVED'
           AND approval.prompt_content_hash = revision.content_hash
           AND approval.scenario_content_hash = scenario.content_hash`,
        [input.sourceInput.promptSetId, input.sourceInput.promptRevisionId],
      );
      const promptRow = prompt.rows[0];
      if (promptRow === undefined) {
        return { outcome: 'INVALID_REFERENCE' as const, referenceType: 'PROMPT_REVISION' };
      }
      if (!this.promptSourceContextMatches(promptRow.source_context, input.sourceInput)) {
        return { outcome: 'INVALID_REFERENCE' as const, referenceType: 'PROMPT_SOURCE_CONTEXT' };
      }
      const promptIds = promptRow.prompts
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string');
      if (promptIds.length < 3 || promptIds.length !== promptRow.prompts.length) {
        return { outcome: 'INVALID_REFERENCE' as const, referenceType: 'PROMPT' };
      }

      const primaryClaims = await this.resolveClaimEvidence(
        client,
        input.sourceInput.primaryClaimRevisionIds,
        input.createdAt,
      );
      if (primaryClaims === null) {
        return { outcome: 'INVALID_REFERENCE' as const, referenceType: 'PRIMARY_CLAIM_REVISION' };
      }
      const comparisonClaims = await this.resolveClaimEvidence(
        client,
        input.sourceInput.comparisonClaimRevisionIds,
        input.createdAt,
      );
      if (comparisonClaims === null) {
        return {
          outcome: 'INVALID_REFERENCE' as const,
          referenceType: 'COMPARISON_CLAIM_REVISION',
        };
      }

      const baseline = await client.query<{ id: string }>(
        `SELECT crawl.id
         FROM crawl_runs crawl
         JOIN sites site ON site.id = crawl.site_id
         WHERE crawl.id = $1
           AND crawl.status IN ('COMPLETE', 'PARTIAL')
           AND site.profile_id = $2`,
        [input.sourceInput.baselineId, input.sourceInput.profile.id],
      );
      if (baseline.rows[0] === undefined) {
        return { outcome: 'INVALID_REFERENCE' as const, referenceType: 'BASELINE' };
      }

      const primaryEvidenceSnapshotIds = this.uniqueEvidence(primaryClaims);
      const comparisonEvidenceSnapshotIds = this.uniqueEvidence(comparisonClaims);
      const comparisonEvidenceIndependent =
        comparisonClaims.length > 0 &&
        comparisonEvidenceSnapshotIds.every((id) => !primaryEvidenceSnapshotIds.includes(id));
      const snapshot: ContentPlanInputSnapshot = {
        ...input.sourceInput,
        profileRevisionId: knowledgeRow.profile_revision_id,
        offeringRevisionId: knowledgeRow.offering_revision_id,
        promptIds,
        primaryEvidenceSnapshotIds,
        comparisonEvidenceSnapshotIds,
        availableClaimRevisionIds: [
          ...new Set([
            ...input.sourceInput.primaryClaimRevisionIds,
            ...input.sourceInput.comparisonClaimRevisionIds,
          ]),
        ],
        availableSourceArtifactIds: [
          knowledgeRow.profile_revision_id,
          knowledgeRow.offering_revision_id,
          promptRow.prompt_revision_id,
          input.sourceInput.baselineId,
        ],
        comparisonEvidenceIndependent,
      };
      const inserted = await client.query<ContentPlanRow>(
        `INSERT INTO content_plans
          (id, tenant_id, workspace_id, status, method_policy_version, input_snapshot,
            created_by_user_id, created_at)
         VALUES ($1, $2, $3, 'PENDING', $4, $5::jsonb, $6, $7)
         RETURNING id, tenant_id, workspace_id, job_id, status, method_policy_version,
           input_snapshot, content_hash, created_by_user_id, created_at, completed_at`,
        [
          input.planId,
          input.context.tenantId,
          input.context.workspaceId,
          input.sourceInput.methodPolicyVersion,
          JSON.stringify(snapshot),
          input.context.actorUserId,
          input.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'CONTENT_PLAN_PREPARED', 'CONTENT_PLAN', $5, 'SUCCEEDED',
           jsonb_build_object('methodPolicyVersion', $6::text,
             'profileRevisionId', $7::uuid, 'offeringRevisionId', $8::uuid,
             'promptRevisionId', $9::uuid, 'baselineId', $10::uuid,
             'primaryClaimCount', $11::integer, 'comparisonClaimCount', $12::integer), $13)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.planId,
          input.sourceInput.methodPolicyVersion,
          knowledgeRow.profile_revision_id,
          knowledgeRow.offering_revision_id,
          promptRow.prompt_revision_id,
          input.sourceInput.baselineId,
          input.sourceInput.primaryClaimRevisionIds.length,
          input.sourceInput.comparisonClaimRevisionIds.length,
          input.createdAt,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('CONTENT_PLAN_DID_NOT_RETURN_RESULT');
      return { outcome: 'SUCCEEDED' as const, plan: this.mapPlan(row) };
    });
  }

  bindJob(input: Parameters<ContentPlanningStore['bindJob']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<ContentPlanRow>(
        `UPDATE content_plans SET job_id = $1
         WHERE id = $2 AND workspace_id = $3
         RETURNING id, tenant_id, workspace_id, job_id, status, method_policy_version,
           input_snapshot, content_hash, created_by_user_id, created_at, completed_at`,
        [input.jobId, input.planId, input.context.workspaceId],
      );
      return result.rows[0] === undefined ? null : this.mapPlan(result.rows[0]);
    });
  }

  findBundle(input: Parameters<ContentPlanningStore['findBundle']>[0]) {
    return this.contexts.run(input.context, (client) => this.loadBundle(client, input.planId));
  }

  loadInput(input: Parameters<ContentPlanningStore['loadInput']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<{ input_snapshot: ContentPlanInputSnapshot }>(
        `SELECT input_snapshot FROM content_plans
         WHERE id = $1 AND workspace_id = $2`,
        [input.planId, input.context.workspaceId],
      );
      return result.rows[0]?.input_snapshot ?? null;
    });
  }

  completePlan(input: Parameters<ContentPlanningStore['completePlan']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const locked = await client.query<ContentPlanRow>(
        `SELECT id, tenant_id, workspace_id, job_id, status, method_policy_version,
           input_snapshot, content_hash, created_by_user_id, created_at, completed_at
         FROM content_plans WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [input.planId, input.context.workspaceId],
      );
      const plan = locked.rows[0];
      if (plan === undefined) return { outcome: 'NOT_FOUND' as const };
      if (plan.status === 'READY') {
        const existing = await this.loadBundle(client, input.planId);
        return existing === null
          ? { outcome: 'NOT_FOUND' as const }
          : { outcome: 'SUCCEEDED' as const, bundle: existing };
      }
      const errors = contentPlanReferenceErrors({
        snapshot: plan.input_snapshot,
        result: input.result,
      });
      if (errors.length > 0) {
        await client.query(
          `UPDATE content_plans
           SET status = 'INVALID', content_hash = $1, completed_at = $2
           WHERE id = $3`,
          [input.contentHash, input.completedAt, input.planId],
        );
        await client.query(
          `INSERT INTO audit_events
            (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
              outcome, metadata, occurred_at)
           VALUES ($1, $2, $3, $4, 'CONTENT_PLAN_INVALIDATED', 'CONTENT_PLAN', $5, 'FAILED',
             jsonb_build_object('referenceErrors', $6::jsonb), $7)`,
          [
            input.auditEventId,
            input.context.tenantId,
            input.context.workspaceId,
            plan.created_by_user_id,
            input.planId,
            JSON.stringify(errors),
            input.completedAt,
          ],
        );
        return { outcome: 'INVALID_REFERENCE' as const, errors };
      }

      for (const opportunity of input.result.opportunities) {
        await client.query(
          `INSERT INTO opportunities
            (id, tenant_id, workspace_id, content_plan_id, opportunity_key, asset_kind,
              business_value, evidence_readiness, visibility_gap, effort, risk, priority_score,
              priority_rank, rank_reason, action, evidence_ready, publish_ready)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13,
             $14, $15, $16, false)`,
          [
            input.opportunityIds[opportunity.assetKind],
            input.context.tenantId,
            input.context.workspaceId,
            input.planId,
            opportunity.key,
            opportunity.assetKind,
            opportunity.businessValue,
            opportunity.evidenceReadiness,
            JSON.stringify(opportunity.visibilityGap),
            opportunity.effort,
            opportunity.risk,
            opportunity.priorityScore,
            opportunity.rank,
            opportunity.rankReason,
            opportunity.action,
            opportunity.evidenceReady,
          ],
        );
      }
      for (const brief of input.result.briefs) {
        const briefId = input.briefIds[brief.assetKind];
        const briefHash = input.briefContentHashes[brief.assetKind];
        if (briefId === undefined || briefHash === undefined) {
          throw new Error('CONTENT_PLAN_BRIEF_ID_OR_HASH_MISSING');
        }
        await client.query(
          `INSERT INTO briefs
            (id, tenant_id, workspace_id, content_plan_id, opportunity_id, brief_key,
              asset_kind, title, prompt_ids, claim_revision_ids, source_artifact_ids, status,
              evidence_ready, publish_ready, content_hash, created_by_user_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb,
             'REVIEW_REQUIRED', true, false, $12, $13, $14)`,
          [
            briefId,
            input.context.tenantId,
            input.context.workspaceId,
            input.planId,
            input.opportunityIds[brief.assetKind],
            brief.key,
            brief.assetKind,
            brief.title,
            JSON.stringify(brief.promptIds),
            JSON.stringify(brief.claimRevisionIds),
            JSON.stringify(brief.sourceArtifactIds),
            briefHash,
            plan.created_by_user_id,
            input.completedAt,
          ],
        );
      }
      for (const evidenceTask of input.result.evidenceTasks) {
        const evidenceTaskId = input.evidenceTaskIds[evidenceTask.assetKind];
        if (evidenceTaskId === undefined) throw new Error('CONTENT_PLAN_EVIDENCE_TASK_ID_MISSING');
        await client.query(
          `INSERT INTO evidence_tasks
            (id, tenant_id, workspace_id, content_plan_id, opportunity_id, task_key,
              asset_kind, reason_code, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            evidenceTaskId,
            input.context.tenantId,
            input.context.workspaceId,
            input.planId,
            input.opportunityIds[evidenceTask.assetKind],
            evidenceTask.key,
            evidenceTask.assetKind,
            evidenceTask.reasonCode,
            evidenceTask.detail,
          ],
        );
      }
      await client.query(
        `UPDATE content_plans
         SET status = 'READY', content_hash = $1, completed_at = $2
         WHERE id = $3`,
        [input.contentHash, input.completedAt, input.planId],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'CONTENT_PLAN_COMPLETED', 'CONTENT_PLAN', $5, 'SUCCEEDED',
           jsonb_build_object('methodPolicyVersion', $6::text, 'contentHash', $7::text,
             'opportunityCount', $8::integer, 'briefCount', $9::integer,
             'evidenceTaskCount', $10::integer), $11)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          plan.created_by_user_id,
          input.planId,
          input.result.methodPolicyVersion,
          input.contentHash,
          input.result.opportunities.length,
          input.result.briefs.length,
          input.result.evidenceTasks.length,
          input.completedAt,
        ],
      );
      const bundle = await this.loadBundle(client, input.planId);
      if (bundle === null) throw new Error('COMPLETED_CONTENT_PLAN_NOT_FOUND');
      return { outcome: 'SUCCEEDED' as const, bundle };
    });
  }

  reviewBrief(input: Parameters<ContentPlanningStore['reviewBrief']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const current = await client.query<BriefRow>(
        `SELECT brief.id, brief.content_plan_id, brief.opportunity_id, brief.brief_key,
           brief.asset_kind, brief.title, brief.prompt_ids, brief.claim_revision_ids,
           brief.source_artifact_ids, brief.status, brief.evidence_ready, brief.publish_ready,
           brief.content_hash, brief.created_by_user_id, brief.created_at
         FROM briefs brief
         JOIN content_plans plan ON plan.id = brief.content_plan_id
         WHERE plan.id = $1 AND brief.id = $2
         FOR UPDATE OF brief`,
        [input.planId, input.briefId],
      );
      const brief = current.rows[0];
      if (brief === undefined) return { outcome: 'NOT_FOUND' as const };
      if (brief.content_hash !== input.expectedContentHash) {
        return { outcome: 'HASH_MISMATCH' as const };
      }
      if (brief.created_by_user_id === input.context.actorUserId) {
        return { outcome: 'SELF_APPROVAL' as const };
      }
      if (brief.status !== 'REVIEW_REQUIRED') {
        return { outcome: 'ALREADY_REVIEWED' as const };
      }
      const status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      await client.query(`UPDATE briefs SET status = $1 WHERE id = $2`, [status, input.briefId]);
      const inserted = await client.query<BriefReviewRow>(
        `INSERT INTO brief_reviews
          (id, tenant_id, workspace_id, brief_id, decision, reviewer_user_id, content_hash,
            note, reviewed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, brief_id, decision, content_hash, reviewer_user_id, note, reviewed_at`,
        [
          input.reviewId,
          input.context.tenantId,
          input.context.workspaceId,
          input.briefId,
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
         VALUES ($1, $2, $3, $4, 'BRIEF_REVIEWED', 'BRIEF', $5, 'SUCCEEDED',
           jsonb_build_object('decision', $6::text, 'contentHash', $7::text,
             'contentPlanId', $8::uuid), $9)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.briefId,
          input.decision,
          input.expectedContentHash,
          input.planId,
          input.reviewedAt,
        ],
      );
      const review = inserted.rows[0];
      if (review === undefined) throw new Error('BRIEF_REVIEW_DID_NOT_RETURN_RESULT');
      return {
        outcome: 'SUCCEEDED' as const,
        brief: this.mapBrief({ ...brief, status }),
        review: this.mapBriefReview(review),
      };
    });
  }

  private async resolveClaimEvidence(
    client: PoolClient,
    claimRevisionIds: string[],
    effectiveAt: Date,
  ): Promise<ClaimEvidenceRow[] | null> {
    const requested = [...new Set(claimRevisionIds)];
    if (requested.length === 0) return [];
    const result = await client.query<ClaimEvidenceRow>(
      `SELECT revision.id AS claim_revision_id, link.snapshot_id
       FROM claim_revisions revision
       JOIN claim_evidence_links link ON link.claim_revision_id = revision.id
       JOIN evidence_snapshots snapshot ON snapshot.id = link.snapshot_id
       JOIN evidence_sources source
         ON source.id = snapshot.source_id
         AND source.current_snapshot_id = snapshot.id
       WHERE revision.id = ANY($1::uuid[])
         AND revision.status = 'APPROVED'
         AND (revision.expires_at IS NULL OR revision.expires_at > $2)
         AND link.source_hash = snapshot.content_hash
       ORDER BY revision.id, link.snapshot_id`,
      [requested, effectiveAt],
    );
    const resolved = new Set(result.rows.map((row) => row.claim_revision_id));
    return requested.every((id) => resolved.has(id)) ? result.rows : null;
  }

  private uniqueEvidence(rows: ClaimEvidenceRow[]): string[] {
    return [...new Set(rows.map((row) => row.snapshot_id))];
  }

  private promptSourceContextMatches(
    sourceContext: unknown,
    sourceInput: ContentPlanSourceInput,
  ): boolean {
    if (sourceContext === null || typeof sourceContext !== 'object') return false;
    const candidate = sourceContext as {
      profile?: unknown;
      offering?: unknown;
      claimRevisionIds?: unknown;
    };
    if (
      candidate.profile === null ||
      typeof candidate.profile !== 'object' ||
      candidate.offering === null ||
      typeof candidate.offering !== 'object' ||
      !Array.isArray(candidate.claimRevisionIds) ||
      candidate.claimRevisionIds.some((id) => typeof id !== 'string')
    ) {
      return false;
    }
    const profile = candidate.profile as { id?: unknown; revision?: unknown };
    const offering = candidate.offering as { id?: unknown; revision?: unknown };
    if (
      profile.id !== sourceInput.profile.id ||
      profile.revision !== sourceInput.profile.revision ||
      offering.id !== sourceInput.offering.id ||
      offering.revision !== sourceInput.offering.revision
    ) {
      return false;
    }

    const promptClaimIds = candidate.claimRevisionIds as string[];
    const planClaimIds = [
      ...sourceInput.primaryClaimRevisionIds,
      ...sourceInput.comparisonClaimRevisionIds,
    ];
    if (
      new Set(promptClaimIds).size !== promptClaimIds.length ||
      new Set(planClaimIds).size !== planClaimIds.length ||
      promptClaimIds.length !== planClaimIds.length
    ) {
      return false;
    }
    const expected = new Set(planClaimIds);
    return promptClaimIds.every((id) => expected.has(id));
  }

  private async loadBundle(client: PoolClient, planId: string): Promise<ContentPlanBundle | null> {
    const planResult = await client.query<ContentPlanRow>(
      `SELECT id, tenant_id, workspace_id, job_id, status, method_policy_version,
         input_snapshot, content_hash, created_by_user_id, created_at, completed_at
       FROM content_plans WHERE id = $1`,
      [planId],
    );
    const planRow = planResult.rows[0];
    if (planRow === undefined) return null;
    const opportunities = await client.query<OpportunityRow>(
      `SELECT id, content_plan_id, opportunity_key, asset_kind, business_value,
         evidence_readiness, visibility_gap, effort, risk, priority_score, priority_rank,
         rank_reason, action, evidence_ready, publish_ready
       FROM opportunities WHERE content_plan_id = $1 ORDER BY priority_rank, id`,
      [planId],
    );
    const briefs = await client.query<BriefRow>(
      `SELECT id, content_plan_id, opportunity_id, brief_key, asset_kind, title, prompt_ids,
         claim_revision_ids, source_artifact_ids, status, evidence_ready, publish_ready,
         content_hash, created_by_user_id, created_at
       FROM briefs WHERE content_plan_id = $1 ORDER BY brief_key, id`,
      [planId],
    );
    const evidenceTasks = await client.query<EvidenceTaskRow>(
      `SELECT id, content_plan_id, opportunity_id, task_key, asset_kind, reason_code, detail
       FROM evidence_tasks WHERE content_plan_id = $1 ORDER BY task_key, id`,
      [planId],
    );
    const briefReviews = await client.query<BriefReviewRow>(
      `SELECT review.id, review.brief_id, review.decision, review.content_hash,
         review.reviewer_user_id, review.note, review.reviewed_at
       FROM brief_reviews review
       JOIN briefs brief ON brief.id = review.brief_id
       WHERE brief.content_plan_id = $1
       ORDER BY review.reviewed_at, review.id`,
      [planId],
    );
    return {
      plan: this.mapPlan(planRow),
      opportunities: opportunities.rows.map((row) => this.mapOpportunity(row)),
      briefs: briefs.rows.map((row) => this.mapBrief(row)),
      briefReviews: briefReviews.rows.map((row) => this.mapBriefReview(row)),
      evidenceTasks: evidenceTasks.rows.map((row) => this.mapEvidenceTask(row)),
    };
  }

  private mapPlan(row: ContentPlanRow): ContentPlanRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      jobId: row.job_id,
      status: row.status,
      methodPolicyVersion: row.method_policy_version,
      inputSnapshot: row.input_snapshot,
      contentHash: row.content_hash,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
    };
  }

  private mapOpportunity(row: OpportunityRow): OpportunityRecord {
    return {
      id: row.id,
      contentPlanId: row.content_plan_id,
      key: row.opportunity_key,
      assetKind: row.asset_kind,
      businessValue: row.business_value,
      evidenceReadiness: row.evidence_readiness,
      visibilityGap: row.visibility_gap,
      effort: row.effort,
      risk: row.risk,
      priorityScore: row.priority_score,
      rank: row.priority_rank,
      rankReason: row.rank_reason,
      action: row.action,
      evidenceReady: row.evidence_ready,
      publishReady: row.publish_ready,
    };
  }

  private mapBrief(row: BriefRow): BriefRecord {
    return {
      id: row.id,
      contentPlanId: row.content_plan_id,
      opportunityId: row.opportunity_id,
      key: row.brief_key,
      assetKind: row.asset_kind,
      title: row.title,
      promptIds: row.prompt_ids,
      claimRevisionIds: row.claim_revision_ids,
      sourceArtifactIds: row.source_artifact_ids,
      status: row.status,
      evidenceReady: row.evidence_ready,
      publishReady: row.publish_ready,
      contentHash: row.content_hash,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at.toISOString(),
    };
  }

  private mapEvidenceTask(row: EvidenceTaskRow): EvidenceTaskRecord {
    return {
      id: row.id,
      contentPlanId: row.content_plan_id,
      opportunityId: row.opportunity_id,
      key: row.task_key,
      assetKind: row.asset_kind,
      reasonCode: row.reason_code,
      detail: row.detail,
    };
  }

  private mapBriefReview(row: BriefReviewRow): BriefReviewRecord {
    return {
      id: row.id,
      briefId: row.brief_id,
      decision: row.decision,
      contentHash: row.content_hash,
      reviewedByUserId: row.reviewer_user_id,
      note: row.note,
      reviewedAt: row.reviewed_at.toISOString(),
    };
  }
}
