/* global process */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function commitWriteOnceFile(input) {
  const sourcePath = resolve(input.sourcePath);
  const targetPath = resolve(input.targetPath);
  if (sourcePath === targetPath) throw new Error('WRITE_ONCE_SOURCE_TARGET_MUST_DIFFER');
  const bytes = await readFile(sourcePath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, bytes, { flag: 'wx', mode: 0o600 });
  await unlink(sourcePath);
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    process.stderr.write('USAGE: commit-write-once-file.mjs <source> <target>\n');
    process.exitCode = 1;
  } else {
    try {
      await commitWriteOnceFile({ sourcePath: process.argv[2], targetPath: process.argv[3] });
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : 'WRITE_ONCE_FAILED'}\n`);
      process.exitCode = 1;
    }
  }
}
