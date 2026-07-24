import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

// @ts-expect-error The production helper is a native ESM JavaScript module.
import * as untypedPromotion from '../../scripts/acceptance/validate-production-promotion-evidence.mjs';

const promotion = untypedPromotion as {
  validateRestorePromotionEvidence(input: {
    checksum: string;
    expected: {
      repository: string;
      restoreRunAttempt: string;
      restoreRunId: string;
      sourceSha: string;
    };
    manifest: Record<string, unknown>;
    raw: Record<string, unknown>;
    rawBytes: Buffer;
  }): void;
};

const repository = 'owner/aeostudio';
const sourceSha = 'd'.repeat(40);
const restoreRunId = '777';
const restoreRunAttempt = '3';
const taskId = 'a'.repeat(32);
const buildRunId = '4312';
const buildRunAttempt = '2';
const recoveryImage = '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-recovery';
const recoveryImageDigest = `sha256:${'e'.repeat(64)}`;
const executionArn = `arn:aws:states:ap-southeast-1:123456789012:execution:aeostudio-staging-restore-drill:restore-${restoreRunId}-${restoreRunAttempt}`;
const taskArn = `arn:aws:ecs:ap-southeast-1:123456789012:task/aeostudio-staging/${taskId}`;
const taskDefinitionArn =
  'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/aeostudio-staging-restore-drill:7';

function fixture() {
  const raw = {
    schemaVersion: 'aeostudio-restore-drill.v1',
    environment: 'staging',
    outcome: 'PASSED',
    drillId: taskId,
    region: 'ap-southeast-1',
    source: {
      repository,
      sourceSha,
      workflowRunId: restoreRunId,
      workflowRunAttempt: restoreRunAttempt,
      buildRunId,
      buildRunAttempt,
    },
    executionIdentity: { executionArn, taskArn, taskDefinitionArn },
    recoveryImage: {
      image: `${recoveryImage}@${recoveryImageDigest}`,
      digest: recoveryImageDigest,
    },
    startedAt: '2026-07-23T00:00:00.000Z',
    completedAt: '2026-07-23T01:15:00.000Z',
    limits: { rpoMinutes: 15, rtoHours: 4 },
    rpoMinutes: { rds: 2.5, rdsRecoveryPointAge: 2.5, s3: 4 },
    rtoHours: 1.25,
    rds: {
      sourceRecoveryPoint: '2026-07-22T23:57:30.000Z',
      selectedRestoreTime: '2026-07-22T23:57:30.000Z',
      latestRestorableTime: '2026-07-23T00:00:00.000Z',
      earliestRestorableTime: '2026-07-22T00:00:00.000Z',
      markerToRecoveryPointMinutes: 0,
      restoredIdentifier: 'aeostudio-staging-restore-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      parameterGroupName: 'aeostudio-staging-restored',
      connectivity: 'PRIVATE_VPC_TLS_QUERY_SUCCEEDED',
      markerAt: '2026-07-22T23:57:30.000Z',
      privateAddressCount: 2,
    },
    s3: {
      recoveryPointCreatedAt: '2026-07-22T23:56:00.000Z',
      requestedRestoreTime: '2026-07-23T00:00:00.000Z',
      restoreJobId: 'restore-job-id',
      sourceMarkerAt: '2026-07-22T23:56:00.000Z',
      sourceVersionId: 'source-version-id',
      restoredVersionId: 'restored-version-id',
    },
  };
  const rawBytes = Buffer.from(`${JSON.stringify(raw)}\n`);
  const evidenceSha256 = createHash('sha256').update(rawBytes).digest('hex');
  return {
    checksum: `${evidenceSha256}  restore-drill.json\n`,
    expected: {
      accountId: '123456789012',
      buildRunAttempt,
      buildRunId,
      region: 'ap-southeast-1',
      repository,
      restoreRunAttempt,
      restoreRunId,
      sourceSha,
    },
    manifest: {
      schemaVersion: 'aeostudio.restore-drill-artifact.v1',
      environment: 'staging',
      repository,
      sourceSha,
      workflowRunId: restoreRunId,
      workflowRunAttempt: restoreRunAttempt,
      buildRunId,
      buildRunAttempt,
      executionArn,
      taskArn,
      taskDefinitionArn,
      recoveryImage,
      recoveryImageDigest,
      evidenceBucket: 'aeostudio-staging-123456789012-audit',
      evidenceKey: `restore-drills/${taskId}.json`,
      evidenceVersionId: 'opaque-version-id',
      taskId,
      evidenceSha256,
    },
    raw,
    rawBytes,
  };
}

function rebind(value: ReturnType<typeof fixture>): ReturnType<typeof fixture> {
  value.rawBytes = Buffer.from(`${JSON.stringify(value.raw)}\n`);
  value.manifest.evidenceSha256 = createHash('sha256').update(value.rawBytes).digest('hex');
  value.checksum = `${value.manifest.evidenceSha256}  restore-drill.json\n`;
  return value;
}

describe('Task 18 production restore promotion evidence', () => {
  test('requires the same-source immutable restore artifact with RPO <= 15 and RTO <= 4', () => {
    expect(() => promotion.validateRestorePromotionEvidence(fixture())).not.toThrow();

    const excessiveRpo = fixture();
    excessiveRpo.raw.rpoMinutes.rds = 15.01;
    expect(() => promotion.validateRestorePromotionEvidence(rebind(excessiveRpo))).toThrow(
      'RESTORE_RPO_INVALID',
    );

    const excessiveRto = fixture();
    excessiveRto.raw.rtoHours = 4.01;
    expect(() => promotion.validateRestorePromotionEvidence(rebind(excessiveRto))).toThrow(
      'RESTORE_RTO_INVALID',
    );

    const incompleteRpo = fixture();
    delete incompleteRpo.raw.rpoMinutes.rdsRecoveryPointAge;
    expect(() => promotion.validateRestorePromotionEvidence(rebind(incompleteRpo))).toThrow(
      'RESTORE_RPO_INVALID',
    );

    const changedLimits = fixture();
    changedLimits.raw.limits.rpoMinutes = 30;
    expect(() => promotion.validateRestorePromotionEvidence(rebind(changedLimits))).toThrow(
      'RESTORE_LIMITS_INVALID',
    );
  });

  test('rejects a different workflow run, source SHA or any raw/checksum hash drift', () => {
    const wrongRun = fixture();
    wrongRun.manifest.workflowRunId = '778';
    expect(() => promotion.validateRestorePromotionEvidence(wrongRun)).toThrow(
      'RESTORE_ARTIFACT_IDENTITY_MISMATCH',
    );

    const wrongSource = fixture();
    wrongSource.manifest.sourceSha = 'e'.repeat(40);
    expect(() => promotion.validateRestorePromotionEvidence(wrongSource)).toThrow(
      'RESTORE_ARTIFACT_IDENTITY_MISMATCH',
    );

    const drifted = fixture();
    drifted.raw.rtoHours = 2;
    expect(() => promotion.validateRestorePromotionEvidence(drifted)).toThrow(
      'RESTORE_EVIDENCE_SHA256_MISMATCH',
    );

    const wrongChecksum = fixture();
    wrongChecksum.checksum = `${'0'.repeat(64)}  restore-drill.json\n`;
    expect(() => promotion.validateRestorePromotionEvidence(wrongChecksum)).toThrow(
      'RESTORE_CHECKSUM_FILE_INVALID',
    );
  });
});
