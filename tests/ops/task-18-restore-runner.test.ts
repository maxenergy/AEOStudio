import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

// @ts-expect-error The production helper is a native ESM JavaScript module.
import * as untypedPrivateRestoreTaskContract from '../../scripts/recovery/private-restore-task-contract.mjs';
// @ts-expect-error The production entrypoint is a native ESM JavaScript module.
import * as untypedPrivateRestoreTaskEntrypoint from '../../scripts/recovery/run-private-restore-task.mjs';
// @ts-expect-error The production helper is a native ESM JavaScript module.
import * as untypedRestoreContract from '../../scripts/recovery/restore-contract.mjs';

const repositoryRoot = process.cwd();

async function text(path: string): Promise<string> {
  return readFile(join(repositoryRoot, path), 'utf8');
}

describe('Task 18 private restore-drill execution plane', () => {
  test('packages a dedicated exact-Alpine non-root SDK image without AWS CLI', async () => {
    const [dockerfile, taskEntrypoint, runtimePackage, runtimeLock, runbook] = await Promise.all([
      text('Dockerfile.recovery'),
      text('scripts/recovery/run-private-restore-task.mjs'),
      text('scripts/recovery/package.json').then((value) => JSON.parse(value) as unknown),
      text('scripts/recovery/package-lock.json').then((value) => JSON.parse(value) as unknown),
      text('scripts/recovery/README.md'),
    ]);
    const manifest = runtimePackage as {
      aeostudioDependencyPolicy?: {
        lockResolvedAt?: string;
        minimumReleaseAgeHours?: number;
        registryCutoff?: string;
      };
      dependencies?: Record<string, string>;
      private?: boolean;
    };
    const lock = runtimeLock as {
      lockfileVersion?: number;
      packages?: Record<string, { version?: string }>;
    };

    expect(dockerfile).toContain(
      'FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime',
    );
    expect(dockerfile).toMatch(/apk add --no-cache\s+ca-certificates/u);
    expect(dockerfile).toContain(
      'COPY scripts/recovery/package.json scripts/recovery/package-lock.json ./',
    );
    expect(dockerfile).toMatch(/npm ci --omit=dev --ignore-scripts --no-audit --no-fund/u);
    expect(dockerfile).not.toMatch(/\bnpm install\b/u);
    expect(manifest.private).toBe(true);
    const exactRuntimeDependencies = {
      '@aws-sdk/client-backup': '3.1090.0',
      '@aws-sdk/client-rds': '3.1090.0',
      '@aws-sdk/client-s3': '3.1090.0',
      '@aws-sdk/client-secrets-manager': '3.1090.0',
      '@aws-sdk/client-ssm': '3.1090.0',
      pg: '8.22.0',
    };
    expect(manifest.dependencies).toEqual(exactRuntimeDependencies);
    expect(lock.lockfileVersion).toBe(3);
    for (const [dependency, version] of Object.entries(exactRuntimeDependencies)) {
      expect(lock.packages?.[`node_modules/${dependency}`]?.version).toBe(version);
    }
    expect(manifest.aeostudioDependencyPolicy?.minimumReleaseAgeHours).toBe(24);
    const lockResolvedAt = new Date(
      manifest.aeostudioDependencyPolicy?.lockResolvedAt ?? Number.NaN,
    );
    const registryCutoff = new Date(
      manifest.aeostudioDependencyPolicy?.registryCutoff ?? Number.NaN,
    );
    expect(lockResolvedAt.getTime() - registryCutoff.getTime()).toBeGreaterThanOrEqual(
      24 * 60 * 60 * 1_000,
    );
    expect(runbook).toContain('minimumReleaseAge');
    expect(runbook).toContain('--before=2026-07-22T07:36:00.000Z');
    expect(runbook).toContain(
      'node scripts/security/verify-npm-lock-release-age.mjs --lock scripts/recovery/package-lock.json --manifest scripts/recovery/package.json',
    );
    expect(dockerfile).toContain('rm -rf /usr/local/lib/node_modules/npm');
    expect(dockerfile).toContain('/usr/local/lib/node_modules/corepack');
    expect(dockerfile).not.toMatch(/AWS_CLI|awscli\.amazonaws\.com|\/usr\/local\/aws-cli/iu);
    expect(dockerfile).not.toMatch(/\baws --version\b/u);
    expect(dockerfile).not.toMatch(/\bapt-get\b|\bcurl\b|\bunzip\b/u);
    expect(dockerfile).toContain('COPY --chown=node:node scripts/recovery');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain(
      'ENTRYPOINT ["node", "scripts/recovery/run-private-restore-task.mjs"]',
    );
    expect(taskEntrypoint).toContain('run-restore-drill.mjs');
    expect(taskEntrypoint).not.toMatch(/spawn\(['"]aws['"]/u);
  });

  test('derives one staging drill identity and evidence object from ECS task metadata', () => {
    const { buildPrivateRestoreTaskPlan } = untypedPrivateRestoreTaskContract as {
      buildPrivateRestoreTaskPlan: (input: {
        taskArn: string;
        now: Date;
        contract: {
          schemaVersion: string;
          environment: string;
          expiresAt: string;
          rds: { markerId: string };
          s3: {
            markerChecksumSha256: string;
            markerKey: string;
            markerVersionId: string;
            recoveryPointArn: string;
            restoreTime: string;
          };
        };
      }) => {
        drillId: string;
        evidenceKey: string;
        evidencePath: string;
        restoreMetadataPath: string;
        environment: Record<string, string>;
      };
    };

    const plan = buildPrivateRestoreTaskPlan({
      taskArn:
        'arn:aws:ecs:ap-southeast-1:123456789012:task/aeostudio-staging/0123456789abcdef0123456789abcdef',
      now: new Date('2026-07-23T04:00:00.000Z'),
      contract: {
        schemaVersion: 'aeostudio.restore-drill-input.v1',
        environment: 'staging',
        expiresAt: '2026-07-23T04:15:00.000Z',
        rds: { markerId: '123e4567-e89b-42d3-a456-426614174000' },
        s3: {
          markerChecksumSha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          markerKey: 'recovery/markers/2026-07-23.json',
          markerVersionId: '3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY+MTRCxf3vjtesQ',
          recoveryPointArn:
            'arn:aws:backup:ap-southeast-1:123456789012:recovery-point:continuous-0123456789abcdef',
          restoreTime: '2026-07-23T03:59:00.000Z',
        },
      },
    });

    expect(plan.drillId).toBe('0123456789abcdef0123456789abcdef');
    expect(plan.environment.AEO_RESTORE_CONFIRM).toBe('staging');
    expect(plan.environment.AWS_REGION).toBe('ap-southeast-1');
    expect(plan.environment.AEO_RESTORE_DB_IDENTIFIER).toBe(
      'aeostudio-staging-0123456789ab-restore-drill',
    );
    expect(plan.environment.AEO_RESTORE_MARKER_ID).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(plan.evidencePath).toBe(
      '/tmp/aeostudio-restore/0123456789abcdef0123456789abcdef/evidence.json',
    );
    expect(plan.restoreMetadataPath).toBe(
      '/tmp/aeostudio-restore/0123456789abcdef0123456789abcdef/s3-restore-metadata.json',
    );
    expect(plan.evidenceKey).toBe('restore-drills/0123456789abcdef0123456789abcdef.json');
  });

  test('runs the fixed restore script and conditionally persists its evidence exactly once', async () => {
    const { runPrivateRestoreTask } = untypedPrivateRestoreTaskEntrypoint as {
      runPrivateRestoreTask: (input: {
        environment: Record<string, string>;
        loadTaskMetadata: (uri: string) => Promise<{
          Containers: Array<{ Image: string; ImageID: string; Name: string }>;
          Family: string;
          Revision: number;
          TaskARN: string;
        }>;
        aws: {
          getParameter: (input: { Name: string }) => Promise<{
            Parameter?: { Value?: string };
          }>;
          getRecoveryPointRestoreMetadata: (input: {
            BackupVaultName: string;
            RecoveryPointArn: string;
          }) => Promise<{ RestoreMetadata?: Record<string, string> }>;
          putEvidenceObject: (input: {
            BodyPath: string;
            Bucket: string;
            ChecksumAlgorithm: string;
            ContentType: string;
            IfNoneMatch: string;
            Key: string;
            ServerSideEncryption: string;
            SSEKMSKeyId: string;
          }) => Promise<unknown>;
        };
        runDrill: (environment: Record<string, string>) => Promise<number>;
        files: {
          mkdir: (path: string) => Promise<void>;
          readFile: (path: string) => Promise<string>;
          writeFile: (path: string, contents: string) => Promise<void>;
        };
        now: Date;
      }) => Promise<{ drillExitCode: number; evidenceKey: string }>;
    };
    const awsCalls: Array<{ input: Record<string, string>; operation: string }> = [];
    const writes: Array<{ path: string; contents: string }> = [];
    let drillEnvironment: Record<string, string> | undefined;
    const taskId = '0123456789abcdef0123456789abcdef';
    const evidence = `${JSON.stringify({
      schemaVersion: 'aeostudio-restore-drill.v1',
      drillId: taskId,
      environment: 'staging',
      outcome: 'PASSED',
      executionIdentity: {
        executionArn:
          'arn:aws:states:ap-southeast-1:123456789012:execution:aeostudio-staging-restore-drill:restore-4312-2',
        taskArn: `arn:aws:ecs:ap-southeast-1:123456789012:task/aeostudio-staging/${taskId}`,
        taskDefinitionArn:
          'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/aeostudio-staging-restore-drill:7',
      },
      recoveryImage: {
        image:
          '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-recovery@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    })}\n`;

    const result = await runPrivateRestoreTask({
      environment: {
        AWS_REGION: 'ap-southeast-1',
        AEO_RESTORE_INPUT_PARAMETER: '/aeostudio/staging/recovery/restore-drill-input',
        AEO_SOURCE_DB_IDENTIFIER: 'aeostudio-staging-postgres',
        AEO_RESTORE_DB_SUBNET_GROUP: 'aeostudio-staging-postgres',
        AEO_RESTORE_DB_PARAMETER_GROUP: 'aeostudio-staging-postgres18-tls',
        AEO_RESTORE_DB_SECURITY_GROUP: 'sg-0123456789abcdef0',
        AEO_RESTORE_DB_CREDENTIAL_SECRET_ARN:
          'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:rds!db-ABCDEF',
        AEO_RDS_CA_BUNDLE: '/opt/rds/global-bundle.pem',
        AEO_RESTORE_DATABASE_NAME: 'aeostudio',
        AEO_BACKUP_VAULT_NAME: 'aeostudio-staging-backup',
        AEO_RESTORED_BUCKET: 'aeostudio-staging-123456789012-restore-drill',
        AEO_BACKUP_RESTORE_ROLE_ARN: 'arn:aws:iam::123456789012:role/aeostudio-staging-backup',
        AEO_RESTORE_EVIDENCE_BUCKET: 'aeostudio-staging-123456789012-audit',
        AEO_DATA_KMS_KEY_ARN:
          'arn:aws:kms:ap-southeast-1:123456789012:key/123e4567-e89b-42d3-a456-426614174000',
        AEO_RECOVERY_IMAGE_URI:
          '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-recovery@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        AEO_RECOVERY_IMAGE_DIGEST:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        AEO_RESTORE_REPOSITORY: 'owner/aeostudio',
        AEO_RESTORE_SOURCE_SHA: 'b'.repeat(40),
        AEO_RESTORE_WORKFLOW_RUN_ID: '4312',
        AEO_RESTORE_WORKFLOW_RUN_ATTEMPT: '2',
        AEO_RECOVERY_BUILD_RUN_ID: '4200',
        AEO_RECOVERY_BUILD_RUN_ATTEMPT: '3',
        AEO_RESTORE_EXECUTION_ARN:
          'arn:aws:states:ap-southeast-1:123456789012:execution:aeostudio-staging-restore-drill:restore-4312-2',
        ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/example',
      },
      loadTaskMetadata: () =>
        Promise.resolve({
          TaskARN: `arn:aws:ecs:ap-southeast-1:123456789012:task/aeostudio-staging/${taskId}`,
          Family: 'aeostudio-staging-restore-drill',
          Revision: 7,
          Containers: [
            {
              Name: 'restore-drill',
              Image:
                '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-recovery@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              ImageID: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          ],
        }),
      aws: {
        getParameter: (input) => {
          awsCalls.push({ operation: 'GetParameter', input });
          return Promise.resolve({
            Parameter: {
              Value: JSON.stringify({
                schemaVersion: 'aeostudio.restore-drill-input.v1',
                environment: 'staging',
                expiresAt: '2026-07-23T04:15:00.000Z',
                rds: { markerId: '123e4567-e89b-42d3-a456-426614174000' },
                s3: {
                  markerChecksumSha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                  markerKey: 'recovery/markers/2026-07-23.json',
                  markerVersionId: 'source-version-id',
                  recoveryPointArn:
                    'arn:aws:backup:ap-southeast-1:123456789012:recovery-point:continuous-0123456789abcdef',
                  restoreTime: '2026-07-23T03:59:00.000Z',
                },
              }),
            },
          });
        },
        getRecoveryPointRestoreMetadata: (input) => {
          awsCalls.push({ operation: 'GetRecoveryPointRestoreMetadata', input });
          return Promise.resolve({
            RestoreMetadata: {
              DestinationBucketName: 'untrusted-source-value',
              EncryptionType: 'SSE-S3',
            },
          });
        },
        putEvidenceObject: (input) => {
          awsCalls.push({ operation: 'PutEvidenceObject', input });
          return Promise.resolve({});
        },
      },
      runDrill: (environment) => {
        drillEnvironment = environment;
        return Promise.resolve(0);
      },
      files: {
        mkdir: () => Promise.resolve(),
        readFile: () => Promise.resolve(evidence),
        writeFile: (path, contents) => {
          writes.push({ path, contents });
          return Promise.resolve();
        },
      },
      now: new Date('2026-07-23T04:00:00.000Z'),
    });

    expect(result).toEqual({
      drillExitCode: 0,
      evidenceKey: `restore-drills/${taskId}.json`,
    });
    expect(drillEnvironment?.AEO_RESTORE_DB_PARAMETER_GROUP).toBe(
      'aeostudio-staging-postgres18-tls',
    );
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]?.contents ?? '{}')).toMatchObject({
      DestinationBucketName: 'aeostudio-staging-123456789012-restore-drill',
      EncryptionType: 'SSE-KMS',
      KMSKey: 'arn:aws:kms:ap-southeast-1:123456789012:key/123e4567-e89b-42d3-a456-426614174000',
      NewBucket: 'false',
      RestoreACLs: 'false',
    });
    const evidenceWrites = awsCalls.filter(({ operation }) => operation === 'PutEvidenceObject');
    expect(evidenceWrites).toHaveLength(1);
    expect(evidenceWrites[0]?.input).toMatchObject({
      BodyPath: `/tmp/aeostudio-restore/${taskId}/evidence.json`,
      Bucket: 'aeostudio-staging-123456789012-audit',
      ChecksumAlgorithm: 'SHA256',
      ContentType: 'application/json',
      IfNoneMatch: '*',
      Key: `restore-drills/${taskId}.json`,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId:
        'arn:aws:kms:ap-southeast-1:123456789012:key/123e4567-e89b-42d3-a456-426614174000',
    });
    expect(awsCalls.map(({ operation }) => operation)).toEqual([
      'GetParameter',
      'GetRecoveryPointRestoreMetadata',
      'PutEvidenceObject',
    ]);
  });

  test('rejects a task whose ECS metadata image manifest digest is not the approved digest', async () => {
    const { runPrivateRestoreTask } = untypedPrivateRestoreTaskEntrypoint as {
      runPrivateRestoreTask: (input: Record<string, unknown>) => Promise<unknown>;
    };
    const expectedDigest = `sha256:${'a'.repeat(64)}`;
    const image = `123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-recovery@${expectedDigest}`;

    await expect(
      runPrivateRestoreTask({
        aws: {},
        environment: {
          AWS_REGION: 'ap-southeast-1',
          AEO_RECOVERY_IMAGE_DIGEST: expectedDigest,
          AEO_RECOVERY_IMAGE_URI: image,
          ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/example',
        },
        loadTaskMetadata: () =>
          Promise.resolve({
            Containers: [
              {
                Image: image,
                ImageID: `sha256:${'b'.repeat(64)}`,
                Name: 'restore-drill',
              },
            ],
            Family: 'aeostudio-staging-restore-drill',
            Revision: 7,
            TaskARN:
              'arn:aws:ecs:ap-southeast-1:123456789012:task/aeostudio-staging/0123456789abcdef0123456789abcdef',
          }),
      }),
    ).rejects.toThrow('RESTORE_TASK_IDENTITY_INVALID');
  });

  test('selects only the one marker version created by the current repeat drill', () => {
    const { selectNewRestoredVersion } = untypedRestoreContract as {
      selectNewRestoredVersion: (input: {
        before: {
          Versions?: Array<{ Key?: string; VersionId?: string; LastModified?: string }>;
          DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>;
        };
        after: {
          Versions?: Array<{ Key?: string; VersionId?: string; LastModified?: string }>;
          DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>;
        };
        markerKey: string;
        sourceVersionId: string;
      }) => { Key: string; VersionId: string; LastModified?: string };
    };
    const before = {
      Versions: [
        {
          Key: 'recovery/marker.json',
          VersionId: 'prior-restored-version',
          LastModified: '2026-07-22T04:00:00.000Z',
        },
      ],
    };

    expect(
      selectNewRestoredVersion({
        before,
        after: {
          Versions: [
            {
              Key: 'recovery/marker.json',
              VersionId: 'new-restored-version',
              LastModified: '2026-07-23T04:05:00.000Z',
            },
            ...before.Versions,
          ],
        },
        markerKey: 'recovery/marker.json',
        sourceVersionId: 'source-version',
      }),
    ).toMatchObject({ VersionId: 'new-restored-version' });

    expect(() =>
      selectNewRestoredVersion({
        before,
        after: {
          Versions: [
            { Key: 'recovery/marker.json', VersionId: 'new-version-one' },
            { Key: 'recovery/marker.json', VersionId: 'new-version-two' },
            ...before.Versions,
          ],
        },
        markerKey: 'recovery/marker.json',
        sourceVersionId: 'source-version',
      }),
    ).toThrow('S3_RESTORED_VERSION_SET_INVALID');
  });

  test('defines an exact-digest staging-only Fargate task behind a fixed private-network broker', async () => {
    const [runner, platformVariables, stagingMain, stagingVariables, productionMain, bootstrap] =
      await Promise.all([
        text('infra/modules/platform/recovery-runner.tf'),
        text('infra/modules/platform/variables.tf'),
        text('infra/environments/staging/main.tf'),
        text('infra/environments/staging/variables.tf'),
        text('infra/environments/production/main.tf'),
        text('infra/bootstrap/main.tf'),
      ]);

    expect(runner).toMatch(/restore_drill_enabled\s*=\s*var\.environment\s*==\s*"staging"/u);
    expect(bootstrap).toMatch(/repositories\s*=\s*\{[\s\S]*?recovery\s*=\s*"aeostudio-recovery"/u);
    expect(platformVariables).toMatch(
      /variable "recovery_image_digest"[\s\S]*?\^sha256:\[0-9a-f\]\{64\}\$/u,
    );
    expect(stagingVariables).toContain('variable "recovery_image_digest"');
    expect(stagingMain).toContain('recovery_image_digest');
    expect(productionMain).not.toContain('recovery_image_digest');

    expect(runner).toMatch(
      /resource "aws_ecs_task_definition" "restore_drill"[\s\S]*?requires_compatibilities\s*=\s*\["FARGATE"\][\s\S]*?network_mode\s*=\s*"awsvpc"/u,
    );
    expect(runner).toMatch(
      /image\s*=\s*"\$\{data\.aws_ecr_repository\.recovery\[0\]\.repository_url\}@\$\{var\.recovery_image_digest\}"/u,
    );
    expect(runner).toContain(
      '{ name = "AEO_RESTORE_DB_PARAMETER_GROUP", value = aws_db_parameter_group.postgres18_tls.name }',
    );
    expect(runner).toMatch(
      /resource "aws_sfn_state_machine" "restore_drill"[\s\S]*?arn:aws:states:::ecs:runTask\.sync/u,
    );
    expect(runner).toMatch(/LaunchType\s*=\s*"FARGATE"/u);
    expect(runner).toMatch(
      /TaskDefinition\s*=\s*aws_ecs_task_definition\.restore_drill\[0\]\.arn/u,
    );
    expect(runner).toMatch(/Subnets\s*=\s*aws_subnet\.private\[\*\]\.id/u);
    expect(runner).toMatch(/SecurityGroups\s*=\s*\[aws_security_group\.restore_drill\[0\]\.id\]/u);
    expect(runner).toMatch(/AssignPublicIp\s*=\s*"DISABLED"/u);
    expect(runner).toContain('Overrides = {');
    for (const identityField of [
      'AEO_RESTORE_REPOSITORY',
      'AEO_RESTORE_SOURCE_SHA',
      'AEO_RESTORE_WORKFLOW_RUN_ID',
      'AEO_RESTORE_WORKFLOW_RUN_ATTEMPT',
      'AEO_RECOVERY_BUILD_RUN_ID',
      'AEO_RECOVERY_BUILD_RUN_ATTEMPT',
      'AEO_RESTORE_EXECUTION_ARN',
    ]) {
      expect(runner).toContain(`Name = "${identityField}"`);
    }
    const identityOverrides =
      runner.split('Overrides = {')[1]?.split('NetworkConfiguration = {')[0] ?? '';
    expect(identityOverrides).not.toMatch(/Command\s*=|Cpu\s*=|Memory\s*=/u);
    expect(runner).toMatch(
      /Variable\s*=\s*"\$\.Containers\[0\]\.ExitCode"[\s\S]*?NumericEquals\s*=\s*0/u,
    );
    expect(runner).toMatch(
      /Default\s*=\s*"Restore task failed"[\s\S]*?"Restore task failed"\s*=\s*\{[\s\S]*?Type\s*=\s*"Fail"/u,
    );
  });

  test('separates least-privilege execution, task, broker and protected-environment operator roles', async () => {
    const [runner, bootstrap, platformVariables, stagingMain, productionMain] = await Promise.all([
      text('infra/modules/platform/recovery-runner.tf'),
      text('infra/bootstrap/main.tf'),
      text('infra/modules/platform/variables.tf'),
      text('infra/environments/staging/main.tf'),
      text('infra/environments/production/main.tf'),
    ]);

    expect(bootstrap).toContain(
      'restore_drill_staging = "repo:${var.github_repository}:environment:restore-drill-staging"',
    );
    expect(bootstrap).toContain('resource "aws_iam_role" "staging_restore_drill_operator"');
    expect(bootstrap).not.toContain('production_restore_drill_operator');
    expect(platformVariables).toContain('variable "restore_drill_operator_role_name"');
    expect(stagingMain).toMatch(
      /restore_drill_operator_role_name\s*=\s*"aeostudio-staging-restore-drill-operator"/u,
    );
    expect(productionMain).not.toContain('restore_drill_operator_role_name');
    expect(runner).toContain('data "aws_iam_policy_document" "restore_drill_ecs_assume"');
    expect(runner).toMatch(
      /restore_drill_ecs_assume[\s\S]*?aws:SourceAccount[\s\S]*?data\.aws_caller_identity\.current\.account_id/u,
    );
    expect(runner).toMatch(
      /restore_drill_broker_assume[\s\S]*?aws:SourceArn[\s\S]*?stateMachine:\$\{local\.name\}-restore-drill/u,
    );

    const executionPolicy =
      runner
        .split('data "aws_iam_policy_document" "restore_drill_execution"')[1]
        ?.split('resource "aws_iam_role_policy" "restore_drill_execution"')[0] ?? '';
    expect(executionPolicy).toContain('ecr:GetAuthorizationToken');
    expect(executionPolicy).toContain('ecr:BatchGetImage');
    expect(executionPolicy).toContain('logs:CreateLogStream');
    expect(executionPolicy).toContain('logs:PutLogEvents');
    expect(executionPolicy).not.toContain('secretsmanager:GetSecretValue');

    const taskPolicy =
      runner
        .split('data "aws_iam_policy_document" "restore_drill_task"')[1]
        ?.split('resource "aws_iam_role_policy" "restore_drill_task"')[0] ?? '';
    for (const action of [
      'ssm:GetParameter',
      'rds:DescribeDBInstances',
      'rds:RestoreDBInstanceToPointInTime',
      'backup:DescribeRecoveryPoint',
      'backup:GetRecoveryPointRestoreMetadata',
      'backup:StartRestoreJob',
      'backup:DescribeRestoreJob',
      'secretsmanager:GetSecretValue',
      's3:GetObjectVersion',
      's3:ListBucketVersions',
      's3:PutObject',
      'iam:PassRole',
    ]) {
      expect(taskPolicy).toContain(action);
    }
    expect(taskPolicy).toContain('aws_db_instance.main.master_user_secret[0].secret_arn');
    expect(taskPolicy).toContain('"${aws_s3_bucket.audit_evidence.arn}/restore-drills/*"');
    expect(taskPolicy).not.toMatch(/actions\s*=\s*\[\s*"\*"/u);

    const brokerPolicy =
      runner
        .split('data "aws_iam_policy_document" "restore_drill_broker"')[1]
        ?.split('resource "aws_iam_role_policy" "restore_drill_broker"')[0] ?? '';
    expect(brokerPolicy).toContain('ecs:RunTask');
    expect(brokerPolicy).toContain('aws_ecs_task_definition.restore_drill[0].arn');
    expect(brokerPolicy).toContain('iam:PassRole');
    expect(brokerPolicy).toContain('aws_iam_role.restore_drill_execution[0].arn');
    expect(brokerPolicy).toContain('aws_iam_role.restore_drill_task[0].arn');

    const operatorPolicy =
      runner
        .split('data "aws_iam_policy_document" "restore_drill_operator"')[1]
        ?.split('resource "aws_iam_role_policy" "restore_drill_operator"')[0] ?? '';
    expect(operatorPolicy).toContain('states:StartExecution');
    expect(operatorPolicy).toContain('states:DescribeExecution');
    expect(operatorPolicy).toContain('s3:ListBucketVersions');
    expect(operatorPolicy).toContain('s3:GetObject');
    expect(operatorPolicy).toContain('s3:GetObjectVersion');
    expect(operatorPolicy).toContain('aws_s3_bucket.audit_evidence.arn');
    expect(operatorPolicy).toContain('${aws_s3_bucket.audit_evidence.arn}/restore-drills/*');
    expect(operatorPolicy).toContain('variable = "s3:prefix"');
    expect(operatorPolicy).toContain('kms:Decrypt');
    expect(operatorPolicy).toContain('resources = [aws_kms_key.data.arn]');
    expect(operatorPolicy).toContain('variable = "kms:ViaService"');
    expect(operatorPolicy).toContain('variable = "kms:EncryptionContext:aws:s3:arn"');
    expect(operatorPolicy).not.toMatch(
      /"(?:ecs:[^"]+|iam:PassRole|secretsmanager:[^"]+|kms:Encrypt|kms:GenerateDataKey(?:WithoutPlaintext)?|s3:(?:Put|Delete|Abort)[^"]*)"/u,
    );
  });

  test('lets only the protected staging workflow start and observe the fixed broker', async () => {
    const workflow = await text('.github/workflows/restore-drill.yml');

    expect(workflow).toContain('build-run-id:');
    expect(workflow).toContain('required: true');
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain('github.event.repository.fork == false');
    expect(workflow).toMatch(/environment:\s*restore-drill-staging/u);
    expect(workflow).toMatch(/permissions:[\s\S]*?contents:\s*read[\s\S]*?id-token:\s*write/u);
    expect(workflow).toContain(
      'aws-actions/configure-aws-credentials@61815dcd50bd041e203e49132bacad1fd04d2708',
    );
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    expect(workflow).toContain(
      'arn:aws:iam::${EXPECTED_ACCOUNT_ID}:role/aeostudio-staging-restore-drill-operator',
    );
    expect(workflow).toContain('stateMachine:aeostudio-staging-restore-drill');
    expect(workflow).toMatch(/aws stepfunctions start-execution/u);
    expect(workflow).toMatch(/aws stepfunctions describe-execution/u);
    expect(workflow).toContain('recovery-image.json');
    expect(workflow).toContain('recovery-provenance.json');
    expect(workflow).toContain('recovery-sbom.json');
    expect(workflow).toContain('gh attestation verify');
    expect(workflow).toContain('.taskDefinitionArn == $taskDefinitionArn');
    expect(workflow).toContain('.recoveryImage.digest == $recoveryDigest');
    expect(workflow).toContain('.executionArn == $executionArn');
    expect(workflow).toContain('.source.repository == $repository');
    expect(workflow).toContain('.source.sourceSha == $sourceSha');
    expect(workflow).toMatch(
      /list-object-versions[\s\S]*?restore-drill-evidence-before\.json[\s\S]*?start-execution/u,
    );
    expect(workflow).toMatch(/list-object-versions[\s\S]*?restore-drill-evidence-after\.json/u);
    expect(workflow).toContain('restore-drills/(?<task>[0-9a-f]{32})\\\\.json');
    expect(workflow).toMatch(/VersionId[\s\S]*?get-object[\s\S]*?--version-id/u);
    expect(workflow).toContain('.schemaVersion == "aeostudio-restore-drill.v1"');
    expect(workflow).toContain('.environment == "staging"');
    expect(workflow).toContain('.outcome == "PASSED"');
    expect(workflow).toContain('.drillId == $taskId');
    expect(workflow).toContain('.rpoMinutes');
    expect(workflow).toContain('.value >= 0 and .value <= 15');
    expect(workflow).toContain('.rtoHours >= 0 and .rtoHours <= 4');
    expect(workflow).toMatch(/sha256sum\s+output\/restore-drill\.json/u);
    expect(workflow).toContain('aeostudio.restore-drill-artifact.v1');
    expect(workflow).toContain('workflowRunId');
    expect(workflow).toContain('workflowRunAttempt');
    expect(workflow).toContain('sourceSha');
    expect(workflow).toContain('evidenceSha256');
    expect(workflow).toContain('recoveryImageDigest');
    expect(workflow).toContain('taskDefinitionArn');
    expect(workflow).toContain('executionArn');
    expect(workflow).toContain(
      'name: restore-drill-evidence-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    expect(workflow).toMatch(
      /path:\s*\|[\s\S]*?output\/restore-drill\.json[\s\S]*?output\/restore-drill\.json\.sha256[\s\S]*?output\/restore-drill-evidence-manifest\.json/u,
    );
    expect(workflow).not.toMatch(
      /aws ecs|run-task|--overrides|assignPublicIp|subnets|securityGroups/u,
    );
    expect(workflow).not.toMatch(/environment:\s*production|aeostudio-production/iu);
    expect(workflow).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|secrets\.AWS_/u);
  });

  test('documents and packages the complete private-runner operating contract', async () => {
    const [dockerfile, runbook, supplyChainRunbook] = await Promise.all([
      text('Dockerfile.recovery'),
      text('scripts/recovery/README.md'),
      text('docs/operations/supply-chain.md'),
    ]);

    expect(dockerfile).toMatch(/RDS_CA_BUNDLE_SHA256=[0-9a-f]{64}/u);
    expect(dockerfile).toContain(
      'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem',
    );
    expect(dockerfile).toMatch(/sha256sum -c/u);
    expect(dockerfile).toContain('test -s /opt/rds/global-bundle.pem');

    expect(runbook).toMatch(/restore-drill-staging/u);
    expect(runbook).toContain('Dockerfile.recovery');
    expect(runbook).toContain('aeostudio-recovery@sha256:');
    expect(runbook).toContain('/aeostudio/staging/recovery/restore-drill-input');
    expect(runbook).toContain('aeostudio.restore-drill-input.v1');
    expect(runbook).toContain('AWS_STAGING_RESTORE_DRILL_OPERATOR_ROLE_ARN');
    expect(runbook).toContain('AWS_STAGING_RESTORE_DRILL_STATE_MACHINE_ARN');
    expect(runbook).toMatch(/private subnet|私有子网/iu);
    expect(runbook).toMatch(/AssignPublicIp=DISABLED/u);
    expect(runbook).toMatch(/production.*(?:forbidden|禁止)/iu);
    expect(runbook).toContain('s3://<staging-audit-bucket>/restore-drills/<ecs-task-id>.json');
    expect(runbook).toContain('restore-drill-evidence-<workflow-run-id>-<run-attempt>');
    expect(runbook).toContain('aeostudio.restore-drill-artifact.v1');
    expect(runbook).toMatch(/restore workflow run-id/iu);
    expect(runbook).toMatch(/sourceSha/iu);
    expect(runbook).toMatch(/sha256sum -c restore-drill\.json\.sha256/iu);
    expect(supplyChainRunbook).toContain(
      '| AWS_STAGING_RESTORE_DRILL_OPERATOR_ROLE_ARN | restore-drill-staging environment, client for the fixed private restore workflow |',
    );
    expect(supplyChainRunbook).not.toMatch(/\bstaging-restore environment\b/u);
  });

  test('exports only non-secret identifiers needed to configure the protected staging environment', async () => {
    const outputs = await text('infra/modules/platform/outputs.tf');

    expect(outputs).toMatch(/restore_drill\s*=\s*var\.environment\s*==\s*"staging"\s*\?\s*\{/u);
    expect(outputs).toContain('broker_arn');
    expect(outputs).toContain('task_definition_arn');
    expect(outputs).toContain('input_parameter_name');
    expect(outputs).toContain('evidence_bucket');
    expect(outputs).toContain('restore_bucket');
    expect(outputs).toMatch(/\}\s*:\s*null/u);
    expect(outputs).not.toMatch(/credential|password|secret/iu);
  });
});
