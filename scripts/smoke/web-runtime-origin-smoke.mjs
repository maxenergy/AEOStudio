import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const webRoot = resolve(repositoryRoot, 'apps/web');
const origins = ['https://staging.runtime.example', 'https://production.runtime.example'];

for (const [index, origin] of origins.entries()) {
  const forbiddenOrigin = origins[(index + 1) % origins.length];
  const html = await renderLoginWithRuntimeOrigin(origin);
  const expectedHref = `href="${origin}/api/v1/auth/login"`;
  if (!html.includes(expectedHref)) {
    throw new Error(`WEB_RUNTIME_ORIGIN_NOT_APPLIED: expected ${expectedHref}`);
  }
  if (html.includes(forbiddenOrigin) || html.includes('127.0.0.1:3200')) {
    throw new Error('WEB_BUILD_TIME_ORIGIN_LEAKED_INTO_RUNTIME_RESPONSE');
  }
}

process.stdout.write('WEB_RUNTIME_ORIGIN_SMOKE_OK\n');

async function renderLoginWithRuntimeOrigin(origin) {
  const port = await findFreePort();
  const child = spawn(
    process.execPath,
    [
      '-e',
      "delete process.env.NEXT_MANUAL_SIG_HANDLE; require('./.next/standalone/apps/web/server.js')",
    ],
    {
      cwd: webRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOSTNAME: '127.0.0.1',
        PORT: String(port),
        API_INTERNAL_ORIGIN: origin,
        API_PUBLIC_ORIGIN: origin,
        WEB_ORIGIN: origin,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let diagnostics = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-16_384);
  });
  child.stderr.on('data', (chunk) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-16_384);
  });

  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`WEB_STANDALONE_EXITED_BEFORE_READY\n${diagnostics.trim()}`);
      }
      try {
        const response = await globalThis.fetch(`http://127.0.0.1:${port}/login`);
        if (response.ok) return await response.text();
      } catch {
        // The production server has not bound its socket yet.
      }
      await delay(100);
    }
    throw new Error(`WEB_STANDALONE_READY_TIMEOUT\n${diagnostics.trim()}`);
  } finally {
    await stopChild(child);
  }
}

async function findFreePort() {
  const server = createServer();
  server.unref();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('FREE_PORT_NOT_RESOLVED');
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
  return address.port;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), delay(5_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
