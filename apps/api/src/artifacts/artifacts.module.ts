import { Module, type DynamicModule } from '@nestjs/common';
import {
  ArtifactService,
  type ArtifactPayloadStore,
  type ArtifactStore,
} from '@aeostudio/application/artifacts';
import type { TenancyStore } from '@aeostudio/application/identity-access';
import type { JobBudgetStore } from '@aeostudio/application/jobs-budgets';
import type { CapabilityBoundArtifactRevisionPayloadReader } from '@aeostudio/application/tenant-data-access';
import { v7 as uuidv7 } from 'uuid';

import { MissingJobBudgetStore } from '../jobs/missing-job-budget-store.js';
import { ArtifactsController } from './artifacts.controller.js';
import { ARTIFACT_SERVICE } from './artifacts.tokens.js';
import { MissingArtifactStore } from './missing-artifact-store.js';

export interface ArtifactsModuleOptions {
  artifactStore?: ArtifactStore;
  artifactPayloadStore?: ArtifactPayloadStore;
  artifactPayloadReader?: CapabilityBoundArtifactRevisionPayloadReader;
  jobBudgetStore?: JobBudgetStore;
  tenancyStore?: TenancyStore;
  clock?: { now(): Date };
}

@Module({})
export class ArtifactsModule {
  static register(options: ArtifactsModuleOptions = {}): DynamicModule {
    return {
      module: ArtifactsModule,
      controllers: [ArtifactsController],
      providers: [
        {
          provide: ARTIFACT_SERVICE,
          useValue: new ArtifactService(
            options.artifactStore ?? new MissingArtifactStore(),
            options.artifactPayloadStore ?? new MissingArtifactPayloadStore(),
            options.artifactPayloadReader ?? new MissingArtifactPayloadReader(),
            options.jobBudgetStore ?? new MissingJobBudgetStore(),
            options.tenancyStore ?? new MissingTenancyAccess(),
            { next: uuidv7 },
            options.clock ?? { now: () => new Date() },
          ),
        },
      ],
    };
  }
}

class MissingArtifactPayloadReader implements CapabilityBoundArtifactRevisionPayloadReader {
  readAuthenticatedArtifactRevision(): Promise<never> {
    return Promise.reject(new Error('ARTIFACT_PAYLOAD_READER_NOT_CONFIGURED'));
  }
}

class MissingArtifactPayloadStore implements ArtifactPayloadStore {
  put(): Promise<never> {
    return Promise.reject(new Error('ARTIFACT_PAYLOAD_STORE_NOT_CONFIGURED'));
  }

  get(): Promise<null> {
    return Promise.reject(new Error('ARTIFACT_PAYLOAD_STORE_NOT_CONFIGURED'));
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
