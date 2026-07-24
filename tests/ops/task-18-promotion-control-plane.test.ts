import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

// @ts-expect-error The production helper is a native ESM JavaScript module.
import * as untypedControlPlane from '../../scripts/acceptance/github-promotion-control-plane.mjs';

const controlPlane = untypedControlPlane as {
  validatePromotionControlPlane(input: {
    artifacts: Record<string, Record<string, unknown>>;
    currentSourceSha: string;
    expectedControlPlaneSha256?: string;
    expectedRunIds: Record<string, string>;
    now: Date;
    repository: string;
    runs: Record<string, Record<string, unknown>>;
  }): Record<string, unknown>;
};

const repository = 'owner/aeostudio';
const sourceSha = 'd'.repeat(40);
const runIds = {
  build: '100',
  plan: '101',
  acceptance: '102',
  restore: '103',
};

function run(
  kind: keyof typeof runIds,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const metadata = {
    build: {
      path: '.github/workflows/build-attest.yml',
      name: 'Build, attest and deploy staging',
      event: 'push',
      createdAt: '2026-07-22T00:00:00.000Z',
      startedAt: '2026-07-22T00:01:00.000Z',
      updatedAt: '2026-07-22T01:00:00.000Z',
      attempt: 2,
    },
    plan: {
      path: '.github/workflows/verify.yml',
      name: 'Verify',
      event: 'push',
      createdAt: '2026-07-22T00:00:00.000Z',
      startedAt: '2026-07-22T00:01:00.000Z',
      updatedAt: '2026-07-22T00:30:00.000Z',
      attempt: 1,
    },
    acceptance: {
      path: '.github/workflows/staging-acceptance.yml',
      name: 'Prove immutable staging acceptance',
      event: 'workflow_dispatch',
      createdAt: '2026-07-22T02:00:00.000Z',
      startedAt: '2026-07-22T02:01:00.000Z',
      updatedAt: '2026-07-22T02:45:00.000Z',
      attempt: 3,
    },
    restore: {
      path: '.github/workflows/restore-drill.yml',
      name: 'Run the fixed private staging restore drill',
      event: 'workflow_dispatch',
      createdAt: '2026-07-22T03:00:00.000Z',
      startedAt: '2026-07-22T03:01:00.000Z',
      updatedAt: '2026-07-22T04:30:00.000Z',
      attempt: 4,
    },
  }[kind];
  return {
    id: Number(runIds[kind]),
    run_attempt: metadata.attempt,
    conclusion: 'success',
    status: 'completed',
    event: metadata.event,
    head_branch: 'main',
    head_sha: sourceSha,
    head_repository: { full_name: repository },
    path: metadata.path,
    name: metadata.name,
    created_at: metadata.createdAt,
    run_started_at: metadata.startedAt,
    updated_at: metadata.updatedAt,
    ...overrides,
  };
}

function artifact(
  runKind: keyof typeof runIds,
  name: string,
  character: string,
): Record<string, unknown> {
  return {
    id: Number(`${runIds[runKind]}1`),
    name,
    expired: false,
    size_in_bytes: 4096,
    digest: `sha256:${character.repeat(64)}`,
    created_at: run(runKind).run_started_at,
    updated_at: run(runKind).updated_at,
    workflow_run: { id: Number(runIds[runKind]), head_sha: sourceSha },
  };
}

function fixture() {
  return {
    repository,
    currentSourceSha: sourceSha,
    expectedRunIds: runIds,
    now: new Date('2026-07-23T00:00:00.000Z'),
    runs: {
      build: run('build'),
      plan: run('plan'),
      acceptance: run('acceptance'),
      restore: run('restore'),
    },
    artifacts: {
      build: {
        artifacts: [
          artifact('build', 'release-digests-100-2', 'a'),
          artifact('build', 'staging-release-contract-100-2', 'b'),
        ],
      },
      plan: {
        artifacts: [artifact('plan', 'staging-opentofu-plan-evidence-101-1', 'c')],
      },
      acceptance: {
        artifacts: [artifact('acceptance', 'staging-acceptance-evidence-102-3', 'd')],
      },
      restore: {
        artifacts: [artifact('restore', 'restore-drill-evidence-103-4', 'e')],
      },
    },
  };
}

describe('Task 18 production promotion control plane', () => {
  test('binds current source, exact attempts, ordered fresh runs and immutable artifact digests', () => {
    const evidence = controlPlane.validatePromotionControlPlane(fixture());
    expect(evidence).toMatchObject({
      schemaVersion: 'aeostudio.github-promotion-control-plane.v1',
      repository,
      sourceSha,
      maxAgeHours: 168,
      runs: {
        build: { id: '100', attempt: '2' },
        plan: { id: '101', attempt: '1' },
        acceptance: { id: '102', attempt: '3' },
        restore: { id: '103', attempt: '4' },
      },
    });
    expect(evidence.controlPlaneSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  test('rejects candidate-validator downgrade, stale evidence and pre-build acceptance', () => {
    const wrongSource = fixture();
    wrongSource.runs.build.head_sha = 'e'.repeat(40);
    expect(() => controlPlane.validatePromotionControlPlane(wrongSource)).toThrow(
      'PROMOTION_RUN_SOURCE_MISMATCH',
    );

    const stale = fixture();
    stale.now = new Date('2026-08-01T00:00:00.000Z');
    expect(() => controlPlane.validatePromotionControlPlane(stale)).toThrow('PROMOTION_RUN_STALE');

    const outOfOrder = fixture();
    outOfOrder.runs.acceptance.created_at = '2026-07-22T00:30:00.000Z';
    outOfOrder.runs.acceptance.run_started_at = '2026-07-22T00:31:00.000Z';
    expect(() => controlPlane.validatePromotionControlPlane(outOfOrder)).toThrow(
      'PROMOTION_RUN_ORDER_INVALID',
    );
  });

  test('post-approval revalidation rejects changed run or artifact identity', () => {
    const first = controlPlane.validatePromotionControlPlane(fixture()) as {
      controlPlaneSha256: string;
    };
    const changed = fixture();
    changed.artifacts.restore.artifacts[0]!.digest = `sha256:${'f'.repeat(64)}`;
    expect(() =>
      controlPlane.validatePromotionControlPlane({
        ...changed,
        expectedControlPlaneSha256: first.controlPlaneSha256,
      }),
    ).toThrow('PROMOTION_CONTROL_PLANE_HASH_MISMATCH');
  });

  test('uses current control-plane source and repeats exact evidence checks after production approval', async () => {
    const workflow = await readFile(
      join(process.cwd(), '.github', 'workflows', 'deploy-production.yml'),
      'utf8',
    );
    const validation = workflow.split('\n  deploy-production:')[0] ?? '';
    const deployment = workflow.split('\n  deploy-production:')[1] ?? '';

    expect(validation).toContain('ref: ${{ github.sha }}');
    expect(validation).toContain('CURRENT_SOURCE_SHA: ${{ github.sha }}');
    expect(validation).toContain('node scripts/acceptance/github-promotion-control-plane.mjs');
    expect(validation).not.toContain('ref: ${{ steps.source-run.outputs.source_sha }}');
    expect(deployment).toContain('environment: production');
    expect(deployment).toContain('Revalidate exact promotion evidence after production approval');
    expect(deployment).toContain(
      'EXPECTED_CONTROL_PLANE_SHA256: ${{ needs.validate-release.outputs.control-plane-sha256 }}',
    );
    expect(deployment).toContain('node scripts/acceptance/github-promotion-control-plane.mjs');
  });
});
