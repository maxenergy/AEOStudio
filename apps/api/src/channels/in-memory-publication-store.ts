import { createHash } from 'node:crypto';

import type {
  ChannelAuthorizationSecretReferenceStore,
  ChannelAuthorizationStore,
  ChannelPackageStore,
  ChannelRegistryStore,
  PublicationAdapter,
  PublicationAdapterCommand,
  PublicationCommandStore,
  PublicationQueryStore,
  PublicationRemoteStatusRefreshStore,
} from '@aeostudio/application/channels-publishing';
import type { ArtifactStore } from '@aeostudio/application/artifacts';
import type {
  ActivePublicationJobAccess,
  ActivePublicationPackageReader,
  ActivePublicationSecretReader,
} from '@aeostudio/application/tenant-data-access';
import {
  publicationAuthorizationFailureCode,
  providerApiVersionIsExpired,
  resolvePublicationAdapterGovernance,
  validatePublicationAdapterRuntime,
  verifyChannelPackagePayload,
} from '@aeostudio/application/channels-publishing';
import { PublicationRemoteStateSchema } from '@aeostudio/contracts/channels';
import type {
  ChannelAdapterVersion,
  ChannelAuthorizationEligibility,
  ChannelPackagePayload,
  ChannelRegistryEntry,
  PublicationAttemptOutcome,
  PublicationAttemptRecord,
  PublicationRecord,
  PublicationRemoteState,
} from '@aeostudio/domain/channels-publishing';
import type { ArtifactLedgerBundle } from '@aeostudio/domain/artifacts';
import { roleAllows } from '@aeostudio/domain/identity-access';
import type { JobRecord } from '@aeostudio/domain/jobs-budgets';
import type { JsonValue, TenantExportSourceObject } from '@aeostudio/application/privacy-audit';

import type {
  InMemoryJobBudgetStore,
  InMemoryPublicationJobCompletion,
} from '../jobs/in-memory-job-budget-store.js';
import type { InMemoryAuditSink } from '../privacy/in-memory-audit-sink.js';
import type { InMemoryTenantExportSource } from '../privacy/in-memory-tenant-export-source.js';

interface PublicationState {
  actorSubject: string;
  context: Parameters<PublicationCommandStore['submit']>[0]['context'];
  publication: PublicationRecord;
  authorizationTarget: string;
  requiredScopesSnapshot: string[];
  attempts: PublicationAttemptRecord[];
  pendingOperation: 'PUBLISH' | 'RECONCILE';
}

export interface InMemoryPublishedExperimentIntervention {
  publication: PublicationRecord;
  publicationAttemptId: string;
  appliedAt: string;
}

type PublicationSubmitResult = Awaited<ReturnType<PublicationCommandStore['submit']>>;
type FinalLifecycleEffectResult<T> =
  | { outcome: 'GATE_STALE' }
  | { outcome: 'EFFECT_COMPLETED'; value: T }
  | { outcome: 'EFFECT_FAILED' };

interface AtomicEffectInput<T> {
  validate(): boolean;
  effect(): Promise<T>;
}

type AtomicEffectStart<T> =
  | { outcome: 'GATE_STALE' }
  | { outcome: 'EFFECT_STARTED'; promise: Promise<T> }
  | { outcome: 'EFFECT_FAILED' };

export interface InMemoryAtomicEffectRunner {
  run<T>(input: AtomicEffectInput<T>): AtomicEffectStart<T>;
}

export interface InMemoryPublicationLiveEffectState {
  resolveTenantContext(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): PublicationState['context'] | null;
  isCurrentApprovedArtifact(input: {
    tenantId: string;
    workspaceId: string;
    artifactId: string;
    artifactRevisionId: string;
    revision: number;
    contentHash: string;
  }): boolean;
  isCurrentApprovedLineage(input: {
    context: PublicationState['context'];
    tenantId: string;
    workspaceId: string;
    artifactId: string;
    artifactRevisionId: string;
    revision: number;
    contentHash: string;
  }): boolean;
  listRegistryEntries(input: { context: PublicationState['context'] }): ChannelRegistryEntry[];
  findAuthorization(input: {
    context: PublicationState['context'];
    authorizationId: string;
    adapterVersionId: string;
    target: string;
  }): {
    authorization: ChannelAuthorizationEligibility;
    secretReference: string | null;
    credentialFingerprint: string | null;
  } | null;
  secretValueMatches(input: {
    tenantId: string;
    secretReference: string;
    secretValue: string;
  }): boolean;
}

/**
 * Fake-runtime linearization primitive. Validation and effect invocation happen in one
 * synchronous JavaScript stack; callers await only after the external effect has started.
 */
export const IN_MEMORY_ATOMIC_EFFECT_RUNNER: InMemoryAtomicEffectRunner = {
  run<T>(input: AtomicEffectInput<T>): AtomicEffectStart<T> {
    try {
      if (!input.validate()) return { outcome: 'GATE_STALE' };
    } catch {
      return { outcome: 'GATE_STALE' };
    }
    try {
      return { outcome: 'EFFECT_STARTED', promise: input.effect() };
    } catch {
      return { outcome: 'EFFECT_FAILED' };
    }
  },
};

interface InMemoryPublicationStoreOptions {
  jobs: InMemoryJobBudgetStore;
  packages: ChannelPackageStore;
  artifacts: ArtifactStore;
  publicationPackages: ActivePublicationPackageReader;
  publicationSecrets: ActivePublicationSecretReader;
  registry: ChannelRegistryStore;
  authorizations: ChannelAuthorizationStore &
    ChannelAuthorizationSecretReferenceStore & {
      findCredentialFingerprint(input: {
        context: PublicationState['context'];
        authorizationId: string;
      }): Promise<string | null>;
    };
  adapters: {
    resolve(adapterKey: string, adapterVersion: string): PublicationAdapter | null;
  };
  ids: { next(): string };
  clock: { now(): Date };
  tenancy: {
    resolveTenantContext(input: {
      actorSubject: string;
      tenantId: string;
      workspaceId: string;
    }): Promise<PublicationState['context'] | null>;
  };
  /**
   * Required for effects, optional only so read/query-only test composition can construct the
   * store. Missing runners fail closed and never invoke an Adapter.
   */
  atomicEffectRunner?: InMemoryAtomicEffectRunner;
  liveEffectState?: InMemoryPublicationLiveEffectState;
  audit?: InMemoryAuditSink;
}

export class InMemoryPublicationStore
  implements
    PublicationCommandStore,
    PublicationQueryStore,
    PublicationRemoteStatusRefreshStore,
    InMemoryTenantExportSource
{
  private readonly states = new Map<string, PublicationState>();
  private readonly submissions = new Map<string, Promise<PublicationSubmitResult>>();

  constructor(private readonly options: InMemoryPublicationStoreOptions) {
    options.jobs.registerPublicationProcessor((job) => this.process(job));
  }

  findExisting(input: Parameters<PublicationCommandStore['findExisting']>[0]) {
    const state = this.findByIdempotencyKey(
      input.context.tenantId,
      input.context.workspaceId,
      input.idempotencyKey,
    );
    if (state === undefined) return Promise.resolve({ outcome: 'NOT_FOUND' as const });
    if (state.publication.requestHash !== input.requestHash) {
      return Promise.resolve({ outcome: 'IDEMPOTENCY_CONFLICT' as const });
    }
    const job = this.boundJob(state);
    if (job === null) throw new Error('IN_MEMORY_PUBLICATION_JOB_NOT_FOUND');
    return Promise.resolve({
      outcome: 'SUCCEEDED' as const,
      publication: structuredClone(state.publication),
      job,
      created: false as const,
    });
  }

  submit(
    input: Parameters<PublicationCommandStore['submit']>[0],
  ): Promise<PublicationSubmitResult> {
    const key = `${input.context.tenantId}:${input.context.workspaceId}:${input.idempotencyKey}`;
    const active = this.submissions.get(key);
    if (active !== undefined) {
      return active.then(() => this.submitOnce(input));
    }
    const pending = this.submitOnce(input);
    this.submissions.set(key, pending);
    return pending.finally(() => {
      if (this.submissions.get(key) === pending) this.submissions.delete(key);
    });
  }

  private async submitOnce(
    input: Parameters<PublicationCommandStore['submit']>[0],
  ): Promise<PublicationSubmitResult> {
    const prior = this.findByIdempotencyKey(
      input.context.tenantId,
      input.context.workspaceId,
      input.idempotencyKey,
    );
    if (prior !== undefined) {
      if (prior.publication.requestHash !== input.requestHash) {
        return { outcome: 'IDEMPOTENCY_CONFLICT' as const };
      }
      const job = this.boundJob(prior);
      if (job === null) throw new Error('IN_MEMORY_PUBLICATION_JOB_NOT_FOUND');
      return {
        outcome: 'SUCCEEDED' as const,
        publication: structuredClone(prior.publication),
        job,
        created: false,
      };
    }

    const currentBundle = await this.options.artifacts.findBundle({
      context: input.context,
      artifactId: input.channelPackage.artifact.artifactId,
      effectiveAt: this.options.clock.now(),
    });
    if (
      !packageMatchesCurrentApprovedArtifact(currentBundle, input.context, input.channelPackage)
    ) {
      return { outcome: 'APPROVAL_STALE' as const };
    }

    const job = await this.options.jobs.submitJob({
      context: input.context,
      jobId: input.jobId,
      jobType: 'PUBLICATION',
      aggregateId: input.publicationId,
      idempotencyKey: `publication-job:${input.jobId}`,
      estimatedUnits: input.estimatedUnits,
      reservationId: input.reservationId,
      budgetAlertId: input.budgetAlertId,
      outboxMessageId: input.outboxMessageId,
      auditEventId: input.jobAuditEventId,
      ...(input.traceContext === undefined ? {} : { traceContext: input.traceContext }),
    });
    if (job === null) return { outcome: 'NOT_FOUND' as const };
    const createdAt = input.createdAt.toISOString();
    const publication: PublicationRecord = {
      id: input.publicationId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      channelPackageId: input.channelPackage.id,
      packageChecksum: input.channelPackage.packageChecksum,
      artifactRevisionId: input.channelPackage.artifact.artifactRevisionId,
      artifactContentHash: input.channelPackage.artifact.contentHash,
      adapterVersionId: input.adapterVersionId,
      channelAuthorizationId: input.channelAuthorization.id,
      target: input.target,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      status: job.status === 'BUDGET_BLOCKED' ? 'BUDGET_BLOCKED' : 'QUEUED',
      jobId: job.id,
      remoteRef: null,
      remoteState: null,
      requestedByUserId: input.context.actorUserId,
      createdAt,
      updatedAt: createdAt,
    };
    this.states.set(publication.id, {
      actorSubject: input.actorSubject,
      context: structuredClone(input.context),
      publication,
      authorizationTarget: input.channelAuthorization.target,
      requiredScopesSnapshot: [...input.requiredScopes],
      attempts: [],
      pendingOperation: 'PUBLISH',
    });
    this.packageSnapshots.set(publication.id, structuredClone(input.channelPackage));
    this.options.audit?.append({
      id: input.auditEventId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      actorId: input.context.actorUserId,
      action: 'PUBLICATION_REQUESTED',
      resourceType: 'PUBLICATION',
      resourceId: publication.id,
      outcome: publication.status,
      metadata: {
        adapterVersionId: publication.adapterVersionId,
        artifactContentHash: publication.artifactContentHash,
        artifactRevisionId: publication.artifactRevisionId,
        channelAuthorizationId: publication.channelAuthorizationId,
        channelPackageId: publication.channelPackageId,
        jobId: publication.jobId,
        packageChecksum: publication.packageChecksum,
      },
      occurredAt: input.createdAt,
    });
    return {
      outcome: 'SUCCEEDED' as const,
      publication: structuredClone(publication),
      job,
      created: true,
    };
  }

  async findDetail(input: Parameters<PublicationQueryStore['findDetail']>[0]) {
    const state = this.states.get(input.publicationId);
    if (
      state === undefined ||
      state.publication.tenantId !== input.context.tenantId ||
      state.publication.workspaceId !== input.context.workspaceId
    ) {
      return null;
    }
    if (state.publication.jobId === null) return null;
    // In the explicit browser fake, polling the read model is the deterministic queue driver.
    // Production uses SQS/Worker composition; no default runtime relies on this behavior.
    const job = await this.options.jobs.findJob({
      context: state.context,
      jobId: state.publication.jobId,
    });
    if (job === null) return null;
    return {
      publication: structuredClone(state.publication),
      attempts: structuredClone(state.attempts),
      job,
    };
  }

  async refresh(
    input: Parameters<PublicationRemoteStatusRefreshStore['refresh']>[0],
  ): ReturnType<PublicationRemoteStatusRefreshStore['refresh']> {
    const state = this.states.get(input.publicationId);
    if (
      state === undefined ||
      state.publication.tenantId !== input.context.tenantId ||
      state.publication.workspaceId !== input.context.workspaceId
    ) {
      return { outcome: 'NOT_FOUND' };
    }
    const priorRemoteRef = state.publication.remoteRef;
    const priorRemoteState = safeGitPullRequestRemoteState(state.publication.remoteState);
    if (
      state.publication.status !== 'REMOTE_APPLIED' ||
      priorRemoteRef === null ||
      priorRemoteState === null
    ) {
      return { outcome: 'INVALID_STATE' };
    }

    const currentContext = await this.options.tenancy.resolveTenantContext({
      actorSubject: input.actorSubject,
      tenantId: state.publication.tenantId,
      workspaceId: state.publication.workspaceId,
    });
    if (
      currentContext === null ||
      currentContext.actorUserId !== input.context.actorUserId ||
      currentContext.tenantId !== input.context.tenantId ||
      currentContext.workspaceId !== input.context.workspaceId ||
      !roleAllows(currentContext.role, 'PUBLISH')
    ) {
      return { outcome: 'GATE_REJECTED' };
    }

    const publicationJobId = state.publication.jobId;
    if (publicationJobId === null) {
      return { outcome: 'GATE_REJECTED' };
    }
    const boundPackage = await this.loadBoundPackage(state, currentContext, {
      publicationId: state.publication.id,
      leaseToken: publicationJobId,
    });
    if (boundPackage === null) {
      return { outcome: 'GATE_REJECTED' };
    }
    const { packageRecord, payload } = boundPackage;
    const channel = (await this.options.registry.listEntries({ context: currentContext })).find(
      (candidate) =>
        candidate.id === packageRecord.channel.definitionId &&
        candidate.channelKey === packageRecord.channel.channelKey,
    );
    const adapterMetadata = channel?.adapterVersions.find(
      (candidate) => candidate.id === state.publication.adapterVersionId,
    );
    if (
      channel?.status !== 'AVAILABLE' ||
      adapterMetadata === undefined ||
      !adapterMetadata.enabled ||
      providerApiVersionIsExpired(
        adapterMetadata.providerApiSupportedUntil,
        this.options.clock.now(),
      ) ||
      !adapterMetadata.capabilities.includes('PULL_REQUEST_STATUS') ||
      adapterMetadata.termsStatus !== 'ALLOWED'
    ) {
      return { outcome: 'GATE_REJECTED' };
    }
    const adapter = this.options.adapters.resolve(
      adapterMetadata.adapterKey,
      adapterMetadata.adapterVersion,
    );
    if (adapter === null || adapter.refreshRemoteStatus === undefined) {
      return { outcome: 'ADAPTER_UNAVAILABLE' };
    }
    if (validatePublicationAdapterRuntime(adapter, adapterMetadata) !== null) {
      return { outcome: 'ADAPTER_UNAVAILABLE' };
    }
    const authorization = await this.options.authorizations.findForTarget({
      context: currentContext,
      adapterVersionId: state.publication.adapterVersionId,
      target: state.authorizationTarget,
    });
    const governance = resolvePublicationAdapterGovernance(
      adapter,
      adapterMetadata.requiredScopes,
      {
        target: state.publication.target,
        channelPackage: packageRecord,
      },
    );
    if (
      governance === null ||
      governance.authorizationTarget !== state.authorizationTarget ||
      !sameRequiredScopeSet(governance.requiredScopes, state.requiredScopesSnapshot) ||
      authorization === null ||
      authorization.status !== 'ACTIVE' ||
      (authorization.expiresAt !== null &&
        new Date(authorization.expiresAt).getTime() <= this.options.clock.now().getTime()) ||
      authorization.acceptedTermsVersion !== adapterMetadata.termsVersion ||
      authorization.validationStatus !== 'VERIFIED' ||
      authorization.validationSnapshot === null ||
      authorization.validationSnapshot.actualTarget !== state.authorizationTarget ||
      authorization.validationSnapshot.acceptedTermsVersion !== adapterMetadata.termsVersion ||
      new Date(authorization.validationSnapshot.validUntil).getTime() <=
        this.options.clock.now().getTime() ||
      governance.requiredScopes.some(
        (scope) => !authorization.validationSnapshot!.actualScopes.includes(scope),
      )
    ) {
      return { outcome: 'GATE_REJECTED' };
    }
    const secretReference = await this.options.authorizations.findSecretArn({
      context: currentContext,
      authorizationId: authorization.id,
    });
    if (secretReference === null || secretReference.length === 0) {
      return { outcome: 'GATE_REJECTED' };
    }
    const credentialFingerprint = await this.options.authorizations.findCredentialFingerprint({
      context: currentContext,
      authorizationId: authorization.id,
    });
    let secretValue: string;
    try {
      secretValue = await this.options.publicationSecrets.readPublicationSecret({
        access: {
          publicationId: state.publication.id,
          leaseToken: publicationJobId,
        },
        expected: {
          secretReference,
          tenantId: state.publication.tenantId,
          workspaceId: state.publication.workspaceId,
        },
      });
    } catch {
      return { outcome: 'GATE_REJECTED' };
    }
    if (
      secretValue.length === 0 ||
      credentialFingerprint === null ||
      createHash('sha256').update(secretValue).digest('hex') !== credentialFingerprint
    ) {
      return { outcome: 'GATE_REJECTED' };
    }
    const command: PublicationAdapterCommand = {
      publicationId: state.publication.id,
      idempotencyKey: state.publication.id,
      target: state.publication.target,
      channelPackage: packageRecord,
      payload,
      secretValue,
    };
    let validated: Awaited<ReturnType<PublicationAdapter['validateAuthorization']>>;
    try {
      validated = await adapter.validateAuthorization(command);
    } catch {
      return { outcome: 'GATE_REJECTED' };
    }
    if (validated.outcome !== 'VALID') return { outcome: 'GATE_REJECTED' };
    if (
      providerApiVersionIsExpired(
        adapterMetadata.providerApiSupportedUntil,
        this.options.clock.now(),
      )
    ) {
      return { outcome: 'GATE_REJECTED' };
    }

    let refreshed: Awaited<ReturnType<NonNullable<PublicationAdapter['refreshRemoteStatus']>>>;
    try {
      refreshed = await adapter.refreshRemoteStatus(command);
    } catch {
      return { outcome: 'REMOTE_STATUS_UNAVAILABLE' };
    }
    if (refreshed.outcome !== 'APPLIED') return { outcome: 'REMOTE_STATUS_UNAVAILABLE' };
    const remoteRef = safeRemoteRef(refreshed.remoteRef, secretReference, secretValue);
    const remoteState = safeRemoteState(
      refreshed.remoteState,
      command.publicationId,
      secretReference,
      secretValue,
    );
    const gitRemoteState = safeGitPullRequestRemoteState(remoteState);
    if (
      remoteRef === null ||
      remoteRef !== priorRemoteRef ||
      gitRemoteState === null ||
      gitRemoteState.number !== priorRemoteState.number ||
      !gitPullRequestStatusTransitionAllowed(priorRemoteState.status, gitRemoteState.status) ||
      (gitRemoteState.status === 'PR_OPENED' &&
        priorRemoteState.status === 'PR_OPENED' &&
        gitRemoteState.rollbackHandle?.repository !==
          priorRemoteState.rollbackHandle?.repository) ||
      state.publication.remoteRef !== priorRemoteRef ||
      JSON.stringify(state.publication.remoteState) !== JSON.stringify(priorRemoteState)
    ) {
      return { outcome: 'REMOTE_STATUS_INVALID' };
    }

    state.context = currentContext;
    state.publication.status = 'REMOTE_APPLIED';
    state.publication.remoteState = gitRemoteState;
    state.publication.updatedAt = this.options.clock.now().toISOString();
    return { outcome: 'SUCCEEDED', publication: structuredClone(state.publication) };
  }

  private async process(job: JobRecord): Promise<InMemoryPublicationJobCompletion> {
    const state = this.states.get(job.aggregateId);
    if (
      state === undefined ||
      state.publication.jobId !== job.id ||
      state.publication.tenantId !== job.tenantId ||
      state.publication.workspaceId !== job.workspaceId
    ) {
      return failed('PUBLICATION_EXECUTION_NOT_FOUND');
    }
    if (
      ['PUBLISHED', 'REMOTE_APPLIED'].includes(state.publication.status) &&
      state.publication.remoteRef !== null
    ) {
      return succeeded(state.publication);
    }
    if (
      !['QUEUED', 'RUNNING', 'RETRY_WAIT', 'RECONCILE_REQUIRED', 'RECONCILING'].includes(
        state.publication.status,
      )
    ) {
      return failed('PUBLICATION_EXECUTION_STATE_INVALID');
    }
    state.publication.status = state.pendingOperation === 'PUBLISH' ? 'RUNNING' : 'RECONCILING';
    state.publication.updatedAt = this.options.clock.now().toISOString();

    const currentContext = await this.options.tenancy.resolveTenantContext({
      actorSubject: state.actorSubject,
      tenantId: state.publication.tenantId,
      workspaceId: state.publication.workspaceId,
    });
    if (
      currentContext === null ||
      currentContext.actorUserId !== state.publication.requestedByUserId ||
      !roleAllows(currentContext.role, 'PUBLISH')
    ) {
      return this.failState(state, 'PUBLICATION_GATE_STALE');
    }
    state.context = currentContext;

    const boundPackage = await this.loadBoundPackage(state, currentContext, {
      publicationId: state.publication.id,
      leaseToken: job.id,
    });
    if (boundPackage === null) {
      return this.failState(state, 'PUBLICATION_GATE_STALE');
    }
    const { packageRecord, payload } = boundPackage;
    const channel = (await this.options.registry.listEntries({ context: state.context })).find(
      (candidate) =>
        candidate.id === packageRecord.channel.definitionId &&
        candidate.channelKey === packageRecord.channel.channelKey,
    );
    if (channel === undefined || channel.status !== 'AVAILABLE') {
      return this.failState(state, 'PUBLICATION_GATE_STALE');
    }
    const adapterMetadata = channel.adapterVersions.find(
      (candidate) => candidate.id === state.publication.adapterVersionId,
    );
    if (adapterMetadata === undefined) return this.failState(state, 'ADAPTER_NOT_FOUND');
    if (
      !adapterMetadata.enabled ||
      providerApiVersionIsExpired(
        adapterMetadata.providerApiSupportedUntil,
        this.options.clock.now(),
      ) ||
      !adapterMetadata.capabilities.includes('PUBLISH') ||
      !adapterMetadata.capabilities.includes('RECONCILE') ||
      adapterMetadata.termsStatus !== 'ALLOWED'
    ) {
      return this.failState(state, 'PUBLICATION_GATE_STALE');
    }
    const adapter = this.options.adapters.resolve(
      adapterMetadata.adapterKey,
      adapterMetadata.adapterVersion,
    );
    if (adapter === null) return this.failState(state, 'ADAPTER_RUNTIME_UNAVAILABLE');
    const runtimeMismatch = validatePublicationAdapterRuntime(adapter, adapterMetadata);
    if (runtimeMismatch !== null) return this.failState(state, runtimeMismatch);
    const authorization = await this.options.authorizations.findForTarget({
      context: state.context,
      adapterVersionId: state.publication.adapterVersionId,
      target: state.authorizationTarget,
    });
    const governance = resolvePublicationAdapterGovernance(
      adapter,
      adapterMetadata.requiredScopes,
      {
        target: state.publication.target,
        channelPackage: packageRecord,
      },
    );
    if (
      governance === null ||
      governance.authorizationTarget !== state.authorizationTarget ||
      !sameRequiredScopeSet(governance.requiredScopes, state.requiredScopesSnapshot) ||
      authorization === null ||
      authorization.id !== state.publication.channelAuthorizationId ||
      authorization.status !== 'ACTIVE' ||
      (authorization.expiresAt !== null &&
        new Date(authorization.expiresAt).getTime() <= this.options.clock.now().getTime()) ||
      authorization.acceptedTermsVersion !== adapterMetadata.termsVersion ||
      authorization.validationStatus !== 'VERIFIED' ||
      authorization.validationSnapshot === null ||
      authorization.validationSnapshot.actualTarget !== state.authorizationTarget ||
      authorization.validationSnapshot.acceptedTermsVersion !== adapterMetadata.termsVersion ||
      new Date(authorization.validationSnapshot.validUntil).getTime() <=
        this.options.clock.now().getTime() ||
      governance.requiredScopes.some(
        (scope) => !authorization.validationSnapshot!.actualScopes.includes(scope),
      )
    ) {
      return this.failState(state, 'PUBLICATION_AUTHORIZATION_STALE');
    }
    const secretReference = await this.options.authorizations.findSecretArn({
      context: state.context,
      authorizationId: authorization.id,
    });
    if (secretReference === null) {
      return this.failState(state, 'AUTHORIZATION_SECRET_UNAVAILABLE');
    }
    const credentialFingerprint = await this.options.authorizations.findCredentialFingerprint({
      context: state.context,
      authorizationId: authorization.id,
    });
    let secretValue: string;
    try {
      secretValue = await this.options.publicationSecrets.readPublicationSecret({
        access: {
          publicationId: state.publication.id,
          leaseToken: job.id,
        },
        expected: {
          secretReference,
          tenantId: state.publication.tenantId,
          workspaceId: state.publication.workspaceId,
        },
      });
    } catch {
      return this.failState(state, 'AUTHORIZATION_SECRET_UNAVAILABLE');
    }
    if (
      credentialFingerprint === null ||
      createHash('sha256').update(secretValue).digest('hex') !== credentialFingerprint
    ) {
      return this.failState(state, 'PUBLICATION_AUTHORIZATION_STALE');
    }
    const command: PublicationAdapterCommand = {
      publicationId: state.publication.id,
      idempotencyKey: state.publication.id,
      target: state.publication.target,
      channelPackage: packageRecord,
      payload,
      secretValue,
    };
    let validated: Awaited<ReturnType<PublicationAdapter['validateAuthorization']>>;
    try {
      validated = await adapter.validateAuthorization(command);
    } catch {
      validated = { outcome: 'UNKNOWN' };
    }
    if (validated.outcome !== 'VALID') {
      return this.failState(state, publicationAuthorizationFailureCode(validated));
    }
    if (
      providerApiVersionIsExpired(
        adapterMetadata.providerApiSupportedUntil,
        this.options.clock.now(),
      )
    ) {
      return this.failState(state, 'ADAPTER_PROVIDER_API_VERSION_EXPIRED');
    }

    if (state.pendingOperation === 'RECONCILE') {
      return this.reconcile(state, adapter, command, secretReference, secretValue, job);
    }

    const publicationEffect = await this.invokeAfterFinalPublishGate(
      state,
      command.channelPackage,
      command.payload,
      adapter,
      secretReference,
      secretValue,
      () => adapter.publish(command),
    );
    if (publicationEffect.outcome === 'GATE_STALE') {
      return this.failState(state, 'PUBLICATION_GATE_STALE');
    }
    const published: Awaited<ReturnType<PublicationAdapter['publish']>> =
      publicationEffect.outcome === 'EFFECT_COMPLETED'
        ? publicationEffect.value
        : { outcome: 'UNKNOWN', errorCode: 'UNTRUSTED' };
    if (published.outcome === 'APPLIED') {
      const remoteRef = safeRemoteRef(published.remoteRef, secretReference, secretValue);
      const remoteState =
        published.remoteState === undefined
          ? null
          : safeRemoteState(
              published.remoteState,
              command.publicationId,
              secretReference,
              secretValue,
            );
      if (remoteRef === null || (published.remoteState !== undefined && remoteState === null)) {
        this.appendAttempt(state, 'PUBLISH', 'AMBIGUOUS', null, 'ADAPTER_REMOTE_REF_INVALID');
        state.pendingOperation = 'RECONCILE';
        return this.reconcile(state, adapter, command, secretReference, secretValue, job);
      }
      this.appendAttempt(state, 'PUBLISH', 'APPLIED', remoteRef, null);
      return this.publishState(state, remoteRef, remoteState);
    }
    if (published.outcome === 'DEFINITELY_NOT_APPLIED') {
      this.appendAttempt(
        state,
        'PUBLISH',
        'DEFINITELY_NOT_APPLIED',
        null,
        'ADAPTER_PUBLISH_DEFINITELY_NOT_APPLIED',
      );
      return this.failState(state, 'ADAPTER_PUBLISH_DEFINITELY_NOT_APPLIED');
    }
    if (published.outcome === 'RETRYABLE_FAILURE') {
      this.appendAttempt(
        state,
        'PUBLISH',
        'RETRYABLE_FAILURE',
        null,
        'ADAPTER_PUBLISH_RETRYABLE_FAILURE',
      );
      if (job.attempt >= job.maxAttempts) {
        return this.failState(state, 'PUBLICATION_EXECUTION_ATTEMPTS_EXHAUSTED');
      }
      state.publication.status = 'RETRY_WAIT';
      state.publication.updatedAt = this.options.clock.now().toISOString();
      return retryWait('ADAPTER_PUBLISH_RETRYABLE_FAILURE');
    }
    if (published.outcome === 'TERMINAL_FAILURE') {
      this.appendAttempt(
        state,
        'PUBLISH',
        'TERMINAL_FAILURE',
        null,
        'ADAPTER_PUBLISH_TERMINAL_FAILURE',
      );
      return this.failState(state, 'ADAPTER_PUBLISH_TERMINAL_FAILURE');
    }
    this.appendAttempt(state, 'PUBLISH', 'AMBIGUOUS', null, 'ADAPTER_PUBLISH_OUTCOME_UNKNOWN');
    state.pendingOperation = 'RECONCILE';
    return this.reconcile(state, adapter, command, secretReference, secretValue, job);
  }

  private async reconcile(
    state: PublicationState,
    adapter: PublicationAdapter,
    command: PublicationAdapterCommand,
    secretReference: string,
    secretValue: string,
    job: JobRecord,
  ): Promise<InMemoryPublicationJobCompletion> {
    const reconciliationEffect = await this.invokeAfterFinalRecoveryGate(
      state,
      command.channelPackage,
      command.payload,
      adapter,
      secretReference,
      secretValue,
      () => {
        state.pendingOperation = 'RECONCILE';
        state.publication.status = 'RECONCILING';
        return adapter.reconcile(command);
      },
    );
    if (reconciliationEffect.outcome === 'GATE_STALE') {
      return this.failState(state, 'PUBLICATION_GATE_STALE');
    }
    const reconciled: Awaited<ReturnType<PublicationAdapter['reconcile']>> =
      reconciliationEffect.outcome === 'EFFECT_COMPLETED'
        ? reconciliationEffect.value
        : { outcome: 'UNKNOWN', errorCode: 'UNTRUSTED' };
    if (reconciled.outcome === 'APPLIED') {
      const remoteRef = safeRemoteRef(reconciled.remoteRef, secretReference, secretValue);
      const remoteState =
        reconciled.remoteState === undefined
          ? null
          : safeRemoteState(
              reconciled.remoteState,
              command.publicationId,
              secretReference,
              secretValue,
            );
      if (remoteRef !== null && (reconciled.remoteState === undefined || remoteState !== null)) {
        this.appendAttempt(state, 'RECONCILE', 'APPLIED', remoteRef, null);
        return this.publishState(state, remoteRef, remoteState);
      }
    }
    if (reconciled.outcome === 'RETRYABLE_FAILURE') {
      this.appendAttempt(
        state,
        'RECONCILE',
        'RETRYABLE_FAILURE',
        null,
        'ADAPTER_RECONCILE_RETRYABLE_FAILURE',
      );
      if (job.attempt >= job.maxAttempts) {
        state.publication.status = 'MANUAL_REVIEW_REQUIRED';
        state.publication.updatedAt = this.options.clock.now().toISOString();
        return failed('PUBLICATION_EXECUTION_ATTEMPTS_EXHAUSTED');
      }
      state.publication.status = 'RECONCILE_REQUIRED';
      state.publication.updatedAt = this.options.clock.now().toISOString();
      return retryWait('ADAPTER_RECONCILE_RETRYABLE_FAILURE');
    }
    if (reconciled.outcome === 'TERMINAL_FAILURE') {
      this.appendAttempt(
        state,
        'RECONCILE',
        'TERMINAL_FAILURE',
        null,
        'ADAPTER_RECONCILE_TERMINAL_FAILURE',
      );
      state.publication.status = 'MANUAL_REVIEW_REQUIRED';
      state.publication.updatedAt = this.options.clock.now().toISOString();
      return failed('ADAPTER_RECONCILE_TERMINAL_FAILURE');
    }
    const definitelyNotApplied = reconciled.outcome === 'DEFINITELY_NOT_APPLIED';
    this.appendAttempt(
      state,
      'RECONCILE',
      definitelyNotApplied ? 'DEFINITELY_NOT_APPLIED' : 'UNKNOWN',
      null,
      definitelyNotApplied
        ? 'ADAPTER_RECONCILE_DEFINITELY_NOT_APPLIED'
        : 'ADAPTER_RECONCILE_OUTCOME_UNKNOWN',
    );
    state.publication.status = definitelyNotApplied ? 'FAILED_TERMINAL' : 'MANUAL_REVIEW_REQUIRED';
    state.publication.updatedAt = this.options.clock.now().toISOString();
    return failed(
      definitelyNotApplied
        ? 'ADAPTER_RECONCILE_DEFINITELY_NOT_APPLIED'
        : 'ADAPTER_RECONCILE_OUTCOME_UNKNOWN',
    );
  }

  private async invokeAfterFinalPublishGate<T>(
    state: PublicationState,
    packageRecord: Parameters<PublicationCommandStore['submit']>[0]['channelPackage'],
    packagePayload: ChannelPackagePayload,
    adapter: PublicationAdapter,
    secretReference: string,
    secretValue: string,
    effect: () => Promise<T>,
  ): Promise<FinalLifecycleEffectResult<T>> {
    return this.invokeAfterFinalEffectGate(
      'PUBLISH',
      state,
      packageRecord,
      packagePayload,
      adapter,
      secretReference,
      secretValue,
      effect,
    );
  }

  private async invokeAfterFinalRecoveryGate<T>(
    state: PublicationState,
    packageRecord: Parameters<PublicationCommandStore['submit']>[0]['channelPackage'],
    packagePayload: ChannelPackagePayload,
    adapter: PublicationAdapter,
    secretReference: string,
    secretValue: string,
    effect: () => Promise<T>,
  ): Promise<FinalLifecycleEffectResult<T>> {
    return this.invokeAfterFinalEffectGate(
      'RECONCILE',
      state,
      packageRecord,
      packagePayload,
      adapter,
      secretReference,
      secretValue,
      effect,
    );
  }

  private async invokeAfterFinalEffectGate<T>(
    operation: 'PUBLISH' | 'RECONCILE',
    state: PublicationState,
    expectedPackage: Parameters<PublicationCommandStore['submit']>[0]['channelPackage'],
    expectedPackagePayload: ChannelPackagePayload,
    expectedAdapter: PublicationAdapter,
    expectedSecretReference: string,
    expectedSecretValue: string,
    effect: () => Promise<T>,
  ): Promise<FinalLifecycleEffectResult<T>> {
    const runner = this.options.atomicEffectRunner;
    const live = this.options.liveEffectState;
    if (runner === undefined || live === undefined) return { outcome: 'GATE_STALE' };

    const started = runner.run({
      validate: () =>
        this.finalLiveEffectStateIsCurrent(
          operation,
          state,
          expectedPackage,
          expectedPackagePayload,
          expectedAdapter,
          expectedSecretReference,
          expectedSecretValue,
          live,
        ),
      effect,
    });
    if (started.outcome !== 'EFFECT_STARTED') return started;
    try {
      return { outcome: 'EFFECT_COMPLETED', value: await started.promise };
    } catch {
      return { outcome: 'EFFECT_FAILED' };
    }
  }

  private finalLiveEffectStateIsCurrent(
    operation: 'PUBLISH' | 'RECONCILE',
    state: PublicationState,
    expectedPackage: Parameters<PublicationCommandStore['submit']>[0]['channelPackage'],
    expectedPackagePayload: ChannelPackagePayload,
    expectedAdapter: PublicationAdapter,
    expectedSecretReference: string,
    expectedSecretValue: string,
    live: InMemoryPublicationLiveEffectState,
  ): boolean {
    const reject: (reason: string) => false = () => false;
    let context: PublicationState['context'] | null;
    let registryEntries: ChannelRegistryEntry[];
    let authorizationMaterial: ReturnType<InMemoryPublicationLiveEffectState['findAuthorization']>;
    try {
      context = live.resolveTenantContext({
        actorSubject: state.actorSubject,
        tenantId: state.publication.tenantId,
        workspaceId: state.publication.workspaceId,
      });
      if (context === null) return reject('context-null');
      registryEntries = live.listRegistryEntries({ context });
      authorizationMaterial = live.findAuthorization({
        context,
        authorizationId: state.publication.channelAuthorizationId,
        adapterVersionId: state.publication.adapterVersionId,
        target: state.authorizationTarget,
      });
    } catch {
      return reject('live-resolver-threw');
    }
    const packageSnapshot = this.packageSnapshots.get(state.publication.id);
    if (
      context.tenantId !== state.publication.tenantId ||
      context.workspaceId !== state.publication.workspaceId ||
      context.actorUserId !== state.publication.requestedByUserId ||
      context.membershipId !== state.context.membershipId ||
      !roleAllows(context.role, 'PUBLISH') ||
      packageSnapshot === undefined ||
      !packageMatchesPublication(state, expectedPackage) ||
      packageSnapshot.packageChecksum !== expectedPackage.packageChecksum ||
      packageSnapshot.payloadObjectRef !== expectedPackage.payloadObjectRef ||
      verifyChannelPackagePayload(expectedPackage, expectedPackagePayload) === null
    ) {
      return reject('context-or-package');
    }
    if (operation === 'PUBLISH') {
      const artifactInput = {
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        artifactId: expectedPackage.artifact.artifactId,
        artifactRevisionId: expectedPackage.artifact.artifactRevisionId,
        revision: expectedPackage.artifact.revision,
        contentHash: expectedPackage.artifact.contentHash,
      };
      if (
        !live.isCurrentApprovedArtifact(artifactInput) ||
        !live.isCurrentApprovedLineage({ context, ...artifactInput })
      ) {
        return reject('artifact-currentness');
      }
    }
    if (operation === 'RECONCILE' && !stateHasReconciliationEvidence(state))
      return reject('recovery-evidence');

    const channel = registryEntries.find(
      (candidate) =>
        candidate.id === expectedPackage.channel.definitionId &&
        candidate.channelKey === expectedPackage.channel.channelKey,
    );
    const adapterMetadata = channel?.adapterVersions.find(
      (candidate) => candidate.id === state.publication.adapterVersionId,
    );
    if (
      channel?.status !== 'AVAILABLE' ||
      channel.packageTransformerKey !== expectedPackage.transformer.key ||
      channel.packageSchemaVersion !== expectedPackage.packageSchemaVersion ||
      adapterMetadata === undefined ||
      !this.registryAdapterAllows(operation, adapterMetadata)
    ) {
      return reject('registry');
    }
    const adapter = this.options.adapters.resolve(
      adapterMetadata.adapterKey,
      adapterMetadata.adapterVersion,
    );
    if (
      adapter === null ||
      adapter !== expectedAdapter ||
      validatePublicationAdapterRuntime(adapter, adapterMetadata) !== null
    ) {
      return reject('adapter-runtime');
    }
    const governance = resolvePublicationAdapterGovernance(
      adapter,
      adapterMetadata.requiredScopes,
      {
        target: state.publication.target,
        channelPackage: expectedPackage,
      },
    );
    const authorization = authorizationMaterial?.authorization ?? null;
    const secretReference = authorizationMaterial?.secretReference ?? null;
    const credentialFingerprint = authorizationMaterial?.credentialFingerprint ?? null;
    const now = this.options.clock.now().getTime();
    if (governance === null) return reject('governance-null');
    if (governance.authorizationTarget !== state.authorizationTarget)
      return reject('governance-target');
    if (!sameRequiredScopeSet(governance.requiredScopes, state.requiredScopesSnapshot))
      return reject('governance-scopes');
    if (authorization === null) return reject('authorization-null');
    if (authorization.id !== state.publication.channelAuthorizationId)
      return reject('authorization-id');
    if (authorization.tenantId !== state.publication.tenantId)
      return reject('authorization-tenant');
    if (authorization.workspaceId !== state.publication.workspaceId)
      return reject('authorization-workspace');
    if (authorization.adapterVersionId !== state.publication.adapterVersionId)
      return reject('authorization-adapter');
    if (authorization.target !== state.authorizationTarget) return reject('authorization-target');
    if (authorization.status !== 'ACTIVE') return reject('authorization-status');
    if (authorization.expiresAt !== null && new Date(authorization.expiresAt).getTime() <= now) {
      return reject('authorization-expired');
    }
    if (authorization.acceptedTermsVersion !== adapterMetadata.termsVersion)
      return reject('authorization-terms');
    if (governance.requiredScopes.some((scope) => !authorization.grantedScopes.includes(scope))) {
      return reject('authorization-scopes');
    }
    if (authorization.validationStatus !== 'VERIFIED')
      return reject('authorization-validation-status');
    if (authorization.validationSnapshot === null) return reject('authorization-validation-null');
    if (authorization.validationSnapshot.actualTarget !== state.authorizationTarget)
      return reject('authorization-validation-target');
    if (authorization.validationSnapshot.acceptedTermsVersion !== adapterMetadata.termsVersion) {
      return reject('authorization-validation-terms');
    }
    if (new Date(authorization.validationSnapshot.validUntil).getTime() <= now)
      return reject('authorization-validation-expired');
    if (
      governance.requiredScopes.some(
        (scope) => !authorization.validationSnapshot!.actualScopes.includes(scope),
      )
    ) {
      return reject('authorization-validation-scopes');
    }
    if (secretReference === null || secretReference.length === 0)
      return reject('secret-reference-null');
    if (secretReference !== expectedSecretReference) return reject('secret-reference-mismatch');
    if (credentialFingerprint === null) return reject('secret-fingerprint-null');
    if (expectedSecretValue.length === 0) return reject('secret-value-empty');
    if (createHash('sha256').update(expectedSecretValue).digest('hex') !== credentialFingerprint) {
      return reject('secret-fingerprint-mismatch');
    }
    if (
      !live.secretValueMatches({
        tenantId: state.publication.tenantId,
        secretReference: expectedSecretReference,
        secretValue: expectedSecretValue,
      })
    ) {
      return reject('secret-value-mismatch');
    }
    return true;
  }

  private registryAdapterAllows(
    operation: 'PUBLISH' | 'RECONCILE',
    adapter: ChannelAdapterVersion,
  ): boolean {
    return (
      adapter.enabled &&
      !providerApiVersionIsExpired(adapter.providerApiSupportedUntil, this.options.clock.now()) &&
      adapter.capabilities.includes('RECONCILE') &&
      (operation === 'RECONCILE' || adapter.capabilities.includes('PUBLISH')) &&
      adapter.termsStatus === 'ALLOWED'
    );
  }

  private readonly packageSnapshots = new Map<
    string,
    Parameters<PublicationCommandStore['submit']>[0]['channelPackage']
  >();

  private async loadBoundPackage(
    state: PublicationState,
    context: PublicationState['context'],
    access: ActivePublicationJobAccess,
  ) {
    const packageRecord = await this.options.packages.findById({
      context,
      packageId: state.publication.channelPackageId,
    });
    if (
      packageRecord === null ||
      packageRecord.id !== state.publication.channelPackageId ||
      packageRecord.tenantId !== state.publication.tenantId ||
      packageRecord.workspaceId !== state.publication.workspaceId ||
      packageRecord.packageChecksum !== state.publication.packageChecksum ||
      packageRecord.artifact.artifactRevisionId !== state.publication.artifactRevisionId ||
      packageRecord.artifact.contentHash !== state.publication.artifactContentHash
    ) {
      return null;
    }
    if (state.pendingOperation === 'PUBLISH') {
      const bundle = await this.options.artifacts.findBundle({
        context,
        artifactId: packageRecord.artifact.artifactId,
        effectiveAt: this.options.clock.now(),
      });
      if (!packageMatchesCurrentApprovedArtifact(bundle, context, packageRecord)) {
        return null;
      }
    }
    const payload = await this.options.publicationPackages.readPublicationPackage({
      access,
      expected: {
        objectRef: packageRecord.payloadObjectRef,
        tenantId: packageRecord.tenantId,
        workspaceId: packageRecord.workspaceId,
        packageChecksum: packageRecord.packageChecksum,
      },
    });
    return payload !== null && verifyChannelPackagePayload(packageRecord, payload) !== null
      ? { packageRecord, payload }
      : null;
  }

  private appendAttempt(
    state: PublicationState,
    operation: PublicationAttemptRecord['operation'],
    outcome: PublicationAttemptOutcome,
    remoteRef: string | null,
    errorCode: string | null,
  ): void {
    const timestamp = this.options.clock.now().toISOString();
    state.attempts.push({
      id: this.options.ids.next(),
      tenantId: state.publication.tenantId,
      workspaceId: state.publication.workspaceId,
      publicationId: state.publication.id,
      attemptNumber: state.attempts.length + 1,
      operation,
      outcome,
      remoteRef,
      errorCode,
      startedAt: timestamp,
      finishedAt: timestamp,
    });
  }

  private publishState(
    state: PublicationState,
    remoteRef: string,
    remoteState: PublicationRemoteState | null,
  ): InMemoryPublicationJobCompletion {
    state.publication.status =
      remoteState?.isProductionLive === false ? 'REMOTE_APPLIED' : 'PUBLISHED';
    state.publication.remoteRef = remoteRef;
    state.publication.remoteState = remoteState;
    state.publication.updatedAt = this.options.clock.now().toISOString();
    this.options.audit?.append({
      id: this.options.ids.next(),
      tenantId: state.context.tenantId,
      workspaceId: state.context.workspaceId,
      actorKind: 'AGENT',
      actorId: 'fake-publication-worker',
      action:
        state.publication.status === 'PUBLISHED'
          ? 'PUBLICATION_PUBLISHED'
          : 'PUBLICATION_REMOTE_APPLIED',
      resourceType: 'PUBLICATION',
      resourceId: state.publication.id,
      outcome: 'SUCCEEDED',
      metadata: {
        attemptCount: state.attempts.length,
        packageChecksum: state.publication.packageChecksum,
      },
      occurredAt: new Date(state.publication.updatedAt),
    });
    return succeeded(state.publication);
  }

  private failState(state: PublicationState, errorCode: string): InMemoryPublicationJobCompletion {
    state.publication.status =
      state.pendingOperation === 'RECONCILE' ? 'MANUAL_REVIEW_REQUIRED' : 'FAILED_TERMINAL';
    state.publication.updatedAt = this.options.clock.now().toISOString();
    return failed(errorCode);
  }

  private findByIdempotencyKey(tenantId: string, workspaceId: string, key: string) {
    return [...this.states.values()].find(
      (state) =>
        state.publication.tenantId === tenantId &&
        state.publication.workspaceId === workspaceId &&
        state.publication.idempotencyKey === key,
    );
  }

  private boundJob(state: PublicationState): JobRecord | null {
    return state.publication.jobId === null
      ? null
      : this.options.jobs.peekJob({ context: state.context, jobId: state.publication.jobId });
  }

  /** Explicit fake-runtime projection; secret references and attempt payloads never leave. */
  listPublishedForExperiment(
    context: PublicationState['context'],
  ): InMemoryPublishedExperimentIntervention[] {
    return [...this.states.values()]
      .filter(
        (state) =>
          state.context.tenantId === context.tenantId &&
          state.context.workspaceId === context.workspaceId &&
          state.publication.status === 'PUBLISHED',
      )
      .flatMap((state) => {
        const appliedAttempts = state.attempts
          .filter(
            (attempt) =>
              (attempt.operation === 'PUBLISH' || attempt.operation === 'RECONCILE') &&
              attempt.outcome === 'APPLIED' &&
              attempt.finishedAt !== null &&
              attempt.remoteRef === state.publication.remoteRef,
          )
          .sort(
            (left, right) =>
              compareCodeUnits(left.finishedAt ?? '', right.finishedAt ?? '') ||
              left.attemptNumber - right.attemptNumber ||
              compareCodeUnits(left.id, right.id),
          );
        const appliedAttempt = appliedAttempts[0];
        if (appliedAttempt === undefined || appliedAttempt.finishedAt === null) return [];
        return [
          {
            publication: structuredClone(state.publication),
            publicationAttemptId: appliedAttempt.id,
            appliedAt: appliedAttempt.finishedAt,
          },
        ];
      })
      .sort((left, right) =>
        left.appliedAt > right.appliedAt ? -1 : left.appliedAt < right.appliedAt ? 1 : 0,
      );
  }

  listTenantExportObjects(input: {
    tenantId: string;
    from: Date;
    to: Date;
  }): Promise<TenantExportSourceObject[]> {
    const from = input.from.getTime();
    const to = input.to.getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      return Promise.reject(new Error('INVALID_TENANT_EXPORT_RANGE'));
    }
    const objects = [...this.states.values()]
      .filter((state) => state.publication.tenantId === input.tenantId)
      .filter((state) => {
        const occurredAt = Date.parse(state.publication.createdAt);
        return occurredAt >= from && occurredAt <= to;
      })
      .map<TenantExportSourceObject>((state) => ({
        tenantId: state.publication.tenantId,
        workspaceId: state.publication.workspaceId,
        kind: 'PUBLICATION',
        objectId: state.publication.id,
        occurredAt: state.publication.createdAt,
        payload: toJsonValue({ publication: state.publication, attempts: state.attempts }),
      }));
    objects.sort((left, right) =>
      `${left.kind}:${left.objectId}`.localeCompare(`${right.kind}:${right.objectId}`),
    );
    return Promise.resolve(objects);
  }
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function packageMatchesCurrentArtifact(
  bundle: ArtifactLedgerBundle | null,
  context: PublicationState['context'],
  packageRecord: Parameters<PublicationCommandStore['submit']>[0]['channelPackage'],
): boolean {
  return (
    packageRecord.tenantId === context.tenantId &&
    packageRecord.workspaceId === context.workspaceId &&
    bundle !== null &&
    bundle.artifact.tenantId === context.tenantId &&
    bundle.artifact.workspaceId === context.workspaceId &&
    bundle.artifact.id === packageRecord.artifact.artifactId &&
    bundle.artifact.revision === packageRecord.artifact.revision &&
    bundle.revision !== null &&
    bundle.revision.id === packageRecord.artifact.artifactRevisionId &&
    bundle.revision.artifactId === packageRecord.artifact.artifactId &&
    bundle.revision.revision === packageRecord.artifact.revision &&
    bundle.revision.contentHash === packageRecord.artifact.contentHash
  );
}

function packageMatchesCurrentApprovedArtifact(
  bundle: ArtifactLedgerBundle | null,
  context: PublicationState['context'],
  packageRecord: Parameters<PublicationCommandStore['submit']>[0]['channelPackage'],
): boolean {
  if (bundle === null || !packageMatchesCurrentArtifact(bundle, context, packageRecord))
    return false;
  const exactRevision = bundle.revisions.find(
    (candidate) =>
      candidate.id === packageRecord.artifact.artifactRevisionId &&
      candidate.artifactId === packageRecord.artifact.artifactId &&
      candidate.revision === packageRecord.artifact.revision &&
      candidate.contentHash === packageRecord.artifact.contentHash,
  );
  const exactApproval = bundle.reviews.some(
    (review) =>
      review.artifactId === packageRecord.artifact.artifactId &&
      review.artifactRevisionId === packageRecord.artifact.artifactRevisionId &&
      review.revision === packageRecord.artifact.revision &&
      review.contentHash === packageRecord.artifact.contentHash &&
      review.decision === 'APPROVE',
  );
  const selectableAndCurrent = bundle.selectableApprovedRevisions.some(
    (candidate) =>
      candidate.revision === packageRecord.artifact.revision &&
      candidate.contentHash === packageRecord.artifact.contentHash,
  );
  return (
    bundle.artifact.status === 'APPROVED' &&
    bundle.revision?.status === 'APPROVED' &&
    exactRevision?.status === 'APPROVED' &&
    bundle.approvalState === 'ELIGIBLE' &&
    selectableAndCurrent &&
    exactApproval
  );
}

function packageMatchesPublication(
  state: PublicationState,
  packageRecord: Parameters<PublicationCommandStore['submit']>[0]['channelPackage'],
): boolean {
  return (
    packageRecord.id === state.publication.channelPackageId &&
    packageRecord.tenantId === state.publication.tenantId &&
    packageRecord.workspaceId === state.publication.workspaceId &&
    packageRecord.packageChecksum === state.publication.packageChecksum &&
    packageRecord.artifact.artifactRevisionId === state.publication.artifactRevisionId &&
    packageRecord.artifact.contentHash === state.publication.artifactContentHash
  );
}

function stateHasReconciliationEvidence(state: PublicationState): boolean {
  if (
    state.pendingOperation !== 'RECONCILE' ||
    !['RUNNING', 'RECONCILE_REQUIRED', 'RECONCILING'].includes(state.publication.status)
  ) {
    return false;
  }
  const latestAttempt = state.attempts.at(-1);
  return (
    (latestAttempt?.operation === 'PUBLISH' && latestAttempt.outcome === 'AMBIGUOUS') ||
    (latestAttempt?.operation === 'RECONCILE' && latestAttempt.outcome === 'RETRYABLE_FAILURE')
  );
}

function sameRequiredScopeSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((scope) => rightSet.has(scope))
  );
}

function succeeded(publication: PublicationRecord): InMemoryPublicationJobCompletion {
  return {
    status: 'SUCCEEDED',
    result: {
      publicationId: publication.id,
      publicationStatus: publication.status,
      remoteRef: publication.remoteRef,
      packageChecksum: publication.packageChecksum,
      ...(publication.remoteState === null || publication.remoteState === undefined
        ? {}
        : { remoteState: structuredClone(publication.remoteState) }),
    },
    errorCode: null,
  };
}

type GitPullRequestRemoteStatus = 'PR_OPENED' | 'MERGED' | 'CLOSED' | 'FAILED';

interface GitPullRequestRemoteState extends PublicationRemoteState {
  status: GitPullRequestRemoteStatus;
  number: number;
}

function safeGitPullRequestRemoteState(value: unknown): GitPullRequestRemoteState | null {
  const parsed = PublicationRemoteStateSchema.safeParse(value);
  if (
    !parsed.success ||
    !['PR_OPENED', 'MERGED', 'CLOSED', 'FAILED'].includes(parsed.data.status) ||
    parsed.data.number === null ||
    parsed.data.isProductionLive
  ) {
    return null;
  }
  if (parsed.data.status === 'PR_OPENED') {
    const handle = parsed.data.rollbackHandle;
    if (
      handle === null ||
      handle.operation !== 'CLOSE_PULL_REQUEST' ||
      typeof handle.repository !== 'string' ||
      handle.repository.length === 0 ||
      handle.pullRequestNumber !== parsed.data.number
    ) {
      return null;
    }
  } else if (parsed.data.rollbackHandle !== null) {
    return null;
  }
  return parsed.data as GitPullRequestRemoteState;
}

function gitPullRequestStatusTransitionAllowed(
  current: GitPullRequestRemoteStatus,
  next: GitPullRequestRemoteStatus,
): boolean {
  return current === 'PR_OPENED' ? true : current === next;
}

function failed(errorCode: string): InMemoryPublicationJobCompletion {
  return { status: 'FAILED_TERMINAL', result: null, errorCode };
}

function retryWait(errorCode: string): InMemoryPublicationJobCompletion {
  return { status: 'RETRY_WAIT', result: null, errorCode };
}

function safeRemoteRef(value: string, secretReference: string, secretValue: string): string | null {
  return value.length > 0 &&
    value.length <= 2_048 &&
    !value.includes(secretReference) &&
    !value.includes(secretValue) &&
    ![...value].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 0x1f || point === 0x7f);
    })
    ? value
    : null;
}

function safeRemoteState(
  value: unknown,
  expectedPublicationId: string,
  secretReference: string,
  secretValue: string,
): PublicationRemoteState | null {
  try {
    const parsed = PublicationRemoteStateSchema.safeParse(value);
    if (!parsed.success) return null;
    if (
      parsed.data.receiptEvidence !== undefined &&
      parsed.data.receiptEvidence.deliveryId !== expectedPublicationId
    ) {
      return null;
    }
    const serialized = JSON.stringify(parsed.data);
    if (
      (secretReference.length > 0 && serialized.includes(secretReference)) ||
      (secretValue.length > 0 && serialized.includes(secretValue))
    ) {
      return null;
    }
    const { receiptEvidence, ...baseState } = parsed.data;
    return receiptEvidence === undefined
      ? baseState
      : { ...baseState, receiptEvidence: { ...receiptEvidence } };
  } catch {
    return null;
  }
}
