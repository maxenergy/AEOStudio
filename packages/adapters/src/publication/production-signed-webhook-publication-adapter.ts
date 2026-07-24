import type {
  ChannelAuthorizationValidationInput,
  ChannelAuthorizationValidationResult,
  PublicationAdapter,
  PublicationAdapterAuthorizationResult,
  PublicationAdapterCommand,
  PublicationAdapterDescriptor,
  PublicationAdapterPreviewCommand,
  PublicationAdapterPreviewResult,
  PublicationAdapterPublishResult,
  PublicationAdapterReconcileResult,
} from '@aeostudio/application/channels-publishing';
import {
  decodeSignedWebhookTarget,
  encodeSignedWebhookTarget,
  type SignedWebhookTargetV1,
} from '@aeostudio/contracts/channels';

import type {
  SignedWebhookDnsResolver,
  SignedWebhookHttpTransport,
} from './signed-webhook-http-client.js';
import { SignedWebhookPublicationAdapter } from './signed-webhook-publication-adapter.js';
import {
  parseSignedWebhookKeyRing,
  requireActiveSigningKey,
  SIGNED_WEBHOOK_SIGNATURE_VALIDITY_SECONDS,
} from './signed-webhook-protocol.js';
import type {
  SignedWebhookEndpointVerificationPort,
  SignedWebhookEndpointVerificationRecord,
} from './signed-webhook-endpoint-verification.js';

export interface ProductionSignedWebhookPublicationAdapterOptions {
  descriptor: PublicationAdapterDescriptor;
  resolver: SignedWebhookDnsResolver;
  transport: SignedWebhookHttpTransport;
  clock: { now(): Date };
  nextNonce(): string;
  endpointVerifications?: SignedWebhookEndpointVerificationPort;
  timeoutMs?: number;
}

interface ProductionSignedWebhookCredential {
  endpoint: Omit<SignedWebhookTargetV1, 'schemaVersion'>;
  keyRingValue: string;
}

export class ProductionSignedWebhookPublicationAdapter implements PublicationAdapter {
  readonly adapterKey: string;
  readonly adapterVersion: string;

  private readonly descriptor: PublicationAdapterDescriptor;

  constructor(private readonly options: ProductionSignedWebhookPublicationAdapterOptions) {
    this.descriptor = structuredClone(options.descriptor);
    this.adapterKey = this.descriptor.adapterKey;
    this.adapterVersion = this.descriptor.adapterVersion;
  }

  describe(): PublicationAdapterDescriptor {
    return structuredClone(this.descriptor);
  }

  authorizationTargetFor(publicationTarget: string): string {
    decodeSignedWebhookTarget(publicationTarget);
    return publicationTarget;
  }

  requiredScopesFor(input: { target: string }): string[] {
    decodeSignedWebhookTarget(input.target);
    return ['webhook:deliver'];
  }

  async validateChannelAuthorization(
    input: ChannelAuthorizationValidationInput,
  ): Promise<ChannelAuthorizationValidationResult> {
    let target: SignedWebhookTargetV1;
    let credential: ProductionSignedWebhookCredential;
    try {
      target = decodeSignedWebhookTarget(input.target);
      credential = parseProductionSignedWebhookCredential(input.secretValue);
    } catch {
      return { outcome: 'INVALID', reason: 'CREDENTIAL_INVALID' };
    }
    if (input.acceptedTermsVersion !== this.descriptor.termsVersion) {
      return { outcome: 'INVALID', reason: 'TERMS_MISMATCH' };
    }
    if (
      !sameEndpoint(target, credential.endpoint) ||
      input.requestedScopes.some((scope) => scope !== 'webhook:deliver')
    ) {
      return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
    }
    const store = this.options.endpointVerifications;
    if (store === undefined) return { outcome: 'INVALID', reason: 'ENDPOINT_NOT_VERIFIED' };
    try {
      requireActiveSigningKey({
        secretValue: credential.keyRingValue,
        targetKeyId: target.keyId,
        targetAlgorithm: target.algorithm,
        now: this.options.clock.now(),
      });
    } catch {
      return { outcome: 'INVALID', reason: 'CREDENTIAL_INVALID' };
    }
    try {
      const verification = await store.findVerifiedEndpoint({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        channelDefinitionId: input.channelDefinitionId,
        endpointVerificationId: target.endpointVerificationId,
      });
      if (
        verification === null ||
        verification.status !== 'VERIFIED' ||
        verification.tenantId !== input.tenantId ||
        verification.workspaceId !== input.workspaceId ||
        verification.channelDefinitionId !== input.channelDefinitionId ||
        verification.endpointVerificationId !== target.endpointVerificationId ||
        verification.endpointUrl !== target.endpointUrl ||
        verification.receiptUrl !== target.receiptUrl ||
        verification.algorithm !== target.algorithm ||
        verification.keyId !== target.keyId
      ) {
        return { outcome: 'INVALID', reason: 'ENDPOINT_NOT_VERIFIED' };
      }
      return {
        outcome: 'VERIFIED',
        actualTarget: input.target,
        actualScopes: ['webhook:deliver'],
      };
    } catch {
      return { outcome: 'UNKNOWN' };
    }
  }

  async validateAuthorization(
    command: PublicationAdapterCommand,
  ): Promise<PublicationAdapterAuthorizationResult> {
    try {
      const verification = await this.requireDurableVerification(command);
      const { adapter, command: delegated } = this.delegate(command, verification);
      return await adapter.validateAuthorization(delegated);
    } catch {
      return { outcome: 'INVALID', reason: 'TARGET_NOT_ALLOWED' };
    }
  }

  preview(command: PublicationAdapterPreviewCommand): PublicationAdapterPreviewResult {
    const target = decodeSignedWebhookTarget(command.target);
    return this.adapterForTarget(target).preview(command);
  }

  async publish(command: PublicationAdapterCommand): Promise<PublicationAdapterPublishResult> {
    try {
      const verification = await this.requireDurableVerification(command);
      const delegated = this.delegate(command, verification);
      return await delegated.adapter.publish(delegated.command);
    } catch {
      return { outcome: 'DEFINITELY_NOT_APPLIED', errorCode: 'WEBHOOK_AUTHORIZATION_INVALID' };
    }
  }

  async reconcile(command: PublicationAdapterCommand): Promise<PublicationAdapterReconcileResult> {
    try {
      const verification = await this.requireDurableVerification(command);
      const delegated = this.delegate(command, verification);
      return await delegated.adapter.reconcile(delegated.command);
    } catch {
      return { outcome: 'AMBIGUOUS', errorCode: 'WEBHOOK_RECONCILIATION_UNAVAILABLE' };
    }
  }

  private delegate(
    command: PublicationAdapterCommand,
    verification: SignedWebhookEndpointVerificationRecord,
  ): {
    adapter: SignedWebhookPublicationAdapter;
    command: PublicationAdapterCommand;
  } {
    const target = decodeSignedWebhookTarget(command.target);
    const credential = parseProductionSignedWebhookCredential(command.secretValue);
    if (!sameEndpoint(target, credential.endpoint)) {
      throw new Error('WEBHOOK_CREDENTIAL_TARGET_MISMATCH');
    }
    return {
      adapter: this.adapterForTarget(target, verification),
      command: { ...command, secretValue: credential.keyRingValue },
    };
  }

  private async requireDurableVerification(
    command: PublicationAdapterCommand,
  ): Promise<SignedWebhookEndpointVerificationRecord> {
    const target = decodeSignedWebhookTarget(command.target);
    const store = this.options.endpointVerifications;
    if (store === undefined) throw new Error('WEBHOOK_ENDPOINT_VERIFICATION_STORE_UNAVAILABLE');
    const verification = await store.findVerifiedEndpoint({
      tenantId: command.channelPackage.tenantId,
      workspaceId: command.channelPackage.workspaceId,
      channelDefinitionId: command.channelPackage.channel.definitionId,
      endpointVerificationId: target.endpointVerificationId,
    });
    if (verification === null || !verificationMatchesCommand(verification, command, target)) {
      throw new Error('WEBHOOK_TARGET_NOT_VERIFIED');
    }
    return verification;
  }

  private adapterForTarget(
    target: SignedWebhookTargetV1,
    verification?: SignedWebhookEndpointVerificationRecord,
  ): SignedWebhookPublicationAdapter {
    const descriptor = {
      ...(this.descriptor.providerApiVersion === undefined
        ? {}
        : { providerApiVersion: this.descriptor.providerApiVersion }),
      capabilities: structuredClone(this.descriptor.capabilities),
      requiredScopes: structuredClone(this.descriptor.requiredScopes),
      termsVersion: this.descriptor.termsVersion,
      processingRegion: this.descriptor.processingRegion,
      retentionPolicy: this.descriptor.retentionPolicy,
      trainingPolicy: this.descriptor.trainingPolicy,
      subprocessors: structuredClone(this.descriptor.subprocessors),
      ratePolicy: structuredClone(this.descriptor.ratePolicy),
    };
    return new SignedWebhookPublicationAdapter({
      adapterKey: this.adapterKey,
      adapterVersion: this.adapterVersion,
      descriptor,
      verifiedEndpoints: [
        {
          endpointUrl: verification?.endpointUrl ?? target.endpointUrl,
          receiptUrl: verification?.receiptUrl ?? target.receiptUrl,
          endpointVerificationId:
            verification?.endpointVerificationId ?? target.endpointVerificationId,
          algorithm: verification?.algorithm ?? target.algorithm,
          keyId: verification?.keyId ?? target.keyId,
        },
      ],
      resolver: this.options.resolver,
      transport: this.options.transport,
      clock: this.options.clock,
      nextNonce: () => this.options.nextNonce(),
      maxTimestampSkewSeconds: SIGNED_WEBHOOK_SIGNATURE_VALIDITY_SECONDS,
      timeoutMs: this.options.timeoutMs ?? 5_000,
    });
  }
}

function parseProductionSignedWebhookCredential(
  secretValue: string,
): ProductionSignedWebhookCredential {
  let value: unknown;
  try {
    value = JSON.parse(secretValue) as unknown;
  } catch {
    throw new Error('WEBHOOK_CREDENTIAL_INVALID');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'endpoint', 'keyRing']) ||
    value.schemaVersion !== 'aeostudio.signed-webhook-credential.v1' ||
    !isRecord(value.endpoint) ||
    !hasExactKeys(value.endpoint, [
      'endpointUrl',
      'receiptUrl',
      'endpointVerificationId',
      'algorithm',
      'keyId',
    ])
  ) {
    throw new Error('WEBHOOK_CREDENTIAL_INVALID');
  }
  const target = decodeSignedWebhookTarget(
    encodeSignedWebhookTarget({
      schemaVersion: 'signed-webhook-target.v1',
      endpointUrl: value.endpoint.endpointUrl as string,
      receiptUrl: value.endpoint.receiptUrl as string,
      endpointVerificationId: value.endpoint.endpointVerificationId as string,
      algorithm: value.endpoint.algorithm as SignedWebhookTargetV1['algorithm'],
      keyId: value.endpoint.keyId as string,
    }),
  );
  const keyRingValue = JSON.stringify(value.keyRing);
  parseSignedWebhookKeyRing(keyRingValue);
  return {
    endpoint: {
      endpointUrl: target.endpointUrl,
      receiptUrl: target.receiptUrl,
      endpointVerificationId: target.endpointVerificationId,
      algorithm: target.algorithm,
      keyId: target.keyId,
    },
    keyRingValue,
  };
}

function sameEndpoint(
  target: SignedWebhookTargetV1,
  credential: ProductionSignedWebhookCredential['endpoint'],
): boolean {
  return (
    target.endpointUrl === credential.endpointUrl &&
    target.receiptUrl === credential.receiptUrl &&
    target.endpointVerificationId === credential.endpointVerificationId &&
    target.algorithm === credential.algorithm &&
    target.keyId === credential.keyId
  );
}

function verificationMatchesCommand(
  verification: SignedWebhookEndpointVerificationRecord,
  command: PublicationAdapterCommand,
  target: SignedWebhookTargetV1,
): boolean {
  return (
    verification.status === 'VERIFIED' &&
    verification.tenantId === command.channelPackage.tenantId &&
    verification.workspaceId === command.channelPackage.workspaceId &&
    verification.channelDefinitionId === command.channelPackage.channel.definitionId &&
    verification.endpointVerificationId === target.endpointVerificationId &&
    verification.endpointUrl === target.endpointUrl &&
    verification.receiptUrl === target.receiptUrl &&
    verification.algorithm === target.algorithm &&
    verification.keyId === target.keyId
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
