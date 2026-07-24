import { canonicalArtifactJson } from '@aeostudio/application/artifacts';
import type { ChannelPackagePayloadStore } from '@aeostudio/application/channels-publishing';
import type { CapabilityBoundChannelPackagePayloadReader } from '@aeostudio/application/tenant-data-access';
import type { ChannelPackagePayload } from '@aeostudio/domain/channels-publishing';

export class InMemoryChannelPackagePayloadStore
  implements ChannelPackagePayloadStore, CapabilityBoundChannelPackagePayloadReader
{
  private readonly objects = new Map<string, ChannelPackagePayload>();

  put(input: Parameters<ChannelPackagePayloadStore['put']>[0]) {
    const objectRef =
      `memory://channel-packages/${input.tenantId}/${input.workspaceId}/` +
      `${input.packageChecksum}.json`;
    const existing = this.objects.get(objectRef);
    if (
      existing !== undefined &&
      canonicalArtifactJson(existing) !== canonicalArtifactJson(input.payload)
    ) {
      return Promise.reject(new Error('CHANNEL_PACKAGE_PAYLOAD_CHECKSUM_COLLISION'));
    }
    this.objects.set(objectRef, structuredClone(input.payload));
    return Promise.resolve({ objectRef });
  }

  get(objectRef: string): Promise<ChannelPackagePayload | null> {
    const payload = this.objects.get(objectRef);
    return Promise.resolve(payload === undefined ? null : structuredClone(payload));
  }

  readAuthenticatedChannelPackage(
    input: Parameters<
      CapabilityBoundChannelPackagePayloadReader['readAuthenticatedChannelPackage']
    >[0],
  ): Promise<ChannelPackagePayload | null> {
    if (
      input.sessionToken.length < 1 ||
      input.authority.kind !== 'CHANNEL_PACKAGE' ||
      input.authority.packageId.length < 1 ||
      input.expected.packageChecksum.length !== 64
    ) {
      return Promise.resolve(null);
    }
    return this.get(input.expected.objectRef);
  }
}
