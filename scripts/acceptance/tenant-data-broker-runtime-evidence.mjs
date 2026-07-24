const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export function validateTenantDataBrokerRuntimeEvidence(value, expected, errorCode) {
  const runtime = object(value, errorCode);
  if (
    !sameKeys(runtime, [
      'accountId',
      'adotImage',
      'adotRuntimeDigest',
      'desiredCount',
      'environment',
      'healthyTargetCount',
      'pendingCount',
      'region',
      'releaseId',
      'runningCount',
      'runtimePlatform',
      'schemaVersion',
      'taskDefinitionArn',
      'tasks',
      'workerImage',
    ]) ||
    runtime.schemaVersion !== 'aeostudio.tenant-data-broker-runtime.v1' ||
    runtime.environment !== expected.environment ||
    runtime.region !== expected.region ||
    runtime.accountId !== expected.accountId ||
    runtime.releaseId !== expected.releaseId ||
    runtime.taskDefinitionArn !== expected.taskDefinitionArn ||
    runtime.workerImage !== expected.workerImage ||
    runtime.adotImage !== expected.adotImage ||
    !Number.isInteger(runtime.desiredCount) ||
    runtime.desiredCount < 2 ||
    runtime.runningCount !== runtime.desiredCount ||
    runtime.pendingCount !== 0 ||
    runtime.healthyTargetCount !== runtime.desiredCount ||
    !DIGEST.test(runtime.adotRuntimeDigest ?? '')
  ) {
    throw new Error(errorCode);
  }
  const platform = object(runtime.runtimePlatform, errorCode);
  if (
    !sameKeys(platform, ['cpuArchitecture', 'operatingSystemFamily']) ||
    platform.cpuArchitecture !== 'X86_64' ||
    platform.operatingSystemFamily !== 'LINUX'
  ) {
    throw new Error(errorCode);
  }
  if (!Array.isArray(runtime.tasks) || runtime.tasks.length !== runtime.desiredCount) {
    throw new Error(errorCode);
  }
  const taskArns = [];
  for (const taskValue of runtime.tasks) {
    const task = object(taskValue, errorCode);
    if (
      !sameKeys(task, ['adotRuntimeDigest', 'brokerRuntimeDigest', 'taskArn']) ||
      typeof task.taskArn !== 'string' ||
      !new RegExp(
        `^arn:aws:ecs:${expected.region}:${expected.accountId}:task/aeostudio-${expected.environment}/[0-9a-f]{32}$`,
        'u',
      ).test(task.taskArn) ||
      task.brokerRuntimeDigest !== expected.workerDigest ||
      task.adotRuntimeDigest !== runtime.adotRuntimeDigest
    ) {
      throw new Error(errorCode);
    }
    taskArns.push(task.taskArn);
  }
  if (
    new Set(taskArns).size !== runtime.desiredCount ||
    taskArns.some((taskArn, index) => taskArn !== [...taskArns].sort()[index])
  ) {
    throw new Error(errorCode);
  }
  return runtime;
}

function sameKeys(value, expected) {
  return Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
}

function object(value, errorCode) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  return value;
}
