import * as AdapterRuntime from '@aeostudio/adapters';
import {
  encodeWordPressDraftTarget,
  encodeWordPressSiteAuthorizationTarget,
} from '@aeostudio/contracts/channels';
import type {
  ChannelPackagePayload,
  ChannelPackageRecord,
  PublicationRemoteState,
} from '@aeostudio/domain/channels-publishing';
import { describe, expect, test } from 'vitest';

interface RuntimeCommand {
  publicationId: string;
  idempotencyKey: string;
  target: string;
  channelPackage: ChannelPackageRecord;
  payload: ChannelPackagePayload;
  secretValue: string;
}

interface RuntimeAdapter {
  authorizationTargetFor(target: string): string;
  requiredScopesFor(input: { target: string; channelPackage: ChannelPackageRecord }): string[];
  validateAuthorization(command: RuntimeCommand): Promise<{ outcome: 'VALID' | 'INVALID' }>;
  publish(
    command: RuntimeCommand,
  ): Promise<
    | { outcome: 'APPLIED'; remoteRef: string; remoteState: PublicationRemoteState }
    | { outcome: 'DEFINITELY_NOT_APPLIED' | 'AMBIGUOUS'; errorCode: string }
  >;
  reconcile(
    command: RuntimeCommand,
  ): Promise<
    | { outcome: 'APPLIED'; remoteRef: string; remoteState: PublicationRemoteState }
    | { outcome: 'DEFINITELY_NOT_APPLIED' | 'AMBIGUOUS'; errorCode: string }
  >;
}

type RuntimeAdapterConstructor = new (options: {
  adapterKey: string;
  adapterVersion: string;
  descriptor: {
    capabilities: string[];
    requiredScopes: string[];
    termsVersion: string;
    processingRegion: string;
    retentionPolicy: string;
    trainingPolicy: string;
    subprocessors: Array<Record<string, unknown>>;
    ratePolicy: Record<string, unknown>;
  };
  draftAdapter: InstanceType<
    NonNullable<
      (typeof AdapterRuntime & {
        WordPressWooCommerceDraftPublicationAdapter?: new (...args: never[]) => unknown;
      })['WordPressWooCommerceDraftPublicationAdapter']
    >
  >;
}) => RuntimeAdapter;

const packagePayload: ChannelPackagePayload = {
  files: {
    'content.md': '# Approved guide\n\nApproved summary.',
    'content.html': '<article><h1>Approved guide</h1><p>Approved summary.</p></article>',
    'structured-data.json': JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'CreativeWork',
      headline: 'Approved guide',
      abstract: 'Approved summary.',
    }),
  },
};

const channelPackage: ChannelPackageRecord = {
  id: '00000000-0000-7000-8000-000000001221',
  tenantId: '00000000-0000-7000-8000-000000001222',
  workspaceId: '00000000-0000-7000-8000-000000001223',
  packageRevision: 1,
  channel: {
    definitionId: '00000000-0000-7000-8000-000000001224',
    channelKey: 'wordpress-woocommerce-draft',
  },
  transformer: { key: 'generic-web-package', version: '1.0.0' },
  packageSchemaVersion: '1.0.0',
  artifact: {
    artifactId: '00000000-0000-7000-8000-000000001225',
    artifactRevisionId: '00000000-0000-7000-8000-000000001226',
    revision: 3,
    contentHash: 'a'.repeat(64),
    type: 'DEFINITION_PRODUCT',
    locale: 'en-US',
    market: 'US',
    methodPolicyVersion: 'fixture-v1',
  },
  manifest: { schemaVersion: '1.0.0', files: [], assetRefs: [], claimSourceMap: [] },
  packageChecksum: 'b'.repeat(64),
  payloadObjectRef: 'memory://task-12-runtime-package',
  createdByUserId: '00000000-0000-7000-8000-000000001227',
  createdAt: '2026-07-21T00:00:00.000Z',
};

describe('Task 12 WordPress runtime Adapter bridge', () => {
  test('maps an exact generic package to a durable non-live draft state without leaking the secret', async () => {
    const runtimeConstructor = (
      AdapterRuntime as unknown as {
        WordPressWooCommerceDraftRuntimeAdapter?: RuntimeAdapterConstructor;
      }
    ).WordPressWooCommerceDraftRuntimeAdapter;
    const serverConstructor = AdapterRuntime.VersionedFakeWordPressServer;
    const draftAdapterConstructor = AdapterRuntime.WordPressWooCommerceDraftPublicationAdapter;
    expect(runtimeConstructor, 'WordPress runtime bridge missing').toBeTypeOf('function');
    if (runtimeConstructor === undefined) throw new Error('WordPress runtime bridge missing');

    const secretSentinel = 'wordpress-runtime-secret-must-never-escape';
    const logs: string[] = [];
    const server = new serverConstructor({
      apiVersion: 'wp/v2',
      siteOrigin: 'https://cms.example.test',
      authorization: {
        mechanism: 'APPLICATION_PASSWORD',
        scopes: ['pages:write'],
        credential: secretSentinel,
      },
      log: (entry) => logs.push(entry),
    });
    const draftAdapter = new draftAdapterConstructor({
      adapterKey: 'wordpress-woocommerce-draft',
      adapterVersion: '1.0.0',
      providerApiVersion: 'wp/v2',
      server,
      requiredScopes: [],
      allowedSiteOrigins: ['https://cms.example.test'],
    });
    const adapter = new runtimeConstructor({
      adapterKey: 'wordpress-woocommerce-draft',
      adapterVersion: '1.0.0',
      descriptor: {
        capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
        requiredScopes: ['media:write', 'pages:write', 'posts:write', 'woocommerce:products:write'],
        termsVersion: 'wordpress-test-terms-v1',
        processingRegion: 'in-process-test-runtime',
        retentionPolicy: 'No credential or package retention.',
        trainingPolicy: 'No training.',
        subprocessors: [],
        ratePolicy: { mode: 'deterministic-test-only' },
      },
      draftAdapter,
    });
    const target = encodeWordPressDraftTarget({
      schemaVersion: 'wordpress-draft-target.v1',
      siteUrl: 'https://cms.example.test',
      authMode: 'APPLICATION_PASSWORD',
      destination: { kind: 'PAGE', operation: 'CREATE', slug: 'approved-runtime-guide' },
    });
    const command: RuntimeCommand = {
      publicationId: '00000000-0000-7000-8000-000000001228',
      idempotencyKey: 'local-runtime-attempt-1',
      target,
      channelPackage,
      payload: packagePayload,
      secretValue: secretSentinel,
    };
    expect(adapter.authorizationTargetFor(target)).toBe(
      encodeWordPressSiteAuthorizationTarget({
        schemaVersion: 'wordpress-site-auth.v1',
        siteUrl: 'https://cms.example.test',
        authMode: 'APPLICATION_PASSWORD',
      }),
    );
    expect(adapter.requiredScopesFor({ target, channelPackage })).toEqual(['pages:write']);
    await expect(adapter.validateAuthorization(command)).resolves.toEqual({ outcome: 'VALID' });

    const result = await adapter.publish(command);
    expect(result).toEqual({
      outcome: 'APPLIED',
      remoteRef: 'https://cms.example.test/wp-admin/post.php?post=1&action=edit',
      remoteState: {
        status: 'DRAFT',
        number: 1,
        isProductionLive: false,
        rollbackHandle: {
          operation: 'TRASH_DRAFT',
          siteOrigin: 'https://cms.example.test',
          resource: '/wp/v2/pages',
          remoteId: 1,
        },
      },
    });
    const retry = await adapter.publish({
      ...command,
      publicationId: '00000000-0000-7000-8000-000000001229',
      idempotencyKey: 'fresh-local-runtime-attempt',
    });
    expect(retry).toEqual(result);
    expect(server.snapshot().objects).toHaveLength(1);
    expect(JSON.stringify({ result, retry, snapshot: server.snapshot(), logs })).not.toContain(
      secretSentinel,
    );
  });
});
