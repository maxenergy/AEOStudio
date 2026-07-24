/* global process */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ACCOUNT_ID = /^[0-9]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const POST_APPROVAL_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;

export function validateProductionFinalizationEvidence(input) {
  const expected = validateExpected(input.expected);
  const release = validateRelease(input.manifest, expected);
  const contract = validateContract(input.contractEnvelope, expected, release);
  const apiWeb = validateApiWebRuntime(input.apiWebRuntime, expected, release, contract);
  const broker = validateBrokerRuntime(input.brokerRuntime, expected, release, contract);
  const health = validateProbe(input.health, 'alive', 'PRODUCTION_HEALTH_EVIDENCE_INVALID');
  const readiness = validateProbe(
    input.readiness,
    'ready',
    'PRODUCTION_READINESS_EVIDENCE_INVALID',
  );
  const smoke = validateSmokeEnvelope({
    value: input.smokeEnvelope,
    expected,
    release,
    apiWeb: input.apiWebRuntime,
    broker: input.brokerRuntime,
    healthSha256: health.sha256,
    readinessSha256: readiness.sha256,
  });
  validatePostApprovalSnapshotTime(
    expected.githubEnvironmentValidatedAt,
    smoke.completedAt,
    expected.now,
  );
  validatePostApprovalSnapshotTime(
    expected.promotionControlPlaneValidatedAt,
    smoke.completedAt,
    expected.now,
  );

  const core = {
    schemaVersion: 'aeostudio.production-finalization-evidence.v1',
    outcome: 'PASS',
    environment: 'production',
    region: expected.region,
    accountId: expected.accountId,
    repository: expected.repository,
    sourceSha: expected.sourceSha,
    buildRunId: expected.buildRunId,
    buildRunAttempt: expected.buildRunAttempt,
    releaseId: expected.releaseId,
    endpointOrigin: expected.origin,
    runtimeIdentity: {
      clusterArn: apiWeb.clusterArn,
      apiTaskDefinitionArn: apiWeb.services.api.taskDefinitionArn,
      webTaskDefinitionArn: apiWeb.services.web.taskDefinitionArn,
      brokerTaskDefinitionArn: broker.taskDefinitionArn,
      apiImageDigest: release.digests.api,
      webImageDigest: release.digests.web,
      endpointOrigin: apiWeb.route.origin,
      loadBalancerArn: apiWeb.route.loadBalancerArn,
      listenerArn: apiWeb.route.listenerArn,
    },
    evidence: {
      manifestSha256: hashJson(input.manifest),
      contractSha256: hashJson(input.contractEnvelope),
      apiWebRuntimeSha256: hashJson(input.apiWebRuntime),
      brokerRuntimeSha256: hashJson(input.brokerRuntime),
      smokeSha256: hashJson(input.smokeEnvelope),
      healthSha256: health.sha256,
      readinessSha256: readiness.sha256,
      githubEnvironmentEvidenceSha256: expected.githubEnvironmentEvidenceSha256,
      githubEnvironmentSnapshotSha256: expected.githubEnvironmentSnapshotSha256,
      githubEnvironmentValidatedAt: expected.githubEnvironmentValidatedAt.canonical,
      promotionControlPlaneEvidenceSha256: expected.promotionControlPlaneEvidenceSha256,
      promotionControlPlaneSnapshotSha256: expected.promotionControlPlaneSnapshotSha256,
      promotionControlPlaneValidatedAt: expected.promotionControlPlaneValidatedAt.canonical,
    },
  };
  return {
    ...core,
    evidenceSha256: createHash('sha256').update(JSON.stringify(core)).digest('hex'),
  };
}

function validateExpected(value) {
  const expected = object(value, 'PRODUCTION_FINALIZATION_EXPECTED_INVALID');
  return {
    accountId: exact(expected.accountId, ACCOUNT_ID, 'PRODUCTION_ACCOUNT_ID_INVALID'),
    region:
      expected.region === 'ap-southeast-1' ? expected.region : fail('PRODUCTION_REGION_INVALID'),
    repository: exact(expected.repository, REPOSITORY, 'PRODUCTION_REPOSITORY_INVALID'),
    sourceSha: exact(expected.sourceSha, SHA, 'PRODUCTION_SOURCE_SHA_INVALID'),
    buildRunId: exact(expected.buildRunId, POSITIVE_INTEGER, 'PRODUCTION_BUILD_RUN_ID_INVALID'),
    buildRunAttempt: exact(
      expected.buildRunAttempt,
      POSITIVE_INTEGER,
      'PRODUCTION_BUILD_RUN_ATTEMPT_INVALID',
    ),
    releaseId: exact(
      expected.releaseId,
      /^production-[1-9][0-9]*-[1-9][0-9]*$/u,
      'PRODUCTION_RELEASE_ID_INVALID',
    ),
    origin: rootHttpsUrl(expected.origin, 'PRODUCTION_ORIGIN_INVALID'),
    githubEnvironmentEvidenceSha256: exact(
      expected.githubEnvironmentEvidenceSha256,
      SHA256,
      'PRODUCTION_GITHUB_ENVIRONMENT_EVIDENCE_SHA256_INVALID',
    ),
    githubEnvironmentSnapshotSha256: exact(
      expected.githubEnvironmentSnapshotSha256,
      SHA256,
      'PRODUCTION_GITHUB_ENVIRONMENT_SNAPSHOT_SHA256_INVALID',
    ),
    githubEnvironmentValidatedAt: timestamp(
      expected.githubEnvironmentValidatedAt,
      'PRODUCTION_GITHUB_ENVIRONMENT_VALIDATED_AT_INVALID',
    ),
    promotionControlPlaneEvidenceSha256: exact(
      expected.promotionControlPlaneEvidenceSha256,
      SHA256,
      'PRODUCTION_PROMOTION_CONTROL_PLANE_EVIDENCE_SHA256_INVALID',
    ),
    promotionControlPlaneSnapshotSha256: exact(
      expected.promotionControlPlaneSnapshotSha256,
      SHA256,
      'PRODUCTION_PROMOTION_CONTROL_PLANE_SNAPSHOT_SHA256_INVALID',
    ),
    promotionControlPlaneValidatedAt: timestamp(
      expected.promotionControlPlaneValidatedAt,
      'PRODUCTION_PROMOTION_CONTROL_PLANE_VALIDATED_AT_INVALID',
    ),
    now: timestamp(expected.now, 'PRODUCTION_FINALIZATION_NOW_INVALID'),
  };
}

export function validateGitHubEnvironmentEvidenceHash(value, expected, expectedSha256) {
  const evidence = object(value, 'PRODUCTION_GITHUB_ENVIRONMENT_EVIDENCE_INVALID');
  if (
    !sameKeys(evidence, [
      'schemaVersion',
      'repository',
      'sourceSha',
      'production',
      'stagingDeployment',
      'evidenceSha256',
      'validatedAt',
    ]) ||
    evidence.schemaVersion !== 'aeostudio.github-environment-evidence.v1' ||
    evidence.repository !== expected.repository ||
    evidence.sourceSha !== expected.sourceSha
  ) {
    fail('PRODUCTION_GITHUB_ENVIRONMENT_EVIDENCE_INVALID');
  }
  const core = {
    schemaVersion: evidence.schemaVersion,
    repository: evidence.repository,
    sourceSha: evidence.sourceSha,
    production: object(evidence.production, 'PRODUCTION_GITHUB_ENVIRONMENT_EVIDENCE_INVALID'),
    stagingDeployment: object(
      evidence.stagingDeployment,
      'PRODUCTION_GITHUB_ENVIRONMENT_EVIDENCE_INVALID',
    ),
  };
  const stableSha256 = exact(
    evidence.evidenceSha256,
    SHA256,
    'PRODUCTION_GITHUB_ENVIRONMENT_EVIDENCE_INVALID',
  );
  if (hashJson(core) !== stableSha256) fail('PRODUCTION_GITHUB_ENVIRONMENT_EVIDENCE_INVALID');
  if (
    stableSha256 !==
    exact(expectedSha256, SHA256, 'PRODUCTION_EXPECTED_GITHUB_ENVIRONMENT_EVIDENCE_SHA256_INVALID')
  ) {
    fail('PRODUCTION_GITHUB_ENVIRONMENT_EVIDENCE_HASH_MISMATCH');
  }
  const validatedAt = timestamp(
    evidence.validatedAt,
    'PRODUCTION_GITHUB_ENVIRONMENT_EVIDENCE_INVALID',
  ).canonical;
  return {
    stableSha256,
    snapshotSha256: canonicalJsonSha256({
      ...core,
      evidenceSha256: stableSha256,
      validatedAt,
    }),
    validatedAt,
  };
}

export function validatePromotionControlPlaneEvidenceHash(value, expected, expectedSha256) {
  const evidence = object(value, 'PRODUCTION_PROMOTION_CONTROL_PLANE_EVIDENCE_INVALID');
  if (
    !sameKeys(evidence, [
      'schemaVersion',
      'repository',
      'sourceSha',
      'maxAgeHours',
      'runs',
      'artifacts',
      'controlPlaneSha256',
      'validatedAt',
    ]) ||
    evidence.schemaVersion !== 'aeostudio.github-promotion-control-plane.v1' ||
    evidence.repository !== expected.repository ||
    evidence.sourceSha !== expected.sourceSha
  ) {
    fail('PRODUCTION_PROMOTION_CONTROL_PLANE_EVIDENCE_INVALID');
  }
  const validatedAt = timestamp(
    evidence.validatedAt,
    'PRODUCTION_PROMOTION_CONTROL_PLANE_EVIDENCE_INVALID',
  ).canonical;
  const core = {
    schemaVersion: evidence.schemaVersion,
    repository: evidence.repository,
    sourceSha: evidence.sourceSha,
    maxAgeHours: evidence.maxAgeHours,
    runs: object(evidence.runs, 'PRODUCTION_PROMOTION_CONTROL_PLANE_EVIDENCE_INVALID'),
    artifacts: object(evidence.artifacts, 'PRODUCTION_PROMOTION_CONTROL_PLANE_EVIDENCE_INVALID'),
  };
  const stableSha256 = exact(
    evidence.controlPlaneSha256,
    SHA256,
    'PRODUCTION_PROMOTION_CONTROL_PLANE_EVIDENCE_INVALID',
  );
  if (hashJson(core) !== stableSha256) fail('PRODUCTION_PROMOTION_CONTROL_PLANE_EVIDENCE_INVALID');
  if (
    stableSha256 !==
    exact(
      expectedSha256,
      SHA256,
      'PRODUCTION_EXPECTED_PROMOTION_CONTROL_PLANE_EVIDENCE_SHA256_INVALID',
    )
  ) {
    fail('PRODUCTION_PROMOTION_CONTROL_PLANE_EVIDENCE_HASH_MISMATCH');
  }
  return {
    stableSha256,
    snapshotSha256: canonicalJsonSha256({
      ...core,
      controlPlaneSha256: stableSha256,
      validatedAt,
    }),
    validatedAt,
  };
}

function validateRelease(value, expected) {
  const manifest = object(value, 'PRODUCTION_RELEASE_MANIFEST_INVALID');
  const images = object(manifest.images, 'PRODUCTION_RELEASE_IMAGES_INVALID');
  if (
    manifest.schemaVersion !== 'aeostudio.release.v1' ||
    manifest.repository !== expected.repository ||
    manifest.sourceSha !== expected.sourceSha ||
    manifest.sourceRef !== 'refs/heads/main' ||
    manifest.buildRunId !== expected.buildRunId ||
    manifest.buildRunAttempt !== expected.buildRunAttempt ||
    !sameKeys(images, ['adot', 'api', 'web', 'worker'])
  ) {
    fail('PRODUCTION_RELEASE_MANIFEST_INVALID');
  }
  const digests = {};
  const references = {};
  for (const service of ['adot', 'api', 'web', 'worker']) {
    const record = object(images[service], 'PRODUCTION_RELEASE_IMAGES_INVALID');
    const image = `${expected.accountId}.dkr.ecr.${expected.region}.amazonaws.com/aeostudio-${service}`;
    if (record.image !== image) fail('PRODUCTION_RELEASE_IMAGES_INVALID');
    const digest = exact(record.digest, DIGEST, 'PRODUCTION_RELEASE_IMAGES_INVALID');
    digests[service] = digest;
    references[service] = `${image}@${digest}`;
  }
  return { digests, references };
}

function validateContract(value, expected, release) {
  const envelope = object(value, 'PRODUCTION_RELEASE_CONTRACT_INVALID');
  const contract = object(envelope.contract, 'PRODUCTION_RELEASE_CONTRACT_INVALID');
  const images = object(contract.Images, 'PRODUCTION_RELEASE_CONTRACT_INVALID');
  const taskDefinitions = object(contract.TaskDefinitions, 'PRODUCTION_RELEASE_CONTRACT_INVALID');
  if (
    envelope.executionStatus !== 'SUCCEEDED' ||
    contract.SchemaVersion !== 'aeostudio.release-contract.v2' ||
    contract.Environment !== 'production' ||
    contract.Region !== expected.region ||
    contract.AccountId !== expected.accountId ||
    contract.ReleaseId !== expected.releaseId ||
    images.Adot !== release.references.adot ||
    images.Api !== release.references.api ||
    images.Web !== release.references.web ||
    images.Worker !== release.references.worker ||
    images.TenantDataBroker !== release.references.worker
  ) {
    fail('PRODUCTION_RELEASE_CONTRACT_INVALID');
  }
  const definitions = {};
  for (const [service, family] of [
    ['api', 'api'],
    ['web', 'web'],
    ['worker', 'worker'],
    ['broker', 'tenant-data-broker'],
  ]) {
    const title =
      service === 'broker' ? 'TenantDataBroker' : `${service[0].toUpperCase()}${service.slice(1)}`;
    definitions[service] = exact(
      taskDefinitions[title],
      new RegExp(
        `^arn:aws:ecs:${expected.region}:${expected.accountId}:task-definition/aeostudio-production-${family}:[1-9][0-9]*$`,
        'u',
      ),
      'PRODUCTION_RELEASE_CONTRACT_INVALID',
    );
  }
  return { taskDefinitions: definitions };
}

function validateApiWebRuntime(value, expected, release, contract) {
  const runtime = object(value, 'PRODUCTION_API_WEB_RUNTIME_INVALID');
  const services = object(runtime.services, 'PRODUCTION_API_WEB_RUNTIME_INVALID');
  const route = object(runtime.routeBinding, 'PRODUCTION_API_WEB_RUNTIME_INVALID');
  const routeServices = object(route.services, 'PRODUCTION_API_WEB_RUNTIME_INVALID');
  const clusterName = 'aeostudio-production';
  const clusterArn = `arn:aws:ecs:${expected.region}:${expected.accountId}:cluster/${clusterName}`;
  if (
    runtime.schemaVersion !== 'aeostudio.production-api-web-runtime.v1' ||
    runtime.environment !== 'production' ||
    runtime.region !== expected.region ||
    runtime.accountId !== expected.accountId ||
    runtime.releaseId !== expected.releaseId ||
    runtime.clusterName !== clusterName ||
    runtime.clusterArn !== clusterArn ||
    !sameKeys(services, ['api', 'web']) ||
    !sameKeys(routeServices, ['api', 'web']) ||
    route.origin !== expected.origin ||
    route.hostname !== new URL(expected.origin).hostname ||
    !/^[A-Z0-9]+$/u.test(route.hostedZoneId ?? '') ||
    typeof route.aliasDnsName !== 'string' ||
    route.aliasDnsName.length === 0 ||
    !new RegExp(
      `^arn:aws:elasticloadbalancing:${expected.region}:${expected.accountId}:loadbalancer/app/${clusterName}/[0-9a-f]+$`,
      'u',
    ).test(route.loadBalancerArn) ||
    !new RegExp(
      `^arn:aws:elasticloadbalancing:${expected.region}:${expected.accountId}:listener/app/${clusterName}/[0-9a-f]+/[0-9a-f]+$`,
      'u',
    ).test(route.listenerArn) ||
    route.ipAddressType !== 'ipv4' ||
    !Array.isArray(route.routeRecordTypes) ||
    route.routeRecordTypes.length !== 1 ||
    route.routeRecordTypes[0] !== 'A' ||
    !/^vpc-[0-9a-f]+$/u.test(route.vpcId ?? '')
  ) {
    fail('PRODUCTION_API_WEB_RUNTIME_INVALID');
  }
  const validated = {};
  for (const service of ['api', 'web']) {
    const record = object(services[service], 'PRODUCTION_API_WEB_RUNTIME_INVALID');
    if (
      record.taskDefinitionArn !== contract.taskDefinitions[service] ||
      record.image !== release.references[service] ||
      record.imageDigest !== release.digests[service] ||
      record.desiredCount !== 2 ||
      record.runningCount !== 2 ||
      record.pendingCount !== 0 ||
      !Array.isArray(record.tasks) ||
      record.tasks.length !== 2
    ) {
      fail('PRODUCTION_API_WEB_RUNTIME_INVALID');
    }
    const taskArns = record.tasks.map((taskValue) => {
      const task = object(taskValue, 'PRODUCTION_API_WEB_RUNTIME_INVALID');
      if (
        task.imageDigest !== release.digests[service] ||
        !privateIpv4(task.privateIp) ||
        !new RegExp(
          `^arn:aws:ecs:${expected.region}:${expected.accountId}:task/${clusterName}/[0-9a-f]{32}$`,
          'u',
        ).test(task.taskArn)
      ) {
        fail('PRODUCTION_API_WEB_RUNTIME_INVALID');
      }
      return { taskArn: task.taskArn, privateIp: task.privateIp };
    });
    if (
      new Set(taskArns.map((task) => task.taskArn)).size !== 2 ||
      taskArns.map((task) => task.taskArn).join('\n') !==
        [...taskArns]
          .map((task) => task.taskArn)
          .sort()
          .join('\n')
    ) {
      fail('PRODUCTION_API_WEB_RUNTIME_INVALID');
    }
    const routeService = object(routeServices[service], 'PRODUCTION_API_WEB_RUNTIME_INVALID');
    const port = service === 'api' ? 3200 : 3100;
    if (
      !new RegExp(
        `^arn:aws:elasticloadbalancing:${expected.region}:${expected.accountId}:targetgroup/${clusterName}-${service}/[0-9a-f]+$`,
        'u',
      ).test(routeService.targetGroupArn) ||
      routeService.targetPort !== port ||
      !Array.isArray(routeService.healthyTargetIps) ||
      routeService.healthyTargetIps.length !== 2 ||
      routeService.healthyTargetIps.some((address) => !privateIpv4(address))
    ) {
      fail('PRODUCTION_API_WEB_RUNTIME_INVALID');
    }
    const routeIps = [...routeService.healthyTargetIps].sort();
    const taskIps = taskArns.map((task) => task.privateIp).sort();
    if (new Set(routeIps).size !== 2 || routeIps.join('\n') !== taskIps.join('\n')) {
      fail('PRODUCTION_API_WEB_RUNTIME_INVALID');
    }
    validated[service] = {
      taskDefinitionArn: record.taskDefinitionArn,
      tasks: taskArns.map((task) => task.taskArn),
    };
  }
  return {
    clusterArn,
    services: validated,
    route: {
      origin: route.origin,
      loadBalancerArn: route.loadBalancerArn,
      listenerArn: route.listenerArn,
    },
  };
}

function validateBrokerRuntime(value, expected, release, contract) {
  const runtime = object(value, 'PRODUCTION_BROKER_RUNTIME_INVALID');
  if (
    runtime.schemaVersion !== 'aeostudio.tenant-data-broker-runtime.v1' ||
    runtime.environment !== 'production' ||
    runtime.region !== expected.region ||
    runtime.accountId !== expected.accountId ||
    runtime.releaseId !== expected.releaseId ||
    runtime.taskDefinitionArn !== contract.taskDefinitions.broker ||
    runtime.desiredCount !== 2 ||
    runtime.runningCount !== 2 ||
    runtime.pendingCount !== 0 ||
    runtime.healthyTargetCount !== 2 ||
    runtime.workerImage !== release.references.worker ||
    runtime.adotImage !== release.references.adot ||
    !DIGEST.test(runtime.adotRuntimeDigest) ||
    !Array.isArray(runtime.tasks) ||
    runtime.tasks.length !== 2
  ) {
    fail('PRODUCTION_BROKER_RUNTIME_INVALID');
  }
  const taskArns = runtime.tasks.map((taskValue) => {
    const task = object(taskValue, 'PRODUCTION_BROKER_RUNTIME_INVALID');
    if (
      task.brokerRuntimeDigest !== release.digests.worker ||
      task.adotRuntimeDigest !== runtime.adotRuntimeDigest ||
      !new RegExp(
        `^arn:aws:ecs:${expected.region}:${expected.accountId}:task/aeostudio-production/[0-9a-f]{32}$`,
        'u',
      ).test(task.taskArn)
    ) {
      fail('PRODUCTION_BROKER_RUNTIME_INVALID');
    }
    return task.taskArn;
  });
  if (new Set(taskArns).size !== 2 || taskArns.join('\n') !== [...taskArns].sort().join('\n')) {
    fail('PRODUCTION_BROKER_RUNTIME_INVALID');
  }
  return { taskDefinitionArn: runtime.taskDefinitionArn };
}

function validateProbe(value, status, code) {
  const probe = object(value, code);
  if (!Buffer.isBuffer(probe.raw)) fail(code);
  const response = object(probe.value, code);
  if (object(response.data, code).status !== status) fail(code);
  return { sha256: createHash('sha256').update(probe.raw).digest('hex') };
}

function validateSmokeEnvelope(input) {
  const smoke = object(input.value, 'PRODUCTION_SMOKE_EVIDENCE_INVALID');
  const endpoint = object(smoke.endpoint, 'PRODUCTION_SMOKE_EVIDENCE_INVALID');
  const digests = object(smoke.digests, 'PRODUCTION_SMOKE_EVIDENCE_INVALID');
  const checks = object(smoke.checks, 'PRODUCTION_SMOKE_EVIDENCE_INVALID');
  const health = object(checks.health, 'PRODUCTION_SMOKE_EVIDENCE_INVALID');
  const readiness = object(checks.readiness, 'PRODUCTION_SMOKE_EVIDENCE_INVALID');
  if (
    smoke.schemaVersion !== 'aeostudio.production-smoke-envelope.v2' ||
    smoke.environment !== 'production' ||
    smoke.region !== input.expected.region ||
    smoke.accountId !== input.expected.accountId ||
    smoke.repository !== input.expected.repository ||
    smoke.sourceSha !== input.expected.sourceSha ||
    smoke.buildRunId !== input.expected.buildRunId ||
    smoke.buildRunAttempt !== input.expected.buildRunAttempt ||
    smoke.releaseId !== input.expected.releaseId ||
    endpoint.origin !== input.expected.origin ||
    digests.adot !== input.release.digests.adot ||
    digests.api !== input.release.digests.api ||
    digests.web !== input.release.digests.web ||
    digests.worker !== input.release.digests.worker ||
    digests.tenantDataBroker !== input.release.digests.worker ||
    JSON.stringify(smoke.apiWebRuntime) !== JSON.stringify(input.apiWeb) ||
    JSON.stringify(smoke.brokerRuntime) !== JSON.stringify(input.broker) ||
    health.status !== 200 ||
    health.responseSha256 !== input.healthSha256 ||
    health.effectiveUrl !== `${input.expected.origin}/health` ||
    isIP(health.remoteIp) !== 4 ||
    health.tlsVerifyResult !== 0 ||
    readiness.status !== 200 ||
    readiness.responseSha256 !== input.readinessSha256 ||
    readiness.effectiveUrl !== `${input.expected.origin}/ready` ||
    isIP(readiness.remoteIp) !== 4 ||
    readiness.tlsVerifyResult !== 0 ||
    checks.apiRuntimeIdentity !== 'PASSED' ||
    checks.webRuntimeIdentity !== 'PASSED'
  ) {
    fail('PRODUCTION_SMOKE_EVIDENCE_INVALID');
  }
  return {
    completedAt: timestamp(smoke.completedAt, 'PRODUCTION_SMOKE_EVIDENCE_INVALID'),
  };
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function canonicalJsonSha256(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson(value)))
    .digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalJson(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function timestamp(value, code) {
  if (typeof value !== 'string') fail(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) fail(code);
  return { canonical: value, milliseconds: parsed.getTime() };
}

function validatePostApprovalSnapshotTime(validatedAt, smokeCompletedAt, now) {
  if (validatedAt.milliseconds < smokeCompletedAt.milliseconds) {
    fail('PRODUCTION_POST_APPROVAL_EVIDENCE_BEFORE_SMOKE');
  }
  if (validatedAt.milliseconds > now.milliseconds) {
    fail('PRODUCTION_POST_APPROVAL_EVIDENCE_FROM_FUTURE');
  }
  if (now.milliseconds - validatedAt.milliseconds > POST_APPROVAL_SNAPSHOT_MAX_AGE_MS) {
    fail('PRODUCTION_POST_APPROVAL_EVIDENCE_EXPIRED');
  }
}

function rootHttpsUrl(value, code) {
  if (typeof value !== 'string' || value.endsWith('/')) fail(code);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(code);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.pathname !== '/' ||
    parsed.port !== '' ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
      parsed.hostname,
    ) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    fail(code);
  }
  return value;
}

function privateIpv4(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) return false;
  const octets = value.split('.').map(Number);
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function sameKeys(value, keys) {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value)
      .sort()
      .every((key, index) => key === [...keys].sort()[index])
  );
}

function exact(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code);
  return value;
}

function object(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function fail(code) {
  throw new Error(code);
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value || /[\r\n]/u.test(value)) fail(`${name}_REQUIRED`);
  return value;
}

async function readJson(path, code) {
  const resolved = resolve(path);
  const raw = await readFile(resolved);
  let value;
  try {
    value = object(JSON.parse(raw.toString('utf8')), code);
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    throw new Error(code, { cause: error });
  }
  return { raw, value };
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    const [
      manifest,
      contractEnvelope,
      apiWebRuntime,
      brokerRuntime,
      health,
      readiness,
      smoke,
      githubEnvironmentEvidence,
      promotionControlPlaneEvidence,
    ] = await Promise.all([
      readJson(
        requiredEnvironment('AEO_PRODUCTION_RELEASE_MANIFEST_PATH'),
        'PRODUCTION_RELEASE_MANIFEST_INVALID',
      ),
      readJson(
        requiredEnvironment('AEO_PRODUCTION_RELEASE_CONTRACT_PATH'),
        'PRODUCTION_RELEASE_CONTRACT_INVALID',
      ),
      readJson(
        requiredEnvironment('AEO_PRODUCTION_API_WEB_RUNTIME_PATH'),
        'PRODUCTION_API_WEB_RUNTIME_INVALID',
      ),
      readJson(
        requiredEnvironment('AEO_PRODUCTION_BROKER_RUNTIME_PATH'),
        'PRODUCTION_BROKER_RUNTIME_INVALID',
      ),
      readJson(
        requiredEnvironment('AEO_PRODUCTION_HEALTH_PATH'),
        'PRODUCTION_HEALTH_EVIDENCE_INVALID',
      ),
      readJson(
        requiredEnvironment('AEO_PRODUCTION_READINESS_PATH'),
        'PRODUCTION_READINESS_EVIDENCE_INVALID',
      ),
      readJson(
        requiredEnvironment('AEO_PRODUCTION_SMOKE_PATH'),
        'PRODUCTION_SMOKE_EVIDENCE_INVALID',
      ),
      readJson(
        requiredEnvironment('AEO_PRODUCTION_GITHUB_ENVIRONMENT_EVIDENCE_PATH'),
        'PRODUCTION_GITHUB_ENVIRONMENT_EVIDENCE_INVALID',
      ),
      readJson(
        requiredEnvironment('AEO_PRODUCTION_PROMOTION_CONTROL_PLANE_EVIDENCE_PATH'),
        'PRODUCTION_PROMOTION_CONTROL_PLANE_EVIDENCE_INVALID',
      ),
    ]);
    const persistedEvidenceIdentity = {
      repository: requiredEnvironment('GITHUB_REPOSITORY'),
      sourceSha: requiredEnvironment('AEO_PRODUCTION_SOURCE_SHA'),
    };
    const githubEnvironment = validateGitHubEnvironmentEvidenceHash(
      githubEnvironmentEvidence.value,
      persistedEvidenceIdentity,
      requiredEnvironment('AEO_PRODUCTION_EXPECTED_GITHUB_ENVIRONMENT_EVIDENCE_SHA256'),
    );
    const promotionControlPlane = validatePromotionControlPlaneEvidenceHash(
      promotionControlPlaneEvidence.value,
      persistedEvidenceIdentity,
      requiredEnvironment('AEO_PRODUCTION_EXPECTED_PROMOTION_CONTROL_PLANE_EVIDENCE_SHA256'),
    );
    const now = new Date().toISOString();
    const result = validateProductionFinalizationEvidence({
      manifest: manifest.value,
      contractEnvelope: contractEnvelope.value,
      apiWebRuntime: apiWebRuntime.value,
      brokerRuntime: brokerRuntime.value,
      health,
      readiness,
      smokeEnvelope: smoke.value,
      expected: {
        accountId: requiredEnvironment('AEO_PRODUCTION_AWS_ACCOUNT_ID'),
        region: requiredEnvironment('AWS_REGION'),
        repository: persistedEvidenceIdentity.repository,
        sourceSha: persistedEvidenceIdentity.sourceSha,
        buildRunId: requiredEnvironment('AEO_PRODUCTION_BUILD_RUN_ID'),
        buildRunAttempt: requiredEnvironment('AEO_PRODUCTION_BUILD_RUN_ATTEMPT'),
        releaseId: requiredEnvironment('AEO_PRODUCTION_RELEASE_ID'),
        origin: requiredEnvironment('AEO_PRODUCTION_ORIGIN'),
        githubEnvironmentEvidenceSha256: githubEnvironment.stableSha256,
        githubEnvironmentSnapshotSha256: githubEnvironment.snapshotSha256,
        githubEnvironmentValidatedAt: githubEnvironment.validatedAt,
        promotionControlPlaneEvidenceSha256: promotionControlPlane.stableSha256,
        promotionControlPlaneSnapshotSha256: promotionControlPlane.snapshotSha256,
        promotionControlPlaneValidatedAt: promotionControlPlane.validatedAt,
        now,
      },
    });
    const output = resolve(requiredEnvironment('AEO_PRODUCTION_FINALIZATION_EVIDENCE_OUTPUT'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    if (typeof process.env.GITHUB_OUTPUT === 'string' && process.env.GITHUB_OUTPUT.length > 0) {
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `evidence_sha256=${result.evidenceSha256}\n`,
        'utf8',
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        outcome: result.outcome,
        releaseId: result.releaseId,
        evidenceSha256: result.evidenceSha256,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'PRODUCTION_FINALIZATION_EVIDENCE_INVALID'}\n`,
    );
    process.exitCode = 1;
  }
}
