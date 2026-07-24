import type {
  PreparedWorkloadObjectWrite,
  StoredWorkloadObjectVersion,
  WorkloadObjectRecoveryStorage,
} from '../privacy-audit/index.js';
import type { TenantContext } from '../identity-access/index.js';
import type { ArtifactPayload } from '@aeostudio/domain/artifacts';
import type { ChannelPackagePayload } from '@aeostudio/domain/channels-publishing';

/**
 * AUTHENTICATED_OBJECT_READ authority is resolved from the immutable Artifact
 * revision row and the current tenant membership. The object reference and
 * hash are expectations only; neither may be used to discover the authority.
 */
export interface ArtifactRevisionPayloadReadRequest {
  /** Raw, already-authenticated __Host-aeo_session value; never reconstructed from actorSubject. */
  sessionToken: string;
  context: TenantContext;
  authority: {
    kind: 'ARTIFACT_REVISION';
    artifactRevisionId: string;
  };
  expected: {
    objectRef: string;
    contentHash: string;
  };
}

export interface CapabilityBoundArtifactRevisionPayloadReader {
  readAuthenticatedArtifactRevision(
    input: ArtifactRevisionPayloadReadRequest,
  ): Promise<ArtifactPayload | null>;
}

/**
 * AUTHENTICATED_OBJECT_READ authority is resolved from the persisted Channel
 * Package row. A caller-supplied object reference or checksum can only confirm
 * that exact binding and cannot select another package.
 */
export interface ChannelPackagePayloadReadRequest {
  /** Raw, already-authenticated __Host-aeo_session value; never reconstructed from actorSubject. */
  sessionToken: string;
  context: TenantContext;
  authority: {
    kind: 'CHANNEL_PACKAGE';
    packageId: string;
  };
  expected: {
    objectRef: string;
    packageChecksum: string;
  };
}

export interface CapabilityBoundChannelPackagePayloadReader {
  readAuthenticatedChannelPackage(
    input: ChannelPackagePayloadReadRequest,
  ): Promise<ChannelPackagePayload | null>;
}

/**
 * A Tenant export read is authorized by the durable export row, never by an
 * object coordinate supplied by the caller. Coordinates are exact
 * expectations used to bind the resulting capability to one immutable
 * managed-object version.
 */
export interface TenantExportArchiveReadRequest {
  /** Raw, already-authenticated __Host-aeo_session value; never persisted or reconstructed. */
  sessionToken: string;
  context: TenantContext;
  authority: {
    kind: 'TENANT_EXPORT';
    exportId: string;
  };
  expected: {
    objectRef: string;
    objectKey: string;
    objectVersionId: string;
    checksum: string;
  };
}

export interface AuthenticatedTenantExportArchive {
  body: Uint8Array;
  object: {
    tenantId: string;
    objectRef: string;
    objectKey: string;
    objectVersionId: string;
    checksum: string;
  };
}

export interface CapabilityBoundTenantExportArchiveReader {
  readAuthenticatedTenantExportArchive(
    input: TenantExportArchiveReadRequest,
  ): Promise<AuthenticatedTenantExportArchive | null>;
}

/**
 * The database write intent is the authority source for both PUT and its
 * recovery HEAD. Object coordinates are only expectations and must never be
 * used to discover this authority.
 */
export interface WorkloadWriteAccess {
  operationId: string;
  leaseToken: string;
}

export interface CapabilityBoundWorkloadObjectWriter {
  putAuthorizedWorkloadVersion(
    input: PreparedWorkloadObjectWrite,
    access: WorkloadWriteAccess,
  ): Promise<StoredWorkloadObjectVersion>;
}

export type WorkloadWriteRecoveryResult =
  | { outcome: 'FOUND'; object: StoredWorkloadObjectVersion }
  | { outcome: 'ABSENT' | 'FAILED' | 'UNKNOWN' };

export interface CapabilityBoundWorkloadObjectRecovery {
  recoverAuthorizedWorkloadVersion(
    input: Parameters<WorkloadObjectRecoveryStorage['recoverWorkloadVersion']>[0],
    access: WorkloadWriteAccess,
  ): Promise<WorkloadWriteRecoveryResult>;
}

/** The active Job row is the only authority source for publication reads. */
export interface ActivePublicationJobAccess {
  publicationId: string;
  leaseToken: string;
}

export interface ActivePublicationPackageReader {
  readPublicationPackage(input: {
    access: ActivePublicationJobAccess;
    expected: {
      objectRef: string;
      tenantId: string;
      workspaceId: string;
      packageChecksum: string;
    };
  }): Promise<ChannelPackagePayload | null>;
}

export interface ActivePublicationSecretReader {
  readPublicationSecret(input: {
    access: ActivePublicationJobAccess;
    expected: {
      secretReference: string;
      tenantId: string;
      workspaceId: string;
    };
  }): Promise<string>;
}

/** A leased provider-validation command is the only authority source for this secret read. */
export interface LeasedChannelAuthorizationValidationSecretReader {
  readValidationSecret(input: {
    access: {
      commandId: string;
      authorizationId: string;
      leaseToken: string;
    };
    expected: {
      secretReference: string;
      tenantId: string;
      workspaceId: string;
    };
  }): Promise<string>;
}
