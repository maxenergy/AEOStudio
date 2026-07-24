import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();

async function dockerfile(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8');
}

describe('Task 18 production runtime images', () => {
  test('API runtime contains only the deployed production dependency closure', async () => {
    const source = await dockerfile('apps/api/Dockerfile');

    expect(source).toContain(
      'pnpm --filter @aeostudio/api deploy --prod --legacy /opt/aeostudio-runtime',
    );
    expect(source).toContain(
      'COPY --chown=node:node --from=build /opt/aeostudio-runtime /workspace',
    );
    expect(source).not.toContain('COPY --chown=node:node --from=build /workspace /workspace');
  });

  test('Worker runtime contains only the deployed production dependency closure', async () => {
    const source = await dockerfile('apps/worker/Dockerfile');

    expect(source).toContain(
      'pnpm --filter @aeostudio/worker deploy --prod --legacy /opt/aeostudio-runtime',
    );
    expect(source).toContain(
      'COPY --chown=node:node --from=build /opt/aeostudio-runtime /workspace',
    );
    expect(source).not.toContain('COPY --chown=node:node --from=build /workspace /workspace');
  });

  test('Root multi-target API and Worker runtimes contain only their production closures', async () => {
    const source = await dockerfile('Dockerfile');

    expect(source).toContain(
      'pnpm --filter @aeostudio/api deploy --prod --legacy /opt/aeostudio-api-runtime',
    );
    expect(source).toContain(
      'pnpm --filter @aeostudio/worker deploy --prod --legacy /opt/aeostudio-worker-runtime',
    );
    expect(source).toContain(
      'COPY --chown=node:node --from=build /opt/aeostudio-api-runtime /workspace',
    );
    expect(source).toContain(
      'COPY --chown=node:node --from=build /opt/aeostudio-worker-runtime /workspace',
    );
    expect(source).not.toContain('COPY --chown=node:node --from=build /workspace /workspace');
  });

  test('Worker production dependency closure excludes the development-only TypeScript runner', async () => {
    const manifest = JSON.parse(
      await readFile(join(root, 'apps', 'worker', 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(manifest.dependencies).not.toHaveProperty('tsx');
    expect(manifest.devDependencies?.tsx).toBe('4.23.1');
    expect(manifest.scripts?.['start:production']).toBe('node dist/production-main.js');
  });

  test('Tooling-only license exceptions do not claim or authorize runtime use', async () => {
    const policy = JSON.parse(
      await readFile(join(root, 'scripts', 'security', 'license-policy.json'), 'utf8'),
    ) as {
      exceptions: Array<{
        scope: { purl: string };
        reason: string;
        compensatingControl: string;
      }>;
    };
    const toolingOnlyPurls = new Set([
      'pkg:npm/jackspeak@3.4.3',
      'pkg:npm/minimatch@10.2.5',
      'pkg:npm/minipass@7.1.3',
      'pkg:npm/package-json-from-dist@1.0.1',
      'pkg:npm/path-scurry@1.11.1',
    ]);
    const exceptions = policy.exceptions.filter(({ scope }) => toolingOnlyPurls.has(scope.purl));

    expect(exceptions).toHaveLength(toolingOnlyPurls.size);
    for (const exception of exceptions) {
      expect(exception.reason).toContain('repository tooling dependency graph');
      expect(exception.compensatingControl).toContain(
        'This exception does not authorize the package in a production runtime image.',
      );
      expect(exception.compensatingControl).not.toContain('the release SBOM is checked to prevent');
    }
  });
});
