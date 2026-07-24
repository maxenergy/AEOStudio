import { describe, expect, it } from 'vitest';
import {
  validateEvidenceSource,
  validateAlternativeComparisonEligibility,
  classifyEvidenceOwnership,
  type EvidenceSourceValidationInput,
  type AlternativeComparisonEligibilityInput,
  type EvidenceSourceRecord,
  type AlternativeReferenceRecord,
} from '@aeostudio/domain/evidence-claims';

function makeSource(overrides: Partial<EvidenceSourceRecord> = {}): EvidenceSourceRecord {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    tenantId: '00000000-0000-7000-8000-000000000002',
    workspaceId: '00000000-0000-7000-8000-000000000003',
    sourceType: 'UPLOAD',
    title: 'Test Evidence',
    uri: null,
    license: 'proprietary',
    publicity: 'PRIVATE',
    ownershipClass: 'OWNED',
    currentSnapshotId: null,
    createdAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  };
}

function makeSourceWithoutOwnership(): EvidenceSourceRecord {
  const source = makeSource();
  const { ownershipClass: _omitted, ...rest } = source;
  void _omitted;
  return rest;
}

function makeAlternative(
  overrides: Partial<AlternativeReferenceRecord> = {},
): AlternativeReferenceRecord {
  return {
    id: '00000000-0000-7000-8000-000000000010',
    tenantId: '00000000-0000-7000-8000-000000000002',
    workspaceId: '00000000-0000-7000-8000-000000000003',
    kind: 'DIRECT_COMPETITOR',
    name: 'Competitor Product',
    description: 'A competing product in the market',
    websiteUri: 'https://competitor.example.com',
    evidenceSourceIds: ['00000000-0000-7000-8000-000000000001'],
    hasIndependentEvidence: true,
    market: 'US',
    locale: 'en-US',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('C02: Evidence Ownership & Competitor Reference', () => {
  describe('Evidence source ownership validation', () => {
    function makeValidationInput(
      overrides: Partial<EvidenceSourceValidationInput> = {},
    ): EvidenceSourceValidationInput {
      return {
        source: makeSource(),
        isSiteVerified: true,
        hasIndependentEvidence: true,
        ...overrides,
      };
    }

    it('accepts valid owned source with verification', () => {
      const result = validateEvidenceSource(makeValidationInput());
      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('rejects source without ownership class', () => {
      const result = validateEvidenceSource(
        makeValidationInput({ source: makeSourceWithoutOwnership() }),
      );
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.code === 'OWNERSHIP_CLASS_REQUIRED')).toBe(true);
    });

    it('rejects owned source without site verification', () => {
      const result = validateEvidenceSource(
        makeValidationInput({
          source: makeSource({ ownershipClass: 'OWNED' }),
          isSiteVerified: false,
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.code === 'OWNED_REQUIRES_VERIFICATION')).toBe(true);
    });

    it('rejects competitor source without independent evidence', () => {
      const result = validateEvidenceSource(
        makeValidationInput({
          source: makeSource({ ownershipClass: 'COMPETITOR' }),
          hasIndependentEvidence: false,
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.code === 'COMPETITOR_REQUIRES_INDEPENDENT_EVIDENCE')).toBe(
        true,
      );
    });

    it('accepts public source without verification requirement', () => {
      const result = validateEvidenceSource(
        makeValidationInput({
          source: makeSource({ ownershipClass: 'PUBLIC' }),
          isSiteVerified: false,
        }),
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('Alternative comparison eligibility', () => {
    function makeEligibilityInput(
      overrides: Partial<AlternativeComparisonEligibilityInput> = {},
    ): AlternativeComparisonEligibilityInput {
      return {
        alternative: makeAlternative(),
        independentEvidenceSources: [makeSource({ ownershipClass: 'PUBLIC' })],
        ...overrides,
      };
    }

    it('accepts eligible alternative with independent evidence', () => {
      const result = validateAlternativeComparisonEligibility(makeEligibilityInput());
      expect(result.eligible).toBe(true);
      expect(result.independentEvidenceCount).toBe(1);
      expect(result.ineligibleReasons).toEqual([]);
    });

    it('rejects alternative without independent evidence', () => {
      const result = validateAlternativeComparisonEligibility(
        makeEligibilityInput({
          independentEvidenceSources: [makeSource({ ownershipClass: 'OWNED' })],
        }),
      );
      expect(result.eligible).toBe(false);
      expect(result.ineligibleReasons).toContain('NO_INDEPENDENT_EVIDENCE');
    });

    it('rejects alternative without name', () => {
      const result = validateAlternativeComparisonEligibility(
        makeEligibilityInput({ alternative: makeAlternative({ name: '' }) }),
      );
      expect(result.eligible).toBe(false);
      expect(result.ineligibleReasons).toContain('MISSING_NAME');
    });

    it('counts multiple independent evidence sources', () => {
      const result = validateAlternativeComparisonEligibility(
        makeEligibilityInput({
          independentEvidenceSources: [
            makeSource({ id: '1', ownershipClass: 'PUBLIC' }),
            makeSource({ id: '2', ownershipClass: 'COMPETITOR' }),
            makeSource({ id: '3', ownershipClass: 'OWNED' }),
          ],
        }),
      );
      expect(result.independentEvidenceCount).toBe(2);
    });
  });

  describe('Evidence ownership classification', () => {
    it('classifies verified crawl as OWNED', () => {
      const result = classifyEvidenceOwnership({
        sourceType: 'CRAWL',
        isSiteVerified: true,
        isCompetitorSource: false,
      });
      expect(result).toBe('OWNED');
    });

    it('classifies unverified crawl as PUBLIC', () => {
      const result = classifyEvidenceOwnership({
        sourceType: 'CRAWL',
        isSiteVerified: false,
        isCompetitorSource: false,
      });
      expect(result).toBe('PUBLIC');
    });

    it('classifies competitor source as COMPETITOR', () => {
      const result = classifyEvidenceOwnership({
        sourceType: 'CRAWL',
        isSiteVerified: true,
        isCompetitorSource: true,
      });
      expect(result).toBe('COMPETITOR');
    });

    it('classifies upload as PUBLIC by default', () => {
      const result = classifyEvidenceOwnership({
        sourceType: 'UPLOAD',
        isSiteVerified: false,
        isCompetitorSource: false,
      });
      expect(result).toBe('PUBLIC');
    });
  });

  describe('Determinism', () => {
    it('same input produces same validation result', () => {
      const input: EvidenceSourceValidationInput = {
        source: makeSource(),
        isSiteVerified: true,
        hasIndependentEvidence: true,
      };
      const result1 = validateEvidenceSource(input);
      const result2 = validateEvidenceSource(input);
      expect(result1).toEqual(result2);
    });

    it('same classification input produces same result', () => {
      const input = {
        sourceType: 'CRAWL' as const,
        isSiteVerified: true,
        isCompetitorSource: false,
      };
      const result1 = classifyEvidenceOwnership(input);
      const result2 = classifyEvidenceOwnership(input);
      expect(result1).toBe(result2);
    });
  });
});
