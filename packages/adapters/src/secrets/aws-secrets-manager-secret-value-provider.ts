import type { SecretValueProvider } from '@aeostudio/application/channels-publishing';

export interface AwsSecretsManagerValueApi {
  describeSecret(input: { SecretId: string }): Promise<{
    ARN?: string | undefined;
    Tags?: Array<{ Key?: string | undefined; Value?: string | undefined }> | undefined;
  }>;
  getSecretValue(input: { SecretId: string }): Promise<{
    SecretString?: string | undefined;
    SecretBinary?: Uint8Array | undefined;
  }>;
}

export interface AwsSecretsManagerValueScope {
  region: string;
  accountId: string;
}

/** Read-only publication credential boundary; IAM and runtime validation both fail closed. */
export class AwsSecretsManagerSecretValueProvider implements SecretValueProvider {
  constructor(
    private readonly api: AwsSecretsManagerValueApi,
    private readonly scope: AwsSecretsManagerValueScope,
  ) {
    if (scope.region !== 'ap-southeast-1') throw new Error('AWS_SINGAPORE_REGION_REQUIRED');
    if (!/^\d{12}$/u.test(scope.accountId)) throw new Error('INVALID_AWS_ACCOUNT_ID');
  }

  async getSecretValue(
    secretReference: string,
    expectedScope?: { tenantId: string; workspaceId: string },
  ): Promise<string> {
    if (expectedScope === undefined) throw new Error('SECRET_EXPECTED_SCOPE_REQUIRED');
    const expectedTenantId = readUuid(expectedScope.tenantId, 'TENANT');
    const expectedWorkspaceId = readUuid(expectedScope.workspaceId, 'WORKSPACE');
    const reference = this.readReference(secretReference);
    const metadata = await this.api.describeSecret({ SecretId: reference });
    if (metadata.ARN !== reference) throw new Error('SECRET_REFERENCE_SCOPE_MISMATCH');
    const tenantId = readSingleUuidTag(metadata.Tags, 'TenantId');
    const workspaceId = readSingleUuidTag(metadata.Tags, 'WorkspaceId');
    if (tenantId === null || workspaceId === null) throw new Error('SECRET_SCOPE_TAGS_REQUIRED');
    if (tenantId !== expectedTenantId) throw new Error('SECRET_TENANT_SCOPE_MISMATCH');
    if (workspaceId !== expectedWorkspaceId) throw new Error('SECRET_WORKSPACE_SCOPE_MISMATCH');
    const value = await this.api.getSecretValue({ SecretId: reference });
    const decoded =
      value.SecretString ??
      (value.SecretBinary === undefined
        ? undefined
        : new TextDecoder('utf-8', { fatal: true }).decode(value.SecretBinary));
    if (
      decoded === undefined ||
      decoded.length < 1 ||
      Buffer.byteLength(decoded, 'utf8') > 65_536
    ) {
      throw new Error('SECRET_VALUE_INVALID');
    }
    return decoded;
  }

  private readReference(value: string): string {
    const region = escapeRegularExpression(this.scope.region);
    const account = escapeRegularExpression(this.scope.accountId);
    if (
      !new RegExp(
        `^arn:aws:secretsmanager:${region}:${account}:secret:tenant-[A-Za-z0-9/_+=.@-]{1,505}$`,
        'u',
      ).test(value)
    ) {
      throw new Error('SECRET_REFERENCE_OUTSIDE_RUNTIME_SCOPE');
    }
    return value;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function readUuid(value: string, kind: 'TENANT' | 'WORKSPACE'): string {
  if (!UUID.test(value)) throw new Error(`INVALID_${kind}_ID`);
  return value.toLowerCase();
}

function readSingleUuidTag(
  tags: Array<{ Key?: string | undefined; Value?: string | undefined }> | undefined,
  key: string,
): string | null {
  const matches = tags?.filter((tag) => tag.Key === key) ?? [];
  const value = matches.length === 1 ? matches[0]?.Value : undefined;
  return value !== undefined && UUID.test(value) ? value.toLowerCase() : null;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
