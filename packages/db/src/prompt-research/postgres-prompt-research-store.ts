import type { PromptResearchStore } from '@aeostudio/application/prompt-research';
import {
  promptApprovalIssues,
  type MeasurementScenarioRecord,
  type PromptApprovalRecord,
  type PromptBundle,
  type PromptRevisionRecord,
  type PromptSetRecord,
  type ProviderSurfaceRegistryRecord,
} from '@aeostudio/domain/prompt-research';
import type { Pool, PoolClient } from 'pg';

import { TenantContextRunner } from '../tenant-context/tenant-context-runner.js';

interface PromptSetRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  current_revision: number;
  created_at: Date;
}

interface PromptRevisionRow {
  id: string;
  prompt_set_id: string;
  revision: number;
  title: string;
  subject: string;
  source_context: PromptRevisionRecord['sourceContext'];
  prompts: PromptRevisionRecord['prompts'];
  scopes: PromptRevisionRecord['scopes'];
  content_hash: string;
  status: PromptRevisionRecord['status'];
  created_by_user_id: string;
  created_at: Date;
}

interface ScenarioRow {
  id: string;
  prompt_revision_id: string;
  version: number;
  provider_key: string;
  surface_key: string;
  model: string;
  model_version: string;
  account_ref: string;
  acquisition_method: string;
  fresh_session: boolean;
  search_enabled: boolean;
  parameters: Record<string, unknown>;
  repetitions: number;
  content_hash: string;
  registry_status: MeasurementScenarioRecord['registryStatus'];
  created_at: Date;
}

interface ApprovalRow {
  id: string;
  prompt_revision_id: string;
  scenario_id: string;
  prompt_content_hash: string;
  scenario_content_hash: string;
  approved_by_user_id: string;
  approved_at: Date;
}

interface RegistryRow {
  id: string;
  provider_key: string;
  provider_name: string;
  surface_key: string;
  surface_name: string;
  surface_kind: ProviderSurfaceRegistryRecord['surfaceKind'];
  acquisition_class: ProviderSurfaceRegistryRecord['acquisitionClass'];
  acquisition_method: string;
  status: ProviderSurfaceRegistryRecord['status'];
  unavailable_reason: string | null;
  adapter_version: string;
}

export class PostgresPromptResearchStore implements PromptResearchStore {
  private readonly contexts: TenantContextRunner;

  constructor(pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  listRegistry(
    input: Parameters<PromptResearchStore['listRegistry']>[0],
  ): Promise<ProviderSurfaceRegistryRecord[]> {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<RegistryRow>(
        `SELECT id, provider_key, provider_name, surface_key, surface_name, surface_kind,
           acquisition_class, acquisition_method, status, unavailable_reason, adapter_version
         FROM provider_surface_registry
         ORDER BY provider_key, surface_key`,
      );
      return result.rows.map((row) => this.mapRegistry(row));
    });
  }

  createProposal(input: Parameters<PromptResearchStore['createProposal']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      if (!(await this.validSourceContext(client, input.sourceContext))) return null;
      const registry = await this.findRegistry(
        client,
        input.scenario.providerKey,
        input.scenario.surfaceKey,
      );
      await client.query(
        `INSERT INTO prompt_sets
          (id, tenant_id, workspace_id, current_revision, created_at)
         VALUES ($1, $2, $3, 1, $4)`,
        [input.promptSetId, input.context.tenantId, input.context.workspaceId, input.createdAt],
      );
      await client.query(
        `INSERT INTO prompt_revisions
          (id, tenant_id, workspace_id, prompt_set_id, revision, title, subject,
            source_context, prompts, scopes, content_hash, status, created_by_user_id, created_at)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
           $10, 'DRAFT', $11, $12)`,
        [
          input.revisionId,
          input.context.tenantId,
          input.context.workspaceId,
          input.promptSetId,
          input.title,
          input.subject,
          JSON.stringify(input.sourceContext),
          JSON.stringify(input.prompts),
          JSON.stringify(input.scopes),
          input.promptContentHash,
          input.context.actorUserId,
          input.createdAt,
        ],
      );
      await this.insertScenario(client, {
        ...input,
        version: 1,
        registryStatus: registry?.status ?? 'UNKNOWN',
      });
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'PROMPT_SET_PROPOSED', 'PROMPT_SET', $5, 'SUCCEEDED',
           jsonb_build_object('revisionId', $6::uuid, 'promptHash', $7::text,
             'scenarioHash', $8::text, 'promptCount', $9::integer, 'scopeCount', $10::integer),
           $11)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.promptSetId,
          input.revisionId,
          input.promptContentHash,
          input.scenarioContentHash,
          input.prompts.length,
          input.scopes.length,
          input.createdAt,
        ],
      );
      return this.loadBundle(client, input.promptSetId, input.context.workspaceId);
    });
  }

  findCurrent(input: Parameters<PromptResearchStore['findCurrent']>[0]) {
    return this.contexts.run(input.context, (client) =>
      this.loadBundle(client, input.promptSetId, input.context.workspaceId),
    );
  }

  findRevision(input: Parameters<PromptResearchStore['findRevision']>[0]) {
    return this.contexts.run(input.context, (client) =>
      this.loadBundle(client, input.promptSetId, input.context.workspaceId, input.revisionId),
    );
  }

  createRevision(input: Parameters<PromptResearchStore['createRevision']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const locked = await client.query<PromptSetRow>(
        `SELECT id, tenant_id, workspace_id, current_revision, created_at
         FROM prompt_sets WHERE id = $1 FOR UPDATE`,
        [input.promptSetId],
      );
      const promptSet = locked.rows[0];
      if (promptSet === undefined || promptSet.current_revision !== input.expectedRevision) {
        return null;
      }
      const current = await this.loadBundle(client, input.promptSetId, input.context.workspaceId);
      if (current === null) return null;
      const registry = await this.findRegistry(
        client,
        input.scenario.providerKey,
        input.scenario.surfaceKey,
      );
      const nextRevision = input.expectedRevision + 1;
      if (current.revision.status === 'APPROVED') {
        await client.query(`UPDATE prompt_revisions SET status = 'STALE' WHERE id = $1`, [
          current.revision.id,
        ]);
      }
      await client.query(
        `INSERT INTO prompt_revisions
          (id, tenant_id, workspace_id, prompt_set_id, revision, title, subject,
            source_context, prompts, scopes, content_hash, status, created_by_user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb,
           $11, 'DRAFT', $12, $13)`,
        [
          input.revisionId,
          input.context.tenantId,
          input.context.workspaceId,
          input.promptSetId,
          nextRevision,
          current.revision.title,
          current.revision.subject,
          JSON.stringify(current.revision.sourceContext),
          JSON.stringify(input.prompts),
          JSON.stringify(input.scopes),
          input.promptContentHash,
          input.context.actorUserId,
          input.createdAt,
        ],
      );
      await this.insertScenario(client, {
        ...input,
        version: nextRevision,
        registryStatus: registry?.status ?? 'UNKNOWN',
      });
      await client.query(`UPDATE prompt_sets SET current_revision = $2 WHERE id = $1`, [
        input.promptSetId,
        nextRevision,
      ]);
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'PROMPT_REVISION_CREATED', 'PROMPT_SET', $5, 'SUCCEEDED',
           jsonb_build_object('revisionId', $6::uuid, 'revision', $7::integer,
             'promptHash', $8::text, 'scenarioHash', $9::text), $10)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.promptSetId,
          input.revisionId,
          nextRevision,
          input.promptContentHash,
          input.scenarioContentHash,
          input.createdAt,
        ],
      );
      return this.loadBundle(client, input.promptSetId, input.context.workspaceId);
    });
  }

  approveRevision(input: Parameters<PromptResearchStore['approveRevision']>[0]) {
    return this.contexts.run(input.context, async (client) => {
      const locked = await client.query<{ id: string; current_revision: number }>(
        `SELECT id, current_revision FROM prompt_sets WHERE id = $1 FOR UPDATE`,
        [input.promptSetId],
      );
      if (locked.rows[0] === undefined) return { outcome: 'NOT_FOUND' as const };
      const bundle = await this.loadBundle(client, input.promptSetId, input.context.workspaceId);
      if (bundle === null || bundle.revision.id !== input.revisionId) {
        return { outcome: 'NOT_FOUND' as const };
      }
      if (
        bundle.revision.contentHash !== input.expectedPromptHash ||
        bundle.scenario.contentHash !== input.expectedScenarioHash
      ) {
        return { outcome: 'HASH_MISMATCH' as const };
      }
      const registry = await this.findRegistry(
        client,
        bundle.scenario.providerKey,
        bundle.scenario.surfaceKey,
      );
      const issues = promptApprovalIssues({
        revision: bundle.revision,
        scenario: bundle.scenario,
        registry,
      });
      if (issues.length > 0) return { outcome: 'NOT_APPROVABLE' as const, issues };
      if (bundle.revision.status !== 'DRAFT') return { outcome: 'HASH_MISMATCH' as const };
      await client.query(`UPDATE prompt_revisions SET status = 'APPROVED' WHERE id = $1`, [
        bundle.revision.id,
      ]);
      await client.query(
        `INSERT INTO prompt_approvals
          (id, tenant_id, workspace_id, prompt_revision_id, scenario_id, prompt_content_hash,
            scenario_content_hash, approved_by_user_id, approved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.approvalId,
          input.context.tenantId,
          input.context.workspaceId,
          bundle.revision.id,
          bundle.scenario.id,
          input.expectedPromptHash,
          input.expectedScenarioHash,
          input.context.actorUserId,
          input.approvedAt,
        ],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, 'PROMPT_SET_APPROVED', 'PROMPT_REVISION', $5, 'SUCCEEDED',
           jsonb_build_object('promptSetId', $6::uuid, 'promptHash', $7::text,
             'scenarioHash', $8::text), $9)`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          bundle.revision.id,
          input.promptSetId,
          input.expectedPromptHash,
          input.expectedScenarioHash,
          input.approvedAt,
        ],
      );
      const approved = await this.loadBundle(client, input.promptSetId, input.context.workspaceId);
      return approved === null
        ? { outcome: 'NOT_FOUND' as const }
        : { outcome: 'SUCCEEDED' as const, bundle: approved };
    });
  }

  private async validSourceContext(
    client: PoolClient,
    sourceContext: Parameters<PromptResearchStore['createProposal']>[0]['sourceContext'],
  ): Promise<boolean> {
    const knowledge = await client.query<{ profile_exists: boolean; offering_exists: boolean }>(
      `SELECT
         EXISTS (
           SELECT 1 FROM profile_revisions
           WHERE profile_id = $1 AND revision = $2
         ) AS profile_exists,
         EXISTS (
           SELECT 1 FROM offering_revisions
           WHERE offering_id = $3 AND revision = $4 AND profile_id = $1
         ) AS offering_exists`,
      [
        sourceContext.profile.id,
        sourceContext.profile.revision,
        sourceContext.offering.id,
        sourceContext.offering.revision,
      ],
    );
    const knowledgeRow = knowledge.rows[0];
    if (knowledgeRow?.profile_exists !== true || knowledgeRow.offering_exists !== true)
      return false;
    if (sourceContext.claimRevisionIds.length === 0) return true;
    const claims = await client.query<{ count: string }>(
      `SELECT count(DISTINCT id)::text AS count
       FROM claim_revisions
       WHERE id = ANY($1::uuid[]) AND status = 'APPROVED'`,
      [sourceContext.claimRevisionIds],
    );
    return Number(claims.rows[0]?.count ?? 0) === new Set(sourceContext.claimRevisionIds).size;
  }

  private async insertScenario(
    client: PoolClient,
    input: Pick<
      Parameters<PromptResearchStore['createProposal']>[0],
      'context' | 'revisionId' | 'scenarioId' | 'scenario' | 'scenarioContentHash' | 'createdAt'
    > & {
      version: number;
      registryStatus: MeasurementScenarioRecord['registryStatus'];
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO measurement_scenarios
        (id, tenant_id, workspace_id, prompt_revision_id, version, provider_key, surface_key,
          model, model_version, account_ref, acquisition_method, fresh_session, search_enabled,
          parameters, repetitions, content_hash, registry_status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14::jsonb, $15, $16, $17, $18)`,
      [
        input.scenarioId,
        input.context.tenantId,
        input.context.workspaceId,
        input.revisionId,
        input.version,
        input.scenario.providerKey,
        input.scenario.surfaceKey,
        input.scenario.model,
        input.scenario.modelVersion,
        input.scenario.account,
        input.scenario.acquisitionMethod,
        input.scenario.freshSession,
        input.scenario.searchEnabled,
        JSON.stringify(input.scenario.parameters),
        input.scenario.repetitions,
        input.scenarioContentHash,
        input.registryStatus,
        input.createdAt,
      ],
    );
  }

  private async loadBundle(
    client: PoolClient,
    promptSetId: string,
    workspaceId: string,
    revisionId?: string,
  ): Promise<PromptBundle | null> {
    const promptSetResult = await client.query<PromptSetRow>(
      `SELECT id, tenant_id, workspace_id, current_revision, created_at
       FROM prompt_sets WHERE id = $1 AND workspace_id = $2`,
      [promptSetId, workspaceId],
    );
    const promptSetRow = promptSetResult.rows[0];
    if (promptSetRow === undefined) return null;
    const revisionResult =
      revisionId === undefined
        ? await client.query<PromptRevisionRow>(
            `SELECT id, prompt_set_id, revision, title, subject, source_context, prompts, scopes,
               content_hash, status, created_by_user_id, created_at
             FROM prompt_revisions
             WHERE prompt_set_id = $1 AND revision = $2 AND workspace_id = $3`,
            [promptSetId, promptSetRow.current_revision, workspaceId],
          )
        : await client.query<PromptRevisionRow>(
            `SELECT id, prompt_set_id, revision, title, subject, source_context, prompts, scopes,
               content_hash, status, created_by_user_id, created_at
             FROM prompt_revisions
             WHERE prompt_set_id = $1 AND id = $2 AND workspace_id = $3`,
            [promptSetId, revisionId, workspaceId],
          );
    const revisionRow = revisionResult.rows[0];
    if (revisionRow === undefined) return null;
    const scenarioResult = await client.query<ScenarioRow>(
      `SELECT id, prompt_revision_id, version, provider_key, surface_key, model, model_version,
         account_ref, acquisition_method, fresh_session, search_enabled, parameters, repetitions,
         content_hash, registry_status, created_at
       FROM measurement_scenarios WHERE prompt_revision_id = $1 AND workspace_id = $2`,
      [revisionRow.id, workspaceId],
    );
    const scenarioRow = scenarioResult.rows[0];
    if (scenarioRow === undefined) return null;
    const approvalResult = await client.query<ApprovalRow>(
      `SELECT id, prompt_revision_id, scenario_id, prompt_content_hash, scenario_content_hash,
         approved_by_user_id, approved_at
       FROM prompt_approvals WHERE prompt_revision_id = $1 AND workspace_id = $2`,
      [revisionRow.id, workspaceId],
    );
    const previousApproval = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM prompt_approvals approval
         JOIN prompt_revisions revision ON revision.id = approval.prompt_revision_id
         WHERE revision.prompt_set_id = $1 AND revision.revision < $2
           AND revision.workspace_id = $3 AND approval.workspace_id = $3
       ) AS exists`,
      [promptSetId, revisionRow.revision, workspaceId],
    );
    const promptSet = this.mapPromptSet(promptSetRow);
    const revision = this.mapRevision(revisionRow);
    const scenario = this.mapScenario(scenarioRow);
    const approval =
      approvalResult.rows[0] === undefined ? null : this.mapApproval(approvalResult.rows[0]);
    const approvalCurrent =
      approval !== null &&
      revision.status === 'APPROVED' &&
      approval.promptContentHash === revision.contentHash &&
      approval.scenarioContentHash === scenario.contentHash;
    return {
      promptSet,
      revision,
      scenario,
      approval,
      approvalCurrent,
      previousApprovalStale: approval === null && previousApproval.rows[0]?.exists === true,
    };
  }

  private async findRegistry(
    client: PoolClient,
    providerKey: string,
    surfaceKey: string,
  ): Promise<ProviderSurfaceRegistryRecord | null> {
    const result = await client.query<RegistryRow>(
      `SELECT id, provider_key, provider_name, surface_key, surface_name, surface_kind,
         acquisition_class, acquisition_method, status, unavailable_reason, adapter_version
       FROM provider_surface_registry WHERE provider_key = $1 AND surface_key = $2`,
      [providerKey, surfaceKey],
    );
    return result.rows[0] === undefined ? null : this.mapRegistry(result.rows[0]);
  }

  private mapPromptSet(row: PromptSetRow): PromptSetRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      currentRevision: row.current_revision,
      createdAt: row.created_at.toISOString(),
    };
  }

  private mapRevision(row: PromptRevisionRow): PromptRevisionRecord {
    return {
      id: row.id,
      promptSetId: row.prompt_set_id,
      revision: row.revision,
      title: row.title,
      subject: row.subject,
      sourceContext: row.source_context,
      prompts: row.prompts,
      scopes: row.scopes,
      contentHash: row.content_hash,
      status: row.status,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at.toISOString(),
    };
  }

  private mapScenario(row: ScenarioRow): MeasurementScenarioRecord {
    return {
      id: row.id,
      promptRevisionId: row.prompt_revision_id,
      version: row.version,
      providerKey: row.provider_key,
      surfaceKey: row.surface_key,
      model: row.model,
      modelVersion: row.model_version,
      account: row.account_ref,
      acquisitionMethod: row.acquisition_method,
      freshSession: row.fresh_session,
      searchEnabled: row.search_enabled,
      parameters: row.parameters,
      repetitions: row.repetitions,
      contentHash: row.content_hash,
      registryStatus: row.registry_status,
      createdAt: row.created_at.toISOString(),
    };
  }

  private mapApproval(row: ApprovalRow): PromptApprovalRecord {
    return {
      id: row.id,
      promptRevisionId: row.prompt_revision_id,
      scenarioId: row.scenario_id,
      promptContentHash: row.prompt_content_hash,
      scenarioContentHash: row.scenario_content_hash,
      approvedByUserId: row.approved_by_user_id,
      approvedAt: row.approved_at.toISOString(),
    };
  }

  private mapRegistry(row: RegistryRow): ProviderSurfaceRegistryRecord {
    return {
      id: row.id,
      providerKey: row.provider_key,
      providerName: row.provider_name,
      surfaceKey: row.surface_key,
      surfaceName: row.surface_name,
      surfaceKind: row.surface_kind,
      acquisitionClass: row.acquisition_class,
      acquisitionMethod: row.acquisition_method,
      status: row.status,
      unavailableReason: row.unavailable_reason,
      adapterVersion: row.adapter_version,
    };
  }
}
