import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

const policyRelativePath = 'scripts/security/trivy-exception-policy.json';
const allowedTextExtensions = new Set([
  '.dockerfile',
  '.hcl',
  '.json',
  '.tf',
  '.toml',
  '.yaml',
  '.yml',
]);
const ignoredDirectories = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'output',
  'playwright-report',
  'test-results',
]);

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function repositoryPath(repositoryRoot, path) {
  return relative(repositoryRoot, path).split(sep).join('/');
}

function textFilesBelow(root) {
  const result = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile() || statSync(absolute).size > 1_000_000) continue;
      const extension = extname(entry.name).toLowerCase();
      if (allowedTextExtensions.has(extension) || entry.name === 'Dockerfile') {
        result.push(absolute);
      }
    }
  };
  visit(root);
  return result;
}

function parseIsoDate(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    fail('TRIVY_EXCEPTION_POLICY_INVALID', `${field} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('TRIVY_EXCEPTION_POLICY_INVALID', `${field} is not a calendar date`);
  }
  return parsed;
}

function validateDeclaration(exception, maximumLifetimeDays, now) {
  if (
    exception === null ||
    typeof exception !== 'object' ||
    typeof exception.id !== 'string' ||
    !/^[A-Z]+-\d{4}$/u.test(exception.id) ||
    typeof exception.path !== 'string' ||
    !exception.path ||
    typeof exception.resource !== 'string' ||
    !/^[a-z0-9_]+\.[a-z0-9_]+$/u.test(exception.resource)
  ) {
    fail('TRIVY_EXCEPTION_POLICY_INVALID', 'exception identity is malformed');
  }
  if (
    exception.id.includes('*') ||
    exception.path.includes('*') ||
    exception.resource.includes('*')
  ) {
    fail('TRIVY_EXCEPTION_WILDCARD', `${exception.path}:${exception.id}`);
  }
  if (typeof exception.rationale !== 'string' || exception.rationale.trim().length < 40) {
    fail('TRIVY_EXCEPTION_POLICY_INVALID', `${exception.path}:${exception.id} rationale`);
  }
  let evidenceUrl;
  try {
    evidenceUrl = new URL(exception.officialEvidence);
  } catch {
    fail('TRIVY_EXCEPTION_POLICY_INVALID', `${exception.path}:${exception.id} evidence URL`);
  }
  if (evidenceUrl.protocol !== 'https:' || evidenceUrl.hostname !== 'docs.aws.amazon.com') {
    fail('TRIVY_EXCEPTION_POLICY_INVALID', `${exception.path}:${exception.id} evidence origin`);
  }

  const expiresAt = parseIsoDate(exception.expiresOn, 'expiresOn');
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (expiresAt.getTime() <= today.getTime()) {
    fail('TRIVY_EXCEPTION_EXPIRED', `${exception.path}:${exception.id}:${exception.expiresOn}`);
  }
  const lifetimeDays = (expiresAt.getTime() - today.getTime()) / 86_400_000;
  if (lifetimeDays > maximumLifetimeDays) {
    fail(
      'TRIVY_EXCEPTION_TOO_LONG',
      `${exception.path}:${exception.id}:${String(lifetimeDays)}d`,
    );
  }
}

function observedInlineExceptions(repositoryRoot) {
  const observed = [];
  for (const path of textFilesBelow(repositoryRoot)) {
    const contents = readFileSync(path, 'utf8');
    for (const match of contents.matchAll(
      /(?:#|\/\/)\s*trivy:ignore:([A-Za-z0-9_*-]+):exp:(\d{4}-\d{2}-\d{2})/gu,
    )) {
      const id = match[1] ?? '';
      const expiresOn = match[2] ?? '';
      if (id.includes('*')) {
        fail('TRIVY_EXCEPTION_WILDCARD', `${repositoryPath(repositoryRoot, path)}:${id}`);
      }
      const after = contents.slice((match.index ?? 0) + match[0].length);
      const resourceMatch =
        /^\s*\r?\n\s*resource\s+"([a-z0-9_]+)"\s+"([a-z0-9_]+)"/u.exec(after);
      if (!resourceMatch) {
        fail(
          'TRIVY_EXCEPTION_UNBOUND',
          `${repositoryPath(repositoryRoot, path)}:${id}:${expiresOn}`,
        );
      }
      observed.push({
        id,
        path: repositoryPath(repositoryRoot, path),
        resource: `${resourceMatch[1]}.${resourceMatch[2]}`,
        expiresOn,
      });
    }

    const allIgnoreMarkers = [...contents.matchAll(/trivy:ignore:/gu)].length;
    const exactIgnoreMarkers = [
      ...contents.matchAll(
        /(?:#|\/\/)\s*trivy:ignore:[A-Za-z0-9_*-]+:exp:\d{4}-\d{2}-\d{2}/gu,
      ),
    ].length;
    if (allIgnoreMarkers !== exactIgnoreMarkers) {
      fail('TRIVY_EXCEPTION_UNDECLARED', repositoryPath(repositoryRoot, path));
    }
  }
  return observed;
}

function exceptionKey(exception) {
  return [exception.path, exception.resource, exception.id, exception.expiresOn].join('|');
}

export function verifyTrivyExceptionPolicy({ repositoryRoot, now = new Date() }) {
  const root = resolve(repositoryRoot);
  let policy;
  try {
    policy = JSON.parse(readFileSync(join(root, policyRelativePath), 'utf8'));
  } catch (error) {
    fail(
      'TRIVY_EXCEPTION_POLICY_INVALID',
      error instanceof Error ? error.message : policyRelativePath,
    );
  }
  if (
    policy?.schemaVersion !== 'aeostudio.trivy-exception-policy.v1' ||
    !Number.isInteger(policy.maximumLifetimeDays) ||
    policy.maximumLifetimeDays < 1 ||
    policy.maximumLifetimeDays > 366 ||
    !Array.isArray(policy.exceptions)
  ) {
    fail('TRIVY_EXCEPTION_POLICY_INVALID', policyRelativePath);
  }

  for (const exception of policy.exceptions) {
    validateDeclaration(exception, policy.maximumLifetimeDays, now);
  }
  const declaredKeys = policy.exceptions.map(exceptionKey);
  if (new Set(declaredKeys).size !== declaredKeys.length) {
    fail('TRIVY_EXCEPTION_POLICY_INVALID', 'duplicate exception declaration');
  }

  const observed = observedInlineExceptions(root);
  const observedKeys = observed.map(exceptionKey);
  for (const key of observedKeys) {
    if (!declaredKeys.includes(key)) fail('TRIVY_EXCEPTION_UNDECLARED', key);
  }
  for (const key of declaredKeys) {
    if (!observedKeys.includes(key)) fail('TRIVY_EXCEPTION_NOT_BOUND', key);
  }
  if (new Set(observedKeys).size !== observedKeys.length) {
    fail('TRIVY_EXCEPTION_POLICY_INVALID', 'duplicate inline exception');
  }

  return {
    outcome: 'PASS',
    exceptionCount: declaredKeys.length,
  };
}
