/* global process */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_KEYS = new Set(['bucket', 'encrypt', 'key', 'region', 'use_lockfile']);
const STATE_KEY = 'aeostudio/staging/opentofu.tfstate';
const REGION = 'ap-southeast-1';

export function canonicalizeStagingBackendConfig({ expectedBucket, raw }) {
  validateBucket(expectedBucket);
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 16_384) {
    throw new Error('STAGING_BACKEND_CONFIG_INVALID');
  }

  const values = new Map();
  for (const originalLine of raw.split(/\r?\n/u)) {
    const line = originalLine.trim();
    if (line.length === 0) continue;
    const match = /^([a-z_]+)\s*=\s*(.+)$/u.exec(line);
    if (match === null || !EXPECTED_KEYS.has(match[1]) || values.has(match[1])) {
      throw new Error('STAGING_BACKEND_CONFIG_INVALID');
    }
    values.set(match[1], match[2]);
  }
  if (values.size !== EXPECTED_KEYS.size) throw new Error('STAGING_BACKEND_CONFIG_INVALID');

  const bucket = hclString(values.get('bucket'));
  const key = hclString(values.get('key'));
  const region = hclString(values.get('region'));
  if (
    bucket !== expectedBucket ||
    key !== STATE_KEY ||
    region !== REGION ||
    values.get('encrypt') !== 'true' ||
    values.get('use_lockfile') !== 'true'
  ) {
    throw new Error('STAGING_BACKEND_CONFIG_INVALID');
  }
  return canonicalBackend(expectedBucket);
}

export function stagingBackendConfigSha256(expectedBucket) {
  validateBucket(expectedBucket);
  return createHash('sha256').update(canonicalBackend(expectedBucket)).digest('hex');
}

function canonicalBackend(bucket) {
  return (
    `bucket       = ${JSON.stringify(bucket)}\n` +
    `key          = ${JSON.stringify(STATE_KEY)}\n` +
    `region       = ${JSON.stringify(REGION)}\n` +
    'encrypt      = true\n' +
    'use_lockfile = true\n'
  );
}

function hclString(value) {
  if (
    typeof value !== 'string' ||
    !/^"(?:[^"\\\r\n]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"$/u.test(value)
  ) {
    throw new Error('STAGING_BACKEND_CONFIG_INVALID');
  }
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== 'string') throw new Error('STAGING_BACKEND_CONFIG_INVALID');
    return parsed;
  } catch (error) {
    throw new Error('STAGING_BACKEND_CONFIG_INVALID', { cause: error });
  }
}

function validateBucket(value) {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(value) ||
    value.includes('..') ||
    value.includes('.-') ||
    value.includes('-.') ||
    /^[0-9]+(?:\.[0-9]+){3}$/u.test(value)
  ) {
    throw new Error('STAGING_BACKEND_BUCKET_INVALID');
  }
}

function parseOptions(values) {
  const options = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('STAGING_BACKEND_OPTIONS_INVALID');
    }
    const key = name.slice(2);
    if (options.has(key)) throw new Error('STAGING_BACKEND_OPTIONS_INVALID');
    options.set(key, value);
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`STAGING_BACKEND_${name.replaceAll('-', '_').toUpperCase()}_REQUIRED`);
  }
  return value;
}

const entrypoint = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== 'canonicalize') throw new Error('STAGING_BACKEND_COMMAND_INVALID');
    const options = parseOptions(process.argv.slice(3));
    const inputPath = requiredOption(options, 'input');
    const outputPath = requiredOption(options, 'output');
    const expectedBucket = requiredOption(options, 'expected-bucket');
    const canonical = canonicalizeStagingBackendConfig({
      expectedBucket,
      raw: await readFile(resolve(inputPath), 'utf8'),
    });
    await writeFile(resolve(outputPath), canonical, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(
      `${JSON.stringify({ outcome: 'PASS', sha256: stagingBackendConfigSha256(expectedBucket) })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'STAGING_BACKEND_CONFIG_INVALID'}\n`,
    );
    process.exitCode = 1;
  }
}
