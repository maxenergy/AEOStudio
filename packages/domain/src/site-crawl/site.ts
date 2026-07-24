export type SiteStatus = 'UNVERIFIED' | 'VERIFIED';

export interface SiteRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  profileId: string;
  origin: string;
  hostname: string;
  status: SiteStatus;
  verifiedAt: string | null;
}

export type SiteVerificationMethod = 'DNS' | 'FILE' | 'OAUTH' | 'ADMIN';

export interface SiteVerificationRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  siteId: string;
  method: SiteVerificationMethod;
  challengeToken: string;
  challengePath: string | null;
  status: 'PENDING' | 'VERIFIED';
  verifiedAt: string | null;
}

export interface CrawlSnapshotRecord {
  id: string;
  url: string;
  checksum: string;
  contentType: string;
  sizeBytes: number;
  capturedAt: string;
  objectRef: string;
}

export interface BaselineFindingRecord {
  id: string;
  snapshotId: string;
  findingType: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
  detail: string;
}

export interface SiteBaselineRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  siteId: string;
  jobId: string;
  status: 'COMPLETE' | 'PARTIAL' | 'FAILED_TERMINAL';
  errorCode: string | null;
  pageCount: number;
  totalBytes: number;
  completedAt: string;
  snapshots: CrawlSnapshotRecord[];
  findings: BaselineFindingRecord[];
}
