/* global process */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { REQUIRED_LOAD_THRESHOLD_METRICS } from '../load/task-18-load-contract.mjs';
import { validateAcceptedJobsEvidence } from '../load/accepted-job-evidence.mjs';
import { validateActiveJobsEvidence } from '../load/active-job-evidence.mjs';
import { expectedSyntheticFaultMatrix } from '../observability/synthetic-alarm-contract.mjs';
import { readStagingReleaseContractEvidence } from './staging-release-contract-evidence.mjs';
import { validateTenantDataBrokerRuntimeEvidence } from './tenant-data-broker-runtime-evidence.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TRACE_ID = /^[0-9a-f]{32}$/u;
const XRAY_TRACE_ID = /^1-[0-9a-f]{8}-[0-9a-f]{24}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ECS_TASK_ARN =
  /^arn:aws:ecs:ap-southeast-1:(?<account>[0-9]{12}):task\/[A-Za-z0-9_-]{1,255}\/[0-9a-f]{32}$/u;
const ECS_TASK_DEFINITION_ARN =
  /^arn:aws:ecs:ap-southeast-1:(?<account>[0-9]{12}):task-definition\/[A-Za-z0-9_-]{1,255}:[1-9][0-9]{0,9}$/u;

export async function finalizeStagingAcceptanceEvidence(input) {
  const expected = {
    repository: exactRepository(input.repository),
    sourceSha: exact(input.sourceSha, SHA, 'SOURCE_SHA_INVALID'),
    buildRunId: exact(input.buildRunId, POSITIVE_INTEGER, 'BUILD_RUN_ID_INVALID'),
    buildRunAttempt: exact(input.buildRunAttempt, POSITIVE_INTEGER, 'BUILD_RUN_ATTEMPT_INVALID'),
    workflowRunId: exact(input.workflowRunId, POSITIVE_INTEGER, 'WORKFLOW_RUN_ID_INVALID'),
    workflowRunAttempt: exact(
      input.workflowRunAttempt,
      POSITIVE_INTEGER,
      'WORKFLOW_RUN_ATTEMPT_INVALID',
    ),
    accountId: exact(input.accountId, ACCOUNT_ID, 'AWS_ACCOUNT_ID_INVALID'),
    region: input.region,
  };
  if (expected.region !== 'ap-southeast-1') throw new Error('AWS_REGION_INVALID');

  const release = await evidenceFile(input.releaseManifestPath, 'RELEASE_MANIFEST_INVALID');
  const smoke = await evidenceFile(input.smokeEnvelopePath, 'SMOKE_ENVELOPE_INVALID');
  const rawLoad = await evidenceFile(input.rawLoadEvidencePath, 'LOAD_RAW_SUMMARY_INVALID');
  const load = await evidenceFile(input.loadEvidencePath, 'LOAD_EVIDENCE_INVALID');
  const alarm = await evidenceFile(input.alarmEvidencePath, 'ALARM_EVIDENCE_INVALID');
  const trace = await evidenceFile(input.traceEvidencePath, 'TRACE_EVIDENCE_INVALID');

  const imageDigests = validateRelease(release.value, expected);
  const releaseContract = await readStagingReleaseContractEvidence({
    path: input.releaseContractPath,
    expected,
    imageDigests,
  });
  const smokeBinding = validateSmoke(
    smoke.value,
    expected,
    imageDigests,
    releaseContract.taskDefinitions,
  );
  const loadBinding = validateLoadEvidence(load.value, expected, imageDigests);
  validateRawLoadEvidence(rawLoad.value, load.value);
  validateAlarmEvidence(alarm.value, expected);
  const traceBinding = validateTraceEvidence(
    trace.value,
    expected,
    imageDigests,
    load.value,
    releaseContract.taskDefinitions,
    releaseContract.binding,
  );
  if (
    smokeBinding.endpointOrigin !== traceBinding.endpointOrigin ||
    !sameJson(smokeBinding.brokerRuntime, traceBinding.brokerRuntime) ||
    !sameJson(smokeBinding.runtimeBuildIdentity, traceBinding.smokeApiRuntimeBuildIdentity) ||
    !sameJson(smokeBinding.webRuntimeBuildIdentity, traceBinding.smokeWebRuntimeBuildIdentity)
  ) {
    throw new Error('SMOKE_TRACE_RUNTIME_IDENTITY_MISMATCH');
  }

  const outputPath = resolve(input.outputPath);
  const envelope = {
    schemaVersion: 'aeostudio.staging-acceptance-evidence.v1',
    outcome: 'PASSED',
    environment: 'staging',
    repository: expected.repository,
    sourceSha: expected.sourceSha,
    buildRunId: expected.buildRunId,
    buildRunAttempt: expected.buildRunAttempt,
    workflowRunId: expected.workflowRunId,
    workflowRunAttempt: expected.workflowRunAttempt,
    imageDigests,
    accountId: expected.accountId,
    region: expected.region,
    loadTraceBinding: {
      loadRunId: loadBinding.loadRunId,
      acceptedJobCount: loadBinding.acceptedJobs.count,
      acceptedJobIdsSha256: loadBinding.acceptedJobs.sha256,
      tracedJobId: traceBinding.tracedJobId,
    },
    runtimeDeploymentBinding: {
      endpointOrigin: traceBinding.endpointOrigin,
      smokeApiTaskArn: traceBinding.smokeApiRuntimeBuildIdentity.runtime_task_arn,
      smokeApiTaskDefinitionArn:
        traceBinding.smokeApiRuntimeBuildIdentity.runtime_task_definition_arn,
      smokeWebTaskArn: traceBinding.smokeWebRuntimeBuildIdentity.runtime_task_arn,
      smokeWebTaskDefinitionArn:
        traceBinding.smokeWebRuntimeBuildIdentity.runtime_task_definition_arn,
      smokeWebImageDigest: traceBinding.smokeWebRuntimeBuildIdentity.runtime_image_digest,
      smokeWebImageId: traceBinding.smokeWebRuntimeBuildIdentity.runtime_image_id,
      loadApiTaskArn: traceBinding.loadApiRuntimeBuildIdentity.runtime_task_arn,
      loadApiTaskDefinitionArn:
        traceBinding.loadApiRuntimeBuildIdentity.runtime_task_definition_arn,
      loadWorkerTaskArn: traceBinding.loadWorkerRuntimeBuildIdentity.runtime_task_arn,
      loadWorkerTaskDefinitionArn:
        traceBinding.loadWorkerRuntimeBuildIdentity.runtime_task_definition_arn,
      tenantDataBrokerTaskDefinitionArn: smokeBinding.brokerRuntime.taskDefinitionArn,
      tenantDataBrokerDesiredCount: smokeBinding.brokerRuntime.desiredCount,
      tenantDataBrokerRunningCount: smokeBinding.brokerRuntime.runningCount,
      tenantDataBrokerHealthyTargetCount: smokeBinding.brokerRuntime.healthyTargetCount,
      tenantDataBrokerImageDigest: imageDigests.tenantDataBroker,
      adotImageDigest: imageDigests.adot,
      adotRuntimeDigest: smokeBinding.brokerRuntime.adotRuntimeDigest,
      apiImageDigest: imageDigests.api,
      workerImageDigest: imageDigests.worker,
    },
    completedAt: (input.now ?? (() => new Date()))().toISOString(),
    evidence: {
      releaseContract: releaseContract.binding,
      loadRaw: { file: basename(rawLoad.path), sha256: rawLoad.sha256 },
      load: { file: basename(load.path), sha256: load.sha256 },
      alarm: { file: basename(alarm.path), sha256: alarm.sha256 },
      trace: { file: basename(trace.path), sha256: trace.sha256 },
    },
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return { outcome: 'PASS', evidencePath: outputPath };
}

export function validateLoadEvidence(value, expected, imageDigests) {
  const load = object(value, 'LOAD_EVIDENCE_INVALID');
  const identity = object(load.runIdentity, 'LOAD_RUN_IDENTITY_INVALID');
  const digests = object(identity.releaseImageDigests, 'LOAD_DIGESTS_INVALID');
  const approvedOrigin = exactHttpsOrigin(identity.approvedOrigin, 'LOAD_APPROVED_ORIGIN_INVALID');
  if (
    load.schemaVersion !== 'aeostudio.load-evidence.v2' ||
    identity.environment !== 'staging' ||
    identity.region !== expected.region ||
    identity.awsAccountId !== expected.accountId ||
    identity.buildRunId !== expected.buildRunId ||
    identity.buildRunAttempt !== expected.buildRunAttempt ||
    identity.approvedHost !== new URL(approvedOrigin).host ||
    !sameStringSet(Object.keys(digests), ['adot', 'api', 'tenantDataBroker', 'web', 'worker']) ||
    digests.adot !== imageDigests.adot ||
    digests.api !== imageDigests.api ||
    digests.tenantDataBroker !== imageDigests.tenantDataBroker ||
    digests.web !== imageDigests.web ||
    digests.worker !== imageDigests.worker
  ) {
    throw new Error('LOAD_RELEASE_IDENTITY_MISMATCH');
  }
  timestamp(load.completedAt, 'LOAD_COMPLETED_AT_INVALID');
  timestamp(load.finalizedAt, 'LOAD_FINALIZED_AT_INVALID');

  const profile = object(load.profile, 'LOAD_PROFILE_INVALID');
  if (
    profile.distinctSessions !== 100 ||
    profile.concurrentJobSubmissions !== 50 ||
    profile.jobsPerTenant !== 5 ||
    profile.budgetProbes !== 10 ||
    profile.requiredObservedStartedJobs !== 50 ||
    profile.requiredMaxActiveGlobal !== 50 ||
    profile.maximumActiveJobsPerTenant !== 5 ||
    profile.processingObservationDefinition !==
      'same completed polling round; RUNNING only; terminal states excluded'
  ) {
    throw new Error('LOAD_PROFILE_INVALID');
  }
  const gate = object(load.gate, 'LOAD_GATE_INVALID');
  const thresholds = object(gate.thresholds, 'LOAD_THRESHOLDS_INVALID');
  if (
    gate.outcome !== 'PASS' ||
    !Array.isArray(gate.failedThresholds) ||
    gate.failedThresholds.length !== 0 ||
    !sameStringSet(Object.keys(thresholds), REQUIRED_LOAD_THRESHOLD_METRICS) ||
    REQUIRED_LOAD_THRESHOLD_METRICS.some((metric) => thresholds[metric] !== true)
  ) {
    throw new Error('LOAD_THRESHOLDS_FAILED');
  }

  const metrics = object(load.metrics, 'LOAD_METRICS_INVALID');
  boundedMetric(metrics, 'aeo_read_ms', 'p(95)', (value) => value <= 500);
  boundedMetric(metrics, 'aeo_write_ms', 'p(95)', (value) => value <= 1_000);
  boundedMetric(metrics, 'aeo_job_ack_ms', 'p(95)', (value) => value <= 2_000);
  boundedMetric(metrics, 'aeo_queue_start_ms', 'p(95)', (value) => value <= 30_000);
  boundedMetric(metrics, 'aeo_errors', 'rate', (value) => value >= 0 && value < 0.01);
  exactMetric(metrics, 'aeo_tenant_isolation_failures', 'count', 0);
  exactMetric(metrics, 'aeo_budget_probe_attempts', 'count', 10);
  exactMetric(metrics, 'aeo_budget_probe_blocked', 'count', 10);
  exactMetric(metrics, 'aeo_budget_probe_failures', 'count', 0);
  exactMetric(metrics, 'aeo_budget_probe_success', 'rate', 1);
  exactMetric(metrics, 'aeo_jobs_accepted', 'count', 50);
  exactMetric(metrics, 'aeo_distinct_jobs_accepted', 'count', 50);
  exactMetric(metrics, 'aeo_job_submission_failures', 'count', 0);
  exactMetric(metrics, 'aeo_job_poll_failures', 'count', 0);
  exactMetric(metrics, 'aeo_jobs_observed_started', 'count', 50);
  boundedMetric(metrics, 'aeo_max_active_global', 'max', (value) => value >= 50);
  boundedMetric(metrics, 'aeo_max_active_tenant', 'max', (value) => value <= 5);
  const acceptedJobs = validateAcceptedJobsEvidence(load.acceptedJobs);
  return {
    loadRunId: exact(identity.loadRunId, UUID, 'LOAD_RUN_ID_INVALID'),
    acceptedJobs,
    activeJobs: validateActiveJobsEvidence(load.activeJobs, acceptedJobs.ids),
  };
}

export function validateRawLoadEvidence(value, finalizedValue) {
  const raw = object(value, 'LOAD_RAW_SUMMARY_INVALID');
  const finalized = object(finalizedValue, 'LOAD_EVIDENCE_INVALID');
  const finalizedAcceptedJobs = validateAcceptedJobsEvidence(finalized.acceptedJobs);
  if (
    raw.schemaVersion !== 'aeostudio.load-raw-summary.v2' ||
    raw.completedAt !== finalized.completedAt ||
    !sameJson(raw.runIdentity, finalized.runIdentity) ||
    !sameJson(raw.profile, finalized.profile) ||
    !sameJson(raw.gate, finalized.gate) ||
    !sameJson(validateAcceptedJobsEvidence(raw.acceptedJobs), finalizedAcceptedJobs) ||
    !sameJson(
      validateActiveJobsEvidence(raw.activeJobs, finalizedAcceptedJobs.ids),
      validateActiveJobsEvidence(finalized.activeJobs, finalizedAcceptedJobs.ids),
    )
  ) {
    throw new Error('LOAD_RAW_SUMMARY_BINDING_MISMATCH');
  }
  const rawMetrics = object(raw.metrics, 'LOAD_RAW_SUMMARY_METRICS_INVALID');
  const finalizedMetrics = object(finalized.metrics, 'LOAD_METRICS_INVALID');
  if (!sameStringSet(Object.keys(rawMetrics), REQUIRED_LOAD_THRESHOLD_METRICS)) {
    throw new Error('LOAD_RAW_SUMMARY_METRICS_INVALID');
  }
  for (const metricName of REQUIRED_LOAD_THRESHOLD_METRICS) {
    const rawMetric = object(
      rawMetrics[metricName],
      `LOAD_RAW_SUMMARY_METRIC_INVALID:${metricName}`,
    );
    const finalizedMetric = object(
      finalizedMetrics[metricName],
      `LOAD_METRIC_INVALID:${metricName}`,
    );
    if (!sameJson(rawMetric.values, finalizedMetric.values)) {
      throw new Error(`LOAD_RAW_SUMMARY_METRIC_BINDING_MISMATCH:${metricName}`);
    }
  }
}

export function validateAlarmEvidence(value, expected) {
  const alarm = object(value, 'ALARM_EVIDENCE_INVALID');
  if (alarm.schemaVersion !== 'aeostudio.synthetic-fault-evidence.v2') {
    throw new Error('ALARM_EVIDENCE_SCHEMA_UNSUPPORTED');
  }
  if (
    !sameStringSet(Object.keys(alarm), [
      'accountId',
      'completedAt',
      'drillId',
      'environment',
      'faults',
      'matrixVersion',
      'outcome',
      'region',
      'schemaVersion',
      'startedAt',
    ]) ||
    alarm.matrixVersion !== 'aeostudio.synthetic-fault-matrix.v1' ||
    alarm.environment !== 'staging' ||
    alarm.region !== expected.region ||
    alarm.accountId !== expected.accountId ||
    !['NOT_CHECKED', 'PASSED'].includes(alarm.outcome)
  ) {
    throw new Error('ALARM_EVIDENCE_INVALID');
  }
  exact(alarm.drillId, /^[a-z0-9][a-z0-9-]{5,79}$/u, 'ALARM_DRILL_ID_INVALID');
  for (const [runId, runAttempt] of [
    [expected.workflowRunId, expected.workflowRunAttempt],
    [expected.acceptanceRunId, expected.acceptanceRunAttempt],
  ]) {
    if (runId === undefined && runAttempt === undefined) continue;
    if (
      runId === undefined ||
      runAttempt === undefined ||
      alarm.drillId !==
        `acceptance-${exact(runId, POSITIVE_INTEGER, 'ALARM_DRILL_RUN_IDENTITY_INVALID')}-${exact(
          runAttempt,
          POSITIVE_INTEGER,
          'ALARM_DRILL_RUN_IDENTITY_INVALID',
        )}`
    ) {
      throw new Error('ALARM_DRILL_RUN_IDENTITY_MISMATCH');
    }
  }
  const startedAt = timestamp(alarm.startedAt, 'ALARM_STARTED_AT_INVALID');
  const completedAt = timestamp(alarm.completedAt, 'ALARM_COMPLETED_AT_INVALID');
  const startedAtMs = new Date(startedAt).getTime();
  const completedAtMs = new Date(completedAt).getTime();
  if (startedAtMs > completedAtMs) throw new Error('SYNTHETIC_FAULT_WINDOW_INVALID');

  const matrix = expectedSyntheticFaultMatrix('staging');
  if (!Array.isArray(alarm.faults) || alarm.faults.length !== matrix.length) {
    throw new Error('SYNTHETIC_FAULT_MATRIX_MISMATCH');
  }
  const notChecked = [];
  for (let index = 0; index < matrix.length; index += 1) {
    const expectedFault = matrix[index];
    const fault = object(alarm.faults[index], 'SYNTHETIC_FAULT_RECORD_INVALID');
    if (fault.alarmName !== expectedFault.alarmName || fault.type !== expectedFault.type) {
      throw new Error('SYNTHETIC_FAULT_MATRIX_MISMATCH');
    }
    if (fault.status === 'NOT_CHECKED') {
      if (
        !sameStringSet(Object.keys(fault), ['alarmName', 'reasonCode', 'status', 'type']) ||
        fault.reasonCode !== expectedFault.notCheckedReason
      ) {
        throw new Error(`SYNTHETIC_FAULT_NOT_CHECKED_INVALID:${expectedFault.type}`);
      }
      notChecked.push(expectedFault.type);
      continue;
    }
    if (fault.status !== 'PASSED') {
      throw new Error(`SYNTHETIC_FAULT_STATUS_INVALID:${expectedFault.type}`);
    }
    if (expectedFault.approvedInjector === null) {
      throw new Error(`SYNTHETIC_FAULT_INJECTOR_NOT_APPROVED:${expectedFault.type}`);
    }
    validateSyntheticFaultCausalEvidence({
      completedAt,
      expectedFault,
      fault,
      startedAt,
    });
  }
  if (alarm.outcome !== 'PASSED' || notChecked.length > 0) {
    throw new Error(`SYNTHETIC_FAULT_COVERAGE_NOT_CHECKED:${notChecked.join(',')}`);
  }
}

export function validateSyntheticFaultCausalEvidence(input) {
  const expectedFault = object(input.expectedFault, 'SYNTHETIC_FAULT_CONTRACT_INVALID');
  const fault = object(input.fault, 'SYNTHETIC_FAULT_RECORD_INVALID');
  const startedAt = timestamp(input.startedAt, 'SYNTHETIC_FAULT_WINDOW_INVALID');
  const completedAt = timestamp(input.completedAt, 'SYNTHETIC_FAULT_WINDOW_INVALID');
  const startedAtMs = new Date(startedAt).getTime();
  const completedAtMs = new Date(completedAt).getTime();
  if (
    !nonEmptyString(expectedFault.type) ||
    !nonEmptyString(expectedFault.alarmName) ||
    !nonEmptyString(expectedFault.approvedInjector) ||
    !nonEmptyString(expectedFault.expectedSignal) ||
    !Number.isInteger(expectedFault.maxCausalLagSeconds) ||
    expectedFault.maxCausalLagSeconds < 1 ||
    !SHA256.test(expectedFault.alarmConfigurationSha256 ?? '') ||
    startedAtMs > completedAtMs
  ) {
    throw new Error('SYNTHETIC_FAULT_CONTRACT_INVALID');
  }
  return validateCausalFaultRecord(fault, expectedFault, startedAtMs, completedAtMs);
}

function validateCausalFaultRecord(fault, expectedFault, startedAtMs, completedAtMs) {
  if (
    !sameStringSet(Object.keys(fault), [
      'alarmConfiguration',
      'alarmHistory',
      'alarmName',
      'breachingDatapoints',
      'cloudTrail',
      'injection',
      'signal',
      'status',
      'trace',
      'type',
    ])
  ) {
    throw new Error(`SYNTHETIC_FAULT_RECORD_INVALID:${expectedFault.type}`);
  }
  const injection = object(fault.injection, 'SYNTHETIC_FAULT_INJECTION_INVALID');
  if (
    !sameStringSet(Object.keys(injection), ['correlationId', 'injectedAt', 'injector', 'kind']) ||
    injection.kind !== 'REAL_FAULT' ||
    injection.injector !== expectedFault.approvedInjector
  ) {
    throw new Error(`SYNTHETIC_FAULT_INJECTION_INVALID:${expectedFault.type}`);
  }
  const correlationId = exact(
    injection.correlationId,
    UUID,
    `SYNTHETIC_FAULT_CORRELATION_INVALID:${expectedFault.type}`,
  );
  const injectedAt = timestamp(
    injection.injectedAt,
    `SYNTHETIC_FAULT_INJECTED_AT_INVALID:${expectedFault.type}`,
  );

  const signal = object(fault.signal, 'SYNTHETIC_FAULT_SIGNAL_INVALID');
  if (
    !sameStringSet(Object.keys(signal), ['correlationId', 'event', 'observedAt', 'traceId']) ||
    signal.event !== expectedFault.expectedSignal ||
    signal.correlationId !== correlationId
  ) {
    throw new Error(`SYNTHETIC_FAULT_SIGNAL_INVALID:${expectedFault.type}`);
  }
  const traceId = exact(
    signal.traceId,
    TRACE_ID,
    `SYNTHETIC_FAULT_TRACE_INVALID:${expectedFault.type}`,
  );
  const signalObservedAt = timestamp(
    signal.observedAt,
    `SYNTHETIC_FAULT_SIGNAL_TIME_INVALID:${expectedFault.type}`,
  );

  if (!Array.isArray(fault.alarmHistory) || fault.alarmHistory.length === 0) {
    throw new Error(`SYNTHETIC_FAULT_ALARM_HISTORY_INVALID:${expectedFault.type}`);
  }
  const alarmTransition = validateAlarmHistoryTransition(
    fault.alarmHistory[0],
    expectedFault,
    'OK',
    'ALARM',
  );
  if (fault.alarmHistory.length < 2) {
    throw new Error(`SYNTHETIC_FAULT_ALARM_RECOVERY_MISSING:${expectedFault.type}`);
  }
  if (fault.alarmHistory.length !== 2) {
    throw new Error(`SYNTHETIC_FAULT_ALARM_HISTORY_INVALID:${expectedFault.type}`);
  }
  const recoveryTransition = validateAlarmHistoryTransition(
    fault.alarmHistory[1],
    expectedFault,
    'ALARM',
    'OK',
  );
  const alarmTransitionedAt = alarmTransition.timestamp;
  const alarmRecoveredAt = recoveryTransition.timestamp;
  const alarmConfiguration = validateSyntheticFaultAlarmConfiguration(
    fault.alarmConfiguration,
    expectedFault,
  );
  validateSyntheticFaultBreachingDatapoints(
    fault.breachingDatapoints,
    alarmConfiguration,
    expectedFault,
    injectedAt,
    alarmTransitionedAt,
  );
  validateSyntheticFaultCloudTrail(
    fault.cloudTrail,
    expectedFault,
    new Date(startedAtMs).toISOString(),
    alarmRecoveredAt,
    new Date(completedAtMs).toISOString(),
  );

  const trace = object(fault.trace, 'SYNTHETIC_FAULT_TRACE_INVALID');
  if (
    !sameStringSet(Object.keys(trace), [
      'correlationId',
      'found',
      'observedAt',
      'traceId',
      'xrayTraceId',
    ]) ||
    trace.correlationId !== correlationId ||
    trace.traceId !== traceId ||
    trace.xrayTraceId !== `1-${traceId.slice(0, 8)}-${traceId.slice(8)}` ||
    trace.found !== true
  ) {
    throw new Error(`SYNTHETIC_FAULT_TRACE_INVALID:${expectedFault.type}`);
  }
  const traceObservedAt = timestamp(
    trace.observedAt,
    `SYNTHETIC_FAULT_TRACE_TIME_INVALID:${expectedFault.type}`,
  );

  const injectedAtMs = new Date(injectedAt).getTime();
  const signalObservedAtMs = new Date(signalObservedAt).getTime();
  const alarmTransitionedAtMs = new Date(alarmTransitionedAt).getTime();
  const alarmRecoveredAtMs = new Date(alarmRecoveredAt).getTime();
  const traceObservedAtMs = new Date(traceObservedAt).getTime();
  if (
    injectedAtMs < startedAtMs ||
    signalObservedAtMs < injectedAtMs ||
    alarmTransitionedAtMs < signalObservedAtMs ||
    alarmRecoveredAtMs < alarmTransitionedAtMs ||
    traceObservedAtMs < signalObservedAtMs ||
    alarmRecoveredAtMs > completedAtMs ||
    traceObservedAtMs > completedAtMs ||
    alarmTransitionedAtMs - injectedAtMs > expectedFault.maxCausalLagSeconds * 1_000
  ) {
    throw new Error(`SYNTHETIC_FAULT_CAUSAL_WINDOW_INVALID:${expectedFault.type}`);
  }
  if (
    new Date(alarmConfiguration.capturedAt).getTime() < startedAtMs ||
    new Date(alarmConfiguration.capturedAt).getTime() > completedAtMs
  ) {
    throw new Error(`SYNTHETIC_FAULT_ALARM_CONFIGURATION_TIME_INVALID:${expectedFault.type}`);
  }
}

function validateSyntheticFaultCloudTrail(
  value,
  expectedFault,
  startedAt,
  alarmRecoveredAt,
  completedAt,
) {
  const errorCode = `SYNTHETIC_FAULT_CLOUDTRAIL_INVALID:${expectedFault.type}`;
  const evidence = object(value, errorCode);
  if (
    !sameStringSet(Object.keys(evidence), [
      'eventName',
      'eventSource',
      'lookupEndAt',
      'lookupStartAt',
      'rawLookupEvents',
      'status',
    ]) ||
    evidence.eventName !== 'SetAlarmState' ||
    evidence.eventSource !== 'monitoring.amazonaws.com' ||
    evidence.status !== 'COMPLETE' ||
    typeof evidence.rawLookupEvents !== 'string' ||
    evidence.rawLookupEvents.length === 0 ||
    evidence.rawLookupEvents.length > 1024 * 1024
  ) {
    throw new Error(errorCode);
  }
  const lookupStartAt = timestamp(evidence.lookupStartAt, errorCode);
  const lookupEndAt = timestamp(evidence.lookupEndAt, errorCode);
  if (
    new Date(lookupStartAt).getTime() > new Date(startedAt).getTime() ||
    new Date(lookupEndAt).getTime() < new Date(alarmRecoveredAt).getTime() ||
    new Date(lookupEndAt).getTime() > new Date(completedAt).getTime()
  ) {
    throw new Error(`SYNTHETIC_FAULT_CLOUDTRAIL_WINDOW_INVALID:${expectedFault.type}`);
  }
  const raw = parseObject(evidence.rawLookupEvents, errorCode);
  if (!sameStringSet(Object.keys(raw), ['Events']) || !Array.isArray(raw.Events)) {
    throw new Error(errorCode);
  }
  if (raw.Events.length > 0) {
    throw new Error(`SYNTHETIC_FAULT_CLOUDTRAIL_SET_ALARM_STATE_DETECTED:${expectedFault.type}`);
  }
}

function validateSyntheticFaultBreachingDatapoints(
  value,
  alarmConfiguration,
  expectedFault,
  injectedAt,
  alarmTransitionedAt,
) {
  const errorCode = `SYNTHETIC_FAULT_BREACHING_DATAPOINTS_INVALID:${expectedFault.type}`;
  const evidence = object(value, errorCode);
  if (
    !sameStringSet(Object.keys(evidence), ['configurationSha256', 'queryId', 'rawMetricData']) ||
    evidence.configurationSha256 !== alarmConfiguration.sha256 ||
    typeof evidence.rawMetricData !== 'string' ||
    evidence.rawMetricData.length === 0 ||
    evidence.rawMetricData.length > 1024 * 1024
  ) {
    throw new Error(errorCode);
  }
  const queryId = exact(evidence.queryId, /^[a-z][a-z0-9_]{0,254}$/u, errorCode);
  const raw = parseObject(evidence.rawMetricData, errorCode);
  const rawKeys = Object.keys(raw);
  if (
    !Object.hasOwn(raw, 'MetricDataResults') ||
    rawKeys.some((key) => !['Messages', 'MetricDataResults'].includes(key)) ||
    (Object.hasOwn(raw, 'Messages') &&
      (!Array.isArray(raw.Messages) || raw.Messages.length !== 0)) ||
    !Array.isArray(raw.MetricDataResults) ||
    raw.MetricDataResults.length === 0 ||
    raw.MetricDataResults.length > 100
  ) {
    throw new Error(errorCode);
  }
  const result = raw.MetricDataResults.find((candidate) => objectOrNull(candidate)?.Id === queryId);
  const requiredResultKeys = ['Id', 'StatusCode', 'Timestamps', 'Values'];
  const allowedResultKeys = [...requiredResultKeys, 'Label', 'Messages'];
  if (
    result === undefined ||
    requiredResultKeys.some((key) => !Object.hasOwn(result, key)) ||
    Object.keys(result).some((key) => !allowedResultKeys.includes(key)) ||
    (Object.hasOwn(result, 'Label') && !nonEmptyString(result.Label)) ||
    (Object.hasOwn(result, 'Messages') &&
      (!Array.isArray(result.Messages) || result.Messages.length !== 0)) ||
    result.StatusCode !== 'Complete' ||
    !Array.isArray(result.Timestamps) ||
    !Array.isArray(result.Values) ||
    result.Timestamps.length === 0 ||
    result.Timestamps.length !== result.Values.length ||
    result.Timestamps.length > 1000
  ) {
    throw new Error(errorCode);
  }
  const injectedAtMs = new Date(injectedAt).getTime();
  const alarmTransitionedAtMs = new Date(alarmTransitionedAt).getTime();
  const metricPeriodMs = alarmConfiguration.configuration.metric.period * 1_000;
  const seenTimestamps = new Set();
  let breaching = 0;
  for (let index = 0; index < result.Timestamps.length; index += 1) {
    const pointTimestamp = timestamp(result.Timestamps[index], errorCode);
    const pointTimestampMs = new Date(pointTimestamp).getTime();
    const pointPeriodEndMs = pointTimestampMs + metricPeriodMs;
    const pointValue = result.Values[index];
    if (
      seenTimestamps.has(pointTimestamp) ||
      pointTimestampMs > alarmTransitionedAtMs ||
      pointPeriodEndMs < injectedAtMs ||
      typeof pointValue !== 'number' ||
      !Number.isFinite(pointValue)
    ) {
      throw new Error(errorCode);
    }
    seenTimestamps.add(pointTimestamp);
    if (
      breachesAlarmThreshold(
        pointValue,
        alarmConfiguration.configuration.comparisonOperator,
        alarmConfiguration.configuration.threshold,
      )
    ) {
      breaching += 1;
    }
  }
  if (breaching < alarmConfiguration.configuration.datapointsToAlarm) {
    throw new Error(errorCode);
  }
}

function breachesAlarmThreshold(value, comparisonOperator, threshold) {
  switch (comparisonOperator) {
    case 'GreaterThanOrEqualToThreshold':
      return value >= threshold;
    case 'GreaterThanThreshold':
      return value > threshold;
    case 'LessThanOrEqualToThreshold':
      return value <= threshold;
    case 'LessThanThreshold':
      return value < threshold;
    default:
      return false;
  }
}

function validateSyntheticFaultAlarmConfiguration(value, expectedFault) {
  const errorCode = `SYNTHETIC_FAULT_ALARM_CONFIGURATION_INVALID:${expectedFault.type}`;
  const configurationEvidence = object(value, errorCode);
  if (
    !sameStringSet(Object.keys(configurationEvidence), ['capturedAt', 'configuration', 'sha256'])
  ) {
    throw new Error(errorCode);
  }
  const configuration = object(configurationEvidence.configuration, errorCode);
  const metric = object(configuration.metric, errorCode);
  if (
    !sameStringSet(Object.keys(configuration), [
      'alarmName',
      'comparisonOperator',
      'datapointsToAlarm',
      'evaluationPeriods',
      'metric',
      'threshold',
      'treatMissingData',
    ]) ||
    configuration.alarmName !== expectedFault.alarmName ||
    ![
      'GreaterThanOrEqualToThreshold',
      'GreaterThanThreshold',
      'LessThanOrEqualToThreshold',
      'LessThanThreshold',
    ].includes(configuration.comparisonOperator) ||
    !Number.isInteger(configuration.datapointsToAlarm) ||
    configuration.datapointsToAlarm < 1 ||
    !Number.isInteger(configuration.evaluationPeriods) ||
    configuration.evaluationPeriods < configuration.datapointsToAlarm ||
    typeof configuration.threshold !== 'number' ||
    !Number.isFinite(configuration.threshold) ||
    !['breaching', 'ignore', 'missing', 'notBreaching'].includes(configuration.treatMissingData) ||
    Object.keys(metric).length === 0 ||
    !isValidCloudWatchAlarmPeriod(metric.period)
  ) {
    throw new Error(errorCode);
  }
  const sha256 = exact(configurationEvidence.sha256, SHA256, errorCode);
  const actualSha256 = createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
  if (sha256 !== actualSha256 || sha256 !== expectedFault.alarmConfigurationSha256) {
    throw new Error(`SYNTHETIC_FAULT_ALARM_CONFIGURATION_MISMATCH:${expectedFault.type}`);
  }
  return {
    capturedAt: timestamp(
      configurationEvidence.capturedAt,
      `SYNTHETIC_FAULT_ALARM_CONFIGURATION_TIME_INVALID:${expectedFault.type}`,
    ),
    configuration,
    sha256,
  };
}

function isValidCloudWatchAlarmPeriod(value) {
  return (
    Number.isSafeInteger(value) &&
    value > 0 &&
    (value === 10 || value === 20 || value === 30 || value % 60 === 0)
  );
}

function validateAlarmHistoryTransition(value, expectedFault, oldState, newState) {
  const history = object(value, 'SYNTHETIC_FAULT_ALARM_HISTORY_INVALID');
  const historyDataError = `SYNTHETIC_FAULT_CLOUDWATCH_HISTORY_DATA_INVALID:${expectedFault.type}`;
  if (!Object.hasOwn(history, 'historyData')) throw new Error(historyDataError);
  if (
    !sameStringSet(Object.keys(history), [
      'alarmName',
      'historyData',
      'historyItemType',
      'newState',
      'oldState',
      'summary',
      'timestamp',
    ]) ||
    history.alarmName !== expectedFault.alarmName ||
    history.historyItemType !== 'StateUpdate' ||
    history.oldState !== oldState ||
    history.newState !== newState ||
    !nonEmptyString(history.summary)
  ) {
    throw new Error(`SYNTHETIC_FAULT_ALARM_HISTORY_INVALID:${expectedFault.type}`);
  }
  const historyData = parseObject(history.historyData, historyDataError);
  const rawOldState = object(historyData.oldState, historyDataError);
  const rawNewState = object(historyData.newState, historyDataError);
  if (rawOldState.stateValue !== oldState || rawNewState.stateValue !== newState) {
    throw new Error(historyDataError);
  }
  return {
    timestamp: timestamp(
      history.timestamp,
      `SYNTHETIC_FAULT_ALARM_TIME_INVALID:${expectedFault.type}`,
    ),
  };
}

export function validateTraceEvidence(
  value,
  expected,
  imageDigests,
  loadValue,
  expectedTaskDefinitions,
  expectedReleaseContract,
) {
  const trace = object(value, 'TRACE_EVIDENCE_INVALID');
  const digests = object(trace.imageDigests, 'TRACE_DIGESTS_INVALID');
  const taskDefinitions = object(expectedTaskDefinitions, 'TRACE_TASK_DEFINITIONS_INVALID');
  const tracedTaskDefinitions = object(trace.taskDefinitions, 'TRACE_TASK_DEFINITIONS_INVALID');
  const brokerRuntime = object(trace.brokerRuntime, 'TRACE_TENANT_DATA_BROKER_RUNTIME_INVALID');
  const releaseContract = object(trace.releaseContract, 'TRACE_RELEASE_CONTRACT_BINDING_MISMATCH');
  const loadEvidence = object(loadValue, 'LOAD_EVIDENCE_INVALID');
  const identity = object(loadEvidence.runIdentity, 'LOAD_RUN_IDENTITY_INVALID');
  const loadRunId = exact(identity.loadRunId, UUID, 'LOAD_RUN_ID_INVALID');
  const acceptedJobs = validateAcceptedJobsEvidence(loadEvidence.acceptedJobs);
  const endpoint = object(trace.endpoint, 'TRACE_ENDPOINT_INVALID');
  const endpointOrigin = exactHttpsOrigin(endpoint.origin, 'TRACE_ENDPOINT_INVALID');
  if (
    endpointOrigin !== exactHttpsOrigin(identity.approvedOrigin, 'LOAD_APPROVED_ORIGIN_INVALID')
  ) {
    throw new Error('TRACE_ENDPOINT_MISMATCH');
  }
  if (
    trace.schemaVersion !== 'aeostudio.staging-trace-evidence.v1' ||
    trace.outcome !== 'PASS' ||
    trace.environment !== 'staging' ||
    trace.repository !== expected.repository ||
    trace.sourceSha !== expected.sourceSha ||
    trace.buildRunId !== expected.buildRunId ||
    trace.buildRunAttempt !== expected.buildRunAttempt ||
    trace.accountId !== expected.accountId ||
    trace.region !== expected.region ||
    trace.loadRunId !== loadRunId ||
    trace.acceptedJobsSha256 !== acceptedJobs.sha256 ||
    !sameStringSet(Object.keys(digests), ['adot', 'api', 'tenantDataBroker', 'web', 'worker']) ||
    digests.adot !== imageDigests.adot ||
    digests.api !== imageDigests.api ||
    digests.tenantDataBroker !== imageDigests.tenantDataBroker ||
    digests.web !== imageDigests.web ||
    digests.worker !== imageDigests.worker ||
    !sameJson(tracedTaskDefinitions, taskDefinitions) ||
    (expectedReleaseContract !== undefined && !sameJson(releaseContract, expectedReleaseContract))
  ) {
    throw new Error('TRACE_RELEASE_IDENTITY_MISMATCH');
  }
  const registry = `${expected.accountId}.dkr.ecr.${expected.region}.amazonaws.com`;
  if (
    brokerRuntime.schemaVersion !== 'aeostudio.tenant-data-broker-runtime.v1' ||
    brokerRuntime.environment !== 'staging' ||
    brokerRuntime.region !== expected.region ||
    brokerRuntime.accountId !== expected.accountId ||
    brokerRuntime.releaseId !== `staging-${expected.buildRunId}-${expected.buildRunAttempt}` ||
    brokerRuntime.taskDefinitionArn !== taskDefinitions.tenantDataBroker ||
    brokerRuntime.desiredCount < 2 ||
    !Number.isInteger(brokerRuntime.desiredCount) ||
    brokerRuntime.runningCount !== brokerRuntime.desiredCount ||
    brokerRuntime.pendingCount !== 0 ||
    brokerRuntime.healthyTargetCount !== brokerRuntime.desiredCount ||
    brokerRuntime.workerImage !== `${registry}/aeostudio-worker@${imageDigests.tenantDataBroker}` ||
    brokerRuntime.adotImage !== `${registry}/aeostudio-adot@${imageDigests.adot}` ||
    !DIGEST.test(brokerRuntime.adotRuntimeDigest ?? '')
  ) {
    throw new Error('TRACE_TENANT_DATA_BROKER_RUNTIME_INVALID');
  }
  validateTenantDataBrokerRuntimeEvidence(
    brokerRuntime,
    {
      accountId: expected.accountId,
      adotImage: `${registry}/aeostudio-adot@${imageDigests.adot}`,
      environment: 'staging',
      region: expected.region,
      releaseId: `staging-${expected.buildRunId}-${expected.buildRunAttempt}`,
      taskDefinitionArn: taskDefinitions.tenantDataBroker,
      workerDigest: imageDigests.tenantDataBroker,
      workerImage: `${registry}/aeostudio-worker@${imageDigests.tenantDataBroker}`,
    },
    'TRACE_TENANT_DATA_BROKER_RUNTIME_INVALID',
  );
  if (
    releaseContract.file !== 'staging-release-contract.json' ||
    !/^[0-9a-f]{64}$/u.test(releaseContract.sha256 ?? '')
  ) {
    throw new Error('TRACE_RELEASE_CONTRACT_BINDING_MISMATCH');
  }
  const correlations = object(trace.correlations, 'TRACE_CORRELATIONS_INVALID');
  const smoke = object(correlations.smokeRequest, 'SMOKE_TRACE_CORRELATION_INVALID');
  const loadCorrelation = object(correlations.loadRequestJob, 'LOAD_TRACE_CORRELATION_INVALID');
  validateCorrelation(smoke, false, 'SMOKE_TRACE_CORRELATION_INVALID');
  validateCorrelation(loadCorrelation, true, 'LOAD_TRACE_CORRELATION_INVALID');
  const smokeApiRuntimeBuildIdentity = validateRuntimeLogIdentity(
    smoke.runtimeBuildIdentity,
    'api',
    imageDigests.api,
    expected.accountId,
    'SMOKE_RUNTIME_IDENTITY_MISMATCH',
  );
  const smokeWebRuntimeBuildIdentity = validateRuntimeLogIdentity(
    smoke.webRuntimeBuildIdentity,
    'web',
    imageDigests.web,
    expected.accountId,
    'SMOKE_WEB_RUNTIME_IDENTITY_MISMATCH',
  );
  const loadApiRuntimeBuildIdentity = validateRuntimeLogIdentity(
    loadCorrelation.apiRuntimeBuildIdentity,
    'api',
    imageDigests.api,
    expected.accountId,
    'LOAD_API_RUNTIME_IDENTITY_MISMATCH',
  );
  const loadWorkerRuntimeBuildIdentity = validateRuntimeLogIdentity(
    loadCorrelation.workerRuntimeBuildIdentity,
    'worker',
    imageDigests.worker,
    expected.accountId,
    'LOAD_WORKER_RUNTIME_IDENTITY_MISMATCH',
  );
  assertTaskDefinition(
    smokeApiRuntimeBuildIdentity,
    taskDefinitions.api,
    'SMOKE_API_TASK_DEFINITION_MISMATCH',
  );
  assertTaskDefinition(
    smokeWebRuntimeBuildIdentity,
    taskDefinitions.web,
    'SMOKE_WEB_TASK_DEFINITION_MISMATCH',
  );
  assertTaskDefinition(
    loadApiRuntimeBuildIdentity,
    taskDefinitions.api,
    'LOAD_API_TASK_DEFINITION_MISMATCH',
  );
  assertTaskDefinition(
    loadWorkerRuntimeBuildIdentity,
    taskDefinitions.worker,
    'LOAD_WORKER_TASK_DEFINITION_MISMATCH',
  );
  if (!acceptedJobs.ids.includes(loadCorrelation.jobId)) {
    throw new Error('LOAD_TRACE_JOB_NOT_ACCEPTED');
  }
  return {
    tracedJobId: loadCorrelation.jobId,
    endpointOrigin,
    smokeApiRuntimeBuildIdentity,
    smokeWebRuntimeBuildIdentity,
    loadApiRuntimeBuildIdentity,
    loadWorkerRuntimeBuildIdentity,
    brokerRuntime,
  };
}

function validateRelease(value, expected) {
  const release = object(value, 'RELEASE_MANIFEST_INVALID');
  if (
    release.schemaVersion !== 'aeostudio.release.v1' ||
    release.repository !== expected.repository ||
    release.sourceSha !== expected.sourceSha ||
    release.sourceRef !== 'refs/heads/main' ||
    release.buildRunId !== expected.buildRunId ||
    release.buildRunAttempt !== expected.buildRunAttempt
  ) {
    throw new Error('RELEASE_MANIFEST_IDENTITY_MISMATCH');
  }
  const images = object(release.images, 'RELEASE_IMAGES_INVALID');
  const registry = `${expected.accountId}.dkr.ecr.${expected.region}.amazonaws.com`;
  const imageDigests = {};
  if (!sameStringSet(Object.keys(images), ['adot', 'api', 'web', 'worker'])) {
    throw new Error('RELEASE_IMAGES_INVALID');
  }
  for (const service of ['adot', 'api', 'web', 'worker']) {
    const image = object(images[service], `RELEASE_${service.toUpperCase()}_IMAGE_INVALID`);
    if (image.image !== `${registry}/aeostudio-${service}`) {
      throw new Error(`RELEASE_${service.toUpperCase()}_IMAGE_INVALID`);
    }
    imageDigests[service] = exact(
      image.digest,
      DIGEST,
      `RELEASE_${service.toUpperCase()}_DIGEST_INVALID`,
    );
  }
  imageDigests.tenantDataBroker = imageDigests.worker;
  return imageDigests;
}

function validateSmoke(value, expected, imageDigests, taskDefinitions) {
  const smoke = object(value, 'SMOKE_ENVELOPE_INVALID');
  const body = object(smoke.smoke, 'SMOKE_EVIDENCE_INVALID');
  const digests = object(smoke.digests, 'SMOKE_DIGESTS_INVALID');
  const brokerRuntime = object(smoke.brokerRuntime, 'SMOKE_TENANT_DATA_BROKER_RUNTIME_INVALID');
  if (
    smoke.schemaVersion !== 'aeostudio.staging-smoke-envelope.v1' ||
    smoke.sourceSha !== expected.sourceSha ||
    smoke.buildRunId !== expected.buildRunId ||
    smoke.buildRunAttempt !== expected.buildRunAttempt ||
    !sameStringSet(Object.keys(digests), ['adot', 'api', 'tenantDataBroker', 'web', 'worker']) ||
    digests.adot !== imageDigests.adot ||
    digests.api !== imageDigests.api ||
    digests.tenantDataBroker !== imageDigests.tenantDataBroker ||
    digests.web !== imageDigests.web ||
    digests.worker !== imageDigests.worker ||
    body.schemaVersion !== 'aeostudio-staging-smoke.v1' ||
    body.environment !== 'staging' ||
    body.region !== expected.region ||
    body.imageDigest !== imageDigests.api
  ) {
    throw new Error('SMOKE_RELEASE_IDENTITY_MISMATCH');
  }
  const registry = `${expected.accountId}.dkr.ecr.${expected.region}.amazonaws.com`;
  if (
    brokerRuntime.schemaVersion !== 'aeostudio.tenant-data-broker-runtime.v1' ||
    brokerRuntime.environment !== 'staging' ||
    brokerRuntime.region !== expected.region ||
    brokerRuntime.accountId !== expected.accountId ||
    brokerRuntime.releaseId !== `staging-${expected.buildRunId}-${expected.buildRunAttempt}` ||
    brokerRuntime.taskDefinitionArn !== taskDefinitions.tenantDataBroker ||
    brokerRuntime.desiredCount < 2 ||
    !Number.isInteger(brokerRuntime.desiredCount) ||
    brokerRuntime.runningCount !== brokerRuntime.desiredCount ||
    brokerRuntime.pendingCount !== 0 ||
    brokerRuntime.healthyTargetCount !== brokerRuntime.desiredCount ||
    brokerRuntime.workerImage !== `${registry}/aeostudio-worker@${imageDigests.tenantDataBroker}` ||
    brokerRuntime.adotImage !== `${registry}/aeostudio-adot@${imageDigests.adot}` ||
    !DIGEST.test(brokerRuntime.adotRuntimeDigest ?? '') ||
    brokerRuntime.runtimePlatform?.cpuArchitecture !== 'X86_64' ||
    brokerRuntime.runtimePlatform?.operatingSystemFamily !== 'LINUX'
  ) {
    throw new Error('SMOKE_TENANT_DATA_BROKER_RUNTIME_INVALID');
  }
  validateTenantDataBrokerRuntimeEvidence(
    brokerRuntime,
    {
      accountId: expected.accountId,
      adotImage: `${registry}/aeostudio-adot@${imageDigests.adot}`,
      environment: 'staging',
      region: expected.region,
      releaseId: `staging-${expected.buildRunId}-${expected.buildRunAttempt}`,
      taskDefinitionArn: taskDefinitions.tenantDataBroker,
      workerDigest: imageDigests.tenantDataBroker,
      workerImage: `${registry}/aeostudio-worker@${imageDigests.tenantDataBroker}`,
    },
    'SMOKE_TENANT_DATA_BROKER_RUNTIME_INVALID',
  );
  timestamp(body.startedAt, 'SMOKE_STARTED_AT_INVALID');
  timestamp(body.completedAt, 'SMOKE_COMPLETED_AT_INVALID');
  const checks = object(body.checks, 'SMOKE_CHECKS_INVALID');
  for (const check of [
    'health',
    'readiness',
    'syntheticLogin',
    'runtimeBuildIdentity',
    'webRuntimeBuildIdentity',
    'sealedExperiment',
  ]) {
    if (object(checks[check], 'SMOKE_CHECK_INVALID').status !== 200) {
      throw new Error(`SMOKE_CHECK_FAILED:${check}`);
    }
  }
  const probe = object(body.traceProbe, 'SMOKE_TRACE_PROBE_INVALID');
  if (probe.operation !== 'runtimeBuildIdentity' || !UUID.test(probe.requestId ?? '')) {
    throw new Error('SMOKE_TRACE_PROBE_INVALID');
  }
  const endpoint = object(body.endpoint, 'SMOKE_ENDPOINT_INVALID');
  const endpointOrigin = exactHttpsOrigin(endpoint.origin, 'SMOKE_ENDPOINT_INVALID');
  const runtime = object(body.runtimeBuildIdentity, 'SMOKE_RUNTIME_IDENTITY_MISMATCH');
  const webRuntime = object(body.webRuntimeBuildIdentity, 'SMOKE_WEB_RUNTIME_IDENTITY_MISMATCH');
  if (
    runtime.schemaVersion !== 'aeostudio.runtime-build-identity.v1' ||
    runtime.source !== 'ecs-container-metadata-v4' ||
    runtime.service !== 'api' ||
    runtime.imageDigest !== imageDigests.api ||
    runtime.imageId !== imageDigests.api ||
    typeof runtime.image !== 'string' ||
    !runtime.image.endsWith(`@${imageDigests.api}`) ||
    typeof runtime.containerArn !== 'string' ||
    !runtime.containerArn.startsWith(`arn:aws:ecs:ap-southeast-1:${expected.accountId}:container/`)
  ) {
    throw new Error('SMOKE_RUNTIME_IDENTITY_MISMATCH');
  }
  if (
    webRuntime.schemaVersion !== 'aeostudio.runtime-build-identity.v1' ||
    webRuntime.source !== 'ecs-container-metadata-v4' ||
    webRuntime.service !== 'web' ||
    webRuntime.imageDigest !== imageDigests.web ||
    webRuntime.imageId !== imageDigests.web ||
    typeof webRuntime.image !== 'string' ||
    !webRuntime.image.endsWith(`@${imageDigests.web}`) ||
    typeof webRuntime.containerArn !== 'string' ||
    !webRuntime.containerArn.startsWith(
      `arn:aws:ecs:ap-southeast-1:${expected.accountId}:container/`,
    )
  ) {
    throw new Error('SMOKE_WEB_RUNTIME_IDENTITY_MISMATCH');
  }
  timestamp(runtime.capturedAt, 'SMOKE_RUNTIME_IDENTITY_MISMATCH');
  timestamp(webRuntime.capturedAt, 'SMOKE_WEB_RUNTIME_IDENTITY_MISMATCH');
  return {
    endpointOrigin,
    brokerRuntime,
    runtimeBuildIdentity: validateRuntimeLogIdentity(
      {
        runtime_task_arn: runtime.taskArn,
        runtime_task_definition_arn: runtime.taskDefinitionArn,
        runtime_image_digest: runtime.imageDigest,
        runtime_image_id: runtime.imageId,
      },
      'api',
      imageDigests.api,
      expected.accountId,
      'SMOKE_RUNTIME_IDENTITY_MISMATCH',
    ),
    webRuntimeBuildIdentity: validateRuntimeLogIdentity(
      {
        runtime_task_arn: webRuntime.taskArn,
        runtime_task_definition_arn: webRuntime.taskDefinitionArn,
        runtime_image_digest: webRuntime.imageDigest,
        runtime_image_id: webRuntime.imageId,
      },
      'web',
      imageDigests.web,
      expected.accountId,
      'SMOKE_WEB_RUNTIME_IDENTITY_MISMATCH',
    ),
  };
}

function validateCorrelation(value, requiresJob, errorCode) {
  if (
    !UUID.test(value.requestId ?? '') ||
    !TRACE_ID.test(value.traceId ?? '') ||
    !XRAY_TRACE_ID.test(value.xrayTraceId ?? '') ||
    value.xrayTraceId !== xrayTraceId(value.traceId) ||
    value.xrayFound !== true ||
    (requiresJob && !UUID.test(value.jobId ?? ''))
  ) {
    throw new Error(errorCode);
  }
}

function validateRuntimeLogIdentity(value, service, expectedDigest, accountId, errorCode) {
  const identity = object(value, errorCode);
  const taskArn = exact(identity.runtime_task_arn, ECS_TASK_ARN, errorCode);
  const taskDefinitionArn = exact(
    identity.runtime_task_definition_arn,
    ECS_TASK_DEFINITION_ARN,
    errorCode,
  );
  const imageDigest = exact(identity.runtime_image_digest, DIGEST, errorCode);
  const imageId = exact(identity.runtime_image_id, DIGEST, errorCode);
  if (
    ECS_TASK_ARN.exec(taskArn)?.groups?.account !== accountId ||
    ECS_TASK_DEFINITION_ARN.exec(taskDefinitionArn)?.groups?.account !== accountId ||
    imageDigest !== expectedDigest ||
    imageId !== expectedDigest ||
    !taskDefinitionArn.includes(`aeostudio-staging-${service}:`)
  ) {
    throw new Error(errorCode);
  }
  return {
    runtime_task_arn: taskArn,
    runtime_task_definition_arn: taskDefinitionArn,
    runtime_image_digest: imageDigest,
    runtime_image_id: imageId,
  };
}

function assertTaskDefinition(identity, expectedTaskDefinitionArn, errorCode) {
  if (identity.runtime_task_definition_arn !== expectedTaskDefinitionArn) {
    throw new Error(errorCode);
  }
}

function exactMetric(metrics, metricName, valueName, expectedValue) {
  boundedMetric(metrics, metricName, valueName, (value) => value === expectedValue);
}

function boundedMetric(metrics, metricName, valueName, predicate) {
  const metric = object(metrics[metricName], `LOAD_METRIC_INVALID:${metricName}`);
  const values = object(metric.values, `LOAD_METRIC_VALUES_INVALID:${metricName}`);
  const value = values[valueName];
  if (typeof value !== 'number' || !Number.isFinite(value) || !predicate(value)) {
    throw new Error(`LOAD_METRIC_GATE_FAILED:${metricName}:${valueName}`);
  }
}

async function evidenceFile(path, errorCode) {
  const resolvedPath = resolve(path);
  const raw = await readFile(resolvedPath);
  return {
    path: resolvedPath,
    raw,
    sha256: createHash('sha256').update(raw).digest('hex'),
    value: parseObject(raw.toString('utf8'), errorCode),
  };
}

function xrayTraceId(traceId) {
  return `1-${traceId.slice(0, 8)}-${traceId.slice(8)}`;
}

function exactHttpsOrigin(value, errorCode) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(errorCode);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(errorCode);
  }
  return parsed.origin;
}

function sameStringSet(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 && !/[\r\n]/u.test(value);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function timestamp(value, errorCode) {
  if (typeof value !== 'string') throw new Error(errorCode);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(errorCode);
  }
  return value;
}

function exactRepository(value) {
  return exact(value, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, 'REPOSITORY_INVALID');
}

function exact(value, pattern, errorCode) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(errorCode);
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

function object(value, errorCode) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  return value;
}

function objectOrNull(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    const result = await finalizeStagingAcceptanceEvidence({
      accountId: requiredEnvironment('AEO_ACCEPTANCE_AWS_ACCOUNT_ID'),
      alarmEvidencePath: requiredEnvironment('AEO_ACCEPTANCE_ALARM_EVIDENCE_PATH'),
      buildRunAttempt: requiredEnvironment('AEO_ACCEPTANCE_BUILD_RUN_ATTEMPT'),
      buildRunId: requiredEnvironment('AEO_ACCEPTANCE_BUILD_RUN_ID'),
      loadEvidencePath: requiredEnvironment('AEO_ACCEPTANCE_LOAD_EVIDENCE_PATH'),
      rawLoadEvidencePath: requiredEnvironment('AEO_ACCEPTANCE_LOAD_RAW_EVIDENCE_PATH'),
      outputPath: requiredEnvironment('AEO_ACCEPTANCE_ENVELOPE_PATH'),
      region: requiredEnvironment('AWS_REGION'),
      releaseContractPath: requiredEnvironment('AEO_ACCEPTANCE_RELEASE_CONTRACT_PATH'),
      releaseManifestPath: requiredEnvironment('AEO_ACCEPTANCE_RELEASE_MANIFEST_PATH'),
      repository: requiredEnvironment('GITHUB_REPOSITORY'),
      smokeEnvelopePath: requiredEnvironment('AEO_ACCEPTANCE_SMOKE_ENVELOPE_PATH'),
      sourceSha: requiredEnvironment('AEO_ACCEPTANCE_SOURCE_SHA'),
      traceEvidencePath: requiredEnvironment('AEO_ACCEPTANCE_TRACE_EVIDENCE_PATH'),
      workflowRunAttempt: requiredEnvironment('GITHUB_RUN_ATTEMPT'),
      workflowRunId: requiredEnvironment('GITHUB_RUN_ID'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'STAGING_ACCEPTANCE_EVIDENCE_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
