import type {
  MeasurementApprovedSource,
  MeasurementDashboardSource,
  MeasurementExecutionPlan,
  MeasurementProviderPolicyRecord,
  MeasurementRunRecord,
  MeasurementStore,
  PromptRunRecord,
  RawMeasurementEvidenceReference,
  StoredMetricObservation,
  StoredMetricSnapshot,
} from '@aeostudio/application/measurement';
import type { TenantContext } from '@aeostudio/application/identity-access';
import type { JsonValue, TenantExportSourceObject } from '@aeostudio/application/privacy-audit';

import type { InMemoryTenantExportSource } from '../privacy/in-memory-tenant-export-source.js';

interface MeasurementState {
  context: TenantContext;
  idempotencyKey: string;
  requestIdentity: MeasurementRequestIdentity;
  run: MeasurementRunRecord;
  prompts: MeasurementApprovedSource['prompts'];
  scopes: MeasurementApprovedSource['scenarioSnapshot']['scopes'];
  promptRuns: Map<string, PromptRunRecord>;
  evidence: Map<string, RawMeasurementEvidenceReference | null>;
  observations: Map<string, StoredMetricObservation>;
  snapshots: StoredMetricSnapshot[];
}

interface MeasurementRequestIdentity {
  promptSetId: string;
  promptRevisionId: string;
  promptContentHash: string;
  scenarioId: string;
  scenarioContentHash: string;
  manualImportId: string | null;
  manualImportContentHash: string | null;
  kind: 'BASELINE' | 'REMEASUREMENT';
}

const FIXTURE_POLICY_ID = '00000000-0000-7000-8000-000000001515';
const FIXTURE_POLICY_ACTOR_ID = '00000000-0000-7000-8000-000000001516';

/** Process-memory persistence used only behind the explicit fake-runtime gate. */
export class InMemoryMeasurementStore implements MeasurementStore, InMemoryTenantExportSource {
  private readonly states = new Map<string, MeasurementState>();
  private readonly policies = new Map<string, MeasurementProviderPolicyRecord>();

  prepareRun(input: Parameters<MeasurementStore['prepareRun']>[0]) {
    const existing = [...this.states.values()].find(
      (state) =>
        this.inScope(state, input.context) && state.idempotencyKey === input.idempotencyKey,
    );
    const requestIdentity = measurementRequestIdentity(input.approvedSource, input.kind);
    if (existing !== undefined) {
      return Promise.resolve(
        measurementRequestIdentityMatches(existing.requestIdentity, requestIdentity)
          ? this.clone(existing.run)
          : null,
      );
    }

    const scenario = input.approvedSource.scenarioSnapshot;
    const run = {
      id: input.measurementRunId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      promptRevisionId: input.approvedSource.promptRevisionId,
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      jobId: null,
      kind: input.kind,
      status: 'QUEUED',
      expectedPromptRunCount: input.approvedSource.expectedPromptRunCount,
      completedPromptRunCount: 0,
      providerKey: scenario.providerKey,
      surfaceKey: scenario.surfaceKey,
      model: scenario.model,
      modelVersion: scenario.modelVersion,
      acquisitionClass: scenario.acquisitionClass,
      acquisitionMethod: scenario.acquisitionMethod,
      adapterVersion: input.approvedSource.adapterVersion,
      scenarioSnapshot: this.clone(scenario),
      createdAt: input.createdAt.toISOString(),
      startedAt: null,
      completedAt: null,
    } satisfies MeasurementRunRecord;
    this.states.set(run.id, {
      context: this.clone(input.context),
      idempotencyKey: input.idempotencyKey,
      requestIdentity,
      run,
      prompts: this.clone(input.approvedSource.prompts),
      scopes: this.clone(scenario.scopes),
      promptRuns: new Map(),
      evidence: new Map(),
      observations: new Map(),
      snapshots: [],
    });
    return Promise.resolve(this.clone(run));
  }

  bindJob(input: Parameters<MeasurementStore['bindJob']>[0]) {
    const state = this.scopedState(input.context, input.measurementRunId);
    if (state === null) return Promise.resolve(null);
    if (state.run.jobId !== null && state.run.jobId !== input.jobId) return Promise.resolve(null);
    state.run.jobId = input.jobId;
    return Promise.resolve(this.clone(state.run));
  }

  setProviderPolicy(input: Parameters<MeasurementStore['setProviderPolicy']>[0]) {
    const policy: MeasurementProviderPolicyRecord = {
      id: input.policyId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      providerKey: input.providerKey,
      surfaceKey: input.surfaceKey,
      adapterVersion: input.adapterVersion,
      termsVersion: input.termsVersion,
      termsApproved: input.termsApproved,
      authorizationApproved: input.authorizationApproved,
      crossBorderApproved: input.crossBorderApproved,
      purpose: input.purpose,
      policyVersion: input.policyVersion,
      approvedByUserId: input.context.actorUserId,
      approvedAt: input.approvedAt.toISOString(),
    };
    this.policies.set(this.policyKey(input.context, input.providerKey, input.surfaceKey), policy);
    return Promise.resolve(this.clone(policy));
  }

  findProviderPolicy(input: Parameters<MeasurementStore['findProviderPolicy']>[0]) {
    const explicit = this.policies.get(
      this.policyKey(input.context, input.providerKey, input.surfaceKey),
    );
    if (explicit !== undefined) return Promise.resolve(this.clone(explicit));
    if (
      input.providerKey !== 'fixture-provider' ||
      input.surfaceKey !== 'consumer-answer-sandbox'
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      id: FIXTURE_POLICY_ID,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      providerKey: input.providerKey,
      surfaceKey: input.surfaceKey,
      adapterVersion: 'fixture-v1',
      termsVersion: 'fixture-terms-2026-07',
      termsApproved: true,
      authorizationApproved: true,
      crossBorderApproved: true,
      purpose: 'Explicit fake-runtime recorded measurement fixture.',
      policyVersion: 'fake-runtime-policy-v1',
      approvedByUserId: FIXTURE_POLICY_ACTOR_ID,
      approvedAt: '2026-07-20T00:00:00.000Z',
    });
  }

  findRun(input: Parameters<MeasurementStore['findRun']>[0]) {
    const state = this.scopedState(input.context, input.measurementRunId);
    return Promise.resolve(state === null ? null : this.clone(state.run));
  }

  listPromptRuns(input: Parameters<MeasurementStore['listPromptRuns']>[0]) {
    const state = this.scopedState(input.context, input.measurementRunId);
    if (state === null) return Promise.resolve(null);
    const promptRuns = [...state.promptRuns.values()]
      .filter((run) => input.scopeKey === undefined || run.scopeKey === input.scopeKey)
      .filter((run) => {
        if (input.dimension === undefined || input.dimension === 'COST') return true;
        if (input.dimension === 'ERROR') return run.status === 'ERROR';
        return [...state.observations.values()].some(
          (observation) =>
            observation.promptRunId === run.id && observation.metricKey === input.dimension,
        );
      })
      .sort(
        (left, right) =>
          left.promptOrdinal - right.promptOrdinal ||
          left.scopeKey.localeCompare(right.scopeKey) ||
          left.repetition - right.repetition ||
          left.id.localeCompare(right.id),
      );
    return Promise.resolve({
      promptRuns: this.clone(promptRuns.slice(input.offset, input.offset + input.limit)),
      total: promptRuns.length,
    });
  }

  findPromptRun(input: Parameters<MeasurementStore['findPromptRun']>[0]) {
    const state = this.scopedState(input.context, input.measurementRunId);
    const promptRun = state?.promptRuns.get(input.promptRunId);
    if (state === null || promptRun === undefined) return Promise.resolve(null);
    return Promise.resolve({
      promptRun: this.clone(promptRun),
      rawEvidenceRef: this.clone(state.evidence.get(input.promptRunId) ?? null),
    });
  }

  loadDashboard(input: Parameters<MeasurementStore['loadDashboard']>[0]) {
    const state = this.scopedState(input.context, input.measurementRunId);
    if (state === null) return Promise.resolve(null);
    const source: MeasurementDashboardSource = {
      run: this.clone(state.run),
      promptRuns: this.clone([...state.promptRuns.values()]),
      snapshots: this.clone(state.snapshots),
    };
    return Promise.resolve(source);
  }

  loadExecutionPlan(input: Parameters<MeasurementStore['loadExecutionPlan']>[0]) {
    const state = this.scopedState(input.context, input.measurementRunId);
    if (state === null) return Promise.resolve(null);
    const storedPolicy = this.policies.get(
      this.policyKey(state.context, state.run.providerKey, state.run.surfaceKey),
    );
    const plan: MeasurementExecutionPlan = {
      run: this.clone(state.run),
      prompts: this.clone(state.prompts),
      scopes: this.clone(state.scopes),
      policy: this.clone(storedPolicy ?? this.fixturePolicy(state)),
      completedSlots: this.clone(
        [...state.promptRuns.values()].map((promptRun) => ({
          promptRun,
          observations: [...state.observations.values()].filter(
            (observation) => observation.promptRunId === promptRun.id,
          ),
        })),
      ),
      snapshotCount: state.snapshots.length,
    };
    return Promise.resolve(plan);
  }

  markRunning(input: Parameters<MeasurementStore['markRunning']>[0]) {
    const state = this.scopedState(input.context, input.measurementRunId);
    if (state === null || !['QUEUED', 'RUNNING'].includes(state.run.status)) {
      return Promise.resolve('CONFLICT' as const);
    }
    state.run.status = 'RUNNING';
    state.run.startedAt ??= input.startedAt.toISOString();
    return Promise.resolve('SUCCEEDED' as const);
  }

  recordPromptRun(input: Parameters<MeasurementStore['recordPromptRun']>[0]) {
    const state = this.scopedState(input.context, input.promptRun.measurementRunId);
    if (state === null || state.run.status !== 'RUNNING') {
      return Promise.resolve('CONFLICT' as const);
    }
    if (
      input.promptRun.measurementRunId !== state.run.id ||
      state.promptRuns.has(input.promptRun.id)
    ) {
      return Promise.resolve('CONFLICT' as const);
    }
    const observationIds = new Set(input.observations.map((observation) => observation.id));
    if (
      observationIds.size !== input.observations.length ||
      input.observations.some(
        (observation) =>
          observation.promptRunId !== input.promptRun.id || state.observations.has(observation.id),
      )
    ) {
      return Promise.resolve('CONFLICT' as const);
    }
    state.promptRuns.set(input.promptRun.id, this.clone(input.promptRun));
    state.evidence.set(input.promptRun.id, this.clone(input.rawEvidenceRef));
    for (const observation of input.observations) {
      state.observations.set(observation.id, this.clone(observation));
    }
    state.run.completedPromptRunCount = state.promptRuns.size;
    return Promise.resolve('SUCCEEDED' as const);
  }

  completeRun(input: Parameters<MeasurementStore['completeRun']>[0]) {
    const state = this.scopedState(input.context, input.measurementRunId);
    if (state === null || state.run.status !== 'RUNNING') {
      return Promise.resolve({ outcome: 'CONFLICT' as const });
    }
    state.snapshots = this.clone(input.snapshots);
    state.run.completedPromptRunCount = state.promptRuns.size;
    state.run.status =
      state.promptRuns.size === state.run.expectedPromptRunCount ? 'COMPLETED' : 'PARTIAL';
    state.run.completedAt = input.completedAt.toISOString();
    return Promise.resolve({
      outcome: 'SUCCEEDED' as const,
      measurementRun: this.clone(state.run),
    });
  }

  /** Explicit fake-runtime projection used by the Experiment candidate registry. */
  listCompletedForExperiment(context: TenantContext): MeasurementDashboardSource[] {
    return [...this.states.values()]
      .filter((state) => this.inScope(state, context) && state.run.status === 'COMPLETED')
      .sort((left, right) => right.run.createdAt.localeCompare(left.run.createdAt))
      .map((state) => ({
        run: this.clone(state.run),
        promptRuns: this.clone([...state.promptRuns.values()]),
        snapshots: this.clone(state.snapshots),
      }));
  }

  listTenantExportObjects(input: {
    tenantId: string;
    from: Date;
    to: Date;
  }): Promise<TenantExportSourceObject[]> {
    const from = input.from.getTime();
    const to = input.to.getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      return Promise.reject(new Error('INVALID_TENANT_EXPORT_RANGE'));
    }
    const objects: TenantExportSourceObject[] = [];
    for (const state of this.states.values()) {
      if (state.run.tenantId !== input.tenantId) continue;
      const runOccurredAt = Date.parse(state.run.createdAt);
      if (runOccurredAt >= from && runOccurredAt <= to) {
        objects.push({
          tenantId: state.run.tenantId,
          workspaceId: state.run.workspaceId,
          kind: 'MEASUREMENT_RUN',
          objectId: state.run.id,
          occurredAt: state.run.createdAt,
          payload: toJsonValue(state.run),
        });
      }
      const snapshotOccurredAt = state.run.completedAt ?? state.run.createdAt;
      const snapshotOccurredAtMs = Date.parse(snapshotOccurredAt);
      if (snapshotOccurredAtMs < from || snapshotOccurredAtMs > to) continue;
      for (const snapshot of state.snapshots) {
        objects.push({
          tenantId: state.run.tenantId,
          workspaceId: state.run.workspaceId,
          kind: 'METRIC_SNAPSHOT',
          objectId: snapshot.id,
          occurredAt: snapshotOccurredAt,
          payload: toJsonValue(snapshot),
        });
      }
    }
    objects.sort((left, right) =>
      `${left.kind}:${left.objectId}`.localeCompare(`${right.kind}:${right.objectId}`),
    );
    return Promise.resolve(objects);
  }

  private fixturePolicy(state: MeasurementState): MeasurementProviderPolicyRecord | null {
    if (
      state.run.providerKey !== 'fixture-provider' ||
      state.run.surfaceKey !== 'consumer-answer-sandbox' ||
      state.run.adapterVersion !== 'fixture-v1'
    ) {
      return null;
    }
    return {
      id: FIXTURE_POLICY_ID,
      tenantId: state.run.tenantId,
      workspaceId: state.run.workspaceId,
      providerKey: state.run.providerKey,
      surfaceKey: state.run.surfaceKey,
      adapterVersion: state.run.adapterVersion,
      termsVersion: 'fixture-terms-2026-07',
      termsApproved: true,
      authorizationApproved: true,
      crossBorderApproved: true,
      purpose: 'Explicit fake-runtime recorded measurement fixture.',
      policyVersion: 'fake-runtime-policy-v1',
      approvedByUserId: FIXTURE_POLICY_ACTOR_ID,
      approvedAt: state.run.createdAt,
    };
  }

  private scopedState(context: TenantContext, measurementRunId: string): MeasurementState | null {
    const state = this.states.get(measurementRunId);
    return state !== undefined && this.inScope(state, context) ? state : null;
  }

  private inScope(state: MeasurementState, context: TenantContext): boolean {
    return (
      state.context.tenantId === context.tenantId &&
      state.context.workspaceId === context.workspaceId
    );
  }

  private policyKey(context: TenantContext, providerKey: string, surfaceKey: string): string {
    return `${context.tenantId}:${context.workspaceId}:${providerKey}:${surfaceKey}`;
  }

  private clone<T>(value: T): T {
    return structuredClone(value);
  }
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function measurementRequestIdentity(
  source: MeasurementApprovedSource,
  kind: 'BASELINE' | 'REMEASUREMENT',
): MeasurementRequestIdentity {
  return {
    promptSetId: source.promptSetId,
    promptRevisionId: source.promptRevisionId,
    promptContentHash: source.promptContentHash,
    scenarioId: source.scenarioSnapshot.id,
    scenarioContentHash: source.scenarioContentHash,
    manualImportId: source.scenarioSnapshot.manualImport?.id ?? null,
    manualImportContentHash: source.scenarioSnapshot.manualImport?.contentHash ?? null,
    kind,
  };
}

function measurementRequestIdentityMatches(
  stored: MeasurementRequestIdentity,
  requested: MeasurementRequestIdentity,
): boolean {
  return (
    stored.promptSetId === requested.promptSetId &&
    stored.promptRevisionId === requested.promptRevisionId &&
    stored.promptContentHash === requested.promptContentHash &&
    stored.scenarioId === requested.scenarioId &&
    stored.scenarioContentHash === requested.scenarioContentHash &&
    stored.manualImportId === requested.manualImportId &&
    stored.manualImportContentHash === requested.manualImportContentHash &&
    stored.kind === requested.kind
  );
}
