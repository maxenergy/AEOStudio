import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

describe('Task 18 Recovery npm lock release-age gate', () => {
  test('rejects a too-new transitive package even when every top-level dependency is old enough', async () => {
    // @ts-expect-error The production verifier is a native ESM JavaScript module.
    const { verifyNpmLockReleaseAge } =
      (await import('../../scripts/security/verify-npm-lock-release-age.mjs')) as {
        verifyNpmLockReleaseAge: (input: {
          lock: unknown;
          manifest: unknown;
          readPublishedAt: (input: { name: string; version: string }) => Promise<string>;
        }) => Promise<unknown>;
      };
    const publishedAt = new Map([
      ['top-level@1.0.0', '2026-07-20T07:36:00.000Z'],
      ['transitive@2.0.0', '2026-07-22T08:00:00.000Z'],
    ]);

    await expect(
      verifyNpmLockReleaseAge({
        lock: {
          lockfileVersion: 3,
          packages: {
            '': {
              dependencies: { 'top-level': '1.0.0' },
              name: '@aeostudio/recovery-runtime',
              version: '1.0.0',
            },
            'node_modules/top-level': {
              integrity: `sha512-${'a'.repeat(64)}`,
              resolved: 'https://registry.npmjs.org/top-level/-/top-level-1.0.0.tgz',
              version: '1.0.0',
            },
            'node_modules/top-level/node_modules/transitive': {
              integrity: `sha512-${'b'.repeat(64)}`,
              resolved: 'https://registry.npmjs.org/transitive/-/transitive-2.0.0.tgz',
              version: '2.0.0',
            },
          },
        },
        manifest: {
          aeostudioDependencyPolicy: {
            lockResolvedAt: '2026-07-23T07:36:00.000Z',
            minimumReleaseAgeHours: 24,
            registryCutoff: '2026-07-22T07:36:00.000Z',
          },
          dependencies: { 'top-level': '1.0.0' },
        },
        readPublishedAt: ({ name, version }) =>
          Promise.resolve(publishedAt.get(`${name}@${version}`) ?? ''),
      }),
    ).rejects.toThrow('NPM_PACKAGE_RELEASE_TOO_NEW:transitive@2.0.0');
  });

  test('fails closed when the registry omits a release timestamp', async () => {
    // @ts-expect-error The production verifier is a native ESM JavaScript module.
    const { verifyNpmLockReleaseAge } =
      (await import('../../scripts/security/verify-npm-lock-release-age.mjs')) as {
        verifyNpmLockReleaseAge: (input: Record<string, unknown>) => Promise<unknown>;
      };

    await expect(
      verifyNpmLockReleaseAge({
        lock: {
          lockfileVersion: 3,
          packages: {
            '': {
              dependencies: { dependency: '1.0.0' },
              name: '@aeostudio/recovery-runtime',
              version: '1.0.0',
            },
            'node_modules/dependency': {
              integrity: `sha512-${'a'.repeat(64)}`,
              resolved: 'https://registry.npmjs.org/dependency/-/dependency-1.0.0.tgz',
              version: '1.0.0',
            },
          },
        },
        manifest: {
          aeostudioDependencyPolicy: {
            lockResolvedAt: '2026-07-23T07:36:00.000Z',
            minimumReleaseAgeHours: 24,
            registryCutoff: '2026-07-22T07:36:00.000Z',
          },
          dependencies: { dependency: '1.0.0' },
        },
        readPublishedAt: () => Promise.resolve(undefined),
      }),
    ).rejects.toThrow('NPM_PACKAGE_REGISTRY_TIME_INVALID:dependency@1.0.0');
  });

  test('enumerates every unique package in the committed Recovery lock', async () => {
    // @ts-expect-error The production verifier is a native ESM JavaScript module.
    const { verifyNpmLockReleaseAge } =
      (await import('../../scripts/security/verify-npm-lock-release-age.mjs')) as {
        verifyNpmLockReleaseAge: (input: Record<string, unknown>) => Promise<{
          outcome: string;
          packagesChecked: number;
        }>;
      };
    const root = process.cwd();
    const [lockText, manifestText] = await Promise.all([
      readFile(join(root, 'scripts', 'recovery', 'package-lock.json'), 'utf8'),
      readFile(join(root, 'scripts', 'recovery', 'package.json'), 'utf8'),
    ]);
    const lock = JSON.parse(lockText) as Record<string, unknown>;
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;

    const result = await verifyNpmLockReleaseAge({
      lock,
      manifest,
      readPublishedAt: () => Promise.resolve('2026-07-20T07:36:00.000Z'),
    });

    expect(result).toMatchObject({ outcome: 'PASS', packagesChecked: 45 });
  });
});
