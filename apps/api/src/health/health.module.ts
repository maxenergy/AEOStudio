import { Module, type DynamicModule } from '@nestjs/common';

import { HealthController, type ReadinessCheck } from './health.controller.js';
import { READINESS_CHECK } from './health.tokens.js';

@Module({})
export class HealthModule {
  static register(readiness: ReadinessCheck): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [{ provide: READINESS_CHECK, useValue: readiness }],
    };
  }
}
