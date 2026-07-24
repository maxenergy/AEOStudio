import { FakeOidcClient } from '@aeostudio/adapters';
import { InMemoryMeasurementRawEvidenceStore } from '@aeostudio/application/measurement';
import type { MeasurementApprovedSource } from '@aeostudio/application/measurement';
import { AesGcmSessionCipher, PostgresAuthStore } from '@aeostudio/db';
import { Pool } from 'pg';
import { afterEach, describe, expect, test } from 'vitest';

import { resolveApiRuntime } from '../../apps/api/src/runtime/resolve-runtime.js';
import { InMemoryManualMeasurementImportStore } from '../../apps/api/src/measurement/in-memory-manual-measurement-import-store.js';
import { InMemoryMeasurementStore } from '../../apps/api/src/measurement/in-memory-measurement-store.js';

const ORIGINAL_AUTH_MODE = process.env.AEOSTUDIO_AUTH_MODE;
const ORIGINAL_MEASUREMENT_MODE = process.env.AEOSTUDIO_MEASUREMENT_PROVIDER_MODE;
const ORIGINAL_ALLOW_FAKE_RUNTIME = process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_API_DATABASE_POOL_MAX = process.env.API_DATABASE_POOL_MAX;
const ORIGINAL_SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY;
const ORIGINAL_DELETION_RECEIPT_SIGNING_KEY = process.env.DELETION_RECEIPT_SIGNING_KEY;
const ORIGINAL_AWS_REGION = process.env.AWS_REGION;
const ORIGINAL_AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID;
const ORIGINAL_ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET;
const ORIGINAL_AUDIT_EVIDENCE_BUCKET = process.env.AUDIT_EVIDENCE_BUCKET;
const ORIGINAL_S3_KMS_KEY_ARN = process.env.S3_KMS_KEY_ARN;
const ORIGINAL_TENANT_DATA_BROKER_ENDPOINT = process.env.TENANT_DATA_BROKER_ENDPOINT;
const ORIGINAL_TENANT_DATA_BROKER_AUDIENCE = process.env.TENANT_DATA_BROKER_AUDIENCE;
const ORIGINAL_TENANT_DATA_BROKER_HMAC_KEY_RING = process.env.TENANT_DATA_BROKER_HMAC_KEY_RING;

afterEach(() => {
  restoreEnvironment('AEOSTUDIO_AUTH_MODE', ORIGINAL_AUTH_MODE);
  restoreEnvironment('AEOSTUDIO_MEASUREMENT_PROVIDER_MODE', ORIGINAL_MEASUREMENT_MODE);
  restoreEnvironment('AEOSTUDIO_ALLOW_FAKE_RUNTIME', ORIGINAL_ALLOW_FAKE_RUNTIME);
  restoreEnvironment('NODE_ENV', ORIGINAL_NODE_ENV);
  restoreEnvironment('DATABASE_URL', ORIGINAL_DATABASE_URL);
  restoreEnvironment('API_DATABASE_POOL_MAX', ORIGINAL_API_DATABASE_POOL_MAX);
  restoreEnvironment('SESSION_ENCRYPTION_KEY', ORIGINAL_SESSION_ENCRYPTION_KEY);
  restoreEnvironment('DELETION_RECEIPT_SIGNING_KEY', ORIGINAL_DELETION_RECEIPT_SIGNING_KEY);
  restoreEnvironment('AWS_REGION', ORIGINAL_AWS_REGION);
  restoreEnvironment('AWS_ACCOUNT_ID', ORIGINAL_AWS_ACCOUNT_ID);
  restoreEnvironment('ARTIFACT_BUCKET', ORIGINAL_ARTIFACT_BUCKET);
  restoreEnvironment('AUDIT_EVIDENCE_BUCKET', ORIGINAL_AUDIT_EVIDENCE_BUCKET);
  restoreEnvironment('S3_KMS_KEY_ARN', ORIGINAL_S3_KMS_KEY_ARN);
  restoreEnvironment('TENANT_DATA_BROKER_ENDPOINT', ORIGINAL_TENANT_DATA_BROKER_ENDPOINT);
  restoreEnvironment('TENANT_DATA_BROKER_AUDIENCE', ORIGINAL_TENANT_DATA_BROKER_AUDIENCE);
  restoreEnvironment('TENANT_DATA_BROKER_HMAC_KEY_RING', ORIGINAL_TENANT_DATA_BROKER_HMAC_KEY_RING);
});

describe.sequential('Task 15 production Measurement runtime', () => {
  test('installs PostgreSQL Measurement metadata and durable raw-evidence stores', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AEOSTUDIO_AUTH_MODE;
    delete process.env.AEOSTUDIO_MEASUREMENT_PROVIDER_MODE;
    process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/runtime-wiring-only';
    process.env.API_DATABASE_POOL_MAX = '10';
    process.env.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 15).toString('base64url');
    process.env.DELETION_RECEIPT_SIGNING_KEY = Buffer.alloc(32, 17).toString('base64url');
    configureProductionTenantDataBrokerEnvironment();

    const runtime = await resolveApiRuntime({
      oidcClient: new FakeOidcClient('http://127.0.0.1/unused-fake-oidc'),
    });
    expect(runtime.options.measurementStore?.constructor.name).toBe('PostgresMeasurementStore');
    expect(runtime.options.measurementRawEvidenceStore?.constructor.name).toBe(
      'PostgresMeasurementRawEvidenceStore',
    );
    expect(runtime.options.manualMeasurementImportStore?.constructor.name).toBe(
      'PostgresManualMeasurementImportStore',
    );
    expect(
      runtime.options.measurementSurfaceAdapters?.resolve(
        'openai',
        'chatgpt-search',
        'manual-import-v1',
      )?.adapterKey,
    ).toBe('reviewed-manual-import');
    await runtime.cleanup();
  });

  test('fails closed when production skips default persistence without complete Measurement stores', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AEOSTUDIO_AUTH_MODE;
    delete process.env.AEOSTUDIO_MEASUREMENT_PROVIDER_MODE;
    delete process.env.DATABASE_URL;
    delete process.env.SESSION_ENCRYPTION_KEY;
    process.env.DELETION_RECEIPT_SIGNING_KEY = Buffer.alloc(32, 17).toString('base64url');
    const externalPool = new Pool({ connectionString: 'postgresql://127.0.0.1:1/unused' });
    try {
      await expect(
        resolveApiRuntime({
          store: new PostgresAuthStore(externalPool, new AesGcmSessionCipher(Buffer.alloc(32, 15))),
          oidcClient: new FakeOidcClient('http://127.0.0.1/unused-fake-oidc'),
        }),
      ).rejects.toThrow('MEASUREMENT_RUNTIME_NOT_CONFIGURED');
    } finally {
      await externalPool.end();
    }
  });

  test('rejects every in-memory Manual Import persistence path in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AEOSTUDIO_AUTH_MODE;
    delete process.env.AEOSTUDIO_MEASUREMENT_PROVIDER_MODE;
    delete process.env.DATABASE_URL;
    delete process.env.SESSION_ENCRYPTION_KEY;
    process.env.DELETION_RECEIPT_SIGNING_KEY = Buffer.alloc(32, 17).toString('base64url');
    const externalPool = new Pool({ connectionString: 'postgresql://127.0.0.1:1/unused' });
    try {
      await expect(
        resolveApiRuntime({
          store: new PostgresAuthStore(externalPool, new AesGcmSessionCipher(Buffer.alloc(32, 15))),
          oidcClient: new FakeOidcClient('http://127.0.0.1/unused-fake-oidc'),
          measurementStore: new InMemoryMeasurementStore(),
          measurementRawEvidenceStore: new InMemoryMeasurementRawEvidenceStore(),
          manualMeasurementImportStore: new InMemoryManualMeasurementImportStore(),
        }),
      ).rejects.toThrow('MEASUREMENT_RUNTIME_NOT_CONFIGURED');
    } finally {
      await externalPool.end();
    }
  });
});

describe('Task 16 fake Measurement idempotency parity', () => {
  test('reuses an idempotency key only for the same exact approved source and run kind', async () => {
    const store = new InMemoryMeasurementStore();
    const context = {
      tenantId: id(1),
      workspaceId: id(2),
      actorUserId: id(3),
      membershipId: id(4),
      role: 'OWNER' as const,
    };
    const approvedSource = measurementSource();
    const base = {
      context,
      measurementRunId: id(5),
      approvedSource,
      kind: 'BASELINE' as const,
      idempotencyKey: 'exact-measurement-request',
      createdAt: new Date('2026-07-22T08:00:00.000Z'),
      auditEventId: id(6),
    };

    const first = await store.prepareRun(base);
    expect(first?.id).toBe(base.measurementRunId);
    await expect(
      store.prepareRun({ ...base, measurementRunId: id(7), auditEventId: id(8) }),
    ).resolves.toMatchObject({ id: base.measurementRunId });

    const conflicts: Array<{
      name: string;
      kind?: 'BASELINE' | 'REMEASUREMENT';
      source: MeasurementApprovedSource;
    }> = [
      {
        name: 'prompt set',
        source: { ...approvedSource, promptSetId: id(20) },
      },
      {
        name: 'prompt revision',
        source: { ...approvedSource, promptRevisionId: id(21) },
      },
      {
        name: 'prompt hash',
        source: { ...approvedSource, promptContentHash: 'b'.repeat(64) },
      },
      {
        name: 'scenario',
        source: {
          ...approvedSource,
          scenarioSnapshot: { ...approvedSource.scenarioSnapshot, id: id(22) },
        },
      },
      {
        name: 'scenario hash',
        source: { ...approvedSource, scenarioContentHash: 'c'.repeat(64) },
      },
      {
        name: 'manual import',
        source: {
          ...approvedSource,
          scenarioSnapshot: {
            ...approvedSource.scenarioSnapshot,
            manualImport: { id: id(23), contentHash: 'd'.repeat(64) },
          },
        },
      },
      {
        name: 'kind',
        kind: 'REMEASUREMENT',
        source: approvedSource,
      },
    ];
    for (const conflict of conflicts) {
      await expect(
        store.prepareRun({
          ...base,
          measurementRunId: id(30),
          auditEventId: id(31),
          approvedSource: conflict.source,
          kind: conflict.kind ?? base.kind,
        }),
        `expected ${conflict.name} mismatch to fail closed`,
      ).resolves.toBeNull();
    }
  });
});

function measurementSource(): MeasurementApprovedSource {
  return {
    promptSetId: id(10),
    promptRevisionId: id(11),
    promptContentHash: '1'.repeat(64),
    scenarioContentHash: '2'.repeat(64),
    prompts: [{ id: id(12), ordinal: 1, text: 'What evidence supports this offering?' }],
    scenarioSnapshot: {
      id: id(13),
      version: 1,
      contentHash: '2'.repeat(64),
      promptRevisionId: id(11),
      providerKey: 'fixture-provider',
      surfaceKey: 'consumer-answer-sandbox',
      model: 'fixture-model',
      modelVersion: '2026-07',
      account: 'fixture-account',
      acquisitionClass: 'MODEL_API_DIAGNOSTIC',
      acquisitionMethod: 'FAKE_RUNTIME',
      registryStatus: 'AVAILABLE',
      manualImport: null,
      freshSession: true,
      searchEnabled: true,
      parameters: {},
      repetitions: 3,
      scopes: [{ market: 'SG', locale: 'en-SG', region: 'Singapore' }],
    },
    adapterVersion: 'fixture-v1',
    expectedPromptRunCount: 3,
  };
}

function id(suffix: number): string {
  return `00000000-0000-7000-8000-${String(suffix).padStart(12, '0')}`;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configureProductionTenantDataBrokerEnvironment(): void {
  process.env.AWS_REGION = 'ap-southeast-1';
  process.env.AWS_ACCOUNT_ID = '123456789012';
  process.env.ARTIFACT_BUCKET = 'aeostudio-test-artifacts';
  process.env.AUDIT_EVIDENCE_BUCKET = 'aeostudio-test-audit-evidence';
  process.env.S3_KMS_KEY_ARN =
    'arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-4000-8000-000000000018';
  process.env.TENANT_DATA_BROKER_ENDPOINT =
    'https://broker.example.internal/internal/v1/tenant-data';
  process.env.TENANT_DATA_BROKER_AUDIENCE = 'broker.example.internal';
  process.env.TENANT_DATA_BROKER_HMAC_KEY_RING = JSON.stringify({
    schemaVersion: 'aeostudio.tenant-data-broker-key-ring.v1',
    current: {
      id: 'current-2026-07',
      value: Buffer.alloc(32, 41).toString('base64url'),
    },
  });
}
