import type { SignedWebhookTargetV1 } from '@aeostudio/contracts/channels';

/**
 * Platform-owned durable evidence that one receiver tuple was verified for the
 * narrowest channel scope available to a publication command.
 */
export interface SignedWebhookEndpointVerificationRecord {
  readonly status: 'VERIFIED';
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly channelDefinitionId: string;
  readonly endpointVerificationId: string;
  readonly endpointUrl: string;
  readonly receiptUrl: string;
  readonly algorithm: SignedWebhookTargetV1['algorithm'];
  readonly keyId: string;
}

export interface SignedWebhookEndpointVerificationPort {
  /**
   * Reads platform-owned durable state. Credential payloads are never valid
   * substitutes for this lookup.
   */
  findVerifiedEndpoint(input: {
    tenantId: string;
    workspaceId: string;
    channelDefinitionId: string;
    endpointVerificationId: string;
  }): Promise<SignedWebhookEndpointVerificationRecord | null>;
}
