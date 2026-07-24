import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();
const verifier = join(root, 'scripts', 'security', 'verify-container-base-policy.mjs');

function runVerifier(repositoryRoot: string, policyPath: string) {
  return spawnSync(
    process.execPath,
    [verifier, '--repository-root', repositoryRoot, '--policy', policyPath],
    { encoding: 'utf8', windowsHide: true },
  );
}

describe('Task 18 exact container base policy', () => {
  test('binds every repository Dockerfile to a named, expiring, exact-digest base review', () => {
    const result = runVerifier(
      root,
      join(root, 'scripts', 'security', 'container-base-policy.json'),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: 'PASS',
      dockerfilesChecked: 5,
      externalBaseReferencesChecked: 9,
    });
  });

  test('fails closed when a covered Dockerfile uses a mutable base tag', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeostudio-container-policy-'));
    const dockerfile = join(directory, 'Dockerfile');
    const policy = join(directory, 'container-base-policy.json');
    await writeFile(dockerfile, 'FROM node:24-bookworm-slim AS runtime\nUSER node\n');
    await writeFile(
      policy,
      JSON.stringify({
        schemaVersion: 'aeostudio.container-base-policy.v1',
        bases: [
          {
            name: 'Reviewed fixture base',
            reference:
              'node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d',
            sourceUrl: 'https://github.com/nodejs/docker-node',
            licenseDecision: 'PROTECTED_EXTERNAL_REVIEW_REQUIRED',
            owner: 'platform-security-legal',
            expiresAt: '2027-01-31',
            dockerfiles: ['Dockerfile'],
          },
        ],
      }),
    );

    const result = runVerifier(directory, policy);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CONTAINER_BASE_NOT_PINNED:Dockerfile:node:24-bookworm-slim');
    expect(result.stdout).toBe('');
  });
});
