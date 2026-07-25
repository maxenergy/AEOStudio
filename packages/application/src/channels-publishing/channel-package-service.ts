import { createHash } from 'node:crypto';

import {
  canonicalArtifactJson,
  hashArtifactRevision,
  validateArtifactPayload,
  type ArtifactStore,
} from '../artifacts/index.js';
import type { ArtifactLedgerBundle, ArtifactRevisionRecord } from '@aeostudio/domain/artifacts';
import type {
  CapabilityBoundArtifactRevisionPayloadReader,
  CapabilityBoundChannelPackagePayloadReader,
} from '../tenant-data-access/capability-context.js';
import { roleAllows } from '@aeostudio/domain/identity-access';
import type {
  ChannelPackageDocument,
  ChannelPackageExport,
  ChannelPackageManifest,
  ChannelPackagePayload,
  ChannelPackageRecord,
} from '@aeostudio/domain/channels-publishing';

import type { IdentityIdGenerator, TenantContext, TenancyStore } from '../identity-access/index.js';
import type {
  ChannelPackagePayloadWriter,
  ChannelPackageStore,
  ChannelRegistryStore,
} from './ports.js';
import type { ChannelPackageTransformerRegistry } from './generic-web-package-transformer.js';
import { channelProfileIsValid } from './channel-profile.js';
import { validateFactEvidence } from '../writer/fact-evidence-validator.js';

export type BuildChannelPackageOutcome =
  | { outcome: 'SUCCEEDED'; package: ChannelPackageDocument; created: boolean }
  | {
      outcome:
        | 'NOT_FOUND'
        | 'FORBIDDEN'
        | 'APPROVAL_REQUIRED'
        | 'APPROVAL_STALE'
        | 'HASH_MISMATCH'
        | 'PAYLOAD_INTEGRITY_INVALID'
        | 'CHANNEL_UNAVAILABLE'
        | 'CHANNEL_PROFILE_INVALID'
        | 'TRANSFORMER_UNAVAILABLE'
        | 'UNSUPPORTED_CLAIM_BLOCKS_PUBLICATION';
    };

export class ChannelPackageService {
  constructor(
    private readonly packages: ChannelPackageStore,
    private readonly packagePayloads: ChannelPackagePayloadWriter,
    private readonly packagePayloadReader: CapabilityBoundChannelPackagePayloadReader,
    private readonly registry: ChannelRegistryStore,
    private readonly transformers: ChannelPackageTransformerRegistry,
    private readonly artifacts: ArtifactStore,
    private readonly artifactPayloadReader: CapabilityBoundArtifactRevisionPayloadReader,
    private readonly tenancy: Pick<TenancyStore, 'resolveTenantContext'>,
    private readonly ids: IdentityIdGenerator,
    private readonly clock: { now(): Date },
  ) {}

  async build(input: {
    actorSubject: string;
    sessionToken: string;
    tenantId: string;
    workspaceId: string;
    artifactId: string;
    artifactRevisionId: string;
    revision: number;
    expectedContentHash: string;
    channelKey: string;
  }): Promise<BuildChannelPackageOutcome> {
    const context = await this.tenancy.resolveTenantContext({
      actorSubject: input.actorSubject,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
    });
    if (context === null) return { outcome: 'NOT_FOUND' };
    if (!roleAllows(context.role, 'PUBLISH')) return { outcome: 'FORBIDDEN' };

    const channel = (await this.registry.listEntries({ context })).find(
      (entry) => entry.channelKey === input.channelKey,
    );
    if (channel === undefined) return { outcome: 'NOT_FOUND' };
    if (channel.status !== 'AVAILABLE') return { outcome: 'CHANNEL_UNAVAILABLE' };
    const channelProfile = channel.channelProfile ?? null;
    if (channelProfile !== null && !channelProfileIsValid(channelProfile, channel.channelKey)) {
      return { outcome: 'CHANNEL_PROFILE_INVALID' };
    }
    const transformer = this.transformers.resolve(channel.packageTransformerKey);
    if (transformer === null) return { outcome: 'TRANSFORMER_UNAVAILABLE' };

    const bundle = await this.artifacts.findBundle({
      context,
      artifactId: input.artifactId,
      effectiveAt: this.clock.now(),
    });
    if (bundle === null) return { outcome: 'NOT_FOUND' };
    const revision = bundle.revisions.find(
      (entry) =>
        entry.id === input.artifactRevisionId &&
        entry.artifactId === input.artifactId &&
        entry.revision === input.revision,
    );
    if (revision === undefined) return { outcome: 'NOT_FOUND' };
    if (revision.contentHash !== input.expectedContentHash) return { outcome: 'HASH_MISMATCH' };
    if (revision.status !== 'APPROVED') return { outcome: 'APPROVAL_REQUIRED' };
    const approvedAndCurrent =
      artifactRevisionIsCurrent(bundle, revision, context) &&
      bundle.selectableApprovedRevisions.some(
        (entry) =>
          entry.revision === revision.revision && entry.contentHash === revision.contentHash,
      );
    const exactApproval = bundle.reviews.some(
      (review) =>
        review.artifactId === input.artifactId &&
        review.artifactRevisionId === revision.id &&
        review.revision === revision.revision &&
        review.contentHash === revision.contentHash &&
        review.decision === 'APPROVE',
    );
    if (!approvedAndCurrent || !exactApproval) return { outcome: 'APPROVAL_STALE' };

    const storedArtifactPayload =
      await this.artifactPayloadReader.readAuthenticatedArtifactRevision({
        sessionToken: input.sessionToken,
        context,
        authority: {
          kind: 'ARTIFACT_REVISION',
          artifactRevisionId: revision.id,
        },
        expected: {
          objectRef: revision.payloadObjectRef,
          contentHash: revision.contentHash,
        },
      });
    const artifactPayload = validateArtifactPayload(storedArtifactPayload, revision.claimBindings);
    if (artifactPayload === null) return { outcome: 'PAYLOAD_INTEGRITY_INVALID' };
    const actualArtifactHash = hashArtifactRevision({
      schemaVersion: revision.schemaVersion,
      artifactId: revision.artifactId,
      revision: revision.revision,
      type: revision.type,
      locale: revision.locale,
      market: revision.market,
      sourceArtifactIds: revision.sourceArtifactIds,
      lineage: revision.lineage,
      claimBindings: revision.claimBindings,
      methodPolicyVersion: revision.methodPolicyVersion,
      payload: artifactPayload,
    });
    if (actualArtifactHash !== revision.contentHash) {
      return { outcome: 'PAYLOAD_INTEGRITY_INVALID' };
    }

    const factEvidence = validateFactEvidence(artifactPayload);
    if (!factEvidence.supported) {
      return { outcome: 'UNSUPPORTED_CLAIM_BLOCKS_PUBLICATION' };
    }

    const payload = transformer.transform({
      revision,
      payload: artifactPayload,
      channelProfile,
    });
    const artifact: ChannelPackageRecord['artifact'] = {
      artifactId: input.artifactId,
      artifactRevisionId: revision.id,
      revision: revision.revision,
      contentHash: revision.contentHash,
      type: revision.type,
      locale: revision.locale,
      market: revision.market,
      methodPolicyVersion: revision.methodPolicyVersion,
    };
    const channelSnapshot = { definitionId: channel.id, channelKey: channel.channelKey };
    const transformerSnapshot = { key: transformer.key, version: transformer.version };
    const manifest = createManifest(
      channel.packageSchemaVersion,
      revision.claimBindings,
      payload,
      channelProfile,
    );
    const packageChecksum = hashChannelPackage({
      packageSchemaVersion: channel.packageSchemaVersion,
      channel: channelSnapshot,
      transformer: transformerSnapshot,
      artifact,
      manifest,
      payload,
    });
    const storedPayload = await this.packagePayloads.put({
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      packageChecksum,
      payload,
    });
    const persisted = await this.packages.createOrFind({
      context,
      packageId: this.ids.next(),
      channel: channelSnapshot,
      transformer: transformerSnapshot,
      packageSchemaVersion: channel.packageSchemaVersion,
      artifact,
      manifest,
      packageChecksum,
      payloadObjectRef: storedPayload.objectRef,
      createdAt: this.clock.now(),
      auditEventId: this.ids.next(),
    });
    if (persisted.outcome === 'APPROVAL_STALE') return persisted;
    const persistedPayload = await this.packagePayloadReader.readAuthenticatedChannelPackage({
      sessionToken: input.sessionToken,
      context,
      authority: {
        kind: 'CHANNEL_PACKAGE',
        packageId: persisted.record.id,
      },
      expected: {
        objectRef: persisted.record.payloadObjectRef,
        packageChecksum: persisted.record.packageChecksum,
      },
    });
    const document =
      persistedPayload === null
        ? null
        : verifyChannelPackagePayload(persisted.record, persistedPayload);
    if (document === null) return { outcome: 'PAYLOAD_INTEGRITY_INVALID' };
    return { outcome: 'SUCCEEDED', package: document, created: persisted.created };
  }

  async export(input: {
    actorSubject: string;
    sessionToken: string;
    tenantId: string;
    workspaceId: string;
    packageId: string;
  }): Promise<
    | { outcome: 'SUCCEEDED'; package: ChannelPackageExport }
    | { outcome: 'NOT_FOUND' }
    | { outcome: 'PAYLOAD_INTEGRITY_INVALID' }
  > {
    const context = await this.tenancy.resolveTenantContext({
      actorSubject: input.actorSubject,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
    });
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) {
      return { outcome: 'NOT_FOUND' };
    }
    const record = await this.packages.findById({ context, packageId: input.packageId });
    if (record === null) return { outcome: 'NOT_FOUND' };
    const payload = await this.packagePayloadReader.readAuthenticatedChannelPackage({
      sessionToken: input.sessionToken,
      context,
      authority: {
        kind: 'CHANNEL_PACKAGE',
        packageId: record.id,
      },
      expected: {
        objectRef: record.payloadObjectRef,
        packageChecksum: record.packageChecksum,
      },
    });
    if (payload === null || verifyChannelPackagePayload(record, payload) === null) {
      return { outcome: 'PAYLOAD_INTEGRITY_INVALID' };
    }
    return {
      outcome: 'SUCCEEDED',
      package: {
        id: record.id,
        packageRevision: record.packageRevision,
        packageChecksum: record.packageChecksum,
        manifest: record.manifest,
        channel: record.channel,
        transformer: record.transformer,
        artifact: record.artifact,
        files: structuredClone(payload.files),
      },
    };
  }

  async getPreview(input: {
    actorSubject: string;
    sessionToken: string;
    tenantId: string;
    workspaceId: string;
    packageId: string;
  }): Promise<
    | { outcome: 'SUCCEEDED'; package: ChannelPackageDocument }
    | { outcome: 'NOT_FOUND' }
    | { outcome: 'PAYLOAD_INTEGRITY_INVALID' }
  > {
    const context = await this.tenancy.resolveTenantContext({
      actorSubject: input.actorSubject,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
    });
    if (context === null || !roleAllows(context.role, 'WORKSPACE_READ')) {
      return { outcome: 'NOT_FOUND' };
    }
    const record = await this.packages.findById({ context, packageId: input.packageId });
    if (record === null) return { outcome: 'NOT_FOUND' };
    const payload = await this.packagePayloadReader.readAuthenticatedChannelPackage({
      sessionToken: input.sessionToken,
      context,
      authority: {
        kind: 'CHANNEL_PACKAGE',
        packageId: record.id,
      },
      expected: {
        objectRef: record.payloadObjectRef,
        packageChecksum: record.packageChecksum,
      },
    });
    const document = payload === null ? null : verifyChannelPackagePayload(record, payload);
    return document === null
      ? { outcome: 'PAYLOAD_INTEGRITY_INVALID' }
      : { outcome: 'SUCCEEDED', package: document };
  }

  /**
   * Revalidates the immutable package and the exact approved Artifact ledger entry at the
   * publication boundary. Building a package is not a permanent approval grant: its Claim,
   * evidence, Prompt, Brief, and baseline lineage must still be current when publish is clicked.
   */
  async verifyForPublication(input: {
    actorSubject: string;
    sessionToken: string;
    tenantId: string;
    workspaceId: string;
    packageId: string;
  }): Promise<
    | { outcome: 'SUCCEEDED'; context: TenantContext; package: ChannelPackageRecord }
    | { outcome: 'NOT_FOUND' | 'FORBIDDEN' | 'PAYLOAD_INTEGRITY_INVALID' }
    | { outcome: 'APPROVAL_REQUIRED' | 'APPROVAL_STALE' }
  > {
    const context = await this.tenancy.resolveTenantContext({
      actorSubject: input.actorSubject,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
    });
    if (context === null) return { outcome: 'NOT_FOUND' };
    if (!roleAllows(context.role, 'PUBLISH')) return { outcome: 'FORBIDDEN' };

    const record = await this.packages.findById({ context, packageId: input.packageId });
    if (record === null) return { outcome: 'NOT_FOUND' };
    const payload = await this.packagePayloadReader.readAuthenticatedChannelPackage({
      sessionToken: input.sessionToken,
      context,
      authority: {
        kind: 'CHANNEL_PACKAGE',
        packageId: record.id,
      },
      expected: {
        objectRef: record.payloadObjectRef,
        packageChecksum: record.packageChecksum,
      },
    });
    if (payload === null || verifyChannelPackagePayload(record, payload) === null) {
      return { outcome: 'PAYLOAD_INTEGRITY_INVALID' };
    }

    const bundle = await this.artifacts.findBundle({
      context,
      artifactId: record.artifact.artifactId,
      effectiveAt: this.clock.now(),
    });
    if (bundle === null) return { outcome: 'NOT_FOUND' };
    const revision = bundle.revisions.find(
      (candidate) =>
        candidate.id === record.artifact.artifactRevisionId &&
        candidate.artifactId === record.artifact.artifactId &&
        candidate.revision === record.artifact.revision &&
        candidate.contentHash === record.artifact.contentHash,
    );
    if (revision === undefined) return { outcome: 'NOT_FOUND' };
    if (revision.status !== 'APPROVED') return { outcome: 'APPROVAL_REQUIRED' };
    const approvedAndCurrent =
      artifactRevisionIsCurrent(bundle, revision, context) &&
      bundle.selectableApprovedRevisions.some(
        (candidate) =>
          candidate.revision === revision.revision &&
          candidate.contentHash === revision.contentHash,
      );
    const exactApproval = bundle.reviews.some(
      (review) =>
        review.artifactId === revision.artifactId &&
        review.artifactRevisionId === revision.id &&
        review.revision === revision.revision &&
        review.contentHash === revision.contentHash &&
        review.decision === 'APPROVE',
    );
    return approvedAndCurrent && exactApproval
      ? { outcome: 'SUCCEEDED', context, package: record }
      : { outcome: 'APPROVAL_STALE' };
  }
}

function artifactRevisionIsCurrent(
  bundle: ArtifactLedgerBundle,
  revision: ArtifactRevisionRecord,
  context: TenantContext,
): boolean {
  return (
    bundle.artifact.tenantId === context.tenantId &&
    bundle.artifact.workspaceId === context.workspaceId &&
    bundle.artifact.id === revision.artifactId &&
    bundle.artifact.revision === revision.revision &&
    bundle.revision?.id === revision.id &&
    bundle.revision.artifactId === revision.artifactId &&
    bundle.revision.revision === revision.revision &&
    bundle.revision.contentHash === revision.contentHash
  );
}

function createManifest(
  schemaVersion: string,
  claimBindings: Parameters<typeof validateArtifactPayload>[1],
  payload: ChannelPackagePayload,
  channelProfile: ChannelPackageManifest['channelProfile'] | null,
): ChannelPackageManifest {
  return {
    schemaVersion,
    files: Object.entries(payload.files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, content]) => ({
        path,
        mediaType: channelPackageMediaType(path),
        sha256: sha256(content),
        byteLength: Buffer.byteLength(content, 'utf8'),
      })),
    assetRefs: [],
    claimSourceMap: [...claimBindings]
      .sort((left, right) => left.claimRevisionId.localeCompare(right.claimRevisionId))
      .map((binding) => ({
        claimId: binding.claimId,
        claimRevisionId: binding.claimRevisionId,
        claimContentHash: binding.claimContentHash,
        evidence: [...binding.evidence].sort((left, right) =>
          `${left.sourceId}:${left.snapshotId}`.localeCompare(
            `${right.sourceId}:${right.snapshotId}`,
          ),
        ),
      })),
    ...(channelProfile === undefined || channelProfile === null
      ? {}
      : { channelProfile: structuredClone(channelProfile) }),
  };
}

export function verifyChannelPackagePayload(
  record: ChannelPackageRecord,
  payload: ChannelPackagePayload,
): ChannelPackageDocument | null {
  const expectedFiles = new Map(record.manifest.files.map((file) => [file.path, file]));
  const actualFiles = Object.entries(payload.files);
  const requiredCoreFiles = ['content.md', 'content.html', 'structured-data.json'] as const;
  const requiredProfileFiles = ['post.txt', 'fields.json', 'submission-checklist.md'] as const;
  if (
    expectedFiles.size !== record.manifest.files.length ||
    expectedFiles.size !== actualFiles.length ||
    !requiredCoreFiles.every((path) => typeof payload.files[path] === 'string') ||
    !actualFiles.every(([path, content]) => {
      const file = expectedFiles.get(path);
      return (
        typeof content === 'string' &&
        file !== undefined &&
        file.sha256 === sha256(content) &&
        file.byteLength === Buffer.byteLength(content, 'utf8')
      );
    }) ||
    (record.manifest.channelProfile !== undefined &&
      (!channelProfileIsValid(record.manifest.channelProfile, record.channel.channelKey) ||
        !requiredProfileFiles.every((path) => typeof payload.files[path] === 'string')))
  ) {
    return null;
  }
  const actualChecksum = hashChannelPackage({
    packageSchemaVersion: record.packageSchemaVersion,
    channel: record.channel,
    transformer: record.transformer,
    artifact: record.artifact,
    manifest: record.manifest,
    payload,
  });
  if (actualChecksum !== record.packageChecksum) return null;
  let jsonLd: Record<string, unknown>;
  try {
    const parsed = JSON.parse(payload.files['structured-data.json']) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    jsonLd = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    id: record.id,
    packageRevision: record.packageRevision,
    packageChecksum: record.packageChecksum,
    channel: record.channel,
    transformer: record.transformer,
    artifact: record.artifact,
    manifest: record.manifest,
    preview: {
      markdown: payload.files['content.md'],
      html: payload.files['content.html'],
      jsonLd,
    },
  };
}

function hashChannelPackage(input: {
  packageSchemaVersion: string;
  channel: ChannelPackageRecord['channel'];
  transformer: ChannelPackageRecord['transformer'];
  artifact: ChannelPackageRecord['artifact'];
  manifest: ChannelPackageManifest;
  payload: ChannelPackagePayload;
}): string {
  return sha256(canonicalArtifactJson(input));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function channelPackageMediaType(path: string): string {
  if (path.endsWith('.md')) return 'text/markdown';
  if (path.endsWith('.html')) return 'text/html';
  if (path.endsWith('.txt')) return 'text/plain';
  if (path === 'structured-data.json') return 'application/ld+json';
  if (path.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}
