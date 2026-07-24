/* global process */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stagingBackendConfigSha256 } from './staging-backend-config.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const CROSS_REGION_RESOURCE_TYPES = new Set([
  'aws_db_instance_automated_backups_replication',
  'aws_docdb_global_cluster',
  'aws_dynamodb_table_replica',
  'aws_ecr_replication_configuration',
  'aws_elasticache_global_replication_group',
  'aws_kms_replica_external_key',
  'aws_kms_replica_key',
  'aws_neptune_global_cluster',
  'aws_rds_global_cluster',
  'aws_s3_bucket_replication_configuration',
]);
const FORBIDDEN_RESOURCE_PREFIXES = [
  'aws_eks_',
  'aws_elasticsearch_',
  'aws_opensearch_',
  'aws_opensearchserverless_',
];

export function createStagingPlanEvidence(input) {
  const identity = object(input.identity, 'PLAN_IDENTITY_INVALID');
  const plan = object(input.plan, 'PLAN_JSON_INVALID');
  const terraformSources = sources(input.terraformSources);
  const planBytes = Buffer.isBuffer(input.planBytes)
    ? input.planBytes
    : Buffer.from(input.planBytes ?? '');
  const planJsonBytes = Buffer.isBuffer(input.planJsonBytes)
    ? input.planJsonBytes
    : Buffer.from(JSON.stringify(plan));
  validateCreationIdentity(identity);
  if (
    planBytes.length === 0 ||
    plan.format_version === undefined ||
    !/^1\.[0-9]+$/u.test(String(plan.format_version)) ||
    plan.terraform_version !== '1.11.6' ||
    !Array.isArray(plan.resource_changes)
  ) {
    throw new Error('PLAN_JSON_INVALID');
  }

  const providerConfig = object(plan.configuration, 'PLAN_CONFIGURATION_INVALID').provider_config;
  const awsProviders = Object.values(
    object(providerConfig, 'PLAN_PROVIDER_CONFIGURATION_INVALID'),
  ).filter(
    (provider) =>
      provider?.name === 'aws' ||
      (typeof provider?.full_name === 'string' && provider.full_name.endsWith('/hashicorp/aws')),
  );
  const regionPassed =
    awsProviders.length > 0 &&
    awsProviders.every(
      (provider) => provider?.expressions?.region?.constant_value === identity.region,
    );
  const resourceChanges = Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
  const noCrossRegionReplica = !resourceChanges.some(isCrossRegionReplica);
  const noWildcardIam = !containsWildcardIamAction(terraformSources, resourceChanges);
  const noForbiddenResources = !containsForbiddenResource(terraformSources, resourceChanges);
  const violations = [];
  if (!regionPassed) violations.push('AWS_PROVIDER_REGION_INVALID');
  if (!noCrossRegionReplica) violations.push('CROSS_REGION_REPLICA_FORBIDDEN');
  if (!noWildcardIam) violations.push('IAM_ACTION_WILDCARD_FORBIDDEN');
  if (!noForbiddenResources) violations.push('FORBIDDEN_RESOURCE_TYPE');
  const policy = {
    schemaVersion: 'aeostudio.opentofu-static-policy.v1',
    decision: violations.length === 0 ? 'PASS' : 'FAIL',
    gates: {
      region: regionPassed ? 'PASS' : 'FAIL',
      noCrossRegionReplica: noCrossRegionReplica ? 'PASS' : 'FAIL',
      noWildcardIam: noWildcardIam ? 'PASS' : 'FAIL',
      forbiddenResources: noForbiddenResources ? 'PASS' : 'FAIL',
    },
    iacSourceSha256: terraformSourceSha256(terraformSources),
    evaluatedManagedResourceCount: resourceChanges.filter(
      (resource) => resource?.mode === 'managed',
    ).length,
    violations,
  };

  const changes = resourceChanges.map((resource) => ({
    address: resource.address,
    mode: resource.mode,
    type: resource.type,
    name: resource.name,
    providerName: resource.provider_name,
    actions: resource.change?.actions,
  }));
  return {
    schemaVersion: 'aeostudio.opentofu-plan-evidence.v2',
    status: policy.decision === 'PASS' ? 'SUCCEEDED' : 'FAILED',
    environment: identity.environment,
    region: identity.region,
    accountId: identity.accountId,
    repository: identity.repository,
    sourceRef: identity.sourceRef,
    sourceSha: identity.sourceSha,
    workflowPath: identity.workflowPath,
    workflowName: identity.workflowName,
    workflowRunId: identity.workflowRunId,
    workflowRunAttempt: identity.workflowRunAttempt,
    jobName: identity.jobName,
    createdAt: identity.createdAt,
    planRoleArn: identity.planRoleArn,
    callerArn: identity.callerArn,
    backendConfigSha256: identity.backendConfigSha256,
    tfvarsSha256: identity.tfvarsSha256,
    policySourceSha256: identity.policySourceSha256,
    tofuVersion: identity.tofuVersion,
    planFormatVersion: plan.format_version,
    planExitCode: identity.planExitCode,
    planSha256: createHash('sha256').update(planBytes).digest('hex'),
    planJsonSha256: createHash('sha256').update(planJsonBytes).digest('hex'),
    changesSha256: jsonSha256(changes),
    policySha256: jsonSha256(policy),
    policy,
    changes,
  };
}

export function validateStagingPlanEvidence(input) {
  const evidence = object(input.evidence, 'PLAN_EVIDENCE_INVALID');
  const expected = object(input.expected, 'PLAN_EXPECTED_IDENTITY_INVALID');
  exact(expected.sourceSha, SHA, 'SOURCE_SHA_INVALID');
  exact(expected.accountId, ACCOUNT_ID, 'AWS_ACCOUNT_ID_INVALID');
  exact(expected.repository, REPOSITORY, 'REPOSITORY_INVALID');
  exact(expected.workflowRunId, POSITIVE_INTEGER, 'PLAN_RUN_ID_INVALID');
  exact(expected.workflowRunAttempt, POSITIVE_INTEGER, 'PLAN_RUN_ATTEMPT_INVALID');
  exact(expected.iacSourceSha256, SHA256, 'IAC_SOURCE_SHA256_INVALID');
  if (expected.region !== 'ap-southeast-1') throw new Error('AWS_REGION_INVALID');

  if (
    !sameStringSet(Object.keys(evidence), [
      'accountId',
      'backendConfigSha256',
      'callerArn',
      'changes',
      'changesSha256',
      'createdAt',
      'environment',
      'jobName',
      'planExitCode',
      'planFormatVersion',
      'planJsonSha256',
      'planRoleArn',
      'planSha256',
      'policy',
      'policySha256',
      'policySourceSha256',
      'region',
      'repository',
      'schemaVersion',
      'sourceRef',
      'sourceSha',
      'status',
      'tfvarsSha256',
      'tofuVersion',
      'workflowName',
      'workflowPath',
      'workflowRunAttempt',
      'workflowRunId',
    ]) ||
    typeof evidence.planFormatVersion !== 'string' ||
    !/^1\.[0-9]+$/u.test(evidence.planFormatVersion) ||
    !Array.isArray(evidence.changes)
  ) {
    throw new Error('PLAN_EVIDENCE_SCHEMA_INVALID');
  }
  validateChanges(evidence.changes);
  timestamp(evidence.createdAt, 'PLAN_CREATED_AT_INVALID');
  validatePlanCallerIdentity(evidence, expected.accountId, expected.workflowRunId);

  if (
    evidence.schemaVersion !== 'aeostudio.opentofu-plan-evidence.v2' ||
    evidence.status !== 'SUCCEEDED' ||
    evidence.environment !== 'staging' ||
    evidence.region !== expected.region ||
    evidence.accountId !== expected.accountId ||
    evidence.repository !== expected.repository ||
    evidence.sourceRef !== 'refs/heads/main' ||
    evidence.sourceSha !== expected.sourceSha ||
    evidence.workflowPath !== '.github/workflows/verify.yml' ||
    evidence.workflowName !== 'Verify' ||
    evidence.workflowRunId !== expected.workflowRunId ||
    evidence.workflowRunAttempt !== expected.workflowRunAttempt ||
    evidence.jobName !== 'Trusted staging OpenTofu plan evidence' ||
    evidence.tofuVersion !== 'OpenTofu v1.11.6' ||
    ![0, 2].includes(evidence.planExitCode) ||
    !SHA256.test(String(evidence.planSha256)) ||
    !SHA256.test(String(evidence.planJsonSha256)) ||
    !SHA256.test(String(evidence.backendConfigSha256)) ||
    (expected.backendConfigSha256 !== undefined &&
      evidence.backendConfigSha256 !==
        exact(expected.backendConfigSha256, SHA256, 'BACKEND_CONFIG_SHA256_INVALID')) ||
    !SHA256.test(String(evidence.tfvarsSha256)) ||
    !SHA256.test(String(evidence.policySourceSha256)) ||
    (expected.policySourceSha256 !== undefined &&
      evidence.policySourceSha256 !==
        exact(expected.policySourceSha256, SHA256, 'POLICY_SOURCE_SHA256_INVALID'))
  ) {
    throw new Error('PLAN_EVIDENCE_IDENTITY_MISMATCH');
  }

  const policy = object(evidence.policy, 'PLAN_POLICY_INVALID');
  if (
    evidence.changesSha256 !== jsonSha256(evidence.changes) ||
    evidence.policySha256 !== jsonSha256(policy)
  ) {
    throw new Error('PLAN_REDACTED_BINDING_MISMATCH');
  }
  const gates = object(policy.gates, 'PLAN_POLICY_INVALID');
  if (
    !sameStringSet(Object.keys(policy), [
      'decision',
      'evaluatedManagedResourceCount',
      'gates',
      'iacSourceSha256',
      'schemaVersion',
      'violations',
    ]) ||
    !sameStringSet(Object.keys(gates), [
      'forbiddenResources',
      'noCrossRegionReplica',
      'noWildcardIam',
      'region',
    ]) ||
    policy.schemaVersion !== 'aeostudio.opentofu-static-policy.v1' ||
    policy.decision !== 'PASS' ||
    policy.iacSourceSha256 !== expected.iacSourceSha256 ||
    !Number.isInteger(policy.evaluatedManagedResourceCount) ||
    policy.evaluatedManagedResourceCount < 0 ||
    policy.evaluatedManagedResourceCount !==
      evidence.changes.filter((change) => change.mode === 'managed').length ||
    gates.region !== 'PASS' ||
    gates.noCrossRegionReplica !== 'PASS' ||
    gates.noWildcardIam !== 'PASS' ||
    gates.forbiddenResources !== 'PASS' ||
    !Array.isArray(policy.violations) ||
    policy.violations.length !== 0
  ) {
    throw new Error('PLAN_POLICY_NOT_PASS');
  }
}

export function terraformSourceSha256(terraformSources) {
  const hash = createHash('sha256');
  for (const source of sources(terraformSources)) {
    hash.update(source.path.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(source.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function readTerraformSources(iacRoot) {
  const root = resolve(iacRoot);
  const files = [];
  await visit(root);
  if (files.length === 0) throw new Error('IAC_SOURCES_INVALID');
  return sources(files);

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.terraform') await visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.tf')) continue;
      files.push({
        path: relative(process.cwd(), path).replaceAll('\\', '/'),
        content: await readFile(path, 'utf8'),
      });
    }
  }
}

function isCrossRegionReplica(resource) {
  if (resource?.mode !== 'managed' || resource?.change?.after === null) return false;
  if (CROSS_REGION_RESOURCE_TYPES.has(resource.type)) return true;
  const after = resource?.change?.after ?? {};
  const unknown = resource?.change?.after_unknown ?? {};
  if (resource.type === 'aws_db_instance') {
    return nonEmpty(after.replicate_source_db) || unknown.replicate_source_db === true;
  }
  if (resource.type === 'aws_rds_cluster') {
    return (
      nonEmpty(after.replication_source_identifier) ||
      nonEmpty(after.global_cluster_identifier) ||
      unknown.replication_source_identifier === true ||
      unknown.global_cluster_identifier === true
    );
  }
  if (resource.type === 'aws_dynamodb_table') {
    return (
      (Array.isArray(after.replica) && after.replica.length > 0) ||
      unknown.replica === true ||
      (Array.isArray(unknown.replica) && unknown.replica.length > 0)
    );
  }
  return false;
}

function containsWildcardIamAction(terraformSources, resourceChanges) {
  const actionAssignment =
    /(?:\bactions\b|["']Action["'])\s*(?:=|:)\s*(\[[\s\S]*?\]|"[^"]*"|'[^']*')/giu;
  for (const source of terraformSources) {
    for (const match of source.content.matchAll(actionAssignment)) {
      const actionValues = [...match[1].matchAll(/["']([^"']+)["']/gu)].map((value) => value[1]);
      if (actionValues.some(isBroadWildcardAction)) return true;
    }
  }

  for (const resource of resourceChanges) {
    const after = resource?.change?.after;
    if (after === null || typeof after !== 'object' || Array.isArray(after)) continue;
    for (const field of ['policy', 'assume_role_policy']) {
      const policy = after[field];
      if (typeof policy !== 'string') continue;
      try {
        if (jsonPolicyHasWildcardAction(JSON.parse(policy))) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

function containsForbiddenResource(terraformSources, resourceChanges) {
  if (
    resourceChanges.some(
      (resource) =>
        resource?.mode === 'managed' &&
        resource?.change?.after !== null &&
        typeof resource?.type === 'string' &&
        FORBIDDEN_RESOURCE_PREFIXES.some((prefix) => resource.type.startsWith(prefix)),
    )
  ) {
    return true;
  }
  const declaration = /\bresource\s+"([^"]+)"/gu;
  return terraformSources.some((source) =>
    [...source.content.matchAll(declaration)].some((match) =>
      FORBIDDEN_RESOURCE_PREFIXES.some((prefix) => match[1].startsWith(prefix)),
    ),
  );
}

function jsonPolicyHasWildcardAction(policy) {
  const statements = Array.isArray(policy?.Statement) ? policy.Statement : [policy?.Statement];
  return statements.some((statement) => {
    const actions = Array.isArray(statement?.Action) ? statement.Action : [statement?.Action];
    return actions.some((action) => typeof action === 'string' && isBroadWildcardAction(action));
  });
}

function isBroadWildcardAction(action) {
  return action === '*' || /^[A-Za-z0-9-]+:\*$/u.test(action);
}

function nonEmpty(value) {
  return value !== undefined && value !== null && value !== '';
}

function validateChanges(changes) {
  const addresses = new Set();
  const allowedActions = new Set(['create', 'delete', 'forget', 'no-op', 'read', 'update']);
  for (const change of changes) {
    const value = object(change, 'PLAN_CHANGE_INVALID');
    if (
      !sameStringSet(Object.keys(value), [
        'actions',
        'address',
        'mode',
        'name',
        'providerName',
        'type',
      ]) ||
      !safeString(value.address, 512) ||
      addresses.has(value.address) ||
      !['data', 'managed'].includes(value.mode) ||
      !safeString(value.type, 256) ||
      !safeString(value.name, 256) ||
      !safeString(value.providerName, 512) ||
      !Array.isArray(value.actions) ||
      value.actions.length === 0 ||
      value.actions.some((action) => !allowedActions.has(action))
    ) {
      throw new Error('PLAN_CHANGE_INVALID');
    }
    addresses.add(value.address);
  }
}

function safeString(value, maximumLength) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\r\n\0]/u.test(value)
  );
}

function sameStringSet(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function sources(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('IAC_SOURCES_INVALID');
  return value
    .map((source) => {
      const candidate = object(source, 'IAC_SOURCE_INVALID');
      if (typeof candidate.path !== 'string' || typeof candidate.content !== 'string') {
        throw new Error('IAC_SOURCE_INVALID');
      }
      return { path: candidate.path, content: candidate.content };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function validateCreationIdentity(identity) {
  if (
    typeof identity.accountId !== 'string' ||
    !ACCOUNT_ID.test(identity.accountId) ||
    identity.environment !== 'staging' ||
    typeof identity.createdAt !== 'string' ||
    !isTimestamp(identity.createdAt) ||
    typeof identity.backendConfigSha256 !== 'string' ||
    !SHA256.test(identity.backendConfigSha256) ||
    typeof identity.tfvarsSha256 !== 'string' ||
    !SHA256.test(identity.tfvarsSha256) ||
    typeof identity.policySourceSha256 !== 'string' ||
    !SHA256.test(identity.policySourceSha256) ||
    identity.jobName !== 'Trusted staging OpenTofu plan evidence' ||
    ![0, 2].includes(identity.planExitCode) ||
    identity.region !== 'ap-southeast-1' ||
    typeof identity.repository !== 'string' ||
    !REPOSITORY.test(identity.repository) ||
    identity.sourceRef !== 'refs/heads/main' ||
    typeof identity.sourceSha !== 'string' ||
    !SHA.test(identity.sourceSha) ||
    identity.tofuVersion !== 'OpenTofu v1.11.6' ||
    identity.workflowName !== 'Verify' ||
    identity.workflowPath !== '.github/workflows/verify.yml' ||
    typeof identity.workflowRunAttempt !== 'string' ||
    !POSITIVE_INTEGER.test(identity.workflowRunAttempt) ||
    typeof identity.workflowRunId !== 'string' ||
    !POSITIVE_INTEGER.test(identity.workflowRunId)
  ) {
    throw new Error('PLAN_IDENTITY_INVALID');
  }
  validatePlanCallerIdentity(identity, identity.accountId, identity.workflowRunId);
}

function validatePlanCallerIdentity(value, accountId, workflowRunId) {
  const roleArn = `arn:aws:iam::${accountId}:role/aeostudio-staging-plan`;
  if (value.planRoleArn !== roleArn) {
    throw new Error('PLAN_CALLER_IDENTITY_INVALID');
  }
  const callerArn =
    `arn:aws:sts::${accountId}:assumed-role/aeostudio-staging-plan/` +
    `aeostudio-staging-plan-${workflowRunId}`;
  if (value.callerArn !== callerArn) throw new Error('PLAN_CALLER_IDENTITY_INVALID');
}

function jsonSha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function timestamp(value, errorCode) {
  if (!isTimestamp(value)) throw new Error(errorCode);
  return value;
}

function isTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
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

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    const options = parseOptions(process.argv.slice(3));
    if (command === 'create') {
      const evidence = await createFromFiles(options);
      process.stdout.write(
        `${JSON.stringify({ decision: evidence.policy.decision, status: evidence.status })}\n`,
      );
      if (evidence.status !== 'SUCCEEDED') process.exitCode = 1;
    } else if (command === 'validate') {
      await validateFromFiles(options);
      process.stdout.write(`${JSON.stringify({ outcome: 'PASS' })}\n`);
    } else {
      throw new Error('PLAN_EVIDENCE_COMMAND_INVALID');
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'PLAN_EVIDENCE_FAILED'}\n`);
    process.exitCode = 1;
  }
}

async function createFromFiles(options) {
  const planJsonPath = requiredOption(options, 'plan-json');
  const planBinaryPath = requiredOption(options, 'plan-binary');
  const iacRoot = requiredOption(options, 'iac-root');
  const outputPath = requiredOption(options, 'output');
  let plan;
  let planJsonBytes;
  try {
    planJsonBytes = await readFile(resolve(planJsonPath));
    plan = JSON.parse(planJsonBytes.toString('utf8'));
  } catch (error) {
    throw new Error('PLAN_JSON_INVALID', { cause: error });
  }
  const identity = {
    accountId: requiredEnvironment('AEO_PLAN_ACCOUNT_ID'),
    backendConfigSha256: requiredEnvironment('AEO_PLAN_BACKEND_CONFIG_SHA256'),
    callerArn: requiredEnvironment('AEO_PLAN_CALLER_ARN'),
    createdAt: requiredEnvironment('AEO_PLAN_CREATED_AT'),
    environment: 'staging',
    jobName: 'Trusted staging OpenTofu plan evidence',
    planExitCode: Number(requiredEnvironment('AEO_PLAN_EXIT_CODE')),
    planRoleArn: requiredEnvironment('AEO_PLAN_ROLE_ARN'),
    policySourceSha256: createHash('sha256')
      .update(await readFile(fileURLToPath(import.meta.url)))
      .digest('hex'),
    region: requiredEnvironment('AWS_REGION'),
    repository: requiredEnvironment('GITHUB_REPOSITORY'),
    sourceRef: requiredEnvironment('GITHUB_REF'),
    sourceSha: requiredEnvironment('GITHUB_SHA'),
    tofuVersion: requiredEnvironment('AEO_PLAN_TOFU_VERSION'),
    tfvarsSha256: requiredEnvironment('AEO_PLAN_TFVARS_SHA256'),
    workflowName: requiredEnvironment('GITHUB_WORKFLOW'),
    workflowPath: '.github/workflows/verify.yml',
    workflowRunAttempt: requiredEnvironment('GITHUB_RUN_ATTEMPT'),
    workflowRunId: requiredEnvironment('GITHUB_RUN_ID'),
  };
  const evidence = createStagingPlanEvidence({
    identity,
    plan,
    planBytes: await readFile(resolve(planBinaryPath)),
    planJsonBytes,
    terraformSources: await readTerraformSources(iacRoot),
  });
  await writeFile(resolve(outputPath), `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return evidence;
}

async function validateFromFiles(options) {
  const evidencePath = requiredOption(options, 'evidence');
  const iacRoot = requiredOption(options, 'iac-root');
  let evidence;
  try {
    evidence = JSON.parse(await readFile(resolve(evidencePath), 'utf8'));
  } catch (error) {
    throw new Error('PLAN_EVIDENCE_INVALID', { cause: error });
  }
  const terraformSources = await readTerraformSources(iacRoot);
  validateStagingPlanEvidence({
    evidence,
    expected: {
      accountId: requiredEnvironment('AEO_PLAN_EXPECTED_ACCOUNT_ID'),
      backendConfigSha256: stagingBackendConfigSha256(
        requiredEnvironment('AEO_PLAN_EXPECTED_BACKEND_BUCKET'),
      ),
      iacSourceSha256: terraformSourceSha256(terraformSources),
      policySourceSha256: createHash('sha256')
        .update(await readFile(fileURLToPath(import.meta.url)))
        .digest('hex'),
      region: requiredEnvironment('AWS_REGION'),
      repository: requiredEnvironment('GITHUB_REPOSITORY'),
      sourceSha: requiredEnvironment('AEO_PLAN_EXPECTED_SOURCE_SHA'),
      workflowRunAttempt: requiredEnvironment('AEO_PLAN_EXPECTED_RUN_ATTEMPT'),
      workflowRunId: requiredEnvironment('AEO_PLAN_EXPECTED_RUN_ID'),
    },
  });
}

function parseOptions(values) {
  const options = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('PLAN_EVIDENCE_OPTIONS_INVALID');
    }
    const key = name.slice(2);
    if (options.has(key)) throw new Error('PLAN_EVIDENCE_OPTIONS_INVALID');
    options.set(key, value);
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`PLAN_EVIDENCE_${name.replaceAll('-', '_').toUpperCase()}_REQUIRED`);
  }
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
