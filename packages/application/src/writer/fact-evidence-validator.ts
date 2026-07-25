import type { ArtifactPayload } from '@aeostudio/domain/artifacts';

export interface FactEvidenceValidationResult {
  supported: boolean;
  unsupportedClaimRevisionIds: string[];
}

/**
 * Evidence-first gate for generated content. A claim is UNSUPPORTED when its
 * claim-map entry carries no backing Evidence source ids. Any UNSUPPORTED claim
 * makes the whole payload unsupported so publication can be blocked with a
 * transparent failure code rather than asserting unverified facts.
 */
export function validateFactEvidence(payload: ArtifactPayload): FactEvidenceValidationResult {
  const unsupportedClaimRevisionIds = payload.claimMap
    .filter((entry) => entry.evidenceSourceIds.length === 0)
    .map((entry) => entry.claimRevisionId);
  return {
    supported: unsupportedClaimRevisionIds.length === 0,
    unsupportedClaimRevisionIds,
  };
}
