import { Module, type DynamicModule } from '@nestjs/common';
import { KnowledgeService, type KnowledgeStore } from '@aeostudio/application/knowledge';
import type { TenancyStore } from '@aeostudio/application/identity-access';
import { v7 as uuidv7 } from 'uuid';

import { InMemoryKnowledgeStore } from './in-memory-knowledge-store.js';
import { KnowledgeController } from './knowledge.controller.js';
import { KNOWLEDGE_SERVICE } from './knowledge.tokens.js';

export interface KnowledgeModuleOptions {
  knowledgeStore?: KnowledgeStore;
  tenancyStore?: TenancyStore;
}

@Module({})
export class KnowledgeModule {
  static register(options: KnowledgeModuleOptions = {}): DynamicModule {
    return {
      module: KnowledgeModule,
      controllers: [KnowledgeController],
      providers: [
        {
          provide: KNOWLEDGE_SERVICE,
          useValue: new KnowledgeService(
            options.knowledgeStore ?? new InMemoryKnowledgeStore(),
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
