import { resolveTxt } from 'node:dns/promises';

import type { CrawlPageFetcher, SiteOwnershipVerifier } from '@aeostudio/application/site-crawl';

import { createNodeSafeCrawlerFetch } from './node-safe-crawler-fetch.js';

const DNS_LOOKUP_TIMEOUT_MS = 5_000;

export interface SiteOwnershipTxtResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
}

export class NodeSiteOwnershipTxtResolver implements SiteOwnershipTxtResolver {
  resolveTxt(hostname: string): Promise<string[][]> {
    return resolveTxt(hostname);
  }
}

export function createNodeSafeSiteOwnershipVerifier(): SafeSiteOwnershipVerifier {
  return new SafeSiteOwnershipVerifier(
    new NodeSiteOwnershipTxtResolver(),
    createNodeSafeCrawlerFetch(),
  );
}

export class SafeSiteOwnershipVerifier implements SiteOwnershipVerifier {
  constructor(
    private readonly dns: SiteOwnershipTxtResolver,
    private readonly fetcher: CrawlPageFetcher,
  ) {}

  async verify(
    input: Parameters<SiteOwnershipVerifier['verify']>[0],
  ): Promise<{ matched: boolean }> {
    if (!hasConsistentSiteOrigin(input.site.origin, input.site.hostname)) {
      return { matched: false };
    }
    if (input.method === 'FILE') {
      return this.verifyFile(input);
    }
    if (input.method !== 'DNS' || input.challengePath !== '_aeostudio-verification') {
      return { matched: false };
    }
    const challengeHostname = `${input.challengePath}.${input.site.hostname}`;
    let records: string[][] | null;
    try {
      records = await this.resolveTxtWithinDeadline(challengeHostname);
    } catch {
      return { matched: false };
    }
    if (records === null) return { matched: false };
    return {
      matched: records.some((chunks) => chunks.join('') === input.expectedToken),
    };
  }

  private async resolveTxtWithinDeadline(hostname: string): Promise<string[][] | null> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolveDeadline) => {
      timeout = setTimeout(() => resolveDeadline(null), DNS_LOOKUP_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.dns.resolveTxt(hostname), deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async verifyFile(
    input: Parameters<SiteOwnershipVerifier['verify']>[0],
  ): Promise<{ matched: boolean }> {
    if (input.challengePath !== '/.well-known/aeostudio-verification') {
      return { matched: false };
    }
    const challengeUrl = new URL(input.challengePath, input.site.origin).href;
    let result: Awaited<ReturnType<CrawlPageFetcher['fetch']>>;
    try {
      result = await this.fetcher.fetch({
        url: challengeUrl,
        allowedHostname: input.site.hostname,
        maxBytes: 4_096,
        timeoutMs: 5_000,
      });
    } catch {
      return { matched: false };
    }
    if (
      result.outcome !== 'SUCCEEDED' ||
      result.response.status !== 200 ||
      result.finalUrl !== challengeUrl
    ) {
      return { matched: false };
    }
    const expectedBytes = new TextEncoder().encode(input.expectedToken);
    return {
      matched:
        result.response.body.byteLength === expectedBytes.byteLength &&
        result.response.body.every((value, index) => value === expectedBytes[index]),
    };
  }
}

function hasConsistentSiteOrigin(origin: string, hostname: string): boolean {
  try {
    const url = new URL(origin);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.origin === origin &&
      url.hostname.toLowerCase() === hostname.toLowerCase()
    );
  } catch {
    return false;
  }
}
