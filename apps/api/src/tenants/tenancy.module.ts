import { Module, type DynamicModule } from '@nestjs/common';
import { TenancyService, type TenancyStore } from '@aeostudio/application/identity-access';
import { v7 as uuidv7 } from 'uuid';

import { MissingTenancyStore } from './missing-tenancy-store.js';
import { TenancyController } from './tenancy.controller.js';
import { TENANCY_SERVICE } from './tenancy.tokens.js';

export interface TenancyModuleOptions {
  tenancyStore?: TenancyStore;
}

@Module({})
export class TenancyModule {
  static register(options: TenancyModuleOptions = {}): DynamicModule {
    return {
      module: TenancyModule,
      controllers: [TenancyController],
      providers: [
        {
          provide: TENANCY_SERVICE,
          useValue: new TenancyService(options.tenancyStore ?? new MissingTenancyStore(), {
            next: uuidv7,
          }),
        },
      ],
    };
  }
}
