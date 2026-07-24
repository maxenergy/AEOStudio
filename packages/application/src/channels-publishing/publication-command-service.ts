import { createHash } from 'node:crypto';

import { canonicalArtifactJson } from '../artifacts/index.js';
import type { IdentityIdGenerator, TenancyStore } from '../identity-access/index.js';
import { roleAllows } from '@aeostudio/domain/identity-access';
import type {
  PublicationEligibilityReason,
  PublicationRecord,
} from '@aeostudio/domain/channels-publishing';
import type { JobRecord } from '@aeostudio/domain/jobs-budgets';
import type { JobTraceContext } from '../jobs-budgets/index.js';

import type { PublicationEligibilityService } from './publication-eligibility-service.js';
import type { PublicationCommandStore } from './ports.js';

export const PUBLICATION_ESTIMATED_UNITS = 5;

export type PublicationCommandOutcome =
  | {
      outcome: 'SUCCEEDED';
      publication: PublicationRecord;
      job: JobRecord;
      created: boolean;
    }
  | {
      outcome: 'EXPORT_ONLY';
      packageId: string;
      packageChecksum: string;
      reasons: PublicationEligibilityReason[];
    }
  | {
      outcome:
        | 'NOT_FOUND'
        | 'FORBIDDEN'
        | 'PACKAGE_CHECKSUM_MISMATCH'
        | 'PACKAGE_INTEGRITY_INVALID'
        | 'APPROVAL_REQUIRED'
        | 'APPROVAL_STALE'
        | 'IDEMPOTENCY_CONFLICT'
        | 'PIPELINE_UNAVAILABLE';
    };

export class PublicationCommandService {
  constructor(
    private readonly eligibility: PublicationEligibilityService,
    private readonly store: PublicationCommandStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext' | 'appendDeniedAudit'>,
    private readonly ids: IdentityIdGenerator,
    private readonly clock: { now(): Date },
  ) {}

  async request(input: {
    actorSubject: string;
    sessionToken: string;
    tenantId: string;
    workspaceId: string;
    channelPackageId: string;
    adapterVersionId?: string;
    target: string;
    expectedPackageChecksum: string;
    idempotencyKey: string;
    traceContext?: JobTraceContext;
  }): Promise<PublicationCommandOutcome> {
    const context = await this.tenancy.resolveTenantContext({
      actorSubject: input.actorSubject,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
    });
    if (context === null) return { outcome: 'NOT_FOUND' };
    if (!roleAllows(context.role, 'PUBLISH')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'PUBLICATION_REQUEST',
        resourceType: 'PUBLICATION',
      });
      return { outcome: 'FORBIDDEN' };
    }

    const requestHash = createHash('sha256')
      .update(
        canonicalArtifactJson({
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          channelPackageId: input.channelPackageId,
          adapterVersionId: input.adapterVersionId,
          target: input.target,
          expectedPackageChecksum: input.expectedPackageChecksum,
          idempotencyKey: input.idempotencyKey,
          estimatedUnits: PUBLICATION_ESTIMATED_UNITS,
        }),
        'utf8',
      )
      .digest('hex');
    const existing = await this.store.findExisting({
      context,
      idempotencyKey: input.idempotencyKey,
      requestHash,
    });
    if (existing.outcome === 'SUCCEEDED' || existing.outcome === 'IDEMPOTENCY_CONFLICT') {
      return existing;
    }

    const eligible = await this.eligibility.request(input);
    if (eligible.outcome !== 'READY') return eligible;

    const submitted = await this.store.submit({
      context,
      actorSubject: input.actorSubject,
      publicationId: this.ids.next(),
      jobId: this.ids.next(),
      reservationId: this.ids.next(),
      budgetAlertId: this.ids.next(),
      outboxMessageId: this.ids.next(),
      auditEventId: this.ids.next(),
      jobAuditEventId: this.ids.next(),
      channelPackage: eligible.channelPackage,
      adapterVersionId: eligible.adapter.id,
      channelAuthorization: eligible.authorization,
      requiredScopes: eligible.requiredScopes,
      target: input.target,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      estimatedUnits: PUBLICATION_ESTIMATED_UNITS,
      createdAt: this.clock.now(),
      ...(input.traceContext === undefined ? {} : { traceContext: input.traceContext }),
    });
    return submitted;
  }
}
