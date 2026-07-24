import { describe, expect, test, vi } from 'vitest';

import { emitJobBudgetSignals } from './job-budget-signals.js';

describe('job budget operational signals', () => {
  test('emits warning and hard-block events with opaque correlation only', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };

    emitJobBudgetSignals(logger, {
      requestId: 'request-1',
      tenantId: 'tenant-1',
      workspaceId: 'workspace-1',
      aggregateId: 'aggregate-1',
      job: { id: 'job-1', status: 'BUDGET_BLOCKED', budgetWarning: true },
    });

    expect(logger.warn).toHaveBeenNthCalledWith(1, 'BUDGET_WARNING', {
      correlation: { requestId: 'request-1', jobId: 'job-1' },
      attributes: {
        tenantId: 'tenant-1',
        workspaceId: 'workspace-1',
        aggregateId: 'aggregate-1',
        outcome: 'BUDGET_BLOCKED',
      },
    });
    expect(logger.warn).toHaveBeenNthCalledWith(2, 'BUDGET_BLOCKED', {
      correlation: { requestId: 'request-1', jobId: 'job-1' },
      attributes: {
        tenantId: 'tenant-1',
        workspaceId: 'workspace-1',
        aggregateId: 'aggregate-1',
        outcome: 'BUDGET_BLOCKED',
      },
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(
      /prompt|content|rawResponse|token/iu,
    );
  });

  test('does not emit budget events for a normal submission', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };

    emitJobBudgetSignals(logger, {
      requestId: 'request-1',
      tenantId: 'tenant-1',
      workspaceId: 'workspace-1',
      aggregateId: 'aggregate-1',
      job: { id: 'job-1', status: 'QUEUED', budgetWarning: false },
    });

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
