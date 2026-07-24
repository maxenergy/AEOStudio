import type { ExperimentStore } from '@aeostudio/application/experiments';

export class MissingExperimentStore implements ExperimentStore {
  listOptions(): Promise<never> {
    return Promise.reject(new Error('EXPERIMENT_STORE_NOT_CONFIGURED'));
  }

  create(): Promise<{ outcome: 'PIPELINE_UNAVAILABLE' }> {
    return Promise.resolve({ outcome: 'PIPELINE_UNAVAILABLE' });
  }

  find(): Promise<null> {
    return Promise.resolve(null);
  }
}
