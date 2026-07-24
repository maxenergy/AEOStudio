/* global process */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MAX_AGE_HOURS = 168;
const MAX_AGE_MS = MAX_AGE_HOURS * 60 * 60 * 1_000;

const RUN_CONTRACT = {
  build: {
    path: '.github/workflows/build-attest.yml',
    name: 'Build, attest and deploy staging',
    events: ['push', 'workflow_dispatch'],
  },
  plan: {
    path: '.github/workflows/verify.yml',
    name: 'Verify',
    events: ['push'],
  },
  acceptance: {
    path: '.github/workflows/staging-acceptance.yml',
    name: 'Prove immutable staging acceptance',
    events: ['workflow_dispatch'],
  },
  restore: {
    path: '.github/workflows/restore-drill.yml',
    name: 'Run the fixed private staging restore drill',
    events: ['workflow_dispatch'],
  },
};

export function validatePromotionControlPlane(input) {
  const repository = exact(input.repository, REPOSITORY, 'PROMOTION_REPOSITORY_INVALID');
  const sourceSha = exact(input.currentSourceSha, SHA, 'PROMOTION_SOURCE_SHA_INVALID');
  const expectedRunIds = object(input.expectedRunIds, 'PROMOTION_RUN_IDS_INVALID');
  const runsInput = object(input.runs, 'PROMOTION_RUNS_INVALID');
  const artifactsInput = object(input.artifacts, 'PROMOTION_ARTIFACTS_INVALID');
  const now = input.now instanceof Date ? input.now : new Date(input.now);
  if (!Number.isFinite(now.valueOf())) throw new Error('PROMOTION_CLOCK_INVALID');

  const runs = {};
  for (const kind of Object.keys(RUN_CONTRACT)) {
    runs[kind] = validateRun({
      kind,
      now,
      record: runsInput[kind],
      repository,
      sourceSha,
      expectedRunId: expectedRunIds[kind],
    });
  }
  if (
    new Date(runs.acceptance.startedAt).getTime() < new Date(runs.build.completedAt).getTime() ||
    new Date(runs.restore.startedAt).getTime() < new Date(runs.build.completedAt).getTime()
  ) {
    throw new Error('PROMOTION_RUN_ORDER_INVALID');
  }

  const artifacts = {
    releaseManifest: validateArtifact(
      artifactsInput.build,
      `release-digests-${runs.build.id}-${runs.build.attempt}`,
      runs.build,
      sourceSha,
    ),
    stagingRelease: validateArtifact(
      artifactsInput.build,
      `staging-release-contract-${runs.build.id}-${runs.build.attempt}`,
      runs.build,
      sourceSha,
    ),
    plan: validateArtifact(
      artifactsInput.plan,
      `staging-opentofu-plan-evidence-${runs.plan.id}-${runs.plan.attempt}`,
      runs.plan,
      sourceSha,
    ),
    acceptance: validateArtifact(
      artifactsInput.acceptance,
      `staging-acceptance-evidence-${runs.acceptance.id}-${runs.acceptance.attempt}`,
      runs.acceptance,
      sourceSha,
    ),
    restore: validateArtifact(
      artifactsInput.restore,
      `restore-drill-evidence-${runs.restore.id}-${runs.restore.attempt}`,
      runs.restore,
      sourceSha,
    ),
  };

  const core = {
    schemaVersion: 'aeostudio.github-promotion-control-plane.v1',
    repository,
    sourceSha,
    maxAgeHours: MAX_AGE_HOURS,
    runs,
    artifacts,
  };
  const controlPlaneSha256 = createHash('sha256').update(JSON.stringify(core)).digest('hex');
  if (
    input.expectedControlPlaneSha256 !== undefined &&
    exact(
      input.expectedControlPlaneSha256,
      SHA256,
      'PROMOTION_EXPECTED_CONTROL_PLANE_HASH_INVALID',
    ) !== controlPlaneSha256
  ) {
    throw new Error('PROMOTION_CONTROL_PLANE_HASH_MISMATCH');
  }
  return {
    ...core,
    controlPlaneSha256,
    validatedAt: now.toISOString(),
  };
}

function validateRun(input) {
  const record = object(input.record, 'PROMOTION_RUN_INVALID');
  const contract = RUN_CONTRACT[input.kind];
  const expectedRunId = exact(input.expectedRunId, POSITIVE_INTEGER, 'PROMOTION_RUN_ID_INVALID');
  const id = exact(String(record.id), POSITIVE_INTEGER, 'PROMOTION_RUN_ID_INVALID');
  const attempt = exact(
    String(record.run_attempt),
    POSITIVE_INTEGER,
    'PROMOTION_RUN_ATTEMPT_INVALID',
  );
  if (
    id !== expectedRunId ||
    record.status !== 'completed' ||
    record.conclusion !== 'success' ||
    record.head_branch !== 'main' ||
    record.path !== contract.path ||
    record.name !== contract.name ||
    !contract.events.includes(record.event) ||
    object(record.head_repository, 'PROMOTION_RUN_REPOSITORY_INVALID').full_name !==
      input.repository
  ) {
    throw new Error('PROMOTION_RUN_IDENTITY_MISMATCH');
  }
  if (record.head_sha !== input.sourceSha) throw new Error('PROMOTION_RUN_SOURCE_MISMATCH');
  const createdAt = timestamp(record.created_at, 'PROMOTION_RUN_TIMESTAMP_INVALID');
  const startedAt = timestamp(record.run_started_at, 'PROMOTION_RUN_TIMESTAMP_INVALID');
  const completedAt = timestamp(record.updated_at, 'PROMOTION_RUN_TIMESTAMP_INVALID');
  const created = new Date(createdAt).getTime();
  const started = new Date(startedAt).getTime();
  const completed = new Date(completedAt).getTime();
  if (created > started || started > completed) throw new Error('PROMOTION_RUN_TIME_INVALID');
  const age = input.now.getTime() - completed;
  if (age < 0) throw new Error('PROMOTION_RUN_TIME_INVALID');
  if (age > MAX_AGE_MS) throw new Error('PROMOTION_RUN_STALE');
  return { id, attempt, createdAt, startedAt, completedAt };
}

function validateArtifact(inventoryValue, expectedName, run, sourceSha) {
  const inventory = object(inventoryValue, 'PROMOTION_ARTIFACT_INVENTORY_INVALID');
  if (!Array.isArray(inventory.artifacts)) {
    throw new Error('PROMOTION_ARTIFACT_INVENTORY_INVALID');
  }
  const matches = inventory.artifacts.filter(
    (candidate) => objectOrNull(candidate)?.name === expectedName,
  );
  if (matches.length !== 1) throw new Error('PROMOTION_ARTIFACT_NOT_UNIQUE');
  const artifact = object(matches[0], 'PROMOTION_ARTIFACT_INVALID');
  const workflowRun = object(artifact.workflow_run, 'PROMOTION_ARTIFACT_RUN_INVALID');
  const id = exact(String(artifact.id), POSITIVE_INTEGER, 'PROMOTION_ARTIFACT_ID_INVALID');
  const digestWithPrefix = exact(
    artifact.digest,
    /^sha256:[0-9a-f]{64}$/u,
    'PROMOTION_ARTIFACT_DIGEST_INVALID',
  );
  const createdAt = timestamp(artifact.created_at, 'PROMOTION_ARTIFACT_TIMESTAMP_INVALID');
  const updatedAt = timestamp(artifact.updated_at, 'PROMOTION_ARTIFACT_TIMESTAMP_INVALID');
  if (
    artifact.expired !== false ||
    !Number.isInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes < 1 ||
    String(workflowRun.id) !== run.id ||
    workflowRun.head_sha !== sourceSha ||
    new Date(createdAt).getTime() < new Date(run.createdAt).getTime() ||
    new Date(createdAt).getTime() > new Date(updatedAt).getTime() ||
    new Date(updatedAt).getTime() > new Date(run.completedAt).getTime()
  ) {
    throw new Error('PROMOTION_ARTIFACT_IDENTITY_MISMATCH');
  }
  return {
    id,
    name: expectedName,
    digest: digestWithPrefix,
    createdAt,
    updatedAt,
  };
}

function timestamp(value, code) {
  if (typeof value !== 'string') throw new Error(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) throw new Error(code);
  return value;
}

function exact(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(code);
  return value;
}

function object(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value;
}

function objectOrNull(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

async function readJson(path, code) {
  try {
    return object(JSON.parse(await readFile(resolve(path), 'utf8')), code);
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    throw new Error(code, { cause: error });
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    const outputPath = resolve(requiredEnvironment('AEO_PROMOTION_CONTROL_PLANE_OUTPUT'));
    const evidence = validatePromotionControlPlane({
      repository: requiredEnvironment('GITHUB_REPOSITORY'),
      currentSourceSha: requiredEnvironment('CURRENT_SOURCE_SHA'),
      expectedRunIds: {
        build: requiredEnvironment('BUILD_RUN_ID'),
        plan: requiredEnvironment('PLAN_RUN_ID'),
        acceptance: requiredEnvironment('ACCEPTANCE_RUN_ID'),
        restore: requiredEnvironment('RESTORE_RUN_ID'),
      },
      now: new Date(),
      runs: {
        build: await readJson(requiredEnvironment('BUILD_RUN_PATH'), 'BUILD_RUN_INVALID'),
        plan: await readJson(requiredEnvironment('PLAN_RUN_PATH'), 'PLAN_RUN_INVALID'),
        acceptance: await readJson(
          requiredEnvironment('ACCEPTANCE_RUN_PATH'),
          'ACCEPTANCE_RUN_INVALID',
        ),
        restore: await readJson(requiredEnvironment('RESTORE_RUN_PATH'), 'RESTORE_RUN_INVALID'),
      },
      artifacts: {
        build: await readJson(
          requiredEnvironment('BUILD_ARTIFACTS_PATH'),
          'BUILD_ARTIFACTS_INVALID',
        ),
        plan: await readJson(requiredEnvironment('PLAN_ARTIFACTS_PATH'), 'PLAN_ARTIFACTS_INVALID'),
        acceptance: await readJson(
          requiredEnvironment('ACCEPTANCE_ARTIFACTS_PATH'),
          'ACCEPTANCE_ARTIFACTS_INVALID',
        ),
        restore: await readJson(
          requiredEnvironment('RESTORE_ARTIFACTS_PATH'),
          'RESTORE_ARTIFACTS_INVALID',
        ),
      },
      ...(process.env.EXPECTED_CONTROL_PLANE_SHA256?.trim()
        ? { expectedControlPlaneSha256: process.env.EXPECTED_CONTROL_PLANE_SHA256.trim() }
        : {}),
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(
      `${JSON.stringify({
        outcome: 'PASS',
        sourceSha: evidence.sourceSha,
        buildAttempt: evidence.runs.build.attempt,
        planAttempt: evidence.runs.plan.attempt,
        acceptanceAttempt: evidence.runs.acceptance.attempt,
        restoreAttempt: evidence.runs.restore.attempt,
        controlPlaneSha256: evidence.controlPlaneSha256,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'PROMOTION_CONTROL_PLANE_INVALID'}\n`,
    );
    process.exitCode = 1;
  }
}
