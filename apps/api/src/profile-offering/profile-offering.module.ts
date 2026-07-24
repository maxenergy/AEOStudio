import { Module, type DynamicModule } from '@nestjs/common';
import {
  ProfileOfferingService,
  type ProfileOfferingStore,
} from '@aeostudio/application/profile-offering';
import type { TenancyStore } from '@aeostudio/application/identity-access';
import { v7 as uuidv7 } from 'uuid';

import { MissingProfileOfferingStore } from './missing-profile-offering-store.js';
import { ProfileOfferingController } from './profile-offering.controller.js';
import { PROFILE_OFFERING_SERVICE } from './profile-offering.tokens.js';

export interface ProfileOfferingModuleOptions {
  profileOfferingStore?: ProfileOfferingStore;
  tenancyStore?: TenancyStore;
}

@Module({})
export class ProfileOfferingModule {
  static register(options: ProfileOfferingModuleOptions = {}): DynamicModule {
    return {
      module: ProfileOfferingModule,
      controllers: [ProfileOfferingController],
      providers: [
        {
          provide: PROFILE_OFFERING_SERVICE,
          useValue: new ProfileOfferingService(
            options.profileOfferingStore ?? new MissingProfileOfferingStore(),
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
