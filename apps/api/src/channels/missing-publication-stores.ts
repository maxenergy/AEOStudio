import type {
  ChannelAuthorizationStore,
  PublicationCommandStore,
  PublicationQueryStore,
  PublicationRemoteStatusRefreshStore,
  RuntimeChannelAdapterRegistry,
} from '@aeostudio/application/channels-publishing';

export class MissingChannelAuthorizationStore implements ChannelAuthorizationStore {
  create(): Promise<never> {
    return Promise.reject(new Error('CHANNEL_AUTHORIZATION_STORE_NOT_CONFIGURED'));
  }

  revoke(): Promise<never> {
    return Promise.reject(new Error('CHANNEL_AUTHORIZATION_STORE_NOT_CONFIGURED'));
  }

  list(): Promise<never> {
    return Promise.reject(new Error('CHANNEL_AUTHORIZATION_STORE_NOT_CONFIGURED'));
  }

  findForTarget(): Promise<null> {
    return Promise.resolve(null);
  }
}

export class MissingRuntimeChannelAdapterRegistry implements RuntimeChannelAdapterRegistry {
  resolve(): null {
    return null;
  }
}

export class MissingPublicationCommandStore implements PublicationCommandStore {
  findExisting(): Promise<{ outcome: 'NOT_FOUND' }> {
    return Promise.resolve({ outcome: 'NOT_FOUND' });
  }

  submit(): Promise<{ outcome: 'PIPELINE_UNAVAILABLE' }> {
    return Promise.resolve({ outcome: 'PIPELINE_UNAVAILABLE' });
  }
}

export class MissingPublicationQueryStore implements PublicationQueryStore {
  findDetail(): Promise<null> {
    return Promise.resolve(null);
  }
}

export class MissingPublicationRemoteStatusRefreshStore implements PublicationRemoteStatusRefreshStore {
  refresh(): Promise<{ outcome: 'ADAPTER_UNAVAILABLE' }> {
    return Promise.resolve({ outcome: 'ADAPTER_UNAVAILABLE' });
  }
}
