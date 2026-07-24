import { describe, expect, test } from 'vitest';

import { NodeGitHubRestTransport } from './node-github-rest-transport.js';

describe('Node GitHub REST transport', () => {
  test('sends a JSON request to the fixed GitHub API origin and parses the JSON response', async () => {
    let observedUrl = '';
    let observedInit: RequestInit | undefined;
    const fetchImplementation: typeof fetch = (input, init) => {
      observedUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      observedInit = init;
      return Promise.resolve(
        new Response(JSON.stringify({ sha: 'commit-1' }), {
          status: 201,
          headers: { 'X-GitHub-Request-Id': 'request-1' },
        }),
      );
    };

    const response = await new NodeGitHubRestTransport({
      fetch: fetchImplementation,
    }).request({
      method: 'POST',
      path: '/repos/acme/site/git/commits',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer installation-token',
      },
      body: { message: 'Approved content' },
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
    });

    expect({
      url: observedUrl,
      method: observedInit?.method,
      body: observedInit?.body,
      response,
    }).toEqual({
      url: 'https://api.github.com/repos/acme/site/git/commits',
      method: 'POST',
      body: JSON.stringify({ message: 'Approved content' }),
      response: {
        status: 201,
        headers: {
          'content-type': 'text/plain;charset=UTF-8',
          'x-github-request-id': 'request-1',
        },
        body: { sha: 'commit-1' },
      },
    });
    expect(new Headers(observedInit?.headers).get('accept')).toBe('application/vnd.github+json');
    expect(new Headers(observedInit?.headers).get('authorization')).toBe(
      'Bearer installation-token',
    );
    expect(new Headers(observedInit?.headers).get('content-type')).toBe('application/json');
  });

  test.each([
    'https://attacker.example.test/steal',
    '//attacker.example.test/steal',
    '/\\attacker.example.test/steal',
    'repos/acme/site',
  ])('rejects a non-origin-relative path before issuing a request: %s', async (path) => {
    let requestCount = 0;
    const fetchImplementation: typeof fetch = () => {
      requestCount += 1;
      return Promise.resolve(new Response('{}'));
    };

    await expect(
      new NodeGitHubRestTransport({ fetch: fetchImplementation }).request({
        method: 'GET',
        path,
        headers: { authorization: 'Bearer must-not-leak' },
      }),
    ).rejects.toMatchObject({ code: 'PATH_INVALID', message: 'PATH_INVALID' });
    expect(requestCount).toBe(0);
  });

  test('forbids fetch from following redirects', async () => {
    let redirectPolicy: RequestRedirect | undefined;
    const fetchImplementation: typeof fetch = (_input, init) => {
      redirectPolicy = init?.redirect;
      return Promise.resolve(new Response('{}'));
    };

    await new NodeGitHubRestTransport({ fetch: fetchImplementation }).request({
      method: 'GET',
      path: '/installation',
      headers: {},
    });

    expect(redirectPolicy).toBe('error');
  });

  test('rejects an oversized JSON request before it can leave the process', async () => {
    let requestCount = 0;
    const fetchImplementation: typeof fetch = () => {
      requestCount += 1;
      return Promise.resolve(new Response('{}'));
    };

    let rejected: unknown;
    try {
      await new NodeGitHubRestTransport({
        fetch: fetchImplementation,
        maxRequestBytes: 8,
      }).request({
        method: 'POST',
        path: '/repos/acme/site/git/blobs',
        headers: { authorization: 'Bearer must-not-leak' },
        body: { content: 'sensitive-body' },
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toMatchObject({
      code: 'REQUEST_TOO_LARGE',
      message: 'REQUEST_TOO_LARGE',
    });
    expect(String(rejected)).not.toContain('must-not-leak');
    expect(String(rejected)).not.toContain('sensitive-body');
    expect(requestCount).toBe(0);
  });

  test('fails closed when the configured request byte cap is invalid', () => {
    expect(() => new NodeGitHubRestTransport({ maxRequestBytes: Number.NaN })).toThrowError(
      expect.objectContaining({
        code: 'REQUEST_LIMIT_INVALID',
        message: 'REQUEST_LIMIT_INVALID',
      }),
    );
  });

  test('rejects an oversized declared response without exposing its body', async () => {
    const fetchImplementation: typeof fetch = () =>
      Promise.resolve(
        new Response('{"secret":"sensitive-response"}', {
          headers: { 'content-length': '4096' },
        }),
      );

    let rejected: unknown;
    try {
      await new NodeGitHubRestTransport({ fetch: fetchImplementation }).request({
        method: 'GET',
        path: '/installation',
        headers: { authorization: 'Bearer must-not-leak' },
        maxResponseBytes: 32,
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      message: 'RESPONSE_TOO_LARGE',
    });
    expect(String(rejected)).not.toContain('must-not-leak');
    expect(String(rejected)).not.toContain('sensitive-response');
  });

  test('stops an undeclared response once its streamed bytes exceed the cap', async () => {
    let streamCancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"payload":"'));
        controller.enqueue(new TextEncoder().encode('x'.repeat(64)));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
      cancel() {
        streamCancelled = true;
      },
    });
    const fetchImplementation: typeof fetch = () => Promise.resolve(new Response(responseBody));

    await expect(
      new NodeGitHubRestTransport({ fetch: fetchImplementation }).request({
        method: 'GET',
        path: '/installation',
        headers: {},
        maxResponseBytes: 32,
      }),
    ).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      message: 'RESPONSE_TOO_LARGE',
    });
    expect(streamCancelled).toBe(true);
  });

  test.each([0, Number.NaN])(
    'rejects an invalid response byte cap before issuing a request: %s',
    async (maxResponseBytes) => {
      let requestCount = 0;
      const fetchImplementation: typeof fetch = () => {
        requestCount += 1;
        return Promise.resolve(new Response('{}'));
      };

      await expect(
        new NodeGitHubRestTransport({ fetch: fetchImplementation }).request({
          method: 'GET',
          path: '/installation',
          headers: {},
          maxResponseBytes,
        }),
      ).rejects.toMatchObject({
        code: 'RESPONSE_LIMIT_INVALID',
        message: 'RESPONSE_LIMIT_INVALID',
      });
      expect(requestCount).toBe(0);
    },
  );

  test('aborts a request when its total deadline expires', async () => {
    const fetchImplementation: typeof fetch = (_input, init) =>
      new Promise<Response>((resolve, reject) => {
        const completion = setTimeout(() => resolve(new Response('{}')), 100);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(completion);
            reject(new Error('fetch included sensitive transport details'));
          },
          { once: true },
        );
      });

    await expect(
      new NodeGitHubRestTransport({ fetch: fetchImplementation }).request({
        method: 'GET',
        path: '/installation',
        headers: { authorization: 'Bearer must-not-leak' },
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({
      code: 'FETCH_TIMEOUT',
      message: 'FETCH_TIMEOUT',
    });
  });

  test('redacts authorization and request content from provider failures', async () => {
    const fetchImplementation: typeof fetch = () =>
      Promise.reject(
        Object.assign(
          new Error('socket failed with Bearer must-not-leak while sending sensitive-body'),
          { code: 'ECONNRESET' },
        ),
      );

    let rejected: unknown;
    try {
      await new NodeGitHubRestTransport({ fetch: fetchImplementation }).request({
        method: 'POST',
        path: '/repos/acme/site/git/blobs',
        headers: { authorization: 'Bearer must-not-leak' },
        body: { content: 'sensitive-body' },
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toMatchObject({
      code: 'REQUEST_FAILED',
      message: 'REQUEST_FAILED',
    });
    expect(String(rejected)).not.toContain('must-not-leak');
    expect(String(rejected)).not.toContain('sensitive-body');
  });

  test('redacts request content from JSON serialization failures', async () => {
    const sensitiveBody = {
      toJSON() {
        throw new Error('serialization exposed sensitive-body');
      },
    };

    let rejected: unknown;
    try {
      await new NodeGitHubRestTransport({
        fetch: () => Promise.resolve(new Response('{}')),
      }).request({
        method: 'POST',
        path: '/repos/acme/site/git/blobs',
        headers: { authorization: 'Bearer must-not-leak' },
        body: sensitiveBody,
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toMatchObject({
      code: 'REQUEST_INVALID',
      message: 'REQUEST_INVALID',
    });
    expect(String(rejected)).not.toContain('must-not-leak');
    expect(String(rejected)).not.toContain('sensitive-body');
  });

  test('redacts authorization from invalid header failures', async () => {
    let rejected: unknown;
    try {
      await new NodeGitHubRestTransport({
        fetch: () => Promise.resolve(new Response('{}')),
      }).request({
        method: 'GET',
        path: '/installation',
        headers: { authorization: 'Bearer must-not-leak\r\nx-injected: yes' },
      });
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toMatchObject({
      code: 'REQUEST_INVALID',
      message: 'REQUEST_INVALID',
    });
    expect(String(rejected)).not.toContain('must-not-leak');
  });
});
