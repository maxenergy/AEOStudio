import type { SiteCrawlStore } from '@aeostudio/application/site-crawl';

export class MissingSiteCrawlStore implements SiteCrawlStore {
  createSite(): ReturnType<SiteCrawlStore['createSite']> {
    return Promise.reject(new Error('SITE_CRAWL_STORE_NOT_CONFIGURED'));
  }

  findSite(): ReturnType<SiteCrawlStore['findSite']> {
    return Promise.reject(new Error('SITE_CRAWL_STORE_NOT_CONFIGURED'));
  }

  createVerification(): ReturnType<SiteCrawlStore['createVerification']> {
    return Promise.reject(new Error('SITE_CRAWL_STORE_NOT_CONFIGURED'));
  }

  findVerification(): ReturnType<SiteCrawlStore['findVerification']> {
    return Promise.reject(new Error('SITE_CRAWL_STORE_NOT_CONFIGURED'));
  }

  markVerified(): ReturnType<SiteCrawlStore['markVerified']> {
    return Promise.reject(new Error('SITE_CRAWL_STORE_NOT_CONFIGURED'));
  }

  findBaseline(): ReturnType<SiteCrawlStore['findBaseline']> {
    return Promise.reject(new Error('SITE_CRAWL_STORE_NOT_CONFIGURED'));
  }
}
