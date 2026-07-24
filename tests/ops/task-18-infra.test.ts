import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();
const excludedTreeDirectories = new Set(['.git', '.turbo', 'coverage', 'dist', 'node_modules']);

async function text(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8').catch(() => '');
}

async function tree(path: string, extensions: readonly string[]): Promise<string> {
  const absolute = join(root, path);
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
  const documents: string[] = [];
  for (const entry of entries) {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) {
      if (excludedTreeDirectories.has(entry.name)) continue;
      documents.push(await tree(relative(root, child), extensions));
    } else if (extensions.includes(extname(entry.name))) {
      documents.push(`\n# ${relative(root, child)}\n${await readFile(child, 'utf8')}`);
    }
  }
  return documents.join('\n');
}

describe('Task 18 AWS Singapore infrastructure contracts', () => {
  test('serializes legal-hold effects and aborts the remote call well before its lease expires', async () => {
    const migration = await text(
      'packages/db/migrations/0023_task18_legal_hold_reconciliation.sql',
    );
    const s3Sdk = await text('packages/adapters/src/storage/aws-s3-sdk.ts');

    expect(migration).toContain("work_lease_expires_at = database_now + interval '5 minutes'");
    expect(migration).not.toMatch(
      /desired_status = EXCLUDED\.desired_status[\s\S]{0,700}work_lease_token\s*=\s*CASE/u,
    );
    expect(s3Sdk).toContain('AbortSignal.timeout(30_000)');
    expect(s3Sdk).toMatch(
      /PutObjectLegalHoldCommand\(input\)[\s\S]{0,120}abortSignal:\s*createRemoteEffectAbortSignal\(\)/u,
    );
  });

  test('defines an encrypted private Multi-AZ data plane in ap-southeast-1', async () => {
    const iac = await tree('infra', ['.tf', '.tfvars']);

    expect(iac, 'expected RDS Multi-AZ resource').toContain('resource "aws_db_instance"');
    expect(iac).toMatch(/region\s*=\s*"ap-southeast-1"/u);
    expect(iac).toContain('resource "aws_vpc"');
    expect(iac.match(/resource "aws_subnet"/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(iac).toMatch(/availability_zones[\s\S]*ap-southeast-1a[\s\S]*ap-southeast-1b/u);
    expect(iac).toMatch(/multi_az\s*=\s*true/u);
    expect(iac).toMatch(/publicly_accessible\s*=\s*false/u);
    expect(iac).toMatch(/storage_encrypted\s*=\s*true/u);
    expect(iac).toMatch(/manage_master_user_password\s*=\s*true/u);
    expect(iac).toMatch(/backup_retention_period\s*=\s*(?:1[5-9]|2\d|3[0-5])/u);
    expect(iac).toMatch(/deletion_protection\s*=\s*true/u);
    expect(iac).toMatch(/skip_final_snapshot\s*=\s*false/u);
    expect(iac).not.toMatch(
      /(?:replicate|replication|destination_region)[\s\S]{0,100}(?:us-|eu-|ap-(?!southeast-1))/iu,
    );
  });

  test('keeps only ALB public and runs immutable Web API and Worker tasks privately', async () => {
    const iac = await tree('infra', ['.tf', '.json']);

    expect(iac).toContain('resource "aws_lb"');
    expect(iac).toMatch(/internal\s*=\s*false/u);
    expect(iac).toMatch(/target_type\s*=\s*"ip"/u);
    expect(iac.match(/resource "aws_ecs_service"/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(iac.match(/assign_public_ip\s*=\s*false/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(iac).toMatch(
      /deployment_circuit_breaker[\s\S]*enable\s*=\s*true[\s\S]*rollback\s*=\s*true/u,
    );
    expect(iac).toMatch(/image_tag_mutability\s*=\s*"IMMUTABLE"/u);
    expect(iac).not.toMatch(/image\s*=\s*"[^"]*:latest"/u);
  });

  test('defines SQS DLQs, lifecycle storage, Object Lock, Secrets, Cognito and recovery', async () => {
    const iac = await tree('infra', ['.tf', '.json']);

    expect(iac.match(/resource "aws_sqs_queue"/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(iac).toContain('redrive_policy');
    expect(iac).toContain('redrive_allow_policy');
    expect(iac).toContain('object_lock_enabled = true');
    expect(iac).toMatch(/status\s*=\s*"Enabled"/u);
    expect(iac).toMatch(/default_retention[\s\S]*mode\s*=\s*"GOVERNANCE"[\s\S]*days\s*=\s*365/u);
    expect(iac).toMatch(
      /resource "aws_s3_bucket_lifecycle_configuration" "audit_evidence"[\s\S]*expiration[\s\S]*days\s*=\s*365[\s\S]*noncurrent_version_expiration[\s\S]*noncurrent_days\s*=\s*1/u,
    );
    for (const days of [30, 90, 180, 365])
      expect(iac).toMatch(new RegExp(`days\\s*=\\s*${days}\\b`, 'u'));
    expect(iac).toContain('resource "aws_secretsmanager_secret"');
    expect(iac).toContain('resource "aws_cognito_user_pool"');
    expect(iac).toMatch(/mfa_configuration\s*=\s*"ON"/u);
    expect(iac).toContain('resource "aws_backup_plan"');
    expect(iac).toContain('resource "aws_backup_vault"');
    expect(iac).toContain('resource "aws_backup_restore_testing_plan"');
    expect(iac).toMatch(/enable_continuous_backup\s*=\s*true/u);
  });

  test('isolates crawl generation publish and measurement on Standard queues with exact Worker wiring', async () => {
    const messaging = await text('infra/modules/platform/messaging.tf');
    const compute = await text('infra/modules/platform/compute.tf');
    const iam = await text('infra/modules/platform/iam.tf');
    const observability = await text('infra/modules/platform/observability.tf');
    const workerComposition = await text('apps/worker/src/production-worker-composition.ts');

    for (const workload of ['crawl', 'generation', 'publish', 'measurement']) {
      expect(messaging).toContain(`resource "aws_sqs_queue" "${workload}_dlq"`);
      expect(messaging).toContain(`resource "aws_sqs_queue" "${workload}"`);
      expect(messaging).toMatch(
        new RegExp(
          `resource "aws_sqs_queue" "${workload}"[\\s\\S]*?deadLetterTargetArn\\s*=\\s*aws_sqs_queue\\.${workload}_dlq\\.arn`,
          'u',
        ),
      );
      expect(messaging).toMatch(
        new RegExp(
          `resource "aws_sqs_queue" "${workload}"[\\s\\S]*?maxReceiveCount\\s*=\\s*100`,
          'u',
        ),
      );
      expect(messaging).toMatch(
        new RegExp(
          `resource "aws_sqs_queue_redrive_allow_policy" "${workload}_dlq"[\\s\\S]*?sourceQueueArns\\s*=\\s*\\[aws_sqs_queue\\.${workload}\\.arn\\]`,
          'u',
        ),
      );
      expect(compute).toMatch(
        new RegExp(
          `name\\s*=\\s*"${workload.toUpperCase()}_QUEUE_URL"[\\s\\S]{0,100}aws_sqs_queue\\.${workload}\\.url`,
          'u',
        ),
      );
      expect(observability).toMatch(
        new RegExp(`${workload}\\s*=\\s*aws_sqs_queue\\.${workload}\\.name`, 'u'),
      );
      expect(observability).toMatch(
        new RegExp(`${workload}\\s*=\\s*aws_sqs_queue\\.${workload}_dlq\\.name`, 'u'),
      );
      expect(workerComposition).toContain(`sqs.${workload}.producer`);
      expect(workerComposition).toContain(`sqs.${workload}.consumer`);
    }
    expect(messaging).not.toMatch(/fifo_queue\s*=\s*true|\.fifo"/u);
    expect(iam).toMatch(
      /sid\s*=\s*"RelayWorkloadJobs"[\s\S]*?aws_sqs_queue\.crawl\.arn[\s\S]*?aws_sqs_queue\.generation\.arn[\s\S]*?aws_sqs_queue\.publish\.arn[\s\S]*?aws_sqs_queue\.measurement\.arn/u,
    );
    expect(iam).toMatch(
      /sid\s*=\s*"ConsumeWorkloadJobs"[\s\S]*?aws_sqs_queue\.crawl\.arn[\s\S]*?aws_sqs_queue\.generation\.arn[\s\S]*?aws_sqs_queue\.publish\.arn[\s\S]*?aws_sqs_queue\.measurement\.arn/u,
    );
  });

  test('separates migration execution and runtime task roles without broad administration', async () => {
    const iac = await tree('infra', ['.tf', '.json']);

    expect(iac).toMatch(/(?:name|name_prefix)\s*=\s*"[^"]*migration/u);
    expect(iac).toMatch(/(?:name|name_prefix)\s*=\s*"[^"]*api/u);
    expect(iac).toMatch(/(?:name|name_prefix)\s*=\s*"[^"]*worker/u);
    expect(iac).not.toMatch(/AdministratorAccess|PowerUserAccess/u);
    expect(iac).not.toMatch(/actions\s*=\s*\[?\s*"\*"/u);
    expect(iac).toMatch(/secretsmanager:GetSecretValue/u);
    expect(iac).toMatch(/sqs:(?:ReceiveMessage|DeleteMessage|SendMessage)/u);
    expect(iac).toMatch(/s3:(?:GetObject|PutObject)/u);
    expect(iac).toMatch(/iam:PassRole/u);
    expect(iac).toMatch(/token\.actions\.githubusercontent\.com:sub/u);
    expect(iac).toMatch(/StringEquals/u);
    expect(iac).not.toMatch(/repo:[^"\s]+\/[^"\s]+:\*/u);
  });

  test('wires the deployable runtime contract instead of placeholder environment names', async () => {
    const iac = await tree('infra', ['.tf', '.json']);
    const workerDockerfile = await text('apps/worker/Dockerfile');
    const databasePackage = await text('packages/db/package.json');

    expect(iac, 'Web target group must match the real Next.js port').toMatch(
      /resource "aws_lb_target_group" "web"[\s\S]*?port\s*=\s*3100/u,
    );
    expect(iac).toMatch(
      /resource "aws_ecs_task_definition" "web"[\s\S]*?containerPort\s*=\s*3100/u,
    );
    expect(iac).toMatch(/resource "aws_lb_target_group" "web"[\s\S]*?path\s*=\s*"\/"/u);
    for (const variable of [
      'DATABASE_URL',
      'SESSION_ENCRYPTION_KEY',
      'DELETION_RECEIPT_SIGNING_KEY',
      'OIDC_ISSUER_URL',
      'OIDC_CLIENT_ID',
      'OIDC_REDIRECT_URI',
      'WEB_ORIGIN',
      'API_PUBLIC_ORIGIN',
      'AWS_ACCOUNT_ID',
      'CRAWL_QUEUE_URL',
      'GENERATION_QUEUE_URL',
      'PUBLISH_QUEUE_URL',
      'MEASUREMENT_QUEUE_URL',
      'AEOSTUDIO_MEASUREMENT_QUEUE_TRANSPORT',
    ]) {
      expect(iac, `expected production runtime variable ${variable}`).toContain(`"${variable}"`);
    }
    expect(workerDockerfile).toContain('production-main.js');
    expect(databasePackage).toContain('"start:migrate"');
    expect(iac).toContain('start:migrate');
    expect(iac).not.toMatch(/name\s*=\s*"DATABASE_SECRET_ARN"/u);
  });

  test('keeps exact object identities in API configuration while denying direct tenant S3 calls', async () => {
    const compute = await text('infra/modules/platform/compute.tf');
    const iam = await text('infra/modules/platform/iam.tf');
    const apiRuntime = iam
      .split('data "aws_iam_policy_document" "api_runtime"')[1]
      ?.split('resource "aws_iam_role_policy" "api_runtime"')[0];

    expect(compute).toMatch(
      /resource "aws_ecs_task_definition" "api"[\s\S]*?"AWS_ACCOUNT_ID"[\s\S]*?"S3_KMS_KEY_ARN"/u,
    );
    expect(apiRuntime, 'expected API runtime IAM policy').toBeDefined();
    expect(apiRuntime).toMatch(
      /sid\s*=\s*"DenyDirectTenantDataAccess"[\s\S]*?effect\s*=\s*"Deny"/u,
    );
    expect(apiRuntime).toContain('s3:GetObjectVersion');
    expect(apiRuntime).toContain('s3:PutObjectTagging');
    expect(apiRuntime).toContain('s3:PutObjectRetention');
  });

  test('explicitly denies the shared Worker every tenant object-store data action', async () => {
    const iam = await text('infra/modules/platform/iam.tf');
    const workerRuntime = iam
      .split('data "aws_iam_policy_document" "worker_runtime"')[1]
      ?.split('resource "aws_iam_role_policy" "worker_runtime"')[0];
    const deniedObjects = workerRuntime
      ?.split('sid    = "DenyDirectTenantObjectAccess"')[1]
      ?.split('\n  }')[0];

    expect(deniedObjects, 'expected Worker object-store deny statement').toBeDefined();
    expect(deniedObjects).toContain('effect = "Deny"');
    expect(deniedObjects).toContain('s3:PutObjectTagging');
    expect(deniedObjects).toContain('s3:GetObjectVersion');
    expect(deniedObjects).toContain('s3:DeleteObjectVersion');
    expect(deniedObjects).toContain('s3:ListBucketVersions');
  });

  test('gives the lifecycle Worker a cross-vault read-only backup verification contract', async () => {
    const compute = await text('infra/modules/platform/compute.tf');
    const iam = await text('infra/modules/platform/iam.tf');
    const data = await text('infra/modules/platform/data.tf');

    expect(compute).toMatch(
      /resource "aws_ecs_task_definition" "worker"[\s\S]*?"BACKUP_VAULT_NAME"[\s\S]*?aws_backup_vault\.main\.name/u,
    );
    expect(compute).toMatch(
      /resource "aws_ecs_task_definition" "worker"[\s\S]*?"RDS_INSTANCE_ARN"[\s\S]*?aws_db_instance\.main\.arn/u,
    );
    expect(compute).toMatch(
      /resource "aws_ecs_task_definition" "worker"[\s\S]*?"RDS_INSTANCE_IDENTIFIER"[\s\S]*?aws_db_instance\.main\.identifier/u,
    );
    expect(data).toMatch(/backup_retention_period\s*=\s*35/u);

    const workerRuntime = iam
      .split('data "aws_iam_policy_document" "worker_runtime"')[1]
      ?.split('resource "aws_iam_role_policy" "worker_runtime"')[0];
    expect(workerRuntime, 'expected Worker runtime IAM policy').toBeDefined();
    expect(workerRuntime).toContain('backup:ListRecoveryPointsByResource');
    expect(workerRuntime).toContain('rds:DescribeDBInstances');
    expect(workerRuntime).toContain('rds:DescribeDBInstanceAutomatedBackups');
    expect(workerRuntime).toContain('rds:DescribeDBSnapshots');
    expect(workerRuntime).toMatch(
      /sid\s*=\s*"VerifyBackupDeletion"[\s\S]*?aws:RequestedRegion[\s\S]*?var\.region/u,
    );
    expect(workerRuntime).not.toMatch(
      /backup:(?:Delete|Disassociate|Start|Update)|rds:(?:Delete|Modify|Restore)/u,
    );
  });

  test('uses separate runtime credentials, a real public FQDN and explicit tenant-data denies', async () => {
    const iac = await tree('infra', ['.tf', '.json']);
    const iam = await text('infra/modules/platform/iam.tf');

    expect(iac).toContain('runtime_database_url');
    expect(iac).toContain('lifecycle_database_url');
    expect(iac).toContain('session_encryption_key');
    expect(iac).toContain('deletion_receipt_signing_key');
    expect(iac).toContain('resource "aws_route53_record"');
    expect(iac).toContain('resource "aws_acm_certificate_validation"');
    expect(iac).toMatch(/custom_domain/iu);
    expect(iac).toContain('/api/v1/auth/callback');
    expect(iac).not.toMatch(/https:\/\/\$\{aws_lb\.main\.dns_name\}/u);
    expect(iac).toMatch(/secretsmanager:DeleteSecret/u);
    expect(iac).toMatch(/s3:DeleteObjectVersion/u);
    expect(iac).toMatch(/s3:(?:PutObjectLegalHold|GetObjectLegalHold)/u);
    const deleteStatement = iam
      .split('sid    = "DenyDirectTenantObjectAccess"')[1]
      ?.split(/\n\s*statement\s*\{/u)[0];
    expect(deleteStatement, 'expected exact-version delete deny statement').toBeDefined();
    expect(deleteStatement).toContain('effect = "Deny"');
    expect(iam).toContain('sid    = "DenyDirectTenantSecretAccess"');
    expect(iam).toContain('sid    = "DenyDirectTenantDataKeyUse"');
  });

  test('aligns shared ECR and OIDC resources with workflows and protects alarm delivery', async () => {
    const iac = await tree('infra', ['.tf', '.json']);
    const workflows = await tree('.github/workflows', ['.yml', '.yaml']);

    for (const repository of ['aeostudio-api', 'aeostudio-web', 'aeostudio-worker']) {
      expect(iac).toContain(repository);
      expect(workflows).toContain(repository);
    }
    expect(iac.match(/resource "aws_iam_openid_connect_provider"/gu)?.length ?? 0).toBe(1);
    expect(iac).toContain('aeostudio-staging-image-builder');
    expect(iac).toContain('aeostudio-staging-deployer');
    expect(iac).toContain('aeostudio-production-deployer');
    expect(iac).toMatch(/aws:RequestTag\/aeostudio:attested/iu);
    expect(iac).toMatch(/ecs:cluster/iu);
    expect(iac).toMatch(/cloudwatch\.amazonaws\.com/iu);
    expect(iac).toMatch(/kms:GenerateDataKey\*/u);
    expect(iac).toMatch(/kms:Decrypt/u);
    expect(iac).toContain('resource "aws_sns_topic_policy"');
    expect(iac).toContain('resource "aws_sns_topic_subscription"');
  });
});

describe('Task 18 observability and operational evidence contracts', () => {
  test('redacts sensitive content before correlated Pino and ADOT export', async () => {
    const observability = await tree('packages/adapters/src/observability', [
      '.ts',
      '.json',
      '.yaml',
      '.yml',
    ]);
    const runtime = `${await tree('apps/api/src', ['.ts'])}\n${await tree('apps/worker/src', ['.ts'])}`;
    const iac = await tree('infra', ['.tf', '.json', '.yaml', '.yml']);

    expect(observability, 'expected trace correlation').toMatch(/trace[_-]?id/iu);
    expect(observability).toMatch(/request[_-]?id/iu);
    expect(observability).toMatch(/job[_-]?id/iu);
    for (const forbidden of [
      'authorization',
      'cookie',
      'token',
      'password',
      'secret',
      'prompt',
      'rawResponse',
      'query',
    ]) {
      expect(observability.toLowerCase()).toContain(forbidden.toLowerCase());
    }
    expect(observability).toMatch(/redact/iu);
    expect(runtime).toMatch(/instrumentation|telemetry|observability/iu);
    expect(iac).toContain('public.ecr.aws/aws-observability/aws-otel-collector@sha256:');
    expect(iac).toMatch(/retention_in_days\s*=\s*30/u);
    expect(iac).toMatch(/AWS\/ApplicationELB|TargetResponseTime/u);
    expect(iac).toMatch(/ApproximateAgeOfOldestMessage/u);
    expect(iac).toMatch(/ApproximateNumberOfMessagesVisible/u);
    expect(iac).toMatch(/DatabaseConnections|FreeStorageSpace/u);
    expect(iac).toMatch(/BackupJobsFailed/u);
  });

  test('provides explicit synthetic smoke, rollback, load and measured restore drills', async () => {
    const smoke = await tree('scripts/smoke', ['.mjs', '.ts', '.ps1', '.sh']);
    const recovery = await tree('scripts/recovery', ['.mjs', '.ts', '.ps1', '.sh']);
    const load = await tree('tests/load', ['.js', '.mjs', '.ts', '.json']);

    expect(smoke).toMatch(/health|readiness/iu);
    expect(smoke).toMatch(/login|session/iu);
    expect(smoke).toMatch(/experiment/iu);
    expect(smoke).toMatch(/rollback/iu);
    expect(load).toMatch(/100[\s\S]*(?:session|vus)|(?:session|vus)[\s\S]*100/iu);
    expect(load).toMatch(/50[\s\S]*jobs|jobs[\s\S]*50/iu);
    expect(load).toMatch(/5[\s\S]*(?:tenant|perTenant)|(?:tenant|perTenant)[\s\S]*5/iu);
    expect(load).toMatch(/500[\s\S]*(?:read|p95)|(?:read|p95)[\s\S]*500/iu);
    expect(load).toMatch(/1000[\s\S]*(?:write|p95)|(?:write|p95)[\s\S]*1000/iu);
    expect(load).toMatch(/2000[\s\S]*(?:ack|p95)|(?:ack|p95)[\s\S]*2000/iu);
    expect(load).toMatch(/30000[\s\S]*(?:queue|start)|(?:queue|start)[\s\S]*30000/iu);
    expect(load).toContain('/jobs');
    expect(load).toMatch(/jobType\s*:\s*['"]PROFILE_READINESS['"]/u);
    expect(load).toMatch(/aggregateId\s*:\s*scope\.profileId/u);
    expect(load).not.toContain('profile-readiness-jobs');
    expect(load).toMatch(/import\s*\{[^}]*sleep[^}]*\}\s*from\s*['"]k6['"]/u);
    expect(load).toMatch(/for\s*\([^)]*attempt\s*<\s*60[^)]*\)[\s\S]*sleep\(0\.5\)/u);
    expect(recovery).toMatch(
      /restoreDbInstanceToPointInTime|startRestoreJob|RestoreDBInstanceToPointInTimeCommand|StartRestoreJobCommand|restore testing/u,
    );
    expect(recovery).toMatch(/RPO/iu);
    expect(recovery).toMatch(/RTO/iu);
    expect(recovery).toMatch(/rpoLimitMinutes\s*=\s*15/u);
    expect(recovery).toMatch(/rtoLimitHours\s*=\s*4/u);
    expect(recovery).toMatch(/evidence|timestamp|recovery point/iu);
  });

  test('measures S3 continuous-restore RPO from recovered source data, not recovery-point creation', async () => {
    const recovery = await text('scripts/recovery/run-restore-drill.mjs');

    expect(recovery).toContain('AEO_S3_RESTORE_TIME');
    expect(recovery).toMatch(/RestoreTime/u);
    expect(recovery).toMatch(/sourceMarkerAt/u);
    expect(recovery).toContain('sourceVersionId');
    expect(recovery).toContain('restoredVersionId');
    expect(recovery).toMatch(/private[\s_-]*vpc|VPC_REACHABILITY/iu);
    expect(recovery).not.toMatch(/restorePoint\s*=\s*new Date\(point\?\.CreationDate/u);
    expect(recovery).not.toMatch(
      /head-object[\s\S]{0,300}AEO_RESTORED_BUCKET[\s\S]{0,300}AEO_RESTORE_MARKER_VERSION_ID/u,
    );
  });

  test('requires the recovered RDS marker to be fresh and compatible with the selected recovery point', async () => {
    const recovery = await text('scripts/recovery/run-restore-drill.mjs');
    const runbook = await text('scripts/recovery/README.md');

    expect(recovery).toContain('rdsMarkerRpoMinutes');
    expect(recovery).toContain('rdsMarkerToRestorePointMinutes');
    expect(recovery).toMatch(/rdsMarkerRpoMinutes\s*>=\s*0/u);
    expect(recovery).toMatch(/rdsMarkerRpoMinutes\s*<=\s*rpoLimitMinutes/u);
    expect(recovery).toMatch(/rdsMarkerToRestorePointMinutes\s*>=\s*0/u);
    expect(runbook).toMatch(/VPC-attached|VPC 可达|staging VPC/iu);
  });
});

describe('Task 18 delivery, supply-chain and accessibility contracts', () => {
  test('pins every external Action and uses OIDC plus build-once digest promotion', async () => {
    const workflows = await tree('.github/workflows', ['.yml', '.yaml']);
    const releaseControl = await text('infra/modules/platform/release-control.tf');
    const releaseBrokerClient = await text('scripts/release/run-release-broker.mjs');
    const uses = [...workflows.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gmu)].map(
      (match) => match[1] ?? '',
    );

    expect(workflows, 'expected GitHub OIDC role').toMatch(/id-token:\s*write/u);
    expect(workflows).toMatch(/environment:\s*staging/u);
    expect(workflows).toMatch(/environment:\s*production/u);
    expect(workflows).toMatch(/configure-aws-credentials@[0-9a-f]{40}/u);
    expect(workflows).toMatch(/actions\/attest@[0-9a-f]{40}/u);
    expect(workflows, 'expected signed SBOM attestation').toMatch(/sbom/iu);
    expect(workflows).toMatch(/provenance/iu);
    expect(workflows).toMatch(/image(?:_|-)digest|@sha256/iu);
    expect(workflows).toContain('node scripts/release/run-release-broker.mjs');
    expect(workflows).toContain('--mode DEPLOY_START');
    expect(workflows).toContain('--mode DEPLOY_WAIT');
    expect(releaseControl).toMatch(/Tags\s*=\s*local\.release_tags/u);
    expect(releaseControl).toMatch(/Key\s*=\s*"aeostudio:attested"[\s\S]{0,80}Value\s*=\s*"true"/u);
    expect(releaseControl).toMatch(/aws:RequestTag\/aeostudio:attested[\s\S]{0,80}"true"/u);
    expect(releaseControl).toContain('"Exact release services stable"');
    expect(workflows).toContain('--mode CLEANUP');
    expect(releaseBrokerClient).not.toContain("cleanupMode = 'ROLLBACK'");
    expect(releaseBrokerClient).toContain(
      'const expectedReconciliationName = `reconcile-${releaseId}`',
    );
    expect(releaseBrokerClient).toContain("Mode: 'RECOVER'");
    const credentialScan = workflows.replace(
      /^\s*(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_SECURITY_TOKEN):\s*(?:''|"")\s*$/gmu,
      '',
    );
    expect(credentialScan).not.toMatch(
      /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_SECURITY_TOKEN|secrets\.AWS_/u,
    );
    expect(uses.length).toBeGreaterThan(5);
    for (const action of uses) {
      if (action.startsWith('./') || action.startsWith('docker://')) continue;
      expect(action, `external Action must use a full commit SHA: ${action}`).toMatch(
        /@[0-9a-f]{40}$/u,
      );
    }
  });

  test('defines pinned non-root images and blocking vulnerability, secret and license gates', async () => {
    const packageJson = await text('package.json');
    const namedDockerfiles = (
      await Promise.all([
        text('Dockerfile'),
        text('apps/api/Dockerfile'),
        text('apps/web/Dockerfile'),
        text('apps/worker/Dockerfile'),
      ])
    ).join('\n');
    const security = `${await tree('scripts/security', ['.mjs', '.js', '.ts', '.json', '.yaml', '.yml'])}\n${await text('.github/workflows/build-attest.yml')}\n${await text('.github/workflows/security.yml')}`;

    expect(packageJson).toContain('"security:verify"');
    expect(namedDockerfiles).toMatch(/FROM\s+[^\s]+@sha256:[0-9a-f]{64}/iu);
    expect(namedDockerfiles).toMatch(/USER\s+(?!root\b)\w+/iu);
    expect(security).toMatch(/CycloneDX|cyclonedx/iu);
    expect(security).toMatch(/OSV|osv-scanner/iu);
    expect(security).toMatch(/Gitleaks/iu);
    expect(security).toMatch(/Trivy|Grype/iu);
    expect(security).toMatch(/license/iu);
    for (const license of ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD']) {
      expect(security).toContain(license);
    }
    expect(security).toMatch(/critical|high/iu);
    expect(security).not.toMatch(/continue-on-error:\s*true/iu);
  });

  test('runs automated axe checks across the critical user journeys', async () => {
    const accessibility = await text('tests/e2e/task-18-accessibility.spec.ts');

    expect(accessibility).toMatch(/axe/iu);
    for (const surface of ['onboarding', 'artifacts', 'channels', 'measurement']) {
      expect(accessibility).toContain(surface);
    }
    expect(accessibility).toMatch(/keyboard|Tab/u);
    expect(accessibility).toMatch(/color|focus/iu);
  });
});
