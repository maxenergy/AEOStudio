import { Module, type DynamicModule } from '@nestjs/common';
import { JobBudgetService, type JobBudgetStore } from '@aeostudio/application/jobs-budgets';
import type { TenancyStore } from '@aeostudio/application/identity-access';
import { v7 as uuidv7 } from 'uuid';

import { JobsController } from './jobs.controller.js';
import { JOB_BUDGET_SERVICE } from './jobs.tokens.js';
import { MissingJobBudgetStore } from './missing-job-budget-store.js';

export interface JobsModuleOptions {
  jobBudgetStore?: JobBudgetStore;
  tenancyStore?: TenancyStore;
}

@Module({})
export class JobsModule {
  static register(options: JobsModuleOptions = {}): DynamicModule {
    return {
      module: JobsModule,
      controllers: [JobsController],
      providers: [
        {
          provide: JOB_BUDGET_SERVICE,
          useValue: new JobBudgetService(
            options.jobBudgetStore ?? new MissingJobBudgetStore(),
            options.tenancyStore ?? new MissingTenancyAccess(),
            { next: uuidv7 },
          ),
        },
      ],
    };
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
