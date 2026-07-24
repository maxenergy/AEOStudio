import { describe, expect, test } from 'vitest';
import { resolve } from 'node:path';

interface RestoreDrillResult {
  evidence: {
    drillId: string;
    environment: string;
    executionIdentity: {
      executionArn: string;
      taskArn: string;
      taskDefinitionArn: string;
    };
    outcome: string;
    rds: {
      restoredIdentifier: string;
      selectedRestoreTime: string;
    };
    recoveryImage: { digest: string; image: string };
    s3: { restoreJobId: string; restoredVersionId: string };
    schemaVersion: string;
  };
  evidencePath: string;
  exitCode: number;
}

describe('Task 18 recovery SDK runtime', () => {
  test('performs the complete restore through SDK operations and preserves the evidence contract', async () => {
    // @ts-expect-error The production entrypoint is a native ESM JavaScript module.
    const { runRestoreDrill } = (await import('../../scripts/recovery/run-restore-drill.mjs')) as {
      runRestoreDrill: (input: Record<string, unknown>) => Promise<RestoreDrillResult>;
    };
    const startedAt = new Date('2026-07-23T04:00:00.000Z');
    const calls: Array<{ input: Record<string, unknown>; operation: string }> = [];
    const evidenceWrites: Array<{
      contents: string;
      options: Record<string, unknown>;
      path: string;
    }> = [];
    let databaseConfiguration: Record<string, unknown> | undefined;
    const taskId = '0123456789abcdef0123456789abcdef';
    const imageDigest = 'sha256:'.concat('a'.repeat(64));
    const image = `123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-recovery@${imageDigest}`;
    const environment = {
      AWS_REGION: 'ap-southeast-1',
      AEO_BACKUP_RESTORE_ROLE_ARN:
        'arn:aws:iam::123456789012:role/aeostudio-staging-backup-restore',
      AEO_BACKUP_VAULT_NAME: 'aeostudio-staging-backup',
      AEO_RECOVERY_BUILD_RUN_ATTEMPT: '3',
      AEO_RECOVERY_BUILD_RUN_ID: '4200',
      AEO_RECOVERY_IMAGE_DIGEST: imageDigest,
      AEO_RECOVERY_IMAGE_URI: image,
      AEO_RDS_CA_BUNDLE: '/opt/rds/global-bundle.pem',
      AEO_RESTORED_BUCKET: 'aeostudio-staging-123456789012-restore-drill',
      AEO_RESTORE_CONFIRM: 'staging',
      AEO_RESTORE_DATABASE_NAME: 'aeostudio',
      AEO_RESTORE_DB_CREDENTIAL_SECRET_ARN:
        'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:staging/restore-AbCdEf',
      AEO_RESTORE_DB_IDENTIFIER: `aeostudio-staging-${taskId.slice(0, 12)}-restore-drill`,
      AEO_RESTORE_DB_PARAMETER_GROUP: 'aeostudio-staging-postgres18-tls',
      AEO_RESTORE_DB_SECURITY_GROUP: 'sg-0123456789abcdef0',
      AEO_RESTORE_DB_SUBNET_GROUP: 'aeostudio-staging-postgres',
      AEO_RESTORE_DRILL_ID: taskId,
      AEO_RESTORE_EVIDENCE_PATH: '/tmp/aeostudio-restore/evidence.json',
      AEO_RESTORE_EXECUTION_ARN:
        'arn:aws:states:ap-southeast-1:123456789012:execution:aeostudio-staging-restore-drill:restore-4312-2',
      AEO_RESTORE_MARKER_CHECKSUM: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      AEO_RESTORE_MARKER_ID: '123e4567-e89b-42d3-a456-426614174000',
      AEO_RESTORE_MARKER_KEY: 'recovery/markers/2026-07-23.json',
      AEO_RESTORE_MARKER_VERSION_ID: 'source-version-id',
      AEO_RESTORE_REPOSITORY: 'owner/aeostudio',
      AEO_RESTORE_SOURCE_SHA: 'b'.repeat(40),
      AEO_RESTORE_TASK_ARN: `arn:aws:ecs:ap-southeast-1:123456789012:task/aeostudio-staging/${taskId}`,
      AEO_RESTORE_TASK_DEFINITION_ARN:
        'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/aeostudio-staging-restore-drill:7',
      AEO_RESTORE_WORKFLOW_RUN_ATTEMPT: '2',
      AEO_RESTORE_WORKFLOW_RUN_ID: '4312',
      AEO_S3_RECOVERY_POINT_ARN:
        'arn:aws:backup:ap-southeast-1:123456789012:recovery-point:continuous-0123456789abcdef',
      AEO_S3_RESTORE_METADATA_FILE: '/tmp/aeostudio-restore/s3-restore-metadata.json',
      AEO_S3_RESTORE_TIME: '2026-07-23T03:58:00.000Z',
      AEO_SOURCE_DB_IDENTIFIER: 'aeostudio-staging-postgres',
    };
    let describeDatabaseCount = 0;
    const record = <T>(
      operation: string,
      input: Record<string, unknown>,
      response: T,
    ): Promise<T> => {
      calls.push({ operation, input });
      return Promise.resolve(response);
    };
    const aws = {
      describeDbInstances: (input: Record<string, unknown>) => {
        describeDatabaseCount += 1;
        return record('DescribeDbInstances', input, {
          DBInstances:
            describeDatabaseCount === 1
              ? [
                  {
                    EarliestRestorableTime: new Date('2026-07-23T03:45:00.000Z'),
                    Engine: 'postgres',
                    LatestRestorableTime: new Date('2026-07-23T03:59:00.000Z'),
                  },
                ]
              : [
                  {
                    DBParameterGroups: [
                      {
                        DBParameterGroupName: 'aeostudio-staging-postgres18-tls',
                        ParameterApplyStatus: 'in-sync',
                      },
                    ],
                    Endpoint: { Address: 'restore.internal', Port: 5432 },
                    Engine: 'postgres',
                    MultiAZ: true,
                    PubliclyAccessible: false,
                  },
                ],
        });
      },
      restoreDbInstanceToPointInTime: (input: Record<string, unknown>) =>
        record('RestoreDbInstanceToPointInTime', input, {}),
      waitUntilDbInstanceAvailable: (input: Record<string, unknown>) =>
        record('WaitUntilDbInstanceAvailable', input, { state: 'SUCCESS' }),
      getSecretValue: (input: Record<string, unknown>) =>
        record('GetSecretValue', input, {
          SecretString: JSON.stringify({
            password: 'test-only-password',
            username: 'restore_operator',
          }),
        }),
      describeRecoveryPoint: (input: Record<string, unknown>) =>
        record('DescribeRecoveryPoint', input, {
          CreationDate: new Date('2026-07-23T03:55:00.000Z'),
          RecoveryPointArn: environment.AEO_S3_RECOVERY_POINT_ARN,
          ResourceArn: 'arn:aws:s3:::aeostudio-staging-source',
          ResourceType: 'S3',
          Status: 'AVAILABLE',
        }),
      headObject: (input: Record<string, unknown>) =>
        record('HeadObject', input, {
          ChecksumSHA256: environment.AEO_RESTORE_MARKER_CHECKSUM,
          LastModified: new Date('2026-07-23T03:57:00.000Z'),
        }),
      listObjectVersions: (input: Record<string, unknown>) => {
        const prior = calls.filter(({ operation }) => operation === 'ListObjectVersions').length;
        return record(
          'ListObjectVersions',
          input,
          prior === 0
            ? {
                Versions: [
                  {
                    Key: environment.AEO_RESTORE_MARKER_KEY,
                    VersionId: 'prior-restored-version',
                  },
                ],
              }
            : {
                Versions: [
                  {
                    Key: environment.AEO_RESTORE_MARKER_KEY,
                    VersionId: 'new-restored-version',
                  },
                  {
                    Key: environment.AEO_RESTORE_MARKER_KEY,
                    VersionId: 'prior-restored-version',
                  },
                ],
              },
        );
      },
      startRestoreJob: (input: Record<string, unknown>) =>
        record('StartRestoreJob', input, { RestoreJobId: 'restore-job-123' }),
      describeRestoreJob: (input: Record<string, unknown>) =>
        record('DescribeRestoreJob', input, { Status: 'COMPLETED' }),
    };

    const result = await runRestoreDrill({
      aws,
      createDatabaseClient: (configuration: Record<string, unknown>) => {
        databaseConfiguration = configuration;
        return Promise.resolve({
          connect: () => Promise.resolve(),
          end: () => Promise.resolve(),
          query: () =>
            Promise.resolve({
              rowCount: 1,
              rows: [{ occurred_at: '2026-07-23T03:58:00.000Z' }],
            }),
        });
      },
      environment,
      files: {
        mkdir: () => Promise.resolve(),
        readFile: (path: string) =>
          Promise.resolve(
            path.endsWith('global-bundle.pem')
              ? 'test-only-rds-ca'
              : JSON.stringify({
                  DestinationBucketName: environment.AEO_RESTORED_BUCKET,
                  EncryptionType: 'SSE-KMS',
                }),
          ),
        writeFile: (path: string, contents: string, options: Record<string, unknown>) => {
          evidenceWrites.push({ path, contents, options });
          return Promise.resolve();
        },
      },
      lookupHost: () => Promise.resolve([{ address: '10.0.0.12', family: 4 }]),
      now: () => new Date('2026-07-23T04:02:00.000Z'),
      sleep: () => Promise.reject(new Error('UNEXPECTED_BACKUP_WAITER_SLEEP')),
      startedAt,
    });

    expect(result.exitCode).toBe(0);
    expect(result.evidence).toMatchObject({
      drillId: taskId,
      environment: 'staging',
      executionIdentity: {
        executionArn: environment.AEO_RESTORE_EXECUTION_ARN,
        taskArn: environment.AEO_RESTORE_TASK_ARN,
        taskDefinitionArn: environment.AEO_RESTORE_TASK_DEFINITION_ARN,
      },
      outcome: 'PASSED',
      rds: {
        restoredIdentifier: environment.AEO_RESTORE_DB_IDENTIFIER,
        selectedRestoreTime: '2026-07-23T03:58:59.000Z',
      },
      recoveryImage: { digest: imageDigest, image },
      s3: {
        restoreJobId: 'restore-job-123',
        restoredVersionId: 'new-restored-version',
      },
      schemaVersion: 'aeostudio-restore-drill.v1',
    });
    expect(databaseConfiguration).toMatchObject({
      database: 'aeostudio',
      host: 'restore.internal',
      password: 'test-only-password',
      port: 5432,
      ssl: { ca: 'test-only-rds-ca', rejectUnauthorized: true },
      user: 'restore_operator',
    });
    expect(calls.map(({ operation }) => operation)).toEqual([
      'DescribeDbInstances',
      'RestoreDbInstanceToPointInTime',
      'WaitUntilDbInstanceAvailable',
      'DescribeDbInstances',
      'GetSecretValue',
      'DescribeRecoveryPoint',
      'HeadObject',
      'ListObjectVersions',
      'StartRestoreJob',
      'DescribeRestoreJob',
      'ListObjectVersions',
      'HeadObject',
    ]);
    const restore = calls.find(({ operation }) => operation === 'RestoreDbInstanceToPointInTime');
    expect(restore?.input).toMatchObject({
      DBParameterGroupName: environment.AEO_RESTORE_DB_PARAMETER_GROUP,
      DBSubnetGroupName: environment.AEO_RESTORE_DB_SUBNET_GROUP,
      DeletionProtection: true,
      MultiAZ: true,
      PubliclyAccessible: false,
      RestoreTime: new Date('2026-07-23T03:58:59.000Z'),
      SourceDBInstanceIdentifier: environment.AEO_SOURCE_DB_IDENTIFIER,
      TargetDBInstanceIdentifier: environment.AEO_RESTORE_DB_IDENTIFIER,
      VpcSecurityGroupIds: [environment.AEO_RESTORE_DB_SECURITY_GROUP],
    });
    const startRestore = calls.find(({ operation }) => operation === 'StartRestoreJob');
    expect(startRestore?.input).toMatchObject({
      IamRoleArn: environment.AEO_BACKUP_RESTORE_ROLE_ARN,
      IdempotencyToken: taskId,
      Metadata: {
        DestinationBucketName: environment.AEO_RESTORED_BUCKET,
        EncryptionType: 'SSE-KMS',
        RestoreTime: environment.AEO_S3_RESTORE_TIME,
      },
      RecoveryPointArn: environment.AEO_S3_RECOVERY_POINT_ARN,
      ResourceType: 'S3',
    });
    const markerReads = calls.filter(({ operation }) => operation === 'HeadObject');
    expect(markerReads).toHaveLength(2);
    for (const markerRead of markerReads) {
      expect(markerRead.input).toMatchObject({ ChecksumMode: 'ENABLED' });
    }
    expect(evidenceWrites).toHaveLength(1);
    expect(evidenceWrites[0]).toMatchObject({
      path: resolve(environment.AEO_RESTORE_EVIDENCE_PATH),
      options: { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    });
    expect(JSON.parse(evidenceWrites[0]?.contents ?? '{}')).toEqual(
      JSON.parse(JSON.stringify(result.evidence)),
    );
  });
});
