import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const requiredOptions = [
  'environment',
  'region',
  'expected-account-id',
  'expected-api-digest',
  'execution-name',
  'confirm',
  'output-evidence',
];
const terminalStatuses = new Set(['ABORTED', 'FAILED', 'SUCCEEDED', 'TIMED_OUT']);

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
      fail('BOOTSTRAP_ARGUMENTS_INVALID');
    }
    const name = flag.slice(2);
    if (!requiredOptions.includes(name) || options.has(name)) {
      fail('BOOTSTRAP_ARGUMENTS_INVALID');
    }
    options.set(name, value);
  }
  if (requiredOptions.some((name) => !options.has(name))) {
    fail('BOOTSTRAP_ARGUMENTS_INVALID');
  }
  return options;
}

function option(options, name) {
  const value = options.get(name);
  if (value === undefined || value.length === 0) {
    fail('BOOTSTRAP_ARGUMENTS_INVALID');
  }
  return value;
}

function aws(region, args) {
  const result = spawnSync('aws', ['--region', region, '--no-cli-pager', ...args], {
    encoding: 'utf8',
    env: { ...process.env, AWS_PAGER: '' },
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(`AWS_COMMAND_FAILED:${args[0] ?? 'unknown'}:${args[1] ?? 'unknown'}`);
  }
  return result.stdout;
}

function awsJson(region, args) {
  try {
    return JSON.parse(aws(region, [...args, '--output', 'json']));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('AWS_COMMAND_FAILED:')) {
      throw error;
    }
    fail('AWS_RESPONSE_INVALID');
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

function sameStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function entriesByName(entries) {
  if (!Array.isArray(entries)) {
    return undefined;
  }
  const values = new Map();
  for (const entry of entries) {
    if (
      typeof entry?.name !== 'string' ||
      typeof entry?.value !== 'string' ||
      values.has(entry.name)
    ) {
      return undefined;
    }
    values.set(entry.name, entry.value);
  }
  return values;
}

function secretArnPattern(region, accountId, secretName) {
  const escapedName = secretName.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(
    `^arn:aws:secretsmanager:${region}:${accountId}:secret:${escapedName}-[A-Za-z0-9]{6}$`,
    'u',
  );
}

function taskTagsAreExact(tags, environment) {
  if (!Array.isArray(tags) || tags.length !== 4) {
    return false;
  }
  const values = new Map(tags.map((tag) => [tag.key, tag.value]));
  return (
    values.size === 4 &&
    values.get('Application') === 'aeostudio' &&
    values.get('Environment') === environment &&
    values.get('ManagedBy') === 'opentofu' &&
    values.get('DataClass') === (environment === 'staging' ? 'synthetic-only' : 'tenant-data')
  );
}

function validateTaskDefinition(region, accountId, environment, contract, phase) {
  const taskReference = phase === 'bootstrap' ? contract.BootstrapTask : contract.MigrationTask;
  const expectedFamily = `aeostudio-${environment}-${phase}`;
  const arnPattern = new RegExp(
    `^arn:aws:ecs:${region}:${accountId}:task-definition/${expectedFamily}:[1-9][0-9]*$`,
    'u',
  );
  if (!arnPattern.test(taskReference)) {
    fail('BOOTSTRAP_TASK_REFERENCE_INVALID');
  }
  const response = awsJson(region, [
    'ecs',
    'describe-task-definition',
    '--task-definition',
    taskReference,
    '--include',
    'TAGS',
  ]);
  const task = response.taskDefinition;
  const container =
    Array.isArray(task?.containerDefinitions) && task.containerDefinitions.length === 1
      ? task.containerDefinitions[0]
      : undefined;
  const environmentValues = entriesByName(container?.environment);
  const expectedCommand = [
    'node',
    phase === 'bootstrap'
      ? 'packages/db/dist/bootstrap-main.js'
      : 'packages/db/dist/migrate-main.js',
  ];
  const rolePrefix = `arn:aws:iam::${accountId}:role/aeostudio-${environment}-${phase}`;
  const logOptions = container?.logConfiguration?.options;
  const commonIsExact =
    task?.taskDefinitionArn === taskReference &&
    task?.family === expectedFamily &&
    task?.networkMode === 'awsvpc' &&
    task?.cpu === '512' &&
    task?.memory === '1024' &&
    task?.taskRoleArn === `${rolePrefix}-runtime` &&
    task?.executionRoleArn === `${rolePrefix}-execution` &&
    sameStrings(task?.requiresCompatibilities, ['FARGATE']) &&
    container?.name === phase &&
    container?.essential === true &&
    sameStrings(container?.command, expectedCommand) &&
    container?.image === contract.ApiImage &&
    container?.logConfiguration?.logDriver === 'awslogs' &&
    logOptions?.['awslogs-group'] === `/ecs/aeostudio-${environment}/api` &&
    logOptions?.['awslogs-region'] === region &&
    logOptions?.['awslogs-stream-prefix'] === phase &&
    container?.privileged !== true &&
    taskTagsAreExact(response.tags, environment);

  let phaseIsExact = false;
  if (phase === 'bootstrap' && environmentValues !== undefined) {
    const fixedValues = new Map([
      ['NODE_ENV', 'production'],
      ['AWS_REGION', region],
      ['AEO_ENVIRONMENT', environment],
      ['AEO_DATABASE_NAME', 'aeostudio'],
      ['BOOTSTRAP_CONFIRMATION', `bootstrap:${environment}`],
    ]);
    const secretNames = [
      ['RUNTIME_DATABASE_URL_SECRET_ARN', 'runtime_database_url'],
      ['LIFECYCLE_DATABASE_URL_SECRET_ARN', 'lifecycle_database_url'],
      ['ADMIN_DATABASE_URL_SECRET_ARN', 'admin_database_url'],
      ['TENANT_DATA_BROKER_DATABASE_URL_SECRET_ARN', 'tenant_data_broker_database_url'],
      ['TENANT_DATA_BROKER_HMAC_KEY_RING_SECRET_ARN', 'tenant_data_broker_hmac_key_ring'],
      ['SESSION_ENCRYPTION_KEY_SECRET_ARN', 'session_encryption_key'],
      ['DELETION_RECEIPT_SIGNING_KEY_SECRET_ARN', 'deletion_receipt_signing_key'],
    ];
    phaseIsExact =
      environmentValues.size === 13 &&
      [...fixedValues].every(([name, value]) => environmentValues.get(name) === value) &&
      new RegExp(
        `^arn:aws:secretsmanager:${region}:${accountId}:secret:rds!db-[A-Za-z0-9-]+$`,
        'u',
      ).test(environmentValues.get('RDS_MASTER_SECRET_ARN') ?? '') &&
      secretNames.every(([name, secretName]) =>
        secretArnPattern(region, accountId, `aeostudio-${environment}/${secretName}`).test(
          environmentValues.get(name) ?? '',
        ),
      ) &&
      (!Array.isArray(container?.secrets) || container.secrets.length === 0);
  } else if (phase === 'migration' && environmentValues !== undefined) {
    const secrets = Array.isArray(container?.secrets) ? container.secrets : [];
    phaseIsExact =
      environmentValues.size === 2 &&
      environmentValues.get('NODE_ENV') === 'production' &&
      environmentValues.get('AWS_REGION') === region &&
      secrets.length === 1 &&
      secrets[0]?.name === 'DATABASE_URL' &&
      secretArnPattern(region, accountId, `aeostudio-${environment}/admin_database_url`).test(
        secrets[0]?.valueFrom ?? '',
      );
  }
  if (!commonIsExact || !phaseIsExact) {
    fail('BOOTSTRAP_TASK_DEFINITION_MISMATCH');
  }
}

function loadContract(region, accountId, environment, expectedDigest) {
  const parameterName = `/aeostudio/${environment}/bootstrap-contract`;
  const response = awsJson(region, ['ssm', 'get-parameter', '--name', parameterName]);
  let contract;
  try {
    contract = JSON.parse(response.Parameter.Value);
  } catch {
    fail('BOOTSTRAP_CONTRACT_INVALID');
  }
  const expectedBroker = `arn:aws:states:${region}:${accountId}:stateMachine:aeostudio-${environment}-bootstrap`;
  const expectedCluster = `arn:aws:ecs:${region}:${accountId}:cluster/aeostudio-${environment}`;
  const expectedImage = `${accountId}.dkr.ecr.${region}.amazonaws.com/aeostudio-api@${expectedDigest}`;
  if (
    !exactKeys(contract, [
      'SchemaVersion',
      'Environment',
      'Region',
      'AccountId',
      'ApiDigest',
      'ApiImage',
      'BootstrapTask',
      'MigrationTask',
      'BrokerArn',
      'ClusterArn',
    ]) ||
    contract.SchemaVersion !== 'aeostudio.bootstrap-contract.v1' ||
    contract.Environment !== environment ||
    contract.Region !== region ||
    contract.AccountId !== accountId ||
    contract.ApiDigest !== expectedDigest ||
    contract.ApiImage !== expectedImage ||
    contract.BrokerArn !== expectedBroker ||
    contract.ClusterArn !== expectedCluster
  ) {
    fail('BOOTSTRAP_CONTRACT_INVALID');
  }
  validateTaskDefinition(region, accountId, environment, contract, 'bootstrap');
  validateTaskDefinition(region, accountId, environment, contract, 'migration');
  return contract;
}

function startExecution(region, brokerArn, executionName) {
  const response = awsJson(region, [
    'stepfunctions',
    'start-execution',
    '--state-machine-arn',
    brokerArn,
    '--name',
    executionName,
    '--input',
    '{}',
  ]);
  if (typeof response.executionArn !== 'string') {
    fail('BOOTSTRAP_EXECUTION_START_FAILED');
  }
  return response.executionArn;
}

async function waitForExecution(region, executionArn) {
  const deadline = Date.now() + 2_250_000;
  while (Date.now() < deadline) {
    const execution = awsJson(region, [
      'stepfunctions',
      'describe-execution',
      '--execution-arn',
      executionArn,
    ]);
    if (terminalStatuses.has(execution.status)) {
      if (execution.status !== 'SUCCEEDED') {
        fail(`BOOTSTRAP_EXECUTION_${execution.status}`);
      }
      return execution;
    }
    await delay(10_000);
  }
  fail('BOOTSTRAP_EXECUTION_WAIT_TIMEOUT');
}

function verifiedExecutionEvidence(execution, contract, region, accountId, environment) {
  let output;
  try {
    output = JSON.parse(execution.output);
  } catch {
    fail('BOOTSTRAP_EXECUTION_OUTPUT_INVALID');
  }
  const taskArnPattern = new RegExp(
    `^arn:aws:ecs:${region}:${accountId}:task/aeostudio-${environment}/[0-9a-f]{32}$`,
    'u',
  );
  const phases = {
    bootstrap: {
      result: output.bootstrap,
      run: output.bootstrapRun,
      taskDefinitionArn: contract.BootstrapTask,
    },
    migration: {
      result: output.migration,
      run: output.migrationRun,
      taskDefinitionArn: contract.MigrationTask,
    },
  };
  const tasks = {};
  for (const [phase, value] of Object.entries(phases)) {
    if (
      !taskArnPattern.test(value.run?.TaskArn) ||
      value.result?.FailureCount !== 0 ||
      value.result?.ContainerCount !== 1 ||
      value.result?.TaskDefinitionArn !== value.taskDefinitionArn ||
      value.result?.LastStatus !== 'STOPPED' ||
      value.result?.ContainerName !== phase ||
      value.result?.ExitCode !== 0
    ) {
      fail('BOOTSTRAP_EXECUTION_OUTPUT_INVALID');
    }
    tasks[phase] = {
      taskArn: value.run.TaskArn,
      taskDefinitionArn: value.result.TaskDefinitionArn,
      containerName: value.result.ContainerName,
      exitCode: value.result.ExitCode,
    };
  }
  return tasks;
}

function writeGithubOutput(executionArn) {
  const output = process.env.GITHUB_OUTPUT;
  if (typeof output === 'string' && output.length > 0) {
    appendFileSync(output, `execution_arn=${executionArn}\n`);
  }
}

async function main() {
  const options = parseOptions(process.argv);
  const environment = option(options, 'environment');
  const region = option(options, 'region');
  const accountId = option(options, 'expected-account-id');
  const expectedDigest = option(options, 'expected-api-digest');
  const executionName = option(options, 'execution-name');
  if (
    !/^(?:staging|production)$/u.test(environment) ||
    region !== 'ap-southeast-1' ||
    !/^[0-9]{12}$/u.test(accountId) ||
    !/^sha256:[0-9a-f]{64}$/u.test(expectedDigest) ||
    !/^[A-Za-z0-9_-]{1,80}$/u.test(executionName) ||
    option(options, 'confirm') !== `bootstrap:${environment}`
  ) {
    fail('BOOTSTRAP_ARGUMENTS_INVALID');
  }
  const contract = loadContract(region, accountId, environment, expectedDigest);
  const executionArn = startExecution(region, contract.BrokerArn, executionName);
  const execution = await waitForExecution(region, executionArn);
  const tasks = verifiedExecutionEvidence(execution, contract, region, accountId, environment);
  writeFileSync(
    option(options, 'output-evidence'),
    `${JSON.stringify({ contract, executionArn, executionStatus: execution.status, tasks }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  writeGithubOutput(executionArn);
  process.stdout.write(`BOOTSTRAP_AND_MIGRATION_COMPLETE:${executionArn}\n`);
}

try {
  await main();
} catch (error) {
  const code = error instanceof Error ? error.message : 'BOOTSTRAP_OPERATOR_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
