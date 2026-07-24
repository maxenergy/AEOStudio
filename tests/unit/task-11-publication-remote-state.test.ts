import { createHash, randomUUID } from 'node:crypto';

import { canonicalArtifactJson } from '@aeostudio/application/artifacts';
import type { JobLease } from '@aeostudio/application/jobs-budgets';
import { PublicationRemoteStateSchema } from '@aeostudio/contracts/channels';
import type {
  ChannelPackagePayload,
  ChannelPackageRecord,
} from '@aeostudio/domain/channels-publishing';
import * as WorkerRuntime from '@aeostudio/worker';
import { describe, expect, test, vi } from 'vitest';

describe('Task 11 generic remote lifecycle persistence', () => {
  test('records an opened pull request as a non-live remote effect, never as PUBLISHED', async () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Reviewed content',
        'content.html': '<h1>Reviewed content</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const channelPackage = makePackage(payload);
    const lease = makeLease();
    const remoteState = {
      status: 'PR_OPENED',
      number: 41,
      isProductionLive: false,
      rollbackHandle: {
        operation: 'CLOSE_PULL_REQUEST',
        repository: 'tenant-owned/site-content',
        pullRequestNumber: 41,
      },
    };
    const recordPublishApplied = vi.fn().mockResolvedValue(true);
    const store = {
      prepare: vi.fn().mockResolvedValue({
        outcome: 'PUBLISH',
        attemptId: randomUUID(),
        execution: {
          publicationId: lease.job.aggregateId,
          publicationStatus: 'RUNNING',
          idempotencyKey: 'task11-reviewed-intent',
          target: 'git-pr://installation-4101/tenant-owned/site-content',
          remoteRef: null,
          channelPackage,
          adapterKey: 'git-pull-request',
          adapterVersion: '1.0.0',
          adapterCapabilities: [
            'PREVIEW',
            'PUBLISH',
            'RECONCILE',
            'ROLLBACK',
            'PULL_REQUEST_STATUS',
          ],
          adapterRequiredScopes: ['contents:write', 'pull_requests:write'],
          adapterTermsVersion: 'git-test-terms-v1',
          adapterProcessingRegion: 'in-process-test-runtime',
          adapterRetentionPolicy: 'No retention.',
          adapterTrainingPolicy: 'No training.',
          adapterSubprocessors: [],
          adapterRatePolicy: { mode: 'deterministic-test-only' },
        },
      }),
      runGuardedEffect: guardedEffect(),
      recordPublishApplied,
      recordPublishAmbiguous: vi.fn(),
      recordReconcileApplied: vi.fn(),
      recordReconcileUnknown: vi.fn(),
      recordReconcileDefinitelyNotApplied: vi.fn(),
      recordRetryableFailure: vi.fn(),
      recordPreflightFailure: vi.fn(),
    };
    const adapter = {
      adapterKey: 'git-pull-request',
      adapterVersion: '1.0.0',
      describe: () => ({
        adapterKey: 'git-pull-request',
        adapterVersion: '1.0.0',
        capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'PULL_REQUEST_STATUS'],
        requiredScopes: ['contents:write', 'pull_requests:write'],
        termsVersion: 'git-test-terms-v1',
        processingRegion: 'in-process-test-runtime',
        retentionPolicy: 'No retention.',
        trainingPolicy: 'No training.',
        subprocessors: [],
        ratePolicy: { mode: 'deterministic-test-only' },
      }),
      validateAuthorization: vi.fn().mockResolvedValue({ outcome: 'VALID' }),
      preview: () => ({ packageChecksum: channelPackage.packageChecksum, files: payload.files }),
      publish: vi.fn().mockResolvedValue({
        outcome: 'APPLIED',
        remoteRef: 'https://git.example.test/tenant-owned/site-content/pull/41',
        remoteState,
      }),
      reconcile: vi.fn(),
      rollback: vi.fn(),
      refreshRemoteStatus: vi.fn(),
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
        ) => {
          run(lease: JobLease): Promise<{
            outcome: string;
            publicationStatus?: string;
            remoteState?: unknown;
          }>;
        };
      }
    ).PublicationExecutionHandler;
    const handler = new Constructor(
      store,
      { readPublicationPackage: vi.fn().mockResolvedValue(payload) },
      { resolve: vi.fn().mockReturnValue(adapter) },
      authorizationMaterialsFor('task11-secret-value'),
      { readPublicationSecret: vi.fn().mockResolvedValue('task11-secret-value') },
      { next: randomUUID },
      { now: () => new Date('2026-07-21T00:00:00.000Z') },
    );

    const result = await handler.run(lease);

    expect(result).toMatchObject({
      outcome: 'SUCCEEDED',
      publicationStatus: 'REMOTE_APPLIED',
      remoteState,
    });
    expect(result.publicationStatus).not.toBe('PUBLISHED');
    expect(recordPublishApplied).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationStatus: 'REMOTE_APPLIED',
        remoteState,
      }),
    );
  });

  test('replays a persisted non-live remote effect without invoking an Adapter again', async () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Reviewed content',
        'content.html': '<h1>Reviewed content</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const channelPackage = makePackage(payload);
    const lease = makeLease();
    const remoteState = {
      status: 'PR_OPENED',
      number: 41,
      isProductionLive: false,
      rollbackHandle: {
        operation: 'CLOSE_PULL_REQUEST',
        repository: 'tenant-owned/site-content',
        pullRequestNumber: 41,
      },
    };
    const getPayload = vi.fn();
    const resolveAdapter = vi.fn();
    const getSecretValue = vi.fn();
    const store = {
      prepare: vi.fn().mockResolvedValue({
        outcome: 'REMOTE_APPLIED',
        execution: {
          ...makeExecution(lease, channelPackage),
          publicationStatus: 'REMOTE_APPLIED',
          remoteRef: 'https://git.example.test/tenant-owned/site-content/pull/41',
          remoteState,
        },
      }),
    };
    const handler = new (publicationExecutionHandlerConstructor())(
      store,
      { get: getPayload },
      { resolve: resolveAdapter },
      authorizationMaterialsFor('task11-secret-value'),
      { readPublicationSecret: getSecretValue },
      { next: randomUUID },
      { now: () => new Date('2026-07-21T00:00:00.000Z') },
    );

    await expect(handler.run(lease)).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      publicationStatus: 'REMOTE_APPLIED',
      remoteState,
    });
    expect(getPayload).not.toHaveBeenCalled();
    expect(resolveAdapter).not.toHaveBeenCalled();
    expect(getSecretValue).not.toHaveBeenCalled();
  });

  test('treats an applied result containing secret-shaped remote state as ambiguous', async () => {
    const secretSentinel = 'TASK11_REMOTE_STATE_SECRET_DO_NOT_PERSIST';
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Reviewed content',
        'content.html': '<h1>Reviewed content</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const channelPackage = makePackage(payload);
    const lease = makeLease();
    const recordPublishApplied = vi.fn();
    const recordPublishAmbiguous = vi.fn().mockResolvedValue(true);
    const recordReconcileUnknown = vi.fn().mockResolvedValue(true);
    const store = {
      prepare: vi
        .fn()
        .mockResolvedValueOnce({
          outcome: 'PUBLISH',
          attemptId: randomUUID(),
          execution: makeExecution(lease, channelPackage),
        })
        .mockResolvedValueOnce({
          outcome: 'RECONCILE',
          attemptId: randomUUID(),
          execution: makeExecution(lease, channelPackage),
        }),
      runGuardedEffect: guardedEffect(),
      recordPublishApplied,
      recordPublishAmbiguous,
      recordReconcileApplied: vi.fn(),
      recordReconcileUnknown,
      recordReconcileDefinitelyNotApplied: vi.fn(),
      recordRetryableFailure: vi.fn(),
      recordPreflightFailure: vi.fn(),
    };
    const adapter = makeAdapter(channelPackage, payload, {
      publish: vi.fn().mockResolvedValue({
        outcome: 'APPLIED',
        remoteRef: 'https://git.example.test/tenant-owned/site-content/pull/41',
        remoteState: {
          status: 'PR_OPENED',
          number: 41,
          isProductionLive: false,
          rollbackHandle: {
            operation: 'CLOSE_PULL_REQUEST',
            repository: secretSentinel,
            pullRequestNumber: 41,
          },
        },
      }),
      reconcile: vi.fn().mockResolvedValue({ outcome: 'UNKNOWN', errorCode: secretSentinel }),
    });
    const handler = new (publicationExecutionHandlerConstructor())(
      store,
      { readPublicationPackage: vi.fn().mockResolvedValue(payload) },
      { resolve: vi.fn().mockReturnValue(adapter) },
      authorizationMaterialsFor(secretSentinel),
      { readPublicationSecret: vi.fn().mockResolvedValue(secretSentinel) },
      { next: randomUUID },
      { now: () => new Date('2026-07-21T00:00:00.000Z') },
    );

    await expect(handler.run(lease)).resolves.toEqual({
      outcome: 'TERMINAL_FAILURE',
      errorCode: 'ADAPTER_RECONCILE_OUTCOME_UNKNOWN',
    });
    expect(recordPublishApplied).not.toHaveBeenCalled();
    expect(recordPublishAmbiguous).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'ADAPTER_APPLIED_REMOTE_STATE_INVALID' }),
    );
    expect(JSON.stringify(recordPublishAmbiguous.mock.calls)).not.toContain(secretSentinel);
    expect(JSON.stringify(recordReconcileUnknown.mock.calls)).not.toContain(secretSentinel);
  });

  test('rejects malformed remote state instead of persisting an untrusted object', async () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Reviewed content',
        'content.html': '<h1>Reviewed content</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const channelPackage = makePackage(payload);
    const lease = makeLease();
    const recordPublishApplied = vi.fn();
    const recordPublishAmbiguous = vi.fn().mockResolvedValue(true);
    const store = {
      prepare: vi
        .fn()
        .mockResolvedValueOnce({
          outcome: 'PUBLISH',
          attemptId: randomUUID(),
          execution: makeExecution(lease, channelPackage),
        })
        .mockResolvedValueOnce({
          outcome: 'RECONCILE',
          attemptId: randomUUID(),
          execution: makeExecution(lease, channelPackage),
        }),
      runGuardedEffect: guardedEffect(),
      recordPublishApplied,
      recordPublishAmbiguous,
      recordReconcileApplied: vi.fn(),
      recordReconcileUnknown: vi.fn().mockResolvedValue(true),
      recordReconcileDefinitelyNotApplied: vi.fn(),
      recordRetryableFailure: vi.fn(),
      recordPreflightFailure: vi.fn(),
    };
    const adapter = makeAdapter(channelPackage, payload, {
      publish: vi.fn().mockResolvedValue({
        outcome: 'APPLIED',
        remoteRef: 'https://git.example.test/tenant-owned/site-content/pull/41',
        remoteState: {
          status: 'pr_opened',
          number: -1,
          isProductionLive: false,
          rollbackHandle: { operation: { nested: true } },
          unexpected: 'must fail closed',
        },
      }),
      reconcile: vi.fn().mockResolvedValue({ outcome: 'UNKNOWN', errorCode: 'fixture' }),
    });
    const handler = new (publicationExecutionHandlerConstructor())(
      store,
      { readPublicationPackage: vi.fn().mockResolvedValue(payload) },
      { resolve: vi.fn().mockReturnValue(adapter) },
      authorizationMaterialsFor('task11-secret-value'),
      { readPublicationSecret: vi.fn().mockResolvedValue('task11-secret-value') },
      { next: randomUUID },
      { now: () => new Date('2026-07-21T00:00:00.000Z') },
    );

    await expect(handler.run(lease)).resolves.toEqual({
      outcome: 'TERMINAL_FAILURE',
      errorCode: 'ADAPTER_RECONCILE_OUTCOME_UNKNOWN',
    });
    expect(recordPublishApplied).not.toHaveBeenCalled();
    expect(recordPublishAmbiguous).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'ADAPTER_APPLIED_REMOTE_STATE_INVALID' }),
    );
  });

  test('maps a reconciled non-live remote effect through the same durable state contract', async () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Reviewed content',
        'content.html': '<h1>Reviewed content</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const channelPackage = makePackage(payload);
    const lease = makeLease();
    const remoteState = {
      status: 'PR_OPENED',
      number: 41,
      isProductionLive: false,
      rollbackHandle: {
        operation: 'CLOSE_PULL_REQUEST',
        repository: 'tenant-owned/site-content',
        pullRequestNumber: 41,
      },
    };
    const recordReconcileApplied = vi.fn().mockResolvedValue(true);
    const store = {
      prepare: vi.fn().mockResolvedValue({
        outcome: 'RECONCILE',
        attemptId: randomUUID(),
        execution: makeExecution(lease, channelPackage),
      }),
      runGuardedEffect: guardedEffect(),
      recordPublishApplied: vi.fn(),
      recordPublishAmbiguous: vi.fn(),
      recordReconcileApplied,
      recordReconcileUnknown: vi.fn(),
      recordReconcileDefinitelyNotApplied: vi.fn(),
      recordRetryableFailure: vi.fn(),
      recordPreflightFailure: vi.fn(),
    };
    const adapter = makeAdapter(channelPackage, payload, {
      publish: vi.fn(),
      reconcile: vi.fn().mockResolvedValue({
        outcome: 'APPLIED',
        remoteRef: 'https://git.example.test/tenant-owned/site-content/pull/41',
        remoteState,
      }),
    });
    const handler = new (publicationExecutionHandlerConstructor())(
      store,
      { readPublicationPackage: vi.fn().mockResolvedValue(payload) },
      { resolve: vi.fn().mockReturnValue(adapter) },
      authorizationMaterialsFor('task11-secret-value'),
      { readPublicationSecret: vi.fn().mockResolvedValue('task11-secret-value') },
      { next: randomUUID },
      { now: () => new Date('2026-07-21T00:00:00.000Z') },
    );

    await expect(handler.run(lease)).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      publicationStatus: 'REMOTE_APPLIED',
      remoteState,
    });
    expect(recordReconcileApplied).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationStatus: 'REMOTE_APPLIED',
        remoteState,
      }),
    );
  });

  test('persists a closed platform diagnostic for a recoverable branch policy conflict', async () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Reviewed content',
        'content.html': '<h1>Reviewed content</h1>',
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
        execution: makeExecution(lease, channelPackage),
      }),
      runGuardedEffect: vi.fn(),
      recordPublishApplied: vi.fn(),
      recordPublishAmbiguous: vi.fn(),
      recordReconcileApplied: vi.fn(),
      recordReconcileUnknown: vi.fn(),
      recordReconcileDefinitelyNotApplied: vi.fn(),
      recordRetryableFailure: vi.fn(),
      recordPreflightFailure,
    };
    const adapter = {
      ...makeAdapter(channelPackage, payload, {
        publish: vi.fn(),
        reconcile: vi.fn(),
      }),
      validateAuthorization: vi
        .fn()
        .mockResolvedValue({ outcome: 'INVALID', reason: 'BRANCH_POLICY_CONFLICT' }),
    };
    const handler = new (publicationExecutionHandlerConstructor())(
      store,
      { readPublicationPackage: vi.fn().mockResolvedValue(payload) },
      { resolve: vi.fn().mockReturnValue(adapter) },
      authorizationMaterialsFor('task11-secret-value'),
      { readPublicationSecret: vi.fn().mockResolvedValue('task11-secret-value') },
      { next: randomUUID },
      { now: () => new Date('2026-07-21T00:00:00.000Z') },
    );

    await expect(handler.run(lease)).resolves.toEqual({
      outcome: 'TERMINAL_FAILURE',
      errorCode: 'ADAPTER_AUTHORIZATION_BRANCH_POLICY_CONFLICT',
    });
    expect(recordPreflightFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'ADAPTER_AUTHORIZATION_BRANCH_POLICY_CONFLICT' }),
    );
  });

  test('persists verified signed-webhook receipt evidence with the non-live remote effect', async () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Reviewed content',
        'content.html': '<h1>Reviewed content</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const channelPackage = makePackage(payload);
    const lease = makeLease();
    const remoteState = {
      status: 'DELIVERED',
      number: null,
      isProductionLive: false,
      rollbackHandle: null,
      receiptEvidence: {
        schemaVersion: 'signed-webhook-receipt-evidence.v1',
        receiptId: `receipt:${lease.job.aggregateId}`,
        deliveryId: lease.job.aggregateId,
        receiverEffectId: `effect:${lease.job.aggregateId}`,
        requestBodySha256: 'b'.repeat(64),
        verifiedKeyId: 'hmac-2026-07',
        verifiedAlgorithm: 'HMAC_SHA256',
        receivedAt: '2026-07-21T12:00:00.000Z',
      },
    };
    const recordPublishApplied = vi.fn().mockResolvedValue(true);
    const store = {
      prepare: vi
        .fn()
        .mockResolvedValueOnce({
          outcome: 'PUBLISH',
          attemptId: randomUUID(),
          execution: makeExecution(lease, channelPackage),
        })
        .mockResolvedValueOnce({ outcome: 'INVALID_STATE' }),
      runGuardedEffect: guardedEffect(),
      recordPublishApplied,
      recordPublishAmbiguous: vi.fn().mockResolvedValue(true),
      recordReconcileApplied: vi.fn(),
      recordReconcileUnknown: vi.fn(),
      recordReconcileDefinitelyNotApplied: vi.fn(),
      recordRetryableFailure: vi.fn(),
      recordPreflightFailure: vi.fn(),
    };
    const adapter = makeAdapter(channelPackage, payload, {
      publish: vi.fn().mockResolvedValue({
        outcome: 'APPLIED',
        remoteRef: `https://cms.receiver.example.test/receipts/${lease.job.aggregateId}`,
        remoteState,
      }),
      reconcile: vi.fn(),
    });
    const handler = new (publicationExecutionHandlerConstructor())(
      store,
      { readPublicationPackage: vi.fn().mockResolvedValue(payload) },
      { resolve: vi.fn().mockReturnValue(adapter) },
      authorizationMaterialsFor('task14-secret-value'),
      { readPublicationSecret: vi.fn().mockResolvedValue('task14-secret-value') },
      { next: randomUUID },
      { now: () => new Date('2026-07-21T12:00:00.000Z') },
    );

    await expect(handler.run(lease)).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      publicationStatus: 'REMOTE_APPLIED',
      remoteState,
    });
    expect(recordPublishApplied).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationStatus: 'REMOTE_APPLIED',
        remoteState,
      }),
    );
  });

  test('accepts only strict bounded receipt evidence on a non-live DELIVERED state', () => {
    const valid = signedWebhookRemoteState(makeLease().job.aggregateId);

    expect(PublicationRemoteStateSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { ...valid, status: 'PR_OPENED' },
      { ...valid, isProductionLive: true },
      { ...valid, rollbackHandle: { operation: 'DELETE' } },
      {
        ...valid,
        receiptEvidence: { ...valid.receiptEvidence, unexpected: 'must fail closed' },
      },
      {
        ...valid,
        receiptEvidence: { ...valid.receiptEvidence, receiptId: 'x'.repeat(501) },
      },
    ]) {
      expect(PublicationRemoteStateSchema.safeParse(invalid).success).toBe(false);
    }
  });

  test('rejects receipt evidence belonging to a different delivery before persistence', async () => {
    const payload: ChannelPackagePayload = {
      files: {
        'content.md': '# Reviewed content',
        'content.html': '<h1>Reviewed content</h1>',
        'structured-data.json': '{"@context":"https://schema.org"}',
      },
    };
    const channelPackage = makePackage(payload);
    const lease = makeLease();
    const mismatchedState = signedWebhookRemoteState('00000000-0000-7000-8000-000000001119');
    const recordPublishApplied = vi.fn();
    const recordPublishAmbiguous = vi.fn().mockResolvedValue(true);
    const store = {
      prepare: vi
        .fn()
        .mockResolvedValueOnce({
          outcome: 'PUBLISH',
          attemptId: randomUUID(),
          execution: makeExecution(lease, channelPackage),
        })
        .mockResolvedValueOnce({ outcome: 'INVALID_STATE' }),
      runGuardedEffect: guardedEffect(),
      recordPublishApplied,
      recordPublishAmbiguous,
      recordReconcileApplied: vi.fn(),
      recordReconcileUnknown: vi.fn(),
      recordReconcileDefinitelyNotApplied: vi.fn(),
      recordRetryableFailure: vi.fn(),
      recordPreflightFailure: vi.fn(),
    };
    const adapter = makeAdapter(channelPackage, payload, {
      publish: vi.fn().mockResolvedValue({
        outcome: 'APPLIED',
        remoteRef: `https://cms.receiver.example.test/receipts/${lease.job.aggregateId}`,
        remoteState: mismatchedState,
      }),
      reconcile: vi.fn(),
    });
    const handler = new (publicationExecutionHandlerConstructor())(
      store,
      { readPublicationPackage: vi.fn().mockResolvedValue(payload) },
      { resolve: vi.fn().mockReturnValue(adapter) },
      authorizationMaterialsFor('task14-secret-value'),
      { readPublicationSecret: vi.fn().mockResolvedValue('task14-secret-value') },
      { next: randomUUID },
      { now: () => new Date('2026-07-21T12:00:00.000Z') },
    );

    await expect(handler.run(lease)).resolves.toEqual({
      outcome: 'TERMINAL_FAILURE',
      errorCode: 'PUBLICATION_EXECUTION_STATE_INVALID',
    });
    expect(recordPublishApplied).not.toHaveBeenCalled();
    expect(recordPublishAmbiguous).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'ADAPTER_APPLIED_REMOTE_STATE_INVALID' }),
    );
  });
});

function publicationExecutionHandlerConstructor(): new (
  store: unknown,
  payloads: unknown,
  adapters: unknown,
  authorizationMaterials: unknown,
  secrets: unknown,
  ids: unknown,
  clock: unknown,
) => {
  run(lease: JobLease): Promise<{
    outcome: string;
    publicationStatus?: string;
    remoteState?: unknown;
  }>;
} {
  return (
    WorkerRuntime as unknown as {
      PublicationExecutionHandler: new (
        store: unknown,
        payloads: unknown,
        adapters: unknown,
        authorizationMaterials: unknown,
        secrets: unknown,
        ids: unknown,
        clock: unknown,
      ) => {
        run(lease: JobLease): Promise<{
          outcome: string;
          publicationStatus?: string;
          remoteState?: unknown;
        }>;
      };
    }
  ).PublicationExecutionHandler;
}

function authorizationMaterialsFor(secretValue: string) {
  return {
    readForPublication: vi.fn().mockResolvedValue({
      secretReference: 'arn:fixture:git-secret',
      credentialFingerprint: createHash('sha256').update(secretValue, 'utf8').digest('hex'),
    }),
  };
}

function makeExecution(lease: JobLease, channelPackage: ChannelPackageRecord) {
  return {
    publicationId: lease.job.aggregateId,
    publicationStatus: 'RUNNING',
    idempotencyKey: 'task11-reviewed-intent',
    target: 'git-pr://installation-4101/tenant-owned/site-content',
    remoteRef: null,
    remoteState: null,
    channelPackage,
    adapterKey: 'git-pull-request',
    adapterVersion: '1.0.0',
    adapterCapabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'PULL_REQUEST_STATUS'],
    adapterRequiredScopes: ['contents:write', 'pull_requests:write'],
    adapterTermsVersion: 'git-test-terms-v1',
    adapterProcessingRegion: 'in-process-test-runtime',
    adapterRetentionPolicy: 'No retention.',
    adapterTrainingPolicy: 'No training.',
    adapterSubprocessors: [],
    adapterRatePolicy: { mode: 'deterministic-test-only' },
  };
}

function makeAdapter(
  channelPackage: ChannelPackageRecord,
  payload: ChannelPackagePayload,
  operations: { publish: ReturnType<typeof vi.fn>; reconcile: ReturnType<typeof vi.fn> },
) {
  return {
    adapterKey: 'git-pull-request',
    adapterVersion: '1.0.0',
    describe: () => ({
      adapterKey: 'git-pull-request',
      adapterVersion: '1.0.0',
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'ROLLBACK', 'PULL_REQUEST_STATUS'],
      requiredScopes: ['contents:write', 'pull_requests:write'],
      termsVersion: 'git-test-terms-v1',
      processingRegion: 'in-process-test-runtime',
      retentionPolicy: 'No retention.',
      trainingPolicy: 'No training.',
      subprocessors: [],
      ratePolicy: { mode: 'deterministic-test-only' },
    }),
    validateAuthorization: vi.fn().mockResolvedValue({ outcome: 'VALID' }),
    preview: () => ({ packageChecksum: channelPackage.packageChecksum, files: payload.files }),
    publish: operations.publish,
    reconcile: operations.reconcile,
    rollback: vi.fn(),
    refreshRemoteStatus: vi.fn(),
  };
}

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
    definitionId: '00000000-0000-7000-8000-000000001110',
    channelKey: 'git-pull-request',
  };
  const transformer = { key: 'generic-web-package', version: '1.0.0' };
  const artifact = {
    artifactId: '00000000-0000-7000-8000-000000001111',
    artifactRevisionId: '00000000-0000-7000-8000-000000001112',
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
    id: '00000000-0000-7000-8000-000000001113',
    tenantId: '00000000-0000-7000-8000-000000001114',
    workspaceId: '00000000-0000-7000-8000-000000001115',
    packageRevision: 1,
    channel,
    transformer,
    packageSchemaVersion,
    artifact,
    manifest,
    packageChecksum,
    payloadObjectRef: 'memory://task11-package',
    createdByUserId: '00000000-0000-7000-8000-000000001116',
    createdAt: '2026-07-21T00:00:00.000Z',
  };
}

function makeLease(): JobLease {
  return {
    job: {
      id: '00000000-0000-7000-8000-000000001117',
      tenantId: '00000000-0000-7000-8000-000000001114',
      workspaceId: '00000000-0000-7000-8000-000000001115',
      jobType: 'PUBLICATION',
      aggregateId: '00000000-0000-7000-8000-000000001118',
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
    leaseToken: 'task11-lease',
    messageId: 'task11-message',
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

function signedWebhookRemoteState(deliveryId: string) {
  return {
    status: 'DELIVERED',
    number: null,
    isProductionLive: false,
    rollbackHandle: null,
    receiptEvidence: {
      schemaVersion: 'signed-webhook-receipt-evidence.v1',
      receiptId: `receipt:${deliveryId}`,
      deliveryId,
      receiverEffectId: `effect:${deliveryId}`,
      requestBodySha256: 'b'.repeat(64),
      verifiedKeyId: 'hmac-2026-07',
      verifiedAlgorithm: 'HMAC_SHA256',
      receivedAt: '2026-07-21T12:00:00.000Z',
    },
  };
}
