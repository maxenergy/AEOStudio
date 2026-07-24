import { createHash } from 'node:crypto';

import type {
  BackupDeletionVerification,
  BackupDeletionVerifier,
} from '@aeostudio/application/privacy-audit';

export interface AwsBackupRecoveryPointByResource {
  BackupVaultName?: string | undefined;
  CreationDate?: Date | undefined;
  RecoveryPointArn?: string | undefined;
  Status?: string | undefined;
}

export interface AwsBackupApi {
  listRecoveryPointsByResource(
    input: {
      ResourceArn: string;
      ManagedByAWSBackupOnly: false;
      MaxResults: number;
      NextToken?: string;
    },
    options: AwsRemoteCallOptions,
  ): Promise<{
    RecoveryPoints?: AwsBackupRecoveryPointByResource[] | undefined;
    NextToken?: string | undefined;
  }>;
}

export interface AwsRdsInstance {
  BackupRetentionPeriod?: number | undefined;
  DBInstanceArn?: string | undefined;
  DBInstanceIdentifier?: string | undefined;
  DBInstanceStatus?: string | undefined;
  DbiResourceId?: string | undefined;
  LatestRestorableTime?: Date | undefined;
}

export interface AwsRdsAutomatedBackup {
  BackupRetentionPeriod?: number | undefined;
  DBInstanceArn?: string | undefined;
  DBInstanceIdentifier?: string | undefined;
  DbiResourceId?: string | undefined;
  Region?: string | undefined;
  RestoreWindow?:
    | {
        EarliestTime?: Date | undefined;
        LatestTime?: Date | undefined;
      }
    | undefined;
  Status?: string | undefined;
}

export interface AwsRdsApi {
  describeDBInstances(
    input: {
      DBInstanceIdentifier: string;
      MaxRecords: number;
      Marker?: string;
    },
    options: AwsRemoteCallOptions,
  ): Promise<{
    DBInstances?: AwsRdsInstance[] | undefined;
    Marker?: string | undefined;
  }>;
  describeDBInstanceAutomatedBackups(
    input: {
      DBInstanceIdentifier: string;
      MaxRecords: number;
      Marker?: string;
    },
    options: AwsRemoteCallOptions,
  ): Promise<{
    DBInstanceAutomatedBackups?: AwsRdsAutomatedBackup[] | undefined;
    Marker?: string | undefined;
  }>;
  describeDBSnapshots(
    input: {
      DBInstanceIdentifier: string;
      IncludePublic: false;
      IncludeShared: false;
      MaxRecords: number;
      SnapshotType: 'automated' | 'manual' | 'awsbackup';
      Marker?: string;
    },
    options: AwsRemoteCallOptions,
  ): Promise<{
    DBSnapshots?: AwsRdsSnapshot[] | undefined;
    Marker?: string | undefined;
  }>;
}

export interface AwsRemoteCallOptions {
  abortSignal: AbortSignal;
}

export interface AwsRdsSnapshot {
  DBInstanceIdentifier?: string | undefined;
  DBSnapshotArn?: string | undefined;
  OriginalSnapshotCreateTime?: Date | undefined;
  SnapshotDatabaseTime?: Date | undefined;
  SnapshotCreateTime?: Date | undefined;
  SnapshotType?: string | undefined;
  Status?: string | undefined;
}

export interface AwsBackupDeletionVerifierScope {
  accountId: string;
  region: string;
  backupVaultName: string;
  databaseArn: string;
  databaseIdentifier: string;
  protectedResourceArns: readonly string[];
  clock: { now(): Date };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RDS_RESOURCE_ID = /^db-[A-Z0-9]{2,}$/u;
const MAX_CONTINUOUS_RECOVERY_DAYS = 35;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const USABLE_CONTINUOUS_STATUSES = new Set(['AVAILABLE', 'COMPLETED', 'STOPPED']);
const REMOTE_EFFECT_TOTAL_DEADLINE_MS = 30_000;

export class AwsBackupDeletionVerifier implements BackupDeletionVerifier {
  public constructor(
    private readonly backup: AwsBackupApi,
    private readonly rds: AwsRdsApi,
    private readonly scope: AwsBackupDeletionVerifierScope,
  ) {
    if (scope.region !== 'ap-southeast-1') throw new Error('AWS_SINGAPORE_REGION_REQUIRED');
    if (!/^\d{12}$/u.test(scope.accountId)) throw new Error('INVALID_AWS_ACCOUNT_ID');
    if (!/^[A-Za-z0-9_-]{2,50}$/u.test(scope.backupVaultName)) {
      throw new Error('INVALID_BACKUP_VAULT_NAME');
    }
    if (!/^[a-z][a-z0-9-]{0,62}$/u.test(scope.databaseIdentifier)) {
      throw new Error('INVALID_RDS_INSTANCE_IDENTIFIER');
    }
    const expectedDatabaseArn = `arn:aws:rds:${scope.region}:${scope.accountId}:db:${scope.databaseIdentifier}`;
    if (scope.databaseArn !== expectedDatabaseArn) throw new Error('RDS_INSTANCE_SCOPE_INVALID');
    const resources = [...scope.protectedResourceArns];
    const s3Resources = resources.filter((resource) =>
      /^arn:aws:s3:::[a-z0-9.-]{3,63}$/u.test(resource),
    );
    if (
      resources.length !== 3 ||
      new Set(resources).size !== resources.length ||
      !resources.includes(expectedDatabaseArn) ||
      s3Resources.length !== 2
    ) {
      throw new Error('BACKUP_PROTECTED_RESOURCE_SCOPE_INVALID');
    }
  }

  public async verifyExpired(input: {
    requestId: string;
    sourceDeletedAt: string;
  }): Promise<BackupDeletionVerification> {
    if (!UUID.test(input.requestId)) throw new Error('INVALID_DELETION_REQUEST_ID');
    const sourceDeletedAt = readInstant(input.sourceDeletedAt, 'SOURCE_DELETED_AT');
    const remote = { abortSignal: AbortSignal.timeout(REMOTE_EFFECT_TOTAL_DEADLINE_MS) };
    const backupObservations: Array<Record<string, string>> = [];
    const continuousObservations: Array<Record<string, string>> = [];

    for (const resourceArn of this.scope.protectedResourceArns) {
      let nextToken: string | undefined;
      const visitedTokens = new Set<string>();
      do {
        const response = await this.backup.listRecoveryPointsByResource(
          {
            ResourceArn: resourceArn,
            ManagedByAWSBackupOnly: false,
            MaxResults: 1_000,
            ...(nextToken === undefined ? {} : { NextToken: nextToken }),
          },
          remote,
        );
        for (const point of response.RecoveryPoints ?? []) {
          const recoveryPointArn = readRecoveryPointArn(point.RecoveryPointArn, this.scope);
          const creationDate = readDate(point.CreationDate, 'BACKUP_RECOVERY_POINT_CREATION_DATE');
          const status = readNonEmpty(point.Status, 'RECOVERY_POINT_STATUS');
          const observation = {
            creationDate: creationDate.toISOString(),
            recoveryPointArn,
            resourceArn,
            status,
          };
          if (isContinuousRecoveryPoint(recoveryPointArn)) {
            if (!USABLE_CONTINUOUS_STATUSES.has(status)) {
              return { outcome: 'RECOVERY_POINTS_RETAINED' };
            }
            continuousObservations.push(observation);
          } else {
            if (creationDate.getTime() <= sourceDeletedAt.getTime()) {
              return { outcome: 'RECOVERY_POINTS_RETAINED' };
            }
            backupObservations.push(observation);
          }
        }
        nextToken = readPaginationToken(response.NextToken, visitedTokens, 'BACKUP_RECOVERY_POINT');
      } while (nextToken !== undefined);
    }

    const instance = await this.readExactDatabaseInstance(remote);
    const automatedBackup = await this.readExactAutomatedBackup(instance, remote);
    const earliestRestorableTime = readDate(
      automatedBackup.RestoreWindow?.EarliestTime,
      'RDS_RESTORE_WINDOW',
    );
    const latestRestorableTime = readDate(
      automatedBackup.RestoreWindow?.LatestTime,
      'RDS_RESTORE_WINDOW',
    );
    if (latestRestorableTime.getTime() < earliestRestorableTime.getTime()) {
      throw new Error('RDS_RESTORE_WINDOW_INVALID');
    }
    if (earliestRestorableTime.getTime() <= sourceDeletedAt.getTime()) {
      return { outcome: 'RECOVERY_POINTS_RETAINED' };
    }

    const snapshotObservations = await this.readNativeSnapshots(sourceDeletedAt, remote);
    if (snapshotObservations === undefined) return { outcome: 'RECOVERY_POINTS_RETAINED' };

    const verifiedAt = readDate(this.scope.clock.now(), 'BACKUP_VERIFICATION_TIME');
    if (verifiedAt.getTime() < sourceDeletedAt.getTime()) {
      throw new Error('BACKUP_VERIFICATION_PRECEDES_SOURCE_DELETION');
    }
    const earliestPossibleContinuousRestore = new Date(
      verifiedAt.getTime() - MAX_CONTINUOUS_RECOVERY_DAYS * MILLISECONDS_PER_DAY,
    );
    if (
      continuousObservations.length > 0 &&
      earliestPossibleContinuousRestore.getTime() <= sourceDeletedAt.getTime()
    ) {
      return { outcome: 'RECOVERY_POINTS_RETAINED' };
    }

    const configuredVaultArn = `arn:aws:backup:${this.scope.region}:${this.scope.accountId}:backup-vault:${this.scope.backupVaultName}`;
    const proof = {
      accountId: this.scope.accountId,
      awsBackupCrossVaultInventory: backupObservations.sort(compareCanonicalRecords),
      awsBackupContinuousInventory: continuousObservations.sort(compareCanonicalRecords),
      configuredBackupVaultArn: configuredVaultArn,
      configuredBackupVaultName: this.scope.backupVaultName,
      continuousRecoveryMaximumDays: MAX_CONTINUOUS_RECOVERY_DAYS,
      databaseArn: this.scope.databaseArn,
      databaseIdentifier: this.scope.databaseIdentifier,
      protectedResourceArns: [...this.scope.protectedResourceArns].sort(),
      inventoryMethod: 'ListRecoveryPointsByResource',
      managedByAWSBackupOnly: false,
      rdsAutomatedBackup: {
        dbiResourceId: readNonEmpty(automatedBackup.DbiResourceId, 'RDS_DBI_RESOURCE_ID'),
        earliestRestorableTime: earliestRestorableTime.toISOString(),
        latestRestorableTime: latestRestorableTime.toISOString(),
        status: readNonEmpty(automatedBackup.Status, 'RDS_AUTOMATED_BACKUP_STATUS'),
      },
      rdsSnapshots: snapshotObservations.sort(compareCanonicalRecords),
      region: this.scope.region,
      requestId: input.requestId.toLowerCase(),
      schemaVersion: '2.0.0',
      sourceDeletedAt: sourceDeletedAt.toISOString(),
      verifiedAt: verifiedAt.toISOString(),
    };
    const evidenceCanonicalJson = canonicalJson(proof);
    if (evidenceCanonicalJson.length > 1_048_576) {
      throw new Error('BACKUP_VERIFICATION_EVIDENCE_TOO_LARGE');
    }
    return {
      outcome: 'VERIFIED',
      evidenceCanonicalJson,
      evidenceHash: createHash('sha256').update(evidenceCanonicalJson).digest('hex'),
      sourceDeletedAt: sourceDeletedAt.toISOString(),
      verifiedAt: verifiedAt.toISOString(),
    };
  }

  private async readExactDatabaseInstance(remote: AwsRemoteCallOptions): Promise<AwsRdsInstance> {
    const response = await this.rds.describeDBInstances(
      {
        DBInstanceIdentifier: this.scope.databaseIdentifier,
        MaxRecords: 100,
      },
      remote,
    );
    if (response.Marker !== undefined || response.DBInstances?.length !== 1) {
      throw new Error('RDS_INSTANCE_SCOPE_INVALID');
    }
    const instance = response.DBInstances[0];
    if (
      instance === undefined ||
      instance.DBInstanceIdentifier !== this.scope.databaseIdentifier ||
      instance.DBInstanceArn !== this.scope.databaseArn ||
      !RDS_RESOURCE_ID.test(instance.DbiResourceId ?? '') ||
      instance.DBInstanceStatus !== 'available' ||
      !isContinuousRetention(instance.BackupRetentionPeriod)
    ) {
      throw new Error('RDS_INSTANCE_SCOPE_INVALID');
    }
    readDate(instance.LatestRestorableTime, 'RDS_LATEST_RESTORABLE_TIME');
    return instance;
  }

  private async readExactAutomatedBackup(
    instance: AwsRdsInstance,
    remote: AwsRemoteCallOptions,
  ): Promise<AwsRdsAutomatedBackup> {
    const observations: AwsRdsAutomatedBackup[] = [];
    let marker: string | undefined;
    const visitedMarkers = new Set<string>();
    do {
      const response = await this.rds.describeDBInstanceAutomatedBackups(
        {
          DBInstanceIdentifier: this.scope.databaseIdentifier,
          MaxRecords: 100,
          ...(marker === undefined ? {} : { Marker: marker }),
        },
        remote,
      );
      observations.push(...(response.DBInstanceAutomatedBackups ?? []));
      marker = readPaginationToken(response.Marker, visitedMarkers, 'RDS_AUTOMATED_BACKUP');
    } while (marker !== undefined);

    if (observations.length !== 1) throw new Error('RDS_AUTOMATED_BACKUP_SCOPE_INVALID');
    const automatedBackup = observations[0];
    if (
      automatedBackup === undefined ||
      automatedBackup.DBInstanceIdentifier !== this.scope.databaseIdentifier ||
      automatedBackup.DBInstanceArn !== this.scope.databaseArn ||
      automatedBackup.DbiResourceId !== instance.DbiResourceId ||
      automatedBackup.Region !== this.scope.region ||
      automatedBackup.Status !== 'active' ||
      !isContinuousRetention(automatedBackup.BackupRetentionPeriod)
    ) {
      throw new Error('RDS_AUTOMATED_BACKUP_SCOPE_INVALID');
    }
    return automatedBackup;
  }

  private async readNativeSnapshots(
    sourceDeletedAt: Date,
    remote: AwsRemoteCallOptions,
  ): Promise<Array<Record<string, string>> | undefined> {
    const observations: Array<Record<string, string>> = [];
    for (const snapshotType of ['automated', 'manual', 'awsbackup'] as const) {
      let marker: string | undefined;
      const visitedMarkers = new Set<string>();
      do {
        const response = await this.rds.describeDBSnapshots(
          {
            DBInstanceIdentifier: this.scope.databaseIdentifier,
            IncludePublic: false,
            IncludeShared: false,
            MaxRecords: 100,
            SnapshotType: snapshotType,
            ...(marker === undefined ? {} : { Marker: marker }),
          },
          remote,
        );
        for (const snapshot of response.DBSnapshots ?? []) {
          const snapshotArn = snapshot.DBSnapshotArn;
          const expectedSnapshotArnPrefix = `arn:aws:rds:${this.scope.region}:${this.scope.accountId}:snapshot:`;
          const snapshotCreateTime = readDate(
            snapshot.SnapshotCreateTime,
            'RDS_SNAPSHOT_CREATE_TIME',
          );
          const originalSnapshotCreateTime = readOptionalDate(
            snapshot.OriginalSnapshotCreateTime,
            'RDS_ORIGINAL_SNAPSHOT_CREATE_TIME',
          );
          const snapshotDatabaseTime = readOptionalDate(
            snapshot.SnapshotDatabaseTime,
            'RDS_SNAPSHOT_DATABASE_TIME',
          );
          if (
            snapshot.DBInstanceIdentifier !== this.scope.databaseIdentifier ||
            snapshotArn === undefined ||
            !snapshotArn.startsWith(expectedSnapshotArnPrefix) ||
            snapshotArn.length === expectedSnapshotArnPrefix.length ||
            snapshot.SnapshotType !== snapshotType
          ) {
            throw new Error('RDS_SNAPSHOT_SCOPE_INVALID');
          }
          if (
            snapshotCreateTime.getTime() <= sourceDeletedAt.getTime() ||
            (originalSnapshotCreateTime !== undefined &&
              originalSnapshotCreateTime.getTime() <= sourceDeletedAt.getTime()) ||
            (snapshotDatabaseTime !== undefined &&
              snapshotDatabaseTime.getTime() <= sourceDeletedAt.getTime())
          ) {
            return undefined;
          }
          observations.push({
            createdAt: snapshotCreateTime.toISOString(),
            ...(snapshotDatabaseTime === undefined
              ? {}
              : { databaseAt: snapshotDatabaseTime.toISOString() }),
            ...(originalSnapshotCreateTime === undefined
              ? {}
              : { originalCreatedAt: originalSnapshotCreateTime.toISOString() }),
            snapshotArn,
            snapshotType,
            status: readNonEmpty(snapshot.Status, 'RDS_SNAPSHOT_STATUS'),
          });
        }
        marker = readPaginationToken(response.Marker, visitedMarkers, 'RDS_SNAPSHOT');
      } while (marker !== undefined);
    }
    return observations;
  }
}

function readInstant(value: string, label: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`INVALID_${label}`);
  }
  return parsed;
}

function readDate(value: Date | undefined, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label}_INVALID`);
  }
  return value;
}

function readOptionalDate(value: Date | undefined, label: string): Date | undefined {
  return value === undefined ? undefined : readDate(value, label);
}

function readNonEmpty(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${label}_REQUIRED`);
  return value;
}

function readRecoveryPointArn(
  value: string | undefined,
  scope: AwsBackupDeletionVerifierScope,
): string {
  const recoveryPointArn = readNonEmpty(value, 'RECOVERY_POINT_ARN');
  const prefixes = [
    `arn:aws:backup:${scope.region}:${scope.accountId}:recovery-point:`,
    `arn:aws:rds:${scope.region}:${scope.accountId}:snapshot:`,
  ];
  if (
    !prefixes.some(
      (prefix) => recoveryPointArn.startsWith(prefix) && recoveryPointArn.length > prefix.length,
    )
  ) {
    throw new Error('BACKUP_RECOVERY_POINT_SCOPE_INVALID');
  }
  return recoveryPointArn;
}

function isContinuousRecoveryPoint(recoveryPointArn: string): boolean {
  return /:recovery-point:continuous(?::|$)/u.test(recoveryPointArn);
}

function isContinuousRetention(value: number | undefined): boolean {
  return value === MAX_CONTINUOUS_RECOVERY_DAYS;
}

function readPaginationToken(
  value: string | undefined,
  visited: Set<string>,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || visited.has(value)) throw new Error(`${label}_PAGINATION_INVALID`);
  visited.add(value);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function compareCanonicalRecords(
  left: Record<string, string>,
  right: Record<string, string>,
): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}
