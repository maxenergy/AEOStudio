import { Module, type DynamicModule } from '@nestjs/common';
import {
  SiteCrawlService,
  type SiteCrawlStore,
  type SiteOwnershipVerifier,
} from '@aeostudio/application/site-crawl';
import type { TenancyStore } from '@aeostudio/application/identity-access';
import { JobBudgetService, type JobBudgetStore } from '@aeostudio/application/jobs-budgets';
import { v7 as uuidv7 } from 'uuid';

import { MissingJobBudgetStore } from '../jobs/missing-job-budget-store.js';
import { MissingSiteCrawlStore } from './missing-site-crawl-store.js';
import { SitesController } from './sites.controller.js';
import { SITE_CRAWL_SERVICE, SITE_JOB_BUDGET_SERVICE } from './sites.tokens.js';

export interface SitesModuleOptions {
  siteCrawlStore?: SiteCrawlStore;
  siteOwnershipVerifier?: SiteOwnershipVerifier;
  jobBudgetStore?: JobBudgetStore;
  tenancyStore?: TenancyStore;
}

@Module({})
export class SitesModule {
  static register(options: SitesModuleOptions = {}): DynamicModule {
    return {
      module: SitesModule,
      controllers: [SitesController],
      providers: [
        {
          provide: SITE_CRAWL_SERVICE,
          useValue: new SiteCrawlService(
            options.siteCrawlStore ?? new MissingSiteCrawlStore(),
            options.tenancyStore ?? new MissingTenancyAccess(),
            { next: uuidv7 },
            options.siteOwnershipVerifier ?? new MissingOwnershipVerifier(),
            { now: () => new Date() },
          ),
        },
        {
          provide: SITE_JOB_BUDGET_SERVICE,
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

class MissingOwnershipVerifier implements SiteOwnershipVerifier {
  verify(): Promise<{ matched: boolean }> {
    return Promise.reject(new Error('SITE_OWNERSHIP_VERIFIER_NOT_CONFIGURED'));
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
