import { randomBytes } from 'node:crypto';

import { Module, type DynamicModule } from '@nestjs/common';
import {
  ChannelAuthorizationService,
  ChannelPackageService,
  ChannelRegistryService,
  DefaultChannelPackageTransformerRegistry,
  PublicationCommandService,
  PublicationEligibilityService,
  PublicationQueryService,
  PublicationRemoteStatusRefreshService,
  SignedWebhookEndpointVerificationService,
  type ChannelAuthorizationStore,
  type ChannelPackagePayloadStore,
  type ChannelPackageStore,
  type ChannelPackageTransformerRegistry,
  type ChannelRegistryStore,
  type PublicationCommandStore,
  type PublicationQueryStore,
  type PublicationRemoteStatusRefreshStore,
  type RuntimeChannelAdapterRegistry,
  type SignedWebhookEndpointOwnershipVerifier,
  type SignedWebhookEndpointVerificationStore,
} from '@aeostudio/application/channels-publishing';
import type { ArtifactPayloadStore, ArtifactStore } from '@aeostudio/application/artifacts';
import type { TenancyStore } from '@aeostudio/application/identity-access';
import type {
  CapabilityBoundArtifactRevisionPayloadReader,
  CapabilityBoundChannelPackagePayloadReader,
} from '@aeostudio/application/tenant-data-access';
import { v7 as uuidv7 } from 'uuid';

import { MissingArtifactStore } from '../artifacts/missing-artifact-store.js';
import { ChannelAuthorizationsController } from './channel-authorizations.controller.js';
import { ChannelPackagesController } from './channel-packages.controller.js';
import { ChannelsController } from './channels.controller.js';
import {
  CHANNEL_AUTHORIZATION_SERVICE,
  CHANNEL_PACKAGE_SERVICE,
  CHANNEL_REGISTRY_SERVICE,
  PUBLICATION_COMMAND_SERVICE,
  PUBLICATION_ELIGIBILITY_SERVICE,
  PUBLICATION_QUERY_SERVICE,
  PUBLICATION_REMOTE_STATUS_REFRESH_SERVICE,
  SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_SERVICE,
} from './channels.tokens.js';
import {
  MissingChannelPackagePayloadStore,
  MissingChannelPackageStore,
} from './missing-channel-package-stores.js';
import { MissingChannelRegistryStore } from './missing-channel-registry-store.js';
import {
  MissingChannelAuthorizationStore,
  MissingPublicationCommandStore,
  MissingPublicationQueryStore,
  MissingPublicationRemoteStatusRefreshStore,
  MissingRuntimeChannelAdapterRegistry,
} from './missing-publication-stores.js';
import { PublicationsController } from './publications.controller.js';
import { SignedWebhookEndpointVerificationsController } from './signed-webhook-endpoint-verifications.controller.js';

export interface ChannelsModuleOptions {
  artifactStore?: ArtifactStore;
  artifactPayloadStore?: ArtifactPayloadStore;
  artifactPayloadReader?: CapabilityBoundArtifactRevisionPayloadReader;
  channelPackageStore?: ChannelPackageStore;
  channelPackagePayloadStore?: ChannelPackagePayloadStore;
  channelPackagePayloadReader?: CapabilityBoundChannelPackagePayloadReader;
  channelPackageTransformers?: ChannelPackageTransformerRegistry;
  channelRegistryStore?: ChannelRegistryStore;
  channelAuthorizationStore?: ChannelAuthorizationStore;
  publicationCommandStore?: PublicationCommandStore;
  publicationQueryStore?: PublicationQueryStore;
  publicationRemoteStatusRefreshStore?: PublicationRemoteStatusRefreshStore;
  runtimeChannelAdapters?: RuntimeChannelAdapterRegistry;
  signedWebhookEndpointOwnershipVerifier?: SignedWebhookEndpointOwnershipVerifier;
  signedWebhookEndpointVerificationStore?: SignedWebhookEndpointVerificationStore;
  tenancyStore?: TenancyStore;
  clock?: { now(): Date };
}

@Module({})
export class ChannelsModule {
  static register(options: ChannelsModuleOptions = {}): DynamicModule {
    const tenancy = options.tenancyStore ?? new MissingTenancyAccess();
    const registry = options.channelRegistryStore ?? new MissingChannelRegistryStore();
    const authorizations =
      options.channelAuthorizationStore ?? new MissingChannelAuthorizationStore();
    const packagePayloads =
      options.channelPackagePayloadStore ?? new MissingChannelPackagePayloadStore();
    const clock = options.clock ?? { now: () => new Date() };
    const packageService = new ChannelPackageService(
      options.channelPackageStore ?? new MissingChannelPackageStore(),
      packagePayloads,
      options.channelPackagePayloadReader ?? new MissingChannelPackagePayloadReader(),
      registry,
      options.channelPackageTransformers ?? new DefaultChannelPackageTransformerRegistry(),
      options.artifactStore ?? new MissingArtifactStore(),
      options.artifactPayloadReader ?? new MissingArtifactPayloadReader(),
      tenancy,
      { next: uuidv7 },
      clock,
    );
    const eligibilityService = new PublicationEligibilityService(
      packageService,
      registry,
      authorizations,
      options.runtimeChannelAdapters ?? new MissingRuntimeChannelAdapterRegistry(),
      tenancy,
      clock,
    );
    return {
      module: ChannelsModule,
      controllers: [
        ChannelsController,
        ChannelPackagesController,
        ChannelAuthorizationsController,
        PublicationsController,
        SignedWebhookEndpointVerificationsController,
      ],
      providers: [
        {
          provide: CHANNEL_REGISTRY_SERVICE,
          useValue: new ChannelRegistryService(registry, tenancy),
        },
        {
          provide: CHANNEL_PACKAGE_SERVICE,
          useValue: packageService,
        },
        {
          provide: CHANNEL_AUTHORIZATION_SERVICE,
          useValue: new ChannelAuthorizationService(
            authorizations,
            registry,
            tenancy,
            { next: uuidv7 },
            clock,
          ),
        },
        {
          provide: SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_SERVICE,
          useValue: new SignedWebhookEndpointVerificationService(
            options.signedWebhookEndpointVerificationStore ??
              new MissingSignedWebhookEndpointVerificationStore(),
            options.signedWebhookEndpointOwnershipVerifier ??
              new MissingSignedWebhookEndpointOwnershipVerifier(),
            registry,
            tenancy,
            { next: uuidv7 },
            { next: () => randomBytes(32).toString('base64url') },
            clock,
          ),
        },
        {
          provide: PUBLICATION_ELIGIBILITY_SERVICE,
          useValue: eligibilityService,
        },
        {
          provide: PUBLICATION_COMMAND_SERVICE,
          useValue: new PublicationCommandService(
            eligibilityService,
            options.publicationCommandStore ?? new MissingPublicationCommandStore(),
            tenancy,
            { next: uuidv7 },
            clock,
          ),
        },
        {
          provide: PUBLICATION_QUERY_SERVICE,
          useValue: new PublicationQueryService(
            options.publicationQueryStore ?? new MissingPublicationQueryStore(),
            tenancy,
          ),
        },
        {
          provide: PUBLICATION_REMOTE_STATUS_REFRESH_SERVICE,
          useValue: new PublicationRemoteStatusRefreshService(
            options.publicationRemoteStatusRefreshStore ??
              new MissingPublicationRemoteStatusRefreshStore(),
            tenancy,
            { next: uuidv7 },
          ),
        },
      ],
    };
  }
}

class MissingSignedWebhookEndpointVerificationStore implements SignedWebhookEndpointVerificationStore {
  createPending(): Promise<never> {
    return Promise.reject(new Error('SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_STORE_NOT_CONFIGURED'));
  }

  list(): Promise<never> {
    return Promise.reject(new Error('SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_STORE_NOT_CONFIGURED'));
  }

  findPending(): Promise<never> {
    return Promise.reject(new Error('SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_STORE_NOT_CONFIGURED'));
  }

  markVerified(): Promise<never> {
    return Promise.reject(new Error('SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_STORE_NOT_CONFIGURED'));
  }

  revoke(): Promise<never> {
    return Promise.reject(new Error('SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_STORE_NOT_CONFIGURED'));
  }

  findVerifiedEndpoint(): Promise<never> {
    return Promise.reject(new Error('SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_STORE_NOT_CONFIGURED'));
  }
}

class MissingSignedWebhookEndpointOwnershipVerifier implements SignedWebhookEndpointOwnershipVerifier {
  verifyOwnership(): Promise<{
    outcome: 'FAILED';
    reason: 'TRANSPORT_FAILED';
  }> {
    return Promise.resolve({ outcome: 'FAILED', reason: 'TRANSPORT_FAILED' });
  }
}

class MissingArtifactPayloadReader implements CapabilityBoundArtifactRevisionPayloadReader {
  readAuthenticatedArtifactRevision(): Promise<never> {
    return Promise.reject(new Error('ARTIFACT_PAYLOAD_READER_NOT_CONFIGURED'));
  }
}

class MissingChannelPackagePayloadReader implements CapabilityBoundChannelPackagePayloadReader {
  readAuthenticatedChannelPackage(): Promise<never> {
    return Promise.reject(new Error('CHANNEL_PACKAGE_PAYLOAD_READER_NOT_CONFIGURED'));
  }
}

class MissingTenancyAccess {
  resolveTenantContext(): Promise<null> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }

  appendDeniedAudit(): Promise<never> {
    return Promise.reject(new Error('TENANCY_STORE_NOT_CONFIGURED'));
  }
}
