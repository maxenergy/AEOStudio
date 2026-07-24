import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

// @ts-expect-error The production helper is a native ESM JavaScript module.
import * as untypedValidator from '../../scripts/acceptance/validate-production-finalization-evidence.mjs';

const validator = untypedValidator as {
  validateProductionFinalizationEvidence(input: {
    apiWebRuntime: Record<string, unknown>;
    brokerRuntime: Record<string, unknown>;
    contractEnvelope: Record<string, unknown>;
    expected: {
      accountId: string;
      buildRunAttempt: string;
      buildRunId: string;
      origin: string;
      githubEnvironmentEvidenceSha256: string;
      githubEnvironmentSnapshotSha256: string;
      githubEnvironmentValidatedAt: string;
      now: string;
      promotionControlPlaneEvidenceSha256: string;
      promotionControlPlaneSnapshotSha256: string;
      promotionControlPlaneValidatedAt: string;
      region: string;
      releaseId: string;
      repository: string;
      sourceSha: string;
    };
    health: { raw: Buffer; value: Record<string, unknown> };
    manifest: Record<string, unknown>;
    readiness: { raw: Buffer; value: Record<string, unknown> };
    smokeEnvelope: Record<string, unknown>;
  }): Record<string, unknown>;
  validateGitHubEnvironmentEvidenceHash(
    value: Record<string, unknown>,
    expected: { repository: string; sourceSha: string },
    expectedSha256: string,
  ): { snapshotSha256: string; stableSha256: string; validatedAt: string };
  validatePromotionControlPlaneEvidenceHash(
    value: Record<string, unknown>,
    expected: { repository: string; sourceSha: string },
    expectedSha256: string,
  ): { snapshotSha256: string; stableSha256: string; validatedAt: string };
};

const accountId = '123456789012';
const region = 'ap-southeast-1';
const repository = 'owner/aeostudio';
const sourceSha = 'd'.repeat(40);
const buildRunId = '100';
const buildRunAttempt = '2';
const releaseId = 'production-901-3';
const origin = 'https://app.example.com';
const githubEnvironmentEvidenceSha256 = 'e'.repeat(64);
const promotionControlPlaneEvidenceSha256 = 'f'.repeat(64);
const githubEnvironmentSnapshotSha256 = '1'.repeat(64);
const promotionControlPlaneSnapshotSha256 = '2'.repeat(64);
const smokeCompletedAt = '2026-07-24T10:00:00.000Z';
const githubEnvironmentValidatedAt = '2026-07-24T10:01:00.000Z';
const promotionControlPlaneValidatedAt = '2026-07-24T10:02:00.000Z';
const finalizationNow = '2026-07-24T10:05:00.000Z';
const clusterName = 'aeostudio-production';
const clusterArn = `arn:aws:ecs:${region}:${accountId}:cluster/${clusterName}`;
const loadBalancerArn =
  `arn:aws:elasticloadbalancing:${region}:${accountId}:loadbalancer/app/` +
  `${clusterName}/${'a'.repeat(16)}`;
const listenerArn =
  `arn:aws:elasticloadbalancing:${region}:${accountId}:listener/app/` +
  `${clusterName}/${'a'.repeat(16)}/${'b'.repeat(16)}`;
const digests = {
  adot: `sha256:${'a'.repeat(64)}`,
  api: `sha256:${'b'.repeat(64)}`,
  web: `sha256:${'c'.repeat(64)}`,
  worker: `sha256:${'d'.repeat(64)}`,
};
const image = (service: keyof typeof digests) =>
  `${accountId}.dkr.ecr.${region}.amazonaws.com/aeostudio-${service}`;
const reference = (service: keyof typeof digests) => `${image(service)}@${digests[service]}`;
const taskDefinitions = {
  api: `arn:aws:ecs:${region}:${accountId}:task-definition/${clusterName}-api:17`,
  web: `arn:aws:ecs:${region}:${accountId}:task-definition/${clusterName}-web:19`,
  worker: `arn:aws:ecs:${region}:${accountId}:task-definition/${clusterName}-worker:23`,
  broker: `arn:aws:ecs:${region}:${accountId}:task-definition/${clusterName}-tenant-data-broker:29`,
};

function taskArn(service: 'api' | 'web' | 'broker', suffix: string) {
  const prefix = { api: '1', web: '2', broker: '3' }[service];
  return `arn:aws:ecs:${region}:${accountId}:task/${clusterName}/${prefix.repeat(31)}${suffix}`;
}

function manifest(): Record<string, unknown> {
  return {
    schemaVersion: 'aeostudio.release.v1',
    repository,
    sourceSha,
    sourceRef: 'refs/heads/main',
    buildRunId,
    buildRunAttempt,
    images: Object.fromEntries(
      Object.keys(digests).map((service) => [
        service,
        {
          image: image(service as keyof typeof digests),
          digest: digests[service as keyof typeof digests],
        },
      ]),
    ),
  };
}

function contractEnvelope(): Record<string, unknown> {
  return {
    executionStatus: 'SUCCEEDED',
    contract: {
      SchemaVersion: 'aeostudio.release-contract.v2',
      Environment: 'production',
      Region: region,
      AccountId: accountId,
      ReleaseId: releaseId,
      Images: {
        Adot: reference('adot'),
        Api: reference('api'),
        Web: reference('web'),
        Worker: reference('worker'),
        TenantDataBroker: reference('worker'),
      },
      TaskDefinitions: {
        Api: taskDefinitions.api,
        Web: taskDefinitions.web,
        Worker: taskDefinitions.worker,
        TenantDataBroker: taskDefinitions.broker,
      },
    },
  };
}

function apiWebRuntime(): Record<string, unknown> {
  const privateIps = {
    api: ['10.0.1.11', '10.0.1.12'],
    web: ['10.0.2.11', '10.0.2.12'],
  };
  const services = Object.fromEntries(
    (['api', 'web'] as const).map((service) => [
      service,
      {
        taskDefinitionArn: taskDefinitions[service],
        image: reference(service),
        imageDigest: digests[service],
        desiredCount: 2,
        runningCount: 2,
        pendingCount: 0,
        tasks: ['1', '2'].map((suffix, index) => ({
          taskArn: taskArn(service, suffix),
          imageDigest: digests[service],
          privateIp: privateIps[service][index],
        })),
      },
    ]),
  );
  return {
    schemaVersion: 'aeostudio.production-api-web-runtime.v1',
    environment: 'production',
    region,
    accountId,
    clusterName,
    clusterArn,
    releaseId,
    routeBinding: {
      origin,
      hostname: 'app.example.com',
      hostedZoneId: 'Z0123456789ABC',
      aliasDnsName: 'aeostudio-production.ap-southeast-1.elb.amazonaws.com',
      loadBalancerArn,
      listenerArn,
      ipAddressType: 'ipv4',
      routeRecordTypes: ['A'],
      vpcId: 'vpc-0123456789abcdef0',
      services: {
        api: {
          targetGroupArn:
            `arn:aws:elasticloadbalancing:${region}:${accountId}:targetgroup/` +
            `${clusterName}-api/${'c'.repeat(16)}`,
          targetPort: 3200,
          healthyTargetIps: privateIps.api,
        },
        web: {
          targetGroupArn:
            `arn:aws:elasticloadbalancing:${region}:${accountId}:targetgroup/` +
            `${clusterName}-web/${'d'.repeat(16)}`,
          targetPort: 3100,
          healthyTargetIps: privateIps.web,
        },
      },
    },
    services,
  };
}

function brokerRuntime(): Record<string, unknown> {
  return {
    schemaVersion: 'aeostudio.tenant-data-broker-runtime.v1',
    environment: 'production',
    region,
    accountId,
    releaseId,
    taskDefinitionArn: taskDefinitions.broker,
    desiredCount: 2,
    runningCount: 2,
    pendingCount: 0,
    healthyTargetCount: 2,
    workerImage: reference('worker'),
    adotImage: reference('adot'),
    adotRuntimeDigest: `sha256:${'e'.repeat(64)}`,
    tasks: ['1', '2'].map((suffix) => ({
      taskArn: taskArn('broker', suffix),
      brokerRuntimeDigest: digests.worker,
      adotRuntimeDigest: `sha256:${'e'.repeat(64)}`,
    })),
  };
}

function fixture() {
  const health = Buffer.from('{"data":{"status":"alive"}}\n');
  const readiness = Buffer.from('{"data":{"status":"ready"}}\n');
  const runtime = apiWebRuntime();
  const broker = brokerRuntime();
  return {
    manifest: manifest(),
    contractEnvelope: contractEnvelope(),
    apiWebRuntime: runtime,
    brokerRuntime: broker,
    health: {
      raw: health,
      value: JSON.parse(health.toString('utf8')) as Record<string, unknown>,
    },
    readiness: {
      raw: readiness,
      value: JSON.parse(readiness.toString('utf8')) as Record<string, unknown>,
    },
    smokeEnvelope: {
      schemaVersion: 'aeostudio.production-smoke-envelope.v2',
      environment: 'production',
      region,
      accountId,
      repository,
      sourceSha,
      buildRunId,
      buildRunAttempt,
      releaseId,
      endpoint: { origin },
      digests: {
        adot: digests.adot,
        api: digests.api,
        web: digests.web,
        worker: digests.worker,
        tenantDataBroker: digests.worker,
      },
      apiWebRuntime: runtime,
      brokerRuntime: broker,
      completedAt: smokeCompletedAt,
      checks: {
        health: {
          status: 200,
          responseSha256: createHash('sha256').update(health).digest('hex'),
          effectiveUrl: `${origin}/health`,
          remoteIp: '203.0.113.10',
          tlsVerifyResult: 0,
        },
        readiness: {
          status: 200,
          responseSha256: createHash('sha256').update(readiness).digest('hex'),
          effectiveUrl: `${origin}/ready`,
          remoteIp: '203.0.113.11',
          tlsVerifyResult: 0,
        },
        apiRuntimeIdentity: 'PASSED',
        webRuntimeIdentity: 'PASSED',
      },
    },
    expected: {
      accountId,
      buildRunAttempt,
      buildRunId,
      origin,
      githubEnvironmentEvidenceSha256,
      githubEnvironmentSnapshotSha256,
      githubEnvironmentValidatedAt,
      now: finalizationNow,
      promotionControlPlaneEvidenceSha256,
      promotionControlPlaneSnapshotSha256,
      promotionControlPlaneValidatedAt,
      region,
      releaseId,
      repository,
      sourceSha,
    },
  };
}

describe('Task 18 production finalization evidence', () => {
  test('rejects self-consistent post-approval evidence that differs from the pre-approval hashes', () => {
    const githubCore = {
      schemaVersion: 'aeostudio.github-environment-evidence.v1',
      repository,
      sourceSha,
      production: { environment: 'production' },
      stagingDeployment: { environment: 'staging' },
    };
    const githubEvidence = {
      ...githubCore,
      evidenceSha256: createHash('sha256').update(JSON.stringify(githubCore)).digest('hex'),
      validatedAt: githubEnvironmentValidatedAt,
    };
    expect(() =>
      validator.validateGitHubEnvironmentEvidenceHash(
        githubEvidence,
        { repository, sourceSha },
        '1'.repeat(64),
      ),
    ).toThrow('PRODUCTION_GITHUB_ENVIRONMENT_EVIDENCE_HASH_MISMATCH');

    const controlPlaneCore = {
      schemaVersion: 'aeostudio.github-promotion-control-plane.v1',
      repository,
      sourceSha,
      maxAgeHours: 168,
      runs: { build: { id: '100' } },
      artifacts: { releaseManifest: { id: '200' } },
    };
    const controlPlaneEvidence = {
      ...controlPlaneCore,
      controlPlaneSha256: createHash('sha256')
        .update(JSON.stringify(controlPlaneCore))
        .digest('hex'),
      validatedAt: '2026-07-24T10:00:00.000Z',
    };
    expect(() =>
      validator.validatePromotionControlPlaneEvidenceHash(
        controlPlaneEvidence,
        { repository, sourceSha },
        '2'.repeat(64),
      ),
    ).toThrow('PRODUCTION_PROMOTION_CONTROL_PLANE_EVIDENCE_HASH_MISMATCH');
  });

  test('binds each canonical post-approval snapshot without changing its immutable hash', () => {
    const githubCore = {
      schemaVersion: 'aeostudio.github-environment-evidence.v1',
      repository,
      sourceSha,
      production: { environment: 'production' },
      stagingDeployment: { environment: 'staging' },
    };
    const stableSha256 = createHash('sha256').update(JSON.stringify(githubCore)).digest('hex');
    const firstSnapshot = {
      ...githubCore,
      evidenceSha256: stableSha256,
      validatedAt: githubEnvironmentValidatedAt,
    };
    const secondSnapshot = {
      ...firstSnapshot,
      validatedAt: promotionControlPlaneValidatedAt,
    };

    const first = validator.validateGitHubEnvironmentEvidenceHash(
      firstSnapshot,
      { repository, sourceSha },
      stableSha256,
    );
    const second = validator.validateGitHubEnvironmentEvidenceHash(
      secondSnapshot,
      { repository, sourceSha },
      stableSha256,
    );

    expect(first.stableSha256).toBe(stableSha256);
    expect(second.stableSha256).toBe(stableSha256);
    expect(first.validatedAt).toBe(githubEnvironmentValidatedAt);
    expect(second.validatedAt).toBe(promotionControlPlaneValidatedAt);
    expect(first.snapshotSha256).toBe(
      createHash('sha256')
        .update(JSON.stringify(canonicalJson(firstSnapshot)))
        .digest('hex'),
    );
    expect(second.snapshotSha256).not.toBe(first.snapshotSha256);
  });

  test('authorizes FINALIZE only from exact health, contract, Broker, API and Web evidence', () => {
    expect(validator.validateProductionFinalizationEvidence(fixture())).toMatchObject({
      schemaVersion: 'aeostudio.production-finalization-evidence.v1',
      outcome: 'PASS',
      environment: 'production',
      region,
      accountId,
      repository,
      sourceSha,
      buildRunId,
      buildRunAttempt,
      releaseId,
      endpointOrigin: origin,
      evidence: {
        githubEnvironmentEvidenceSha256,
        githubEnvironmentSnapshotSha256,
        githubEnvironmentValidatedAt,
        promotionControlPlaneEvidenceSha256,
        promotionControlPlaneSnapshotSha256,
        promotionControlPlaneValidatedAt,
      },
      runtimeIdentity: {
        clusterArn,
        apiTaskDefinitionArn: taskDefinitions.api,
        webTaskDefinitionArn: taskDefinitions.web,
        brokerTaskDefinitionArn: taskDefinitions.broker,
        apiImageDigest: digests.api,
        webImageDigest: digests.web,
        endpointOrigin: origin,
        loadBalancerArn,
        listenerArn,
      },
    });
  });

  test('rejects post-approval snapshots that predate smoke, expire, or come from the future', () => {
    const beforeSmoke = fixture();
    beforeSmoke.expected.githubEnvironmentValidatedAt = '2026-07-24T09:59:59.999Z';
    expect(() => validator.validateProductionFinalizationEvidence(beforeSmoke)).toThrow(
      'PRODUCTION_POST_APPROVAL_EVIDENCE_BEFORE_SMOKE',
    );

    const expired = fixture();
    expired.expected.now = '2026-07-24T10:17:00.001Z';
    expect(() => validator.validateProductionFinalizationEvidence(expired)).toThrow(
      'PRODUCTION_POST_APPROVAL_EVIDENCE_EXPIRED',
    );

    const future = fixture();
    future.expected.promotionControlPlaneValidatedAt = '2026-07-24T10:05:00.001Z';
    expect(() => validator.validateProductionFinalizationEvidence(future)).toThrow(
      'PRODUCTION_POST_APPROVAL_EVIDENCE_FROM_FUTURE',
    );
  });

  test('rejects runtime task, probe hash, or smoke identity drift before FINALIZE', () => {
    const missingTask = fixture();
    (
      (
        (missingTask.apiWebRuntime.services as Record<string, unknown>).api as Record<
          string,
          unknown
        >
      ).tasks as unknown[]
    ).pop();
    expect(() => validator.validateProductionFinalizationEvidence(missingTask)).toThrow(
      'PRODUCTION_API_WEB_RUNTIME_INVALID',
    );

    const changedHealth = fixture();
    changedHealth.health.raw = Buffer.from('{"data":{"status":"alive"},"drift":true}\n');
    expect(() => validator.validateProductionFinalizationEvidence(changedHealth)).toThrow(
      'PRODUCTION_SMOKE_EVIDENCE_INVALID',
    );

    const identityNotPassed = fixture();
    (identityNotPassed.smokeEnvelope.checks as Record<string, unknown>).apiRuntimeIdentity =
      'NOT_CHECKED';
    expect(() => validator.validateProductionFinalizationEvidence(identityNotPassed)).toThrow(
      'PRODUCTION_SMOKE_EVIDENCE_INVALID',
    );

    const noRouteBinding = fixture();
    delete noRouteBinding.apiWebRuntime.routeBinding;
    expect(() => validator.validateProductionFinalizationEvidence(noRouteBinding)).toThrow(
      'PRODUCTION_API_WEB_RUNTIME_INVALID',
    );

    const splitCapableRoute = fixture();
    (splitCapableRoute.apiWebRuntime.routeBinding as Record<string, unknown>).ipAddressType =
      'dualstack';
    expect(() => validator.validateProductionFinalizationEvidence(splitCapableRoute)).toThrow(
      'PRODUCTION_API_WEB_RUNTIME_INVALID',
    );

    const redirectedProbe = fixture();
    (
      (redirectedProbe.smokeEnvelope.checks as Record<string, unknown>).health as Record<
        string,
        unknown
      >
    ).effectiveUrl = 'https://other.example.com/health';
    expect(() => validator.validateProductionFinalizationEvidence(redirectedProbe)).toThrow(
      'PRODUCTION_SMOKE_EVIDENCE_INVALID',
    );

    for (const probeName of ['health', 'readiness']) {
      const ipv6Probe = fixture();
      (
        (ipv6Probe.smokeEnvelope.checks as Record<string, unknown>)[probeName] as Record<
          string,
          unknown
        >
      ).remoteIp = '2001:db8::10';
      expect(() => validator.validateProductionFinalizationEvidence(ipv6Probe)).toThrow(
        'PRODUCTION_SMOKE_EVIDENCE_INVALID',
      );
    }
  });

  test('runs both identity probes and the final evidence validator before FINALIZE', async () => {
    const [workflow, finalizer] = await Promise.all([
      readFile(join(process.cwd(), '.github', 'workflows', 'deploy-production.yml'), 'utf8'),
      readFile(
        join(
          process.cwd(),
          'scripts',
          'acceptance',
          'validate-production-finalization-evidence.mjs',
        ),
        'utf8',
      ),
    ]);
    const production = workflow.split('\n  deploy-production:')[1] ?? '';
    const runtimeIndex = production.indexOf(
      'Verify exact production API and Web ECS runtime identity',
    );
    const smokeIndex = production.indexOf('Smoke production health and exact runtime identity');
    const liveRereadIndex = production.indexOf(
      'Revalidate live promotion evidence immediately before finalization',
    );
    const evidenceIndex = production.indexOf(
      'Validate exact production evidence before finalization',
    );
    const evidenceUploadIndex = production.indexOf(
      'Upload immutable production finalization candidate',
    );
    const postCandidateRereadIndex = production.indexOf(
      'Revalidate live promotion evidence after candidate upload',
    );
    const finalizeIndex = production.indexOf('Finalize the exact production release');

    expect(runtimeIndex).toBeGreaterThan(0);
    expect(smokeIndex).toBeGreaterThan(runtimeIndex);
    expect(liveRereadIndex).toBeGreaterThan(smokeIndex);
    expect(evidenceIndex).toBeGreaterThan(liveRereadIndex);
    expect(evidenceUploadIndex).toBeGreaterThan(evidenceIndex);
    expect(postCandidateRereadIndex).toBeGreaterThan(evidenceUploadIndex);
    expect(finalizeIndex).toBeGreaterThan(postCandidateRereadIndex);
    expect(production).toContain('node scripts/smoke/verify-production-api-web-runtime.mjs');
    expect(production).toContain('--origin "$PRODUCTION_BASE_URL"');
    expect(production).toContain('release/production-api-web-runtime.json');
    expect(production).toContain('--max-redirs 0');
    expect(production.match(/--ipv4/gu)).toHaveLength(2);
    expect(production).toContain('%{url_effective}');
    expect(production).toContain('%{ssl_verify_result}');
    expect(production).toContain('aeostudio.production-smoke-envelope.v2');
    expect(production).toContain('--slurpfile apiWebRuntime');
    expect(production).toContain('apiRuntimeIdentity:"PASSED"');
    expect(production).toContain('webRuntimeIdentity:"PASSED"');
    expect(production).toContain(
      'node scripts/acceptance/validate-production-finalization-evidence.mjs',
    );
    expect(production).toContain('id: final-evidence');
    expect(production).toContain('id: pre-finalize-live-evidence');
    expect(production).toContain(
      "if: ${{ steps.pre-finalize-live-evidence.outcome == 'success' }}",
    );
    expect(production).toContain('id: persist-finalization-candidate');
    expect(production).toContain(
      "if: ${{ steps.persist-finalization-candidate.outcome == 'success' }}",
    );
    expect(production).toContain('release/production-finalization-evidence.json');
    expect(production).toContain(
      'AEO_PRODUCTION_GITHUB_ENVIRONMENT_EVIDENCE_PATH: release/production-github-environment-evidence-pre-finalize.json',
    );
    expect(production).toContain(
      'AEO_PRODUCTION_PROMOTION_CONTROL_PLANE_EVIDENCE_PATH: release/production-promotion-control-plane-pre-finalize.json',
    );
    expect(production).toContain(
      'AEO_GITHUB_ENVIRONMENT_EVIDENCE_OUTPUT: release/production-github-environment-evidence-pre-finalize.json',
    );
    expect(production).toContain(
      'AEO_PROMOTION_CONTROL_PLANE_OUTPUT: release/production-promotion-control-plane-pre-finalize.json',
    );
    expect(
      production.match(/node scripts\/acceptance\/github-environment-evidence\.mjs/gu),
    ).toHaveLength(3);
    expect(
      production.match(/node scripts\/acceptance\/github-promotion-control-plane\.mjs/gu),
    ).toHaveLength(3);
    expect(finalizer).toContain(
      "requiredEnvironment('AEO_PRODUCTION_GITHUB_ENVIRONMENT_EVIDENCE_PATH')",
    );
    expect(finalizer).toContain(
      "requiredEnvironment('AEO_PRODUCTION_PROMOTION_CONTROL_PLANE_EVIDENCE_PATH')",
    );
    expect(finalizer).toContain('process.env.GITHUB_OUTPUT');
    expect(finalizer).toContain('evidence_sha256=${result.evidenceSha256}');
    expect(production).toContain(
      'AEO_PRODUCTION_EXPECTED_GITHUB_ENVIRONMENT_EVIDENCE_SHA256: ${{ needs.validate-release.outputs.github-environment-evidence-sha256 }}',
    );
    expect(production).toContain(
      'AEO_PRODUCTION_EXPECTED_PROMOTION_CONTROL_PLANE_EVIDENCE_SHA256: ${{ needs.validate-release.outputs.control-plane-sha256 }}',
    );
  });
});

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalJson(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
