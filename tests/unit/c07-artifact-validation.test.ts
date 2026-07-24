import { describe, expect, it } from 'vitest';
import {
  validateArtifactOutput,
  type ArtifactOutputValidationInput,
  type ArtifactOutputValidationIssue,
} from '@aeostudio/domain/artifacts';

function makeInput(
  overrides: Partial<ArtifactOutputValidationInput> = {},
): ArtifactOutputValidationInput {
  return {
    payload: {
      title: 'Guided Learning Sessions Overview',
      summary: 'A comprehensive overview of AIBOX Guided Learning Sessions.',
      sections: [
        { heading: 'What is it?', body: 'Guided Learning Sessions is an AI-powered platform.' },
        {
          heading: 'Evidence',
          body: 'Studies show a 40% improvement in completion rates.',
        },
      ],
      claimMap: [
        {
          claimRevisionId: '00000000-0000-7000-8000-000000000005',
          statement: 'Guided Learning Sessions improve learner completion rates by 40%',
          evidenceSourceIds: ['00000000-0000-7000-8000-000000000031'],
        },
      ],
      disclosure: 'Content generated with AI assistance. Claims verified against evidence.',
    },
    approvedClaimRevisionIds: ['00000000-0000-7000-8000-000000000005'],
    approvedEvidenceSnapshotIds: ['00000000-0000-7000-8000-000000000031'],
    artifactType: 'DEFINITION_PRODUCT',
    ...overrides,
  };
}

describe('C07: Evidence-Grounded Artifact Validation', () => {
  describe('Claim mapping validation', () => {
    it('accepts valid artifact with all claims mapped', () => {
      const issues = validateArtifactOutput(makeInput());
      expect(issues).toEqual([]);
    });

    it('rejects artifact referencing non-existent claim revision', () => {
      const issues = validateArtifactOutput(
        makeInput({
          payload: {
            ...makeInput().payload,
            claimMap: [
              {
                claimRevisionId: '00000000-0000-7000-8000-000000000999',
                statement: 'Non-existent claim',
                evidenceSourceIds: ['00000000-0000-7000-8000-000000000031'],
              },
            ],
          },
        }),
      );
      expect(issues.some((i: ArtifactOutputValidationIssue) => i.code === 'UNMAPPED_CLAIM')).toBe(
        true,
      );
    });

    it('rejects artifact with empty claim map', () => {
      const issues = validateArtifactOutput(
        makeInput({
          payload: { ...makeInput().payload, claimMap: [] },
        }),
      );
      expect(issues.some((i: ArtifactOutputValidationIssue) => i.code === 'EMPTY_CLAIM_MAP')).toBe(
        true,
      );
    });
  });

  describe('Forbidden guarantee language', () => {
    it('rejects artifact with ranking guarantee', () => {
      const issues = validateArtifactOutput(
        makeInput({
          payload: {
            ...makeInput().payload,
            sections: [
              {
                heading: 'Benefits',
                body: 'This will guarantee you rank #1 on Google.',
              },
            ],
          },
        }),
      );
      expect(
        issues.some((i: ArtifactOutputValidationIssue) => i.code === 'FORBIDDEN_GUARANTEE'),
      ).toBe(true);
    });

    it('rejects artifact promising traffic or revenue', () => {
      const issues = validateArtifactOutput(
        makeInput({
          payload: {
            ...makeInput().payload,
            summary: 'This will definitely increase your traffic by 200%.',
          },
        }),
      );
      expect(
        issues.some((i: ArtifactOutputValidationIssue) => i.code === 'FORBIDDEN_GUARANTEE'),
      ).toBe(true);
    });

    it('accepts artifact without forbidden language', () => {
      const issues = validateArtifactOutput(makeInput());
      expect(
        issues.some((i: ArtifactOutputValidationIssue) => i.code === 'FORBIDDEN_GUARANTEE'),
      ).toBe(false);
    });
  });

  describe('Hallucination detection', () => {
    it('rejects numeric claims not present in approved claims', () => {
      const issues = validateArtifactOutput(
        makeInput({
          payload: {
            ...makeInput().payload,
            sections: [
              {
                heading: 'Results',
                body: 'Our platform achieves 99.9% uptime and 500% ROI.',
              },
            ],
          },
          approvedClaimRevisionIds: ['00000000-0000-7000-8000-000000000005'],
        }),
      );
      expect(
        issues.some((i: ArtifactOutputValidationIssue) => i.code === 'UNSUPPORTED_NUMERIC'),
      ).toBe(true);
    });
  });

  describe('Structural validation', () => {
    it('rejects artifact with empty title', () => {
      const issues = validateArtifactOutput(
        makeInput({
          payload: { ...makeInput().payload, title: '' },
        }),
      );
      expect(
        issues.some((i: ArtifactOutputValidationIssue) => i.code === 'MISSING_REQUIRED_FIELD'),
      ).toBe(true);
    });

    it('rejects artifact with empty summary', () => {
      const issues = validateArtifactOutput(
        makeInput({
          payload: { ...makeInput().payload, summary: '' },
        }),
      );
      expect(
        issues.some((i: ArtifactOutputValidationIssue) => i.code === 'MISSING_REQUIRED_FIELD'),
      ).toBe(true);
    });

    it('rejects artifact with no sections', () => {
      const issues = validateArtifactOutput(
        makeInput({
          payload: { ...makeInput().payload, sections: [] },
        }),
      );
      expect(
        issues.some((i: ArtifactOutputValidationIssue) => i.code === 'MISSING_REQUIRED_FIELD'),
      ).toBe(true);
    });

    it('rejects artifact without disclosure', () => {
      const issues = validateArtifactOutput(
        makeInput({
          payload: { ...makeInput().payload, disclosure: '' },
        }),
      );
      expect(
        issues.some((i: ArtifactOutputValidationIssue) => i.code === 'MISSING_DISCLOSURE'),
      ).toBe(true);
    });
  });

  describe('Comparison balance', () => {
    it('rejects comparison artifact without independent evidence', () => {
      const issues = validateArtifactOutput(
        makeInput({
          artifactType: 'COMPARISON',
          payload: {
            ...makeInput().payload,
            claimMap: [
              {
                claimRevisionId: '00000000-0000-7000-8000-000000000005',
                statement: 'Our product is the best',
                evidenceSourceIds: ['00000000-0000-7000-8000-000000000031'],
              },
            ],
          },
          approvedEvidenceSnapshotIds: ['00000000-0000-7000-8000-000000000031'],
          comparisonEvidenceIndependent: false,
        }),
      );
      expect(
        issues.some(
          (i: ArtifactOutputValidationIssue) => i.code === 'COMPARISON_EVIDENCE_NOT_INDEPENDENT',
        ),
      ).toBe(true);
    });
  });

  describe('Determinism', () => {
    it('same input produces same validation result', () => {
      const input = makeInput();
      const issues1 = validateArtifactOutput(input);
      const issues2 = validateArtifactOutput(input);
      expect(issues1).toEqual(issues2);
    });
  });
});
