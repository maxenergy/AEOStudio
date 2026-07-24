import { describe, expect, test, vi } from 'vitest';

import { resolveGenerationCapacityProbe } from './generation-capacity-probe.js';

const capacityRequestId = '00000000-0000-7000-8000-000000000050';

describe('generation capacity probe', () => {
  test('holds only the explicitly marked staging load run after its Job lease is active', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const probe = resolveGenerationCapacityProbe(
      {
        AEO_ENVIRONMENT: 'staging',
        GENERATION_CAPACITY_PROBE_REQUEST_ID_SUFFIX: '0050',
        GENERATION_CAPACITY_PROBE_HOLD_MS: '10000',
      },
      sleep,
    );
    if (probe === undefined) throw new Error('GENERATION_CAPACITY_PROBE_REQUIRED');

    await probe.holdAfterClaim({
      traceContext: {
        requestId: capacityRequestId,
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    });
    await probe.holdAfterClaim({
      traceContext: {
        requestId: '00000000-0000-7000-8000-000000000051',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    });
    await probe.holdAfterClaim({});

    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(10_000);
  });

  test('fails closed when the capacity-only hold is configured outside staging', () => {
    expect(() =>
      resolveGenerationCapacityProbe({
        AEO_ENVIRONMENT: 'production',
        GENERATION_CAPACITY_PROBE_REQUEST_ID_SUFFIX: '0050',
        GENERATION_CAPACITY_PROBE_HOLD_MS: '10000',
      }),
    ).toThrow('GENERATION_CAPACITY_PROBE_STAGING_ONLY');
  });
});
