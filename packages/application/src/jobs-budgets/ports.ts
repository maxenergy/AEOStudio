import type {
  BudgetPolicyRecord,
  BudgetAlertRecord,
  JobRecord,
  JobType,
  ProviderBudgetPolicyRecord,
  TenantBudgetPolicyRecord,
} from '@aeostudio/domain/jobs-budgets';
import type { TenantContext } from '../identity-access/index.js';
import type { JobTraceContext } from './execution-ports.js';

export interface JobBudgetStore {
  setBudget(input: {
    context: TenantContext;
    policyId: string;
    limitUnits: number;
    auditEventId: string;
  }): Promise<BudgetPolicyRecord>;
  setTenantBudget(input: {
    context: TenantContext;
    policyId: string;
    limitUnits: number;
    auditEventId: string;
  }): Promise<TenantBudgetPolicyRecord>;
  setProviderBudget(input: {
    context: TenantContext;
    policyId: string;
    providerKey: string;
    limitUnits: number;
    auditEventId: string;
  }): Promise<ProviderBudgetPolicyRecord>;
  listBudgetAlerts(input: { context: TenantContext }): Promise<BudgetAlertRecord[]>;
  reserveGenerationStart(input: {
    context: TenantContext;
    operation: 'CONTENT_PLAN' | 'ARTIFACT_GENERATION';
    idempotencyKey: string;
    requestHash: string;
    aggregateId: string;
    jobId: string;
    estimatedUnits: number;
    requestedAt: Date;
  }): Promise<
    | {
        outcome: 'RESERVED';
        aggregateId: string;
        jobId: string;
        estimatedUnits: number;
        requestedAt: Date;
      }
    | { outcome: 'IDEMPOTENCY_CONFLICT' | 'NOT_FOUND' }
  >;
  submitJob(input: {
    context: TenantContext;
    jobId: string;
    jobType: JobType;
    aggregateId: string;
    idempotencyKey: string;
    estimatedUnits: number;
    providerKey?: string | null;
    reservationId: string;
    budgetAlertId: string;
    outboxMessageId: string;
    auditEventId: string;
    traceContext?: JobTraceContext;
  }): Promise<JobRecord | null>;
  findJob(input: { context: TenantContext; jobId: string }): Promise<JobRecord | null>;
  cancelJob(input: {
    context: TenantContext;
    jobId: string;
    eventId: string;
    auditEventId: string;
  }): Promise<JobRecord | null>;
}
