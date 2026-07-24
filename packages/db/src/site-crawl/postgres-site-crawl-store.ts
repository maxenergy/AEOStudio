import type { SiteCrawlExecutionStore, SiteCrawlStore } from '@aeostudio/application/site-crawl';
import type { TenantContext } from '@aeostudio/application/identity-access';
import type {
  BaselineFindingRecord,
  CrawlSnapshotRecord,
  SiteBaselineRecord,
  SiteRecord,
  SiteStatus,
  SiteVerificationMethod,
  SiteVerificationRecord,
} from '@aeostudio/domain/site-crawl';
import type { Pool, PoolClient } from 'pg';

import { TenantContextRunner } from '../tenant-context/tenant-context-runner.js';

interface SiteRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  profile_id: string;
  origin: string;
  hostname: string;
  status: SiteStatus;
  verified_at: Date | null;
}

interface SiteVerificationRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  site_id: string;
  method: SiteVerificationMethod;
  challenge_token: string;
  challenge_path: string | null;
  status: 'PENDING' | 'VERIFIED';
  verified_at: Date | null;
}

interface CrawlRunRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  site_id: string;
  job_id: string;
  status: SiteBaselineRecord['status'];
  error_code: string | null;
  page_count: number;
  total_bytes: string;
  completed_at: Date;
}

interface CrawlSnapshotRow {
  id: string;
  url: string;
  checksum: string;
  content_type: string;
  size_bytes: string;
  captured_at: Date;
  object_ref: string;
}

interface BaselineFindingRow {
  id: string;
  snapshot_id: string;
  finding_type: string;
  severity: BaselineFindingRecord['severity'];
  detail: string;
}

export class PostgresSiteCrawlStore implements SiteCrawlStore, SiteCrawlExecutionStore {
  private readonly contexts: TenantContextRunner;

  constructor(pool: Pool) {
    this.contexts = new TenantContextRunner(pool);
  }

  createSite(input: Parameters<SiteCrawlStore['createSite']>[0]): Promise<SiteRecord | null> {
    return this.contexts.run(input.context, async (client) => {
      const profile = await client.query<{ id: string }>(
        'SELECT id FROM profiles WHERE id = $1 AND workspace_id = $2',
        [input.profileId, input.context.workspaceId],
      );
      if (profile.rows[0] === undefined) {
        return null;
      }
      const inserted = await client.query<SiteRow>(
        `INSERT INTO sites
          (id, tenant_id, workspace_id, profile_id, origin, hostname)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, tenant_id, workspace_id, profile_id, origin, hostname, status,
           verified_at`,
        [
          input.siteId,
          input.context.tenantId,
          input.context.workspaceId,
          input.profileId,
          input.origin,
          input.hostname,
        ],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome)
         VALUES ($1, $2, $3, $4, 'SITE_REGISTERED', 'SITE', $5, 'SUCCEEDED')`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.siteId,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error('SITE_DID_NOT_RETURN_RESULT');
      }
      return this.mapSite(row);
    });
  }

  findSite(input: Parameters<SiteCrawlStore['findSite']>[0]): Promise<SiteRecord | null> {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<SiteRow>(
        `SELECT id, tenant_id, workspace_id, profile_id, origin, hostname, status, verified_at
         FROM sites
         WHERE id = $1 AND workspace_id = $2`,
        [input.siteId, input.context.workspaceId],
      );
      const row = result.rows[0];
      return row === undefined ? null : this.mapSite(row);
    });
  }

  createVerification(
    input: Parameters<SiteCrawlStore['createVerification']>[0],
  ): Promise<SiteVerificationRecord | null> {
    return this.contexts.run(input.context, async (client) => {
      const inserted = await client.query<SiteVerificationRow>(
        `INSERT INTO site_verifications
          (id, tenant_id, workspace_id, site_id, method, challenge_token, challenge_path)
         SELECT $1, $2, $3, site.id, $4, $5, $6
         FROM sites site
         WHERE site.id = $7 AND site.workspace_id = $3
         RETURNING id, tenant_id, workspace_id, site_id, method, challenge_token,
           challenge_path, status, verified_at`,
        [
          input.verificationId,
          input.context.tenantId,
          input.context.workspaceId,
          input.method,
          input.challengeToken,
          input.challengePath,
          input.siteId,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        return null;
      }
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome, metadata)
         VALUES ($1, $2, $3, $4, 'SITE_VERIFICATION_CREATED', 'SITE_VERIFICATION', $5,
           'SUCCEEDED', jsonb_build_object('method', $6::text))`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.verificationId,
          input.method,
        ],
      );
      return this.mapVerification(row);
    });
  }

  findVerification(
    input: Parameters<SiteCrawlStore['findVerification']>[0],
  ): ReturnType<SiteCrawlStore['findVerification']> {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<SiteRow & SiteVerificationRow>(
        `SELECT
           site.id, site.tenant_id, site.workspace_id, site.profile_id, site.origin,
           site.hostname, site.status, site.verified_at,
           verification.id AS verification_id,
           verification.tenant_id AS verification_tenant_id,
           verification.workspace_id AS verification_workspace_id,
           verification.site_id, verification.method, verification.challenge_token,
           verification.challenge_path, verification.status AS verification_status,
           verification.verified_at AS verification_verified_at
         FROM sites site
         JOIN site_verifications verification ON verification.site_id = site.id
           AND verification.tenant_id = site.tenant_id
         WHERE site.id = $1 AND verification.id = $2 AND site.workspace_id = $3`,
        [input.siteId, input.verificationId, input.context.workspaceId],
      );
      const row = result.rows[0] as
        | (SiteRow & {
            verification_id: string;
            verification_tenant_id: string;
            verification_workspace_id: string;
            site_id: string;
            method: SiteVerificationMethod;
            challenge_token: string;
            challenge_path: string | null;
            verification_status: 'PENDING' | 'VERIFIED';
            verification_verified_at: Date | null;
          })
        | undefined;
      return row === undefined
        ? null
        : {
            site: this.mapSite(row),
            verification: this.mapVerification({
              id: row.verification_id,
              tenant_id: row.verification_tenant_id,
              workspace_id: row.verification_workspace_id,
              site_id: row.site_id,
              method: row.method,
              challenge_token: row.challenge_token,
              challenge_path: row.challenge_path,
              status: row.verification_status,
              verified_at: row.verification_verified_at,
            }),
          };
    });
  }

  markVerified(input: Parameters<SiteCrawlStore['markVerified']>[0]): Promise<SiteRecord | null> {
    return this.contexts.run(input.context, async (client) => {
      const verification = await client.query(
        `UPDATE site_verifications
         SET status = 'VERIFIED', verified_at = $1
         WHERE id = $2 AND site_id = $3 AND workspace_id = $4
         RETURNING id`,
        [input.verifiedAt, input.verificationId, input.siteId, input.context.workspaceId],
      );
      if (verification.rows[0] === undefined) {
        return null;
      }
      const updated = await client.query<SiteRow>(
        `UPDATE sites
         SET status = 'VERIFIED', verified_at = $1
         WHERE id = $2 AND workspace_id = $3
         RETURNING id, tenant_id, workspace_id, profile_id, origin, hostname, status,
           verified_at`,
        [input.verifiedAt, input.siteId, input.context.workspaceId],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
            outcome)
         VALUES ($1, $2, $3, $4, 'SITE_VERIFIED', 'SITE', $5, 'SUCCEEDED')`,
        [
          input.auditEventId,
          input.context.tenantId,
          input.context.workspaceId,
          input.context.actorUserId,
          input.siteId,
        ],
      );
      const row = updated.rows[0];
      return row === undefined ? null : this.mapSite(row);
    });
  }

  findBaseline(
    input: Parameters<SiteCrawlStore['findBaseline']>[0],
  ): ReturnType<SiteCrawlStore['findBaseline']> {
    return this.contexts.run(input.context, (client) =>
      this.loadBaseline(client, 'site_id', input.siteId),
    );
  }

  listBaselines(
    input: Parameters<SiteCrawlStore['listBaselines']>[0],
  ): ReturnType<SiteCrawlStore['listBaselines']> {
    return this.contexts.run(input.context, async (client) => {
      const result = await client.query<CrawlRunRow>(
        `SELECT id, tenant_id, workspace_id, site_id, job_id, status, error_code,
           page_count, total_bytes::text, completed_at
         FROM crawl_runs
         WHERE workspace_id = $1
         ORDER BY completed_at DESC, id DESC`,
        [input.context.workspaceId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        siteId: row.site_id,
        status: row.status,
        pageCount: row.page_count,
        completedAt: row.completed_at.toISOString(),
      }));
    });
  }

  persistBaseline(
    input: Parameters<SiteCrawlExecutionStore['persistBaseline']>[0],
  ): ReturnType<SiteCrawlExecutionStore['persistBaseline']> {
    return this.contexts.run(this.workerContext(input), async (client) => {
      const existing = await this.loadBaseline(client, 'job_id', input.jobId);
      if (existing !== null) {
        return existing;
      }
      const job = await client.query<{ id: string }>(
        `SELECT id FROM jobs
         WHERE id = $1 AND workspace_id = $2 AND job_type = 'SITE_CRAWL'
           AND aggregate_id = $3`,
        [input.jobId, input.workspaceId, input.siteId],
      );
      if (job.rows[0] === undefined) {
        throw new Error('CRAWL_JOB_SCOPE_INVALID');
      }
      const snapshotIds = new Set(input.snapshots.map((snapshot) => snapshot.id));
      if (input.findings.some((finding) => !snapshotIds.has(finding.snapshotId))) {
        throw new Error('FINDING_SNAPSHOT_REFERENCE_INVALID');
      }
      await client.query(
        `INSERT INTO crawl_runs
          (id, tenant_id, workspace_id, site_id, job_id, status, error_code, page_count,
            total_bytes, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          input.crawlId,
          input.tenantId,
          input.workspaceId,
          input.siteId,
          input.jobId,
          input.status,
          input.errorCode,
          input.pageCount,
          input.totalBytes,
          input.completedAt,
        ],
      );
      for (const snapshot of input.snapshots) {
        await client.query(
          `INSERT INTO crawl_snapshots
            (id, tenant_id, workspace_id, crawl_id, site_id, url, checksum, content_type,
              size_bytes, captured_at, object_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            snapshot.id,
            input.tenantId,
            input.workspaceId,
            input.crawlId,
            input.siteId,
            snapshot.url,
            snapshot.checksum,
            snapshot.contentType,
            snapshot.sizeBytes,
            snapshot.capturedAt,
            snapshot.objectRef,
          ],
        );
      }
      for (const finding of input.findings) {
        await client.query(
          `INSERT INTO baseline_findings
            (id, tenant_id, workspace_id, crawl_id, snapshot_id, finding_type, severity,
              detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            finding.id,
            input.tenantId,
            input.workspaceId,
            input.crawlId,
            finding.snapshotId,
            finding.findingType,
            finding.severity,
            finding.detail,
          ],
        );
      }
      const baseline = await this.loadBaseline(client, 'job_id', input.jobId);
      if (baseline === null) {
        throw new Error('PERSISTED_BASELINE_NOT_FOUND');
      }
      return baseline;
    });
  }

  loadVerifiedSite(
    job: Parameters<SiteCrawlExecutionStore['loadVerifiedSite']>[0],
  ): ReturnType<SiteCrawlExecutionStore['loadVerifiedSite']> {
    return this.contexts.run(
      this.workerContext({
        tenantId: job.tenantId,
        workspaceId: job.workspaceId,
        jobId: job.id,
      }),
      async (client) => {
        if (job.jobType !== 'SITE_CRAWL') {
          return null;
        }
        const result = await client.query<SiteRow>(
          `SELECT id, tenant_id, workspace_id, profile_id, origin, hostname, status, verified_at
         FROM sites
         WHERE id = $1 AND workspace_id = $2 AND status = 'VERIFIED'`,
          [job.aggregateId, job.workspaceId],
        );
        const row = result.rows[0];
        return row === undefined ? null : this.mapSite(row);
      },
    );
  }

  private async loadBaseline(
    client: PoolClient,
    key: 'job_id' | 'site_id',
    value: string,
  ): Promise<SiteBaselineRecord | null> {
    const runResult = await client.query<CrawlRunRow>(
      `SELECT id, tenant_id, workspace_id, site_id, job_id, status, error_code,
         page_count, total_bytes::text, completed_at
       FROM crawl_runs
       WHERE ${key} = $1
       ORDER BY completed_at DESC, id DESC
       LIMIT 1`,
      [value],
    );
    const run = runResult.rows[0];
    if (run === undefined) {
      return null;
    }
    const [snapshotResult, findingResult] = await Promise.all([
      client.query<CrawlSnapshotRow>(
        `SELECT id, url, checksum, content_type, size_bytes::text, captured_at, object_ref
         FROM crawl_snapshots WHERE crawl_id = $1 ORDER BY captured_at, id`,
        [run.id],
      ),
      client.query<BaselineFindingRow>(
        `SELECT id, snapshot_id, finding_type, severity, detail
         FROM baseline_findings WHERE crawl_id = $1 ORDER BY id`,
        [run.id],
      ),
    ]);
    return {
      id: run.id,
      tenantId: run.tenant_id,
      workspaceId: run.workspace_id,
      siteId: run.site_id,
      jobId: run.job_id,
      status: run.status,
      errorCode: run.error_code,
      pageCount: run.page_count,
      totalBytes: Number(run.total_bytes),
      completedAt: run.completed_at.toISOString(),
      snapshots: snapshotResult.rows.map((row): CrawlSnapshotRecord => ({
        id: row.id,
        url: row.url,
        checksum: row.checksum,
        contentType: row.content_type,
        sizeBytes: Number(row.size_bytes),
        capturedAt: row.captured_at.toISOString(),
        objectRef: row.object_ref,
      })),
      findings: findingResult.rows.map((row): BaselineFindingRecord => ({
        id: row.id,
        snapshotId: row.snapshot_id,
        findingType: row.finding_type,
        severity: row.severity,
        detail: row.detail,
      })),
    };
  }

  private workerContext(input: {
    tenantId: string;
    workspaceId: string;
    jobId: string;
  }): TenantContext {
    return {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      actorUserId: input.jobId,
      membershipId: input.jobId,
      role: 'OWNER',
    };
  }

  private mapSite(row: SiteRow): SiteRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      profileId: row.profile_id,
      origin: row.origin,
      hostname: row.hostname,
      status: row.status,
      verifiedAt: row.verified_at?.toISOString() ?? null,
    };
  }

  private mapVerification(row: SiteVerificationRow): SiteVerificationRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      siteId: row.site_id,
      method: row.method,
      challengeToken: row.challenge_token,
      challengePath: row.challenge_path,
      status: row.status,
      verifiedAt: row.verified_at?.toISOString() ?? null,
    };
  }
}
