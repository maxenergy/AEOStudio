import type { TenantContext } from '../identity-access/index.js';
import type { JobRecord } from '@aeostudio/domain/jobs-budgets';
import type {
  SiteBaselineRecord,
  SiteRecord,
  SiteVerificationMethod,
  SiteVerificationRecord,
} from '@aeostudio/domain/site-crawl';

export interface SiteOwnershipVerifier {
  verify(input: {
    site: SiteRecord;
    method: SiteVerificationMethod;
    expectedToken: string;
    challengePath: string | null;
  }): Promise<{ matched: boolean }>;
}

export interface CrawlFetchResponse {
  status: number;
  contentType: string | null;
  body: Uint8Array;
}

export type CrawlFetchResult =
  | { outcome: 'SUCCEEDED'; finalUrl: string; response: CrawlFetchResponse }
  | { outcome: 'SSRF_BLOCKED' | 'FETCH_FAILED'; errorCode: string };

export interface CrawlPageFetcher {
  fetch(input: {
    url: string;
    allowedHostname: string;
    maxBytes: number;
    timeoutMs: number;
  }): Promise<CrawlFetchResult>;
}

export interface CrawlObjectStorage {
  putObject(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
    checksum: string;
  }): Promise<{ objectRef: string }>;
}

export interface SiteCrawlStore {
  createSite(input: {
    context: TenantContext;
    siteId: string;
    profileId: string;
    origin: string;
    hostname: string;
    auditEventId: string;
  }): Promise<SiteRecord | null>;
  findSite(input: { context: TenantContext; siteId: string }): Promise<SiteRecord | null>;
  createVerification(input: {
    context: TenantContext;
    verificationId: string;
    siteId: string;
    method: SiteVerificationMethod;
    challengeToken: string;
    challengePath: string | null;
    auditEventId: string;
  }): Promise<SiteVerificationRecord | null>;
  findVerification(input: {
    context: TenantContext;
    siteId: string;
    verificationId: string;
  }): Promise<{ site: SiteRecord; verification: SiteVerificationRecord } | null>;
  markVerified(input: {
    context: TenantContext;
    siteId: string;
    verificationId: string;
    verifiedAt: Date;
    auditEventId: string;
  }): Promise<SiteRecord | null>;
  findBaseline(input: {
    context: TenantContext;
    siteId: string;
  }): Promise<SiteBaselineRecord | null>;
}

export interface PersistSiteBaselineInput {
  tenantId: string;
  workspaceId: string;
  siteId: string;
  jobId: string;
  crawlId: string;
  status: SiteBaselineRecord['status'];
  errorCode: string | null;
  pageCount: number;
  totalBytes: number;
  completedAt: Date;
  snapshots: SiteBaselineRecord['snapshots'];
  findings: SiteBaselineRecord['findings'];
}

export interface SiteCrawlExecutionStore {
  loadVerifiedSite(job: JobRecord): Promise<SiteRecord | null>;
  persistBaseline(input: PersistSiteBaselineInput): Promise<SiteBaselineRecord>;
}
