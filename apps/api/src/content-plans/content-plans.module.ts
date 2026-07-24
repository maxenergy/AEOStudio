import { Module, type DynamicModule } from '@nestjs/common';
import {
  ContentPlanningService,
  type ContentPlanningStore,
} from '@aeostudio/application/content-planning';
import type { TenancyStore } from '@aeostudio/application/identity-access';
import type { JobBudgetStore } from '@aeostudio/application/jobs-budgets';
import { v7 as uuidv7 } from 'uuid';

import { MissingJobBudgetStore } from '../jobs/missing-job-budget-store.js';
import { ContentPlansController } from './content-plans.controller.js';
import { CONTENT_PLANNING_SERVICE } from './content-plans.tokens.js';
import { MissingContentPlanningStore } from './missing-content-planning-store.js';

export interface ContentPlansModuleOptions {
  contentPlanningStore?: ContentPlanningStore;
  jobBudgetStore?: JobBudgetStore;
  tenancyStore?: TenancyStore;
  clock?: { now(): Date };
}

@Module({})
export class ContentPlansModule {
  static register(options: ContentPlansModuleOptions = {}): DynamicModule {
    return {
      module: ContentPlansModule,
      controllers: [ContentPlansController],
      providers: [
        {
          provide: CONTENT_PLANNING_SERVICE,
          useValue: new ContentPlanningService(
            options.contentPlanningStore ?? new MissingContentPlanningStore(),
            options.jobBudgetStore ?? new MissingJobBudgetStore(),
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
  resolveTenantContext(): Promise<null> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }

  appendDeniedAudit(): Promise<void> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }
}
