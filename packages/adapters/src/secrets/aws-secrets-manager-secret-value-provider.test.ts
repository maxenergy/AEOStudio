import { describe, expect, test } from 'vitest';

import { AwsSecretsManagerSecretValueProvider } from './aws-secrets-manager-secret-value-provider.js';

describe('AWS Secrets Manager publication secret reader', () => {
  const reference =
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:tenant-publication-abc123';

  test('returns only a tagged in-scope secret value', async () => {
    const provider = new AwsSecretsManagerSecretValueProvider(
      {
        describeSecret: () =>
          Promise.resolve({
            ARN: reference,
            Tags: [
              { Key: 'TenantId', Value: '00000000-0000-7000-8000-000000000001' },
              { Key: 'WorkspaceId', Value: '00000000-0000-7000-8000-000000000002' },
            ],
          }),
        getSecretValue: () => Promise.resolve({ SecretString: 'provider-credential' }),
      },
      { region: 'ap-southeast-1', accountId: '123456789012' },
    );

    await expect(
      provider.getSecretValue(reference, {
        tenantId: '00000000-0000-7000-8000-000000000001',
        workspaceId: '00000000-0000-7000-8000-000000000002',
      }),
    ).resolves.toBe('provider-credential');
  });

  test('fails closed when either scope tag is missing', async () => {
    const provider = new AwsSecretsManagerSecretValueProvider(
      {
        describeSecret: () =>
          Promise.resolve({
            ARN: reference,
            Tags: [{ Key: 'TenantId', Value: '00000000-0000-7000-8000-000000000001' }],
          }),
        getSecretValue: () => Promise.resolve({ SecretString: 'must-not-be-returned' }),
      },
      { region: 'ap-southeast-1', accountId: '123456789012' },
    );

    await expect(
      provider.getSecretValue(reference, {
        tenantId: '00000000-0000-7000-8000-000000000001',
        workspaceId: '00000000-0000-7000-8000-000000000002',
      }),
    ).rejects.toThrow('SECRET_SCOPE_TAGS_REQUIRED');
  });

  test('rejects a tagged credential that belongs to another Tenant before reading its value', async () => {
    let secretRead = false;
    const provider = new AwsSecretsManagerSecretValueProvider(
      {
        describeSecret: () =>
          Promise.resolve({
            ARN: reference,
            Tags: [
              { Key: 'TenantId', Value: '00000000-0000-7000-8000-000000000099' },
              { Key: 'WorkspaceId', Value: '00000000-0000-7000-8000-000000000002' },
            ],
          }),
        getSecretValue: () => {
          secretRead = true;
          return Promise.resolve({ SecretString: 'cross-tenant-credential' });
        },
      },
      { region: 'ap-southeast-1', accountId: '123456789012' },
    );

    await expect(
      provider.getSecretValue(reference, {
        tenantId: '00000000-0000-7000-8000-000000000001',
        workspaceId: '00000000-0000-7000-8000-000000000002',
      }),
    ).rejects.toThrow('SECRET_TENANT_SCOPE_MISMATCH');
    expect(secretRead).toBe(false);
  });
});
