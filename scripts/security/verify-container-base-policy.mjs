import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function fail(code) {
  throw new Error(code);
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\n') === [...expected].sort().join('\n')
  );
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function repositoryPath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function dockerfilesBelow(root) {
  const ignored = new Set(['.git', '.next', '.turbo', 'dist', 'node_modules', 'output']);
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        entry.isFile() &&
        (entry.name === 'Dockerfile' ||
          (entry.name.startsWith('Dockerfile.') && extname(entry.name).length > 1))
      ) {
        paths.push(path);
      }
    }
  };
  visit(root);
  return paths.sort();
}

function parseExternalBases(contents, dockerfile) {
  const stages = new Set();
  const external = [];
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/iu.exec(line);
    if (match === null) continue;
    const reference = match[1];
    const alias = match[2]?.toLowerCase();
    if (!stages.has(reference.toLowerCase())) {
      if (!/@sha256:[0-9a-f]{64}$/u.test(reference)) {
        fail(`CONTAINER_BASE_NOT_PINNED:${dockerfile}:${reference}`);
      }
      external.push(reference);
    }
    if (alias !== undefined) stages.add(alias);
  }
  if (external.length === 0) fail(`CONTAINER_EXTERNAL_BASE_MISSING:${dockerfile}`);
  return external;
}

export function verifyContainerBasePolicy({
  repositoryRoot,
  policyPath,
  today = new Date().toISOString().slice(0, 10),
}) {
  const root = resolve(repositoryRoot);
  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  } catch {
    fail('CONTAINER_BASE_POLICY_INVALID');
  }
  if (
    !isIsoDate(today) ||
    !exactKeys(policy, ['schemaVersion', 'bases']) ||
    policy.schemaVersion !== 'aeostudio.container-base-policy.v1' ||
    !Array.isArray(policy.bases) ||
    policy.bases.length === 0
  ) {
    fail('CONTAINER_BASE_POLICY_INVALID');
  }

  const baseByReference = new Map();
  const coveredDockerfiles = new Set();
  for (const base of policy.bases) {
    if (
      !exactKeys(base, [
        'name',
        'reference',
        'sourceUrl',
        'licenseDecision',
        'owner',
        'expiresAt',
        'dockerfiles',
      ]) ||
      typeof base.name !== 'string' ||
      base.name.trim() === '' ||
      typeof base.reference !== 'string' ||
      !/^[^\s@]+@sha256:[0-9a-f]{64}$/u.test(base.reference) ||
      typeof base.sourceUrl !== 'string' ||
      !base.sourceUrl.startsWith('https://') ||
      base.licenseDecision !== 'PROTECTED_EXTERNAL_REVIEW_REQUIRED' ||
      typeof base.owner !== 'string' ||
      base.owner.trim() === '' ||
      !isIsoDate(base.expiresAt) ||
      base.expiresAt < today ||
      !Array.isArray(base.dockerfiles) ||
      base.dockerfiles.length === 0 ||
      baseByReference.has(base.reference)
    ) {
      fail('CONTAINER_BASE_POLICY_INVALID');
    }
    for (const dockerfile of base.dockerfiles) {
      if (
        typeof dockerfile !== 'string' ||
        dockerfile === '' ||
        dockerfile.includes('..') ||
        dockerfile.startsWith('/') ||
        dockerfile.includes('\\') ||
        coveredDockerfiles.has(dockerfile)
      ) {
        fail('CONTAINER_BASE_POLICY_INVALID');
      }
      coveredDockerfiles.add(dockerfile);
    }
    baseByReference.set(base.reference, base);
  }

  const actualDockerfiles = dockerfilesBelow(root);
  const actualPaths = actualDockerfiles.map((path) => repositoryPath(root, path));
  if (
    actualPaths.length !== coveredDockerfiles.size ||
    actualPaths.some((path) => !coveredDockerfiles.has(path))
  ) {
    fail('CONTAINER_DOCKERFILE_COVERAGE_MISMATCH');
  }

  let externalBaseReferencesChecked = 0;
  for (const path of actualDockerfiles) {
    const dockerfile = repositoryPath(root, path);
    if (!statSync(path).isFile()) fail(`CONTAINER_DOCKERFILE_INVALID:${dockerfile}`);
    for (const reference of parseExternalBases(readFileSync(path, 'utf8'), dockerfile)) {
      const governed = baseByReference.get(reference);
      if (governed === undefined || !governed.dockerfiles.includes(dockerfile)) {
        fail(`CONTAINER_BASE_NOT_GOVERNED:${dockerfile}:${reference}`);
      }
      externalBaseReferencesChecked += 1;
    }
  }

  return {
    outcome: 'PASS',
    dockerfilesChecked: actualDockerfiles.length,
    externalBaseReferencesChecked,
  };
}

function parseOptions(argv) {
  if (
    argv.length !== 6 ||
    argv[2] !== '--repository-root' ||
    argv[3]?.length === 0 ||
    argv[4] !== '--policy' ||
    argv[5]?.length === 0
  ) {
    fail('CONTAINER_BASE_POLICY_ARGUMENTS_INVALID');
  }
  return { repositoryRoot: argv[3], policyPath: argv[5] };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(
      `${JSON.stringify(verifyContainerBasePolicy(parseOptions(process.argv)))}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'CONTAINER_BASE_POLICY_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
