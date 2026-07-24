import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import * as untypedLoadContract from '../../scripts/load/task-18-load-contract.mjs';
import * as untypedLoadFinalizer from '../../scripts/load/finalize-task-18-load-evidence.mjs';

const loadContract = untypedLoadContract as unknown as {
  jobSubmissionScopes(
    configuration: ReturnType<typeof loadContract.loadConfigurationFromEnvironment>,
  ): Array<{
    identityId: string;
    sessionCookie: string;
    submissionIndex: number;
    tenantId: string;
  }>;
  loadConfigurationFromEnvironment(environment: Record<string, string | undefined>): {
    sessions: Array<{
      identityId: string;
      sessionCookie: string;
      tenantId: string;
    }>;
  };
  loadRunIdentityFromEnvironment(environment: Record<string, string | undefined>): {
    approvedHost: string;
    approvedOrigin: string;
    awsAccountId: string;
    buildRunAttempt: string;
    buildRunId: string;
    environment: 'staging';
    releaseImageDigests: {
      adot: string;
      api: string;
      tenantDataBroker: string;
      web: string;
      worker: string;
    };
    region: 'ap-southeast-1';
  };
  inspectJobPollingRound(
    pollingRound: number,
    entries: Array<{
      expected: { jobId: string; tenantId: string; workspaceId: string };
      httpStatus: number;
      job: { id: string; tenantId: string; workspaceId: string; status: string } | undefined;
    }>,
  ): {
    pollingRound: number;
    failures: number;
    observations: Array<{
      jobId: string;
      tenantId: string;
      workspaceId: string;
      status: string;
    }>;
    activeRecords: Array<{ jobId: string; tenantId: string; workspaceId: string }>;
  };
  sessionScopeForVu(
    configuration: ReturnType<typeof loadContract.loadConfigurationFromEnvironment>,
    vu: number,
  ): { identityId: string; sessionCookie: string; tenantId: string };
};

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const loadRunId = '018f84b3-7eb8-7c75-9ca5-252789690050';
const acceptedJobIds = Array.from(
  { length: 50 },
  (_, index) => `018f84b3-7eb8-7c75-9ca5-${index.toString(16).padStart(12, '0')}`,
);
const acceptedJobIdsSha256 = createHash('sha256')
  .update(`${acceptedJobIds.join('\n')}\n`)
  .digest('hex');
const activeJobRecords = acceptedJobIds.map((jobId, index) => {
  const tenantIndex = Math.floor(index / 5);
  return {
    jobId,
    tenantId: `018f84b3-7eb8-7c75-9ca6-${tenantIndex.toString(16).padStart(12, '0')}`,
    workspaceId: `018f84b3-7eb8-7c75-9ca7-${tenantIndex.toString(16).padStart(12, '0')}`,
  };
});
const activeJobRecordsSha256 = createHash('sha256')
  .update(
    `pollingRound=7\nstatus=RUNNING\n${activeJobRecords
      .map((record) => `${record.jobId}\t${record.tenantId}\t${record.workspaceId}`)
      .join('\n')}\n`,
  )
  .digest('hex');
const loadFinalizer = untypedLoadFinalizer as {
  finalizeTask18LoadEvidence(input: {
    environment: Record<string, string | undefined>;
    now?: () => Date;
  }): Promise<{ evidencePath: string; outcome: 'PASS' }>;
};

function approvedEnvironment(): Record<string, string> {
  return {
    AEO_LOAD_BASE_URL: 'https://synthetic.staging.example.com',
    AEO_LOAD_APPROVED_ORIGIN: 'https://synthetic.staging.example.com',
    AEO_LOAD_APPROVED_HOST: 'synthetic.staging.example.com',
    AEO_LOAD_AWS_ACCOUNT_ID: '123456789012',
    AEO_LOAD_ADOT_IMAGE_DIGEST: digest('d'),
    AEO_LOAD_API_IMAGE_DIGEST: digest('a'),
    AEO_LOAD_TENANT_DATA_BROKER_IMAGE_DIGEST: digest('c'),
    AEO_LOAD_WEB_IMAGE_DIGEST: digest('b'),
    AEO_LOAD_WORKER_IMAGE_DIGEST: digest('c'),
    AEO_LOAD_BUILD_RUN_ID: '4312',
    AEO_LOAD_BUILD_RUN_ATTEMPT: '2',
    AEO_LOAD_RUN_ID: loadRunId,
  };
}

function syntheticTenants() {
  return Array.from({ length: 10 }, (_, tenantIndex) => ({
    tenantId: `tenant-${tenantIndex}`,
    workspaceId: `workspace-${tenantIndex}`,
    profileId: `profile-${tenantIndex}`,
    budgetProbeEstimatedUnits: 100_000,
    sessions: Array.from({ length: 10 }, (_, sessionIndex) => ({
      identityId: `tenant-${tenantIndex}-session-${sessionIndex}`,
      sessionCookie: `session=opaque-${tenantIndex}-${sessionIndex}`,
    })),
  }));
}

function passingThresholds(): Record<string, boolean> {
  return Object.fromEntries(
    [
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
    ].map((name) => [name, true]),
  );
}

function passingMetrics(): Record<string, { values: Record<string, number> }> {
  return {
    aeo_read_ms: { values: { 'p(95)': 500 } },
    aeo_write_ms: { values: { 'p(95)': 1_000 } },
    aeo_job_ack_ms: { values: { 'p(95)': 2_000 } },
    aeo_queue_start_ms: { values: { 'p(95)': 30_000 } },
    aeo_errors: { values: { rate: 0 } },
    aeo_tenant_isolation_failures: { values: { count: 0 } },
    aeo_budget_probe_attempts: { values: { count: 10 } },
    aeo_budget_probe_blocked: { values: { count: 10 } },
    aeo_budget_probe_failures: { values: { count: 0 } },
    aeo_budget_probe_success: { values: { rate: 1 } },
    aeo_jobs_accepted: { values: { count: 50 } },
    aeo_distinct_jobs_accepted: { values: { count: 50 } },
    aeo_job_submission_failures: { values: { count: 0 } },
    aeo_job_poll_failures: { values: { count: 0 } },
    aeo_jobs_observed_started: { values: { count: 50 } },
    aeo_max_active_global: { values: { max: 50 } },
    aeo_max_active_tenant: { values: { max: 5 } },
  };
}

function passingRawSummary(runIdentity: unknown) {
  return {
    schemaVersion: 'aeostudio.load-raw-summary.v2',
    completedAt: '2026-07-23T03:00:00.000Z',
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
      outcome: 'PASS',
      failedThresholds: [],
      thresholds: passingThresholds(),
    },
    acceptedJobs: {
      count: 50,
      canonicalization: 'uuid-lowercase-lexicographic-newline-v1',
      ids: acceptedJobIds,
      sha256: acceptedJobIdsSha256,
    },
    activeJobs: {
      pollingRound: 7,
      status: 'RUNNING',
      count: 50,
      tenantCount: 10,
      maximumPerTenant: 5,
      canonicalization: 'polling-round+job-tenant-workspace-lexicographic-newline-v1',
      records: activeJobRecords,
      sha256: activeJobRecordsSha256,
    },
    metrics: passingMetrics(),
  };
}

describe('Task 18 load evidence contract', () => {
  test('binds the run to one approved HTTPS staging origin, account and release build', () => {
    expect(loadContract.loadRunIdentityFromEnvironment(approvedEnvironment())).toEqual({
      environment: 'staging',
      region: 'ap-southeast-1',
      approvedOrigin: 'https://synthetic.staging.example.com',
      approvedHost: 'synthetic.staging.example.com',
      awsAccountId: '123456789012',
      releaseImageDigests: {
        adot: digest('d'),
        api: digest('a'),
        tenantDataBroker: digest('c'),
        web: digest('b'),
        worker: digest('c'),
      },
      buildRunId: '4312',
      buildRunAttempt: '2',
      loadRunId,
    });

    expect(() =>
      loadContract.loadRunIdentityFromEnvironment({
        ...approvedEnvironment(),
        AEO_LOAD_BASE_URL: 'https://unapproved.example.com',
      }),
    ).toThrow('AEO_LOAD_BASE_URL_APPROVED_ORIGIN_MISMATCH');

    expect(() =>
      loadContract.loadRunIdentityFromEnvironment({
        ...approvedEnvironment(),
        AEO_LOAD_RUN_ID: '',
      }),
    ).toThrow('AEO_LOAD_RUN_ID_REQUIRED');
    expect(() =>
      loadContract.loadRunIdentityFromEnvironment({
        ...approvedEnvironment(),
        AEO_LOAD_RUN_ID: '018f84b3-7eb8-7c75-9ca5-25278969d304',
      }),
    ).toThrow('AEO_LOAD_RUN_ID_CAPACITY_PROBE_MARKER_REQUIRED');
  });

  test('parses the approved origin without relying on the unavailable k6 URL global', async () => {
    const source = await readFile(
      join(process.cwd(), 'scripts/load/task-18-load-contract.mjs'),
      'utf8',
    );

    expect(source).not.toMatch(/\bnew URL\s*\(/u);
    expect(
      loadContract.loadRunIdentityFromEnvironment({
        ...approvedEnvironment(),
        AEO_LOAD_BASE_URL: 'https://synthetic.staging.example.com/',
        AEO_LOAD_APPROVED_ORIGIN: 'https://synthetic.staging.example.com/',
      }).approvedOrigin,
    ).toBe('https://synthetic.staging.example.com');

    for (const invalidOrigin of [
      'http://synthetic.staging.example.com',
      'https://synthetic.staging.example.com:443',
      'https://operator@synthetic.staging.example.com',
      'https://synthetic.staging.example.com/path',
      'https://synthetic.staging.example.com?query=1',
      'https://synthetic.staging.example.com#fragment',
      'https://SYNTHETIC.staging.example.com',
      'https://localhost',
    ]) {
      expect(() =>
        loadContract.loadRunIdentityFromEnvironment({
          ...approvedEnvironment(),
          AEO_LOAD_BASE_URL: invalidOrigin,
        }),
      ).toThrow('AEO_LOAD_BASE_URL_INVALID');
    }
  });

  test('writes passing evidence once with private permissions and never replaces it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeostudio-load-evidence-'));
    const rawSummaryPath = join(directory, 'raw.json');
    const evidencePath = join(directory, 'evidence.json');
    const environment = {
      ...approvedEnvironment(),
      AEO_LOAD_RAW_SUMMARY_PATH: rawSummaryPath,
      AEO_LOAD_EVIDENCE_PATH: evidencePath,
    };
    const runIdentity = loadContract.loadRunIdentityFromEnvironment(environment);
    const passing = passingRawSummary(runIdentity);
    const rawSummary = {
      ...passing,
      profile: { ...passing.profile, sessionCookie: 'must-not-leak-profile' },
      gate: { ...passing.gate, token: 'must-not-leak-gate' },
      metrics: {
        ...passing.metrics,
        untrusted: { values: { token: 'must-not-leak-metric' } },
      },
    };
    await writeFile(rawSummaryPath, JSON.stringify(rawSummary));

    await expect(
      loadFinalizer.finalizeTask18LoadEvidence({
        environment,
        now: () => new Date('2026-07-23T03:01:00.000Z'),
      }),
    ).resolves.toEqual({ evidencePath, outcome: 'PASS' });

    const firstContents = await readFile(evidencePath, 'utf8');
    expect(JSON.parse(firstContents)).toMatchObject({
      schemaVersion: 'aeostudio.load-evidence.v2',
      runIdentity,
      finalizedAt: '2026-07-23T03:01:00.000Z',
      acceptedJobs: {
        count: 50,
        canonicalization: 'uuid-lowercase-lexicographic-newline-v1',
        ids: acceptedJobIds,
        sha256: acceptedJobIdsSha256,
      },
      activeJobs: {
        pollingRound: 7,
        status: 'RUNNING',
        count: 50,
        tenantCount: 10,
        maximumPerTenant: 5,
        canonicalization: 'polling-round+job-tenant-workspace-lexicographic-newline-v1',
        records: activeJobRecords,
        sha256: activeJobRecordsSha256,
      },
    });
    expect(firstContents).not.toContain('must-not-leak');
    if (process.platform !== 'win32') {
      expect((await stat(evidencePath)).mode & 0o777).toBe(0o600);
    }

    await expect(loadFinalizer.finalizeTask18LoadEvidence({ environment })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(evidencePath, 'utf8')).toBe(firstContents);
  });

  test('rejects self-reported PASS evidence when an actual metric misses its gate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeostudio-load-tamper-'));
    const rawSummaryPath = join(directory, 'raw.json');
    const evidencePath = join(directory, 'evidence.json');
    const environment = {
      ...approvedEnvironment(),
      AEO_LOAD_RAW_SUMMARY_PATH: rawSummaryPath,
      AEO_LOAD_EVIDENCE_PATH: evidencePath,
    };
    const rawSummary = passingRawSummary(loadContract.loadRunIdentityFromEnvironment(environment));
    rawSummary.metrics.aeo_budget_probe_blocked!.values.count = 9;
    await writeFile(rawSummaryPath, JSON.stringify(rawSummary));

    await expect(loadFinalizer.finalizeTask18LoadEvidence({ environment })).rejects.toThrow(
      'LOAD_METRIC_FAILED:aeo_budget_probe_blocked',
    );
  });

  test.each([
    ['aeo_max_active_global', 49],
    ['aeo_max_active_tenant', 6],
  ] as const)('rejects a false concurrency proof in %s', async (metricName, observedMaximum) => {
    const directory = await mkdtemp(join(tmpdir(), 'aeostudio-load-concurrency-tamper-'));
    const rawSummaryPath = join(directory, 'raw.json');
    const evidencePath = join(directory, 'evidence.json');
    const environment = {
      ...approvedEnvironment(),
      AEO_LOAD_RAW_SUMMARY_PATH: rawSummaryPath,
      AEO_LOAD_EVIDENCE_PATH: evidencePath,
    };
    const rawSummary = passingRawSummary(loadContract.loadRunIdentityFromEnvironment(environment));
    rawSummary.metrics[metricName]!.values.max = observedMaximum;
    await writeFile(rawSummaryPath, JSON.stringify(rawSummary));

    await expect(loadFinalizer.finalizeTask18LoadEvidence({ environment })).rejects.toThrow(
      `LOAD_METRIC_FAILED:${metricName}`,
    );
  });

  test('rejects a reordered accepted-job set before finalization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeostudio-load-job-set-tamper-'));
    const rawSummaryPath = join(directory, 'raw.json');
    const evidencePath = join(directory, 'evidence.json');
    const environment = {
      ...approvedEnvironment(),
      AEO_LOAD_RAW_SUMMARY_PATH: rawSummaryPath,
      AEO_LOAD_EVIDENCE_PATH: evidencePath,
    };
    const rawSummary = passingRawSummary(loadContract.loadRunIdentityFromEnvironment(environment));
    rawSummary.acceptedJobs.ids = [...rawSummary.acceptedJobs.ids].reverse();
    await writeFile(rawSummaryPath, JSON.stringify(rawSummary));

    await expect(loadFinalizer.finalizeTask18LoadEvidence({ environment })).rejects.toThrow(
      'LOAD_ACCEPTED_JOBS_HASH_MISMATCH',
    );
  });

  test('rejects a scope-tampered same-round RUNNING set before finalization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeostudio-load-active-set-tamper-'));
    const rawSummaryPath = join(directory, 'raw.json');
    const evidencePath = join(directory, 'evidence.json');
    const environment = {
      ...approvedEnvironment(),
      AEO_LOAD_RAW_SUMMARY_PATH: rawSummaryPath,
      AEO_LOAD_EVIDENCE_PATH: evidencePath,
    };
    const rawSummary = passingRawSummary(loadContract.loadRunIdentityFromEnvironment(environment));
    rawSummary.activeJobs.records = rawSummary.activeJobs.records.map((record, index) =>
      index < 5 ? { ...record, workspaceId: '018f84b3-7eb8-7c75-9ca7-ffffffffffff' } : record,
    );
    await writeFile(rawSummaryPath, JSON.stringify(rawSummary));

    await expect(loadFinalizer.finalizeTask18LoadEvidence({ environment })).rejects.toThrow(
      'LOAD_ACTIVE_JOBS_HASH_MISMATCH',
    );
  });

  test('binds the k6 raw summary to the validated identity before finalization', async () => {
    const load = await readFile(join(process.cwd(), 'tests/load/task-18-capacity.js'), 'utf8');
    const finalizer = await readFile(
      join(process.cwd(), 'scripts/load/finalize-task-18-load-evidence.mjs'),
      'utf8',
    );

    expect(load).toContain('loadConfigurationFromEnvironment(__ENV)');
    expect(load).toContain('REQUIRED_LOAD_THRESHOLD_METRICS');
    expect(load).toContain('AEO_LOAD_RAW_SUMMARY_PATH');
    expect(load).toContain("schemaVersion: 'aeostudio.load-raw-summary.v2'");
    expect(load).toContain('runIdentity');
    expect(load).not.toContain("schemaVersion: 'aeostudio.load-evidence.v2'");
    expect(finalizer).toContain("flag: 'wx'");
    expect(finalizer).toContain('mode: 0o600');
  });

  test('requires exactly one hundred globally unique session identities and cookies', () => {
    const environment = {
      ...approvedEnvironment(),
      AEO_LOAD_TENANTS_JSON: JSON.stringify(syntheticTenants()),
    };
    const configuration = loadContract.loadConfigurationFromEnvironment(environment);
    const scopes = Array.from({ length: 100 }, (_, index) =>
      loadContract.sessionScopeForVu(configuration, index + 1),
    );

    expect(configuration.sessions).toHaveLength(100);
    expect(new Set(scopes.map((scope) => scope.identityId)).size).toBe(100);
    expect(new Set(scopes.map((scope) => scope.sessionCookie)).size).toBe(100);
    expect(
      Object.fromEntries(
        Array.from({ length: 10 }, (_, tenantIndex) => [
          `tenant-${tenantIndex}`,
          scopes.filter((scope) => scope.tenantId === `tenant-${tenantIndex}`).length,
        ]),
      ),
    ).toEqual(
      Object.fromEntries(
        Array.from({ length: 10 }, (_, tenantIndex) => [`tenant-${tenantIndex}`, 10]),
      ),
    );

    const duplicated = syntheticTenants();
    duplicated[9]!.sessions[9]!.sessionCookie = duplicated[0]!.sessions[0]!.sessionCookie;
    expect(() =>
      loadContract.loadConfigurationFromEnvironment({
        ...approvedEnvironment(),
        AEO_LOAD_TENANTS_JSON: JSON.stringify(duplicated),
      }),
    ).toThrow('AEO_LOAD_SESSION_COOKIE_DUPLICATE');
  });

  test('assigns each session VU its own validated identity instead of reusing tenant cookies', async () => {
    const load = await readFile(join(process.cwd(), 'tests/load/task-18-capacity.js'), 'utf8');
    const sessionScenario =
      load.split('export function sessionReadProfile')[1]?.split('export function')[0] ?? '';

    expect(load).toContain('loadConfigurationFromEnvironment(__ENV)');
    expect(load).toContain("import execution from 'k6/execution'");
    expect(sessionScenario).toContain('sessionScopeForVu(configuration, execution.vu.idInTest)');
    expect(sessionScenario).not.toContain('sessionScopeForVu(configuration, __VU)');
    expect(sessionScenario).toContain('isolationFailures.add(0)');
    expect(load).toContain('cookie: scope.sessionCookie');
    expect(sessionScenario).not.toMatch(/\(__VU\s*-\s*1\)\s*%\s*tenants\.length/u);
    expect(load).not.toContain('const tenants = JSON.parse');
  });

  test('never follows redirects while sending an authenticated session cookie', async () => {
    const load = await readFile(join(process.cwd(), 'tests/load/task-18-capacity.js'), 'utf8');

    expect(load).toContain(
      'function requestOptions(scope, mutation, operation, requestId = undefined)',
    );
    expect(load).toContain('redirects: 0');
    for (const request of [
      "requestOptions(scope, false, 'read-profile')",
      "requestOptions(scope, false, 'cross-tenant-denial')",
      "requestOptions(scope, true, 'job-ack', runIdentity.loadRunId)",
      "requestOptions(scope, false, 'queue-start')",
      "requestOptions(scope, true, 'budget-hard-stop')",
    ]) {
      expect(load).toContain(request);
    }
    expect(load.match(/requestOptions\(/gmu)).toHaveLength(6);
  });

  test('builds exactly fifty job submissions with five independently authenticated per Tenant', () => {
    const configuration = loadContract.loadConfigurationFromEnvironment({
      ...approvedEnvironment(),
      AEO_LOAD_TENANTS_JSON: JSON.stringify(syntheticTenants()),
    });
    const submissions = loadContract.jobSubmissionScopes(configuration);

    expect(submissions).toHaveLength(50);
    expect(new Set(submissions.map((submission) => submission.submissionIndex)).size).toBe(50);
    expect(new Set(submissions.map((submission) => submission.identityId)).size).toBe(50);
    expect(new Set(submissions.map((submission) => submission.sessionCookie)).size).toBe(50);
    for (let tenantIndex = 0; tenantIndex < 10; tenantIndex += 1) {
      expect(
        submissions.filter((submission) => submission.tenantId === `tenant-${tenantIndex}`),
      ).toHaveLength(5);
    }
  });

  type PollingJob = {
    id: string;
    tenantId: string;
    workspaceId: string;
    status: string;
  };
  type PollingMutation = {
    httpStatus?: number;
    job?: Partial<PollingJob>;
  };
  const pollingResponseMismatchCases: Array<[string, PollingMutation]> = [
    ['http status', { httpStatus: 503 }],
    ['job id', { job: { id: acceptedJobIds[1] } }],
    ['tenant id', { job: { tenantId: activeJobRecords[5]!.tenantId } }],
    ['workspace id', { job: { workspaceId: activeJobRecords[5]!.workspaceId } }],
  ];

  test.each(pollingResponseMismatchCases)(
    'rejects a polling response with a mismatched %s',
    (_name, mutation) => {
      const expected = activeJobRecords[0]!;
      const job = {
        id: expected.jobId,
        tenantId: expected.tenantId,
        workspaceId: expected.workspaceId,
        status: 'RUNNING',
        ...(mutation.job ?? {}),
      };

      expect(
        loadContract.inspectJobPollingRound(7, [
          {
            expected,
            httpStatus: mutation.httpStatus ?? 200,
            job,
          },
        ]),
      ).toMatchObject({ pollingRound: 7, failures: 1, observations: [], activeRecords: [] });
    },
  );

  test('collects one unique RUNNING set from one complete polling round', () => {
    const entries = activeJobRecords.map((expected) => ({
      expected,
      httpStatus: 200,
      job: {
        id: expected.jobId,
        tenantId: expected.tenantId,
        workspaceId: expected.workspaceId,
        status: 'RUNNING',
      },
    }));

    expect(loadContract.inspectJobPollingRound(7, entries)).toEqual({
      pollingRound: 7,
      failures: 0,
      observations: entries.map(({ job }) => ({
        jobId: job.id,
        tenantId: job.tenantId,
        workspaceId: job.workspaceId,
        status: 'RUNNING',
      })),
      activeRecords: activeJobRecords,
    });
  });

  test('proves fifty distinct accepted submissions and fifty simultaneously active Jobs', async () => {
    const load = await readFile(join(process.cwd(), 'tests/load/task-18-capacity.js'), 'utf8');
    const jobScenario =
      load.split('export function submitAndObserveJobs')[1]?.split('export function')[0] ?? '';

    expect(load).toContain('batch: 50');
    expect(load).toContain('batchPerHost: 50');
    expect(load).toContain("exec: 'submitAndObserveJobs'");
    expect(jobScenario).toContain('jobSubmissionScopes(configuration)');
    expect(jobScenario.match(/http\.batch/gmu)).toHaveLength(2);
    expect(jobScenario).toContain('new Set');
    expect(jobScenario).toContain('acceptedJobs.add(0)');
    expect(jobScenario).toContain('jobSubmissionFailures.add(0)');
    expect(jobScenario).toContain('jobsObservedStarted.add(0)');
    expect(jobScenario).toContain('acceptedJobs.add(1)');
    expect(jobScenario).toContain('distinctAcceptedJobs.add(jobIds.size)');
    expect(jobScenario).toContain('jobSubmissionFailures.add(1)');
    expect(jobScenario).toContain("state === 'RUNNING'");
    expect(load).toContain("aeo_jobs_accepted: ['count==50']");
    expect(load).toContain("aeo_distinct_jobs_accepted: ['count==50']");
    expect(load).toContain("aeo_job_submission_failures: ['count==0']");
    expect(load).toContain("aeo_job_poll_failures: ['count==0']");
    expect(load).toContain("aeo_jobs_observed_started: ['count==50']");
    expect(load).toContain("aeo_max_active_global: ['max>=50']");
    expect(load).toContain("aeo_max_active_tenant: ['max<=5']");
    expect(jobScenario).toContain('inspectJobPollingRound(');
    expect(jobScenario).toContain(
      "'job poll returns HTTP 200 with exact job and scope identifiers'",
    );
    expect(jobScenario).toContain('activeJobCheckName(attempt, record)');
    expect(jobScenario).toContain('maxActiveGlobal');
    expect(jobScenario).toContain('maxActiveTenant');
    expect(load).toContain('concurrentJobSubmissions: 50');
    expect(load).toContain('requiredObservedStartedJobs: 50');
    expect(load).toContain('requiredMaxActiveGlobal: 50');
    expect(load).toContain('maximumActiveJobsPerTenant: 5');
    expect(load).toContain(
      "'same completed polling round; RUNNING only; terminal states excluded'",
    );
  });

  test('binds all accepted submissions and the raw evidence to one safe unique load run marker', async () => {
    const load = await readFile(join(process.cwd(), 'tests/load/task-18-capacity.js'), 'utf8');
    const jobScenario =
      load.split('export function submitAndObserveJobs')[1]?.split('export function')[0] ?? '';
    const summary = load.split('export function handleSummary')[1] ?? '';

    expect(load).toContain("import crypto from 'k6/crypto'");
    expect(jobScenario).toContain(
      'idempotencyKey: `task18-load-${runIdentity.loadRunId}-${scope.submissionIndex}`',
    );
    expect(jobScenario).toContain("requestOptions(scope, true, 'job-ack', runIdentity.loadRunId)");
    expect(load).toContain("result['x-request-id'] = requestId");
    expect(jobScenario).toContain('acceptedJobCheckName(jobId)');
    expect(summary).toContain('acceptedJobIdsFromSummary(data)');
    expect(summary).toContain('canonicalAcceptedJobIds');
    expect(summary).toContain('acceptedJobIdsCanonicalPayload');
    expect(summary).toContain('acceptedJobs,');
    expect(summary).toContain('sha256:');
    expect(summary).not.toMatch(/sessionCookie|cookie/iu);
  });

  test('documents the approved-input, one-hundred-session and finalization contract', async () => {
    const readme = await readFile(join(process.cwd(), 'tests/load/README.md'), 'utf8');

    for (const name of [
      'AEO_LOAD_APPROVED_ORIGIN',
      'AEO_LOAD_APPROVED_HOST',
      'AEO_LOAD_AWS_ACCOUNT_ID',
      'AEO_LOAD_ADOT_IMAGE_DIGEST',
      'AEO_LOAD_API_IMAGE_DIGEST',
      'AEO_LOAD_TENANT_DATA_BROKER_IMAGE_DIGEST',
      'AEO_LOAD_WEB_IMAGE_DIGEST',
      'AEO_LOAD_WORKER_IMAGE_DIGEST',
      'AEO_LOAD_BUILD_RUN_ID',
      'AEO_LOAD_BUILD_RUN_ATTEMPT',
      'AEO_LOAD_RUN_ID',
      'AEO_LOAD_TENANTS_JSON',
    ]) {
      expect(readme).toContain(name);
    }
    expect(readme).toContain('10 个 Tenant');
    expect(readme).toContain('每个 Tenant 10 个');
    expect(readme).toContain('共 100 个全局唯一');
    expect(readme).toContain('50 个 Job **同时处于 `RUNNING`**');
    expect(readme).toContain('同一轮完整 polling snapshot');
    expect(readme).toContain('每次查询都必须为 HTTP 200');
    expect(readme).toContain('Job/Tenant/Workspace 必须与 accepted scope 精确一致');
    expect(readme).toContain('terminal 不计入 active');
    expect(readme).toContain('node scripts/load/finalize-task-18-load-evidence.mjs');
    expect(readme).toContain('output/task-18-load-evidence.json');
    expect(readme).toContain('write-once');
  });
});
