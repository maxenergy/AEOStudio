import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

// @ts-expect-error The OpenTofu evidence helper is a native ESM JavaScript module.
import * as untypedPlanEvidence from '../../scripts/infra/staging-plan-evidence.mjs';
// @ts-expect-error The staging backend helper is a native ESM JavaScript module.
import * as untypedBackendConfig from '../../scripts/infra/staging-backend-config.mjs';

const backendConfig = untypedBackendConfig as {
  stagingBackendConfigSha256(expectedBucket: string): string;
};

const planEvidence = untypedPlanEvidence as {
  createStagingPlanEvidence(input: {
    identity: ReturnType<typeof identity>;
    plan: ReturnType<typeof validPlan>;
    planBytes: Buffer;
    terraformSources: Array<{ content: string; path: string }>;
  }): Record<string, unknown>;
  readTerraformSources(iacRoot: string): Promise<Array<{ content: string; path: string }>>;
  validateStagingPlanEvidence(input: {
    evidence: Record<string, unknown>;
    expected: {
      accountId: string;
      backendConfigSha256?: string;
      iacSourceSha256: string;
      policySourceSha256?: string;
      region: string;
      repository: string;
      sourceSha: string;
      workflowRunAttempt: string;
      workflowRunId: string;
    };
  }): void;
};

const repository = 'owner/aeostudio';
const sourceSha = 'a'.repeat(40);
const accountId = '123456789012';
const workflowRunId = '8001';
const workflowRunAttempt = '2';
const planBytes = Buffer.from('trusted-binary-plan');
const expectedBackendBucket = 'aeostudio-staging-opentofu-state-123456789012';
const backendConfigSha256 = backendConfig.stagingBackendConfigSha256(expectedBackendBucket);
const tfvarsSha256 = 'c'.repeat(64);
const policySourceSha256 = 'd'.repeat(64);
const root = resolve(import.meta.dirname, '../..');

function identity() {
  return {
    accountId,
    backendConfigSha256,
    callerArn:
      `arn:aws:sts::${accountId}:assumed-role/aeostudio-staging-plan/` +
      `aeostudio-staging-plan-${workflowRunId}`,
    createdAt: '2026-07-22T00:10:00.000Z',
    environment: 'staging',
    jobName: 'Trusted staging OpenTofu plan evidence',
    planExitCode: 2,
    planRoleArn: `arn:aws:iam::${accountId}:role/aeostudio-staging-plan`,
    policySourceSha256,
    region: 'ap-southeast-1',
    repository,
    sourceRef: 'refs/heads/main',
    sourceSha,
    tofuVersion: 'OpenTofu v1.11.6',
    tfvarsSha256,
    workflowName: 'Verify',
    workflowPath: '.github/workflows/verify.yml',
    workflowRunAttempt,
    workflowRunId,
  };
}

function terraformSources() {
  return [
    {
      path: 'infra/environments/staging/versions.tf',
      content: 'provider "aws" {\n  region = "ap-southeast-1"\n}\n',
    },
    {
      path: 'infra/modules/platform/iam.tf',
      content:
        'data "aws_iam_policy_document" "runtime" {\n' +
        '  statement {\n' +
        '    actions = ["s3:GetObject"]\n' +
        '    resources = ["arn:aws:s3:::example/*"]\n' +
        '  }\n' +
        '}\n',
    },
  ];
}

function validPlan() {
  return {
    format_version: '1.2',
    terraform_version: '1.11.6',
    configuration: {
      provider_config: {
        aws: {
          name: 'aws',
          full_name: 'registry.opentofu.org/hashicorp/aws',
          expressions: { region: { constant_value: 'ap-southeast-1' } },
        },
      },
    },
    resource_changes: [
      {
        address: 'module.platform.aws_vpc.main',
        mode: 'managed',
        type: 'aws_vpc',
        name: 'main',
        provider_name: 'registry.opentofu.org/hashicorp/aws',
        change: { actions: ['create'], after: {}, after_unknown: {} },
      },
    ],
  };
}

describe('Task 18 staging OpenTofu production promotion gate', () => {
  test('accepts only a PASS policy bound to the exact staging plan identity and source tree', () => {
    const sources = terraformSources();
    const evidence = planEvidence.createStagingPlanEvidence({
      identity: identity(),
      plan: validPlan(),
      planBytes,
      terraformSources: sources,
    });
    const policy = evidence.policy as Record<string, unknown>;

    expect(evidence).toMatchObject({
      schemaVersion: 'aeostudio.opentofu-plan-evidence.v2',
      status: 'SUCCEEDED',
      environment: 'staging',
      region: 'ap-southeast-1',
      accountId,
      repository,
      sourceRef: 'refs/heads/main',
      sourceSha,
      workflowPath: '.github/workflows/verify.yml',
      workflowName: 'Verify',
      workflowRunId,
      workflowRunAttempt,
      jobName: 'Trusted staging OpenTofu plan evidence',
      tofuVersion: 'OpenTofu v1.11.6',
      planExitCode: 2,
      createdAt: '2026-07-22T00:10:00.000Z',
      backendConfigSha256,
      tfvarsSha256,
      policySourceSha256,
      planRoleArn: `arn:aws:iam::${accountId}:role/aeostudio-staging-plan`,
      callerArn:
        `arn:aws:sts::${accountId}:assumed-role/aeostudio-staging-plan/` +
        `aeostudio-staging-plan-${workflowRunId}`,
      policy: {
        schemaVersion: 'aeostudio.opentofu-static-policy.v1',
        decision: 'PASS',
        gates: {
          region: 'PASS',
          noCrossRegionReplica: 'PASS',
          noWildcardIam: 'PASS',
          forbiddenResources: 'PASS',
        },
        violations: [],
      },
    });
    expect(evidence.planSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(evidence.planJsonSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(evidence.changesSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(evidence.policySha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(policy.iacSourceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(() =>
      planEvidence.validateStagingPlanEvidence({
        evidence,
        expected: {
          accountId,
          backendConfigSha256,
          iacSourceSha256: String(policy.iacSourceSha256),
          region: 'ap-southeast-1',
          repository,
          sourceSha,
          workflowRunAttempt,
          workflowRunId,
        },
      }),
    ).not.toThrow();
  });

  test('rejects an internally consistent caller that used any role other than aeostudio-staging-plan', () => {
    const evidence = planEvidence.createStagingPlanEvidence({
      identity: identity(),
      plan: validPlan(),
      planBytes,
      terraformSources: terraformSources(),
    });
    evidence.planRoleArn = `arn:aws:iam::${accountId}:role/unrelated-read-role`;
    evidence.callerArn =
      `arn:aws:sts::${accountId}:assumed-role/unrelated-read-role/` +
      `aeostudio-staging-plan-${workflowRunId}`;

    expect(() =>
      planEvidence.validateStagingPlanEvidence({
        evidence,
        expected: {
          accountId,
          iacSourceSha256: String((evidence.policy as Record<string, unknown>).iacSourceSha256),
          region: 'ap-southeast-1',
          repository,
          sourceSha,
          workflowRunAttempt,
          workflowRunId,
        },
      }),
    ).toThrow('PLAN_CALLER_IDENTITY_INVALID');
  });

  test('rejects plan evidence not bound to the canonical expected staging backend', () => {
    const evidence = planEvidence.createStagingPlanEvidence({
      identity: identity(),
      plan: validPlan(),
      planBytes,
      terraformSources: terraformSources(),
    });

    expect(() =>
      planEvidence.validateStagingPlanEvidence({
        evidence,
        expected: {
          accountId,
          backendConfigSha256: 'f'.repeat(64),
          iacSourceSha256: String((evidence.policy as Record<string, unknown>).iacSourceSha256),
          region: 'ap-southeast-1',
          repository,
          sourceSha,
          workflowRunAttempt,
          workflowRunId,
        },
      }),
    ).toThrow('PLAN_EVIDENCE_IDENTITY_MISMATCH');
  });

  test('detects drift in the redacted plan or evaluated policy without exposing reviewed inputs', () => {
    const evidence = planEvidence.createStagingPlanEvidence({
      identity: identity(),
      plan: validPlan(),
      planBytes,
      terraformSources: terraformSources(),
    });
    const driftedChanges = structuredClone(evidence);
    (driftedChanges.changes as Array<Record<string, unknown>>)[0].name = 'drifted';
    expect(() =>
      planEvidence.validateStagingPlanEvidence({
        evidence: driftedChanges,
        expected: {
          accountId,
          iacSourceSha256: String((evidence.policy as Record<string, unknown>).iacSourceSha256),
          policySourceSha256,
          region: 'ap-southeast-1',
          repository,
          sourceSha,
          workflowRunAttempt,
          workflowRunId,
        },
      }),
    ).toThrow('PLAN_REDACTED_BINDING_MISMATCH');

    expect(JSON.stringify(evidence)).not.toContain('reviewed-backend-secret');
    expect(JSON.stringify(evidence)).not.toContain('reviewed-tfvars-secret');
  });

  test('the current exact Terraform tree passes the source-side wildcard and service policy', async () => {
    const evidence = planEvidence.createStagingPlanEvidence({
      identity: identity(),
      plan: validPlan(),
      planBytes,
      terraformSources: await planEvidence.readTerraformSources(resolve(root, 'infra')),
    });

    expect(evidence).toMatchObject({
      status: 'SUCCEEDED',
      policy: {
        decision: 'PASS',
        gates: {
          noWildcardIam: 'PASS',
          forbiddenResources: 'PASS',
        },
      },
    });
  });

  test('fails closed when any AWS provider is not pinned to Singapore', () => {
    const plan = validPlan();
    plan.configuration.provider_config.aws.expressions.region.constant_value = 'us-east-1';
    const evidence = planEvidence.createStagingPlanEvidence({
      identity: identity(),
      plan,
      planBytes,
      terraformSources: terraformSources(),
    });

    expect(evidence).toMatchObject({
      status: 'FAILED',
      policy: {
        decision: 'FAIL',
        gates: { region: 'FAIL' },
        violations: ['AWS_PROVIDER_REGION_INVALID'],
      },
    });
    expect(() =>
      planEvidence.validateStagingPlanEvidence({
        evidence,
        expected: {
          accountId,
          iacSourceSha256: String((evidence.policy as Record<string, unknown>).iacSourceSha256),
          region: 'ap-southeast-1',
          repository,
          sourceSha,
          workflowRunAttempt,
          workflowRunId,
        },
      }),
    ).toThrow();
  });

  test('cannot create a successful staging artifact for a non-Singapore workflow identity', () => {
    const wrongIdentity = identity();
    wrongIdentity.region = 'us-east-1';
    const plan = validPlan();
    plan.configuration.provider_config.aws.expressions.region.constant_value = 'us-east-1';

    expect(() =>
      planEvidence.createStagingPlanEvidence({
        identity: wrongIdentity,
        plan,
        planBytes,
        terraformSources: terraformSources(),
      }),
    ).toThrow('PLAN_IDENTITY_INVALID');
  });

  test('fails closed on a cross-region database replica in the plan', () => {
    const plan = validPlan();
    const resource = plan.resource_changes[0];
    resource.address = 'module.platform.aws_db_instance.replica';
    resource.type = 'aws_db_instance';
    resource.name = 'replica';
    resource.change.after = {
      replicate_source_db: 'arn:aws:rds:us-east-1:123456789012:db:source',
    };
    const evidence = planEvidence.createStagingPlanEvidence({
      identity: identity(),
      plan,
      planBytes,
      terraformSources: terraformSources(),
    });

    expect(evidence).toMatchObject({
      status: 'FAILED',
      policy: {
        decision: 'FAIL',
        gates: { noCrossRegionReplica: 'FAIL' },
        violations: ['CROSS_REGION_REPLICA_FORBIDDEN'],
      },
    });
  });

  test('fails closed on wildcard IAM actions in the exact Terraform source tree', () => {
    const sources = terraformSources();
    sources[1] = {
      path: 'infra/modules/platform/iam.tf',
      content:
        'data "aws_iam_policy_document" "runtime" {\n' +
        '  statement {\n' +
        '    actions = ["iam:*"]\n' +
        '    resources = ["*"]\n' +
        '  }\n' +
        '}\n',
    };
    const evidence = planEvidence.createStagingPlanEvidence({
      identity: identity(),
      plan: validPlan(),
      planBytes,
      terraformSources: sources,
    });

    expect(evidence).toMatchObject({
      status: 'FAILED',
      policy: {
        decision: 'FAIL',
        gates: { noWildcardIam: 'FAIL' },
        violations: ['IAM_ACTION_WILDCARD_FORBIDDEN'],
      },
    });
  });

  test('fails closed when the plan introduces an explicitly forbidden service', () => {
    const plan = validPlan();
    const resource = plan.resource_changes[0];
    resource.address = 'module.platform.aws_eks_cluster.main';
    resource.type = 'aws_eks_cluster';
    resource.name = 'main';
    const evidence = planEvidence.createStagingPlanEvidence({
      identity: identity(),
      plan,
      planBytes,
      terraformSources: terraformSources(),
    });

    expect(evidence).toMatchObject({
      status: 'FAILED',
      policy: {
        decision: 'FAIL',
        gates: { forbiddenResources: 'FAIL' },
        violations: ['FORBIDDEN_RESOURCE_TYPE'],
      },
    });
  });

  test.each(['NOT_RUN', 'FAILED'])('rejects %s plan evidence during promotion', (status) => {
    const evidence = planEvidence.createStagingPlanEvidence({
      identity: identity(),
      plan: validPlan(),
      planBytes,
      terraformSources: terraformSources(),
    });
    evidence.status = status;

    expect(() =>
      planEvidence.validateStagingPlanEvidence({
        evidence,
        expected: {
          accountId,
          iacSourceSha256: String((evidence.policy as Record<string, unknown>).iacSourceSha256),
          region: 'ap-southeast-1',
          repository,
          sourceSha,
          workflowRunAttempt,
          workflowRunId,
        },
      }),
    ).toThrow('PLAN_EVIDENCE_IDENTITY_MISMATCH');
  });

  test('rejects plan evidence with missing plan schema metadata even when policy says PASS', () => {
    const evidence = planEvidence.createStagingPlanEvidence({
      identity: identity(),
      plan: validPlan(),
      planBytes,
      terraformSources: terraformSources(),
    });
    delete evidence.planFormatVersion;

    expect(() =>
      planEvidence.validateStagingPlanEvidence({
        evidence,
        expected: {
          accountId,
          iacSourceSha256: String((evidence.policy as Record<string, unknown>).iacSourceSha256),
          region: 'ap-southeast-1',
          repository,
          sourceSha,
          workflowRunAttempt,
          workflowRunId,
        },
      }),
    ).toThrow('PLAN_EVIDENCE_SCHEMA_INVALID');
  });

  test('production consumes the exact successful Verify plan job and its exact-attempt artifact', async () => {
    const workflow = await readFile(
      resolve(root, '.github', 'workflows', 'deploy-production.yml'),
      'utf8',
    );
    const validationJob = workflow.split('\n  deploy-production:')[0] ?? '';

    expect(workflow).toContain('staging-plan-run-id:');
    expect(validationJob).toContain('PLAN_RUN_ID: ${{ inputs.staging-plan-run-id }}');
    expect(validationJob).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/actions/runs/$PLAN_RUN_ID" > plan-run.json',
    );
    expect(validationJob).toContain(
      'test "$(jq -r .path plan-run.json)" = ".github/workflows/verify.yml"',
    );
    expect(validationJob).toContain('test "$(jq -r .name plan-run.json)" = "Verify"');
    expect(validationJob).toContain('test "$(jq -r .head_branch plan-run.json)" = "main"');
    expect(validationJob).toContain(
      'test "$(jq -r .head_repository.full_name plan-run.json)" = "$GITHUB_REPOSITORY"',
    );
    expect(validationJob).toContain('test "$(jq -r .head_sha plan-run.json)" = "$source_sha"');
    expect(validationJob).toContain(
      'actions/runs/$PLAN_RUN_ID/attempts/$plan_attempt/jobs?per_page=100',
    );
    expect(validationJob).toContain(
      '.name == "Trusted staging OpenTofu plan evidence" and .conclusion == "success"',
    );
    expect(validationJob).toContain('plan-attempt: ${{ steps.source-run.outputs.plan_attempt }}');
    expect(validationJob).toContain(
      'name: staging-opentofu-plan-evidence-${{ inputs.staging-plan-run-id }}-${{ steps.source-run.outputs.plan_attempt }}',
    );
    expect(validationJob).toContain('run-id: ${{ inputs.staging-plan-run-id }}');
    expect(validationJob).toContain(
      'AEO_PLAN_EXPECTED_BACKEND_BUCKET: ${{ vars.AEO_STAGING_BACKEND_BUCKET }}',
    );
    expect(validationJob).toContain('run: node scripts/infra/staging-plan-evidence.mjs validate');
  });

  test('Verify emits v2 plan evidence from the actual AWS identity and blocking static policy', async () => {
    const workflow = await readFile(resolve(root, '.github', 'workflows', 'verify.yml'), 'utf8');
    const planJob = workflow.split('\n  staging_plan:')[1] ?? '';

    expect(planJob).toContain('schemaVersion: "aeostudio.opentofu-plan-evidence.v2"');
    expect(planJob).toContain('repository: $repository');
    expect(planJob).toContain('sourceRef: $sourceRef');
    expect(planJob).toContain('sourceSha: $sourceSha');
    expect(planJob).toContain('workflowPath: ".github/workflows/verify.yml"');
    expect(planJob).toContain('region: "ap-southeast-1"');
    expect(planJob).toContain('aws sts get-caller-identity --query Account --output text');
    expect(planJob).toContain('test "$actual_account_id" = "$EXPECTED_ACCOUNT_ID"');
    expect(planJob).toContain(
      'node scripts/infra/staging-plan-evidence.mjs create --plan-json "$RUNNER_TEMP/staging-plan.json" --plan-binary "$RUNNER_TEMP/staging.tfplan" --iac-root infra --output output/task-18-staging-plan-evidence.json',
    );
    expect(planJob).toContain('AEO_PLAN_ACCOUNT_ID="$actual_account_id"');
    expect(planJob).toContain('AEO_PLAN_EXIT_CODE="$plan_exit"');
    expect(planJob).toContain('AEO_PLAN_TOFU_VERSION="$tofu_version"');
    expect(planJob).not.toMatch(/\btofu\s+apply\b/u);
  });
});
