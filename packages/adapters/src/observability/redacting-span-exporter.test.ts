import { describe, expect, test, vi } from 'vitest';

import { createRedactingSpanExporter } from './redacting-span-exporter.js';

describe('redacting span exporter', () => {
  test('exports correlation-safe telemetry without request, content, SQL or exception text', () => {
    const exported: unknown[][] = [];
    const delegate = {
      export: vi.fn((spans: unknown[], callback: (result: { code: number }) => void) => {
        exported.push(spans);
        callback({ code: 0 });
      }),
      shutdown: vi.fn(() => Promise.resolve()),
      forceFlush: vi.fn(() => Promise.resolve()),
    };
    const exporter = createRedactingSpanExporter(delegate);
    const spanContext = () => ({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: 1,
    });
    const resource = { attributes: { 'service.name': 'aeostudio-api' } };
    const span = {
      name: 'GET /api/v1/tenants/tenant-secret/workspaces/owner@example.test',
      kind: 1,
      spanContext,
      startTime: [1, 0],
      endTime: [1, 1],
      duration: [0, 1],
      status: { code: 2, message: 'owner@example.test failed with private payload' },
      attributes: {
        'http.request.method': 'GET',
        'http.response.status_code': 200,
        'http.route': '/api/v1/tenants/tenant-secret/workspaces/owner@example.test',
        'url.full': 'https://app.example.test/jobs?token=private-query',
        'url.query': 'token=private-query',
        'client.address': '203.0.113.77',
        'user_agent.original': 'private browser fingerprint',
        'db.statement': 'select * from users where email = owner@example.test',
        prompt: 'confidential customer prompt',
      },
      links: [
        {
          context: spanContext(),
          attributes: { baggage: 'private-tenant-content' },
        },
      ],
      events: [
        {
          name: 'exception',
          time: [1, 1],
          attributes: {
            'exception.type': 'TypeError',
            'exception.message': 'owner@example.test private payload',
            'exception.stacktrace': 'secret stack',
          },
        },
      ],
      ended: true,
      resource,
      instrumentationScope: { name: 'test' },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };

    exporter.export([span] as never, () => undefined);

    const serialized = JSON.stringify(exported);
    expect(serialized).not.toMatch(
      /tenant-secret|owner@example|private-query|203\.0\.113\.77|fingerprint|select \*|confidential|private-tenant-content|secret stack/iu,
    );
    expect(exported).toMatchObject([
      [
        {
          name: 'HTTP GET',
          status: { code: 2 },
          attributes: {
            'http.request.method': 'GET',
            'http.response.status_code': 200,
            'http.route': '/api/v1/tenants/:value/workspaces/:value',
          },
          links: [{ attributes: {} }],
          events: [{ name: 'exception', attributes: { 'exception.type': 'TypeError' } }],
        },
      ],
    ]);
    expect(delegate.export).toHaveBeenCalledOnce();
  });
});
