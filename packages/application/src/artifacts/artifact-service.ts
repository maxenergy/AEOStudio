import { createHash } from 'node:crypto';

import { roleAllows } from '@aeostudio/domain/identity-access';
import type { ArtifactPayload, ArtifactRevisionRecord } from '@aeostudio/domain/artifacts';
import type { IdentityIdGenerator, TenantContext, TenancyStore } from '../identity-access/index.js';
import {
  estimateGenerationJobUnits,
  type JobBudgetStore,
  type JobTraceContext,
} from '../jobs-budgets/index.js';
import type { CapabilityBoundArtifactRevisionPayloadReader } from '../tenant-data-access/capability-context.js';

import type { ArtifactPayloadWriter, ArtifactStore } from './ports.js';
import { canonicalArtifactJson, hashArtifactRevision } from './artifact-hash.js';
import { validateArtifactPayload } from './artifact-payload-validation.js';

export class ArtifactService {
  constructor(
    private readonly store: ArtifactStore,
    private readonly payloads: ArtifactPayloadWriter,
    private readonly payloadReader: CapabilityBoundArtifactRevisionPayloadReader,
    private readonly jobs: JobBudgetStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext' | 'appendDeniedAudit'>,
    private readonly ids: IdentityIdGenerator,
    private readonly clock: { now(): Date },
  ) {}

  async getArtifact(input: {
    actorSubject: string;
    sessionToken: string;
    tenantId: string;
    workspaceId: string;
    artifactId: string;
  }) {
    const context = await this.tenancy.resolveTenantContext({
      actorSubject: input.actorSubject,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
    });
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) return null;
    const bundle = await this.store.findBundle({
      context,
      artifactId: input.artifactId,
      effectiveAt: this.clock.now(),
    });
    if (bundle === null) return null;
    const payload =
      bundle.revision === null
        ? null
        : await this.loadValidPayload(input.sessionToken, context, bundle.revision);
    if (bundle.revision !== null && payload === null) return null;
    const previousRevision = bundle.revisions.find(
      (revision) => revision.revision === bundle.artifact.revision - 1,
    );
    const previousPayload =
      previousRevision === undefined
        ? null
        : await this.loadValidPayload(input.sessionToken, context, previousRevision);
    if (previousRevision !== undefined && previousPayload === null) return null;
    return { ...bundle, payload, previousPayload };
  }

  async createRevision(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    artifactId: string;
    expectedRevision: number;
    payload: ArtifactPayload;
  }) {
    const context = await this.tenancy.resolveTenantContext({
      actorSubject: input.actorSubject,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
    });
    if (context === null) return { outcome: 'NOT_FOUND' as const };
    if (!roleAllows(context.role, 'CONTENT_EDIT')) return { outcome: 'FORBIDDEN' as const };
    const bundle = await this.store.findBundle({
      context,
      artifactId: input.artifactId,
      effectiveAt: this.clock.now(),
    });
    if (bundle === null || bundle.revision === null) return { outcome: 'NOT_FOUND' as const };
    if (bundle.artifact.revision !== input.expectedRevision) {
      return { outcome: 'REVISION_CONFLICT' as const };
    }
    if (validateArtifactPayload(input.payload, bundle.revision.claimBindings) === null) {
      return { outcome: 'INVALID_REFERENCE' as const };
    }
    const nextRevision = input.expectedRevision + 1;
    const contentHash = hashArtifactRevision({
      schemaVersion: bundle.revision.schemaVersion,
      artifactId: input.artifactId,
      revision: nextRevision,
      type: bundle.revision.type,
      locale: bundle.revision.locale,
      market: bundle.revision.market,
      sourceArtifactIds: bundle.revision.sourceArtifactIds,
      lineage: bundle.revision.lineage,
      claimBindings: bundle.revision.claimBindings,
      methodPolicyVersion: bundle.revision.methodPolicyVersion,
      payload: input.payload,
    });
    const stored = await this.payloads.put({
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      artifactId: input.artifactId,
      revision: nextRevision,
      contentHash,
      payload: input.payload,
    });
    const created = await this.store.createRevision({
      context,
      artifactId: input.artifactId,
      expectedRevision: input.expectedRevision,
      revisionId: this.ids.next(),
      contentHash,
      payloadObjectRef: stored.objectRef,
      createdAt: this.clock.now(),
      claimLinkIds: bundle.revision.claimBindings.flatMap((binding) =>
        binding.evidence.map(() => this.ids.next()),
      ),
      auditEventId: this.ids.next(),
    });
    return created;
  }

  async submitRevision(input: {
    actorSubject: string;
    sessionToken: string;
    tenantId: string;
    workspaceId: string;
    artifactId: string;
    revision: number;
    expectedContentHash: string;
  }) {
    const context = await this.tenancy.resolveTenantContext({
      actorSubject: input.actorSubject,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
    });
    if (context === null) return { outcome: 'NOT_FOUND' as const };
    if (!roleAllows(context.role, 'CONTENT_EDIT')) return { outcome: 'FORBIDDEN' as const };
    const bundle = await this.store.findBundle({
      context,
      artifactId: input.artifactId,
      effectiveAt: this.clock.now(),
    });
    const exactRevision = bundle?.revisions.find(
      (revision) => revision.revision === input.revision,
    );
    if (exactRevision === undefined) return { outcome: 'NOT_FOUND' as const };
    if ((await this.loadValidPayload(input.sessionToken, context, exactRevision)) === null) {
      return { outcome: 'INVALID_PAYLOAD' as const };
    }
    return this.store.submitRevision({
      context,
      artifactId: input.artifactId,
      revision: input.revision,
      expectedContentHash: input.expectedContentHash,
      submittedAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
  }

  async reviewRevision(input: {
    actorSubject: string;
    sessionToken: string;
    tenantId: string;
    workspaceId: string;
    artifactId: string;
    revision: number;
    expectedContentHash: string;
    decision: 'APPROVE' | 'REJECT';
    note: string;
  }) {
    const context = await this.tenancy.resolveTenantContext({
      actorSubject: input.actorSubject,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
    });
    if (context === null) return { outcome: 'NOT_FOUND' as const };
    if (!roleAllows(context.role, 'ARTIFACT_APPROVE')) return { outcome: 'FORBIDDEN' as const };
    const bundle = await this.store.findBundle({
      context,
      artifactId: input.artifactId,
      effectiveAt: this.clock.now(),
    });
    const exactRevision = bundle?.revisions.find(
      (revision) => revision.revision === input.revision,
    );
    if (exactRevision === undefined) return { outcome: 'NOT_FOUND' as const };
    if ((await this.loadValidPayload(input.sessionToken, context, exactRevision)) === null) {
      return { outcome: 'INVALID_PAYLOAD' as const };
    }
    return this.store.reviewRevision({
      context,
      artifactId: input.artifactId,
      revision: input.revision,
      expectedContentHash: input.expectedContentHash,
      decision: input.decision,
      note: input.note,
      reviewId: this.ids.next(),
      reviewedAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
  }

  async startGeneration(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    briefId: string;
    locale: string;
    market: string;
    methodPolicyVersion: string;
    idempotencyKey: string;
    traceContext?: JobTraceContext;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' as const };
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'ARTIFACT_GENERATION_START',
        resourceType: 'ARTIFACT',
      });
      return { outcome: 'FORBIDDEN' as const };
    }
    const estimatedUnits = estimateGenerationJobUnits({
      jobType: 'ARTIFACT_GENERATION',
      methodVersion: input.methodPolicyVersion,
      boundedInput: {
        briefCount: 1,
        localeLength: input.locale.length,
        marketLength: input.market.length,
      },
    });
    const reserved = await this.jobs.reserveGenerationStart({
      context,
      operation: 'ARTIFACT_GENERATION',
      idempotencyKey: input.idempotencyKey,
      requestHash: createHash('sha256')
        .update(
          canonicalArtifactJson({
            briefId: input.briefId,
            locale: input.locale,
            market: input.market,
            methodPolicyVersion: input.methodPolicyVersion,
          }),
          'utf8',
        )
        .digest('hex'),
      aggregateId: this.ids.next(),
      jobId: this.ids.next(),
      estimatedUnits,
      requestedAt: this.clock.now(),
    });
    if (reserved.outcome !== 'RESERVED') {
      return reserved.outcome === 'IDEMPOTENCY_CONFLICT'
        ? { outcome: 'IDEMPOTENCY_CONFLICT' as const }
        : { outcome: 'NOT_FOUND' as const };
    }
    const artifactId = reserved.aggregateId;
    const prepared = await this.store.prepareArtifact({
      context,
      artifactId,
      briefId: input.briefId,
      locale: input.locale,
      market: input.market,
      methodPolicyVersion: input.methodPolicyVersion,
      createdAt: reserved.requestedAt,
      auditEventId: this.ids.next(),
    });
    if (prepared.outcome === 'INVALID_REFERENCE') return prepared;
    const job = await this.jobs.submitJob({
      context,
      jobId: reserved.jobId,
      jobType: 'ARTIFACT_GENERATION',
      aggregateId: artifactId,
      idempotencyKey: input.idempotencyKey,
      estimatedUnits: reserved.estimatedUnits,
      reservationId: this.ids.next(),
      budgetAlertId: this.ids.next(),
      outboxMessageId: this.ids.next(),
      auditEventId: this.ids.next(),
      ...(input.traceContext === undefined ? {} : { traceContext: input.traceContext }),
    });
    if (job === null) return { outcome: 'NOT_FOUND' as const };
    const artifact = await this.store.bindJob({ context, artifactId, jobId: job.id });
    return artifact === null
      ? { outcome: 'NOT_FOUND' as const }
      : { outcome: 'SUCCEEDED' as const, artifact, job };
  }

  private async loadValidPayload(
    sessionToken: string,
    context: TenantContext,
    revision: ArtifactRevisionRecord,
  ): Promise<ArtifactPayload | null> {
    const stored = await this.payloadReader.readAuthenticatedArtifactRevision({
      sessionToken,
      context,
      authority: {
        kind: 'ARTIFACT_REVISION',
        artifactRevisionId: revision.id,
      },
      expected: {
        objectRef: revision.payloadObjectRef,
        contentHash: revision.contentHash,
      },
    });
    const payload = validateArtifactPayload(stored, revision.claimBindings);
    if (payload === null) return null;
    const actualHash = hashArtifactRevision({
      schemaVersion: revision.schemaVersion,
      artifactId: revision.artifactId,
      revision: revision.revision,
      type: revision.type,
      locale: revision.locale,
      market: revision.market,
      sourceArtifactIds: revision.sourceArtifactIds,
      lineage: revision.lineage,
      claimBindings: revision.claimBindings,
      methodPolicyVersion: revision.methodPolicyVersion,
      payload,
    });
    return actualHash === revision.contentHash ? payload : null;
  }
}
