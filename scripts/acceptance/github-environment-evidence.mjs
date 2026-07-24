/* global process */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const SAFE_REVIEWER_NAME = /^[A-Za-z0-9_.-]+$/u;
const API_VERSION = '2026-03-10';
const DEPLOY_JOB_NAME = 'Deploy exact digests to synthetic staging';

export async function collectGitHubEnvironmentEvidence(input) {
  const expected = validateExpected({
    repository: input.repository,
    sourceSha: input.sourceSha,
    buildRunId: input.buildRunId,
    buildRunAttempt: input.buildRunAttempt,
    stagingUrl: input.expectedStagingUrl,
  });
  if (typeof input.runApi !== 'function') {
    throw new Error('GITHUB_ENVIRONMENT_COLLECTOR_INVALID');
  }

  const environment = await input.runApi(`/repos/${expected.repository}/environments/production`);
  const branchPolicies = await input.runApi(
    `/repos/${expected.repository}/environments/production/deployment-branch-policies?per_page=100`,
  );
  const buildJobs = await input.runApi(
    `/repos/${expected.repository}/actions/runs/${expected.buildRunId}/attempts/${expected.buildRunAttempt}/jobs?per_page=100`,
  );
  const deploymentInventory = await input.runApi(
    `/repos/${expected.repository}/deployments?sha=${expected.sourceSha}&environment=staging&per_page=100`,
  );
  if (!Array.isArray(deploymentInventory)) {
    throw new Error('GITHUB_STAGING_DEPLOYMENT_INVENTORY_INVALID');
  }
  if (deploymentInventory.length === 100) {
    throw new Error('GITHUB_STAGING_DEPLOYMENT_INVENTORY_TRUNCATED');
  }
  const deployments = [];
  for (const deployment of deploymentInventory) {
    const record = object(deployment, 'GITHUB_STAGING_DEPLOYMENT_INVALID');
    const deploymentId = positiveInteger(String(record.id), 'GITHUB_STAGING_DEPLOYMENT_INVALID');
    const statuses = await input.runApi(
      `/repos/${expected.repository}/deployments/${deploymentId}/statuses?per_page=100`,
    );
    if (!Array.isArray(statuses)) {
      throw new Error('GITHUB_STAGING_DEPLOYMENT_STATUS_INVENTORY_INVALID');
    }
    if (statuses.length === 100) {
      throw new Error('GITHUB_STAGING_DEPLOYMENT_STATUS_INVENTORY_TRUNCATED');
    }
    deployments.push({ deployment: record, statuses });
  }

  return validateGitHubEnvironmentEvidence({
    environment,
    branchPolicies,
    buildJobs,
    deployments,
    now: input.now,
    expected,
    ...(input.expectedEvidenceSha256 === undefined
      ? {}
      : { expectedEvidenceSha256: input.expectedEvidenceSha256 }),
  });
}

export function validateGitHubEnvironmentEvidence(input) {
  const expected = validateExpected(input.expected);
  const validatedAt = apiTimestamp(
    input.now,
    'GITHUB_ENVIRONMENT_VALIDATION_TIME_INVALID',
  ).canonical;
  const production = validateProductionEnvironment({
    environment: input.environment,
    branchPolicies: input.branchPolicies,
  });
  const buildJob = validateBuildJob(input.buildJobs, expected);
  const stagingDeployment = validateStagingDeployment({
    deployments: input.deployments,
    expected,
    buildJob,
  });
  const core = {
    schemaVersion: 'aeostudio.github-environment-evidence.v1',
    repository: expected.repository,
    sourceSha: expected.sourceSha,
    production,
    stagingDeployment,
  };
  const evidenceSha256 = createHash('sha256').update(JSON.stringify(core)).digest('hex');
  if (
    input.expectedEvidenceSha256 !== undefined &&
    exact(input.expectedEvidenceSha256, SHA256, 'GITHUB_ENVIRONMENT_EXPECTED_HASH_INVALID') !==
      evidenceSha256
  ) {
    throw new Error('GITHUB_ENVIRONMENT_EVIDENCE_HASH_MISMATCH');
  }
  return { ...core, evidenceSha256, validatedAt };
}

function validateExpected(value) {
  const expected = object(value, 'GITHUB_ENVIRONMENT_EXPECTED_IDENTITY_INVALID');
  return {
    repository: exact(expected.repository, REPOSITORY, 'GITHUB_ENVIRONMENT_REPOSITORY_INVALID'),
    sourceSha: exact(expected.sourceSha, SHA, 'GITHUB_ENVIRONMENT_SOURCE_SHA_INVALID'),
    buildRunId: positiveInteger(expected.buildRunId, 'GITHUB_ENVIRONMENT_BUILD_RUN_ID_INVALID'),
    buildRunAttempt: positiveInteger(
      expected.buildRunAttempt,
      'GITHUB_ENVIRONMENT_BUILD_RUN_ATTEMPT_INVALID',
    ),
    stagingUrl: exactRootHttpsUrl(expected.stagingUrl, 'GITHUB_ENVIRONMENT_STAGING_URL_INVALID'),
  };
}

function validateProductionEnvironment(input) {
  const environment = object(input.environment, 'GITHUB_PRODUCTION_ENVIRONMENT_INVALID');
  if (environment.name !== 'production' || !Array.isArray(environment.protection_rules)) {
    throw new Error('GITHUB_PRODUCTION_ENVIRONMENT_INVALID');
  }
  const reviewerRules = environment.protection_rules.filter(
    (rule) => objectOrNull(rule)?.type === 'required_reviewers',
  );
  if (reviewerRules.length !== 1) {
    throw new Error('GITHUB_PRODUCTION_REQUIRED_REVIEWERS_INVALID');
  }
  const reviewerRule = object(reviewerRules[0], 'GITHUB_PRODUCTION_REQUIRED_REVIEWERS_INVALID');
  if (reviewerRule.prevent_self_review !== true) {
    throw new Error('GITHUB_PRODUCTION_PREVENT_SELF_REVIEW_INVALID');
  }
  if (
    !Array.isArray(reviewerRule.reviewers) ||
    reviewerRule.reviewers.length < 1 ||
    reviewerRule.reviewers.length > 6
  ) {
    throw new Error('GITHUB_PRODUCTION_REQUIRED_REVIEWERS_INVALID');
  }
  const requiredReviewers = reviewerRule.reviewers
    .map((entry) => validateReviewer(entry))
    .sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
  if (
    new Set(requiredReviewers.map((reviewer) => `${reviewer.type}:${reviewer.id}`)).size !==
    requiredReviewers.length
  ) {
    throw new Error('GITHUB_PRODUCTION_REQUIRED_REVIEWERS_INVALID');
  }

  const branchRules = environment.protection_rules.filter(
    (rule) => objectOrNull(rule)?.type === 'branch_policy',
  );
  const deploymentPolicy = object(
    environment.deployment_branch_policy,
    'GITHUB_PRODUCTION_BRANCH_POLICY_INVALID',
  );
  const branchPolicies = object(input.branchPolicies, 'GITHUB_PRODUCTION_BRANCH_POLICY_INVALID');
  if (
    branchRules.length !== 1 ||
    deploymentPolicy.protected_branches !== false ||
    deploymentPolicy.custom_branch_policies !== true ||
    branchPolicies.total_count !== 1 ||
    !Array.isArray(branchPolicies.branch_policies) ||
    branchPolicies.branch_policies.length !== 1
  ) {
    throw new Error('GITHUB_PRODUCTION_BRANCH_POLICY_INVALID');
  }
  const branch = object(
    branchPolicies.branch_policies[0],
    'GITHUB_PRODUCTION_BRANCH_POLICY_INVALID',
  );
  if (
    branch.name !== 'main' ||
    (branch.type !== undefined && branch.type !== 'branch') ||
    !POSITIVE_INTEGER.test(String(branch.id))
  ) {
    throw new Error('GITHUB_PRODUCTION_BRANCH_POLICY_INVALID');
  }
  return {
    environment: 'production',
    preventSelfReview: true,
    requiredReviewers,
    deploymentBranches: ['main'],
  };
}

function validateReviewer(value) {
  const entry = object(value, 'GITHUB_PRODUCTION_REQUIRED_REVIEWERS_INVALID');
  if (entry.type !== 'User' && entry.type !== 'Team') {
    throw new Error('GITHUB_PRODUCTION_REQUIRED_REVIEWERS_INVALID');
  }
  const reviewer = object(entry.reviewer, 'GITHUB_PRODUCTION_REQUIRED_REVIEWERS_INVALID');
  const id = positiveInteger(String(reviewer.id), 'GITHUB_PRODUCTION_REQUIRED_REVIEWERS_INVALID');
  const key = entry.type === 'Team' ? 'slug' : 'login';
  const identity = exact(
    reviewer[key],
    SAFE_REVIEWER_NAME,
    'GITHUB_PRODUCTION_REQUIRED_REVIEWERS_INVALID',
  );
  return entry.type === 'Team'
    ? { type: 'Team', id, slug: identity }
    : { type: 'User', id, login: identity };
}

function validateBuildJob(value, expected) {
  const inventory = object(value, 'GITHUB_BUILD_JOBS_INVALID');
  if (!Array.isArray(inventory.jobs)) throw new Error('GITHUB_BUILD_JOBS_INVALID');
  const matches = inventory.jobs.filter(
    (candidate) => objectOrNull(candidate)?.name === DEPLOY_JOB_NAME,
  );
  if (matches.length !== 1) throw new Error('GITHUB_STAGING_DEPLOY_JOB_NOT_UNIQUE');
  const job = object(matches[0], 'GITHUB_STAGING_DEPLOY_JOB_INVALID');
  const id = positiveInteger(String(job.id), 'GITHUB_STAGING_DEPLOY_JOB_INVALID');
  const expectedUrl = `https://github.com/${expected.repository}/actions/runs/${expected.buildRunId}/job/${id}`;
  if (
    String(job.run_id) !== expected.buildRunId ||
    String(job.run_attempt) !== expected.buildRunAttempt ||
    job.head_sha !== expected.sourceSha ||
    job.status !== 'completed' ||
    job.conclusion !== 'success' ||
    job.html_url !== expectedUrl
  ) {
    throw new Error('GITHUB_STAGING_DEPLOY_JOB_INVALID');
  }
  return { id, url: expectedUrl };
}

function validateStagingDeployment(input) {
  if (!Array.isArray(input.deployments)) {
    throw new Error('GITHUB_STAGING_DEPLOYMENT_INVENTORY_INVALID');
  }
  const candidates = [];
  for (const item of input.deployments) {
    const aggregate = object(item, 'GITHUB_STAGING_DEPLOYMENT_INVALID');
    const deployment = object(aggregate.deployment, 'GITHUB_STAGING_DEPLOYMENT_INVALID');
    if (!Array.isArray(aggregate.statuses)) {
      throw new Error('GITHUB_STAGING_DEPLOYMENT_STATUS_INVENTORY_INVALID');
    }
    const app = objectOrNull(deployment.performed_via_github_app);
    if (
      deployment.ref !== 'main' ||
      deployment.sha !== input.expected.sourceSha ||
      deployment.task !== 'deploy' ||
      deployment.environment !== 'staging' ||
      deployment.transient_environment !== false ||
      deployment.production_environment !== false ||
      app?.slug !== 'github-actions'
    ) {
      continue;
    }
    const deploymentId = positiveInteger(
      String(deployment.id),
      'GITHUB_STAGING_DEPLOYMENT_INVALID',
    );
    const normalizedStatuses = aggregate.statuses.map((statusValue) => {
      const status = object(statusValue, 'GITHUB_STAGING_DEPLOYMENT_STATUS_INVALID');
      const id = positiveInteger(String(status.id), 'GITHUB_STAGING_DEPLOYMENT_STATUS_INVALID');
      const createdAt = apiTimestamp(status.created_at, 'GITHUB_STAGING_DEPLOYMENT_STATUS_INVALID');
      const updatedAt = apiTimestamp(status.updated_at, 'GITHUB_STAGING_DEPLOYMENT_STATUS_INVALID');
      if (updatedAt.milliseconds < createdAt.milliseconds) {
        throw new Error('GITHUB_STAGING_DEPLOYMENT_STATUS_INVALID');
      }
      return { status, id, createdAt };
    });
    if (
      normalizedStatuses.length === 0 ||
      new Set(normalizedStatuses.map((status) => status.id)).size !== normalizedStatuses.length
    ) {
      throw new Error('GITHUB_STAGING_DEPLOYMENT_STATUS_INVALID');
    }
    normalizedStatuses.sort((left, right) => {
      const timeOrder = right.createdAt.milliseconds - left.createdAt.milliseconds;
      if (timeOrder !== 0) return timeOrder;
      const leftId = BigInt(left.id);
      const rightId = BigInt(right.id);
      return rightId > leftId ? 1 : rightId < leftId ? -1 : 0;
    });
    const latest = normalizedStatuses[0];
    if (
      latest.status.state === 'success' &&
      latest.status.environment === 'staging' &&
      latest.status.environment_url === input.expected.stagingUrl &&
      latest.status.log_url === input.buildJob.url
    ) {
      candidates.push({
        deploymentId,
        statusId: latest.id,
        statusCreatedAt: latest.createdAt.canonical,
      });
    }
  }
  if (candidates.length !== 1) {
    throw new Error('GITHUB_STAGING_DEPLOYMENT_NOT_UNIQUE');
  }
  return {
    environment: 'staging',
    environmentUrl: input.expected.stagingUrl,
    buildRunId: input.expected.buildRunId,
    buildRunAttempt: input.expected.buildRunAttempt,
    jobId: input.buildJob.id,
    deploymentId: candidates[0].deploymentId,
    statusId: candidates[0].statusId,
    statusCreatedAt: candidates[0].statusCreatedAt,
  };
}

function githubApi(path) {
  const result = spawnSync(
    'gh',
    [
      'api',
      '--method',
      'GET',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      `X-GitHub-Api-Version: ${API_VERSION}`,
      path,
    ],
    {
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(`GITHUB_API_REQUEST_FAILED:${path}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`GITHUB_API_RESPONSE_INVALID:${path}`, { cause: error });
  }
}

function exactRootHttpsUrl(value, code) {
  if (typeof value !== 'string' || value.length === 0 || value.endsWith('/')) {
    throw new Error(code);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(code);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.pathname !== '/' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(code);
  }
  return value;
}

function positiveInteger(value, code) {
  return exact(value, POSITIVE_INTEGER, code);
}

function apiTimestamp(value, code) {
  if (
    typeof value !== 'string' ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/u.test(value)
  ) {
    throw new Error(code);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) throw new Error(code);
  return { milliseconds: parsed.getTime(), canonical: parsed.toISOString() };
}

function exact(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(code);
  return value;
}

function object(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(code);
  }
  return value;
}

function objectOrNull(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value || /[\r\n]/u.test(value)) throw new Error(`${name}_REQUIRED`);
  return value;
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    requiredEnvironment('GH_TOKEN');
    const now = new Date().toISOString();
    const outputPath = resolve(requiredEnvironment('AEO_GITHUB_ENVIRONMENT_EVIDENCE_OUTPUT'));
    const result = await collectGitHubEnvironmentEvidence({
      repository: requiredEnvironment('GITHUB_REPOSITORY'),
      sourceSha: requiredEnvironment('CURRENT_SOURCE_SHA'),
      buildRunId: requiredEnvironment('BUILD_RUN_ID'),
      buildRunAttempt: requiredEnvironment('BUILD_RUN_ATTEMPT'),
      expectedStagingUrl: requiredEnvironment('AEO_GITHUB_EXPECTED_STAGING_URL'),
      now,
      runApi: async (path) => githubApi(path),
      ...(process.env.EXPECTED_GITHUB_ENVIRONMENT_EVIDENCE_SHA256?.trim()
        ? {
            expectedEvidenceSha256: process.env.EXPECTED_GITHUB_ENVIRONMENT_EVIDENCE_SHA256.trim(),
          }
        : {}),
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(
      `${JSON.stringify({
        outcome: 'PASS',
        evidenceSha256: result.evidenceSha256,
        validatedAt: result.validatedAt,
        productionEnvironment: result.production.environment,
        stagingDeploymentId: result.stagingDeployment.deploymentId,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'GITHUB_ENVIRONMENT_EVIDENCE_INVALID'}\n`,
    );
    process.exitCode = 1;
  }
}
