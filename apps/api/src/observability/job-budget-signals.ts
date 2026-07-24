import type { StructuredApplicationLogger } from '@aeostudio/adapters/observability';

export interface BudgetSignalJob {
  id: string;
  status: string;
  budgetWarning: boolean;
}

export function emitJobBudgetSignals(
  logger: StructuredApplicationLogger,
  input: {
    requestId: string;
    tenantId: string;
    workspaceId: string;
    aggregateId: string;
    job: BudgetSignalJob;
  },
): void {
  const logInput = {
    correlation: { requestId: input.requestId, jobId: input.job.id },
    attributes: {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      aggregateId: input.aggregateId,
      outcome: input.job.status,
    },
  };
  if (input.job.budgetWarning) logger.warn('BUDGET_WARNING', logInput);
  if (input.job.status === 'BUDGET_BLOCKED') logger.warn('BUDGET_BLOCKED', logInput);
}
