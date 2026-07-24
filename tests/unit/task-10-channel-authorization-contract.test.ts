import {
  ChannelAuthorizationMetadataSchema,
  CreateChannelAuthorizationRequestSchema,
  RevokeChannelAuthorizationRequestSchema,
} from '@aeostudio/contracts/channels';
import { describe, expect, test } from 'vitest';

const request = {
  adapterVersionId: '019f81e3-bef7-7728-83ea-22a7aa1efbbe',
  target: 'fixture://installation/main',
  grantedScopes: [],
  acceptedTermsVersion: '2026-07',
  secretArn: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:installation/no-expiry',
};

describe('Task 10 generic Channel authorization contracts', () => {
  test('an authorization can require no scopes and have no expiry', () => {
    expect(CreateChannelAuthorizationRequestSchema.parse(request)).toEqual(request);
    expect(CreateChannelAuthorizationRequestSchema.parse({ ...request, expiresAt: null })).toEqual({
      ...request,
      expiresAt: null,
    });
  });

  test('revoke is a strict lifecycle command and public metadata cannot carry a secret reference', () => {
    expect(RevokeChannelAuthorizationRequestSchema.parse({})).toEqual({});
    expect(RevokeChannelAuthorizationRequestSchema.safeParse({ status: 'ACTIVE' }).success).toBe(
      false,
    );
    expect(
      ChannelAuthorizationMetadataSchema.safeParse({
        id: '019f81e3-bef7-7728-83ea-22a7aa1efbbe',
        adapterVersionId: '019f81e3-bef7-7728-83ea-26dcf1843eff',
        status: 'REVOKED',
        target: 'fixture://installation/main',
        grantedScopes: [],
        acceptedTermsVersion: '2026-07',
        expiresAt: null,
        secretConfigured: true,
        secretArn: request.secretArn,
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:01:00.000Z',
      }).success,
    ).toBe(false);
  });

  test('public validation metadata rejects credential-derived fingerprints', () => {
    const publicMetadata = {
      id: '019f81e3-bef7-7728-83ea-22a7aa1efbbe',
      adapterVersionId: '019f81e3-bef7-7728-83ea-26dcf1843eff',
      status: 'ACTIVE',
      target: 'fixture://installation/main',
      grantedScopes: [],
      acceptedTermsVersion: '2026-07',
      expiresAt: null,
      validationStatus: 'VERIFIED',
      validationSnapshot: {
        actualTarget: 'fixture://installation/main',
        actualScopes: [],
        acceptedTermsVersion: '2026-07',
        validatedAt: '2026-07-24T03:00:00.000Z',
        validUntil: '2026-07-24T04:00:00.000Z',
      },
      validationFailureCode: null,
      secretConfigured: true,
      createdAt: '2026-07-24T02:59:00.000Z',
      updatedAt: '2026-07-24T03:00:00.000Z',
    };
    expect(ChannelAuthorizationMetadataSchema.parse(publicMetadata)).toEqual(publicMetadata);
    expect(
      ChannelAuthorizationMetadataSchema.safeParse({
        ...publicMetadata,
        validationSnapshot: {
          ...publicMetadata.validationSnapshot,
          credentialFingerprint: 'a'.repeat(64),
        },
      }).success,
    ).toBe(false);
  });
});
