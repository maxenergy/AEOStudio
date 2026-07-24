import {
  AwsSecretsManagerLifecycleAdapter,
  type AwsSecretsManagerApi,
  type AwsSecretsManagerScope,
} from './aws-secrets-manager-lifecycle.js';

export async function createAwsSecretsManagerLifecycleAdapter(scope: AwsSecretsManagerScope) {
  const {
    DeleteSecretCommand,
    DescribeSecretCommand,
    GetSecretValueCommand,
    SecretsManagerClient,
  } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region: scope.region });
  const api: AwsSecretsManagerApi = {
    describeSecret: (input) => client.send(new DescribeSecretCommand(input)),
    deleteSecret: (input) => client.send(new DeleteSecretCommand(input)),
    getSecretValue: (input) => client.send(new GetSecretValueCommand(input)),
  };
  return {
    secrets: new AwsSecretsManagerLifecycleAdapter(api, scope),
    close() {
      client.destroy();
      return Promise.resolve();
    },
  };
}
