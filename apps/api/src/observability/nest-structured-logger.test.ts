import { describe, expect, test, vi } from 'vitest';

import { NestStructuredLogger } from './nest-structured-logger.js';

describe('Nest structured logger boundary', () => {
  test('maps framework logging to fixed event codes without forwarding message content', () => {
    const sink = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const logger = new NestStructuredLogger(sink);

    logger.log('Mapped {/users?token=private-token} route');
    logger.warn('cookie=session-secret');
    logger.error(new Error('password=private-password'));
    logger.debug('owner@example.test');

    expect(sink.info).toHaveBeenCalledWith('NEST_RUNTIME_LOG');
    expect(sink.warn).toHaveBeenCalledWith('NEST_RUNTIME_WARNING');
    expect(sink.error).toHaveBeenCalledWith('NEST_RUNTIME_ERROR');
    expect(sink.debug).toHaveBeenCalledWith('NEST_RUNTIME_DEBUG');
    const forwarded = [sink.debug, sink.info, sink.warn, sink.error].flatMap(
      (method) => method.mock.calls,
    );
    expect(JSON.stringify(forwarded)).not.toMatch(
      /private-token|session-secret|private-password|owner@example/iu,
    );
  });
});
