import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

// @ts-expect-error The production helper is a native ESM JavaScript module.
import * as untypedTraceCollector from '../../scripts/acceptance/collect-staging-trace-evidence.mjs';
// @ts-expect-error The production helper is a native ESM JavaScript module.
import * as untypedAcceptanceFinalizer from '../../scripts/acceptance/finalize-staging-acceptance-evidence.mjs';
// @ts-expect-error The production helper is a native ESM JavaScript module.
import * as untypedPromotionValidator from '../../scripts/acceptance/validate-production-promotion-evidence.mjs';
// @ts-expect-error The production helper is a native ESM JavaScript module.
import * as untypedWriteOnce from '../../scripts/acceptance/commit-write-once-file.mjs';
import {
  loadRunIdentityFromEnvironment,
  REQUIRED_LOAD_THRESHOLD_METRICS,
} from '../../scripts/load/task-18-load-contract.mjs';
import {
  expectedAlarmNames,
  expectedSyntheticFaultMatrix,
} from '../../scripts/observability/synthetic-alarm-contract.mjs';

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const releaseImageDigests = () => ({
  adot: digest('d'),
  api: digest('a'),
  tenantDataBroker: digest('c'),
  web: digest('b'),
  worker: digest('c'),
});
const repository = 'owner/aeostudio';
const sourceSha = 'd'.repeat(40);
const accountId = '123456789012';
const buildRunId = '4312';
const buildRunAttempt = '2';
const loadRunId = '018f84b3-7eb8-7c75-9ca5-252789690050';
const smokeRequestId = '018f84b3-7eb8-7c75-9ca5-25278969d301';
const loadRequestId = loadRunId;
const loadJobId = '018f84b3-7eb8-7c75-9ca5-25278969d303';
const backgroundRequestId = '018f84b3-7eb8-7c75-9ca5-25278969d305';
const backgroundJobId = '018f84b3-7eb8-7c75-9ca5-25278969d306';
const smokeTraceId = '1'.repeat(32);
const loadTraceId = '2'.repeat(32);
const backgroundTraceId = '3'.repeat(32);
const smokeApiTaskId = 'a'.repeat(32);
const smokeWebTaskId = 'f'.repeat(32);
const loadApiTaskId = 'b'.repeat(32);
const loadWorkerTaskId = 'c'.repeat(32);
const acceptedJobIds = [
  loadJobId,
  ...Array.from(
    { length: 49 },
    (_, index) => `018f84b3-7eb8-7c75-9ca5-${index.toString(16).padStart(12, '0')}`,
  ),
].sort();
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

function brokerTaskDefinitions() {
  return {
    api: `arn:aws:ecs:ap-southeast-1:${accountId}:task-definition/aeostudio-staging-api:17`,
    web: `arn:aws:ecs:ap-southeast-1:${accountId}:task-definition/aeostudio-staging-web:19`,
    worker: `arn:aws:ecs:ap-southeast-1:${accountId}:task-definition/aeostudio-staging-worker:11`,
    tenantDataBroker:
      `arn:aws:ecs:ap-southeast-1:${accountId}:task-definition/` +
      'aeostudio-staging-tenant-data-broker:13',
    migration: `arn:aws:ecs:ap-southeast-1:${accountId}:task-definition/aeostudio-staging-migration:7`,
  };
}

const traceCollector = untypedTraceCollector as {
  collectStagingTraceEvidence(input: {
    accountId: string;
    apiLogGroup: string;
    buildRunAttempt: string;
    buildRunId: string;
    delay?: () => Promise<void>;
    loadEvidencePath: string;
    loadStartedAt: string;
    outputPath: string;
    region: string;
    releaseContractPath: string;
    repository: string;
    runAws: (args: string[]) => unknown;
    smokeEnvelopePath: string;
    sourceSha: string;
    workerLogGroup: string;
  }): Promise<{ evidencePath: string; outcome: 'PASS' }>;
};

const acceptanceFinalizer = untypedAcceptanceFinalizer as {
  finalizeStagingAcceptanceEvidence(input: {
    accountId: string;
    alarmEvidencePath: string;
    buildRunAttempt: string;
    buildRunId: string;
    loadEvidencePath: string;
    rawLoadEvidencePath: string;
    outputPath: string;
    region: string;
    releaseContractPath: string;
    releaseManifestPath: string;
    repository: string;
    smokeEnvelopePath: string;
    sourceSha: string;
    traceEvidencePath: string;
    workflowRunAttempt: string;
    workflowRunId: string;
  }): Promise<{ evidencePath: string; outcome: 'PASS' }>;
  validateAlarmEvidence(value: Record<string, unknown>, expected: Record<string, string>): void;
  validateSyntheticFaultCausalEvidence(input: {
    completedAt: string;
    expectedFault: Record<string, unknown>;
    fault: Record<string, unknown>;
    startedAt: string;
  }): void;
  validateTraceEvidence(
    value: Record<string, unknown>,
    expected: Record<string, string>,
    imageDigests: Record<string, string>,
    loadValue: Record<string, unknown>,
    taskDefinitions: Record<string, string>,
  ): { tracedJobId: string };
};
const promotionValidator = untypedPromotionValidator as {
  validateProductionLoadTraceBinding(input: {
    envelope: Record<string, unknown>;
    load: Record<string, unknown>;
    rawLoad: Record<string, unknown>;
    trace: Record<string, unknown>;
  }): void;
};
const writeOnce = untypedWriteOnce as {
  commitWriteOnceFile(input: { sourcePath: string; targetPath: string }): Promise<void>;
};

function loadEnvironment(): Record<string, string> {
  return {
    AEO_LOAD_BASE_URL: 'https://staging.example.test',
    AEO_LOAD_APPROVED_ORIGIN: 'https://staging.example.test',
    AEO_LOAD_APPROVED_HOST: 'staging.example.test',
    AEO_LOAD_AWS_ACCOUNT_ID: accountId,
    AEO_LOAD_ADOT_IMAGE_DIGEST: digest('d'),
    AEO_LOAD_API_IMAGE_DIGEST: digest('a'),
    AEO_LOAD_TENANT_DATA_BROKER_IMAGE_DIGEST: digest('c'),
    AEO_LOAD_WEB_IMAGE_DIGEST: digest('b'),
    AEO_LOAD_WORKER_IMAGE_DIGEST: digest('c'),
    AEO_LOAD_BUILD_RUN_ID: buildRunId,
    AEO_LOAD_BUILD_RUN_ATTEMPT: buildRunAttempt,
    AEO_LOAD_RUN_ID: loadRunId,
  };
}

function releaseManifest() {
  const registry = `${accountId}.dkr.ecr.ap-southeast-1.amazonaws.com`;
  return {
    schemaVersion: 'aeostudio.release.v1',
    sourceSha,
    sourceRef: 'refs/heads/main',
    repository,
    buildRunId,
    buildRunAttempt,
    images: {
      adot: { image: `${registry}/aeostudio-adot`, digest: digest('d') },
      api: { image: `${registry}/aeostudio-api`, digest: digest('a') },
      web: { image: `${registry}/aeostudio-web`, digest: digest('b') },
      worker: { image: `${registry}/aeostudio-worker`, digest: digest('c') },
    },
  };
}

function releaseContract() {
  const registry = `${accountId}.dkr.ecr.ap-southeast-1.amazonaws.com`;
  const taskDefinitions = brokerTaskDefinitions();
  return {
    executionStatus: 'SUCCEEDED',
    contract: {
      SchemaVersion: 'aeostudio.release-contract.v2',
      Environment: 'staging',
      Region: 'ap-southeast-1',
      AccountId: accountId,
      ReleaseId: `staging-${buildRunId}-${buildRunAttempt}`,
      Source: {
        Sha: sourceSha,
        BuildRunId: buildRunId,
        BuildRunAttempt: buildRunAttempt,
      },
      Digests: { Adot: digest('d'), Api: digest('a'), Web: digest('b'), Worker: digest('c') },
      Images: {
        Adot: `${registry}/aeostudio-adot@${digest('d')}`,
        Api: `${registry}/aeostudio-api@${digest('a')}`,
        TenantDataBroker: `${registry}/aeostudio-worker@${digest('c')}`,
        Web: `${registry}/aeostudio-web@${digest('b')}`,
        Worker: `${registry}/aeostudio-worker@${digest('c')}`,
      },
      TaskDefinitions: {
        Api: taskDefinitions.api,
        Migration: taskDefinitions.migration,
        TenantDataBroker: taskDefinitions.tenantDataBroker,
        Web: taskDefinitions.web,
        Worker: taskDefinitions.worker,
      },
      Rollback: {
        Api: taskDefinitions.api,
        TenantDataBroker: taskDefinitions.tenantDataBroker,
        Web: taskDefinitions.web,
        Worker: taskDefinitions.worker,
      },
    },
  };
}

function releaseContractRaw(): string {
  return JSON.stringify(releaseContract());
}

function releaseContractSha256(): string {
  return createHash('sha256').update(releaseContractRaw()).digest('hex');
}

function smokeEnvelope() {
  return {
    schemaVersion: 'aeostudio.staging-smoke-envelope.v1',
    sourceSha,
    buildRunId,
    buildRunAttempt,
    digests: {
      adot: digest('d'),
      api: digest('a'),
      tenantDataBroker: digest('c'),
      web: digest('b'),
      worker: digest('c'),
    },
    brokerRuntime: brokerRuntimeEvidence(),
    smoke: {
      schemaVersion: 'aeostudio-staging-smoke.v1',
      environment: 'staging',
      region: 'ap-southeast-1',
      startedAt: '2026-07-23T03:00:00.000Z',
      completedAt: '2026-07-23T03:01:00.000Z',
      endpoint: { origin: 'https://staging.example.test' },
      imageDigest: digest('a'),
      runtimeBuildIdentity: runtimeIdentity('api', 'a', smokeApiTaskId, '17'),
      webRuntimeBuildIdentity: runtimeIdentity('web', 'b', smokeWebTaskId, '19'),
      traceProbe: {
        operation: 'runtimeBuildIdentity',
        requestId: smokeRequestId,
      },
      checks: {
        health: { status: 200 },
        readiness: { status: 200 },
        syntheticLogin: { status: 200 },
        runtimeBuildIdentity: { status: 200 },
        webRuntimeBuildIdentity: { status: 200 },
        sealedExperiment: { status: 200 },
      },
    },
  };
}

function brokerRuntimeEvidence() {
  const registry = `${accountId}.dkr.ecr.ap-southeast-1.amazonaws.com`;
  return {
    schemaVersion: 'aeostudio.tenant-data-broker-runtime.v1',
    environment: 'staging',
    region: 'ap-southeast-1',
    accountId,
    releaseId: `staging-${buildRunId}-${buildRunAttempt}`,
    taskDefinitionArn: brokerTaskDefinitions().tenantDataBroker,
    desiredCount: 2,
    runningCount: 2,
    pendingCount: 0,
    healthyTargetCount: 2,
    workerImage: `${registry}/aeostudio-worker@${digest('c')}`,
    adotImage: `${registry}/aeostudio-adot@${digest('d')}`,
    adotRuntimeDigest: digest('e'),
    tasks: ['4'.repeat(32), '5'.repeat(32)].map((taskId) => ({
      taskArn: `arn:aws:ecs:ap-southeast-1:${accountId}:task/aeostudio-staging/${taskId}`,
      brokerRuntimeDigest: digest('c'),
      adotRuntimeDigest: digest('e'),
    })),
    runtimePlatform: {
      cpuArchitecture: 'X86_64',
      operatingSystemFamily: 'LINUX',
    },
  };
}

function runtimeIdentity(
  service: 'api' | 'web' | 'worker',
  digestCharacter: string,
  taskId: string,
  revision: string,
) {
  const containerId =
    service === 'api' ? 'd'.repeat(32) : service === 'web' ? '8'.repeat(32) : 'e'.repeat(32);
  return {
    schemaVersion: 'aeostudio.runtime-build-identity.v1',
    source: 'ecs-container-metadata-v4',
    service,
    taskArn: `arn:aws:ecs:ap-southeast-1:${accountId}:task/aeostudio-staging/${taskId}`,
    taskDefinitionArn:
      `arn:aws:ecs:ap-southeast-1:${accountId}:task-definition/` +
      `aeostudio-staging-${service}:${revision}`,
    containerArn:
      `arn:aws:ecs:ap-southeast-1:${accountId}:container/aeostudio-staging/` +
      `${taskId}/${containerId}`,
    image:
      `${accountId}.dkr.ecr.ap-southeast-1.amazonaws.com/aeostudio-${service}@` +
      digest(digestCharacter),
    imageDigest: digest(digestCharacter),
    imageId: digest(digestCharacter),
    capturedAt: '2026-07-23T02:55:00.000Z',
  };
}

function logRuntimeIdentity(
  service: 'api' | 'web' | 'worker',
  digestCharacter: string,
  taskId: string,
  revision: string,
) {
  const identity = runtimeIdentity(service, digestCharacter, taskId, revision);
  return {
    runtime_task_arn: identity.taskArn,
    runtime_task_definition_arn: identity.taskDefinitionArn,
    runtime_image_digest: identity.imageDigest,
    runtime_image_id: identity.imageId,
  };
}

function loadEvidence() {
  const thresholds = Object.fromEntries(
    REQUIRED_LOAD_THRESHOLD_METRICS.map((metric) => [metric, true]),
  );
  const metric = (values: Record<string, number>) => ({ thresholds: {}, values });
  return {
    schemaVersion: 'aeostudio.load-evidence.v2',
    runIdentity: loadRunIdentityFromEnvironment(loadEnvironment()),
    completedAt: '2026-07-23T03:08:00.000Z',
    finalizedAt: '2026-07-23T03:08:01.000Z',
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
    gate: { outcome: 'PASS', failedThresholds: [], thresholds },
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
    metrics: {
      aeo_read_ms: metric({ 'p(95)': 400 }),
      aeo_write_ms: metric({ 'p(95)': 900 }),
      aeo_job_ack_ms: metric({ 'p(95)': 1_900 }),
      aeo_queue_start_ms: metric({ 'p(95)': 29_000 }),
      aeo_errors: metric({ rate: 0 }),
      aeo_tenant_isolation_failures: metric({ count: 0 }),
      aeo_budget_probe_attempts: metric({ count: 10 }),
      aeo_budget_probe_blocked: metric({ count: 10 }),
      aeo_budget_probe_failures: metric({ count: 0 }),
      aeo_budget_probe_success: metric({ rate: 1 }),
      aeo_jobs_accepted: metric({ count: 50 }),
      aeo_distinct_jobs_accepted: metric({ count: 50 }),
      aeo_job_submission_failures: metric({ count: 0 }),
      aeo_job_poll_failures: metric({ count: 0 }),
      aeo_jobs_observed_started: metric({ count: 50 }),
      aeo_max_active_global: metric({ max: 50 }),
      aeo_max_active_tenant: metric({ max: 5 }),
    },
  };
}

function rawLoadEvidence() {
  const final = loadEvidence();
  return {
    schemaVersion: 'aeostudio.load-raw-summary.v2',
    runIdentity: final.runIdentity,
    completedAt: final.completedAt,
    profile: final.profile,
    gate: final.gate,
    acceptedJobs: final.acceptedJobs,
    activeJobs: final.activeJobs,
    metrics: Object.fromEntries(
      Object.entries(final.metrics).map(([name, metric]) => [
        name,
        { ...metric, thresholds: { exactGate: true } },
      ]),
    ),
  };
}

function alarmEvidence() {
  const alarms = expectedAlarmNames('staging');
  return {
    schemaVersion: 'aeostudio.synthetic-alarm-drill.v1',
    environment: 'staging',
    region: 'ap-southeast-1',
    accountId,
    drillId: 'acceptance-991-1',
    startedAt: '2026-07-23T03:08:02.000Z',
    completedAt: '2026-07-23T03:10:00.000Z',
    state: 'TRIGGERED_AND_RESET',
    alarms,
    history: alarms.map((alarmName) => ({
      alarmName,
      timestamp: '2026-07-23T03:09:00.000Z',
      summary: 'synthetic state update',
    })),
  };
}

function notCheckedFaultEvidence() {
  return {
    schemaVersion: 'aeostudio.synthetic-fault-evidence.v2',
    matrixVersion: 'aeostudio.synthetic-fault-matrix.v1',
    outcome: 'NOT_CHECKED',
    environment: 'staging',
    region: 'ap-southeast-1',
    accountId,
    drillId: 'acceptance-991-1',
    startedAt: '2026-07-23T03:08:02.000Z',
    completedAt: '2026-07-23T03:10:00.000Z',
    faults: expectedSyntheticFaultMatrix('staging').map((entry) => ({
      alarmName: entry.alarmName,
      type: entry.type,
      status: 'NOT_CHECKED',
      reasonCode: entry.notCheckedReason,
    })),
  };
}

function causalBudgetFaultEvidence() {
  const evidence = structuredClone(notCheckedFaultEvidence()) as {
    completedAt: string;
    outcome: string;
    faults: Array<Record<string, unknown>>;
    startedAt: string;
  };
  const index = expectedSyntheticFaultMatrix('staging').findIndex(
    (entry) => entry.type === 'BUDGET_HARD_STOP',
  );
  const correlationId = '018f84b3-7eb8-7c75-9ca5-25278969d307';
  const traceId = '4'.repeat(32);
  evidence.faults[index] = {
    alarmName: 'aeostudio-staging-budget-blocked',
    type: 'BUDGET_HARD_STOP',
    status: 'PASSED',
    injection: {
      kind: 'REAL_FAULT',
      injector: 'task-18-load-budget-hard-stop-v1',
      injectedAt: '2026-07-23T03:08:10.000Z',
      correlationId,
    },
    signal: {
      event: 'BUDGET_BLOCKED',
      observedAt: '2026-07-23T03:08:11.000Z',
      correlationId,
      traceId,
    },
    alarmHistory: [
      {
        alarmName: 'aeostudio-staging-budget-blocked',
        historyItemType: 'StateUpdate',
        oldState: 'OK',
        newState: 'ALARM',
        timestamp: '2026-07-23T03:09:00.000Z',
        summary: 'Threshold Crossed: one datapoint was greater than zero.',
      },
      {
        alarmName: 'aeostudio-staging-budget-blocked',
        historyItemType: 'StateUpdate',
        oldState: 'ALARM',
        newState: 'OK',
        timestamp: '2026-07-23T03:09:30.000Z',
        summary: 'Threshold Crossed: one datapoint was not breaching.',
      },
    ],
    trace: {
      correlationId,
      traceId,
      xrayTraceId: xrayId(traceId),
      found: true,
      observedAt: '2026-07-23T03:08:12.000Z',
    },
  };
  return evidence;
}

function reviewedBudgetFaultRecord() {
  const evidence = causalBudgetFaultEvidence();
  const fault = evidence.faults.find((candidate) => candidate.type === 'BUDGET_HARD_STOP')!;
  (fault.injection as Record<string, unknown>).injector = 'future-reviewed-budget-fault-v2';
  for (const item of fault.alarmHistory as Array<Record<string, unknown>>) {
    item.historyData = JSON.stringify({
      oldState: { stateValue: item.oldState },
      newState: { stateValue: item.newState },
    });
  }
  const configuration = {
    alarmName: 'aeostudio-staging-budget-blocked',
    comparisonOperator: 'GreaterThanThreshold',
    datapointsToAlarm: 1,
    evaluationPeriods: 1,
    metric: {
      dimensions: {},
      metricName: 'aeostudio-staging-budget-blocked-count',
      namespace: 'AEOStudio/Operations',
      period: 60,
      statistic: 'Sum',
    },
    threshold: 0,
    treatMissingData: 'notBreaching',
  };
  const configurationSha256 = createHash('sha256')
    .update(JSON.stringify(configuration))
    .digest('hex');
  fault.alarmConfiguration = {
    capturedAt: '2026-07-23T03:08:09.000Z',
    configuration,
    sha256: configurationSha256,
  };
  fault.breachingDatapoints = {};
  fault.cloudTrail = {};
  return { configurationSha256, evidence, fault };
}

function reviewedBudgetFaultWithMetricData() {
  const result = reviewedBudgetFaultRecord();
  result.fault.breachingDatapoints = {
    configurationSha256: result.configurationSha256,
    queryId: 'alarm_metric',
    rawMetricData: JSON.stringify({
      MetricDataResults: [
        {
          Id: 'alarm_metric',
          StatusCode: 'Complete',
          Timestamps: ['2026-07-23T03:08:30.000Z'],
          Values: [1],
        },
      ],
    }),
  };
  return result;
}

function reviewedBudgetFaultWithCompleteEvidence() {
  const result = reviewedBudgetFaultWithMetricData();
  result.fault.cloudTrail = {
    eventName: 'SetAlarmState',
    eventSource: 'monitoring.amazonaws.com',
    lookupEndAt: '2026-07-23T03:09:30.000Z',
    lookupStartAt: '2026-07-23T03:08:02.000Z',
    rawLookupEvents: JSON.stringify({ Events: [] }),
    status: 'COMPLETE',
  };
  return result;
}

function reviewedBudgetExpectedFault(configurationSha256: string) {
  return {
    alarmName: 'aeostudio-staging-budget-blocked',
    alarmConfigurationSha256: configurationSha256,
    approvedInjector: 'future-reviewed-budget-fault-v2',
    expectedSignal: 'BUDGET_BLOCKED',
    maxCausalLagSeconds: 900,
    type: 'BUDGET_HARD_STOP',
  };
}

function xrayId(traceId: string): string {
  return `1-${traceId.slice(0, 8)}-${traceId.slice(8)}`;
}

function traceEvidence() {
  return {
    schemaVersion: 'aeostudio.staging-trace-evidence.v1',
    outcome: 'PASS',
    environment: 'staging',
    repository,
    sourceSha,
    buildRunId,
    buildRunAttempt,
    releaseContract: {
      file: 'staging-release-contract.json',
      sha256: releaseContractSha256(),
    },
    taskDefinitions: brokerTaskDefinitions(),
    brokerRuntime: brokerRuntimeEvidence(),
    loadRunId,
    acceptedJobsSha256: acceptedJobIdsSha256,
    imageDigests: {
      adot: digest('d'),
      api: digest('a'),
      tenantDataBroker: digest('c'),
      web: digest('b'),
      worker: digest('c'),
    },
    endpoint: { origin: 'https://staging.example.test' },
    accountId,
    region: 'ap-southeast-1',
    correlations: {
      smokeRequest: {
        requestId: smokeRequestId,
        traceId: smokeTraceId,
        runtimeBuildIdentity: logRuntimeIdentity('api', 'a', smokeApiTaskId, '17'),
        webRuntimeBuildIdentity: logRuntimeIdentity('web', 'b', smokeWebTaskId, '19'),
        xrayTraceId: xrayId(smokeTraceId),
        xrayFound: true,
      },
      loadRequestJob: {
        requestId: loadRequestId,
        traceId: loadTraceId,
        jobId: loadJobId,
        apiRuntimeBuildIdentity: logRuntimeIdentity('api', 'a', loadApiTaskId, '17'),
        workerRuntimeBuildIdentity: logRuntimeIdentity('worker', 'c', loadWorkerTaskId, '11'),
        xrayTraceId: xrayId(loadTraceId),
        xrayFound: true,
      },
    },
  };
}

describe('Task 18 immutable staging evidence', () => {
  test('rejects v1 alarm-state history because it is not causal synthetic fault evidence', () => {
    expect(() =>
      acceptanceFinalizer.validateAlarmEvidence(alarmEvidence(), {
        accountId,
        region: 'ap-southeast-1',
      }),
    ).toThrow('ALARM_EVIDENCE_SCHEMA_UNSUPPORTED');
  });

  test('fails closed when any frozen synthetic fault has no reviewed REAL_FAULT injector', () => {
    expect(() =>
      acceptanceFinalizer.validateAlarmEvidence(notCheckedFaultEvidence(), {
        accountId,
        region: 'ap-southeast-1',
      }),
    ).toThrow('SYNTHETIC_FAULT_COVERAGE_NOT_CHECKED');
  });

  test('rejects stale v2 fault evidence from another acceptance run', () => {
    expect(() =>
      acceptanceFinalizer.validateAlarmEvidence(notCheckedFaultEvidence(), {
        acceptanceRunAttempt: '1',
        acceptanceRunId: '992',
        accountId,
        region: 'ap-southeast-1',
      }),
    ).toThrow('ALARM_DRILL_RUN_IDENTITY_MISMATCH');
  });

  test('rejects every PASSED fault while no REAL_FAULT injector is reviewed', () => {
    const expected = { accountId, region: 'ap-southeast-1' };
    expect(() =>
      acceptanceFinalizer.validateAlarmEvidence(causalBudgetFaultEvidence(), expected),
    ).toThrow('SYNTHETIC_FAULT_INJECTOR_NOT_APPROVED:BUDGET_HARD_STOP');
  });

  test('rejects manual SetAlarmState evidence that has only self-declared summary and correlation', () => {
    const evidence = causalBudgetFaultEvidence();
    const fault = evidence.faults.find((candidate) => candidate.type === 'BUDGET_HARD_STOP')!;
    (fault.injection as Record<string, unknown>).injector = 'future-reviewed-budget-fault-v2';
    fault.alarmConfiguration = {};
    fault.breachingDatapoints = {};
    fault.cloudTrail = {};

    expect(() =>
      acceptanceFinalizer.validateSyntheticFaultCausalEvidence({
        completedAt: evidence.completedAt,
        expectedFault: reviewedBudgetExpectedFault('0'.repeat(64)),
        fault,
        startedAt: evidence.startedAt,
      }),
    ).toThrow('SYNTHETIC_FAULT_CLOUDWATCH_HISTORY_DATA_INVALID:BUDGET_HARD_STOP');
  });

  test('binds future causal evidence to the exact reviewed alarm metric configuration', () => {
    const { evidence, fault } = reviewedBudgetFaultRecord();

    expect(() =>
      acceptanceFinalizer.validateSyntheticFaultCausalEvidence({
        completedAt: evidence.completedAt,
        expectedFault: reviewedBudgetExpectedFault('0'.repeat(64)),
        fault,
        startedAt: evidence.startedAt,
      }),
    ).toThrow('SYNTHETIC_FAULT_ALARM_CONFIGURATION_MISMATCH:BUDGET_HARD_STOP');
  });

  test('requires raw CloudWatch metric data with enough breaching datapoints', () => {
    const { configurationSha256, evidence, fault } = reviewedBudgetFaultRecord();

    expect(() =>
      acceptanceFinalizer.validateSyntheticFaultCausalEvidence({
        completedAt: evidence.completedAt,
        expectedFault: reviewedBudgetExpectedFault(configurationSha256),
        fault,
        startedAt: evidence.startedAt,
      }),
    ).toThrow('SYNTHETIC_FAULT_BREACHING_DATAPOINTS_INVALID:BUDGET_HARD_STOP');
  });

  test('rejects a manual SetAlarmState event inside the causal CloudTrail window', () => {
    const { configurationSha256, evidence, fault } = reviewedBudgetFaultWithMetricData();
    fault.cloudTrail = {
      eventName: 'SetAlarmState',
      eventSource: 'monitoring.amazonaws.com',
      lookupEndAt: '2026-07-23T03:09:30.000Z',
      lookupStartAt: '2026-07-23T03:08:02.000Z',
      rawLookupEvents: JSON.stringify({
        Events: [
          {
            EventId: '018f84b3-7eb8-7c75-9ca5-25278969d309',
            EventName: 'SetAlarmState',
            EventSource: 'monitoring.amazonaws.com',
            EventTime: '2026-07-23T03:08:45.000Z',
          },
        ],
      }),
      status: 'COMPLETE',
    };

    expect(() =>
      acceptanceFinalizer.validateSyntheticFaultCausalEvidence({
        completedAt: evidence.completedAt,
        expectedFault: reviewedBudgetExpectedFault(configurationSha256),
        fault,
        startedAt: evidence.startedAt,
      }),
    ).toThrow('SYNTHETIC_FAULT_CLOUDTRAIL_SET_ALARM_STATE_DETECTED:BUDGET_HARD_STOP');
  });

  test('accepts a future reviewed record only with raw causal CloudWatch and CloudTrail evidence', () => {
    const { configurationSha256, evidence, fault } = reviewedBudgetFaultWithCompleteEvidence();

    expect(() =>
      acceptanceFinalizer.validateSyntheticFaultCausalEvidence({
        completedAt: evidence.completedAt,
        expectedFault: reviewedBudgetExpectedFault(configurationSha256),
        fault,
        startedAt: evidence.startedAt,
      }),
    ).not.toThrow();
  });

  test('accepts the real GetMetricData shape with optional labels and empty messages', () => {
    const { configurationSha256, evidence, fault } = reviewedBudgetFaultWithCompleteEvidence();
    const breachingDatapoints = fault.breachingDatapoints as Record<string, unknown>;
    breachingDatapoints.rawMetricData = JSON.stringify({
      Messages: [],
      MetricDataResults: [
        {
          Id: 'alarm_metric',
          Label: 'AEOStudio/Operations budget blocked count',
          Messages: [],
          StatusCode: 'Complete',
          Timestamps: ['2026-07-23T03:08:30.000Z'],
          Values: [1],
        },
      ],
    });

    expect(() =>
      acceptanceFinalizer.validateSyntheticFaultCausalEvidence({
        completedAt: evidence.completedAt,
        expectedFault: reviewedBudgetExpectedFault(configurationSha256),
        fault,
        startedAt: evidence.startedAt,
      }),
    ).not.toThrow();
  });

  test('accepts a breaching period that starts before injection but overlaps the causal window', () => {
    const { configurationSha256, evidence, fault } = reviewedBudgetFaultWithCompleteEvidence();
    const breachingDatapoints = fault.breachingDatapoints as Record<string, unknown>;
    breachingDatapoints.rawMetricData = JSON.stringify({
      MetricDataResults: [
        {
          Id: 'alarm_metric',
          StatusCode: 'Complete',
          Timestamps: ['2026-07-23T03:08:00.000Z'],
          Values: [1],
        },
      ],
    });

    expect(() =>
      acceptanceFinalizer.validateSyntheticFaultCausalEvidence({
        completedAt: evidence.completedAt,
        expectedFault: reviewedBudgetExpectedFault(configurationSha256),
        fault,
        startedAt: evidence.startedAt,
      }),
    ).not.toThrow();
  });

  test.each([0, 7, 60.5])(
    'rejects invalid CloudWatch metric period %s even when its reviewed hash is self-consistent',
    (period) => {
      const { evidence, fault } = reviewedBudgetFaultWithCompleteEvidence();
      const alarmConfiguration = fault.alarmConfiguration as Record<string, unknown>;
      const configuration = alarmConfiguration.configuration as Record<string, unknown>;
      const metric = configuration.metric as Record<string, unknown>;
      metric.period = period;
      const configurationSha256 = createHash('sha256')
        .update(JSON.stringify(configuration))
        .digest('hex');
      alarmConfiguration.sha256 = configurationSha256;
      const breachingDatapoints = fault.breachingDatapoints as Record<string, unknown>;
      breachingDatapoints.configurationSha256 = configurationSha256;

      expect(() =>
        acceptanceFinalizer.validateSyntheticFaultCausalEvidence({
          completedAt: evidence.completedAt,
          expectedFault: reviewedBudgetExpectedFault(configurationSha256),
          fault,
          startedAt: evidence.startedAt,
        }),
      ).toThrow('SYNTHETIC_FAULT_ALARM_CONFIGURATION_INVALID:BUDGET_HARD_STOP');
    },
  );

  test('rejects paginated GetMetricData evidence instead of accepting an incomplete window', () => {
    const { configurationSha256, evidence, fault } = reviewedBudgetFaultWithCompleteEvidence();
    const breachingDatapoints = fault.breachingDatapoints as Record<string, unknown>;
    breachingDatapoints.rawMetricData = JSON.stringify({
      Messages: [],
      MetricDataResults: [
        {
          Id: 'alarm_metric',
          Label: 'AEOStudio/Operations budget blocked count',
          StatusCode: 'Complete',
          Timestamps: ['2026-07-23T03:08:30.000Z'],
          Values: [1],
        },
      ],
      NextToken: 'uncollected-next-page',
    });

    expect(() =>
      acceptanceFinalizer.validateSyntheticFaultCausalEvidence({
        completedAt: evidence.completedAt,
        expectedFault: reviewedBudgetExpectedFault(configurationSha256),
        fault,
        startedAt: evidence.startedAt,
      }),
    ).toThrow('SYNTHETIC_FAULT_BREACHING_DATAPOINTS_INVALID:BUDGET_HARD_STOP');
  });

  test.each([
    {
      location: 'operation',
      rawMetricData: {
        Messages: [{ Code: 'DataTruncated', Value: 'The operation was incomplete.' }],
        MetricDataResults: [
          {
            Id: 'alarm_metric',
            StatusCode: 'Complete',
            Timestamps: ['2026-07-23T03:08:30.000Z'],
            Values: [1],
          },
        ],
      },
    },
    {
      location: 'metric result',
      rawMetricData: {
        Messages: [],
        MetricDataResults: [
          {
            Id: 'alarm_metric',
            Messages: [{ Code: 'DataTruncated', Value: 'The metric was incomplete.' }],
            StatusCode: 'Complete',
            Timestamps: ['2026-07-23T03:08:30.000Z'],
            Values: [1],
          },
        ],
      },
    },
  ])('rejects non-empty GetMetricData messages at the $location level', ({ rawMetricData }) => {
    const { configurationSha256, evidence, fault } = reviewedBudgetFaultWithCompleteEvidence();
    const breachingDatapoints = fault.breachingDatapoints as Record<string, unknown>;
    breachingDatapoints.rawMetricData = JSON.stringify(rawMetricData);

    expect(() =>
      acceptanceFinalizer.validateSyntheticFaultCausalEvidence({
        completedAt: evidence.completedAt,
        expectedFault: reviewedBudgetExpectedFault(configurationSha256),
        fault,
        startedAt: evidence.startedAt,
      }),
    ).toThrow('SYNTHETIC_FAULT_BREACHING_DATAPOINTS_INVALID:BUDGET_HARD_STOP');
  });

  test('rejects causal fault evidence without an ALARM to OK recovery transition', () => {
    const { configurationSha256, evidence, fault } = reviewedBudgetFaultWithCompleteEvidence();
    fault.alarmHistory = (fault.alarmHistory as unknown[]).slice(0, 1);

    expect(() =>
      acceptanceFinalizer.validateSyntheticFaultCausalEvidence({
        completedAt: evidence.completedAt,
        expectedFault: reviewedBudgetExpectedFault(configurationSha256),
        fault,
        startedAt: evidence.startedAt,
      }),
    ).toThrow('SYNTHETIC_FAULT_ALARM_RECOVERY_MISSING:BUDGET_HARD_STOP');
  });

  test('commits the k6 raw summary once with private permissions before finalization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeostudio-write-once-'));
    const sourcePath = join(directory, 'k6.tmp.json');
    const targetPath = join(directory, 'task-18-load-raw-summary.json');
    const bytes = '{"schemaVersion":"aeostudio.load-raw-summary.v2"}\n';
    await writeFile(sourcePath, bytes);

    await writeOnce.commitWriteOnceFile({ sourcePath, targetPath });
    expect(await readFile(targetPath, 'utf8')).toBe(bytes);
    if (process.platform !== 'win32') {
      expect((await stat(targetPath)).mode & 0o777).toBe(0o600);
    }
    await writeFile(sourcePath, '{"replacement":true}\n');
    await expect(writeOnce.commitWriteOnceFile({ sourcePath, targetPath })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(targetPath, 'utf8')).toBe(bytes);
  });

  test('queries CloudWatch and X-Ray for the exact smoke request and a correlated load request/job', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeostudio-trace-evidence-'));
    const smokePath = join(directory, 'smoke.json');
    const loadPath = join(directory, 'load.json');
    const releaseContractPath = join(directory, 'staging-release-contract.json');
    const tracePath = join(directory, 'trace.json');
    await writeFile(smokePath, JSON.stringify(smokeEnvelope()));
    await writeFile(loadPath, JSON.stringify(loadEvidence()));
    await writeFile(releaseContractPath, releaseContractRaw());
    const queryKinds = new Map<string, 'smoke' | 'worker' | 'load-api'>();
    const queries: string[] = [];
    let querySequence = 0;

    const runAws = (args: string[]) => {
      if (args[0] === 'sts') return { Account: accountId };
      if (args[0] === 'logs' && args[1] === 'start-query') {
        const queryId = `query-${String(++querySequence)}`;
        const query = args[args.indexOf('--query-string') + 1] ?? '';
        queries.push(query);
        const logGroup = args[args.indexOf('--log-group-name') + 1] ?? '';
        queryKinds.set(
          queryId,
          query.includes(smokeRequestId)
            ? 'smoke'
            : logGroup.endsWith('/worker')
              ? 'worker'
              : 'load-api',
        );
        return { queryId };
      }
      if (args[0] === 'logs' && args[1] === 'get-query-results') {
        const queryId = args[args.indexOf('--query-id') + 1] ?? '';
        const kind = queryKinds.get(queryId);
        const values =
          kind === 'smoke'
            ? [
                {
                  '@timestamp': '2026-07-23 03:00:30.000',
                  event: 'HTTP_REQUEST_COMPLETED',
                  request_id: smokeRequestId,
                  trace_id: smokeTraceId,
                  ...logRuntimeIdentity('api', 'a', smokeApiTaskId, '17'),
                },
              ]
            : kind === 'worker'
              ? [
                  {
                    '@timestamp': '2026-07-23 03:02:30.000',
                    event: 'WORKER_JOB_RECEIVED',
                    request_id: backgroundRequestId,
                    trace_id: backgroundTraceId,
                    job_id: backgroundJobId,
                  },
                  {
                    '@timestamp': '2026-07-23 03:03:00.000',
                    event: 'WORKER_JOB_RECEIVED',
                    request_id: loadRequestId,
                    trace_id: loadTraceId,
                    job_id: loadJobId,
                    ...logRuntimeIdentity('worker', 'c', loadWorkerTaskId, '11'),
                  },
                ]
              : [
                  {
                    '@timestamp': '2026-07-23 03:02:59.000',
                    event: 'HTTP_REQUEST_COMPLETED',
                    request_id: loadRequestId,
                    trace_id: loadTraceId,
                    ...logRuntimeIdentity('api', 'a', loadApiTaskId, '17'),
                  },
                ];
        return {
          status: 'Complete',
          results: values.map((row) =>
            Object.entries(row).map(([field, value]) => ({ field, value })),
          ),
        };
      }
      if (args[0] === 'xray' && args[1] === 'batch-get-traces') {
        return {
          Traces: [{ Id: xrayId(smokeTraceId) }, { Id: xrayId(loadTraceId) }],
          UnprocessedTraceIds: [],
        };
      }
      throw new Error(`UNEXPECTED_AWS_CALL:${args.join(' ')}`);
    };

    await expect(
      traceCollector.collectStagingTraceEvidence({
        accountId,
        apiLogGroup: '/ecs/aeostudio-staging/api',
        buildRunAttempt,
        buildRunId,
        delay: () => Promise.resolve(),
        loadEvidencePath: loadPath,
        loadStartedAt: '2026-07-23T03:02:00.000Z',
        outputPath: tracePath,
        region: 'ap-southeast-1',
        releaseContractPath,
        repository,
        runAws,
        smokeEnvelopePath: smokePath,
        sourceSha,
        workerLogGroup: '/ecs/aeostudio-staging/worker',
      }),
    ).resolves.toEqual({ evidencePath: tracePath, outcome: 'PASS' });

    const trace = JSON.parse(await readFile(tracePath, 'utf8')) as Record<string, unknown>;
    expect(trace).toMatchObject({
      schemaVersion: 'aeostudio.staging-trace-evidence.v1',
      outcome: 'PASS',
      repository,
      sourceSha,
      buildRunId,
      buildRunAttempt,
      releaseContract: {
        file: 'staging-release-contract.json',
        sha256: releaseContractSha256(),
      },
      taskDefinitions: brokerTaskDefinitions(),
      accountId,
      region: 'ap-southeast-1',
      loadRunId,
      acceptedJobsSha256: acceptedJobIdsSha256,
      endpoint: { origin: 'https://staging.example.test' },
      correlations: {
        smokeRequest: {
          requestId: smokeRequestId,
          traceId: smokeTraceId,
          runtimeBuildIdentity: logRuntimeIdentity('api', 'a', smokeApiTaskId, '17'),
          webRuntimeBuildIdentity: logRuntimeIdentity('web', 'b', smokeWebTaskId, '19'),
          xrayTraceId: xrayId(smokeTraceId),
          xrayFound: true,
        },
        loadRequestJob: {
          requestId: loadRequestId,
          traceId: loadTraceId,
          jobId: loadJobId,
          apiRuntimeBuildIdentity: logRuntimeIdentity('api', 'a', loadApiTaskId, '17'),
          workerRuntimeBuildIdentity: logRuntimeIdentity('worker', 'c', loadWorkerTaskId, '11'),
          xrayTraceId: xrayId(loadTraceId),
          xrayFound: true,
        },
      },
    });
    expect(queries.find((query) => query.includes('WORKER_JOB_RECEIVED'))).toContain(
      `request_id = "${loadRunId}"`,
    );
    expect(JSON.stringify(trace)).not.toMatch(/@message|authorization|cookie|prompt|token/iu);
    if (process.platform !== 'win32') {
      expect((await stat(tracePath)).mode & 0o777).toBe(0o600);
    }
  });

  test('refuses to finalize an acceptance envelope while frozen fault coverage is NOT_CHECKED', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeostudio-acceptance-evidence-'));
    const paths = {
      acceptance: join(directory, 'acceptance.json'),
      alarm: join(directory, 'alarm.json'),
      load: join(directory, 'load.json'),
      loadRaw: join(directory, 'loadRaw.json'),
      release: join(directory, 'release.json'),
      releaseContract: join(directory, 'staging-release-contract.json'),
      smoke: join(directory, 'smoke.json'),
      trace: join(directory, 'trace.json'),
    };
    await writeFile(paths.release, JSON.stringify(releaseManifest()));
    await writeFile(paths.releaseContract, releaseContractRaw());
    await writeFile(paths.smoke, JSON.stringify(smokeEnvelope()));
    await writeFile(paths.loadRaw, JSON.stringify(rawLoadEvidence()));
    await writeFile(paths.load, JSON.stringify(loadEvidence()));
    await writeFile(paths.alarm, JSON.stringify(notCheckedFaultEvidence()));
    await writeFile(paths.trace, JSON.stringify(traceEvidence()));

    const input = {
      accountId,
      alarmEvidencePath: paths.alarm,
      buildRunAttempt,
      buildRunId,
      loadEvidencePath: paths.load,
      rawLoadEvidencePath: paths.loadRaw,
      outputPath: paths.acceptance,
      region: 'ap-southeast-1',
      releaseContractPath: paths.releaseContract,
      releaseManifestPath: paths.release,
      repository,
      smokeEnvelopePath: paths.smoke,
      sourceSha,
      traceEvidencePath: paths.trace,
      workflowRunAttempt: '1',
      workflowRunId: '991',
    };
    await expect(acceptanceFinalizer.finalizeStagingAcceptanceEvidence(input)).rejects.toThrow(
      'SYNTHETIC_FAULT_COVERAGE_NOT_CHECKED',
    );
    await expect(readFile(paths.acceptance, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('production validation rejects any accepted-job hash or traced-job drift', () => {
    const load = loadEvidence();
    const rawLoad = rawLoadEvidence();
    const trace = traceEvidence();
    const envelope = {
      loadTraceBinding: {
        loadRunId,
        acceptedJobCount: 50,
        acceptedJobIdsSha256,
        tracedJobId: loadJobId,
      },
      runtimeDeploymentBinding: {
        endpointOrigin: 'https://staging.example.test',
        smokeApiTaskArn: runtimeIdentity('api', 'a', smokeApiTaskId, '17').taskArn,
        smokeApiTaskDefinitionArn: brokerTaskDefinitions().api,
        smokeWebTaskArn: runtimeIdentity('web', 'b', smokeWebTaskId, '19').taskArn,
        smokeWebTaskDefinitionArn: runtimeIdentity('web', 'b', smokeWebTaskId, '19')
          .taskDefinitionArn,
        smokeWebImageDigest: digest('b'),
        smokeWebImageId: digest('b'),
        loadApiTaskArn: runtimeIdentity('api', 'a', loadApiTaskId, '17').taskArn,
        loadApiTaskDefinitionArn: brokerTaskDefinitions().api,
        loadWorkerTaskArn: runtimeIdentity('worker', 'c', loadWorkerTaskId, '11').taskArn,
        loadWorkerTaskDefinitionArn: brokerTaskDefinitions().worker,
        tenantDataBrokerTaskDefinitionArn: brokerTaskDefinitions().tenantDataBroker,
        tenantDataBrokerDesiredCount: 2,
        tenantDataBrokerRunningCount: 2,
        tenantDataBrokerHealthyTargetCount: 2,
        tenantDataBrokerImageDigest: digest('c'),
        adotImageDigest: digest('d'),
        adotRuntimeDigest: digest('e'),
        apiImageDigest: digest('a'),
        workerImageDigest: digest('c'),
      },
    };
    expect(() =>
      promotionValidator.validateProductionLoadTraceBinding({
        envelope,
        load,
        rawLoad,
        trace,
      }),
    ).not.toThrow();

    const driftedEnvelope = structuredClone(envelope);
    driftedEnvelope.loadTraceBinding.acceptedJobIdsSha256 = '0'.repeat(64);
    expect(() =>
      promotionValidator.validateProductionLoadTraceBinding({
        envelope: driftedEnvelope,
        load,
        rawLoad,
        trace,
      }),
    ).toThrow('ACCEPTANCE_LOAD_TRACE_BINDING_MISMATCH');

    const driftedTraceHash = structuredClone(trace);
    driftedTraceHash.acceptedJobsSha256 = '0'.repeat(64);
    expect(() =>
      promotionValidator.validateProductionLoadTraceBinding({
        envelope,
        load,
        rawLoad,
        trace: driftedTraceHash,
      }),
    ).toThrow('ACCEPTANCE_LOAD_TRACE_BINDING_MISMATCH');

    const backgroundTrace = structuredClone(trace);
    backgroundTrace.correlations.loadRequestJob.jobId = backgroundJobId;
    expect(() =>
      promotionValidator.validateProductionLoadTraceBinding({
        envelope,
        load,
        rawLoad,
        trace: backgroundTrace,
      }),
    ).toThrow('ACCEPTANCE_LOAD_TRACE_JOB_NOT_ACCEPTED');

    const manifestOnlyRuntime = structuredClone(trace);
    manifestOnlyRuntime.correlations.loadRequestJob.workerRuntimeBuildIdentity.runtime_image_digest =
      digest('a');
    expect(() =>
      promotionValidator.validateProductionLoadTraceBinding({
        envelope,
        load,
        rawLoad,
        trace: manifestOnlyRuntime,
      }),
    ).toThrow('LOAD_WORKER_RUNTIME_IDENTITY_MISMATCH');

    for (const mutate of [
      (runtime: ReturnType<typeof brokerRuntimeEvidence>) => {
        runtime.tasks.pop();
      },
      (runtime: ReturnType<typeof brokerRuntimeEvidence>) => {
        runtime.tasks[1] = structuredClone(runtime.tasks[0]);
      },
      (runtime: ReturnType<typeof brokerRuntimeEvidence>) => {
        runtime.tasks[0].taskArn = runtime.tasks[0].taskArn.replace(
          '/aeostudio-staging/',
          '/aeostudio-production/',
        );
      },
      (runtime: ReturnType<typeof brokerRuntimeEvidence>) => {
        runtime.tasks[0].brokerRuntimeDigest = digest('a');
      },
      (runtime: ReturnType<typeof brokerRuntimeEvidence>) => {
        runtime.tasks.reverse();
      },
    ]) {
      const invalidBrokerTasks = structuredClone(trace);
      mutate(invalidBrokerTasks.brokerRuntime);
      expect(() =>
        promotionValidator.validateProductionLoadTraceBinding({
          envelope,
          load,
          rawLoad,
          trace: invalidBrokerTasks,
        }),
      ).toThrow('TRACE_TENANT_DATA_BROKER_RUNTIME_INVALID');
    }
  });

  test('staging finalization cannot use a background worker job as the load trace', () => {
    const trace = traceEvidence();
    trace.correlations.loadRequestJob.jobId = backgroundJobId;
    expect(() =>
      acceptanceFinalizer.validateTraceEvidence(
        trace,
        {
          repository,
          sourceSha,
          buildRunId,
          buildRunAttempt,
          accountId,
          region: 'ap-southeast-1',
        },
        releaseImageDigests(),
        loadEvidence(),
        brokerTaskDefinitions(),
      ),
    ).toThrow('LOAD_TRACE_JOB_NOT_ACCEPTED');
  });

  test('production validation rejects a manifest-only or drifted runtime image identity', () => {
    const trace = traceEvidence();
    trace.correlations.loadRequestJob.workerRuntimeBuildIdentity.runtime_image_digest = digest('a');
    expect(() =>
      acceptanceFinalizer.validateTraceEvidence(
        trace,
        {
          repository,
          sourceSha,
          buildRunId,
          buildRunAttempt,
          accountId,
          region: 'ap-southeast-1',
        },
        releaseImageDigests(),
        loadEvidence(),
        brokerTaskDefinitions(),
      ),
    ).toThrow('LOAD_WORKER_RUNTIME_IDENTITY_MISMATCH');

    const webManifestOnly = traceEvidence();
    webManifestOnly.correlations.smokeRequest.webRuntimeBuildIdentity.runtime_image_digest =
      digest('a');
    expect(() =>
      acceptanceFinalizer.validateTraceEvidence(
        webManifestOnly,
        {
          repository,
          sourceSha,
          buildRunId,
          buildRunAttempt,
          accountId,
          region: 'ap-southeast-1',
        },
        releaseImageDigests(),
        loadEvidence(),
        brokerTaskDefinitions(),
      ),
    ).toThrow('SMOKE_WEB_RUNTIME_IDENTITY_MISMATCH');

    const webImageIdDrift = traceEvidence();
    webImageIdDrift.correlations.smokeRequest.webRuntimeBuildIdentity.runtime_image_id =
      digest('a');
    expect(() =>
      acceptanceFinalizer.validateTraceEvidence(
        webImageIdDrift,
        {
          repository,
          sourceSha,
          buildRunId,
          buildRunAttempt,
          accountId,
          region: 'ap-southeast-1',
        },
        releaseImageDigests(),
        loadEvidence(),
        brokerTaskDefinitions(),
      ),
    ).toThrow('SMOKE_WEB_RUNTIME_IDENTITY_MISMATCH');

    const staleTaskDefinition = traceEvidence();
    staleTaskDefinition.correlations.loadRequestJob.apiRuntimeBuildIdentity.runtime_task_definition_arn = `arn:aws:ecs:ap-southeast-1:${accountId}:task-definition/aeostudio-staging-api:18`;
    expect(() =>
      acceptanceFinalizer.validateTraceEvidence(
        staleTaskDefinition,
        {
          repository,
          sourceSha,
          buildRunId,
          buildRunAttempt,
          accountId,
          region: 'ap-southeast-1',
        },
        releaseImageDigests(),
        loadEvidence(),
        brokerTaskDefinitions(),
      ),
    ).toThrow('LOAD_API_TASK_DEFINITION_MISMATCH');
  });
});
