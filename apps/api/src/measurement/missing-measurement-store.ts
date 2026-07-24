import type { MeasurementStore } from '@aeostudio/application/measurement';

export class MissingMeasurementStore implements MeasurementStore {
  private unavailable(): never {
    throw new Error('MEASUREMENT_STORE_NOT_CONFIGURED');
  }

  prepareRun(): Promise<never> {
    return this.unavailable();
  }
  bindJob(): Promise<never> {
    return this.unavailable();
  }
  setProviderPolicy(): Promise<never> {
    return this.unavailable();
  }
  findProviderPolicy(): Promise<never> {
    return this.unavailable();
  }
  findRun(): Promise<never> {
    return this.unavailable();
  }
  listPromptRuns(): Promise<never> {
    return this.unavailable();
  }
  findPromptRun(): Promise<never> {
    return this.unavailable();
  }
  loadDashboard(): Promise<never> {
    return this.unavailable();
  }
  loadExecutionPlan(): Promise<never> {
    return this.unavailable();
  }
  markRunning(): Promise<never> {
    return this.unavailable();
  }
  recordPromptRun(): Promise<never> {
    return this.unavailable();
  }
  completeRun(): Promise<never> {
    return this.unavailable();
  }
}
