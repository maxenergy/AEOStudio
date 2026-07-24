/* global process */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateAlarmEvidence,
  validateLoadEvidence,
  validateRawLoadEvidence,
  validateTraceEvidence,
} from './finalize-staging-acceptance-evidence.mjs';
import { validateTenantDataBrokerRuntimeEvidence } from './tenant-data-broker-runtime-evidence.mjs';
import { validateAcceptedJobsEvidence } from '../load/accepted-job-evidence.mjs';
import { validateActiveJobsEvidence } from '../load/active-job-evidence.mjs';
import { readStagingReleaseContractEvidence } from './staging-release-contract-evidence.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ECS_TASK_ARN =
  /^arn:aws:ecs:ap-southeast-1:(?<account>[0-9]{12}):task\/[A-Za-z0-9_-]{1,255}\/[0-9a-f]{32}$/u;
const ECS_TASK_DEFINITION_ARN =
  /^arn:aws:ecs:ap-southeast-1:(?<account>[0-9]{12}):task-definition\/[A-Za-z0-9_-]{1,255}:[1-9][0-9]{0,9}$/u;
const RESTORE_TASK_ID = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export async function validateProductionPromotionEvidence(input) {
  const expected = {
    repository: exactRepository(input.repository),
    sourceSha: exact(input.sourceSha, SHA, 'SOURCE_SHA_INVALID'),
    buildRunId: exact(input.buildRunId, POSITIVE_INTEGER, 'BUILD_RUN_ID_INVALID'),
    buildRunAttempt: exact(input.buildRunAttempt, POSITIVE_INTEGER, 'BUILD_RUN_ATTEMPT_INVALID'),
    acceptanceRunId: exact(input.acceptanceRunId, POSITIVE_INTEGER, 'ACCEPTANCE_RUN_ID_INVALID'),
    acceptanceRunAttempt: exact(
      input.acceptanceRunAttempt,
      POSITIVE_INTEGER,
      'ACCEPTANCE_RUN_ATTEMPT_INVALID',
    ),
    restoreRunId: exact(input.restoreRunId, POSITIVE_INTEGER, 'RESTORE_RUN_ID_INVALID'),
    restoreRunAttempt: exact(
      input.restoreRunAttempt,
      POSITIVE_INTEGER,
      'RESTORE_RUN_ATTEMPT_INVALID',
    ),
    accountId: exact(input.accountId, ACCOUNT_ID, 'AWS_ACCOUNT_ID_INVALID'),
    region: input.region,
  };
  if (expected.region !== 'ap-southeast-1') throw new Error('AWS_REGION_INVALID');

  const release = await readJsonFile(input.releaseManifestPath, 'RELEASE_MANIFEST_INVALID');
  const imageDigests = validateRelease(release.value, expected);
  const releaseContract = await readStagingReleaseContractEvidence({
    path: input.releaseContractPath,
    expected,
    imageDigests,
  });
  const envelope = await readJsonFile(input.acceptanceEnvelopePath, 'ACCEPTANCE_ENVELOPE_INVALID');
  const rawLoad = await readJsonFile(input.rawLoadEvidencePath, 'LOAD_RAW_SUMMARY_INVALID');
  const load = await readJsonFile(input.loadEvidencePath, 'LOAD_EVIDENCE_INVALID');
  const alarm = await readJsonFile(input.alarmEvidencePath, 'ALARM_EVIDENCE_INVALID');
  const trace = await readJsonFile(input.traceEvidencePath, 'TRACE_EVIDENCE_INVALID');

  validateAcceptanceEnvelope({
    alarm,
    envelope: envelope.value,
    expected,
    imageDigests,
    load,
    rawLoad,
    releaseContract,
    trace,
  });
  validateLoadEvidence(load.value, expected, imageDigests);
  validateRawLoadEvidence(rawLoad.value, load.value);
  validateAlarmEvidence(alarm.value, expected);
  validateTraceEvidence(
    trace.value,
    expected,
    imageDigests,
    load.value,
    releaseContract.taskDefinitions,
    releaseContract.binding,
  );

  const restoreRaw = await readJsonFile(input.restoreEvidencePath, 'RESTORE_EVIDENCE_INVALID');
  const restoreManifest = await readJsonFile(input.restoreManifestPath, 'RESTORE_MANIFEST_INVALID');
  const restoreChecksum = await readFile(resolve(input.restoreChecksumPath), 'utf8');
  validateRestorePromotionEvidence({
    checksum: restoreChecksum,
    expected,
    manifest: restoreManifest.value,
    raw: restoreRaw.value,
    rawBytes: restoreRaw.raw,
  });
  return { outcome: 'PASS' };
}

export function validateRestorePromotionEvidence(input) {
  const manifest = object(input.manifest, 'RESTORE_MANIFEST_INVALID');
  const expected = input.expected;
  if (
    manifest.schemaVersion !== 'aeostudio.restore-drill-artifact.v1' ||
    manifest.environment !== 'staging' ||
    manifest.repository !== expected.repository ||
    manifest.sourceSha !== expected.sourceSha ||
    manifest.workflowRunId !== expected.restoreRunId ||
    manifest.workflowRunAttempt !== expected.restoreRunAttempt ||
    manifest.buildRunId !== expected.buildRunId ||
    manifest.buildRunAttempt !== expected.buildRunAttempt
  ) {
    throw new Error('RESTORE_ARTIFACT_IDENTITY_MISMATCH');
  }
  const taskId = exact(manifest.taskId, RESTORE_TASK_ID, 'RESTORE_TASK_ID_INVALID');
  const executionArn = `arn:aws:states:${expected.region}:${expected.accountId}:execution:aeostudio-staging-restore-drill:restore-${expected.restoreRunId}-${expected.restoreRunAttempt}`;
  const taskArn = `arn:aws:ecs:${expected.region}:${expected.accountId}:task/aeostudio-staging/${taskId}`;
  const taskDefinitionPattern = new RegExp(
    `^arn:aws:ecs:${expected.region}:${expected.accountId}:task-definition/aeostudio-staging-restore-drill:[1-9][0-9]*$`,
    'u',
  );
  const recoveryImage = `${expected.accountId}.dkr.ecr.${expected.region}.amazonaws.com/aeostudio-recovery`;
  const recoveryImageDigest = exact(
    manifest.recoveryImageDigest,
    DIGEST,
    'RESTORE_RECOVERY_IMAGE_DIGEST_INVALID',
  );
  if (
    typeof manifest.evidenceBucket !== 'string' ||
    !/^aeostudio-staging-[0-9]{12}-audit$/u.test(manifest.evidenceBucket) ||
    manifest.evidenceKey !== `restore-drills/${taskId}.json` ||
    typeof manifest.evidenceVersionId !== 'string' ||
    manifest.evidenceVersionId.length === 0 ||
    manifest.evidenceVersionId.length > 1_024 ||
    /[\r\n]/u.test(manifest.evidenceVersionId) ||
    manifest.executionArn !== executionArn ||
    manifest.taskArn !== taskArn ||
    !taskDefinitionPattern.test(manifest.taskDefinitionArn) ||
    manifest.recoveryImage !== recoveryImage
  ) {
    throw new Error('RESTORE_IMMUTABLE_OBJECT_IDENTITY_INVALID');
  }
  const evidenceSha256 = exact(manifest.evidenceSha256, SHA256, 'RESTORE_EVIDENCE_SHA256_INVALID');
  const actualSha256 = createHash('sha256').update(input.rawBytes).digest('hex');
  let parsedRaw;
  try {
    parsedRaw = JSON.parse(input.rawBytes.toString('utf8'));
  } catch {
    throw new Error('RESTORE_EVIDENCE_INVALID');
  }
  if (actualSha256 !== evidenceSha256 || JSON.stringify(parsedRaw) !== JSON.stringify(input.raw)) {
    throw new Error('RESTORE_EVIDENCE_SHA256_MISMATCH');
  }
  if (input.checksum !== `${evidenceSha256}  restore-drill.json\n`) {
    throw new Error('RESTORE_CHECKSUM_FILE_INVALID');
  }

  const raw = object(input.raw, 'RESTORE_EVIDENCE_INVALID');
  const source = object(raw.source, 'RESTORE_SOURCE_IDENTITY_INVALID');
  const executionIdentity = object(raw.executionIdentity, 'RESTORE_EXECUTION_IDENTITY_INVALID');
  const rawRecoveryImage = object(raw.recoveryImage, 'RESTORE_RECOVERY_IMAGE_INVALID');
  if (
    raw.schemaVersion !== 'aeostudio-restore-drill.v1' ||
    raw.environment !== 'staging' ||
    raw.outcome !== 'PASSED' ||
    raw.drillId !== taskId ||
    raw.region !== 'ap-southeast-1' ||
    source.repository !== expected.repository ||
    source.sourceSha !== expected.sourceSha ||
    source.workflowRunId !== expected.restoreRunId ||
    source.workflowRunAttempt !== expected.restoreRunAttempt ||
    source.buildRunId !== expected.buildRunId ||
    source.buildRunAttempt !== expected.buildRunAttempt ||
    executionIdentity.executionArn !== executionArn ||
    executionIdentity.taskArn !== taskArn ||
    executionIdentity.taskDefinitionArn !== manifest.taskDefinitionArn ||
    rawRecoveryImage.image !== `${recoveryImage}@${recoveryImageDigest}` ||
    rawRecoveryImage.digest !== recoveryImageDigest
  ) {
    throw new Error('RESTORE_EVIDENCE_INVALID');
  }
  const startedAt = timestamp(raw.startedAt, 'RESTORE_STARTED_AT_INVALID');
  const completedAt = timestamp(raw.completedAt, 'RESTORE_COMPLETED_AT_INVALID');
  const startedAtMs = new Date(startedAt).getTime();
  const completedAtMs = new Date(completedAt).getTime();
  if (completedAtMs < startedAtMs) throw new Error('RESTORE_TIME_WINDOW_INVALID');
  const limits = object(raw.limits, 'RESTORE_LIMITS_INVALID');
  if (
    !sameStringSet(Object.keys(limits), ['rpoMinutes', 'rtoHours']) ||
    limits.rpoMinutes !== 15 ||
    limits.rtoHours !== 4
  ) {
    throw new Error('RESTORE_LIMITS_INVALID');
  }
  const rpo = object(raw.rpoMinutes, 'RESTORE_RPO_INVALID');
  if (!sameStringSet(Object.keys(rpo), ['rds', 'rdsRecoveryPointAge', 's3'])) {
    throw new Error('RESTORE_RPO_INVALID');
  }
  const rpoValues = Object.values(rpo);
  if (
    rpoValues.some(
      (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 15,
    )
  ) {
    throw new Error('RESTORE_RPO_INVALID');
  }
  if (
    typeof raw.rtoHours !== 'number' ||
    !Number.isFinite(raw.rtoHours) ||
    raw.rtoHours < 0 ||
    raw.rtoHours > 4
  ) {
    throw new Error('RESTORE_RTO_INVALID');
  }
  if (!sameNumber(raw.rtoHours, (completedAtMs - startedAtMs) / 3_600_000)) {
    throw new Error('RESTORE_RTO_INVALID');
  }

  const rds = object(raw.rds, 'RESTORE_RDS_EVIDENCE_INVALID');
  const selectedRestoreTime = timestamp(
    rds.selectedRestoreTime,
    'RESTORE_RDS_SELECTED_TIME_INVALID',
  );
  const selectedRestoreTimeMs = new Date(selectedRestoreTime).getTime();
  const markerAt = timestamp(rds.markerAt, 'RESTORE_RDS_MARKER_TIME_INVALID');
  const markerAtMs = new Date(markerAt).getTime();
  const earliestRestoreTimeMs = new Date(
    timestamp(rds.earliestRestorableTime, 'RESTORE_RDS_WINDOW_INVALID'),
  ).getTime();
  const latestRestoreTimeMs = new Date(
    timestamp(rds.latestRestorableTime, 'RESTORE_RDS_WINDOW_INVALID'),
  ).getTime();
  if (
    rds.sourceRecoveryPoint !== selectedRestoreTime ||
    selectedRestoreTimeMs < earliestRestoreTimeMs ||
    selectedRestoreTimeMs > latestRestoreTimeMs ||
    typeof rds.markerToRecoveryPointMinutes !== 'number' ||
    !Number.isFinite(rds.markerToRecoveryPointMinutes) ||
    rds.markerToRecoveryPointMinutes < 0 ||
    rds.markerToRecoveryPointMinutes > 15 ||
    !sameNumber(rpo.rds, (startedAtMs - markerAtMs) / 60_000) ||
    !sameNumber(rpo.rdsRecoveryPointAge, (startedAtMs - selectedRestoreTimeMs) / 60_000) ||
    !sameNumber(rds.markerToRecoveryPointMinutes, (selectedRestoreTimeMs - markerAtMs) / 60_000) ||
    rds.connectivity !== 'PRIVATE_VPC_TLS_QUERY_SUCCEEDED' ||
    !Number.isInteger(rds.privateAddressCount) ||
    rds.privateAddressCount < 1 ||
    !nonEmptyString(rds.restoredIdentifier) ||
    !nonEmptyString(rds.parameterGroupName)
  ) {
    throw new Error('RESTORE_RDS_EVIDENCE_INVALID');
  }

  const s3 = object(raw.s3, 'RESTORE_S3_EVIDENCE_INVALID');
  const sourceMarkerAtMs = new Date(
    timestamp(s3.sourceMarkerAt, 'RESTORE_S3_MARKER_TIME_INVALID'),
  ).getTime();
  const requestedRestoreTimeMs = new Date(
    timestamp(s3.requestedRestoreTime, 'RESTORE_S3_REQUESTED_TIME_INVALID'),
  ).getTime();
  timestamp(s3.recoveryPointCreatedAt, 'RESTORE_S3_RECOVERY_POINT_TIME_INVALID');
  if (
    sourceMarkerAtMs > startedAtMs ||
    requestedRestoreTimeMs > startedAtMs ||
    !sameNumber(rpo.s3, (startedAtMs - sourceMarkerAtMs) / 60_000) ||
    !nonEmptyString(s3.restoreJobId) ||
    !nonEmptyString(s3.sourceVersionId) ||
    !nonEmptyString(s3.restoredVersionId) ||
    s3.sourceVersionId === s3.restoredVersionId
  ) {
    throw new Error('RESTORE_S3_EVIDENCE_INVALID');
  }
}

export function validateProductionLoadTraceBinding(input) {
  const load = object(input.load, 'LOAD_EVIDENCE_INVALID');
  const identity = object(load.runIdentity, 'LOAD_RUN_IDENTITY_INVALID');
  const loadRunId = exact(identity.loadRunId, UUID, 'LOAD_RUN_ID_INVALID');
  const acceptedJobs = validateAcceptedJobsEvidence(load.acceptedJobs);
  const activeJobs = validateActiveJobsEvidence(load.activeJobs, acceptedJobs.ids);
  const rawLoad = object(input.rawLoad, 'LOAD_RAW_SUMMARY_INVALID');
  const rawAcceptedJobs = validateAcceptedJobsEvidence(rawLoad.acceptedJobs);
  const rawActiveJobs = validateActiveJobsEvidence(rawLoad.activeJobs, rawAcceptedJobs.ids);
  if (
    JSON.stringify(rawAcceptedJobs) !== JSON.stringify(acceptedJobs) ||
    JSON.stringify(rawActiveJobs) !== JSON.stringify(activeJobs)
  ) {
    throw new Error('ACCEPTANCE_LOAD_TRACE_BINDING_MISMATCH');
  }

  const trace = object(input.trace, 'TRACE_EVIDENCE_INVALID');
  if (trace.loadRunId !== loadRunId || trace.acceptedJobsSha256 !== acceptedJobs.sha256) {
    throw new Error('ACCEPTANCE_LOAD_TRACE_BINDING_MISMATCH');
  }
  const correlations = object(trace.correlations, 'TRACE_CORRELATIONS_INVALID');
  const smokeCorrelation = object(correlations.smokeRequest, 'SMOKE_TRACE_CORRELATION_INVALID');
  const loadCorrelation = object(correlations.loadRequestJob, 'LOAD_TRACE_CORRELATION_INVALID');
  const tracedJobId = exact(loadCorrelation.jobId, UUID, 'LOAD_TRACE_CORRELATION_INVALID');
  if (!acceptedJobs.ids.includes(tracedJobId)) {
    throw new Error('ACCEPTANCE_LOAD_TRACE_JOB_NOT_ACCEPTED');
  }

  const envelope = object(input.envelope, 'ACCEPTANCE_ENVELOPE_INVALID');
  const binding = object(envelope.loadTraceBinding, 'ACCEPTANCE_LOAD_TRACE_BINDING_MISMATCH');
  if (
    !sameStringSet(Object.keys(binding), [
      'acceptedJobCount',
      'acceptedJobIdsSha256',
      'loadRunId',
      'tracedJobId',
    ]) ||
    binding.loadRunId !== loadRunId ||
    binding.acceptedJobCount !== acceptedJobs.count ||
    binding.acceptedJobIdsSha256 !== acceptedJobs.sha256 ||
    binding.tracedJobId !== tracedJobId
  ) {
    throw new Error('ACCEPTANCE_LOAD_TRACE_BINDING_MISMATCH');
  }

  const traceEndpoint = object(trace.endpoint, 'TRACE_ENDPOINT_INVALID');
  const traceDigests = object(trace.imageDigests, 'TRACE_DIGESTS_INVALID');
  const taskDefinitions = object(trace.taskDefinitions, 'TRACE_TASK_DEFINITIONS_INVALID');
  const brokerRuntime = object(trace.brokerRuntime, 'TRACE_TENANT_DATA_BROKER_RUNTIME_INVALID');
  const releaseContract = object(trace.releaseContract, 'TRACE_RELEASE_CONTRACT_BINDING_MISMATCH');
  const accountId = exact(identity.awsAccountId, ACCOUNT_ID, 'LOAD_RUN_IDENTITY_INVALID');
  if (
    !sameStringSet(Object.keys(traceDigests), ['adot', 'api', 'tenantDataBroker', 'web', 'worker'])
  ) {
    throw new Error('TRACE_DIGESTS_INVALID');
  }
  const apiDigest = exact(traceDigests.api, DIGEST, 'TRACE_DIGESTS_INVALID');
  const adotDigest = exact(traceDigests.adot, DIGEST, 'TRACE_DIGESTS_INVALID');
  const tenantDataBrokerDigest = exact(
    traceDigests.tenantDataBroker,
    DIGEST,
    'TRACE_DIGESTS_INVALID',
  );
  const webDigest = exact(traceDigests.web, DIGEST, 'TRACE_DIGESTS_INVALID');
  const workerDigest = exact(traceDigests.worker, DIGEST, 'TRACE_DIGESTS_INVALID');
  const registry = `${accountId}.dkr.ecr.ap-southeast-1.amazonaws.com`;
  validateTenantDataBrokerRuntimeEvidence(
    brokerRuntime,
    {
      accountId,
      adotImage: `${registry}/aeostudio-adot@${adotDigest}`,
      environment: 'staging',
      region: 'ap-southeast-1',
      releaseId: `staging-${identity.buildRunId}-${identity.buildRunAttempt}`,
      taskDefinitionArn: taskDefinitions.tenantDataBroker,
      workerDigest,
      workerImage: `${registry}/aeostudio-worker@${workerDigest}`,
    },
    'TRACE_TENANT_DATA_BROKER_RUNTIME_INVALID',
  );
  if (tenantDataBrokerDigest !== workerDigest) {
    throw new Error('TRACE_TENANT_DATA_BROKER_RUNTIME_INVALID');
  }
  const smokeRuntime = validateRuntimeIdentity(
    smokeCorrelation.runtimeBuildIdentity,
    'api',
    apiDigest,
    accountId,
    'SMOKE_RUNTIME_IDENTITY_MISMATCH',
  );
  const smokeWebRuntime = validateRuntimeIdentity(
    smokeCorrelation.webRuntimeBuildIdentity,
    'web',
    webDigest,
    accountId,
    'SMOKE_WEB_RUNTIME_IDENTITY_MISMATCH',
  );
  const loadApiRuntime = validateRuntimeIdentity(
    loadCorrelation.apiRuntimeBuildIdentity,
    'api',
    apiDigest,
    accountId,
    'LOAD_API_RUNTIME_IDENTITY_MISMATCH',
  );
  const loadWorkerRuntime = validateRuntimeIdentity(
    loadCorrelation.workerRuntimeBuildIdentity,
    'worker',
    workerDigest,
    accountId,
    'LOAD_WORKER_RUNTIME_IDENTITY_MISMATCH',
  );
  const runtimeBinding = object(
    envelope.runtimeDeploymentBinding,
    'ACCEPTANCE_RUNTIME_DEPLOYMENT_BINDING_MISMATCH',
  );
  if (
    !sameStringSet(Object.keys(runtimeBinding), [
      'adotImageDigest',
      'adotRuntimeDigest',
      'apiImageDigest',
      'endpointOrigin',
      'loadApiTaskArn',
      'loadApiTaskDefinitionArn',
      'loadWorkerTaskArn',
      'loadWorkerTaskDefinitionArn',
      'smokeApiTaskArn',
      'smokeApiTaskDefinitionArn',
      'smokeWebImageDigest',
      'smokeWebImageId',
      'smokeWebTaskArn',
      'smokeWebTaskDefinitionArn',
      'tenantDataBrokerDesiredCount',
      'tenantDataBrokerHealthyTargetCount',
      'tenantDataBrokerImageDigest',
      'tenantDataBrokerRunningCount',
      'tenantDataBrokerTaskDefinitionArn',
      'workerImageDigest',
    ]) ||
    runtimeBinding.endpointOrigin !== traceEndpoint.origin ||
    runtimeBinding.endpointOrigin !== identity.approvedOrigin ||
    runtimeBinding.smokeApiTaskArn !== smokeRuntime.runtime_task_arn ||
    runtimeBinding.smokeApiTaskDefinitionArn !== smokeRuntime.runtime_task_definition_arn ||
    runtimeBinding.smokeWebTaskArn !== smokeWebRuntime.runtime_task_arn ||
    runtimeBinding.smokeWebTaskDefinitionArn !== smokeWebRuntime.runtime_task_definition_arn ||
    runtimeBinding.smokeWebImageDigest !== webDigest ||
    runtimeBinding.smokeWebImageId !== webDigest ||
    runtimeBinding.loadApiTaskArn !== loadApiRuntime.runtime_task_arn ||
    runtimeBinding.loadApiTaskDefinitionArn !== loadApiRuntime.runtime_task_definition_arn ||
    runtimeBinding.loadWorkerTaskArn !== loadWorkerRuntime.runtime_task_arn ||
    runtimeBinding.loadWorkerTaskDefinitionArn !== loadWorkerRuntime.runtime_task_definition_arn ||
    tenantDataBrokerDigest !== workerDigest ||
    runtimeBinding.tenantDataBrokerTaskDefinitionArn !== taskDefinitions.tenantDataBroker ||
    runtimeBinding.tenantDataBrokerTaskDefinitionArn !== brokerRuntime.taskDefinitionArn ||
    runtimeBinding.tenantDataBrokerDesiredCount !== brokerRuntime.desiredCount ||
    runtimeBinding.tenantDataBrokerRunningCount !== brokerRuntime.runningCount ||
    runtimeBinding.tenantDataBrokerHealthyTargetCount !== brokerRuntime.healthyTargetCount ||
    runtimeBinding.tenantDataBrokerImageDigest !== tenantDataBrokerDigest ||
    runtimeBinding.adotImageDigest !== adotDigest ||
    runtimeBinding.adotRuntimeDigest !== brokerRuntime.adotRuntimeDigest ||
    runtimeBinding.apiImageDigest !== apiDigest ||
    runtimeBinding.workerImageDigest !== workerDigest ||
    smokeRuntime.runtime_task_definition_arn !== taskDefinitions.api ||
    smokeWebRuntime.runtime_task_definition_arn !== taskDefinitions.web ||
    loadApiRuntime.runtime_task_definition_arn !== taskDefinitions.api ||
    loadWorkerRuntime.runtime_task_definition_arn !== taskDefinitions.worker ||
    releaseContract.file !== 'staging-release-contract.json' ||
    !SHA256.test(releaseContract.sha256 ?? '')
  ) {
    throw new Error('ACCEPTANCE_RUNTIME_DEPLOYMENT_BINDING_MISMATCH');
  }
}

function validateRuntimeIdentity(value, service, expectedDigest, accountId, errorCode) {
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
    !taskDefinitionArn.includes(`aeostudio-staging-${service}:`) ||
    imageDigest !== expectedDigest ||
    imageId !== expectedDigest
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

function validateAcceptanceEnvelope(input) {
  const envelope = object(input.envelope, 'ACCEPTANCE_ENVELOPE_INVALID');
  const expected = input.expected;
  const digests = object(envelope.imageDigests, 'ACCEPTANCE_DIGESTS_INVALID');
  if (
    envelope.schemaVersion !== 'aeostudio.staging-acceptance-evidence.v1' ||
    envelope.outcome !== 'PASSED' ||
    envelope.environment !== 'staging' ||
    envelope.repository !== expected.repository ||
    envelope.sourceSha !== expected.sourceSha ||
    envelope.buildRunId !== expected.buildRunId ||
    envelope.buildRunAttempt !== expected.buildRunAttempt ||
    envelope.workflowRunId !== expected.acceptanceRunId ||
    envelope.workflowRunAttempt !== expected.acceptanceRunAttempt ||
    envelope.accountId !== expected.accountId ||
    envelope.region !== expected.region ||
    !sameStringSet(Object.keys(digests), ['adot', 'api', 'tenantDataBroker', 'web', 'worker']) ||
    digests.adot !== input.imageDigests.adot ||
    digests.api !== input.imageDigests.api ||
    digests.tenantDataBroker !== input.imageDigests.tenantDataBroker ||
    digests.web !== input.imageDigests.web ||
    digests.worker !== input.imageDigests.worker
  ) {
    throw new Error('ACCEPTANCE_ENVELOPE_IDENTITY_MISMATCH');
  }
  timestamp(envelope.completedAt, 'ACCEPTANCE_COMPLETED_AT_INVALID');
  const evidence = object(envelope.evidence, 'ACCEPTANCE_HASH_BINDING_INVALID');
  validateHashBinding(
    evidence.releaseContract,
    input.releaseContract,
    'staging-release-contract.json',
    'release_contract',
  );
  validateHashBinding(evidence.loadRaw, input.rawLoad, 'task-18-load-raw-summary.json', 'load_raw');
  validateHashBinding(evidence.load, input.load, 'task-18-load-evidence.json', 'load');
  validateHashBinding(evidence.alarm, input.alarm, 'synthetic-alarm-drill.json', 'alarm');
  validateHashBinding(evidence.trace, input.trace, 'staging-trace-evidence.json', 'trace');
  validateProductionLoadTraceBinding({
    envelope,
    load: input.load.value,
    rawLoad: input.rawLoad.value,
    trace: input.trace.value,
  });
}

function validateHashBinding(value, file, expectedName, kind) {
  const binding = object(value, 'ACCEPTANCE_HASH_BINDING_INVALID');
  if (
    binding.file !== expectedName ||
    basename(file.path) !== expectedName ||
    binding.sha256 !== createHash('sha256').update(file.raw).digest('hex')
  ) {
    throw new Error(`ACCEPTANCE_${kind.toUpperCase()}_SHA256_MISMATCH`);
  }
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
  const registry = `${expected.accountId}.dkr.ecr.${expected.region}.amazonaws.com`;
  const images = object(release.images, 'RELEASE_IMAGES_INVALID');
  const digests = {};
  if (!sameStringSet(Object.keys(images), ['adot', 'api', 'web', 'worker'])) {
    throw new Error('RELEASE_IMAGES_INVALID');
  }
  for (const service of ['adot', 'api', 'web', 'worker']) {
    const image = object(images[service], `RELEASE_${service.toUpperCase()}_IMAGE_INVALID`);
    if (image.image !== `${registry}/aeostudio-${service}`) {
      throw new Error(`RELEASE_${service.toUpperCase()}_IMAGE_INVALID`);
    }
    digests[service] = exact(
      image.digest,
      DIGEST,
      `RELEASE_${service.toUpperCase()}_DIGEST_INVALID`,
    );
  }
  digests.tenantDataBroker = digests.worker;
  return digests;
}

async function readJsonFile(path, errorCode) {
  const resolved = resolve(path);
  const raw = await readFile(resolved);
  let value;
  try {
    value = object(JSON.parse(raw.toString('utf8')), errorCode);
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new Error(errorCode, { cause: error });
  }
  return { path: resolved, raw, value };
}

function timestamp(value, errorCode) {
  if (typeof value !== 'string') throw new Error(errorCode);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(errorCode);
  }
  return value;
}

function sameNumber(left, right) {
  return (
    typeof left === 'number' &&
    Number.isFinite(left) &&
    typeof right === 'number' &&
    Number.isFinite(right) &&
    Math.abs(left - right) <= 1e-9
  );
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

function exactRepository(value) {
  return exact(value, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, 'REPOSITORY_INVALID');
}

function exact(value, pattern, errorCode) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(errorCode);
  return value;
}

function object(value, errorCode) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    const result = await validateProductionPromotionEvidence({
      acceptanceEnvelopePath: requiredEnvironment('AEO_PROMOTION_ACCEPTANCE_ENVELOPE_PATH'),
      acceptanceRunAttempt: requiredEnvironment('AEO_PROMOTION_ACCEPTANCE_RUN_ATTEMPT'),
      acceptanceRunId: requiredEnvironment('AEO_PROMOTION_ACCEPTANCE_RUN_ID'),
      accountId: requiredEnvironment('AEO_PROMOTION_AWS_ACCOUNT_ID'),
      alarmEvidencePath: requiredEnvironment('AEO_PROMOTION_ALARM_EVIDENCE_PATH'),
      buildRunAttempt: requiredEnvironment('AEO_PROMOTION_BUILD_RUN_ATTEMPT'),
      buildRunId: requiredEnvironment('AEO_PROMOTION_BUILD_RUN_ID'),
      loadEvidencePath: requiredEnvironment('AEO_PROMOTION_LOAD_EVIDENCE_PATH'),
      rawLoadEvidencePath: requiredEnvironment('AEO_PROMOTION_LOAD_RAW_EVIDENCE_PATH'),
      region: requiredEnvironment('AWS_REGION'),
      releaseContractPath: requiredEnvironment('AEO_PROMOTION_RELEASE_CONTRACT_PATH'),
      releaseManifestPath: requiredEnvironment('AEO_PROMOTION_RELEASE_MANIFEST_PATH'),
      repository: requiredEnvironment('GITHUB_REPOSITORY'),
      restoreChecksumPath: requiredEnvironment('AEO_PROMOTION_RESTORE_CHECKSUM_PATH'),
      restoreEvidencePath: requiredEnvironment('AEO_PROMOTION_RESTORE_EVIDENCE_PATH'),
      restoreManifestPath: requiredEnvironment('AEO_PROMOTION_RESTORE_MANIFEST_PATH'),
      restoreRunAttempt: requiredEnvironment('AEO_PROMOTION_RESTORE_RUN_ATTEMPT'),
      restoreRunId: requiredEnvironment('AEO_PROMOTION_RESTORE_RUN_ID'),
      sourceSha: requiredEnvironment('AEO_PROMOTION_SOURCE_SHA'),
      traceEvidencePath: requiredEnvironment('AEO_PROMOTION_TRACE_EVIDENCE_PATH'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'PRODUCTION_PROMOTION_EVIDENCE_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
