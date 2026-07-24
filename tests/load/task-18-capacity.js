/* global __ENV */

import http from 'k6/http';
import execution from 'k6/execution';
import crypto from 'k6/crypto';
import { check, fail, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

import {
  ACCEPTED_JOB_ID_CANONICALIZATION,
  ACTIVE_JOB_CANONICALIZATION,
  acceptedJobIdsCanonicalPayload,
  activeJobRecordsCanonicalPayload,
  canonicalAcceptedJobIds,
  canonicalActiveJobRecords,
  inspectJobPollingRound,
  jobSubmissionScopes,
  loadConfigurationFromEnvironment,
  REQUIRED_LOAD_THRESHOLD_METRICS,
  sessionScopeForVu,
} from '../../scripts/load/task-18-load-contract.mjs';

const readLatency = new Trend('aeo_read_ms', true);
const writeLatency = new Trend('aeo_write_ms', true);
const jobAckLatency = new Trend('aeo_job_ack_ms', true);
const queueStartLatency = new Trend('aeo_queue_start_ms', true);
const isolationFailures = new Counter('aeo_tenant_isolation_failures');
const budgetProbeAttempts = new Counter('aeo_budget_probe_attempts');
const budgetProbeBlocked = new Counter('aeo_budget_probe_blocked');
const budgetProbeFailures = new Counter('aeo_budget_probe_failures');
const budgetProbeSuccess = new Rate('aeo_budget_probe_success');
const acceptedJobs = new Counter('aeo_jobs_accepted');
const distinctAcceptedJobs = new Counter('aeo_distinct_jobs_accepted');
const jobSubmissionFailures = new Counter('aeo_job_submission_failures');
const jobPollFailures = new Counter('aeo_job_poll_failures');
const jobsObservedStarted = new Counter('aeo_jobs_observed_started');
const maxActiveGlobalMetric = new Trend('aeo_max_active_global');
const maxActiveTenantMetric = new Trend('aeo_max_active_tenant');
const errorRate = new Rate('aeo_errors');

export const options = {
  batch: 50,
  batchPerHost: 50,
  scenarios: {
    sessions: {
      executor: 'constant-vus',
      vus: 100,
      duration: '5m',
      exec: 'sessionReadProfile',
    },
    jobs: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '5m',
      exec: 'submitAndObserveJobs',
      startTime: '15s',
    },
    budgetHardStop: {
      executor: 'per-vu-iterations',
      vus: 10,
      iterations: 1,
      maxDuration: '2m',
      exec: 'verifyBudgetHardStop',
      startTime: '5m15s',
    },
  },
  thresholds: {
    aeo_read_ms: ['p(95)<=500'],
    aeo_write_ms: ['p(95)<=1000'],
    aeo_job_ack_ms: ['p(95)<=2000'],
    aeo_queue_start_ms: ['p(95)<=30000'],
    aeo_errors: ['rate<0.01'],
    aeo_tenant_isolation_failures: ['count==0'],
    aeo_budget_probe_attempts: ['count==10'],
    aeo_budget_probe_blocked: ['count==10'],
    aeo_budget_probe_failures: ['count==0'],
    aeo_budget_probe_success: ['rate==1'],
    aeo_jobs_accepted: ['count==50'],
    aeo_distinct_jobs_accepted: ['count==50'],
    aeo_job_submission_failures: ['count==0'],
    aeo_job_poll_failures: ['count==0'],
    aeo_jobs_observed_started: ['count==50'],
    aeo_max_active_global: ['max>=50'],
    aeo_max_active_tenant: ['max<=5'],
  },
};

let configuration;
try {
  configuration = loadConfigurationFromEnvironment(__ENV);
} catch (error) {
  fail(error instanceof Error ? error.message : 'AEO_LOAD_CONFIGURATION_INVALID');
}
const { runIdentity, tenants } = configuration;
const baseUrl = runIdentity.approvedOrigin;
const rawSummaryPath = __ENV.AEO_LOAD_RAW_SUMMARY_PATH ?? 'output/task-18-load-raw-summary.json';
const ACCEPTED_JOB_CHECK_PREFIX = 'accepted-job-id:';
const ACTIVE_JOB_CHECK_PREFIX = 'active-running:';

function budgetScopeForIteration() {
  const tenantIndex = execution.scenario.iterationInTest;
  if (tenantIndex < 0 || tenantIndex >= tenants.length) {
    fail('AEO_LOAD_BUDGET_PROBE_TENANT_MAPPING_INVALID');
  }
  const tenant = tenants[tenantIndex];
  return {
    ...tenant,
    tenantIndex,
    identityId: tenant.sessions[0].identityId,
    sessionCookie: tenant.sessions[0].sessionCookie,
  };
}

function headers(scope, mutation = false, requestId = undefined) {
  const result = {
    accept: 'application/json',
    cookie: scope.sessionCookie,
  };
  if (mutation) {
    result['content-type'] = 'application/json';
    result.origin = baseUrl;
  }
  if (requestId !== undefined) result['x-request-id'] = requestId;
  return result;
}

function requestOptions(scope, mutation, operation, requestId = undefined) {
  return {
    headers: headers(scope, mutation, requestId),
    redirects: 0,
    tags: { operation },
  };
}

export function sessionReadProfile() {
  const scope = sessionScopeForVu(configuration, execution.vu.idInTest);
  isolationFailures.add(0);
  const response = http.get(
    `${baseUrl}/api/v1/tenants/${scope.tenantId}/workspaces/${scope.workspaceId}/profiles/${scope.profileId}`,
    requestOptions(scope, false, 'read-profile'),
  );
  readLatency.add(response.timings.duration);
  const ok = check(response, { 'bounded read succeeds': (item) => item.status === 200 });
  errorRate.add(!ok);

  const other = tenants[(scope.tenantIndex + 1) % tenants.length];
  const guessed = http.get(
    `${baseUrl}/api/v1/tenants/${other.tenantId}/workspaces/${other.workspaceId}/profiles/${other.profileId}`,
    requestOptions(scope, false, 'cross-tenant-denial'),
  );
  if (guessed.status !== 404) isolationFailures.add(1);
}

export function submitAndObserveJobs() {
  const scopes = jobSubmissionScopes(configuration);
  const requestedAt = Date.now();
  acceptedJobs.add(0);
  jobSubmissionFailures.add(0);
  jobPollFailures.add(0);
  jobsObservedStarted.add(0);
  maxActiveGlobalMetric.add(0);
  maxActiveTenantMetric.add(0);
  const responses = http.batch(
    scopes.map((scope) => [
      'POST',
      `${baseUrl}/api/v1/tenants/${scope.tenantId}/workspaces/${scope.workspaceId}/jobs`,
      JSON.stringify({
        jobType: 'PROFILE_READINESS',
        aggregateId: scope.profileId,
        idempotencyKey: `task18-load-${runIdentity.loadRunId}-${scope.submissionIndex}`,
        estimatedUnits: 10,
      }),
      requestOptions(scope, true, 'job-ack', runIdentity.loadRunId),
    ]),
  );
  const jobIds = new Set();
  const accepted = [];
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index];
    const scope = scopes[index];
    writeLatency.add(response.timings.duration);
    jobAckLatency.add(response.timings.duration);
    const body = responseJson(response);
    const jobId = body?.data?.job?.id;
    const acknowledged = check(response, {
      'job acknowledged with an id': (item) => item.status === 202 && typeof jobId === 'string',
    });
    errorRate.add(!acknowledged);
    if (!acknowledged) {
      jobSubmissionFailures.add(1);
      continue;
    }
    acceptedJobs.add(1);
    if (jobIds.has(jobId)) {
      jobSubmissionFailures.add(1);
      continue;
    }
    jobIds.add(jobId);
    check(response, { [acceptedJobCheckName(jobId)]: () => true });
    accepted.push({ jobId, scope });
  }
  distinctAcceptedJobs.add(jobIds.size);
  if (jobIds.size !== 50) return;

  const observedStarted = new Set();
  const observedTerminalFailure = new Set();
  let maxActiveGlobal = 0;
  let maxActiveTenant = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const polls = http.batch(
      accepted.map(({ jobId, scope }) => [
        'GET',
        `${baseUrl}/api/v1/tenants/${scope.tenantId}/workspaces/${scope.workspaceId}/jobs/${jobId}`,
        null,
        requestOptions(scope, false, 'queue-start'),
      ]),
    );
    const pollingRound = inspectJobPollingRound(
      attempt,
      polls.map((response, index) => {
        const expected = accepted[index];
        const job = responseJson(response)?.data?.job;
        return {
          expected: {
            jobId: expected.jobId,
            tenantId: expected.scope.tenantId,
            workspaceId: expected.scope.workspaceId,
          },
          httpStatus: response.status,
          job,
        };
      }),
    );
    jobPollFailures.add(pollingRound.failures);
    const observationsByJobId = new Map(
      pollingRound.observations.map((observation) => [observation.jobId, observation]),
    );
    for (let index = 0; index < polls.length; index += 1) {
      const jobId = accepted[index].jobId;
      const observation = observationsByJobId.get(jobId);
      const exactPoll = check(polls[index], {
        'job poll returns HTTP 200 with exact job and scope identifiers': () =>
          observation !== undefined,
      });
      errorRate.add(!exactPoll);
      if (observation === undefined) continue;
      const state = observation.status;
      const started =
        state === 'RUNNING' || ['SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED'].includes(state);
      if (started && !observedStarted.has(jobId)) {
        observedStarted.add(jobId);
        jobsObservedStarted.add(1);
        queueStartLatency.add(Date.now() - requestedAt);
      }
      if (
        ['FAILED_TERMINAL', 'CANCELLED', 'BUDGET_BLOCKED'].includes(state) &&
        !observedTerminalFailure.has(jobId)
      ) {
        observedTerminalFailure.add(jobId);
        errorRate.add(true);
      }
    }
    const activeByTenant = new Map(tenants.map((tenant) => [tenant.tenantId, new Set()]));
    for (const record of pollingRound.activeRecords) {
      const tenantJobs = activeByTenant.get(record.tenantId);
      if (tenantJobs === undefined) {
        jobPollFailures.add(1);
        errorRate.add(true);
        continue;
      }
      tenantJobs.add(record.jobId);
      const responseIndex = accepted.findIndex(({ jobId }) => jobId === record.jobId);
      if (responseIndex < 0) {
        jobPollFailures.add(1);
        errorRate.add(true);
        continue;
      }
      check(polls[responseIndex], {
        [activeJobCheckName(attempt, record)]: () => true,
      });
    }
    const activeTenantCounts = [...activeByTenant.values()].map((jobs) => jobs.size);
    const activeTenantMaximum = Math.max(...activeTenantCounts);
    const activeGlobal = new Set(pollingRound.activeRecords.map((record) => record.jobId)).size;
    maxActiveGlobalMetric.add(activeGlobal);
    for (const activeTenant of activeTenantCounts) maxActiveTenantMetric.add(activeTenant);
    maxActiveGlobal = Math.max(maxActiveGlobal, activeGlobal);
    maxActiveTenant = Math.max(maxActiveTenant, activeTenantMaximum);
    if (observedStarted.size === 50 && maxActiveGlobal >= 50 && maxActiveTenant <= 5) return;
    if (attempt < 59) sleep(0.5);
  }
  errorRate.add(true);
}

export function verifyBudgetHardStop() {
  const scope = budgetScopeForIteration();
  budgetProbeAttempts.add(1);
  budgetProbeBlocked.add(0);
  budgetProbeFailures.add(0);
  const response = http.post(
    `${baseUrl}/api/v1/tenants/${scope.tenantId}/workspaces/${scope.workspaceId}/jobs`,
    JSON.stringify({
      jobType: 'PROFILE_READINESS',
      aggregateId: scope.profileId,
      idempotencyKey: `task18-budget-probe-${runIdentity.loadRunId}-${scope.tenantIndex}`,
      estimatedUnits: scope.budgetProbeEstimatedUnits,
    }),
    requestOptions(scope, true, 'budget-hard-stop'),
  );
  let body;
  try {
    body = response.json();
  } catch {
    body = undefined;
  }
  const blocked = check(response, {
    'budget probe returns 202 BUDGET_BLOCKED': (item) =>
      item.status === 202 && body?.data?.job?.status === 'BUDGET_BLOCKED',
  });
  budgetProbeSuccess.add(blocked);
  errorRate.add(!blocked);
  if (blocked) budgetProbeBlocked.add(1);
  else budgetProbeFailures.add(1);
}

function responseJson(response) {
  try {
    return response.json();
  } catch {
    return undefined;
  }
}

export function handleSummary(data) {
  const acceptedJobIds = canonicalAcceptedJobIds(acceptedJobIdsFromSummary(data));
  const acceptedJobs = {
    count: acceptedJobIds.length,
    canonicalization: ACCEPTED_JOB_ID_CANONICALIZATION,
    ids: acceptedJobIds,
    sha256: crypto.sha256(acceptedJobIdsCanonicalPayload(acceptedJobIds), 'hex'),
  };
  const activeJobsFromChecks = activeJobsFromSummary(data);
  const activeJobs = {
    pollingRound: activeJobsFromChecks.pollingRound,
    status: 'RUNNING',
    count: activeJobsFromChecks.records.length,
    tenantCount: new Set(activeJobsFromChecks.records.map((record) => record.tenantId)).size,
    maximumPerTenant: maximumJobsPerTenant(activeJobsFromChecks.records),
    canonicalization: ACTIVE_JOB_CANONICALIZATION,
    records: activeJobsFromChecks.records,
    sha256: crypto.sha256(activeJobRecordsCanonicalPayload(activeJobsFromChecks), 'hex'),
  };
  const thresholdResults = Object.fromEntries(
    REQUIRED_LOAD_THRESHOLD_METRICS.map((metricName) => {
      const thresholds = Object.values(data.metrics?.[metricName]?.thresholds ?? {});
      return [
        metricName,
        thresholds.length > 0 && thresholds.every((threshold) => threshold.ok === true),
      ];
    }),
  );
  const failedThresholds = Object.entries(thresholdResults)
    .filter(([, passed]) => !passed)
    .map(([metricName]) => metricName);
  const metrics = Object.fromEntries(
    REQUIRED_LOAD_THRESHOLD_METRICS.map((metricName) => [
      metricName,
      {
        values: data.metrics?.[metricName]?.values ?? {},
        thresholds: Object.fromEntries(
          Object.entries(data.metrics?.[metricName]?.thresholds ?? {}).map(
            ([expression, result]) => [expression, result.ok === true],
          ),
        ),
      },
    ]),
  );
  return {
    [rawSummaryPath]: `${JSON.stringify(
      {
        schemaVersion: 'aeostudio.load-raw-summary.v2',
        completedAt: new Date().toISOString(),
        runIdentity,
        profile: {
          distinctSessions: 100,
          concurrentJobSubmissions: 50,
          jobsPerTenant: 5,
          budgetProbes: 10,
          requiredObservedStartedJobs: 50,
          requiredMaxActiveGlobal: 50,
          maximumActiveJobsPerTenant: 5,
          processingObservationDefinition:
            'same completed polling round; RUNNING only; terminal states excluded',
        },
        gate: {
          outcome: failedThresholds.length === 0 ? 'PASS' : 'FAIL',
          failedThresholds,
          thresholds: thresholdResults,
        },
        acceptedJobs,
        activeJobs,
        metrics,
      },
      null,
      2,
    )}\n`,
  };
}

function acceptedJobCheckName(jobId) {
  return `${ACCEPTED_JOB_CHECK_PREFIX}${jobId}`;
}

function activeJobCheckName(pollingRound, record) {
  return `${ACTIVE_JOB_CHECK_PREFIX}${pollingRound}:${record.jobId}:${record.tenantId}:${record.workspaceId}`;
}

function acceptedJobIdsFromSummary(data) {
  const ids = [];
  const groups = [data.root_group];
  while (groups.length > 0) {
    const group = groups.pop();
    for (const checkResult of group?.checks ?? []) {
      if (!checkResult.name?.startsWith(ACCEPTED_JOB_CHECK_PREFIX)) continue;
      if (checkResult.passes !== 1 || checkResult.fails !== 0) {
        throw new Error('LOAD_ACCEPTED_JOB_CHECK_INVALID');
      }
      ids.push(checkResult.name.slice(ACCEPTED_JOB_CHECK_PREFIX.length));
    }
    groups.push(...(group?.groups ?? []));
  }
  return ids;
}

function activeJobsFromSummary(data) {
  const rounds = new Map();
  const groups = [data.root_group];
  while (groups.length > 0) {
    const group = groups.pop();
    for (const checkResult of group?.checks ?? []) {
      if (!checkResult.name?.startsWith(ACTIVE_JOB_CHECK_PREFIX)) continue;
      if (checkResult.passes !== 1 || checkResult.fails !== 0) {
        throw new Error('LOAD_ACTIVE_JOB_CHECK_INVALID');
      }
      const [rawRound, jobId, tenantId, workspaceId, ...unexpected] = checkResult.name
        .slice(ACTIVE_JOB_CHECK_PREFIX.length)
        .split(':');
      const pollingRound = Number(rawRound);
      if (
        unexpected.length > 0 ||
        !Number.isInteger(pollingRound) ||
        pollingRound < 0 ||
        pollingRound > 59
      ) {
        throw new Error('LOAD_ACTIVE_JOB_CHECK_INVALID');
      }
      const records = rounds.get(pollingRound) ?? [];
      records.push({ jobId, tenantId, workspaceId });
      rounds.set(pollingRound, records);
    }
    groups.push(...(group?.groups ?? []));
  }
  const qualifying = [...rounds.entries()]
    .filter(([, records]) => records.length === 50)
    .sort(([leftRound], [rightRound]) => leftRound - rightRound);
  for (const [pollingRound, records] of qualifying) {
    try {
      return { pollingRound, records: canonicalActiveJobRecords(records) };
    } catch {
      // A malformed round cannot be promoted into evidence; try the next complete round.
    }
  }
  throw new Error('LOAD_ACTIVE_JOB_OBSERVATION_MISSING');
}

function maximumJobsPerTenant(records) {
  const counts = new Map();
  for (const record of records) {
    counts.set(record.tenantId, (counts.get(record.tenantId) ?? 0) + 1);
  }
  return Math.max(...counts.values());
}
