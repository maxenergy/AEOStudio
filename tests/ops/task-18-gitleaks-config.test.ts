import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

const expectedConfig = String.raw`title = "AEOStudio Gitleaks configuration"

[extend]
useDefault = true

[[allowlists]]
description = "Exact GitHub Action commit SHA in the action pin registry"
targetRules = ["generic-api-key"]
condition = "AND"
regexTarget = "secret"
paths = ['''(?:^|/)scripts/security/action-pins\.json$''']
regexes = ['''^[0-9a-f]{40}$''']

[[allowlists]]
description = "Exact AwsS3PrivacyApi type name in the S3 SDK adapter"
targetRules = ["generic-api-key"]
condition = "AND"
regexTarget = "secret"
paths = ['''(?:^|/)packages/adapters/src/storage/aws-s3-sdk\.ts$''']
regexes = ['''^AwsS3PrivacyApi$''']

[[allowlists]]
description = "Exact AwsS3EvidenceApi test-double type name in its adapter test"
targetRules = ["generic-api-key"]
condition = "AND"
regexTarget = "secret"
paths = ['''(?:^|/)packages/adapters/src/storage/aws-s3-evidence-object-store\.test\.ts$''']
regexes = ['''^AwsS3EvidenceApi$''']

[[allowlists]]
description = "Deletion receipt schema identifier is a public version label, not a credential"
targetRules = ["generic-api-key"]
condition = "AND"
regexTarget = "line"
paths = ['''(?:^|/)apps/api/src/privacy/deletion-receipt-token\.ts$''']
regexes = ['''TOKEN_SCHEMA_VERSION\s*=\s*['"]deletion-receipt-capability\.v1['"]''']

[[allowlists]]
description = "Named deterministic credential-boundary fixtures in exact test files"
targetRules = ["generic-api-key"]
condition = "AND"
regexTarget = "line"
paths = [
  '''(?:^|/)tests/ops/fixtures/staging-synthetic-happy-path\.ts$''',
  '''(?:^|/)tests/ops/task-18-staging-smoke-login\.test\.ts$''',
  '''(?:^|/)tests/unit/task-10-fake-publication-runtime\.test\.ts$''',
  '''(?:^|/)tests/unit/task-18-tenant-data-broker-http-adversarial\.test\.ts$''',
  '''(?:^|/)tests/unit/task-18-tenant-data-broker-http\.test\.ts$''',
  '''(?:^|/)tests/unit/task-18-tenant-data-broker-policy\.test\.ts$''',
]
regexes = [
  '''\b(?:totpSecret|secret|idempotencyKey|leaseTokenSha256|LEASE_TOKEN_SHA256)\b''',
]
`;

describe('Task 18 Gitleaks false-positive boundary', () => {
  test('extends the default rules with exactly five reviewed path-and-secret AND allowlists', () => {
    const actual = readFileSync('.gitleaks.toml', 'utf8').replaceAll('\r\n', '\n');

    expect(actual).toBe(expectedConfig);
  });

  test('the complete-history workflow explicitly loads the reviewed root configuration', () => {
    const workflow = readFileSync('.github/workflows/security.yml', 'utf8');
    const stepStart = workflow.indexOf('- name: Run Gitleaks complete-history secret scan');
    const stepEnd = workflow.indexOf('- name: Run Trivy high and critical source scan');

    expect(stepStart).toBeGreaterThanOrEqual(0);
    expect(stepEnd).toBeGreaterThan(stepStart);
    const gitleaksStep = workflow.slice(stepStart, stepEnd);
    expect(gitleaksStep).toContain(
      'ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f',
    );
    expect(gitleaksStep).toContain(
      'detect --source=/src --config=/src/.gitleaks.toml --redact --no-banner --exit-code=1',
    );
  });
});
