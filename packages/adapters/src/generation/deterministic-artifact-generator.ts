import type { ArtifactGenerator } from '@aeostudio/application/artifacts';
import type { ArtifactPayload, ArtifactWriterContext } from '@aeostudio/domain/artifacts';

const TYPE_LABELS = {
  DEFINITION_PRODUCT: 'Definition and offering',
  COMPARISON: 'Evidence-balanced comparison',
  TECHNICAL_EVIDENCE: 'Technical and evidence',
} as const;

export class DeterministicArtifactGenerator implements ArtifactGenerator {
  generate(context: ArtifactWriterContext): Promise<ArtifactPayload> {
    const label = TYPE_LABELS[context.type];
    const claimText = context.claims.map((claim) => claim.statement).join(' ');
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
      disclosure:
        'This draft is evidence-backed but remains subject to exact-revision human review. It does not guarantee ranking, citation, recommendation, traffic, conversion or revenue.',
    });
  }
}
