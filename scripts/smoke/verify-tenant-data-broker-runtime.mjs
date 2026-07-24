import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const allowedOptions = new Set([
  'contract',
  'environment',
  'expected-account-id',
  'manifest',
  'output',
  'region',
]);
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function fail(code) {
  throw new Error(code);
}

function parseOptions(argv) {
  const options = new Map();
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith('--') ||
      value.startsWith('--')
    ) {
      fail('BROKER_RUNTIME_ARGUMENTS_INVALID');
    }
    const name = flag.slice(2);
    if (!allowedOptions.has(name) || options.has(name)) {
      fail('BROKER_RUNTIME_ARGUMENTS_INVALID');
    }
    options.set(name, value);
  }
  if (options.size !== allowedOptions.size) {
    fail('BROKER_RUNTIME_ARGUMENTS_INVALID');
  }
  return options;
}

function option(options, name) {
  const value = options.get(name);
  if (typeof value !== 'string' || value.length === 0) {
    fail('BROKER_RUNTIME_ARGUMENTS_INVALID');
  }
  return value;
}

function jsonFile(path, code) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(code);
  }
}

function awsJson(region, args) {
  const result = spawnSync(
    'aws',
    ['--region', region, '--no-cli-pager', ...args, '--output', 'json'],
    {
      encoding: 'utf8',
      env: { ...process.env, AWS_PAGER: '' },
      maxBuffer: 8 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    fail(`BROKER_RUNTIME_AWS_FAILED:${args[0] ?? 'unknown'}:${args[1] ?? 'unknown'}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail('BROKER_RUNTIME_AWS_RESPONSE_INVALID');
  }
}

function exactContainerMap(containers) {
  if (
    !Array.isArray(containers) ||
    containers.some(
      (container) => typeof container?.name !== 'string' || typeof container?.image !== 'string',
    )
  ) {
    fail('BROKER_RUNTIME_TASK_DEFINITION_INVALID');
  }
  const map = new Map(containers.map((container) => [container.name, container]));
  if (
    map.size !== 2 ||
    !map.has('tenant-data-broker') ||
    !map.has('adot') ||
    containers.length !== 2
  ) {
    fail('BROKER_RUNTIME_TASK_DEFINITION_INVALID');
  }
  return map;
}

function requireExactRuntimeTask(task, expected) {
  if (
    typeof task?.taskArn !== 'string' ||
    task?.taskDefinitionArn !== expected.taskDefinitionArn ||
    task?.lastStatus !== 'RUNNING' ||
    task?.desiredStatus !== 'RUNNING'
  ) {
    fail('BROKER_RUNTIME_TASK_INVALID');
  }
  const containers = exactContainerMap(task.containers);
  const broker = containers.get('tenant-data-broker');
  const adot = containers.get('adot');
  if (
    broker.image !== expected.workerImage ||
    broker.imageDigest !== expected.workerDigest ||
    broker.lastStatus !== 'RUNNING' ||
    adot.image !== expected.adotImage ||
    !digestPattern.test(adot.imageDigest) ||
    !expected.adotAmd64Digests.has(adot.imageDigest) ||
    adot.lastStatus !== 'RUNNING'
  ) {
    fail('BROKER_RUNTIME_IMAGE_MISMATCH');
  }
  return {
    taskArn: task.taskArn,
    brokerRuntimeDigest: broker.imageDigest,
    adotRuntimeDigest: adot.imageDigest,
  };
}

export function verifyTenantDataBrokerRuntime({
  accountId,
  contractEnvelope,
  environment,
  manifest,
  region,
  runAws,
}) {
  if (
    !/^(?:staging|production)$/u.test(environment) ||
    region !== 'ap-southeast-1' ||
    !/^[0-9]{12}$/u.test(accountId) ||
    typeof runAws !== 'function'
  ) {
    fail('BROKER_RUNTIME_ARGUMENTS_INVALID');
  }

  const contract = contractEnvelope?.contract;
  const worker = manifest?.images?.worker;
  const adot = manifest?.images?.adot;
  const expectedWorkerImage = `${accountId}.dkr.ecr.${region}.amazonaws.com/aeostudio-worker`;
  const expectedAdotImage = `${accountId}.dkr.ecr.${region}.amazonaws.com/aeostudio-adot`;
  const workerReference = `${expectedWorkerImage}@${worker?.digest ?? ''}`;
  const adotReference = `${expectedAdotImage}@${adot?.digest ?? ''}`;
  const expectedTaskDefinition = contract?.TaskDefinitions?.TenantDataBroker;
  if (
    manifest?.schemaVersion !== 'aeostudio.release.v1' ||
    worker?.image !== expectedWorkerImage ||
    adot?.image !== expectedAdotImage ||
    !digestPattern.test(worker?.digest) ||
    !digestPattern.test(adot?.digest) ||
    contract?.Environment !== environment ||
    contract?.Region !== region ||
    contract?.AccountId !== accountId ||
    contract?.Images?.Worker !== workerReference ||
    contract?.Images?.TenantDataBroker !== workerReference ||
    contract?.Images?.Adot !== adotReference ||
    typeof expectedTaskDefinition !== 'string'
  ) {
    fail('BROKER_RUNTIME_CONTRACT_INVALID');
  }

  const cluster = `aeostudio-${environment}`;
  const serviceName = `${cluster}-tenant-data-broker`;
  const serviceResponse = runAws(region, [
    'ecs',
    'describe-services',
    '--cluster',
    cluster,
    '--services',
    serviceName,
  ]);
  const service = serviceResponse.services?.[0];
  const deployments = service?.deployments;
  const targetGroupArn = service?.loadBalancers?.[0]?.targetGroupArn;
  if (
    !Array.isArray(serviceResponse.failures) ||
    serviceResponse.failures.length !== 0 ||
    !Array.isArray(serviceResponse.services) ||
    serviceResponse.services.length !== 1 ||
    service?.serviceName !== serviceName ||
    service?.taskDefinition !== expectedTaskDefinition ||
    !Number.isInteger(service?.desiredCount) ||
    service.desiredCount < 2 ||
    service.runningCount !== service.desiredCount ||
    service.pendingCount !== 0 ||
    !Array.isArray(deployments) ||
    deployments.length !== 1 ||
    deployments[0]?.status !== 'PRIMARY' ||
    deployments[0]?.rolloutState !== 'COMPLETED' ||
    !new RegExp(
      `^arn:aws:elasticloadbalancing:${region}:${accountId}:targetgroup/aeostudio-${environment}-broker/[0-9a-f]+$`,
      'u',
    ).test(targetGroupArn)
  ) {
    fail('BROKER_RUNTIME_SERVICE_UNHEALTHY');
  }

  const definitionResponse = runAws(region, [
    'ecs',
    'describe-task-definition',
    '--task-definition',
    expectedTaskDefinition,
  ]);
  const definition = definitionResponse.taskDefinition;
  const definitionContainers = exactContainerMap(definition?.containerDefinitions);
  if (
    definition?.taskDefinitionArn !== expectedTaskDefinition ||
    definition?.family !== serviceName ||
    definition?.runtimePlatform?.cpuArchitecture !== 'X86_64' ||
    definition?.runtimePlatform?.operatingSystemFamily !== 'LINUX' ||
    definitionContainers.get('tenant-data-broker').image !== workerReference ||
    definitionContainers.get('adot').image !== adotReference
  ) {
    fail('BROKER_RUNTIME_TASK_DEFINITION_INVALID');
  }

  const adotManifestResponse = runAws(region, [
    'ecr',
    'batch-get-image',
    '--repository-name',
    'aeostudio-adot',
    '--image-ids',
    `imageDigest=${adot.digest}`,
    '--accepted-media-types',
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
  ]);
  let adotIndex;
  try {
    adotIndex = JSON.parse(adotManifestResponse.images?.[0]?.imageManifest);
  } catch {
    fail('BROKER_RUNTIME_ADOT_INDEX_INVALID');
  }
  const adotAmd64Digests = new Set(
    Array.isArray(adotIndex?.manifests)
      ? adotIndex.manifests
          .filter(
            (entry) => entry?.platform?.os === 'linux' && entry?.platform?.architecture === 'amd64',
          )
          .map((entry) => entry.digest)
      : [],
  );
  if (
    adotManifestResponse.images?.length !== 1 ||
    adotManifestResponse.images[0]?.imageId?.imageDigest !== adot.digest ||
    (Array.isArray(adotManifestResponse.failures) && adotManifestResponse.failures.length !== 0) ||
    adotAmd64Digests.size !== 1
  ) {
    fail('BROKER_RUNTIME_ADOT_INDEX_INVALID');
  }

  const listResponse = runAws(region, [
    'ecs',
    'list-tasks',
    '--cluster',
    cluster,
    '--service-name',
    serviceName,
    '--desired-status',
    'RUNNING',
  ]);
  const taskArns = listResponse.taskArns;
  if (
    !Array.isArray(taskArns) ||
    taskArns.length !== service.desiredCount ||
    new Set(taskArns).size !== taskArns.length
  ) {
    fail('BROKER_RUNTIME_TASK_COUNT_INVALID');
  }
  const taskResponse = runAws(region, [
    'ecs',
    'describe-tasks',
    '--cluster',
    cluster,
    '--tasks',
    ...taskArns,
  ]);
  if (
    !Array.isArray(taskResponse.failures) ||
    taskResponse.failures.length !== 0 ||
    !Array.isArray(taskResponse.tasks) ||
    taskResponse.tasks.length !== taskArns.length
  ) {
    fail('BROKER_RUNTIME_TASK_INVALID');
  }
  const describedTaskArns = taskResponse.tasks.map((task) => task?.taskArn);
  if (
    describedTaskArns.some((taskArn) => typeof taskArn !== 'string') ||
    new Set(describedTaskArns).size !== describedTaskArns.length ||
    [...describedTaskArns].sort().join('\n') !== [...taskArns].sort().join('\n')
  ) {
    fail('BROKER_RUNTIME_TASK_INVALID');
  }
  const runtimeTasks = taskResponse.tasks
    .map((task) =>
      requireExactRuntimeTask(task, {
        adotAmd64Digests,
        adotImage: adotReference,
        taskDefinitionArn: expectedTaskDefinition,
        workerDigest: worker.digest,
        workerImage: workerReference,
      }),
    )
    .sort((left, right) => left.taskArn.localeCompare(right.taskArn));
  const runtimeAdotDigests = new Set(runtimeTasks.map((task) => task.adotRuntimeDigest));
  if (runtimeAdotDigests.size !== 1) {
    fail('BROKER_RUNTIME_IMAGE_MISMATCH');
  }

  const targetResponse = runAws(region, [
    'elbv2',
    'describe-target-health',
    '--target-group-arn',
    targetGroupArn,
  ]);
  const targetDescriptions = targetResponse.TargetHealthDescriptions;
  if (
    !Array.isArray(targetDescriptions) ||
    targetDescriptions.length !== service.desiredCount ||
    targetDescriptions.some((target) => target?.TargetHealth?.State !== 'healthy')
  ) {
    fail('BROKER_RUNTIME_TARGET_UNHEALTHY');
  }

  const evidence = {
    schemaVersion: 'aeostudio.tenant-data-broker-runtime.v1',
    environment,
    region,
    accountId,
    releaseId: contract.ReleaseId,
    taskDefinitionArn: expectedTaskDefinition,
    desiredCount: service.desiredCount,
    runningCount: service.runningCount,
    pendingCount: service.pendingCount,
    healthyTargetCount: targetDescriptions.length,
    workerImage: workerReference,
    adotImage: adotReference,
    adotRuntimeDigest: [...runtimeAdotDigests][0],
    tasks: runtimeTasks,
    runtimePlatform: {
      cpuArchitecture: 'X86_64',
      operatingSystemFamily: 'LINUX',
    },
  };
  return evidence;
}

function main() {
  const options = parseOptions(process.argv);
  const evidence = verifyTenantDataBrokerRuntime({
    accountId: option(options, 'expected-account-id'),
    contractEnvelope: jsonFile(option(options, 'contract'), 'BROKER_RUNTIME_CONTRACT_INVALID'),
    environment: option(options, 'environment'),
    manifest: jsonFile(option(options, 'manifest'), 'BROKER_RUNTIME_MANIFEST_INVALID'),
    region: option(options, 'region'),
    runAws: awsJson,
  });
  writeFileSync(option(options, 'output'), `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  process.stdout.write('TENANT_DATA_BROKER_RUNTIME_VERIFIED\n');
}

const entrypoint =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (entrypoint) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'BROKER_RUNTIME_VERIFICATION_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
