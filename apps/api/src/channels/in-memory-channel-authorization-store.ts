import { createHash } from 'node:crypto';

import type {
  ChannelAuthorizationStore,
  ChannelAuthorizationSecretReferenceStore,
  ChannelAuthorizationValidationCommandStore,
  ChannelAuthorizationValidationLease,
} from '@aeostudio/application/channels-publishing';
import type {
  ChannelAuthorizationEligibility,
  ChannelAuthorizationMetadata,
} from '@aeostudio/domain/channels-publishing';

import type { InMemoryAuditSink } from '../privacy/in-memory-audit-sink.js';

interface StoredAuthorization extends ChannelAuthorizationEligibility {
  validationCredentialFingerprint: string | null;
  secretArn: string | null;
  secretArnHash: string | null;
  adapterKey: string;
  adapterVersion: string;
  channelDefinitionId: string;
}

interface StoredValidationCommand {
  id: string;
  authorizationId: string;
  status: 'PENDING' | 'LEASED' | 'COMPLETED';
  workerId: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
}

interface ConfigurableSecretStore {
  configure(input: { tenantId: string; secretReference: string; value: string }): Promise<unknown>;
}

export interface InMemoryChannelAuthorizationStoreOptions {
  secrets: ConfigurableSecretStore;
  secretValueForReference(secretReference: string): string;
  validation?: {
    mode: 'DETERMINISTIC_FAKE';
    nodeEnv: 'test';
    allowFakeRuntime: true;
    validForMs?: number;
  };
}

/** Test/dev metadata store. Credential values are deliberately outside this store. */
export class InMemoryChannelAuthorizationStore
  implements
    ChannelAuthorizationStore,
    ChannelAuthorizationSecretReferenceStore,
    ChannelAuthorizationValidationCommandStore
{
  private readonly configuredSecretReferences = new Set<string>();
  private readonly records = new Map<string, StoredAuthorization>();
  private readonly validationCommands = new Map<string, StoredValidationCommand>();

  public constructor(
    private readonly options?: InMemoryChannelAuthorizationStoreOptions,
    private readonly audit?: InMemoryAuditSink,
  ) {}

  async create(input: Parameters<ChannelAuthorizationStore['create']>[0]) {
    if (this.options !== undefined && !this.configuredSecretReferences.has(input.secretArn)) {
      await this.options.secrets.configure({
        tenantId: input.context.tenantId,
        secretReference: input.secretArn,
        value: this.options.secretValueForReference(input.secretArn),
      });
      this.configuredSecretReferences.add(input.secretArn);
    }
    const record: StoredAuthorization = {
      id: input.authorizationId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      adapterVersionId: input.adapterVersionId,
      status: 'ACTIVE',
      secretArn: input.secretArn,
      secretArnHash: null,
      grantedScopes: [...input.grantedScopes],
      acceptedTermsVersion: input.acceptedTermsVersion,
      target: input.target,
      expiresAt: input.expiresAt?.toISOString() ?? null,
      validationStatus: 'PENDING_VALIDATION',
      validationSnapshot: null,
      validationCredentialFingerprint: null,
      validationFailureCode: null,
      createdByUserId: input.context.actorUserId,
      createdAt: input.createdAt.toISOString(),
      updatedAt: input.createdAt.toISOString(),
      adapterKey: input.adapterKey ?? 'UNRESOLVED',
      adapterVersion: input.adapterVersion ?? 'UNRESOLVED',
      channelDefinitionId: input.channelDefinitionId ?? '00000000-0000-0000-0000-000000000000',
    };
    this.records.set(record.id, record);
    this.validationCommands.set(record.id, {
      id: record.id,
      authorizationId: record.id,
      status: 'PENDING',
      workerId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      createdAt: record.createdAt,
    });
    if (this.options?.validation?.mode === 'DETERMINISTIC_FAKE') {
      const validForMs = this.options.validation.validForMs ?? 60 * 60 * 1_000;
      const requestedValidUntil = new Date(input.createdAt.getTime() + validForMs);
      const validUntil =
        input.expiresAt !== null && input.expiresAt.getTime() < requestedValidUntil.getTime()
          ? input.expiresAt
          : requestedValidUntil;
      const credential = this.options.secretValueForReference(input.secretArn);
      record.validationStatus = 'VERIFIED';
      record.validationSnapshot = {
        actualTarget: record.target,
        actualScopes: [...record.grantedScopes],
        acceptedTermsVersion: record.acceptedTermsVersion,
        validatedAt: record.createdAt,
        validUntil: validUntil.toISOString(),
      };
      record.validationCredentialFingerprint = createHash('sha256')
        .update(credential)
        .digest('hex');
      this.validationCommands.get(record.id)!.status = 'COMPLETED';
    }
    this.audit?.append({
      id: input.auditEventId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      actorId: input.context.actorUserId,
      action: 'CHANNEL_AUTHORIZATION_CREATED',
      resourceType: 'CHANNEL_AUTHORIZATION',
      resourceId: record.id,
      outcome: 'SUCCEEDED',
      metadata: {
        adapterVersionId: record.adapterVersionId,
        acceptedTermsVersion: record.acceptedTermsVersion,
        expiresAt: record.expiresAt,
        grantedScopeCount: record.grantedScopes.length,
      },
      occurredAt: input.createdAt,
    });
    return this.toMetadata(record);
  }

  revoke(input: Parameters<ChannelAuthorizationStore['revoke']>[0]) {
    const record = this.records.get(input.authorizationId);
    if (
      record === undefined ||
      record.tenantId !== input.context.tenantId ||
      record.workspaceId !== input.context.workspaceId
    ) {
      return Promise.resolve(null);
    }
    const changed = record.status === 'ACTIVE';
    if (changed) {
      record.status = 'REVOKED';
      record.validationStatus = 'INVALID';
      record.validationSnapshot = null;
      record.validationCredentialFingerprint = null;
      record.validationFailureCode = 'AUTHORIZATION_REVOKED';
      record.updatedAt = input.revokedAt.toISOString();
      const command = this.validationCommands.get(record.id);
      if (command !== undefined) command.status = 'COMPLETED';
      this.audit?.append({
        id: input.auditEventId,
        tenantId: input.context.tenantId,
        workspaceId: input.context.workspaceId,
        actorId: input.context.actorUserId,
        action: 'CHANNEL_AUTHORIZATION_REVOKED',
        resourceType: 'CHANNEL_AUTHORIZATION',
        resourceId: record.id,
        outcome: 'SUCCEEDED',
        metadata: { adapterVersionId: record.adapterVersionId },
        occurredAt: input.revokedAt,
      });
    }
    return Promise.resolve(this.toMetadata(record));
  }

  list(input: Parameters<ChannelAuthorizationStore['list']>[0]) {
    return Promise.resolve(
      [...this.records.values()]
        .filter(
          (record) =>
            record.tenantId === input.context.tenantId &&
            record.workspaceId === input.context.workspaceId,
        )
        .map((record) => this.toMetadata(record)),
    );
  }

  findForTarget(input: Parameters<ChannelAuthorizationStore['findForTarget']>[0]) {
    const record = [...this.records.values()]
      .filter(
        (candidate) =>
          candidate.tenantId === input.context.tenantId &&
          candidate.workspaceId === input.context.workspaceId &&
          candidate.adapterVersionId === input.adapterVersionId &&
          candidate.target === input.target,
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )[0];
    return Promise.resolve(record === undefined ? null : this.toEligibility(record));
  }

  findSecretArn(input: Parameters<ChannelAuthorizationSecretReferenceStore['findSecretArn']>[0]) {
    const record = this.records.get(input.authorizationId);
    return Promise.resolve(
      record !== undefined &&
        record.tenantId === input.context.tenantId &&
        record.workspaceId === input.context.workspaceId &&
        record.status === 'ACTIVE'
        ? record.secretArn
        : null,
    );
  }

  /** Fake-runtime-only credential material; never returned from API eligibility or metadata. */
  findCredentialFingerprint(input: {
    context: Parameters<ChannelAuthorizationSecretReferenceStore['findSecretArn']>[0]['context'];
    authorizationId: string;
  }): Promise<string | null> {
    const record = this.records.get(input.authorizationId);
    return Promise.resolve(
      record !== undefined &&
        record.tenantId === input.context.tenantId &&
        record.workspaceId === input.context.workspaceId &&
        record.status === 'ACTIVE' &&
        record.validationStatus === 'VERIFIED'
        ? record.validationCredentialFingerprint
        : null,
    );
  }

  /** Fake-runtime atomic effect boundary; credential plaintext remains in the secret store. */
  findPublicationAuthorizationNow(input: {
    context: Parameters<ChannelAuthorizationSecretReferenceStore['findSecretArn']>[0]['context'];
    authorizationId: string;
    adapterVersionId: string;
    target: string;
  }): {
    authorization: ChannelAuthorizationEligibility;
    secretReference: string | null;
    credentialFingerprint: string | null;
  } | null {
    const record = this.records.get(input.authorizationId);
    if (
      record === undefined ||
      record.tenantId !== input.context.tenantId ||
      record.workspaceId !== input.context.workspaceId ||
      record.adapterVersionId !== input.adapterVersionId ||
      record.target !== input.target
    ) {
      return null;
    }
    return {
      authorization: this.toEligibility(record),
      secretReference: record.secretArn,
      credentialFingerprint: record.validationCredentialFingerprint,
    };
  }

  claimNext(
    input: Parameters<ChannelAuthorizationValidationCommandStore['claimNext']>[0],
  ): Promise<ChannelAuthorizationValidationLease | null> {
    const command = [...this.validationCommands.values()]
      .filter(
        (candidate) =>
          candidate.status === 'PENDING' ||
          (candidate.status === 'LEASED' &&
            candidate.leaseExpiresAt !== null &&
            new Date(candidate.leaseExpiresAt).getTime() <= input.now.getTime()),
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )[0];
    if (command === undefined) return Promise.resolve(null);
    const authorization = this.records.get(command.authorizationId);
    if (
      authorization === undefined ||
      authorization.secretArn === null ||
      authorization.status !== 'ACTIVE' ||
      authorization.validationStatus !== 'PENDING_VALIDATION'
    ) {
      command.status = 'COMPLETED';
      return this.claimNext(input);
    }
    command.status = 'LEASED';
    command.workerId = input.workerId;
    command.leaseToken = input.leaseToken;
    command.leaseExpiresAt = input.leaseUntil.toISOString();
    return Promise.resolve({
      commandId: command.id,
      tenantId: authorization.tenantId,
      workspaceId: authorization.workspaceId,
      authorizationId: authorization.id,
      channelDefinitionId: authorization.channelDefinitionId,
      adapterVersionId: authorization.adapterVersionId,
      adapterKey: authorization.adapterKey,
      adapterVersion: authorization.adapterVersion,
      target: authorization.target,
      requestedScopes: [...authorization.grantedScopes],
      acceptedTermsVersion: authorization.acceptedTermsVersion,
      secretReference: authorization.secretArn,
      authorizationExpiresAt: authorization.expiresAt,
      workerId: input.workerId,
      leaseToken: input.leaseToken,
      leaseExpiresAt: input.leaseUntil.toISOString(),
    });
  }

  completeVerified(
    input: Parameters<ChannelAuthorizationValidationCommandStore['completeVerified']>[0],
  ): Promise<boolean> {
    const resolved = this.resolveLeased(input.lease, input.validatedAt);
    if (resolved === null) return Promise.resolve(false);
    if (
      input.actualTarget.length < 1 ||
      input.actualTarget.length > 2_048 ||
      input.actualScopes.length > 100 ||
      input.actualScopes.some((scope) => scope.trim().length < 1 || scope.length > 160) ||
      new Set(input.actualScopes).size !== input.actualScopes.length ||
      !/^[a-f0-9]{64}$/u.test(input.credentialFingerprint) ||
      input.validUntil.getTime() <= input.validatedAt.getTime()
    ) {
      return Promise.resolve(false);
    }
    const { authorization, command } = resolved;
    authorization.validationStatus = 'VERIFIED';
    authorization.validationSnapshot = {
      actualTarget: input.actualTarget,
      actualScopes: [...input.actualScopes],
      acceptedTermsVersion: input.acceptedTermsVersion,
      validatedAt: input.validatedAt.toISOString(),
      validUntil: input.validUntil.toISOString(),
    };
    authorization.validationCredentialFingerprint = input.credentialFingerprint;
    authorization.validationFailureCode = null;
    authorization.updatedAt = input.validatedAt.toISOString();
    command.status = 'COMPLETED';
    return Promise.resolve(true);
  }

  completeInvalid(
    input: Parameters<ChannelAuthorizationValidationCommandStore['completeInvalid']>[0],
  ): Promise<boolean> {
    const resolved = this.resolveLeased(input.lease, input.validatedAt);
    if (
      resolved === null ||
      input.failureCode.trim().length < 1 ||
      input.failureCode.length > 120
    ) {
      return Promise.resolve(false);
    }
    resolved.authorization.validationStatus = 'INVALID';
    resolved.authorization.validationSnapshot = null;
    resolved.authorization.validationCredentialFingerprint = null;
    resolved.authorization.validationFailureCode = input.failureCode;
    resolved.authorization.updatedAt = input.validatedAt.toISOString();
    resolved.command.status = 'COMPLETED';
    return Promise.resolve(true);
  }

  revokeTenant(
    tenantId: string,
    revokedAt: Date,
  ): Array<{
    authorizationId: string;
    secretArn: string;
  }> {
    return this.revokeScope(tenantId, null, revokedAt);
  }

  revokeWorkspace(
    tenantId: string,
    workspaceId: string,
    revokedAt: Date,
  ): Array<{
    authorizationId: string;
    secretArn: string;
  }> {
    return this.revokeScope(tenantId, workspaceId, revokedAt);
  }

  private revokeScope(
    tenantId: string,
    workspaceId: string | null,
    revokedAt: Date,
  ): Array<{
    authorizationId: string;
    secretArn: string;
  }> {
    const revoked: Array<{ authorizationId: string; secretArn: string }> = [];
    for (const record of this.records.values()) {
      if (
        record.tenantId !== tenantId ||
        (workspaceId !== null && record.workspaceId !== workspaceId)
      ) {
        continue;
      }
      if (record.status === 'ACTIVE') {
        record.status = 'REVOKED';
        record.validationStatus = 'INVALID';
        record.validationSnapshot = null;
        record.validationCredentialFingerprint = null;
        record.validationFailureCode = 'AUTHORIZATION_REVOKED';
        record.updatedAt = revokedAt.toISOString();
      }
      const command = this.validationCommands.get(record.id);
      if (command !== undefined) command.status = 'COMPLETED';
      if (record.secretArn !== null) {
        const secretArn = record.secretArn;
        record.secretArnHash = createHash('sha256').update(secretArn).digest('hex');
        record.secretArn = null;
        this.configuredSecretReferences.delete(secretArn);
        revoked.push({ authorizationId: record.id, secretArn });
      }
    }
    return revoked.sort((left, right) => left.authorizationId.localeCompare(right.authorizationId));
  }

  private toMetadata(record: StoredAuthorization): ChannelAuthorizationMetadata {
    const eligibility = this.toEligibility(record);
    const snapshot = eligibility.validationSnapshot;
    return {
      ...eligibility,
      validationSnapshot:
        snapshot === null
          ? null
          : {
              actualTarget: snapshot.actualTarget,
              actualScopes: snapshot.actualScopes,
              acceptedTermsVersion: snapshot.acceptedTermsVersion,
              validatedAt: snapshot.validatedAt,
              validUntil: snapshot.validUntil,
            },
      secretConfigured: true,
    };
  }

  private toEligibility(record: StoredAuthorization): ChannelAuthorizationEligibility {
    return structuredClone({
      id: record.id,
      tenantId: record.tenantId,
      workspaceId: record.workspaceId,
      adapterVersionId: record.adapterVersionId,
      status: record.status,
      grantedScopes: record.grantedScopes,
      acceptedTermsVersion: record.acceptedTermsVersion,
      target: record.target,
      expiresAt: record.expiresAt,
      validationStatus: record.validationStatus,
      validationSnapshot: record.validationSnapshot,
      validationFailureCode: record.validationFailureCode,
      createdByUserId: record.createdByUserId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  private resolveLeased(
    lease: ChannelAuthorizationValidationLease,
    completedAt: Date,
  ): { authorization: StoredAuthorization; command: StoredValidationCommand } | null {
    const command = this.validationCommands.get(lease.commandId);
    const authorization = this.records.get(lease.authorizationId);
    if (
      command === undefined ||
      authorization === undefined ||
      command.authorizationId !== lease.authorizationId ||
      command.status !== 'LEASED' ||
      command.workerId !== lease.workerId ||
      command.leaseToken !== lease.leaseToken ||
      command.leaseExpiresAt !== lease.leaseExpiresAt ||
      new Date(lease.leaseExpiresAt).getTime() <= completedAt.getTime() ||
      authorization.tenantId !== lease.tenantId ||
      authorization.workspaceId !== lease.workspaceId ||
      authorization.adapterVersionId !== lease.adapterVersionId ||
      authorization.target !== lease.target ||
      authorization.status !== 'ACTIVE' ||
      authorization.validationStatus !== 'PENDING_VALIDATION'
    ) {
      return null;
    }
    return { authorization, command };
  }
}
