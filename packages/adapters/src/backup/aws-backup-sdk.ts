import {
  AwsBackupDeletionVerifier,
  type AwsBackupApi,
  type AwsBackupDeletionVerifierScope,
  type AwsRdsApi,
} from './aws-backup-deletion-verifier.js';

export async function createAwsBackupDeletionVerifier(scope: AwsBackupDeletionVerifierScope) {
  const [{ BackupClient, ListRecoveryPointsByResourceCommand }, rdsSdk] = await Promise.all([
    import('@aws-sdk/client-backup'),
    import('@aws-sdk/client-rds'),
  ]);
  const backupClient = new BackupClient({ region: scope.region });
  const rdsClient = new rdsSdk.RDSClient({ region: scope.region });
  const backup: AwsBackupApi = {
    listRecoveryPointsByResource: (input, options) =>
      backupClient.send(new ListRecoveryPointsByResourceCommand(input), options),
  };
  const rds: AwsRdsApi = {
    describeDBInstances: (input, options) =>
      rdsClient.send(new rdsSdk.DescribeDBInstancesCommand(input), options),
    describeDBInstanceAutomatedBackups: (input, options) =>
      rdsClient.send(new rdsSdk.DescribeDBInstanceAutomatedBackupsCommand(input), options),
    describeDBSnapshots: (input, options) =>
      rdsClient.send(new rdsSdk.DescribeDBSnapshotsCommand(input), options),
  };
  return {
    verifier: new AwsBackupDeletionVerifier(backup, rds, scope),
    close() {
      backupClient.destroy();
      rdsClient.destroy();
      return Promise.resolve();
    },
  };
}
