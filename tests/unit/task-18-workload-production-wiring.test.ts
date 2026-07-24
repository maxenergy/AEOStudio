import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

describe('Task 18 production workload privacy wiring', () => {
  test('API and Worker expose only the database-first durable workload wrapper', async () => {
    const [api, worker, privacyWorker, composition] = await Promise.all([
      readSource('../../apps/api/src/runtime/resolve-runtime.ts'),
      readSource('../../apps/worker/src/production-workload-worker-runtime.ts'),
      readSource('../../apps/worker/src/production-privacy-lifecycle-worker-runtime.ts'),
      readSource('../../apps/worker/src/production-worker-composition.ts'),
    ]);

    expect(api).toContain('new DurableWorkloadObjectStorage(');
    expect(api).toContain('artifactPayloadStore: durableWorkloadObjectStorage');
    expect(api).toContain(
      'channelPackagePayloadStore: durableWorkloadObjectStorage.channelPackages()',
    );
    expect(api).not.toContain('artifactPayloadStore: workloadObjectStorage.artifacts');
    expect(api).not.toContain('channelPackagePayloadStore: workloadObjectStorage.channelPackages');

    expect(worker).toContain('const durableStorage = new DurableWorkloadObjectStorage(');
    expect(worker).not.toContain('input.storage.artifacts');
    expect(worker).not.toContain('input.storage.channelPackages');
    expect(worker).not.toContain('input.storage.crawls');

    expect(privacyWorker).toContain('new PostgresWorkloadObjectWriteIntentStore(pool)');
    expect(privacyWorker).toContain('workloadWrites:');
    expect(privacyWorker).toContain('lifecycleGateway: input.lifecycleGateway');
    expect(composition).toContain('storage: { storage: tenantDataBroker.workload }');
    expect(composition).toContain('publicationPackages: tenantDataBroker.workload');
    expect(composition).toContain('publicationSecrets: tenantDataBroker.workload');
    expect(composition).toContain('lifecycleGateway: tenantDataBroker.lifecycle');
  });

  test('the Broker inventory IAM covers the Tenant Workspace artifact prefix', async () => {
    const iam = await readSource('../../infra/modules/platform/iam.tf');
    expect(iam).toMatch(
      /ListExactTenantArtifactVersions[\s\S]*?s3:ListBucketVersions[\s\S]*?tenants\/\*\/workspaces\/\*/u,
    );
  });
});

function readSource(relative: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}
