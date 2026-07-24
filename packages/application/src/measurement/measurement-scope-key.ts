import type { MeasurementScope } from './types.js';

/** Collision-free, bounded identity for a Measurement scope. */
export function measurementScopeKey(scope: MeasurementScope): string {
  return [scope.market, scope.locale, scope.region]
    .map((value) => `${value.length}:${value}`)
    .join('');
}
