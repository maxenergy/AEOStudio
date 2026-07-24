import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();

const forbiddenDirectTenantDataFactories = [
  'createAwsS3PrivacyObjectStorage',
  'createAwsS3WorkloadObjectStorage',
  'createAwsSecretsManagerSecretValueProvider',
  'createAwsSecretsManagerLifecycleAdapter',
] as const;

describe('Task 18 application tenant data broker boundary', () => {
  test.each([
    ['API production composition', 'apps/api/src/runtime/resolve-runtime.ts'],
    ['Worker production composition', 'apps/worker/src/production-worker-composition.ts'],
  ])('%s cannot construct a direct S3 or Secrets Manager tenant-data adapter', async (_, path) => {
    const source = await readFile(join(root, path), 'utf8');

    for (const factory of forbiddenDirectTenantDataFactories) {
      expect(
        source,
        `${path} still references direct tenant-data factory ${factory}`,
      ).not.toContain(factory);
    }
    expect(source).not.toMatch(/@aws-sdk\/client-(?:s3|secrets-manager)/u);
    expect(source).toMatch(/TenantDataBroker|tenant-data-broker/u);
  });

  test('the shared Worker image selects the Broker process before normal Worker composition', async () => {
    const source = await readFile(join(root, 'apps/worker/src/production-main.ts'), 'utf8');
    const modeCheck = source.indexOf('AEOSTUDIO_WORKER_MODE');
    const brokerMode = source.indexOf('tenant-data-broker', modeCheck);
    const normalComposition = source.indexOf('production-worker-composition');

    expect(modeCheck).toBeGreaterThanOrEqual(0);
    expect(brokerMode).toBeGreaterThan(modeCheck);
    expect(normalComposition).toBeGreaterThan(brokerMode);
    expect(source).toMatch(/tenant-data-broker-(?:process|runtime)/u);
  });
});
