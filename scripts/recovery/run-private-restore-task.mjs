import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

import { createRecoveryAwsSdk } from './aws-recovery-sdk.mjs';
import { buildPrivateRestoreTaskPlan } from './private-restore-task-contract.mjs';

const region = 'ap-southeast-1';
const restoreScriptPath = fileURLToPath(new URL('./run-restore-drill.mjs', import.meta.url));

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function json(output, code) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(code);
  }
}

function taskIdentity(taskMetadata, expectedImage, expectedDigest) {
  const taskArn = String(taskMetadata?.TaskARN ?? '');
  const task =
    /^arn:aws:ecs:ap-southeast-1:([0-9]{12}):task\/aeostudio-staging\/([0-9a-f]{32})$/u.exec(
      taskArn,
    );
  const family = String(taskMetadata?.Family ?? '');
  const revision = Number(taskMetadata?.Revision);
  const container = Array.isArray(taskMetadata?.Containers)
    ? taskMetadata.Containers.find((candidate) => candidate?.Name === 'restore-drill')
    : undefined;
  if (
    task === null ||
    family !== 'aeostudio-staging-restore-drill' ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    container?.Image !== expectedImage ||
    container?.ImageID !== expectedDigest ||
    !expectedImage.endsWith(`@${expectedDigest}`)
  ) {
    throw new Error('RESTORE_TASK_IDENTITY_INVALID');
  }
  return {
    taskArn,
    taskDefinitionArn: `arn:aws:ecs:ap-southeast-1:${task[1]}:task-definition/${family}:${String(revision)}`,
  };
}

async function defaultLoadTaskMetadata(metadataUri) {
  const endpoint = new URL(`${metadataUri.replace(/\/+$/u, '')}/task`);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '169.254.170.2') {
    throw new Error('ECS_TASK_METADATA_URI_INVALID');
  }
  const response = await globalThis.fetch(endpoint, {
    headers: { accept: 'application/json' },
    signal: globalThis.AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`ECS_TASK_METADATA_HTTP_${String(response.status)}`);
  return response.json();
}

async function defaultRunDrill(environment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [restoreScriptPath], {
      env: environment,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => resolvePromise(code ?? 1));
  });
}

const defaultFiles = {
  mkdir: (path) => mkdir(path, { recursive: true }),
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, contents) => writeFile(path, contents, { encoding: 'utf8', flag: 'wx' }),
};

export async function runPrivateRestoreTask({
  environment = process.env,
  loadTaskMetadata = defaultLoadTaskMetadata,
  aws,
  runDrill = defaultRunDrill,
  files = defaultFiles,
  now = new Date(),
} = {}) {
  if (required(environment, 'AWS_REGION') !== region) {
    throw new Error('RESTORE_TASK_REGION_MUST_BE_SINGAPORE');
  }
  const metadataUri = required(environment, 'ECS_CONTAINER_METADATA_URI_V4');
  const taskMetadata = await loadTaskMetadata(metadataUri);
  const expectedRecoveryImage = required(environment, 'AEO_RECOVERY_IMAGE_URI');
  const expectedRecoveryDigest = required(environment, 'AEO_RECOVERY_IMAGE_DIGEST');
  const identity = taskIdentity(taskMetadata, expectedRecoveryImage, expectedRecoveryDigest);
  const sdk = aws ?? (await createRecoveryAwsSdk({ region }));
  const parameterName = required(environment, 'AEO_RESTORE_INPUT_PARAMETER');
  const parameterEnvelope = await sdk.getParameter({ Name: parameterName });
  const restoreInput = json(
    parameterEnvelope?.Parameter?.Value ?? '',
    'RESTORE_INPUT_PARAMETER_VALUE_INVALID',
  );
  const plan = buildPrivateRestoreTaskPlan({
    taskArn: taskMetadata?.TaskARN,
    now,
    contract: restoreInput,
  });

  const recoveryMetadataEnvelope = await sdk.getRecoveryPointRestoreMetadata({
    BackupVaultName: required(environment, 'AEO_BACKUP_VAULT_NAME'),
    RecoveryPointArn: plan.environment.AEO_S3_RECOVERY_POINT_ARN,
  });
  const sourceMetadata = recoveryMetadataEnvelope?.RestoreMetadata;
  if (
    sourceMetadata === null ||
    typeof sourceMetadata !== 'object' ||
    Array.isArray(sourceMetadata) ||
    Object.values(sourceMetadata).some((value) => typeof value !== 'string')
  ) {
    throw new Error('S3_RESTORE_METADATA_RESPONSE_INVALID');
  }
  const restoreMetadata = {
    ...sourceMetadata,
    DestinationBucketName: required(environment, 'AEO_RESTORED_BUCKET'),
    EncryptionType: 'SSE-KMS',
    KMSKey: required(environment, 'AEO_DATA_KMS_KEY_ARN'),
    NewBucket: 'false',
    RestoreACLs: 'false',
  };
  delete restoreMetadata.RestoreTime;

  await files.mkdir(dirname(plan.restoreMetadataPath));
  await files.writeFile(plan.restoreMetadataPath, `${JSON.stringify(restoreMetadata, null, 2)}\n`);
  const drillEnvironment = {
    ...environment,
    ...plan.environment,
    AEO_RESTORE_TASK_ARN: identity.taskArn,
    AEO_RESTORE_TASK_DEFINITION_ARN: identity.taskDefinitionArn,
  };
  const drillExitCode = await runDrill(drillEnvironment);
  const evidenceText = await files.readFile(plan.evidencePath);
  const evidence = json(evidenceText, 'RESTORE_EVIDENCE_INVALID');
  if (
    evidence?.schemaVersion !== 'aeostudio-restore-drill.v1' ||
    evidence?.environment !== 'staging' ||
    evidence?.drillId !== plan.drillId ||
    evidence?.executionIdentity?.taskArn !== identity.taskArn ||
    evidence?.executionIdentity?.taskDefinitionArn !== identity.taskDefinitionArn ||
    evidence?.recoveryImage?.image !== expectedRecoveryImage ||
    evidence?.recoveryImage?.digest !== expectedRecoveryDigest
  ) {
    throw new Error('RESTORE_EVIDENCE_CONTRACT_MISMATCH');
  }

  await sdk.putEvidenceObject({
    BodyPath: plan.evidencePath,
    Bucket: required(environment, 'AEO_RESTORE_EVIDENCE_BUCKET'),
    ChecksumAlgorithm: 'SHA256',
    ContentType: 'application/json',
    IfNoneMatch: '*',
    Key: plan.evidenceKey,
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: required(environment, 'AEO_DATA_KMS_KEY_ARN'),
  });

  return { drillExitCode, evidenceKey: plan.evidenceKey };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const result = await runPrivateRestoreTask();
    process.stdout.write(
      `${JSON.stringify({
        outcome: result.drillExitCode === 0 ? 'PASSED' : 'FAILED',
        evidenceKey: result.evidenceKey,
      })}\n`,
    );
    process.exitCode = result.drillExitCode;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        outcome: 'FAILED',
        errorCode: error instanceof Error ? error.message.split(':', 1)[0] : 'UNKNOWN_ERROR',
      })}\n`,
    );
    process.exitCode = 1;
  }
}
