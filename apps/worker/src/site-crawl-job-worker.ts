import {
  JobWorkerCoordinator,
  type JobClaimResult,
  type JobQueueMessage,
} from '@aeostudio/application/jobs-budgets';
import type { SiteCrawlExecutionStore } from '@aeostudio/application/site-crawl';

import type { CrawlPolicy, SiteCrawlHandler } from './site-crawl-handler.js';

export type SiteCrawlJobOutcome =
  | { outcome: JobClaimResult['outcome'] }
  | { outcome: 'SUCCEEDED' | 'RETRY_WAIT' | 'FAILED_TERMINAL' | 'LEASE_LOST'; crawlId?: string };

const RETRYABLE_ZERO_PAGE_ERRORS = new Set([
  'DNS_NO_ADDRESS',
  'FETCH_TIMEOUT',
  'SNAPSHOT_STORAGE_FAILED',
  'TRANSPORT_ERROR',
]);

export class SiteCrawlJobWorker {
  constructor(
    private readonly coordinator: JobWorkerCoordinator,
    private readonly crawls: SiteCrawlExecutionStore,
    private readonly handler: SiteCrawlHandler,
    private readonly ids: { next(): string },
    private readonly clock: { now(): Date },
  ) {}

  async process(message: JobQueueMessage, policy: CrawlPolicy): Promise<SiteCrawlJobOutcome> {
    const claimed = await this.coordinator.claim(message);
    if (claimed.outcome !== 'CLAIMED') {
      return { outcome: claimed.outcome };
    }
    const { lease } = claimed;
    if (lease.job.jobType !== 'SITE_CRAWL') {
      await this.coordinator.fail(lease, 'TERMINAL', 'UNSUPPORTED_JOB_TYPE');
      return { outcome: 'FAILED_TERMINAL' };
    }
    if (!(await this.coordinator.reportProgress(lease, 10))) {
      return { outcome: 'LEASE_LOST' };
    }
    let leaseAlive = true;
    const heartbeat = setInterval(() => {
      void this.coordinator
        .heartbeat(lease)
        .then((alive) => {
          leaseAlive &&= alive;
        })
        .catch(() => {
          leaseAlive = false;
        });
    }, JobWorkerCoordinator.heartbeatIntervalMs);
    try {
      const site = await this.crawls.loadVerifiedSite(lease.job);
      if (site === null) {
        await this.coordinator.fail(lease, 'TERMINAL', 'VERIFIED_SITE_NOT_FOUND');
        return { outcome: 'FAILED_TERMINAL' };
      }
      const result = await this.handler.run(site, policy);
      leaseAlive &&= await this.coordinator.heartbeat(lease);
      if (!leaseAlive) {
        return { outcome: 'LEASE_LOST' };
      }
      if (
        result.pageCount === 0 &&
        result.errorCode !== null &&
        RETRYABLE_ZERO_PAGE_ERRORS.has(result.errorCode)
      ) {
        const retryStatus = await this.coordinator.fail(lease, 'RETRYABLE', result.errorCode);
        if (retryStatus === false) {
          return { outcome: 'LEASE_LOST' };
        }
        return {
          outcome: retryStatus === 'RETRY_WAIT' ? 'RETRY_WAIT' : 'FAILED_TERMINAL',
        };
      }
      const crawlId = this.ids.next();
      await this.crawls.persistBaseline({
        tenantId: lease.job.tenantId,
        workspaceId: lease.job.workspaceId,
        siteId: site.id,
        jobId: lease.job.id,
        crawlId,
        status: result.status,
        errorCode: result.errorCode,
        pageCount: result.pageCount,
        totalBytes: result.totalBytes,
        completedAt: this.clock.now(),
        snapshots: result.snapshots,
        findings: result.findings,
      });
      if (result.status === 'FAILED_TERMINAL') {
        await this.coordinator.fail(lease, 'TERMINAL', result.errorCode ?? 'CRAWL_FAILED_TERMINAL');
        return { outcome: 'FAILED_TERMINAL', crawlId };
      }
      if (!(await this.coordinator.reportProgress(lease, 90))) {
        return { outcome: 'LEASE_LOST', crawlId };
      }
      const actualUnits = Math.min(lease.job.estimatedUnits, Math.max(1, result.pageCount + 1));
      const completed = await this.coordinator.complete(
        lease,
        {
          crawlId,
          baselineStatus: result.status,
          pageCount: result.pageCount,
          totalBytes: result.totalBytes,
          errorCode: result.errorCode,
        },
        actualUnits,
      );
      return completed ? { outcome: 'SUCCEEDED', crawlId } : { outcome: 'LEASE_LOST', crawlId };
    } finally {
      clearInterval(heartbeat);
    }
  }
}
