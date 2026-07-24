import type {
  EvidenceOwnershipClass,
  EvidenceSourceRecord,
  AlternativeReferenceRecord,
} from './evidence-claims.js';

// ============================================================================
// C02: Evidence Source Ownership Validation
// ============================================================================

export type EvidenceSourceIssueCode =
  | 'OWNERSHIP_CLASS_REQUIRED'
  | 'OWNED_REQUIRES_VERIFICATION'
  | 'COMPETITOR_REQUIRES_INDEPENDENT_EVIDENCE';

export interface EvidenceSourceIssue {
  code: EvidenceSourceIssueCode;
  message: string;
}

export interface EvidenceSourceValidationInput {
  source: EvidenceSourceRecord;
  isSiteVerified: boolean;
  hasIndependentEvidence: boolean;
}

export interface EvidenceSourceValidationResult {
  valid: boolean;
  issues: EvidenceSourceIssue[];
}

export function validateEvidenceSource(
  input: EvidenceSourceValidationInput,
): EvidenceSourceValidationResult {
  const issues: EvidenceSourceIssue[] = [];
  const { source, isSiteVerified, hasIndependentEvidence } = input;

  const ownershipClass = source.ownershipClass;

  if (ownershipClass === undefined) {
    issues.push({
      code: 'OWNERSHIP_CLASS_REQUIRED',
      message: 'Evidence source must have an ownership classification.',
    });
    return { valid: false, issues };
  }

  if (ownershipClass === 'OWNED' && !isSiteVerified) {
    issues.push({
      code: 'OWNED_REQUIRES_VERIFICATION',
      message: 'Owned evidence sources require site verification.',
    });
  }

  if (ownershipClass === 'COMPETITOR' && !hasIndependentEvidence) {
    issues.push({
      code: 'COMPETITOR_REQUIRES_INDEPENDENT_EVIDENCE',
      message: 'Competitor evidence sources require independent (non-tenant-owned) evidence.',
    });
  }

  return { valid: issues.length === 0, issues };
}

// ============================================================================
// C02: Alternative Comparison Eligibility
// ============================================================================

export type ComparisonIneligibilityReason =
  'NO_INDEPENDENT_EVIDENCE' | 'MISSING_NAME' | 'MISSING_KIND';

export interface AlternativeComparisonEligibilityInput {
  alternative: AlternativeReferenceRecord;
  independentEvidenceSources: EvidenceSourceRecord[];
}

export interface AlternativeComparisonEligibilityResult {
  eligible: boolean;
  independentEvidenceCount: number;
  ineligibleReasons: ComparisonIneligibilityReason[];
}

export function validateAlternativeComparisonEligibility(
  input: AlternativeComparisonEligibilityInput,
): AlternativeComparisonEligibilityResult {
  const ineligibleReasons: ComparisonIneligibilityReason[] = [];
  const { alternative, independentEvidenceSources } = input;

  if (alternative.name.trim().length === 0) {
    ineligibleReasons.push('MISSING_NAME');
  }

  if (alternative.kind === undefined) {
    ineligibleReasons.push('MISSING_KIND');
  }

  const independentCount = independentEvidenceSources.filter(
    (source) => source.ownershipClass !== 'OWNED',
  ).length;

  if (independentCount === 0) {
    ineligibleReasons.push('NO_INDEPENDENT_EVIDENCE');
  }

  return {
    eligible: ineligibleReasons.length === 0,
    independentEvidenceCount: independentCount,
    ineligibleReasons,
  };
}

// ============================================================================
// C02: Evidence Ownership Classification Helper
// ============================================================================

export function classifyEvidenceOwnership(input: {
  sourceType: EvidenceSourceRecord['sourceType'];
  isSiteVerified: boolean;
  isCompetitorSource: boolean;
}): EvidenceOwnershipClass {
  if (input.isCompetitorSource) {
    return 'COMPETITOR';
  }
  if (input.sourceType === 'CRAWL' && input.isSiteVerified) {
    return 'OWNED';
  }
  return 'PUBLIC';
}
