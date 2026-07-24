import type { IdentityIdGenerator, TenancyStore } from '../identity-access/index.js';
import { roleAllows } from '@aeostudio/domain/identity-access';
import type {
  BudgetAlertRecord,
  BudgetPolicyRecord,
  JobRecord,
  JobType,
  ProviderBudgetPolicyRecord,
  TenantBudgetPolicyRecord,
} from '@aeostudio/domain/jobs-budgets';

import type { JobBudgetStore } from './ports.js';
import { readJobTraceContext } from './job-trace-context.js';
import type { JobTraceContext } from './execution-ports.js';

export type BudgetMutationResult =
  | {
      outcome: 'SUCCEEDED';
      policy: BudgetPolicyRecord | TenantBudgetPolicyRecord | ProviderBudgetPolicyRecord;
    }
  | { outcome: 'FORBIDDEN' }
  | { outcome: 'NOT_FOUND' };

export type JobMutationResult =
  | { outcome: 'SUCCEEDED'; job: JobRecord }
  | { outcome: 'CONFLICT'; job: JobRecord }
  | { outcome: 'FORBIDDEN' }
  | { outcome: 'NOT_FOUND' };

export type BudgetAlertQueryResult =
  | { outcome: 'SUCCEEDED'; alerts: BudgetAlertRecord[] }
  | { outcome: 'FORBIDDEN' }
  | { outcome: 'NOT_FOUND' };

export class JobBudgetService {
  constructor(
    private readonly store: JobBudgetStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext' | 'appendDeniedAudit'>,
    private readonly ids: IdentityIdGenerator,
  ) {}

  async setBudget(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    limitUnits: number;
  }): Promise<BudgetMutationResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'TENANT_MANAGE')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'BUDGET_CHANGE',
        resourceType: 'BUDGET_POLICY',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const policy = await this.store.setBudget({
      context,
      policyId: this.ids.next(),
      limitUnits: input.limitUnits,
      auditEventId: this.ids.next(),
    });
    return { outcome: 'SUCCEEDED', policy };
  }

  async setTenantBudget(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    limitUnits: number;
  }): Promise<BudgetMutationResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' };
    if (!roleAllows(context.role, 'TENANT_MANAGE')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'TENANT_BUDGET_CHANGE',
        resourceType: 'TENANT_BUDGET_POLICY',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const policy = await this.store.setTenantBudget({
      context,
      policyId: this.ids.next(),
      limitUnits: input.limitUnits,
      auditEventId: this.ids.next(),
    });
    return { outcome: 'SUCCEEDED', policy };
  }

  async setProviderBudget(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    providerKey: string;
    limitUnits: number;
  }): Promise<BudgetMutationResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' };
    if (!roleAllows(context.role, 'TENANT_MANAGE')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'PROVIDER_BUDGET_CHANGE',
        resourceType: 'PROVIDER_BUDGET_POLICY',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const policy = await this.store.setProviderBudget({
      context,
      policyId: this.ids.next(),
      providerKey: input.providerKey,
      limitUnits: input.limitUnits,
      auditEventId: this.ids.next(),
    });
    return { outcome: 'SUCCEEDED', policy };
  }

  async listBudgetAlerts(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<BudgetAlertQueryResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' };
    if (!roleAllows(context.role, 'TENANT_MANAGE')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'TENANT_BUDGET_ALERT_READ',
        resourceType: 'TENANT_BUDGET_ALERT',
      });
      return { outcome: 'FORBIDDEN' };
    }
    return {
      outcome: 'SUCCEEDED',
      alerts: await this.store.listBudgetAlerts({ context }),
    };
  }

  async submitJob(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    jobType: JobType;
    aggregateId: string;
    idempotencyKey: string;
    estimatedUnits: number;
    traceContext?: JobTraceContext;
  }): Promise<JobMutationResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'JOB_SUBMIT',
        resourceType: 'JOB',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const job = await this.store.submitJob({
      context,
      jobId: this.ids.next(),
      jobType: input.jobType,
      aggregateId: input.aggregateId,
      idempotencyKey: input.idempotencyKey,
      estimatedUnits: input.estimatedUnits,
      providerKey: null,
      reservationId: this.ids.next(),
      budgetAlertId: this.ids.next(),
      outboxMessageId: this.ids.next(),
      auditEventId: this.ids.next(),
      ...(input.traceContext === undefined
        ? {}
        : { traceContext: readJobTraceContext(input.traceContext) }),
    });
    return job === null ? { outcome: 'NOT_FOUND' } : { outcome: 'SUCCEEDED', job };
  }

  async getJob(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    jobId: string;
  }): Promise<JobRecord | null> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) {
      return null;
    }
    return this.store.findJob({ context, jobId: input.jobId });
  }

  async cancelJob(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    jobId: string;
  }): Promise<JobMutationResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'JOB_CANCEL',
        resourceType: 'JOB',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const job = await this.store.cancelJob({
      context,
      jobId: input.jobId,
      eventId: this.ids.next(),
      auditEventId: this.ids.next(),
    });
    if (job === null) return { outcome: 'NOT_FOUND' };
    if (
      job.jobType === 'PUBLICATION' &&
      (job.status === 'RUNNING' || job.status === 'RETRY_WAIT')
    ) {
      return { outcome: 'CONFLICT', job };
    }
    return { outcome: 'SUCCEEDED', job };
  }
}
