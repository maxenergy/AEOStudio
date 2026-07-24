import { Module, type DynamicModule } from '@nestjs/common';
import type { InMemorySecretLifecycleStore } from '@aeostudio/adapters/secrets';
import {
  PrivacyAuditService,
  type PlatformBreakGlassAuthorizer,
  type PrivacyAuditStore,
} from '@aeostudio/application/privacy-audit';
import type { TenancyStore } from '@aeostudio/application/identity-access';
import { v7 as uuidv7 } from 'uuid';

import { MissingPrivacyAuditStore } from './missing-privacy-audit-store.js';
import {
  MissingDeletionReceiptTokenService,
  type DeletionReceiptTokenService,
} from './deletion-receipt-token.js';
import { DeletionReceiptController } from './deletion-receipt.controller.js';
import { PrivacyController } from './privacy.controller.js';
import {
  DELETION_RECEIPT_TOKEN_SERVICE,
  PRIVACY_AUDIT_SERVICE,
  PRIVACY_AUDIT_STORE,
  PRIVACY_TENANCY_STORE,
} from './privacy.tokens.js';

export interface PrivacyModuleOptions {
  /** Explicit test/development composition hook; production uses the database lifecycle store. */
  fakeSecretLifecycleStore?: InMemorySecretLifecycleStore;
  deletionReceiptTokenService?: DeletionReceiptTokenService;
  platformBreakGlassAuthorizer?: PlatformBreakGlassAuthorizer;
  privacyAuditStore?: PrivacyAuditStore;
  tenancyStore?: TenancyStore;
  clock?: { now(): Date };
}

@Module({})
export class PrivacyModule {
  static register(options: PrivacyModuleOptions = {}): DynamicModule {
    const privacyAuditStore = options.privacyAuditStore ?? new MissingPrivacyAuditStore();
    const tenancyStore = options.tenancyStore ?? new MissingTenancyAccess();
    return {
      module: PrivacyModule,
      controllers: [PrivacyController, DeletionReceiptController],
      providers: [
        { provide: PRIVACY_AUDIT_STORE, useValue: privacyAuditStore },
        { provide: PRIVACY_TENANCY_STORE, useValue: tenancyStore },
        {
          provide: DELETION_RECEIPT_TOKEN_SERVICE,
          useValue: options.deletionReceiptTokenService ?? new MissingDeletionReceiptTokenService(),
        },
        {
          provide: PRIVACY_AUDIT_SERVICE,
          useValue: new PrivacyAuditService(
            privacyAuditStore,
            tenancyStore,
            { next: uuidv7 },
            options.clock ?? { now: () => new Date() },
            options.platformBreakGlassAuthorizer,
          ),
        },
      ],
    };
  }
}

class MissingTenancyAccess {
  resolveTenantContext(): Promise<never> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }

  resolvePrivacyGovernanceContext(): Promise<never> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }

  appendDeniedAudit(): Promise<never> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }
}
