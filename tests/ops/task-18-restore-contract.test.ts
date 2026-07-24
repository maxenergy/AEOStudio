import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

// @ts-expect-error The production helper is a native ESM JavaScript module.
import * as untypedRestoreContract from '../../scripts/recovery/restore-contract.mjs';

interface RestoreContract {
  loadApprovedDatabaseCredentials: (input: {
    credentialSecretArn: string;
    region: string;
    readSecretValue: (secretArn: string) => Promise<{ SecretString?: string } | null | undefined>;
  }) => Promise<{ username: string; password: string }>;
  selectRdsRestoreWindow: (instance: {
    EarliestRestorableTime?: Date | string;
    LatestRestorableTime?: Date | string;
  }) => {
    earliestRestorableTime: Date;
    latestRestorableTime: Date;
    selectedRestoreTime: Date;
  };
}

const { loadApprovedDatabaseCredentials, selectRdsRestoreWindow } =
  untypedRestoreContract as unknown as RestoreContract;

describe('Task 18 restore contract', () => {
  test('selects and preserves an auditable RDS restore time strictly inside the available window', () => {
    const window = selectRdsRestoreWindow({
      EarliestRestorableTime: '2026-07-23T09:00:00.000Z',
      LatestRestorableTime: '2026-07-23T09:10:00.000Z',
    });

    expect(window.earliestRestorableTime.toISOString()).toBe('2026-07-23T09:00:00.000Z');
    expect(window.latestRestorableTime.toISOString()).toBe('2026-07-23T09:10:00.000Z');
    expect(window.selectedRestoreTime.toISOString()).toBe('2026-07-23T09:09:59.000Z');
    expect(window.selectedRestoreTime.getTime()).toBeLessThan(
      window.latestRestorableTime.getTime(),
    );
    expect(window.selectedRestoreTime.getTime()).toBeGreaterThanOrEqual(
      window.earliestRestorableTime.getTime(),
    );
  });

  test('passes the selected RDS recovery point to AWS and preserves selected and latest audit values', async () => {
    const recovery = await readFile(
      join(process.cwd(), 'scripts', 'recovery', 'run-restore-drill.mjs'),
      'utf8',
    );

    expect(recovery).toContain('selectRdsRestoreWindow');
    expect(recovery).toMatch(/RestoreTime:\s*restoreWindow\.selectedRestoreTime/u);
    expect(recovery).toContain(
      'selectedRestoreTime: rds.restoreWindow.selectedRestoreTime.toISOString()',
    );
    expect(recovery).toContain(
      'latestRestorableTime: rds.restoreWindow.latestRestorableTime.toISOString()',
    );
    expect(recovery).toContain(
      "const parameterGroupName = required(environment, 'AEO_RESTORE_DB_PARAMETER_GROUP')",
    );
    expect(recovery).toContain('DBParameterGroupName: parameterGroupName');
    expect(recovery).toContain("flag: 'wx'");
    expect(recovery).not.toMatch(
      /new Date\(source\?\.DBInstances\?\.\[0\]\?\.LatestRestorableTime/u,
    );
  });

  test('loads database credentials only from an explicit approved secret ARN without accepting its host', async () => {
    const approvedArn =
      'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:staging/restore-drill-AbCdEf';
    let requestedArn: string | undefined;

    const credentials = await loadApprovedDatabaseCredentials({
      credentialSecretArn: approvedArn,
      region: 'ap-southeast-1',
      readSecretValue: (secretArn: string) => {
        requestedArn = secretArn;
        return Promise.resolve({
          SecretString: JSON.stringify({
            username: 'restore_operator',
            password: 'test-only-password',
            host: 'source-database.example.invalid',
          }),
        });
      },
    });

    expect(requestedArn).toBe(approvedArn);
    expect(credentials).toEqual({
      username: 'restore_operator',
      password: 'test-only-password',
    });
  });

  test('connects the restored private endpoint with approved credentials without projecting secrets into evidence', async () => {
    const [recovery, runbook] = await Promise.all([
      readFile(join(process.cwd(), 'scripts', 'recovery', 'run-restore-drill.mjs'), 'utf8'),
      readFile(join(process.cwd(), 'scripts', 'recovery', 'README.md'), 'utf8'),
    ]);
    const evidenceProjection = recovery.split('Object.assign(evidence, {')[1] ?? '';

    expect(recovery).toContain(
      "credentialSecretArn: required(environment, 'AEO_RESTORE_DB_CREDENTIAL_SECRET_ARN')",
    );
    expect(recovery).toContain('loadApprovedDatabaseCredentials');
    expect(recovery).not.toContain('MasterUserSecret');
    expect(recovery).toContain('const host = rds.instance?.Endpoint?.Address');
    expect(recovery).toContain('user: credentials.username');
    expect(recovery).toContain('password: credentials.password');
    expect(evidenceProjection).not.toMatch(/credential|password|secret/iu);
    expect(runbook).toContain('AEO_RESTORE_DB_CREDENTIAL_SECRET_ARN');
    expect(runbook).toContain('AEO_RESTORE_DB_PARAMETER_GROUP');
    expect(runbook).toMatch(/approved|批准/iu);
    expect(runbook).toMatch(/never written|不会写入/iu);
  });
});
