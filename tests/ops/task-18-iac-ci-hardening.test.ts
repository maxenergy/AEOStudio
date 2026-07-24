import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function section(document: string, start: string, end?: string): string {
  const startIndex = document.indexOf(start);
  expect(startIndex, `expected section ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex =
    end === undefined ? document.length : document.indexOf(end, startIndex + start.length);
  expect(endIndex, `expected section terminator ${end ?? '<eof>'}`).toBeGreaterThan(startIndex);
  return document.slice(startIndex, endIndex);
}

describe('Task 18 IaC and CI hardening', () => {
  test('provisions the exact staging-plan OIDC role with read-only state and provider metadata access', async () => {
    const bootstrap = await readFile(join(root, 'infra', 'bootstrap', 'main.tf'), 'utf8');
    const outputs = await readFile(join(root, 'infra', 'bootstrap', 'outputs.tf'), 'utf8');
    const variables = await readFile(join(root, 'infra', 'bootstrap', 'variables.tf'), 'utf8');

    expect(bootstrap).toContain(
      'staging_plan          = "repo:${var.github_repository}:environment:staging-plan"',
    );
    expect(bootstrap).toMatch(
      /resource "aws_iam_role" "staging_plan" \{[\s\S]*?name\s*=\s*"aeostudio-staging-plan"[\s\S]*?assume_role_policy\s*=\s*data\.aws_iam_policy_document\.github_assume\["staging_plan"\]\.json[\s\S]*?\}/u,
    );
    expect(bootstrap).toMatch(
      /data "aws_iam_policy_document" "staging_plan" \{[\s\S]*?"s3:GetObject"[\s\S]*?var\.staging_plan_state_bucket_arn[\s\S]*?var\.staging_plan_state_key[\s\S]*?"sts:GetCallerIdentity"[\s\S]*?\}/u,
    );
    expect(bootstrap).toMatch(
      /resource "aws_iam_role_policy" "staging_plan" \{[\s\S]*?role\s*=\s*aws_iam_role\.staging_plan\.id[\s\S]*?policy\s*=\s*data\.aws_iam_policy_document\.staging_plan\.json[\s\S]*?\}/u,
    );
    expect(variables).toContain('variable "staging_plan_state_bucket_arn"');
    expect(variables).toContain('variable "staging_plan_state_key"');
    expect(outputs).toContain('staging_plan                   = aws_iam_role.staging_plan.arn');

    const planPolicy = section(
      bootstrap,
      'data "aws_iam_policy_document" "staging_plan"',
      'resource "aws_iam_role_policy" "staging_plan"',
    );
    const planStatements = [...planPolicy.matchAll(/\n {2}statement \{([\s\S]*?)\n {2}\}/gu)].map(
      (match) => match[1] ?? '',
    );
    const providerMetadata = planStatements.find((statement) =>
      statement.includes('sid    = "ReadStagingProviderMetadata"'),
    );
    const exactParameters = planStatements.find((statement) =>
      statement.includes('sid    = "ReadExactStagingParameters"'),
    );
    expect(providerMetadata).toBeDefined();
    expect(providerMetadata).not.toContain('"ssm:GetParameter"');
    expect(exactParameters).toContain('"ssm:GetParameter"');
    expect(exactParameters).toContain('"ssm:ListTagsForResource"');
    expect(planPolicy.match(/"ssm:GetParameter"/gu)).toHaveLength(1);
    for (const parameter of [
      'release-contract',
      'bootstrap-contract',
      'recovery/restore-drill-input',
    ]) {
      expect(exactParameters).toContain(
        `arn:aws:ssm:ap-southeast-1:\${data.aws_caller_identity.current.account_id}:parameter/aeostudio/staging/${parameter}`,
      );
    }
    expect(exactParameters).not.toContain('resources = ["*"]');
    expect(planPolicy).not.toMatch(
      /"(?:s3:PutObject|s3:DeleteObject|iam:PassRole|iam:CreateRole|iam:UpdateRole|iam:DeleteRole|ecs:UpdateService|rds:ModifyDBInstance|secretsmanager:GetSecretValue)"/u,
    );
    for (const refreshAction of [
      'rds:DescribeDBParameters',
      's3:GetBucketLocation',
      'sns:GetSubscriptionAttributes',
      'ssm:ListTagsForResource',
    ]) {
      expect(planPolicy).toContain(`"${refreshAction}"`);
    }
  });

  test('attaches the exact S3 backup and restore policies to the selected AWS Backup role', async () => {
    const recovery = await readFile(
      join(root, 'infra', 'modules', 'platform', 'recovery.tf'),
      'utf8',
    );

    expect(recovery).toMatch(
      /resource "aws_iam_role_policy_attachment" "backup_s3" \{[\s\S]*?role\s*=\s*aws_iam_role\.backup\.name[\s\S]*?policy_arn\s*=\s*"arn:aws:iam::aws:policy\/AWSBackupServiceRolePolicyForS3Backup"[\s\S]*?\}/u,
    );
    expect(recovery).toMatch(
      /resource "aws_iam_role_policy_attachment" "restore_s3" \{[\s\S]*?role\s*=\s*aws_iam_role\.backup\.name[\s\S]*?policy_arn\s*=\s*"arn:aws:iam::aws:policy\/AWSBackupServiceRolePolicyForS3Restore"[\s\S]*?\}/u,
    );
  });

  test('runs pinned OpenTofu formatting, backend-free initialization and validation on every verify event', async () => {
    const workflow = await readFile(join(root, '.github', 'workflows', 'verify.yml'), 'utf8');
    const pins = JSON.parse(
      await readFile(join(root, 'scripts', 'security', 'action-pins.json'), 'utf8'),
    ) as Record<string, string>;
    const infrastructure = section(workflow, '  infrastructure:', '  staging_plan:');

    expect(pins['opentofu/setup-opentofu']).toBe('a1320f892987e89d278cc92dc5adc984fb93aca4');
    expect(infrastructure).toContain(
      'uses: opentofu/setup-opentofu@a1320f892987e89d278cc92dc5adc984fb93aca4',
    );
    expect(infrastructure).toMatch(/tofu_version:\s*1\.11\.6/u);
    expect(infrastructure).toContain('tofu fmt -check -recursive infra');
    for (const directory of [
      'infra/bootstrap',
      'infra/environments/staging',
      'infra/environments/production',
    ]) {
      expect(infrastructure).toContain(`tofu -chdir=${directory} init -backend=false -input=false`);
      expect(infrastructure).toContain(`tofu -chdir=${directory} validate`);
    }
    expect(infrastructure).not.toContain('secrets.');
    expect(infrastructure).not.toContain('id-token: write');
  });

  test('makes a real staging plan only in a trusted OIDC job and emits explicit NOT_RUN evidence', async () => {
    const workflow = await readFile(join(root, '.github', 'workflows', 'verify.yml'), 'utf8');
    const plan = section(workflow, '  staging_plan:');

    expect(plan).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main' && github.event.repository.fork == false",
    );
    expect(plan).toContain('environment: staging-plan');
    expect(plan).toContain('id-token: write');
    expect(plan).toContain('AWS_STAGING_PLAN_ROLE_ARN');
    expect(plan).toContain('AEO_STAGING_BACKEND_BUCKET');
    expect(plan).toContain(
      'test "$PLAN_ROLE_ARN" = "arn:aws:iam::${ACCOUNT_ID}:role/aeostudio-staging-plan"',
    );
    expect(plan).toContain('AEO_STAGING_BACKEND_HCL');
    expect(plan).toContain('AEO_STAGING_PLAN_TFVARS_JSON');
    expect(plan).toContain('status: "NOT_RUN"');
    expect(plan).toContain("if: steps.plan_readiness.outputs.ready == 'true'");
    expect(plan).toContain(
      'uses: aws-actions/configure-aws-credentials@61815dcd50bd041e203e49132bacad1fd04d2708',
    );
    const canonicalizeIndex = plan.indexOf(
      'node scripts/infra/staging-backend-config.mjs canonicalize',
    );
    const oidcIndex = plan.indexOf(
      'uses: aws-actions/configure-aws-credentials@61815dcd50bd041e203e49132bacad1fd04d2708',
    );
    expect(canonicalizeIndex).toBeGreaterThan(-1);
    expect(oidcIndex).toBeGreaterThan(canonicalizeIndex);
    expect(plan).toContain('--input "$RUNNER_TEMP/staging-backend.raw.hcl"');
    expect(plan).toContain('--output "$RUNNER_TEMP/staging-backend.hcl"');
    expect(plan).toContain('--expected-bucket "$EXPECTED_BACKEND_BUCKET"');
    expect(plan).not.toMatch(
      /grep[\s\S]*?(?:access_key|endpoint|proxy|skip_credentials_validation)/u,
    );
    expect(plan).toContain(
      'tofu -chdir=infra/environments/staging init -input=false -backend-config="$RUNNER_TEMP/staging-backend.hcl"',
    );
    expect(plan).toContain(
      'tofu -chdir=infra/environments/staging plan -input=false -lock=false -detailed-exitcode',
    );
    expect(plan).toContain('output/task-18-staging-plan-evidence.json');
    expect(plan).toContain(
      'test "$PLAN_ROLE_ARN" = "arn:aws:iam::${EXPECTED_ACCOUNT_ID}:role/aeostudio-staging-plan"',
    );
    expect(plan).toContain('if: always()');
    expect(plan).not.toMatch(/\btofu\s+apply\b/u);
    expect(workflow).not.toMatch(/\btofu\s+apply\b/u);
  });

  test('documents static validation, trusted plan prerequisites and the no-apply boundary', async () => {
    const runbook = await readFile(join(root, 'docs', 'operations', 'supply-chain.md'), 'utf8');

    expect(runbook).not.toContain('No workflow runs OpenTofu');
    expect(runbook).toContain('OpenTofu 1.11.6');
    expect(runbook).toContain('AWS_STAGING_PLAN_ROLE_ARN');
    expect(runbook).toContain('github_roles.staging_plan');
    expect(runbook).toContain('staging_plan_state_bucket_arn');
    expect(runbook).toContain('arn:aws:iam::<AWS_ACCOUNT_ID>:role/aeostudio-staging-plan');
    expect(runbook).toContain('AEO_STAGING_BACKEND_HCL');
    expect(runbook).toContain('AEO_STAGING_PLAN_TFVARS_JSON');
    expect(runbook).toContain('NOT_RUN');
    expect(runbook).toMatch(/pull request[\s\S]*backend=false/iu);
    expect(runbook).toMatch(/never runs? `?tofu apply`?/iu);
    for (const exactSmokeSecret of [
      'AEO_STAGING_SMOKE_COGNITO_USERNAME',
      'AEO_STAGING_SMOKE_COGNITO_PASSWORD',
      'AEO_STAGING_SMOKE_COGNITO_TOTP_SECRET',
      'AEO_STAGING_SMOKE_REVIEWER_COGNITO_USERNAME',
      'AEO_STAGING_SMOKE_REVIEWER_COGNITO_PASSWORD',
      'AEO_STAGING_SMOKE_REVIEWER_COGNITO_TOTP_SECRET',
    ]) {
      expect(runbook).toContain(`\`${exactSmokeSecret}\``);
    }
    expect(runbook).not.toContain('`AEO_STAGING_SMOKE_COGNITO_*`');
    expect(runbook).not.toContain('`AEO_STAGING_SMOKE_REVIEWER_COGNITO_*`');
  });

  test('keeps every workflow variable and secret in one fail-closed machine-readable contract', async () => {
    const contract = JSON.parse(
      await readFile(join(root, 'scripts', 'infra', 'github-environment-contract.json'), 'utf8'),
    ) as {
      environmentExpressions: Record<string, string[]>;
      environments: Record<string, { secrets: string[]; variables: string[] }>;
      missingConfiguration: {
        externalEvidenceCollection: boolean;
        outcome: string;
        phase: string;
      };
      repository: { secrets: string[]; variables: string[] };
      schemaVersion: string;
    };
    const workflowDirectory = join(root, '.github', 'workflows');
    const workflowNames = (await readdir(workflowDirectory))
      .filter((workflowName) => workflowName.endsWith('.yml'))
      .sort();
    const workflows = await Promise.all(
      workflowNames.map(async (workflowName) => ({
        workflowName,
        document: await readFile(join(workflowDirectory, workflowName), 'utf8'),
      })),
    );
    const workflowText = workflows.map(({ document }) => document).join('\n');
    const referenced = (kind: 'secrets' | 'vars') =>
      [...workflowText.matchAll(new RegExp(`\\$\\{\\{\\s*${kind}\\.([A-Z0-9_]+)\\s*\\}\\}`, 'gu'))]
        .map((match) => match[1])
        .sort();
    const declared = (kind: 'secrets' | 'variables') =>
      [
        ...contract.repository[kind],
        ...Object.values(contract.environments).flatMap((environment) => environment[kind]),
      ].sort();

    expect(contract.schemaVersion).toBe('aeostudio.github-environment-contract.v2');
    expect(Object.keys(contract.environments).sort()).toEqual([
      'bootstrap-production',
      'bootstrap-staging',
      'production',
      'restore-drill-staging',
      'staging',
      'staging-acceptance',
      'staging-plan',
    ]);
    expect(new Set(declared('variables'))).toEqual(new Set(referenced('vars')));
    expect(new Set(declared('secrets'))).toEqual(new Set(referenced('secrets')));
    for (const { document, workflowName } of workflows) {
      const jobsDocument = document.slice(document.search(/^jobs:\s*$/mu));
      const starts = [...jobsDocument.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gmu)];
      for (const [index, start] of starts.entries()) {
        const jobName = start[1] ?? '';
        const job = jobsDocument.slice(
          start.index,
          starts[index + 1]?.index ?? jobsDocument.length,
        );
        const scalarEnvironment = /^ {4}environment:[ \t]+(\S.*?)\s*$/mu.exec(job)?.[1];
        const objectEnvironment = /^ {4}environment:\s*$\r?\n {6}name:\s*(\S.*?)\s*$/mu.exec(
          job,
        )?.[1];
        const environment = scalarEnvironment ?? objectEnvironment;
        const scopes =
          environment === undefined
            ? []
            : (contract.environmentExpressions[environment] ?? [environment]);
        for (const scope of scopes) {
          expect(
            contract.environments[scope],
            `${workflowName}:${jobName} uses undeclared environment ${scope}`,
          ).toBeDefined();
        }
        for (const [referenceKind, contractKind] of [
          ['vars', 'variables'],
          ['secrets', 'secrets'],
        ] as const) {
          const allowed = new Set([
            ...contract.repository[contractKind],
            ...scopes.flatMap((scope) => contract.environments[scope]?.[contractKind] ?? []),
          ]);
          const jobReferences = [
            ...job.matchAll(
              new RegExp(`\\$\\{\\{\\s*${referenceKind}\\.([A-Z0-9_]+)\\s*\\}\\}`, 'gu'),
            ),
          ].map((match) => match[1]);
          expect(
            jobReferences.filter((reference) => !allowed.has(reference)),
            `${workflowName}:${jobName} has ${referenceKind} outside its actual scope`,
          ).toEqual([]);
        }
      }
    }
    expect(contract.missingConfiguration).toEqual({
      phase: 'preflight',
      outcome: 'FAIL_CLOSED',
      externalEvidenceCollection: false,
    });
  });
});
