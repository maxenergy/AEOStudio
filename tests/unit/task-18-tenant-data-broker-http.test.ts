import { createHash } from 'node:crypto';

import {
  TenantDataBrokerAuthorizer,
  type TenantDataAccessRequest,
  type TenantDataAuthorization,
} from '@aeostudio/application/tenant-data-access';
import {
  createTenantDataBrokerClientGateway,
  createTenantDataBrokerStreamingHttpTransport,
  TenantDataBrokerHttpClient,
  TenantDataBrokerHttpHandler,
  type TenantDataBrokerClientCapabilityIssuer,
  type TenantDataBrokerHttpRequest,
  type TenantDataBrokerHttpResponse,
} from '@aeostudio/adapters/tenant-data-broker';
import { describe, expect, test, vi } from 'vitest';

const NOW = new Date('2026-07-23T08:00:00.000Z');
const CAPABILITY_ID = '018f3b76-1000-7000-8000-000000000001';
const LEASE_TOKEN = '018f3b76-1000-7000-8000-000000000002';
const TENANT_ID = '018f3b76-1000-7000-8000-000000000003';
const WORKSPACE_ID = '018f3b76-1000-7000-8000-000000000004';
const AUTHORIZATION_ID = '018f3b76-1000-7000-8000-000000000005';
const NONCE = '018f3b76-1000-7000-8000-000000000006';
const KEY_ID = 'broker-2026-07';
const SIGNING_KEY = 'tenant-data-broker-hmac-key-sentinel-at-least-32-bytes';
const SECRET_REFERENCE =
  `arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:tenant-${TENANT_ID}/` +
  `workspace-${WORKSPACE_ID}/connector-authoritative`;
const SECRET_VALUE = 'provider-secret-value-must-never-enter-logs';

describe('Task 18 tenant data broker HTTPS boundary', () => {
  test('returns an exact authority-derived secret over a signed no-store response without logging sensitive values', async () => {
    const logs: unknown[] = [];
    let authenticatedAttempt: unknown;
    const beginAuthenticated = vi.fn((input: unknown) => {
      authenticatedAttempt = input;
      return Promise.resolve({
        outcome: 'STARTED' as const,
        attemptId: '018f3b76-1000-7000-8000-000000000090',
      });
    });
    const complete = vi.fn(() => Promise.resolve());
    let observedExecution: StreamingExecution | undefined;
    const execute = vi.fn(async (input: StreamingExecution) => {
      observedExecution = input;
      expect(await consumeBody(input.body)).toEqual(new Uint8Array());
      return {
        kind: 'SECRET_VALUE' as const,
        value: SECRET_VALUE,
      };
    });
    const loadActiveGrant = vi.fn(() =>
      Promise.resolve({
        capabilityId: CAPABILITY_ID,
        leaseTokenSha256: '33246a3e70a81a58720ac80b2f704e0d56b7d39ffa47acd1bfc0da4a30dbfb08',
        authorityKind: 'ACTIVE_PUBLICATION_JOB' as const,
        authorityReference: AUTHORIZATION_ID,
        scopeKind: 'WORKSPACE',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        operation: 'READ_CONNECTOR_SECRET' as const,
        resource: { kind: 'CONNECTOR_SECRET' as const, secretArn: SECRET_REFERENCE },
        expiresAt: '2026-07-23T08:01:00.000Z',
      }),
    );
    const authorizer = new TenantDataBrokerAuthorizer({ loadActiveGrant }, { now: () => NOW });
    const handler = new TenantDataBrokerHttpHandler({
      signingKeys: { current: { id: KEY_ID, value: SIGNING_KEY } },
      audience: 'platform.example.com',
      authorizer,
      attempts: {
        beginAuthenticated,
        complete,
        fail: () => Promise.resolve(),
      },
      effectResolver: unusedEffectResolver(),
      executor: { execute },
      clock: { now: () => NOW },
      logger: {
        info: (entry) => logs.push(entry),
        warn: (entry) => logs.push(entry),
      },
    });
    let request: TenantDataBrokerHttpRequest | undefined;
    let response: TenantDataBrokerHttpResponse | undefined;
    const client = new TenantDataBrokerHttpClient({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: { id: KEY_ID, value: SIGNING_KEY },
      clock: { now: () => NOW },
      nextNonce: () => NONCE,
      transport: async (input) => {
        request = input;
        response = await handler.handle(input);
        return response;
      },
    });

    const invocation = emptyInvocation();
    await expect(
      client.invoke(
        {
          capabilityId: CAPABILITY_ID,
          leaseToken: LEASE_TOKEN,
          authorityReference: AUTHORIZATION_ID,
          scopeKind: 'WORKSPACE',
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          operation: 'READ_CONNECTOR_SECRET',
        },
        invocation,
      ),
    ).resolves.toEqual({ kind: 'SECRET_VALUE', value: SECRET_VALUE });

    expect(response).toMatchObject({
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/vnd.aeostudio.tenant-data+json',
      },
    });
    expect(beginAuthenticated).toHaveBeenCalledTimes(1);
    expect(authenticatedAttempt).toMatchObject({
      capabilityId: CAPABILITY_ID,
      leaseToken: LEASE_TOKEN,
      nonce: NONCE,
      operation: 'READ_CONNECTOR_SECRET',
      signedAt: NOW,
      expiresAt: new Date('2026-07-23T08:00:30.000Z'),
    });
    if (authenticatedAttempt === null || typeof authenticatedAttempt !== 'object') {
      throw new Error('authenticated attempt was not captured');
    }
    expect((authenticatedAttempt as Record<string, unknown>).resourceReferenceSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(request?.headers['x-aeostudio-command']).toBeUndefined();
    expect(request?.headers['x-aeostudio-payload-length']).toBe('0');
    expect(request?.headers['content-length']).toMatch(/^[1-9][0-9]*$/u);
    expect(observedExecution).toBeDefined();
    if (observedExecution === undefined) throw new Error('executor was not called');
    expect(observedExecution.deadline).toEqual(invocation.deadline);
    expect(observedExecution.signal).toBe(invocation.signal);
    expect(observedExecution.grant).toMatchObject({
      resource: { kind: 'CONNECTOR_SECRET', secretArn: SECRET_REFERENCE },
    });
    expect(complete).toHaveBeenCalledWith({
      attemptId: '018f3b76-1000-7000-8000-000000000090',
      leaseToken: LEASE_TOKEN,
      receipt: null,
    });
    expect(loadActiveGrant).toHaveBeenCalledWith({
      capabilityId: CAPABILITY_ID,
      leaseToken: LEASE_TOKEN,
      at: NOW,
    });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).not.toContain(SECRET_REFERENCE);
    expect(serialized).not.toContain(LEASE_TOKEN);
    expect(serialized).not.toContain(SIGNING_KEY);
  });

  test('accepts an unexpired previous key version during rotation and rejects an unknown version generically', async () => {
    const previousKey = 'previous-tenant-data-broker-key-sentinel-at-least-32-bytes';
    const currentKey = 'current-tenant-data-broker-key-sentinel-at-least-32-bytes';
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
            expiresAt: '2026-07-23T08:01:00.000Z',
          }),
      },
      { now: () => NOW },
    );
    const handler = new TenantDataBrokerHttpHandler({
      audience: 'platform.example.com',
      signingKeys: {
        current: { id: 'broker-2026-07-b', value: currentKey },
        previous: {
          id: 'broker-2026-07-a',
          value: previousKey,
          acceptUntil: '2026-07-23T08:02:00.000Z',
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
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    });
    const transport = (request: Parameters<typeof handler.handle>[0]) => handler.handle(request);
    const previousClient = new TenantDataBrokerHttpClient({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: { id: 'broker-2026-07-a', value: previousKey },
      clock: { now: () => NOW },
      nextNonce: () => NONCE,
      transport,
    });
    const unknownClient = new TenantDataBrokerHttpClient({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: {
        id: 'broker-2026-07-unknown',
        value: 'unknown-tenant-data-broker-key-sentinel-at-least-32-bytes',
      },
      clock: { now: () => NOW },
      nextNonce: () => '018f3b76-1000-7000-8000-000000000007',
      transport,
    });

    await expect(
      previousClient.invoke(
        {
          capabilityId: CAPABILITY_ID,
          leaseToken: LEASE_TOKEN,
          authorityReference: AUTHORIZATION_ID,
          scopeKind: 'WORKSPACE',
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          operation: 'READ_CONNECTOR_SECRET',
        },
        emptyInvocation(),
      ),
    ).resolves.toEqual({ kind: 'SECRET_VALUE', value: SECRET_VALUE });
    await expect(
      unknownClient.invoke(
        {
          capabilityId: CAPABILITY_ID,
          leaseToken: LEASE_TOKEN,
          authorityReference: AUTHORIZATION_ID,
          scopeKind: 'WORKSPACE',
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          operation: 'READ_CONNECTOR_SECRET',
        },
        emptyInvocation(),
      ),
    ).rejects.toThrow('TENANT_DATA_ACCESS_DENIED');
  });

  test('returns the durable receipt without repeating an already-succeeded effect', async () => {
    const broker = (await import('@aeostudio/adapters/tenant-data-broker')) as Record<
      string,
      unknown
    >;
    const factory = broker.createTenantDataBrokerStreamingHttpTransport;
    expect(factory).toBeTypeOf('function');
    const payload = new Uint8Array([0x10, 0x20, 0x30]);
    const checksum = createHash('sha256').update(payload).digest('hex');
    const receipt = {
      bucket: 'aeostudio-staging-artifacts',
      key: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/object.json`,
      versionId: 'version-1',
      checksum,
      contentType: 'application/json',
      byteLength: payload.byteLength,
    };
    const execute = vi.fn(() => Promise.reject(new Error('effect must not repeat')));
    const complete = vi.fn(() => Promise.reject(new Error('completed attempt must not repeat')));
    const fail = vi.fn(() => Promise.reject(new Error('completed attempt must not fail')));
    const transport = (
      factory as (options: Record<string, unknown>) => {
        handle(request: unknown): Promise<unknown>;
      }
    )({
      audience: 'platform.example.com',
      signingKeys: { current: { id: KEY_ID, value: SIGNING_KEY } },
      authorizer: {
        authorize: () =>
          Promise.resolve({
            outcome: 'AUTHORIZED',
            audit: { resourceReferenceSha256: 'a'.repeat(64) },
            grant: {
              capabilityId: CAPABILITY_ID,
              authorityKind: 'WORKLOAD_WRITE_INTENT',
              authorityReference: AUTHORIZATION_ID,
              scopeKind: 'WORKSPACE',
              tenantId: TENANT_ID,
              workspaceId: WORKSPACE_ID,
              operation: 'PUT_WORKLOAD_OBJECT',
              resource: {
                kind: 'WORKLOAD_OBJECT_PUT',
                objectClass: 'WORKLOAD_OBJECTS',
                bucket: receipt.bucket,
                key: receipt.key,
                checksumSha256: checksum,
                contentType: receipt.contentType,
                byteLength: receipt.byteLength,
                lockedUntil: null,
                sealedAt: null,
              },
              expiresAt: '2026-07-23T08:01:00.000Z',
            },
          }),
      },
      attempts: {
        beginAuthenticated: () =>
          Promise.resolve({
            outcome: 'ALREADY_SUCCEEDED',
            successReceipt: receipt,
          }),
        complete,
        fail,
      },
      effectResolver: unusedEffectResolver(),
      executor: { execute },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    });
    const Client = broker.TenantDataBrokerHttpClient as new (options: Record<string, unknown>) => {
      invoke(command: Record<string, unknown>, input: Record<string, unknown>): Promise<unknown>;
    };
    const client = new Client({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: { id: KEY_ID, value: SIGNING_KEY },
      clock: { now: () => NOW },
      nextNonce: () => NONCE,
      transport: (request: unknown) => transport.handle(request),
    });

    await expect(
      client.invoke(
        {
          capabilityId: CAPABILITY_ID,
          leaseToken: LEASE_TOKEN,
          authorityReference: AUTHORIZATION_ID,
          scopeKind: 'WORKSPACE',
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          operation: 'PUT_WORKLOAD_OBJECT',
        },
        {
          body: onePassBody([payload]),
          deadline: new Date(NOW.getTime() + 5_000),
          payloadLength: payload.byteLength,
          payloadSha256: checksum,
          signal: AbortSignal.timeout(5_000),
        },
      ),
    ).resolves.toEqual(receipt);
    expect(execute).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  test('reconstructs non-PUT crash-resume receipts through signed HTTP for the gateway', async () => {
    const execute = vi.fn(() => Promise.reject(new Error('durable effect must not repeat')));
    const handler = new TenantDataBrokerHttpHandler({
      audience: 'platform.example.com',
      signingKeys: { current: { id: KEY_ID, value: SIGNING_KEY } },
      expectedBucketOwner: '123456789012',
      authorizer: {
        authorize: (command) => Promise.resolve(crashResumeAuthorization(command)),
      },
      attempts: {
        beginAuthenticated: () =>
          Promise.resolve({
            outcome: 'ALREADY_SUCCEEDED' as const,
            successReceipt: {},
          }),
        complete: () => Promise.reject(new Error('completed effect must not complete twice')),
        fail: () => Promise.reject(new Error('completed effect must not fail')),
      },
      effectResolver: unusedEffectResolver(),
      executor: { execute },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    });
    const client = new TenantDataBrokerHttpClient({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: { id: KEY_ID, value: SIGNING_KEY },
      clock: { now: () => NOW },
      nextNonce: () => NONCE,
      transport: (request) => handler.handle(request),
    });
    const issuer = crashResumeIssuer();
    const gateway = createTenantDataBrokerClientGateway({
      issuer,
      client,
      ids: { next: () => CAPABILITY_ID },
      clock: { now: () => NOW },
      buckets: {
        workload: 'aeostudio-workload-prod',
        tenantExports: 'aeostudio-exports-prod',
      },
      expectedBucketOwner: '123456789012',
      requestTimeoutMs: 5_000,
    });

    await expect(
      gateway.requestAuthorizedConnectorSecretForceDelete({
        source: {
          channelAuthorizationId: AUTHORIZATION_ID,
          leaseToken: LEASE_TOKEN,
        },
        expected: {
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          secretReference: SECRET_REFERENCE,
        },
      }),
    ).resolves.toBeUndefined();

    await expect(
      gateway.deleteAuthorizedObjectVersion({
        source: { requestId: AUTHORIZATION_ID, leaseToken: LEASE_TOKEN },
        expected: {
          tenantId: TENANT_ID,
          scopeKind: 'WORKSPACE',
          workspaceId: WORKSPACE_ID,
          objectClass: 'WORKLOAD_OBJECTS',
          objectKey: objectKey(),
          objectVersionId: 'exact-version',
          isDeleteMarker: false,
        },
      }),
    ).resolves.toBe('DELETED');

    await expect(
      gateway.reconcileAuthorizedObjectLegalHold({
        source: {
          tenantId: TENANT_ID,
          objectKey: privacyObjectKey(),
          objectVersionId: 'exact-version',
          leaseToken: LEASE_TOKEN,
        },
        expected: {
          scopeKind: 'TENANT',
          workspaceId: null,
          objectClass: 'TENANT_EXPORTS',
          desiredStatus: 'ON',
          revision: 3,
        },
      }),
    ).resolves.toBe(true);

    const wrongOwnerGateway = createTenantDataBrokerClientGateway({
      issuer,
      client,
      ids: { next: () => CAPABILITY_ID },
      clock: { now: () => NOW },
      buckets: {
        workload: 'aeostudio-workload-prod',
        tenantExports: 'aeostudio-exports-prod',
      },
      expectedBucketOwner: '999999999999',
      requestTimeoutMs: 5_000,
    });
    await expect(
      wrongOwnerGateway.reconcileAuthorizedObjectLegalHold({
        source: {
          tenantId: TENANT_ID,
          objectKey: privacyObjectKey(),
          objectVersionId: 'exact-version',
          leaseToken: LEASE_TOKEN,
        },
        expected: {
          scopeKind: 'TENANT',
          workspaceId: null,
          objectClass: 'TENANT_EXPORTS',
          desiredStatus: 'ON',
          revision: 3,
        },
      }),
    ).rejects.toThrow('TENANT_DATA_BROKER_RESOURCE_MISMATCH');
    expect(execute).not.toHaveBeenCalled();
  });

  test('returns outcome-unknown without executing when the atomic begin is ambiguous', async () => {
    const payload = new Uint8Array([0x41, 0x42, 0x43]);
    const checksum = createHash('sha256').update(payload).digest('hex');
    const execute = vi.fn(() => Promise.reject(new Error('effect must not execute')));
    const complete = vi.fn(() => Promise.reject(new Error('must not complete')));
    const fail = vi.fn(() => Promise.reject(new Error('must not fail a prior attempt')));
    const transport = createTenantDataBrokerStreamingHttpTransport({
      audience: 'platform.example.com',
      signingKeys: { current: { id: KEY_ID, value: SIGNING_KEY } },
      authorizer: {
        authorize: () => Promise.resolve(workloadPutAuthorization(payload.byteLength, checksum)),
      },
      attempts: {
        beginAuthenticated: () => Promise.resolve({ outcome: 'AMBIGUOUS' }),
        complete,
        fail,
      },
      effectResolver: unusedEffectResolver(),
      executor: { execute },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    });
    const client = new TenantDataBrokerHttpClient({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: { id: KEY_ID, value: SIGNING_KEY },
      clock: { now: () => NOW },
      nextNonce: () => NONCE,
      transport: (request) => transport.handle(request),
    });

    await expect(
      client.invoke(workloadPutCommand(), {
        body: onePassBody([payload]),
        deadline: new Date(NOW.getTime() + 5_000),
        payloadLength: payload.byteLength,
        payloadSha256: checksum,
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow('TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
    expect(execute).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  test('durably completes a successful cloud effect after the client signal is cancelled', async () => {
    const attemptId = '018f3b76-1000-7000-8000-000000000091';
    const payload = new Uint8Array([0x41, 0x42, 0x43]);
    const checksum = createHash('sha256').update(payload).digest('hex');
    const receipt = {
      bucket: 'aeostudio-staging-artifacts',
      key: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/object.json`,
      versionId: 'version-after-client-cancel',
      checksum,
      contentType: 'application/json',
      byteLength: payload.byteLength,
    };
    const controller = new AbortController();
    const complete = vi.fn(() => Promise.resolve());
    const fail = vi.fn(() => Promise.resolve());
    const transport = createTenantDataBrokerStreamingHttpTransport({
      audience: 'platform.example.com',
      signingKeys: { current: { id: KEY_ID, value: SIGNING_KEY } },
      authorizer: {
        authorize: () => Promise.resolve(workloadPutAuthorization(payload.byteLength, checksum)),
      },
      attempts: {
        beginAuthenticated: () => Promise.resolve({ outcome: 'STARTED' as const, attemptId }),
        complete,
        fail,
      },
      effectResolver: unusedEffectResolver(),
      executor: {
        execute: async (input) => {
          await consumeBody(input.body);
          queueMicrotask(() => controller.abort(new Error('CLIENT_DISCONNECTED')));
          return receipt;
        },
      },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    });
    const client = new TenantDataBrokerHttpClient({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: { id: KEY_ID, value: SIGNING_KEY },
      clock: { now: () => NOW },
      nextNonce: () => NONCE,
      transport: (request) => transport.handle(request),
    });

    await expect(
      client.invoke(workloadPutCommand(), {
        body: onePassBody([payload]),
        deadline: new Date(NOW.getTime() + 5_000),
        payloadLength: payload.byteLength,
        payloadSha256: checksum,
        signal: controller.signal,
      }),
    ).rejects.toThrow('CLIENT_DISCONNECTED');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(complete).toHaveBeenCalledWith({
      attemptId,
      leaseToken: LEASE_TOKEN,
      receipt,
    });
    expect(fail).not.toHaveBeenCalled();
  });

  test('best-effort persists UNKNOWN when a successful cloud effect cannot be completed', async () => {
    const attemptId = '018f3b76-1000-7000-8000-000000000092';
    const payload = new Uint8Array([0x51, 0x52, 0x53]);
    const checksum = createHash('sha256').update(payload).digest('hex');
    const receipt = {
      bucket: 'aeostudio-staging-artifacts',
      key: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/object.json`,
      versionId: 'version-complete-failed',
      checksum,
      contentType: 'application/json',
      byteLength: payload.byteLength,
    };
    const complete = vi.fn(() => Promise.reject(new Error('DATABASE_COMPLETE_UNAVAILABLE')));
    const fail = vi.fn(() => Promise.resolve());
    const transport = createTenantDataBrokerStreamingHttpTransport({
      audience: 'platform.example.com',
      signingKeys: { current: { id: KEY_ID, value: SIGNING_KEY } },
      authorizer: {
        authorize: () => Promise.resolve(workloadPutAuthorization(payload.byteLength, checksum)),
      },
      attempts: {
        beginAuthenticated: () => Promise.resolve({ outcome: 'STARTED' as const, attemptId }),
        complete,
        fail,
      },
      effectResolver: unusedEffectResolver(),
      executor: {
        execute: async (input) => {
          await consumeBody(input.body);
          return receipt;
        },
      },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    });
    const client = new TenantDataBrokerHttpClient({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: { id: KEY_ID, value: SIGNING_KEY },
      clock: { now: () => NOW },
      nextNonce: () => NONCE,
      transport: (request) => transport.handle(request),
    });

    await expect(
      client.invoke(workloadPutCommand(), {
        body: onePassBody([payload]),
        deadline: new Date(NOW.getTime() + 5_000),
        payloadLength: payload.byteLength,
        payloadSha256: checksum,
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow('TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
    expect(complete).toHaveBeenCalledWith({
      attemptId,
      leaseToken: LEASE_TOKEN,
      receipt,
    });
    expect(fail).toHaveBeenCalledWith({
      attemptId,
      leaseToken: LEASE_TOKEN,
      outcome: 'UNKNOWN',
    });
  });

  test('atomically resolves an existing-secret DELETE probe as failed without completing it twice', async () => {
    const attemptId = '018f3b76-1000-7000-8000-000000000093';
    const resolveSecretDelete = vi.fn(() => Promise.resolve('RESOLVED_FAILED' as const));
    const complete = vi.fn(() => Promise.reject(new Error('resolver owns probe completion')));
    const fail = vi.fn(() => Promise.reject(new Error('resolver owns probe completion')));
    const effectResolver = {
      ...unusedEffectResolver(),
      resolveSecretDelete,
    };
    const handler = new TenantDataBrokerHttpHandler({
      audience: 'platform.example.com',
      signingKeys: { current: { id: KEY_ID, value: SIGNING_KEY } },
      authorizer: {
        authorize: () =>
          Promise.resolve({
            outcome: 'AUTHORIZED' as const,
            audit: { resourceReferenceSha256: 'b'.repeat(64) },
            grant: {
              capabilityId: CAPABILITY_ID,
              authorityKind: 'CONNECTOR_DELETION_INTENT' as const,
              authorityReference: AUTHORIZATION_ID,
              scopeKind: 'WORKSPACE' as const,
              tenantId: TENANT_ID,
              workspaceId: WORKSPACE_ID,
              operation: 'DESCRIBE_CONNECTOR_SECRET' as const,
              resource: {
                kind: 'CONNECTOR_SECRET' as const,
                secretArn: SECRET_REFERENCE,
              },
              expiresAt: '2026-07-23T08:01:00.000Z',
            },
          }),
      },
      attempts: {
        beginAuthenticated: () => Promise.resolve({ outcome: 'STARTED' as const, attemptId }),
        complete,
        fail,
      },
      effectResolver,
      executor: {
        execute: async (input) => {
          await consumeBody(input.body);
          return { kind: 'SECRET_DESCRIPTION', exists: true };
        },
      },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    });
    const client = new TenantDataBrokerHttpClient({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: { id: KEY_ID, value: SIGNING_KEY },
      clock: { now: () => NOW },
      nextNonce: () => NONCE,
      transport: (request) => handler.handle(request),
    });

    await expect(
      client.invoke(
        {
          capabilityId: CAPABILITY_ID,
          leaseToken: LEASE_TOKEN,
          authorityReference: AUTHORIZATION_ID,
          scopeKind: 'WORKSPACE',
          tenantId: TENANT_ID,
          workspaceId: WORKSPACE_ID,
          operation: 'DESCRIBE_CONNECTOR_SECRET',
        },
        emptyInvocation(),
      ),
    ).resolves.toEqual({ kind: 'SECRET_DESCRIPTION', exists: true });
    expect(resolveSecretDelete).toHaveBeenCalledWith({
      probeAttemptId: attemptId,
      leaseToken: LEASE_TOKEN,
      observation: 'EXISTS',
    });
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  test('atomically resolves a found workload PUT recovery observation without completing the probe twice', async () => {
    const attemptId = '018f3b76-1000-7000-8000-000000000093';
    const checksum = 'c'.repeat(64);
    const resolveObjectPut = vi.fn(() => Promise.resolve('RESOLVED_SUCCESS' as const));
    const complete = vi.fn(() => Promise.reject(new Error('resolver already completed probe')));
    const fail = vi.fn(() => Promise.reject(new Error('resolved probe must not fail')));
    const result = {
      kind: 'OBJECT_HEAD',
      exists: true,
      bucket: 'aeostudio-workload-prod',
      key: objectKey(),
      versionId: 'version-recovered-1',
      checksum,
      contentType: 'application/json',
      byteLength: 128,
    } as const;
    const transport = new TenantDataBrokerHttpHandler({
      audience: 'platform.example.com',
      signingKeys: { current: { id: KEY_ID, value: SIGNING_KEY } },
      authorizer: {
        authorize: () => Promise.resolve(workloadRecoveryAuthorization(checksum)),
      },
      attempts: {
        beginAuthenticated: () => Promise.resolve({ outcome: 'STARTED' as const, attemptId }),
        complete,
        fail,
      },
      effectResolver: {
        resolveObjectPut,
        resolveLegalHold: () => Promise.reject(new Error('wrong resolver')),
        resolveSecretDelete: () => Promise.reject(new Error('wrong resolver')),
      },
      executor: {
        execute: async (input) => {
          await consumeBody(input.body);
          return result;
        },
      },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    });
    const client = new TenantDataBrokerHttpClient({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: { id: KEY_ID, value: SIGNING_KEY },
      clock: { now: () => NOW },
      nextNonce: () => NONCE,
      transport: (request) => transport.handle(request),
    });

    await expect(client.invoke(workloadRecoveryCommand(), emptyInvocation())).resolves.toEqual(
      result,
    );
    expect(resolveObjectPut).toHaveBeenCalledWith({
      probeAttemptId: attemptId,
      leaseToken: LEASE_TOKEN,
      observation: 'FOUND',
      observedVersionId: result.versionId,
      observedChecksum: result.checksum,
      observedContentType: result.contentType,
      observedByteLength: result.byteLength,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  test('atomically resolves a missing workload PUT recovery observation without completing or failing the probe twice', async () => {
    const attemptId = '018f3b76-1000-7000-8000-000000000094';
    const checksum = 'd'.repeat(64);
    const resolveObjectPut = vi.fn(() => Promise.resolve('RESOLVED_FAILED' as const));
    const complete = vi.fn(() => Promise.reject(new Error('resolver already completed probe')));
    const fail = vi.fn(() => Promise.reject(new Error('resolver already completed probe')));
    const result = {
      kind: 'OBJECT_HEAD',
      exists: false,
      bucket: 'aeostudio-workload-prod',
      key: objectKey(),
    } as const;
    const transport = new TenantDataBrokerHttpHandler({
      audience: 'platform.example.com',
      signingKeys: { current: { id: KEY_ID, value: SIGNING_KEY } },
      authorizer: {
        authorize: () => Promise.resolve(workloadRecoveryAuthorization(checksum)),
      },
      attempts: {
        beginAuthenticated: () => Promise.resolve({ outcome: 'STARTED' as const, attemptId }),
        complete,
        fail,
      },
      effectResolver: {
        resolveObjectPut,
        resolveLegalHold: () => Promise.reject(new Error('wrong resolver')),
        resolveSecretDelete: () => Promise.reject(new Error('wrong resolver')),
      },
      executor: {
        execute: async (input) => {
          await consumeBody(input.body);
          return result;
        },
      },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    });
    const client = new TenantDataBrokerHttpClient({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: { id: KEY_ID, value: SIGNING_KEY },
      clock: { now: () => NOW },
      nextNonce: () => NONCE,
      transport: (request) => transport.handle(request),
    });

    await expect(client.invoke(workloadRecoveryCommand(), emptyInvocation())).resolves.toEqual(
      result,
    );
    expect(resolveObjectPut).toHaveBeenCalledWith({
      probeAttemptId: attemptId,
      leaseToken: LEASE_TOKEN,
      observation: 'MISSING',
      observedVersionId: null,
      observedChecksum: null,
      observedContentType: null,
      observedByteLength: null,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  test('atomically resolves a mismatched workload PUT recovery observation and reports the strict mismatch', async () => {
    const attemptId = '018f3b76-1000-7000-8000-000000000095';
    const checksum = 'e'.repeat(64);
    const resolveObjectPut = vi.fn(() => Promise.resolve('RESOLVED_FAILED' as const));
    const complete = vi.fn(() => Promise.reject(new Error('resolver already completed probe')));
    const fail = vi.fn(() => Promise.reject(new Error('resolver already completed probe')));
    const transport = new TenantDataBrokerHttpHandler({
      audience: 'platform.example.com',
      signingKeys: { current: { id: KEY_ID, value: SIGNING_KEY } },
      authorizer: {
        authorize: () => Promise.resolve(workloadRecoveryAuthorization(checksum)),
      },
      attempts: {
        beginAuthenticated: () => Promise.resolve({ outcome: 'STARTED' as const, attemptId }),
        complete,
        fail,
      },
      effectResolver: {
        resolveObjectPut,
        resolveLegalHold: () => Promise.reject(new Error('wrong resolver')),
        resolveSecretDelete: () => Promise.reject(new Error('wrong resolver')),
      },
      executor: {
        execute: async (input) => {
          await consumeBody(input.body);
          throw new Error('TENANT_DATA_BROKER_HEAD_METADATA_MISMATCH');
        },
      },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    });
    const client = new TenantDataBrokerHttpClient({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: { id: KEY_ID, value: SIGNING_KEY },
      clock: { now: () => NOW },
      nextNonce: () => NONCE,
      transport: (request) => transport.handle(request),
    });

    await expect(client.invoke(workloadRecoveryCommand(), emptyInvocation())).rejects.toThrow(
      'TENANT_DATA_EFFECT_FAILED',
    );
    expect(resolveObjectPut).toHaveBeenCalledWith({
      probeAttemptId: attemptId,
      leaseToken: LEASE_TOKEN,
      observation: 'MISMATCH',
      observedVersionId: null,
      observedChecksum: null,
      observedContentType: null,
      observedByteLength: null,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  test.each([
    {
      observation: 'FOUND' as const,
      executorResult: {
        kind: 'OBJECT_HEAD',
        exists: true,
        bucket: 'aeostudio-exports-prod',
        key: privacyObjectKey(),
        versionId: 'privacy-version-recovered-1',
        checksum: 'f'.repeat(64),
        contentType: 'application/json',
        byteLength: 256,
      },
      executorError: null,
      resolverResult: 'RESOLVED_SUCCESS' as const,
      expectedError: null,
      observedVersionId: 'privacy-version-recovered-1',
      observedChecksum: 'f'.repeat(64),
      observedContentType: 'application/json',
      observedByteLength: 256,
    },
    {
      observation: 'MISSING' as const,
      executorResult: {
        kind: 'OBJECT_HEAD',
        exists: false,
        bucket: 'aeostudio-exports-prod',
        key: privacyObjectKey(),
      },
      executorError: null,
      resolverResult: 'RESOLVED_FAILED' as const,
      expectedError: null,
      observedVersionId: null,
      observedChecksum: null,
      observedContentType: null,
      observedByteLength: null,
    },
    {
      observation: 'MISMATCH' as const,
      executorResult: null,
      executorError: 'TENANT_DATA_BROKER_HEAD_METADATA_MISMATCH',
      resolverResult: 'RESOLVED_FAILED' as const,
      expectedError: 'TENANT_DATA_EFFECT_FAILED',
      observedVersionId: null,
      observedChecksum: null,
      observedContentType: null,
      observedByteLength: null,
    },
  ])(
    'atomically resolves a $observation privacy PUT recovery observation without a second attempt finish',
    async ({
      observation,
      executorResult,
      executorError,
      resolverResult,
      expectedError,
      observedVersionId,
      observedChecksum,
      observedContentType,
      observedByteLength,
    }) => {
      const attemptId = '018f3b76-1000-7000-8000-000000000096';
      const checksum = 'f'.repeat(64);
      const resolveObjectPut = vi.fn(() => Promise.resolve(resolverResult));
      const complete = vi.fn(() => Promise.reject(new Error('resolver already completed probe')));
      const fail = vi.fn(() => Promise.reject(new Error('resolver already completed probe')));
      const transport = new TenantDataBrokerHttpHandler({
        audience: 'platform.example.com',
        signingKeys: { current: { id: KEY_ID, value: SIGNING_KEY } },
        authorizer: {
          authorize: () => Promise.resolve(privacyRecoveryAuthorization(checksum)),
        },
        attempts: {
          beginAuthenticated: () => Promise.resolve({ outcome: 'STARTED' as const, attemptId }),
          complete,
          fail,
        },
        effectResolver: {
          resolveObjectPut,
          resolveLegalHold: () => Promise.reject(new Error('wrong resolver')),
          resolveSecretDelete: () => Promise.reject(new Error('wrong resolver')),
        },
        executor: {
          execute: async (input) => {
            await consumeBody(input.body);
            if (executorError !== null) throw new Error(executorError);
            return executorResult;
          },
        },
        clock: { now: () => NOW },
        logger: { info: () => undefined, warn: () => undefined },
      });
      const client = new TenantDataBrokerHttpClient({
        endpoint: 'https://platform.example.com/internal/v1/tenant-data',
        signingKey: { id: KEY_ID, value: SIGNING_KEY },
        clock: { now: () => NOW },
        nextNonce: () => NONCE,
        transport: (request) => transport.handle(request),
      });
      const invocation = client.invoke(privacyRecoveryCommand(), emptyInvocation());

      if (expectedError === null) {
        await expect(invocation).resolves.toEqual(executorResult);
      } else {
        await expect(invocation).rejects.toThrow(expectedError);
      }
      expect(resolveObjectPut).toHaveBeenCalledWith({
        probeAttemptId: attemptId,
        leaseToken: LEASE_TOKEN,
        observation,
        observedVersionId,
        observedChecksum,
        observedContentType,
        observedByteLength,
      });
      expect(complete).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['ON', 'RESOLVED_SUCCESS'],
    ['OFF', 'RESOLVED_FAILED'],
  ] as const)(
    'atomically resolves a legal-hold %s recovery observation without completing the probe twice',
    async (status, resolverResult) => {
      const attemptId = '018f3b76-1000-7000-8000-000000000097';
      const resolveLegalHold = vi.fn(() => Promise.resolve(resolverResult));
      const complete = vi.fn(() => Promise.reject(new Error('resolver already completed probe')));
      const fail = vi.fn(() => Promise.reject(new Error('resolver already completed probe')));
      const result = {
        kind: 'OBJECT_LEGAL_HOLD',
        bucket: 'aeostudio-workload-prod',
        key: objectKey(),
        versionId: 'exact-version',
        status,
      } as const;
      const transport = new TenantDataBrokerHttpHandler({
        audience: 'platform.example.com',
        signingKeys: { current: { id: KEY_ID, value: SIGNING_KEY } },
        authorizer: {
          authorize: () => Promise.resolve(legalHoldRecoveryAuthorization()),
        },
        attempts: {
          beginAuthenticated: () => Promise.resolve({ outcome: 'STARTED' as const, attemptId }),
          complete,
          fail,
        },
        effectResolver: {
          resolveObjectPut: () => Promise.reject(new Error('wrong resolver')),
          resolveLegalHold,
          resolveSecretDelete: () => Promise.reject(new Error('wrong resolver')),
        },
        executor: {
          execute: async (input) => {
            await consumeBody(input.body);
            return result;
          },
        },
        clock: { now: () => NOW },
        logger: { info: () => undefined, warn: () => undefined },
      });
      const client = new TenantDataBrokerHttpClient({
        endpoint: 'https://platform.example.com/internal/v1/tenant-data',
        signingKey: { id: KEY_ID, value: SIGNING_KEY },
        clock: { now: () => NOW },
        nextNonce: () => NONCE,
        transport: (request) => transport.handle(request),
      });

      await expect(client.invoke(legalHoldRecoveryCommand(), emptyInvocation())).resolves.toEqual(
        result,
      );
      expect(resolveLegalHold).toHaveBeenCalledWith({
        probeAttemptId: attemptId,
        leaseToken: LEASE_TOKEN,
        observedStatus: status,
      });
      expect(complete).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['NOT_RESOLVED', 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN'],
    ['THROW', 'TENANT_DATA_BROKER_UNAVAILABLE'],
  ] as const)(
    'does not report a recovered object effect when its resolver returns %s',
    async (resolverBehavior, expectedCode) => {
      const attemptId = '018f3b76-1000-7000-8000-000000000098';
      const checksum = '1'.repeat(64);
      const complete = vi.fn(() => Promise.resolve());
      const fail = vi.fn(() => Promise.resolve());
      const transport = new TenantDataBrokerHttpHandler({
        audience: 'platform.example.com',
        signingKeys: { current: { id: KEY_ID, value: SIGNING_KEY } },
        authorizer: {
          authorize: () => Promise.resolve(workloadRecoveryAuthorization(checksum)),
        },
        attempts: {
          beginAuthenticated: () => Promise.resolve({ outcome: 'STARTED' as const, attemptId }),
          complete,
          fail,
        },
        effectResolver: {
          resolveObjectPut: () =>
            resolverBehavior === 'THROW'
              ? Promise.reject(new Error('resolver unavailable'))
              : Promise.resolve('NOT_RESOLVED' as const),
          resolveLegalHold: () => Promise.reject(new Error('wrong resolver')),
          resolveSecretDelete: () => Promise.reject(new Error('wrong resolver')),
        },
        executor: {
          execute: async (input) => {
            await consumeBody(input.body);
            return {
              kind: 'OBJECT_HEAD',
              exists: true,
              bucket: 'aeostudio-workload-prod',
              key: objectKey(),
              versionId: 'version-unresolved-1',
              checksum,
              contentType: 'application/json',
              byteLength: 128,
            };
          },
        },
        clock: { now: () => NOW },
        logger: { info: () => undefined, warn: () => undefined },
      });
      const client = new TenantDataBrokerHttpClient({
        endpoint: 'https://platform.example.com/internal/v1/tenant-data',
        signingKey: { id: KEY_ID, value: SIGNING_KEY },
        clock: { now: () => NOW },
        nextNonce: () => NONCE,
        transport: (request) => transport.handle(request),
      });

      await expect(client.invoke(workloadRecoveryCommand(), emptyInvocation())).rejects.toThrow(
        expectedCode,
      );
      expect(complete).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['NOT_RESOLVED', 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN'],
    ['THROW', 'TENANT_DATA_BROKER_UNAVAILABLE'],
  ] as const)(
    'does not report a recovered legal-hold effect when its resolver returns %s',
    async (resolverBehavior, expectedCode) => {
      const attemptId = '018f3b76-1000-7000-8000-000000000099';
      const complete = vi.fn(() => Promise.resolve());
      const fail = vi.fn(() => Promise.resolve());
      const transport = new TenantDataBrokerHttpHandler({
        audience: 'platform.example.com',
        signingKeys: { current: { id: KEY_ID, value: SIGNING_KEY } },
        authorizer: {
          authorize: () => Promise.resolve(legalHoldRecoveryAuthorization()),
        },
        attempts: {
          beginAuthenticated: () => Promise.resolve({ outcome: 'STARTED' as const, attemptId }),
          complete,
          fail,
        },
        effectResolver: {
          resolveObjectPut: () => Promise.reject(new Error('wrong resolver')),
          resolveLegalHold: () =>
            resolverBehavior === 'THROW'
              ? Promise.reject(new Error('resolver unavailable'))
              : Promise.resolve('NOT_RESOLVED' as const),
          resolveSecretDelete: () => Promise.reject(new Error('wrong resolver')),
        },
        executor: {
          execute: async (input) => {
            await consumeBody(input.body);
            return {
              kind: 'OBJECT_LEGAL_HOLD',
              bucket: 'aeostudio-workload-prod',
              key: objectKey(),
              versionId: 'exact-version',
              status: 'ON',
            };
          },
        },
        clock: { now: () => NOW },
        logger: { info: () => undefined, warn: () => undefined },
      });
      const client = new TenantDataBrokerHttpClient({
        endpoint: 'https://platform.example.com/internal/v1/tenant-data',
        signingKey: { id: KEY_ID, value: SIGNING_KEY },
        clock: { now: () => NOW },
        nextNonce: () => NONCE,
        transport: (request) => transport.handle(request),
      });

      await expect(client.invoke(legalHoldRecoveryCommand(), emptyInvocation())).rejects.toThrow(
        expectedCode,
      );
      expect(complete).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
    },
  );

  test('frames GET metadata separately and completes only after the response stream verifies', async () => {
    const payload = Uint8Array.from({ length: 4_096 }, (_, index) => index % 251);
    const checksum = createHash('sha256').update(payload).digest('hex');
    const complete = vi.fn(() => Promise.resolve());
    const fail = vi.fn(() => Promise.resolve());
    let upstreamPulls = 0;
    let responseHeaders: Readonly<Record<string, string>> | undefined;
    const upstream = trackedBody([payload], {
      onPull: () => {
        upstreamPulls += 1;
      },
    });
    const transport = createTenantDataBrokerStreamingHttpTransport({
      audience: 'platform.example.com',
      signingKeys: { current: { id: KEY_ID, value: SIGNING_KEY } },
      authorizer: {
        authorize: () => Promise.resolve(workloadReadAuthorization(payload.byteLength, checksum)),
      },
      attempts: {
        beginAuthenticated: () =>
          Promise.resolve({
            outcome: 'STARTED',
            attemptId: '018f3b76-1000-7000-8000-000000000091',
          }),
        complete,
        fail,
      },
      effectResolver: unusedEffectResolver(),
      executor: {
        execute: async (input) => {
          await consumeBody(input.body);
          return {
            kind: 'OBJECT_STREAM',
            bucket: 'aeostudio-staging-artifacts',
            key: objectKey(),
            versionId: 'version-read-1',
            checksum,
            contentType: 'application/octet-stream',
            byteLength: payload.byteLength,
            transportChecksumSha256: 'transport-checksum',
            body: upstream,
          };
        },
      },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    });
    const client = new TenantDataBrokerHttpClient({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: { id: KEY_ID, value: SIGNING_KEY },
      clock: { now: () => NOW },
      nextNonce: () => NONCE,
      transport: async (request) => {
        const response = await transport.handle(request);
        responseHeaders = response.headers;
        return response;
      },
    });

    const result = (await client.invoke(workloadReadCommand(), emptyInvocation())) as {
      kind: string;
      checksum: string;
      contentType: string;
      byteLength: number;
      body: AsyncIterable<Uint8Array>;
    };

    expect(result).toMatchObject({
      kind: 'OBJECT_STREAM',
      checksum,
      contentType: 'application/octet-stream',
      byteLength: payload.byteLength,
    });
    expect(responseHeaders).toMatchObject({
      'cache-control': 'no-store',
      'content-length': String(payload.byteLength),
      'content-type': 'application/octet-stream',
      'x-aeostudio-result-kind': 'OBJECT_STREAM',
    });
    expect(upstreamPulls).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    await expect(consumeBody(result.body)).resolves.toEqual(payload);
    expect(upstreamPulls).toBe(1);
    expect(complete).toHaveBeenCalledWith({
      attemptId: '018f3b76-1000-7000-8000-000000000091',
      leaseToken: LEASE_TOKEN,
      receipt: null,
    });
    expect(fail).not.toHaveBeenCalled();
  });

  test('propagates GET response cancellation upstream and durably fails the read attempt', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    const payload = new Uint8Array([1, 2, 3, 4]);
    const checksum = createHash('sha256').update(payload).digest('hex');
    const complete = vi.fn(() => Promise.resolve());
    const fail = vi.fn(() => Promise.resolve());
    let upstreamReturns = 0;
    const transport = createTenantDataBrokerStreamingHttpTransport({
      audience: 'platform.example.com',
      signingKeys: { current: { id: KEY_ID, value: SIGNING_KEY } },
      authorizer: {
        authorize: () => Promise.resolve(workloadReadAuthorization(payload.byteLength, checksum)),
      },
      attempts: {
        beginAuthenticated: () =>
          Promise.resolve({
            outcome: 'STARTED',
            attemptId: '018f3b76-1000-7000-8000-000000000092',
          }),
        complete,
        fail,
      },
      effectResolver: unusedEffectResolver(),
      executor: {
        execute: async (input) => {
          await consumeBody(input.body);
          return {
            kind: 'OBJECT_STREAM',
            bucket: 'aeostudio-staging-artifacts',
            key: objectKey(),
            versionId: 'version-read-1',
            checksum,
            contentType: 'application/octet-stream',
            byteLength: payload.byteLength,
            transportChecksumSha256: 'transport-checksum',
            body: trackedBody(chunks, {
              onReturn: () => {
                upstreamReturns += 1;
              },
            }),
          };
        },
      },
      clock: { now: () => NOW },
      logger: { info: () => undefined, warn: () => undefined },
    });
    const client = new TenantDataBrokerHttpClient({
      endpoint: 'https://platform.example.com/internal/v1/tenant-data',
      signingKey: { id: KEY_ID, value: SIGNING_KEY },
      clock: { now: () => NOW },
      nextNonce: () => NONCE,
      transport: (request) => transport.handle(request),
    });
    const result = (await client.invoke(workloadReadCommand(), emptyInvocation())) as {
      body: AsyncIterable<Uint8Array>;
    };
    const iterator = result.body[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: chunks[0],
    });
    await iterator.return?.();

    expect(upstreamReturns).toBe(1);
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith({
      attemptId: '018f3b76-1000-7000-8000-000000000092',
      leaseToken: LEASE_TOKEN,
      outcome: 'FAILED',
    });
  });
});

function workloadPutCommand() {
  return {
    capabilityId: CAPABILITY_ID,
    leaseToken: LEASE_TOKEN,
    authorityReference: AUTHORIZATION_ID,
    scopeKind: 'WORKSPACE' as const,
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    operation: 'PUT_WORKLOAD_OBJECT' as const,
  };
}

function workloadPutAuthorization(byteLength: number, checksumSha256: string) {
  return {
    outcome: 'AUTHORIZED' as const,
    audit: { resourceReferenceSha256: 'a'.repeat(64) },
    grant: {
      capabilityId: CAPABILITY_ID,
      authorityKind: 'WORKLOAD_WRITE_INTENT' as const,
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE' as const,
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'PUT_WORKLOAD_OBJECT' as const,
      resource: {
        kind: 'WORKLOAD_OBJECT_PUT' as const,
        objectClass: 'WORKLOAD_OBJECTS' as const,
        bucket: 'aeostudio-staging-artifacts',
        key: `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/object.json`,
        checksumSha256,
        contentType: 'application/json',
        byteLength,
        lockedUntil: null,
        sealedAt: null,
      },
      expiresAt: '2026-07-23T08:01:00.000Z',
    },
  };
}

function workloadReadCommand() {
  return {
    capabilityId: CAPABILITY_ID,
    leaseToken: LEASE_TOKEN,
    authorityReference: AUTHORIZATION_ID,
    scopeKind: 'WORKSPACE' as const,
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    operation: 'READ_WORKLOAD_OBJECT' as const,
  };
}

function workloadRecoveryCommand() {
  return {
    capabilityId: CAPABILITY_ID,
    leaseToken: LEASE_TOKEN,
    authorityReference: AUTHORIZATION_ID,
    scopeKind: 'WORKSPACE' as const,
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    operation: 'HEAD_WORKLOAD_OBJECT' as const,
  };
}

function workloadRecoveryAuthorization(checksumSha256: string) {
  return {
    outcome: 'AUTHORIZED' as const,
    audit: { resourceReferenceSha256: 'c'.repeat(64) },
    grant: {
      capabilityId: CAPABILITY_ID,
      authorityKind: 'WORKLOAD_WRITE_INTENT' as const,
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE' as const,
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'HEAD_WORKLOAD_OBJECT' as const,
      resource: {
        kind: 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD' as const,
        objectClass: 'WORKLOAD_OBJECTS' as const,
        bucket: 'aeostudio-workload-prod',
        key: objectKey(),
        expectedChecksumSha256: checksumSha256,
        expectedContentType: 'application/json',
        expectedByteLength: 128,
        lockedUntil: null,
        sealedAt: null,
      },
      expiresAt: '2026-07-23T08:01:00.000Z',
    },
  };
}

function privacyRecoveryCommand() {
  return {
    capabilityId: CAPABILITY_ID,
    leaseToken: LEASE_TOKEN,
    authorityReference: AUTHORIZATION_ID,
    scopeKind: 'TENANT' as const,
    tenantId: TENANT_ID,
    workspaceId: null,
    operation: 'HEAD_PRIVACY_OBJECT' as const,
  };
}

function privacyRecoveryAuthorization(checksumSha256: string) {
  return {
    outcome: 'AUTHORIZED' as const,
    audit: { resourceReferenceSha256: 'd'.repeat(64) },
    grant: {
      capabilityId: CAPABILITY_ID,
      authorityKind: 'PRIVACY_WRITE_INTENT' as const,
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'TENANT' as const,
      tenantId: TENANT_ID,
      workspaceId: null,
      operation: 'HEAD_PRIVACY_OBJECT' as const,
      resource: {
        kind: 'PRIVACY_OBJECT_WRITE_RECOVERY_HEAD' as const,
        objectClass: 'TENANT_EXPORTS' as const,
        bucket: 'aeostudio-exports-prod',
        key: privacyObjectKey(),
        expectedChecksumSha256: checksumSha256,
        expectedContentType: 'application/json',
        expectedByteLength: 256,
        lockedUntil: null,
        sealedAt: null,
      },
      expiresAt: '2026-07-23T08:01:00.000Z',
    },
  };
}

function privacyObjectKey(): string {
  return `tenants/${TENANT_ID}/exports/exact.json`;
}

function legalHoldRecoveryCommand() {
  return {
    capabilityId: CAPABILITY_ID,
    leaseToken: LEASE_TOKEN,
    authorityReference: AUTHORIZATION_ID,
    scopeKind: 'WORKSPACE' as const,
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    operation: 'GET_OBJECT_LEGAL_HOLD' as const,
  };
}

function legalHoldRecoveryAuthorization() {
  return {
    outcome: 'AUTHORIZED' as const,
    audit: { resourceReferenceSha256: 'e'.repeat(64) },
    grant: {
      capabilityId: CAPABILITY_ID,
      authorityKind: 'LEGAL_HOLD_RECONCILIATION_INTENT' as const,
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE' as const,
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'GET_OBJECT_LEGAL_HOLD' as const,
      resource: {
        kind: 'OBJECT_LEGAL_HOLD_READ' as const,
        objectClass: 'WORKLOAD_OBJECTS' as const,
        bucket: 'aeostudio-workload-prod',
        key: objectKey(),
        versionId: 'exact-version',
      },
      expiresAt: '2026-07-23T08:01:00.000Z',
    },
  };
}

function crashResumeAuthorization(command: TenantDataAccessRequest): TenantDataAuthorization {
  const common = {
    capabilityId: command.capabilityId,
    authorityReference: command.authorityReference,
    scopeKind: command.scopeKind,
    tenantId: command.tenantId,
    workspaceId: command.workspaceId,
    expiresAt: '2026-07-23T08:01:00.000Z',
  };
  switch (command.operation) {
    case 'DELETE_CONNECTOR_SECRET':
      return {
        outcome: 'AUTHORIZED',
        audit: { resourceReferenceSha256: 'a'.repeat(64) },
        grant: {
          ...common,
          authorityKind: 'CONNECTOR_DELETION_INTENT',
          operation: command.operation,
          resource: {
            kind: 'CONNECTOR_SECRET',
            secretArn: SECRET_REFERENCE,
          },
        },
      };
    case 'DELETE_WORKLOAD_OBJECT_VERSION':
      return {
        outcome: 'AUTHORIZED',
        audit: { resourceReferenceSha256: 'b'.repeat(64) },
        grant: {
          ...common,
          authorityKind: 'DELETION_OBJECT_INTENT',
          operation: command.operation,
          resource: {
            kind: 'OBJECT_VERSION_DELETE',
            objectClass: 'WORKLOAD_OBJECTS',
            bucket: 'aeostudio-workload-prod',
            key: objectKey(),
            versionId: 'exact-version',
            isDeleteMarker: false,
          },
        },
      };
    case 'SET_OBJECT_LEGAL_HOLD':
      return {
        outcome: 'AUTHORIZED',
        audit: { resourceReferenceSha256: 'c'.repeat(64) },
        grant: {
          ...common,
          authorityKind: 'LEGAL_HOLD_RECONCILIATION_INTENT',
          operation: command.operation,
          resource: {
            kind: 'OBJECT_LEGAL_HOLD_WRITE',
            objectClass: 'TENANT_EXPORTS',
            bucket: 'aeostudio-exports-prod',
            key: privacyObjectKey(),
            versionId: 'exact-version',
            desiredStatus: 'ON',
            revision: 3,
          },
        },
      };
    default:
      throw new Error(`UNEXPECTED_CRASH_RESUME_OPERATION:${command.operation}`);
  }
}

function crashResumeIssuer(): TenantDataBrokerClientCapabilityIssuer {
  const issue = () => Promise.resolve(CAPABILITY_ID);
  return {
    issueAuthenticatedObjectRead: issue,
    issueWorkloadObjectPut: issue,
    issuePublicationPackageRead: issue,
    issuePublicationSecretRead: issue,
    issueChannelAuthorizationValidationSecretRead: issue,
    issuePrivacyObjectPut: issue,
    issuePrivacyObjectRecoveryHead: issue,
    issueWorkloadObjectRecoveryHead: issue,
    issueConnectorSecretDescribe: issue,
    issueConnectorSecretDelete: issue,
    issueConnectorSecretVerifyUnreadable: issue,
    issueDeletionInventory: issue,
    issueDeletionObjectHead: issue,
    issueDeletionObjectGetLegalHold: issue,
    issueDeletionObjectDelete: issue,
    issueLegalHoldSet: issue,
    issueLegalHoldGetRecovery: issue,
  };
}

function workloadReadAuthorization(byteLength: number, checksumSha256: string) {
  return {
    outcome: 'AUTHORIZED' as const,
    audit: { resourceReferenceSha256: 'b'.repeat(64) },
    grant: {
      capabilityId: CAPABILITY_ID,
      authorityKind: 'ACTIVE_JOB_OBJECT_READ' as const,
      authorityReference: AUTHORIZATION_ID,
      scopeKind: 'WORKSPACE' as const,
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      operation: 'READ_WORKLOAD_OBJECT' as const,
      resource: {
        kind: 'OBJECT_VERSION' as const,
        objectClass: 'WORKLOAD_OBJECTS' as const,
        bucket: 'aeostudio-staging-artifacts',
        key: objectKey(),
        versionId: 'version-read-1',
        checksumSha256,
        contentType: 'application/octet-stream',
        byteLength,
      },
      expiresAt: '2026-07-23T08:01:00.000Z',
    },
  };
}

function objectKey(): string {
  return `tenants/${TENANT_ID}/workspaces/${WORKSPACE_ID}/artifacts/object.json`;
}

function onePassBody(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  let used = false;
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      if (used) throw new Error('body reused');
      used = true;
      for (const chunk of chunks) yield chunk;
    },
  };
}

function trackedBody(
  chunks: readonly Uint8Array[],
  callbacks: { onPull?(): void; onReturn?(): void },
): AsyncIterable<Uint8Array> {
  let used = false;
  return {
    [Symbol.asyncIterator]() {
      if (used) throw new Error('body reused');
      used = true;
      let index = 0;
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (index >= chunks.length) {
            return Promise.resolve({ done: true, value: undefined });
          }
          callbacks.onPull?.();
          const value = chunks[index];
          if (value === undefined) {
            return Promise.resolve({ done: true, value: undefined });
          }
          index += 1;
          return Promise.resolve({ done: false, value });
        },
        return(): Promise<IteratorResult<Uint8Array>> {
          callbacks.onReturn?.();
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

interface StreamingExecution {
  body: AsyncIterable<Uint8Array>;
  signal: AbortSignal;
  deadline: Date;
  grant: unknown;
}

function emptyInvocation() {
  return {
    body: onePassBody([]),
    deadline: new Date(NOW.getTime() + 5_000),
    payloadLength: 0,
    payloadSha256: createHash('sha256').update(new Uint8Array()).digest('hex'),
    signal: AbortSignal.timeout(5_000),
  };
}

async function consumeBody(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    chunks.push(Uint8Array.from(chunk));
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
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
