/* global process */

import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCOUNT_ID = /^[0-9]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export function selectProductionTerminalRelease(input) {
  const value = object(input, 'PRODUCTION_TERMINAL_RELEASE_INVALID');
  const expectedValue = object(value.expected, 'PRODUCTION_TERMINAL_RELEASE_EXPECTED_INVALID');
  const accountId = exact(
    expectedValue.accountId,
    ACCOUNT_ID,
    'PRODUCTION_TERMINAL_RELEASE_EXPECTED_INVALID',
  );
  const region =
    expectedValue.region === 'ap-southeast-1'
      ? expectedValue.region
      : fail('PRODUCTION_TERMINAL_RELEASE_EXPECTED_INVALID');
  const releaseId = exact(
    expectedValue.releaseId,
    /^production-[1-9][0-9]*-[1-9][0-9]*$/u,
    'PRODUCTION_TERMINAL_RELEASE_EXPECTED_INVALID',
  );
  const expected = {
    accountId,
    region,
    releaseId,
    productionFinalizationEvidenceSha256: exact(
      expectedValue.productionFinalizationEvidenceSha256,
      SHA256,
      'PRODUCTION_TERMINAL_RELEASE_EXPECTED_INVALID',
    ),
    githubEnvironmentEvidenceSha256: exact(
      expectedValue.githubEnvironmentEvidenceSha256,
      SHA256,
      'PRODUCTION_TERMINAL_RELEASE_EXPECTED_INVALID',
    ),
    promotionControlPlaneEvidenceSha256: exact(
      expectedValue.promotionControlPlaneEvidenceSha256,
      SHA256,
      'PRODUCTION_TERMINAL_RELEASE_EXPECTED_INVALID',
    ),
  };
  const finalize = validateChannel(value.finalize, expected);
  const reconciliation = validateChannel(value.reconciliation, expected);
  const observed = [finalize, reconciliation].filter((channel) => channel !== undefined);
  const deployed = observed.filter((channel) => channel.terminalStatus === 'DEPLOYED');
  const nonDeployed = observed.filter((channel) => channel.terminalStatus !== 'DEPLOYED');
  if (deployed.length > 0 && nonDeployed.length > 0) {
    fail('PRODUCTION_TERMINAL_RELEASE_CONFLICT');
  }
  if (deployed.length === 0) {
    return { terminalDeployed: false };
  }
  if (
    deployed.length === 2 &&
    (deployed[0].finalizeExecutionArn !== deployed[1].finalizeExecutionArn ||
      deployed[0].productionFinalizationEvidenceSha256 !==
        deployed[1].productionFinalizationEvidenceSha256 ||
      deployed[0].githubEnvironmentEvidenceSha256 !== deployed[1].githubEnvironmentEvidenceSha256 ||
      deployed[0].promotionControlPlaneEvidenceSha256 !==
        deployed[1].promotionControlPlaneEvidenceSha256)
  ) {
    fail('PRODUCTION_TERMINAL_RELEASE_CONFLICT');
  }
  const selected = reconciliation?.terminalStatus === 'DEPLOYED' ? reconciliation : deployed[0];
  return { terminalDeployed: true, ...selected };
}

function validateChannel(value, expected) {
  const channel = object(value, 'PRODUCTION_TERMINAL_RELEASE_OUTPUT_INVALID');
  if (Object.keys(channel).length === 0) return undefined;
  if (
    channel.terminalStatus !== 'DEPLOYED' &&
    channel.terminalStatus !== 'ROLLED_BACK' &&
    channel.terminalStatus !== 'PREPARATION_ABORTED'
  ) {
    fail('PRODUCTION_TERMINAL_RELEASE_OUTPUT_INVALID');
  }
  const expectedArns = terminalExecutionArns(expected);
  const terminalExecutionArn = exact(
    channel.terminalExecutionArn,
    /^arn:aws:states:ap-southeast-1:[0-9]{12}:execution:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/u,
    'PRODUCTION_TERMINAL_RELEASE_EXECUTION_INVALID',
  );
  if (!expectedArns.has(terminalExecutionArn)) {
    fail('PRODUCTION_TERMINAL_RELEASE_EXECUTION_INVALID');
  }
  if (channel.terminalStatus !== 'DEPLOYED') {
    if (
      Object.keys(channel).sort().join('\n') !==
      ['terminalExecutionArn', 'terminalStatus'].sort().join('\n')
    ) {
      fail('PRODUCTION_TERMINAL_RELEASE_OUTPUT_INVALID');
    }
    return { terminalStatus: channel.terminalStatus, terminalExecutionArn };
  }
  if (
    Object.keys(channel).sort().join('\n') !==
    [
      'terminalStatus',
      'terminalExecutionArn',
      'finalizeExecutionArn',
      'productionFinalizationEvidenceSha256',
      'githubEnvironmentEvidenceSha256',
      'promotionControlPlaneEvidenceSha256',
    ]
      .sort()
      .join('\n')
  ) {
    fail('PRODUCTION_TERMINAL_RELEASE_OUTPUT_INVALID');
  }
  const finalizeExecutionArn = expectedFinalizeExecutionArn(expected);
  if (channel.finalizeExecutionArn !== finalizeExecutionArn) {
    fail('PRODUCTION_TERMINAL_RELEASE_EXECUTION_INVALID');
  }
  for (const name of [
    'productionFinalizationEvidenceSha256',
    'githubEnvironmentEvidenceSha256',
    'promotionControlPlaneEvidenceSha256',
  ]) {
    if (
      exact(channel[name], SHA256, 'PRODUCTION_TERMINAL_RELEASE_OUTPUT_INVALID') !== expected[name]
    ) {
      fail('PRODUCTION_TERMINAL_RELEASE_HASH_MISMATCH');
    }
  }
  return {
    terminalStatus: 'DEPLOYED',
    terminalExecutionArn,
    finalizeExecutionArn,
    productionFinalizationEvidenceSha256: expected.productionFinalizationEvidenceSha256,
    githubEnvironmentEvidenceSha256: expected.githubEnvironmentEvidenceSha256,
    promotionControlPlaneEvidenceSha256: expected.promotionControlPlaneEvidenceSha256,
  };
}

function terminalExecutionArns(expected) {
  return new Set([
    expectedFinalizeExecutionArn(expected),
    `arn:aws:states:${expected.region}:${expected.accountId}:execution:aeostudio-production-release:reconcile-${expected.releaseId}`,
  ]);
}

function expectedFinalizeExecutionArn(expected) {
  const suffix = expected.releaseId.slice('production-'.length);
  return `arn:aws:states:${expected.region}:${expected.accountId}:execution:aeostudio-production-release:production-finalize-${suffix}`;
}

function exact(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code);
  return value;
}

function object(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function fail(code) {
  throw new Error(code);
}

function optionalEnvironment(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') return undefined;
  if (/[\r\n]/u.test(value)) fail(`${name}_INVALID`);
  return value;
}

function requiredEnvironment(name) {
  const value = optionalEnvironment(name);
  if (value === undefined) fail(`${name}_REQUIRED`);
  return value;
}

function channelFromEnvironment(prefix) {
  const terminalStatus = optionalEnvironment(`${prefix}_TERMINAL_STATUS`);
  if (terminalStatus === undefined) return {};
  const base = {
    terminalStatus,
    terminalExecutionArn: requiredEnvironment(`${prefix}_TERMINAL_EXECUTION_ARN`),
  };
  if (terminalStatus !== 'DEPLOYED') return base;
  return {
    ...base,
    finalizeExecutionArn: requiredEnvironment(`${prefix}_FINALIZE_EXECUTION_ARN`),
    productionFinalizationEvidenceSha256: requiredEnvironment(
      `${prefix}_PRODUCTION_FINALIZATION_EVIDENCE_SHA256`,
    ),
    githubEnvironmentEvidenceSha256: requiredEnvironment(
      `${prefix}_GITHUB_ENVIRONMENT_EVIDENCE_SHA256`,
    ),
    promotionControlPlaneEvidenceSha256: requiredEnvironment(
      `${prefix}_PROMOTION_CONTROL_PLANE_EVIDENCE_SHA256`,
    ),
  };
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    const result = selectProductionTerminalRelease({
      expected: {
        accountId: requiredEnvironment('AEO_PRODUCTION_AWS_ACCOUNT_ID'),
        region: requiredEnvironment('AWS_REGION'),
        releaseId: requiredEnvironment('AEO_PRODUCTION_RELEASE_ID'),
        productionFinalizationEvidenceSha256: requiredEnvironment(
          'AEO_PRODUCTION_EXPECTED_FINALIZATION_EVIDENCE_SHA256',
        ),
        githubEnvironmentEvidenceSha256: requiredEnvironment(
          'AEO_PRODUCTION_EXPECTED_GITHUB_ENVIRONMENT_EVIDENCE_SHA256',
        ),
        promotionControlPlaneEvidenceSha256: requiredEnvironment(
          'AEO_PRODUCTION_EXPECTED_PROMOTION_CONTROL_PLANE_EVIDENCE_SHA256',
        ),
      },
      finalize: channelFromEnvironment('AEO_FINALIZE'),
      reconciliation: channelFromEnvironment('AEO_RECONCILE'),
    });
    const output = requiredEnvironment('GITHUB_OUTPUT');
    const entries = result.terminalDeployed
      ? {
          terminal_deployed: 'true',
          terminal_status: result.terminalStatus,
          terminal_execution_arn: result.terminalExecutionArn,
          finalize_execution_arn: result.finalizeExecutionArn,
          production_finalization_evidence_sha256: result.productionFinalizationEvidenceSha256,
          github_environment_evidence_sha256: result.githubEnvironmentEvidenceSha256,
          promotion_control_plane_evidence_sha256: result.promotionControlPlaneEvidenceSha256,
        }
      : { terminal_deployed: 'false' };
    await appendFile(
      output,
      Object.entries(entries)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
      'utf8',
    );
    process.stdout.write(
      `${JSON.stringify({
        outcome: 'PASS',
        terminalDeployed: result.terminalDeployed,
        ...(result.terminalDeployed
          ? {
              terminalStatus: result.terminalStatus,
              terminalExecutionArn: result.terminalExecutionArn,
            }
          : {}),
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'PRODUCTION_TERMINAL_RELEASE_INVALID'}\n`,
    );
    process.exitCode = 1;
  }
}
