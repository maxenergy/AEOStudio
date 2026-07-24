import { Module, type DynamicModule } from '@nestjs/common';
import {
  MeasurementService,
  type ManualMeasurementImportStore,
  type MeasurementRawEvidenceStore,
  type MeasurementStore,
  type MeasurementSurfaceAdapterRegistry,
} from '@aeostudio/application/measurement';
import type { TenancyStore } from '@aeostudio/application/identity-access';
import type { JobBudgetStore } from '@aeostudio/application/jobs-budgets';
import type { PromptResearchStore } from '@aeostudio/application/prompt-research';
import { v7 as uuidv7 } from 'uuid';

import { MissingJobBudgetStore } from '../jobs/missing-job-budget-store.js';
import { MissingPromptResearchStore } from '../prompts/missing-prompt-research-store.js';
import { MeasurementController } from './measurement.controller.js';
import { MEASUREMENT_SERVICE } from './measurement.tokens.js';
import { MissingMeasurementStore } from './missing-measurement-store.js';

export interface MeasurementModuleOptions {
  measurementStore?: MeasurementStore;
  measurementRawEvidenceStore?: MeasurementRawEvidenceStore;
  manualMeasurementImportStore?: ManualMeasurementImportStore;
  measurementSurfaceAdapters?: MeasurementSurfaceAdapterRegistry;
  promptResearchStore?: PromptResearchStore;
  jobBudgetStore?: JobBudgetStore;
  tenancyStore?: TenancyStore;
  clock?: { now(): Date };
}

@Module({})
export class MeasurementModule {
  static register(options: MeasurementModuleOptions = {}): DynamicModule {
    return {
      module: MeasurementModule,
      controllers: [MeasurementController],
      providers: [
        {
          provide: MEASUREMENT_SERVICE,
          useValue: new MeasurementService(
            options.measurementStore ?? new MissingMeasurementStore(),
            options.measurementRawEvidenceStore ?? new MissingRawEvidenceStore(),
            options.manualMeasurementImportStore ?? new MissingManualMeasurementImportStore(),
            options.jobBudgetStore ?? new MissingJobBudgetStore(),
            options.promptResearchStore ?? new MissingPromptResearchStore(),
            options.tenancyStore ?? new MissingTenancyAccess(),
            { next: uuidv7 },
            options.clock ?? { now: () => new Date() },
            options.measurementSurfaceAdapters,
          ),
        },
      ],
    };
  }
}

class MissingManualMeasurementImportStore implements ManualMeasurementImportStore {
  submit(): Promise<never> {
    return Promise.reject(new Error('MANUAL_MEASUREMENT_IMPORT_STORE_NOT_CONFIGURED'));
  }
  find(): Promise<never> {
    return Promise.reject(new Error('MANUAL_MEASUREMENT_IMPORT_STORE_NOT_CONFIGURED'));
  }
  findWithSlots(): Promise<never> {
    return Promise.reject(new Error('MANUAL_MEASUREMENT_IMPORT_STORE_NOT_CONFIGURED'));
  }
  review(): Promise<never> {
    return Promise.reject(new Error('MANUAL_MEASUREMENT_IMPORT_STORE_NOT_CONFIGURED'));
  }
  readReviewedSlot(): Promise<never> {
    return Promise.reject(new Error('MANUAL_MEASUREMENT_IMPORT_STORE_NOT_CONFIGURED'));
  }
}

class MissingRawEvidenceStore implements MeasurementRawEvidenceStore {
  put(): Promise<never> {
    return Promise.reject(new Error('MEASUREMENT_RAW_EVIDENCE_STORE_NOT_CONFIGURED'));
  }
  get(): Promise<never> {
    return Promise.reject(new Error('MEASUREMENT_RAW_EVIDENCE_STORE_NOT_CONFIGURED'));
  }
}

class MissingTenancyAccess {
  resolveTenantContext(): Promise<null> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }
  appendDeniedAudit(): Promise<void> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }
}
