import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();

async function text(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8');
}

describe('Task 18 Tenant Data Broker atomic release', () => {
  test('mirrors the pinned ADOT upstream into private ECR and verifies its supply chain', async () => {
    const [bootstrap, compute, release, build, production] = await Promise.all([
      text('infra/bootstrap/main.tf'),
      text('infra/modules/platform/compute.tf'),
      text('infra/modules/platform/release-control.tf'),
      text('.github/workflows/build-attest.yml'),
      text('.github/workflows/deploy-production.yml'),
    ]);

    expect(bootstrap).toMatch(/adot\s*=\s*"aeostudio-adot"/u);
    expect(compute).toContain('data "aws_ecr_repository" "adot"');
    expect(compute).toContain('local.adot_private_image');
    expect(release).toContain('local.adot_private_image');
    for (const task of [compute, release]) {
      expect(task).not.toMatch(/Image\s*=\s*var\.adot_image|image\s*=\s*var\.adot_image/u);
    }

    expect(build).toContain('ADOT_REPOSITORY: aeostudio-adot');
    expect(build).toMatch(
      /ADOT_UPSTREAM_IMAGE:\s*public\.ecr\.aws\/aws-observability\/aws-otel-collector@sha256:[0-9a-f]{64}/u,
    );
    expect(build).toMatch(
      /CRANE_IMAGE:\s*gcr\.io\/go-containerregistry\/crane@sha256:[0-9a-f]{64}/u,
    );
    expect(build).toContain('crane copy preserves the complete multi-platform index');
    expect(build).toContain('copy "$ADOT_UPSTREAM_IMAGE" "$destination_tag"');
    expect(build).toContain('test "$destination_digest" = "$upstream_digest"');
    expect(build).toContain('test "$ecr_digest" = "$upstream_digest"');
    expect(build).toContain('${{ steps.ecr.outputs.registry }}/${{ env.ADOT_REPOSITORY }}');
    expect(build).toContain('Block high or critical ADOT image vulnerabilities');
    expect(build).toContain('Block secrets in the exact ADOT image');
    expect(build).toContain('Generate ADOT CycloneDX SBOM');
    expect(build).toContain('osv-image-adot.json');
    expect(build).toContain('license-sbom-adot.cdx.json');
    expect(build).toContain('Attest ADOT provenance');
    expect(build).toContain('Attest ADOT CycloneDX SBOM');
    expect(build).toContain('attestations/adot-provenance.json');
    expect(build).toContain('attestations/adot-sbom.json');
    expect(production).toContain('for service in adot api web worker; do');
    expect(production).toContain('attestations/${service}-provenance.json');
    expect(production).toContain('attestations/${service}-sbom.json');
  });

  test('registers five exact task definitions with Broker image equal to Worker image', async () => {
    const [release, client] = await Promise.all([
      text('infra/modules/platform/release-control.tf'),
      text('scripts/release/run-release-broker.mjs'),
    ]);

    expect(release).toContain('release_tenant_data_broker_container');
    expect(release).toContain('"Register fixed Tenant Data Broker revision"');
    expect(release).toMatch(
      /Family\s*=\s*"\$\{local\.name\}-tenant-data-broker"[\s\S]*?"Image\.\$"\s*=\s*"States\.Format\('\$\{data\.aws_ecr_repository\.worker\.repository_url\}@\{\}', \$\.Release\.WorkerDigest\)"/u,
    );
    expect(release).toMatch(
      /TaskDefinitions\s*=\s*\{[\s\S]*?"TenantDataBroker\.\$"[\s\S]*?"Migration\.\$"/u,
    );
    expect(release).toMatch(/Images\s*=\s*\{[\s\S]*?"Worker\.\$"[\s\S]*?"TenantDataBroker\.\$"/u);
    expect(client).toContain("familyArn('tenant-data-broker')");
    expect(client).toContain('contract.TaskDefinitions.TenantDataBroker');
    expect(client).toContain('contract.Images.TenantDataBroker !== contract.Images.Worker');
    expect(client).toContain("for (const service of ['adot', 'api', 'web', 'worker'])");
    expect(release).toContain('"Exact ADOT digest matches"');
    expect(release).toContain('StringEqualsPath = "$.Release.AdotDigest"');
    expect(release).toMatch(
      /"Exact ADOT digest matches"[\s\S]*?StringEqualsPath\s*=\s*"\$\.Release\.AdotDigest"[\s\S]*?Next\s*=\s*"Build exact environment release lock"[\s\S]*?Default\s*=\s*"Release digest verification failed"/u,
    );
    expect(release.indexOf('"Release digest verification failed"')).toBeLessThan(
      release.indexOf('"Build exact environment release lock"'),
    );
  });

  test('captures deploys stabilizes and rolls back all four services atomically', async () => {
    const release = await text('infra/modules/platform/release-control.tf');
    for (const marker of [
      'Describe exact rollback Tenant Data Broker service',
      'RollbackTenantDataBroker',
      'Activate exact Tenant Data Broker',
      'Describe exact release Tenant Data Broker service',
      'Exact Tenant Data Broker targets healthy',
      'Restore exact Tenant Data Broker',
      'Describe exact rollback Tenant Data Broker target health',
    ]) {
      expect(release).toContain(marker);
    }
    expect(release).toContain('aws_ecs_service.tenant_data_broker.name');
    expect(release).toContain('aws_ecs_service.tenant_data_broker.id');
    expect(release).toContain('aws_lb_target_group.tenant_data_broker.arn');
    expect(release).toMatch(/Variable = "\$\.services\.ServiceCount", NumericEquals = 4/u);
    expect(release).toMatch(
      /Variable = "\$\.services\.TenantDataBrokerDesiredCount", NumericEquals = 2/u,
    );
    expect(release).toMatch(
      /Variable = "\$\.services\.TenantDataBrokerRunningCount", NumericEquals = 2/u,
    );
    expect(release).toMatch(
      /Variable = "\$\.services\.TenantDataBrokerPendingCount", NumericEquals = 0/u,
    );
    expect(release).toMatch(
      /TenantDataBrokerTaskDefinition", StringEqualsPath = "\$\.Contract\.Rollback\.TenantDataBroker"/u,
    );
  });

  test('carries Broker identity through staging acceptance trace load and promotion validators', async () => {
    const [build, production, acceptance, rollback, smoke, runtime, client, trace, promotion] =
      await Promise.all([
        text('.github/workflows/build-attest.yml'),
        text('.github/workflows/deploy-production.yml'),
        text('.github/workflows/staging-acceptance.yml'),
        text('scripts/smoke/rollback-staging.mjs'),
        text('scripts/smoke/staging-smoke.mjs'),
        text('scripts/smoke/verify-tenant-data-broker-runtime.mjs'),
        text('scripts/release/run-release-broker.mjs'),
        text('scripts/acceptance/collect-staging-trace-evidence.mjs'),
        text('scripts/acceptance/validate-production-promotion-evidence.mjs'),
      ]);
    const surfaces = [build, production, acceptance, rollback, runtime, client, trace, promotion];
    for (const surface of surfaces) {
      expect(surface).toMatch(/TenantDataBroker|tenant-data-broker/u);
    }
    expect(runtime).toContain("'describe-services'");
    expect(runtime).toContain("'describe-task-definition'");
    expect(runtime).toContain("'list-tasks'");
    expect(runtime).toContain("'describe-tasks'");
    expect(runtime).toContain("'describe-target-health'");
    expect(runtime).toMatch(/service\.desiredCount < 2/u);
    expect(runtime).toContain("TargetHealth?.State !== 'healthy'");
    expect(production).toContain('.brokerRuntime.tasks | type == "array"');
    expect(production).toContain('[.brokerRuntime.tasks[].taskArn] | unique | length');
    expect(production).toContain('all($brokerRuntime.tasks[];');
    expect(production).toContain('.brokerRuntimeDigest == $manifest[0].images.worker.digest');
    expect(production).toContain('.adotRuntimeDigest == $brokerRuntime.adotRuntimeDigest');
    expect(build).toContain("AWS_ACCESS_KEY_ID: ''");
    expect(smoke).not.toContain("'describe-services'");
  });

  test('keeps Broker executor and migration resource-authority values exact', async () => {
    const [compute, release] = await Promise.all([
      text('infra/modules/platform/compute.tf'),
      text('infra/modules/platform/release-control.tf'),
    ]);
    for (const source of [compute, release]) {
      const broker = source.slice(source.indexOf('tenant-data-broker'));
      for (const name of [
        'AWS_ACCOUNT_ID',
        'ARTIFACT_BUCKET',
        'AUDIT_EVIDENCE_BUCKET',
        'S3_KMS_KEY_ARN',
        'OTEL_SERVICE_NAME',
      ]) {
        expect(broker).toContain(name);
      }
      expect(broker).toContain('aeostudio-tenant-data-broker');
      expect(source).toMatch(
        /migration[\s\S]*?AWS_ACCOUNT_ID[\s\S]*?ARTIFACT_BUCKET[\s\S]*?AUDIT_EVIDENCE_BUCKET[\s\S]*?S3_KMS_KEY_ARN/u,
      );
    }
  });

  test('documents four-service bootstrap and rollback without reopening public ADOT', async () => {
    const [bootstrap, smoke] = await Promise.all([
      text('docs/operations/environment-bootstrap.md'),
      text('scripts/smoke/README.md'),
    ]);

    expect(bootstrap).toContain('all four ECS services');
    expect(bootstrap).toContain('Web, API, Worker, and Tenant Data Broker');
    expect(smoke).toContain('exactly four previously captured');
    expect(smoke).toContain('Tenant Data Broker');
    expect(`${bootstrap}\n${smoke}`).not.toContain('all three ECS services');
  });
});
