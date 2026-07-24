import {
  createAwsTenantDataBrokerCloudResource,
  createAwsTenantDataBrokerExecutor,
  createTenantDataBrokerNodeHttpServer,
  createTenantDataBrokerStreamingHttpTransport,
  parseTenantDataBrokerKeyRing,
  type AwsTenantDataBrokerCloudResource,
  type AwsTenantDataBrokerExecutor,
  type TenantDataBrokerHttpHandler,
  type TenantDataBrokerNodeHttpServer,
  type TenantDataBrokerNodeHttpServerOptions,
  type TenantDataBrokerSigningKeyRing,
  type TenantDataBrokerStreamingHttpTransportOptions,
} from '@aeostudio/adapters/tenant-data-broker';
import {
  createStructuredApplicationLogger,
  type StructuredApplicationLogger,
} from '@aeostudio/adapters/observability';
import { TenantDataBrokerAuthorizer } from '@aeostudio/application/tenant-data-access';
import {
  PostgresTenantDataBrokerStore,
  type TenantDataBrokerSqlClient,
} from '@aeostudio/db/tenant-data-broker';
import { Pool } from 'pg';

import { readRequiredDatabasePoolMax } from './production-worker-capacity.js';

const SINGAPORE_REGION = 'ap-southeast-1';
const MULTIPART_PART_BYTES = 5 * 1_024 * 1_024;
const REQUEST_DEADLINE_CAP_MS = 30_000;
const GRACEFUL_CLOSE_TIMEOUT_MS = 30_000;
const LISTEN_HOST = '0.0.0.0';

export interface TenantDataBrokerRuntimeEnvironment {
  [name: string]: string | undefined;
  NODE_ENV?: string;
  AEOSTUDIO_WORKER_MODE?: string;
  TENANT_DATA_BROKER_DATABASE_URL?: string;
  TENANT_DATA_BROKER_DATABASE_POOL_MAX?: string;
  TENANT_DATA_BROKER_HMAC_KEY_RING?: string;
  AWS_REGION?: string;
  AWS_ACCOUNT_ID?: string;
  ARTIFACT_BUCKET?: string;
  AUDIT_EVIDENCE_BUCKET?: string;
  S3_KMS_KEY_ARN?: string;
  TENANT_DATA_BROKER_AUDIENCE?: string;
  PORT?: string;
}

export interface TenantDataBrokerRuntimePool extends TenantDataBrokerSqlClient {
  end(): Promise<void>;
}

export interface TenantDataBrokerRuntimeFactories {
  createPool(connectionString: string, max: number): TenantDataBrokerRuntimePool;
  createCloudResource(input: { region: string }): AwsTenantDataBrokerCloudResource;
  createExecutor(
    input: Parameters<typeof createAwsTenantDataBrokerExecutor>[0],
  ): AwsTenantDataBrokerExecutor;
  createHandler(input: TenantDataBrokerStreamingHttpTransportOptions): TenantDataBrokerHttpHandler;
  createServer(input: TenantDataBrokerNodeHttpServerOptions): TenantDataBrokerNodeHttpServer;
}

export interface TenantDataBrokerRuntime {
  start(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export async function createTenantDataBrokerRuntime(input: {
  environment: TenantDataBrokerRuntimeEnvironment;
  clock?: { now(): Date };
  logger?: StructuredApplicationLogger;
  factories?: Partial<TenantDataBrokerRuntimeFactories>;
}): Promise<TenantDataBrokerRuntime> {
  const clock = input.clock ?? { now: () => new Date() };
  const contract = readRuntimeContract(input.environment, clock);
  const factories = resolveFactories(input.factories);
  const logger =
    input.logger ??
    createStructuredApplicationLogger({
      serviceName: 'aeostudio-tenant-data-broker',
    });
  let pool: TenantDataBrokerRuntimePool | undefined;
  let cloud: AwsTenantDataBrokerCloudResource | undefined;
  let server: TenantDataBrokerNodeHttpServer | undefined;
  try {
    pool = factories.createPool(contract.databaseUrl, contract.databasePoolMax);
    const store = new PostgresTenantDataBrokerStore(pool);
    const authorizer = new TenantDataBrokerAuthorizer(store, clock);
    cloud = factories.createCloudResource({ region: SINGAPORE_REGION });
    const executor = factories.createExecutor({
      artifactBucket: contract.artifactBucket,
      auditEvidenceBucket: contract.auditEvidenceBucket,
      expectedBucketOwner: contract.accountId,
      kmsKeyArn: contract.kmsKeyArn,
      multipartPartBytes: MULTIPART_PART_BYTES,
      s3: cloud.s3,
      secrets: cloud.secrets,
    });
    const handler = factories.createHandler({
      audience: contract.audience,
      signingKeys: contract.signingKeys,
      expectedBucketOwner: contract.accountId,
      authorizer,
      attempts: store,
      effectResolver: store,
      executor,
      clock,
      logger: brokerLogger(logger),
    });
    server = factories.createServer({
      audience: contract.audience,
      handler,
      readiness: () => readiness(pool!),
      clock,
      requestDeadlineCapMs: REQUEST_DEADLINE_CAP_MS,
      gracefulCloseTimeoutMs: GRACEFUL_CLOSE_TIMEOUT_MS,
    });

    return createManagedRuntime({
      port: contract.port,
      logger,
      pool,
      cloud,
      server,
    });
  } catch (error: unknown) {
    await closeAllocatedResources({ server, cloud, pool, logger }, false);
    throw error;
  }
}

export async function startTenantDataBrokerRuntime(
  input: Parameters<typeof createTenantDataBrokerRuntime>[0],
): Promise<TenantDataBrokerRuntime> {
  const runtime = await createTenantDataBrokerRuntime(input);
  await runtime.start();
  return runtime;
}

function readRuntimeContract(
  environment: TenantDataBrokerRuntimeEnvironment,
  clock: { now(): Date },
): {
  databaseUrl: string;
  databasePoolMax: number;
  signingKeys: TenantDataBrokerSigningKeyRing;
  accountId: string;
  artifactBucket: string;
  auditEvidenceBucket: string;
  kmsKeyArn: string;
  audience: string;
  port: number;
} {
  const databaseUrl = environment.TENANT_DATA_BROKER_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('TENANT_DATA_BROKER_DATABASE_URL_REQUIRED');
  }
  if (!validPostgresUrl(databaseUrl)) {
    throw new Error('TENANT_DATA_BROKER_DATABASE_URL_INVALID');
  }
  const databasePoolMax = readRequiredDatabasePoolMax(
    environment.TENANT_DATA_BROKER_DATABASE_POOL_MAX,
    'TENANT_DATA_BROKER_DATABASE_POOL_MAX',
  );
  if (environment.NODE_ENV !== 'production') {
    throw new Error('TENANT_DATA_BROKER_PRODUCTION_REQUIRED');
  }
  if (environment.AEOSTUDIO_WORKER_MODE !== 'tenant-data-broker') {
    throw new Error('TENANT_DATA_BROKER_MODE_REQUIRED');
  }
  const signingKeys = parseTenantDataBrokerKeyRing(
    requireValue(
      environment.TENANT_DATA_BROKER_HMAC_KEY_RING,
      'TENANT_DATA_BROKER_SIGNING_KEYS_INVALID',
    ),
    clock,
  );
  if (environment.AWS_REGION !== SINGAPORE_REGION) {
    throw new Error('AWS_SINGAPORE_REGION_REQUIRED');
  }
  const accountId = requireValue(
    environment.AWS_ACCOUNT_ID,
    'TENANT_DATA_BROKER_AWS_ACCOUNT_ID_INVALID',
  );
  if (!/^[0-9]{12}$/u.test(accountId)) {
    throw new Error('TENANT_DATA_BROKER_AWS_ACCOUNT_ID_INVALID');
  }
  const artifactBucket = requireValue(
    environment.ARTIFACT_BUCKET,
    'TENANT_DATA_BROKER_ARTIFACT_BUCKET_INVALID',
  );
  if (!validBucket(artifactBucket)) {
    throw new Error('TENANT_DATA_BROKER_ARTIFACT_BUCKET_INVALID');
  }
  const auditEvidenceBucket = requireValue(
    environment.AUDIT_EVIDENCE_BUCKET,
    'TENANT_DATA_BROKER_AUDIT_EVIDENCE_BUCKET_INVALID',
  );
  if (!validBucket(auditEvidenceBucket)) {
    throw new Error('TENANT_DATA_BROKER_AUDIT_EVIDENCE_BUCKET_INVALID');
  }
  if (artifactBucket === auditEvidenceBucket) {
    throw new Error('TENANT_DATA_BROKER_BUCKETS_MUST_BE_DISTINCT');
  }
  const kmsKeyArn = requireValue(environment.S3_KMS_KEY_ARN, 'TENANT_DATA_BROKER_KMS_KEY_INVALID');
  if (
    !new RegExp(
      `^arn:aws:kms:ap-southeast-1:${accountId}:key/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
      'iu',
    ).test(kmsKeyArn)
  ) {
    throw new Error('TENANT_DATA_BROKER_KMS_KEY_INVALID');
  }
  const audience = requireValue(
    environment.TENANT_DATA_BROKER_AUDIENCE,
    'TENANT_DATA_BROKER_AUDIENCE_INVALID',
  );
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::443)?$/u.test(
      audience,
    )
  ) {
    throw new Error('TENANT_DATA_BROKER_AUDIENCE_INVALID');
  }
  const rawPort = requireValue(environment.PORT, 'TENANT_DATA_BROKER_PORT_INVALID');
  if (
    !/^(?:[1-9]|[1-9][0-9]{1,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/u.test(
      rawPort,
    )
  ) {
    throw new Error('TENANT_DATA_BROKER_PORT_INVALID');
  }
  return {
    databaseUrl,
    databasePoolMax,
    signingKeys,
    accountId,
    artifactBucket,
    auditEvidenceBucket,
    kmsKeyArn,
    audience,
    port: Number(rawPort),
  };
}

function validPostgresUrl(value: string): boolean {
  if (value.trim() !== value || value.length > 8_192) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
      parsed.username.length > 0 &&
      parsed.password.length > 0 &&
      parsed.hostname.length > 0 &&
      parsed.pathname.length > 1 &&
      parsed.hash.length === 0
    );
  } catch {
    return false;
  }
}

function validBucket(value: string): boolean {
  return (
    /^(?=.{3,63}$)(?![0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/u.test(
      value,
    ) &&
    !value.includes('..') &&
    !value.includes('.-') &&
    !value.includes('-.')
  );
}

function requireValue(value: string | undefined, code: string): string {
  if (value === undefined || value.length === 0) throw new Error(code);
  return value;
}

function resolveFactories(
  overrides: Partial<TenantDataBrokerRuntimeFactories> | undefined,
): TenantDataBrokerRuntimeFactories {
  return {
    createPool:
      overrides?.createPool ?? ((connectionString, max) => new Pool({ connectionString, max })),
    createCloudResource: overrides?.createCloudResource ?? createAwsTenantDataBrokerCloudResource,
    createExecutor: overrides?.createExecutor ?? createAwsTenantDataBrokerExecutor,
    createHandler:
      overrides?.createHandler ??
      ((options) => createTenantDataBrokerStreamingHttpTransport(options)),
    createServer: overrides?.createServer ?? createTenantDataBrokerNodeHttpServer,
  };
}

function createManagedRuntime(input: {
  port: number;
  logger: StructuredApplicationLogger;
  pool: TenantDataBrokerRuntimePool;
  cloud: AwsTenantDataBrokerCloudResource;
  server: TenantDataBrokerNodeHttpServer;
}): TenantDataBrokerRuntime {
  let startPromise: Promise<{ host: string; port: number }> | null = null;
  let closePromise: Promise<void> | null = null;
  let closing = false;
  const runtime: TenantDataBrokerRuntime = {
    start() {
      if (startPromise !== null) return startPromise;
      if (closing) {
        return Promise.reject(new Error('TENANT_DATA_BROKER_RUNTIME_CLOSED'));
      }
      startPromise = input.server
        .listen({ host: LISTEN_HOST, port: input.port })
        .catch(async (error: unknown) => {
          await runtime.close().catch(() => undefined);
          throw error;
        });
      return startPromise;
    },
    close() {
      if (closePromise !== null) return closePromise;
      closing = true;
      closePromise = closeAllocatedResources(
        {
          server: input.server,
          cloud: input.cloud,
          pool: input.pool,
          logger: input.logger,
        },
        true,
      );
      return closePromise;
    },
  };
  return runtime;
}

async function readiness(pool: TenantDataBrokerRuntimePool): Promise<boolean> {
  try {
    const result = await pool.query('SELECT 1 AS ready', []);
    const row = result.rows[0];
    return (
      result.rows.length === 1 &&
      row !== null &&
      typeof row === 'object' &&
      !Array.isArray(row) &&
      Object.keys(row).length === 1 &&
      Object.prototype.hasOwnProperty.call(row, 'ready') &&
      (row as Record<string, unknown>).ready === 1
    );
  } catch {
    return false;
  }
}

async function closeAllocatedResources(
  input: {
    server?: TenantDataBrokerNodeHttpServer | undefined;
    cloud?: AwsTenantDataBrokerCloudResource | undefined;
    pool?: TenantDataBrokerRuntimePool | undefined;
    logger: StructuredApplicationLogger;
  },
  throwOnFailure: boolean,
): Promise<void> {
  const errors: unknown[] = [];
  await captureClose(errors, () => input.server?.close());
  await captureClose(errors, () => input.cloud?.close());
  await captureClose(errors, () => input.pool?.end());
  await captureClose(errors, () => input.logger.flush());
  if (throwOnFailure && errors.length > 0) throw errors[0];
}

async function captureClose(errors: unknown[], effect: () => unknown): Promise<void> {
  try {
    await effect();
  } catch (error: unknown) {
    errors.push(error);
  }
}

function brokerLogger(logger: StructuredApplicationLogger): {
  info(entry: Readonly<Record<string, unknown>>): void;
  warn(entry: Readonly<Record<string, unknown>>): void;
} {
  return {
    info: (entry) => writeBrokerLog(logger, 'info', entry),
    warn: (entry) => writeBrokerLog(logger, 'warn', entry),
  };
}

function writeBrokerLog(
  logger: StructuredApplicationLogger,
  level: 'info' | 'warn',
  entry: Readonly<Record<string, unknown>>,
): void {
  const event =
    typeof entry.event === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(entry.event)
      ? entry.event
      : 'TENANT_DATA_BROKER_LOG_REJECTED';
  const errorCode =
    typeof entry.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(entry.code)
      ? entry.code
      : undefined;
  logger[level](
    event,
    errorCode === undefined
      ? undefined
      : {
          attributes: { errorCode },
        },
  );
}
