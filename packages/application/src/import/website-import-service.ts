import type { IdentityIdGenerator, TenancyStore } from '../identity-access/index.js';
import { roleAllows } from '@aeostudio/domain/identity-access';
import type { ProfileOfferingService } from '../profile-offering/profile-offering-service.js';

import type {
  WebsiteImportFaqCandidate,
  WebsiteImportOfferingCandidate,
  WebsiteImportSession,
  WebsiteImportStore,
} from './ports.js';

export type WebsiteImportStartResult =
  | { outcome: 'SUCCEEDED'; session: WebsiteImportSession }
  | { outcome: 'FORBIDDEN' }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'INVALID_URL' };

export type WebsiteImportGetResult =
  { outcome: 'SUCCEEDED'; session: WebsiteImportSession } | { outcome: 'NOT_FOUND' };

export type WebsiteImportConfirmResult =
  | {
      outcome: 'SUCCEEDED';
      importId: string;
      profileId: string | null;
      offeringIds: string[];
      pendingFaqs: WebsiteImportFaqCandidate[];
    }
  | { outcome: 'FORBIDDEN' }
  | { outcome: 'NOT_FOUND' };

/** 从 URL 推导确定性的候选数据（in-memory/fake 模式下的模拟抓取）。 */
function buildCandidates(
  url: string,
  ids: IdentityIdGenerator,
): Pick<WebsiteImportSession, 'profile' | 'offerings' | 'faqs'> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    hostname = 'example.com';
  }
  const firstLabel = hostname.split('.')[0] ?? hostname;
  const brand = firstLabel
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  const displayName = brand.length === 0 ? 'Imported Company' : brand;

  const offerings: WebsiteImportOfferingCandidate[] = [
    {
      candidateId: ids.next(),
      kind: 'product',
      name: `${displayName} Core`,
      description: `Flagship product imported from ${hostname}.`,
      locale: 'en-US',
      market: 'US',
    },
    {
      candidateId: ids.next(),
      kind: 'service',
      name: `${displayName} Support`,
      description: `Support service imported from ${hostname}.`,
      locale: 'en-US',
      market: 'US',
    },
  ];

  const faqs: WebsiteImportFaqCandidate[] = [
    {
      candidateId: ids.next(),
      question: `What is ${displayName}?`,
      answer: `${displayName} is a company discovered at ${hostname}.`,
    },
    {
      candidateId: ids.next(),
      question: `How do I get started with ${displayName}?`,
      answer: `Visit ${hostname} to learn more about ${displayName}.`,
    },
  ];

  return {
    profile: {
      displayName,
      description: `Company profile imported from ${hostname}.`,
      websiteUrl: url,
      locale: 'en-US',
      market: 'US',
    },
    offerings,
    faqs,
  };
}

export class WebsiteImportService {
  constructor(
    private readonly store: WebsiteImportStore,
    private readonly profileOffering: ProfileOfferingService,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext' | 'appendDeniedAudit'>,
    private readonly ids: IdentityIdGenerator,
    private readonly clock: { now(): Date },
  ) {}

  async startImport(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    url: string;
  }): Promise<WebsiteImportStartResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'WORKSPACE_READ')) {
      return { outcome: 'FORBIDDEN' };
    }
    let normalized: string;
    try {
      normalized = new URL(input.url).toString();
    } catch {
      return { outcome: 'INVALID_URL' };
    }
    const session: WebsiteImportSession = {
      importId: this.ids.next(),
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      url: normalized,
      status: 'PENDING_CONFIRMATION',
      ...buildCandidates(normalized, this.ids),
      createdAt: this.clock.now().toISOString(),
    };
    await this.store.save(session);
    return { outcome: 'SUCCEEDED', session };
  }

  async confirmImport(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    importId: string;
    createProfile: boolean;
    offeringCandidateIds: string[];
  }): Promise<WebsiteImportConfirmResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null) {
      return { outcome: 'NOT_FOUND' };
    }
    if (!roleAllows(context.role, 'CONTENT_EDIT')) {
      await this.tenancy.appendDeniedAudit({
        context,
        auditEventId: this.ids.next(),
        action: 'WEBSITE_IMPORT_CONFIRM',
        resourceType: 'WEBSITE_IMPORT',
      });
      return { outcome: 'FORBIDDEN' };
    }
    const session = await this.store.find({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      importId: input.importId,
    });
    if (session === null || session.status !== 'PENDING_CONFIRMATION') {
      return { outcome: 'NOT_FOUND' };
    }

    let profileId: string | null = null;
    if (input.createProfile) {
      const profileResult = await this.profileOffering.createProfile({
        actorSubject: input.actorSubject,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        content: {
          displayName: session.profile.displayName,
          description: session.profile.description,
          digitalAssets: [{ label: 'Website', url: session.profile.websiteUrl }],
          targetMarkets: [{ locale: session.profile.locale, market: session.profile.market }],
        },
      });
      if (profileResult.outcome === 'SUCCEEDED') {
        profileId = profileResult.profile.profileId;
      }
    }

    const offeringIds: string[] = [];
    if (profileId !== null) {
      const selected = session.offerings.filter((offering) =>
        input.offeringCandidateIds.includes(offering.candidateId),
      );
      for (const candidate of selected) {
        const offeringResult = await this.profileOffering.createOffering({
          actorSubject: input.actorSubject,
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          profileId,
          content: {
            kind: candidate.kind,
            name: candidate.name,
            locale: candidate.locale,
            market: candidate.market,
            taxonomy: [],
            principle: candidate.description,
            specifications: [],
            features: [],
            usage: [],
            applicationScenarios: [],
            compatibility: [],
            evidenceHints: [session.url],
            attributes: [],
          },
        });
        if (offeringResult.outcome === 'SUCCEEDED') {
          offeringIds.push(offeringResult.offering.offeringId);
        }
      }
    }

    const confirmed: WebsiteImportSession = { ...session, status: 'CONFIRMED' };
    await this.store.save(confirmed);
    return {
      outcome: 'SUCCEEDED',
      importId: session.importId,
      profileId,
      offeringIds,
      pendingFaqs: session.faqs,
    };
  }

  async getSession(input: {
    actorSubject: string;
    tenantId: string;
    workspaceId: string;
    importId: string;
  }): Promise<WebsiteImportGetResult> {
    const context = await this.tenancy.resolveTenantContext(input);
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) {
      return { outcome: 'NOT_FOUND' };
    }
    const session = await this.store.find({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      importId: input.importId,
    });
    if (session === null) {
      return { outcome: 'NOT_FOUND' };
    }
    return { outcome: 'SUCCEEDED', session };
  }
}
