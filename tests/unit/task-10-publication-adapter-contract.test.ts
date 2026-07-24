import * as AdapterRuntime from '@aeostudio/adapters';
import * as ChannelApplication from '@aeostudio/application/channels-publishing';
import type { PublicationAdapterPreviewCommand } from '@aeostudio/application/channels-publishing';
import type {
  ChannelPackagePayload,
  ChannelPackageRecord,
} from '@aeostudio/domain/channels-publishing';
import { describe, expect, test } from 'vitest';

const packageRecord: ChannelPackageRecord = {
  id: '00000000-0000-7000-8000-000000001101',
  tenantId: '00000000-0000-7000-8000-000000001102',
  workspaceId: '00000000-0000-7000-8000-000000001103',
  packageRevision: 1,
  channel: {
    definitionId: '00000000-0000-7000-8000-000000001104',
    channelKey: 'fixture-contract-channel',
  },
  transformer: { key: 'generic-web-package', version: '1.0.0' },
  packageSchemaVersion: '1.0.0',
  artifact: {
    artifactId: '00000000-0000-7000-8000-000000001105',
    artifactRevisionId: '00000000-0000-7000-8000-000000001106',
    revision: 1,
    contentHash: 'a'.repeat(64),
    type: 'DEFINITION_PRODUCT',
    locale: 'en-SG',
    market: 'SG',
    methodPolicyVersion: 'fixture-v1',
  },
  manifest: {
    schemaVersion: '1.0.0',
    files: [
      {
        path: 'content.md',
        mediaType: 'text/markdown',
        sha256: 'b'.repeat(64),
        byteLength: 7,
      },
    ],
    assetRefs: [],
    claimSourceMap: [],
  },
  packageChecksum: 'c'.repeat(64),
  payloadObjectRef: 'memory://fixture-contract-package',
  createdByUserId: '00000000-0000-7000-8000-000000001107',
  createdAt: '2026-07-21T00:00:00.000Z',
};

const packagePayload: ChannelPackagePayload = {
  files: {
    'content.md': '# Hello',
    'content.html': '<h1>Hello</h1>',
    'structured-data.json': '{"@context":"https://schema.org"}',
  },
};

type AdapterCommand = {
  publicationId: string;
  idempotencyKey: string;
  target: string;
  channelPackage: ChannelPackageRecord;
  payload: ChannelPackagePayload;
  secretValue: string;
};

type FakeAdapterConstructor = new (options: {
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
  authorizationValidator(command: AdapterCommand): boolean;
}) => {
  describe(): {
    adapterKey: string;
    adapterVersion: string;
    capabilities: string[];
  };
  validateAuthorization(
    command: AdapterCommand,
  ): Promise<{ outcome: 'VALID' } | { outcome: 'INVALID' | 'UNKNOWN' }>;
  preview(command: PublicationAdapterPreviewCommand): {
    packageChecksum: string;
    files: ChannelPackagePayload['files'];
  };
  publish(command: AdapterCommand): Promise<{ outcome: 'AMBIGUOUS'; errorCode: string }>;
  reconcile(command: AdapterCommand): Promise<{ outcome: 'APPLIED'; remoteRef: string }>;
  rollback(
    command: AdapterCommand & { remoteRef: string },
  ): Promise<{ outcome: 'ROLLED_BACK'; remoteRef: string }>;
  snapshot(): {
    effectCount: number;
    publishCalls: number;
    reconcileCalls: number;
    rollbackCalls: number;
  };
};

describe('Task 10 generic Publication Adapter contract', () => {
  test('the explicit test/dev fake validates authorization and implements idempotent preview, publish, reconcile, and rollback', async () => {
    const constructor = (
      AdapterRuntime as unknown as {
        FakeAmbiguousPublicationAdapter?: FakeAdapterConstructor;
      }
    ).FakeAmbiguousPublicationAdapter;
    expect(
      constructor,
      'expected fake Adapter contract with validateAuthorization and typed rollback',
    ).toBeTypeOf('function');
    if (constructor === undefined) throw new Error('FAKE_PUBLICATION_ADAPTER_UNAVAILABLE');

    const adapter = new constructor({
      adapterKey: 'fixture-contract-adapter',
      adapterVersion: '1.0.0',
      descriptor: {
        capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK'],
        requiredScopes: ['fixture.publish'],
        termsVersion: 'fixture-terms-v1',
        processingRegion: 'fixture-region',
        retentionPolicy: 'fixture-retention',
        trainingPolicy: 'fixture-training',
        subprocessors: [],
        ratePolicy: { requestsPerMinute: 10 },
      },
      authorizationValidator(command) {
        return command.secretValue === 'fixture-valid-secret';
      },
    });
    const command: AdapterCommand = {
      publicationId: '00000000-0000-7000-8000-000000001108',
      idempotencyKey: '00000000-0000-7000-8000-000000001108',
      target: 'fixture://contract/target',
      channelPackage: packageRecord,
      payload: packagePayload,
      secretValue: 'fixture-valid-secret',
    };

    expect(adapter.describe()).toEqual({
      adapterKey: 'fixture-contract-adapter',
      adapterVersion: '1.0.0',
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK'],
      requiredScopes: ['fixture.publish'],
      termsVersion: 'fixture-terms-v1',
      processingRegion: 'fixture-region',
      retentionPolicy: 'fixture-retention',
      trainingPolicy: 'fixture-training',
      subprocessors: [],
      ratePolicy: { requestsPerMinute: 10 },
    });
    expect(await adapter.validateAuthorization(command)).toEqual({ outcome: 'VALID' });
    expect(
      await adapter.validateAuthorization({ ...command, secretValue: 'fixture-invalid-secret' }),
    ).toEqual({ outcome: 'INVALID' });
    const previewCommand: PublicationAdapterPreviewCommand = {
      target: command.target,
      channelPackage: command.channelPackage,
      payload: command.payload,
    };
    expect(previewCommand).not.toHaveProperty('secretValue');
    expect(previewCommand).not.toHaveProperty('idempotencyKey');
    const preview = adapter.preview(previewCommand);
    expect(preview).toEqual({
      packageChecksum: packageRecord.packageChecksum,
      files: packagePayload.files,
    });
    expect(preview.files).not.toBe(packagePayload.files);

    expect(await adapter.publish(command)).toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'FAKE_RESPONSE_LOST_AFTER_EFFECT',
    });
    expect(await adapter.publish(command)).toEqual({
      outcome: 'AMBIGUOUS',
      errorCode: 'FAKE_RESPONSE_LOST_AFTER_EFFECT',
    });
    const reconciled = await adapter.reconcile(command);
    expect(reconciled).toEqual({
      outcome: 'APPLIED',
      remoteRef: `fake://remote/${command.publicationId}`,
    });
    expect(await adapter.rollback({ ...command, remoteRef: reconciled.remoteRef })).toEqual({
      outcome: 'ROLLED_BACK',
      remoteRef: reconciled.remoteRef,
    });
    expect(adapter.snapshot()).toEqual({
      effectCount: 1,
      publishCalls: 2,
      reconcileCalls: 1,
      rollbackCalls: 1,
    });
    expect(JSON.stringify(adapter.snapshot())).not.toContain(command.secretValue);
  });

  test('runtime metadata validation fails closed when required methods or Registry identity differ', () => {
    const validate = (
      ChannelApplication as unknown as {
        validatePublicationAdapterRuntime?: (
          adapter: unknown,
          expected: {
            adapterKey: string;
            adapterVersion: string;
            capabilities: string[];
          },
        ) => string | null;
      }
    ).validatePublicationAdapterRuntime;
    expect(validate, 'expected a fail-closed Adapter runtime metadata validator').toBeTypeOf(
      'function',
    );
    if (validate === undefined) throw new Error('ADAPTER_RUNTIME_VALIDATOR_UNAVAILABLE');

    const expected = {
      adapterKey: 'fixture-contract-adapter',
      adapterVersion: '1.0.0',
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'DRAFT'],
      requiredScopes: ['content:write'],
      termsVersion: 'fixture-terms-v1',
      processingRegion: 'fixture-region',
      retentionPolicy: 'fixture-retention',
      trainingPolicy: 'fixture-training',
      subprocessors: [{ name: 'fixture-subprocessor', purpose: 'delivery' }],
      ratePolicy: { requestsPerMinute: 10 },
    };
    const valid = {
      adapterKey: expected.adapterKey,
      adapterVersion: expected.adapterVersion,
      describe: () => ({ ...expected, capabilities: [...expected.capabilities] }),
      validateAuthorization: () => Promise.resolve({ outcome: 'VALID' as const }),
      preview: () => ({ packageChecksum: 'c'.repeat(64), files: packagePayload.files }),
      publish: () =>
        Promise.resolve({ outcome: 'DEFINITELY_NOT_APPLIED' as const, errorCode: 'fixture' }),
      reconcile: () =>
        Promise.resolve({
          outcome: 'DEFINITELY_NOT_APPLIED' as const,
          errorCode: 'fixture',
        }),
      rollback: () =>
        Promise.resolve({ outcome: 'ROLLED_BACK' as const, remoteRef: 'fixture://remote' }),
    };

    expect(validate(valid, expected)).toBeNull();
    expect(validate({ ...valid, preview: undefined }, expected)).toBe(
      'ADAPTER_RUNTIME_METADATA_MISMATCH',
    );
    expect(
      validate(
        {
          ...valid,
          describe: () => ({ ...expected, adapterVersion: '2.0.0' }),
        },
        expected,
      ),
    ).toBe('ADAPTER_RUNTIME_METADATA_MISMATCH');
    expect(
      validate(
        {
          ...valid,
          describe: () => ({ ...expected, capabilities: ['PREVIEW', 'PUBLISH'] }),
        },
        expected,
      ),
    ).toBe('ADAPTER_RUNTIME_METADATA_MISMATCH');
    expect(
      validate(
        {
          ...valid,
          describe: () => ({ ...expected, retentionPolicy: 'drifted-retention' }),
        },
        expected,
      ),
    ).toBe('ADAPTER_RUNTIME_METADATA_MISMATCH');
  });
});
