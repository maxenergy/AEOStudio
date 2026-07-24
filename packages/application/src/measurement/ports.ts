import type { JobBudgetStore } from '../jobs-budgets/index.js';
import type { TenantContext } from '../identity-access/index.js';
import type {
  MeasurementApprovedSource,
  MeasurementDashboardSource,
  MeasurementDrillDownDimension,
  MeasurementExecutionPlan,
  ManualMeasurementImportRecord,
  ManualMeasurementImportSlot,
  MeasurementProviderPolicyRecord,
  MeasurementRunRecord,
  PromptRunRecord,
  RawMeasurementEvidencePayload,
  RawMeasurementEvidenceReference,
  StoredMetricObservation,
  StoredMetricSnapshot,
} from './types.js';

export interface MeasurementPersistenceLease {
  jobId: string;
  leaseToken: string;
}

export type MeasurementLeaseFencedWriteResult = 'SUCCEEDED' | 'CONFLICT' | 'LEASE_LOST';

export type MeasurementLeaseFencedCompletionResult =
  | { outcome: 'SUCCEEDED'; measurementRun: MeasurementRunRecord }
  | { outcome: 'CONFLICT' | 'LEASE_LOST' };

export type MeasurementRawEvidenceWriteResult =
  { outcome: 'SUCCEEDED'; reference: RawMeasurementEvidenceReference } | { outcome: 'LEASE_LOST' };

export interface MeasurementStore {
  prepareRun(input: {
    context: TenantContext;
    measurementRunId: string;
    approvedSource: MeasurementApprovedSource;
    kind: 'BASELINE' | 'REMEASUREMENT';
    idempotencyKey: string;
    createdAt: Date;
    auditEventId: string;
  }): Promise<MeasurementRunRecord | null>;
  bindJob(input: {
    context: TenantContext;
    measurementRunId: string;
    jobId: string;
  }): Promise<MeasurementRunRecord | null>;
  setProviderPolicy(input: {
    context: TenantContext;
    policyId: string;
    providerKey: string;
    surfaceKey: string;
    adapterVersion: string;
    termsVersion: string;
    termsApproved: boolean;
    authorizationApproved: boolean;
    crossBorderApproved: boolean;
    purpose: string;
    policyVersion: string;
    approvedAt: Date;
    auditEventId: string;
  }): Promise<MeasurementProviderPolicyRecord>;
  findProviderPolicy(input: {
    context: TenantContext;
    providerKey: string;
    surfaceKey: string;
  }): Promise<MeasurementProviderPolicyRecord | null>;
  findRun(input: {
    context: TenantContext;
    measurementRunId: string;
  }): Promise<MeasurementRunRecord | null>;
  listPromptRuns(input: {
    context: TenantContext;
    measurementRunId: string;
    limit: number;
    offset: number;
    scopeKey?: string;
    dimension?: MeasurementDrillDownDimension;
  }): Promise<{ promptRuns: PromptRunRecord[]; total: number } | null>;
  findPromptRun(input: {
    context: TenantContext;
    measurementRunId: string;
    promptRunId: string;
  }): Promise<{
    promptRun: PromptRunRecord;
    rawEvidenceRef: RawMeasurementEvidenceReference | null;
  } | null>;
  loadDashboard(input: {
    context: TenantContext;
    measurementRunId: string;
  }): Promise<MeasurementDashboardSource | null>;
  loadExecutionPlan(input: {
    context: TenantContext;
    measurementRunId: string;
  }): Promise<MeasurementExecutionPlan | null>;
  markRunning(input: {
    context: TenantContext;
    measurementRunId: string;
    startedAt: Date;
    lease: MeasurementPersistenceLease | null;
  }): Promise<MeasurementLeaseFencedWriteResult>;
  recordPromptRun(input: {
    context: TenantContext;
    promptRun: PromptRunRecord;
    rawEvidenceRef: RawMeasurementEvidenceReference | null;
    observations: StoredMetricObservation[];
    lease: MeasurementPersistenceLease | null;
  }): Promise<MeasurementLeaseFencedWriteResult>;
  completeRun(input: {
    context: TenantContext;
    measurementRunId: string;
    snapshots: StoredMetricSnapshot[];
    completedAt: Date;
    auditEventId: string;
    lease: MeasurementPersistenceLease | null;
  }): Promise<MeasurementLeaseFencedCompletionResult>;
}

export interface MeasurementRawEvidenceStore {
  put(input: {
    tenantId: string;
    workspaceId: string;
    measurementRunId: string;
    promptRunId: string;
    payload: RawMeasurementEvidencePayload;
    lease: MeasurementPersistenceLease | null;
  }): Promise<MeasurementRawEvidenceWriteResult>;
  get(input: {
    tenantId: string;
    workspaceId: string;
    objectRef: string;
    contentHash: string;
  }): Promise<RawMeasurementEvidencePayload | null>;
}

export interface ManualMeasurementImportStore {
  submit(input: {
    context: TenantContext;
    manualImport: ManualMeasurementImportRecord;
    slots: ManualMeasurementImportSlot[];
    idempotencyKey: string;
    auditEventId: string;
  }): Promise<
    | { outcome: 'SUCCEEDED'; manualImport: ManualMeasurementImportRecord }
    | { outcome: 'IDEMPOTENCY_CONFLICT' }
  >;
  find(input: {
    context: TenantContext;
    manualImportId: string;
  }): Promise<ManualMeasurementImportRecord | null>;
  findWithSlots(input: { context: TenantContext; manualImportId: string }): Promise<{
    manualImport: ManualMeasurementImportRecord;
    slots: ManualMeasurementImportSlot[];
  } | null>;
  review(input: {
    context: TenantContext;
    manualImportId: string;
    expectedContentHash: string;
    decision: 'APPROVE' | 'REJECT';
    note: string | null;
    reviewedAt: Date;
    auditEventId: string;
  }): Promise<
    | { outcome: 'SUCCEEDED'; manualImport: ManualMeasurementImportRecord }
    | {
        outcome:
          'NOT_FOUND' | 'HASH_MISMATCH' | 'ALREADY_REVIEWED' | 'SELF_REVIEW' | 'INVALID_SLOT_SET';
      }
  >;
  readReviewedSlot(input: {
    tenantId: string;
    workspaceId: string;
    actorId: string;
    manualImportId: string;
    expectedContentHash: string;
    promptId: string;
    scopeKey: string;
    repetition: number;
  }): Promise<
    | { outcome: 'FOUND'; slot: ManualMeasurementImportSlot }
    | { outcome: 'MISSING'; costCurrency: string }
    | { outcome: 'INVALID'; costCurrency?: string }
  >;
}

export type MeasurementJobStore = JobBudgetStore;
