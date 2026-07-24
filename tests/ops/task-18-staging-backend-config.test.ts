import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

// @ts-expect-error The staging backend helper is a native ESM JavaScript module.
import * as untypedBackendConfig from '../../scripts/infra/staging-backend-config.mjs';

const backendConfig = untypedBackendConfig as {
  canonicalizeStagingBackendConfig(input: { expectedBucket: string; raw: string }): string;
  stagingBackendConfigSha256(expectedBucket: string): string;
};

const expectedBucket = 'aeostudio-staging-opentofu-state-123456789012';
const canonical =
  `bucket       = "${expectedBucket}"\n` +
  'key          = "aeostudio/staging/opentofu.tfstate"\n' +
  'region       = "ap-southeast-1"\n' +
  'encrypt      = true\n' +
  'use_lockfile = true\n';

describe('Task 18 canonical staging backend boundary', () => {
  test('parses only the five reviewed settings and emits one canonical backend', () => {
    const raw =
      'use_lockfile=true\n' +
      'region = "ap-southeast-1"\n' +
      `bucket = "${expectedBucket}"\n` +
      'encrypt = true\n' +
      'key="aeostudio/staging/opentofu.tfstate"\n';

    expect(backendConfig.canonicalizeStagingBackendConfig({ expectedBucket, raw })).toBe(canonical);
    expect(backendConfig.stagingBackendConfigSha256(expectedBucket)).toBe(
      createHash('sha256').update(canonical).digest('hex'),
    );
  });

  test.each([
    ['wrong bucket', `bucket = "attacker-state"`],
    ['wrong key', 'key = "another/state.tfstate"'],
    ['wrong region', 'region = "us-east-1"'],
    ['unencrypted', 'encrypt = false'],
    ['unlocked', 'use_lockfile = false'],
    ['custom endpoint', 'endpoints = { s3 = "https://attacker.example" }'],
    ['legacy endpoint', 'endpoint = "https://attacker.example"'],
    ['proxy', 'http_proxy = "https://attacker.example"'],
    ['skip credentials validation', 'skip_credentials_validation = true'],
    ['inline credential', 'access_key = "not-allowed"'],
    ['assume role', 'assume_role = { role_arn = "arn:aws:iam::123456789012:role/x" }'],
    ['duplicate setting', `bucket = "${expectedBucket}"`],
  ])('rejects %s before any backend or OIDC use', (_name, replacement) => {
    const required = [
      `bucket = "${expectedBucket}"`,
      'key = "aeostudio/staging/opentofu.tfstate"',
      'region = "ap-southeast-1"',
      'encrypt = true',
      'use_lockfile = true',
    ];
    const raw =
      _name === 'duplicate setting'
        ? `${required.join('\n')}\n${replacement}\n`
        : `${required
            .map((line) => {
              const key = replacement.split('=', 1)[0]?.trim();
              return key !== undefined && line.startsWith(`${key} `) ? replacement : line;
            })
            .join('\n')}\n${
            [
              'custom endpoint',
              'legacy endpoint',
              'proxy',
              'skip credentials validation',
              'inline credential',
              'assume role',
            ].includes(_name)
              ? `${replacement}\n`
              : ''
          }`;

    expect(() => backendConfig.canonicalizeStagingBackendConfig({ expectedBucket, raw })).toThrow(
      'STAGING_BACKEND_CONFIG_INVALID',
    );
  });
});
