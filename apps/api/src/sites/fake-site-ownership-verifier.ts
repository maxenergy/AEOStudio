import type { SiteOwnershipVerifier } from '@aeostudio/application/site-crawl';

export class FakeSiteOwnershipVerifier implements SiteOwnershipVerifier {
  verify(): Promise<{ matched: boolean }> {
    return Promise.resolve({ matched: true });
  }
}
