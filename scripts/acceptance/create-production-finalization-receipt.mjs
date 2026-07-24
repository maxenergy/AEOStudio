/* global process */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateGitHubEnvironmentEvidenceHash,
  validatePromotionControlPlaneEvidenceHash,
} from './validate-production-finalization-evidence.mjs';
import { selectProductionTerminalRelease } from './select-production-terminal-release.mjs';

const ACCOUNT_ID = /^[0-9]{12}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export function createProductionFinalizationReceipt(input) {
  const value = object(input, 'PRODUCTION_FINALIZATION_RECEIPT_INVALID');
  const accountId = exact(
    value.accountId,
    ACCOUNT_ID,
    'PRODUCTION_FINALIZATION_RECEIPT_IDENTITY_INVALID',
  );
  const region =
    value.region === 'ap-southeast-1'
      ? value.region
      : fail('PRODUCTION_FINALIZATION_RECEIPT_IDENTITY_INVALID');
  const repository = exact(
    value.repository,
    REPOSITORY,
    'PRODUCTION_FINALIZATION_RECEIPT_IDENTITY_INVALID',
  );
  const sourceSha = exact(value.sourceSha, SHA, 'PRODUCTION_FINALIZATION_RECEIPT_IDENTITY_INVALID');
  const releaseId = exact(
    value.releaseId,
    /^production-[1-9][0-9]*-[1-9][0-9]*$/u,
    'PRODUCTION_FINALIZATION_RECEIPT_IDENTITY_INVALID',
  );
  const [, runId, runAttempt] = /^production-([1-9][0-9]*)-([1-9][0-9]*)$/u.exec(releaseId);

  const productionFinalizationEvidenceSha256 = exact(
    value.productionFinalizationEvidenceSha256,
    SHA256,
    'PRODUCTION_FINALIZATION_RECEIPT_HASH_INVALID',
  );
  const githubEnvironmentEvidenceSha256 = exact(
    value.githubEnvironmentEvidenceSha256,
    SHA256,
    'PRODUCTION_FINALIZATION_RECEIPT_HASH_INVALID',
  );
  const promotionControlPlaneEvidenceSha256 = exact(
    value.promotionControlPlaneEvidenceSha256,
    SHA256,
    'PRODUCTION_FINALIZATION_RECEIPT_HASH_INVALID',
  );
  let selectedTerminal;
  try {
    selectedTerminal = selectProductionTerminalRelease({
      expected: {
        accountId,
        region,
        releaseId,
        productionFinalizationEvidenceSha256,
        githubEnvironmentEvidenceSha256,
        promotionControlPlaneEvidenceSha256,
      },
      finalize: {},
      reconciliation: {
        terminalStatus: value.terminalStatus,
        terminalExecutionArn: value.terminalExecutionArn,
        finalizeExecutionArn: value.finalizeExecutionArn,
        productionFinalizationEvidenceSha256,
        githubEnvironmentEvidenceSha256,
        promotionControlPlaneEvidenceSha256,
      },
    });
  } catch (error) {
    throw new Error('PRODUCTION_FINALIZATION_RECEIPT_EXECUTION_INVALID', { cause: error });
  }
  if (!selectedTerminal.terminalDeployed) {
    fail('PRODUCTION_FINALIZATION_RECEIPT_EXECUTION_INVALID');
  }
  const candidate = object(
    value.candidateArtifact,
    'PRODUCTION_FINALIZATION_RECEIPT_ARTIFACT_INVALID',
  );
  const artifactId = exact(
    candidate.id,
    POSITIVE_INTEGER,
    'PRODUCTION_FINALIZATION_RECEIPT_ARTIFACT_INVALID',
  );
  const expectedArtifactName = `production-finalization-candidate-${runId}-${runAttempt}`;
  const expectedArtifactUrl = `https://github.com/${repository}/actions/runs/${runId}/artifacts/${artifactId}`;
  if (candidate.name !== expectedArtifactName || candidate.url !== expectedArtifactUrl) {
    fail('PRODUCTION_FINALIZATION_RECEIPT_ARTIFACT_INVALID');
  }
  const artifactDigest = exact(
    candidate.digest,
    SHA256,
    'PRODUCTION_FINALIZATION_RECEIPT_ARTIFACT_INVALID',
  );

  const evidenceIdentity = { repository, sourceSha };
  const githubEnvironment = validateGitHubEnvironmentEvidenceHash(
    value.githubEnvironmentSnapshot,
    evidenceIdentity,
    githubEnvironmentEvidenceSha256,
  );
  const promotionControlPlane = validatePromotionControlPlaneEvidenceHash(
    value.promotionControlPlaneSnapshot,
    evidenceIdentity,
    promotionControlPlaneEvidenceSha256,
  );
  const finalizedAt = timestamp(value.finalizedAt, 'PRODUCTION_FINALIZATION_RECEIPT_TIME_INVALID');
  if (
    timestamp(githubEnvironment.validatedAt, 'PRODUCTION_FINALIZATION_RECEIPT_TIME_INVALID')
      .milliseconds > finalizedAt.milliseconds ||
    timestamp(promotionControlPlane.validatedAt, 'PRODUCTION_FINALIZATION_RECEIPT_TIME_INVALID')
      .milliseconds > finalizedAt.milliseconds
  ) {
    fail('PRODUCTION_FINALIZATION_RECEIPT_TIME_INVALID');
  }

  return {
    schemaVersion: 'aeostudio.production-finalization-receipt.v1',
    environment: 'production',
    region,
    accountId,
    repository,
    sourceSha,
    releaseId,
    terminalStatus: selectedTerminal.terminalStatus,
    terminalExecutionArn: selectedTerminal.terminalExecutionArn,
    finalizeExecutionArn: selectedTerminal.finalizeExecutionArn,
    hashes: {
      productionFinalizationEvidenceSha256,
      githubEnvironmentEvidenceSha256,
      promotionControlPlaneEvidenceSha256,
    },
    candidateArtifact: {
      name: expectedArtifactName,
      id: artifactId,
      url: expectedArtifactUrl,
      digest: artifactDigest,
    },
    postCandidateSnapshots: {
      githubEnvironment,
      promotionControlPlane,
    },
    finalizedAt: finalizedAt.canonical,
  };
}

function exact(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code);
  return value;
}

function object(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function timestamp(value, code) {
  if (typeof value !== 'string') fail(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) fail(code);
  return { canonical: value, milliseconds: parsed.getTime() };
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
  const raw = await readFile(resolve(path), 'utf8');
  try {
    return object(JSON.parse(raw), code);
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    throw new Error(code, { cause: error });
  }
}

async function readExistingReceipt(path) {
  try {
    return object(
      JSON.parse(await readFile(path, 'utf8')),
      'PRODUCTION_FINALIZATION_RECEIPT_EXISTING_INVALID',
    );
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    if (
      error instanceof Error &&
      error.message === 'PRODUCTION_FINALIZATION_RECEIPT_EXISTING_INVALID'
    ) {
      throw error;
    }
    throw new Error('PRODUCTION_FINALIZATION_RECEIPT_EXISTING_INVALID', { cause: error });
  }
}

function requiredExistingFinalizedAt(existing) {
  return timestamp(existing.finalizedAt, 'PRODUCTION_FINALIZATION_RECEIPT_EXISTING_INVALID')
    .canonical;
}

async function persistReceipt(output, result, existing) {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(result)) {
      fail('PRODUCTION_FINALIZATION_RECEIPT_EXISTING_MISMATCH');
    }
    return;
  }
  try {
    await writeFile(output, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (
      error === null ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    ) {
      throw error;
    }
    const raced = await readExistingReceipt(output);
    if (raced === undefined || JSON.stringify(raced) !== JSON.stringify(result)) {
      fail('PRODUCTION_FINALIZATION_RECEIPT_EXISTING_MISMATCH');
    }
  }
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    const [githubEnvironmentSnapshot, promotionControlPlaneSnapshot] = await Promise.all([
      readJson(
        requiredEnvironment('AEO_POST_CANDIDATE_GITHUB_ENVIRONMENT_EVIDENCE_PATH'),
        'PRODUCTION_GITHUB_ENVIRONMENT_EVIDENCE_INVALID',
      ),
      readJson(
        requiredEnvironment('AEO_POST_CANDIDATE_PROMOTION_CONTROL_PLANE_EVIDENCE_PATH'),
        'PRODUCTION_PROMOTION_CONTROL_PLANE_EVIDENCE_INVALID',
      ),
    ]);
    const output = resolve(requiredEnvironment('AEO_PRODUCTION_FINALIZATION_RECEIPT_OUTPUT'));
    const existing = await readExistingReceipt(output);
    const result = createProductionFinalizationReceipt({
      accountId: requiredEnvironment('AEO_PRODUCTION_AWS_ACCOUNT_ID'),
      region: requiredEnvironment('AWS_REGION'),
      repository: requiredEnvironment('GITHUB_REPOSITORY'),
      sourceSha: requiredEnvironment('AEO_PRODUCTION_SOURCE_SHA'),
      releaseId: requiredEnvironment('AEO_PRODUCTION_RELEASE_ID'),
      terminalStatus: requiredEnvironment('AEO_TERMINAL_STATUS'),
      terminalExecutionArn: requiredEnvironment('AEO_TERMINAL_EXECUTION_ARN'),
      finalizeExecutionArn: requiredEnvironment('AEO_FINALIZE_EXECUTION_ARN'),
      productionFinalizationEvidenceSha256: requiredEnvironment(
        'AEO_PRODUCTION_FINALIZATION_EVIDENCE_SHA256',
      ),
      githubEnvironmentEvidenceSha256: requiredEnvironment(
        'AEO_PRODUCTION_EXPECTED_GITHUB_ENVIRONMENT_EVIDENCE_SHA256',
      ),
      promotionControlPlaneEvidenceSha256: requiredEnvironment(
        'AEO_PRODUCTION_EXPECTED_PROMOTION_CONTROL_PLANE_EVIDENCE_SHA256',
      ),
      candidateArtifact: {
        name: requiredEnvironment('AEO_CANDIDATE_ARTIFACT_NAME'),
        id: requiredEnvironment('AEO_CANDIDATE_ARTIFACT_ID'),
        url: requiredEnvironment('AEO_CANDIDATE_ARTIFACT_URL'),
        digest: requiredEnvironment('AEO_CANDIDATE_ARTIFACT_DIGEST'),
      },
      githubEnvironmentSnapshot,
      promotionControlPlaneSnapshot,
      finalizedAt:
        existing === undefined ? new Date().toISOString() : requiredExistingFinalizedAt(existing),
    });
    await mkdir(dirname(output), { recursive: true });
    await persistReceipt(output, result, existing);
    process.stdout.write(
      `${JSON.stringify({
        outcome: 'PASS',
        releaseId: result.releaseId,
        finalizeExecutionArn: result.finalizeExecutionArn,
        candidateArtifactId: result.candidateArtifact.id,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'PRODUCTION_FINALIZATION_RECEIPT_INVALID'}\n`,
    );
    process.exitCode = 1;
  }
}
