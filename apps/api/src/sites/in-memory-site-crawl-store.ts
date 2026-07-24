import { createHash, randomUUID } from 'node:crypto';

import type { SiteCrawlStore } from '@aeostudio/application/site-crawl';
import type { JobRecord } from '@aeostudio/domain/jobs-budgets';
import type {
  SiteBaselineRecord,
  SiteRecord,
  SiteVerificationRecord,
} from '@aeostudio/domain/site-crawl';

import type { InMemoryAuditSink } from '../privacy/in-memory-audit-sink.js';

export class InMemorySiteCrawlStore implements SiteCrawlStore {
  private readonly sites = new Map<string, SiteRecord>();
  private readonly verifications = new Map<string, SiteVerificationRecord>();
  private readonly baselines = new Map<string, SiteBaselineRecord>();

  public constructor(private readonly audit?: InMemoryAuditSink) {}

  createSite(input: Parameters<SiteCrawlStore['createSite']>[0]): Promise<SiteRecord | null> {
    const site: SiteRecord = {
      id: input.siteId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      profileId: input.profileId,
      origin: input.origin,
      hostname: input.hostname,
      status: 'UNVERIFIED',
      verifiedAt: null,
    };
    this.sites.set(site.id, site);
    this.audit?.append({
      id: input.auditEventId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      actorId: input.context.actorUserId,
      action: 'SITE_CREATED',
      resourceType: 'SITE',
      resourceId: site.id,
      outcome: 'SUCCEEDED',
      metadata: { profileId: site.profileId },
    });
    return Promise.resolve(structuredClone(site));
  }

  findSite(input: Parameters<SiteCrawlStore['findSite']>[0]): Promise<SiteRecord | null> {
    const site = this.sites.get(input.siteId);
    return Promise.resolve(
      site !== undefined &&
        site.tenantId === input.context.tenantId &&
        site.workspaceId === input.context.workspaceId
        ? structuredClone(site)
        : null,
    );
  }

  createVerification(
    input: Parameters<SiteCrawlStore['createVerification']>[0],
  ): Promise<SiteVerificationRecord | null> {
    const site = this.sites.get(input.siteId);
    if (
      site === undefined ||
      site.tenantId !== input.context.tenantId ||
      site.workspaceId !== input.context.workspaceId
    ) {
      return Promise.resolve(null);
    }
    const verification: SiteVerificationRecord = {
      id: input.verificationId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      siteId: input.siteId,
      method: input.method,
      challengeToken: input.challengeToken,
      challengePath: input.challengePath,
      status: 'PENDING',
      verifiedAt: null,
    };
    this.verifications.set(verification.id, verification);
    this.audit?.append({
      id: input.auditEventId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      actorId: input.context.actorUserId,
      action: 'SITE_VERIFICATION_CREATED',
      resourceType: 'SITE_VERIFICATION',
      resourceId: verification.id,
      outcome: 'SUCCEEDED',
      metadata: { method: verification.method, siteId: verification.siteId },
    });
    return Promise.resolve(structuredClone(verification));
  }

  findVerification(
    input: Parameters<SiteCrawlStore['findVerification']>[0],
  ): ReturnType<SiteCrawlStore['findVerification']> {
    const site = this.sites.get(input.siteId);
    const verification = this.verifications.get(input.verificationId);
    return Promise.resolve(
      site !== undefined &&
        verification !== undefined &&
        site.tenantId === input.context.tenantId &&
        site.workspaceId === input.context.workspaceId &&
        verification.siteId === site.id
        ? { site: structuredClone(site), verification: structuredClone(verification) }
        : null,
    );
  }

  markVerified(input: Parameters<SiteCrawlStore['markVerified']>[0]): Promise<SiteRecord | null> {
    const site = this.sites.get(input.siteId);
    const verification = this.verifications.get(input.verificationId);
    if (
      site === undefined ||
      verification === undefined ||
      site.tenantId !== input.context.tenantId ||
      site.workspaceId !== input.context.workspaceId ||
      verification.siteId !== site.id
    ) {
      return Promise.resolve(null);
    }
    const verifiedAt = input.verifiedAt.toISOString();
    site.status = 'VERIFIED';
    site.verifiedAt = verifiedAt;
    verification.status = 'VERIFIED';
    verification.verifiedAt = verifiedAt;
    this.audit?.append({
      id: input.auditEventId,
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      actorId: input.context.actorUserId,
      action: 'SITE_VERIFIED',
      resourceType: 'SITE',
      resourceId: site.id,
      outcome: 'SUCCEEDED',
      metadata: { method: verification.method, verificationId: verification.id },
      occurredAt: input.verifiedAt,
    });
    return Promise.resolve(structuredClone(site));
  }

  findBaseline(
    input: Parameters<SiteCrawlStore['findBaseline']>[0],
  ): ReturnType<SiteCrawlStore['findBaseline']> {
    const baseline = this.baselines.get(input.siteId);
    return Promise.resolve(
      baseline !== undefined &&
        baseline.tenantId === input.context.tenantId &&
        baseline.workspaceId === input.context.workspaceId
        ? structuredClone(baseline)
        : null,
    );
  }

  recordCompletedCrawl(job: JobRecord): void {
    if (job.jobType !== 'SITE_CRAWL') {
      return;
    }
    const site = this.sites.get(job.aggregateId);
    if (
      site === undefined ||
      site.tenantId !== job.tenantId ||
      site.workspaceId !== job.workspaceId
    ) {
      return;
    }
    const capturedAt = new Date().toISOString();
    const fixtures = [
      { suffix: 'robots.txt', contentType: 'text/plain', content: 'User-agent: *\nAllow: /' },
      {
        suffix: 'sitemap.xml',
        contentType: 'application/xml',
        content: `<urlset><url><loc>${site.origin}/</loc></url></urlset>`,
      },
      {
        suffix: '',
        contentType: 'text/html',
        content: '<html><head><title>Fixture baseline</title></head><body>Content</body></html>',
      },
    ];
    const snapshots = fixtures.map((fixture) => {
      const id = randomUUID();
      const checksum = createHash('sha256').update(fixture.content).digest('hex');
      return {
        id,
        url: `${site.origin}/${fixture.suffix}`,
        checksum,
        contentType: fixture.contentType,
        sizeBytes: Buffer.byteLength(fixture.content),
        capturedAt,
        objectRef: `s3+memory://crawl-snapshots/${site.tenantId}/${site.id}/${checksum}`,
      };
    });
    const pageSnapshot = snapshots[2];
    if (pageSnapshot === undefined) {
      throw new Error('FAKE_PAGE_SNAPSHOT_MISSING');
    }
    this.baselines.set(site.id, {
      id: randomUUID(),
      tenantId: site.tenantId,
      workspaceId: site.workspaceId,
      siteId: site.id,
      jobId: job.id,
      status: 'COMPLETE',
      errorCode: null,
      pageCount: 1,
      totalBytes: snapshots.reduce((total, snapshot) => total + snapshot.sizeBytes, 0),
      completedAt: capturedAt,
      snapshots,
      findings: [
        {
          id: randomUUID(),
          snapshotId: pageSnapshot.id,
          findingType: 'HTTP_STATUS',
          severity: 'INFO',
          detail: '200',
        },
      ],
    });
  }
}
