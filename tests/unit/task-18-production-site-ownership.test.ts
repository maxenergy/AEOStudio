import type { OidcClient } from '@aeostudio/application/auth';
import type { SiteOwnershipVerifier } from '@aeostudio/application/site-crawl';
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

describe('Task 18 production Site ownership composition', () => {
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

  test('injects the production ownership verifier into the Sites module runtime', async () => {
    const verifier: SiteOwnershipVerifier = {
      verify: () => Promise.resolve({ matched: false }),
    };
    const oidcClient: OidcClient = {
      createAuthorizationUrl: () => 'https://identity.example.test/authorize',
      exchangeCode: () => Promise.reject(new Error('not used')),
    };
    const runtime = await resolveApiRuntime(
      { oidcClient },
      {
        createSiteOwnershipVerifier: () => verifier,
      },
    );

    expect(runtime.options.siteOwnershipVerifier).toBe(verifier);
    await runtime.cleanup();
  });
});
