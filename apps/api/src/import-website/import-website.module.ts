import { Module, type DynamicModule } from '@nestjs/common';
import { WebsiteImportService, type WebsiteImportStore } from '@aeostudio/application/import';
import {
  ProfileOfferingService,
  type ProfileOfferingStore,
} from '@aeostudio/application/profile-offering';
import type { TenancyStore } from '@aeostudio/application/identity-access';
import { v7 as uuidv7 } from 'uuid';

import { MissingProfileOfferingStore } from '../profile-offering/missing-profile-offering-store.js';
import { InMemoryWebsiteImportStore } from './in-memory-website-import-store.js';
import { ImportWebsiteController } from './import-website.controller.js';
import { WEBSITE_IMPORT_SERVICE } from './import-website.tokens.js';

export interface ImportWebsiteModuleOptions {
  websiteImportStore?: WebsiteImportStore;
  profileOfferingStore?: ProfileOfferingStore;
  tenancyStore?: TenancyStore;
}

@Module({})
export class ImportWebsiteModule {
  static register(options: ImportWebsiteModuleOptions = {}): DynamicModule {
    const tenancy = options.tenancyStore ?? new MissingTenancyAccess();
    return {
      module: ImportWebsiteModule,
      controllers: [ImportWebsiteController],
      providers: [
        {
          provide: WEBSITE_IMPORT_SERVICE,
          useValue: new WebsiteImportService(
            options.websiteImportStore ?? new InMemoryWebsiteImportStore(),
            new ProfileOfferingService(
              options.profileOfferingStore ?? new MissingProfileOfferingStore(),
              tenancy,
              { next: uuidv7 },
            ),
            tenancy,
            { next: uuidv7 },
            { now: () => new Date() },
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
