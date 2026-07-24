import { describe, expect, test, vi } from 'vitest';

import { createApiRequestTelemetry } from './request-correlation.js';

describe('API request correlation', () => {
  test('replaces untrusted request IDs and emits only opaque request/trace correlation', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const header = vi.fn();
    const raw = {};
    const request = {
      raw,
      id: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
      headers: {
        'x-request-id': 'owner@example.test?token=private',
        authorization: 'Bearer private-token',
        cookie: 'session=private-cookie',
      },
    };
    const reply = { header, statusCode: 204 };
    const telemetry = createApiRequestTelemetry(logger, {
      traceIds: { current: () => '4bf92f3577b34da6a3ce929d0e0e4736' },
      clock: { now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(142) },
    });

    telemetry.onRequest(request, reply);
    telemetry.onResponse(request, reply);

    expect(header).toHaveBeenCalledWith('x-request-id', '018f84b3-7eb8-7c75-9ca5-25278969d3ef');
    expect(logger.info).toHaveBeenNthCalledWith(1, 'HTTP_REQUEST_RECEIVED', {
      correlation: {
        requestId: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      },
    });
    expect(logger.info).toHaveBeenNthCalledWith(2, 'HTTP_REQUEST_COMPLETED', {
      correlation: {
        requestId: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      },
      attributes: { durationMs: 42, outcome: 'HTTP_2XX' },
    });
    expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(
      /owner@example|private-token|private-cookie|authorization|cookie/iu,
    );
  });

  test('emits one safe authentication-denial signal for 401 and 403 responses', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const telemetry = createApiRequestTelemetry(logger, {
      traceIds: { current: () => undefined },
      clock: { now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(101) },
    });
    const request = {
      raw: {},
      id: '018f84b3-7eb8-7c75-9ca5-25278969d3ef',
      headers: { authorization: 'must-not-be-logged' },
    };

    telemetry.onRequest(request, { header: vi.fn(), statusCode: 200 });
    telemetry.onResponse(request, { header: vi.fn(), statusCode: 401 });

    expect(logger.warn).toHaveBeenCalledWith('AUTHENTICATION_DENIED', {
      correlation: { requestId: request.id },
      attributes: { outcome: 'HTTP_401' },
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('must-not-be-logged');
  });
});
