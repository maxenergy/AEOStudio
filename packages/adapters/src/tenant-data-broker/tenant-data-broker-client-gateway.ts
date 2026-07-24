import { createHash, timingSafeEqual } from 'node:crypto';

import { canonicalArtifactJson, type ArtifactPayloadStore } from '@aeostudio/application/artifacts';
import type { ChannelPackagePayloadStore } from '@aeostudio/application/channels-publishing';
import type {
  PreparedWorkloadObjectWrite,
  PrivacyObjectInventoryVersion,
  PrivacyObjectInventoryBucket,
  PrivacyObjectWriteIntentWork,
  StoredPrivacyObjectVersion,
  StoredWorkloadObjectVersion,
} from '@aeostudio/application/privacy-audit';
import type { CrawlObjectStorage } from '@aeostudio/application/site-crawl';
import type {
  ArtifactRevisionPayloadReadRequest,
  ActivePublicationPackageReader,
  ActivePublicationSecretReader,
  AuthenticatedTenantExportArchive,
  CapabilityBoundArtifactRevisionPayloadReader,
  CapabilityBoundChannelPackagePayloadReader,
  CapabilityBoundTenantExportArchiveReader,
  CapabilityBoundWorkloadObjectRecovery,
  CapabilityBoundWorkloadObjectWriter,
  ChannelPackagePayloadReadRequest,
  LeasedChannelAuthorizationValidationSecretReader,
  TenantDataAccessRequest,
  TenantExportArchiveReadRequest,
  WorkloadWriteRecoveryResult,
} from '@aeostudio/application/tenant-data-access';
import { ArtifactPayloadSchema } from '@aeostudio/contracts/artifacts';
import type { ArtifactPayload } from '@aeostudio/domain/artifacts';
import type { ChannelPackagePayload } from '@aeostudio/domain/channels-publishing';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_OBJECT_BYTES = 2 * 1_024 * 1_024 * 1_024;
const DEFAULT_MAX_JSON_PAYLOAD_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_MAX_EXPORT_ARCHIVE_BYTES = 64 * 1_024 * 1_024;

export interface TenantDataBrokerClientInvoker {
  invoke(
    command: TenantDataAccessRequest,
    input: {
      body: AsyncIterable<Uint8Array>;
      deadline: Date;
      payloadLength: number;
      payloadSha256: string;
      signal: AbortSignal;
    },
  ): Promise<unknown>;
}

export interface TenantDataBrokerClientCapabilityIssuer {
  issueAuthenticatedObjectRead(input: {
    sessionToken: string;
    membershipId: string;
    tenantId: string;
    workspaceId: string;
    objectKey: string;
    objectVersionId: string;
    leaseToken: string;
    capabilityId: string;
  }): Promise<string | null>;
  issueWorkloadObjectPut(input: {
    operationId: string;
    leaseToken: string;
    capabilityId: string;
  }): Promise<string | null>;
  issuePublicationPackageRead(input: {
    publicationId: string;
    leaseToken: string;
    capabilityId: string;
  }): Promise<string | null>;
  issuePublicationSecretRead(input: {
    publicationId: string;
    leaseToken: string;
    capabilityId: string;
  }): Promise<string | null>;
  issueChannelAuthorizationValidationSecretRead(input: {
    commandId: string;
    authorizationId: string;
    leaseToken: string;
    capabilityId: string;
  }): Promise<string | null>;
  issuePrivacyObjectPut(input: {
    operationId: string;
    leaseToken: string;
    capabilityId: string;
  }): Promise<string | null>;
  issuePrivacyObjectRecoveryHead(input: {
    operationId: string;
    leaseToken: string;
    capabilityId: string;
  }): Promise<string | null>;
  issueWorkloadObjectRecoveryHead(input: {
    operationId: string;
    leaseToken: string;
    capabilityId: string;
  }): Promise<string | null>;
  issueConnectorSecretDescribe(input: {
    channelAuthorizationId: string;
    leaseToken: string;
    capabilityId: string;
  }): Promise<string | null>;
  issueConnectorSecretDelete(input: {
    channelAuthorizationId: string;
    leaseToken: string;
    capabilityId: string;
  }): Promise<string | null>;
  issueConnectorSecretVerifyUnreadable(input: {
    channelAuthorizationId: string;
    leaseToken: string;
    capabilityId: string;
  }): Promise<string | null>;
  issueDeletionInventory(input: {
    requestId: string;
    leaseToken: string;
    capabilityId: string;
  }): Promise<string | null>;
  issueDeletionObjectHead(input: {
    requestId: string;
    leaseToken: string;
    capabilityId: string;
    objectKey: string;
    objectVersionId: string;
  }): Promise<string | null>;
  issueDeletionObjectGetLegalHold(input: {
    requestId: string;
    leaseToken: string;
    capabilityId: string;
    objectKey: string;
    objectVersionId: string;
  }): Promise<string | null>;
  issueDeletionObjectDelete(input: {
    requestId: string;
    leaseToken: string;
    capabilityId: string;
    objectKey: string;
    objectVersionId: string;
  }): Promise<string | null>;
  issueLegalHoldSet(input: {
    tenantId: string;
    objectKey: string;
    objectVersionId: string;
    leaseToken: string;
    capabilityId: string;
  }): Promise<string | null>;
  issueLegalHoldGetRecovery(input: {
    tenantId: string;
    objectKey: string;
    objectVersionId: string;
    leaseToken: string;
    capabilityId: string;
  }): Promise<string | null>;
}

export interface TenantDataBrokerClientGatewayOptions {
  issuer: TenantDataBrokerClientCapabilityIssuer;
  client: TenantDataBrokerClientInvoker;
  ids: { next(): string };
  clock: { now(): Date };
  buckets: {
    workload: string;
    tenantExports: string;
    auditEvidence?: string;
  };
  requestTimeoutMs: number;
  expectedBucketOwner?: string;
  maxJsonPayloadBytes?: number;
  maxExportArchiveBytes?: number;
}

export interface TenantDataBrokerClientGateway
  extends
    CapabilityBoundWorkloadObjectWriter,
    CapabilityBoundWorkloadObjectRecovery,
    CapabilityBoundArtifactRevisionPayloadReader,
    CapabilityBoundChannelPackagePayloadReader,
    ActivePublicationPackageReader,
    ActivePublicationSecretReader,
    LeasedChannelAuthorizationValidationSecretReader,
    CapabilityBoundTenantExportArchiveReader,
    CapabilityBoundPrivacyObjectWriter,
    CapabilityBoundSecretLifecycleGateway,
    CapabilityBoundDeletionInventoryGateway,
    CapabilityBoundObjectDeletionGateway,
    CapabilityBoundLegalHoldGateway {
  prepareArtifactPayload(
    input: Parameters<ArtifactPayloadStore['put']>[0],
  ): PreparedWorkloadObjectWrite;
  prepareChannelPackage(
    input: Parameters<ChannelPackagePayloadStore['put']>[0],
  ): PreparedWorkloadObjectWrite;
  prepareCrawlSnapshot(
    input: Parameters<CrawlObjectStorage['putObject']>[0],
  ): PreparedWorkloadObjectWrite;
  get(objectRef: string): Promise<ArtifactPayload | null>;
  getChannelPackage(objectRef: string): Promise<ChannelPackagePayload | null>;
}

/**
 * Privacy PUT authority is the leased database intent. The cloud object key
 * and retention fields are expectations only and can never select authority.
 */
export interface CapabilityBoundPrivacyObjectWriter {
  putAuthorizedPrivacyVersion(
    input: PrivacyObjectWriteIntentWork,
  ): Promise<StoredPrivacyObjectVersion>;
}

export interface CapabilityBoundSecretDeletionRequest {
  source: {
    channelAuthorizationId: string;
    leaseToken: string;
  };
  expected: {
    tenantId: string;
    workspaceId: string;
    secretReference: string;
  };
}

export interface CapabilityBoundSecretLifecycleGateway {
  requestAuthorizedConnectorSecretForceDelete(
    input: CapabilityBoundSecretDeletionRequest,
  ): Promise<void>;
  verifyAuthorizedConnectorSecretUnreadable(
    input: CapabilityBoundSecretDeletionRequest,
  ): Promise<boolean>;
}

export interface CapabilityBoundDeletionInventoryRequest {
  source: {
    requestId: string;
    leaseToken: string;
  };
  expected: {
    tenantId: string;
    scopeKind: 'TENANT' | 'WORKSPACE';
    workspaceId: string | null;
    objectClass: PrivacyObjectInventoryBucket;
  };
}

export interface CapabilityBoundDeletionInventoryGateway {
  listAuthorizedObjectVersions(input: CapabilityBoundDeletionInventoryRequest): Promise<{
    versions: PrivacyObjectInventoryVersion[];
    nextCursor: string | null;
  }>;
}

export interface CapabilityBoundObjectDeletionRequest {
  source: {
    requestId: string;
    leaseToken: string;
  };
  expected: {
    tenantId: string;
    scopeKind: 'TENANT' | 'WORKSPACE';
    workspaceId: string | null;
    objectClass: PrivacyObjectInventoryBucket;
    objectKey: string;
    objectVersionId: string;
    isDeleteMarker: boolean;
  };
}

export interface CapabilityBoundDeletionObjectRequest {
  source: {
    requestId: string;
    leaseToken: string;
  };
  expected: {
    tenantId: string;
    scopeKind: 'TENANT' | 'WORKSPACE';
    workspaceId: string | null;
    objectClass: PrivacyObjectInventoryBucket;
    objectKey: string;
    objectVersionId: string;
  };
}

export type AuthorizedDeletionObjectHead =
  | { exists: false }
  | {
      exists: true;
      checksum: string;
      contentType: string;
      byteLength: number;
    };

export interface CapabilityBoundObjectDeletionGateway {
  headAuthorizedDeletionObject(
    input: CapabilityBoundDeletionObjectRequest,
  ): Promise<AuthorizedDeletionObjectHead>;
  getAuthorizedDeletionObjectLegalHold(
    input: CapabilityBoundDeletionObjectRequest,
  ): Promise<'ON' | 'OFF'>;
  deleteAuthorizedObjectVersion(input: CapabilityBoundObjectDeletionRequest): Promise<'DELETED'>;
}

export interface CapabilityBoundLegalHoldRequest {
  source: {
    tenantId: string;
    objectKey: string;
    objectVersionId: string;
    leaseToken: string;
  };
  expected: {
    scopeKind: 'TENANT' | 'WORKSPACE';
    workspaceId: string | null;
    objectClass: PrivacyObjectInventoryBucket;
    desiredStatus: 'ON' | 'OFF';
    revision: number;
  };
}

export interface CapabilityBoundLegalHoldGateway {
  reconcileAuthorizedObjectLegalHold(input: CapabilityBoundLegalHoldRequest): Promise<boolean>;
}

export function createTenantDataBrokerClientGateway(
  options: TenantDataBrokerClientGatewayOptions,
): TenantDataBrokerClientGateway {
  return new DefaultTenantDataBrokerClientGateway(options);
}

class DefaultTenantDataBrokerClientGateway implements TenantDataBrokerClientGateway {
  private readonly workloadBucket: string;
  private readonly tenantExportsBucket: string;
  private readonly auditEvidenceBucket: string | null;
  private readonly expectedBucketOwner: string | null;
  private readonly maxJsonPayloadBytes: number;
  private readonly maxExportArchiveBytes: number;

  public constructor(private readonly options: TenantDataBrokerClientGatewayOptions) {
    if (
      !hasFunctions(options?.issuer, [
        'issueAuthenticatedObjectRead',
        'issueWorkloadObjectPut',
        'issuePublicationPackageRead',
        'issuePublicationSecretRead',
        'issueChannelAuthorizationValidationSecretRead',
        'issuePrivacyObjectPut',
        'issuePrivacyObjectRecoveryHead',
        'issueWorkloadObjectRecoveryHead',
        'issueConnectorSecretDescribe',
        'issueConnectorSecretDelete',
        'issueConnectorSecretVerifyUnreadable',
        'issueDeletionInventory',
        'issueDeletionObjectHead',
        'issueDeletionObjectGetLegalHold',
        'issueDeletionObjectDelete',
        'issueLegalHoldSet',
        'issueLegalHoldGetRecovery',
      ]) ||
      !hasFunctions(options?.client, ['invoke']) ||
      !hasFunctions(options?.ids, ['next']) ||
      !hasFunctions(options?.clock, ['now']) ||
      !validBucket(options?.buckets?.workload) ||
      !validBucket(options?.buckets?.tenantExports) ||
      (options?.buckets?.auditEvidence !== undefined &&
        !validBucket(options.buckets.auditEvidence)) ||
      (options.expectedBucketOwner !== undefined &&
        !/^\d{12}$/u.test(options.expectedBucketOwner)) ||
      !Number.isSafeInteger(options.requestTimeoutMs) ||
      options.requestTimeoutMs < 100 ||
      options.requestTimeoutMs > 5 * 60 * 1_000 ||
      (options.maxJsonPayloadBytes !== undefined &&
        (!Number.isSafeInteger(options.maxJsonPayloadBytes) ||
          options.maxJsonPayloadBytes < 1 ||
          options.maxJsonPayloadBytes > 64 * 1_024 * 1_024)) ||
      (options.maxExportArchiveBytes !== undefined &&
        (!Number.isSafeInteger(options.maxExportArchiveBytes) ||
          options.maxExportArchiveBytes < 1 ||
          options.maxExportArchiveBytes > 256 * 1_024 * 1_024))
    ) {
      throw new Error('TENANT_DATA_BROKER_GATEWAY_OPTIONS_INVALID');
    }
    this.workloadBucket = options.buckets.workload;
    this.tenantExportsBucket = options.buckets.tenantExports;
    this.auditEvidenceBucket = options.buckets.auditEvidence ?? null;
    this.expectedBucketOwner = options.expectedBucketOwner ?? null;
    this.maxJsonPayloadBytes = options.maxJsonPayloadBytes ?? DEFAULT_MAX_JSON_PAYLOAD_BYTES;
    this.maxExportArchiveBytes = options.maxExportArchiveBytes ?? DEFAULT_MAX_EXPORT_ARCHIVE_BYTES;
  }

  public prepareArtifactPayload(
    input: Parameters<ArtifactPayloadStore['put']>[0],
  ): PreparedWorkloadObjectWrite {
    if (
      !isPlainRecord(input) ||
      !UUID.test(input.tenantId) ||
      !UUID.test(input.workspaceId) ||
      !UUID.test(input.artifactId) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      !SHA256.test(input.contentHash)
    ) {
      throw new Error('TENANT_DATA_BROKER_ARTIFACT_PREPARATION_INVALID');
    }
    const payload = ArtifactPayloadSchema.safeParse(input.payload);
    if (!payload.success) {
      throw new Error('TENANT_DATA_BROKER_ARTIFACT_PREPARATION_INVALID');
    }
    return prepareCanonicalWorkloadJson({
      kind: 'ARTIFACT_PAYLOAD',
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      objectKey:
        `tenants/${input.tenantId.toLowerCase()}` +
        `/workspaces/${input.workspaceId.toLowerCase()}` +
        `/artifacts/${input.artifactId.toLowerCase()}` +
        `/revisions/${input.revision}/${input.contentHash}.json`,
      value: payload.data,
    });
  }

  public prepareChannelPackage(
    input: Parameters<ChannelPackagePayloadStore['put']>[0],
  ): PreparedWorkloadObjectWrite {
    if (
      !isPlainRecord(input) ||
      !UUID.test(input.tenantId) ||
      !UUID.test(input.workspaceId) ||
      !SHA256.test(input.packageChecksum)
    ) {
      throw new Error('TENANT_DATA_BROKER_CHANNEL_PACKAGE_PREPARATION_INVALID');
    }
    const payload = readChannelPackagePayload(input.payload);
    return prepareCanonicalWorkloadJson({
      kind: 'CHANNEL_PACKAGE',
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      objectKey:
        `tenants/${input.tenantId.toLowerCase()}` +
        `/workspaces/${input.workspaceId.toLowerCase()}` +
        `/channel-packages/${input.packageChecksum}.json`,
      value: payload,
    });
  }

  public prepareCrawlSnapshot(
    input: Parameters<CrawlObjectStorage['putObject']>[0],
  ): PreparedWorkloadObjectWrite {
    if (
      !isPlainRecord(input) ||
      !validObjectKey(input.key) ||
      !(input.body instanceof Uint8Array) ||
      input.body.byteLength < 1 ||
      input.body.byteLength > MAX_OBJECT_BYTES ||
      !validContentType(input.contentType) ||
      typeof input.checksum !== 'string' ||
      !SHA256.test(input.checksum) ||
      !constantTimeHexEquals(input.checksum, sha256(input.body))
    ) {
      throw new Error('TENANT_DATA_BROKER_CRAWL_PREPARATION_INVALID');
    }
    const match =
      /^tenants\/([0-9a-f-]{36})\/workspaces\/([0-9a-f-]{36})\/sites\/([0-9a-f-]{36})\/snapshots\/([a-f0-9]{64})$/u.exec(
        input.key,
      );
    if (
      match === null ||
      !UUID.test(match[1] ?? '') ||
      !UUID.test(match[2] ?? '') ||
      !UUID.test(match[3] ?? '') ||
      match[4] !== input.checksum
    ) {
      throw new Error('TENANT_DATA_BROKER_CRAWL_PREPARATION_INVALID');
    }
    return {
      kind: 'CRAWL_SNAPSHOT',
      tenantId: (match[1] ?? '').toLowerCase(),
      workspaceId: (match[2] ?? '').toLowerCase(),
      objectKey: input.key,
      canonicalPayload: input.body.slice(),
      checksum: input.checksum,
      contentType: input.contentType,
      byteLength: input.body.byteLength,
    };
  }

  public get(objectRef: string): Promise<ArtifactPayload | null> {
    void objectRef;
    return Promise.reject(new Error('TENANT_DATA_AUTHORITY_REQUIRED'));
  }

  public getChannelPackage(objectRef: string): Promise<ChannelPackagePayload | null> {
    void objectRef;
    return Promise.reject(new Error('TENANT_DATA_AUTHORITY_REQUIRED'));
  }

  public async putAuthorizedWorkloadVersion(
    input: PreparedWorkloadObjectWrite,
    access: { operationId: string; leaseToken: string },
  ): Promise<StoredWorkloadObjectVersion> {
    validatePreparedWorkloadObject(input);
    requireUuid(access.operationId);
    requireUuid(access.leaseToken);
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issueWorkloadObjectPut({
      operationId: access.operationId,
      leaseToken: access.leaseToken,
      capabilityId: candidateCapabilityId,
    });
    if (capabilityId === null) throw new Error('TENANT_DATA_ACCESS_DENIED');
    requireUuid(capabilityId);
    const result = readPutReceipt(
      await this.invoke(
        {
          capabilityId,
          leaseToken: access.leaseToken,
          authorityReference: access.operationId,
          scopeKind: 'WORKSPACE',
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          operation: 'PUT_WORKLOAD_OBJECT',
        },
        input.canonicalPayload,
        input.checksum,
      ),
    );
    if (
      result.bucket !== this.workloadBucket ||
      result.key !== input.objectKey ||
      result.checksum !== input.checksum ||
      result.contentType !== input.contentType ||
      result.byteLength !== input.byteLength
    ) {
      throw new Error('TENANT_DATA_BROKER_RESOURCE_MISMATCH');
    }
    return {
      kind: input.kind,
      objectClass: input.kind,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      objectRef: objectReference(result.bucket, result.key, result.versionId),
      objectKey: result.key,
      objectVersionId: result.versionId,
      checksum: result.checksum,
      contentType: result.contentType,
      byteLength: result.byteLength,
      createdAt: readNow(this.options.clock).toISOString(),
    };
  }

  public async recoverAuthorizedWorkloadVersion(
    input: Omit<PreparedWorkloadObjectWrite, 'canonicalPayload'>,
    access: { operationId: string; leaseToken: string },
  ): Promise<WorkloadWriteRecoveryResult> {
    validateWorkloadObjectMetadata(input);
    requireUuid(access.operationId);
    requireUuid(access.leaseToken);
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issueWorkloadObjectRecoveryHead({
      operationId: access.operationId,
      leaseToken: access.leaseToken,
      capabilityId: candidateCapabilityId,
    });
    if (capabilityId === null) throw new Error('TENANT_DATA_ACCESS_DENIED');
    requireUuid(capabilityId);
    let rawResult: unknown;
    try {
      rawResult = await this.invoke(
        {
          capabilityId,
          leaseToken: access.leaseToken,
          authorityReference: access.operationId,
          scopeKind: 'WORKSPACE',
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          operation: 'HEAD_WORKLOAD_OBJECT',
        },
        new Uint8Array(),
        sha256(new Uint8Array()),
      );
    } catch (error: unknown) {
      if (hasErrorCode(error, 'TENANT_DATA_EFFECT_FAILED')) return { outcome: 'FAILED' };
      if (hasErrorCode(error, 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN')) {
        return { outcome: 'UNKNOWN' };
      }
      throw error;
    }
    const result = readObjectHead(rawResult);
    if (
      result.bucket !== this.workloadBucket ||
      result.key !== input.objectKey ||
      (result.exists &&
        (result.checksum !== input.checksum ||
          result.contentType !== input.contentType ||
          result.byteLength !== input.byteLength))
    ) {
      throw new Error('TENANT_DATA_BROKER_RESOURCE_MISMATCH');
    }
    if (!result.exists) return { outcome: 'ABSENT' };
    return {
      outcome: 'FOUND',
      object: {
        kind: input.kind,
        objectClass: input.kind,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        objectRef: objectReference(result.bucket, result.key, result.versionId),
        objectKey: result.key,
        objectVersionId: result.versionId,
        checksum: result.checksum,
        contentType: result.contentType,
        byteLength: result.byteLength,
        createdAt: readNow(this.options.clock).toISOString(),
      },
    };
  }

  public async readAuthenticatedArtifactRevision(
    input: ArtifactRevisionPayloadReadRequest,
  ): Promise<ArtifactPayload | null> {
    validateAuthenticatedReadContext(input);
    if (
      input.authority.kind !== 'ARTIFACT_REVISION' ||
      !UUID.test(input.authority.artifactRevisionId) ||
      !SHA256.test(input.expected.contentHash)
    ) {
      throw new Error('TENANT_DATA_BROKER_AUTHENTICATED_READ_INPUT_INVALID');
    }
    const reference = readWorkloadObjectReference(input.expected.objectRef, {
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      expectedSuffix: `/revisions/`,
      expectedBucket: this.workloadBucket,
    });
    if (
      !new RegExp(
        `^tenants/${escapeRegularExpression(input.context.tenantId.toLowerCase())}` +
          `/workspaces/${escapeRegularExpression(input.context.workspaceId.toLowerCase())}` +
          `/artifacts/[0-9a-f-]{36}/revisions/[1-9][0-9]*/${input.expected.contentHash}\\.json$`,
        'u',
      ).test(reference.key)
    ) {
      throw new Error('TENANT_DATA_BROKER_OBJECT_REFERENCE_INVALID');
    }
    const result = await this.readAuthenticatedObject({
      sessionToken: input.sessionToken,
      membershipId: input.context.membershipId,
      tenantId: input.context.tenantId,
      issuerWorkspaceId: input.context.workspaceId,
      commandWorkspaceId: input.context.workspaceId,
      operation: 'READ_WORKLOAD_OBJECT',
      reference,
    });
    if (result === null) return null;
    const value = await readCanonicalJsonObject(result, this.maxJsonPayloadBytes);
    const parsed = ArtifactPayloadSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error('TENANT_DATA_BROKER_ARTIFACT_PAYLOAD_INVALID');
    }
    return parsed.data;
  }

  public async readAuthenticatedChannelPackage(
    input: ChannelPackagePayloadReadRequest,
  ): Promise<ChannelPackagePayload | null> {
    validateAuthenticatedReadContext(input);
    if (
      input.authority.kind !== 'CHANNEL_PACKAGE' ||
      !UUID.test(input.authority.packageId) ||
      !SHA256.test(input.expected.packageChecksum)
    ) {
      throw new Error('TENANT_DATA_BROKER_AUTHENTICATED_READ_INPUT_INVALID');
    }
    const reference = readWorkloadObjectReference(input.expected.objectRef, {
      tenantId: input.context.tenantId,
      workspaceId: input.context.workspaceId,
      expectedSuffix: '/channel-packages/',
      expectedBucket: this.workloadBucket,
    });
    const expectedKey =
      `tenants/${input.context.tenantId.toLowerCase()}` +
      `/workspaces/${input.context.workspaceId.toLowerCase()}` +
      `/channel-packages/${input.expected.packageChecksum}.json`;
    if (reference.key !== expectedKey) {
      throw new Error('TENANT_DATA_BROKER_OBJECT_REFERENCE_INVALID');
    }
    const result = await this.readAuthenticatedObject({
      sessionToken: input.sessionToken,
      membershipId: input.context.membershipId,
      tenantId: input.context.tenantId,
      issuerWorkspaceId: input.context.workspaceId,
      commandWorkspaceId: input.context.workspaceId,
      operation: 'READ_WORKLOAD_OBJECT',
      reference,
    });
    if (result === null) return null;
    return readChannelPackagePayload(
      await readCanonicalJsonObject(result, this.maxJsonPayloadBytes),
    );
  }

  public async readPublicationPackage(
    input: Parameters<ActivePublicationPackageReader['readPublicationPackage']>[0],
  ): Promise<ChannelPackagePayload | null> {
    validatePublicationAccess(input);
    if (!SHA256.test(input.expected.packageChecksum)) {
      throw new Error('TENANT_DATA_BROKER_PUBLICATION_READ_INPUT_INVALID');
    }
    const reference = readWorkloadObjectReference(input.expected.objectRef, {
      tenantId: input.expected.tenantId,
      workspaceId: input.expected.workspaceId,
      expectedSuffix: '/channel-packages/',
      expectedBucket: this.workloadBucket,
    });
    const expectedKey =
      `tenants/${input.expected.tenantId.toLowerCase()}` +
      `/workspaces/${input.expected.workspaceId.toLowerCase()}` +
      `/channel-packages/${input.expected.packageChecksum}.json`;
    if (reference.key !== expectedKey) {
      throw new Error('TENANT_DATA_BROKER_OBJECT_REFERENCE_INVALID');
    }
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issuePublicationPackageRead({
      publicationId: input.access.publicationId,
      leaseToken: input.access.leaseToken,
      capabilityId: candidateCapabilityId,
    });
    if (capabilityId === null) return null;
    requireUuid(capabilityId);
    const result = readObjectStream(
      await this.invoke(
        {
          capabilityId,
          leaseToken: input.access.leaseToken,
          authorityReference: input.access.publicationId,
          scopeKind: 'WORKSPACE',
          tenantId: input.expected.tenantId,
          workspaceId: input.expected.workspaceId,
          operation: 'READ_WORKLOAD_OBJECT',
        },
        new Uint8Array(),
        sha256(new Uint8Array()),
      ),
    );
    if (
      result.bucket !== reference.bucket ||
      result.key !== reference.key ||
      result.versionId !== reference.versionId
    ) {
      await closeAsyncIterable(result.body);
      throw new Error('TENANT_DATA_BROKER_RESOURCE_MISMATCH');
    }
    return readChannelPackagePayload(
      await readCanonicalJsonObject(result, this.maxJsonPayloadBytes),
    );
  }

  public async readPublicationSecret(
    input: Parameters<ActivePublicationSecretReader['readPublicationSecret']>[0],
  ): Promise<string> {
    validatePublicationAccess(input);
    validateSecretReference(input.expected);
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issuePublicationSecretRead({
      publicationId: input.access.publicationId,
      leaseToken: input.access.leaseToken,
      capabilityId: candidateCapabilityId,
    });
    if (capabilityId === null) throw new Error('TENANT_DATA_ACCESS_DENIED');
    requireUuid(capabilityId);
    const result = await this.invoke(
      {
        capabilityId,
        leaseToken: input.access.leaseToken,
        authorityReference: input.access.publicationId,
        scopeKind: 'WORKSPACE',
        tenantId: input.expected.tenantId,
        workspaceId: input.expected.workspaceId,
        operation: 'READ_CONNECTOR_SECRET',
      },
      new Uint8Array(),
      sha256(new Uint8Array()),
    );
    if (
      !exactRecord(result, ['kind', 'value']) ||
      result.kind !== 'SECRET_VALUE' ||
      typeof result.value !== 'string' ||
      result.value.length < 1 ||
      Buffer.byteLength(result.value, 'utf8') > 65_536
    ) {
      throw new Error('TENANT_DATA_BROKER_SECRET_VALUE_INVALID');
    }
    return result.value;
  }

  public async readValidationSecret(
    input: Parameters<LeasedChannelAuthorizationValidationSecretReader['readValidationSecret']>[0],
  ): Promise<string> {
    validateChannelAuthorizationValidationAccess(input);
    validateSecretReference(input.expected);
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issueChannelAuthorizationValidationSecretRead({
      commandId: input.access.commandId,
      authorizationId: input.access.authorizationId,
      leaseToken: input.access.leaseToken,
      capabilityId: candidateCapabilityId,
    });
    if (capabilityId === null) throw new Error('TENANT_DATA_ACCESS_DENIED');
    requireUuid(capabilityId);
    const result = await this.invoke(
      {
        capabilityId,
        leaseToken: input.access.leaseToken,
        authorityReference: input.access.authorizationId,
        scopeKind: 'WORKSPACE',
        tenantId: input.expected.tenantId,
        workspaceId: input.expected.workspaceId,
        operation: 'READ_CONNECTOR_SECRET',
      },
      new Uint8Array(),
      sha256(new Uint8Array()),
    );
    if (
      !exactRecord(result, ['kind', 'value']) ||
      result.kind !== 'SECRET_VALUE' ||
      typeof result.value !== 'string' ||
      result.value.length < 1 ||
      Buffer.byteLength(result.value, 'utf8') > 65_536
    ) {
      throw new Error('TENANT_DATA_BROKER_SECRET_VALUE_INVALID');
    }
    return result.value;
  }

  public async requestAuthorizedConnectorSecretForceDelete(
    input: CapabilityBoundSecretDeletionRequest,
  ): Promise<void> {
    validateSecretDeletionRequest(input);
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issueConnectorSecretDelete({
      channelAuthorizationId: input.source.channelAuthorizationId,
      leaseToken: input.source.leaseToken,
      capabilityId: candidateCapabilityId,
    });
    if (capabilityId === null) throw new Error('TENANT_DATA_ACCESS_DENIED');
    requireUuid(capabilityId);
    let result: unknown;
    try {
      result = await this.invoke(
        {
          capabilityId,
          leaseToken: input.source.leaseToken,
          authorityReference: input.source.channelAuthorizationId,
          scopeKind: 'WORKSPACE',
          tenantId: input.expected.tenantId,
          workspaceId: input.expected.workspaceId,
          operation: 'DELETE_CONNECTOR_SECRET',
        },
        new Uint8Array(),
        sha256(new Uint8Array()),
      );
    } catch (error: unknown) {
      if (hasErrorCode(error, 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN')) {
        await this.recoverUnknownConnectorSecretDelete(input);
        return;
      }
      throw error;
    }
    if (
      !exactRecord(result, ['deleted', 'kind']) ||
      result.kind !== 'SECRET_DELETE_RECEIPT' ||
      result.deleted !== true
    ) {
      throw new Error('TENANT_DATA_BROKER_SECRET_DELETE_RECEIPT_INVALID');
    }
  }

  private async recoverUnknownConnectorSecretDelete(
    input: CapabilityBoundSecretDeletionRequest,
  ): Promise<void> {
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issueConnectorSecretDescribe({
      channelAuthorizationId: input.source.channelAuthorizationId,
      leaseToken: input.source.leaseToken,
      capabilityId: candidateCapabilityId,
    });
    if (capabilityId === null) throw new Error('TENANT_DATA_ACCESS_DENIED');
    requireUuid(capabilityId);
    const result = await this.invoke(
      {
        capabilityId,
        leaseToken: input.source.leaseToken,
        authorityReference: input.source.channelAuthorizationId,
        scopeKind: 'WORKSPACE',
        tenantId: input.expected.tenantId,
        workspaceId: input.expected.workspaceId,
        operation: 'DESCRIBE_CONNECTOR_SECRET',
      },
      new Uint8Array(),
      sha256(new Uint8Array()),
    );
    if (
      exactRecord(result, ['exists', 'kind']) &&
      result.kind === 'SECRET_DESCRIPTION' &&
      result.exists === false
    ) {
      return;
    }
    if (
      exactRecord(result, ['deletedAt', 'exists', 'kind']) &&
      result.kind === 'SECRET_DESCRIPTION' &&
      result.exists === true &&
      readCanonicalInstant(result.deletedAt) !== null
    ) {
      return;
    }
    if (
      exactRecord(result, ['exists', 'kind']) &&
      result.kind === 'SECRET_DESCRIPTION' &&
      result.exists === true
    ) {
      throw new Error('TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
    }
    throw new Error('TENANT_DATA_BROKER_SECRET_DESCRIPTION_INVALID');
  }

  public async verifyAuthorizedConnectorSecretUnreadable(
    input: CapabilityBoundSecretDeletionRequest,
  ): Promise<boolean> {
    validateSecretDeletionRequest(input);
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issueConnectorSecretVerifyUnreadable({
      channelAuthorizationId: input.source.channelAuthorizationId,
      leaseToken: input.source.leaseToken,
      capabilityId: candidateCapabilityId,
    });
    if (capabilityId === null) throw new Error('TENANT_DATA_ACCESS_DENIED');
    requireUuid(capabilityId);
    const result = await this.invoke(
      {
        capabilityId,
        leaseToken: input.source.leaseToken,
        authorityReference: input.source.channelAuthorizationId,
        scopeKind: 'WORKSPACE',
        tenantId: input.expected.tenantId,
        workspaceId: input.expected.workspaceId,
        operation: 'VERIFY_CONNECTOR_SECRET_UNREADABLE',
      },
      new Uint8Array(),
      sha256(new Uint8Array()),
    );
    if (
      !exactRecord(result, ['kind', 'unreadable']) ||
      result.kind !== 'CONNECTOR_SECRET_UNREADABLE' ||
      typeof result.unreadable !== 'boolean'
    ) {
      throw new Error('TENANT_DATA_BROKER_SECRET_VERIFICATION_INVALID');
    }
    return result.unreadable;
  }

  public async listAuthorizedObjectVersions(
    input: CapabilityBoundDeletionInventoryRequest,
  ): Promise<{
    versions: PrivacyObjectInventoryVersion[];
    nextCursor: string | null;
  }> {
    const prefix = validateDeletionInventoryRequest(input);
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issueDeletionInventory({
      requestId: input.source.requestId,
      leaseToken: input.source.leaseToken,
      capabilityId: candidateCapabilityId,
    });
    if (capabilityId === null) throw new Error('TENANT_DATA_ACCESS_DENIED');
    requireUuid(capabilityId);
    const result = await this.invoke(
      {
        capabilityId,
        leaseToken: input.source.leaseToken,
        authorityReference: input.source.requestId,
        scopeKind: input.expected.scopeKind,
        tenantId: input.expected.tenantId,
        workspaceId: input.expected.workspaceId,
        operation: 'LIST_TENANT_OBJECT_VERSIONS',
      },
      new Uint8Array(),
      sha256(new Uint8Array()),
    );
    return readInventoryPage(result, input.expected.objectClass, prefix);
  }

  public async deleteAuthorizedObjectVersion(
    input: CapabilityBoundObjectDeletionRequest,
  ): Promise<'DELETED'> {
    const expectedBucket = this.validateDeletionObjectRequest(input);
    if (typeof input.expected.isDeleteMarker !== 'boolean') {
      throw new Error('TENANT_DATA_BROKER_OBJECT_DELETION_INPUT_INVALID');
    }
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issueDeletionObjectDelete({
      requestId: input.source.requestId,
      leaseToken: input.source.leaseToken,
      capabilityId: candidateCapabilityId,
      objectKey: input.expected.objectKey,
      objectVersionId: input.expected.objectVersionId,
    });
    if (capabilityId === null) throw new Error('TENANT_DATA_ACCESS_DENIED');
    requireUuid(capabilityId);
    const result = await this.invoke(
      {
        capabilityId,
        leaseToken: input.source.leaseToken,
        authorityReference: input.source.requestId,
        scopeKind: input.expected.scopeKind,
        tenantId: input.expected.tenantId,
        workspaceId: input.expected.workspaceId,
        operation:
          input.expected.objectClass === 'WORKLOAD_OBJECTS'
            ? 'DELETE_WORKLOAD_OBJECT_VERSION'
            : 'DELETE_PRIVACY_OBJECT_VERSION',
      },
      new Uint8Array(),
      sha256(new Uint8Array()),
    );
    if (
      !exactRecord(result, ['bucket', 'isDeleteMarker', 'key', 'kind', 'versionId']) ||
      result.kind !== 'OBJECT_VERSION_DELETED' ||
      result.bucket !== expectedBucket ||
      result.key !== input.expected.objectKey ||
      result.versionId !== input.expected.objectVersionId ||
      result.isDeleteMarker !== input.expected.isDeleteMarker
    ) {
      throw new Error('TENANT_DATA_BROKER_DELETE_RECEIPT_INVALID');
    }
    return 'DELETED';
  }

  public async headAuthorizedDeletionObject(
    input: CapabilityBoundDeletionObjectRequest,
  ): Promise<AuthorizedDeletionObjectHead> {
    const expectedBucket = this.validateDeletionObjectRequest(input);
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issueDeletionObjectHead({
      requestId: input.source.requestId,
      leaseToken: input.source.leaseToken,
      capabilityId: candidateCapabilityId,
      objectKey: input.expected.objectKey,
      objectVersionId: input.expected.objectVersionId,
    });
    if (capabilityId === null) throw new Error('TENANT_DATA_ACCESS_DENIED');
    requireUuid(capabilityId);
    const result = readDeletionObjectHead(
      await this.invoke(
        {
          capabilityId,
          leaseToken: input.source.leaseToken,
          authorityReference: input.source.requestId,
          scopeKind: input.expected.scopeKind,
          tenantId: input.expected.tenantId,
          workspaceId: input.expected.workspaceId,
          operation:
            input.expected.objectClass === 'WORKLOAD_OBJECTS'
              ? 'HEAD_WORKLOAD_OBJECT'
              : 'HEAD_PRIVACY_OBJECT',
        },
        new Uint8Array(),
        sha256(new Uint8Array()),
      ),
    );
    if (
      result.bucket !== expectedBucket ||
      result.key !== input.expected.objectKey ||
      result.versionId !== input.expected.objectVersionId
    ) {
      throw new Error('TENANT_DATA_BROKER_RESOURCE_MISMATCH');
    }
    return result.exists
      ? {
          exists: true,
          checksum: result.checksum,
          contentType: result.contentType,
          byteLength: result.byteLength,
        }
      : { exists: false };
  }

  public async getAuthorizedDeletionObjectLegalHold(
    input: CapabilityBoundDeletionObjectRequest,
  ): Promise<'ON' | 'OFF'> {
    const expectedBucket = this.validateDeletionObjectRequest(input);
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issueDeletionObjectGetLegalHold({
      requestId: input.source.requestId,
      leaseToken: input.source.leaseToken,
      capabilityId: candidateCapabilityId,
      objectKey: input.expected.objectKey,
      objectVersionId: input.expected.objectVersionId,
    });
    if (capabilityId === null) throw new Error('TENANT_DATA_ACCESS_DENIED');
    requireUuid(capabilityId);
    const result = readLegalHoldResult(
      await this.invoke(
        {
          capabilityId,
          leaseToken: input.source.leaseToken,
          authorityReference: input.source.requestId,
          scopeKind: input.expected.scopeKind,
          tenantId: input.expected.tenantId,
          workspaceId: input.expected.workspaceId,
          operation: 'GET_OBJECT_LEGAL_HOLD',
        },
        new Uint8Array(),
        sha256(new Uint8Array()),
      ),
    );
    if (
      result.bucket !== expectedBucket ||
      result.key !== input.expected.objectKey ||
      result.versionId !== input.expected.objectVersionId ||
      (this.expectedBucketOwner !== null && result.expectedBucketOwner !== this.expectedBucketOwner)
    ) {
      throw new Error('TENANT_DATA_BROKER_RESOURCE_MISMATCH');
    }
    return result.status;
  }

  public async reconcileAuthorizedObjectLegalHold(
    input: CapabilityBoundLegalHoldRequest,
  ): Promise<boolean> {
    const { bucket, authorityReference } = this.validateLegalHoldRequest(input);
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issueLegalHoldSet({
      tenantId: input.source.tenantId,
      objectKey: input.source.objectKey,
      objectVersionId: input.source.objectVersionId,
      leaseToken: input.source.leaseToken,
      capabilityId: candidateCapabilityId,
    });
    if (capabilityId === null) throw new Error('TENANT_DATA_ACCESS_DENIED');
    requireUuid(capabilityId);
    let rawResult: unknown;
    try {
      rawResult = await this.invoke(
        {
          capabilityId,
          leaseToken: input.source.leaseToken,
          authorityReference,
          scopeKind: input.expected.scopeKind,
          tenantId: input.source.tenantId,
          workspaceId: input.expected.workspaceId,
          operation: 'SET_OBJECT_LEGAL_HOLD',
        },
        new Uint8Array(),
        sha256(new Uint8Array()),
      );
    } catch (error: unknown) {
      if (hasErrorCode(error, 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN')) {
        return this.recoverUnknownLegalHold(input, bucket, authorityReference);
      }
      throw error;
    }
    const result = readLegalHoldSetResult(rawResult);
    if (
      result.bucket !== bucket ||
      result.key !== input.source.objectKey ||
      result.versionId !== input.source.objectVersionId ||
      result.status !== input.expected.desiredStatus ||
      result.revision !== input.expected.revision ||
      (this.expectedBucketOwner !== null && result.expectedBucketOwner !== this.expectedBucketOwner)
    ) {
      throw new Error('TENANT_DATA_BROKER_RESOURCE_MISMATCH');
    }
    return true;
  }

  private async recoverUnknownLegalHold(
    input: CapabilityBoundLegalHoldRequest,
    expectedBucket: string,
    authorityReference: string,
  ): Promise<boolean> {
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issueLegalHoldGetRecovery({
      tenantId: input.source.tenantId,
      objectKey: input.source.objectKey,
      objectVersionId: input.source.objectVersionId,
      leaseToken: input.source.leaseToken,
      capabilityId: candidateCapabilityId,
    });
    if (capabilityId === null) throw new Error('TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
    requireUuid(capabilityId);
    const result = readLegalHoldResult(
      await this.invoke(
        {
          capabilityId,
          leaseToken: input.source.leaseToken,
          authorityReference,
          scopeKind: input.expected.scopeKind,
          tenantId: input.source.tenantId,
          workspaceId: input.expected.workspaceId,
          operation: 'GET_OBJECT_LEGAL_HOLD',
        },
        new Uint8Array(),
        sha256(new Uint8Array()),
      ),
    );
    if (
      result.bucket !== expectedBucket ||
      result.key !== input.source.objectKey ||
      result.versionId !== input.source.objectVersionId ||
      (this.expectedBucketOwner !== null && result.expectedBucketOwner !== this.expectedBucketOwner)
    ) {
      throw new Error('TENANT_DATA_BROKER_RESOURCE_MISMATCH');
    }
    return result.status === input.expected.desiredStatus;
  }

  private validateDeletionObjectRequest(input: CapabilityBoundDeletionObjectRequest): string {
    if (
      !isPlainRecord(input) ||
      !isPlainRecord(input.source) ||
      !UUID.test(input.source.requestId) ||
      !UUID.test(input.source.leaseToken) ||
      !isPlainRecord(input.expected) ||
      !UUID.test(input.expected.tenantId) ||
      !validObjectKey(input.expected.objectKey) ||
      !validVersionId(input.expected.objectVersionId) ||
      !validVersionId(input.expected.objectVersionId)
    ) {
      throw new Error('TENANT_DATA_BROKER_OBJECT_DELETION_INPUT_INVALID');
    }
    const prefix = validateDeletionInventoryRequest({
      source: input.source,
      expected: {
        tenantId: input.expected.tenantId,
        scopeKind: input.expected.scopeKind,
        workspaceId: input.expected.workspaceId,
        objectClass: input.expected.objectClass,
      },
    });
    if (!input.expected.objectKey.startsWith(prefix)) {
      throw new Error('TENANT_DATA_BROKER_OBJECT_DELETION_INPUT_INVALID');
    }
    if (input.expected.objectClass === 'WORKLOAD_OBJECTS') return this.workloadBucket;
    if (input.expected.objectClass === 'TENANT_EXPORTS') return this.tenantExportsBucket;
    if (this.auditEvidenceBucket !== null) return this.auditEvidenceBucket;
    throw new Error('TENANT_DATA_BROKER_GATEWAY_OPTIONS_INVALID');
  }

  private validateLegalHoldRequest(input: CapabilityBoundLegalHoldRequest): {
    bucket: string;
    authorityReference: string;
  } {
    if (
      !isPlainRecord(input) ||
      !isPlainRecord(input.source) ||
      !UUID.test(input.source.tenantId) ||
      !validObjectKey(input.source.objectKey) ||
      !validVersionId(input.source.objectVersionId) ||
      !UUID.test(input.source.leaseToken) ||
      !isPlainRecord(input.expected) ||
      (input.expected.desiredStatus !== 'ON' && input.expected.desiredStatus !== 'OFF') ||
      !Number.isSafeInteger(input.expected.revision) ||
      input.expected.revision < 1
    ) {
      throw new Error('TENANT_DATA_BROKER_LEGAL_HOLD_INPUT_INVALID');
    }
    const prefix = objectPrefix({
      tenantId: input.source.tenantId,
      scopeKind: input.expected.scopeKind,
      workspaceId: input.expected.workspaceId,
      objectClass: input.expected.objectClass,
    });
    if (!input.source.objectKey.startsWith(prefix)) {
      throw new Error('TENANT_DATA_BROKER_LEGAL_HOLD_INPUT_INVALID');
    }
    let bucket: string;
    if (input.expected.objectClass === 'WORKLOAD_OBJECTS') bucket = this.workloadBucket;
    else if (input.expected.objectClass === 'TENANT_EXPORTS') {
      bucket = this.tenantExportsBucket;
    } else if (this.auditEvidenceBucket !== null) bucket = this.auditEvidenceBucket;
    else throw new Error('TENANT_DATA_BROKER_GATEWAY_OPTIONS_INVALID');
    return {
      bucket,
      authorityReference: createHash('sha256')
        .update(
          canonicalArtifactJson({
            tenantId: input.source.tenantId.toLowerCase(),
            key: input.source.objectKey,
            versionId: input.source.objectVersionId,
          }),
          'utf8',
        )
        .digest('hex'),
    };
  }

  public async readAuthenticatedTenantExportArchive(
    input: TenantExportArchiveReadRequest,
  ): Promise<AuthenticatedTenantExportArchive | null> {
    validateAuthenticatedReadContext(input);
    if (
      input.authority.kind !== 'TENANT_EXPORT' ||
      !UUID.test(input.authority.exportId) ||
      !validObjectKey(input.expected.objectKey) ||
      !validVersionId(input.expected.objectVersionId) ||
      !SHA256.test(input.expected.checksum)
    ) {
      throw new Error('TENANT_DATA_BROKER_AUTHENTICATED_READ_INPUT_INVALID');
    }
    const expectedKey =
      `tenants/${input.context.tenantId.toLowerCase()}` +
      `/exports/${input.authority.exportId.toLowerCase()}.bundle.json`;
    if (input.expected.objectKey !== expectedKey) {
      throw new Error('TENANT_DATA_BROKER_OBJECT_REFERENCE_INVALID');
    }
    const reference = readTenantExportObjectReference(
      input.expected.objectRef,
      this.tenantExportsBucket,
      input.context.tenantId,
    );
    if (
      reference.key !== input.expected.objectKey ||
      reference.versionId !== input.expected.objectVersionId
    ) {
      throw new Error('TENANT_DATA_BROKER_OBJECT_REFERENCE_INVALID');
    }
    const result = await this.readAuthenticatedObject({
      sessionToken: input.sessionToken,
      membershipId: input.context.membershipId,
      tenantId: input.context.tenantId,
      issuerWorkspaceId: input.context.workspaceId,
      commandWorkspaceId: null,
      operation: 'READ_PRIVACY_OBJECT',
      reference,
    });
    if (result === null) return null;
    if (
      result.contentType !== 'application/json' ||
      result.checksum !== input.expected.checksum ||
      result.byteLength > this.maxExportArchiveBytes
    ) {
      await closeAsyncIterable(result.body);
      throw new Error('TENANT_DATA_BROKER_TENANT_EXPORT_INVALID');
    }
    const body = await consumeExact(result.body, result.byteLength, this.maxExportArchiveBytes);
    if (!constantTimeHexEquals(result.checksum, sha256(body))) {
      body.fill(0);
      throw new Error('TENANT_DATA_BROKER_TENANT_EXPORT_INVALID');
    }
    return {
      body,
      object: {
        tenantId: input.context.tenantId,
        objectRef: input.expected.objectRef,
        objectKey: input.expected.objectKey,
        objectVersionId: input.expected.objectVersionId,
        checksum: input.expected.checksum,
      },
    };
  }

  public async putAuthorizedPrivacyVersion(
    input: PrivacyObjectWriteIntentWork,
  ): Promise<StoredPrivacyObjectVersion> {
    const expectedBucket = this.validatePrivacyObjectWrite(input);
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issuePrivacyObjectPut({
      operationId: input.operationId,
      leaseToken: input.leaseToken,
      capabilityId: candidateCapabilityId,
    });
    if (capabilityId === null) throw new Error('TENANT_DATA_ACCESS_DENIED');
    requireUuid(capabilityId);
    let rawResult: unknown;
    try {
      rawResult = await this.invoke(
        {
          capabilityId,
          leaseToken: input.leaseToken,
          authorityReference: input.operationId,
          scopeKind: 'TENANT',
          tenantId: input.tenantId,
          workspaceId: null,
          operation: 'PUT_PRIVACY_OBJECT',
        },
        input.canonicalPayload,
        input.checksum,
      );
    } catch (error: unknown) {
      if (hasErrorCode(error, 'TENANT_DATA_EFFECT_OUTCOME_UNKNOWN')) {
        return this.recoverUnknownPrivacyPut(input, expectedBucket);
      }
      throw error;
    }
    const receipt = readPutReceipt(rawResult);
    if (
      receipt.bucket !== expectedBucket ||
      receipt.key !== input.objectKey ||
      receipt.checksum !== input.checksum ||
      receipt.contentType !== input.contentType ||
      receipt.byteLength !== input.canonicalPayload.byteLength
    ) {
      throw new Error('TENANT_DATA_BROKER_RESOURCE_MISMATCH');
    }
    return this.storedPrivacyObject(input, receipt);
  }

  private async recoverUnknownPrivacyPut(
    input: PrivacyObjectWriteIntentWork,
    expectedBucket: string,
  ): Promise<StoredPrivacyObjectVersion> {
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issuePrivacyObjectRecoveryHead({
      operationId: input.operationId,
      leaseToken: input.leaseToken,
      capabilityId: candidateCapabilityId,
    });
    if (capabilityId === null) throw new Error('TENANT_DATA_EFFECT_OUTCOME_UNKNOWN');
    requireUuid(capabilityId);
    const result = readObjectHead(
      await this.invoke(
        {
          capabilityId,
          leaseToken: input.leaseToken,
          authorityReference: input.operationId,
          scopeKind: 'TENANT',
          tenantId: input.tenantId,
          workspaceId: null,
          operation: 'HEAD_PRIVACY_OBJECT',
        },
        new Uint8Array(),
        sha256(new Uint8Array()),
      ),
    );
    if (!result.exists) throw new Error('TENANT_DATA_EFFECT_FAILED');
    if (
      result.bucket !== expectedBucket ||
      result.key !== input.objectKey ||
      result.checksum !== input.checksum ||
      result.contentType !== input.contentType ||
      result.byteLength !== input.canonicalPayload.byteLength
    ) {
      throw new Error('TENANT_DATA_BROKER_RESOURCE_MISMATCH');
    }
    return this.storedPrivacyObject(input, {
      bucket: result.bucket,
      key: result.key,
      versionId: result.versionId,
      checksum: result.checksum,
      contentType: result.contentType,
      byteLength: result.byteLength,
    });
  }

  private storedPrivacyObject(
    input: PrivacyObjectWriteIntentWork,
    receipt: PutReceipt,
  ): StoredPrivacyObjectVersion {
    return {
      tenantId: input.tenantId,
      objectRef: objectReference(receipt.bucket, receipt.key, receipt.versionId),
      objectKey: receipt.key,
      objectVersionId: receipt.versionId,
      checksum: receipt.checksum,
      contentType: receipt.contentType,
      byteLength: receipt.byteLength,
      createdAt: readNow(this.options.clock).toISOString(),
      lockedUntil: input.lockedUntil,
    };
  }

  private validatePrivacyObjectWrite(input: PrivacyObjectWriteIntentWork): string {
    const now = readNow(this.options.clock);
    const leaseExpiresAt = readCanonicalInstant(input.leaseExpiresAt);
    if (
      !isPlainRecord(input) ||
      !UUID.test(input.operationId) ||
      (input.kind !== 'TENANT_EXPORT' && input.kind !== 'AUDIT_DIGEST') ||
      !UUID.test(input.tenantId) ||
      !UUID.test(input.workspaceId) ||
      !validObjectKey(input.objectKey) ||
      !(input.canonicalPayload instanceof Uint8Array) ||
      input.canonicalPayload.byteLength < 1 ||
      input.canonicalPayload.byteLength > MAX_OBJECT_BYTES ||
      typeof input.checksum !== 'string' ||
      !SHA256.test(input.checksum) ||
      !constantTimeHexEquals(input.checksum, sha256(input.canonicalPayload)) ||
      !validContentType(input.contentType) ||
      !UUID.test(input.leaseToken) ||
      leaseExpiresAt === null ||
      leaseExpiresAt.getTime() <= now.getTime()
    ) {
      throw new Error('TENANT_DATA_BROKER_PRIVACY_WRITE_INPUT_INVALID');
    }
    const tenantPrefix = `tenants/${input.tenantId.toLowerCase()}/`;
    if (input.kind === 'TENANT_EXPORT') {
      if (
        input.lockedUntil !== null ||
        input.sealedAt !== null ||
        !input.objectKey.startsWith(`${tenantPrefix}exports/`) ||
        !input.objectKey.endsWith('.bundle.json')
      ) {
        throw new Error('TENANT_DATA_BROKER_PRIVACY_WRITE_INPUT_INVALID');
      }
      return this.tenantExportsBucket;
    }
    const sealedAt = readCanonicalInstant(input.sealedAt);
    const lockedUntil = readCanonicalInstant(input.lockedUntil);
    if (
      this.auditEvidenceBucket === null ||
      sealedAt === null ||
      lockedUntil === null ||
      lockedUntil.getTime() - sealedAt.getTime() < 365 * 24 * 60 * 60 * 1_000 ||
      !input.objectKey.startsWith(`${tenantPrefix}audit-digests/`) ||
      !input.objectKey.endsWith('.json')
    ) {
      throw new Error('TENANT_DATA_BROKER_PRIVACY_WRITE_INPUT_INVALID');
    }
    return this.auditEvidenceBucket;
  }

  private async readAuthenticatedObject(input: {
    sessionToken: string;
    membershipId: string;
    tenantId: string;
    issuerWorkspaceId: string;
    commandWorkspaceId: string | null;
    operation: 'READ_WORKLOAD_OBJECT' | 'READ_PRIVACY_OBJECT';
    reference: ObjectReference;
  }): Promise<ObjectStream | null> {
    const leaseToken = this.nextId();
    const candidateCapabilityId = this.nextId();
    const capabilityId = await this.options.issuer.issueAuthenticatedObjectRead({
      sessionToken: input.sessionToken,
      membershipId: input.membershipId,
      tenantId: input.tenantId,
      workspaceId: input.issuerWorkspaceId,
      objectKey: input.reference.key,
      objectVersionId: input.reference.versionId,
      leaseToken,
      capabilityId: candidateCapabilityId,
    });
    if (capabilityId === null) return null;
    requireUuid(capabilityId);
    const result = readObjectStream(
      await this.invoke(
        {
          capabilityId,
          leaseToken,
          authorityReference: capabilityId,
          scopeKind: input.commandWorkspaceId === null ? 'TENANT' : 'WORKSPACE',
          tenantId: input.tenantId,
          workspaceId: input.commandWorkspaceId,
          operation: input.operation,
        },
        new Uint8Array(),
        sha256(new Uint8Array()),
      ),
    );
    if (
      result.bucket !== input.reference.bucket ||
      result.key !== input.reference.key ||
      result.versionId !== input.reference.versionId
    ) {
      await closeAsyncIterable(result.body);
      throw new Error('TENANT_DATA_BROKER_RESOURCE_MISMATCH');
    }
    return result;
  }

  private nextId(): string {
    const value = this.options.ids.next();
    requireUuid(value);
    return value;
  }

  private async invoke(
    command: TenantDataAccessRequest,
    payload: Uint8Array,
    checksum: string,
  ): Promise<unknown> {
    const now = readNow(this.options.clock);
    const deadline = new Date(now.getTime() + this.options.requestTimeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('TENANT_DATA_BROKER_DEADLINE_EXCEEDED')),
      this.options.requestTimeoutMs,
    );
    timer.unref();
    try {
      return await this.options.client.invoke(command, {
        body: oneShotBody(payload),
        deadline,
        payloadLength: payload.byteLength,
        payloadSha256: checksum,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

interface PutReceipt {
  bucket: string;
  key: string;
  versionId: string;
  checksum: string;
  contentType: string;
  byteLength: number;
}

type ObjectHead =
  | {
      kind: 'OBJECT_HEAD';
      exists: false;
      bucket: string;
      key: string;
    }
  | {
      kind: 'OBJECT_HEAD';
      exists: true;
      bucket: string;
      key: string;
      versionId: string;
      checksum: string;
      contentType: string;
      byteLength: number;
    };

interface ObjectReference {
  bucket: string;
  key: string;
  versionId: string;
}

interface ObjectStream extends ObjectReference {
  kind: 'OBJECT_STREAM';
  checksum: string;
  contentType: string;
  byteLength: number;
  transportChecksumSha256: string;
  body: AsyncIterable<Uint8Array>;
}

function readPutReceipt(value: unknown): PutReceipt {
  if (
    !exactRecord(value, ['bucket', 'byteLength', 'checksum', 'contentType', 'key', 'versionId']) ||
    !validBucket(value.bucket) ||
    !validObjectKey(value.key) ||
    !validVersionId(value.versionId) ||
    typeof value.checksum !== 'string' ||
    !SHA256.test(value.checksum) ||
    !validContentType(value.contentType) ||
    !validByteLength(value.byteLength)
  ) {
    throw new Error('TENANT_DATA_BROKER_PUT_RECEIPT_INVALID');
  }
  return value as unknown as PutReceipt;
}

function readObjectHead(value: unknown): ObjectHead {
  if (
    exactRecord(value, ['bucket', 'exists', 'key', 'kind']) &&
    value.kind === 'OBJECT_HEAD' &&
    value.exists === false &&
    validBucket(value.bucket) &&
    validObjectKey(value.key)
  ) {
    return value as unknown as Extract<ObjectHead, { exists: false }>;
  }
  if (
    exactRecord(value, [
      'bucket',
      'byteLength',
      'checksum',
      'contentType',
      'exists',
      'key',
      'kind',
      'versionId',
    ]) &&
    value.kind === 'OBJECT_HEAD' &&
    value.exists === true &&
    validBucket(value.bucket) &&
    validObjectKey(value.key) &&
    validVersionId(value.versionId) &&
    typeof value.checksum === 'string' &&
    SHA256.test(value.checksum) &&
    validContentType(value.contentType) &&
    validByteLength(value.byteLength)
  ) {
    return value as unknown as Extract<ObjectHead, { exists: true }>;
  }
  throw new Error('TENANT_DATA_BROKER_OBJECT_HEAD_INVALID');
}

type DeletionObjectHead =
  | {
      kind: 'OBJECT_HEAD';
      exists: false;
      bucket: string;
      key: string;
      versionId: string;
    }
  | {
      kind: 'OBJECT_HEAD';
      exists: true;
      bucket: string;
      key: string;
      versionId: string;
      checksum: string;
      contentType: string;
      byteLength: number;
    };

function readDeletionObjectHead(value: unknown): DeletionObjectHead {
  if (
    exactRecord(value, ['bucket', 'exists', 'key', 'kind', 'versionId']) &&
    value.kind === 'OBJECT_HEAD' &&
    value.exists === false &&
    validBucket(value.bucket) &&
    validObjectKey(value.key) &&
    validVersionId(value.versionId)
  ) {
    return value as unknown as Extract<DeletionObjectHead, { exists: false }>;
  }
  if (
    exactRecord(value, [
      'bucket',
      'byteLength',
      'checksum',
      'contentType',
      'exists',
      'key',
      'kind',
      'versionId',
    ]) &&
    value.kind === 'OBJECT_HEAD' &&
    value.exists === true &&
    validBucket(value.bucket) &&
    validObjectKey(value.key) &&
    validVersionId(value.versionId) &&
    typeof value.checksum === 'string' &&
    SHA256.test(value.checksum) &&
    validContentType(value.contentType) &&
    validByteLength(value.byteLength)
  ) {
    return value as unknown as Extract<DeletionObjectHead, { exists: true }>;
  }
  throw new Error('TENANT_DATA_BROKER_OBJECT_HEAD_INVALID');
}

interface LegalHoldResult {
  kind: 'OBJECT_LEGAL_HOLD';
  bucket: string;
  expectedBucketOwner: string;
  key: string;
  versionId: string;
  status: 'ON' | 'OFF';
}

function readLegalHoldResult(value: unknown): LegalHoldResult {
  if (
    !exactRecord(value, ['bucket', 'expectedBucketOwner', 'key', 'kind', 'status', 'versionId']) ||
    value.kind !== 'OBJECT_LEGAL_HOLD' ||
    !validBucket(value.bucket) ||
    typeof value.expectedBucketOwner !== 'string' ||
    !/^\d{12}$/u.test(value.expectedBucketOwner) ||
    !validObjectKey(value.key) ||
    !validVersionId(value.versionId) ||
    (value.status !== 'ON' && value.status !== 'OFF')
  ) {
    throw new Error('TENANT_DATA_BROKER_LEGAL_HOLD_RESPONSE_INVALID');
  }
  return value as unknown as LegalHoldResult;
}

interface LegalHoldSetResult {
  kind: 'OBJECT_LEGAL_HOLD_SET';
  bucket: string;
  expectedBucketOwner: string;
  key: string;
  versionId: string;
  status: 'ON' | 'OFF';
  revision: number;
}

function readLegalHoldSetResult(value: unknown): LegalHoldSetResult {
  if (
    !exactRecord(value, [
      'bucket',
      'expectedBucketOwner',
      'key',
      'kind',
      'revision',
      'status',
      'versionId',
    ]) ||
    value.kind !== 'OBJECT_LEGAL_HOLD_SET' ||
    !validBucket(value.bucket) ||
    typeof value.expectedBucketOwner !== 'string' ||
    !/^\d{12}$/u.test(value.expectedBucketOwner) ||
    !validObjectKey(value.key) ||
    !validVersionId(value.versionId) ||
    (value.status !== 'ON' && value.status !== 'OFF') ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  ) {
    throw new Error('TENANT_DATA_BROKER_LEGAL_HOLD_RESPONSE_INVALID');
  }
  return value as unknown as LegalHoldSetResult;
}

function readObjectStream(value: unknown): ObjectStream {
  if (
    !exactRecord(value, [
      'body',
      'bucket',
      'byteLength',
      'checksum',
      'contentType',
      'key',
      'kind',
      'transportChecksumSha256',
      'versionId',
    ]) ||
    value.kind !== 'OBJECT_STREAM' ||
    !validBucket(value.bucket) ||
    !validObjectKey(value.key) ||
    !validVersionId(value.versionId) ||
    typeof value.checksum !== 'string' ||
    !SHA256.test(value.checksum) ||
    !validContentType(value.contentType) ||
    !validByteLength(value.byteLength) ||
    typeof value.transportChecksumSha256 !== 'string' ||
    value.transportChecksumSha256.length < 1 ||
    value.transportChecksumSha256.length > 256 ||
    hasControlCharacter(value.transportChecksumSha256) ||
    !isAsyncByteIterable(value.body)
  ) {
    throw new Error('TENANT_DATA_BROKER_OBJECT_STREAM_INVALID');
  }
  return value as unknown as ObjectStream;
}

function prepareCanonicalWorkloadJson(input: {
  kind: 'ARTIFACT_PAYLOAD' | 'CHANNEL_PACKAGE';
  tenantId: string;
  workspaceId: string;
  objectKey: string;
  value: unknown;
}): PreparedWorkloadObjectWrite {
  const canonicalPayload = new TextEncoder().encode(canonicalArtifactJson(input.value));
  if (canonicalPayload.byteLength < 1 || canonicalPayload.byteLength > MAX_OBJECT_BYTES) {
    throw new Error('TENANT_DATA_BROKER_WORKLOAD_PREPARATION_INVALID');
  }
  return {
    kind: input.kind,
    tenantId: input.tenantId.toLowerCase(),
    workspaceId: input.workspaceId.toLowerCase(),
    objectKey: input.objectKey,
    canonicalPayload,
    checksum: sha256(canonicalPayload),
    contentType: 'application/json',
    byteLength: canonicalPayload.byteLength,
  };
}

function validatePreparedWorkloadObject(input: PreparedWorkloadObjectWrite): void {
  validateWorkloadObjectMetadata(input);
  if (
    !(input.canonicalPayload instanceof Uint8Array) ||
    !constantTimeHexEquals(input.checksum, sha256(input.canonicalPayload)) ||
    input.byteLength !== input.canonicalPayload.byteLength
  ) {
    throw new Error('TENANT_DATA_BROKER_WORKLOAD_INPUT_INVALID');
  }
}

function validateWorkloadObjectMetadata(
  input: Omit<PreparedWorkloadObjectWrite, 'canonicalPayload'>,
): void {
  if (
    !isPlainRecord(input) ||
    !['ARTIFACT_PAYLOAD', 'CHANNEL_PACKAGE', 'CRAWL_SNAPSHOT'].includes(input.kind) ||
    !UUID.test(input.tenantId) ||
    !UUID.test(input.workspaceId) ||
    !validObjectKey(input.objectKey) ||
    !input.objectKey.startsWith(
      `tenants/${input.tenantId.toLowerCase()}/workspaces/${input.workspaceId.toLowerCase()}/`,
    ) ||
    typeof input.checksum !== 'string' ||
    !SHA256.test(input.checksum) ||
    !validContentType(input.contentType) ||
    !validByteLength(input.byteLength)
  ) {
    throw new Error('TENANT_DATA_BROKER_WORKLOAD_INPUT_INVALID');
  }
}

function oneShotBody(value: Uint8Array): AsyncIterable<Uint8Array> {
  let consumed = false;
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      if (consumed) throw new Error('TENANT_DATA_BROKER_REQUEST_BODY_REUSED');
      consumed = true;
      yield value;
    },
  };
}

function objectReference(bucket: string, key: string, versionId: string): string {
  return `s3://${bucket}/${key}?versionId=${encodeURIComponent(versionId)}`;
}

function readWorkloadObjectReference(
  value: string,
  scope: {
    tenantId: string;
    workspaceId: string;
    expectedSuffix: string;
    expectedBucket: string;
  },
): ObjectReference {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TENANT_DATA_BROKER_OBJECT_REFERENCE_INVALID');
  }
  const keys = [...url.searchParams.keys()];
  const versionId = url.searchParams.get('versionId');
  const key = url.pathname.slice(1);
  const expectedPrefix = `tenants/${scope.tenantId.toLowerCase()}/workspaces/${scope.workspaceId.toLowerCase()}/`;
  if (
    url.protocol !== 's3:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== '' ||
    !validBucket(url.hostname) ||
    url.hostname !== scope.expectedBucket ||
    !validObjectKey(key) ||
    !key.startsWith(expectedPrefix) ||
    !key.includes(scope.expectedSuffix) ||
    keys.length !== 1 ||
    keys[0] !== 'versionId' ||
    versionId === null ||
    !validVersionId(versionId) ||
    objectReference(url.hostname, key, versionId) !== value
  ) {
    throw new Error('TENANT_DATA_BROKER_OBJECT_REFERENCE_INVALID');
  }
  return { bucket: url.hostname, key, versionId };
}

function readTenantExportObjectReference(
  value: string,
  expectedBucket: string,
  tenantId: string,
): ObjectReference {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TENANT_DATA_BROKER_OBJECT_REFERENCE_INVALID');
  }
  const keys = [...url.searchParams.keys()];
  const versionId = url.searchParams.get('versionId');
  const key = url.pathname.slice(1);
  if (
    url.protocol !== 's3:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== '' ||
    url.hostname !== expectedBucket ||
    !validObjectKey(key) ||
    !key.startsWith(`tenants/${tenantId.toLowerCase()}/exports/`) ||
    keys.length !== 1 ||
    keys[0] !== 'versionId' ||
    versionId === null ||
    !validVersionId(versionId) ||
    objectReference(url.hostname, key, versionId) !== value
  ) {
    throw new Error('TENANT_DATA_BROKER_OBJECT_REFERENCE_INVALID');
  }
  return { bucket: url.hostname, key, versionId };
}

function validateAuthenticatedReadContext(input: {
  sessionToken: string;
  context: {
    tenantId: string;
    workspaceId: string;
    actorUserId: string;
    membershipId: string;
  };
}): void {
  if (
    !isPlainRecord(input) ||
    typeof input.sessionToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(input.sessionToken) ||
    !isPlainRecord(input.context) ||
    !UUID.test(input.context.tenantId) ||
    !UUID.test(input.context.workspaceId) ||
    !UUID.test(input.context.actorUserId) ||
    !UUID.test(input.context.membershipId)
  ) {
    throw new Error('TENANT_DATA_BROKER_AUTHENTICATED_READ_INPUT_INVALID');
  }
}

function validatePublicationAccess(input: {
  access: { publicationId: string; leaseToken: string };
  expected: { tenantId: string; workspaceId: string };
}): void {
  if (
    !isPlainRecord(input) ||
    !isPlainRecord(input.access) ||
    !UUID.test(input.access.publicationId) ||
    !UUID.test(input.access.leaseToken) ||
    !isPlainRecord(input.expected) ||
    !UUID.test(input.expected.tenantId) ||
    !UUID.test(input.expected.workspaceId)
  ) {
    throw new Error('TENANT_DATA_BROKER_PUBLICATION_READ_INPUT_INVALID');
  }
}

function validateChannelAuthorizationValidationAccess(input: {
  access: {
    commandId: string;
    authorizationId: string;
    leaseToken: string;
  };
  expected: { tenantId: string; workspaceId: string };
}): void {
  if (
    !isPlainRecord(input) ||
    !isPlainRecord(input.access) ||
    !UUID.test(input.access.commandId) ||
    !UUID.test(input.access.authorizationId) ||
    !UUID.test(input.access.leaseToken) ||
    !isPlainRecord(input.expected) ||
    !UUID.test(input.expected.tenantId) ||
    !UUID.test(input.expected.workspaceId)
  ) {
    throw new Error('TENANT_DATA_BROKER_AUTHORIZATION_VALIDATION_INPUT_INVALID');
  }
}

function validateSecretDeletionRequest(input: CapabilityBoundSecretDeletionRequest): void {
  if (
    !isPlainRecord(input) ||
    !isPlainRecord(input.source) ||
    !UUID.test(input.source.channelAuthorizationId) ||
    !UUID.test(input.source.leaseToken) ||
    !isPlainRecord(input.expected) ||
    !UUID.test(input.expected.tenantId) ||
    !UUID.test(input.expected.workspaceId)
  ) {
    throw new Error('TENANT_DATA_BROKER_SECRET_DELETION_INPUT_INVALID');
  }
  validateSecretReference(input.expected);
}

function validateSecretReference(input: {
  tenantId: string;
  workspaceId: string;
  secretReference: string;
}): void {
  const match =
    /^arn:aws:secretsmanager:ap-southeast-1:(\d{12}):secret:([A-Za-z0-9/_+=.@-]{1,512})$/u.exec(
      input.secretReference,
    );
  const expectedPrefix =
    `tenant-${input.tenantId.toLowerCase()}/` + `workspace-${input.workspaceId.toLowerCase()}/`;
  if (
    match === null ||
    !(match[2] ?? '').startsWith(expectedPrefix) ||
    (match[2] ?? '').length <= expectedPrefix.length
  ) {
    throw new Error('TENANT_DATA_BROKER_SECRET_REFERENCE_INVALID');
  }
}

function validateDeletionInventoryRequest(input: CapabilityBoundDeletionInventoryRequest): string {
  if (
    !isPlainRecord(input) ||
    !isPlainRecord(input.source) ||
    !UUID.test(input.source.requestId) ||
    !UUID.test(input.source.leaseToken) ||
    !isPlainRecord(input.expected) ||
    !UUID.test(input.expected.tenantId) ||
    !['TENANT_EXPORTS', 'AUDIT_EVIDENCE', 'WORKLOAD_OBJECTS'].includes(input.expected.objectClass)
  ) {
    throw new Error('TENANT_DATA_BROKER_DELETION_INVENTORY_INPUT_INVALID');
  }
  try {
    return objectPrefix(input.expected);
  } catch {
    throw new Error('TENANT_DATA_BROKER_DELETION_INVENTORY_INPUT_INVALID');
  }
}

function objectPrefix(input: {
  tenantId: string;
  scopeKind: 'TENANT' | 'WORKSPACE';
  workspaceId: string | null;
  objectClass: PrivacyObjectInventoryBucket;
}): string {
  if (!UUID.test(input.tenantId)) {
    throw new Error('TENANT_DATA_BROKER_OBJECT_SCOPE_INVALID');
  }
  const tenantPrefix = `tenants/${input.tenantId.toLowerCase()}/`;
  if (input.objectClass === 'TENANT_EXPORTS') {
    if (input.scopeKind !== 'TENANT' || input.workspaceId !== null) {
      throw new Error('TENANT_DATA_BROKER_OBJECT_SCOPE_INVALID');
    }
    return `${tenantPrefix}exports/`;
  }
  if (input.objectClass === 'AUDIT_EVIDENCE') {
    if (input.scopeKind !== 'TENANT' || input.workspaceId !== null) {
      throw new Error('TENANT_DATA_BROKER_OBJECT_SCOPE_INVALID');
    }
    return `${tenantPrefix}audit-digests/`;
  }
  if (input.objectClass !== 'WORKLOAD_OBJECTS') {
    throw new Error('TENANT_DATA_BROKER_OBJECT_SCOPE_INVALID');
  }
  if (input.scopeKind === 'TENANT' && input.workspaceId === null) {
    return `${tenantPrefix}workspaces/`;
  }
  if (
    input.scopeKind === 'WORKSPACE' &&
    typeof input.workspaceId === 'string' &&
    UUID.test(input.workspaceId)
  ) {
    return `${tenantPrefix}workspaces/${input.workspaceId.toLowerCase()}/`;
  }
  throw new Error('TENANT_DATA_BROKER_OBJECT_SCOPE_INVALID');
}

function readInventoryPage(
  value: unknown,
  expectedObjectClass: PrivacyObjectInventoryBucket,
  prefix: string,
): { versions: PrivacyObjectInventoryVersion[]; nextCursor: string | null } {
  if (
    !exactRecord(value, [
      'deleteMarkers',
      'isTruncated',
      'kind',
      'nextCursor',
      'objectClass',
      'versions',
    ]) ||
    value.kind !== 'OBJECT_VERSION_INVENTORY' ||
    value.objectClass !== expectedObjectClass ||
    !Array.isArray(value.versions) ||
    !Array.isArray(value.deleteMarkers) ||
    value.versions.length + value.deleteMarkers.length > 1_000 ||
    typeof value.isTruncated !== 'boolean'
  ) {
    throw new Error('TENANT_DATA_BROKER_INVENTORY_RESPONSE_INVALID');
  }
  const versions = [
    ...value.versions.map((entry) => readInventoryEntry(entry, false, prefix, expectedObjectClass)),
    ...value.deleteMarkers.map((entry) =>
      readInventoryEntry(entry, true, prefix, expectedObjectClass),
    ),
  ];
  const identities = new Set(
    versions.map(
      (entry) =>
        `${entry.objectKey}\n${entry.objectVersionId}\n${entry.isDeleteMarker === true ? '1' : '0'}`,
    ),
  );
  if (identities.size !== versions.length) {
    throw new Error('TENANT_DATA_BROKER_INVENTORY_RESPONSE_INVALID');
  }
  let nextCursor: string | null;
  if (value.isTruncated) {
    if (
      !exactRecord(value.nextCursor, ['keyMarker', 'versionIdMarker']) ||
      !validObjectKey(value.nextCursor.keyMarker) ||
      !value.nextCursor.keyMarker.startsWith(prefix) ||
      !validVersionId(value.nextCursor.versionIdMarker)
    ) {
      throw new Error('TENANT_DATA_BROKER_INVENTORY_RESPONSE_INVALID');
    }
    nextCursor = Buffer.from(canonicalArtifactJson(value.nextCursor), 'utf8').toString('base64url');
    if (nextCursor.length > 4_096) {
      throw new Error('TENANT_DATA_BROKER_INVENTORY_RESPONSE_INVALID');
    }
  } else {
    if (value.nextCursor !== null) {
      throw new Error('TENANT_DATA_BROKER_INVENTORY_RESPONSE_INVALID');
    }
    nextCursor = null;
  }
  return { versions, nextCursor };
}

function readInventoryEntry(
  value: unknown,
  expectedDeleteMarker: boolean,
  prefix: string,
  objectClass: PrivacyObjectInventoryBucket,
): PrivacyObjectInventoryVersion {
  if (
    (!exactRecord(value, ['isDeleteMarker', 'key', 'versionId']) &&
      !exactRecord(value, ['isDeleteMarker', 'key', 'lastModified', 'versionId'])) ||
    !validObjectKey(value.key) ||
    !value.key.startsWith(prefix) ||
    !validVersionId(value.versionId) ||
    value.isDeleteMarker !== expectedDeleteMarker
  ) {
    throw new Error('TENANT_DATA_BROKER_INVENTORY_RESPONSE_INVALID');
  }
  let createdAt: string | undefined;
  if ('lastModified' in value) {
    const instant = readCanonicalInstant(value.lastModified);
    if (instant === null) {
      throw new Error('TENANT_DATA_BROKER_INVENTORY_RESPONSE_INVALID');
    }
    createdAt = instant.toISOString();
  }
  let workspaceId: string | undefined;
  if (objectClass === 'WORKLOAD_OBJECTS') {
    const match = /^tenants\/[^/]+\/workspaces\/([^/]+)\//u.exec(value.key);
    if (match === null || !UUID.test(match[1] ?? '')) {
      throw new Error('TENANT_DATA_BROKER_INVENTORY_RESPONSE_INVALID');
    }
    workspaceId = (match[1] ?? '').toLowerCase();
  }
  return {
    objectKey: value.key,
    objectVersionId: value.versionId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(expectedDeleteMarker ? { isDeleteMarker: true as const } : {}),
  };
}

async function readCanonicalJsonObject(
  stream: ObjectStream,
  maximumBytes: number,
): Promise<unknown> {
  if (stream.contentType !== 'application/json' || stream.byteLength > maximumBytes) {
    await closeAsyncIterable(stream.body);
    throw new Error('TENANT_DATA_BROKER_JSON_PAYLOAD_INVALID');
  }
  const bytes = await consumeExact(stream.body, stream.byteLength, maximumBytes);
  try {
    if (!constantTimeHexEquals(stream.checksum, sha256(bytes))) {
      throw new Error('invalid');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (!isPlainRecord(value) || canonicalArtifactJson(value) !== text) {
      throw new Error('invalid');
    }
    return value;
  } catch {
    throw new Error('TENANT_DATA_BROKER_JSON_PAYLOAD_INVALID');
  } finally {
    bytes.fill(0);
  }
}

function readChannelPackagePayload(value: unknown): ChannelPackagePayload {
  if (
    !exactRecord(value, ['files']) ||
    !exactRecord(value.files, ['content.html', 'content.md', 'structured-data.json']) ||
    typeof value.files['content.md'] !== 'string' ||
    value.files['content.md'].length < 1 ||
    typeof value.files['content.html'] !== 'string' ||
    value.files['content.html'].length < 1 ||
    typeof value.files['structured-data.json'] !== 'string' ||
    value.files['structured-data.json'].length < 1
  ) {
    throw new Error('TENANT_DATA_BROKER_CHANNEL_PACKAGE_PAYLOAD_INVALID');
  }
  return {
    files: {
      'content.md': value.files['content.md'],
      'content.html': value.files['content.html'],
      'structured-data.json': value.files['structured-data.json'],
    },
  };
}

async function consumeExact(
  source: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (expectedBytes < 1 || expectedBytes > maximumBytes) {
    await closeAsyncIterable(source);
    throw new Error('TENANT_DATA_BROKER_PAYLOAD_LIMIT_EXCEEDED');
  }
  const result = new Uint8Array(expectedBytes);
  const iterator = source[Symbol.asyncIterator]();
  let offset = 0;
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || offset + next.value.byteLength > expectedBytes) {
        throw new Error('TENANT_DATA_BROKER_RESPONSE_LENGTH_MISMATCH');
      }
      result.set(next.value, offset);
      offset += next.value.byteLength;
    }
    if (offset !== expectedBytes) {
      throw new Error('TENANT_DATA_BROKER_RESPONSE_LENGTH_MISMATCH');
    }
    return result;
  } catch (error: unknown) {
    result.fill(0);
    if (typeof iterator.return === 'function') {
      await iterator.return().catch(() => undefined);
    }
    throw error;
  }
}

async function closeAsyncIterable(value: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    const iterator = value[Symbol.asyncIterator]();
    if (typeof iterator.return === 'function') await iterator.return();
  } catch {
    // Release is best effort after a rejected response.
  }
}

function readNow(clock: { now(): Date }): Date {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('TENANT_DATA_BROKER_TIME_INVALID');
  }
  return new Date(now);
}

function readCanonicalInstant(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? new Date(milliseconds)
    : null;
}

function requireUuid(value: string): void {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error('TENANT_DATA_BROKER_GATEWAY_INPUT_INVALID');
  }
}

function validBucket(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?=.{3,63}$)(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/u.test(value) &&
    !value.includes('..') &&
    !value.includes('.-') &&
    !value.includes('-.')
  );
}

function validObjectKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 1_024 &&
    !value.startsWith('/') &&
    !hasControlCharacter(value)
  );
}

function validVersionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 1_024 &&
    !hasControlCharacter(value)
  );
}

function validContentType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 3 &&
    value.length <= 255 &&
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ -~]+)?$/u.test(value)
  );
}

function validByteLength(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_OBJECT_BYTES
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function hasFunctions(value: unknown, names: readonly string[]): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const candidate = value as Record<string, unknown>;
  return names.every((name) => typeof candidate[name] === 'function');
}

function isAsyncByteIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function'
  );
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  return (
    isPlainRecord(value) &&
    Object.keys(value).sort().join('\n') === [...expectedKeys].sort().join('\n')
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function constantTimeHexEquals(expected: string, actual: string): boolean {
  if (!SHA256.test(expected) || !SHA256.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function hasErrorCode(value: unknown, expected: string): boolean {
  if (!(value instanceof Error)) return false;
  const code = (value as Error & { code?: unknown }).code;
  return value.message === expected || code === expected;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
