import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export async function readStagingReleaseContractEvidence(input) {
  const path = resolve(input.path);
  const raw = await readFile(path);
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('STAGING_RELEASE_CONTRACT_INVALID', { cause: error });
  }
  const taskDefinitions = validateStagingReleaseContract(value, input.expected, input.imageDigests);
  if (basename(path) !== 'staging-release-contract.json') {
    throw new Error('STAGING_RELEASE_CONTRACT_FILE_INVALID');
  }
  return {
    path,
    raw,
    value,
    taskDefinitions,
    binding: {
      file: basename(path),
      sha256: createHash('sha256').update(raw).digest('hex'),
    },
  };
}

export function validateStagingReleaseContract(value, expected, imageDigests) {
  const wrapper = object(value, 'STAGING_RELEASE_CONTRACT_INVALID');
  const contract = object(wrapper.contract, 'STAGING_RELEASE_CONTRACT_INVALID');
  const source = object(contract.Source, 'STAGING_RELEASE_CONTRACT_INVALID');
  const digests = object(contract.Digests, 'STAGING_RELEASE_CONTRACT_INVALID');
  const images = object(contract.Images, 'STAGING_RELEASE_CONTRACT_INVALID');
  const rawTaskDefinitions = object(contract.TaskDefinitions, 'STAGING_RELEASE_CONTRACT_INVALID');
  const rollback = object(contract.Rollback, 'STAGING_RELEASE_CONTRACT_INVALID');
  const releaseId = `staging-${expected.buildRunId}-${expected.buildRunAttempt}`;
  if (
    wrapper.executionStatus !== 'SUCCEEDED' ||
    contract.SchemaVersion !== 'aeostudio.release-contract.v2' ||
    contract.Environment !== 'staging' ||
    contract.Region !== 'ap-southeast-1' ||
    contract.AccountId !== expected.accountId ||
    contract.ReleaseId !== releaseId ||
    source.Sha !== expected.sourceSha ||
    String(source.BuildRunId) !== expected.buildRunId ||
    String(source.BuildRunAttempt) !== expected.buildRunAttempt
  ) {
    throw new Error('STAGING_RELEASE_CONTRACT_IDENTITY_MISMATCH');
  }
  if (
    !sameKeys(digests, ['Adot', 'Api', 'Web', 'Worker']) ||
    !sameKeys(images, ['Adot', 'Api', 'TenantDataBroker', 'Web', 'Worker']) ||
    !sameKeys(rawTaskDefinitions, ['Api', 'Migration', 'TenantDataBroker', 'Web', 'Worker']) ||
    !sameKeys(rollback, ['Api', 'TenantDataBroker', 'Web', 'Worker'])
  ) {
    throw new Error('STAGING_RELEASE_CONTRACT_INVALID');
  }

  const registry = `${expected.accountId}.dkr.ecr.ap-southeast-1.amazonaws.com`;
  const taskDefinitions = {};
  const adotDigest = exact(imageDigests.adot, DIGEST, 'STAGING_RELEASE_CONTRACT_DIGEST_MISMATCH');
  if (digests.Adot !== adotDigest || images.Adot !== `${registry}/aeostudio-adot@${adotDigest}`) {
    throw new Error('STAGING_RELEASE_CONTRACT_DIGEST_MISMATCH');
  }
  for (const [contractName, service] of [
    ['Api', 'api'],
    ['Web', 'web'],
    ['Worker', 'worker'],
  ]) {
    const digest = exact(imageDigests[service], DIGEST, 'STAGING_RELEASE_CONTRACT_DIGEST_MISMATCH');
    if (
      digests[contractName] !== digest ||
      images[contractName] !== `${registry}/aeostudio-${service}@${digest}`
    ) {
      throw new Error('STAGING_RELEASE_CONTRACT_DIGEST_MISMATCH');
    }
    taskDefinitions[service] = exact(
      rawTaskDefinitions[contractName],
      new RegExp(
        `^arn:aws:ecs:ap-southeast-1:${expected.accountId}:task-definition/aeostudio-staging-${service}:[1-9][0-9]*$`,
        'u',
      ),
      'STAGING_RELEASE_CONTRACT_TASK_DEFINITION_INVALID',
    );
    exact(
      rollback[contractName],
      new RegExp(
        `^arn:aws:ecs:ap-southeast-1:${expected.accountId}:task-definition/aeostudio-staging-${service}:[1-9][0-9]*$`,
        'u',
      ),
      'STAGING_RELEASE_CONTRACT_TASK_DEFINITION_INVALID',
    );
  }
  if (
    imageDigests.tenantDataBroker !== imageDigests.worker ||
    images.TenantDataBroker !== images.Worker
  ) {
    throw new Error('STAGING_RELEASE_CONTRACT_DIGEST_MISMATCH');
  }
  taskDefinitions.tenantDataBroker = exact(
    rawTaskDefinitions.TenantDataBroker,
    new RegExp(
      `^arn:aws:ecs:ap-southeast-1:${expected.accountId}:task-definition/aeostudio-staging-tenant-data-broker:[1-9][0-9]*$`,
      'u',
    ),
    'STAGING_RELEASE_CONTRACT_TASK_DEFINITION_INVALID',
  );
  exact(
    rollback.TenantDataBroker,
    new RegExp(
      `^arn:aws:ecs:ap-southeast-1:${expected.accountId}:task-definition/aeostudio-staging-tenant-data-broker:[1-9][0-9]*$`,
      'u',
    ),
    'STAGING_RELEASE_CONTRACT_TASK_DEFINITION_INVALID',
  );
  taskDefinitions.migration = exact(
    rawTaskDefinitions.Migration,
    new RegExp(
      `^arn:aws:ecs:ap-southeast-1:${expected.accountId}:task-definition/aeostudio-staging-migration:[1-9][0-9]*$`,
      'u',
    ),
    'STAGING_RELEASE_CONTRACT_TASK_DEFINITION_INVALID',
  );
  return taskDefinitions;
}

function sameKeys(value, expected) {
  return Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
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
