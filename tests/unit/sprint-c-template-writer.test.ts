import { canonicalArtifactJson } from '@aeostudio/application/artifacts';
import { TemplateContentWriter } from '@aeostudio/application/writer';
import type { ArtifactEvidenceBinding, ArtifactWriterContext } from '@aeostudio/domain/artifacts';
import { describe, expect, test } from 'vitest';

function evidence(sourceId: string): ArtifactEvidenceBinding {
  return {
    sourceId,
    snapshotId: `snapshot-${sourceId}`,
    sourceHash: `hash-${sourceId}`,
  };
}

function buildContext(overrides?: {
  claims?: ArtifactWriterContext['claims'];
}): ArtifactWriterContext {
  return {
    schemaVersion: '1.0.0',
    type: 'DEFINITION_PRODUCT',
    locale: 'en-US',
    market: 'global',
    methodPolicyVersion: 'artifact-fixture-v1',
    brief: {
      id: '00000000-0000-7000-8000-000000000910',
      contentHash: 'brief-hash',
      title: 'Acme Analytics',
      promptIds: ['prompt-1'],
      sourceArtifactIds: [],
      lineage: {
        contentPlanId: 'plan-1',
        brief: { id: '00000000-0000-7000-8000-000000000910', contentHash: 'brief-hash' },
        prompt: {
          promptSetId: 'prompt-set-1',
          promptRevisionId: 'prompt-revision-1',
          contentHash: 'prompt-hash',
          promptIds: ['prompt-1'],
        },
        sourceReferences: [],
      },
    },
    claims: overrides?.claims ?? [
      {
        claimId: 'claim-1',
        revisionId: 'claim-revision-1',
        contentHash: 'claim-1-hash',
        statement: 'Acme Analytics provides evidence-backed AEO insights.',
        conditions: {},
        evidence: [evidence('source-1'), evidence('source-1'), evidence('source-2')],
      },
    ],
  };
}

const BASE_DISCLOSURE =
  'This draft is evidence-backed but remains subject to exact-revision human review. It does not guarantee ranking, citation, recommendation, traffic, conversion or revenue.';

describe('TemplateContentWriter', () => {
  test('produces the historical deterministic payload shape', async () => {
    const writer = new TemplateContentWriter();
    const payload = await writer.generateDraft({ context: buildContext() });

    expect(payload.title).toBe('Definition and offering: Acme Analytics');
    expect(payload.summary).toBe('Acme Analytics provides evidence-backed AEO insights.');
    expect(payload.sections).toEqual([
      {
        heading: 'Definition and offering',
        body: 'Acme Analytics provides evidence-backed AEO insights.',
      },
      {
        heading: 'Evidence and scope',
        body: 'Locale en-US; market global; every factual statement is bound to an approved Claim revision.',
      },
    ]);
    expect(payload.claimMap).toEqual([
      {
        claimRevisionId: 'claim-revision-1',
        statement: 'Acme Analytics provides evidence-backed AEO insights.',
        evidenceSourceIds: ['source-1', 'source-2'],
      },
    ]);
    expect(payload.disclosure).toBe(BASE_DISCLOSURE);
  });

  test('is deterministic: identical input yields identical canonical payload', async () => {
    const writer = new TemplateContentWriter();
    const context = buildContext();
    const first = await writer.generateDraft({ context });
    const second = await writer.generateDraft({ context });

    expect(canonicalArtifactJson(first)).toBe(canonicalArtifactJson(second));
  });

  test('accepts a WriterPolicy without changing deterministic output', async () => {
    const writer = new TemplateContentWriter();
    const context = buildContext();
    const baseline = await writer.generateDraft({ context });
    const withPolicy = await writer.generateDraft({
      context,
      policy: { temperature: 0.9, topP: 0.95, maxTokens: 2048, seed: 42 },
    });

    expect(withPolicy).toEqual(baseline);
  });

  test('flags claims without backing Evidence as pending verification', async () => {
    const writer = new TemplateContentWriter();
    const context = buildContext({
      claims: [
        {
          claimId: 'claim-1',
          revisionId: 'claim-revision-1',
          contentHash: 'claim-1-hash',
          statement: 'Supported statement.',
          conditions: {},
          evidence: [evidence('source-1')],
        },
        {
          claimId: 'claim-2',
          revisionId: 'claim-revision-2',
          contentHash: 'claim-2-hash',
          statement: 'Unsupported statement.',
          conditions: {},
          evidence: [],
        },
      ],
    });

    const payload = await writer.generateDraft({ context });

    expect(payload.disclosure).toBe(
      `${BASE_DISCLOSURE} Pending verification: 1 claim(s) lack backing Evidence and must not be published as fact.`,
    );
    expect(payload.claimMap[1]?.evidenceSourceIds).toEqual([]);
  });
});
