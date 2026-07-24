import { roleAllows } from '@aeostudio/domain/identity-access';

import type { IdentityIdGenerator, TenancyStore } from '../identity-access/index.js';
import type {
  ChannelRegistryStore,
  PendingSignedWebhookEndpointVerification,
  SignedWebhookEndpointOwnershipVerifier,
  SignedWebhookEndpointVerificationRecord,
  SignedWebhookEndpointVerificationStore,
} from './ports.js';

const CHALLENGE_TTL_MILLISECONDS = 15 * 60 * 1_000;

export type CreateSignedWebhookEndpointVerificationOutcome =
  | {
      outcome: 'SUCCEEDED';
      verification: PendingSignedWebhookEndpointVerification;
    }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'FORBIDDEN' }
  | { outcome: 'CHANNEL_NOT_FOUND' };

export type ManageSignedWebhookEndpointVerificationOutcome =
  | { outcome: 'SUCCEEDED'; verification: SignedWebhookEndpointVerificationRecord }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'FORBIDDEN' };

export type VerifySignedWebhookEndpointVerificationOutcome =
  | ManageSignedWebhookEndpointVerificationOutcome
  | {
      outcome: 'OWNERSHIP_NOT_VERIFIED';
      reason:
        | 'CHALLENGE_EXPIRED'
        | 'CHALLENGE_MISMATCH'
        | 'INVALID_RESPONSE'
        | 'SSRF_BLOCKED'
        | 'TRANSPORT_FAILED';
    };

export type ListSignedWebhookEndpointVerificationsOutcome =
  | { outcome: 'SUCCEEDED'; verifications: SignedWebhookEndpointVerificationRecord[] }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'FORBIDDEN' };

export class SignedWebhookEndpointVerificationService {
  constructor(
    private readonly verifications: SignedWebhookEndpointVerificationStore,
    private readonly ownership: SignedWebhookEndpointOwnershipVerifier,
    private readonly registry: ChannelRegistryStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext' | 'appendDeniedAudit'>,
    private readonly ids: IdentityIdGenerator,
    private readonly challenges: { next(): string },
    private readonly clock: { now(): Date },
  ) {}

  async create(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    channelDefinitionId: string;
    endpointUrl: string;
    receiptUrl: string;
    algorithm: 'HMAC_SHA256' | 'ED25519';
    keyId: string;
    verificationReference: string;
  }): Promise<CreateSignedWebhookEndpointVerificationOutcome> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' };
    if (!roleAllows(context.role, 'CHANNEL_AUTHORIZATION_MANAGE')) {
      await this.appendDenied(context, 'SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_CREATE');
      return { outcome: 'FORBIDDEN' };
    }
    const channel = (await this.registry.listEntries({ context })).find(
      (entry) =>
        entry.id === input.channelDefinitionId &&
        entry.channelKey === 'signed-webhook' &&
        entry.status === 'AVAILABLE',
    );
    if (channel === undefined) return { outcome: 'CHANNEL_NOT_FOUND' };
    const now = this.clock.now();
    const challengeExpiresAt = new Date(now.getTime() + CHALLENGE_TTL_MILLISECONDS);
    const proofTargets =
      input.endpointUrl === input.receiptUrl
        ? [{ purpose: 'DELIVERY_AND_RECEIPT' as const, exactUrl: input.endpointUrl }]
        : [
            { purpose: 'DELIVERY' as const, exactUrl: input.endpointUrl },
            { purpose: 'RECEIPT' as const, exactUrl: input.receiptUrl },
          ];
    const proofs = proofTargets.map(({ purpose, exactUrl }) => ({
      purpose,
      exactUrl,
      challenge: this.validChallenge(),
      challengeExpiresAt,
    }));
    if (new Set(proofs.map(({ challenge }) => challenge)).size !== proofs.length) {
      throw new Error('SIGNED_WEBHOOK_VERIFICATION_CHALLENGE_DUPLICATE');
    }
    const verification = await this.verifications.createPending({
      context,
      verificationId: this.ids.next(),
      channelDefinitionId: input.channelDefinitionId,
      endpointUrl: input.endpointUrl,
      receiptUrl: input.receiptUrl,
      algorithm: input.algorithm,
      keyId: input.keyId,
      verificationReference: input.verificationReference,
      proofs,
      createdAt: now,
      auditEventId: this.ids.next(),
    });
    return { outcome: 'SUCCEEDED', verification };
  }

  async verify(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    verificationId: string;
  }): Promise<VerifySignedWebhookEndpointVerificationOutcome> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' };
    if (!roleAllows(context.role, 'CHANNEL_AUTHORIZATION_MANAGE')) {
      await this.appendDenied(context, 'SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_VERIFY');
      return { outcome: 'FORBIDDEN' };
    }
    const pending = await this.verifications.findPending({
      context,
      verificationId: input.verificationId,
    });
    if (pending === null) return { outcome: 'NOT_FOUND' };
    const now = this.clock.now();
    if (
      pending.proofs.some(
        ({ challengeExpiresAt }) => new Date(challengeExpiresAt).getTime() <= now.getTime(),
      )
    ) {
      return { outcome: 'OWNERSHIP_NOT_VERIFIED', reason: 'CHALLENGE_EXPIRED' };
    }
    for (const challenge of pending.proofs) {
      const proof = await this.ownership.verifyOwnership({
        verificationId: pending.id,
        purpose: challenge.purpose,
        exactUrl: challenge.exactUrl,
        challenge: challenge.challenge,
      });
      if (proof.outcome === 'FAILED') {
        return { outcome: 'OWNERSHIP_NOT_VERIFIED', reason: proof.reason };
      }
    }
    const verification = await this.verifications.markVerified({
      context,
      verificationId: pending.id,
      expectedProofs: pending.proofs,
      verifiedAt: now,
      auditEventId: this.ids.next(),
    });
    return verification === null
      ? { outcome: 'NOT_FOUND' }
      : { outcome: 'SUCCEEDED', verification };
  }

  async list(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<ListSignedWebhookEndpointVerificationsOutcome> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' };
    if (!roleAllows(context.role, 'CHANNEL_AUTHORIZATION_MANAGE')) {
      return { outcome: 'FORBIDDEN' };
    }
    return {
      outcome: 'SUCCEEDED',
      verifications: await this.verifications.list({ context }),
    };
  }

  async revoke(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    verificationId: string;
  }): Promise<ManageSignedWebhookEndpointVerificationOutcome> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' };
    if (!roleAllows(context.role, 'CHANNEL_AUTHORIZATION_MANAGE')) {
      await this.appendDenied(context, 'SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_REVOKE');
      return { outcome: 'FORBIDDEN' };
    }
    const verification = await this.verifications.revoke({
      context,
      verificationId: input.verificationId,
      revokedAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
    return verification === null
      ? { outcome: 'NOT_FOUND' }
      : { outcome: 'SUCCEEDED', verification };
  }

  private appendDenied(
    context: Parameters<TenancyStore['appendDeniedAudit']>[0]['context'],
    action: string,
  ) {
    return this.tenancy.appendDeniedAudit({
      context,
      auditEventId: this.ids.next(),
      action,
      resourceType: 'SIGNED_WEBHOOK_ENDPOINT_VERIFICATION',
    });
  }

  private validChallenge(): string {
    const challenge = this.challenges.next();
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(challenge)) {
      throw new Error('SIGNED_WEBHOOK_VERIFICATION_CHALLENGE_INVALID');
    }
    return challenge;
  }
}
