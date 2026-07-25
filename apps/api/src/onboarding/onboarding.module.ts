import { Module, type DynamicModule } from '@nestjs/common';
import {
  OnboardingService,
  type OnboardingStore,
  type OnboardingProgressReader,
} from '@aeostudio/application/onboarding';
import type { TenancyStore } from '@aeostudio/application/identity-access';

import { InMemoryOnboardingStore } from './in-memory-onboarding-store.js';
import { OnboardingController } from './onboarding.controller.js';
import { ONBOARDING_SERVICE } from './onboarding.tokens.js';

export interface OnboardingModuleOptions {
  onboardingStore?: OnboardingStore & OnboardingProgressReader;
  tenancyStore?: TenancyStore;
}

@Module({})
export class OnboardingModule {
  static register(options: OnboardingModuleOptions = {}): DynamicModule {
    const store = options.onboardingStore ?? new InMemoryOnboardingStore();
    return {
      module: OnboardingModule,
      controllers: [OnboardingController],
      providers: [
        {
          provide: ONBOARDING_SERVICE,
          useValue: new OnboardingService(
            store,
            options.tenancyStore ?? new MissingTenancyAccess(),
            store,
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
}
