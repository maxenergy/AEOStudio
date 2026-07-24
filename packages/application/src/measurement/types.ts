import type { JobRecord } from '@aeostudio/domain/jobs-budgets';
import type {
  MeasurementAcquisitionClass,
  MetricClassification,
  MetricCohort,
} from '@aeostudio/domain/measurement';

export type MeasurementRunStatus =
  'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'ERROR' | 'CANCELLED';

export type PromptRunStatus =
  'PASS' | 'FAIL' | 'ERROR' | 'NOT_CHECKED' | 'INCONCLUSIVE' | 'NOT_APPLICABLE';

export type MeasurementDrillDownDimension =
  'MENTION_RATE' | 'CITATION_RATE' | 'ACCURACY_RATE' | 'COVERAGE_RATE' | 'COST' | 'ERROR';

export interface MeasurementScope {
  market: string;
  locale: string;
  region: string;
}

export interface MeasurementScenarioSnapshot {
  id: string;
  version: number;
  contentHash: string;
  promptRevisionId: string;
  providerKey: string;
  surfaceKey: string;
  model: string;
  modelVersion: string;
  account: string;
  acquisitionClass: MeasurementAcquisitionClass;
  acquisitionMethod: string;
  registryStatus: 'AVAILABLE' | 'UNAVAILABLE';
  manualImport: { id: string; contentHash: string } | null;
  freshSession: boolean;
  searchEnabled: boolean;
  parameters: Record<string, unknown>;
  repetitions: number;
  scopes: MeasurementScope[];
}

export type ManualMeasurementImportStatus = 'SUBMITTED' | 'APPROVED' | 'REJECTED';

export interface ManualMeasurementImportRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  schemaVersion: 'measurement-manual-import.v1';
  promptSetId: string;
  promptRevisionId: string;
  promptContentHash: string;
  scenarioId: string;
  scenarioContentHash: string;
  providerKey: string;
  surfaceKey: string;
  adapterVersion: string;
  acquisitionClass: 'MANUAL_IMPORT';
  acquisitionMethod: 'MANUAL_IMPORT';
  status: ManualMeasurementImportStatus;
  contentHash: string;
  expectedSlotCount: number;
  providedSlotCount: number;
  costCurrency: string;
  submittedByUserId: string;
  submittedAt: string;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

export interface ManualMeasurementImportSlot {
  promptId: string;
  scope: MeasurementScope;
  scopeKey: string;
  repetition: number;
  provided: boolean;
  observedAt: string | null;
  result: {
    status: PromptRunStatus;
    observation: MeasurementObservationValue;
    cost: MeasurementCost;
    rawEvidence: RawMeasurementEvidencePayload;
  } | null;
  rawEvidenceContentHash: string | null;
  contentHash: string;
}

export interface MeasurementRunRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  promptRevisionId: string;
  scenarioId: string;
  scenarioVersion: number;
  jobId: string | null;
  kind: 'BASELINE' | 'REMEASUREMENT';
  status: MeasurementRunStatus;
  expectedPromptRunCount: number;
  completedPromptRunCount: number;
  providerKey: string;
  surfaceKey: string;
  model: string;
  modelVersion: string;
  acquisitionClass: MeasurementAcquisitionClass;
  acquisitionMethod: string;
  adapterVersion: string;
  scenarioSnapshot: MeasurementScenarioSnapshot;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface MeasurementObservationValue {
  mention: boolean | null;
  citation: boolean | null;
  accuracy: 'MATCH' | 'MISMATCH' | 'NOT_APPLICABLE' | null;
  coverage: boolean | null;
}

export interface MeasurementCost {
  amount: string;
  currency: string;
}

export interface PromptRunRecord {
  id: string;
  measurementRunId: string;
  promptId: string;
  promptOrdinal: number;
  repetition: number;
  scopeKey: string;
  status: PromptRunStatus;
  providerKey: string;
  surfaceKey: string;
  model: string;
  modelVersion: string;
  scenarioId: string;
  scenarioVersion: number;
  acquisitionMethod: string;
  acquisitionClass: MeasurementAcquisitionClass;
  adapterKey: string;
  adapterVersion: string;
  methodVersion: string;
  observation: MeasurementObservationValue;
  cost: MeasurementCost;
  policyReason: string | null;
  observedAt: string;
}

export interface RawCitation {
  url: string;
  title: string;
  snippet: string;
}

export interface RawMeasurementEvidencePayload {
  responseText: string | null;
  citations: RawCitation[];
  error: { code: string; message: string } | null;
}

export interface RawMeasurementEvidenceReference {
  objectRef: string;
  contentHash: string;
}

export interface MeasurementSurfaceExecutionResult {
  providerKey: string;
  surfaceKey: string;
  acquisitionMethod: string;
  adapterVersion: string;
  methodVersion: string;
  observedAt: string;
  status: PromptRunStatus;
  observation: MeasurementObservationValue;
  cost: MeasurementCost;
  rawEvidence: RawMeasurementEvidencePayload;
}

export interface MeasurementSurfaceAdapterDescriptor {
  adapterKey: string;
  adapterVersion: string;
  providerKey: string;
  surfaceKey: string;
  surfaceKind: 'SEARCH_DATA' | 'CONSUMER_SEARCH' | 'CONSUMER_AI_ANSWER';
  acquisitionClass: MeasurementAcquisitionClass;
  acquisitionMethod: string;
  termsVersion: string;
  processingRegion: string;
  storageRegion: string;
  retentionPolicy: string;
  trainingPolicy: string;
  subprocessors: string[];
  requiresAuthorization: boolean;
}

export interface MeasurementSurfaceExecutionCommand {
  measurementRunId: string;
  tenantId: string;
  workspaceId: string;
  /** Stable for the exact run/prompt/scope/repetition slot across retries. */
  idempotencyKey: string;
  /** Adapters must pass this signal through to every external request. */
  signal: AbortSignal;
  scenario: MeasurementScenarioSnapshot;
  prompt: { id: string; ordinal: number; text: string };
  scope: MeasurementScope;
  repetition: number;
}

export interface MeasurementSurfaceAdapter {
  adapterKey: string;
  adapterVersion: string;
  describe(): MeasurementSurfaceAdapterDescriptor;
  executeScenario(
    command: MeasurementSurfaceExecutionCommand,
  ): Promise<MeasurementSurfaceExecutionResult>;
}

export interface MeasurementSurfaceAdapterRegistry {
  resolve(
    providerKey: string,
    surfaceKey: string,
    adapterVersion: string,
  ): MeasurementSurfaceAdapter | null;
}

export interface MeasurementProviderPolicyRecord {
  id: string;
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
  approvedByUserId: string;
  approvedAt: string;
}

export interface MeasurementExecutionPlan {
  run: MeasurementRunRecord;
  prompts: { id: string; ordinal: number; text: string }[];
  scopes: MeasurementScope[];
  policy: MeasurementProviderPolicyRecord | null;
  completedSlots?: {
    promptRun: PromptRunRecord;
    observations: StoredMetricObservation[];
  }[];
  snapshotCount?: number;
}

export interface MeasurementApprovedSource {
  promptSetId: string;
  promptRevisionId: string;
  promptContentHash: string;
  scenarioContentHash: string;
  prompts: { id: string; ordinal: number; text: string }[];
  scenarioSnapshot: MeasurementScenarioSnapshot;
  adapterVersion: string;
  expectedPromptRunCount: number;
}

export interface StoredMetricObservation {
  id: string;
  promptRunId: string;
  metricKey: 'MENTION_RATE' | 'CITATION_RATE' | 'ACCURACY_RATE' | 'COVERAGE_RATE';
  classification: MetricClassification;
  cohort: MetricCohort;
}

export interface StoredMetricSnapshot {
  id: string;
  measurementRunId: string;
  metricKey: StoredMetricObservation['metricKey'];
  methodVersion: string;
  cohort: MetricCohort;
  numerator: number;
  eligibleDenominator: number;
  value: number | null;
  excludedCounts: {
    ERROR: number;
    NOT_CHECKED: number;
    INCONCLUSIVE: number;
    NOT_APPLICABLE: number;
  };
  sourceObservationIds: string[];
  sourceHash: string;
  contentHash: string;
}

export interface MeasurementDashboardSource {
  run: MeasurementRunRecord;
  promptRuns: PromptRunRecord[];
  snapshots: StoredMetricSnapshot[];
}

export interface StartMeasurementResult {
  measurementRun: MeasurementRunRecord;
  job: JobRecord;
}
