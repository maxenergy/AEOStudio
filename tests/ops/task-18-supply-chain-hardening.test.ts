import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();

async function securityWorkflow(): Promise<string> {
  return readFile(join(root, '.github', 'workflows', 'security.yml'), 'utf8');
}

async function releaseWorkflow(): Promise<string> {
  return readFile(join(root, '.github', 'workflows', 'build-attest.yml'), 'utf8');
}

async function productionWorkflow(): Promise<string> {
  return readFile(join(root, '.github', 'workflows', 'deploy-production.yml'), 'utf8');
}

function runLicenseVerifierWithPolicy(sbomFixture: string, policyPath: string) {
  return spawnSync(
    process.execPath,
    [
      join(root, 'scripts', 'security', 'verify-cyclonedx-licenses.mjs'),
      '--sbom',
      join(root, 'scripts', 'security', 'fixtures', 'cyclonedx', sbomFixture),
      '--policy',
      policyPath,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
}

function runLicenseVerifier(sbomFixture: string, policyFixture = 'valid-policy.json') {
  return runLicenseVerifierWithPolicy(
    sbomFixture,
    join(root, 'scripts', 'security', 'fixtures', 'cyclonedx', policyFixture),
  );
}

function runRuntimeLicenseExtractor(sbomFixture: string, outputPath: string) {
  return spawnSync(
    process.execPath,
    [
      join(root, 'scripts', 'security', 'extract-runtime-license-sbom.mjs'),
      '--sbom',
      join(root, 'scripts', 'security', 'fixtures', 'cyclonedx', sbomFixture),
      '--out',
      outputPath,
      '--first-party-purl-prefix',
      'pkg:npm/%40aeostudio/',
      '--runtime-root',
      '/workspace',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
}

describe('Task 18 supply-chain hardening', () => {
  test('removes build-only package managers and AWS CLI wheel tooling from final images', async () => {
    const applicationDockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
    const recoveryDockerfile = await readFile(join(root, 'Dockerfile.recovery'), 'utf8');
    const nextConfig = await readFile(join(root, 'apps', 'web', 'next.config.ts'), 'utf8');
    const serviceDockerfiles = await Promise.all(
      ['api', 'web', 'worker'].map((service) =>
        readFile(join(root, 'apps', service, 'Dockerfile'), 'utf8'),
      ),
    );
    const dockerfileFrontend =
      '# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e';

    expect(applicationDockerfile).toContain(dockerfileFrontend);
    expect(applicationDockerfile).toContain(
      'node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd',
    );
    expect(applicationDockerfile).toContain('AS hardened-node-runtime');
    expect(applicationDockerfile).toContain('rm -rf /usr/local/lib/node_modules/npm');
    expect(applicationDockerfile).toContain('/usr/local/lib/node_modules/corepack');
    for (const target of ['api', 'web', 'worker']) {
      expect(applicationDockerfile).toContain(`FROM hardened-node-runtime AS ${target}`);
    }
    expect(nextConfig).toMatch(/images:\s*\{\s*unoptimized:\s*true/u);
    expect(applicationDockerfile).toContain('/workspace/node_modules/.pnpm/@img+*');
    for (const dockerfile of serviceDockerfiles) {
      expect(dockerfile).toContain(dockerfileFrontend);
      expect(dockerfile).toContain(
        'node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd',
      );
      expect(dockerfile).toContain('rm -rf /usr/local/lib/node_modules/npm');
      expect(dockerfile).toContain('/usr/local/lib/node_modules/corepack');
    }
    expect(serviceDockerfiles[1]).toContain('/workspace/node_modules/.pnpm/@img+*');

    expect(recoveryDockerfile).toContain('rm -rf /usr/local/lib/node_modules/npm');
    expect(recoveryDockerfile).toContain(dockerfileFrontend);
    expect(recoveryDockerfile).toContain('/usr/local/lib/node_modules/corepack');
    expect(recoveryDockerfile).toContain('npm ci --omit=dev');
    expect(recoveryDockerfile).not.toMatch(/AWS_CLI_VERSION|awscli|dist\/wheel|wheel-.*dist-info/u);
  });

  test('does not blanket-ignore unfixed high or critical Trivy findings', async () => {
    const workflow = `${await securityWorkflow()}\n${await releaseWorkflow()}`;

    expect(workflow).not.toContain('--ignore-unfixed');
    expect(workflow).not.toMatch(/ignore-unfixed:\s*true/u);
  });

  test('runs OSV against the generated CycloneDX SBOM instead of only the lockfile', async () => {
    const workflow = await securityWorkflow();
    const sbomIndex = workflow.indexOf('- name: Generate CycloneDX source SBOM');
    const osvIndex = workflow.indexOf('- name: Run OSV CycloneDX SBOM scan');
    const osvStep = workflow.slice(osvIndex, workflow.indexOf('\n      - name:', osvIndex + 1));

    expect(sbomIndex).toBeGreaterThan(-1);
    expect(osvIndex).toBeGreaterThan(sbomIndex);
    expect(osvStep).toContain('--volume "$RUNNER_TEMP/security-evidence:/evidence:ro"');
    expect(osvStep).toContain('scan --sbom=/evidence/source-sbom.cdx.json');
    expect(osvStep).not.toContain('--lockfile=');
  });

  test('generates the source SBOM from the installed frozen dependency graph', async () => {
    const workflow = await securityWorkflow();
    const sbomIndex = workflow.indexOf('- name: Generate CycloneDX source SBOM');
    const sbomStep = workflow.slice(sbomIndex, workflow.indexOf('\n      - name:', sbomIndex + 1));

    expect(sbomStep).toContain('pnpm sbom');
    expect(sbomStep).toContain('--sbom-format cyclonedx');
    expect(sbomStep).toContain('--sbom-spec-version 1.7');
    expect(sbomStep).toContain('--no-optional');
    expect(sbomStep).not.toContain('--lockfile-only');
  });

  test('extracts only installed root npm packages for the runtime license decision', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'aeostudio-runtime-license-'));
    try {
      const outputPath = join(temporaryDirectory, 'runtime-license.cdx.json');
      const extracted = runRuntimeLicenseExtractor('runtime-image.cdx.json', outputPath);

      expect(extracted.status, extracted.stderr).toBe(0);
      expect(JSON.parse(extracted.stdout)).toMatchObject({
        outcome: 'PASS',
        componentsSelected: 1,
        firstPartyComponentsExcluded: 1,
        nestedPackageManifestsExcluded: 1,
      });
      const verified = spawnSync(
        process.execPath,
        [
          join(root, 'scripts', 'security', 'verify-cyclonedx-licenses.mjs'),
          '--sbom',
          outputPath,
          '--policy',
          join(root, 'scripts', 'security', 'fixtures', 'cyclonedx', 'valid-policy.json'),
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      expect(verified.status, verified.stderr).toBe(0);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('fails closed when an installed third-party root package has no exact license', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'aeostudio-runtime-license-'));
    try {
      const outputPath = join(temporaryDirectory, 'runtime-license.cdx.json');
      const extracted = runRuntimeLicenseExtractor(
        'runtime-image-missing-license.cdx.json',
        outputPath,
      );

      expect(extracted.status).toBe(1);
      expect(extracted.stderr).toContain(
        'RUNTIME_LICENSE_COMPONENT_INVALID:pkg:npm/missing-license@1.0.0',
      );
      expect(extracted.stdout).toBe('');
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('accepts a CycloneDX component covered by the named exact SPDX allowlist', () => {
    const result = runLicenseVerifier('allowed.cdx.json');

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: 'PASS',
      componentsChecked: 1,
    });
  });

  test('blocks a CycloneDX component whose exact license is not approved', () => {
    const result = runLicenseVerifier('denied.cdx.json');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'LICENSE_NOT_APPROVED:pkg:npm/denied-package@2.0.0:GPL-3.0-only',
    );
    expect(result.stdout).toBe('');
  });

  test('accepts a named active exception only for its exact package-version purl and license', () => {
    const result = runLicenseVerifier('exception.cdx.json', 'active-exception-policy.json');

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome: 'PASS',
      componentsChecked: 1,
      exceptionsUsed: 1,
    });
  });

  test('blocks an expired exception even when its purl and license match exactly', () => {
    const result = runLicenseVerifier('exception.cdx.json', 'expired-exception-policy.json');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'LICENSE_EXCEPTION_EXPIRED:Expired fixture GPL runtime:2000-01-01',
    );
    expect(result.stdout).toBe('');
  });

  test('rejects an exception that omits required accountable governance metadata', () => {
    const result = runLicenseVerifier('exception.cdx.json', 'malformed-exception-policy.json');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('LICENSE_POLICY_INVALID');
    expect(result.stdout).toBe('');
  });

  test('keeps the repository license policy on the same named exact fail-closed schema', () => {
    const result = runLicenseVerifierWithPolicy(
      'allowed.cdx.json',
      join(root, 'scripts', 'security', 'license-policy.json'),
    );

    expect(result.status, result.stderr).toBe(0);
  });

  test('rejects any expansion or contraction of the frozen automatic license allowlist', () => {
    const result = runLicenseVerifier('allowed.cdx.json', 'expanded-allowlist-policy.json');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('LICENSE_POLICY_INVALID');
    expect(result.stdout).toBe('');
  });

  test('recursively checks licenses on nested CycloneDX components', () => {
    const result = runLicenseVerifier('nested-denied.cdx.json');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'LICENSE_NOT_APPROVED:pkg:npm/nested-denied-package@2.0.0:GPL-3.0-only',
    );
    expect(result.stdout).toBe('');
  });

  test('rejects an empty or unsupported CycloneDX inventory', () => {
    for (const fixture of ['empty.cdx.json', 'unsupported-spec.cdx.json']) {
      const result = runLicenseVerifier(fixture);

      expect(result.status, fixture).toBe(1);
      expect(result.stderr, fixture).toContain('CYCLONEDX_SBOM_INVALID');
      expect(result.stdout, fixture).toBe('');
    }
  });

  test('does not broaden an exception to another version or license', () => {
    for (const fixture of [
      'exception-version-mismatch.cdx.json',
      'exception-license-mismatch.cdx.json',
    ]) {
      const result = runLicenseVerifier(fixture, 'active-exception-policy.json');

      expect(result.status, fixture).toBe(1);
      expect(result.stderr, fixture).toContain('LICENSE_NOT_APPROVED:');
      expect(result.stdout, fixture).toBe('');
    }
  });

  test('blocks the workflow on the local CycloneDX license verifier before evidence upload', async () => {
    const workflow = await securityWorkflow();
    const sbomIndex = workflow.indexOf('- name: Generate CycloneDX source SBOM');
    const licenseIndex = workflow.indexOf('- name: Enforce named exact CycloneDX license policy');
    const uploadIndex = workflow.indexOf('- name: Upload CycloneDX evidence');
    const licenseStep = workflow.slice(
      licenseIndex,
      workflow.indexOf('\n      - name:', licenseIndex + 1),
    );

    expect(licenseIndex).toBeGreaterThan(sbomIndex);
    expect(uploadIndex).toBeGreaterThan(licenseIndex);
    expect(licenseStep).toContain('node scripts/security/verify-cyclonedx-licenses.mjs');
    expect(licenseStep).toContain('--sbom "$RUNNER_TEMP/security-evidence/source-sbom.cdx.json"');
    expect(licenseStep).toContain('--policy scripts/security/license-policy.json');
  });

  test('blocks exact-digest attestation on final image and SBOM OSV scans plus license policy', async () => {
    const workflow = await releaseWorkflow();
    const finalSbomIndex = workflow.indexOf('- name: Generate Worker CycloneDX SBOM');
    const exportIndex = workflow.indexOf('- name: Export exact-digest images for OSV');
    const scanIndex = workflow.indexOf('- name: Scan exact images and final SBOMs with OSV');
    const extractIndex = workflow.indexOf('- name: Extract exact-image runtime license SBOMs');
    const licenseIndex = workflow.indexOf('- name: Enforce final CycloneDX license policy');
    const attestIndex = workflow.indexOf('- name: Attest API provenance');
    const exportStep = workflow.slice(exportIndex, scanIndex);
    const scanStep = workflow.slice(scanIndex, licenseIndex);
    const licenseStep = workflow.slice(licenseIndex, attestIndex);

    expect(exportIndex).toBeGreaterThan(finalSbomIndex);
    expect(scanIndex).toBeGreaterThan(exportIndex);
    expect(extractIndex).toBeGreaterThan(scanIndex);
    expect(licenseIndex).toBeGreaterThan(scanIndex);
    expect(attestIndex).toBeGreaterThan(licenseIndex);
    for (const service of ['adot', 'api', 'web', 'worker', 'recovery']) {
      expect(exportStep).toContain(`${service}.tar`);
      expect(scanStep).toContain(`--archive /images/${service}.tar`);
      expect(scanStep).toContain(`--sbom=/workspace/sbom-${service}.cdx.json`);
      expect(licenseStep).toContain(`--sbom "license-sbom-${service}.cdx.json"`);
      expect(licenseStep).toContain(`> "license-${service}.json"`);
    }
    expect(
      exportStep.match(/@\$\{\{ steps\.build-(?:api|web|worker|recovery)\.outputs\.digest \}\}/gu),
    ).toHaveLength(4);
    expect(scanStep).toContain(
      'ghcr.io/google/osv-scanner:v2.4.0@sha256:5116601dedc01c1c580eb92371883ec052fc4c13c3fbc109d621a63ac416d475',
    );
    expect(licenseStep).toContain('--policy scripts/security/license-policy.json');
    const extractStep = workflow.slice(extractIndex, licenseIndex);
    expect(extractStep.match(/extract-runtime-license-sbom\.mjs/gu)).toHaveLength(5);
    expect(extractStep.match(/--first-party-purl-prefix 'pkg:npm\/%40aeostudio\/'/gu)).toHaveLength(
      5,
    );
    expect(extractStep.match(/--runtime-root '\/workspace'/gu)).toHaveLength(3);
    expect(extractStep).toContain("--runtime-root '/opt/aeostudio'");
    expect(extractStep).toContain("--runtime-root '/'");
  });

  test('builds, scans, attests and manifests the fixed recovery image in the same build run', async () => {
    const workflow = await releaseWorkflow();

    expect(workflow).toContain('RECOVERY_REPOSITORY: aeostudio-recovery');
    expect(workflow).toContain('- name: Build and push Recovery image once');
    expect(workflow).toContain('file: Dockerfile.recovery');
    expect(workflow).toContain('- name: Block high or critical Recovery image vulnerabilities');
    expect(workflow).toContain('- name: Generate Recovery CycloneDX SBOM');
    expect(workflow).toContain('- name: Attest Recovery provenance');
    expect(workflow).toContain('- name: Attest Recovery CycloneDX SBOM');
    expect(workflow).toContain('attestations/recovery-provenance.json');
    expect(workflow).toContain('attestations/recovery-sbom.json');
    expect(workflow).toContain('schemaVersion:"aeostudio.recovery-image.v1"');
    expect(workflow).toContain('> recovery-image.json');
  });

  test('uploads the final scan decisions and their checksum binding with the release evidence', async () => {
    const workflow = await releaseWorkflow();
    const checksumIndex = workflow.indexOf('- name: Bind final supply-chain evidence');
    const uploadIndex = workflow.indexOf('- name: Upload release manifest and SBOM evidence');
    const uploadStep = workflow.slice(
      uploadIndex,
      workflow.indexOf('\n      - name:', uploadIndex + 1),
    );

    expect(checksumIndex).toBeGreaterThan(-1);
    expect(uploadIndex).toBeGreaterThan(checksumIndex);
    for (const evidence of [
      'osv-image-*.json',
      'osv-sbom-*.json',
      'license-*.json',
      'license-sbom-*.cdx.json',
      'supply-chain-evidence.sha256',
    ]) {
      expect(uploadStep).toContain(evidence);
    }
  });

  test('declares protected ownership for release and security policy surfaces', async () => {
    const codeowners = await readFile(join(root, '.github', 'CODEOWNERS'), 'utf8');

    for (const protectedPath of [
      '/.github/workflows/',
      '/.github/CODEOWNERS',
      '/infra/',
      '/scripts/acceptance/',
      '/scripts/bootstrap/',
      '/scripts/infra/',
      '/scripts/load/',
      '/scripts/observability/',
      '/scripts/recovery/',
      '/scripts/release/',
      '/scripts/security/',
      '/scripts/smoke/',
      '/package.json',
      '/pnpm-lock.yaml',
      '/pnpm-workspace.yaml',
      '/scripts/security/license-policy.json',
      '/scripts/security/action-pins.json',
      '/Dockerfile',
      '/apps/api/Dockerfile',
      '/apps/web/Dockerfile',
      '/apps/worker/Dockerfile',
    ]) {
      expect(codeowners).toMatch(
        new RegExp(
          `^${protectedPath.replaceAll('/', '\\/').replaceAll('.', '\\.')}\\s+@maxenergy$`,
          'mu',
        ),
      );
    }
  });

  test('requires protected external approval for the exact aggregate supply-chain policy', async () => {
    const workflow = await productionWorkflow();
    const approvalIndex = workflow.indexOf(
      '- name: Validate protected production approval and deploy role',
    );
    const credentialsIndex = workflow.indexOf(
      '- name: Acquire production release-broker credentials',
    );
    const approvalStep = workflow.slice(approvalIndex, credentialsIndex);

    expect(approvalIndex).toBeGreaterThan(-1);
    expect(credentialsIndex).toBeGreaterThan(approvalIndex);
    expect(approvalStep).toContain(
      'APPROVED_SUPPLY_CHAIN_POLICY_SHA256: ${{ vars.AEO_APPROVED_SUPPLY_CHAIN_POLICY_SHA256 }}',
    );
    expect(approvalStep).toContain(
      'LICENSE_APPROVAL_REFERENCE: ${{ vars.AEO_LICENSE_APPROVAL_REFERENCE }}',
    );
    expect(approvalStep).toContain('sha256sum scripts/security/container-base-policy.json');
    expect(approvalStep).toContain('sha256sum scripts/security/license-policy.json');
    expect(approvalStep).toContain('aeostudio-supply-chain-policy.sha256');
    expect(approvalStep).toContain(
      'test "$actual_supply_chain_policy_sha256" = "$APPROVED_SUPPLY_CHAIN_POLICY_SHA256"',
    );
    expect(approvalStep).toContain('test -n "$LICENSE_APPROVAL_REFERENCE"');
    expect(approvalStep).not.toContain('AEO_APPROVED_LICENSE_POLICY_SHA256');
  });

  test('runs registry signature audit in both pull-request and release security gates', async () => {
    const verify = await readFile(join(root, '.github', 'workflows', 'verify.yml'), 'utf8');
    const release = await releaseWorkflow();

    for (const workflow of [verify, release]) {
      expect(workflow).toContain('- name: Verify npm registry signatures');
      expect(workflow).toContain('pnpm audit signatures');
      expect(workflow).toContain('npm ci --prefix scripts/recovery --ignore-scripts');
      expect(workflow).toContain('npm audit signatures --prefix scripts/recovery');
      expect(workflow).not.toMatch(/audit signatures[^\n]*\|\|\s*true/u);
    }
  });

  test('builds and hash-binds a frozen Recovery source SBOM before OSV and exact license gates', async () => {
    const workflow = await securityWorkflow();
    const installIndex = workflow.indexOf('npm ci --prefix scripts/recovery --ignore-scripts');
    const sbomIndex = workflow.indexOf('recovery-source-sbom.cdx.json');
    const osvIndex = workflow.indexOf('scan --sbom=/evidence/recovery-source-sbom.cdx.json');
    const licenseIndex = workflow.indexOf(
      '--sbom "$RUNNER_TEMP/security-evidence/recovery-source-sbom.cdx.json"',
    );
    const hashIndex = workflow.indexOf('source-sboms.sha256');
    const uploadIndex = workflow.indexOf('- name: Upload CycloneDX evidence');

    expect(installIndex).toBeGreaterThan(-1);
    expect(sbomIndex).toBeGreaterThan(installIndex);
    expect(osvIndex).toBeGreaterThan(sbomIndex);
    expect(licenseIndex).toBeGreaterThan(osvIndex);
    expect(hashIndex).toBeGreaterThan(licenseIndex);
    expect(uploadIndex).toBeGreaterThan(hashIndex);
    expect(workflow).toContain('npm sbom --prefix scripts/recovery');
    expect(workflow).toContain('--policy scripts/security/license-policy.json');
    expect(workflow).toContain(
      '${{ runner.temp }}/security-evidence/recovery-source-sbom.cdx.json',
    );
    expect(workflow).toContain('${{ runner.temp }}/security-evidence/source-sboms.sha256');
  });

  test('revalidates every Recovery lock publication time after frozen install and signatures', async () => {
    const command =
      'node scripts/security/verify-npm-lock-release-age.mjs --lock scripts/recovery/package-lock.json --manifest scripts/recovery/package.json';
    for (const workflow of [await securityWorkflow(), await releaseWorkflow()]) {
      const installIndex = workflow.indexOf('npm ci --prefix scripts/recovery --ignore-scripts');
      const signatureIndex = workflow.indexOf('npm audit signatures --prefix scripts/recovery');
      const releaseAgeIndex = workflow.indexOf(command);

      expect(installIndex).toBeGreaterThan(-1);
      expect(signatureIndex).toBeGreaterThan(installIndex);
      expect(releaseAgeIndex).toBeGreaterThan(signatureIndex);
    }
    expect((await securityWorkflow()).indexOf(command)).toBeLessThan(
      (await securityWorkflow()).indexOf('recovery-source-sbom.cdx.json'),
    );
    expect((await releaseWorkflow()).indexOf(command)).toBeLessThan(
      (await releaseWorkflow()).indexOf('- name: Build and push Recovery image once'),
    );
  });

  test('configures weekly pinned Renovate updates and immediate vulnerability-alert triage', async () => {
    const renovate = JSON.parse(await readFile(join(root, 'renovate.json'), 'utf8')) as {
      automerge?: boolean;
      extends?: string[];
      internalChecksFilter?: string;
      minimumReleaseAge?: string;
      osvVulnerabilityAlerts?: boolean;
      rangeStrategy?: string;
      schedule?: string[];
      timezone?: string;
      vulnerabilityAlerts?: {
        enabled?: boolean;
        labels?: string[];
        schedule?: string[];
      };
    };

    expect(renovate.extends).toContain('config:best-practices');
    expect(renovate.timezone).toBe('Asia/Taipei');
    expect(renovate.schedule).toContain('before 6am on monday');
    expect(renovate.minimumReleaseAge).toBe('1 day');
    expect(renovate.internalChecksFilter).toBe('strict');
    expect(renovate.rangeStrategy).toBe('pin');
    expect(renovate.automerge).toBe(false);
    expect(renovate.osvVulnerabilityAlerts).toBe(true);
    expect(renovate.vulnerabilityAlerts).toMatchObject({
      enabled: true,
      schedule: ['at any time'],
    });
    expect(renovate.vulnerabilityAlerts?.labels).toEqual(
      expect.arrayContaining(['security', 'sla:critical-24h', 'sla:high-7d']),
    );
  });
});
