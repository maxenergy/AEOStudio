import { createReadStream } from 'node:fs';

const rdsWaiterMaxSeconds = 4 * 60 * 60;

export async function createRecoveryAwsSdk({ region } = {}) {
  if (typeof region !== 'string' || region.length === 0) {
    throw new Error('AWS_SDK_REGION_REQUIRED');
  }

  const [backup, rds, s3, secretsManager, ssm] = await Promise.all([
    import('@aws-sdk/client-backup'),
    import('@aws-sdk/client-rds'),
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/client-secrets-manager'),
    import('@aws-sdk/client-ssm'),
  ]);
  const backupClient = new backup.BackupClient({ region });
  const rdsClient = new rds.RDSClient({ region });
  const s3Client = new s3.S3Client({ region });
  const secretsManagerClient = new secretsManager.SecretsManagerClient({ region });
  const ssmClient = new ssm.SSMClient({ region });

  return Object.freeze({
    describeDbInstances: (input) => rdsClient.send(new rds.DescribeDBInstancesCommand(input)),
    restoreDbInstanceToPointInTime: (input) =>
      rdsClient.send(new rds.RestoreDBInstanceToPointInTimeCommand(input)),
    async waitUntilDbInstanceAvailable(input) {
      const result = await rds.waitUntilDBInstanceAvailable(
        {
          client: rdsClient,
          maxDelay: 120,
          maxWaitTime: rdsWaiterMaxSeconds,
          minDelay: 30,
        },
        input,
      );
      if (result.state !== 'SUCCESS') {
        throw new Error('RDS_DB_INSTANCE_AVAILABLE_WAITER_FAILED');
      }
      return result;
    },
    getSecretValue: (input) =>
      secretsManagerClient.send(new secretsManager.GetSecretValueCommand(input)),
    describeRecoveryPoint: (input) =>
      backupClient.send(new backup.DescribeRecoveryPointCommand(input)),
    getRecoveryPointRestoreMetadata: (input) =>
      backupClient.send(new backup.GetRecoveryPointRestoreMetadataCommand(input)),
    startRestoreJob: (input) => backupClient.send(new backup.StartRestoreJobCommand(input)),
    describeRestoreJob: (input) => backupClient.send(new backup.DescribeRestoreJobCommand(input)),
    headObject: (input) => s3Client.send(new s3.HeadObjectCommand(input)),
    listObjectVersions: (input) => s3Client.send(new s3.ListObjectVersionsCommand(input)),
    getParameter: (input) => ssmClient.send(new ssm.GetParameterCommand(input)),
    putEvidenceObject: ({ BodyPath, ...input }) => {
      if (typeof BodyPath !== 'string' || BodyPath.length === 0) {
        throw new Error('RESTORE_EVIDENCE_BODY_PATH_REQUIRED');
      }
      return s3Client.send(
        new s3.PutObjectCommand({
          ...input,
          Body: createReadStream(BodyPath),
        }),
      );
    },
  });
}
