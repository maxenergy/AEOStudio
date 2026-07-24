import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const registryOrigin = 'https://registry.npmjs.org';
const defaultConcurrency = 6;

function fail(code) {
  throw new Error(code);
}

function record(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function instant(value, code) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    fail(code);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail(code);
  return parsed;
}

function packageNameFromPath(path) {
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  if (index < 0) fail(`NPM_LOCK_PACKAGE_PATH_INVALID:${path}`);
  const name = path.slice(index + marker.length);
  if (
    name.length === 0 ||
    name.includes('node_modules/') ||
    !/^(?:@[^/\\\s]+\/)?[^/\\\s]+$/u.test(name)
  ) {
    fail(`NPM_LOCK_PACKAGE_PATH_INVALID:${path}`);
  }
  return name;
}

function exactDependencyMap(value, code) {
  const dependencies = record(value, code);
  const entries = Object.entries(dependencies);
  if (
    entries.length === 0 ||
    entries.some(
      ([name, version]) =>
        !/^(?:@[^/\\\s]+\/)?[^/\\\s]+$/u.test(name) ||
        typeof version !== 'string' ||
        version.length === 0 ||
        /[\s*^~<>=|]/u.test(version),
    )
  ) {
    fail(code);
  }
  return dependencies;
}

function releaseAgePolicy(manifest) {
  const policy = record(manifest?.aeostudioDependencyPolicy, 'NPM_RELEASE_AGE_POLICY_INVALID');
  if (
    Object.keys(policy).sort().join('\n') !==
      ['lockResolvedAt', 'minimumReleaseAgeHours', 'registryCutoff'].sort().join('\n') ||
    !Number.isSafeInteger(policy.minimumReleaseAgeHours) ||
    policy.minimumReleaseAgeHours < 1 ||
    policy.minimumReleaseAgeHours > 720
  ) {
    fail('NPM_RELEASE_AGE_POLICY_INVALID');
  }
  const lockResolvedAt = instant(policy.lockResolvedAt, 'NPM_RELEASE_AGE_POLICY_INVALID');
  const registryCutoff = instant(policy.registryCutoff, 'NPM_RELEASE_AGE_POLICY_INVALID');
  if (
    lockResolvedAt.getTime() - registryCutoff.getTime() <
    policy.minimumReleaseAgeHours * 60 * 60 * 1_000
  ) {
    fail('NPM_RELEASE_AGE_POLICY_INVALID');
  }
  return {
    lockResolvedAt,
    minimumReleaseAgeHours: policy.minimumReleaseAgeHours,
    registryCutoff,
  };
}

function packagesFromLock(lock, manifest) {
  if (lock?.lockfileVersion !== 3) fail('NPM_LOCK_INVALID');
  const packages = record(lock?.packages, 'NPM_LOCK_INVALID');
  const root = record(packages[''], 'NPM_LOCK_INVALID');
  const manifestDependencies = exactDependencyMap(
    manifest?.dependencies,
    'NPM_RELEASE_AGE_MANIFEST_DEPENDENCIES_INVALID',
  );
  const lockDependencies = exactDependencyMap(
    root.dependencies,
    'NPM_LOCK_ROOT_DEPENDENCIES_INVALID',
  );
  if (JSON.stringify(manifestDependencies) !== JSON.stringify(lockDependencies)) {
    fail('NPM_LOCK_ROOT_DEPENDENCIES_MISMATCH');
  }

  const uniquePackages = new Map();
  for (const [path, entryValue] of Object.entries(packages)) {
    if (path === '') continue;
    const entry = record(entryValue, `NPM_LOCK_PACKAGE_INVALID:${path}`);
    const name = packageNameFromPath(path);
    const version = entry.version;
    if (
      entry.link === true ||
      typeof version !== 'string' ||
      version.length === 0 ||
      /[\s/\\]/u.test(version) ||
      typeof entry.resolved !== 'string' ||
      !entry.resolved.startsWith(`${registryOrigin}/`) ||
      typeof entry.integrity !== 'string' ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity)
    ) {
      fail(`NPM_LOCK_PACKAGE_INVALID:${path}`);
    }
    const identity = `${name}@${version}`;
    uniquePackages.set(identity, { identity, name, version });
  }
  if (uniquePackages.size === 0) fail('NPM_LOCK_INVALID');

  for (const [name, version] of Object.entries(manifestDependencies)) {
    if (!uniquePackages.has(`${name}@${version}`)) {
      fail(`NPM_LOCK_TOP_LEVEL_DEPENDENCY_MISSING:${name}@${version}`);
    }
  }
  return [...uniquePackages.values()].sort((left, right) =>
    left.identity.localeCompare(right.identity),
  );
}

async function mapConcurrent(values, concurrency, callback) {
  let cursor = 0;
  const results = new Array(values.length);
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await callback(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function defaultReadPublishedAt({ name, version }) {
  const endpoint = `${registryOrigin}/${encodeURIComponent(name)}`;
  let response;
  try {
    response = await globalThis.fetch(endpoint, {
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
        'user-agent': 'aeostudio-release-age-verifier/1',
      },
      signal: globalThis.AbortSignal.timeout(30_000),
    });
  } catch {
    fail(`NPM_PACKAGE_REGISTRY_FETCH_FAILED:${name}@${version}`);
  }
  if (!response.ok) {
    fail(`NPM_PACKAGE_REGISTRY_HTTP_${String(response.status)}:${name}@${version}`);
  }
  let metadata;
  try {
    metadata = await response.json();
  } catch {
    fail(`NPM_PACKAGE_REGISTRY_RESPONSE_INVALID:${name}@${version}`);
  }
  return metadata?.time?.[version];
}

export async function verifyNpmLockReleaseAge({
  lock,
  manifest,
  readPublishedAt = defaultReadPublishedAt,
  concurrency = defaultConcurrency,
}) {
  if (
    typeof readPublishedAt !== 'function' ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 16
  ) {
    fail('NPM_RELEASE_AGE_VERIFIER_CONFIGURATION_INVALID');
  }
  const policy = releaseAgePolicy(manifest);
  const packages = packagesFromLock(lock, manifest);
  const publishedTimes = await mapConcurrent(packages, concurrency, async (pkg) => {
    let publishedAtValue;
    try {
      publishedAtValue = await readPublishedAt({
        name: pkg.name,
        version: pkg.version,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /^NPM_PACKAGE_REGISTRY_(?:FETCH_FAILED|HTTP_\d+|RESPONSE_INVALID):/u.test(error.message)
      ) {
        throw error;
      }
      fail(`NPM_PACKAGE_REGISTRY_FETCH_FAILED:${pkg.identity}`);
    }
    const publishedAt = instant(
      publishedAtValue,
      `NPM_PACKAGE_REGISTRY_TIME_INVALID:${pkg.identity}`,
    );
    if (publishedAt.getTime() > policy.registryCutoff.getTime()) {
      fail(`NPM_PACKAGE_RELEASE_TOO_NEW:${pkg.identity}`);
    }
    return publishedAt;
  });
  const newestPublishedAt = new Date(
    Math.max(...publishedTimes.map((publishedAt) => publishedAt.getTime())),
  );
  return {
    outcome: 'PASS',
    lockResolvedAt: policy.lockResolvedAt.toISOString(),
    minimumReleaseAgeHours: policy.minimumReleaseAgeHours,
    newestPublishedAt: newestPublishedAt.toISOString(),
    packagesChecked: packages.length,
    registryCutoff: policy.registryCutoff.toISOString(),
  };
}

function readJson(path, code) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(code);
  }
}

function parseOptions(argv) {
  if (
    argv.length !== 6 ||
    argv[2] !== '--lock' ||
    argv[3]?.length === 0 ||
    argv[4] !== '--manifest' ||
    argv[5]?.length === 0
  ) {
    fail('NPM_RELEASE_AGE_ARGUMENTS_INVALID');
  }
  return { lockPath: argv[3], manifestPath: argv[5] };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const { lockPath, manifestPath } = parseOptions(process.argv);
    const result = await verifyNpmLockReleaseAge({
      lock: readJson(lockPath, 'NPM_LOCK_INVALID'),
      manifest: readJson(manifestPath, 'NPM_RELEASE_AGE_MANIFEST_INVALID'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'NPM_RELEASE_AGE_VERIFIER_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
