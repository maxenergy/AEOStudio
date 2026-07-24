import type { ChannelRegistryStore } from '@aeostudio/application/channels-publishing';

export class MissingChannelRegistryStore implements ChannelRegistryStore {
  listEntries(): ReturnType<ChannelRegistryStore['listEntries']> {
    return Promise.reject(new Error('CHANNEL_REGISTRY_STORE_NOT_CONFIGURED'));
  }
}
