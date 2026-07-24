import { ArtifactPayloadSchema } from '@aeostudio/contracts/artifacts';
import type { ArtifactClaimBinding, ArtifactPayload } from '@aeostudio/domain/artifacts';

export function validateArtifactPayload(
  input: unknown,
  bindings: ArtifactClaimBinding[],
): ArtifactPayload | null {
  const parsed = ArtifactPayloadSchema.safeParse(input);
  if (!parsed.success || !artifactPayloadMatchesBindings(parsed.data, bindings)) return null;
  return parsed.data;
}

export function artifactPayloadMatchesBindings(
  payload: ArtifactPayload,
  bindings: ArtifactClaimBinding[],
): boolean {
  if (payload.claimMap.length !== bindings.length) return false;
  const claims = new Map(payload.claimMap.map((claim) => [claim.claimRevisionId, claim]));
  if (claims.size !== payload.claimMap.length) return false;
  return bindings.every((binding) => {
    const claim = claims.get(binding.claimRevisionId);
    if (claim === undefined || claim.statement !== binding.claimStatement) return false;
    const expectedSources = [...new Set(binding.evidence.map((entry) => entry.sourceId))].sort();
    const actualSources = [...new Set(claim.evidenceSourceIds)].sort();
    return (
      actualSources.length === claim.evidenceSourceIds.length &&
      actualSources.length === expectedSources.length &&
      actualSources.every((sourceId, index) => sourceId === expectedSources[index])
    );
  });
}
