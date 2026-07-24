import { Module, type DynamicModule } from '@nestjs/common';
import { ExperimentService, type ExperimentStore } from '@aeostudio/application/experiments';
import type { TenancyStore } from '@aeostudio/application/identity-access';
import { v7 as uuidv7 } from 'uuid';

import { ExperimentsController } from './experiments.controller.js';
import { EXPERIMENT_SERVICE } from './experiments.tokens.js';
import { MissingExperimentStore } from './missing-experiment-store.js';

export interface ExperimentsModuleOptions {
  experimentStore?: ExperimentStore;
  tenancyStore?: TenancyStore;
  clock?: { now(): Date };
}

@Module({})
export class ExperimentsModule {
  static register(options: ExperimentsModuleOptions = {}): DynamicModule {
    return {
      module: ExperimentsModule,
      controllers: [ExperimentsController],
      providers: [
        {
          provide: EXPERIMENT_SERVICE,
          useValue: new ExperimentService(
            options.experimentStore ?? new MissingExperimentStore(),
            options.tenancyStore ?? new MissingTenancyAccess(),
            { next: uuidv7 },
            options.clock ?? { now: () => new Date() },
          ),
        },
      ],
    };
  }
}

class MissingTenancyAccess {
  resolveTenantContext(): Promise<never> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }

  appendDeniedAudit(): Promise<never> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }
}
