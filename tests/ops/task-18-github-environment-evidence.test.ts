import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

// @ts-expect-error The production helper is a native ESM JavaScript module.
import * as untypedEvidence from '../../scripts/acceptance/github-environment-evidence.mjs';

const evidence = untypedEvidence as {
  collectGitHubEnvironmentEvidence(input: {
    buildRunAttempt: string;
    buildRunId: string;
    expectedStagingUrl: string;
    repository: string;
    runApi: (path: string) => Promise<unknown>;
    sourceSha: string;
    now: string;
  }): Promise<Record<string, unknown>>;
  validateGitHubEnvironmentEvidence(input: {
    branchPolicies: Record<string, unknown>;
    buildJobs: Record<string, unknown>;
    deployments: {
      deployment: Record<string, unknown>;
      statuses: Record<string, unknown>[];
    }[];
    environment: Record<string, unknown>;
    now: string;
    expected: {
      buildRunAttempt: string;
      buildRunId: string;
      repository: string;
      sourceSha: string;
      stagingUrl: string;
    };
  }): Record<string, unknown>;
};

const repository = 'owner/aeostudio';
const sourceSha = 'd'.repeat(40);
const buildRunId = '100';
const buildRunAttempt = '2';
const stagingUrl = 'https://staging.example.com';
const firstValidationTime = '2026-07-24T10:01:00.000Z';
const secondValidationTime = '2026-07-24T10:02:00.000Z';
const jobId = 9001;
const jobUrl = `https://github.com/${repository}/actions/runs/${buildRunId}/job/${jobId}`;

async function jsonFixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(process.cwd(), 'tests', 'ops', 'fixtures', name), 'utf8'),
  ) as Record<string, unknown>;
}

function buildJobs() {
  return {
    total_count: 1,
    jobs: [
      {
        id: jobId,
        run_id: Number(buildRunId),
        run_attempt: Number(buildRunAttempt),
        head_sha: sourceSha,
        name: 'Deploy exact digests to synthetic staging',
        status: 'completed',
        conclusion: 'success',
        html_url: jobUrl,
      },
    ],
  };
}

function deployment() {
  return {
    id: 7001,
    ref: 'main',
    sha: sourceSha,
    task: 'deploy',
    environment: 'staging',
    transient_environment: false,
    production_environment: false,
    performed_via_github_app: { slug: 'github-actions' },
  };
}

function statuses() {
  return [
    {
      id: 8001,
      state: 'success',
      environment: 'staging',
      environment_url: stagingUrl,
      log_url: jobUrl,
      created_at: '2026-07-22T01:00:00Z',
      updated_at: '2026-07-22T01:00:00Z',
    },
  ];
}

async function fixture() {
  return {
    environment: await jsonFixture('github-production-environment.json'),
    branchPolicies: await jsonFixture('github-production-branch-policies.json'),
    buildJobs: buildJobs(),
    deployments: [{ deployment: deployment(), statuses: statuses() }],
    now: firstValidationTime,
    expected: {
      repository,
      sourceSha,
      buildRunId,
      buildRunAttempt,
      stagingUrl,
    },
  };
}

describe('Task 18 authoritative GitHub environment evidence', () => {
  test('collects production reviewer protection and the exact staging deployment URL', async () => {
    const environment = await jsonFixture('github-production-environment.json');
    const branchPolicies = await jsonFixture('github-production-branch-policies.json');
    const paths: string[] = [];
    const result = await evidence.collectGitHubEnvironmentEvidence({
      repository,
      sourceSha,
      buildRunId,
      buildRunAttempt,
      expectedStagingUrl: stagingUrl,
      now: firstValidationTime,
      runApi: (path) => {
        paths.push(path);
        if (path.endsWith('/environments/production')) return Promise.resolve(environment);
        if (path.includes('/deployment-branch-policies')) return Promise.resolve(branchPolicies);
        if (path.includes('/attempts/2/jobs')) return Promise.resolve(buildJobs());
        if (path.includes('/deployments/7001/statuses')) return Promise.resolve(statuses());
        if (path.includes('/deployments?')) return Promise.resolve([deployment()]);
        return Promise.reject(new Error(`UNEXPECTED_FIXTURE_PATH:${path}`));
      },
    });

    expect(result).toMatchObject({
      schemaVersion: 'aeostudio.github-environment-evidence.v1',
      repository,
      sourceSha,
      production: {
        environment: 'production',
        preventSelfReview: true,
        deploymentBranches: ['main'],
        requiredReviewers: [{ type: 'Team', id: '301', slug: 'release-approvers' }],
      },
      stagingDeployment: {
        environment: 'staging',
        environmentUrl: stagingUrl,
        buildRunId,
        buildRunAttempt,
        jobId: String(jobId),
        deploymentId: '7001',
        statusId: '8001',
      },
      validatedAt: firstValidationTime,
    });
    expect(result.evidenceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(paths).toContain(`/repos/${repository}/deployments/7001/statuses?per_page=100`);
  });

  test('keeps the immutable evidence hash stable while binding each live snapshot time', async () => {
    const firstInput = await fixture();
    const secondInput = structuredClone(firstInput);
    secondInput.now = secondValidationTime;

    const first = evidence.validateGitHubEnvironmentEvidence(firstInput);
    const second = evidence.validateGitHubEnvironmentEvidence(secondInput);

    expect(first.evidenceSha256).toBe(second.evidenceSha256);
    expect(first.validatedAt).toBe(firstValidationTime);
    expect(second.validatedAt).toBe(secondValidationTime);
    expect(createCanonicalSha(first)).not.toBe(createCanonicalSha(second));
  });

  test('fails closed if required reviewers, self-review prevention, or main-only policy drifts', async () => {
    const missingReviewer = await fixture();
    (
      (missingReviewer.environment.protection_rules as Record<string, unknown>[])[0]!
        .reviewers as unknown[]
    ).length = 0;
    expect(() => evidence.validateGitHubEnvironmentEvidence(missingReviewer)).toThrow(
      'GITHUB_PRODUCTION_REQUIRED_REVIEWERS_INVALID',
    );

    const selfReview = await fixture();
    (selfReview.environment.protection_rules as Record<string, unknown>[])[0]!.prevent_self_review =
      false;
    expect(() => evidence.validateGitHubEnvironmentEvidence(selfReview)).toThrow(
      'GITHUB_PRODUCTION_PREVENT_SELF_REVIEW_INVALID',
    );

    const extraBranch = await fixture();
    (extraBranch.branchPolicies.branch_policies as Record<string, unknown>[]).push({
      id: 402,
      node_id: 'BP_kwDOAeostudio_release',
      name: 'release/*',
      type: 'branch',
    });
    extraBranch.branchPolicies.total_count = 2;
    expect(() => evidence.validateGitHubEnvironmentEvidence(extraBranch)).toThrow(
      'GITHUB_PRODUCTION_BRANCH_POLICY_INVALID',
    );
  });

  test('rejects a staging Deployment status whose URL or Actions job identity drifts', async () => {
    const wrongUrl = await fixture();
    wrongUrl.deployments[0]!.statuses[0]!.environment_url = 'https://other.example.com';
    expect(() => evidence.validateGitHubEnvironmentEvidence(wrongUrl)).toThrow(
      'GITHUB_STAGING_DEPLOYMENT_NOT_UNIQUE',
    );

    const wrongJob = await fixture();
    wrongJob.deployments[0]!.statuses[0]!.log_url = `https://github.com/${repository}/actions/runs/999/job/${jobId}`;
    expect(() => evidence.validateGitHubEnvironmentEvidence(wrongJob)).toThrow(
      'GITHUB_STAGING_DEPLOYMENT_NOT_UNIQUE',
    );

    const supersededSuccess = await fixture();
    supersededSuccess.deployments[0]!.statuses.push({
      id: 8002,
      state: 'failure',
      environment: 'staging',
      environment_url: stagingUrl,
      log_url: jobUrl,
      created_at: '2026-07-22T01:05:00Z',
      updated_at: '2026-07-22T01:05:00Z',
    });
    expect(() => evidence.validateGitHubEnvironmentEvidence(supersededSuccess)).toThrow(
      'GITHUB_STAGING_DEPLOYMENT_NOT_UNIQUE',
    );
  });

  test('makes the staging URL authoritative and revalidates GitHub evidence after approval', async () => {
    const [buildWorkflow, promotionWorkflow, collector] = await Promise.all([
      readFile(join(process.cwd(), '.github', 'workflows', 'build-attest.yml'), 'utf8'),
      readFile(join(process.cwd(), '.github', 'workflows', 'deploy-production.yml'), 'utf8'),
      readFile(
        join(process.cwd(), 'scripts', 'acceptance', 'github-environment-evidence.mjs'),
        'utf8',
      ),
    ]);
    const stagingDeployment = buildWorkflow.split('\n  deploy-staging:')[1] ?? '';
    const preApproval = promotionWorkflow.split('\n  deploy-production:')[0] ?? '';
    const postApproval = promotionWorkflow.split('\n  deploy-production:')[1] ?? '';

    expect(stagingDeployment).toContain(
      'environment:\n      name: staging\n      url: ${{ vars.AEO_STAGING_BASE_URL }}',
    );
    expect(preApproval).toContain(
      'Collect authoritative GitHub environment and deployment evidence',
    );
    expect(preApproval).toContain('node scripts/acceptance/github-environment-evidence.mjs');
    expect(preApproval).toContain(
      'github-environment-evidence-sha256: ${{ steps.github-environment.outputs.evidence_sha256 }}',
    );
    expect(postApproval).toContain(
      'EXPECTED_GITHUB_ENVIRONMENT_EVIDENCE_SHA256: ${{ needs.validate-release.outputs.github-environment-evidence-sha256 }}',
    );
    expect(postApproval).toContain('node scripts/acceptance/github-environment-evidence.mjs');
    expect(postApproval).toContain('release/production-github-environment-evidence.json');
    expect(collector).toContain("const API_VERSION = '2026-03-10'");
  });

  test('grants only read permissions needed for authoritative deployment evidence', async () => {
    const workflow = await readFile(
      join(process.cwd(), '.github', 'workflows', 'deploy-production.yml'),
      'utf8',
    );
    const topPermissions = workflow.split('\nconcurrency:')[0] ?? '';
    const production = workflow.split('\n  deploy-production:')[1] ?? '';
    expect(topPermissions).toContain('deployments: read');
    expect(production.split('\n    runs-on:')[0]).toContain('deployments: read');
    expect(workflow).not.toContain('deployments: write');
  });
});

function createCanonicalSha(value: Record<string, unknown>) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson(value)))
    .digest('hex');
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalJson(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
