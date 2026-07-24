import { describe, expect, test } from 'vitest';

import { resolveProductionWorkerMode } from './production-worker-mode.js';

describe('production Worker mode', () => {
  test.each([
    [undefined, 'worker'],
    ['', 'worker'],
    ['worker', 'worker'],
    ['tenant-data-broker', 'tenant-data-broker'],
  ] as const)('maps %s to the exact supported process', (value, expected) => {
    expect(
      resolveProductionWorkerMode({
        ...(value === undefined ? {} : { AEOSTUDIO_WORKER_MODE: value }),
      }),
    ).toBe(expected);
  });

  test.each(['broker', 'TENANT-DATA-BROKER', ' tenant-data-broker ', 'measurement'])(
    'fails closed for unsupported mode %s',
    (value) => {
      expect(() => resolveProductionWorkerMode({ AEOSTUDIO_WORKER_MODE: value })).toThrow(
        'PRODUCTION_WORKER_MODE_INVALID',
      );
    },
  );
});
