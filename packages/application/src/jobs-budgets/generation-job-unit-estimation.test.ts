import type { ArtifactRecord } from '@aeostudio/domain/artifacts';
import type { ContentPlanRecord } from '@aeostudio/domain/content-planning';
import type { JobRecord } from '@aeostudio/domain/jobs-budgets';
import { describe, expect, test, vi } from 'vitest';

import { ArtifactService } from '../artifacts/artifact-service.js';
import type { ArtifactStore } from '../artifacts/ports.js';
import { ContentPlanningService } from '../content-planning/content-planning-service.js';
import type { ContentPlanningStore } from '../content-planning/ports.js';
import type { TenantContext, TenancyStore } from '../identity-access/index.js';
import { estimateGenerationJobUnits } from './generation-job-unit-estimator.js';
import type { JobBudgetStore } from './ports.js';

const context: TenantContext = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  actorUserId: 'user-1',
  membershipId: 'membership-1',
  role: 'EDITOR',
};

function tenancy(): Pick<TenancyStore, 'resolveTenantContext' | 'appendDeniedAudit'> {
  return {
    resolveTenantContext: vi.fn(() => Promise.resolve(context)),
    appendDeniedAudit: vi.fn(() => Promise.resolve()),
  };
}

function ids() {
  let nextId = 0;
  return { next: () => `generated-${++nextId}` };
}

function jobFrom(input: Parameters<JobBudgetStore['submitJob']>[0]): JobRecord {
  return {
    id: input.jobId,
    tenantId: input.context.tenantId,
    workspaceId: input.context.workspaceId,
    providerKey: input.providerKey ?? null,
    jobType: input.jobType,
    aggregateId: input.aggregateId,
    status: 'QUEUED',
    progress: 0,
    attempt: 0,
    maxAttempts: 3,
    budgetWarning: false,
    estimatedUnits: input.estimatedUnits,
    heartbeatAt: null,
    result: null,
    errorCode: null,
  };
}

function capturingJobs() {
  const submitJob = vi.fn((input: Parameters<JobBudgetStore['submitJob']>[0]) =>
    Promise.resolve(jobFrom(input)),
  );
  const reserveGenerationStart = vi.fn(
    (input: Parameters<JobBudgetStore['reserveGenerationStart']>[0]) =>
      Promise.resolve({
        outcome: 'RESERVED' as const,
        aggregateId: input.aggregateId,
        jobId: input.jobId,
        estimatedUnits: input.estimatedUnits,
        requestedAt: input.requestedAt,
      }),
  );
  return {
    submitJob,
    reserveGenerationStart,
    store: { submitJob, reserveGenerationStart } as unknown as JobBudgetStore,
  };
}

describe('server-owned generation Job estimates', () => {
  test('estimation is method-versioned and rejects inputs outside public bounds', () => {
    expect(
      estimateGenerationJobUnits({
        jobType: 'CONTENT_PLAN',
        methodVersion: 'content-plan-v1',
        boundedInput: { primaryClaimCount: 0, comparisonClaimCount: 0 },
      }),
    ).toBe(1);
    expect(
      estimateGenerationJobUnits({
        jobType: 'CONTENT_PLAN',
        methodVersion: 'content-plan-v1',
        boundedInput: { primaryClaimCount: 50, comparisonClaimCount: 50 },
      }),
    ).toBe(4);
    expect(() =>
      estimateGenerationJobUnits({
        jobType: 'CONTENT_PLAN',
        methodVersion: 'content-plan-v2',
        boundedInput: { primaryClaimCount: 1, comparisonClaimCount: 1 },
      }),
    ).toThrow('UNSUPPORTED_JOB_ESTIMATE_METHOD:CONTENT_PLAN');
    expect(() =>
      estimateGenerationJobUnits({
        jobType: 'ARTIFACT_GENERATION',
        methodVersion: 'artifact-fixture-v1',
        boundedInput: { briefCount: 1, localeLength: 36, marketLength: 2 },
      }),
    ).toThrow('INVALID_JOB_ESTIMATE_INPUT:localeLength');
  });

  test('Content Plan reservation ignores low and high legacy client estimates', async () => {
    const jobs = capturingJobs();
    const plan = { id: 'plan-1' } as ContentPlanRecord;
    const store = {
      preparePlan: vi.fn(() => Promise.resolve({ outcome: 'SUCCEEDED' as const, plan })),
      bindJob: vi.fn(() => Promise.resolve(plan)),
    } as unknown as ContentPlanningStore;
    const service = new ContentPlanningService(store, jobs.store, tenancy(), ids(), {
      now: () => new Date('2026-07-24T00:00:00.000Z'),
    });
    const base = {
      actorSubject: 'subject-1',
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      sourceInput: {
        profile: { id: 'profile-1', revision: 1 },
        offering: { id: 'offering-1', revision: 1 },
        promptSetId: 'prompt-set-1',
        promptRevisionId: 'prompt-revision-1',
        primaryClaimRevisionIds: ['primary-claim-1'],
        comparisonClaimRevisionIds: ['comparison-claim-1'],
        baselineId: 'baseline-1',
        methodPolicyVersion: 'content-plan-v1',
      },
    };

    await service.startPlan({
      ...base,
      idempotencyKey: 'content-plan-low',
      estimatedUnits: 1,
    } as Parameters<ContentPlanningService['startPlan']>[0] & { estimatedUnits: number });
    await service.startPlan({
      ...base,
      idempotencyKey: 'content-plan-high',
      estimatedUnits: 999_999,
    } as Parameters<ContentPlanningService['startPlan']>[0] & { estimatedUnits: number });

    expect(jobs.submitJob.mock.calls.map(([input]) => input.estimatedUnits)).toEqual([4, 4]);
  });

  test('Artifact reservation ignores low and high legacy client estimates', async () => {
    const jobs = capturingJobs();
    const artifact = {
      id: 'artifact-1',
      type: 'DEFINITION_PRODUCT',
    } as ArtifactRecord;
    const store = {
      prepareArtifact: vi.fn(() => Promise.resolve({ outcome: 'SUCCEEDED' as const, artifact })),
      bindJob: vi.fn(() => Promise.resolve(artifact)),
    } as unknown as ArtifactStore;
    const service = new ArtifactService(
      store,
      {} as never,
      {} as never,
      jobs.store,
      tenancy(),
      ids(),
      { now: () => new Date('2026-07-24T00:00:00.000Z') },
    );
    const base = {
      actorSubject: 'subject-1',
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      briefId: 'brief-1',
      locale: 'en-SG',
      market: 'SG',
      methodPolicyVersion: 'artifact-fixture-v1',
    };

    await service.startGeneration({
      ...base,
      idempotencyKey: 'artifact-low',
      estimatedUnits: 1,
    } as Parameters<ArtifactService['startGeneration']>[0] & { estimatedUnits: number });
    await service.startGeneration({
      ...base,
      idempotencyKey: 'artifact-high',
      estimatedUnits: 999_999,
    } as Parameters<ArtifactService['startGeneration']>[0] & { estimatedUnits: number });

    expect(jobs.submitJob.mock.calls.map(([input]) => input.estimatedUnits)).toEqual([5, 5]);
  });
});
