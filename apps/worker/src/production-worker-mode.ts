export type ProductionWorkerMode = 'worker' | 'tenant-data-broker';

export function resolveProductionWorkerMode(environment: {
  AEOSTUDIO_WORKER_MODE?: string | undefined;
}): ProductionWorkerMode {
  const mode = environment.AEOSTUDIO_WORKER_MODE;
  if (mode === undefined || mode === '' || mode === 'worker') return 'worker';
  if (mode === 'tenant-data-broker') return mode;
  throw new Error('PRODUCTION_WORKER_MODE_INVALID');
}
