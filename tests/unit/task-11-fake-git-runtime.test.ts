import { encodeGitPullRequestTarget } from '@aeostudio/adapters/publication';
import { afterEach, describe, expect, test } from 'vitest';

import { resolveApiRuntime } from '../../apps/api/src/runtime/resolve-runtime.js';

const ORIGINAL_AUTH_MODE = process.env.AEOSTUDIO_AUTH_MODE;
const ORIGINAL_ADAPTER_MODE = process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE;
const ORIGINAL_GIT_MODE = process.env.AEOSTUDIO_GIT_PROVIDER_MODE;
const ORIGINAL_ALLOW_FAKE_RUNTIME = process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

const context = {
  tenantId: '00000000-0000-7000-8000-000000000001',
  workspaceId: '00000000-0000-7000-8000-000000000002',
  actorUserId: '00000000-0000-7000-8000-000000000003',
  membershipId: '00000000-0000-7000-8000-000000000004',
  role: 'OWNER' as const,
};

afterEach(() => {
  restoreEnvironment('AEOSTUDIO_AUTH_MODE', ORIGINAL_AUTH_MODE);
  restoreEnvironment('AEOSTUDIO_CHANNEL_ADAPTER_MODE', ORIGINAL_ADAPTER_MODE);
  restoreEnvironment('AEOSTUDIO_GIT_PROVIDER_MODE', ORIGINAL_GIT_MODE);
  restoreEnvironment('AEOSTUDIO_ALLOW_FAKE_RUNTIME', ORIGINAL_ALLOW_FAKE_RUNTIME);
  restoreEnvironment('NODE_ENV', ORIGINAL_NODE_ENV);
});

describe.sequential('Task 11 explicit fake Git runtime', () => {
  test('registers the Git PR channel only behind all explicit fake switches', async () => {
    process.env.NODE_ENV = 'test';
    process.env.AEOSTUDIO_ALLOW_FAKE_RUNTIME = 'true';
    process.env.AEOSTUDIO_AUTH_MODE = 'fake';
    process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE = 'fake';
    delete process.env.AEOSTUDIO_GIT_PROVIDER_MODE;

    const task10Runtime = await resolveApiRuntime({});
    expect(
      (await task10Runtime.options.channelRegistryStore?.listEntries({ context }))?.map(
        ({ channelKey }) => channelKey,
      ),
    ).toEqual([
      'portable-web-export',
      'third-party-site-handoff',
      'social-channel-handoff',
      'directory-handoff',
      'reviewed-test-publisher',
    ]);
    await task10Runtime.cleanup();

    process.env.AEOSTUDIO_GIT_PROVIDER_MODE = 'fake';
    const runtime = await resolveApiRuntime({});
    const entries = await runtime.options.channelRegistryStore?.listEntries({ context });
    expect(entries?.map(({ channelKey }) => channelKey)).toEqual([
      'portable-web-export',
      'third-party-site-handoff',
      'social-channel-handoff',
      'directory-handoff',
      'reviewed-test-publisher',
      'git-pull-request',
    ]);
    expect(entries?.find((entry) => entry.channelKey === 'git-pull-request')).toMatchObject({
      displayName: 'Git Pull Request',
      status: 'AVAILABLE',
      adapterVersions: [
        {
          adapterKey: 'git-pull-request',
          adapterVersion: '1.0.0',
          enabled: true,
          capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'PULL_REQUEST_STATUS'],
          requiredScopes: ['contents:write', 'pull_requests:write', 'metadata:read'],
          termsStatus: 'ALLOWED',
        },
      ],
    });
    const adapter = runtime.options.runtimeChannelAdapters?.resolve('git-pull-request', '1.0.0');
    expect(adapter).not.toBeNull();
    expect(adapter?.describe()).toMatchObject({
      adapterKey: 'git-pull-request',
      adapterVersion: '1.0.0',
    });
    expect(runtime.options.publicationCommandStore).toBeDefined();
    expect(runtime.options.publicationQueryStore).toBe(runtime.options.publicationCommandStore);
    expect(
      encodeGitPullRequestTarget({
        schemaVersion: 'git-pr-target.v1',
        provider: 'GITHUB',
        installationId: 'installation-tenant-a',
        repository: 'tenant-owned/site-content',
        baseBranch: 'main',
        pathPrefix: 'content/approved',
      }),
    ).toMatch(/^git-pr:v1:/);
    await runtime.cleanup();
  });

  test('refuses the fake Git provider switch in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AEOSTUDIO_AUTH_MODE;
    delete process.env.AEOSTUDIO_CHANNEL_ADAPTER_MODE;
    process.env.AEOSTUDIO_GIT_PROVIDER_MODE = 'fake';

    await expect(resolveApiRuntime({})).rejects.toThrow('FAKE_RUNTIME_FORBIDDEN_IN_PRODUCTION');
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
