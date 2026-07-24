import { CreateEvidenceSnapshotRequestSchema } from '@aeostudio/contracts/evidence-claims';
import { describe, expect, test } from 'vitest';

describe('Task 6 server-owned Evidence trust root', () => {
  test('the public Snapshot request accepts source bytes but rejects client-authored object metadata', () => {
    expect(
      CreateEvidenceSnapshotRequestSchema.safeParse({
        contentBase64: Buffer.from('Exact supporting excerpt.', 'utf8').toString('base64'),
        contentType: 'text/plain',
      }).success,
    ).toBe(true);

    expect(
      CreateEvidenceSnapshotRequestSchema.safeParse({
        contentHash: 'a'.repeat(64),
        objectRef: `s3://untrusted-client/${'a'.repeat(64)}`,
        contentType: 'text/plain',
        sizeBytes: 27,
      }).success,
    ).toBe(false);
  });
});
