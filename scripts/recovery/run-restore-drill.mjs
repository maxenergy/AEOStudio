import { lookup } from 'node:dns/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { createRecoveryAwsSdk } from './aws-recovery-sdk.mjs';
import {
  loadApprovedDatabaseCredentials,
  selectNewRestoredVersion,
  selectRdsRestoreWindow,
} from './restore-contract.mjs';

const region = 'ap-southeast-1';
const rpoLimitMinutes = 15;
const rtoLimitHours = 4;

const defaultFiles = {
  mkdir,
  readFile,
  writeFile,
};

async function defaultCreateDatabaseClient(configuration) {
  const { Client } = await import('pg');
  return new Client(configuration);
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function assertStagingApproval(environment) {
  if (required(environment, 'AEO_RESTORE_CONFIRM') !== 'staging') {
    throw new Error('AEO_RESTORE_CONFIRM_MUST_EQUAL_STAGING');
  }
  if (required(environment, 'AWS_REGION') !== region) {
    throw new Error('RESTORE_DRILL_REGION_MUST_BE_SINGAPORE');
  }
}

function minutesBetween(later, earlier) {
  return (later.getTime() - earlier.getTime()) / 60_000;
}

function hoursBetween(later, earlier) {
  return (later.getTime() - earlier.getTime()) / 3_600_000;
}

function requiredInstant(environment, name) {
  const value = required(environment, name);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name}_INVALID`);
  return parsed;
}

function isPrivateAddress(address) {
  const normalized = address.toLowerCase();
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

async function assertPrivateVpcReachability(host, lookupHost) {
  const addresses = await lookupHost(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPrivateAddress(address))) {
    throw new Error('RDS_PRIVATE_VPC_REACHABILITY_REQUIRED');
  }
  return addresses.length;
}

async function waitForBackupRestore({ aws, jobId, now, sleep, startedAt }) {
  const deadline = startedAt.getTime() + rtoLimitHours * 3_600_000;
  while (now().getTime() < deadline) {
    const job = await aws.describeRestoreJob({ RestoreJobId: jobId });
    if (job?.Status === 'COMPLETED') return job;
    if (['ABORTED', 'FAILED', 'EXPIRED'].includes(job?.Status)) {
      throw new Error(`S3_RESTORE_${String(job?.Status)}`);
    }
    await sleep(30_000);
  }
  throw new Error('S3_RESTORE_RTO_EXCEEDED');
}

async function restoreRds(environment, aws) {
  const sourceIdentifier = required(environment, 'AEO_SOURCE_DB_IDENTIFIER');
  const targetIdentifier = required(environment, 'AEO_RESTORE_DB_IDENTIFIER');
  if (!targetIdentifier.endsWith('-restore-drill')) {
    throw new Error('RESTORE_DB_IDENTIFIER_MUST_END_IN_RESTORE_DRILL');
  }
  const source = await aws.describeDbInstances({
    DBInstanceIdentifier: sourceIdentifier,
  });
  const sourceInstance = source?.DBInstances?.[0];
  if (sourceInstance?.Engine !== 'postgres') throw new Error('RDS_SOURCE_ENGINE_MUST_BE_POSTGRES');
  const restoreWindow = selectRdsRestoreWindow(sourceInstance);
  const parameterGroupName = required(environment, 'AEO_RESTORE_DB_PARAMETER_GROUP');

  await aws.restoreDbInstanceToPointInTime({
    DBParameterGroupName: parameterGroupName,
    DBSubnetGroupName: required(environment, 'AEO_RESTORE_DB_SUBNET_GROUP'),
    DeletionProtection: true,
    MultiAZ: true,
    PubliclyAccessible: false,
    RestoreTime: restoreWindow.selectedRestoreTime,
    SourceDBInstanceIdentifier: sourceIdentifier,
    TargetDBInstanceIdentifier: targetIdentifier,
    VpcSecurityGroupIds: [required(environment, 'AEO_RESTORE_DB_SECURITY_GROUP')],
  });
  await aws.waitUntilDbInstanceAvailable({
    DBInstanceIdentifier: targetIdentifier,
  });
  const restored = await aws.describeDbInstances({
    DBInstanceIdentifier: targetIdentifier,
  });
  const instance = restored?.DBInstances?.[0];
  const parameterGroup = instance?.DBParameterGroups?.find(
    (group) => group?.DBParameterGroupName === parameterGroupName,
  );
  if (
    instance?.Engine !== 'postgres' ||
    instance?.PubliclyAccessible !== false ||
    instance?.MultiAZ !== true ||
    parameterGroup?.ParameterApplyStatus !== 'in-sync'
  ) {
    throw new Error('RESTORED_RDS_NETWORK_OR_AZ_POLICY_FAILED');
  }
  return { targetIdentifier, restoreWindow, parameterGroupName, instance };
}

async function verifyRestoredDatabase({
  aws,
  createDatabaseClient,
  environment,
  files,
  lookupHost,
  rds,
}) {
  const host = rds.instance?.Endpoint?.Address;
  const port = rds.instance?.Endpoint?.Port;
  if (typeof host !== 'string' || typeof port !== 'number') {
    throw new Error('RESTORED_RDS_CONNECTION_METADATA_MISSING');
  }
  const privateAddressCount = await assertPrivateVpcReachability(host, lookupHost);
  const credentials = await loadApprovedDatabaseCredentials({
    credentialSecretArn: required(environment, 'AEO_RESTORE_DB_CREDENTIAL_SECRET_ARN'),
    region,
    readSecretValue: (secretArn) => aws.getSecretValue({ SecretId: secretArn }),
  });
  const ca = await files.readFile(required(environment, 'AEO_RDS_CA_BUNDLE'), 'utf8');
  const client = await createDatabaseClient({
    host,
    port,
    database: required(environment, 'AEO_RESTORE_DATABASE_NAME'),
    user: credentials.username,
    password: credentials.password,
    ssl: { ca, rejectUnauthorized: true },
  });
  try {
    await client.connect();
    const marker = await client.query(
      'SELECT occurred_at FROM audit_events WHERE id = $1::uuid AND action = $2',
      [required(environment, 'AEO_RESTORE_MARKER_ID'), 'RESTORE_DRILL_MARKER'],
    );
    if (marker.rowCount !== 1) throw new Error('RDS_RESTORE_MARKER_NOT_FOUND');
    const markerAt = new Date(marker.rows[0].occurred_at);
    if (!Number.isFinite(markerAt.getTime())) throw new Error('RDS_RESTORE_MARKER_TIME_INVALID');
    return {
      connectivity: 'PRIVATE_VPC_TLS_QUERY_SUCCEEDED',
      markerAt,
      privateAddressCount,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function restoreAndVerifyS3({ aws, environment, files, now, sleep, startedAt }) {
  const recoveryPointArn = required(environment, 'AEO_S3_RECOVERY_POINT_ARN');
  const point = await aws.describeRecoveryPoint({
    BackupVaultName: required(environment, 'AEO_BACKUP_VAULT_NAME'),
    RecoveryPointArn: recoveryPointArn,
  });
  if (
    !recoveryPointArn.includes(':recovery-point:continuous') ||
    point?.RecoveryPointArn !== recoveryPointArn ||
    point?.ResourceType !== 'S3' ||
    !['AVAILABLE', 'COMPLETED'].includes(point?.Status)
  ) {
    throw new Error('S3_CONTINUOUS_RECOVERY_POINT_INVALID');
  }
  const recoveryPointCreatedAt = new Date(point?.CreationDate ?? Number.NaN);
  if (!Number.isFinite(recoveryPointCreatedAt.getTime())) {
    throw new Error('S3_RECOVERY_POINT_CREATION_TIME_MISSING');
  }
  const sourceBucketMatch = /^arn:aws:s3:::([a-z0-9.-]{3,63})$/u.exec(point?.ResourceArn ?? '');
  if (sourceBucketMatch?.[1] === undefined) throw new Error('S3_SOURCE_RESOURCE_SCOPE_INVALID');
  const sourceBucket = sourceBucketMatch[1];
  const markerKey = required(environment, 'AEO_RESTORE_MARKER_KEY');
  const sourceVersionId = required(environment, 'AEO_RESTORE_MARKER_VERSION_ID');
  const expectedChecksum = required(environment, 'AEO_RESTORE_MARKER_CHECKSUM');
  const sourceMarker = await aws.headObject({
    Bucket: sourceBucket,
    ChecksumMode: 'ENABLED',
    Key: markerKey,
    VersionId: sourceVersionId,
  });
  if (sourceMarker?.ChecksumSHA256 !== expectedChecksum) {
    throw new Error('S3_SOURCE_MARKER_CHECKSUM_MISMATCH');
  }
  const sourceMarkerAt = new Date(sourceMarker?.LastModified ?? Number.NaN);
  if (!Number.isFinite(sourceMarkerAt.getTime())) throw new Error('S3_SOURCE_MARKER_TIME_MISSING');

  const restoreTime = requiredInstant(environment, 'AEO_S3_RESTORE_TIME');
  if (
    restoreTime.getTime() < sourceMarkerAt.getTime() ||
    restoreTime.getTime() > startedAt.getTime()
  ) {
    throw new Error('S3_RESTORE_TIME_OUTSIDE_MARKER_WINDOW');
  }
  const metadataPath = resolve(required(environment, 'AEO_S3_RESTORE_METADATA_FILE'));
  const metadata = JSON.parse(await files.readFile(metadataPath, 'utf8'));
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    Object.values(metadata).some((value) => typeof value !== 'string') ||
    metadata.DestinationBucketName !== required(environment, 'AEO_RESTORED_BUCKET')
  ) {
    throw new Error('S3_RESTORE_METADATA_INVALID');
  }
  const restoreMetadata = { ...metadata, RestoreTime: restoreTime.toISOString() };
  const restoredBucket = required(environment, 'AEO_RESTORED_BUCKET');
  const beforeRestoreVersions = await aws.listObjectVersions({
    Bucket: restoredBucket,
    Prefix: markerKey,
  });
  const started = await aws.startRestoreJob({
    IamRoleArn: required(environment, 'AEO_BACKUP_RESTORE_ROLE_ARN'),
    IdempotencyToken: required(environment, 'AEO_RESTORE_DRILL_ID'),
    Metadata: restoreMetadata,
    RecoveryPointArn: recoveryPointArn,
    ResourceType: 'S3',
  });
  const jobId = started?.RestoreJobId;
  if (typeof jobId !== 'string') throw new Error('S3_RESTORE_JOB_ID_MISSING');
  await waitForBackupRestore({ aws, jobId, now, sleep, startedAt });
  const restoredVersions = await aws.listObjectVersions({
    Bucket: restoredBucket,
    Prefix: markerKey,
  });
  const restoredVersion = selectNewRestoredVersion({
    before: beforeRestoreVersions,
    after: restoredVersions,
    markerKey,
    sourceVersionId,
  });
  const restoredVersionId = restoredVersion?.VersionId;
  if (typeof restoredVersionId !== 'string' || restoredVersionId === sourceVersionId) {
    throw new Error('S3_RESTORED_VERSION_ID_INVALID');
  }
  const marker = await aws.headObject({
    Bucket: restoredBucket,
    ChecksumMode: 'ENABLED',
    Key: markerKey,
    VersionId: restoredVersionId,
  });
  if (marker?.ChecksumSHA256 !== expectedChecksum) {
    throw new Error('S3_RESTORE_MARKER_CHECKSUM_MISMATCH');
  }
  return {
    jobId,
    recoveryPointCreatedAt,
    requestedRestoreTime: restoreTime,
    restoredVersionId,
    sourceMarkerAt,
    sourceVersionId,
  };
}

export async function runRestoreDrill({
  environment = process.env,
  aws,
  createDatabaseClient = defaultCreateDatabaseClient,
  files = defaultFiles,
  lookupHost = lookup,
  now = () => new Date(),
  sleep = delay,
  startedAt = new Date(),
} = {}) {
  assertStagingApproval(environment);
  const sdk = aws ?? (await createRecoveryAwsSdk({ region }));
  const evidencePath = resolve(
    environment.AEO_RESTORE_EVIDENCE_PATH ?? 'output/restore-drill.json',
  );
  const evidence = {
    schemaVersion: 'aeostudio-restore-drill.v1',
    drillId: required(environment, 'AEO_RESTORE_DRILL_ID'),
    environment: 'staging',
    region,
    source: {
      repository: required(environment, 'AEO_RESTORE_REPOSITORY'),
      sourceSha: required(environment, 'AEO_RESTORE_SOURCE_SHA'),
      workflowRunId: required(environment, 'AEO_RESTORE_WORKFLOW_RUN_ID'),
      workflowRunAttempt: required(environment, 'AEO_RESTORE_WORKFLOW_RUN_ATTEMPT'),
      buildRunId: required(environment, 'AEO_RECOVERY_BUILD_RUN_ID'),
      buildRunAttempt: required(environment, 'AEO_RECOVERY_BUILD_RUN_ATTEMPT'),
    },
    executionIdentity: {
      executionArn: required(environment, 'AEO_RESTORE_EXECUTION_ARN'),
      taskArn: required(environment, 'AEO_RESTORE_TASK_ARN'),
      taskDefinitionArn: required(environment, 'AEO_RESTORE_TASK_DEFINITION_ARN'),
    },
    recoveryImage: {
      image: required(environment, 'AEO_RECOVERY_IMAGE_URI'),
      digest: required(environment, 'AEO_RECOVERY_IMAGE_DIGEST'),
    },
    startedAt: startedAt.toISOString(),
    limits: { rpoMinutes: rpoLimitMinutes, rtoHours: rtoLimitHours },
  };
  let exitCode = 0;

  try {
    const rds = await restoreRds(environment, sdk);
    const rdsVerification = await verifyRestoredDatabase({
      aws: sdk,
      createDatabaseClient,
      environment,
      files,
      lookupHost,
      rds,
    });
    const s3 = await restoreAndVerifyS3({
      aws: sdk,
      environment,
      files,
      now,
      sleep,
      startedAt,
    });
    const completedAt = now();
    const rdsRecoveryPointAgeMinutes = minutesBetween(
      startedAt,
      rds.restoreWindow.selectedRestoreTime,
    );
    const rdsMarkerRpoMinutes = minutesBetween(startedAt, rdsVerification.markerAt);
    const rdsMarkerToRestorePointMinutes = minutesBetween(
      rds.restoreWindow.selectedRestoreTime,
      rdsVerification.markerAt,
    );
    const s3RpoMinutes = minutesBetween(startedAt, s3.sourceMarkerAt);
    const rtoHours = hoursBetween(completedAt, startedAt);
    const passed =
      rdsRecoveryPointAgeMinutes >= 0 &&
      rdsRecoveryPointAgeMinutes <= rpoLimitMinutes &&
      rdsMarkerRpoMinutes >= 0 &&
      rdsMarkerRpoMinutes <= rpoLimitMinutes &&
      rdsMarkerToRestorePointMinutes >= 0 &&
      rdsMarkerToRestorePointMinutes <= rpoLimitMinutes &&
      s3RpoMinutes >= 0 &&
      s3RpoMinutes <= rpoLimitMinutes &&
      rtoHours >= 0 &&
      rtoHours <= rtoLimitHours;
    Object.assign(evidence, {
      outcome: passed ? 'PASSED' : 'FAILED_THRESHOLD',
      completedAt: completedAt.toISOString(),
      rpoMinutes: {
        rds: rdsMarkerRpoMinutes,
        rdsRecoveryPointAge: rdsRecoveryPointAgeMinutes,
        s3: s3RpoMinutes,
      },
      rtoHours,
      rds: {
        sourceRecoveryPoint: rds.restoreWindow.selectedRestoreTime.toISOString(),
        selectedRestoreTime: rds.restoreWindow.selectedRestoreTime.toISOString(),
        latestRestorableTime: rds.restoreWindow.latestRestorableTime.toISOString(),
        earliestRestorableTime: rds.restoreWindow.earliestRestorableTime.toISOString(),
        markerToRecoveryPointMinutes: rdsMarkerToRestorePointMinutes,
        restoredIdentifier: rds.targetIdentifier,
        parameterGroupName: rds.parameterGroupName,
        ...rdsVerification,
      },
      s3: {
        recoveryPointCreatedAt: s3.recoveryPointCreatedAt.toISOString(),
        requestedRestoreTime: s3.requestedRestoreTime.toISOString(),
        restoreJobId: s3.jobId,
        sourceMarkerAt: s3.sourceMarkerAt.toISOString(),
        sourceVersionId: s3.sourceVersionId,
        restoredVersionId: s3.restoredVersionId,
      },
    });
    if (!passed) exitCode = 1;
  } catch (error) {
    Object.assign(evidence, {
      outcome: 'FAILED',
      completedAt: now().toISOString(),
      errorCode: error instanceof Error ? error.message.split(':', 1)[0] : 'UNKNOWN_ERROR',
    });
    exitCode = 1;
  } finally {
    await files.mkdir(dirname(evidencePath), { recursive: true });
    await files.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  }
  return { evidence, evidencePath, exitCode };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const result = await runRestoreDrill();
    process.stdout.write(
      `${JSON.stringify({ outcome: result.evidence.outcome, evidencePath: result.evidencePath })}\n`,
    );
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        outcome: 'FAILED',
        errorCode: error instanceof Error ? error.message.split(':', 1)[0] : 'UNKNOWN_ERROR',
      })}\n`,
    );
    process.exitCode = 1;
  }
}
