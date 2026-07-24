import { createHash } from 'node:crypto';

import type {
  ChannelAuthorizationValidationCommandStore,
  ChannelAuthorizationValidationLease,
  PublicationAdapterRegistry,
} from '@aeostudio/application/channels-publishing';

const DEFAULT_VALIDATION_FRESHNESS_MS = 60 * 60 * 1_000;
const VALIDATION_LEASE_MS = 60 * 1_000;

export interface ChannelAuthorizationValidationSecretReader {
  readValidationSecret(input: {
    access: {
      commandId: string;
      authorizationId: string;
      leaseToken: string;
    };
    expected: {
      secretReference: string;
      tenantId: string;
      workspaceId: string;
    };
  }): Promise<string>;
}

export type ChannelAuthorizationValidationHandlerOutcome =
  | { outcome: 'IDLE' }
  | { outcome: 'VERIFIED'; authorizationId: string }
  | { outcome: 'INVALID'; authorizationId: string; failureCode: string }
  | { outcome: 'LEASE_LOST'; authorizationId: string };

/**
 * The only component that can turn PENDING_VALIDATION into VERIFIED/INVALID. It receives both the
 * Worker-only command store and secret reader; neither is wired into the API application graph.
 */
export class ChannelAuthorizationValidationHandler {
  constructor(
    private readonly commands: ChannelAuthorizationValidationCommandStore,
    private readonly adapters: PublicationAdapterRegistry,
    private readonly secrets: ChannelAuthorizationValidationSecretReader,
    private readonly ids: { next(): string },
    private readonly clock: { now(): Date },
    private readonly freshnessMs = DEFAULT_VALIDATION_FRESHNESS_MS,
  ) {
    if (
      !Number.isSafeInteger(freshnessMs) ||
      freshnessMs < 60_000 ||
      freshnessMs > DEFAULT_VALIDATION_FRESHNESS_MS
    ) {
      throw new Error('CHANNEL_AUTHORIZATION_VALIDATION_FRESHNESS_INVALID');
    }
  }

  async runOnce(workerId: string): Promise<ChannelAuthorizationValidationHandlerOutcome> {
    const claimedAt = this.clock.now();
    const lease = await this.commands.claimNext({
      workerId,
      leaseToken: this.ids.next(),
      now: claimedAt,
      leaseUntil: new Date(claimedAt.getTime() + VALIDATION_LEASE_MS),
    });
    if (lease === null) return { outcome: 'IDLE' };

    const authorizationExpiry =
      lease.authorizationExpiresAt === null
        ? null
        : new Date(lease.authorizationExpiresAt).getTime();
    if (
      authorizationExpiry !== null &&
      (!Number.isFinite(authorizationExpiry) || authorizationExpiry <= claimedAt.getTime())
    ) {
      return this.invalidate(lease, 'AUTHORIZATION_EXPIRED');
    }

    const adapter = this.adapters.resolve(lease.adapterKey, lease.adapterVersion);
    if (adapter === null) return this.invalidate(lease, 'ADAPTER_UNAVAILABLE');
    if (adapter.validateChannelAuthorization === undefined) {
      return this.invalidate(lease, 'ADAPTER_VALIDATOR_UNAVAILABLE');
    }
    let descriptor: ReturnType<typeof adapter.describe>;
    try {
      descriptor = adapter.describe();
    } catch {
      return this.invalidate(lease, 'ADAPTER_METADATA_INVALID');
    }
    if (
      adapter.adapterKey !== lease.adapterKey ||
      adapter.adapterVersion !== lease.adapterVersion ||
      descriptor.adapterKey !== lease.adapterKey ||
      descriptor.adapterVersion !== lease.adapterVersion ||
      descriptor.termsVersion !== lease.acceptedTermsVersion ||
      lease.requestedScopes.some((scope) => !descriptor.requiredScopes.includes(scope))
    ) {
      return this.invalidate(lease, 'ADAPTER_METADATA_INVALID');
    }

    let secretValue: string;
    try {
      secretValue = await this.secrets.readValidationSecret({
        access: {
          commandId: lease.commandId,
          authorizationId: lease.authorizationId,
          leaseToken: lease.leaseToken,
        },
        expected: {
          secretReference: lease.secretReference,
          tenantId: lease.tenantId,
          workspaceId: lease.workspaceId,
        },
      });
    } catch {
      return this.invalidate(lease, 'CREDENTIAL_UNAVAILABLE');
    }
    if (secretValue.length < 1 || secretValue.length > 64 * 1_024) {
      return this.invalidate(lease, 'CREDENTIAL_INVALID');
    }

    let validation: Awaited<ReturnType<NonNullable<typeof adapter.validateChannelAuthorization>>>;
    try {
      validation = await adapter.validateChannelAuthorization({
        tenantId: lease.tenantId,
        workspaceId: lease.workspaceId,
        channelDefinitionId: lease.channelDefinitionId,
        target: lease.target,
        requestedScopes: [...lease.requestedScopes],
        acceptedTermsVersion: lease.acceptedTermsVersion,
        secretValue,
      });
    } catch {
      validation = { outcome: 'UNKNOWN' };
    }
    if (validation.outcome !== 'VERIFIED') {
      return this.invalidate(
        lease,
        validation.outcome === 'INVALID'
          ? boundedFailureCode(`PROVIDER_${validation.reason}`)
          : 'PROVIDER_VALIDATION_UNAVAILABLE',
      );
    }
    if (
      validation.actualTarget !== lease.target ||
      validation.actualScopes.length > 100 ||
      new Set(validation.actualScopes).size !== validation.actualScopes.length ||
      validation.actualScopes.some((scope) => scope.trim().length < 1 || scope.length > 160) ||
      lease.requestedScopes.some((scope) => !validation.actualScopes.includes(scope))
    ) {
      return this.invalidate(lease, 'PROVIDER_VALIDATION_SNAPSHOT_INVALID');
    }

    const validatedAt = this.clock.now();
    const freshnessBoundary = new Date(validatedAt.getTime() + this.freshnessMs);
    const validUntil =
      authorizationExpiry !== null && authorizationExpiry < freshnessBoundary.getTime()
        ? new Date(authorizationExpiry)
        : freshnessBoundary;
    const completed = await this.commands.completeVerified({
      lease,
      actualTarget: validation.actualTarget,
      actualScopes: [...validation.actualScopes],
      acceptedTermsVersion: lease.acceptedTermsVersion,
      credentialFingerprint: createHash('sha256').update(secretValue).digest('hex'),
      validatedAt,
      validUntil,
    });
    return completed
      ? { outcome: 'VERIFIED', authorizationId: lease.authorizationId }
      : { outcome: 'LEASE_LOST', authorizationId: lease.authorizationId };
  }

  private async invalidate(
    lease: ChannelAuthorizationValidationLease,
    failureCode: string,
  ): Promise<ChannelAuthorizationValidationHandlerOutcome> {
    const bounded = boundedFailureCode(failureCode);
    const completed = await this.commands.completeInvalid({
      lease,
      failureCode: bounded,
      validatedAt: this.clock.now(),
    });
    return completed
      ? { outcome: 'INVALID', authorizationId: lease.authorizationId, failureCode: bounded }
      : { outcome: 'LEASE_LOST', authorizationId: lease.authorizationId };
  }
}

function boundedFailureCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{0,119}$/u.test(value) ? value : 'PROVIDER_VALIDATION_INVALID';
}
