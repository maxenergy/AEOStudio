import { InMemoryArtifactPayloadStore } from '@aeostudio/adapters/generation';
import type { ArtifactPayload } from '@aeostudio/domain/artifacts';
import { describe, expect, test } from 'vitest';

const payload: ArtifactPayload = {
  title: 'Artifact title',
  summary: 'Immutable summary',
  sections: [{ heading: 'Evidence', body: 'Evidence-backed body.' }],
  claimMap: [
    {
      claimRevisionId: '00000000-0000-7000-8000-000000000901',
      statement: 'Approved statement.',
      evidenceSourceIds: ['00000000-0000-7000-8000-000000000902'],
    },
  ],
  disclosure: 'Method disclosure.',
};

describe('Task 9 content-addressed Artifact payload storage', () => {
  test('rejects conflicting bytes at an existing immutable object reference', async () => {
    const store = new InMemoryArtifactPayloadStore();
    const input = {
      tenantId: '00000000-0000-7000-8000-000000000903',
      workspaceId: '00000000-0000-7000-8000-000000000904',
      artifactId: '00000000-0000-7000-8000-000000000905',
      revision: 1,
      contentHash: 'a'.repeat(64),
      payload,
    };
    const stored = await store.put(input);
    await expect(
      store.put({ ...input, payload: { ...payload, summary: 'Tampered.' } }),
    ).rejects.toThrow('ARTIFACT_PAYLOAD_CONFLICT');
    expect(await store.get(stored.objectRef)).toEqual(payload);
    await expect(store.put(input)).resolves.toEqual(stored);
  });
});
