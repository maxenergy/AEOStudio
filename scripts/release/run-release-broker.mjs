import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const allowedOptions = new Set([
  'environment',
  'deploy-execution-name',
  'execution-name',
  'expected-account-id',
  'finalize-execution-name',
  'github-environment-evidence-sha256',
  'manifest',
  'mode',
  'output-contract',
  'production-finalization-evidence-sha256',
  'promotion-control-plane-evidence-sha256',
  'region',
  'release-id',
  'repository',
]);
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const sourcePattern = /^[0-9a-f]{40}$/u;
const terminalStatuses = new Set(['ABORTED', 'FAILED', 'SUCCEEDED', 'TIMED_OUT']);
export const awsCommandTimeoutMilliseconds = 30_000;
export const maximumReleaseIdLength = 70;
export const releaseExecutionWaitTimeoutMilliseconds = 4_260_000;
export const cleanupRecoveryWaitBudgetMilliseconds = 2 * releaseExecutionWaitTimeoutMilliseconds;
const finalizationEvidenceNames = [
  'ProductionFinalizationEvidenceSha256',
  'GitHubEnvironmentEvidenceSha256',
  'PromotionControlPlaneEvidenceSha256',
];

function fail(code) {
  throw new Error(code);
}

export function parseOptions(argv) {
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
      fail('RELEASE_ARGUMENTS_INVALID');
    }
    const name = flag.slice(2);
    if (!allowedOptions.has(name) || options.has(name)) {
      fail('RELEASE_ARGUMENTS_INVALID');
    }
    options.set(name, value);
  }
  return options;
}

function option(options, name) {
  const value = options.get(name);
  if (value === undefined || value.length === 0) {
    fail('RELEASE_ARGUMENTS_INVALID');
  }
  return value;
}

function requireAwsCommandTimeout(timeoutMilliseconds) {
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0 ||
    timeoutMilliseconds > awsCommandTimeoutMilliseconds
  ) {
    fail('AWS_COMMAND_TIMEOUT_INVALID');
  }
  return timeoutMilliseconds;
}

function aws(region, args, timeoutMilliseconds = awsCommandTimeoutMilliseconds) {
  const result = spawnSync('aws', ['--region', region, '--no-cli-pager', ...args], {
    encoding: 'utf8',
    env: { ...process.env, AWS_PAGER: '' },
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    timeout: requireAwsCommandTimeout(timeoutMilliseconds),
    windowsHide: true,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    fail(`AWS_COMMAND_TIMEOUT:${args[0] ?? 'unknown'}:${args[1] ?? 'unknown'}`);
  }
  if (result.status !== 0) {
    fail(`AWS_COMMAND_FAILED:${args[0] ?? 'unknown'}:${args[1] ?? 'unknown'}`);
  }
  return result.stdout;
}

function awsJson(region, args, timeoutMilliseconds = awsCommandTimeoutMilliseconds) {
  try {
    return JSON.parse(aws(region, [...args, '--output', 'json'], timeoutMilliseconds));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('AWS_COMMAND_')) {
      throw error;
    }
    fail('AWS_RESPONSE_INVALID');
  }
}

function describeExecutionIfExists(
  region,
  targetExecutionArn,
  timeoutMilliseconds = awsCommandTimeoutMilliseconds,
) {
  const result = spawnSync(
    'aws',
    [
      '--region',
      region,
      '--no-cli-pager',
      'stepfunctions',
      'describe-execution',
      '--execution-arn',
      targetExecutionArn,
      '--output',
      'json',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, AWS_PAGER: '' },
      maxBuffer: 8 * 1024 * 1024,
      shell: false,
      timeout: requireAwsCommandTimeout(timeoutMilliseconds),
      windowsHide: true,
    },
  );
  if (result.error?.code === 'ETIMEDOUT') {
    fail('AWS_COMMAND_TIMEOUT:stepfunctions:describe-execution');
  }
  if (result.status !== 0) {
    if (String(result.stderr ?? '').includes('ExecutionDoesNotExist')) {
      return undefined;
    }
    fail('AWS_COMMAND_FAILED:stepfunctions:describe-execution');
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail('AWS_RESPONSE_INVALID');
  }
}

function jsonFile(path, code) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(code);
  }
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\n') === [...expected].sort().join('\n')
  );
}

function assertNoDuplicateJsonKeys(raw) {
  let index = 0;
  const whitespace = /\s/u;
  const skipWhitespace = () => {
    while (index < raw.length && whitespace.test(raw[index])) index += 1;
  };
  const readString = () => {
    const start = index;
    index += 1;
    while (index < raw.length) {
      if (raw[index] === '\\') {
        index += 2;
      } else if (raw[index] === '"') {
        index += 1;
        return JSON.parse(raw.slice(start, index));
      } else {
        index += 1;
      }
    }
    throw new Error('JSON_STRING_UNTERMINATED');
  };
  const visitValue = () => {
    skipWhitespace();
    if (raw[index] === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (raw[index] === '}') {
        index += 1;
        return;
      }
      while (index < raw.length) {
        skipWhitespace();
        const key = readString();
        if (keys.has(key)) throw new Error('JSON_DUPLICATE_KEY');
        keys.add(key);
        skipWhitespace();
        index += 1;
        visitValue();
        skipWhitespace();
        if (raw[index] === '}') {
          index += 1;
          return;
        }
        index += 1;
      }
      return;
    }
    if (raw[index] === '[') {
      index += 1;
      skipWhitespace();
      if (raw[index] === ']') {
        index += 1;
        return;
      }
      while (index < raw.length) {
        visitValue();
        skipWhitespace();
        if (raw[index] === ']') {
          index += 1;
          return;
        }
        index += 1;
      }
      return;
    }
    if (raw[index] === '"') {
      readString();
      return;
    }
    while (
      index < raw.length &&
      raw[index] !== ',' &&
      raw[index] !== ']' &&
      raw[index] !== '}' &&
      !whitespace.test(raw[index])
    ) {
      index += 1;
    }
  };
  visitValue();
  skipWhitespace();
  if (index !== raw.length) throw new Error('JSON_TRAILING_DATA');
}

function exactJsonValue(observed, expected) {
  if (Array.isArray(observed) || Array.isArray(expected)) {
    return (
      Array.isArray(observed) &&
      Array.isArray(expected) &&
      observed.length === expected.length &&
      observed.every((value, index) => exactJsonValue(value, expected[index]))
    );
  }
  if (
    observed !== null &&
    expected !== null &&
    typeof observed === 'object' &&
    typeof expected === 'object'
  ) {
    const observedKeys = Object.keys(observed).sort();
    const expectedKeys = Object.keys(expected).sort();
    return (
      observedKeys.join('\n') === expectedKeys.join('\n') &&
      observedKeys.every((key) => exactJsonValue(observed[key], expected[key]))
    );
  }
  return observed === expected;
}

export function strictJsonObjectEquals(observed, expected) {
  if (
    typeof observed !== 'string' ||
    expected === null ||
    typeof expected !== 'object' ||
    Array.isArray(expected)
  ) {
    return false;
  }
  try {
    const parsed = JSON.parse(observed);
    assertNoDuplicateJsonKeys(observed);
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      exactJsonValue(parsed, expected)
    );
  } catch {
    return false;
  }
}

function integer(value) {
  return typeof value === 'string' && /^[1-9][0-9]*$/u.test(value) ? Number(value) : Number.NaN;
}

export function validateCommon(options) {
  const mode = option(options, 'mode');
  const environment = option(options, 'environment');
  const region = option(options, 'region');
  const accountId = option(options, 'expected-account-id');
  const executionName = option(options, 'execution-name');
  if (
    !['DEPLOY_START', 'DEPLOY_WAIT', 'FINALIZE', 'ROLLBACK', 'RECOVER', 'CLEANUP'].includes(mode) ||
    !/^(?:staging|production)$/u.test(environment) ||
    region !== 'ap-southeast-1' ||
    !/^[0-9]{12}$/u.test(accountId) ||
    !/^[A-Za-z0-9_-]{1,80}$/u.test(executionName)
  ) {
    fail('RELEASE_ARGUMENTS_INVALID');
  }
  let required;
  if (mode === 'DEPLOY_START') {
    required = ['manifest', 'release-id', 'repository'];
  } else if (mode === 'DEPLOY_WAIT') {
    required = ['manifest', 'output-contract', 'release-id', 'repository'];
  } else if (mode === 'RECOVER') {
    required =
      environment === 'production'
        ? [
            'release-id',
            'production-finalization-evidence-sha256',
            'github-environment-evidence-sha256',
            'promotion-control-plane-evidence-sha256',
          ]
        : ['release-id'];
  } else if (mode === 'CLEANUP') {
    required = ['deploy-execution-name', 'release-id'];
  } else if (mode === 'FINALIZE' && environment === 'production') {
    required = [
      'release-id',
      'production-finalization-evidence-sha256',
      'github-environment-evidence-sha256',
      'promotion-control-plane-evidence-sha256',
    ];
  } else {
    required = ['release-id'];
  }
  for (const name of required) {
    option(options, name);
  }
  const releaseId = option(options, 'release-id');
  if (
    !new RegExp(`^[A-Za-z0-9_-]{1,${maximumReleaseIdLength}}$`, 'u').test(releaseId) ||
    (['DEPLOY_START', 'DEPLOY_WAIT'].includes(mode) && executionName !== releaseId) ||
    (['RECOVER', 'CLEANUP'].includes(mode) && executionName !== `reconcile-${releaseId}`) ||
    (mode === 'CLEANUP' && option(options, 'deploy-execution-name') !== releaseId)
  ) {
    fail('RELEASE_ARGUMENTS_INVALID');
  }
  const permitted = new Set([
    'mode',
    'environment',
    'region',
    'expected-account-id',
    'execution-name',
    ...required,
    ...(mode === 'CLEANUP' && environment === 'production'
      ? [
          'finalize-execution-name',
          'production-finalization-evidence-sha256',
          'github-environment-evidence-sha256',
          'promotion-control-plane-evidence-sha256',
        ]
      : []),
  ]);
  if ([...options.keys()].some((name) => !permitted.has(name))) {
    fail('RELEASE_ARGUMENTS_INVALID');
  }
  if (environment === 'production') {
    const authorizationNames = [
      'finalize-execution-name',
      'production-finalization-evidence-sha256',
      'github-environment-evidence-sha256',
      'promotion-control-plane-evidence-sha256',
    ];
    const suppliedAuthorizationNames = authorizationNames.filter((name) => options.has(name));
    if (
      mode === 'CLEANUP' &&
      suppliedAuthorizationNames.length !== 0 &&
      suppliedAuthorizationNames.length !== authorizationNames.length
    ) {
      fail('RELEASE_FINALIZATION_EVIDENCE_INVALID');
    }
    const hashNames = authorizationNames.filter((name) => name.endsWith('-sha256'));
    if (
      (['FINALIZE', 'RECOVER'].includes(mode) ||
        (mode === 'CLEANUP' && suppliedAuthorizationNames.length > 0)) &&
      hashNames.some((name) => !sha256Pattern.test(option(options, name)))
    ) {
      fail('RELEASE_FINALIZATION_EVIDENCE_INVALID');
    }
  }
  return { accountId, environment, executionName, mode, region };
}

function readPointer(region, accountId, environment) {
  const parameterName = `/aeostudio/${environment}/release-contract`;
  const response = awsJson(region, ['ssm', 'get-parameter', '--name', parameterName]);
  let pointer;
  try {
    pointer = JSON.parse(response.Parameter.Value);
  } catch {
    fail('RELEASE_POINTER_INVALID');
  }
  const expectedBroker = `arn:aws:states:${region}:${accountId}:stateMachine:aeostudio-${environment}-release`;
  const terminalKeys = ['SchemaVersion', 'Status', 'BrokerArn', 'ReleaseId', 'ContractName'];
  if (
    pointer?.SchemaVersion !== 'aeostudio.release-pointer.v1' ||
    pointer?.BrokerArn !== expectedBroker ||
    !['UNINITIALIZED', 'AWAITING_SMOKE', 'DEPLOYED', 'ROLLED_BACK'].includes(pointer?.Status)
  ) {
    fail('RELEASE_POINTER_INVALID');
  }
  if (pointer.Status === 'UNINITIALIZED') {
    if (!exactKeys(pointer, ['SchemaVersion', 'Status', 'BrokerArn'])) {
      fail('RELEASE_POINTER_INVALID');
    }
  } else {
    const productionFinalized = environment === 'production' && pointer.Status === 'DEPLOYED';
    if (
      !exactKeys(
        pointer,
        productionFinalized ? [...terminalKeys, 'FinalizationEvidence'] : terminalKeys,
      ) ||
      typeof pointer.ReleaseId !== 'string' ||
      pointer.ReleaseId.length === 0 ||
      pointer.ContractName !== `/aeostudio/${environment}/releases/${pointer.ReleaseId}`
    ) {
      fail('RELEASE_POINTER_INVALID');
    }
    if (productionFinalized) {
      const names = [
        'ProductionFinalizationEvidenceSha256',
        'GitHubEnvironmentEvidenceSha256',
        'PromotionControlPlaneEvidenceSha256',
      ];
      if (
        !exactKeys(pointer.FinalizationEvidence, names) ||
        names.some((name) => !sha256Pattern.test(pointer.FinalizationEvidence[name]))
      ) {
        fail('RELEASE_POINTER_INVALID');
      }
    }
  }
  return { brokerArn: expectedBroker, pointer };
}

function readCoordination(region, environment) {
  const response = awsJson(region, [
    'dynamodb',
    'get-item',
    '--table-name',
    `aeostudio-${environment}-release-control`,
    '--key',
    JSON.stringify({ CoordinationKey: { S: 'ENVIRONMENT' } }),
    '--consistent-read',
  ]);
  if (response.Item === undefined) {
    return {};
  }
  if (response.Item === null || typeof response.Item !== 'object' || Array.isArray(response.Item)) {
    fail('RELEASE_COORDINATION_INVALID');
  }
  return response.Item;
}

function stringAttribute(item, name) {
  if (!Object.hasOwn(item, name)) {
    return undefined;
  }
  const value = item[name];
  if (!exactKeys(value, ['S']) || typeof value.S !== 'string' || value.S.length === 0) {
    fail('RELEASE_COORDINATION_INVALID');
  }
  return value.S;
}

function numberAttribute(item, name) {
  if (!Object.hasOwn(item, name)) {
    return undefined;
  }
  const value = item[name];
  if (!exactKeys(value, ['N']) || typeof value.N !== 'string' || !/^[1-9][0-9]*$/u.test(value.N)) {
    fail('RELEASE_COORDINATION_INVALID');
  }
  return value.N;
}

function exactReleaseOwner(item, expected) {
  return (
    numberAttribute(item, 'Generation') !== undefined &&
    stringAttribute(item, 'LockOwner') === expected.deployArn &&
    stringAttribute(item, 'ReleaseId') === expected.releaseId &&
    stringAttribute(item, 'ContractName') === expected.contractName
  );
}

function exactCoordinationOwner(item, expected) {
  return exactReleaseOwner(item, expected) && stringAttribute(item, 'Phase') === 'CONTRACT_READY';
}

function requireAwaitingSmokeCoordination(item, expected) {
  if (
    !exactCoordinationOwner(item, expected) ||
    stringAttribute(item, 'PointerStatus') !== 'AWAITING_SMOKE' ||
    stringAttribute(item, 'PointerReleaseId') !== expected.releaseId ||
    stringAttribute(item, 'PointerContractName') !== expected.contractName ||
    stringAttribute(item, 'ClaimOwner') !== undefined
  ) {
    fail('RELEASE_COORDINATION_NOT_AWAITING_SMOKE');
  }
  requireNoFinalizationEvidence(item);
}

export function requireTerminalCoordination(item, expected, allowedStatuses) {
  const lockOwner = stringAttribute(item, 'LockOwner');
  const status = stringAttribute(item, 'PointerStatus');
  if (
    numberAttribute(item, 'Generation') === undefined ||
    lockOwner !== undefined ||
    stringAttribute(item, 'ClaimOwner') !== undefined ||
    stringAttribute(item, 'Phase') !== undefined ||
    !allowedStatuses.includes(status) ||
    stringAttribute(item, 'PointerReleaseId') !== expected.releaseId ||
    stringAttribute(item, 'PointerContractName') !== expected.contractName
  ) {
    fail('RELEASE_COORDINATION_NOT_TERMINAL');
  }
  return status;
}

function requireNoFinalizationEvidence(item) {
  if (finalizationEvidenceNames.some((name) => Object.hasOwn(item, name))) {
    fail('RELEASE_FINALIZATION_EVIDENCE_MISMATCH');
  }
}

export function requireFinalizedReleaseState(pointer, item, expected, environment) {
  if (
    pointer.Status !== 'DEPLOYED' ||
    pointer.ReleaseId !== expected.releaseId ||
    pointer.ContractName !== expected.contractName
  ) {
    fail('RELEASE_POINTER_NOT_FINALIZED');
  }
  requireTerminalCoordination(item, expected, ['DEPLOYED']);
  if (environment === 'production') {
    if (
      !exactKeys(pointer.FinalizationEvidence, finalizationEvidenceNames) ||
      !exactKeys(expected.finalizationEvidence, finalizationEvidenceNames) ||
      finalizationEvidenceNames.some(
        (name) =>
          !sha256Pattern.test(expected.finalizationEvidence[name]) ||
          pointer.FinalizationEvidence[name] !== expected.finalizationEvidence[name] ||
          stringAttribute(item, name) !== expected.finalizationEvidence[name],
      )
    ) {
      fail('RELEASE_FINALIZATION_EVIDENCE_MISMATCH');
    }
    return {
      status: 'DEPLOYED',
      finalizationEvidence: Object.fromEntries(
        finalizationEvidenceNames.map((name) => [name, expected.finalizationEvidence[name]]),
      ),
    };
  } else {
    requireNoFinalizationEvidence(item);
  }
  return { status: 'DEPLOYED' };
}

function requireExactTerminalReleaseState(item, expected, allowedStatuses, common) {
  const status = requireTerminalCoordination(item, expected, allowedStatuses);
  if (status !== 'PREPARATION_ABORTED') {
    const pointer = readPointer(common.region, common.accountId, common.environment).pointer;
    if (
      pointer.Status !== status ||
      pointer.ReleaseId !== expected.releaseId ||
      pointer.ContractName !== expected.contractName
    ) {
      fail('RELEASE_POINTER_NOT_TERMINAL');
    }
    if (status !== 'DEPLOYED') {
      requireNoFinalizationEvidence(item);
      return { status };
    }
    return requireFinalizedReleaseState(pointer, item, expected, common.environment);
  }
  requireNoFinalizationEvidence(item);
  return { status };
}

function releaseIsNotOwned(item, releaseId) {
  return (
    numberAttribute(item, 'Generation') !== undefined &&
    stringAttribute(item, 'LockOwner') === undefined &&
    stringAttribute(item, 'ClaimOwner') === undefined &&
    stringAttribute(item, 'PointerReleaseId') !== releaseId
  );
}

function exactExecutionIdentity(execution, expected) {
  return (
    execution?.executionArn === expected.executionArn &&
    execution?.stateMachineArn === expected.stateMachineArn &&
    execution?.name === expected.name &&
    (expected.input === undefined || strictJsonObjectEquals(execution.input, expected.input))
  );
}

export function refreshExactDeployExecutionAfterWatchdog(
  common,
  brokerArn,
  deployName,
  deployArn,
  describeExecution = describeExecutionIfExists,
) {
  const execution = describeExecution(common.region, deployArn);
  if (
    execution === undefined ||
    !exactExecutionIdentity(execution, {
      executionArn: deployArn,
      name: deployName,
      stateMachineArn: brokerArn,
    })
  ) {
    fail('CLEANUP_DEPLOY_EXECUTION_MISMATCH');
  }
  return execution;
}

function validateManifest(manifest, expected) {
  if (
    !exactKeys(manifest, [
      'schemaVersion',
      'sourceSha',
      'sourceRef',
      'repository',
      'buildRunId',
      'buildRunAttempt',
      'images',
    ]) ||
    manifest.schemaVersion !== 'aeostudio.release.v1' ||
    !sourcePattern.test(manifest.sourceSha) ||
    manifest.sourceRef !== 'refs/heads/main' ||
    manifest.repository !== expected.repository ||
    !exactKeys(manifest.images, ['adot', 'api', 'web', 'worker'])
  ) {
    fail('RELEASE_MANIFEST_INVALID');
  }
  const runId = integer(manifest.buildRunId);
  const runAttempt = integer(manifest.buildRunAttempt);
  if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(runAttempt)) {
    fail('RELEASE_MANIFEST_INVALID');
  }
  for (const service of ['adot', 'api', 'web', 'worker']) {
    const image = manifest.images[service];
    const expectedImage = `${expected.accountId}.dkr.ecr.${expected.region}.amazonaws.com/aeostudio-${service}`;
    if (
      !exactKeys(image, ['image', 'digest']) ||
      image.image !== expectedImage ||
      !digestPattern.test(image.digest)
    ) {
      fail('RELEASE_MANIFEST_INVALID');
    }
  }
  return { runAttempt, runId };
}

function verifyDigestExists(region, repository, digest) {
  const response = awsJson(region, [
    'ecr',
    'batch-get-image',
    '--repository-name',
    repository,
    '--image-ids',
    `imageDigest=${digest}`,
  ]);
  if (
    !Array.isArray(response.images) ||
    response.images.length !== 1 ||
    response.images[0]?.imageId?.imageDigest !== digest ||
    (Array.isArray(response.failures) && response.failures.length !== 0)
  ) {
    fail('RELEASE_DIGEST_NOT_FOUND');
  }
}

function startExecution(region, brokerArn, executionName, input) {
  const inputJson = JSON.stringify(input);
  const expectedArn = executionArn(brokerArn, executionName);
  const result = spawnSync(
    'aws',
    [
      '--region',
      region,
      '--no-cli-pager',
      'stepfunctions',
      'start-execution',
      '--state-machine-arn',
      brokerArn,
      '--name',
      executionName,
      '--input',
      inputJson,
      '--output',
      'json',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, AWS_PAGER: '' },
      maxBuffer: 8 * 1024 * 1024,
      shell: false,
      timeout: awsCommandTimeoutMilliseconds,
      windowsHide: true,
    },
  );
  if (result.status === 0) {
    let started;
    try {
      started = JSON.parse(result.stdout);
    } catch {
      fail('AWS_RESPONSE_INVALID');
    }
    if (started.executionArn !== expectedArn) {
      fail('RELEASE_EXECUTION_START_FAILED');
    }
    return expectedArn;
  }
  const observed = describeExecutionIfExists(region, expectedArn);
  if (
    observed?.executionArn !== expectedArn ||
    observed?.stateMachineArn !== brokerArn ||
    observed?.name !== executionName ||
    !strictJsonObjectEquals(observed?.input, input)
  ) {
    fail('RELEASE_EXECUTION_START_AMBIGUOUS');
  }
  if (['ABORTED', 'FAILED', 'TIMED_OUT'].includes(observed.status)) {
    fail(`RELEASE_EXECUTION_${observed.status}`);
  }
  return expectedArn;
}

function configuredProductionJobDeadline() {
  const raw = process.env.AEO_PRODUCTION_JOB_DEADLINE_EPOCH_MILLISECONDS;
  if (raw === undefined || raw === '') return Number.POSITIVE_INFINITY;
  if (!/^[1-9][0-9]*$/u.test(raw)) fail('RELEASE_EXECUTION_DEADLINE_INVALID');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail('RELEASE_EXECUTION_DEADLINE_INVALID');
  return value;
}

export async function waitForExecution(region, executionArn, adapters = {}) {
  const now = adapters.now ?? Date.now;
  const sleep = adapters.sleep ?? delay;
  const waitBudgetMilliseconds =
    adapters.waitBudgetMilliseconds ?? releaseExecutionWaitTimeoutMilliseconds;
  const describeExecution =
    adapters.describeExecution ??
    ((targetRegion, targetExecutionArn, timeoutMilliseconds) =>
      awsJson(
        targetRegion,
        ['stepfunctions', 'describe-execution', '--execution-arn', targetExecutionArn],
        timeoutMilliseconds,
      ));
  if (
    !Number.isSafeInteger(waitBudgetMilliseconds) ||
    waitBudgetMilliseconds <= 0 ||
    waitBudgetMilliseconds > releaseExecutionWaitTimeoutMilliseconds
  ) {
    fail('RELEASE_EXECUTION_WAIT_BUDGET_INVALID');
  }
  const startedAt = now();
  if (!Number.isSafeInteger(startedAt)) fail('RELEASE_EXECUTION_CLOCK_INVALID');
  const deadline = Math.min(
    startedAt + waitBudgetMilliseconds,
    adapters.deadlineEpochMilliseconds ?? configuredProductionJobDeadline(),
  );
  while (true) {
    const remainingBeforeCommand = deadline - now();
    if (remainingBeforeCommand <= 0) fail('RELEASE_EXECUTION_WAIT_TIMEOUT');
    const commandTimeoutMilliseconds = Math.min(
      awsCommandTimeoutMilliseconds,
      remainingBeforeCommand,
    );
    const execution = await describeExecution(region, executionArn, commandTimeoutMilliseconds);
    if (terminalStatuses.has(execution.status)) {
      return execution;
    }
    const remainingBeforeSleep = deadline - now();
    if (remainingBeforeSleep <= 0) fail('RELEASE_EXECUTION_WAIT_TIMEOUT');
    await sleep(Math.min(10_000, remainingBeforeSleep));
  }
}

function requireSucceeded(execution) {
  if (execution.status !== 'SUCCEEDED') {
    fail(`RELEASE_EXECUTION_${execution.status}`);
  }
  return execution;
}

function executionArn(brokerArn, executionName) {
  return `${brokerArn.replace(':stateMachine:', ':execution:')}:${executionName}`;
}

function readContract(region, contractName) {
  const response = awsJson(region, ['ssm', 'get-parameter', '--name', contractName]);
  try {
    return JSON.parse(response.Parameter.Value);
  } catch {
    fail('RELEASE_CONTRACT_INVALID');
  }
}

function taskDefinitionContainers(region, taskDefinitionArn) {
  const response = awsJson(region, [
    'ecs',
    'describe-task-definition',
    '--task-definition',
    taskDefinitionArn,
  ]);
  const containers = response.taskDefinition?.containerDefinitions;
  if (
    response.taskDefinition?.taskDefinitionArn !== taskDefinitionArn ||
    response.taskDefinition?.runtimePlatform?.cpuArchitecture !== 'X86_64' ||
    response.taskDefinition?.runtimePlatform?.operatingSystemFamily !== 'LINUX' ||
    !Array.isArray(containers) ||
    containers.some(
      (container) => typeof container?.name !== 'string' || typeof container?.image !== 'string',
    )
  ) {
    fail('RELEASE_TASK_DEFINITION_INVALID');
  }
  return new Map(containers.map((container) => [container.name, container.image]));
}

function validateContract(contract, expected) {
  const familyArn = (service) =>
    new RegExp(
      `^arn:aws:ecs:${expected.region}:${expected.accountId}:task-definition/aeostudio-${expected.environment}-${service}:[1-9][0-9]*$`,
      'u',
    );
  const expectedContractName = `/aeostudio/${expected.environment}/releases/${expected.releaseId}`;
  if (
    !exactKeys(contract, [
      'SchemaVersion',
      'Environment',
      'Region',
      'AccountId',
      'ReleaseId',
      'ContractName',
      'BrokerArn',
      'WatchdogArn',
      'Source',
      'Digests',
      'Images',
      'TaskDefinitions',
      'Rollback',
    ]) ||
    contract.SchemaVersion !== 'aeostudio.release-contract.v2' ||
    contract.Environment !== expected.environment ||
    contract.Region !== expected.region ||
    contract.AccountId !== expected.accountId ||
    contract.ReleaseId !== expected.releaseId ||
    contract.ContractName !== expectedContractName ||
    contract.BrokerArn !== expected.brokerArn ||
    contract.WatchdogArn !==
      `arn:aws:states:${expected.region}:${expected.accountId}:stateMachine:aeostudio-${expected.environment}-release-watchdog` ||
    contract.Source?.Sha !== expected.manifest.sourceSha ||
    contract.Source?.BuildRunId !== expected.runId ||
    contract.Source?.BuildRunAttempt !== expected.runAttempt
  ) {
    fail('RELEASE_CONTRACT_INVALID');
  }
  if (
    !exactKeys(contract.Digests, ['Adot', 'Api', 'Web', 'Worker']) ||
    !exactKeys(contract.Images, ['Adot', 'Api', 'TenantDataBroker', 'Web', 'Worker']) ||
    !exactKeys(contract.TaskDefinitions, [
      'Api',
      'Migration',
      'TenantDataBroker',
      'Web',
      'Worker',
    ]) ||
    !exactKeys(contract.Rollback, ['Api', 'TenantDataBroker', 'Web', 'Worker']) ||
    contract.Digests.Adot !== expected.manifest.images.adot.digest ||
    contract.Images.Adot !==
      `${expected.manifest.images.adot.image}@${expected.manifest.images.adot.digest}` ||
    contract.Images.TenantDataBroker !== contract.Images.Worker ||
    !familyArn('tenant-data-broker').test(contract.TaskDefinitions.TenantDataBroker) ||
    !familyArn('tenant-data-broker').test(contract.Rollback.TenantDataBroker)
  ) {
    fail('RELEASE_CONTRACT_INVALID');
  }
  for (const service of ['Api', 'Web', 'Worker']) {
    const lower = service.toLowerCase();
    if (
      contract.Digests?.[service] !== expected.manifest.images[lower].digest ||
      contract.Images?.[service] !==
        `${expected.manifest.images[lower].image}@${expected.manifest.images[lower].digest}` ||
      !familyArn(lower).test(contract.TaskDefinitions?.[service]) ||
      !familyArn(lower).test(contract.Rollback?.[service])
    ) {
      fail('RELEASE_CONTRACT_INVALID');
    }
  }
  if (!familyArn('migration').test(contract.TaskDefinitions?.Migration)) {
    fail('RELEASE_CONTRACT_INVALID');
  }
  const expectedImages = {
    Api: contract.Images.Api,
    Migration: contract.Images.Api,
    TenantDataBroker: contract.Images.Worker,
    Web: contract.Images.Web,
    Worker: contract.Images.Worker,
  };
  for (const [service, expectedImage] of Object.entries(expectedImages)) {
    const containers = taskDefinitionContainers(expected.region, contract.TaskDefinitions[service]);
    const mainContainer =
      service === 'TenantDataBroker' ? 'tenant-data-broker' : service.toLowerCase();
    const expectedContainerNames =
      service === 'Migration' ? ['migration'] : ['adot', mainContainer].sort();
    if (
      [...containers.keys()].sort().join('\n') !== expectedContainerNames.join('\n') ||
      containers.get(mainContainer) !== expectedImage ||
      (service !== 'Migration' && containers.get('adot') !== contract.Images.Adot)
    ) {
      fail('RELEASE_TASK_DEFINITION_IMAGE_MISMATCH');
    }
  }
  return contract;
}

function writeGithubOutput(values) {
  const output = process.env.GITHUB_OUTPUT;
  if (typeof output !== 'string' || output.length === 0) {
    return;
  }
  appendFileSync(
    output,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}

function finalizationEvidenceFromOptions(options) {
  return {
    ProductionFinalizationEvidenceSha256: option(
      options,
      'production-finalization-evidence-sha256',
    ),
    GitHubEnvironmentEvidenceSha256: option(options, 'github-environment-evidence-sha256'),
    PromotionControlPlaneEvidenceSha256: option(options, 'promotion-control-plane-evidence-sha256'),
  };
}

async function inspectExactProductionFinalizeExecution(
  common,
  brokerArn,
  releaseId,
  finalizeExecutionName,
  finalizationEvidence,
  required,
) {
  const expectedName = releaseId.replace(/^production-/u, 'production-finalize-');
  if (finalizeExecutionName !== expectedName) {
    fail('RELEASE_FINALIZE_EXECUTION_MISMATCH');
  }
  const finalizeExecutionArn = executionArn(brokerArn, finalizeExecutionName);
  let execution = describeExecutionIfExists(common.region, finalizeExecutionArn);
  if (execution === undefined && !required) {
    return undefined;
  }
  if (
    execution === undefined ||
    !exactExecutionIdentity(execution, {
      executionArn: finalizeExecutionArn,
      input: {
        Mode: 'FINALIZE',
        ReleaseId: releaseId,
        FinalizationEvidence: finalizationEvidence,
      },
      name: finalizeExecutionName,
      stateMachineArn: brokerArn,
    })
  ) {
    fail('RELEASE_FINALIZE_EXECUTION_MISMATCH');
  }
  if (!terminalStatuses.has(execution.status)) {
    execution = await waitForExecution(common.region, finalizeExecutionArn);
    if (
      !terminalStatuses.has(execution.status) ||
      !exactExecutionIdentity(execution, {
        executionArn: finalizeExecutionArn,
        input: {
          Mode: 'FINALIZE',
          ReleaseId: releaseId,
          FinalizationEvidence: finalizationEvidence,
        },
        name: finalizeExecutionName,
        stateMachineArn: brokerArn,
      })
    ) {
      fail('RELEASE_FINALIZE_EXECUTION_MISMATCH');
    }
  }
  return { executionArn: finalizeExecutionArn, status: execution.status };
}

async function requireExactProductionFinalizeExecution(
  common,
  brokerArn,
  releaseId,
  finalizeExecutionName,
  finalizationEvidence,
) {
  const execution = await inspectExactProductionFinalizeExecution(
    common,
    brokerArn,
    releaseId,
    finalizeExecutionName,
    finalizationEvidence,
    true,
  );
  return execution.executionArn;
}

export async function inspectExactClaimedLifecycleExecution(
  common,
  brokerArn,
  item,
  expected,
  finalizationEvidence,
  adapters = {},
) {
  const claimedExecutionArn = stringAttribute(item, 'ClaimOwner');
  const claimedMode = stringAttribute(item, 'ClaimMode');
  const executionPrefix = `${brokerArn.replace(':stateMachine:', ':execution:')}:`;
  const exactActiveReleaseClaim = exactReleaseOwner(item, expected);
  const exactOrphanReleaseClaim =
    numberAttribute(item, 'Generation') !== undefined &&
    stringAttribute(item, 'LockOwner') === undefined &&
    stringAttribute(item, 'Phase') === undefined;
  if (
    (!exactActiveReleaseClaim && !exactOrphanReleaseClaim) ||
    stringAttribute(item, 'PointerReleaseId') !== expected.releaseId ||
    stringAttribute(item, 'PointerContractName') !== expected.contractName ||
    typeof claimedExecutionArn !== 'string' ||
    !claimedExecutionArn.startsWith(executionPrefix) ||
    !['FINALIZE', 'RECOVER'].includes(claimedMode)
  ) {
    fail('RELEASE_LIFECYCLE_EXECUTION_MISMATCH');
  }
  const executionName = claimedExecutionArn.slice(executionPrefix.length);
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(executionName)) {
    fail('RELEASE_LIFECYCLE_EXECUTION_MISMATCH');
  }
  let input;
  if (claimedMode === 'FINALIZE') {
    const expectedFinalizeName = expected.releaseId.replace(
      new RegExp(`^${common.environment}-`, 'u'),
      `${common.environment}-finalize-`,
    );
    if (executionName !== expectedFinalizeName) {
      fail('RELEASE_LIFECYCLE_EXECUTION_MISMATCH');
    }
    if (common.environment === 'production') {
      if (!exactKeys(finalizationEvidence, finalizationEvidenceNames)) {
        fail('RELEASE_LIFECYCLE_EXECUTION_MISMATCH');
      }
      input = {
        Mode: 'FINALIZE',
        ReleaseId: expected.releaseId,
        FinalizationEvidence: finalizationEvidence,
      };
    } else if (common.environment === 'staging' && finalizationEvidence === undefined) {
      input = {
        Mode: 'FINALIZE',
        ReleaseId: expected.releaseId,
      };
    } else {
      fail('RELEASE_LIFECYCLE_EXECUTION_MISMATCH');
    }
  } else if (claimedMode === 'RECOVER') {
    if (executionName !== `reconcile-${expected.releaseId}`) {
      fail('RELEASE_LIFECYCLE_EXECUTION_MISMATCH');
    }
    input = {
      Mode: 'RECOVER',
      ReleaseId: expected.releaseId,
      DeployExecutionArn: expected.deployArn,
    };
  }
  const describeExecution = adapters.describeExecution ?? describeExecutionIfExists;
  const waitForClaimedExecution = adapters.waitForExecution ?? waitForExecution;
  let execution = describeExecution(common.region, claimedExecutionArn);
  const expectedIdentity = {
    executionArn: claimedExecutionArn,
    input,
    name: executionName,
    stateMachineArn: brokerArn,
  };
  if (execution === undefined || !exactExecutionIdentity(execution, expectedIdentity)) {
    fail('RELEASE_LIFECYCLE_EXECUTION_MISMATCH');
  }
  if (!terminalStatuses.has(execution.status)) {
    execution = await waitForClaimedExecution(common.region, claimedExecutionArn);
    if (
      !terminalStatuses.has(execution.status) ||
      !exactExecutionIdentity(execution, expectedIdentity)
    ) {
      fail('RELEASE_LIFECYCLE_EXECUTION_MISMATCH');
    }
  }
  return {
    executionArn: claimedExecutionArn,
    mode: claimedMode,
    status: execution.status,
  };
}

function writeTerminalGithubOutput(common, terminal, terminalExecutionArn, finalizeExecutionArn) {
  const values = {
    terminal_status: terminal.status,
    terminal_execution_arn: terminalExecutionArn,
  };
  if (common.environment === 'production' && terminal.status === 'DEPLOYED') {
    if (
      !exactKeys(terminal.finalizationEvidence, finalizationEvidenceNames) ||
      typeof finalizeExecutionArn !== 'string'
    ) {
      fail('RELEASE_FINALIZATION_EVIDENCE_MISMATCH');
    }
    Object.assign(values, {
      finalize_execution_arn: finalizeExecutionArn,
      production_finalization_evidence_sha256:
        terminal.finalizationEvidence.ProductionFinalizationEvidenceSha256,
      github_environment_evidence_sha256:
        terminal.finalizationEvidence.GitHubEnvironmentEvidenceSha256,
      promotion_control_plane_evidence_sha256:
        terminal.finalizationEvidence.PromotionControlPlaneEvidenceSha256,
    });
  }
  writeGithubOutput(values);
}

async function main() {
  const options = parseOptions(process.argv);
  const common = validateCommon(options);
  const expectedBrokerArn = `arn:aws:states:${common.region}:${common.accountId}:stateMachine:aeostudio-${common.environment}-release`;
  const brokerArn = ['RECOVER', 'CLEANUP'].includes(common.mode)
    ? expectedBrokerArn
    : readPointer(common.region, common.accountId, common.environment).brokerArn;
  let input;
  let manifest;
  let runId;
  let runAttempt;
  let releaseId;
  const expectedProductionFinalizationEvidence =
    common.environment === 'production' &&
    ['FINALIZE', 'RECOVER', 'CLEANUP'].includes(common.mode) &&
    (common.mode !== 'CLEANUP' || options.has('production-finalization-evidence-sha256'))
      ? finalizationEvidenceFromOptions(options)
      : undefined;

  if (common.mode === 'DEPLOY_START' || common.mode === 'DEPLOY_WAIT') {
    releaseId = option(options, 'release-id');
    manifest = jsonFile(option(options, 'manifest'), 'RELEASE_MANIFEST_INVALID');
    ({ runAttempt, runId } = validateManifest(manifest, {
      accountId: common.accountId,
      region: common.region,
      repository: option(options, 'repository'),
    }));
    if (common.mode === 'DEPLOY_START') {
      for (const service of ['adot', 'api', 'web', 'worker']) {
        verifyDigestExists(common.region, `aeostudio-${service}`, manifest.images[service].digest);
      }
    }
    input = {
      Mode: 'DEPLOY',
      Release: {
        ApiDigest: manifest.images.api.digest,
        AdotDigest: manifest.images.adot.digest,
        WebDigest: manifest.images.web.digest,
        WorkerDigest: manifest.images.worker.digest,
        SourceSha: manifest.sourceSha,
        BuildRunId: runId,
        BuildRunAttempt: runAttempt,
      },
    };
  } else if (common.mode === 'RECOVER') {
    releaseId = option(options, 'release-id');
    input = {
      Mode: 'RECOVER',
      ReleaseId: releaseId,
      DeployExecutionArn: executionArn(brokerArn, releaseId),
    };
  } else {
    releaseId = option(options, 'release-id');
    input =
      common.mode === 'FINALIZE' && common.environment === 'production'
        ? {
            Mode: common.mode,
            ReleaseId: releaseId,
            FinalizationEvidence: expectedProductionFinalizationEvidence,
          }
        : { Mode: common.mode, ReleaseId: releaseId };
  }

  if (common.mode === 'DEPLOY_START') {
    const startedArn = startExecution(common.region, brokerArn, common.executionName, input);
    writeGithubOutput({
      contract_name: `/aeostudio/${common.environment}/releases/${releaseId}`,
      execution_arn: startedArn,
      release_id: releaseId,
    });
    process.stdout.write(`DEPLOY_STARTED:${startedArn}\n`);
    return;
  }

  if (common.mode === 'DEPLOY_WAIT') {
    const deployArn = executionArn(brokerArn, common.executionName);
    const contractName = `/aeostudio/${common.environment}/releases/${releaseId}`;
    const execution = requireSucceeded(await waitForExecution(common.region, deployArn));
    const currentPointer = readPointer(common.region, common.accountId, common.environment).pointer;
    if (
      currentPointer.Status !== 'AWAITING_SMOKE' ||
      currentPointer.ReleaseId !== releaseId ||
      currentPointer.ContractName !== contractName
    ) {
      fail('RELEASE_POINTER_NOT_AWAITING_SMOKE');
    }
    requireAwaitingSmokeCoordination(readCoordination(common.region, common.environment), {
      contractName,
      deployArn,
      releaseId,
    });
    const contract = validateContract(readContract(common.region, contractName), {
      ...common,
      brokerArn,
      manifest,
      releaseId,
      runAttempt,
      runId,
    });
    writeFileSync(
      option(options, 'output-contract'),
      `${JSON.stringify({ contract, executionArn: deployArn, executionStatus: execution.status }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    writeGithubOutput({
      contract_name: contractName,
      execution_arn: deployArn,
      release_id: releaseId,
    });
    process.stdout.write(`DEPLOY_WAIT_SUCCEEDED:${deployArn}\n`);
    return;
  }

  if (common.mode === 'CLEANUP') {
    const deployName = option(options, 'deploy-execution-name');
    const expectedReconciliationName = `reconcile-${releaseId}`;
    if (
      !new RegExp(`^[A-Za-z0-9_-]{1,${maximumReleaseIdLength}}$`, 'u').test(deployName) ||
      releaseId !== deployName ||
      common.executionName !== expectedReconciliationName
    ) {
      fail('RELEASE_ARGUMENTS_INVALID');
    }
    const deployArn = executionArn(brokerArn, deployName);
    const expectedReconciliationArn = executionArn(brokerArn, expectedReconciliationName);
    const contractName = `/aeostudio/${common.environment}/releases/${releaseId}`;
    const expectedOwner = {
      contractName,
      deployArn,
      releaseId,
      ...(common.environment === 'production'
        ? { finalizationEvidence: expectedProductionFinalizationEvidence }
        : {}),
    };
    const recordTerminal = async (terminal, terminalExecutionArn) => {
      const finalizeExecutionArn =
        common.environment === 'production' && terminal.status === 'DEPLOYED'
          ? await requireExactProductionFinalizeExecution(
              common,
              brokerArn,
              releaseId,
              option(options, 'finalize-execution-name'),
              expectedProductionFinalizationEvidence,
            )
          : undefined;
      writeTerminalGithubOutput(
        common,
        terminal,
        terminalExecutionArn ?? finalizeExecutionArn,
        finalizeExecutionArn,
      );
    };
    let deployExecution;
    for (let attempt = 0; attempt < 6 && deployExecution === undefined; attempt += 1) {
      deployExecution = describeExecutionIfExists(common.region, deployArn);
      if (deployExecution === undefined) {
        await delay(2_000);
      }
    }
    if (deployExecution === undefined) {
      const coordination = readCoordination(common.region, common.environment);
      const lockOwner = stringAttribute(coordination, 'LockOwner');
      const claimOwner = stringAttribute(coordination, 'ClaimOwner');
      if (lockOwner === deployArn) {
        fail('CLEANUP_DEPLOY_EXECUTION_MISSING_WITH_ACTIVE_COORDINATION');
      }
      if (claimOwner !== undefined) {
        const claimReleaseId = stringAttribute(coordination, 'PointerReleaseId');
        const claimContractName = stringAttribute(coordination, 'PointerContractName');
        const claimMode = stringAttribute(coordination, 'ClaimMode');
        const claimGeneration = numberAttribute(coordination, 'Generation');
        if (
          claimReleaseId === undefined ||
          claimContractName === undefined ||
          claimMode === undefined ||
          claimGeneration === undefined
        ) {
          fail('RELEASE_COORDINATION_INVALID');
        }
        if (claimReleaseId === releaseId && claimContractName === contractName) {
          fail('CLEANUP_DEPLOY_EXECUTION_MISSING_WITH_ACTIVE_COORDINATION');
        }
      }
      process.stdout.write(`CLEANUP_NOT_STARTED:${deployArn}\n`);
      return;
    }
    if (
      !exactExecutionIdentity(deployExecution, {
        executionArn: deployArn,
        name: deployName,
        stateMachineArn: brokerArn,
      })
    ) {
      fail('CLEANUP_DEPLOY_EXECUTION_MISMATCH');
    }
    const watchdogStateMachineArn = `arn:aws:states:${common.region}:${common.accountId}:stateMachine:aeostudio-${common.environment}-release-watchdog`;
    const watchdogExecutionArn = executionArn(watchdogStateMachineArn, deployName);
    const watchdogInput = { DeployExecutionArn: deployArn, ReleaseId: releaseId };
    let watchdogExecution;
    for (let attempt = 0; attempt < 6 && watchdogExecution === undefined; attempt += 1) {
      watchdogExecution = describeExecutionIfExists(common.region, watchdogExecutionArn);
      if (watchdogExecution === undefined) {
        await delay(2_000);
      }
    }
    if (
      watchdogExecution !== undefined &&
      !exactExecutionIdentity(watchdogExecution, {
        executionArn: watchdogExecutionArn,
        input: watchdogInput,
        name: deployName,
        stateMachineArn: watchdogStateMachineArn,
      })
    ) {
      fail('CLEANUP_WATCHDOG_EXECUTION_MISMATCH');
    }
    if (!terminalStatuses.has(deployExecution.status)) {
      const waitedDeployExecution = await waitForExecution(common.region, deployArn);
      deployExecution = refreshExactDeployExecutionAfterWatchdog(
        common,
        brokerArn,
        deployName,
        deployArn,
        () => waitedDeployExecution,
      );
    }
    if (!terminalStatuses.has(deployExecution.status)) {
      fail('CLEANUP_RUNNING_DEPLOY_WITHOUT_ACTIVE_WATCHDOG');
    }
    let coordination = readCoordination(common.region, common.environment);
    const authorizedFinalizeExecution =
      common.environment === 'production' && expectedProductionFinalizationEvidence !== undefined
        ? await inspectExactProductionFinalizeExecution(
            common,
            brokerArn,
            releaseId,
            option(options, 'finalize-execution-name'),
            expectedProductionFinalizationEvidence,
            false,
          )
        : undefined;
    if (authorizedFinalizeExecution !== undefined) {
      coordination = readCoordination(common.region, common.environment);
    }
    const claimedExecutionArn = stringAttribute(coordination, 'ClaimOwner');
    const claimedLifecycleExecution =
      claimedExecutionArn === undefined
        ? undefined
        : await inspectExactClaimedLifecycleExecution(
            common,
            brokerArn,
            coordination,
            expectedOwner,
            expectedProductionFinalizationEvidence,
          );
    if (claimedLifecycleExecution !== undefined) {
      coordination = readCoordination(common.region, common.environment);
    }
    const activeClaimOwner = stringAttribute(coordination, 'ClaimOwner');
    if (!exactReleaseOwner(coordination, expectedOwner) && activeClaimOwner === undefined) {
      if (releaseIsNotOwned(coordination, releaseId)) {
        process.stdout.write(`CLEANUP_RELEASE_NOT_OWNED:${deployArn}\n`);
        return;
      }
      const terminal = requireExactTerminalReleaseState(
        coordination,
        expectedOwner,
        ['DEPLOYED', 'PREPARATION_ABORTED', 'ROLLED_BACK'],
        common,
      );
      const terminalObserverArn =
        terminal.status === 'DEPLOYED' && authorizedFinalizeExecution?.status === 'SUCCEEDED'
          ? authorizedFinalizeExecution.executionArn
          : claimedLifecycleExecution?.status === 'SUCCEEDED' &&
              claimedLifecycleExecution.mode === 'RECOVER' &&
              claimedLifecycleExecution.executionArn === expectedReconciliationArn
            ? claimedLifecycleExecution.executionArn
            : undefined;
      if (terminalObserverArn !== undefined) {
        await recordTerminal(terminal, terminalObserverArn);
        process.stdout.write(`CLEANUP_ALREADY_CONVERGED:${deployArn}\n`);
        return;
      }
    }
    const cleanupInput = {
      Mode: 'RECOVER',
      ReleaseId: releaseId,
      DeployExecutionArn: deployArn,
    };
    const expectedTerminalStatuses = ['DEPLOYED', 'PREPARATION_ABORTED', 'ROLLED_BACK'];
    const cleanupArn = startExecution(
      common.region,
      brokerArn,
      expectedReconciliationName,
      cleanupInput,
    );
    writeGithubOutput({ execution_arn: cleanupArn });
    const cleanupExecution = requireSucceeded(await waitForExecution(common.region, cleanupArn));
    if (
      !exactExecutionIdentity(cleanupExecution, {
        executionArn: expectedReconciliationArn,
        input: cleanupInput,
        name: expectedReconciliationName,
        stateMachineArn: brokerArn,
      })
    ) {
      fail('RELEASE_LIFECYCLE_EXECUTION_MISMATCH');
    }
    const terminal = requireExactTerminalReleaseState(
      readCoordination(common.region, common.environment),
      expectedOwner,
      expectedTerminalStatuses,
      common,
    );
    await recordTerminal(terminal, cleanupArn);
    process.stdout.write(`CLEANUP_RECOVER_SUCCEEDED:${cleanupArn}\n`);
    return;
  }

  const startedArn = startExecution(common.region, brokerArn, common.executionName, input);
  writeGithubOutput({ execution_arn: startedArn });
  requireSucceeded(await waitForExecution(common.region, startedArn));
  if (common.mode === 'FINALIZE') {
    const contractName = `/aeostudio/${common.environment}/releases/${releaseId}`;
    const terminal = requireFinalizedReleaseState(
      readPointer(common.region, common.accountId, common.environment).pointer,
      readCoordination(common.region, common.environment),
      {
        contractName,
        releaseId,
        ...(common.environment === 'production'
          ? { finalizationEvidence: input.FinalizationEvidence }
          : {}),
      },
      common.environment,
    );
    writeTerminalGithubOutput(common, terminal, startedArn, startedArn);
  } else if (common.mode === 'RECOVER') {
    requireExactTerminalReleaseState(
      readCoordination(common.region, common.environment),
      {
        contractName: `/aeostudio/${common.environment}/releases/${releaseId}`,
        deployArn: executionArn(brokerArn, releaseId),
        releaseId,
        ...(common.environment === 'production'
          ? { finalizationEvidence: expectedProductionFinalizationEvidence }
          : {}),
      },
      ['DEPLOYED', 'PREPARATION_ABORTED', 'ROLLED_BACK'],
      common,
    );
  }
  process.stdout.write(`${common.mode}_BROKER_SUCCEEDED:${startedArn}\n`);
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof Error ? error.message : 'RELEASE_BROKER_CLIENT_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
