import { createHash, randomUUID } from 'node:crypto';

import type {
  PublicationAdapter,
  PublicationAdapterRegistry,
} from '@aeostudio/application/channels-publishing';
import { describe, expect, test, vi } from 'vitest';

import { InMemoryChannelAuthorizationStore } from '../../api/src/channels/in-memory-channel-authorization-store.js';
import { ChannelAuthorizationValidationHandler } from './channel-authorization-validation-handler.js';

const now = new Date('2026-07-24T05:00:00.000Z');
const tenantId = '00000000-0000-7000-8000-00000000c001';
const workspaceId = '00000000-0000-7000-8000-00000000c002';
const authorizationId = '00000000-0000-7000-8000-00000000c003';
const adapterVersionId = '00000000-0000-7000-8000-00000000c004';
const target = 'fixture://provider-validation/exact-target';
const secretValue = 'credential-value-never-returned';

describe('Channel authorization validation Worker', () => {
  test('claims one durable command, validates through the Adapter and stores a bounded snapshot', async () => {
    const store = await pendingStore();
    const validateChannelAuthorization = vi.fn(() =>
      Promise.resolve({
        outcome: 'VERIFIED' as const,
        actualTarget: target,
        actualScopes: ['content:write'],
      }),
    );
    const handler = new ChannelAuthorizationValidationHandler(
      store,
      registry(adapter(validateChannelAuthorization)),
      {
        readValidationSecret: vi.fn(() => Promise.resolve(secretValue)),
      },
      { next: randomUUID },
      { now: () => now },
    );

    await expect(handler.runOnce('validator-worker-1')).resolves.toEqual({
      outcome: 'VERIFIED',
      authorizationId,
    });
    expect(validateChannelAuthorization).toHaveBeenCalledWith({
      tenantId,
      workspaceId,
      channelDefinitionId: '00000000-0000-7000-8000-00000000c005',
      target,
      requestedScopes: ['content:write'],
      acceptedTermsVersion: 'provider-terms-v1',
      secretValue,
    });
    const eligibility = await store.findForTarget({
      context,
      adapterVersionId,
      target,
    });
    expect(eligibility).toMatchObject({
      validationStatus: 'VERIFIED',
      validationSnapshot: {
        actualTarget: target,
        actualScopes: ['content:write'],
        acceptedTermsVersion: 'provider-terms-v1',
        validatedAt: now.toISOString(),
        validUntil: '2026-07-24T06:00:00.000Z',
      },
    });
    const credentialFingerprint = createHash('sha256').update(secretValue).digest('hex');
    expect(JSON.stringify(eligibility)).not.toContain(credentialFingerprint);
    await expect(store.findCredentialFingerprint({ context, authorizationId })).resolves.toBe(
      credentialFingerprint,
    );
    expect(JSON.stringify(await store.list({ context }))).not.toContain(secretValue);
    expect(JSON.stringify(await store.list({ context }))).not.toContain(credentialFingerprint);
  });

  test('fails closed when the deployed Adapter cannot perform provider validation', async () => {
    const store = await pendingStore();
    const handler = new ChannelAuthorizationValidationHandler(
      store,
      registry(adapter()),
      { readValidationSecret: () => Promise.resolve(secretValue) },
      { next: randomUUID },
      { now: () => now },
    );

    await expect(handler.runOnce('validator-worker-1')).resolves.toEqual({
      outcome: 'INVALID',
      authorizationId,
      failureCode: 'ADAPTER_VALIDATOR_UNAVAILABLE',
    });
    await expect(store.findForTarget({ context, adapterVersionId, target })).resolves.toMatchObject(
      {
        validationStatus: 'INVALID',
        validationSnapshot: null,
        validationFailureCode: 'ADAPTER_VALIDATOR_UNAVAILABLE',
      },
    );
  });
});

const context = {
  tenantId,
  workspaceId,
  actorUserId: '00000000-0000-7000-8000-00000000c006',
  membershipId: '00000000-0000-7000-8000-00000000c007',
  role: 'OWNER' as const,
};

async function pendingStore(): Promise<InMemoryChannelAuthorizationStore> {
  const store = new InMemoryChannelAuthorizationStore();
  await store.create({
    context,
    authorizationId,
    adapterVersionId,
    adapterKey: 'fixture-provider-adapter',
    adapterVersion: '1.0.0',
    channelDefinitionId: '00000000-0000-7000-8000-00000000c005',
    target,
    grantedScopes: ['content:write'],
    acceptedTermsVersion: 'provider-terms-v1',
    secretArn:
      'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:provider-validation-worker',
    expiresAt: new Date('2026-07-25T05:00:00.000Z'),
    createdAt: new Date('2026-07-24T04:59:00.000Z'),
    auditEventId: '00000000-0000-7000-8000-00000000c008',
  });
  return store;
}

function adapter(
  validateChannelAuthorization?: PublicationAdapter['validateChannelAuthorization'],
): PublicationAdapter {
  return {
    adapterKey: 'fixture-provider-adapter',
    adapterVersion: '1.0.0',
    describe: () => ({
      adapterKey: 'fixture-provider-adapter',
      adapterVersion: '1.0.0',
      capabilities: ['PREVIEW', 'PUBLISH', 'RECONCILE'],
      requiredScopes: ['content:write'],
      termsVersion: 'provider-terms-v1',
      processingRegion: 'provider-controlled',
      retentionPolicy: 'provider policy',
      trainingPolicy: 'no training',
      subprocessors: [],
      ratePolicy: { mode: 'provider' },
    }),
    ...(validateChannelAuthorization === undefined ? {} : { validateChannelAuthorization }),
    validateAuthorization: () => Promise.resolve({ outcome: 'UNKNOWN' }),
    preview: ({ channelPackage, payload }) => ({
      packageChecksum: channelPackage.packageChecksum,
      files: payload.files,
    }),
    publish: () => Promise.resolve({ outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'NOT_USED' }),
    reconcile: () => Promise.resolve({ outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'NOT_USED' }),
  };
}

function registry(value: PublicationAdapter): PublicationAdapterRegistry {
  return {
    resolve: (adapterKey, adapterVersion) =>
      adapterKey === value.adapterKey && adapterVersion === value.adapterVersion ? value : null,
  };
}
