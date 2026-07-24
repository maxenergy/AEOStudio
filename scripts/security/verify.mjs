/* global console, process */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { licenseExceptionKey, npmPackagePurl, validateLicensePolicy } from './license-policy.mjs';
import { verifyTrivyExceptionPolicy } from './trivy-exception-policy.mjs';
import { verifyContainerBasePolicy } from './verify-container-base-policy.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const securityDirectory = resolve(repositoryRoot, 'scripts/security');
const failures = [];

function fail(code, detail) {
  failures.push(`${code}: ${detail}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function filesBelow(root, predicate) {
  if (!statExists(root)) return [];
  const result = [];
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
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && predicate(absolute)) result.push(absolute);
    }
  };
  visit(root);
  return result;
}

function statExists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function repositoryPath(path) {
  return relative(repositoryRoot, path).split(sep).join('/');
}

function verifySecretPatterns() {
  const textExtensions = new Set([
    '.cjs',
    '.css',
    '.env',
    '.hcl',
    '.html',
    '.js',
    '.json',
    '.jsx',
    '.md',
    '.mjs',
    '.sql',
    '.tf',
    '.tfvars',
    '.toml',
    '.ts',
    '.tsx',
    '.txt',
    '.yaml',
    '.yml',
  ]);
  const rules = [
    ['AWS_ACCESS_KEY', /(?:AKIA|ASIA)[A-Z0-9]{16}/gu],
    ['GITHUB_TOKEN', /(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{40,255})/gu],
    ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu],
    ['SLACK_TOKEN', /xox[baprs]-[A-Za-z0-9-]{10,}/gu],
    ['LIVE_PAYMENT_KEY', /sk_live_[A-Za-z0-9]{16,}/gu],
  ];
  const candidates = filesBelow(repositoryRoot, (path) => {
    if (!textExtensions.has(extname(path).toLowerCase())) return false;
    return statSync(path).size <= 1_000_000;
  });

  for (const path of candidates) {
    const contents = readFileSync(path, 'utf8');
    for (const [rule, pattern] of rules) {
      pattern.lastIndex = 0;
      const match = pattern.exec(contents);
      if (!match) continue;
      const line = contents.slice(0, match.index).split(/\r?\n/u).length;
      fail('SECRET_PATTERN_DETECTED', `${repositoryPath(path)}:${String(line)} (${rule})`);
    }
  }
}

function verifyLicenses() {
  const policy = readJson(join(securityDirectory, 'license-policy.json'));
  let policyDecision;
  try {
    policyDecision = validateLicensePolicy(policy);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'LICENSE_POLICY_INVALID';
    const [code, ...detail] = message.split(':');
    fail(code, detail.join(':') || 'scripts/security/license-policy.json');
    return;
  }

  let report;
  try {
    const pnpmCli = [
      process.env.npm_execpath,
      process.env.APPDATA
        ? join(process.env.APPDATA, 'npm/node_modules/pnpm/bin/pnpm.cjs')
        : undefined,
    ].find((candidate) => candidate?.match(/\.(?:c?js|mjs)$/u) && statExists(candidate));
    if (!pnpmCli) throw new Error('PNPM_CLI_NOT_FOUND_RUN_VIA_PNPM_SECURITY_VERIFY');
    const childEnvironment = { ...process.env };
    for (const name of [
      'NPM_CONFIG_ONLY',
      'NPM_CONFIG_PRODUCTION',
      'PNPM_CONFIG_PRODUCTION',
      'npm_config_only',
      'npm_config_production',
    ]) {
      delete childEnvironment[name];
    }
    report = JSON.parse(
      execFileSync(process.execPath, [pnpmCli, 'licenses', 'list', '--json'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: childEnvironment,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      }),
    );
  } catch (error) {
    fail('LICENSE_REPORT_FAILED', error instanceof Error ? error.message : String(error));
    return;
  }

  for (const [license, packages] of Object.entries(report)) {
    if (policyDecision.allowedLicenses.has(license)) continue;
    if (!Array.isArray(packages)) {
      fail('LICENSE_REPORT_INVALID', license);
      continue;
    }
    for (const dependency of packages) {
      if (
        typeof dependency?.name !== 'string' ||
        !Array.isArray(dependency?.versions) ||
        dependency.versions.length === 0
      ) {
        fail('LICENSE_REPORT_INVALID', license);
        continue;
      }
      for (const version of dependency.versions) {
        let purl;
        try {
          purl = npmPackagePurl(dependency.name, version);
        } catch {
          fail('LICENSE_REPORT_INVALID', `${dependency.name} (${license})`);
          continue;
        }
        if (!policyDecision.exceptionByScopeAndLicense.has(licenseExceptionKey(purl, license))) {
          fail('LICENSE_NOT_APPROVED', `${purl} (${license})`);
        }
      }
    }
  }
}

function verifyContainerBases() {
  try {
    verifyContainerBasePolicy({
      repositoryRoot,
      policyPath: join(securityDirectory, 'container-base-policy.json'),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CONTAINER_BASE_POLICY_INVALID';
    const [code, ...detail] = message.split(':');
    fail(code, detail.join(':') || 'scripts/security/container-base-policy.json');
  }
}

function verifyTrivyExceptions() {
  try {
    verifyTrivyExceptionPolicy({ repositoryRoot });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'TRIVY_EXCEPTION_POLICY_INVALID';
    const [code, ...detail] = message.split(':');
    fail(code, detail.join(':') || 'scripts/security/trivy-exception-policy.json');
  }
}

function workflowFiles() {
  return filesBelow(resolve(repositoryRoot, '.github/workflows'), (path) =>
    ['.yaml', '.yml'].includes(extname(path).toLowerCase()),
  );
}

function verifyWorkflows() {
  const paths = workflowFiles();
  if (paths.length === 0) {
    fail('WORKFLOWS_MISSING', '.github/workflows contains no YAML workflows');
    return;
  }

  const pins = readJson(join(securityDirectory, 'action-pins.json'));
  const combined = paths.map((path) => readFileSync(path, 'utf8')).join('\n');
  // A credential-bearing job may deliberately clear the OIDC session for an unprivileged child
  // process. Permit only an exact YAML empty-string override; assignments, shell exports and
  // secret references remain visible to the forbidden-pattern scan below.
  const credentialScan = combined.replace(
    /^\s*(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_SECURITY_TOKEN):\s*(?:''|"")\s*$/gmu,
    '',
  );
  const actionUses = [...combined.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gmu)].map(
    (match) => match[1],
  );
  const allowedNonBlockingArtifactSteps = new Set([
    'Upload immutable finalized production release receipt',
    'Retry immutable finalized production release receipt upload',
  ]);
  const observedNonBlockingArtifactSteps = [];
  for (const path of paths) {
    const contents = readFileSync(path, 'utf8');
    for (const match of contents.matchAll(
      /^ {6}- name: ([^\r\n]+)\r?\n([\s\S]*?)(?=^ {6}- name: |$(?![\s\S]))/gmu,
    )) {
      const name = match[1];
      const body = match[2] ?? '';
      if (!/continue-on-error:\s*true/iu.test(body)) continue;
      observedNonBlockingArtifactSteps.push(name);
      if (
        !allowedNonBlockingArtifactSteps.has(name) ||
        !/uses:\s*actions\/upload-artifact@[0-9a-f]{40}/u.test(body) ||
        !/if-no-files-found:\s*error/u.test(body)
      ) {
        fail('WORKFLOW_FORBIDDEN_PATTERN', `NON_BLOCKING_GATE (${repositoryPath(path)}:${name})`);
      }
    }
  }
  const rawNonBlockingCount = [...combined.matchAll(/continue-on-error:\s*true/giu)].length;
  if (
    rawNonBlockingCount !== observedNonBlockingArtifactSteps.length ||
    observedNonBlockingArtifactSteps.sort().join('\n') !==
      [...allowedNonBlockingArtifactSteps].sort().join('\n')
  ) {
    fail('WORKFLOW_FORBIDDEN_PATTERN', 'NON_BLOCKING_GATE');
  }
  for (const use of actionUses) {
    if (use.startsWith('./') || use.startsWith('docker://')) continue;
    const separator = use.lastIndexOf('@');
    const target = separator === -1 ? use : use.slice(0, separator);
    const sha = separator === -1 ? '' : use.slice(separator + 1);
    const repository = target.split('/').slice(0, 2).join('/');
    if (!/^[0-9a-f]{40}$/u.test(sha)) {
      fail('ACTION_NOT_PINNED', use);
      continue;
    }
    if (pins[repository] !== sha) fail('ACTION_PIN_NOT_REVIEWED', use);
  }

  const requiredEvidence = [
    ['OIDC', /id-token:\s*write/u],
    ['OSV', /OSV|osv-scanner/iu],
    ['GITLEAKS', /Gitleaks/iu],
    ['TRIVY', /Trivy/iu],
    ['CYCLONEDX', /CycloneDX|cyclonedx/iu],
    ['PROVENANCE', /provenance/iu],
    ['SBOM_ATTESTATION', /actions\/attest@[0-9a-f]{40}[\s\S]*sbom-path/iu],
    ['STAGING', /environment:\s*staging/u],
    ['PRODUCTION', /environment:\s*production/u],
    ['DIGEST_PROMOTION', /image(?:_|-)digest|@sha256/iu],
  ];
  for (const [name, pattern] of requiredEvidence) {
    if (!pattern.test(combined)) fail('CI_GATE_MISSING', name);
  }

  const releaseBrokerClient = readFileSync(
    join(repositoryRoot, 'scripts/release/run-release-broker.mjs'),
    'utf8',
  );
  const cleanupWorkflows = ['build-attest.yml', 'deploy-production.yml'].every((name) => {
    const path = join(repositoryRoot, '.github/workflows', name);
    if (!statExists(path)) return false;
    const contents = readFileSync(path, 'utf8');
    return /node scripts\/release\/run-release-broker\.mjs[\s\S]{0,600}?--mode CLEANUP/u.test(
      contents,
    );
  });
  const brokerCanAdoptDeterministicRecovery =
    /const expectedReconciliationName = `reconcile-\$\{releaseId\}`/u.test(releaseBrokerClient) &&
    /const cleanupInput = \{\s*Mode: 'RECOVER',\s*ReleaseId: releaseId,\s*DeployExecutionArn: deployArn,/u.test(
      releaseBrokerClient,
    ) &&
    /requireSucceeded\(await waitForExecution\(common\.region, cleanupArn\)\)/u.test(
      releaseBrokerClient,
    );
  if (!cleanupWorkflows || !brokerCanAdoptDeterministicRecovery) {
    fail('CI_GATE_MISSING', 'DETERMINISTIC_RECOVER');
  }

  const forbidden = [
    [
      'LONG_LIVED_AWS_KEY',
      /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_SECURITY_TOKEN|secrets\.AWS_/u,
    ],
  ];
  for (const [name, pattern] of forbidden) {
    if (pattern.test(name === 'LONG_LIVED_AWS_KEY' ? credentialScan : combined)) {
      fail('WORKFLOW_FORBIDDEN_PATTERN', name);
    }
  }
  for (const path of paths) {
    const contents = readFileSync(path, 'utf8');
    if (
      /environment:\s*production/u.test(contents) &&
      /docker\/build-push-action/iu.test(contents)
    ) {
      fail('WORKFLOW_FORBIDDEN_PATTERN', `UNSAFE_PRODUCTION_REBUILD (${repositoryPath(path)})`);
    }
  }
}

function verifyInfrastructureRestrictions() {
  const paths = filesBelow(resolve(repositoryRoot, 'infra'), (path) => extname(path) === '.tf');
  if (paths.length === 0) {
    fail('INFRASTRUCTURE_MISSING', 'infra contains no OpenTofu files');
    return;
  }
  const combined = paths.map((path) => readFileSync(path, 'utf8')).join('\n');
  const forbidden = [
    ['EKS', /resource\s+"aws_eks_/u],
    ['OPENSEARCH', /resource\s+"aws_(?:opensearch|elasticsearch)_/u],
    ['CROSS_REGION_DATABASE', /resource\s+"aws_(?:rds_global_cluster|dynamodb_global_table)"/u],
    ['WILDCARD_IAM_ACTION', /"Action"\s*:\s*(?:"\*"|\[[^\]]*"[^"\r\n]*\*"[^\]]*\])/u],
  ];
  for (const [name, pattern] of forbidden) {
    if (pattern.test(combined)) fail('INFRA_FORBIDDEN_PATTERN', name);
  }
}

verifySecretPatterns();
verifyLicenses();
verifyContainerBases();
verifyTrivyExceptions();
verifyWorkflows();
verifyInfrastructureRestrictions();

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      outcome: 'PASS',
      checks: [
        'secret-patterns',
        'licenses',
        'container-bases',
        'trivy-exceptions',
        'action-pins',
        'ci-gates',
        'infra-forbidden',
      ],
    }),
  );
}
