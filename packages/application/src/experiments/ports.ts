import type {
  CreateExperimentRequest,
  Experiment,
  ExperimentInterventionRequest,
} from '@aeostudio/contracts/experiments';

import type { TenantContext } from '../identity-access/index.js';

export interface ExperimentRunOption {
  id: string;
  kind: 'BASELINE' | 'REMEASUREMENT';
  scenarioId: string;
  scenarioVersion: number;
  providerKey: string;
  surfaceKey: string;
  model: string;
  modelVersion: string;
  completedAt: string;
}

export type ExperimentInterventionOption =
  | {
      kind: 'PUBLISHED_PUBLICATION';
      publicationRecordId: string;
      publicationAttemptId: string;
      channelPackageId: string;
      artifactId: string;
      artifactReviewId: string;
      artifactRevisionId: string;
      artifactContentHash: string;
      observedAt: string;
    }
  | {
      kind: 'APPROVED_ARTIFACT';
      artifactId: string;
      artifactReviewId: string;
      artifactRevisionId: string;
      artifactContentHash: string;
      observedAt: string;
    };

export interface ExperimentOptions {
  baselineRuns: ExperimentRunOption[];
  remeasurementRuns: ExperimentRunOption[];
  interventions: ExperimentInterventionOption[];
  compatibleCombinations: {
    baselineRunId: string;
    intervention: ExperimentInterventionOption;
    remeasurementRunId: string;
  }[];
}

export type CreateExperimentStoreResult =
  | { outcome: 'SUCCEEDED'; experiment: Experiment; created: boolean }
  | {
      outcome: 'INCOMPATIBLE_SCENARIO';
      differingFields: string[];
      decision: 'REBASELINE' | 'STRATIFY';
      baselineCompatibilityKeys: string[];
      remeasurementCompatibilityKeys: string[];
      caveat: string;
    }
  | {
      outcome:
        | 'NOT_FOUND'
        | 'BASELINE_NOT_COMPLETED'
        | 'REMEASUREMENT_NOT_COMPLETED'
        | 'INVALID_RUN_KIND'
        | 'EXACT_INTERVENTION_REQUIRED'
        | 'INTERVENTION_NOT_APPLIED'
        | 'INTERVENTION_OUTSIDE_MEASUREMENT_WINDOW'
        | 'SNAPSHOT_SET_MISMATCH'
        | 'IDEMPOTENCY_CONFLICT'
        | 'PIPELINE_UNAVAILABLE';
    };

export interface ExperimentStore {
  listOptions(input: { context: TenantContext; limit: number }): Promise<ExperimentOptions>;
  create(input: {
    context: TenantContext;
    experimentId: string;
    baselineRunId: string;
    remeasurementRunId: string;
    intervention: ExperimentInterventionRequest;
    idempotencyKey: string;
    requestHash: string;
    createdAt: Date;
    auditEventId: string;
  }): Promise<CreateExperimentStoreResult>;
  find(input: { context: TenantContext; experimentId: string }): Promise<Experiment | null>;
}

export type ExperimentCreateCommand = CreateExperimentRequest & {
  actorSubject: string;
  tenantId: string;
  workspaceId: string;
};
