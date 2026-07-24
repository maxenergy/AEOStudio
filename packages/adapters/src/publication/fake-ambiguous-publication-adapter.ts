import type {
  PublicationAdapter,
  PublicationAdapterAuthorizationResult,
  PublicationAdapterCommand,
  PublicationAdapterDescriptor,
  PublicationAdapterPreviewResult,
  PublicationAdapterPreviewCommand,
  PublicationAdapterPublishResult,
  PublicationAdapterReconcileResult,
  PublicationAdapterRollbackCommand,
  PublicationAdapterRollbackResult,
} from '@aeostudio/application/channels-publishing';

export interface FakeAmbiguousPublicationAdapterOptions {
  adapterKey: string;
  adapterVersion: string;
  descriptor: Omit<PublicationAdapterDescriptor, 'adapterKey' | 'adapterVersion'>;
  authorizationValidator: (command: PublicationAdapterCommand) => boolean;
}

interface FakeRemoteEffect {
  publicationId: string;
  remoteRef: string;
  rolledBack: boolean;
}

/**
 * Explicit in-process test/dev Adapter. Import and register it deliberately in a test harness;
 * production runtime composition never discovers or registers it automatically.
 */
export class FakeAmbiguousPublicationAdapter implements PublicationAdapter {
  readonly adapterKey: string;
  readonly adapterVersion: string;

  private readonly authorizationValidator: (command: PublicationAdapterCommand) => boolean;
  private readonly descriptor: Omit<PublicationAdapterDescriptor, 'adapterKey' | 'adapterVersion'>;
  private readonly effects = new Map<string, FakeRemoteEffect>();
  private publishCalls = 0;
  private reconcileCalls = 0;
  private rollbackCalls = 0;

  constructor(options: FakeAmbiguousPublicationAdapterOptions) {
    this.adapterKey = options.adapterKey;
    this.adapterVersion = options.adapterVersion;
    this.descriptor = structuredClone(options.descriptor);
    this.authorizationValidator = options.authorizationValidator;
  }

  describe(): PublicationAdapterDescriptor {
    return {
      adapterKey: this.adapterKey,
      adapterVersion: this.adapterVersion,
      ...structuredClone(this.descriptor),
    };
  }

  validateAuthorization(
    command: PublicationAdapterCommand,
  ): Promise<PublicationAdapterAuthorizationResult> {
    try {
      return Promise.resolve(
        this.authorizationValidator(command) ? { outcome: 'VALID' } : { outcome: 'INVALID' },
      );
    } catch {
      return Promise.resolve({ outcome: 'UNKNOWN' });
    }
  }

  preview(command: PublicationAdapterPreviewCommand): PublicationAdapterPreviewResult {
    return {
      packageChecksum: command.channelPackage.packageChecksum,
      files: { ...command.payload.files },
    };
  }

  publish(command: PublicationAdapterCommand): Promise<PublicationAdapterPublishResult> {
    this.publishCalls += 1;
    const existing = this.effects.get(command.idempotencyKey);
    if (existing !== undefined && existing.publicationId !== command.publicationId) {
      return Promise.resolve({
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'FAKE_IDEMPOTENCY_KEY_CONFLICT',
      });
    }
    if (existing === undefined) {
      this.effects.set(command.idempotencyKey, {
        publicationId: command.publicationId,
        remoteRef: `fake://remote/${command.publicationId}`,
        rolledBack: false,
      });
    }
    // Simulate a response being lost only after the idempotent remote effect exists.
    return Promise.resolve({
      outcome: 'AMBIGUOUS',
      errorCode: 'FAKE_RESPONSE_LOST_AFTER_EFFECT',
    });
  }

  reconcile(command: PublicationAdapterCommand): Promise<PublicationAdapterReconcileResult> {
    this.reconcileCalls += 1;
    const effect = this.effects.get(command.idempotencyKey);
    if (effect === undefined || effect.publicationId !== command.publicationId) {
      return Promise.resolve({
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'FAKE_REMOTE_EFFECT_NOT_FOUND',
      });
    }
    if (effect.rolledBack) {
      return Promise.resolve({
        outcome: 'DEFINITELY_NOT_APPLIED',
        errorCode: 'FAKE_REMOTE_EFFECT_ROLLED_BACK',
      });
    }
    return Promise.resolve({ outcome: 'APPLIED', remoteRef: effect.remoteRef });
  }

  rollback(command: PublicationAdapterRollbackCommand): Promise<PublicationAdapterRollbackResult> {
    this.rollbackCalls += 1;
    const effect = this.effects.get(command.idempotencyKey);
    if (
      effect === undefined ||
      effect.publicationId !== command.publicationId ||
      effect.remoteRef !== command.remoteRef
    ) {
      return Promise.resolve({
        outcome: 'DEFINITELY_NOT_ROLLED_BACK',
        errorCode: 'FAKE_REMOTE_EFFECT_NOT_FOUND',
      });
    }
    effect.rolledBack = true;
    return Promise.resolve({ outcome: 'ROLLED_BACK', remoteRef: effect.remoteRef });
  }

  snapshot(): {
    effectCount: number;
    publishCalls: number;
    reconcileCalls: number;
    rollbackCalls: number;
  } {
    return {
      effectCount: this.effects.size,
      publishCalls: this.publishCalls,
      reconcileCalls: this.reconcileCalls,
      rollbackCalls: this.rollbackCalls,
    };
  }
}
