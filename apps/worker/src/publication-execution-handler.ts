import { createHash } from 'node:crypto';

import {
  verifyChannelPackagePayload,
  providerApiVersionIsExpired,
  validatePublicationAdapterRuntime,
  publicationAuthorizationFailureCode,
  resolvePublicationAdapterGovernance,
  type PublicationAdapterCommand,
  type PublicationAdapterReconciliationIntent,
  type PublicationAdapterRegistry,
  type PublicationAuthorizationMaterialReader,
  type PublicationExecutionStore,
} from '@aeostudio/application/channels-publishing';
import type { JobLease } from '@aeostudio/application/jobs-budgets';
import type {
  ActivePublicationPackageReader,
  ActivePublicationSecretReader,
} from '@aeostudio/application/tenant-data-access';
import type { PublicationRemoteState } from '@aeostudio/domain/channels-publishing';

export type PublicationExecutionHandlerOutcome =
  | {
      outcome: 'SUCCEEDED';
      publicationId: string;
      publicationStatus: 'PUBLISHED' | 'REMOTE_APPLIED';
      remoteRef: string;
      packageChecksum: string;
      remoteState?: PublicationRemoteState;
    }
  | { outcome: 'LEASE_LOST' }
  | { outcome: 'RETRYABLE_FAILURE'; errorCode: string }
  | { outcome: 'TERMINAL_FAILURE'; errorCode: string };

export class PublicationExecutionHandler {
  constructor(
    private readonly store: PublicationExecutionStore,
    private readonly payloads: ActivePublicationPackageReader,
    private readonly adapters: PublicationAdapterRegistry,
    private readonly authorizationMaterials: PublicationAuthorizationMaterialReader,
    private readonly secrets: ActivePublicationSecretReader,
    private readonly ids: { next(): string },
    private readonly clock: { now(): Date },
  ) {}

  async run(lease: JobLease): Promise<PublicationExecutionHandlerOutcome> {
    for (let transition = 0; transition < 3; transition += 1) {
      const prepared = await this.store.prepare({
        lease,
        publishAttemptId: this.ids.next(),
        reconcileAttemptId: this.ids.next(),
        publishAuditEventId: this.ids.next(),
        recoveryAuditEventId: this.ids.next(),
        reconcileAuditEventId: this.ids.next(),
        gateFailureAuditEventId: this.ids.next(),
        now: this.clock.now(),
      });
      if (prepared.outcome === 'FENCED') return { outcome: 'LEASE_LOST' };
      if (prepared.outcome === 'GATE_REJECTED') {
        return { outcome: 'TERMINAL_FAILURE', errorCode: prepared.errorCode };
      }
      if (prepared.outcome === 'NOT_FOUND' || prepared.outcome === 'INVALID_STATE') {
        return {
          outcome: 'TERMINAL_FAILURE',
          errorCode:
            prepared.outcome === 'NOT_FOUND'
              ? 'PUBLICATION_EXECUTION_NOT_FOUND'
              : 'PUBLICATION_EXECUTION_STATE_INVALID',
        };
      }
      if (prepared.outcome === 'PUBLISHED' || prepared.outcome === 'REMOTE_APPLIED') {
        const remoteRef = validRemoteRef(prepared.execution.remoteRef);
        const storedRemoteState = prepared.execution.remoteState ?? null;
        const remoteState =
          storedRemoteState === null
            ? null
            : validRemoteState(storedRemoteState, prepared.execution.publicationId);
        const stateIsInvalid =
          (storedRemoteState !== null && remoteState === null) ||
          (prepared.outcome === 'REMOTE_APPLIED' &&
            (remoteState === null || remoteState.isProductionLive)) ||
          (prepared.outcome === 'PUBLISHED' &&
            remoteState !== null &&
            !remoteState.isProductionLive);
        if (remoteRef === null) {
          return { outcome: 'TERMINAL_FAILURE', errorCode: 'PUBLICATION_REMOTE_REF_INVALID' };
        }
        if (stateIsInvalid) {
          return { outcome: 'TERMINAL_FAILURE', errorCode: 'PUBLICATION_REMOTE_STATE_INVALID' };
        }
        return succeeded(
          prepared.execution.publicationId,
          remoteRef,
          prepared.execution.channelPackage.packageChecksum,
          prepared.outcome,
          remoteState,
        );
      }

      if (
        providerApiVersionIsExpired(
          prepared.execution.adapterProviderApiSupportedUntil,
          this.clock.now(),
        )
      ) {
        return this.recordPreflightFailure(lease, prepared, 'ADAPTER_PROVIDER_API_VERSION_EXPIRED');
      }

      const payload = await this.payloads.readPublicationPackage({
        access: {
          publicationId: lease.job.aggregateId,
          leaseToken: lease.leaseToken,
        },
        expected: {
          objectRef: prepared.execution.channelPackage.payloadObjectRef,
          tenantId: prepared.execution.channelPackage.tenantId,
          workspaceId: prepared.execution.channelPackage.workspaceId,
          packageChecksum: prepared.execution.channelPackage.packageChecksum,
        },
      });
      if (
        payload === null ||
        verifyChannelPackagePayload(prepared.execution.channelPackage, payload) === null
      ) {
        return this.recordPreflightFailure(lease, prepared, 'CHANNEL_PACKAGE_INTEGRITY_INVALID');
      }
      const adapter = this.adapters.resolve(
        prepared.execution.adapterKey,
        prepared.execution.adapterVersion,
      );
      if (adapter === null) {
        return this.recordPreflightFailure(lease, prepared, 'ADAPTER_RUNTIME_UNAVAILABLE');
      }
      const runtimeMismatch = validatePublicationAdapterRuntime(adapter, {
        adapterKey: prepared.execution.adapterKey,
        adapterVersion: prepared.execution.adapterVersion,
        ...(prepared.execution.adapterProviderApiVersion === undefined
          ? {}
          : { providerApiVersion: prepared.execution.adapterProviderApiVersion }),
        capabilities: prepared.execution.adapterCapabilities,
        requiredScopes: prepared.execution.adapterRequiredScopes,
        termsVersion: prepared.execution.adapterTermsVersion,
        processingRegion: prepared.execution.adapterProcessingRegion,
        retentionPolicy: prepared.execution.adapterRetentionPolicy,
        trainingPolicy: prepared.execution.adapterTrainingPolicy,
        subprocessors: prepared.execution.adapterSubprocessors,
        ratePolicy: prepared.execution.adapterRatePolicy,
      });
      if (runtimeMismatch !== null) {
        return this.recordPreflightFailure(lease, prepared, runtimeMismatch);
      }
      const governance = resolvePublicationAdapterGovernance(
        adapter,
        prepared.execution.adapterRequiredScopes,
        {
          target: prepared.execution.target,
          channelPackage: prepared.execution.channelPackage,
        },
      );
      if (
        governance === null ||
        governance.authorizationTarget !==
          (prepared.execution.authorizationTarget ?? prepared.execution.target) ||
        governance.requiredScopes.some(
          (scope) =>
            !(
              prepared.execution.authorizationGrantedScopes ??
              prepared.execution.adapterRequiredScopes
            ).includes(scope),
        )
      ) {
        return this.recordPreflightFailure(lease, prepared, 'PUBLICATION_AUTHORIZATION_STALE');
      }

      let authorizationMaterial: Awaited<
        ReturnType<PublicationAuthorizationMaterialReader['readForPublication']>
      >;
      try {
        authorizationMaterial = await this.authorizationMaterials.readForPublication({ lease });
      } catch {
        return this.recordPreflightFailure(lease, prepared, 'AUTHORIZATION_SECRET_UNAVAILABLE');
      }
      if (authorizationMaterial === null) {
        return this.recordPreflightFailure(lease, prepared, 'PUBLICATION_AUTHORIZATION_STALE');
      }
      let secretValue: string;
      try {
        secretValue = await this.secrets.readPublicationSecret({
          access: {
            publicationId: lease.job.aggregateId,
            leaseToken: lease.leaseToken,
          },
          expected: {
            secretReference: authorizationMaterial.secretReference,
            tenantId: lease.job.tenantId,
            workspaceId: lease.job.workspaceId,
          },
        });
      } catch {
        return this.recordPreflightFailure(lease, prepared, 'AUTHORIZATION_SECRET_UNAVAILABLE');
      }
      if (
        createHash('sha256').update(secretValue).digest('hex') !==
        authorizationMaterial.credentialFingerprint
      ) {
        return this.recordPreflightFailure(lease, prepared, 'PUBLICATION_AUTHORIZATION_STALE');
      }
      const command: PublicationAdapterCommand = {
        publicationId: prepared.execution.publicationId,
        // Client keys are only Workspace-unique. Publication IDs are globally unique and stable
        // across publish/reconcile, so shared remote Adapter domains cannot collapse Tenants.
        idempotencyKey: prepared.execution.publicationId,
        target: prepared.execution.target,
        channelPackage: prepared.execution.channelPackage,
        payload,
        secretValue,
      };
      let authorization: Awaited<ReturnType<typeof adapter.validateAuthorization>>;
      try {
        authorization = await adapter.validateAuthorization(command);
      } catch {
        authorization = { outcome: 'UNKNOWN' };
      }
      if (authorization.outcome !== 'VALID') {
        return this.recordPreflightFailure(
          lease,
          prepared,
          publicationAuthorizationFailureCode(authorization),
        );
      }
      if (
        providerApiVersionIsExpired(
          prepared.execution.adapterProviderApiSupportedUntil,
          this.clock.now(),
        )
      ) {
        return this.recordPreflightFailure(lease, prepared, 'ADAPTER_PROVIDER_API_VERSION_EXPIRED');
      }
      if (prepared.outcome === 'PUBLISH') {
        const guarded = await this.store.runGuardedEffect(
          {
            lease,
            attemptId: prepared.attemptId,
            operation: 'PUBLISH',
            expectedAuthorizationMaterial: authorizationMaterial,
            expectedRequiredScopes: governance.requiredScopes,
          },
          async () => {
            try {
              return { outcome: 'RETURNED' as const, result: await adapter.publish(command) };
            } catch {
              return { outcome: 'THREW' as const };
            }
          },
        );
        if (guarded.outcome === 'FENCED') return { outcome: 'LEASE_LOST' };
        if (guarded.outcome === 'GATE_REJECTED') {
          return this.recordPreflightFailure(lease, prepared, 'PUBLICATION_GATE_STALE');
        }
        const result: Awaited<ReturnType<typeof adapter.publish>> =
          guarded.value.outcome === 'RETURNED'
            ? guarded.value.result
            : { outcome: 'AMBIGUOUS', errorCode: 'ADAPTER_PUBLISH_OUTCOME_UNKNOWN' };
        if (result.outcome === 'APPLIED') {
          const remoteRef = validRemoteRef(
            result.remoteRef,
            secretValue,
            authorizationMaterial.secretReference,
          );
          if (remoteRef === null) {
            const ambiguous = await this.store.recordPublishAmbiguous({
              lease,
              attemptId: prepared.attemptId,
              errorCode: 'ADAPTER_APPLIED_REMOTE_REF_INVALID',
              auditEventId: this.ids.next(),
              now: this.clock.now(),
            });
            if (!ambiguous) return { outcome: 'LEASE_LOST' };
            continue;
          }
          const remoteState =
            result.remoteState === undefined
              ? null
              : validRemoteState(
                  result.remoteState,
                  prepared.execution.publicationId,
                  secretValue,
                  authorizationMaterial.secretReference,
                );
          if (result.remoteState !== undefined && remoteState === null) {
            const ambiguous = await this.store.recordPublishAmbiguous({
              lease,
              attemptId: prepared.attemptId,
              errorCode: 'ADAPTER_APPLIED_REMOTE_STATE_INVALID',
              auditEventId: this.ids.next(),
              now: this.clock.now(),
            });
            if (!ambiguous) return { outcome: 'LEASE_LOST' };
            continue;
          }
          const publicationStatus =
            remoteState?.isProductionLive === false ? 'REMOTE_APPLIED' : 'PUBLISHED';
          const applied = await this.store.recordPublishApplied({
            lease,
            attemptId: prepared.attemptId,
            remoteRef,
            publicationStatus,
            remoteState,
            auditEventId: this.ids.next(),
            now: this.clock.now(),
          });
          return applied
            ? succeeded(
                prepared.execution.publicationId,
                remoteRef,
                prepared.execution.channelPackage.packageChecksum,
                publicationStatus,
                remoteState,
              )
            : { outcome: 'LEASE_LOST' };
        }
        if (result.outcome === 'DEFINITELY_NOT_APPLIED') {
          return this.recordPreflightFailure(
            lease,
            prepared,
            'ADAPTER_PUBLISH_DEFINITELY_NOT_APPLIED',
          );
        }
        if (result.outcome === 'RETRYABLE_FAILURE') {
          return this.recordRetryableFailure(lease, prepared, 'ADAPTER_PUBLISH_RETRYABLE_FAILURE');
        }
        if (result.outcome === 'TERMINAL_FAILURE') {
          return this.recordPreflightFailure(lease, prepared, 'ADAPTER_PUBLISH_TERMINAL_FAILURE');
        }
        const reconciliationIntent =
          result.outcome === 'AMBIGUOUS'
            ? validReconciliationIntent(
                result.reconciliationIntent,
                secretValue,
                authorizationMaterial.secretReference,
              )
            : null;
        const ambiguous = await this.store.recordPublishAmbiguous({
          lease,
          attemptId: prepared.attemptId,
          // Adapter-owned strings are untrusted and can contain credentials. Persist only a
          // platform-owned closed error code at the execution boundary.
          errorCode:
            reconciliationIntent === null
              ? 'ADAPTER_PUBLISH_OUTCOME_UNKNOWN'
              : 'UNSAFE_CREATE_COMPENSATION_PENDING',
          ...(reconciliationIntent === null ? {} : { remoteRef: reconciliationIntent.remoteRef }),
          auditEventId: this.ids.next(),
          now: this.clock.now(),
        });
        if (!ambiguous) return { outcome: 'LEASE_LOST' };
        // The next prepare call starts reconciliation. Never invoke publish again after ambiguity.
        continue;
      }

      const reconciliationIntent = validReconciliationIntent(
        prepared.execution.reconciliationIntent,
        secretValue,
        authorizationMaterial.secretReference,
      );
      const guarded = await this.store.runGuardedEffect(
        {
          lease,
          attemptId: prepared.attemptId,
          operation: 'RECONCILE',
          expectedAuthorizationMaterial: authorizationMaterial,
          expectedRequiredScopes: governance.requiredScopes,
        },
        async () => {
          try {
            return {
              outcome: 'RETURNED' as const,
              result: await adapter.reconcile({
                ...command,
                ...(reconciliationIntent === null ? {} : { reconciliationIntent }),
              }),
            };
          } catch {
            return { outcome: 'THREW' as const };
          }
        },
      );
      if (guarded.outcome === 'FENCED') return { outcome: 'LEASE_LOST' };
      if (guarded.outcome === 'GATE_REJECTED') {
        return this.recordPreflightFailure(
          lease,
          prepared,
          'PUBLICATION_RECONCILE_GATE_UNAVAILABLE',
        );
      }
      if (guarded.value.outcome === 'THREW') {
        return this.recordReconcileUnknown(
          lease,
          prepared.attemptId,
          'ADAPTER_RECONCILE_OUTCOME_UNKNOWN',
        );
      }
      const reconciled: Awaited<ReturnType<typeof adapter.reconcile>> = guarded.value.result;
      if (reconciled.outcome === 'DEFINITELY_NOT_APPLIED') {
        const errorCode = 'ADAPTER_RECONCILE_DEFINITELY_NOT_APPLIED';
        const recorded = await this.store.recordReconcileDefinitelyNotApplied({
          lease,
          attemptId: prepared.attemptId,
          errorCode,
          auditEventId: this.ids.next(),
          now: this.clock.now(),
        });
        return recorded ? { outcome: 'TERMINAL_FAILURE', errorCode } : { outcome: 'LEASE_LOST' };
      }
      if (reconciled.outcome === 'RETRYABLE_FAILURE') {
        return this.recordRetryableFailure(lease, prepared, 'ADAPTER_RECONCILE_RETRYABLE_FAILURE');
      }
      if (reconciled.outcome === 'TERMINAL_FAILURE') {
        return this.recordPreflightFailure(lease, prepared, 'ADAPTER_RECONCILE_TERMINAL_FAILURE');
      }
      if (reconciled.outcome !== 'APPLIED') {
        return this.recordReconcileUnknown(
          lease,
          prepared.attemptId,
          'ADAPTER_RECONCILE_OUTCOME_UNKNOWN',
        );
      }
      const remoteRef = validRemoteRef(
        reconciled.remoteRef,
        secretValue,
        authorizationMaterial.secretReference,
      );
      if (remoteRef === null) {
        return this.recordReconcileUnknown(
          lease,
          prepared.attemptId,
          'ADAPTER_RECONCILE_REMOTE_REF_INVALID',
        );
      }
      const remoteState =
        reconciled.remoteState === undefined
          ? null
          : validRemoteState(
              reconciled.remoteState,
              prepared.execution.publicationId,
              secretValue,
              authorizationMaterial.secretReference,
            );
      if (reconciled.remoteState !== undefined && remoteState === null) {
        return this.recordReconcileUnknown(
          lease,
          prepared.attemptId,
          'ADAPTER_RECONCILE_REMOTE_STATE_INVALID',
        );
      }
      const publicationStatus =
        remoteState?.isProductionLive === false ? 'REMOTE_APPLIED' : 'PUBLISHED';
      const applied = await this.store.recordReconcileApplied({
        lease,
        attemptId: prepared.attemptId,
        remoteRef,
        publicationStatus,
        remoteState,
        auditEventId: this.ids.next(),
        now: this.clock.now(),
      });
      return applied
        ? succeeded(
            prepared.execution.publicationId,
            remoteRef,
            prepared.execution.channelPackage.packageChecksum,
            publicationStatus,
            remoteState,
          )
        : { outcome: 'LEASE_LOST' };
    }
    return { outcome: 'TERMINAL_FAILURE', errorCode: 'PUBLICATION_TRANSITION_LIMIT_EXCEEDED' };
  }

  private async recordPreflightFailure(
    lease: JobLease,
    prepared: {
      outcome: 'PUBLISH' | 'RECONCILE';
      attemptId: string;
    },
    errorCode: string,
  ): Promise<PublicationExecutionHandlerOutcome> {
    const recorded = await this.store.recordPreflightFailure({
      lease,
      attemptId: prepared.attemptId,
      operation: prepared.outcome,
      errorCode,
      auditEventId: this.ids.next(),
      now: this.clock.now(),
    });
    return recorded ? { outcome: 'TERMINAL_FAILURE', errorCode } : { outcome: 'LEASE_LOST' };
  }

  private async recordRetryableFailure(
    lease: JobLease,
    prepared: { outcome: 'PUBLISH' | 'RECONCILE'; attemptId: string },
    errorCode: string,
  ): Promise<PublicationExecutionHandlerOutcome> {
    const recorded = await this.store.recordRetryableFailure({
      lease,
      attemptId: prepared.attemptId,
      operation: prepared.outcome,
      errorCode,
      auditEventId: this.ids.next(),
      now: this.clock.now(),
    });
    return recorded ? { outcome: 'RETRYABLE_FAILURE', errorCode } : { outcome: 'LEASE_LOST' };
  }

  private async recordReconcileUnknown(
    lease: JobLease,
    attemptId: string,
    errorCode: string,
  ): Promise<PublicationExecutionHandlerOutcome> {
    const recorded = await this.store.recordReconcileUnknown({
      lease,
      attemptId,
      errorCode,
      auditEventId: this.ids.next(),
      now: this.clock.now(),
    });
    return recorded ? { outcome: 'TERMINAL_FAILURE', errorCode } : { outcome: 'LEASE_LOST' };
  }
}

function succeeded(
  publicationId: string,
  remoteRef: string,
  packageChecksum: string,
  publicationStatus: 'PUBLISHED' | 'REMOTE_APPLIED' = 'PUBLISHED',
  remoteState: PublicationRemoteState | null = null,
): PublicationExecutionHandlerOutcome {
  return {
    outcome: 'SUCCEEDED',
    publicationId,
    publicationStatus,
    remoteRef,
    packageChecksum,
    ...(remoteState === null ? {} : { remoteState }),
  };
}

function validRemoteRef(
  value: string | null,
  secretValue?: string,
  secretReference?: string,
): string | null {
  if (
    value === null ||
    value.length < 1 ||
    value.length > 2_048 ||
    hasControlCharacter(value) ||
    (secretValue !== undefined && secretValue.length > 0 && value.includes(secretValue)) ||
    (secretReference !== undefined && secretReference.length > 0 && value.includes(secretReference))
  ) {
    return null;
  }
  return value;
}

function validReconciliationIntent(
  value: unknown,
  secretValue: string,
  secretReference: string,
): PublicationAdapterReconciliationIntent | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== 2 ||
      !ownKeys.includes('kind') ||
      !ownKeys.includes('remoteRef') ||
      ownKeys.some((key) => typeof key !== 'string')
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const kindDescriptor = descriptors.kind;
    const remoteRefDescriptor = descriptors.remoteRef;
    if (
      kindDescriptor === undefined ||
      !('value' in kindDescriptor) ||
      !kindDescriptor.enumerable ||
      remoteRefDescriptor === undefined ||
      !('value' in remoteRefDescriptor) ||
      !remoteRefDescriptor.enumerable ||
      kindDescriptor.value !== 'COMPENSATE_UNSAFE_CREATE' ||
      typeof remoteRefDescriptor.value !== 'string'
    ) {
      return null;
    }
    const remoteRef = validRemoteRef(remoteRefDescriptor.value, secretValue, secretReference);
    return remoteRef === null
      ? null
      : {
          kind: 'COMPENSATE_UNSAFE_CREATE',
          remoteRef,
        };
  } catch {
    return null;
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function validRemoteState(
  value: unknown,
  expectedPublicationId: string,
  secretValue?: string,
  secretReference?: string,
): PublicationRemoteState | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    const requiredKeys = ['status', 'number', 'isProductionLive', 'rollbackHandle'] as const;
    const allowedKeys = [...requiredKeys, 'receiptEvidence'] as const;
    if (
      (ownKeys.length !== requiredKeys.length && ownKeys.length !== allowedKeys.length) ||
      ownKeys.some(
        (key) =>
          typeof key !== 'string' || !allowedKeys.includes(key as (typeof allowedKeys)[number]),
      )
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      requiredKeys.some((key) => {
        const descriptor = descriptors[key];
        return descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable;
      }) ||
      (ownKeys.length === allowedKeys.length &&
        (descriptors.receiptEvidence === undefined ||
          !('value' in descriptors.receiptEvidence) ||
          !descriptors.receiptEvidence.enumerable))
    ) {
      return null;
    }

    const status = descriptors.status?.value as unknown;
    const number = descriptors.number?.value as unknown;
    const isProductionLive = descriptors.isProductionLive?.value as unknown;
    const rawRollbackHandle = descriptors.rollbackHandle?.value as unknown;
    const rawReceiptEvidence = descriptors.receiptEvidence?.value as unknown;
    if (
      typeof status !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(status) ||
      (number !== null &&
        (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0)) ||
      typeof isProductionLive !== 'boolean'
    ) {
      return null;
    }

    let rollbackHandle: PublicationRemoteState['rollbackHandle'] = null;
    if (rawRollbackHandle !== null) {
      if (
        typeof rawRollbackHandle !== 'object' ||
        Array.isArray(rawRollbackHandle) ||
        (Object.getPrototypeOf(rawRollbackHandle) !== Object.prototype &&
          Object.getPrototypeOf(rawRollbackHandle) !== null)
      ) {
        return null;
      }
      const rollbackKeys = Reflect.ownKeys(rawRollbackHandle);
      if (
        rollbackKeys.length < 1 ||
        rollbackKeys.length > 16 ||
        rollbackKeys.some(
          (key) => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key),
        )
      ) {
        return null;
      }
      const rollbackDescriptors = Object.getOwnPropertyDescriptors(rawRollbackHandle);
      rollbackHandle = {};
      for (const key of rollbackKeys as string[]) {
        const descriptor = rollbackDescriptors[key];
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
          return null;
        }
        const candidate = descriptor.value as unknown;
        if (
          (typeof candidate === 'string' &&
            (candidate.length < 1 || candidate.length > 512 || hasControlCharacter(candidate))) ||
          (typeof candidate === 'number' && (!Number.isSafeInteger(candidate) || candidate < 0)) ||
          (typeof candidate !== 'string' &&
            typeof candidate !== 'number' &&
            typeof candidate !== 'boolean')
        ) {
          return null;
        }
        rollbackHandle[key] = candidate;
      }
    }

    let receiptEvidence: NonNullable<PublicationRemoteState['receiptEvidence']> | undefined;
    if (rawReceiptEvidence !== undefined) {
      const parsedReceiptEvidence = validReceiptEvidence(rawReceiptEvidence);
      if (parsedReceiptEvidence === null) return null;
      receiptEvidence = parsedReceiptEvidence;
      if (
        status !== 'DELIVERED' ||
        number !== null ||
        isProductionLive ||
        rollbackHandle !== null ||
        receiptEvidence.deliveryId !== expectedPublicationId
      ) {
        return null;
      }
    }

    const remoteState: PublicationRemoteState = {
      status,
      number,
      isProductionLive,
      rollbackHandle,
      ...(receiptEvidence === undefined ? {} : { receiptEvidence }),
    };
    const serialized = JSON.stringify(remoteState);
    if (
      new TextEncoder().encode(serialized).byteLength > 4_096 ||
      (secretValue !== undefined && secretValue.length > 0 && serialized.includes(secretValue)) ||
      (secretReference !== undefined &&
        secretReference.length > 0 &&
        serialized.includes(secretReference))
    ) {
      return null;
    }
    return remoteState;
  } catch {
    return null;
  }
}

function validReceiptEvidence(
  value: unknown,
): NonNullable<PublicationRemoteState['receiptEvidence']> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const allowedKeys = [
    'schemaVersion',
    'receiptId',
    'deliveryId',
    'receiverEffectId',
    'requestBodySha256',
    'verifiedKeyId',
    'verifiedAlgorithm',
    'receivedAt',
  ] as const;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== allowedKeys.length ||
    ownKeys.some(
      (key) =>
        typeof key !== 'string' || !allowedKeys.includes(key as (typeof allowedKeys)[number]),
    )
  ) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    allowedKeys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable;
    })
  ) {
    return null;
  }
  const candidate = Object.fromEntries(
    allowedKeys.map((key) => [key, descriptors[key]?.value as unknown]),
  ) as Record<(typeof allowedKeys)[number], unknown>;
  if (
    candidate.schemaVersion !== 'signed-webhook-receipt-evidence.v1' ||
    !validBoundedReceiptText(candidate.receiptId, 500) ||
    typeof candidate.deliveryId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      candidate.deliveryId,
    ) ||
    !validBoundedReceiptText(candidate.receiverEffectId, 500) ||
    typeof candidate.requestBodySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(candidate.requestBodySha256) ||
    typeof candidate.verifiedKeyId !== 'string' ||
    candidate.verifiedKeyId.length > 120 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(candidate.verifiedKeyId) ||
    (candidate.verifiedAlgorithm !== 'HMAC_SHA256' && candidate.verifiedAlgorithm !== 'ED25519') ||
    typeof candidate.receivedAt !== 'string' ||
    candidate.receivedAt.length > 35 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      candidate.receivedAt,
    ) ||
    !Number.isFinite(Date.parse(candidate.receivedAt))
  ) {
    return null;
  }
  return {
    schemaVersion: candidate.schemaVersion,
    receiptId: candidate.receiptId,
    deliveryId: candidate.deliveryId,
    receiverEffectId: candidate.receiverEffectId,
    requestBodySha256: candidate.requestBodySha256,
    verifiedKeyId: candidate.verifiedKeyId,
    verifiedAlgorithm: candidate.verifiedAlgorithm,
    receivedAt: candidate.receivedAt,
  };
}

function validBoundedReceiptText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maxLength &&
    !hasControlCharacter(value)
  );
}
