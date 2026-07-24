import { describe, expect, it, vi } from 'vitest';

import { createTenantDataBrokerRuntime } from './tenant-data-broker-runtime.js';

const validEnvironment = {
  NODE_ENV: 'production',
  AEOSTUDIO_WORKER_MODE: 'tenant-data-broker',
  TENANT_DATA_BROKER_DATABASE_URL:
    'postgresql://aeostudio_broker:password@database.internal:5432/aeostudio?sslmode=verify-full',
  TENANT_DATA_BROKER_DATABASE_POOL_MAX: '5',
  TENANT_DATA_BROKER_HMAC_KEY_RING: JSON.stringify({
    schemaVersion: 'aeostudio.tenant-data-broker-key-ring.v1',
    current: {
      id: 'broker-current',
      value: 'tenant-data-broker-hmac-key-at-least-32-bytes',
    },
  }),
  AWS_REGION: 'ap-southeast-1',
  AWS_ACCOUNT_ID: '123456789012',
  ARTIFACT_BUCKET: 'aeostudio-production-artifacts',
  AUDIT_EVIDENCE_BUCKET: 'aeostudio-production-audit-evidence',
  S3_KMS_KEY_ARN:
    'arn:aws:kms:ap-southeast-1:123456789012:key/018f7e63-bc14-7750-89f6-a069c6db4cb5',
  TENANT_DATA_BROKER_AUDIENCE: 'broker.example.internal',
  PORT: '3300',
} as const;

describe('tenant data broker runtime', () => {
  it('rejects an incomplete production contract before allocating resources', async () => {
    const createPool = vi.fn();

    await expect(
      createTenantDataBrokerRuntime({
        environment: {},
        factories: { createPool },
      }),
    ).rejects.toThrow('TENANT_DATA_BROKER_DATABASE_URL_REQUIRED');

    expect(createPool).not.toHaveBeenCalled();
  });

  it.each([
    ['NODE_ENV', 'development', 'TENANT_DATA_BROKER_PRODUCTION_REQUIRED'],
    ['AEOSTUDIO_WORKER_MODE', 'worker', 'TENANT_DATA_BROKER_MODE_REQUIRED'],
    [
      'TENANT_DATA_BROKER_DATABASE_URL',
      ' https://database.internal ',
      'TENANT_DATA_BROKER_DATABASE_URL_INVALID',
    ],
    ['TENANT_DATA_BROKER_HMAC_KEY_RING', '{}', 'TENANT_DATA_BROKER_SIGNING_KEYS_INVALID'],
    ['AWS_REGION', 'us-east-1', 'AWS_SINGAPORE_REGION_REQUIRED'],
    ['AWS_ACCOUNT_ID', '123', 'TENANT_DATA_BROKER_AWS_ACCOUNT_ID_INVALID'],
    ['ARTIFACT_BUCKET', 'Bad_Bucket', 'TENANT_DATA_BROKER_ARTIFACT_BUCKET_INVALID'],
    ['AUDIT_EVIDENCE_BUCKET', 'Bad_Bucket', 'TENANT_DATA_BROKER_AUDIT_EVIDENCE_BUCKET_INVALID'],
    [
      'S3_KMS_KEY_ARN',
      'arn:aws:kms:us-east-1:123456789012:key/018f7e63-bc14-7750-89f6-a069c6db4cb5',
      'TENANT_DATA_BROKER_KMS_KEY_INVALID',
    ],
    [
      'TENANT_DATA_BROKER_AUDIENCE',
      'https://broker.example.internal',
      'TENANT_DATA_BROKER_AUDIENCE_INVALID',
    ],
    ['PORT', '03300', 'TENANT_DATA_BROKER_PORT_INVALID'],
  ] as const)(
    'rejects malformed %s before allocating resources',
    async (name, value, expectedError) => {
      const createPool = vi.fn();

      await expect(
        createTenantDataBrokerRuntime({
          environment: { ...validEnvironment, [name]: value },
          factories: { createPool },
        }),
      ).rejects.toThrow(expectedError);

      expect(createPool).not.toHaveBeenCalled();
    },
  );

  it('composes the isolated broker and starts its private server exactly once', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ ready: 1 }] }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const cloud = {
      s3: { kind: 's3-port' },
      secrets: { kind: 'secrets-port' },
      close: vi.fn(),
    };
    const executor = { execute: vi.fn() };
    const handler = { handle: vi.fn() };
    const server = {
      listen: vi.fn().mockResolvedValue({ host: '0.0.0.0', port: 3300 }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const createPool = vi.fn(() => pool);
    const createCloudResource = vi.fn(() => cloud);
    const createExecutor = vi.fn(() => executor);
    let capturedHandlerOptions:
      | {
          attempts: unknown;
          authorizer: unknown;
          effectResolver: unknown;
        }
      | undefined;
    const createHandler = vi.fn((options: unknown) => {
      capturedHandlerOptions = options as {
        attempts: unknown;
        authorizer: unknown;
        effectResolver: unknown;
      };
      return handler;
    });
    let capturedServerOptions:
      | {
          readiness(): Promise<boolean>;
        }
      | undefined;
    const createServer = vi.fn((options: unknown) => {
      capturedServerOptions = options as { readiness(): Promise<boolean> };
      return server;
    });

    const runtime = await createTenantDataBrokerRuntime({
      environment: validEnvironment,
      logger,
      clock: { now: () => new Date('2026-07-23T00:00:00.000Z') },
      factories: {
        createPool,
        createCloudResource,
        createExecutor,
        createHandler,
        createServer,
      } as never,
    });

    expect(createPool).toHaveBeenCalledWith(validEnvironment.TENANT_DATA_BROKER_DATABASE_URL, 5);
    expect(createCloudResource).toHaveBeenCalledWith({ region: 'ap-southeast-1' });
    expect(createExecutor).toHaveBeenCalledWith({
      artifactBucket: validEnvironment.ARTIFACT_BUCKET,
      auditEvidenceBucket: validEnvironment.AUDIT_EVIDENCE_BUCKET,
      expectedBucketOwner: validEnvironment.AWS_ACCOUNT_ID,
      kmsKeyArn: validEnvironment.S3_KMS_KEY_ARN,
      multipartPartBytes: 5 * 1_024 * 1_024,
      s3: cloud.s3,
      secrets: cloud.secrets,
    });
    expect(createHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: validEnvironment.TENANT_DATA_BROKER_AUDIENCE,
        executor,
      }),
    );
    if (capturedHandlerOptions === undefined) throw new Error('HANDLER_OPTIONS_NOT_CAPTURED');
    expect(capturedHandlerOptions.attempts).toBe(capturedHandlerOptions.effectResolver);
    const capturedAuthorizer = capturedHandlerOptions.authorizer;
    if (capturedAuthorizer === null || typeof capturedAuthorizer !== 'object') {
      throw new Error('AUTHORIZER_NOT_COMPOSED');
    }
    expect(typeof (capturedAuthorizer as Record<string, unknown>).authorize).toBe('function');
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: validEnvironment.TENANT_DATA_BROKER_AUDIENCE,
        handler,
        requestDeadlineCapMs: 30_000,
        gracefulCloseTimeoutMs: 30_000,
      }),
    );

    const firstStart = runtime.start();
    const secondStart = runtime.start();
    expect(firstStart).toBe(secondStart);
    await expect(firstStart).resolves.toEqual({ host: '0.0.0.0', port: 3300 });
    expect(server.listen).toHaveBeenCalledTimes(1);
    expect(server.listen).toHaveBeenCalledWith({ host: '0.0.0.0', port: 3300 });

    if (capturedServerOptions === undefined) throw new Error('SERVER_OPTIONS_NOT_CAPTURED');
    await expect(capturedServerOptions.readiness()).resolves.toBe(true);
    expect(pool.query).toHaveBeenCalledWith('SELECT 1 AS ready', []);
  });

  it('reports not ready unless PostgreSQL returns the exact SELECT 1 sentinel', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ ready: 0 }] }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const cloud = {
      s3: {},
      secrets: {},
      close: vi.fn(),
    };
    const server = {
      listen: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    let readiness: (() => Promise<boolean>) | undefined;

    const runtime = await createTenantDataBrokerRuntime({
      environment: validEnvironment,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        flush: vi.fn(),
      },
      factories: {
        createPool: () => pool,
        createCloudResource: () => cloud,
        createExecutor: () => ({ execute: vi.fn() }),
        createHandler: () => ({ handle: vi.fn() }),
        createServer: (options: { readiness(): Promise<boolean> }) => {
          readiness = () => options.readiness();
          return server;
        },
      } as never,
    });

    if (readiness === undefined) throw new Error('READINESS_NOT_CAPTURED');
    await expect(readiness()).resolves.toBe(false);
    await runtime.close();
  });

  it('cleans every allocated resource when composition fails', async () => {
    const pool = {
      query: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const cloud = {
      s3: {},
      secrets: {},
      close: vi.fn(),
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const createServer = vi.fn();

    await expect(
      createTenantDataBrokerRuntime({
        environment: validEnvironment,
        logger,
        factories: {
          createPool: () => pool,
          createCloudResource: () => cloud,
          createExecutor: () => ({ execute: vi.fn() }),
          createHandler: () => {
            throw new Error('HANDLER_COMPOSITION_FAILED');
          },
          createServer,
        } as never,
      }),
    ).rejects.toThrow('HANDLER_COMPOSITION_FAILED');

    expect(createServer).not.toHaveBeenCalled();
    expect(cloud.close).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(logger.flush).toHaveBeenCalledTimes(1);
  });

  it('preserves a listen failure while closing every runtime resource idempotently', async () => {
    const pool = {
      query: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const cloud = {
      s3: {},
      secrets: {},
      close: vi.fn(() => {
        throw new Error('CLOUD_CLOSE_FAILED');
      }),
    };
    const server = {
      listen: vi.fn().mockRejectedValue(new Error('LISTEN_FAILED')),
      close: vi.fn().mockRejectedValue(new Error('SERVER_CLOSE_FAILED')),
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    const runtime = await createTenantDataBrokerRuntime({
      environment: validEnvironment,
      logger,
      factories: {
        createPool: () => pool,
        createCloudResource: () => cloud,
        createExecutor: () => ({ execute: vi.fn() }),
        createHandler: () => ({ handle: vi.fn() }),
        createServer: () => server,
      } as never,
    });

    await expect(runtime.start()).rejects.toThrow('LISTEN_FAILED');
    const firstClose = runtime.close();
    const secondClose = runtime.close();
    expect(firstClose).toBe(secondClose);
    await expect(firstClose).rejects.toThrow('SERVER_CLOSE_FAILED');

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(cloud.close).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(logger.flush).toHaveBeenCalledTimes(1);
  });

  it('reduces broker log records to the structured logger allowlist', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    };
    let brokerWarn: ((entry: Readonly<Record<string, unknown>>) => void) | undefined;
    const runtime = await createTenantDataBrokerRuntime({
      environment: validEnvironment,
      logger,
      factories: {
        createPool: () => ({
          query: vi.fn(),
          end: vi.fn().mockResolvedValue(undefined),
        }),
        createCloudResource: () => ({
          s3: {},
          secrets: {},
          close: vi.fn(),
        }),
        createExecutor: () => ({ execute: vi.fn() }),
        createHandler: (options: {
          logger: { warn(entry: Readonly<Record<string, unknown>>): void };
        }) => {
          brokerWarn = (entry) => options.logger.warn(entry);
          return { handle: vi.fn() };
        },
        createServer: () => ({
          listen: vi.fn(),
          close: vi.fn().mockResolvedValue(undefined),
        }),
      } as never,
    });

    if (brokerWarn === undefined) throw new Error('BROKER_LOGGER_NOT_CAPTURED');
    brokerWarn({
      event: 'TENANT_DATA_BROKER_EFFECT_FAILURE',
      code: 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN',
      leaseToken: 'must-not-be-logged',
      databaseUrl: validEnvironment.TENANT_DATA_BROKER_DATABASE_URL,
      signingKey: validEnvironment.TENANT_DATA_BROKER_HMAC_KEY_RING,
    });

    expect(logger.warn).toHaveBeenCalledWith('TENANT_DATA_BROKER_EFFECT_FAILURE', {
      attributes: { errorCode: 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN' },
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('must-not-be-logged');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('postgresql://');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('hmac-key');
    await runtime.close();
  });
});
