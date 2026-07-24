import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test, vi } from 'vitest';

// @ts-expect-error The production helper is a native ESM JavaScript module.
import * as untypedReceipt from '../../scripts/acceptance/create-production-finalization-receipt.mjs';
// @ts-expect-error The production helper is a native ESM JavaScript module.
import * as untypedTerminal from '../../scripts/acceptance/select-production-terminal-release.mjs';
// @ts-expect-error The production budget helper is a native ESM JavaScript module.
import * as untypedBudget from '../../scripts/acceptance/production-finalization-budget.mjs';
// @ts-expect-error The release broker is a native ESM JavaScript module.
import * as untypedBroker from '../../scripts/release/run-release-broker.mjs';

const receipt = untypedReceipt as {
  createProductionFinalizationReceipt(input: Record<string, unknown>): Record<string, unknown>;
};
const terminal = untypedTerminal as {
  selectProductionTerminalRelease(input: Record<string, unknown>): Record<string, unknown>;
};
const budget = untypedBudget as {
  finalizationSafetyMarginMilliseconds: number;
  minimumFinalizationRemainingMilliseconds: number;
  minimumRecoveryRemainingMilliseconds: number;
  postTerminalEvidenceMilliseconds: number;
  productionJobDeadlineWindowMilliseconds: number;
  releaseExecutionObservationMilliseconds: number;
  smokeLeaseMilliseconds: number;
  evaluateProductionFinalizationBudget(input: Record<string, unknown>): Record<string, unknown>;
};
const broker = untypedBroker as {
  awsCommandTimeoutMilliseconds: number;
  cleanupRecoveryWaitBudgetMilliseconds: number;
  maximumReleaseIdLength: number;
  releaseExecutionWaitTimeoutMilliseconds: number;
  strictJsonObjectEquals(observed: unknown, expected: Record<string, unknown>): boolean;
  inspectExactClaimedLifecycleExecution(
    common: Record<string, unknown>,
    brokerArn: string,
    item: Record<string, unknown>,
    expected: Record<string, unknown>,
    finalizationEvidence: Record<string, unknown> | undefined,
    adapters: {
      describeExecution: (
        region: string,
        executionArn: string,
      ) => Record<string, unknown> | undefined;
      waitForExecution: (region: string, executionArn: string) => Promise<Record<string, unknown>>;
    },
  ): Promise<Record<string, unknown>>;
  parseOptions(argv: string[]): Map<string, string>;
  refreshExactDeployExecutionAfterWatchdog(
    common: Record<string, unknown>,
    brokerArn: string,
    deployName: string,
    deployArn: string,
    describeExecution: (
      region: string,
      executionArn: string,
    ) => Record<string, unknown> | undefined,
  ): Record<string, unknown>;
  requireFinalizedReleaseState(
    pointer: Record<string, unknown>,
    item: Record<string, unknown>,
    expected: Record<string, unknown>,
    environment: string,
  ): Record<string, unknown>;
  requireTerminalCoordination(
    item: Record<string, unknown>,
    expected: Record<string, unknown>,
    allowedStatuses: string[],
  ): string;
  validateCommon(options: Map<string, string>): Record<string, unknown>;
  waitForExecution(
    region: string,
    executionArn: string,
    adapters: {
      describeExecution: (
        region: string,
        executionArn: string,
        timeoutMilliseconds: number,
      ) => Record<string, unknown>;
      now: () => number;
      sleep: (milliseconds: number) => Promise<void>;
      waitBudgetMilliseconds: number;
    },
  ): Promise<Record<string, unknown>>;
};

const accountId = '123456789012';
const region = 'ap-southeast-1';
const repository = 'owner/aeostudio';
const sourceSha = 'd'.repeat(40);
const runId = '901';
const runAttempt = '3';
const releaseId = `production-${runId}-${runAttempt}`;
const githubValidatedAt = '2026-07-24T10:08:00.000Z';
const controlPlaneValidatedAt = '2026-07-24T10:09:00.000Z';
const finalizedAt = '2026-07-24T10:10:00.000Z';

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function receiptFixture(): Record<string, unknown> {
  const githubCore = {
    schemaVersion: 'aeostudio.github-environment-evidence.v1',
    repository,
    sourceSha,
    production: { environment: 'production' },
    stagingDeployment: { environment: 'staging' },
  };
  const controlPlaneCore = {
    schemaVersion: 'aeostudio.github-promotion-control-plane.v1',
    repository,
    sourceSha,
    maxAgeHours: 168,
    runs: { build: { id: '100' } },
    artifacts: { releaseManifest: { id: '200' } },
  };
  const githubEnvironmentEvidenceSha256 = sha256(githubCore);
  const promotionControlPlaneEvidenceSha256 = sha256(controlPlaneCore);
  const finalizeExecutionArn =
    `arn:aws:states:${region}:${accountId}:execution:` +
    `aeostudio-production-release:production-finalize-${runId}-${runAttempt}`;
  return {
    accountId,
    region,
    repository,
    sourceSha,
    releaseId,
    terminalStatus: 'DEPLOYED',
    terminalExecutionArn: finalizeExecutionArn,
    finalizeExecutionArn,
    productionFinalizationEvidenceSha256: 'a'.repeat(64),
    githubEnvironmentEvidenceSha256,
    promotionControlPlaneEvidenceSha256,
    candidateArtifact: {
      name: `production-finalization-candidate-${runId}-${runAttempt}`,
      id: '789',
      url: `https://github.com/${repository}/actions/runs/${runId}/artifacts/789`,
      digest: 'b'.repeat(64),
    },
    githubEnvironmentSnapshot: {
      ...githubCore,
      evidenceSha256: githubEnvironmentEvidenceSha256,
      validatedAt: githubValidatedAt,
    },
    promotionControlPlaneSnapshot: {
      ...controlPlaneCore,
      controlPlaneSha256: promotionControlPlaneEvidenceSha256,
      validatedAt: controlPlaneValidatedAt,
    },
    finalizedAt,
  };
}

function namedSteps(workflow: string): string[] {
  return [...workflow.matchAll(/^ {6}- name: (.+)$/gmu)].map((match) => match[1]!);
}

function stepSection(workflow: string, name: string): string {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  if (start < 0) return '';
  const next = workflow.indexOf('\n      - name: ', start + marker.length);
  return workflow.slice(start, next < 0 ? undefined : next);
}

describe('Task 18 production finalization artifacts', () => {
  test('persists a candidate, performs one adjacent live reread, then emits a finalized receipt', async () => {
    const [workflow, brokerClient, releaseControl, bootstrap] = await Promise.all([
      readFile(join(process.cwd(), '.github', 'workflows', 'deploy-production.yml'), 'utf8'),
      readFile(join(process.cwd(), 'scripts', 'release', 'run-release-broker.mjs'), 'utf8'),
      readFile(join(process.cwd(), 'infra', 'modules', 'platform', 'release-control.tf'), 'utf8'),
      readFile(join(process.cwd(), 'infra', 'bootstrap', 'main.tf'), 'utf8'),
    ]);
    const production = workflow.split('\n  deploy-production:')[1] ?? '';
    const jobTimeoutMinutes = Number(production.match(/^ {4}timeout-minutes: ([0-9]+)$/mu)?.[1]);
    const watchdogTimeoutSeconds = Number(
      releaseControl.match(
        /resource "aws_sfn_state_machine" "release_watchdog"[\s\S]*?TimeoutSeconds = ([0-9]+)/u,
      )?.[1],
    );
    const productionRoleMaxSessionSeconds = Number(
      bootstrap.match(
        /resource "aws_iam_role" "production_deployer"[\s\S]*?max_session_duration = ([0-9]+)/u,
      )?.[1],
    );
    const credentials = stepSection(production, 'Acquire production release-broker credentials');
    const credentialDurationSeconds = Number(
      credentials.match(/role-duration-seconds: ([0-9]+)/u)?.[1],
    );
    expect(jobTimeoutMinutes).toBe(360);
    expect(jobTimeoutMinutes).toBeLessThanOrEqual(360);
    expect(credentialDurationSeconds).toBe(21_600);
    expect(productionRoleMaxSessionSeconds).toBe(credentialDurationSeconds);
    expect(credentialDurationSeconds).toBeGreaterThanOrEqual(jobTimeoutMinutes * 60);
    expect(watchdogTimeoutSeconds).toBe(10_800);
    expect(broker.cleanupRecoveryWaitBudgetMilliseconds).toBe(
      2 * broker.releaseExecutionWaitTimeoutMilliseconds,
    );
    const steps = namedSteps(production);
    const deadlineName = 'Establish bounded production job deadline';
    const candidateName = 'Upload immutable production finalization candidate';
    const postUploadName = 'Revalidate live promotion evidence after candidate upload';
    const budgetName = 'Authorize FINALIZE within the remaining production job budget';
    const finalizeName = 'Finalize the exact production release';
    const cleanupName = 'Reconcile or roll back any started release that was not finalized';
    const terminalName = 'Select exact deployed production terminal';
    const receiptName = 'Generate finalized production release receipt';
    const finalizedArtifactName = 'Upload immutable finalized production release receipt';
    const retryArtifactName = 'Retry immutable finalized production release receipt upload';
    const verifyArtifactName = 'Verify immutable finalized production release receipt artifact';
    const candidatePayloadFiles = [
      'release-digests.json',
      'production-github-environment-evidence-pre-finalize.json',
      'production-promotion-control-plane-pre-finalize.json',
      'production-release-contract.json',
      'production-tenant-data-broker-runtime.json',
      'production-api-web-runtime.json',
      'production-health.json',
      'production-ready.json',
      'production-smoke-envelope.json',
      'production-finalization-evidence.json',
    ];
    const finalizedFiles = [
      ...candidatePayloadFiles,
      'production-finalization-candidate-verification.json',
      'production-finalization-receipt.json',
      'production-github-environment-evidence-post-candidate.json',
      'production-promotion-control-plane-post-candidate.json',
    ];
    const candidateIndex = steps.indexOf(candidateName);
    const postUploadIndex = steps.indexOf(postUploadName);
    const budgetIndex = steps.indexOf(budgetName);
    const finalizeIndex = steps.indexOf(finalizeName);
    const cleanupIndex = steps.indexOf(cleanupName);
    const terminalIndex = steps.indexOf(terminalName);
    const receiptIndex = steps.indexOf(receiptName);
    const finalizedArtifactIndex = steps.indexOf(finalizedArtifactName);
    const retryArtifactIndex = steps.indexOf(retryArtifactName);
    const verifyArtifactIndex = steps.indexOf(verifyArtifactName);

    expect(steps[0]).toBe(deadlineName);
    expect(candidateIndex).toBeGreaterThan(0);
    expect(postUploadIndex).toBe(candidateIndex + 1);
    expect(budgetIndex).toBe(postUploadIndex + 1);
    expect(finalizeIndex).toBe(budgetIndex + 1);
    expect(cleanupIndex).toBe(finalizeIndex + 1);
    expect(terminalIndex).toBe(cleanupIndex + 1);
    expect(receiptIndex).toBe(terminalIndex + 1);
    expect(finalizedArtifactIndex).toBe(receiptIndex + 1);
    expect(retryArtifactIndex).toBe(finalizedArtifactIndex + 1);
    expect(verifyArtifactIndex).toBe(retryArtifactIndex + 1);

    const candidate = stepSection(production, candidateName);
    expect(candidate).toContain('id: persist-finalization-candidate');
    expect(candidate).toContain("if: ${{ steps.final-evidence.outcome == 'success' }}");
    expect(candidate).toContain('timeout-minutes: 5');
    expect(candidate).toContain(
      'name: production-finalization-candidate-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    for (const file of candidatePayloadFiles) {
      expect(candidate).toContain(`release/${file}`);
    }
    expect(candidate).toContain('if-no-files-found: error');

    const postUpload = stepSection(production, postUploadName);
    expect(postUpload).toContain('id: post-candidate-live-evidence');
    expect(postUpload).toContain(
      "if: ${{ steps.persist-finalization-candidate.outcome == 'success' }}",
    );
    expect(postUpload).toContain('timeout-minutes: 5');
    expect(postUpload).toContain(
      'AEO_GITHUB_ENVIRONMENT_EVIDENCE_OUTPUT: release/production-github-environment-evidence-post-candidate.json',
    );
    expect(postUpload).toContain(
      'AEO_PROMOTION_CONTROL_PLANE_OUTPUT: release/production-promotion-control-plane-post-candidate.json',
    );
    for (const path of [
      'acceptance-run-post-candidate.json',
      'acceptance-artifacts-post-candidate.json',
      'build-run-post-candidate.json',
      'build-artifacts-post-candidate.json',
      'plan-run-post-candidate.json',
      'plan-artifacts-post-candidate.json',
      'restore-run-post-candidate.json',
      'restore-artifacts-post-candidate.json',
    ]) {
      expect(postUpload).toContain(path);
    }
    expect(postUpload).toContain(
      'EXPECTED_CONTROL_PLANE_SHA256: ${{ needs.validate-release.outputs.control-plane-sha256 }}',
    );
    expect(postUpload).toContain(
      'EXPECTED_GITHUB_ENVIRONMENT_EVIDENCE_SHA256: ${{ needs.validate-release.outputs.github-environment-evidence-sha256 }}',
    );
    expect(postUpload).toContain('node scripts/acceptance/github-promotion-control-plane.mjs');
    expect(postUpload).toContain('node scripts/acceptance/github-environment-evidence.mjs');
    expect(postUpload).toContain(
      'actions/runs/$GITHUB_RUN_ID/artifacts?name=$CANDIDATE_ARTIFACT_NAME',
    );
    expect(postUpload).toContain('actions/artifacts/$CANDIDATE_ARTIFACT_ID/zip');
    expect(postUpload).toContain('sha256sum "$candidate_archive"');
    expect(postUpload).toContain('production-finalization-candidate-verification.json');
    expect(postUpload.indexOf('actions/artifacts/$CANDIDATE_ARTIFACT_ID/zip')).toBeLessThan(
      postUpload.indexOf('actions/runs/$BUILD_RUN_ID"'),
    );
    expect(postUpload.lastIndexOf('node scripts/acceptance/github-environment-evidence.mjs')).toBe(
      postUpload.lastIndexOf('node scripts/acceptance'),
    );
    for (const file of candidatePayloadFiles) {
      expect(postUpload).toContain(file);
    }

    const finalize = stepSection(production, finalizeName);
    expect(finalize).toContain("steps.finalization-budget.outcome == 'success'");
    expect(finalize).toContain("steps.finalization-budget.outputs.finalize_authorized == 'true'");
    expect(finalize).toContain('timeout-minutes: 75');

    const deadline = stepSection(production, deadlineName);
    expect(deadline).toContain('timeout-minutes: 1');
    expect(deadline).toContain('AEO_PRODUCTION_JOB_DEADLINE_EPOCH_MILLISECONDS');
    expect(deadline).toContain('21000000');

    const finalizationBudget = stepSection(production, budgetName);
    expect(finalizationBudget).toContain('id: finalization-budget');
    expect(finalizationBudget).toContain('timeout-minutes: 1');
    expect(finalizationBudget).toContain(
      'node scripts/acceptance/production-finalization-budget.mjs',
    );
    expect(finalizationBudget).toContain('AEO_PRODUCTION_JOB_DEADLINE_EPOCH_MILLISECONDS');
    expect(finalizationBudget).not.toContain('continue-on-error: true');

    const cleanup = stepSection(production, cleanupName);
    const cleanupTimeoutMinutes = Number(cleanup.match(/^\s+timeout-minutes: ([0-9]+)$/mu)?.[1]);
    expect(cleanup).toContain('id: reconcile');
    expect(cleanup).toContain('always()');
    expect(cleanup).toContain('steps.finalize.outcome !=');
    expect(cleanupTimeoutMinutes).toBe(150);
    expect(cleanupTimeoutMinutes * 60_000).toBeGreaterThan(
      broker.cleanupRecoveryWaitBudgetMilliseconds,
    );
    const preGateTimeouts = new Map([
      [deadlineName, 1],
      ['Check out the exact attested source', 5],
      ['Revalidate exact promotion evidence after production approval', 10],
      ['Download the exact promoted manifest', 5],
      ['Validate protected production approval and deploy role', 5],
      ['Acquire production release-broker credentials', 5],
      ['Start deployment through the fixed release broker', 5],
      ['Wait for the broker and verify its immutable contract', 75],
      ['Verify production Tenant Data Broker ECS runtime identity and health', 5],
      ['Verify exact production API and Web ECS runtime identity', 5],
      ['Smoke production health and exact runtime identity', 10],
      ['Revalidate live promotion evidence immediately before finalization', 10],
      ['Validate exact production evidence before finalization', 5],
      [candidateName, 5],
      [postUploadName, 5],
      [budgetName, 1],
    ]);
    let preGateBudgetMinutes = 0;
    for (const [name, expectedTimeout] of preGateTimeouts) {
      const timeout = Number(
        stepSection(production, name).match(/^\s+timeout-minutes: ([0-9]+)$/mu)?.[1],
      );
      expect(timeout).toBe(expectedTimeout);
      preGateBudgetMinutes += timeout;
    }
    const postTerminalNames = [
      terminalName,
      receiptName,
      finalizedArtifactName,
      retryArtifactName,
      verifyArtifactName,
    ];
    let postTerminalBudgetMinutes = 0;
    for (const name of postTerminalNames) {
      const timeout = Number(
        stepSection(production, name).match(/^\s+timeout-minutes: ([0-9]+)$/mu)?.[1],
      );
      expect(timeout).toBe(5);
      postTerminalBudgetMinutes += timeout;
    }
    expect(preGateBudgetMinutes).toBe(157);
    expect(postTerminalBudgetMinutes).toBe(25);
    expect(budget.productionJobDeadlineWindowMilliseconds).toBe(21_000_000);
    expect(budget.minimumFinalizationRemainingMilliseconds).toBe(15_000_000);
    expect(budget.releaseExecutionObservationMilliseconds).toBe(
      broker.releaseExecutionWaitTimeoutMilliseconds,
    );
    expect(budget.smokeLeaseMilliseconds).toBe(15 * 60_000);
    expect(budget.postTerminalEvidenceMilliseconds).toBe(postTerminalBudgetMinutes * 60_000);
    expect(budget.finalizationSafetyMarginMilliseconds).toBe(12 * 60_000);
    expect(budget.finalizationSafetyMarginMilliseconds).toBeGreaterThanOrEqual(
      12 * broker.awsCommandTimeoutMilliseconds,
    );
    expect(budget.minimumRecoveryRemainingMilliseconds).toBe(
      2 * broker.releaseExecutionWaitTimeoutMilliseconds +
        budget.postTerminalEvidenceMilliseconds +
        budget.finalizationSafetyMarginMilliseconds,
    );
    expect(budget.minimumFinalizationRemainingMilliseconds).toBe(
      Math.max(broker.releaseExecutionWaitTimeoutMilliseconds, budget.smokeLeaseMilliseconds) +
        2 * broker.releaseExecutionWaitTimeoutMilliseconds +
        budget.postTerminalEvidenceMilliseconds +
        budget.finalizationSafetyMarginMilliseconds,
    );
    expect(budget.productionJobDeadlineWindowMilliseconds).toBeLessThan(jobTimeoutMinutes * 60_000);
    expect(preGateBudgetMinutes * 60_000).toBeLessThanOrEqual(
      budget.productionJobDeadlineWindowMilliseconds - budget.minimumRecoveryRemainingMilliseconds,
    );
    expect(cleanup).toContain(
      '--finalize-execution-name "production-finalize-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    );
    expect(cleanup).toContain(
      '--execution-name "reconcile-production-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    );
    expect(cleanup).toContain(
      'EXPECTED_FINALIZATION_EVIDENCE_SHA256: ${{ steps.final-evidence.outputs.evidence_sha256 }}',
    );
    expect(cleanup).toContain(
      'EXPECTED_GITHUB_ENVIRONMENT_EVIDENCE_SHA256: ${{ needs.validate-release.outputs.github-environment-evidence-sha256 }}',
    );
    expect(cleanup).toContain(
      'EXPECTED_PROMOTION_CONTROL_PLANE_EVIDENCE_SHA256: ${{ needs.validate-release.outputs.control-plane-sha256 }}',
    );
    expect(cleanup).toContain('if [[ -n "$EXPECTED_FINALIZATION_EVIDENCE_SHA256" ]]');
    expect(cleanup).toContain(
      '--production-finalization-evidence-sha256 "$EXPECTED_FINALIZATION_EVIDENCE_SHA256"',
    );
    expect(cleanup).toContain(
      '--github-environment-evidence-sha256 "$EXPECTED_GITHUB_ENVIRONMENT_EVIDENCE_SHA256"',
    );
    expect(cleanup).toContain(
      '--promotion-control-plane-evidence-sha256 "$EXPECTED_PROMOTION_CONTROL_PLANE_EVIDENCE_SHA256"',
    );

    const terminal = stepSection(production, terminalName);
    expect(terminal).toContain('id: terminal-release');
    expect(terminal).toContain('${{ steps.finalize.outputs.terminal_status }}');
    expect(terminal).toContain('${{ steps.reconcile.outputs.terminal_status }}');
    expect(terminal).toContain('node scripts/acceptance/select-production-terminal-release.mjs');

    const receipt = stepSection(production, receiptName);
    expect(receipt).toContain('id: finalized-receipt');
    expect(receipt).toContain(
      "if: ${{ always() && steps.terminal-release.outputs.terminal_deployed == 'true' }}",
    );
    expect(receipt).toContain('node scripts/acceptance/create-production-finalization-receipt.mjs');
    expect(receipt).toContain(
      'AEO_FINALIZE_EXECUTION_ARN: ${{ steps.terminal-release.outputs.finalize_execution_arn }}',
    );
    expect(receipt).toContain(
      'AEO_TERMINAL_EXECUTION_ARN: ${{ steps.terminal-release.outputs.terminal_execution_arn }}',
    );
    expect(receipt).toContain(
      'AEO_CANDIDATE_ARTIFACT_ID: ${{ steps.persist-finalization-candidate.outputs.artifact-id }}',
    );
    expect(receipt).toContain(
      'AEO_CANDIDATE_ARTIFACT_URL: ${{ steps.persist-finalization-candidate.outputs.artifact-url }}',
    );
    expect(receipt).toContain(
      'AEO_CANDIDATE_ARTIFACT_DIGEST: ${{ steps.persist-finalization-candidate.outputs.artifact-digest }}',
    );

    const finalizedArtifact = stepSection(production, finalizedArtifactName);
    expect(finalizedArtifact).toContain('continue-on-error: true');
    expect(finalizedArtifact).toContain('timeout-minutes: 5');
    expect(finalizedArtifact).toContain(
      'name: production-release-finalized-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    for (const file of finalizedFiles) {
      expect(finalizedArtifact).toContain(`release/${file}`);
    }
    expect(finalizedArtifact).toContain('if-no-files-found: error');
    expect(finalizedArtifact).not.toContain('overwrite: true');

    const retryArtifact = stepSection(production, retryArtifactName);
    expect(retryArtifact).toContain('continue-on-error: true');
    expect(retryArtifact).toContain('steps.persist-finalized-receipt.outcome !=');
    expect(retryArtifact).toContain(
      'name: production-release-finalized-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    expect(retryArtifact).not.toContain('overwrite: true');
    for (const file of finalizedFiles) {
      expect(retryArtifact).toContain(`release/${file}`);
    }

    const verifyArtifact = stepSection(production, verifyArtifactName);
    expect(verifyArtifact).toContain('id: verify-finalized-receipt');
    expect(verifyArtifact).toContain(
      'actions/runs/$GITHUB_RUN_ID/artifacts?name=$FINALIZED_ARTIFACT_NAME',
    );
    expect(verifyArtifact).toContain('sha256sum');
    expect(verifyArtifact).toContain('unzip');
    expect(verifyArtifact).toContain('for finalized_file in "${finalized_files[@]}"');
    expect(verifyArtifact).toContain(
      'cmp --silent "$extract_dir/$finalized_file" "release/$finalized_file"',
    );
    expect(verifyArtifact).not.toContain('CANDIDATE_ARTIFACT_ID');
    for (const file of finalizedFiles) {
      expect(verifyArtifact).toContain(file);
    }

    for (const output of [
      'terminal_status',
      'terminal_execution_arn',
      'finalize_execution_arn',
      'production_finalization_evidence_sha256',
      'github_environment_evidence_sha256',
      'promotion_control_plane_evidence_sha256',
    ]) {
      expect(brokerClient).toContain(`${output}:`);
    }
    expect(brokerClient).toContain(
      'suppliedAuthorizationNames.length !== authorizationNames.length',
    );
    expect(brokerClient).toContain('await requireExactProductionFinalizeExecution(');
    expect(brokerClient).toContain(
      'execution = await waitForExecution(common.region, finalizeExecutionArn)',
    );
    expect(brokerClient).not.toMatch(
      /waitForExecution\(\s*common\.region,\s*watchdogExecutionArn/u,
    );
    expect(brokerClient).not.toContain('claimAttempt');
    expect(brokerClient).toContain("authorizedFinalizeExecution?.status === 'SUCCEEDED'");
    expect(brokerClient).toContain("claimedLifecycleExecution?.status === 'SUCCEEDED'");
    expect(brokerClient).toContain("claimedLifecycleExecution.mode === 'RECOVER'");
    expect(brokerClient).toContain("Mode: 'RECOVER'");
    expect(brokerClient).not.toContain("cleanupMode = 'ROLLBACK'");
    expect(brokerClient).toContain('const expectedReconciliationName = `reconcile-${releaseId}`');
    expect(brokerClient).not.toContain('await recordTerminal(terminal, watchdogExecutionArn)');
    expect(releaseControl).not.toContain('States.UUID()');
    expect(releaseControl).not.toContain('"Build exact rolled-back cleanup input"');
    expect(brokerClient.match(/spawnSync\(/gu)).toHaveLength(3);
    expect(brokerClient.match(/\btimeout:/gu)).toHaveLength(3);
  });

  test('authorizes FINALIZE at 15000 seconds remaining and rejects 14999 seconds', () => {
    const nowEpochMilliseconds = Date.parse('2026-07-24T10:00:00.000Z');
    expect(
      budget.evaluateProductionFinalizationBudget({
        nowEpochMilliseconds,
        deadlineEpochMilliseconds: nowEpochMilliseconds + 15_000 * 1000,
      }),
    ).toMatchObject({
      finalizeAuthorized: true,
      remainingMilliseconds: 15_000_000,
    });
    expect(
      budget.evaluateProductionFinalizationBudget({
        nowEpochMilliseconds,
        deadlineEpochMilliseconds: nowEpochMilliseconds + 14_999 * 1000,
      }),
    ).toMatchObject({
      finalizeAuthorized: false,
      remainingMilliseconds: 14_999_000,
    });
  });

  test('admits a 70-character release identity and rejects 71 before a shared child can be named', () => {
    const release70 = 'r'.repeat(70);
    const release71 = 'r'.repeat(71);
    const deployArguments = (release: string) => [
      'node',
      'run-release-broker.mjs',
      '--mode',
      'DEPLOY_START',
      '--environment',
      'staging',
      '--region',
      region,
      '--expected-account-id',
      accountId,
      '--execution-name',
      release,
      '--manifest',
      'release.json',
      '--release-id',
      release,
      '--repository',
      repository,
    ];
    const cleanupArguments = (release: string, executionName: string) => [
      'node',
      'run-release-broker.mjs',
      '--mode',
      'CLEANUP',
      '--environment',
      'staging',
      '--region',
      region,
      '--expected-account-id',
      accountId,
      '--execution-name',
      executionName,
      '--deploy-execution-name',
      release,
      '--release-id',
      release,
    ];
    const recoverArguments = (release: string) => [
      'node',
      'run-release-broker.mjs',
      '--mode',
      'RECOVER',
      '--environment',
      'staging',
      '--region',
      region,
      '--expected-account-id',
      accountId,
      '--execution-name',
      `reconcile-${release}`,
      '--release-id',
      release,
    ];

    expect(broker.maximumReleaseIdLength).toBe(70);
    expect(broker.validateCommon(broker.parseOptions(deployArguments(release70)))).toMatchObject({
      executionName: release70,
      mode: 'DEPLOY_START',
    });
    expect(() => broker.validateCommon(broker.parseOptions(deployArguments(release71)))).toThrow(
      'RELEASE_ARGUMENTS_INVALID',
    );
    expect(
      broker.validateCommon(
        broker.parseOptions(cleanupArguments(release70, `reconcile-${release70}`)),
      ),
    ).toMatchObject({ mode: 'CLEANUP' });
    expect(() =>
      broker.validateCommon(broker.parseOptions(cleanupArguments(release71, 'x'.repeat(80)))),
    ).toThrow('RELEASE_ARGUMENTS_INVALID');
    expect(broker.validateCommon(broker.parseOptions(recoverArguments(release70)))).toMatchObject({
      executionName: `reconcile-${release70}`,
      mode: 'RECOVER',
    });
    expect(() => broker.validateCommon(broker.parseOptions(recoverArguments(release71)))).toThrow(
      'RELEASE_ARGUMENTS_INVALID',
    );
  });

  test('never lets an execution poll or sleep cross the absolute wait deadline', async () => {
    let nowEpochMilliseconds = 1_000;
    const deadlineEpochMilliseconds = nowEpochMilliseconds + 35_000;
    const commandTimeouts: number[] = [];
    const sleeps: number[] = [];
    const describeExecution = vi.fn(
      (_region: string, _executionArn: string, timeoutMilliseconds: number) => {
        commandTimeouts.push(timeoutMilliseconds);
        expect(nowEpochMilliseconds + timeoutMilliseconds).toBeLessThanOrEqual(
          deadlineEpochMilliseconds,
        );
        return { status: 'RUNNING' };
      },
    );
    const sleep = vi.fn((milliseconds: number) => {
      sleeps.push(milliseconds);
      expect(nowEpochMilliseconds + milliseconds).toBeLessThanOrEqual(deadlineEpochMilliseconds);
      nowEpochMilliseconds += milliseconds;
      return Promise.resolve();
    });

    await expect(
      broker.waitForExecution(region, 'arn:aws:states:execution:test', {
        describeExecution,
        now: () => nowEpochMilliseconds,
        sleep,
        waitBudgetMilliseconds: 35_000,
      }),
    ).rejects.toThrow('RELEASE_EXECUTION_WAIT_TIMEOUT');
    expect(commandTimeouts).toEqual([30_000, 25_000, 15_000, 5_000]);
    expect(sleeps).toEqual([10_000, 10_000, 10_000, 5_000]);
    expect(nowEpochMilliseconds).toBe(deadlineEpochMilliseconds);
    expect(describeExecution).toHaveBeenCalledTimes(4);
  });

  test('fails closed immediately when the bounded AWS describe command times out', async () => {
    const describeExecution = vi.fn(() => {
      throw new Error('AWS_COMMAND_TIMEOUT:stepfunctions:describe-execution');
    });
    const sleep = vi.fn(() => Promise.resolve());

    await expect(
      broker.waitForExecution(region, 'arn:aws:states:execution:test', {
        describeExecution,
        now: () => 1_000,
        sleep,
        waitBudgetMilliseconds: 35_000,
      }),
    ).rejects.toThrow('AWS_COMMAND_TIMEOUT:stepfunctions:describe-execution');
    expect(describeExecution).toHaveBeenCalledWith(
      region,
      'arn:aws:states:execution:test',
      broker.awsCommandTimeoutMilliseconds,
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  test('creates a strict receipt that binds the terminal execution, candidate, and live snapshots', () => {
    const input = receiptFixture();
    const result = receipt.createProductionFinalizationReceipt(input);
    expect(result).toMatchObject({
      schemaVersion: 'aeostudio.production-finalization-receipt.v1',
      environment: 'production',
      region,
      accountId,
      repository,
      sourceSha,
      releaseId,
      terminalStatus: 'DEPLOYED',
      terminalExecutionArn:
        `arn:aws:states:${region}:${accountId}:execution:` +
        `aeostudio-production-release:production-finalize-${runId}-${runAttempt}`,
      finalizeExecutionArn:
        `arn:aws:states:${region}:${accountId}:execution:` +
        `aeostudio-production-release:production-finalize-${runId}-${runAttempt}`,
      candidateArtifact: {
        name: `production-finalization-candidate-${runId}-${runAttempt}`,
        id: '789',
        url: `https://github.com/${repository}/actions/runs/${runId}/artifacts/789`,
        digest: 'b'.repeat(64),
      },
      hashes: {
        productionFinalizationEvidenceSha256: 'a'.repeat(64),
      },
      postCandidateSnapshots: {
        githubEnvironment: {
          validatedAt: githubValidatedAt,
        },
        promotionControlPlane: {
          validatedAt: controlPlaneValidatedAt,
        },
      },
      finalizedAt,
    });
    const hashes = result.hashes as Record<string, unknown>;
    expect(hashes.githubEnvironmentEvidenceSha256).toBe(input.githubEnvironmentEvidenceSha256);
    expect(hashes.promotionControlPlaneEvidenceSha256).toBe(
      input.promotionControlPlaneEvidenceSha256,
    );
    const snapshots = result.postCandidateSnapshots as Record<string, Record<string, unknown>>;
    for (const name of ['githubEnvironment', 'promotionControlPlane']) {
      expect(snapshots[name]?.stableSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(snapshots[name]?.snapshotSha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  test('selects only an exactly hash-bound DEPLOYED terminal from FINALIZE or reconciliation', () => {
    const input = receiptFixture();
    const expected = {
      accountId,
      region,
      releaseId,
      productionFinalizationEvidenceSha256: input.productionFinalizationEvidenceSha256,
      githubEnvironmentEvidenceSha256: input.githubEnvironmentEvidenceSha256,
      promotionControlPlaneEvidenceSha256: input.promotionControlPlaneEvidenceSha256,
    };
    const direct = {
      terminalStatus: 'DEPLOYED',
      terminalExecutionArn: input.terminalExecutionArn,
      finalizeExecutionArn: input.finalizeExecutionArn,
      productionFinalizationEvidenceSha256: input.productionFinalizationEvidenceSha256,
      githubEnvironmentEvidenceSha256: input.githubEnvironmentEvidenceSha256,
      promotionControlPlaneEvidenceSha256: input.promotionControlPlaneEvidenceSha256,
    };
    expect(
      terminal.selectProductionTerminalRelease({ expected, finalize: direct, reconciliation: {} }),
    ).toMatchObject({
      terminalDeployed: true,
      terminalStatus: 'DEPLOYED',
      terminalExecutionArn: input.terminalExecutionArn,
      finalizeExecutionArn: input.finalizeExecutionArn,
    });

    const reconciled = {
      ...direct,
      terminalExecutionArn:
        `arn:aws:states:${region}:${accountId}:execution:` +
        `aeostudio-production-release:reconcile-${releaseId}`,
    };
    expect(
      terminal.selectProductionTerminalRelease({
        expected,
        finalize: {},
        reconciliation: reconciled,
      }),
    ).toMatchObject({
      terminalDeployed: true,
      terminalStatus: 'DEPLOYED',
      terminalExecutionArn: reconciled.terminalExecutionArn,
      finalizeExecutionArn: input.finalizeExecutionArn,
    });

    expect(
      terminal.selectProductionTerminalRelease({
        expected,
        finalize: {},
        reconciliation: {
          terminalStatus: 'ROLLED_BACK',
          terminalExecutionArn:
            `arn:aws:states:${region}:${accountId}:execution:` +
            `aeostudio-production-release:reconcile-${releaseId}`,
        },
      }),
    ).toEqual({ terminalDeployed: false });

    const wrongHashes = {
      ...reconciled,
      productionFinalizationEvidenceSha256: 'f'.repeat(64),
    };
    expect(() =>
      terminal.selectProductionTerminalRelease({
        expected,
        finalize: {},
        reconciliation: wrongHashes,
      }),
    ).toThrow('PRODUCTION_TERMINAL_RELEASE_HASH_MISMATCH');
  });

  test('refreshes stale deploy state after a failed watchdog and rejects a drifted identity', () => {
    const brokerArn =
      `arn:aws:states:${region}:${accountId}:stateMachine:` + 'aeostudio-production-release';
    const deployArn =
      `arn:aws:states:${region}:${accountId}:execution:` +
      `aeostudio-production-release:${releaseId}`;
    const refreshed = {
      executionArn: deployArn,
      name: releaseId,
      stateMachineArn: brokerArn,
      status: 'SUCCEEDED',
    };
    const describeExecution = vi.fn(() => refreshed);

    expect(
      broker.refreshExactDeployExecutionAfterWatchdog(
        { region },
        brokerArn,
        releaseId,
        deployArn,
        describeExecution,
      ),
    ).toEqual(refreshed);
    expect(describeExecution).toHaveBeenCalledWith(region, deployArn);

    expect(() =>
      broker.refreshExactDeployExecutionAfterWatchdog(
        { region },
        brokerArn,
        releaseId,
        deployArn,
        () => ({ ...refreshed, name: 'another-release' }),
      ),
    ).toThrow('CLEANUP_DEPLOY_EXECUTION_MISMATCH');
  });

  test('allows no-hash rollback cleanup but fails closed for a production DEPLOYED state', () => {
    const cleanupArguments = [
      'node',
      'run-release-broker.mjs',
      '--mode',
      'CLEANUP',
      '--environment',
      'production',
      '--region',
      region,
      '--expected-account-id',
      accountId,
      '--execution-name',
      `reconcile-${releaseId}`,
      '--deploy-execution-name',
      releaseId,
      '--release-id',
      releaseId,
    ];
    expect(broker.validateCommon(broker.parseOptions(cleanupArguments))).toMatchObject({
      environment: 'production',
      mode: 'CLEANUP',
    });
    expect(() =>
      broker.validateCommon(
        broker.parseOptions([
          ...cleanupArguments,
          '--production-finalization-evidence-sha256',
          'a'.repeat(64),
        ]),
      ),
    ).toThrow('RELEASE_FINALIZATION_EVIDENCE_INVALID');

    const deployArn =
      `arn:aws:states:${region}:${accountId}:execution:` +
      `aeostudio-production-release:${releaseId}`;
    const contractName = `/aeostudio/production/releases/${releaseId}`;
    const expectedOwner = { contractName, deployArn, releaseId };
    const terminalBase = {
      Generation: { N: '7' },
      PointerReleaseId: { S: releaseId },
      PointerContractName: { S: contractName },
    };
    expect(
      broker.requireTerminalCoordination(
        { ...terminalBase, PointerStatus: { S: 'ROLLED_BACK' } },
        expectedOwner,
        ['ROLLED_BACK'],
      ),
    ).toBe('ROLLED_BACK');

    const finalizationEvidence = {
      ProductionFinalizationEvidenceSha256: 'a'.repeat(64),
      GitHubEnvironmentEvidenceSha256: 'b'.repeat(64),
      PromotionControlPlaneEvidenceSha256: 'c'.repeat(64),
    };
    expect(() =>
      broker.requireFinalizedReleaseState(
        {
          Status: 'DEPLOYED',
          ReleaseId: releaseId,
          ContractName: contractName,
          FinalizationEvidence: finalizationEvidence,
        },
        {
          ...terminalBase,
          PointerStatus: { S: 'DEPLOYED' },
          ...Object.fromEntries(
            Object.entries(finalizationEvidence).map(([name, value]) => [name, { S: value }]),
          ),
        },
        expectedOwner,
        'production',
      ),
    ).toThrow('RELEASE_FINALIZATION_EVIDENCE_MISMATCH');
  });

  test('adopts semantically identical JSON input while rejecting extra, drifted, duplicate, or invalid input', () => {
    const expected = {
      Mode: 'RECOVER',
      ReleaseId: releaseId,
      DeployExecutionArn: 'arn:aws:states:ap-southeast-1:123456789012:execution:release:deploy',
    };
    expect(
      broker.strictJsonObjectEquals(
        `{"DeployExecutionArn":"${expected.DeployExecutionArn}","ReleaseId":"${releaseId}","Mode":"RECOVER"}`,
        expected,
      ),
    ).toBe(true);
    expect(
      broker.strictJsonObjectEquals(
        `${JSON.stringify(expected).slice(0, -1)},"Unexpected":true}`,
        expected,
      ),
    ).toBe(false);
    expect(
      broker.strictJsonObjectEquals(
        JSON.stringify({ ...expected, ReleaseId: 'production-902-1' }),
        expected,
      ),
    ).toBe(false);
    expect(
      broker.strictJsonObjectEquals(
        `{"Mode":"RECOVER","Mode":"RECOVER","ReleaseId":"${releaseId}","DeployExecutionArn":"${expected.DeployExecutionArn}"}`,
        expected,
      ),
    ).toBe(false);
    expect(broker.strictJsonObjectEquals('{"Mode":', expected)).toBe(false);
    expect(broker.strictJsonObjectEquals('[]', expected)).toBe(false);
  });

  test('waits only for the deterministic RECOVER child and keeps staging FINALIZE exact', async () => {
    const brokerArn =
      `arn:aws:states:${region}:${accountId}:stateMachine:` + 'aeostudio-production-release';
    const deployArn =
      `arn:aws:states:${region}:${accountId}:execution:` +
      `aeostudio-production-release:${releaseId}`;
    const contractName = `/aeostudio/production/releases/${releaseId}`;
    const expected = { contractName, deployArn, releaseId };
    const claimBase = {
      Generation: { N: '9' },
      LockOwner: { S: deployArn },
      ReleaseId: { S: releaseId },
      ContractName: { S: contractName },
      Phase: { S: 'CONTRACT_READY' },
      PointerReleaseId: { S: releaseId },
      PointerContractName: { S: contractName },
    };
    const recoverName = `reconcile-${releaseId}`;
    const recoverArn =
      `arn:aws:states:${region}:${accountId}:execution:` +
      `aeostudio-production-release:${recoverName}`;
    const recoverInput = {
      Mode: 'RECOVER',
      ReleaseId: releaseId,
      DeployExecutionArn: deployArn,
    };
    const recoverRunning = {
      executionArn: recoverArn,
      input: JSON.stringify(recoverInput),
      name: recoverName,
      stateMachineArn: brokerArn,
      status: 'RUNNING',
    };
    const waitForExecution = vi.fn(() =>
      Promise.resolve({
        ...recoverRunning,
        status: 'SUCCEEDED',
      }),
    );
    await expect(
      broker.inspectExactClaimedLifecycleExecution(
        { region },
        brokerArn,
        {
          ...claimBase,
          ClaimOwner: { S: recoverArn },
          ClaimMode: { S: 'RECOVER' },
        },
        expected,
        undefined,
        {
          describeExecution: () => recoverRunning,
          waitForExecution,
        },
      ),
    ).resolves.toEqual({
      executionArn: recoverArn,
      mode: 'RECOVER',
      status: 'SUCCEEDED',
    });
    expect(waitForExecution).toHaveBeenCalledWith(region, recoverArn);

    const uuidRecoverName = '6f9d410f-e8d3-4ec5-9c92-7b04be16cf67';
    const uuidRecoverArn =
      `arn:aws:states:${region}:${accountId}:execution:` +
      `aeostudio-production-release:${uuidRecoverName}`;
    const uuidRecoverExecution = {
      ...recoverRunning,
      executionArn: uuidRecoverArn,
      name: uuidRecoverName,
      status: 'SUCCEEDED',
    };
    await expect(
      broker.inspectExactClaimedLifecycleExecution(
        { region },
        brokerArn,
        {
          ...claimBase,
          ClaimOwner: { S: uuidRecoverArn },
          ClaimMode: { S: 'RECOVER' },
        },
        expected,
        undefined,
        {
          describeExecution: () => uuidRecoverExecution,
          waitForExecution: vi.fn(),
        },
      ),
    ).rejects.toThrow('RELEASE_LIFECYCLE_EXECUTION_MISMATCH');

    const rollbackName = `rollback-${releaseId}`;
    const rollbackArn =
      `arn:aws:states:${region}:${accountId}:execution:` +
      `aeostudio-production-release:${rollbackName}`;
    const rollbackExecution = {
      executionArn: rollbackArn,
      input: JSON.stringify({ Mode: 'ROLLBACK', ReleaseId: releaseId }),
      name: rollbackName,
      stateMachineArn: brokerArn,
      status: 'SUCCEEDED',
    };
    await expect(
      broker.inspectExactClaimedLifecycleExecution(
        { region },
        brokerArn,
        {
          ...claimBase,
          ClaimOwner: { S: rollbackArn },
          ClaimMode: { S: 'ROLLBACK' },
        },
        expected,
        undefined,
        {
          describeExecution: () => rollbackExecution,
          waitForExecution: vi.fn(),
        },
      ),
    ).rejects.toThrow('RELEASE_LIFECYCLE_EXECUTION_MISMATCH');

    await expect(
      broker.inspectExactClaimedLifecycleExecution(
        { region },
        brokerArn,
        {
          ...claimBase,
          ClaimOwner: { S: recoverArn },
          ClaimMode: { S: 'RECOVER' },
        },
        expected,
        undefined,
        {
          describeExecution: () => ({
            ...recoverRunning,
            input: JSON.stringify({ ...recoverInput, ReleaseId: 'another-release' }),
          }),
          waitForExecution: vi.fn(),
        },
      ),
    ).rejects.toThrow('RELEASE_LIFECYCLE_EXECUTION_MISMATCH');

    const stagingReleaseId = `staging-${runId}-${runAttempt}`;
    const stagingBrokerArn =
      `arn:aws:states:${region}:${accountId}:stateMachine:` + 'aeostudio-staging-release';
    const stagingDeployArn =
      `arn:aws:states:${region}:${accountId}:execution:` +
      `aeostudio-staging-release:${stagingReleaseId}`;
    const stagingFinalizeName = `staging-finalize-${runId}-${runAttempt}`;
    const stagingFinalizeArn =
      `arn:aws:states:${region}:${accountId}:execution:` +
      `aeostudio-staging-release:${stagingFinalizeName}`;
    const stagingContractName = `/aeostudio/staging/releases/${stagingReleaseId}`;
    const stagingFinalizeExecution = {
      executionArn: stagingFinalizeArn,
      input: JSON.stringify({ Mode: 'FINALIZE', ReleaseId: stagingReleaseId }),
      name: stagingFinalizeName,
      stateMachineArn: stagingBrokerArn,
      status: 'SUCCEEDED',
    };
    const stagingClaim = {
      Generation: { N: '4' },
      LockOwner: { S: stagingDeployArn },
      ReleaseId: { S: stagingReleaseId },
      ContractName: { S: stagingContractName },
      Phase: { S: 'CONTRACT_READY' },
      PointerReleaseId: { S: stagingReleaseId },
      PointerContractName: { S: stagingContractName },
      ClaimOwner: { S: stagingFinalizeArn },
      ClaimMode: { S: 'FINALIZE' },
    };
    await expect(
      broker.inspectExactClaimedLifecycleExecution(
        { environment: 'staging', region },
        stagingBrokerArn,
        stagingClaim,
        {
          contractName: stagingContractName,
          deployArn: stagingDeployArn,
          releaseId: stagingReleaseId,
        },
        undefined,
        {
          describeExecution: () => stagingFinalizeExecution,
          waitForExecution: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({ executionArn: stagingFinalizeArn, mode: 'FINALIZE' });
    await expect(
      broker.inspectExactClaimedLifecycleExecution(
        { environment: 'production', region },
        stagingBrokerArn,
        stagingClaim,
        {
          contractName: stagingContractName,
          deployArn: stagingDeployArn,
          releaseId: stagingReleaseId,
        },
        undefined,
        {
          describeExecution: () => stagingFinalizeExecution,
          waitForExecution: vi.fn(),
        },
      ),
    ).rejects.toThrow('RELEASE_LIFECYCLE_EXECUTION_MISMATCH');
  });

  test('rejects drifted execution, artifact, hash, and post-candidate evidence identities', () => {
    const wrongExecution = receiptFixture();
    wrongExecution.finalizeExecutionArn = String(wrongExecution.finalizeExecutionArn).replace(
      'production-finalize-901-3',
      'production-finalize-901-4',
    );
    expect(() => receipt.createProductionFinalizationReceipt(wrongExecution)).toThrow(
      'PRODUCTION_FINALIZATION_RECEIPT_EXECUTION_INVALID',
    );

    const wrongArtifactUrl = receiptFixture();
    (wrongArtifactUrl.candidateArtifact as Record<string, unknown>).url =
      `https://github.com/${repository}/actions/runs/902/artifacts/789`;
    expect(() => receipt.createProductionFinalizationReceipt(wrongArtifactUrl)).toThrow(
      'PRODUCTION_FINALIZATION_RECEIPT_ARTIFACT_INVALID',
    );

    const prefixedArtifactDigest = receiptFixture();
    (prefixedArtifactDigest.candidateArtifact as Record<string, unknown>).digest =
      `sha256:${'b'.repeat(64)}`;
    expect(() => receipt.createProductionFinalizationReceipt(prefixedArtifactDigest)).toThrow(
      'PRODUCTION_FINALIZATION_RECEIPT_ARTIFACT_INVALID',
    );

    const wrongStableHash = receiptFixture();
    wrongStableHash.githubEnvironmentEvidenceSha256 = 'c'.repeat(64);
    expect(() => receipt.createProductionFinalizationReceipt(wrongStableHash)).toThrow(
      'PRODUCTION_GITHUB_ENVIRONMENT_EVIDENCE_HASH_MISMATCH',
    );

    const futureSnapshot = receiptFixture();
    (futureSnapshot.promotionControlPlaneSnapshot as Record<string, unknown>).validatedAt =
      '2026-07-24T10:10:00.001Z';
    expect(() => receipt.createProductionFinalizationReceipt(futureSnapshot)).toThrow(
      'PRODUCTION_FINALIZATION_RECEIPT_TIME_INVALID',
    );
  });
});
