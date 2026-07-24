import { createHash, randomUUID } from 'node:crypto';

import type {
  EvidenceObjectRead,
  EvidenceObjectRecord,
  EvidenceObjectStore,
  EvidenceObjectWrite,
} from '@aeostudio/application/evidence-claims';

interface StoredEvidenceObject extends EvidenceObjectRecord {
  body: Uint8Array;
}

/** Explicit fake-runtime object boundary; it never represents an AWS success. */
export class InMemoryEvidenceObjectStore implements EvidenceObjectStore {
  private readonly objects = new Map<string, StoredEvidenceObject>();

  public constructor(private readonly ids: { next(): string } = { next: randomUUID }) {}

  ingestExact(input: EvidenceObjectWrite): Promise<EvidenceObjectRecord> {
    if (
      input.body.byteLength !== input.sizeBytes ||
      createHash('sha256').update(input.body).digest('hex') !== input.contentHash
    ) {
      return Promise.reject(new Error('EVIDENCE_OBJECT_METADATA_MISMATCH'));
    }
    const objectVersionId = this.ids.next();
    const key =
      `tenants/${input.tenantId}/workspaces/${input.workspaceId}` +
      `/evidence-sources/${input.sourceId}/snapshots/${input.snapshotId}/${input.contentHash}`;
    const record: StoredEvidenceObject = {
      ...input,
      objectRef: `memory+evidence://objects/${key}?versionId=${encodeURIComponent(objectVersionId)}`,
      objectVersionId,
      body: input.body.slice(),
    };
    this.objects.set(this.key(record.objectRef, objectVersionId), record);
    return Promise.resolve(this.withoutBody(record));
  }

  readExact(input: EvidenceObjectRecord): Promise<EvidenceObjectRead | null> {
    const stored = this.objects.get(this.key(input.objectRef, input.objectVersionId));
    if (stored === undefined || !sameMetadata(stored, input)) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ ...this.withoutBody(stored), body: stored.body.slice() });
  }

  /** Test/fake-runtime control used to prove physical object currentness checks. */
  deleteExact(input: { objectRef: string; objectVersionId: string }): boolean {
    return this.objects.delete(this.key(input.objectRef, input.objectVersionId));
  }

  private key(objectRef: string, objectVersionId: string): string {
    return `${objectRef}\u0000${objectVersionId}`;
  }

  private withoutBody(input: StoredEvidenceObject): EvidenceObjectRecord {
    const { body: _, ...record } = input;
    return record;
  }
}

function sameMetadata(left: EvidenceObjectRecord, right: EvidenceObjectRecord): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.workspaceId === right.workspaceId &&
    left.sourceId === right.sourceId &&
    left.snapshotId === right.snapshotId &&
    left.objectRef === right.objectRef &&
    left.objectVersionId === right.objectVersionId &&
    left.contentHash === right.contentHash &&
    left.contentType === right.contentType &&
    left.sizeBytes === right.sizeBytes
  );
}
