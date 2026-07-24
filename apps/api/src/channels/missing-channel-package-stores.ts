import type {
  ChannelPackagePayloadStore,
  ChannelPackageStore,
} from '@aeostudio/application/channels-publishing';
import type { ArtifactPayloadStore } from '@aeostudio/application/artifacts';

export class MissingChannelPackageStore implements ChannelPackageStore {
  createOrFind(): Promise<never> {
    return Promise.reject(new Error('CHANNEL_PACKAGE_STORE_NOT_CONFIGURED'));
  }

  findById(): Promise<never> {
    return Promise.reject(new Error('CHANNEL_PACKAGE_STORE_NOT_CONFIGURED'));
  }
}

export class MissingChannelPackagePayloadStore implements ChannelPackagePayloadStore {
  put(): Promise<never> {
    return Promise.reject(new Error('CHANNEL_PACKAGE_PAYLOAD_STORE_NOT_CONFIGURED'));
  }

  get(): Promise<never> {
    return Promise.reject(new Error('CHANNEL_PACKAGE_PAYLOAD_STORE_NOT_CONFIGURED'));
  }
}

export class MissingArtifactPayloadStore implements ArtifactPayloadStore {
  put(): Promise<never> {
    return Promise.reject(new Error('ARTIFACT_PAYLOAD_STORE_NOT_CONFIGURED'));
  }

  get(): Promise<never> {
    return Promise.reject(new Error('ARTIFACT_PAYLOAD_STORE_NOT_CONFIGURED'));
  }
}
