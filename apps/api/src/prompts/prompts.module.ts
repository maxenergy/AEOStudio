import { Module, type DynamicModule } from '@nestjs/common';
import {
  PromptResearchService,
  type PromptResearchStore,
} from '@aeostudio/application/prompt-research';
import type { TenancyStore } from '@aeostudio/application/identity-access';
import { v7 as uuidv7 } from 'uuid';

import { MissingPromptResearchStore } from './missing-prompt-research-store.js';
import { PromptsController } from './prompts.controller.js';
import { PROMPT_RESEARCH_SERVICE } from './prompts.tokens.js';

export interface PromptsModuleOptions {
  promptResearchStore?: PromptResearchStore;
  tenancyStore?: TenancyStore;
  clock?: { now(): Date };
}

@Module({})
export class PromptsModule {
  static register(options: PromptsModuleOptions = {}): DynamicModule {
    return {
      module: PromptsModule,
      controllers: [PromptsController],
      providers: [
        {
          provide: PROMPT_RESEARCH_SERVICE,
          useValue: new PromptResearchService(
            options.promptResearchStore ?? new MissingPromptResearchStore(),
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
