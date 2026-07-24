import { createHash } from 'node:crypto';

import type { CrawlObjectStorage } from '@aeostudio/application/site-crawl';

interface StoredObject {
  body: Uint8Array;
  checksum: string;
  contentType: string;
}

export class FakeS3ObjectStorage implements CrawlObjectStorage {
  private readonly objects = new Map<string, StoredObject>();

  get size(): number {
    return this.objects.size;
  }

  putObject(input: Parameters<CrawlObjectStorage['putObject']>[0]): Promise<{ objectRef: string }> {
    const checksum = createHash('sha256').update(input.body).digest('hex');
    if (checksum !== input.checksum) {
      return Promise.reject(new Error('SNAPSHOT_CHECKSUM_MISMATCH'));
    }
    const existing = this.objects.get(input.key);
    if (existing !== undefined && existing.checksum !== checksum) {
      return Promise.reject(new Error('CONTENT_ADDRESSED_OBJECT_CONFLICT'));
    }
    this.objects.set(input.key, {
      body: new Uint8Array(input.body),
      checksum,
      contentType: input.contentType,
    });
    return Promise.resolve({ objectRef: `s3+memory://crawl-snapshots/${input.key}` });
  }

  readObject(key: string): StoredObject | null {
    const stored = this.objects.get(key);
    return stored === undefined ? null : { ...stored, body: new Uint8Array(stored.body) };
  }
}
