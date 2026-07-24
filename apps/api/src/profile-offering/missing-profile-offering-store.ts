import type { ProfileOfferingStore } from '@aeostudio/application/profile-offering';
import type { OfferingRevision, ProfileRevision } from '@aeostudio/domain/profile-offering';

export class MissingProfileOfferingStore implements ProfileOfferingStore {
  createProfile(): Promise<ProfileRevision> {
    return Promise.reject(new Error('PROFILE_OFFERING_STORE_NOT_CONFIGURED'));
  }

  createProfileRevision(): Promise<ProfileRevision | null> {
    return Promise.reject(new Error('PROFILE_OFFERING_STORE_NOT_CONFIGURED'));
  }

  findProfileRevision(): Promise<ProfileRevision | null> {
    return Promise.reject(new Error('PROFILE_OFFERING_STORE_NOT_CONFIGURED'));
  }

  createOffering(): Promise<OfferingRevision | null> {
    return Promise.reject(new Error('PROFILE_OFFERING_STORE_NOT_CONFIGURED'));
  }

  createOfferingRevision(): Promise<OfferingRevision | null> {
    return Promise.reject(new Error('PROFILE_OFFERING_STORE_NOT_CONFIGURED'));
  }

  findOfferingRevision(): Promise<OfferingRevision | null> {
    return Promise.reject(new Error('PROFILE_OFFERING_STORE_NOT_CONFIGURED'));
  }

  listProfiles(): Promise<never> {
    return Promise.reject(new Error('PROFILE_OFFERING_STORE_NOT_CONFIGURED'));
  }

  listOfferings(): Promise<never> {
    return Promise.reject(new Error('PROFILE_OFFERING_STORE_NOT_CONFIGURED'));
  }
}
