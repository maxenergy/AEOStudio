import { describe, expect, test, vi } from 'vitest';

import {
  AwsBackupDeletionVerifier,
  type AwsBackupApi,
  type AwsRdsApi,
} from './aws-backup-deletion-verifier.js';

const REQUEST_ID = '018f84b3-7eb8-7c75-9ca5-25278969d3f1';
const ACCOUNT_ID = '123456789012';
const REGION = 'ap-southeast-1';
const VAULT_NAME = 'aeostudio-staging-backup';
const DATABASE_IDENTIFIER = 'aeostudio-staging-postgres';
const DATABASE_ARN = `arn:aws:rds:${REGION}:${ACCOUNT_ID}:db:${DATABASE_IDENTIFIER}`;
const ARTIFACTS_ARN = 'arn:aws:s3:::aeostudio-staging-artifacts';
const AUDIT_ARN = 'arn:aws:s3:::aeostudio-staging-audit-evidence';
const SOURCE_DELETED_AT = '2026-05-23T00:00:00.000Z';
const VERIFIED_AT = '2026-07-22T00:00:00.000Z';
const DBI_RESOURCE_ID = 'db-ABCDEFGHIJKLMNOPQRSTUVWX12';

describe('AWS backup deletion verifier', () => {
  test('refuses a verifier scope outside the Singapore account and exact protected resources', () => {
    const backup = backupApi();
    const rds = rdsApi();

    expect(
      () => new AwsBackupDeletionVerifier(backup, rds, { ...scope(), region: 'us-east-1' }),
    ).toThrow('AWS_SINGAPORE_REGION_REQUIRED');
    expect(
      () =>
        new AwsBackupDeletionVerifier(backup, rds, {
          ...scope(),
          protectedResourceArns: [DATABASE_ARN, ARTIFACTS_ARN],
        }),
    ).toThrow('BACKUP_PROTECTED_RESOURCE_SCOPE_INVALID');
  });

  test('enumerates every exact resource across vaults and freezes on an old periodic recovery point', async () => {
    const backup = backupApi({
      listRecoveryPointsByResource: vi.fn(({ ResourceArn }: { ResourceArn: string }) =>
        Promise.resolve({
          RecoveryPoints:
            ResourceArn === ARTIFACTS_ARN
              ? [
                  {
                    CreationDate: new Date('2026-05-22T23:59:59.999Z'),
                    RecoveryPointArn: `arn:aws:backup:${REGION}:${ACCOUNT_ID}:recovery-point:other-vault-copy`,
                    Status: 'COMPLETED',
                  },
                ]
              : [],
        }),
      ),
    });
    const verifier = new AwsBackupDeletionVerifier(backup, rdsApi(), scope());

    await expect(
      verifier.verifyExpired({ requestId: REQUEST_ID, sourceDeletedAt: SOURCE_DELETED_AT }),
    ).resolves.toEqual({ outcome: 'RECOVERY_POINTS_RETAINED' });
    const artifactCall = backup.listRecoveryPointsByResource.mock.calls.find((call) => {
      const input = call[0] as { ResourceArn?: unknown };
      return input.ResourceArn === ARTIFACTS_ARN;
    });
    expect(artifactCall?.[0] as unknown).toEqual({
      ManagedByAWSBackupOnly: false,
      MaxResults: 1_000,
      ResourceArn: ARTIFACTS_ARN,
    });
    expectAbortSignalOption(artifactCall?.[1] as unknown);
  });

  test('does not permanently freeze on an old continuous point after the maximum 35-day PITR window', async () => {
    const backup = backupApi({
      listRecoveryPointsByResource: vi.fn(({ ResourceArn }: { ResourceArn: string }) =>
        Promise.resolve({
          RecoveryPoints:
            ResourceArn === ARTIFACTS_ARN
              ? [
                  {
                    CreationDate: new Date('2026-01-01T00:00:00.000Z'),
                    RecoveryPointArn: `arn:aws:backup:${REGION}:${ACCOUNT_ID}:recovery-point:continuous:artifacts`,
                    Status: 'COMPLETED',
                  },
                ]
              : [],
        }),
      ),
    });

    await expect(
      new AwsBackupDeletionVerifier(backup, rdsApi(), scope()).verifyExpired({
        requestId: REQUEST_ID,
        sourceDeletedAt: SOURCE_DELETED_AT,
      }),
    ).resolves.toMatchObject({ outcome: 'VERIFIED' });
  });

  test('freezes while a continuous point can still restore the source deletion time', async () => {
    const backup = backupApi({
      listRecoveryPointsByResource: vi.fn(({ ResourceArn }: { ResourceArn: string }) =>
        Promise.resolve({
          RecoveryPoints:
            ResourceArn === ARTIFACTS_ARN
              ? [
                  {
                    CreationDate: new Date('2026-01-01T00:00:00.000Z'),
                    RecoveryPointArn: `arn:aws:backup:${REGION}:${ACCOUNT_ID}:recovery-point:continuous:artifacts`,
                    Status: 'COMPLETED',
                  },
                ]
              : [],
        }),
      ),
    });
    const verifier = new AwsBackupDeletionVerifier(backup, rdsApi(), {
      ...scope(),
      clock: { now: () => new Date('2026-06-01T00:00:00.000Z') },
    });

    await expect(
      verifier.verifyExpired({ requestId: REQUEST_ID, sourceDeletedAt: SOURCE_DELETED_AT }),
    ).resolves.toEqual({ outcome: 'RECOVERY_POINTS_RETAINED' });
  });

  test('freezes when the exact RDS automated-backup restore window still includes source data', async () => {
    const rds = rdsApi({
      describeDBInstanceAutomatedBackups: vi.fn(() =>
        Promise.resolve({
          DBInstanceAutomatedBackups: [automatedBackup({ earliest: new Date(SOURCE_DELETED_AT) })],
        }),
      ),
    });

    await expect(
      new AwsBackupDeletionVerifier(backupApi(), rds, scope()).verifyExpired({
        requestId: REQUEST_ID,
        sourceDeletedAt: SOURCE_DELETED_AT,
      }),
    ).resolves.toEqual({ outcome: 'RECOVERY_POINTS_RETAINED' });
    expect(rds.describeDBInstances.mock.calls[0]?.[0] as unknown).toEqual({
      DBInstanceIdentifier: DATABASE_IDENTIFIER,
      MaxRecords: 100,
    });
    expectAbortSignalOption(rds.describeDBInstances.mock.calls[0]?.[1] as unknown);
    expect(rds.describeDBInstanceAutomatedBackups.mock.calls[0]?.[0] as unknown).toEqual({
      DBInstanceIdentifier: DATABASE_IDENTIFIER,
      MaxRecords: 100,
    });
    expectAbortSignalOption(rds.describeDBInstanceAutomatedBackups.mock.calls[0]?.[1] as unknown);
  });

  test('returns a timestamped hash proof only after cross-vault, exact RDS identity, PITR, and snapshots are clear', async () => {
    const backup = backupApi();
    const rds = rdsApi();
    const verifier = new AwsBackupDeletionVerifier(backup, rds, scope());

    const verification = await verifier.verifyExpired({
      requestId: REQUEST_ID,
      sourceDeletedAt: SOURCE_DELETED_AT,
    });
    expect(verification.outcome).toBe('VERIFIED');
    if (verification.outcome !== 'VERIFIED') throw new Error('verification proof required');
    expect(verification.evidenceCanonicalJson).toContain(
      '"inventoryMethod":"ListRecoveryPointsByResource"',
    );
    expect(verification.evidenceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(verification.sourceDeletedAt).toBe(SOURCE_DELETED_AT);
    expect(verification.verifiedAt).toBe(VERIFIED_AT);
    expect(backup.listRecoveryPointsByResource).toHaveBeenCalledTimes(3);
    for (const [index, ResourceArn] of [DATABASE_ARN, ARTIFACTS_ARN, AUDIT_ARN].entries()) {
      expect(backup.listRecoveryPointsByResource.mock.calls[index]?.[0] as unknown).toEqual({
        ManagedByAWSBackupOnly: false,
        MaxResults: 1_000,
        ResourceArn,
      });
      expectAbortSignalOption(
        backup.listRecoveryPointsByResource.mock.calls[index]?.[1] as unknown,
      );
    }
    for (const [index, SnapshotType] of ['automated', 'manual', 'awsbackup'].entries()) {
      expect(rds.describeDBSnapshots.mock.calls[index]?.[0] as unknown).toEqual({
        DBInstanceIdentifier: DATABASE_IDENTIFIER,
        IncludePublic: false,
        IncludeShared: false,
        MaxRecords: 100,
        SnapshotType,
      });
      expectAbortSignalOption(rds.describeDBSnapshots.mock.calls[index]?.[1] as unknown);
    }
  });

  test('shares one total-deadline abort signal across every Backup and RDS page', async () => {
    const backup = backupApi();
    const rds = rdsApi();

    await new AwsBackupDeletionVerifier(backup, rds, scope()).verifyExpired({
      requestId: REQUEST_ID,
      sourceDeletedAt: SOURCE_DELETED_AT,
    });

    const calls = [
      ...backup.listRecoveryPointsByResource.mock.calls,
      ...rds.describeDBInstances.mock.calls,
      ...rds.describeDBInstanceAutomatedBackups.mock.calls,
      ...rds.describeDBSnapshots.mock.calls,
    ];
    const signals = calls.map(
      (call) => (call[1] as { abortSignal?: unknown } | undefined)?.abortSignal,
    );
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(new Set(signals).size).toBe(1);
  });

  test('keeps backup deletion frozen while a native RDS snapshot can restore pre-deletion data', async () => {
    const rds = rdsApi({
      describeDBSnapshots: vi.fn(({ SnapshotType }: { SnapshotType: string }) =>
        Promise.resolve({
          DBSnapshots:
            SnapshotType === 'manual'
              ? [
                  {
                    DBInstanceIdentifier: DATABASE_IDENTIFIER,
                    DBSnapshotArn: `arn:aws:rds:${REGION}:${ACCOUNT_ID}:snapshot:retained-manual`,
                    OriginalSnapshotCreateTime: new Date(SOURCE_DELETED_AT),
                    SnapshotDatabaseTime: new Date(SOURCE_DELETED_AT),
                    SnapshotCreateTime: new Date(SOURCE_DELETED_AT),
                    SnapshotType: 'manual',
                    Status: 'available',
                  },
                ]
              : [],
        }),
      ),
    });

    await expect(
      new AwsBackupDeletionVerifier(backupApi(), rds, scope()).verifyExpired({
        requestId: REQUEST_ID,
        sourceDeletedAt: SOURCE_DELETED_AT,
      }),
    ).resolves.toEqual({ outcome: 'RECOVERY_POINTS_RETAINED' });
  });

  test('freezes on a post-deletion RDS copy whose immutable original snapshot time contains old data', async () => {
    const rds = rdsApi({
      describeDBSnapshots: vi.fn(({ SnapshotType }: { SnapshotType: string }) =>
        Promise.resolve({
          DBSnapshots:
            SnapshotType === 'manual'
              ? [
                  {
                    DBInstanceIdentifier: DATABASE_IDENTIFIER,
                    DBSnapshotArn: `arn:aws:rds:${REGION}:${ACCOUNT_ID}:snapshot:copied-after-delete`,
                    OriginalSnapshotCreateTime: new Date('2026-05-22T23:59:59.999Z'),
                    SnapshotCreateTime: new Date('2026-06-01T00:00:00.000Z'),
                    SnapshotDatabaseTime: new Date('2026-05-22T23:59:59.999Z'),
                    SnapshotType: 'manual',
                    Status: 'available',
                  },
                ]
              : [],
        }),
      ),
    });

    await expect(
      new AwsBackupDeletionVerifier(backupApi(), rds, scope()).verifyExpired({
        requestId: REQUEST_ID,
        sourceDeletedAt: SOURCE_DELETED_AT,
      }),
    ).resolves.toEqual({ outcome: 'RECOVERY_POINTS_RETAINED' });
  });

  test('allows an ordinary post-deletion snapshot when optional copy timestamps are absent', async () => {
    const rds = rdsApi({
      describeDBSnapshots: vi.fn(({ SnapshotType }: { SnapshotType: string }) =>
        Promise.resolve({
          DBSnapshots:
            SnapshotType === 'manual'
              ? [
                  {
                    DBInstanceIdentifier: DATABASE_IDENTIFIER,
                    DBSnapshotArn: `arn:aws:rds:${REGION}:${ACCOUNT_ID}:snapshot:ordinary-after-delete`,
                    SnapshotCreateTime: new Date('2026-06-01T00:00:00.000Z'),
                    SnapshotType: 'manual',
                    Status: 'available',
                  },
                ]
              : [],
        }),
      ),
    });

    await expect(
      new AwsBackupDeletionVerifier(backupApi(), rds, scope()).verifyExpired({
        requestId: REQUEST_ID,
        sourceDeletedAt: SOURCE_DELETED_AT,
      }),
    ).resolves.toMatchObject({ outcome: 'VERIFIED' });
  });

  test('fails closed when RDS identity or restore-window evidence is missing or outside exact scope', async () => {
    const wrongIdentity = rdsApi({
      describeDBInstances: vi.fn(() =>
        Promise.resolve({
          DBInstances: [dbInstance({ arn: `arn:aws:rds:${REGION}:999999999999:db:wrong` })],
        }),
      ),
    });
    await expect(
      new AwsBackupDeletionVerifier(backupApi(), wrongIdentity, scope()).verifyExpired({
        requestId: REQUEST_ID,
        sourceDeletedAt: SOURCE_DELETED_AT,
      }),
    ).rejects.toThrow('RDS_INSTANCE_SCOPE_INVALID');

    const missingWindow = rdsApi({
      describeDBInstanceAutomatedBackups: vi.fn(() =>
        Promise.resolve({ DBInstanceAutomatedBackups: [automatedBackup({ earliest: undefined })] }),
      ),
    });
    await expect(
      new AwsBackupDeletionVerifier(backupApi(), missingWindow, scope()).verifyExpired({
        requestId: REQUEST_ID,
        sourceDeletedAt: SOURCE_DELETED_AT,
      }),
    ).rejects.toThrow('RDS_RESTORE_WINDOW_INVALID');
  });

  test('fails closed on repeated AWS pagination tokens', async () => {
    const backup = backupApi({
      listRecoveryPointsByResource: vi.fn(() =>
        Promise.resolve({ RecoveryPoints: [], NextToken: 'repeated' }),
      ),
    });

    await expect(
      new AwsBackupDeletionVerifier(backup, rdsApi(), scope()).verifyExpired({
        requestId: REQUEST_ID,
        sourceDeletedAt: SOURCE_DELETED_AT,
      }),
    ).rejects.toThrow('BACKUP_RECOVERY_POINT_PAGINATION_INVALID');
  });
});

function backupApi(overrides: Partial<AwsBackupApi> = {}) {
  return {
    listRecoveryPointsByResource: vi.fn(() => Promise.resolve({ RecoveryPoints: [] })),
    ...overrides,
  } as AwsBackupApi & {
    listRecoveryPointsByResource: ReturnType<typeof vi.fn>;
  };
}

function rdsApi(overrides: Partial<AwsRdsApi> = {}) {
  return {
    describeDBInstances: vi.fn(() => Promise.resolve({ DBInstances: [dbInstance()] })),
    describeDBInstanceAutomatedBackups: vi.fn(() =>
      Promise.resolve({ DBInstanceAutomatedBackups: [automatedBackup()] }),
    ),
    describeDBSnapshots: vi.fn(() => Promise.resolve({ DBSnapshots: [] })),
    ...overrides,
  } as AwsRdsApi & {
    describeDBInstances: ReturnType<typeof vi.fn>;
    describeDBInstanceAutomatedBackups: ReturnType<typeof vi.fn>;
    describeDBSnapshots: ReturnType<typeof vi.fn>;
  };
}

function dbInstance(input: { arn?: string } = {}) {
  return {
    BackupRetentionPeriod: 35,
    DBInstanceArn: input.arn ?? DATABASE_ARN,
    DBInstanceIdentifier: DATABASE_IDENTIFIER,
    DBInstanceStatus: 'available',
    DbiResourceId: DBI_RESOURCE_ID,
    LatestRestorableTime: new Date('2026-07-21T23:55:00.000Z'),
  };
}

function automatedBackup(input: { earliest?: Date | undefined } = {}) {
  return {
    BackupRetentionPeriod: 35,
    DBInstanceArn: DATABASE_ARN,
    DBInstanceIdentifier: DATABASE_IDENTIFIER,
    DbiResourceId: DBI_RESOURCE_ID,
    Region: REGION,
    RestoreWindow: {
      EarliestTime: Object.prototype.hasOwnProperty.call(input, 'earliest')
        ? input.earliest
        : new Date('2026-06-17T00:00:00.001Z'),
      LatestTime: new Date('2026-07-21T23:55:00.000Z'),
    },
    Status: 'active',
  };
}

function expectAbortSignalOption(value: unknown): void {
  if (typeof value !== 'object' || value === null || !('abortSignal' in value)) {
    throw new Error('AWS request abort signal required');
  }
  expect(value.abortSignal).toBeInstanceOf(AbortSignal);
}

function scope() {
  return {
    accountId: ACCOUNT_ID,
    region: REGION,
    backupVaultName: VAULT_NAME,
    databaseArn: DATABASE_ARN,
    databaseIdentifier: DATABASE_IDENTIFIER,
    protectedResourceArns: [DATABASE_ARN, ARTIFACTS_ARN, AUDIT_ARN],
    clock: { now: () => new Date(VERIFIED_AT) },
  };
}
