import { readFileSync } from 'node:fs';
import process from 'node:process';

import {
  exactVersionedPurl,
  licenseExceptionKey,
  validateLicensePolicy,
} from './license-policy.mjs';

function fail(code) {
  throw new Error(code);
}

function parseOptions(argv) {
  if (
    argv.length !== 6 ||
    argv[2] !== '--sbom' ||
    argv[3]?.length === 0 ||
    argv[4] !== '--policy' ||
    argv[5]?.length === 0
  ) {
    fail('LICENSE_VERIFIER_ARGUMENTS_INVALID');
  }
  return { policyPath: argv[5], sbomPath: argv[3] };
}

function readJson(path, code) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(code);
  }
}

function exactLicense(entry) {
  if (typeof entry?.expression === 'string' && entry.expression.length > 0) {
    return entry.expression;
  }
  const id = entry?.license?.id;
  const name = entry?.license?.name;
  if (typeof id === 'string' && id.length > 0 && name === undefined) return id;
  if (typeof name === 'string' && name.length > 0 && id === undefined) return name;
  fail('CYCLONEDX_LICENSE_INVALID');
}

function flattenComponents(components) {
  const flattened = [];
  const visit = (component) => {
    flattened.push(component);
    if (component?.components === undefined) return;
    if (!Array.isArray(component.components)) fail('CYCLONEDX_SBOM_INVALID');
    for (const child of component.components) visit(child);
  };
  for (const component of components) visit(component);
  return flattened;
}

try {
  const { policyPath, sbomPath } = parseOptions(process.argv);
  const policy = readJson(policyPath, 'LICENSE_POLICY_INVALID');
  const sbom = readJson(sbomPath, 'CYCLONEDX_SBOM_INVALID');
  const { allowedLicenses, exceptionByScopeAndLicense } = validateLicensePolicy(policy);
  if (
    sbom?.bomFormat !== 'CycloneDX' ||
    !['1.5', '1.6', '1.7'].includes(sbom?.specVersion) ||
    !Array.isArray(sbom?.components) ||
    sbom.components.length === 0
  ) {
    fail('CYCLONEDX_SBOM_INVALID');
  }
  const components = flattenComponents(sbom.components);
  let exceptionsUsed = 0;
  for (const component of components) {
    if (
      !exactVersionedPurl(component?.purl) ||
      !Array.isArray(component?.licenses) ||
      component.licenses.length === 0
    ) {
      fail('CYCLONEDX_COMPONENT_LICENSE_MISSING');
    }
    for (const entry of component.licenses) {
      const license = exactLicense(entry);
      if (allowedLicenses.has(license)) continue;
      if (!exceptionByScopeAndLicense.has(licenseExceptionKey(component.purl, license))) {
        fail(`LICENSE_NOT_APPROVED:${component.purl}:${license}`);
      }
      exceptionsUsed += 1;
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      outcome: 'PASS',
      componentsChecked: components.length,
      exceptionsUsed,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'LICENSE_VERIFIER_FAILED'}\n`);
  process.exitCode = 1;
}
