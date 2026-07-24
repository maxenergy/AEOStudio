/* global process */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadRunIdentityFromEnvironment,
  REQUIRED_LOAD_THRESHOLD_METRICS,
} from './task-18-load-contract.mjs';
import { validateAcceptedJobsEvidence } from './accepted-job-evidence.mjs';
import { validateActiveJobsEvidence } from './active-job-evidence.mjs';

const LOAD_METRIC_GATES = Object.freeze({
  aeo_read_ms: { value: 'p(95)', passes: (metric) => metric <= 500 },
  aeo_write_ms: { value: 'p(95)', passes: (metric) => metric <= 1_000 },
  aeo_job_ack_ms: { value: 'p(95)', passes: (metric) => metric <= 2_000 },
  aeo_queue_start_ms: { value: 'p(95)', passes: (metric) => metric <= 30_000 },
  aeo_errors: { value: 'rate', passes: (metric) => metric >= 0 && metric < 0.01 },
  aeo_tenant_isolation_failures: { value: 'count', passes: (metric) => metric === 0 },
  aeo_budget_probe_attempts: { value: 'count', passes: (metric) => metric === 10 },
  aeo_budget_probe_blocked: { value: 'count', passes: (metric) => metric === 10 },
  aeo_budget_probe_failures: { value: 'count', passes: (metric) => metric === 0 },
  aeo_budget_probe_success: { value: 'rate', passes: (metric) => metric === 1 },
  aeo_jobs_accepted: { value: 'count', passes: (metric) => metric === 50 },
  aeo_distinct_jobs_accepted: { value: 'count', passes: (metric) => metric === 50 },
  aeo_job_submission_failures: { value: 'count', passes: (metric) => metric === 0 },
  aeo_job_poll_failures: { value: 'count', passes: (metric) => metric === 0 },
  aeo_jobs_observed_started: { value: 'count', passes: (metric) => metric === 50 },
  aeo_max_active_global: { value: 'max', passes: (metric) => metric >= 50 },
  aeo_max_active_tenant: { value: 'max', passes: (metric) => metric <= 5 },
});

export async function finalizeTask18LoadEvidence(input) {
  const environment = input.environment;
  const rawSummaryPath = resolve(
    environment.AEO_LOAD_RAW_SUMMARY_PATH ?? 'output/task-18-load-raw-summary.json',
  );
  const evidencePath = resolve(
    environment.AEO_LOAD_EVIDENCE_PATH ?? 'output/task-18-load-evidence.json',
  );
  if (rawSummaryPath === evidencePath) throw new Error('AEO_LOAD_EVIDENCE_PATH_MUST_DIFFER');

  const expectedIdentity = loadRunIdentityFromEnvironment(environment);
  const raw = parseObject(await readFile(rawSummaryPath, 'utf8'), 'LOAD_RAW_SUMMARY_INVALID');
  if (raw.schemaVersion !== 'aeostudio.load-raw-summary.v2') {
    throw new Error('LOAD_RAW_SUMMARY_SCHEMA_INVALID');
  }
  if (!sameJson(raw.runIdentity, expectedIdentity)) {
    throw new Error('LOAD_RAW_SUMMARY_IDENTITY_MISMATCH');
  }
  const gate = passingGate(raw.gate);

  const acceptedJobs = validateAcceptedJobsEvidence(raw.acceptedJobs);
  const evidence = {
    schemaVersion: 'aeostudio.load-evidence.v2',
    runIdentity: expectedIdentity,
    completedAt: timestamp(raw.completedAt, 'LOAD_RAW_SUMMARY_COMPLETED_AT_INVALID'),
    finalizedAt: (input.now ?? (() => new Date()))().toISOString(),
    profile: loadProfile(raw.profile),
    gate,
    acceptedJobs,
    activeJobs: validateActiveJobsEvidence(raw.activeJobs, acceptedJobs.ids),
    metrics: loadMetrics(raw.metrics),
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return { outcome: 'PASS', evidencePath };
}

function passingGate(value) {
  const gate = object(value, 'LOAD_RAW_SUMMARY_GATE_INVALID');
  if (gate.outcome !== 'PASS') throw new Error('LOAD_THRESHOLDS_FAILED');
  if (!Array.isArray(gate.failedThresholds) || gate.failedThresholds.length !== 0) {
    throw new Error('LOAD_THRESHOLDS_FAILED');
  }
  const thresholds = object(gate.thresholds, 'LOAD_RAW_SUMMARY_THRESHOLDS_INVALID');
  for (const metric of REQUIRED_LOAD_THRESHOLD_METRICS) {
    if (thresholds[metric] !== true) throw new Error(`LOAD_THRESHOLD_NOT_PASSED:${metric}`);
  }
  return {
    outcome: 'PASS',
    failedThresholds: [],
    thresholds: Object.fromEntries(REQUIRED_LOAD_THRESHOLD_METRICS.map((metric) => [metric, true])),
  };
}

function loadProfile(value) {
  const profile = object(value, 'LOAD_RAW_SUMMARY_PROFILE_INVALID');
  const expected = {
    distinctSessions: 100,
    concurrentJobSubmissions: 50,
    jobsPerTenant: 5,
    budgetProbes: 10,
    requiredObservedStartedJobs: 50,
    requiredMaxActiveGlobal: 50,
    maximumActiveJobsPerTenant: 5,
    processingObservationDefinition:
      'same completed polling round; RUNNING only; terminal states excluded',
  };
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (profile[name] !== expectedValue) throw new Error(`LOAD_PROFILE_INVALID:${name}`);
  }
  return expected;
}

function loadMetrics(value) {
  const metrics = object(value, 'LOAD_RAW_SUMMARY_METRICS_INVALID');
  const allowedValueNames = new Set([
    'avg',
    'count',
    'fails',
    'max',
    'med',
    'min',
    'p(90)',
    'p(95)',
    'passes',
    'rate',
  ]);
  return Object.fromEntries(
    REQUIRED_LOAD_THRESHOLD_METRICS.map((metricName) => {
      const candidate = metrics[metricName];
      const metric = object(candidate, `LOAD_RAW_SUMMARY_METRIC_INVALID:${metricName}`);
      const values = object(metric.values, `LOAD_RAW_SUMMARY_METRIC_VALUES_INVALID:${metricName}`);
      const gate = LOAD_METRIC_GATES[metricName];
      const gateValue = values[gate.value];
      if (typeof gateValue !== 'number' || !Number.isFinite(gateValue) || !gate.passes(gateValue)) {
        throw new Error(`LOAD_METRIC_FAILED:${metricName}`);
      }
      return [
        metricName,
        {
          values: Object.fromEntries(
            Object.entries(values).filter(
              ([name, metricValue]) =>
                allowedValueNames.has(name) &&
                typeof metricValue === 'number' &&
                Number.isFinite(metricValue),
            ),
          ),
        },
      ];
    }),
  );
}

function timestamp(value, errorCode) {
  if (typeof value !== 'string') throw new Error(errorCode);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(errorCode);
  }
  return value;
}

function object(value, errorCode) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  return value;
}

function parseObject(contents, errorCode) {
  try {
    return object(JSON.parse(contents), errorCode);
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new Error(errorCode, { cause: error });
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    const result = await finalizeTask18LoadEvidence({ environment: process.env });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'LOAD_EVIDENCE_FAILED'}\n`);
    process.exitCode = 1;
  }
}
