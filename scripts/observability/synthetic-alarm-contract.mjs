const queueKinds = ['crawl', 'generation', 'publish', 'measurement', 'lifecycle'];
const requiredEvidence = 'REAL_FAULT_CAUSAL_TRACE';
const noReviewedInjector = 'NO_REVIEWED_REAL_FAULT_INJECTOR';
const causalEvidenceMissing = 'CAUSAL_FAULT_EVIDENCE_MISSING';
const approvedInjectors = new Map();

const fixedFaults = [
  ['slo-fast-burn', 'HTTP_SLO_FAST_BURN'],
  ['alb-target-latency', 'HTTP_TARGET_LATENCY'],
  ['alb-target-5xx', 'HTTP_TARGET_5XX'],
  ['budget-warning', 'BUDGET_WARNING'],
  ['budget-blocked', 'BUDGET_HARD_STOP'],
  ['authentication-denied', 'AUTHENTICATION_DENIAL_BURST'],
  ['job-heartbeat-failed', 'JOB_HEARTBEAT_FAILURE'],
  ['provider-failed', 'PROVIDER_TERMINAL_FAILURE'],
  ['publication-failed', 'PUBLICATION_TERMINAL_FAILURE'],
  ['database-connections', 'DATABASE_CONNECTION_PRESSURE'],
  ['database-free-storage', 'DATABASE_STORAGE_PRESSURE'],
  ['rds-backup-jobs-failed', 'RDS_BACKUP_FAILURE'],
  ['s3-backup-jobs-failed', 'S3_BACKUP_FAILURE'],
  ['rds-restore-jobs-failed', 'RDS_RESTORE_FAILURE'],
  ['s3-restore-jobs-failed', 'S3_RESTORE_FAILURE'],
];

export function expectedAlarmNames(environment) {
  if (environment !== 'staging') throw new Error('SYNTHETIC_ALARM_DRILL_STAGING_ONLY');
  const prefix = `aeostudio-${environment}-`;
  return [
    'slo-fast-burn',
    'alb-target-latency',
    'alb-target-5xx',
    'budget-warning',
    'budget-blocked',
    'authentication-denied',
    'job-heartbeat-failed',
    'provider-failed',
    'publication-failed',
    ...queueKinds.map((kind) => `${kind}-queue-age`),
    ...queueKinds.map((kind) => `${kind}-dlq-visible`),
    'database-connections',
    'database-free-storage',
    'rds-backup-jobs-failed',
    's3-backup-jobs-failed',
    'rds-restore-jobs-failed',
    's3-restore-jobs-failed',
  ]
    .map((suffix) => `${prefix}${suffix}`)
    .sort();
}

export function expectedSyntheticFaultMatrix(environment) {
  if (environment !== 'staging') throw new Error('SYNTHETIC_ALARM_DRILL_STAGING_ONLY');
  const prefix = `aeostudio-${environment}-`;
  const entries = [
    ...fixedFaults.map(([suffix, type]) => ({ suffix, type })),
    ...queueKinds.flatMap((queueKind) => [
      { suffix: `${queueKind}-queue-age`, type: `${queueKind.toUpperCase()}_QUEUE_BACKLOG` },
      { suffix: `${queueKind}-dlq-visible`, type: `${queueKind.toUpperCase()}_DLQ_MESSAGE` },
    ]),
  ]
    .map(({ suffix, type }) => {
      const approvedInjector = approvedInjectors.get(type) ?? null;
      return Object.freeze({
        alarmName: `${prefix}${suffix}`,
        alarmConfigurationSha256: null,
        approvedInjector,
        expectedSignal: type === 'BUDGET_HARD_STOP' ? 'BUDGET_BLOCKED' : `SYNTHETIC_${type}`,
        maxCausalLagSeconds: 900,
        notCheckedReason: approvedInjector === null ? noReviewedInjector : causalEvidenceMissing,
        requiredEvidence,
        type,
      });
    })
    .sort((left, right) => left.alarmName.localeCompare(right.alarmName));
  return Object.freeze(entries);
}

export function validateExactAlarmInventory(metricAlarms, environment, accountId) {
  if (!Array.isArray(metricAlarms)) throw new Error('ALARM_INVENTORY_INVALID');
  const expectedNames = expectedAlarmNames(environment);
  const expectedNameSet = new Set(expectedNames);
  const expectedAction = `arn:aws:sns:ap-southeast-1:${accountId}:aeostudio-${environment}-operations`;
  const alarmsByName = new Map();
  for (const alarm of metricAlarms) {
    if (typeof alarm?.AlarmName !== 'string' || alarmsByName.has(alarm.AlarmName)) {
      throw new Error('ALARM_INVENTORY_INVALID');
    }
    alarmsByName.set(alarm.AlarmName, alarm);
  }
  const missing = expectedNames.filter((name) => !alarmsByName.has(name));
  const unexpected = [...alarmsByName.keys()].filter((name) => !expectedNameSet.has(name));
  if (missing.length > 0) throw new Error(`ALARM_INVENTORY_MISSING:${missing.join(',')}`);
  if (unexpected.length > 0) {
    throw new Error(`ALARM_INVENTORY_UNEXPECTED:${unexpected.sort().join(',')}`);
  }
  for (const name of expectedNames) {
    const alarm = alarmsByName.get(name);
    if (alarm.StateValue !== 'OK') throw new Error(`ALARM_NOT_HEALTHY:${name}`);
    if (alarm.ActionsEnabled !== true) throw new Error(`ALARM_ACTIONS_DISABLED:${name}`);
    if (
      !Array.isArray(alarm.AlarmActions) ||
      alarm.AlarmActions.length !== 1 ||
      alarm.AlarmActions[0] !== expectedAction
    ) {
      throw new Error(`ALARM_ACTIONS_INVALID:${name}`);
    }
  }
  return expectedNames;
}
