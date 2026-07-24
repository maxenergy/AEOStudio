import type { ArtifactType } from '../artifacts/index.js';
import type { ChannelProfile } from './channel-registry.js';

export interface ChannelPackageFile {
  path: string;
  mediaType: string;
  sha256: string;
  byteLength: number;
}

export interface ChannelPackageClaimSourceMapEntry {
  claimId: string;
  claimRevisionId: string;
  claimContentHash: string;
  evidence: {
    sourceId: string;
    snapshotId: string;
    sourceHash: string;
  }[];
}

export interface ChannelPackageManifest {
  schemaVersion: string;
  files: ChannelPackageFile[];
  assetRefs: string[];
  claimSourceMap: ChannelPackageClaimSourceMapEntry[];
  channelProfile?: ChannelProfile;
}

export interface ChannelPackagePreview {
  markdown: string;
  html: string;
  jsonLd: Record<string, unknown>;
}

export interface ChannelPackageDocument {
  id: string;
  packageRevision: number;
  packageChecksum: string;
  channel: {
    definitionId: string;
    channelKey: string;
  };
  transformer: {
    key: string;
    version: string;
  };
  artifact: {
    artifactId: string;
    artifactRevisionId: string;
    revision: number;
    contentHash: string;
    type: ArtifactType;
    locale: string;
    market: string;
    methodPolicyVersion: string;
  };
  manifest: ChannelPackageManifest;
  preview: ChannelPackagePreview;
}

export interface ChannelPackageRecord extends Omit<ChannelPackageDocument, 'preview'> {
  tenantId: string;
  workspaceId: string;
  packageSchemaVersion: string;
  payloadObjectRef: string;
  createdByUserId: string;
  createdAt: string;
}

export interface ChannelPackagePayload {
  files: Record<string, string> & {
    'content.md': string;
    'content.html': string;
    'structured-data.json': string;
  };
}

export interface ChannelPackageExport {
  id: string;
  packageRevision: number;
  packageChecksum: string;
  manifest: ChannelPackageManifest;
  channel: ChannelPackageDocument['channel'];
  transformer: ChannelPackageDocument['transformer'];
  artifact: ChannelPackageDocument['artifact'];
  files: ChannelPackagePayload['files'];
}
