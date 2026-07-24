import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const workspacePackageManifests = [
  'packages/adapters/package.json',
  'packages/application/package.json',
  'packages/contracts/package.json',
  'packages/db/package.json',
  'packages/domain/package.json',
  'apps/worker/package.json',
];

for (const manifestPath of workspacePackageManifests) {
  const manifest = JSON.parse(
    await readFile(resolve(repositoryRoot, manifestPath), { encoding: 'utf8' }),
  );
  const exportedSubpaths = Object.keys(manifest.exports ?? {});
  for (const exportedSubpath of exportedSubpaths) {
    const specifier =
      exportedSubpath === '.' ? manifest.name : `${manifest.name}${exportedSubpath.slice(1)}`;
    await import(specifier);
  }
}

runEntrypointSmoke('API', 'apps/api/dist/main.js', 'API_RUNTIME_SMOKE_OK');
runEntrypointSmoke('WORKER', 'apps/worker/dist/production-main.js', 'WORKER_RUNTIME_SMOKE_OK');

process.stdout.write('PRODUCTION_RUNTIME_SMOKE_OK\n');

function runEntrypointSmoke(name, entrypoint, expectedOutput) {
  const result = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, entrypoint), '--runtime-smoke'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        OTEL_SDK_DISABLED: 'true',
      },
      timeout: 15_000,
    },
  );

  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 || !result.stdout.includes(expectedOutput)) {
    const details = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    throw new Error(`${name}_RUNTIME_SMOKE_FAILED${details.length === 0 ? '' : `\n${details}`}`);
  }
}
