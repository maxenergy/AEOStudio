import type { PublicationRecord } from '@aeostudio/domain/channels-publishing';
import { roleAllows } from '@aeostudio/domain/identity-access';

import type { IdentityIdGenerator, TenancyStore } from '../identity-access/index.js';
import type { PublicationRemoteStatusRefreshStore } from './ports.js';

export type PublicationRemoteStatusRefreshOutcome =
  | { outcome: 'SUCCEEDED'; publication: PublicationRecord }
  | {
      outcome:
        | 'NOT_FOUND'
        | 'FORBIDDEN'
        | 'INVALID_STATE'
        | 'GATE_REJECTED'
        | 'ADAPTER_UNAVAILABLE'
        | 'REMOTE_STATUS_UNAVAILABLE'
        | 'REMOTE_STATUS_INVALID';
    };

export class PublicationRemoteStatusRefreshService {
  constructor(
    private readonly store: PublicationRemoteStatusRefreshStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext' | 'appendDeniedAudit'>,
    private readonly ids: IdentityIdGenerator,
  ) {}

  async refresh(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    publicationId: string;
  }): Promise<PublicationRemoteStatusRefreshOutcome> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' };
    if (!roleAllows(context.role, 'PUBLISH')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'PUBLICATION_REMOTE_STATUS_REFRESH',
        resourceType: 'PUBLICATION',
      });
      return { outcome: 'FORBIDDEN' };
    }
    return this.store.refresh({
      context,
      actorSubject: input.actorSubject,
      publicationId: input.publicationId,
    });
  }
}
