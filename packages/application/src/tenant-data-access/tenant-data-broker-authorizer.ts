import { createHash, timingSafeEqual } from 'node:crypto';

export type TenantDataOperation =
  | 'READ_CONNECTOR_SECRET'
  | 'DESCRIBE_CONNECTOR_SECRET'
  | 'VERIFY_CONNECTOR_SECRET_UNREADABLE'
  | 'DELETE_CONNECTOR_SECRET'
  | 'PUT_WORKLOAD_OBJECT'
  | 'READ_WORKLOAD_OBJECT'
  | 'HEAD_WORKLOAD_OBJECT'
  | 'DELETE_WORKLOAD_OBJECT_VERSION'
  | 'PUT_PRIVACY_OBJECT'
  | 'READ_PRIVACY_OBJECT'
  | 'HEAD_PRIVACY_OBJECT'
  | 'LIST_TENANT_OBJECT_VERSIONS'
  | 'DELETE_PRIVACY_OBJECT_VERSION'
  | 'GET_OBJECT_LEGAL_HOLD'
  | 'SET_OBJECT_LEGAL_HOLD';

export type TenantDataAuthorityKind =
  | 'ACTIVE_PUBLICATION_JOB'
  | 'CHANNEL_AUTHORIZATION_VALIDATION'
  | 'CONNECTOR_DELETION_INTENT'
  | 'WORKLOAD_WRITE_INTENT'
  | 'PRIVACY_WRITE_INTENT'
  | 'ACTIVE_JOB_OBJECT_READ'
  | 'AUTHENTICATED_OBJECT_READ'
  | 'DELETION_INVENTORY_INTENT'
  | 'DELETION_OBJECT_INTENT'
  | 'LEGAL_HOLD_RECONCILIATION_INTENT';

export type TenantDataObjectClass = 'WORKLOAD_OBJECTS' | 'TENANT_EXPORTS' | 'AUDIT_EVIDENCE';

export type TenantDataPrivacyObjectClass = Exclude<TenantDataObjectClass, 'WORKLOAD_OBJECTS'>;

export type TenantDataScope =
  | { scopeKind: 'TENANT'; tenantId: string; workspaceId: null }
  | { scopeKind: 'WORKSPACE'; tenantId: string; workspaceId: string };

export interface TenantDataConnectorSecretResource {
  kind: 'CONNECTOR_SECRET';
  secretArn: string;
}

export interface TenantDataConnectorSecretUnreadableVerificationResource {
  kind: 'CONNECTOR_SECRET_UNREADABLE_VERIFICATION';
  secretArn: string;
  resultKind: 'BOOLEAN_ONLY';
}

export interface TenantDataWorkloadObjectPutResource {
  kind: 'WORKLOAD_OBJECT_PUT';
  objectClass: 'WORKLOAD_OBJECTS';
  bucket: string;
  key: string;
  checksumSha256: string;
  contentType: string;
  byteLength: number;
  lockedUntil: null;
  sealedAt: null;
}

type TenantDataPrivacyRetention =
  | {
      objectClass: 'TENANT_EXPORTS';
      lockedUntil: null;
      sealedAt: null;
    }
  | {
      objectClass: 'AUDIT_EVIDENCE';
      lockedUntil: string;
      sealedAt: string;
    };

export type TenantDataPrivacyObjectPutResource = {
  kind: 'PRIVACY_OBJECT_PUT';
  bucket: string;
  key: string;
  checksumSha256: string;
  contentType: string;
  byteLength: number;
} & TenantDataPrivacyRetention;

export interface TenantDataWorkloadObjectWriteRecoveryHeadResource {
  kind: 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD';
  objectClass: 'WORKLOAD_OBJECTS';
  bucket: string;
  key: string;
  expectedChecksumSha256: string;
  expectedContentType: string;
  expectedByteLength: number;
  lockedUntil: null;
  sealedAt: null;
}

export type TenantDataPrivacyObjectWriteRecoveryHeadResource = {
  kind: 'PRIVACY_OBJECT_WRITE_RECOVERY_HEAD';
  bucket: string;
  key: string;
  expectedChecksumSha256: string;
  expectedContentType: string;
  expectedByteLength: number;
} & TenantDataPrivacyRetention;

export type TenantDataObjectPutResource =
  TenantDataWorkloadObjectPutResource | TenantDataPrivacyObjectPutResource;

export interface TenantDataObjectVersionResource<
  TObjectClass extends TenantDataObjectClass = TenantDataObjectClass,
> {
  kind: 'OBJECT_VERSION';
  objectClass: TObjectClass;
  bucket: string;
  key: string;
  versionId: string;
  checksumSha256: string;
  contentType: string;
  byteLength: number;
}

export interface TenantDataObjectDeleteResource<
  TObjectClass extends TenantDataObjectClass = TenantDataObjectClass,
> {
  kind: 'OBJECT_VERSION_DELETE';
  objectClass: TObjectClass;
  bucket: string;
  key: string;
  versionId: string;
  isDeleteMarker: boolean;
}

export interface TenantDataObjectLegalHoldReadResource {
  kind: 'OBJECT_LEGAL_HOLD_READ';
  objectClass: TenantDataObjectClass;
  bucket: string;
  key: string;
  versionId: string;
}

export interface TenantDataObjectLegalHoldWriteResource {
  kind: 'OBJECT_LEGAL_HOLD_WRITE';
  objectClass: TenantDataObjectClass;
  bucket: string;
  key: string;
  versionId: string;
  desiredStatus: 'ON' | 'OFF';
  revision: number;
}

export interface TenantDataObjectInventoryResource {
  kind: 'OBJECT_VERSION_INVENTORY';
  objectClass: TenantDataObjectClass;
  bucket: string;
  prefix: string;
  cursor: { keyMarker: string; versionIdMarker: string } | null;
  limit: number;
}

type GrantFor<
  TOperation extends TenantDataOperation,
  TAuthority extends TenantDataAuthorityKind,
  TResource,
> = {
  capabilityId: string;
  leaseTokenSha256: string;
  authorityKind: TAuthority;
  authorityReference: string;
  scopeKind: TenantDataScope['scopeKind'];
  tenantId: string;
  workspaceId: string | null;
  operation: TOperation;
  resource: TResource;
  expiresAt: string;
};

export type TenantDataAccessGrant =
  | GrantFor<
      'READ_CONNECTOR_SECRET',
      'ACTIVE_PUBLICATION_JOB' | 'CHANNEL_AUTHORIZATION_VALIDATION',
      TenantDataConnectorSecretResource
    >
  | GrantFor<
      'DESCRIBE_CONNECTOR_SECRET' | 'DELETE_CONNECTOR_SECRET',
      'CONNECTOR_DELETION_INTENT',
      TenantDataConnectorSecretResource
    >
  | GrantFor<
      'VERIFY_CONNECTOR_SECRET_UNREADABLE',
      'CONNECTOR_DELETION_INTENT',
      TenantDataConnectorSecretUnreadableVerificationResource
    >
  | GrantFor<'PUT_WORKLOAD_OBJECT', 'WORKLOAD_WRITE_INTENT', TenantDataWorkloadObjectPutResource>
  | GrantFor<'PUT_PRIVACY_OBJECT', 'PRIVACY_WRITE_INTENT', TenantDataPrivacyObjectPutResource>
  | GrantFor<
      'HEAD_WORKLOAD_OBJECT',
      'WORKLOAD_WRITE_INTENT',
      TenantDataWorkloadObjectWriteRecoveryHeadResource
    >
  | GrantFor<
      'HEAD_PRIVACY_OBJECT',
      'PRIVACY_WRITE_INTENT',
      TenantDataPrivacyObjectWriteRecoveryHeadResource
    >
  | GrantFor<
      'READ_WORKLOAD_OBJECT',
      'ACTIVE_JOB_OBJECT_READ' | 'AUTHENTICATED_OBJECT_READ',
      TenantDataObjectVersionResource<'WORKLOAD_OBJECTS'>
    >
  | GrantFor<
      'READ_PRIVACY_OBJECT',
      'ACTIVE_JOB_OBJECT_READ' | 'AUTHENTICATED_OBJECT_READ',
      TenantDataObjectVersionResource<TenantDataPrivacyObjectClass>
    >
  | GrantFor<
      'HEAD_WORKLOAD_OBJECT',
      'DELETION_OBJECT_INTENT',
      TenantDataObjectVersionResource<'WORKLOAD_OBJECTS'>
    >
  | GrantFor<
      'HEAD_PRIVACY_OBJECT',
      'DELETION_OBJECT_INTENT',
      TenantDataObjectVersionResource<TenantDataPrivacyObjectClass>
    >
  | GrantFor<
      'DELETE_WORKLOAD_OBJECT_VERSION',
      'DELETION_OBJECT_INTENT',
      TenantDataObjectDeleteResource<'WORKLOAD_OBJECTS'>
    >
  | GrantFor<
      'DELETE_PRIVACY_OBJECT_VERSION',
      'DELETION_OBJECT_INTENT',
      TenantDataObjectDeleteResource<TenantDataPrivacyObjectClass>
    >
  | GrantFor<
      'LIST_TENANT_OBJECT_VERSIONS',
      'DELETION_INVENTORY_INTENT',
      TenantDataObjectInventoryResource
    >
  | GrantFor<
      'GET_OBJECT_LEGAL_HOLD',
      'DELETION_OBJECT_INTENT' | 'LEGAL_HOLD_RECONCILIATION_INTENT',
      TenantDataObjectLegalHoldReadResource
    >
  | GrantFor<
      'SET_OBJECT_LEGAL_HOLD',
      'LEGAL_HOLD_RECONCILIATION_INTENT',
      TenantDataObjectLegalHoldWriteResource
    >;

export interface TenantDataAccessRequest {
  capabilityId: string;
  leaseToken: string;
  authorityReference: string;
  scopeKind: TenantDataScope['scopeKind'];
  tenantId: string;
  workspaceId: string | null;
  operation: TenantDataOperation;
}

/**
 * The implementation of this port is the security authority. The opaque
 * capability and lease are the only lookup roots. Tenant, Workspace,
 * operation and cloud coordinates are loaded from the authoritative row and
 * compared after the complete grant has been returned.
 */
export interface TenantDataAccessAuthority {
  loadActiveGrant(input: {
    capabilityId: string;
    leaseToken: string;
    at: Date;
  }): Promise<TenantDataAccessGrant | null>;
}

type AuthorizedGrant<T> = T extends TenantDataAccessGrant ? Omit<T, 'leaseTokenSha256'> : never;

export type TenantDataAuthorization =
  | {
      outcome: 'AUTHORIZED';
      grant: AuthorizedGrant<TenantDataAccessGrant>;
      audit: { resourceReferenceSha256: string };
    }
  | { outcome: 'DENIED'; code: 'TENANT_DATA_ACCESS_DENIED' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CAPABILITY_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_OBJECT_BYTES = 2 * 1_024 * 1_024 * 1_024;

const AUTHORITY_KINDS_BY_OPERATION = {
  READ_CONNECTOR_SECRET: ['ACTIVE_PUBLICATION_JOB', 'CHANNEL_AUTHORIZATION_VALIDATION'],
  DESCRIBE_CONNECTOR_SECRET: ['CONNECTOR_DELETION_INTENT'],
  VERIFY_CONNECTOR_SECRET_UNREADABLE: ['CONNECTOR_DELETION_INTENT'],
  DELETE_CONNECTOR_SECRET: ['CONNECTOR_DELETION_INTENT'],
  PUT_WORKLOAD_OBJECT: ['WORKLOAD_WRITE_INTENT'],
  READ_WORKLOAD_OBJECT: ['ACTIVE_JOB_OBJECT_READ', 'AUTHENTICATED_OBJECT_READ'],
  HEAD_WORKLOAD_OBJECT: ['WORKLOAD_WRITE_INTENT', 'DELETION_OBJECT_INTENT'],
  DELETE_WORKLOAD_OBJECT_VERSION: ['DELETION_OBJECT_INTENT'],
  PUT_PRIVACY_OBJECT: ['PRIVACY_WRITE_INTENT'],
  READ_PRIVACY_OBJECT: ['ACTIVE_JOB_OBJECT_READ', 'AUTHENTICATED_OBJECT_READ'],
  HEAD_PRIVACY_OBJECT: ['PRIVACY_WRITE_INTENT', 'DELETION_OBJECT_INTENT'],
  LIST_TENANT_OBJECT_VERSIONS: ['DELETION_INVENTORY_INTENT'],
  DELETE_PRIVACY_OBJECT_VERSION: ['DELETION_OBJECT_INTENT'],
  GET_OBJECT_LEGAL_HOLD: ['DELETION_OBJECT_INTENT', 'LEGAL_HOLD_RECONCILIATION_INTENT'],
  SET_OBJECT_LEGAL_HOLD: ['LEGAL_HOLD_RECONCILIATION_INTENT'],
} as const satisfies Record<TenantDataOperation, readonly TenantDataAuthorityKind[]>;

/**
 * Fail-closed broker policy. Cloud coordinates and high-risk parameters are
 * copied only from the authoritative operation-specific grant.
 */
export class TenantDataBrokerAuthorizer {
  public constructor(
    private readonly authority: TenantDataAccessAuthority,
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {}

  public async authorize(request: TenantDataAccessRequest): Promise<TenantDataAuthorization> {
    try {
      const now = this.clock.now();
      if (!validDate(now) || !isTenantDataAccessRequest(request)) return denied();

      let grant: TenantDataAccessGrant | null;
      try {
        grant = await this.authority.loadActiveGrant({
          capabilityId: request.capabilityId,
          leaseToken: request.leaseToken,
          at: new Date(now),
        });
      } catch {
        return denied();
      }
      if (grant === null || !validGrant(grant, now)) return denied();
      if (
        grant.capabilityId !== request.capabilityId ||
        !matchesLeaseToken(grant.leaseTokenSha256, request.leaseToken) ||
        grant.authorityReference !== request.authorityReference ||
        grant.scopeKind !== request.scopeKind ||
        grant.tenantId !== request.tenantId ||
        grant.workspaceId !== request.workspaceId ||
        grant.operation !== request.operation
      ) {
        return denied();
      }
      const allowedAuthorityKinds = AUTHORITY_KINDS_BY_OPERATION[
        request.operation
      ] as readonly string[];
      if (!allowedAuthorityKinds.includes(grant.authorityKind)) return denied();

      const { leaseTokenSha256, ...authorizedGrant } = grant;
      void leaseTokenSha256;
      return {
        outcome: 'AUTHORIZED',
        grant: authorizedGrant,
        audit: {
          resourceReferenceSha256: createHash('sha256')
            .update(canonicalJson(grant.resource), 'utf8')
            .digest('hex'),
        },
      };
    } catch {
      return denied();
    }
  }
}

export function isTenantDataAccessRequest(value: unknown): value is TenantDataAccessRequest {
  if (
    !exactRecord(value, [
      'authorityReference',
      'capabilityId',
      'leaseToken',
      'operation',
      'scopeKind',
      'tenantId',
      'workspaceId',
    ])
  ) {
    return false;
  }
  return (
    typeof value.capabilityId === 'string' &&
    UUID.test(value.capabilityId) &&
    typeof value.leaseToken === 'string' &&
    UUID.test(value.leaseToken) &&
    typeof value.tenantId === 'string' &&
    UUID.test(value.tenantId) &&
    validScope(value.scopeKind, value.tenantId, value.workspaceId) &&
    isTenantDataOperation(value.operation) &&
    validReference(value.authorityReference)
  );
}

function validGrant(value: unknown, now: Date): value is TenantDataAccessGrant {
  if (
    !exactRecord(value, [
      'authorityKind',
      'authorityReference',
      'capabilityId',
      'expiresAt',
      'leaseTokenSha256',
      'operation',
      'resource',
      'scopeKind',
      'tenantId',
      'workspaceId',
    ])
  ) {
    return false;
  }
  const expiresAt = readInstant(value.expiresAt);
  return (
    typeof value.capabilityId === 'string' &&
    UUID.test(value.capabilityId) &&
    typeof value.leaseTokenSha256 === 'string' &&
    SHA256.test(value.leaseTokenSha256) &&
    validScope(value.scopeKind, value.tenantId, value.workspaceId) &&
    isTenantDataOperation(value.operation) &&
    isTenantDataAuthorityKind(value.authorityKind) &&
    validReference(value.authorityReference) &&
    expiresAt !== null &&
    expiresAt > now.getTime() &&
    expiresAt - now.getTime() <= MAX_CAPABILITY_LIFETIME_MS &&
    validResourceForOperation(value.operation, value.authorityKind, value.resource, {
      scopeKind: value.scopeKind,
      tenantId: value.tenantId,
      workspaceId: value.workspaceId,
    })
  );
}

function validResourceForOperation(
  operation: TenantDataOperation,
  authorityKind: TenantDataAuthorityKind,
  resource: unknown,
  scope: { scopeKind: unknown; tenantId: unknown; workspaceId: unknown },
): boolean {
  switch (operation) {
    case 'READ_CONNECTOR_SECRET':
    case 'DESCRIBE_CONNECTOR_SECRET':
    case 'DELETE_CONNECTOR_SECRET':
      return validConnectorSecretResource(resource, scope);
    case 'VERIFY_CONNECTOR_SECRET_UNREADABLE':
      return validConnectorSecretUnreadableVerificationResource(resource, scope);
    case 'PUT_WORKLOAD_OBJECT':
      return validWorkloadObjectPutResource(resource, scope);
    case 'PUT_PRIVACY_OBJECT':
      return validPrivacyObjectPutResource(resource, scope);
    case 'READ_WORKLOAD_OBJECT':
      return validObjectVersionResource(resource, ['WORKLOAD_OBJECTS'], scope);
    case 'HEAD_WORKLOAD_OBJECT':
      if (authorityKind === 'WORKLOAD_WRITE_INTENT') {
        return validWorkloadObjectWriteRecoveryHeadResource(resource, scope);
      }
      return (
        authorityKind === 'DELETION_OBJECT_INTENT' &&
        validObjectVersionResource(resource, ['WORKLOAD_OBJECTS'], scope)
      );
    case 'READ_PRIVACY_OBJECT':
      return validObjectVersionResource(resource, ['TENANT_EXPORTS', 'AUDIT_EVIDENCE'], scope);
    case 'HEAD_PRIVACY_OBJECT':
      if (authorityKind === 'PRIVACY_WRITE_INTENT') {
        return validPrivacyObjectWriteRecoveryHeadResource(resource, scope);
      }
      return (
        authorityKind === 'DELETION_OBJECT_INTENT' &&
        validObjectVersionResource(resource, ['TENANT_EXPORTS', 'AUDIT_EVIDENCE'], scope)
      );
    case 'DELETE_WORKLOAD_OBJECT_VERSION':
      return validObjectDeleteResource(resource, ['WORKLOAD_OBJECTS'], scope);
    case 'DELETE_PRIVACY_OBJECT_VERSION':
      return validObjectDeleteResource(resource, ['TENANT_EXPORTS', 'AUDIT_EVIDENCE'], scope);
    case 'LIST_TENANT_OBJECT_VERSIONS':
      return validObjectInventoryResource(resource, scope);
    case 'GET_OBJECT_LEGAL_HOLD':
      return validObjectLegalHoldReadResource(resource, scope);
    case 'SET_OBJECT_LEGAL_HOLD':
      return validObjectLegalHoldWriteResource(resource, scope);
  }
}

function validConnectorSecretResource(
  value: unknown,
  scope: { scopeKind: unknown; tenantId: unknown; workspaceId: unknown },
): boolean {
  return (
    exactRecord(value, ['kind', 'secretArn']) &&
    value.kind === 'CONNECTOR_SECRET' &&
    validConnectorSecretArn(value.secretArn, scope)
  );
}

function validConnectorSecretUnreadableVerificationResource(
  value: unknown,
  scope: { scopeKind: unknown; tenantId: unknown; workspaceId: unknown },
): boolean {
  return (
    exactRecord(value, ['kind', 'resultKind', 'secretArn']) &&
    value.kind === 'CONNECTOR_SECRET_UNREADABLE_VERIFICATION' &&
    value.resultKind === 'BOOLEAN_ONLY' &&
    validConnectorSecretArn(value.secretArn, scope)
  );
}

function validConnectorSecretArn(
  value: unknown,
  scope: { scopeKind: unknown; tenantId: unknown; workspaceId: unknown },
): value is string {
  if (
    typeof value !== 'string' ||
    scope.scopeKind !== 'WORKSPACE' ||
    typeof scope.tenantId !== 'string' ||
    !UUID.test(scope.tenantId) ||
    typeof scope.workspaceId !== 'string' ||
    !UUID.test(scope.workspaceId)
  ) {
    return false;
  }
  const match =
    /^arn:aws:secretsmanager:ap-southeast-1:\d{12}:secret:([A-Za-z0-9/_+=.@-]{1,512})$/u.exec(
      value,
    );
  if (match === null) return false;
  const expectedPrefix =
    `tenant-${scope.tenantId.toLowerCase()}/workspace-` + `${scope.workspaceId.toLowerCase()}/`;
  const secretName = match[1] ?? '';
  return secretName.startsWith(expectedPrefix) && secretName.length > expectedPrefix.length;
}

function validWorkloadObjectPutResource(
  value: unknown,
  scope: { scopeKind: unknown; tenantId: unknown; workspaceId: unknown },
): boolean {
  return (
    exactRecord(value, [
      'bucket',
      'byteLength',
      'checksumSha256',
      'contentType',
      'key',
      'kind',
      'lockedUntil',
      'objectClass',
      'sealedAt',
    ]) &&
    value.kind === 'WORKLOAD_OBJECT_PUT' &&
    value.objectClass === 'WORKLOAD_OBJECTS' &&
    validBucket(value.bucket) &&
    validObjectKey(value.key) &&
    validScopedObjectKey(value.objectClass, value.key, scope) &&
    typeof value.checksumSha256 === 'string' &&
    SHA256.test(value.checksumSha256) &&
    validContentType(value.contentType) &&
    validByteLength(value.byteLength) &&
    value.lockedUntil === null &&
    value.sealedAt === null &&
    scope.scopeKind === 'WORKSPACE'
  );
}

function validPrivacyObjectPutResource(
  value: unknown,
  scope: { scopeKind: unknown; tenantId: unknown; workspaceId: unknown },
): boolean {
  if (
    !exactRecord(value, [
      'bucket',
      'byteLength',
      'checksumSha256',
      'contentType',
      'key',
      'kind',
      'lockedUntil',
      'objectClass',
      'sealedAt',
    ]) ||
    value.kind !== 'PRIVACY_OBJECT_PUT' ||
    !validObjectClass(value.objectClass, ['TENANT_EXPORTS', 'AUDIT_EVIDENCE']) ||
    !validBucket(value.bucket) ||
    !validObjectKey(value.key) ||
    !validScopedObjectKey(value.objectClass, value.key, scope) ||
    typeof value.checksumSha256 !== 'string' ||
    !SHA256.test(value.checksumSha256) ||
    !validContentType(value.contentType) ||
    !validByteLength(value.byteLength) ||
    scope.scopeKind !== 'TENANT'
  ) {
    return false;
  }
  return validPrivacyRetention(value.objectClass, value.lockedUntil, value.sealedAt);
}

function validWorkloadObjectWriteRecoveryHeadResource(
  value: unknown,
  scope: { scopeKind: unknown; tenantId: unknown; workspaceId: unknown },
): boolean {
  return (
    exactRecord(value, [
      'bucket',
      'expectedByteLength',
      'expectedChecksumSha256',
      'expectedContentType',
      'key',
      'kind',
      'lockedUntil',
      'objectClass',
      'sealedAt',
    ]) &&
    value.kind === 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD' &&
    value.objectClass === 'WORKLOAD_OBJECTS' &&
    validBucket(value.bucket) &&
    validObjectKey(value.key) &&
    validScopedObjectKey(value.objectClass, value.key, scope) &&
    typeof value.expectedChecksumSha256 === 'string' &&
    SHA256.test(value.expectedChecksumSha256) &&
    validContentType(value.expectedContentType) &&
    validByteLength(value.expectedByteLength) &&
    value.lockedUntil === null &&
    value.sealedAt === null &&
    scope.scopeKind === 'WORKSPACE'
  );
}

function validPrivacyObjectWriteRecoveryHeadResource(
  value: unknown,
  scope: { scopeKind: unknown; tenantId: unknown; workspaceId: unknown },
): boolean {
  if (
    !exactRecord(value, [
      'bucket',
      'expectedByteLength',
      'expectedChecksumSha256',
      'expectedContentType',
      'key',
      'kind',
      'lockedUntil',
      'objectClass',
      'sealedAt',
    ]) ||
    value.kind !== 'PRIVACY_OBJECT_WRITE_RECOVERY_HEAD' ||
    !validObjectClass(value.objectClass, ['TENANT_EXPORTS', 'AUDIT_EVIDENCE']) ||
    !validBucket(value.bucket) ||
    !validObjectKey(value.key) ||
    !validScopedObjectKey(value.objectClass, value.key, scope) ||
    typeof value.expectedChecksumSha256 !== 'string' ||
    !SHA256.test(value.expectedChecksumSha256) ||
    !validContentType(value.expectedContentType) ||
    !validByteLength(value.expectedByteLength) ||
    scope.scopeKind !== 'TENANT'
  ) {
    return false;
  }
  return validPrivacyRetention(value.objectClass, value.lockedUntil, value.sealedAt);
}

function validPrivacyRetention(
  objectClass: unknown,
  lockedUntilValue: unknown,
  sealedAtValue: unknown,
): boolean {
  if (objectClass === 'TENANT_EXPORTS') {
    return lockedUntilValue === null && sealedAtValue === null;
  }
  if (objectClass !== 'AUDIT_EVIDENCE') return false;
  const sealedAt = readInstant(sealedAtValue);
  const lockedUntil = readInstant(lockedUntilValue);
  return (
    sealedAt !== null &&
    lockedUntil !== null &&
    lockedUntil - sealedAt >= 365 * 24 * 60 * 60 * 1_000
  );
}

function validObjectVersionResource(
  value: unknown,
  objectClasses: readonly TenantDataObjectClass[],
  scope: { scopeKind: unknown; tenantId: unknown; workspaceId: unknown },
): boolean {
  return (
    exactRecord(value, [
      'bucket',
      'byteLength',
      'checksumSha256',
      'contentType',
      'key',
      'kind',
      'objectClass',
      'versionId',
    ]) &&
    value.kind === 'OBJECT_VERSION' &&
    validObjectClass(value.objectClass, objectClasses) &&
    validBucket(value.bucket) &&
    validObjectKey(value.key) &&
    validScopedObjectKey(value.objectClass, value.key, scope) &&
    validVersionId(value.versionId) &&
    typeof value.checksumSha256 === 'string' &&
    SHA256.test(value.checksumSha256) &&
    validContentType(value.contentType) &&
    validByteLength(value.byteLength)
  );
}

function validObjectDeleteResource(
  value: unknown,
  objectClasses: readonly TenantDataObjectClass[],
  scope: { scopeKind: unknown; tenantId: unknown; workspaceId: unknown },
): boolean {
  return (
    exactRecord(value, ['bucket', 'isDeleteMarker', 'key', 'kind', 'objectClass', 'versionId']) &&
    value.kind === 'OBJECT_VERSION_DELETE' &&
    validObjectClass(value.objectClass, objectClasses) &&
    validBucket(value.bucket) &&
    validObjectKey(value.key) &&
    validScopedObjectKey(value.objectClass, value.key, scope) &&
    validVersionId(value.versionId) &&
    typeof value.isDeleteMarker === 'boolean'
  );
}

function validObjectLegalHoldReadResource(
  value: unknown,
  scope: { scopeKind: unknown; tenantId: unknown; workspaceId: unknown },
): boolean {
  return (
    exactRecord(value, ['bucket', 'key', 'kind', 'objectClass', 'versionId']) &&
    value.kind === 'OBJECT_LEGAL_HOLD_READ' &&
    validObjectClass(value.objectClass, ['WORKLOAD_OBJECTS', 'TENANT_EXPORTS', 'AUDIT_EVIDENCE']) &&
    validBucket(value.bucket) &&
    validObjectKey(value.key) &&
    validScopedObjectKey(value.objectClass, value.key, scope) &&
    validVersionId(value.versionId)
  );
}

function validObjectLegalHoldWriteResource(
  value: unknown,
  scope: { scopeKind: unknown; tenantId: unknown; workspaceId: unknown },
): boolean {
  return (
    exactRecord(value, [
      'bucket',
      'desiredStatus',
      'key',
      'kind',
      'objectClass',
      'revision',
      'versionId',
    ]) &&
    value.kind === 'OBJECT_LEGAL_HOLD_WRITE' &&
    validObjectClass(value.objectClass, ['WORKLOAD_OBJECTS', 'TENANT_EXPORTS', 'AUDIT_EVIDENCE']) &&
    validBucket(value.bucket) &&
    validObjectKey(value.key) &&
    validScopedObjectKey(value.objectClass, value.key, scope) &&
    validVersionId(value.versionId) &&
    (value.desiredStatus === 'ON' || value.desiredStatus === 'OFF') &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1
  );
}

function validObjectInventoryResource(
  value: unknown,
  scope: { scopeKind: unknown; tenantId: unknown; workspaceId: unknown },
): boolean {
  return (
    exactRecord(value, ['bucket', 'cursor', 'kind', 'limit', 'objectClass', 'prefix']) &&
    value.kind === 'OBJECT_VERSION_INVENTORY' &&
    validObjectClass(value.objectClass, ['WORKLOAD_OBJECTS', 'TENANT_EXPORTS', 'AUDIT_EVIDENCE']) &&
    validBucket(value.bucket) &&
    validObjectKey(value.prefix) &&
    validScopedInventoryPrefix(value.objectClass, value.prefix, scope) &&
    validInventoryCursor(value.cursor) &&
    typeof value.limit === 'number' &&
    Number.isSafeInteger(value.limit) &&
    value.limit >= 1 &&
    value.limit <= 1_000
  );
}

function validInventoryCursor(value: unknown): boolean {
  return (
    value === null ||
    (exactRecord(value, ['keyMarker', 'versionIdMarker']) &&
      validObjectKey(value.keyMarker) &&
      validVersionId(value.versionIdMarker))
  );
}

function validObjectClass(
  value: unknown,
  allowed: readonly TenantDataObjectClass[],
): value is TenantDataObjectClass {
  return typeof value === 'string' && allowed.includes(value as TenantDataObjectClass);
}

function validScope(scopeKind: unknown, tenantId: unknown, workspaceId: unknown): boolean {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) return false;
  if (scopeKind === 'TENANT') return workspaceId === null;
  return scopeKind === 'WORKSPACE' && typeof workspaceId === 'string' && UUID.test(workspaceId);
}

function validScopedObjectKey(
  objectClass: unknown,
  key: unknown,
  scope: { scopeKind: unknown; tenantId: unknown; workspaceId: unknown },
): boolean {
  const prefix = scopedObjectPrefix(objectClass, scope);
  return (
    prefix !== null &&
    typeof key === 'string' &&
    key.startsWith(prefix) &&
    key.length > prefix.length
  );
}

function validScopedInventoryPrefix(
  objectClass: unknown,
  prefix: unknown,
  scope: { scopeKind: unknown; tenantId: unknown; workspaceId: unknown },
): boolean {
  const expected = scopedObjectPrefix(objectClass, scope);
  return expected !== null && prefix === expected;
}

function scopedObjectPrefix(
  objectClass: unknown,
  scope: { scopeKind: unknown; tenantId: unknown; workspaceId: unknown },
): string | null {
  if (
    typeof scope.tenantId !== 'string' ||
    !UUID.test(scope.tenantId) ||
    (scope.scopeKind !== 'TENANT' && scope.scopeKind !== 'WORKSPACE')
  ) {
    return null;
  }
  const tenantId = scope.tenantId.toLowerCase();
  if (objectClass === 'WORKLOAD_OBJECTS') {
    if (scope.scopeKind === 'TENANT' && scope.workspaceId === null) {
      return `tenants/${tenantId}/workspaces/`;
    }
    if (
      scope.scopeKind === 'WORKSPACE' &&
      typeof scope.workspaceId === 'string' &&
      UUID.test(scope.workspaceId)
    ) {
      return `tenants/${tenantId}/workspaces/${scope.workspaceId.toLowerCase()}/`;
    }
    return null;
  }
  if (scope.scopeKind !== 'TENANT' || scope.workspaceId !== null) return null;
  if (objectClass === 'TENANT_EXPORTS') return `tenants/${tenantId}/exports/`;
  if (objectClass === 'AUDIT_EVIDENCE') {
    return `tenants/${tenantId}/audit-digests/`;
  }
  return null;
}

function matchesLeaseToken(expectedSha256: string, leaseToken: string): boolean {
  if (!SHA256.test(expectedSha256) || !UUID.test(leaseToken)) return false;
  const expected = Buffer.from(expectedSha256, 'hex');
  const actual = createHash('sha256').update(leaseToken, 'utf8').digest();
  return timingSafeEqual(expected, actual);
}

function isTenantDataOperation(value: unknown): value is TenantDataOperation {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(AUTHORITY_KINDS_BY_OPERATION, value)
  );
}

function isTenantDataAuthorityKind(value: unknown): value is TenantDataAuthorityKind {
  return (
    typeof value === 'string' &&
    Object.values(AUTHORITY_KINDS_BY_OPERATION).some((kinds) =>
      (kinds as readonly string[]).includes(value),
    )
  );
}

function validReference(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return false;
  }
  return true;
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
  return validReference(value) && value.length <= 1_024 && !value.startsWith('/');
}

function validVersionId(value: unknown): value is string {
  return validReference(value) && value.length <= 1_024;
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

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join('\n') === [...expectedKeys].sort().join('\n')
  );
}

function readInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function denied(): TenantDataAuthorization {
  return { outcome: 'DENIED', code: 'TENANT_DATA_ACCESS_DENIED' };
}
