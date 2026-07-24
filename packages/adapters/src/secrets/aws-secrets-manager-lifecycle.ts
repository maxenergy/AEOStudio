export interface AwsSecretsManagerApi {
  describeSecret(input: { SecretId: string }): Promise<{
    ARN?: string | undefined;
    Tags?: Array<{ Key?: string | undefined; Value?: string | undefined }> | undefined;
  }>;
  deleteSecret(input: { SecretId: string; ForceDeleteWithoutRecovery: true }): Promise<unknown>;
  getSecretValue(input: { SecretId: string }): Promise<unknown>;
}

export interface AwsSecretsManagerScope {
  region: string;
  accountId: string;
}

// This key must stay identical to the IAM aws:ResourceTag/TenantId condition.
const TENANT_TAG = 'TenantId';
const WORKSPACE_TAG = 'WorkspaceId';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Worker-only lifecycle boundary; it never reads or returns secret plaintext. */
export class AwsSecretsManagerLifecycleAdapter {
  public constructor(
    private readonly api: AwsSecretsManagerApi,
    private readonly scope: AwsSecretsManagerScope,
  ) {
    if (!/^[a-z]{2}-[a-z]+-\d$/u.test(scope.region)) throw new Error('INVALID_AWS_REGION');
    if (!/^\d{12}$/u.test(scope.accountId)) throw new Error('INVALID_AWS_ACCOUNT_ID');
  }

  public async requestForceDelete(input: {
    tenantId: string;
    workspaceId: string;
    secretReference: string;
  }): Promise<void> {
    const secretReference = this.readScopedReference(input.secretReference);
    const metadata = await this.describeScopedSecret({ ...input, secretReference });
    if (metadata === null) return;
    try {
      await this.api.deleteSecret({
        SecretId: secretReference,
        ForceDeleteWithoutRecovery: true,
      });
    } catch (error: unknown) {
      if (!isAwsResourceNotFound(error)) throw error;
    }
  }

  public async verifyUnreadable(input: {
    tenantId: string;
    workspaceId: string;
    secretReference: string;
  }): Promise<boolean> {
    const secretReference = this.readScopedReference(input.secretReference);
    const metadata = await this.describeScopedSecret({ ...input, secretReference });
    if (metadata === null) return true;
    try {
      await this.api.getSecretValue({ SecretId: secretReference });
      return false;
    } catch (error: unknown) {
      if (isAwsResourceNotFound(error)) return true;
      throw new Error('SECRET_UNREADABLE_VERIFICATION_FAILED', { cause: error });
    }
  }

  private async describeScopedSecret(input: {
    tenantId: string;
    workspaceId: string;
    secretReference: string;
  }): Promise<Awaited<ReturnType<AwsSecretsManagerApi['describeSecret']>> | null> {
    const tenantId = readScopeId(input.tenantId, 'TENANT');
    const workspaceId = readScopeId(input.workspaceId, 'WORKSPACE');
    let metadata: Awaited<ReturnType<AwsSecretsManagerApi['describeSecret']>>;
    try {
      metadata = await this.api.describeSecret({ SecretId: input.secretReference });
    } catch (error: unknown) {
      if (isAwsResourceNotFound(error)) return null;
      throw error;
    }
    if (metadata.ARN !== input.secretReference || readTag(metadata.Tags, TENANT_TAG) !== tenantId) {
      throw new Error('SECRET_TENANT_SCOPE_MISMATCH');
    }
    if (readTag(metadata.Tags, WORKSPACE_TAG) !== workspaceId) {
      throw new Error('SECRET_WORKSPACE_SCOPE_MISMATCH');
    }
    return metadata;
  }

  private readScopedReference(value: string): string {
    const escapedRegion = escapeRegularExpression(this.scope.region);
    const escapedAccount = escapeRegularExpression(this.scope.accountId);
    const pattern = new RegExp(
      `^arn:aws:secretsmanager:${escapedRegion}:${escapedAccount}:secret:[A-Za-z0-9/_+=.@-]{1,512}$`,
      'u',
    );
    if (!pattern.test(value)) throw new Error('SECRET_REFERENCE_OUTSIDE_RUNTIME_SCOPE');
    return value;
  }
}

function isAwsResourceNotFound(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    candidate.name === 'ResourceNotFoundException' && candidate.$metadata?.httpStatusCode === 400
  );
}

function readScopeId(value: string, kind: 'TENANT' | 'WORKSPACE'): string {
  if (!UUID.test(value)) throw new Error(`INVALID_${kind}_ID`);
  return value.toLowerCase();
}

function readTag(
  tags: Array<{ Key?: string | undefined; Value?: string | undefined }> | undefined,
  key: string,
): string | null {
  const matches = tags?.filter((tag) => tag.Key === key) ?? [];
  return matches.length === 1 ? (matches[0]?.Value ?? null) : null;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
