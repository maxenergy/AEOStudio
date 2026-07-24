/* global console, process */

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  expectedSyntheticFaultMatrix,
  validateExactAlarmInventory,
} from './synthetic-alarm-contract.mjs';

const environment = process.env.AEO_ENVIRONMENT ?? '';
const region = process.env.AWS_REGION ?? '';
const expectedAccountId = process.env.AEO_EXPECTED_ACCOUNT_ID ?? '';
const approved = process.env.AEO_SYNTHETIC_FAULT_APPROVED ?? '';
const drillId = process.env.AEO_SYNTHETIC_DRILL_ID ?? '';
const evidencePath = resolve(
  process.env.AEO_SYNTHETIC_ALARM_EVIDENCE_PATH ??
    `output/synthetic-fault-evidence-${drillId || 'missing-id'}.json`,
);

if (environment !== 'staging') throw new Error('SYNTHETIC_ALARM_DRILL_STAGING_ONLY');
if (region !== 'ap-southeast-1') throw new Error('SYNTHETIC_ALARM_DRILL_REGION_MISMATCH');
if (!/^[0-9]{12}$/u.test(expectedAccountId)) throw new Error('EXPECTED_ACCOUNT_ID_REQUIRED');
if (approved !== 'true') throw new Error('AEO_SYNTHETIC_FAULT_APPROVED_REQUIRED');
if (!/^[a-z0-9][a-z0-9-]{5,79}$/u.test(drillId)) throw new Error('INVALID_SYNTHETIC_DRILL_ID');

const startedAt = new Date();
const identity = awsJson(['sts', 'get-caller-identity']);
if (identity.Account !== expectedAccountId) throw new Error('AWS_ACCOUNT_MISMATCH');

const described = awsJson([
  'cloudwatch',
  'describe-alarms',
  '--alarm-name-prefix',
  `aeostudio-${environment}-`,
]);
validateExactAlarmInventory(described.MetricAlarms, environment, expectedAccountId);

const matrix = expectedSyntheticFaultMatrix(environment);
const evidence = {
  schemaVersion: 'aeostudio.synthetic-fault-evidence.v2',
  matrixVersion: 'aeostudio.synthetic-fault-matrix.v1',
  outcome: 'NOT_CHECKED',
  environment,
  region,
  accountId: expectedAccountId,
  drillId,
  startedAt: startedAt.toISOString(),
  completedAt: new Date().toISOString(),
  faults: matrix.map((entry) => ({
    alarmName: entry.alarmName,
    type: entry.type,
    status: 'NOT_CHECKED',
    reasonCode: entry.notCheckedReason,
  })),
};
await mkdir(dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
});
console.log(
  JSON.stringify({
    outcome: 'NOT_CHECKED',
    evidencePath,
    reason: 'SYNTHETIC_FAULT_CAUSAL_EVIDENCE_REQUIRED',
    faults: matrix.length,
  }),
);

function awsJson(args) {
  return JSON.parse(
    execFileSync('aws', [...args, '--region', region, '--no-cli-pager', '--output', 'json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }),
  );
}
