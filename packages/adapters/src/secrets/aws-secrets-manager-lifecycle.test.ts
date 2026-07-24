import { describe, expect, test, vi } from 'vitest';

import { AwsSecretsManagerLifecycleAdapter } from './aws-secrets-manager-lifecycle.js';

const TENANT_ID = '018f84b3-7eb8-7c75-9ca5-25278969d3f1';
const WORKSPACE_ID = '018f84b3-7eb8-7c75-9ca5-25278969d3f2';
const SECRET_ARN =
  'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:tenant-channel-AbCdEf';

describe('AWS Secrets Manager privacy lifecycle adapter', () => {
  test('verifies the tenant tag before requesting immediate force deletion', async () => {
    const api = {
      describeSecret: vi.fn().mockResolvedValue({
        ARN: SECRET_ARN,
        Tags: [
          { Key: 'TenantId', Value: TENANT_ID },
          { Key: 'WorkspaceId', Value: WORKSPACE_ID },
        ],
      }),
      deleteSecret: vi.fn().mockResolvedValue({ ARN: SECRET_ARN }),
      getSecretValue: vi.fn(),
    };
    const adapter = new AwsSecretsManagerLifecycleAdapter(api, {
      region: 'ap-southeast-1',
      accountId: '123456789012',
    });

    await adapter.requestForceDelete({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      secretReference: SECRET_ARN,
    });

    expect(api.describeSecret).toHaveBeenCalledWith({ SecretId: SECRET_ARN });
    expect(api.deleteSecret).toHaveBeenCalledWith({
      SecretId: SECRET_ARN,
      ForceDeleteWithoutRecovery: true,
    });
  });

  test('reports unreadable only when AWS confirms the exact secret no longer exists', async () => {
    const api = {
      describeSecret: vi.fn().mockResolvedValue({
        ARN: SECRET_ARN,
        Tags: [
          { Key: 'TenantId', Value: TENANT_ID },
          { Key: 'WorkspaceId', Value: WORKSPACE_ID },
        ],
      }),
      deleteSecret: vi.fn(),
      getSecretValue: vi
        .fn()
        .mockResolvedValueOnce({ SecretString: 'still-readable' })
        .mockRejectedValueOnce(
          Object.assign(new Error('not found'), {
            name: 'ResourceNotFoundException',
            $metadata: { httpStatusCode: 400 },
          }),
        ),
    };
    const adapter = new AwsSecretsManagerLifecycleAdapter(api, {
      region: 'ap-southeast-1',
      accountId: '123456789012',
    });

    await expect(
      adapter.verifyUnreadable({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        secretReference: SECRET_ARN,
      }),
    ).resolves.toBe(false);
    await expect(
      adapter.verifyUnreadable({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        secretReference: SECRET_ARN,
      }),
    ).resolves.toBe(true);
    expect(api.getSecretValue).toHaveBeenNthCalledWith(1, { SecretId: SECRET_ARN });
  });

  test('treats an already deleted scoped secret as an idempotent force-delete success', async () => {
    const notFound = Object.assign(new Error('not found'), {
      name: 'ResourceNotFoundException',
      $metadata: { httpStatusCode: 400 },
    });
    const api = {
      describeSecret: vi.fn().mockRejectedValue(notFound),
      deleteSecret: vi.fn(),
      getSecretValue: vi.fn(),
    };
    const adapter = new AwsSecretsManagerLifecycleAdapter(api, {
      region: 'ap-southeast-1',
      accountId: '123456789012',
    });

    await expect(
      adapter.requestForceDelete({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        secretReference: SECRET_ARN,
      }),
    ).resolves.toBeUndefined();
    expect(api.deleteSecret).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: 'wrong Workspace tag',
      tags: [
        { Key: 'TenantId', Value: TENANT_ID },
        { Key: 'WorkspaceId', Value: '018f84b3-7eb8-7c75-9ca5-25278969d3ff' },
      ],
    },
    { name: 'missing Workspace tag', tags: [{ Key: 'TenantId', Value: TENANT_ID }] },
    {
      name: 'duplicate Workspace tag',
      tags: [
        { Key: 'TenantId', Value: TENANT_ID },
        { Key: 'WorkspaceId', Value: WORKSPACE_ID },
        { Key: 'WorkspaceId', Value: WORKSPACE_ID },
      ],
    },
  ])('refuses force deletion for $name', async ({ tags }) => {
    const api = {
      describeSecret: vi.fn().mockResolvedValue({ ARN: SECRET_ARN, Tags: tags }),
      deleteSecret: vi.fn(),
      getSecretValue: vi.fn(),
    };
    const adapter = new AwsSecretsManagerLifecycleAdapter(api, {
      region: 'ap-southeast-1',
      accountId: '123456789012',
    });

    await expect(
      adapter.requestForceDelete({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        secretReference: SECRET_ARN,
      }),
    ).rejects.toThrow('SECRET_WORKSPACE_SCOPE_MISMATCH');
    expect(api.deleteSecret).not.toHaveBeenCalled();
  });
});
