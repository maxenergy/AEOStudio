import type {
  ActiveSignedWebhookEndpointVerification,
  PendingSignedWebhookEndpointVerification,
  SignedWebhookEndpointVerificationRecord,
  SignedWebhookEndpointVerificationStore,
} from '@aeostudio/application/channels-publishing';

export class InMemorySignedWebhookEndpointVerificationStore implements SignedWebhookEndpointVerificationStore {
  private readonly records = new Map<
    string,
    SignedWebhookEndpointVerificationRecord & {
      proofs: PendingSignedWebhookEndpointVerification['proofs'];
    }
  >();

  createPending(
    input: Parameters<SignedWebhookEndpointVerificationStore['createPending']>[0],
  ): Promise<PendingSignedWebhookEndpointVerification> {
    const record: PendingSignedWebhookEndpointVerification = {
      id: input.verificationId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      channelDefinitionId: input.channelDefinitionId,
      status: 'PENDING',
      endpointUrl: input.endpointUrl,
      receiptUrl: input.receiptUrl,
      algorithm: input.algorithm,
      keyId: input.keyId,
      verificationReference: input.verificationReference,
      createdByUserId: input.context.actorUserId,
      createdAt: input.createdAt.toISOString(),
      challengeExpiresAt: earliestChallengeExpiration(input.proofs),
      proofs: input.proofs.map((proof) => ({
        ...proof,
        challengeExpiresAt: proof.challengeExpiresAt.toISOString(),
      })),
      verifiedAt: null,
      revokedAt: null,
    };
    this.records.set(record.id, record);
    return Promise.resolve(structuredClone(record));
  }

  list(
    input: Parameters<SignedWebhookEndpointVerificationStore['list']>[0],
  ): Promise<SignedWebhookEndpointVerificationRecord[]> {
    return Promise.resolve(
      [...this.records.values()]
        .filter(
          (record) =>
            record.tenantId === input.context.tenantId &&
            record.workspaceId === input.context.workspaceId,
        )
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
        )
        .map(withoutChallenge),
    );
  }

  findPending(
    input: Parameters<SignedWebhookEndpointVerificationStore['findPending']>[0],
  ): Promise<PendingSignedWebhookEndpointVerification | null> {
    const current = this.records.get(input.verificationId);
    if (
      current === undefined ||
      current.status !== 'PENDING' ||
      current.tenantId !== input.context.tenantId ||
      current.workspaceId !== input.context.workspaceId
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve(structuredClone(current) as PendingSignedWebhookEndpointVerification);
  }

  markVerified(
    input: Parameters<SignedWebhookEndpointVerificationStore['markVerified']>[0],
  ): Promise<ActiveSignedWebhookEndpointVerification | null> {
    const current = this.records.get(input.verificationId);
    if (
      current === undefined ||
      current.status !== 'PENDING' ||
      current.tenantId !== input.context.tenantId ||
      current.workspaceId !== input.context.workspaceId ||
      !sameProofs(current.proofs, input.expectedProofs) ||
      current.proofs.some(
        ({ challengeExpiresAt }) =>
          new Date(challengeExpiresAt).getTime() <= input.verifiedAt.getTime(),
      )
    ) {
      return Promise.resolve(null);
    }
    const verified = {
      ...current,
      status: 'VERIFIED' as const,
      verifiedAt: input.verifiedAt.toISOString(),
      revokedAt: null,
    };
    this.records.set(verified.id, verified);
    return Promise.resolve({
      ...withoutChallenge(verified),
      endpointVerificationId: verified.id,
    } as ActiveSignedWebhookEndpointVerification);
  }

  revoke(
    input: Parameters<SignedWebhookEndpointVerificationStore['revoke']>[0],
  ): Promise<SignedWebhookEndpointVerificationRecord | null> {
    const current = this.records.get(input.verificationId);
    if (
      current === undefined ||
      current.tenantId !== input.context.tenantId ||
      current.workspaceId !== input.context.workspaceId
    ) {
      return Promise.resolve(null);
    }
    if (current.status === 'REVOKED') return Promise.resolve(withoutChallenge(current));
    const revoked = {
      ...current,
      status: 'REVOKED' as const,
      revokedAt: input.revokedAt.toISOString(),
    };
    this.records.set(revoked.id, revoked);
    return Promise.resolve(withoutChallenge(revoked));
  }

  findVerifiedEndpoint(
    input: Parameters<SignedWebhookEndpointVerificationStore['findVerifiedEndpoint']>[0],
  ): Promise<ActiveSignedWebhookEndpointVerification | null> {
    const current = this.records.get(input.endpointVerificationId);
    if (
      current === undefined ||
      current.status !== 'VERIFIED' ||
      current.tenantId !== input.tenantId ||
      current.workspaceId !== input.workspaceId ||
      current.channelDefinitionId !== input.channelDefinitionId ||
      current.verifiedAt === null ||
      current.revokedAt !== null
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      ...withoutChallenge(current),
      endpointVerificationId: current.id,
    } as ActiveSignedWebhookEndpointVerification);
  }
}

function withoutChallenge(
  record: SignedWebhookEndpointVerificationRecord & {
    proofs: PendingSignedWebhookEndpointVerification['proofs'];
  },
): SignedWebhookEndpointVerificationRecord {
  const publicRecord: Partial<SignedWebhookEndpointVerificationRecord> & {
    proofs?: PendingSignedWebhookEndpointVerification['proofs'];
  } = structuredClone(record);
  delete publicRecord.proofs;
  return publicRecord as SignedWebhookEndpointVerificationRecord;
}

function sameProofs(
  actual: PendingSignedWebhookEndpointVerification['proofs'],
  expected: PendingSignedWebhookEndpointVerification['proofs'],
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function earliestChallengeExpiration(
  proofs: Parameters<SignedWebhookEndpointVerificationStore['createPending']>[0]['proofs'],
): string {
  const timestamps = proofs.map(({ challengeExpiresAt }) => challengeExpiresAt.getTime());
  if (timestamps.length === 0) throw new Error('SIGNED_WEBHOOK_VERIFICATION_PROOF_REQUIRED');
  return new Date(Math.min(...timestamps)).toISOString();
}
