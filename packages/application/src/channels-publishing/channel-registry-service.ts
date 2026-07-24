import { roleAllows } from '@aeostudio/domain/identity-access';

import type { TenancyStore } from '../identity-access/index.js';
import type { ChannelRegistryStore } from './ports.js';

export class ChannelRegistryService {
  constructor(
    private readonly registry: ChannelRegistryStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext'>,
  ) {}

  async listRegistry(input: { actorSubject: string; tenantId: string; workspaceId: string }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) return null;
    return this.registry.listEntries({ context });
  }
}
