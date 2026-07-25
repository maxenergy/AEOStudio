import { validateFactEvidence } from '@aeostudio/application/writer';
import type { ArtifactPayload } from '@aeostudio/domain/artifacts';
import { describe, expect, test } from 'vitest';

function buildPayload(claimMap: ArtifactPayload['claimMap']): ArtifactPayload {
  return {
    title: 'Definition and offering: Acme Analytics',
    summary: 'Acme Analytics provides evidence-backed AEO insights.',
    sections: [{ heading: 'Definition and offering', body: 'body' }],
    claimMap,
    disclosure: 'disclosure',
  };
}

describe('validateFactEvidence', () => {
  test('reports supported when every claim has backing Evidence', () => {
    const result = validateFactEvidence(
      buildPayload([
        {
          claimRevisionId: 'claim-revision-1',
          statement: 'Supported statement.',
          evidenceSourceIds: ['source-1'],
        },
        {
          claimRevisionId: 'claim-revision-2',
          statement: 'Another supported statement.',
          evidenceSourceIds: ['source-2', 'source-3'],
        },
      ]),
    );

    expect(result.supported).toBe(true);
    expect(result.unsupportedClaimRevisionIds).toEqual([]);
  });

  test('reports unsupported when a claim has no Evidence', () => {
    const result = validateFactEvidence(
      buildPayload([
        {
          claimRevisionId: 'claim-revision-1',
          statement: 'Supported statement.',
          evidenceSourceIds: ['source-1'],
        },
        {
          claimRevisionId: 'claim-revision-2',
          statement: 'Unsupported statement.',
          evidenceSourceIds: [],
        },
      ]),
    );

    expect(result.supported).toBe(false);
    expect(result.unsupportedClaimRevisionIds).toEqual(['claim-revision-2']);
  });

  test('collects every unsupported claim revision id', () => {
    const result = validateFactEvidence(
      buildPayload([
        {
          claimRevisionId: 'claim-revision-1',
          statement: 'First unsupported.',
          evidenceSourceIds: [],
        },
        {
          claimRevisionId: 'claim-revision-2',
          statement: 'Supported.',
          evidenceSourceIds: ['source-1'],
        },
        {
          claimRevisionId: 'claim-revision-3',
          statement: 'Second unsupported.',
          evidenceSourceIds: [],
        },
      ]),
    );

    expect(result.supported).toBe(false);
    expect(result.unsupportedClaimRevisionIds).toEqual(['claim-revision-1', 'claim-revision-3']);
  });
});
