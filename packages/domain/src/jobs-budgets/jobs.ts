export const JOB_STATUSES = [
  'BUDGET_BLOCKED',
  'QUEUED',
  'RUNNING',
  'RETRY_WAIT',
  'SUCCEEDED',
  'FAILED_TERMINAL',
  'CANCELLED',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobType =
  | 'PROFILE_READINESS'
  | 'SITE_CRAWL'
  | 'CONTENT_PLAN'
  | 'ARTIFACT_GENERATION'
  | 'PUBLICATION'
  | 'MEASUREMENT';

export interface JobRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  providerKey: string | null;
  jobType: JobType;
  aggregateId: string;
  status: JobStatus;
  progress: number;
  attempt: number;
  maxAttempts: number;
  budgetWarning: boolean;
  estimatedUnits: number;
  heartbeatAt: string | null;
  result: Record<string, unknown> | null;
  errorCode: string | null;
}

export interface BudgetPolicyRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  limitUnits: number;
  warningPercent: number;
}

export interface TenantBudgetPolicyRecord {
  id: string;
  tenantId: string;
  limitUnits: number;
  warningPercent: number;
}

export interface ProviderBudgetPolicyRecord extends TenantBudgetPolicyRecord {
  providerKey: string;
}

export type BudgetAlertScope = 'TENANT' | 'PROVIDER';
export type BudgetAlertAudience = 'TENANT_OWNER';

export interface BudgetAlertRecord {
  id: string;
  tenantId: string;
  sourceWorkspaceId: string;
  jobId: string;
  budgetScope: BudgetAlertScope;
  policyId: string;
  providerKey: string | null;
  thresholdPercent: number;
  audience: BudgetAlertAudience;
  recipientUserId: string;
  createdAt: string;
}
