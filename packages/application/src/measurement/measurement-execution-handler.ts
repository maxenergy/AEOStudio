import { createHash } from 'node:crypto';

import type {
  MeasurementPersistenceLease,
  MeasurementRawEvidenceStore,
  MeasurementStore,
} from './ports.js';
import type {
  MeasurementSurfaceAdapterDescriptor,
  MeasurementSurfaceAdapterRegistry,
  MeasurementSurfaceExecutionCommand,
  MeasurementSurfaceExecutionResult,
  MeasurementProviderPolicyRecord,
  MeasurementRunRecord,
  PromptRunRecord,
  StoredMetricObservation,
  StoredMetricSnapshot,
} from './types.js';
import type { TenantContext } from '../identity-access/index.js';
import type { JobRecord } from '@aeostudio/domain/jobs-budgets';
import {
  buildMetricSnapshot,
  type MetricClassification,
  type MetricCohort,
} from '@aeostudio/domain/measurement';
import { measurementScopeKey } from './measurement-scope-key.js';
import { REVIEWED_MANUAL_IMPORT_ADAPTER_KEY } from './manual-measurement-import.js';

const METRIC_KEYS = ['MENTION_RATE', 'CITATION_RATE', 'ACCURACY_RATE', 'COVERAGE_RATE'] as const;

export type MeasurementExecutionHandlerOutcome =
  | {
      outcome: 'SUCCEEDED';
      measurementRunId: string;
      actualUnits: number;
      snapshotCount: number;
      providerFailureCount: number;
    }
  | { outcome: 'NOT_FOUND' | 'INVALID_REFERENCE' | 'RETRYABLE_CONFLICT' | 'LEASE_LOST' };

export interface MeasurementExecutionControl {
  signal?: AbortSignal;
  /** Database persistence fence owned by the Worker that claimed this Job. */
  lease?: MeasurementPersistenceLease;
  /** Fences every external Adapter call and its subsequent persistence against the active lease. */
  leaseGuard?: () => Promise<boolean>;
}

export class MeasurementExecutionHandler {
  constructor(
    private readonly store: MeasurementStore,
    private readonly rawEvidence: MeasurementRawEvidenceStore,
    private readonly adapters: MeasurementSurfaceAdapterRegistry,
    private readonly ids: { next(): string },
    private readonly clock: { now(): Date },
    private readonly versions: {
      observationMethodVersion: string;
      snapshotMethodVersion: string;
    },
    private readonly execution: { adapterTimeoutMs: number } = { adapterTimeoutMs: 30_000 },
  ) {}

  async run(
    job: JobRecord,
    control: MeasurementExecutionControl = {},
  ): Promise<MeasurementExecutionHandlerOutcome> {
    if (control.lease !== undefined && control.lease.jobId !== job.id) {
      return { outcome: 'LEASE_LOST' };
    }
    const persistenceLease = control.lease ?? null;
    const context: TenantContext = {
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
      actorUserId: job.id,
      membershipId: job.id,
      role: 'OWNER',
    };
    const plan = await this.store.loadExecutionPlan({
      context,
      measurementRunId: job.aggregateId,
    });
    if (plan === null || plan.run.jobId !== job.id) return { outcome: 'NOT_FOUND' };
    const completedSlots = plan.completedSlots ?? [];
    if (plan.run.status === 'COMPLETED') {
      return {
        outcome: 'SUCCEEDED',
        measurementRunId: plan.run.id,
        actualUnits: completedSlots.filter((slot) => slot.promptRun.policyReason === null).length,
        snapshotCount: plan.snapshotCount ?? plan.run.scenarioSnapshot.scopes.length * 4,
        providerFailureCount: completedSlots.filter((slot) => slot.promptRun.status === 'ERROR')
          .length,
      };
    }
    if (plan.run.status !== 'QUEUED' && plan.run.status !== 'RUNNING') {
      return { outcome: 'INVALID_REFERENCE' };
    }
    if (plan.run.status === 'QUEUED') {
      const markedRunning = await this.store.markRunning({
        context,
        measurementRunId: plan.run.id,
        startedAt: this.clock.now(),
        lease: persistenceLease,
      });
      if (markedRunning === 'LEASE_LOST') return { outcome: 'LEASE_LOST' };
      if (markedRunning === 'CONFLICT') {
        return { outcome: 'INVALID_REFERENCE' };
      }
    }

    const adapter = this.adapters.resolve(
      plan.run.providerKey,
      plan.run.surfaceKey,
      plan.run.adapterVersion,
    );
    const described = safeDescriptor(adapter, plan.run);
    const descriptor = described.descriptor;
    const adapterMatches = described.valid && descriptorMatchesRun(descriptor, plan.run);
    const reviewedManualImportAllowed =
      plan.run.scenarioSnapshot.registryStatus === 'UNAVAILABLE' &&
      plan.run.acquisitionClass === 'MANUAL_IMPORT' &&
      plan.run.acquisitionMethod === 'MANUAL_IMPORT' &&
      plan.run.scenarioSnapshot.manualImport !== null &&
      descriptor.adapterKey === REVIEWED_MANUAL_IMPORT_ADAPTER_KEY;
    const staticPolicyReason =
      plan.run.scenarioSnapshot.registryStatus === 'UNAVAILABLE' && !reviewedManualImportAllowed
        ? 'SURFACE_UNAVAILABLE'
        : adapter === null
          ? 'ADAPTER_NOT_AVAILABLE'
          : !adapterMatches
            ? 'ADAPTER_RUNTIME_METADATA_MISMATCH'
            : null;
    let actualUnits = completedSlots.filter((slot) => slot.promptRun.policyReason === null).length;
    let providerFailureCount = completedSlots.filter(
      (slot) => slot.promptRun.status === 'ERROR',
    ).length;
    const observationsByCohortMetric = new Map<string, StoredMetricObservation[]>();
    const completedSlotKeys = new Set<string>();
    for (const slot of completedSlots) {
      completedSlotKeys.add(
        slotKey(slot.promptRun.promptId, slot.promptRun.scopeKey, slot.promptRun.repetition),
      );
      for (const observation of slot.observations) {
        const key = cohortMetricKey(slot.promptRun.scopeKey, observation.metricKey);
        const grouped = observationsByCohortMetric.get(key) ?? [];
        grouped.push(observation);
        observationsByCohortMetric.set(key, grouped);
      }
    }

    for (const scope of plan.scopes) {
      const cohort: MetricCohort = {
        scenarioId: plan.run.scenarioId,
        scenarioVersion: plan.run.scenarioVersion,
        providerKey: plan.run.providerKey,
        surfaceKey: plan.run.surfaceKey,
        acquisitionClass: plan.run.acquisitionClass,
        acquisitionMethod: plan.run.acquisitionMethod,
        adapterKey: descriptor.adapterKey,
        adapterVersion: descriptor.adapterVersion,
        model: plan.run.model,
        modelVersion: plan.run.modelVersion,
        scope: structuredClone(scope),
        parameters: structuredClone(plan.run.scenarioSnapshot.parameters),
      };
      for (const prompt of plan.prompts) {
        for (
          let repetition = 1;
          repetition <= plan.run.scenarioSnapshot.repetitions;
          repetition += 1
        ) {
          const currentScopeKey = measurementScopeKey(scope);
          if (completedSlotKeys.has(slotKey(prompt.id, currentScopeKey, repetition))) continue;
          const promptRunId = this.ids.next();
          if (control.signal?.aborted) return { outcome: 'LEASE_LOST' };
          let result: MeasurementSurfaceExecutionResult;
          let policyReason = staticPolicyReason;
          let policyApproved = false;
          if (adapter !== null && staticPolicyReason === null) {
            if (!(await leaseAllowsExternalWork(control))) return { outcome: 'LEASE_LOST' };
            policyApproved = await currentPolicyAllows(
              this.store,
              context,
              plan.run.providerKey,
              plan.run.surfaceKey,
              descriptor,
            );
            if (policyApproved) {
              if (!(await leaseAllowsExternalWork(control))) return { outcome: 'LEASE_LOST' };
              const executed = await this.executeSafely(
                adapter,
                descriptor,
                {
                  measurementRunId: plan.run.id,
                  tenantId: plan.run.tenantId,
                  workspaceId: plan.run.workspaceId,
                  scenario: plan.run.scenarioSnapshot,
                  prompt,
                  scope,
                  repetition,
                },
                measurementSlotIdempotencyKey(plan.run.id, prompt.id, currentScopeKey, repetition),
                control.signal,
              );
              if (executed.outcome === 'LEASE_LOST') return { outcome: 'LEASE_LOST' };
              if (!(await leaseAllowsExternalWork(control))) return { outcome: 'LEASE_LOST' };
              result = executed.result;
            } else {
              policyReason = 'PROVIDER_POLICY_NOT_APPROVED';
              result = notCheckedResult(
                plan.run,
                descriptor,
                this.versions.observationMethodVersion,
                policyReason,
                this.clock.now(),
              );
            }
          } else {
            result = notCheckedResult(
              plan.run,
              descriptor,
              this.versions.observationMethodVersion,
              policyReason ?? 'PROVIDER_POLICY_NOT_APPROVED',
              this.clock.now(),
            );
          }
          if (policyApproved) actualUnits += 1;
          const normalized = normalizeResult(
            result,
            plan.run,
            descriptor,
            this.versions.observationMethodVersion,
            this.clock.now(),
          );
          if (normalized.status === 'ERROR') providerFailureCount += 1;
          if (!(await leaseAllowsExternalWork(control))) return { outcome: 'LEASE_LOST' };
          const rawEvidenceWrite = await this.rawEvidence.put({
            tenantId: plan.run.tenantId,
            workspaceId: plan.run.workspaceId,
            measurementRunId: plan.run.id,
            promptRunId,
            payload: normalized.rawEvidence,
            lease: persistenceLease,
          });
          if (rawEvidenceWrite.outcome === 'LEASE_LOST') return { outcome: 'LEASE_LOST' };
          const rawEvidenceRef = rawEvidenceWrite.reference;
          const promptRun: PromptRunRecord = {
            id: promptRunId,
            measurementRunId: plan.run.id,
            promptId: prompt.id,
            promptOrdinal: prompt.ordinal,
            repetition,
            scopeKey: currentScopeKey,
            status: normalized.status,
            providerKey: plan.run.providerKey,
            surfaceKey: plan.run.surfaceKey,
            model: plan.run.model,
            modelVersion: plan.run.modelVersion,
            scenarioId: plan.run.scenarioId,
            scenarioVersion: plan.run.scenarioVersion,
            acquisitionClass: plan.run.acquisitionClass,
            acquisitionMethod: plan.run.acquisitionMethod,
            adapterKey: descriptor.adapterKey,
            adapterVersion: descriptor.adapterVersion,
            methodVersion: normalized.methodVersion,
            observation: normalized.observation,
            cost: normalized.cost,
            policyReason,
            observedAt: normalized.observedAt,
          };
          const observations = METRIC_KEYS.map((metricKey) => ({
            id: this.ids.next(),
            promptRunId,
            metricKey,
            classification: classifyMetric(promptRun, metricKey),
            cohort,
          }));
          const recorded = await this.store.recordPromptRun({
            context,
            promptRun,
            rawEvidenceRef,
            observations,
            lease: persistenceLease,
          });
          if (recorded === 'LEASE_LOST') return { outcome: 'LEASE_LOST' };
          if (recorded === 'CONFLICT') return { outcome: 'RETRYABLE_CONFLICT' };
          for (const observation of observations) {
            const key = cohortMetricKey(promptRun.scopeKey, observation.metricKey);
            const grouped = observationsByCohortMetric.get(key) ?? [];
            grouped.push(observation);
            observationsByCohortMetric.set(key, grouped);
          }
        }
      }
    }

    const snapshots: StoredMetricSnapshot[] = [];
    for (const observations of observationsByCohortMetric.values()) {
      const first = observations[0];
      if (first === undefined) continue;
      const reduced = buildMetricSnapshot({
        metricKey: first.metricKey,
        methodVersion: this.versions.snapshotMethodVersion,
        observations,
      });
      snapshots.push({
        id: this.ids.next(),
        measurementRunId: plan.run.id,
        metricKey: first.metricKey,
        methodVersion: reduced.methodVersion,
        cohort: reduced.cohort,
        numerator: reduced.numerator,
        eligibleDenominator: reduced.eligibleDenominator,
        value: reduced.value,
        excludedCounts: reduced.excludedCounts,
        sourceObservationIds: reduced.sourceObservationIds,
        sourceHash: reduced.sourceHash,
        contentHash: reduced.contentHash,
      });
    }
    const completed = await this.store.completeRun({
      context,
      measurementRunId: plan.run.id,
      snapshots,
      completedAt: this.clock.now(),
      auditEventId: this.ids.next(),
      lease: persistenceLease,
    });
    if (completed.outcome === 'LEASE_LOST') return { outcome: 'LEASE_LOST' };
    return completed.outcome === 'CONFLICT'
      ? { outcome: 'RETRYABLE_CONFLICT' }
      : {
          outcome: 'SUCCEEDED',
          measurementRunId: plan.run.id,
          actualUnits,
          snapshotCount: snapshots.length,
          providerFailureCount,
        };
  }

  private async executeSafely(
    adapter: NonNullable<ReturnType<MeasurementSurfaceAdapterRegistry['resolve']>>,
    descriptor: MeasurementSurfaceAdapterDescriptor,
    command: Omit<MeasurementSurfaceExecutionCommand, 'idempotencyKey' | 'signal'>,
    idempotencyKey: string,
    parentSignal: AbortSignal | undefined,
  ): Promise<
    { outcome: 'RESULT'; result: MeasurementSurfaceExecutionResult } | { outcome: 'LEASE_LOST' }
  > {
    if (parentSignal?.aborted) return { outcome: 'LEASE_LOST' };
    const controller = new AbortController();
    let deadlineExceeded = false;
    const onParentAbort = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    const timeoutMs = Math.min(Math.max(this.execution.adapterTimeoutMs, 1), 300_000);
    const timeout = setTimeout(() => {
      deadlineExceeded = true;
      controller.abort(new Error('MEASUREMENT_ADAPTER_TIMEOUT'));
    }, timeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () =>
          reject(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new Error('MEASUREMENT_ADAPTER_ABORTED'),
          ),
        { once: true },
      );
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() =>
          adapter.executeScenario({
            ...command,
            idempotencyKey,
            signal: controller.signal,
          }),
        ),
        aborted,
      ]);
      return { outcome: 'RESULT', result };
    } catch {
      if (parentSignal?.aborted && !deadlineExceeded) return { outcome: 'LEASE_LOST' };
      return {
        outcome: 'RESULT',
        result: adapterFailureResult(
          descriptor,
          this.versions.observationMethodVersion,
          this.clock.now(),
          deadlineExceeded,
        ),
      };
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
  }
}

async function leaseAllowsExternalWork(control: MeasurementExecutionControl): Promise<boolean> {
  if (control.signal?.aborted) return false;
  if (control.leaseGuard === undefined) return true;
  try {
    return (await control.leaseGuard()) && control.signal?.aborted !== true;
  } catch {
    return false;
  }
}

function measurementSlotIdempotencyKey(
  measurementRunId: string,
  promptId: string,
  scopeKey: string,
  repetition: number,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([measurementRunId, promptId, scopeKey, repetition]), 'utf8')
    .digest('hex');
  return `measurement-slot:${digest}`;
}

function adapterFailureResult(
  descriptor: MeasurementSurfaceAdapterDescriptor,
  methodVersion: string,
  observedAt: Date,
  deadlineExceeded: boolean,
): MeasurementSurfaceExecutionResult {
  return {
    providerKey: descriptor.providerKey,
    surfaceKey: descriptor.surfaceKey,
    acquisitionMethod: descriptor.acquisitionMethod,
    adapterVersion: descriptor.adapterVersion,
    methodVersion,
    observedAt: observedAt.toISOString(),
    status: 'ERROR',
    observation: { mention: null, citation: null, accuracy: null, coverage: null },
    cost: { amount: '0.000000', currency: 'USD' },
    rawEvidence: {
      responseText: null,
      citations: [],
      error: deadlineExceeded
        ? {
            code: 'MEASUREMENT_ADAPTER_TIMEOUT',
            message: 'The approved measurement Adapter exceeded its execution deadline.',
          }
        : {
            code: 'MEASUREMENT_ADAPTER_EXECUTION_ERROR',
            message: 'The approved measurement Adapter execution failed.',
          },
    },
  };
}

function classifyMetric(
  run: PromptRunRecord,
  metricKey: StoredMetricObservation['metricKey'],
): MetricClassification {
  if (
    run.status === 'ERROR' ||
    run.status === 'NOT_CHECKED' ||
    run.status === 'INCONCLUSIVE' ||
    run.status === 'NOT_APPLICABLE'
  ) {
    return run.status;
  }
  if (metricKey === 'ACCURACY_RATE') {
    if (run.observation.accuracy === 'MATCH') return 'PASS';
    if (run.observation.accuracy === 'MISMATCH') return 'MISMATCH';
    return 'NOT_APPLICABLE';
  }
  const value =
    metricKey === 'MENTION_RATE'
      ? run.observation.mention
      : metricKey === 'CITATION_RATE'
        ? run.observation.citation
        : run.observation.coverage;
  return value === true ? 'PASS' : value === false ? 'FAIL' : 'INCONCLUSIVE';
}

function policyAllows(
  policy: MeasurementProviderPolicyRecord | null,
  descriptor: MeasurementSurfaceAdapterDescriptor,
): boolean {
  return (
    policy !== null &&
    policy.providerKey === descriptor.providerKey &&
    policy.surfaceKey === descriptor.surfaceKey &&
    policy.adapterVersion === descriptor.adapterVersion &&
    policy.termsVersion === descriptor.termsVersion &&
    policy.termsApproved &&
    policy.authorizationApproved &&
    policy.crossBorderApproved
  );
}

async function currentPolicyAllows(
  store: MeasurementStore,
  context: TenantContext,
  providerKey: string,
  surfaceKey: string,
  descriptor: MeasurementSurfaceAdapterDescriptor,
): Promise<boolean> {
  const policy = await store.findProviderPolicy({ context, providerKey, surfaceKey });
  return policyAllows(policy, descriptor);
}

function descriptorMatchesRun(
  descriptor: MeasurementSurfaceAdapterDescriptor,
  run: MeasurementRunRecord,
): boolean {
  return (
    descriptor.providerKey === run.providerKey &&
    descriptor.surfaceKey === run.surfaceKey &&
    descriptor.adapterVersion === run.adapterVersion &&
    descriptor.acquisitionClass === run.acquisitionClass &&
    descriptor.acquisitionMethod === run.acquisitionMethod
  );
}

function safeDescriptor(
  adapter: ReturnType<MeasurementSurfaceAdapterRegistry['resolve']>,
  run: MeasurementRunRecord,
): { descriptor: MeasurementSurfaceAdapterDescriptor; valid: boolean } {
  if (adapter === null) return { descriptor: unavailableDescriptor(run), valid: false };
  try {
    const descriptor = adapter.describe();
    const valid =
      isValidDescriptor(descriptor) &&
      descriptor.adapterKey === adapter.adapterKey &&
      descriptor.adapterVersion === adapter.adapterVersion;
    return { descriptor: valid ? descriptor : unavailableDescriptor(run), valid };
  } catch {
    return { descriptor: unavailableDescriptor(run), valid: false };
  }
}

function unavailableDescriptor(run: MeasurementRunRecord): MeasurementSurfaceAdapterDescriptor {
  return {
    adapterKey: 'unavailable-adapter',
    adapterVersion: run.adapterVersion,
    providerKey: run.providerKey,
    surfaceKey: run.surfaceKey,
    surfaceKind: 'CONSUMER_AI_ANSWER',
    acquisitionClass: run.acquisitionClass,
    acquisitionMethod: run.acquisitionMethod,
    termsVersion: 'unavailable',
    processingRegion: 'unavailable',
    storageRegion: 'unavailable',
    retentionPolicy: 'No payload sent.',
    trainingPolicy: 'No payload sent.',
    subprocessors: [],
    requiresAuthorization: true,
  };
}

function notCheckedResult(
  run: MeasurementRunRecord,
  descriptor: MeasurementSurfaceAdapterDescriptor,
  methodVersion: string,
  policyReason: string,
  observedAt: Date,
): MeasurementSurfaceExecutionResult {
  return {
    providerKey: run.providerKey,
    surfaceKey: run.surfaceKey,
    acquisitionMethod: run.acquisitionMethod,
    adapterVersion: descriptor.adapterVersion,
    methodVersion,
    observedAt: observedAt.toISOString(),
    status: 'NOT_CHECKED',
    observation: { mention: null, citation: null, accuracy: null, coverage: null },
    cost: { amount: '0.000000', currency: 'USD' },
    rawEvidence: {
      responseText: null,
      citations: [],
      error: {
        code: policyReason,
        message:
          'This measurement was not executed because its approved runtime policy did not allow it.',
      },
    },
  };
}

function normalizeResult(
  result: MeasurementSurfaceExecutionResult,
  run: MeasurementRunRecord,
  descriptor: MeasurementSurfaceAdapterDescriptor,
  expectedMethodVersion: string,
  fallbackObservedAt: Date,
): MeasurementSurfaceExecutionResult {
  if (!isValidExecutionResult(result)) {
    return safeInvalidResult(
      run,
      descriptor,
      expectedMethodVersion,
      fallbackObservedAt,
      'MEASUREMENT_ADAPTER_RESULT_INVALID',
      'The Measurement Adapter returned an invalid result.',
      'ERROR',
    );
  }
  if (
    result.providerKey === run.providerKey &&
    result.surfaceKey === run.surfaceKey &&
    result.acquisitionMethod === run.acquisitionMethod &&
    result.adapterVersion === descriptor.adapterVersion &&
    result.methodVersion === expectedMethodVersion
  ) {
    return result;
  }
  return {
    providerKey: run.providerKey,
    surfaceKey: run.surfaceKey,
    acquisitionMethod: run.acquisitionMethod,
    adapterVersion: descriptor.adapterVersion,
    methodVersion: expectedMethodVersion,
    observedAt: result.observedAt,
    status: 'INCONCLUSIVE',
    observation: { mention: null, citation: null, accuracy: null, coverage: null },
    cost: result.cost,
    rawEvidence: {
      responseText: result.rawEvidence.responseText,
      citations: result.rawEvidence.citations,
      error: {
        code: 'ADAPTER_RUNTIME_METADATA_MISMATCH',
        message: 'The recorded result metadata does not match the approved Measurement Scenario.',
      },
    },
  };
}

function slotKey(promptId: string, currentScopeKey: string, repetition: number): string {
  return JSON.stringify([promptId, currentScopeKey, repetition]);
}

function cohortMetricKey(
  scopeKey: string,
  metricKey: StoredMetricObservation['metricKey'],
): string {
  return JSON.stringify([scopeKey, metricKey]);
}

function safeInvalidResult(
  run: MeasurementRunRecord,
  descriptor: MeasurementSurfaceAdapterDescriptor,
  methodVersion: string,
  observedAt: Date,
  code: string,
  message: string,
  status: 'ERROR' | 'INCONCLUSIVE',
): MeasurementSurfaceExecutionResult {
  return {
    providerKey: run.providerKey,
    surfaceKey: run.surfaceKey,
    acquisitionMethod: run.acquisitionMethod,
    adapterVersion: descriptor.adapterVersion,
    methodVersion,
    observedAt: observedAt.toISOString(),
    status,
    observation: { mention: null, citation: null, accuracy: null, coverage: null },
    cost: { amount: '0.000000', currency: 'USD' },
    rawEvidence: { responseText: null, citations: [], error: { code, message } },
  };
}

function isValidDescriptor(value: unknown): value is MeasurementSurfaceAdapterDescriptor {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'adapterKey',
      'adapterVersion',
      'providerKey',
      'surfaceKey',
      'surfaceKind',
      'acquisitionClass',
      'acquisitionMethod',
      'termsVersion',
      'processingRegion',
      'storageRegion',
      'retentionPolicy',
      'trainingPolicy',
      'subprocessors',
      'requiresAuthorization',
    ])
  )
    return false;
  const acquisitionClasses = new Set([
    'CONSUMER_UI_SAMPLE',
    'MODEL_API_DIAGNOSTIC',
    'SEARCH_DATA_API',
    'MANUAL_IMPORT',
  ]);
  const surfaceKinds = new Set(['SEARCH_DATA', 'CONSUMER_SEARCH', 'CONSUMER_AI_ANSWER']);
  return (
    boundedString(value.adapterKey, 120) &&
    boundedString(value.adapterVersion, 120) &&
    boundedString(value.providerKey, 120) &&
    boundedString(value.surfaceKey, 120) &&
    typeof value.surfaceKind === 'string' &&
    surfaceKinds.has(value.surfaceKind) &&
    typeof value.acquisitionClass === 'string' &&
    acquisitionClasses.has(value.acquisitionClass) &&
    boundedString(value.acquisitionMethod, 120) &&
    boundedString(value.termsVersion, 120) &&
    boundedString(value.processingRegion, 240) &&
    boundedString(value.storageRegion, 240) &&
    boundedString(value.retentionPolicy, 500) &&
    boundedString(value.trainingPolicy, 500) &&
    Array.isArray(value.subprocessors) &&
    value.subprocessors.length <= 100 &&
    value.subprocessors.every((item) => boundedString(item, 240)) &&
    typeof value.requiresAuthorization === 'boolean'
  );
}

function isValidExecutionResult(value: unknown): value is MeasurementSurfaceExecutionResult {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'providerKey',
      'surfaceKey',
      'acquisitionMethod',
      'adapterVersion',
      'methodVersion',
      'observedAt',
      'status',
      'observation',
      'cost',
      'rawEvidence',
    ])
  )
    return false;
  const statuses = new Set([
    'PASS',
    'FAIL',
    'ERROR',
    'NOT_CHECKED',
    'INCONCLUSIVE',
    'NOT_APPLICABLE',
  ]);
  if (
    !boundedString(value.providerKey, 120) ||
    !boundedString(value.surfaceKey, 120) ||
    !boundedString(value.acquisitionMethod, 120) ||
    !boundedString(value.adapterVersion, 120) ||
    !boundedString(value.methodVersion, 120) ||
    !boundedString(value.observedAt, 64) ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    typeof value.status !== 'string' ||
    !statuses.has(value.status) ||
    !isValidObservation(value.observation) ||
    !isValidCost(value.cost) ||
    !isValidRawEvidence(value.rawEvidence)
  )
    return false;
  const excluded = new Set(['ERROR', 'NOT_CHECKED', 'INCONCLUSIVE', 'NOT_APPLICABLE']);
  if (
    excluded.has(value.status) &&
    Object.values(value.observation).some((item) => item !== null)
  ) {
    return false;
  }
  if (value.status === 'ERROR' && value.rawEvidence.error === null) return false;
  if (
    (value.status === 'PASS' || value.status === 'FAIL') &&
    Object.values(value.observation).every((item) => item === null)
  )
    return false;
  return true;
}

function isValidObservation(
  value: unknown,
): value is MeasurementSurfaceExecutionResult['observation'] {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['mention', 'citation', 'accuracy', 'coverage']) &&
    nullableBoolean(value.mention) &&
    nullableBoolean(value.citation) &&
    (value.accuracy === null ||
      value.accuracy === 'MATCH' ||
      value.accuracy === 'MISMATCH' ||
      value.accuracy === 'NOT_APPLICABLE') &&
    nullableBoolean(value.coverage)
  );
}

function isValidCost(value: unknown): value is MeasurementSurfaceExecutionResult['cost'] {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['amount', 'currency']) &&
    typeof value.amount === 'string' &&
    /^(?:0|[1-9]\d{0,11})\.\d{6}$/u.test(value.amount) &&
    typeof value.currency === 'string' &&
    /^[A-Z]{3}$/u.test(value.currency)
  );
}

function isValidRawEvidence(
  value: unknown,
): value is MeasurementSurfaceExecutionResult['rawEvidence'] {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['responseText', 'citations', 'error']) ||
    !(
      value.responseText === null ||
      (typeof value.responseText === 'string' && value.responseText.length <= 2_000_000)
    ) ||
    !Array.isArray(value.citations) ||
    value.citations.length > 1_000 ||
    !value.citations.every(isValidCitation)
  )
    return false;
  return (
    value.error === null ||
    (isRecord(value.error) &&
      hasOnlyKeys(value.error, ['code', 'message']) &&
      boundedString(value.error.code, 160) &&
      boundedString(value.error.message, 4_000))
  );
}

function isValidCitation(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['url', 'title', 'snippet']) ||
    !boundedString(value.url, 2_000) ||
    !(typeof value.title === 'string' && value.title.length <= 500) ||
    !(typeof value.snippet === 'string' && value.snippet.length <= 4_000)
  )
    return false;
  try {
    new URL(value.url);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max;
}

function nullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean';
}
