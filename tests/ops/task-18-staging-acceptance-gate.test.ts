import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();

async function workflow(name: string): Promise<string> {
  return readFile(join(root, '.github', 'workflows', name), 'utf8');
}

function step(source: string, name: string): string {
  const start = source.indexOf(`- name: ${name}`);
  if (start < 0) return '';
  const end = source.indexOf('\n      - name:', start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}

describe('Task 18 staging acceptance and production evidence gates', () => {
  test('accepts only an exact successful main build run inside the protected staging environment', async () => {
    const source = await workflow('staging-acceptance.yml');
    const sourceRun = step(source, 'Verify the exact successful staging build run');

    expect(source).toContain('build-run-id:');
    expect(source).toContain('required: true');
    expect(source).toContain('environment: staging-acceptance');
    expect(source).toContain('id-token: write');
    expect(sourceRun).toContain('gh api "repos/$GITHUB_REPOSITORY/actions/runs/$BUILD_RUN_ID"');
    expect(sourceRun).toContain('test "$(jq -r .conclusion build-run.json)" = "success"');
    expect(sourceRun).toContain('test "$(jq -r .head_branch build-run.json)" = "main"');
    expect(sourceRun).toContain(
      'test "$(jq -r .path build-run.json)" = ".github/workflows/build-attest.yml"',
    );
    expect(sourceRun).toContain(
      'test "$(jq -r .head_repository.full_name build-run.json)" = "$GITHUB_REPOSITORY"',
    );
    expect(source).toContain(
      'name: release-digests-${{ inputs.build-run-id }}-${{ steps.source-run.outputs.run_attempt }}',
    );
    expect(source).toContain(
      'name: staging-release-contract-${{ inputs.build-run-id }}-${{ steps.source-run.outputs.run_attempt }}',
    );
    expect(source).toContain(
      'test "$ROLE_ARN" = "arn:aws:iam::${EXPECTED_ACCOUNT_ID}:role/aeostudio-staging-acceptance-operator"',
    );
    expect(source).toContain(
      'uses: aws-actions/configure-aws-credentials@61815dcd50bd041e203e49132bacad1fd04d2708',
    );
    expect(source).not.toMatch(/secrets\.AWS_|continue-on-error:\s*true/u);
  });

  test('provisions one environment-bound acceptance role with read-only telemetry access', async () => {
    const [bootstrap, outputs, variables, staging, operator] = await Promise.all([
      readFile(join(root, 'infra', 'bootstrap', 'main.tf'), 'utf8'),
      readFile(join(root, 'infra', 'bootstrap', 'outputs.tf'), 'utf8'),
      readFile(join(root, 'infra', 'modules', 'platform', 'variables.tf'), 'utf8'),
      readFile(join(root, 'infra', 'environments', 'staging', 'main.tf'), 'utf8'),
      readFile(
        join(root, 'infra', 'modules', 'platform', 'staging-acceptance-operator.tf'),
        'utf8',
      ),
    ]);

    expect(bootstrap).toContain('"repo:${var.github_repository}:environment:staging-acceptance"');
    expect(bootstrap).toContain('resource "aws_iam_role" "staging_acceptance_operator"');
    expect(outputs).toContain('staging_acceptance_operator');
    expect(outputs).toContain('aws_iam_role.staging_acceptance_operator.arn');
    expect(variables).toContain('variable "staging_acceptance_operator_role_name"');
    expect(staging).toContain(
      'staging_acceptance_operator_role_name = "aeostudio-staging-acceptance-operator"',
    );
    for (const action of [
      'logs:StartQuery',
      'logs:GetQueryResults',
      'xray:BatchGetTraces',
      'cloudwatch:DescribeAlarms',
      'cloudwatch:DescribeAlarmHistory',
    ]) {
      expect(operator).toContain(action);
    }
    expect(operator).not.toContain('cloudwatch:SetAlarmState');
    expect(operator).not.toContain('RunExactStagingSyntheticAlarmDrill');
    expect(operator).toContain('aws_cloudwatch_log_group.api.arn');
    expect(operator).toContain('aws_cloudwatch_log_group.worker.arn');
    expect(operator).not.toContain('alarm:aeostudio-staging-*');
    expect(operator).not.toMatch(
      /xray:Put|logs:(?:PutLogEvents|CreateLogGroup)|cloudwatch:PutMetricData/u,
    );
  });

  test('runs the exact 100-session load gate and requires complete causal fault evidence without forwarding AWS credentials', async () => {
    const source = await workflow('staging-acceptance.yml');
    const releaseGate = step(source, 'Validate the exact deployed staging release');
    const load = step(source, 'Run the fixed digest staging load profile');
    const finalizeLoad = step(source, 'Finalize the write-once load evidence');
    const alarm = step(source, 'Require complete frozen causal synthetic fault evidence');

    expect(releaseGate).toContain('aeostudio.release.v1');
    expect(releaseGate).toContain('aeostudio.release-contract.v2');
    expect(releaseGate).toContain('aeostudio.staging-smoke-envelope.v1');
    expect(releaseGate).toContain('SOURCE_SHA');
    for (const service of ['api', 'web', 'worker']) {
      expect(releaseGate).toContain(`images.${service}.digest`);
    }
    expect(releaseGate).toContain(
      '.smoke.runtimeBuildIdentity.taskDefinitionArn == $contract[0].contract.TaskDefinitions.Api',
    );
    expect(releaseGate).toContain(
      '.smoke.webRuntimeBuildIdentity.taskDefinitionArn == $contract[0].contract.TaskDefinitions.Web',
    );

    expect(load).toContain(
      'grafana/k6@sha256:65c920dc067d5e2e00befbf982af6ad6ad0117034e8b1c65817c7975c52d4669',
    );
    expect(load).toContain('--platform linux/amd64');
    expect(load).toContain('--read-only');
    expect(load).toContain('--cap-drop ALL');
    expect(load).toContain('--security-opt no-new-privileges');
    expect(load).toContain('tests/load/task-18-capacity.js');
    expect(load).toContain('AEO_LOAD_TENANTS_JSON');
    expect(load).toContain("import { randomUUID } from 'node:crypto'");
    expect(load).toContain('echo "load_run_id=$load_run_id" >> "$GITHUB_OUTPUT"');
    expect(load).toContain('--env AEO_LOAD_RUN_ID');
    expect(finalizeLoad).toContain('AEO_LOAD_RUN_ID: ${{ steps.load.outputs.load_run_id }}');
    for (const credential of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_SECURITY_TOKEN',
    ]) {
      expect(load).toContain(`${credential}: ''`);
      expect(finalizeLoad).toContain(`${credential}: ''`);
    }
    expect(finalizeLoad).toContain('node scripts/load/finalize-task-18-load-evidence.mjs');
    expect(alarm).toContain('node scripts/observability/run-synthetic-alarm-drill.mjs');
    expect(alarm).toContain(
      'AEO_SYNTHETIC_FAULT_APPROVED: ${{ vars.AEO_SYNTHETIC_FAULT_APPROVED }}',
    );
    expect(alarm).toContain('AEO_ENVIRONMENT: staging');
    expect(alarm).toContain('aeostudio.synthetic-fault-evidence.v2');
    expect(alarm).toContain(
      'test "$(jq -r .outcome "$AEO_SYNTHETIC_ALARM_EVIDENCE_PATH")" = "PASSED"',
    );
  });

  test('collects read-only CloudWatch/X-Ray correlation and uploads only fully bound private evidence', async () => {
    const [source, smokeRunner, browserLogin] = await Promise.all([
      workflow('staging-acceptance.yml'),
      readFile(join(root, 'scripts', 'smoke', 'staging-smoke-runner.mjs'), 'utf8'),
      readFile(join(root, 'scripts', 'smoke', 'cognito-login.mjs'), 'utf8'),
    ]);
    const trace = step(source, 'Prove smoke and load request/job trace correlation');
    const envelope = step(source, 'Finalize the immutable staging acceptance envelope');
    const upload = step(source, 'Upload the immutable staging acceptance evidence');

    expect(smokeRunner).toContain('traceProbe');
    expect(smokeRunner).toContain('syntheticHappyPath');
    expect(smokeRunner).toContain("sealState: 'SEALED'");
    expect(smokeRunner).toContain('timingGates');
    expect(browserLogin).toContain("'x-request-id'");
    expect(trace).toContain('node scripts/acceptance/collect-staging-trace-evidence.mjs');
    expect(trace).toContain('AEO_ACCEPTANCE_LOAD_STARTED_AT');
    expect(trace).toContain(
      'AEO_ACCEPTANCE_RELEASE_CONTRACT_PATH: staging/staging-release-contract.json',
    );
    expect(trace).toContain('/ecs/aeostudio-staging/api');
    expect(trace).toContain('/ecs/aeostudio-staging/worker');
    expect(envelope).toContain('node scripts/acceptance/finalize-staging-acceptance-evidence.mjs');
    expect(envelope).toContain(
      'AEO_ACCEPTANCE_LOAD_RAW_EVIDENCE_PATH: output/staging-acceptance/task-18-load-raw-summary.json',
    );
    expect(envelope).toContain(
      'AEO_ACCEPTANCE_RELEASE_CONTRACT_PATH: staging/staging-release-contract.json',
    );
    expect(envelope).toContain('stat -c %a');
    expect(upload).toContain(
      'name: staging-acceptance-evidence-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    for (const evidence of [
      'task-18-load-raw-summary.json',
      'task-18-load-evidence.json',
      'synthetic-alarm-drill.json',
      'staging-trace-evidence.json',
      'staging-acceptance-envelope.json',
    ]) {
      expect(upload).toContain(evidence);
    }
    expect(source).not.toContain('if: ${{ always() }}');
  });

  test('blocks the production environment on same-source acceptance and restore evidence runs', async () => {
    const [source, promotionValidator] = await Promise.all([
      workflow('deploy-production.yml'),
      readFile(
        join(root, 'scripts', 'acceptance', 'validate-production-promotion-evidence.mjs'),
        'utf8',
      ),
    ]);
    const validationJob = source.split('\n  deploy-production:')[0] ?? '';
    const sourceRuns = step(source, 'Verify the source workflows and every release gate');
    const evidenceGate = step(source, 'Verify staging acceptance and restore promotion evidence');

    for (const input of ['build-run-id:', 'staging-acceptance-run-id:', 'restore-run-id:']) {
      expect(source).toContain(input);
    }
    expect(sourceRuns).toContain('.github/workflows/build-attest.yml');
    expect(sourceRuns).toContain('.github/workflows/staging-acceptance.yml');
    expect(sourceRuns).toContain('.github/workflows/restore-drill.yml');
    expect(sourceRuns).toContain('Prove immutable staging acceptance');
    expect(sourceRuns).toContain('Run the fixed private staging restore drill');
    expect(sourceRuns).toContain('.head_repository.full_name');
    expect(sourceRuns).toContain('.head_sha');
    expect(sourceRuns).toContain('acceptance_attempt=');
    expect(sourceRuns).toContain('restore_attempt=');
    expect(validationJob).toContain(
      'name: staging-acceptance-evidence-${{ inputs.staging-acceptance-run-id }}-${{ steps.source-run.outputs.acceptance_attempt }}',
    );
    expect(validationJob).toContain(
      'name: restore-drill-evidence-${{ inputs.restore-run-id }}-${{ steps.source-run.outputs.restore_attempt }}',
    );
    expect(evidenceGate).toContain(
      'node scripts/acceptance/validate-production-promotion-evidence.mjs',
    );
    expect(promotionValidator).toContain('validateAlarmEvidence(alarm.value, expected)');
    expect(promotionValidator).not.toContain('aeostudio.synthetic-alarm-drill.v1');
    expect(evidenceGate).toContain(
      'AEO_PROMOTION_LOAD_RAW_EVIDENCE_PATH: acceptance/task-18-load-raw-summary.json',
    );
    expect(evidenceGate).toContain(
      'AEO_PROMOTION_RELEASE_CONTRACT_PATH: staging/staging-release-contract.json',
    );
    expect(source).toContain(
      'APPROVED_SUPPLY_CHAIN_POLICY_SHA256: ${{ vars.AEO_APPROVED_SUPPLY_CHAIN_POLICY_SHA256 }}',
    );
    expect(source).toContain('sha256sum scripts/security/container-base-policy.json');
    expect(source).toContain('sha256sum scripts/security/license-policy.json');
    expect(source).toContain('aeostudio-supply-chain-policy.sha256');
    expect(source).toContain(
      'test "$actual_supply_chain_policy_sha256" = "$APPROVED_SUPPLY_CHAIN_POLICY_SHA256"',
    );
    expect(source).not.toContain('AEO_APPROVED_LICENSE_POLICY_SHA256');
    expect(
      validationJob.indexOf('Verify staging acceptance and restore promotion evidence'),
    ).toBeGreaterThan(validationJob.indexOf('Download the exact restore drill evidence'));
    expect(source.indexOf('environment: production')).toBeGreaterThan(
      source.indexOf('Verify staging acceptance and restore promotion evidence'),
    );
  });
});
