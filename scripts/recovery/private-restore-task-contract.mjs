import { posix } from 'node:path';

const region = 'ap-southeast-1';
const contractSchema = 'aeostudio.restore-drill-input.v1';
const maximumContractLifetimeMilliseconds = 60 * 60 * 1_000;

function invalid(code) {
  throw new Error(code);
}

function instant(value, code) {
  const parsed = new Date(value ?? Number.NaN);
  if (!Number.isFinite(parsed.getTime())) invalid(code);
  return parsed;
}

function record(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(code);
  return value;
}

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

export function buildPrivateRestoreTaskPlan({ taskArn, now, contract }) {
  const arn =
    /^arn:aws:ecs:ap-southeast-1:([0-9]{12}):task\/aeostudio-staging\/([0-9a-f]{32})$/u.exec(
      taskArn ?? '',
    );
  if (arn === null) invalid('RESTORE_TASK_ARN_INVALID');
  const accountId = arn[1];
  const drillId = arn[2];

  const current = instant(now, 'RESTORE_TASK_NOW_INVALID');
  const input = record(contract, 'RESTORE_INPUT_INVALID');
  if (input.schemaVersion !== contractSchema || input.environment !== 'staging') {
    invalid('RESTORE_INPUT_NOT_STAGING');
  }
  const expiresAt = instant(input.expiresAt, 'RESTORE_INPUT_EXPIRY_INVALID');
  if (
    expiresAt.getTime() <= current.getTime() ||
    expiresAt.getTime() - current.getTime() > maximumContractLifetimeMilliseconds
  ) {
    invalid('RESTORE_INPUT_EXPIRED_OR_OVERLONG');
  }

  const rds = record(input.rds, 'RESTORE_INPUT_RDS_INVALID');
  const markerId = String(rds.markerId ?? '');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(markerId)
  ) {
    invalid('RESTORE_INPUT_RDS_MARKER_INVALID');
  }

  const s3 = record(input.s3, 'RESTORE_INPUT_S3_INVALID');
  const restoreTime = instant(s3.restoreTime, 'RESTORE_INPUT_S3_TIME_INVALID');
  if (restoreTime.getTime() > current.getTime()) invalid('RESTORE_INPUT_S3_TIME_IN_FUTURE');
  const recoveryPointArn = String(s3.recoveryPointArn ?? '');
  if (
    !new RegExp(
      `^arn:aws:backup:${region}:${accountId}:recovery-point:continuous-[A-Za-z0-9-]+$`,
      'u',
    ).test(recoveryPointArn)
  ) {
    invalid('RESTORE_INPUT_RECOVERY_POINT_INVALID');
  }
  const markerKey = String(s3.markerKey ?? '');
  if (
    markerKey.length === 0 ||
    markerKey.length > 1_024 ||
    markerKey.startsWith('/') ||
    markerKey.includes('\\') ||
    markerKey.split('/').includes('..') ||
    containsControlCharacter(markerKey)
  ) {
    invalid('RESTORE_INPUT_S3_MARKER_KEY_INVALID');
  }
  const markerVersionId = String(s3.markerVersionId ?? '');
  if (
    markerVersionId.length === 0 ||
    markerVersionId.length > 1_024 ||
    containsControlCharacter(markerVersionId)
  ) {
    invalid('RESTORE_INPUT_S3_VERSION_INVALID');
  }
  const markerChecksumSha256 = String(s3.markerChecksumSha256 ?? '');
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(markerChecksumSha256)) {
    invalid('RESTORE_INPUT_S3_CHECKSUM_INVALID');
  }

  const taskDirectory = posix.join('/tmp/aeostudio-restore', drillId);
  const evidencePath = posix.join(taskDirectory, 'evidence.json');
  const restoreMetadataPath = posix.join(taskDirectory, 's3-restore-metadata.json');
  const evidenceKey = posix.join('restore-drills', `${drillId}.json`);

  return {
    drillId,
    evidenceKey,
    evidencePath,
    restoreMetadataPath,
    environment: {
      AEO_RESTORE_CONFIRM: 'staging',
      AWS_REGION: region,
      AEO_RESTORE_DRILL_ID: drillId,
      AEO_RESTORE_DB_IDENTIFIER: `aeostudio-staging-${drillId.slice(0, 12)}-restore-drill`,
      AEO_RESTORE_MARKER_ID: markerId,
      AEO_S3_RECOVERY_POINT_ARN: recoveryPointArn,
      AEO_S3_RESTORE_TIME: restoreTime.toISOString(),
      AEO_RESTORE_MARKER_KEY: markerKey,
      AEO_RESTORE_MARKER_VERSION_ID: markerVersionId,
      AEO_RESTORE_MARKER_CHECKSUM: markerChecksumSha256,
      AEO_RESTORE_EVIDENCE_PATH: evidencePath,
      AEO_S3_RESTORE_METADATA_FILE: restoreMetadataPath,
    },
  };
}
