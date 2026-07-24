import { createHash } from 'node:crypto';

import type { ExperimentInterventionRequest } from '@aeostudio/contracts/experiments';
import { roleAllows } from '@aeostudio/domain/identity-access';

import type { TenancyStore } from '../identity-access/index.js';
import type { ExperimentCreateCommand, ExperimentStore } from './ports.js';

export class ExperimentService {
  constructor(
    private readonly store: ExperimentStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext' | 'appendDeniedAudit'>,
    private readonly ids: { next(): string },
    private readonly clock: { now(): Date },
  ) {}

  async listOptions(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    limit: number;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) return null;
    return this.store.listOptions({ context, limit: Math.min(Math.max(input.limit, 1), 100) });
  }

  async create(input: ExperimentCreateCommand) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' as const };
    if (!roleAllows(context.role, 'MEASUREMENT_RUN')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'EXPERIMENT_CREATE',
        resourceType: 'EXPERIMENT',
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    return this.store.create({
      context,
      experimentId: this.ids.next(),
      baselineRunId: input.baselineRunId,
      remeasurementRunId: input.remeasurementRunId,
      intervention: input.intervention,
      idempotencyKey: input.idempotencyKey,
      requestHash: experimentRequestHash({
        baselineRunId: input.baselineRunId,
        remeasurementRunId: input.remeasurementRunId,
        intervention: input.intervention,
      }),
      createdAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
  }

  async get(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    experimentId: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) return null;
    return this.store.find({ context, experimentId: input.experimentId });
  }
}

function experimentRequestHash(input: {
  baselineRunId: string;
  remeasurementRunId: string;
  intervention: ExperimentInterventionRequest;
}): string {
  return createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
}
