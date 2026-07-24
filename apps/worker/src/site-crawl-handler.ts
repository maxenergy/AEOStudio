import type { CrawlObjectStorage, CrawlPageFetcher } from '@aeostudio/application/site-crawl';
import type { SiteRecord } from '@aeostudio/domain/site-crawl';

export interface CrawlPolicy {
  maxPages: number;
  maxBytes: number;
  timeoutMs: number;
}

export const MAX_CRAWL_PAGES = 500;
export const MAX_CRAWL_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_CRAWL_PAGE_BYTES = 10 * 1024 * 1024;

interface RobotsRule {
  allow: boolean;
  pattern: RegExp;
  specificity: number;
}

export interface CrawlSnapshotResult {
  id: string;
  url: string;
  checksum: string;
  contentType: string;
  sizeBytes: number;
  capturedAt: string;
  objectRef: string;
}

export interface BaselineFindingResult {
  id: string;
  snapshotId: string;
  findingType: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
  detail: string;
}

export interface SiteCrawlResult {
  status: 'COMPLETE' | 'PARTIAL' | 'FAILED_TERMINAL';
  errorCode: string | null;
  pageCount: number;
  totalBytes: number;
  snapshots: CrawlSnapshotResult[];
  findings: BaselineFindingResult[];
}

export class SiteCrawlHandler {
  constructor(
    private readonly fetcher: CrawlPageFetcher,
    private readonly storage: CrawlObjectStorage,
    private readonly ids: { next(): string },
    private readonly clock: { now(): Date },
  ) {}

  async run(site: SiteRecord, policy: CrawlPolicy): Promise<SiteCrawlResult> {
    if (site.status !== 'VERIFIED') {
      return this.failure('SITE_NOT_VERIFIED');
    }
    const limits = {
      maxPages: Math.min(Math.max(1, policy.maxPages), MAX_CRAWL_PAGES),
      maxBytes: Math.min(Math.max(1, policy.maxBytes), MAX_CRAWL_BYTES),
      timeoutMs: Math.max(1, policy.timeoutMs),
    };
    const snapshots: CrawlSnapshotResult[] = [];
    const findings: BaselineFindingResult[] = [];
    let totalBytes = 0;
    let errorCode: string | null = null;
    let robotsRules: RobotsRule[] = [];
    let robotsSnapshotId: string | null = null;

    const capture = async (url: string, acceptedTypes: string[]) => {
      const remainingBytes = limits.maxBytes - totalBytes;
      if (remainingBytes < 1) {
        return { outcome: 'FETCH_FAILED', errorCode: 'BYTE_LIMIT_REACHED' } as const;
      }
      const fetched = await this.fetcher.fetch({
        url,
        allowedHostname: site.hostname,
        maxBytes: Math.min(remainingBytes, MAX_CRAWL_PAGE_BYTES),
        timeoutMs: limits.timeoutMs,
      });
      if (fetched.outcome !== 'SUCCEEDED') {
        return { outcome: fetched.outcome, errorCode: fetched.errorCode } as const;
      }
      const contentType = fetched.response.contentType?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType === undefined || !acceptedTypes.includes(contentType)) {
        return { outcome: 'FETCH_FAILED', errorCode: 'UNSUPPORTED_CONTENT_TYPE' } as const;
      }
      const sizeBytes = fetched.response.body.byteLength;
      if (sizeBytes > limits.maxBytes - totalBytes) {
        return { outcome: 'FETCH_FAILED', errorCode: 'BYTE_LIMIT_REACHED' } as const;
      }
      const checksum = createHash('sha256').update(fetched.response.body).digest('hex');
      const snapshotId = this.ids.next();
      const key =
        `tenants/${site.tenantId}/workspaces/${site.workspaceId}/sites/` +
        `${site.id}/snapshots/${checksum}`;
      let objectRef: string;
      try {
        objectRef = (
          await this.storage.putObject({
            key,
            body: fetched.response.body,
            contentType,
            checksum,
          })
        ).objectRef;
      } catch {
        return { outcome: 'FETCH_FAILED', errorCode: 'SNAPSHOT_STORAGE_FAILED' } as const;
      }
      const snapshot: CrawlSnapshotResult = {
        id: snapshotId,
        url: fetched.finalUrl,
        checksum,
        contentType,
        sizeBytes,
        capturedAt: this.clock.now().toISOString(),
        objectRef,
      };
      snapshots.push(snapshot);
      totalBytes += sizeBytes;
      return {
        outcome: 'SUCCEEDED',
        snapshot,
        body: fetched.response.body,
        status: fetched.response.status,
      } as const;
    };

    const robots = await capture(`${site.origin}/robots.txt`, ['text/plain']);
    let sitemapUrl = `${site.origin}/sitemap.xml`;
    if (robots.outcome === 'SUCCEEDED') {
      robotsSnapshotId = robots.snapshot.id;
      this.addFinding(
        findings,
        robots.snapshot.id,
        'ROBOTS_PRESENT',
        'INFO',
        'robots.txt captured',
      );
      const sitemapDirective = /^\s*sitemap:\s*(\S+)\s*$/gim.exec(
        new TextDecoder().decode(robots.body),
      )?.[1];
      if (sitemapDirective !== undefined) {
        sitemapUrl = sitemapDirective;
      }
      robotsRules = this.parseRobotsRules(new TextDecoder().decode(robots.body));
    } else if (robots.outcome === 'SSRF_BLOCKED') {
      return { ...this.failure(robots.errorCode), snapshots, findings, totalBytes };
    } else {
      errorCode = robots.errorCode;
    }

    const sitemap = await capture(sitemapUrl, ['application/xml', 'text/xml']);
    const pageUrls = new Set<string>([`${site.origin}/`]);
    if (sitemap.outcome === 'SUCCEEDED') {
      this.addFinding(findings, sitemap.snapshot.id, 'SITEMAP_PRESENT', 'INFO', 'sitemap captured');
      for (const candidate of this.sitemapLocations(new TextDecoder().decode(sitemap.body))) {
        const canonical = this.allowedPageUrl(candidate, site.hostname);
        if (canonical !== null) {
          pageUrls.add(canonical);
        }
      }
    } else if (sitemap.outcome === 'SSRF_BLOCKED') {
      return { ...this.failure(sitemap.errorCode), snapshots, findings, totalBytes };
    } else {
      errorCode ??= sitemap.errorCode;
    }

    let pageCount = 0;
    for (const pageUrl of pageUrls) {
      if (!this.robotsAllows(pageUrl, robotsRules)) {
        if (robotsSnapshotId !== null) {
          this.addFinding(
            findings,
            robotsSnapshotId,
            'ROBOTS_BLOCKED',
            'INFO',
            `robots policy excluded ${pageUrl}`,
          );
        }
        continue;
      }
      if (pageCount >= limits.maxPages) {
        errorCode = 'PAGE_LIMIT_REACHED';
        break;
      }
      const page = await capture(pageUrl, ['text/html', 'application/xhtml+xml']);
      if (page.outcome !== 'SUCCEEDED') {
        if (page.outcome === 'SSRF_BLOCKED') {
          return { ...this.failure(page.errorCode), snapshots, findings, totalBytes, pageCount };
        }
        errorCode ??= page.errorCode;
        break;
      }
      pageCount += 1;
      this.analyzeHtml(new TextDecoder().decode(page.body), page.snapshot, page.status, findings);
    }

    return {
      status: errorCode === null ? 'COMPLETE' : 'PARTIAL',
      errorCode,
      pageCount,
      totalBytes,
      snapshots,
      findings,
    };
  }

  private failure(errorCode: string): SiteCrawlResult {
    return {
      status: 'FAILED_TERMINAL',
      errorCode,
      pageCount: 0,
      totalBytes: 0,
      snapshots: [],
      findings: [],
    };
  }

  private sitemapLocations(xml: string): string[] {
    return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) =>
      (match[1] ?? '').replaceAll('&amp;', '&'),
    );
  }

  private parseRobotsRules(text: string): RobotsRule[] {
    const groups: {
      userAgents: string[];
      rules: { allow: boolean; path: string }[];
    }[] = [];
    let userAgents: string[] = [];
    let rules: { allow: boolean; path: string }[] = [];
    const flush = () => {
      if (userAgents.length > 0) groups.push({ userAgents, rules });
      userAgents = [];
      rules = [];
    };
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.split('#', 1)[0]?.trim() ?? '';
      const separator = line.indexOf(':');
      if (separator < 0) {
        continue;
      }
      const key = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (key === 'user-agent') {
        if (rules.length > 0) flush();
        if (value.length > 0) userAgents.push(this.normalizeUserAgent(value));
      } else if (key === 'allow' || key === 'disallow') {
        if (userAgents.length > 0 && value.length > 0) {
          rules.push({ allow: key === 'allow', path: value });
        }
      }
    }
    flush();

    const crawlerToken = 'aeostudiocrawler';
    const specificGroups = groups.filter((group) => group.userAgents.includes(crawlerToken));
    const selected =
      specificGroups.length > 0
        ? specificGroups
        : groups.filter((group) => group.userAgents.includes('*'));
    return selected.flatMap((group) =>
      group.rules.map((rule) => this.compileRobotsRule(rule.allow, rule.path)),
    );
  }

  private robotsAllows(value: string, rules: RobotsRule[]): boolean {
    const url = new URL(value);
    const path = this.normalizeRobotsOctets(`${url.pathname}${url.search}`);
    const matching = rules
      .filter((rule) => rule.pattern.test(path))
      .sort(
        (left, right) =>
          right.specificity - left.specificity || Number(right.allow) - Number(left.allow),
      );
    return matching[0]?.allow ?? true;
  }

  private normalizeUserAgent(value: string): string {
    return value.trim().toLowerCase().split(/[/:\s]/u, 1)[0] ?? '';
  }

  private compileRobotsRule(allow: boolean, source: string): RobotsRule {
    const normalized = this.normalizeRobotsOctets(source);
    const endAnchored = normalized.endsWith('$');
    const path = endAnchored ? normalized.slice(0, -1) : normalized;
    const expression = path
      .split('*')
      .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&'))
      .join('.*');
    const literal = path.replaceAll('*', '');
    return {
      allow,
      pattern: new RegExp(`^${expression}${endAnchored ? '$' : ''}`, 'u'),
      specificity: new TextEncoder().encode(literal).byteLength,
    };
  }

  private normalizeRobotsOctets(value: string): string {
    return value.replace(/%[0-9a-f]{2}/giu, (encoded) => {
      const decoded = String.fromCharCode(Number.parseInt(encoded.slice(1), 16));
      return /^[A-Za-z0-9._~-]$/u.test(decoded) ? decoded : encoded.toUpperCase();
    });
  }

  private allowedPageUrl(value: string, allowedHostname: string): string | null {
    try {
      const url = new URL(value);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.hostname.toLowerCase() !== allowedHostname.toLowerCase()
      ) {
        return null;
      }
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  }

  private analyzeHtml(
    html: string,
    snapshot: CrawlSnapshotResult,
    status: number,
    findings: BaselineFindingResult[],
  ): void {
    this.addFinding(
      findings,
      snapshot.id,
      'HTTP_STATUS',
      status >= 400 ? 'ERROR' : 'INFO',
      String(status),
    );
    this.addPresenceFinding(findings, snapshot.id, 'TITLE', /<title\b[^>]*>\s*[^<]+/i.test(html));
    this.addPresenceFinding(
      findings,
      snapshot.id,
      'META_DESCRIPTION',
      /<meta\b(?=[^>]*\bname=["']description["'])[^>]*>/i.test(html),
    );
    this.addPresenceFinding(
      findings,
      snapshot.id,
      'CANONICAL',
      /<link\b(?=[^>]*\brel=["'][^"']*canonical[^"']*["'])[^>]*>/i.test(html),
    );
    this.addPresenceFinding(
      findings,
      snapshot.id,
      'STRUCTURED_DATA',
      /<script\b(?=[^>]*\btype=["']application\/ld\+json["'])[^>]*>/i.test(html),
    );
  }

  private addPresenceFinding(
    findings: BaselineFindingResult[],
    snapshotId: string,
    prefix: string,
    present: boolean,
  ): void {
    this.addFinding(
      findings,
      snapshotId,
      `${prefix}_${present ? 'PRESENT' : 'MISSING'}`,
      present ? 'INFO' : 'WARNING',
      present ? `${prefix.toLowerCase()} detected` : `${prefix.toLowerCase()} not detected`,
    );
  }

  private addFinding(
    findings: BaselineFindingResult[],
    snapshotId: string,
    findingType: string,
    severity: BaselineFindingResult['severity'],
    detail: string,
  ): void {
    findings.push({ id: this.ids.next(), snapshotId, findingType, severity, detail });
  }
}
import { createHash } from 'node:crypto';
