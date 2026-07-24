import { randomUUID } from 'node:crypto';

import type { JobBudgetStore } from '@aeostudio/application/jobs-budgets';
import type {
  BudgetAlertRecord,
  BudgetPolicyRecord,
  JobRecord,
  ProviderBudgetPolicyRecord,
  TenantBudgetPolicyRecord,
} from '@aeostudio/domain/jobs-budgets';

import type { InMemoryAuditSink } from '../privacy/in-memory-audit-sink.js';

interface JobState {
  idempotencyKey: string;
  job: JobRecord;
  lifecycleEpoch: number;
  polls: number;
  processorRun: {
    lifecycleEpoch: number;
    promise: Promise<InMemoryPublicationJobCompletion>;
  } | null;
}

interface GenerationStartState {
  operation: 'CONTENT_PLAN' | 'ARTIFACT_GENERATION';
  requestHash: string;
  aggregateId: string;
  jobId: string;
  estimatedUnits: number;
  requestedAt: Date;
}

export interface InMemoryPublicationJobCompletion {
  status: 'SUCCEEDED' | 'FAILED_TERMINAL' | 'RETRY_WAIT';
  result: Record<string, unknown> | null;
  errorCode: string | null;
}

type PublicationProcessor = (job: JobRecord) => Promise<InMemoryPublicationJobCompletion>;
type MeasurementProcessor = (job: JobRecord) => Promise<InMemoryPublicationJobCompletion>;

export class InMemoryJobBudgetStore implements JobBudgetStore {
  private readonly policies = new Map<string, BudgetPolicyRecord>();
  private readonly tenantPolicies = new Map<string, TenantBudgetPolicyRecord>();
  private readonly providerPolicies = new Map<string, ProviderBudgetPolicyRecord>();
  private readonly explicitlyConfiguredTenantPolicies = new Set<string>();
  private readonly explicitlyConfiguredProviderPolicies = new Set<string>();
  private readonly tenantOwners = new Map<string, Set<string>>();
  private readonly budgetAlerts = new Map<string, BudgetAlertRecord>();
  private readonly jobs = new Map<string, JobState>();
  private readonly generationStarts = new Map<string, GenerationStartState>();
  private readonly frozenTenants = new Set<string>();
  private readonly frozenWorkspaces = new Set<string>();
  private publicationProcessor: PublicationProcessor | undefined;
  private measurementProcessor: MeasurementProcessor | undefined;

  constructor(
    private readonly onCompleted?: (job: JobRecord) => void | Promise<void>,
    private readonly audit?: InMemoryAuditSink,
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {}

  registerPublicationProcessor(processor: PublicationProcessor): void {
    if (this.publicationProcessor !== undefined) {
      throw new Error('IN_MEMORY_PUBLICATION_PROCESSOR_ALREADY_REGISTERED');
    }
    this.publicationProcessor = processor;
  }

  registerMeasurementProcessor(processor: MeasurementProcessor): void {
    if (this.measurementProcessor !== undefined) {
      throw new Error('IN_MEMORY_MEASUREMENT_PROCESSOR_ALREADY_REGISTERED');
    }
    this.measurementProcessor = processor;
  }

  setBudget(input: Parameters<JobBudgetStore['setBudget']>[0]): Promise<BudgetPolicyRecord> {
    const key = this.scopeKey(input.context.tenantId, input.context.workspaceId);
    const policy: BudgetPolicyRecord = {
      id: this.policies.get(key)?.id ?? input.policyId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      limitUnits: input.limitUnits,
      warningPercent: 80,
    };
    this.policies.set(key, policy);
    if (!this.explicitlyConfiguredTenantPolicies.has(input.context.tenantId)) {
      const inheritedTenantLimit = [...this.policies.values()]
        .filter((candidate) => candidate.tenantId === input.context.tenantId)
        .reduce((total, candidate) => total + candidate.limitUnits, 0);
      this.tenantPolicies.set(input.context.tenantId, {
        id: this.tenantPolicies.get(input.context.tenantId)?.id ?? policy.id,
        tenantId: input.context.tenantId,
        limitUnits: inheritedTenantLimit,
        warningPercent: 80,
      });
    }
    this.rememberTenantOwner(input.context.tenantId, input.context.actorUserId);
    this.audit?.append({
      id: input.auditEventId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      actorId: input.context.actorUserId,
      action: 'BUDGET_POLICY_SET',
      resourceType: 'BUDGET_POLICY',
      resourceId: policy.id,
      outcome: 'SUCCEEDED',
      metadata: { limitUnits: policy.limitUnits, warningPercent: policy.warningPercent },
    });
    return Promise.resolve(structuredClone(policy));
  }

  setTenantBudget(
    input: Parameters<JobBudgetStore['setTenantBudget']>[0],
  ): Promise<TenantBudgetPolicyRecord> {
    const existing = this.tenantPolicies.get(input.context.tenantId);
    const policy: TenantBudgetPolicyRecord = {
      id: existing?.id ?? input.policyId,
      tenantId: input.context.tenantId,
      limitUnits: input.limitUnits,
      warningPercent: 80,
    };
    this.tenantPolicies.set(input.context.tenantId, policy);
    this.explicitlyConfiguredTenantPolicies.add(input.context.tenantId);
    this.rememberTenantOwner(input.context.tenantId, input.context.actorUserId);
    return Promise.resolve(structuredClone(policy));
  }

  setProviderBudget(
    input: Parameters<JobBudgetStore['setProviderBudget']>[0],
  ): Promise<ProviderBudgetPolicyRecord> {
    const key = this.providerPolicyKey(input.context.tenantId, input.providerKey);
    const existing = this.providerPolicies.get(key);
    const policy: ProviderBudgetPolicyRecord = {
      id: existing?.id ?? input.policyId,
      tenantId: input.context.tenantId,
      providerKey: input.providerKey,
      limitUnits: input.limitUnits,
      warningPercent: 80,
    };
    this.providerPolicies.set(key, policy);
    this.explicitlyConfiguredProviderPolicies.add(key);
    this.rememberTenantOwner(input.context.tenantId, input.context.actorUserId);
    return Promise.resolve(structuredClone(policy));
  }

  listBudgetAlerts(
    input: Parameters<JobBudgetStore['listBudgetAlerts']>[0],
  ): Promise<BudgetAlertRecord[]> {
    return Promise.resolve(
      [...this.budgetAlerts.values()]
        .filter(
          (alert) =>
            alert.tenantId === input.context.tenantId &&
            alert.recipientUserId === input.context.actorUserId,
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((alert) => structuredClone(alert)),
    );
  }

  reserveGenerationStart(
    input: Parameters<JobBudgetStore['reserveGenerationStart']>[0],
  ): ReturnType<JobBudgetStore['reserveGenerationStart']> {
    if (
      this.frozenTenants.has(input.context.tenantId) ||
      this.frozenWorkspaces.has(this.scopeKey(input.context.tenantId, input.context.workspaceId))
    ) {
      return Promise.resolve({ outcome: 'NOT_FOUND' });
    }
    const key = `${this.scopeKey(input.context.tenantId, input.context.workspaceId)}:${input.idempotencyKey}`;
    const existing = this.generationStarts.get(key);
    if (existing !== undefined) {
      if (
        existing.operation !== input.operation ||
        existing.requestHash !== input.requestHash
      ) {
        return Promise.resolve({ outcome: 'IDEMPOTENCY_CONFLICT' });
      }
      return Promise.resolve({
        outcome: 'RESERVED',
        aggregateId: existing.aggregateId,
        jobId: existing.jobId,
        estimatedUnits: existing.estimatedUnits,
        requestedAt: new Date(existing.requestedAt),
      });
    }
    const state: GenerationStartState = {
      operation: input.operation,
      requestHash: input.requestHash,
      aggregateId: input.aggregateId,
      jobId: input.jobId,
      estimatedUnits: input.estimatedUnits,
      requestedAt: new Date(input.requestedAt),
    };
    this.generationStarts.set(key, state);
    return Promise.resolve({
      outcome: 'RESERVED',
      aggregateId: state.aggregateId,
      jobId: state.jobId,
      estimatedUnits: state.estimatedUnits,
      requestedAt: new Date(state.requestedAt),
    });
  }

  submitJob(input: Parameters<JobBudgetStore['submitJob']>[0]): Promise<JobRecord | null> {
    if (
      this.frozenTenants.has(input.context.tenantId) ||
      this.frozenWorkspaces.has(this.scopeKey(input.context.tenantId, input.context.workspaceId))
    ) {
      return Promise.resolve(null);
    }
    const existing = [...this.jobs.values()].find(
      (state) =>
        state.job.tenantId === input.context.tenantId &&
        state.job.workspaceId === input.context.workspaceId &&
        state.idempotencyKey === input.idempotencyKey,
    );
    if (existing !== undefined) {
      const matches =
        existing.job.providerKey === (input.providerKey ?? null) &&
        existing.job.jobType === input.jobType &&
        existing.job.aggregateId === input.aggregateId &&
        existing.job.estimatedUnits === input.estimatedUnits;
      return Promise.resolve(matches ? structuredClone(existing.job) : null);
    }
    const workspacePolicy = this.policies.get(
      this.scopeKey(input.context.tenantId, input.context.workspaceId),
    );
    const tenantPolicy =
      this.tenantPolicies.get(input.context.tenantId) ??
      (workspacePolicy === undefined
        ? undefined
        : {
            id: workspacePolicy.id,
            tenantId: input.context.tenantId,
            limitUnits: [...this.policies.values()]
              .filter((candidate) => candidate.tenantId === input.context.tenantId)
              .reduce((total, candidate) => total + candidate.limitUnits, 0),
            warningPercent: workspacePolicy.warningPercent,
          });
    if (tenantPolicy !== undefined && !this.tenantPolicies.has(input.context.tenantId)) {
      this.tenantPolicies.set(input.context.tenantId, tenantPolicy);
    }
    const providerKey = input.providerKey ?? null;
    let providerPolicy =
      providerKey === null
        ? undefined
        : this.providerPolicies.get(this.providerPolicyKey(input.context.tenantId, providerKey));
    if (providerKey !== null && providerPolicy === undefined && tenantPolicy !== undefined) {
      providerPolicy = {
        id: input.jobId,
        tenantId: input.context.tenantId,
        providerKey,
        limitUnits: tenantPolicy.limitUnits,
        warningPercent: 80,
      };
      this.providerPolicies.set(
        this.providerPolicyKey(input.context.tenantId, providerKey),
        providerPolicy,
      );
    } else if (
      providerKey !== null &&
      providerPolicy !== undefined &&
      tenantPolicy !== undefined &&
      !this.explicitlyConfiguredProviderPolicies.has(
        this.providerPolicyKey(input.context.tenantId, providerKey),
      )
    ) {
      providerPolicy = { ...providerPolicy, limitUnits: tenantPolicy.limitUnits };
      this.providerPolicies.set(
        this.providerPolicyKey(input.context.tenantId, providerKey),
        providerPolicy,
      );
    }
    const reservingJobs = [...this.jobs.values()].filter(
      (state) =>
        state.job.tenantId === input.context.tenantId &&
        !['BUDGET_BLOCKED', 'FAILED_TERMINAL', 'CANCELLED'].includes(state.job.status),
    );
    const workspaceCommitted = reservingJobs
      .filter((state) => state.job.workspaceId === input.context.workspaceId)
      .reduce((total, state) => total + state.job.estimatedUnits, 0);
    const tenantCommitted = reservingJobs.reduce(
      (total, state) => total + state.job.estimatedUnits,
      0,
    );
    const providerCommitted =
      providerKey === null
        ? 0
        : reservingJobs
            .filter((state) => state.job.providerKey === providerKey)
            .reduce((total, state) => total + state.job.estimatedUnits, 0);
    const workspaceProjected = workspaceCommitted + input.estimatedUnits;
    const tenantProjected = tenantCommitted + input.estimatedUnits;
    const providerProjected = providerCommitted + input.estimatedUnits;
    const workspaceWarning =
      workspacePolicy !== undefined &&
      workspaceProjected * 100 >= workspacePolicy.limitUnits * workspacePolicy.warningPercent;
    const tenantWarning =
      tenantPolicy !== undefined &&
      tenantProjected * 100 >= tenantPolicy.limitUnits * tenantPolicy.warningPercent;
    const providerWarning =
      providerPolicy !== undefined &&
      providerProjected * 100 >= providerPolicy.limitUnits * providerPolicy.warningPercent;
    const blocked =
      workspacePolicy === undefined ||
      tenantPolicy === undefined ||
      workspaceProjected > workspacePolicy.limitUnits ||
      tenantProjected > tenantPolicy.limitUnits ||
      (providerPolicy !== undefined && providerProjected > providerPolicy.limitUnits);
    const job: JobRecord = {
      id: input.jobId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      providerKey,
      jobType: input.jobType,
      aggregateId: input.aggregateId,
      status: blocked ? 'BUDGET_BLOCKED' : 'QUEUED',
      progress: 0,
      attempt: 0,
      maxAttempts: 3,
      budgetWarning: workspaceWarning || tenantWarning || providerWarning,
      estimatedUnits: input.estimatedUnits,
      heartbeatAt: null,
      result: null,
      errorCode: blocked ? 'BUDGET_LIMIT_REACHED' : null,
    };
    this.jobs.set(job.id, {
      idempotencyKey: input.idempotencyKey,
      job,
      lifecycleEpoch: 0,
      polls: 0,
      processorRun: null,
    });
    if (tenantWarning && tenantPolicy !== undefined) {
      this.recordOwnerAlert({
        tenantId: input.context.tenantId,
        sourceWorkspaceId: input.context.workspaceId,
        jobId: job.id,
        budgetScope: 'TENANT',
        policyId: tenantPolicy.id,
        providerKey: null,
        thresholdPercent: tenantPolicy.warningPercent,
      });
    }
    if (providerWarning && providerPolicy !== undefined) {
      this.recordOwnerAlert({
        tenantId: input.context.tenantId,
        sourceWorkspaceId: input.context.workspaceId,
        jobId: job.id,
        budgetScope: 'PROVIDER',
        policyId: providerPolicy.id,
        providerKey: providerPolicy.providerKey,
        thresholdPercent: providerPolicy.warningPercent,
      });
    }
    this.audit?.append({
      id: input.auditEventId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      actorId: input.context.actorUserId,
      action: blocked ? 'JOB_BUDGET_BLOCKED' : 'JOB_SUBMITTED',
      resourceType: 'JOB',
      resourceId: job.id,
      outcome: blocked ? 'BUDGET_BLOCKED' : 'SUCCEEDED',
      metadata: {
        aggregateId: input.aggregateId,
        estimatedUnits: input.estimatedUnits,
        jobType: input.jobType,
      },
    });
    return Promise.resolve(structuredClone(job));
  }

  async findJob(input: Parameters<JobBudgetStore['findJob']>[0]): Promise<JobRecord | null> {
    const state = this.jobs.get(input.jobId);
    if (!this.inScope(state, input.context.tenantId, input.context.workspaceId)) {
      return null;
    }
    if (state.job.status === 'QUEUED' && state.polls >= 1) {
      state.job.status = 'RUNNING';
      state.job.progress = 50;
      state.job.attempt = 1;
      state.job.heartbeatAt = new Date().toISOString();
    } else if (state.job.status === 'RETRY_WAIT') {
      state.job.status = 'RUNNING';
      state.job.attempt += 1;
      state.job.heartbeatAt = new Date().toISOString();
    } else if (state.job.status === 'RUNNING' && state.polls >= 2) {
      if (state.job.jobType === 'PUBLICATION' || state.job.jobType === 'MEASUREMENT') {
        const processorRun = state.processorRun ?? {
          lifecycleEpoch: state.lifecycleEpoch,
          promise:
            state.job.jobType === 'PUBLICATION'
              ? this.publicationProcessor === undefined
                ? Promise.resolve({
                    status: 'FAILED_TERMINAL' as const,
                    result: null,
                    errorCode: 'PUBLICATION_PIPELINE_UNAVAILABLE',
                  })
                : this.publicationProcessor(structuredClone(state.job))
              : this.measurementProcessor === undefined
                ? Promise.resolve({
                    status: 'FAILED_TERMINAL' as const,
                    result: null,
                    errorCode: 'MEASUREMENT_PIPELINE_UNAVAILABLE',
                  })
                : this.measurementProcessor(structuredClone(state.job)),
        };
        state.processorRun = processorRun;
        let completion: InMemoryPublicationJobCompletion;
        try {
          completion = await processorRun.promise;
        } finally {
          if (state.processorRun === processorRun) state.processorRun = null;
        }
        if (
          processorRun.lifecycleEpoch !== state.lifecycleEpoch ||
          state.job.status !== 'RUNNING' ||
          this.scopeIsFrozen(state.job.tenantId, state.job.workspaceId)
        ) {
          state.polls += 1;
          return structuredClone(state.job);
        }
        state.job.status = completion.status;
        state.job.progress = completion.status === 'SUCCEEDED' ? 100 : state.job.progress;
        state.job.result = completion.result;
        state.job.errorCode = completion.errorCode;
      } else {
        state.job.status = 'SUCCEEDED';
        state.job.progress = 100;
        state.job.result =
          state.job.jobType === 'SITE_CRAWL'
            ? { baselineStatus: 'COMPLETE', pageCount: 1, totalBytes: 256 }
            : state.job.jobType === 'CONTENT_PLAN'
              ? { contentPlanStatus: 'READY', planId: state.job.aggregateId }
              : state.job.jobType === 'ARTIFACT_GENERATION'
                ? { artifactStatus: 'DRAFT', artifactId: state.job.aggregateId, revision: 1 }
                : {
                    readinessPercent: 100,
                    completedFields: 4,
                    totalFields: 4,
                    missingFields: [],
                  };
        await this.onCompleted?.(structuredClone(state.job));
      }
    }
    state.polls += 1;
    return structuredClone(state.job);
  }

  cancelJob(input: Parameters<JobBudgetStore['cancelJob']>[0]): Promise<JobRecord | null> {
    const state = this.jobs.get(input.jobId);
    if (!this.inScope(state, input.context.tenantId, input.context.workspaceId)) {
      return Promise.resolve(null);
    }
    if (
      state.job.jobType === 'PUBLICATION' &&
      (state.job.status === 'RUNNING' || state.job.status === 'RETRY_WAIT')
    ) {
      return Promise.resolve(structuredClone(state.job));
    }
    if (!['SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED'].includes(state.job.status)) {
      state.job.status = 'CANCELLED';
      state.job.errorCode = 'JOB_CANCELLED';
      this.audit?.append({
        id: input.auditEventId,
        tenantId: input.context.tenantId,
        workspaceId: input.context.workspaceId,
        actorId: input.context.actorUserId,
        action: 'JOB_CANCELLED',
        resourceType: 'JOB',
        resourceId: state.job.id,
        outcome: 'SUCCEEDED',
        metadata: { jobType: state.job.jobType },
        occurredAt: this.clock.now(),
      });
    }
    return Promise.resolve(structuredClone(state.job));
  }

  /** Lifecycle freeze is stronger than the user-facing single-job cancellation policy. */
  freezeTenant(tenantId: string): number {
    this.frozenTenants.add(tenantId);
    let frozen = 0;
    for (const state of this.jobs.values()) {
      if (
        state.job.tenantId === tenantId &&
        !['SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED'].includes(state.job.status)
      ) {
        state.lifecycleEpoch += 1;
        state.job.status = 'CANCELLED';
        state.job.errorCode = 'TENANT_LIFECYCLE_FROZEN';
        state.job.heartbeatAt = null;
        state.job.result = null;
        frozen += 1;
      }
    }
    return frozen;
  }

  freezeWorkspace(tenantId: string, workspaceId: string): number {
    this.frozenWorkspaces.add(this.scopeKey(tenantId, workspaceId));
    let frozen = 0;
    for (const state of this.jobs.values()) {
      if (
        state.job.tenantId === tenantId &&
        state.job.workspaceId === workspaceId &&
        !['SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED'].includes(state.job.status)
      ) {
        state.lifecycleEpoch += 1;
        state.job.status = 'CANCELLED';
        state.job.errorCode = 'WORKSPACE_LIFECYCLE_FROZEN';
        state.job.heartbeatAt = null;
        state.job.result = null;
        frozen += 1;
      }
    }
    return frozen;
  }

  isTenantFrozen(tenantId: string): boolean {
    return this.frozenTenants.has(tenantId);
  }

  isWorkspaceFrozen(tenantId: string, workspaceId: string): boolean {
    return this.frozenWorkspaces.has(this.scopeKey(tenantId, workspaceId));
  }

  peekJob(input: Parameters<JobBudgetStore['findJob']>[0]): JobRecord | null {
    const state = this.jobs.get(input.jobId);
    return this.inScope(state, input.context.tenantId, input.context.workspaceId)
      ? structuredClone(state.job)
      : null;
  }

  private scopeKey(tenantId: string, workspaceId: string): string {
    return `${tenantId}:${workspaceId}`;
  }

  private providerPolicyKey(tenantId: string, providerKey: string): string {
    return `${tenantId}:${providerKey}`;
  }

  private rememberTenantOwner(tenantId: string, userId: string): void {
    const owners = this.tenantOwners.get(tenantId) ?? new Set<string>();
    owners.add(userId);
    this.tenantOwners.set(tenantId, owners);
  }

  private recordOwnerAlert(
    input: Omit<BudgetAlertRecord, 'id' | 'audience' | 'recipientUserId' | 'createdAt'>,
  ): void {
    for (const recipientUserId of this.tenantOwners.get(input.tenantId) ?? []) {
      const deduplicationKey = [
        input.tenantId,
        input.budgetScope,
        input.policyId,
        input.thresholdPercent,
        recipientUserId,
      ].join(':');
      if (this.budgetAlerts.has(deduplicationKey)) continue;
      this.budgetAlerts.set(deduplicationKey, {
        ...input,
        id: randomUUID(),
        audience: 'TENANT_OWNER',
        recipientUserId,
        createdAt: this.clock.now().toISOString(),
      });
    }
  }

  private scopeIsFrozen(tenantId: string, workspaceId: string): boolean {
    return (
      this.frozenTenants.has(tenantId) ||
      this.frozenWorkspaces.has(this.scopeKey(tenantId, workspaceId))
    );
  }

  private inScope(
    state: JobState | undefined,
    tenantId: string,
    workspaceId: string,
  ): state is JobState {
    return (
      state !== undefined &&
      state.job.tenantId === tenantId &&
      state.job.workspaceId === workspaceId
    );
  }
}
