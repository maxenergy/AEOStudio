import { createHash } from 'node:crypto';
import { roleAllows } from '@aeostudio/domain/identity-access';
import {
  buildDeterministicContentPlan,
  type ContentPlanSourceInput,
  type PlannedAssetKind,
} from '@aeostudio/domain/content-planning';
import {
  estimateGenerationJobUnits,
  type JobBudgetStore,
  type JobTraceContext,
} from '../jobs-budgets/index.js';

import type { IdentityIdGenerator, TenancyStore } from '../identity-access/index.js';
import type { ContentPlanningStore } from './ports.js';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

const ASSET_KINDS: PlannedAssetKind[] = ['DEFINITION_PRODUCT', 'COMPARISON', 'TECHNICAL_EVIDENCE'];

export class ContentPlanningService {
  constructor(
    private readonly store: ContentPlanningStore,
    private readonly jobs: JobBudgetStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext' | 'appendDeniedAudit'>,
    private readonly ids: IdentityIdGenerator,
    private readonly clock: { now(): Date },
  ) {}

  async startPlan(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    sourceInput: ContentPlanSourceInput;
    idempotencyKey: string;
    traceContext?: JobTraceContext;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' as const };
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'CONTENT_PLAN_START',
        resourceType: 'CONTENT_PLAN',
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    const estimatedUnits = estimateGenerationJobUnits({
      jobType: 'CONTENT_PLAN',
      methodVersion: input.sourceInput.methodPolicyVersion,
      boundedInput: {
        primaryClaimCount: input.sourceInput.primaryClaimRevisionIds.length,
        comparisonClaimCount: input.sourceInput.comparisonClaimRevisionIds.length,
      },
    });
    const reserved = await this.jobs.reserveGenerationStart({
      context,
      operation: 'CONTENT_PLAN',
      idempotencyKey: input.idempotencyKey,
      requestHash: hash(input.sourceInput),
      aggregateId: this.ids.next(),
      jobId: this.ids.next(),
      estimatedUnits,
      requestedAt: this.clock.now(),
    });
    if (reserved.outcome !== 'RESERVED') {
      return reserved.outcome === 'IDEMPOTENCY_CONFLICT'
        ? { outcome: 'IDEMPOTENCY_CONFLICT' as const }
        : { outcome: 'NOT_FOUND' as const };
    }
    const planId = reserved.aggregateId;
    const prepared = await this.store.preparePlan({
      context,
      planId,
      sourceInput: input.sourceInput,
      createdAt: reserved.requestedAt,
      auditEventId: this.ids.next(),
    });
    if (prepared.outcome === 'INVALID_REFERENCE') return prepared;
    const job = await this.jobs.submitJob({
      context,
      jobId: reserved.jobId,
      jobType: 'CONTENT_PLAN',
      aggregateId: planId,
      idempotencyKey: input.idempotencyKey,
      estimatedUnits: reserved.estimatedUnits,
      reservationId: this.ids.next(),
      budgetAlertId: this.ids.next(),
      outboxMessageId: this.ids.next(),
      auditEventId: this.ids.next(),
      ...(input.traceContext === undefined ? {} : { traceContext: input.traceContext }),
    });
    if (job === null) return { outcome: 'NOT_FOUND' as const };
    const plan = await this.store.bindJob({ context, planId, jobId: job.id });
    return plan === null
      ? { outcome: 'NOT_FOUND' as const }
      : { outcome: 'SUCCEEDED' as const, plan, job };
  }

  async getPlan(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    planId: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) return null;
    return this.store.findBundle({ context, planId: input.planId });
  }

  async completePlanJob(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    planId: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' as const };
    const snapshot = await this.store.loadInput({ context, planId: input.planId });
    if (snapshot === null) return { outcome: 'NOT_FOUND' as const };
    const result = buildDeterministicContentPlan(snapshot);
    const opportunityIds = Object.fromEntries(
      ASSET_KINDS.map((assetKind) => [assetKind, this.ids.next()]),
    ) as Record<PlannedAssetKind, string>;
    const briefIds: Partial<Record<PlannedAssetKind, string>> = {};
    const briefContentHashes: Partial<Record<PlannedAssetKind, string>> = {};
    for (const brief of result.briefs) {
      briefIds[brief.assetKind] = this.ids.next();
      briefContentHashes[brief.assetKind] = hash({
        methodPolicyVersion: result.methodPolicyVersion,
        ...brief,
      });
    }
    const evidenceTaskIds: Partial<Record<PlannedAssetKind, string>> = {};
    for (const task of result.evidenceTasks) evidenceTaskIds[task.assetKind] = this.ids.next();
    return this.store.completePlan({
      context,
      planId: input.planId,
      result,
      contentHash: hash({ snapshot, result }),
      opportunityIds,
      briefIds,
      briefContentHashes,
      evidenceTaskIds,
      completedAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
  }

  async reviewBrief(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    planId: string;
    briefId: string;
    decision: 'APPROVE' | 'REJECT';
    expectedContentHash: string;
    note: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' as const };
    if (!roleAllows(context.role, 'BRIEF_APPROVE')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'BRIEF_REVIEW',
        resourceType: 'BRIEF',
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    return this.store.reviewBrief({
      context,
      planId: input.planId,
      briefId: input.briefId,
      decision: input.decision,
      expectedContentHash: input.expectedContentHash,
      note: input.note,
      reviewId: this.ids.next(),
      reviewedAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
  }
}
