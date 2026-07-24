import type {
  PublicationAttemptRecord,
  PublicationRecord,
} from '@aeostudio/domain/channels-publishing';
import { roleAllows } from '@aeostudio/domain/identity-access';
import type { JobRecord } from '@aeostudio/domain/jobs-budgets';

import type { TenancyStore } from '../identity-access/index.js';
import type { PublicationQueryStore } from './ports.js';

export interface PublicationDetail {
  publication: PublicationRecord;
  attempts: PublicationAttemptRecord[];
  job: JobRecord;
}

export class PublicationQueryService {
  constructor(
    private readonly store: PublicationQueryStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext'>,
  ) {}

  async get(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    publicationId: string;
  }): Promise<PublicationDetail | null> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) return null;
    return this.store.findDetail({ context, publicationId: input.publicationId });
  }
}
