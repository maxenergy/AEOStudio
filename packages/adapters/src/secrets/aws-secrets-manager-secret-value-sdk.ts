import {
  AwsSecretsManagerSecretValueProvider,
  type AwsSecretsManagerValueApi,
  type AwsSecretsManagerValueScope,
} from './aws-secrets-manager-secret-value-provider.js';

export async function createAwsSecretsManagerSecretValueProvider(
  scope: AwsSecretsManagerValueScope,
) {
  const { DescribeSecretCommand, GetSecretValueCommand, SecretsManagerClient } =
    await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region: scope.region });
  const api: AwsSecretsManagerValueApi = {
    describeSecret: (input) => client.send(new DescribeSecretCommand(input)),
    async getSecretValue(input) {
      const value = await client.send(new GetSecretValueCommand(input));
      return {
        ...(value.SecretString === undefined ? {} : { SecretString: value.SecretString }),
        ...(value.SecretBinary === undefined ? {} : { SecretBinary: value.SecretBinary }),
      };
    },
  };
  return {
    provider: new AwsSecretsManagerSecretValueProvider(api, scope),
    close() {
      client.destroy();
      return Promise.resolve();
    },
  };
}
