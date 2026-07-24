const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const AWS_ACCOUNT_ID = /^[0-9]{12}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HTTPS_ROOT_ORIGIN =
  /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)\/?$/u;

export const REQUIRED_ACCEPTED_JOB_COUNT = 50;
export const ACCEPTED_JOB_ID_CANONICALIZATION = 'uuid-lowercase-lexicographic-newline-v1';
export const REQUIRED_ACTIVE_JOB_COUNT = 50;
export const ACTIVE_JOB_CANONICALIZATION =
  'polling-round+job-tenant-workspace-lexicographic-newline-v1';
export const CAPACITY_PROBE_REQUEST_ID_SUFFIX = '0050';

export const REQUIRED_LOAD_THRESHOLD_METRICS = Object.freeze([
  'aeo_read_ms',
  'aeo_write_ms',
  'aeo_job_ack_ms',
  'aeo_queue_start_ms',
  'aeo_errors',
  'aeo_tenant_isolation_failures',
  'aeo_budget_probe_attempts',
  'aeo_budget_probe_blocked',
  'aeo_budget_probe_failures',
  'aeo_budget_probe_success',
  'aeo_jobs_accepted',
  'aeo_distinct_jobs_accepted',
  'aeo_job_submission_failures',
  'aeo_job_poll_failures',
  'aeo_jobs_observed_started',
  'aeo_max_active_global',
  'aeo_max_active_tenant',
]);

export function loadRunIdentityFromEnvironment(environment) {
  const base = stagingOrigin(required(environment, 'AEO_LOAD_BASE_URL'), 'AEO_LOAD_BASE_URL');
  const approved = stagingOrigin(
    required(environment, 'AEO_LOAD_APPROVED_ORIGIN'),
    'AEO_LOAD_APPROVED_ORIGIN',
  );
  const approvedHost = required(environment, 'AEO_LOAD_APPROVED_HOST');
  if (approved.host !== approvedHost) throw new Error('AEO_LOAD_APPROVED_HOST_MISMATCH');
  if (base.origin !== approved.origin) {
    throw new Error('AEO_LOAD_BASE_URL_APPROVED_ORIGIN_MISMATCH');
  }

  const awsAccountId = required(environment, 'AEO_LOAD_AWS_ACCOUNT_ID');
  if (!AWS_ACCOUNT_ID.test(awsAccountId)) throw new Error('AEO_LOAD_AWS_ACCOUNT_ID_INVALID');

  const releaseImageDigests = {
    adot: imageDigest(environment, 'AEO_LOAD_ADOT_IMAGE_DIGEST'),
    api: imageDigest(environment, 'AEO_LOAD_API_IMAGE_DIGEST'),
    tenantDataBroker: imageDigest(environment, 'AEO_LOAD_TENANT_DATA_BROKER_IMAGE_DIGEST'),
    web: imageDigest(environment, 'AEO_LOAD_WEB_IMAGE_DIGEST'),
    worker: imageDigest(environment, 'AEO_LOAD_WORKER_IMAGE_DIGEST'),
  };
  if (releaseImageDigests.tenantDataBroker !== releaseImageDigests.worker) {
    throw new Error('AEO_LOAD_TENANT_DATA_BROKER_IMAGE_DIGEST_MISMATCH');
  }
  const buildRunId = positiveInteger(environment, 'AEO_LOAD_BUILD_RUN_ID');
  const buildRunAttempt = positiveInteger(environment, 'AEO_LOAD_BUILD_RUN_ATTEMPT');
  const loadRunId = exact(environment, 'AEO_LOAD_RUN_ID', UUID);
  if (!loadRunId.endsWith(CAPACITY_PROBE_REQUEST_ID_SUFFIX)) {
    throw new Error('AEO_LOAD_RUN_ID_CAPACITY_PROBE_MARKER_REQUIRED');
  }

  return Object.freeze({
    environment: 'staging',
    region: 'ap-southeast-1',
    approvedOrigin: approved.origin,
    approvedHost,
    awsAccountId,
    releaseImageDigests: Object.freeze(releaseImageDigests),
    buildRunId,
    buildRunAttempt,
    loadRunId,
  });
}

export function loadConfigurationFromEnvironment(environment) {
  const runIdentity = loadRunIdentityFromEnvironment(environment);
  const tenants = tenantConfiguration(environment);
  const sessions = tenants.flatMap((tenant, tenantIndex) =>
    tenant.sessions.map((session, sessionIndex) =>
      Object.freeze({
        tenantId: tenant.tenantId,
        workspaceId: tenant.workspaceId,
        profileId: tenant.profileId,
        tenantIndex,
        sessionIndex,
        identityId: session.identityId,
        sessionCookie: session.sessionCookie,
      }),
    ),
  );
  return Object.freeze({
    runIdentity,
    tenants: Object.freeze(tenants),
    sessions: Object.freeze(sessions),
  });
}

export function sessionScopeForVu(configuration, vu) {
  if (!Number.isInteger(vu) || vu < 1 || vu > configuration.sessions.length) {
    throw new Error('AEO_LOAD_SESSION_VU_OUT_OF_RANGE');
  }
  return configuration.sessions[vu - 1];
}

export function jobSubmissionScopes(configuration) {
  return Object.freeze(
    configuration.tenants.flatMap((tenant, tenantIndex) =>
      tenant.sessions.slice(0, 5).map((session, tenantSubmissionIndex) =>
        Object.freeze({
          tenantId: tenant.tenantId,
          workspaceId: tenant.workspaceId,
          profileId: tenant.profileId,
          tenantIndex,
          tenantSubmissionIndex,
          submissionIndex: tenantIndex * 5 + tenantSubmissionIndex,
          identityId: session.identityId,
          sessionCookie: session.sessionCookie,
        }),
      ),
    ),
  );
}

export function canonicalAcceptedJobIds(values) {
  if (!Array.isArray(values) || values.length !== REQUIRED_ACCEPTED_JOB_COUNT) {
    throw new Error('LOAD_ACCEPTED_JOB_COUNT_INVALID');
  }
  const ids = values.map((value) => {
    if (typeof value !== 'string' || !UUID.test(value)) {
      throw new Error('LOAD_ACCEPTED_JOB_ID_INVALID');
    }
    return value;
  });
  const unique = new Set(ids);
  if (unique.size !== REQUIRED_ACCEPTED_JOB_COUNT) {
    throw new Error('LOAD_ACCEPTED_JOB_ID_DUPLICATE');
  }
  return Object.freeze([...unique].sort());
}

export function acceptedJobIdsCanonicalPayload(ids) {
  return `${canonicalAcceptedJobIds(ids).join('\n')}\n`;
}

export function canonicalActiveJobRecords(values) {
  if (!Array.isArray(values) || values.length !== REQUIRED_ACTIVE_JOB_COUNT) {
    throw new Error('LOAD_ACTIVE_JOB_COUNT_INVALID');
  }
  const records = values.map((value) => {
    const candidate = record(value, 'LOAD_ACTIVE_JOB_RECORD_INVALID');
    if (
      !sameStringSet(Object.keys(candidate), ['jobId', 'tenantId', 'workspaceId']) ||
      !UUID.test(candidate.jobId) ||
      !UUID.test(candidate.tenantId) ||
      !UUID.test(candidate.workspaceId)
    ) {
      throw new Error('LOAD_ACTIVE_JOB_RECORD_INVALID');
    }
    return {
      jobId: candidate.jobId,
      tenantId: candidate.tenantId,
      workspaceId: candidate.workspaceId,
    };
  });
  if (new Set(records.map((entry) => entry.jobId)).size !== REQUIRED_ACTIVE_JOB_COUNT) {
    throw new Error('LOAD_ACTIVE_JOB_ID_DUPLICATE');
  }
  const tenantWorkspaces = new Map();
  const tenantCounts = new Map();
  for (const entry of records) {
    const existingWorkspace = tenantWorkspaces.get(entry.tenantId);
    if (existingWorkspace !== undefined && existingWorkspace !== entry.workspaceId) {
      throw new Error('LOAD_ACTIVE_JOB_TENANT_WORKSPACE_INVALID');
    }
    tenantWorkspaces.set(entry.tenantId, entry.workspaceId);
    tenantCounts.set(entry.tenantId, (tenantCounts.get(entry.tenantId) ?? 0) + 1);
  }
  if (tenantCounts.size !== 10 || [...tenantCounts.values()].some((count) => count !== 5)) {
    throw new Error('LOAD_ACTIVE_JOB_TENANT_DISTRIBUTION_INVALID');
  }
  return Object.freeze(
    records
      .sort((left, right) => left.jobId.localeCompare(right.jobId))
      .map((entry) => Object.freeze(entry)),
  );
}

export function activeJobRecordsCanonicalPayload(input) {
  if (!Number.isInteger(input.pollingRound) || input.pollingRound < 0 || input.pollingRound > 59) {
    throw new Error('LOAD_ACTIVE_JOB_POLLING_ROUND_INVALID');
  }
  const records = canonicalActiveJobRecords(input.records);
  return `pollingRound=${input.pollingRound}\nstatus=RUNNING\n${records
    .map((record) => `${record.jobId}\t${record.tenantId}\t${record.workspaceId}`)
    .join('\n')}\n`;
}

export function inspectJobPollingRound(pollingRound, entries) {
  if (!Number.isInteger(pollingRound) || pollingRound < 0 || pollingRound > 59) {
    throw new Error('LOAD_JOB_POLLING_ROUND_INVALID');
  }
  if (!Array.isArray(entries)) throw new Error('LOAD_JOB_POLLING_ENTRIES_INVALID');
  const observations = [];
  const activeRecords = [];
  const activeJobIds = new Set();
  let failures = 0;
  for (const entryValue of entries) {
    const entry = record(entryValue, 'LOAD_JOB_POLLING_ENTRY_INVALID');
    const expected = record(entry.expected, 'LOAD_JOB_POLLING_EXPECTED_SCOPE_INVALID');
    const job =
      entry.job === undefined ? undefined : record(entry.job, 'LOAD_JOB_POLLING_RESPONSE_INVALID');
    if (
      entry.httpStatus !== 200 ||
      job === undefined ||
      job.id !== expected.jobId ||
      job.tenantId !== expected.tenantId ||
      job.workspaceId !== expected.workspaceId ||
      typeof job.status !== 'string'
    ) {
      failures += 1;
      continue;
    }
    const observation = {
      jobId: job.id,
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
      status: job.status,
    };
    observations.push(observation);
    if (job.status !== 'RUNNING') continue;
    if (activeJobIds.has(job.id)) {
      failures += 1;
      continue;
    }
    activeJobIds.add(job.id);
    activeRecords.push({
      jobId: job.id,
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
    });
  }
  return { pollingRound, failures, observations, activeRecords };
}

function tenantConfiguration(environment) {
  const source = required(environment, 'AEO_LOAD_TENANTS_JSON');
  let values;
  try {
    values = JSON.parse(source);
  } catch {
    throw new Error('AEO_LOAD_TENANTS_JSON_INVALID');
  }
  if (!Array.isArray(values) || values.length !== 10) {
    throw new Error('AEO_LOAD_TENANTS_COUNT_INVALID');
  }

  const tenantIds = new Set();
  const identityIds = new Set();
  const sessionCookies = new Set();
  return values.map((value, tenantIndex) => {
    const tenant = record(value, 'AEO_LOAD_TENANT_INVALID');
    const tenantId = recordString(tenant, 'tenantId', 'AEO_LOAD_TENANT_ID_INVALID');
    if (tenantIds.has(tenantId)) throw new Error('AEO_LOAD_TENANT_ID_DUPLICATE');
    tenantIds.add(tenantId);
    const workspaceId = recordString(tenant, 'workspaceId', 'AEO_LOAD_WORKSPACE_ID_INVALID');
    const profileId = recordString(tenant, 'profileId', 'AEO_LOAD_PROFILE_ID_INVALID');
    const budgetProbeEstimatedUnits = tenant.budgetProbeEstimatedUnits;
    if (
      !Number.isInteger(budgetProbeEstimatedUnits) ||
      budgetProbeEstimatedUnits < 1 ||
      budgetProbeEstimatedUnits > 1_000_000
    ) {
      throw new Error('AEO_LOAD_BUDGET_PROBE_ESTIMATED_UNITS_INVALID');
    }
    if (!Array.isArray(tenant.sessions) || tenant.sessions.length !== 10) {
      throw new Error('AEO_LOAD_TENANT_SESSION_COUNT_INVALID');
    }
    const sessions = tenant.sessions.map((value, sessionIndex) => {
      const session = record(value, 'AEO_LOAD_SESSION_INVALID');
      const identityId = recordString(session, 'identityId', 'AEO_LOAD_SESSION_IDENTITY_INVALID');
      const sessionCookie = recordString(
        session,
        'sessionCookie',
        'AEO_LOAD_SESSION_COOKIE_INVALID',
        false,
      );
      if (identityIds.has(identityId)) throw new Error('AEO_LOAD_SESSION_IDENTITY_DUPLICATE');
      if (sessionCookies.has(sessionCookie)) throw new Error('AEO_LOAD_SESSION_COOKIE_DUPLICATE');
      identityIds.add(identityId);
      sessionCookies.add(sessionCookie);
      return Object.freeze({ identityId, sessionCookie, sessionIndex });
    });
    return Object.freeze({
      tenantId,
      workspaceId,
      profileId,
      budgetProbeEstimatedUnits,
      tenantIndex,
      sessions: Object.freeze(sessions),
    });
  });
}

function stagingOrigin(value, name) {
  const match = HTTPS_ROOT_ORIGIN.exec(value);
  const host = match?.[1];
  if (host === undefined || host.length > 253) {
    throw new Error(`${name}_INVALID`);
  }
  return Object.freeze({ host, origin: `https://${host}` });
}

function imageDigest(environment, name) {
  const value = required(environment, name);
  if (!IMAGE_DIGEST.test(value)) throw new Error(`${name}_INVALID`);
  return value;
}

function positiveInteger(environment, name) {
  const value = required(environment, name);
  if (!POSITIVE_INTEGER.test(value)) throw new Error(`${name}_INVALID`);
  return value;
}

function exact(environment, name, pattern) {
  const value = required(environment, name);
  if (!pattern.test(value)) throw new Error(`${name}_INVALID`);
  return value;
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name}_REQUIRED`);
  return value.trim();
}

function record(value, errorCode) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  return value;
}

function recordString(value, key, errorCode, trim = true) {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.trim() === '') throw new Error(errorCode);
  return trim ? candidate.trim() : candidate;
}

function sameStringSet(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}
