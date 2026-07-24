import { Module, type DynamicModule } from '@nestjs/common';
import {
  EvidenceClaimService,
  type EvidenceClaimStore,
  type EvidenceObjectStore,
} from '@aeostudio/application/evidence-claims';
import type { TenancyStore } from '@aeostudio/application/identity-access';
import { v7 as uuidv7 } from 'uuid';

import { ClaimsController } from './claims.controller.js';
import { EVIDENCE_CLAIM_SERVICE } from './claims.tokens.js';
import { MissingEvidenceClaimStore } from './missing-evidence-claim-store.js';
import { MissingEvidenceObjectStore } from './missing-evidence-object-store.js';

export interface ClaimsModuleOptions {
  evidenceClaimStore?: EvidenceClaimStore;
  evidenceObjectStore?: EvidenceObjectStore;
  tenancyStore?: TenancyStore;
  clock?: { now(): Date };
}

@Module({})
export class ClaimsModule {
  static register(options: ClaimsModuleOptions = {}): DynamicModule {
    return {
      module: ClaimsModule,
      controllers: [ClaimsController],
      providers: [
        {
          provide: EVIDENCE_CLAIM_SERVICE,
          useValue: new EvidenceClaimService(
            options.evidenceClaimStore ?? new MissingEvidenceClaimStore(),
            options.evidenceObjectStore ?? new MissingEvidenceObjectStore(),
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
