import { createHash } from 'node:crypto';

import { TenantDataBrokerAuthorizer } from '@aeostudio/application/tenant-data-access';
import {
  TenantDataBrokerHttpClient,
  TenantDataBrokerHttpHandler,
  parseTenantDataBrokerKeyRing,
} from '@aeostudio/adapters/tenant-data-broker';
import { describe, expect, test, vi } from 'vitest';

const NOW = new Date('2026-07-23T08:00:00.000Z');
const CAPABILITY_ID = '018f3b76-1000-7000-8000-000000000001';
const LEASE_TOKEN = '018f3b76-1000-7000-8000-000000000002';
const TENANT_ID = '018f3b76-1000-7000-8000-000000000003';
const WORKSPACE_ID = '018f3b76-1000-7000-8000-000000000004';
const AUTHORIZATION_ID = '018f3b76-1000-7000-8000-000000000005';
const NONCE = '018f3b76-1000-7000-8000-000000000006';
const SIGNING_KEY = 'tenant-data-broker-hmac-key-sentinel-at-least-32-bytes';
const SECRET_REFERENCE =
  `arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:tenant-${TENANT_ID}/` +
  `workspace-${WORKSPACE_ID}/connector-authoritative`;
const SECRET_VALUE = 'provider-secret-value-must-never-enter-logs';

describe('Task 18 tenant data broker adversarial protocol', () => {
  test('parses only the exact versioned production key-ring schema', () => {
    const valid = JSON.stringify({
      schemaVersion: 'aeostudio.tenant-data-broker-key-ring.v1',
      current: { id: 'broker-current', value: SIGNING_KEY },
      previous: {
        id: 'broker-previous',
        value: 'previous-tenant-data-broker-key-sentinel-at-least-32-bytes',
        acceptUntil: '2026-07-23T08:02:00.000Z',
      },
    });

    expect(parseTenantDataBrokerKeyRing(valid, { now: () => NOW })).toEqual({
      current: { id: 'broker-current', value: SIGNING_KEY },
      previous: {
        id: 'broker-previous',
        value: 'previous-tenant-data-broker-key-sentinel-at-least-32-bytes',
        acceptUntil: '2026-07-23T08:02:00.000Z',
      },
    });

    const invalid: unknown[] = [
      SIGNING_KEY,
      { current: { id: 'broker-current', value: SIGNING_KEY } },
      {
        schemaVersion: 'aeostudio.tenant-data-broker-key-ring.v2',
        current: { id: 'broker-current', value: SIGNING_KEY },
      },
      {
        schemaVersion: 'aeostudio.tenant-data-broker-key-ring.v1',
        current: { id: 'broker-current', value: SIGNING_KEY, extra: true },
      },
      {
        schemaVersion: 'aeostudio.tenant-data-broker-key-ring.v1',
        current: { id: 'same', value: SIGNING_KEY },
        previous: {
          id: 'same',
          value: SIGNING_KEY,
          acceptUntil: '2026-07-23T08:02:00.000Z',
        },
      },
      {
        schemaVersion: 'aeostudio.tenant-data-broker-key-ring.v1',
        current: { id: 'broker-current', value: SIGNING_KEY },
        extra: true,
      },
    ];
    for (const value of invalid) {
      expect(() =>
        parseTenantDataBrokerKeyRing(typeof value === 'string' ? value : JSON.stringify(value), {
          now: () => NOW,
        }),
      ).toThrow('TENANT_DATA_BROKER_SIGNING_KEYS_INVALID');
    }
  });

  test('rejects every legacy unversioned signing-key configuration', () => {
    const authorizer = new TenantDataBrokerAuthorizer({
      loadActiveGrant: () => Promise.resolve(null),
    });

    expect(
      () =>
        new TenantDataBrokerHttpHandler({
          audience: 'platform.example.com',
          signingKey: SIGNING_KEY,
          authorizer,
          nonces: { consume: () => Promise.resolve(false) },
          executor: {
            execute: () => Promise.reject(new Error('must not execute')),
          },
          clock: { now: () => NOW },
          logger: { info: () => undefined, warn: () => undefined },
        } as never),
    ).toThrow('TENANT_DATA_BROKER_SIGNING_KEYS_INVALID');

    expect(
      () =>
        new TenantDataBrokerHttpClient({
          endpoint: 'https://platform.example.com/internal/v1/tenant-data',
          signingKey: SIGNING_KEY,
          clock: { now: () => NOW },
          nextNonce: () => '018f3b76-1000-7000-8000-000000000006',
          transport: () => Promise.reject(new Error('must not transport')),
        } as never),
    ).toThrow('TENANT_DATA_BROKER_SIGNING_KEYS_INVALID');
  });

  test('requires the atomic effect resolver port at handler construction', () => {
    const base = {
      audience: 'platform.example.com',
      signingKeys: {
        current: { id: 'broker-current', value: SIGNING_KEY },
      },
      authorizer: { authorize: () => Promise.reject(new Error('must not authorize')) },
      attempts: successfulAttempts(),
      executor: { execute: () => Promise.reject(new Error('must not execute')) },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    };

    expect(() => new TenantDataBrokerHttpHandler(base as never)).toThrow(
      'TENANT_DATA_BROKER_PORT_INVALID',
    );
    expect(
      () =>
        new TenantDataBrokerHttpHandler({
          ...base,
          effectResolver: {
            resolveObjectPut: () => Promise.resolve('NOT_RESOLVED' as const),
          },
        } as never),
    ).toThrow('TENANT_DATA_BROKER_PORT_INVALID');
  });

  test('treats the previous-key acceptUntil boundary as expired', async () => {
    let now = new Date(NOW);
    const previousKey = 'previous-tenant-data-broker-key-sentinel-at-least-32-bytes';
    const authorizer = new TenantDataBrokerAuthorizer(
      {
        loadActiveGrant: () =>
          Promise.resolve({
            capabilityId: CAPABILITY_ID,
            leaseTokenSha256: '33246a3e70a81a58720ac80b2f704e0d56b7d39ffa47acd1bfc0da4a30dbfb08',
            authorityKind: 'ACTIVE_PUBLICATION_JOB',
            authorityReference: AUTHORIZATION_ID,
            scopeKind: 'WORKSPACE',
            tenantId: TENANT_ID,
            workspaceId: WORKSPACE_ID,
            operation: 'READ_CONNECTOR_SECRET',
            resource: { kind: 'CONNECTOR_SECRET', secretArn: SECRET_REFERENCE },
            expiresAt: '2026-07-23T08:04:00.000Z',
          }),
      },
      { now: () => now },
    );
    const handler = new TenantDataBrokerHttpHandler({
      audience: 'platform.example.com',
      signingKeys: {
        current: {
          id: 'broker-current',
          value: 'current-tenant-data-broker-key-sentinel-at-least-32-bytes',
        },
        previous: {
          id: 'broker-previous',
          value: previousKey,
          acceptUntil: '2026-07-23T08:00:01.000Z',
        },
      },
      authorizer,
      attempts: successfulAttempts(),
      effectResolver: unusedEffectResolver(),
      executor: {
        execute: async (input) => {
          await consumeBody(input.body);
          return { kind: 'SECRET_VALUE', value: SECRET_VALUE };
        },
      },
      clock: { now: () => now },
      logger: { info: () => undefined, warn: () => undefined },
    });
    now = new Date('2026-07-23T08:00:01.000Z');
    const client = new TenantDataBrokerHttpClient({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: { id: 'broker-previous', value: previousKey },
      clock: { now: () => now },
      nextNonce: () => NONCE,
      transport: (request) => handler.handle(request),
    });

    await expect(client.invoke(secretReadCommand(), emptyInvocation())).rejects.toThrow(
      'TENANT_DATA_ACCESS_DENIED',
    );
  });

  test('logs the authorized attempt before the effect and logger failures cannot change a successful result', async () => {
    const events: string[] = [];
    const execute = vi.fn(async (input: StreamingExecution) => {
      expect(events).toEqual(['TENANT_DATA_BROKER_AUTHORIZED_ATTEMPT']);
      await consumeBody(input.body);
      return { kind: 'SECRET_VALUE' as const, value: SECRET_VALUE };
    });
    const authorizer = new TenantDataBrokerAuthorizer(
      {
        loadActiveGrant: () =>
          Promise.resolve({
            capabilityId: CAPABILITY_ID,
            leaseTokenSha256: '33246a3e70a81a58720ac80b2f704e0d56b7d39ffa47acd1bfc0da4a30dbfb08',
            authorityKind: 'ACTIVE_PUBLICATION_JOB',
            authorityReference: AUTHORIZATION_ID,
            scopeKind: 'WORKSPACE',
            tenantId: TENANT_ID,
            workspaceId: WORKSPACE_ID,
            operation: 'READ_CONNECTOR_SECRET',
            resource: { kind: 'CONNECTOR_SECRET', secretArn: SECRET_REFERENCE },
            expiresAt: '2026-07-23T08:04:00.000Z',
          }),
      },
      { now: () => NOW },
    );
    const handler = new TenantDataBrokerHttpHandler({
      audience: 'platform.example.com',
      signingKeys: {
        current: { id: 'broker-current', value: SIGNING_KEY },
      },
      authorizer,
      attempts: successfulAttempts(),
      effectResolver: unusedEffectResolver(),
      executor: { execute },
      clock: { now: () => NOW },
      logger: {
        info: (entry) => {
          events.push(String(entry.event));
          throw new Error('logger unavailable');
        },
        warn: () => {
          throw new Error('logger unavailable');
        },
      },
    });
    const client = new TenantDataBrokerHttpClient({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: { id: 'broker-current', value: SIGNING_KEY },
      clock: { now: () => NOW },
      nextNonce: () => NONCE,
      transport: (request) => handler.handle(request),
    });

    await expect(client.invoke(secretReadCommand(), emptyInvocation())).resolves.toEqual({
      kind: 'SECRET_VALUE',
      value: SECRET_VALUE,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'TENANT_DATA_BROKER_AUTHORIZED_ATTEMPT',
      'TENANT_DATA_BROKER_AUTHORIZED',
    ]);
  });

  test('rejects missing, duplicate, transfer-encoded, and over-limit framing before nonce or effect work', async () => {
    const beginAuthenticated = vi.fn(() =>
      Promise.resolve({
        outcome: 'STARTED' as const,
        attemptId: '018f3b76-1000-7000-8000-000000000090',
      }),
    );
    const execute = vi.fn(() =>
      Promise.resolve({ kind: 'SECRET_VALUE' as const, value: SECRET_VALUE }),
    );
    const authorizer = new TenantDataBrokerAuthorizer({
      loadActiveGrant: () => Promise.reject(new Error('must not query authority')),
    });
    const handler = new TenantDataBrokerHttpHandler({
      audience: 'platform.example.com',
      signingKeys: {
        current: { id: 'broker-current', value: SIGNING_KEY },
      },
      authorizer,
      attempts: {
        beginAuthenticated,
        complete: () => Promise.resolve(),
        fail: () => Promise.resolve(),
      },
      effectResolver: unusedEffectResolver(),
      executor: { execute },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    });
    const mutations = [
      (headers: Record<string, unknown>) => {
        delete headers['content-length'];
      },
      (headers: Record<string, unknown>) => {
        headers['content-length'] = [headers['content-length'], headers['content-length']];
      },
      (headers: Record<string, unknown>) => {
        headers['transfer-encoding'] = 'chunked';
      },
      (headers: Record<string, unknown>) => {
        headers['content-length'] = '2147500037';
      },
    ];

    for (const [index, mutate] of mutations.entries()) {
      const client = new TenantDataBrokerHttpClient({
        endpoint: 'https://platform.example.com/internal/v1/tenant-data',
        signingKey: { id: 'broker-current', value: SIGNING_KEY },
        clock: { now: () => NOW },
        nextNonce: () => `018f3b76-1000-7000-8000-${String(index + 10).padStart(12, '0')}`,
        transport: (request) => {
          const headers = { ...request.headers } as Record<string, unknown>;
          mutate(headers);
          return handler.handle({
            ...request,
            headers: headers as never,
          });
        },
      });
      await expect(client.invoke(secretReadCommand(), emptyInvocation())).rejects.toThrow(
        'TENANT_DATA_ACCESS_DENIED',
      );
    }

    expect(beginAuthenticated).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test('allows only one effect when 100 concurrent signed requests reuse one nonce', async () => {
    const consumed = new Set<string>();
    const execute = vi.fn(async (input: StreamingExecution) => {
      await consumeBody(input.body);
      return { kind: 'SECRET_VALUE' as const, value: SECRET_VALUE };
    });
    const authorizer = new TenantDataBrokerAuthorizer(
      {
        loadActiveGrant: () =>
          Promise.resolve({
            capabilityId: CAPABILITY_ID,
            leaseTokenSha256: '33246a3e70a81a58720ac80b2f704e0d56b7d39ffa47acd1bfc0da4a30dbfb08',
            authorityKind: 'ACTIVE_PUBLICATION_JOB',
            authorityReference: AUTHORIZATION_ID,
            scopeKind: 'WORKSPACE',
            tenantId: TENANT_ID,
            workspaceId: WORKSPACE_ID,
            operation: 'READ_CONNECTOR_SECRET',
            resource: { kind: 'CONNECTOR_SECRET', secretArn: SECRET_REFERENCE },
            expiresAt: '2026-07-23T08:04:00.000Z',
          }),
      },
      { now: () => NOW },
    );
    const handler = new TenantDataBrokerHttpHandler({
      audience: 'platform.example.com',
      signingKeys: {
        current: { id: 'broker-current', value: SIGNING_KEY },
      },
      authorizer,
      attempts: {
        beginAuthenticated: async ({ nonce }) => {
          if (consumed.has(nonce)) return { outcome: 'DENIED' as const };
          consumed.add(nonce);
          await Promise.resolve();
          return {
            outcome: 'STARTED' as const,
            attemptId: '018f3b76-1000-7000-8000-000000000090',
          };
        },
        complete: () => Promise.resolve(),
        fail: () => Promise.resolve(),
      },
      effectResolver: unusedEffectResolver(),
      executor: { execute },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    });

    const attempts = Array.from({ length: 100 }, () => {
      const client = new TenantDataBrokerHttpClient({
        endpoint: 'https://platform.example.com/internal/v1/tenant-data',
        signingKey: { id: 'broker-current', value: SIGNING_KEY },
        clock: { now: () => NOW },
        nextNonce: () => NONCE,
        transport: (request) => handler.handle(request),
      });
      return client.invoke(secretReadCommand(), emptyInvocation());
    });
    const results = await Promise.allSettled(attempts);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(99);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('rejects every malformed signed command field before authority or executor work', async () => {
    const loadActiveGrant = vi.fn(() => Promise.reject(new Error('must not load')));
    const execute = vi.fn(() =>
      Promise.resolve({ kind: 'SECRET_VALUE' as const, value: SECRET_VALUE }),
    );
    const handler = new TenantDataBrokerHttpHandler({
      audience: 'platform.example.com',
      signingKeys: {
        current: { id: 'broker-current', value: SIGNING_KEY },
      },
      authorizer: new TenantDataBrokerAuthorizer({ loadActiveGrant }),
      attempts: successfulAttempts(),
      effectResolver: unusedEffectResolver(),
      executor: { execute },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    });
    const fields = [
      'capabilityId',
      'leaseToken',
      'authorityReference',
      'tenantId',
      'workspaceId',
      'operation',
    ] as const;
    const malformedValues: readonly unknown[] = [
      null,
      {},
      [],
      7,
      'x'.repeat(2_049),
      'value\u0000with-control',
    ];
    let nonceSequence = 100;

    for (const field of fields) {
      for (const malformed of malformedValues) {
        const client = new TenantDataBrokerHttpClient({
          endpoint: 'https://platform.example.com/internal/v1/tenant-data',
          signingKey: { id: 'broker-current', value: SIGNING_KEY },
          clock: { now: () => NOW },
          nextNonce: () => `018f3b76-1000-7000-8000-${String(nonceSequence++).padStart(12, '0')}`,
          transport: (request) => handler.handle(request),
        });
        await expect(
          client.invoke({ ...secretReadCommand(), [field]: malformed } as never, emptyInvocation()),
        ).rejects.toThrow('TENANT_DATA_ACCESS_DENIED');
      }
    }

    expect(loadActiveGrant).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test('returns 503 and performs no effect when the durable attempt insert fails', async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ kind: 'SECRET_VALUE' as const, value: SECRET_VALUE }),
    );
    const authorizer = new TenantDataBrokerAuthorizer(
      {
        loadActiveGrant: () =>
          Promise.resolve({
            capabilityId: CAPABILITY_ID,
            leaseTokenSha256: '33246a3e70a81a58720ac80b2f704e0d56b7d39ffa47acd1bfc0da4a30dbfb08',
            authorityKind: 'ACTIVE_PUBLICATION_JOB',
            authorityReference: AUTHORIZATION_ID,
            scopeKind: 'WORKSPACE',
            tenantId: TENANT_ID,
            workspaceId: WORKSPACE_ID,
            operation: 'READ_CONNECTOR_SECRET',
            resource: { kind: 'CONNECTOR_SECRET', secretArn: SECRET_REFERENCE },
            expiresAt: '2026-07-23T08:04:00.000Z',
          }),
      },
      { now: () => NOW },
    );
    const handler = new TenantDataBrokerHttpHandler({
      audience: 'platform.example.com',
      signingKeys: {
        current: { id: 'broker-current', value: SIGNING_KEY },
      },
      authorizer,
      attempts: {
        beginAuthenticated: () => Promise.reject(new Error('database unavailable')),
        complete: () => Promise.reject(new Error('must not complete')),
        fail: () => Promise.reject(new Error('must not fail')),
      },
      effectResolver: unusedEffectResolver(),
      executor: { execute },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    });
    let status: number | undefined;
    const client = new TenantDataBrokerHttpClient({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: { id: 'broker-current', value: SIGNING_KEY },
      clock: { now: () => NOW },
      nextNonce: () => NONCE,
      transport: async (request) => {
        const response = await handler.handle(request);
        status = response.status;
        return response;
      },
    });

    await expect(client.invoke(secretReadCommand(), emptyInvocation())).rejects.toThrow(
      'TENANT_DATA_BROKER_UNAVAILABLE',
    );
    expect(status).toBe(503);
    expect(execute).not.toHaveBeenCalled();
  });
});

function secretReadCommand() {
  return {
    capabilityId: CAPABILITY_ID,
    leaseToken: LEASE_TOKEN,
    authorityReference: AUTHORIZATION_ID,
    scopeKind: 'WORKSPACE',
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    operation: 'READ_CONNECTOR_SECRET' as const,
  };
}

interface StreamingExecution {
  body: AsyncIterable<Uint8Array>;
}

function emptyInvocation() {
  return {
    body: emptyBody(),
    deadline: new Date(NOW.getTime() + 5_000),
    payloadLength: 0,
    payloadSha256: createHash('sha256').update(new Uint8Array()).digest('hex'),
    signal: AbortSignal.timeout(5_000),
  };
}

function emptyBody(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.resolve({ done: true, value: undefined }),
      };
    },
  };
}

async function consumeBody(body: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const chunk of body) {
    void chunk;
    // The secret-read request body must be empty.
  }
}

function successfulAttempts() {
  return {
    beginAuthenticated: () =>
      Promise.resolve({
        outcome: 'STARTED' as const,
        attemptId: '018f3b76-1000-7000-8000-000000000090',
      }),
    complete: () => Promise.resolve(),
    fail: () => Promise.resolve(),
  };
}

function unusedEffectResolver() {
  return {
    resolveObjectPut: () => Promise.resolve('NOT_RESOLVED' as const),
    resolveLegalHold: () => Promise.resolve('NOT_RESOLVED' as const),
    resolveSecretDelete: () => Promise.resolve('NOT_RESOLVED' as const),
  };
}
