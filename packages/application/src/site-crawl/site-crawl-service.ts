import type { IdentityIdGenerator, TenancyStore } from '../identity-access/index.js';
import { roleAllows } from '@aeostudio/domain/identity-access';
import type { SiteBaselineRecord, SiteRecord } from '@aeostudio/domain/site-crawl';
import type { SiteVerificationMethod, SiteVerificationRecord } from '@aeostudio/domain/site-crawl';

import type { SiteCrawlStore, SiteOwnershipVerifier } from './ports.js';

export type SiteMutationResult =
  | { outcome: 'SUCCEEDED'; site: SiteRecord }
  | { outcome: 'FORBIDDEN' | 'INVALID_ORIGIN' | 'NOT_FOUND' };

export type CrawlAuthorizationResult =
  | { outcome: 'ALLOWED'; site: SiteRecord }
  | { outcome: 'FORBIDDEN' | 'NOT_FOUND' | 'SITE_NOT_VERIFIED' };

export type VerificationMutationResult =
  | { outcome: 'SUCCEEDED'; verification: SiteVerificationRecord }
  | { outcome: 'FORBIDDEN' | 'NOT_FOUND' };

export type VerificationCompletionResult =
  | { outcome: 'SUCCEEDED'; site: SiteRecord }
  | { outcome: 'FORBIDDEN' | 'NOT_FOUND' | 'VERIFICATION_MISMATCH' };

export class SiteCrawlService {
  constructor(
    private readonly store: SiteCrawlStore,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext' | 'appendDeniedAudit'>,
    private readonly ids: IdentityIdGenerator,
    private readonly ownershipVerifier: SiteOwnershipVerifier,
    private readonly clock: { now(): Date },
  ) {}

  async registerSite(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    profileId: string;
    origin: string;
  }): Promise<SiteMutationResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'SITE_REGISTER',
        resourceType: 'SITE',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const normalized = this.normalizeOrigin(input.origin);
    if (normalized === null) {
      return { outcome: 'INVALID_ORIGIN' };
    }
    const site = await this.store.createSite({
      context,
      siteId: this.ids.next(),
      profileId: input.profileId,
      origin: normalized.origin,
      hostname: normalized.hostname,
      auditEventId: this.ids.next(),
    });
    return site === null ? { outcome: 'NOT_FOUND' } : { outcome: 'SUCCEEDED', site };
  }

  async authorizeCrawl(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    siteId: string;
  }): Promise<CrawlAuthorizationResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'CRAWL_START',
        resourceType: 'SITE',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const site = await this.store.findSite({ context, siteId: input.siteId });
    if (site === null) {
      return { outcome: 'NOT_FOUND' };
    }
    return site.status === 'VERIFIED'
      ? { outcome: 'ALLOWED', site }
      : { outcome: 'SITE_NOT_VERIFIED' };
  }

  async createVerification(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    siteId: string;
    method: SiteVerificationMethod;
  }): Promise<VerificationMutationResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'SITE_VERIFY',
        resourceType: 'SITE',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const verification = await this.store.createVerification({
      context,
      verificationId: this.ids.next(),
      siteId: input.siteId,
      method: input.method,
      challengeToken: this.ids.next(),
      challengePath:
        input.method === 'FILE'
          ? '/.well-known/aeostudio-verification'
          : input.method === 'DNS'
            ? '_aeostudio-verification'
            : null,
      auditEventId: this.ids.next(),
    });
    return verification === null
      ? { outcome: 'NOT_FOUND' }
      : { outcome: 'SUCCEEDED', verification };
  }

  async completeVerification(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    siteId: string;
    verificationId: string;
  }): Promise<VerificationCompletionResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'SITE_VERIFY',
        resourceType: 'SITE',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const found = await this.store.findVerification({
      context,
      siteId: input.siteId,
      verificationId: input.verificationId,
    });
    if (found === null) {
      return { outcome: 'NOT_FOUND' };
    }
    const evidence = await this.ownershipVerifier.verify({
      site: found.site,
      method: found.verification.method,
      expectedToken: found.verification.challengeToken,
      challengePath: found.verification.challengePath,
    });
    if (!evidence.matched) {
      return { outcome: 'VERIFICATION_MISMATCH' };
    }
    const site = await this.store.markVerified({
      context,
      siteId: input.siteId,
      verificationId: input.verificationId,
      verifiedAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
    return site === null ? { outcome: 'NOT_FOUND' } : { outcome: 'SUCCEEDED', site };
  }

  async getBaseline(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    siteId: string;
  }): Promise<SiteBaselineRecord | null> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) {
      return null;
    }
    return this.store.findBaseline({ context, siteId: input.siteId });
  }

  async listBaselines(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
  }) {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) return null;
    return this.store.listBaselines({ context });
  }

  async getSite(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    siteId: string;
  }): Promise<SiteRecord | null> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) {
      return null;
    }
    return this.store.findSite({ context, siteId: input.siteId });
  }

  private normalizeOrigin(value: string): { hostname: string; origin: string } | null {
    try {
      const url = new URL(value);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.pathname !== '/' ||
        url.search.length > 0 ||
        url.hash.length > 0
      ) {
        return null;
      }
      return { hostname: url.hostname.toLowerCase(), origin: url.origin };
    } catch {
      return null;
    }
  }
}
