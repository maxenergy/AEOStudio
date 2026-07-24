import type { JobBudgetStore } from '@aeostudio/application/jobs-budgets';
import type {
  BudgetAlertRecord,
  BudgetPolicyRecord,
  JobRecord,
  ProviderBudgetPolicyRecord,
  TenantBudgetPolicyRecord,
} from '@aeostudio/domain/jobs-budgets';

export class MissingJobBudgetStore implements JobBudgetStore {
  setBudget(): Promise<BudgetPolicyRecord> {
    return Promise.reject(new Error('JOB_BUDGET_STORE_NOT_CONFIGURED'));
  }

  setTenantBudget(): Promise<TenantBudgetPolicyRecord> {
    return Promise.reject(new Error('JOB_BUDGET_STORE_NOT_CONFIGURED'));
  }

  setProviderBudget(): Promise<ProviderBudgetPolicyRecord> {
    return Promise.reject(new Error('JOB_BUDGET_STORE_NOT_CONFIGURED'));
  }

  listBudgetAlerts(): Promise<BudgetAlertRecord[]> {
    return Promise.reject(new Error('JOB_BUDGET_STORE_NOT_CONFIGURED'));
  }

  reserveGenerationStart(): ReturnType<JobBudgetStore['reserveGenerationStart']> {
    return Promise.reject(new Error('JOB_BUDGET_STORE_NOT_CONFIGURED'));
  }

  submitJob(): Promise<JobRecord | null> {
    return Promise.reject(new Error('JOB_BUDGET_STORE_NOT_CONFIGURED'));
  }

  findJob(): Promise<JobRecord | null> {
    return Promise.reject(new Error('JOB_BUDGET_STORE_NOT_CONFIGURED'));
  }

  cancelJob(): Promise<JobRecord | null> {
    return Promise.reject(new Error('JOB_BUDGET_STORE_NOT_CONFIGURED'));
  }
}
