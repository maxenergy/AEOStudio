import type { ArtifactPayload, ArtifactWriterContext } from '@aeostudio/domain/artifacts';

import type { ContentWriter, WriterPolicy } from './ports.js';

const TYPE_LABELS = {
  DEFINITION_PRODUCT: 'Definition and offering',
  COMPARISON: 'Evidence-balanced comparison',
  TECHNICAL_EVIDENCE: 'Technical and evidence',
} as const;

const BASE_DISCLOSURE =
  'This draft is evidence-backed but remains subject to exact-revision human review. It does not guarantee ranking, citation, recommendation, traffic, conversion or revenue.';

/**
 * Deterministic restricted writer. Produces byte-for-byte the same payload as
 * the historical DeterministicArtifactGenerator when every claim carries
 * Evidence (the fixture and approved-claim paths), so exact-revision content
 * hashes remain stable. Claims without backing Evidence are surfaced as
 * "pending verification" in the disclosure instead of being asserted as fact.
 *
 * The optional WriterPolicy is accepted for interface parity with a future LLM
 * adapter but never influences deterministic output.
 */
export class TemplateContentWriter implements ContentWriter {
  generateDraft(input: {
    context: ArtifactWriterContext;
    policy?: WriterPolicy;
  }): Promise<ArtifactPayload> {
    const context = input.context;
    const label = TYPE_LABELS[context.type];
    const claimText = context.claims.map((claim) => claim.statement).join(' ');
    const pendingVerification = context.claims.filter((claim) => claim.evidence.length === 0);
    const disclosure =
      pendingVerification.length === 0
        ? BASE_DISCLOSURE
        : `${BASE_DISCLOSURE} Pending verification: ${pendingVerification.length} claim(s) lack backing Evidence and must not be published as fact.`;
    return Promise.resolve({
      title: `${label}: ${context.brief.title}`,
      summary: claimText,
      sections: [
        {
          heading: label,
          body: claimText,
        },
        {
          heading: 'Evidence and scope',
          body: `Locale ${context.locale}; market ${context.market}; every factual statement is bound to an approved Claim revision.`,
        },
      ],
      claimMap: context.claims.map((claim) => ({
        claimRevisionId: claim.revisionId,
        statement: claim.statement,
        evidenceSourceIds: [...new Set(claim.evidence.map((evidence) => evidence.sourceId))],
      })),
      disclosure,
    });
  }
}
