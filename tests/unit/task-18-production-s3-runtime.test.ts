import type {
  TenantDataBrokerClientGateway,
  TenantDataBrokerClientGatewayOptions,
} from '@aeostudio/adapters/tenant-data-broker';
import type { OidcClient } from '@aeostudio/application/auth';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { resolveApiRuntime } from '../../apps/api/src/runtime/resolve-runtime.js';

const ENVIRONMENT_KEYS = [
  'NODE_ENV',
  'DATABASE_URL',
  'API_DATABASE_POOL_MAX',
  'SESSION_ENCRYPTION_KEY',
  'DELETION_RECEIPT_SIGNING_KEY',
  'AWS_ACCOUNT_ID',
  'ARTIFACT_BUCKET',
  'AUDIT_EVIDENCE_BUCKET',
  'TENANT_DATA_BROKER_ENDPOINT',
  'TENANT_DATA_BROKER_AUDIENCE',
  'TENANT_DATA_BROKER_HMAC_KEY_RING',
  'AEOSTUDIO_AUTH_MODE',
  'AEOSTUDIO_ALLOW_FAKE_RUNTIME',
] as const;

const originalEnvironment = new Map<string, string | undefined>();

describe('Task 18 production API tenant data broker composition', () => {
  beforeEach(() => {
    for (const key of ENVIRONMENT_KEYS) originalEnvironment.set(key, process.env[key]);
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://runtime:secret@database.example.test/aeostudio';
    process.env.API_DATABASE_POOL_MAX = '5';
    process.env.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64url');
    process.env.DELETION_RECEIPT_SIGNING_KEY = Buffer.alloc(32, 23).toString('base64url');
    process.env.AWS_ACCOUNT_ID = '123456789012';
    process.env.ARTIFACT_BUCKET = 'aeostudio-staging-artifacts';
    process.env.AUDIT_EVIDENCE_BUCKET = 'aeostudio-staging-audit-evidence';
    process.env.TENANT_DATA_BROKER_ENDPOINT =
      'https://tenant-data-broker.example.test/internal/v1/tenant-data';
    process.env.TENANT_DATA_BROKER_AUDIENCE = 'tenant-data-broker.example.test';
    process.env.TENANT_DATA_BROKER_HMAC_KEY_RING = JSON.stringify({
      schemaVersion: 'aeostudio.tenant-data-broker-key-ring.v1',
      current: {
        id: 'production-current',
        value: 'production-tenant-data-broker-signing-key-at-least-32-bytes',
      },
    });
    delete process.env.AEOSTUDIO_AUTH_MODE;
    delete process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME;
  });

  afterEach(() => {
    for (const key of ENVIRONMENT_KEYS) {
      const value = originalEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnvironment.clear();
  });

  test('uses one capability gateway for all production object writes and explicit reads', async () => {
    const gateway = Object.freeze({}) as unknown as TenantDataBrokerClientGateway;
    let captured: TenantDataBrokerClientGatewayOptions | undefined;
    const oidcClient: OidcClient = {
      createAuthorizationUrl: () => 'https://identity.example.test/authorize',
      exchangeCode: () => Promise.reject(new Error('not used')),
    };
    const runtime = await resolveApiRuntime(
      { oidcClient },
      {
        createTenantDataBrokerClientGateway(options) {
          captured = options;
          return gateway;
        },
      },
    );

    expect(captured?.issuer.constructor.name).toBe('PostgresTenantDataCapabilityIssuer');
    expect(runtime.components.databasePool?.options.max).toBe(5);
    expect(captured?.client.constructor.name).toBe('TenantDataBrokerHttpClient');
    expect(captured).toMatchObject({
      buckets: {
        workload: 'aeostudio-staging-artifacts',
        tenantExports: 'aeostudio-staging-artifacts',
        auditEvidence: 'aeostudio-staging-audit-evidence',
      },
      expectedBucketOwner: '123456789012',
      requestTimeoutMs: 5_000,
    });
    expect(runtime.options.artifactPayloadStore?.constructor.name).toBe(
      'DurableWorkloadObjectStorage',
    );
    expect(runtime.options.artifactPayloadReader).toBe(gateway);
    expect(runtime.options.channelPackagePayloadReader).toBe(gateway);
    expect(runtime.options.privacyAuditStore?.constructor.name).toBe('PostgresPrivacyAuditStore');
    await runtime.cleanup();
  });

  test('installs the four owned publication adapters while leaving unowned channels export-only', async () => {
    const gateway = Object.freeze({}) as unknown as TenantDataBrokerClientGateway;
    const oidcClient: OidcClient = {
      createAuthorizationUrl: () => 'https://identity.example.test/authorize',
      exchangeCode: () => Promise.reject(new Error('not used')),
    };
    const runtime = await resolveApiRuntime(
      { oidcClient },
      {
        createTenantDataBrokerClientGateway() {
          return gateway;
        },
      },
    );

    expect(
      [
        ['git-pull-request', '1.0.0'],
        ['wordpress-woocommerce-draft', '1.0.0'],
        ['shopify-draft', '1.0.0'],
        ['signed-webhook', '1.0.0'],
      ].map(([adapterKey, adapterVersion]) =>
        runtime.options.runtimeChannelAdapters?.resolve(adapterKey, adapterVersion)?.describe(),
      ),
    ).toEqual([
      expect.objectContaining({ adapterKey: 'git-pull-request', adapterVersion: '1.0.0' }),
      expect.objectContaining({
        adapterKey: 'wordpress-woocommerce-draft',
        adapterVersion: '1.0.0',
      }),
      expect.objectContaining({ adapterKey: 'shopify-draft', adapterVersion: '1.0.0' }),
      expect.objectContaining({ adapterKey: 'signed-webhook', adapterVersion: '1.0.0' }),
    ]);
    expect(runtime.options.runtimeChannelAdapters?.resolve('social-directory', '1.0.0')).toBeNull();
    expect(runtime.options.signedWebhookEndpointVerificationStore?.constructor.name).toBe(
      'PostgresSignedWebhookEndpointVerificationStore',
    );
    expect(runtime.options.signedWebhookEndpointOwnershipVerifier?.constructor.name).toBe(
      'HttpsSignedWebhookEndpointOwnershipVerifier',
    );
    await runtime.cleanup();
  });

  test('rejects a Broker endpoint whose exact host differs from the configured audience', async () => {
    process.env.TENANT_DATA_BROKER_AUDIENCE = 'approved-broker.example.test';
    const oidcClient: OidcClient = {
      createAuthorizationUrl: () => 'https://identity.example.test/authorize',
      exchangeCode: () => Promise.reject(new Error('not used')),
    };

    await expect(
      resolveApiRuntime(
        { oidcClient },
        {
          createTenantDataBrokerClientGateway() {
            throw new Error('UNAPPROVED_GATEWAY_FACTORY_CALLED');
          },
        },
      ),
    ).rejects.toThrow('TENANT_DATA_BROKER_ENDPOINT_AUDIENCE_MISMATCH');
  });
});
