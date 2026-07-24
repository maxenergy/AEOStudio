import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import { exactVersionedPurl } from './license-policy.mjs';

function fail(code) {
  throw new Error(code);
}

function parseOptions(argv) {
  if (
    argv.length !== 10 ||
    argv[2] !== '--sbom' ||
    argv[3]?.length === 0 ||
    argv[4] !== '--out' ||
    argv[5]?.length === 0 ||
    argv[6] !== '--first-party-purl-prefix' ||
    !/^pkg:npm\/[A-Za-z0-9%._~-]+\/$/u.test(argv[7] ?? '') ||
    argv[8] !== '--runtime-root' ||
    !/^\/[A-Za-z0-9._/-]+$/u.test(argv[9] ?? '') ||
    argv[9]?.includes('..')
  ) {
    fail('RUNTIME_LICENSE_SBOM_ARGUMENTS_INVALID');
  }
  return {
    sbomPath: argv[3],
    outputPath: argv[5],
    firstPartyPurlPrefix: argv[7],
    runtimeRoot: argv[9].replace(/\/$/u, ''),
  };
}

function readSbom(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('RUNTIME_LICENSE_SBOM_INVALID');
  }
}

function propertyValues(component, namePrefix) {
  if (component?.properties === undefined) return [];
  if (!Array.isArray(component.properties)) fail('RUNTIME_LICENSE_SBOM_INVALID');
  return component.properties
    .filter(
      (property) =>
        typeof property?.name === 'string' &&
        property.name.startsWith(namePrefix) &&
        typeof property.value === 'string',
    )
    .map((property) => property.value);
}

function isInstalledNpmComponent(component) {
  return (
    component?.type === 'library' &&
    propertyValues(component, 'syft:package:foundBy').includes('javascript-package-cataloger') &&
    propertyValues(component, 'syft:package:type').includes('npm')
  );
}

function isPackageRootManifest(path, runtimeRoot) {
  const normalized = path.replaceAll('\\', '/');
  const prefix = `${runtimeRoot}/node_modules/`;
  if (!normalized.startsWith(prefix)) return false;
  return /\/node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/u.test(normalized);
}

function writeExclusive(path, value) {
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
  } catch {
    fail('RUNTIME_LICENSE_SBOM_WRITE_FAILED');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

try {
  const { sbomPath, outputPath, firstPartyPurlPrefix, runtimeRoot } = parseOptions(process.argv);
  const source = readSbom(sbomPath);
  if (
    source?.bomFormat !== 'CycloneDX' ||
    !['1.5', '1.6', '1.7'].includes(source?.specVersion) ||
    !Array.isArray(source?.components) ||
    source.components.length === 0
  ) {
    fail('RUNTIME_LICENSE_SBOM_INVALID');
  }

  const selected = [];
  let firstPartyComponentsExcluded = 0;
  let nestedPackageManifestsExcluded = 0;
  for (const component of source.components) {
    if (!isInstalledNpmComponent(component)) continue;
    const locations = propertyValues(component, 'syft:location:');
    if (!locations.some((location) => isPackageRootManifest(location, runtimeRoot))) {
      nestedPackageManifestsExcluded += 1;
      continue;
    }
    if (typeof component.purl === 'string' && component.purl.startsWith(firstPartyPurlPrefix)) {
      firstPartyComponentsExcluded += 1;
      continue;
    }
    if (
      !exactVersionedPurl(component.purl) ||
      !component.purl.startsWith('pkg:npm/') ||
      !Array.isArray(component.licenses) ||
      component.licenses.length === 0
    ) {
      fail(`RUNTIME_LICENSE_COMPONENT_INVALID:${component?.purl ?? 'PURL_MISSING'}`);
    }
    selected.push(component);
  }
  if (selected.length === 0) fail('RUNTIME_LICENSE_SBOM_EMPTY');

  writeExclusive(outputPath, {
    bomFormat: 'CycloneDX',
    specVersion: source.specVersion,
    serialNumber: source.serialNumber,
    version: 1,
    metadata: source.metadata,
    components: selected,
  });
  process.stdout.write(
    `${JSON.stringify({
      outcome: 'PASS',
      componentsSelected: selected.length,
      firstPartyComponentsExcluded,
      nestedPackageManifestsExcluded,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'RUNTIME_LICENSE_SBOM_FAILED'}\n`,
  );
  process.exitCode = 1;
}
