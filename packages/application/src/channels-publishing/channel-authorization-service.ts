import { roleAllows } from '@aeostudio/domain/identity-access';
import type { ChannelAuthorizationMetadata } from '@aeostudio/domain/channels-publishing';

import type { IdentityIdGenerator, TenancyStore } from '../identity-access/index.js';
import type { ChannelAuthorizationStore, ChannelRegistryStore } from './ports.js';

export type CreateChannelAuthorizationOutcome =
  | {
      outcome: 'SUCCEEDED';
      authorization: ChannelAuthorizationMetadata;
    }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'FORBIDDEN' }
  | { outcome: 'ADAPTER_NOT_FOUND' };

export type ListChannelAuthorizationsOutcome =
  | {
      outcome: 'SUCCEEDED';
      authorizations: ChannelAuthorizationMetadata[];
    }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'FORBIDDEN' };

export type RevokeChannelAuthorizationOutcome =
  | {
      outcome: 'SUCCEEDED';
      authorization: ChannelAuthorizationMetadata;
    }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'FORBIDDEN' };

export class ChannelAuthorizationService {
  constructor(
    private readonly authorizations: ChannelAuthorizationStore,
    private readonly registry: ChannelRegistryStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext' | 'appendDeniedAudit'>,
    private readonly ids: IdentityIdGenerator,
    private readonly clock: { now(): Date },
  ) {}

  async create(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    adapterVersionId: string;
    target: string;
    grantedScopes: string[];
    acceptedTermsVersion: string;
    secretArn: string;
    expiresAt?: string | null;
  }): Promise<CreateChannelAuthorizationOutcome> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' };
    if (!roleAllows(context.role, 'CHANNEL_AUTHORIZATION_MANAGE')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'CHANNEL_AUTHORIZATION_CREATE',
        resourceType: 'CHANNEL_AUTHORIZATION',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const channelEntries = await this.registry.listEntries({ context });
    const channel = channelEntries.find((entry) =>
      entry.adapterVersions.some((adapter) => adapter.id === input.adapterVersionId),
    );
    const adapter = channel?.adapterVersions.find((entry) => entry.id === input.adapterVersionId);
    if (channel === undefined || adapter === undefined) return { outcome: 'ADAPTER_NOT_FOUND' };
    const now = this.clock.now();
    const authorization = await this.authorizations.create({
      context,
      authorizationId: this.ids.next(),
      adapterVersionId: input.adapterVersionId,
      adapterKey: adapter.adapterKey,
      adapterVersion: adapter.adapterVersion,
      channelDefinitionId: channel.id,
      target: input.target,
      grantedScopes: [...input.grantedScopes],
      acceptedTermsVersion: input.acceptedTermsVersion,
      secretArn: input.secretArn,
      expiresAt: input.expiresAt == null ? null : new Date(input.expiresAt),
      createdAt: now,
      auditEventId: this.ids.next(),
    });
    return { outcome: 'SUCCEEDED', authorization };
  }

  async list(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }): Promise<ListChannelAuthorizationsOutcome> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' };
    if (!roleAllows(context.role, 'CHANNEL_AUTHORIZATION_MANAGE')) {
      return { outcome: 'FORBIDDEN' };
    }
    return {
      outcome: 'SUCCEEDED',
      authorizations: await this.authorizations.list({ context }),
    };
  }

  async revoke(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    authorizationId: string;
  }): Promise<RevokeChannelAuthorizationOutcome> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) return { outcome: 'NOT_FOUND' };
    if (!roleAllows(context.role, 'CHANNEL_AUTHORIZATION_MANAGE')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'CHANNEL_AUTHORIZATION_REVOKE',
        resourceType: 'CHANNEL_AUTHORIZATION',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const authorization = await this.authorizations.revoke({
      context,
      authorizationId: input.authorizationId,
      revokedAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
    return authorization === null
      ? { outcome: 'NOT_FOUND' }
      : { outcome: 'SUCCEEDED', authorization };
  }
}
