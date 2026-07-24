import { generateKeyPairSync } from 'node:crypto';

import * as AdapterRuntime from '@aeostudio/adapters';
import type {
  PublicationAdapter,
  PublicationAdapterCommand,
  PublicationAdapterDescriptor,
} from '@aeostudio/application/channels-publishing';
import * as ContractRuntime from '@aeostudio/contracts/channels';
import type {
  ChannelPackagePayload,
  ChannelPackageRecord,
} from '@aeostudio/domain/channels-publishing';
import { describe, expect, test } from 'vitest';

type SigningAlgorithm = 'HMAC_SHA256' | 'ED25519';

interface SignedWebhookTargetV1 {
  schemaVersion: 'signed-webhook-target.v1';
  endpointUrl: string;
  receiptUrl: string;
  endpointVerificationId: string;
  algorithm: SigningAlgorithm;
  keyId: string;
}

interface DnsResolver {
  resolve(hostname: string): Promise<string[]>;
}

interface HttpTransport {
  post(input: {
    url: string;
    address: string;
    headers: Record<string, string>;
    body: Uint8Array;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: Uint8Array;
    location: string | null;
    connectedAddress: string;
  }>;
}

interface ReceiverSnapshot {
  effectCount: number;
  deliveryRequestCount: number;
  receiptQueryCount: number;
  replayRejectCount: number;
  signatureRejectCount: number;
  timestampRejectCount: number;
  receiptQueryKeyIds: string[];
  effects: Array<{
    deliveryId: string;
    receiverEffectId: string;
    keyId: string;
    algorithm: SigningAlgorithm;
    requestBodySha256: string;
    packageChecksum: string;
    artifactRevisionId: string;
    artifactContentHash: string;
  }>;
}

interface FakeReceiver extends HttpTransport {
  queueFailure(
    mode:
      | 'TIMEOUT_AFTER_EFFECT'
      | 'FIVE_HUNDRED_AFTER_EFFECT'
      | 'ACCEPTED_PENDING'
      | 'TOO_MANY_REQUESTS'
      | 'ARBITRARY_FOUR_HUNDRED'
      | 'MALFORMED_UNICODE_RECEIPT'
      | 'TAMPER_BODY',
  ): void;
  replayLastRequest(): Promise<{ status: number; reason: string }>;
  snapshot(): ReceiverSnapshot;
}

type FakeReceiverConstructor = new (options: {
  deliveryUrl: string;
  receiptUrl: string;
  endpointVerificationId: string;
  address: string;
  verificationKeys: Array<{
    keyId: string;
    algorithm: SigningAlgorithm;
    verificationMaterial: string;
    validFrom: string;
    validUntil: string | null;
  }>;
  clock: { now(): Date };
  maxTimestampSkewSeconds: number;
  log(entry: string): void;
}) => FakeReceiver;

type SignedWebhookAdapterConstructor = new (options: {
  adapterKey: string;
  adapterVersion: string;
  descriptor: Omit<PublicationAdapterDescriptor, 'adapterKey' | 'adapterVersion'>;
  verifiedEndpoints: Array<{
    endpointUrl: string;
    receiptUrl: string;
    endpointVerificationId: string;
    algorithm: SigningAlgorithm;
    keyId: string;
  }>;
  resolver: DnsResolver;
  transport: HttpTransport;
  clock: { now(): Date };
  nextNonce(): string;
  maxTimestampSkewSeconds: number;
  timeoutMs: number;
}) => PublicationAdapter;

const publicAdapters = AdapterRuntime as unknown as {
  SignedWebhookPublicationAdapter?: SignedWebhookAdapterConstructor;
  VersionedFakeWebhookReceiver?: FakeReceiverConstructor;
};
const publicContracts = ContractRuntime as unknown as {
  encodeSignedWebhookTarget?: (target: SignedWebhookTargetV1) => string;
  decodeSignedWebhookTarget?: (value: string) => SignedWebhookTargetV1;
  SIGNED_WEBHOOK_DELIVERY_V1_JSON_SCHEMA?: Record<string, unknown>;
  SIGNED_WEBHOOK_RECEIPT_V1_JSON_SCHEMA?: Record<string, unknown>;
  SIGNED_WEBHOOK_RECEIPT_QUERY_V1_JSON_SCHEMA?: Record<string, unknown>;
};
const runtimeMissing =
  publicAdapters.SignedWebhookPublicationAdapter === undefined ||
  publicAdapters.VersionedFakeWebhookReceiver === undefined ||
  publicContracts.encodeSignedWebhookTarget === undefined ||
  publicContracts.decodeSignedWebhookTarget === undefined;

const deliveryUrl = 'https://cms.receiver.example.test/aeo/webhooks';
const receiptUrl = 'https://cms.receiver.example.test/aeo/webhook-receipts';
const verificationId = '00000000-0000-7000-8000-000000001401';
const hmacKeyId = 'hmac-2026-07';
const hmacSecret = 'task14-hmac-secret-sentinel-with-at-least-32-bytes';
const nowState = { value: new Date('2026-07-21T12:00:00.000Z') };

describe('Task 14 versioned signed webhook public contract', () => {
  test('exports a receiver-verifiable Adapter and versioned target/JSON Schemas', () => {
    expect(
      publicAdapters.SignedWebhookPublicationAdapter,
      'expected signature verification success/failure, signed webhook adapter unavailable',
    ).toBeTypeOf('function');
    expect(publicAdapters.VersionedFakeWebhookReceiver).toBeTypeOf('function');
    expect(publicContracts.encodeSignedWebhookTarget).toBeTypeOf('function');
    expect(publicContracts.decodeSignedWebhookTarget).toBeTypeOf('function');
    for (const schema of [
      publicContracts.SIGNED_WEBHOOK_DELIVERY_V1_JSON_SCHEMA,
      publicContracts.SIGNED_WEBHOOK_RECEIPT_V1_JSON_SCHEMA,
      publicContracts.SIGNED_WEBHOOK_RECEIPT_QUERY_V1_JSON_SCHEMA,
    ]) {
      expect(schema).toMatchObject({ $schema: 'https://json-schema.org/draft/2020-12/schema' });
      expect(JSON.stringify(schema)).not.toMatch(/secret|privateKey|signingMaterial/iu);
    }
  });

  test.skipIf(runtimeMissing)(
    'signs the exact approved package and accepts only a matching applied receipt',
    async () => {
      const harness = createHarness();
      const command = commandFor('00000000-0000-7000-8000-000000001410');
      await expect(harness.adapter.validateAuthorization(command)).resolves.toEqual({
        outcome: 'VALID',
      });
      expect(harness.adapter.preview(command)).toEqual({
        packageChecksum: command.channelPackage.packageChecksum,
        files: command.payload.files,
      });

      const publishResult = await harness.adapter.publish(command);
      expect(publishResult).toMatchObject({
        outcome: 'APPLIED',
        remoteRef: `${receiptUrl}/${command.publicationId}`,
        remoteState: {
          status: 'DELIVERED',
          number: null,
          isProductionLive: false,
          rollbackHandle: null,
          receiptEvidence: {
            schemaVersion: 'signed-webhook-receipt-evidence.v1',
            receiptId: `receipt:${command.publicationId}`,
            deliveryId: command.publicationId,
            receiverEffectId: `effect:${command.publicationId}`,
            verifiedKeyId: hmacKeyId,
            verifiedAlgorithm: 'HMAC_SHA256',
            receivedAt: '2026-07-21T12:00:00.000Z',
          },
        },
      });
      if (
        publishResult.outcome !== 'APPLIED' ||
        publishResult.remoteState?.receiptEvidence === undefined
      ) {
        throw new Error('expected persisted signed-webhook receipt evidence');
      }
      const receiptEvidence = publishResult.remoteState.receiptEvidence;
      expect(receiptEvidence.requestBodySha256).toMatch(/^[a-f0-9]{64}$/u);
      const snapshot = harness.receiver.snapshot();
      expect(snapshot).toMatchObject({
        effectCount: 1,
        deliveryRequestCount: 1,
        receiptQueryCount: 0,
        replayRejectCount: 0,
        signatureRejectCount: 0,
        effects: [
          {
            deliveryId: command.publicationId,
            keyId: hmacKeyId,
            algorithm: 'HMAC_SHA256',
            packageChecksum: command.channelPackage.packageChecksum,
            artifactRevisionId: command.channelPackage.artifact.artifactRevisionId,
            artifactContentHash: command.channelPackage.artifact.contentHash,
          },
        ],
      });
      expect(snapshot.effects[0]?.requestBodySha256).toBe(receiptEvidence.requestBodySha256);
      expect(JSON.stringify({ snapshot, logs: harness.logs })).not.toContain(hmacSecret);
    },
  );

  test.skipIf(runtimeMissing)(
    'rejects a target whose key ID is absent from the administratively verified endpoint tuple',
    async () => {
      const receiver = makeReceiver();
      const adapter = makeAdapter(receiver, { keyId: 'another-verified-key' });

      await expect(
        adapter.validateAuthorization(commandFor('00000000-0000-7000-8000-000000001433')),
      ).resolves.toEqual({ outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' });
      expect(receiver.snapshot().effectCount).toBe(0);
    },
  );

  test.skipIf(runtimeMissing)(
    'rejects a target whose algorithm differs from the administratively verified endpoint tuple',
    async () => {
      const receiver = makeReceiver();
      const adapter = makeAdapter(receiver, { algorithm: 'ED25519' });

      await expect(
        adapter.validateAuthorization(commandFor('00000000-0000-7000-8000-000000001434')),
      ).resolves.toEqual({ outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' });
      expect(receiver.snapshot().effectCount).toBe(0);
    },
  );

  test.skipIf(runtimeMissing)(
    'treats a receipt that claims a different verified key as ambiguous evidence',
    async () => {
      const receiver = makeReceiver();
      const dishonestTransport: HttpTransport = {
        async post(input) {
          const response = await receiver.post(input);
          const body = new TextDecoder().decode(response.body);
          return {
            ...response,
            body: new TextEncoder().encode(
              body.replace(`"verifiedKeyId":"${hmacKeyId}"`, '"verifiedKeyId":"different-key"'),
            ),
          };
        },
      };
      const adapter = makeAdapter(dishonestTransport);

      await expect(
        adapter.publish(commandFor('00000000-0000-7000-8000-000000001435')),
      ).resolves.toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'WEBHOOK_RECEIPT_MISMATCH',
      });
      expect(receiver.snapshot().effectCount).toBe(1);
    },
  );

  test.skipIf(runtimeMissing)(
    'rejects one-byte tampering, stale timestamps, and an exact nonce replay without effects',
    async () => {
      const tampered = createHarness();
      tampered.receiver.queueFailure('TAMPER_BODY');
      await expect(
        tampered.adapter.publish(commandFor('00000000-0000-7000-8000-000000001411')),
      ).resolves.toEqual({
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'WEBHOOK_SIGNATURE_REJECTED',
      });
      expect(tampered.receiver.snapshot()).toMatchObject({
        effectCount: 0,
        signatureRejectCount: 1,
      });

      const staleSenderClock = { now: () => new Date('2026-07-21T11:50:00.000Z') };
      const stale = createHarness({ senderClock: staleSenderClock });
      await expect(
        stale.adapter.publish(commandFor('00000000-0000-7000-8000-000000001412')),
      ).resolves.toEqual({
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'WEBHOOK_TIMESTAMP_REJECTED',
      });
      expect(stale.receiver.snapshot()).toMatchObject({ effectCount: 0, timestampRejectCount: 1 });

      const slightPositiveSkew = createHarness({
        senderClock: { now: () => new Date('2026-07-21T12:00:15.000Z') },
      });
      await expect(
        slightPositiveSkew.adapter.publish(commandFor('00000000-0000-7000-8000-000000001427')),
      ).resolves.toMatchObject({ outcome: 'APPLIED' });

      const invalidUnicode = createHarness();
      const invalidUnicodeCommand = commandFor('00000000-0000-7000-8000-000000001426');
      invalidUnicodeCommand.payload.files['content.md'] = '\ud800';
      await expect(invalidUnicode.adapter.publish(invalidUnicodeCommand)).resolves.toEqual({
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'WEBHOOK_CONFIGURATION_REJECTED',
      });
      expect(invalidUnicode.receiver.snapshot().effectCount).toBe(0);

      const replay = createHarness();
      await replay.adapter.publish(commandFor('00000000-0000-7000-8000-000000001413'));
      await expect(replay.receiver.replayLastRequest()).resolves.toEqual({
        status: 409,
        reason: 'REPLAY_REJECTED',
      });
      expect(replay.receiver.snapshot()).toMatchObject({ effectCount: 1, replayRejectCount: 1 });

      const replayClock = { value: new Date('2026-07-21T12:00:00.000Z') };
      const expiryReplayReceiver = makeReceiver({ clock: { now: () => replayClock.value } });
      const expiryReplayAdapter = makeAdapter(expiryReplayReceiver);
      await expiryReplayAdapter.publish(commandFor('00000000-0000-7000-8000-000000001424'));
      replayClock.value = new Date('2026-07-21T12:05:01.000Z');
      await expect(expiryReplayReceiver.replayLastRequest()).resolves.toEqual({
        status: 409,
        reason: 'REPLAY_REJECTED',
      });
    },
  );

  test.skipIf(runtimeMissing)(
    'supports HMAC key rotation and Ed25519 without exposing signing material',
    async () => {
      const oldSecret = 'task14-old-hmac-secret-sentinel-at-least-32-bytes';
      const newSecret = 'task14-new-hmac-secret-sentinel-at-least-32-bytes';
      const rotationClock = { now: () => nowState.value };
      const receiver = makeReceiver({
        clock: rotationClock,
        keys: [
          {
            keyId: 'old-key',
            algorithm: 'HMAC_SHA256',
            verificationMaterial: oldSecret,
            validFrom: '2026-07-01T00:00:00.000Z',
            validUntil: '2026-07-22T00:00:00.000Z',
          },
          {
            keyId: 'new-key',
            algorithm: 'HMAC_SHA256',
            verificationMaterial: newSecret,
            validFrom: '2026-07-21T00:00:00.000Z',
            validUntil: null,
          },
        ],
      });
      const oldAdapter = makeAdapter(receiver, {
        clock: rotationClock,
        keyId: 'old-key',
      });
      const oldCommand = commandFor('00000000-0000-7000-8000-000000001414', {
        target: targetFor('HMAC_SHA256', 'old-key'),
        secretValue: keyRing('old-key', [
          signingKey('old-key', 'HMAC_SHA256', oldSecret, '2026-07-22T00:00:00.000Z'),
          signingKey('new-key', 'HMAC_SHA256', newSecret, null),
        ]),
      });
      await expect(oldAdapter.publish(oldCommand)).resolves.toMatchObject({ outcome: 'APPLIED' });

      const newAdapter = makeAdapter(receiver, {
        clock: rotationClock,
        keyId: 'new-key',
      });
      const newCommand = commandFor('00000000-0000-7000-8000-000000001415', {
        target: targetFor('HMAC_SHA256', 'new-key'),
        secretValue: keyRing('new-key', [
          signingKey('old-key', 'HMAC_SHA256', oldSecret, '2026-07-22T00:00:00.000Z'),
          signingKey('new-key', 'HMAC_SHA256', newSecret, null),
        ]),
      });
      await expect(newAdapter.publish(newCommand)).resolves.toMatchObject({ outcome: 'APPLIED' });

      const overlapReceiver = makeReceiver({
        clock: rotationClock,
        keys: [
          {
            keyId: 'old-key',
            algorithm: 'HMAC_SHA256',
            verificationMaterial: oldSecret,
            validFrom: '2026-07-01T00:00:00.000Z',
            validUntil: '2026-07-22T00:00:00.000Z',
          },
          {
            keyId: 'new-key',
            algorithm: 'HMAC_SHA256',
            verificationMaterial: newSecret,
            validFrom: '2026-07-21T00:00:00.000Z',
            validUntil: null,
          },
        ],
      });
      const overlapAdapter = makeAdapter(overlapReceiver, {
        clock: rotationClock,
        keyId: 'old-key',
      });
      const overlapCommand = commandFor('00000000-0000-7000-8000-000000001425', {
        target: targetFor('HMAC_SHA256', 'old-key'),
        secretValue: keyRing('old-key', [
          signingKey('old-key', 'HMAC_SHA256', oldSecret, '2026-07-22T00:00:00.000Z'),
          signingKey('new-key', 'HMAC_SHA256', newSecret, null),
        ]),
      });
      overlapReceiver.queueFailure('TIMEOUT_AFTER_EFFECT');
      await expect(overlapAdapter.publish(overlapCommand)).resolves.toMatchObject({
        outcome: 'AMBIGUOUS',
      });
      const rotatedOverlapCommand = {
        ...overlapCommand,
        secretValue: keyRing('new-key', [
          signingKey('old-key', 'HMAC_SHA256', oldSecret, '2026-07-22T00:00:00.000Z'),
          signingKey('new-key', 'HMAC_SHA256', newSecret, null),
        ]),
      };
      await expect(overlapAdapter.validateAuthorization(rotatedOverlapCommand)).resolves.toEqual({
        outcome: 'VALID',
      });
      await expect(overlapAdapter.reconcile(rotatedOverlapCommand)).resolves.toMatchObject({
        outcome: 'APPLIED',
      });
      expect(overlapReceiver.snapshot()).toMatchObject({
        effectCount: 1,
        receiptQueryCount: 1,
        receiptQueryKeyIds: ['old-key'],
      });
      await expect(overlapAdapter.publish(rotatedOverlapCommand)).resolves.toEqual({
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'WEBHOOK_CONFIGURATION_REJECTED',
      });
      expect(overlapReceiver.snapshot().effectCount).toBe(1);

      nowState.value = new Date('2026-07-22T00:00:00.000Z');
      await expect(oldAdapter.validateAuthorization(oldCommand)).resolves.toEqual({
        outcome: 'INVALID',
        reason: 'TARGET_NOT_ALLOWED',
      });

      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const edReceiver = makeReceiver({
        keys: [
          {
            keyId: 'ed25519-key',
            algorithm: 'ED25519',
            verificationMaterial: publicPem,
            validFrom: '2026-07-01T00:00:00.000Z',
            validUntil: null,
          },
        ],
      });
      const edAdapter = makeAdapter(edReceiver, { algorithm: 'ED25519', keyId: 'ed25519-key' });
      const edCommand = commandFor('00000000-0000-7000-8000-000000001416', {
        target: targetFor('ED25519', 'ed25519-key'),
        secretValue: keyRing('ed25519-key', [
          signingKey('ed25519-key', 'ED25519', privatePem, null),
        ]),
      });
      await expect(edAdapter.publish(edCommand)).resolves.toMatchObject({ outcome: 'APPLIED' });
      expect(
        JSON.parse(JSON.stringify({ snapshot: edReceiver.snapshot(), privatePem, publicPem })),
      ).toMatchObject({ privatePem, publicPem });
      expect(JSON.stringify(edReceiver.snapshot())).not.toContain(privatePem);
      expect(JSON.stringify(receiver.snapshot())).not.toMatch(
        new RegExp(`${oldSecret}|${newSecret}`, 'u'),
      );
    },
  );

  test.skipIf(runtimeMissing)(
    'reconciles timeout/5xx after one effect and never treats HTTP 202 as applied',
    async () => {
      for (const mode of ['TIMEOUT_AFTER_EFFECT', 'FIVE_HUNDRED_AFTER_EFFECT'] as const) {
        const harness = createHarness();
        const command = commandFor(
          mode === 'TIMEOUT_AFTER_EFFECT'
            ? '00000000-0000-7000-8000-000000001417'
            : '00000000-0000-7000-8000-000000001418',
        );
        harness.receiver.queueFailure(mode);
        await expect(harness.adapter.publish(command)).resolves.toMatchObject({
          outcome: 'AMBIGUOUS',
        });
        await expect(harness.adapter.reconcile(command)).resolves.toMatchObject({
          outcome: 'APPLIED',
          remoteRef: `${receiptUrl}/${command.publicationId}`,
        });
        await expect(harness.adapter.publish(command)).resolves.toMatchObject({
          outcome: 'APPLIED',
        });
        expect(harness.receiver.snapshot()).toMatchObject({ effectCount: 1, receiptQueryCount: 1 });
      }

      const dnsState = { unavailable: false };
      const receiver = makeReceiver();
      receiver.queueFailure('TIMEOUT_AFTER_EFFECT');
      const dnsFailure = makeAdapter(receiver, {
        resolver: {
          resolve: () =>
            dnsState.unavailable
              ? Promise.reject(new Error('dns unavailable'))
              : Promise.resolve(['93.184.216.34']),
        },
      });
      const dnsFailureCommand = commandFor('00000000-0000-7000-8000-000000001428');
      await expect(dnsFailure.publish(dnsFailureCommand)).resolves.toMatchObject({
        outcome: 'AMBIGUOUS',
      });
      dnsState.unavailable = true;
      await expect(dnsFailure.reconcile(dnsFailureCommand)).resolves.toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'WEBHOOK_DNS_RESOLUTION_FAILED',
      });

      const accepted = createHarness();
      accepted.receiver.queueFailure('ACCEPTED_PENDING');
      await expect(
        accepted.adapter.publish(commandFor('00000000-0000-7000-8000-000000001419')),
      ).resolves.toEqual({ outcome: 'AMBIGUOUS', errorCode: 'WEBHOOK_RECEIPT_PENDING' });
      expect(accepted.receiver.snapshot().effectCount).toBe(0);
      await expect(
        accepted.adapter.reconcile(commandFor('00000000-0000-7000-8000-000000001419')),
      ).resolves.toEqual({ outcome: 'AMBIGUOUS', errorCode: 'WEBHOOK_RECEIPT_NOT_FOUND' });

      const rateLimited = createHarness();
      rateLimited.receiver.queueFailure('TOO_MANY_REQUESTS');
      await expect(
        rateLimited.adapter.publish(commandFor('00000000-0000-7000-8000-000000001429')),
      ).resolves.toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'WEBHOOK_RATE_LIMITED_RESULT_UNKNOWN',
      });
      expect(rateLimited.receiver.snapshot().effectCount).toBe(0);

      const arbitraryFourHundred = createHarness();
      arbitraryFourHundred.receiver.queueFailure('ARBITRARY_FOUR_HUNDRED');
      await expect(
        arbitraryFourHundred.adapter.publish(commandFor('00000000-0000-7000-8000-000000001430')),
      ).resolves.toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'WEBHOOK_REQUEST_REJECTED_RESULT_UNKNOWN',
      });
      expect(arbitraryFourHundred.receiver.snapshot().effectCount).toBe(0);

      const malformedUnicodeReceipt = createHarness();
      malformedUnicodeReceipt.receiver.queueFailure('MALFORMED_UNICODE_RECEIPT');
      await expect(
        malformedUnicodeReceipt.adapter.publish(commandFor('00000000-0000-7000-8000-000000001432')),
      ).resolves.toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'WEBHOOK_RECEIPT_MISMATCH',
      });
      expect(malformedUnicodeReceipt.receiver.snapshot().effectCount).toBe(1);

      const conflict = createHarness();
      const originalConflictCommand = commandFor('00000000-0000-7000-8000-000000001431');
      conflict.receiver.queueFailure('TIMEOUT_AFTER_EFFECT');
      await expect(conflict.adapter.publish(originalConflictCommand)).resolves.toMatchObject({
        outcome: 'AMBIGUOUS',
      });
      const changedConflictCommand = structuredClone(originalConflictCommand);
      changedConflictCommand.channelPackage.packageChecksum = 'f'.repeat(64);
      await expect(conflict.adapter.reconcile(changedConflictCommand)).resolves.toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'WEBHOOK_RECEIPT_CONFLICT',
      });
      expect(conflict.receiver.snapshot().effectCount).toBe(1);
    },
  );

  test.skipIf(runtimeMissing)(
    'treats a reset after the request may have reached the receiver as ambiguous',
    async () => {
      const adapter = makeAdapter({
        post: () =>
          Promise.reject(
            Object.assign(new Error('REQUEST_RESULT_UNKNOWN'), {
              code: 'REQUEST_RESULT_UNKNOWN',
            }),
          ),
      });

      await expect(
        adapter.publish(commandFor('00000000-0000-7000-8000-000000001431')),
      ).resolves.toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'WEBHOOK_REQUEST_RESULT_UNKNOWN',
      });
    },
  );

  test.skipIf(runtimeMissing)(
    'conservatively treats a connect failure as ambiguous because a secure socket may have accepted the request',
    async () => {
      const adapter = makeAdapter({
        post: () =>
          Promise.reject(
            Object.assign(new Error('CONNECT_FAILED'), {
              code: 'CONNECT_FAILED',
            }),
          ),
      });

      await expect(
        adapter.publish(commandFor('00000000-0000-7000-8000-000000001433')),
      ).resolves.toEqual({
        outcome: 'AMBIGUOUS',
        errorCode: 'WEBHOOK_CONNECT_FAILED',
      });
    },
  );

  test.skipIf(runtimeMissing)(
    'fails closed without a remote effect when the local transport rejects an oversized request',
    async () => {
      const adapter = makeAdapter({
        post: () =>
          Promise.reject(
            Object.assign(new Error('REQUEST_TOO_LARGE'), {
              code: 'REQUEST_TOO_LARGE',
            }),
          ),
      });

      await expect(
        adapter.publish(commandFor('00000000-0000-7000-8000-000000001434')),
      ).resolves.toEqual({
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'WEBHOOK_REQUEST_TOO_LARGE',
      });
    },
  );
});

function createHarness(options: { senderClock?: { now(): Date } } = {}) {
  const logs: string[] = [];
  const receiver = makeReceiver({ log: (entry) => logs.push(entry) });
  return {
    adapter: makeAdapter(receiver, { clock: options.senderClock }),
    receiver,
    logs,
  };
}

function makeReceiver(
  options: {
    clock?: { now(): Date };
    keys?: ConstructorParameters<FakeReceiverConstructor>[0]['verificationKeys'];
    log?: (entry: string) => void;
  } = {},
): FakeReceiver {
  const Constructor = publicAdapters.VersionedFakeWebhookReceiver;
  if (Constructor === undefined) throw new Error('expected signature verification receiver');
  return new Constructor({
    deliveryUrl,
    receiptUrl,
    endpointVerificationId: verificationId,
    address: '93.184.216.34',
    verificationKeys: options.keys ?? [
      {
        keyId: hmacKeyId,
        algorithm: 'HMAC_SHA256',
        verificationMaterial: hmacSecret,
        validFrom: '2026-07-01T00:00:00.000Z',
        validUntil: null,
      },
    ],
    clock: options.clock ?? { now: () => new Date('2026-07-21T12:00:00.000Z') },
    maxTimestampSkewSeconds: 300,
    log: options.log ?? (() => undefined),
  });
}

function makeAdapter(
  receiver: HttpTransport,
  options: {
    clock?: { now(): Date };
    algorithm?: SigningAlgorithm;
    keyId?: string;
    resolver?: DnsResolver;
  } = {},
): PublicationAdapter {
  const Constructor = publicAdapters.SignedWebhookPublicationAdapter;
  if (Constructor === undefined) throw new Error('expected signed webhook adapter');
  let nonce = 0;
  return new Constructor({
    adapterKey: 'signed-webhook',
    adapterVersion: '1.0.0',
    descriptor: descriptor(),
    verifiedEndpoints: [
      {
        endpointUrl: deliveryUrl,
        receiptUrl,
        endpointVerificationId: verificationId,
        algorithm: options.algorithm ?? 'HMAC_SHA256',
        keyId: options.keyId ?? hmacKeyId,
      },
    ],
    resolver: options.resolver ?? { resolve: () => Promise.resolve(['93.184.216.34']) },
    transport: receiver,
    clock: options.clock ?? { now: () => new Date('2026-07-21T12:00:00.000Z') },
    nextNonce: () => `task14-nonce-${String(++nonce).padStart(6, '0')}`,
    maxTimestampSkewSeconds: 300,
    timeoutMs: 5_000,
  });
}

function descriptor(): Omit<PublicationAdapterDescriptor, 'adapterKey' | 'adapterVersion'> {
  return {
    capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE', 'SIGNED_WEBHOOK'],
    requiredScopes: ['webhook:deliver'],
    termsVersion: 'signed-webhook-test-terms-v1',
    processingRegion: 'in-process-test-runtime',
    retentionPolicy: 'Receipts only; request bodies are not retained by the Adapter.',
    trainingPolicy: 'No training.',
    subprocessors: [],
    ratePolicy: { mode: 'deterministic-test-only' },
  };
}

function targetFor(algorithm: SigningAlgorithm = 'HMAC_SHA256', keyId = hmacKeyId): string {
  const encode = publicContracts.encodeSignedWebhookTarget;
  if (encode === undefined) throw new Error('expected signed webhook target codec');
  return encode({
    schemaVersion: 'signed-webhook-target.v1',
    endpointUrl: deliveryUrl,
    receiptUrl,
    endpointVerificationId: verificationId,
    algorithm,
    keyId,
  });
}

function commandFor(
  publicationId: string,
  overrides: { target?: string; secretValue?: string } = {},
): PublicationAdapterCommand {
  return {
    publicationId,
    idempotencyKey: publicationId,
    target: overrides.target ?? targetFor(),
    channelPackage: channelPackage(),
    payload: channelPayload(),
    secretValue:
      overrides.secretValue ??
      keyRing(hmacKeyId, [signingKey(hmacKeyId, 'HMAC_SHA256', hmacSecret, null)]),
  };
}

function channelPackage(): ChannelPackageRecord {
  const payload = channelPayload();
  return {
    id: '00000000-0000-7000-8000-000000001420',
    tenantId: '00000000-0000-7000-8000-000000001421',
    workspaceId: '00000000-0000-7000-8000-000000001422',
    packageRevision: 3,
    channel: {
      definitionId: '00000000-0000-7000-8000-000000001423',
      channelKey: 'signed-webhook',
    },
    transformer: { key: 'generic-web-package', version: '1.0.0' },
    packageSchemaVersion: '1.0.0',
    artifact: {
      artifactId: '00000000-0000-7000-8000-000000001424',
      artifactRevisionId: '00000000-0000-7000-8000-000000001425',
      revision: 7,
      contentHash: 'a'.repeat(64),
      type: 'DEFINITION_PRODUCT',
      locale: 'en-SG',
      market: 'SG',
      methodPolicyVersion: 'task14-method-v1',
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
        sha256:
          path === 'content.md'
            ? 'b'.repeat(64)
            : path === 'content.html'
              ? 'c'.repeat(64)
              : 'd'.repeat(64),
        byteLength: Buffer.byteLength(value, 'utf8'),
      })),
      assetRefs: [],
      claimSourceMap: [],
    },
    packageChecksum: 'e'.repeat(64),
    payloadObjectRef: 'memory://task-14-package',
    createdByUserId: '00000000-0000-7000-8000-000000001426',
    createdAt: '2026-07-21T11:00:00.000Z',
  };
}

function channelPayload(): ChannelPackagePayload {
  return {
    files: {
      'content.md': '# Approved webhook content\n',
      'content.html': '<article><h1>Approved webhook content</h1></article>',
      'structured-data.json': '{"@context":"https://schema.org","@type":"Article"}',
    },
  };
}

function signingKey(
  keyId: string,
  algorithm: SigningAlgorithm,
  signingMaterial: string,
  validUntil: string | null,
) {
  return {
    keyId,
    algorithm,
    signingMaterial,
    validFrom: '2026-07-01T00:00:00.000Z',
    validUntil,
  };
}

function keyRing(activeKeyId: string, keys: ReturnType<typeof signingKey>[]): string {
  return JSON.stringify({ schemaVersion: 'signed-webhook-key-ring.v1', activeKeyId, keys });
}
