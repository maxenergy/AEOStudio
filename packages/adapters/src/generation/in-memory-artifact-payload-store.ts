import { canonicalArtifactJson, type ArtifactPayloadStore } from '@aeostudio/application/artifacts';
import type { CapabilityBoundArtifactRevisionPayloadReader } from '@aeostudio/application/tenant-data-access';
import type { ArtifactPayload } from '@aeostudio/domain/artifacts';

export class InMemoryArtifactPayloadStore
  implements ArtifactPayloadStore, CapabilityBoundArtifactRevisionPayloadReader
{
  private readonly objects = new Map<string, ArtifactPayload>();

  put(input: Parameters<ArtifactPayloadStore['put']>[0]) {
    const objectRef =
      `s3://artifact-fixture/${input.tenantId}/${input.workspaceId}/` +
      `${input.artifactId}/r${input.revision}/${input.contentHash}.json`;
    const existing = this.objects.get(objectRef);
    if (
      existing !== undefined &&
      canonicalArtifactJson(existing) !== canonicalArtifactJson(input.payload)
    ) {
      return Promise.reject(new Error('ARTIFACT_PAYLOAD_CONFLICT'));
    }
    this.objects.set(objectRef, structuredClone(input.payload));
    return Promise.resolve({ objectRef });
  }

  get(objectRef: string): Promise<ArtifactPayload | null> {
    const payload = this.objects.get(objectRef);
    return Promise.resolve(payload === undefined ? null : structuredClone(payload));
  }

  readAuthenticatedArtifactRevision(
    input: Parameters<
      CapabilityBoundArtifactRevisionPayloadReader['readAuthenticatedArtifactRevision']
    >[0],
  ): Promise<ArtifactPayload | null> {
    if (
      input.sessionToken.length < 1 ||
      input.authority.kind !== 'ARTIFACT_REVISION' ||
      input.authority.artifactRevisionId.length < 1 ||
      input.expected.contentHash.length !== 64
    ) {
      return Promise.resolve(null);
    }
    return this.get(input.expected.objectRef);
  }
}
