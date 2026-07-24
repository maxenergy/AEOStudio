import { describe, expect, test, vi } from 'vitest';

import { createProductionPublicationAdapterRegistry } from '@aeostudio/adapters/publication';
import type { PublicationAdapterCommand } from '@aeostudio/application/channels-publishing';
import { encodeGitPullRequestTarget } from '@aeostudio/contracts/channels';
import type {
  ChannelPackagePayload,
  ChannelPackageRecord,
} from '@aeostudio/domain/channels-publishing';

describe('production GitHub Pull Request publication Adapter', () => {
  test('produces provider-observed authorization evidence without a publication side effect', async () => {
    const request = vi.fn((input: { method: string; path: string }) => {
      if (input.path === '/installation') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: {
            id: 42,
            permissions: {
              contents: 'write',
              pull_requests: 'write',
              metadata: 'read',
            },
          },
        });
      }
      if (input.path === '/installation/repositories?per_page=100&page=1') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { total_count: 1, repositories: [{ full_name: 'example/docs' }] },
        });
      }
      if (input.path === '/repos/example/docs') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { full_name: 'example/docs' },
        });
      }
      if (input.path === '/repos/example/docs/branches/main') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { name: 'main', protected: true },
        });
      }
      throw new Error(`UNEXPECTED_GITHUB_REQUEST:${input.method}:${input.path}`);
    });
    const adapter = createProductionPublicationAdapterRegistry({ github: { request } }).resolve(
      'git-pull-request',
      '1.0.0',
    );
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');
    const command = githubCommand();

    await expect(
      adapter.validateChannelAuthorization?.({
        tenantId: command.channelPackage.tenantId,
        workspaceId: command.channelPackage.workspaceId,
        channelDefinitionId: command.channelPackage.channel.definitionId,
        target: command.target,
        requestedScopes: ['contents:write', 'pull_requests:write', 'metadata:read'],
        acceptedTermsVersion: 'git-provider-terms-v1',
        secretValue: command.secretValue,
      }),
    ).resolves.toEqual({
      outcome: 'VERIFIED',
      actualTarget: command.target,
      actualScopes: ['contents:write', 'pull_requests:write', 'metadata:read'],
    });
    expect(request.mock.calls.map(([input]) => input.path)).toEqual([
      '/installation',
      '/installation/repositories?per_page=100&page=1',
      '/repos/example/docs',
      '/repos/example/docs/branches/main',
    ]);
  });

  test('authorizes an installation token only for its listed repository, claimed permissions, and protected base', async () => {
    const request = vi.fn(
      (input: {
        method: string;
        path: string;
        headers: Record<string, string>;
        body?: unknown;
      }) => {
        if (input.path === '/installation') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: {
              id: 42,
              permissions: {
                contents: 'write',
                pull_requests: 'write',
                metadata: 'read',
              },
            },
          });
        }
        if (input.path === '/installation/repositories?per_page=100&page=1') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: {
              total_count: 1,
              repositories: [{ full_name: 'example/docs' }],
            },
          });
        }
        if (input.path === '/repos/example/docs') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { full_name: 'example/docs' },
          });
        }
        if (input.path === '/repos/example/docs/branches/main') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { name: 'main', protected: true },
          });
        }
        throw new Error(`UNEXPECTED_GITHUB_REQUEST:${input.method}:${input.path}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      github: { request },
    }).resolve('git-pull-request', '1.0.0');
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');
    const command = githubCommand();

    await expect(adapter.validateAuthorization(command)).resolves.toEqual({ outcome: 'VALID' });
    expect(request.mock.calls.map(([input]) => input.path)).toEqual([
      '/installation',
      '/installation/repositories?per_page=100&page=1',
      '/repos/example/docs',
      '/repos/example/docs/branches/main',
    ]);
  });

  test('fails closed when GitHub revokes provider permissions after initial verification', async () => {
    const request = vi.fn((input: { method: string; path: string }) => {
      if (input.path === '/installation') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: {
            id: 42,
            permissions: {
              contents: 'read',
              pull_requests: 'write',
              metadata: 'read',
            },
          },
        });
      }
      throw new Error(`REMOTE_WRITE_MUST_NOT_RUN:${input.method}:${input.path}`);
    });
    const adapter = createProductionPublicationAdapterRegistry({ github: { request } }).resolve(
      'git-pull-request',
      '1.0.0',
    );
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');

    await expect(adapter.validateAuthorization(githubCommand())).resolves.toEqual({
      outcome: 'INVALID',
      reason: 'SCOPE_INSUFFICIENT',
    });
    expect(request.mock.calls.map(([input]) => input.path)).toEqual(['/installation']);
    expect(request.mock.calls.some(([input]) => input.method !== 'GET')).toBe(false);
  });

  test('does not duplicate the provider authorization read after the worker preflight', async () => {
    const request = createGitHubPublishRequest((body) => ({
      number: 29,
      html_url: 'https://github.com/example/docs/pull/29',
      state: 'open',
      merged_at: null,
      draft: true,
      body: body.body,
      head: { ref: body.head },
      base: { ref: body.base },
    }));
    const adapter = createProductionPublicationAdapterRegistry({ github: { request } }).resolve(
      'git-pull-request',
      '1.0.0',
    );
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');
    const command = githubCommand();

    await expect(adapter.validateAuthorization(command)).resolves.toEqual({ outcome: 'VALID' });
    await expect(adapter.publish(command)).resolves.toMatchObject({ outcome: 'APPLIED' });
    expect(request.mock.calls.filter(([input]) => input.path === '/installation')).toHaveLength(1);
  });

  test('fails closed before GitHub access when the local installation permission claims are insufficient', async () => {
    const request = vi.fn();
    const adapter = createProductionPublicationAdapterRegistry({
      github: { request },
    }).resolve('git-pull-request', '1.0.0');
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');
    const command = githubCommand();

    await expect(
      adapter.validateAuthorization({
        ...command,
        secretValue: JSON.stringify({
          schemaVersion: 'aeostudio.github-installation-credential.v1',
          installationId: '42',
          permissions: {
            contents: 'read',
            pull_requests: 'write',
            metadata: 'read',
          },
          token: 'github-installation-token-value',
        }),
      }),
    ).resolves.toEqual({ outcome: 'INVALID', reason: 'SCOPE_INSUFFICIENT' });
    expect(request).not.toHaveBeenCalled();
  });

  test('finds the exact target repository across bounded installation-token pagination', async () => {
    const request = vi.fn(
      (input: {
        method: string;
        path: string;
        headers: Record<string, string>;
        body?: unknown;
      }) => {
        if (input.path === '/installation') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: {
              id: 42,
              permissions: {
                contents: 'write',
                pull_requests: 'write',
                metadata: 'read',
              },
            },
          });
        }
        if (input.path === '/installation/repositories?per_page=100&page=1') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: {
              total_count: 101,
              repositories: Array.from({ length: 100 }, (_, index) => ({
                full_name: `example/other-${String(index)}`,
              })),
            },
          });
        }
        if (input.path === '/installation/repositories?per_page=100&page=2') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: {
              total_count: 101,
              repositories: [{ full_name: 'example/docs' }],
            },
          });
        }
        if (input.path === '/repos/example/docs') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { full_name: 'example/docs' },
          });
        }
        if (input.path === '/repos/example/docs/branches/main') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { name: 'main', protected: true },
          });
        }
        throw new Error(`UNEXPECTED_GITHUB_REQUEST:${input.method}:${input.path}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      github: { request },
    }).resolve('git-pull-request', '1.0.0');
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');

    await expect(adapter.validateAuthorization(githubCommand())).resolves.toEqual({
      outcome: 'VALID',
    });
    expect(request.mock.calls.map(([input]) => input.path).slice(0, 3)).toEqual([
      '/installation',
      '/installation/repositories?per_page=100&page=1',
      '/installation/repositories?per_page=100&page=2',
    ]);
  });

  test('writes the exact approved files to a topic branch and opens one draft Pull Request', async () => {
    let blob = 0;
    let branchSha: string | null = null;
    let commitMessage: string | null = null;
    let storedPullRequest: Record<string, unknown> | null = null;
    const request = vi.fn(
      (input: {
        method: string;
        path: string;
        headers: Record<string, string>;
        body?: unknown;
      }) => {
        if (input.path === '/installation/repositories?per_page=100&page=1') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: {
              total_count: 1,
              repositories: [{ full_name: 'example/docs' }],
            },
          });
        }
        if (input.path === '/repos/example/docs') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { full_name: 'example/docs' },
          });
        }
        if (input.path === '/repos/example/docs/branches/main') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { name: 'main', protected: true },
          });
        }
        if (input.path.startsWith('/repos/example/docs/pulls?')) {
          const summary = storedPullRequest === null ? null : { ...storedPullRequest };
          if (summary !== null) {
            delete summary.merged;
            delete summary.merged_at;
          }
          return Promise.resolve({
            status: 200,
            headers: {},
            body: summary === null ? [] : [summary],
          });
        }
        if (input.method === 'GET' && input.path === '/repos/example/docs/pulls/17') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: storedPullRequest,
          });
        }
        if (input.path === '/repos/example/docs/git/ref/heads/main') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { object: { sha: 'base-commit-sha' } },
          });
        }
        if (
          input.method === 'GET' &&
          input.path.startsWith('/repos/example/docs/git/ref/heads/aeostudio%2Fpublication-')
        ) {
          return Promise.resolve(
            branchSha === null
              ? { status: 404, headers: {}, body: null }
              : {
                  status: 200,
                  headers: {},
                  body: { object: { sha: branchSha } },
                },
          );
        }
        if (input.path === '/repos/example/docs/git/commits/base-commit-sha') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { tree: { sha: 'base-tree-sha' } },
          });
        }
        if (input.path === '/repos/example/docs/git/commits/approved-commit-sha') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { message: commitMessage, tree: { sha: 'approved-tree-sha' } },
          });
        }
        if (input.path === '/repos/example/docs/git/trees/base-tree-sha?recursive=1') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { truncated: false, tree: [] },
          });
        }
        if (input.method === 'POST' && input.path === '/repos/example/docs/git/blobs') {
          blob += 1;
          return Promise.resolve({
            status: 201,
            headers: {},
            body: { sha: `blob-${String(blob)}` },
          });
        }
        if (input.method === 'POST' && input.path === '/repos/example/docs/git/trees') {
          return Promise.resolve({
            status: 201,
            headers: {},
            body: { sha: 'approved-tree-sha' },
          });
        }
        if (input.method === 'POST' && input.path === '/repos/example/docs/git/commits') {
          commitMessage = (input.body as { message: string }).message;
          return Promise.resolve({
            status: 201,
            headers: {},
            body: { sha: 'approved-commit-sha' },
          });
        }
        if (input.method === 'POST' && input.path === '/repos/example/docs/git/refs') {
          branchSha = (input.body as { sha: string }).sha;
          return Promise.resolve({
            status: 201,
            headers: {},
            body: { ref: (input.body as { ref: string }).ref, object: { sha: branchSha } },
          });
        }
        if (input.method === 'POST' && input.path === '/repos/example/docs/pulls') {
          const body = input.body as { head: string; base: string; body: string };
          storedPullRequest = {
            number: 17,
            html_url: 'https://github.com/example/docs/pull/17',
            state: 'open',
            merged: false,
            merged_at: null,
            draft: true,
            body: body.body,
            head: {
              ref: body.head,
              sha: 'approved-commit-sha',
              repo: { full_name: 'example/docs' },
            },
            base: {
              ref: body.base,
              repo: { full_name: 'example/docs' },
            },
          };
          return Promise.resolve({
            status: 201,
            headers: {},
            body: storedPullRequest,
          });
        }
        if (input.method === 'PATCH' && input.path === '/repos/example/docs/pulls/17') {
          if (storedPullRequest === null) throw new Error('PULL_REQUEST_NOT_CREATED');
          storedPullRequest = { ...storedPullRequest, state: 'closed' };
          return Promise.resolve({ status: 200, headers: {}, body: storedPullRequest });
        }
        throw new Error(`UNEXPECTED_GITHUB_REQUEST:${input.method}:${input.path}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      github: { request },
    }).resolve('git-pull-request', '1.0.0');
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');
    const command = githubCommand();

    const result = await adapter.publish(command);

    expect(result).toMatchObject({
      outcome: 'APPLIED',
      remoteRef: 'https://github.com/example/docs/pull/17',
      remoteState: {
        status: 'PR_OPENED',
        number: 17,
        isProductionLive: false,
        rollbackHandle: {
          operation: 'CLOSE_PULL_REQUEST',
          repository: 'example/docs',
          pullRequestNumber: 17,
        },
      },
    });
    expect(
      request.mock.calls.filter(
        ([input]) => input.method === 'GET' && input.path === '/repos/example/docs/pulls/17',
      ),
    ).toHaveLength(1);
    const treeRequest = request.mock.calls
      .map(([input]) => input)
      .find((input) => input.method === 'POST' && input.path === '/repos/example/docs/git/trees');
    expect(treeRequest?.body).toEqual({
      base_tree: 'base-tree-sha',
      tree: [
        {
          path: 'content/approved/content.html',
          mode: '100644',
          type: 'blob',
          sha: 'blob-1',
        },
        {
          path: 'content/approved/content.md',
          mode: '100644',
          type: 'blob',
          sha: 'blob-2',
        },
        {
          path: 'content/approved/structured-data.json',
          mode: '100644',
          type: 'blob',
          sha: 'blob-3',
        },
      ],
    });
    const pullRequest = request.mock.calls
      .map(([input]) => input)
      .find((input) => input.method === 'POST' && input.path === '/repos/example/docs/pulls');
    expect(pullRequest?.body).toMatchObject({
      base: 'main',
      draft: true,
      title: 'AEOStudio approved content package',
    });
    expect(JSON.stringify(request.mock.calls)).not.toContain(command.secretValue);
    expect(JSON.stringify(result)).not.toContain('github-installation-token-value');

    const reconciled = await adapter.reconcile(command);

    expect(reconciled).toMatchObject({
      outcome: 'APPLIED',
      remoteRef: 'https://github.com/example/docs/pull/17',
      remoteState: { status: 'PR_OPENED', number: 17 },
    });
    expect(
      request.mock.calls.filter(
        ([input]) => input.method === 'POST' && input.path === '/repos/example/docs/pulls',
      ),
    ).toHaveLength(1);

    await expect(
      adapter.rollback?.({
        ...command,
        remoteRef: 'https://github.com/example/docs/pull/17',
      }),
    ).resolves.toEqual({
      outcome: 'ROLLED_BACK',
      remoteRef: 'https://github.com/example/docs/pull/17',
    });
    await expect(
      adapter.rollback?.({
        ...command,
        remoteRef: 'https://github.com/example/docs/pull/17',
      }),
    ).resolves.toEqual({
      outcome: 'ROLLED_BACK',
      remoteRef: 'https://github.com/example/docs/pull/17',
    });
    expect(
      request.mock.calls.filter(
        ([input]) => input.method === 'PATCH' && input.path === '/repos/example/docs/pulls/17',
      ),
    ).toHaveLength(1);
    await expect(adapter.refreshRemoteStatus?.(command)).resolves.toMatchObject({
      outcome: 'APPLIED',
      remoteRef: 'https://github.com/example/docs/pull/17',
      remoteState: {
        status: 'CLOSED',
        number: 17,
        isProductionLive: false,
        rollbackHandle: null,
      },
    });
    expect(
      request.mock.calls.filter(
        ([input]) => input.method === 'GET' && input.path === '/repos/example/docs/pulls/17',
      ).length,
    ).toBeGreaterThan(0);
  });

  test('resumes one draft Pull Request from its deterministic verified branch after interruption', async () => {
    let blob = 0;
    let commitMessage: string | null = null;
    let branchSha: string | null = null;
    let pullAttempts = 0;
    let storedPullRequest: Record<string, unknown> | null = null;
    const request = vi.fn(
      (input: {
        method: string;
        path: string;
        headers: Record<string, string>;
        body?: unknown;
      }) => {
        if (input.path === '/installation/repositories?per_page=100&page=1') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: {
              total_count: 1,
              repositories: [{ full_name: 'example/docs' }],
            },
          });
        }
        if (input.path === '/repos/example/docs') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { full_name: 'example/docs' },
          });
        }
        if (input.path === '/repos/example/docs/branches/main') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { name: 'main', protected: true },
          });
        }
        if (input.path.startsWith('/repos/example/docs/pulls?')) {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: storedPullRequest === null ? [] : [storedPullRequest],
          });
        }
        if (input.method === 'GET' && input.path === '/repos/example/docs/pulls/29') {
          return Promise.resolve({
            status: storedPullRequest === null ? 404 : 200,
            headers: {},
            body: storedPullRequest,
          });
        }
        if (input.path === '/repos/example/docs/git/ref/heads/main') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { object: { sha: 'base-commit-sha' } },
          });
        }
        if (
          input.method === 'GET' &&
          input.path.startsWith('/repos/example/docs/git/ref/heads/aeostudio%2Fpublication-')
        ) {
          return Promise.resolve(
            branchSha === null
              ? { status: 404, headers: {}, body: null }
              : {
                  status: 200,
                  headers: {},
                  body: { object: { sha: branchSha } },
                },
          );
        }
        if (input.path === '/repos/example/docs/git/commits/base-commit-sha') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { tree: { sha: 'base-tree-sha' } },
          });
        }
        if (input.path === '/repos/example/docs/git/commits/approved-commit-sha') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { message: commitMessage, tree: { sha: 'approved-tree-sha' } },
          });
        }
        if (input.path === '/repos/example/docs/git/trees/base-tree-sha?recursive=1') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { truncated: false, tree: [] },
          });
        }
        if (input.method === 'POST' && input.path === '/repos/example/docs/git/blobs') {
          blob += 1;
          return Promise.resolve({
            status: 201,
            headers: {},
            body: { sha: `blob-${String(blob)}` },
          });
        }
        if (input.method === 'POST' && input.path === '/repos/example/docs/git/trees') {
          return Promise.resolve({
            status: 201,
            headers: {},
            body: { sha: 'approved-tree-sha' },
          });
        }
        if (input.method === 'POST' && input.path === '/repos/example/docs/git/commits') {
          commitMessage = (input.body as { message: string }).message;
          return Promise.resolve({
            status: 201,
            headers: {},
            body: { sha: 'approved-commit-sha' },
          });
        }
        if (input.method === 'POST' && input.path === '/repos/example/docs/git/refs') {
          if (branchSha !== null) {
            return Promise.resolve({
              status: 422,
              headers: {},
              body: { message: 'Reference exists' },
            });
          }
          branchSha = (input.body as { sha: string }).sha;
          return Promise.resolve({
            status: 201,
            headers: {},
            body: { object: { sha: branchSha } },
          });
        }
        if (input.method === 'POST' && input.path === '/repos/example/docs/pulls') {
          pullAttempts += 1;
          if (pullAttempts <= 2) {
            return Promise.reject(new Error('NETWORK_INTERRUPTED_BEFORE_PULL_REQUEST'));
          }
          const body = input.body as { head: string; base: string; body: string };
          storedPullRequest = {
            number: 29,
            html_url: 'https://github.com/example/docs/pull/29',
            state: 'open',
            merged: false,
            merged_at: null,
            draft: true,
            body: body.body,
            head: {
              ref: body.head,
              sha: branchSha,
              repo: { full_name: 'example/docs' },
            },
            base: {
              ref: body.base,
              repo: { full_name: 'example/docs' },
            },
          };
          return Promise.resolve({
            status: 201,
            headers: {},
            body: storedPullRequest,
          });
        }
        throw new Error(`UNEXPECTED_GITHUB_REQUEST:${input.method}:${input.path}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      github: { request },
    }).resolve('git-pull-request', '1.0.0');
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');
    const command = githubCommand();

    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'GITHUB_REMOTE_WRITE_RESULT_UNKNOWN',
    });
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'GITHUB_PARTIAL_REMOTE_EFFECT_FOUND',
    });
    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'GITHUB_REMOTE_WRITE_RESULT_UNKNOWN',
    });
    await expect(adapter.publish(command)).resolves.toMatchObject({
      outcome: 'APPLIED',
      remoteRef: 'https://github.com/example/docs/pull/29',
      remoteState: { status: 'PR_OPENED', number: 29 },
    });
    expect(
      request.mock.calls.filter(
        ([input]) => input.method === 'POST' && input.path === '/repos/example/docs/git/blobs',
      ),
    ).toHaveLength(3);
    expect(
      request.mock.calls.filter(
        ([input]) => input.method === 'POST' && input.path === '/repos/example/docs/git/commits',
      ),
    ).toHaveLength(1);
    expect(
      request.mock.calls.filter(
        ([input]) => input.method === 'POST' && input.path === '/repos/example/docs/git/refs',
      ),
    ).toHaveLength(1);
    expect(
      request.mock.calls.filter(
        ([input]) => input.method === 'POST' && input.path === '/repos/example/docs/pulls',
      ),
    ).toHaveLength(3);
  });

  test('recovers from a concurrent existing-ref 422 only after the deterministic commit matches', async () => {
    let commitMessage: string | null = null;
    let branchSha: string | null = null;
    let topicRefReads = 0;
    let storedPullRequest: Record<string, unknown> | null = null;
    const request = vi.fn(
      (input: {
        method: string;
        path: string;
        headers: Record<string, string>;
        body?: unknown;
      }) => {
        if (input.path === '/installation/repositories?per_page=100&page=1') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: {
              total_count: 1,
              repositories: [{ full_name: 'example/docs' }],
            },
          });
        }
        if (input.path === '/repos/example/docs') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { full_name: 'example/docs' },
          });
        }
        if (input.path === '/repos/example/docs/branches/main') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { name: 'main', protected: true },
          });
        }
        if (input.path.startsWith('/repos/example/docs/pulls?')) {
          return Promise.resolve({ status: 200, headers: {}, body: [] });
        }
        if (input.method === 'GET' && input.path === '/repos/example/docs/pulls/31') {
          return Promise.resolve({
            status: storedPullRequest === null ? 404 : 200,
            headers: {},
            body: storedPullRequest,
          });
        }
        if (input.path === '/repos/example/docs/git/ref/heads/main') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { object: { sha: 'base-commit-sha' } },
          });
        }
        if (
          input.method === 'GET' &&
          input.path.startsWith('/repos/example/docs/git/ref/heads/aeostudio%2Fpublication-')
        ) {
          topicRefReads += 1;
          return Promise.resolve(
            topicRefReads === 1
              ? { status: 404, headers: {}, body: null }
              : {
                  status: 200,
                  headers: {},
                  body: { object: { sha: branchSha } },
                },
          );
        }
        if (input.path === '/repos/example/docs/git/commits/base-commit-sha') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { tree: { sha: 'base-tree-sha' } },
          });
        }
        if (
          input.path === '/repos/example/docs/git/commits/approved-commit-sha' ||
          input.path === '/repos/example/docs/git/commits/concurrent-commit-sha'
        ) {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { message: commitMessage, tree: { sha: 'approved-tree-sha' } },
          });
        }
        if (input.path === '/repos/example/docs/git/trees/base-tree-sha?recursive=1') {
          return Promise.resolve({
            status: 200,
            headers: {},
            body: { truncated: false, tree: [] },
          });
        }
        if (input.method === 'POST' && input.path === '/repos/example/docs/git/blobs') {
          return Promise.resolve({
            status: 201,
            headers: {},
            body: { sha: `blob-${String(request.mock.calls.length)}` },
          });
        }
        if (input.method === 'POST' && input.path === '/repos/example/docs/git/trees') {
          return Promise.resolve({
            status: 201,
            headers: {},
            body: { sha: 'approved-tree-sha' },
          });
        }
        if (input.method === 'POST' && input.path === '/repos/example/docs/git/commits') {
          commitMessage = (input.body as { message: string }).message;
          return Promise.resolve({
            status: 201,
            headers: {},
            body: { sha: 'approved-commit-sha' },
          });
        }
        if (input.method === 'POST' && input.path === '/repos/example/docs/git/refs') {
          branchSha = 'concurrent-commit-sha';
          return Promise.resolve({
            status: 422,
            headers: {},
            body: { message: 'Reference already exists' },
          });
        }
        if (input.method === 'POST' && input.path === '/repos/example/docs/pulls') {
          const body = input.body as { head: string; base: string; body: string };
          storedPullRequest = {
            number: 31,
            html_url: 'https://github.com/example/docs/pull/31',
            state: 'open',
            merged: false,
            merged_at: null,
            draft: true,
            body: body.body,
            head: {
              ref: body.head,
              sha: branchSha,
              repo: { full_name: 'example/docs' },
            },
            base: {
              ref: body.base,
              repo: { full_name: 'example/docs' },
            },
          };
          return Promise.resolve({
            status: 201,
            headers: {},
            body: storedPullRequest,
          });
        }
        throw new Error(`UNEXPECTED_GITHUB_REQUEST:${input.method}:${input.path}`);
      },
    );
    const adapter = createProductionPublicationAdapterRegistry({
      github: { request },
    }).resolve('git-pull-request', '1.0.0');
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');

    await expect(adapter.publish(githubCommand())).resolves.toMatchObject({
      outcome: 'APPLIED',
      remoteRef: 'https://github.com/example/docs/pull/31',
      remoteState: { status: 'PR_OPENED', number: 31 },
    });
    expect(topicRefReads).toBe(2);
    expect(
      request.mock.calls.filter(
        ([input]) => input.method === 'POST' && input.path === '/repos/example/docs/git/refs',
      ),
    ).toHaveLength(1);
  });

  test('rejects a created Pull Request readback whose URL is outside the exact repository', async () => {
    const request = createGitHubPublishRequest((body) => ({
      number: 37,
      html_url: 'https://github.com/other/docs/pull/37',
      state: 'open',
      merged_at: null,
      draft: true,
      body: body.body,
      head: { ref: body.head },
      base: { ref: body.base },
    }));
    const adapter = createProductionPublicationAdapterRegistry({
      github: { request },
    }).resolve('git-pull-request', '1.0.0');
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');

    await expect(adapter.publish(githubCommand())).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'GITHUB_PULL_REQUEST_RESULT_UNKNOWN',
    });
  });

  test('accepts a created Pull Request readback only when it is open, unmerged, and draft', async () => {
    const request = createGitHubPublishRequest((body) => ({
      number: 41,
      html_url: 'https://github.com/example/docs/pull/41',
      state: 'closed',
      merged_at: '2026-07-24T01:00:00Z',
      draft: false,
      body: body.body,
      head: { ref: body.head },
      base: { ref: body.base },
    }));
    const adapter = createProductionPublicationAdapterRegistry({
      github: { request },
    }).resolve('git-pull-request', '1.0.0');
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');

    await expect(adapter.publish(githubCommand())).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'GITHUB_PULL_REQUEST_RESULT_UNKNOWN',
    });
  });

  test('requires the exact publication marker in a created Pull Request readback', async () => {
    const request = createGitHubPublishRequest((body) => ({
      number: 43,
      html_url: 'https://github.com/example/docs/pull/43',
      state: 'open',
      merged_at: null,
      draft: true,
      body: `untrusted-prefix\n${body.body}`,
      head: { ref: body.head },
      base: { ref: body.base },
    }));
    const adapter = createProductionPublicationAdapterRegistry({
      github: { request },
    }).resolve('git-pull-request', '1.0.0');
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');

    await expect(adapter.publish(githubCommand())).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'GITHUB_PULL_REQUEST_RESULT_UNKNOWN',
    });
  });

  test('rejects an existing Pull Request URL outside the exact repository in publish and reconcile', async () => {
    let createdPullRequest: Record<string, unknown> | null = null;
    const request = createGitHubPublishRequest((body) => {
      createdPullRequest = {
        number: 47,
        html_url: 'https://github.com/example/docs/pull/47',
        state: 'open',
        merged_at: null,
        draft: true,
        body: body.body,
        head: { ref: body.head },
        base: { ref: body.base },
      };
      return createdPullRequest;
    });
    const adapter = createProductionPublicationAdapterRegistry({
      github: { request },
    }).resolve('git-pull-request', '1.0.0');
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');
    const command = githubCommand();
    await expect(adapter.publish(command)).resolves.toMatchObject({ outcome: 'APPLIED' });
    const conflictingPullRequest: Record<string, unknown> = {
      ...requireTestRecord(createdPullRequest, 'PULL_REQUEST_REQUIRED'),
      html_url: 'https://github.com/other/docs/pull/47',
    };
    request.mockImplementation((input) => {
      if (input.path === '/installation/repositories?per_page=100&page=1') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: {
            total_count: 1,
            repositories: [{ full_name: 'example/docs' }],
          },
        });
      }
      if (input.path === '/repos/example/docs') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { full_name: 'example/docs' },
        });
      }
      if (input.path === '/repos/example/docs/branches/main') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { name: 'main', protected: true },
        });
      }
      if (input.path.startsWith('/repos/example/docs/pulls?')) {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: [conflictingPullRequest],
        });
      }
      throw new Error(`UNEXPECTED_GITHUB_REQUEST:${input.method}:${input.path}`);
    });

    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'GITHUB_PULL_REQUEST_CONFLICT',
    });
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'GITHUB_REMOTE_EFFECT_CONFLICT',
    });
  });

  test('rejects an existing full Pull Request whose head repository or SHA differs from the verified branch', async () => {
    let createdPullRequest: Record<string, unknown> | null = null;
    const request = createGitHubPublishRequest((body) => {
      createdPullRequest = {
        number: 67,
        html_url: 'https://github.com/example/docs/pull/67',
        state: 'open',
        merged_at: null,
        draft: true,
        body: body.body,
        head: { ref: body.head },
        base: { ref: body.base },
      };
      return createdPullRequest;
    });
    const adapter = createProductionPublicationAdapterRegistry({
      github: { request },
    }).resolve('git-pull-request', '1.0.0');
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');
    const command = githubCommand();
    await expect(adapter.publish(command)).resolves.toMatchObject({ outcome: 'APPLIED' });
    if (createdPullRequest === null) throw new Error('PULL_REQUEST_REQUIRED');
    const commitRequest = request.mock.calls
      .map(([input]) => input)
      .find((input) => input.method === 'POST' && input.path === '/repos/example/docs/git/commits');
    const expectedCommitMessage = (commitRequest?.body as { message?: unknown } | undefined)
      ?.message;
    if (typeof expectedCommitMessage !== 'string') throw new Error('COMMIT_MESSAGE_REQUIRED');
    request.mockImplementation((input) => {
      if (input.path === '/installation/repositories?per_page=100&page=1') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: {
            total_count: 1,
            repositories: [{ full_name: 'example/docs' }],
          },
        });
      }
      if (input.path === '/repos/example/docs') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { full_name: 'example/docs' },
        });
      }
      if (input.path === '/repos/example/docs/branches/main') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { name: 'main', protected: true },
        });
      }
      if (input.path.startsWith('/repos/example/docs/pulls?')) {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: [createdPullRequest],
        });
      }
      if (
        input.method === 'GET' &&
        input.path.startsWith('/repos/example/docs/git/ref/heads/aeostudio%2Fpublication-')
      ) {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { object: { sha: 'approved-commit-sha' } },
        });
      }
      if (input.path === '/repos/example/docs/git/commits/approved-commit-sha') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { message: expectedCommitMessage },
        });
      }
      if (input.method === 'GET' && input.path === '/repos/example/docs/pulls/67') {
        const head = createdPullRequest?.head;
        const base = createdPullRequest?.base;
        return Promise.resolve({
          status: 200,
          headers: {},
          body: {
            ...createdPullRequest,
            merged: false,
            head: {
              ...(typeof head === 'object' && head !== null ? head : {}),
              sha: 'different-commit-sha',
              repo: { full_name: 'other/docs' },
            },
            base: {
              ...(typeof base === 'object' && base !== null ? base : {}),
              repo: { full_name: 'example/docs' },
            },
          },
        });
      }
      throw new Error(`UNEXPECTED_GITHUB_REQUEST:${input.method}:${input.path}`);
    });

    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'GITHUB_PULL_REQUEST_CONFLICT',
    });
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'GITHUB_REMOTE_EFFECT_CONFLICT',
    });
  });

  test('rejects a blob whose encoded request would exceed the 8 MiB transport limit before mutation', async () => {
    const request = createGitHubPublishRequest((body) => ({
      number: 53,
      html_url: 'https://github.com/example/docs/pull/53',
      state: 'open',
      merged_at: null,
      draft: true,
      body: body.body,
      head: { ref: body.head },
      base: { ref: body.base },
    }));
    const adapter = createProductionPublicationAdapterRegistry({
      github: { request },
    }).resolve('git-pull-request', '1.0.0');
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');
    const command = githubCommand();

    await expect(
      adapter.publish({
        ...command,
        payload: {
          files: {
            ...command.payload.files,
            'content.md': 'a'.repeat(6 * 1024 * 1024),
          },
        },
      }),
    ).resolves.toEqual({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'GITHUB_PACKAGE_INVALID',
    });
    expect(request.mock.calls.some(([input]) => input.method !== 'GET')).toBe(false);
  });

  test('rejects multiple Pull Requests matching the same deterministic publication marker', async () => {
    let createdPullRequest: Record<string, unknown> | null = null;
    const request = createGitHubPublishRequest((body) => {
      createdPullRequest = {
        number: 59,
        html_url: 'https://github.com/example/docs/pull/59',
        state: 'open',
        merged_at: null,
        draft: true,
        body: body.body,
        head: { ref: body.head },
        base: { ref: body.base },
      };
      return createdPullRequest;
    });
    const adapter = createProductionPublicationAdapterRegistry({
      github: { request },
    }).resolve('git-pull-request', '1.0.0');
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');
    const command = githubCommand();
    await expect(adapter.publish(command)).resolves.toMatchObject({ outcome: 'APPLIED' });
    const duplicatePullRequest: Record<string, unknown> = {
      ...requireTestRecord(createdPullRequest, 'PULL_REQUEST_REQUIRED'),
      number: 61,
      html_url: 'https://github.com/example/docs/pull/61',
    };
    request.mockImplementation((input) => {
      if (input.path === '/installation/repositories?per_page=100&page=1') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: {
            total_count: 1,
            repositories: [{ full_name: 'example/docs' }],
          },
        });
      }
      if (input.path === '/repos/example/docs') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { full_name: 'example/docs' },
        });
      }
      if (input.path === '/repos/example/docs/branches/main') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { name: 'main', protected: true },
        });
      }
      if (input.path.startsWith('/repos/example/docs/pulls?')) {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: [createdPullRequest, duplicatePullRequest],
        });
      }
      throw new Error(`UNEXPECTED_GITHUB_REQUEST:${input.method}:${input.path}`);
    });

    await expect(adapter.publish(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'GITHUB_PULL_REQUEST_CONFLICT',
    });
    await expect(adapter.reconcile(command)).resolves.toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'GITHUB_REMOTE_EFFECT_CONFLICT',
    });
  });

  test('accepts GitHub canonical repository URL casing while preserving the exact Pull Request number', async () => {
    const request = createGitHubPublishRequest((body) => ({
      number: 71,
      html_url: 'https://github.com/Example/Docs/pull/71',
      state: 'open',
      merged_at: null,
      draft: true,
      body: body.body,
      head: { ref: body.head },
      base: { ref: body.base },
    }));
    const adapter = createProductionPublicationAdapterRegistry({
      github: { request },
    }).resolve('git-pull-request', '1.0.0');
    if (adapter === null) throw new Error('GITHUB_ADAPTER_REQUIRED');

    await expect(adapter.publish(githubCommand())).resolves.toMatchObject({
      outcome: 'APPLIED',
      remoteRef: 'https://github.com/Example/Docs/pull/71',
      remoteState: { status: 'PR_OPENED', number: 71 },
    });
  });
});

function githubCommand(): PublicationAdapterCommand {
  const payload: ChannelPackagePayload = {
    files: {
      'content.html': '<article><h1>Approved content</h1></article>',
      'content.md': '# Approved content\n',
      'structured-data.json': '{"@context":"https://schema.org","@type":"Article"}',
    },
  };
  const channelPackage: ChannelPackageRecord = {
    id: '00000000-0000-7000-8000-000000008010',
    tenantId: '00000000-0000-7000-8000-000000008011',
    workspaceId: '00000000-0000-7000-8000-000000008012',
    packageRevision: 1,
    channel: {
      definitionId: '00000000-0000-7000-8000-000000008013',
      channelKey: 'git-pull-request',
    },
    transformer: { key: 'generic-web-package', version: '1.0.0' },
    packageSchemaVersion: '1.0.0',
    artifact: {
      artifactId: '00000000-0000-7000-8000-000000008014',
      artifactRevisionId: '00000000-0000-7000-8000-000000008015',
      revision: 1,
      contentHash: 'a'.repeat(64),
      type: 'DEFINITION_PRODUCT',
      locale: 'en-SG',
      market: 'SG',
      methodPolicyVersion: 'production-github-test-v1',
    },
    manifest: {
      schemaVersion: '1.0.0',
      files: Object.entries(payload.files).map(([path, value]) => ({
        path,
        mediaType:
          path === 'content.md'
            ? 'text/markdown'
            : path === 'content.html'
              ? 'text/html'
              : 'application/ld+json',
        sha256: 'b'.repeat(64),
        byteLength: Buffer.byteLength(value, 'utf8'),
      })),
      assetRefs: [],
      claimSourceMap: [],
    },
    packageChecksum: 'c'.repeat(64),
    payloadObjectRef: 's3://test-bucket/channel-package.json',
    createdByUserId: '00000000-0000-7000-8000-000000008016',
    createdAt: '2026-07-24T00:00:00.000Z',
  };
  return {
    publicationId: '00000000-0000-7000-8000-000000008017',
    idempotencyKey: '00000000-0000-7000-8000-000000008017',
    target: encodeGitPullRequestTarget({
      schemaVersion: 'git-pr-target.v1',
      provider: 'GITHUB',
      installationId: '42',
      repository: 'example/docs',
      baseBranch: 'main',
      pathPrefix: 'content/approved',
    }),
    channelPackage,
    payload,
    secretValue: JSON.stringify({
      schemaVersion: 'aeostudio.github-installation-credential.v1',
      installationId: '42',
      permissions: {
        contents: 'write',
        pull_requests: 'write',
        metadata: 'read',
      },
      token: 'github-installation-token-value',
    }),
  };
}

function createGitHubPublishRequest(
  pullRequest: (body: { head: string; base: string; body: string }) => Record<string, unknown>,
) {
  let blob = 0;
  let createdPullRequest: Record<string, unknown> | null = null;
  return vi.fn(
    (input: { method: string; path: string; headers: Record<string, string>; body?: unknown }) => {
      if (input.path === '/installation') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: {
            id: 42,
            permissions: {
              contents: 'write',
              pull_requests: 'write',
              metadata: 'read',
            },
          },
        });
      }
      if (input.path === '/installation/repositories?per_page=100&page=1') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: {
            total_count: 1,
            repositories: [{ full_name: 'example/docs' }],
          },
        });
      }
      if (input.path === '/repos/example/docs') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { full_name: 'example/docs' },
        });
      }
      if (input.path === '/repos/example/docs/branches/main') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { name: 'main', protected: true },
        });
      }
      if (input.path.startsWith('/repos/example/docs/pulls?')) {
        return Promise.resolve({ status: 200, headers: {}, body: [] });
      }
      if (
        input.method === 'GET' &&
        /^\/repos\/example\/docs\/pulls\/[1-9][0-9]*$/u.test(input.path)
      ) {
        if (createdPullRequest === null) {
          return Promise.resolve({ status: 404, headers: {}, body: null });
        }
        const head = createdPullRequest.head;
        const base = createdPullRequest.base;
        return Promise.resolve({
          status: 200,
          headers: {},
          body: {
            ...createdPullRequest,
            merged:
              typeof createdPullRequest.merged === 'boolean'
                ? createdPullRequest.merged
                : createdPullRequest.merged_at !== null,
            head: {
              ...(typeof head === 'object' && head !== null ? head : {}),
              sha: 'approved-commit-sha',
              repo: { full_name: 'example/docs' },
            },
            base: {
              ...(typeof base === 'object' && base !== null ? base : {}),
              repo: { full_name: 'example/docs' },
            },
          },
        });
      }
      if (input.path === '/repos/example/docs/git/ref/heads/main') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { object: { sha: 'base-commit-sha' } },
        });
      }
      if (
        input.method === 'GET' &&
        input.path.startsWith('/repos/example/docs/git/ref/heads/aeostudio%2Fpublication-')
      ) {
        return Promise.resolve({ status: 404, headers: {}, body: null });
      }
      if (input.path === '/repos/example/docs/git/commits/base-commit-sha') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { tree: { sha: 'base-tree-sha' } },
        });
      }
      if (input.path === '/repos/example/docs/git/trees/base-tree-sha?recursive=1') {
        return Promise.resolve({
          status: 200,
          headers: {},
          body: { truncated: false, tree: [] },
        });
      }
      if (input.method === 'POST' && input.path === '/repos/example/docs/git/blobs') {
        blob += 1;
        return Promise.resolve({
          status: 201,
          headers: {},
          body: { sha: `blob-${String(blob)}` },
        });
      }
      if (input.method === 'POST' && input.path === '/repos/example/docs/git/trees') {
        return Promise.resolve({
          status: 201,
          headers: {},
          body: { sha: 'approved-tree-sha' },
        });
      }
      if (input.method === 'POST' && input.path === '/repos/example/docs/git/commits') {
        return Promise.resolve({
          status: 201,
          headers: {},
          body: { sha: 'approved-commit-sha' },
        });
      }
      if (input.method === 'POST' && input.path === '/repos/example/docs/git/refs') {
        return Promise.resolve({
          status: 201,
          headers: {},
          body: { object: { sha: 'approved-commit-sha' } },
        });
      }
      if (input.method === 'POST' && input.path === '/repos/example/docs/pulls') {
        createdPullRequest = pullRequest(
          input.body as { head: string; base: string; body: string },
        );
        return Promise.resolve({
          status: 201,
          headers: {},
          body: createdPullRequest,
        });
      }
      throw new Error(`UNEXPECTED_GITHUB_REQUEST:${input.method}:${input.path}`);
    },
  );
}

function requireTestRecord(
  value: Record<string, unknown> | null,
  errorCode: string,
): Record<string, unknown> {
  if (value === null) throw new Error(errorCode);
  return value;
}
