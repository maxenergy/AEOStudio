import { createHash, randomUUID } from 'node:crypto';

import { canonicalArtifactJson } from '@aeostudio/application/artifacts';
import type {
  ChannelPackagePayload,
  ChannelPackageRecord,
} from '@aeostudio/domain/channels-publishing';
import type { JobLease } from '@aeostudio/application/jobs-budgets';
import * as WorkerRuntime from '@aeostudio/worker';
import { describe, expect, test, vi } from 'vitest';

describe('Task 10 Publication Worker Adapter boundary', () => {
  test('rejects a queued command at the provider API cutoff before resolving its secret', async () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Fixture',
        'content.html': '<h1>Fixture</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const channelPackage = makePackage(payload);
    const lease = makeLease();
    const attemptId = randomUUID();
    const recordPreflightFailure = vi.fn().mockResolvedValue(true);
    const store = {
      prepare: vi.fn().mockResolvedValue({
        outcome: 'PUBLISH',
        attemptId,
        execution: {
          publicationId: lease.job.aggregateId,
          publicationStatus: 'RUNNING',
          idempotencyKey: 'provider-cutoff-command',
          target: 'fixture://worker/target',
          remoteRef: null,
          channelPackage,
          adapterKey: 'fixture-adapter',
          adapterVersion: '1.0.0',
          adapterProviderApiVersion: '2026-07',
          adapterProviderApiSupportedUntil: '2027-07-16T15:00:00.000Z',
          adapterCapabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
          adapterRequiredScopes: ['fixture.publish'],
          adapterTermsVersion: 'fixture-terms-v1',
          adapterProcessingRegion: 'fixture-region',
          adapterRetentionPolicy: 'fixture-retention',
          adapterTrainingPolicy: 'fixture-training',
          adapterSubprocessors: [],
          adapterRatePolicy: { requestsPerMinute: 10 },
        },
      }),
      runGuardedEffect: guardedEffect(),
      recordPublishApplied: vi.fn(),
      recordPublishAmbiguous: vi.fn(),
      recordReconcileApplied: vi.fn(),
      recordReconcileUnknown: vi.fn(),
      recordRetryableFailure: vi.fn(),
      recordPreflightFailure,
    };
    const validateAuthorization = vi.fn().mockResolvedValue({ outcome: 'VALID' });
    const publish = vi
      .fn()
      .mockResolvedValue({ outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'NOT_USED' });
    const adapter = {
      adapterKey: 'fixture-adapter',
      adapterVersion: '1.0.0',
      describe: () => ({
        adapterKey: 'fixture-adapter',
        adapterVersion: '1.0.0',
        providerApiVersion: '2026-07',
        capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
        requiredScopes: ['fixture.publish'],
        termsVersion: 'fixture-terms-v1',
        processingRegion: 'fixture-region',
        retentionPolicy: 'fixture-retention',
        trainingPolicy: 'fixture-training',
        subprocessors: [],
        ratePolicy: { requestsPerMinute: 10 },
      }),
      validateAuthorization,
      preview: () => ({ packageChecksum: channelPackage.packageChecksum, files: payload.files }),
      publish,
      reconcile: vi.fn(),
    };
    const getSecretValue = vi.fn().mockResolvedValue('fixture-secret');
    const Constructor = (
      WorkerRuntime as unknown as {
        PublicationExecutionHandler: new (
          store: unknown,
          payloads: unknown,
          adapters: unknown,
          authorizationMaterials: unknown,
          secrets: unknown,
          ids: unknown,
          clock: unknown,
        ) => { run(lease: JobLease): Promise<{ outcome: string; errorCode?: string }> };
      }
    ).PublicationExecutionHandler;
    const handler = new Constructor(
      store,
      { readPublicationPackage: vi.fn().mockResolvedValue(payload) },
      { resolve: vi.fn().mockReturnValue(adapter) },
      authorizationMaterialsFor('fixture-secret'),
      { readPublicationSecret: getSecretValue },
      { next: randomUUID },
      { now: () => new Date('2027-07-16T15:00:00.000Z') },
    );

    await expect(handler.run(lease)).resolves.toEqual({
      outcome: 'TERMINAL_FAILURE',
      errorCode: 'ADAPTER_PROVIDER_API_VERSION_EXPIRED',
    });
    expect(recordPreflightFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId,
        errorCode: 'ADAPTER_PROVIDER_API_VERSION_EXPIRED',
      }),
    );
    expect(getSecretValue).not.toHaveBeenCalled();
    expect(validateAuthorization).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  test('rejects runtime descriptor drift before resolving a secret or invoking the Adapter', async () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Fixture',
        'content.html': '<h1>Fixture</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const channelPackage = makePackage(payload);
    const lease = makeLease();
    const recordPreflightFailure = vi.fn().mockResolvedValue(true);
    const store = {
      prepare: vi.fn().mockResolvedValue({
        outcome: 'PUBLISH',
        attemptId: randomUUID(),
        execution: {
          publicationId: lease.job.aggregateId,
          publicationStatus: 'RUNNING',
          idempotencyKey: 'fixture-command',
          target: 'fixture://worker/target',
          remoteRef: null,
          channelPackage,
          adapterKey: 'fixture-adapter',
          adapterVersion: '1.0.0',
          adapterCapabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
          adapterRequiredScopes: ['fixture.publish'],
          adapterTermsVersion: 'fixture-terms-v1',
          adapterProcessingRegion: 'fixture-region',
          adapterRetentionPolicy: 'fixture-retention',
          adapterTrainingPolicy: 'fixture-training',
          adapterSubprocessors: [],
          adapterRatePolicy: { requestsPerMinute: 10 },
        },
      }),
      runGuardedEffect: vi.fn(),
      recordPublishApplied: vi.fn(),
      recordPublishAmbiguous: vi.fn(),
      recordReconcileApplied: vi.fn(),
      recordReconcileUnknown: vi.fn(),
      recordPreflightFailure,
    };
    const validateAuthorization = vi.fn().mockResolvedValue({ outcome: 'VALID' });
    const publish = vi
      .fn()
      .mockResolvedValue({ outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'fixture' });
    const adapter = {
      adapterKey: 'fixture-adapter',
      adapterVersion: '1.0.0',
      describe: () => ({
        adapterKey: 'fixture-adapter',
        adapterVersion: 'drifted-version',
        capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
        requiredScopes: ['fixture.publish'],
        termsVersion: 'fixture-terms-v1',
        processingRegion: 'fixture-region',
        retentionPolicy: 'fixture-retention',
        trainingPolicy: 'fixture-training',
        subprocessors: [],
        ratePolicy: { requestsPerMinute: 10 },
      }),
      validateAuthorization,
      preview: () => ({ packageChecksum: channelPackage.packageChecksum, files: payload.files }),
      publish,
      reconcile: vi.fn(),
    };
    const getSecretValue = vi.fn().mockResolvedValue('fixture-secret');
    const Constructor = (
      WorkerRuntime as unknown as {
        PublicationExecutionHandler: new (
          store: unknown,
          payloads: unknown,
          adapters: unknown,
          authorizationMaterials: unknown,
          secrets: unknown,
          ids: unknown,
          clock: unknown,
        ) => { run(lease: JobLease): Promise<{ outcome: string; errorCode?: string }> };
      }
    ).PublicationExecutionHandler;
    const handler = new Constructor(
      store,
      { readPublicationPackage: vi.fn().mockResolvedValue(payload) },
      { resolve: vi.fn().mockReturnValue(adapter) },
      authorizationMaterialsFor('fixture-secret'),
      { readPublicationSecret: getSecretValue },
      { next: randomUUID },
      { now: () => new Date('2026-07-21T00:00:00.000Z') },
    );

    await expect(handler.run(lease)).resolves.toEqual({
      outcome: 'TERMINAL_FAILURE',
      errorCode: 'ADAPTER_RUNTIME_METADATA_MISMATCH',
    });
    expect(recordPreflightFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'ADAPTER_RUNTIME_METADATA_MISMATCH' }),
    );
    expect(getSecretValue).not.toHaveBeenCalled();
    expect(validateAuthorization).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  test('maps a typed publish transient failure to the bounded retry path with a closed error code', async () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Fixture',
        'content.html': '<h1>Fixture</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const channelPackage = makePackage(payload);
    const lease = makeLease();
    const attemptId = randomUUID();
    const recordRetryableFailure = vi.fn().mockResolvedValue(true);
    const recordPublishAmbiguous = vi.fn().mockResolvedValue(true);
    const runGuardedEffect = vi.fn(async (_input: unknown, effect: () => Promise<unknown>) => ({
      outcome: 'EXECUTED' as const,
      value: await effect(),
    }));
    const store = {
      prepare: vi.fn().mockResolvedValue({
        outcome: 'PUBLISH',
        attemptId,
        execution: {
          publicationId: lease.job.aggregateId,
          publicationStatus: 'RUNNING',
          idempotencyKey: 'fixture-command',
          target: 'fixture://worker/target',
          remoteRef: null,
          channelPackage,
          adapterKey: 'fixture-adapter',
          adapterVersion: '1.0.0',
          adapterCapabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
          adapterRequiredScopes: ['fixture.publish'],
          adapterTermsVersion: 'fixture-terms-v1',
          adapterProcessingRegion: 'fixture-region',
          adapterRetentionPolicy: 'fixture-retention',
          adapterTrainingPolicy: 'fixture-training',
          adapterSubprocessors: [],
          adapterRatePolicy: { requestsPerMinute: 10 },
        },
      }),
      runGuardedEffect,
      recordPublishApplied: vi.fn(),
      recordPublishAmbiguous,
      recordReconcileApplied: vi.fn(),
      recordReconcileUnknown: vi.fn(),
      recordRetryableFailure,
      recordPreflightFailure: vi.fn(),
    };
    const adapter = {
      adapterKey: 'fixture-adapter',
      adapterVersion: '1.0.0',
      describe: () => ({
        adapterKey: 'fixture-adapter',
        adapterVersion: '1.0.0',
        capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
        requiredScopes: ['fixture.publish'],
        termsVersion: 'fixture-terms-v1',
        processingRegion: 'fixture-region',
        retentionPolicy: 'fixture-retention',
        trainingPolicy: 'fixture-training',
        subprocessors: [],
        ratePolicy: { requestsPerMinute: 10 },
      }),
      validateAuthorization: vi.fn().mockResolvedValue({ outcome: 'VALID' }),
      preview: () => ({ packageChecksum: channelPackage.packageChecksum, files: payload.files }),
      publish: vi.fn().mockResolvedValue({
        outcome: 'RETRYABLE_FAILURE',
        errorCode: 'TASK10_SECRET_SENTINEL_DO_NOT_PERSIST',
      }),
      reconcile: vi.fn(),
    };
    const Constructor = (
      WorkerRuntime as unknown as {
        PublicationExecutionHandler: new (
          store: unknown,
          payloads: unknown,
          adapters: unknown,
          authorizationMaterials: unknown,
          secrets: unknown,
          ids: unknown,
          clock: unknown,
        ) => { run(lease: JobLease): Promise<{ outcome: string; errorCode?: string }> };
      }
    ).PublicationExecutionHandler;
    const handler = new Constructor(
      store,
      { readPublicationPackage: vi.fn().mockResolvedValue(payload) },
      { resolve: vi.fn().mockReturnValue(adapter) },
      authorizationMaterialsFor('fixture-secret'),
      { readPublicationSecret: vi.fn().mockResolvedValue('fixture-secret') },
      { next: randomUUID },
      { now: () => new Date('2026-07-21T00:00:00.000Z') },
    );

    await expect(handler.run(lease)).resolves.toEqual({
      outcome: 'RETRYABLE_FAILURE',
      errorCode: 'ADAPTER_PUBLISH_RETRYABLE_FAILURE',
    });
    expect(recordRetryableFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId,
        operation: 'PUBLISH',
        errorCode: 'ADAPTER_PUBLISH_RETRYABLE_FAILURE',
      }),
    );
    expect(recordPublishAmbiguous).not.toHaveBeenCalled();
    expect(runGuardedEffect).toHaveBeenCalledWith(
      {
        lease,
        attemptId,
        operation: 'PUBLISH',
        expectedAuthorizationMaterial: {
          secretReference: 'arn:fixture:secret',
          credentialFingerprint: sha256('fixture-secret'),
        },
        expectedRequiredScopes: ['fixture.publish'],
      },
      expect.any(Function),
    );
  });

  test('persists only a strict unsafe-create compensation intent as a closed code plus safe remote reference', async () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Fixture',
        'content.html': '<h1>Fixture</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const channelPackage = makePackage(payload);
    const lease = makeLease();
    const attemptId = randomUUID();
    const remoteRef = 'https://admin.example.test/content/123';
    const recordPublishAmbiguous = vi.fn().mockResolvedValue(true);
    const store = {
      prepare: vi
        .fn()
        .mockResolvedValueOnce({
          outcome: 'PUBLISH',
          attemptId,
          execution: {
            publicationId: lease.job.aggregateId,
            publicationStatus: 'RUNNING',
            idempotencyKey: 'fixture-command',
            target: 'fixture://worker/target',
            remoteRef: null,
            channelPackage,
            adapterKey: 'fixture-adapter',
            adapterVersion: '1.0.0',
            adapterCapabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
            adapterRequiredScopes: ['fixture.publish'],
            adapterTermsVersion: 'fixture-terms-v1',
            adapterProcessingRegion: 'fixture-region',
            adapterRetentionPolicy: 'fixture-retention',
            adapterTrainingPolicy: 'fixture-training',
            adapterSubprocessors: [],
            adapterRatePolicy: { requestsPerMinute: 10 },
          },
        })
        .mockResolvedValueOnce({ outcome: 'INVALID_STATE' }),
      runGuardedEffect: guardedEffect(),
      recordPublishApplied: vi.fn(),
      recordPublishAmbiguous,
      recordReconcileApplied: vi.fn(),
      recordReconcileUnknown: vi.fn(),
      recordReconcileDefinitelyNotApplied: vi.fn(),
      recordRetryableFailure: vi.fn(),
      recordPreflightFailure: vi.fn(),
    };
    const adapter = {
      adapterKey: 'fixture-adapter',
      adapterVersion: '1.0.0',
      describe: () => ({
        adapterKey: 'fixture-adapter',
        adapterVersion: '1.0.0',
        capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
        requiredScopes: ['fixture.publish'],
        termsVersion: 'fixture-terms-v1',
        processingRegion: 'fixture-region',
        retentionPolicy: 'fixture-retention',
        trainingPolicy: 'fixture-training',
        subprocessors: [],
        ratePolicy: { requestsPerMinute: 10 },
      }),
      validateAuthorization: vi.fn().mockResolvedValue({ outcome: 'VALID' }),
      preview: () => ({ packageChecksum: channelPackage.packageChecksum, files: payload.files }),
      publish: vi.fn().mockResolvedValue({
        outcome: 'AMBIGUOUS',
        errorCode: 'adapter-owned-diagnostic-must-not-persist',
        reconciliationIntent: {
          kind: 'COMPENSATE_UNSAFE_CREATE',
          remoteRef,
        },
      }),
      reconcile: vi.fn(),
    };
    const Constructor = (
      WorkerRuntime as unknown as {
        PublicationExecutionHandler: new (
          store: unknown,
          payloads: unknown,
          adapters: unknown,
          authorizationMaterials: unknown,
          secrets: unknown,
          ids: unknown,
          clock: unknown,
        ) => { run(lease: JobLease): Promise<{ outcome: string; errorCode?: string }> };
      }
    ).PublicationExecutionHandler;
    const handler = new Constructor(
      store,
      { readPublicationPackage: vi.fn().mockResolvedValue(payload) },
      { resolve: vi.fn().mockReturnValue(adapter) },
      authorizationMaterialsFor('fixture-secret'),
      { readPublicationSecret: vi.fn().mockResolvedValue('fixture-secret') },
      { next: randomUUID },
      { now: () => new Date('2026-07-21T00:00:00.000Z') },
    );

    await expect(handler.run(lease)).resolves.toEqual({
      outcome: 'TERMINAL_FAILURE',
      errorCode: 'PUBLICATION_EXECUTION_STATE_INVALID',
    });
    expect(recordPublishAmbiguous).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId,
        errorCode: 'UNSAFE_CREATE_COMPENSATION_PENDING',
        remoteRef,
      }),
    );
    expect(JSON.stringify(recordPublishAmbiguous.mock.calls)).not.toContain(
      'adapter-owned-diagnostic-must-not-persist',
    );
  });

  test('rejects malformed, secret-bearing, and accessor-based compensation intents without reading accessors', async () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Fixture',
        'content.html': '<h1>Fixture</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const channelPackage = makePackage(payload);
    const lease = makeLease();
    let getterCalls = 0;
    const accessorIntent = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(accessorIntent, {
      kind: {
        value: 'COMPENSATE_UNSAFE_CREATE',
        enumerable: true,
      },
      remoteRef: {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return 'https://admin.example.test/content/getter';
        },
      },
    });
    const invalidIntents: unknown[] = [
      {
        kind: 'COMPENSATE_UNSAFE_CREATE',
        remoteRef: 'https://admin.example.test/content/extra',
        extra: true,
      },
      {
        kind: 'COMPENSATE_UNSAFE_CREATE',
        remoteRef: 'https://admin.example.test/fixture-secret',
      },
      {
        kind: 'COMPENSATE_UNSAFE_CREATE',
        remoteRef: 'https://admin.example.test/arn:fixture:secret',
      },
      accessorIntent,
    ];

    for (const reconciliationIntent of invalidIntents) {
      const recordPublishAmbiguous = vi
        .fn<(input: { errorCode: string; remoteRef?: string }) => Promise<boolean>>()
        .mockResolvedValue(true);
      const store = {
        prepare: vi
          .fn()
          .mockResolvedValueOnce({
            outcome: 'PUBLISH',
            attemptId: randomUUID(),
            execution: {
              publicationId: lease.job.aggregateId,
              publicationStatus: 'RUNNING',
              idempotencyKey: 'fixture-command',
              target: 'fixture://worker/target',
              remoteRef: null,
              channelPackage,
              adapterKey: 'fixture-adapter',
              adapterVersion: '1.0.0',
              adapterCapabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
              adapterRequiredScopes: ['fixture.publish'],
              adapterTermsVersion: 'fixture-terms-v1',
              adapterProcessingRegion: 'fixture-region',
              adapterRetentionPolicy: 'fixture-retention',
              adapterTrainingPolicy: 'fixture-training',
              adapterSubprocessors: [],
              adapterRatePolicy: { requestsPerMinute: 10 },
            },
          })
          .mockResolvedValueOnce({ outcome: 'INVALID_STATE' }),
        runGuardedEffect: guardedEffect(),
        recordPublishApplied: vi.fn(),
        recordPublishAmbiguous,
        recordReconcileApplied: vi.fn(),
        recordReconcileUnknown: vi.fn(),
        recordReconcileDefinitelyNotApplied: vi.fn(),
        recordRetryableFailure: vi.fn(),
        recordPreflightFailure: vi.fn(),
      };
      const adapter = {
        adapterKey: 'fixture-adapter',
        adapterVersion: '1.0.0',
        describe: () => ({
          adapterKey: 'fixture-adapter',
          adapterVersion: '1.0.0',
          capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
          requiredScopes: ['fixture.publish'],
          termsVersion: 'fixture-terms-v1',
          processingRegion: 'fixture-region',
          retentionPolicy: 'fixture-retention',
          trainingPolicy: 'fixture-training',
          subprocessors: [],
          ratePolicy: { requestsPerMinute: 10 },
        }),
        validateAuthorization: vi.fn().mockResolvedValue({ outcome: 'VALID' }),
        preview: () => ({ packageChecksum: channelPackage.packageChecksum, files: payload.files }),
        publish: vi.fn().mockResolvedValue({
          outcome: 'AMBIGUOUS',
          reconciliationIntent,
        }),
        reconcile: vi.fn(),
      };
      const Constructor = (
        WorkerRuntime as unknown as {
          PublicationExecutionHandler: new (
            store: unknown,
            payloads: unknown,
            adapters: unknown,
            authorizationMaterials: unknown,
            secrets: unknown,
            ids: unknown,
            clock: unknown,
          ) => { run(lease: JobLease): Promise<{ outcome: string; errorCode?: string }> };
        }
      ).PublicationExecutionHandler;
      const handler = new Constructor(
        store,
        { readPublicationPackage: vi.fn().mockResolvedValue(payload) },
        { resolve: vi.fn().mockReturnValue(adapter) },
        authorizationMaterialsFor('fixture-secret'),
        { readPublicationSecret: vi.fn().mockResolvedValue('fixture-secret') },
        { next: randomUUID },
        { now: () => new Date('2026-07-21T00:00:00.000Z') },
      );

      await handler.run(lease);

      expect(recordPublishAmbiguous).toHaveBeenCalledOnce();
      const recorded = recordPublishAmbiguous.mock.calls[0]?.[0];
      expect(recorded).toMatchObject({ errorCode: 'ADAPTER_PUBLISH_OUTCOME_UNKNOWN' });
      expect(recorded).not.toHaveProperty('remoteRef');
    }
    expect(getterCalls).toBe(0);
  });

  test('passes a recovered unsafe-create compensation intent only to reconcile', async () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Fixture',
        'content.html': '<h1>Fixture</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const channelPackage = makePackage(payload);
    const lease = makeLease();
    const remoteRef = 'https://admin.example.test/content/123';
    const recordReconcileDefinitelyNotApplied = vi.fn().mockResolvedValue(true);
    const store = {
      prepare: vi.fn().mockResolvedValue({
        outcome: 'RECONCILE',
        attemptId: randomUUID(),
        execution: {
          publicationId: lease.job.aggregateId,
          publicationStatus: 'RECONCILING',
          idempotencyKey: 'fixture-command',
          target: 'fixture://worker/target',
          remoteRef: null,
          reconciliationIntent: {
            kind: 'COMPENSATE_UNSAFE_CREATE',
            remoteRef,
          },
          channelPackage,
          adapterKey: 'fixture-adapter',
          adapterVersion: '1.0.0',
          adapterCapabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
          adapterRequiredScopes: ['fixture.publish'],
          adapterTermsVersion: 'fixture-terms-v1',
          adapterProcessingRegion: 'fixture-region',
          adapterRetentionPolicy: 'fixture-retention',
          adapterTrainingPolicy: 'fixture-training',
          adapterSubprocessors: [],
          adapterRatePolicy: { requestsPerMinute: 10 },
        },
      }),
      runGuardedEffect: guardedEffect(),
      recordPublishApplied: vi.fn(),
      recordPublishAmbiguous: vi.fn(),
      recordReconcileApplied: vi.fn(),
      recordReconcileUnknown: vi.fn(),
      recordReconcileDefinitelyNotApplied,
      recordRetryableFailure: vi.fn(),
      recordPreflightFailure: vi.fn(),
    };
    const reconcile = vi.fn().mockResolvedValue({
      outcome: 'DEFINITELY_NOT_APPLIED',
      errorCode: 'fixture-complete',
    });
    const adapter = {
      adapterKey: 'fixture-adapter',
      adapterVersion: '1.0.0',
      describe: () => ({
        adapterKey: 'fixture-adapter',
        adapterVersion: '1.0.0',
        capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
        requiredScopes: ['fixture.publish'],
        termsVersion: 'fixture-terms-v1',
        processingRegion: 'fixture-region',
        retentionPolicy: 'fixture-retention',
        trainingPolicy: 'fixture-training',
        subprocessors: [],
        ratePolicy: { requestsPerMinute: 10 },
      }),
      validateAuthorization: vi.fn().mockResolvedValue({ outcome: 'VALID' }),
      preview: () => ({ packageChecksum: channelPackage.packageChecksum, files: payload.files }),
      publish: vi.fn(),
      reconcile,
    };
    const Constructor = (
      WorkerRuntime as unknown as {
        PublicationExecutionHandler: new (
          store: unknown,
          payloads: unknown,
          adapters: unknown,
          authorizationMaterials: unknown,
          secrets: unknown,
          ids: unknown,
          clock: unknown,
        ) => { run(lease: JobLease): Promise<{ outcome: string; errorCode?: string }> };
      }
    ).PublicationExecutionHandler;
    const handler = new Constructor(
      store,
      { readPublicationPackage: vi.fn().mockResolvedValue(payload) },
      { resolve: vi.fn().mockReturnValue(adapter) },
      authorizationMaterialsFor('fixture-secret'),
      { readPublicationSecret: vi.fn().mockResolvedValue('fixture-secret') },
      { next: randomUUID },
      { now: () => new Date('2026-07-21T00:00:00.000Z') },
    );

    await expect(handler.run(lease)).resolves.toEqual({
      outcome: 'TERMINAL_FAILURE',
      errorCode: 'ADAPTER_RECONCILE_DEFINITELY_NOT_APPLIED',
    });
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        reconciliationIntent: {
          kind: 'COMPENSATE_UNSAFE_CREATE',
          remoteRef,
        },
      }),
    );
    expect(recordReconcileDefinitelyNotApplied).toHaveBeenCalledOnce();
  });
});

function makePackage(payload: ChannelPackagePayload): ChannelPackageRecord {
  const manifest = {
    schemaVersion: '1.0.0',
    files: Object.entries(payload.files).map(([path, content]) => ({
      path,
      mediaType:
        path === 'content.md'
          ? 'text/markdown'
          : path === 'content.html'
            ? 'text/html'
            : 'application/ld+json',
      sha256: sha256(content),
      byteLength: Buffer.byteLength(content, 'utf8'),
    })),
    assetRefs: [],
    claimSourceMap: [],
  };
  const channel = {
    definitionId: '00000000-0000-7000-8000-000000002001',
    channelKey: 'fixture-worker-channel',
  };
  const transformer = { key: 'generic-web-package', version: '1.0.0' };
  const artifact = {
    artifactId: '00000000-0000-7000-8000-000000002002',
    artifactRevisionId: '00000000-0000-7000-8000-000000002003',
    revision: 1,
    contentHash: 'a'.repeat(64),
    type: 'DEFINITION_PRODUCT' as const,
    locale: 'en-SG',
    market: 'SG',
    methodPolicyVersion: 'fixture-v1',
  };
  const packageSchemaVersion = '1.0.0';
  const packageChecksum = sha256(
    canonicalArtifactJson({
      packageSchemaVersion,
      channel,
      transformer,
      artifact,
      manifest,
      payload,
    }),
  );
  return {
    id: '00000000-0000-7000-8000-000000002004',
    tenantId: '00000000-0000-7000-8000-000000002005',
    workspaceId: '00000000-0000-7000-8000-000000002006',
    packageRevision: 1,
    channel,
    transformer,
    packageSchemaVersion,
    artifact,
    manifest,
    packageChecksum,
    payloadObjectRef: 'memory://fixture-worker-package',
    createdByUserId: '00000000-0000-7000-8000-000000002007',
    createdAt: '2026-07-21T00:00:00.000Z',
  };
}

function makeLease(): JobLease {
  return {
    job: {
      id: '00000000-0000-7000-8000-000000002008',
      tenantId: '00000000-0000-7000-8000-000000002005',
      workspaceId: '00000000-0000-7000-8000-000000002006',
      jobType: 'PUBLICATION',
      aggregateId: '00000000-0000-7000-8000-000000002009',
      status: 'RUNNING',
      progress: 10,
      attempt: 1,
      maxAttempts: 3,
      budgetWarning: false,
      estimatedUnits: 5,
      heartbeatAt: '2026-07-21T00:00:00.000Z',
      result: null,
      errorCode: null,
    },
    leaseToken: 'fixture-lease',
    messageId: 'fixture-message',
  };
}

function authorizationMaterialsFor(secretValue: string) {
  return {
    readForPublication: vi.fn().mockResolvedValue({
      secretReference: 'arn:fixture:secret',
      credentialFingerprint: sha256(secretValue),
    }),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function guardedEffect() {
  return async <T>(_input: unknown, effect: () => Promise<T>) => ({
    outcome: 'EXECUTED' as const,
    value: await effect(),
  });
}
