import type { ManualMeasurementImportStore } from './ports.js';
import type {
  MeasurementSurfaceAdapter,
  MeasurementSurfaceAdapterDescriptor,
  MeasurementSurfaceAdapterRegistry,
  MeasurementSurfaceExecutionCommand,
  MeasurementSurfaceExecutionResult,
} from './types.js';
import {
  MANUAL_IMPORT_OBSERVATION_METHOD_VERSION,
  REVIEWED_MANUAL_IMPORT_ADAPTER_KEY,
  REVIEWED_MANUAL_IMPORT_ADAPTER_VERSION,
  REVIEWED_MANUAL_IMPORT_TERMS_VERSION,
} from './manual-measurement-import.js';
import { measurementScopeKey } from './measurement-scope-key.js';

const REVIEWED_SURFACES = [
  { providerKey: 'openai', surfaceKey: 'chatgpt-search' },
  { providerKey: 'google', surfaceKey: 'ai-mode' },
  { providerKey: 'google', surfaceKey: 'ai-overviews' },
  { providerKey: 'perplexity', surfaceKey: 'answer-surface' },
] as const;

export function createReviewedManualMeasurementImportAdapterRegistry(
  store: ManualMeasurementImportStore,
  clock: { now(): Date } = { now: () => new Date() },
): MeasurementSurfaceAdapterRegistry {
  const adapters = REVIEWED_SURFACES.map(
    (surface) => new ReviewedManualMeasurementImportAdapter(store, surface, clock),
  );
  return {
    resolve(providerKey, surfaceKey, adapterVersion) {
      return (
        adapters.find(
          (adapter) =>
            adapter.providerKey === providerKey &&
            adapter.surfaceKey === surfaceKey &&
            adapter.adapterVersion === adapterVersion,
        ) ?? null
      );
    },
  };
}

export class ReviewedManualMeasurementImportAdapter implements MeasurementSurfaceAdapter {
  readonly adapterKey = REVIEWED_MANUAL_IMPORT_ADAPTER_KEY;
  readonly adapterVersion = REVIEWED_MANUAL_IMPORT_ADAPTER_VERSION;
  readonly providerKey: string;
  readonly surfaceKey: string;

  constructor(
    private readonly store: ManualMeasurementImportStore,
    surface: { providerKey: string; surfaceKey: string },
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {
    this.providerKey = surface.providerKey;
    this.surfaceKey = surface.surfaceKey;
  }

  describe(): MeasurementSurfaceAdapterDescriptor {
    return {
      adapterKey: this.adapterKey,
      adapterVersion: this.adapterVersion,
      providerKey: this.providerKey,
      surfaceKey: this.surfaceKey,
      surfaceKind: 'CONSUMER_AI_ANSWER',
      acquisitionClass: 'MANUAL_IMPORT',
      acquisitionMethod: 'MANUAL_IMPORT',
      termsVersion: REVIEWED_MANUAL_IMPORT_TERMS_VERSION,
      processingRegion: 'workspace-database',
      storageRegion: 'workspace-database',
      retentionPolicy: 'Retained under the workspace evidence retention policy.',
      trainingPolicy: 'Reviewed manual evidence is not used for model training.',
      subprocessors: [],
      requiresAuthorization: true,
    };
  }

  async executeScenario(
    command: MeasurementSurfaceExecutionCommand,
  ): Promise<MeasurementSurfaceExecutionResult> {
    const binding = command.scenario.manualImport;
    if (
      binding === null ||
      command.scenario.providerKey !== this.providerKey ||
      command.scenario.surfaceKey !== this.surfaceKey ||
      command.scenario.acquisitionClass !== 'MANUAL_IMPORT' ||
      command.scenario.acquisitionMethod !== 'MANUAL_IMPORT'
    ) {
      return this.notChecked(
        'MANUAL_IMPORT_BINDING_INVALID',
        'The reviewed manual import binding is missing or does not match the Scenario.',
        'USD',
      );
    }
    const selected = await this.store.readReviewedSlot({
      tenantId: command.tenantId,
      workspaceId: command.workspaceId,
      actorId: command.measurementRunId,
      manualImportId: binding.id,
      expectedContentHash: binding.contentHash,
      promptId: command.prompt.id,
      scopeKey: measurementScopeKey(command.scope),
      repetition: command.repetition,
    });
    if (selected.outcome === 'MISSING') {
      return this.notChecked(
        'MANUAL_IMPORT_SLOT_MISSING',
        'No reviewed evidence was provided for this exact prompt, scope, and repetition.',
        selected.costCurrency,
      );
    }
    if (selected.outcome === 'INVALID') {
      return this.notChecked(
        'MANUAL_IMPORT_EVIDENCE_INVALID',
        'The reviewed manual evidence failed its immutable binding or integrity check.',
        selected.costCurrency ?? 'USD',
      );
    }
    const result = selected.slot.result;
    if (result === null || selected.slot.observedAt === null) {
      return this.notChecked(
        'MANUAL_IMPORT_EVIDENCE_INVALID',
        'The reviewed manual evidence slot is incomplete.',
        result?.cost.currency ?? 'USD',
      );
    }
    return {
      providerKey: this.providerKey,
      surfaceKey: this.surfaceKey,
      acquisitionMethod: 'MANUAL_IMPORT',
      adapterVersion: this.adapterVersion,
      methodVersion: MANUAL_IMPORT_OBSERVATION_METHOD_VERSION,
      observedAt: selected.slot.observedAt,
      status: result.status,
      observation: structuredClone(result.observation),
      cost: structuredClone(result.cost),
      rawEvidence: structuredClone(result.rawEvidence),
    };
  }

  private notChecked(
    code: string,
    message: string,
    currency: string,
  ): MeasurementSurfaceExecutionResult {
    return {
      providerKey: this.providerKey,
      surfaceKey: this.surfaceKey,
      acquisitionMethod: 'MANUAL_IMPORT',
      adapterVersion: this.adapterVersion,
      methodVersion: MANUAL_IMPORT_OBSERVATION_METHOD_VERSION,
      observedAt: this.clock.now().toISOString(),
      status: 'NOT_CHECKED',
      observation: { mention: null, citation: null, accuracy: null, coverage: null },
      cost: { amount: '0.000000', currency },
      rawEvidence: {
        responseText: null,
        citations: [],
        error: { code, message },
      },
    };
  }
}
