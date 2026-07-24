import { createHash } from 'node:crypto';
import { roleAllows } from '@aeostudio/domain/identity-access';
import {
  generateDeterministicPromptSkeleton,
  type MeasurementScenarioInput,
  type PromptDraftRecord,
  type PromptScopeRecord,
  type PromptSourceContext,
} from '@aeostudio/domain/prompt-research';

import type { IdentityIdGenerator, TenancyStore } from '../identity-access/index.js';
import type { PromptResearchStore } from './ports.js';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canManagePrompts(role: Parameters<typeof roleAllows>[0]): boolean {
  return roleAllows(role, 'CONTENT_EDIT') || roleAllows(role, 'MEASUREMENT_RUN');
}

function canApprovePrompts(role: Parameters<typeof roleAllows>[0]): boolean {
  return canManagePrompts(role) || roleAllows(role, 'CLAIM_APPROVE');
}

export class PromptResearchService {
  constructor(
    private readonly store: PromptResearchStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext' | 'appendDeniedAudit'>,
    private readonly ids: IdentityIdGenerator,
    private readonly clock: { now(): Date },
  ) {}

  async listRegistry(input: { actorSubject: string; tenantId: string; workspaceId: string }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) return null;
    return this.store.listRegistry({ context });
  }

  async propose(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    title: string;
    subject: string;
    sourceContext: PromptSourceContext;
    scopes: PromptScopeRecord[];
    scenario: MeasurementScenarioInput;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' as const };
    if (!canManagePrompts(context.role)) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'PROMPT_SET_PROPOSE',
        resourceType: 'PROMPT_SET',
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    const prompts = generateDeterministicPromptSkeleton(input.subject, () => this.ids.next());
    const promptHash = contentHash({
      title: input.title,
      subject: input.subject,
      sourceContext: input.sourceContext,
      prompts,
      scopes: input.scopes,
    });
    const scenarioHash = contentHash(input.scenario);
    const bundle = await this.store.createProposal({
      context,
      promptSetId: this.ids.next(),
      revisionId: this.ids.next(),
      scenarioId: this.ids.next(),
      title: input.title,
      subject: input.subject,
      sourceContext: input.sourceContext,
      prompts,
      scopes: input.scopes,
      scenario: input.scenario,
      promptContentHash: promptHash,
      scenarioContentHash: scenarioHash,
      createdAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
    return bundle === null
      ? { outcome: 'NOT_FOUND' as const }
      : { outcome: 'SUCCEEDED' as const, bundle };
  }

  async revise(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    promptSetId: string;
    expectedRevision: number;
    prompts: PromptDraftRecord[];
    scopes: PromptScopeRecord[];
    scenario: MeasurementScenarioInput;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' as const };
    if (!canManagePrompts(context.role)) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'PROMPT_SET_EDIT',
        resourceType: 'PROMPT_SET',
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    const current = await this.store.findCurrent({ context, promptSetId: input.promptSetId });
    if (current === null || current.revision.revision !== input.expectedRevision) {
      return { outcome: 'NOT_FOUND' as const };
    }
    const promptHash = contentHash({
      title: current.revision.title,
      subject: current.revision.subject,
      sourceContext: current.revision.sourceContext,
      prompts: input.prompts,
      scopes: input.scopes,
    });
    const scenarioHash = contentHash(input.scenario);
    const bundle = await this.store.createRevision({
      context,
      promptSetId: input.promptSetId,
      expectedRevision: input.expectedRevision,
      revisionId: this.ids.next(),
      scenarioId: this.ids.next(),
      prompts: input.prompts,
      scopes: input.scopes,
      scenario: input.scenario,
      promptContentHash: promptHash,
      scenarioContentHash: scenarioHash,
      createdAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
    return bundle === null
      ? { outcome: 'NOT_FOUND' as const }
      : { outcome: 'SUCCEEDED' as const, bundle };
  }

  async approve(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    promptSetId: string;
    revisionId: string;
    expectedPromptHash: string;
    expectedScenarioHash: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' as const };
    if (!canApprovePrompts(context.role)) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'PROMPT_SET_APPROVE',
        resourceType: 'PROMPT_REVISION',
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    return this.store.approveRevision({
      context,
      promptSetId: input.promptSetId,
      revisionId: input.revisionId,
      expectedPromptHash: input.expectedPromptHash,
      expectedScenarioHash: input.expectedScenarioHash,
      approvalId: this.ids.next(),
      approvedAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
  }

  async getCurrent(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    promptSetId: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) return null;
    return this.store.findCurrent({ context, promptSetId: input.promptSetId });
  }

  async getRevision(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    promptSetId: string;
    revisionId: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) return null;
    return this.store.findRevision({
      context,
      promptSetId: input.promptSetId,
      revisionId: input.revisionId,
    });
  }

  async listApprovedPromptSets(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) return null;
    return this.store.listApprovedPromptSets({ context });
  }
}
