import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  expectedAlarmNames,
  expectedSyntheticFaultMatrix,
  validateExactAlarmInventory,
} from '../../scripts/observability/synthetic-alarm-contract.mjs';

const root = process.cwd();

async function source(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8');
}

describe('Task 18 synthetic alarm drill safety', () => {
  test('freezes one causal REAL_FAULT contract for every exact alarm', () => {
    const matrix = expectedSyntheticFaultMatrix('staging');

    expect(matrix.map((entry) => entry.alarmName)).toEqual(expectedAlarmNames('staging'));
    expect(new Set(matrix.map((entry) => entry.type)).size).toBe(25);
    expect(matrix.every((entry) => entry.requiredEvidence === 'REAL_FAULT_CAUSAL_TRACE')).toBe(
      true,
    );
    expect(matrix.every((entry) => entry.approvedInjector === null)).toBe(true);
    expect(matrix.every((entry) => entry.alarmConfigurationSha256 === null)).toBe(true);
  });

  test('validates all 25 exact alarms, their healthy state and the single Singapore action', () => {
    const accountId = '123456789012';
    const names = expectedAlarmNames('staging');
    const alarms = names.map((AlarmName) => ({
      ActionsEnabled: true,
      AlarmActions: [`arn:aws:sns:ap-southeast-1:${accountId}:aeostudio-staging-operations`],
      AlarmName,
      StateValue: 'OK',
    }));

    expect(names).toHaveLength(25);
    expect(validateExactAlarmInventory(alarms, 'staging', accountId)).toEqual(names);
    expect(() => validateExactAlarmInventory(alarms.slice(1), 'staging', accountId)).toThrow(
      'ALARM_INVENTORY_MISSING',
    );
    expect(() =>
      validateExactAlarmInventory(
        [...alarms, { ...alarms[0], AlarmName: 'aeostudio-staging-unexpected' }],
        'staging',
        accountId,
      ),
    ).toThrow('ALARM_INVENTORY_UNEXPECTED');
    expect(() =>
      validateExactAlarmInventory(
        alarms.map((alarm, index) => (index === 0 ? { ...alarm, StateValue: 'ALARM' } : alarm)),
        'staging',
        accountId,
      ),
    ).toThrow('ALARM_NOT_HEALTHY');
  });

  test('removes the obsolete alarm-state ownership contract', async () => {
    const contract = await source('scripts/observability/synthetic-alarm-contract.mjs');

    expect(contract).not.toContain('isOwnedSyntheticAlarmState');
  });

  test('requires the exact frozen alarm inventory rather than substring family matches', async () => {
    const drill = await source('scripts/observability/run-synthetic-alarm-drill.mjs');

    expect(drill).toContain("from './synthetic-alarm-contract.mjs'");
    expect(drill).toContain('validateExactAlarmInventory');
    expect(drill).not.toContain('name.includes(family)');
  });

  test('never uses SetAlarmState as synthetic fault evidence', async () => {
    const drill = await source('scripts/observability/run-synthetic-alarm-drill.mjs');

    expect(drill).not.toContain('set-alarm-state');
    expect(drill).not.toContain('SetAlarmState');
  });

  test('defines the precise 500ms p95 and both RDS and S3 backup failure alarms', async () => {
    const observability = await source('infra/modules/platform/observability.tf');
    const latency =
      observability.split('resource "aws_cloudwatch_metric_alarm" "alb_latency"')[1] ?? '';
    const backup =
      observability.split('resource "aws_cloudwatch_metric_alarm" "backup_failures"')[1] ?? '';

    expect(latency).toMatch(/threshold\s*=\s*0\.5/u);
    expect(backup).toContain('for_each = toset(["RDS", "S3"])');
    expect(backup).toContain('${lower(each.value)}-backup-jobs-failed');
    expect(backup).toContain('dimensions = { ResourceType = each.value }');
  });
});
