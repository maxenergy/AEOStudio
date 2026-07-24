import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

describe('Next standalone Web bootstrap', () => {
  test('restores Next graceful signal handling before every production entrypoint loads server.js', async () => {
    const [packageJson, appDockerfile, rootDockerfile] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
      readFile(new URL('../../../Dockerfile', import.meta.url), 'utf8'),
    ]);
    const packageStart = JSON.parse(packageJson) as { scripts: { start: string } };

    expect(packageStart.scripts.start).toContain(
      "delete process.env.NEXT_MANUAL_SIG_HANDLE; require('./.next/standalone/apps/web/server.js')",
    );
    for (const dockerfile of [appDockerfile, rootDockerfile]) {
      expect(dockerfile).toContain(
        `CMD ["node", "-e", "delete process.env.NEXT_MANUAL_SIG_HANDLE; require('./apps/web/server.js')"]`,
      );
    }
  });
});
