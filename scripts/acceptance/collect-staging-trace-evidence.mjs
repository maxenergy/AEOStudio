/* global process, setTimeout */

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { validateAcceptedJobsEvidence } from '../load/accepted-job-evidence.mjs';
import { readStagingReleaseContractEvidence } from './staging-release-contract-evidence.mjs';
import { validateTenantDataBrokerRuntimeEvidence } from './tenant-data-broker-runtime-evidence.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TRACE_ID = /^[0-9a-f]{32}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ECS_TASK_ARN =
  /^arn:aws:ecs:ap-southeast-1:(?<account>[0-9]{12}):task\/[A-Za-z0-9_-]{1,255}\/[0-9a-f]{32}$/u;
const ECS_TASK_DEFINITION_ARN =
  /^arn:aws:ecs:ap-southeast-1:(?<account>[0-9]{12}):task-definition\/[A-Za-z0-9_-]{1,255}:[1-9][0-9]{0,9}$/u;
const API_LOG_GROUP = '/ecs/aeostudio-staging/api';
const WORKER_LOG_GROUP = '/ecs/aeostudio-staging/worker';
const TERMINAL_QUERY_FAILURES = new Set(['Cancelled', 'Failed', 'Timeout', 'Unknown']);

export async function collectStagingTraceEvidence(input) {
  const repository = exactRepository(input.repository);
  const sourceSha = exact(input.sourceSha, SHA, 'SOURCE_SHA_INVALID');
  const buildRunId = exact(input.buildRunId, POSITIVE_INTEGER, 'BUILD_RUN_ID_INVALID');
  const buildRunAttempt = exact(
    input.buildRunAttempt,
    POSITIVE_INTEGER,
    'BUILD_RUN_ATTEMPT_INVALID',
  );
  const accountId = exact(input.accountId, ACCOUNT_ID, 'AWS_ACCOUNT_ID_INVALID');
  if (input.region !== 'ap-southeast-1') throw new Error('AWS_REGION_INVALID');
  if (input.apiLogGroup !== API_LOG_GROUP) throw new Error('API_LOG_GROUP_INVALID');
  if (input.workerLogGroup !== WORKER_LOG_GROUP) throw new Error('WORKER_LOG_GROUP_INVALID');

  const smoke = parseObject(
    await readFile(resolve(input.smokeEnvelopePath), 'utf8'),
    'SMOKE_ENVELOPE_INVALID',
  );
  const load = parseObject(
    await readFile(resolve(input.loadEvidencePath), 'utf8'),
    'LOAD_EVIDENCE_INVALID',
  );
  const sourceEvidence = validateSourceEvidence({
    accountId,
    buildRunAttempt,
    buildRunId,
    load,
    smoke,
    sourceSha,
  });
  const {
    acceptedJobs,
    brokerRuntime,
    endpointOrigin,
    imageDigests,
    loadRunId,
    smokeRuntimeIdentity,
    smokeWebRuntimeIdentity,
  } = sourceEvidence;
  const releaseContract = await readStagingReleaseContractEvidence({
    path: input.releaseContractPath,
    expected: {
      accountId,
      buildRunAttempt,
      buildRunId,
      sourceSha,
    },
    imageDigests,
  });
  assertTaskDefinition(
    smokeRuntimeIdentity,
    releaseContract.taskDefinitions.api,
    'SMOKE_API_TASK_DEFINITION_MISMATCH',
  );
  if (brokerRuntime.taskDefinitionArn !== releaseContract.taskDefinitions.tenantDataBroker) {
    throw new Error('TENANT_DATA_BROKER_TASK_DEFINITION_MISMATCH');
  }
  const registry = `${accountId}.dkr.ecr.ap-southeast-1.amazonaws.com`;
  validateTenantDataBrokerRuntimeEvidence(
    brokerRuntime,
    {
      accountId,
      adotImage: `${registry}/aeostudio-adot@${imageDigests.adot}`,
      environment: 'staging',
      region: input.region,
      releaseId: `staging-${buildRunId}-${buildRunAttempt}`,
      taskDefinitionArn: releaseContract.taskDefinitions.tenantDataBroker,
      workerDigest: imageDigests.tenantDataBroker,
      workerImage: `${registry}/aeostudio-worker@${imageDigests.tenantDataBroker}`,
    },
    'SMOKE_TENANT_DATA_BROKER_RUNTIME_INVALID',
  );
  assertTaskDefinition(
    smokeWebRuntimeIdentity,
    releaseContract.taskDefinitions.web,
    'SMOKE_WEB_TASK_DEFINITION_MISMATCH',
  );

  const smokeStartedAt = timestamp(smoke.smoke.startedAt, 'SMOKE_STARTED_AT_INVALID');
  const smokeCompletedAt = timestamp(smoke.smoke.completedAt, 'SMOKE_COMPLETED_AT_INVALID');
  const smokeRequestId = exact(
    smoke.smoke.traceProbe?.requestId,
    UUID,
    'SMOKE_TRACE_PROBE_REQUEST_ID_INVALID',
  );
  if (smoke.smoke.traceProbe?.operation !== 'runtimeBuildIdentity') {
    throw new Error('SMOKE_TRACE_PROBE_OPERATION_INVALID');
  }
  assertWindow(smokeStartedAt, smokeCompletedAt, 'SMOKE_TRACE_WINDOW_INVALID');

  const loadStartedAt = timestamp(input.loadStartedAt, 'LOAD_STARTED_AT_INVALID');
  const loadCompletedAt = timestamp(load.completedAt, 'LOAD_COMPLETED_AT_INVALID');
  assertWindow(loadStartedAt, loadCompletedAt, 'LOAD_TRACE_WINDOW_INVALID');

  const runAws =
    input.runAws ??
    ((args) =>
      JSON.parse(
        execFileSync(
          'aws',
          [...args, '--region', input.region, '--no-cli-pager', '--output', 'json'],
          {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
          },
        ),
      ));
  const delay = input.delay ?? ((milliseconds) => wait(milliseconds));
  const identity = object(await runAws(['sts', 'get-caller-identity']), 'AWS_IDENTITY_INVALID');
  if (identity.Account !== accountId) throw new Error('AWS_ACCOUNT_MISMATCH');

  const smokeQuery = await queryUntilRows({
    delay,
    end: smokeCompletedAt,
    logGroup: API_LOG_GROUP,
    query:
      'fields @timestamp, event, trace_id, request_id, runtime_task_arn, ' +
      'runtime_task_definition_arn, runtime_image_digest, runtime_image_id ' +
      `| filter event = "HTTP_REQUEST_COMPLETED" and request_id = "${smokeRequestId}" ` +
      '| sort @timestamp asc | limit 10',
    runAws,
    start: smokeStartedAt,
  });
  const smokeRecord = selectSmokeRecord(smokeQuery.rows, smokeRequestId);
  const smokeLogRuntimeIdentity = runtimeLogIdentity(
    smokeRecord,
    'api',
    imageDigests.api,
    accountId,
    'SMOKE_RUNTIME_IDENTITY_MISMATCH',
  );
  if (!sameJson(smokeLogRuntimeIdentity, smokeRuntimeIdentity)) {
    throw new Error('SMOKE_RUNTIME_IDENTITY_MISMATCH');
  }

  const workerQuery = await queryUntilRows({
    delay,
    end: loadCompletedAt,
    logGroup: WORKER_LOG_GROUP,
    query:
      'fields @timestamp, event, trace_id, request_id, job_id, runtime_task_arn, ' +
      'runtime_task_definition_arn, runtime_image_digest, runtime_image_id ' +
      '| filter event = "WORKER_JOB_RECEIVED" and ispresent(trace_id) ' +
      `and request_id = "${loadRunId}" and ispresent(job_id) ` +
      '| sort @timestamp asc | limit 1000',
    runAws,
    start: loadStartedAt,
  });
  const workerRecord = selectLoadWorkerRecord(workerQuery.rows, loadRunId, acceptedJobs.ids);
  const workerRuntimeIdentity = runtimeLogIdentity(
    workerRecord,
    'worker',
    imageDigests.worker,
    accountId,
    'LOAD_WORKER_RUNTIME_IDENTITY_MISMATCH',
  );
  assertTaskDefinition(
    workerRuntimeIdentity,
    releaseContract.taskDefinitions.worker,
    'LOAD_WORKER_TASK_DEFINITION_MISMATCH',
  );

  const loadApiQuery = await queryUntilRows({
    delay,
    end: loadCompletedAt,
    logGroup: API_LOG_GROUP,
    query:
      'fields @timestamp, event, trace_id, request_id, runtime_task_arn, ' +
      'runtime_task_definition_arn, runtime_image_digest, runtime_image_id ' +
      `| filter event = "HTTP_REQUEST_COMPLETED" and request_id = "${workerRecord.request_id}" ` +
      `and trace_id = "${workerRecord.trace_id}" | sort @timestamp asc | limit 10`,
    runAws,
    start: loadStartedAt,
  });
  const loadApiRecord = selectLoadApiRecord(loadApiQuery.rows, workerRecord);
  const loadApiRuntimeIdentity = runtimeLogIdentity(
    loadApiRecord,
    'api',
    imageDigests.api,
    accountId,
    'LOAD_API_RUNTIME_IDENTITY_MISMATCH',
  );
  assertTaskDefinition(
    loadApiRuntimeIdentity,
    releaseContract.taskDefinitions.api,
    'LOAD_API_TASK_DEFINITION_MISMATCH',
  );

  const xrayTraceIds = [xrayTraceId(smokeRecord.trace_id), xrayTraceId(workerRecord.trace_id)];
  const xray = object(
    await runAws(['xray', 'batch-get-traces', '--trace-ids', ...xrayTraceIds]),
    'XRAY_RESPONSE_INVALID',
  );
  if (
    !Array.isArray(xray.UnprocessedTraceIds) ||
    xray.UnprocessedTraceIds.length !== 0 ||
    !Array.isArray(xray.Traces)
  ) {
    throw new Error('XRAY_TRACE_LOOKUP_INCOMPLETE');
  }
  const returnedTraceIds = new Set(
    xray.Traces.map((trace) => objectOrNull(trace)?.Id ?? '').filter((value) => value !== ''),
  );
  for (const traceId of xrayTraceIds) {
    if (!returnedTraceIds.has(traceId)) throw new Error(`XRAY_TRACE_MISSING:${traceId}`);
  }

  const outputPath = resolve(input.outputPath);
  const evidence = {
    schemaVersion: 'aeostudio.staging-trace-evidence.v1',
    outcome: 'PASS',
    environment: 'staging',
    repository,
    sourceSha,
    buildRunId,
    buildRunAttempt,
    releaseContract: releaseContract.binding,
    taskDefinitions: releaseContract.taskDefinitions,
    imageDigests,
    brokerRuntime,
    endpoint: { origin: endpointOrigin },
    loadRunId,
    acceptedJobsSha256: acceptedJobs.sha256,
    accountId,
    region: input.region,
    completedAt: (input.now ?? (() => new Date()))().toISOString(),
    sources: {
      cloudWatch: {
        apiLogGroup: API_LOG_GROUP,
        workerLogGroup: WORKER_LOG_GROUP,
        queryIds: [smokeQuery.queryId, workerQuery.queryId, loadApiQuery.queryId],
      },
      xray: { traceIds: xrayTraceIds },
    },
    correlations: {
      smokeRequest: {
        requestId: smokeRecord.request_id,
        traceId: smokeRecord.trace_id,
        apiEvent: smokeRecord.event,
        apiTimestamp: smokeRecord['@timestamp'],
        runtimeBuildIdentity: smokeLogRuntimeIdentity,
        webRuntimeBuildIdentity: smokeWebRuntimeIdentity,
        xrayTraceId: xrayTraceIds[0],
        xrayFound: true,
      },
      loadRequestJob: {
        requestId: workerRecord.request_id,
        traceId: workerRecord.trace_id,
        jobId: workerRecord.job_id,
        apiEvent: loadApiRecord.event,
        apiTimestamp: loadApiRecord['@timestamp'],
        workerEvent: workerRecord.event,
        workerTimestamp: workerRecord['@timestamp'],
        apiRuntimeBuildIdentity: loadApiRuntimeIdentity,
        workerRuntimeBuildIdentity: workerRuntimeIdentity,
        xrayTraceId: xrayTraceIds[1],
        xrayFound: true,
      },
    },
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return { outcome: 'PASS', evidencePath: outputPath };
}

function validateSourceEvidence(input) {
  const smoke = object(input.smoke, 'SMOKE_ENVELOPE_INVALID');
  if (
    smoke.schemaVersion !== 'aeostudio.staging-smoke-envelope.v1' ||
    smoke.sourceSha !== input.sourceSha ||
    smoke.buildRunId !== input.buildRunId ||
    smoke.buildRunAttempt !== input.buildRunAttempt
  ) {
    throw new Error('SMOKE_RELEASE_IDENTITY_MISMATCH');
  }
  const smokeBody = object(smoke.smoke, 'SMOKE_EVIDENCE_INVALID');
  if (
    smokeBody.schemaVersion !== 'aeostudio-staging-smoke.v1' ||
    smokeBody.environment !== 'staging' ||
    smokeBody.region !== 'ap-southeast-1'
  ) {
    throw new Error('SMOKE_EVIDENCE_INVALID');
  }
  const digests = object(smoke.digests, 'SMOKE_DIGESTS_INVALID');
  if (!sameKeys(digests, ['adot', 'api', 'tenantDataBroker', 'web', 'worker'])) {
    throw new Error('SMOKE_DIGESTS_INVALID');
  }
  const imageDigests = {
    adot: exact(digests.adot, DIGEST, 'SMOKE_ADOT_DIGEST_INVALID'),
    api: exact(digests.api, DIGEST, 'SMOKE_API_DIGEST_INVALID'),
    tenantDataBroker: exact(
      digests.tenantDataBroker,
      DIGEST,
      'SMOKE_TENANT_DATA_BROKER_DIGEST_INVALID',
    ),
    web: exact(digests.web, DIGEST, 'SMOKE_WEB_DIGEST_INVALID'),
    worker: exact(digests.worker, DIGEST, 'SMOKE_WORKER_DIGEST_INVALID'),
  };
  if (imageDigests.tenantDataBroker !== imageDigests.worker) {
    throw new Error('SMOKE_TENANT_DATA_BROKER_DIGEST_MISMATCH');
  }
  const brokerRuntime = object(smoke.brokerRuntime, 'SMOKE_TENANT_DATA_BROKER_RUNTIME_INVALID');
  const registry = `${input.accountId}.dkr.ecr.ap-southeast-1.amazonaws.com`;
  if (
    brokerRuntime.schemaVersion !== 'aeostudio.tenant-data-broker-runtime.v1' ||
    brokerRuntime.environment !== 'staging' ||
    brokerRuntime.region !== 'ap-southeast-1' ||
    brokerRuntime.accountId !== input.accountId ||
    brokerRuntime.releaseId !== `staging-${input.buildRunId}-${input.buildRunAttempt}` ||
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
  if (smokeBody.imageDigest !== imageDigests.api) throw new Error('SMOKE_API_DIGEST_MISMATCH');
  const endpoint = object(smokeBody.endpoint, 'SMOKE_ENDPOINT_INVALID');
  const endpointOrigin = exactHttpsOrigin(endpoint.origin, 'SMOKE_ENDPOINT_INVALID');
  const smokeRuntimeIdentity = runtimeEvidenceIdentity(
    smokeBody.runtimeBuildIdentity,
    'api',
    imageDigests.api,
    input.accountId,
    'SMOKE_RUNTIME_IDENTITY_MISMATCH',
  );
  const smokeWebRuntimeIdentity = runtimeEvidenceIdentity(
    smokeBody.webRuntimeBuildIdentity,
    'web',
    imageDigests.web,
    input.accountId,
    'SMOKE_WEB_RUNTIME_IDENTITY_MISMATCH',
  );

  const load = object(input.load, 'LOAD_EVIDENCE_INVALID');
  const identity = object(load.runIdentity, 'LOAD_RUN_IDENTITY_INVALID');
  const releaseDigests = object(identity.releaseImageDigests, 'LOAD_DIGESTS_INVALID');
  if (
    load.schemaVersion !== 'aeostudio.load-evidence.v2' ||
    identity.environment !== 'staging' ||
    identity.region !== 'ap-southeast-1' ||
    identity.awsAccountId !== input.accountId ||
    identity.buildRunId !== input.buildRunId ||
    identity.buildRunAttempt !== input.buildRunAttempt ||
    !sameKeys(releaseDigests, ['adot', 'api', 'tenantDataBroker', 'web', 'worker']) ||
    releaseDigests.adot !== imageDigests.adot ||
    releaseDigests.api !== imageDigests.api ||
    releaseDigests.tenantDataBroker !== imageDigests.tenantDataBroker ||
    releaseDigests.web !== imageDigests.web ||
    releaseDigests.worker !== imageDigests.worker
  ) {
    throw new Error('LOAD_RELEASE_IDENTITY_MISMATCH');
  }
  if (
    exactHttpsOrigin(identity.approvedOrigin, 'LOAD_APPROVED_ORIGIN_INVALID') !== endpointOrigin
  ) {
    throw new Error('LOAD_ENDPOINT_MISMATCH');
  }
  const loadRunId = exact(identity.loadRunId, UUID, 'LOAD_RUN_ID_INVALID');
  const acceptedJobs = validateAcceptedJobsEvidence(load.acceptedJobs);
  return {
    acceptedJobs,
    brokerRuntime,
    endpointOrigin,
    imageDigests,
    loadRunId,
    smokeRuntimeIdentity,
    smokeWebRuntimeIdentity,
  };
}

function sameKeys(value, expected) {
  return Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
}

async function queryUntilRows(input) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await queryLogs(input);
    if (result.rows.length > 0) return result;
    if (attempt < 11) await input.delay(5_000);
  }
  throw new Error(`CLOUDWATCH_LOG_CORRELATION_MISSING:${input.logGroup}`);
}

async function queryLogs(input) {
  const start = Math.max(0, Math.floor(new Date(input.start).getTime() / 1000) - 5);
  const end = Math.ceil(new Date(input.end).getTime() / 1000) + 5;
  const started = object(
    await input.runAws([
      'logs',
      'start-query',
      '--log-group-name',
      input.logGroup,
      '--start-time',
      String(start),
      '--end-time',
      String(end),
      '--query-string',
      input.query,
    ]),
    'CLOUDWATCH_QUERY_START_INVALID',
  );
  const queryId = exact(started.queryId, /^[A-Za-z0-9-]{3,128}$/u, 'CLOUDWATCH_QUERY_ID_INVALID');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = object(
      await input.runAws(['logs', 'get-query-results', '--query-id', queryId]),
      'CLOUDWATCH_QUERY_RESULT_INVALID',
    );
    if (response.status === 'Complete') {
      if (!Array.isArray(response.results)) throw new Error('CLOUDWATCH_QUERY_RESULT_INVALID');
      return { queryId, rows: response.results.map(queryRow) };
    }
    if (TERMINAL_QUERY_FAILURES.has(response.status)) {
      throw new Error(`CLOUDWATCH_QUERY_FAILED:${String(response.status)}`);
    }
    if (attempt < 29) await input.delay(2_000);
  }
  throw new Error('CLOUDWATCH_QUERY_TIMEOUT');
}

function queryRow(value) {
  if (!Array.isArray(value)) throw new Error('CLOUDWATCH_QUERY_ROW_INVALID');
  const row = {};
  for (const field of value) {
    const entry = object(field, 'CLOUDWATCH_QUERY_FIELD_INVALID');
    if (
      ![
        '@timestamp',
        'event',
        'trace_id',
        'request_id',
        'job_id',
        'runtime_task_arn',
        'runtime_task_definition_arn',
        'runtime_image_digest',
        'runtime_image_id',
      ].includes(entry.field) ||
      typeof entry.value !== 'string' ||
      Object.hasOwn(row, entry.field)
    ) {
      throw new Error('CLOUDWATCH_QUERY_FIELD_INVALID');
    }
    row[entry.field] = entry.value;
  }
  return row;
}

function runtimeEvidenceIdentity(value, service, expectedDigest, accountId, errorCode) {
  const identity = object(value, errorCode);
  if (
    identity.schemaVersion !== 'aeostudio.runtime-build-identity.v1' ||
    identity.source !== 'ecs-container-metadata-v4' ||
    identity.service !== service ||
    identity.imageDigest !== expectedDigest ||
    identity.imageId !== expectedDigest ||
    typeof identity.image !== 'string' ||
    !identity.image.endsWith(`@${expectedDigest}`) ||
    typeof identity.containerArn !== 'string' ||
    !identity.containerArn.startsWith(`arn:aws:ecs:ap-southeast-1:${accountId}:container/`)
  ) {
    throw new Error(errorCode);
  }
  return runtimeLogIdentity(
    {
      runtime_task_arn: identity.taskArn,
      runtime_task_definition_arn: identity.taskDefinitionArn,
      runtime_image_digest: identity.imageDigest,
      runtime_image_id: identity.imageId,
    },
    service,
    expectedDigest,
    accountId,
    errorCode,
  );
}

function runtimeLogIdentity(row, service, expectedDigest, accountId, errorCode) {
  const taskArn = exact(row.runtime_task_arn, ECS_TASK_ARN, errorCode);
  const taskDefinitionArn = exact(
    row.runtime_task_definition_arn,
    ECS_TASK_DEFINITION_ARN,
    errorCode,
  );
  const imageDigest = exact(row.runtime_image_digest, DIGEST, errorCode);
  const imageId = exact(row.runtime_image_id, DIGEST, errorCode);
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

function selectSmokeRecord(rows, requestId) {
  const record = rows.find(
    (row) =>
      row.event === 'HTTP_REQUEST_COMPLETED' &&
      row.request_id === requestId &&
      TRACE_ID.test(row.trace_id ?? '') &&
      validLogTimestamp(row['@timestamp']),
  );
  if (record === undefined) throw new Error('SMOKE_TRACE_CORRELATION_MISSING');
  return record;
}

function selectLoadWorkerRecord(rows, loadRunId, acceptedJobIds) {
  const accepted = new Set(acceptedJobIds);
  const record = rows.find(
    (row) =>
      row.event === 'WORKER_JOB_RECEIVED' &&
      TRACE_ID.test(row.trace_id ?? '') &&
      row.request_id === loadRunId &&
      UUID.test(row.job_id ?? '') &&
      accepted.has(row.job_id) &&
      validLogTimestamp(row['@timestamp']),
  );
  if (record === undefined) throw new Error('LOAD_WORKER_TRACE_CORRELATION_MISSING');
  return record;
}

function selectLoadApiRecord(rows, workerRecord) {
  const record = rows.find(
    (row) =>
      row.event === 'HTTP_REQUEST_COMPLETED' &&
      row.trace_id === workerRecord.trace_id &&
      row.request_id === workerRecord.request_id &&
      validLogTimestamp(row['@timestamp']),
  );
  if (record === undefined) throw new Error('LOAD_API_WORKER_TRACE_CORRELATION_MISSING');
  return record;
}

function xrayTraceId(traceId) {
  return `1-${traceId.slice(0, 8)}-${traceId.slice(8)}`;
}

function validLogTimestamp(value) {
  return (
    typeof value === 'string' && Number.isFinite(new Date(value.replace(' ', 'T') + 'Z').valueOf())
  );
}

function assertWindow(start, end, errorCode) {
  if (new Date(start).getTime() > new Date(end).getTime()) throw new Error(errorCode);
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

function exactHttpsOrigin(value, errorCode) {
  if (typeof value !== 'string') throw new Error(errorCode);
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(errorCode, { cause: error });
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.origin !== value
  ) {
    throw new Error(errorCode);
  }
  return value;
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

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function wait(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    const result = await collectStagingTraceEvidence({
      accountId: requiredEnvironment('AEO_ACCEPTANCE_AWS_ACCOUNT_ID'),
      apiLogGroup: requiredEnvironment('AEO_ACCEPTANCE_API_LOG_GROUP'),
      buildRunAttempt: requiredEnvironment('AEO_ACCEPTANCE_BUILD_RUN_ATTEMPT'),
      buildRunId: requiredEnvironment('AEO_ACCEPTANCE_BUILD_RUN_ID'),
      loadEvidencePath: requiredEnvironment('AEO_ACCEPTANCE_LOAD_EVIDENCE_PATH'),
      loadStartedAt: requiredEnvironment('AEO_ACCEPTANCE_LOAD_STARTED_AT'),
      outputPath: requiredEnvironment('AEO_ACCEPTANCE_TRACE_EVIDENCE_PATH'),
      region: requiredEnvironment('AWS_REGION'),
      releaseContractPath: requiredEnvironment('AEO_ACCEPTANCE_RELEASE_CONTRACT_PATH'),
      repository: requiredEnvironment('GITHUB_REPOSITORY'),
      smokeEnvelopePath: requiredEnvironment('AEO_ACCEPTANCE_SMOKE_ENVELOPE_PATH'),
      sourceSha: requiredEnvironment('AEO_ACCEPTANCE_SOURCE_SHA'),
      workerLogGroup: requiredEnvironment('AEO_ACCEPTANCE_WORKER_LOG_GROUP'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'STAGING_TRACE_EVIDENCE_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
