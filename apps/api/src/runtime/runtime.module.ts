import { Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import type { RuntimeBuildIdentity } from '@aeostudio/adapters';

import { RuntimeBuildIdentityController } from './runtime-build-identity.controller.js';
import { RUNTIME_BUILD_IDENTITY } from './runtime.tokens.js';

class RuntimeCleanup implements OnApplicationShutdown {
  constructor(private readonly cleanup: () => Promise<void>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.cleanup();
  }
}

@Module({})
export class RuntimeModule {
  static register(
    cleanup: () => Promise<void>,
    buildIdentity: RuntimeBuildIdentity | null,
  ): DynamicModule {
    return {
      module: RuntimeModule,
      controllers: [RuntimeBuildIdentityController],
      providers: [
        { provide: RuntimeCleanup, useValue: new RuntimeCleanup(cleanup) },
        { provide: RUNTIME_BUILD_IDENTITY, useValue: buildIdentity },
      ],
    };
  }
}
