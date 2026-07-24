import { roleAllows } from '@aeostudio/domain/identity-access';
import type { MetricCohort } from '@aeostudio/domain/measurement';
import type { PromptBundle } from '@aeostudio/domain/prompt-research';
import type { SubmitManualMeasurementImportRequest } from '@aeostudio/contracts/measurement';
import type { ReviewManualMeasurementImportRequest } from '@aeostudio/contracts/measurement';

import type { IdentityIdGenerator, TenancyStore } from '../identity-access/index.js';
import type { JobTraceContext } from '../jobs-budgets/index.js';
import type { PromptResearchStore } from '../prompt-research/index.js';
import type {
  MeasurementJobStore,
  ManualMeasurementImportStore,
  MeasurementRawEvidenceStore,
  MeasurementStore,
} from './ports.js';
import type {
  ManualMeasurementImportRecord,
  ManualMeasurementImportSlot,
  MeasurementDrillDownDimension,
  MeasurementSurfaceAdapterRegistry,
  PromptRunRecord,
  RawMeasurementEvidencePayload,
} from './types.js';
import { measurementScopeKey } from './measurement-scope-key.js';
import {
  MAX_MANUAL_IMPORT_RAW_EVIDENCE_BYTES,
  MAX_MANUAL_IMPORT_TOTAL_EVIDENCE_BYTES,
  manualImportSlotContentHash,
  manualMeasurementImportHash,
  rawEvidenceByteLength,
  REVIEWED_MANUAL_IMPORT_ADAPTER_VERSION,
} from './manual-measurement-import.js';

export class MeasurementService {
  constructor(
    private readonly store: MeasurementStore,
    private readonly rawEvidence: MeasurementRawEvidenceStore,
    private readonly manualImports: ManualMeasurementImportStore,
    private readonly jobs: MeasurementJobStore,
    private readonly prompts: PromptResearchStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext' | 'appendDeniedAudit'>,
    private readonly ids: IdentityIdGenerator,
    private readonly clock: { now(): Date },
    private readonly adapters?: MeasurementSurfaceAdapterRegistry,
  ) {}

  async reviewManualImport(
    input: {
      actorSubject: string;
      tenantId: string;
      workspaceId: string;
      manualImportId: string;
    } & ReviewManualMeasurementImportRequest,
  ) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' as const };
    if (!roleAllows(context.role, 'MEASUREMENT_IMPORT_APPROVE')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'MEASUREMENT_MANUAL_IMPORT_REVIEW',
        resourceType: 'MEASUREMENT_MANUAL_IMPORT',
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    return this.manualImports.review({
      context,
      manualImportId: input.manualImportId,
      expectedContentHash: input.expectedContentHash,
      decision: input.decision,
      note: input.note ?? null,
      reviewedAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
  }

  async getManualImport(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    manualImportId: string;
  }) {
    const context = await this.readContext(input);
    if (context === null) return null;
    const detail = await this.manualImports.findWithSlots({
      context,
      manualImportId: input.manualImportId,
    });
    if (detail === null) return null;
    const bundle = await this.prompts.findRevision({
      context,
      promptSetId: detail.manualImport.promptSetId,
      revisionId: detail.manualImport.promptRevisionId,
    });
    if (
      bundle === null ||
      bundle.revision.contentHash !== detail.manualImport.promptContentHash ||
      bundle.scenario.id !== detail.manualImport.scenarioId ||
      bundle.scenario.contentHash !== detail.manualImport.scenarioContentHash
    ) {
      return null;
    }
    const prompts = new Map(
      bundle.revision.prompts.map((prompt, index) => [
        prompt.id,
        { id: prompt.id, ordinal: index + 1, text: prompt.text },
      ]),
    );
    const slots = detail.slots.map((slot) => ({ ...slot, prompt: prompts.get(slot.promptId) }));
    if (slots.some((slot) => slot.prompt === undefined)) return null;
    return {
      manualImport: detail.manualImport,
      slots: slots.map((slot) => ({
        prompt: slot.prompt!,
        scope: slot.scope,
        scopeKey: slot.scopeKey,
        repetition: slot.repetition,
        provided: slot.provided,
        observedAt: slot.observedAt,
        result: slot.result,
        rawEvidenceContentHash: slot.rawEvidenceContentHash,
        contentHash: slot.contentHash,
      })),
    };
  }

  async submitManualImport(
    input: {
      actorSubject: string;
      tenantId: string;
      workspaceId: string;
    } & SubmitManualMeasurementImportRequest,
  ) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' as const };
    if (!roleAllows(context.role, 'MEASUREMENT_RUN')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'MEASUREMENT_MANUAL_IMPORT_SUBMIT',
        resourceType: 'MEASUREMENT_MANUAL_IMPORT',
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    const bundle = await this.prompts.findRevision({
      context,
      promptSetId: input.promptSetId,
      revisionId: input.promptRevisionId,
    });
    if (!approvedBundleMatches(bundle, input)) {
      return { outcome: 'APPROVAL_MISMATCH' as const };
    }
    const registry = (await this.prompts.listRegistry({ context })).find(
      (entry) =>
        entry.providerKey === bundle.scenario.providerKey &&
        entry.surfaceKey === bundle.scenario.surfaceKey,
    );
    if (
      registry === undefined ||
      registry.acquisitionClass !== 'MANUAL_IMPORT' ||
      registry.acquisitionMethod !== 'MANUAL_IMPORT' ||
      registry.adapterVersion !== REVIEWED_MANUAL_IMPORT_ADAPTER_VERSION ||
      bundle.scenario.acquisitionMethod !== 'MANUAL_IMPORT'
    ) {
      return { outcome: 'INVALID_SOURCE' as const };
    }
    const normalized = buildManualImportSlots({
      prompts: bundle.revision.prompts.map((prompt) => ({ id: prompt.id })),
      scopes: bundle.revision.scopes,
      repetitions: bundle.scenario.repetitions,
      entries: input.entries,
    });
    if (normalized.outcome !== 'SUCCEEDED') return normalized;
    const submittedAt = this.clock.now();
    const manualImportId = this.ids.next();
    const contentHash = manualMeasurementImportHash({
      schemaVersion: input.schemaVersion,
      promptSetId: bundle.promptSet.id,
      promptRevisionId: bundle.revision.id,
      promptContentHash: bundle.revision.contentHash,
      scenarioId: bundle.scenario.id,
      scenarioContentHash: bundle.scenario.contentHash,
      providerKey: registry.providerKey,
      surfaceKey: registry.surfaceKey,
      adapterVersion: registry.adapterVersion,
      acquisitionClass: registry.acquisitionClass,
      acquisitionMethod: registry.acquisitionMethod,
      costCurrency: normalized.costCurrency,
      slots: normalized.slots,
    });
    const manualImport: ManualMeasurementImportRecord = {
      id: manualImportId,
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      schemaVersion: input.schemaVersion,
      promptSetId: bundle.promptSet.id,
      promptRevisionId: bundle.revision.id,
      promptContentHash: bundle.revision.contentHash,
      scenarioId: bundle.scenario.id,
      scenarioContentHash: bundle.scenario.contentHash,
      providerKey: registry.providerKey,
      surfaceKey: registry.surfaceKey,
      adapterVersion: registry.adapterVersion,
      acquisitionClass: 'MANUAL_IMPORT',
      acquisitionMethod: 'MANUAL_IMPORT',
      status: 'SUBMITTED',
      contentHash,
      expectedSlotCount: normalized.slots.length,
      providedSlotCount: normalized.providedSlotCount,
      costCurrency: normalized.costCurrency,
      submittedByUserId: context.actorUserId,
      submittedAt: submittedAt.toISOString(),
      reviewedByUserId: null,
      reviewedAt: null,
      reviewNote: null,
    };
    const stored = await this.manualImports.submit({
      context,
      manualImport,
      slots: normalized.slots,
      idempotencyKey: input.idempotencyKey,
      auditEventId: this.ids.next(),
    });
    return stored.outcome === 'IDEMPOTENCY_CONFLICT'
      ? stored
      : { outcome: 'SUCCEEDED' as const, manualImport: stored.manualImport };
  }

  async start(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    promptSetId: string;
    promptRevisionId: string;
    scenarioId: string;
    expectedPromptHash: string;
    expectedScenarioHash: string;
    manualImportId?: string;
    expectedManualImportHash?: string;
    kind: 'BASELINE' | 'REMEASUREMENT';
    idempotencyKey: string;
    traceContext?: JobTraceContext;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' as const };
    if (!roleAllows(context.role, 'MEASUREMENT_RUN')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'MEASUREMENT_RUN_START',
        resourceType: 'MEASUREMENT_RUN',
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    const bundle = await this.prompts.findRevision({
      context,
      promptSetId: input.promptSetId,
      revisionId: input.promptRevisionId,
    });
    if (
      bundle === null ||
      bundle.promptSet.id !== input.promptSetId ||
      bundle.revision.id !== input.promptRevisionId ||
      bundle.revision.status !== 'APPROVED' ||
      bundle.revision.contentHash !== input.expectedPromptHash ||
      bundle.scenario.id !== input.scenarioId ||
      bundle.scenario.contentHash !== input.expectedScenarioHash ||
      bundle.approval === null ||
      !bundle.approvalCurrent ||
      bundle.approval.promptRevisionId !== input.promptRevisionId ||
      bundle.approval.scenarioId !== input.scenarioId ||
      bundle.approval.promptContentHash !== input.expectedPromptHash ||
      bundle.approval.scenarioContentHash !== input.expectedScenarioHash
    ) {
      return { outcome: 'APPROVAL_MISMATCH' as const };
    }
    const registry = (await this.prompts.listRegistry({ context })).find(
      (entry) =>
        entry.providerKey === bundle.scenario.providerKey &&
        entry.surfaceKey === bundle.scenario.surfaceKey,
    );
    if (registry === undefined) return { outcome: 'NOT_FOUND' as const };
    const expectedPromptRunCount =
      bundle.revision.prompts.length * bundle.revision.scopes.length * bundle.scenario.repetitions;
    const requiresReviewedImport =
      registry.acquisitionClass === 'MANUAL_IMPORT' &&
      registry.acquisitionMethod === 'MANUAL_IMPORT' &&
      registry.adapterVersion === REVIEWED_MANUAL_IMPORT_ADAPTER_VERSION;
    let reviewedImport: ManualMeasurementImportRecord | null = null;
    if (requiresReviewedImport) {
      if (input.manualImportId === undefined || input.expectedManualImportHash === undefined) {
        return { outcome: 'MANUAL_IMPORT_NOT_APPROVED' as const };
      }
      reviewedImport = await this.manualImports.find({
        context,
        manualImportId: input.manualImportId,
      });
      if (
        reviewedImport === null ||
        reviewedImport.status !== 'APPROVED' ||
        reviewedImport.contentHash !== input.expectedManualImportHash ||
        reviewedImport.promptSetId !== bundle.promptSet.id ||
        reviewedImport.promptRevisionId !== bundle.revision.id ||
        reviewedImport.promptContentHash !== bundle.revision.contentHash ||
        reviewedImport.scenarioId !== bundle.scenario.id ||
        reviewedImport.scenarioContentHash !== bundle.scenario.contentHash ||
        reviewedImport.providerKey !== registry.providerKey ||
        reviewedImport.surfaceKey !== registry.surfaceKey ||
        reviewedImport.adapterVersion !== registry.adapterVersion ||
        reviewedImport.expectedSlotCount !== expectedPromptRunCount
      ) {
        return { outcome: 'MANUAL_IMPORT_NOT_APPROVED' as const };
      }
    } else if (input.manualImportId !== undefined || input.expectedManualImportHash !== undefined) {
      return { outcome: 'MANUAL_IMPORT_NOT_APPROVED' as const };
    }
    const measurementRun = await this.store.prepareRun({
      context,
      measurementRunId: this.ids.next(),
      approvedSource: {
        promptSetId: bundle.promptSet.id,
        promptRevisionId: bundle.revision.id,
        promptContentHash: bundle.revision.contentHash,
        scenarioContentHash: bundle.scenario.contentHash,
        prompts: bundle.revision.prompts.map((prompt, index) => ({
          id: prompt.id,
          ordinal: index + 1,
          text: prompt.text,
        })),
        scenarioSnapshot: {
          id: bundle.scenario.id,
          version: bundle.scenario.version,
          contentHash: bundle.scenario.contentHash,
          promptRevisionId: bundle.revision.id,
          providerKey: bundle.scenario.providerKey,
          surfaceKey: bundle.scenario.surfaceKey,
          model: bundle.scenario.model,
          modelVersion: bundle.scenario.modelVersion,
          account: bundle.scenario.account,
          acquisitionClass: registry.acquisitionClass,
          acquisitionMethod: bundle.scenario.acquisitionMethod,
          registryStatus: registry.status,
          manualImport:
            reviewedImport === null
              ? null
              : { id: reviewedImport.id, contentHash: reviewedImport.contentHash },
          freshSession: bundle.scenario.freshSession,
          searchEnabled: bundle.scenario.searchEnabled,
          parameters: structuredClone(bundle.scenario.parameters),
          repetitions: bundle.scenario.repetitions,
          scopes: structuredClone(bundle.revision.scopes),
        },
        adapterVersion: registry.adapterVersion,
        expectedPromptRunCount,
      },
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      createdAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
    if (measurementRun === null) return { outcome: 'NOT_FOUND' as const };
    const job = await this.jobs.submitJob({
      context,
      jobId: this.ids.next(),
      jobType: 'MEASUREMENT',
      aggregateId: measurementRun.id,
      idempotencyKey: input.idempotencyKey,
      estimatedUnits: measurementRun.expectedPromptRunCount,
      providerKey: bundle.scenario.providerKey,
      reservationId: this.ids.next(),
      budgetAlertId: this.ids.next(),
      outboxMessageId: this.ids.next(),
      auditEventId: this.ids.next(),
      ...(input.traceContext === undefined ? {} : { traceContext: input.traceContext }),
    });
    if (job === null) return { outcome: 'NOT_FOUND' as const };
    const bound = await this.store.bindJob({
      context,
      measurementRunId: measurementRun.id,
      jobId: job.id,
    });
    if (bound === null) return { outcome: 'NOT_FOUND' as const };
    return { outcome: 'SUCCEEDED' as const, measurementRun: bound, job };
  }

  async setProviderPolicy(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    providerKey: string;
    surfaceKey: string;
    adapterVersion: string;
    termsVersion: string;
    termsApproved: boolean;
    authorizationApproved: boolean;
    crossBorderApproved: boolean;
    purpose: string;
    policyVersion: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' as const };
    if (!roleAllows(context.role, 'TENANT_MANAGE')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'MEASUREMENT_PROVIDER_POLICY_CHANGE',
        resourceType: 'MEASUREMENT_PROVIDER_POLICY',
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    const policy = await this.store.setProviderPolicy({
      context,
      policyId: this.ids.next(),
      providerKey: input.providerKey,
      surfaceKey: input.surfaceKey,
      adapterVersion: input.adapterVersion,
      termsVersion: input.termsVersion,
      termsApproved: input.termsApproved,
      authorizationApproved: input.authorizationApproved,
      crossBorderApproved: input.crossBorderApproved,
      purpose: input.purpose,
      policyVersion: input.policyVersion,
      approvedAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
    return { outcome: 'SUCCEEDED' as const, policy };
  }

  async getProviderPolicyState(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    providerKey: string;
    surfaceKey: string;
  }) {
    const context = await this.readContext(input);
    if (context === null) return null;
    const registry = (await this.prompts.listRegistry({ context })).find(
      (entry) => entry.providerKey === input.providerKey && entry.surfaceKey === input.surfaceKey,
    );
    if (registry === undefined) return null;
    const adapter = this.adapters?.resolve(
      registry.providerKey,
      registry.surfaceKey,
      registry.adapterVersion,
    );
    let requiredTermsVersion: string | null = null;
    let requiresAuthorization = true;
    let adapterAvailable = false;
    if (adapter !== null && adapter !== undefined) {
      try {
        const descriptor = adapter.describe();
        if (
          descriptor.providerKey === registry.providerKey &&
          descriptor.surfaceKey === registry.surfaceKey &&
          descriptor.adapterVersion === registry.adapterVersion
        ) {
          requiredTermsVersion = descriptor.termsVersion;
          requiresAuthorization = descriptor.requiresAuthorization;
          adapterAvailable = true;
        }
      } catch {
        adapterAvailable = false;
      }
    }
    const policy = await this.store.findProviderPolicy({
      context,
      providerKey: registry.providerKey,
      surfaceKey: registry.surfaceKey,
    });
    const reasons: Array<
      | 'POLICY_MISSING'
      | 'ADAPTER_UNAVAILABLE'
      | 'ADAPTER_VERSION_MISMATCH'
      | 'TERMS_VERSION_MISMATCH'
      | 'TERMS_NOT_APPROVED'
      | 'AUTHORIZATION_NOT_APPROVED'
      | 'CROSS_BORDER_NOT_APPROVED'
    > = [];
    if (policy === null) reasons.push('POLICY_MISSING');
    if (!adapterAvailable) reasons.push('ADAPTER_UNAVAILABLE');
    if (policy !== null) {
      if (policy.adapterVersion !== registry.adapterVersion) {
        reasons.push('ADAPTER_VERSION_MISMATCH');
      }
      if (requiredTermsVersion === null || policy.termsVersion !== requiredTermsVersion) {
        reasons.push('TERMS_VERSION_MISMATCH');
      }
      if (!policy.termsApproved) reasons.push('TERMS_NOT_APPROVED');
      if (!policy.authorizationApproved) reasons.push('AUTHORIZATION_NOT_APPROVED');
      if (!policy.crossBorderApproved) reasons.push('CROSS_BORDER_NOT_APPROVED');
    }
    return {
      providerKey: registry.providerKey,
      surfaceKey: registry.surfaceKey,
      requiredAdapterVersion: registry.adapterVersion,
      requiredTermsVersion,
      requiresAuthorization,
      eligible: reasons.length === 0,
      reasons,
      policy,
    };
  }

  async getRun(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    measurementRunId: string;
  }) {
    const context = await this.readContext(input);
    return context === null
      ? null
      : this.store.findRun({ context, measurementRunId: input.measurementRunId });
  }

  async listPromptRuns(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    measurementRunId: string;
    limit: number;
    offset: number;
    scopeKey?: string;
    dimension?: MeasurementDrillDownDimension;
  }) {
    const context = await this.readContext(input);
    return context === null
      ? null
      : this.store.listPromptRuns({
          context,
          measurementRunId: input.measurementRunId,
          limit: Math.min(Math.max(input.limit, 1), 100),
          offset: Math.min(Math.max(input.offset, 0), 100_000),
          ...(input.scopeKey === undefined ? {} : { scopeKey: input.scopeKey }),
          ...(input.dimension === undefined ? {} : { dimension: input.dimension }),
        });
  }

  async getPromptRun(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    measurementRunId: string;
    promptRunId: string;
  }) {
    const context = await this.readContext(input);
    if (context === null) return null;
    const stored = await this.store.findPromptRun({
      context,
      measurementRunId: input.measurementRunId,
      promptRunId: input.promptRunId,
    });
    if (stored?.rawEvidenceRef === null || stored === null) return null;
    const payload = await this.rawEvidence.get({
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      objectRef: stored.rawEvidenceRef.objectRef,
      contentHash: stored.rawEvidenceRef.contentHash,
    });
    return payload === null
      ? null
      : {
          promptRun: stored.promptRun,
          rawEvidence: { contentHash: stored.rawEvidenceRef.contentHash, ...payload },
        };
  }

  async getDashboard(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    measurementRunId: string;
  }) {
    const context = await this.readContext(input);
    if (context === null) return null;
    const source = await this.store.loadDashboard({
      context,
      measurementRunId: input.measurementRunId,
    });
    if (source === null || source.snapshots.length === 0) return null;
    const first = source.promptRuns[0];
    if (first === undefined) return null;
    const summary = measurementSummary(source.promptRuns);
    const dashboardMetrics = source.snapshots.map((snapshot) => {
      const cohort = dashboardCohort(snapshot.cohort);
      const promptRunIds = source.promptRuns
        .filter((run) => promptRunBelongsToCohort(run, cohort))
        .map((run) => run.id);
      return {
        id: snapshot.id,
        metricKey: snapshot.metricKey,
        methodVersion: snapshot.methodVersion,
        numerator: snapshot.numerator,
        eligibleDenominator: snapshot.eligibleDenominator,
        value: snapshot.value,
        excludedCounts: snapshot.excludedCounts,
        promptRunIds,
        sourceHash: snapshot.sourceHash,
        contentHash: snapshot.contentHash,
        cohort,
      };
    });
    const cohortGroups = new Map<
      string,
      {
        cohort: ReturnType<typeof dashboardCohort>;
        metricIds: string[];
        cost: ReturnType<typeof measurementSummary>['cost'];
        costBreakdown: ReturnType<typeof measurementSummary>['costBreakdown'];
        resultCounts: ReturnType<typeof measurementSummary>['resultCounts'];
      }
    >();
    for (const metric of dashboardMetrics) {
      const compatibilityKey = JSON.stringify(metric.cohort);
      const cohortRuns = source.promptRuns.filter((run) =>
        promptRunBelongsToCohort(run, metric.cohort),
      );
      const cohortSummary = measurementSummary(cohortRuns);
      const group = cohortGroups.get(compatibilityKey) ?? {
        cohort: metric.cohort,
        metricIds: [],
        cost: cohortSummary.cost,
        costBreakdown: cohortSummary.costBreakdown,
        resultCounts: cohortSummary.resultCounts,
      };
      group.metricIds.push(metric.id);
      cohortGroups.set(compatibilityKey, group);
    }
    return {
      snapshot: {
        measurementRunId: source.run.id,
        metrics: dashboardMetrics,
      },
      sections: [
        {
          key: 'TECHNICAL_HEALTH' as const,
          sourceKind: 'OWNED_SITE_BASELINE' as const,
          summary: {
            state: 'NOT_LINKED' as const,
            reason: 'MEASUREMENT_SCENARIO_SITE_NOT_LINKED' as const,
          },
        },
        {
          key: 'CONTENT_EVIDENCE_READINESS' as const,
          sourceKind: 'CLAIM_EVIDENCE_LEDGER' as const,
          summary: {
            state: 'NOT_LINKED' as const,
            reason: 'MEASUREMENT_SCENARIO_CLAIM_SET_NOT_LINKED' as const,
          },
        },
        {
          key: 'MEASURED_AI_VISIBILITY' as const,
          cohorts: [...cohortGroups.values()],
        },
      ],
      cost: summary.cost,
      costBreakdown: summary.costBreakdown,
      resultCounts: summary.resultCounts,
    };
  }

  private async readContext(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    return context !== null && roleAllows(context.role, 'WORKSPACE_READ') ? context : null;
  }
}

function approvedBundleMatches(
  bundle: PromptBundle | null,
  input: {
    promptSetId: string;
    promptRevisionId: string;
    scenarioId: string;
    expectedPromptHash: string;
    expectedScenarioHash: string;
  },
): bundle is PromptBundle {
  return (
    bundle !== null &&
    bundle.promptSet.id === input.promptSetId &&
    bundle.revision.id === input.promptRevisionId &&
    bundle.revision.status === 'APPROVED' &&
    bundle.revision.contentHash === input.expectedPromptHash &&
    bundle.scenario.id === input.scenarioId &&
    bundle.scenario.contentHash === input.expectedScenarioHash &&
    bundle.approval !== null &&
    bundle.approvalCurrent &&
    bundle.approval.promptRevisionId === input.promptRevisionId &&
    bundle.approval.scenarioId === input.scenarioId &&
    bundle.approval.promptContentHash === input.expectedPromptHash &&
    bundle.approval.scenarioContentHash === input.expectedScenarioHash
  );
}

function buildManualImportSlots(input: {
  prompts: { id: string }[];
  scopes: { market: string; locale: string; region: string }[];
  repetitions: number;
  entries: SubmitManualMeasurementImportRequest['entries'];
}):
  | {
      outcome: 'SUCCEEDED';
      slots: ManualMeasurementImportSlot[];
      providedSlotCount: number;
      costCurrency: string;
    }
  | { outcome: 'INVALID_ENTRIES' | 'EVIDENCE_HASH_MISMATCH' | 'EVIDENCE_TOO_LARGE' } {
  const promptIds = new Set(input.prompts.map((prompt) => prompt.id));
  const scopesByKey = new Map(
    input.scopes.map((scope) => [measurementScopeKey(scope), structuredClone(scope)]),
  );
  const provided = new Map<string, Omit<ManualMeasurementImportSlot, 'contentHash'>>();
  const currencies = new Set<string>();
  let totalEvidenceBytes = 0;
  for (const entry of input.entries) {
    const scopeKey = measurementScopeKey(entry.scope);
    const exactScope = scopesByKey.get(scopeKey);
    if (
      !promptIds.has(entry.promptId) ||
      exactScope === undefined ||
      entry.repetition > input.repetitions ||
      !manualImportResultIsConsistent(entry.result)
    ) {
      return { outcome: 'INVALID_ENTRIES' };
    }
    const key = manualImportSlotKey(entry.promptId, scopeKey, entry.repetition);
    if (provided.has(key)) return { outcome: 'INVALID_ENTRIES' };
    const suppliedHash = entry.result.rawEvidence.contentHash;
    const rawEvidence: RawMeasurementEvidencePayload = {
      responseText: entry.result.rawEvidence.responseText,
      citations: structuredClone(entry.result.rawEvidence.citations),
      error: structuredClone(entry.result.rawEvidence.error),
    };
    const rawEvidenceContentHash = manualMeasurementImportHash(rawEvidence);
    if (suppliedHash !== undefined && suppliedHash !== rawEvidenceContentHash) {
      return { outcome: 'EVIDENCE_HASH_MISMATCH' };
    }
    const evidenceBytes = rawEvidenceByteLength(rawEvidence);
    totalEvidenceBytes += evidenceBytes;
    currencies.add(entry.result.cost.currency);
    if (
      evidenceBytes > MAX_MANUAL_IMPORT_RAW_EVIDENCE_BYTES ||
      totalEvidenceBytes > MAX_MANUAL_IMPORT_TOTAL_EVIDENCE_BYTES
    ) {
      return { outcome: 'EVIDENCE_TOO_LARGE' };
    }
    provided.set(key, {
      promptId: entry.promptId,
      scope: exactScope,
      scopeKey,
      repetition: entry.repetition,
      provided: true,
      observedAt: entry.observedAt,
      result: {
        status: entry.result.status,
        observation: structuredClone(entry.result.observation),
        cost: structuredClone(entry.result.cost),
        rawEvidence,
      },
      rawEvidenceContentHash,
    });
  }
  if (currencies.size !== 1) return { outcome: 'INVALID_ENTRIES' };
  const slots: ManualMeasurementImportSlot[] = [];
  for (const scope of input.scopes) {
    const scopeKey = measurementScopeKey(scope);
    for (const prompt of input.prompts) {
      for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
        const key = manualImportSlotKey(prompt.id, scopeKey, repetition);
        const existing = provided.get(key);
        const slotWithoutHash: Omit<ManualMeasurementImportSlot, 'contentHash'> = existing ?? {
          promptId: prompt.id,
          scope: structuredClone(scope),
          scopeKey,
          repetition,
          provided: false,
          observedAt: null,
          result: null,
          rawEvidenceContentHash: null,
        };
        slots.push({
          ...slotWithoutHash,
          contentHash: manualImportSlotContentHash(slotWithoutHash),
        });
      }
    }
  }
  slots.sort(
    (left, right) =>
      left.scopeKey.localeCompare(right.scopeKey) ||
      left.promptId.localeCompare(right.promptId) ||
      left.repetition - right.repetition,
  );
  return {
    outcome: 'SUCCEEDED',
    slots,
    providedSlotCount: provided.size,
    costCurrency: currencies.values().next().value as string,
  };
}

function manualImportResultIsConsistent(
  result: SubmitManualMeasurementImportRequest['entries'][number]['result'],
): boolean {
  const excluded = new Set(['ERROR', 'NOT_CHECKED', 'INCONCLUSIVE', 'NOT_APPLICABLE']);
  if (
    excluded.has(result.status) &&
    Object.values(result.observation).some((value) => value !== null)
  ) {
    return false;
  }
  if (
    (result.status === 'ERROR' || result.status === 'NOT_CHECKED') &&
    result.rawEvidence.error === null
  ) {
    return false;
  }
  if (
    (result.status === 'PASS' || result.status === 'FAIL') &&
    Object.values(result.observation).every((value) => value === null)
  ) {
    return false;
  }
  return true;
}

function manualImportSlotKey(promptId: string, scopeKey: string, repetition: number): string {
  return JSON.stringify([promptId, scopeKey, repetition]);
}

function dashboardCohort(cohort: MetricCohort) {
  return {
    providerKey: cohort.providerKey,
    surfaceKey: cohort.surfaceKey,
    acquisitionClass: cohort.acquisitionClass,
    acquisitionMethod: cohort.acquisitionMethod,
    adapterKey: cohort.adapterKey,
    adapterVersion: cohort.adapterVersion,
    model: cohort.model,
    modelVersion: cohort.modelVersion,
    scenarioId: cohort.scenarioId,
    scenarioVersion: cohort.scenarioVersion,
    scopeKey: measurementScopeKey(cohort.scope),
  };
}

function promptRunBelongsToCohort(
  run: PromptRunRecord,
  cohort: ReturnType<typeof dashboardCohort>,
): boolean {
  return (
    run.providerKey === cohort.providerKey &&
    run.surfaceKey === cohort.surfaceKey &&
    run.acquisitionClass === cohort.acquisitionClass &&
    run.acquisitionMethod === cohort.acquisitionMethod &&
    run.adapterKey === cohort.adapterKey &&
    run.adapterVersion === cohort.adapterVersion &&
    run.model === cohort.model &&
    run.modelVersion === cohort.modelVersion &&
    run.scenarioId === cohort.scenarioId &&
    run.scenarioVersion === cohort.scenarioVersion &&
    run.scopeKey === cohort.scopeKey
  );
}

function measurementSummary(runs: PromptRunRecord[]) {
  const resultCounts = {
    PASS: 0,
    FAIL: 0,
    ERROR: 0,
    NOT_CHECKED: 0,
    INCONCLUSIVE: 0,
    NOT_APPLICABLE: 0,
  };
  const costMicrosByCurrency = new Map<string, bigint>();
  for (const run of runs) {
    resultCounts[run.status] += 1;
    const [whole = '0', fraction = ''] = run.cost.amount.split('.');
    const costMicros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
    costMicrosByCurrency.set(
      run.cost.currency,
      (costMicrosByCurrency.get(run.cost.currency) ?? 0n) + costMicros,
    );
  }
  const costBreakdown = [...costMicrosByCurrency.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([currency, costMicros]) => ({
      amount: `${costMicros / 1_000_000n}.${String(costMicros % 1_000_000n).padStart(6, '0')}`,
      currency,
    }));
  return {
    cost: costBreakdown.length === 1 ? costBreakdown[0]! : null,
    costBreakdown,
    resultCounts,
  };
}
