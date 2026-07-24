import { createHash } from 'node:crypto';
import type { ContentPlanningStore } from '@aeostudio/application/content-planning';
import type { TenantContext } from '@aeostudio/application/identity-access';
import {
  buildDeterministicContentPlan,
  type PlannedAssetKind,
} from '@aeostudio/domain/content-planning';
import type { JobRecord } from '@aeostudio/domain/jobs-budgets';

export type ContentPlanHandlerOutcome =
  | { outcome: 'SUCCEEDED'; planId: string; contentHash: string; briefCount: number }
  | { outcome: 'INVALID_REFERENCE'; errors: string[] }
  | { outcome: 'NOT_FOUND' };

export class ContentPlanHandler {
  constructor(
    private readonly store: ContentPlanningStore,
    private readonly ids: { next(): string },
    private readonly clock: { now(): Date },
  ) {}

  async run(job: JobRecord): Promise<ContentPlanHandlerOutcome> {
    const context: TenantContext = {
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
      actorUserId: job.id,
      membershipId: job.id,
      role: 'OWNER',
    };
    const snapshot = await this.store.loadInput({ context, planId: job.aggregateId });
    if (snapshot === null) return { outcome: 'NOT_FOUND' };
    const result = buildDeterministicContentPlan(snapshot);
    const assetKinds: PlannedAssetKind[] = [
      'DEFINITION_PRODUCT',
      'COMPARISON',
      'TECHNICAL_EVIDENCE',
    ];
    const opportunityIds = Object.fromEntries(
      assetKinds.map((assetKind) => [assetKind, this.ids.next()]),
    ) as Record<PlannedAssetKind, string>;
    const briefIds: Partial<Record<PlannedAssetKind, string>> = {};
    const briefContentHashes: Partial<Record<PlannedAssetKind, string>> = {};
    for (const brief of result.briefs) {
      briefIds[brief.assetKind] = this.ids.next();
      briefContentHashes[brief.assetKind] = this.hash({
        methodPolicyVersion: result.methodPolicyVersion,
        ...brief,
      });
    }
    const evidenceTaskIds: Partial<Record<PlannedAssetKind, string>> = {};
    for (const task of result.evidenceTasks) evidenceTaskIds[task.assetKind] = this.ids.next();
    const completed = await this.store.completePlan({
      context,
      planId: job.aggregateId,
      result,
      contentHash: this.hash({ snapshot, result }),
      opportunityIds,
      briefIds,
      briefContentHashes,
      evidenceTaskIds,
      completedAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
    if (completed.outcome !== 'SUCCEEDED') return completed;
    return {
      outcome: 'SUCCEEDED',
      planId: completed.bundle.plan.id,
      contentHash: completed.bundle.plan.contentHash ?? this.hash({ snapshot, result }),
      briefCount: completed.bundle.briefs.length,
    };
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(this.canonicalJson(value), 'utf8').digest('hex');
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
